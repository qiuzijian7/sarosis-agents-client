/*---------------------------------------------------------------------------------------------
 *  piLoop/agentLoop.ts — pi agentloop 核心的本地复刻
 *
 *  复刻来源：https://github.com/earendil-works/pi  @ e98f287ee498e0116546f4e9aa083fdec9793cd2
 *            packages/agent/src/agent-loop.ts (857 行)
 *
 *  复刻范围（仅 A 类「纯循环核心」，不含 pi 的 EventStream 包装层）：
 *    runAgentLoop / runAgentLoopContinue   入口
 *    runLoop                               主循环
 *    streamAssistantResponse               LLM 流式
 *    executeToolCalls(+Sequential/Parallel) 工具派发
 *    prepareToolCall / executePreparedToolCall / finalizeExecutedToolCall
 *    shouldTerminateToolBatch              批终止判定
 *    failToolCallsFromTruncatedMessage     截断兜底
 *    createToolResultMessage / emitToolResultMessage
 *
 *  刻意未复刻：`agentLoop` / `agentLoopContinue` / `createAgentStream` —— 那是 pi 的
 *  EventStream 便利包装（pi/src/agent.ts 的 `Agent` 类消费），本仓已有自己的事件派发
 *  （`IChatStreamDelta`），由 `streamAdapter.ts` 承担。
 *
 *  与 pi 的语义差异（逐条记录，便于上游比对）：
 *  1. `getDefaultStreamFn()` 在 pi 里回落到 pi-ai 的内置实现；本仓**不设回落**，
 *     `streamFn` 为必填 —— 本仓的模型层由 `IModelProvider` 提供，没有内置实现可言。
 *  2. `declareToolChanges` / `withToolChanges` 未复刻：它们依赖 pi 的「工具集热变更
 *     声明」机制（`SystemMessage` 注入），本仓的工具集在 turn 起点即固定。
 *  3. （2026-09-20 增补，超出 pi 原版，对齐 legacy）steering 顶部统一轮询 +
 *     撞顶收尾轮（toolChoice:'none' + hardLimitWrapUpReminder）—— 见 runLoop 注释。
 *--------------------------------------------------------------------------------------------*/

import { hardLimitWrapUpReminder } from '../../common/loopReminders.js';
import { hasPruneEffect, pruneOrphanedToolCalls } from './kernelTranscriptHygiene.js';
import type {
	AfterToolCallResult,
	AgentContext,
	AgentEventSink,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AssistantMessage,
	ExecutedToolCallBatch,
	FinalizedToolCallOutcome,
	Message,
	StopReason,
	StreamFn,
	ToolCallPreparation,
	ToolResultMessage,
	TranscriptContext,
} from './types.js';

/**
 * 启动 agentloop（新 prompt 模式）。
 *
 * 复刻自 pi `runAgentLoop`。与 p 原版的差异见文件头「与 pi 的语义差异」第 2 条 ——
 * 此处不做 `declareToolChanges`，`prompts` 直接并入上下文。
 *
 * @param prompts 本轮新增的提示消息（user 消息或工具结果）
 * @param context 运行上下文；其 `messages` 数组会被就地追加
 * @param config  loop 配置（宿主唯一接入面）
 * @param emit    事件接收器
 * @param signal  中止信号
 * @param streamFn 模型流函数
 * @returns 本轮新增的全部消息
 */
