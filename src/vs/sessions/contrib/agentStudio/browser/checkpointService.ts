/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { writeFileAtomicSafe } from '../common/atomicWrite.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IAgentStudioService } from '../../../common/agentStudioService.js';
import { ICheckpointService } from '../common/checkpointService.js';
import { resolveSarosPath } from '../common/sarosPaths.js';
import {
	ICheckpoint,
	ICheckpointFileChange,
	ICreateCheckpointPayload,
	IJumpToCheckpointResult,
	IFileSnapshot,
	IFileSnapshotData,
} from '../common/checkpointTypes.js';
import {
	CHECKPOINT_MAX_PER_SESSION,
	CHECKPOINT_MAX_VERSIONS_PER_FILE,
	CHECKPOINT_TTL_MS,
	SNAPSHOT_ID_HEX_LENGTH,
	ISnapshotVersionRef,
	collectProtectedSnapshotIds,
	isSessionExpired,
	planCheckpointEviction,
	planVersionPrune,
	selectUnreferencedSnapshotIds,
} from '../common/checkpointRetention.js';
import { shouldOmitSnapshotContent } from '../common/checkpointSnapshotPolicy.js';

/**
 * On-disk shape for a persisted checkpoint (metadata only; file snapshots are
 * stored separately as one JSON file per snapshot so that large file contents
 * don't bloat the index).
 */
interface IStoredCheckpoint {
	readonly id: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly type: 'user_edit' | 'tool_edit';
	readonly label: string;
	readonly description: string | undefined;
	readonly createdAt: number;
	/** 可变：保留策略（版本限流）会收缩该列表。 */
	fileSnapshotIds: string[];
	isGhost: boolean;
	readonly messageId: string | undefined;
	readonly files?: ICheckpointFileChange[];
}

/** On-disk shape for a single file snapshot. */
interface IStoredFileSnapshot {
	readonly id: string;
	readonly checkpointId: string;
	readonly uri: string; // URI.toString()
	readonly languageId: string | undefined;
	readonly content: string;
	/**
	 * Whether the file already existed on disk at snapshot time. `false` →
	 * the edit created the file, so reverting must delete it. Optional for
	 * backward-compat (absent = treat as existed → restore-by-write).
	 */
	readonly existedBefore?: boolean;
	/** 内容因超大/二进制被省略（2026-09-12，P2-3；见 common/checkpointSnapshotPolicy.ts）。 */
	readonly contentOmitted?: boolean;
}

/**
 * Browser-layer checkpoint service backed by {@link IFileService} + JSON.
 *
 * Storage layout (under the workspace home dir):
 *   <home>/.sarosworkspace/checkpoints/<agentId>/<sessionId>/index.json
 *   <home>/.sarosworkspace/checkpoints/<agentId>/<sessionId>/snapshots/<snapshotId>.json
 *
 * The index file holds the ordered checkpoint metadata array; each snapshot is
 * its own file. When no workspace home dir can be resolved we fall back to the
 * environment user-data dir so the feature still works for legacy/virtual
 * workspaces.
 */
