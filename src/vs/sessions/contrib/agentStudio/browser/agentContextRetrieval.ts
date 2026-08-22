/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent 上下文检索 — 从 agentOSService.ts 抽出 5 个方法（~150 行）。
 *
 * 负责将对话增量外置为 episodic 记忆、从记忆系统检索相关上下文、
 * 以及在压缩期间用检索替代同步 LLM 摘要。
 */

import { insertMessages } from '../common/agentRunState.js';

/** 检索式上下文注入前缀：与 contextManager.INJECTED_CONTEXT_PREFIX 完全一致。 */
export const RETRIEVED_CTX_PREFIX = '## Preserved Context (from memory)';

export interface ContextRetrievalDeps {
	/** 已外置的中间消息哈希去重集合（按 sessionId 分组）。 */
	getStoredHashes: (sessionId: string) => Set<string>;
}

/**
 * 粗略估算消息输入 token（char/4，与 ContextManager._estimateTokens 口径一致）。
 */
export function estimateMessagesTokens(messages: ReadonlyArray<any>): number {
	const IMAGE_TOKEN_COST = 1500;
	let totalChars = 0;
	let imageTokens = 0;
	for (const m of messages) {
		if (!m) { continue; }
		const shadow: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
			if (k === 'contentParts' && Array.isArray(v)) {
				shadow[k] = v.map((p: any) => (p && p.type === 'image' ? { type: 'image', data: '[stripped]' } : p));
			} else {
				shadow[k] = v;
			}
		}
		if (Array.isArray(shadow.contentParts)) {
			imageTokens += shadow.contentParts.filter((p: any) => p?.type === 'image').length * IMAGE_TOKEN_COST;
		}
		try {
			totalChars += JSON.stringify(shadow).length;
		} catch {
			totalChars += (typeof m.content === 'string' ? m.content.length : 0);
		}
	}
	return Math.ceil(totalChars / 4) + imageTokens;
}

/**
 * 中英混合的轻量分词（用于 session summary 相关性判定，非通用分词器）。
 *
 * - 英文/数字：按非字母数字切分 → 小写 → 去停用词 → 长度 ≥ 3
 * - 中文：字符级 **bigram**（中文无空格，词级切分需词典；bigram 足够做"零重叠"判定）
 *
 * 刻意不引入依赖、不追求分词准确度 —— 下游只用它判断「是否完全无关」，
 * 判据粗一点会**多保留**（漏过滤），而不会误删。
 */
export function tokenizeForRelevance(text: string): Set<string> {
	const tokens = new Set<string>();
	if (!text) { return tokens; }
	const lower = text.toLowerCase();

	// 英文 / 数字 / 标识符（含下划线连字符路径片段）
	for (const w of lower.split(/[^a-z0-9_]+/)) {
		if (w.length >= 3 && !RELEVANCE_STOPWORDS.has(w)) { tokens.add(w); }
	}
	// 中文 bigram（连续 CJK 字符两两成对）
	const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
	for (const run of cjkRuns) {
		if (run.length === 1) { tokens.add(run); continue; }
		for (let i = 0; i + 1 < run.length; i++) { tokens.add(run.slice(i, i + 2)); }
	}
	return tokens;
}

/**
 * 相关性判定的停用词（英文）。只收高频虚词与本项目里几乎无区分度的词。
 * 保持精简：词表越长越容易把真正的关键词删掉，导致误过滤。
 */
const RELEVANCE_STOPWORDS: ReadonlySet<string> = new Set([
	'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'was', 'were', 'has', 'have',
	'not', 'but', 'you', 'your', 'are', 'session', 'task', 'file', 'files', 'code',
	'add', 'use', 'used', 'using', 'get', 'set', 'new', 'all', 'can', 'via', 'per',
]);