export async function runAgentLoop(
	prompts: readonly AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	context.messages.push(...prompts);

	await emit({ type: 'agent_start' });
	await emit({ type: 'turn_start' });
	for (const message of prompts) {
		await emit({ type: 'message_start', message });
		await emit({ type: 'message_end', message });
	}

	await runLoop(context, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * 从当前上下文续跑 agentloop（不追加新消息）。
 *
 * 复刻自 pi `runAgentLoopContinue`。用于重试场景 —— 上下文里已有 user 消息或工具结果。
 *
 * 前置条件（照搬 pi，不做放宽）：上下文的最后一条消息必须能经 `convertToLlm` 转成
 * `user` 或 `toolResult`。否则 provider 会拒绝请求。此处无法校验 —— `convertToLlm`
 * 每轮只调用一次。
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error('无法续跑：上下文中没有任何消息');
	}

	const lastMessage = context.messages[context.messages.length - 1];
	if (lastMessage.role === 'assistant') {
		throw new Error('无法从 assistant 消息续跑：该角色无法作为请求的尾消息');
	}

	const newMessages: AgentMessage[] = [];
	await emit({ type: 'agent_start' });
	await emit({ type: 'turn_start' });

	await runLoop(context, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * 主循环：流式生成 → 执行工具 → 判定停止 → 下一轮。
 *
 * 复刻自 pi `runLoop`。循环在「模型未请求工具」或「shouldStopAfterTurn 返回 true」时结束。
 *
 * 2026-09-20 增补（对齐 legacy，超出 pi 原版）：
 *  · steering 轮询（顶部统一轮询点，见循环内注释）；
 *  · **撞顶收尾轮**：`turnIndex >= maxTurns` 且上轮模型仍在要工具 ⇒ 跑一轮禁工具收尾
 *    （`toolChoice:'none'` + `hardLimitWrapUpReminder` 注入），收尾轮的工具调用不再执行，
 *    随后硬停 —— 对齐 legacy `classifyBudgetGate` 的 wrap-up 语义（`turnIterationGate.ts`
 *    + `executor:1428`；失败背景：撞顶直接结束会让末轮发起的 delegate_task 成果 100% 丢弃）。
 */
async function runLoop(
	context: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<void> {
	let turnIndex = 0;
	let activeConfig: AgentLoopConfig = config;

	// 复刻 pi 的门控语义：内层循环只在「本轮产生了工具调用且整批未被终止」时继续。
	// 无工具调用意味着模型已给出最终答复 —— 循环必须终止，且**不依赖**
	// `shouldStopAfterTurn`（后者是宿主的额外停止条件，不是终止的默认来源）。
	let hasMoreToolCalls = true;

	// ── steering 轮询（复刻 pi `agent-loop.ts:173/203/263` 语义，2026-09-20 补）────
	// 宿主提供 `config.getSteeringMessages?.()`；loop 在「起始 + 每个边界」轮询，取到的
	// 消息**排进下一次模型调用之前**推入 transcript（用户插话）；模型本无工具调用
	// （本想停）时取到 ⇒ 续跑（follow-up 语义）。轮询是宿主零成本空 lease 的廉价操作，
	// 故每个迭代顶部统一轮询一次，替代 pi 的三处分写。
	let pendingSteering: AgentMessage[] = [];
	// 撞顶收尾轮只跑一次（对齐 legacy `runState.wrapUp.done` 语义）
	let wrapUpDone = false;
	// XML 泄漏重试计数（对齐 legacy `loopState.xmlToolLeakAttempts`，上限 2）
	let leakAttempts = 0;

	while (true) {
		const fresh = await activeConfig.getSteeringMessages?.() ?? [];
		if (fresh.length > 0) { pendingSteering.push(...fresh); }

		if (signal?.aborted) {
			break;
		}
		// 强制收尾轮请求（宿主钩子；对齐 legacy `wrapUp.forced`）：返回文案 ⇒ 立即武装，
		// 不等 maxTurns 撞顶。一次性消费（wrapUpDone 已保证单发，这里仅避免重复读钩子）。
		const forcedWrapUpReminder = wrapUpDone ? undefined : activeConfig.requestWrapUp?.();
		if ((activeConfig.maxTurns !== undefined && turnIndex >= activeConfig.maxTurns) || forcedWrapUpReminder !== undefined) {
			// ── 撞顶/强制收尾轮（对齐 legacy classifyBudgetGate 的 wrap-up 语义）─────
			// 上轮模型仍在要工具（有 toolCalls）且收尾轮未跑过 ⇒ 跑一轮禁工具收尾：
			// 注入提醒（强制场景用宿主文案，否则 hardLimitWrapUpReminder）+ toolChoice:'none'，
			// **直接落入本迭代流式段**（不回顶部，否则 maxTurns 判定会立即再拦）。
			// 收尾轮的工具调用不再执行（见下方执行块的 wrapUpDone 门），之后硬停。
			const lastAssistant = findLastAssistant(context.messages);
			const stillWantsTools = lastAssistant !== undefined && collectToolCalls(lastAssistant).length > 0;
			if (wrapUpDone || !stillWantsTools) {
				break;
			}
			wrapUpDone = true;
			const nudge = {
				role: 'user',
				content: forcedWrapUpReminder ?? hardLimitWrapUpReminder(activeConfig.maxTurns ?? 0),
				timestamp: Date.now(),
			} as AgentMessage;
			await emit({ type: 'message_start', message: nudge });
			await emit({ type: 'message_end', message: nudge });
			newMessages.push(nudge);
			context.messages.push(nudge);
			turnIndex++;
			activeConfig = await applyNextTurnUpdate(activeConfig, context, turnIndex);
			activeConfig = {
				...activeConfig,
				streamOptions: { ...(activeConfig.streamOptions ?? {}), toolChoice: 'none' },
			};
			await emit({ type: 'turn_start' });
		}
		if (!hasMoreToolCalls && pendingSteering.length === 0) {
			// ⚠ 不得加 `!wrapUpDone` 门：收尾轮跑完后 hasMoreToolCalls=false 必须在此跳出，
			// 否则 turnIndex < maxTurns 的强制收尾场景会无限流式（2026-09-20 OOM 实证）。
			break;
		}
		if (pendingSteering.length > 0) {
			// 插话单独成一轮：沿用常规轮的 turn 计数/钩子/turn_start 纪律
			turnIndex++;
			activeConfig = await applyNextTurnUpdate(activeConfig, context, turnIndex);
			await emit({ type: 'turn_start' });
			for (const message of pendingSteering) {
				await emit({ type: 'message_start', message });
				await emit({ type: 'message_end', message });
				newMessages.push(message);
				context.messages.push(message);
			}
			pendingSteering = [];
		}

		// ── 转录卫生：清理孤儿 tool 对（2026-09-20，修复「每轮重剥」实证缺陷）──────
		// 此刻 transcript 完整（上轮工具结果已入库）⇒ 摘掉「有 call 无 result / 有 result
		// 无 call」的孤儿。清理落在**权威 transcript** 上（内核自有资产）⇒ 与 legacy 靠
		// LMBridge 回写等价且彻底，孤儿不再每轮复发（真机实测每轮固定剥 3→6 条）。
		const pruned = pruneOrphanedToolCalls(context.messages);
		if (hasPruneEffect(pruned)) { activeConfig.onTranscriptPruned?.(pruned); }

		const assistantMessage = await streamAssistantResponse(context, activeConfig, signal, emit, streamFn);
		newMessages.push(assistantMessage);
		context.messages.push(assistantMessage);

		// 流以 error / aborted 收尾时，本轮不可能再有可执行的工具调用，直接终结。
		if (assistantMessage.stopReason === 'error' || assistantMessage.stopReason === 'aborted') {
			await emit({ type: 'turn_end' });
			break;
		}

		const toolCalls = collectToolCalls(assistantMessage);

		// ── 文本工具调用泄漏重试（对齐 legacy executor:2294-2368）────────────────
		// 模型把工具调用写成 XML 纯文本（未走 native function call）时：
		//   · 上限内 ⇒ 丢弃泄漏文本（discard_streamed_text + **不入 transcript**）+
		//     注入纠正指令为 user 消息 + 续跑重试（legacy 上限 2）；
		//   · 超限   ⇒ 发 exhausted 丢弃事件，按正常终轮处理（文本留在 transcript 维持历史连贯，
		//     UI 侧由 discard 事件清屏）。
		const leakGuard = activeConfig.textToolCallLeakGuard;
		if (leakGuard && toolCalls.length === 0 && leakGuard.detect(extractAssistantText(assistantMessage))) {
			if (leakAttempts < leakGuard.retryLimit) {
				leakAttempts++;
				await emit({ type: 'discard_streamed_text', reason: 'xml-tool-call-leak' });
				// 丢弃泄漏文本：把刚推入的 assistant 消息从 transcript 撤出（对齐 legacy「跳过入库」）
				newMessages.pop();
				context.messages.pop();
				const nudge = {
					role: 'user',
					content: leakGuard.reminder(),
					timestamp: Date.now(),
				} as AgentMessage;
				await emit({ type: 'message_start', message: nudge });
				await emit({ type: 'message_end', message: nudge });
				newMessages.push(nudge);
				context.messages.push(nudge);
				// 续跑一轮纠正：沿用常规轮的 turn 计数/钩子/turn 纪律
				await emit({ type: 'turn_end' });
				turnIndex++;
				activeConfig = await applyNextTurnUpdate(activeConfig, context, turnIndex);
				await emit({ type: 'turn_start' });
				continue;
			}
			await emit({ type: 'discard_streamed_text', reason: 'xml-tool-call-leak-exhausted' });
		}

		// ── 未完成轮安全续跑（对齐 legacy executor:2375-2470，顺序在 XML 泄漏之后）────
		// 无工具调用的收尾候选轮：空 / 只有思考 / 截断 / 工具调用丢失 ⇒ 按类注入纠正指令续跑。
		// discard=true 撤出本轮消息（空/幻觉文本无参考价值）；false 保留半截文本续写。
		if (toolCalls.length === 0 && !wrapUpDone && activeConfig.incompleteTurnRetry) {
			const retry = activeConfig.incompleteTurnRetry(assistantMessage);
			if (retry) {
				if (retry.discard) {
					await emit({ type: 'discard_streamed_text', reason: `incomplete-turn-${retry.kind}` });
					newMessages.pop();
					context.messages.pop();
				}
				const nudge = {
					role: 'user',
					content: retry.instruction,
					timestamp: Date.now(),
				} as AgentMessage;
				await emit({ type: 'message_start', message: nudge });
				await emit({ type: 'message_end', message: nudge });
				newMessages.push(nudge);
				context.messages.push(nudge);
				// 续跑计入 turn 纪律（消耗迭代预算 —— 与 legacy 每续跑一轮占一次 iteration 同）
				await emit({ type: 'turn_end' });
				turnIndex++;
				activeConfig = await applyNextTurnUpdate(activeConfig, context, turnIndex);
				await emit({ type: 'turn_start' });
				continue;
			}
		}

		hasMoreToolCalls = false;
		if (toolCalls.length > 0 && !wrapUpDone) {
			const batch = await executeToolCalls(context, assistantMessage, activeConfig, signal, emit);
			for (const message of batch.messages) {
				newMessages.push(message);
				context.messages.push(message);
			}
			hasMoreToolCalls = !batch.terminate;
		} else if (toolCalls.length > 0) {
			// 收尾轮里模型仍写工具调用（provider 无视 toolChoice:'none'）—— 不执行
			// （legacy 'stop' 语义）。悬空 tool_calls **就地摘除**：本迭代即最后一轮
			// （下方跳出条件必然成立）⇒ 不摘的话会永久留在权威 transcript 里，
			// 逼着 LMBridge 每轮重剥（2026-09-20 实证：孤儿数会随会话增长）。
			hasMoreToolCalls = false;
			const prunedWrapUp = pruneOrphanedToolCalls(context.messages);
			if (hasPruneEffect(prunedWrapUp)) { activeConfig.onTranscriptPruned?.(prunedWrapUp); }
		}

		const shouldStop = await evaluateShouldStop(activeConfig, context, turnIndex, assistantMessage);
		await emit({ type: 'turn_end' });
		if (shouldStop) {
			break;
		}
		if (!hasMoreToolCalls) {
			// 模型本想停：不立即退出 —— 回顶部轮询一次 steering，有插话则续跑（follow-up）。
			continue;
		}

		turnIndex++;
		activeConfig = await applyNextTurnUpdate(activeConfig, context, turnIndex);
		await emit({ type: 'turn_start' });
	}

	await emit({ type: 'agent_end' });
}

/** 提取 assistant 消息的可见文本（XML 泄漏检测用；thinking/工具块不计）。 */
function extractAssistantText(message: AssistantMessage): string {
	let out = '';
	for (const block of message.content) {
		if ((block as { type?: string }).type === 'text') {
			out += (block as { text?: string }).text ?? '';
		}
	}
	return out.trim();
}

/** 逆序找最近一条 assistant 消息（收尾轮判定用：上轮模型是否仍在要工具）。 */
function findLastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role === 'assistant' && Array.isArray((m as AssistantMessage).content)) {
			return m as AssistantMessage;
		}
	}
	return undefined;
}

