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
 *--------------------------------------------------------------------------------------------*/

import type {
	AfterToolCallResult,
	AgentContext,
	AgentEventSink,
	AgentLoopConfig,
	AgentMessage,
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

	while (hasMoreToolCalls) {
		if (signal?.aborted) {
			break;
		}
		if (activeConfig.maxTurns !== undefined && turnIndex >= activeConfig.maxTurns) {
			break;
		}

		const assistantMessage = await streamAssistantResponse(context, activeConfig, signal, emit, streamFn);
		newMessages.push(assistantMessage);
		context.messages.push(assistantMessage);

		// 流以 error / aborted 收尾时，本轮不可能再有可执行的工具调用，直接终结。
		if (assistantMessage.stopReason === 'error' || assistantMessage.stopReason === 'aborted') {
			await emit({ type: 'turn_end' });
			break;
		}

		const toolCalls = collectToolCalls(assistantMessage);

		hasMoreToolCalls = false;
		if (toolCalls.length > 0) {
			const batch = await executeToolCalls(context, assistantMessage, activeConfig, signal, emit);
			for (const message of batch.messages) {
				newMessages.push(message);
				context.messages.push(message);
			}
			hasMoreToolCalls = !batch.terminate;
		}

		const shouldStop = await evaluateShouldStop(activeConfig, context, turnIndex, assistantMessage);
		await emit({ type: 'turn_end' });
		if (shouldStop || !hasMoreToolCalls) {
			break;
		}

		turnIndex++;
		activeConfig = await applyNextTurnUpdate(activeConfig, context, turnIndex);
		await emit({ type: 'turn_start' });
	}

	await emit({ type: 'agent_end' });
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
	const transcript = normalizeTranscript(llmMessages);

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

/** 将 LLM 消息归一化为 transcript 上下文。 */
function normalizeTranscript(messages: readonly Message[]): { messages: readonly Message[] } {
	return { messages };
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
