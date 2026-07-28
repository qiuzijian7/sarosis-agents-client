/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 编排前置层依赖构造器 —— 从 agentTurnExecutor 的 _buildPreLoopDeps 提取，
 * 供 HermesReActStrategy.preLoop 和主循环共用，避免 browser→strategies→browser 循环依赖。
 *
 * 内聚三个辅助函数（仅此文件使用，不从外部暴露）：
 *   _singleLLMText / _parseAssessment / _parsePlanTasks
 */

import type { IChatStreamDelta } from '../common/providers.js';
import {
	preLoopOrchestrate,
	type PreLoopDeps,
	type PreLoopAssessment,
	type PreLoopResult,
} from '../common/preLoopOrchestrator.js';
import type { ParsedPlanTask } from '../common/workMode.js';
import { ITaskOrchestrationService } from '../common/agentStudio.js';
import { createEmptyCard, reduceCardState } from '../common/subAgentCardReducer.js';
import { getBuiltinAgentIdentity } from '../common/builtinAgents.js';

// ─── 辅助函数 ────────────────────────────────────────────────

async function _singleLLMText(modelProvider: any, modelId: string, msgs: any[], signal?: AbortSignal): Promise<string> {
	const stream = modelProvider.chat(modelId, msgs, { temperature: 0.2, stream: true } as any, undefined);
	const chunks: string[] = [];
	for await (const delta of stream) {
		if (delta.type === 'text' && typeof delta.content === 'string') { chunks.push(delta.content); }
		if (signal?.aborted) { break; }
	}
	return chunks.join('');
}

function _parseAssessment(text: string): PreLoopAssessment {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) { return { needsExploration: false, explorationAreas: [], planTasks: [], reason: 'no json' }; }
	try {
		const o = JSON.parse(m[0]);
		return {
			needsExploration: !!o.needsExploration,
			explorationAreas: Array.isArray(o.explorationAreas) ? o.explorationAreas.map(String) : [],
			planTasks: Array.isArray(o.planTasks) ? o.planTasks.map((t: any) => ({
				title: String(t.title || ''),
				description: t.description ? String(t.description) : undefined,
				files: Array.isArray(t.files) ? t.files.map(String) : undefined,
				complexity: t.complexity,
				deliverable: t.deliverable ? String(t.deliverable) : undefined,
			} as ParsedPlanTask)) : [],
			reason: String(o.reason || 'llm assessed'),
		};
	} catch { return { needsExploration: false, explorationAreas: [], planTasks: [], reason: 'json parse failed' }; }
}

function _parsePlanTasks(text: string): ParsedPlanTask[] {
	const m = text.match(/\[[\s\S]*\]/);
	if (!m) { return []; }
	try {
		const arr = JSON.parse(m[0]);
		if (!Array.isArray(arr)) { return []; }
		return arr.map((t: any) => ({
			title: String(t.title || ''),
			description: t.description ? String(t.description) : undefined,
			files: Array.isArray(t.files) ? t.files.map(String) : undefined,
			complexity: t.complexity,
			deliverable: t.deliverable ? String(t.deliverable) : undefined,
		} as ParsedPlanTask));
	} catch { return []; }
}

// ─── 公开 API ────────────────────────────────────────────────

/**
 * 构建编排前置层依赖。
 * @param host agentOSService 实例（含 _instantiationService、executeAgentTurn、fireSubAgentTrace 等）
 * @param modelProvider LLM 模型提供者
 * @param modelId 模型 ID
 * @param agentId 父 agent ID（用于子 agent dispatch 的 parent）
 * @param signal AbortSignal
 */
