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
	[key: string]: unknown;
}

export interface IChatMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
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
}

export interface IModelDelta {
	readonly type: 'text' | 'thinking' | 'tool_call' | 'done' | 'error' | 'usage';
	readonly content?: string;
	readonly toolCall?: IToolCallInfo;
	readonly error?: string;
	/** Token 使用量（type === 'usage' 时携带） */
	readonly usage?: IModelUsage;
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
	 */
	loadContext(agentId: string, sessionId: string, query?: string): Promise<IMemoryContext>;
	writeMemory(agentId: string, entry: IMemoryEntry): Promise<void>;
	searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]>;
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
}

export interface IChatStreamDelta {
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'done' | 'error' | 'tool_progress' | 'content_replace'
	| 'references' | 'progress' | 'confirmation' | 'todos' | 'tips' | 'questions' | 'usage';
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly metadata?: Record<string, unknown>;
	readonly progress?: number; // 0-100 进度百分比（用于 tool_progress 类型）
	readonly stage?: string; // 当前阶段描述（用于 tool_progress 类型）
	readonly success?: boolean; // tool_end 时表示工具是否执行成功
	/** Token 使用量（type === 'usage' 时携带） */
	readonly usage?: IModelUsage;
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
