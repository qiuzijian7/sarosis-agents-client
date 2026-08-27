/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph Watcher — 自适应轮询文件监听，检测变更后触发增量索引。
 *
 * 对标 codebase-memory-mcp 的 watcher.c：
 * - 基础间隔 5s，每 500 文件 +1s，上限 60s
 * - git HEAD 变化时触发全量检查
 * - 文件 SHA-256 变化时触发增量索引
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { CodebaseGraphStore } from './codebaseGraphStore.js';

export interface CodebaseGraphChangeEvent {
	type: 'git-head' | 'files';
	/** 触发事件的监听根目录（多 root 下必须携带，否则增量会跑错 folder）。 */
	rootPath: string;
	head?: string;
	added?: string[];
	modified?: string[];
	deleted?: string[];
}

export const ICodebaseGraphWatcher = createDecorator<CodebaseGraphWatcher>('ICodebaseGraphWatcher');

/** 多 folder：每个监听根目录的上下文（store/project/扩展集/上次 git head）。 */
interface IWatcherRoot {
	rootPath: string;
	store: CodebaseGraphStore;
	project: string;
	exts: Set<string>;
	/** 目录排除集（与索引扫描一致，防止 Intermediate/ 等生成目录误扫）。 */
	excludeDirs: Set<string>;
	/** keepDirs 例外集（exclude 内保留的子目录，小写 / 分隔相对路径，与索引扫描口径一致）。 */
	keepDirs: Set<string>;
	lastGitHead?: string;
	/** 脏状态签名：同一 (added,modified,deleted) 组合不重复触发重索引（对齐 C 版 dirty-state 签名去重）。 */
	lastDirtySig?: string;
	/** 连续缺失轮数：达到上限后 prune（对齐 C 版 MISSING_ROOT_DELETE_AFTER）。 */
	missingCount?: number;
}

const LOG_TAG = '[CodebaseGraphWatcher]';
const BASE_POLL_MS = 5000;
const MAX_POLL_MS = 60000;
const FILES_PER_EXTRA_SEC = 500;
/**
 * 变更事件去抖静默期（ms）。
 *
 * 背景：保存风暴（批量格式化 / git checkout / 生成代码）会在数秒内产生多轮脏集，
 * 每轮都触发一次增量索引 → 全图 rebuildBM25 + 全图序列化落盘，renderer 连续冻结。
 * 静默期内到达的变更集与待发集合并（按 relPath 去重），静默期结束后只发一次。
 * 与 lastDirtySig 去重互补：sig 拦"完全相同的重复轮"，本去抖拦"不同但在时间上连续的多轮"。
 */
const CHANGE_DEBOUNCE_MS = 2000;

export class CodebaseGraphWatcher extends Disposable {
	declare readonly _serviceBrand: undefined;

	private _pollTimer: any;
	private _pollInterval = BASE_POLL_MS;
	private _isPolling = false;
	private _disposed = false;
	/** 多 folder：同时监听多个根目录（每个 folder 一个），互不覆盖。 */
	private _roots: IWatcherRoot[] = [];
	private _started = false;
	/**
	 * 去抖待发的变更集：归一化 rootPath → 待发事件。
	 * 静默期内新到的变更与本集合并，静默期结束只 fire 一次（见 _fireChangeDebounced）。
	 */
	private readonly _pendingChanges = new Map<string, { event: CodebaseGraphChangeEvent; timer: any }>();

	private readonly _onDidChange = this._register(new Emitter<CodebaseGraphChangeEvent>());
	readonly onDidChange: Event<CodebaseGraphChangeEvent> = this._onDidChange.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * 注册一个监听根目录。多 folder 工作区：每个 folder 各调用一次，互不覆盖（同 root 去重替换）。
	 */
	start(rootPath: string, store: CodebaseGraphStore, project: string, supportedExtensions: Set<string>, excludeDirs?: Set<string>, keepDirs?: readonly string[]): void {
		const norm = this._normalizeRoot(rootPath);
		// 同 root 去重（重复 start 同一 folder 时替换而非新增）。
		// 保留 lastDirtySig：索引完成后会重新 start（刷新 project/excludeDirs），若丢弃签名，
		// 未收敛的脏集（如始终无哈希的文件）会在每轮"重启→首检"循环中反复触发增量。
		const prev = this._roots.find(r => this._normalizeRoot(r.rootPath) === norm);
		this._roots = this._roots.filter(r => this._normalizeRoot(r.rootPath) !== norm);
		// excludeDirs 统一小写化存储（扫描比较用小写名）
		const excludeLower = new Set<string>();
		for (const d of excludeDirs ?? []) { excludeLower.add(d.toLowerCase()); }
		// keepDirs 归一化：小写 + / 分隔 + 去首尾斜杠（与 graphService._scanFiles 口径一致）
		const keepLower = new Set<string>();
		for (const k of keepDirs ?? []) { keepLower.add(k.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()); }
		this._roots.push({ rootPath, store, project, exts: supportedExtensions, excludeDirs: excludeLower, keepDirs: keepLower, lastDirtySig: prev?.lastDirtySig });
		this._logService.info(LOG_TAG, `Watching ${rootPath} (project=${project}); active roots=${this._roots.length}`);
		if (!this._started) {
			this._started = true;
			this._schedulePollAll();
		}
	}

