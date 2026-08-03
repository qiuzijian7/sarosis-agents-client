/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import type { AgentGraph } from './agentGraph.js';
import type { AgentRunState, AgentRunStateSnapshot } from './agentRunState.js';
import type { IForkContext } from './forkContext.js';

// ─── Model Auth Status ───────────────────────────────────────────────────────────

export enum ModelAuthStatus {
	NotConfigured = 'not-configured',
	Validating = 'validating',
	Authenticated = 'authenticated',
	Failed = 'failed',
}

// ─── Model Info ──────────────────────────────────────────────────────────────────

export interface IModelInfo {
	readonly id: string;               // e.g. 'gpt-4o'
	readonly name: string;             // e.g. 'GPT-4o'
	readonly description?: string;
	readonly descriptionZh?: string;    // 中文描述
	readonly descriptionEn?: string;    // 英文描述
	readonly contextWindow?: number;    // 上下文窗口大小
	readonly maxInputTokens?: number;   // 最大输入 token 数
	readonly maxOutputTokens?: number;  // 最大输出 token 数
	readonly maxAllowedSize?: number;   // 最大上下文大小（input + output）
	readonly capabilities?: ModelCapability[];
	readonly supportsToolCall?: boolean; // 是否支持工具调用
	readonly supportsImages?: boolean;  // 是否支持图片
	readonly supportsReasoning?: boolean; // 是否支持推理/思考模式
	readonly onlyReasoning?: boolean;   // 是否仅推理模式
	readonly temperature?: number;      // 温度参数
	readonly vendor?: string;           // 供应商
	readonly credits?: string;          // Credits 信息
	readonly pricing?: IModelPricing;

	/**
	 * 声明式能力配置 — 参考 Void 的 VoidStaticModelInfo。
	 * 优先级高于上方布尔字段（supportsToolCall / supportsReasoning 等）。
	 * 新增模型时只需添加配置对象，无需修改代码逻辑。
	 */
	readonly capabilityConfig?: IModelCapabilityConfig;
}

// ─── Declarative Capability Config (Void-inspired) ──────────────────────────

/**
 * 声明式模型能力配置。
 *
 * 参考 Void 项目的 VoidStaticModelInfo，将模型的行为差异通过配置声明，
 * 而非在代码中 if/else 判断。新增模型时只需添加配置对象即可。
 *
 * 使用方式：
 * 1. 优先读取 capabilityConfig 中的声明式配置
 * 2. 若未配置，回退到 IModelInfo 上的布尔字段（supportsToolCall 等）
 * 3. 若仍无信息，通过 _inferCapabilities() 从模型 ID/描述推断
 */
export interface IModelCapabilityConfig {
	// ─── 系统消息处理 ──────────────────────────────────────────
	/**
	 * 系统消息如何处理。不同提供商 API 对系统消息的支持方式不同：
	 * - false:           不支持，将系统消息嵌入到用户消息中
	 * - 'system-role':   使用 role: 'system'（OpenAI 标准）
	 * - 'developer-role': 使用 role: 'developer'（OpenAI o-series）
	 * - 'separated':      作为单独参数传递（Anthropic system, Gemini systemInstruction）
	 */
	readonly supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated';

	// ─── 工具调用格式 ──────────────────────────────────────────
	/**
	 * 工具调用的格式。不同提供商 API 使用不同的工具调用编码：
	 * - undefined:       不支持原生工具调用，使用文本提取兜底（XML/JSON/ReAct 等）
	 * - 'openai-style':  OpenAI 格式 tool_calls[].function.{name, arguments}
	 * - 'anthropic-style': Anthropic 格式 content[].tool_use.{name, input}
	 * - 'gemini-style':  Gemini 格式 functionCall.{name, args}
	 */
	readonly specialToolFormat?: 'openai-style' | 'anthropic-style' | 'gemini-style';

	// ─── 推理/思考能力 ──────────────────────────────────────────
	/**
	 * 推理能力类型：
	 * - false:           不支持推理
	 * - 'budget-slider': 预算滑块（如 Anthropic extended thinking: budget_tokens）
	 * - 'effort-slider': 努力滑块（如 OpenAI o-series: reasoning_effort）
	 */
	readonly reasoningType?: 'budget-slider' | 'effort-slider' | false;

	// ─── 缓存支持 ──────────────────────────────────────────────
	/**
	 * 是否支持 KV Cache / Prompt Caching：
	 * - 'openai':   OpenAI cached_tokens（prompt_tokens_details.cached_tokens）
	 * - 'anthropic': Anthropic cache（cache_read_input_tokens / cache_creation_input_tokens）
	 * - false:       不支持
	 */
	readonly supportsCaching?: 'openai' | 'anthropic' | false;

	// ─── FIM 支持 ──────────────────────────────────────────────
	/** 是否支持 Fill-in-the-Middle（代码补全） */
	readonly supportsFIM?: boolean;

	// ─── 预留输出 Token ────────────────────────────────────────
	/** 为输出预留的 token 空间（某些模型需要从 contextWindow 中扣除） */
	readonly reservedOutputTokenSpace?: number | null;
}

export const enum ModelCapability {
	Chat = 'chat',
	Code = 'code',
	Vision = 'vision',
	FunctionCalling = 'function-calling',
}

export interface IModelPricing {
	readonly inputPerMillion?: number;   // USD per 1M input tokens
	readonly outputPerMillion?: number;  // USD per 1M output tokens
}

// ─── Model Selection ────────────────────────────────────────────────────────────

export interface IModelSelection {
	readonly providerId: string;     // e.g. 'knot-agui'
	readonly modelId: string;        // e.g. 'gpt-4o'
	readonly agentId?: string;       // e.g. 'agent-123' (可选，仅支持 Agent 的 Provider 使用)
}

// ─── Model Agent Info ──────────────────────────────────────────────────────────
// 表示 Provider 支持的一个 Agent（如 Knot 中的一个智能体）

export interface IModelAgentInfo {
	readonly id: string;               // e.g. 'agent-123'
	readonly name: string;             // e.g. 'My Agent'
	readonly description?: string;
	readonly icon?: string;            // URI string
	readonly models?: string[];        // 该 Agent 支持的模型 ID 列表
}

// ─── Model Provider Interface ───────────────────────────────────────────────────
// 特殊性：支持同时注册多个 Provider，每个 Provider 可提供多个模型
// 部分 Provider 还支持 Agent 选择（如 Knot）

export interface IModelProvider {
	readonly id: string;              // e.g. 'knot-agui', 'direct-openai'
	readonly name: string;            // 显示名，e.g. 'Knot AG-UI'
	readonly icon?: URI;
	readonly priority: number;        // 默认优先级（决定默认选中）
	readonly settingsSearchQuery?: string; // 打开设置时使用的搜索关键字（可选）

	// 模型列表（可动态刷新）
	readonly onDidChangeModels: Event<void>;
	listModels(): Promise<IModelInfo[]>;

	// 认证状态
	readonly onDidChangeAuthStatus: Event<ModelAuthStatus>;
	getAuthStatus(): ModelAuthStatus;

	// ─── Agent 支持（可选）────────────────────────────────────
	// 如果 Provider 支持 Agent 选择，设置 supportsAgents = true
	// 并在 listAgents() 中返回可用 Agent 列表

	readonly supportsAgents?: boolean;         // 是否支持 Agent 选择
	readonly onDidChangeAgents?: Event<void>; // Agent 列表变化事件
	listAgents?(): Promise<IModelAgentInfo[]>; // 获取 Agent 列表

	// ─── Server-side agent loop ────────────────────────────────
	// 当 provider 内部封装了完整的 agent 循环（如 Knot AG-UI 在同一次
	// chat() 流中完成 tool call → execution → response），设为 true。
	// 此时 AgentOS 不会在本地执行工具调用，而是让 provider 自行管理循环。
	// CodeBuddy API 等仅返回 tool call 的 provider 应设为 false。
	readonly isServerSideProvider?: boolean;

	// 推理调用（指定模型，可选指定 Agent）
	chat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncIterable<IModelDelta>;
}

// ─── Chat Context ──────────────────────────────────────────────────────
// 传递给 chat() 的额外上下文（如选中的 Agent）

