/*---------------------------------------------------------------------------------------------
 *  piLoop/streamAdapter.ts — 本仓 IModelProvider ⟷ pi StreamFn 的双向适配
 *
 *  这是 pi agentloop 落地本项目的**核心改造点**：两边的流式契约形状不同。
 *
 *    pi 侧    StreamFn(model, TranscriptContext, options) → AssistantMessageEventStream
 *             事件：start / text_* / thinking_* / toolcall_* / done / error
 *             语义：每个事件携带 `partial`（完整快照）
 *
 *    本仓侧    provider.chat(modelId, IChatMessage[], IModelOptions, IChatContext)
 *             → AsyncIterable<IModelDelta>
 *             事件：text / thinking / tool_call / done / error / usage / tool_progress
 *             语义：增量片段，消费方自行累积
 *
 *  适配方向：本仓 provider → pi StreamFn（即 pi loop 驱动本仓模型层）。
 *
 *  ⚠ 契约铁律（pi types.ts 明确要求，不可放宽）：
 *  `StreamFn` 对请求/模型/运行时失败**不得抛错**，必须把失败编码为流内事件 +
 *  终态 `stopReason: 'error' | 'aborted'` + `errorMessage`。故 `createPiStreamFn`
 *  内部全量 try/catch，任何异常都转为 error 事件。
 *--------------------------------------------------------------------------------------------*/

import type { IChatContext, IChatMessage, IModelDelta, IModelOptions, IModelProvider, IToolDefinition } from '../../common/providers.js';
import { markChatMessagesDerived } from '../../common/providers.js';
import type {
	AssistantContent,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFn,
	TextContent,
	ThinkingContent,
	ToolCallContent,
	ToolResultMessage,
} from './types.js';

/** 本仓 provider 无法提供的模型元信息，由调用方补齐。 */
export interface PiStreamFnOptions {
	/** 图片生成等非对话能力的 provider id 过滤（可选）。 */
	readonly modelId?: string;
	/** 透传给本仓 `IModelOptions` 的推理强度等参数。 */
	readonly modelOptions?: IModelOptions;
	/** 透传给本仓 `IChatContext` 的调用上下文（宿主、工具定义等）。 */
	readonly chatContext?: IChatContext;
}

/**
 * 把本仓的 `IModelProvider` 适配为 pi 的 `StreamFn`。
 *
 * 用法：
 * ```ts
 * const streamFn = createPiStreamFn(modelProvider, { modelId: 'claude-sonnet-4-6' });
 * await runAgentLoop(prompts, context, config, emit, signal, streamFn);
 * ```
 *
 * @param provider 本仓模型 provider（负责鉴权、重试、SSE 解析）
 * @param options  模型选择与透传参数
 * @returns 满足 pi 契约的流函数
 */
export function createPiStreamFn(provider: IModelProvider, options: PiStreamFnOptions = {}): StreamFn {
	return (model: Model, context, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream => {
		return createEventStream(async (push) => {
			const accumulated = createEmptyAssistantMessage(model);

			try {
				const chatMessages = convertToChatMessages(context.messages);
				const modelId = options.modelId ?? model.id;
				// ★ 2026-09-20（真机双跑实证）：工具定义必须随每次请求送达模型（TranscriptContext.tools
				// 是唯一通道；缺失时模型看不到任何工具 ⇒ 自称"无法访问文件系统"）。
				const toolDefs = (context.tools ?? []).map(t => ({
					name: t.name, description: t.description, inputSchema: t.inputSchema,
				} as IToolDefinition));

				const iterator = provider.chat(
					modelId,
					chatMessages,
					buildModelOptions(options.modelOptions, streamOptions, toolDefs.length > 0 ? toolDefs : undefined),
					options.chatContext,
				);

				push({ type: 'start', partial: cloneAssistantMessage(accumulated) });

				for await (const delta of iterator) {
					applyDelta(delta, accumulated, push);
				}

				// 正常收尾：stopReason 已由 done 事件写入（缺省视作 stop）。
				if (!accumulated.stopReason) {
					(accumulated as Mutable<AssistantMessage>).stopReason = 'stop';
				}
				push({ type: 'done', message: cloneAssistantMessage(accumulated) });
				return cloneAssistantMessage(accumulated);
			} catch (error) {
				return handleStreamFailure(error, accumulated, streamOptions, push);
			}
		});
	};
}

/** 可变的助手消息（pi 的类型是 readonly，适配层需要就地累积）。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 构造初始（空）助手消息。 */
function createEmptyAssistantMessage(model: Model): AssistantMessage {
	return {
		role: 'assistant',
		content: [],
		usage: { input: 0, output: 0 },
		model: `${model.provider}/${model.id}`,
	};
}

/** 深拷贝助手消息，避免下游持有可变引用。 */
function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((block) => ({ ...block })),
	};
}

