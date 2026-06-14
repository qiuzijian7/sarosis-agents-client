/*---------------------------------------------------------------------------------------------
 *  TdbAmMemoryProvider — forwards IMemoryProvider calls to the local TDB-AM gateway.
 *
 *  Gateway endpoints used:
 *    POST /capture            — record a turn (writeMemory)
 *    POST /search/memories    — L1 keyword search (searchMemory + loadContext long-term)
 *    POST /recall             — pre-built context string (loadContext)
 *
 *  ─── 关键设计：saros writeMemory 调用模式适配 ─────────────────────────────
 *
 *  saros 的 chat 链路有两处会调 writeMemory（参见 src/vs/sessions/contrib/
 *  agentStudio/browser）：
 *
 *    1. agentDriverService.ts (Step 5: 写回记忆)
 *         writeMemory(agentId, {
 *           id: 'memory-...', type:'short_term',
 *           content: <最近一条 user 消息>,    // ← 这是用户输入！
 *         });
 *
 *    2. providers/execution/executionProvider.ts (Step 7.7)
 *         writeMemory(agentId, {
 *           id: 'msg-...', type:'short_term',
 *           content: <assistant 回复或工具结果>,  // ← 这是 assistant 输出！
 *           metadata: { toolCalls, toolResults },
 *         });
 *
 *  ⚠ saros 没有传递 metadata.role 字段。早期版本依赖 role='user'/'assistant'
 *  来区分两端，导致两次调用都被当 assistant 处理，userContent 永远空，
 *  /capture 直接返回 HTTP 400。
 *
 *  ─── 现在的判定策略 ─────────────────────────────────────────────────
 *
 *  核心观察：在一轮对话里，两个 writeMemory 调用按时间顺序到达：
 *    先 agentDriverService（写 user 消息，无 metadata）
 *    后 executionProvider（写 assistant 消息，含 metadata.toolCalls / toolResults）
 *
 *  特征区分（按可信度排序）：
 *    A. 显式 entry.metadata.role — 兼容未来 saros 升级
 *    B. metadata 里含 toolCalls / toolResults — 强烈暗示 assistant
 *    C. 默认：第一次到达视作 user，第二次到达视作 assistant，触发 /capture
 *
 *  sessionKey 推导：
 *    优先用 entry.metadata.sessionId / entry.metadata.session_key；
 *    退而求其次：用 agentId 作为唯一 key（同一 agent 在 saros 里只会有一个
 *    活动会话，足以保证 vendor 端 session 连续性）。
 *--------------------------------------------------------------------------------------------*/

// ─── Structural mirror of saros IMemoryProvider contract ──────────────────

interface IMemoryEntry {
	readonly id: string;
	readonly type: 'short_term' | 'long_term';
	readonly content: string;
	readonly metadata?: Record<string, unknown>;
	readonly timestamp?: number;
	readonly score?: number;
}

interface IMemoryContext {
	readonly shortTermMemories: IMemoryEntry[];
	readonly longTermMemories: IMemoryEntry[];
	readonly systemPrompt?: string;
	readonly relevantDocuments?: unknown[];
}

interface IMemoryProvider {
	readonly id: string;
	readonly name: string;
	loadContext(
		agentId: string,
		sessionId: string,
		query?: string,
		options?: {
			scope?: 'agent' | 'workspace' | 'global';
			allowedSessionKeys?: readonly string[];
		},
	): Promise<IMemoryContext>;
	writeMemory(agentId: string, entry: IMemoryEntry): Promise<void>;
	searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]>;
}

// ─── Gateway response shapes ────────────────────────────────────────────────

const DEFAULT_GATEWAY = 'http://127.0.0.1:8420';
const REQUEST_TIMEOUT_MS = 5000;

interface SearchMemoriesResponse {
	results: string;
	total: number;
	strategy: string;
}

interface CaptureResponse {
	l0_recorded: number;
	scheduler_notified: boolean;
}

interface InjectL1Response {
	stored: number;
	skipped: number;
}