export interface IChatContext {
	readonly agentId?: string;       // 选中的 Agent ID
	readonly sessionId?: string;     // 会话 ID
	// ─── 抓包对齐的三个独立 id（CodeBuddy IDE /v2/chat/completions 协议）──────
	// 抓包证据：HTTP header 携带三个粒度不同、绝不可混用的 id：
	//   X-Conversation-ID    会话级，整段稳定不变  ← conversationId
	//   X-Conversation-Request-ID  请求级，每次 API 调用都换  ← requestId
	//   X-Conversation-Message-ID  消息级，每条消息不同（暂由 provider 自生成）
	// 历史 bug：仅用单一 sessionId 当所有 id → 服务端 KV 缓存按 conversation-id
	// 跨会话碰撞 → 命中旧上下文、忽略本地 priorMessages → 第三轮串台。
	/** 会话级稳定 id（→ X-Conversation-ID），同一会话内不变 */
	readonly conversationId?: string;
	/** 请求级 id（→ X-Conversation-Request-ID），每轮 API 调用都重新生成 */
	readonly requestId?: string;
	/** 上一次响应流 chunk 的 id（→ 请求体 previous_response_id），用于服务端链式上下文衔接 */
	readonly previousResponseId?: string;
	[key: string]: unknown;
}

// ─── Chat Attachment Types (Void-inspired image/file upload) ──────────────

/**
 * 图片 MIME 类型 — 与各 LLM API 支持的图片格式对齐。
 */
export type ChatImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp';

/**
 * 用户上传的附件（图片或文件）。
 *
 * 参考 Void 的 IChatRequestVariableEntry / IImageVariableEntry，但简化为
 * WebView→Host 传输所需的扁平结构：
 * - 图片附件：`type='image'`，`data` 为 base64 编码，`mimeType` 必填
 * - 文件附件：`type='file'`，`data` 为文件内容（文本为原文，二进制为 base64），`mimeType` 可选
 */
export interface IChatAttachment {
	/** 附件唯一标识（用于前端删除/去重） */
	readonly id: string;
	/** 附件类型：图片 or 文件 */
	readonly type: 'image' | 'file';
	/** 原始文件名 */
	readonly name: string;
	/** MIME 类型 */
	readonly mimeType: string;
	/** 文件/图片内容（图片为 base64，文本文件为原文，二进制文件为 base64） */
	readonly data: string;
	/** 文件大小（字节，用于前端限制提示） */
	readonly size: number;
	/** 图片附件：是否从剪贴板粘贴 */
	readonly isPasted?: boolean;
}

/**
 * LLM 消息中的多模态内容块 — 替代纯 `content: string`，
 * 使 IChatMessage 支持 text + image 混合内容。
 *
 * 参考 Void 的 IChatMessagePart / IChatMessageImagePart。
 * 各 Provider 实现（OpenAI / Anthropic / Gemini）将此映射到各自 API 格式。
 */
export type IChatContentPart = IChatTextPart | IChatImagePart;

export interface IChatTextPart {
	readonly type: 'text';
	readonly text: string;
}

export interface IChatImagePart {
	readonly type: 'image';
	/** base64 编码的图片数据（不含 data: 前缀） */
	readonly data: string;
	/** 图片 MIME 类型 */
	readonly mimeType: ChatImageMimeType;
}

export interface IChatMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	/** 纯文本内容（向后兼容，新代码优先使用 contentParts） */
	readonly content: string;
	/**
	 * ReAct 推理内容（可选）。当模型输出 native thinking（如 qwen 的思考链路、
	 * Claude 的 extended thinking）时，此字段保存推理文本。后续迭代中会合并到
	 * assistant 消息的 content 中发回模型，实现完整 ReAct（模型能"看见"自己
	 * 上一轮的思考过程）。
	 */
	readonly reasoning?: string;
	/**
	 * 多模态内容块（可选）。当存在时，Provider 实现应优先使用 contentParts
	 * 而非 content，以支持图片/文件等非文本内容。
	 */
	readonly contentParts?: IChatContentPart[];
	readonly toolCalls?: IToolCallInfo[];
	readonly toolCallId?: string;
}

export interface IToolCallInfo {
	readonly id: string;
	readonly name: string;
	readonly arguments: string; // JSON string
	/** UI 显示名称（来自模型的 display_name 字段） */
	readonly displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeEditor 等） */
	readonly renderType?: string;
	/** 是否默认展开显示工具卡（默认 true） */
	readonly defaultShow?: boolean;
	/** 工具已在服务端执行（如 Knot AG-UI），客户端不需要再执行 */
	readonly serverExecuted?: boolean;
}

export interface IModelOptions {
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly systemPrompt?: string;
	readonly tools?: IToolDefinition[];
	readonly stop?: string[];
	/**
	 * 工具选择策略（对齐 OpenAI tool_choice 语义）。
	 *   - 'auto'（默认）：模型自行决定是否调用工具
	 *   - 'required'：强制本轮必须调用至少一个工具（用于续跑兜底，逼模型
	 *      停止"宣告意图却不动手"的空转行为）
	 *   - 'none'：禁止调用工具
	 * 未设置时 provider 应回退到 'auto'。
	 */
	readonly toolChoice?: 'auto' | 'required' | 'none';
	/**
	 * 推理/思考（thinking / reasoning）配置。各 provider 按自身能力映射到原生 API 参数：
	 *   - Anthropic Claude：thinking: { type: 'enabled', budget_tokens: budget }
	 *   - Gemini：config.thinkingConfig = { thinkingBudget: budget }
	 *   - OpenAI o 系列 / xAI：reasoning_effort: effort
	 *   - DeepSeek / OpenRouter：reasoning_effort 或开启 reasoning
	 * 当 enabled 为 false 或字段缺失时，provider 不应注入任何 thinking 参数。
	 */
	readonly reasoning?: IReasoningOptions;
	/**
	 * 抓包对齐的会话/请求 id（由 agentOS 经 IChatContext 下传，bridge 转写入此处
	 * 再透传给 provider 扩展，最终映射为 HTTP header / 请求体字段）：
	 *   sessionId          → X-Conversation-Id（保留兼容，等同 conversationId）
	 *   conversationId     → X-Conversation-ID（会话级稳定）
	 *   requestId          → X-Conversation-Request-ID（请求级，每轮新）
	 *   previousResponseId → 请求体 previous_response_id（上轮响应 id）
	 */
	readonly sessionId?: string;
	readonly conversationId?: string;
	readonly requestId?: string;
	readonly previousResponseId?: string;
	/**
	 * 透传给请求构造端（MessageFormatConverter）的父级 ForkContext。
	 * 当本请求的 (systemPrompt, tools) 与父级冻结前缀对齐时，构造端在该前缀边界
	 * 注入 `cache_control` 断点以命中 provider 的 prompt cache（MiMo ForkContext）。
	 * 省略 → undefined（零行为变更）。
	 */
	readonly forkContext?: IForkContext;
}

/**
 * 推理/思考配置。budget 与 effort 二选一（取决于模型能力 reasoningType）。
 */
export interface IReasoningOptions {
	/** 是否开启思考模式 */
	readonly enabled: boolean;
	/** 思考预算（token 数），用于 budget-slider 类模型（Claude / Gemini） */
	readonly budget?: number;
	/** 思考工作量等级，用于 effort-slider 类模型（OpenAI o 系列 / xAI） */
	readonly effort?: 'low' | 'medium' | 'high';
}

export interface IModelDelta {
	// tool_progress（2026-07-26）：工具参数流式生成期间的轻量进度信号
	// （provider 节流上报），content 携带阶段描述。不进入正文/工具装配，
	// 仅用于 idle 计时器续命与 UI 进度提示。
	readonly type: 'text' | 'thinking' | 'tool_call' | 'done' | 'error' | 'usage' | 'tool_progress';
	readonly content?: string;
	readonly toolCall?: IToolCallInfo;
	readonly error?: string;
	/** Token 使用量（type === 'usage' 时携带） */
	readonly usage?: IModelUsage;
	/**
	 * 模型本轮结束原因（OpenAI `finish_reason` / Anthropic `stop_reason` 等）。
	 * 仅 type === 'done' 时携带。用于 agent loop 判定"未完成轮"（对齐 OpenClaw
	 * incomplete-turn 结构判定，而非文本意图识别）：
	 *   - 'length' / 'max_tokens' → 输出被 token 上限截断，视为未完成、触发安全续跑
	 *   - 'tool_calls' / 'tool_use' → 模型本要调工具（已有工具调用路径处理，一般不在此分支）
	 *   - 'stop' / 'end_turn' / 'content_filter' → 正常结束
	 */
	readonly finishReason?: string;
	/**
	 * 本次响应流的 id（来自 SSE chunk 的 `id` 字段）。
	 * 抓包证据：响应流每个 chunk 的 id 相同，且 = 下一次请求体的 previous_response_id。
	 * provider 解析到 chunk.id 时通过任意 delta（通常 'done'）回传，
	 * agentOS 据此更新会话的 previousResponseId，实现服务端链式上下文衔接。
	 */
	readonly responseId?: string;
}

