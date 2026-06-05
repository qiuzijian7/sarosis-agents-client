/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

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
	readonly type: 'text' | 'thinking' | 'tool_call' | 'done' | 'error' | 'usage';
	readonly content?: string;
	readonly toolCall?: IToolCallInfo;
	readonly error?: string;
	/** Token 使用量（type === 'usage' 时携带） */
	readonly usage?: IModelUsage;
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

export interface IMemoryProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * 加载会话的记忆上下文。
	 *
	 * `query` 参数（可选）：当前轮次的用户输入文本，用于驱动 vendor 的语义/关键词
	 * 召回。若不传，provider 实现可走"全量摘要"或返回空，但召回质量会大幅下降。
	 *
	 * 历史 bug：早期接口没有 query 参数，TdbAmMemoryProvider 只能用占位字符串
	 * `_loadContext_` 当 query，导致 vendor FTS5 永远召不回任何 L1 记忆。
	 * 加了第 3 参后，调用方应把 messages 中最近一条 user 消息抽出来传入。
	 *
	 * `options.scope` (2026-06 新增) —— 控制召回的作用域：
	 *   - 'agent'     → 仅本 Agent 自己写入的记忆
	 *   - 'workspace' → 当前 workspace 下所有 agent 的记忆（需配合
	 *     `options.allowedSessionKeys` 提供兄弟 agent 的 sessionKey 列表）
	 *   - 'global'    → 全库（旧行为）
	 * 不传时 provider 实现按"global"兜底，保持向后兼容；老的 provider
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
}

/**
 * 记忆召回的可选作用域参数（2026-06 新增）。详见 IMemoryProvider.loadContext 注释。
 */
export interface IMemoryRecallOptions {
	scope?: 'agent' | 'workspace' | 'global';
	allowedSessionKeys?: readonly string[];
}

export interface IMemoryContext {
	readonly shortTermMemories: IMemoryEntry[];
	readonly longTermMemories: IMemoryEntry[];
	readonly systemPrompt?: string;
	readonly relevantDocuments?: IDocumentRef[];
}

export interface IMemoryEntry {
	readonly id: string;
	readonly type: 'short_term' | 'long_term';
	readonly content: string;
	readonly metadata?: Record<string, unknown>;
	readonly timestamp?: number;
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
}

export interface IToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>; // JSON Schema
	readonly category?: string;  // e.g. 'filesystem', 'browser', 'search'
	readonly source?: string;      // provider id
	/** 安全等级 — 决定是否需要用户审批（默认 safe） */
	readonly securityLevel?: ToolSecurityLevel;
	/** 声明式可用性条件列表（所有条件需同时满足） */
	readonly availability?: IToolAvailability[];
}

export interface IToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface IToolResult {
	readonly toolCallId: string;
	readonly success: boolean;
	readonly content: IToolResultContent[];
	readonly error?: string;
	/** 结构化执行元数据 — 参考 OpenClaw 的 AgentToolResult.details */
	readonly metadata?: IToolResultMetadata;
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
}

export interface IToolResultContent {
	readonly type: 'text' | 'image' | 'resource';
	readonly text?: string;
	readonly data?: string; // base64 or URI
	readonly mimeType?: string;
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
	readonly systemPrompt?: string;
	readonly options?: IModelOptions;
	/** 用户通过 /skill 命令显式激活的技能 ID 列表 */
	readonly explicitSkillIds?: readonly string[];
	/** Current chat mode: craft (full access), ask (read-only tools), plan (decomposition only), workflow (craft + downstream agents) */
	readonly chatMode?: 'craft' | 'ask' | 'plan' | 'workflow';
	/**
	 * Memory 注入策略（来自 Agent 的 memoryConfig.strategy）：
	 *   - 'full'    → 仅注入 L0（原始对话 / shortTermMemories）
	 *   - 'summary' → 仅注入 L1（摘要 / longTermMemories）
	 * 未指定时按 'full' 处理，保留旧行为兼容。
	 */
	readonly memoryStrategy?: 'summary' | 'full';
	/** Memory 注入条数上限（来自 Agent 的 memoryConfig.maxEntries），未指定时不限制。 */
	readonly memoryMaxEntries?: number;
	/**
	 * Memory 召回作用域（2026-06 新增，来自 Agent 的 memoryConfig.scope）：
	 *   - 'agent'     → 仅本 Agent 自己写入的 L1 记忆
	 *   - 'workspace' → 当前 workspace 下所有 agent 共享 L1（需配合 memoryAllowedSessionKeys）
	 *   - 'global'    → 全库 L1（旧行为）
	 * 未指定时按 'agent' 处理（C2 默认严格隔离）。
	 */
	readonly memoryScope?: 'agent' | 'workspace' | 'global';
	/**
	 * 当 memoryScope === 'workspace' 时，调用方负责把"同 workspace 下所有 agent 的
	 * sessionKey（agent:<id>）"列出来传下去。Provider 自身没有能力枚举兄弟 agent。
	 */
	readonly memoryAllowedSessionKeys?: readonly string[];
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
	| 'sub_agent_start' | 'sub_agent_progress' | 'sub_agent_end'
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
	| 'assistant_turn';
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
	readonly subAgentGroupId?: string;
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

export const enum KanbanPriority {
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
