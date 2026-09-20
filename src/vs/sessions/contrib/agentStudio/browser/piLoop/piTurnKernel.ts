/*---------------------------------------------------------------------------------------------
 *  piTurnKernel.ts —— pi 内核的**真路径**轮驱动器（doc/agentloop-pi-core-redesign.md §5 的 P1 门控实现）。
 *
 *  与对拍入口（`hostBridge.installPiLoopDualRunGlobal`）的分工：
 *    · 对拍入口：独立最小链路（只读工具、不写会话）⇒ 验证内核的机械正确性；
 *    · 本驱动器：替换 `executeAgentTurnDirect` 的**内核**（模型流 → 工具执行 → 续跑），
 *      复用 legacy 的前置产物（`initTurnContext`：记忆注入/权限/工具门控都已生效）
 *      与工具执行链（`host._executeToolCalls`：审批/沙箱/图谱副作用全部保留）。
 *
 *  门控（默认 legacy，**双跑为准入**）：
 *    · `window.__SAROSIS_PI_KERNEL = true` 或 env `SAROSIS_PI_KERNEL=1`；
 *    · 不支持的形态**自动回落 legacy**（`piKernelSupports`）：plan 模式 / chatOnly /
 *      断点续跑（resumeFrom）/ 子代理（subAgent，带 softDeadlineMs 语义，pi 路径暂未接）。
 *
 *  ⚠ 已知缺口（正式豁免，附理由；翻转默认值前无需补齐）：
 *    · **ToolAudit / AntiGuidance**（executor:826-870/3140+）：纯观测面 —— 只记录水位/指纹/
 *      日志，不影响任何模型可见行为。豁免理由：pi 路径的每条护栏触发都有等价 warn 日志
 *      （[PiKernel] 前缀可 grep），审计聚合报告是 legacy 的调参基础设施，双跑期以日志为准。
 *    · **hookBus `before_tool`**（executor:3040+）：唯一 handler 是 memory provider 的
 *      pre_tool_use 转发（上下文丰富化）。pi 路径经 `_observeToolResult` 仍喂结果侧信号；
 *      pre 侧缺失只影响记忆系统的细粒度上下文，不改行为。
 *    · **checkpoint 的 preExploreDone / paradigmOverride** 恢复：preLoop/范式在 pi 路径
 *      不存在 ⇒ 无恢复对象；phase 与 legacy 一样**故意不恢复**（防副作用工具重跑）。
 *    · **incomplete-turn 重试的 `tool-call-lost` 诊断增强**（outputTokens 判据日志）未复刻 ——
 *      纯日志增强，重试行为已对齐。
 *  D2 已接（2026-09-20）：resumeFrom 恢复（messages 优先/loopMessages 回落 + 划痕
 *  runState 安全恢复 + 迭代接续扣减）+ 每 3 轮 `buildCheckpointSnapshot` 落盘
 *  （fire-and-forget，对齐 turnPostIteration:441-472）。
 *  已对齐 legacy 的 parity 项：记忆检索注入（executor:1123-1159）、Dashboard token
 *  计数（executor:1776-1816 口径）、工具循环护栏全套（executor:2862-2936 的
 *  ping-pong/detectToolCallLoop + ToolGuardrailController 的 no-progress/halt，
 *  executor 同款显式配置）、`_setCurrentModel` 登记（executor:1119）、压缩四级阶梯
 *  （parts/turnContextCompaction 同一实现，经 piLoop `transformContext` 缝接入并
 *  **写回权威 transcript** —— piLoop 的 transformContext 默认只影响发送副本，而
 *  legacy 压缩改写权威历史，故就地 splice）、steering 队列（pi 轮询模型 +
 *  DeliveryQueue 租约桥，follow-up 续跑）、撞顶收尾轮（maxTurns 撞顶且模型仍在要
 *  工具 ⇒ 禁工具收尾轮 toolChoice:'none' + hardLimitWrapUpReminder，再硬停）、
 *  边界引导八件套：XML 泄漏重试（runLoop 缝：丢弃文本不入 transcript + 纠正指令 +
 *  重试 ≤2 + discard_prior_text 清屏，executor:2294-2368）、reasonStreak（同 thinking
 *  连击 ≥3 ⇒ 恢复引导，executor:3088-3106；⚠ pi-ai 的 AgentToolCall.arguments 是对象
 *  非字符串，误按 string 解析会让所有轮 argsHash 全同 ⇒ streak 误报）、连续失败熔断
 *  （连败 3 次提醒，executor:3352-3363）、terminal 空输出连击（'(no output)' ×3 ⇒
 *  提醒，executor:3365-3385）、文本搜索连击（软 4 提醒一次 / 硬 8 ⇒ `requestWrapUp`
 *  强制禁工具收尾轮，executor:3395-3430）、argument_churn（同工具参数各异 ×5 ⇒
 *  引导一次，多目标工具只留痕，executor:3110-3135）、单只读工具连击（每轮只请求 1 个
 *  并行安全只读工具 ×4 ⇒ 批量并行引导，executor:3211-3240）、全批拦截连击（一轮全部
 *  调用被拦 ⇒ 三档：仅回填 / ≥2 强提醒直写 transcript / ≥4 强制收尾轮，executor:2980-3031）、
 *  未完成轮安全续跑（fork 缝 `incompleteTurnRetry`：空/只有思考/截断/工具调用丢失 ⇒ 按类
 *  阶梯指令续跑，每类独立上限；length/truncated-text **保留**半截文本续写不 discard；
 *  >90% 上下文压力重置压缩冷却；executor:2375-2470）
 *  —— 提醒默认经「追加进下一条工具结果文本」投递（对齐 legacy _pendingBatchReminders
 *  的"只随工具批次注入"语义）；⚠ 被拦调用走 piLoop 'immediate' 路径**不过 afterToolCall**
 *  ⇒ 全批拦截轮的强提醒在 shouldStopAfterTurn 直写 transcript（legacy 同款 appendMessages）、
 *  子代理语义（2026-09-20 接入，`piKernelSupports` 已解除排除）：软预算提醒
 *  （wall-clock 超 softDeadlineMs ⇒ `softBudgetWrapUpReminder`，60s 周期重提，
 *  turnIterationGate:256-268）+ 迭代预算 1000（background，executor:765-769）+
 *  `deriveAskRoutingContext` 审批路由（executor:3247）；180s 工具活动超时在 host
 *  执行层，天然继承）、plan 编排（D1，2026-09-20 接入，`piKernelSupports` 已解除排除）：
 *  plan_enter/plan_exit/plan_explore 批后拦截复用 `parts/turnPlanModeTools` 同一实现，
 *  拦截点 = `shouldStopAfterTurn`（对齐 executor:3667 的批后时序），产出 delta 经
 *  pending 桥流式上屏，'done' ⇒ 本 turn 结束；messages 经 pi⇄legacy 转换器往返
 *  （与压缩段同款），work.mode 划痕播种 `resolveRequestWorkMode(chatMode, workMode)`。
 *
 *  ⚠ 系统提示的送达：piLoop 的 `TranscriptContext` **没有** systemPrompt 通道
 *    （`normalizeTranscript` 只透传 messages）—— 系统提示必须以 `role:'system'` 消息
 *    随种子历史携带。legacy 的 `ctx.messages[0]` 正是它（agentTurnExecutor 在
 *    initTurnContext 里 prepend），故本驱动器**不再**单独设置 `context.systemPrompt`。
 *--------------------------------------------------------------------------------------------*/