/**
 * LLM 调用的 Token 使用量统计
 */
export interface IModelUsage {
	/** 输入 token 数 */
	readonly inputTokens?: number;
	/** 输出 token 数 */
	readonly outputTokens?: number;
	/** 缓存命中的输入 token 数（来自 OpenAI cached_tokens / Anthropic cache_read_input_tokens） */
	readonly cachedTokens?: number;
	/** 写入缓存的 token 数（来自 Anthropic cache_creation_input_tokens） */
	readonly cacheWriteTokens?: number;
	/** 总 token 数（部分网关在末块 usage 直接给出 total_tokens；缺省时可由 input+output 推导） */
	readonly totalTokens?: number;
	/** 本次调用消耗的计费额度 / 积分（来自 CodeBuddy 网关末块 usage.credit 等字段） */
	readonly credit?: number;
}

// ─── Memory Provider Interface ────────────────────────────────────────────────

/**
 * 固定槽位名（顺序即展示顺序）。对齐 extensions/agentmemory-memory/src/amSlots.ts 的
 * DEFAULT_SLOTS。记忆槽位是「固定 8 槽位模型」——无论网关是否返回数据，编辑器都应
 * 展示这 8 个固定槽位（内容为空则显示「(空)」），避免误导性的「暂无固定槽位」空态。
 */
export const FIXED_SLOT_NAMES: readonly string[] = [
	'persona',
	'user_preferences',
	'tool_guidelines',
	'project_context',
	'guidance',
	'pending_items',
	'session_patterns',
	'self_notes',
];

export interface IMemoryProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * 加载会话的记忆上下文。
	 *
	 * `query` 参数（可选）：当前轮次的用户输入文本，用于驱动 vendor 的语义/关键词
	 * 召回。若不传，provider 实现可走"全量摘要"或返回空，但召回质量会大幅下降。
	 *
	 * `options.scope` (2026-06 新增) —— 控制召回的作用域：
	 *   - 'agent'     → 仅本 Agent 自己写入的记忆（默认，严格隔离）
	 *   - 'global'    → 全库（跨 agent 共享）
	 * 不传时 provider 实现按"agent"兜底，保持向后兼容；老的 provider
	 * 实现可以忽略此参数（接口已声明为可选）。
	 */
	loadContext(
		agentId: string,
		sessionId: string,
		query?: string,
		options?: IMemoryRecallOptions,
	): Promise<IMemoryContext>;
	writeMemory(agentId: string, entry: IMemoryEntry): Promise<void>;
	searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]>;

	// ─── Extended Lifecycle Methods (optional, AgentMemoryProvider implements) ──

	/** Pre-compact injection: called before context compression to inject relevant memories */
	onPreCompact?(agentId: string, sessionId: string, messages: Array<{ role: string; content: string; timestamp: number }>, tokenBudget: number): { injectedContext: string; totalTokens: number };

	/** Called when a task is completed */
	onTaskCompleted?(agentId: string, sessionId: string, taskSubject: string, taskId?: string): void;

	/** Called when a git commit is made */
	onGitCommit?(commit: { sha: string; message: string; author: string; filesChanged: string[]; insertions: number; deletions: number; timestamp: number; branch?: string }): unknown;

	/** Called when a subagent starts */
	onSubagentStart?(parentAgentId: string, task: string): unknown;

	/** Called when a subagent stops */
	onSubagentStop?(agentId: string, status: 'completed' | 'failed' | 'cancelled', result?: string, error?: string): boolean;

	/** Get extended stats (for memory detail pane) */
	getExtendedStats?(agentId: string): Record<string, unknown>;

	/** Run extended diagnostics */
	runExtendedDiagnostics?(agentId: string): Record<string, unknown>;

	/** 文件相关 bug 记忆（mem::enrich 复刻）：type=bug ∩ isLatest ∩ files 路径重叠，updatedAt 倒序 top3 */
	bugMemoriesForFiles?(agentId: string, files: string[], project?: string): Promise<Array<{ id: string; title: string; content: string }>>;

	/** Flush pending writes */
	flush?(): Promise<void>;

	// ─── Session Observation（mem:obs 会话暂存层，对齐 agentmemory mem::observe）───
	/**
	 * 写入一条会话观察（工具结果 / turn 消息等暂存事件）。
	 * 与 writeMemory 的区别：写入 mem:obs:<agent>:<session> 会话暂存层——
	 * 便宜 KV set + 滑动窗口上限 + 阈值自动触发会话压缩，**不走**长期记忆的
	 * 去重/巩固管线。经 compressSession 压缩后才可能进入长期层。
	 */
	observe?(agentId: string, payload: { sessionId: string; hookType: string; timestamp: string; data?: unknown }): Promise<{ success: boolean; observationId?: string; error?: string } | unknown>;

	// ─── Hook System (for agentOSService lifecycle integration) ────────────
	/**
	 * Trigger a lifecycle hook. Called by agentOSService at key lifecycle points:
	 * session_start, prompt_submit, pre_tool_use, post_tool_use, post_tool_failure,
	 * pre_compact, stop, session_end, task_completed.
	 */
	triggerHook?(type: string, ctx: Record<string, unknown>): Promise<void>;

	/** Get hook system statistics (for memory detail panel).
	 *  Renderer 代理(Opt1)返回 Promise（数据在网关进程），V2 网关实现返回同步对象。
	 *  调用方（memoryDetailEditorPane）统一 `await`。 */
	getHookStats?(): { totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> } | Promise<{ totalHooks: number; hooksByType: Record<string, number>; callCounts: Record<string, number> }>;

	// ─── Extended Memory APIs (for memory detail panel) ────────────────────

	/** Get basic memory stats */
	getStats?(agentId: string): Record<string, unknown>;

	/** Get project profile */
	getProfile?(agentId: string): Record<string, unknown> | null;

	/** Get timeline of memory events */
	getTimeline?(agentId: string): Array<Record<string, unknown>>;

	/** Get all pinned slots */
	getSlots?(agentId: string): Array<{ name: string; content: string }>;

	/**
	 * 固定槽位名（顺序即展示顺序）。对齐 extensions/agentmemory-memory/src/amSlots.ts 的
	 * DEFAULT_SLOTS。记忆槽位是「固定 8 槽位模型」——无论网关是否返回数据，
	 * 编辑器都应展示这 8 个固定槽位（内容为空则显示「(空)」），故以此为渲染底表。
	 */
	FIXED_SLOT_NAMES?: readonly string[];

	/** Set a pinned slot's content */
	setSlot?(agentId: string, label: string, content: string): void;

	/** Get all lessons */
	getLessons?(agentId: string): Array<{ id: string; content: string; context?: string; tags?: string[] }>;

	/** Add a manual lesson */
	addLesson?(agentId: string, content: string, context?: string, tags?: string[]): Record<string, unknown>;

	/** Delete a lesson */
	deleteLesson?(agentId: string, lessonId: string): void;

	/** Get episodic memories (consolidated) */
	getEpisodicMemories?(agentId: string): Array<Record<string, unknown>>;

	/** Get semantic memories (consolidated) */
	getSemanticMemories?(agentId: string): Array<Record<string, unknown>>;

	/** Get procedural memories (consolidated) */
	getProceduralMemories?(agentId: string): Array<Record<string, unknown>>;

	/** Get consolidation context as text */
	getConsolidationContext?(agentId: string): string;

	/** Get relations for a memory */
	getRelations?(agentId: string, memoryId: string): Array<Record<string, unknown>>;

	/** Get relation statistics */
	getRelationStats?(agentId: string): Record<string, number>;

	/** Trace provenance chain for a memory */
	traceProvenance?(agentId: string, memoryId: string): Record<string, unknown> | null;

	/** Get audit log */
	getAuditLog?(filter?: { operation?: string; agentId?: string; limit?: number }): Array<Record<string, unknown>>;

	/** Get audit summary */
	getAuditSummary?(): Record<string, number>;

	// ─── Report & Git APIs (for memory detail panel) ──────────────────────

	/** Generate a system report */
	generateReport?(type: string, agentId: string): Promise<Record<string, unknown>>;

	/** Get recent git commits captured into memory */
	getRecentCommits?(limit?: number): Array<Record<string, unknown>>;

	/** Get git commit statistics */
	getCommitStats?(): Record<string, unknown>;

	// ─── Skill Extract APIs (for memory detail panel) ─────────────────────

	/** Get skill statistics.
	 *  Renderer 代理(Opt1)返回 Promise（数据在网关进程），V2 网关实现亦返回 Promise。
	 *  首参 agentId 对齐 host.mjs 的 /provider 路由约定（首参即 agentId）。 */
	getSkillStats?(agentId?: string): { totalSkills: number; avgConfidence: number; avgSteps: number; totalUsage: number; writtenCount: number } | Promise<{ totalSkills: number; avgConfidence: number; avgSteps: number; totalUsage: number; writtenCount: number }>;

	/** List all extracted skills. agentId 为首参；filter 可选。 */
	listSkills?(agentId?: string, filter?: { tags?: string[]; minConfidence?: number }): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;

	/** Write a skill's SKILL.md file to ~/.vssaros/skills/<slug>/SKILL.md */
	writeSkillFile?(agentId: string, skillId: string): Promise<{ ok: boolean; path?: string; error?: string }>;

	/** Delete a skill's SKILL.md file */
	deleteSkillFile?(agentId: string, skillId: string): Promise<{ ok: boolean; deleted?: boolean; error?: string }>;

	/** Write SKILL.md for all pending skills */
	writeAllSkillFiles?(agentId: string): Promise<{ written: number; failed: number; errors: string[] }>;

	/** Add a manual skill (pane _addSkill) */
	addSkill?(agentId: string, data: { title: string; trigger: string; steps: string[]; expectedOutcome?: string; tags?: string[] }): Promise<Record<string, unknown> | null>;

	/** Update a skill (edit mode) */
	updateSkill?(agentId: string, id: string, updates: Record<string, unknown>): Record<string, unknown> | null;

	/** Delete a skill */
	deleteSkill?(agentId: string, id: string): boolean;

	/** Update a long-term memory entry (edit mode，updates 支持 title/content/type/concepts/files/strength) */
	updateMemory?(agentId: string, id: string, updates: Record<string, unknown>): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;

	/** Delete a long-term memory entry (硬删除，含索引清理) */
	deleteMemory?(agentId: string, id: string): boolean | Promise<boolean>;

	// ─── Cross-Agent APIs (for memory detail panel) ────────────────────────

	/** List all agent IDs that have memory data */
	listAllAgentsWithData?(): Promise<string[]>;

	/** Search memories across ALL agents */
	searchAllAgents?(query: string): Promise<Array<Record<string, unknown>>>;

	// ─── Memory Lifecycle Events (for accurate UI feedback) ──────────────────
	// 替代旧的 fire-and-forget + 假"已保存" UI 反馈模式。
	// Provider 在 writeMemory 成功/失败时通过这些回调通知调用方，
	// 调用方据此更新聊天系统栏记忆卡片状态 (pending → saved/failed)。

	/**
	 * 订阅记忆写入成功事件。
	 * @param handler 回调，接收 agentId、memoryId 和可选的 noticeId（来自 entry.metadata.noticeId）
	 * @returns 取消订阅函数
	 */
	onMemoryWritten?(handler: (agentId: string, data: { memoryId: string; noticeId?: string; memoryType?: string; contentLength?: number }) => void): () => void;

	/**
	 * 订阅记忆写入失败事件。
	 * @param handler 回调，接收 agentId、错误信息和可选的 noticeId
	 * @returns 取消订阅函数
	 */
	onMemoryWriteFailed?(handler: (agentId: string, data: { noticeId?: string; error: string; memoryType?: string }) => void): () => void;
}

