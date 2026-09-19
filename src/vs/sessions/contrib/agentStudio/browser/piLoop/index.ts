/*---------------------------------------------------------------------------------------------
 *  piLoop — pi agentloop 的本地复刻与适配
 *
 *  为什么存在（完整决策链）：
 *  1. 需求：agentloop 采用 pi 的方案，UI / memory / codebase 保持本仓实现。
 *  2. 首选方案是直接依赖 pi（submodule + 构建）。实测受阻：pi-agent-core 的
 *     dist/index.js 顶层静态 import `@earendil-works/pi-ai`，而 pi-ai 的构建链
 *     （scripts/generate-models.ts → models.dev）依赖网络拉取模型数据，在受控网络
 *     环境下无法构建（TS2307: kimi-coding.models.ts / data/kimi-coding.json）。
 *  3. 遂改为本地复刻：只复刻 agentloop 的**纯循环核心**（约 1300 行，含 400 行类型），
 *     从 22.8k 行的 pi harness 中只取 agent-loop 这一层 —— harness 的持久化/多会话/
 *     崩溃恢复语义本仓已有替代（agentRunState + session 层）。
 *
 *  对齐靶点：pi @ e98f287ee498e0116546f4e9aa083fdec9793cd2
 *            packages/agent/src/{types.ts, agent-loop.ts}
 *
 *  ⚠ 升级纪律：
 *  本目录是 pi 公开契约的**逐字段复刻**。字段名、字面量联合、可选性不得自行改动，
 *  否则 pi 生态的扩展无法直接对接。上游变更时按 commit 比对 `types.ts` 后同步。
 *
 *  模块职责：
 *    types.ts        pi 契约复刻（AgentMessage / AgentEvent / AgentLoopConfig / …）
 *    agentLoop.ts    主循环（runLoop + 工具派发 + 截断兜底）
 *    streamAdapter.ts 本仓 IModelProvider → pi StreamFn
 *    toolAdapter.ts   本仓 IToolDefinition → pi AgentTool
 *--------------------------------------------------------------------------------------------*/

export {
	runAgentLoop,
	runAgentLoopContinue,
	isFailureStopReason,
} from './agentLoop.js';

export {
	createPiStreamFn,
	convertToChatMessages,
} from './streamAdapter.js';
export type { PiStreamFnOptions } from './streamAdapter.js';

export {
	toAgentTool,
	toAgentTools,
	extractToolName,
} from './toolAdapter.js';
export type { ToolExecutor, ToolExecutionOutcome, ToAgentToolOptions } from './toolAdapter.js';

export type {
	// ── LLM 层（pi-ai 契约的本地声明）──
	LlmMessageRole,
	TextContent,
	ThinkingContent,
	ImageContent,
	ToolCallContent,
	AssistantContent,
	UserContent,
	Usage,
	StopReason,
	Message,
	ToolResultMessage,
	AssistantMessage,
	Model,
	TranscriptContext,
	// ── 流式事件 ──
	AssistantMessageEvent,
	AssistantMessageEventStream,
	SimpleStreamOptions,
	ThinkingLevel,
	StreamFn,
	// ── 工具 ──
	ToolExecutionMode,
	AgentToolResult,
	AgentToolUpdateCallback,
	AgentTool,
	AgentToolCall,
	// ── 消息 ──
	AgentMessageBase,
	StandardAgentMessage,
	CustomAgentMessage,
	AgentMessage,
	// ── 事件 ──
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolExecutionEndEvent,
	AgentEvent,
	AgentEventSink,
	// ── 队列与钩子 ──
	QueueMode,
	BeforeToolCallContext,
	BeforeToolCallResult,
	AfterToolCallContext,
	AfterToolCallResult,
	ShouldStopAfterTurnContext,
	PrepareNextTurnContext,
	AgentLoopTurnUpdate,
	// ── 上下文与配置 ──
	AgentContext,
	AgentState,
	AgentLoopConfig,
	// ── 内部结果类型 ──
	ToolCallPreparation,
	FinalizedToolCallOutcome,
	ExecutedToolCallBatch,
} from './types.js';
