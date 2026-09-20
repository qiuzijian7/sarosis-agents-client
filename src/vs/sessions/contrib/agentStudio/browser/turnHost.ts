/*---------------------------------------------------------------------------------------------
 *  Turn host 面 —— executor 内部函数参数的窄接口（阶段 4 / 方案 C）
 *
 *  为什么放在 `browser/` 而不是 `common/`：
 *  `UserMessageEnricher` 位于 `browser/messageEnrichment/`，`common/` 不允许反向
 *  依赖 `browser/`，故本模块只能落在 browser 层。
 *
 *  为什么不直接 import `AgentOSService` 类型复用：
 *  `agentOSService.ts:212` 已 import 本 executor 模块，反向 import 会构成循环
 *  依赖 —— 这正是当初 `host: any` 的由来。
 *
 *  ⚠ 适用边界（务必先读）：
 *  宿主 `AgentOSService` 上有 25 个成员是 `private`（如 `_logService:225`、
 *  `_durableContext:287`），而 TS 的 `private` **不参与结构类型匹配**。因此本文件
 *  的接口只能用于「实参本身已是 `any`」的**内部函数参数**位置 —— `any` 可赋给
 *  任意类型，不触发可见性检查。
 *
 *  把顶层入口 `executeAgentTurnDirect(host: any, …)` 也改成这些接口会**编译失败**
 *  （调用点 `agentOSService.ts:2619` 传的是 `this`，实测报 TS2345：
 *   `Property '_logService' is private in type 'AgentOSService' but not in type …`）。
 *  那一步需要先放开宿主可见性或让宿主 `implements` 共享接口，属独立任务。
 *
 *  纪律沿用 `turnIterationGate.ts` 的 `IGateHost`：**只声明实际用到的成员**，
 *  不拖入整个宿主类型。
 *--------------------------------------------------------------------------------------------*/

import type { IAgentTurnRequest, IChatStreamDelta, IMemoryProvider, IModelProvider, IModelSelection, ISandboxViolationInfo, IToolCallInfo, IToolDefinition, SandboxConfirmationDecision } from '../common/providers.js';
import type { AgentGraph } from '../common/agentGraph.js';
import type { IHardPermissionPolicy } from '../common/toolPermission.js';
import type { IAskRoutingContext } from '../common/askRouting.js';
import type { IForkContext } from '../common/forkContext.js';
import type { DurableContextManager } from '../common/durableContextMiddleware.js';
import type { DelegationLedgerManager } from '../common/delegationLedger.js';
import type { SubagentLimitMiddleware } from '../common/subagentLimitMiddleware.js';
import type { ToolApprovalService } from './toolExecutionGuard.js';
import type { IConfirmationData } from '../../../browser/agentChat/agentChatTypes.js';
import type { UserMessageEnricher } from './messageEnrichment/userMessageEnricher.js';
import type { AgentConfigDeps } from './agentConfigReader.js';
import type { ILogService } from '../../../../platform/log/common/log.js';

/**
 * 日志面 —— 直接复用宿主的 `ILogService`，而非结构化窄化。
 *
 * 为什么不像 `IGateHost` 那样只声明 `info` / `warn`：
 * `initTurnContext` 里除 info/warn 外还用到 `error`（`:337`），并且把
 * `host._logService` **整体**传给 `injectMemoryContext`（`:479`），后者形参要求
 * 完整 `ILogService`（含 `_serviceBrand` / `dispose` / 5 个其它成员）。
 * 窄接口在这两处都会编译失败 —— 实测 TS2339 + TS2740。
 */
export interface ITurnHostLog {
	readonly _logService: ILogService;
}

/**
 * 模型与工具解析面 —— 轮次启动阶段决定「用哪个 provider、带哪些工具」。
 */
export interface ITurnHostModelTools {
	_getActiveModelProvider(): IModelProvider | undefined;
	getActiveModelSelection(): IModelSelection | undefined;

