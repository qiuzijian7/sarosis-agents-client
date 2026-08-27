/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import {
	IAgentChatService,
	IAgentStudioService,
} from "../common/agentStudio.js";
import type {
	IChatStreamDelta,
	IChatSendOptions,
} from "../common/agentStudio.js";
import { IAgentDriverService } from "../common/agentDriver.js";
import type { ChatMessage } from "../common/types.js";
import { deriveMessageParts } from "../common/types.js";
import type { IChatMessage } from "../common/providers.js";
import { type IForkContext } from "../common/forkContext.js";
import { sliceAtCompactionBoundary, truncateToolResultContent, COMPACTION_METADATA_TYPE, type ICompactionBoundaryInfo } from "../common/historyCompaction.js";
import { IFileService, FileSystemProviderCapabilities } from "../../../../platform/files/common/files.js";
import { IEnvironmentService } from "../../../../platform/environment/common/environment.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { ILifecycleService } from "../../../../workbench/services/lifecycle/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import {
	AGENT_STUDIO_DATA_PATH_SETTING,
	DATA_FILE_CHAT_HISTORY,
	WORKSPACE_DATA_DIR,
	AGENTS_DIR,
} from "../common/constants.js";
import { createIndexLockToken, isIndexLockStale, parseIndexLock, serializeIndexLock } from './codebaseIndexLock.js';

/** 会话锁过期阈值：2min 未心跳视为持有方崩溃，可接管（短于索引锁的 5min——会话崩溃恢复应更快）。 */
const SESSION_LOCK_STALE_MS = 2 * 60 * 1000;

// ─── Agent Session Index ────────────────────────────────────────────────────

/**
 * Metadata for one agent-level session.
 * Stored in agents/{slug}/sessions.json as an array.
 */
export interface AgentSessionMeta {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** External provider session ID (e.g. Knot AG-UI threadId). Captured from stream metadata. */
	providerSessionId?: string;
	/**
	 * Fork prefix-cache fingerprint (MiMo-inspired). Set when this session was forked
	 * from a parent whose frozen system+tools prefix is reused so the LLM provider's
	 * prompt cache hits instead of re-billing the stable prefix every turn.
	 */
	forkContextFingerprint?: string;
	/**
	 * Fork 前缀缓存上下文（MiMo ForkContext）— 请求构造端接 ForkContext 的完整形态。
	 * 携带父级冻结的 system+tools 前缀。fork 会话由 forkAgentSession 持久化父级
	 * ForkContext；后续 sendMessage 经 session.forkContext 透传到 IAgentTurnRequest，
	 * 使子会话请求与父级前缀对齐 → 命中 provider prompt cache。非 fork 会话为 undefined。
	 */
	forkContext?: IForkContext;
}

// ─── Service ────────────────────────────────────────────────────────────────

/**
 * AgentChatService — chat history persistence + agent session management.
 *
 * Storage layout (global, per-agent under ~/.vssaros/):
 *   chat-history/{agentId}/sessions.json          ← session index (array of AgentSessionMeta)
 *   chat-history/{agentId}/sessions/{id}.json     ← chat messages per session
 *
 * Migration: On first access, legacy workspace-local data
 *   (workspace/.sarosworkspace/agents/{agentId}/sessions/)
 *   is automatically copied to the global location.
 */
