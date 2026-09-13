/*──────────────────────────────────────────────────────────────
 * 会话历史搜索工具（session_search）
 *
 * 2026-09-11 补全：此前 `session_search` 是**基础设施齐全、唯独缺 handler**
 * 的半成品 —— 配置项（`AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER/_MODEL`）、
 * 设置面板 UI 区块、`agentToolIsolator` 的工具名映射、`CORE_TOOLS` 与 core
 * 的 `exactNames` 登记**全都就位**，但 `name: 'session_search'` 全仓只出现在
 * `bundledTools.ts` 的定义里 → 被注册成 stub → `listTools` 跳过 → **模型看不到**。
 *
 * 数据源（无需新增存储，全部复用 `IAgentChatService`）：
 *   ~/.vssaros/chat-history/{agentId}/sessions.json       ← 会话索引
 *   ~/.vssaros/chat-history/{agentId}/sessions/{id}.json  ← 每会话消息
 *
 * ★ 设计取舍（刻意保守）：
 *  - **只做关键词匹配**，不调用 LLM 摘要。原 bundled 描述写的是
 *    "Returns summarized matching sessions"，但「摘要」需要额外模型调用与
 *    成本/时延/失败面（且 aux 模型未配置时会退化）—— 先用确定性的关键词 +
 *    命中片段，把能力跑通；将来接入 aux 摘要只需在 `formatHits` 层替换。
 *  - **硬性上限**（会话数 / 每会话消息数 / 片段数 / 片段长度）：历史可能累积
 *    几百个会话、单个会话几千条消息，无上限扫描会拖垮工具调用。
 *  - 命中片段**以匹配位置为中心**截取（而非只取开头），否则长消息里的命中
 *    在展示时看不见。
 *──────────────────────────────────────────────────────────────*/

import { IToolDefinition, IToolResultContent } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

export const SESSION_SEARCH_TOOL_NAME = 'session_search';

/** 单次搜索最多扫描的会话数（按 updatedAt 倒序，最新的优先）。 */
const MAX_SESSIONS_SCANNED = 30;
/** 单个会话最多读取的消息条数（防止超长会话拖垮搜索）。 */
const MAX_MESSAGES_PER_SESSION = 400;
/** 单个会话最多返回的命中片段数。 */
const MAX_SNIPPETS_PER_SESSION = 3;
/** 单个片段的最大字符数。 */
const SNIPPET_MAX_CHARS = 160;
/** 片段中匹配点前后各保留的字符数。 */
const SNIPPET_CONTEXT_CHARS = 60;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export interface ISessionSearchSessionMeta {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
}

export interface ISessionSearchMessage {
	readonly role?: string;
	readonly content?: unknown;
	readonly timestamp?: string;
}

export interface SessionSearchToolContext {
	register: (descriptor: {
		definition: IToolDefinition;
		handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string, sessionId?: string) => Promise<IToolResultContent[] | { content: IToolResultContent[] }>;
	}) => void;
	logService: ILogService;
	/** 列出该 agent 的全部会话（`IAgentChatService.listAgentSessions`，已按 updatedAt 倒序）。 */
	listSessions: (agentId: string) => Promise<readonly ISessionSearchSessionMeta[]>;
	/** 读取指定会话的消息（`IAgentChatService.getHistory`）。 */
	loadMessages: (agentId: string, sessionId: string) => Promise<readonly ISessionSearchMessage[]>;
}

// ─── 纯函数（便于单测，不依赖服务）────────────────────────────────────────

/**
 * 从消息 content 中提取可搜索文本。
 *
 * content 形态多样：纯字符串、多模态数组（`[{type:'text',text:'...'}]`）、
 * 或带 `text` 字段的对象。**刻意不做 `JSON.stringify` 兜底** —— 那会把工具调用的
 * 参数/结果 JSON 全量变成"可搜索文本"，让搜索被大量结构噪音淹没，反而降低信噪比。
 */
export function extractSearchableText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map(extractSearchableText).filter(Boolean).join(' ');
	}
	if (content && typeof content === 'object') {
		const obj = content as Record<string, unknown>;
		if (typeof obj.text === 'string') { return obj.text; }
		if (typeof obj.content === 'string') { return obj.content; }
	}
	return '';
}

/** 以匹配位置为中心截取片段（匹配点前后的内容都保留）。 */
export function buildSnippet(text: string, queryLower: string): string {
	const idx = text.toLowerCase().indexOf(queryLower);
	if (idx < 0) { return text.slice(0, SNIPPET_MAX_CHARS); }
	const start = Math.max(0, idx - SNIPPET_CONTEXT_CHARS);
	const end = Math.min(text.length, idx + queryLower.length + SNIPPET_CONTEXT_CHARS);
	const core = text.slice(start, end).replace(/\s+/g, ' ').trim();
	const prefix = start > 0 ? '…' : '';
	const suffix = end < text.length ? '…' : '';
	return `${prefix}${core}${suffix}`.slice(0, SNIPPET_MAX_CHARS);
}

export interface ISessionSearchHit {
	readonly sessionId: string;
	readonly sessionName: string;
	readonly updatedAt: string;
	readonly matchCount: number;
	readonly snippets: readonly string[];
}

/**
 * 在给定会话集合中做关键词搜索（大小写不敏感）。
 *
 * 命中条件：会话**名称**或**任一消息文本**包含 query。
 * 排序：命中次数多者优先；相同则 updatedAt 新者优先（`sessions` 传入时已倒序）。
 */