/**
 * 记忆召回的可选作用域参数（2026-06 新增）。详见 IMemoryProvider.loadContext 注释。
 */
export interface IMemoryRecallOptions {
	scope?: 'agent' | 'global';
	/**
	 * 是否消费长/短期记忆条目数组（shortTermMemories/longTermMemories）。
	 * 注入主路径（agentMemoryInjection）默认关闭以省全表扫描；
	 * executionProvider 循环内显式开启（其 Long-term/Short-term 块依赖条目）。
	 */
	includeEntries?: boolean;
}

export interface IMemoryContext {
	readonly shortTermMemories: IMemoryEntry[];
	readonly longTermMemories: IMemoryEntry[];
	readonly systemPrompt?: string;
	readonly relevantDocuments?: IDocumentRef[];
	/** 注入策展块数量（对齐 agentmemory mem::context 返回的 blocks 元数据） */
	readonly contextBlocks?: number;
	/** 注入实际占用 token 数（含 header/footer） */
	readonly contextTokens?: number;
}

export interface IMemoryEntry {
	readonly id: string;
	/** agentmemory 原生类型（working/episodic/semantic/procedural + pattern/preference/architecture/bug/workflow/fact）。
	 *  引擎写入侧按类型路由：working→core、semantic/procedural→独立 scope、其余→KV.memories。 */
	readonly type: string;
	readonly content: string;
	readonly metadata?: Record<string, unknown>;
	readonly timestamp?: number;
	readonly importance?: number; // 0-10，重要性评分
	readonly score?: number; // for search results
}

export interface IDocumentRef {
	readonly uri: URI;
	readonly snippet: string;
	readonly score: number;
}

// ─── Tool Security Level (OpenClaw-inspired) ─────────────────────────────────

/**
 * 工具安全等级 — 决定执行前是否需要用户审批。
 * 参考 OpenClaw 的 before_tool_call hook + exec.approval 两阶段审批。
 */
export const enum ToolSecurityLevel {
	/** 安全工具：读取类操作，无需确认 */
	Safe = 'safe',
	/** 谨慎工具：可能有轻微副作用，首次使用时提示 */
	Cautious = 'cautious',
	/** 危险工具：文件写入、命令执行等破坏性操作，每次确认 */
	Dangerous = 'dangerous',
}

// ─── Tool Availability (OpenClaw-inspired) ───────────────────────────────────

/**
 * 声明式可用性条件 — 参考 OpenClaw 的 ToolAvailabilityExpression。
 * 允许工具声明自己在何种条件下可用，运行时自动评估。
 */
export interface IToolAvailability {
	/** 条件类型 */
	readonly type: 'always' | 'config' | 'env' | 'platform' | 'custom';
	/**
	 * 条件值：
	 * - config: 配置项键名（非空即满足）
	 * - env: 环境变量名（非空即满足）
	 * - platform: 'desktop' | 'web' | 'node'
	 * - custom: 自定义条件标识符（由 provider 实现评估）
	 */
	readonly condition?: string;
	/** 是否取反（例如 "非 web 环境" = { type: 'platform', condition: 'web', negate: true }） */
	readonly negate?: boolean;
}

// ─── Tool Approval (OpenClaw-inspired) ──────────────────────────────────────

/**
 * 工具审批请求 — 发送给 UI 层，等待用户决策。
 */
export interface IToolApprovalRequest {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly arguments: Record<string, unknown>;
	readonly securityLevel: ToolSecurityLevel;
	readonly reason?: string; // 说明为什么需要审批
}

/**
 * 工具审批决策
 */
export const enum ToolApprovalDecision {
	/** 允许本次执行 */
	AllowOnce = 'allow-once',
	/** 允许本次执行，且后续同名工具不再询问（本次会话内） */
	AllowAlways = 'allow-always',
	/** 拒绝执行 */
	Deny = 'deny',
}

/**
 * 工具审批回调接口 — AgentOS 注册到 UI 层
 */
export interface IToolApprovalHandler {
	/**
	 * 请求用户审批。
	 * @returns 用户的审批决策
	 */
	requestApproval(request: IToolApprovalRequest): Promise<ToolApprovalDecision>;
}

// ─── Tool Sandbox Confirmation (安全沙箱受限→询问用户) ───────────────────────────

/**
 * 工具因安全沙箱限制而执行失败时的结构化违规信息。
 * 由 builtinToolProvider 在路径校验失败时附带到 IToolResult.metadata，
 * 供 agentOSService 检测并向用户弹出确认卡片（对齐 void 的 confirmed.promise 模式）。
 */
export interface ISandboxViolationInfo {
	/** 工具请求的原始路径（未解析） */
	readonly requestedPath: string;
	/** 解析后的绝对路径 */
	readonly resolvedPath: string;
	/** 当前允许的工作区根目录列表 */
	readonly allowedRoots: string[];
	/** 建议的替代路径（落在某个允许根内）；无可行建议时为 undefined */
	readonly suggestedPath: string | undefined;
	/** 是否处于 worktree 独占沙箱模式 */
	readonly isWorktree: boolean;
}

/**
 * 用户对沙箱受限工具调用的决策。
 */
