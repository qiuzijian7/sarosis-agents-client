/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { Event } from "../../../../base/common/event.js";
import { IDisposable } from "../../../../base/common/lifecycle.js";
import {
	IModelProvider,
	IModelSelection,
	IMemoryProvider,
	IToolProvider,
	IPlanningProvider,
	IExecutionProvider,
	IRetrievalProvider,
	IKanbanProvider,
	IAgentTurnRequest,
	IChatStreamDelta,
	ISlotRegistry,
	IToolDefinition,
	IToolApprovalHandler,
} from "./providers.js";
import type { IForkContext } from "./forkContext.js";

// ─── Agent OS Service ───────────────────────────────────────────────────────

export const IAgentOSService =
	createDecorator<IAgentOSService>("agentOSService");

/**
 * Agent OS 中间层核心服务
 * 统一编排所有能力槽（Model / Memory / Tool / Planning / Execution / Retrieval / Kanban）
 *
 * 架构位置：
 *   UI → Driver Layer → **OS Layer (IAgentOSService)** → Provider Plugins
 */
export interface IAgentOSService {
	readonly _serviceBrand: undefined;

	// ─── 能力槽注册 ─────────────────────────────────────────────────

	/**
	 * 注册 Model Provider（支持多个，用户在 UI 中选择）
	 */
	registerModelProvider(provider: IModelProvider): IDisposable;

	/**
	 * 注册 Memory Provider（优先级自动选择活跃 Provider）
	 */
	registerMemoryProvider(
		provider: IMemoryProvider,
		priority?: number,
	): IDisposable;

	/**
	 * 注册 Tool Provider
	 */
	registerToolProvider(provider: IToolProvider, priority?: number): IDisposable;

	/**
	 * 注册 Planning Provider
	 */
	registerPlanningProvider(
		provider: IPlanningProvider,
		priority?: number,
	): IDisposable;

	/**
	 * 注册 Execution Provider
	 */
	registerExecutionProvider(
		provider: IExecutionProvider,
		priority?: number,
	): IDisposable;

	/**
	 * 注册 Retrieval (RAG) Provider
	 */
	registerRetrievalProvider(
		provider: IRetrievalProvider,
		priority?: number,
	): IDisposable;

	/**
	 * 注册 Kanban Provider
	 */
	registerKanbanProvider(
		provider: IKanbanProvider,
		priority?: number,
	): IDisposable;

	// ─── Model Provider 管理（多 Provider 多模型）────────────────────

	readonly onDidChangeModelProviders: Event<void>;
	getModelProviders(): IModelProvider[];
	getActiveModelSelection(): IModelSelection;
	setActiveModelSelection(selection: IModelSelection): void;

	// ─── 其他能力查询（优先级自动选择）────────────────────────────

	getActiveMemoryProvider(): IMemoryProvider | undefined;
	getActiveToolProvider(): IToolProvider | undefined;
	getActivePlanningProvider(): IPlanningProvider | undefined;
	getActiveExecutionProvider(): IExecutionProvider | undefined;
	getActiveRetrievalProvider(): IRetrievalProvider | undefined;
	getActiveKanbanProvider(): IKanbanProvider | undefined;

	/**
	 * 返回某会话最近一次迭代计算出的冻结前缀（ForkContext）。fork 会话时用于抓取父级
	 * 冻结 system+tools，使子会话请求与父级前缀对齐 → 命中 provider prompt cache。
	 * 会话从未运行过则返回 undefined。
	 */
	getForkContext(sessionId: string): IForkContext | undefined;

	// ─── Slot Registry（传递给 ExecutionProvider）──────────────────

	/**
	 * 获取 SlotRegistry，供 ExecutionProvider 在 Agent Loop 内部回调 OS 各能力槽
	 */
	getSlotRegistry(): ISlotRegistry;

	// ─── 统一执行入口（替代原 IAgentChatService.sendMessage）────────

