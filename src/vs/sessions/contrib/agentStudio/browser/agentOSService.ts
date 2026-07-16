/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IAgentOSService, IAgentOSDashboardStats, IDashboardMetricsSnapshot, IDailyBucket } from '../common/agentOS.js';
import {
	IModelProvider, IModelSelection, ModelAuthStatus,
	IMemoryProvider, IToolProvider, IPlanningProvider,
	IExecutionProvider, IRetrievalProvider, IKanbanProvider,
	IAgentTurnRequest, IChatStreamDelta, ISlotRegistry,
	IToolDefinition, IToolCallInfo, IToolResult, IModelOptions,
	IToolApprovalHandler,
	SandboxConfirmationDecision, ISandboxViolationInfo,
} from '../common/providers.js';
import type { IConfirmationData } from '../../../browser/agentChat/agentChatTypes.js';
import { SlotRegistry } from './slotRegistry.js';
import {
	withStreamTimeout,
	type TimeoutPolicy,
} from '../common/resilience.js';
import {
	appendMessages,
	insertMessages,
	compactMessages,
	createInitialRunState,
	reduceRunState,
	detectToolCallLoop,
	classifyIncompleteTurn,
	resolveIncompleteTurnRetryInstruction,
	incompleteTurnDiscardReason,
	incompleteTurnRetryLimit,
	isTransientStreamError,
	TRANSIENT_ERROR_MAX_RETRIES,
	TRANSIENT_ERROR_BASE_DELAY_MS,
	TRANSIENT_ERROR_BACKOFF_FACTOR,
	TRANSIENT_ERROR_MAX_DELAY_MS,
	snapshotRunState,
	prepareResumeRunState,
	type AgentRunMessage,
	type AgentRunState,
	type AgentRunStateSnapshot,
} from '../common/agentRunState.js';
import {
	AgentGraph,
	AgentCommand,
	END_NODE,
	TRANSFER_TO_AGENT_TOOL,
	buildHandoffCommand,
	applyCommandToState,
	computeNextNode,
} from '../common/agentGraph.js';
import { applyHardPermission, planModeHardPermission, type IHardPermissionPolicy } from '../common/toolPermission.js';
import { buildForkContext, prefixCacheAligned, type IForkContext } from '../common/forkContext.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import {
	ToolsetPriority, getToolsetForTool,
	getToolsetPriority, isBridgeTool,
	TOOL_SEARCH_BRIDGE_TOOLS,
} from '../common/toolsetConfig.js';
import {
	assembleToolDefs, IAssemblyResult, DEFAULT_TOOL_SEARCH_CONFIG,
	IToolSearchConfig,
} from '../common/toolSearchAssembler.js';
import {
	dispatchBridgeTool, buildDispatcherContext, IDispatcherContext,
} from '../common/toolSearchDispatcher.js';
import {
	correctSchemaReferences,
} from '../common/schemaCorrector.js';
import {
	detectFocusModeWithProbe, IFocusModeResult, IFileProbe,
} from '../common/focusMode.js';

import { DashboardFileStorage } from './dashboardFileStorage.js';
import {
	repairToolName,
	repairToolArguments,
	coerceArgsToSchema,
	sanitizeToolError,
	deduplicateToolCalls,
	limitToolResultSize,
	safeStringifyToolResult,
	formatToolErrorResult,
	formatToolNotFoundResult,
	classifyArgumentValidity,
	buildValidToolNameSet,
	buildToolSchemaMap,
	MAX_INVALID_TOOL_RETRIES,
	MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES,
	shouldParallelizeToolBatch,
	StreamingToolCallAssembler,
	PHANTOM_TOOL_NAMES,
} from './toolCallUtils.js';
import {
	sanitizeAssistantVisibleText,
	sanitizeToolResultText,
	isEntirelyToolCallContent,
} from '../common/assistantVisibleText.js';
import {
	executeWithRetryAndTimeout,
	getTimeoutForTool,
	ToolApprovalService,
	ToolExecutionTracker,
} from './toolExecutionGuard.js';
import {
	SurroundingsRemover,
} from '../common/toolExtractionUtils.js';
import {
	DelegationLedgerManager,
} from '../common/delegationLedger.js';
import {
	DurableContextManager, buildDurableContextSystemMessage,
	type DurableContextSnapshot,
} from '../common/durableContextMiddleware.js';
import {
	SubagentLimitMiddleware,
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
} from '../common/subagentLimitMiddleware.js';
import {
	TokenUsageLedger,
	type SubagentTokenUsage,
} from '../common/subagentTokenCollector.js';

import { AGUIChatMessageBuilder } from '../common/adapters/aguiAdapter.js';
import { ContextManager, RETRIEVAL_COMPACTION_ENABLED, RETRIEVAL_BUDGET_RATIO } from '../common/contextManager.js';
import type { ChatMessage } from '../common/types.js';

// MCP 工具不直发 schema（会导致 API 400），仅通过 tool_search 桥接发现。
// 系统提示词（agentDriverService.ts）中已有 MCP 工具摘要指引。

// ─── Agent OS Service Implementation ────────────────────────────────────

export class AgentOSService extends Disposable implements IAgentOSService {

	declare readonly _serviceBrand: undefined;

	private readonly _slotRegistry: SlotRegistry;
	private readonly _modelProviders: IModelProvider[] = [];
	private _activeSelection: IModelSelection | undefined;
	private readonly _logService: ILogService;
	private _currentWorkspaceId: string = '';

	// ─── Tool Execution Guard (P0 优化) ───────────────────────
	private readonly _approvalService = new ToolApprovalService();
	private readonly _executionTracker = new ToolExecutionTracker();

	// ─── 沙箱确认（安全沙箱受限→暂停等待用户决策）──────────────
	// 存放进行中的沙箱确认：confirmationId → resolve 回调。
	private readonly _pendingSandboxConfirmations = new Map<string, (decision: SandboxConfirmationDecision) => void>();

	/**
	 * Agent Loop 级别的 AbortController — 用于取消整个循环。
	 * @deprecated 保留作单窗口兼容与"最近 turn"兜底；多窗口并发请用 _activeTurnControllers。
	 */
	private _loopAbortController: AbortController | undefined;

	/**
	 * Per-turn AbortController 表 —— 支持多聊天窗口/多 Session 并发执行时的取消隔离。
	 * key = `${agentId}::${sessionId}`（见 _turnKey）。
	 * executeAgentTurn 进入时按 turnKey 建一个 controller，finally 时删除；
	 * cancelAgentLoop(agentId, sessionId) 按 turnKey 精确取消，不影响其他窗口。
	 */
	private readonly _activeTurnControllers = new Map<string, AbortController>();

	// ─── Delegation Ledger + Durable Context（借鉴 deer-flow）───────────
	/** Tracks all sub-agent delegations with live status updates. */
	private readonly _delegationLedger = new DelegationLedgerManager();
	/** Survives summarization compression — injected as hidden system message before each LLM call. */
	private readonly _durableContext = new DurableContextManager();
	/** Applied before tool execution to truncate excess sub-agent calls. */
	private readonly _subagentLimitMw = new SubagentLimitMiddleware(DEFAULT_MAX_CONCURRENT_SUBAGENTS);
	/** Session-level token usage aggregation across all sub-agents. */
	private readonly _tokenUsageLedger = new TokenUsageLedger();

	// ─── Tool Search 三层分离状态（Assembly + Dispatcher）─────────────
	// 参考 Hermes-Agent：assembly 结果缓存 + dispatcher context 缓存
	// 避免每次工具调用都重建 catalog
	/** 最近一次 Assembly 结果（含 deferredDefs） */
	private _lastAssembly: IAssemblyResult | undefined;
	/** 最近一次 Dispatcher 上下文（含 catalog + scopedNames） */
	private _lastDispatcherCtx: IDispatcherContext | undefined;
	/** 最近一次全量已启用工具名集合（不受 MAX_VISIBLE_TOOLS 截断影响），供白名单过滤用 */
	private _lastAllEnabledToolNames: Set<string> = new Set();

	// ─── Tool Defs LRU 缓存（对齐 Hermes-Agent `model_tools._TOOL_DEFS_CACHE_MAX = 8`）──
	// 2026-07-03 改造：Map-based LRU + 多维缓存键
	// 缓存键维度：agentId | registryGeneration | configFingerprint | contextWindow
	// registryGeneration: 注册表版本（MCP 重连、plugin 加载时递增）→ 对齐 Hermes `registry._generation`
	// configFingerprint: config mtime+size 指纹 → 对齐 Hermes `cfg_fp`
	// contextWindow: 模型上下文窗口 → 模型切换时自动失效
	private static readonly TOOL_DEFS_CACHE_MAX = 8;
	private _cachedToolDefs = new Map<string, IToolDefinition[]>();

	/**
	 * Fork 前缀缓存（MiMo ForkContext）：每个会话最近一次迭代计算出的「冻结前缀」
	 * (system + tools 指纹)。fork 会话 / 子 agent 在构造请求时据此对齐父级前缀 → 命中
	 * provider prompt cache。`getForkContext(sessionId)` 供 forkAgentSession 抓取父级
	 * 冻结前缀用。键为 sessionId；未分叉会话也有值（自身前缀），但不影响缓存语义。
	 */
	private readonly _lastForkContextBySession = new Map<string, IForkContext>();

	/** P1: 上一轮 LLM 回传的真实 prompt token，按键 agentId 持久化跨 turn 传递。
	 *  compressContext 优先用它做触发判定（取代低估的 char/4 粗估），
	 *  首次调用=0 时自动退回粗估。捕获点在 L1773 usage delta。 */
	private _lastRealPromptTokensByAgent = new Map<string, number>();

	/**
	 * 注册表版本号 — 当 MCP/builtin 工具集变化时递增，触发缓存失效。
	 * 对齐 Hermes-Agent `registry._generation`。
	 * 默认 0，注册表首次就绪后设为 1，工具集变化时通过 `_bumpToolDefsCache()` 递增。
	 */
	private _registryGeneration = 0;

	/**
	 * config 文件指纹（mtime + size）— config 修改时变化，触发缓存失效。
	 * 对齐 Hermes-Agent `cfg_fp`。
	 * 默认空，调用 `_getConfigFingerprint()` 时实时计算。
	 */

	/**
	 * 当前 agent loop 使用的模型 provider 和 modelId。
	 * 由 agent loop 入口设置（对齐 Hermes `_resolve_active_context_length` 实时查表）。
	 */
	private _currentModelProvider: IModelProvider | undefined;
	private _currentModelId: string | undefined;

	/**
	 * Focus 模式检测结果缓存（对齐 Hermes `auto` / `focus` 编码姿态切换）。
	 * 工作区不变时复用，避免每次 _getEnabledTools 都重新检测。
	 */
	private _focusModeCache: { workspaceKey: string; result: IFocusModeResult } | undefined;

	// 注：AGUIChatMessageBuilder 原本是实例字段 _chatMessageStream，但它是 turn 级状态
	// （每个 executeAgentTurn 重建），多 session/多 agent 并发执行时会被并发 turn 互相覆盖
	// → 跨 turn 流式消息错乱。改为 _executeWithFallbackDirectly 内的局部变量 chatMessageStream
	// （见 turn 内定义 + 流循环内使用），彻底消除此竞态。语义不变。

	// ─── 抓包对齐的会话 id 状态（按 sessionId 隔离）────────────────────────
	// 抓包证据（CodeBuddy IDE /v2/chat/completions）：
	//   - X-Conversation-ID 会话级稳定不变  → 同一 sessionId 复用同一 conversationId
	//   - X-Conversation-Request-ID 每次 API 调用都换  → 每轮 iteration 生成新 requestId
	//   - 请求体 previous_response_id = 上一次响应流 chunk 的 id  → 每轮捕获并记下，
	//     下一轮带上，让服务端做链式上下文衔接
	// 历史串台 bug 根因：仅用单一 sessionId 当所有 id，服务端 KV 缓存按 conversation-id
	// 跨会话碰撞。此处把三个 id 分离：conversationId 稳定、requestId 每轮新。
	/** sessionId → 稳定 conversationId（会话内不变） */
	private readonly _conversationIdBySession = new Map<string, string>();
	/** sessionId → 上一次响应流的 id（作为下一轮请求的 previous_response_id） */
	private readonly _lastResponseIdBySession = new Map<string, string>();

	// ─── Episodic 自动提取管线状态 ──────────────────────────────────────────
	// 对齐 AgentMemory 的 Working→Episodic pipeline：对话轮次达到阈值后，后台调用 LLM
	// 从最近对话中提取结构化长期记忆。不再完全依赖 LLM 主动调 memory_remember。
	/** agentId → 对话轮次计数（达到 Episodic_THRESHOLD 后触发提取并清零） */
	private readonly _l1ConversationCountByAgent = new Map<string, number>();
	/** Episodic 提取的对话轮次阈值（每 N 轮触发一次） */
	private static readonly EPISODIC_EXTRACTION_THRESHOLD = 3;

	// ─── Semantic 提取管线状态 ──────────────────────────────────────────
	// 对齐 AgentMemory Semantic：per-agent timer，Episodic 完成后延迟触发场景级摘要提取。
	/** agentId → Semantic 定时器（Episodic 完成后延迟触发） */
	private readonly _l2TimersByAgent = new Map<string, ReturnType<typeof setTimeout>>();
	/** Semantic 延迟触发时间（ms，Episodic 完成后等待此时间再触发 Semantic） */
	private static readonly SEMANTIC_DELAY_AFTER_EPISODIC_MS = 30_000; // 30 秒
	/** Semantic 最小间隔（ms，两次 Semantic 之间的最小间隔） */
	private static readonly SEMANTIC_MIN_INTERVAL_MS = 300_000; // 5 分钟
	/** agentId → 上次 Semantic 执行时间（epoch ms） */
	private readonly _l2LastRunTime = new Map<string, number>();

	// ─── Procedural 生成管线状态 ──────────────────────────────────────────
	// 对齐 AgentMemory Procedural：global mutex (concurrency=1) + pending flag dedup。
	/** Procedural 是否正在运行（全局互斥） */
	private _proceduralRunning = false;
	/** Procedural 是否有待处理请求（dedup：运行中再来请求只设 flag，不重复入队） */
	private _proceduralPending = false;
	/** 压缩冷却期：上次压缩时间戳。跨用户消息持久化，避免频繁压缩。 */
	private _lastCompressionTime: number = 0;
	/** 检索式压缩：已外置到记忆的 middle 消息内容哈希集合（按 sessionId），
	 *  避免每次压缩重复写入同一批对话导致记忆无限膨胀。 */
	private _storedMiddleHashes = new Map<string, Set<string>>();
	private static readonly COMPRESSION_COOLDOWN_MS = 60_000;

	// ─── Tool-Use Enforcement（对齐 Hermes TOOL_USE_ENFORCEMENT_GUIDANCE）──────────
	// 对 DeepSeek / GPT / Gemini 等需要显式引导的模型族，自动在 system prompt 末尾
	// 注入工具使用强制指令。模型名包含列表中子串即触发。ID 匹配幂等（检测 TOOL_USE_ENFORCEMENT 标记）。
	private static readonly TOOL_USE_ENFORCEMENT_MODELS = ['deepseek', 'gpt-', 'gemini', 'gemma', 'grok', 'glm', 'qwen'];
	private static readonly TOOL_USE_ENFORCEMENT_GUIDANCE = [
		'<!-- TOOL_USE_ENFORCEMENT -->',
		'# Tool-use enforcement',
		'You MUST use your tools to take action — do not describe what you would do',
		'or plan to do without actually doing it. When you say you will perform an',
		'action (e.g. "I will run the tests", "Let me check the file", "I will create',
		'the project"), you MUST immediately make the corresponding tool call in the same',
		'response. Never end your turn with a promise of future action — execute it now.',
		'Keep working until the task is actually complete. Do not stop with a summary of',
		'what you plan to do next time. If you have tools available that can accomplish',
		'the task, use them instead of telling the user what you would do.',
		'Every response should either (a) contain tool calls that make progress, or',
		'(b) deliver a final result to the user. Responses that only describe intentions',
		'without acting are not acceptable.',
	].join('\n');
	/** MCP 工具初始等待标志：仅在首次 executeAgentTurn 时等待 MCP 服务器连接。
	 *  避免对没有 MCP 服务器的用户在每条消息上都延迟。 */
	private _mcpToolsInitialWaitDone = false;

	// ─── Dashboard 统计追踪 ──────────────────────────────────────────
	// 在 executeAgentTurn 流程中实时累积，供 IAgentStudioDashboardService 读取。
	private _totalInputTokens = 0;
	/** P7: 注入幂等去重 — 同一 session 只注入一次 agentmemory-context */
	private _injectedSessions = new Set<string>();
	/** P8: 文件路径暂存 — 工具执行时收集涉及的文件路径，下一轮 loadContext 时批量 enrich */
	private _stashedFiles = new Map<string, Set<string>>();
	private static readonly MAX_STASHED_FILES = 20;
	private _totalOutputTokens = 0;
	private _totalCachedTokens = 0;
	private _compressionCount = 0;
	private _compressionIneffectiveCount = 0;
	private _compressionBeforeTokens = 0;
	private _compressionAfterTokens = 0;
	private readonly _toolCallCounts = new Map<string, number>();
	private _l1ExtractionCount = 0;
	private _l2ExtractionCount = 0;
	private _l3ExtractionCount = 0;

	/** Dashboard 文件存储实例（IFileService+JSON，替代 SQLite 原生模块） */
	private _dashboardStorage: DashboardFileStorage | undefined;

	/** 取（或惰性创建）某会话的稳定 conversationId。无 sessionId 时回退到随机串。 */
	private _getOrCreateConversationId(sessionId: string | undefined): string {
		const key = sessionId || '__nosession__';
		let cid = this._conversationIdBySession.get(key);
		if (!cid) {
			// 32 位 hex，与抓包 X-Conversation-ID 形态一致
			cid = this._generateHexId();
			this._conversationIdBySession.set(key, cid);
		}
		return cid;
	}

	/** 生成 32 位十六进制 id（用于 conversationId / requestId）。 */
	private _generateHexId(): string {
		let s = '';
		for (let i = 0; i < 8; i++) {
			s += Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
		}
		return s;
	}

	// Events
	private readonly _onDidChangeModelProviders = this._register(new Emitter<void>());
	readonly onDidChangeModelProviders = this._onDidChangeModelProviders.event;

	private readonly _onDidChangeAvailableModels = this._register(new Emitter<void>());
	readonly onDidChangeAvailableModels = this._onDidChangeAvailableModels.event;

	constructor(
		@ILogService logService: ILogService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly _pathService: IPathService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._logService = logService;
		this._slotRegistry = this._register(new SlotRegistry(logService));

		// 获取当前工作区 ID 用于记忆元数据
		const ws = this._workspaceContextService.getWorkspace();
		this._currentWorkspaceId = ws.folders.length > 0 ? ws.folders[0].name : '';

		// 注册沙箱确认命令：原生 chat 卡片按钮点击 → 派发此命令 → resolve pending promise，
		// 解除 agent loop 的暂停（对齐 void 的 confirmed.promise 模式）。
		this._register(CommandsRegistry.registerCommand(
			'agentStudio.confirmationAction',
			(_accessor, confirmationId: string, decision: string) => {
				const resolve = this._pendingSandboxConfirmations.get(confirmationId);
				if (!resolve) {
					this._logService.warn(`[AgentOS] No pending sandbox confirmation for id=${confirmationId}`);
					return;
				}
				this._pendingSandboxConfirmations.delete(confirmationId);
				const mapped = this._mapConfirmationButtonToDecision(decision);
				this._logService.info(`[AgentOS] Sandbox confirmation ${confirmationId} → ${mapped}`);
				resolve(mapped);
			},
		));

		// Bridge the OS-level ModelProvider list and active selection
		// into the SlotRegistry so that ExecutionProviders can access them
		// via slots.getActiveModelProvider() / slots.getActiveModelSelection()
		this._slotRegistry.setModelProviderBridge({
			getModelProviders: () => this._modelProviders,
			getActiveModelSelection: () => this._activeSelection,
		});

		// Init Dashboard file storage and load persisted stats
		this._initDashboardStorage().catch(err => {
			this._logService.warn('[AgentOS] Failed to init dashboard storage:', err);
		});

		// 2026-07-03: 注册 Tool Defs 缓存失效监听（对齐 Hermes `registry._generation`）
		// 当 MCP/builtin 工具集动态变化时递增 _registryGeneration
		this._registerToolSetChangeListeners();

		// Save stats on dispose
		this._register({
			dispose: () => {
				if (this._saveTimer) { clearTimeout(this._saveTimer); }
				this._saveDashboardStats().catch(() => { /* best effort */ });
			},
		});
	}

	// ─── Tool Execution Guard API (P0) ────────────────────────────────

	/**
	 * 注册工具审批 UI Handler。
	 * 由 WebView 或 Chat UI 层调用，提供用户确认能力。
	 */
	setToolApprovalHandler(handler: IToolApprovalHandler): void {
		this._approvalService.setApprovalHandler(handler);
		this._logService.info('[AgentOS] Tool approval handler registered');
	}

	// ─── 沙箱确认（安全沙箱受限→暂停等待用户决策）──────────────

	private _mapConfirmationButtonToDecision(buttonId: string): SandboxConfirmationDecision {
		switch (buttonId) {
			case 'allow_once': return SandboxConfirmationDecision.AllowOnce;
			case 'allow_workspace': return SandboxConfirmationDecision.AllowWorkspace;
			case 'use_suggested': return SandboxConfirmationDecision.UseSuggested;
			case 'cancel':
			case 'reject':
			case 'deny':
				return SandboxConfirmationDecision.Cancel;
			default:
				this._logService.warn(`[AgentOS] Unknown sandbox confirmation button "${buttonId}" → Cancel`);
				return SandboxConfirmationDecision.Cancel;
		}
	}

	private _mapDecisionToCardStatus(decision: SandboxConfirmationDecision): 'approved' | 'rejected' | 'cancelled' {
		return decision === SandboxConfirmationDecision.Cancel ? 'cancelled' : 'approved';
	}

	/** 工具结果是否因安全沙箱限制而失败 */
	private _isSandboxViolation(result: { metadata?: { sandboxViolation?: ISandboxViolationInfo } }): boolean {
		return !!result.metadata?.sandboxViolation;
	}

	/**
	 * 生成沙箱确认卡片数据（标题 / 说明 / 允许目录 / 建议路径 / 四个按钮）。
	 */
	private _buildSandboxConfirmationCard(toolName: string, v: ISandboxViolationInfo): IConfirmationData {
		const allowedList = v.allowedRoots.length > 0
			? v.allowedRoots.map(r => `  • ${r}`).join('\n')
			: '  （无 — 请确认已正确配置工作区）';
		const lines: string[] = [
			`工具 "${toolName}" 请求访问的路径不在允许的工作区目录内：`,
			`  ${v.requestedPath}`,
			'',
			'当前允许的工作区目录：',
			allowedList,
		];
		if (v.suggestedPath) {
			lines.push('', `建议路径（落在允许根内）：${v.suggestedPath}`);
		}
		const buttons: Array<{ id: string; label: string; primary?: boolean; danger?: boolean }> = [
			{ id: 'allow_once', label: '允许本次', primary: true },
			{ id: 'allow_workspace', label: '允许此工作区' },
		];
		if (v.suggestedPath) {
			buttons.push({ id: 'use_suggested', label: '改用建议路径' });
		}
		buttons.push({ id: 'cancel', label: '取消', danger: true });
		return {
			id: '', // 由调用方填充
			title: '安全沙箱限制',
			message: lines.join('\n'),
			detail: v.resolvedPath !== v.requestedPath ? `解析后: ${v.resolvedPath}` : undefined,
			buttons,
			status: 'pending',
			securityLevel: 'dangerous',
		};
	}

	/**
	 * 等待用户对沙箱受限工具调用的决策。
	 * 调用方（生成器）需先 yield 一个 `confirmation` delta 渲染卡片，
	 * 本方法仅负责挂起循环并在命令 resolve 时返回决策。
	 */
	private _awaitSandboxConfirmation(confirmationId: string): Promise<SandboxConfirmationDecision> {
		return new Promise<SandboxConfirmationDecision>((resolve) => {
			this._pendingSandboxConfirmations.set(confirmationId, resolve);
		});
	}

	/** 把路径参数值从 requestedPath 改写为 suggestedPath（精确匹配才替换） */
	private _rewritePathArgs(args: unknown, requestedPath: string, suggestedPath: string): unknown {
		if (typeof args === 'string') {
			try {
				const parsed = JSON.parse(args) as Record<string, unknown>;
				this._rewritePathInObject(parsed, requestedPath, suggestedPath);
				return JSON.stringify(parsed);
			} catch {
				return args;
			}
		}
		if (args && typeof args === 'object') {
			const cloned = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
			this._rewritePathInObject(cloned, requestedPath, suggestedPath);
			return cloned;
		}
		return args;
	}

	private _rewritePathInObject(obj: Record<string, unknown>, requestedPath: string, suggestedPath: string): void {
		for (const key of Object.keys(obj)) {
			const val = obj[key];
			if (typeof val === 'string' && val === requestedPath) {
				obj[key] = suggestedPath;
			} else if (val && typeof val === 'object') {
				this._rewritePathInObject(val as Record<string, unknown>, requestedPath, suggestedPath);
			}
		}
	}

	/** 持久化「允许此工作区」：把目录追加到当前 Workspace.sandboxRoots */
	private async _persistSandboxRoot(dir: string): Promise<void> {
		const studioService = (this as any)._studioService;
		const wsId = this._currentWorkspaceId;
		if (!studioService || !wsId) { return; }
		try {
			const ws = await studioService.getWorkspace(wsId);
			const existing: string[] = Array.isArray(ws?.sandboxRoots) ? ws.sandboxRoots : [];
			if (existing.includes(dir)) { return; }
			await studioService.updateWorkspace(wsId, { sandboxRoots: [...existing, dir] });
			this._logService.info(`[AgentOS] Persisted sandbox root: ${dir} (workspace=${wsId})`);
		} catch (err) {
			this._logService.warn(`[AgentOS] Failed to persist sandbox root ${dir}:`, err);
		}
	}

	/**
	 * 按用户决策重执行被沙箱拦截的工具调用。
	 * - allow_once: 临时放行精确路径后重执行（finally 移除放行）
	 * - allow_workspace: 持久化目录到 Workspace.sandboxRoots 后重执行
	 * - use_suggested: 把路径参数改写为建议路径后重执行
	 * - cancel: 直接返回失败（操作已取消）
	 */
	private async _reExecuteAfterSandbox(
		tc: IToolCallInfo,
		agentId: string,
		worktreePath: string | undefined,
		signal: AbortSignal | undefined,
		decision: SandboxConfirmationDecision,
		v: ISandboxViolationInfo,
	): Promise<{ toolCallId: string; content: any; success: boolean }> {
		if (decision === SandboxConfirmationDecision.Cancel) {
			return {
				toolCallId: tc.id,
				content: [{ type: 'text', text: '操作已取消：用户拒绝了沙箱受限路径。请改用允许的工作区目录，或选择「允许此工作区」/「改用建议路径」。' }],
				success: false,
			};
		}

		let reCall = tc;
		if (decision === SandboxConfirmationDecision.UseSuggested && v.suggestedPath) {
			reCall = { ...tc, arguments: this._rewritePathArgs(tc.arguments, v.requestedPath, v.suggestedPath) as string };
		}

		const builtin = this._slotRegistry.getToolProviders()
			.find(p => p.id === 'saros.builtin-tools') as (IToolProvider & {
				addSandboxBypassRoot?: (p: string) => void;
				removeSandboxBypassRoot?: (p: string) => void;
			}) | undefined;

		if (decision === SandboxConfirmationDecision.AllowOnce) {
			builtin?.addSandboxBypassRoot?.(v.requestedPath);
		} else if (decision === SandboxConfirmationDecision.AllowWorkspace) {
			const dir = v.requestedPath.replace(/[\\/][^\\/]*$/, '');
			await this._persistSandboxRoot(dir);
		}

		try {
			const results = await this._executeToolCalls([reCall], agentId, worktreePath, signal);
			const r = results[0];
			return { toolCallId: r.toolCallId, content: r.content, success: r.success };
		} finally {
			if (decision === SandboxConfirmationDecision.AllowOnce) {
				builtin?.removeSandboxBypassRoot?.(v.requestedPath);
			}
		}
	}

	getDashboardStats(): IAgentOSDashboardStats {
		const selection = this._activeSelection;
		return {
			totalInputTokens: this._totalInputTokens,
			totalOutputTokens: this._totalOutputTokens,
			totalCachedTokens: this._totalCachedTokens,
			activeModelId: selection?.modelId ?? 'unknown',
			compressionCount: this._compressionCount,
			compressionIneffectiveCount: this._compressionIneffectiveCount,
			compressionBeforeTokens: this._compressionBeforeTokens,
			compressionAfterTokens: this._compressionAfterTokens,
			toolCallCounts: new Map(this._toolCallCounts),
			l1ExtractionCount: this._l1ExtractionCount,
			l2ExtractionCount: this._l2ExtractionCount,
			l3ExtractionCount: this._l3ExtractionCount,
		};
	}

	/**
	 * 查询 Dashboard 时间序列快照（用于趋势图）。
	 */
	async queryDashboardSnapshots(rangeMs: number): Promise<IDashboardMetricsSnapshot[]> {
		if (!this._dashboardStorage?.ready) {
			return [];
		}
		try {
			return await this._dashboardStorage.querySnapshots(rangeMs);
		} catch (err) {
			this._logService.warn('[AgentOS] queryDashboardSnapshots failed:', err);
			return [];
		}
	}

	/**
	 * 查询 Dashboard 按天聚合数据（趋势图降采样）。
	 */
	async queryDashboardDailyBuckets(rangeMs: number): Promise<IDailyBucket[]> {
		if (!this._dashboardStorage?.ready) {
			return [];
		}
		try {
			return await this._dashboardStorage.dailyBuckets(rangeMs);
		} catch (err) {
			this._logService.warn('[AgentOS] queryDashboardDailyBuckets failed:', err);
			return [];
		}
	}

	/**
	 * 采集并保存 Dashboard 时间序列快照。
	 * 调用时机：periodic timer、executeAgentTurn 完成、dispose。
	 */
	async captureDashboardSnapshot(options?: { sessionCount?: number; memoryTotal?: number; graphNodes?: number }): Promise<void> {
		if (!this._dashboardStorage?.ready) {
			return;
		}
		try {
			await this._dashboardStorage.insertSnapshot({
				ts: new Date().toISOString(),
				inputTokens: this._totalInputTokens,
				outputTokens: this._totalOutputTokens,
				cachedTokens: this._totalCachedTokens,
				compressionCount: this._compressionCount,
				memoryTotal: options?.memoryTotal ?? 0,
				graphNodes: options?.graphNodes ?? 0,
				sessionCount: options?.sessionCount ?? 0,
				activeModel: this._activeSelection?.modelId,
			});
		} catch (err) {
			this._logService.warn('[AgentOS] captureDashboardSnapshot failed:', err);
		}
	}

	// ─── Dashboard Stats Persistence ──────────────────────────────────
	// 统计数据持久化到 ~/.saros/dashboard/ (JSON/JSONL 文件)，重启后恢复。
	// 使用 IFileService（通过 IPC 委托主进程），在 EXE 打包后也能正常工作。
	// 防抖保存：统计变更后 2 秒内无新变更才落盘，避免频繁 IO。

	private _saveTimer: ReturnType<typeof setTimeout> | undefined;
	private static readonly SAVE_DEBOUNCE_MS = 2000;

	private async _initDashboardStorage(): Promise<void> {
		try {
			const userHome = await this._pathService.userHome();
			const dirUri = joinPath(userHome, '.saros', 'dashboard');

			this._dashboardStorage = this._register(new DashboardFileStorage(this._fileService, this._logService));
			await this._dashboardStorage.initialize(dirUri);

			// 从文件存储加载已持久化的累计统计
			await this._loadDashboardStats();
		} catch (err) {
			this._logService.warn('[AgentOS] Failed to init dashboard storage:', err);
		}
	}

	private async _loadDashboardStats(): Promise<void> {
		if (!this._dashboardStorage?.ready) {
			return; // 存储未就绪，使用内存默认值
		}
		try {
			const allStats = await this._dashboardStorage.getAllStats();

			this._totalInputTokens = Number(allStats['totalInputTokens']) || 0;
			this._totalOutputTokens = Number(allStats['totalOutputTokens']) || 0;
			this._totalCachedTokens = Number(allStats['totalCachedTokens']) || 0;
			this._compressionCount = Number(allStats['compressionCount']) || 0;
			this._compressionIneffectiveCount = Number(allStats['compressionIneffectiveCount']) || 0;
			this._compressionBeforeTokens = Number(allStats['compressionBeforeTokens']) || 0;
			this._compressionAfterTokens = Number(allStats['compressionAfterTokens']) || 0;
			this._l1ExtractionCount = Number(allStats['l1ExtractionCount']) || 0;
			this._l2ExtractionCount = Number(allStats['l2ExtractionCount']) || 0;
			this._l3ExtractionCount = Number(allStats['l3ExtractionCount']) || 0;

			// 工具调用计数
			try {
				const toolCounts = await this._dashboardStorage.getToolCallCounts();
				for (const [k, v] of Object.entries(toolCounts)) {
					this._toolCallCounts.set(k, v);
				}
			} catch { /* tool call stats may be empty */ }

			this._logService.info('[AgentOS] Dashboard stats loaded from file storage:', {
				tokens: this._totalInputTokens + this._totalOutputTokens + this._totalCachedTokens,
				compression: this._compressionCount,
				tools: this._toolCallCounts.size,
			});
		} catch (err) {
			this._logService.warn('[AgentOS] Failed to load dashboard stats:', err);
		}
	}

	private _scheduleSave(): void {
		if (this._saveTimer) { clearTimeout(this._saveTimer); }
		this._saveTimer = setTimeout(() => {
			this._saveDashboardStats().catch(err => {
				this._logService.warn('[AgentOS] Failed to save dashboard stats:', err);
			});
		}, AgentOSService.SAVE_DEBOUNCE_MS);
	}

	// ─── R1: per-tool-call observe ─────────────────────────────────────────

	/**
	 * R1: 每次工具调用完成后 fire-and-forget 写入观察记录。
	 * 对齐 agentmemory PostToolUse Hook → mem::observe 机制。
	 */
	private _observeToolResult(agentId: string, toolResult: { toolCallId: string; content: any; success: boolean }): void {
		const memProvider = this.getActiveMemoryProvider();
		if (!memProvider) return;
		const summary = typeof toolResult.content === 'string'
			? toolResult.content.slice(0, 200)
			: JSON.stringify(toolResult.content).slice(0, 200);
		void memProvider.writeMemory(agentId, {
			id: `observe-${toolResult.toolCallId}-${Date.now()}`,
			type: 'working',
			content: `Tool result (${toolResult.success ? 'ok' : 'failed'}): ${summary}`,
			metadata: {
				toolCallId: toolResult.toolCallId,
				source: 'tool_observe',
				success: toolResult.success,
			},
			timestamp: Date.now(),
			importance: 3,
		}).catch(() => {});
	}

	// ─── P8: 文件路径暂存 helpers ──────────────────────────────────────────

	/**
	 * 从工具调用参数中提取涉及的文件路径。
	 * 对齐 agentmemory plugin extractFilePaths（FILE_KEYS + FILE_TOOLS）。
	 */
	private _extractFilePathsFromToolCall(tc: IToolCallInfo): string[] {
		const FILE_KEYS = ['filePath', 'file_path', 'path', 'file', 'pattern', 'uri', 'target_file'];
		const FILE_TOOLS = new Set(['read_file', 'write_to_file', 'replace_in_file', 'edit_file',
			'create_file', 'delete_file', 'search_file', 'list_dir', 'execute_command']);
		const paths: string[] = [];
		if (!tc.name || !FILE_TOOLS.has(tc.name)) return paths;
		try {
			const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
			const parsed = JSON.parse(argsStr);
			for (const key of FILE_KEYS) {
				const v = parsed[key];
				if (typeof v === 'string' && v.length > 0) paths.push(v);
			}
		} catch { /* ignore parse errors */ }
		return paths;
	}

	/**
	 * 暂存文件路径到 session stash。
	 * 下一轮 loadContext 时会消费这些路径做批量 enrich。
	 */
	private _stashFilePaths(sessionKey: string, filePaths: string[]): void {
		if (filePaths.length === 0) return;
		let stash = this._stashedFiles.get(sessionKey);
		if (!stash) { stash = new Set(); this._stashedFiles.set(sessionKey, stash); }
		for (const fp of filePaths) stash.add(fp);
		// 限制 stash 大小
		if (stash.size > AgentOSService.MAX_STASHED_FILES) {
			const keep = [...stash].slice(-AgentOSService.MAX_STASHED_FILES);
			stash.clear();
			for (const f of keep) stash.add(f);
		}
	}

	/**
	 * 消费并返回暂存的文件路径（读取后清空 stash）。
	 * 在 loadContext 注入逻辑中调用。
	 */
	private _consumeStashedFiles(sessionKey: string): string[] {
		const stash = this._stashedFiles.get(sessionKey);
		if (!stash || stash.size === 0) return [];
		const files = [...stash];
		stash.clear();
		return files;
	}

	private async _saveDashboardStats(): Promise<void> {
		if (!this._dashboardStorage?.ready) {
			return; // 存储未就绪，跳过保存
		}
		try {
			// 批量保存累计统计
			await this._dashboardStorage.setAllStats({
				totalInputTokens: String(this._totalInputTokens),
				totalOutputTokens: String(this._totalOutputTokens),
				totalCachedTokens: String(this._totalCachedTokens),
				compressionCount: String(this._compressionCount),
				compressionIneffectiveCount: String(this._compressionIneffectiveCount),
				compressionBeforeTokens: String(this._compressionBeforeTokens),
				compressionAfterTokens: String(this._compressionAfterTokens),
				l1ExtractionCount: String(this._l1ExtractionCount),
				l2ExtractionCount: String(this._l2ExtractionCount),
				l3ExtractionCount: String(this._l3ExtractionCount),
			});

			// 保存工具调用计数
			const toolCounts: Record<string, number> = {};
			this._toolCallCounts.forEach((v, k) => { toolCounts[k] = v; });
			await this._dashboardStorage.setToolCallCounts(toolCounts);
		} catch (err) {
			this._logService.warn('[AgentOS] Failed to save dashboard stats:', err);
		}
	}

	/**
	 * 取消当前 Agent Loop（如果正在执行）。
	 * 所有活跃的工具执行将被 abort。
	 */
	/**
	 * 计算 turn 的隔离 key。与 chat 层 streamKey 对齐（agentId 在前）。
	 */
	private _turnKey(agentId: string | undefined, sessionId: string | undefined): string {
		return `${agentId ?? ''}::${sessionId ?? ''}`;
	}

