/*---------------------------------------------------------------------------------------------
 *  Delegation Ledger — 委托历史专门通道
 *
 *  Inspired by deer-flow's delegation_ledger.py.
 *
 *  Purpose:
 *  - Deterministically extracts sub-agent delegate_task calls from LLM conversation history
 *  - Renders a concise, status-aware ledger for injection into the system prompt
 *  - Prevents the LLM from re-delegating tasks that are already in-progress or completed
 *
 *  Design (aligned with deer-flow):
 *  1. Scan message history for AIMessage → tool_calls named 'delegate_task' / 'task'
 *  2. Match each tool_call to its ToolMessage by tool_call_id
 *  3. Extract task description and completion status from the result metadata
 *  4. Render a compact ledger (< 6000 chars) with per-entry status guidance
 *  5. The ledger is injected into the system prompt so the LLM always "sees" prior delegations
 *
 *  The output format is plain text designed for LLM consumption:
 *
 *    ## Delegation Ledger
 *    1. [completed] "Explore the auth module" (subagent: explore) — completed result; do NOT delegate again; reuse
 *    2. [in_progress] "Analyze the database schema" (subagent: general) — already delegated; do NOT delegate again
 *--------------------------------------------------------------------------------------------*/

// ─── Types ────────────────────────────────────────────────────────────────

/** Status of a single delegation entry. */
export type DelegationStatus =
	| 'in_progress'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'timed_out';

/** An immutable entry in the delegation ledger. */
export interface DelegationEntry {
	/** Unique ID (maps to the tool_call_id) */
	readonly callId: string;
	/** The subagent type used (explore / general / scout) */
	readonly subagentType: string;
	/** Human-readable task description (from tool_call arguments, truncated to 200 chars) */
	readonly taskDescription: string;
	/** Current status */
	readonly status: DelegationStatus;
	/** Brief result text (truncated) — only for completed/failed */
	readonly resultBrief?: string;
	/** When the delegation was made (ISO 8601) */
	readonly createdAt: string;
	/** When the delegation finished (ISO 8601) */
	readonly completedAt?: string;
}

// ─── Rendering constants (aligned with deer-flow) ───────────────────────

/** Max chars for the full rendered ledger text. */
const LEDGER_RENDER_CHAR_BUDGET = 6000;
/** Max chars for each entry's result brief. */
const LEDGER_ENTRY_RESULT_RENDER_CAP = 120;
/** Max chars for the task description heading. */
const DESCRIPTION_CAP = 200;
/** Max chars for the result body (before truncation). */
const RESULT_BRIEF_CAP = 2000;

// ─── Status-only result briefs (avoid wasting budget on predictable text) ─

const STATUS_ONLY_RESULT_BRIEFS: Record<DelegationStatus, string> = {
	in_progress: '(still running)',
	completed: '(see result below)',
	failed: 'Task failed.',
	cancelled: 'Task cancelled by user.',
	timed_out: 'Task timed out.',
};

// ─── Status guidance (injected as inline hints) ─────────────────────────

const STATUS_GUIDANCE: Record<DelegationStatus, string> = {
	in_progress: 'already delegated; do NOT delegate again; wait for or build on the result',
	completed: 'completed result; do NOT delegate again; reuse this result',
	failed: 'failed attempt; may retry with a changed plan',
	cancelled: 'cancelled attempt; may retry with a changed plan',
	timed_out: 'timed-out attempt; may retry with a changed plan',
};

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Deterministic head/tail truncation. This is NOT an LLM summary — it's a pure string op. */
function boundText(text: string, cap: number = RESULT_BRIEF_CAP): string {
	if (text.length <= cap) { return text; }
	if (cap <= 0) { return ''; }
	const head = Math.floor(cap * 2 / 3);
	const omittedMarker = '\n...\n';
	if (cap <= omittedMarker.length) { return text.slice(0, cap); }
	const tail = cap - head - omittedMarker.length;
	if (tail <= 0) { return text.slice(0, cap); }
	return text.slice(0, head) + omittedMarker + text.slice(-tail);
}

