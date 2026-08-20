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
import type { AgentGraph } from "./agentGraph.js";
import type { IHardPermissionPolicy } from "./toolPermission.js";

// ─── SubAgent trace streaming (P0/P1: 旁路事件总线) ──────────────────────────
//
// plan_explore 是 blocking 工具，执行期间无法向主 turn 的 delta 流插入进度。
// 因此改走独立的旁路总线：适配层（planExploreTool）维护每个子 agent 的全量卡片
// 快照，事件驱动更新并节流 fire；UI（nativeChatEditorPane）订阅并按 `id` upsert
// 到当前流式 assistant 消息的 subagent parts。此结构刻意与 UI 侧 ISubAgentData
// 对齐，使 UI 收到后可直接当作卡片数据渲染，无需二次映射。
//
// 注意：common 层不能 import browser 层的 ISubAgentData，故这里内联等价结构。

/** 单条子 agent 工具执行痕迹（与 UI ISubAgentToolTrace 对齐）。 */
export interface ISubAgentTraceEntry {
	readonly id: string;
	readonly name: string;
	readonly status: 'running' | 'done' | 'error';
	readonly args?: string;
	readonly result?: string;
}

/** 单个子 agent 卡片快照（与 UI ISubAgentData 的核心字段对齐）。 */
export interface ISubAgentCardSnapshot {
	readonly id: string;
	/** Agent type badge. Fixed values: 'explore' | 'general' | 'scout' — or any registered agent name (e.g. 'code-explorer', 'researcher', 'data'). */
	readonly type: string;
	readonly task: string;
	readonly status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	readonly progress?: string;
	readonly output?: string;
	readonly error?: string;
	readonly groupId?: string;
	readonly toolTraces?: ReadonlyArray<ISubAgentTraceEntry>;
	/** P0: 将 subagent 卡片归位到其父 plan_explore tool card 之后。 */
	readonly parentToolCallId?: string;
	/** Live thinking text emitted by the sub-agent during execution (running only). */
	readonly thinking?: string;
	/** 子代理开始/结束时间（epoch ms），供 UI 计算时长（卡片时间 chip 与页脚统计）。 */
	readonly startedAt?: number;
	readonly completedAt?: number;
}

/**
 * 旁路总线事件载荷：一批子 agent 卡片的全量快照。
 * UI 按 `subagentData[].id` 幂等 upsert（流式与最终态共用同一批 id，天然去重）。
 */
export interface ISubAgentTraceSnapshot {
	readonly groupId?: string;
	readonly subagentData: ReadonlyArray<ISubAgentCardSnapshot>;
}

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

	// ─── SubAgent 执行过程流式（P0/P1 旁路总线）─────────────────────
	//
	// 订阅方（nativeChatEditorPane）监听 onDidSubAgentTrace，按快照 upsert 卡片；
	// 产出方（planExploreTool 的 inlineTraceSink）调 fireSubAgentTrace 推送节流后的快照。
	readonly onDidSubAgentTrace: Event<ISubAgentTraceSnapshot>;
	/** 推送一批子 agent 卡片快照到 UI（旁路主 delta 流）。 */
	fireSubAgentTrace(snapshot: ISubAgentTraceSnapshot): void;

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

	/**
	 * 跳过当前正在执行的工具（terminal 等长命令卡住时用户点「继续执行」）：
	 * 中止工具级信号 → 工具返回中断结果回传 LLM，turn 本身不被取消，
	 * agent 拿到结果后继续后续步骤。
	 */
	skipCurrentTool(): void;

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
	 * 将对话增量外置为会话观察（mem:obs 暂存层，按内容哈希去重，跳过 system 消息）。
	 * 供 driver/turn 边界统一捕获 user/assistant 消息（2026-07-26 W2：替代直写
	 * writeMemory(type=working) 的历史通道）。
	 */
	_storeTurnObservations(provider: unknown, agentId: string, sessionId: string, messages: ReadonlyArray<unknown>): Promise<void>;

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
	 * 返回经过 focus 模式 + toolset 白名单 + hardPermission 过滤后、真正会随请求下发
	 * function-calling schema 的非 MCP 工具名清单。
	 *
	 * 用于 Prompt 组装层生成 "Built-in tools:" 文字清单——必须与真实下发的 schema
	 * 严格一致，不能再用 listAllToolsWithState() 的全量结果（那会导致提示词点名
	 * 但实际无 schema 的工具，模型调用必然失败或产生幻觉）。
	 *
	 * 参数含义与 executeAgentTurn 内部过滤一致，调用方应原样传入本轮 request 的对应字段。
	 */
	getEnabledToolNamesForPrompt(
		agentId: string,
		agentGraph?: AgentGraph,
		toolsetsOverride?: string[],
		hardPermission?: IHardPermissionPolicy,
		excludedTools?: readonly string[],
		allowedTools?: readonly string[],
	): Promise<string[]>;

	/**
	 * 解析某次 turn 请求应生效的 hardPermission 策略（work/plan mode 驱动）。
	 * 供调用方（agentDriverService）在组装 Prompt 阶段与 executeAgentTurn 内部
	 * 使用同一套 hardPermission，保证 getEnabledToolNamesForPrompt 的过滤结果
	 * 与真正下发的工具 schema 一致。
	 */
	_resolveHardPermission(request: IAgentTurnRequest): IHardPermissionPolicy | undefined;

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