	/**
	 * 取消 Agent Loop。
	 * - 传入 agentId + sessionId：按 turnKey 精确取消该窗口/会话的循环，不影响其他并发窗口。
	 * - 不传参数（向后兼容）：取消所有活跃 turn。
	 * 所有活跃的工具执行将随对应 AbortController abort 而被取消。
	 */
	cancelAgentLoop(agentId?: string, sessionId?: string): void {
		if (agentId !== undefined || sessionId !== undefined) {
			const key = this._turnKey(agentId, sessionId);
			const ctrl = this._activeTurnControllers.get(key);
			if (ctrl) {
				this._logService.info(`[AgentOS] Cancelling agent loop (turnKey=${key})`);
				ctrl.abort();
				this._activeTurnControllers.delete(key);
			} else {
				this._logService.info(`[AgentOS] cancelAgentLoop: no active turn for key=${key}`);
			}
			return;
		}
		// 无参：取消所有活跃 turn（向后兼容旧调用）
		this._logService.info(`[AgentOS] Cancelling ALL agent loops (${this._activeTurnControllers.size} active)`);
		for (const ctrl of this._activeTurnControllers.values()) {
			ctrl.abort();
		}
		this._activeTurnControllers.clear();
		if (this._loopAbortController) {
			this._loopAbortController.abort();
		}
		this._executionTracker.cancelAll();
	}

	/**
	 * 获取当前活跃的工具执行信息（供 UI 展示）
	 */
	getActiveToolExecutions(): ReadonlyArray<{ toolCallId: string; toolName: string; elapsedMs: number }> {
		return this._executionTracker.getActiveExecutions();
	}

	// ─── 能力槽注册 ─────────────────────────────────────────────────

	registerModelProvider(provider: IModelProvider): IDisposable {
		this._modelProviders.push(provider);
		this._onDidChangeModelProviders.fire();
		this._onDidChangeAvailableModels.fire();

		// 监听 Provider 自身状态变化
		this._register(provider.onDidChangeModels?.(() => {
			this._onDidChangeAvailableModels.fire();
		}));
		this._register(provider.onDidChangeAuthStatus?.(() => {
			this._onDidChangeAvailableModels.fire();
		}));

		this._logService.info(`[AgentOS] Registered ModelProvider: ${provider.id}`);

		// 如果没有活跃选择，自动选择第一个已认证的 Provider
		if (!this._activeSelection && provider.getAuthStatus?.() === ModelAuthStatus.Authenticated) {
			this._autoSelectDefault();
		}

		return {
			dispose: () => {
				const idx = this._modelProviders.indexOf(provider);
				if (idx !== -1) {
					this._modelProviders.splice(idx, 1);
					this._onDidChangeModelProviders.fire();
					this._onDidChangeAvailableModels.fire();
					this._logService.info(`[AgentOS] Unregistered ModelProvider: ${provider.id}`);
				}
			},
		};
	}

	registerMemoryProvider(provider: IMemoryProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerMemoryProvider(provider, priority);
	}

	registerToolProvider(provider: IToolProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerToolProvider(provider, priority);
	}

	registerPlanningProvider(provider: IPlanningProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerPlanningProvider(provider, priority);
	}

	registerExecutionProvider(provider: IExecutionProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerExecutionProvider(provider, priority);
	}

	registerRetrievalProvider(provider: IRetrievalProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerRetrievalProvider(provider, priority);
	}

	registerKanbanProvider(provider: IKanbanProvider, priority: number = 0): IDisposable {
		return this._slotRegistry.registerKanbanProvider(provider, priority);
	}

	// ─── Model Provider 管理 ─────────────────────────────────────────

	getModelProviders(): IModelProvider[] {
		return [...this._modelProviders];
	}

	getActiveModelSelection(): IModelSelection {
		if (!this._activeSelection && this._modelProviders.length > 0) {
			this._autoSelectDefault();
		}
		return this._activeSelection!;
	}

	setActiveModelSelection(selection: IModelSelection): void {
		this._activeSelection = selection;
		this._logService.info(`[AgentOS] Active model selection: ${selection.providerId}/${selection.modelId}`);
	}

	private _autoSelectDefault(): void {
		// 优先级：已认证 > priority 高 > 第一个
		const authenticated = this._modelProviders.filter(
			p => p.getAuthStatus?.() === ModelAuthStatus.Authenticated,
		);
		if (authenticated.length > 0) {
			const selected = authenticated.sort((a, b) => b.priority - a.priority)[0];
			selected.listModels?.().then(models => {
				if (models && models.length > 0) {
					// ── Guard: do NOT overwrite an explicit selection ──
					// The async .then() can resolve after the webview has
					// already synced an agent-level selection (e.g. Knot)
					// via providers.select → setActiveModelSelection().
					// Blindly overwriting here would snap the selection back
					// to a different provider (e.g. OpenRouter).
					if (this._activeSelection) {
						this._logService.info(
							`[AgentOS] _autoSelectDefault: skipping — explicit selection already set `
							+ `(${this._activeSelection.providerId}/${this._activeSelection.modelId})`,
						);
						return;
					}
					this._activeSelection = {
						providerId: selected.id,
						modelId: models[0].id,
					};
					this._logService.info(
						`[AgentOS] _autoSelectDefault: auto-selected ${selected.id}/${models[0].id}`,
					);
				}
			});
		}
	}

	// ─── 其他能力查询 ─────────────────────────────────────────────

	getActiveMemoryProvider(): IMemoryProvider | undefined {
		return this._slotRegistry.getActiveMemoryProvider();
	}

	// ─── Delegation Ledger + Durable Context accessors（借鉴 deer-flow）──

	/** Get the delegation ledger manager for external inspection. */
	get delegationLedger(): DelegationLedgerManager { return this._delegationLedger; }

	/** Get the durable context manager for checkpoint persistence. */
	get durableContext(): DurableContextManager { return this._durableContext; }

	/** Get the session-level token usage ledger across all sub-agents. */
	get tokenUsageLedger(): TokenUsageLedger { return this._tokenUsageLedger; }

	/** Get the subagent limit middleware for configuration inspection. */
	get subagentLimitMiddleware(): SubagentLimitMiddleware { return this._subagentLimitMw; }

	/** Render the current delegation ledger as a compact text block for debugging. */
	renderDelegationLedger(): string {
		return this._delegationLedger.render();
	}

	/** Reset the delegation ledger and durable context (for new sessions). */
	resetDelegationState(): void {
		this._delegationLedger.reset();
		this._durableContext.reset();
		this._tokenUsageLedger.reset();
	}

	/** Serialize durable context for checkpoint persistence. */
	saveDurableContextSnapshot(): DurableContextSnapshot {
		return this._durableContext.snapshot();
	}

	/** Restore durable context from a persisted checkpoint. */
	restoreDurableContextSnapshot(snapshot: DurableContextSnapshot): void {
		this._durableContext.restore(snapshot);
		// Optionally repopulate delegation ledger from the snapshot
		if (snapshot.delegationLedger) {
			for (const entry of snapshot.delegationLedger) {
				// Re-register completed entries into the live ledger
				if (entry.status === 'completed') {
					this._delegationLedger.markCompleted(entry.callId, entry.resultBrief);
				} else if (entry.status === 'failed') {
					this._delegationLedger.markFailed(entry.callId, entry.resultBrief);
				}
			}
		}
	}

	/**
	 * Record a completed sub-agent's token usage into the session-level ledger.
	 * Call this after each sub-agent execution completes (e.g., from delegate_task tool result).
	 */
	recordSubagentTokenUsage(
		subAgentId: string,
		subAgentType: string,
		task: string,
		startedAt: number,
		completedAt: number,
		usage: SubagentTokenUsage,
	): void {
		this._tokenUsageLedger.recordCompletion(
			subAgentId, subAgentType, task, startedAt, completedAt, usage,
		);
	}