import type { ILogService } from '../../../../../platform/log/common/log.js';
import type {
	IAgentTurnRequest,
	IChatStreamDelta,
	IMemoryProvider,
	IModelProvider,
	IModelSelection,
	IToolCall,
	IToolCallInfo,
	IToolDefinition,
} from '../../common/providers.js';
import {
	classifyIncompleteTurn,
	createInitialRunState,
	detectTruncatedTail,
	detectXmlToolCallLeak,
	incompleteTurnDiscardReason,
	incompleteTurnRetryLimit,
	reduceRunState,
	resolveIncompleteTurnRetryInstruction,
	restoreRunState,
	RUN_STATE_LIMITS,
	type AgentAction,
	type AgentRunMessage,
	type IncompleteTurnKind,
} from '../../common/agentRunState.js';
import { COMPRESSION_COOLDOWN_MS } from '../../common/turnLoopConstants.js';
import { xmlToolCallLeakReminder } from '../../common/loopReminders.js';
import { deriveAskRoutingContext } from '../../common/askRouting.js';
import { createInitialWorkState, resolveRequestWorkMode } from '../../common/workMode.js';
import { ContextManager, RETRIEVAL_BUDGET_RATIO, RETRIEVAL_COMPACTION_ENABLED } from '../../common/contextManager.js';
import type { DeliveryQueue } from '../../common/deliveryQueue.js';
import {
	compactContextIfNeededImpl,
	type IContextCompactionDeps,
	type IContextCompactionHost,
	type IContextCompactionManager,
	type IContextCompactionState,
} from '../parts/turnContextCompaction.js';
import { estimateToolsSchemaTokens } from '../parts/turnHelpers.js';
import { runAgentLoop } from './agentLoop.js';
import { createPiStreamFn } from './streamAdapter.js';
import { toAgentTools, type ToolExecutor } from './toolAdapter.js';
import { createPiLoopEventMapper } from './eventAdapter.js';
import { piLoopConvertToLlm } from './hostBridge.js';
import type {
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AssistantMessage,
	Model,
} from './types.js';
import { loopMessagesToPiMessages, piMessagesToLoopMessages } from './kernelMessages.js';
import { toolResultToText } from './kernelUtils.js';
import { makeGuardrailHooks } from './kernelGuardrails.js';
import { createPlanInterception } from './kernelPlan.js';
import { createCheckpointWriter, resolveResume } from './kernelCheckpoint.js';

