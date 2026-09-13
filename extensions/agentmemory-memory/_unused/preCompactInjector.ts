/*---------------------------------------------------------------------------------------------
 *  预压缩注入 — 在上下文压缩前注入相关记忆。
 *  参考 agentmemory src/hooks/pre-compact.ts
 *
 *  优化 (P2+P3):
 *    P2: 搜索相关性 — 用最后一条用户消息作为主搜索 query，加权关键词匹配
 *    P3: 4-Tier 优先级 — Procedural(40%) > Semantic(30%) > Episodic(20%) > Working(10%)
 *
 *  注入策略：
 *    1. 固定槽位 (persona/guidance) — 最高优先级，不受 tier 预算限制
 *    2. Procedural (persona/workflow) — 40% 剩余预算
 *    3. Semantic (scene/architecture) — 30% 剩余预算
 *    4. Episodic (long_term/pattern/preference/bug/fact) — 20% 剩余预算
 *    5. Working (short_term) — 10% 剩余预算
 *    6. 滑动窗口 — 填充剩余
 *--------------------------------------------------------------------------------------------*/

export interface PreCompactContext {
	sessionId: string;
	agentId: string;
	currentMessages: Array<{ role: string; content: string; timestamp: number }>;
	tokenBudget: number;
}

export interface PreCompactResult {
	injectedContext: string;
	sources: Array<{
		source: string;
		tokens: number;
		content: string;
	}>;
	totalTokens: number;
}

export interface InjectEntry {
	id: string;
	content: string;
	score: number;
	importance?: number;
	type: string;
	timestamp: number;
	metadata?: Record<string, unknown>;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

const MAX_ENTRY_TOKENS = 200;

// ─── 4-Tier classification ────────────────────────────────────────────────────

type Tier = 'procedural' | 'semantic' | 'episodic' | 'working';

const TIER_BUDGET_RATIO: Record<Tier, number> = {
	procedural: 0.40,
	semantic: 0.30,
	episodic: 0.20,
	working: 0.10,
};

function classifyTier(entry: InjectEntry): Tier {
	// Direct 4-Tier type matching — no more TDB-AM legacy mapping
	if (entry.type === 'procedural') return 'procedural';
	if (entry.type === 'semantic') return 'semantic';
	if (entry.type === 'working') return 'working';
	return 'episodic'; // default
}

const TIER_LABEL: Record<Tier, string> = {
	procedural: 'Procedural',
	semantic: 'Semantic',
	episodic: 'Episodic',
	working: 'Working',
};

export class PreCompactInjector {
	/**
	 * 准备预压缩注入内容 — 4-Tier 优先级 + 搜索相关性
	 */
	prepare(
		ctx: PreCompactContext,
		allEntries: InjectEntry[],
		slots?: Array<{ name: string; content: string }>,
		windowEntries?: Array<{ id: string; content: string }>,
	): PreCompactResult {
		const sources: Array<{ source: string; tokens: number; content: string }> = [];
		const injectedIds = new Set<string>(); // P5: dedup tracking
		const budget = Math.min(ctx.tokenBudget, 2000);  // 上限 2000 tokens
		let usedTokens = 0;

		// ── 1. 固定槽位（最高优先级，不受 tier 预算限制）──
		if (slots) {
			for (const slot of slots) {
				if (usedTokens >= budget) break;
				if (!slot.content || slot.content.trim().length === 0) continue;
				const content = slot.content.slice(0, MAX_ENTRY_TOKENS * 4);
				const tokens = estimateTokens(content);
				if (usedTokens + tokens > budget) continue;
				sources.push({ source: `slot:${slot.name}`, tokens, content });
				usedTokens += tokens;
			}
		}

		// ── 2. 提取搜索关键词（P2: 用最后一条用户消息作为主 query）──
		const keywords = this._extractKeywords(ctx.currentMessages);
		const lastUserMsg = this._getLastUserMessage(ctx.currentMessages);

		// Score and classify all entries
		const scored = allEntries
			.filter(e => !e.metadata?.['supersededBy'])
			.map(e => ({
				...e,
				tier: classifyTier(e),
				searchScore: e.score + this._keywordScore(e.content, keywords) + this._userMsgScore(e.content, lastUserMsg),
			}));

		// ── 3. 按 4-Tier 优先级注入（P3）──
		const remainingBudget = budget - usedTokens;
		for (const tier of ['procedural', 'semantic', 'episodic', 'working'] as Tier[]) {
			const tierBudget = Math.floor(remainingBudget * TIER_BUDGET_RATIO[tier]);
			let tierUsed = 0;
			const tierEntries = scored
				.filter(e => e.tier === tier)
				.sort((a, b) => b.searchScore - a.searchScore);

			for (const entry of tierEntries) {
				if (tierUsed >= tierBudget || usedTokens >= budget) break;
				if (injectedIds.has(entry.id)) continue;
				const content = entry.content.slice(0, MAX_ENTRY_TOKENS * 4);
				const tokens = estimateTokens(content);
				if (usedTokens + tokens > budget) continue;
				if (tierUsed + tokens > tierBudget) continue;
				sources.push({ source: `memory:${TIER_LABEL[tier].toLowerCase()}:${entry.id}`, tokens, content });
				injectedIds.add(entry.id);
				usedTokens += tokens;
				tierUsed += tokens;
			}
		}

		// ── 4. 滑动窗口（填充剩余预算）──
		if (windowEntries && usedTokens < budget) {
			for (const wEntry of windowEntries.slice(0, 5)) {
				if (usedTokens >= budget) break;
				if (injectedIds.has(wEntry.id)) continue;
				const content = wEntry.content.slice(0, MAX_ENTRY_TOKENS * 4);
				const tokens = estimateTokens(content);
				if (usedTokens + tokens > budget) continue;
				sources.push({ source: `window:${wEntry.id}`, tokens, content });
				injectedIds.add(wEntry.id);
				usedTokens += tokens;
			}
		}

		// ── 5. 构建注入文本 ──
		const parts: string[] = ['## Preserved Context (from memory)'];
		for (const source of sources) {
			parts.push('', `### ${source.source}`, source.content);
		}

		return {
			injectedContext: parts.join('\n'),
			sources,
			totalTokens: usedTokens,
		};
	}