/** 从助手消息中取出全部工具调用。 */
function collectToolCalls(message: AssistantMessage): AgentToolCall[] {
	const calls: AgentToolCall[] = [];
	for (const block of message.content) {
		if (block.type === 'toolCall') {
			calls.push({ id: block.id, name: block.name, arguments: block.arguments });
		}
	}
	return calls;
}

/** 调用宿主的停止判定钩子；未配置时返回 false。 */
async function evaluateShouldStop(
	config: AgentLoopConfig,
	context: AgentContext,
	turnIndex: number,
	lastAssistantMessage: AssistantMessage,
): Promise<boolean> {
	if (!config.shouldStopAfterTurn) {
		return false;
	}
	return await config.shouldStopAfterTurn({
		messages: context.messages,
		turnIndex,
		lastAssistantMessage,
	});
}

/** 调用宿主的轮间更新钩子，返回合并后的配置。 */
async function applyNextTurnUpdate(
	config: AgentLoopConfig,
	context: AgentContext,
	turnIndex: number,
): Promise<AgentLoopConfig> {
	if (!config.prepareNextTurn) {
		return config;
	}

	const update = await config.prepareNextTurn({ messages: context.messages, turnIndex });
	if (!update) {
		return config;
	}

	return { ...config, ...update };
}

