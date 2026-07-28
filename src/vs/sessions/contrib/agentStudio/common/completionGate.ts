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
 *
 *  2026-07-23: 自报通道升级 —— 优先采信 MiMo RETURN_FORMAT 的 `**Status**:` Markdown 头
 *  （子代理任务消息已注入 RETURN_FORMAT_INSTRUCTION 契约），其次才是历史 XML 标记
 *  `<result status="..."/>`，均无则回退推断式判定。
 *--------------------------------------------------------------------------------------------*/

import { parseReturnHeader } from './subAgentReturnFormat.js';

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
	/**
	 * P2d: IDs of non-terminal tasks left on the DB TaskBoard for this owner/session
	 * (queried by the caller via IAgentTaskBoardService before building the context).
	 * When present and non-empty, gateResult DOWNGRADES a self-reported 'success' to
	 * 'partial' — DB truth wins over self-report (mirrors MiMo-Code TaskGate). The
	 * detailed re-entry decision (nudge vs cap) is handled separately by
	 * `taskGate.decideTaskGate`; this field only makes the structured verdict honest.
	 */
	readonly incompleteTasks?: readonly string[];
	/**
	 * B：探索型子代理的 ground-truth — 该子代理「调用了工具但没有任何真正的探索工具」。
	 * 由调用方（unifiedSubAgentDispatch）从 toolTrace 计算：explore 子代理有工具调用
	 * （toolTrace 非空）但全部不属于探索类工具集（search_graph/query_graph/get_code_snippet/
	 * file_read/web_search/execute_code 等），则置 true。
	 *
	 * 这是纯代码事实判定（不解析 LLM 文本）：当模型看似忙碌（调了工具）但一次真正的
	 * 探索工具都没调用（只调用了 index_repository / 元工具），gateResult 把 status 降级
	 * 为 partial——杜绝"空洞输出被误判为成功"。零工具调用（toolTrace 为空）不置 true，
	 * 因为那可能是合理的"从上下文直接作答"或重试场景，不应误降级。
	 */
	readonly noRealExploration?: boolean;
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
	// 防御：subAgent.task 在极端情况下可能是对象（模型把 tasks 传成对象数组），
	// 此处归一化为字符串，避免 task.search(...) 抛 "is not a function"。
	if (typeof task !== 'string') {
		if (task === null || task === undefined) { return []; }
		if (typeof task === 'object') {
			const o = task as Record<string, unknown>;
			const cand = o['task'] ?? o['description'] ?? o['content'] ?? o['goal'];
			task = cand !== undefined ? String(cand) : JSON.stringify(task);
		} else {
			task = String(task);
		}
	}
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
	// 自报通道优先级：**Status** Markdown 头（RETURN_FORMAT 契约，注入式）>
	// `<result status="..."/>` XML 标记（历史格式）> 推断式判定。
	const header = parseReturnHeader(raw);
	const marker = parseStructuredResultMarker(raw);
	const selfReported = header?.status ?? marker?.status;
	const selfReportSource = header ? 'Status header' : marker ? 'result marker' : undefined;

	let status: SubAgentGateStatus;
	let reason: string;

	if (ctx.errored) {
		status = 'failed';
		reason = 'sub-agent exited with an error';
	} else if (selfReported) {
		status = selfReported;
		reason = `model self-reported ${selfReported}${selfReportSource ? ` (${selfReportSource})` : ''}`;
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
	// 4) P2d: DB-truth downgrade — model claims success but incomplete tasks remain
	//    on the board. Mirrors MiMo-Code TaskGate: DB truth wins over self-report.
	//    Only downgrades success (not partial/blocked/failed — those already signal
	//    incompleteness). The re-entry nudge itself is driven by taskGate.decideTaskGate
	//    in the caller; here we only keep the structured verdict honest so the parent
	//    agent sees a 'partial' (not a misleading 'success') when work was left behind.
	if (status === 'success' && ctx.incompleteTasks && ctx.incompleteTasks.length > 0) {
		status = 'partial';
		reason = `${reason}; ${ctx.incompleteTasks.length} incomplete task(s) remain on the board (DB truth)`;
	}
	// 5) B：探索型子代理 ground-truth 降级 — 一次真正的探索工具都没调用（仅索引/零工具），
	//    即使模型输出了看似完整的文本，也判 partial（空洞输出 ≠ 成功）。
	if (status === 'success' && ctx.noRealExploration) {
		status = 'partial';
		reason = `${reason}; explore sub-agent performed no real exploration tool calls (ground truth from tool trace)`;
	}

	return {
		status,
		summary: summarize(raw, header?.summary ?? marker?.summary),
		filesTouched: ctx.filesTouched,
		acceptanceMet: status === 'success',
		reason,
	};
}
