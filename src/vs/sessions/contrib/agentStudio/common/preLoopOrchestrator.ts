/**
 * 编排前置层 —— agent loop 范式重构的核心组件。
 *
 * 范式（用户定稿）：
 *   由 LLM 自主判断是否需要并行 code-explorer 探索 → 探索结果汇总生成计划列表 → loop 内依次执行
 *
 * 本模块负责前两步，在 agentTurnExecutor 的 while 循环之前运行：
 *   1. assessFn（LLM 自主判断）：给定用户问题，LLM 决定是否需要探索 + 探索方向 + 可选的初步计划
 *   2. 若需探索 → exploreFn（并行 code-explorer 子 agent）→ findings
 *   3. planGenerator（LLM）：用 findings + 问题生成最终 ParsedPlanTask[]
 *
 * 第三步（loop 内依次执行）由 agentTurnExecutor 持有 planTasks 队列完成。
 *
 * 设计原则：
 *  - 无独立难度分析器：复杂度/是否探索完全由 LLM 在 assessFn 里自主判断
 *  - 编排逻辑与 IO 解耦：assess/explore/plan 通过函数注入，本模块纯编排
 *  - 简单任务快速短路（LLM 判定无需探索时直接给 planTasks），零额外探索开销
 *  - 任何探索/LLM 失败都降级为"直接进原 loop"，永不阻塞主流程
 */

import type { ParsedPlanTask } from './workMode.js';

// ─── 类型 ────────────────────────────────────────────────────────

/**
 * LLM 自主判断结果（替代原启发式难度分析器）。
 * LLM 根据用户问题决定：是否需要并行探索、探索哪些方向、以及（无需探索时）直接给出计划。
 */
export interface PreLoopAssessment {
	/** LLM 判断是否需要并行 code-explorer 探索 */
	needsExploration: boolean;
	/** 探索方向（needsExploration=true 时非空，供 exploreFn 派发子 agent） */
	explorationAreas: string[];
	/**
	 * 初步计划（无需探索时 LLM 可直接给出；需探索时通常为空，待 findings 后由 planGenerator 细化）。
	 * 空数组表示暂无计划（需探索后再生成，或降级直接进原 loop）。
	 */
	planTasks: ParsedPlanTask[];
	/** LLM 判断理由（供日志/调试） */
	reason: string;
}

/**
 * LLM 自主判断函数（由上层注入，封装一次轻量 LLM 调用）。
 * 输入用户消息，返回是否需要探索 + 探索方向 + 可选初步计划。
 */
export type AssessFn = (userMessage: string) => Promise<PreLoopAssessment>;

/**
 * 并行探索函数（由上层注入，封装 dispatchParallelExplore + 结果汇总）。
 * 输入探索方向列表 + 目标，返回汇总 findings 文本。
 */
export type ParallelExploreFn = (
	areas: string[],
	goal: string,
) => Promise<{ findings: string; successCount: number; failCount: number }>;

/**
 * 计划生成函数（由上层注入，封装轻量 LLM 调用）。
 * 输入用户问题 + 探索 findings，返回结构化计划任务列表。
 */
export type PlanGeneratorFn = (
	userMessage: string,
	findings: string | undefined,
) => Promise<ParsedPlanTask[]>;

export interface PreLoopResult {
	/** 计划任务队列。空数组=无需编排，直接进原 agent loop（零开销） */
	planTasks: ParsedPlanTask[];
	/** 探索汇总（探索后非空，由 agentTurnExecutor 注入 messages 作为上下文） */
	findings?: string;
	/** LLM 判断结果（供日志/UI） */
	assessment: PreLoopAssessment;
}

export interface PreLoopDeps {
	/** LLM 自主判断（必需）：决定是否探索 + 方向 + 初步计划 */
	assessFn: AssessFn;
	/** 并行探索（needsExploration 时调用，可选） */
	exploreFn?: ParallelExploreFn;
	/** 计划生成（探索后细化计划，可选；未提供时用 assessment.planTasks） */
	planGenerator?: PlanGeneratorFn;
}

// ─── 编排入口 ────────────────────────────────────────────────────

/**
 * 执行编排前置层。
 *
 * 流程：
 *  1. assessFn（LLM 自主判断）
 *  2. 若 needsExploration → exploreFn 并行探索 → findings
 *  3. planGenerator 用 findings 细化计划（或直接用 assessment.planTasks）
 *
 * @param userMessage 用户原始消息
 * @param deps 依赖（assessFn 必需，exploreFn/planGenerator 可选）
 * @returns PreLoopResult。planTasks 为空表示直接进原 loop。
 */
export async function preLoopOrchestrate(
	userMessage: string,
	deps: PreLoopDeps,
): Promise<PreLoopResult> {
	// Step 1: LLM 自主判断
	let assessment: PreLoopAssessment;
	try {
		assessment = await deps.assessFn(userMessage);
	} catch {
		// 判断失败 → 降级：直接进原 loop
		return {
			planTasks: [],
			assessment: { needsExploration: false, explorationAreas: [], planTasks: [], reason: 'assess failed — fallback' },
		};
	}

	// 无需探索 → 用 LLM 给的初步计划（可能为空=简单任务直接进 loop）
	if (!assessment.needsExploration) {
		return { planTasks: assessment.planTasks, assessment };
	}

	// Step 2: 并行 code-explorer 探索
	let findings: string | undefined;
	if (deps.exploreFn && assessment.explorationAreas.length > 0) {
		try {
			const result = await deps.exploreFn(assessment.explorationAreas, userMessage);
			findings = result.findings;
		} catch {
			// 探索失败 → 降级：无 findings，仍尝试生成计划
			findings = undefined;
		}
	}

	// Step 3: 生成/细化计划
	let planTasks: ParsedPlanTask[] = assessment.planTasks;
	if (deps.planGenerator) {
		try {
			planTasks = await deps.planGenerator(userMessage, findings);
		} catch {
			// 计划生成失败 → 用 assessment 初步计划（可能为空）
			planTasks = assessment.planTasks;
		}
	}

	return { planTasks, findings, assessment };
}

// ─── 计划队列辅助（供 agentTurnExecutor loop 内使用）──────────────

/**
 * 把当前计划任务格式化为 system-reminder 文本，供每轮 loop 注入。
 */
export function formatCurrentTaskReminder(
	task: ParsedPlanTask,
	index: number,
	total: number,
): string {
	const lines: string[] = [
		'<system-reminder>',
		`# CURRENT TASK (${index + 1}/${total}) — execute this now`,
		'',
		`## ${task.title}`,
	];
	if (task.description) {
		lines.push('', task.description);
	}
	if (task.files && task.files.length > 0) {
		lines.push('', '## Priority files', ...task.files.map(f => `- ${f}`));
	}
	if (task.deliverable) {
		lines.push('', `## Deliverable: ${task.deliverable}`);
	}
	lines.push(
		'',
		`When this task is done, briefly state completion and STOP calling tools — the loop will advance to task ${index + 2}/${total}.`,
		`This is task ${index + 1} of ${total}. Focus ONLY on this task.`,
		'</system-reminder>',
	);
	return lines.join('\n');
}

/**
 * 把探索 findings 格式化为 system-reminder，供 loop 前注入。
 */
export function formatExplorationFindings(findings: string): string {
	return [
		'<system-reminder>',
		'# EXPLORATION FINDINGS (from parallel code-explorer sub-agents)',
		'',
		findings,
		'',
		'Use these findings to execute the planned tasks below.',
		'</system-reminder>',
	].join('\n');
}