export function buildPreLoopDeps(
	host: any,
	modelProvider: any,
	modelId: string,
	agentId: string,
	signal?: AbortSignal,
): PreLoopDeps {
	const assessFn = async (userMessage: string): Promise<PreLoopAssessment> => {
		const prompt = [
			{ role: 'system', content: [
				'## <task_analysis> — determine whether parallel code exploration is needed',
				'',
				'You are a task classifier. Analyze the user request and decide whether to invoke',
				'the code-explorer subagent for parallel codebase exploration.',
				'Return ONLY JSON: {"needsExploration":bool,"explorationAreas":string[],"planTasks":[],"reason":string}',
				'',
				'### Use code-explorer (needsExploration: true)',
				'Explore when the task requires BROAD codebase exploration rather than reading',
				'a few specific files:',
				'- Understanding codebase structure, module organization, or architecture',
				'- Finding where a feature, concept, or behavior is implemented across files',
				'- Tracing call chains, dependency graphs, or data flow paths',
				'- Analyzing / diagnosing / investigating performance issues, crashes, or lag',
				'- Involving C++ / engine source code (UE, Unity, or other large frameworks)',
				'- Message contains extensive context (>3000 chars of logs, stack traces, specs)',
				'- Keywords: analyze, investigate, diagnose, debug, optimize, review, refactor, understand',
				'',
				'### Skip exploration (needsExploration: false)',
				'Skip ONLY when the task clearly falls into one of these categories:',
				'- Specific file paths are given — just read/write them directly',
				'- Single-file targeted edit (fix one line, change one function)',
				'- Simple question that needs no code inspection ("What is X?")',
				'- Answer is already in the conversation context',
				'',
				'### Exploration areas',
				'- Default to 1 holistic area (["broad codebase exploration"]); one subagent covers most cases',
				'- Only split into 2-3 areas when the task involves 3+ clearly unrelated modules/subsystems',
				'- Priority: understanding project-wide context > diving into individual files',
				'',
				'### Why this matters',
				'- code-explorer results are summarized ONCE — they do NOT fill your context window',
				'  with raw file contents and search tool outputs',
				'- Parallel exploration is 3-5x faster than sequential manual search → read → search → read',
				'- Each sub-agent has dedicated tool access and context, keeping the main conversation',
				'  focused on the user\'s actual task',
				'',
				'### Decision principle',
				'- When UNCERTAIN, bias toward exploration: one lightweight summary costs far less',
				'  than missing the exploration and wasting 10+ iterations on manual search loops',
				'- Large projects (UE/engine/framework-level) should explore even for seemingly simple questions',
				'- Return ONLY JSON, no other text.',
			].join('\n') },
			{ role: 'user', content: userMessage },
		];
		const text = await _singleLLMText(modelProvider, modelId, prompt, signal);
		return _parseAssessment(text);
	};

	const exploreFn = async (areas: string[], goal: string): Promise<{ findings: string; successCount: number; failCount: number }> => {
		let orchService: any;
		try { orchService = host._instantiationService.invokeFunction((a: any) => a.get(ITaskOrchestrationService)); }
		catch { orchService = undefined; }
		const dispatch = orchService?.subAgentDispatch;
		if (!dispatch?.dispatchParallelExplore) { throw new Error('subAgentDispatch unavailable'); }
		(dispatch as any).setLogger?.((lvl: string, msg: string) => (host._logService as any)[lvl]?.(msg) ?? host._logService.info(msg));
		const executeFn = (req: any): AsyncIterable<IChatStreamDelta> => host.executeAgentTurn(req);
		const sharedContext = [
			`# EXPLORATION GOAL`, `${goal}`, ``,
			`# YOUR MISSION`,
			`You are a read-only exploration agent. Investigate your assigned area THOROUGHLY using search_graph (primary), search_code (fallback text search), file_read, and other read-only tools.`,
			`Explore deeply: read multiple files, trace call chains, examine patterns. Do NOT stop after one or two searches — keep investigating until you genuinely understand the area.`,
			``,
			`# REPORT FORMAT (REQUIRED — your final message MUST be this report)`,
			`When done, provide a DETAILED finding report covering:`,
			`1. Key files/patterns found (with full file paths)`,
			`2. Architecture observations and how components relate`,
			`3. Relevant code snippets (brief but concrete, with line references)`,
			`4. Risks, gaps, assumptions, and recommendations`,
			`5. Suggested implementation approach based on your findings`,
			``,
			`Be thorough and specific. Vague one-line summaries are NOT acceptable — your findings will guide a concrete implementation plan, so insufficient detail will cause the plan to fail.`,
		].join('\n');
		const _parentToolCallId = `preloop_explore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const _cardMap = new Map<string, any>();
		let _flushTimer: any;
		const _flushNow = () => {
			if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = undefined; }
			try {
				(host as any).fireSubAgentTrace?.({
					groupId: _parentToolCallId,
					subagentData: [..._cardMap.values()].map((c: any) => ({
						id: c.id, type: c.type, task: c.task, status: c.status,
						progress: c.progress, output: c.output, streamingOutput: c.streamingOutput,
						error: c.error, groupId: c.groupId, toolTraces: c.toolTraces.map((t: any) => ({ ...t })),
						parentToolCallId: _parentToolCallId,
					})),
				});
			} catch { /* sink errors swallowed */ }
		};
		const _scheduleFlush = () => { if (!_flushTimer) { _flushTimer = setTimeout(() => { _flushTimer = undefined; _flushNow(); }, 100); } };
		const inlineTraceSink = (ev: any) => {
			let card = _cardMap.get(ev.subAgentId);
			if (!card) { card = createEmptyCard(ev.subAgentId, 'explore', ev.task || ''); _cardMap.set(ev.subAgentId, card); }
			reduceCardState(card, ev);
			_scheduleFlush();
		};
		host._logService.warn(`[PreLoop exploreFn] dispatchParallelExplore areas=${areas.length} eventSink=inlineTraceSink (parentToolCallId=${_parentToolCallId})`);
		// agentId 驱动（2026-07-27）：pre-loop 探索子代理以内置 code-explorer Agent 身份实例化。
		const exploreIdentity = getBuiltinAgentIdentity('code-explorer') ?? {};
		const results: any[] = await dispatch.dispatchParallelExplore(
			agentId, areas, executeFn, sharedContext,
			areas.map(() => ({ type: 'explore' as const, priority: 'high' as const, parentWorkMode: 'plan' as const, ...exploreIdentity })),
			inlineTraceSink, signal, areas.length,
		);
		host._logService.info(`[PreLoop exploreFn] dispatchParallelExplore done: ${results.length} results, success=${results.filter((r: any) => r.success).length}`);
		const lines: string[] = [`# Parallel Exploration Results (${results.length} areas)\n`];
		let successCount = 0;
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.success) { successCount++; lines.push(`## ✓ ${areas[i]}\n${(r.output || '(no output)').slice(0, 5000)}\n`); }
			else { lines.push(`## ✗ ${areas[i]}\nFailed: ${r.error || 'unknown'}\n`); }
		}
		return { findings: lines.join('\n'), successCount, failCount: results.length - successCount };
	};

	const planGenerator = async (msg: string, findings: string | undefined): Promise<ParsedPlanTask[]> => {
		const prompt = [
			{ role: 'system', content: '根据用户问题和探索结果生成执行计划。返回JSON数组: [{"title":string,"description":string,"files"?:string[],"complexity"?:"low"|"medium"|"high","deliverable"?:string}]。任务按执行顺序排列。只返回JSON数组。' },
			{ role: 'user', content: `# 用户问题\n${msg}\n\n# 探索发现\n${findings || '(无探索)'}` },
		];
		const text = await _singleLLMText(modelProvider, modelId, prompt, signal);
		return _parsePlanTasks(text);
	};

	return { assessFn, exploreFn, planGenerator };
}

// Re-export for convenience
export { preLoopOrchestrate };
export type { PreLoopResult };