interface InjectL1Memory {
	content: string;
	type: 'persona' | 'episodic' | 'instruction';
	priority: number;
	scene_name: string;
	metadata?: Record<string, unknown>;
}

interface RecallResponse {
	context: string;
	strategy?: string;
	memory_count?: number;
}

/**
 * Resolve the gateway base URL.
 * Honors env var TDBAM_GATEWAY for the host process to inject a custom port.
 */
function gatewayBase(): string {
	const envUrl = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.['TDBAM_GATEWAY'];
	if (typeof envUrl === 'string' && envUrl.length > 0) {
		return envUrl.replace(/\/+$/, '');
	}
	return DEFAULT_GATEWAY;
}

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
	const url = `${gatewayBase()}${path}`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
	try {
		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
		if (!resp.ok) {
			let detail = '';
			try { detail = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
			console.warn(`[TdbAmMemory] ${path} -> HTTP ${resp.status} ${detail}`);
			return null;
		}
		return (await resp.json()) as T;
	} catch (err) {
		console.warn(`[TdbAmMemory] ${path} failed: ${(err as Error).message}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The gateway returns L1 results as a single text blob. We do a best-effort
 * split into IMemoryEntry items so the host can render them. If the format
 * changes upstream, we fall back to one entry containing the whole blob.
 */
function parseMemoryResults(blob: string): IMemoryEntry[] {
	if (!blob || blob.trim().length === 0) {
		return [];
	}
	const chunks = blob.split(/\n---+\n|\n\n(?=\[)/g).map(s => s.trim()).filter(Boolean);
	const entries: IMemoryEntry[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const c = chunks[i];
		entries.push({
			id: `tdbam-l1-${Date.now()}-${i}`,
			type: 'long_term',
			content: c,
			timestamp: Date.now(),
		});
	}
	return entries.length > 0 ? entries : [{
		id: `tdbam-l1-${Date.now()}-0`,
		type: 'long_term',
		content: blob,
		timestamp: Date.now(),
	}];
}

/**
 * 推导 sessionKey：统一以 `agent:<agentId>` 为粒度。
 *
 * ── 设计决策（2026-06）──────────────────────────────────────────────────
 * 此前实现会优先用 metadata.sessionId 拼成 `<agentId>:<sessionId>`，
 * 导致 SQLite 实际写入的 sessionKey 是 `<agentId>:<sessionId>`，
 * 而 host 侧 Memory Tab（agentStudioWebviewController._deriveSessionKey）
 * 用 `agent:<agentId>` 去查 → 永远查不到，列表恒为 0。
 *
 * 修复方式：写入侧也统一为 `agent:<agentId>`，放弃 session 级隔离。
 * 同一 agent 跨 chat session 共享同一记忆空间，这与"长期记忆"语义
 * 更契合，也跟 host._deriveSessionKey 完全对齐。
 *
 * 入参 `entry` 现已不再使用（保留参数避免改 callsites 签名），仅用
 * 来兼容历史调用约定。
 * ─────────────────────────────────────────────────────────────────────
 */
function deriveSessionKey(agentId: string, _entry: IMemoryEntry): string {
	const trimmed = (agentId ?? '').trim();
	return trimmed.length > 0 ? `agent:${trimmed}` : 'agent:default';
}

/**
 * 清除内容中由上游 chat 渲染链路漏网的字面量 `undefined` 串。
 *
 * 背景：saros 早期 chat 写入路径在某些异步消息片段尚未到达时会用
 * `String(undefined)` 拼接历史，导致 `assistant_content` 中夹杂 "undefined"
 * 序列。即使 chat 侧已加了 7 道防线，仍需要在 vendor /capture 入口处兜底，
 * 避免再次污染 SQLite L0 表（已落盘的脏数据无法靠重启自愈）。
 *
 * `undefined` 在本产品的任何合法 user/assistant 文本中都不会作为连续 run
 * 出现，无条件剥离是安全的。
 */
function stripUndefinedLiterals(s: string | undefined | null): string {
	if (!s) return '';
	if (!s.includes('undefined')) return s;
	return s.replace(/(?:undefined)+/g, '');
}

/**
 * 解析并剥离 Knot 回复末尾的记忆标签块（兜底层，流式阶段已剥离时此处为空操作）。
 *
 * 支持两种格式：
 *   1. <memory_extract>{"content":"...","type":"episodic","priority":80,"scene_name":"..."}</memory_extract>
 *      （推荐格式，图里方案）
 *   2. [MEMORY:L1:<type>:<priority>:<scene_name>]内容[/MEMORY]
 *      （旧格式，向后兼容）
 *
 * 返回：
 *   - cleanedText: 剥离所有标签后的纯文本（用于写入 L0）
 *   - l1Memories:  解析出的 L1 记忆列表（用于调用 /inject/l1）
 */
function parseAndStripMemoryTags(text: string): {
	cleanedText: string;
	l1Memories: InjectL1Memory[];
} {
	const l1Memories: InjectL1Memory[] = [];
	const VALID_TYPES = new Set(['persona', 'episodic', 'instruction']);

	let cleanedText = text;

	// ── 格式1：<memory_extract>JSON</memory_extract> ──────────────────────────
	const extractTagRe = /<memory_extract>([\s\S]*?)<\/memory_extract>/g;
	cleanedText = cleanedText.replace(extractTagRe, (_match, inner: string) => {
		try {
			const parsed = JSON.parse(inner.trim()) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const item = parsed as Record<string, unknown>;
				const content = typeof item['content'] === 'string' ? item['content'].trim() : '';
				const type = item['type'];
				if (content && VALID_TYPES.has(type as string)) {
					l1Memories.push({
						content,
						type: type as InjectL1Memory['type'],
						priority: typeof item['priority'] === 'number' ? item['priority'] : 70,
						scene_name: typeof item['scene_name'] === 'string' ? item['scene_name'] : 'Knot内联记忆',
					});
				}
			}
		} catch {
			// JSON 解析失败，忽略该标签
		}
		return '';
	});

	// ── 格式2：[MEMORY:L1:type:priority:scene]内容[/MEMORY] ──────────────────
	const legacyTagRe = /\[MEMORY:([^\]]+)\]([\s\S]*?)\[\/MEMORY\]/g;
	cleanedText = cleanedText.replace(legacyTagRe, (_match, header: string, body: string) => {
		const parts = header.split(':');
		const layer = parts[0]; // L1 / L2_SIGNAL / L3_SIGNAL

		if (layer === 'L1' && parts.length >= 4) {
			const type = parts[1];
			const priority = parseInt(parts[2], 10);
			const sceneName = parts.slice(3).join(':').trim();
			const content = body.trim();

			if (VALID_TYPES.has(type) && content.length > 0 && !isNaN(priority)) {
				l1Memories.push({
					content,
					type: type as InjectL1Memory['type'],
					priority,
					scene_name: sceneName || 'Knot内联记忆',
				});
			}
		}
		return '';
	});

	return { cleanedText: cleanedText.trim(), l1Memories };
}

/** 判断一个 entry 是 user 还是 assistant 角色（依赖 metadata 特征 + 顺序兜底）。 */
function inferRole(entry: IMemoryEntry, hasPendingUser: boolean): 'user' | 'assistant' {
	const md = entry.metadata ?? {};
	const explicit = md['role'];
	if (explicit === 'user' || explicit === 'assistant') {
		return explicit;
	}
	// executionProvider 写 assistant 时会带 toolCalls/toolResults
	if (typeof md['toolCalls'] === 'number' || typeof md['toolResults'] === 'number'
		|| typeof md['toolCalls'] === 'object' || typeof md['toolResults'] === 'object') {
		return 'assistant';
	}
	// 顺序兜底：当本次 entry 抵达时若已经有缓存的 user，则把当前视作 assistant；
	// 否则把当前视作 user。
	return hasPendingUser ? 'assistant' : 'user';
}

export class TdbAmMemoryProvider implements IMemoryProvider {
	readonly id = 'tdb-am-memory';
	readonly name = 'TencentDB Agent Memory';

	/** 缓存最近一次 user 消息（按 sessionKey 分组）。assistant 到达时与之配对。 */
	private _pendingUser = new Map<string, string>();

	// ── L2/L3 蒸馏调度 ────────────────────────────────────────────────────────
	// L2：session 空闲 10 分钟后触发（每次 writeMemory 重置定时器）
	// L3：全局定时器，每 6 小时触发一次
	private readonly L2_IDLE_MS = 10 * 60_000;
	private readonly L3_INTERVAL_MS = 6 * 60 * 60 * 1000;

	private _l2Timers = new Map<string, ReturnType<typeof setTimeout>>();
	private _l3Timer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		this._l3Timer = setInterval(() => { void this._triggerL3(); }, this.L3_INTERVAL_MS);
		if ((this._l3Timer as unknown as { unref?: () => void }).unref) {
			(this._l3Timer as unknown as { unref: () => void }).unref();
		}
	}

	dispose(): void {
		this._pendingUser.clear();
		for (const t of this._l2Timers.values()) { clearTimeout(t); }
		this._l2Timers.clear();
		if (this._l3Timer !== undefined) {
			clearInterval(this._l3Timer);
			this._l3Timer = undefined;
		}
	}

	private _resetL2IdleTimer(sessionKey: string): void {
		const existing = this._l2Timers.get(sessionKey);
		if (existing !== undefined) { clearTimeout(existing); }
		const t = setTimeout(() => {
			this._l2Timers.delete(sessionKey);
			void this._triggerL2(sessionKey);
		}, this.L2_IDLE_MS);
		if ((t as unknown as { unref?: () => void }).unref) {
			(t as unknown as { unref: () => void }).unref();
		}
		this._l2Timers.set(sessionKey, t);
	}

	private async _triggerL2(sessionKey: string): Promise<void> {
		const result = await postJson<{ triggered: boolean }>('/distill/l2', { session_key: sessionKey });
		if (result?.triggered) {
			console.log(`[TdbAmMemory] ✅ /distill/l2 triggered for session=${sessionKey}`);
		}
	}

	private async _triggerL3(): Promise<void> {
		const result = await postJson<{ triggered: boolean }>('/distill/l3', {});
		if (result?.triggered) {
			console.log(`[TdbAmMemory] ✅ /distill/l3 triggered`);
		}
	}

	async loadContext(
		agentId: string,
		sessionId: string,
		query?: string,
		options?: {
			scope?: 'agent' | 'workspace' | 'global';
			allowedSessionKeys?: readonly string[];
		},
	): Promise<IMemoryContext> {
		const sessionKey = deriveSessionKey(agentId, {
			id: '', type: 'short_term', content: '',
			metadata: { sessionId },
		});
		// 优先用调用方传入的真实 user 消息做召回；只有缺省时才退回占位字符串。
		// 占位字符串时 vendor FTS5 / embedding 都不会有实际命中，等价于"无召回"。
		const recallQuery = (query && query.trim().length > 0) ? query.trim() : '_loadContext_';

		// 召回作用域（2026-06 新增）：未传时不传 scope 字段，gateway 维持
		// 'global' 兜底语义，老调用方零行为变更。
		const recallBody: Record<string, unknown> = {
			query: recallQuery,
			session_key: sessionKey,
		};
		if (options?.scope) {
			recallBody['scope'] = options.scope;
		}
		if (options?.allowedSessionKeys && options.allowedSessionKeys.length > 0) {
			recallBody['allowed_session_keys'] = [...options.allowedSessionKeys];
		}

		const result = await postJson<RecallResponse>('/recall', recallBody);

		const ctx: IMemoryContext = {
			shortTermMemories: [],
			longTermMemories: result?.context
				? [{
					id: `tdbam-recall-${Date.now()}`,
					type: 'long_term',
					content: result.context,
					timestamp: Date.now(),
				}]
				: [],
			systemPrompt: undefined,
			relevantDocuments: [],
		};
		return ctx;
	}

	async writeMemory(agentId: string, entry: IMemoryEntry): Promise<void> {
		const sessionKey = deriveSessionKey(agentId, entry);
		const role = inferRole(entry, this._pendingUser.has(sessionKey));

		// 入口处统一清洗：阻止 chat 渲染链路漏网的字面量 "undefined" 落盘到
		// vendor SQLite L0 表（已落盘的脏数据需要单独清库，无法靠运行时自愈）。
		const cleanedContent = stripUndefinedLiterals(entry.content);

		// 诊断日志：让 DevTools console 能看到每次 writeMemory 是怎么被分类的。
		try {
			const mdKeys = entry.metadata ? Object.keys(entry.metadata).join(',') : '<none>';
			const preview = cleanedContent.slice(0, 60).replace(/\n/g, ' ');
			console.log(`[TdbAmMemory] writeMemory: agentId=${agentId} sessionKey=${sessionKey} role=${role} mdKeys=[${mdKeys}] content="${preview}"`);
		} catch { /* ignore */ }

		if (role === 'user') {
			this._pendingUser.set(sessionKey, cleanedContent);
			return;
		}

		const userContent = this._pendingUser.get(sessionKey) ?? '';
		const assistantContent = cleanedContent;

		// ── 解析并剥离 Knot 内联记忆标签 ──────────────────────────────────────
		// Knot 可以在回复末尾输出 [MEMORY:L1:type:priority:scene]内容[/MEMORY] 标签，
		// 拦截层解析后直接写入 L1，同时把标签从 assistantContent 中剥离，
		// 避免标签文本污染 L0 对话记录。
		const { cleanedText: assistantForCapture, l1Memories } = parseAndStripMemoryTags(assistantContent);

		// 异步注入 L1 记忆（不阻塞 /capture）
		if (l1Memories.length > 0) {
			const sessionId = (entry.metadata?.['sessionId'] as string | undefined) ?? sessionKey;
			postJson<InjectL1Response>('/inject/l1', {
				session_key: sessionKey,
				session_id: sessionId,
				memories: l1Memories,
			}).then(r => {
				if (r) {
					console.log(`[TdbAmMemory] ✅ /inject/l1 stored=${r.stored} skipped=${r.skipped} (from ${l1Memories.length} inline tags)`);
				}
			}).catch(err => {
				console.warn(`[TdbAmMemory] /inject/l1 failed: ${(err as Error).message}`);
			});
		}

		// vendor /capture 强制要求 user_content / assistant_content / session_key 非空。
		// 任何一项缺失就放弃本次 capture，避免 HTTP 400 的噪声日志。
		if (!sessionKey || !userContent || !assistantForCapture) {
			console.warn(`[TdbAmMemory] /capture 跳过：缺少必填字段 (sessionKey="${sessionKey}", userLen=${userContent.length}, assistantLen=${assistantForCapture.length})`);
			this._pendingUser.delete(sessionKey);
			return;
		}

		const result = await postJson<CaptureResponse>('/capture', {
			user_content: userContent,
			assistant_content: assistantForCapture,
			session_key: sessionKey,
			session_id: (entry.metadata?.['sessionId'] as string | undefined) ?? sessionKey,
			user_id: entry.metadata?.['userId'],
		});

		if (result) {
			console.log(`[TdbAmMemory] ✅ /capture l0_recorded=${result.l0_recorded} scheduler_notified=${result.scheduler_notified}`);
			// 每次成功 capture 后重置 L2 空闲定时器（60 秒无活动触发 L2 蒸馏）
			this._resetL2IdleTimer(sessionKey);
		}

		// 不论成功失败，都清掉缓存——下一轮重新累积。
		this._pendingUser.delete(sessionKey);
	}

	async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
		// vendor /search/memories 要求 query 非空
		if (!query || query.trim().length === 0) {
			return [];
		}
		const resp = await postJson<SearchMemoriesResponse>('/search/memories', {
			query,
			limit: 10,
		});
		if (!resp) {
			return [];
		}
		return parseMemoryResults(resp.results);
	}
}