// ── 拆出的子模块（2026-09-20，A3：「内核薄、复杂度归钩子」）────────────────
// kernelUtils（纯小件）/ kernelMessages（pi⇄legacy 转换器）/ kernelGuardrails
// （护栏+引导族）/ kernelPlan（plan 批后拦截）/ kernelCheckpoint（resume+落盘）。
// 转换器从本文件 re-export：既有测试/调用方入口不变。
export { loopMessagesToPiMessages, piMessagesToLoopMessages } from './kernelMessages.js';

// ─────────────────────────── 门控 ───────────────────────────

/**
 * pi 内核开关（**2026-09-20 E2 翻转：默认开** = pi 内核驱动）。
 * 显式回落 legacy：`window.__SAROSIS_PI_KERNEL = false`（devtools）或 env `SAROSIS_PI_KERNEL=0`。
 * 显式开启（冗余但保留）：`= true` / `=1`。
 * 与 `[MainHeartbeat]`/`[RenderHeartbeat]` 同款运行时门控约定，无需重启 vs 需重启的取舍：
 * 该判定在**每个 turn 开始处**执行 ⇒ devtools 里翻转后立即对下一条消息生效。
 *
 * 翻转依据（见 doc/agentloop-pi-migration-plan.html 状态）：双跑矩阵 15 形态全绿、
 * 准入 149/149 钉住 legacy（套件内显式关断本开关）、护栏六件套/plan/resume/subAgent
 * 全形态接入（piKernelSupports 恒 true）。
 */
export function isPiKernelEnabled(): boolean {
	try {
		const flag = (globalThis as unknown as Record<string, unknown>)['__SAROSIS_PI_KERNEL'];
		if (flag === true) { return true; }
		if (flag === false) { return false; }
	} catch { /* ignore */ }
	try {
		const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
		const env = proc?.env?.['SAROSIS_PI_KERNEL'];
		if (env === '1') { return true; }
		if (env === '0') { return false; }
	} catch { /* ignore */ }
	return true;
}

/**
 * pi 路径当前支持的 turn 形态；不支持 ⇒ 调用方回落 legacy（不报错、不打断）。
 *
 * ⚠ chatOnly 于 2026-09-20 **移出排除清单**：executor 的写工具过滤（`agentTurnExecutor.ts`
 * chatOnly 分支）发生在门控分流点**之前** ⇒ 到达驱动器的 `enabledTools` 已是过滤后的
 * 安全集合，pi 路径无需任何额外处理即继承该语义（阶段 1 唯一"零成本"项，实证见
 * `piTurnKernel.test.ts` 的 chatOnly 用例）。
 */
export function piKernelSupports(request: IAgentTurnRequest): boolean {
	// 2026-09-20：全部形态已接入 ——
	//   · resumeFrom（D2）：checkpoint 恢复（messages 优先/loopMessages 回落）+ 划痕
	//     runState 安全恢复 + 迭代计数接续 + 每 3 轮快照落盘（request.checkpointSink）；
	//   · plan（D1）：plan_enter/plan_exit/plan_explore 批后拦截复用 parts/turnPlanModeTools
	//     同一实现（拦截点 = shouldStopAfterTurn，对齐 executor:3667）；
	//   · subAgent：softDeadlineMs 软预算提醒（60s 周期重提）+ 迭代预算 1000（background）
	//     + askRouting 审批路由；180s 工具活动超时在 host 执行层，天然继承。
	// 保留本函数作为将来新增不支持形态的单点门（返回 true = 全形态支持）。
	void request;
	return true;
}

// ─────────────────────────── 宿主窄接口 ───────────────────────────

/**
 * 驱动器实际读到的宿主面（沿用 `turnHost.ts`/`turnIterationGate.ts` 的窄接口纪律：
 * 只声明用到的成员）。`host._executeToolCalls` 是 legacy 的工具执行总线 ——
 * 审批 / 沙箱 / 权限 / 图谱副作用全在里面，pi 路径**不重造**。
 */
export interface IPiKernelHost {
	readonly _logService: ILogService;
	readonly _loopAbortController?: AbortController | undefined;
	_executeToolCalls(
		toolCalls: IToolCallInfo[],
		agentId: string,
		worktreePath?: string,
		abortSignal?: AbortSignal,
		askRouting?: unknown,
		agentSessionId?: string,
	): Promise<Array<{ toolCallId: string; content: unknown; success: boolean; metadata?: Record<string, unknown> }>>;
	_observeToolResult?(
		agentId: string,
		toolResult: { toolCallId: string; content: unknown; success: boolean; toolName?: string },
		sessionId?: string,
	): void;

	// ── Dashboard token 计数（executor:1776-1816 同款累加，均见 ITurnHostCounters/Lifecycle）──
	_totalInputTokens: number;
	_totalOutputTokens: number;
	_totalCachedTokens: number;
	readonly _lastRealPromptTokensByAgent: Map<string, number>;
	readonly _lastAssistantAtByAgent: Map<string, number>;
	_turnKey(agentId: string | undefined, sessionId: string | undefined): string;
	_scheduleSave(): void;