/**
 * 消费一条本仓 `IModelDelta`，更新累积状态并发射对应的 pi 事件。
 *
 * 两边的语义落差在此处收平：本仓是增量，pi 要求每个事件带完整 `partial`。
 */
function applyDelta(
	delta: IModelDelta,
	accumulated: AssistantMessage,
	push: (event: AssistantMessageEvent) => void,
): void {
	switch (delta.type) {
		case 'text': {
			if (typeof delta.content === 'string') {
				appendText(accumulated, delta.content);
				push({
					type: 'text_delta',
					delta: delta.content,
					partial: cloneAssistantMessage(accumulated),
				});
			}
			return;
		}

		case 'thinking': {
			if (typeof delta.content === 'string') {
				appendThinking(accumulated, delta.content);
				push({
					type: 'thinking_delta',
					delta: delta.content,
					partial: cloneAssistantMessage(accumulated),
				});
			}
			return;
		}

		case 'tool_call': {
			if (!delta.toolCall) {
				return;
			}
			upsertToolCall(accumulated, delta.toolCall);
			push({ type: 'toolcall_delta', delta: '', partial: cloneAssistantMessage(accumulated) });
			return;
		}

		case 'usage': {
			if (delta.usage) {
				(accumulated as Mutable<AssistantMessage>).usage = {
					input: delta.usage.inputTokens ?? 0,
					output: delta.usage.outputTokens ?? 0,
					cacheRead: delta.usage.cachedTokens,
				};
			}
			return;
		}

		case 'done': {
			(accumulated as Mutable<AssistantMessage>).stopReason = mapFinishReason(delta.finishReason);
			return;
		}

		case 'error': {
			(accumulated as Mutable<AssistantMessage>).stopReason = 'error';
			(accumulated as Mutable<AssistantMessage>).errorMessage = delta.error ?? '模型返回未知错误';
			return;
		}

		case 'tool_progress':
			// 本仓的进度提示仅供 UI 与 idle 计时器续命；pi 事件面无对应项，不透传。
			return;

		default:
			return;
	}
}

/** 追加文本内容块。空串不产生内容块（避免污染 content 数组）。 */
function appendText(accumulated: AssistantMessage, chunk: string): void {
	if (chunk.length === 0) {
		return;
	}

	const content = accumulated.content as Mutable<AssistantContent>[];
	const last = content[content.length - 1];

	if (last && last.type === 'text') {
		content[content.length - 1] = { type: 'text', text: last.text + chunk };
		return;
	}
	content.push({ type: 'text', text: chunk });
}

/** 追加思考内容块。 */
function appendThinking(accumulated: AssistantMessage, chunk: string): void {
	if (chunk.length === 0) {
		return;
	}

	const content = accumulated.content as Mutable<AssistantContent>[];
	const last = content[content.length - 1];

	if (last && last.type === 'thinking') {
		content[content.length - 1] = { type: 'thinking', thinking: last.thinking + chunk };
		return;
	}
	content.push({ type: 'thinking', thinking: chunk });
}

/**
 * 写入或更新一条工具调用。
 *
 * 本仓 `IToolCallInfo.arguments` 是 **JSON 字符串**，pi 要求**已解析对象**。
 * 解析失败时降级为空对象 —— 让 `prepareToolCall` 走参数校验路径给出明确错误，
 * 而不是让整个流崩掉。
 */
function upsertToolCall(
	accumulated: AssistantMessage,
	toolCall: { id: string; name: string; arguments: string },
): void {
	const content = accumulated.content as Mutable<AssistantContent>[];
	const parsedArguments = parseToolArguments(toolCall.arguments);

	const existingIndex = content.findIndex(
		(block): block is ToolCallContent => block.type === 'toolCall' && block.id === toolCall.id,
	);

	const next: ToolCallContent = {
		type: 'toolCall',
		id: toolCall.id,
		name: toolCall.name,
		arguments: parsedArguments,
	};

	if (existingIndex >= 0) {
		content[existingIndex] = next;
		return;
	}
	content.push(next);
}