export function searchSessions(
	query: string,
	sessions: readonly ISessionSearchSessionMeta[],
	messagesBySession: ReadonlyMap<string, readonly ISessionSearchMessage[]>,
	limit: number,
): ISessionSearchHit[] {
	const queryLower = query.toLowerCase();
	const hits: ISessionSearchHit[] = [];

	for (const s of sessions) {
		const snippets: string[] = [];
		let matchCount = 0;

		if (s.name.toLowerCase().includes(queryLower)) {
			matchCount++;
			snippets.push(`(会话名) ${s.name}`);
		}

		const messages = messagesBySession.get(s.id) ?? [];
		for (const m of messages) {
			const text = extractSearchableText(m.content);
			if (!text || !text.toLowerCase().includes(queryLower)) { continue; }
			matchCount++;
			if (snippets.length < MAX_SNIPPETS_PER_SESSION) {
				const role = m.role ? `${m.role}: ` : '';
				snippets.push(role + buildSnippet(text, queryLower));
			}
		}

		if (matchCount > 0) {
			hits.push({
				sessionId: s.id,
				sessionName: s.name,
				updatedAt: s.updatedAt,
				matchCount,
				snippets,
			});
		}
	}

	hits.sort((a, b) => {
		if (b.matchCount !== a.matchCount) { return b.matchCount - a.matchCount; }
		return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
	});
	return hits.slice(0, limit);
}

/** 把命中结果格式化为给 LLM 的文本。 */
export function formatHits(query: string, hits: readonly ISessionSearchHit[], scanned: number): string {
	if (hits.length === 0) {
		return `[Session Search] No matches for "${query}" within the ${scanned} most recent session(s).\n`
			+ 'Try a different keyword, or note that only recent sessions are searched.';
	}
	const lines: string[] = [`[Session Search] ${hits.length} matching session(s) for "${query}" (scanned ${scanned}):`, ''];
	hits.forEach((h, i) => {
		const when = h.updatedAt ? new Date(h.updatedAt).toISOString().slice(0, 10) : 'unknown date';
		lines.push(`${i + 1}. 「${h.sessionName}」 — ${when}, ${h.matchCount} match(es)`);
		lines.push(`   session_id: ${h.sessionId}`);
		for (const sn of h.snippets) {
			lines.push(`   - ${sn}`);
		}
		lines.push('');
	});
	return lines.join('\n').trimEnd();
}

// ─── 工具注册 ─────────────────────────────────────────────────────────────

export function registerSessionSearchTools(ctx: SessionSearchToolContext): void {
	ctx.register({
		definition: {
			name: SESSION_SEARCH_TOOL_NAME,
			description: 'Search your own past conversation sessions (history) for a keyword and return the matching sessions with the relevant snippets. '
				+ 'Use this when the user refers to something discussed earlier ("上次我们说的…", "之前那个 bug"), or when you need to recall prior decisions/context that is no longer in the current context window.\n\n'
				+ 'Parameters:\n'
				+ '- `query` (required): keyword or phrase to look for. Matched case-insensitively against session names and message text.\n'
				+ '- `limit` (optional): max number of sessions to return (default 5, max 20).\n\n'
				+ 'Notes:\n'
				+ '- Only the most recent sessions are scanned (bounded for performance); an empty result does not prove the topic was never discussed.\n'
				+ '- Matching is literal keyword based (no semantic/LLM summarization).\n'
				+ '- Returns `session_id` values; use them to identify which past session is relevant.',
			inputSchema: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Keyword or phrase to search for in past sessions (case-insensitive).',
					},
					limit: {
						type: 'number',
						description: `Maximum number of matching sessions to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
					},
				},
				required: ['query'],
			},
		},
		handler: async (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string): Promise<IToolResultContent[]> => {
			const query = typeof args.query === 'string' ? args.query.trim() : '';
			if (!query) {
				return [{ type: 'text', text: '[Session Search] Error: "query" is required and cannot be empty.' }];
			}
			if (!agentId) {
				return [{ type: 'text', text: '[Session Search] Error: no agent context available (cannot resolve session history).' }];
			}
			const rawLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit);
			const limit = Number.isFinite(rawLimit) && rawLimit > 0
				? Math.min(Math.floor(rawLimit), MAX_LIMIT)
				: DEFAULT_LIMIT;

			try {
				const all = await ctx.listSessions(agentId);
				if (signal?.aborted) {
					return [{ type: 'text', text: '[Session Search] Cancelled before scanning.' }];
				}
				// 会话索引已按 updatedAt 倒序；再截断到上限（历史可能累积几百个会话）。
				const scanned = all.slice(0, MAX_SESSIONS_SCANNED);

				const messagesBySession = new Map<string, readonly ISessionSearchMessage[]>();
				for (const s of scanned) {
					if (signal?.aborted) { break; }
					try {
						const msgs = await ctx.loadMessages(agentId, s.id);
						messagesBySession.set(s.id, msgs.slice(-MAX_MESSAGES_PER_SESSION));
					} catch (err) {
						// 单个会话读取失败不应让整次搜索失败 —— 跳过并继续。
						ctx.logService.warn(`[SessionSearch] failed to load session ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}

				const hits = searchSessions(query, scanned, messagesBySession, limit);
				return [{ type: 'text', text: formatHits(query, hits, scanned.length) }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logService.error(`[SessionSearch] search failed: ${msg}`);
				return [{ type: 'text', text: `[Session Search] Error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[SessionSearchTools] Registered session_search tool');
}
