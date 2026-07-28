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
			context = compactCtx.map((s: any) =>
				`## ${s.title ?? 'Session'}\n${s.narrative ?? ''}\n` +
				`Decisions: ${(s.keyDecisions || []).join('; ')}\n` +
				`Files: ${(s.filesModified || []).join(', ')}`
			).join('\n\n');
			source = 'compact_context';
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
