/*---------------------------------------------------------------------------------------------
 *  pi 内核驱动器 —— plan 批后拦截（2026-09-20 自 piTurnKernel.ts 拆出，D1）。
 *
 *  plan_enter / plan_exit / plan_explore 的批后拦截，**复用 parts/turnPlanModeTools
 *  同一实现**——编排本就在独立模块里，pi 侧只是换调用点：
 *    · 时机 = 驱动的 `shouldStopAfterTurn`（对齐 executor:3667 的批后时序：
 *      工具结果已回灌 transcript、本轮收尾前）；
 *    · 产出 delta（work_mode_changed / subagent_batch / 拦截器补发的 tool_result+tool_end /
 *      orchestration 流）经 `pushDelta` 进 pending 桥流式上屏；
 *    · 返回 'done' ⇒ 本 turn 结束（对齐 legacy `return undefined`）；
 *    · messages 适配经 pi⇄legacy 转换器往返（与压缩段同款，保真度有测试钉住）。
 *--------------------------------------------------------------------------------------------*/

import type { IAgentTurnRequest, IChatStreamDelta } from '../../common/providers.js';
import type { AgentAction, AgentRunState } from '../../common/agentRunState.js';
import {
	handlePlanModeTools,
	type IPlanModeToolsHost,
	type IPlanModeToolsState,
} from '../parts/turnPlanModeTools.js';
import type { AgentEvent, AgentMessage } from './types.js';
import { loopMessagesToPiMessages, piMessagesToLoopMessages } from './kernelMessages.js';
import type { IPiKernelHost } from './piTurnKernel.js';

export interface IPlanInterceptionDeps {
	readonly host: IPiKernelHost;
	readonly request: IAgentTurnRequest;
	/** 划痕 runState（与压缩段同一对象；work.mode/planFilePath 的读写面）。 */
	readonly getRunState: () => AgentRunState;
	readonly dispatchRunState: (action: AgentAction) => void;
	/** 拦截器产出的 delta 经此进 pending 桥（流式上屏）。 */
	readonly pushDelta: (delta: IChatStreamDelta) => void;
}

export interface IPlanInterception {
	/** emit 钩子：追踪每轮的 plan 调用/结果（message_end / tool_execution_end / turn_start）。 */
	readonly trackEvent: (event: AgentEvent) => void;
	/** shouldStopAfterTurn 钩子：批后拦截；返回 true ⇒ 本 turn 结束（'done'）。 */
	readonly tryIntercept: (transcript: AgentMessage[]) => Promise<boolean>;
}

export function createPlanInterception(deps: IPlanInterceptionDeps): IPlanInterception {
	const { host, request, getRunState, dispatchRunState, pushDelta } = deps;
	// 每轮追踪：tool calls 来自 assistant message_end；结果来自 tool_execution_end；turn_start 清零
	const planRound = {
		calls: [] as Array<{ id: string; name: string; arguments?: unknown }>,
		results: [] as Array<{ toolCallId?: string; content?: unknown }>,
		endedToolIds: new Set<string>(),
	};
	// 与 legacy 同为 turn 局部（planFilePath 初值随划痕 runState —— resume 时已恢复）
	let planFilePath: string | undefined = getRunState().work.planFilePath;
	let planEnterCalled = false;
	let planExitCalled = false;

	return {
		trackEvent(event) {
			if (event.type === 'message_end') {
				const message = (event as { message?: AgentMessage }).message;
				if (message && (message as { role?: string }).role === 'assistant') {
					for (const b of (message as { content?: unknown[] }).content ?? []) {
						if ((b as { type?: string }).type === 'toolCall') {
							const tc = b as { id?: string; name?: string; arguments?: unknown };
							planRound.calls.push({ id: tc.id ?? '', name: tc.name ?? '', arguments: tc.arguments });
						}
					}
				}
			} else if (event.type === 'tool_execution_end') {
				const e = event as { toolCallId: string; result?: { content?: unknown } };
				planRound.results.push({ toolCallId: e.toolCallId, content: e.result?.content });
				planRound.endedToolIds.add(e.toolCallId);
			} else if (event.type === 'turn_start') {
				planRound.calls.length = 0;
				planRound.results.length = 0;
			}
		},

		async tryIntercept(transcript) {
			if (!planRound.calls.some(c => c.name === 'plan_enter' || c.name === 'plan_exit' || c.name === 'plan_explore')) {
				return false;
			}
			if (!host._writePlanFile || !host._readPlanFile || !host._awaitPlanApproval || !host._orchestratePlan) {
				host._logService.warn('[PiKernel] plan 控制工具出现但宿主缺 plan 编排面（_writePlanFile 等）—— 按普通工具结果处理，不拦截');
				return false;
			}
			const state: IPlanModeToolsState = {
				messages: () => piMessagesToLoopMessages(transcript),
				setMessages: (next) => {
					const back = loopMessagesToPiMessages(next);
					transcript.length = 0;
					transcript.push(...back);
				},
				syncMessages: () => { /* pi 路径权威历史 = transcript 本身（与压缩段同款说明） */ },
				runState: getRunState,
				dispatchRunState,
				planFilePath: () => planFilePath,
				setPlanFilePath: next => { planFilePath = next; },
				planEnterCalled: () => planEnterCalled,
				setPlanEnterCalled: next => { planEnterCalled = next; },
				planExitCalled: () => planExitCalled,
				setPlanExitCalled: next => { planExitCalled = next; },
			};
			const gen = handlePlanModeTools(
				{ host: host as unknown as IPlanModeToolsHost, request },
				state, planRound.calls, planRound.results, planRound.endedToolIds,
			);
			let step = await gen.next();
			while (!step.done) {
				if (step.value) { pushDelta(step.value); }
				step = await gen.next();
			}
			return step.value === 'done';
		},
	};
}
