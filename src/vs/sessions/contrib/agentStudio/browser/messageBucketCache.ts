/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import type { ChatMessage } from '../common/types.js';
import type { AgentChatPaths } from './agentChatPaths.js';

/** 桶缓存的宿主注入面（缓存/索引归本模块 ⇒ 这几项只能由宿主提供 ✓）。 */
export interface IMessageBucketDeps {
	/** 该桶是否"打开"（流式中 / 有活跃 onDelta）—— 打开的桶**永不淘汰** ✓。 */
	isOpen: (key: string) => boolean;
	/** 是否有活跃流（内存周期监护的采样开关 ✓）。 */
	hasActiveStreams: () => boolean;
	/** 整段改写落盘（P1/P2 压缩后 ✓）—— 实现归 `SessionHistoryStore` ✓。
	 *  ⚠ `sessionId` 可为 `undefined`（noSession 桶 ✓）：`SessionHistoryStore.persistSnapshot`
	 *  对空 sessionId 是 **no-op** ✓ ⇒ 语义与搬迁前逐字节一致 ✓。 */
	persist: (agentId: string, sessionId: string | undefined, messages: ChatMessage[]) => Promise<void>;
	/** 工具结果外置到 sidecar（淘汰前 ✓）—— 实现归 `SessionSidecarStore` ✓。 */
	externalize: (agentId: string, sessionId: string, messages: ChatMessage[]) => Promise<number>;
}

/**
 * 消息桶缓存 + LRU 淘汰 + 三段式压缩 + 内存/DOM 诊断 —— 从 `agentChatService.ts` 拆出的独立簇
 * ✓（2026-09-22 阶段③c）。
 *
 * ## 三条内存防线（从 2026-07-13「每发一条消息内存持续增长直至崩溃」事故来的 ✓✓）
 *  ① **LRU 淘汰整桶**（`evictIfNeeded` ✓）：只淘汰会话桶（key 含 `::` ✓），
 *     `noSession` 系统桶与**打开的桶**（流式中 ✓）永不淘汰 ✓；候选按 **P3 保留分**排序
 *     （recency + activity 加权 ✓ —— 防"一次琐碎交互挤掉重会话"的抖动 ✓）。
 *  ② **淘汰前两段收敛**（`evictLruBucket` ✓）：先把超长工具结果**外置到 sidecar**（P1 ✓，
 *     句柄可回读 ✓），再把中段 tool result 截到 280 字符（P2 ✓，本地确定性、不调 LLM ✓）。
 *  ③ **活跃桶也会压缩**（`compactActiveBucketIfNeeded` ✓）：LRU 只管整桶 ⇒ 活跃桶内**无界累积** ✗
 *     —— 这正是当年事故的疑点 ✓ ⇒ 估算字节超 48MB 时复用同款三段式压缩 + 落盘 ✓。
 *
 * ## 诊断（`logMemSnapshot` / `startMemWatch` ✓）
 * `MemSnap` 原先只在 3 个事件点打点 ✗ ⇒ 卡死那次**整份日志只有 2 条**、RSS 涨到 3.4GB 的
 * 全过程零记录 ✗✓。现加 **30s 周期采样**（仅在有活跃流或 DOM 越警戒线时输出 ✓ 不刷屏 ✓），
 * 并且**必须同时统计 DOM 节点数** ✓✓：真机 RSS 3.4GB 而 JS 堆仅 600MB ⇒ 差值全在 DOM/渲染层 ✗
 * ⇒ 只看 heap 永远看不到真凶 ✓。
 *
 * ⚠ 字节估算一律**字段长度求和**，绝不 `JSON.stringify` 整桶 ✗✓（OOM 时翻倍分配会直接致死 ✓）。
 */