	stop(): void {
		if (this._pollTimer) {
			clearTimeout(this._pollTimer);
			this._pollTimer = null;
		}
		// 丢弃所有去抖待发变更：否则 stop 之后仍会 fire 一次，
		// 让已停止/已销毁的 graphService 再跑一轮全图重建。
		for (const pending of this._pendingChanges.values()) {
			clearTimeout(pending.timer);
		}
		this._pendingChanges.clear();
		this._isPolling = false;
		this._roots = [];
		this._started = false;
	}

	private _normalizeRoot(p: string): string {
		return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	}

	/** 调度下一轮全根轮询。 */
	private _schedulePollAll(): void {
		if (this._disposed) { return; }
		this._pollTimer = setTimeout(() => {
			this._pollAll().catch(err =>
				this._logService.warn(LOG_TAG, `Poll error: ${err?.message || err}`));
		}, this._pollInterval);
	}

	/** 遍历所有已注册根目录轮询变更（多 folder：逐一检查各 folder 文件变更；单轮询锁保证顺序执行）。 */
	private async _pollAll(): Promise<void> {
		if (this._isPolling || this._disposed) { return; }
		this._isPolling = true;
		try {
			for (const r of this._roots) {
				await this._poll(r);
			}
		} finally {
			this._isPolling = false;
			this._schedulePollAll();
		}
	}

	private async _poll(root: IWatcherRoot): Promise<void> {
		const { rootPath } = root;
		// 缺根 prune（对齐 C 版 MISSING_ROOT_DELETE_AFTER=3）：根目录连续缺失 3 轮则停止监听
		try {
			await this._fileService.stat(URI.file(rootPath));
			root.missingCount = 0;
		} catch {
			root.missingCount = (root.missingCount ?? 0) + 1;
			if (root.missingCount >= 3) {
				this._roots = this._roots.filter(r => r !== root);
				this._logService.warn(LOG_TAG, `Root missing ${root.missingCount} consecutive polls, pruned: ${rootPath}`);
			}
			return;
		}

		// 1. Check git HEAD（每 root 独立，避免多 folder 各自的 .git 互相误判）
		const head = await this._getGitHead(rootPath);
		if (head && head !== root.lastGitHead) {
			if (root.lastGitHead !== undefined) {
				this._logService.info(LOG_TAG, `Git HEAD changed: ${root.lastGitHead} → ${head}`);
				this._onDidChange.fire({ type: 'git-head', rootPath: root.rootPath, head });
			}
			root.lastGitHead = head;
			// On git HEAD change, do a full file check
			await this._checkFiles(root);
			return;
		}
		root.lastGitHead = head;

		// 2. Check file changes (stat-based)
		await this._checkFiles(root);
	}

