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
	readonly contextWindow?: number;
	readonly capabilities?: ModelCapability[];
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
}

// ─── Model Provider Interface ───────────────────────────────────────────────────
// 特殊性：支持同时注册多个 Provider，每个 Provider 可提供多个模型

export interface IModelProvider {
	readonly id: string;              // e.g. 'knot-agui', 'direct-openai'
	readonly name: string;            // 显示名，e.g. 'Knot AG-UI'
	readonly icon?: URI;
	readonly priority: number;        // 默认优先级（决定默认选中）

	// 模型列表（可动态刷新）
	readonly onDidChangeModels: Event<void>;
	listModels(): Promise<IModelInfo[]>;

	// 认证状态
	readonly onDidChangeAuthStatus: Event<ModelAuthStatus>;
	getAuthStatus(): ModelAuthStatus;

	// 推理调用（指定模型）
	chat(
		modelId: string,
		messages: IChatMessage[],
		options: IModelOptions,
	): AsyncIterable<IModelDelta>;
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
}

export interface IModelOptions {
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly systemPrompt?: string;
	readonly tools?: IToolDefinition[];
	readonly stop?: string[];
}

export interface IModelDelta {
	readonly type: 'text' | 'thinking' | 'tool_call' | 'done' | 'error';
	readonly content?: string;
	readonly toolCall?: IToolCallInfo;
	readonly error?: string;
}

// ─── Memory Provider Interface ────────────────────────────────────────────────

export interface IMemoryProvider {
	readonly id: string;
	readonly name: string;

	loadContext(agentId: string, sessionId: string): Promise<IMemoryContext>;
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

// ─── Tool Provider Interface ──────────────────────────────────────────────────

export interface IToolProvider {
	readonly id: string;
	readonly name: string;

	listTools(agentId: string): Promise<IToolDefinition[]>;
	executeTool(agentId: string, toolCall: IToolCall): Promise<IToolResult>;
}

export interface IToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>; // JSON Schema
	readonly category?: string;  // e.g. 'filesystem', 'browser', 'search'
	readonly source?: string;      // provider id
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
}

export interface IChatStreamDelta {
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'done' | 'error';
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly metadata?: Record<string, unknown>;
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
	getActiveMemoryProvider(): IMemoryProvider | undefined;
	getActiveToolProvider(): IToolProvider | undefined;
	getActivePlanningProvider(): IPlanningProvider | undefined;
	getActiveRetrievalProvider(): IRetrievalProvider | undefined;
	getActiveKanbanProvider(): IKanbanProvider | undefined;
}
