import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IAgentOSService, IAgentOSDashboardStats, IDashboardMetricsSnapshot, IDailyBucket, ISubAgentTraceSnapshot } from '../common/agentOS.js';
import {
	IModelProvider, IModelSelection, ModelAuthStatus,
	IMemoryProvider, IToolProvider, IPlanningProvider,
	IExecutionProvider, IRetrievalProvider, IKanbanProvider,
	IAgentTurnRequest, IChatStreamDelta, ISlotRegistry,
	IToolDefinition, IToolCallInfo, IToolResult,
	IToolApprovalHandler,
	SandboxConfirmationDecision, ISandboxViolationInfo,
} from '../common/providers.js';
import type { IConfirmationData } from '../../../browser/agentChat/agentChatTypes.js';
import { SlotRegistry } from './slotRegistry.js';
import { type TimeoutPolicy } from '../common/resilience.js';
import {
	createInitialRunState, reduceRunState, snapshotRunState, prepareResumeRunState,
	type AgentRunMessage, type AgentRunState, type AgentRunStateSnapshot,
} from '../common/agentRunState.js';
import {
	AgentGraph,
	AgentCommand,
	END_NODE,
	computeNextNode,
} from '../common/agentGraph.js';
import { planModeHardPermission, isToolHardDenied, type IHardPermissionPolicy } from '../common/toolPermission.js';
import type { IAskRoutingContext } from '../common/askRouting.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import {
	isBridgeTool,
} from '../common/toolsetConfig.js';
import {
	assembleToolDefs, IAssemblyResult, DEFAULT_TOOL_SEARCH_CONFIG,
	IToolSearchConfig,
} from '../common/toolSearchAssembler.js';
import {
	dispatchBridgeTool, buildDispatcherContext, IDispatcherContext,
} from '../common/toolSearchDispatcher.js';
import {
	detectFocusModeWithProbe, IFocusModeResult, IFileProbe,
} from '../common/focusMode.js';

import { DashboardFileStorage } from './dashboardFileStorage.js';
import {
	repairToolName,
	repairToolArguments,
	coerceOrReject,
	sanitizeToolError,
	deduplicateToolCalls,
	safeStringifyToolResult,
	formatToolErrorResult,
	formatToolNotFoundResult,
	classifyArgumentValidity,
	buildValidToolNameSet,
	buildToolSchemaMap,
	PHANTOM_TOOL_NAMES,
} from './toolCallUtils.js';
import {
	executeWithRetryAndTimeout,
	getTimeoutForTool,
	ToolApprovalService,
	ToolExecutionTracker,
} from './toolExecutionGuard.js';
import {
	DelegationLedgerManager,
} from '../common/delegationLedger.js';
import {
	DurableContextManager,
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

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IForkContext } from '../common/forkContext.js';
import { ITaskOrchestrationService } from '../common/agentStudio.js';
import { extractToolCallsFromText } from './agentToolExtractor.js';
import {
	getAgentToolsConfig, getAgentEnabledToolsets, getAgentDisabledToolsets,
	shouldEnableUpdatePlan,
	type AgentConfigDeps,
} from './agentConfigReader.js';
import {
	estimateMessagesTokens, retrieveContextOnly, retrieveCompactionContext,
	storeTurnObservations, injectRetrievalSystemMessage,
	type ContextRetrievalDeps,
} from './agentContextRetrieval.js';
import {
	getActiveModelProvider, resolveContextWindow, formatUserFacingError, adaptModelDelta,
	type ModelAccessDeps,
} from './agentModelAccess.js';