/** 解析工具参数 JSON；失败返回空对象。 */
function parseToolArguments(raw: string): Record<string, unknown> {
	if (!raw || raw.trim().length === 0) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

/** 本仓 finishReason → pi stopReason。 */
function mapFinishReason(finishReason: string | undefined): AssistantMessage['stopReason'] {
	switch (finishReason) {
		case 'length':
		case 'max_tokens':
			return 'length';
		case 'tool_calls':
		case 'tool_use':
			return 'toolUse';
		case 'error':
			return 'error';
		default:
			return 'stop';
	}
}

/** 把 pi 的 transcript 消息转为本仓的 `IChatMessage[]`。 */
export function convertToChatMessages(messages: readonly Message[]): IChatMessage[] {
	// ★ 2026-09-20：本函数产出的是**派生的一次性副本**（每次调用新建数组，与内核
	// transcript 无引用关系）⇒ 打标，供 `LMBridge` 的发送前守卫跳过「回写历史」
	// 这一无效动作并如实记日志（详见 providers.ts 的 CHAT_MESSAGES_DERIVED 注释）。
	return markChatMessagesDerived(messages.map(convertOneMessage));
}

/** 单条消息转换。 */
function convertOneMessage(message: Message): IChatMessage {
	const role = message.role === 'toolResult' ? 'tool' : message.role;

	// ★★ 2026-09-20 契约修复（真机报文取证 vscode-app-1789900477124）：
	// pi `toolResult` → 本仓 `tool` 消息时**必须携带 `toolCallId`**。此前漏传导致
	// 下游 `ContextManager.sanitizeToolPairs` 的 respondedIds 恒为空 ⇒ 每轮把 assistant
	// 的 tool_calls 全部剥离、网关收到「61 条 tool_call_id 为空串的孤儿工具结果 +
	// 0 条带 tool_calls 的 assistant」⇒ 模型失去「调用→结果」因果；严格网关
	// （OpenAI/Azure/Anthropic）会直接 400，仅 IOA 容忍掩盖。
	const toolCallId = message.role === 'toolResult'
		? (message as ToolResultMessage).toolCallId
		: undefined;

	if (typeof message.content === 'string') {
		return toolCallId
			? { role, content: message.content, toolCallId }
			: { role, content: message.content };
	}

	const textParts: string[] = [];
	const toolCalls: { id: string; name: string; arguments: string }[] = [];

	for (const block of message.content as readonly { type: string }[]) {
		switch (block.type) {
			case 'text':
				textParts.push((block as TextContent).text);
				break;
			case 'thinking':
				// pi 的 thinking 块在本仓对应 `reasoning` 字段，此处并入文本以保证
				// 模型能看见自身上一轮的思考（与 agentTurnExecutor 的既有行为一致）。
				// 注意：`Message.content` 的静态联合不含 thinking（pi 原版亦如此），
				// 但运行时的 assistant 消息可能携带该块，故按结构判定而非联合收窄。
				textParts.push((block as ThinkingContent).thinking);
				break;
			case 'toolCall':
				toolCalls.push({
					id: (block as ToolCallContent).id,
					name: (block as ToolCallContent).name,
					arguments: JSON.stringify((block as ToolCallContent).arguments),
				});
				break;
			default:
				break;
		}
	}

	const result: IChatMessage = { role, content: textParts.join('') };
	if (toolCallId) {
		(result as Mutable<IChatMessage>).toolCallId = toolCallId;
	}
	if (toolCalls.length > 0) {
		(result as Mutable<IChatMessage>).toolCalls = toolCalls;
	}
	return result;
}

/** 合并本仓选项与 pi 透传选项；后者优先。`tools` 仅在调用方未自带时补入。 */
function buildModelOptions(
	base: IModelOptions | undefined,
	streamOptions: SimpleStreamOptions | undefined,
	tools?: readonly IToolDefinition[],
): IModelOptions {
	const merged: Record<string, unknown> = { ...base };
	if (tools && tools.length > 0 && merged['tools'] === undefined) {
		merged['tools'] = [...tools];
	}

	if (streamOptions) {
		if (typeof streamOptions.temperature === 'number') {
			merged.temperature = streamOptions.temperature;
		}
		if (typeof streamOptions.maxTokens === 'number') {
			merged.maxTokens = streamOptions.maxTokens;
		}
		if (streamOptions.thinkingLevel !== undefined) {
			merged.reasoningEffort = streamOptions.thinkingLevel;
		}
		// toolChoice 直通（撞顶收尾轮的禁工具语义依赖它，对齐 executor:1428 `toolChoice:'none'`）
		if (streamOptions['toolChoice'] !== undefined) {
			merged['toolChoice'] = streamOptions['toolChoice'];
		}
	}
	return merged as IModelOptions;
}

/**
 * 处理流式过程中的异常，转为 pi 契约要求的 error 事件。
 *
 * 中止（AbortError）与真实错误分开映射：前者 `stopReason: 'aborted'`，
 * 下游据此区分「用户主动取消」与「请求失败」。
 */
function handleStreamFailure(
	error: unknown,
	accumulated: AssistantMessage,
	streamOptions: SimpleStreamOptions | undefined,
	push: (event: AssistantMessageEvent) => void,
): AssistantMessage {
	const aborted = isAbortError(error) || streamOptions?.signal?.aborted === true;

	(accumulated as Mutable<AssistantMessage>).stopReason = aborted ? 'aborted' : 'error';
	(accumulated as Mutable<AssistantMessage>).errorMessage = aborted
		? '请求已被取消'
		: error instanceof Error
			? error.message
			: String(error);

	const failure: AssistantMessageEvent = { type: 'error', message: cloneAssistantMessage(accumulated) };
	push(failure);
	return cloneAssistantMessage(accumulated);
}

/** 判定是否为中止类错误。 */
function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === 'AbortError') {
		return true;
	}
	if (error instanceof Error && error.name === 'AbortError') {
		return true;
	}
	return false;
}