	private async _checkFiles(root: IWatcherRoot): Promise<void> {
		const { rootPath, store, project, exts } = root;
		// 与索引扫描一致的目录排除（旧实现传空集：UE 项目 Intermediate/ 生成目录
		// 会扫出 18w+ 文件，每轮误报全量 added）
		const currentFiles = await this._scanFiles(URI.file(rootPath), exts, root.excludeDirs, 0, rootPath, root.keepDirs);
		// 元数据兜底：部分 provider 的 resolve 不返回 children 的 mtime/size（全为 0），
		// 会导致所有带哈希的文件被误判 modified（实证：全量 6268/28674 误报）。
		// 对缺元数据的条目用 stat() 补齐（32 并发分批，28k 文件约秒级）。
		if (currentFiles.length > 0 && currentFiles[0].mtimeNs === 0) {
			await this._fillMetadata(currentFiles);
		}
		// 统一用相对路径比较（修复既有 bug：旧实现用绝对路径 Set 对相对路径 Set，
		// 两者不相交 → 每轮误报全量 added/deleted）。
		const currentRelSet = new Set(currentFiles.map(e => this._getRelPath(rootPath, e.path)));

		// Get previous file hashes
		const oldHashes = store.getAllFileHashes(project);
		const oldSet = new Set(oldHashes.map(h => h.relPath));

		// Find added/modified/deleted
		const added: string[] = [];
		const modified: string[] = [];
		const deleted: string[] = [];

		for (const relPath of currentRelSet) {
			if (!oldSet.has(relPath)) {
				added.push(relPath);
			}
		}

		for (const oldHash of oldHashes) {
			if (!currentRelSet.has(oldHash.relPath)) {
				deleted.push(oldHash.relPath);
			}
		}

		// 变更判定对齐 C 版：stat-only（mtime+size 来自 resolve() 扫描结果，零额外 I/O），
		// 全量覆盖而非采样。sha256 仅作记录字段（重索引时写入），判定不走内容哈希——
		// 旧实现每轮读 200 个整文件算 SHA-256，且采样外的变更会漏判。
		for (const entry of currentFiles) {
			const relPath = this._getRelPath(rootPath, entry.path);
			if (!oldSet.has(relPath)) { continue; } // added 已在上面处理
			const oldHash = store.getFileHash(project, relPath);
			if (!oldHash || oldHash.size !== entry.size || oldHash.mtimeNs !== entry.mtimeNs) {
				modified.push(relPath);
			}
		}

		// Adaptive interval based on file count
		this._pollInterval = Math.min(MAX_POLL_MS, BASE_POLL_MS + Math.floor(currentFiles.length / FILES_PER_EXTRA_SEC) * 1000);

		if (added.length > 0 || modified.length > 0 || deleted.length > 0) {
			// 脏状态签名去重（对齐 C 版 dirty-state signature）：同一变更组合在连续轮询中
			// 只触发一次重索引；状态转干净时重置签名（之后相同变更可再次触发）。
			const sig = `+${added.length}~${modified.length}-${deleted.length}|${added.slice(0, 64).join(',')}|${modified.slice(0, 64).join(',')}|${deleted.slice(0, 64).join(',')}`;
			if (sig === root.lastDirtySig) { return; }
			root.lastDirtySig = sig;
			// 诊断明细：modified 首条的 old/new (size,mtime) 对比——用于区分真实改动、mtime 精度问题与键格式错配
			let modDetail = '';
			if (modified.length > 0) {
				const rel = modified[0];
				const oldH = store.getFileHash(project, rel);
				const cur = currentFiles.find(f => this._getRelPath(rootPath, f.path) === rel);
				if (oldH && cur) {
					modDetail = ` | first-modified ${rel}: old(size=${oldH.size},mtime=${oldH.mtimeNs}) new(size=${cur.size},mtime=${cur.mtimeNs})`;
				}
			}
			const sample = (rels: string[]) => rels.slice(0, 5).join(', ');
			this._logService.info(LOG_TAG, `Changes: +${added.length} ~${modified.length} -${deleted.length}${modDetail} | added≈[${sample(added)}] modified≈[${sample(modified)}] deleted≈[${sample(deleted)}]`);
			this._fireChangeDebounced({ type: 'files', rootPath: root.rootPath, added, modified, deleted });
		} else {
			root.lastDirtySig = undefined;
		}
	}

	/**
	 * 去抖后发出文件变更事件（CHANGE_DEBOUNCE_MS 静默期）。
	 *
	 * 保存风暴（批量格式化 / git checkout / 代码生成）会在数秒内产生多轮不同的脏集；
	 * 每轮都会触发一次增量索引，而增量索引的 rebuildBM25 + _saveGraph 是**全图**工作量，
	 * 连续多轮即 renderer 持续冻结。此处把静默期内的多轮变更合并为一次事件。
	 *
	 * 按 root 独立去抖（多 folder 各自的变更不互相拖延）。合并规则见 _mergeChangeSets。
	 */
	private _fireChangeDebounced(event: CodebaseGraphChangeEvent): void {
		const key = this._normalizeRoot(event.rootPath ?? '');
		const pending = this._pendingChanges.get(key);
		if (pending) {
			clearTimeout(pending.timer);
			pending.event = this._mergeChangeSets(pending.event, event);
		} else {
			this._pendingChanges.set(key, { event, timer: undefined });
		}
		const entry = this._pendingChanges.get(key)!;
		entry.timer = setTimeout(() => {
			this._pendingChanges.delete(key);
			if (this._disposed) { return; }
			this._onDidChange.fire(entry.event);
		}, CHANGE_DEBOUNCE_MS);
	}