/**
 * 流式生成一次助手响应。
 *
 * 复刻自 pi `streamAssistantResponse`。关键语义：每个增量事件的 `partial` 都是当前
 * **完整快照**，loop 用它原地替换上下文尾部消息 —— 消费方无需自行拼接。
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<AssistantMessage> {
	let messages: readonly AgentMessage[] = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const transcript = normalizeTranscript(llmMessages, context.tools);

	const resolvedApiKey = config.getApiKey
		? (await config.getApiKey(config.model.provider)) || config.apiKey
		: config.apiKey;

	const response = await streamFn(config.model, transcript, {
		...config.streamOptions,
		apiKey: resolvedApiKey,
		signal,
	});

	let accumulated: AssistantMessage | null = null;

	for await (const event of response) {
		switch (event.type) {
			case 'start':
				accumulated = event.partial;
				await emit({ type: 'message_start', message: event.partial });
				break;

			case 'text_start':
			case 'text_delta':
			case 'text_end':
			case 'thinking_start':
			case 'thinking_delta':
			case 'thinking_end':
			case 'toolcall_start':
			case 'toolcall_delta':
			case 'toolcall_end':
				accumulated = event.partial;
				await emit({
					type: 'message_update',
					message: event.partial,
					assistantMessageEvent: event,
				});
				break;

			case 'done':
				accumulated = event.message;
				await emit({ type: 'message_end', message: event.message });
				break;

			case 'error':
				accumulated = event.message;
				await emit({ type: 'message_end', message: event.message });
				break;

			default:
				break;
		}
	}

	if (!accumulated) {
		return createErrorAssistantMessage('模型流未产生任何消息');
	}

	// 输出被 token 上限截断时，未完成的工具调用必须以失败结果收尾 —— 否则循环会
	// 带着残缺参数去执行工具，或永久卡在"等待工具结果"状态。
	if (accumulated.stopReason === 'length') {
		await failToolCallsFromTruncatedMessage(accumulated, emit);
	}

	return accumulated;
}

/** 将 LLM 消息归一化为 transcript 上下文（工具定义随附 —— 模型层唯一工具通道）。 */
function normalizeTranscript(messages: readonly Message[], tools?: readonly AgentTool[]): TranscriptContext {
	return tools && tools.length > 0 ? { messages, tools } : { messages };
}