/**
 * 构造 pi 契约要求的 `AssistantMessageEventStream`。
 *
 * pi 原版用自家 `EventStream` 工具类（`pi-ai`）。此处以最小实现替代：
 * 边推送边缓冲，支持晚订阅（`for await` 在 `push` 之后才开始时也能取到全部事件），
 * 并提供 `result()` 取终值。
 */
function createEventStream(
	producer: (
		push: (event: AssistantMessageEvent) => void,
	) => Promise<AssistantMessage>,
): AssistantMessageEventStream {
	const buffered: AssistantMessageEvent[] = [];
	const waiters: (() => void)[] = [];
	let finished = false;
	let resultPromise: Promise<AssistantMessage> | undefined;

	const notify = (): void => {
		const pending = waiters.splice(0, waiters.length);
		for (const resolve of pending) {
			resolve();
		}
	};

	const push = (event: AssistantMessageEvent): void => {
		buffered.push(event);
		notify();
	};

	// 生产者立即启动。终态写入 `finished` 标志（而非依赖 promise 链），这样：
	// 1. 迭代器只需读 `finished`，无竞态；
	// 2. `resultPromise` 永不被拒绝 —— 失败已由 error 事件表达，若它同时是 rejected promise，
	//    无人 await 时会触发 unhandled rejection（实测会导致进程挂起）。
	resultPromise = (async (): Promise<AssistantMessage> => {
		try {
			return await producer(push);
		} catch (error) {
			// 契约要求失败经 error 事件表达。此处兜底：生产者若在推送 error 事件前就崩了，
			// 补推一个最小可用的终态消息，保证 result() 有值可返回。
			const fallback: AssistantMessage = {
				role: 'assistant',
				content: [],
				stopReason: 'error',
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			push({ type: 'error', message: fallback });
			return fallback;
		} finally {
			finished = true;
			notify();
		}
	})();

	const stream: AssistantMessageEventStream = {
		async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
			let cursor = 0;
			for (;;) {
				while (cursor < buffered.length) {
					yield buffered[cursor];
					cursor++;
				}
				if (finished) {
					return;
				}
				await new Promise<void>((resolve) => {
					waiters.push(resolve);
					// 入队后复查：生产者可能恰在 push 与入队之间结束。
					if (finished || cursor < buffered.length) {
						notify();
					}
				});
			}
		},

		result(): Promise<AssistantMessage> {
			return resultPromise as Promise<AssistantMessage>;
		},
	};

	return stream;
}