	/**
	 * 执行一次 Agent 对话轮次
	 * 内部编排：Planning → Memory → Execution(Tool) → Memory → 返回流
	 */
	executeAgentTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta>;

	/**
	 * 执行多 agent 图（supervisor / AgentCommand(goto) 设计 Step C）。
	 * 当 `request.agentGraph` 含 ≥2 节点时由 `executeAgentTurn` 自动委派；也可由
	 * 图运行时直接调用。复用既有单 agent loop 作为节点执行器，按 `AgentCommand(goto)`
	 * 动态路由。单 agent 模式（无 agentGraph）回退到单 agent 路径，零行为变更。
	 */
	executeAgentGraph(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta>;

	// ─── Agent Loop 控制 ───────────────────────────────────────

	/**
	 * 取消 Agent Loop（中断工具执行）。
	 * - 传 agentId + sessionId：按 turnKey 精确取消该窗口/会话，不影响其他并发窗口。
	 * - 不传参数：取消所有活跃 turn（向后兼容）。
	 */
	cancelAgentLoop(agentId?: string, sessionId?: string): void;

	/**
	 * Episodic 自动提取：对话轮次达阈值时，后台调用 LLM 从最近对话中提取
	 * 结构化长期记忆（persona/episodic/instruction），写入 Memory Provider。
	 * fire-and-forget，不阻塞调用方。
	 *
	 * 对齐 AgentMemory 的 Working→Episodic 管线：不再完全依赖 LLM 主动调 memory_remember，
	 * 系统自动在对话累积后提取值得跨会话记住的事实。
	 */
	triggerEpisodicExtraction(agentId: string, sessionId: string | undefined, recentUserText: string, recentAssistantText: string): void;

	/**
	 * Semantic 提取：Episodic 完成后延迟触发，后台调用 LLM 从近期 Episodic 记忆中
	 * 提取场景级摘要（如"用户在做 X 项目时遇到 Y 问题"），写入 Memory Provider。
	 * fire-and-forget，不阻塞调用方。
	 *
	 * 对齐 AgentMemory 的 Semantic 层：per-session downward-only timer，delay-after-Episodic 触发。
	 */
	triggerSemanticExtraction(agentId: string): void;

	/**
	 * Procedural 生成：Semantic 完成后触发，后台调用 LLM 从所有场景摘要中
	 * 生成用户人格画像（偏好、习惯、专业领域等），写入 Memory Provider。
	 * 全局互斥（concurrency=1），fire-and-forget。
	 *
	 * 对齐 AgentMemory 的 Procedural 层：global mutex + pending flag dedup。
	 */
	triggerProceduralGeneration(): void;

	// ─── Tool 启用/禁用管理 ─────────────────────────────────────

	/**
	 * 启用工具
	 * @param agentId Agent ID
	 * @param toolName 工具名称
	 */
	enableTool(agentId: string, toolName: string): Promise<void>;

	/**
	 * 禁用工具
	 * @param agentId Agent ID
	 * @param toolName 工具名称
	 */
	disableTool(agentId: string, toolName: string): Promise<void>;

	/**
	 * 检查工具是否已启用
	 * @param agentId Agent ID
	 * @param toolName 工具名称
	 * @returns 是否已启用
	 */
	isToolEnabled(agentId: string, toolName: string): Promise<boolean>;

	/**
	 * 获取所有工具的启用状态
	 * @param agentId Agent ID
	 * @returns 工具名称 -> 是否启用的 Map
	 */
	getToolsEnabledState(agentId: string): Promise<Record<string, boolean>>;

	/**
	 * 批量设置工具的启用状态
	 * @param agentId Agent ID
	 * @param state 工具名称 -> 是否启用的 Map
	 */
	setToolsEnabledState(
		agentId: string,
		state: Record<string, boolean>,
	): Promise<void>;

	/**
	 * 获取所有工具定义（包括被禁用的，带 enabled 状态）
	 * @param agentId Agent ID
	 * @returns 工具定义数组（包含 enabled 字段）
	 */
	listAllToolsWithState(
		agentId: string,
	): Promise<(IToolDefinition & { enabled: boolean })[]>;

	/**
	 * 注册工具审批 UI Handler。
	 * 由 WebView 或 Chat UI 层调用，提供用户确认能力。
	 * @param handler 工具审批处理器
	 */
	setToolApprovalHandler(handler: IToolApprovalHandler): void;

	// ─── Dashboard 统计 ───────────────────────────────────────────────

	/**
	 * 获取 Dashboard 统计数据（Token 消耗、压缩指标、工具调用频率等）
	 * 数据在 executeAgentTurn 流程中实时累积，供 Dashboard UI 展示。
	 */
	getDashboardStats(): IAgentOSDashboardStats;

	/**
	 * 获取 Dashboard 时间序列快照（用于趋势图）。
	 * @param rangeMs 向前查询的时间范围（毫秒），如 7 * 24 * 60 * 60 * 1000 = 7天
	 */
	queryDashboardSnapshots(rangeMs: number): Promise<IDashboardMetricsSnapshot[]>;

	/**
	 * 获取 Dashboard 按天聚合数据（趋势图降采样）。
	 * @param rangeMs 向前查询的时间范围（毫秒）
	 */
	queryDashboardDailyBuckets(rangeMs: number): Promise<IDailyBucket[]>;

	/**
	 * 采集并保存 Dashboard 时间序列快照。
	 * 调用时机：periodic timer、executeAgentTurn 完成、dispose。
	 * fire-and-forget，调用方无需 await。
	 */
	captureDashboardSnapshot(options?: {
		sessionCount?: number;
		memoryTotal?: number;
		graphNodes?: number;
	}): Promise<void>;
}

/** AgentOS Dashboard 统计数据快照 */
export interface IAgentOSDashboardStats {
	/** 累计输入 Token */
	totalInputTokens: number;
	/** 累计输出 Token */
	totalOutputTokens: number;
	/** 累计缓存命中 Token */
	totalCachedTokens: number;
	/** 当前活跃模型 ID */
	activeModelId: string;
	/** 压缩总次数 */
	compressionCount: number;
	/** 低效压缩次数（节省 < 阈值） */
	compressionIneffectiveCount: number;
	/** 累计压缩前 Token */
	compressionBeforeTokens: number;
	/** 累计压缩后 Token */
	compressionAfterTokens: number;
	/** 工具调用次数（按工具名） */
	toolCallCounts: Map<string, number>;
	/** L1 Episodic 自动提取触发次数 */
	l1ExtractionCount: number;
	/** L2 Semantic 提取触发次数 */
	l2ExtractionCount: number;
	/** L3 Procedural 生成触发次数 */
	l3ExtractionCount: number;
}

/** Dashboard 时间序列快照（SQLite metrics_snapshots 表行） */
export interface IDashboardMetricsSnapshot {
	/** 快照时间戳（ISO 8601） */
	ts: string;
	/** 累计输入 Token */
	inputTokens: number;
	/** 累计输出 Token */
	outputTokens: number;
	/** 累计缓存 Token */
	cachedTokens: number;
	/** 压缩总次数 */
	compressionCount: number;
	/** 记忆总条数 */
	memoryTotal: number;
	/** 代码图谱节点数 */
	graphNodes: number;
	/** 活跃会话数 */
	sessionCount: number;
	/** 当前活跃模型 */
	activeModel?: string;
}

/** Dashboard 按天聚合数据（趋势图降采样） */
export interface IDailyBucket {
	/** 日期（YYYY-MM-DD） */
	day: string;
	/** 当日累计输入 Token */
	input_tokens: number;
	/** 当日累计输出 Token */
	output_tokens: number;
	/** 当日累计缓存 Token */
	cached_tokens: number;
	/** 当日压缩次数 */
	compression_count: number;
	/** 当日记忆总数 */
	memory_total: number;
	/** 当日代码图谱节点数 */
	graph_nodes: number;
	/** 当日活跃会话数 */
	session_count: number;
}
