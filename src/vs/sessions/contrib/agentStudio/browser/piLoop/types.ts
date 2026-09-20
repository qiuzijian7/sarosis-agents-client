/*---------------------------------------------------------------------------------------------
 *  piLoop/types.ts — pi agentloop 契约的本地复刻（自包含，零外部依赖）
 *
 *  复刻来源：https://github.com/earendil-works/pi  @ e98f287ee498e0116546f4e9aa083fdec9793cd2
 *            packages/agent/src/types.ts (462 行) + agent-loop.ts 的类型声明
 *
 *  为什么是「复刻」而非「依赖」：
 *  pi-agent-core 的 dist/index.js 顶层静态 import `@earendil-works/pi-ai`，而 pi-ai 的
 *  构建链依赖网络拉取模型数据（scripts/generate-models.ts → models.dev），在受控网络环境
 *  下无法构建（实测 TS2307: kimi-coding.models.ts）。故本项目自带一份类型契约。
 *
 *  ⚠ 对齐纪律（升级时必读）：
 *  本文件是 pi 公开契约的**逐字段照搬**。字段名、字面量联合、可选性均不得自行改动，
 *  否则 pi 生态的扩展/插件无法直接对接。若上游 pi 变更，需按 commit 比对后同步。
 *--------------------------------------------------------------------------------------------*/

// ─── pi-ai 侧类型的本地声明 ──────────────────────────────────────────────────
// 这些类型原本定义在 `@earendil-works/pi-ai`。此处仅复刻 agentloop 实际触及的字段子集，
// 保留原字段名与语义。刻意**不做** provider SDK 层（openai/anthropic/bedrock）的复刻。

/** LLM 消息角色。对应 pi-ai `Message["role"]`。 */
export type LlmMessageRole = 'user' | 'assistant' | 'toolResult' | 'system';

/** 转录卫生清理结果（AgentLoopConfig.onTranscriptPruned 的载荷；见 kernelTranscriptHygiene.ts）。 */
export interface ITranscriptPruneResult {
	/** 摘除的孤儿 tool call 块数。 */
	readonly prunedCalls: number;
	/** 摘除的孤儿 tool result 消息数。 */
	readonly prunedResults: number;
	/** 因内容清空而整条移除的消息数。 */
	readonly droppedMessages: number;
}

/** 文本内容块。 */
export interface TextContent {
	readonly type: 'text';
	readonly text: string;
}

/** 思考内容块（extended thinking）。 */
export interface ThinkingContent {
	readonly type: 'thinking';
	readonly thinking: string;
}

/** 图片内容块。 */
export interface ImageContent {
	readonly type: 'image';
	readonly data: string;
	readonly mimeType: string;
}