	// ── 记忆检索注入（executor:1123-1159 同款 host 方法，见 ITurnHostExecution）──
	getActiveMemoryProvider(): IMemoryProvider | undefined;
	_setCurrentModel(provider: IModelProvider | undefined, modelId: string | undefined): void;
	_resolveContextWindow(provider: IModelProvider, modelId: string): Promise<number>;
	_storeTurnObservations(provider: IMemoryProvider, agentId: string, sessionId: string, messages: ReadonlyArray<unknown>): Promise<void>;
	_retrieveContextOnly(provider: IMemoryProvider, agentId: string, sessionId: string, middle: ReadonlyArray<unknown>, budget: number): Promise<{ context: string; tokens: number; source: string } | null>;
	_injectRetrievalSystemMessage(messages: unknown[], context: string, source: string): unknown[];

	// ── plan 编排面（D1；parts/turnPlanModeTools 的宿主面，全可选 —— 缺失时 plan 工具
	//    按普通工具执行并告警，不拦截）──────────────────────────────────────────
	_getSarosRoot?(): string;
	_writePlanFile?(path: string, content: string): Promise<void>;
	_readPlanFile?(path: string): Promise<string>;
	_awaitPlanApproval?(confirmationId: string): Promise<string>;
	_orchestratePlan?(
		request: IAgentTurnRequest,
		options: { plan_summary: string; next_mode: string; idempotencyKey: string },
		tasks: unknown[],
		toolCallId: string,
	): AsyncGenerator<IChatStreamDelta>;

	// ── 压缩段（parts/turnContextCompaction 的 IContextCompactionHost 面）──
	_estimateMessagesTokens(messages: readonly unknown[]): number;
	_lastCompressionTime: number;
	_lastHardPruneBaselineTokens: number;
	_compressionCount: number;
	_compressionIneffectiveCount: number;
	_compressionBeforeTokens: number;
	_compressionAfterTokens: number;
	readonly _currentWorkspaceId: string | undefined;
	_retrieveCompactionContext(provider: IMemoryProvider, req: unknown): Promise<unknown>;
}

/** 一轮 turn 的前置产物（由 `initTurnContext` + executor 的工具门控产出）。 */
export interface PiKernelTurnDeps {
	readonly modelProvider: IModelProvider;
	readonly selection: IModelSelection;
	/** ⚠ 必须是 executor 过滤后的最终工具列表（plan-exclusive/chatOnly 门控已应用）。 */
	readonly enabledTools: readonly IToolDefinition[];
	/** 种子历史（含首条 `role:'system'` 的冻结前缀；形状 = legacy 循环消息）。 */
	readonly messages: readonly AgentRunMessage[];
	/** 压缩管理器工厂（默认 `new ContextManager(provider, modelId)`；测试注入 mock）。 */
	readonly contextManagerFactory?: () => IContextCompactionManager;
	/**
	 * steering 队列（用户插话；可选）。缺失时 pi 路径不轮询 —— 与 legacy 不传
	 * `steeringQueue` 形参等价。注入语义对齐 legacy `injectSteeringMessages`
	 * （common/loopGate.ts）：lease → 追加成功才 ack；失败 release 归还重试。
	 */
	readonly steeringQueue?: DeliveryQueue;
	/** 迭代上限（默认 RUN_STATE_LIMITS.MAX_TOOL_ITERATIONS=100；测试可传小值验证收尾轮）。 */
	readonly maxTurns?: number;
}

// ─────────────────────────── 主驱动 ───────────────────────────

/**
 * 用 piLoop 内核驱动一个 turn，产出与 legacy `executeAgentTurnDirect` **同一契约**的
 * `IChatStreamDelta` 流（UI/会话/审批零改动）。
 *
 * 实现要点：`runAgentLoop` 是 Promise + emit sink 风格，本函数用「缓冲 + 唤醒」桥成
 * async generator —— delta 随 emit 即时产出（流式 UI 不降级），loop 终结后退出。
 */