/** getCompactContext 返回的 session 摘要（结构由记忆 provider 决定，按需取字段）。 */
export interface ISessionSummaryLike {
	readonly title?: string;
	readonly narrative?: string;
	readonly keyDecisions?: ReadonlyArray<string>;
	readonly filesModified?: ReadonlyArray<string>;
}

/**
 * 按与 query 的词汇重叠度过滤 session 摘要（2026-08-21，日志 1787289570191）。
 *
 * ## 问题
 *
 * `retrieveContextOnly` 原先无条件把 `getCompactContext(agentId, 5)` 的最近 5 个
 * session 摘要全量注入，**完全不看当前 query 相关性**，且优先级高于带 query 的
 * 语义检索 `recallFormatted`。日志实证：用户问「工作流连线菜单缺删除选项」，
 * 注入的上下文里混进了无关 kanban 任务「共享设置脚手架」，模型被迫花 2 整轮辨识：
 *   "This task_1786900273490_c4l8t40 appears to be an unrelated kanban task..."
 *   "I'll ignore the unrelated kanban reminder..."
 * 除浪费 token 外还有**误导风险**（模型可能真去做那个任务）。
 *
 * ## 策略：保守过滤，只丢「零重叠」
 *
 * 仅当某摘要与 query **没有任何**共同 token 时才丢弃。理由：
 *  - 记忆检索的价值在于召回"我可能忘了但相关"的历史，过度过滤会削弱它；
 *  - 判定用的是粗分词，边缘相关的摘要本就该保留（宁可多带一点上下文）。
 *
 * 全部被判定为无关时**返回空数组**，由调用方回退到 `recallFormatted`
 * （带 query 的语义检索），而不是硬塞无关内容 —— 这才是正确的降级方向。
 *
 * @returns 保留的摘要子集（保持原顺序）
 */
export function filterRelevantSessionSummaries<T extends ISessionSummaryLike>(
	summaries: ReadonlyArray<T>,
	query: string,
): T[] {
	const queryTokens = tokenizeForRelevance(query);
	// query 无有效 token（如纯符号/极短）→ 无从判断，全部保留（不做无依据的过滤）
	if (queryTokens.size === 0) { return [...summaries]; }

	return summaries.filter(s => {
		const summaryText = [
			s.title ?? '',
			s.narrative ?? '',
			(s.keyDecisions ?? []).join(' '),
			(s.filesModified ?? []).join(' '),
		].join(' ');
		const summaryTokens = tokenizeForRelevance(summaryText);
		if (summaryTokens.size === 0) { return false; } // 空摘要无信息量，丢弃
		for (const t of summaryTokens) {
			if (queryTokens.has(t)) { return true; } // 有任一重叠即保留
		}
		return false;
	});
}

/**
 * 仅检索：从记忆系统取回相关上下文，替代同步 LLM 摘要。
 */
export async function retrieveContextOnly(
	provider: any,
	agentId: string,
	sessionId: string,
	middle: ReadonlyArray<any>,
	budget: number,
): Promise<{ context: string; tokens: number; source: string } | null> {
	try {
		let query = 'current task context';
		for (let i = middle.length - 1; i >= 0; i--) {
			const m = middle[i];
			if (m && m.role === 'user') {
				const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
				if (c.trim()) { query = c.slice(0, 300); break; }
			}
		}

		let context = '';
		let source = 'recall';
		const compactCtx = await provider.getCompactContext?.(agentId, 5);
		if (Array.isArray(compactCtx) && compactCtx.length > 0) {
			// ★ 相关性过滤（见 filterRelevantSessionSummaries 注释）：
			// getCompactContext 只按"最近"取，不看 query —— 无关跨域会话（如 kanban
			// 任务摘要）会被无条件注入，既浪费预算又可能误导模型去做别的任务。
			// 全部无关时留空 → 下面自动回退到带 query 的语义检索 recallFormatted。
			const relevant = filterRelevantSessionSummaries(compactCtx, query);
			if (relevant.length > 0) {
				context = relevant.map((s: any) =>
					`## ${s.title ?? 'Session'}\n${s.narrative ?? ''}\n` +
					`Decisions: ${(s.keyDecisions || []).join('; ')}\n` +
					`Files: ${(s.filesModified || []).join(', ')}`
				).join('\n\n');
				source = relevant.length < compactCtx.length
					? `compact_context(filtered ${relevant.length}/${compactCtx.length})`
					: 'compact_context';
			}
		}
		if (!context) {
			const recalled: unknown = await provider.recallFormatted(agentId, query, undefined, 10);
			if (typeof recalled === 'string' && recalled && !recalled.startsWith('memory_recall: no results')) {
				context = recalled;
				source = 'recall';
			}
		}
		if (!context) { return null; }
		const tokens = Math.ceil(context.length / 3);
		return { context, tokens, source };
	} catch {
		return null;
	}
}

