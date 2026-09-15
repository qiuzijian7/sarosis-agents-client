/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph Bootstrap — 工作区打开后自动加载/索引代码图谱，用户无感知。
 *
 * 多 folder 工作区（如 S1Game + UE5EA）：每个 folder 各自持久化 graph.db.zst，
 * 用唯一项目名（folder 目录名）区分；启动时依次合并进同一内存 store（跨 folder 检索）。
 *
 * 1. 工作区打开时遍历所有 folder，检查各自是否已有 graph.db.zst
 * 2. 有 → 合并加载（loadGraphMerge，毫秒级）
 * 3. 无 → 延迟 5s 后自动索引该 folder（后台，不阻塞 UI）
 * 4. 全部加载/索引完成后启动文件监听 → 文件变更时自动增量索引
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { runWhenGlobalIdle } from '../../../../base/common/async.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, IWorkspaceFoldersChangeEvent } from '../../../../platform/workspace/common/workspace.js';
import { ICodebaseGraphService, IIndexConfig } from './codebaseGraphService.js';
import { ICodebaseMemoryMcpService, IIndexConfig as IUserIndexConfig } from './codebaseMemoryMcpService.js';
import { URI } from '../../../../base/common/uri.js';

const LOG_TAG = '[CodebaseGraph]';
const AUTO_INDEX_DELAY_MS = 5000; // 5s delay after workspace open

class CodebaseGraphBootstrapContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codebaseGraphBootstrap';

	private _autoIndexTimer: any;
	/** 已加载/已索引的 folder（归一化 fsPath） */
	private readonly _readyFolders = new Set<string>();
	/**
	 * **正在加载中**的 folder（归一化 fsPath）。
	 *
	 * 2026-09-15 修：`_readyFolders` 只在加载**完成后**才 add，而一次 `loadGraphMerge`
	 * 要 10~40s（大图）——期间任何再次触发的 `_bootstrap()`（工作区切换、folder 事件）
	 * 都会把同一 folder **再加载一遍**。实测日志（20260915T132615）：
	 * ```
	 * 13:26:45 [loadGraphMerge] merged ...sarosis... store nodes=341560
	 * 13:26:53 [loadGraphMerge] merged ...sarosis... store nodes=522257   ← 同一制品被合并两次
	 * ```
	 * 后果（实测制品 `graph.db.zst` 358,887 节点去重后仅 180,753，**49.6% 冗余**）：
	 * 内存节点翻倍 → `_ensureSqliteFreshness` 恒判「sqlite 落后」→ 每次查询触发全量重同步
	 * → 查询与写事务竞争（单次检索 2.3s 且候选残缺）。
	 * 注：`mergeFromJSONAsync` 现已幂等（同 qn 跳过），此处是**源头**防重复发起（省掉一次解析）。
	 */
	private readonly _loadingFolders = new Set<string>();
	/** 待自动索引的 folder（归一化 fsPath → 原始 fsPath） */
	private readonly _pendingIndex = new Map<string, string>();

	constructor(
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
		@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();

		// Subscribe to index progress logs
		this._register(this._graphService.onDidIndexProgress(line => {
			this._logService.info(LOG_TAG, line);
		}));

		this._register(this._graphService.onDidIndexComplete(result => {
			if (!result.success) {
				this._logService.warn(LOG_TAG, `Auto-index failed: ${result.message}`);
				return;
			}
			this._logService.info(LOG_TAG, `Auto-index complete: ${result.message}`);
			// 启动文件监听（增量重索引触发源，P2-#8）
			//
			// ① 增量索引由 **watcher 自己**触发（watcher 必然已存在、排除集未变）⇒ **无需**刷新：
			//    旧实现每轮都重启一次 ⇒ 重跑 `_excludeResolver.resolve()`（读 `.cbmignore` + 工作区配置）
			//    + 替换 root 条目 + `[exclude]` / `Starting graph watcher` / `Watching` 三条日志。
			//    用户 2026-09-15 日志里正是「每轮增量完成后紧跟这三条」。
			if (result.kind === 'incremental') { return; }
			// ② ★ 用「**刚完成索引的那个 root**」而不是 `_primaryFolder()`（= folders[0]）：
			//    多 folder 工作区下否则永远只刷新第一个 folder 的 watcher，而真正可能改了排除集
			//    （索引会写 `.cbmignore`）的那个 folder 的 watcher 永不刷新。
			//    与 `_onWatcherChange`（用事件携带的 `rootPath`）/ `_resolveActiveProject`
			//    是同一条教训：「别用 folders[0] 代替事件所属 root」。
			void this._startWatching(result.rootPath || this._primaryFolder());
		}));

		// Listen for workspace folder changes
		this._register(this._workspaceService.onDidChangeWorkspaceFolders((e: IWorkspaceFoldersChangeEvent) => {
			if (e.added.length > 0) {
				this._bootstrap().catch(err => this._logService.error(LOG_TAG, 'Re-bootstrap failed:', err));
			}
		}));

		// 懒加载：不在 app 启动时立即加载图谱。
		// 18w+ 节点的解压 + 反序列化 + BM25 重建是 CPU/内存密集的重活，
		// 若在启动阶段与 getAgents（磁盘 IO）、插件激活、Codebuddy /v3/config
		// 等任务并发执行，会把 CPU + 内存 + 磁盘同时打满 → 初次打开工作流"整个电脑卡"。
		// 改为 runWhenGlobalIdle 延迟到 UI 空闲后再后台加载（时间切片已保证不冻结交互）。
		this._register(runWhenGlobalIdle(() => {
			this._bootstrap().catch(err => this._logService.error(LOG_TAG, 'Bootstrap failed:', err));
		}));
	}

	private _normalize(p: string): string {
		return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	}

	private _basename(p: string): string {
		const norm = p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
		const idx = norm.lastIndexOf('/');
		return idx >= 0 ? norm.substring(idx + 1) : norm;
	}

	private _primaryFolder(): string {
		const folders = this._workspaceService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri.fsPath : '';
	}

	/**
	 * 判定工作区是否由 `.code-workspace` 文件打开（区别于「从文件夹添加」）。
	 * 检查每个 folder 根目录是否直接存在 `.code-workspace` 文件（与
	 * codebaseMemoryMcpService._initWorkspaceFileConfig 的根目录检测口径一致）。
	 * 任何 folder 命中即视为 code-workspace 工作区。
	 */
	private async _hasCodeWorkspaceFile(): Promise<boolean> {
		try {
			const folders = this._workspaceService.getWorkspace().folders;
			for (const f of folders) {
				try {
					const rootStat = await this._fileService.resolve(f.uri);
					if (!rootStat?.children) { continue; }
					const has = rootStat.children.some(c =>
						!c.isDirectory && (c.name ?? '').toLowerCase().endsWith('.code-workspace'));
					if (has) { return true; }
				} catch { /* 单个 folder 不可读，跳过 */ }
			}
		} catch { /* ignore */ }
		return false;
	}

	private async _bootstrap(): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			this._logService.info(LOG_TAG, 'No workspace folder open, skipping.');
			return;
		}

		this._logService.info(LOG_TAG, `Bootstrapping ${folders.length} workspace folder(s): ${folders.map(f => f.uri.fsPath).join(', ')}`);

		// 2026-08-19：从文件夹添加工作区（根目录无 .code-workspace 文件）时【禁用自动索引】。
		// 已有图照常合并加载 + 启动 watcher（增量）；只有「无图」时才走 auto-index，且仅当
		// 存在 .code-workspace 文件才允许。无 .code-workspace 的裸文件夹/多项目父目录，
		// 索引改由 LLM 在 codebase 工具触发时询问用户后手动发起（见 codebaseTools.noGraphGuidance）。
		const allowAutoIndex = await this._hasCodeWorkspaceFile();

		// 收集需要合并加载的 folder（不含已 ready 的、也不含**正在加载中**的）
		const toLoad = folders.filter(f => {
			const key = this._normalize(f.uri.fsPath);
			return !this._readyFolders.has(key) && !this._loadingFolders.has(key);
		});

		for (let i = 0; i < toLoad.length; i++) {
			const folder = toLoad[i];
			const key = this._normalize(folder.uri.fsPath);
			const project = this._basename(folder.uri.fsPath) || '_default';
			const graphFileUri = URI.joinPath(folder.uri, '.codebase-memory', 'graph.db.zst');

			// 合并加载；BM25 仅在最后一个 folder 加载后重建一次（避免重复重建开销）
			const isLast = i === toLoad.length - 1;
			let loaded = false;
			this._loadingFolders.add(key);
			try {
				loaded = await this._graphService.loadGraphMerge(graphFileUri.fsPath, project, isLast);
			} catch { /* 读取/解析异常，落入下方区分逻辑 */ } finally {
				this._loadingFolders.delete(key);
			}
			if (loaded) {
				this._logService.info(LOG_TAG, `Loaded existing graph for folder "${project}".`);
				this._readyFolders.add(key);
				this._pendingIndex.delete(key);
				// 多 folder：每个已加载 folder 单独启动监听（增量索引，互不覆盖）
				await this._startWatching(folder.uri.fsPath);
				continue;
			}

			// 2026-09-15：用户可能在合并加载期间就切走了工作区（切换不 reload renderer）——
			// 此时该 folder 已不属于本窗口，`loadGraphMerge` 会**主动丢弃**它（防跨工作区污染）。
			// 必须在这里静默跳过，否则会打出「制品存在但加载失败」的**假警报**，把真正原因盖掉。
			const stillInWorkspace = this._workspaceService.getWorkspace().folders
				.some(f => this._normalize(f.uri.fsPath) === key);
			if (!stillInWorkspace) {
				this._logService.info(LOG_TAG, `Folder "${project}" left the workspace during load — skipping (no auto-index).`);
				continue;
			}

			// 未加载成功：区分「图文件存在但加载失败」与「图文件缺失」。
			// 图文件存在但加载失败（如过大/损坏/内存不足）时【跳过自动索引】——
			// 否则会对超大图谱反复全量重建（用户视角"莫名扫描"），且几乎必然再次失败。
			// 此时保留内存/sqlite 兜底读取，用户可手动触发索引。
			let graphFileExists = false;
			try {
				await this._fileService.stat(graphFileUri);
				graphFileExists = true;
			} catch { /* 文件不存在 */ }
			if (graphFileExists) {
				this._logService.warn(LOG_TAG, `Graph artifact exists but failed to load for "${project}" — skipping auto-index to avoid full rescan (artifact may be too large / corrupted / OOM). Use in-memory/sqlite fallback or manually re-index.`);
				continue;
			}

			// 无既有图谱 → 加入待索引队列。
			// 区分"首次索引"与"图谱丢失"：.codebase-memory 目录存在但 graph.db.zst 缺失，
			// 说明图谱曾被创建过（外部删除 / 保存中断 / 引擎目录被刷新），值得 warn 提醒。
			let graphLost = false;
			try {
				await this._fileService.stat(URI.joinPath(folder.uri, '.codebase-memory'));
				graphLost = true;
			} catch { /* 目录也不存在 = 首次索引 */ }
			if (!allowAutoIndex) {
				this._logService.info(LOG_TAG, `No existing graph for folder "${project}", but auto-index is disabled (no .code-workspace file) — deferring to manual/LLM-triggered indexing.`);
				continue;
			}
			if (graphLost) {
				this._logService.warn(LOG_TAG, `Graph artifact missing but .codebase-memory dir exists for "${project}" (external deletion or interrupted save?), scheduling auto-index...`);
			} else {
				this._logService.info(LOG_TAG, `No existing graph for folder "${project}", scheduling auto-index...`);
			}
			this._pendingIndex.set(key, folder.uri.fsPath);
		}

		if (this._pendingIndex.size > 0) {
			this._scheduleAutoIndex();
		}
	}

	private _scheduleAutoIndex(): void {
		if (this._pendingIndex.size === 0) { return; }
		clearTimeout(this._autoIndexTimer);
		this._autoIndexTimer = setTimeout(() => {
			this._autoIndex().catch(err =>
				this._logService.warn(LOG_TAG, 'Auto-index failed:', err));
		}, AUTO_INDEX_DELAY_MS);
	}

	/**
	 * 读取用户在「代码库索引」面板保存的配置（P2）。
	 * 此前 auto-index 硬编码 `mode:'fast'` + `excludeDirs:[]`，完全绕过用户配置，
	 * 导致「面板里改了排除目录，但启动自动索引仍按默认扫」。
	 */
	private async _readUserIndexConfig(): Promise<IUserIndexConfig | undefined> {
		try {
			await this._cbmService.ensureConfigReady();
			return this._cbmService.getIndexConfig();
		} catch (err: any) {
			this._logService.warn(LOG_TAG, `Failed to read user index config, falling back to defaults: ${err?.message || err}`);
			return undefined;
		}
	}

	/** 启动 watcher，并把用户配置的排除目录一并传入（否则 watcher 与索引扫描口径不一致）。 */
	private async _startWatching(rootPath: string): Promise<void> {
		if (!rootPath) { return; }
		const userConfig = await this._readUserIndexConfig();
		this._graphService.startWatching(rootPath, userConfig?.excludeDirs, userConfig?.keepDirs);
	}

	private async _autoIndex(): Promise<void> {
		// [TRACE] codebaseGraphBootstrap._autoIndex 入口
		this._logService.info(LOG_TAG, `[TRACE] codebaseGraphBootstrap._autoIndex triggered: pending=${this._pendingIndex.size} folders`);
		const userConfig = await this._readUserIndexConfig();
		// subPath 是全局单值配置：多 folder 工作区下无法判定它属于哪个 folder，故仅单 folder 时透传
		const singleFolder = this._workspaceService.getWorkspace().folders.length === 1;
		// 逐 folder 索引（每个 folder 用其目录名作为唯一项目名，避免多 folder 覆盖）
		const pending = [...this._pendingIndex.entries()];
		for (const [key, rootPath] of pending) {
			// 2026-09-15：自动索引有 5s 延迟（AUTO_INDEX_DELAY_MS），期间用户可能已切走工作区
			// （切换不 reload renderer）⇒ 该 folder 不再属于本窗口，**不得**再为它建图。
			const stillInWorkspace = this._workspaceService.getWorkspace().folders
				.some(f => this._normalize(f.uri.fsPath) === key);
			if (!stillInWorkspace) {
				this._pendingIndex.delete(key);
				this._logService.info(LOG_TAG, `Skipped auto-index for "${rootPath}" — left the workspace before the delay elapsed.`);
				continue;
			}
			const project = this._basename(rootPath) || '_default';
			const config: IIndexConfig = {
				mode: userConfig?.mode ?? 'fast',
				excludeDirs: userConfig?.excludeDirs ?? [], // 空 = 仅用默认；graphService 会与默认表取并集
				keepDirs: userConfig?.keepDirs,
				subPath: singleFolder ? userConfig?.subPath : undefined,
				projectName: project,
			};
			this._logService.info(LOG_TAG, `Starting auto-index: ${rootPath} (project=${project}, mode=${config.mode}, exclude=${config.excludeDirs.length} items, subPath=${config.subPath || '(none)'})`);
			try {
				const result = await this._graphService.indexWorkspace(rootPath, config);
				if (result.success) {
					this._readyFolders.add(key);
					this._pendingIndex.delete(key);
					// 多 folder：每个已索引 folder 单独启动监听（增量索引，互不覆盖）。
					// keepDirs 一并透传：与全量索引扫描口径一致（否则 Content/script 等保留目录
					// 在 watcher/增量扫描中被整目录排除，产生幻影 deleted）。
					this._graphService.startWatching(rootPath, config.excludeDirs, config.keepDirs);
					this._logService.info(LOG_TAG, `Auto-index completed for "${project}": ${result.message}`);
				}
			} catch (err: any) {
				this._logService.warn(LOG_TAG, `Auto-index failed for "${project}": ${err?.message || err}`);
			}
		}
	}
}



registerWorkbenchContribution2(
	CodebaseGraphBootstrapContribution.ID,
	CodebaseGraphBootstrapContribution as any,
	WorkbenchPhase.AfterRestored,
);