export const enum SandboxConfirmationDecision {
	/** 仅本次临时放行该精确路径（不持久化） */
	AllowOnce = 'allow_once',
	/** 把该路径所在目录加入当前工作区沙箱允许根（持久化） */
	AllowWorkspace = 'allow_workspace',
	/** 改用建议路径（落在允许根内）重试 */
	UseSuggested = 'use_suggested',
	/** 取消操作，工具以失败结束 */
	Cancel = 'cancel',
}

/**
 * 沙箱确认请求 — 发送给 UI 层，等待用户决策。
 */
export interface ISandboxConfirmationRequest {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly requestedPath: string;
	readonly resolvedPath: string;
	readonly allowedRoots: string[];
	readonly suggestedPath: string | undefined;
	readonly isWorktree: boolean;
}

/**
 * 沙箱确认回调接口 — AgentOS 注册到 UI 层（原生 chat 由 AgentOSService 自身接管）。
 */
export interface ISandboxConfirmationHandler {
	/**
	 * 请求用户对沙箱受限工具调用做出决策。
	 * @returns 用户的决策
	 */
	requestDecision(request: ISandboxConfirmationRequest): Promise<SandboxConfirmationDecision>;
}

// ─── Tool Provider Interface ──────────────────────────────────────────────────

export interface IToolProvider {
	readonly id: string;
	readonly name: string;

	listTools(agentId: string): Promise<IToolDefinition[]>;
	executeTool(agentId: string, toolCall: IToolCall, signal?: AbortSignal): Promise<IToolResult>;

	/**
	 * 启用一个工具
	 * @param _agentId Agent ID（保留供未来按 Agent 配置）
	 * @param toolName 工具名称
	 */
	enableTool(_agentId: string, toolName: string): Promise<void>;

	/**
	 * 禁用一个工具
	 * @param _agentId Agent ID（保留供未来按 Agent 配置）
	 * @param toolName 工具名称
	 */
	disableTool(_agentId: string, toolName: string): Promise<void>;

	/**
	 * 检查工具是否已启用
	 * @param _agentId Agent ID（保留供未来按 Agent 配置）
	 * @param toolName 工具名称
	 * @returns 是否已启用
	 */
	isToolEnabled(_agentId: string, toolName: string): Promise<boolean>;

	/**
	 * 临时放行某个精确路径（仅本次工具调用生效，不持久化）。
	 * 用于沙箱确认「允许本次」：agentOSService 在重试前调用，重试后调用
	 * removeSandboxBypassRoot 移除，避免泄露到后续 turn。
	 */
	addSandboxBypassRoot?(path: string): void;

	/**
	 * 移除临时放行的精确路径（见 addSandboxBypassRoot）。
	 */
	removeSandboxBypassRoot?(path: string): void;

	/**
	 * 清空所有临时放行的路径。
	 */
	clearSandboxBypassRoots?(): void;

	/**
	 * 获取所有工具的启用状态 Map
	 * @param _agentId Agent ID（保留供未来按 Agent 配置）
	 * @returns 工具名称 -> 是否启用的 Map
	 */
	getToolsEnabledState(_agentId: string): Promise<Record<string, boolean>>;

	/**
	 * 批量设置工具的启用状态
	 * @param _agentId Agent ID（保留供未来按 Agent 配置）
	 * @param state 工具名称 -> 是否启用的 Map
	 */
	setToolsEnabledState(_agentId: string, state: Record<string, boolean>): Promise<void>;

	/**
	 * Per-turn 状态重置。在每个 agent turn 开始时调用，
	 * 清空跨 turn 不应保留的累积状态（如读取去重/重复计数等）。
	 * 可选：不实现则不清空。
	 */
	resetPerTurn?(): void;
}

export interface IToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>; // JSON Schema
	readonly category?: string;  // e.g. 'filesystem', 'browser', 'search'
	readonly source?: string;      // provider id
	/** 工具列表中的简短摘要（参考 OpenClaw displaySummary） */
	readonly displaySummary?: string;
	/** 回放安全标记 — 标记工具在不完整回合恢复时可安全重放（参考 OpenClaw tool-replay-safety） */
	readonly replaySafe?: boolean;
	/** 安全等级 — 决定是否需要用户审批（默认 safe） */
	readonly securityLevel?: ToolSecurityLevel;
	/** 声明式可用性条件列表（所有条件需同时满足） */
	readonly availability?: IToolAvailability[];
	/**
	 * 所属工具集 — 用于 toolset 驱动的工具过滤。
	 * 值由 toolsetConfig.ts 的 TOOLSET_DEFINITIONS 定义。
	 * 如果未设置，getAllToolDefinitions() 会自动推断。
	 */
	readonly toolset?: string;
}

export interface IToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
	/**
	 * 当前工具调用所属的 worktree 路径（看板 / 任务级隔离透传）。
	 *
	 * 来源：AgentOS.executeTurn(request.worktreePath) → _executeToolCalls →
	 * 桥接工具（tool_call）→ executeWithRetryAndTimeout → provider.executeTool。
	 *
	 * 用途：
	 *  - Builtin 工具当前通过 `setParentWorktreePath` 机制读取（delegate_task 子 agent 继承）。
	 *  - MCP 桥接工具（McpToolProvider）在 D2 后从 IToolCall.worktreePath 注入
	 *    IMcpTool.call 的 context，使 server 能感知当前工作根（见 worktreeIsolation.mcp.test.ts）。
	 * 可选：未指定时工具按 provider 默认工作区执行。
	 */
	readonly worktreePath?: string;
}

export interface IToolResult {
	readonly toolCallId: string;
	readonly success: boolean;
	readonly content: IToolResultContent[];
	readonly error?: string;
	/** 结构化执行元数据 — 参考 OpenClaw 的 AgentToolResult.details */
	readonly metadata?: IToolResultMetadata;
	/** 工具特定结构化数据，供 UI 渲染（如 update_plan 的计划步骤） */
	readonly details?: Record<string, unknown>;
}

/**
 * 工具执行结果的结构化元数据
 */
export interface IToolResultMetadata {
	/** 执行耗时（毫秒） */
	readonly executionTimeMs?: number;
	/** 结果是否被截断 */
	readonly truncated?: boolean;
	/** 结构化内容（可选，供下游精确使用） */
	readonly structuredContent?: unknown;
	/** MCP 来源服务器名 */
	readonly mcpServer?: string;
	/** 是否可重试 */
	readonly retryable?: boolean;
	/** 是否因超时而终止 */
	readonly timedOut?: boolean;
	/** 安全沙箱违规信息（路径不在允许的工作区目录内） */
	readonly sandboxViolation?: ISandboxViolationInfo;
}

export interface IToolResultContent {
	readonly type: 'text' | 'image' | 'resource';
	readonly text?: string;
	readonly data?: string; // base64 or URI
	readonly mimeType?: string;
}

/**
 * 工具永久性错误：重试不可能改变结果（如 HTTP 404/403、参数非法）。
 *
 * toolExecutor 捕获后把 `metadata.retryable` 置为 false，executeWithRetryAndTimeout
 * 的 runWithRetry 因而不会重试（避免对确定性失败白费 3 次尝试 + 三倍日志噪音）。
 * 与 SandboxViolationError 的 isSandboxViolation 标记同一模式。
 */
export class NonRetryableToolError extends Error {
	readonly isNonRetryableToolError = true;
}

// ─── Planning Provider Interface ──────────────────────────────────────────────

export interface IPlanningProvider {
	readonly id: string;
	readonly name: string;

	analyzeIntent(message: string, context: IMemoryContext): Promise<IPlan>;
	decomposeTasks(plan: IPlan): Promise<ITask[]>;
}

export interface IPlan {
	readonly id: string;
	readonly intent: string;
	readonly steps: IPlanStep[];
	readonly estimatedComplexity?: 'low' | 'medium' | 'high';
}

export interface IPlanStep {
	readonly id: string;
	readonly description: string;
	readonly toolRequirements?: string[];
}

export interface ITask {
	readonly id: string;
	readonly description: string;
	readonly dependencies?: string[]; // task IDs
	readonly status: 'pending' | 'running' | 'done' | 'error';
}

// ─── Execution Provider Interface ──────────────────────────────────────────────

export interface IExecutionProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * Agent 循环：Plan → Act → Observe → Reflect
	 * 接收 OS 的 SlotRegistry，使其能在循环内回调 OS 的各能力槽
	 */
	runAgentLoop(
		request: IAgentTurnRequest,
		slots: ISlotRegistry,
	): AsyncIterable<IChatStreamDelta>;
}