export class CheckpointService extends Disposable implements ICheckpointService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidCreateCheckpoint = this._register(new Emitter<ICheckpoint>());
	readonly onDidCreateCheckpoint: Event<ICheckpoint> = this._onDidCreateCheckpoint.event;

	/** agentId → active sessionId, set by the controller when streaming starts. */
	private readonly _activeSessions = new Map<string, string>();

	/** TTL 清扫是否已触发（每进程一次，见 setActiveSession）。 */
	private _ttlPruneStarted = false;

	/**
	 * uri → agent 最后一次写入的内容（2026-09-12，P1-3：外部改动检测基线）。
	 *
	 * 用途：回退前检测「agent 编辑之后、回退之前被**用户手动改过**」的文件。
	 *
	 * 为什么要单独检测 —— 回退写回的是「agent 写入**前**的内容」，因此它天然保留了
	 * 此前所有的人类改动。**唯一真正的丢失场景**是：agent 改完 → 用户又手动改 → 回退
	 * → 用户这次手改被抹掉。此时「当前磁盘内容 ≠ agent 最后写入的内容」即为信号。
	 *
	 * ⚠ 内存态：窗口重载后丢失 → 重载后的预检保守返回空（宁可漏报不误报）。
	 */
	private readonly _lastAgentWrite = new Map<string, string>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IAgentStudioService private readonly studioService: IAgentStudioService,
	) {
		super();
	}

	// ─── Active session tracking (for tool-edit capture) ──────────────────────

	setActiveSession(agentId: string, sessionId: string): void {
		this._activeSessions.set(agentId, sessionId);
		if (!this._ttlPruneStarted) {
			this._ttlPruneStarted = true;
			// 2026-09-12（P0-3）：每进程首次注册活跃会话时做一次 TTL 清扫
			// （fire-and-forget —— 绝不阻塞会话切换；失败只 warn）。
			void this.pruneStaleSessions();
		}
	}

	async captureBeforeToolEdit(agentId: string, fileUri: string, newContent?: string): Promise<void> {
		const sessionId = this._activeSessions.get(agentId);
		if (!sessionId) {
			// 2026-09-12（P0-4）：此前**完全静默** return —— 事后无法解释「为什么这次编辑
			// 没有检查点」（用户以为可回退、实际没有）。改为 warn 留痕（对齐「降级必须可见」）。
			this.logService.warn(
				`[CheckpointService] captureBeforeToolEdit skipped: no active session for agent ${agentId} ` +
				`(file ${fileUri}) — this edit will NOT be revertible via checkpoints.`,
			);
			return;
		}
		// Derive a short, human-readable file name for the checkpoint label
		// instead of dumping the full URI (which is noisy in the card).
		let resource: URI;
		try {
			resource = URI.parse(fileUri);
		} catch {
			resource = URI.file(fileUri);
		}
		const segments = resource.path.split('/').filter(Boolean);
		const shortName = segments[segments.length - 1] || fileUri;

		// Compute additions/deletions vs. the file's pre-edit content so the
		// checkpoint bar can show "+N -N" like Void / GitHub diff stats.
		let oldContent = '';
		try {
			if (await this.fileService.exists(resource)) {
				oldContent = (await this.fileService.readFile(resource)).value.toString();
			}
		} catch {
			/* treat unreadable as empty (new file) */
		}
		const { additions, deletions } = this._computeLineDiff(oldContent, newContent ?? '');
		// 2026-09-12（P1-3）：登记 agent 本次写入的内容，作为「用户手改」检测的基线
		// （见 _lastAgentWrite）。newContent 未知时**保留旧基线**（不误清）。
		if (typeof newContent === 'string') {
			this._lastAgentWrite.set(resource.toString(), newContent);
		}
		const fileChange: ICheckpointFileChange = {
			uri: resource.toString(),
			fileName: shortName,
			fsPath: resource.fsPath,
			additions,
			deletions,
		};

		try {
			await this.createCheckpointFromUris(agentId, sessionId, 'tool_edit', [fileUri], {
				label: `编辑 ${shortName}`,
				description: `${shortName} 文件变更`,
				files: [fileChange],
			});
		} catch (err) {
			this.logService.warn(`[CheckpointService] captureBeforeToolEdit failed for ${fileUri}: ${err}`);
		}
	}

	/**
	 * 预检：找出「agent 编辑之后被**用户手动改过**」的文件（2026-09-12，P1-3）。
	 *
	 * 判定：某文件的**当前磁盘内容** ≠ agent 最后一次写入的内容（{@link _lastAgentWrite}）。
	 * 这些文件一旦回退，用户的手动改动会被抹掉 —— 调用方应在回退前向用户确认。
	 *
	 * 保守边界（宁可漏报不误报，避免无谓的惊吓式确认）：
	 *   · 无 agent 写入基线（窗口重载 / agent 未传 newContent）→ 跳过该文件；
	 *   · 文件读不到 / 已不存在 → 跳过；
	 *   · 只看**存活 tool_edit 检查点**覆盖的文件（= 本次回退真正会动的文件）。
	 *
	 * @returns 被外部修改过的文件 URI 列表（空数组 = 无冲突）。
	 */
	async detectExternallyModifiedFiles(agentId: string, sessionId: string): Promise<string[]> {
		const out: string[] = [];
		try {
			const sessionDir = await this._resolveSessionDir(agentId, sessionId);
			const index = await this._readIndex(sessionDir);
			const active = index.filter(cp => cp.type === 'tool_edit' && !cp.isGhost);

			const uris = new Set<string>();
			for (const cp of active) {
				for (const snapshotId of cp.fileSnapshotIds) {
					const snapshot = await this._readSnapshot(sessionDir, snapshotId);
					if (snapshot) { uris.add(snapshot.uri); }
				}
			}

			for (const uriStr of uris) {
				const baseline = this._lastAgentWrite.get(uriStr);
				if (baseline === undefined) { continue; }
				try {
					const resource = URI.parse(uriStr);
					if (!(await this.fileService.exists(resource))) { continue; }
					const current = (await this.fileService.readFile(resource)).value.toString();
					if (current !== baseline) { out.push(uriStr); }
				} catch {
					// 读不到 → 保守跳过（不判定为冲突）
				}
			}
			if (out.length > 0) {
				this.logService.warn(
					`[CheckpointService] detectExternallyModifiedFiles: ${out.length} file(s) changed after the ` +
					`agent's last write — reverting will discard those manual edits`,
				);
			}
		} catch (err) {
			this.logService.warn(`[CheckpointService] detectExternallyModifiedFiles failed (non-fatal): ${err}`);
		}
		return out;
	}

	/**
	 * Compute a coarse line-level diff (added/removed line counts) between two
	 * text blobs. This is a lightweight LCS-free heuristic sufficient for the
	 * checkpoint bar's "+N -N" badge: lines present only in `next` count as
	 * additions, lines present only in `prev` count as deletions (multiset diff).
	 */
	private _computeLineDiff(prev: string, next: string): { additions: number; deletions: number } {
		if (prev === next) {
			return { additions: 0, deletions: 0 };
		}
		const prevLines = prev.length ? prev.split('\n') : [];
		const nextLines = next.length ? next.split('\n') : [];
		// Multiset counts so reordering doesn't inflate the diff too much.
		const count = new Map<string, number>();
		for (const l of prevLines) { count.set(l, (count.get(l) ?? 0) + 1); }
		let additions = 0;
		for (const l of nextLines) {
			const c = count.get(l) ?? 0;
			if (c > 0) { count.set(l, c - 1); } else { additions++; }
		}
		let deletions = 0;
		for (const c of count.values()) { deletions += c; }
		return { additions, deletions };
	}

	// ─── Storage path resolution ────────────────────────────────────────────

	/**
	 * Resolve the base directory for an agent's checkpoint storage.
	 * Prefers the workspace home dir (Workspace.path); falls back to the
	 * environment user-data dir.
	 */
	private async _resolveSessionDir(agentId: string, sessionId: string): Promise<URI> {
		let baseDir: URI | undefined;
		try {
			// Agent is global; the runtime workspace is resolved from the session
			// (sessionId → session.workspaceId), falling back to the active workspace.
			let workspaceId: string | undefined;
			try {
				const session = await this.studioService.getSession(sessionId);
				workspaceId = session?.workspaceId;
			} catch {
				// ignore — fall through to active workspace
			}
			if (!workspaceId) {
				workspaceId = this.studioService.getActiveWorkspaceId();
			}
			if (workspaceId) {
				const workspace = await this.studioService.getWorkspace(workspaceId);
				if (workspace?.path) {
					baseDir = URI.file(workspace.path);
				}
			}
		} catch (err) {
			this.logService.warn(`[CheckpointService] Failed to resolve workspace home for ${agentId}: ${err}`);
		}

		if (!baseDir) {
			// Fallback: user-data dir keeps the feature alive for virtual workspaces.
			// Unified with other modules under ~/.vssaros/.
			// ⚠ 2026-09-12 修：此处此前写成 joinPath(root, 'checkpoints')，与下方统一
			// 拼接的 `.sarosworkspace/checkpoints/...` 叠加后变成
			// `~/.vssaros/checkpoints/.sarosworkspace/checkpoints/<agent>/<session>`
			// （多出一层无意义的 checkpoints/）。只给「根」，路径段由下方统一负责。
			baseDir = resolveSarosPath(URI.file(this.environmentService.userDataPath));
		}

		return joinPath(baseDir, '.sarosworkspace', 'checkpoints', agentId, sessionId);
	}

	private _indexUri(sessionDir: URI): URI {
		return joinPath(sessionDir, 'index.json');
	}

	private _snapshotUri(sessionDir: URI, snapshotId: string): URI {
		return joinPath(sessionDir, 'snapshots', `${snapshotId}.json`);
	}

	/**
	 * 解析检查点**根目录**（`<base>/.sarosworkspace/checkpoints`）—— 跨会话清扫用。
	 * 与 {@link _resolveSessionDir} 同源：优先 active workspace，回退 user-data 目录。
	 */
	private async _resolveCheckpointsRoot(): Promise<URI> {
		let baseDir: URI | undefined;
		try {
			const workspaceId = this.studioService.getActiveWorkspaceId();
			if (workspaceId) {
				const workspace = await this.studioService.getWorkspace(workspaceId);
				if (workspace?.path) { baseDir = URI.file(workspace.path); }
			}
		} catch (err) {
			this.logService.warn(`[CheckpointService] Failed to resolve workspace for TTL prune: ${err}`);
		}
		if (!baseDir) {
			baseDir = resolveSarosPath(URI.file(this.environmentService.userDataPath));
		}
		return joinPath(baseDir, '.sarosworkspace', 'checkpoints');
	}

	/**
	 * 清扫过期会话的检查点（TTL，2026-09-12，P0-3）。
	 *
	 * 遍历 `<root>/<agentId>/<sessionId>/`，取该会话**最新**检查点的 createdAt
	 * （索引为空/损坏时用目录 mtime 兜底），超过 `maxAgeMs` → 删除整个会话目录。
	 *
	 * 保守边界：时间戳缺失（0）不判定过期 —— 宁可漏清也不误删用户数据。
	 * 失败只 warn（尽力而为），返回实际删除的会话数。
	 */
	async pruneStaleSessions(maxAgeMs: number = CHECKPOINT_TTL_MS): Promise<number> {
		let removed = 0;
		try {
			const root = await this._resolveCheckpointsRoot();
			if (!(await this.fileService.exists(root))) { return 0; }
			const rootStat = await this.fileService.resolve(root);
			const now = Date.now();
			for (const agentDir of rootStat.children ?? []) {
				if (!agentDir.isDirectory) { continue; }
				let agentStat;
				try { agentStat = await this.fileService.resolve(agentDir.resource); } catch { continue; }
				for (const sessionDir of agentStat.children ?? []) {
					if (!sessionDir.isDirectory) { continue; }
					const index = await this._readIndex(sessionDir.resource);
					const latest = index.reduce((max, cp) => Math.max(max, cp.createdAt), 0);
					// 索引为空/损坏时用目录 mtime 兜底（IFileStat.mtime 可选 → 再兜 0，
					// isSessionExpired 对 0 判定为「不过期」，宁可漏清不误删）。
					if (!isSessionExpired(latest || sessionDir.mtime || 0, now, maxAgeMs)) { continue; }
					try {
						await this.fileService.del(sessionDir.resource, { recursive: true });
						removed++;
					} catch (err) {
						this.logService.warn(
							`[CheckpointService] TTL prune: failed to delete ${sessionDir.resource.toString()}: ${err}`,
						);
					}
				}
			}
			if (removed > 0) {
				this.logService.info(
					`[CheckpointService] TTL prune: removed ${removed} stale session checkpoint dir(s) ` +
					`(idle for more than ${Math.round(maxAgeMs / 86400000)} day(s))`,
				);
			}
		} catch (err) {
			this.logService.warn(`[CheckpointService] TTL prune failed (non-fatal): ${err}`);
		}
		return removed;
	}

	// ─── Index read / write ──────────────────────────────────────────────────

	private async _readIndex(sessionDir: URI): Promise<IStoredCheckpoint[]> {
		const indexUri = this._indexUri(sessionDir);
		try {
			if (!(await this.fileService.exists(indexUri))) {
				return [];
			}
			const content = await this.fileService.readFile(indexUri);
			const parsed = JSON.parse(content.value.toString());
			return Array.isArray(parsed) ? parsed as IStoredCheckpoint[] : [];
		} catch (err) {
			this.logService.error(`[CheckpointService] Failed to read index ${indexUri.toString()}: ${err}`);
			return [];
		}
	}

	private async _writeIndex(sessionDir: URI, checkpoints: IStoredCheckpoint[]): Promise<void> {
		const indexUri = this._indexUri(sessionDir);
		const json = JSON.stringify(checkpoints, null, 2);
		// ★ 2026-09-15：检查点索引/快照是**每次编辑都会覆盖写**且回退时立刻要读 ⇒ 原子写
		//（半写 ⇒ 该会话的全部检查点无法回退）。详见 `common/atomicWrite.ts`。
		await writeFileAtomicSafe(this.fileService, indexUri, VSBuffer.fromString(json));
	}

	// ─── Snapshot read / write ────────────────────────────────────────────────

	private async _writeSnapshot(sessionDir: URI, snapshot: IStoredFileSnapshot): Promise<void> {
		const uri = this._snapshotUri(sessionDir, snapshot.id);
		const json = JSON.stringify(snapshot, null, 2);
		await writeFileAtomicSafe(this.fileService, uri, VSBuffer.fromString(json));
	}

	private async _readSnapshot(sessionDir: URI, snapshotId: string): Promise<IStoredFileSnapshot | undefined> {
		const uri = this._snapshotUri(sessionDir, snapshotId);
		try {
			if (!(await this.fileService.exists(uri))) {
				return undefined;
			}
			const content = await this.fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as IStoredFileSnapshot;
		} catch (err) {
			this.logService.error(`[CheckpointService] Failed to read snapshot ${uri.toString()}: ${err}`);
			return undefined;
		}
	}

	// ─── 内容寻址与保留策略（2026-09-12，P0-1 / P0-2）─────────────────────────

	/** SHA-256（WebCrypto，renderer 可用；同 codebaseGraphStore.computeHash 的做法）。 */
	private static async _sha256Hex(text: string): Promise<string> {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * 计算内容寻址的快照 id。
	 *
	 * `existedBefore` **必须参与哈希**：「新建出来的空文件」与「原本就存在的空文件」
	 * 回退语义不同（前者删除、后者写空），仅按内容哈希会把两者错误合并成同一快照。
	 */
	private async _computeSnapshotId(fileData: IFileSnapshotData): Promise<string> {
		const full = await CheckpointService._sha256Hex(
			`${fileData.uri.toString()}\u0000${fileData.existedBefore === false ? '0' : '1'}\u0000${fileData.content}`,
		);
		return full.slice(0, SNAPSHOT_ID_HEX_LENGTH);
	}

	/**
	 * 执行保留策略：把无界的检查点/快照增长变为有界。
	 *
	 * 两级：
	 *   · 按 URI 的版本数 —— 每个文件保留「最早 1 个」（撤销基线，永不淘汰）+ 最近 N 个；
	 *   · 按会话的检查点总数 —— 超限时从最老的开始整体移除，但跳过承载最早快照的检查点。
	 * 淘汰后统一走**引用计数**删除快照文件（内容寻址后可能被多个检查点共享）。
	 */
	private async _pruneSnapshots(sessionDir: URI, index: IStoredCheckpoint[]): Promise<void> {
		try {
			// 1) 收集存活检查点的快照引用（读盘只为拿 uri；缺失的快照跳过）
			const refs: ISnapshotVersionRef[] = [];
			const cache = new Map<string, IStoredFileSnapshot>();
			for (const cp of index) {
				if (cp.isGhost) { continue; }
				for (const sid of cp.fileSnapshotIds) {
					let snap = cache.get(sid);
					if (!snap) {
						snap = await this._readSnapshot(sessionDir, sid);
						if (!snap) { continue; }
						cache.set(sid, snap);
					}
					refs.push({ snapshotId: sid, uri: snap.uri, createdAt: cp.createdAt });
				}
			}

			const protectedIds = collectProtectedSnapshotIds(refs);
			const evictedVersions = planVersionPrune(refs, CHECKPOINT_MAX_VERSIONS_PER_FILE);
			const evictedCheckpoints = planCheckpointEviction(
				index.map(cp => ({
					id: cp.id, createdAt: cp.createdAt, isGhost: cp.isGhost, snapshotIds: cp.fileSnapshotIds,
				})),
				protectedIds,
				CHECKPOINT_MAX_PER_SESSION,
			);
			if (evictedVersions.length === 0 && evictedCheckpoints.length === 0) { return; }

			const evictVersionSet = new Set(evictedVersions);
			const removedCpIds = new Set(evictedCheckpoints);
			const releasedIds: string[] = [];
			const next: IStoredCheckpoint[] = [];
			for (const cp of index) {
				if (removedCpIds.has(cp.id)) {
					releasedIds.push(...cp.fileSnapshotIds);
					continue;
				}
				if (evictVersionSet.size > 0 && cp.fileSnapshotIds.some(id => evictVersionSet.has(id))) {
					const kept: string[] = [];
					for (const id of cp.fileSnapshotIds) {
						if (evictVersionSet.has(id)) { releasedIds.push(id); } else { kept.push(id); }
					}
					cp.fileSnapshotIds = kept;
					// 已无任何快照的 tool_edit 检查点不再具备回退价值 → 一并移除。
					// （user_edit 锚点即使无快照也要保留：它承载对话回退的 messageId。）
					if (cp.type === 'tool_edit' && kept.length === 0) { continue; }
				}
				next.push(cp);
			}

			await this._writeIndex(sessionDir, next);
			const deleted = await this._deleteUnreferencedSnapshots(sessionDir, next, releasedIds);
			this.logService.info(
				`[CheckpointService] Retention: evicted ${evictedVersions.length} snapshot version(s), ` +
				`${evictedCheckpoints.length} checkpoint(s); deleted ${deleted} snapshot file(s)`,
			);
		} catch (err) {
			// 清理是尽力而为 —— 失败绝不影响检查点创建。
			this.logService.warn(`[CheckpointService] Retention prune failed (non-fatal): ${err}`);
		}
	}

	/**
	 * 引用计数删除：只删除**在 `remaining` 中再无任何引用**的快照文件。
	 *
	 * 内容寻址（id = 内容哈希）让多个检查点共享同一快照文件成为常态，因此任何删除
	 * 路径都必须先确认全局无引用（此前 deleteCheckpoint 直接删文件 → 会误删共享快照，
	 * 导致其它检查点回退时「快照缺失」）。
	 *
	 * @returns 实际删除的文件数。
	 */
	private async _deleteUnreferencedSnapshots(
		sessionDir: URI,
		remaining: readonly IStoredCheckpoint[],
		releasedIds: readonly string[],
	): Promise<number> {
		if (releasedIds.length === 0) { return 0; }
		const stillReferenced = new Set<string>();
		for (const cp of remaining) {
			for (const id of cp.fileSnapshotIds) { stillReferenced.add(id); }
		}
		const deletable = selectUnreferencedSnapshotIds(releasedIds, stillReferenced);
		let deleted = 0;
		for (const id of deletable) {
			const uri = this._snapshotUri(sessionDir, id);
			try {
				if (await this.fileService.exists(uri)) {
					await this.fileService.del(uri);
					deleted++;
				}
			} catch (err) {
				this.logService.warn(`[CheckpointService] Failed to delete snapshot ${uri.toString()}: ${err}`);
			}
		}
		return deleted;
	}

	// ─── Mapping helpers ──────────────────────────────────────────────────────

	private _toCheckpoint(stored: IStoredCheckpoint): ICheckpoint {
		// Only emit agentId as the canonical identity field.
		return {
			id: stored.id,
			agentId: stored.agentId,
			sessionId: stored.sessionId,
			type: stored.type,
			label: stored.label,
			description: stored.description,
			createdAt: stored.createdAt,
			fileSnapshotIds: stored.fileSnapshotIds,
			isGhost: stored.isGhost,
			messageId: stored.messageId,
			files: stored.files,
		};
	}

	private _getDefaultLabel(type: 'user_edit' | 'tool_edit'): string {
		const now = new Date();
		const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		return type === 'user_edit' ? `User edit at ${timeStr}` : `Tool edit at ${timeStr}`;
	}

	// ─── Public API ────────────────────────────────────────────────────────────

	async createCheckpoint(payload: ICreateCheckpointPayload): Promise<ICheckpoint> {
		const agentId = payload.agentId;
		if (!agentId) {
			throw new Error('[CheckpointService] createCheckpoint: agentId is required');
		}
		const sessionDir = await this._resolveSessionDir(agentId, payload.sessionId);
		const checkpointId = generateUuid();

		// Persist each file snapshot as its own file —— **内容寻址**（2026-09-12，P0-2）：
		// snapshotId = sha256(uri + existedBefore + content) 前 32 hex。同一（文件 + 内容 +
		// 新建标记）必然得到同一 id → 天然去重，多个检查点可共享同一快照文件
		// （删除必须走引用计数，见 _deleteUnreferencedSnapshots）。已存在则跳过写入。
		const fileSnapshotIds: string[] = [];
		for (const fileData of payload.fileSnapshots) {
			const snapshotId = await this._computeSnapshotId(fileData);
			const snapshotUri = this._snapshotUri(sessionDir, snapshotId);
			// 2026-09-12（P2-3）：超大 / 二进制内容只存元数据（省略 content）——
			// 避免单条快照就撑爆磁盘，并防止二进制解码后写回造成文件损坏。
			// ⚠ 哈希仍用**完整原内容**（见 _computeSnapshotId），故不同大文件得到不同 id。
			const omitContent = shouldOmitSnapshotContent(fileData.content);
			try {
				if (!(await this.fileService.exists(snapshotUri))) {
					const snapshot: IStoredFileSnapshot = {
						id: snapshotId,
						// 内容寻址后同一快照可能被多个检查点共享 → 记录**首次创建者**。
						// 读取侧 getFileSnapshots 会覆写为当前查询的 checkpointId，对外语义不变。
						checkpointId,
						uri: fileData.uri.toString(),
						languageId: fileData.languageId,
						content: omitContent ? '' : fileData.content,
						existedBefore: fileData.existedBefore,
						contentOmitted: omitContent || undefined,
					};
					await this._writeSnapshot(sessionDir, snapshot);
				}
				if (!fileSnapshotIds.includes(snapshotId)) {
					fileSnapshotIds.push(snapshotId);
				}
			} catch (err) {
				this.logService.error(`[CheckpointService] Failed to write snapshot for ${fileData.uri.toString()}: ${err}`);
			}
		}

		const stored: IStoredCheckpoint = {
			id: checkpointId,
			agentId,
			sessionId: payload.sessionId,
			type: payload.type,
			label: payload.label || this._getDefaultLabel(payload.type),
			description: payload.description,
			createdAt: Date.now(),
			fileSnapshotIds,
			isGhost: false,
			messageId: payload.messageId,
			files: payload.files,
		};

		const index = await this._readIndex(sessionDir);
		index.push(stored);
		await this._writeIndex(sessionDir, index);
		// 2026-09-12（P0-1）：写入后执行保留策略 —— 把此前**无界**的检查点/快照增长
		// 变为有界（每个文件保留「最早 1 个 + 最近 N 个」；会话检查点总数上限）。
		// 尽力而为：失败只 warn，绝不能让清理问题导致检查点创建本身失败。
		await this._pruneSnapshots(sessionDir, index);

		this.logService.info(
			`[CheckpointService] Created checkpoint ${checkpointId} (${payload.type}) with ${fileSnapshotIds.length} snapshots`,
		);
		const result = this._toCheckpoint(stored);
		this._onDidCreateCheckpoint.fire(result);
		return result;
	}

	async createCheckpointFromUris(
		agentId: string,
		sessionId: string,
		type: 'user_edit' | 'tool_edit',
		fileUris: string[],
		opts?: { label?: string; description?: string; messageId?: string; files?: ICheckpointFileChange[] },
	): Promise<ICheckpoint | undefined> {
		// Read current on-disk content of each file (skip ones that don't exist).
		const fileSnapshots = [];
		for (const uriStr of fileUris) {
			let resource: URI;
			try {
				resource = URI.parse(uriStr);
			} catch {
				// Treat as a filesystem path.
				resource = URI.file(uriStr);
			}
			try {
				if (await this.fileService.exists(resource)) {
					const content = await this.fileService.readFile(resource);
					fileSnapshots.push({
						uri: resource,
						languageId: undefined,
						content: content.value.toString(),
						existedBefore: true,
					});
				} else {
					// File not yet created — record an empty-content snapshot flagged
					// as existedBefore:false so that reverting DELETES the new file
					// rather than leaving an empty file behind.
					fileSnapshots.push({
						uri: resource,
						languageId: undefined,
						content: '',
						existedBefore: false,
					});
				}
			} catch (err) {
				this.logService.warn(`[CheckpointService] Skip unreadable file ${uriStr}: ${err}`);
			}
		}

		if (fileSnapshots.length === 0) {
			this.logService.info('[CheckpointService] createCheckpointFromUris: no files to snapshot, skipping');
			return undefined;
		}

		return this.createCheckpoint({
			agentId,
			sessionId,
			type,
			label: opts?.label,
			description: opts?.description,
			fileSnapshots,
			messageId: opts?.messageId,
			files: opts?.files,
		});
	}

	async jumpToCheckpoint(agentId: string, sessionId: string, checkpointId: string): Promise<IJumpToCheckpointResult> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const target = index.find(cp => cp.id === checkpointId);
		if (!target) {
			throw new Error(`Checkpoint not found: ${checkpointId}`);
		}

		// 1. Restore each file snapshot's content.
		const restoredFiles: string[] = [];
		const skippedFiles: string[] = [];
		for (const snapshotId of target.fileSnapshotIds) {
			const snapshot = await this._readSnapshot(sessionDir, snapshotId);
			if (!snapshot) {
				continue;
			}
			try {
				const resource = URI.parse(snapshot.uri);
				// existedBefore === false 表示该文件是这次编辑“新建”的，
				// 撤销应当删除它，而不是写入空内容（否则会残留一个空文件）。
				// 旧快照没有该字段（undefined）时按“原本存在”处理，沿用写回逻辑。
				if (snapshot.existedBefore === false) {
					// 新建文件：回退 = 删除，**不依赖 content**（即使内容被省略也能回退）。
					if (await this.fileService.exists(resource)) {
						await this.fileService.del(resource);
					}
					restoredFiles.push(snapshot.uri);
				} else if (snapshot.contentOmitted) {
					// 2026-09-12（P2-3）：内容被省略（超大/二进制）→ 无法还原。
					// **绝不能写入空内容**（会损坏文件）→ 跳过并记录，由调用方提示用户。
					skippedFiles.push(snapshot.uri);
				} else {
					await this.fileService.writeFile(resource, VSBuffer.fromString(snapshot.content));
					restoredFiles.push(snapshot.uri);
				}
			} catch (err) {
				this.logService.error(`[CheckpointService] Failed to restore ${snapshot.uri}: ${err}`);
			}
		}

		// 2. Mark all checkpoints created after the target as ghost (unreachable).
		let removedCount = 0;
		for (const cp of index) {
			if (cp.createdAt > target.createdAt && !cp.isGhost) {
				cp.isGhost = true;
				removedCount++;
			}
		}
		await this._writeIndex(sessionDir, index);

		this.logService.info(
			`[CheckpointService] Jumped to ${checkpointId}: restored ${restoredFiles.length} files, ` +
			`skipped ${skippedFiles.length} (content omitted), ghosted ${removedCount} checkpoints`,
		);

		return {
			checkpointId,
			restoredFiles,
			removedMessages: removedCount, // host maps this; webview truncates by messageId
			skippedFiles,
		};
	}

	/**
	 * 聚合所有（非 ghost）检查点，对每个被改过的文件取其**最早一次**快照
	 * （= 第一次被编辑前的原始内容），把文件还原到该最初状态：
	 *   - `existedBefore === false` 的最早快照 → 该文件是被新建出来的，删除它；
	 *   - 否则写回最早快照内容。
	 * 还原完成后把所有检查点标记为 ghost。
	 *
	 * 这是"撤销全部修改"的正确语义：不是逐个检查点回退，而是直接回到
	 * 任何检查点产生之前的最初状态。与单个 {@link jumpToCheckpoint} 不同，
	 * 后者只还原目标检查点自己的快照。
	 */
	async revertAllCheckpoints(agentId: string, sessionId: string): Promise<IJumpToCheckpointResult> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		// 仅聚合 tool_edit 且非 ghost 的检查点（ghost = 已被回退，不应再参与）。
		const active = index
			.filter(cp => cp.type === 'tool_edit' && !cp.isGhost)
			.sort((a, b) => a.createdAt - b.createdAt);

		// 每个文件 URI → 其最早一次快照（首次遇到即保留，因为已按时间升序）。
		const earliestByUri = new Map<string, IStoredFileSnapshot>();
		for (const cp of active) {
			for (const snapshotId of cp.fileSnapshotIds) {
				const snapshot = await this._readSnapshot(sessionDir, snapshotId);
				if (!snapshot) { continue; }
				if (!earliestByUri.has(snapshot.uri)) {
					earliestByUri.set(snapshot.uri, snapshot);
				}
			}
		}

		const restoredFiles: string[] = [];
		const skippedFiles: string[] = [];
		for (const snapshot of earliestByUri.values()) {
			try {
				const resource = URI.parse(snapshot.uri);
				if (snapshot.existedBefore === false) {
					// 文件是被新建出来的 → 撤销即删除（不依赖 content）。
					if (await this.fileService.exists(resource)) {
						await this.fileService.del(resource);
					}
					restoredFiles.push(snapshot.uri);
				} else if (snapshot.contentOmitted) {
					// 2026-09-12（P2-3）：内容被省略（超大/二进制）→ 无法还原，跳过并记录。
					skippedFiles.push(snapshot.uri);
				} else {
					await this.fileService.writeFile(resource, VSBuffer.fromString(snapshot.content));
					restoredFiles.push(snapshot.uri);
				}
			} catch (err) {
				this.logService.error(`[CheckpointService] revertAll: failed to restore ${snapshot.uri}: ${err}`);
			}
		}

		// 全部标 ghost（已回退，不再可达）。
		let ghosted = 0;
		for (const cp of index) {
			if (!cp.isGhost) { cp.isGhost = true; ghosted++; }
		}
		await this._writeIndex(sessionDir, index);

		this.logService.info(
			`[CheckpointService] revertAllCheckpoints: restored ${restoredFiles.length} files to original, ` +
			`skipped ${skippedFiles.length} (content omitted), ghosted ${ghosted} checkpoints`,
		);

		return {
			checkpointId: '',
			restoredFiles,
			removedMessages: ghosted,
			skippedFiles,
		};
	}

	/**
	 * 聚合所有（非 ghost）tool_edit 检查点，返回每个被改过文件的**最早一次**
	 * 快照（首次编辑前的原始内容）。供"查看全部变更"在一个多文件 diff 窗口
	 * 中对比"最初内容 vs 当前内容"。
	 */
	async getAggregatedFileSnapshots(agentId: string, sessionId: string): Promise<IFileSnapshot[]> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const active = index
			.filter(cp => cp.type === 'tool_edit' && !cp.isGhost)
			.sort((a, b) => a.createdAt - b.createdAt);

		const earliestByUri = new Map<string, IFileSnapshot>();
		for (const cp of active) {
			for (const snapshotId of cp.fileSnapshotIds) {
				const stored = await this._readSnapshot(sessionDir, snapshotId);
				if (!stored) { continue; }
				if (!earliestByUri.has(stored.uri)) {
					earliestByUri.set(stored.uri, {
						id: stored.id,
						checkpointId: stored.checkpointId,
						uri: URI.parse(stored.uri),
						languageId: stored.languageId,
						content: stored.content,
						existedBefore: stored.existedBefore,
						contentOmitted: stored.contentOmitted,
					});
				}
			}
		}
		return [...earliestByUri.values()];
	}

	async getCheckpoint(agentId: string, sessionId: string, checkpointId: string): Promise<ICheckpoint | undefined> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const found = index.find(cp => cp.id === checkpointId);
		return found ? this._toCheckpoint(found) : undefined;
	}

	async listCheckpoints(agentId: string, sessionId: string): Promise<ICheckpoint[]> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		return index
			.slice()
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(cp => this._toCheckpoint(cp));
	}

	async deleteCheckpoint(agentId: string, sessionId: string, checkpointId: string): Promise<void> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const target = index.find(cp => cp.id === checkpointId);
		if (!target) {
			return;
		}

		const next = index.filter(cp => cp.id !== checkpointId);
		await this._writeIndex(sessionDir, next);
		// 2026-09-12：改走**引用计数** —— 内容寻址后同一快照可能被其它检查点共享，
		// 直接删文件会让那些检查点回退时「快照缺失」。
		const deleted = await this._deleteUnreferencedSnapshots(sessionDir, next, target.fileSnapshotIds);
		this.logService.info(
			`[CheckpointService] Deleted checkpoint ${checkpointId} (${deleted} snapshot file(s) freed)`,
		);
	}

	async deleteAllCheckpoints(agentId: string, sessionId: string): Promise<void> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		if (index.length === 0) {
			return;
		}

		const released: string[] = [];
		for (const cp of index) { released.push(...cp.fileSnapshotIds); }
		await this._writeIndex(sessionDir, []);
		const deleted = await this._deleteUnreferencedSnapshots(sessionDir, [], released);
		this.logService.info(
			`[CheckpointService] Deleted all ${index.length} checkpoints for session ${sessionId} ` +
			`(${deleted} snapshot file(s) removed)`,
		);
	}

	/**
	 * 会话被删除时彻底回收其检查点数据（2026-09-12，P0-3）—— 删除整个会话目录。
	 * 此前会话删除路径只重置 UI（`setCheckpoint(null)`），磁盘上的 index + 快照永久残留。
	 */
	async deleteSessionCheckpoints(agentId: string, sessionId: string): Promise<void> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		try {
			if (await this.fileService.exists(sessionDir)) {
				await this.fileService.del(sessionDir, { recursive: true });
				this.logService.info(
					`[CheckpointService] Purged checkpoint dir for deleted session ${sessionId}`,
				);
			}
		} catch (err) {
			this.logService.warn(
				`[CheckpointService] Failed to purge checkpoint dir for session ${sessionId}: ${err}`,
			);
		}
	}

	async getFileSnapshots(agentId: string, sessionId: string, checkpointId: string): Promise<IFileSnapshot[]> {
		const sessionDir = await this._resolveSessionDir(agentId, sessionId);
		const index = await this._readIndex(sessionDir);
		const cp = index.find(c => c.id === checkpointId);
		if (!cp) {
			return [];
		}
		const snapshots: IFileSnapshot[] = [];
		for (const snapshotId of cp.fileSnapshotIds) {
			try {
				const uri = this._snapshotUri(sessionDir, snapshotId);
				if (!await this.fileService.exists(uri)) {
					continue;
				}
				const raw = (await this.fileService.readFile(uri)).value.toString();
				const stored: IStoredFileSnapshot = JSON.parse(raw);
				snapshots.push({
					id: stored.id,
					// 内容寻址后磁盘上的 checkpointId 是「首次创建者」；对外统一返回
					// **当前查询的** checkpoint，保持调用方语义不变（2026-09-12）。
					checkpointId: cp.id,
					uri: URI.parse(stored.uri),
					languageId: stored.languageId,
					content: stored.content,
					existedBefore: stored.existedBefore,
					contentOmitted: stored.contentOmitted,
				});
			} catch (err) {
				this.logService.warn(`[CheckpointService] Failed to read snapshot ${snapshotId}: ${err}`);
			}
		}
		return snapshots;
	}

	async getSnapshotContentForFile(
		agentId: string,
		sessionId: string,
		checkpointId: string,
		fileUri: string,
	): Promise<string | undefined> {
		const snapshots = await this.getFileSnapshots(agentId, sessionId, checkpointId);
		const found = snapshots.find(s => s.uri.toString() === fileUri);
		return found?.content;
	}
}
