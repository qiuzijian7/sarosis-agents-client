/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { isDraftAlreadyPersisted, normDraftCompareText, dropCoveredInterruptedDrafts, messageVisibleText } from "../common/interruptedDraftGuard.js";
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
import { IFileService } from "../../../../platform/files/common/files.js";
import { IEnvironmentService } from "../../../../platform/environment/common/environment.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { ILifecycleService } from "../../../../workbench/services/lifecycle/common/lifecycle.js";
import { URI } from "../../../../base/common/uri.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import { appendFileSafe, writeFileAtomicSafe } from "../common/atomicWrite.js";
import {
	replaySessionLog,
	serializeSessionLogAppends,
	serializeSessionLogBarrier,
	upsertMessageById,
	SESSION_LOG_SUFFIX,
} from "../common/sessionHistoryLog.js";
import {
	readSessionEvents as readEventsFromLog,
	type IReadSessionEventsResult,
	type ISessionEventCursor,
} from "../common/sessionEventStream.js";
import {
	AGENT_STUDIO_DATA_PATH_SETTING,
	DATA_FILE_CHAT_HISTORY,
	WORKSPACE_DATA_DIR,
	AGENTS_DIR,
} from "../common/constants.js";
import { createIndexLockToken, isIndexLockStale, parseIndexLock, serializeIndexLock } from './codebaseIndexLock.js';
import { diagnoseEmptyPriorMessagesImpl } from './contextMaintenance.js';

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
	/**
	 * ★ 2026-09-20（用户需求）：**这个名字是用户手动起的**。
	 *
	 * 首条消息发出去时，`NativeChatEditorPane` / webview `useChatStore` 会把会话名
	 * 自动改成「消息前 30 字」（因为新会话的占位名是「新对话」，没信息量）。
	 * 但如果用户已经手动改过名（侧栏铅笔 / 页签 Rename / 聊天框 Rename），
	 * 那次自动命名就会**把用户起的名字覆盖掉** —— 用户报的正是这个。
	 *
	 * 显式字段（而不是去猜「名字像不像自动生成的」——形态判断会随命名规则变化静默失效）：
	 * 手动改名入口传 `userInitiated` ⇒ 打上本标记；两个自动命名入口先检查它，置位即跳过。
	 */
	userRenamed?: boolean;
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
/**
 * 是否允许对该会话执行自动命名。
 *
 * 自动命名会覆盖会话名，因此用户手动命名过的会话必须让路；否则用户改的名字
 * 会在下一次自动命名时被静默冲掉（见 sessionAutoRename.test.ts 的回归）。
 *
 * @param nameIsCustom   该会话名是否由用户手动指定
 * @param historyLength  该会话已有历史消息条数
 */
export function shouldAutoRenameSession(
	nameIsCustom: boolean,
	historyLength: number,
): boolean {
	if (nameIsCustom) {
		return false;
	}
	return historyLength === 0;
}