/** 构造一条表示失败的助手消息，避免 loop 因 `null` 而中断。 */
function createErrorAssistantMessage(errorMessage: string): AssistantMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text: '' }],
		stopReason: 'error',
		errorMessage,
	};
}

/**
 * 令被截断消息中的工具调用全部失败。
 *
 * 复刻自 pi `failToolCallsFromTruncatedMessage`。流式产出的工具调用参数可能在中途被
 * token 上限截断，此时 JSON 不完整、参数不可信。pi 的做法是逐条合成失败结果，让模型
 * 在下一轮看到明确反馈，而不是执行半个工具。
 */
async function failToolCallsFromTruncatedMessage(
	message: AssistantMessage,
	emit: AgentEventSink,
): Promise<void> {
	for (const block of message.content) {
		if (block.type !== 'toolCall') {
			continue;
		}

		const result = createErrorToolResult(
			`工具调用「${block.name}」的参数因输出长度上限被截断，未执行。请重新发起该调用，或减小单次参数体积。`,
		);

		await emit({
			type: 'tool_execution_end',
			toolCallId: block.id,
			toolName: block.name,
			result,
			isError: true,
		});
	}
}

/** 构造一条错误形态的工具结果。 */
function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: 'text', text: message }],
		details: undefined,
	};
}