export class AgentChatService extends Disposable implements IAgentChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _activeStreams = new Map<string, AbortController>();
	private readonly logService: ILogService;
	private readonly driverService: IAgentDriverService;
	private readonly fileService: IFileService;
	private readonly environmentService: IEnvironmentService;
	private readonly configurationService: IConfigurationService;
	private readonly studioService: IAgentStudioService;

	/**
	 * 当前活跃的 onDelta 回调集合。
	 *
	 * 历史实现是单例 `_activeOnDelta`，第二个并发 sendMessage 会覆盖第一个的
	 * 回调，导致第一个流的 memory 事件无法到达 UI（跨流串台根因）。
	 * 改为按 streamKey（agentId::sessionId）分桶，支持同一 agent 下多个会话
	 * 并发流式输出。
	 */
	private readonly _activeOnDeltas = new Map<string, (delta: IChatStreamDelta) => void>();
	/** 每个 streamKey 的创建时间，用于在内存事件桥接时选出"最近一次"流（兜底）。 */
	private readonly _streamCreatedAt = new Map<string, number>();
	/** provider 事件取消订阅函数 */
	private _memoryEventUnsub: (() => void) | null = null;
	/** 内存事件桥接是否已建立（幂等，只建立一次） */
	private _memoryBridgeReady = false;

	/** In-memory cache: compositeKey → messages */
	private readonly _historyCache = new Map<string, ChatMessage[]>();
	/** P0-LRU: last access timestamp (Date.now()) per cache key. */
	private readonly _historyCacheAccess = new Map<string, number>();
	/**
	 * P0-LRU: maximum number of session-level (key contains "::") buckets kept in
	 * memory. noSession buckets (pure agentId, system messages only) are unlimited.
	 * When exceeded during `appendMessage` (new bucket created), evict the
	 * least recently accessed non-open bucket.
	 *
	 * Rationale: each bucket can hold hundreds of ChatMessages with full
	 * ToolResult payloads (multi-GB total).  This cap keeps the renderer
	 * heap comfortably below the 4 GB V8 pointer-compression cage.
	 */
	private static readonly MAX_CACHED_SESSION_BUCKETS = 15;

	/** Per-agent migration marker: prevents repeated migration attempts for the same agent. */
	private readonly _migratedAgents = new Set<string>();
	/**
	 * P1: maximum characters of a single tool call result kept inline in
	 * memory / the session JSON file.  Results exceeding this limit are
	 * externalised to a per-session sidecar directory on bucket eviction
	 * and resolved back on lazy-load.
	 *
	 * 8 KiB ≈ 2 000 tokens — enough for a diff, a search result page, or
	 * a moderate file read.  Typical `read_file` of a 500-line source file
	 * is ~15–25 KiB; this cap cuts it to one-third in memory.
	 */
	private static readonly MAX_INLINE_TOOL_RESULT = 8192;
	/**
	 * P1 sentinel prefix for externalised tool results.
	 *
	 * Format: `\x1EVSSAROS_TOOL_REF:tc_abc123:25000\x1E{truncated preview}`
	 *
	 * The ASCII Record Separator (0x1E, \\036) is deliberately chosen: it
	 * never appears in valid UTF-8 user-facing text, tool output, or JSON.
	 * The marker is still a plain `string`, so all existing `typeof result ===
	 * 'string'` guards (e.g. _toDriverMessages line ~770) continue to work.
	 */
	private static readonly TOOL_REF_MARKER = '\x1EVSSAROS_TOOL_REF:';
	/**
	 * P2: minimum message count before session history compaction kicks in
	 * during LRU eviction.  Sessions shorter than this are kept as-is.
	 * Aligns with ContextManager.minMessagesToCompress default.
	 */
	private static readonly COMPACT_MIN_MESSAGES = 20;
	/**
	 * P2: number of messages at the start of a conversation to keep verbatim
	 * (protected head — task origin).  Aligns with ContextManager.PROTECT_FIRST_N.
	 */
	private static readonly COMPACT_PROTECT_HEAD = 3;
	/**
	 * P2: maximum number of messages at the end of a conversation to keep
	 * verbatim (protected tail — recent context).  Aligns with
	 * ContextManager.TAIL_MAX_MESSAGES.
	 */
	private static readonly COMPACT_PROTECT_TAIL = 15;
	/**
	 * P2: maximum characters of a single tool call result kept in the
	 * middle (summarisable) segment after compaction.  Aligns with
	 * ContextManager.TOOL_RESULT_TRUNCATE_CHARS.
	 */
	private static readonly COMPACT_RESULT_TRUNCATE = 280;
	/**
	 * P4: IPC-time three-segment tool-result truncation applied inside
	 * `_toDriverMessages`.  Every prior message the renderer ships to ext
	 * host is squeezed through this shape:
	 *
	 *   [head COMPACT_PROTECT_HEAD verbatim]
	 *   [middle: tc.result / tool.content sliced to IPC_TRUNCATE]
	 *   [tail COMPACT_PROTECT_TAIL verbatim]
	 *
	 * Rationale: ext host V8 has an independent 4 GB cage.  When a session
	 * has 100+ turns of large ToolResult payloads, the assembled
	 * `IChatMessage[]` array becomes multi-hundred-MB and OOMs ext host
	 * on the ModelProvider serialization path.  Truncating middle-segment
	 * tool payloads (kept verbatim for head+tail) preserves recent context
	 * while cutting the peak IPC/serialization pressure by an order of
	 * magnitude.  Aligns with agentmemory 的 "原文即弃" 中间段策略。
	 */
	private static readonly IPC_TRUNCATE_RESULT_CHARS = 2048;
	// P5: IPC_TRUNCATE_MIN_MESSAGES 已随三段式区域截断一起移除 —— 冻结截断
	// （truncateToolResultContent，确定性、位置无关）取而代之，见 _toDriverMessages。
	/**
	 * P3 retention scoring weights for eviction candidate ranking.
	 * Replaces pure LRU with a weighted score (recency + activity),
	 * directly inspired by agentmemory retention.ts.
	 *
	 * Lower score = more evictable.  Score ∈ [0, 1].
	 *
	 *   score = recencyScore · RECENCY_WEIGHT + activityScore · ACTIVITY_WEIGHT
	 *
	 * recencyScore  = 1 / (1 + daysSinceAccess · RECENCY_DECAY)
	 * activityScore = log₂(msgCount + 1) / ACTIVITY_LOG_CAP
	 */
	private static readonly EVICT_RECENCY_WEIGHT = 0.6;
	private static readonly EVICT_ACTIVITY_WEIGHT = 0.4;
	private static readonly EVICT_RECENCY_DECAY = 0.5;
	private static readonly EVICT_ACTIVITY_LOG_CAP = 10;
	/** Short-lived cache: agentId → session index (avoids 4–5s file read on every task execution). */
	private _sessionIndexCache: Map<string, { meta: AgentSessionMeta; ts: number }> | undefined;
	/** Per-agentId promise chain serialising session-index read-modify-write (prevents interleaved writes truncating the JSON). */
	private readonly _sessionIndexWriteQueue = new Map<string, Promise<void>>();

	// ─── Session index in-memory authority + coalesced flush (2026-08-20) ─────
	// 此前 _doUpdateSessionIndex 每条消息都「读盘 + JSON.parse + 原子写盘」一次：
	// 单个 turn 51 条 assistant 消息 → 51 次读 + 51 次写（日志 1787214724132 尾部
	// `_readSessionIndex(saros-claw): 20 sessions found` 连刷 50+ 次）。
	// 现改为：完整 index 常驻内存作为写路径权威，messageCount/updatedAt 这类高频更新
	// 只改内存并防抖落盘；createAgentSession/rename/delete/fork 等语义性变更仍立即落盘。
	/** agentId → 完整 index 内存副本（写路径权威）。 */
	private readonly _sessionIndexData = new Map<string, { index: AgentSessionMeta[]; loadedAt: number }>();
	/** agentId → 尚未落盘（dirty）。dirty 期间禁止按 TTL 重读磁盘，否则丢失内存修改。 */
	private readonly _sessionIndexDirty = new Set<string>();
	/** agentId → 防抖落盘定时器句柄。 */
	private readonly _sessionIndexFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** 防抖窗口：turn 内连续 append 合并为一次写；崩溃最多丢这段时间的 messageCount。 */
	private static readonly SESSION_INDEX_FLUSH_DELAY_MS = 800;
	/** 内存副本存活时间（无 dirty 时）。多实例场景下过期后重读，感知外部修改。 */
	private static readonly SESSION_INDEX_DATA_TTL_MS = 10_000;

	private _historyLoaded = false;
	private _globalDataUri: URI | undefined;

	private readonly _onDidChangeAgentSessionsEmitter = this._register(
		new Emitter<{ agentId: string }>(),
	);
	readonly onDidChangeAgentSessions: Event<{ agentId: string }> =
		this._onDidChangeAgentSessionsEmitter.event;

	private readonly _onDidStreamDeltaEmitter = this._register(
		new Emitter<{ agentId: string; sessionId: string; delta: IChatStreamDelta }>(),
	);
	readonly onDidStreamDelta: Event<{ agentId: string; sessionId: string; delta: IChatStreamDelta }> =
		this._onDidStreamDeltaEmitter.event;

	/** 广播 user 消息（经 onDidStreamDelta 以 'user_message' delta 形式下发）。 */
	fireUserMessageAdded(agentId: string, sessionId: string, message: unknown): void {
		this._onDidStreamDeltaEmitter.fire({
			agentId,
			sessionId: sessionId || '',
			delta: { type: 'user_message', message } as any,
		});
	}

	constructor(
		@ILogService logService: ILogService,
		@IAgentDriverService driverService: IAgentDriverService,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IConfigurationService configurationService: IConfigurationService,
		@IAgentStudioService studioService: IAgentStudioService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.logService = logService;
		this.driverService = driverService;
		this.fileService = fileService;
		this.environmentService = environmentService;
		this.configurationService = configurationService;
		this.studioService = studioService;
		// 关窗前把防抖窗口内未落盘的 session index 写出（dispose 不能 await，
		// onWillShutdown 的 join 才能真正等待写完成，否则最后几条消息的
		// messageCount/updatedAt 会丢失）。
		this._register(lifecycleService.onWillShutdown(e => {
			if (this._sessionIndexDirty.size === 0) { return; }
			e.join(this._flushAllSessionIndexes(), {
				id: 'agentChatService.sessionIndex',
				label: 'Saving agent session index',
			});
		}));
	}

	/** 落盘所有 dirty 的 session index（关窗兜底）。 */
	private async _flushAllSessionIndexes(): Promise<void> {
		for (const timer of this._sessionIndexFlushTimers.values()) { clearTimeout(timer); }
		this._sessionIndexFlushTimers.clear();
		await Promise.all(
			[...this._sessionIndexDirty].map(agentId => this.flushSessionIndex(agentId).catch(() => { })),
		);
	}

	// ─── Path helpers ────────────────────────────────────────────────────────

	/**
	 * Resolve the global chat history root directory.
	 * All chat sessions are stored under ~/.vssaros/chat-history/ (user-global),
	 * making history accessible across workspaces.
	 */
	private _getChatHistoryRoot(): URI {
		// userRoamingDataHome = ~/.vssaros/User/
		// Going up one level gives ~/.vssaros/
		return URI.joinPath(
			this.environmentService.userRoamingDataHome,
			'..',
			'chat-history',
		);
	}

	private _getGlobalDataUri(): URI {
		if (!this._globalDataUri) {
			const customPath = this.configurationService.getValue<string>(
				AGENT_STUDIO_DATA_PATH_SETTING,
			);
			this._globalDataUri = customPath
				? URI.file(customPath)
				: URI.joinPath(
					this.environmentService.userRoamingDataHome,
					"agent-studio",
				);
		}
		return this._globalDataUri;
	}

	private _getHistoryFileUri(): URI {
		return URI.joinPath(this._getGlobalDataUri(), DATA_FILE_CHAT_HISTORY);
	}

	/**
	 * Resolve the sessions directory and index file URI for an agent.
	 *
	 * Storage is now user-global under ~/.vssaros/chat-history/{agentId}/.
	 * Legacy workspace-local data (workspace/.sarosworkspace/agents/{agentId}/sessions/)
	 * is migrated on first access.
	 */
	private async _resolveAgentPaths(agentId: string): Promise<{
		sessionsDirUri: URI;
		indexUri: URI;
	}> {
		const agentUri = URI.joinPath(this._getChatHistoryRoot(), agentId);

		// Migrate legacy data from workspace-local to global on first access (per-agent)
		if (!this._migratedAgents.has(agentId)) {
			await this._migrateLegacySessions(agentId, agentUri);
		}

		return {
			sessionsDirUri: URI.joinPath(agentUri, "sessions"),
			indexUri: URI.joinPath(agentUri, "sessions.json"),
		};
	}

	/**
	 * Migrate legacy workspace-local session data to the new global location.
	 * Source: {workspace}/.sarosworkspace/agents/{agentId}/sessions.json
	 *         {workspace}/.sarosworkspace/agents/{agentId}/sessions/{id}.json
	 * Target: ~/.vssaros/chat-history/{agentId}/sessions.json
	 *         ~/.vssaros/chat-history/{agentId}/sessions/{id}.json
	 * Only runs once per service lifetime (fire-and-forget, errors are logged).
	 */
	private async _migrateLegacySessions(agentId: string, targetAgentUri: URI): Promise<void> {
		try {
			const activeWorkspaceId = this.studioService.getActiveWorkspaceId();
			if (!activeWorkspaceId) {
				this._migratedAgents.add(agentId);
				return;
			}

			const workspace = await this.studioService.getWorkspace(activeWorkspaceId);
			const workspacePath = workspace?.path;
			if (!workspacePath) {
				this._migratedAgents.add(agentId);
				return;
			}

			const legacyAgentUri = URI.joinPath(
				URI.file(workspacePath),
				WORKSPACE_DATA_DIR,
				AGENTS_DIR,
				agentId,
			);
			const legacyIndexUri = URI.joinPath(legacyAgentUri, 'sessions.json');
			const targetIndexUri = URI.joinPath(targetAgentUri, 'sessions.json');

			// Skip if target already exists or legacy doesn't exist
			if (await this.fileService.exists(targetIndexUri)) {
				this.logService.info(`[AgentChatService] Migration: target already exists for ${agentId}, skipping`);
				this._migratedAgents.add(agentId);
				return;
			}
			if (!(await this.fileService.exists(legacyIndexUri))) {
				// No legacy data for this agent
				this._migratedAgents.add(agentId);
				return;
			}

			this.logService.info(`[AgentChatService] Migrating chat sessions for agent ${agentId} from ${legacyAgentUri.fsPath} to ${targetAgentUri.fsPath}`);

			// Ensure target directory exists
			const targetSessionsDir = URI.joinPath(targetAgentUri, 'sessions');
			if (!(await this.fileService.exists(targetAgentUri))) {
				await this.fileService.createFolder(targetAgentUri);
			}

			// Copy sessions.json index
			const legacyIdxContent = await this.fileService.readFile(legacyIndexUri);
			await this.fileService.writeFile(targetIndexUri, legacyIdxContent.value);

			// Copy individual session files
			const legacySessionsDir = URI.joinPath(legacyAgentUri, 'sessions');
			if (await this.fileService.exists(legacySessionsDir)) {
				if (!(await this.fileService.exists(targetSessionsDir))) {
					await this.fileService.createFolder(targetSessionsDir);
				}
				const children = await this.fileService.resolve(legacySessionsDir);
				if (children.children) {
					for (const child of children.children) {
						if (!child.isDirectory && child.name.endsWith('.json')) {
							const targetFile = URI.joinPath(targetSessionsDir, child.name);
							if (!(await this.fileService.exists(targetFile))) {
								const content = await this.fileService.readFile(child.resource);
								await this.fileService.writeFile(targetFile, content.value);
							}
						}
					}
				}
			}

			this.logService.info(`[AgentChatService] Migration complete for agent ${agentId}`);
		} catch (err) {
			this.logService.warn(`[AgentChatService] Migration failed for agent ${agentId}:`, err);
		} finally {
			this._migratedAgents.add(agentId);
		}
	}

	private _sessionFileUri(sessionsDirUri: URI, sessionId: string): URI {
		return URI.joinPath(sessionsDirUri, `${sessionId}.json`);
	}

	private _cacheKey(agentId: string, sessionId?: string): string {
		return sessionId ? `${agentId}::${sessionId}` : agentId;
	}

	// ─── 会话跨实例锁（多开 --instance 同会话双开只读）─────────────────────────
	// 锁文件：sessions/{sessionId}.lock（JSON {token, instanceId, acquiredAt}，复用
	// codebaseIndexLock 的解析/过期判定）。持锁期间 30s 心跳刷新 mtime；2min 未刷新
	// 视为持有方崩溃，可接管。释放仅删自己的锁。

	private _sessionLockToken: string | undefined;
	private _sessionLockHeartbeat: ReturnType<typeof setInterval> | undefined;
	private _sessionLockUri: URI | undefined;

	/**
	 * 尝试获取会话锁。返回 acquired=false 时表示另一实例正在编辑（含持锁实例 ID）。
	 * 锁过期（持有方崩溃 2min）自动接管。
	 */
	async tryAcquireSessionLock(agentId: string, sessionId: string): Promise<{ acquired: boolean; holderInstanceId?: string }> {
		try {
			const { sessionsDirUri } = await this._resolveAgentPaths(agentId);
			const lockUri = URI.joinPath(sessionsDirUri, `${sessionId}.lock`);
			const instanceId = (this.environmentService as unknown as { instanceId?: string }).instanceId;
			if (!this._sessionLockToken) {
				this._sessionLockToken = createIndexLockToken(instanceId);
			}
			const token = this._sessionLockToken;

			// 已有锁且新鲜且属他人 → 拒绝
			try {
				const existing = await this.fileService.readFile(lockUri);
				const mtime = (await this.fileService.stat(lockUri)).mtime;
				const content = parseIndexLock(existing.value.toString());
				if (content && content.token !== token && !isIndexLockStale(mtime, Date.now(), SESSION_LOCK_STALE_MS)) {
					return { acquired: false, holderInstanceId: content.instanceId };
				}
			} catch { /* 无锁文件 → 可获取 */ }

			// 释放旧锁（切换会话）
			await this._releaseSessionLockFile();

			const writeLock = async () => {
				await this.fileService.writeFile(lockUri, VSBuffer.fromString(serializeIndexLock({
					token, instanceId, acquiredAt: Date.now(),
				})));
			};
			await writeLock();
			this._sessionLockUri = lockUri;
			this._sessionLockHeartbeat = setInterval(() => { void writeLock().catch(() => { /* 心跳失败忽略 */ }); }, 30_000);
			return { acquired: true };
		} catch (err) {
			this.logService.warn(`[AgentChatService] tryAcquireSessionLock failed (fail-open): ${err}`);
			return { acquired: true }; // 文件系统异常时放行，避免锁死用户输入
		}
	}

	/** 释放当前持有的会话锁（仅删自己的锁）。 */
	async releaseSessionLock(): Promise<void> {
		if (this._sessionLockHeartbeat) {
			clearInterval(this._sessionLockHeartbeat);
			this._sessionLockHeartbeat = undefined;
		}
		await this._releaseSessionLockFile();
	}

	private async _releaseSessionLockFile(): Promise<void> {
		const lockUri = this._sessionLockUri;
		this._sessionLockUri = undefined;
		if (!lockUri || !this._sessionLockToken) { return; }
		try {
			const cur = await this.fileService.readFile(lockUri);
			const content = parseIndexLock(cur.value.toString());
			if (content?.token === this._sessionLockToken) {
				await this.fileService.del(lockUri);
			}
		} catch { /* 锁已被删/被接管，忽略 */ }
	}

	// ─── P1: Tool result externalisation ────────────────────────────────────

	/**
	 * Resolve the sidecar directory for a session.
	 * agents/{slug}/sessions/{sessionId}.sidecar/
	 */
	private async _sidecarDirUri(agentId: string, sessionId: string): Promise<URI> {
		const { sessionsDirUri } = await this._resolveAgentPaths(agentId);
		return URI.joinPath(sessionsDirUri, `${sessionId}.sidecar`);
	}

	/**
	 * P1: Externalise oversize tool results in a message array and write the
	 * excess to the session sidecar directory.  Called during LRU eviction so
	 * the session file on disk is compact and future lazy-loads are fast.
	 *
	 * Returns the number of externalised results.
	 */
	private async _externalizeToolResults(
		agentId: string,
		sessionId: string,
		messages: ChatMessage[],
	): Promise<number> {
		let count = 0;
		const sidecarDir = await this._sidecarDirUri(agentId, sessionId);
		if (!(await this.fileService.exists(sidecarDir))) {
			await this.fileService.createFolder(sidecarDir);
		}
		for (const msg of messages) {
			if (!msg.toolCalls) { continue; }
			for (const tc of msg.toolCalls) {
				const result = tc.result;
				if (!result || result.length <= AgentChatService.MAX_INLINE_TOOL_RESULT) { continue; }
				// Write full result to sidecar
				const sidecarFile = URI.joinPath(sidecarDir, `tool_${tc.id}.json`);
				const preview = result.slice(0, 400);
				const marker = `${AgentChatService.TOOL_REF_MARKER}${tc.id}:${result.length}\x1E${preview}`;
				await this.fileService.writeFile(
					sidecarFile,
					VSBuffer.fromString(result),
				);
				// Replace inline result with marker
				(tc as any).result = marker;
				count++;
			}
		}
		if (count > 0) {
			this.logService.info(
				`[AgentChatService][P1] Externalised ${count} tool result(s) for ${sessionId} (cap=${AgentChatService.MAX_INLINE_TOOL_RESULT})`,
			);
		}
		return count;
	}

	/**
	 * P1: Resolve externalised tool result references back to full content.
	 * Reads sidecar files and replaces markers inline.  Called on lazy-load
	 * so the in-memory bucket always holds complete data.
	 *
	 * Returns the number of resolved refs.
	 */
	private async _resolveToolResultRefs(
		agentId: string,
		sessionId: string,
		messages: ChatMessage[],
	): Promise<number> {
		let count = 0;
		const sidecarDir = await this._sidecarDirUri(agentId, sessionId);
		const sidecarExists = await this.fileService.exists(sidecarDir);
		for (const msg of messages) {
			if (!msg.toolCalls) { continue; }
			for (const tc of msg.toolCalls) {
				const result = tc.result;
				if (!result || !result.startsWith(AgentChatService.TOOL_REF_MARKER)) { continue; }
				if (!sidecarExists) { continue; }
				// Parse: \x1EVSSAROS_TOOL_REF:toolCallId:len\x1Epreview
				const payload = result.slice(AgentChatService.TOOL_REF_MARKER.length);
				const endIdx = payload.indexOf('\x1E');
				if (endIdx < 0) { continue; }
				const header = payload.slice(0, endIdx);
				const colonIdx = header.lastIndexOf(':');
				if (colonIdx < 0) { continue; }
				const toolCallId = header.slice(0, colonIdx);
				const sidecarFile = URI.joinPath(sidecarDir, `tool_${toolCallId}.json`);
				try {
					if (!(await this.fileService.exists(sidecarFile))) { continue; }
					const content = await this.fileService.readFile(sidecarFile);
					(tc as any).result = content.value.toString();
					count++;
				} catch {
					// Sidecar read failed — leave marker as-is (UI will show preview)
				}
			}
		}
		if (count > 0) {
			this.logService.info(
				`[AgentChatService][P1] Resolved ${count} tool result ref(s) for ${sessionId}`,
			);
		}
		return count;
	}

	/**
	 * P1: Delete sidecar directory for a session (called on session deletion).
	 */
	private async _deleteSidecarDir(agentId: string, sessionId: string): Promise<void> {
		try {
			const sidecarDir = await this._sidecarDirUri(agentId, sessionId);
			if (await this.fileService.exists(sidecarDir)) {
				await this.fileService.del(sidecarDir, { recursive: true });
			}
		} catch {
			/* ignore */
		}
	}

	/**
	 * P2: Compact a session's message history before eviction.
	 *
	 * Three-segment compaction (aligns with ContextManager.compressContext):
	 *   1. System messages — kept verbatim
	 *   2. Protected head (first COMPACT_PROTECT_HEAD non-system messages) — kept verbatim
	 *   3. Protected tail (last  COMPACT_PROTECT_TAIL  non-system messages) — kept verbatim
	 *   4. Middle segment — each toolCall.result truncated to COMPACT_RESULT_TRUNCATE chars
	 *
	 * This is a purely local / deterministic operation — no LLM call.
	 * It mirrors what `compressContext` already does to the transient LLM window,
	 * but persists the result so the next lazy-load is fast and compact.
	 *
	 * Short sessions (< COMPACT_MIN_MESSAGES) are left untouched.
	 *
	 * Returns the number of truncated tool results.
	 */
	private _compactMessagesForEviction(
		messages: ChatMessage[],
	): number {
		if (messages.length < AgentChatService.COMPACT_MIN_MESSAGES) {
			return 0;
		}
		// Split into system and conversation messages
		const systemMsgs: ChatMessage[] = [];
		const convMsgs: ChatMessage[] = [];
		for (const m of messages) {
			if (m.role === 'system') { systemMsgs.push(m); }
			else { convMsgs.push(m); }
		}
		if (convMsgs.length <= AgentChatService.COMPACT_PROTECT_HEAD + AgentChatService.COMPACT_PROTECT_TAIL) {
			return 0; // head+tail already cover everything — nothing to compact
		}

		const head = convMsgs.slice(0, AgentChatService.COMPACT_PROTECT_HEAD);
		const tail = convMsgs.slice(-AgentChatService.COMPACT_PROTECT_TAIL);
		const headEnd = AgentChatService.COMPACT_PROTECT_HEAD;
		const tailStart = convMsgs.length - AgentChatService.COMPACT_PROTECT_TAIL;
		const middle = convMsgs.slice(headEnd, Math.max(headEnd, tailStart));

		let truncated = 0;
		for (const m of middle) {
			if (!m.toolCalls) { continue; }
			for (const tc of m.toolCalls) {
				const result = tc.result;
				if (!result || result.length <= AgentChatService.COMPACT_RESULT_TRUNCATE) { continue; }
				(tc as any).result = result.slice(0, AgentChatService.COMPACT_RESULT_TRUNCATE);
				truncated++;
			}
		}

		// Rebuild in order: system → head → middle → tail
		messages.length = 0;
		messages.push(...systemMsgs, ...head, ...middle, ...tail);

		return truncated;
	}

	// ─── Global history (fallback) ───────────────────────────────────────────

	/** P0-LRU: mark a bucket as recently accessed. */
	private _touchBucket(key: string): void {
		this._historyCacheAccess.set(key, Date.now());
	}

	/** P0-LRU: check whether a bucket is "open" (streaming or has active onDelta). */
	private _isBucketOpen(key: string): boolean {
		// key format: agentId::sessionId  or  agentId
		return this._activeStreams.has(key) || this._activeOnDeltas.has(key);
	}

	/**
	 * P3 retention score for eviction candidate ranking.
	 *
	 * Lower score = more evictable.  Combines recency (access time) and
	 * activity (message count) into a single score ∈ [0, 1].
	 *
	 * recencyScore  = 1 / (1 + daysSinceAccess · DECAY)
	 * activityScore = log₂(msgCount + 1) / LOG_CAP
	 * score         = recencyScore · RECENCY_W + activityScore · ACTIVITY_W
	 *
	 * This means: a frequently-accessed 500-msg session can outrank a
	 * recently-accessed 2-msg session, preventing thrashing where a
	 * trivial interaction evicts a heavyweight conversation.
	 * Directly inspired by agentmemory retention.ts `computeRetention()`.
	 */
	private _scoreBucketForEviction(accessTime: number, msgCount: number): number {
		const daysSince = (Date.now() - accessTime) / (1000 * 60 * 60 * 24);
		const recencyScore = 1 / (1 + Math.max(0, daysSince) * AgentChatService.EVICT_RECENCY_DECAY);
		const activityScore = Math.log2(Math.max(1, msgCount + 1)) / AgentChatService.EVICT_ACTIVITY_LOG_CAP;
		return recencyScore * AgentChatService.EVICT_RECENCY_WEIGHT
			+ activityScore * AgentChatService.EVICT_ACTIVITY_WEIGHT;
	}

	/** P0-LRU: evict the single least-recently-used non-open session bucket. */
	private async _evictLruBucket(): Promise<void> {
		// Collect candidate keys: only session buckets (contain "::") that are
		// NOT open.  noSession buckets and open buckets are never evicted.
		const candidates: { key: string; access: number; msgCount: number; score: number }[] = [];
		for (const [key, access] of this._historyCacheAccess) {
			if (!key.includes('::')) { continue; }       // protect noSession system buckets
			if (this._isBucketOpen(key)) { continue; }    // protect streaming/active buckets
			const msgCnt = this._historyCache.get(key)?.length ?? 0;
			const score = this._scoreBucketForEviction(access, msgCnt);
			candidates.push({ key, access, msgCount: msgCnt, score });
		}
		if (candidates.length === 0) {
			this.logService.warn(
				`[AgentChatService][LRU] evict: no candidates (all ${this._countSessionBuckets()} buckets open/streaming)`,
			);
			return;
		}
		// P3: sort by retention score ascending (lowest score = most evictable)
		candidates.sort((a, b) => a.score - b.score);
		const victim = candidates[0];
		const messages = this._historyCache.get(victim.key);
		// P1: externalise oversize tool results to sidecar before eviction,
		// then rewrite the session file so disk is compact too.
		const sepIdx = victim.key.indexOf('::');
		const agentId = victim.key.slice(0, sepIdx);
		const sessionId = victim.key.slice(sepIdx + 2);
		if (messages && messages.length > 0) {
			let dirty = false;
			try {
				const externalised = await this._externalizeToolResults(agentId, sessionId, messages);
				dirty = dirty || externalised > 0;
			} catch (err) {
				this.logService.warn(
					`[AgentChatService][LRU] P1 externalise failed for ${victim}: ${err instanceof Error ? err.message : err}`,
				);
			}
			// P2: compact middle-segment tool results to 280 chars (local, no LLM)
			const truncated = this._compactMessagesForEviction(messages);
			if (truncated > 0) {
				dirty = true;
				this.logService.info(
					`[AgentChatService][P2] Compacted ${truncated} middle-segment tool result(s) for ${victim} (head=${AgentChatService.COMPACT_PROTECT_HEAD} tail=${AgentChatService.COMPACT_PROTECT_TAIL})`,
				);
			}
			if (dirty) {
				await this._persistToSessionFile(agentId, sessionId, messages).catch((err) =>
					this.logService.warn(
						`[AgentChatService][LRU] persist after P1+P2 failed for ${victim}: ${err instanceof Error ? err.message : err}`,
					),
				);
			}
		}
		this._historyCache.delete(victim.key);
		this._historyCacheAccess.delete(victim.key);
		this.logService.info(
			`[AgentChatService][LRU] evicted bucket ${victim.key} (score=${victim.score.toFixed(3)} ${victim.msgCount} msgs, last access ${Math.round((Date.now() - victim.access) / 1000)}s ago, ${candidates.length} candidates)`,
		);
	}

	/** P0-LRU: count session buckets (keys with "::") currently in cache. */
	private _countSessionBuckets(): number {
		let count = 0;
		for (const key of this._historyCache.keys()) {
			if (key.includes('::')) { count++; }
		}
		return count;
	}

	/** P0-LRU: evict LRU buckets until we are at or under the session bucket cap. */
	private async _evictIfNeeded(): Promise<void> {
		while (this._countSessionBuckets() > AgentChatService.MAX_CACHED_SESSION_BUCKETS) {
			await this._evictLruBucket();
		}
	}

	// ─── OOM 诊断：每条消息的堆增长 + 历史留存归因 ──────────────────────────
	// 2026-07-13：用户反馈「每发一条消息内存持续增长直至崩溃」。疑点：活跃会话桶
	// _historyCache[key] 无界累积（LRU 只淘汰整条会话桶，不裁剪活跃会话内的消息），
	// 且 ToolMessage.result（文件全文/搜索输出）原样留存。字节估算用字段长度求和，
	// 绝不 JSON.stringify 整桶（避免 OOM 时翻倍分配）。只扫活跃桶，避免 O(n²)。
	private static _estimateMessageBytes(m: ChatMessage): number {
		try {
			let n = 0;
			const a = m as any;
			if (typeof a.content === 'string') { n += a.content.length; }
			if (typeof a.displayContent === 'string') { n += a.displayContent.length; }
			if (typeof a.reasoning === 'string') { n += a.reasoning.length; }
			if (Array.isArray(a.thinking)) {
				for (const b of a.thinking) {
					n += typeof b?.thinking === 'string' ? b.thinking.length : 0;
					n += typeof b?.data === 'string' ? b.data.length : 0;
				}
			}
			// parts（落盘有序段：文本段 + 工具段，重载渲染的真相源）
			if (Array.isArray(a.parts)) {
				for (const p of a.parts) {
					n += typeof p?.text === 'string' ? p.text.length : 0;
					n += typeof p?.content === 'string' ? p.content.length : 0;
				}
			}
			// assistant.toolCalls[].result —— 工具结果（文件全文/搜索输出）的真正留存点
			if (Array.isArray(a.toolCalls)) {
				for (const tc of a.toolCalls) {
					n += typeof tc?.arguments === 'string' ? tc.arguments.length : 0;
					if (tc?.params && typeof tc.params === 'object') { try { n += JSON.stringify(tc.params).length; } catch { /* ignore */ } }
					const r = tc?.result;
					if (r) {
						if (typeof r === 'string') {
							n += r.length;
						} else if (Array.isArray(r.content)) {
							for (const rc of r.content) {
								n += typeof rc?.text === 'string' ? rc.text.length : 0;
								n += typeof rc?.data === 'string' ? rc.data.length : 0;
								if (Array.isArray(rc?.items)) {
									for (const it of rc.items) {
										n += typeof it?.content === 'string' ? it.content.length : 0;
										n += typeof it?.path === 'string' ? it.path.length : 0;
									}
								}
							}
						}
					}
				}
			}
			// 顶层 result（ToolMessage 形态）
			const res = a.result;
			if (res) {
				if (typeof res === 'string') {
					n += res.length;
				} else if (Array.isArray(res.content)) {
					for (const rc of res.content) {
						n += typeof rc?.text === 'string' ? rc.text.length : 0;
						n += typeof rc?.data === 'string' ? rc.data.length : 0;
					}
				}
			}
			if (a.params && typeof a.params === 'object') { try { n += JSON.stringify(a.params).length; } catch { /* ignore */ } }
			if (a.rawParams && typeof a.rawParams === 'object') { try { n += JSON.stringify(a.rawParams).length; } catch { /* ignore */ } }
			// checkpoint fileSnapshots（防御性——正常不落本缓存）
			const fs = a.fileSnapshots;
			if (fs && typeof fs === 'object') {
				for (const k in fs) {
					const snap = fs[k];
					n += typeof snap?.content === 'string' ? snap.content.length : 0;
				}
			}
			return n;
		} catch { return 0; }
	}

	/**
	 * 在 sendMessage 入口 / appendMessage 落库后 / 流式结束 三点打点。
	 * 对比 send-start 与 send-done 的 heapUsed 即得每条消息净堆增长；
	 * 对比 active bytes 增长即得历史留存归因。
	 */
	private _logMemSnapshot(tag: string, ctx?: { agentId?: string; sessionId?: string; role?: string; msgBytes?: number }): void {
		try {
			// renderer（Electron/Chromium）下 process.memoryUsage 不可用，回退 performance.memory
			let mem: { heapUsed: number; heapTotal: number; rss: number; external: number } | null = null;
			try {
				if (typeof process === 'object' && process && typeof (process as any).memoryUsage === 'function') {
					const p = (process as any).memoryUsage();
					mem = { heapUsed: p.heapUsed, heapTotal: p.heapTotal, rss: p.rss, external: p.external };
				}
			} catch { /* ignore */ }
			let pmem: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } | null = null;
			if (!mem) {
				try {
					const pm = (performance as any).memory;
					if (pm && typeof pm.usedJSHeapSize === 'number') {
						pmem = { usedJSHeapSize: pm.usedJSHeapSize, totalJSHeapSize: pm.totalJSHeapSize, jsHeapSizeLimit: pm.jsHeapSizeLimit };
					}
				} catch { /* ignore */ }
			}
			const mb = (v: number) => (v / 1048576).toFixed(1);
			const heapUsed = mem ? mb(mem.heapUsed) : (pmem ? mb(pmem.usedJSHeapSize) : '?');
			const heapTotal = mem ? mb(mem.heapTotal) : (pmem ? mb(pmem.totalJSHeapSize) : '?');
			const rss = mem ? mb(mem.rss) : '?';
			const ext = mem ? mb(mem.external) : '?';
			const limitTag = pmem ? ` limit=${mb(pmem.jsHeapSizeLimit)}MB` : '';

			let totalMsgs = 0;
			for (const msgs of this._historyCache.values()) { totalMsgs += msgs.length; }

			let activeMsgs = 0;
			let activeBytes = 0;
			const activeKey = ctx?.agentId
				? (ctx.sessionId ? `${ctx.agentId}::${ctx.sessionId}` : ctx.agentId)
				: '';
			if (activeKey) {
				const msgs = this._historyCache.get(activeKey);
				if (msgs) {
					for (const m of msgs) {
						activeMsgs++;
						activeBytes += AgentChatService._estimateMessageBytes(m);
					}
				}
			}

			const appendInfo = ctx?.role
				? ` | append role=${ctx.role} +${ctx.msgBytes ?? 0}B (${((ctx.msgBytes ?? 0) / 1024).toFixed(1)}KiB)`
				: '';

			this.logService.info(
				`[MemSnap][${tag}] heap=${heapUsed}/${heapTotal}MB rss=${rss}MB ext=${ext}MB${limitTag} | ` +
				`cache buckets=${this._historyCache.size} sessBuckets=${this._countSessionBuckets()} totalMsgs=${totalMsgs} | ` +
				`active[${activeKey}] msgs=${activeMsgs} bytes=${mb(activeBytes)}MB${appendInfo}`,
			);
		} catch { /* 诊断绝不能打断主流程 */ }
	}

	private async _ensureHistoryLoaded(): Promise<void> {
		if (this._historyLoaded) {
			return;
		}
		this._historyLoaded = true;
		try {
			const uri = this._getHistoryFileUri();
			if (!(await this.fileService.exists(uri))) {
				this.logService.info(
					`[AgentChatService] No global history file — session buckets will be loaded lazily from per-session files.`,
				);
				return;
			}
			const content = await this.fileService.readFile(uri);
			const data = JSON.parse(content.value.toString()) as Record<
				string,
				ChatMessage[]
			>;
			// P0: only load noSession buckets (keys without "::") at startup.
			// Session-level buckets are loaded lazily via getHistory →
			// _loadFromSessionFile fallback.  This avoids loading multi-GB of
			// ToolResult payloads into the renderer heap on every window launch.
			let loadedCount = 0;
			let skippedCount = 0;
			for (const [key, messages] of Object.entries(data)) {
				if (!key.includes('::')) {
					this._historyCache.set(key, messages);
					this._touchBucket(key);
					loadedCount++;
				} else {
					skippedCount++;
				}
			}
			this.logService.info(
				`[AgentChatService] Loaded ${loadedCount} noSession buckets, skipped ${skippedCount} session buckets (lazy-load via per-session files)`,
			);

			// 🔒 启动期净化（2026-06-05）：noSession 桶（key 不含 `::`，即 `agentId`
			// 本身）历史上沉积过 user/assistant/tool 消息，会被 getHistory 在每次 session
			// 请求时 merge system 消息时报警 dropped X non-system messages，并增加 IO。
			// 在加载完成后立刻把所有 noSession 桶过滤为仅 system 消息，并回写 global
			// history 文件，让磁盘也保持干净。
			let dirty = false;
			let totalDropped = 0;
			for (const [key, messages] of this._historyCache) {
				if (key.includes('::')) { continue; }
				const systemOnly = messages.filter(m => m.role === 'system');
				if (systemOnly.length !== messages.length) {
					totalDropped += messages.length - systemOnly.length;
					this._historyCache.set(key, systemOnly);
					dirty = true;
				}
			}
			if (dirty) {
				this.logService.warn(
					`[AgentChatService] Startup sanitize: dropped ${totalDropped} non-system messages from noSession buckets`,
				);
				this._persistGlobalHistory().catch((err) =>
					this.logService.error('[AgentChatService] Startup sanitize persist failed:', err),
				);
			}
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to load global history:",
				err,
			);
		}
	}

	private async _persistGlobalHistory(): Promise<void> {
		try {
			const dirUri = this._getGlobalDataUri();
			if (!(await this.fileService.exists(dirUri))) {
				await this.fileService.createFolder(dirUri);
			}
			const data: Record<string, ChatMessage[]> = {};
			for (const [key, messages] of this._historyCache) {
				data[key] = messages;
			}
			await this.fileService.writeFile(
				this._getHistoryFileUri(),
				VSBuffer.fromString(JSON.stringify(data, null, 2)),
			);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to persist global history:",
				err,
			);
		}
	}

	// ─── Per-agent session file persistence ──────────────────────────────────

	private async _persistToSessionFile(
		agentId: string,
		sessionId: string | undefined,
		messages: ChatMessage[],
	): Promise<void> {
		if (!sessionId) {
			return;
		} // No session assigned yet — skip per-file persist
		try {
			const { sessionsDirUri } = await this._resolveAgentPaths(agentId);
			if (!(await this.fileService.exists(sessionsDirUri))) {
				await this.fileService.createFolder(sessionsDirUri);
			}
			const fileUri = this._sessionFileUri(sessionsDirUri, sessionId);
			await this.fileService.writeFile(
				fileUri,
				VSBuffer.fromString(JSON.stringify(messages, null, 2)),
			);
			await this._updateSessionIndex(agentId, sessionId, messages.length);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] _persistToSessionFile failed:",
				err,
			);
		}
	}

	private async _loadFromSessionFile(
		agentId: string,
		sessionId?: string,
	): Promise<ChatMessage[]> {
		if (!sessionId) {
			return [];
		} // No session specified — nothing to load
		try {
			const paths = await this._resolveAgentPaths(agentId);
			const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
			if (!(await this.fileService.exists(fileUri))) {
				return [];
			}
			const content = await this.fileService.readFile(fileUri);
			const messages = JSON.parse(content.value.toString()) as ChatMessage[];
			// P1: resolve externalised tool result refs (from prior LRU eviction)
			const resolved = await this._resolveToolResultRefs(agentId, sessionId, messages);
			if (resolved > 0) {
				// Write back resolved messages so next load is fast (no sidecar I/O)
				await this._persistToSessionFile(agentId, sessionId, messages).catch(() => { });
			}
			return messages;
		} catch {
			return [];
		}
	}

	// ─── Session Index (sessions.json) ───────────────────────────────────────

	private async _readSessionIndex(
		agentId: string,
	): Promise<AgentSessionMeta[]> {
		try {
			const paths = await this._resolveAgentPaths(agentId);
			if (!(await this.fileService.exists(paths.indexUri))) {
				return [];
			}
			const content = await this.fileService.readFile(paths.indexUri);
			const text = content.value.toString();
			// Empty / whitespace-only file → treat as an empty index without alarming
			// the user. This is the state left behind by a killed/corrupted write and
			// is recovered by the next _updateSessionIndex, so it is not an error.
			if (text.trim().length === 0) {
				return [];
			}
			const parsed = JSON.parse(text) as AgentSessionMeta[];
			// 2026-08-20：原先每次读盘都 info 一行，turn 内连刷 50+ 次（日志
			// 1787214724132）。写路径已改为内存权威 + 防抖落盘，此处读盘应变得罕见；
			// 仅在索引异常庞大时告警，正常情况保持静默（trace 级留给排障）。
			if (parsed.length > 200) {
				this.logService.warn(`[AgentChatService] _readSessionIndex(${agentId}): ${parsed.length} sessions — index is large, consider pruning`);
			} else {
				this.logService.trace(`[AgentChatService] _readSessionIndex(${agentId}): ${parsed.length} sessions found`);
			}
			return parsed;
		} catch (err) {
			this.logService.warn(`[AgentChatService] _readSessionIndex(${agentId}) error:`, err);
			return [];
		}
	}

	/**
	 * Write content to the session index file, preferring an atomic
	 * temp-file+rename when the provider supports it so a crash mid-write can
	 * never leave a truncated JSON that breaks subsequent reads.
	 */
	private async _writeSessionIndex(
		agentId: string,
		index: AgentSessionMeta[],
	): Promise<void> {
		try {
			const paths = await this._resolveAgentPaths(agentId);
			const content = VSBuffer.fromString(JSON.stringify(index, null, 2));
			if (this.fileService.hasCapability(paths.indexUri, FileSystemProviderCapabilities.FileAtomicWrite)) {
				await this.fileService.writeFile(paths.indexUri, content, { atomic: { postfix: '.vsctmp' } });
			} else {
				await this.fileService.writeFile(paths.indexUri, content);
			}
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to write session index:",
				err,
			);
		}
		// Invalidate stale cache so getOrCreateActiveSession sees the latest index
		this._sessionIndexCache?.delete(agentId);
		// 刚写盘 → 内存副本与磁盘一致，刷新 loadedAt 让 TTL 从此刻重新计时，
		// 避免「写完立刻被判过期 → 又读一次盘」的无谓 IO。
		const held = this._sessionIndexData.get(agentId);
		if (held) { held.loadedAt = Date.now(); }
	}

	/**
	 * 取得 index 的内存权威副本（不存在/过期则读盘一次）。
	 *
	 * dirty（有未落盘修改）时**绝不**重读磁盘：磁盘上是旧内容，重读会覆盖内存里
	 * 尚未 flush 的 messageCount/updatedAt。
	 */
	private async _getSessionIndexForWrite(agentId: string): Promise<AgentSessionMeta[]> {
		const held = this._sessionIndexData.get(agentId);
		const fresh = held && (Date.now() - held.loadedAt) < AgentChatService.SESSION_INDEX_DATA_TTL_MS;
		if (held && (this._sessionIndexDirty.has(agentId) || fresh)) {
			return held.index;
		}
		const index = await this._readSessionIndex(agentId);
		this._sessionIndexData.set(agentId, { index, loadedAt: Date.now() });
		return index;
	}

	/** 安排一次防抖落盘（同一 agent 在窗口内的多次更新合并为一次写）。 */
	private _scheduleSessionIndexFlush(agentId: string): void {
		this._sessionIndexDirty.add(agentId);
		const existing = this._sessionIndexFlushTimers.get(agentId);
		if (existing) { clearTimeout(existing); }
		const timer = setTimeout(() => {
			this._sessionIndexFlushTimers.delete(agentId);
			void this.flushSessionIndex(agentId);
		}, AgentChatService.SESSION_INDEX_FLUSH_DELAY_MS);
		this._sessionIndexFlushTimers.set(agentId, timer);
	}

	/**
	 * 立即把内存 index 落盘（若 dirty）。turn 结束、窗口关闭、以及任何需要磁盘
	 * 与内存强一致的读取路径（listAgentSessions 等）之前调用。
	 */
	async flushSessionIndex(agentId: string): Promise<void> {
		const timer = this._sessionIndexFlushTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this._sessionIndexFlushTimers.delete(agentId);
		}
		if (!this._sessionIndexDirty.has(agentId)) { return; }
		const held = this._sessionIndexData.get(agentId);
		if (!held) { this._sessionIndexDirty.delete(agentId); return; }
		// 先清 dirty 再写：写期间到来的新更新会重新置 dirty 并再排一次 flush，
		// 不会被本次写「吞掉」。
		this._sessionIndexDirty.delete(agentId);
		await this._writeSessionIndexQueued(agentId, held.index);
	}

	/** 把 index 写盘，复用 per-agentId 串行队列（防止交错写截断 JSON）。 */
	private async _writeSessionIndexQueued(agentId: string, index: AgentSessionMeta[]): Promise<void> {
		const prev = this._sessionIndexWriteQueue.get(agentId) ?? Promise.resolve();
		// 写盘用快照：await 期间内存数组可能被后续 append 继续修改（JSON.stringify
		// 不是原子的），拷一份保证本次写出的是自洽状态。
		const snapshot = index.map(e => ({ ...e }));
		const run = prev.catch(() => { }).then(() => this._writeSessionIndex(agentId, snapshot));
		this._sessionIndexWriteQueue.set(agentId, run);
		try {
			await run;
		} finally {
			if (this._sessionIndexWriteQueue.get(agentId) === run) {
				this._sessionIndexWriteQueue.delete(agentId);
			}
		}
	}

	/**
	 * Ensure a session exists in the index; update messageCount + updatedAt.
	 * If the session doesn't exist yet, auto-create it (supports first-message auto-create).
	 *
	 * 2026-08-20：高频路径（每条消息都会调用）不再每次读写磁盘 —— 只更新内存权威副本
	 * 并安排防抖落盘。新建 session 这类结构性变更立即落盘（不能丢）。
	 */
	private async _updateSessionIndex(
		agentId: string,
		sessionId: string,
		messageCount: number,
	): Promise<void> {
		const index = await this._getSessionIndexForWrite(agentId);
		const now = new Date().toISOString();
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			// 新 session 首次入索引：结构性变更，立即落盘，避免崩溃后会话「消失」。
			index.push({
				id: sessionId,
				name: `新对话`,
				createdAt: now,
				updatedAt: now,
				messageCount,
			});
			this._sessionIndexDirty.add(agentId);
			await this.flushSessionIndex(agentId);
			this._onDidChangeAgentSessionsEmitter.fire({ agentId });
			return;
		}
		// 已存在：仅 messageCount/updatedAt 变化 → 内存改动 + 防抖落盘。
		// 值未变则连事件都不用发（避免 UI 无谓刷新）。
		if (entry.messageCount === messageCount) { return; }
		entry.messageCount = messageCount;
		entry.updatedAt = now;
		this._scheduleSessionIndexFlush(agentId);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
	}

	// ─── Public: appendMessage ───────────────────────────────────────────────

	async appendMessage(agentId: string, message: ChatMessage): Promise<void> {
		await this._ensureHistoryLoaded();
		// 🔒 严格隔离写入侧（2026-06-05）：
		// 之前任何 user/assistant/tool 落到 noSession 桶（agentSessionId=undefined）
		// 都会被 getHistory 整桶 merge 出来污染所有 session。这里在源头拦截：仅
		// system 消息允许 noSession（task orchestration 全局注入用途），其它角色
		// 必须带 agentSessionId，否则丢弃并告警，避免日后再次串台。
		if (!message.agentSessionId && message.role !== 'system') {
			this.logService.warn(
				`[AgentChatService] appendMessage: dropping ${message.role} message without agentSessionId for ${agentId} (cross-session leakage guard) - content="${(message.content || '').substring(0, 60)}"`,
			);
			return;
		}
		const key = this._cacheKey(agentId, message.agentSessionId);
		let messages = this._historyCache.get(key);
		if (!messages) {
			messages = [];
			this._historyCache.set(key, messages);
			this._touchBucket(key);
			// P0-LRU: new bucket created — evict LRU non-open bucket if over cap
			await this._evictIfNeeded();
		} else {
			this._touchBucket(key);
		}
		// 🔒 写入侧去重（2026-06-05）：阻止连续重复的 user 消息落盘。
		// 历史双写 race（webview controller `_handleChatSend` 先 append 一次，随后
		// service `sendMessage` 的 5 秒 dedup 守卫在跨时序/进程下偶发失效又 append
		// 一次）导致 session 文件里同一条 user 消息相邻出现两次。这里在 cache 末尾
		// 做强一致检查：若新来的 user 消息与**末尾一条** user 消息 content 完全相同，
		// 直接丢弃，不依赖时间窗口。assistant/tool 不做此限制（同内容可能合法重复）。
		if (message.role === 'user') {
			const last = messages[messages.length - 1];
			console.info(`[TaskPromptCard] appendMessage role=user id=${message.id} source=${message.source ?? 'user'} isDup=${last?.role === 'user' && (last.content ?? '') === (message.content ?? '')}`);
			if (last && last.role === 'user' && (last.content ?? '') === (message.content ?? '')) {
				// Task execution messages (source='task') are programmatic and must
				// never be deduped — otherwise the task prompt card won't render.
				if (message.source !== 'task') {
					console.info(`[TaskPromptCard] appendMessage DROPPED as duplicate, content="${(message.content ?? '').slice(0, 40)}"`);
					this.logService.warn(
						`[AgentChatService] appendMessage: dropping consecutive duplicate user message for ${key} - content="${(message.content || '').substring(0, 40)}"`,
					);
					return;
				}
				console.info(`[TaskPromptCard] appendMessage ALLOWED (source=task bypass)`);
				this.logService.info(
					`[AgentChatService] appendMessage: allowing duplicate task-prompt message for ${key} (source=task)`,
				);
			}
		}
		// P0: 如果末尾消息 ID 与新消息 ID 相同，REPLACE 而非 push。
		// streaming 期间已经 push 了一个 streaming message（id 相同），
		// 流式结束后 sendMessage 又 append 一次会变成两条 → 工具卡重复显示。
		const tail = messages[messages.length - 1];
		if (tail && tail.id === message.id) {
			messages[messages.length - 1] = message;
		} else {
			messages.push(message);
		}
		this._logMemSnapshot('append', {
			agentId,
			sessionId: message.agentSessionId,
			role: message.role,
			msgBytes: AgentChatService._estimateMessageBytes(message),
		});

		// Dual-write: global fallback + per-agent session file
		this._persistGlobalHistory().catch((err) =>
			this.logService.error("[AgentChatService] Global persist failed:", err),
		);
		this._persistToSessionFile(
			agentId,
			message.agentSessionId,
			messages,
		).catch((err) =>
			this.logService.error(
				"[AgentChatService] Session file persist failed:",
				err,
			),
		);
	}

	// ─── Public: updateMessage ─────────────────────────────────────────────
	/**
	 * Update an existing message in cache + session file.
	 * Used by workflow trace deltas (workflowExecutions/events/collectVariables)
	 * which mutate an existing assistant message in-place.
	 */
	async updateMessage(
		agentId: string,
		sessionId: string | undefined,
		messageId: string,
		updates: Partial<ChatMessage>,
	): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		const messages = this._historyCache.get(key);
		if (!messages) { return; }
		this._touchBucket(key);
		const idx = messages.findIndex(m => m.id === messageId);
		if (idx < 0) { return; }
		// In-place update (mutate the cached object so panel.updateMessage also sees it)
		Object.assign(messages[idx], updates);
		// Persist
		await this._persistToSessionFile(agentId, sessionId, messages);
	}

	// ─── Public: getHistory / clearHistory ──────────────────────────────────

	async getHistory(
		agentId: string,
		sessionId?: string,
	): Promise<ChatMessage[]> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		let messages = this._historyCache.get(key);

		if (!messages || messages.length === 0) {
			messages = await this._loadFromSessionFile(agentId, sessionId);
			if (messages.length > 0) {
				this._historyCache.set(key, messages);
				this._touchBucket(key);
				// P0-LRU: evict after lazy-loading a new bucket into cache
				await this._evictIfNeeded();
			}
		} else {
			this._touchBucket(key);
		}

		// When a sessionId is specified, also include messages stored with
		// agentSessionId=undefined (e.g. task orchestration system messages).
		// These messages belong to the agent globally, not to any specific session,
		// so they should appear regardless of which session is active.
		//
		// 🔒 严格隔离修复（2026-06-05）：
		// 历史上 noSession 桶（key === agentId，无 sessionId）在多条路径下被错误
		// 写入过 user / assistant / tool 消息（旧 webview controller 首消息分配 session
		// 之前的临时持久化、错误回收路径、跨 worktree 共用 agentId 的旧数据等）。
		// 之前不加过滤地整桶 merge 进来，会让一个全新 sessionId 的会话立即看到
		// **几百条** 跨主题、跨 worktree 的历史（含重复 user 消息）。
		//
		// 真正需要透传的只有 task orchestration 注入的 **system 消息**。其它角色一律
		// 丢弃，避免污染当前 session 的上下文。
		if (sessionId) {
			const noSessionKey = this._cacheKey(agentId, undefined);
			let noSessionMessages = this._historyCache.get(noSessionKey);
			if (!noSessionMessages || noSessionMessages.length === 0) {
				noSessionMessages = await this._loadFromSessionFile(agentId, undefined);
			}
			if (noSessionMessages && noSessionMessages.length > 0) {
				// 仅保留 system 消息（这是注释里声明的合法用途）；
				// 同时排除 orchestration_plan 类消息（2026-07-22 修复）：plan 通知
				// 已改为会话隔离存储（见 taskOrchestrationService.createPlan* 的
				// agentSessionId 参数），应只出现在创建它的那个 session，而非全局泄漏
				// 进该 agent 的每一个会话。遗留的旧全局 plan 消息亦不再 merge，避免重复显示。
				const systemOnly = noSessionMessages.filter(
					m => m.role === 'system' && (m.metadata as any)?.type !== 'orchestration_plan',
				);
				const droppedCrossSession = noSessionMessages.length - systemOnly.length;
				if (droppedCrossSession > 0) {
					this.logService.warn(
						`[AgentChatService] getHistory: dropped ${droppedCrossSession} non-system/plan messages from noSession bucket for ${key} (cross-session leakage guard)`,
					);
				}
				if (systemOnly.length > 0) {
					// Merge and deduplicate by message id, sorted by timestamp
					const existingIds = new Set((messages || []).map(m => m.id));
					const merged = [
						...(messages || []),
						...systemOnly.filter(m => !existingIds.has(m.id)),
					].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
					messages = merged;
				}
			}
		}

		this.logService.info(
			`[AgentChatService] getHistory: ${(messages || []).length} msgs for ${key}`,
		);
		return messages || [];
	}

	async clearHistory(agentId: string, sessionId?: string): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		this._historyCache.delete(key);
		this._historyCacheAccess.delete(key);
		await this._persistGlobalHistory();
		if (sessionId) {
			try {
				const paths = await this._resolveAgentPaths(agentId);
				const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
				if (await this.fileService.exists(fileUri)) {
					await this.fileService.writeFile(
						fileUri,
						VSBuffer.fromString("[]"),
					);
				}
			} catch {
				/* ignore */
			}
		}
	}

	/**
	 * Replace the entire chat history for an agent session in both the
	 * in-memory cache and the persistent session file. Used by workflow
	 * execution to write back compressed messages so subsequent
	 * `getHistory` calls don't reload the full uncompressed history.
	 */
	async replaceHistory(agentId: string, sessionId: string | undefined, messages: ChatMessage[]): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		this._historyCache.set(key, [...messages]);
		this._touchBucket(key);
		await this._persistGlobalHistory();
		if (sessionId) {
			try {
				const paths = await this._resolveAgentPaths(agentId);
				const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
				const json = JSON.stringify(messages, null, 2);
				await this.fileService.writeFile(fileUri, VSBuffer.fromString(json));
				this.logService.info(
					`[AgentChatService] replaceHistory: wrote ${messages.length} msgs to ${key}`,
				);
			} catch (err) {
				this.logService.error(
					`[AgentChatService] replaceHistory: failed to persist for ${key}: ${err instanceof Error ? err.message : err}`,
				);
				throw err;
			}
		}
	}

	// ─── 历史转换：host ChatMessage[] → driver IChatMessage[] ──────────────────
	//
	// 背景：后端 turn 此前每轮只收到当前 user 消息（messages=1），长对话上下文
	// 永远涨不起来，已验证正确的压缩链路（P0/P1/P2）永远不被触发。B 方案让后端
	// 收到完整历史，这里负责把持久化的 host 历史转换为 driver 消息格式。
	//
	// 关键约束（决定 OpenAI 格式是否合法）：
	//   1. host 的 assistant 消息把工具结果**内嵌**在 toolCalls[].result 里，
	//      没有独立的 role:'tool' 消息；而 OpenAI 要求 assistant.tool_calls 的每个
	//      调用都必须有一条配对的 role:'tool' + 同 id 的 tool_call_id 响应，否则
	//      API 报错。因此对每个**有 result** 的 toolCall，要：
	//        a) 在 assistant.toolCalls 里保留它（携带 id/name/arguments）
	//        b) 紧随该 assistant 追加一条 role:'tool'、toolCallId===id 的消息
	//   2. **没有 result** 的 toolCall（status=running/error 且无结果）必须从
	//      assistant.toolCalls 中剔除——否则会留下"有 tool_call 但无配对 tool 响应"
	//      的非法序列。剔除后若该 assistant 还有文本 content 仍保留为纯文本消息。
	//   3. 历史里的 system 消息按原样转换（system prompt 由后端单独注入，这里
	//      只透传历史中可能存在的 system 类消息）。
	//   4. tool 角色的独立历史消息（理论上 host 端不产生，但防御性处理）按其
	//      自身 content 透传，toolCallId 缺失时用空串（与 MessageFormatConverter
	//      的容错一致）。
	/**
	 * 防御性过滤：检测 assistant content 是否疑似被 fake-completion / unfinished-intent
	 * 污染（旧 session 残留的"您完全正确！我犯了严重错误..."幻觉道歉模式）。
	 *
	 * 即使新机制（discard_prior_text）已阻止新污染，旧 session 已写入的 _historyCache
	 * 仍含污染条目。这里在组装 priorMessages 时主动跳过/重写这些条目，让旧 session
	 * 也能立即恢复，无需手动 reset。
	 *
	 * 命中规则（任一即视为污染）：
	 *  - "您完全正确" / "我犯了严重错误" / "让我重新" 开头（fake-completion 模型自我反省语）
	 *  - 没有 toolCalls 也没有正常文本输出，只是道歉性过渡语
	 */
	private _isContaminated(content: string): boolean {
		if (!content) {
			return false;
		}
		const head = content.slice(0, 80);
		const patterns = [
			/^您完全正确/,
			/^我犯了严重错误/,
			/^让我重新(?:开始|尝试|执行)/,
			/^抱歉.{0,10}重新/,
			/^对不起.{0,10}重新/,
			/^检测到模型未真正调用工具/, // 我们自己的 nudge 提示，也不应回灌历史
		];
		return patterns.some(re => re.test(head));
	}

	private _toDriverMessages(history: readonly ChatMessage[]): IChatMessage[] {
		// ─── P5: 压缩边界回放（压缩状态跨 turn 持久化）────────────────────────
		// 历史中最后一条 metadata.type='compaction' 的消息是压缩边界：其 content
		// 已承载旧历史摘要，边界之前的消息不再回灌（对齐 opencode/MiMo 的
		// compaction boundary 持久化），长会话不再每 turn 重新膨胀、重新压缩。
		history = sliceAtCompactionBoundary(history);
		// 🧹 一致性兜底（2026-06-05）：折叠**连续重复的 user 消息**。
		// 历史 session 文件（如 sess_mpwt6z2s_szhpq3.json）因早期持久化双写 race
		// （webview controller `_handleChatSend` 与 service `sendMessage` 各 append
		// 一次，5 秒 dedup 守卫在不同进程/时序下失效），磁盘上已沉淀大量"同一条
		// user 消息相邻出现 2 次"的脏数据。B 方案每轮把整段历史回灌给模型，会原样
		// 把重复 user 发出去（log 里 hello×4 / test×2 / createtestN×2）。这里在
		// 组装 driver messages 的唯一漏斗处做最终去重：相邻且 content 完全相同的
		// user 消息只保留第一条，杜绝重复输入污染模型上下文。注意只折叠**相邻**
		// 重复，正常的"用户连续发两条不同消息"不受影响。
		let collapsedUserDup = 0;
		const deduped: ChatMessage[] = [];
		for (const m of history) {
			const prev = deduped[deduped.length - 1];
			if (
				m.role === 'user' &&
				prev &&
				prev.role === 'user' &&
				(prev.content ?? '') === (m.content ?? '')
			) {
				collapsedUserDup++;
				continue;
			}
			deduped.push(m);
		}
		if (collapsedUserDup > 0) {
			this.logService.warn(
				`[AgentChatService] 🧹 _toDriverMessages: collapsed ${collapsedUserDup} consecutive duplicate user message(s) (persist-race / legacy session-file pollution guard)`,
			);
		}

		const out: IChatMessage[] = [];
		let droppedContaminated = 0;
		// ─── P5: 冻结截断文本（frozen truncation，对齐 openclaw projection）────
		// 工具结果统一做确定性截断（同一内容永远得到逐字节相同的结果），
		// 不再按 head/middle/tail 区域区分 —— 消除了"消息从 tail 保护区移入
		// middle 截断区时字节变化"导致的跨 turn 缓存前缀漂移。
		// 同时仍满足原 P4 目标：renderer→ext-host 的 IPC 序列化不压垮 4GB heap。
		let ipcTruncatedResults = 0;
		let ipcTruncatedBytes = 0;
		const truncateResult = (s: string): string => {
			if (s.length <= AgentChatService.IPC_TRUNCATE_RESULT_CHARS) { return s; }
			ipcTruncatedResults++;
			ipcTruncatedBytes += s.length - AgentChatService.IPC_TRUNCATE_RESULT_CHARS;
			return truncateToolResultContent(s, AgentChatService.IPC_TRUNCATE_RESULT_CHARS);
		};

		for (let mi = 0; mi < deduped.length; mi++) {
			const m = deduped[mi];
			if (m.role === 'user') {
				out.push({ role: 'user', content: m.content ?? '' });
			} else if (m.role === 'assistant') {
				// 仅保留已完成（有 result）的工具调用，保证 tool_call ↔ tool 配对完整
				const completed = (m.toolCalls ?? []).filter(
					tc => typeof tc.result === 'string',
				);
				// 🧹 防御过滤：assistant 内容疑似污染且**没有任何工具调用**时整条丢弃
				// （有工具调用的 assistant 必须保留以维持 tool_call ↔ tool 配对完整性，
				// 但可以把 content 重写为空串，让模型只看到工具调用历史，不再看到道歉语料）
				const contentRaw = m.content ?? '';
				const contaminated = this._isContaminated(contentRaw);
				if (contaminated && completed.length === 0) {
					droppedContaminated++;
					continue;
				}
				const sanitizedContent = contaminated ? '' : contentRaw;
				if (contaminated) {
					droppedContaminated++;
				}
				const assistantMsg: IChatMessage = {
					role: 'assistant',
					content: sanitizedContent,
					...(completed.length > 0
						? {
							toolCalls: completed.map(tc => ({
								id: tc.id,
								name: tc.name,
								arguments: tc.arguments ?? '{}',
							})),
						}
						: {}),
				};
				out.push(assistantMsg);
			// 为每个已完成工具调用补一条配对的 tool 响应消息
			for (const tc of completed) {
				const raw = tc.result ?? '';
				out.push({
					role: 'tool',
					content: truncateResult(raw),
					toolCallId: tc.id,
				});
			}
		} else if (m.role === 'system') {
			out.push({ role: 'system', content: m.content ?? '' });
		} else if (m.role === 'tool') {
			// 防御性：host 端通常不产生独立 tool 消息
			const raw = m.content ?? '';
			out.push({
				role: 'tool',
				content: truncateResult(raw),
				toolCallId: '',
			});
		}
	}
	if (ipcTruncatedResults > 0) {
		this.logService.info(
			`[AgentChatService][P5-frozen] Truncated ${ipcTruncatedResults} tool result(s) `
			+ `(-${(ipcTruncatedBytes / 1024).toFixed(1)}KB, cap=${AgentChatService.IPC_TRUNCATE_RESULT_CHARS}, deterministic/frozen)`,
		);
	}
		if (droppedContaminated > 0) {
			this.logService.info(
				`[AgentChatService] 🧹 _toDriverMessages: filtered ${droppedContaminated} contaminated assistant messages (fake-completion / unfinished-intent residue)`,
			);
		}
		return out;
	}

	async deleteMessagesAfter(
		agentId: string,
		sessionId: string | undefined,
		messageId: string,
	): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		let messages = this._historyCache.get(key);

		if (!messages || messages.length === 0) {
			messages = await this._loadFromSessionFile(agentId, sessionId);
			if (messages.length > 0) {
				this._historyCache.set(key, messages);
				this._touchBucket(key);
			}
		} else {
			this._touchBucket(key);
		}
		if (!messages || messages.length === 0) {
			this.logService.info(`[AgentChatService] deleteMessagesAfter: no messages found for ${key}`);
			return;
		}

		const targetIdx = messages.findIndex(m => m.id === messageId);
		if (targetIdx < 0) {
			this.logService.warn(`[AgentChatService] deleteMessagesAfter: message ${messageId} not found in ${key}`);
			return;
		}

		// Keep messages up to and including targetIdx
		const updatedMessages = messages.slice(0, targetIdx + 1);
		this._historyCache.set(key, updatedMessages);

		this.logService.info(
			`[AgentChatService] deleteMessagesAfter: kept ${updatedMessages.length} messages (removed ${messages.length - updatedMessages.length}) for ${key}`,
		);

		// Persist: global + session file
		this._persistGlobalHistory().catch((err) =>
			this.logService.error("[AgentChatService] Global persist failed:", err),
		);
		this._persistToSessionFile(
			agentId,
			sessionId,
			updatedMessages,
		).catch((err) =>
			this.logService.error("[AgentChatService] Session file persist failed:", err),
		);
	}

	// ─── Public: sendMessage ─────────────────────────────────────────────────

	async sendMessage(
		agentId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage> {
		const t0 = performance.now();
		console.info(`[PerfDiag] 🔵 sendMessage ENTER agentId=${agentId} msgLen=${message.length} source=${options.source ?? 'user'} prefix="${message.slice(0, 50).replace(/\n/g, '\\n')}" t=${t0.toFixed(0)}ms`);
		this.logService.info(
			`[CoderTrace] AgentChatService.sendMessage: agentId=${agentId}, messageLen=${message.length}, model=${options.model}, chatMode=${options.chatMode}, explicitSkillIds=${JSON.stringify(options.explicitSkillIds)}`,
		);
		// OOM 诊断：发送前基线快照（heap + 活跃桶留存）
		this._logMemSnapshot('send-start', { agentId, sessionId: options.agentSessionId });

		const streamKey = options.agentSessionId
			? `${agentId}::${options.agentSessionId}`
			: agentId;
		// ⚠️ 2026-08-27 修复参数形态 bug：`cancelStream(agentId, agentSessionId?)`
		// 期望【两个独立参数】并在内部自行拼 `${agentId}::${agentSessionId}`。
		// 旧代码把已拼好的复合 streamKey 当作 agentId 传入 → 内部又拼成
		// `saros-claw::sess_xxx::undefined`，与实际登记的 key 不匹配，
		// 导致这句取消**从未真正生效**（查不到 controller，静默 no-op）。
		// 后果：同一 session 上的重入发送无法掐掉上一个流，两个流并发跑，
		// 后注册的 onDelta 覆盖先注册的（_activeOnDeltas.set），先发者的
		// delta 回调被摘除 → 先发 pane 的 UI 再也不刷新（用户报告现象）。
		// 现改为传正确参数，使同 session 重入时旧流被真正取消、状态干净。
		this.cancelStream(agentId, options.agentSessionId);

		const controller = new AbortController();
		this._activeStreams.set(streamKey, controller);

		// ─── Memory provider 事件桥接 ──────────────────────────────────────
		// 订阅 provider 的 onMemoryWritten/onMemoryWriteFailed 事件，
		// 将真实的写入结果转发给 onDelta，使 UI 卡片从 pending → saved/failed。
		// 替代旧的 fire-and-forget + 假"已保存"信号模式。
		// 并发修复：每个 streamKey 独立注册回调，而非覆盖单例。
		// 串台防护：事件 data 携带 sessionId（由写入方写入 entry.metadata.sessionId），
		// _getOnDeltaForAgent 优先按 agentId::sessionId 精确命中对应 session 的 onDelta，
		// 仅在 sessionId 缺失时退化为"同 agent 最近一次活跃流"，避免多开聊天框串台。
		this._activeOnDeltas.set(streamKey, onDelta);
		this._streamCreatedAt.set(streamKey, Date.now());
		this._ensureMemoryEventBridge();

		let fullContent = "";
		let fullThinking = "";
		// P0-leak-fix: streamed text is accumulated in chunk arrays and joined ONCE
		// at finalization. The previous `fullContent += delta.content` built a V8
		// ConsString rope (one node per delta) that was retained in _historyCache,
		// causing unbounded heap growth after every send.
		const _fullContentChunks: string[] = [];
		const _fullThinkingChunks: string[] = [];
		const _toolArgChunks = new Map<string, string[]>();
		let toolCalls: ChatMessage["toolCalls"];
		// P0: chronological parts 跟踪——按 LLM 实际输出顺序记录 text→tool→text→tool，
		// 最终落盘时直接使用，避免 deriveMessageParts 依赖跨迭代失效的 textPosition。
		const _streamingParts: any[] = [];
		// 阶段E：textPosition 仅作**落盘时切分 parts 的本地排序信号**，不再跨层依赖。
		// driver/agentOS 不下发 textPosition，由本侧在 tool_start 时按"当前 turn 内已累积
		// 文本长度"计算（assistant_turn 结算后归零）。最终 deriveMessageParts 用它把
		// turn.content 与 toolCalls 一次性切分成有序 parts 落盘，重载即按数组顺序渲染，
		// 不再有任何一层依赖 textPosition 的字符偏移（消除历史错位根因）。
		let currentTurnTextLen = 0;
		// ─── Hermes-style 回合边界收集（2026-06-05 治本根因修复）──────────────
		// agentOS 每个 iteration yield 一个 `assistant_turn` 边界事件。我们据此把
		// 这一回合（同一次用户请求）拆成多条 assistant 消息，每条只含**本 iteration**
		// 的 content + 本 iteration 发起的 toolCalls，紧跟其 tool 结果落在下一条之前。
		// 这样持久化的历史与 agentOS loop 内部结构一致，杜绝"先宣告成功、后调用工具"
		// 的因果倒置范例。turns 为空（无边界事件，旧后端/直连模式）时回退单条逻辑。
		interface ITurnSnapshot {
			content: string;
			toolCallIds: string[];
		}
		const turns: ITurnSnapshot[] = [];
		// ─── P5: 压缩边界捕获（压缩状态跨 turn 持久化）───────────────────────
		// executor 在 loop 内压缩后 yield context_compacted（含 compressionSummary）。
		// 记录边界信息（同一回合多次压缩取最后一次），完成落盘时把边界消息插入
		// 到压缩点位置；下一 turn 回灌从边界处重放（边界前历史由摘要承载）。
		let pendingCompaction: ICompactionBoundaryInfo | undefined;
		// Accumulators for new card data (VS Code Copilot Chat pattern)
		let references: ChatMessage["references"];
		let progress: ChatMessage["progress"];
		let confirmation: ChatMessage["confirmation"];
		let todos: ChatMessage["todos"];
		let tips: ChatMessage["tips"];
		let questions: ChatMessage["questions"];
		// KV Cache: accumulated token usage across the turn.
		let usageInput = 0;
		let usageOutput = 0;
		let usageCached = 0;
		let usageCacheWrite = 0;
		let usageCredit = 0;
		let usageCreditSeen = false; // 2026-07-27：区分"网关返回 credit=0"与"网关根本未提供该字段"
		let usageTotalReported = 0; // total_tokens as reported by the gateway (preferred over input+output)
		let usageSeen = false;

		try {
			// Persist user message (fire-and-forget, don't block AI response)
			// Defensive: check if an identical user message was already persisted
			// in the last 5 seconds (e.g. by the webview controller or another caller).
			const key = this._cacheKey(agentId, options.agentSessionId);
			const existingMessages = this._historyCache.get(key) || [];
			if (existingMessages.length > 0) { this._touchBucket(key); }
			const now = Date.now();
			const alreadyPersisted = existingMessages.some(m =>
				m.role === 'user' &&
				m.content === message &&
				m.agentSessionId === options.agentSessionId &&
				(now - new Date(m.timestamp).getTime()) < 5000
			);

			if (!alreadyPersisted || options.source === 'task') {
				const userMessage: ChatMessage = {
					id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					role: 'user',
					content: message,
					agentId,
					agentSessionId: options.agentSessionId,
					timestamp: new Date().toISOString(),
					source: options.source,
					taskCard: options.taskCard,
				};
				console.info(`[TaskPromptCard] sendMessage → appendMessage id=${userMessage.id} source=${options.source ?? 'user'} alreadyPersisted=${alreadyPersisted}`);
				this.appendMessage(agentId, userMessage).catch(err =>
					this.logService.error('[AgentChatService] Failed to persist user message:', err)
				);
			} else {
				console.info(`[TaskPromptCard] sendMessage BLOCKED by alreadyPersisted (source=${options.source ?? 'user'}), msg="${message.slice(0, 50)}"`);
				this.logService.info(`[AgentChatService] Skipping duplicate user message persist: "${message.substring(0, 40)}..."`);
			}

			// ─── B 方案：组装完整会话历史传给后端 ─────────────────────────────
			// 后端 turn 此前每轮只收到当前 user 消息（executeAgentTurn: messages=1），
			// 长对话上下文涨不起来，已验证正确的压缩链路（P0/P1/P2）永不触发。这里
			// 取出该 session 全量历史，转换为 driver 消息格式，经 priorMessages 参数
			// 下发。driver 会在其后追加当前 user 消息，因此先从历史尾部剔除"当前这条
			// user 消息"避免重复——user 消息在上方 fire-and-forget 持久化，时序上可能
			// 已写入 _historyCache（末尾即当前消息），也可能尚未写入（末尾是上一轮
			// assistant）。只检查末尾一条最安全：是当前 user 就剔除，否则不动。
			let priorMessages: IChatMessage[] | undefined;
			try {
				const history = await this.getHistory(agentId, options.agentSessionId);
				const trimmed = [...history];
				const last = trimmed[trimmed.length - 1];
				if (last && last.role === 'user' && last.content === message) {
					trimmed.pop();
				}
				priorMessages = this._toDriverMessages(trimmed);
				this.logService.info(
					`[AgentChatService] Assembled ${priorMessages.length} prior driver messages from ${history.length} history msgs (key=${this._cacheKey(agentId, options.agentSessionId)})`,
				);
			} catch (err) {
				this.logService.warn(
					`[AgentChatService] Failed to assemble prior messages (continuing with current message only): ${err}`,
				);
				priorMessages = undefined;
			}

			this.logService.info(`[AgentChatService] Creating stream (agentId=${agentId}, priorMsgs=${priorMessages?.length ?? 0})`);
			const tStream = performance.now();
			console.info(`[PerfDiag] 🔵 sendMessage → executeFromChatOptions elapsed=${(tStream - t0).toFixed(0)}ms`);

			// Fork 前缀缓存：把本会话携带的父级 ForkContext 透传到 driver/agentOS 请求构造端，
			// 使其 (system+tools) 与父级冻结前缀对齐 → 命中 provider prompt cache（零行为变更：
			// 非 fork 会话 session.forkContext 为 undefined，options.forkContext 仍为 undefined）。
			let sessionForkContext: IForkContext | undefined;
			if (options.agentSessionId) {
				try {
					// forkContext 只在 create/fork 时写入（立即落盘），不受防抖影响 →
					// 可直接用内存权威副本，省掉一次读盘。
					const idx = await this._getSessionIndexForWrite(agentId);
					sessionForkContext = idx.find((s) => s.id === options.agentSessionId)?.forkContext;
				} catch {
					// 读取会话索引失败不阻塞主流程
				}
			}
			this.logService.info(`[AgentChatService] Fork prefix-cache: session=${options.agentSessionId ?? '(none)'} hasParentFork=${!!sessionForkContext}`);

			const stream = this.driverService.executeFromChatOptions(
				agentId,
				message,
				{ ...options, forkContext: sessionForkContext },
				priorMessages,
			);
			this.logService.info(`[AgentChatService] Stream created in ${(performance.now() - tStream).toFixed(0)}ms, starting iteration`);
			let _deltaCount = 0;
			let _firstDeltaTs = 0;
			for await (const delta of stream) {
				if (_deltaCount === 0) {
					_firstDeltaTs = performance.now();
					console.info(`[PerfDiag] 🔵 sendMessage FIRST_DELTA elapsed=${(_firstDeltaTs - tStream).toFixed(0)}ms type=${delta.type}`);
				}
				_deltaCount++;
				if (controller.signal.aborted) {
					break;
				}
				if (delta.type === "text" && delta.content) {
					_fullContentChunks.push(delta.content);
					// P0: chronological parts 跟踪——更新最后一个 text part 或创建新的
					const lastPart = _streamingParts[_streamingParts.length - 1];
					if (lastPart && lastPart.kind === 'text') {
						lastPart.text = (lastPart.text || '') + delta.content;
					} else {
						_streamingParts.push({ kind: 'text', text: delta.content });
					}
				}
				if (delta.type === "thinking" && delta.content) {
					_fullThinkingChunks.push(delta.content);
				}
				// content_replace: upstream extracted tool calls from text and wants
				// to replace the accumulated fullContent with the cleaned version.
				if (delta.type === "content_replace") {
					_fullContentChunks.length = 0;
					if (delta.content) { _fullContentChunks.push(delta.content); }
					// P0: chronological parts — content_replace 重置文本，更新最后一个 text part
					const lastPart = _streamingParts[_streamingParts.length - 1];
					if (lastPart && lastPart.kind === 'text') {
						lastPart.text = delta.content || '';
					} else {
						_streamingParts.push({ kind: 'text', text: delta.content || '' });
					}
					currentTurnTextLen = (delta.content ?? "").length;
				}
				// ── Hermes-style synthetic-recovery 续跑信号 ──────────────────────
				// 参考 Hermes `agent/conversation_loop.py:4300-4310` 的 while-pop 模式：
				// upstream 检测到 fake-completion / unfinished-intent，准备注入 nudge
				// 续跑时，要求**永远不要把已累计的幻觉文本持久化到 history**——否则下一轮
				// `_toDriverMessages(history)` 会把它当作 prior driver messages 喂回模型，
				// 形成 "您完全正确！我犯了严重错误..." 的对话循环（test50 复现的根因）。
				//
				// 收到该信号后立即清空 fullContent / fullThinking，让最终持久化的
				// chatMessage.content 仅包含**信号之后真正成功的那段输出**。
				if ((delta as any).type === 'discard_prior_text') {
					const reason = (delta as any).metadata?.reason ?? 'unknown';
					const _discardedLen = _fullContentChunks.reduce((a, s) => a + s.length, 0)
						+ _fullThinkingChunks.reduce((a, s) => a + s.length, 0);
					this.logService.info(
						`[AgentChatService] 🧹 Received discard_prior_text (reason=${reason}) — clearing fullContent (was len=${_discardedLen}) + fullThinking to prevent conversation rot`,
					);
					_fullContentChunks.length = 0;
					_fullThinkingChunks.length = 0;
					currentTurnTextLen = 0;
					// 通知 webview 同步重置（content_replace 已发，仅作冗余兜底）
					onDelta(delta as any);
					continue;
				}
				// ─── Hermes-style 回合边界事件 ──────────────────────────────
				// agentOS 在每个 iteration 确定 assistant 消息后发来 `assistant_turn`，
				// content 为本轮权威文本（已 sanitize+trim），metadata.toolCallIds 为本轮
				// 工具调用 id。收到后把这一轮快照成一个 turn。
				//
				// 同时作为 `content_replace` 转发给 webview，确保 webview 的 textBuffer
				// 与宿主的 sanitized 内容同步。若不转发，多轮 agent loop 时 webview 的 buffer
				// 会累积所有轮次的原始文本，导致最终 chat.stream.complete 时 buffer 与 host
				// message 内容完全不同（CONTENT MISMATCH），引发渲染异常和 UI 卡死。
				//
				// 注意：此时 toolCalls 里这些 id 的 result 可能尚未回填
				// （tool_result 在 assistant_turn 之后才 yield），因此只记录 id，
				// 最终持久化时再按 id 从全局 toolCalls 取回填好 result 的副本。
			// ─── P5: 压缩边界事件捕获 ─────────────────────────────────────
			// executor 压缩成功后 yield context_compacted（含 compressionSummary）。
			// 不在此转发/消费（原有 onDelta 转发链不变），只记录边界供完成落盘时插入。
			if ((delta as any).type === 'context_compacted') {
				const summary = (delta as any).compressionSummary;
				if (typeof summary === 'string' && summary.length > 0) {
					pendingCompaction = {
						summary,
						turnCount: turns.length,
						originalCount: (delta as any).compressionOriginalCount ?? 0,
						compressedCount: (delta as any).compressionCompressedCount ?? 0,
						tokensSaved: (delta as any).compressionTokensSaved ?? 0,
					};
					this.logService.info(
						`[AgentChatService][P5] Captured compaction boundary: turnCount=${turns.length}, original=${pendingCompaction.originalCount}→compressed=${pendingCompaction.compressedCount}, saved=${pendingCompaction.tokensSaved} tokens`,
					);
				}
			}
			if ((delta as any).type === 'assistant_turn') {
				const md = (delta as any).metadata ?? {};
				const ids = Array.isArray(md.toolCallIds) ? md.toolCallIds as string[] : [];
				const turnContent: string = (delta as any).content ?? "";
				turns.push({
					content: turnContent,
					toolCallIds: ids,
				});
					// 本轮结算：下一轮工具卡片的 textPosition 从 0 重新计起，
					// 与 _aggregateTurns 合并各 turn 时按 turn.content 长度累加 offset 对齐。
					currentTurnTextLen = 0;
					// 同步 webview 的 text buffer 为本轮 sanitized 文本
					if (turnContent) {
						onDelta({
							type: 'content_replace' as any,
							content: turnContent,
						});
					}
					continue;
				}
				if (delta.type === "tool_start" && delta.toolCallId && delta.toolName) {
					if (!toolCalls) {
						toolCalls = [];
					}
					toolCalls.push({
						id: delta.toolCallId,
						name: delta.toolName,
						arguments: "",
						result: undefined,
						displayName: delta.displayName,
						renderType: delta.renderType,
						defaultShow: delta.defaultShow,
						serverExecuted: (delta as any).serverExecuted,
						// 记录卡片插入位置：优先用上游下发的 textPosition，否则用当前 turn 内
						// 已累积的文本长度。持久化后重载即可按位置交织渲染，而非全部排到末尾。
						textPosition: typeof (delta as any).textPosition === 'number'
							? (delta as any).textPosition
							: currentTurnTextLen,
					});
					_toolArgChunks.set(delta.toolCallId, []);
					// P0: chronological parts 跟踪
					_streamingParts.push({ kind: 'tool', tool: toolCalls[toolCalls.length - 1] });
				}
				if (
					delta.type === "tool_args" &&
					delta.toolCallId &&
					delta.content &&
					toolCalls
				) {
					const tc = toolCalls.find((t) => t.id === delta.toolCallId);
					if (tc) {
						let chunks = _toolArgChunks.get(tc.id);
						if (!chunks) { chunks = []; _toolArgChunks.set(tc.id, chunks); }
						chunks.push(delta.content);
					}
				}
				if (delta.type === "tool_result" && delta.toolCallId && toolCalls) {
					const tc = toolCalls.find((t) => t.id === delta.toolCallId);
					if (tc) {
						tc.result = delta.content;
						// Mark finished so the persisted card restores in a
						// completed (not loading) state after a window refresh.
						// Without this, the webview's mapPhase sees no status and
						// defaults to 'pending' → renders the loading title forever.
						tc.status = 'done';
					}
				}
				// P2-4 阶段卡：work_mode_changed 携带 planPhase 时合并到最近一个
				// plan_enter（优先）/plan_explore 工具卡对象（共享引用，随 parts 落盘
				// 于 line ~2192）——窗口刷新后 adaptPersistedToolCall 透传 planPhase，
				// 阶段卡不丢失。合并语义：字段级（currentStep/planFilePath/completedAt
				// 各自缺省保留旧值），支持 plan_exit 只带 completedAt 定格完成态。
				if (delta.type === 'work_mode_changed' && (delta as any).planPhase && toolCalls) {
					const phase = (delta as any).planPhase as { currentStep?: number; planFilePath?: string; completedAt?: number };
					let planHostTc: any;
					for (let i = toolCalls.length - 1; i >= 0; i--) {
						const n = toolCalls[i]?.name;
						if (n === 'plan_enter') { planHostTc = toolCalls[i]; break; }
						if (n === 'plan_explore' && !planHostTc) { planHostTc = toolCalls[i]; }
					}
					if (planHostTc) {
						planHostTc.planPhase = {
							...(planHostTc.planPhase ?? {}),
							...(phase.currentStep !== undefined ? { currentStep: phase.currentStep } : {}),
							...(phase.planFilePath !== undefined ? { planFilePath: phase.planFilePath } : {}),
							...(phase.completedAt !== undefined ? { completedAt: phase.completedAt } : {}),
						};
					}
				}
				// Handle new card data delta types (VS Code Copilot Chat pattern)
				if (delta.type === 'references' && delta.references) {
					references = delta.references as unknown as ChatMessage['references'];
				}
				if (delta.type === 'progress' && delta.progressData) {
					progress = delta.progressData as unknown as ChatMessage['progress'];
				}
				if (delta.type === 'confirmation' && delta.confirmationData) {
					confirmation = delta.confirmationData as unknown as ChatMessage['confirmation'];
				}
				if (delta.type === 'confirmation_resolved' && confirmation && (delta as any).confirmationId === confirmation.id) {
					// Persist approval resolution: approved/rejected/reverted status survives reload
					confirmation = {
						...confirmation,
						status: ((delta as any).confirmationStatus as any) || 'rejected',
					};
				}
				if (delta.type === 'todos' && delta.todosData) {
					todos = delta.todosData as unknown as ChatMessage['todos'];
				}
				if (delta.type === 'tips' && delta.tipsData) {
					tips = delta.tipsData as unknown as ChatMessage['tips'];
				}
				if (delta.type === 'questions' && delta.questionsData) {
					questions = delta.questionsData as unknown as ChatMessage['questions'];
				}
				// KV Cache: aggregate per-chunk usage so the persisted ChatMessage
				// carries the final token totals (BYOK providers may emit usage on
				// either the streaming chunk path or the fallback non-streaming path,
				// so we sum defensively rather than overwrite).
				if (delta.type === 'usage' && delta.usage) {
					usageSeen = true;
					if (typeof delta.usage.inputTokens === 'number') { usageInput += delta.usage.inputTokens; }
					if (typeof delta.usage.outputTokens === 'number') { usageOutput += delta.usage.outputTokens; }
					if (typeof delta.usage.cachedTokens === 'number') { usageCached += delta.usage.cachedTokens; }
					if (typeof delta.usage.cacheWriteTokens === 'number') { usageCacheWrite += delta.usage.cacheWriteTokens; }
					if (typeof delta.usage.totalTokens === 'number') { usageTotalReported += delta.usage.totalTokens; }
					if (typeof delta.usage.credit === 'number') { usageCredit += delta.usage.credit; usageCreditSeen = true; }
				}
				onDelta(delta as any);
				// Broadcast delta for external panels (kanban, task overview) to stay in sync.
				// ⚠️ 不广播 'done'/'error' delta — agent loop 中每次 LLM turn 结束都会 yield done，
				// 如果广播给外部监听器，会过早 finalize + setSending(false) + _resetStreamingMessage()，
				// 导致下一轮 LLM delta 到达时创建新的 assistant 消息卡片（冒泡消息 UI bug）。
				// 最终 done 在 for-await 循环退出后统一广播（见下方）。
				if (delta.type !== 'done' && delta.type !== 'error') {
					this._onDidStreamDeltaEmitter.fire({
						agentId,
						sessionId: options.agentSessionId || '',
						delta: delta as any,
					});
				}
			}

			this.logService.info(`[AgentChatService] Stream iteration done: ${_deltaCount} deltas in ${(performance.now() - tStream).toFixed(0)}ms`);

			// 用户点击 Stop → cancelStream 调用 controller.abort() → for-await break。
			// 此时 done/error delta 尚未被 stream 发射，UI 不会收到 setSending(false)。
			// 这里补发 done delta，让 nativeChatEditorPane 的 done handler 清理消息状态。
			// 如果是用户主动取消，带上 canceled:true 标记，让 UI 显示「用户已取消」并停止流式动画。
			if (controller.signal.aborted) {
				this.logService.info(`[AgentChatService] Stream aborted by user, emitting done delta with canceled flag for UI cleanup`);
				const cancelDelta = { type: 'done', canceled: true } as any;
				onDelta(cancelDelta);
			}

			// 广播 done delta 给外部监听器（看板 onDidStreamDelta）。
			// for-await 循环内只广播了 stream 的实时 delta，normal/abort 完成
			// 后都没广播 done → onDidStreamDelta 监听器无法重置按钮状态。
			this._onDidStreamDeltaEmitter.fire({
				agentId,
				sessionId: options.agentSessionId || '',
				delta: { type: 'done', canceled: controller.signal.aborted } as any,
			});

			// 诊断日志：for-await 循环已退出，即将进入 finalization。
			// 如果此日志不出现，说明 generator 的 finally 块阻塞了 for-await 退出。
			this.logService.info(`[AgentChatService] for-await loop exited, starting finalization`);

			// L0 记忆写入通知：由 agentDriverService 在 finally 块中 yield memory_writing delta
			// （含 noticeId），本处不再发送假的 "已保存" 信号。
			// 真实的写入结果通过 provider 的 onMemoryWritten/onMemoryWriteFailed 事件桥接到 onDelta。

			// Finalization safety net: the stream has fully completed, so any
			// tool call still lacking a status must have finished. Mark it 'done'
			// so the persisted card restores in a completed state rather than the
			// loading title after a window refresh.
			if (toolCalls) {
				for (const tc of toolCalls) {
					const chunks = _toolArgChunks.get(tc.id);
					if (chunks && chunks.length > 0) {
						tc.arguments = chunks.join('');
					}
					if (!tc.status) {
						tc.status = 'done';
					}
				}
			}
			// Flatten accumulated streamed text exactly once (O(n), no ConsString ropes).
			fullContent = _fullContentChunks.join('');
			fullThinking = _fullThinkingChunks.join('');

			// 共享的 token usage 对象（多条 turn 时仅挂在最后一条上）
			const sharedTokenUsage = usageSeen
				? {
					input: usageInput,
					output: usageOutput,
					// Prefer the gateway-reported total_tokens when present (it may
					// account for tokens not split into input/output); otherwise derive.
					total: usageTotalReported > 0 ? usageTotalReported : usageInput + usageOutput,
					cached: usageCached > 0 ? usageCached : undefined,
					cacheWrite: usageCacheWrite > 0 ? usageCacheWrite : undefined,
					credit: usageCreditSeen ? usageCredit : undefined,
				}
				: undefined;

			let chatMessage: ChatMessage;

			if (turns.length > 0) {
				// ─── Hermes-style 多条持久化（治本根因修复）──────────────────────
				// agentOS 发来了逐 iteration 的 `assistant_turn` 边界。按回合切分成
				// 多条 assistant 消息（共享一个 turnId），每条只含本轮 content + 本轮
				// 发起的 toolCalls（result 已按 id 回填到全局 toolCalls）。持久化后磁盘
				// 历史天然呈现 assistant(意图+toolCalls)→tool(结果)→assistant(下轮/总结)
				// 的正确因果链，回灌时不再出现"先宣告成功、后调用工具"的倒置范例。
				const turnId = `turn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
				const allToolCalls = toolCalls ?? [];
				const claimedIds = new Set<string>();
				const builtMessages: ChatMessage[] = [];

				for (let i = 0; i < turns.length; i++) {
					const turn = turns[i];
					const isLast = i === turns.length - 1;
					// 收集本轮工具调用（按 id 从全局取，已含回填好的 result/status）
					let turnToolCalls = turn.toolCallIds
						.map(id => allToolCalls.find(tc => tc.id === id))
						.filter((tc): tc is NonNullable<typeof tc> => !!tc);
					for (const tc of turnToolCalls) { claimedIds.add(tc.id); }
					// 防御：最后一轮兜底接管任何未被任何 turn 认领的工具调用
					if (isLast) {
						const orphans = allToolCalls.filter(tc => !claimedIds.has(tc.id));
						if (orphans.length > 0) {
							turnToolCalls = [...turnToolCalls, ...orphans];
							for (const tc of orphans) { claimedIds.add(tc.id); }
						}
					}
					const msg: ChatMessage = {
						id: `msg_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 7)}`,
						role: "assistant",
						content: turn.content,
						agentId,
						agentSessionId: options.agentSessionId,
						turnId,
						timestamp: new Date().toISOString(),
						...(turnToolCalls.length > 0 ? { toolCalls: turnToolCalls } : {}),
						// 阶段E：落盘有序 parts（文本段与工具段按 textPosition 一次性切分定位），
						// 作为重载渲染的唯一真相。textPosition 仅在此处切分时使用，不再跨层依赖。
						parts: deriveMessageParts({ role: "assistant", content: turn.content, toolCalls: turnToolCalls }),
						// thinking + 卡片数据 + token usage 都是整回合聚合量，仅挂最后一条，
						// 避免在多条气泡里重复渲染。
						...(isLast ? {
							thinking: fullThinking || undefined,
							references: references || undefined,
							progress: progress || undefined,
							confirmation: confirmation || undefined,
							todos: todos || undefined,
							tips: tips || undefined,
							questions: questions || undefined,
							tokenUsage: sharedTokenUsage,
						} : {}),
					};
				builtMessages.push(msg);
			}

			// ─── P5: 压缩边界消息插入（压缩状态跨 turn 持久化）────────────────
			// 本回合发生过压缩时，把边界消息插入到压缩点位置（压缩时已有 turnCount
			// 条 turn 消息，每条 turn 恰好产出一条持久化消息）。边界之后的消息
			// 是压缩后继续执行的真实迭代；下一 turn 回灌从边界处重放。
			if (pendingCompaction) {
				const boundaryMsg: ChatMessage = {
					id: `msg_compaction_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					role: "assistant",
					content: `[上下文压缩] 此前的对话历史（${pendingCompaction.originalCount} 条消息）已压缩为以下摘要：\n\n${pendingCompaction.summary}`,
					agentId,
					agentSessionId: options.agentSessionId,
					timestamp: new Date().toISOString(),
					metadata: {
						type: COMPACTION_METADATA_TYPE,
						originalCount: pendingCompaction.originalCount,
						compressedCount: pendingCompaction.compressedCount,
						tokensSaved: pendingCompaction.tokensSaved,
					},
				};
				const insertAt = Math.min(pendingCompaction.turnCount, builtMessages.length);
				builtMessages.splice(insertAt, 0, boundaryMsg);
				this.logService.info(
					`[AgentChatService][P5] Persisting compaction boundary at position ${insertAt}/${builtMessages.length} (cross-turn compression persistence)`,
				);
			}

			// 顺序持久化（保持磁盘顺序 = 因果顺序）
			for (const msg of builtMessages) {
					await this.appendMessage(agentId, msg).catch((err) =>
						this.logService.error(
							"[AgentChatService] Failed to persist assistant turn message:",
							err,
						),
					);
				}
				this.logService.info(
					`[AgentChatService] Persisted ${builtMessages.length} assistant turn message(s) under turnId=${turnId} (Hermes-style boundary)`,
				);
				// 返回最后一条（其 content 为最终总结，供 configHtmlService 解析）
				chatMessage = builtMessages[builtMessages.length - 1];
		} else {
			// ─── 回退：无边界事件（直连模式/旧后端）持久化单条 ────────────────
			// P5: 若本回合发生过压缩（executionProvider 路径也会 yield
			// context_compacted），先把压缩边界消息单独落盘，再落盘本条 ——
			// 下一 turn 回灌从边界处重放，语义与多 turn 路径一致。
			if (pendingCompaction) {
				const boundaryMsg: ChatMessage = {
					id: `msg_compaction_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					role: "assistant",
					content: `[上下文压缩] 此前的对话历史（${pendingCompaction.originalCount} 条消息）已压缩为以下摘要：\n\n${pendingCompaction.summary}`,
					agentId,
					agentSessionId: options.agentSessionId,
					timestamp: new Date().toISOString(),
					metadata: {
						type: COMPACTION_METADATA_TYPE,
						originalCount: pendingCompaction.originalCount,
						compressedCount: pendingCompaction.compressedCount,
						tokensSaved: pendingCompaction.tokensSaved,
					},
				};
				this.appendMessage(agentId, boundaryMsg).catch((err) =>
					this.logService.error("[AgentChatService] Failed to persist compaction boundary message:", err),
				);
			}
			chatMessage = {
				id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
				role: "assistant",
				content: fullContent,
					agentId,
					agentSessionId: options.agentSessionId,
					thinking: fullThinking || undefined,
					toolCalls: toolCalls || undefined,
				// 阶段E：落盘有序 parts。
				// P0: 优先使用流式期间按时间顺序跟踪的 chronological parts；
				// 回退到 deriveMessageParts（依赖 textPosition，跨迭代可能错位）。
				parts: _streamingParts.length > 0
					? _streamingParts
					: deriveMessageParts({ role: "assistant", content: fullContent, toolCalls: toolCalls }),
					timestamp: new Date().toISOString(),
					// New card data fields (VS Code Copilot Chat pattern)
					references: references || undefined,
					progress: progress || undefined,
					confirmation: confirmation || undefined,
					todos: todos || undefined,
					tips: tips || undefined,
					questions: questions || undefined,
					// KV Cache: persist token usage so the webview footer can render the
					// total + cache-hit badge (only emitted when the provider reported usage).
					tokenUsage: sharedTokenUsage,
				};

				this.appendMessage(agentId, chatMessage).catch((err) =>
					this.logService.error(
						"[AgentChatService] Failed to persist assistant message:",
						err,
					),
				);
			}

			return chatMessage;
		} catch (error) {
			this.logService.error(
				`[AgentChatService] sendMessage failed for ${agentId}:`,
				error,
			);
			onDelta({ type: "error", content: String(error) });
			this._onDidStreamDeltaEmitter.fire({
				agentId,
				sessionId: options.agentSessionId || '',
				delta: { type: 'error' as any, content: String(error) },
			});
			throw error;
		} finally {
			// OOM 诊断：流式结束后快照（对比 send-start heapUsed 即得本轮净增长）
			this._logMemSnapshot('send-done', { agentId, sessionId: options.agentSessionId });
			this._activeStreams.delete(streamKey);
			// 并发修复：移除本次流的回调与计时戳。writeMemory 完成事件若晚到，
			// 桥接会按 agentId 路由到该 agent 仍活跃的最近一次流；若已无活跃流则安全 no-op。
			this._activeOnDeltas.delete(streamKey);
			this._streamCreatedAt.delete(streamKey);
		}
	}

	/**
	 * 服务销毁时取消 memory 事件桥接订阅，避免泄漏。
	 * 该字段此前仅被赋值、未被读取，现通过 dispose 真正消费它。
	 */
	override dispose(): void {
		this._memoryEventUnsub?.();
		this._memoryEventUnsub = null;
		// 兜底落盘：清掉待触发的防抖定时器，把仍 dirty 的 index 同步写出。
		// dispose 不能 await，故 fire-and-forget（写队列自身串行，不会撕裂 JSON）。
		for (const timer of this._sessionIndexFlushTimers.values()) { clearTimeout(timer); }
		this._sessionIndexFlushTimers.clear();
		for (const agentId of [...this._sessionIndexDirty]) {
			void this.flushSessionIndex(agentId).catch(() => { });
		}
		super.dispose();
	}

	/**
	 * 订阅 memory provider 的 lifecycle 事件，桥接为 onDelta 调用。
	 * 替代旧的 fire-and-forget + 假"已保存" UI 信号。
	 *
	 * 幂等：只建立一次订阅；并发修复后用 {@link _getOnDeltaForAgent} 按 agentId
	 * 把事件路由到该 agent 最近一次活跃流的 onDelta，避免多会话串台。
	 */
	private _ensureMemoryEventBridge(): void {
		if (this._memoryBridgeReady) {
			return;
		}
		this._memoryBridgeReady = true;

		// Dedup: track processed noticeIds to prevent duplicate display
		const processedNoticeIds = new Set<string>();
		// Dedup map for Episodic/Semantic/Procedural extraction cards (no noticeId)
		// Key: memoryType, Value: last shown timestamp — 5s window prevents duplicate cards
		const recentExtractedTypes = new Map<string, number>();

		const provider = this.driverService.getActiveMemoryProvider();
		if (!provider?.onMemoryWritten) {
			// Provider 不支持事件订阅（旧 provider），回退：不桥接
			return;
		}

		const unsubWritten = provider.onMemoryWritten((agentId, data) => {
			// 串台防护：优先按 data.sessionId 精确路由到对应会话（agentId::sessionId）；
			// sessionId 缺失时退化为"同 agent 最近活跃流"。
			const onDelta = this._getOnDeltaForAgent(agentId, data.sessionId);
			if (!onDelta) {
				return;
			}
			if (data.noticeId) {
				// Dedup: skip if this noticeId was already processed
				if (processedNoticeIds.has(data.noticeId)) {
					return;
				}
				processedNoticeIds.add(data.noticeId);

				// L0 写入完成：contentLength 为 0 时移除 pending 卡片，不显示"已保存"
				if (!data.contentLength || data.contentLength === 0) {
					onDelta({
						type: 'memory_written' as any,
						content: '',
						metadata: { noticeId: data.noticeId, memoryType: data.memoryType, remove: true },
					} as any);
					return;
				}

			// Use actual memoryType for the label instead of hardcoding "Working"
			const memTypeLabels: Record<string, string> = {
				working: 'Working', semantic: 'Semantic', procedural: 'Procedural',
				pattern: 'Pattern', preference: 'Preference', architecture: 'Architecture',
				bug: 'Bug', workflow: 'Workflow', fact: 'Fact', instruction: 'Instruction',
			};
			const memLabel = memTypeLabels[data.memoryType ?? ''] ?? data.memoryType ?? 'Working';
				onDelta({
					type: 'memory_written' as any,
					content: `${memLabel} 已保存 ${data.contentLength}字`,
					metadata: { noticeId: data.noticeId, memoryType: data.memoryType },
				} as any);
			} else {
				// Episodic/Semantic/Procedural 写入完成：直接显示 saved 卡片（无对应 pending 卡片）
				// Skip 'working' type — working memory writes always go through the noticeId path above.
				// Hook-triggered working writes (post_tool_use) are redundant with per-iteration writes.
			const memType = data.memoryType ?? 'fact';
			if (memType === 'working' || memType === 'short_term') {
				return; // Working memory without noticeId = hook-triggered duplicate, skip
			}
			// Dedup: 同一 memoryType 在 5 秒内只显示一次（一次提取可能写入多条 fact）
			const now = Date.now();
			const lastShown = recentExtractedTypes.get(memType) ?? 0;
			if (now - lastShown < 5000) {
				return; // 5 秒内已显示过同类型卡片，跳过
			}
			recentExtractedTypes.set(memType, now);

			const typeLabels: Record<string, string> = {
				working: 'Working', semantic: 'Semantic', procedural: 'Procedural',
				pattern: 'Pattern', preference: 'Preference', architecture: 'Architecture',
				bug: 'Bug', workflow: 'Workflow', fact: 'Fact', instruction: 'Instruction',
			};
			const label = typeLabels[memType] ?? memType ?? 'Fact';
				onDelta({
					type: 'memory_extracted' as any,
					content: `${label} 已提取`,
					metadata: { memoryType: memType, status: 'saved' },
				} as any);
			}
		});

		const unsubFailed = provider.onMemoryWriteFailed?.((_agentId, data) => {
			// 串台防护：按 data.sessionId 精确路由（缺失时退化为最近活跃流）。
			const onDelta = this._getOnDeltaForAgent(_agentId, data.sessionId);
			if (onDelta && data.noticeId) {
				onDelta({
					type: 'memory_write_failed' as any,
					content: `Working 写入失败: ${data.error}`,
					metadata: { noticeId: data.noticeId, error: data.error },
				} as any);
			}
		}) ?? (() => { });

		// 技能提取事件桥接：sweep 中自动提取技能后通知 UI
		const providerAny = provider as any;
		const unsubSkill = providerAny?.onEvent?.('skill_extracted', (event: any) => {
			const agentId = event.agentId ?? '';
			const onDelta = this._getOnDeltaForAgent(agentId);
			if (!onDelta) {
				return;
			}
			const skillId = event.data?.['skillId'] as string ?? '';
			const title = event.data?.['title'] as string ?? '未知技能';
			onDelta({
				type: 'skill_extracted' as any,
				content: `⚡ 技能已沉淀: ${title}`,
				metadata: {
					skillId,
					title,
					agentId,
					clickable: true,
				},
			} as any);
		}) ?? null;

		this._memoryEventUnsub = () => {
			unsubWritten();
			unsubFailed();
			if (typeof unsubSkill === 'function') { unsubSkill(); }
		};
	}

	/**
	 * 并发路由：给定 agentId（及可选 sessionId），返回应接收该 memory 事件的 onDelta 回调。
	 *
	 * 内存 provider 的 onMemoryWritten/onMemoryWriteFailed 是全局事件。路由优先级：
	 *   1. 若传入 sessionId → 精确按 agentId::sessionId 命中对应会话的 onDelta（不串台）。
	 *      同 agent 多 session 并发时，A 的记忆写入结果只回 A 的聊天框。
	 *   2. 否则退化为"同 agent 最近一次活跃流"（sessionId 缺失的事件，如
	 *      memory_extracted / skill_extracted，仍走此兜底）。
	 */
	private _getOnDeltaForAgent(agentId: string, sessionId?: string): ((delta: IChatStreamDelta) => void) | undefined {
		if (!agentId) {
			return undefined;
		}
		// 1) 按 sessionId 精确路由（sessionId 由写入方写入 entry.metadata.sessionId 并透传）
		if (sessionId) {
			const key = `${agentId}::${sessionId}`;
			if (this._activeOnDeltas.has(key)) {
				return this._activeOnDeltas.get(key);
			}
		}
		// 2) 退化：同 agent 最近一次活跃流
		let bestKey: string | undefined;
		let bestTime = -1;
		for (const [key, time] of this._streamCreatedAt) {
			if (key === agentId || key.startsWith(`${agentId}::`)) {
				if (time > bestTime) {
					bestTime = time;
					bestKey = key;
				}
			}
		}
		return bestKey ? this._activeOnDeltas.get(bestKey) : undefined;
	}

	cancelStream(agentId: string, agentSessionId?: string): void {
		// The stream is stored under a composite key when agentSessionId exists
		// (see sendMessage line ~297).  We must look up the same key to abort it.
		const streamKey = agentSessionId
			? `${agentId}::${agentSessionId}`
			: agentId;
		const controller = this._activeStreams.get(streamKey);
		if (controller) {
			controller.abort();
			this._activeStreams.delete(streamKey);
		}
		// 并发修复：同步移除该流的回调与计时戳，避免内存事件桥接路由到已取消的流。
		this._activeOnDeltas.delete(streamKey);
		this._streamCreatedAt.delete(streamKey);
	}

	// ─── Agent Session CRUD (Root mode) ──────────────────────────────────────

	/**
	 * List all sessions for an agent.
	 * Reads from sessions.json index (fast, no file scanning).
	 */
	async listAgentSessions(agentId: string): Promise<AgentSessionMeta[]> {
		// 内存中可能有未落盘的 messageCount/updatedAt（防抖窗口内）→ 先 flush，
		// 否则列表显示的消息数/排序会滞后一个窗口。
		await this.flushSessionIndex(agentId);
		const index = await this._readSessionIndex(agentId);
		index.sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);
		return index;
	}

	/**
	 * Create a new session. Returns the full AgentSessionMeta.
	 */
	async createAgentSession(
		agentId: string,
		name?: string,
	): Promise<AgentSessionMeta> {
		this.logService.info(
			`[AgentChatService] createAgentSession: BEGIN agentId=${agentId}, name=${name ?? '(default)'}`,
		);
		const paths = await this._resolveAgentPaths(agentId);

		const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
		const now = new Date().toISOString();
		const meta: AgentSessionMeta = {
			id: sessionId,
			name: name || "新对话",
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
		};

		if (!(await this.fileService.exists(paths.sessionsDirUri))) {
			await this.fileService.createFolder(paths.sessionsDirUri);
		}
		await this.fileService.writeFile(
			this._sessionFileUri(paths.sessionsDirUri, sessionId),
			VSBuffer.fromString("[]"),
		);

		const index = await this._getSessionIndexForWrite(agentId);
		index.push(meta);
		this._sessionIndexDirty.add(agentId);
		await this.flushSessionIndex(agentId);

		this.logService.info(
			`[AgentChatService] createAgentSession: DONE sessionId=${sessionId}, agentId=${agentId}, indexSize=${index.length}`,
		);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
		return meta;
	}

	/**
	 * Rename a session.
	 */
	async renameAgentSession(
		agentId: string,
		sessionId: string,
		newName: string,
	): Promise<void> {
		const index = await this._getSessionIndexForWrite(agentId);
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			throw new Error(`Session ${sessionId} not found`);
		}
		entry.name = newName;
		entry.updatedAt = new Date().toISOString();
		this._sessionIndexDirty.add(agentId);
		await this.flushSessionIndex(agentId);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
	}

	/**
	 * Delete a session. If it's the last one, it can still be deleted
	 * (user will get a new session auto-created on next message).
	 */
	async deleteAgentSession(
		agentId: string,
		sessionId: string,
	): Promise<void> {
		const paths = await this._resolveAgentPaths(agentId);
		const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
		try {
			await this.fileService.del(fileUri);
		} catch {
			/* ignore */
		}
		// P1: clean up sidecar directory
		await this._deleteSidecarDir(agentId, sessionId);

		const index = await this._getSessionIndexForWrite(agentId);
		const filtered = index.filter((s) => s.id !== sessionId);
		// 删除后内存权威副本必须替换为过滤后的数组（不能只写盘），否则后续
		// _updateSessionIndex 仍看到已删条目并把它写回。
		this._sessionIndexData.set(agentId, { index: filtered, loadedAt: Date.now() });
		this._sessionIndexDirty.add(agentId);
		await this.flushSessionIndex(agentId);

		// Remove from memory cache
		const key = this._cacheKey(agentId, sessionId);
		this._historyCache.delete(key);
		this._historyCacheAccess.delete(key);
		await this._persistGlobalHistory();

		this.logService.info(
			`[AgentChatService] Deleted session ${sessionId} for ${agentId}`,
		);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
	}

	/**
	 * Fork (deep-copy) an existing session into a brand-new independent session.
	 *
	 * Strategy — **file-level copy**:
	 *   1. Copy the session's messages JSON verbatim (preserves TOOL_REF markers,
	 *      no resolve/re-externalise round-trip).
	 *   2. Copy the `.sidecar` directory (externalised oversize tool results);
	 *      sidecar files are named `tool_{tcId}.json` (no sessionId embedded),
	 *      so a directory copy yields a fully self-contained fork.
	 *   3. Register a fresh AgentSessionMeta in the index.
	 *
	 * The fork intentionally **drops providerSessionId** so the copy starts a
	 * fresh external provider thread and can diverge from the source safely.
	 * This is the "试探性会话" primitive (aligns with LangGraph `copy_thread`).
	 */
	async forkAgentSession(
		agentId: string,
		sessionId: string,
		newName?: string,
		parentForkContext?: IForkContext,
	): Promise<AgentSessionMeta> {
		// fork 要读 src.messageCount，且随后 push 新条目 → 走内存权威副本，
		// 否则会用磁盘旧内容覆盖掉防抖窗口内未落盘的 messageCount。
		const index = await this._getSessionIndexForWrite(agentId);
		const src = index.find((s) => s.id === sessionId);
		if (!src) {
			throw new Error(`Session ${sessionId} not found`);
		}

		const paths = await this._resolveAgentPaths(agentId);
		if (!(await this.fileService.exists(paths.sessionsDirUri))) {
			await this.fileService.createFolder(paths.sessionsDirUri);
		}

		const newId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
		const now = new Date().toISOString();

		// 1) Copy the messages file. If the source only lives in the in-memory
		//    cache (never flushed), persist that snapshot into the new file.
		const srcFile = this._sessionFileUri(paths.sessionsDirUri, sessionId);
		const dstFile = this._sessionFileUri(paths.sessionsDirUri, newId);
		if (await this.fileService.exists(srcFile)) {
			await this.fileService.copy(srcFile, dstFile, true);
		} else {
			const cached = this._historyCache.get(this._cacheKey(agentId, sessionId)) ?? [];
			await this.fileService.writeFile(
				dstFile,
				VSBuffer.fromString(JSON.stringify(cached, null, 2)),
			);
		}

		// 2) Copy the sidecar directory (externalised oversize tool results).
		try {
			const srcSidecar = await this._sidecarDirUri(agentId, sessionId);
			if (await this.fileService.exists(srcSidecar)) {
				const dstSidecar = await this._sidecarDirUri(agentId, newId);
				await this.fileService.copy(srcSidecar, dstSidecar, true);
			}
		} catch (err) {
			this.logService.warn(
				`[AgentChatService] forkAgentSession: sidecar copy failed for ${sessionId}: ${err instanceof Error ? err.message : err}`,
			);
		}

		// 3) Register the fork in the session index (fresh id, no provider thread).
		// 持久化父级完整 ForkContext（system+tools 前缀），供子会话后续 sendMessage
		// 经 session.forkContext 透传 → 请求构造端对齐父级前缀、命中 prompt cache。
		const meta: AgentSessionMeta = {
			id: newId,
			name: newName || `${src.name} (副本)`,
			createdAt: now,
			updatedAt: now,
			messageCount: src.messageCount,
			forkContextFingerprint: parentForkContext?.toolsFingerprint,
			forkContext: parentForkContext,
		};
		index.push(meta);
		this._sessionIndexDirty.add(agentId);
		await this.flushSessionIndex(agentId);

		// 4) Drop any stale cache bucket so the next getHistory lazy-loads fresh.
		const newKey = this._cacheKey(agentId, newId);
		this._historyCache.delete(newKey);
		this._historyCacheAccess.delete(newKey);

		this.logService.info(
			`[AgentChatService] forkAgentSession: ${sessionId} → ${newId} (agentId=${agentId}, msgs=${src.messageCount})`,
		);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
		return meta;
	}

	/**
	 * Get the most recently active session for an agent.
	 * If no sessions exist, auto-create one (first conversation).
	 * Returns the AgentSessionMeta of the active session.
	 */
	async getOrCreateActiveSession(
		agentId: string,
		name?: string,
	): Promise<AgentSessionMeta> {
		const t0 = performance.now();
		// Short-lived cache: the session index rarely changes within a single
		// execution setup window (~10s), but the file keeps growing with each
		// new session. Reading it takes 4‑5s for agents with 500+ sessions.
		const CACHE_TTL = 10_000;
		const now = Date.now();
		const cached = this._sessionIndexCache?.get(agentId);
		if (cached && (now - cached.ts) < CACHE_TTL) {
			return cached.meta;
		}
		const index = await this._getSessionIndexForWrite(agentId);
		this.logService.info(`[AgentChatService] getOrCreateActiveSession(${agentId}): index has ${index.length} sessions`);
		let meta: AgentSessionMeta;
		if (index.length > 0) {
			// 内存副本是写路径权威，不要原地 sort（会打乱 _updateSessionIndex 持有的
			// 引用顺序语义；虽不致错但易误导）→ 拷贝后排序。
			meta = index.slice().sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			)[0];
			this.logService.info(`[AgentChatService] getOrCreateActiveSession(${agentId}): latest session=${meta.id} updatedAt=${meta.updatedAt} name=${meta.name}`);
		} else {
			this.logService.info(`[AgentChatService] getOrCreateActiveSession(${agentId}): NO sessions, creating new`);
			meta = await this.createAgentSession(agentId, name || "新对话");
		}
		this._sessionIndexCache ??= new Map();
		this._sessionIndexCache.set(agentId, { meta, ts: now });
		console.info(`[PerfDiag] getOrCreateActiveSession elapsed=${(performance.now() - t0).toFixed(0)}ms agentId=${agentId}`);
		return meta;
	}

	/**
	 * Store the external provider's session ID (e.g. Knot AG-UI threadId)
	 * into the agent session metadata so it can be sent on subsequent requests.
	 */
	async updateProviderSessionId(
		agentId: string,
		sessionId: string,
		providerSessionId: string,
	): Promise<void> {
		// 走内存权威副本：若用 _readSessionIndex + _writeSessionIndex，会把防抖窗口内
		// 未落盘的 messageCount/updatedAt 用磁盘旧值覆盖掉。
		const index = await this._getSessionIndexForWrite(agentId);
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			return;
		}
		if (entry.providerSessionId === providerSessionId) {
			return;
		}
		entry.providerSessionId = providerSessionId;
		entry.updatedAt = new Date().toISOString();
		this._sessionIndexDirty.add(agentId);
		await this.flushSessionIndex(agentId);
		this.logService.info(
			`[AgentChatService] Stored providerSessionId=${providerSessionId} for session ${sessionId}`,
		);
	}

	/**
	 * Submit AskUser response (workflow interactive input).
	 */
	async submitAskUser(agentId: string, sessionId: string, executionId: string, nodeId: string, selection: string | string[]): Promise<void> {
		this.logService.info(
			`[AgentChatService] submitAskUser: agentId=${agentId}, sessionId=${sessionId}, executionId=${executionId}, nodeId=${nodeId}`,
		);
		// TODO: 实现向工作流引擎提交用户响应的逻辑
		// 这通常需要调用后端 API 或通过 driver 服务发送响应
		throw new Error('submitAskUser not yet implemented');
	}

	/**
	 * Apply code to file (from AI-generated code).
	 */
	async applyCode(agentId: string, sessionId: string, code: string, language: string, filePath?: string): Promise<void> {
		this.logService.info(
			`[AgentChatService] applyCode: agentId=${agentId}, sessionId=${sessionId}, language=${language}, filePath=${filePath}`,
		);
		// TODO: 实现将代码应用到文件的逻辑
		// 这通常需要调用文件服务或编辑器服务来写入文件
		throw new Error('applyCode not yet implemented');
	}
}