	/**
	 * Capture a git commit into memory. Called by git post-commit hook integration.
	 * The commit info is stored as an episodic memory for future recall.
	 */
	captureGitCommit(commit: {
		sha: string; message: string; author: string; authorEmail?: string;
		filesChanged: string[]; insertions: number; deletions: number;
		timestamp: number; branch?: string; repoPath?: string;
	}): void {
		const provider = this.getActiveMemoryProvider();
		if (provider?.onGitCommit) {
			try {
				provider.onGitCommit(commit as any);
				this._logService.info(`[AgentOS] Git commit captured: ${commit.sha.slice(0, 8)} (${commit.filesChanged.length} files, +${commit.insertions}/-${commit.deletions})`);
			} catch (err) {
				this._logService.warn(`[AgentOS] Git commit capture failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	getActiveToolProvider(): IToolProvider | undefined {
		return this._slotRegistry.getActiveToolProvider();
	}

	getActivePlanningProvider(): IPlanningProvider | undefined {
		return this._slotRegistry.getActivePlanningProvider();
	}

	getActiveExecutionProvider(): IExecutionProvider | undefined {
		return this._slotRegistry.getActiveExecutionProvider();
	}

	getActiveRetrievalProvider(): IRetrievalProvider | undefined {
		return this._slotRegistry.getActiveRetrievalProvider();
	}

	getActiveKanbanProvider(): IKanbanProvider | undefined {
		return this._slotRegistry.getActiveKanbanProvider();
	}

	// ─── Slot Registry ────────────────────────────────────────────

	getSlotRegistry(): ISlotRegistry {
		return this._slotRegistry;
	}

	// ─── 工具启用/禁用管理 ─────────────────────────────────────

	async enableTool(agentId: string, toolName: string): Promise<void> {
		const provider = this.getActiveToolProvider();
		if (provider) {
			await provider.enableTool(agentId, toolName);
			this._logService.info(`[AgentOS] Enabled tool: ${toolName}`);
		}
	}

	async disableTool(agentId: string, toolName: string): Promise<void> {
		const provider = this.getActiveToolProvider();
		if (provider) {
			await provider.disableTool(agentId, toolName);
			this._logService.info(`[AgentOS] Disabled tool: ${toolName}`);
		}
	}

	async isToolEnabled(agentId: string, toolName: string): Promise<boolean> {
		const provider = this.getActiveToolProvider();
		if (!provider) { return true; }
		return await provider.isToolEnabled(agentId, toolName);
	}

	async getToolsEnabledState(agentId: string): Promise<Record<string, boolean>> {
		const provider = this.getActiveToolProvider();
		if (!provider) { return {}; }
		return await provider.getToolsEnabledState(agentId);
	}

	async setToolsEnabledState(agentId: string, state: Record<string, boolean>): Promise<void> {
		const provider = this.getActiveToolProvider();
		if (provider) {
			await provider.setToolsEnabledState(agentId, state);
		}
	}

	async listAllToolsWithState(agentId: string): Promise<(IToolDefinition & { enabled: boolean })[]> {
		// 获取所有已注册的 tool provider，而不仅是 active provider
		// 注意：不使用可选链，因为 getToolProviders 在 ISlotRegistry 接口中是必需方法
		let allProviders: IToolProvider[];
		try {
			allProviders = this._slotRegistry.getToolProviders();
		} catch (err) {
			this._logService.warn('[AgentOS] listAllToolsWithState: getToolProviders() failed, falling back to active provider', err);
			allProviders = this.getActiveToolProvider() ? [this.getActiveToolProvider()!] : [];
		}

		this._logService.info(`[AgentOS] listAllToolsWithState: found ${allProviders.length} tool providers`);
		for (const p of allProviders) {
			this._logService.info(`[AgentOS] listAllToolsWithState: provider ${p.id}`);
		}

		if (allProviders.length === 0) {
			this._logService.warn('[AgentOS] listAllToolsWithState: no tool providers registered!');
			return [];
		}

		const allTools: IToolDefinition[] = [];
		for (const provider of allProviders) {
			if (!provider) { continue; }
			if ('getAllToolDefinitions' in provider && typeof (provider as any).getAllToolDefinitions === 'function') {
				allTools.push(...await (provider as any).getAllToolDefinitions(agentId));
			} else {
				allTools.push(...await provider.listTools(agentId));
			}
		}

		// 去重：同名工具只保留第一个
		const seen = new Set<string>();
		const uniqueTools = allTools.filter(tool => {
			if (seen.has(tool.name)) { return false; }
			seen.add(tool.name);
			return true;
		});

		// 收集所有 provider 的启用状态
		const enabledState: Record<string, boolean> = {};
		for (const provider of allProviders) {
			if (!provider) { continue; }
			try {
				const state = await provider.getToolsEnabledState(agentId);
				Object.assign(enabledState, state);
			} catch { /* ignore */ }
		}

		return uniqueTools.map(tool => ({
			...tool,
			enabled: enabledState[tool.name] ?? true,
		}));
	}

	// ─── Fallback 配置（已关闭：容错机制禁用，保留供日后恢复参考）─────
	// private readonly _fallbackModels: string[] = ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'];
	// private readonly _maxFallbackAttempts: number = 3;
	// /** 模型 fallback 间的退避策略（指数退避 + 抖动），缓解限流风暴 */
	// private readonly _modelRetryPolicy: RetryPolicy = {
	// 	...DEFAULT_RETRY_POLICY,
	// 	initialInterval: 800,
	// 	maxInterval: 30_000,
	// 	maxAttempts: 5,
	// 	jitter: true,
	// };
	/**
	 * 模型流式响应的双超时策略（对齐 LangGraph TimeoutPolicy）：
	 *  - idleTimeout（180s）：流「中途」超过该时长无任何 delta 即判定为「静默挂起」，
	 *    抛 TimeoutError 触发模型 fallback。runTimeout 不启用，避免误杀合法长输出。
	 *    注：必须 ≥ HTTP 请求超时（120s），否则 resilience 会在 HTTP 层之前误杀一个
	 *    仍存活（只是慢）的流。真正死连接由 HTTP 层在 120s 以 AbortError 兜底。
	 *  - firstTokenTimeout（45s）：流「首 token 之前」的慢启动宽限。实测 CodeBuddy
	 *    网关冷启动首 delta 延迟可达 51s 且返回空响应（仅 usage + done）；
	 *    45s 超时可在冷启动场景提前 abort → 触发 fallback 或 retry，避免浪费 51s
	 *    等待一个空响应。MAX_VISIBLE_TOOLS=30 已收敛 payload，正常请求首 token
	 *    远低于 45s。
	 */
	private readonly _modelStreamTimeoutPolicy: TimeoutPolicy = {
		idleTimeout: 180_000,
		firstTokenTimeout: 45_000,
	};

	// ─── 统一执行入口 ───────────────────────────────────────────

	/**
	 * 执行一次 Agent 对话轮次
	 *
	 * 完整实现 — 包含错误恢复和 Fallback 机制
	 *
	 * 路径选择逻辑：
	 * 1. 如果有活跃的 ModelSelection 且对应的 ModelProvider 已注册
	 *    → 优先走直通模式（直接调用选中的 ModelProvider），确保用户在 UI
	 *      中选择的 Provider/Model 生效。
	 * 2. 否则尝试 ExecutionProvider（完整 Agent Loop）。
	 * 3. 最终退化为直接 Model Provider 调用（带 Fallback）。
	 */
	async *executeAgentTurn(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		this._logService.info(`[AgentOS] executeAgentTurn: agentId=${request.agentId}, messages=${request.messages.length}`);

		// ─── 图运行时路由（supervisor / AgentCommand(goto) 设计 Step C）──
		// 当请求携带≥2 节点的 agentGraph → 交给 runAgentGraph 解释器按节点执行。
		// 单 agent 模式（request.agentGraph 缺省）完全不进入此分支 → 零行为变更。
		if (request.agentGraph && Object.keys(request.agentGraph.nodes).length >= 2) {
			this._logService.info(
				`[AgentOS] executeAgentTurn: routing to runAgentGraph ` +
				`(${Object.keys(request.agentGraph.nodes).length} nodes, entry=${request.agentGraph.entryNodeId})`,
			);
			yield* this.executeAgentGraph(request);
			return;
		}

		// v39: per-request model override — workflow nodes can specify their own
		// provider/model. We temporarily swap the global selection and restore
		// it in the finally block, so all downstream code (tool listing,
		// provider lookup, fallback) sees the overridden selection.
		const savedSelection = this._activeSelection;
		if (request.modelOverride?.providerId && request.modelOverride?.modelId) {
			this._activeSelection = request.modelOverride;
			this._logService.info(
				`[AgentOS] Model override active: ${request.modelOverride.providerId}/${request.modelOverride.modelId} ` +
				`(was ${savedSelection?.providerId}/${savedSelection?.modelId})`,
			);
		}

		// ─── Per-turn 取消隔离（多窗口/多 Session 并发）──────────────────
		// 为本次 turn 建立独立 AbortController，存入 _activeTurnControllers。
		// cancelAgentLoop(agentId, sessionId) 按 turnKey 精确取消，互不干扰。
		// this._loopAbortController 仍指向"最近 turn"作为单窗口兼容/兜底。
		const turnKey = this._turnKey(request.agentId, request.sessionId);
		const turnController = new AbortController();
		this._activeTurnControllers.set(turnKey, turnController);
		this._loopAbortController = turnController;

		try {
			// ─── Path 1: 用户明确选择了 Model → 直通模式 ───────────────
			// 当用户在聊天框中显式选择了 Provider/Model 时，应直接使用该 Provider
			// 的 chat() 方法，而不是走 ExecutionProvider（它可能是 example stub）。
			const activeModelProvider = this._getActiveModelProvider();
			if (activeModelProvider && this._activeSelection?.modelId) {
				this._logService.info(
					`[AgentOS] Active model selection detected (${this._activeSelection.providerId}/${this._activeSelection.modelId}), `
					+ `using direct model call instead of ExecutionProvider`,
				);
				// 包一层 model fallback：此前此路径直接调 _executeWithFallbackDirectly，
				// 模型流 idle 超时（TimeoutError）会裸抛到 UI，_fallbackModels 形同虚设。
				yield* this._executeWithFallback(
					() => this._executeWithFallbackDirectly(request),
					request,
				);
				return;
			}

			// ─── Path 2: 使用 ExecutionProvider（完整 Agent Loop）────────
			const executionProvider = this.getActiveExecutionProvider();
			if (executionProvider) {
				this._logService.info(`[AgentOS] Using ExecutionProvider: ${executionProvider.id}`);
				try {
					yield* this._executeWithFallback(
						() => executionProvider.runAgentLoop(request, this.getSlotRegistry()),
						request,
					);
				} catch (error) {
					this._logService.error('[AgentOS] ExecutionProvider failed, trying fallback', error);
					yield {
						type: 'text',
						content: `\n[System: ExecutionProvider failed, falling back to direct mode]\n`,
					};
					yield* this._executeWithFallbackDirectly(request);
				}
				return;
			}

			// ─── Path 3: 退化模式：直接调用 Model Provider（带 Fallback）──
			yield* this._executeWithFallback(
				() => this._executeWithFallbackDirectly(request),
				request,
			);
		} finally {
			// Per-turn 取消隔离清理：移除本次 turn 的 controller。
			// 若 this._loopAbortController 恰为本 turn（无并发覆盖）则一并清空。
			this._activeTurnControllers.delete(turnKey);
			if (this._loopAbortController === turnController) {
				this._loopAbortController = undefined;
			}

			// v39: restore the original selection after the turn completes.
			if (request.modelOverride?.providerId && request.modelOverride?.modelId) {
				this._activeSelection = savedSelection;
				this._logService.info(
					`[AgentOS] Model override restored to: ${savedSelection?.providerId}/${savedSelection?.modelId}`,
				);
			}

			// Fire onTaskCompleted lifecycle callback (if provider supports it)
			const memProvider = this.getActiveMemoryProvider();

			// ── Hook: stop + session_end ────────────────────────────────
			if (memProvider?.triggerHook) {
				memProvider.triggerHook('stop', {
					agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
				}).catch(() => {});
				memProvider.triggerHook('session_end', {
					agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
				}).catch(() => {});
			}

			if (memProvider?.onTaskCompleted) {
				try {
					const userMsg = [...(request.messages as Array<{ role?: string; content?: string }>)]
						.reverse().find(m => m?.role === 'user')?.content?.slice(0, 200) ?? 'Agent turn completed';
					memProvider.onTaskCompleted(request.agentId, request.sessionId || '', userMsg);
				} catch { /* best effort */ }
			}
		}
		// P7: 清理注入幂等标记
		this._injectedSessions.delete(request.sessionId || request.agentId);
		// P8: 清理文件路径暂存
		this._stashedFiles.delete(request.agentId);
	}

	/**
	 * 图解释器（supervisor / AgentCommand(goto) 设计 Step C）。
	 *
	 * 复用既有单 agent loop（`_executeWithFallbackDirectly`）作为"节点执行器"，
	 * 按节点顺序执行，节点经 `transfer_to_agent`（Step B 拦截）或 supervisor 文本
	 * 返回 `AgentCommand({ goto })` 驱动动态路由。图状态（`currentNodeId` /
	 * `nodeThreads` / `sharedMemory` / `handoffSummary` / `nodeStatus`）统一经
	 * `reduceRunState` 维护，使整图在 Step 5 后可由 snapshot/resume 续跑。
	 *
	 * 单 agent 模式（`request.agentGraph` 缺省或节点数 <2）回退到单 agent 路径
	 * （零行为变更）。本方法被 `executeAgentTurn` 在检测到图时自动委派；也可由
	 * 图运行时直接调用。内部直接调用 `_executeWithFallbackDirectly`（非
	 * `executeAgentTurn`），避免重复路由 / 递归。
	 */
	async *executeAgentGraph(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta> {
		const graph = request.agentGraph;
		if (!graph || Object.keys(graph.nodes).length < 2) {
			// 单 agent 模式 / 非法图：回退单 agent 路径（agentGraph 清掉，避免再次路由）
			yield* this._executeWithFallbackDirectly({ ...request, agentGraph: undefined });
			return;
		}

		const end = graph.endNodeId ?? END_NODE;
		// 图级 runState + 续跑起点（Step D）：若 request.resumeFrom 携带上次落盘的
		// AgentRunState，则从其 graph.currentNodeId 续跑；否则从 entry 节点开始。
		// 单 agent 为 undefined（此处显式注入，使 ENTER_NODE/EXIT_NODE 等 action 生效）。
		const resume = prepareResumeRunState(graph, request.resumeFrom);
		let runState: AgentRunState = resume.runState;
		let current: string = resume.startNodeId;

		// 防图内环路导致无限运行（最大节点跳转次数，含容错上限）。
		let steps = 0;
		const MAX_GRAPH_STEPS = 64;

		while (current !== end) {
			if (++steps > MAX_GRAPH_STEPS) {
				this._logService.error(`[AgentOS] runAgentGraph: exceeded MAX_GRAPH_STEPS (${MAX_GRAPH_STEPS}) — stopping to avoid cycle`);
				yield { type: 'error', content: '[System: graph step limit exceeded — possible cycle]' };
				break;
			}

			const node = graph.nodes[current];
			if (!node) {
				this._logService.error(`[AgentOS] runAgentGraph: unknown node "${current}" — stopping graph`);
				yield { type: 'error', content: `[System: unknown graph node "${current}"]` };
				break;
			}

			// ─── 进入节点 ──────────────────────────────────────────────
			runState = reduceRunState(runState, { type: 'ENTER_NODE', nodeId: current });
			this._logService.info(`[AgentOS] runAgentGraph: ▶ entering node "${current}" (${node.kind}, agent=${node.agentId})`);
			yield { type: 'text', content: `\n[System: ▶ node "${current}" (${node.kind})]\n` };
			// checkpoint（Step D）：节点边界落盘；sink 缺省时不落盘（零行为变更）。
			await this._emitCheckpoint(request, runState);

			// ─── 构造节点请求 ──────────────────────────────────────────
			// agentId = node.agentId；agentGraph = graph（transfer_to_agent 可见 + 拦截）；
			// systemAppend 注入；上一节点 handoff summary 作为首条 user 消息（inheritHandoff）。
			const inheritHandoff = node.inheritHandoff !== false;
			const handoffSummary = runState.graph?.handoffSummary;
			const existingThread = runState.graph?.nodeThreads[current];
			let nodeMessages: IAgentTurnRequest['messages'];
			if (existingThread && existingThread.length > 0) {
				// Step D(resume) 才会填充真实线程；v1 仅入口/手交接种子（见 EXIT_NODE 注记）。
				nodeMessages = existingThread as unknown as IAgentTurnRequest['messages'];
			} else if (current === graph.entryNodeId) {
				nodeMessages = request.messages;
			} else if (inheritHandoff && handoffSummary) {
				nodeMessages = [{ role: 'user', content: handoffSummary }];
			} else {
				nodeMessages = [];
			}
			const nodeSystemPrompt = [request.systemPrompt, node.systemAppend].filter(Boolean).join('\n\n');

			// 节点子请求不含 checkpointSink / resumeFrom：落盘只在图顶层（本方法）发生，
			// resumeFrom 也只用于图起点一次；其余字段从 request 继承。
			const { checkpointSink: _sink, resumeFrom: _resume, ...nodeRequestBase } = request;
			const nodeRequest: IAgentTurnRequest = {
				...nodeRequestBase,
				agentId: node.agentId,
				agentGraph: graph,
				messages: nodeMessages,
				systemPrompt: nodeSystemPrompt || undefined,
				// 不把图外层 modelOverride 误传到子节点（节点用自身 agent 配置）
				modelOverride: undefined,
			};

			// 每节点独立 turn 控制器（对齐 executeAgentTurn 的取消隔离）。
			const turnKey = this._turnKey(node.agentId, request.sessionId);
			const turnController = new AbortController();
			this._activeTurnControllers.set(turnKey, turnController);
			this._loopAbortController = turnController;

			// ─── 执行节点 = 既有单 agent loop ─────────────────────────
			let command: AgentCommand | undefined;
			try {
				command = yield* this._executeWithFallbackDirectly(nodeRequest);
			} catch (err) {
				runState = reduceRunState(runState, { type: 'SET_NODE_STATUS', nodeId: current, status: 'error' });
				this._logService.error(`[AgentOS] runAgentGraph: node "${current}" failed`, err);
				yield { type: 'error', content: `[System: node "${current}" failed: ${(err as Error)?.message ?? String(err)}]` };
				break;
			} finally {
				this._activeTurnControllers.delete(turnKey);
				if (this._loopAbortController === turnController) {
					this._loopAbortController = undefined;
				}
			}

			// ─── 退出节点：落地线程 + 写回共享黑板 / handoff ───────────
			// 注：v1 将"输入线程"落地到 nodeThreads（Step D 接入 Step 5 snapshot 后，
			// 改为捕获节点真实回复线程，使 resume 可从节点中间续跑）。图级共享状态
			// （sharedMemory / handoffSummary / nodeStatus / currentNodeId）已正确持久。
			runState = reduceRunState(runState, { type: 'EXIT_NODE', nodeId: current, messages: nodeMessages as unknown as AgentRunMessage[] });
			if (command?.update) {
				runState = reduceRunState(runState, { type: 'WRITE_SHARED_MEMORY', patch: command.update });
			}
			if (command?.summary !== undefined) {
				runState = reduceRunState(runState, { type: 'SET_HANDOFF', summary: command.summary });
			}

			// ─── 路由到下一节点 ────────────────────────────────────────
			const next = computeNextNode(graph, node, command);
			this._logService.info(
				`[AgentOS] runAgentGraph: node "${current}" → next "${next}" ` +
				`(goto=${JSON.stringify(command?.goto ?? null)}, summary=${(command?.summary ?? '').slice(0, 60)})`,
			);
			// 更新续跑点（Step D）：即便崩溃，下次 resume 也从 next 节点继续，而非重跑本节点。
			runState = reduceRunState(runState, { type: 'SET_CURRENT_NODE', nodeId: next });
			await this._emitCheckpoint(request, runState);
			current = next;
		}

		yield { type: 'done' };
	}

	/**
	 * checkpoint 落盘（supervisor/goto Step D，存储无关）。
	 * 仅当 request.checkpointSink 注入时持久化当前 runState 快照；缺省为 no-op（零行为变更）。
	 * sink 抛错不影响图运行（仅记日志），保证 checkpoint 失败不阻断主流程。
	 */
	private async _emitCheckpoint(request: IAgentTurnRequest, runState: AgentRunState): Promise<void> {
		if (!request.checkpointSink) { return; }
		try {
			const snapshot: AgentRunStateSnapshot = snapshotRunState(runState);
			await request.checkpointSink(snapshot);
		} catch (err) {
			this._logService.error('[AgentOS] runAgentGraph checkpoint sink failed', err);
		}
	}





	/**
	 * 带 Fallback 的直接模型调用（含工具执行循环）
	 *
	 * 实现完整的 Agent Loop：
	 *   1. 获取启用的工具列表
	 *   2. 将工具定义传递给模型
	 *   3. 收集模型返回的 tool_calls
	 *   4. 执行工具调用，将结果反馈给模型
	 *   5. 循环直到模型不再调用工具或达到最大迭代次数
	 */
	private async *_executeWithFallbackDirectly(request: IAgentTurnRequest): AsyncIterable<IChatStreamDelta, AgentCommand | undefined> {
		const modelProvider = this._getActiveModelProvider();
		if (!modelProvider) {
			this._logService.warn('[AgentOS] No ModelProvider available');
			yield* this._fallbackToDirectChat(request);
			return undefined;
		}

		const selection = this.getActiveModelSelection();
		this._logService.info(`[AgentOS] Using ModelProvider directly: ${modelProvider.id}, modelId=${selection?.modelId}`);

		if (!selection || !selection.modelId) {
			this._logService.error('[AgentOS] No active model selection or modelId is empty');
			yield { type: 'error', content: 'No model selected. Please select a model from the toolbar.' };
			return undefined;
		}

		// ─── 1. 收集启用的工具（含 MCP 工具等待）─────────────────────
		// MCP 服务器连接和工具枚举是异步的：McpToolProvider 的 autorun 在
		// server.tools observable 变化后才填充 _routes。如果用户在 workbench
		// 启动后立即发消息，MCP 工具可能尚未就绪。这里在首次执行时做一次短轮询等待。
		let enabledTools = await this._getEnabledTools(request.agentId, request.agentGraph, request.toolsetsOverride, this._resolveHardPermission(request));
		this._logService.info(`[AgentOS] Direct mode: initial ${enabledTools.length} enabled tools for agent ${request.agentId}`);
		// 仅首次执行时，如果初始没有 MCP 工具，等待最多 3 秒让 MCP 服务器完成连接
		const mcpToolCount0 = enabledTools.filter(t => t.category?.startsWith('mcp:')).length;
		if (mcpToolCount0 === 0 && !this._mcpToolsInitialWaitDone) {
			this._mcpToolsInitialWaitDone = true;
			this._logService.info(`[AgentOS] No MCP tools found initially (first turn), waiting for MCP servers to connect...`);
			enabledTools = await this._waitForMcpTools(request.agentId, enabledTools, 3000);
		}
		// 诊断日志：列出所有工具名（特别标注 MCP 工具）
		const mcpToolNames = enabledTools.filter(t => t.category?.startsWith('mcp:')).map(t => t.name);
		const builtinToolNames = enabledTools.filter(t => !t.category?.startsWith('mcp:')).map(t => t.name);
		this._logService.info(`[AgentOS] Direct mode tools: ${enabledTools.length} total (${mcpToolNames.length} MCP: [${mcpToolNames.join(', ')}], ${builtinToolNames.length} builtin: [${builtinToolNames.slice(0, 10).join(', ')}${builtinToolNames.length > 10 ? '...' : ''}])`);

		// ─── 2. 初始化消息历史 ─────────────────────────────────────
		// 对齐 Hermes TOOL_USE_ENFORCEMENT_GUIDANCE + MiMo beast.txt：
		// 对 DeepSeek 等需要显式引导的模型族，自动在 system prompt 末尾注入
		// 工具使用强制指令——"说了要做就必须在同一轮发出 tool_call，否则不要停"。
		let effectiveSystemPrompt = request.systemPrompt;
		if (effectiveSystemPrompt) {
			const modelId = (selection?.modelId ?? '').toLowerCase();
			const needsEnforcement = AgentOSService.TOOL_USE_ENFORCEMENT_MODELS.some(m => modelId.includes(m));
			if (needsEnforcement && !effectiveSystemPrompt.includes('TOOL_USE_ENFORCEMENT')) {
				effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${AgentOSService.TOOL_USE_ENFORCEMENT_GUIDANCE}`;
				this._logService.info(`[AgentOS] Appended tool-use enforcement guidance for model ${selection.modelId}`);
			}
		}

		let messages: any[];
		if (effectiveSystemPrompt) {
			messages = [
				{ role: 'system', content: effectiveSystemPrompt },
				...request.messages,
			];
			this._logService.info(`[AgentOS] Prepended systemPrompt (${effectiveSystemPrompt.length} chars) as system message`);
		} else {
			messages = request.messages as any[];
		}

		// ─── 加载 Memory 上下文并注入 system prompt（冻结快照模式）──────
		//
		// 对齐 ExecutionProvider.runAgentLoop 的 memory 注入语义。
		// 用户反馈："Episodic 看起来没有收集到跟随这次对话一起下发的 memory"
		//
		// 历史 BUG：这里之前只有一行 `_logService.info('Memory provider available')`
		// 占位代码，根本没调用 loadContext，导致用户在工具栏选了模型走 Path 1 时，
		// Episodic/Semantic/Procedural 记忆永远不会被注入到 system prompt。
		//
		// Hermes "冻结快照"：会话开始时一次性注入，会话内不再刷新（中途新写入的
		// 记忆下次会话才生效），目的是保持 KV prefix cache 稳定。
		// 参见：doc/Memory-Strategy.md §4.2 / §五.2
		const memoryProvider = this.getActiveMemoryProvider();

		// ── Hook: session_start + prompt_submit ──────────────────────────
		// Fire session_start when the agent loop begins, and prompt_submit
		// to capture the user's intent for memory.
		if (memoryProvider?.triggerHook) {
			const userMsg = [...(request.messages as Array<{ role?: string; content?: string }>)]
				.reverse().find(m => m?.role === 'user')?.content ?? '';
			memoryProvider.triggerHook('session_start', {
				agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
			}).catch(() => {});
			memoryProvider.triggerHook('prompt_submit', {
				agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
				userMessage: userMsg.slice(0, 2000),
			}).catch(() => {});
		}
		if (memoryProvider) {
			try {
				// 抽取最近一条 user 消息作为召回 query —— 让 vendor 能用真实意图
				// 做 FTS5/embedding 匹配，而不是占位字符串（详见 IMemoryProvider.loadContext 注释）
				const recallQuery = [...(request.messages as Array<{ role?: string; content?: string }>)]
					.reverse()
					.find(m => m?.role === 'user')?.content ?? '';

				// ── 召回作用域（2026-06）─────────────────────────────────
				// 直接用 AgentDriver 在 enrichedRequest 上提前计算好的字段，
				// 避免 OSService 重复访问 IAgentStudioService（它没有这个依赖）。
				// 缺省时按 'agent' 严格隔离，与 AgentDriver 默认对齐。
				const recallScope: 'agent' | 'global' = request.memoryScope ?? 'agent';
				const recallOptions = { scope: recallScope };

			const memoryContext = await memoryProvider.loadContext(
				request.agentId,
				request.sessionId || '',
				recallQuery,
				recallOptions,
			) ?? { longTermMemories: [], shortTermMemories: [], injectedContext: '' };

				// P7: 注入幂等去重 — 同一 session 只注入一次 agentmemory-context
				// 后续轮次 memoryProvider 的 _sessionContextCache 会命中（返回相同 context），
				// 但注入操作本身（blocks 组装 + message splice）无需重复执行。
				const sessionKey = request.sessionId || request.agentId;
				const alreadyInjected = this._injectedSessions.has(sessionKey);

				// ─── 按 memoryConfig.strategy 过滤 memoryContext ────────────
				// 'summary' → 仅注入 Episodic（longTermMemories：摘要 / 长期记忆）
				// 'full'    → 注入 Episodic + Working（longTermMemories + shortTermMemories）
				//              即 full ⊇ summary，符合"全量"的语义直觉，
				//              并保证跨 Agent / 跨 session 的 Episodic 共享在两种策略下都生效。
				// 未指定时按 'full' 处理，与默认值一致。
				const strategy: 'summary' | 'full' = request.memoryStrategy === 'summary' ? 'summary' : 'full';
				// ── System default: prevent OOM when agent doesn't configure maxEntries ──
				// Previous sessions crashed with ~3.9GB V8 heap due to unlimited memory
				// entries accumulating across sessions. A hard cap of 50 per type (long +
				// short) keeps total injected entries ≤ 100, fitting comfortably in a
				// typical 4GB extension host heap alongside conversation + tool schemas.
				const SYSTEM_DEFAULT_MAX_MEMORY_ENTRIES = 50;
				const maxEntriesSource = (typeof request.memoryMaxEntries === 'number' && request.memoryMaxEntries > 0)
					? ('agent-config' as const)
					: ('system-default' as const);
				const maxEntries = maxEntriesSource === 'agent-config'
					? request.memoryMaxEntries!
					: SYSTEM_DEFAULT_MAX_MEMORY_ENTRIES;
				this._logService.info(
					`[AgentOS][MemoryCap] maxEntries=${maxEntries} (source=${maxEntriesSource}, ` +
					`raw=${request.memoryMaxEntries ?? 'undefined'})`
				);
				const cap = <T,>(arr: T[] | undefined): T[] => {
					if (!arr || arr.length === 0) { return []; }
					// 取最近 N 条（按 timestamp 升序时取尾部；这里直接 slice 末尾以保留既有顺序语义）
					return arr.length > maxEntries ? arr.slice(-maxEntries) : arr;
				};
				// Episodic 在 summary 与 full 两种策略下都注入；Working 仅在 full 下注入。
				const rawLongTermCount = (memoryContext.longTermMemories ?? []).length;
				const rawShortTermCount = (memoryContext.shortTermMemories ?? []).length;
				const filteredLongTerm = cap(memoryContext.longTermMemories);
				const filteredShortTerm = strategy === 'full' ? cap(memoryContext.shortTermMemories) : [];

				// ── Diagnostic: log each entry source + content size ────────
				if (rawLongTermCount > 0 || rawShortTermCount > 0) {
					const ltStats = memoryContext.longTermMemories?.slice(0, 5).map(m =>
						`[${m.type ?? '?'}] id=${(m.id ?? '').slice(0, 16)} chars=${(m.content ?? '').length}`
					).join(', ') ?? '';
					const stStats = memoryContext.shortTermMemories?.slice(0, 5).map(m =>
						`[${m.type ?? '?'}] id=${(m.id ?? '').slice(0, 16)} chars=${(m.content ?? '').length}`
					).join(', ') ?? '';
					this._logService.info(
						`[AgentOS][MemoryLoad] agent=${request.agentId} ` +
						`longTerm=${rawLongTermCount}→${filteredLongTerm.length} ` +
						`shortTerm=${rawShortTermCount}→${filteredShortTerm.length} ` +
						`maxEntries=${maxEntries}(${maxEntriesSource}) ` +
						`strategy=${strategy}`
					);
					if (ltStats) {
						this._logService.info(`[AgentOS][MemoryLoad] longTerm samples: ${ltStats}`);
					}
					if (stStats) {
						this._logService.info(`[AgentOS][MemoryLoad] shortTerm samples: ${stStats}`);
					}
				}

				const blocks: string[] = [];

				// longTermMemories（Episodic/Semantic 召回内容）——AgentMemory 的核心记忆
				if (filteredLongTerm.length > 0) {
					const ltContents = filteredLongTerm
						.map(m => m.content)
						.filter(Boolean)
						.join('\n\n');
					if (ltContents.trim().length > 0) {
						blocks.push(`## Long-term Memory (AgentMemory Recall)\n\n${ltContents}`);
					}
				}

				// shortTermMemories（最近几轮摘要，通常为空）
				if (filteredShortTerm.length > 0) {
					const stContents = filteredShortTerm
						.map(m => m.content)
						.filter(Boolean)
						.join('\n\n');
					if (stContents.trim().length > 0) {
						blocks.push(`## Short-term Memory\n\n${stContents}`);
					}
				}

				// systemPrompt（第三方 Memory Provider 直接返回的格式化字符串）
				// 其本质是 provider 端的摘要表述，属于 Episodic 范畴，因此在 summary 与 full
				// 两种策略下均注入（full ⊇ summary）。
				if (memoryContext.systemPrompt && memoryContext.systemPrompt.trim().length > 0) {
					blocks.push(memoryContext.systemPrompt.trim());
				}

				// P8: 消费暂存的文件路径，注入到 context（对齐 agentmemory stashedFiles）
				const stashedFiles = this._consumeStashedFiles(request.agentId);
				if (stashedFiles.length > 0) {
					const fileList = stashedFiles.slice(0, 10).join('\n');
					blocks.push(`## Recently Touched Files\n${fileList}`);
				}

				if (blocks.length > 0 && !alreadyInjected) {
					// 对齐 agentmemory 源码：使用 <agentmemory-context> 标签 + token 估算
					const usedTokens = Math.ceil(blocks.join('\n\n').length / 3);
					const result = `<agentmemory-context>\n${blocks.join('\n\n')}\n</agentmemory-context>`;
					// 注入为 system 消息（放在已有 systemPrompt 之后、用户消息之前）。
					let insertIdx = 0;
					for (let i = 0; i < messages.length; i++) {
						if (messages[i]?.role === 'system') {
							insertIdx = i + 1;
						} else {
							break;
						}
					}
					messages = insertMessages(messages, insertIdx, {
						role: 'system',
						content: result,
					});
					this._injectedSessions.add(sessionKey);
					this._logService.info(
						`[AgentOS] Injected agentmemory-context (strategy=${strategy}, ${result.length} chars, ` +
						`~${usedTokens} tokens, blocks=${blocks.length}, ` +
						`Episodic/Semantic=${filteredLongTerm.length}, ` +
						`Working=${filteredShortTerm.length}, ` +
						`hasSystemPrompt=${!!memoryContext.systemPrompt}, ` +
						`maxEntries=${maxEntries}(${maxEntriesSource})) for agent ${request.agentId}`
					);

					// 通知 UI 系统消息栏：记忆已注入
					const injectedEntries = [
						...filteredLongTerm.map(e => ({ type: e.type ?? 'episodic', content: (e.content ?? '').slice(0, 120) })),
						...filteredShortTerm.map(e => ({ type: e.type ?? 'working', content: (e.content ?? '').slice(0, 120) })),
					];
					yield {
						type: 'memory_injected',
						content: `已注入 ${filteredLongTerm.length + filteredShortTerm.length} 条记忆 (~${usedTokens} tokens)`,
						metadata: {
							strategy,
							episodicCount: filteredLongTerm.length,
							workingCount: filteredShortTerm.length,
							usedTokens,
							hasSystemPrompt: !!memoryContext.systemPrompt,
							entries: injectedEntries,
						},
					} as any;
				} else {
					this._logService.info(
						`[AgentOS] Memory provider returned empty context for agent ${request.agentId} ` +
						`(strategy=${strategy}, ` +
						`Episodic/Semantic=${filteredLongTerm.length}, ` +
						`Working=${filteredShortTerm.length})`
					);
					// 注入内容为空，不向 UI 系统消息栏发送通知
				}
			} catch (error) {
				this._logService.error('[AgentOS] Failed to load memory context', error);
				// 通知 UI：记忆加载失败（让用户知道注入逻辑已执行但出错）
				yield {
					type: 'memory_injected',
					content: `记忆加载失败: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
					metadata: { error: true },
				} as any;
			}
		} else {
			this._logService.info(`[AgentOS] No memory provider registered — skipping memory injection`);
		}

		// ─── Inject Durable Context（借鉴 deer-flow DurableContextMiddleware）────
		// Durable context survives summarization compression and keeps the LLM
		// aware of prior sub-agent delegations, active goals, and critical skill
		// context even when older messages have been dropped.
		const durableCtxMsg = buildDurableContextSystemMessage(this._durableContext);
		if (durableCtxMsg) {
			// Inject right after system prompt, before user messages
			let insertIdx = 0;
			for (let i = 0; i < messages.length; i++) {
				if (messages[i]?.role === 'system') {
					insertIdx = i + 1;
				} else {
					break;
				}
			}
			messages = insertMessages(messages, insertIdx, durableCtxMsg);
			this._logService.info(
				`[AgentOS] Injected durable context (${durableCtxMsg.content.length} chars, ` +
				`ledger entries: ${this._delegationLedger.getAllEntries().length})`
			);
		}

		// ─── 3. Agent Loop（带工具执行） ─────────────────────────
		// 复用 executeAgentTurn 建立的 per-turn AbortController（多窗口取消隔离）。
		// 兜底：若不存在（理论上 executeAgentTurn 一定已建）则就地新建并登记。
		const turnKey = this._turnKey(request.agentId, request.sessionId);
		let turnController = this._activeTurnControllers.get(turnKey);
		if (!turnController) {
			turnController = new AbortController();
			this._activeTurnControllers.set(turnKey, turnController);
		}
		this._loopAbortController = turnController;
		// 本 turn 的取消信号 —— 沿调用链传给工具执行方法，避免并发窗口读到被覆盖的 this 字段。
		const turnAbortSignal = turnController.signal;
		this._approvalService.reset(); // 新会话重置审批记忆
		const MAX_TOOL_ITERATIONS = 50;
		let iteration = 0;

		// ─── 未完成轮安全续跑计数器（对齐 OpenClaw attempt-scoped 重试）──────
		// 声明为 loop 局部：单次 turn 内跨 iteration 累计，达到上限即放弃续跑。
		// 不进 runState（与 iteration 同为 graph runtime 局部量），但受次数上限保护，
		// 不会形成无限循环。
		let reasoningOnlyRetryAttempts = 0;
		let emptyResponseRetryAttempts = 0;
		let lengthTruncatedRetryAttempts = 0;
		// 维度 3：瞬态错误（SSE 超时/网络/429/5xx）重试计数器，单次 turn 内累计
		let transientErrorRetries = 0;
			// 本轮 provider 结束原因（finish_reason / stop_reason），每轮迭代重置。
		let lastFinishReason: string | undefined;

		// ─── 工具失败连续计数（对齐 Hermes-Agent `_tool_failure_recovery_hint` 的增强版）──
		// 追踪同一工具的连续失败次数。达到阈值时注入 <system-reminder> 引导 LLM
		// 仔细阅读错误消息并换策略，避免盲目重试消耗迭代（详见日志：skill_create 名称缺失×3）。
		// 按工具名分组；任意工具成功后或调用 change 时全局清零。
		const _toolConsecutiveFailures = new Map<string, number>();
		const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

		// ─── AgentRunState（reducer 化 Step 3）────────────────────────────────
		// 跨 iteration 的业务状态（非法工具名计数 / 续跑计数 / 反思计数 / 文件修改标记 /
		// 强制 tool_choice 标志 / 工具调用历史 等）统一收口进不可变 reducer，
		// 取代原先散落的 `let` 控制变量。messages 仍由 loop 局部 `let messages` 管理
		// （Step 2 已收口写入），将在 Step 5 并入此 state 做 snapshot。
		// iteration 作为 while 循环步进计数器保留为 loop 局部（对齐 LangGraph：
		// step 计数属 graph runtime，不进 state schema）。
		// 真实 prompt token 按 agentId::sessionId 双键隔离，避免同 agent 多 session
		// 并行时压缩触发估算互相污染。
		let runState: AgentRunState = createInitialRunState({
			lastRealPromptTokens: this._lastRealPromptTokensByAgent.get(this._turnKey(request.agentId, request.sessionId)) ?? 0,
		});

		// ─── 工具失败恢复提示（借鉴 Hermes-Agent `_tool_failure_recovery_hint`）──
		// Hermes-Agent: 工具失败后注入针对性恢复建议，引导 LLM 换方案而非盲目重试。
		// 不对成功结果注入任何提示。
		function getToolFailureRecoveryHint(toolName: string): string | null {
			const hints: Record<string, string> = {
				terminal: 'For terminal failures, try a diagnostic command first (e.g., `pwd && ls`), ' +
					'then use an absolute path, a simpler command, or a different tool such as file_read/patch.',
				search_files: 'Search returned no results. Try a narrower directory, a simpler pattern, ' +
					'or use search_graph / query_graph to explore code by structure instead of by text.',
				file_read: 'File read failed. Check the path exists with file_list, or try search_graph ' +
					'to locate the file by its function/class names.',
				file_write: 'File write failed. Verify the parent directory exists, check write permissions, ' +
					'or try patch for targeted edits instead of full rewrites.',
				patch: 'Patch failed. The search text may not match exactly — try reading the file first ' +
					'to verify the current content, then use a smaller or more unique search string.',
				file_list: 'Directory listing failed. Check the path exists with `pwd` or an absolute path.',
				index_repository: 'Indexing failed. The workspace may already have a graph loaded — ' +
					'check index_status first, or try a different mode (fast/moderate/full).',
				search_graph: 'Graph search returned no results. Try a wider name pattern, a different label filter, ' +
					'or check index_status to verify the graph is loaded.',
			};
			return hints[toolName] ?? null;
		}


		// ─── Plan-Execute-Reflect 反思阶段跟踪 ───────────────────
		// 当 LLM 完成工具调用并给出最终回复后，注入反思提示让它检查是否有遗漏。
		// 参考 OpenSearch ML Commons 的 PLAN_EXECUTE_AND_REFLECT 模式。
		const MAX_REFLECT_ITERATIONS = 1;
		// 文件修改类工具名集合 — 仅在这些工具被使用后才触发反思
		const FILE_MODIFICATION_TOOLS = new Set([
			'file_write', 'write_to_file', 'replace_in_file', 'edit_file',
			'delete_file', 'write_to_file',
		]);

		// ─── 上下文压缩初始化（对齐 ExecutionProvider Path 2）──────────
		// Direct Mode 之前完全没有压缩，消息数一路增长直到撑爆上下文窗口。
		// 这里复用 ContextManager.compressContext 做 Hermes 三段式压缩，
		// 与 ExecutionProvider 保持一致的触发阈值和诊断日志。
		const contextManager = new ContextManager(modelProvider, selection.modelId);
		contextManager.setLogger({
			info: (msg: string) => this._logService.info(msg),
			warn: (msg: string) => this._logService.warn(msg),
			error: (msg: string, error?: unknown) => this._logService.error(msg, error),
			debug: (msg: string) => this._logService.debug(msg),
		});
		// 设置当前 model（用于 _getEnabledTools 实时查表 context window）
		// 对齐 Hermes-Agent `model_tools._resolve_active_context_length()` 每次实时查表
		this._setCurrentModel(modelProvider, selection.modelId);
		// 解析模型真实上下文窗口（token），用于计算压缩阈值
		const compressionWindow = await this._resolveContextWindow(modelProvider, selection.modelId);

		// ─── 检索式上下文：每轮 turn 开始前独立注入（对齐 agentmemory mem::context）──
		// 把记忆检索从「仅压缩时」提前到每轮 llm_streaming 前：turn 开始时即检索相关
		// 对话上下文并作为独立 system 消息注入，使 LLM 每轮都能拿到历史记忆；同时把
		// 当前消息增量外置到记忆（含本 turn 新到的 user 消息），保证首轮压缩也有数据、
		// 彻底去除首次 37s。仅在 RETRIEVAL_COMPACTION_ENABLED 开启时执行。
		if (RETRIEVAL_COMPACTION_ENABLED) {
			const rp = this.getActiveMemoryProvider();
			if (rp && (rp as any).recallFormatted) {
				try {
					// 1) 增量外置：先把当前 messages（含本 turn 新到的 user 消息 + 历史）
					//    写进记忆（await 保证落盘），保证本 turn 内触发压缩时 recallFormatted
					//    已有数据可取，彻底去除首次 37s。
					await this._storeTurnObservations(rp, request.agentId ?? 'default', request.sessionId ?? '', messages);
					// 2) 检索相关上下文并注入为独立 system 消息（前缀与 contextManager
					//    INJECTED_CONTEXT_PREFIX 一致，压缩时会被剥离，避免与摘要重复）。
					const r = await this._retrieveContextOnly(
						rp, request.agentId ?? 'default', request.sessionId ?? '', messages,
						Math.floor(compressionWindow * RETRIEVAL_BUDGET_RATIO),
					);
					if (r && r.context.trim()) {
						messages = this._injectRetrievalSystemMessage(messages, r.context, r.source);
						this._logService.info(
							`[AgentOS][Retrieval] injected retrieved context at turn start ` +
							`(source=${r.source}, ~${Math.ceil(r.context.length / 3)} tokens) for agent ${request.agentId}`
						);
						yield {
							type: 'memory_injected',
							content: `已检索注入历史上下文 (~${Math.ceil(r.context.length / 3)} tokens)`,
							metadata: { source: r.source, retrieval: true },
						} as any;
					}
				} catch (reErr) {
					this._logService.warn(
						`[AgentOS][Retrieval] turn-start retrieval failed: ` +
						`${reErr instanceof Error ? reErr.message : String(reErr)}`
					);
				}
			}
		}

		// P1: 上一轮 LLM 响应回传的真实 prompt token（provider usage，含 cache）。
		// compressContext 优先用它判定，取代低估的 char/4 粗估。首轮=0 自动退回粗估。
		// 上一轮真实 prompt token 由 runState.lastRealPromptTokens 承载（初始值取自实例字段，
		// 跨 turn 持久化，不再每轮归零）。

		while (iteration < MAX_TOOL_ITERATIONS) {
			iteration++;
			// 每轮迭代重置上一轮的 finishReason（仅当前轮有效）
			lastFinishReason = undefined;
			// 每轮进入 LLM 推理前显式置 phase=llm_streaming（对齐 UI 广播，
			// phase 进 runState 供 Step 5 checkpoint 读取）。压缩块内会切到
			// 'compressing' 再切回 'llm_streaming'，runState.phase 跟随。
			runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'llm_streaming' });
			// Yield to the event loop every 5 iterations to prevent UI freeze
			// during long-running agent loops (P2-6 fix).
			if (iteration % 5 === 0) {
				await new Promise<void>(r => setTimeout(r, 0));
			}
			this._logService.info(`[AgentOS] Direct mode iteration ${iteration}/${MAX_TOOL_ITERATIONS}`);

			// ─── 上下文压缩（对齐 ExecutionProvider 7.1）──────────────────
			// 每轮迭代开头检查是否需要压缩，压缩发生时：
			// 1. yield phase_change='compressing' 通知 UI
			// 2. 替换 messages 为压缩后的消息
			// 3. yield context_compacted 回传压缩后 token 基线
			// 4. yield phase_change='llm_streaming' 切回流式态
			{
			// P3: 廉价逐轮剪枝（无 LLM、不丢消息）—— 仅对最近 CHEAP_PRUNE_RECENT_KEEP 条之外的
			// 旧 tool 输出做 head+tail 截断，约束 token 增长；受保护工具(skill/memory/...)原样保留。
			// 对齐 MiMo prune.ts 的"活体边缘之外剪枝"，避免大输出持续累积撑爆窗口。
			messages = ContextManager.pruneOldToolOutputs(
				messages as unknown as ReadonlyArray<ChatMessage>,
				ContextManager.CHEAP_PRUNE_RECENT_KEEP
			) as unknown as typeof messages;

			const compressionStartTime = Date.now();
			const originalMessageCount = messages.length;
				const originalEstimatedTokens = this._estimateMessagesTokens(messages);
				this._logService.info(
				`[AgentOS][Compression] BEFORE: messages=${originalMessageCount}, ` +
				`estimatedTokens=${originalEstimatedTokens}, compressionWindow=${compressionWindow}, ` +
				`lastRealPromptTokens=${runState.lastRealPromptTokens}`
				);

				// 跨消息冷却期检查（ContextManager 每次新建，冷却期需在 AgentOSService 层持久化）
				let compressionResult;
				const cooldownElapsed = this._lastCompressionTime > 0
					? Date.now() - this._lastCompressionTime
					: Infinity;
				if (cooldownElapsed < AgentOSService.COMPRESSION_COOLDOWN_MS) {
					this._logService.info(
						`[AgentOS][Compression] COOLDOWN: ${Math.round((AgentOSService.COMPRESSION_COOLDOWN_MS - cooldownElapsed) / 1000)}s remaining, skipping`
					);
					compressionResult = {
						originalMessageCount: messages.length,
						compressedMessageCount: messages.length,
						summary: '',
						compressedMessages: [...messages] as unknown as ChatMessage[],
						metadata: { compressionRatio: 1.0, skipped: 'cooldown' },
					};
				} else {
					try {
						// Pre-compact injection callback — passed into compressContext
						// so injected memories are part of the compressed result.
						const memProviderForInject = this.getActiveMemoryProvider();
						const preCompactInject = memProviderForInject?.onPreCompact
							? (ctx: { agentId: string; sessionId: string; messages: Array<{ role: string; content: string; timestamp: number }>; tokensSaved: number; contextWindow: number }) => {
								const injectBudget = Math.min(
									Math.max(Math.floor(ctx.tokensSaved * 0.1), 500),
									Math.floor(ctx.contextWindow * 0.05),
									2000,
								);
					return memProviderForInject.onPreCompact!(ctx.agentId, ctx.sessionId, ctx.messages, injectBudget);
						}
						: undefined;
					// 检索式上下文回调（对齐 agentmemory mem::context）：从记忆系统
					// 取回相关上下文替代同步 LLM 摘要。仅在 AgentMemory 可用时提供，
					// 否则 compressContext 回退到原有 LLM 摘要路径（零行为变更）。
					const memProviderForRetrieve = memProviderForInject;
					const retrieveContext = (memProviderForRetrieve && (memProviderForRetrieve as any).recallFormatted)
						? (r: any) => this._retrieveCompactionContext(memProviderForRetrieve as any, r)
						: undefined;
					compressionResult = await contextManager.compressContext(
						messages as unknown as ReadonlyArray<ChatMessage>,
						undefined,
						compressionWindow,
						runState.lastRealPromptTokens,
						preCompactInject as any,
						retrieveContext as any
					);
					} catch (compressionError) {
						this._logService.error(
							`[AgentOS][Compression] EXCEPTION during compressContext: ` +
							`${compressionError instanceof Error ? compressionError.message : String(compressionError)}`,
							compressionError
						);
						compressionResult = {
							originalMessageCount: messages.length,
							compressedMessageCount: messages.length,
							summary: '',
							compressedMessages: [...messages] as unknown as ChatMessage[],
							metadata: { compressionRatio: 1.0, skipped: 'exception', error: String(compressionError) },
						};
					}
				}
				const didCompress = compressionResult.compressedMessageCount < compressionResult.originalMessageCount;
				const compressionDurationMs = Date.now() - compressionStartTime;
				const cmpMeta = compressionResult.metadata ?? {};
				const logFn = didCompress
					? this._logService.info.bind(this._logService)
					: this._logService.warn.bind(this._logService);
				logFn(
					`[AgentOS][Compression] didCompress=${didCompress} ` +
					`skipped=${JSON.stringify(cmpMeta.skipped ?? null)} ` +
					`tokenSource=${cmpMeta.tokenSource ?? 'n/a'} ` +
					`effectiveTokens=${cmpMeta.effectiveTokens ?? 'n/a'} ` +
					`realPromptTokens=${cmpMeta.realPromptTokens ?? 'n/a'} ` +
					`estimatedTokens=${cmpMeta.estimatedTokens ?? 'n/a'} ` +
					`thresholdTokens=${cmpMeta.thresholdTokens ?? 'n/a'} ` +
					`effectiveWindow=${cmpMeta.effectiveWindow ?? 'n/a'} ` +
					`compressionWindow=${compressionWindow} ` +
					`messageCount=${cmpMeta.messageCount ?? messages.length} ` +
					`minMessagesToCompress=${cmpMeta.minMessagesToCompress ?? 'n/a'} ` +
					`ineffectiveCompressionCount=${cmpMeta.ineffectiveCompressionCount ?? 'n/a'} ` +
				`compressionThreshold=${cmpMeta.compressionThreshold ?? 'n/a'}`
			);
			// ─── Dashboard 统计：压缩指标累积 ──
			if (didCompress) {
				this._compressionCount++;
				const before = (cmpMeta.estimatedTokens as number) ?? 0;
				const after = (cmpMeta.estimatedTokensAfter as number) ?? 0;
				const savingRatio = before > 0 ? (before - after) / before : 0;
				if (savingRatio < 0.1) {
					this._compressionIneffectiveCount++;
				}
				this._compressionBeforeTokens += before;
				this._compressionAfterTokens += after;
				this._scheduleSave();
			}
				if (didCompress) {
				this._lastCompressionTime = Date.now();
				// 显式置 phase 后再广播，确保 loop 内部 phase 与 UI 同源（设计 §3.4）
				runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'compressing' });
				yield { type: 'phase_change', phase: runState.phase };
					// 捕获压缩前后文本（用于详情编辑器对比显示）
					// 消息级别截断：只在消息边界截断，避免在消息块中间切断导致公共后缀匹配失败
					const fmtBlock = (m: any) => `[${m.role ?? 'unknown'}] ${(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).slice(0, 300)}`;
					const MAX_TEXT_LEN = 50000;
					// afterText：压缩后消息数少，直接顺序拼接即可
					const fmtListSequential = (msgs: any[]): string => {
						const blocks: string[] = [];
						let totalLen = 0;
						for (const m of msgs) {
							const block = fmtBlock(m);
							if (totalLen + block.length + 2 > MAX_TEXT_LEN && blocks.length > 0) { break; }
							blocks.push(block);
							totalLen += block.length + 2;
						}
						return blocks.join('\n\n');
					};
					// beforeText：原始消息可能很多（400+条），必须用"头尾保留+中间截断"策略
					// 否则从头截断会丢失尾部消息，导致 _computeStructuredDiff 公共后缀匹配失败
					const fmtListBefore = (msgs: any[]): string => {
						const allBlocks: string[] = [];
						let totalLen = 0;
						for (const m of msgs) {
							const block = fmtBlock(m);
							allBlocks.push(block);
							totalLen += block.length + 2;
						}
						// 未超限则直接返回
						if (totalLen <= MAX_TEXT_LEN) { return allBlocks.join('\n\n'); }
						// 超限时：保留头尾，截断中间
						// 头部占一半预算，尾部占一半预算
						const halfBudget = Math.floor(MAX_TEXT_LEN / 2);
						const headBlocks: string[] = [];
						let headLen = 0;
						for (const block of allBlocks) {
							if (headLen + block.length + 2 > halfBudget && headBlocks.length > 0) { break; }
							headBlocks.push(block);
							headLen += block.length + 2;
						}
						const tailBlocks: string[] = [];
						let tailLen = 0;
						for (let i = allBlocks.length - 1; i >= headBlocks.length; i--) {
							const block = allBlocks[i];
							if (tailLen + block.length + 2 > halfBudget && tailBlocks.length > 0) { break; }
							tailBlocks.unshift(block);
							tailLen += block.length + 2;
						}
						const omitted = allBlocks.length - headBlocks.length - tailBlocks.length;
						const parts = [...headBlocks];
						if (omitted > 0) {
							parts.push(`[... 省略 ${omitted} 条消息 ...]`);
						}
						parts.push(...tailBlocks);
						return parts.join('\n\n');
					};
					const beforeText = fmtListBefore(messages);
					// 收口到 compactMessages reducer（不可变换底），保留单点便于后续加 size guard / token 计费
					messages = compactMessages(messages, compressionResult.compressedMessages as unknown as AgentRunMessage[]) as any[];

					// Calculate compression metrics (needed by P4 injection budget and P0 summary write)
					const compressedEstimatedTokens = this._estimateMessagesTokens(messages);
					const tokensSaved = originalEstimatedTokens - compressedEstimatedTokens;
					const savePercent = originalEstimatedTokens > 0
						? Math.round(tokensSaved / originalEstimatedTokens * 100)
						: 0;
					this._logService.info(
						`[AgentOS][Compression] AFTER: messages=${compressionResult.compressedMessageCount}, ` +
						`estimatedTokens=${compressedEstimatedTokens}, saved=${tokensSaved} (${savePercent}%), ` +
						`duration=${compressionDurationMs}ms`
					);

					// ── P0: 压缩摘要写入记忆 ──────────────────────────────────────
					// 压缩摘要是宝贵的 Episodic (L1) 记忆，记录了"这段对话讲了什么"，
					// 应该持久化到 memory 中供后续会话召回。
					// IMemoryEntry.type 4-Tier: 'working' | 'episodic' | 'semantic' | 'procedural'
					if (didCompress && compressionResult.summary && compressionResult.summary.length > 10) {
						const memProviderForSummary = this.getActiveMemoryProvider();
						if (memProviderForSummary) {
							const summaryTs = Date.now();
							void (async () => {
								try {
									await memProviderForSummary.writeMemory(request.agentId, {
										id: `compression-${summaryTs}`,
										type: 'episodic',
										content: `[Context Compressed] ${compressionResult.summary}`,
										metadata: {
											memoryType: 'episodic',
											source: 'context_compression',
											originalCount: compressionResult.originalMessageCount,
											compressedCount: compressionResult.compressedMessageCount,
											tokensSaved,
											savePercent,
											workspaceId: this._currentWorkspaceId,
											sessionId: request.sessionId,
											noticeId: `compression-${summaryTs}`,
										},
										timestamp: summaryTs,
									});
									this._logService.info(
										`[AgentOS][Compression] Summary written to memory: ${compressionResult.summary.length} chars`
									);
								} catch (e) {
									this._logService.warn(`[AgentOS][Compression] Failed to write summary to memory: ${e instanceof Error ? e.message : String(e)}`);
								}
							})();
						}
					}

				// ── P4: Checkpoint 无损重建（极端压力兜底）────────────────────
				// 当压力 ≥85% 窗口时，检查点重建比常规压缩更激进：
				// 不调 LLM，复用既有摘要作为"检查点"，丢弃全部旧消息，只保留极短尾段。
				// 对齐 MiMo checkpoint.ts 的丢弃重建——这是 context overflow 前的最后一道防线。
				{
					const postCompressTokens = this._estimateMessagesTokens(messages);
					const postPressure = ContextManager.getPressureLevel(postCompressTokens, compressionWindow);
					if (postPressure >= 3 && postCompressTokens > compressionWindow * 0.85) {
						this._logService.warn(
							`[AgentOS][Checkpoint] EXTREME pressure (${(postCompressTokens / compressionWindow * 100).toFixed(0)}%), ` +
							`trying checkpoint rebuild (no LLM, aggressive cut)`
						);
						const checkpointResult = await contextManager.compressCheckpoint(
							messages as unknown as ReadonlyArray<ChatMessage>,
							compressionWindow,
						);
						const ckMeta = checkpointResult.metadata ?? {};
						if (checkpointResult.compressedMessageCount < checkpointResult.originalMessageCount) {
							messages = compactMessages(messages, checkpointResult.compressedMessages as unknown as AgentRunMessage[]) as any[];
							this._logService.warn(
								`[AgentOS][Checkpoint] REBUILT: ` +
								`from ${checkpointResult.originalMessageCount}→${checkpointResult.compressedMessageCount} messages, ` +
								`saved ${ckMeta.tokensSaved ?? 'n/a'} tokens, no LLM`
							);
						} else {
							this._logService.warn(
								`[AgentOS][Checkpoint] SKIPPED: ${ckMeta.skipped ?? 'no_saving'}`
							);
						}
					}
				}

				const afterText = fmtListSequential(messages);
				const finalEstimatedTokens = this._estimateMessagesTokens(messages);
				yield {
					type: 'context_compacted',
					compactedInputTokens: finalEstimatedTokens,
						compressionOriginalCount: originalMessageCount,
						compressionCompressedCount: compressionResult.compressedMessageCount,
						compressionTokensSaved: tokensSaved,
						compressionDurationMs,
						compressionBeforeText: beforeText,
						compressionAfterText: afterText,
						compressionSummary: compressionResult.summary || '',
					} as IChatStreamDelta;
					// 压缩恢复后显式置 phase 再广播，与 SET_PHASE('compressing') 同源
					runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'llm_streaming' });
					yield { type: 'phase_change', phase: runState.phase };
				}
			}

			// ─── 每轮迭代重新收集工具 ──────────────────────────────────
			// MCP 服务器可能在 agent loop 进行中才完成连接并暴露工具。
			// 每轮迭代重新收集确保新可用的 MCP 工具被纳入 LLM 请求。
			// 首轮使用循环前已收集（含等待）的 enabledTools；后续轮次刷新。
			if (iteration > 1) {
				const refreshed = await this._getEnabledTools(request.agentId, request.agentGraph, request.toolsetsOverride, this._resolveHardPermission(request));
				if (refreshed.length !== enabledTools.length) {
					const newMcp = refreshed.filter(t => t.category?.startsWith('mcp:')).map(t => t.name);
					this._logService.info(`[AgentOS] Iteration ${iteration}: tools refreshed ${enabledTools.length} → ${refreshed.length} (MCP: [${newMcp.join(', ')}])`);
				}
				enabledTools = refreshed;
			}

		// ── Fork 前缀缓存（请求构造端接 ForkContext）─────────────────────────
		// 计算本请求自身的冻结前缀（system + tools），并与父级 ForkContext 比对对齐。
		// 对齐时请求构造端（MessageFormatConverter + BYOK provider）会在该前缀边界
		// 注入 cache_control 断点 → 命中父级已写入的 prompt cache（而非重计费稳定大前缀）。
		const currentFork = buildForkContext(request.systemPrompt ?? '', enabledTools);
		if (request.sessionId) {
			this._lastForkContextBySession.set(request.sessionId, currentFork);
		}
		const forkAligned = prefixCacheAligned(request.forkContext, request.systemPrompt ?? '', enabledTools);
		this._logService.info(
			`[AgentOS] Fork prefix-cache: aligned=${forkAligned} ` +
			`parentFp=${request.forkContext?.toolsFingerprint ?? '(none)'} ` +
			`childFp=${currentFork.toolsFingerprint} session=${request.sessionId ?? '(none)'}`,
		);

		// 构建模型选项（注入工具 + ForkContext）
		const modelOptions: IModelOptions = {
			temperature: request.options?.temperature ?? 0.7,
			maxTokens: request.options?.maxTokens ?? 4096,
			systemPrompt: request.systemPrompt,
			tools: enabledTools.length > 0 ? enabledTools : undefined,
			stop: request.options?.stop,
			// 思考/推理配置：由聊天输入框 thinking UI 控件透传至此，
			// 各 model provider 据此映射到原生 API 参数（thinking/thinkingConfig/reasoning_effort）。
			reasoning: request.options?.reasoning,
			// Fork 前缀缓存：透传父级 ForkContext 给请求构造端判对齐 + 打 cache 断点。
			forkContext: request.forkContext,
		};

			// 调用模型
			// 注意：抓包对齐的三个独立 id（不可混用）：
			//   conversationId  会话级稳定（同一 sessionId 复用同一个）→ X-Conversation-ID
			//   requestId       请求级，每轮 iteration 都重新生成      → X-Conversation-Request-ID
			//   previousResponseId  上一轮响应流的 id（链式衔接）        → 请求体 previous_response_id
			// 历史串台 bug：仅用单一 sessionId 当所有 id，服务端 KV 缓存按 conversation-id
			// 跨会话碰撞 → 命中旧上下文、忽略本地 priorMessages。此处分离三 id 杜绝碰撞。
			const conversationId = this._getOrCreateConversationId(request.sessionId);
			const requestId = this._generateHexId();
			const previousResponseId = request.sessionId
				? this._lastResponseIdBySession.get(request.sessionId)
				: undefined;
			const context: { agentId?: string; sessionId?: string; conversationId?: string; requestId?: string; previousResponseId?: string } = {};
			if (request.agentId) {
				context.agentId = request.agentId;
			}
			if (request.sessionId) {
				context.sessionId = request.sessionId;
			}
			context.conversationId = conversationId;
			context.requestId = requestId;
			if (previousResponseId) {
				context.previousResponseId = previousResponseId;
			}

			this._logService.info(`[AgentOS] Calling modelProvider.chat(modelId=${selection.modelId}, messages=${messages.length}, tools=${enabledTools.length}) convId=${conversationId} reqId=${requestId} prevRespId=${previousResponseId ?? '(none)'}`);

			// ─── 诊断：列出实际发送给 LLM 的所有工具名 ──────────────────
			if (enabledTools.length > 0) {
				const mcpToolsSent = enabledTools.filter(t => t.category?.startsWith('mcp:'));
				const builtinToolsSent = enabledTools.filter(t => !t.category?.startsWith('mcp:'));
				this._logService.info(
					`[AgentOS] TOOLS SENT TO LLM: ${enabledTools.length} total\n` +
					`  MCP tools (${mcpToolsSent.length}): [${mcpToolsSent.map(t => t.name).join(', ')}]\n` +
					`  Builtin tools (${builtinToolsSent.length}): [${builtinToolsSent.map(t => t.name).join(', ')}]`
				);
				if (mcpToolsSent.length === 0) {
					this._logService.warn(`[AgentOS] ⚠ NO MCP TOOLS in API request! MCP server may not be connected.`);
				}
			} else {
				this._logService.warn(`[AgentOS] ⚠ NO TOOLS at all in API request!`);
			}

		// 收集模型响应
		let assistantContent = '';
		let thinkingContent = '';
		// 诊断：保留最后一个 usage delta 供 try-catch 外的 Model response 日志输出
		let _lastUsageDelta: any = null;
			// P0-leak-fix: accumulate streamed text in chunk arrays and join ONCE
			// after the stream. Per-delta `assistantContent += delta.content` built a
			// V8 ConsString rope (one node per delta) that ballooned heap usage.
			const _assistantChunks: string[] = [];
			const _thinkingChunks: string[] = [];
			const assistantToolCalls: IToolCallInfo[] = [];
			// Streaming tool call assembly using OpenClaw-inspired assembler
			// Provides: incremental argument buffering, size limits, partial JSON parsing
			const toolCallAssembler = new StreamingToolCallAssembler();
			// ─── Track all tool_start IDs we yield this iteration ──────────────
			// Any ID that gets a tool_start MUST eventually get a tool_end, otherwise
			// the webview's tool card will spin forever. Tool calls can be lost between
			// tool_start and tool_end via:
			//   1. Deduplication (`deduplicateToolCalls`) — duplicate name+args dropped
			//   2. Phantom filter (render_type=None && default_show=false)
			//   3. Provider not found (executed=false in _executeToolCalls)
			//   4. Any execution exception that bypasses results.push()
			// We track started IDs and emit a synthetic tool_end with success=false
			// for any ID that did not get a real tool_end before the iteration ends.
			const chatMessageStream = new AGUIChatMessageBuilder();
			const startedToolIds = new Set<string>();
			const endedToolIds = new Set<string>();

			try {
				this._logService.info(`[AgentOS] modelProvider.chat: creating stream...`);
				// ─── 发送前 tool 配对守卫（治本对抗 IOA 网关 HTTP 400 code 11133）─────
				// 压缩(head/tail 切割)、冷却期跳过压缩、或历史回灌都可能留下
				// 「assistant 发起 tool_call 但缺对应 tool 结果」的悬空调用。
				// OpenAI/IOA 网关强制 tool_call 必须被对应 tool 结果应答，失配即
				// 整轮 400。这里在真正发请求前把序列修成协议合法形态（纯函数，
				// 无失配时保持等价，不改变正常流程）。
				const _beforePairGuard = messages.length;
				messages = ContextManager.sanitizeToolPairs(messages);
				if (messages.length !== _beforePairGuard) {
					this._logService.warn(`[AgentOS] Tool-pair guard: dropped ${_beforePairGuard - messages.length} orphan/dangling tool message(s) before send (${_beforePairGuard} → ${messages.length})`);
				}
				const t0_modelCall = Date.now();
				// ─── 诊断：pre-call 快照（帮助定位"突然中断"）────────────
				// 记录发出请求时的完整上下文状态：消息数、估算 token、真实 token、
				// 压力等级（≥3 即 ≥85% 窗口，会触发 P4 checkpoint 重建）、
				// 上次压缩距今时间、上次响应 id。事后可对照"中断时刻"的这些值。
				{
					const _est = this._estimateMessagesTokens(messages);
					const _real = runState.lastRealPromptTokens ?? 0;
					const _pressure = ContextManager.getPressureLevel(_real || _est, compressionWindow);
					const _sinceCompress = this._lastCompressionTime > 0
						? Math.round((Date.now() - this._lastCompressionTime) / 1000)
						: -1;
					this._logService.info(
						`[AgentOS][Diag] PRE-CHAT snapshot | ` +
						`iter=${iteration} model=${selection.modelId} convId=${conversationId} reqId=${requestId} | ` +
						`msgs=${messages.length} enabledTools=${enabledTools.length} | ` +
						`estTokens=${_est} realPromptTokens=${_real} compressionWindow=${compressionWindow} | ` +
						`pressure=${_pressure}/3 (${compressionWindow > 0 ? Math.round((_real || _est) / compressionWindow * 100) : 0}%) | ` +
						`lastCompressionAt=${_sinceCompress >= 0 ? _sinceCompress + 's ago' : 'never'} | ` +
						`prevRespId=${previousResponseId ?? '(none)'} | ` +
						`abortSignal=${this._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
					);
				}
				const rawStream = modelProvider.chat(selection.modelId, messages, modelOptions, context);
			// 流式 idle 超时：模型静默挂起（无 delta 心跳超过阈值）时抛 TimeoutError，
			// 由下方 catch 重新抛出并触发 _executeWithFallback 的备用模型切换（对齐 LangGraph TimeoutPolicy）。
			const stream = withStreamTimeout(rawStream, this._modelStreamTimeoutPolicy, {
				signal: this._loopAbortController?.signal,
				log: (lvl, msg) => {
					if (lvl === 'error') { this._logService.error(msg); }
					else if (lvl === 'warn') { this._logService.warn(msg); }
					else { this._logService.info(msg); }
				},
			});
				let _firstDeltaReceived = false;
				// ─── 诊断：per-delta 类型追踪 + heartbeat ─────────────────────
				// 区分 text/reasoning/tool_call/usage/done 等 delta 类型并分别计数，
				// 追踪"上一次文本 delta 距今多久"（流式 idle 监测），
				// 定期 heartbeat 帮助事后还原"中断时刻"的流进度。
				let _totalDeltas = 0;
				let _textDeltas = 0;
				let _textBytes = 0;
				let _reasoningDeltas = 0;
				let _reasoningBytes = 0;
				let _toolCallDeltas = 0;
				let _usageDeltas = 0;
				let _otherDeltas = 0;
				let _lastTextDeltaAt = 0;
				let _lastReasoningDeltaAt = 0;
				let _lastDeltaType = '';
				let _lastHeartbeatAt = Date.now();
				const _heartbeatMs = 5000;
				// ── 诊断：per-delta 时间线（定位"46s 空窗"类问题）─────────────────
				// 记录每个 delta 的时间戳 + 类型 + 内容预览，用于事后还原流的节奏。
				// 完整记录（不截断数量），仅在 stream-end 时输出，避免逐 delta 打日志。
				const _deltaTimeline: string[] = [];
				let _prevDeltaAt = 0;
				for await (const delta of stream) {
					_totalDeltas++;
					_lastDeltaType = String(delta.type ?? 'unknown');
					const _deltaAt = Date.now();
					// ── GAP 检测：>10s 的 delta 间空窗（定位"模型在等什么"）──
					if (_prevDeltaAt > 0 && _deltaAt - _prevDeltaAt > 10_000) {
						this._logService.warn(
							`[AgentOS][Diag] DELTA GAP | ${_deltaAt - _prevDeltaAt}ms between delta #${_totalDeltas - 1} → #${_totalDeltas} | ` +
							`elapsed=${Math.round((_deltaAt - t0_modelCall) / 1000)}s`
						);
					}
					_prevDeltaAt = _deltaAt;
					if (!_firstDeltaReceived) {
						_firstDeltaReceived = true;
						this._logService.info(
							`[AgentOS] modelProvider.chat: first delta received in ${Date.now() - t0_modelCall}ms ` +
							`(type=${_lastDeltaType})`
						);
					}
					// ── 诊断：per-delta 时间线条目 ──
					{
						const _elapsed = _deltaAt - t0_modelCall;
						let _preview = '';
						if (delta.type === 'text' && delta.content) {
							_preview = `"${String(delta.content).slice(0, 80)}"`;
						} else if (delta.type === 'thinking' && (delta as any).content) {
							_preview = `"${String((delta as any).content).slice(0, 80)}"`;
						} else if (delta.type === 'tool_call' && delta.toolCall) {
							_preview = `name=${delta.toolCall.name ?? '(cont)'}`;
						} else if (delta.type === 'usage' && delta.usage) {
							const u = delta.usage;
							_preview = `in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0} cached=${u.cachedTokens ?? 0}`;
							_lastUsageDelta = u; // 保留供 POST-CHAT 输出
							// ── 关键诊断：usage delta 到达时立即记录（尤其 outputTokens）──
							// outputTokens 高 → 模型生成了大量 token 但未被捕获为 text/reasoning
							// outputTokens 低 → 模型确实只生成了极少内容
							this._logService.info(
								`[AgentOS][Diag] USAGE delta | inputTokens=${u.inputTokens ?? 0} outputTokens=${u.outputTokens ?? 0} ` +
								`cached=${u.cachedTokens ?? 0} cacheWrite=${u.cacheWriteTokens ?? 0} | ` +
								`textSoFar=${_textDeltas}(${_textBytes}B) reasoningSoFar=${_reasoningDeltas}(${_reasoningBytes}B) | ` +
								`elapsed=${Math.round(_elapsed / 1000)}s`
							);
						} else if (delta.type === 'done') {
							_preview = `finishReason=${delta.finishReason ?? '(none)'}`;
							// ── 关键诊断：done delta 到达时立即记录 finishReason ──
							this._logService.info(
								`[AgentOS][Diag] DONE delta | finishReason=${delta.finishReason ?? '(none)'} | ` +
								`elapsed=${Math.round(_elapsed / 1000)}s | ` +
								`text=${_textDeltas}(${_textBytes}B) reasoning=${_reasoningDeltas}(${_reasoningBytes}B) toolCall=${_toolCallDeltas}`
							);
						}
						_deltaTimeline.push(`#${_totalDeltas} t=${_elapsed}ms type=${_lastDeltaType} ${_preview}`);
					}
					// 按 delta 类型分类计数 + 时间戳
					// IChatStreamDelta.type 联合：'text' | 'thinking' | 'tool_call' | 'usage' | 'error' | 'done'
					if (delta.type === 'text' && delta.content) {
						_textDeltas++;
						_textBytes += (delta.content as string).length;
						_lastTextDeltaAt = Date.now();
					} else if (delta.type === 'thinking' && (delta as any).content) {
						_reasoningDeltas++;
						_reasoningBytes += String((delta as any).content).length;
						_lastReasoningDeltaAt = Date.now();
					} else if (delta.type === 'tool_call') {
						_toolCallDeltas++;
					} else if (delta.type === 'usage') {
						_usageDeltas++;
					} else {
						_otherDeltas++;
					}
					// Heartbeat：每 5s 输出一次（除非刚刚有文本/推理 delta，否则会重复出现）
					const _now = Date.now();
					if (_now - _lastHeartbeatAt >= _heartbeatMs) {
						const _sinceText = _lastTextDeltaAt > 0 ? Math.round((_now - _lastTextDeltaAt) / 1000) : -1;
						const _sinceReasoning = _lastReasoningDeltaAt > 0 ? Math.round((_now - _lastReasoningDeltaAt) / 1000) : -1;
						this._logService.info(
							`[AgentOS][Diag] MID-STREAM heartbeat | ` +
							`elapsed=${Math.round((_now - t0_modelCall) / 1000)}s | ` +
							`totalDeltas=${_totalDeltas} text=${_textDeltas}(${_textBytes}B) ` +
							`reasoning=${_reasoningDeltas}(${_reasoningBytes}B) ` +
							`toolCall=${_toolCallDeltas} usage=${_usageDeltas} other=${_otherDeltas} | ` +
							`lastDeltaType=${_lastDeltaType} | ` +
							`sinceText=${_sinceText >= 0 ? _sinceText + 's' : 'none'} ` +
							`sinceReasoning=${_sinceReasoning >= 0 ? _sinceReasoning + 's' : 'none'} | ` +
							`abortSignal=${this._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
						);
						_lastHeartbeatAt = _now;
					}
					// ─── 捕获响应流 id（抓包对齐）──────────────────────────────
					// 抓包证据：响应流每个 chunk 的 id 相同，且 = 下一次请求的
					// previous_response_id。任意 delta 携带 responseId 即记下，供下一轮
					// （或下一条用户消息）作 previousResponseId 链式衔接。
				if (delta.responseId && request.sessionId) {
					this._lastResponseIdBySession.set(request.sessionId, delta.responseId);
				}
				// ─── P1: 截获真实 prompt token，供下一轮 compressContext 优先判定 ──
				// 完整 prompt = inputTokens + 缓存读 + 缓存写（缓存 token 同样占窗口）。
				// 捕获后同步写入实例字段，跨 turn 持久化；下一轮 L1390 直接读取。
				if (delta.type === 'usage' && delta.usage) {
					const u = delta.usage;
					const realPrompt = (u.inputTokens ?? 0) + (u.cachedTokens ?? 0) + (u.cacheWriteTokens ?? 0);
					if (realPrompt > 0) {
						runState = reduceRunState(runState, { type: 'SET_LAST_PROMPT_TOKENS', value: realPrompt });
						this._lastRealPromptTokensByAgent.set(this._turnKey(request.agentId, request.sessionId), realPrompt);
						this._logService.info(
							`[AgentOS][Compression] captured real prompt usage: inputTokens=${u.inputTokens ?? 0} ` +
							`cached=${u.cachedTokens ?? 0} cacheWrite=${u.cacheWriteTokens ?? 0} → lastRealPromptTokens=${runState.lastRealPromptTokens}`
						);
					}
					// ─── Dashboard 统计：累积 Token 用量 ──
					this._totalInputTokens += (u.inputTokens ?? 0);
					this._totalOutputTokens += (u.outputTokens ?? 0);
					this._totalCachedTokens += (u.cachedTokens ?? 0);
					this._scheduleSave();
					// ─── P5: Cache hit rate monitoring — persist cache metrics to memory observation ──
					// Aligns with agentmemory: cache_read/cache_write tokens become first-class memory observations.
					if ((u.cachedTokens ?? 0) > 0 || (u.cacheWriteTokens ?? 0) > 0) {
						const memProvider = this.getActiveMemoryProvider();
						if (memProvider) {
							const memTs = Date.now();
							void memProvider.writeMemory(request.agentId, {
								id: `cache-metric-${memTs}`,
								type: 'working',
								content: `Cache usage: read=${u.cachedTokens ?? 0}, write=${u.cacheWriteTokens ?? 0}, total=${u.inputTokens ?? 0 + (u.outputTokens ?? 0)}`,
								metadata: {
									agentId: request.agentId,
									workspaceId: this._currentWorkspaceId,
									source: 'cache_metrics',
									cacheReadTokens: u.cachedTokens ?? 0,
									cacheWriteTokens: u.cacheWriteTokens ?? 0,
									inputTokens: u.inputTokens ?? 0,
									outputTokens: u.outputTokens ?? 0,
								},
								timestamp: memTs,
							}).catch(err => {
								this._logService.warn(`[AgentOS][CacheMetrics] failed to write cache metric: ${err}`);
							});
						}
					}
				}
				// 收集完整的助手消息数据
				// ─── 捕获 provider 本轮结束原因（finish_reason / stop_reason）──
				// 供后续"未完成轮"结构判定（对齐 OpenClaw，无文本意图识别）。
				if (delta.type === 'done' && delta.finishReason) {
					lastFinishReason = delta.finishReason;
				}
				if (delta.type === 'text' && delta.content) {
					_assistantChunks.push(delta.content);
				} else if (delta.type === 'thinking' && delta.content) {
					_thinkingChunks.push(delta.content);
					} else if (delta.type === 'tool_call' && delta.toolCall) {
						const tc = delta.toolCall;
						if (tc.name) {
							// New tool call (first chunk) — finalize previous if any
							if (toolCallAssembler.isActive) {
								assistantToolCalls.push(toolCallAssembler.finalize());
							}
							toolCallAssembler.start(tc.id, tc.name, tc.arguments || '', {
								displayName: tc.displayName,
								renderType: tc.renderType,
								defaultShow: tc.defaultShow,
								serverExecuted: tc.serverExecuted,
							});
						} else {
							// Continuation chunk — append arguments with buffer size check
							const appended = toolCallAssembler.appendArgs(tc.arguments || '');
							if (!appended) {
								this._logService.warn(`[AgentOS] Tool call argument buffer overflow (>${MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES} bytes), finalizing early`);
								assistantToolCalls.push(toolCallAssembler.finalize());
							}
						}
					}

					// 将 delta 适配并 yield 给调用者
					// 同时更新统一 ChatMessage 格式（AG-UI → ChatMessage）
					if (chatMessageStream) {
						chatMessageStream.handlePart(delta as any);
					}
					const adapted = this._adaptModelDelta(delta);
					if (adapted) {
						// Track tool_start IDs for end-of-iteration reconciliation
						if ((adapted as any).type === 'tool_start' && (adapted as any).toolCallId) {
							startedToolIds.add((adapted as any).toolCallId);
						}
						yield adapted;
						// ── Forward tool arguments alongside a single-shot tool_call ──
						// Some model providers (e.g. CodeBuddy / hy3-preview-ioa) emit the
						// whole tool call in ONE delta (name + arguments together) rather
						// than streaming the name first and arguments in follow-up chunks.
						// _adaptModelDelta maps such a delta to a `tool_start` ONLY (it can
						// return a single chunk), so the arguments would be dropped and the
						// webview card would never receive `params` → the title would show
						// no file name / command. Detect this case and emit the matching
						// `tool_args` right after the `tool_start` so the card can render
						// the italic description (e.g. "读取文件 README.md").
						if (
							(adapted as any).type === 'tool_start' &&
							delta.type === 'tool_call' &&
							delta.toolCall &&
							delta.toolCall.name &&
							typeof delta.toolCall.arguments === 'string' &&
							delta.toolCall.arguments.length > 0
						) {
							yield {
								type: 'tool_args' as any,
								content: delta.toolCall.arguments,
								toolCallId: delta.toolCall.id,
							};
						}
					}
				}
				this._logService.info(
					`[AgentOS] modelProvider.chat: stream ended after ${Date.now() - t0_modelCall}ms (firstDelta=${_firstDeltaReceived ? 'yes' : 'no'})`
				);
				// ─── 诊断：stream-end 详细快照 ────────────────────────────
				// 记录流结束时所有 delta 的分类统计 + "最后文本 delta 距今多久"，
				// 配合 POST-CHAT 后的"为什么空响应"分析，定位流是被谁中断的。
				{
					const _now = Date.now();
					const _sinceText = _lastTextDeltaAt > 0 ? Math.round((_now - _lastTextDeltaAt) / 1000) : -1;
					const _sinceReasoning = _lastReasoningDeltaAt > 0 ? Math.round((_now - _lastReasoningDeltaAt) / 1000) : -1;
					const _outTokens = _lastUsageDelta?.outputTokens ?? 'n/a';
					this._logService.info(
						`[AgentOS][Diag] POST-CHAT stream-end | ` +
						`elapsed=${Math.round((_now - t0_modelCall) / 1000)}s | ` +
						`totalDeltas=${_totalDeltas} ` +
						`text=${_textDeltas}(${_textBytes}B) ` +
						`reasoning=${_reasoningDeltas}(${_reasoningBytes}B) ` +
						`toolCall=${_toolCallDeltas} usage=${_usageDeltas} other=${_otherDeltas} | ` +
						`lastDeltaType=${_lastDeltaType || '(none)'} ` +
						`finishReason=${lastFinishReason ?? '(none)'} ` +
						`outputTokens=${_outTokens} | ` +
						`sinceText=${_sinceText >= 0 ? _sinceText + 's' : 'none'} ` +
						`sinceReasoning=${_sinceReasoning >= 0 ? _sinceReasoning + 's' : 'none'} | ` +
						`assistantContentLen=${assistantContent.length} toolCallsSoFar=${assistantToolCalls.length} | ` +
						`abortSignal=${this._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
					);
					// ── 诊断：per-delta 时间线（定位空窗/异常节奏）──
					// 输出全部 delta 的时间戳+类型+预览，最多 50 条避免日志爆炸
					if (_deltaTimeline.length > 0) {
						const _tl = _deltaTimeline.length > 50
							? [..._deltaTimeline.slice(0, 25), `... (${_deltaTimeline.length - 50} more) ...`, ..._deltaTimeline.slice(-25)]
							: _deltaTimeline;
						this._logService.info(
							`[AgentOS][Diag] DELTA TIMELINE (${_deltaTimeline.length} deltas):\n${_tl.join('\n')}`
						);
					}
				}
		} catch (error) {
			// 模型调用失败：显式置 phase=error（进 runState，供异常路径 checkpoint 读取）
			runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'error' });
			// ── 维度 3：瞬态错误重试（对齐 MiMo persistentRetrySchedule）────────
			// SSE 超时 / 网络中断 / HTTP 429/5xx 等瞬态错误用指数退避重试，
			// 避免 1 次瞬时抖动就中止整轮对话。TimeoutError 仍向上抛（触发 fallback 模型切换）。
			const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
			if (!isTimeout && isTransientStreamError(error) && transientErrorRetries < TRANSIENT_ERROR_MAX_RETRIES) {
				transientErrorRetries++;
				const delay = Math.min(
					TRANSIENT_ERROR_BASE_DELAY_MS * Math.pow(TRANSIENT_ERROR_BACKOFF_FACTOR, transientErrorRetries - 1),
					TRANSIENT_ERROR_MAX_DELAY_MS
				);
				this._logService.warn(
					`[AgentOS] Transient stream error on iteration ${iteration}, ` +
					`retrying in ${delay}ms (attempt ${transientErrorRetries}/${TRANSIENT_ERROR_MAX_RETRIES}): ` +
					`${error instanceof Error ? error.message : String(error)}`
				);
				await new Promise(r => setTimeout(r, delay));
				continue;  // 回到 while loop 重试
			}
			this._logService.error(`[AgentOS] Model call failed on iteration ${iteration}:`, error);
				// 流式 idle 超时（模型静默挂起）：作为硬失败向上抛出，
				// 经由 runAgentLoop → _executeWithFallback 切换到备用模型（对齐 LangGraph TimeoutPolicy）。
				if (isTimeout) {
					throw error;
				}
				// 如果是第一次迭代失败，尝试 fallback
				if (iteration === 1) {
					yield { type: 'error', content: `Model call failed: ${error instanceof Error ? error.message : String(error)}` };
				}
				// Reconcile any tool_start that was emitted during streaming before
				// the model call failed — webview must not be left with spinners.
				for (const orphanId of startedToolIds) {
					if (!endedToolIds.has(orphanId)) {
						this._logService.warn(`[AgentOS] Orphaned tool_start after model error: ${orphanId} — emitting synthetic tool_result + tool_end`);
						const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ error: 'Model call failed before tool could execute' })));
						yield { type: 'tool_result', content: orphanResultStr, toolCallId: orphanId };
						yield { type: 'tool_end', toolCallId: orphanId, success: false };
						endedToolIds.add(orphanId);
					}
				}
				break;
			}

		// Finalize the last pending tool call from streaming assembly
		if (toolCallAssembler.isActive) {
			assistantToolCalls.push(toolCallAssembler.finalize());
		}

		// ─── Flatten accumulated streamed text exactly once (O(n), no ConsString ropes).
		// MUST happen before any diagnostic log / empty-response check that reads
		// assistantContent — otherwise the join hasn't run yet and textLen is always 0
		// even when hundreds of text deltas were received (diagnostic false-positive).
		assistantContent = _assistantChunks.join('');
		thinkingContent = _thinkingChunks.join('');

	this._logService.info(
		`[AgentOS] Model response: textLen=${assistantContent.length}, toolCalls=${assistantToolCalls.length}` +
		`, finishReason=${lastFinishReason ?? 'n/a'}, outputTokens=${_lastUsageDelta?.outputTokens ?? 'n/a'}`
	);
	if (assistantContent.length === 0 && assistantToolCalls.length === 0) {
			// 诊断：空响应时刻的完整上下文快照（关键定位信息）
			const _est = this._estimateMessagesTokens(messages);
			const _real = runState.lastRealPromptTokens ?? 0;
			const _pressure = ContextManager.getPressureLevel(_real || _est, compressionWindow);
			const _sinceCompress = this._lastCompressionTime > 0
				? Math.round((Date.now() - this._lastCompressionTime) / 1000)
				: -1;
			this._logService.warn(
				`[AgentOS] Model returned empty response — no text and no tool calls. ` +
				`Snapshot: iter=${iteration} msgs=${messages.length} estTokens=${_est} ` +
				`realPromptTokens=${_real} compressionWindow=${compressionWindow} ` +
				`pressure=${_pressure}/3 (${compressionWindow > 0 ? Math.round((_real || _est) / compressionWindow * 100) : 0}%) ` +
				`lastCompressionAt=${_sinceCompress >= 0 ? _sinceCompress + 's ago' : 'never'} ` +
				`maxTokens=${(modelOptions as any)?.maxTokens ?? 'n/a'} ` +
				`abortSignal=${this._loopAbortController?.signal?.aborted ? 'ABORTED' : 'active'}`
			);
		}

		// ─── 诊断日志：记录原生 tool calls 的名称 ──────────────────────
		if (assistantToolCalls.length > 0) {
			this._logService.info(`[AgentOS] Native tool calls from API: ${assistantToolCalls.map(tc => tc.name).join(', ')}`);
		}

	// ─── 检查是否需要执行工具（含文本解析兜底）──────────────────
		let effectiveToolCalls = assistantToolCalls;
			if (effectiveToolCalls.length === 0 && assistantContent) {
				// 尝试从纯文本中解析工具调用（兼容不严格遵循 OpenAI 格式的模型）
				// 传入 enabledTools 以支持从纯参数 JSON 推断工具名
				const extracted = this._tryExtractToolCallsFromText(assistantContent, thinkingContent, enabledTools);
			if (extracted.length > 0) {
				this._logService.info(`[AgentOS] Extracted ${extracted.length} tool calls from text output: [${extracted.map(tc => tc.name).join(', ')}]`);
					effectiveToolCalls = extracted;

					// ── Clean assistantContent using the unified sanitizer pipeline
					// (OpenClaw-style multi-stage strip: JSON objects, code blocks, XML, brackets, etc.)
					if (isEntirelyToolCallContent(assistantContent)) {
						assistantContent = '';
						this._logService.info(`[AgentOS] Cleared assistantContent (was entirely tool-call content)`);
					} else {
						const cleaned = sanitizeAssistantVisibleText(assistantContent, 'streaming');
						assistantContent = cleaned.length < 5 ? '' : cleaned;
						this._logService.info(`[AgentOS] Sanitized assistantContent, remaining: ${assistantContent.length} chars`);
					}

					// Notify downstream (agentChatService + webview) to replace accumulated text
					// content with the cleaned version. This prevents the UI from showing
					// the raw JSON that was already extracted into tool cards.
					yield { type: 'content_replace', content: assistantContent };

					// 向 UI 发送 tool_start 事件（前端需要 tool_start 才能渲染工具卡片）
					for (const tc of extracted) {
						startedToolIds.add(tc.id);
						yield {
							type: 'tool_start',
							toolCallId: tc.id,
							toolName: tc.name,
							displayName: tc.displayName,
							renderType: tc.renderType,
							defaultShow: tc.defaultShow,
						};
					}
				}
			}

			// ─── 白名单过滤原生工具调用 ──────────────────────────────────────
			// 模型可能在 agent 定义 / system prompt 中知晓某个工具（如 new_agent），
			// 但它被 tool_search 桥接归入 deferred 池、未直接下发到 API tools 参数中。
			// 此时模型直接调用该工具属于合法行为，不应被当作幻觉调用过滤掉。
			// 因此白名单检查须基于全量已启用工具（不受 MAX_VISIBLE_TOOLS 截断影响），
			// 而非仅可见工具子集（enabledTools）。
			if (effectiveToolCalls.length > 0 && this._lastAllEnabledToolNames.size > 0) {
				const validCalls = effectiveToolCalls.filter(tc => {
					if (this._lastAllEnabledToolNames.has(tc.name)) { return true; }
					// 2026-07-03: 统一单套桥接 — 接受所有桥接工具调用（tool_search/tool_describe/tool_call）
					if (isBridgeTool(tc.name)) { return true; }
					if (PHANTOM_TOOL_NAMES.has(tc.name)) { return true; }
					this._logService.warn(`[AgentOS] Filtered out hallucinated tool call: "${tc.name}" (not in enabled tools)`);
					return false;
				});
				if (validCalls.length < effectiveToolCalls.length) {
					this._logService.info(`[AgentOS] Whitelist filtered native tool calls: ${effectiveToolCalls.length} → ${validCalls.length}`);
					// 为被过滤的幻觉调用补 tool_result + tool_end，防止卡片永远转圈
					for (const tc of effectiveToolCalls) {
						if (validCalls.includes(tc)) { continue; }
						yield { type: 'tool_result', content: `工具 "${tc.name}" 不在可用列表中（可能为幻觉调用）`, toolCallId: tc.id };
						yield { type: 'tool_end', toolCallId: tc.id, success: false };
						endedToolIds.add(tc.id);
					}
					effectiveToolCalls = validCalls;
				}
			}

			// Deduplicate tool calls
			const beforeDedup = effectiveToolCalls;
			effectiveToolCalls = deduplicateToolCalls(effectiveToolCalls);
			if (effectiveToolCalls.length < beforeDedup.length) {
				this._logService.info(`[AgentOS] Deduplicated: ${beforeDedup.length} → ${effectiveToolCalls.length}`);
				// 为被去重的工具补 tool_result + tool_end
				for (const tc of beforeDedup) {
					if (effectiveToolCalls.includes(tc)) { continue; }
					yield { type: 'tool_result', content: `工具 "${tc.name}" 已去重（与其它调用重复）`, toolCallId: tc.id };
					yield { type: 'tool_end', toolCallId: tc.id, success: false };
					endedToolIds.add(tc.id);
				}
			}

			// ─── Filter out phantom tool calls (render_type="None", default_show=false) ─────
			// These are UI indicator tools (e.g., "task_planning" showing "任务规划中")
			// that should NOT be executed as real tools. Executing them causes confusing
			// "not yet implemented" errors that derail the conversation.
			//
			// 双重判定（缺一不可的兜底）：
			//   A) 元数据明示：renderType==="None" && defaultShow===false
			//      —— Knot server 在 _meta 里正确标注时走这条
			//   B) 名称白名单：PHANTOM_TOOL_NAMES.has(name)
			//      —— Knot server 漏发 _meta 字段时的兜底（实测会发生，
			//         否则就会进入 repairToolName 失败 → tool not found
			//         → 模型生成一大段"我尝试调用了不存在的工具"道歉的循环）
			const realToolCalls = effectiveToolCalls.filter(tc => {
				const isPhantomByMeta = tc.renderType === 'None' && tc.defaultShow === false;
				const isPhantomByName = PHANTOM_TOOL_NAMES.has(tc.name);
				const isPhantom = isPhantomByMeta || isPhantomByName;
				if (isPhantom) {
					const reason = isPhantomByMeta ? 'meta(render_type=None,default_show=false)' : 'name-whitelist';
					this._logService.info(`[AgentOS] Skipping phantom tool call: ${tc.name} (${reason})`);
				}
				return !isPhantom;
			});
		if (realToolCalls.length < effectiveToolCalls.length) {
			this._logService.info(`[AgentOS] Filtered phantom tool calls: ${effectiveToolCalls.length} → ${realToolCalls.length}`);
			// 为被过滤的 phantom 工具补 tool_result + tool_end
			for (const tc of effectiveToolCalls) {
				if (realToolCalls.includes(tc)) { continue; }
				yield { type: 'tool_result', content: `工具 "${tc.name}" 为 UI 指示器，已跳过`, toolCallId: tc.id };
				yield { type: 'tool_end', toolCallId: tc.id, success: true };
				endedToolIds.add(tc.id);
			}
			effectiveToolCalls = realToolCalls;
		}

		// ─── Supervisor handoff: 拦截 transfer_to_agent（来源 A, 设计 §3.3）────
		// 多 agent 图模式下节点借 builtin 交接工具发出路由指令；此处拦截、不真正
		// 执行，生成 AgentCommand 让 runAgentGraph（Step C）路由到下一节点。
		// 单 agent 模式该工具已被 _getEnabledTools 过滤（不会到达此处）→ 零行为变更。
		const handoffCall = effectiveToolCalls.find(tc => tc.name === TRANSFER_TO_AGENT_TOOL);
		if (handoffCall) {
			let parsed: Record<string, unknown> = {};
			try {
				parsed = typeof handoffCall.arguments === 'string'
					? JSON.parse(handoffCall.arguments)
					: (handoffCall.arguments as Record<string, unknown>) ?? {};
			} catch { parsed = {}; }
			const command = buildHandoffCommand(parsed, request.agentGraph);
			// 标记结束，避免 UI 孤儿 tool_start 转圈
			if (startedToolIds.has(handoffCall.id)) {
				yield { type: 'tool_end', toolCallId: handoffCall.id, success: !!command };
				endedToolIds.add(handoffCall.id);
			}
			if (command) {
				runState = applyCommandToState(runState, command);
				this._logService.info(`[AgentOS] Handoff → goto=${JSON.stringify(command.goto)}, summary=${(command.summary ?? '').slice(0, 80)}`);
				runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'idle' });
				yield { type: 'done' };
				return command;
			}
			// 无法生成 command（graph 缺失或 node_id 非法）：移除该 call，继续正常流程
			this._logService.warn(`[AgentOS] transfer_to_agent present but no valid command (graph=${request.agentGraph ? 'present' : 'absent'}) — dropping handoff call`);
			effectiveToolCalls = effectiveToolCalls.filter(tc => tc.name !== TRANSFER_TO_AGENT_TOOL);
		}

			// 将助手消息添加到消息历史
			// 注意用 trim() 判定：被 sanitize 清洗后可能残留纯空白（'   ' / '\n'），
			// 若原样 push 进历史，下一轮会把这条"空白 assistant 消息"再喂回 LLM
			// （即用户看到的"发送空消息给 llm"）。纯空白且无工具调用时不入历史。
			const trimmedAssistantContent = assistantContent.trim();
			if (trimmedAssistantContent || effectiveToolCalls.length > 0) {
				const assistantMessage: any = {
					role: 'assistant',
					// 落库用 trim 后的内容，杜绝纯空白污染历史
					content: trimmedAssistantContent,
				};
				// ReAct: 将 native thinking 注入 reasoning 字段。
				// messageFormatConverter 会在转 OpenAI/Anthropic/Gemini 格式时
				// 将其合并到 content 中（<thinking>...</thinking> 前缀），使模型在
				// 下一轮迭代中能"看见"自己的思考过程。
				if (thinkingContent) {
					assistantMessage.reasoning = thinkingContent;
				}
				if (effectiveToolCalls.length > 0) {
					assistantMessage.toolCalls = effectiveToolCalls;
				}
				messages = appendMessages(messages, assistantMessage);

				// ─── Hermes-style 消息边界事件（治本根因修复）─────────────────
				// 把"本 iteration 的 assistant 边界"显式告知下游持久化层，让 chatService
				// 不再 `fullContent += delta` 把多轮文本压扁成一条。content 为本轮权威
				// 文本（已 sanitize+trim），toolCallIds 为本轮工具调用 id。后续 tool_result
				// 仍按 id 跨事件回填，因此这里只需声明归属关系。
				yield {
					type: 'assistant_turn' as any,
					content: trimmedAssistantContent,
					metadata: {
						turnIndex: iteration,
						toolCallIds: effectiveToolCalls.map(tc => tc.id),
					},
				};
			}

		if (effectiveToolCalls.length === 0) {
			// ─── 未完成轮安全续跑（对齐 OpenClaw stopReason 结构判定，无文本意图识别）──
			// 仅当本轮"无可见文本 + 无工具调用"才可能是未完成轮：
			//   - 'reasoning-only'：只有思考块、无可见答案（模型想做但没落地）
			//   - 'empty'：全空（既无文本也无思考、无工具调用）
			//   - 'length'：被 token 上限截断（finishReason=length）
			// 命中则在次数上限内注入续跑指令 + discard_prior_text（防历史污染），然后续跑；
			// 超限则丢弃空/幻觉文本后正常结束。有可见文本（正常终轮）不触发。
			const hasVisibleText = trimmedAssistantContent.length > 0;
			const hasThinking = !!thinkingContent && thinkingContent.trim().length > 0;
			const incompleteKind = classifyIncompleteTurn({
				finishReason: lastFinishReason,
				hasVisibleText,
				hasThinking,
				hasToolCalls: false,
			});
			const used =
				incompleteKind === 'reasoning-only' ? reasoningOnlyRetryAttempts
				: incompleteKind === 'length' ? lengthTruncatedRetryAttempts
				: emptyResponseRetryAttempts;
			// 维度 2+4：按 attempt 获取升级阶梯指令（L1 soft remind / L2 final chance）
			const retryInstruction = resolveIncompleteTurnRetryInstruction(incompleteKind, used + 1);
			if (retryInstruction && incompleteKind !== 'complete') {
				const limit = incompleteTurnRetryLimit(incompleteKind);
				if (used < limit) {
					if (incompleteKind === 'reasoning-only') { reasoningOnlyRetryAttempts++; }
					else if (incompleteKind === 'length') { lengthTruncatedRetryAttempts++; }
					else { emptyResponseRetryAttempts++; }
					this._logService.warn(
						`[AgentOS] Incomplete turn detected (kind=${incompleteKind}, finishReason=${lastFinishReason ?? 'n/a'}, attempt=${used + 1}/${limit}) — safe retry`,
					);
					// 丢弃本轮空/幻觉文本，避免污染历史（对齐 discard_prior_text 基础设施）
					yield { type: 'discard_prior_text', metadata: { reason: incompleteTurnDiscardReason(incompleteKind) } };
					// 注入续跑指令作为下一轮 user 边界，让模型产出可见答案 / 真正动手
					messages = appendMessages(messages, { role: 'user', content: retryInstruction });
					continue;
				}
				this._logService.warn(
					`[AgentOS] Incomplete turn retries exhausted (kind=${incompleteKind}, finishReason=${lastFinishReason ?? 'n/a'}) — ending conversation`,
				);
			// 超限：丢弃空/幻觉文本后正常结束，避免把污染内容喂回模型
			yield { type: 'discard_prior_text', metadata: { reason: incompleteTurnDiscardReason(incompleteKind) } };
		}

		// ─── Text-without-tools in retry context（结构化信号，非文本意图识别）──
		// 场景：上一轮空响应触发 retry（emptyResponseRetryAttempts > 0），retry 后模型
		// 产出了可见文本但仍无 tool_call。对编码 Agent，这通常是"描述了计划但没动手"。
		// 结构信号：hasVisibleText && !hasToolCalls && emptyResponseRetryAttempts > 0
		// ——不分析文本内容，仅凭"retry 上下文 + 有文无工具"判定。
		// 复用 emptyResponseRetryAttempts 计数器，受 incompleteTurnRetryLimit('empty') 上限保护。
		// 不 discard_prior_text：保留模型计划文本作上下文，让模型在下一轮看到自己的计划并执行。
		if (
			incompleteKind === 'complete' &&
			hasVisibleText &&
			emptyResponseRetryAttempts > 0 &&
			emptyResponseRetryAttempts < incompleteTurnRetryLimit('empty')
		) {
			emptyResponseRetryAttempts++;
			const toolActionReminder = [
				'<system-reminder>',
				'You produced text in the previous step but did not call any tools.',
				'If you were describing a plan or approach, STOP DESCRIBING and TAKE ACTION NOW.',
				'Call the appropriate tool(s) to execute what you just described.',
				'Do not output another plan, description, or summary without taking action.',
				'If the task genuinely requires no tool calls and is complete,',
				'explicitly state "Task complete, no further action needed."',
				'</system-reminder>',
			].join('\n');
			this._logService.warn(
				`[AgentOS] Text-without-tools in retry context (emptyRetryAtt=${emptyResponseRetryAttempts}/${incompleteTurnRetryLimit('empty')}, textLen=${trimmedAssistantContent.length}) — injecting tool-action reminder`,
			);
			messages = appendMessages(messages, { role: 'user', content: toolActionReminder });
			continue;
		}

			// 没有工具调用 — 检查是否需要反思阶段
				// ─── Plan-Execute-Reflect 模式 ──────────────────────────
				// 当 LLM 执行过工具并给出最终回复后，注入反思提示让它自查是否有遗漏。
				// 参考 OpenSearch ML Commons 的 PLAN_EXECUTE_AND_REFLECT Agent 类型。
				if (runState.hasModifiedFiles && runState.reflectCount < MAX_REFLECT_ITERATIONS && trimmedAssistantContent) {
					runState = reduceRunState(runState, { type: 'REFLECT' });
					this._logService.info(`[AgentOS] Entering reflect phase (${runState.reflectCount}/${MAX_REFLECT_ITERATIONS})`);
					// Reconcile orphaned tool_starts before reflect
					for (const orphanId of startedToolIds) {
						if (!endedToolIds.has(orphanId)) {
							const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: '工具在反思阶段已跳过' })));
							yield { type: 'tool_result', content: orphanResultStr, toolCallId: orphanId };
							yield { type: 'tool_end', toolCallId: orphanId, success: false };
							endedToolIds.add(orphanId);
						}
					}
					// 注入反思提示，让 LLM 检查工作是否有遗漏
					yield { type: 'text', content: '\n\n---\n**[Reflection Phase]** Reviewing completed work...' };
					messages = appendMessages(messages, {
						role: 'user',
						content:
							'Before finalizing, please review your completed work:\n' +
							'1. Did you modify all necessary files? Are there missing imports or references?\n' +
							'2. Are there any compilation errors or lint warnings you should fix?\n' +
							'3. Did you handle edge cases and error paths?\n' +
							'4. Are your changes complete, consistent, and tested?\n\n' +
							'If you find issues, fix them now using the appropriate tools.\n' +
							'If everything is correct, provide your final summary.',
					});
					continue; // 进入反思迭代
				}

				// 反思已完成或无需反思 — 真正结束
				this._logService.info('[AgentOS] No tool calls, ending conversation' + (runState.reflectCount > 0 ? ` (after ${runState.reflectCount} reflect phase(s))` : ''));
				// Reconcile orphaned tool_starts before ending (e.g., phantom tools
				// that were filtered out had a tool_start but no execution path).
				for (const orphanId of startedToolIds) {
					if (!endedToolIds.has(orphanId)) {
						this._logService.warn(`[AgentOS] Orphaned tool_start at end-of-conversation: ${orphanId} — emitting synthetic tool_result + tool_end`);
						const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: '工具未执行（对话已结束）' })));
						yield { type: 'tool_result', content: orphanResultStr, toolCallId: orphanId };
					yield { type: 'tool_end', toolCallId: orphanId, success: false };
					endedToolIds.add(orphanId);
				}
			}
			// 真正结束前显式置 phase=idle（对齐 UI 结束态，phase 进 runState 供 checkpoint 读取）
			runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'idle' });
			yield { type: 'done' };
			break;
			}

			// ─── 分离 serverExecuted 工具（服务端已执行，跳过本地执行）──────────
			// Knot AG-UI 等服务端 Agent 会在服务端执行工具并标记 server_executed=true。
			// 这些工具不需要（也不应该）在客户端再次执行——本地没有对应的 provider，
			// 强行执行只会报 "No provider available" 错误，导致 tool card 显示"错误详情"。
			// 标记是否使用了文件修改类工具（用于反思阶段判断）
			if (effectiveToolCalls.length > 0) {
				for (const tc of effectiveToolCalls) {
					if (FILE_MODIFICATION_TOOLS.has(tc.name)) { runState = reduceRunState(runState, { type: 'MARK_FILE_MODIFIED' }); break; }
				}
			}
			//
			// 对于 serverExecuted 的工具：
			//   - 发送 tool_result（占位成功结果）+ tool_end(success=true)
			//   - 不添加到 messages 历史中的 tool 消息（服务端已将结果融入后续文本）
			//   - 标记 endedToolIds 避免孤儿检测重复发送
			//
			// [Sarosis] Server-executed tool detection:
			// 由 IModelProvider.isServerSideProvider 决定（不再硬编码 providerId）。
			// - Knot AG-UI: provider 内部封装了完整 agent 循环，chat() 流中
			//   包含 tool execution + response → isServerSideProvider = true。
			// - CodeBuddy API: 仅返回 tool call，需客户端本地执行 → false。
			// - 其他 BYOK provider: 默认 false。
			// - Individual tool calls may also carry explicit tc.serverExecuted flag.
			//
			// 🔧 2026-06-10 修复：原来的 isDirectMode 将所有直连模式的工具都视为
			// server-executed，导致 CodeBuddy API 返回的工具调用被跳过，agent loop
			// 一轮即结束（用户反馈："发一条消息就结束了"）。
			// 改为读取 provider 自身的 isServerSideProvider 属性。
			const activeProvider = this._getActiveModelProvider();
			const isServerSideProvider = activeProvider?.isServerSideProvider === true;
			const serverExecutedCalls = effectiveToolCalls.filter(tc =>
				tc.serverExecuted === true || isServerSideProvider
			);
			let localExecutedCalls = isServerSideProvider
				? []
				: effectiveToolCalls.filter(tc => tc.serverExecuted !== true);

		/**
		 * 将工具失败恢复提示追加到结果文本中。
		 * 借鉴 Hermes-Agent: 工具失败后告诉 LLM "试试别的方案"，而非让它盲目重试。
		 */
		function appendRecoveryHint(resultStr: string, toolCallId: string): string {
			const tc = localExecutedCalls.find(c => c.id === toolCallId);
			if (!tc) { return resultStr; }
			const hint = getToolFailureRecoveryHint(tc.name);
			if (!hint) { return resultStr; }
			return resultStr + `\n\n[Hint: ${hint}]`;
		}

		if (serverExecutedCalls.length > 0) {
				this._logService.info(`[AgentOS] ${serverExecutedCalls.length} tool calls were server-executed (skipping local execution): ${serverExecutedCalls.map(tc => tc.name).join(', ')}`);
				for (const tc of serverExecutedCalls) {
					const serverResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({
						ok: true,
						serverExecuted: true,
						note: 'Tool was executed on the server side; result incorporated into subsequent model response.',
					})));
					// 添加 tool message 到历史（即使结果是占位的），确保 messages 中
					// 每个 assistant toolCall 都有对应的 tool result，否则模型可能困惑。
					// 但如果所有工具都是 serverExecuted 且即将 break，则无需添加
					// （因为不会再有下一轮迭代）。
					if (localExecutedCalls.length > 0) {
						messages = appendMessages(messages, {
							role: 'tool',
							content: serverResultStr,
							toolCallId: tc.id,
						});
					}
					yield {
						type: 'tool_result',
						content: serverResultStr,
						toolCallId: tc.id,
					};
					yield {
						type: 'tool_end',
						toolCallId: tc.id,
						success: true,
					};
					endedToolIds.add(tc.id);
				}

				// 如果所有工具都是服务端执行的，不需要继续 agent loop —
				// 服务端 Agent（如 Knot）会在同一次 chat() 流中完成所有工具
				// 调用循环并返回后续文本，客户端不应再发起新一轮 LLM 请求。
				if (localExecutedCalls.length === 0) {
					this._logService.info('[AgentOS] All tool calls were server-executed — ending local agent loop (server handles the loop)');
					yield { type: 'done' };
					break;
				}
			}

			// ─── 执行工具调用（仅本地需要执行的）────────────────────────
			// Wrap in try/catch so any provider/internal exception cannot break the
			// generator before we have a chance to yield tool_end + done.
			//
			// CRITICAL FIX (用户反馈："工具一直在转圈，明明已经完成任务了还在执行"):
			// We previously did `await Promise.all(...)` then yielded tool_end for each
			// tool. This means a fast tool (file_read, 60ms) would have its tool_end
			// blocked for 60+ seconds waiting for a slow sibling (search_files timing
			// out at 60s). The UI saw all spinners spinning for the whole duration of
			// the slowest tool — the user's exact complaint.
			//
			// Fix: stream results as each individual tool finishes, so each tool_end
			// flushes to the UI at its real completion time. We collect into
			// `toolResults` for the message history while streaming.
			const canParallel = shouldParallelizeToolBatch(localExecutedCalls);
			// 防止沙箱确认重提示死循环：同一 toolCallId 在一个迭代内只提示一次，
			// 重执行后若仍被拦截（如持久化失败）则不再提示，直接保留失败。
			const handledSandboxIds = new Set<string>();
			const toolResults: Array<{ toolCallId: string; content: any; success: boolean }> = [];
			// If all tool calls were server-executed, skip the local execution block entirely.
		if (localExecutedCalls.length > 0) {
			// ── Tool Call Loop Detection（借鉴 OpenClaw `detectToolCallLoop`）──────
			// 在执行前检测同一工具+相同参数的重复调用
			const filteredCalls = localExecutedCalls.filter(tc => {
				const rawArgs = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {});
				let args: Record<string, unknown>;
				try { args = JSON.parse(rawArgs) as Record<string, unknown>; } catch { args = {}; }
				const argsHash = JSON.stringify(args ?? {}).slice(0, 200);
				const { loop, count } = detectToolCallLoop(runState.toolCallHistory, tc.name, args);
				// 无论是否 loop，都记录到历史（对齐原内联函数无条件 push）
				runState = reduceRunState(runState, { type: 'RECORD_TOOL_CALL', name: tc.name, argsHash });
				if (loop) {
					this._logService.warn(`[AgentOS] Tool call loop detected: "${tc.name}" called ${count} times with same args — blocking`);
					return false;  // 阻止执行
				}
				return true;
			});
			if (filteredCalls.length < localExecutedCalls.length) {
				// 为被阻止的工具生成错误结果
				const blockedCalls = localExecutedCalls.filter(tc => !filteredCalls.includes(tc));
				for (const tc of blockedCalls) {
					toolResults.push({
						toolCallId: tc.id,
						content: [{ type: 'text', text: `Error: Tool "${tc.name}" was called too many times with the same arguments. This looks like a loop — try a different approach or provide more specific arguments.` }],
						success: false,
					});
					yield { type: 'tool_start', content: '', toolCallId: tc.id, toolName: tc.name };
					yield { type: 'tool_result', content: `工具 "${tc.name}" 因重复调用已被跳过（疑似循环）`, toolCallId: tc.id };
					yield { type: 'tool_end', toolCallId: tc.id, success: false };
					endedToolIds.add(tc.id);
				}
				if (filteredCalls.length === 0) {
					// 全部被阻止 → 跳过执行，直接进入下一轮
					this._logService.warn(`[AgentOS] All ${localExecutedCalls.length} tool calls blocked by loop detection`);
					for (const tr of toolResults) {
						messages = appendMessages(messages, { role: 'tool', content: (tr.content[0] as any)?.text ?? '', toolCallId: tr.toolCallId });
					}
					continue;
				}
				localExecutedCalls = filteredCalls;
			}
			// ── Hook: pre_tool_use ────────────────────────────────────────
			if (memoryProvider?.triggerHook) {
			for (const tc of localExecutedCalls) {
				memoryProvider.triggerHook('pre_tool_use', {
					agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
					toolName: tc.name, toolCallId: tc.id,
				}).catch(() => {});
			}
		}
		// 进入工具执行前显式置 phase=tool_executing（对齐 UI 广播，phase 进 runState 供 checkpoint 读取）
		runState = reduceRunState(runState, { type: 'SET_PHASE', phase: 'tool_executing' });
		try {
			if (canParallel) {
						// Streaming parallel: yield as each tool finishes, in completion order.
						for await (const toolResult of this._executeToolCallsParallelStreaming(localExecutedCalls, request.agentId, request.worktreePath, turnAbortSignal)) {
							toolResults.push(toolResult);
							// R1: per-tool-call observe (对齐 agentmemory PostToolUse Hook → mem::observe)
							this._observeToolResult(request.agentId, toolResult);
							// ── 连续失败追踪 ─────────────────────────────────
							const _tc = localExecutedCalls.find(c => c.id === toolResult.toolCallId);
							const _tname = _tc?.name ?? 'unknown';
							if (!toolResult.success) {
								_toolConsecutiveFailures.set(_tname, (_toolConsecutiveFailures.get(_tname) ?? 0) + 1);
								// 达到阈值时注入 system-reminder，引导 LLM 读错误信息并换策略
								if ((_toolConsecutiveFailures.get(_tname) ?? 0) >= MAX_CONSECUTIVE_TOOL_FAILURES) {
									this._logService.warn(
										`[AgentOS][Diag] Tool "${_tname}" failed ${MAX_CONSECUTIVE_TOOL_FAILURES}+ times consecutively — injecting system-reminder`,
									);
									const reminder = [
										'<system-reminder>',
										`The tool "${_tname}" has failed ${MAX_CONSECUTIVE_TOOL_FAILURES} times in a row.`,
										'READ THE ERROR MESSAGE CAREFULLY and fix the specific issue instead of retrying with similar arguments.',
										'If you are unsure about the correct parameters, use a different tool or ask the user for clarification.',
										'Do NOT retry with the same pattern — each failure costs a turn.',
										'</system-reminder>',
									].join('\n');
									messages = appendMessages(messages, { role: 'user', content: reminder });
								}
							} else {
								_toolConsecutiveFailures.clear(); // 成功重置
							}
							const rawStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(toolResult.content)));
							const resultStr = !toolResult.success
								? appendRecoveryHint(rawStr, toolResult.toolCallId)
								: rawStr;
							messages = appendMessages(messages, {
								role: 'tool',
								content: resultStr,
								toolCallId: toolResult.toolCallId,
							});
							yield {
								type: 'tool_result',
								content: resultStr,
								toolCallId: toolResult.toolCallId,
							};
							yield {
								type: 'tool_end',
								toolCallId: toolResult.toolCallId,
								success: toolResult.success,
							};
							endedToolIds.add(toolResult.toolCallId);
						}
					} else {
						// Serial path: keep old behavior (each tool naturally finishes
						// sequentially so head-of-line blocking is not an issue here).
						const serial = await this._executeToolCalls(localExecutedCalls, request.agentId, request.worktreePath, turnAbortSignal);
						for (const toolResult of serial) {
							// ─── 沙箱确认（完整暂停等待）──────────────────────────
							// 工具因安全沙箱限制失败时，暂停 agent loop，向原生 chat
							// 弹出确认卡片，等待用户决策（允许本次 / 允许此工作区 /
							// 改用建议路径 / 取消），再按决策重执行或保留失败。
							const sr = toolResult as unknown as { toolCallId: string; content: any; success: boolean; metadata?: { sandboxViolation?: ISandboxViolationInfo } };
							let finalResult = toolResult;
							if (!sr.success && this._isSandboxViolation(sr) && !handledSandboxIds.has(sr.toolCallId)) {
								handledSandboxIds.add(sr.toolCallId);
								const v = sr.metadata!.sandboxViolation!;
								const tc = localExecutedCalls.find(c => c.id === toolResult.toolCallId);
								const toolName = tc?.name ?? toolResult.toolCallId;
								const confirmationId = `sandbox-${toolResult.toolCallId}-${Date.now().toString(36)}`;
								const cf = this._buildSandboxConfirmationCard(toolName, v);
								cf.id = confirmationId;
								// 渲染确认卡片（原生 pane 的 _processDelta 处理 confirmation delta）
								yield { type: 'confirmation', confirmationData: cf };
								const decision = await this._awaitSandboxConfirmation(confirmationId);
								yield {
									type: 'confirmation_resolved',
									confirmationId,
									confirmationStatus: this._mapDecisionToCardStatus(decision),
								};
								if (tc) {
									finalResult = await this._reExecuteAfterSandbox(
										tc, request.agentId, request.worktreePath, turnAbortSignal, decision, v,
									);
								}
							}
							toolResults.push(finalResult);
							// R1: per-tool-call observe
							this._observeToolResult(request.agentId, finalResult);
							// ── 连续失败追踪 ─────────────────────────────────
							const _stc = localExecutedCalls.find(c => c.id === finalResult.toolCallId);
							const _stname = _stc?.name ?? 'unknown';
							if (!finalResult.success) {
								_toolConsecutiveFailures.set(_stname, (_toolConsecutiveFailures.get(_stname) ?? 0) + 1);
								if ((_toolConsecutiveFailures.get(_stname) ?? 0) >= MAX_CONSECUTIVE_TOOL_FAILURES) {
									this._logService.warn(
										`[AgentOS][Diag] Tool "${_stname}" failed ${MAX_CONSECUTIVE_TOOL_FAILURES}+ times consecutively — injecting system-reminder`,
									);
									const reminder = [
										'<system-reminder>',
										`The tool "${_stname}" has failed ${MAX_CONSECUTIVE_TOOL_FAILURES} times in a row.`,
										'READ THE ERROR MESSAGE CAREFULLY and fix the specific issue instead of retrying with similar arguments.',
										'If unsure about the correct parameters, use a different tool or ask the user.',
										'</system-reminder>',
									].join('\n');
									messages = appendMessages(messages, { role: 'user', content: reminder });
								}
							} else {
								_toolConsecutiveFailures.clear();
							}
							const rawStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(finalResult.content)));
							const resultStr = !finalResult.success
								? appendRecoveryHint(rawStr, finalResult.toolCallId)
								: rawStr;
							messages = appendMessages(messages, {
								role: 'tool',
								content: resultStr,
								toolCallId: finalResult.toolCallId,
							});
							yield {
								type: 'tool_result',
								content: resultStr,
								toolCallId: finalResult.toolCallId,
							};
							yield {
								type: 'tool_end',
								toolCallId: finalResult.toolCallId,
								success: finalResult.success,
							};
							endedToolIds.add(finalResult.toolCallId);
						}
					}
				} catch (execErr) {
					this._logService.error(`[AgentOS] Tool execution batch threw unexpectedly:`, execErr);
					// Synthesize failed results for every tool that did NOT yet emit tool_end.
					// This guarantees every started tool_call is terminated on the wire.
					for (const tc of localExecutedCalls) {
						if (endedToolIds.has(tc.id)) { continue; }
						const errResult = {
							toolCallId: tc.id,
							content: { error: `Tool execution failed: ${execErr instanceof Error ? execErr.message : String(execErr)}` },
							success: false,
						};
						toolResults.push(errResult);
						const resultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult(errResult.content)));
						messages = appendMessages(messages, {
							role: 'tool',
							content: resultStr,
							toolCallId: tc.id,
						});
						yield { type: 'tool_result', content: resultStr, toolCallId: tc.id };
						yield { type: 'tool_end', toolCallId: tc.id, success: false };
						endedToolIds.add(tc.id);
					}
				}
			} // end if (localExecutedCalls.length > 0)

			// ─── Update Delegation Ledger with tool results（借鉴 deer-flow）──────
			// After tool execution, update the ledger so subsequent LLM turns
			// see the correct status of each delegated sub-agent task.
			for (const tr of toolResults) {
				const tc = localExecutedCalls.find(c => c.id === tr.toolCallId);
				if (!tc || !this._subagentLimitMw.isDelegationCall(tc)) { continue; }

				const resultText = typeof tr.content === 'string'
					? tr.content
					: (tr.content?.text ?? (tr.content?.error ? `Error: ${tr.content.error}` : JSON.stringify(tr.content ?? '')));

				if (tr.success) {
					this._delegationLedger.markCompleted(tc.id, resultText);
				} else {
					this._delegationLedger.markFailed(tc.id, resultText);
				}
			}

			// Persist updated ledger into durable context so it survives
			// summarization compression on the next round.
			this._durableContext.updateFromLedger(this._delegationLedger.getAllEntries());

			// ── Hook: post_tool_use / post_tool_failure ───────────────────
			if (memoryProvider?.triggerHook) {
				for (const tr of toolResults) {
					const tc = localExecutedCalls.find(c => c.id === tr.toolCallId);
					memoryProvider.triggerHook(tr.success ? 'post_tool_use' : 'post_tool_failure', {
						agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
						toolName: tc?.name ?? '', toolCallId: tr.toolCallId,
						toolResult: typeof tr.content === 'string' ? tr.content.slice(0, 2000) : JSON.stringify(tr.content ?? '').slice(0, 2000),
						error: tr.success ? undefined : (typeof tr.content === 'string' ? tr.content.slice(0, 2000) : JSON.stringify(tr.content ?? '').slice(0, 2000)),
					}).catch(() => {});
				}
			}

			// ─── Reconcile: emit synthetic tool_end for any orphaned tool_start ──
			// IDs that received tool_start but never tool_end (lost via dedup,
			// phantom filter, missing provider, or any other early-return path)
			// must be terminated, otherwise their webview tool cards will spin
			// forever. We emit success=false so users can see they did not run.
			for (const orphanId of startedToolIds) {
				if (!endedToolIds.has(orphanId)) {
					this._logService.warn(`[AgentOS] Orphaned tool_start without tool_end: ${orphanId} — emitting synthetic tool_result + tool_end (success=false)`);
					const orphanResultStr = sanitizeToolResultText(limitToolResultSize(safeStringifyToolResult({ note: '工具未执行（可能已被过滤、去重或无匹配的 provider）' })));
					yield {
						type: 'tool_result',
						content: orphanResultStr,
						toolCallId: orphanId,
					};
					yield {
						type: 'tool_end',
						toolCallId: orphanId,
						success: false,
					};
					endedToolIds.add(orphanId);
				}
			}

			// ─── Guardrail: too many failed tool calls → break ──────
			const failedCount = toolResults.filter(r => !r.success).length;
			if (failedCount === toolResults.length && toolResults.length > 0) {
				// All tools failed — check if they are "tool not found" errors
				const allNotFound = toolResults.every(r => {
					const content = JSON.stringify(r.content);
					return content.includes('does not exist') || content.includes('not available');
				});
				if (allNotFound) {
					runState = reduceRunState(runState, { type: 'INVALID_TOOL_NAME' });
					if (runState.invalidToolNameCount >= MAX_INVALID_TOOL_RETRIES) {
						this._logService.warn(`[AgentOS] Too many invalid tool name attempts (${runState.invalidToolNameCount}), ending loop`);
						yield { type: 'done' };
						break;
					}
				}
			}

			// ─── shouldTerminateToolBatch（借鉴 OpenClaw）──────────────
			// 所有工具返回 terminate=true 时提前结束 agent loop
			// 当前 Sarosis 的 IToolResult 没有 terminate 字段，但预留接口
			// 为将来扩展（如 "任务已完成"信号工具）做准备
			if (toolResults.length > 0 && toolResults.every(r => (r as any).terminate === true)) {
				this._logService.info(`[AgentOS] All ${toolResults.length} tool results signaled terminate — ending loop early`);
				yield { type: 'done' };
				break;
			}

			// ─── codebase memory 工具调用检测 ──────────────────────────────────
			// 当 LLM 调用 codebase-memory MCP 工具时，yield codebase_operation 事件
			// 供前端系统消息面板显示
			for (const tc of effectiveToolCalls) {
				if (tc.name.includes('codebase') || tc.name.includes('index_repository') ||
					tc.name.includes('search_graph') || tc.name.includes('search_code') ||
					tc.name.includes('trace_path') || tc.name.includes('get_architecture') ||
					tc.name.includes('detect_changes') || tc.name.includes('list_projects')) {
					const opMap: Record<string, string> = {
						index_repository: 'index', search_graph: 'graph', search_code: 'search',
						trace_path: 'trace', get_architecture: 'graph', detect_changes: 'changes',
						list_projects: 'index', get_code_snippet: 'search', index_status: 'index',
					};
					let op = 'search';
					for (const [key, val] of Object.entries(opMap)) {
						if (tc.name.includes(key)) { op = val; break; }
					}
					// 解析工具参数，供前端显示详细内容
					let argsSummary = '';
					try {
						const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
						if (args) {
							const parts: string[] = [];
							for (const [k, v] of Object.entries(args)) {
								const valStr = typeof v === 'string' ? v : JSON.stringify(v);
								parts.push(`${k}: ${valStr.length > 100 ? valStr.slice(0, 100) + '...' : valStr}`);
							}
							argsSummary = parts.join(', ');
						}
					} catch { /* ignore parse errors */ }
					yield {
						type: 'codebase_operation' as any,
						content: tc.name,
						metadata: { operation: op, toolName: tc.name, args: argsSummary },
					} as any;
				}
			}

			// ─── per-iteration memory write（对齐 ExecutionProvider 7.7）──────────
			// Direct Mode 之前完全没有 per-iteration memory write，仅靠 AgentDriver
			// 的 finally 块在整轮结束时写一条 user + 一条 assistant。这意味着：
			// 1. 工具执行结果未被记忆
			// 2. 长对话被中断时，中间轮次的记忆丢失
			// 这里补全 fire-and-forget writeMemory，与 ExecutionProvider 行为对齐。
			const memProvider = this.getActiveMemoryProvider();
			if (memProvider && (trimmedAssistantContent || toolResults.length > 0)) {
				const memTs = Date.now();
				const toolSummary = toolResults.length > 0
					? ` [工具: ${effectiveToolCalls.map(tc => tc.name).join(', ')}]`
					: '';
				// yield 记忆事件：仅显示记忆操作信息（不含工具调用详情，避免 Bug 1）
				// 同时传递 contentPreview 作为稳定标识符，供 EditorPane 精确匹配 AgentMemory 记忆
				const assistantContentPreview = (trimmedAssistantContent || '').slice(0, 120);
				const iterNoticeId = `mem-l0-iter-${memTs}`;
				yield {
					type: 'memory_writing',
					content: `Working 写入中`,
					metadata: {
						memoryType: 'working',
						assistantContentPreview,
						iteration,
						noticeId: iterNoticeId,
					},
				};
				void (async () => {
					try {
						await memProvider.writeMemory(request.agentId, {
							id: `memory-iter-${memTs}`,
							type: 'working',
							content: (trimmedAssistantContent || 'Tool execution completed') + toolSummary,
							metadata: {
								owner: 'default',
								userId: 'default',
								agentId: request.agentId,
								workspaceId: this._currentWorkspaceId,
								role: 'assistant',
								toolCalls: effectiveToolCalls.length,
								toolResults: toolResults.length,
								iteration,
								sessionId: request.sessionId,
								noticeId: iterNoticeId,
							},
							timestamp: memTs,
						});
					} catch (error) {
						this._logService.error('[AgentOS] Failed to write per-iteration memory:', error);
					}
				})();
			}
		} // end while

		// ─── 每轮 turn 结束：把本轮新增对话增量外置到记忆（延续检索式上下文，
		// 而非只在压缩时才外置），供后续 turn 检索取回，逐步累积历史上下文。──
		if (RETRIEVAL_COMPACTION_ENABLED) {
			const rpEnd = this.getActiveMemoryProvider();
			if (rpEnd && (rpEnd as any).recallFormatted) {
				await this._storeTurnObservations(rpEnd, request.agentId ?? 'default', request.sessionId ?? '', messages);
			}
		}

		if (iteration >= MAX_TOOL_ITERATIONS) {
			this._logService.warn(`[AgentOS] Reached max tool iterations (${MAX_TOOL_ITERATIONS})`);
			yield { type: 'done' };
		}
		// 显式 return undefined：generator TReturn = AgentCommand | undefined，
		// 覆盖函数末尾自然结束路径（对齐 TS7030 要求所有路径返回值）。
		return undefined;
	}

	/**
	 * 获取指定 agent 的已启用工具列表
	 *
	 * 三层分离架构（参考 Hermes-Agent）：
	 *   1. Assembly 层 (toolSearchAssembler.ts): classify + threshold gate + bridge schema
	 *   2. Dispatch 层 (toolSearchDispatcher.ts): catalog + BM25 + scope 门控
	 *   3. Executor 层 (本文件): unwrap tool_call 为真实工具名，走完整 guardrail/approval 链
	 */
	private async _getEnabledTools(agentId: string, agentGraph?: AgentGraph, toolsetsOverride?: string[], hardPermission?: IHardPermissionPolicy): Promise<IToolDefinition[]> {
		// 类型别名：工具定义 + 运行时 toolset 推断 + enabled 状态
		type TTool = IToolDefinition & { enabled: boolean; toolset: string };

		// 实时查表 model context length（对齐 Hermes `_resolve_active_context_length` 每次实时查）
		// 失败/未设置时回退 undefined → assembleToolDefs 自动走 20K token 固定阈值
		const contextWindow = (this._currentModelProvider && this._currentModelId)
			? await this._resolveContextWindow(this._currentModelProvider, this._currentModelId)
			: undefined;

		const allWithState = await this.listAllToolsWithState(agentId);
		const enabled = allWithState.filter(t => t.enabled) as TTool[];
		// 缓存全量已启用工具名（不受 MAX_VISIBLE_TOOLS 截断影响，供白名单过滤用）
		this._lastAllEnabledToolNames = new Set(enabled.map(t => t.name));

		// 多维缓存键（对齐 Hermes `model_tools.get_tool_definitions` 的 cache_key）
		// 维度：agentId | registryGeneration | configFingerprint | contextWindow | 工具状态快照
		const cacheKey = [
			agentId,
			this._registryGeneration,
			this._getConfigFingerprint(),
			contextWindow ?? 'undefined',
			...allWithState.map(t => `${t.name}:${t.enabled ? '1' : '0'}`).sort(),
		].join('|');

		// LRU 命中检查（Map 保持插入顺序，命中时 re-insert 移到末尾实现 LRU）
		const cached = this._cachedToolDefs.get(cacheKey);
		if (cached) {
			this._cachedToolDefs.delete(cacheKey); // 移到末尾（LRU 语义）
			this._cachedToolDefs.set(cacheKey, cached);
		this._logService.info(`[AgentOS] _getEnabledTools: cache hit — ${cached.length} tools (gen=${this._registryGeneration}, ctxWin=${contextWindow ?? '?'})`);
		// hardPermission:INVARIANT layer applied AFTER cache (so the unfiltered list
		// stays cached and chatMode toggles re-evaluate correctly).
		return applyHardPermission(cached, hardPermission);
		}

		// 缓存未命中：清理可能存在的旧版本（不同 ctxWindow 会有多个旧 key）
		// 超过上限时驱逐最旧（Map 头部）
		while (this._cachedToolDefs.size >= AgentOSService.TOOL_DEFS_CACHE_MAX) {
			const oldest = this._cachedToolDefs.keys().next().value;
			if (oldest !== undefined) {
				this._cachedToolDefs.delete(oldest);
			}
		}

		// Step 1: 分离 MCP 工具，按服务器创建动态 toolset（对齐 Hermes-Agent `mcp-{server}` 模式）
		const mcpOriginal = enabled.filter(t => t.category?.startsWith('mcp:'));
		const builtin = enabled.filter(t => !t.category?.startsWith('mcp:'));

		// 提取 MCP 服务器名并创建 per-server toolset
		// category 格式: "mcp:server_name" → toolset: "mcp-server_name"
		const mcpToolsetByServer = new Map<string, string[]>(); // server → tool names
		for (const t of mcpOriginal) {
			const server = (t.category as string).replace(/^mcp:/, '');
			if (!mcpToolsetByServer.has(server)) {
				mcpToolsetByServer.set(server, []);
			}
			mcpToolsetByServer.get(server)!.push(t.name);
		}
		if (mcpToolsetByServer.size > 0) {
			const servers = [...mcpToolsetByServer.entries()].map(([s, tools]) => `${s}(${tools.length})`).join(', ');
			this._logService.info(`[AgentOS] _getEnabledTools: MCP servers detected — ${servers}`);
		}

		// Step 2: 推断 toolset（toolsetConfig 的 auto-infer）
		const tagged: TTool[] = builtin.map(t => ({
			...t,
			toolset: (t.toolset ?? getToolsetForTool(t.name)) as string,
		}));
		// MCP 工具按服务器分配独立 toolset：`mcp-{server}`（对齐 Hermes-Agent `mcp-{server}`）
		// 每个 toolset 有 Medium 优先级且可延迟，单独可控
		const mcpTagged: TTool[] = mcpOriginal.map(t => {
			const server = (t.category as string).replace(/^mcp:/, '');
			return {
				...t,
				toolset: `mcp-${server}`,  // 动态 toolset，Medium priority, deferrable
			};
		});

		// Step 3: Agent.tools[] + enabledToolsets + disabledToolsets 配置过滤
		const agentTools = this._getAgentToolsConfig(agentId);
		const agentToolsets = this._getAgentEnabledToolsets(agentId);
		const agentDisabledToolsets = this._getAgentDisabledToolsets(agentId);
		const allTagged = [...tagged, ...mcpTagged];
		let scoped = allTagged;

		// Step 3a: 自动 focus 模式（对齐 Hermes `auto` / `focus` 编码姿态切换）
		// 仅在用户未显式设置 enabledToolsets 时生效
		if (!agentToolsets?.length) {
			const focusResult = await this._detectFocusModeIfNeeded();
			if (focusResult.mode === 'focus' && focusResult.recommendedToolsets.length > 0) {
			const focusSet = new Set(focusResult.recommendedToolsets);
			// 后向兼容：focus 模式推荐了 'mcp'（旧的统一 toolset），
			// 也需匹配新的动态 `mcp-{server}` toolset(s)
			const hasMcpLegacy = focusSet.has('mcp');
			const beforeFocus = scoped.length;
			scoped = scoped.filter(t =>
				focusSet.has(t.toolset) || isBridgeTool(t.name)
				// Core protection: Always-priority tools survive focus narrowing
				|| getToolsetPriority(t.toolset) === ToolsetPriority.Always
				// 动态 MCP toolset: 当 focus 模式包含旧式 'mcp' 时，允许所有 mcp-{server}
				|| (hasMcpLegacy && t.toolset.startsWith('mcp-'))
			);
				this._logService.info(`[AgentOS] _getEnabledTools: focus mode auto-applied [${focusResult.recommendedToolsets.join(', ')}] (${focusResult.reason}) -> ${scoped.length}/${beforeFocus} tools`);
			}
		}

		// 按 toolset 过滤：只保留 Agent 声明的 toolset 中的工具
		if (agentToolsets?.length) {
			const toolsetSet = new Set(agentToolsets);
			scoped = scoped.filter(t =>
				toolsetSet.has(t.toolset) || isBridgeTool(t.name)
			);
			this._logService.info(`[AgentOS] _getEnabledTools: agent ${agentId} enabledToolsets [${agentToolsets.join(', ')}] -> ${scoped.length}/${allTagged.length} tools`);
		}
		if (agentTools?.length) {
			const toolSet = new Set(agentTools);
			scoped = allTagged.filter(t =>
				toolSet.has(t.name) || isBridgeTool(t.name)
				// Core protection: an explicit `tools` allowlist narrows OPTIONAL
				// tools, but must not strip Always-priority core tools (e.g.
				// delegate_task). The `tools` field is an allowlist of extras, not a
				// way to disable core capabilities.
				|| getToolsetPriority(t.toolset) === ToolsetPriority.Always
			);
			this._logService.info(`[AgentOS] _getEnabledTools: agent ${agentId} tools config -> ${scoped.length}/${allTagged.length}`);
		}

		// Step 3b: disabledToolsets 减法（对齐 Hermes `model_tools.py:399-433`）
		// 在 enabledToolsets 之后应用，确保即使工具集被 enabled 包含也可以被禁用
		if (agentDisabledToolsets?.length) {
			const beforeDisable = scoped.length;
			const disabledSet = new Set(agentDisabledToolsets);
			scoped = scoped.filter(t => {
				if (isBridgeTool(t.name)) { return true; } // 桥接工具永远保护
				if (!disabledSet.has(t.toolset)) { return true; } // 未禁用
				// 核心保护（对齐 Hermes `bundle_non_core_tools` #33924）：
				// Always 优先级的 toolset 即使在 disabled 列表中也保留（不能让 LLM 失去核心工具）
				if (getToolsetPriority(t.toolset) === ToolsetPriority.Always) { return true; }
				return false; // 剥离
			});
			const afterDisable = scoped.length;
			if (beforeDisable !== afterDisable) {
				this._logService.info(`[AgentOS] _getEnabledTools: agent ${agentId} disabledToolsets [${agentDisabledToolsets.join(', ')}] (with core protection) -> ${afterDisable}/${beforeDisable} tools`);
			}
		}

		// Step 3c: update_plan 门控（对齐 OpenClaw — 默认禁用，高级模型自动启用）
		// OpenClaw: update_plan 仅对 strict-agentic 契约活跃（GPT-5 系列）启用。
		// Sarosis: 模型能力自动检测 + agent 显式配置覆盖。
		const updatePlanEnabled = this._shouldEnableUpdatePlan(agentId);
		if (!updatePlanEnabled) {
			const beforePlan = scoped.length;
			scoped = scoped.filter(t => t.name !== 'update_plan');
			if (beforePlan !== scoped.length) {
				this._logService.info(`[AgentOS] _getEnabledTools: update_plan disabled (model not capable or explicitly disabled) -> ${scoped.length}/${beforePlan} tools`);
			}
		}

		// Step 3d: per-request toolset scope override (v17, delegation).
		// When the caller (delegate_task) asks for a narrowed toolset scope, keep
		// only tools whose toolset is in the override set (plus bridge tools, which
		// are the discovery mechanism). This lets a parent constrain what a
		// sub-agent may do. Undefined → no narrowing (current behavior preserved).
		if (toolsetsOverride?.length) {
			const overrideSet = new Set(toolsetsOverride);
			const beforeOverride = scoped.length;
			scoped = scoped.filter(t =>
				overrideSet.has(t.toolset) || isBridgeTool(t.name)
			);
			this._logService.info(`[AgentOS] _getEnabledTools: toolsetsOverride [${toolsetsOverride.join(', ')}] -> ${scoped.length}/${beforeOverride} tools`);
		}

		// MCP 工具名集合（用于 passthrough 模式下移除直发 MCP 工具，统一通过 tool_search 发现）
		const mcpToolNameSet = new Set(mcpOriginal.map(t => t.name));

		// Step 4: Assembly 层（对齐 Hermes-Agent model_tools.py:534-562）
		// 将所有工具（非 MCP + MCP）传给 assembleToolDefs。
		// classifyTools → isDeferrableTool() 自动正确分离：
		//   - visible: 核心工具（isCoreTool / isCoreToolset / Always 优先级）
		//   - deferrable: MCP + 非核心可 defer 工具
		// 移除了原有的优先级填槽（MAX=30 硬上限）——
		//   核心工具永远直接发送，不做数量截断。
		//   Token 预算阈值（10% 上下文窗口）仍限制 deferrable schema 总大小。
		const nonMcpScoped = scoped.filter(t => !mcpToolNameSet.has(t.name));
		const tsConfig = this._getToolSearchConfig();
		const assembly = assembleToolDefs([...nonMcpScoped, ...mcpTagged], {
			contextLength: contextWindow,
			config: tsConfig,
		});
		let finalTools = assembly.toolDefs;

		// Step 5b: passthrough 时 MCP 工具直发
		// 移除硬上限后（P0），核心工具数量不受限，MCP schema 大小由 token 预算阈值控制。
		// passthrough 时不再移除 MCP 工具 —— 直接发送给 LLM，
		// 避免 codebase 等关键工具因 tool_search 发现消耗额外迭代。
		if (!assembly.activated && mcpOriginal.length > 0) {
			this._logService.info(`[AgentOS] _getEnabledTools: passthrough — ${mcpOriginal.length} MCP tools sent directly to LLM (no hard cap, token budget safe)`);
		}

		// 缓存 Assembly + Dispatcher（Executor 层使用）
		this._lastAssembly = assembly;
		this._lastDispatcherCtx = buildDispatcherContext(assembly, tsConfig);

		// ── 直发诊断日志：本轮直接下发给模型的工具 + 检测到的 MCP 服务器 ──
		{
			const directToolNames = finalTools.filter(t => !isBridgeTool(t.name)).map(t => t.name);
			const mcpServers = [...mcpToolsetByServer.keys()];
			const parts: string[] = [];
			parts.push(`[AgentOS] Direct-sent tools (${directToolNames.length}/${enabled.length}): ${directToolNames.join(', ')}`);
			if (mcpServers.length > 0) {
				parts.push(`| MCP servers (${mcpServers.length}): ${mcpServers.join(', ')} (mcpTools=${mcpOriginal.length})`);
			}
			if (assembly.deferredCount > 0) {
				parts.push(`| deferred via tool_search: ${assembly.deferredCount}`);
			}
			this._logService.info(parts.join(' '));
		}


		// Step 6: 桥接工具排前面
		const BRIDGE_NAMES: Set<string> = new Set([
			TOOL_SEARCH_BRIDGE_TOOLS.search, TOOL_SEARCH_BRIDGE_TOOLS.describe, TOOL_SEARCH_BRIDGE_TOOLS.call,
		]);
		finalTools.sort((a, b) => (BRIDGE_NAMES.has(a.name) ? 0 : 1) - (BRIDGE_NAMES.has(b.name) ? 0 : 1));

		// Step 7: Schema 修正（对齐 Hermes `model_tools.py:454-510`）
		// 修正对不可用工具的描述引用，避免 LLM 幻觉调用
		const beforeCorrection = finalTools.length;
		finalTools = correctSchemaReferences(finalTools);
		if (finalTools.length !== beforeCorrection || finalTools.some((t, i) => t !== finalTools[i])) {
			this._logService.info(`[AgentOS] _getEnabledTools: schema correction applied`);
		}

		// 日志
		if (mcpOriginal.length) {
			this._logService.info(`[AgentOS] _getEnabledTools: ${mcpOriginal.length} MCP tools — ${assembly.activated ? 'folded into unified bridge' : 'sent directly (passthrough, token budget safe)'}`);
		}
		if (assembly.activated) {
			this._logService.info(`[AgentOS] _getEnabledTools: Tool Search activated — ${assembly.deferredCount} deferred (~${assembly.deferredTokens} tokens, thresh ~${assembly.thresholdTokens})`);
		}
		this._logService.info(`[AgentOS] _getEnabledTools: ${finalTools.length}/${enabled.length}/${allWithState.length} tools (assembly-driven) for ${agentId}`);

		// ─── Supervisor handoff 工具可见性（Step B, 设计 §3.3）──────────────
		// transfer_to_agent 仅在多 agent 图模式（≥2 节点）暴露；单 agent 模式 /
		// 非图运行：从工具列表移除，模型看不到 → 永不触发 → 零行为变更。
		if (!agentGraph || Object.keys(agentGraph.nodes).length < 2) {
			const before = finalTools.length;
			finalTools = finalTools.filter(t => t.name !== TRANSFER_TO_AGENT_TOOL);
			if (before !== finalTools.length) {
				this._logService.info(`[AgentOS] _getEnabledTools: handoff tool filtered out (not a multi-agent graph) -> ${finalTools.length}/${before} tools`);
			}
		}

		const result = finalTools.map(({ enabled: _, toolset: __, ...toolDef }) => toolDef);
		// 排序：codebase 分析工具 + 桥接工具排在前面（对齐 OpenClaw toolOrder）
		// 避免 LLM 在前 10 个工具中找到 search_files/terminal 后停止扫描
		const PRIORITY_NAMES = new Set([
			'search_graph', 'query_graph', 'get_architecture', 'trace_path',
			'search_code', 'get_code_snippet', 'index_repository', 'index_status',
			'detect_changes', 'update_plan',
			'tool_search', 'tool_describe', 'tool_call',
		]);
		result.sort((a, b) => {
			const aPri = PRIORITY_NAMES.has(a.name) ? 0 : 1;
			const bPri = PRIORITY_NAMES.has(b.name) ? 0 : 1;
			return aPri - bPri || a.name.localeCompare(b.name);
		});
		// 更新 LRU 缓存
		this._cachedToolDefs.set(cacheKey, result);
		// hardPermission:INVARIANT layer applied AFTER cache (so chatMode toggles
		// re-evaluate correctly; the cached `result` is the unfiltered list).
		this._logService.info(`[AgentOS] _getEnabledTools: cache miss — computed ${result.length} tools (gen=${this._registryGeneration}, ctxWin=${contextWindow ?? '?'})`);
		return applyHardPermission(result, hardPermission);
	}

	/**
	 * Resolve the hard-permission policy for a turn. hardPermission is an INVARIANT
	 * layer applied AFTER all toolset/allowlist filtering in `_getEnabledTools` — tools
	 * it denies can never be re-enabled by config or approval (MiMo hardPermission).
	 * Currently: plan mode locks every write/execute tool.
	 */
	private _resolveHardPermission(request: IAgentTurnRequest): IHardPermissionPolicy | undefined {
		if (request.chatMode === 'plan') {
			return planModeHardPermission();
		}
		return undefined;
	}

	/**
	 * 返回某会话最近一次迭代计算出的冻结前缀（ForkContext），用于 fork 会话时抓取父级
	 * 冻结 system+tools，使子会话请求与父级前缀对齐 → 命中 provider prompt cache。
	 * 会话从未运行过则返回 undefined。
	 */
	getForkContext(sessionId: string): IForkContext | undefined {
		return this._lastForkContextBySession.get(sessionId);
	}

	// _filterToolsForLLM 已被三层分离架构替代（Assembly 层 → assembleToolDefs）

	/**
	 * 获取 Agent 的 tools[] 配置。
	 */
	private _getAgentToolsConfig(agentId?: string): string[] | undefined {
		if (!agentId) { return undefined; }
		try {
			const studioService = (this as any)._studioService;
			if (!studioService) { return undefined; }
			const agents = studioService.getAgentsSync?.();
			if (!agents) { return undefined; }
			const agent = agents.find((a: any) => a.id === agentId);
			return agent?.tools;
		} catch {
			return undefined;
		}
	}

	/**
	 * 获取 Agent 的 enabledToolsets 配置。
	 * 对齐 Hermes 的 `agent.enabled_toolsets`：只发送属于这些 toolset 的工具。
	 *
	 * 未设置或空 → 全部 toolset（向后兼容）。
	 */
	private _getAgentEnabledToolsets(agentId?: string): string[] | undefined {
		if (!agentId) { return undefined; }
		try {
			const studioService = (this as any)._studioService;
			if (!studioService) { return undefined; }
			const agents = studioService.getAgentsSync?.();
			if (!agents) { return undefined; }
			const agent = agents.find((a: any) => a.id === agentId);
			return agent?.enabledToolsets?.length ? agent.enabledToolsets : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 获取 Agent 的 disabledToolsets 配置。
	 * 对齐 Hermes 的 `agent.disabled_toolsets`：在 enabled 之后作为减法步骤应用。
	 *
	 * **核心保护**（对齐 Hermes `bundle_non_core_tools` #33924）：Always 优先级的
	 * toolset（core / mcp-bridge / tool-search）即使在 disabled 列表中也不会被
	 * 完全剥离，只剥离其非核心部分。
	 */
	private _getAgentDisabledToolsets(agentId?: string): string[] | undefined {
		if (!agentId) { return undefined; }
		try {
			const studioService = (this as any)._studioService;
			if (!studioService) { return undefined; }
			const agents = studioService.getAgentsSync?.();
			if (!agents) { return undefined; }
			const agent = agents.find((a: any) => a.id === agentId);
			return agent?.disabledToolsets?.length ? agent.disabledToolsets : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * update_plan 门控。
	 *
	 * 默认启用 update_plan，Agent 可通过 enableUpdatePlan: false 显式关闭。
	 */
	private _shouldEnableUpdatePlan(agentId?: string): boolean {
		if (agentId) {
			const planFlag = this._getAgentConfigBool(agentId, 'enableUpdatePlan');
			if (planFlag === false) { return false; }
		}
		return true;
	}

	private _getAgentConfigBool(agentId: string, field: string): boolean | undefined {
		try {
			const studioService = (this as any)._studioService;
			if (!studioService) { return undefined; }
			const agents = studioService.getAgentsSync?.();
			if (!agents) { return undefined; }
			const agent = agents.find((a: any) => a.id === agentId);
			const val = agent?.[field];
			return typeof val === 'boolean' ? val : undefined;
		} catch { return undefined; }
	}

	/**
	 * 延迟工具解析 — 借鉴 OpenClaw `resolveDeferredTool()`。
	 *
	 * 当 LLM 调用的工具不在当前已加载的工具列表中时，尝试从所有 provider 重新扫描。
	 * 场景：MCP 服务器在 agent loop 进行中刚连接，新工具尚未被 _getEnabledTools 缓存。
	 *
	 * @param toolName 工具名
	 * @param agentId Agent ID
	 * @returns 工具定义，或 undefined（未找到）
	 */
	private async _resolveDeferredTool(
		toolName: string,
		agentId: string | undefined,
	): Promise<IToolDefinition | undefined> {
		try {
			const providers = this._slotRegistry.getToolProviders();
			for (const p of providers) {
				try {
					const tools = await p.listTools(agentId ?? '');
					const found = tools.find(t => t.name === toolName);
					if (found) { return found; }
				} catch { /* ignore provider errors */ }
			}
		} catch { /* best effort */ }
		return undefined;
	}

	/**
	 * 执行 Tool Search 桥接工具（三层分离的 Executor 层入口）。
	 *
	 * 参考 Hermes-Agent `model_tools.py` 的桥接分发 + `tool_executor.py` 的 unwrap：
	 *   - tool_search / tool_describe: 调用 Dispatch 层返回结果文本
	 *   - tool_call: Dispatch 层解析为 (underlyingName, args) + scope 门控，
	 *     然后由本方法执行真实工具（走完整 guardrail/approval 链）
	 */
	private async _executeBridgeTool(
		bridgeToolName: string,
		args: Record<string, unknown>,
		agentId: string | undefined,
		toolCallId: string,
		abortSignal?: AbortSignal,
	): Promise<IToolResult> {
		// 确保 dispatcher context 可用（_getEnabledTools 已构建，这是防御）
		if (!this._lastDispatcherCtx || !this._lastAssembly) {
			const tools = (await this.listAllToolsWithState(agentId ?? '')).filter(t => t.enabled);
			const assembly = assembleToolDefs(tools, { config: DEFAULT_TOOL_SEARCH_CONFIG });
			this._lastAssembly = assembly;
			this._lastDispatcherCtx = buildDispatcherContext(assembly, DEFAULT_TOOL_SEARCH_CONFIG);
		}

		const dispatchResult = dispatchBridgeTool(bridgeToolName, args, this._lastDispatcherCtx);

		// search / describe / error → 直接返回文本
		if (dispatchResult.type !== 'call_resolved') {
			return {
				toolCallId, success: dispatchResult.success,
				content: [{ type: 'text', text: dispatchResult.text ?? '' }],
			};
		}

		// call_resolved: executor unwrap — 走完整 guardrail/approval 链
		const underlyingName = dispatchResult.underlyingName!;
		const underlyingArgs = dispatchResult.underlyingArgs ?? {};
		this._logService.info(`[AgentOS] Bridge tool_call unwrapped → executing "${underlyingName}" (args=${JSON.stringify(underlyingArgs).slice(0, 200)})`);

		// 一次收集所有工具 + 记录每个工具所属的 provider
		const providers = this._slotRegistry.getToolProviders();
		const allTools: IToolDefinition[] = [];
		// provider 来源追踪：key = toolName, value = provider
		const providerByTool = new Map<string, typeof providers[number]>();
		for (const p of providers) {
			try {
				const ptools = await p.listTools(agentId ?? '');
				allTools.push(...ptools);
				for (const t of ptools) { providerByTool.set(t.name, p); }
			} catch { /* ignore */ }
		}
		const targetTool = allTools.find(t => t.name === underlyingName);
		if (!targetTool) {
			return {
				toolCallId, success: false,
				content: [{ type: 'text', text: `Error: Tool "${underlyingName}" not found in any provider.` }],
			};
		}

		// Approval（真实工具的安全级别）
		if (!await this._approvalService.checkAndApprove(
			{ id: toolCallId, name: underlyingName, arguments: underlyingArgs }, targetTool,
		)) {
			this._logService.info(`[AgentOS] Bridge tool_call: "${underlyingName}" denied`);
			return {
				toolCallId, success: false,
				content: [{ type: 'text', text: `Tool "${underlyingName}" execution was denied by the user.` }],
			};
		}

		// 执行真实工具 — 优先使用已记录的 provider（避免二次 listTools 数据竞争）
		const knownProvider = providerByTool.get(underlyingName);
		const timeoutMs = getTimeoutForTool(underlyingName, targetTool, targetTool.source);
		if (knownProvider) {
			try {
				return await executeWithRetryAndTimeout(
					knownProvider, agentId ?? '',
					{ id: toolCallId, name: underlyingName, arguments: underlyingArgs },
					{ timeoutMs, parentSignal: abortSignal ?? this._loopAbortController?.signal },
				);
			} catch (err) {
				this._logService.warn(`[AgentOS] Bridge tool_call: "${underlyingName}" via ${knownProvider.id}: ${sanitizeToolError(err)}`);
			}
		}
		// 回退：遍历所有 provider 查找
		for (const p of providers) {
			if (p === knownProvider) { continue; } // 已经试过
			try {
				const ptools = await p.listTools(agentId ?? '');
				if (ptools.some(t => t.name === underlyingName)) {
				return await executeWithRetryAndTimeout(
					p, agentId ?? '',
					{ id: toolCallId, name: underlyingName, arguments: underlyingArgs },
					{ timeoutMs, parentSignal: abortSignal ?? this._loopAbortController?.signal },
				);
				}
			} catch (err) {
				this._logService.warn(`[AgentOS] Bridge tool_call: "${underlyingName}" via ${p.id}: ${sanitizeToolError(err)}`);
			}
		}
		return {
			toolCallId, success: false,
			content: [{ type: 'text', text: `Error: No provider could execute "${underlyingName}".` }],
		};
	}



	/**
	 * 等待 MCP 工具变为可用。
	 *
	 * MCP 服务器连接和工具枚举是异步的。McpToolProvider 的 autorun 在
	 * server.tools observable 变化后才填充 _routes。如果在首轮工具收集时
	 * 没有 MCP 工具，这里做一次短轮询等待（默认 3 秒，每 500ms 检查一次），
	 * 让 MCP 服务器有时间完成连接。
	 *
	 * 返回最新的工具列表（如果 MCP 工具出现则包含它们，否则返回原始列表）。
	 */
	private async _waitForMcpTools(
		agentId: string,
		initialTools: IToolDefinition[],
		timeoutMs: number = 3000,
	): Promise<IToolDefinition[]> {
		const POLL_INTERVAL = 500;
		const deadline = Date.now() + timeoutMs;
		let tools = initialTools;

		while (Date.now() < deadline) {
			// 检查是否已有 MCP 工具
			const mcpCount = tools.filter(t => t.category?.startsWith('mcp:')).length;
			if (mcpCount > 0) {
				this._logService.info(`[AgentOS] MCP tools available after waiting: ${mcpCount} MCP tool(s) found`);
				return tools;
			}
			// 等待一个轮询间隔后重新收集
			await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
			tools = await this._getEnabledTools(agentId);
		}

		// 超时仍未获取到 MCP 工具
		const mcpCount = tools.filter(t => t.category?.startsWith('mcp:')).length;
		if (mcpCount === 0) {
			this._logService.warn(`[AgentOS] No MCP tools after waiting ${timeoutMs}ms — MCP servers may not be connected or configured`);
		}
		return tools;
	}

	/**
	 * 执行一组工具调用
	 *
	 * Enhanced with:
	 *  - Multi-level tool name repair (Hermes-Agent patterns)
	 *  - Argument coercion & repair
	 *  - Error sanitization
	 *  - Result size limiting
	 *  - **[P0] Timeout protection** (AbortController + configurable timeout per tool)
	 *  - **[P0] Approval flow** (securityLevel-based user confirmation)
	 *  - **[P1] Execution metadata** (timing, truncation, timeout info)
	 */
	private async _executeToolCalls(toolCalls: IToolCallInfo[], agentId: string, worktreePath?: string, abortSignal?: AbortSignal): Promise<Array<{ toolCallId: string; content: any; success: boolean }>> {
		const results: Array<{ toolCallId: string; content: any; success: boolean }> = [];

		// ─── Dashboard 统计：工具调用计数 ──
		// P8: 同时收集文件路径用于下一轮 enrich
		for (const tc of toolCalls) {
			if (tc.name) {
				this._toolCallCounts.set(tc.name, (this._toolCallCounts.get(tc.name) ?? 0) + 1);
				this._scheduleSave();
				// 实时写入文件存储（fire-and-forget）
				if (this._dashboardStorage?.ready) {
					this._dashboardStorage.incrementToolCall(tc.name).catch(() => {});
				}
				// P8: 暂存文件路径
				const filePaths = this._extractFilePathsFromToolCall(tc);
				if (filePaths.length > 0) {
					const sessionKey = agentId; // agentId 维度暂存
					this._stashFilePaths(sessionKey, filePaths);
				}
			}
		}

		// v17: propagate the parent agent's worktree to tool providers that
		// support inheriting it. Today this is BuiltinToolProvider, which
		// passes the path down to sub-agents via `delegate_task`.
		if (worktreePath) {
			for (const provider of this._slotRegistry.getToolProviders()) {
				const candidate = provider as unknown as { setParentWorktreePath?: (p: string | undefined) => void };
				if (typeof candidate.setParentWorktreePath === 'function') {
					try { candidate.setParentWorktreePath(worktreePath); } catch { /* ignore */ }
				}
			}
		}

		// Pre-collect all available tools and build lookup structures
		const allAvailableTools: IToolDefinition[] = [];
		for (const provider of this._slotRegistry.getToolProviders()) {
			try {
				const tools = await provider.listTools(agentId);
				allAvailableTools.push(...tools);
			} catch { /* ignore */ }
		}
		const availableToolNames = allAvailableTools.map(t => t.name);
		const validNameSet = buildValidToolNameSet(allAvailableTools);
		const schemaMap = buildToolSchemaMap(allAvailableTools);
		// Build a name → definition map for approval checks
		const toolDefMap = new Map<string, IToolDefinition>();
		for (const t of allAvailableTools) { toolDefMap.set(t.name, t); }

		// ─── Subagent Limit Middleware（借鉴 deer-flow SubagentLimitMiddleware）───
		// Truncate excess sub-agent delegation calls (delegate_task / task) before
		// execution to prevent the LLM from spawning too many parallel sub-agents
		// in a single turn. More reliable than prompt-based limits.
		const limitResult = this._subagentLimitMw.apply(toolCalls);
		if (limitResult.wasTruncated) {
			this._logService.warn(
				`[AgentOS] SubagentLimitMiddleware truncated ${limitResult.droppedCalls.length} excess sub-agent calls ` +
				`(original: ${limitResult.originalTaskCount}, kept: ${limitResult.keptTaskCount}, max: ${this._subagentLimitMw.maxConcurrent})`
			);
			// Track dropped calls in the delegation ledger as cancelled
			for (const dropped of limitResult.droppedCalls) {
				this._delegationLedger.markCancelled(dropped.id);
			}
		}
		const truncatedCalls = limitResult.toolCalls;

		// ─── Track delegate_task calls in the delegation ledger ───
		for (const tc of truncatedCalls) {
			if (this._subagentLimitMw.isDelegationCall(tc)) {
				let parsedArgs: Record<string, unknown> = {};
				if (typeof tc.arguments === 'string') {
					try { parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* ignore */ }
				}
				const taskDesc = String(parsedArgs.task ?? parsedArgs.description ?? tc.name);
				const subagentType = String(parsedArgs.agent_type ?? parsedArgs.type ?? '');
				this._delegationLedger.markDelegated(tc.id, taskDesc, subagentType);
			}
		}

		// Update durable context with the latest ledger state so it survives
		// summarization compression on the next round.
		this._durableContext.updateFromLedger(this._delegationLedger.getAllEntries());

		// Deduplicate tool calls before execution
		const uniqueCalls = deduplicateToolCalls(truncatedCalls);
		if (uniqueCalls.length < truncatedCalls.length) {
			this._logService.info(`[AgentOS] Deduplicated tool calls: ${truncatedCalls.length} → ${uniqueCalls.length}`);
		}

		for (const toolCall of uniqueCalls) {
			this._logService.info(`[AgentOS] Executing tool: ${toolCall.name}, callId=${toolCall.id}`);

			// ─── Step 0: Phantom (UI-indicator) tool short-circuit ───
			// Knot 服务端会下发 `task_planning` / `planning` 等纯 UI 指示器
			// （render_type="none"，仅用于显示"任务规划中"），它们不应进入
			// 真实执行路径。如果不短路，repairToolName 会找不到，进而返回
			// formatToolNotFoundResult — 一大段 "available tools" 列表喂回模型，
			// 模型又会就这条错误生成一段冗长的"我尝试调用了不存在的工具"道歉，
			// 形成视觉噪声循环。这里直接返回一个静默的成功占位即可。
			if (PHANTOM_TOOL_NAMES.has(toolCall.name)) {
			this._logService.info(`[AgentOS] Phantom tool "${toolCall.name}" silently acknowledged (UI indicator only)`);
				results.push({
					toolCallId: toolCall.id,
					content: { ok: true, phantom: true },
					success: true,
				});
				continue;
			}

			// ─── Step 0.5: Tool Search bridge tool short-circuit ───
			// tool_search / tool_call / tool_describe 是动态桥接工具，
			// 不在任何 provider 中注册。跳过 repairToolName 避免误修。
			if (isBridgeTool(toolCall.name)) {
				this._logService.info(`[AgentOS] Bridge tool "${toolCall.name}" short-circuited`);
				const argValidity0 = classifyArgumentValidity(toolCall.arguments || '');
				let bridgeArgs: Record<string, unknown>;
				if (argValidity0 === 'valid') {
					bridgeArgs = JSON.parse(toolCall.arguments!);
				} else if (argValidity0 === 'empty') {
					bridgeArgs = {};
				} else {
					bridgeArgs = repairToolArguments(toolCall.arguments || '') ?? {};
				}
				const bridgeResult = await this._executeBridgeTool(
					toolCall.name, bridgeArgs, agentId, toolCall.id, abortSignal,
				);
				const limitedStr0 = safeStringifyToolResult(bridgeResult.content);
				let finalContent0: unknown = bridgeResult.content;
				try { finalContent0 = JSON.parse(limitedStr0); } catch { finalContent0 = { __truncated__: true, content: limitedStr0 }; }
				results.push({
					toolCallId: toolCall.id,
					content: finalContent0,
					success: bridgeResult.success,
				});
				continue;
			}

			// ─── Step 1: Tool name repair + Deferred Tool Resolution ──
			// 借鉴 OpenClaw `resolveDeferredTool`：执行时按需加载工具。
			// 如果工具不在当前 validNameSet 中，尝试：
			//   a) 名称修复（模糊匹配）
			//   b) 延迟解析：从所有 provider 重新加载（MCP 动态发现的工具可能未在初始列表中）
			let targetToolName = toolCall.name;
			if (!validNameSet.has(targetToolName)) {
				const repaired = repairToolName(targetToolName, availableToolNames);
				if (repaired) {
					this._logService.warn(`[AgentOS] Repaired tool name "${targetToolName}" → "${repaired}"`);
					targetToolName = repaired;
				} else {
					// 延迟工具解析：尝试从 provider 重新发现（MCP 工具可能刚连接）
					const deferredTool = await this._resolveDeferredTool(targetToolName, agentId);
					if (deferredTool) {
						this._logService.info(`[AgentOS] Deferred tool resolved: "${targetToolName}" found via provider re-scan`);
						// 添加到 availableTools 供后续使用
						allAvailableTools.push(deferredTool);
						availableToolNames.push(deferredTool.name);
						validNameSet.add(deferredTool.name);
						targetToolName = deferredTool.name;
					} else {
					// Tool not found — return error with available tool names
					this._logService.warn(`[AgentOS] Tool "${toolCall.name}" not found and not repairable. Valid tools (${availableToolNames.length}): ${availableToolNames.slice(0, 30).join(', ')}${availableToolNames.length > 30 ? '...' : ''}`);
					results.push({
						toolCallId: toolCall.id,
						content: formatToolNotFoundResult(toolCall.name, repaired, availableToolNames),
						success: false,
					});
					continue;
					}  // end else (deferredTool not found)
				}  // end if (!deferredTool)
			}  // end if (!validNameSet.has)

			// ─── Step 2: Argument parsing & repair ─────────────────
			const argValidity = classifyArgumentValidity(toolCall.arguments || '');
			let args: Record<string, unknown>;

			if (argValidity === 'valid') {
				args = JSON.parse(toolCall.arguments!);
			} else if (argValidity === 'empty') {
				args = {};
			} else if (argValidity === 'truncated') {
				// Truncated arguments are not recoverable — return error
				this._logService.warn(`[AgentOS] Tool arguments appear truncated: ${toolCall.arguments?.substring(0, 100)}`);
				results.push({
					toolCallId: toolCall.id,
					content: { error: `Arguments for tool "${targetToolName}" appear to be truncated. Please retry with complete arguments.` },
					success: false,
				});
				continue;
			} else if (argValidity === 'repairable') {
				const repairedArgs = repairToolArguments(toolCall.arguments || '');
				if (repairedArgs) {
					this._logService.info(`[AgentOS] Repaired tool arguments for "${targetToolName}"`);
					args = repairedArgs;
				} else {
					args = {};
				}
			} else {
				// Invalid — try repair as last resort
				const repairedArgs = repairToolArguments(toolCall.arguments || '');
				if (repairedArgs) {
					this._logService.info(`[AgentOS] Repaired invalid tool arguments for "${targetToolName}"`);
					args = repairedArgs;
				} else {
					this._logService.warn(`[AgentOS] Failed to parse tool arguments: ${toolCall.arguments?.substring(0, 200)}`);
					results.push({
						toolCallId: toolCall.id,
						content: { error: `Invalid arguments for tool "${targetToolName}". Please provide valid JSON arguments.` },
						success: false,
					});
					continue;
				}
			}

			// ─── Step 3: Argument coercion ─────────────────────────
			const toolSchema = schemaMap.get(targetToolName);
			if (toolSchema) {
				const coerced = coerceArgsToSchema(args, toolSchema);
				args = coerced.args;
				for (const w of coerced.warnings) {
					this._logService.warn(`[AgentOS][Coerce] "${targetToolName}" — ${w}`);
				}
			}

			// ─── Step 3.5: Approval check (P0 - 审批机制) ─────────
			const toolDef = toolDefMap.get(targetToolName);
			const approved = await this._approvalService.checkAndApprove(
				{ id: toolCall.id, name: targetToolName, arguments: args },
				toolDef,
			);
			if (!approved) {
				this._logService.info(`[AgentOS] Tool "${targetToolName}" execution denied by user`);
				results.push({
					toolCallId: toolCall.id,
					content: { error: `Tool "${targetToolName}" execution was denied by the user. Try a different approach or ask the user for permission.` },
					success: false,
				});
				continue;
			}

			// ─── Step 4: Execute tool via provider (with timeout) ──
			let executed = false;
			const toolProviders = this._slotRegistry.getToolProviders();
			const timeoutMs = getTimeoutForTool(targetToolName, toolDef, toolDef?.source);

			// 单次收集 provider→tool 映射，避免每次 listTools() 返回不同结果导致竞态
			const _execProviderByTool = new Map<string, typeof toolProviders[number]>();
			for (const p of toolProviders) {
				try {
					const ptools = await p.listTools(agentId);
					for (const t of ptools) { _execProviderByTool.set(t.name, p); }
				} catch { /* ignore */ }
			}

			// 优先使用已记录的 provider
			const _execKnown = _execProviderByTool.get(targetToolName);
			if (_execKnown) {
				try {
					const result = await executeWithRetryAndTimeout(
						_execKnown, agentId,
						{ id: toolCall.id, name: targetToolName, arguments: args },
						{ timeoutMs, parentSignal: abortSignal ?? this._loopAbortController?.signal },
					);
					this._executionTracker.complete(toolCall.id);
					const limitedStr = safeStringifyToolResult(result.content);
					let finalContent: unknown = result.content;
					try { finalContent = JSON.parse(limitedStr); } catch { finalContent = { __truncated__: true, content: limitedStr }; }
					results.push({ toolCallId: toolCall.id, content: finalContent, success: result.success });
					executed = true;
					if (result.metadata?.timedOut) {
						this._logService.warn(`[AgentOS] Tool ${targetToolName} timed out after ${timeoutMs}ms`);
					} else if (result.success) {
						this._logService.info(`[AgentOS] Tool ${targetToolName} executed successfully via ${_execKnown.id} (${result.metadata?.executionTimeMs ?? '?'}ms)`);
					} else {
						this._logService.warn(`[AgentOS] Tool ${targetToolName} returned error via ${_execKnown.id}: ${result.error ?? 'unknown error'}`);
					}
				} catch (error) {
					const sanitized = sanitizeToolError(error);
					this._logService.warn(`[AgentOS] Tool ${targetToolName} execution failed via ${_execKnown.id}: ${sanitized}`);
					// handler 抛异常 = 工具确实被找到了并尝试执行了，只是参数或逻辑有问题。
					// 应标记为 executed=true 并返回真实错误给 LLM，避免掉入 fallback 循环
					// 最终报 "No provider available" 掩盖了真正的参数错误。
					executed = true;
					results.push({
						toolCallId: toolCall.id,
						content: typeof error === 'object' && error !== null && 'message' in (error as any)
							? (error as any).message
							: sanitized,
						success: false,
					});
				}
			}

			// 回退：遍历其余 provider
			if (!executed) {
			for (const provider of toolProviders) {
				if (provider === _execKnown) { continue; }
				try {
					const tools = await provider.listTools(agentId);
					if (tools.some(t => t.name === targetToolName)) {
						// 使用带超时保护的执行
						const result: IToolResult = await executeWithRetryAndTimeout(
							provider,
							agentId,
							{ id: toolCall.id, name: targetToolName, arguments: args },
							{ timeoutMs, parentSignal: abortSignal ?? this._loopAbortController?.signal },
						);

						// Track execution
						this._executionTracker.complete(toolCall.id);

						// Limit result size — use safeStringifyToolResult to guard
						// against pathological tool payloads (50MB+) that would OOM the
						// renderer if passed to JSON.stringify directly.
						const limitedStr = safeStringifyToolResult(result.content);
						// `wasTruncated` is true whenever safeStringifyToolResult had to
						// shrink either the object (deep-truncate) or the final string.
						// In that case we re-parse so downstream sees a structured object
						// (matching the original content shape) rather than a string blob.
						let finalContent: unknown = result.content;
						try {
							finalContent = JSON.parse(limitedStr);
						} catch {
							// limitedStr ended in a truncation marker that broke JSON parsing;
							// fall back to a wrapper object so downstream still has structure.
							finalContent = { __truncated__: true, content: limitedStr };
						}

						results.push({
							toolCallId: toolCall.id,
							content: finalContent,
							success: result.success,
						});
						executed = true;

						if (result.metadata?.timedOut) {
							this._logService.warn(`[AgentOS] Tool ${targetToolName} timed out after ${timeoutMs}ms`);
						} else if (result.success) {
							this._logService.info(`[AgentOS] Tool ${targetToolName} executed successfully via ${provider.id} (${result.metadata?.executionTimeMs ?? '?'}ms)`);
						} else {
							const errorMsg = result.error ?? 'unknown error';
							this._logService.warn(`[AgentOS] Tool ${targetToolName} returned error via ${provider.id}: ${errorMsg}`);
						}
						break;
					}
				} catch (error) {
					const sanitizedError = sanitizeToolError(error);
					this._logService.warn(`[AgentOS] Tool ${targetToolName} execution failed via ${provider.id}: ${sanitizedError}`);
					// If a provider fails, try the next one
					continue;
				}
			}
			}

			if (!executed) {
				this._logService.warn(`[AgentOS] No provider could execute tool: ${targetToolName}`);
				results.push({
					toolCallId: toolCall.id,
					content: formatToolErrorResult(targetToolName, 'No provider available for this tool', availableToolNames),
					success: false,
				});
			}
		}

		return results;
	}

	/**
	 * Execute tool calls in parallel using Promise.allSettled.
	 * Borrowed from Hermes-Agent's concurrent tool execution pattern.
	 *
	 * - Validates each call independently (name repair, arg repair, coercion)
	 * - Executes all valid calls concurrently (up to MAX_TOOL_WORKERS)
	 * - Preserves original order in results
	 */
	/**
	 * Streaming parallel tool execution.
	 *
	 * Yields each tool result **as soon as that individual tool finishes**,
	 * in completion order (NOT input order). This is the critical fix for
	 * "工具一直在转圈" — previously we awaited Promise.all then yielded all
	 * results in input order, which meant a 60s slow tool blocked tool_end
	 * for every fast sibling in the same batch.
	 *
	 * Skipped entries (validation failures) are yielded synchronously up
	 * front so the UI can mark them done immediately.
	 */
	private async * _executeToolCallsParallelStreaming(toolCalls: IToolCallInfo[], agentId: string, worktreePath?: string, abortSignal?: AbortSignal): AsyncGenerator<{ toolCallId: string; content: any; success: boolean }, void, unknown> {
		// v17: same as the serial path — push the worktree down to tool providers
		// (e.g. BuiltinToolProvider) so sub-agents inherit it.
		if (worktreePath) {
			for (const provider of this._slotRegistry.getToolProviders()) {
				const candidate = provider as unknown as { setParentWorktreePath?: (p: string | undefined) => void };
				if (typeof candidate.setParentWorktreePath === 'function') {
					try { candidate.setParentWorktreePath(worktreePath); } catch { /* ignore */ }
				}
			}
		}

		// Pre-collect all available tools and build lookup structures
		const allAvailableTools: IToolDefinition[] = [];
		for (const provider of this._slotRegistry.getToolProviders()) {
			try {
				const tools = await provider.listTools(agentId);
				allAvailableTools.push(...tools);
			} catch { /* ignore */ }
		}
		const availableToolNames = allAvailableTools.map(t => t.name);
		const validNameSet = buildValidToolNameSet(allAvailableTools);
		const schemaMap = buildToolSchemaMap(allAvailableTools);

		// Deduplicate
		const uniqueCalls = deduplicateToolCalls(toolCalls);
		if (uniqueCalls.length < toolCalls.length) {
			this._logService.info(`[AgentOS] [parallel] Deduplicated tool calls: ${toolCalls.length} → ${uniqueCalls.length}`);
		}

		// Prepare each tool call: validate, repair, build execution function
		const executionEntries: Array<{
			originalIndex: number;
			toolCall: IToolCallInfo;
			targetToolName: string;
			args: Record<string, unknown>;
			skip: boolean;
			skipResult?: { toolCallId: string; content: any; success: boolean };
		}> = [];

		for (let i = 0; i < uniqueCalls.length; i++) {
			const toolCall = uniqueCalls[i];

			// Phantom (UI-indicator) tool short-circuit — 见串行路径同名注释。
			if (PHANTOM_TOOL_NAMES.has(toolCall.name)) {
				this._logService.info(`[AgentOS] [parallel] Phantom tool "${toolCall.name}" silently acknowledged (UI indicator only)`);
				executionEntries.push({
					originalIndex: i,
					toolCall,
					targetToolName: toolCall.name,
					args: {},
					skip: true,
					skipResult: {
						toolCallId: toolCall.id,
						content: { ok: true, phantom: true },
						success: true,
					},
				});
				continue;
			}

			// Tool name repair — skip for bridge tools (they're dynamic, not in any provider)
			let targetToolName = toolCall.name;
			if (!isBridgeTool(targetToolName) && !validNameSet.has(targetToolName)) {
				const repaired = repairToolName(targetToolName, availableToolNames);
				if (repaired) {
					this._logService.warn(`[AgentOS] [parallel] Repaired tool name "${targetToolName}" → "${repaired}"`);
					targetToolName = repaired;
				} else {
					this._logService.warn(`[AgentOS] [parallel] Tool "${toolCall.name}" not found and not repairable. Valid tools (${availableToolNames.length}): ${availableToolNames.slice(0, 30).join(', ')}${availableToolNames.length > 30 ? '...' : ''}`);
					executionEntries.push({
						originalIndex: i,
						toolCall,
						targetToolName,
						args: {},
						skip: true,
						skipResult: {
							toolCallId: toolCall.id,
							content: formatToolNotFoundResult(toolCall.name, repaired, availableToolNames),
							success: false,
						},
					});
					continue;
				}
			}

			// Argument parsing & repair
			const argValidity = classifyArgumentValidity(toolCall.arguments || '');
			let args: Record<string, unknown>;

			if (argValidity === 'valid') {
				args = JSON.parse(toolCall.arguments!);
			} else if (argValidity === 'empty') {
				args = {};
			} else if (argValidity === 'truncated') {
				executionEntries.push({
					originalIndex: i,
					toolCall,
					targetToolName,
					args: {},
					skip: true,
					skipResult: {
						toolCallId: toolCall.id,
						content: { error: `Arguments for tool "${targetToolName}" appear to be truncated. Please retry with complete arguments.` },
						success: false,
					},
				});
				continue;
			} else {
				const repairedArgs = repairToolArguments(toolCall.arguments || '');
				if (repairedArgs) {
					args = repairedArgs;
				} else {
					executionEntries.push({
						originalIndex: i,
						toolCall,
						targetToolName,
						args: {},
						skip: true,
						skipResult: {
							toolCallId: toolCall.id,
							content: { error: `Invalid arguments for tool "${targetToolName}". Please provide valid JSON arguments.` },
							success: false,
						},
					});
					continue;
				}
			}

			// Argument coercion
			const toolSchema = schemaMap.get(targetToolName);
			if (toolSchema) {
				const coerced = coerceArgsToSchema(args, toolSchema);
				args = coerced.args;
				for (const w of coerced.warnings) {
					this._logService.warn(`[AgentOS][Coerce] "${targetToolName}" — ${w}`);
				}
			}

			executionEntries.push({
				originalIndex: i,
				toolCall,
				targetToolName,
				args,
				skip: false,
			});
		}

		// Execute all non-skipped calls in parallel (with timeout + approval)
		const entriesToExecute = executionEntries.filter(e => !e.skip);
		this._logService.info(`[AgentOS] [parallel] Executing ${entriesToExecute.length} tool calls concurrently (skipped ${executionEntries.length - entriesToExecute.length})`);

		// Build tool definition map for approval
		const toolDefMap = new Map<string, IToolDefinition>();
		for (const t of allAvailableTools) { toolDefMap.set(t.name, t); }

		// Build execution promises (with timeout protection)
		const toolProviders = this._slotRegistry.getToolProviders();
		const executionPromises = entriesToExecute.map(async (entry) => {
			const { toolCall, targetToolName, args } = entry;

			// ── Bridge tool: execute via _executeBridgeTool ──
			// tool_search / tool_call / tool_describe 不在任何 provider 中注册，
			// 需要特殊处理（Dispatch 层解析 + Executor 层执行真实工具）。
			if (isBridgeTool(targetToolName)) {
				this._logService.info(`[AgentOS] [parallel] Bridge tool "${targetToolName}" executing`);
				const bridgeResult = await this._executeBridgeTool(
					targetToolName, args, agentId, toolCall.id, abortSignal,
				);
				const limitedStrB = safeStringifyToolResult(bridgeResult.content);
				let finalContentB: unknown = bridgeResult.content;
				try { finalContentB = JSON.parse(limitedStrB); } catch { finalContentB = { __truncated__: true, content: limitedStrB }; }
				return {
					originalIndex: entry.originalIndex,
					toolCallId: toolCall.id,
					content: finalContentB,
					success: bridgeResult.success,
				};
			}

			// Approval check
			const toolDef = toolDefMap.get(targetToolName);
			const approved = await this._approvalService.checkAndApprove(
				{ id: toolCall.id, name: targetToolName, arguments: args },
				toolDef,
			);
			if (!approved) {
				this._logService.info(`[AgentOS] [parallel] Tool "${targetToolName}" denied by user`);
				return {
					originalIndex: entry.originalIndex,
					toolCallId: toolCall.id,
					content: { error: `Tool "${targetToolName}" execution was denied by the user.` },
					success: false,
				};
			}

			const timeoutMs = getTimeoutForTool(targetToolName, toolDef, toolDef?.source);

			for (const provider of toolProviders) {
				// 先单独 try listTools：provider 不可用时应 continue 尝试下一个，
				// 不能与 execute 的异常混在同一 catch（否则 handler 抛错会被当成
				// "provider 不可用" 而继续 fallback，最终报 "No provider available"
				// 掩盖真正的执行错误——对齐串行路径 4483-4497 的修复）。
				let tools: IToolDefinition[];
				try {
					tools = await provider.listTools(agentId);
				} catch {
					continue;
				}
				if (!tools.some(t => t.name === targetToolName)) {
					continue; // 此 provider 不提供该工具
				}

				// 已确认此 provider 提供该工具 → 执行。
				try {
					// 使用带超时保护的执行
					const result: IToolResult = await executeWithRetryAndTimeout(
						provider,
						agentId,
						{ id: toolCall.id, name: targetToolName, arguments: args },
						{ timeoutMs, parentSignal: abortSignal ?? this._loopAbortController?.signal },
					);
					// safeStringifyToolResult: guards against pathological payloads
					// (e.g. tool returning a 50MB blob) which would otherwise blow up
					// JSON.stringify and OOM the renderer. See toolCallUtils.ts.
					const limitedStr = safeStringifyToolResult(result.content);
					let finalContent: unknown = result.content;
					try {
						finalContent = JSON.parse(limitedStr);
					} catch {
						finalContent = { __truncated__: true, content: limitedStr };
					}

					if (result.success) {
						this._logService.info(`[AgentOS] [parallel] Tool ${targetToolName} executed via ${provider.id} (${result.metadata?.executionTimeMs ?? '?'}ms)`);
					} else {
						this._logService.warn(`[AgentOS] [parallel] Tool ${targetToolName} returned error via ${provider.id}: ${result.error ?? 'unknown'}`);
					}
					return {
						originalIndex: entry.originalIndex,
						toolCallId: toolCall.id,
						content: finalContent,
						success: result.success,
					};
				} catch (error) {
					// handler 抛异常 = 工具已被找到并尝试执行，只是参数或逻辑出错
					// （如 file_read 目标文件不存在）。必须返回真实错误给 LLM，
					// 而非 continue 掉进 "No provider available" 误导循环。
					const sanitizedError = sanitizeToolError(error);
					this._logService.warn(`[AgentOS] [parallel] Tool ${targetToolName} execution failed via ${provider.id}: ${sanitizedError}`);
					return {
						originalIndex: entry.originalIndex,
						toolCallId: toolCall.id,
						content: typeof error === 'object' && error !== null && 'message' in (error as any)
							? (error as any).message
							: sanitizedError,
						success: false,
					};
				}
			}

			// If we get here, no provider could execute the tool
			this._logService.warn(`[AgentOS] [parallel] No provider could execute tool: ${targetToolName}`);
			return {
				originalIndex: entry.originalIndex,
				toolCallId: toolCall.id,
				content: formatToolErrorResult(targetToolName, 'No provider available for this tool', availableToolNames),
				success: false,
			};
		});

		// ── 1. Emit all SKIPPED entries up front (synchronous results) ──
		for (const entry of executionEntries) {
			if (entry.skip && entry.skipResult) {
				yield entry.skipResult;
			}
		}

		// ── 2. Race the executing promises and yield each as it completes ──
		// We can't use `for await (Promise.race)` because race only resolves the
		// fastest *every iteration*, repeatedly returning the same already-resolved
		// promise. Instead we attach an index to each promise, and as each settles
		// we remove it from the pending pool.
		type Settled = { type: 'fulfilled'; value: { originalIndex: number; toolCallId: string; content: any; success: boolean } }
			| { type: 'rejected'; reason: unknown };

		// Wrap each promise so `race` returns the index of the one that settled.
		const wrapped: Array<Promise<{ idx: number; settled: Settled }>> = executionPromises.map((p, idx) =>
			p.then(value => ({ idx, settled: { type: 'fulfilled' as const, value } }))
				.catch(reason => ({ idx, settled: { type: 'rejected' as const, reason } }))
		);

		// Pending pool: replace settled slots with a never-resolving placeholder so
		// race won't pick them again.
		const NEVER: Promise<{ idx: number; settled: Settled }> = new Promise(() => { /* never */ });
		const pool: Array<Promise<{ idx: number; settled: Settled }>> = wrapped.slice();
		let remaining = pool.length;

		while (remaining > 0) {
			const { idx, settled } = await Promise.race(pool);
			pool[idx] = NEVER;
			remaining--;

			if (settled.type === 'fulfilled' && settled.value) {
				const { toolCallId, content, success } = settled.value;
				yield { toolCallId, content, success };
			} else if (settled.type === 'rejected') {
				this._logService.error('[AgentOS] [parallel] Tool execution promise rejected:', settled.reason);
				// Even on rejection, we must produce a tool result for the
				// corresponding entry so its tool_end gets emitted upstream.
				const entry = entriesToExecute[idx];
				if (entry) {
					yield {
						toolCallId: entry.toolCall.id,
						content: { error: `Tool execution promise rejected: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}` },
						success: false,
					};
				}
			}
		}
	}

	/**
	 * 从模型纯文本输出中尝试提取工具调用（兼容非严格 function calling 的模型）
	 *
	 * 支持的文本格式（参考 OpenClaw 的 detectToolCallShapedText）：
	 *   1. JSON in code blocks: ```json { "tool_name": "...", "arguments": {...} } ```
	 *   2. Raw JSON objects: { "function": "...", "arguments": {...} }
	 *   3. XML format: <tool_call>...</tool_call> 或 <function_call>...</function_call>
	 *   4. Bracket format: [TOOL_CALL]...[/TOOL_CALL]
	 *   5. ReAct format: Action: tool_name\nAction Input: {...}
	 *   6. Thinking inference: content = args JSON, tool name from thinking
	 */
	private _tryExtractToolCallsFromText(text: string, thinkingContent?: string, enabledTools?: IToolDefinition[]): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];
		if (!text || text.length < 5) { return results; }

		// 构建工具名白名单 Set — 用于过滤 Python function-call 格式提取时的误匹配
		const enabledToolNames = enabledTools ? new Set(enabledTools.map(t => t.name)) : undefined;

		this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: attempting extraction from ${text.length} chars (thinking: ${thinkingContent?.length ?? 0} chars)`);

		// 1. 尝试从 ```json 代码块中提取（支持嵌套大括号）
		const codeBlockRegex = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/g;
		let match: RegExpExecArray | null;
		while ((match = codeBlockRegex.exec(text)) !== null) {
			const blockContent = match[1].trim();
			if (!blockContent.startsWith('{')) { continue; }
			try {
				const parsed = JSON.parse(blockContent);
				const tc = this._parseSingleToolCall(parsed, enabledTools);
				if (tc) {
					this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found tool call in code block: ${tc.name}`);
					results.push(tc);
				}
			} catch { /* ignore parse error */ }
		}

		// 2. 如果没找到代码块，尝试从文本中提取 JSON 对象（支持嵌套）
		if (results.length === 0) {
			const extracted = this._extractJsonObjects(text);
			for (const jsonStr of extracted) {
				try {
					const parsed = JSON.parse(jsonStr);
					const tc = this._parseSingleToolCall(parsed, enabledTools);
					if (tc) {
						this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found tool call in raw JSON: ${tc.name}`);
						results.push(tc);
					}
				} catch { /* ignore parse error */ }
			}
		}

		// 3. XML 格式: <tool_call>...</tool_call> 或 <function_call>...</function_call>
		if (results.length === 0) {
			// Log whether XML-like tags exist in text before attempting extraction
			const hasXmlTags = /<(?:tool_call|function_call|tool_use|invoke|tool)[\s>]/i.test(text);
			this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: XML extraction attempt, hasXmlTags=${hasXmlTags}, textLen=${text.length}`);
			const xmlResults = this._extractToolCallsFromXml(text);
			if (xmlResults.length > 0) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${xmlResults.length} tool call(s) in XML format`);
				results.push(...xmlResults);
			}
		}

		// 4. Bracket 格式: [TOOL_CALL]...[/TOOL_CALL] 或 [tool_call]...[/tool_call]
		if (results.length === 0) {
			const bracketResults = this._extractToolCallsFromBrackets(text);
			if (bracketResults.length > 0) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${bracketResults.length} tool call(s) in bracket format`);
				results.push(...bracketResults);
			}
		}

		// 5. ReAct 格式: Action: tool_name\nAction Input: {...}
		if (results.length === 0) {
			const reactResults = this._extractToolCallsFromReAct(text);
			if (reactResults.length > 0) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${reactResults.length} tool call(s) in ReAct format`);
				results.push(...reactResults);
			}
		}

		// 6. Python 函数调用格式: tool_name(arg1="val1", arg2="val2")
		//    或 ```python\ntool_name(arg1="val1")\n```
		//    常见于不支持 function calling 的模型（如 qwen3.5:9b）
		if (results.length === 0) {
			const pythonResults = this._extractToolCallsFromPythonSyntax(text, enabledToolNames);
			if (pythonResults.length > 0) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${pythonResults.length} tool call(s) in Python function-call format`);
				results.push(...pythonResults);
			}
		}

		// 7. 如果仍未找到，尝试将整个 content 解析为 JSON 参数对象，
		//    并从 thinking 中提取工具名称（兼容 qwen 等模型：thinking 包含意图，content 只有参数）
		if (results.length === 0) {
			const trimmed = text.trim();
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				try {
					const parsed = JSON.parse(trimmed);
					// 先尝试标准解析（可能有 tool/name 字段），传入 enabledTools 支持参数推断
					const tc = this._parseSingleToolCall(parsed, enabledTools);
					if (tc) {
						results.push(tc);
					} else if (thinkingContent) {
						// content 是纯参数 JSON（无 tool name），从 thinking 中提取工具名
						const toolName = this._extractToolNameFromThinking(thinkingContent);
						if (toolName) {
							this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: inferred tool '${toolName}' from thinking, args from content`);
							results.push({
								id: `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
								name: toolName,
								arguments: trimmed,
							});
						}
					}
				} catch { /* not valid JSON */ }
			}
		}

		// ─── 统一白名单过滤 ──────────────────────────────────────────
		// 所有提取路径（JSON/XML/Bracket/ReAct/Python）的最终结果都需要通过白名单。
		// 这防止 LLM 分析代码时输出的函数名（如 ForceGC, OnPostGarbageCollection）
		// 被误解析为工具调用。
		if (enabledToolNames && enabledToolNames.size > 0 && results.length > 0) {
			const before = results.length;
			const filtered = results.filter(tc => {
				if (enabledToolNames!.has(tc.name)) { return true; }
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: filtered out "${tc.name}" (not in enabled tools)`);
				return false;
			});
			if (filtered.length < before) {
				this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: whitelist filtered ${before} → ${filtered.length} tool calls`);
			}
			results.length = 0;
			results.push(...filtered);
		}

		if (results.length > 0) {
			this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: extracted ${results.length} tool call(s) from ${text.length} chars`);
		} else {
			this._logService.info(`[AgentOS] _tryExtractToolCallsFromText: no tool calls found in text: ${text.slice(0, 200)}`);
		}
		return results;
	}

	/**
	 * 从 XML 格式提取工具调用。
	 * 支持: <tool_call>, <function_call>, <tool_use>, <invoke>
	 */
	private _extractToolCallsFromXml(text: string): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];
		const xmlTags = ['tool_call', 'function_call', 'tool_use', 'invoke', 'tool'];

		for (const tag of xmlTags) {
			// 1. 先匹配闭合标签: <tool_call>...</tool_call>
			const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				const fullMatch = match[0];
				const content = match[1].trim();
				this._logService.info(`[AgentOS] _extractToolCallsFromXml: found <${tag}> tag (closed), contentLen=${content.length}, contentPreview=${content.substring(0, 120)}`);
				// <tool> 标签使用 ▷{JSON} 头部 + <document> 子标签格式
				if (tag === 'tool') {
					const parsed = this._parseToolXMLFormat(content);
					if (parsed) { results.push(parsed); }
					else { this._logService.info(`[AgentOS] _extractToolCallsFromXml: _parseToolXMLFormat returned null for <tool> tag`); }
					continue;
				}
				// 新增：尝试从开口标签提取工具名（如 <invoke name="file_list">）
				const openTagMatch = fullMatch.match(new RegExp(`^<${tag}[^>]*\\bname\\s*=\\s*["']([^"']+)["'][^>]*>`));
				if (openTagMatch) {
					// 从开口标签找到了 name 属性，直接使用
					const toolName = openTagMatch[1];
					this._logService.info(`[AgentOS] _extractToolCallsFromXml: found tool name from open tag: ${toolName}`);
					// 尝试从 content 中解析参数（简单实现：查找 <parameter name="xxx">value</parameter>）
					let args = '{}';
					try {
						const paramRegex = /<parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([^<]*)<\/parameter>/gi;
						let paramMatch: RegExpExecArray | null;
						const argsObj: Record<string, string> = {};
						while ((paramMatch = paramRegex.exec(content)) !== null) {
							argsObj[paramMatch[1]] = paramMatch[2];
						}
						if (Object.keys(argsObj).length > 0) {
							args = JSON.stringify(argsObj);
						}
					} catch { /* ignore */ }
					results.push({
						id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: toolName,
						arguments: args,
					});
					continue;
				}
				this._processXmlTagContent(content, results, tag);
			}

			// 2. 兜底: 匹配未闭合标签: <tool_call>toolname (后面没有 </tool_call>)
			// 只匹配当该标签在文本中确实没有被闭合时
			const hasClosingTag = new RegExp(`</${tag}>`, 'i').test(text);
			if (!hasClosingTag) {
				const unclosedRegex = new RegExp(`<${tag}[^>]*>([\\w_\\-]+)(?=\\s*(?:<|$))`, 'gi');
				let unclosedMatch: RegExpExecArray | null;
				while ((unclosedMatch = unclosedRegex.exec(text)) !== null) {
					const content = unclosedMatch[1].trim();
					this._logService.info(`[AgentOS] _extractToolCallsFromXml: found <${tag}> tag (unclosed), content="${content}"`);
					this._processXmlTagContent(content, results, tag);
				}
			}
		}
		return results;
	}

	/**
	 * 使用 SurroundingsRemover 解析 XML 内容（参考 Void 的 parseXMLPrefixToToolCall）。
	 * 尝试从 XML 格式的内容中提取工具名称和参数。
	 * 返回 { name, args } 或 null（如果无法解析）。
	 */
	private _tryParseXmlWithSurroundingsRemover(content: string): { name: string; args: string } | null {
		try {
			const pm = new SurroundingsRemover(content);

			// 尝试查找 <name>value</name> 或 <tool_name>value</tool_name> 标签
			const allowedNames = ['name', 'tool_name', 'tool', 'function'];
			let toolName: string | null = null;
			let argsStr = '{}';

			// 先尝试查找 </think> 标签（清理被污染的标签）
			const thinkEnd = pm.value().indexOf('</think>');
			if (thinkEnd !== -1) {
				// 有 </think> 标签，截断
				pm.j = thinkEnd - 1;
			}

			// 简化实现：查找第一个 <word> 标签作为工具名
			// 格式: <terminal> 或 <name>terminal</name>
			for (const n of allowedNames) {
				const found = pm.removePrefix(`<${n}>`);
				if (found) {
					toolName = n;
					// 查找 </name> 结束标记
					const endIdx = pm.value().indexOf(`</${n}>`);
					if (endIdx !== -1) {
						pm.i = endIdx + `</${n}>`.length;
					}
					break;
				}
			}

			// 如果没找到 <name> 格式，尝试属性格式 name="xxx"
			if (!toolName) {
				const attrMatch = pm.value().match(/(?:name|tool|function)\s*[:=]\s*["']?(\w+)["']?/i);
				if (attrMatch) {
					toolName = attrMatch[1];
				}
			}

			if (!toolName) {
				return null;
			}

			// 尝试提取参数（简化：返回空 args）
			// TODO: 实现完整的参数解析
			return { name: toolName, args: argsStr };
		} catch {
			return null;
		}
	}

	/**
	 * 处理 XML 标签内容（统一处理闭合和未闭合标签的 content）。
	 */
	private _processXmlTagContent(content: string, results: IToolCallInfo[], tag: string): void {
		// XML 内部可能是 JSON
		if (content.startsWith('{')) {
			try {
				const parsed = JSON.parse(content);
				const tc = this._parseSingleToolCall(parsed);
				if (tc) { results.push(tc); }
			} catch { /* ignore */ }
		} else {
			// 清理被 </think> 等标签污染的内容（取第一个有效工具名）
			const cleanContent = content.split(/\s*<\//)[0].trim();

			// 优先：从 <arg_key>...</arg_value> 格式中提取参数（不依赖 split 丢失子标签）
			const argsFromNested: Record<string, string> = {};
			const nestedArgRegex = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>\s*([^<]*?)\s*<\/arg_value>/gi;
			let nMatch: RegExpExecArray | null;
			while ((nMatch = nestedArgRegex.exec(content)) !== null) {
				argsFromNested[nMatch[1].trim()] = nMatch[2].trim();
			}

			// 新增：尝试使用 SurroundingsRemover 解析 XML 内容（参考 Void 的 parseXMLPrefixToToolCall）
			const xmlParsed = this._tryParseXmlWithSurroundingsRemover(cleanContent);
			if (xmlParsed) {
				this._logService.info(`[AgentOS] _processXmlTagContent: parsed via SurroundingsRemover: name=${xmlParsed.name}`);
				results.push({
					id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: xmlParsed.name,
					arguments: xmlParsed.args === '{}' && Object.keys(argsFromNested).length > 0
						? JSON.stringify(argsFromNested)
						: xmlParsed.args,
				});
				return; // 解析成功，提前返回
			}

			// XML 属性式: <tool_call name="xxx"><param key="val"/></tool_call>
			const nameMatch = cleanContent.match(/(?:name|tool|function)\s*[:=]\s*["']?(\w+)["']?/i);
			const argsMatch = cleanContent.match(/(?:arguments?|params?|input)\s*[:=]\s*({[\s\S]*})/i);
			if (nameMatch) {
				let args = '{}';
				if (argsMatch) {
					try { JSON.parse(argsMatch[1]); args = argsMatch[1]; } catch { /* use default */ }
				} else if (Object.keys(argsFromNested).length > 0) {
					args = JSON.stringify(argsFromNested);
				}
				results.push({
					id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: nameMatch[1],
					arguments: args,
				});
			} else if (/^[\w_\-]+$/.test(cleanContent)) {
				// 兜底: content 本身是纯文本工具名，如 <tool_call>terminal</tool_call>
				this._logService.info(`[AgentOS] _extractToolCallsFromXml: treating content as raw tool name: "${cleanContent}"`);
				results.push({
					id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: cleanContent,
					arguments: Object.keys(argsFromNested).length > 0 ? JSON.stringify(argsFromNested) : '{}',
				});
			} else {
				this._logService.info(`[AgentOS] _extractToolCallsFromXml: unprocessable content for <${tag}>: "${cleanContent.substring(0, 60)}"`);
			}
		}
	}

	/**
	 * 从 Bracket 格式提取工具调用。
	 * 支持: [TOOL_CALL]...[/TOOL_CALL], [FUNCTION]...[/FUNCTION]
	 */
	private _extractToolCallsFromBrackets(text: string): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];
		const bracketTags = ['TOOL_CALL', 'FUNCTION', 'TOOL', 'ACTION'];

		for (const tag of bracketTags) {
			const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[/${tag}\\]`, 'gi');
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				const content = match[1].trim();
				if (content.startsWith('{')) {
					try {
						const parsed = JSON.parse(content);
						const tc = this._parseSingleToolCall(parsed);
						if (tc) { results.push(tc); }
					} catch { /* ignore */ }
				} else if (/^[\w_\-]+$/.test(content)) {
					// 兜底: content 本身是纯文本工具名，如 [TOOL_CALL]terminal[/TOOL_CALL]
					this._logService.info(`[AgentOS] _extractToolCallsFromBrackets: treating content as raw tool name: "${content}"`);
					results.push({
						id: `bracket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: content,
						arguments: '{}',
					});
				}
			}
		}
		return results;
	}

	/**
	 * 从 ReAct 格式提取工具调用。
	 * 格式: Action: tool_name\nAction Input: { ... }
	 */
	private _extractToolCallsFromReAct(text: string): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];

		// 匹配 "Action:" 后跟工具名，然后 "Action Input:" 后跟 JSON
		const reactPattern = /Action\s*:\s*(\w+)\s*\n+\s*Action\s*Input\s*:\s*([\s\S]*?)(?=\n\s*(?:Observation|Action|Thought)|\n\n|$)/gi;
		let match: RegExpExecArray | null;
		while ((match = reactPattern.exec(text)) !== null) {
			const toolName = match[1].trim();
			let argsStr = match[2].trim();

			// 尝试解析参数
			if (!argsStr.startsWith('{')) {
				argsStr = `{"input": ${JSON.stringify(argsStr)}}`;
			} else {
				try { JSON.parse(argsStr); } catch {
					argsStr = `{"input": ${JSON.stringify(argsStr)}}`;
				}
			}

			results.push({
				id: `react_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: toolName,
				arguments: argsStr,
			});
		}
		return results;
	}

	/**
	 * 从 Python 函数调用语法中提取工具调用。
	 * 支持：
	 *   - ```python\ntool_name(arg1="val1", arg2=val2)\n```
	 *   - 行内: tool_name(command="pwd")
	 *   - 多行调用: tool_name(\n  arg1="val",\n  arg2=123\n)
	 *
	 * 这是 qwen3.5 等不支持原生 function calling 的模型常见的输出格式。
	 */
	private _extractToolCallsFromPythonSyntax(text: string, enabledTools?: Set<string>): IToolCallInfo[] {
		const results: IToolCallInfo[] = [];

		// 先提取 ```python 代码块中的内容
		const codeBlockRegex = /```(?:python|Python)?\s*\n([\s\S]*?)\n\s*```/g;
		const codeBlocks: string[] = [];
		let cbMatch: RegExpExecArray | null;
		while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
			codeBlocks.push(cbMatch[1].trim());
		}

		// 如果没有代码块，整个文本作为候选
		const candidates = codeBlocks.length > 0 ? codeBlocks : [text];

		for (const candidate of candidates) {
			// 匹配 Python 函数调用: name(key="value", key2=123, key3=True/False/None)
			// 支持多行参数、嵌套引号、数值/布尔/None 字面量
			const funcCallPattern = /(\w+)\s*\(([\s\S]*?)\)/g;
			let fcMatch: RegExpExecArray | null;
			while ((fcMatch = funcCallPattern.exec(candidate)) !== null) {
				const funcName = fcMatch[1];
				const argsStr = fcMatch[2].trim();

				// 跳过明显不是工具调用的内容（Python 关键字、print 等）
				const skipNames = new Set(['print', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
					'type', 'isinstance', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted',
					'if', 'for', 'while', 'with', 'class', 'def', 'return', 'import', 'from',
					'true', 'false', 'none', 'null', 'self', 'super']);
				if (skipNames.has(funcName.toLowerCase())) { continue; }

				// 白名单过滤：如果提供了 enabledTools，只保留精确匹配已注册工具名的调用
				// 这防止 LLM 分析代码时输出的函数名（如 OnPostGarbageCollection）被误解析为工具调用
				if (enabledTools && enabledTools.size > 0) {
					if (!enabledTools.has(funcName)) {
						continue;
					}
				} else {
					// enabledTools 为空 — 记录警告，这可能导致误匹配
					this._logService.warn(`[AgentOS] _extractToolCallsFromPythonSyntax: enabledTools is empty, cannot filter "${funcName}"`);
				}

				// 解析参数
				const args = this._parsePythonKwargs(argsStr);
				if (args && Object.keys(args).length > 0) {
					results.push({
						id: `pyfunc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: funcName,
						arguments: JSON.stringify(args),
					});
				} else if (args !== null) {
					// 无参数的函数调用
					results.push({
						id: `pyfunc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: funcName,
						arguments: '{}',
					});
				}
			}
		}

		return results;
	}

	/**
	 * 解析 Python keyword arguments 字符串为 Record<string, unknown>。
	 * 输入如: command="pwd", timeout=180, background=False
	 */
	private _parsePythonKwargs(argsStr: string): Record<string, unknown> | null {
		if (!argsStr || argsStr.trim() === '') { return {}; }

		// 如果参数字符串是 JSON 对象格式（以 '{' 开头），直接解析为 JSON
		// 这处理了 LLM 输出 tool_name({"arg": "value"}) 格式的情况
		const trimmed = argsStr.trim();
		if (trimmed.startsWith('{')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {
				// 不是有效 JSON，继续 Python kwargs 解析
			}
		}

		const result: Record<string, unknown> = {};
		let i = 0;
		const len = argsStr.length;

		while (i < len) {
			// 跳过空白和逗号
			while (i < len && (argsStr[i] === ' ' || argsStr[i] === '\t' || argsStr[i] === '\n' || argsStr[i] === ',')) { i++; }
			if (i >= len) { break; }

			// 读取 key
			const keyStart = i;
			while (i < len && /[\w_]/.test(argsStr[i])) { i++; }
			const key = argsStr.slice(keyStart, i);
			if (!key) { break; }

			// 跳过空白
			while (i < len && argsStr[i] === ' ') { i++; }

			// 期待 '='
			if (i >= len || argsStr[i] !== '=') { return null; }
			i++; // skip '='

			// 跳过空白
			while (i < len && argsStr[i] === ' ') { i++; }

			// 读取 value
			if (i >= len) { break; }

			if (argsStr[i] === '"' || argsStr[i] === "'") {
				// 字符串值
				const quote = argsStr[i];
				i++;
				let value = '';
				while (i < len && argsStr[i] !== quote) {
					if (argsStr[i] === '\\' && i + 1 < len) {
						const next = argsStr[i + 1];
						if (next === 'n') { value += '\n'; i += 2; }
						else if (next === 't') { value += '\t'; i += 2; }
						else if (next === quote) { value += quote; i += 2; }
						else if (next === '\\') { value += '\\'; i += 2; }
						else { value += next; i += 2; }
					} else {
						value += argsStr[i];
						i++;
					}
				}
				if (i < len) { i++; }
				result[key] = value;
			} else if (argsStr[i] === '{' || argsStr[i] === '[') {
				// JSON 对象或数组
				const open = argsStr[i];
				const close = open === '{' ? '}' : ']';
				let depth = 0;
				const jsonStart = i;
				while (i < len) {
					if (argsStr[i] === open) { depth++; }
					else if (argsStr[i] === close) { depth--; }
					i++;
					if (depth === 0) { break; }
				}
				try {
					result[key] = JSON.parse(argsStr.slice(jsonStart, i));
				} catch {
					result[key] = argsStr.slice(jsonStart, i);
				}
			} else {
				// 数字、布尔、None/null 或裸字符串
				const valStart = i;
				while (i < len && argsStr[i] !== ',' && argsStr[i] !== ' ' && argsStr[i] !== '\n' && argsStr[i] !== ')') { i++; }
				const rawVal = argsStr.slice(valStart, i).trim();
				if (rawVal === 'True' || rawVal === 'true') { result[key] = true; }
				else if (rawVal === 'False' || rawVal === 'false') { result[key] = false; }
				else if (rawVal === 'None' || rawVal === 'null') { result[key] = null; }
				else if (/^-?\d+(\.\d+)?$/.test(rawVal)) { result[key] = Number(rawVal); }
				else { result[key] = rawVal; }
			}
		}

		return Object.keys(result).length > 0 ? result : null;
	}

	/**
	 * 从模型的 thinking/reasoning 内容中提取工具名称。
	 * 支持模式如："使用 terminal 工具"、"call the terminal tool"、"use terminal"
	 */
	private _extractToolNameFromThinking(thinking: string): string | null {
		if (!thinking) { return null; }

		// 模式1: "使用 xxx 工具" / "调用 xxx 工具" / "用 xxx 来"
		const zhMatch = thinking.match(/(?:使用|调用|用)\s*[`'""]?(\w+)[`'""]?\s*(?:工具|来|命令)/);
		if (zhMatch) { return zhMatch[1]; }

		// 模式2: "use the xxx tool" / "call xxx" / "invoke xxx"
		const enMatch = thinking.match(/(?:use|call|invoke|using)\s+(?:the\s+)?[`'""]?(\w+)[`'""]?\s*(?:tool|function|command)?/i);
		if (enMatch) { return enMatch[1]; }

		// 模式3: 直接匹配已知工具名模式（常见工具名如 terminal, file_read, file_write 等）
		const knownToolPattern = /\b(terminal|file_read|file_write|execute_command|search_files?|list_files?|run_command|shell|bash|exec)\b/i;
		const knownMatch = thinking.match(knownToolPattern);
		if (knownMatch) { return knownMatch[1].toLowerCase(); }

		return null;
	}

	/**
	 * 从文本中提取顶层 JSON 对象（支持嵌套大括号）
	 */
	private _extractJsonObjects(text: string): string[] {
		const results: string[] = [];
		let i = 0;
		while (i < text.length) {
			if (text[i] === '{') {
				let depth = 0;
				let inString = false;
				let escape = false;
				const start = i;
				let found = false;
				for (let j = i; j < text.length; j++) {
					const ch = text[j];
					if (escape) { escape = false; continue; }
					if (ch === '\\' && inString) { escape = true; continue; }
					if (ch === '"' && !escape) { inString = !inString; continue; }
					if (inString) { continue; }
					if (ch === '{') { depth++; }
					else if (ch === '}') {
						depth--;
						if (depth === 0) {
							const candidate = text.slice(start, j + 1);
							// Quick check: does it look like a tool call?
							if (/["'](?:tool_name|tool|function|name)["']\s*:/i.test(candidate) &&
								/["'](?:arguments|args|parameters|params|command)["']\s*:/i.test(candidate)) {
								results.push(candidate);
							}
							i = j + 1;
							found = true;
							break;
						}
					}
				}
				if (!found) {
					// Unclosed brace — skip past it
					i = start + 1;
				}
			} else {
				i++;
			}
		}
		return results;
	}

	/**
	 * 解析 <tool> 标签的特殊格式，支持两种变体：
	 *
	 * 格式 A（▷ 头部）：
	 *   ▷{"tool_call_id":"...","name":"terminal","display_name":"...","render_type":"...","default_show":true}
	 *   <document>{"command":"...","cwd":"...",...}</document>
	 *
	 * 格式 B（<tool_call> 子标签）：
	 *   <tool_call>{"tool_call_id":"...","name":"web_preview","display_name":"...","render_type":"...","default_show":true}</tool_call>
	 *   <document>{"url":"...",...}</document>
	 */
	private _parseToolXMLFormat(content: string): IToolCallInfo | null {
		// 先尝试格式 B：<tool_call> 子标签
		const toolCallMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
		if (toolCallMatch) {
			try {
				const header = JSON.parse(toolCallMatch[1].trim());
				const args = this._extractToolDocument(content);
				this._logService.info(`[AgentOS] _parseToolXMLFormat format B (tool_call): name=${header.name}, default_show=${header.default_show} (type=${typeof header.default_show}), displayName=${header.display_name}, renderType=${header.render_type}`);
				return {
					id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: header.name || header.tool_name || header.tool || '',
					arguments: args ? JSON.stringify(args) : '{}',
					displayName: header.display_name,
					renderType: header.render_type,
					defaultShow: header.default_show !== false,
				};
			} catch (e) {
				this._logService.info(`[AgentOS] _parseToolXMLFormat format B parse error: ${e}`);
				/* fall through to format A */
			}
		}

		// 格式 A：提取 ▷ 后面的 JSON 头部
		const headerMatch = content.match(/[▷►]\s*(\{[\s\S]*?\})\s*\n/);
		if (!headerMatch) {
			// 尝试无 ▷ 前缀的纯 JSON 格式（第一行 JSON）
			const plainJsonMatch = content.match(/^(\{[^<]*?\})\s*\n/);
			if (!plainJsonMatch) {
				this._logService.info(`[AgentOS] _parseToolXMLFormat: no format matched, content preview=${content.substring(0, 120)}`);
				return null;
			}
			try {
				const header = JSON.parse(plainJsonMatch[1]);
				const args = this._extractToolDocument(content);
				this._logService.info(`[AgentOS] _parseToolXMLFormat format A (plain JSON): name=${header.name}, default_show=${header.default_show} (type=${typeof header.default_show}), displayName=${header.display_name}, renderType=${header.render_type}`);
				return {
					id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: header.name || header.tool_name || header.tool || '',
					arguments: args ? JSON.stringify(args) : '{}',
					displayName: header.display_name,
					renderType: header.render_type,
					defaultShow: header.default_show !== false,
				};
			} catch { return null; }
		}

		try {
			const header = JSON.parse(headerMatch[1]);
			const args = this._extractToolDocument(content);
			this._logService.info(`[AgentOS] _parseToolXMLFormat format A (▷ prefix): name=${header.name}, default_show=${header.default_show} (type=${typeof header.default_show}), displayName=${header.display_name}, renderType=${header.render_type}`);
			return {
				id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: header.name || header.tool_name || header.tool || '',
				arguments: args ? JSON.stringify(args) : '{}',
				displayName: header.display_name,
				renderType: header.render_type,
				defaultShow: header.default_show !== false,
			};
		} catch {
			return null;
		}
	}

	/**
	 * 从 <tool> 内容中提取 <document> 子标签的 JSON 数据。
	 */
	private _extractToolDocument(content: string): Record<string, unknown> | null {
		const docMatch = content.match(/<document>([\s\S]*?)<\/document>/);
		if (!docMatch) { return null; }
		try {
			return JSON.parse(docMatch[1].trim());
		} catch {
			return null;
		}
	}


	/**
	 * 解析单个 JSON 对象为 IToolCallInfo
	 * Enhanced with OpenClaw-inspired multi-field resolution:
	 *  - Name: tool_name → function → name → tool
	 *  - Args: arguments → args → parameters → params → input (Anthropic)
	 *  - ID: id → tool_use_id → toolUseId → tool_call_id
	 *
	 * Also supports argument-only JSON inference: when a model outputs only
	 * parameters (e.g. {"command": "pwd"}), we infer the tool name from the
	 * parameter keys by matching against enabled tool schemas.
	 */
	private _parseSingleToolCall(parsed: any, enabledTools?: IToolDefinition[]): IToolCallInfo | null {
		let name = parsed.tool_name || parsed.function || parsed.name || parsed.tool;

		// Fallback 1: {"toolName": {"arg": "val"}} format
		if (!name || typeof name !== 'string') {
			const keys = Object.keys(parsed);
			const reserved = new Set(['id', 'tool_use_id', 'toolUseId', 'tool_call_id']);
			const candidateKeys = keys.filter(k => !reserved.has(k));
			if (candidateKeys.length === 1 && typeof parsed[candidateKeys[0]] === 'object' && parsed[candidateKeys[0]] !== null && !Array.isArray(parsed[candidateKeys[0]])) {
				name = candidateKeys[0];
				return {
					id: `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name,
					arguments: JSON.stringify(parsed[name]),
				};
			}
		}

		// Fallback 2: argument-only JSON — infer tool name from parameter keys
		if (!name && enabledTools && enabledTools.length > 0) {
			const parsedKeys = Object.keys(parsed).filter(k => !['id', 'tool_use_id', 'toolUseId', 'tool_call_id'].includes(k));
			if (parsedKeys.length > 0) {
				// Find the tool whose schema has the most matching parameter keys
				let bestMatch: { tool: IToolDefinition; score: number } | null = null;
				for (const tool of enabledTools) {
					const schemaKeys = Object.keys((tool.inputSchema as any)?.properties || {});
					const requiredKeys: string[] = (tool.inputSchema as any)?.required || [];
					let score = 0;
					for (const key of parsedKeys) {
						if (schemaKeys.includes(key)) { score += 2; }
						if (requiredKeys.includes(key)) { score += 3; }
					}
					if (score > 0 && (!bestMatch || score > bestMatch.score)) {
						bestMatch = { tool, score };
					}
				}
				if (bestMatch && bestMatch.score >= 3) {
					name = bestMatch.tool.name;
					this._logService.info(`[AgentOS] Inferred tool name '${name}' from parameter keys [${parsedKeys.join(', ')}] (score=${bestMatch.score})`);
				}
			}
		}

		if (!name || typeof name !== 'string') {
			return null;
		}

		// Use OpenClaw-style multi-field resolution for arguments
		let rawArgs = parsed.arguments || parsed.args || parsed.parameters || parsed.params || parsed.input;

		// Fallback: some models put args at top-level (e.g. {"tool": "terminal", "command": "pwd"})
		if (!rawArgs || (typeof rawArgs === 'object' && Object.keys(rawArgs).length === 0)) {
			const reservedKeys = new Set(['tool_name', 'function', 'name', 'tool', 'id', 'tool_use_id', 'toolUseId', 'tool_call_id']);
			const inferredArgs: Record<string, any> = {};
			for (const key of Object.keys(parsed)) {
				if (!reservedKeys.has(key)) {
					inferredArgs[key] = parsed[key];
				}
			}
			if (Object.keys(inferredArgs).length > 0) {
				rawArgs = inferredArgs;
			}
		}
		if (!rawArgs) { rawArgs = {}; }

		let argsStr: string;
		if (typeof rawArgs === 'string') {
			// Some models output arguments as a JSON string — validate/repair
			const repaired = repairToolArguments(rawArgs);
			argsStr = repaired ? JSON.stringify(repaired) : rawArgs;
		} else if (typeof rawArgs === 'object' && rawArgs !== null) {
			argsStr = JSON.stringify(rawArgs);
		} else {
			argsStr = '{}';
		}

		// Resolve ID using OpenClaw-style multi-field lookup
		const id = parsed.id || parsed.tool_use_id || parsed.toolUseId || parsed.tool_call_id
			|| `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		return {
			id: String(id),
			name,
			arguments: argsStr,
		};
	}

	/**
	 * 带 Fallback 的执行包装器
	 * @param primaryExecution 主执行函数
	 * @param request 请求参数
	 */
	private async * _executeWithFallback(
		primaryExecution: () => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
	): AsyncIterable<IChatStreamDelta> {
		let lastError: Error | undefined;
		let attempt = 0;
		const triedModels: string[] = [];

		// 尝试主执行
		try {
			yield* primaryExecution();
			return; // 成功，直接返回
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			this._logService.warn(`[AgentOS] Primary execution failed (attempt ${attempt + 1}):`, error);
			attempt++;
		}

		// ── 容错机制已关闭：不尝试备用模型，直接上报错误 ──
		this._logService.warn(`[AgentOS] Model fallback is disabled — primary execution failed, no fallback will be attempted`);
		yield {
			type: 'error',
			content: this._formatUserFacingError(lastError, triedModels),
		};
		return;
	}

	// 原 _executeWithFallback 的备用模型块（已停用，保留做参考）
	/*

		// Fallback: 尝试备用模型
		const modelProvider = this._getActiveModelProvider();
		if (!modelProvider) {
			yield {
				type: 'error',
				content: this._formatUserFacingError(lastError, triedModels),
			};
			return;
		}

		const primaryModelId = this.getActiveModelSelection().modelId;
		// provider-aware 候选：优先保留 provider 真实支持的硬编码 fallback，
		// 再补上 provider 的其它可用模型；listModels 失败回退硬编码列表。
		const fallbackModels = await this._resolveFallbackCandidates(primaryModelId);

		for (const fallbackModel of fallbackModels) {
			triedModels.push(fallbackModel);
			if (attempt >= this._maxFallbackAttempts) {
				this._logService.warn(`[AgentOS] Max fallback attempts (${this._maxFallbackAttempts}) reached`);
				break;
			}

			// 退避：指数退避 + 抖动，缓解限流（429）风暴，对齐 LangGraph RetryPolicy。
			// 绑定当前 turn 的 AbortController，取消时可立即跳出等待。
			try {
				await sleepWithAbort(
					computeBackoffDelay(attempt, this._modelRetryPolicy),
					this._loopAbortController?.signal,
				);
			} catch {
				// 退避期间被取消 —— 直接放弃后续 fallback
				break;
			}

			try {
				const reason = (lastError instanceof DOMException && lastError.name === 'TimeoutError')
					? '模型响应超时' : '上一模型调用失败';
				this._logService.info(`[AgentOS] Trying fallback model: ${fallbackModel} (reason: ${reason})`);
				yield {
					type: 'text',
					content: `\n[System: 正在切换到备用模型 ${fallbackModel}（${reason}）…]\n`,
				};

				// 将 systemPrompt 注入到 messages 最前面作为 system message
				let messages: any[];
				if (request.systemPrompt) {
					messages = [
						{ role: 'system', content: request.systemPrompt },
						...request.messages,
					];
				} else {
					messages = request.messages as any[];
				}
				const options = request.options as any;
				// 传递 context（包含 agentId）给 provider
				const context: { agentId?: string } = {};
				if (request.agentId) {
					context.agentId = request.agentId;
				}
			const rawStream = await modelProvider.chat(fallbackModel, messages, options, context);
			// 备用模型流同样套 idle 超时：避免挂起的备用模型拖垮整轮（失败将由外层 catch 继续下一个 fallback）。
			const stream = withStreamTimeout(rawStream, this._modelStreamTimeoutPolicy, {
				signal: this._loopAbortController?.signal,
				log: (lvl, msg) => {
					if (lvl === 'error') { this._logService.error(msg); }
					else if (lvl === 'warn') { this._logService.warn(msg); }
					else { this._logService.info(msg); }
				},
			});

			for await (const delta of stream) {
				yield this._adaptModelDelta(delta);
			}

				// 成功，返回
				this._logService.info(`[AgentOS] Fallback model ${fallbackModel} succeeded`);
				return;

			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				this._logService.warn(`[AgentOS] Fallback model ${fallbackModel} failed:`, error);
				attempt++;
			}
		}

		// 所有 Fallback 都失败
		this._logService.error('[AgentOS] All fallback attempts failed');
		yield {
			type: 'error',
			content: this._formatUserFacingError(lastError, triedModels),
		};
	}
	*/

	/**
	 * 计算对当前激活 Provider 真实可用的备用模型列表（provider-aware fallback）。
	 *
	 * 此前 `_fallbackModels` 硬编码 OpenAI 模型 ID（gpt-4o 等），直接传给当前
	 * provider（可能是 IOA 网关 / Claude / Knot）。若该 provider 不识别这些 ID，
	 * fallback 会立刻失败或同样挂起，形同虚设。改为：
	 *  1. 优先保留 provider 真实支持的硬编码 fallback；
	 *  2. 再补上 provider 的其它可用模型（排除主模型），按偏好排序；
	 *  3. listModels 失败/超时则回退硬编码列表，保证非 provider-aware 场景不变。
	 */
	/* 容错机制已关闭，保留供日后恢复参考
	private async _resolveFallbackCandidates(primaryModelId: string): Promise<string[]> {
		const hardcoded = this._fallbackModels.filter(m => m !== primaryModelId);
		const provider = this._getActiveModelProvider();
		if (!provider) {
			return hardcoded;
		}
		try {
			const models = await provider.listModels();
			const availableIds = models.map(m => m.id);
			const availableSet = new Set(availableIds);
			const supportedHardcoded = hardcoded.filter(m => availableSet.has(m));
			const others = availableIds.filter(id => id !== primaryModelId && !hardcoded.includes(id));
			// 偏好排序：含 4o/turbo/sonnet/pro/latest/gpt/claude 的靠前
			const PREFER = ['4o', 'turbo', 'sonnet', 'pro', 'latest', 'gpt', 'claude'];
			const scoreOf = (id: string): number => {
				const lower = id.toLowerCase();
				let best = PREFER.length;
				PREFER.forEach((kw, i) => { if (lower.includes(kw)) { best = Math.min(best, i); } });
				return best;
			};
			others.sort((a, b) => scoreOf(a) - scoreOf(b));
			const merged = [...supportedHardcoded, ...others];
			return merged.length > 0 ? [...new Set(merged)] : hardcoded;
		} catch (error) {
			this._logService.warn('[AgentOS] listModels failed during fallback resolution, using hardcoded list', error);
			return hardcoded;
		}
	}
	*/

	/**
	 * 把底层错误翻译成面向用户的清晰中文提示（替代裸 TimeoutError / 英文堆栈）。
	 * 重点处理模型流 idle 超时（TCP 连接存活但不再吐数据）这类用户可理解的场景。
	 */
	private _formatUserFacingError(error: Error | undefined, triedModels: string[]): string {
		const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
		if (isTimeout) {
			const idleSec = Math.round((this._modelStreamTimeoutPolicy.idleTimeout ?? 180_000) / 1000);
			const tried = triedModels.length > 0 ? triedModels.join('、') : '无';
			return [
				'⚠️ 模型响应超时',
				'',
				`主模型在约 ${idleSec} 秒内未返回任何内容。系统已自动尝试切换备用模型（${tried}），但仍未成功。`,
				'',
				'可能原因：',
				'· 网络或网关连接不稳定（连接存活但不再吐出数据）',
				'· 当前请求体过大，网关在生成大响应时卡住',
				'',
				'建议：稍后重试，或在设置中切换到更稳定的模型 / Provider。',
			].join('\n');
		}
		const msg = error?.message || '未知错误';
		const tried = triedModels.length > 0 ? `（已尝试备用模型：${triedModels.join('、')}）` : '';
		return `所有模型均调用失败${tried}。最后错误：${msg}`;
	}

	private _getActiveModelProvider(): IModelProvider | undefined {
		if (!this._activeSelection) {
			return undefined;
		}
		return this._modelProviders.find(p => p.id === this._activeSelection!.providerId);
	}

	private * _fallbackToDirectChat(request: IAgentTurnRequest): Generator<IChatStreamDelta, any, any> {
		// Phase 1: 直通模式 — 通过现有 agentChatService 发送
		// 此方法在 Phase 2 重构 agentChatService 后可移除
		this._logService.info('[AgentOS] Fallback: delegating to AgentChatService');
		// 返回空（Phase 1 暂时不实现直通）
		yield { type: 'error', content: 'No ModelProvider registered. Please install a Model Provider plugin.' };
	}

	private _adaptModelDelta(delta: any): IChatStreamDelta {
		// 将 IModelDelta 适配为 IChatStreamDelta。
		//
		// 防御性兜底：上游 IModelDelta（来自 BYOK / LM bridge / Knot 等多家 provider）
		// 不能保证 content 一定是 string —— 例如 vendor copilot 的 IChatResponsePart
		// 在 reasoning 阶段会送 type='text' 但 value=undefined 的占位 part。
		// 任何 undefined / non-string 内容如果直接透传到 webview，模板字符串拼接
		// 时会被 `${undefined}` 渲染成字面量 "undefined" 字符串污染 textBuffer。
		// 这里在适配层统一做 type-coercion，保证下游永远拿到 string 类型 content。
		const safeContent = (v: unknown): string => (typeof v === 'string' ? v : '');
		if (delta.type === 'text') {
			return { type: 'text', content: safeContent(delta.content) };
		}
		if (delta.type === 'thinking') {
			return { type: 'thinking', content: safeContent(delta.content) };
		}
		if (delta.type === 'tool_call' && delta.toolCall) {
			// Adapt tool_call delta to tool_start/tool_args chunks
			if (delta.toolCall.name) {
				const result: any = { type: 'tool_start' as any, content: '', toolCallId: delta.toolCall.id, toolName: delta.toolCall.name };
				// Forward display metadata if present
				if (delta.toolCall.displayName !== undefined) { result.displayName = delta.toolCall.displayName; }
				if (delta.toolCall.renderType !== undefined) { result.renderType = delta.toolCall.renderType; }
				if (delta.toolCall.defaultShow !== undefined) { result.defaultShow = delta.toolCall.defaultShow; }
				if (delta.toolCall.serverExecuted) { result.serverExecuted = true; }
				this._logService.info(`[AgentOS] _adaptModelDelta tool_start: name=${delta.toolCall.name}, defaultShow=${delta.toolCall.defaultShow}, displayName=${delta.toolCall.displayName}, renderType=${delta.toolCall.renderType}`);
				return result;
			}
			return { type: 'tool_args' as any, content: delta.toolCall.arguments || '', toolCallId: delta.toolCall.id };
		}
		if (delta.type === 'done') {
			return { type: 'done' };
		}
		if (delta.type === 'error') {
			return { type: 'error', content: safeContent(delta.error) || safeContent(delta.content) || 'Unknown error' };
		}
		// ── KV Cache: forward usage metrics (Anthropic Prompt Caching / OpenAI cached_tokens) ──
		// Without this branch, BYOK provider's `{ type: 'usage', usage: {...} }` delta would
		// fall through to the default `{ type: 'text', content: '' }` and be silently dropped
		// before reaching the host→webview boundary, leaving the UI unable to show cache hits.
		if (delta.type === 'usage' && delta.usage) {
			return { type: 'usage', usage: delta.usage };
		}
		return { type: 'text', content: '' };
	}

	// ─── Episodic 自动提取管线（对齐 AgentMemory Working→Episodic pipeline）────────────────────

	/**
	 * Episodic 自动提取：对话轮次达阈值时，后台调用 LLM 从最近对话中提取
	 * 结构化长期记忆（persona/episodic/instruction），写入 Memory Provider。
	 *
	 * 设计参考 AgentMemory 的 auto-capture + pipeline-manager：
	 * - AgentMemory 在 agent_end hook 自动记录 Working，由 pipeline-manager 调度 Episodic 提取
	 * - 本方法在 AgentDriver finally 块调用，计数达阈值后 fire-and-forget 触发
	 * - 不依赖 LLM 主动调 memory_remember，系统自动提取值得记住的事实
	 */
	triggerEpisodicExtraction(
		agentId: string,
		sessionId: string | undefined,
		recentUserText: string,
		recentAssistantText: string
	): void {
		// Episodic/Semantic/Procedural 提取始终执行（无论使用哪个 MemoryProvider）。
		//
		// 此前此处有一段对 agentmemory 的自动跳过逻辑，理由是"agentmemory 有自己的管线"，
		// 但实际 Opt1 下 gateway 进程从未触发 ConsolidationPipeline（host.mjs 无 sweep 定时器），
		// 导致固化完全瘫痪（详见 2026-07-14 审查报告）。现已移除跳过，恢复本地 Episodic 提取，
		// 结果通过 provider.writeMemory()（agentmemory 时走 proxy→gateway HTTP）正常持久化。
		//
		// 若需关闭自动提取（减少 LLM token 消耗），可在网关环境变量设
		// AGENTMEMORY_DISABLE_LOCAL_Episodic=true（仅 Node/main process 可见）。

		// 按 agentId::sessionId 双键隔离轮次计数：避免同 agent 的多个 session 并行时
		// 互相推进对方的 Episodic 触发阈值（跨会话记忆污染——多 session 并行评审要点）。
		// sessionId 为 undefined 时退化为 noSession 桶，与旧行为一致。
		const l1Key = this._turnKey(agentId, sessionId);
		const count = (this._l1ConversationCountByAgent.get(l1Key) ?? 0) + 1;
		this._l1ConversationCountByAgent.set(l1Key, count);

		if (count < AgentOSService.EPISODIC_EXTRACTION_THRESHOLD) {
			this._logService.info(`[AgentOS][Episodic] Conversation count for ${l1Key}: ${count}/${AgentOSService.EPISODIC_EXTRACTION_THRESHOLD} — not yet triggering extraction`);
			return;
		}

		// 达到阈值，清零并触发提取
		this._l1ConversationCountByAgent.set(l1Key, 0);
		this._logService.info(`[AgentOS][Episodic] Threshold reached (${l1Key}, ${count}≥${AgentOSService.EPISODIC_EXTRACTION_THRESHOLD}), triggering Episodic extraction for agent ${agentId}`);

		// fire-and-forget：不阻塞 AgentDriver 的 finally 块
		void this._performEpisodicExtraction(agentId, sessionId, recentUserText, recentAssistantText);
		this._l1ExtractionCount++;
		this._scheduleSave();
	}

	/**
	 * 实际执行 Episodic 提取：调用 LLM 分析最近对话，提取结构化长期记忆。
	 * 失败时静默记录日志，不影响主流程。
	 */
	private async _performEpisodicExtraction(
		agentId: string,
		sessionId: string | undefined,
		recentUserText: string,
		recentAssistantText: string
	): Promise<void> {
		const memProvider = this.getActiveMemoryProvider();
		const modelProvider = this._getActiveModelProvider();
		const selection = this.getActiveModelSelection();
		if (!memProvider || !modelProvider || !selection?.modelId) {
			this._logService.info(`[AgentOS][Episodic] Skipping extraction: memoryProvider=${!!memProvider} modelProvider=${!!modelProvider} modelId=${selection?.modelId ?? 'none'}`);
			return;
		}

		// 截取最近对话（避免 prompt 过长）
		const maxChars = 8000;
		const userText = recentUserText.slice(-maxChars);
		const assistantText = recentAssistantText.slice(-maxChars);

		const extractionPrompt = [
			'You are a memory extraction assistant. Analyze the following conversation and extract durable facts worth remembering across sessions.',
			'Only extract information that is: (1) a personal preference, (2) a project convention, (3) a naming rule, (4) an environment specific, (5) a long-term goal, or (6) an explicit "remember this" instruction.',
			'Do NOT extract transient task details, tool outputs, or temporary context.',
			'',
			'Output format: one fact per line, each as a JSON object:',
			'{"content":"<concise fact>","type":"<persona|episodic|instruction>"}',
			'',
			'If nothing worth remembering, output exactly: NONE',
			'',
			'--- Recent User Message ---',
			userText,
			'',
			'--- Recent Assistant Response ---',
			assistantText,
		].join('\n');

		try {
			const t0 = Date.now();
			const stream = modelProvider.chat(
				selection.modelId,
				[{ role: 'user', content: extractionPrompt } as any],
				{ temperature: 0.3, maxTokens: 1000 },
				{}
			);

			let extractionResult = '';
			for await (const delta of stream) {
				if (delta.type === 'text' && delta.content) {
					extractionResult += delta.content;
				}
				if (delta.type === 'done') {
					break;
				}
			}

			const durationMs = Date.now() - t0;
			const trimmed = extractionResult.trim();

			if (!trimmed || trimmed === 'NONE') {
				this._logService.info(`[AgentOS][Episodic] Extraction completed in ${durationMs}ms — nothing worth remembering`);
				return;
			}

			// 解析提取结果：每行一个 JSON 对象
			const lines = trimmed.split('\n').filter(l => l.trim().startsWith('{'));
			let extractedCount = 0;
			const ts = Date.now();
			for (const line of lines) {
				try {
					const fact = JSON.parse(line.trim());
					if (fact.content && fact.type) {
						await memProvider.writeMemory(agentId, {
							id: `l1-extract-${ts}-${extractedCount}`,
							type: 'episodic',
							content: fact.content,
							metadata: {
								owner: 'default',
								userId: 'default',
								agentId,
								sessionId: sessionId ?? '',
								memoryType: fact.type,
								source: 'l1_auto_extraction',
								extractedAt: new Date().toISOString(),
							},
							timestamp: ts + extractedCount,
						});
						extractedCount++;
					}
				} catch {
					// 单行 JSON 解析失败，跳过继续
				}
			}

			this._logService.info(
				`[AgentOS][Episodic] Extraction completed in ${durationMs}ms — extracted ${extractedCount} long-term memories for agent ${agentId}`
			);

			// Episodic 完成后触发 Semantic 提取（对齐 AgentMemory delay-after-Episodic 触发路径）
			if (extractedCount > 0) {
				this.triggerSemanticExtraction(agentId);
			}
		} catch (error) {
			this._logService.warn(
				`[AgentOS][Episodic] Extraction failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	// ─── Semantic 提取管线（对齐 AgentMemory Semantic）────────────────────────────────

	/**
	 * Semantic 提取触发：Episodic 完成后延迟触发，提取场景级摘要。
	 * 使用 per-agent 定时器，支持 downward-only 语义（只能提前不能延后）。
	 */
	triggerSemanticExtraction(agentId: string): void {
		const now = Date.now();
		const lastRun = this._l2LastRunTime.get(agentId) ?? 0;
		const minIntervalRemaining = Math.max(0, AgentOSService.SEMANTIC_MIN_INTERVAL_MS - (now - lastRun));
		const delay = Math.max(AgentOSService.SEMANTIC_DELAY_AFTER_EPISODIC_MS, minIntervalRemaining);

		// Downward-only：如果已有定时器，只在新的延迟更短时重新设置
		const existingTimer = this._l2TimersByAgent.get(agentId);
		if (existingTimer !== undefined) {
			// 已有定时器在等待，不重复设置（downward-only 语义由 delay 计算保证）
			this._logService.info(`[AgentOS][Semantic] Timer already pending for ${agentId}, skipping (downward-only)`);
			return;
		}

		this._logService.info(`[AgentOS][Semantic] Scheduling scene extraction for ${agentId} in ${delay}ms`);
		const timer = setTimeout(() => {
			this._l2TimersByAgent.delete(agentId);
			void this._performSemanticExtraction(agentId);
			this._l2ExtractionCount++;
			this._scheduleSave();
		}, delay);
		this._l2TimersByAgent.set(agentId, timer);
	}

	/**
	 * 执行 Semantic 提取：搜索近期 Episodic 记忆，调 LLM 生成场景级摘要。
	 */
	private async _performSemanticExtraction(agentId: string): Promise<void> {
		const memProvider = this.getActiveMemoryProvider();
		const modelProvider = this._getActiveModelProvider();
		const selection = this.getActiveModelSelection();
		if (!memProvider || !modelProvider || !selection?.modelId) {
			this._logService.info(`[AgentOS][Semantic] Skipping: missing provider or model`);
			return;
		}

		this._l2LastRunTime.set(agentId, Date.now());

		try {
			// 搜索近期 Episodic 提取的记忆（source=l1_auto_extraction）
			const recentMemories = await memProvider.searchMemory(agentId, '*');
			if (!recentMemories || recentMemories.length === 0) {
				this._logService.info(`[AgentOS][Semantic] No Episodic memories found for ${agentId}, skipping scene extraction`);
				return;
			}

			// 构建场景提取 prompt
			const memoryText = recentMemories
				.slice(0, 20) // 最多取 20 条
				.map((m: any) => `- ${m.content ?? ''}`)
				.join('\n');

			const scenePrompt = [
				'You are a scene extraction assistant. Analyze the following memory entries and extract high-level scene summaries.',
				'A scene summary captures the broader context of what the user is working on, their goals, and recurring patterns.',
				'',
				'Output format: one scene per line, each as a JSON object:',
				'{"scene_name":"<short label>","summary":"<1-2 sentence scene description>","keywords":["<keyword1>","<keyword2>"]}',
				'',
				'If no clear scenes emerge, output exactly: NONE',
				'',
				'--- Recent Memory Entries ---',
				memoryText,
			].join('\n');

			const t0 = Date.now();
			const stream = modelProvider.chat(
				selection.modelId,
				[{ role: 'user', content: scenePrompt } as any],
				{ temperature: 0.3, maxTokens: 1000 },
				{}
			);

			let sceneResult = '';
			for await (const delta of stream) {
				if (delta.type === 'text' && delta.content) {
					sceneResult += delta.content;
				}
				if (delta.type === 'done') { break; }
			}

			const durationMs = Date.now() - t0;
			const trimmed = sceneResult.trim();

			if (!trimmed || trimmed === 'NONE') {
				this._logService.info(`[AgentOS][Semantic] Scene extraction completed in ${durationMs}ms — no scenes extracted`);
				return;
			}

			// 解析场景摘要并写入
			const lines = trimmed.split('\n').filter(l => l.trim().startsWith('{'));
			let sceneCount = 0;
			const ts = Date.now();
			for (const line of lines) {
				try {
					const scene = JSON.parse(line.trim());
					if (scene.scene_name && scene.summary) {
						await memProvider.writeMemory(agentId, {
							id: `l2-scene-${ts}-${sceneCount}`,
							type: 'semantic',
							content: `[${scene.scene_name}] ${scene.summary}`,
							metadata: {
								owner: 'default',
								userId: 'default',
								agentId,
								memoryType: 'scene',
								source: 'l2_scene_extraction',
								keywords: scene.keywords ?? [],
								extractedAt: new Date().toISOString(),
							},
							timestamp: ts + sceneCount,
						});
						sceneCount++;
					}
				} catch { /* skip unparseable lines */ }
			}

			this._logService.info(
				`[AgentOS][Semantic] Scene extraction completed in ${durationMs}ms — extracted ${sceneCount} scenes for agent ${agentId}`
			);

			// Semantic 完成后触发 Procedural 生成
			this.triggerProceduralGeneration();

		} catch (error) {
			this._logService.warn(
				`[AgentOS][Semantic] Scene extraction failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	// ─── Procedural 生成管线（对齐 AgentMemory Procedural）────────────────────────────────

	/**
	 * Procedural 生成触发：Semantic 完成后触发，全局互斥 (concurrency=1) + pending dedup。
	 * 如果 Procedural 正在运行，只设 pending flag；运行中的 Procedural 结束后检查 flag 并重新触发。
	 */
	triggerProceduralGeneration(): void {
		if (this._proceduralRunning) {
			// 已有 Procedural 在运行 → 设 pending flag，运行结束后自动重新触发
			this._proceduralPending = true;
			this._logService.info(`[AgentOS][Procedural] Already running, setting pending flag for next round`);
			return;
		}
		void this._performProceduralGeneration();
		this._l3ExtractionCount++;
		this._scheduleSave();
	}

	/**
	 * 执行 Procedural 生成：搜索所有场景摘要，调 LLM 生成用户人格画像。
	 * 全局互斥：同时只有一个 Procedural 运行。
	 */
	private async _performProceduralGeneration(): Promise<void> {
		const memProvider = this.getActiveMemoryProvider();
		const modelProvider = this._getActiveModelProvider();
		const selection = this.getActiveModelSelection();
		if (!memProvider || !modelProvider || !selection?.modelId) {
			this._logService.info(`[AgentOS][Procedural] Skipping: missing provider or model`);
			return;
		}

		this._proceduralRunning = true;
		try {
			// 搜索所有场景摘要（memoryType=scene）
			const sceneMemories = await memProvider.searchMemory('*', 'scene');
			if (!sceneMemories || sceneMemories.length === 0) {
				this._logService.info(`[AgentOS][Procedural] No scene memories found, skipping persona generation`);
				return;
			}

			const sceneText = sceneMemories
				.slice(0, 30)
				.map((m: any) => `- ${m.content ?? ''}`)
				.join('\n');

			const personaPrompt = [
				'You are a persona generation assistant. Analyze the following scene summaries and generate a concise user persona profile.',
				'Focus on: professional domain, technical preferences, communication style, recurring goals, and working patterns.',
				'',
				'Output format (single JSON object):',
				'{"domain":"<professional domain>","expertise_level":"<beginner|intermediate|expert>","preferences":["<pref1>","<pref2>"],"communication_style":"<concise|detailed|casual|formal>","recurring_goals":["<goal1>"],"working_patterns":"<description>"}',
				'',
				'If insufficient data for a persona, output exactly: NONE',
				'',
				'--- Scene Summaries ---',
				sceneText,
			].join('\n');

			const t0 = Date.now();
			const stream = modelProvider.chat(
				selection.modelId,
				[{ role: 'user', content: personaPrompt } as any],
				{ temperature: 0.3, maxTokens: 800 },
				{}
			);

			let personaResult = '';
			for await (const delta of stream) {
				if (delta.type === 'text' && delta.content) {
					personaResult += delta.content;
				}
				if (delta.type === 'done') { break; }
			}

			const durationMs = Date.now() - t0;
			const trimmed = personaResult.trim();

			if (!trimmed || trimmed === 'NONE') {
				this._logService.info(`[AgentOS][Procedural] Persona generation completed in ${durationMs}ms — insufficient data`);
				return;
			}

			// 解析人格画像并写入
			try {
				// 提取第一个 JSON 对象（可能被 markdown 包裹）
				const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
				if (!jsonMatch) {
					this._logService.warn(`[AgentOS][Procedural] Could not parse persona JSON from LLM response`);
					return;
				}
				const persona = JSON.parse(jsonMatch[0]);
				const ts = Date.now();
				await memProvider.writeMemory('*', {
					id: `l3-persona-${ts}`,
					type: 'procedural',
					content: JSON.stringify(persona),
					metadata: {
						owner: 'default',
						userId: 'default',
						memoryType: 'persona',
						source: 'l3_persona_generation',
						extractedAt: new Date().toISOString(),
					},
					timestamp: ts,
				});

				this._logService.info(
					`[AgentOS][Procedural] Persona generation completed in ${durationMs}ms — persona written`
				);
			} catch (parseErr) {
				this._logService.warn(`[AgentOS][Procedural] Failed to parse persona JSON: ${parseErr}`);
			}

		} catch (error) {
			this._logService.warn(
				`[AgentOS][Procedural] Persona generation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
			);
		} finally {
			this._proceduralRunning = false;
			// 检查 pending flag：如果在运行期间有新的 Procedural 请求，重新触发
			if (this._proceduralPending) {
				this._proceduralPending = false;
				this._logService.info(`[AgentOS][Procedural] Pending flag detected, re-triggering Procedural`);
				void this._performProceduralGeneration();
			}
		}
	}

	// ─── 上下文压缩辅助方法（对齐 ExecutionProvider）──────────────────────

	/**
	 * 解析模型真实上下文窗口（token）。优先 maxInputTokens，其次 contextWindow，
	 * 取不到时回退到 128000。查询失败也回退，绝不抛出。
	 */
	private async _resolveContextWindow(
		provider: IModelProvider,
		modelId: string
	): Promise<number> {
		const FALLBACK = 128000;
		try {
			const models = await provider.listModels?.();
			const info = models?.find((m: any) => m.id === modelId);
			const win = info?.maxInputTokens ?? info?.contextWindow;
			if (typeof win === 'number' && win > 0) {
				return win;
			}
		} catch (err) {
			this._logService.warn(`[AgentOS] _resolveContextWindow failed for ${modelId}, falling back to ${FALLBACK}: ${err}`);
		}
		return FALLBACK;
	}

	/**
	 * Tool Defs 缓存失效触发 — 对齐 Hermes-Agent `model_tools._clear_tool_defs_cache()`。
	 *
	 * 当工具集动态变化时调用（MCP 重连、builtin 工具热加载、plugin 加载等）。
	 * 外部调用方可通过 (agentOSService as any)._bumpToolDefsCache() 触发。
	 */
	public _bumpToolDefsCache(): void {
		this._registryGeneration++;
		this._logService.info(`[AgentOS] Tool defs cache invalidated, generation=${this._registryGeneration}`);
	}

	/**
	 * 注册 Tool Set 变化监听器 — 对齐 Hermes `registry._generation` 失效机制。
	 *
	 * 监听以下事件源：
	 *   1. SlotRegistry.onDidChangeSlots（工具 provider 增删，如果存在）
	 *   2. IMcpService.onDidChangeMcpServers（MCP 服务器增删/重连）
	 *   3. ConfigService.onDidChangeConfiguration（用户配置修改）
	 *
	 * 任何事件触发时递增 _registryGeneration，强制 LRU 缓存下次 miss。
	 */
	private _registerToolSetChangeListeners(): void {
		let listenerCount = 0;

		// ① SlotRegistry: 工具 provider 增删（如果存在）
		const onChangeSlots = (this._slotRegistry as any).onDidChangeSlots;
		if (onChangeSlots) {
			this._register(onChangeSlots(() => {
				this._bumpToolDefsCache();
			}));
			listenerCount++;
		}

		// ② IMcpService: MCP 服务器变化（动态注入的 MCP 工具）
		const mcpService = (this as any)._mcpService;
		if (mcpService?.onDidChangeMcpServers) {
			this._register(mcpService.onDidChangeMcpServers(() => {
				this._bumpToolDefsCache();
			}));
			listenerCount++;
			this._logService.info('[AgentOS] Registered MCP server change listener for cache invalidation');
		}

		// ③ IConfigurationService: 配置变化（影响工具集定义）
		const configService = (this as any)._configService;
		if (configService?.onDidChangeConfiguration) {
			this._register(configService.onDidChangeConfiguration((e: any) => {
				// 只在工具集相关配置变化时触发
				if (e.affectsConfiguration?.('agentStudio.tools') ||
					e.affectsConfiguration?.('agentStudio.toolset') ||
					e.affectsConfiguration?.('agentStudio.disabledToolsets') ||
					e.affectsConfiguration?.('agentStudio.toolSearch')) {
					this._bumpToolDefsCache();
				}
			}));
			listenerCount++;
		}

		this._logService.info(`[AgentOS] Tool set change listeners registered (${listenerCount} active) for cache invalidation`);
	}

	/**
	 * 获取 config 指纹（mtime + size）— 对齐 Hermes-Agent `cfg_fp`。
	 * 失败时返回空字符串，缓存退化到只依赖 registryGeneration。
	 */
	private _getConfigFingerprint(): string {
		try {
			// 尝试获取 Agent Studio 配置文件路径
			const configPath = (this as any)._configService?.getConfigPath?.();
			if (!configPath) { return ''; }
			const stat = (this as any)._fileService?.stat?.(configPath);
			if (stat) {
				return `${stat.mtime}:${stat.size}`;
			}
		} catch { /* 忽略 */ }
		return '';
	}

	/**
	 * 设置当前 agent loop 使用的模型（每次循环入口调用，确保 context window 实时查表）。
	 * 对齐 Hermes-Agent `model_tools._resolve_active_context_length()` 每次实时查表的设计。
	 */
	public _setCurrentModel(provider: IModelProvider | undefined, modelId: string | undefined): void {
		this._currentModelProvider = provider;
		this._currentModelId = modelId;
	}

	/**
	 * 从 VS Code 设置中读取 Tool Search 配置（对齐 Hermes-Agent config.yaml）。
	 * 配置键：`agentStudio.toolSearch.enabled` / `agentStudio.toolSearch.thresholdPct`。
	 * 缺失配置时回退到 DEFAULT_TOOL_SEARCH_CONFIG。
	 */
	private _getToolSearchConfig(): IToolSearchConfig {
		try {
			const configService = (this as any)._configService;
			if (!configService) { return DEFAULT_TOOL_SEARCH_CONFIG; }
			const enabled = configService.getValue('agentStudio.toolSearch.enabled');
			const thresholdPct = configService.getValue('agentStudio.toolSearch.thresholdPct');
			if (enabled !== undefined || thresholdPct !== undefined) {
				const rawEnabled = typeof enabled === 'string' ? enabled : '';
				return {
					enabled: (['off', 'on', 'auto'] as string[]).includes(rawEnabled) ? (rawEnabled as 'off' | 'on' | 'auto') : DEFAULT_TOOL_SEARCH_CONFIG.enabled,
					thresholdPct: (typeof thresholdPct === 'number' && thresholdPct >= 0 && thresholdPct <= 100) ? thresholdPct : DEFAULT_TOOL_SEARCH_CONFIG.thresholdPct,
					searchDefaultLimit: DEFAULT_TOOL_SEARCH_CONFIG.searchDefaultLimit,
					maxSearchLimit: DEFAULT_TOOL_SEARCH_CONFIG.maxSearchLimit,
				};
			}
		} catch { /* 配置读取失败 — 回退默认 */ }
		return DEFAULT_TOOL_SEARCH_CONFIG;
	}

	/**
	 * 检测 focus 模式（带缓存，对齐 Hermes `auto` / `focus` 编码姿态切换）。
	 * 工作区不变时复用检测结果，避免每次 _getEnabledTools 都重新检测。
	 */
	private async _detectFocusModeIfNeeded(): Promise<IFocusModeResult> {
		const ws = this._workspaceContextService.getWorkspace();
		const workspaceKey = ws.folders.map(f => f.uri.fsPath).sort().join('|');

		if (this._focusModeCache && this._focusModeCache.workspaceKey === workspaceKey) {
			return this._focusModeCache.result;
		}

		const folders = ws.folders.map(f => f.uri.fsPath);
		// 使用带 probe 的版本（detectFocusMode 的 checkFileExists 是占位实现，永远返回 false）
		const probe: IFileProbe = {
			exists: async (path: string) => {
				try {
					await this._fileService.resolve(URI.file(path));
					return true;
				} catch { return false; }
			},
			listFolder: async (path: string) => {
				try {
					const stat = await this._fileService.resolve(URI.file(path));
					return (stat.children ?? []).map(c => c.name);
				} catch { return []; }
			},
		};
		const result = await detectFocusModeWithProbe(folders, probe, this._logService);
		this._focusModeCache = { workspaceKey, result };
		return result;
	}

	/**
	 * 粗略估算消息输入 token（char/4，与 ContextManager._estimateTokens 口径一致）。
	 * 用于压缩后回传 context_compacted 让圆环基线同步回落。
	 */
	private _estimateMessagesTokens(messages: ReadonlyArray<any>): number {
		const IMAGE_TOKEN_COST = 1500;
		let totalChars = 0;
		let imageTokens = 0;
		for (const m of messages) {
			if (!m) { continue; }
			const shadow: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
				if (k === 'contentParts' && Array.isArray(v)) {
					shadow[k] = v.map((p: any) => (p && p.type === 'image' ? { type: 'image', data: '[stripped]' } : p));
				} else {
					shadow[k] = v;
				}
			}
			if (Array.isArray(shadow.contentParts)) {
				imageTokens += shadow.contentParts.filter((p: any) => p?.type === 'image').length * IMAGE_TOKEN_COST;
			}
			try {
				totalChars += JSON.stringify(shadow).length;
			} catch {
				totalChars += (typeof m.content === 'string' ? m.content.length : 0);
			}
		}
		return Math.ceil(totalChars / 4) + imageTokens;
	}

	// ─── 检索式上下文：记忆检索 + 对话外置（对齐 agentmemory mem::context）──
	// 用于替代 compressContext 中的同步 LLM 摘要（原路径在高负载下可达 37s），
	// 消除压缩对首 token 的阻塞。默认开启（RETRIEVAL_COMPACTION_ENABLED）。

	// 检索式上下文注入前缀：必须与 contextManager.INJECTED_CONTEXT_PREFIX 完全一致，
	// 压缩时 contextManager 才会剥离该注入消息（避免与摘要重复累积）。
	private static readonly RETRIEVED_CTX_PREFIX = '## Preserved Context (from memory)';

	/**
	 * 仅检索：从记忆系统取回相关上下文，替代同步 LLM 摘要。
	 * 优先 getCompactContext（Zero-LLM 合成的 SessionSummary），否则回退
	 * recallFormatted（按当前任务 query 检索 episodic/semantic 记忆）。
	 */
	private async _retrieveContextOnly(
		provider: any,
		agentId: string,
		sessionId: string,
		middle: ReadonlyArray<any>,
		budget: number,
	): Promise<{ context: string; tokens: number; source: string } | null> {
		try {
			// 构造检索 query：取 middle 中最近一条 user 消息
			let query = 'current task context';
			for (let i = middle.length - 1; i >= 0; i--) {
				const m = middle[i];
				if (m && m.role === 'user') {
					const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
					if (c.trim()) { query = c.slice(0, 300); break; }
				}
			}

			// 优先 getCompactContext（SessionSummary），其次 recallFormatted
			let context = '';
			let source = 'recall';
			const compactCtx = await provider.getCompactContext?.(agentId, 5);
			if (Array.isArray(compactCtx) && compactCtx.length > 0) {
				context = compactCtx.map((s: any) =>
					`## ${s.title ?? 'Session'}\n${s.narrative ?? ''}\n` +
					`Decisions: ${(s.keyDecisions || []).join('; ')}\n` +
					`Files: ${(s.filesModified || []).join(', ')}`
				).join('\n\n');
				source = 'compact_context';
			}
			if (!context) {
				const recalled: unknown = await provider.recallFormatted(agentId, query, undefined, 10);
				if (typeof recalled === 'string' && recalled && !recalled.startsWith('memory_recall: no results')) {
					context = recalled;
					source = 'recall';
				}
			}
			if (!context) { return null; }
			const tokens = Math.ceil(context.length / 3);
			return { context, tokens, source };
		} catch {
			return null;
		}
	}

	/**
	 * 压缩期检索式上下文（对齐 agentmemory mem::context）：先增量外置 middle 到记忆，
	 * 再检索相关上下文替代同步 LLM 摘要。供 compressContext 的 retrieveContext 回调使用。
	 */
	private async _retrieveCompactionContext(
		provider: any,
		req: { agentId: string; sessionId: string; middle: ReadonlyArray<any>; contextWindow: number; budget: number },
	): Promise<{ context: string; tokens: number; source: string } | null> {
		// 压缩时仍把 middle 外置（best-effort），保持记忆与对话同步
		this._storeTurnObservations(provider, req.agentId, req.sessionId, req.middle).catch(() => {});
		return this._retrieveContextOnly(provider, req.agentId, req.sessionId, req.middle, req.budget);
	}

	/**
	 * 将对话增量外置为 episodic 记忆，供后续检索取回（对齐 agentmemory 把 observation
	 * 外置到 KV）。按内容哈希去重，避免重复写入与记忆膨胀；跳过 system 消息，
	 * 只外置 user/assistant/tool 的真实对话内容。
	 */
	private async _storeTurnObservations(
		provider: any,
		agentId: string,
		sessionId: string,
		messages: ReadonlyArray<any>,
	): Promise<void> {
		const seen = this._storedMiddleHashes.get(sessionId) ?? new Set<string>();
		this._storedMiddleHashes.set(sessionId, seen);
		for (const m of messages) {
			if (!m || m.role === 'system') { continue; }
			const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
			const text = content.trim();
			if (text.length < 8) { continue; }
			// 简单内容哈希去重
			let hash = 0;
			for (let i = 0; i < text.length; i++) { hash = (hash * 31 + text.charCodeAt(i)) | 0; }
			const key = String(hash);
			if (seen.has(key)) { continue; }
			seen.add(key);
			await provider.writeMemory(agentId, {
				id: `obs-${sessionId}-${key}`,
				type: 'episodic',
				content: `[${m.role ?? 'unknown'}] ${text.slice(0, 1500)}`,
				metadata: { role: m.role, sessionId, source: 'turn_observation' },
				timestamp: Date.now(),
			}).catch(() => {});
		}
	}

	/**
	 * 把检索到的上下文作为独立 system 消息注入（放在固定 system 之后、user 之前）。
	 * 使用 RETRIEVED_CTX_PREFIX，使压缩时 contextManager 会剥离它、由摘要接管，
	 * 避免与压缩摘要重复累积。已注入则跳过（去重）。
	 */
	private _injectRetrievalSystemMessage(messages: any[], context: string, _source: string): any[] {
		const already = messages.some(
			m => m?.role === 'system'
				&& typeof m.content === 'string'
				&& m.content.startsWith(AgentOSService.RETRIEVED_CTX_PREFIX),
		);
		if (already) { return messages; }
		const wrapped = `${AgentOSService.RETRIEVED_CTX_PREFIX}\n${context}`;
		let insertIdx = 0;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i]?.role === 'system') { insertIdx = i + 1; } else { break; }
		}
		return insertMessages(messages, insertIdx, { role: 'system', content: wrapped });
	}

}

