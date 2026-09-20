/*---------------------------------------------------------------------------------------------
 * piCoreTypes.ts —— pi 内核与我方类型的**本地**出口（自洽，不依赖 npm 类型）。
 *
 * 为什么不从 npm 引类型（实证，勿再重推）：
 *   pi 的 npm `@earendil-works/pi-ai@0.85.1` 与 checkout（09-16，**未发布的新版**）**有漂移**
 *   （npm 根缺 `SystemMessage`/`ToolStateChanges`/`TranscriptContext` 等 ⇒ 0 命中）；
 *   且 renderer 不能裸引 npm 包（out/ 产物 0 条裸 npm 导入）。
 *   ⇒ 本文件是**适配层边界类型**，逐形状对着 checkout 源码核实（2026-09-19）。
 *   运行时行为由 `vendor/piAgentLoop.bundle.ts`（esbuild 自真实源码打包）保证忠实；
 *   本文件只约束**我方适配器**的形状 ⇒ 若有偏差，只会影响我方适配层内部，不会污染 pi 内核。
 *--------------------------------------------------------------------------------------------*/

// ─────────────────────────── pi-ai 侧 ───────────────────────────

export type Api = string;
export type ProviderId = string;
export type StopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';

export interface TextContent { type: 'text'; text: string; textSignature?: string }
export interface ThinkingContent { type: 'thinking'; thinking: string; thinkingSignature?: string }
export interface ImageContent { type: 'image'; data: string; mimeType: string }

export interface ToolCall {
	type: 'toolCall'; id: string; name: string; arguments: Record<string, any>;
	thoughtSignature?: string; namespace?: string;
}

export interface Usage {
	input: number; output: number; cacheRead: number; cacheWrite: number;
	cacheWrite1h?: number; reasoning?: number; totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface Tool<TParameters extends Record<string, unknown> = Record<string, unknown>> {
	name: string; description: string; parameters: TParameters;
	constrainedSampling?: false | Record<string, unknown>;
}
export interface ToolReference { name: string }
export interface ToolStateChanges { toolsAdded: Tool[]; toolsRemoved: ToolReference[] }

export interface Model<TApi extends Api = Api> {
	id: string; name?: string; api: TApi; provider: ProviderId;
	baseUrl?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number;
	headers?: Record<string, string>;
	[k: string]: unknown;
}

export interface SystemMessage {
	role: 'system'; content: string | TextContent[];
	sections?: Record<string, string | null>; timestamp?: number;
}
export interface UserMessage { role: 'user'; content: string | (TextContent | ImageContent)[]; timestamp: number }
export interface AssistantMessage {
	role: 'assistant';
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api; provider: ProviderId; model: string;
	responseModel?: string; responseId?: string; providerThinkingLevel?: string;
	diagnostics?: unknown[];
	usage: Usage; stopReason: StopReason; deferred?: unknown; errorMessage?: string; rawStopReason?: string;
	timestamp: number;
	[k: string]: unknown;
}
export interface ToolResultMessage<TDetails = unknown> {
	role: 'toolResult'; toolCallId: string; toolName: string;
	content: (TextContent | ImageContent)[]; details?: TDetails; usage?: Usage;
	addedToolNames?: string[]; isError: boolean; timestamp: number;
}
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[] }

export interface SimpleStreamOptions {
	signal?: AbortSignal; toolChoice?: unknown; reasoning?: unknown;
	deferred?: boolean | { window?: '15m' | '1h' | '24h' }; thinkingBudgets?: unknown;
	temperature?: number; maxTokens?: number; apiKey?: string; headers?: Record<string, string>;
	[k: string]: unknown;
}

export type AssistantMessageEvent =
	| { type: 'start'; partial: AssistantMessage }
	| { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
	| { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
	| { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
	| { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: 'done'; reason: Extract<StopReason, 'stop' | 'length' | 'toolUse' | 'deferred'>; message: AssistantMessage }
	| { type: 'error'; reason: Extract<StopReason, 'aborted' | 'error'>; error: AssistantMessage };

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
	push(event: AssistantMessageEvent): void;
	end(result?: AssistantMessage): void;
	result(): Promise<AssistantMessage>;
}

// ─────────────────────────── pi-agent 侧 ───────────────────────────

export interface AgentToolResult<T = unknown> {
	content: (TextContent | ImageContent)[]; details: T; usage?: Usage;
	/** 本批所有工具都 terminate=true 时，pi 会提前结束本轮 ⇒ 我方 plan_exit/plan_approval 的映射点。 */
	terminate?: boolean;
}
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;
export type ToolExecutionMode = 'sequential' | 'parallel';
export type AgentToolCall = ToolCall;

export interface AgentTool<TParameters extends Record<string, unknown> = Record<string, unknown>, TDetails = any> extends Tool<TParameters> {
	label: string;
	prepareArguments?: (args: unknown) => TParameters;
	/** pi 语义：**失败用 throw**（异常会被转成 error tool result 回喂模型），不要把错误编码进 content。 */
	execute: (toolCallId: string, params: TParameters, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>;
	replay?: 'never' | 'safe';
	executionMode?: ToolExecutionMode;
}

/** 自定义/UI-only 条目（pi 的 custom/branchSummary/bashExecution/… 的松散形态；不进 LLM 上下文）。 */
export interface AgentCustomMessage { role: string; timestamp?: number; [k: string]: unknown }
export type AgentMessage = Message | AgentCustomMessage;

export interface AgentContext {
	systemPrompt: string; messages: AgentMessage[]; tools?: AgentTool<any>[];
}

export type AgentEvent =
	| { type: 'agent_start' }
	| { type: 'agent_end'; messages: AgentMessage[] }
	| { type: 'turn_start' }
	| { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: 'message_start'; message: AgentMessage }
	| { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: 'message_end'; message: AgentMessage }
	| { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: any }
	| { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: any; isError: boolean };

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;
	/** 契约（pi 注释原话）：**must not throw or reject**；不能转换的条目丢弃而非抛错。 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
}

export type StreamFn = (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** agentLoop 返回的事件流（AsyncIterable + result()）。 */
export interface PiAgentEventStream extends AsyncIterable<AgentEvent> { result(): Promise<AgentMessage[]> }

export interface AgentLoopTurnUpdate { context?: AgentContext; messages?: AgentMessage[]; model?: Model; thinkingLevel?: unknown }
export interface PrepareNextTurnContext { [k: string]: unknown }

// ─────────────────────────── 我方类型 ───────────────────────────
export type { IChatStreamDelta, IModelDelta, IModelUsage, IToolCallInfo } from '../../common/providers.js';