/** Collapse whitespace for compact rendering. */
function compactText(value: unknown): string {
	return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Extract a human-readable task description from tool-call arguments. */
function extractTaskDescription(args: Record<string, unknown>): string {
	const task = args.task ?? args.description ?? args.prompt ?? args.message ?? args.query ?? '';
	return boundText(compactText(task), DESCRIPTION_CAP);
}

/** Build a single ledger line with inline status guidance. */
function renderEntry(entry: DelegationEntry, index: number): string {
	const statusLine = `[${entry.status}]`;
	const guidance = STATUS_GUIDANCE[entry.status];
	const typeHint = entry.subagentType ? ` (${entry.subagentType})` : '';
	const desc = entry.taskDescription || '(no description)';

	let resultLine = '';
	if (entry.resultBrief) {
		const brief = boundText(entry.resultBrief, LEDGER_ENTRY_RESULT_RENDER_CAP);
		resultLine = `\n   result: ${compactText(brief)}`;
	}

	return `${index}. ${statusLine} "${desc}"${typeHint}\n   ${guidance}${resultLine}`;
}

// ─── Message Model (minimal — avoids pulling in LangChain-style types) ──

/** Minimal message interface for ledger scanning. */
export interface LedgerMessage {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content?: string | null;
	toolCalls?: ReadonlyArray<LedgerToolCall>;
	toolCallId?: string;
	name?: string;
}

export interface LedgerToolCall {
	id: string;
	name: string;
	args?: Record<string, unknown>;
}

/** The set of tool names that the ledger recognizes as delegation calls. */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
	'delegate_task',
	'task',
	'spawn_subagent',
	'dispatch_subagent',
]);

// ─── Ledger Extraction ────────────────────────────────────────────────────

/**
 * Scan message history and extract all delegation entries.
 *
 * This is deterministic — it scans for AIMessages with tool_calls matching
 * DELEGATION_TOOL_NAMES, then pairs them with corresponding ToolMessages to
 * infer completion status.
 */
export function extractDelegationLedger(
	messages: ReadonlyArray<LedgerMessage>,
	knownTerminalStatuses?: Map<string, DelegationStatus>,
): DelegationEntry[] {
	const entries: DelegationEntry[] = [];
	const toolResultMap = new Map<string, string>();

	// Pass 1: collect ToolMessage results keyed by tool_call_id
	for (const msg of messages) {
		if (msg.role === 'tool' && msg.toolCallId && msg.content != null) {
			toolResultMap.set(msg.toolCallId, msg.content);
		}
	}

	// Pass 2: scan AIMessages for delegation tool calls
	for (const msg of messages) {
		if (msg.role !== 'assistant' || !msg.toolCalls?.length) { continue; }

		for (const tc of msg.toolCalls) {
			if (!DELEGATION_TOOL_NAMES.has(tc.name)) { continue; }

			const args = tc.args ?? {};

			// Determine status
			let status: DelegationStatus;
			let resultBrief: string | undefined;

			// Check known terminal statuses first (from live tracking)
			if (knownTerminalStatuses?.has(tc.id)) {
				status = knownTerminalStatuses.get(tc.id)!;
				const resultText = toolResultMap.get(tc.id);
				if (resultText) {
					resultBrief = boundText(resultText, RESULT_BRIEF_CAP);
				}
			} else {
				const resultText = toolResultMap.get(tc.id);
				if (resultText) {
					// If we have a result, it's done; detect failure from content
					const isProbablyFailed =
						resultText.toLowerCase().includes('error') ||
						resultText.toLowerCase().includes('failed') ||
						resultText.toLowerCase().includes('[task_failed]');
					status = isProbablyFailed ? 'failed' : 'completed';
					resultBrief = boundText(resultText, RESULT_BRIEF_CAP);
				} else {
					// No result yet → still running
					status = 'in_progress';
				}
			}

			const description = extractTaskDescription(args);
			const subagentType = String(args.agent_type ?? args.subagent_type ?? args.type ?? '');

			entries.push({
				callId: tc.id,
				subagentType,
				taskDescription: description,
				status,
				resultBrief,
				createdAt: new Date().toISOString(), // approximate
			});
		}
	}

	return entries;
}

// ─── Ledger Rendering ─────────────────────────────────────────────────────

/**
 * Render the delegation ledger as a compact text block for injection into
 * the system prompt. The output fits within LEDGER_RENDER_CHAR_BUDGET chars.
 *
 * Returns an empty string if there are no entries.
 */