export interface IAgentTurnRequest {
	readonly agentId: string;
	readonly sessionId?: string;
	readonly messages: IChatMessage[];
	/**
	 * 冻结前缀（stable + context 层），作为第一条 system 消息发送。保持字节稳定
	 * 是 provider prompt cache 命中的前提；fork 前缀指纹也基于本字段计算。
	 */
	readonly systemPrompt?: string;
	/**
	 * 易变层（volatile：Persona Memory + 本轮激活技能）。每轮可变，作为独立
	 * system 消息追加在冻结前缀之后，不参与前缀指纹，其变化不打断前缀缓存。
	 * 由 agentDriverService 分层组装产生；直发 / 子 agent 路径省略 → undefined。
	 */
	readonly systemPromptVolatile?: string;
	readonly options?: IModelOptions;
	/** 用户通过 /skill 命令显式激活的技能 ID 列表 */
	readonly explicitSkillIds?: readonly string[];
	/**
	 * 工作流触发请求（来自 /workflow <id> 或 bare /{wf-xxx} 命令）。
	 * 设置后 executeTurn 进入工作流模式：跳过自由 LLM 循环，由 DAG 驱动逐节点执行。
	 */
	readonly workflowTrigger?: {
		readonly workflowId: string;
		readonly input?: string;
	};
	/** Chat-only 模式开关（来自 UI 切换按钮）。开启时禁用所有写文件工具，React 范式下同时禁用 delegate_task。默认关闭。 */
	readonly chatOnly?: boolean;
	/** @deprecated 已移除 ChatMode（craft/plan/ask/workflow），由 AgentLoop 策略范式取代。保留字段仅为兼容旧调用方。 */
	readonly chatMode?: string;
	/** Mutable AgentLoop phase: plan is read-only; work can edit/execute. */
	readonly workMode?: 'plan' | 'work';
	/**
	 * Memory 注入策略（来自 Agent 的 memoryConfig.strategy）：
	 *   - 'full'    → 仅注入 Working（原始对话 / shortTermMemories）
	 *   - 'summary' → 仅注入 Episodic（摘要 / longTermMemories）
	 * 未指定时按 'full' 处理，保留旧行为兼容。
	 */
	readonly memoryStrategy?: 'summary' | 'full';
	/** Memory 注入条数上限（来自 Agent 的 memoryConfig.maxEntries），未指定时不限制。 */
	readonly memoryMaxEntries?: number;
	/**
	 * 多 agent 图运行时（supervisor / AgentCommand(goto) 设计，Step B/C）。
	 * 由 runAgentGraph（Step C）在节点执行请求中注入；单 agent 模式省略 → undefined。
	 * 透传进 loop 用于：① 仅在图模式暴露 transfer_to_agent 交接工具
	 * ② 校验节点发出的 handoff 指令目标合法性。
	 */
	readonly agentGraph?: AgentGraph;
	/**
	 * Memory 召回作用域（2026-06 新增，来自 Agent 的 memoryConfig.scope）：
	 *   - 'agent'     → 仅本 Agent 自己写入的 Episodic 记忆（默认，严格隔离）
	 *   - 'global'    → 全库 Episodic（跨 agent 共享）
	 * 未指定时按 'agent' 处理（C2 默认严格隔离）。
	 */
	readonly memoryScope?: 'agent' | 'global';
	/**
	 * 任务级 worktree 路径（来自 TaskBoardRecord.worktreePath）。
	 * 当设置时，agent 执行的工作目录应优先使用此路径（高于 AgentBinding.worktreePath）。
	 */
	readonly worktreePath?: string;
	/**
	 * Per-request model override (v39). When set, executeAgentTurn temporarily
	 * replaces the global active model selection with this value for the
	 * duration of the turn. Used by workflow nodes that have node-level
	 * provider/model configuration (agentConfig.providerId / modelId).
	 */
	readonly modelOverride?: IModelSelection;
	/**
	 * Per-request toolset scope override (v17, delegation). When set, it narrows
	 * the enabled tools to ONLY the listed toolsets (plus bridge tools). Used by
	 * `delegate_task` so a parent can constrain which toolsets a sub-agent may use
	 * (e.g. an Explore sub-agent scoped to ['core'] for read-only work). Takes
	 * precedence over the agent's own enabledToolsets/disabledToolsets. Undefined
	 * → no narrowing (current behavior preserved).
	 */
	readonly toolsetsOverride?: string[];
	/**
	 * Per-request tool-name exclusion (delegation). When set, the listed tools are
	 * unconditionally removed from the enabled tool list regardless of toolset —
	 * lets a parent hide specific tools from a sub-agent without fighting the
	 * coarse-grained toolset system. E.g. an Explore sub-agent must NOT see
	 * `index_repository` (the parent pre-builds the graph itself; letting the
	 * sub-agent call it makes it stop after "index started").
	 */
	readonly excludedTools?: readonly string[];
	/**
	 * Per-request tool-name allowlist (agentId-driven delegation, 2026-07-27). When set,
	 * the enabled tools are narrowed to ONLY these tool names (plus mandatory bridge/
	 * Always-priority tools). Sourced from a builtin Agent's `tools` array so a delegated
	 * sub-agent faithfully mirrors that Agent's tool surface. Applied as an intersection
	 * on top of toolsetsOverride/excludedTools. Undefined → no allowlist narrowing.
	 */
	readonly allowedTools?: readonly string[];
	/**
	 * AgentLoop 范式覆盖（可选，来自 Agent 配置 agent.paradigm）。
	 * 不提供时 AgentLoopStrategyFactory 按 chatMode 默认映射。
	 * 可选值：budgeted-react | plan-explore | react | graph | delegation | readonly
	 */
	readonly paradigm?: string;
	/**
	 * 每 turn 最大预算 / 迭代次数（可选，来自 Agent 配置 agent.budgetMaxTotal）。
	 * 不提供时使用 DEFAULT_BUDGET_MAX=90。仅在 budgeted-react 范式生效。
	 */
	readonly budgetMaxTotal?: number;
	/**
	 * 软预算（wall-clock，ms）：turn 耗时超过该值时，主循环注入一次「立即整理
	 * 发现并收尾」的 system-reminder——不打断执行，目的是让长探索任务在硬超时
	 * 前主动收敛产出。当前由子代理派发按 timeout×比例设置；主 agent 缺省
	 * undefined → 不启用。
	 */
	readonly softDeadlineMs?: number;
	/**
	 * checkpoint/resume（supervisor/goto Step D）：多 agent 图续跑请求时，携带上一次
	 * 图运行落盘的 AgentRunState，executeAgentGraph 从中恢复 graph.currentNodeId 续跑，
	 * 而非从 entry 重跑。单 agent / 首次运行省略 → undefined（零行为变更）。
	 */
	readonly resumeFrom?: AgentRunState;
	/**
	 * checkpoint 落盘回调（Step D，调用方注入，可选）。
	 * executeAgentGraph 在节点边界（ENTER_NODE / 路由后 SET_CURRENT_NODE）调用以持久化
	 * 快照；agentOSService 保持存储无关，落盘介质（IStorageService / 文件 / 内存）由调用方决定。
	 * 省略时不落盘（零行为变更）。
	 */
	readonly checkpointSink?: (snapshot: AgentRunStateSnapshot) => void | Promise<void>;
	/**
	 * Fork 前缀缓存上下文（MiMo ForkContext）— 请求构造端接 ForkContext 的完整形态。
	 * 携带父级冻结的 system+tools 前缀指纹。当本请求的 (systemPrompt, tools) 与父级
	 * 冻结前缀对齐（fingerprint 一致）时，请求构造端会在该前缀边界注入 `cache_control`
	 * 断点，使 provider 命中父级的 prompt cache 而非重新计费稳定的大前缀。
	 * 子 agent 由 unifiedSubAgentDispatch 注入父级 ForkContext；fork 会话由
	 * forkAgentSession 持久化的父级 ForkContext 经 sendMessage 透传。单 agent / 非
	 * fork 会话省略 → undefined（零行为变更）。
	 */
	readonly forkContext?: IForkContext;
	/**
	 * 后台子 agent 标记（P1，审批路由 `decideAskRouting`）。当本请求由
	 * unifiedSubAgentDispatch 派发的后台子 agent 触发时注入：
	 *   - `type`       → 子 agent 权限档（explore/general/scout），对齐 SubAgentType 值。
	 *   - `background` → true 表示后台运行，工具审批走「继承父授权（非交互放行）」而非
	 *                    弹交互确认阻塞父级 loop（子 agent 可见工具已被 SUB_AGENT_PERMISSIONS
	 *                    在过滤层收窄，能调到的即在其权限档内）。
	 * 前台主 agent / 用户直接会话省略 → undefined（审批走交互确认，行为不变）。
	 */
	readonly subAgent?: {
		readonly type: 'explore' | 'general' | 'scout';
		readonly background: boolean;
	};
}