import { SandboxGuard } from './agentSandboxGuard.js';
import { getEnabledTools, type ToolAssemblyDeps } from './agentToolAssembly.js';
import { executeAgentTurnDirect } from './agentTurnExecutor.js';
import { isMemoryInjectionEnabled } from './agentMemoryInjection.js';
import { UserMessageEnricher } from './messageEnrichment/userMessageEnricher.js';
import { createBuiltinTagProviders, WorkingMemoryTagProvider } from './messageEnrichment/builtinTagProviders.js';

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

	// ─── Plan 模式审批（plan_exit → 弹出卡片 → 等待用户）──────────
	// 存放进行中的 plan 审批：confirmationId → resolve 回调。
	private readonly _pendingPlanApprovals = new Map<string, (decision: 'approved' | 'rejected') => void>();
	private _pendingApprovalsDir: URI | undefined;
	// P1: durable approval — persist to disk so pending state is visible across window refreshes.

	// ─── Externally injected services（由 agentStudioService 在实例化后注入）──
	// 未注入时相关功能静默降级（?. optional chaining）。
	private _studioService?: { getAgentsSync(): any[] | undefined; getWorkspace(id: string): Promise<any>; updateWorkspace(id: string, props: any): Promise<void>; };
	private _mcpService?: { onDidChangeMcpServers: Event<void>; };
	private _configService?: { onDidChangeConfiguration: Event<any>; getValue(key: string): any; getConfigPath(): string | undefined; };

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
	/**
	 * User message XML tag enricher — wraps environment context into user messages.
	 * Populated by {@link _initUserMessageEnricher} on first use (lazy init).
	 * Tag providers that require external data (rules, git status, etc.) are mutable
	 * and should be populated by agentDriverService before each turn.
	 */
	_userMessageEnricher: UserMessageEnricher | undefined;
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
	public _lastAllEnabledToolNames: Set<string> = new Set();

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
	public _lastRealPromptTokensByAgent = new Map<string, number>();

	/** P1(cache-cold 门控): 上次 assistant 响应（usage 回传）时间戳，按 turnKey 记录。
	 *  对齐 MiMo prune.ts isCacheCold：距上次响应 < TTL 视为 KV 缓存仍热，
	 *  低/中压力下跳过剪枝以免改写前缀浪费已付费的 prompt cache。 */
	public _lastAssistantAtByAgent = new Map<string, number>();

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
	public readonly _lastResponseIdBySession = new Map<string, string>();
	// 30 秒
	// 5 分钟
	/** 压缩冷却期：上次压缩时间戳。跨用户消息持久化，避免频繁压缩。 */
	public _lastCompressionTime: number = 0;
	/** 检索式压缩：已外置到记忆的 middle 消息内容哈希集合（按 sessionId），
	 *  避免每次压缩重复写入同一批对话导致记忆无限膨胀。 */
	private _storedMiddleHashes = new Map<string, Set<string>>();

	private readonly _configReaderDeps: AgentConfigDeps;
	private readonly _contextDeps: ContextRetrievalDeps;

	private get _modelAccessDeps(): ModelAccessDeps {
		return {
			logService: this._logService,
			modelProviders: this._modelProviders,
			activeSelection: this._activeSelection,
			modelStreamTimeoutPolicy: this._modelStreamTimeoutPolicy,
		};
}
private readonly _sandboxGuard: SandboxGuard;

	static readonly COMPRESSION_COOLDOWN_MS = 60_000;

	// ─── Tool-Use Enforcement（对齐 Hermes TOOL_USE_ENFORCEMENT_GUIDANCE）──────────
	// 对 DeepSeek / GPT / Gemini 等需要显式引导的模型族，自动在 system prompt 末尾
	// 注入工具使用强制指令。模型名包含列表中子串即触发。ID 匹配幂等（检测 TOOL_USE_ENFORCEMENT 标记）。
	static readonly TOOL_USE_ENFORCEMENT_MODELS = ['deepseek', 'gpt-', 'gemini', 'gemma', 'grok', 'glm', 'qwen'];
	static readonly MAX_TOOL_ITERATIONS = 50;
	static readonly MAX_CONSECUTIVE_TOOL_FAILURES = 3;
	// 文本搜索连击阈值（2026-07-28）：连续 N 次 search_files（grep 类）成功且
	// 未触及结构搜索工具（search_graph 等）时，注入一次「结构搜索优先」引导。
	// 工具分组数据见 common/searchToolGroups.ts。
	static readonly MAX_TEXT_SEARCH_STREAK = 4;
	// 反思阶段（Plan-Execute-Reflect）总开关：设为 0 即彻底关闭（reflectCount < 0 永假，触发条件
	// `runState.hasModifiedFiles && runState.reflectCount < MAX_REFLECT_ITERATIONS` 永不成立）。
	// 2026-07-27 用户拍板关闭：反思阶段即使措辞已改为"仅需简短确认、禁止重述"，仍存在模型把上一轮
	// 已完整给出的结论重新生成一遍的风险（日志 1785144785309 实测复现），代价大于自查收益，故整体停用。
	// 逻辑保留、未删除代码块——以后若需恢复自查能力，只需把此值改回 1（或更大）。
	static readonly MAX_REFLECT_ITERATIONS = 0;
	static readonly FILE_MODIFICATION_TOOLS = new Set(['file_write', 'write_to_file', 'replace_in_file', 'edit_file', 'delete_file', 'write_to_file']);
	static readonly TOOL_USE_ENFORCEMENT_GUIDANCE = [
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
	public _mcpToolsInitialWaitDone = false;

	// ─── Dashboard 统计追踪 ──────────────────────────────────────────
	// 在 executeAgentTurn 流程中实时累积，供 IAgentStudioDashboardService 读取。
	private _totalInputTokens = 0;
	/** P7: 注入幂等去重 — 同一 session 只注入一次 agentmemory-context（会话级，
	 *  2026-07-25 修正：不再每轮末清理；LRU 上限防长进程无限增长） */
	private _injectedSessions = new Set<string>();
	/** P8: 文件路径暂存 — 工具执行时收集涉及的文件路径，下一轮 volatile 层注入 */
	private _stashedFiles = new Map<string, Set<string>>();
	private static readonly MAX_STASHED_FILES = 20;
	/** P7 幂等标记 LRU 上限（超过时淘汰最老条目） */
	private static readonly MAX_INJECTED_SESSIONS = 500;
	/** P8 暂存 agent 数 LRU 上限 */
	private static readonly MAX_STASH_SESSIONS = 200;
	private _totalOutputTokens = 0;
	private _totalCachedTokens = 0;
	private _compressionCount = 0;
	private _compressionIneffectiveCount = 0;
	private _compressionBeforeTokens = 0;
	private _compressionAfterTokens = 0;
	private readonly _toolCallCounts = new Map<string, number>();

	/** Dashboard 文件存储实例（IFileService+JSON，替代 SQLite 原生模块） */
	private _dashboardStorage: DashboardFileStorage | undefined;
	/** dispose 后置位：_initDashboardStorage 异步初始化竞态防护（已 dispose 不再注册新实例） */
	private _dashboardDisposed = false;

	/** 取（或惰性创建）某会话的稳定 conversationId。无 sessionId 时回退到随机串。 */ public _getOrCreateConversationId(sessionId: string | undefined): string {
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

	// P0/P1: SubAgent 执行过程流式旁路总线。planExploreTool 的 inlineTraceSink 推送
	// 节流后的卡片快照，nativeChatEditorPane 订阅并 upsert 到当前流式 assistant 消息。
	private readonly _onDidSubAgentTrace = this._register(new Emitter<ISubAgentTraceSnapshot>());
	readonly onDidSubAgentTrace = this._onDidSubAgentTrace.event;
	fireSubAgentTrace(snapshot: ISubAgentTraceSnapshot): void {
		const saData = snapshot?.subagentData as any[] | undefined;
		const cnt = saData?.length ?? 0;
		const pids = saData?.map(s => s?.parentToolCallId).filter(Boolean) ?? [];
		this._logService.info(`[fireSubAgentTrace] count=${cnt} parentToolCallIds=[${pids.join(',') || '(none)'}] groupId=${snapshot?.groupId ?? '(none)'}`);
		this._onDidSubAgentTrace.fire(snapshot);
	}

	constructor(
		@ILogService logService: ILogService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IPathService readonly _pathService: IPathService,
		@IFileService private readonly _fileService: IFileService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._logService = logService;
		this._configReaderDeps = {
			getAgentsSync: () => this._studioService?.getAgentsSync?.(),
		};
		this._contextDeps = {
			getStoredHashes: (sessionId) => {
				let s = this._storedMiddleHashes.get(sessionId);
				if (!s) { s = new Set(); this._storedMiddleHashes.set(sessionId, s); }
				return s;
			},
		};
		this._slotRegistry = this._register(new SlotRegistry(logService));

		// 获取当前工作区 ID 用于记忆元数据
		const ws = this._workspaceContextService.getWorkspace();
		this._currentWorkspaceId = ws.folders.length > 0 ? ws.folders[0].name : '';

		// 注册沙箱确认命令：原生 chat 卡片按钮点击 → 派发此命令 → resolve pending promise，
		// 解除 agent loop 的暂停（对齐 void 的 confirmed.promise 模式）。
		this._sandboxGuard = new SandboxGuard({
			logService: this._logService,
			approvalService: this._approvalService,
			pendingSandboxConfirmations: this._pendingSandboxConfirmations,
			executeToolCalls: (tcs, aid, wp, sig) => this._executeToolCalls(tcs, aid, wp, sig),
			getBuiltinProvider: () => this._slotRegistry.getToolProviders().find(p => p.id === 'saros.builtin-tools') as any,
			persistSandboxRoot: async (wsId, dir) => {
				const ss = this._studioService;
				if (!ss || !wsId) { return; }
				const ws = await ss.getWorkspace(wsId);
				const existing = Array.isArray(ws?.sandboxRoots) ? ws.sandboxRoots : [];
				if (existing.includes(dir)) { return; }
				await ss.updateWorkspace(wsId, { sandboxRoots: [...existing, dir] });
			},
		});

		// P1: scan for orphaned approval files left from a previous session crash.
		this._restoreOrphanedApprovals().catch(err =>
			this._logService.warn('[AgentOS] Failed to restore orphaned approvals:', err),
		);

		// Init user message XML tag enricher (lazy — first enrich call triggers warmup)
		this._initUserMessageEnricher();

		this._register(CommandsRegistry.registerCommand(
			'agentStudio.confirmationAction',
			(_accessor, confirmationId: string, decision: string) => {
				// 先查沙箱确认
				const sandboxResolve = this._pendingSandboxConfirmations.get(confirmationId);
				if (sandboxResolve) {
					this._pendingSandboxConfirmations.delete(confirmationId);
					const mapped = this._mapConfirmationButtonToDecision(decision);
					this._logService.info(`[AgentOS] Sandbox confirmation ${confirmationId} → ${mapped}`);
					sandboxResolve(mapped);
					return;
				}
				// 再查 plan 审批（复用同一命令，前端无需新增按钮绑定）
				const planResolve = this._pendingPlanApprovals.get(confirmationId);
				if (planResolve) {
					this._pendingPlanApprovals.delete(confirmationId);
					const normalized = decision === 'approve' || decision === 'approved'
						? 'approved' : 'rejected';
					this._logService.info(`[AgentOS] Plan approval ${confirmationId} → ${normalized}`);
					planResolve(normalized);
					return;
				}
				this._logService.warn(`[AgentOS] No pending confirmation for id=${confirmationId} (checked sandbox + plan)`);
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
				this._dashboardDisposed = true;
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
		return this._sandboxGuard.setToolApprovalHandler(handler);
	}

	// ─── 沙箱确认（安全沙箱受限→暂停等待用户决策）──────────────

	private _mapConfirmationButtonToDecision(buttonId: string): SandboxConfirmationDecision {
		return this._sandboxGuard.mapConfirmationButtonToDecision(buttonId);
	}
 public _mapDecisionToCardStatus(decision: SandboxConfirmationDecision): 'approved' | 'rejected' | 'cancelled' {
		return this._sandboxGuard.mapDecisionToCardStatus(decision);
	}

	/** 工具结果是否因安全沙箱限制而失败 */ public _isSandboxViolation(result: { metadata?: { sandboxViolation?: ISandboxViolationInfo } }): boolean {
		return this._sandboxGuard.isSandboxViolation(result);
	}

	/**
	 * 生成沙箱确认卡片数据（标题 / 说明 / 允许目录 / 建议路径 / 四个按钮）。
	 */ public _buildSandboxConfirmationCard(toolName: string, v: ISandboxViolationInfo): IConfirmationData {
		return this._sandboxGuard.buildConfirmationCard(toolName, v);
	}

	/**
	 * 等待用户对沙箱受限工具调用的决策。
	 * 调用方（生成器）需先 yield 一个 `confirmation` delta 渲染卡片，
	 * 本方法仅负责挂起循环并在命令 resolve 时返回决策。
	 */ public _awaitSandboxConfirmation(confirmationId: string): Promise<SandboxConfirmationDecision> {
		return this._sandboxGuard.awaitConfirmation(confirmationId);
	}

	/**
	 * Plan 模式审批：等待用户对 exit_plan_mode 产出的方案做出 Approve/Reject 决策。
	 * 调用方（agentTurnExecutor）需先 yield 一个 `confirmation` delta，
	 * 本方法挂起循环并在 agentStudio.planApprovalAction 命令 resolve 时返回。
	 *
	 * @param timeoutMs 超时（默认 10 分钟），超时后自动拒绝
	 */ 	// ─── P1: Durable approval helpers ────────────────────────────────────

	private _getApprovalsDir(): URI {
		if (!this._pendingApprovalsDir) {
			const sarosRoot = resolveSarosPath(
				userDataRootFromRoamingHome(this._environmentService.userRoamingDataHome), SarosPath.pendingApprovals,
			);
			this._pendingApprovalsDir = sarosRoot;
		}
		return this._pendingApprovalsDir;
	}

	private async _persistApproval(confirmationId: string, data: Record<string, unknown>): Promise<void> {
		try {
			const dir = this._getApprovalsDir();
			const uri = URI.joinPath(dir, `${confirmationId}.json`);
			await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify({
				...data,
				createdAt: new Date().toISOString(),
			}, null, 2)));
		} catch (err) {
			this._logService.warn(`[AgentOS] Failed to persist approval ${confirmationId}:`, err);
		}
	}

	private async _removeApproval(confirmationId: string): Promise<void> {
		try {
			const uri = URI.joinPath(this._getApprovalsDir(), `${confirmationId}.json`);
			await this._fileService.del(uri);
		} catch { /* file may not exist */ }
	}

	/** Scan for orphaned approvals on service init (for logging/diagnostics). */
	private async _restoreOrphanedApprovals(): Promise<void> {
		try {
			const dir = this._getApprovalsDir();
			const stat = await this._fileService.resolve(dir);
			const files = (stat.children ?? []).filter(c => c.name.endsWith('.json'));
			if (files.length > 0) {
				this._logService.warn(`[AgentOS] Found ${files.length} orphaned approval file(s) from a previous session — they will be cleaned up on next resolution.`);
			}
		} catch { /* dir may not exist yet */ }
	}

	/**
	 * 初始化 User Message XML Tag Enricher。
	 * 创建所有内置 TagProvider。需要外部数据（rules/git/workingMemory 等）
	 * 的 provider 由 agentDriverService 在每个 turn 前填充。
	 */
	private _initUserMessageEnricher(): void {
		const providers = createBuiltinTagProviders();
		this._userMessageEnricher = new UserMessageEnricher(providers);
		this._workingMemoryTagProvider = providers.find(p => p instanceof WorkingMemoryTagProvider) as WorkingMemoryTagProvider | undefined;
		this._logService.info('[AgentOS] User message XML enricher initialized');
	}

	/** 只读工作记忆注入：working_memory_content 标签的数据源（存 provider 实例引用）。 */
	private _workingMemoryTagProvider: WorkingMemoryTagProvider | undefined;

	/**
	 * 2026-08-06 修正：working_memory_content 标签的数据源**从 agentmemory
	 * 记忆系统**读取（经 loadContext 策展），不再读取/依赖 `.codebuddy/memory/`
	 * 文件——该目录是错误路径，产品代码不读写它，模型也不得创建。
	 *
	 * 设计要点：
	 *   - P0 会话级 TTL 缓存：同 agent+session 30s 内复用 loadContext 结果，
	 *     避免每轮白付一次策展（对齐 agentMemoryInjection 的 _injectedSessions 幂等）。
	 *   - P0 与 MemoryInjection 互斥：AGENTMEMORY_INJECT_CONTEXT=true 时由
	 *     <agentmemory-context> 承担注入，working_memory_content 不重复注入。
	 *   - P1 includeEntries=false：保持「召回走工具」姿态——只注入策展块
	 *     （pinned slots / project profile / lessons / summaries），不直接
	 *     喂记忆条目数组（模型应调 memory_search 按需检索）。
	 *   - P2 agentId 为空时不注入，避免空 agentId 导致意外全局召回。
	 */
	private _workingMemoryCache: { key: string; content: string | null; at: number } | undefined;
	private static readonly WORKING_MEMORY_TTL_MS = 30_000;
	/** 新 session 跟踪：已注入过工作记忆的 agent::session 组合（LRU 500）。 */
	private _injectedWorkingMemorySessions = new Set<string>();
	private static readonly WORKING_MEMORY_SESSION_CACHE_MAX = 500;

	public async _refreshWorkingMemoryContent(agentId?: string, sessionId?: string): Promise<void> {
		if (!this._workingMemoryTagProvider) { return; }

		// P0：与 agentMemoryInjection 互斥——MemoryInjection 开启时 <agentmemory-context>
		// 已注入完整策展上下文，working_memory_content 不再重复注入。
		if (isMemoryInjectionEnabled()) {
			this._workingMemoryTagProvider.workingMemoryContent = null;
			return;
		}

		// P2：agentId 为空不注入（避免空 agentId 触发全局召回）
		const aid = agentId ?? '';
		if (!aid) {
			this._workingMemoryTagProvider.workingMemoryContent = null;
			return;
		}

		// P0：TTL 缓存——同 agent+session 30s 内复用，不重复调 loadContext
		const cacheKey = `${aid}::${sessionId ?? ''}`;
		const cached = this._workingMemoryCache;
		if (cached && cached.key === cacheKey && Date.now() - cached.at < AgentOSService.WORKING_MEMORY_TTL_MS) {
			this._workingMemoryTagProvider.workingMemoryContent = cached.content;
			return;
		}

		const memProvider = this.getActiveMemoryProvider();
		if (!memProvider?.loadContext) {
			this._workingMemoryTagProvider.workingMemoryContent = null;
			this._workingMemoryCache = { key: cacheKey, content: null, at: Date.now() };
			return;
		}
		try {
			const ctx: any = await Promise.race([
				// P1：includeEntries=false——只注入策展块，不喂条目数组（召回走工具）
				memProvider.loadContext(aid, sessionId ?? '', '', { includeEntries: false }),
				new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
			]);
			if (!ctx || typeof ctx.systemPrompt !== 'string' || !ctx.systemPrompt.trim()) {
				this._workingMemoryTagProvider.workingMemoryContent = null;
				this._workingMemoryCache = { key: cacheKey, content: null, at: Date.now() };
				return;
			}
			let joined = ctx.systemPrompt.trim();

			// 2026-08-07：新 session 元信息模式——首条消息不注入具体记忆内容，
			// 只注入「存在记忆 + 可用工具检索」的元信息标记，防止旧结论锚定新任务。
			// 后续轮次恢复正常完整注入。
			const isNewSession = !this._injectedWorkingMemorySessions.has(cacheKey);
			if (isNewSession) {
				// LRU 清理
				if (this._injectedWorkingMemorySessions.size >= AgentOSService.WORKING_MEMORY_SESSION_CACHE_MAX) {
					const first = this._injectedWorkingMemorySessions.values().next().value;
					if (first !== undefined) { this._injectedWorkingMemorySessions.delete(first); }
				}
				this._injectedWorkingMemorySessions.add(cacheKey);
				const blockCount = ctx?.contextBlocks ?? 0;
				const tokens = ctx?.contextTokens ?? Math.ceil(joined.length / 3);
				joined = [
					'<!-- NEW SESSION: Historical memory context exists but is intentionally NOT shown',
					'to avoid anchoring. The current task is NEW — do NOT assume previous conclusions apply.',
					'Use memory_search / memory_recall tools to retrieve relevant memories if needed. -->',
					'',
					`存在历史记忆上下文（约 ${blockCount} 个策展块，~${tokens} tokens）。为避免旧结论锚定新任务，`,
					'未直接展示内容。请使用 memory_search / memory_recall 工具按需检索相关记忆。',
				].join('\n');
				this._logService.info(`[AgentOS] New session — injected working-memory META-INFO only (agent=${aid}, ${blockCount} blocks, ~${tokens} tokens)`);
			} else {
				this._logService.info(`[AgentOS] Working memory injected from agentmemory (${joined.length} chars, agent=${aid}, cacheKey=${cacheKey})`);
			}

			const MAX_WORKING_MEMORY_CHARS = 6000;
			if (joined.length > MAX_WORKING_MEMORY_CHARS) {
				joined = joined.slice(0, MAX_WORKING_MEMORY_CHARS) + '\n…(truncated)';
			}
			this._workingMemoryTagProvider.workingMemoryContent = joined;
			this._workingMemoryCache = { key: cacheKey, content: joined, at: Date.now() };
		} catch (err) {
			this._workingMemoryTagProvider.workingMemoryContent = null;
			this._workingMemoryCache = { key: cacheKey, content: null, at: Date.now() };
			this._logService.warn(`[AgentOS] Failed to load working memory from agentmemory: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ─── Plan mode approval ────────────────────────────────────────────

	/**
	 * plan_exit 审批：等待用户 Approve/Reject。
	 * @param confirmationId 唯一确认 ID
	 * @param timeoutMs 超时（默认 10 分钟），超时后自动拒绝
	 */
	public async _awaitPlanApproval(confirmationId: string, timeoutMs: number = 600_000): Promise<'approved' | 'rejected'> {
		// P1: persist approval so it's traceable if the window process crashes.
		await this._persistApproval(confirmationId, { status: 'pending', timeoutMs });
		return new Promise<'approved' | 'rejected'>((resolve) => {
			const timer = setTimeout(() => {
				if (this._pendingPlanApprovals.has(confirmationId)) {
					this._pendingPlanApprovals.delete(confirmationId);
					this._removeApproval(confirmationId).catch(() => {});
					this._logService.warn(`[AgentOS] Plan approval ${confirmationId} timed out after ${timeoutMs}ms — auto-rejecting`);
					resolve('rejected');
				}
			}, timeoutMs);

			this._pendingPlanApprovals.set(confirmationId, (decision) => {
				clearTimeout(timer);
				this._pendingPlanApprovals.delete(confirmationId);
				this._removeApproval(confirmationId).catch(() => {});
				resolve(decision);
			});
		});
	}

	/** Cancel all pending plan approvals for cleanup (e.g., on agent switch). */
	public _cancelAllPlanApprovals(): void {
		for (const [id, resolve] of this._pendingPlanApprovals) {
			this._pendingPlanApprovals.delete(id);
			this._removeApproval(id).catch(() => {});
			this._logService.info(`[AgentOS] Plan approval ${id} cancelled`);
			resolve('rejected');
		}
	}

	/**
	 * plan_exit 后的统一编排流程：创建 OrchestrationPlan，并按 DAG ready queue 派发 task。
	 * Plan ChatMode 在用户批准后调用；Craft ChatMode 自动批准后调用。
	 */
	public async *_orchestratePlan(
		request: IAgentTurnRequest,
		args: { plan_summary?: string; next_mode?: string; idempotencyKey?: string },
		tasks: Array<{ title: string; description: string; files?: string[]; complexity?: string; suggestedRole?: string; dependencies?: string[]; deliverable?: string }>,
		_toolCallId: string,
	): AsyncGenerator<IChatStreamDelta> {
		const planSummary = args.plan_summary || '';
		const nextMode = args.next_mode || 'craft';
		const taskCount = tasks.length;
		const idempotencyKey = args.idempotencyKey;

		this._logService.info(`[AgentOS] _orchestratePlan: ${taskCount} task(s), next_mode=${nextMode}, idempotencyKey=${idempotencyKey ?? '(none)'}`);

		// P1: check idempotency — if a plan was already created for this key, return it.
		if (idempotencyKey) {
			const seenKey = `_plan_idem_${idempotencyKey}`;
			const existingId = (this as any)[seenKey] as string | undefined;
			if (existingId) {
				this._logService.info(`[AgentOS] _orchestratePlan: idempotent replay detected — plan ${existingId} already exists`);
				yield { type: 'text' as any, content: `Plan ${existingId} already created (idempotent replay).\n` };
				return;
			}
		}

		// 通过 DI 懒加载 TaskOrchestrationService 创建 plan
		let planCreated = false;
		let planExecuting = false;
		try {
			let orchService: ITaskOrchestrationService | undefined;
			try {
				orchService = this._instantiationService.invokeFunction(accessor =>
					accessor.get(ITaskOrchestrationService)
				);
			} catch { orchService = undefined; }
			if (orchService && typeof orchService.createPlanFromTasks === 'function') {
				const workspaceId = (request as any).workspaceId || '';
				const plan = await orchService.createPlanFromTasks(
					planSummary,
					workspaceId,
					request.agentId,
					tasks.map(t => ({
						title: t.title,
						description: t.description,
						files: t.files || [],
						complexity: t.complexity || 'medium',
						suggestedRole: t.suggestedRole,
						dependencies: t.dependencies || [],
					})),
					request.sessionId,
				);
				this._logService.info(`[AgentOS] OrchestrationPlan created: id=${plan.id}, tasks=${tasks.length}, session=${request.sessionId || '(none)'}`);
				// P1: persist idempotency key so replay is detected across restarts.
				if (idempotencyKey) {
					(this as any)[`_plan_idem_${idempotencyKey}`] = plan.id;
				}
				// Emit a dedicated plan_tasks card so the chat shows the generated task list.
				yield {
					type: 'plan_tasks' as any,
					planTasksData: {
						planId: plan.id,
						summary: planSummary,
						tasks: tasks.map(t => ({
							title: t.title,
							description: t.description,
							files: t.files,
							dependencies: t.dependencies,
							deliverable: (t as any).deliverable,
							complexity: t.complexity || 'medium',
							status: 'pending',
						})),
					},
				};
				yield { type: 'text' as any, content: `Plan created with ${tasks.length} task(s). ID: ${plan.id}\n` };
				planCreated = true;

				// plan_exit 的策略门已完成（Plan=用户批准，Craft=自动批准），
				// 因此直接批准并派发，避免计划面板产生第二次审批断点。
				if (typeof orchService.approvePlan === 'function') {
					try {
						const executed = await orchService.approvePlan(plan.id);
						planExecuting = true;
						this._logService.info(`[AgentOS] OrchestrationPlan auto-approved & executing: id=${plan.id}, tasks=${executed.tasks.length}`);
						yield { type: 'text' as any, content: `\n✅ 方案已批准，正在拆分 ${executed.tasks.length} 个任务并派发 subagent 执行...\n` };
					} catch (execErr) {
						this._logService.warn(`[AgentOS] Auto-execute after plan creation failed: ${execErr instanceof Error ? execErr.message : String(execErr)}`);
						yield { type: 'text' as any, content: `\n⚠️ 方案已创建但执行启动失败。计划状态已由编排服务记录，可在计划面板查看详情。\n` };
					}
				}
			}
		} catch (err) {
			this._logService.warn(`[AgentOS] Failed to create OrchestrationPlan (may not be configured): ${err instanceof Error ? err.message : String(err)}`);
		}

		// 无论如何，输出方案摘要
		yield {
			type: 'text' as any,
			content: [
				'',
				'## Plan Summary',
				'',
				planSummary,
				'',
				`### Tasks (${taskCount})`,
				...tasks.map((t, i) => `  ${i + 1}. **${t.title}** — ${t.description || '(no description)'}${t.suggestedRole ? ` [role: ${t.suggestedRole}]` : ''}`),
				'',
			planExecuting
				? `✅ 方案已批准，${taskCount} 个任务正由 subagent 并行执行中。`
				: planCreated
					? `✅ ${taskCount} task(s) assigned. Switch to **${nextMode.toUpperCase()}** mode to begin execution.`
					: `Plan ready but orchestration service unavailable. ${taskCount} task(s) listed above — switch to **${nextMode.toUpperCase()}** mode to execute manually.`,
				'',
			].join('\n'),
		};
	}

	/**
	 * 按用户决策重执行被沙箱拦截的工具调用。
	 * - allow_once: 临时放行精确路径后重执行（finally 移除放行）
	 * - allow_workspace: 持久化目录到 Workspace.sandboxRoots 后重执行
	 * - use_suggested: 把路径参数改写为建议路径后重执行
	 * - cancel: 直接返回失败（操作已取消）
	 */ public async _reExecuteAfterSandbox(
		tc: IToolCallInfo,
		agentId: string,
		worktreePath: string | undefined,
		signal: AbortSignal | undefined,
		decision: SandboxConfirmationDecision,
		v: ISandboxViolationInfo,
	): Promise<{ toolCallId: string; content: any; success: boolean }> {
		return this._sandboxGuard.reExecuteAfterSandbox(tc, agentId, worktreePath, signal, decision, v, this._currentWorkspaceId);
	}

	/**
	 * 清空 builtin provider 的临时沙箱放行根集合（AllowOnce 的 _sandboxBypassRoots）。
	 *
	 * ⓵ 仅清内存中的临时放行集合，绝不触碰 persistSandboxRoot 持久放行的根；
	 *    持久根由 StudioService 另行管理，跨调用保留，不在本方法作用范围内。
	 * ⓶ 调用方（agentTurnExecutor 的 fresh-dispatch 入口）应在「每个工具批次派发前」
	 *    调用，以清理上一批次遗留的 AllowOnce 放行根——防止一次用户确认被隐性携带到
	 *    后续无关工具调用。
	 * ⓷ 严禁在 reExecuteAfterSandbox 的共享派发路径内调用：re-exec 在 executeToolCalls
	 *    前 add、finally 内 remove，本方法若在共享路径执行会擦除进行中的 AllowOnce 放行，
	 *    导致重执行再次被沙箱拦截，破坏「允许一次」重执行卡片流程。
	 */
	_clearSandboxBypassRoots(): void {
		const provider = this._slotRegistry.getToolProviders().find((p) => p.id === 'saros.builtin-tools') as any;
		if (provider && typeof provider.clearSandboxBypassRoots === 'function') {
			provider.clearSandboxBypassRoots();
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
			const sarosRoot = userDataRootFromRoamingHome(this._environmentService.userRoamingDataHome);
			const dirUri = resolveSarosPath(sarosRoot, SarosPath.dashboard);

			// 竞态防护：先初始化再注册——若期间服务已 dispose，直接丢弃实例，
			// 避免 initialize 内部 _register 撞上已 dispose 的 store（泄漏告警噪音）
			const storage = new DashboardFileStorage(this._fileService, this._logService);
			this._dashboardStorage = storage;
			try {
				await storage.initialize(dirUri);
			} catch (err) {
				storage.dispose();
				this._dashboardStorage = undefined;
				throw err;
			}
			if (this._dashboardDisposed) {
				storage.dispose();
				this._dashboardStorage = undefined;
				return;
			}
			this._register(storage);

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
	 * 对齐 agentmemory PostToolUse Hook → mem::observe 机制：
	 * 写入 mem:obs:<agent>:<session> 会话暂存层（便宜 KV set + 滑动窗口），
	 * 不再直落 mem:memories 长期层（2026-07-25 存储频率优化 P0）。
	 * 结构化压缩：提取工具名/文件路径/有界输出预览（替代裸 200 字符截断）。
	 */ public _observeToolResult(agentId: string, toolResult: { toolCallId: string; content: any; success: boolean; toolName?: string }, sessionId?: string): void {
		const memProvider = this.getActiveMemoryProvider();
		if (!memProvider) return;
		const text = typeof toolResult.content === 'string'
			? toolResult.content
			: (() => { try { return JSON.stringify(toolResult.content); } catch { return String(toolResult.content); } })();
		// 结构化提取：文件路径（正斜杠/反斜杠路径，限前 10 个）
		const fileMatches = text.match(/[A-Za-z]:[\\/][\w\-./\\]+|(?:^|[\s"'`(])([\w\-]+\/)+[\w\-]+\.\w{1,10}/g);
		const files = fileMatches ? [...new Set(fileMatches.map(f => f.trim()))].slice(0, 10) : undefined;
		void memProvider.observe?.(agentId, {
			sessionId: sessionId ?? '',
			hookType: toolResult.success ? 'post_tool_use' : 'post_tool_failure',
			timestamp: new Date().toISOString(),
			data: {
				tool_name: toolResult.toolName ?? toolResult.toolCallId,
				tool_output: text.slice(0, 2000),
				...(files?.length ? { files } : {}),
				success: toolResult.success,
			},
		})?.catch(() => { });
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
	 * 在 volatile 层注入逻辑中调用（agentTurnExecutor）。
	 */ public _consumeStashedFiles(sessionKey: string): string[] {
		const stash = this._stashedFiles.get(sessionKey);
		if (!stash || stash.size === 0) return [];
		const files = [...stash];
		stash.clear();
		return files;
	}

	/** Set/Map 容量上限控制：超限时按插入顺序淘汰最老条目（FIFO 近似 LRU）。 */
	private _capMapSize(collection: Set<string> | Map<string, unknown>, max: number): void {
		while (collection.size > max) {
			const oldest = collection.keys().next().value;
			if (oldest === undefined) { break; }
			collection.delete(oldest as string);
		}
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
	 *  - firstTokenTimeout（45s 基准）：流「首 token 之前」的慢启动宽限。实测 CodeBuddy
	 *    网关冷启动首 delta 延迟可达 51s 且返回空响应（仅 usage + done）；
	 *    45s 超时可在冷启动场景提前 abort → 触发 fallback 或 retry，避免浪费 51s
	 *    等待一个空响应。MAX_VISIBLE_TOOLS=30 已收敛 payload，正常请求首 token
	 *    远低于 45s。
	 *    注：此值为基准值。agentTurnExecutor 在每次调用前按估算 prompt token 数
	 *    阶梯放宽（computeAdaptiveFirstTokenTimeout：>16k 每 8k +15s，封顶 115s），
	 *    避免大 prompt 冷缓存 prefill（实测 34k tokens TTFB 46.4s）被 45s 基准误杀。
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

		// ─── P0: 主 agent 自身冻结前缀命中 prompt cache（对齐 MiMo 父级冻结自身前缀）──
		// agentTurnExecutor.ts:655 每轮把本会话「冻结前缀」(system+tools fingerprint) 存入
		// _lastForkContextBySession；但主 agent 的 request 默认不带 forkContext，导致
		// prefixCacheAligned(undefined,...) 恒为 false → 稳定的大前缀每轮重新计费。
		// 此处用上一轮同会话的冻结前缀回填（绝不覆盖子 agent 从父级继承的 forkContext），
		// 使请求构造端（messageFormatConverter + BYOK provider）在 system+tools 前缀边界
		// 打 cache_control 断点，命中 provider prompt cache。
		if (!request.forkContext && request.sessionId) {
			const cachedFork = this._lastForkContextBySession.get(request.sessionId);
			if (cachedFork) {
				request = { ...request, forkContext: cachedFork };
				this._logService.info(
					`[AgentOS] Fork prefix-cache: reused prev-turn fork for session=${request.sessionId} (fp=${cachedFork.toolsFingerprint})`,
				);
			}
		}

		// ─── Per-turn 状态重置：告知所有 Tool Provider 清空累积状态 ───
		// 如 coreTools 的 _readDedupMap / _readRepeatMap，防止跨 turn 误报 BLOCKED。
		for (const provider of this._slotRegistry.getToolProviders()) {
			provider.resetPerTurn?.();
		}

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
		if (request.modelOverride?.modelId) {
			if (request.modelOverride.providerId) {
				// 完整覆盖：provider + model 都指定（workflow 节点级 / 面板本地双选）
				this._activeSelection = request.modelOverride;
			} else if (this._activeSelection) {
				// 只指定 model（聊天输入框常只选模型、providerId 为空）：
				// 保留当前 provider，仅覆盖 modelId —— 修复 UI 选 deepseek-v4-pro
				// 但实际用全局 defaultModel hy3-ioa 的脱节问题。
				this._activeSelection = { ...this._activeSelection, modelId: request.modelOverride.modelId };
			}
			this._logService.info(
				`[AgentOS] Model override active: ${request.modelOverride.providerId || (this._activeSelection?.providerId ?? '(keep)')}/${request.modelOverride.modelId} ` +
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
		} 	finally {
			// Per-turn 取消隔离清理：移除本次 turn 的 controller。
			// 若 this._loopAbortController 恰为本 turn（无并发覆盖）则一并清空。
			this._activeTurnControllers.delete(turnKey);
			if (this._loopAbortController === turnController) {
				this._loopAbortController = undefined;
			}

			// v39: restore the original selection after the turn completes.
			if (request.modelOverride?.modelId) {
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
				}).catch(() => { });
				memProvider.triggerHook('session_end', {
					agentId: request.agentId, sessionId: request.sessionId || '', timestamp: Date.now(),
				}).catch(() => { });
			}

		if (memProvider?.onTaskCompleted) {
			try {
				const userMsg = [...(request.messages as Array<{ role?: string; content?: string }>)]
					.reverse().find(m => m?.role === 'user')?.content?.slice(0, 200) ?? 'Agent turn completed';
				memProvider.onTaskCompleted(request.agentId, request.sessionId || '', userMsg);
			} catch { /* best effort */ }
		}
	}
	// P7/P8（2026-07-25 修正，doc §12 F2/F3）：注入幂等标记与文件暂存
	// 不再每轮末清理——此前每轮 delete 导致「每 session 注入一次」名存实亡
	// （实际每轮全量注入），且 stash 在消费前即被清空（Recently Touched
	// Files 死代码）。两者现按会话生命周期保留，LRU 上限防无限增长。
	this._capMapSize(this._injectedSessions, AgentOSService.MAX_INJECTED_SESSIONS);
	this._capMapSize(this._stashedFiles, AgentOSService.MAX_STASH_SESSIONS);
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
		// P1: clear terminal checkpoint so resume doesn't re-enter the graph.
		if (request.checkpointSink) {
			this._logService.info(`[AgentOS] runAgentGraph: clearing terminal checkpoint for session ${request.sessionId ?? '(unknown)'}`);
			await this._emitTerminalCheckpoint(request);
		}
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
	 * P1: clear terminal checkpoint when graph completes.
	 * Prevents the next turn from resuming at entry after the graph already finished.
	 */
	private async _emitTerminalCheckpoint(request: IAgentTurnRequest): Promise<void> {
		if (!request.checkpointSink) { return; }
		try {
			// Write null/empty checkpoint to signal "no active run".
			const terminalSnapshot: AgentRunStateSnapshot = snapshotRunState(
				createInitialRunState({ reducerMode: 'reducer' })
			);
			await request.checkpointSink(terminalSnapshot as any);
			this._logService.info('[AgentOS] runAgentGraph: terminal checkpoint written');
		} catch (err) {
			this._logService.warn('[AgentOS] Failed to write terminal checkpoint', err);
		}
	}

	/**
	 * 获取指定 agent 的已启用工具列表
	 *
	 * 三层分离架构（参考 Hermes-Agent）：
	 *   1. Assembly 层 (toolSearchAssembler.ts): classify + threshold gate + bridge schema
	 *   2. Dispatch 层 (toolSearchDispatcher.ts): catalog + BM25 + scope 门控
	 *   3. Executor 层 (本文件): unwrap tool_call 为真实工具名，走完整 guardrail/approval 链
	 */
	private get _toolAssemblyDeps(): ToolAssemblyDeps {
		return {
			logService: this._logService,
			resolveContextWindow: (p, m) => this._resolveContextWindow(p, m),
			listAllToolsWithState: (aid) => this.listAllToolsWithState(aid),
			getAgentToolsConfig: (aid) => this._getAgentToolsConfig(aid),
			getAgentEnabledToolsets: (aid) => this._getAgentEnabledToolsets(aid),
			getAgentDisabledToolsets: (aid) => this._getAgentDisabledToolsets(aid),
			shouldEnableUpdatePlan: (aid) => this._shouldEnableUpdatePlan(aid),
			detectFocusModeIfNeeded: () => this._detectFocusModeIfNeeded(),
			getToolSearchConfig: () => this._getToolSearchConfig(),
			getConfigFingerprint: () => this._getConfigFingerprint(),
			registryGeneration: this._registryGeneration,
			currentModelProvider: this._currentModelProvider,
			currentModelId: this._currentModelId,
			cachedToolDefs: this._cachedToolDefs,
			toolDefsCacheMax: AgentOSService.TOOL_DEFS_CACHE_MAX,
			setLastAllEnabledToolNames: (s) => { this._lastAllEnabledToolNames = s; },
			setLastAssembly: (a) => { this._lastAssembly = a; },
			setLastDispatcherCtx: (c) => { this._lastDispatcherCtx = c; },
		};
	}

	/**
	 * Turn executor — delegates to agentTurnExecutor.ts (core Agent Loop)。
	 */
	private async *_executeWithFallbackDirectly(request: IAgentTurnRequest): AsyncGenerator<IChatStreamDelta, AgentCommand | undefined> {
		yield* executeAgentTurnDirect(this, request);
		return undefined;
	}

	private async _getEnabledTools(agentId: string, agentGraph?: AgentGraph, toolsetsOverride?: string[], hardPermission?: IHardPermissionPolicy, excludedTools?: readonly string[], allowedTools?: readonly string[]): Promise<IToolDefinition[]> {
		return getEnabledTools(this._toolAssemblyDeps, agentId, agentGraph, toolsetsOverride, hardPermission, excludedTools, allowedTools);
	}

	/**
	 * 供 Prompt 组装层（agentDriverService）生成 "Built-in tools:" 文字清单使用。
	 *
	 * 修复：此前 agentDriverService 直接调用 listAllToolsWithState() 拿全量 enabled 工具
	 * 来生成提示词文字，完全绕过了 focus 模式 + toolset 白名单过滤——导致提示词里点名的
	 * 工具（如 kanban_ 系列 / kb_ 系列 / echo / get_time 等）实际根本没有随请求下发
	 * function-calling schema，模型据此调用必然失败或产生幻觉。
	 *
	 * 现在改为直接复用 _getEnabledTools 的同一套过滤结果（focus + toolset + hardPermission），
	 * 保证「提示词文字声称可用的工具」与「真正随请求下发 schema 的工具」严格一致。
	 * 返回的是非 MCP 工具名（MCP 工具走 tool_search 按需发现，不在此清单列出）。
	 */
	public async getEnabledToolNamesForPrompt(
		agentId: string,
		agentGraph?: AgentGraph,
		toolsetsOverride?: string[],
		hardPermission?: IHardPermissionPolicy,
		excludedTools?: readonly string[],
		allowedTools?: readonly string[],
	): Promise<string[]> {
		const tools = await this._getEnabledTools(agentId, agentGraph, toolsetsOverride, hardPermission, excludedTools, allowedTools);
		return tools
			.filter(t => !t.category?.startsWith('mcp:') && !isBridgeTool(t.name))
			.map(t => t.name);
	}

	/**
	 * Resolve the hard-permission policy for a turn. hardPermission is an INVARIANT
	 * layer applied AFTER all toolset/allowlist filtering in `_getEnabledTools` — tools
	 * it denies can never be re-enabled by config or approval (MiMo hardPermission).
	 * Currently: plan mode locks every write/execute tool.
	 * 
	 * Note: This policy is now used BOTH at schema level (applyHardPermission strips
	 * denied tools from the LLM-visible list) AND at runtime (isToolCallDeniedByHardPermission
	 * blocks denied tool calls in agentTurnExecutor). The runtime check is the primary
	 * enforcement; schema-level stripping is a secondary optimization.
	 */ public _resolveHardPermission(request: IAgentTurnRequest): IHardPermissionPolicy | undefined {
		const workMode = request.workMode ?? (request.chatMode === 'plan' ? 'plan' : 'work');
		return this._resolveHardPermissionForWorkMode(workMode);
	}

	/** WorkMode is the sole runtime permission source; ChatMode remains a stable UI policy. */
	public _resolveHardPermissionForWorkMode(workMode: string): IHardPermissionPolicy | undefined {
		return workMode === 'plan' ? planModeHardPermission() : undefined;
	}

	/** @deprecated Use _resolveHardPermissionForWorkMode. */
	public _resolveHardPermissionForMode(mode: string): IHardPermissionPolicy | undefined {
		return this._resolveHardPermissionForWorkMode(mode === 'plan' ? 'plan' : 'work');
	}

	/**
	 * Get the saros root path (used for plan file generation).
	 * Returns the absolute path to ~/.vssaros/saros/.
	 */
	public _getSarosRoot(): string {
		return resolveSarosPath(
			userDataRootFromRoamingHome(this._environmentService.userRoamingDataHome),
		).fsPath;
	}

	/**
	 * P0: Plan file I/O via IFileService (renderer-safe).
	 * The executor previously used Node.js `fs/promises`, which cannot be resolved
	 * in the browser/renderer process — silently failing all plan file operations.
	 */
	public async _writePlanFile(filePath: string, content: string): Promise<void> {
		const uri = URI.file(filePath);
		// mkdir parent recursively then write
		await this._fileService.createFolder(URI.file(filePath.replace(/[\\/][^\\/]*$/, '')));
		await this._fileService.writeFile(uri, VSBuffer.fromString(content));
	}

	public async _readPlanFile(filePath: string): Promise<string> {
		try {
			const content = await this._fileService.readFile(URI.file(filePath));
			return content.value.toString();
		} catch {
			return '';
		}
	}

	public async _planFileExists(filePath: string): Promise<boolean> {
		try {
			const stat = await this._fileService.stat(URI.file(filePath));
			return stat.size > 0;
		} catch {
			return false;
		}
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
		return getAgentToolsConfig(this._configReaderDeps, agentId);
	}

	/**
	 * 获取 Agent 的 enabledToolsets 配置。
	 * 对齐 Hermes 的 `agent.enabled_toolsets`：只发送属于这些 toolset 的工具。
	 *
	 * 未设置或空 → 全部 toolset（向后兼容）。
	 */
	private _getAgentEnabledToolsets(agentId?: string): string[] | undefined {
		return getAgentEnabledToolsets(this._configReaderDeps, agentId);
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
		return getAgentDisabledToolsets(this._configReaderDeps, agentId);
	}

	/**
	 * update_plan 门控。
	 *
	 * 默认启用 update_plan，Agent 可通过 enableUpdatePlan: false 显式关闭。
	 */
	private _shouldEnableUpdatePlan(agentId?: string): boolean {
		return shouldEnableUpdatePlan(this._configReaderDeps, agentId);
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
		worktreePath?: string,
		askRouting?: IAskRoutingContext,
		agentSessionId?: string,
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

		// Defense-in-depth after bridge unwrap. Apply the plan lock only while the
		// AgentLoop is actually in plan WorkMode; Craft/work calls must not be blocked.
		const bridgeHardPerm = this._resolveHardPermissionForWorkMode(askRouting?.workMode ?? 'work');
		if (bridgeHardPerm && isToolHardDenied(underlyingName, bridgeHardPerm)) {
			this._logService.warn(`[AgentOS] Bridge tool_call: "${underlyingName}" blocked by workMode=plan hard permission`);
			return {
				toolCallId, success: false,
				content: [{ type: 'text', text: `Tool "${underlyingName}" is blocked while workMode=plan. Complete the plan and call plan_exit first.` }],
			};
		}

		// Approval（真实工具的安全级别）
		if (!await this._approvalService.checkAndApprove(
			{ id: toolCallId, name: underlyingName, arguments: underlyingArgs, worktreePath }, targetTool, askRouting,
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
					{ id: toolCallId, name: underlyingName, arguments: underlyingArgs, worktreePath, sessionId: agentSessionId },
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
						{ id: toolCallId, name: underlyingName, arguments: underlyingArgs, worktreePath, sessionId: agentSessionId },
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
	 */ public async _waitForMcpTools(
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
	private async _executeToolCalls(toolCalls: IToolCallInfo[], agentId: string, worktreePath?: string, abortSignal?: AbortSignal, askRouting?: IAskRoutingContext, agentSessionId?: string): Promise<Array<{ toolCallId: string; content: any; success: boolean }>> {
		const results: Array<{ toolCallId: string; content: any; success: boolean }> = [];

		// ─── Dashboard 统计：工具调用计数 ──
		// P8: 同时收集文件路径用于下一轮 enrich
		for (const tc of toolCalls) {
			if (tc.name) {
				this._toolCallCounts.set(tc.name, (this._toolCallCounts.get(tc.name) ?? 0) + 1);
				this._scheduleSave();
				// 实时写入文件存储（fire-and-forget）
				if (this._dashboardStorage?.ready) {
					this._dashboardStorage.incrementToolCall(tc.name).catch(() => { });
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
					toolCall.name, bridgeArgs, agentId, toolCall.id, abortSignal, worktreePath, askRouting, agentSessionId,
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
			const coerceResult = coerceOrReject(args, toolSchema, targetToolName, this._logService);
			args = coerceResult.args;
			if (coerceResult.reject) {
				results.push({ toolCallId: toolCall.id, ...coerceResult.reject });
				continue;
			}

			// ─── Step 3.5: Approval check (P0 - 审批机制) ─────────
			const toolDef = toolDefMap.get(targetToolName);
			const approved = await this._approvalService.checkAndApprove(
				{ id: toolCall.id, name: targetToolName, arguments: args, worktreePath },
				toolDef,
				askRouting,
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
						{ id: toolCall.id, name: targetToolName, arguments: args, worktreePath, sessionId: agentSessionId },
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
								{ id: toolCall.id, name: targetToolName, arguments: args, worktreePath, sessionId: agentSessionId },
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
	 */ public async *_executeToolCallsParallelStreaming(toolCalls: IToolCallInfo[], agentId: string, worktreePath?: string, abortSignal?: AbortSignal, askRouting?: IAskRoutingContext, agentSessionId?: string): AsyncGenerator<{ toolCallId: string; content: any; success: boolean }, void, unknown> {
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
			const coerceResult = coerceOrReject(args, toolSchema, targetToolName, this._logService);
			args = coerceResult.args;
			if (coerceResult.reject) {
				executionEntries.push({
					originalIndex: i,
					toolCall,
					targetToolName,
					args: {},
					skip: true,
					skipResult: { toolCallId: toolCall.id, ...coerceResult.reject },
				});
				continue;
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
					targetToolName, args, agentId, toolCall.id, abortSignal, worktreePath, askRouting, agentSessionId,
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
				{ id: toolCall.id, name: targetToolName, arguments: args, worktreePath },
				toolDef,
				askRouting,
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
						{ id: toolCall.id, name: targetToolName, arguments: args, worktreePath, sessionId: agentSessionId },
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
	 */ public _tryExtractToolCallsFromText(text: string, thinkingContent?: string, enabledTools?: IToolDefinition[]): IToolCallInfo[] {
		return extractToolCallsFromText({ logService: this._logService }, text, thinkingContent, enabledTools);
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

	/**
	 * 把底层错误翻译成面向用户的清晰中文提示（替代裸 TimeoutError / 英文堆栈）。
	 * 重点处理模型流 idle 超时（TCP 连接存活但不再吐数据）这类用户可理解的场景。
	 */
	private _formatUserFacingError(error: Error | undefined, triedModels: string[]): string {
		return formatUserFacingError(this._modelAccessDeps, error, triedModels);
	}

	private _getActiveModelProvider(): IModelProvider | undefined {
		return getActiveModelProvider(this._modelAccessDeps);
	}
 public *_fallbackToDirectChat(request: IAgentTurnRequest): Generator<IChatStreamDelta, any, any> {
		// Phase 1: 直通模式 — 通过现有 agentChatService 发送
		// 此方法在 Phase 2 重构 agentChatService 后可移除
		this._logService.info('[AgentOS] Fallback: delegating to AgentChatService');
		// 返回空（Phase 1 暂时不实现直通）
		yield { type: 'error', content: 'No ModelProvider registered. Please install a Model Provider plugin.' };
	}
 public _adaptModelDelta(delta: any): IChatStreamDelta {
		return adaptModelDelta(this._modelAccessDeps, delta);
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
		return resolveContextWindow(this._modelAccessDeps, provider, modelId);
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
		const mcpService = this._mcpService;
		if (mcpService?.onDidChangeMcpServers) {
			this._register(mcpService.onDidChangeMcpServers(() => {
				this._bumpToolDefsCache();
			}));
			listenerCount++;
			this._logService.info('[AgentOS] Registered MCP server change listener for cache invalidation');
		}

		// ③ IConfigurationService: 配置变化（影响工具集定义）
		const configService = this._configService;
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
			const configPath = this._configService?.getConfigPath?.();
			if (!configPath) { return ''; }
			const stat = (this._fileService as any)?.stat?.(configPath);
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
			const configService = this._configService;
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
	 */ public _estimateMessagesTokens(messages: ReadonlyArray<any>): number {
		return estimateMessagesTokens(messages);
	}

	/**
	 * 仅检索：从记忆系统取回相关上下文，替代同步 LLM 摘要。
	 * 优先 getCompactContext（Zero-LLM 合成的 SessionSummary），否则回退
	 * recallFormatted（按当前任务 query 检索 episodic/semantic 记忆）。
	 */ public async _retrieveContextOnly(
		provider: any,
		agentId: string,
		sessionId: string,
		middle: ReadonlyArray<any>,
		budget: number,
	): Promise<{ context: string; tokens: number; source: string } | null> {
		return retrieveContextOnly(provider, agentId, sessionId, middle, budget);
	}

	/**
	 * 压缩期检索式上下文（对齐 agentmemory mem::context）：先增量外置 middle 到记忆，
	 * 再检索相关上下文替代同步 LLM 摘要。供 compressContext 的 retrieveContext 回调使用。
	 */ public async _retrieveCompactionContext(
		provider: any,
		req: { agentId: string; sessionId: string; middle: ReadonlyArray<any>; contextWindow: number; budget: number },
	): Promise<{ context: string; tokens: number; source: string } | null> {
		return retrieveCompactionContext(provider, this._contextDeps, req);
	}

	/**
	 * 将对话增量外置为 episodic 记忆，供后续检索取回（对齐 agentmemory 把 observation
	 * 外置到 KV）。按内容哈希去重，避免重复写入与记忆膨胀；跳过 system 消息，
	 * 只外置 user/assistant/tool 的真实对话内容。
	 */ public async _storeTurnObservations(
		provider: any,
		agentId: string,
		sessionId: string,
		messages: ReadonlyArray<any>,
	): Promise<void> {
		return storeTurnObservations(this._contextDeps, provider, agentId, sessionId, messages);
	}

	/**
	 * 把检索到的上下文作为独立 system 消息注入（放在固定 system 之后、user 之前）。
	 * 使用 RETRIEVED_CTX_PREFIX，使压缩时 contextManager 会剥离它、由摘要接管，
	 * 避免与压缩摘要重复累积。已注入则跳过（去重）。
	 */ public _injectRetrievalSystemMessage(messages: any[], context: string, _source: string): any[] {
		return injectRetrievalSystemMessage(messages, context, _source);
	}

}