	/**
	 * 提取关键词 — 从最近 5 条消息中提取
	 */
	private _extractKeywords(messages: Array<{ role: string; content: string }>): Set<string> {
		const keywords = new Set<string>();
		for (const msg of messages.slice(-5)) {
			const words = msg.content.toLowerCase().split(/[\s,.!?;:'"()\[\]{}|\\/<>]+/);
			for (const word of words) {
				if (word.length >= 4 && word.length <= 20) {
					keywords.add(word);
				}
			}
		}
		return keywords;
	}

	/**
	 * 获取最后一条用户消息（P2: 作为主搜索 query）
	 */
	private _getLastUserMessage(messages: Array<{ role: string; content: string }>): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') return messages[i].content;
		}
		return '';
	}

	/**
	 * 关键词匹配分数
	 */
	private _keywordScore(content: string, keywords: Set<string>): number {
		let score = 0;
		const lower = content.toLowerCase();
		for (const keyword of keywords) {
			if (lower.includes(keyword)) score += 0.1;
		}
		return Math.min(score, 2);
	}

	/**
	 * 用户消息匹配分数（P2: 加权最后一条用户消息的关键词）
	 */
	private _userMsgScore(content: string, userMsg: string): number {
		if (!userMsg) return 0;
		const lower = content.toLowerCase();
		const userWords = userMsg.toLowerCase().split(/[\s,.!?;:'"()\[\]{}|\\/<>]+/).filter(w => w.length >= 4);
		let score = 0;
		for (const word of userWords) {
			if (lower.includes(word)) score += 0.15;  // 用户消息关键词加权更高
		}
		return Math.min(score, 3);
	}
}