// ─── Stream Phase (Void-inspired: IsRunningType 5-state model) ──────────

/**
 * 精确表达 Agent 循环的每个阶段，替代 boolean isStreaming。
 * 与 WebView 端 streamHandler.ts 中的 StreamPhase 定义保持同步。
 *
 * 状态流转:
 *   idle → llm_streaming → tool_executing → llm_streaming → ... → idle
 *   idle → llm_streaming → awaiting_approval → tool_executing → ... → idle
 *   idle → llm_streaming → compressing → llm_streaming → ... → idle
 *   * → error → idle
 */
export type StreamPhase =
	| 'idle'              // 完全空闲
	| 'llm_streaming'     // LLM 正在流式输出
	| 'tool_executing'    // 工具正在执行
	| 'awaiting_approval' // 等待用户审批
	| 'compressing'       // 正在压缩上下文
	| 'error';            // 错误状态

export interface IChatStreamDelta {
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'done' | 'error' | 'tool_progress' | 'content_replace'
	| 'references' | 'progress' | 'confirmation' | 'todos' | 'tips' | 'questions' | 'usage' | 'phase_change' | 'context_compacted'
	| 'sub_agent_start' | 'sub_agent_progress' | 'sub_agent_end' | 'subagent_batch' | 'mode_changed' | 'work_mode_changed' | 'plan_tasks'

	// ─── Hermes-style synthetic-recovery signal ─────────────────────────────
	// 参考 Hermes `agent/conversation_loop.py` 的 `_empty_recovery_synthetic` /
	// `_thinking_prefill` / `_empty_terminal_sentinel` 三类合成消息标记。
	// 当 host 检测到 fake-completion / unfinished-intent / 空回等"非真实模型输出"
	// 并准备注入 nudge 续跑时，先 yield 一个 `discard_prior_text`：
	//   - 下游 driver / chatService 收到后，**清空已累计的 text+thinking 缓冲**
	//   - 下游不持久化已被丢弃的幻觉文本，避免其作为 `prior driver messages`
	//     污染下一轮模型上下文（test49→test50 复现的 conversation rot 根因）。
	// reason 通过 metadata.reason 传递（'fake-completion' | 'unfinished-intent' | 'empty-recovery'）。
	| 'discard_prior_text'
	// ─── Hermes-style 消息边界事件（2026-06-05 治本根因修复）───────────────
	// 参考 Hermes `chat_completion_helpers.py:build_assistant_message()` 的铁律：
	// 消息边界 = 单次 API 响应。agentOS 多轮 loop 内部每个 iteration 把当前
	// content+toolCalls push 成独立一条 assistant 消息（紧跟 tool 结果），这个
	// 正确的 iteration 边界此前在 chatService 持久化时被 `fullContent += delta`
	// 压扁成一条，导致历史里出现"先宣告成功、后调用工具"的因果倒置范例，教坏
	// 模型在第二轮不再调工具。
	//
	// agentOS 在每个 iteration 确定 assistant 消息后 yield 一个 `assistant_turn`：
	//   - content：该轮经 sanitize+trim 的权威文本（chatService 据此切分，不再自行累加压扁）
	//   - metadata.toolCallIds：该轮的工具调用 id 列表（chatService 据此把 current
	//     toolCalls 归属到该 turn，后续 tool_result 仍可按 id 跨 turn 回填）
	//   - metadata.turnIndex：iteration 序号（调试用）
	// chatService 收到后把"当前累加器"快照成一条 turn，重置进入下一轮；done 后
	// 按 turn 持久化多条 ChatMessage（同回合共享 turnId），历史因果天然正确。
	| 'assistant_turn'
	| 'memory_extracted'
	// ─── 记忆生命周期 deltas（替代旧的单一 memory_extracted 假"已保存"信号）──────
	// 设计原则（对齐 agentmemory Working→Episodic→Semantic→Procedural 层级模型）：
	//   memory_writing      → Working 写入开始（pending 状态，含 noticeId 供后续更新）
	//   memory_written      → Working 写入成功（provider 事件桥接，含 noticeId 匹配）
	//   memory_write_failed → Working 写入失败（provider 事件桥接，含 error）
	//   memory_extracted    → LLM <memory_extract> 标签捕获（同步，memory IS extracted，保持 saved 状态）
	//   memory_episodic_extracted → Episodic 记忆提取完成
	//   memory_semantic_extracted     → Semantic 记忆提取完成
	//   memory_procedural_extracted   → Procedural 记忆生成完成
	| 'memory_writing' | 'memory_written' | 'memory_write_failed'
	| 'memory_episodic_extracted' | 'memory_semantic_extracted' | 'memory_procedural_extracted'
	| 'memory_injected'
	| 'skill_extracted'
	| 'codebase_operation'
	| 'confirmation_resolved';
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly metadata?: Record<string, unknown>;
	readonly progress?: number; // 0-100 进度百分比（用于 tool_progress 类型）
	readonly stage?: string; // 当前阶段描述（用于 tool_progress 类型）
	readonly success?: boolean; // tool_end 时表示工具是否执行成功
	/** Token 使用量（type === 'usage' 时携带） */
	readonly usage?: IModelUsage;
	/**
	 * Stream phase — allows explicit phase transitions from Host.
	 * When present, the WebView will set StreamState.phase to this value.
	 *
	 * Phases: 'idle' | 'llm_streaming' | 'tool_executing' | 'awaiting_approval' | 'compressing' | 'error'
	 */
	readonly phase?: StreamPhase;
	/**
	 * 上下文压缩后回传的"压缩后估算输入 token"（type === 'context_compacted' 时携带）。
	 *
	 * 背景：上下文压缩只缩减 Host 端 messages 数组，WebView store 的 messages 历史不变，
	 * 因此 ChatComposer 圆环进度条的 inputBaselineTokens 仍是压缩前的旧大值，圆圈压不下来。
	 * Host 在压缩成功后 yield 此事件，携带压缩后的估算输入 token，WebView 据此把圆环基线
	 * 立即下调（compactedBaseline），实现"压缩后圆圈同步回落"。下一轮真实 usage 回来后自然覆盖。
	 */
	readonly compactedInputTokens?: number;
	/**
	 * 上下文压缩详情（type === 'context_compacted' 时携带）。
	 * 用于在聊天消息流中渲染压缩提示卡片。
	 */
	readonly compressionOriginalCount?: number;
	readonly compressionCompressedCount?: number;
	readonly compressionTokensSaved?: number;
	readonly compressionDurationMs?: number;
	/**
	 * Sub-agent lifecycle fields. Carried on `sub_agent_start | sub_agent_progress | sub_agent_end`
	 * delta types so that the Host can drive the WebView's SubAgentCard. Field names are kept
	 * 1:1 aligned with the WebView-side StreamChunk (streamHandler.ts) so the controller can
	 * forward the delta verbatim without remapping.
	 */
	readonly subAgentId?: string;
	readonly subAgentType?: 'explore' | 'general' | 'scout';
	readonly subAgentTask?: string;
	readonly subAgentParentId?: string;
	readonly subAgentStatus?: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	readonly subAgentProgress?: string;
	readonly subAgentOutput?: string;
	readonly subAgentError?: string;
	/** plan_explore 子代理批量数据（subagent_batch delta, ISubAgentData[]） */
	readonly subagentData?: any[];
	/** mode_changed delta — sync an explicit user ChatMode change to UI. */
	readonly mode?: string;
	/** work_mode_changed delta — internal AgentLoop phase; does not change the UI ChatMode selector. */
	readonly workMode?: 'plan' | 'work';
	readonly subAgentGroupId?: string;
	/** plan_tasks delta — structured plan tasks generated at plan_exit, for a dedicated chat card. */
	readonly planTasksData?: {
		readonly planId?: string;
		readonly summary?: string;
		readonly tasks: Array<{
			readonly title: string;
			readonly description?: string;
			readonly files?: string[];
			readonly dependencies?: string[];
			readonly deliverable?: string;
			readonly complexity?: string;
			readonly status?: string;
		}>;
	};
	/**
	 * Host-side full text snapshot (Void-inspired fullTextSoFar pattern).
	 * When present, the WebView should use this instead of incrementally
	 * appending `content` to textBuffer. This eliminates the MISMATCH risk
	 * where WebView-side textBuffer drifts from the Host's actual text.
	 *
	 * Only sent when the Host maintains a full-text accumulator; otherwise
	 * the WebView falls back to delta accumulation (content += delta).
	 */
	readonly fullText?: string;
	/**
	 * Host-side full thinking snapshot (parallel to fullText).
	 * When present, the WebView should use this instead of incrementally
	 * appending `content` to thinkingBuffer.
	 */
	readonly fullThinking?: string;
	/** UI 显示名称（来自模型的 display_name 字段） */
	readonly displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeEditor 等） */
	readonly renderType?: string;
	/** 是否默认展开显示工具卡（默认 true） */
	readonly defaultShow?: boolean;
	// New fields for card data (VS Code Copilot Chat pattern)
	/** References data (for references delta type) */
	readonly references?: Array<{
		readonly id: string;
		readonly kind: 'file' | 'code' | 'url' | 'symbol' | 'text';
		readonly name: string;
		readonly uri?: string;
		readonly range?: { startLine: number; startCol: number; endLine: number; endCol: number };
		readonly description?: string;
		readonly state?: 'not-modified' | 'modified' | 'pending' | 'excluded';
	}>;
	/** Progress data (for progress delta type) */
	readonly progressData?: Array<{
		readonly id: string;
		readonly content: string;
		readonly status: 'pending' | 'in-progress' | 'completed' | 'error';
		readonly icon?: 'spinner' | 'check' | 'warning' | 'error';
		readonly timestamp?: string;
	}>;
	/** Confirmation data (for confirmation delta type) */
	readonly confirmationData?: {
		readonly id: string;
		readonly title: string;
		readonly message: string;
		readonly detail?: string;
		readonly buttons: Array<{
			readonly id: string;
			readonly label: string;
			readonly tooltip?: string;
			readonly primary?: boolean;
			readonly danger?: boolean;
			readonly icon?: string;
		}>;
		readonly status: 'pending' | 'approved' | 'rejected' | 'cancelled';
		readonly icon?: string;
		/** Plan-mode specific: structured plan data for approval */
		readonly type?: 'plan-approval';
		readonly planSummary?: string;
		readonly tasks?: Array<{
			readonly title: string;
			readonly description: string;
			readonly files?: string[];
			readonly complexity?: 'low' | 'medium' | 'high';
			readonly suggestedRole?: string;
			readonly dependencies?: number[];
		}>;
		/** Recommended chat mode after plan approval */
		readonly nextMode?: 'craft' | 'ask';
	};
	/** 用户决策后的确认卡片 id（confirmation_resolved delta 携带） */
	readonly confirmationId?: string;
	/** 用户决策后的确认卡片状态（confirmation_resolved delta 携带） */
	readonly confirmationStatus?: 'approved' | 'rejected' | 'cancelled';
	/** Todos data (for todos delta type) */
	readonly todosData?: Array<{
		readonly id: string;
		readonly label: string;
		readonly completed: boolean;
		readonly description?: string;
		readonly assignee?: string;
	}>;
	/** Tips data (for tips delta type) */
	readonly tipsData?: Array<{
		readonly id: string;
		readonly content: string;
		readonly icon?: string;
		readonly action?: {
			readonly label: string;
			readonly tooltip?: string;
			readonly actionId?: string;
		};
	}>;
	/** Questions data (for questions delta type) */
	readonly questionsData?: Array<{
		readonly id: string;
		readonly label: string;
		readonly tooltip?: string;
		readonly category?: string;
	}>;
}