	/**
	 * 降级为直聊：无可用 ModelProvider 时的兜底出口。
	 *
	 * 宿主实现是 `public *_fallbackToDirectChat(…): Generator<IChatStreamDelta, any, any>`，
	 * 此处保留 `unknown` 返回值 —— 调用点 `agentTurnExecutor.ts:328` 只 `yield*`，不读返回值。
	 */
	_fallbackToDirectChat(request: IAgentTurnRequest): Generator<IChatStreamDelta, unknown, unknown>;

	_resolveHardPermission(request: IAgentTurnRequest): IHardPermissionPolicy | undefined;

	_getEnabledTools(
		agentId: string,
		agentGraph?: AgentGraph,
		toolsetsOverride?: string[],
		hardPermission?: IHardPermissionPolicy,
		...rest: readonly unknown[]
	): Promise<IToolDefinition[]>;

	/**
	 * MCP 工具首轮等待标志 —— 可写，executor 在 `:351` 置 true 以保证只等一次。
	 */
	_mcpToolsInitialWaitDone: boolean;

	_waitForMcpTools(
		agentId: string,
		enabledTools: IToolDefinition[],
		timeoutMs: number,
	): Promise<IToolDefinition[]>;
}

/**
 * 上下文注入面 —— 记忆、耐久上下文、委派台账、用户消息富化。
 */
export interface ITurnHostContext {
	getActiveMemoryProvider(): IMemoryProvider | undefined;

	/** 已注入过上下文的会话集合（executor 直接读，用于判定首轮注入）。 */
	readonly _injectedSessions: Set<string>;
	readonly _metaInjectedSessions: Set<string>;

	readonly _durableContext: DurableContextManager;
	readonly _delegationLedger: DelegationLedgerManager;

	/** 未配置富化器时为 `undefined` —— 调用点 `:529` 有显式判空。 */
	readonly _userMessageEnricher: UserMessageEnricher | undefined;

	/**
	 * 取走本轮被标记改动过的文件（消费即清空）。
	 * 宿主形参名为 `sessionKey`，executor 传的是 `request.agentId`（`:449`）。
	 */
	_consumeStashedFiles(sessionKey: string): string[];

	/**
	 * 刷新工作记忆内容。可选成员 —— 调用点 `:539` 用 `?.()` 保护。
	 */
	_refreshWorkingMemoryContent?(agentId?: string, sessionId?: string): Promise<void>;

	/**
	 * 刷新知识库目录摘要注入（kb_overview 标签，L1 常驻目录摘要）。
	 * 可选成员 —— 调用点用 `?.()` 保护。
	 */
	_refreshKbOverviewContent?(): Promise<void>;

	/**
	 * ⚠ 修复历史缺陷（原为 `host._currentAgent`，宿主上从未声明 → 恒 `undefined`）。
	 *
	 * Agent 注册表的同步查询入口，宿主构造时接好（`agentOSService.ts:549-551`，
	 * 底层是 `_studioService?.getAgentsSync?.()`，未注入时返回 `undefined`）。
	 * 供 `initTurnContext` 按 `request.agentId` 取当前 Agent 配置，喂给
	 * `enrichWithStats` 的 `ctx.agent` —— `SystemReminderTagProvider` 靠它判定
	 * 只读 agent（`builtinTagProviders.ts:319`）。
	 */
	readonly _configReaderDeps: AgentConfigDeps;
}

/**
 * `initTurnContext` 实际读到的完整 host 面（由上述三块组合）。
 *
 * 成员清单从调用点归纳（`agentTurnExecutor.ts:324-576`，17 个 distinct 成员），
 * 而非从宿主类倒推 —— 避免把未使用的宿主成员固化进契约。
 */
export type ITurnInitHost = ITurnHostLog & ITurnHostModelTools & ITurnHostContext;

