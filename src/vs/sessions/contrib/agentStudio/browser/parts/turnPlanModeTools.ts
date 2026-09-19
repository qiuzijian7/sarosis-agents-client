/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Plan 模式控制工具的拦截段 —— `plan_explore` / `plan_enter` / `plan_exit`。
 *
 * ## 这一段做什么
 *
 * 三个控制工具**不走常规工具执行路径**：它们改变 turn 自身的工作模式，必须在
 * 工具结果回灌后、本轮收尾前被拦截处理。本段负责：
 *   · `plan_explore` —— 未处于 plan 模式时自动切入（含补建计划文件），并把子代理
 *     台账从工具结果里解出来转成 `subagent_batch` 卡片
 *   · `plan_enter`   —— 切入 plan 模式 + 创建计划文件骨架
 *   · `plan_exit`    —— 校验计划有效性 → （可选审批）→ 切回 work 模式 → 派发 DAG
 *
 * ## 为什么必须自行补发 tool_result + tool_end
 *
 * 拦截意味着常规执行路径不会为这些调用发事件。UI 端的 `tool_start` 卡片会一直
 * 转，直到本轮末尾 `_postIterationCleanup` 的 orphan 清理兜底补发 —— 而兜底是
 * `success=false`，用户看到的是「工具未执行」而非真实结果。所以每条分支都显式
 * 补发带正确 `success` 的事件，并把 id 记进 `endedToolIds` 防止重复补发。
 *
 * ## 迁出说明（期 1）
 *
 * 原为 `agentTurnExecutor.ts:1885-2141` 的内联闭包，捕获 5 个可变量
 * （`runState` / `messages` / `planFilePath` / `planEnterCalled` / `planExitCalled`）
 * 与 6 个 host 方法。迁出时把捕获显式化为 `deps` + `state`，行为逐行保持不变。
 *
 * @module agentStudio/parts/turnPlanModeTools
 */

import type { IAgentTurnRequest, IChatStreamDelta } from '../../common/providers.js';
import type { AgentAction, AgentRunMessage, AgentRunState } from '../../common/agentRunState.js';
import { appendMessages } from '../../common/agentRunState.js';
import { generatePlanPath } from '../../common/planFile.js';
import { parsePlanDocument } from '../../common/workMode.js';
import { buildBuildSwitchReminder } from '../../common/chatModeConfig.js';
import { sanitizeToolResultText } from '../../common/assistantVisibleText.js';
import { limitToolResultSize, safeStringifyToolResult } from '../toolCallUtils.js';
import type { ITurnPartLog } from '../../common/turnKernel/turnPartContext.js';

/**
 * 本段用到的 host 面。
 *
 * 只声明实际调用的 6 个成员：窄接口让依赖可见，也让测试 stub 保持最小。
 * `_getSarosRoot` 与 `_writePlanFile` 在原实现中以可选链调用，此处保留可选性。
 */
export interface IPlanModeToolsHost {
	_logService: ITurnPartLog;
	_getSarosRoot?(): string;
	_writePlanFile(path: string, content: string): Promise<void>;
	_readPlanFile(path: string): Promise<string>;
	_awaitPlanApproval(confirmationId: string): Promise<string>;
	_orchestratePlan(
		request: IAgentTurnRequest,
		options: { plan_summary: string; next_mode: string; idempotencyKey: string },
		tasks: unknown[],
		toolCallId: string,
	): AsyncGenerator<IChatStreamDelta>;
}

/** 本段不变的依赖。 */
export interface IPlanModeToolsDeps {
	readonly host: IPlanModeToolsHost;
	readonly request: IAgentTurnRequest;
}

/**
 * 本段的可变状态读写面。
 *
 * `planFilePath` / `planEnterCalled` / `planExitCalled` 在原闭包里是被重赋值的
 * `let`，故必须走 setter 回写 —— 返回值回传会丢失「auto-enter 途中建立的路径」
 * 这类中间态。
 */
