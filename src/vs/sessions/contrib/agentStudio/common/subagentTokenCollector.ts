/*---------------------------------------------------------------------------------------------
 *  Subagent Token Collector — Token 预算独立追踪
 *
 *  Inspired by deer-flow's subagents/token_collector.py and SubagentTokenCollector.
 *
 *  Purpose:
 *  - Track token usage (input + output) independently for each sub-agent
 *  - Accumulate usage across multiple LLM turns within a single sub-agent execution
 *  - Provide per-sub-agent cost visibility to the parent agent
 *  - Support global aggregation across all sub-agents in a session
 *
 *  Design (aligned with deer-flow):
 *  1. Each sub-agent gets its own SubagentTokenCollector instance at spawn time
 *  2. Usage deltas from the LLM provider stream are fed to the collector
 *  3. At sub-agent completion, the aggregated usage is attached to SubAgentResult
 *  4. A global TokenUsageLedger aggregates across all sub-agents for session-level
 *     cost tracking
 *
 *  Key difference from deer-flow:
 *  - deer-flow uses Langfuse for external usage reporting
 *  - Saros stores usage in-memory and exposes it via SubAgentResult.tokensUsed
 *    and optionally via a usage ledger for dashboard consumption
 *--------------------------------------------------------------------------------------------*/

// ─── Types ────────────────────────────────────────────────────────────────

/** Token usage snapshot for a single LLM turn. */
export interface TokenUsageDelta {
	/** Input (prompt) tokens for this turn. */
	readonly inputTokens: number;
	/** Output (completion) tokens for this turn. */
	readonly outputTokens: number;
	/** Optional: cache hit tokens (for providers that support prompt caching). */
	readonly cacheHitTokens?: number;
	/** Optional: cache write tokens. */
	readonly cacheWriteTokens?: number;
	/** Optional: reasoning tokens (for reasoning models like o1). */
	readonly reasoningTokens?: number;
}

/** Aggregated token usage for a completed sub-agent. */
export interface SubagentTokenUsage {
	/** Total input (prompt) tokens across all turns. */
	totalInputTokens: number;
	/** Total output (completion) tokens across all turns. */
	totalOutputTokens: number;
	/** Total cache hit tokens. */
	totalCacheHitTokens: number;
	/** Total cache write tokens. */
	totalCacheWriteTokens: number;
	/** Total reasoning tokens. */
	totalReasoningTokens: number;
	/** Number of LLM turns. */
	turnCount: number;
	/** Per-turn breakdown (for detailed analysis). */
	perTurnUsage: TokenUsageDelta[];
}

/** A single entry in the global usage ledger. */
export interface UsageLedgerEntry {
	subAgentId: string;
	subAgentType: string;
	task: string;
	startedAt: number;
	completedAt: number;
	usage: SubagentTokenUsage;
}

// ─── Subagent Token Collector ─────────────────────────────────────────────

/**
 * Per-sub-agent token usage collector.
 *
 * Instantiated at sub-agent spawn time and fed usage deltas from the
 * LLM provider stream during execution.
 */
export class SubagentTokenCollector {
	private _totalInputTokens = 0;
	private _totalOutputTokens = 0;
	private _totalCacheHitTokens = 0;
	private _totalCacheWriteTokens = 0;
	private _totalReasoningTokens = 0;
	private _turnCount = 0;
	private _perTurnUsage: TokenUsageDelta[] = [];

	/** Record token usage from a single LLM turn. */
	recordUsage(delta: TokenUsageDelta): void {
		this._totalInputTokens += delta.inputTokens;
		this._totalOutputTokens += delta.outputTokens;
		this._totalCacheHitTokens += delta.cacheHitTokens ?? 0;
		this._totalCacheWriteTokens += delta.cacheWriteTokens ?? 0;
		this._totalReasoningTokens += delta.reasoningTokens ?? 0;
		this._turnCount++;
		this._perTurnUsage.push({ ...delta });
	}