/**
 * 派发一批工具调用。
 *
 * 复刻自 pi `executeToolCalls`。串行/并行由两处决定：
 * 1. `config.toolExecution === 'sequential'` —— 全局策略
 * 2. 批内任一工具声明 `executionMode: 'sequential'` —— 单工具强制
 */
async function executeToolCalls(
	context: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = collectToolCalls(assistantMessage);

	const hasSequentialToolCall = toolCalls.some(
		(call) => context.tools?.find((tool) => tool.name === call.name)?.executionMode === 'sequential',
	);

	if (config.toolExecution === 'sequential' || hasSequentialToolCall) {
		return executeToolCallsSequential(context, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(context, assistantMessage, toolCalls, config, signal, emit);
}

/**
 * 串行执行：每个工具「准备 → 执行 → 收尾」完成后才开始下一个。
 *
 * 复刻自 pi `executeToolCallsSequential`。
 */
async function executeToolCallsSequential(
	context: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: readonly AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: 'tool_execution_start',
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(context, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;

		if (preparation.kind === 'immediate') {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const result = await executePreparedToolCall(preparation, signal, emit, toolCall);
			finalized = await finalizeExecutedToolCall(preparation, result, config, toolCall, emit);
		}

		finalizedCalls.push(finalized);
		await emitToolExecutionEnd(finalized, emit);
		messages.push(createToolResultMessage(finalized));
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

/**
 * 并行执行：先**串行**准备全部工具（保证 beforeToolCall 顺序确定），再并发执行允许的
 * 工具。`tool_execution_end` 按**完成顺序**发射，而工具结果消息按**助手源顺序**排列 ——
 * 这是 pi 的刻意设计，复刻时保留。
 */
async function executeToolCallsParallel(
	context: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: readonly AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: 'tool_execution_start',
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
	}

	// 准备阶段保持串行：beforeToolCall 钩子可能有副作用，并发调用顺序不确定。
	const preparations: (ToolCallPreparation | null)[] = [];
	for (const toolCall of toolCalls) {
		preparations.push(await prepareToolCall(context, assistantMessage, toolCall, config, signal));
	}

	// 执行阶段并发；被拦截的（immediate）直接取预置结果，不占用并发槽位。
	const outcomes = await Promise.all(
		preparations.map(async (preparation, index): Promise<FinalizedToolCallOutcome> => {
			const toolCall = toolCalls[index];
			if (!preparation) {
				return {
					toolCall,
					result: createErrorToolResult('工具准备阶段未返回结果'),
					isError: true,
				};
			}
			if (preparation.kind === 'immediate') {
				return {
					toolCall,
					result: preparation.result,
					isError: preparation.isError,
				};
			}

			const result = await executePreparedToolCall(preparation, signal, emit, toolCall);
			return await finalizeExecutedToolCall(preparation, result, config, toolCall, emit);
		}),
	);

	for (const finalized of outcomes) {
		await emitToolExecutionEnd(finalized, emit);
		messages.push(createToolResultMessage(finalized));
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(outcomes),
	};
}

/**
 * 准备一次工具调用：解析工具、校验参数、跑 `beforeToolCall` 钩子。
 *
 * 复刻自 pi `prepareToolCall`。任一环节失败都返回 `immediate`（合成错误结果），
 * 不抛错 —— 保证批内其余工具不受影响。
 */
async function prepareToolCall(
	context: AgentContext,
	_assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<ToolCallPreparation> {
	const tool = context.tools?.find((candidate) => candidate.name === toolCall.name);
	if (!tool) {
		return {
			kind: 'immediate',
			result: createErrorToolResult(`未找到名为「${toolCall.name}」的工具`),
			isError: true,
		};
	}

	if (!config.beforeToolCall) {
		return { kind: 'execute', tool, args: toolCall.arguments };
	}

	const decision = await config.beforeToolCall({
		toolCall,
		tool,
		args: toolCall.arguments,
		signal,
	});

	if (decision.kind === 'blocked') {
		return {
			kind: 'immediate',
			result: createErrorToolResult(`工具调用被拦截：${decision.reason}`),
			isError: true,
		};
	}

	return { kind: 'execute', tool, args: decision.args ?? toolCall.arguments };
}

/** 执行已准备好的工具调用。工具自身抛错时转为错误结果，不向上传播。 */
async function executePreparedToolCall(
	preparation: Extract<ToolCallPreparation, { kind: 'execute' }>,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	toolCall: AgentToolCall,
): Promise<AgentToolResult<unknown>> {
	const onUpdate = async (update: Partial<AgentToolResult<unknown>>): Promise<void> => {
		await emit({
			type: 'tool_execution_update',
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			update,
		});
	};

	try {
		return await preparation.tool.execute(toolCall.id, preparation.args, signal, onUpdate);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return createErrorToolResult(`工具「${toolCall.name}」执行失败：${message}`);
	}
}

/**
 * 收尾一次工具执行：跑 `afterToolCall` 钩子，允许改写结果。
 *
 * 复刻自 pi `finalizeExecutedToolCall`。
 */
async function finalizeExecutedToolCall(
	preparation: Extract<ToolCallPreparation, { kind: 'execute' }>,
	result: AgentToolResult<unknown>,
	config: AgentLoopConfig,
	toolCall: AgentToolCall,
	_emit: AgentEventSink,
): Promise<FinalizedToolCallOutcome> {
	const isError = detectToolResultError(result);

	if (!config.afterToolCall) {
		return { toolCall, result, isError };
	}

	const decision: AfterToolCallResult = await config.afterToolCall({
		toolCall,
		tool: preparation.tool,
		args: preparation.args,
		result,
		isError,
	});

	if (decision.kind === 'replace') {
		return {
			toolCall,
			result: decision.result,
			isError: decision.isError ?? detectToolResultError(decision.result),
		};
	}

	return { toolCall, result, isError };
}

/**
 * 判定工具结果是否为错误。
 *
 * pi 原版由工具实现自报错误（`AgentToolResult` 无 `isError` 字段，实际错误经异常表达）。
 * 本仓的工具层以内容文本表达失败，故此处兼顾两者：异常路径已在 executePreparedToolCall
 * 转为 `isError`，内容判定作为补充。
 */
function detectToolResultError(result: AgentToolResult<unknown>): boolean {
	const details = result.details as { isError?: unknown } | undefined;
	return details?.isError === true;
}

/**
 * 批终止判定：任一工具返回 `terminate: true` 即终止整批。
 *
 * 复刻自 pi `shouldTerminateToolBatch`。
 */
function shouldTerminateToolBatch(finalizedCalls: readonly FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.some((finalized) => finalized.result.terminate === true);
}

/** 发射 `tool_execution_end` 事件。 */
async function emitToolExecutionEnd(
	finalized: FinalizedToolCallOutcome,
	emit: AgentEventSink,
): Promise<void> {
	await emit({
		type: 'tool_execution_end',
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

/** 将工具执行终态转为 LLM 可消费的工具结果消息。 */
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: 'toolResult',
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		isError: finalized.isError,
	};
}

/** 供 streamAdapter 判定停止原因是否为失败态。 */
export function isFailureStopReason(reason: StopReason | undefined): boolean {
	return reason === 'error' || reason === 'aborted';
}