export interface IPlanModeToolsState {
	messages(): AgentRunMessage[];
	setMessages(next: AgentRunMessage[]): void;
	/** 追加消息后必须调用，把 loopMessages 同步进 runState。 */
	syncMessages(): void;

	runState(): AgentRunState;
	dispatchRunState(action: AgentAction): void;

	planFilePath(): string | undefined;
	setPlanFilePath(next: string | undefined): void;

	planEnterCalled(): boolean;
	setPlanEnterCalled(next: boolean): void;

	planExitCalled(): boolean;
	setPlanExitCalled(next: boolean): void;
}

/** 工具调用的最小形状（本段只读 id / name / arguments）。 */
interface IPlanToolCall {
	id: string;
	name: string;
	arguments?: unknown;
}

/** 工具结果的最小形状（本段只读 toolCallId / content）。 */
interface IPlanToolResult {
	toolCallId?: string;
	content?: unknown;
}

/** 从消息列表里取最后一条用户文本（计划文件命名与标题的来源）。 */
function resolveLastUserText(request: IAgentTurnRequest): string {
	const userMessages = ((request.messages ?? []) as Array<{ role?: string; content?: unknown }>)
		.filter(message => message.role === 'user');
	const lastUserMessage = userMessages[userMessages.length - 1];
	return typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
}

/** 把拦截结果包装成 UI 可见的 tool_result 文本（与常规路径同一套清洗链）。 */
function buildInterceptedResultText(note: string): string {
	return sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note })));
}

/**
 * 处理本轮出现的 plan 控制工具。
 *
 * @returns `'done'` 表示本 turn 应结束（plan_exit 已派发 DAG）；`undefined` 表示继续。
 */