/** 工具调用内容块。 */
export interface ToolCallContent {
	readonly type: 'toolCall';
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/** 助手消息可承载的内容块联合。 */
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

/** 用户消息可承载的内容块联合。 */
export type UserContent = TextContent | ImageContent;

/** Token 使用量。 */
export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

/** 停止原因。`error` / `aborted` 表示失败编码在消息里而非抛错。 */
export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

/** LLM 消息（已归一化，可直接发给 provider）。 */
export interface Message {
	readonly role: LlmMessageRole;
	readonly content: string | readonly (TextContent | ImageContent | ToolCallContent)[];
}

/** 工具结果消息。 */
export interface ToolResultMessage {
	readonly role: 'toolResult';
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly isError: boolean;
}

/** 助手消息（含流式期间的 partial 形态）。 */
export interface AssistantMessage {
	readonly role: 'assistant';
	readonly content: readonly AssistantContent[];
	readonly stopReason?: StopReason;
	readonly errorMessage?: string;
	readonly usage?: Usage;
	readonly model?: string;
}

/** 模型标识。`Api` 复刻为字符串联合，避免引入 pi-ai 的 provider 枚举。 */
export interface Model<TApi extends string = string> {
	readonly provider: string;
	readonly id: string;
	readonly api: TApi;
}

/**
 * 归一化后的 transcript 上下文。system prompt 走 system messages，不走此处。
 * ⚠ 工具声明**必须**走此处的 `tools` 通道（2026-09-20 真机双跑实证）：fork 时曾假定
 * 「工具声明走 system messages」—— 但本仓 provider 的结构化工具调用只认
 * `IModelOptions.tools`（native function calling）；写进 system 文本不会产出
 * `tool_call` 增量 ⇒ 模型自称"无法访问文件系统"。mock streamFn 的测试暴露不出。
 */
export interface TranscriptContext {
	readonly messages: readonly Message[];
	/** 本轮可用工具 —— streamFn 把工具定义转交给模型层的**唯一**通道。 */
	readonly tools?: readonly AgentTool[];
}

// ─── 流式事件（对应 pi-ai AssistantMessageEvent）─────────────────────────────

/**
 * 助手消息流事件。
 *
 * 每个增量事件都携带 `partial`（当前完整快照）——这是 pi 的关键设计：消费方无需自行
 * 拼接增量，直接取 `partial` 即为权威状态。复刻时**必须保留**该语义。
 */
export type AssistantMessageEvent =
	| { readonly type: 'start'; readonly partial: AssistantMessage }
	| { readonly type: 'text_start'; readonly partial: AssistantMessage }
	| { readonly type: 'text_delta'; readonly delta: string; readonly partial: AssistantMessage }
	| { readonly type: 'text_end'; readonly partial: AssistantMessage }
	| { readonly type: 'thinking_start'; readonly partial: AssistantMessage }
	| { readonly type: 'thinking_delta'; readonly delta: string; readonly partial: AssistantMessage }
	| { readonly type: 'thinking_end'; readonly partial: AssistantMessage }
	| { readonly type: 'toolcall_start'; readonly partial: AssistantMessage }
	| { readonly type: 'toolcall_delta'; readonly delta: string; readonly partial: AssistantMessage }
	| { readonly type: 'toolcall_end'; readonly partial: AssistantMessage }
	| { readonly type: 'done'; readonly message: AssistantMessage }
	| { readonly type: 'error'; readonly message: AssistantMessage };

/** 助手消息事件流。实现需同时支持异步迭代与 `result()` 取终值。 */
export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
	/** 流结束后解析为最终助手消息。 */
	result(): Promise<AssistantMessage>;
}

/** 流式调用选项。复刻 pi-ai `SimpleStreamOptions` 中 agentloop 会透传的字段。 */
export interface SimpleStreamOptions {
	readonly apiKey?: string;
	readonly signal?: AbortSignal;
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly thinkingLevel?: ThinkingLevel;
	readonly [key: string]: unknown;
}

/** 思考深度档位。 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/**
 * 流函数 —— agentloop 与模型层之间的唯一缝。
 *
 * 契约（照搬 pi，不可放宽）：
 * - 对请求/模型/运行时失败**不得抛错、不得返回 rejected promise**；
 * - 必须返回 `AssistantMessageEventStream`；
 * - 失败须编码为流内 `error` 事件 + 终态 `stopReason: "error" | "aborted"` 与 `errorMessage`。
 *
 * 注意：loop 传入的是**已归一化**的 transcript —— system prompt 与工具声明由 transcript
 * 的 system 消息承载，绝不出现在 `context.systemPrompt` / `context.tools`。
 */