	/**
	 * 合并两个变更集（后者为较新的一轮），按 relPath 去重并保持语义正确：
	 * - 同文件重复出现在任意两轮 → 归入最新一轮的那个分类
	 * - 先 added 后 modified/deleted → 取后者（一轮内多次写入也只需重解析一次）
	 * - 先 modified 后 deleted → deleted（文件已不存在，重解析会失败）
	 * - 先 deleted 后 added → added（删后重建，需重新解析）
	 */
	private _mergeChangeSets(prev: CodebaseGraphChangeEvent, next: CodebaseGraphChangeEvent): CodebaseGraphChangeEvent {
		const added = new Set<string>();
		const modified = new Set<string>();
		const deleted = new Set<string>();

		// 按时间顺序应用，后者覆盖前者（先从前一轮的各集合移除被后一轮重新归类的文件）
		const apply = (sets: { a: string[]; m: string[]; d: string[] }) => {
			for (const rel of sets.a) { modified.delete(rel); deleted.delete(rel); added.add(rel); }
			for (const rel of sets.m) { added.delete(rel); deleted.delete(rel); modified.add(rel); }
			for (const rel of sets.d) { added.delete(rel); modified.delete(rel); deleted.add(rel); }
		};
		apply({ a: prev.added ?? [], m: prev.modified ?? [], d: prev.deleted ?? [] });
		apply({ a: next.added ?? [], m: next.modified ?? [], d: next.deleted ?? [] });

		return {
			type: next.type,
			rootPath: next.rootPath ?? prev.rootPath,
			head: next.head ?? prev.head,
			added: [...added],
			modified: [...modified],
			deleted: [...deleted],
		};
	}

	private async _scanFiles(dirUri: URI, exts: Set<string>, excludeDirs: Set<string>, depth: number, rootPath: string, keepDirs: Set<string>): Promise<{ path: string; mtimeNs: number; size: number }[]> {
		if (depth > 30) { return []; }

		let stat;
		try {
			// resolveMetadata:true 让 children 携带 mtime/size（缺省时下游全部误判 modified）
			stat = await this._fileService.resolve(dirUri, { resolveMetadata: true });
		} catch { return []; }

		if (!stat.children) { return []; }

		const results: { path: string; mtimeNs: number; size: number }[] = [];
		for (const child of stat.children) {
			if (child.name.startsWith('.') && child.name.length > 1) {
				continue;
			}
			// 大小写不敏感匹配（排除集与实际目录名大小写常不一致，如 'scripts' vs 'Scripts'——
			// 曾致排除静默失效：watcher 扫入索引排除的目录，每轮误报 added）
			if (excludeDirs.has(child.name.toLowerCase())) {
				// keepDirs 例外：被排除目录中的保留子目录仍扫描（与 graphService._scanDir 三段匹配口径一致）
				if (child.isDirectory && keepDirs.size > 0) {
					const rel = this._getRelPath(rootPath, child.resource.fsPath).toLowerCase();
					let keep = false;
					for (const k of keepDirs) {
						if (rel === k || rel.startsWith(k + '/') || k.startsWith(rel + '/')) { keep = true; break; }
					}
					if (!keep) { continue; }
				} else {
					continue;
				}
			}
			if (child.isDirectory) {
				const sub = await this._scanFiles(child.resource, exts, excludeDirs, depth + 1, rootPath, keepDirs);
				// 不用 results.push(...sub)：子目录文件极多时展开成参数会触发
				// "Maximum call stack size exceeded"（V8 函数参数上限）。逐元素入栈安全。
				for (let i = 0; i < sub.length; i++) {
					results.push(sub[i]);
				}
			} else if (child.isFile) {
				const ext = this._getExtension(child.name);
				if (exts.has(ext)) {
					results.push({ path: child.resource.fsPath, mtimeNs: (child.mtime ?? 0) * 1_000_000, size: child.size ?? 0 });
				}
			}
		}
		return results;
	}

	private _getRelPath(rootPath: string, absPath: string): string {
		if (absPath.startsWith(rootPath)) {
			return absPath.substring(rootPath.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
		}
		return absPath.replace(/\\/g, '/');
	}

	/** 用 stat() 补齐缺失的文件元数据（32 并发分批；单条失败保持 0 值静默跳过）。 */
	private async _fillMetadata(files: { path: string; mtimeNs: number; size: number }[]): Promise<void> {
		const CONCURRENCY = 32;
		for (let i = 0; i < files.length; i += CONCURRENCY) {
			const batch = files.slice(i, i + CONCURRENCY);
			await Promise.all(batch.map(async f => {
				if (f.mtimeNs !== 0) { return; }
				try {
					const s = await this._fileService.stat(URI.file(f.path));
					f.mtimeNs = s.mtime * 1_000_000;
					f.size = s.size;
				} catch { /* 单条失败保持 0，下一轮再试 */ }
			}));
		}
	}

	private _getExtension(fileName: string): string {
		const idx = fileName.lastIndexOf('.');
		return idx >= 0 ? fileName.substring(idx).toLowerCase() : '';
	}

	private async _getGitHead(rootPath: string): Promise<string | undefined> {
		try {
			const headUri = URI.joinPath(URI.file(rootPath), '.git', 'HEAD');
			const content = await this._fileService.readFile(headUri);
			return content.value.toString().trim();
		} catch { return undefined; }
	}

	override dispose(): void {
		this._disposed = true;
		this.stop();
		super.dispose();
	}
}