export async function* handlePlanModeTools(
	deps: IPlanModeToolsDeps,
	state: IPlanModeToolsState,
	effectiveToolCalls: readonly IPlanToolCall[],
	toolResults: readonly IPlanToolResult[],
	endedToolIds: Set<string>,
): AsyncGenerator<IChatStreamDelta, 'done' | undefined> {
	const { host, request } = deps;

	// ─── plan_explore + subagent card injection ──
	const planExploreCall = effectiveToolCalls.find(toolCall => toolCall.name === 'plan_explore');
	if (planExploreCall) {
		// P1: enforce that plan_explore only runs in plan workMode.
		// If the LLM calls plan_explore without plan_enter, auto-enter.
		if (state.runState().work.mode !== 'plan') {
			host._logService.info(`[AgentOS] plan_explore auto-entering plan workMode (enforcement)`);
			// workState 唯一权威在 runState.work：只发 WORK_EVENT，不再同步写闭包变量。
			state.dispatchRunState({ type: 'WORK_EVENT', event: { type: 'ENTER_PLAN' } });
			yield { type: 'work_mode_changed', workMode: 'plan' };
			// Generate plan file path if not set
			if (!state.planFilePath()) {
				const sarosRoot = host._getSarosRoot?.() ?? '';
				const planPath = generatePlanPath(sarosRoot, resolveLastUserText(request));
				state.setPlanFilePath(planPath);
				state.dispatchRunState({ type: 'WORK_EVENT', event: { type: 'SET_PLAN_FILE', planFilePath: planPath } });
				try {
					await host._writePlanFile(planPath, `# Plan\n*Auto-created by plan_explore enforcement*\n\n## Goal\n\n\n## Tasks\n\n`);
				} catch { /* best-effort */ }
			}
			// 阶段卡：auto-enter 完成（P1 done，P2 探索进行中）+ 计划文件路径
			yield { type: 'work_mode_changed', workMode: 'plan', planPhase: { currentStep: 1, planFilePath: state.planFilePath() } };
		}
		host._logService.info(`[AgentOS] plan_explore called — parallel exploration launched`);

		// Extract subagent data from tool result for chat panel SubAgentCards
		const exploreResult = toolResults.find(result => result.toolCallId === planExploreCall.id);
		if (exploreResult?.content) {
			try {
				const contentText = Array.isArray(exploreResult.content)
					? exploreResult.content.map((part: { text?: string }) => part.text || '').join('')
					: String(exploreResult.content);
				const parsed = JSON.parse(contentText);
				if (parsed.subagentData && Array.isArray(parsed.subagentData)) {
					yield {
						type: 'subagent_batch',
						subagentData: parsed.subagentData,
						toolCallId: planExploreCall.id,
					} as IChatStreamDelta;
				}
			} catch { /* parse failure — subagent data not available */ }
		}
		// 阶段卡：探索结果已返回（P2 并行探索 done，P3 方案设计 current）
		yield { type: 'work_mode_changed', workMode: 'plan', planPhase: { currentStep: 2 } };
	}

	// ─── plan_enter: enter the internal read-only WorkMode ─────────────
	// Both Plan and Craft policies may enter planning;
	// their only behavioral difference is the approval gate at plan_exit.
	const planEnterCall = effectiveToolCalls.find(toolCall => toolCall.name === 'plan_enter');
	if (planEnterCall && !state.planEnterCalled()) {
		state.setPlanEnterCalled(true);
		state.dispatchRunState({ type: 'WORK_EVENT', event: { type: 'ENTER_PLAN' } });
		yield { type: 'work_mode_changed', workMode: 'plan' };

		const sarosRoot = host._getSarosRoot?.() ?? '';
		const userText = resolveLastUserText(request);
		const planPath = generatePlanPath(sarosRoot, userText);
		state.setPlanFilePath(planPath);
		state.dispatchRunState({ type: 'WORK_EVENT', event: { type: 'SET_PLAN_FILE', planFilePath: planPath } });

		// 阶段卡：plan_enter 完成（P1 理解需求 done，P2 并行探索 current）+ 计划文件路径
		yield { type: 'work_mode_changed', workMode: 'plan', planPhase: { currentStep: 1, planFilePath: planPath } };

		try {
			const initialContent = `# Plan: ${(userText || 'Untitled').slice(0, 80)}\n\n` +
				`*Created: ${new Date().toISOString()}*\n\n` +
				`## Goal\n\n` +
				`## Exploration Findings\n\n` +
				`## Tasks\n\n` +
				`### Task 1: <title>\n` +
				`- Role: <short role label, e.g. Developer | Researcher | Tester>\n` +
				`- Description: <self-contained implementation task and acceptance criteria>\n` +
				`- Files: <comma-separated paths>\n` +
				`- Dependencies: none\n` +
				`- Complexity: medium\n\n` +
				`## Verification\n`;
			await host._writePlanFile(planPath, initialContent);
			host._logService.info(`[AgentOS] plan_enter — workMode=plan, plan file created at ${planPath}`);
		} catch (createErr) {
			host._logService.warn(`[AgentOS] plan_enter could not create plan file: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
		}

		state.setMessages(appendMessages(state.messages(), {
			role: 'tool',
			content: `Entered internal plan work mode. Plan file: ${planPath}. Follow: explore → design → review → write structured tasks → plan_exit.`,
			toolCallId: planEnterCall.id,
		}));
		state.syncMessages();
		// P0: 拦截器必须显式 yield tool_result + tool_end，否则 UI 端那张
		// tool_start 卡片会一直转 —— 要等到本轮末尾 `_postIterationCleanup`
		// 的 orphan 清理才兜底补发。
		// 兜底语义偏弱：它以 success=false 收尾，用户看到的是「工具未执行」，
		// 而非 plan_enter/plan_exit 的真实结果。故此处必须自行补发带正确
		// success 的事件，不要把兜底当作常规路径。
		yield {
			type: 'tool_result',
			content: buildInterceptedResultText(`Entered internal plan work mode. Plan file: ${planPath}.`),
			toolCallId: planEnterCall.id,
		};
		yield { type: 'tool_end', toolCallId: planEnterCall.id, success: true };
		endedToolIds.add(planEnterCall.id);
	}

	// ─── plan_exit: policy gate → WorkMode switch → DAG subagent fan-out ──
	const planExitCall = effectiveToolCalls.find(toolCall => toolCall.name === 'plan_exit');
	if (planExitCall && state.runState().work.mode === 'plan' && !state.planExitCalled()) {
		try {
			const exitArgs = typeof planExitCall.arguments === 'string'
				? JSON.parse(planExitCall.arguments) : planExitCall.arguments;
			if ((exitArgs as { plan_file?: unknown })?.plan_file) {
				state.setPlanFilePath(String((exitArgs as { plan_file: unknown }).plan_file));
			}
		} catch { /* use the path established by plan_enter */ }

		const planFilePath = state.planFilePath();
		let planMarkdown = '';
		if (planFilePath) {
			planMarkdown = await host._readPlanFile(planFilePath);
		}
		const parsedPlan = parsePlanDocument(planMarkdown);
		const executableTasks = parsedPlan.tasks.filter(task => task.title !== '<title>' && !task.title.includes('<'));
		if (!planFilePath || !planMarkdown.trim() || executableTasks.length === 0) {
			const invalidResult = !planFilePath
				? 'Plan exit blocked: no plan file is associated with this work cycle. Call plan_enter first.'
				: `Plan exit blocked: ${planFilePath} must contain at least one structured task under "## Tasks".`;
			host._logService.warn(`[AgentOS] plan_exit rejected invalid plan: file=${planFilePath ?? '(none)'}, tasks=${executableTasks.length}`);
			state.setMessages(appendMessages(state.messages(), { role: 'tool', content: invalidResult, toolCallId: planExitCall.id }));
			state.syncMessages();
			yield { type: 'tool_result', content: buildInterceptedResultText(invalidResult), toolCallId: planExitCall.id };
			yield { type: 'tool_end', toolCallId: planExitCall.id, success: false };
			endedToolIds.add(planExitCall.id);
			return undefined;
		}

		// 2026-08 决策：plan_exit 默认直通执行（审批走 orchestration 的 plan-approval
		// 确认卡片，不随 ChatMode 开关）。原 planExitRequiresApproval() 恒 false 已删
		// （workMode.ts 有恢复指引）；下方 REQUEST_APPROVAL 分支结构完整保留，
		// 如需恢复「退出前弹用户审批」改为 true 即可。
		const shouldAskUser: boolean = false;
		// 阶段卡：计划文件解析出有效 tasks（P4 撰写计划 done，P5 提交执行 current）
		yield { type: 'work_mode_changed', workMode: 'plan', planPhase: { currentStep: 4 } };
		host._logService.info(`[AgentOS] plan_exit — approval=${shouldAskUser}, tasks=${executableTasks.length}`);
		let approved = !shouldAskUser;
		if (shouldAskUser) {
			state.dispatchRunState({ type: 'WORK_EVENT', event: { type: 'REQUEST_APPROVAL' } });
			const confirmationId = `plan-exit-${request.sessionId ?? 's'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			yield {
				type: 'confirmation',
				confirmationData: {
					id: confirmationId,
					type: 'plan-approval' as const,
					title: 'Plan Complete — Execute in Parallel?',
					message: `The plan contains ${executableTasks.length} task(s). Approve parallel subagent execution?`,
					detail: `Plan file: ${planFilePath}`,
					planSummary: parsedPlan.summary,
					tasks: executableTasks,
					buttons: [
						{ id: 'approve', label: 'Approve & Execute', primary: true },
						{ id: 'reject', label: 'Keep Planning', danger: true },
					],
					status: 'pending' as const,
				},
			} as IChatStreamDelta;
			const decision = await host._awaitPlanApproval(confirmationId);
			approved = decision === 'approved';
			yield {
				type: 'confirmation_resolved',
				confirmationId,
				confirmationStatus: approved ? 'approved' : 'rejected',
			};
		}

		if (!approved) {
			state.dispatchRunState({ type: 'WORK_EVENT', event: { type: 'REJECT_PLAN' } });
			state.setMessages(appendMessages(state.messages(), {
				role: 'tool',
				content: 'The user rejected execution. Stay in plan work mode and refine the existing plan.',
				toolCallId: planExitCall.id,
			}));
			state.syncMessages();
			yield { type: 'tool_result', content: buildInterceptedResultText('User rejected execution. Stay in plan work mode.'), toolCallId: planExitCall.id };
			yield { type: 'tool_end', toolCallId: planExitCall.id, success: false };
			endedToolIds.add(planExitCall.id);
			return undefined;
		}

		state.setPlanExitCalled(true);
		// P0: reset planEnterCalled so subsequent plan_explore calls can auto-enter again.
		// Without this, plan_enter auto-enter only fires once per turn.
		state.setPlanEnterCalled(false);
		state.dispatchRunState({
			type: 'WORK_EVENT',
			event: shouldAskUser ? { type: 'APPROVE_PLAN' } : { type: 'START_DISPATCH' },
		});
		// 阶段卡：批准/直通 → 规划全流程完成（P5 done，阶段卡定格完成态）
		yield { type: 'work_mode_changed', workMode: 'work', planPhase: { completedAt: Date.now() } };
		state.setMessages(appendMessages(state.messages(), { role: 'system', content: buildBuildSwitchReminder(planFilePath) }));
		state.syncMessages();
		state.setMessages(appendMessages(state.messages(), {
			role: 'tool',
			content: `${shouldAskUser ? 'User approved' : 'Craft policy auto-approved'} the plan. Dispatching ${executableTasks.length} task(s) through the orchestration DAG.`,
			toolCallId: planExitCall.id,
		}));
		state.syncMessages();

		state.dispatchRunState({ type: 'WORK_EVENT', event: { type: 'START_EXECUTION' } });
		// P1: idempotency key prevents duplicate Plan creation on replay/retry.
		const idempotencyKey = `plan-exit-${request.sessionId ?? 's'}-${planExitCall.id}`;
		yield* host._orchestratePlan(
			request,
			{ plan_summary: parsedPlan.summary, next_mode: 'work', idempotencyKey },
			executableTasks,
			planExitCall.id,
		);
		// P0: 同上 —— 拦截器必须显式补发带正确 success 的事件。
		yield {
			type: 'tool_result',
			content: buildInterceptedResultText(
				`${shouldAskUser ? 'User approved' : 'Craft policy auto-approved'} the plan. Dispatching ${executableTasks.length} task(s).`,
			),
			toolCallId: planExitCall.id,
		};
		yield { type: 'tool_end', toolCallId: planExitCall.id, success: true };
		endedToolIds.add(planExitCall.id);
		yield { type: 'done' };
		return 'done';
	} else if (planExitCall) {
		// P0: plan_exit called outside plan mode → return clear error instead of
		// silently ignoring (which caused the LLM to retry 56+ times per turn).
		const reason = state.planExitCalled()
			? 'plan_exit was already processed this turn. Tasks are being dispatched — wait for results.'
			: 'plan_exit only works in plan mode (after plan_enter). Call plan_enter first to enter plan mode, then plan_explore, then plan_exit ONCE.';
		state.setMessages(appendMessages(state.messages(), {
			role: 'tool',
			content: reason,
			toolCallId: planExitCall.id,
		}));
		state.syncMessages();
		yield { type: 'tool_result', content: buildInterceptedResultText(reason), toolCallId: planExitCall.id };
		yield { type: 'tool_end', toolCallId: planExitCall.id, success: false };
		endedToolIds.add(planExitCall.id);
	}
	return undefined;
}