export async function* runPiKernelTurn(
	host: IPiKernelHost,
	request: IAgentTurnRequest,
	deps: PiKernelTurnDeps,
): AsyncGenerator<IChatStreamDelta, void> {
	const t0 = Date.now();
	const agentId = request.agentId ?? '';
	host._logService.info(
		`[PiKernel] turn 开始：agentId=${agentId} model=${deps.selection.modelId} ` +
		`tools=${deps.enabledTools.length} seed=${deps.messages.length}`,
	);

	// ── parity（executor:1119）：登记当前模型，供宿主实时查表上下文窗口 ──
	host._setCurrentModel(deps.modelProvider, deps.selection.modelId);

	// ── resumeFrom 断点续跑（D2，kernelCheckpoint.ts）─────────────────────────
	// checkpoint 恢复 > 上下文构建结果：messages 优先 / loopMessages 回落；迭代计数接续。
	// ⚠ phase 与 legacy 一样故意不恢复（防副作用工具重跑）。
	const restored = request.resumeFrom;
	const { restoredMessages, restoredIteration } = resolveResume(request, host._logService);

	// ── 记忆检索注入（与 executor:1123-1159 同一语义、同一批 host 方法）──────────
	// 在 **legacy 形状**的种子上操作（_retrieveContextOnly/_injectRetrievalSystemMessage
	// 都吃 legacy 消息），注入完成后再转 pi 形状。默认开启（AGENT_OS_RETRIEVAL_COMPACTION=0 关）。
	let seedMessages: readonly AgentRunMessage[] = restoredMessages ?? deps.messages;
	if (RETRIEVAL_COMPACTION_ENABLED) {
		const rp = host.getActiveMemoryProvider();
		if (rp && typeof (rp as { recallFormatted?: unknown }).recallFormatted === 'function') {
			const retrievalAgentId = agentId || 'default';
			const retrievalSessionId = request.sessionId ?? '';
			// 与 legacy 相同：先亮「正在检索历史上下文」（32s 静默的教训，executor:1131）
			yield { type: 'phase_change', phase: 'retrieving' } as IChatStreamDelta;
			try {
				await host._storeTurnObservations(rp, retrievalAgentId, retrievalSessionId, seedMessages);
				const contextWindow = await host._resolveContextWindow(deps.modelProvider, deps.selection.modelId);
				const r = await host._retrieveContextOnly(rp, retrievalAgentId, retrievalSessionId, seedMessages, Math.floor(contextWindow * RETRIEVAL_BUDGET_RATIO));
				if (r && r.context.trim()) {
					seedMessages = host._injectRetrievalSystemMessage([...seedMessages], r.context, r.source) as AgentRunMessage[];
					host._logService.info(`[PiKernel][Retrieval] injected retrieved context at turn start (source=${r.source}, ~${Math.ceil(r.context.length / 3)} tokens)`);
					yield { type: 'memory_injected', content: `已检索注入历史上下文 (~${Math.ceil(r.context.length / 3)} tokens)` } as IChatStreamDelta;
				}
			} catch (err) {
				host._logService.warn(`[PiKernel][Retrieval] 检索注入失败（继续本轮）：${err instanceof Error ? err.message : String(err)}`);
			}
			yield { type: 'phase_change', phase: 'llm_streaming' } as IChatStreamDelta;
		}
	}

	const model = { id: deps.selection.modelId, name: deps.selection.modelId, api: 'openai-completions', provider: 'saros' } as unknown as Model;

	// ── 压缩段（四级阶梯，复用 parts/turnContextCompaction 的同一实现）──────────────
	// 缝在 piLoop `transformContext`（每次模型请求前，对齐 legacy 的每迭代开头调用点
	// executor:1367）。形态差：压缩模块吃 **legacy 形状**消息 ⇒ pi→legacy 转换 ⇒ 压缩 ⇒
	// legacy→pi 回转，且**写回权威 transcript** —— piLoop 的 transformContext 默认只影响
	// 发送副本，而 legacy 压缩改写权威历史 ⇒ 就地 splice（保持数组引用，loop 后续 push 的
	// assistant/toolResult 落在压缩后的历史上）。
	const compressionWindow = await host._resolveContextWindow(deps.modelProvider, deps.selection.modelId);
	let contextManager: IContextCompactionManager;
	if (deps.contextManagerFactory) {
		contextManager = deps.contextManagerFactory();
	} else {
		const cm = new ContextManager(deps.modelProvider, deps.selection.modelId);
		cm.setLogger({
			info: (msg: string) => host._logService.info(msg),
			warn: (msg: string) => host._logService.warn(msg),
			error: (msg: string, error?: unknown) => host._logService.error(msg, error),
			debug: (msg: string) => host._logService.debug(msg),
		});
		contextManager = cm;
	}
	// 本地 runState 划痕：pi 路径不挂宿主 runState；本对象只承担压缩段读取的
	// lastRealPromptTokens（真实值由 accumulateUsage 在每轮 message_end 回填）与 phase。
	let compactionRunState = createInitialRunState({
		lastRealPromptTokens: host._lastRealPromptTokensByAgent.get(host._turnKey(request.agentId, request.sessionId)) ?? 0,
		// plan 编排也读这个划痕的 work.mode —— 初值播种与 legacy 同（executor createInitialRunState 处）
		workState: createInitialWorkState(resolveRequestWorkMode(request.chatMode, request.workMode)),
	});
	// D2：断点续跑 ⇒ 划痕 runState 从快照安全恢复（永不抛错；work.mode/planFilePath/
	// 计数器随快照回来 —— 对齐 legacy resume 后 runState 接续的语义）。
	if (restored) {
		compactionRunState = restoreRunState(restored);
	}
	const dispatchCompactionRunState = (action: AgentAction): void => { compactionRunState = reduceRunState(compactionRunState, action); };
	let hardPrunePending = false;
	const compactionDeps: IContextCompactionDeps = {
		host: host as unknown as IContextCompactionHost,
		request,
		contextManager,
		compressionWindow,
		enabledTools: () => deps.enabledTools,
		estimateToolsSchemaTokens,
	};

	const guardrails = makeGuardrailHooks(host, deps.enabledTools, { softDeadlineMs: request.softDeadlineMs });
	// 迭代预算基准（background 子代理 1000 / 主代理 100 / 测试缝 deps.maxTurns）——
	// maxTurns 与 checkpoint 的 budgetSnapshot 共用同一基准，避免两处口径分叉。
	const baseMaxTurns = deps.maxTurns ?? (request.subAgent?.background ? 1000 : RUN_STATE_LIMITS.MAX_TOOL_ITERATIONS);
	const context = {
		messages: loopMessagesToPiMessages(seedMessages),
		systemPrompt: '', // 见文件头：system 由种子历史携带，此字段在 piLoop 中无通道
		tools: toAgentTools(deps.enabledTools, makeHostToolExecutor(host, request)),
	};
	const config: AgentLoopConfig = {
		model,
		convertToLlm: piLoopConvertToLlm,
		// 迭代上限与 legacy 对齐（executor:765-769）：background 子代理 1000（只受工具活动
		// 超时约束，1000 仅为失控保险丝）；主代理 100。撞顶后 runLoop 会跑一轮禁工具收尾。
		// resume 续跑：迭代计数接续（否则每次 resume 白拿整份预算 ⇒ 无限续跑失控）。
		maxTurns: Math.max(0, baseMaxTurns - restoredIteration),
		// 工具护栏（对齐 executor:2862-2936 + 护栏控制器）：ping-pong / no-progress /
		// 同签名循环 ⇒ 拦；同名工具失败 8 次 ⇒ halt（经 shouldStopAfterTurn 收尾退出）。
		beforeToolCall: guardrails.beforeToolCall,
		afterToolCall: guardrails.afterToolCall,
		shouldStopAfterTurn: async (ctx) => {
			// plan 批后拦截先行（对齐 executor:3667 的时序）；'done' ⇒ 本 turn 结束。
			// transcript 就地改写（legacy 拦截器同款 messages 重写语义）。
			if (await planInterception.tryIntercept(ctx.messages as AgentMessage[])) { return true; }
			return guardrails.shouldStopAfterTurn(ctx);
		},
		// XML 文本工具调用泄漏守卫（对齐 executor:2294-2368，重试上限 2）
		textToolCallLeakGuard: {
			detect: detectXmlToolCallLeak,
			reminder: xmlToolCallLeakReminder,
			retryLimit: 2,
		},
		// 强制收尾轮请求（文本搜索连击硬上限等；对齐 legacy wrapUp.forced）
		requestWrapUp: guardrails.requestWrapUp,
		// 转录卫生（2026-09-20）：内核摘除孤儿 tool 对后记日志 —— 修复「LMBridge 每轮
		// 重剥同样孤儿」的实证缺陷（pi 权威 transcript 此前永不清洗）。
		onTranscriptPruned: r => host._logService.info(
			`[PiKernel] transcript hygiene: 摘除孤儿 tool call ×${r.prunedCalls} / result ×${r.prunedResults}` +
			(r.droppedMessages > 0 ? ` / 连带移除消息 ×${r.droppedMessages}` : ''),
		),
		// 未完成轮安全续跑（对齐 executor:2375-2470）：pi stopReason → legacy finishReason
		// 映射后复用同一组分类器/阶梯/上限；>90% 上下文压力时重置压缩冷却（executor:2445-2462）。
		incompleteTurnRetry: (message: AssistantMessage) => {
			let text = '';
			let thinking = '';
			for (const b of message.content) {
				const t = (b as { type?: string }).type;
				if (t === 'text') { text += (b as { text?: string }).text ?? ''; }
				else if (t === 'thinking') { thinking += (b as { thinking?: string }).thinking ?? ''; }
			}
			text = text.trim();
			const finishReason = message.stopReason === 'length' ? 'length'
				: message.stopReason === 'toolUse' ? 'tool_calls'
					: message.stopReason === 'error' ? 'error' : 'stop';
			let kind: IncompleteTurnKind = classifyIncompleteTurn({
				finishReason,
				hasVisibleText: text.length > 0,
				hasThinking: thinking.trim().length > 0,
				hasToolCalls: false,
			});
			// 尾部结构截断补位（executor:2387-2393）：provider 误报 stop 的半截文本
			if (kind === 'complete' && text.length > 0 && detectTruncatedTail(text)) {
				kind = 'truncated-text';
			}
			const used = incompleteRetryUsed.get(kind) ?? 0;
			const limit = incompleteTurnRetryLimit(kind);
			const instruction = resolveIncompleteTurnRetryInstruction(kind, used + 1);
			if (!instruction || used >= limit) {
				if (kind !== 'complete') {
					host._logService.warn(`[PiKernel] Incomplete turn retries exhausted (kind=${kind}, finishReason=${message.stopReason}, textLen=${text.length}) — ending conversation`);
				}
				return undefined;
			}
			incompleteRetryUsed.set(kind, used + 1);
			host._logService.warn(`[PiKernel] Incomplete turn (kind=${kind}, finishReason=${message.stopReason}, attempt=${used + 1}/${limit}${text.length > 0 ? `, partialTextLen=${text.length} (kept, not discarded)` : ''}) — safe retry`);
			// 上下文压力 >90% ⇒ 重置压缩冷却（超限 prompt 直接重试必再失败，executor:2445-2462）
			{
				const estTokens = host._estimateMessagesTokens(piMessagesToLoopMessages(context.messages));
				const effectiveTokens = compactionRunState.lastRealPromptTokens ?? estTokens;
				if (compressionWindow > 0 && effectiveTokens > compressionWindow * 0.9) {
					const cooldownMs = host._lastCompressionTime > 0 ? Date.now() - host._lastCompressionTime : Infinity;
					if (cooldownMs < COMPRESSION_COOLDOWN_MS) {
						host._logService.warn(`[PiKernel] Incomplete turn + high pressure (${Math.round(effectiveTokens / compressionWindow * 100)}%): bypassing compression cooldown`);
						host._lastCompressionTime = 0;
					}
				}
			}
			// length / truncated-text 保留半截文本（incompleteTurnDiscardReason 返回 undefined）
			return { instruction, discard: incompleteTurnDiscardReason(kind) !== undefined, kind };
		},
		// steering 轮询（pi 语义）：用户插话在「起始 + 每个边界」被取走并注入 transcript。
		getSteeringMessages: deps.steeringQueue
			? makeSteeringGetter(host, agentId, deps.steeringQueue, `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
			: undefined,
		transformContext: async (piMessages, _signal) => {
			let legacy = piMessagesToLoopMessages(piMessages);
			const state: IContextCompactionState = {
				messages: () => legacy,
				setMessages: next => { legacy = next; },
				// pi 路径的权威历史是 transcript 本身；runState.messages 在本路径无人读 ⇒ 无需同步
				syncMessages: () => { /* no-op（见上） */ },
				runState: () => compactionRunState,
				dispatchRunState: dispatchCompactionRunState,
				hardPrunePending: () => hardPrunePending,
				setHardPrunePending: next => { hardPrunePending = next; },
			};
			try {
				// emit 桥：压缩段的 phase_change / context_compacted 即时进 pending ——
				// transformContext 被 loop await，事件先于下一次模型请求上屏（背压兼容）。
				await compactContextIfNeededImpl(async delta => { pending.push(delta); notify(); }, compactionDeps, state);
			} catch (err) {
				host._logService.warn(`[PiKernel][Compaction] 压缩段异常（本轮按未压缩继续）：${err instanceof Error ? err.message : String(err)}`);
			}
			const compacted = loopMessagesToPiMessages(legacy);
			context.messages.splice(0, context.messages.length, ...compacted);
			return compacted;
		},
	};

	const mapEvent = createPiLoopEventMapper();
	const pending: IChatStreamDelta[] = [];
	let wake: (() => void) | undefined;
	const notify = (): void => { const w = wake; wake = undefined; w?.(); };
	// 未完成轮续跑的按类计数（legacy runState.retry 的驱动器本地等价物）
	const incompleteRetryUsed = new Map<string, number>();
	// ── plan 批后拦截（D1，kernelPlan.ts）：trackEvent 挂在 emit 上，
	//    tryIntercept 挂在 config.shouldStopAfterTurn（= 批后时机）──
	const planInterception = createPlanInterception({
		host, request,
		getRunState: () => compactionRunState,
		dispatchRunState: dispatchCompactionRunState,
		pushDelta: delta => { pending.push(delta); notify(); },
	});
	// ── checkpoint 落盘（D2，kernelCheckpoint.ts）：每 3 轮快照，fire-and-forget ──
	const checkpointWriter = createCheckpointWriter({
		request, host, baseMaxTurns, restoredIteration,
		getRunState: () => compactionRunState,
		getTranscript: () => context.messages,
	});
	const emit = async (event: AgentEvent): Promise<void> => {
		// Dashboard token 计数（executor:1776-1816 同款口径）：message_end 携带终态 usage。
		if (event.type === 'message_end') {
			const message = (event as { message?: AssistantMessage }).message;
			accumulateUsage(host, request, message, dispatchCompactionRunState);
			// reasonStreak 追踪（仅 assistant 工具轮；user 提醒/steering 消息不算）
			if (message && (message as { role?: string }).role === 'assistant') {
				guardrails.onAssistantMessageEnd(message);
			}
		}
		planInterception.trackEvent(event);
		if (event.type === 'turn_end') { checkpointWriter.onTurnEnd(); }
		for (const delta of mapEvent(event)) { pending.push(delta); }
		notify();
	};

	let loopError: unknown;
	let loopSettled = false;
	const done = runAgentLoop(
		[], // prompts 为空：用户消息已在种子历史里（initTurnContext 已注入）
		context,
		config,
		emit,
		host._loopAbortController?.signal,
		createPiStreamFn(deps.modelProvider, { modelId: deps.selection.modelId }),
	).then(
		() => { loopSettled = true; notify(); },
		(err: unknown) => { loopError = err; loopSettled = true; notify(); },
	);

	// 单线程保证：`if (loopSettled) break` 与 `wake = resolve` 之间无交错窗口。
	while (!loopSettled || pending.length > 0) {
		while (pending.length > 0) { yield pending.shift()!; }
		if (loopSettled) { break; }
		await new Promise<void>(resolve => { wake = resolve; });
	}
	await done;
	if (loopError !== undefined && loopError !== null) { throw loopError; }
	host._logService.info(`[PiKernel] turn 完成（${Date.now() - t0}ms）`);
}

// ─────────────────────────── 内部小件 ───────────────────────────

/** 把 piLoop 的工具调用路由进 legacy 工具执行总线（审批/沙箱/副作用全保留）。 */
function makeHostToolExecutor(host: IPiKernelHost, request: IAgentTurnRequest): ToolExecutor {
	let fallbackSeq = 0;
	return async (toolCall: IToolCall, signal, _onProgress) => {
		// IToolCall.arguments 是已解析对象；legacy 总线的 IToolCallInfo.arguments 是 JSON 字符串。
		const info: IToolCallInfo = {
			id: toolCall.id || `pi-call-${Date.now()}-${++fallbackSeq}`,
			name: toolCall.name,
			arguments: typeof toolCall.arguments === 'string'
				? toolCall.arguments
				: JSON.stringify(toolCall.arguments ?? {}),
		};
		let results;
		try {
			// 审批路由上下文与 legacy 一致（executor:3247 deriveAskRoutingContext）——
			// 子代理（background）的审批/权限分流依赖它；chatMode/workMode 两处 legacy 也传
			// undefined/runState.work.mode（plan 已被门控排除 ⇒ pi 路径恒为 work 语义）。
			const askRouting = deriveAskRoutingContext(request.subAgent, undefined, undefined);
			results = await host._executeToolCalls([info], request.agentId ?? '', undefined, signal, askRouting, request.sessionId);
		} catch (err) {
			// 不抛回内核：编码为错误工具结果，让模型看到失败并自行恢复（与 legacy 一致）。
			return { content: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
		const r = results?.[0];
		if (!r) { return { content: '工具执行无结果（宿主返回空数组）', isError: true }; }
		try {
			host._observeToolResult?.(request.agentId ?? '', { toolCallId: r.toolCallId, content: r.content, success: r.success, toolName: toolCall.name }, request.sessionId);
		} catch { /* 观察副作用失败不影响主流程 */ }
		return { content: toolResultToText(r.content), isError: !r.success };
	};
}

/**
 * Dashboard token 计数（executor:1776-1816 同款口径）—— 每条 assistant 终态消息结算一次。
 * OpenAI 系 inputTokens 已含 cache；Anthropic 系不含 ⇒ `input >= cached` 判定归一。
 * （piLoop `Usage` 暂无 cacheWrite 字段；若将来补齐，应计入 cacheSum。）
 */
function accumulateUsage(
	host: IPiKernelHost,
	request: IAgentTurnRequest,
	message: AssistantMessage | undefined,
	dispatchRunState?: (action: AgentAction) => void,
): void {
	const u = message?.usage;
	if (!u) { return; }
	const cached = u.cacheRead ?? 0;
	const input = u.input ?? 0;
	const realPrompt = input >= cached ? input : input + cached;
	if (realPrompt > 0) {
		const key = host._turnKey(request.agentId, request.sessionId);
		host._lastRealPromptTokensByAgent.set(key, realPrompt);
		host._lastAssistantAtByAgent.set(key, Date.now());
		// 压缩段的压力判定以它为唯一真实来源（executor:592 的 runState.lastRealPromptTokens）
		dispatchRunState?.({ type: 'SET_LAST_PROMPT_TOKENS', value: realPrompt });
	}
	host._totalInputTokens += input;
	host._totalOutputTokens += u.output ?? 0;
	host._totalCachedTokens += cached;
	host._scheduleSave();
}

/**
 * steering getter（pi 轮询模型 ⇒ 本仓 DeliveryQueue 租约语义的桥）：
 * `lease(agentId, leaseId)` 取全部 pending → 转 user 消息 → `ack` 确认交付；
 * 转换失败则 `release` 归还重试（对齐 legacy `injectSteeringMessages` 的租约纪律）。
 * ⚠ v1 只支持「全取」（DeliveryQueue.lease 按 enqueue 序返回全部 pending）——
 * pi 的 `one-at-a-time` 模式需要队列侧部分释放能力，超出当前 DeliveryQueue API。
 * ⚠ ack 在 getter 内完成：loop 保证同迭代内 drain（见 agentLoop.ts 轮询点注释）；
 * 若恰在 poll 与 drain 之间 abort，至多丢一批已插话（与 legacy lease→append 同窗同风险）。
 */
function makeSteeringGetter(
	host: IPiKernelHost,
	agentId: string,
	queue: DeliveryQueue,
	leaseId: string,
): () => Promise<readonly AgentMessage[]> {
	return async () => {
		const items = queue.lease(agentId, leaseId);
		if (items.length === 0) { return []; }
		try {
			const messages = items.map(item => ({ role: 'user', content: item.content, timestamp: Date.now() } as AgentMessage));
			queue.ack(items.map(i => i.id));
			host._logService.info(`[PiKernel] Steering: injected ${items.length} message(s) (ids=${items.map(i => i.id).join(',')})`);
			return messages;
		} catch (err) {
			queue.release(leaseId);
			host._logService.warn(`[PiKernel] Steering injection failed, lease released for retry: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	};
}