export class AgentChatService extends Disposable implements IAgentChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _activeStreams = new Map<string, AbortController>();
	/**
	 * ★★★ 2026-09-19（用户选择"主流做法"✓）：**优雅停止**的标记集合（按 streamKey ✓）。
	 *
	 * 语义（对齐 OpenHands **pause** ✓ / Vercel AI SDK 的 `onAbort({steps})` 自行持久化 ✓）：
	 *   用户第一次点 Stop ⇒ **不立即切断**当前 LLM 请求 ✓ —— 让它跑完当前 iteration，
	 *   到 `assistant_turn` 边界（= 当前 iteration 的权威文本已确定 ✓）才硬中止 ✓
	 *   ⇒ **已生成的内容（含其 tokens/credit ✓）照常到达并落盘** ✓✓，只砍掉**后续** iteration ✗；
	 *   用户第二次点 Stop ⇒ 立即硬中止 ✓。
	 * ⚠ 生命周期：回合开始与 finalize 都要 `delete(streamKey)` ✓（避免泄漏到下一回合 ✗）。
	 */
	private readonly _gracefulStopRequested = new Set<string>();
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
	 * ★ 2026-09-12（P1 内存）：**活跃会话桶**的估算字节软上限。超过即对中段
	 * tool result 做三段式压缩（同 LRU 淘汰时的 P2 策略）。
	 *
	 * 由来：LRU 只淘汰**整条**会话桶，活跃桶内的消息**无界累积** —— 正是
	 * 2026-07-13「每发一条消息内存持续增长直至崩溃」的疑点（见
	 * `_estimateMessageBytes` 上方 OOM 诊断注释）。取 48MB 是权衡：低于此值
	 * 不值得改写用户可见内容（压缩会把中段 tool result 截到 280 字符）。
	 */
	private static readonly ACTIVE_BUCKET_SOFT_LIMIT_BYTES = 48 * 1024 * 1024;
	/**
	 * ★ 2026-09-12：活跃桶压缩检查的最小间隔。检查本身是 O(n) 扫字节（绝不
	 * `JSON.stringify`，避免 OOM 时翻倍分配），故按时间节流，避免每次批量落盘都扫。
	 */
	private static readonly ACTIVE_COMPACT_MIN_INTERVAL_MS = 60_000;
	/** 上次活跃桶压缩检查的时间戳（见 ACTIVE_COMPACT_MIN_INTERVAL_MS）。 */
	private _lastActiveCompactAt = 0;
	/**
	 * ★ 2026-09-12：清理时**保留**的单张 data URI 上限（字符数）。
	 *
	 * 超过此值的图片不再内联，替换为指向工作流卡片的占位。
	 *
	 * ⚠ 2026-09-12 二次修正：原值 `200 * 1024`（与写入侧 `agentDriverService.ts` 的
	 * `INLINE_MEDIA_MAX_BYTES` 对齐）**太大** —— 用户报「切换会话后仍显示图片码」，
	 * 实测那段 GIF base64 只有 **~2KB**，远低于 200KB → **根本没被清理**。
	 * 现降到 1KB：工作流输出的图不会这么小（卡片已完整展示），而 1KB 以上的 base64
	 * 内联在聊天流里没有任何价值。
	 *
	 * 同时**移除**了原先的 `INLINE_MEDIA_CLEANUP_MIN_TEXT`（512KB 文本门槛）——
	 * 那个门槛让「只含一小段图片码」的消息**整条被跳过**，正是漏网主因。
	 * 快速路径改为 `text.includes('data:')`：绝大多数消息不含 data:，一次 native
	 * 子串扫描（微秒级）即可跳过，无需长度门槛。
	 */
	private static readonly INLINE_MEDIA_KEEP_MAX_URI = 1024;
	/**
	 * ★ 2026-09-12：存量批量清理的**标记文件名**（放在 chat-history 根目录）。
	 *
	 * 一次性存量清理跑完后写入，之后启动直接跳过——避免「无 data URI 的大文件」
	 * （如巨型 ToolResult payload）每次启动都被读一遍做无谓检查。
	 * 带版本后缀：清理规则变化时换新标记名即可再跑一轮。
	 *
	 * ★ v1 → v2（2026-09-12）：匹配规则放宽 + 保留阈值 200KB → 1KB（见
	 *   `INLINE_MEDIA_KEEP_MAX_URI`）。v1 的判据会把「~2KB 的图片码」当成无需清理，
	 *   所以**必须换名**——否则已写过 v1 标记的机器上，新规则永远不会被执行。
	 */
	private static readonly BULK_CLEANUP_MARKER = '.inline-media-cleanup-v2';
	/** 批量清理的启动延迟（ms）——避开首屏渲染的 I/O 高峰。 */
	private static readonly BULK_CLEANUP_DELAY_MS = 15000;
	/** 批量清理的文件大小预筛阈值（字节）——只有超过此值的会话文件才值得解析。 */
	private static readonly BULK_CLEANUP_MIN_FILE_BYTES = 2 * 1024 * 1024;
	/** 批量清理单次最多处理的文件数——避免启动后跑成长期任务。 */
	private static readonly BULK_CLEANUP_MAX_FILES = 200;
	/**
	 * 批量清理跳过「最近修改」文件的窗口（ms）。
	 *
	 * 防竞态：mtime 在此窗口内的会话文件可能正被活跃会话写入（内存权威 → 落盘），
	 * 批量清理的「读-改-写」会与之打架。跳过它们不影响最终收敛——用户下次**打开**
	 * 该会话时由 `_loadFromSessionFile` 的惰性清理兜住。
	 */
	private static readonly BULK_CLEANUP_SKIP_RECENT_MS = 5 * 60 * 1000;
	/** 批量清理是否已调度（`_ensureHistoryLoaded` 可能被并发调用）。 */
	private _bulkCleanupScheduled = false;
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

	// ─── 会话追加日志（P0-1，2026-09-21）──────────────────────────────────────
	// 会话历史此前每 append/update 一次就**整会话重写** ✗（成本 ∝ 消息数；且崩溃丢整轮 ✗）。
	// 现改为「追加日志 + 定期快照」：追加是 O(1) 增量写 ✓，崩溃最多丢最后一行 ✓。
	// 语义与屏障机制详见 `common/sessionHistoryLog.ts` 头注释 ✓。
	/**
	 * 触发压缩（快照 + 屏障 + 截断）的**追加条数**阈值。
	 *
	 * 取值权衡：太小 ⇒ 快照写（整文件，MB 级）频繁 ✗，退化成改造前的成本；
	 * 太大 ⇒ 打开会话时要重放的日志行多（每行 parse 一次 ✓ 微秒级，可接受 ✓），
	 * 且日志文件体积大 ✗。512 条 ≈ 一个长 turn 的量级 ✓，典型会话压缩 1–2 次 ✓。
	 */
	private static readonly SESSION_LOG_COMPACT_AFTER = 512;
	/**
	 * 触发压缩的**字节**阈值（4MB）。
	 *
	 * **为什么条数阈值不够** ✗：单条消息可以是 MB 级（工具结果全文、大段代码 ✓），
	 * 512 条 × 大消息 ⇒ 日志能涨到几百 MB ✗（每次打开会话都要整份重放 ✗）。
	 * 两个阈值取「先到者」✓。
	 */
	private static readonly SESSION_LOG_COMPACT_AFTER_BYTES = 4 * 1024 * 1024;
	/**
	 * 每会话的写串行化链。
	 *
	 * **为什么必需**：`replaceHistory` / `deleteMessagesAfter` / 压缩快照走的是
	 * 「写快照 → 追加屏障 → 删日志」三步 ✓，若与并发追加**交错**（屏障插到别人追加的
	 * 前面 ✗），那条追加就会被重放丢弃 ✗（静默丢消息）。⇒ 同一会话的所有日志/快照写
	 * 必须串行 ✓（与 `_sessionIndexWriteQueue` 同一套路 ✓）。
	 */
	private readonly _sessionLogChain = new Map<string, Promise<void>>();
	/** key → 上次压缩后累计的追加条数（重放日志时按实际条数恢复 ✓）。 */
	private readonly _sessionLogAppends = new Map<string, number>();
	/** key → 上次压缩后累计的追加字节数（条数阈值兜不住 MB 级消息 ⇒ 双阈值 ✓）。 */
	private readonly _sessionLogBytes = new Map<string, number>();

	private _historyLoaded = false;
	private _globalDataUri: URI | undefined;

	private readonly _onDidChangeAgentSessionsEmitter = this._register(
		new Emitter<{ agentId: string }>(),
	);
	readonly onDidChangeAgentSessions: Event<{ agentId: string }> =
		this._onDidChangeAgentSessionsEmitter.event;

	/**
	 * ★ 2026-09-12：**会话被删除**的专门事件（携带被删 sessionId）。
	 *
	 * 为何不复用 `onDidChangeAgentSessions`：后者 payload 只有 agentId，且在每次
	 * messageCount 变化时都会 fire（一个 turn 50 条消息 = 50 次）。订阅方想知道
	 * 「我正在显示的会话被删了」就得每次去查会话列表 —— 噪音大且昂贵。
	 *
	 * 事故（日志 20260912T102833）：删除由**会话历史视图**发起时，聊天面板自己的
	 * `onDeleteSession` 回调根本不会被调用 → pane 的 `_currentSessionId` 仍指向已删
	 * 会话 → 下次发消息 `getHistory: 0 msgs` + `Auto-rename failed: Session not found`。
	 */
	private readonly _onDidDeleteAgentSessionEmitter = this._register(
		new Emitter<{ agentId: string; sessionId: string }>(),
	);
	readonly onDidDeleteAgentSession: Event<{ agentId: string; sessionId: string }> =
		this._onDidDeleteAgentSessionEmitter.event;

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
		// ★ 硬超时（2026-09-07）：join 的 promise 若挂起会**永久阻塞关闭**（用户报
		// 「点击 close 按钮没有反应」）。与 nativeChatEditorPane.interruptedStream
		// 同一模式——shutdown 期间服务可能半销毁，文件写入有挂起风险；宁可丢
		// 这几个 index 字段（下次会话刷新自愈），绝不让 app 关不掉。
		this._register(lifecycleService.onWillShutdown(e => {
			if (this._sessionIndexDirty.size === 0) {
				this.logService.info('[ShutdownTimeline] sessionIndex: clean, skip join');
				return;
			}
			const FLUSH_TIMEOUT_MS = 3000;
			const timeout = new Promise<void>(resolve => {
				setTimeout(() => resolve(), FLUSH_TIMEOUT_MS);
			});
			const work = this._flushAllSessionIndexes().catch(() => { });
			// 注意：这里**不清 timer**——e.join 后同步 clearTimeout 会让超时永不触发。
			// 进程即将退出，timer 泄漏无碍；work 先完成时 timeout promise 留至退出也无碍。
			const t0 = Date.now();
			this.logService.info(`[ShutdownTimeline] sessionIndex flush begin dirty=${this._sessionIndexDirty.size}`);
			e.join(Promise.race([work, timeout]).then(() => {
				this.logService.info(`[ShutdownTimeline] sessionIndex flush done elapsed=${Date.now() - t0}ms` +
					`(elapsed>=${FLUSH_TIMEOUT_MS} → timed out, index fields lost)`);
			}), {
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

	/** ★ P0-1：会话**追加日志**（`sessions/{sessionId}.jsonl`）—— 与快照同目录、同名不同扩展 ✓。 */
	private _sessionLogUri(sessionsDirUri: URI, sessionId: string): URI {
		return URI.joinPath(sessionsDirUri, `${sessionId}${SESSION_LOG_SUFFIX}`);
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
	/** 心跳失败只提示一次（P0-3：失败必须可见，但不能每 30s 刷屏）。 */
	private _sessionLockHeartbeatWarned = false;
	private _sessionLockUri: URI | undefined;

	/**
	 * 尝试获取会话锁。返回 acquired=false 时表示另一实例正在编辑（含持锁实例 ID）。
	 * 锁过期（持有方崩溃 2min）自动接管。
	 */
	async tryAcquireSessionLock(agentId: string, sessionId: string): Promise<{ acquired: boolean; holderInstanceId?: string; degraded?: boolean }> {
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
			this._sessionLockHeartbeatWarned = false;
			this._sessionLockHeartbeat = setInterval(() => {
				void writeLock().catch(err => {
					// ★★★ P0-3（2026-09-15）：**心跳失败也不能静默**。
					// 锁的「新鲜度」由 mtime 决定：连续 2min（`SESSION_LOCK_STALE_MS`）没刷新，
					// 别的窗口就有权接管 —— 而本窗口**仍在编辑** ⇒ 退化为「双方都以为持有锁」，
					// 正是这把锁要防的局面。只提示一次，避免每 30s 刷屏。
					if (!this._sessionLockHeartbeatWarned) {
						this._sessionLockHeartbeatWarned = true;
						this.logService.warn(`[AgentChatService] session lock heartbeat failed (another window may take over after 2min): ${err}`);
					}
				});
			}, 30_000);
			return { acquired: true };
		} catch (err) {
			// ★★★ 2026-09-15（P0-3）：**fail-open → fail-visible**。
			//
			// 原实现是 `warn('…(fail-open)')` + `return { acquired: true }` —— 即
			// 「加锁失败就当作拿到了锁，且**不告诉任何人**」✗。后果：用户以为会话受互斥保护，
			// 实际两个窗口可能同时写同一份对话历史（表现为「消息莫名少了 / 被回退」，且无从归因）。
			//
			// 现在：**保留可用性**（文件系统抖动不该把用户锁死在只读里），但把「未加锁」这个事实
			// 显式返回给上层 ⇒ pane 会弹警告 + 记日志（见 `nativeChatEditorPane._updateSessionLock`）。
			//
			// 为什么不是「直接降级只读」：① 此处失败多为瞬时/权限类抖动，而若连锁目录都写不进去、
			// 会话文件大概率也写不进去（保存时会报错，用户能看到）；② 会话写入已走原子写（P0-2）
			// ⇒ 最坏结果是「丢更新」，不再是「文件损坏」。**要点是"可见"，不是"禁止"。**
			this.logService.warn(`[AgentChatService] tryAcquireSessionLock failed — continuing WITHOUT lock (fail-visible): ${err}`);
			return { acquired: true, degraded: true };
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
	 * ★ 2026-09-12（P1 内存）：**活跃会话桶**的中段压缩。
	 *
	 * 原实现只在 LRU 淘汰**整桶**时压缩（`_evictLruBucket` → `_compactMessagesForEviction`），
	 * 活跃桶内的消息因此**无界累积** —— 这正是 2026-07-13「每发一条消息内存持续增长
	 * 直至崩溃」的疑点（见 `_estimateMessageBytes` 上方 OOM 诊断注释：「LRU 只淘汰整条
	 * 会话桶，不裁剪活跃会话内的消息，且 ToolMessage.result 原样留存」）。
	 *
	 * 现补：活跃桶估算字节超 `ACTIVE_BUCKET_SOFT_LIMIT_BYTES` 时，复用 LRU 同款
	 * 三段式压缩（保护头 `COMPACT_PROTECT_HEAD` / 尾 `COMPACT_PROTECT_TAIL`，只压中段），
	 * 并落盘使磁盘同样收敛。
	 *
	 * 触发条件刻意保守：① 只在超软上限时动作（否则不改写用户可见内容）；
	 * ② 按 `ACTIVE_COMPACT_MIN_INTERVAL_MS` 节流（估算字节是 O(n) 扫描）。
	 */
	private async _compactActiveBucketIfNeeded(agentId: string, sessionId?: string): Promise<void> {
		const now = Date.now();
		if (now - this._lastActiveCompactAt < AgentChatService.ACTIVE_COMPACT_MIN_INTERVAL_MS) { return; }
		this._lastActiveCompactAt = now;

		const messages = this._historyCache.get(this._cacheKey(agentId, sessionId));
		if (!messages || messages.length < AgentChatService.COMPACT_MIN_MESSAGES) { return; }

		let bytes = 0;
		for (const m of messages) { bytes += AgentChatService._estimateMessageBytes(m); }
		if (bytes < AgentChatService.ACTIVE_BUCKET_SOFT_LIMIT_BYTES) { return; }

		const truncated = this._compactMessagesForEviction(messages);
		if (truncated <= 0) { return; }

		this.logService.info(
			`[AgentChatService][P1] Compacted ${truncated} middle-segment tool result(s) in ACTIVE bucket ` +
			`${agentId}::${sessionId ?? '(noSession)'} (est ${Math.round(bytes / 1024 / 1024)}MB > soft limit ` +
			`${AgentChatService.ACTIVE_BUCKET_SOFT_LIMIT_BYTES / 1024 / 1024}MB, head=${AgentChatService.COMPACT_PROTECT_HEAD} tail=${AgentChatService.COMPACT_PROTECT_TAIL})`,
		);
		await this._persistToSessionFile(agentId, sessionId, messages).catch((err) =>
			this.logService.warn(
				`[AgentChatService][P1] persist after active-bucket compaction failed: ${err instanceof Error ? err.message : err}`,
			),
		);
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
	 * 底层是否仍有**本会话**的活跃流（含「已取消、未收尾」窗口期）。
	 *
	 * 语义：`_activeStreams` 要等流的 `finally` 才清理，因此 `cancelStream()` 之后
	 * 该方法仍会短暂返回 true —— 这正是入队判定需要的语义：此刻 UI 状态已复位，
	 * 但旧流还在收尾，新消息必须排队，否则会把未收尾的旧流彻底打断。
	 *
	 * 只统计本会话（`agentId::sessionId`），后台其它会话的流不参与判定
	 * —— 否则会在 A 会话发消息时被 B 会话的流误判为「忙」。
	 */
	isSessionStreaming(agentId: string, agentSessionId?: string): boolean {
		return this._isBucketOpen(this._cacheKey(agentId, agentSessionId));
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

			// ★★★ 2026-09-19：**必须同时统计 DOM 规模** ✓ —— 否则发现不了真正的爆点 ✗
			//
			// 真机取证（2026-09-19 卡死事故 ✓）：
			//   renderer 进程 RSS = **3.4GB** ✗ 而 V8 **JS 堆只有 600MB** ✓
			//   ⇒ 差值 ~2.8GB **不在 JS 堆里** ✓，而在 **DOM / 渲染层** ✗✓
			// 而 renderer 里 `process.memoryUsage()` **不可用** ✗（上面已回退到 `performance.memory`
			// ⇒ **只有 JS 堆** ✗）⇒ 只看 heap 永远看不到真凶 ✗✓。
			// 因此这里补上「页面节点总数 + 聊天消息元素数」✓ —— 这才是能**提前预警**卡死的指标 ✓。
			let domNodes = -1;
			let domMsgs = -1;
			try {
				// O(全部节点)：30s 一次的诊断采样，可接受 ✓（绝不在热路径调用 ✗）
				domNodes = document.getElementsByTagName('*').length;
				domMsgs = document.querySelectorAll('[data-msg-id]').length;
			} catch { /* 非 DOM 环境（单测/Node）忽略 */ }

			const domInfo = domNodes >= 0 ? ` | dom nodes=${domNodes} msgs=${domMsgs}` : '';
			const line = `[MemSnap][${tag}] heap=${heapUsed}/${heapTotal}MB rss=${rss}MB ext=${ext}MB${limitTag} | ` +
				`cache buckets=${this._historyCache.size} sessBuckets=${this._countSessionBuckets()} totalMsgs=${totalMsgs} | ` +
				`active[${activeKey}] msgs=${activeMsgs} bytes=${mb(activeBytes)}MB${appendInfo}${domInfo}`;

			// 阈值升级：DOM 规模失控是「app 卡死」的**直接前兆** ✓（信息级日志会被忽略 ✗）
			if (domNodes >= AgentChatService.DOM_ERROR_NODES) {
				this.logService.error(`${line} ⚠⚠ DOM 节点数 ${domNodes} 超危险阈值 ${AgentChatService.DOM_ERROR_NODES} —— 主线程即将被布局/重排拖死（真机 3.4GB 事故前兆 ✓）`);
			} else if (domNodes >= AgentChatService.DOM_WARN_NODES) {
				this.logService.warn(`${line} ⚠ DOM 节点数 ${domNodes} 偏高（>${AgentChatService.DOM_WARN_NODES}）`);
			} else {
				this.logService.info(line);
			}
		} catch { /* 诊断绝不能打断主流程 */ }
	}

	// ─── 内存/DOM 周期监护（2026-09-19）────────────────────────────────────
	//
	// 背景（真机 ✓）：`MemSnap` 原来只在 **3 个事件点**打点 ✗
	// （send-start ✓ / append-batch ✓ / send-done ✓），而卡死那次**整份日志只有 2 条** ✗✓
	// ⇒ 内存从正常涨到 RSS 3.4GB 的**全过程零记录** ✗ ⇒ 事后无法归因 ✓。
	// 现在补一个 **30s 周期采样** ✓；只在「有活跃流」或「DOM 越过警戒线」时输出 ✓ ⇒ 不刷屏 ✓。

	/** DOM 节点数警戒线（典型聊天面板约 2–5k 节点 / 30 条消息 ✓）。 */
	private static readonly DOM_WARN_NODES = 60_000;
	/** DOM 节点数危险线（真机 1675 条消息全量入 DOM 时远超此值 ✗）。 */
	private static readonly DOM_ERROR_NODES = 120_000;

	private _memWatchTimer: number | null = null;

	/** 惰性启动周期监护（幂等 ✓，首次 sendMessage 时调用 ✓）。 */
	private _startMemWatch(): void {
		if (this._memWatchTimer !== null) { return; }
		this._memWatchTimer = window.setInterval(() => {
			let domNodes: number;
			try {
				domNodes = document.getElementsByTagName('*').length;
			} catch { return; }
			const busy = this._activeStreams.size > 0;
			if (!busy && domNodes < AgentChatService.DOM_WARN_NODES) {
				// 空闲且 DOM 健康 ⇒ 采样丢弃（不产生日志）✓
				return;
			}
			this._logMemSnapshot(busy ? 'tick' : 'tick-idle');
		}, 30_000);
	}

	private async _ensureHistoryLoaded(): Promise<void> {
		if (this._historyLoaded) {
			return;
		}
		this._historyLoaded = true;
		// ★ 2026-09-12：调度存量历史批量清理（延迟执行，不阻塞启动路径；详见方法注释）。
		//   放在此处而非方法末尾：末尾有「无 global history 文件即 return」的早退分支，
		//   而批量清理只依赖 chat-history 目录，与 global history 文件是否存在无关。
		this._scheduleBulkInlineMediaCleanup();
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
			// ★ P0-1（2026-09-21）：本方法语义 = 「以 messages 为**完整权威**」⇒ 走快照路径
			//   （原子写 + 屏障 + 截断日志 ✓）。**增量追加**请用 `_appendToSessionLog` ✓ ——
			//   正常对话路径（append/update）已全部切换到追加；此处只剩「整段改写」的调用方：
			//   压缩后写回、LRU 淘汰前写回、加载期修复（refs 解析 / 内联大图清理）、
			//   deleteMessagesAfter（截断）✓。
			const key = this._cacheKey(agentId, sessionId);
			await this._withSessionLogLock(key, async () => {
				const { sessionsDirUri } = await this._resolveAgentPaths(agentId);
				if (!(await this.fileService.exists(sessionsDirUri))) {
					await this.fileService.createFolder(sessionsDirUri);
				}
				await this._writeSessionSnapshotLocked(agentId, sessionId, sessionsDirUri, messages);
			});
		} catch (err) {
			this.logService.error(
				"[AgentChatService] _persistToSessionFile failed:",
				err,
			);
		}
	}

	/**
	 * ★ P0-1（2026-09-21）：写**快照**（完整会话）+ 屏障 + 截断日志。
	 *
	 * 语义 = 「以 `messages` 为完整权威」⇒ 此前写入的日志条目必须失效 ✓：
	 * ① 原子写快照（旧内容 / 新内容二选一，绝不半截 ✓）；
	 * ② 追加**屏障**：重放时屏障之前的条目一律丢弃 ✓（此步之后崩了也正确 ✓）；
	 * ③ 尽力删除日志（删不掉只是体积问题 ✓ 正确性已由屏障兜住 ✓）。
	 *
	 * ⚠ 必须在 `_withSessionLogLock` **内**调用 —— 三步之间不允许插入任何追加 ✗，
	 * 否则「先追加、后屏障」的那条追加会被重放丢弃（静默丢消息 ✗✓）。
	 */
	private async _writeSessionSnapshotLocked(
		agentId: string,
		sessionId: string,
		sessionsDirUri: URI,
		messages: readonly ChatMessage[],
	): Promise<void> {
		if (!(await this.fileService.exists(sessionsDirUri))) {
			await this.fileService.createFolder(sessionsDirUri);
		}
		const fileUri = this._sessionFileUri(sessionsDirUri, sessionId);
		// ★ 2026-09-15：**会话本体**是高频覆盖写、且启动即读 ⇒ 必须原子写（详见 common/atomicWrite.ts）。
		await writeFileAtomicSafe(this.fileService, fileUri, VSBuffer.fromString(JSON.stringify(messages, null, 2)));
		const logUri = this._sessionLogUri(sessionsDirUri, sessionId);
		await appendFileSafe(this.fileService, logUri, VSBuffer.fromString(serializeSessionLogBarrier()));
		try {
			if (await this.fileService.exists(logUri)) { await this.fileService.del(logUri); }
		} catch { /* 删不掉无妨：重放遇到屏障即丢弃旧条目 ✓ */ }
		this._sessionLogAppends.set(this._cacheKey(agentId, sessionId), 0);
		this._sessionLogBytes.set(this._cacheKey(agentId, sessionId), 0);
		await this._updateSessionIndex(agentId, sessionId, messages.length).catch(err =>
			this.logService.warn(
				`[AgentChatService] session index update after snapshot failed for ${agentId}::${sessionId}: ${err instanceof Error ? err.message : err}`,
			),
		);
	}

	/** 同一会话的日志/快照写串行化（见 `_sessionLogChain` 字段注释 ✓）。 */
	private async _withSessionLogLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this._sessionLogChain.get(key) ?? Promise.resolve();
		// ⚠ 前一笔失败不能阻塞后续 —— 否则一次写失败会让该会话**永久**无法落盘 ✗
		const run = prev.then(fn, fn);
		const tail = run.then(() => { }, () => { });
		this._sessionLogChain.set(key, tail);
		try {
			return await run;
		} finally {
			if (this._sessionLogChain.get(key) === tail) { this._sessionLogChain.delete(key); }
		}
	}

	/**
	 * ★ P0-1：**追加**消息到会话日志（增量写 ✓，不动快照 ✓）。
	 *
	 * 累计条数超阈值时在锁内顺带压缩（快照 + 屏障 + 截断）⇒ 日志不会无限增长 ✓。
	 * 失败只记日志 —— 与改造前的 `_persistToSessionFile` 一致：落盘失败不该打断对话 ✓。
	 */
	private async _appendToSessionLog(
		agentId: string,
		sessionId: string | undefined,
		msgs: readonly ChatMessage[],
	): Promise<void> {
		if (!sessionId || msgs.length === 0) { return; }
		const text = serializeSessionLogAppends(msgs);
		if (!text) { return; } // 全部无 id ⇒ 无法在重放时定位（写了只会变成重复气泡 ✗）
		const key = this._cacheKey(agentId, sessionId);
		try {
			await this._withSessionLogLock(key, async () => {
				const { sessionsDirUri } = await this._resolveAgentPaths(agentId);
				if (!(await this.fileService.exists(sessionsDirUri))) {
					await this.fileService.createFolder(sessionsDirUri);
				}
				await appendFileSafe(this.fileService, this._sessionLogUri(sessionsDirUri, sessionId), VSBuffer.fromString(text));
				const pending = (this._sessionLogAppends.get(key) ?? 0) + msgs.length;
				const pendingBytes = (this._sessionLogBytes.get(key) ?? 0) + text.length;
				this._sessionLogAppends.set(key, pending);
				this._sessionLogBytes.set(key, pendingBytes);
				if (pending >= AgentChatService.SESSION_LOG_COMPACT_AFTER
					|| pendingBytes >= AgentChatService.SESSION_LOG_COMPACT_AFTER_BYTES) {
					const messages = this._historyCache.get(key);
					if (messages) {
						await this._writeSessionSnapshotLocked(agentId, sessionId, sessionsDirUri, messages);
						this.logService.info(
							`[AgentChatService] compacted session log ${key} after ${pending} appends → snapshot ${messages.length} msgs`,
						);
					} else {
						// 缓存已被 LRU 淘汰：无从写快照 ⇒ 只重置计数（下次加载按重放条数恢复 ✓）
						this._sessionLogAppends.set(key, 0);
					}
				} else {
					const total = this._historyCache.get(key)?.length ?? msgs.length;
					await this._updateSessionIndex(agentId, sessionId, total).catch(err =>
						this.logService.warn(
							`[AgentChatService] session index update failed for ${key}: ${err instanceof Error ? err.message : err}`,
						),
					);
				}
			});
		} catch (err) {
			this.logService.error("[AgentChatService] _appendToSessionLog failed:", err);
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
			const logUri = this._sessionLogUri(paths.sessionsDirUri, sessionId);
			const hasSnapshot = await this.fileService.exists(fileUri);
			const hasLog = await this.fileService.exists(logUri);
			if (!hasSnapshot && !hasLog) {
				return [];
			}
			// ① 快照（完整 ChatMessage[]，原子写 ⇒ 不会是半截 ✓）
			let messages: ChatMessage[] = [];
			if (hasSnapshot) {
				try {
					const parsed = JSON.parse(
						(await this.fileService.readFile(fileUri)).value.toString(),
					) as ChatMessage[];
					messages = Array.isArray(parsed) ? parsed : [];
				} catch (err) {
					// 快照读不出来（历史遗留半写 / 外部损坏 ✗）⇒ **不整段丢弃**：改为尽量从日志重建 ✓
					this.logService.warn(
						`[AgentChatService] session snapshot unreadable for ${agentId}::${sessionId} ` +
						`— rebuilding from append-only log: ${err instanceof Error ? err.message : err}`,
					);
					messages = [];
				}
			}
			// ② 追加日志（★ P0-1）：只取**屏障之后**的条目，按 id 归并（幂等 ✓）
			if (hasLog) {
				try {
					const replay = replaySessionLog(
						(await this.fileService.readFile(logUri)).value.toString(),
					);
					if (replay.tornLines > 0) {
						// 追加途中被 kill ⇒ 尾行可能只有半行 JSON —— 这是**正常情况** ✓
						// （损失仅最后一条消息 ✓），不是数据损坏，不必告警到 error ✓
						this.logService.warn(
							`[AgentChatService] session log for ${agentId}::${sessionId} had ` +
							`${replay.tornLines} unparsable line(s) (crash-truncated tail) — ignored`,
						);
					}
					for (const m of replay.messages) { upsertMessageById(messages, m); }
					// 压缩阈值计数按**实际重放条数与字节**恢复（跨进程重启后依然有界 ✓）
					this._sessionLogAppends.set(this._cacheKey(agentId, sessionId), replay.appends);
					this._sessionLogBytes.set(this._cacheKey(agentId, sessionId), replay.bytes);
				} catch (err) {
					this.logService.warn(
						`[AgentChatService] session log unreadable for ${agentId}::${sessionId}: ` +
						`${err instanceof Error ? err.message : err}`,
					);
				}
			}
			// P1: resolve externalised tool result refs (from prior LRU eviction)
			const resolved = await this._resolveToolResultRefs(agentId, sessionId, messages);
			// ★ 2026-09-12：存量历史脏数据清理 —— 移除内联的超长 data URI（详见方法注释）。
			//   放在「会话文件刚出磁盘」这一唯一收口：此处 messages 就是该文件的全部内容
			//   （不含 getHistory 里 merge 进来的跨会话 system 消息），回写即精确修正本文件。
			const scrubbed = this._scrubOversizedInlineMedia(messages);
			if (scrubbed.replaced > 0) {
				this.logService.info(
					`[AgentChatService] Scrubbed ${scrubbed.replaced} oversized inline data URI(s) ` +
					`(${(scrubbed.freedBytes / 1024 / 1024).toFixed(1)}MB) from ${agentId}::${sessionId} — ` +
					`images remain available in workflow cards.`,
				);
			}
			if (resolved > 0 || scrubbed.replaced > 0) {
				// Write back resolved messages so next load is fast (no sidecar I/O)
				await this._persistToSessionFile(agentId, sessionId, messages).catch(() => { });
			}
			return messages;
		} catch {
			return [];
		}
	}

	/**
	 * ★ 2026-09-12：存量历史脏数据清理 —— 移除已落盘消息里**内联的超长 data URI**。
	 *
	 * **背景**（日志 1789133432350）：`agentDriverService` 曾把 workflow 的全部媒体快照
	 * 内联成 `![输出 N](data:image/jpeg;base64,…)`，42 张 ≈ **8.4MB 单条 content**。
	 * 这既触发过 `marked.parse` 栈溢出（已由 `agentChatPanel.markdown.ts` 的
	 * `_renderMarkdownSafe` 分片兜底修复），也让**历史文件本身**巨大（每条数十 MB JSON）
	 * ——拖慢加载/解析、白占磁盘。
	 *
	 * 写入侧已改为「单张 ≤200KB 且总数 ≤4」（`agentDriverService.ts`），不再产生新巨物；
	 * 本方法负责**存量收敛**：会话文件从磁盘读入时扫一遍，把超限的大图内联替换为一行
	 * 占位，随后由调用方回写落盘。
	 *
	 * **为何可安全替换**：这些内联 base64 是**冗余副本** —— 媒体本身已由工作流卡片的
	 * snapshot 机制完整展示，移除不丢信息。
	 *
	 * 成本：快速路径是 `text.includes('data:')`（native 子串扫描，微秒级）——绝大多数
	 * 消息不含 data: 直接跳过；清理一次后文本不再含长 URI，后续加载自然零成本。
	 */
	private _scrubOversizedInlineMedia(messages: ChatMessage[]): { replaced: number; freedBytes: number } {
		let replaced = 0;
		let freedBytes = 0;
		const scrub = (text: string): string => {
			const PH_PREFIX = '📎 ';
			// 精简文案（2026-09-12）：原「（图片已由工作流卡片展示，历史记录中不再内联）」
			// 太长 —— 63 条折叠成一行后仍然啰嗦。
			const PH_SUFFIX = '（见上方工作流卡片）';
			/**
			 * 判断某行是否为「媒体占位」。
			 *
			 * ⚠ 必须**宽松**（只认前缀 + 含「工作流卡片」），不能用 `endsWith(PH_SUFFIX)`：
			 *   老版本写进历史的占位用的是**长文案**（「图片已由工作流卡片展示，历史记录中
			 *   不再内联」），严格后缀匹配会让它们**永远折叠不了**（正是用户第二次截图里
			 *   那片糊在一起的三列占位）。
			 */
			const isPlaceholder = (line: string): boolean =>
				line.startsWith(PH_PREFIX) && line.includes('工作流卡片');

			// ① 清理内联 base64 图片。
			//
			// 快速路径：绝大多数消息不含 data:（native 子串扫描，微秒级）。
			// ⚠ 折叠（②）**不能**挂在这个快速路径后面 —— 上次清理过的历史里已经没有
			//   `data:` 了，但仍需要折叠（否则 63 条占位永远排成一片）。
			//
			// 宽松匹配（2026-09-12 二次修正）—— 事故现场的实际数据比标准 Markdown
			// 图片语法更松散，原严格正则 `/!\[([^\]]*)\]\((data:[^)\s]+)\)/` 完全匹配
			// 不到，于是图片码原样显示给用户：
			//   `[输出 32]` + 换行 + `(data:image/gif;base64,...`
			// 四处放宽：① `!` 可选（前缀曾被吃掉）；② `]` 与 `(` 之间允许空白/换行；
			// ③ `(` 与 `data:` 之间允许空白；④ URI 与 `)` 之间允许空白
			// （实测：`...base64,AAAA )` 若不放开这一处会**完全匹配不到**）。
			// alt 上限 80 字符、URI 下限 64 字符 —— 避免误伤普通文本里的 data: 提及。
			// `[^)\s]` 保证 URI 内不含空白 → `\s*` 只吃空白，无回溯风险。
			let out = text;
			if (text.includes('data:')) {
				out = text.replace(
					/!?\[([^\]]{0,80})\]\s*\(\s*(data:[^)\s]{64,})\s*\)/g,
					(whole, alt: string, uri: string) => {
						if (uri.length <= AgentChatService.INLINE_MEDIA_KEEP_MAX_URI) { return whole; }
						replaced++;
						freedBytes += uri.length;
						return `${PH_PREFIX}${alt || '输出'}${PH_SUFFIX}`;
					},
				);
			}

			// ② 折叠：把**连续多个**占位合并为一行摘要。
			//
			// 事故现场（2026-09-12 用户截图）：一条消息里有 63 个输出 → 逐项占位会排出
			// 63 条一模一样的啰嗦文案（排成三列糊成一片），比原来的图片码还难读。
			// 这些占位在原始数据里是 `\n` 分隔（`agentDriverService` 用 join('\n')），
			// Markdown 单换行渲染成软换行 → 视觉上连排，所以按行折叠即可命中。
			//
			// 单个占位**原样保留**（保留编号，信息不丢）；连续 ≥2 个才折叠成计数摘要。
			// 折叠也 `replaced++`：让调用方知道「有改动」从而回写落盘（否则已清理过的
			// 历史永远不会被折叠、也永远不会写回）。
			if (!out.includes(PH_PREFIX)) { return out; }
			const merged: string[] = [];
			let run = 0;
			let firstLine = '';
			const flushRun = () => {
				if (run === 0) { return; }
				if (run === 1) {
					merged.push(firstLine);		// 单个：保留编号
				} else {
					merged.push(`${PH_PREFIX}${run} 个输出${PH_SUFFIX}`);
					replaced++;
				}
				run = 0;
				firstLine = '';
			};
			for (const line of out.split('\n')) {
				const t = line.trim();
				if (isPlaceholder(t)) {
					if (run === 0) { firstLine = line; }
					run++;
					continue;
				}
				flushRun();
				merged.push(line);
			}
			flushRun();

			// ③ 整条清空判据（2026-09-12，用户反馈「已完成 42 个输出」也重复）：
			//   清理/折叠后若「除媒体占位外，只剩 `已完成 N 个输出` 这类状态文案」，
			//   则整条视为**纯媒体汇报** → 清空。
			//
			//   目的：让历史里那种「已完成 42 个输出 + 63 条占位」的独立文本消息彻底消失
			//   （`getHistory` 的空消息过滤会丢弃 content 为空且无 parts 的消息）。
			//   工作流卡片在**另一条**消息里，不受影响。
			//
			//   与生成侧对齐：`agentDriverService` 现在有卡片时也不再发这段文本。
			const residue = merged
				.filter(l => !isPlaceholder(l.trim()))
				.join('\n')
				.replace(/已完成\s*\d+\s*个输出/g, '')
				.trim();
			if (residue.length === 0) {
				replaced++;		// 计入「有改动」→ 触发调用方回写落盘
				return '';
			}
			return merged.join('\n');
		};
		for (const m of messages) {
			const anyM = m as unknown as Record<string, unknown>;
			if (typeof anyM['content'] === 'string') {
				const next = scrub(anyM['content']);
				if (next !== anyM['content']) { anyM['content'] = next; }
			}
			if (Array.isArray(anyM['parts'])) {
				for (const p of anyM['parts'] as Array<Record<string, unknown>>) {
					if (typeof p?.['text'] === 'string') {
						const next = scrub(p['text']);
						if (next !== p['text']) { p['text'] = next; }
					}
				}
			}
		}
		return { replaced, freedBytes };
	}

	/**
	 * ★ 2026-09-12：调度**存量历史批量清理**（一次性、延迟、幂等）。
	 *
	 * **为何需要**：`_loadFromSessionFile` 的惰性清理只在用户**打开**某会话时生效——
	 * 历史里那些**再也不会被打开**的旧会话仍占着磁盘（每条数十 MB JSON）。
	 *
	 * **幂等**：跑完在 chat-history 根目录写标记文件（`BULK_CLEANUP_MARKER`），之后
	 * 启动直接跳过。不用「按文件大小判断」代替标记，是因为巨型 ToolResult payload
	 * 这类**无 data URI 的大文件**会每次启动都被白读一遍。
	 */
	private _scheduleBulkInlineMediaCleanup(): void {
		if (this._bulkCleanupScheduled) { return; }
		this._bulkCleanupScheduled = true;
		setTimeout(() => { void this._runBulkInlineMediaCleanup(); }, AgentChatService.BULK_CLEANUP_DELAY_MS);
	}

	/**
	 * 遍历 chat-history/{agentId}/sessions/*.json，清理内联的超长 data URI。
	 *
	 * 三层成本控制：① 延迟 15s 执行，避开首屏 I/O；② `stat.size` 预筛（< 2MB 直接跳过，
	 * 不读文件）；③ 单次处理上限（`BULK_CLEANUP_MAX_FILES`）。单文件失败不影响其余。
	 */
	private async _runBulkInlineMediaCleanup(): Promise<void> {
		try {
			const root = this._getChatHistoryRoot();
			if (!(await this.fileService.exists(root))) { return; }
			const markerUri = URI.joinPath(root, AgentChatService.BULK_CLEANUP_MARKER);
			if (await this.fileService.exists(markerUri)) { return; }	// 已跑过

			// resolveMetadata: 预筛与竞态防护依赖 size/mtime，而它们只在
			// IFileStatWithMetadata 上（裸 IFileStat 不含）。
			const rootStat = await this.fileService.resolve(root, { resolveMetadata: true });
			let scanned = 0;			// 遍历到的 .json 总数
			let processed = 0;			// 实际解析过的大文件数（受上限约束）
			let cleanedFiles = 0;		// 有清理动作的文件数
			let totalReplaced = 0;
			let totalFreed = 0;

			for (const agentEntry of rootStat.children ?? []) {
				if (!agentEntry.isDirectory) { continue; }
				if (processed >= AgentChatService.BULK_CLEANUP_MAX_FILES) { break; }
				const sessionsDir = URI.joinPath(agentEntry.resource, 'sessions');
				let dirStat;
				try {
					if (!(await this.fileService.exists(sessionsDir))) { continue; }
					dirStat = await this.fileService.resolve(sessionsDir, { resolveMetadata: true });
				} catch { continue; }
				for (const f of dirStat.children ?? []) {
					if (processed >= AgentChatService.BULK_CLEANUP_MAX_FILES) { break; }
					if (f.isDirectory || !f.name.endsWith('.json')) { continue; }
					scanned++;
					// 大小预筛：stat 已带 size，避免为小文件付解析成本。
					if ((f.size ?? 0) < AgentChatService.BULK_CLEANUP_MIN_FILE_BYTES) { continue; }
					// 竞态防护：最近修改过的文件可能正被活跃会话使用，跳过（详见常量注释）。
					if (f.mtime && Date.now() - f.mtime < AgentChatService.BULK_CLEANUP_SKIP_RECENT_MS) { continue; }
					processed++;
					try {
						const content = await this.fileService.readFile(f.resource);
						const messages = JSON.parse(content.value.toString()) as ChatMessage[];
						const scrubbed = this._scrubOversizedInlineMedia(messages);
						if (scrubbed.replaced > 0) {
							await this.fileService.writeFile(
								f.resource,
								VSBuffer.fromString(JSON.stringify(messages, null, 2)),
							);
							cleanedFiles++;
							totalReplaced += scrubbed.replaced;
							totalFreed += scrubbed.freedBytes;
						}
					} catch { /* 单文件失败不影响其余 */ }
				}
			}

			if (totalReplaced > 0) {
				this.logService.info(
					`[AgentChatService] Bulk inline-media cleanup: scrubbed ${totalReplaced} oversized data URI(s) ` +
					`(${(totalFreed / 1024 / 1024).toFixed(1)}MB) across ${cleanedFiles} session file(s) ` +
					`(scanned ${scanned}, parsed ${processed}).`,
				);
			} else {
				this.logService.trace(
					`[AgentChatService] Bulk inline-media cleanup: scanned ${scanned}, parsed ${processed}, nothing to scrub.`,
				);
			}
			// 写标记：无论是否有清理都写，避免每次启动重扫。
			await this.fileService.writeFile(markerUri, VSBuffer.fromString(new Date().toISOString()));
		} catch (err) {
			this.logService.warn('[AgentChatService] Bulk inline-media cleanup failed:', err);
		}
	}

	// ─── Session Index (sessions.json) ───────────────────────────────────────

	private async _readSessionIndex(
		agentId: string,
	): Promise<AgentSessionMeta[]> {
		try {
			const paths = await this._resolveAgentPaths(agentId);
			if (!(await this.fileService.exists(paths.indexUri))) {
				// ★ 2026-09-12：索引文件不存在 ≠ 没有会话 —— 可能是索引丢失。
				//   见 _recoverSessionIndexFromDir 的事故说明。
				return await this._recoverSessionIndexFromDir(agentId, 'missing');
			}
			const content = await this.fileService.readFile(paths.indexUri);
			const text = content.value.toString();
			// ★ 2026-09-12 修正：原实现把空文件当「合法空索引」，并注释称
			//   「由下次 _updateSessionIndex 恢复」——**该假设是错的**：
			//   ① `_updateSessionIndex` 只在该会话**首次 append** 时 push，不会重建
			//      已丢失的条目；
			//   ② 本函数返回的 `[]` 会被 `_getSessionIndexForWrite` 设为内存**写权威**，
			//      之后任何一次 flush 都把空数组写回磁盘 → 空状态被固化 → **永久丢失**。
			//   事故（日志 20260912T145937）：sessions.json 变空后重启，聊天框读到
			//   「0 sessions」→ 新建空会话 → 用户看到历史会话全部消失；而会话文件其实
			//   还在 sessions/ 目录里（SessionHistoryView 扫目录仍列得出）。
			//   现在：缺失 / 空 / 损坏 一律尝试从目录重建。
			if (text.trim().length === 0) {
				return await this._recoverSessionIndexFromDir(agentId, 'empty');
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
			// ★ JSON 损坏（半截写入等）同样走重建，而不是返回空索引。
			return await this._recoverSessionIndexFromDir(agentId, 'corrupt');
		}
	}

	/**
	 * ★ 2026-09-12：索引 缺失/为空/损坏 时的**自愈** —— 从 `sessions/` 目录重建。
	 *
	 * **为何需要**：`getOrCreateActiveSession` 只信任 `sessions.json`，而
	 * `SessionHistoryView._discoverAgentIds` 是**扫目录**的。索引一丢，聊天框就认为
	 * 「无会话」并新建空会话，历史列表却仍列得出会话 —— 用户看到「聊天框空白 / 历史消失」。
	 * 会话文件本身通常还在（丢的只是索引），所以重建即可**全量恢复**。
	 *
	 * 代价可控：只在索引异常时触发（正常路径**不**扫目录）；重建结果立即写回，
	 * 之后走正常路径。
	 *
	 * `messageCount` 置 0 而不读每个会话文件 —— 避免为几十 MB 的历史付解析成本；
	 * 该会话下次 append 时由 `_updateSessionIndex` 刷新为真实值。名称同理无法恢复
	 * （名称只存在于索引里），用日期兜底并保留原始 id。
	 */
	private async _recoverSessionIndexFromDir(
		agentId: string,
		cause: 'missing' | 'empty' | 'corrupt',
	): Promise<AgentSessionMeta[]> {
		const rebuilt: AgentSessionMeta[] = [];
		try {
			const paths = await this._resolveAgentPaths(agentId);
			if (await this.fileService.exists(paths.sessionsDirUri)) {
				const stat = await this.fileService.resolve(paths.sessionsDirUri, { resolveMetadata: true });
				for (const f of stat.children ?? []) {
					if (f.isDirectory || !f.name.endsWith('.json')) { continue; }
					const id = f.name.slice(0, -'.json'.length);
					// 只认会话文件（sessionId 形如 sess_xxx），排除目录里的杂项 json。
					if (!id.startsWith('sess_')) { continue; }
					const d = f.mtime ? new Date(f.mtime) : new Date();
					const ts = d.toISOString();
					rebuilt.push({ id, name: `Session ${d.toLocaleString()}`, createdAt: ts, updatedAt: ts, messageCount: 0 });
				}
			}
		} catch (err) {
			this.logService.warn(`[AgentChatService] _recoverSessionIndexFromDir(${agentId}) failed:`, err);
			return [];
		}
		if (rebuilt.length === 0) { return []; }
		this.logService.warn(
			`[AgentChatService] Session index ${cause} for ${agentId} — rebuilt ${rebuilt.length} ` +
			`entry(ies) from session files (history preserved; names/messageCount reset until next append).`,
		);
		// 写回：让后续读取走正常路径，并让磁盘索引恢复一致。
		void this._writeSessionIndexQueued(agentId, rebuilt).catch(() => { });
		return rebuilt;
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
			// 逻辑抽到 `common/atomicWrite.ts`（原先只有这一处记得做原子写，别处都漏了）。
			await writeFileAtomicSafe(this.fileService, paths.indexUri, content);
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
			// 防抖落盘失败绝不能变成 unhandled rejection —— 否则 VS Code 会在
			// LLM 流式输出期间弹出右下角系统通知（错误堆栈），用户感知为
			// 「llm没结束就弹系统消息框」。吞掉错误，dirty 标记保留，
			// 下次 append 会重新调度落盘。与 dispose 路径 L2418 保持一致。
			void this.flushSessionIndex(agentId).catch(() => { });
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
		// ★ 2026-09-11：改用**带硬超时**的写盘。超时必须发生在**链上的 promise 内**
		// （而非仅 await 端）——否则单次 writeFile 挂起会让 `prev` 永不 settle，
		// 队列里所有后续写永久排队（运行期 index 更新整体停摆）。
		const run = prev.catch(() => { }).then(() => this._writeSessionIndexWithTimeout(agentId, snapshot));
		this._sessionIndexWriteQueue.set(agentId, run);
		try {
			await run;
		} finally {
			if (this._sessionIndexWriteQueue.get(agentId) === run) {
				this._sessionIndexWriteQueue.delete(agentId);
			}
		}
	}

	/** 单次 index 写盘的硬超时（2026-09-11）。超时只放弃等待，不 reject。 */
	private static readonly SESSION_INDEX_WRITE_TIMEOUT_MS = 5_000;

	/**
	 * 带硬超时的写盘（2026-09-11）。
	 *
	 * 为什么需要：`_writeSessionIndex` 的 try/catch 只能兜**异常**，兜不住
	 * **挂起**（shutdown 半销毁、磁盘/杀毒锁、网络盘 —— writeFile 可能永不
	 * resolve）。而本方法处于 per-agent 串行队列的链上，一旦挂起，队列里
	 * 后续所有写入永久排队（不止影响关闭：运行期 messageCount/updatedAt 更新
	 * 全部停摆，index 静默陈旧）。
	 *
	 * 超时语义（务实取舍）：
	 *  - 只放弃**等待**，不取消底层写（JS 无法强杀 in-flight IO）；迟到的写仍可能
	 *    落盘 —— 理论上存在「旧快照晚到覆盖新快照」的窗口，但受影响字段
	 *    （messageCount/updatedAt）由下一次 flush 自愈，且顺序错乱概率远低于
	 *    「队列永久死锁」的代价。
	 *  - 超时**必须 resolve**（不能 reject）：队列 `prev.catch().then()` 依赖
	 *    settle 才能推进，reject 虽也被 catch 但会多打一条错误日志、语义上也
	 *    不该把「慢」当「失败」。
	 */
	private async _writeSessionIndexWithTimeout(agentId: string, index: AgentSessionMeta[]): Promise<void> {
		const WRITE = 'write';
		const TIMEOUT = 'timeout';
		const t0 = Date.now();
		const winner = await Promise.race([
			this._writeSessionIndex(agentId, index).then(() => WRITE),
			new Promise<string>(resolve => setTimeout(() => resolve(TIMEOUT), AgentChatService.SESSION_INDEX_WRITE_TIMEOUT_MS)),
		]);
		if (winner === TIMEOUT) {
			this.logService.warn(
				`[AgentChatService] session index write TIMEOUT after ${AgentChatService.SESSION_INDEX_WRITE_TIMEOUT_MS}ms ` +
				`(agent=${agentId}) — queue slot released so later writes are not blocked; the in-flight write may still land late`
			);
		} else if (Date.now() - t0 > 2000) {
			// 慢但未超时：留痕便于排查磁盘性能问题（正常应 <100ms）。
			this.logService.info(`[AgentChatService] session index write slow: ${Date.now() - t0}ms (agent=${agentId})`);
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
		// ★ P0-1（2026-09-21）：**追加**这一条（O(1) 增量写 ✓），不再整会话重写 ✗。
		//   messages 数组早已在内存里更新（上面 push/replace ✓）⇒ 只把**变更的那条**落盘 ✓。
		this._appendToSessionLog(
			agentId,
			message.agentSessionId,
			[message],
		).catch((err) =>
			this.logService.error(
				"[AgentChatService] Session log append failed:",
				err,
			),
		);
	}

	/**
	 * 批量追加多条消息（2026-09-11）—— 把 N 次全量落盘合并为 1 次。
	 *
	 * 为什么需要（真实事故，日志 20260911T193945）：
	 * `appendMessage` **每次**调用都做三件全量 IO ——
	 *   ① `_persistGlobalHistory()`：序列化 `_historyCache` 里的**所有会话**；
	 *   ② `_persistToSessionFile()`：序列化**整个会话**；
	 *   ③ `_updateSessionIndex()`；
	 * 且 ①② 都用 `JSON.stringify(..., null, 2)`（**带缩进**，体积更大）。
	 *
	 * 而 `sendMessage` 的 finalization 原本是**逐条** `await appendMessage(...)`：
	 * 一个 62 轮迭代的 turn（`iters=62 calls=65`）会产生 62 条 assistant 消息
	 * → **62 次全量序列化 + 写盘** → 渲染进程被同步阻塞到日志停滞 2.5 分钟以上
	 * （用户表现为「app 卡死」；日志停在 `starting finalization`，
	 * `Persisted N assistant turn message(s)` 从未出现）。
	 *
	 * 本方法把 N 条合并为**一次** cache 变更 + **一次**落盘，语义与逐条调用一致：
	 *  - 保持顺序（push 顺序 = `builtMessages` 顺序 = 因果顺序）；
	 *  - 末尾同 id 仍做 REPLACE 而非 push（与 `appendMessage` 的流式去重一致）；
	 *  - 跨会话隔离守卫照旧（无 `agentSessionId` 的非 system 消息丢弃并告警）；
	 *  - `MemSnap` 诊断从 N 条合并为 1 条（顺带消除日志风暴）。
	 */
	async appendMessagesBatch(agentId: string, msgs: readonly ChatMessage[]): Promise<void> {
		if (msgs.length === 0) {
			return;
		}
		await this._ensureHistoryLoaded();

		// 按 sessionId 分组：不同会话必须各自落盘（实际绝大多数只有一个分组）。
		const bySession = new Map<string, ChatMessage[]>();
		let dropped = 0;
		for (const m of msgs) {
			if (!m.agentSessionId && m.role !== 'system') {
				dropped++;
				continue;
			}
			const k = m.agentSessionId ?? '';
			const bucket = bySession.get(k);
			if (bucket) {
				bucket.push(m);
			} else {
				bySession.set(k, [m]);
			}
		}
		if (dropped > 0) {
			this.logService.warn(
				`[AgentChatService] appendMessagesBatch: dropped ${dropped} message(s) without agentSessionId for ${agentId} (cross-session leakage guard)`,
			);
		}
		if (bySession.size === 0) {
			// 全部被丢弃 → **不产生任何写盘**（含全局历史）。
			// 空写同样是全量序列化 + 落盘，白白阻塞渲染进程。
			return;
		}

		let totalBytes = 0;
		for (const [sid, batch] of bySession) {
			const key = this._cacheKey(agentId, sid || undefined);
			let messages = this._historyCache.get(key);
			if (!messages) {
				messages = [];
				this._historyCache.set(key, messages);
				this._touchBucket(key);
				await this._evictIfNeeded();
			} else {
				this._touchBucket(key);
			}
			for (const m of batch) {
				const tail = messages[messages.length - 1];
				if (tail && tail.id === m.id) {
					messages[messages.length - 1] = m;
				} else {
					messages.push(m);
				}
				totalBytes += AgentChatService._estimateMessageBytes(m);
			}
			// ★ P0-1：每个会话只**追加一次**（原逐条路径会执行 batch.length 次；
			//   且追加的是**本批新消息** `batch` ✓ —— 不再是整个 `messages` ✗，
			//   写盘量与批次大小成正比、与会话长度**无关** ✓✓）。
			this._appendToSessionLog(agentId, sid || undefined, batch).catch((err) =>
				this.logService.error(
					"[AgentChatService] Session log append failed:",
					err,
				),
			);
		}

		// ★ 全局历史只写一次（原逐条路径会执行 msgs.length 次）。
		this._persistGlobalHistory().catch((err) =>
			this.logService.error("[AgentChatService] Global persist failed:", err),
		);

		this._logMemSnapshot('append-batch', {
			agentId,
			sessionId: msgs[0]?.agentSessionId,
			role: msgs[0]?.role,
			msgBytes: totalBytes,
		});

		// ★ 2026-09-12（P1 内存）：活跃桶超软上限 → 中段压缩（详见方法注释）。
		//   fire-and-forget：内存治理不应阻塞落盘主路径；内部自带时间节流与超限告警。
		for (const [sid] of bySession) {
			void this._compactActiveBucketIfNeeded(agentId, sid || undefined);
		}
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
		// ★ P0-1：把**改后的整条消息**追加进日志（重放按 id 覆盖 ⇒ 就地更新可复现 ✓）。
		//   该方法被工作流 trace delta 高频调用（每次都 mutate 同一条 assistant 消息 ✓）
		//   ⇒ 日志里同一 id 会有多条覆盖条目：重放结果仍是「最后一条胜出」✓，
		//   且条数由压缩阈值（SESSION_LOG_COMPACT_AFTER）兜住 ✓。
		await this._appendToSessionLog(agentId, sessionId, [messages[idx]]);
	}

	// ─── Public: getHistory / clearHistory ──────────────────────────────────

	/**
	 * ★ P1-5（2026-09-21）：**按游标读取会话事件**（增量 ✓）。
	 *
	 * 用途（跨进程/跨窗口消费的**唯一入口** ✓ —— 不再依赖进程内内存共享 ✓）：
	 *   · 第二个窗口/面板"跟上"正在跑的会话 ✓；
	 *   · headless 观察（`npm run session:tail` ✓）；
	 *   · 确定性回放测试（按批次断言增量 ✓）。
	 *
	 * ⚠ 收到 `reset` 事件（屏障 / 日志被压缩重写 ✓）时的正确动作 = **重新 `getHistory`**
	 * ——它会合并**快照** ✓；只按事件折叠是拿不到快照内容的 ✗。
	 * 游标语义、压缩安全与半行处理详见 `common/sessionEventStream.ts` 头注释 ✓。
	 */
	async readSessionEvents(
		agentId: string,
		sessionId: string,
		cursor?: ISessionEventCursor,
	): Promise<IReadSessionEventsResult> {
		const paths = await this._resolveAgentPaths(agentId);
		const logUri = this._sessionLogUri(paths.sessionsDirUri, sessionId);
		let text = '';
		try {
			if (await this.fileService.exists(logUri)) {
				text = (await this.fileService.readFile(logUri)).value.toString();
			}
		} catch (err) {
			// 读不到（刚被压缩删除 / 权限 ✗）⇒ 当作空日志 ✓：消费方会得到"无新事件"，
			// 而不是异常中断 —— 跟随型消费方不应因一次读失败而退出 ✗。
			this.logService.warn(
				`[AgentChatService] readSessionEvents: session log unreadable for ${agentId}::${sessionId}: ` +
				`${err instanceof Error ? err.message : err}`,
			);
		}
		return readEventsFromLog(text, cursor);
	}

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

		// ── 合并「中断草稿」（2026-09-06）──
		// 关闭 app 时若流式输出未结束，pane 只写了一个**小 draft 文件**（见
		// saveInterruptedDraft），不重写整个 session 历史 → 关闭不被阻塞。
		// 此处在加载历史时消费它：补进返回列表（用户立即可见）+ 异步写回 session
		// 文件（持久化）。消费即删除，保证只合并一次。
		if (sessionId) {
			// ★★ 2026-09-20 活跃流守卫（用户报「LLM 回复被拆成两个气泡」取证修复）：
			//   journal 草稿在**流式进行中**每 ~2s 被重写（nativeChatEditorPane
			//   `_journalStreamingDraft`）。无守卫时，流式中途的任何 getHistory
			//   （sendMessage 内部加载历史 / sessionHistoryView / pane 刷新）都会把
			//   「活草稿」当崩溃遗物消费并 appendMessage **永久落盘** ⇒ 重复「已中断」
			//   气泡（实证 sess_mu6wuptt_yywe05 idx 671：草稿 79 字 == 同回合前两条
			//   iteration 消息文本拼接，逐字相等）。
			//   活跃流期间跳过消费：草稿留在盘上 —— 流正常结束由 pane 清除；进程真崩溃
			//   ⇒ 重启后 `_activeStreams` 为空，下次 getHistory 照常消费 ✓。
			if (this._isBucketOpen(key)) {
				// 流还活着：草稿是「正在写」的 journal，不是遗物。
			} else {
				const draftMsg = await this._consumeInterruptedDraft(agentId, sessionId);
				if (draftMsg) {
					// ★ 2026-09-20 去重：回合**正常完成**后草稿也可能因 clear 竞态残留
					//   （实证 idx 668/669：回合落盘与草稿相差仅 66ms）。尾部连续 assistant
					//   消息（同回合 per-iteration 组）拼接内容已包含草稿文本 ⇒ 早已正式
					//   落盘 ⇒ 丢弃（文件已被 _consumeInterruptedDraft 删除，天然不重复）。
					// ★★ 2026-09-23 加固（用户报「一条回答被拆成 2 段」✓ DOM 取证 ✓）：
					//   判据抽到 `common/interruptedDraftGuard.ts`（纯函数 ✓ 可单测 ✓）——
					//   旧守卫的三个漏口见该文件头注 ✓。方向保守：**只放宽"丢弃"，不放宽"保留"** ✓✓。
					if (isDraftAlreadyPersisted(messages, draftMsg.content)) {
						this.logService.info(
							`[AgentChatService] getHistory: skipped stale interrupted draft ` +
							`(${draftMsg.content.length} chars) for ${key} — content already persisted by completed turn`,
						);
					} else {
						// ★ 2026-09-23：保留路径**也落一条日志** —— 下次再漏 ⇒ 用 draftHead 直接对照 ✓
						this.logService.info(
							`[AgentChatService] getHistory: kept interrupted draft (NOT covered by history) ` +
							`for ${key} — draftHead=${JSON.stringify(normDraftCompareText(draftMsg.content).slice(0, 60))}`
						);
						messages = [...(messages || []), draftMsg];
						this._historyCache.set(key, messages);
						void this.appendMessage(agentId, draftMsg).catch(err =>
							this.logService.error('[AgentChatService] Failed to persist recovered interrupted draft:', err),
						);
					}
				}
			}
		}

		// ★★ 2026-09-23 读取期兜底清洗（用户报「一条回答被拆成 2 段」✓ 二次修复 ✓）：
		//   上面的守卫只挡**新**注入 ✗ —— 但已落盘的 `metadata.streamInterrupted` 消息
		//   （中断快照 ✓ 之前漏进来并已 appendMessage 持久化 ✗）现在是**普通历史消息** ✗
		//   ⇒ 每次重开都会再渲染 ✗✓。此处用同一套判据在**读取时**把"已被其它 assistant
		//   消息覆盖"的旧中断快照滤掉 ✓（不改盘 ✓ 只影响返回列表 ⇒ UI 与模型上下文同时受益 ✓✓）。
		//
		// ★★★ 2026-09-23 逐条判定日志（用户报"洗了还在" ✗✓ —— DOM 侧已证明判据该覆盖 ✓
		//   ⇒ 那只能是**服务里看到的输入与 DOM 不同** ✗ ⇒ 必须把判定时刻的输入落出来 ✗✓
		//   —— 只在没有中断快照时零噪音 ✓）：
		const _preDropDrafts = (messages || []).filter(m => (m.metadata as { streamInterrupted?: boolean } | undefined)?.streamInterrupted === true);
		messages = dropCoveredInterruptedDrafts(messages || []);
		if (_preDropDrafts.length > 0) {
			const _keptIds = new Set(messages.map(m => m.id));
			for (const m of _preDropDrafts) {
				this.logService.info(
					`[AgentChatService] getHistory: interrupted draft ${m.id} → ` +
					`${_keptIds.has(m.id) ? 'KEPT ✗ (not covered by history)' : 'dropped ✓'} ` +
					`head=${JSON.stringify(normDraftCompareText(messageVisibleText(m)).slice(0, 60))} ` +
					`parts=${Array.isArray(m.parts) ? m.parts.length : '-'} contentLen=${(m.content ?? '').length}`
				);
			}
		}

		// ★ 历史空消息过滤（2026-09-11 用户反馈「重启后多出一条空白消息」）：
		//   已落盘的历史不受新「空回合守卫」影响（那只管新消息）——这里兜底清理：
		//   无文本/无 parts/无任何卡片字段的 assistant 消息（工作流工具回合的空产出，
		//   如 `content:"" parts:[] progress:[生成中 97%]`）不参与渲染。
		//   注意必须**保留**携带 workflowExecutions / askUsers / collectVariables 的
		//   卡片消息（它们同样可能 content 为空，但有实际渲染内容）。
		const beforeFilter = (messages || []).length;
		messages = (messages || []).filter(m => {
			if (m.role !== 'assistant') { return true; }
			if (typeof m.content === 'string' && m.content.trim()) { return true; }
			const anyMsg = m as unknown as Record<string, unknown>;
			// 有实际渲染载体的（卡片/工具/思考/交互）一律保留。
			if (Array.isArray(anyMsg['parts']) && (anyMsg['parts'] as unknown[]).length > 0) { return true; }
			if (Array.isArray(anyMsg['toolCalls']) && (anyMsg['toolCalls'] as unknown[]).length > 0) { return true; }
			if (anyMsg['thinking']) { return true; }
			for (const k of ['confirmation', 'questions', 'todos', 'collectVariables', 'workflowExecutions', 'askUsers', 'workflowEvents', 'references', 'subAgents']) {
				const v = anyMsg[k];
				if (v === undefined || v === null) { continue; }
				if (Array.isArray(v) ? v.length > 0 : typeof v === 'object' ? Object.keys(v as object).length > 0 : !!v) {
					return true;
				}
			}
			// 无任何可见内容（如只有 progress 的工作流空回合）→ 过滤。
			return false;
		});
		const droppedInvisible = beforeFilter - (messages || []).length;

		this.logService.info(
			`[AgentChatService] getHistory: ${(messages || []).length} msgs for ${key}` +
			(droppedInvisible > 0 ? ` (dropped ${droppedInvisible} invisible assistant msg)` : ''),
		);
		return messages || [];
	}

	// ─── 中断草稿（2026-09-06）：关闭时写小文件，加载时消费 ──────────────

	private async _getDraftUri(agentId: string, sessionId: string): Promise<URI> {
		const { sessionsDirUri } = await this._resolveAgentPaths(agentId);
		return URI.joinPath(sessionsDirUri, `${sessionId}.draft.json`);
	}

	async saveInterruptedDraft(agentId: string, sessionId: string, content: string, opts?: { quiet?: boolean }): Promise<void> {
		try {
			const uri = await this._getDraftUri(agentId, sessionId);
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify({
				content,
				savedAt: Date.now(),
			})));
			// ★ 2026-09-19：journal 模式（流式期间 ~2s 一笔 ✓）必须静默，否则日志刷屏 ✗；
			//   关停兜底（onWillShutdown ✓）保持 info（它证明"关闭时真的救了内容" ✓）。
			if (!opts?.quiet) {
				this.logService.info(
					`[AgentChatService] saved interrupted draft (${content.length} chars) for ${agentId}/${sessionId}`,
				);
			}
		} catch (err) {
			this.logService.error('[AgentChatService] Failed to save interrupted draft:', err);
		}
	}

	/**
	 * ★★ 2026-09-19：流式草稿的**正常完成清理** ✓。
	 * 流式期间有 journal 定期写草稿（崩溃保命 ✓ —— 对齐 Cline 的 write-through /
	 * OpenCode 的按 part 落盘 ✓）；若 loop **正常结束**（内容已由 finalization 落盘 ✓），
	 * 草稿必须删除 —— 否则下次 getHistory 会把**已落盘的内容**再注入一遍「已中断」消息 ✗。
	 */
	async clearInterruptedDraft(agentId: string, sessionId: string): Promise<void> {
		try {
			const uri = await this._getDraftUri(agentId, sessionId);
			if (await this.fileService.exists(uri)) { await this.fileService.del(uri); }
		} catch { /* 删不掉 → 下次消费时按一次性草稿处理（最坏多一条"已中断"消息，可接受 ✓） */ }
	}

	// ⚠ 2026-09-23：草稿去重判定已抽到 `../common/interruptedDraftGuard.js`（纯函数 ✓ 可单测 ✓）。
	//   旧实现（本处原 `_isDraftAlreadyPersisted`）有三个漏口 ✗：① 只拼 `content`（stage-E 正文
	//   可能只在 `parts` ✗）；② 字符级 `includes`（草稿=流式原文 vs 落盘=清洗后 ✓ ⇒ 空白失配 ✗）；
	//   ③ 循环上界 `tail.length < draft.length`（草稿更长 ⇒ 凑不满 ⇒ 必 false ✗）。
	//   —— 用户报「一条回答被拆成 2 段」正是它漏掉所致（`msg_…_interrupted` 与 turn 气泡并存 ✗✓）。

	/** 读取并**删除**草稿（消费一次，避免重复合并）。无草稿返回 undefined。 */
	private async _consumeInterruptedDraft(agentId: string, sessionId: string): Promise<ChatMessage | undefined> {
		try {
			const uri = await this._getDraftUri(agentId, sessionId);
			if (!(await this.fileService.exists(uri))) { return undefined; }
			const raw = (await this.fileService.readFile(uri)).value.toString();
			await this.fileService.del(uri);
			const parsed = JSON.parse(raw);
			const content = typeof parsed?.content === 'string' ? parsed.content : '';
			if (!content.trim()) { return undefined; }
			return {
				id: `msg_${Date.now()}_interrupted`,
				role: 'assistant',
				content,
				agentId,
				agentSessionId: sessionId,
				timestamp: new Date(parsed.savedAt ?? Date.now()).toISOString(),
				metadata: { streamInterrupted: true },
			};
		} catch (err) {
			this.logService.warn('[AgentChatService] Failed to consume interrupted draft:', err);
			return undefined;
		}
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
				const logUri = this._sessionLogUri(paths.sessionsDirUri, sessionId);
				if (await this.fileService.exists(fileUri)) {
					// ★ P0-1：清空 = 写**空快照**（原子 ✓）+ **删日志** ——
					//   只清快照不清日志 ⇒ 重放会把刚删掉的消息原样搬回来 ✗✓
					await writeFileAtomicSafe(this.fileService, fileUri, VSBuffer.fromString("[]"));
				}
				if (await this.fileService.exists(logUri)) {
					await this.fileService.del(logUri);
				}
				this._sessionLogAppends.set(this._cacheKey(agentId, sessionId), 0);
				this._sessionLogBytes.set(this._cacheKey(agentId, sessionId), 0);
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
				// ★ P0-1：整段改写 ⇒ 走**快照路径**（原子写 ✓ + 屏障 ✓ + 截断日志 ✓）——
				//   否则旧日志会在下次加载时把被替换掉的消息重放回来 ✗✓。
				//   注：不吞异常（调用方依赖 throw ✓，与改造前一致 ✓）。
				await this._withSessionLogLock(key, async () => {
					await this._writeSessionSnapshotLocked(agentId, sessionId, paths.sessionsDirUri, messages);
				});
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

	/**
	 * ★★★ 2026-09-21：`priorMessages` 为空时的**决定性取证** ✓（三种成因必须分开 ✗✓）。
	 *
	 * 背景（用户实测：「切换模型后 LLM 对上下文一无所知」✓）：`priorMessages` 是模型能看到
	 * 的全部历史 ✗ —— 它为 0 时模型只剩当前 user 消息 ✓，但既有日志只有一行 `priorMsgs=0` ✗，
	 * **无法区分**下面三种成因，导致排查只能猜 ✗：
	 *   ① `history.length === 0` 且盘上也空 ⇒ 本会话确实还没有历史（正常 ✓）；
	 *   ② `history.length > 0` 但 prior 为 0 ⇒ 历史**被过滤/裁剪光了** ✗（压缩边界 `sliceAtCompactionBoundary`
	 *      或污染过滤 `_isContaminated` ⇒ 前者通常是主因）；
	 *   ③ `history.length === 0` 但**盘上有内容**（快照或日志非空）⇒ **key 不匹配** ✗✗
	 *      —— 本次用的 `agentSessionId` 取到的桶是空的，而真实历史挂在别的 session 上 ✗
	 *      （这正是"UI 里明明有对话、模型却失忆"的最可能形态 ✓）。
	 *
	 * 只在**为空**时调用（低频 ✓）+ 内部全 try/catch ✓ ⇒ 绝不影响发送主路径 ✓。
	 */
	/**
	 * ★ 2026-09-22：实现已**收口**到 `contextMaintenance.ts` 的 `diagnoseEmptyPriorMessagesImpl` ✓
	 * （此处曾是第二份拷贝，漏掉了同日早些时候加在 ContextMaintenance 拷贝上的屏障行排除 ⇒
	 *  双份漂移的实证 ✗）。本方法只剩**适配器**：把 service 的路径学/IO 包成最小依赖面 ✓。
	 *
	 * @param historyLength **本轮之前**的历史条数（调用方须先剔除当前 user 消息 ✓）
	 * @param currentMessage 本轮当前 user 消息原文 —— 探针须排除它
	 *   （fire-and-forget 落盘与磁盘探针存在竞态：jsonl 里那 1 行可能就是它自己 ✗✓）
	 */
	private async _diagnoseEmptyPriorMessages(
		agentId: string,
		sessionId: string | undefined,
		historyLength: number,
		currentMessage?: string,
	): Promise<void> {
		return diagnoseEmptyPriorMessagesImpl({
			logService: this.logService,
			fileService: this.fileService,
			resolveAgentPaths: a => this._resolveAgentPaths(a),
			sessionFileUri: (dir, sid) => this._sessionFileUri(dir, sid),
			sessionLogUri: (dir, sid) => this._sessionLogUri(dir, sid),
			cacheKey: (a, sid) => this._cacheKey(a, sid),
		}, agentId, sessionId, historyLength, currentMessage);
	}

	/**
	 * ★★★ 2026-09-21：构造**压缩边界消息**（两条 fail-safe 的落点 ✓）。
	 *
	 * ── 真机取证（用户报「切换模型后 LLM 对上下文一无所知」✓）──────────────────────
	 * 现场：`sess_ms5kriv8_0j6atj` ✓ 含 1 条边界，其摘要把 `## Active Task` 与 `## Goal`
	 * **都写成「无」** ✗，`metadata.tokensSaved = **-73**`（压缩反而变大 ✗）。而模型能看到的
	 * 边界之前的内容**只有这条边界** ✗（`sliceAtCompactionBoundary` 丢弃边界之前全部消息 ✓）
	 * ⇒ 用户接着说「执行」⇒ 模型回答「当前对话里没有待执行的任务指令」✓✓ 与截图逐字吻合 ✓。
	 *
	 * ── 两条 fail-safe（本方法 + 调用方 guard ✓）──────────────────────────────────
	 * ① **原文兜底**：边界里追加**最近 N 条 user 消息原文** ✓ —— 摘要质量再差，也不会丢
	 *    "用户到底要什么" ✗（此前完全依赖摘要质量 ⇒ 摘要一失手，任务就消失了 ✗✓）；
	 * ② **无收益就不插**（调用方 `tokensSaved > 0` guard ✓）：压缩没省下 token 时，
	 *    边界只有"销毁上下文"这一种效果 ✗✓。
	 * ③ **摘要信息量指纹**（2026-09-21 补 ✓）：`metadata.summaryChars` 记录**纯摘要**长度，
	 *    供回放侧 `isValidCompactionBoundary` 判"摘要饥饿"⇒ 不切片 ⇒ 不丢历史 ✗✓。
	 *    ★ 起因：`tokensSaved > 0` 是**错误的成功判据** —— 毁内容最容易省 token ✓。
	 *    真机取证（日志 `vscode-app-1789994132110.log`）：切模型后窗口塌到 64k ⇒ 强制压缩
	 *    走 RETRIEVAL 模式 `tokens=129`（153 条消息只换回 129 token），`saved=24836 > 0`
	 *    顺利通过 ② 的 guard ⇒ 边界照插 ⇒ 模型永久失忆、转去 `session_search` 抓别的任务。
	 */
	private _buildCompactionBoundaryMessage(
		agentId: string,
		agentSessionId: string | undefined,
		pending: { originalCount: number; compressedCount: number; tokensSaved: number; summary: string; summaryChars?: number },
		currentMessage: string | undefined,
	): ChatMessage {
		// ① 最近 2 条 user 原文（排除"当前这条"以避免与 driver 追加的当前消息重复 ✓）
		const recent: string[] = [];
		try {
			const cache = this._historyCache.get(this._cacheKey(agentId, agentSessionId)) ?? [];
			for (let i = cache.length - 1; i >= 0 && recent.length < 2; i--) {
				const m = cache[i];
				if (m.role !== 'user') { continue; }
				const text = (m.content ?? '').trim();
				if (!text) { continue; }
				if (currentMessage !== undefined && text === currentMessage.trim()) { continue; }
				recent.unshift(text);
			}
		} catch { /* 取不到原文不影响主流程 ✓ */ }
		const tail = recent.length > 0
			? `\n\n---\n**用户最近的指令（原文保留 —— 摘要可能失真，以下为准确来源 ✗）**：\n` +
				recent.map((t, i) => `${i + 1}. ${t.length > 400 ? t.slice(0, 400) + '…' : t}`).join('\n')
			: '';
		return {
			id: `msg_compaction_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
			role: 'assistant',
			content: `[上下文压缩] 此前的对话历史（${pending.originalCount} 条消息）已压缩为以下摘要：\n\n${pending.summary}${tail}`,
			agentId,
			agentSessionId,
			timestamp: new Date().toISOString(),
			metadata: {
				type: COMPACTION_METADATA_TYPE,
				originalCount: pending.originalCount,
				compressedCount: pending.compressedCount,
				tokensSaved: pending.tokensSaved,
				// ③ 摘要信息量指纹（2026-09-21）：`historyCompaction.isValidCompactionBoundary`
				// 用它判边界是否可信（摘要饥饿 ⇒ 不切片 ⇒ 不丢历史）。记录**核心摘要**长度
				// —— 不含固定前缀、"最近指令原文"尾部、以及确定性追加的文件清单
				// （它们都会把空壳/饥饿摘要撑过门槛 ✗）。优先用压缩侧透传的精确值。
				summaryChars: pending.summaryChars ?? pending.summary.trim().length,
			},
		};
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
		// ★ 2026-09-19：顺带启动周期监护 ✓（幂等 ✓）—— 长会话内存涨势从此**过程可见** ✓
		this._startMemWatch();

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
		//
		// ── 2026-08-29 升级为「条件式 + 可观测」（对齐 void 双保险设计）──
		// void 在 chatThreadService._addUserMessageAndStreamResponse:1239 用
		// `if (this.streamState[threadId]?.isRunning) await this.abortRunning(threadId)`
		// ——在 service 层再兜一次，而不是无条件 abort。好处：
		//  ① 只有确实存在遗留流时才取消，避免对「干净状态」做无意义的 abort
		//     （无条件 abort 会误伤外部发送路径：看板任务 / workflow / webview
		//      直接调 sendMessage 的场景，它们的 controller 也可能登记在同一 key）；
		//  ② 打日志，使「编辑重发时是否真的掐掉了旧流」可观测——这正是
		//     「点了发送没反应」类问题最难排查的一环（残留流吞掉新请求）。
		if (this._isBucketOpen(streamKey)) {
			this.logService.warn(
				`[AgentChatService] sendMessage: STALE stream on key=${streamKey} — aborting before new send ` +
				`(hasStream=${this._activeStreams.has(streamKey)}, hasOnDelta=${this._activeOnDeltas.has(streamKey)}). ` +
				`This is the service-layer safety net for edit-resend / reentrant sends.`
			);
			this.cancelStream(agentId, options.agentSessionId);
			this._gracefulStopRequested.delete(streamKey);	// ★ 2026-09-19：新回合 ⇒ 清掉上一回合的优雅停止标记（防泄漏 ✓）
		}

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
		/**
		 * ★ 2026-09-21：**最近一次** usage delta 的 input（= 当前 prompt 大小，**非累加**）。
		 *
		 * `usageInput` 是本 turn 全程累加消费（footer 展示用；多轮 agent loop 逐轮累加）；
		 * 上下文环需要的是「当前 prompt 多大」——两者此前共用同一个值 ⇒ 长 turn 后环暴涨
		 * （实测 1,465,040 vs 真实 prompt 80,724）⇒ 显示 100% 却永不触发压缩（压缩判定用
		 * ContextManager 的 real usage，一直远低于 140k 线）。详见 DETAIL §44。
		 *
		 * 落盘意义：重启/恢复会话时，环能用**真实占用**（而非对全部历史做字符估算）。
		 */
		let usagePromptTokens = 0;
		// ★★★ 2026-09-21（用户报「tokens tip 显示内容不全 + **重启后数据丢失**」✓）：
		// 落盘路径此前只存 input/output/total/cached/cacheWrite ✗ —— 而 **live** 路径
		//（`nativeChatEditorPane` 的 usage delta 处理 ✓）还会写 `reasoning` / `cacheMiss` /
		// `cacheHitRate` / `providerId` / `model` ✓✓ ⇒ 重启后这些富字段全丢 ✗（明细浮层随之残缺 ✓）。
		// 现按 live 路径**同款字段集**落盘 ✓（含 0 ✓ —— 零值也是真实读数 ✗）。
		let usageReasoning = 0;
		let usageProviderId: string | undefined;
		let usageModelId: string | undefined;

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
				// ★★ 2026-09-19（用户实测：重启后气泡里的代码片段 pill 丢失 ✗✓）：
				// 附件此前只透传给 LLM（options.attachments ✓）却**不落盘** ⇒ 重启后丢 ✗。
				// 只持久化**可恢复**的附件：文本片段/日志/文件引用（data 小 ✓）；
				// 图片**刻意不存**（base64 会吹大会话文件 ✗，且没 data 恢复出来也是坏 pill ✗
				// —— 维持既有行为：图片重启后本就不恢复 ✓）。
				const persistableAttachments = options.attachments?.filter(a => a.type !== 'image');
				const userMessage: ChatMessage = {
					id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					role: 'user',
					content: message,
					agentId,
					agentSessionId: options.agentSessionId,
					timestamp: new Date().toISOString(),
					source: options.source,
					taskCard: options.taskCard,
					attachments: persistableAttachments && persistableAttachments.length > 0 ? persistableAttachments : undefined,
				};
				console.info(`[TaskPromptCard] sendMessage → appendMessage id=${userMessage.id} source=${options.source ?? 'user'} alreadyPersisted=${alreadyPersisted}`);
				this.appendMessage(agentId, userMessage).catch(err =>
					this.logService.error('[AgentChatService] Failed to persist user message:', err)
				);
				// ★ 2026-09-22：广播源统一收口到此处（此前仅 nativeChatEditorPane 本地发送路径
				//   自行广播，且用的是本地构造的临时 id，与持久化 id 不一致）。
				//   桥接（飞书/Telegram）、看板、workflow 等外部发送路径由此获得 user 消息广播，
				//   正在显示该会话的聊天框经 onDidStreamDelta 'user_message' 即时渲染气泡。
				//   本地发送 pane 由 _localSendActiveSessionId 守卫跳过，不会重复渲染。
				try {
					this.fireUserMessageAdded(agentId, options.agentSessionId ?? '', userMessage);
				} catch (e) {
					this.logService.warn('[AgentChatService] fireUserMessageAdded failed:', e);
				}
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
				// ★★★ 2026-09-21（用户报：「切换模型后 LLM 对上下文一无所知」✓）：
				// `priorMessages` 为空 ⇒ 模型**只剩当前这一条 user 消息** ✗（症状就是模型
				// 回"当前对话里没有待执行的任务指令"✓）。而这一路在日志里只留下一行
				// `priorMsgs=0` ✗ —— 极易被淹没、且**无法区分三种完全不同的原因** ✗✓：
				//   ① 会话真的还没有历史（正常 ✓）；② 历史存在但被**过滤/裁剪**光了（✗ 压缩边界/污染过滤）；
				//   ③ 盘上有历史但本次 `agentSessionId` 取到的桶是空的（**key 不匹配** ✗✗ 最严重）。
				// 仅在为空时（低频 ✓）做一次磁盘探针，把三者分开 ✓ —— 附带把 key 与长度都打出来 ✓。
				if (priorMessages.length === 0) {
					// ★ 2026-09-22 第二轮修正（真机 `sess_…` 首条消息误报「key 不匹配」）：
					//   ① 传 **trimmed.length**（剔除当前 user 之后）—— 此前传 history.length，
					//      新会话首条的形态是 history=1（刚写入的当前消息）→ pop → prior=0，
					//      会被误报成 ②「历史被过滤/裁剪光」✗；
					//   ② 传 **message 原文** —— 探针须排除它：appendMessage 是 fire-and-forget，
					//      磁盘探针可能跑在"本条消息已写进 jsonl"之后 ⇒ logLines=1 就是它自己 ✗✓。
					void this._diagnoseEmptyPriorMessages(agentId, options.agentSessionId, trimmed.length, message);
				}
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
				// ★★★ 2026-09-19（主流做法 ✓）：优雅停止 —— 用户点过 Stop ⇒ 不再立即切 ✓；
				//   到 `assistant_turn` 边界（= 当前 iteration 的权威文本已确定 ✓）才 abort ✓。
				//   ⚠ 这里**不 break**：让本条 delta 走完快照 ✓（`assistant_turn` 的处理在后面 ✓），
				//     下一轮迭代会被上面的 `controller.signal.aborted` 挡下 ⇒ 砍掉的是**后续** iteration ✗，
				//     当前 iteration 的文本（含 tokens/credit ✓）照常到达并落盘 ✓✓。
				if (this._gracefulStopRequested.has(streamKey) && (delta as any).type === 'assistant_turn') {
					this.logService.info(
						`[AgentChatService] ⏹ 优雅停止：已到 assistant_turn 边界 ⇒ 现在中止（当前 iteration 已跑完 ✓）`,
					);
					controller.abort();
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
						// 核心摘要字符数（2026-09-21）：由 compressContext 产出、emit 透传；
						// 摘要饥饿判据只认它（不含确定性追加的文件清单）。
						summaryChars: (delta as any).compressionSummaryChars,
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
					// ★ 2026-09-21：同时记录**最近一次**的 input（= 当前上下文占用）——只覆盖、不累加。
					if (typeof delta.usage.inputTokens === 'number') { usagePromptTokens = delta.usage.inputTokens; }
					if (typeof delta.usage.outputTokens === 'number') { usageOutput += delta.usage.outputTokens; }
					if (typeof delta.usage.cachedTokens === 'number') { usageCached += delta.usage.cachedTokens; }
					if (typeof delta.usage.cacheWriteTokens === 'number') { usageCacheWrite += delta.usage.cacheWriteTokens; }
					// ★ 与 live 路径对齐 ✓：推理 token（OpenAI reasoning_tokens 系 ✓）与真实命中的 provider/model ✓
					if (typeof delta.usage.reasoning === 'number') { usageReasoning += delta.usage.reasoning; }
					if (delta.usage.providerId) { usageProviderId = delta.usage.providerId; }
					if (delta.usage.modelId) { usageModelId = delta.usage.modelId; }
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
			// ★ 2026-09-19：本次 sendMessage 结束 ⇒ 清掉优雅停止标记（防泄漏到下一回合 ✗）
			this._gracefulStopRequested.delete(streamKey);

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
						// 2026-08-29（日志 1787932864271）：同步写回渲染层同义字段 `args`。
						// UI 侧 IToolCall 只声明 `args`，与执行侧的 `arguments` 是两条独立
						// 链路。流式期间 UI 靠 `tool_args` delta 累加 `args`，但该 delta 若
						// 未到达 / 未匹配到卡片（见 nativeChatEditorPane 的
						// `tool_args dropped` 告警），`args` 就恒为 '' → 卡片退化为无参数
						// 占位空卡，且因 parseToolArgsLoose('') = {} 使 card:args-arrived
						// 补齐也永不触发——故障自锁。
						// 此处补齐第二条链路：落盘对象同时携带两个字段名，渲染层任一取数
						// 路径（adaptPersistedToolCall 映射 / 卡片直接读 arguments）都能拿到
						// 参数。仅在 args 尚无值时写入，不覆盖流式期间已累加的内容。
						if (!tc.args) {
							tc.args = tc.arguments;
						}
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
			// ★★★ 2026-09-21：字段集与 **live** 路径（`nativeChatEditorPane` usage delta ✓）
			// **完全对齐** ✓ —— 否则"重启后明细浮层缺行"✗（用户实测 ✓）。要点：
			//  · `cached/cachedRead/cacheWrite/reasoning` **零值也写** ✓（零值 = 真实读数 ✗；
			//    此前 `> 0 ? : undefined` 会把它抹成"无数据" ✓ → 重启后整行消失 ✗）；
			//  · `cacheMiss` / `cacheHitRate` 是**派生量** ✓（口径与 live/UIS 一致 ✓）；
			//  · `credit` 保留"是否出现过"语义 ✓（0 与"未提供"必须区分 ✓）。
			const sharedTokenUsage = usageSeen
				? (() => {
					const input = usageInput;
					const cachedRead = usageCached;
					const cacheMiss = Math.max(0, input - cachedRead - usageCacheWrite);
					return {
						input,
						output: usageOutput,
						// Prefer the gateway-reported total_tokens when present (it may
						// account for tokens not split into input/output); otherwise derive.
						total: usageTotalReported > 0 ? usageTotalReported : usageInput + usageOutput,
						// ★ 2026-09-21：**当前上下文占用**（末次请求的 prompt 大小）——与 live 路径
						// （`nativeChatEditorPane` 采集的同名字段）同义；落盘后重启/恢复会话时
						// 上下文环能显示真实占用，不再回退到「对全部历史做字符估算」（会高估十倍以上）。
						promptTokens: usagePromptTokens,
						cached: cachedRead,
						cachedRead,
						cacheWrite: usageCacheWrite,
						cacheMiss,
						// 命中率：与 live 路径同式 ✓（百分比，一位小数展示由 UI 负责 ✓）
						cacheHitRate: input > 0 ? (cachedRead / input) * 100 : 0,
						reasoning: usageReasoning,
						credit: usageCreditSeen ? usageCredit : undefined,
						// 真实命中的 provider/model（"UI 选 A 实际用 B"场景的真相 ✓）——
						// 此前完全没落盘 ✗ ⇒ 重启后明细里的「模型」行消失 ✗✓
						providerId: usageProviderId,
						model: usageModelId,
					};
				})()
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
			if (pendingCompaction && pendingCompaction.tokensSaved > 0) {
				const boundaryMsg = this._buildCompactionBoundaryMessage(agentId, options.agentSessionId, pendingCompaction, message);
				const insertAt = Math.min(pendingCompaction.turnCount, builtMessages.length);
				builtMessages.splice(insertAt, 0, boundaryMsg);
				this.logService.info(
					`[AgentChatService][P5] Persisting compaction boundary at position ${insertAt}/${builtMessages.length} (cross-turn compression persistence, tokensSaved=${pendingCompaction.tokensSaved})`,
				);
			} else if (pendingCompaction) {
				// ★ 2026-09-21 fail-safe ②：压缩**没省下 token** 时插边界只有"销毁上下文"一个效果 ✗✓
				//（真机：tokensSaved=-73 ✗ + 摘要把任务写成"无" ⇒ 下一轮模型失忆 ✓）
				this.logService.warn(
					`[AgentChatService][P5] 跳过压缩边界：tokensSaved=${pendingCompaction.tokensSaved} ≤ 0 ` +
					`（压缩无收益 ⇒ 保留完整历史，避免边界把上下文裁没 ✗✓）`,
				);
			}

			// ★ 2026-09-11 改为**批量落盘**（原为逐条 `await appendMessage`）：
			// `appendMessage` **每次**都会全量重写（`_persistGlobalHistory` 序列化
			// **所有会话**、`_persistToSessionFile` 序列化**整个会话**，且都带
			// `null, 2` 缩进）。62 轮迭代的 turn 会触发 62 次全量序列化 + 写盘 →
			// 实测把渲染进程阻塞到日志停滞 2.5 分钟以上（用户表现为「app 卡死」；
			// 日志 20260911T193945 的 `iters=62 calls=65`，停在 `starting finalization`
			// 后再无输出，`Persisted N ...` 从未出现）。批量后为一次 cache 变更 +
			// 一次落盘，**保持顺序 = 因果顺序**，语义不变。
			await this.appendMessagesBatch(agentId, builtMessages);
			this.logService.info(
				`[AgentChatService] Persisted ${builtMessages.length} assistant turn message(s) under turnId=${turnId} (Hermes-style boundary, batched)`,
			);
				// 返回最后一条（其 content 为最终总结，供 configHtmlService 解析）
				chatMessage = builtMessages[builtMessages.length - 1];
		} else {
			// ─── 回退：无边界事件（直连模式/旧后端）持久化单条 ────────────────
			// P5: 若本回合发生过压缩（executionProvider 路径也会 yield
			// context_compacted），先把压缩边界消息单独落盘，再落盘本条 ——
			// 下一 turn 回灌从边界处重放，语义与多 turn 路径一致。
			if (pendingCompaction && pendingCompaction.tokensSaved > 0) {
				const boundaryMsg = this._buildCompactionBoundaryMessage(agentId, options.agentSessionId, pendingCompaction, message);
				this.appendMessage(agentId, boundaryMsg).catch((err) =>
					this.logService.error("[AgentChatService] Failed to persist compaction boundary message:", err),
				);
			} else if (pendingCompaction) {
				this.logService.warn(
					`[AgentChatService][P5] 跳过压缩边界（回退路径）：tokensSaved=${pendingCompaction.tokensSaved} ≤ 0（保留完整历史 ✓）`,
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

				// ★ 空回合守卫（2026-09-11 用户反馈「重启后聊天框多出一条空白消息」）：
				//   工作流工具回合的 LLM 流可能**无任何文本产出**（内容由工作流卡接管），
				//   此时 content='' + parts=[]，只有 progress（工作流进度）——落盘后重启
				//   渲染成空气泡（实测 msg_1789091041933_su9ckco：
				//   `content:"" parts:[] progress:[{id:'wf-...-progress',content:'生成中 97%'}]`）。
				//   progress 由工作流卡自行管理，独立消息无渲染价值 → 无可见内容则跳过落盘。
				const hasVisibleContent = !!(fullContent && fullContent.trim())
					|| (Array.isArray(toolCalls) && toolCalls.length > 0)
					|| !!fullThinking
					|| !!confirmation || !!questions || !!todos
					|| (Array.isArray(references) && references.length > 0)
					|| (_streamingParts && _streamingParts.length > 0);
				// ★ 2026-09-19（主流做法 ✓）：**用户取消 ⇒ 已生成内容照常落盘**（guard 已保证 ✓），
				//   但必须打上「已中断」标记 —— 否则用户分不清"完整回答"与"被截断的回答" ✗
				//   （无内容的占位分支在后面另有专门处理 ✓，这里覆盖的是**有内容**的情形 ✓）。
				if (controller.signal.aborted || this._gracefulStopRequested.has(streamKey)) {
					chatMessage.metadata = { ...(chatMessage.metadata as Record<string, unknown> | undefined ?? {}), streamInterrupted: true };
				}
				if (hasVisibleContent) {
					this.appendMessage(agentId, chatMessage).catch((err) =>
						this.logService.error(
							"[AgentChatService] Failed to persist assistant message:",
							err,
						),
					);
				} else if (controller.signal.aborted) {
					// ★★★ 2026-09-19（用户报「llm 消息丢失」真机取证 ✓）：**用户取消 + 无可见内容**
					// ⇒ 不再**静默丢弃** ✗，而是落一条**自解释的占位** ✓。
					// 证据链（`vscode-app-1789792320170.log` 同一轮 ✓）：
					//   `Stream aborted by user` → `[PartsDiag] DONE partsLen=0 isCanceled=true parts=[]`
					//   → `skip persisting empty assistant turn`（**本分支** ✓）
					//   → 而服务端同刻报 `[SSE-Diag] usage completion_tokens=1119 / usage.credit=27.2` ✗✗
					// ⇒ 用户"付了费、却连一条痕迹都没有" ✓ ⇒ 表现为「消息丢了」✓✓。
					//
					// ⚠ 为什么以 `controller.signal.aborted` 作为条件（而不是无条件落盘 ✗）：原守卫是为挡
					//   「**工作流工具回合无文本**」的空气泡 ✓ —— 那种情况**不是取消** ✓ ⇒ 只有"用户显式取消"
					//   才补占位：既消灭"无痕丢失"，又**不动**原来的空气泡防护 ✓✓。
					chatMessage.content = `⏹ 本轮已取消：未收到内容输出（期间收到 ${_deltaCount} 个事件，`
						+ `耗时约 ${Math.round((performance.now() - tStream) / 1000)}s）。`
						+ `如已计费，请对照同时刻的 [SSE-Diag] usage。`;
					// `parts` 必须同步给（UI 优先按 parts 渲染 ✓；留空会渲染成空白 ✗）—— 复用同一派生函数 ✓
					chatMessage.parts = deriveMessageParts({ role: 'assistant', content: chatMessage.content, toolCalls: undefined });
					// 复用既有约定：`metadata.streamInterrupted` ⇒ UI 会打出「已中断」标记 ✓（见 `:2216` ✓）
					chatMessage.metadata = { streamInterrupted: true };
					this.logService.warn(
						`[AgentChatService] ⚠ 已取消且无可见内容 ⇒ 落一条占位（避免"消息零痕迹"✗）：` +
						`id=${chatMessage.id} deltas=${_deltaCount} contentLen=${fullContent.length} ` +
						`thinkingLen=${fullThinking ? fullThinking.length : 0} ` +
						`toolCalls=${Array.isArray(toolCalls) ? toolCalls.length : 0} parts=${_streamingParts.length} ` +
						`elapsedMs=${Math.round(performance.now() - tStream)} —— 若同刻 usage/credit 非零 ⇒ 属"付费但无内容" ✓`,
					);
					this.appendMessage(agentId, chatMessage).catch((err) =>
						this.logService.error(
							"[AgentChatService] Failed to persist canceled placeholder message:",
							err,
						),
					);
				} else {
					// ★ 2026-09-19：级别 `info` → **`warn`** 并补上关键计数 ✓ —— 这条曾经是纯静默的：
					//   真机上"付费却没内容"只留下这一行 info ✗ ⇒ 排查时极易漏掉 ✓。
					this.logService.warn(
						`[AgentChatService] ⚠ 未落盘：本轮无可见内容（id=${chatMessage.id}、` +
						`progress=${Array.isArray(progress) ? progress.length : 0}、deltas=${_deltaCount}、` +
						`contentLen=${fullContent.length}、aborted=${controller.signal.aborted}）` +
						`—— 工作流工具回合属**正常**情况 ✓；若同时见到 usage/credit 非零 ⇒ 属"付费但无内容"，需排查 ✓`,
					);
				}
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
		// ★ 2026-09-19：停掉周期内存监护，避免宿主销毁后回调仍在跑 ✓
		if (this._memWatchTimer !== null) { window.clearInterval(this._memWatchTimer); this._memWatchTimer = null; }
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
			// ★★★ 2026-09-19（用户选择"主流做法"✓）：**优雅停止** —— 第一次点 Stop **不立即切断** ✓
			// （否则落在「服务端已产出（计费 ✓）但本地未收到」窗口时 = "付费零痕迹" ✗✗，
			//  见 `_gracefulStopRequested` 的注释 ✓）。⇒ 立标记、把决定权交给流式循环的边界处 ✓；
			// 第二次点 Stop ⇒ 立即硬中止 ✓（用户要"现在就停"的逃生口 ✓）。
			if (!this._gracefulStopRequested.has(streamKey)) {
				this._gracefulStopRequested.add(streamKey);
				this.logService.info(
					`[AgentChatService] ⏸ 优雅停止：不切断当前请求，等当前 iteration 跑完在边界处停止 ✓（再次点击 = 立即停 ✓）`,
				);
				return;
			}
			// 第二次点 Stop ⇒ 硬中止 ✓
			this._gracefulStopRequested.delete(streamKey);
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
	 * ★ 2026-09-20：该会话的名字是否由**用户手动**起的（见 {@link AgentSessionMeta.userRenamed}）。
	 *
	 * 供「首条消息自动命名」在写入前判断 —— 用户已经起过名字就不要再覆盖。
	 * 走内存权威副本（不 flush、不读盘），因为调用点是发消息热路径。
	 * 任何异常都返回 `false`（宁可自动命名照旧，也不要让首条消息因查询失败而报错）。
	 */
	async isSessionUserRenamed(agentId: string, sessionId: string): Promise<boolean> {
		try {
			const index = await this._getSessionIndexForWrite(agentId);
			return index.find((s) => s.id === sessionId)?.userRenamed === true;
		} catch {
			return false;
		}
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
		options?: { userInitiated?: boolean },
	): Promise<void> {
		const index = await this._getSessionIndexForWrite(agentId);
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			throw new Error(`Session ${sessionId} not found`);
		}
		entry.name = newName;
		entry.updatedAt = new Date().toISOString();
		// ★ 2026-09-20：用户手动命名 ⇒ 打标记，之后「首条消息自动命名」不再覆盖它。
		// 自动命名入口（NativeChatEditorPane / webview useChatStore）刻意**不传**该选项。
		if (options?.userInitiated) {
			entry.userRenamed = true;
		}
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
		// ★ P0-1：日志与快照是**两份文件** ⇒ 删除必须成对 ✗（漏删会留下孤儿日志 ✓）
		try {
			const logUri = this._sessionLogUri(paths.sessionsDirUri, sessionId);
			if (await this.fileService.exists(logUri)) { await this.fileService.del(logUri); }
		} catch {
			/* ignore */
		}
		this._sessionLogAppends.delete(this._cacheKey(agentId, sessionId));
		this._sessionLogBytes.delete(this._cacheKey(agentId, sessionId));
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
		// ★ 2026-09-12：专门通知「被删的是哪个会话」，让正显示它的聊天面板能切走
		//   （删除可能由历史视图 / 会话浏览器发起，面板自身回调不会被调用）。
		this._onDidDeleteAgentSessionEmitter.fire({ agentId, sessionId });
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
		const srcLog = this._sessionLogUri(paths.sessionsDirUri, sessionId);
		const dstLog = this._sessionLogUri(paths.sessionsDirUri, newId);
		if (await this.fileService.exists(srcFile)) {
			await this.fileService.copy(srcFile, dstFile, true);
		} else {
			// ★ P0-1：快照可能**尚不存在**（新会话只写了日志 ✓）⇒ 内存缓存为空时
			//   必须回落到「快照 + 日志重放」的结果，否则 fork 出来是**空会话** ✗✓。
			const cached = this._historyCache.get(this._cacheKey(agentId, sessionId))
				?? await this._loadFromSessionFile(agentId, sessionId);
			await writeFileAtomicSafe(this.fileService, dstFile, VSBuffer.fromString(JSON.stringify(cached, null, 2)));
		}
		// ★ P0-1：日志一并复制（否则分叉会丢掉「快照之后」的增量消息 ✗）
		if (await this.fileService.exists(srcLog)) {
			await this.fileService.copy(srcLog, dstLog, true);
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