export class MessageBucketCache {
	/**
	 * P0-LRU: maximum number of session-level (key contains "::") buckets kept in
	 * memory. noSession buckets (pure agentId, system messages only) are unlimited.
	 * When exceeded during append (new bucket created), evict the least recently
	 * accessed non-open bucket.
	 *
	 * Rationale: each bucket can hold hundreds of ChatMessages with full
	 * ToolResult payloads (multi-GB total).  This cap keeps the renderer
	 * heap comfortably below the 4 GB V8 pointer-compression cage.
	 */
	static readonly MAX_CACHED_SESSION_BUCKETS = 15;
	/**
	 * P2: minimum message count before session history compaction kicks in
	 * during LRU eviction.  Sessions shorter than this are kept as-is.
	 * Aligns with ContextManager.minMessagesToCompress default.
	 */
	static readonly COMPACT_MIN_MESSAGES = 20;
	/**
	 * P2: number of messages at the start of a conversation to keep verbatim
	 * (protected head — task origin).  Aligns with ContextManager.PROTECT_FIRST_N.
	 */
	static readonly COMPACT_PROTECT_HEAD = 3;
	/**
	 * P2: maximum number of messages at the end of a conversation to keep
	 * verbatim (protected tail — recent context).  Aligns with
	 * ContextManager.TAIL_MAX_MESSAGES.
	 */
	static readonly COMPACT_PROTECT_TAIL = 15;
	/**
	 * P2: maximum characters of a single tool call result kept in the
	 * middle (summarisable) segment after compaction.  Aligns with
	 * ContextManager.TOOL_RESULT_TRUNCATE_CHARS.
	 */
	static readonly COMPACT_RESULT_TRUNCATE = 280;
	/**
	 * ★ 2026-09-12（P1 内存）：**活跃会话桶**的估算字节软上限。超过即对中段
	 * tool result 做三段式压缩（同 LRU 淘汰时的 P2 策略）。
	 *
	 * 由来：LRU 只淘汰**整条**会话桶，活跃桶内的消息**无界累积** —— 正是
	 * 2026-07-13「每发一条消息内存持续增长直至崩溃」的疑点（见 `estimateMessageBytes`
	 * 上方 OOM 诊断注释）。取 48MB 是权衡：低于此值不值得改写用户可见内容
	 * （压缩会把中段 tool result 截到 280 字符）。
	 */
	static readonly ACTIVE_BUCKET_SOFT_LIMIT_BYTES = 48 * 1024 * 1024;
	/**
	 * ★ 2026-09-12：活跃桶压缩检查的最小间隔。检查本身是 O(n) 扫字节（绝不
	 * `JSON.stringify`，避免 OOM 时翻倍分配），故按时间节流，避免每次批量落盘都扫。
	 */
	static readonly ACTIVE_COMPACT_MIN_INTERVAL_MS = 60_000;
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
	 *
	 * 含义 ✓：**频繁访问的 500 条会话可以压过刚访问的 2 条会话** ✓ —— 防止"一次琐碎交互
	 * 挤掉重会话"的抖动 ✓（`scoreBucketForEviction` 头注释有完整推导 ✓）。
	 */
	static readonly EVICT_RECENCY_WEIGHT = 0.6;
	static readonly EVICT_ACTIVITY_WEIGHT = 0.4;
	static readonly EVICT_RECENCY_DECAY = 0.5;
	static readonly EVICT_ACTIVITY_LOG_CAP = 10;
	/** DOM 节点数警戒线（典型聊天面板约 2–5k 节点 / 30 条消息 ✓）。 */
	static readonly DOM_WARN_NODES = 60_000;
	/** DOM 节点数危险线（真机 1675 条消息全量入 DOM 时远超此值 ✗）。 */
	static readonly DOM_ERROR_NODES = 120_000;

	/** In-memory cache: compositeKey → messages（宿主直接读写 ✓ —— 会话 API 大量遍历它 ✓）。 */
	readonly cache = new Map<string, ChatMessage[]>();
	/** P0-LRU: last access timestamp (Date.now()) per cache key. */
	readonly access = new Map<string, number>();

	/** 上次活跃桶压缩检查的时间戳（见 ACTIVE_COMPACT_MIN_INTERVAL_MS ✓）。 */
	private _lastActiveCompactAt = 0;
	/** 周期内存监护定时器（`startMemWatch` ✓；0/null 表示未启动 ✓）。 */
	private _memWatchTimer: number | null = null;

	constructor(
		private readonly logService: ILogService,
		private readonly paths: AgentChatPaths,
		private readonly deps: IMessageBucketDeps,
	) { }