/**
 * 工具执行进度回调
 */
export interface IToolProgressCallback {
	/**
	 * 报告工具执行进度
	 * @param toolCallId 工具调用 ID
	 * @param toolName 工具名称
	 * @param progress 进度 (0-100)
	 * @param stage 当前阶段描述
	 */
	onProgress(toolCallId: string, toolName: string, progress: number, stage?: string): void;

	/**
	 * 报告工具执行完成
	 */
	onComplete(toolCallId: string, toolName: string, success: boolean): void;

	/**
	 * 报告工具执行错误
	 */
	onError(toolCallId: string, toolName: string, error: string): void;
}

// ─── Retrieval Provider Interface ─────────────────────────────────────────────

export interface IRetrievalProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * RAG: 检索相关文档
	 */
	retrieve(query: string, options?: IRetrievalOptions): Promise<IRetrievalResult[]>;
	/**
	 * 索引文档（可选）
	 */
	indexDocument(doc: IDocumentToIndex): Promise<void>;
}

export interface IRetrievalOptions {
	readonly topK?: number;
	readonly scoreThreshold?: number;
	readonly filters?: Record<string, unknown>;
}

export interface IRetrievalResult {
	readonly documentId: string;
	readonly content: string;
	readonly score: number;
	readonly metadata?: Record<string, unknown>;
}

export interface IDocumentToIndex {
	readonly id: string;
	readonly content: string;
	readonly metadata?: Record<string, unknown>;
}

// ─── Kanban Provider Interface ─────────────────────────────────────────────────

export enum KanbanPriority {
	Critical = 'critical',
	High = 'high',
	Medium = 'medium',
	Low = 'low',
}

export interface IKanbanProvider {
	readonly id: string;
	readonly name: string;

	// 看板管理
	listBoards(): Promise<IKanbanBoard[]>;
	getBoard(boardId: string): Promise<IKanbanBoard>;

	// 任务卡片 CRUD
	createCard(boardId: string, card: IKanbanCardCreate): Promise<IKanbanCard>;
	updateCard(cardId: string, updates: Partial<IKanbanCardUpdate>): Promise<IKanbanCard>;
	moveCard(cardId: string, targetColumn: string, position?: number): Promise<void>;
	deleteCard(cardId: string): Promise<void>;

	// 查询
	listCards(boardId: string, filter?: IKanbanFilter): Promise<IKanbanCard[]>;
	getCard(cardId: string): Promise<IKanbanCard>;

	// 实时更新（供 TaskBoard UI 订阅）
	readonly onDidChangeCards: Event<IKanbanCardChangeEvent>;
	readonly onDidChangeBoard: Event<IKanbanBoardChangeEvent>;
}

export interface IKanbanBoard {
	readonly id: string;
	readonly name: string;
	readonly columns: IKanbanColumn[];
	readonly metadata?: Record<string, unknown>;
}

export interface IKanbanColumn {
	readonly id: string;
	readonly name: string;
	readonly order: number;
	readonly wipLimit?: number;
}

export interface IKanbanCard {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly columnId: string;
	readonly assignee?: string;
	readonly labels?: string[];
	readonly priority?: KanbanPriority;
	readonly dueDate?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly metadata?: Record<string, unknown>;
}

export interface IKanbanCardCreate {
	title: string;
	description?: string;
	columnId: string;
	assignee?: string;
	labels?: string[];
	priority?: KanbanPriority;
	dueDate?: string;
	metadata?: Record<string, unknown>;
}

export interface IKanbanCardUpdate {
	title?: string;
	description?: string;
	assignee?: string;
	labels?: string[];
	priority?: KanbanPriority;
	dueDate?: string;
	metadata?: Record<string, unknown>;
}

export interface IKanbanFilter {
	readonly columnId?: string;
	readonly assignee?: string;
	readonly labels?: string[];
	readonly priority?: KanbanPriority;
}

export interface IKanbanCardChangeEvent {
	readonly type: 'created' | 'updated' | 'moved' | 'deleted';
	readonly card: IKanbanCard;
	readonly previousColumnId?: string;
}

export interface IKanbanBoardChangeEvent {
	readonly type: 'column-added' | 'column-removed' | 'column-reordered';
	readonly board: IKanbanBoard;
}

// ─── Slot Registry (传递给 ExecutionProvider) ────────────────────────────────

/**
 * 能力槽注册表 — 供 ExecutionProvider 在 Agent Loop 内部回调各能力槽
 */
export interface ISlotRegistry {
	getActiveModelProvider(): IModelProvider | undefined;
	getActiveModelSelection(): IModelSelection | undefined;
	getActiveMemoryProvider(): IMemoryProvider | undefined;
	getActiveToolProvider(): IToolProvider | undefined;
	getToolProviders(): IToolProvider[];
	getActivePlanningProvider(): IPlanningProvider | undefined;
	getActiveRetrievalProvider(): IRetrievalProvider | undefined;
	getActiveKanbanProvider(): IKanbanProvider | undefined;
}