export type StreamFn = (
	model: Model,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

// ─── 工具（对应 pi types.ts 的 AgentTool）────────────────────────────────────

/** 工具执行模式。 */
export type ToolExecutionMode = 'sequential' | 'parallel';

/** 工具执行结果。 */
export interface AgentToolResult<TDetails = unknown> {
	/** 供 LLM 消费的内容块。 */
	readonly content: readonly (TextContent | ImageContent)[];
	/** 供 UI/宿主消费的结构化详情，不发给 LLM。 */
	readonly details?: TDetails;
	/**
	 * 工具主动终止整批工具调用的信号。pi 用于「一个工具失败后无需继续」的场景。
	 * 命中后 loop 会跳过同批剩余工具。
	 */
	readonly terminate?: boolean;
}

/** 工具执行期间的进度回调。 */
export type AgentToolUpdateCallback<TDetails = unknown> = (
	update: Partial<AgentToolResult<TDetails>>,
) => void | Promise<void>;

/**
 * 工具定义。
 *
 * `inputSchema` 在原版是 typebox `TSchema`。此处放宽为 `unknown`，由 `toolAdapter.ts`
 * 负责从本仓的裸 JSON Schema 桥接 —— 避免为此引入 typebox 运行时依赖。
 */
export interface AgentTool<TParameters = unknown, TDetails = unknown> {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: TParameters;
	/** 缺省为 `parallel`，但命中 config 的 sequential 策略时以 config 为准。 */
	readonly executionMode?: ToolExecutionMode;
	execute(
		toolCallId: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
	): Promise<AgentToolResult<TDetails>>;
}

/** 助手消息中的一个工具调用。 */
export interface AgentToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

// ─── AgentMessage（agentloop 的输入/输出单位）────────────────────────────────

/**
 * `AgentMessage` 是 agent 层的消息，比 LLM `Message` 更宽 —— 可携带应用自定义类型。
 *
 * 本仓的 memory / codebase / plan 等自定义消息即挂在此处，**不污染** LLM 视图；
 * 由 `AgentLoopConfig.convertToLlm` 决定哪些进入模型上下文。
 */
export interface AgentMessageBase {
	readonly role: string;
}

/** 标准 LLM 消息形态（含 user / assistant / toolResult）。 */
export type StandardAgentMessage = Message | AssistantMessage | ToolResultMessage;

/** 应用自定义消息。`customType` 供宿主识别，`data` 由宿主自解释。 */
export interface CustomAgentMessage extends AgentMessageBase {
	readonly customType: string;
	readonly data?: unknown;
}

export type AgentMessage = StandardAgentMessage | CustomAgentMessage;

// ─── 事件（AgentEventSink 的载荷）────────────────────────────────────────────

/** 工具执行开始事件。 */
export interface ToolExecutionStartEvent {
	readonly type: 'tool_execution_start';
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;
}

/** 工具执行进度事件。 */
export interface ToolExecutionUpdateEvent {
	readonly type: 'tool_execution_update';
	readonly toolCallId: string;
	readonly toolName: string;
	readonly update: Partial<AgentToolResult<unknown>>;
}

/** 工具执行结束事件。 */
export interface ToolExecutionEndEvent {
	readonly type: 'tool_execution_end';
	readonly toolCallId: string;
	readonly toolName: string;
	readonly result: AgentToolResult<unknown>;
	readonly isError: boolean;
}

/** agentloop 对外发射的事件联合。 */
export type AgentEvent =
  | { readonly type: 'agent_start' }
  | { readonly type: 'agent_end' }
  | { readonly type: 'turn_start' }
  | { readonly type: 'turn_end' }
  | { readonly type: 'message_start'; readonly message: AgentMessage }
  | { readonly type: 'message_update'; readonly message: AgentMessage; readonly assistantMessageEvent: AssistantMessageEvent }
  | { readonly type: 'message_end'; readonly message: AgentMessage }
  /** （2026-09-20 增补，超出 pi 原版）通知宿主丢弃本轮已流式渲染的文本（XML 泄漏重试等场景；对齐 legacy `discard_prior_text` delta）。 */
  | { readonly type: 'discard_streamed_text'; readonly reason: string }
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent;

/** 事件接收器。可同步或异步；loop 内部会 `await`。 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// ─── 队列模式 ────────────────────────────────────────────────────────────────

/**
 * 队列注入策略。
 * - `all`：在该 drain 点注入全部排队消息
 * - `one`：每次仅注入一条
 */
export type QueueMode = 'all' | 'one';

// ─── 钩子上下文 ──────────────────────────────────────────────────────────────

/** `beforeToolCall` 的入参。 */
export interface BeforeToolCallContext {
	readonly toolCall: AgentToolCall;
	readonly tool: AgentTool;
	readonly args: Record<string, unknown>;
	readonly signal: AbortSignal | undefined;
}

/** `beforeToolCall` 的返回值。返回 `blocked` 则跳过执行并合成一条错误结果。 */
export type BeforeToolCallResult =
	| { readonly kind: 'allow'; readonly args?: Record<string, unknown> }
	| { readonly kind: 'blocked'; readonly reason: string };

/** `afterToolCall` 的入参。 */
export interface AfterToolCallContext {
	readonly toolCall: AgentToolCall;
	readonly tool: AgentTool;
	readonly args: Record<string, unknown>;
	readonly result: AgentToolResult<unknown>;
	readonly isError: boolean;
}

/** `afterToolCall` 的返回值。可改写结果或追加终止信号。 */
export type AfterToolCallResult =
	| { readonly kind: 'keep' }
	| { readonly kind: 'replace'; readonly result: AgentToolResult<unknown>; readonly isError?: boolean };

/** 文本工具调用泄漏守卫（见 `AgentLoopConfig.textToolCallLeakGuard`）。 */
export interface ITextToolCallLeakGuard {
	/** 检测 assistant 文本里是否有伪 XML 工具调用（如 `<tool_calls:...>`）。 */
	detect(text: string): boolean;
	/** 纠正指令文案（作为 user 消息注入后重试一轮）。 */
	reminder(): string;
	/** 重试上限（legacy `XML_TOOL_LEAK_RETRY_LIMIT` = 2）。 */
	readonly retryLimit: number;
}

/** `shouldStopAfterTurn` 的入参。 */
export interface ShouldStopAfterTurnContext {
	readonly messages: readonly AgentMessage[];
	readonly turnIndex: number;
	readonly lastAssistantMessage: AssistantMessage | undefined;
}

/** `prepareNextTurn` 的入参。 */
export interface PrepareNextTurnContext {
	readonly messages: readonly AgentMessage[];
	readonly turnIndex: number;
}

/**
 * 下一轮的覆盖项。宿主据此在轮间热切换模型/工具/提示词，无需重启 loop。
 */
export interface AgentLoopTurnUpdate {
	readonly model?: Model;
	readonly systemPrompt?: string;
	readonly tools?: readonly AgentTool[];
}

// ─── AgentContext / AgentState ───────────────────────────────────────────────

/**
 * agent 运行上下文。`messages` 为可变数组 —— loop 会就地 push 新消息。
 * 这与 pi 原版一致（原版 `AgentContext.messages: AgentMessage[]`）。
 */
export interface AgentContext {
	messages: AgentMessage[];
	readonly systemPrompt?: string;
	readonly tools?: readonly AgentTool[];
}

/**
 * agent 状态快照。宿主可持久化后恢复。
 * 本仓的 memory / codebase 状态**不**放在此处 —— 它们由宿主自己的 RunState 承载。
 */
export interface AgentState {
	readonly systemPrompt?: string;
	readonly model?: Model;
	readonly thinkingLevel?: ThinkingLevel;
	readonly messages: readonly AgentMessage[];
	readonly activeToolNames?: readonly string[];
}

// ─── AgentLoopConfig ─────────────────────────────────────────────────────────

/**
 * agentloop 配置。这是宿主接入 loop 的**唯一**配置面。
 *
 * 复刻自 pi types.ts。字段全部保持原名与语义 —— pi 生态的扩展依赖这些名字。
 */
export interface AgentLoopConfig {
	readonly model: Model;

	/** AgentMessage[] → LLM Message[] 的转换。决定哪些自定义消息进入模型上下文。 */
	convertToLlm(messages: readonly AgentMessage[]): Promise<readonly Message[]> | readonly Message[];

	/** 轮间上下文变换（如压缩、注入）。在 convertToLlm 之前执行。 */
	readonly transformContext?: (
		messages: readonly AgentMessage[],
		signal: AbortSignal | undefined,
	) => Promise<readonly AgentMessage[]> | readonly AgentMessage[];

	/** 工具批执行模式。命中任一 sequential 工具时自动降级为串行。 */
	readonly toolExecution?: ToolExecutionMode;

	/** steering 队列注入策略。 */
	readonly steeringMode?: QueueMode;

	/** follow-up 队列注入策略。 */
	readonly followUpMode?: QueueMode;

	/**
	* steering 消息轮询（pi `agent-loop.ts:173/203/263` 语义，2026-09-20 补）：
	* 宿主提供的 getter，loop 在「起始 + 每个 turn 边界」轮询；取到的消息排进
	* **下一次模型调用之前**推入 transcript（用户插话）；模型本想停（无工具调用）时
	* 取到 ⇒ 续跑（follow-up 语义）。约定：返回即被无条件消费（lease/ack 由宿主在
	* getter 内完成——loop 保证同迭代内 drain）。
	*/
	readonly getSteeringMessages?: () => Promise<readonly AgentMessage[]> | readonly AgentMessage[];

	/** 静态 API key。与 `getApiKey` 二选一，后者优先（支持过期令牌刷新）。 */
	readonly apiKey?: string;

	/** 动态解析 API key，用于会过期的令牌。 */
	readonly getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/** 工具执行前置钩子。返回 `blocked` 即拦截。 */
	readonly beforeToolCall?: (
		context: BeforeToolCallContext,
	) => Promise<BeforeToolCallResult> | BeforeToolCallResult;

	/** 工具执行后置钩子。 */
	readonly afterToolCall?: (
		context: AfterToolCallContext,
	) => Promise<AfterToolCallResult> | AfterToolCallResult;

	/** 单轮结束后的停止判定。返回 true 则终止 agentloop。 */
	readonly shouldStopAfterTurn?: (
	context: ShouldStopAfterTurnContext,
	) => Promise<boolean> | boolean;

	/**
	 * （2026-09-20 增补，超出 pi 原版）
	 * 转录卫生回调：内核摘除「孤儿 tool 对」后通知宿主（计数用于日志/诊断）。
	 * 孤儿 = 有 tool_call 无 tool_result（收尾轮跳过执行 / abort 半批 / 历史遗留）
	 * 或反向；见 kernelTranscriptHygiene.ts 的背景说明。
	 */
	readonly onTranscriptPruned?: (result: ITranscriptPruneResult) => void;


	/**
	 * （2026-09-20 增补，超出 pi 原版，对齐 legacy executor:2294-2368）
	 * 文本形态工具调用泄漏守卫：模型把工具调用写成 XML/伪标签**纯文本**（未走 native
	 * function call）时，runLoop 在「本轮无工具调用且 detect 命中」时：
	 *   · 未超限 ⇒ 丢弃泄漏文本（发 `discard_streamed_text`，不入 transcript）+
	 *     注入 `reminder()` 纠正指令为 user 消息 + 续跑重试；
	 *   · 超限   ⇒ 发 `discard_streamed_text`（reason 后缀 `-exhausted`）后正常收尾。
	 * legacy 阈值：`XML_TOOL_LEAK_RETRY_LIMIT = 2`。
	 */
	readonly textToolCallLeakGuard?: ITextToolCallLeakGuard;

  /**
   * （2026-09-20 增补，超出 pi 原版，对齐 legacy `wrapUp.forced` 语义）
   * 强制收尾轮请求：返回**提醒文案** ⇒ runLoop 立即武装一轮禁工具收尾
   * （不等 maxTurns 撞顶），文案作为该轮的 user 注入；返回 undefined ⇒ 无请求。
   * 一次性语义：被消费后宿主应自清。驱动方用于「文本搜索连击硬上限」等
   * 「打断死循环、强制基于已收集信息收尾」的场景（executor:3400-3410）。
   */
readonly requestWrapUp?: () => string | undefined;

  /**
   * （2026-09-20 增补，超出 pi 原版，对齐 legacy executor:2375-2470「未完成轮安全续跑」）
   * 一轮流式结束且**无工具调用**时调用（收尾候选轮）。返回 ⇒ 续跑一轮纠正：
   *   · `discard: true`  ⇒ 本轮 assistant 消息撤出 transcript + 发 `discard_streamed_text`
   *     （空/幻觉/工具调用丢失 —— 文本无参考价值）；
   *   · `discard: false` ⇒ **保留**半截文本（length/truncated-text 续写语义：半截是有效产物，
   *     丢弃会让模型重写整段）；
   *   · `instruction`    ⇒ 作为 user 消息注入后重试。
   * 返回 undefined ⇒ 正常收尾。实现方负责按 kind 计数与上限（legacy 每类独立上限）。
   */
readonly incompleteTurnRetry?: (message: AssistantMessage) => {
  readonly instruction: string;
  readonly discard: boolean;
  readonly kind: string;
  } | undefined;

	/** 下一轮开始前的准备。可返回覆盖项以热切换模型/工具。 */
	readonly prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;

	/** 最大轮数上限，防止无限循环。未设则由 `shouldStopAfterTurn` 兜底。 */
	readonly maxTurns?: number;

	/** 透传给 `streamFn` 的额外选项。 */
	readonly streamOptions?: SimpleStreamOptions;
}

// ─── 内部执行结果类型 ────────────────────────────────────────────────────────

/** 单个工具调用的准备结果：立即终结（被拦截/参数非法）或待执行。 */
export type ToolCallPreparation =
	| { readonly kind: 'immediate'; readonly result: AgentToolResult<unknown>; readonly isError: boolean }
	| { readonly kind: 'execute'; readonly tool: AgentTool; readonly args: Record<string, unknown> };

/** 单个工具调用终态。 */
export interface FinalizedToolCallOutcome {
	readonly toolCall: AgentToolCall;
	readonly result: AgentToolResult<unknown>;
	readonly isError: boolean;
}

/** 一批工具调用的执行结果。 */
export interface ExecutedToolCallBatch {
	readonly messages: ToolResultMessage[];
	readonly terminate: boolean;
}