	/**
	 * Merge partial usage from consecutive usage events within a single turn.
	 * Some providers emit multiple usage events per turn (e.g., separate
	 * input cache read vs. non-cache input calculations).
	 *
	 * This method merges the last recorded turn's usage with the new delta
	 * rather than creating a new turn entry.
	 */
	mergeUsage(delta: TokenUsageDelta): void {
		this._totalInputTokens += delta.inputTokens;
		this._totalOutputTokens += delta.outputTokens;
		this._totalCacheHitTokens += delta.cacheHitTokens ?? 0;
		this._totalCacheWriteTokens += delta.cacheWriteTokens ?? 0;
		this._totalReasoningTokens += delta.reasoningTokens ?? 0;

		// Merge into the last turn entry if it exists
		if (this._perTurnUsage.length > 0) {
			const last = this._perTurnUsage[this._perTurnUsage.length - 1];
			this._perTurnUsage[this._perTurnUsage.length - 1] = {
				inputTokens: last.inputTokens + delta.inputTokens,
				outputTokens: last.outputTokens + delta.outputTokens,
				cacheHitTokens: (last.cacheHitTokens ?? 0) + (delta.cacheHitTokens ?? 0),
				cacheWriteTokens: (last.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
				reasoningTokens: (last.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0),
			};
		}
	}

	/** Get the aggregated usage snapshot. */
	getUsage(): SubagentTokenUsage {
		return {
			totalInputTokens: this._totalInputTokens,
			totalOutputTokens: this._totalOutputTokens,
			totalCacheHitTokens: this._totalCacheHitTokens,
			totalCacheWriteTokens: this._totalCacheWriteTokens,
			totalReasoningTokens: this._totalReasoningTokens,
			turnCount: this._turnCount,
			perTurnUsage: [...this._perTurnUsage],
		};
	}

	/** Get total tokens (input + output). */
	get totalTokens(): number {
		return this._totalInputTokens + this._totalOutputTokens;
	}

	/** Get a compact summary string suitable for logging. */
	getSummary(): string {
		return `Tokens: ${this._totalInputTokens} in / ${this._totalOutputTokens} out (${this._turnCount} turns)`;
	}

	/** Reset the collector for reuse. */
	reset(): void {
		this._totalInputTokens = 0;
		this._totalOutputTokens = 0;
		this._totalCacheHitTokens = 0;
		this._totalCacheWriteTokens = 0;
		this._totalReasoningTokens = 0;
		this._turnCount = 0;
		this._perTurnUsage = [];
	}
}

// ─── Global Usage Ledger ──────────────────────────────────────────────────

/**
 * Session-level ledger that aggregates token usage across all sub-agents.
 *
 * Used for cost tracking, dashboard display, and budget enforcement
 * across multiple sub-agent invocations within a single parent session.
 */
export class TokenUsageLedger {
	private _entries: UsageLedgerEntry[] = [];

	/** Record a completed sub-agent's usage. */
	recordCompletion(
		subAgentId: string,
		subAgentType: string,
		task: string,
		startedAt: number,
		completedAt: number,
		usage: SubagentTokenUsage,
	): void {
		this._entries.push({
			subAgentId,
			subAgentType,
			task,
			startedAt,
			completedAt,
			usage,
		});
	}

	/** Get all entries. */
	get entries(): ReadonlyArray<UsageLedgerEntry> {
		return this._entries;
	}

	/** Get the number of completed sub-agents. */
	get subagentCount(): number {
		return this._entries.length;
	}

	/** Get total tokens used across all sub-agents. */
	get totalTokens(): { input: number; output: number; total: number } {
		let input = 0;
		let output = 0;
		for (const e of this._entries) {
			input += e.usage.totalInputTokens;
			output += e.usage.totalOutputTokens;
		}
		return { input, output, total: input + output };
	}

	/** Get total LLM turns across all sub-agents. */
	get totalTurns(): number {
		return this._entries.reduce((sum, e) => sum + e.usage.turnCount, 0);
	}

	/** Get a compact summary string for the entire session. */
	getSummary(): string {
		const { input, output, total } = this.totalTokens;
		return `Session: ${this.subagentCount} sub-agents, ${this.totalTurns} turns, ${input} in / ${output} out (${total} total tokens)`;
	}

	/** Clear all entries. */
	reset(): void {
		this._entries = [];
	}
}

// ─── Convenience Factory ─────────────────────────────────────────────────

/**
 * Create a SubagentTokenCollector pre-seeded with a usage event parsed
 * from the common LLM provider usage format.
 */
export function createTokenCollectorFromUsage(
	inputTokens: number,
	outputTokens: number,
): SubagentTokenCollector {
	const collector = new SubagentTokenCollector();
	collector.recordUsage({
		inputTokens,
		outputTokens,
	});
	return collector;
}
