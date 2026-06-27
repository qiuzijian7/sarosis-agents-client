/*---------------------------------------------------------------------------------------------
 *  Token 预算管理器 — 自适应上下文注入，替代固定条数限制。
 *  参考 agentmemory src/functions/sliding-window.ts + context.ts
 *
 *  规则：
 *    - 默认 token 预算 2000（可配置）
 *    - 每条记忆估算 token 数（~4 字符 ≈ 1 token）
 *    - 按强度降序填充，直到预算耗尽
 *    - 高强度记忆优先，低强度截断
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_TOKEN_BUDGET = 2000;
const CHARS_PER_TOKEN = 4;

/** Estimate token count for a text string */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BudgetResult<T> {
	/** Entries that fit within the budget */
	selected: T[];
	/** Total tokens used */
	tokensUsed: number;
	/** Whether some entries were truncated to fit */
	truncated: boolean;
	/** Entries that were excluded due to budget */
	excluded: T[];
}

/**
 * Select entries to fit within a token budget, prioritizing by score/strength.
 * Entries are sorted by the `getScore` function descending, then filled until budget is exhausted.
 */
export function selectWithBudget<T>(
	entries: T[],
	budget: number = DEFAULT_TOKEN_BUDGET,
	getScore: (entry: T) => number,
	getText: (entry: T) => string,
): BudgetResult<T> {
	// Sort by score descending
	const sorted = [...entries].sort((a, b) => getScore(b) - getScore(a));

	const selected: T[] = [];
	const excluded: T[] = [];
	let tokensUsed = 0;
	let truncated = false;

	for (const entry of sorted) {
		const tokens = estimateTokens(getText(entry));
		if (tokensUsed + tokens <= budget) {
			selected.push(entry);
			tokensUsed += tokens;
		} else {
			excluded.push(entry);
			truncated = true;
		}
	}

	return { selected, tokensUsed, truncated, excluded };
}

/**
 * Build a context string from entries within a token budget.
 * Includes a header indicating how many entries were included.
 */
export function buildContextString<T>(
	entries: T[],
	budget: number = DEFAULT_TOKEN_BUDGET,
	getScore: (entry: T) => number,
	getText: (entry: T) => string,
	getLabel?: (entry: T) => string,
): { text: string; tokensUsed: number; entryCount: number; truncated: boolean } {
	const result = selectWithBudget(entries, budget, getScore, getText);
	const lines: string[] = [];

	if (getLabel) {
		lines.push(`## Memory Context (${result.selected.length} entries, ~${result.tokensUsed} tokens)`);
	} else {
		lines.push(`## Memory Context (${result.selected.length} entries)`);
	}

	for (const entry of result.selected) {
		const text = getText(entry).replace(/\s+/g, ' ').slice(0, 300);
		lines.push(`- ${text}`);
	}

	if (result.truncated) {
		lines.push(`\n[... ${result.excluded.length} more entries omitted due to token budget]`);
	}

	return {
		text: lines.join('\n'),
		tokensUsed: result.tokensUsed,
		entryCount: result.selected.length,
		truncated: result.truncated,
	};
}