	/**
	 * ★ 2026-09-12（P1 内存）：**活跃会话桶**的中段压缩。
	 *
	 * 原实现只在 LRU 淘汰**整桶**时压缩（`evictLruBucket` → `compactMessagesForEviction`），
	 * 活跃桶内的消息因此**无界累积** —— 这正是 2026-07-13「每发一条消息内存持续增长
	 * 直至崩溃」的疑点。
	 *
	 * 现补：活跃桶估算字节超 `ACTIVE_BUCKET_SOFT_LIMIT_BYTES` 时，复用 LRU 同款
	 * 三段式压缩（保护头 `COMPACT_PROTECT_HEAD` / 尾 `COMPACT_PROTECT_TAIL`，只压中段），
	 * 并落盘使磁盘同样收敛。
	 *
	 * 触发条件刻意保守：① 只在超软上限时动作（否则不改写用户可见内容）；
	 * ② 按 `ACTIVE_COMPACT_MIN_INTERVAL_MS` 节流（估算字节是 O(n) 扫描）。
	 */
	async compactActiveBucketIfNeeded(agentId: string, sessionId?: string): Promise<void> {
		const now = Date.now();
		if (now - this._lastActiveCompactAt < MessageBucketCache.ACTIVE_COMPACT_MIN_INTERVAL_MS) { return; }
		this._lastActiveCompactAt = now;

		const messages = this.cache.get(this.paths.cacheKey(agentId, sessionId));
		if (!messages || messages.length < MessageBucketCache.COMPACT_MIN_MESSAGES) { return; }

		let bytes = 0;
		for (const m of messages) { bytes += MessageBucketCache.estimateMessageBytes(m); }
		if (bytes < MessageBucketCache.ACTIVE_BUCKET_SOFT_LIMIT_BYTES) { return; }

		const truncated = this.compactMessagesForEviction(messages);
		if (truncated <= 0) { return; }

		this.logService.info(
			`[MessageBucketCache][P1] Compacted ${truncated} middle-segment tool result(s) in ACTIVE bucket ` +
			`${agentId}::${sessionId ?? '(noSession)'} (est ${Math.round(bytes / 1024 / 1024)}MB > soft limit ` +
			`${MessageBucketCache.ACTIVE_BUCKET_SOFT_LIMIT_BYTES / 1024 / 1024}MB, head=${MessageBucketCache.COMPACT_PROTECT_HEAD} tail=${MessageBucketCache.COMPACT_PROTECT_TAIL})`,
		);
		await this.deps.persist(agentId, sessionId, messages).catch((err) =>
			this.logService.warn(
				`[MessageBucketCache][P1] persist after active-bucket compaction failed: ${err instanceof Error ? err.message : err}`,
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
	compactMessagesForEviction(messages: ChatMessage[]): number {
		if (messages.length < MessageBucketCache.COMPACT_MIN_MESSAGES) {
			return 0;
		}
		// Split into system and conversation messages
		const systemMsgs: ChatMessage[] = [];
		const convMsgs: ChatMessage[] = [];
		for (const m of messages) {
			if (m.role === 'system') { systemMsgs.push(m); }
			else { convMsgs.push(m); }
		}
		if (convMsgs.length <= MessageBucketCache.COMPACT_PROTECT_HEAD + MessageBucketCache.COMPACT_PROTECT_TAIL) {
			return 0; // head+tail already cover everything — nothing to compact
		}

		const head = convMsgs.slice(0, MessageBucketCache.COMPACT_PROTECT_HEAD);
		const tail = convMsgs.slice(-MessageBucketCache.COMPACT_PROTECT_TAIL);
		const headEnd = MessageBucketCache.COMPACT_PROTECT_HEAD;
		const tailStart = convMsgs.length - MessageBucketCache.COMPACT_PROTECT_TAIL;
		const middle = convMsgs.slice(headEnd, Math.max(headEnd, tailStart));

		let truncated = 0;
		for (const m of middle) {
			if (!m.toolCalls) { continue; }
			for (const tc of m.toolCalls) {
				const result = tc.result;
				if (!result || result.length <= MessageBucketCache.COMPACT_RESULT_TRUNCATE) { continue; }
				(tc as any).result = result.slice(0, MessageBucketCache.COMPACT_RESULT_TRUNCATE);
				truncated++;
			}
		}

		// Rebuild in order: system → head → middle → tail
		messages.length = 0;
		messages.push(...systemMsgs, ...head, ...middle, ...tail);

		return truncated;
	}

	/** P0-LRU: mark a bucket as recently accessed. */
	touchBucket(key: string): void {
		this.access.set(key, Date.now());
	}

	/** P0-LRU: check whether a bucket is "open" (streaming or has active onDelta). */
	isBucketOpen(key: string): boolean {
		return this.deps.isOpen(key);
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
	scoreBucketForEviction(accessTime: number, msgCount: number): number {
		const daysSince = (Date.now() - accessTime) / (1000 * 60 * 60 * 24);
		const recencyScore = 1 / (1 + Math.max(0, daysSince) * MessageBucketCache.EVICT_RECENCY_DECAY);
		const activityScore = Math.log2(Math.max(1, msgCount + 1)) / MessageBucketCache.EVICT_ACTIVITY_LOG_CAP;
		return recencyScore * MessageBucketCache.EVICT_RECENCY_WEIGHT
			+ activityScore * MessageBucketCache.EVICT_ACTIVITY_WEIGHT;
	}

	/** P0-LRU: evict the single least-recently-used non-open session bucket. */
	async evictLruBucket(): Promise<void> {
		// Collect candidate keys: only session buckets (contain "::") that are
		// NOT open.  noSession buckets and open buckets are never evicted.
		const candidates: { key: string; access: number; msgCount: number; score: number }[] = [];
		for (const [key, access] of this.access) {
			if (!key.includes('::')) { continue; }       // protect noSession system buckets
			if (this.isBucketOpen(key)) { continue; }    // protect streaming/active buckets
			const msgCnt = this.cache.get(key)?.length ?? 0;
			const score = this.scoreBucketForEviction(access, msgCnt);
			candidates.push({ key, access, msgCount: msgCnt, score });
		}
		if (candidates.length === 0) {
			this.logService.warn(
				`[MessageBucketCache][LRU] evict: no candidates (all ${this.countSessionBuckets()} buckets open/streaming)`,
			);
			return;
		}
		// P3: sort by retention score ascending (lowest score = most evictable)
		candidates.sort((a, b) => a.score - b.score);
		const victim = candidates[0];
		const messages = this.cache.get(victim.key);
		// P1: externalise oversize tool results to sidecar before eviction,
		// then rewrite the session file so disk is compact too.
		const sepIdx = victim.key.indexOf('::');
		const agentId = victim.key.slice(0, sepIdx);
		const sessionId = victim.key.slice(sepIdx + 2);
		if (messages && messages.length > 0) {
			let dirty = false;
			try {
				const externalised = await this.deps.externalize(agentId, sessionId, messages);
				dirty = dirty || externalised > 0;
			} catch (err) {
				// ⚠ 原实现用 `${victim}`（对象 ⇒ 打印成 "[object Object]" ✗）⇒ 这里改 `victim.key` ✓
				this.logService.warn(
					`[MessageBucketCache][LRU] P1 externalise failed for ${victim.key}: ${err instanceof Error ? err.message : err}`,
				);
			}
			// P2: compact middle-segment tool results to 280 chars (local, no LLM)
			const truncated = this.compactMessagesForEviction(messages);
			if (truncated > 0) {
				dirty = true;
				this.logService.info(
					`[MessageBucketCache][P2] Compacted ${truncated} middle-segment tool result(s) for ${victim.key} (head=${MessageBucketCache.COMPACT_PROTECT_HEAD} tail=${MessageBucketCache.COMPACT_PROTECT_TAIL})`,
				);
			}
			if (dirty) {
				await this.deps.persist(agentId, sessionId, messages).catch((err) =>
					this.logService.warn(
						`[MessageBucketCache][LRU] persist after P1+P2 failed for ${victim.key}: ${err instanceof Error ? err.message : err}`,
					),
				);
			}
		}
		this.cache.delete(victim.key);
		this.access.delete(victim.key);
		this.logService.info(
			`[MessageBucketCache][LRU] evicted bucket ${victim.key} (score=${victim.score.toFixed(3)} ${victim.msgCount} msgs, last access ${Math.round((Date.now() - victim.access) / 1000)}s ago, ${candidates.length} candidates)`,
		);
	}

	/** P0-LRU: count session buckets (keys with "::") currently in cache. */
	countSessionBuckets(): number {
		let count = 0;
		for (const key of this.cache.keys()) {
			if (key.includes('::')) { count++; }
		}
		return count;
	}

	/** P0-LRU: evict LRU buckets until we are at or under the session bucket cap. */
	async evictIfNeeded(): Promise<void> {
		while (this.countSessionBuckets() > MessageBucketCache.MAX_CACHED_SESSION_BUCKETS) {
			await this.evictLruBucket();
		}
	}

	/**
	 * ★ 2026-09-22（用户要求「压缩后从聊天框移除被压缩内容 ⇒ 间接提升 UI 性能」的**内存侧**配套 ✓）：
	 * **只丢内存桶**（磁盘始终是权威 ✓）—— 刻意**不 externalize、不 persist、不重写任何文件** ✗✓。
	 *
	 * 为什么不让它顺手落盘：现成的 `evictLruBucket` 在 `dirty` 时会走 `deps.persist`（**整会话文件重写**
	 * + 删日志 + 屏障 ✓）—— 那正是 2026-09-11「每次追加都全量重写 ⇒ 渲染进程卡死 2.5 分钟」事故的
	 * 形态 ✗✓。本方法只做两次 `Map.delete`（O(1) ✓ 零 IO ✓）⇒ 可安全用于热路径 ✓。
	 *
	 * ⚠ **调用方必须保证"丢桶之后紧接着会发生一次完整重载"** ✗✓（例如落盘之后、`_reloadChatHistory`
	 * 之前 ✓）。原因：宿主的部分写路径是**读改写**（读桶 → push / slice → 落盘 ✓）—— 若在"丢桶"与
	 * "下一次 append"之间没有重载，那次 append 会**新建一个只含新消息的空桶** ✗ ⇒ 内存权威被静默
	 * 截断（表现为模型失忆，即 `_diagnoseEmptyPriorMessages` 要抓的第③种形态 ✗✗）。桶内容本就是
	 * write-through 落盘的 ✓ ⇒ "丢 + 立刻重读"永远安全 ✓，而"丢 + 接着 append"永远不安全 ✗。
	 *
	 * @returns 该键此前是否存在桶（便于调用方打日志 / 断言 ✓）
	 */
	dropBucket(agentId: string, sessionId?: string): boolean {
		const key = this.paths.cacheKey(agentId, sessionId);
		const had = this.cache.delete(key);
		this.access.delete(key);
		return had;
	}

	// ─── OOM 诊断：每条消息的堆增长 + 历史留存归因 ──────────────────────────
	// 2026-07-13：用户反馈「每发一条消息内存持续增长直至崩溃」。疑点：活跃会话桶
	// cache[key] 无界累积（LRU 只淘汰整条会话桶，不裁剪活跃会话内的消息），
	// 且 ToolMessage.result（文件全文/搜索输出）原样留存。字节估算用字段长度求和，
	// 绝不 JSON.stringify 整桶（避免 OOM 时翻倍分配）。只扫活跃桶，避免 O(n²)。
	static estimateMessageBytes(m: ChatMessage): number {
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
	logMemSnapshot(tag: string, ctx?: { agentId?: string; sessionId?: string; role?: string; msgBytes?: number }): void {
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
			for (const msgs of this.cache.values()) { totalMsgs += msgs.length; }

			let activeMsgs = 0;
			let activeBytes = 0;
			const activeKey = ctx?.agentId
				? (ctx.sessionId ? `${ctx.agentId}::${ctx.sessionId}` : ctx.agentId)
				: '';
			if (activeKey) {
				const msgs = this.cache.get(activeKey);
				if (msgs) {
					for (const m of msgs) {
						activeMsgs++;
						activeBytes += MessageBucketCache.estimateMessageBytes(m);
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
				`cache buckets=${this.cache.size} sessBuckets=${this.countSessionBuckets()} totalMsgs=${totalMsgs} | ` +
				`active[${activeKey}] msgs=${activeMsgs} bytes=${mb(activeBytes)}MB${appendInfo}${domInfo}`;

			// 阈值升级：DOM 规模失控是「app 卡死」的**直接前兆** ✓（信息级日志会被忽略 ✗）
			if (domNodes >= MessageBucketCache.DOM_ERROR_NODES) {
				this.logService.error(`${line} ⚠⚠ DOM 节点数 ${domNodes} 超危险阈值 ${MessageBucketCache.DOM_ERROR_NODES} —— 主线程即将被布局/重排拖死（真机 3.4GB 事故前兆 ✓）`);
			} else if (domNodes >= MessageBucketCache.DOM_WARN_NODES) {
				this.logService.warn(`${line} ⚠ DOM 节点数 ${domNodes} 偏高（>${MessageBucketCache.DOM_WARN_NODES}）`);
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

	/** 惰性启动周期监护（幂等 ✓，首次 sendMessage 时调用 ✓）。 */
	startMemWatch(): void {
		if (this._memWatchTimer !== null) { return; }
		this._memWatchTimer = window.setInterval(() => {
			let domNodes: number;
			try {
				domNodes = document.getElementsByTagName('*').length;
			} catch { return; }
			const busy = this.deps.hasActiveStreams();
			if (!busy && domNodes < MessageBucketCache.DOM_WARN_NODES) {
				// 空闲且 DOM 健康 ⇒ 采样丢弃（不产生日志）✓
				return;
			}
			this.logMemSnapshot(busy ? 'tick' : 'tick-idle');
		}, 30_000);
	}

	/** 停止周期监护（宿主销毁时 ✓ —— 避免宿主销毁后回调仍在跑 ✗）。 */
	stopMemWatch(): void {
		if (this._memWatchTimer !== null) {
			window.clearInterval(this._memWatchTimer);
			this._memWatchTimer = null;
		}
	}
}