/**
 * 轮次级可变计数器与缓存面 —— 宿主上跨轮累积的统计/去重状态。
 *
 * 全部为**可写**属性（executor 直接 `host._totalInputTokens += n`），故不加
 * `readonly`；Map 容器本身是 `readonly` 引用但内容可变，按宿主原始声明对齐。
 */
export interface ITurnHostCounters {
	_totalInputTokens: number;
	_totalOutputTokens: number;
	_totalCachedTokens: number;
	_compressionCount: number;
	_compressionIneffectiveCount: number;
	_compressionBeforeTokens: number;
	_compressionAfterTokens: number;
	_lastCompressionTime: number;
	_lastHardPruneBaselineTokens: number;
	_lastAllEnabledToolNames: Set<string>;
	readonly _lastRealPromptTokensByAgent: Map<string, number>;
	readonly _lastAssistantAtByAgent: Map<string, number>;
	readonly _lastResponseIdBySession: Map<string, string>;
	readonly _injectedSessions: Set<string>;
	readonly _metaInjectedSessions: Set<string>;
	readonly _mcpToolsInitialWaitDone: Set<string>;
}

/**
 * 生命周期与并发控制面 —— 中止信号、轮次注册表、子 agent 限流。
 */
export interface ITurnHostLifecycle {
	_loopAbortController: AbortController | undefined;
	readonly _activeTurnControllers: Map<string, AbortController>;
	readonly _subagentLimitMw: SubagentLimitMiddleware;
	readonly _delegationLedger: DelegationLedgerManager;
	readonly _durableContext: DurableContextManager;
	_turnKey(agentId: string | undefined, sessionId: string | undefined): string;
	_getOrCreateConversationId(sessionId: string | undefined): string;
	_generateHexId(): string;
	_scheduleSave(): void;
}

/**
 * 沙箱确认与工具审批面 —— 工具违规拦截后的人工确认回路。
 */
export interface ITurnHostSandbox {
	readonly _approvalService: ToolApprovalService;
	_isToolCallConfirmationEnabled(): boolean;
	_isSandboxViolation(result: { metadata?: { sandboxViolation?: ISandboxViolationInfo } }): boolean;
	_buildSandboxConfirmationCard(toolName: string, v: ISandboxViolationInfo): IConfirmationData;
	_awaitSandboxConfirmation(confirmationId: string): Promise<SandboxConfirmationDecision>;
	_mapDecisionToCardStatus(decision: SandboxConfirmationDecision): 'approved' | 'rejected' | 'cancelled';
	_reExecuteAfterSandbox(tc: IToolCallInfo, agentId: string, worktreePath: string | undefined, signal: AbortSignal | undefined, decision: SandboxConfirmationDecision, v: ISandboxViolationInfo): Promise<{ toolCallId: string; content: any; success: boolean }>;
	_clearSandboxBypassRoots(): void;
}

/**
 * 计划编排、记忆与工具执行面 —— 主循环体内的重活入口。
 */