export function renderDelegationLedger(entries: DelegationEntry[]): string {
	if (entries.length === 0) { return ''; }

	const lines: string[] = ['## Delegation Ledger'];
	let charBudget = LEDGER_RENDER_CHAR_BUDGET - lines[0].length;

	// Render the most recent entries first (LLMs attend to beginning of context more)
	const recent = entries.slice(-10); // Max 10 entries to keep the ledger tight

	for (let i = 0; i < recent.length; i++) {
		const entry = recent[i];
		const line = renderEntry(entry, i + 1);
		if (charBudget - line.length - 1 < 0) { break; } // budget exhausted
		lines.push(line);
		charBudget -= line.length + 1;
	}

	return lines.join('\n');
}

// ─── Delegation Ledger Manager (live tracking for in-flight sub-agents) ──

/**
 * Live tracker for sub-agent delegation status.
 *
 * Call `markDelegated` when a delegate_task tool call is dispatched.
 * Call `markCompleted` / `markFailed` / `markCancelled` / `markTimedOut`
 * when the sub-agent terminates.
 *
 * The `toSnapshot()` method produces a Map suitable for passing into
 * `extractDelegationLedger()` as `knownTerminalStatuses`.
 */
export class DelegationLedgerManager {
	private readonly _delegations = new Map<string, DelegationEntry>();

	/** Register a new delegation (called when delegate_task tool begins execution). */
	markDelegated(callId: string, taskDescription: string, subagentType: string): void {
		this._delegations.set(callId, {
			callId,
			subagentType,
			taskDescription: boundText(compactText(taskDescription), DESCRIPTION_CAP),
			status: 'in_progress',
			createdAt: new Date().toISOString(),
		});
	}

	/** Mark a delegation as completed with a result. */
	markCompleted(callId: string, resultText?: string): void {
		const entry = this._delegations.get(callId);
		if (entry) {
			this._delegations.set(callId, {
				...entry,
				status: 'completed',
				resultBrief: resultText ? boundText(resultText, RESULT_BRIEF_CAP) : undefined,
				completedAt: new Date().toISOString(),
			});
		}
	}

	/** Mark a delegation as failed with an error. */
	markFailed(callId: string, errorText?: string): void {
		const entry = this._delegations.get(callId);
		if (entry) {
			this._delegations.set(callId, {
				...entry,
				status: 'failed',
				resultBrief: errorText ? boundText(errorText, RESULT_BRIEF_CAP) : undefined,
				completedAt: new Date().toISOString(),
			});
		}
	}

	/** Mark a delegation as cancelled. */
	markCancelled(callId: string): void {
		const entry = this._delegations.get(callId);
		if (entry) {
			this._delegations.set(callId, {
				...entry,
				status: 'cancelled',
				resultBrief: STATUS_ONLY_RESULT_BRIEFS.cancelled,
				completedAt: new Date().toISOString(),
			});
		}
	}

	/** Mark a delegation as timed out. */
	markTimedOut(callId: string): void {
		const entry = this._delegations.get(callId);
		if (entry) {
			this._delegations.set(callId, {
				...entry,
				status: 'timed_out',
				resultBrief: STATUS_ONLY_RESULT_BRIEFS.timed_out,
				completedAt: new Date().toISOString(),
			});
		}
	}

	/** Get all entries (including in_progress). */
	getAllEntries(): DelegationEntry[] {
		return Array.from(this._delegations.values());
	}

	/** Get active (in_progress) count. */
	get activeCount(): number {
		let count = 0;
		for (const e of this._delegations.values()) {
			if (e.status === 'in_progress') { count++; }
		}
		return count;
	}

	/** Get completed + failed count. */
	get completedCount(): number {
		let count = 0;
		for (const e of this._delegations.values()) {
			if (e.status === 'completed' || e.status === 'failed') { count++; }
		}
		return count;
	}

	/** Produce a snapshot of terminal statuses for extractDelegationLedger(). */
	toSnapshot(): Map<string, DelegationStatus> {
		const snap = new Map<string, DelegationStatus>();
		for (const [id, entry] of this._delegations.entries()) {
			snap.set(id, entry.status);
		}
		return snap;
	}

	/** Render the current ledger as compact text. */
	render(): string {
		return renderDelegationLedger(this.getAllEntries());
	}

	/** Clear all entries (e.g., on session reset). */
	reset(): void {
		this._delegations.clear();
	}

	/** Get a specific entry by callId. */
	getEntry(callId: string): DelegationEntry | undefined {
		return this._delegations.get(callId);
	}
}