/**
 * 压缩期检索式上下文：先增量外置 middle 到记忆，再检索。
 */
export async function retrieveCompactionContext(
	provider: any,
	deps: ContextRetrievalDeps,
	req: { agentId: string; sessionId: string; middle: ReadonlyArray<any>; contextWindow: number; budget: number },
): Promise<{ context: string; tokens: number; source: string } | null> {
	storeTurnObservations(deps, provider, req.agentId, req.sessionId, req.middle).catch(() => {});
	return retrieveContextOnly(provider, req.agentId, req.sessionId, req.middle, req.budget);
}

/**
 * 将对话增量外置为 episodic 记忆。按内容哈希去重，跳过 system 消息。
 */
/**
 * turn 消息观察写入（2026-07-25 存储频率优化 P0）：
 * 从 writeMemory（mem:memories 长期层）改道 provider.observe（mem:obs:<agent>:<session>
 * 会话暂存层，原版 mem::observe 语义）——便宜 KV set + 滑动窗口上限 +
 * 阈值自动触发 compressSession，不再走完整 remember 管线（指纹去重全表扫描）。
 * 内容哈希去重防洪闸保留（同 turn 重复调用/重试不会重复写入）。
 */
export async function storeTurnObservations(
	deps: ContextRetrievalDeps,
	provider: any,
	agentId: string,
	sessionId: string,
	messages: ReadonlyArray<any>,
): Promise<void> {
	const seen = deps.getStoredHashes(sessionId);
	for (const m of messages) {
		if (!m || m.role === 'system') { continue; }
		const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
		const text = content.trim();
		if (text.length < 8) { continue; }
		let hash = 0;
		for (let i = 0; i < text.length; i++) { hash = (hash * 31 + text.charCodeAt(i)) | 0; }
		const key = String(hash);
		if (seen.has(key)) { continue; }
		seen.add(key);
		await provider.observe(agentId, {
			sessionId,
			hookType: 'turn_observation',
			timestamp: new Date().toISOString(),
			data: { role: m.role ?? 'unknown', content: `[${m.role ?? 'unknown'}] ${text.slice(0, 1500)}` },
		}).catch(() => {});
	}
}

/**
 * 把检索到的上下文作为独立 system 消息注入（放在固定 system 之后、user 之前）。
 * 使用 RETRIEVED_CTX_PREFIX，使压缩时 contextManager 会剥离它。
 */
export function injectRetrievalSystemMessage(messages: any[], context: string, _source: string): any[] {
	const already = messages.some(
		m => m?.role === 'system'
			&& typeof m.content === 'string'
			&& m.content.startsWith(RETRIEVED_CTX_PREFIX),
	);
	if (already) { return messages; }
	const wrapped = `${RETRIEVED_CTX_PREFIX}\n${context}`;
	let insertIdx = 0;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]?.role === 'system') { insertIdx = i + 1; } else { break; }
	}
	return insertMessages(messages, insertIdx, { role: 'system', content: wrapped });
}
