/*---------------------------------------------------------------------------------------------
 *  Completion Gate + Structured Output Contract (MiMo-Code-inspired)
 *
 *  MiMo-Code reconciles a sub-agent's self-reported status against DB task truth via
 *  `TaskGate.decide`. We don't have a DB task table, but we DO have observable ground
 *  truth: which files the sub-agent actually modified (tool trace), whether it errored,
 *  whether it was truncated by budget/timeout, and the acceptance criteria the parent
 *  spelled out in the task briefing (the `ACCEPTANCE:` clause our sub-agent system prompt
 *  already asks for).
 *
 *  `gateResult` reconciles the model's self-report against that ground truth and may
 *  DOWNGRADE the status (success → partial → blocked → failed) when the two disagree. The
 *  result is a structured contract (`ISubAgentStructuredResult`) the parent can rely on
 *  instead of free-text scraping.
 *
 *  Pure + dependency-free → fully unit-testable.
 *--------------------------------------------------------------------------------------------*/

export type SubAgentGateStatus = 'success' | 'partial' | 'blocked' | 'failed';

export interface ISubAgentStructuredResult {
	readonly status: SubAgentGateStatus;
	readonly summary: string;
	readonly filesTouched: readonly string[];
	/** Whether the acceptance criteria are satisfied (true iff status === 'success'). */
	readonly acceptanceMet: boolean;
	/** Why the status was assigned (for observability / parent briefing). */
	readonly reason: string;
}

export interface ICompletionGateContext {
	/** Files the sub-agent actually modified (from tool trace / filesModified). */
	readonly filesTouched: readonly string[];
	/** Whether the sub-agent exited with an error. */
	readonly errored: boolean;
	/** Whether the sub-agent was truncated by budget/timeout. */
	readonly truncated: boolean;
	/** Acceptance criteria parsed from the parent's task briefing (ACCEPTANCE clause). */
	readonly acceptanceCriteria?: readonly string[];
}

const STATUS_MARKER_RE = /<result\s+status=["']?(success|partial|blocked|failed)["']?\s*(?:summary=["']([^"']*)["'])?\s*\/?>/i;

/**
 * Parse a structured `<result status="..." summary="...">` marker if the sub-agent emitted
 * one. Returns undefined when absent (the sub-agent returned only free text).
 */
export function parseStructuredResultMarker(text: string): { status?: SubAgentGateStatus; summary?: string } | undefined {
	const m = STATUS_MARKER_RE.exec(text);
	if (!m) { return undefined; }
	const status = m[1] as SubAgentGateStatus;
	const summary = m[2] !== undefined && m[2].length > 0 ? m[2] : undefined;
	return { status, summary };
}

/**
 * Extract the ACCEPTANCE criteria bullet list from a task briefing. Our sub-agent system
 * prompt instructs parents to write `ACCEPTANCE (how to know it is done + output limits)`.
 * Returns [] when no ACCEPTANCE clause is present.
 */
export function extractAcceptanceCriteria(task: string): string[] {
	const idx = task.search(/\bACCEPTANCE\b\s*[:：]/i);
	if (idx < 0) { return []; }
	const tail = task.slice(idx);
	const colon = tail.indexOf(':');
	if (colon < 0) { return []; }
	const body = tail.slice(colon + 1);
	const lines = body
		.split(/\n/)
		.map((l) => l.trim().replace(/^[-*]\s*/, ''))
		.filter(Boolean);
	// Stop at the first subsequent all-caps section header (e.g. CONTEXT: / GOAL:).
	const stopAt = lines.findIndex((l) => /^[A-Z][A-Z _-]*[:：]?$/.test(l));
	const criteria = stopAt > 0 ? lines.slice(0, stopAt) : lines;
	return criteria.slice(0, 12);
}

function summarize(raw: string, markerSummary?: string): string {
	if (markerSummary) { return markerSummary.slice(0, 4000); }
	const cleaned = raw.replace(/\n{2,}/g, '\n').trim();
	return cleaned.slice(0, 2000);
}

/**
 * Reconcile the model's self-report (if any) against observable ground truth.
 * Ground truth may DOWNGRADE the self-reported status but never upgrade it.
 */
export function gateResult(raw: string, ctx: ICompletionGateContext): ISubAgentStructuredResult {
	const marker = parseStructuredResultMarker(raw);
	const selfReported = marker?.status;

	let status: SubAgentGateStatus;
	let reason: string;

	if (ctx.errored) {
		status = 'failed';
		reason = 'sub-agent exited with an error';
	} else if (selfReported) {
		status = selfReported;
		reason = `model self-reported ${selfReported}`;
	} else if (ctx.truncated) {
		status = 'partial';
		reason = 'no explicit status marker and execution was truncated (budget/timeout)';
	} else {
		status = 'success';
		reason = 'completed cleanly with no error or truncation';
	}

	// ── Reconciliation (ground truth can only downgrade) ──
	// 1) Model claims success but actually errored → force failed.
	if (selfReported === 'success' && ctx.errored) {
		status = 'failed';
		reason = 'model claimed success but sub-agent errored';
	}
	// 2) Truncation mid-flight loses work → downgrade one notch (only when the
	//    model actually reported a status; a marker-less truncated run is already
	//    'partial' from the branch above and must not be pushed to 'blocked').
	if (ctx.truncated && selfReported === 'success') {
		status = 'partial';
		reason = `${reason}; downgraded to partial due to truncation`;
	} else if (ctx.truncated && selfReported === 'partial') {
		status = 'blocked';
		reason = `${reason}; downgraded to blocked due to truncation`;
	}
	// 3) Acceptance-aware downgrade: criteria imply file changes but none were made.
	if (status === 'success' && ctx.acceptanceCriteria && ctx.acceptanceCriteria.length > 0) {
		const wantsFiles = ctx.acceptanceCriteria.some((c) =>
			/\b(file|write|creat|edit|modif|生成|写出|创建|修改|文件)\b/i.test(c));
		const noneTouched = ctx.filesTouched.length === 0;
		if (wantsFiles && noneTouched) {
			status = 'partial';
			reason = `${reason}; acceptance implies file changes but no files were modified`;
		}
	}

	return {
		status,
		summary: summarize(raw, marker?.summary),
		filesTouched: ctx.filesTouched,
		acceptanceMet: status === 'success',
		reason,
	};
}