export interface ITurnHostExecution {
	_getEnabledTools(agentId: string, agentGraph?: AgentGraph, toolsetsOverride?: string[], hardPermission?: IHardPermissionPolicy, excludedTools?: readonly string[], allowedTools?: readonly string[]): Promise<IToolDefinition[]>;
	_executeToolCalls(toolCalls: IToolCallInfo[], agentId: string, worktreePath?: string, abortSignal?: AbortSignal, askRouting?: IAskRoutingContext, agentSessionId?: string): Promise<Array<{ toolCallId: string; content: any; success: boolean; metadata?: Record<string, unknown> }>>;
	_observeToolResult(agentId: string, toolResult: { toolCallId: string; content: any; success: boolean; toolName?: string }, sessionId?: string): void;
	_consumeStashedFiles(sessionKey: string): string[];
	_resolveContextWindow(provider: IModelProvider, modelId: string): Promise<number>;
	_refreshWorkingMemoryContent(agentId?: string, sessionId?: string): Promise<void>;
	_refreshKbOverviewContent(): Promise<void>;
	_awaitPlanApproval(confirmationId: string, timeoutMs?: number): Promise<'approved' | 'rejected'>;
	_orchestratePlan(request: IAgentTurnRequest, args: { plan_summary?: string; next_mode?: string; idempotencyKey?: string }, tasks: Array<{ title: string; description: string; files?: string[]; complexity?: string; suggestedRole?: string; dependencies?: string[]; deliverable?: string }>, _toolCallId: string): AsyncGenerator<IChatStreamDelta>;
	_readPlanFile(filePath: string): Promise<string>;
	_writePlanFile(filePath: string, content: string): Promise<void>;
	_retrieveCompactionContext(provider: any, req: { agentId: string; sessionId: string; middle: ReadonlyArray<any>; contextWindow: number; budget: number }): Promise<{ context: string; tokens: number; source: string } | null>;
	_retrieveContextOnly(provider: any, agentId: string, sessionId: string, middle: ReadonlyArray<any>, budget: number): Promise<{ context: string; tokens: number; source: string } | null>;
	_storeTurnObservations(provider: any, agentId: string, sessionId: string, messages: ReadonlyArray<any>): Promise<void>;
	getActiveMemoryProvider(): IMemoryProvider | undefined;
	_executeToolCallsParallelStreaming(toolCalls: IToolCallInfo[], agentId: string, worktreePath?: string, abortSignal?: AbortSignal, askRouting?: IAskRoutingContext, agentSessionId?: string): AsyncGenerator<{ toolCallId: string; content: any; success: boolean; metadata?: Record<string, unknown> }, void, unknown>;
	_tryExtractToolCallsFromText(text: string, thinkingContent?: string, enabledTools?: IToolDefinition[]): IToolCallInfo[];
	_adaptModelDelta(delta: any): IChatStreamDelta;
	_setCurrentModel(provider: IModelProvider | undefined, modelId: string | undefined): void;
	_estimateMessagesTokens(messages: ReadonlyArray<any>): number;
	_injectRetrievalSystemMessage(messages: any[], context: string, _source: string): any[];
	_resolveHardPermissionForWorkMode(workMode: string): IHardPermissionPolicy | undefined;
	_getSarosRoot(): string;
	readonly _currentWorkspaceId: string;

	/**
	 * 以下两个成员 executor 并不直接读，而是把**整个 host** 传给下游窄接口时被要求：
	 * - `_lastForkContextBySession` → `computeForkContext` 的 host 面（`:2515`）
	 * - `_modelStreamTimeoutPolicy` → `IStreamHost`（`turnLlmStream.ts:56`，`:2790`/`:3147`）
	 *
	 * 形状照抄下游声明而非宿主实现（宿主是 `TimeoutPolicy`），保持与 `IStreamHost`
	 * 结构兼容即可，避免把 `resilience.ts` 拖进本模块的依赖面。
	 */
	readonly _lastForkContextBySession: Map<string, IForkContext>;
	readonly _modelStreamTimeoutPolicy: { firstTokenTimeout?: number;[key: string]: unknown };
}

/**
 * `executeAgentTurnDirect` 实际读到的**完整** host 面（64 个 distinct 成员）。
 *
 * ⚠ 使用方式（读文件头「适用边界」）：宿主 26 个成员是 `private`，`private` 不参与
 * 结构类型匹配，故顶层签名 `executeAgentTurnDirect(host: any, …)` **必须保持 `any`**，
 * 由唯一调用点 `agentOSService.ts` 做一次显式转型收口。本类型的价值在于让
 * 函数体内 64 个成员访问全部获得编译期检查，而不是去约束入参。
 */
export type ITurnHost = ITurnInitHost & ITurnHostCounters & ITurnHostLifecycle & ITurnHostSandbox & ITurnHostExecution;
