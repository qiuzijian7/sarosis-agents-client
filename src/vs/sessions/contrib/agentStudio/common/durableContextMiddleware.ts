/*---------------------------------------------------------------------------------------------
 *  Durable Context Middleware — 委托信息在摘要压缩后不丢失
 *
 *  Inspired by deer-flow's durable_context_middleware.py.
 *
 *  Purpose:
 *  - Captures the delegation ledger (and other critical context) into a
 *    separate "durable" state channel that IS NOT subject to message summarization
 *  - Before each LLM inference call, injects the durable context as a hidden
 *    system message so the model always has visibility into prior delegations
 *  - Ensures delegation information survives context-window compression and
 *    summarization (where older messages might be dropped or truncated)
 *
 *  Design (aligned with deer-flow):
 *  1. On each tool call round, the DelegationLedgerManager state is captured
 *     into a serializable DurableContext snapshot
 *  2. Before each LLM inference call, the snapshot is rendered and injected
 *     as a system message (wrapped in <durable_context_data> tags to mark it as
 *     non-user-facing metadata)
 *  3. The durable context is checkpointed along with conversation state so it
 *     persists across session restarts
 *  4. Only the DelegationLedger + critical skill context + active plan status
 *     are included — NOT the full conversation history
 *
 *  Tags: Inspired by deer-flow's `<durable_context_data>` wrapper which
 *  ensures downstream summarization middleware recognizes and preserves
 *  this block.
 *--------------------------------------------------------------------------------------------*/

import type { DelegationEntry } from './delegationLedger.js';
import { renderDelegationLedger } from './delegationLedger.js';

// ─── Constants ────────────────────────────────────────────────────────────

/** XML tag wrapper for durable context in system messages. */
export const DURABLE_CONTEXT_OPEN_TAG = '<durable_context_data>';
export const DURABLE_CONTEXT_CLOSE_TAG = '</durable_context_data>';

/** Character budget for the entire durable context block. */
const DURABLE_CONTEXT_CHAR_BUDGET = 8000;

/** Key used for checkpoint persistence in workspace storage. */
export const DURABLE_CONTEXT_STORAGE_KEY = 'agentOS.durableContext';

// ─── Durable Context Types ────────────────────────────────────────────────

/** Serializable snapshot of durable context for checkpoint persistence. */
export interface DurableContextSnapshot {
	/** Delegation ledger entries (serialized). */
	delegationLedger?: ReadonlyArray<DelegationEntry>;
	/** Active plan/goal status (if any). */
	activeGoal?: string;
	/** Critical skill context that must survive summarization. */
	skillContext?: string;
	/** Last updated timestamp (ISO 8601). */
	updatedAt: string;
}

// ─── Durable Context Manager ──────────────────────────────────────────────

/**
 * Manages the durable context lifecycle.
 *
 * Usage pattern (per agent session):
 * ```
 * const manager = new DurableContextManager();
 *
 * // Before each LLM call:
 * const systemBlock = manager.buildDurableContextBlock();
 * // → inject systemBlock as a system message into the conversation
 *
 * // After sub-agent delegation updates:
 * manager.updateFromLedger(delegationEntries);
 *
 * // On checkpoint:
 * const snapshot = manager.snapshot();
 * ```
 */
export class DurableContextManager {
	private _delegationEntries: DelegationEntry[] = [];
	private _activeGoal: string = '';
	private _skillContext: string = '';

	constructor(snapshot?: DurableContextSnapshot) {
		if (snapshot) {
			this._delegationEntries = [...(snapshot.delegationLedger ?? [])];
			this._activeGoal = snapshot.activeGoal ?? '';
			this._skillContext = snapshot.skillContext ?? '';
		}
	}

	/** Update the delegation ledger portion of the durable context. */
	updateFromLedger(entries: DelegationEntry[]): void {
		this._delegationEntries = [...entries];
	}

	/** Set the active goal text. */
	setActiveGoal(goal: string): void {
		this._activeGoal = goal;
	}

	/** Set persistent skill context. */
	setSkillContext(ctx: string): void {
		this._skillContext = ctx;
	}

	/** Build the full durable context block for injection into the system prompt. */
	buildDurableContextBlock(): string {
		const parts: string[] = [];

		if (this._delegationEntries.length > 0) {
			const ledgerText = renderDelegationLedger(this._delegationEntries);
			parts.push(ledgerText);
		}

		if (this._activeGoal) {
			parts.push(`## Active Goal\n${this._activeGoal}`);
		}

		if (this._skillContext) {
			parts.push(`## Skill Context\n${this._skillContext}`);
		}

		if (parts.length === 0) { return ''; }

		let result = parts.join('\n\n');
		if (result.length > DURABLE_CONTEXT_CHAR_BUDGET) {
			result = result.slice(0, DURABLE_CONTEXT_CHAR_BUDGET - 50) + '\n\n... (context truncated)';
		}

		return `${DURABLE_CONTEXT_OPEN_TAG}\n${result}\n${DURABLE_CONTEXT_CLOSE_TAG}`;
	}

	/** Check if there is any durable context to inject. */
	hasContext(): boolean {
		return this._delegationEntries.length > 0 || this._activeGoal.length > 0 || this._skillContext.length > 0;
	}

	/** Serialize to a snapshot for checkpoint persistence. */
	snapshot(): DurableContextSnapshot {
		return {
			delegationLedger: this._delegationEntries.length > 0
				? this._delegationEntries.map(e => ({ ...e }))
				: undefined,
			activeGoal: this._activeGoal || undefined,
			skillContext: this._skillContext || undefined,
			updatedAt: new Date().toISOString(),
		};
	}

	/** Restore from a previously saved snapshot. */
	restore(snapshot: DurableContextSnapshot): void {
		this._delegationEntries = [...(snapshot.delegationLedger ?? [])];
		this._activeGoal = snapshot.activeGoal ?? '';
		this._skillContext = snapshot.skillContext ?? '';
	}

	/** Clear all durable context. */
	reset(): void {
		this._delegationEntries = [];
		this._activeGoal = '';
		this._skillContext = '';
	}
}

// ─── Injection Helper ────────────────────────────────────────────────────

/**
 * Build a system message containing the durable context.
 * Safe to call before every LLM inference turn — returns undefined if
 * there is no durable context to inject.
 */
export function buildDurableContextSystemMessage(
	manager: DurableContextManager,
): { role: 'system'; content: string } | undefined {
	if (!manager.hasContext()) { return undefined; }
	const block = manager.buildDurableContextBlock();
	if (!block) { return undefined; }
	return { role: 'system', content: block };
}
