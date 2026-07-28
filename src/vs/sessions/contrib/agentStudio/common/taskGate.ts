/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TaskGate — DB-truth completion gate (MiMo-Code-inspired, P2d).
 *
 * MiMo-Code's `task/gate.ts` reconciles a sub-agent's self-reported "I'm done"
 * against DB task truth: after a sub-agent finishes, it queries the task table
 * for non-terminal tasks owned by that actor and, if any remain, re-enters the
 * agent with a `<system-reminder>` nudge to finish or abandon them. This is a
 * stronger guarantee than `completionGate.gateResult` (which infers status from
 * the model's output text + observable file/error state): DB truth wins over
 * self-report.
 *
 * We port the *pure decision* half here — no Effect, no DB access, no IO. The
 * caller (agentOSService sub-agent path, future wiring) owns the async query
 * and the re-entry loop; this module only turns `(incompleteTasks, reactCount,
 * maxReact, mode)` into one of three branches:
 *
 *   1. empty      → no re-entry, no cap (clean stop)
 *   2. nudge      → re-enter with a reminder text (agent gets another chance)
 *   3. cap-hit    → stop anyway (bounded — prevents infinite gate loops)
 *
 * This mirrors MiMo-Code's `Decision` type and `decide()` in `task/gate.ts`,
 * but is a plain synchronous function so it is fully unit-testable without a
 * live model / provider / DB.
 *
 * Status taxonomy mapping (our TaskBoardStatus → MiMo-Code actionable filter):
 *   non-terminal actionable: triage / todo / ready / running
 *   non-terminal but NOT actionable: blocked (can't proceed — nudging would loop)
 *   terminal: done / cancelled / archived
 * The caller filters to actionable BEFORE passing `incompleteTasks` here, so
 * this module treats every entry as actionable (mirrors MiMo-Code, which
 * filters `status === 'open' || 'in_progress'` before calling decide).
 */

/** Cap on stop-gate ReAct re-entries for sub-agents (mirrors MiMo-Code). */
export const MAX_TASK_GATE_SUBAGENT_REACT = 2;

/**
 * Cap on stop-gate ReAct re-entries on the main session loop. Higher than the
 * subagent cap because a main session is long-lived and the gate is the last
 * defense before stop (mirrors MiMo-Code).
 */
export const MAX_TASK_GATE_MAIN_REACT = 3;

export type TaskGateMode = 'subagent' | 'main';

/** A non-terminal, actionable task the gate considers "incomplete". */
export interface IIncompleteTask {
	readonly id: string;
	readonly status: string;
	readonly summary: string;
}

/** The three possible outcomes of a gate decision (mirrors MiMo-Code `Decision`). */
export type TaskGateDecision =
	| { readonly needReentry: false; readonly capExceeded: false; readonly incompleteTasks: readonly string[] }
	| { readonly needReentry: true; readonly reentryText: string; readonly incompleteTasks: readonly string[]; readonly capExceeded: false }
	| { readonly needReentry: false; readonly capExceeded: true; readonly incompleteTasks: readonly string[] };

export interface ITaskGateInput {
	/** Non-terminal actionable tasks left on the board for this owner/session. */
	readonly incompleteTasks: readonly IIncompleteTask[];
	/** How many re-entry nudges have already fired (0 on first check). */
	readonly reactCount: number;
	/** Ceiling on re-entries before the gate forces a stop. */
	readonly maxReact: number;
	/**
	 * 'subagent': owner-scoped — every listed task IS owned by the recipient
	 *   (headline says "you own"). 'main': session-scoped — list spans all
	 *   session tasks including subagent-orphaned ones the recipient never
	 *   created (headline says "in this session").
	 */
	readonly mode: TaskGateMode;
}

/**
 * Build the `<system-reminder>` re-entry text injected when incomplete tasks
 * remain. Mirrors MiMo-Code's `buildReentryText` but as a plain function.
 *
 * The headline shifts with mode because owner semantics differ (see ITaskGateInput.mode).
 */
export function buildTaskGateReentryText(
	incomplete: readonly IIncompleteTask[],
	mode: TaskGateMode,
): string {
	const headline =
		mode === 'subagent'
			? 'You are about to finish, but these tasks you own are still unfinished:'
			: 'You are about to finish, but these tasks in this session are still unfinished:';
	const closingLine =
		mode === 'subagent'
			? 'Then re-emit your final message starting with the **Status**/**Summary** header.'
			: 'Then continue or respond.';
	return [
		'<system-reminder>',
		headline,
		...incomplete.map((t) => `- ${t.id} (${t.status}): ${t.summary}`),
		'For EACH: complete the work then mark the task done, or abandon it if it is genuinely not needed.',
		closingLine,
		'</system-reminder>',
	].join('\n');
}

/**
 * Pure decision: turn the incomplete-task list + re-entry counter into one of
 * three branches. The caller owns async DB query, synthetic-message injection,
 * and cap-state management — this function only decides.
 *
 * Mirrors MiMo-Code's `TaskGate.decide` but without Effect/DB. Identical
 * three-branch contract:
 *   - empty list          → { needReentry: false, capExceeded: false }
 *   - non-empty, under cap → { needReentry: true, reentryText, ... }
 *   - non-empty, at/over cap → { needReentry: false, capExceeded: true }
 *
 * The ids-only `incompleteTasks` field on the result lets the caller log /
 * surface which tasks triggered the gate without re-mapping.
 */
export function decideTaskGate(input: ITaskGateInput): TaskGateDecision {
	const ids = input.incompleteTasks.map((t) => t.id);

	if (input.incompleteTasks.length === 0) {
		return { needReentry: false, capExceeded: false, incompleteTasks: [] };
	}

	if (input.reactCount >= input.maxReact) {
		return { needReentry: false, capExceeded: true, incompleteTasks: ids };
	}

	return {
		needReentry: true,
		reentryText: buildTaskGateReentryText(input.incompleteTasks, input.mode),
		incompleteTasks: ids,
		capExceeded: false,
	};
}
