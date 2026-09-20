/*---------------------------------------------------------------------------------------------
 *  Unified SubAgent Dispatch
 *
 *  Unifies the three previous dispatch paths into a single coherent architecture:
 *  1. SubAgentManager (common/) — lightweight budget-aware execution
 *  2. TaskOrchestrationService (browser/) — DAG-based orchestration
 *  3. delegate_task tool — LLM autonomous delegation (was a stub)
 *
 *  Design principles (inspired by OpenCode):
 *  - SubAgentType determines tool permissions (explore=readonly, general=readwrite, scout=external)
 *  - IterationBudget from SubAgentManager is retained for resource control
 *  - TaskOrchestrationService delegates actual execution here
 *  - delegate_task tool routes through TaskOrchestrationService.createPlan()
 *
 *  Execution model (Effect-TS-style, see ./effectRuntime.ts):
 *  - Each sub-agent runs as a forked Fiber with a per-instance InterruptSignal
 *    (created in createSubAgent, so interruptSubAgent works pre/post start).
 *  - Timeout / retry / parallel fan-out use the timeout / retry / forEachPar
 *    combinators instead of hand-rolled Promise.race + retry maps + batching.
 *  - Watchdog disposal and parent-abort unlistening are Scope finalizers —
 *    deterministic cleanup, no manual finally blocks, no dangling timers.
 *
 *  拆分进度（A3 同款策略，2026-09-20）：声明族已拆出 —— subAgentModel.ts（类型/权限/标签/
 *  隔离档/预览）、subAgentLifecycle.ts（实例/事件/退出原因/超时错误），本文件以 `export *`
 *  转出（调用点零改动）。**下一阶段**（未做，需专门评估）：类内部还聚合了 prompt 组装、
 *  结果格式化、看门狗/预算派生、并行扇出四簇 —— 建议按 `_buildSystemPrompt`/`_buildMessages`、
 *  `gateResult` 装配、`StallWatchdog` 接线、`forEachPar` 扇出四刀切，各刀独立可回退。
 *--------------------------------------------------------------------------------------------*/

import { IterationBudget } from './iterationBudget.js';
import { fork, retry, timeout, forEachPar, FiberInterrupt, InterruptSignal, isFiberInterrupt, type FiberExit, type IFiberContext } from './effectRuntime.js';
import type { IAgentTurnRequest, IChatStreamDelta } from './providers.js';
import { SubagentTokenCollector } from './subagentTokenCollector.js';
import { gateResult } from './completionGate.js';
import { decideTaskGate, MAX_TASK_GATE_SUBAGENT_REACT, type IIncompleteTask, type TaskGateDecision } from './taskGate.js';
import { StallWatchdog } from './stallWatchdog.js';
import { defaultPostStopDecision } from './subAgentHooks.js';

import { createWriteExclusionLock, hasWriteCapability, WriteLockAbortedError, type IWriteExclusionLock } from './writeExclusion.js';
// ─── 声明块已拆出（A3 同款策略，2026-09-20）：本文件只留 UnifiedSubAgentDispatch 类 ──────
// 声明族见 subAgentModel.ts（类型/权限/标签/隔离/预览）与 subAgentLifecycle.ts
// （实例/事件/退出原因/超时错误）。以 `export *` 转出 ⇒ 调用点零改动；
// 同时显式 import 本类自身用到的符号（`export *` 不建立本地绑定）。
import {
	_EXPLORE_REAL_TOOLS,
	previewStructured,
	SUB_AGENT_PERMISSIONS,
	SubAgentType,
} from './subAgentModel.js';
import {
	_matchesRequiredKeys,
	_STALL_CONTENT_DELTA_TYPES,
	_STALL_SUMMARY_PROMPT,
	_tryParseJsonObject,
	SUBAGENT_SOFT_BUDGET_RATIO,
	SubAgentEventType,
	SubAgentTimeoutError,
} from './subAgentLifecycle.js';
import type {
	_AttemptControl,
	_BoundEmit,
	_ExecResult,
	_ProgramResult,
	SubAgentEventSink,
	SubAgentExitReason,
	SubAgentInstance,
	SubAgentLifecycleEvent,
	SubAgentOptions,
	SubAgentResult,
	SubAgentStatusReport,
	SubAgentToolTraceEntry,
} from './subAgentLifecycle.js';
export * from './subAgentModel.js';
export * from './subAgentLifecycle.js';
// 第二刀（2026-09-20）：零 `this` 依赖的纯逻辑已搬出（判定依据 = 实测各方法体内 `this.` 计数为 0）
import { buildSubAgentGateContext, buildSubAgentMessages, buildSubAgentSystemPrompt, extractModifiedFile, formatBytes, isToolAllowedForType } from './subAgentPureHelpers.js';

// ─── Unified SubAgent Dispatch ────────────────────────────────────────────

/**
 * UnifiedSubAgentDispatch — the single entry point for all sub-agent operations.
 *
 * Replaces the three previous paths:
 * - SubAgentManager → now a thin wrapper delegating here
 * - TaskOrchestrationService._executeTask() → delegates execution here
 * - delegate_task tool → routes through TaskOrchestrationService which uses this
 *
 * Key improvements over previous SubAgentManager:
 * 1. SubAgentType-based permission profiles (like OpenCode)
 * 2. Context injection (repo_overview, upstream results)
 * 3. Background execution support
 * 4. Permission-aware tool filtering
 */
export class UnifiedSubAgentDispatch {
	/** 回答语言设置（sessions.agentStudio.preferences.responseLanguage），由调用方注入；undefined → 'auto'。 */
	public responseLanguageSetting?: string;
	/** 显示语言设置（sessions.agentStudio.preferences.language），undefined → 'zh-CN'；'auto' 以此为回退，不探测操作系统语言。 */
	public languageSetting?: string;

	private readonly _activeSubAgents = new Map<string, SubAgentInstance>();
	private readonly _parentBudget: IterationBudget;
	private readonly _maxConcurrent: number;
	private readonly _maxSpawnDepth: number;
	/** 内容停滞阈值 (ms)：模型流内超过此时长无任何内容级 delta → 判停滞。 */
	private _stallTimeoutMs: number;
	/**
	 * P2d: 可选的异步 task 查询回调（完成门 DB 真相）。由调用方（agentOSService）
	 * 注入具体实现 —— 查 IAgentTaskBoardService 的非终态任务（triage/todo/ready/running，
	 * 排除 blocked）并按 owner 过滤。undefined → 退化为现状（不查 DB，gateResult 仅靠
	 * 输出标记推断）。对齐 MiMo-Code TaskGate（在 actor/spawn.ts 调用层查 DB）。
	 */
	private readonly _taskLookup?: (input: { ownerAgentId: string; parentSessionId?: string }) => Promise<readonly IIncompleteTask[]>;
	/** Optional logger for sub-agent stream diagnostics (heartbeat / DELTA GAP / handover). */
	private _log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
	/**
	 * Per-instance InterruptSignal (Effect model: cooperative cancellation).
	 * Created in createSubAgent so interruptSubAgent() works whether the
	 * sub-agent is pending or already running — a pre-start interrupt persists
	 * and the fiber observes it as soon as execution begins (replaces the old
	 * `_interruptedSubAgents` Set). Stall state is per-attempt local state now
	 * (replaces `_stalledSubAgents`); retries use the retry() combinator
	 * (replaces `_subagentRetryMap`).
	 */
	private readonly _interruptSignals = new Map<string, InterruptSignal>();

	// ─── Global registry (inspired by Hermes _active_subagents) ───────
	/**
	 * Static registry of all active UnifiedSubAgentDispatch instances,
	 * keyed by workspace/session ID. This enables cross-dispatch queries
	 * and UI integration (TaskBoard can enumerate all running sub-agents).
	 *
	 * Inspired by Hermes-Agent's module-level `_active_subagents` dict
	 * which supports TUI queries and interrupt propagation.
	 */
	private static readonly _globalRegistry = new Map<string, UnifiedSubAgentDispatch>();

	/** Register this dispatch instance in the global registry. */
	registerGlobal(sessionId: string): void {
		UnifiedSubAgentDispatch._globalRegistry.set(sessionId, this);
	}

	/** Unregister this dispatch instance from the global registry. */
	unregisterGlobal(sessionId: string): void {
		UnifiedSubAgentDispatch._globalRegistry.delete(sessionId);
	}

	/**
	 * Look up a sub-agent across all dispatch instances.
	 * Useful for UI (TaskBoard) or interrupt propagation across sessions.
	 */
	static findSubAgentGlobal(subAgentId: string): SubAgentInstance | undefined {
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			const agent = dispatch._activeSubAgents.get(subAgentId);
			if (agent) { return agent; }
		}
		return undefined;
	}

	/**
	 * Interrupt a sub-agent by ID across all dispatch instances.
	 * Inspired by Hermes interrupt_subagent() which uses module-level lookup.
	 */
	static interruptSubAgentGlobal(subAgentId: string): boolean {
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			if (dispatch._activeSubAgents.has(subAgentId)) {
				return dispatch.interruptSubAgent(subAgentId);
			}
		}
		return false;
	}

	/**
	 * Get all running sub-agents across all sessions.
	 * Useful for TaskBoard to show global sub-agent status.
	 */
	static getAllRunningGlobal(): SubAgentStatusReport[] {
		const results: SubAgentStatusReport[] = [];
		for (const dispatch of UnifiedSubAgentDispatch._globalRegistry.values()) {
			results.push(...dispatch.getAllSubAgents());
		}
		return results;
	}

	constructor(
		parentBudget?: IterationBudget,
		maxConcurrent: number = 3,
		maxSpawnDepth: number = 1,  // P0: 禁止 subagent 嵌套（root depth=0, subagent depth=1≥1 → 抛异常）
		// 停滞超时（2026-07-26 MiMo 对齐重构）：模型流期间内容级 delta 计活
		// （text/thinking/tool_*），工具执行窗口看门狗暂停（toolExecutionGuard
		// 兜底）；「阈值内无任何内容产出」才判停滞。单响应软上限见
		// responseSoftCapMs。旧语义「仅工具活动计活」已废弃（误杀长答案与
		// 嵌套委派等待，事故 1785037741973）。
		stallTimeoutMs: number = 180_000,
		/** P2d: 可选异步 task 查询回调（完成门 DB 真相）。 */
		taskLookup?: (input: { ownerAgentId: string; parentSessionId?: string }) => Promise<readonly IIncompleteTask[]>,
	) {
		this._parentBudget = parentBudget || new IterationBudget(90);
		this._maxConcurrent = maxConcurrent;
		this._maxSpawnDepth = maxSpawnDepth;
		this._stallTimeoutMs = stallTimeoutMs;
		this._taskLookup = taskLookup;
	}

	/** Inject a logger for sub-agent stream diagnostics (heartbeat / DELTA GAP / handover). */
	public setLogger(log: (level: 'info' | 'warn' | 'error', msg: string) => void): void {
		this._log = log;
	}

	// ─── 写冲突互斥（P0②，2026-09-11）───────────────────────────────────────
	/**
	 * 可写子代理的串行化闸门。
	 *
	 * 为什么放在**调度层**而不是画布 planner：画布并行层 / 脚本 `parallel()` / swarm
	 * workers / `delegate_task` 全部经 `executeSubAgent` 执行 → 一处加锁覆盖所有路径；
	 * 且画布侧拿不到 agent 的工具面（`Saros.Agent` 节点只有 `agentId`，webview 不认识
	 * 内置 agent 的 `tools`），无法自行判定写能力。
	 *
	 * 只读子代理（Explore/Scout，或工具面里没有写工具的 General）**完全不占锁**
	 * → 并行探索这个主用法零回归。
	 */
	private readonly _writeLock: IWriteExclusionLock = createWriteExclusionLock();

	/** 写互斥诊断快照（日志 / TaskBoard 观测「为什么变慢了」）。 */
	getWriteLockStats() {
		return this._writeLock.stats();
	}

	/**
	 * 该子代理是否**可能写**（保守方向：宁可串行，不可写冲突）。
	 * 判定优先级见 `hasWriteCapability`：显式工具面 > 权限档 > 类型兜底。
	 */
	private _isWriteCapableSubAgent(subAgent: SubAgentInstance): boolean {
		const perms = SUB_AGENT_PERMISSIONS[subAgent.type];
		return hasWriteCapability({
			allowedTools: subAgent.options.allowedTools,
			excludedTools: this._effectiveExcludedTools(subAgent),
			canWrite: perms?.canWrite,
			canExecute: perms?.canExecute,
			type: subAgent.type,
		});
	}

	// ─── delegate_task 子代理会话复用（2026-07-26 用户决策：
	// 「一个 subagent 执行完毕所有任务」——后续单任务委派 follow-up 续跑，
	// 不再每次新起冷启动子代理）─────────────────────────────────────────

	/** 最近完成的单任务子代理索引：`${parentAgentId}::${type}` → {subAgentId, completedAt}。 */
	private readonly _reusableSubAgents = new Map<string, { subAgentId: string; completedAt: number }>();

	/** 复用窗口（默认 15 分钟；同轮连续委派间隔实测 ~3 分钟）。测试可改写。 */
	public reuseWindowMs = 15 * 60_000;

	/**
	 * 单响应软上限（默认 480s，对齐 MiMo-Code chunkTimeout）：连续模型响应段
	 * （两次工具边界之间的内容流）超此上限 → 判停滞中止。防「空谈永动」；
	 * 健康长答案（实测 80s 级）充分放行。测试可改写。
	 */
	public responseSoftCapMs = 480_000;

	/**
	 * 查找可复用的子代理：同父 agent + 同类型 + 窗口内完成 + 实例未在运行。
	 * 复用其会话（sessionId=subAgent.id 不变 → 网关 previous_response_id 链式
	 * 衔接，子代理保留全部探索上下文，避免冷启动 + 上下文丢失）。
	 */
	findReusableSubAgent(parentAgentId: string, type: SubAgentType): SubAgentInstance | undefined {
		const key = `${parentAgentId}::${type}`;
		const rec = this._reusableSubAgents.get(key);
		if (!rec) { return undefined; }
		if (Date.now() - rec.completedAt > this.reuseWindowMs) {
			this._reusableSubAgents.delete(key);
			return undefined;
		}
		const subAgent = this._activeSubAgents.get(rec.subAgentId);
		if (!subAgent || subAgent.status === 'running' || subAgent.status === 'pending') {
			return undefined;
		}
		return subAgent;
	}

	/** 完成时登记可复用（done/error 均登记——会话上下文仍有价值）。 */
	private _markReusable(subAgent: SubAgentInstance): void {
		this._reusableSubAgents.set(`${subAgent.parentAgentId}::${subAgent.type}`, {
			subAgentId: subAgent.id,
			completedAt: Date.now(),
		});
	}

	/**
	 * Follow-up 续跑：复用既有子代理会话执行新任务。
	 * 与新建的本质差异：sessionId（=subAgent.id）不变 → 网关把请求当同一会话
	 * 续轮（previous_response_id 链式衔接），子代理带着此前全部探索上下文
	 * 继续工作；消息层只发增量（新任务），卡片经 Spawned 事件自然重置过程数据。
	 */
	async dispatchFollowUp(
		subAgentId: string,
		newTask: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		eventSink?: SubAgentEventSink,
		abortSignal?: AbortSignal,
	): Promise<SubAgentResult> {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) {
			throw new Error(`dispatchFollowUp: sub-agent ${subAgentId} not found`);
		}
		this._log?.('info', `[FollowUp] reusing ${subAgentId} for new task: ${newTask.slice(0, 60)}`);
		// 重置生命周期：executeSubAgent 要求 pending 起始态；旧 result 清除，
		// 会话（sessionId/budget/depth 链）保留不变。task 为 readonly，经可变视图更新。
		(subAgent as { task: string }).task = newTask;
		subAgent.status = 'pending';
		subAgent.result = undefined;
		return this.executeSubAgent(subAgent.id, executeFn, eventSink, undefined, abortSignal);
	}

	/** 获取当前配置（供 delegate_task 动态描述使用） */
	getConfig() {
		return {
			maxConcurrent: this._maxConcurrent,
			maxSpawnDepth: this._maxSpawnDepth,
		};
	}

	/**
	 * 计算子代理的最终 excludedTools：用户显式排除 + 对所有子代理隐藏编排工具。
	 * 2026-07-26 用户模型「一个 subagent 执行完毕所有任务」：委派是主代理专属
	 * 能力（后续任务走 follow-up 会话复用续跑同一子代理），子代理（depth≥1）
	 * 不应再嵌套委派——线上事故 1785037741973：explore 子代理受提示词中
	 * 「PARALLEL WORK GOES THROUGH SUB-AGENTS」段落诱导，递归发出 6 个
	 * delegate_task，父代理阻塞等待 depth-2 子代理期间被看门狗误杀。
	 * 从工具面直接隐藏（而非仅靠提示词约束），杜绝该事故链。
	 */
	private _effectiveExcludedTools(subAgent: SubAgentInstance): readonly string[] | undefined {
		const base = subAgent.options.excludedTools;
		const depth = this._getAgentDepth(subAgent.id);
		if (depth >= 1) {
			const orchestration = ['delegate_task', 'plan_explore', 'subagent_batch'];
			return base ? [...new Set([...base, ...orchestration])] : orchestration;
		}
		return base;
	}

	/**
	 * 计算指定 agent 的深度（从 root 到该 agent 的层数，root = 0）
	 */
	private _getAgentDepth(agentId: string): number {
		let depth = 0;
		let currentId: string | undefined = agentId;

		while (currentId) {
			const agent = this._activeSubAgents.get(currentId);
			if (!agent) {
				// Reached root agent (not in _activeSubAgents)
				break;
			}
			depth++;
			currentId = agent.parentAgentId;
		}

		return depth;
	}

	/**
	 * Create a sub-agent instance.
	 * Does NOT start execution — call executeSubAgent() separately.
	 */
	createSubAgent(
		parentAgentId: string,
		task: string,
		options?: SubAgentOptions,
	): string {
		// Check spawn depth limit
		const parentDepth = this._getAgentDepth(parentAgentId);
		if (parentDepth >= this._maxSpawnDepth) {
			throw new Error(`Cannot spawn sub-agent: maximum spawn depth (${this._maxSpawnDepth}) reached. Parent agent depth: ${parentDepth}`);
		}

		const subAgentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
		const type = options?.type ?? SubAgentType.General;
		// 子代理不限轮数（2026-07-25 用户决策）：默认独立大额预算，工具消耗只记账
		// 不熔断；唯一时间约束是「工具活动 180s 超时」（StallWatchdog）。
		// 显式 options.maxIterations 仍生效（测试/特殊场景）。注意不能用
		// createChildBudget——它会按父预算剩余 60% 钳制（90 → 54 次，曾致
		// max_iterations 误杀，产出全丢）。
		const budget = options?.maxIterations !== undefined
			? this._parentBudget.createChildBudget(options.maxIterations)
			: new IterationBudget(1_000_000);
		const isolationLevel = options?.isolationLevel ?? 'subagent';

		const subAgent: SubAgentInstance = {
			id: subAgentId,
			parentAgentId,
			type,
			isolationLevel,
			task,
			status: 'pending',
			budget,
			createdAt: Date.now(),
			// 总时长上限（2026-07-26 规则变更：要求限时，MiMo 对齐）：默认 600s
			// = MiMo actor 工具 timeout_ms 默认值。关键语义差异（对齐 MiMo
			// 「timeout 状态照交结果」）：超时**不是失败**——在 _executeWithBudget
			// 的 delta 检查点走 stalled/salvage 路径，保留产出 + P1 禁工具总结；
			// 仅「完全零 delta 挂起」的极端场景才由 timeout() 组合器硬杀
			// （此时本无产出可保，failure 可接受）。
			timeout: options?.timeout ?? 600_000,
			priority: options?.priority ?? 'medium',
			options: options ?? {},
			result: undefined,
			tokenCollector: new SubagentTokenCollector(),
		};

		this._activeSubAgents.set(subAgentId, subAgent);
		// Effect model: the per-instance InterruptSignal exists from creation, so
		// interruptSubAgent() marks the instance even before its fiber starts.
		this._interruptSignals.set(subAgentId, new InterruptSignal());
		return subAgentId;
	}

	/**
	 * Execute a previously created sub-agent.
	 * The executeFn is provided by the caller (typically AgentOSService).
	 *
	 * @param eventSink Optional sink receiving start/progress/end lifecycle events.
	 *                  This is the channel that drives the WebView SubAgentCard.
	 * @param groupId   Optional group id to cluster parallel sub-agents into one card.
	 */
	async executeSubAgent(
		subAgentId: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		eventSink?: SubAgentEventSink,
		groupId?: string,
		/** P3: 父→子取消传播。传入父 turn 的 AbortSignal；abort 时自动 interrupt 本子 agent（递归取消子代）。 */
		abortSignal?: AbortSignal,
	): Promise<SubAgentResult> {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) {
			throw new Error(`SubAgent ${subAgentId} not found`);
		}

		if (subAgent.status !== 'pending') {
			throw new Error(`SubAgent ${subAgentId} is not in pending state (current: ${subAgent.status})`);
		}

		// P2b + P3: 父→子取消传播仅对 subagent 档生效。
		// peer 档为对等独立 agent,父 turn 的 abort 不应级联取消它 (其生命周期独立,
		// 只有显式 interruptSubAgent / swarm.cancelSwarm 才能停)。故 peer 档把父
		// abortSignal 降级为 undefined —— 不桥接到 fiber 的 InterruptSignal。
		const effectiveAbortSignal = (subAgent.options.isolationLevel === 'peer')
			? undefined
			: abortSignal;

		// ★ 写冲突互斥（P0②，2026-09-11）：可写子代理执行前先取写锁，只读者直通。
		//   子代理共享父 worktree 且无隔离档 → 两个可写子代理并发 = 必然互相覆盖。
		//   取锁在 `status='running'` / Spawned 事件**之前**：① 卡片不会显示「运行中」的假象
		//   ② 排队时间不计入 subAgent.timeout / durationMs（排队不是它的执行时间）。
		let releaseWriteLock: (() => void) | undefined;
		if (this._isWriteCapableSubAgent(subAgent)) {
			try {
				releaseWriteLock = await this._writeLock.acquire({
					owner: subAgent.id,
					signal: effectiveAbortSignal,
					onWait: ahead => this._log?.('info',
						`[WriteLock] ${subAgent.id} queued behind ${ahead} writer(s) — 可写子代理串行化（共享 worktree，防写冲突）`),
				});
			} catch (error) {
				if (error instanceof WriteLockAbortedError) {
					// 排队期间父 turn 被取消 → 不启动执行（不占 token、不写文件），按「被中断」收尾。
					subAgent.status = 'cancelled';
					subAgent.result = {
						success: false,
						error: 'Interrupted while waiting for the write lock',
						completedAt: Date.now(),
						durationMs: 0,
						tokenUsage: subAgent.tokenCollector.getUsage(),
						exitReason: 'interrupted',
					};
					return subAgent.result;
				}
				throw error;
			}
		}

		subAgent.status = 'running';
		const startedAt = Date.now();

		// Effect model: per-instance InterruptSignal（createSubAgent 时创建）。
		// interruptSubAgent() 在 pending/running 任意时刻调用都有效；信号是粘性的，
		// pre-start interrupt 会在 fiber 启动后的第一个中断点生效。
		const signal = this._interruptSignals.get(subAgentId) ?? new InterruptSignal();
		this._interruptSignals.set(subAgentId, signal);

		// Emit spawned event — sub-agent has been created and is about to run.
		this._emit(eventSink, {
			type: SubAgentEventType.Spawned,
			subAgentId: subAgent.id,
			subAgentType: subAgent.type,
			task: subAgent.task,
			parentId: subAgent.parentAgentId,
			timestamp: startedAt,
			groupId,
		});

		try {
			// Build the request with context injection
			const messages = buildSubAgentMessages(subAgent);

			const request: IAgentTurnRequest = {
				agentId: subAgent.id,
				// P0: 每个 subagent 必须有唯一 sessionId。
				// 否则 request.sessionId 为 undefined → agentOSService._getOrCreateConversationId
				// 把所有 subagent 归到 '__nosession__' 桶、复用同一个 conversationId，
				// 而该 conversationId 即网关的 X-Conversation-Id（extension.ts:1279），
				// previous_response_id 也按同一 key 复用（agentOSService.ts:243）。
				// 多个并行 subagent 共享同一 X-Conversation-Id → 网关把它们当成同一服务端
				// 会话的并发续轮，复用父会话上下文，subagent 自己的 task 被忽略，
				// 只回开场白即被判 success（见 2026-07-23 日志 1784806388723）。
				// 用 subAgent.id（唯一且跨 retry 稳定）作为 sessionId，使每个 subagent
				// 拥有独立 conversationId / previous_response_id，且自身多轮链式衔接正常。
				sessionId: subAgent.id,
				messages,
				systemPrompt: this._buildSystemPrompt(subAgent),
				// v17: propagate the parent agent's worktree so the subagent's
				// tools (file_read, file_write, terminal_cmd, etc.) all run
				// inside the same worktree the parent was operating in.
				worktreePath: subAgent.options.worktreePath,
				// Stable ChatMode policy + mutable WorkMode permission ceiling.
				chatMode: subAgent.options.parentChatMode as 'craft' | 'plan' | 'ask' | undefined,
				workMode: subAgent.options.parentWorkMode,
				// v17: delegate_task may constrain the sub-agent's toolset scope
				// (e.g. an Explore sub-agent limited to ['core']) and/or pin a
				// specific model. Both flow through to agentOSService.
				toolsetsOverride: subAgent.options.toolsets,
				excludedTools: this._effectiveExcludedTools(subAgent),
				// agentId 驱动（2026-07-27）：内置 Agent 的 `tools` 作为白名单，使子代理可见工具
				// 忠实收敛到该 Agent 定义的工具面（与 toolsetsOverride/excludedTools 叠加取交集）。
				allowedTools: subAgent.options.allowedTools,
				modelOverride: subAgent.options.model,
				// 软预算：默认按 timeout×比例推导（显式 options.softDeadlineMs 优先）；
				// 主循环耗时超过即注入一次收尾提醒，引导子代理在硬超时前收敛产出。
				softDeadlineMs: subAgent.options.softDeadlineMs
					?? (subAgent.timeout > 0 ? Math.floor(subAgent.timeout * SUBAGENT_SOFT_BUDGET_RATIO) : undefined),
				// Fork 前缀缓存：子 agent 携带父级冻结 ForkContext，使其 (system+tools)
				// 前缀与父级对齐 → 请求构造端在该前缀边界打 cache 断点，命中父级 prompt cache。
				forkContext: subAgent.options.forkContext,
				// P1: 后台子 agent 标记 —— 使工具审批闸门（decideAskRouting）对该 turn
				// 走「继承父授权（非交互放行）」，而非弹交互确认阻塞父级 loop。
				// subAgent.type 的值即 SubAgentType 字符串（explore/general/scout）。
				subAgent: { type: subAgent.type, background: true, isolationLevel: subAgent.options.isolationLevel },
			};

			const emitWrapped: _BoundEmit = (event) =>
				this._emit(eventSink, {
					...event,
					subAgentId: subAgent.id,
					subAgentType: subAgent.type,
					task: subAgent.task,
					parentId: subAgent.parentAgentId,
					timestamp: Date.now(),
					groupId,
				});

			// ── Effect model: the whole lifecycle runs as a forked fiber ──
			// - fork: independent execution unit sharing the per-instance InterruptSignal
			// - the parent AbortSignal is bridged into the fiber (P3); unlinking the
			//   listener is a scope finalizer (no manual finally, no leaked listener)
			// - fiber.exit never rejects; the exit is mapped to a SubAgentResult below
			const fiber = fork(async (ctx) => {
				ctx.scope.addFinalizer(ctx.signal.linkAbortSignal(effectiveAbortSignal, 'parent'));
				return this._executeSubAgentProgram(ctx, subAgent, executeFn, request, emitWrapped);
			}, { signal });

			const exit = await fiber.exit;
			return this._settleSubAgentResult(subAgent, exit, eventSink, groupId, startedAt);

		} catch (error) {
			// Defensive: only synchronous programming errors above land here
			// (message/prompt building, fork). The fiber program itself never
			// throws past fiber.exit — execution failures are failure exits.
			const errMsg = error instanceof Error ? error.message : String(error);
			subAgent.result = {
				success: false,
				error: errMsg,
				completedAt: Date.now(),
				durationMs: Date.now() - startedAt,
				tokenUsage: subAgent.tokenCollector.getUsage(),
				exitReason: 'error',
			};
			subAgent.status = 'error';
			this._emit(eventSink, {
				type: SubAgentEventType.Failed,
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				timestamp: Date.now(),
				error: errMsg,
				durationMs: Date.now() - startedAt,
				exitReason: 'error',
				groupId,
			});
			return subAgent.result;
		} finally {
			// ★ 写互斥锁必须在**所有**终态路径释放（正常/失败/取消/超时/异常）——
			//   漏释放会让后续所有可写子代理永久排队。release 本身幂等。
			releaseWriteLock?.();
		}
	}

	/**
	 * The retryable sub-agent program (Effect model): one attempt = one bounded
	 * execution + completion gates, inside a per-attempt child scope.
	 *
	 * - Retry uses the retry() combinator (Schedule.recurs(1)) — replaces the old
	 *   `_subagentRetryMap`. The retried unit is re-invoked from scratch, fixing
	 *   the old hand-rolled retry which rebuilt the request WITHOUT forkContext /
	 *   toolsetsOverride / modelOverride and never emitted Completed/Failed events.
	 * - The stall watchdog is attempt-local state owned by the attempt scope
	 *   (auto-disposed) — replaces the old `_stalledSubAgents` Set.
	 * - The hard timeout cap uses the timeout() combinator — its timer is always
	 *   cleared when the race settles (the old Promise.race leaked the timer).
	 * - Interruption unwinds via FiberInterrupt (skips all gate re-entry on cancel).
	 */
	private async _executeSubAgentProgram(
		ctx: IFiberContext,
		subAgent: SubAgentInstance,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
		emitWrapped: _BoundEmit,
	): Promise<_ProgramResult> {
		return retry(async () => ctx.scope.use(async (attemptScope) => {
			// Per-attempt stall state + watchdog (MiMo T40).
			let stalled = false;
			const watchdog = new StallWatchdog({
				idleTimeoutMs: this._stallTimeoutMs,
				onStall: () => { stalled = true; },
			});
			attemptScope.addFinalizer(() => watchdog.dispose());
			const control: _AttemptControl = { watchdog, signal: ctx.signal, isStalled: () => stalled };

			// 总时长双层（2026-07-26 MiMo 对齐）：①循环内 wall-clock 检查（同值）——
			// 超时走 stalled/salvage（保产出+总结，主路径）；②timeout() 组合器
			// +1s 余量——竞态必须让①先触发（实测同值时组合器在下一 delta 到达前
			// 先杀，salvage 路径被旁路）；仅在限后 1s 内完全零 delta 的挂起场景
			// 才由组合器硬杀（无产出可保，failure 可接受）。
			const runOnce = (req: IAgentTurnRequest) => subAgent.timeout > 0
				? timeout(
					this._executeWithBudget(executeFn, req, subAgent.budget, subAgent.tokenCollector, emitWrapped, control, subAgent.timeout),
					subAgent.timeout + 1_000,
					() => new SubAgentTimeoutError(subAgent.timeout),
					ctx.signal,
				)
				: this._executeWithBudget(executeFn, req, subAgent.budget, subAgent.tokenCollector, emitWrapped, control, 0);

			// ── Main execution ──
			let execResult = await runOnce(request);
			// P3: 被取消时直接以 FiberInterrupt 展开（跳过所有门控复核，不对已取消的
			// 子 agent 空耗 token），由 fiber exit 统一映射为 cancelled 结果。
			if (execResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }

			// 全新看门狗的补充轮执行器（P1 停滞总结 / P3 结构化输出共用）。
			// attempt 级 stalled 标志不可逆（tick 不清），任何补充轮都必须用全新
			// watchdog/control，否则首个 delta 检查即沿用旧停滞状态误判。
			const runFreshRound = async (req: IAgentTurnRequest): Promise<_ExecResult> => {
				let roundStalled = false;
				const roundWatchdog = new StallWatchdog({
					idleTimeoutMs: this._stallTimeoutMs,
					onStall: () => { roundStalled = true; },
				});
				attemptScope.addFinalizer(() => roundWatchdog.dispose());
				const roundControl: _AttemptControl = { watchdog: roundWatchdog, signal: ctx.signal, isStalled: () => roundStalled };
				return subAgent.timeout > 0
					? timeout(
						this._executeWithBudget(executeFn, req, subAgent.budget, subAgent.tokenCollector, emitWrapped, roundControl, subAgent.timeout),
						subAgent.timeout + 1_000, // 同 runOnce：+1s 余量让循环内 wall-clock salvage 先触发
						() => new SubAgentTimeoutError(subAgent.timeout),
						ctx.signal,
					)
					: this._executeWithBudget(executeFn, req, subAgent.budget, subAgent.tokenCollector, emitWrapped, roundControl, 0);
			};

			// ── P1: 停滞时「禁工具强制总结」（2026-07-26，对齐 MiMo max-steps）──
			// 旧行为：停滞 → output=原始片段+静态 [部分完成] 头。新行为：若有有效工具
			// 产出（与 salvage 同资格），先用同一 session 复跑一轮禁工具总结
			// （excludedTools:['*']，对齐 MiMo toolChoice:"none"），让模型自己梳理
			// 「已完成/未完成/建议」作为交接正文；总结轮也失败（模型真死/再停滞）
			// → 回退原始片段。salvage 头仍在 settle 路径统一添加（见 _settleSubAgentResult）。
			if (execResult.stalled && execResult.toolTrace.some(t => t.status === 'ok')) {
				try {
					const summaryResult = await runFreshRound({
						...request,
						messages: [...request.messages, { role: 'user', content: _STALL_SUMMARY_PROMPT }],
						excludedTools: ['*'],
					});
					if (summaryResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }
					if (!summaryResult.stalled && summaryResult.output.trim().length > 0) {
						execResult = {
							...execResult,
							output: summaryResult.output,
							// 保留原 toolTrace/filesModified/stalled：停滞事实与打捞轨迹不变
						};
					}
				} catch (summaryErr) {
					if (summaryErr instanceof FiberInterrupt) { throw summaryErr; }
					// 总结轮失败（模型真死/超时）——best effort，回退原始片段
					this._log?.('warn', `[SubAgent] stall summary round failed, falling back to raw partial output: ${summaryErr}`);
				}
			}

			// ── Completion Gate (MiMo TaskGate) ──
			// P2d: 首轮 gateResult 注入 DB 真相（若有 taskLookup）。无 taskLookup → undefined，退化为现状。
			const firstIncomplete = await this._queryIncompleteTasks(subAgent);
			let structured = gateResult(execResult.output, buildSubAgentGateContext(subAgent, execResult, firstIncomplete?.map(t => t.id)));

			// ── postStop self-verification round (MiMo preStop/postStop ReAct) ──
			const postStop = subAgent.options.postStop;
			const maxRounds = postStop?.maxRounds ?? 1;
			let postStopRound = 0;
			while (postStop && postStopRound < maxRounds) {
				const decision = defaultPostStopDecision({ structured }, postStopRound, maxRounds);
				if (decision.kind === 'return') { break; }
				execResult = await runOnce({
					...request,
					messages: [...request.messages, { role: 'user', content: decision.followUpMessage }],
				});
				if (execResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }
				const postStopIncomplete = await this._queryIncompleteTasks(subAgent);
				structured = gateResult(execResult.output, buildSubAgentGateContext(subAgent, execResult, postStopIncomplete?.map(t => t.id)));
				postStopRound++;
			}

			// ── P2d: TaskGate ReAct (DB-truth completion gate, MiMo-Code task/gate.ts) ──
			// cap=MAX_TASK_GATE_SUBAGENT_REACT(2)，对齐 MiMo-Code。失败开放（_queryIncompleteTasks
			// 内 catch → undefined → break，DB 错误不困住 agent）。
			let taskGateRound = 0;
			while (this._taskLookup && taskGateRound < MAX_TASK_GATE_SUBAGENT_REACT) {
				const incomplete = await this._queryIncompleteTasks(subAgent);
				if (!incomplete || incomplete.length === 0) { break; }
				const gateDecision: TaskGateDecision = decideTaskGate({
					incompleteTasks: incomplete,
					reactCount: taskGateRound,
					maxReact: MAX_TASK_GATE_SUBAGENT_REACT,
					mode: 'subagent',
				});
				if (!gateDecision.needReentry) { break; }
				execResult = await runOnce({
					...request,
					messages: [...request.messages, { role: 'user', content: gateDecision.reentryText }],
				});
				if (execResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }
				structured = gateResult(execResult.output, buildSubAgentGateContext(subAgent, execResult, incomplete.map(t => t.id)));
				taskGateRound++;
			}

			// ── P3: output_schema 结构化交接（2026-07-26，对齐 MiMo output_schema）──
			// 主执行正常结束（未停滞）且委派方指定 outputSchema 时，追加禁工具结构化轮：
			// 要求模型把最终结论整理为符合 schema 的 JSON 对象；轻量校验（可解析 +
			// schema.required 键齐全），不合格重试 1 次；成功则 output=序列化对象，
			// 失败回退自由文本（best effort，不硬失败）。
			if (subAgent.options.outputSchema && !execResult.stalled) {
				const schemaText = JSON.stringify(subAgent.options.outputSchema);
				for (let schemaAttempt = 0; schemaAttempt < 2; schemaAttempt++) {
					try {
						const prompt = schemaAttempt === 0
							? `请把最终结论整理为符合以下 JSON Schema 的 JSON 对象并输出。禁止调用任何工具；只输出 JSON 对象本体，不要输出其他文字或 markdown 代码块：\n${schemaText}`
							: `上次输出不符合要求。请只输出符合以下 JSON Schema 的 JSON 对象本体（不要输出其他文字，不要用 markdown 代码块包裹）：\n${schemaText}`;
						const schemaResult = await runFreshRound({
							...request,
							messages: [...request.messages, { role: 'user', content: prompt }],
							excludedTools: ['*'],
						});
						if (schemaResult.interrupted) { throw new FiberInterrupt(ctx.signal.reason ?? 'user'); }
						if (schemaResult.stalled) { continue; }
						const parsed = _tryParseJsonObject(schemaResult.output);
						if (parsed && _matchesRequiredKeys(parsed, subAgent.options.outputSchema)) {
							execResult = { ...execResult, output: JSON.stringify(parsed) };
							break;
						}
					} catch (schemaErr) {
						if (schemaErr instanceof FiberInterrupt) { throw schemaErr; }
						this._log?.('warn', `[SubAgent] output_schema round ${schemaAttempt + 1} failed: ${schemaErr}`);
					}
				}
			}

			return { execResult, structured };
		}), {
			times: 1,
			// 仅重试非超时的瞬态失败；中断/超时/已取消信号不重试（对齐旧语义）。
			shouldRetry: (error) => !isFiberInterrupt(error) && !(error instanceof SubAgentTimeoutError) && !ctx.signal.interrupted,
			onRetry: (error) => {
				const errMsg = error instanceof Error ? error.message : String(error);
				const retryErrorMsg = errMsg.length > 100 ? errMsg.slice(0, 100) + '…' : errMsg;
				emitWrapped({
					type: SubAgentEventType.Progress,
					progressNote: `🔄 自动重试 (1/1): ${retryErrorMsg}`,
				});
			},
		});
	}

	/**
	 * Maps a fiber exit to the SubAgentResult contract (never throws):
	 * - interrupt → cancelled result + Interrupted event
	 * - failure   → error result + Failed event (timeout cap → exitReason 'timeout')
	 * - success   → Completion-Gate verdict applied + Completed event
	 */
	private _settleSubAgentResult(
		subAgent: SubAgentInstance,
		exit: FiberExit<_ProgramResult>,
		eventSink: SubAgentEventSink | undefined,
		groupId: string | undefined,
		startedAt: number,
	): SubAgentResult {
		const completedAt = Date.now();
		const durationMs = completedAt - startedAt;

		// P3: 被父级/用户取消 → 标记为 cancelled（不落入 success 路径，
		// 避免把已中断的子 agent 误报为成功，也不覆盖 interruptSubAgent 设置的 status）。
		if (exit._tag === 'interrupt') {
			subAgent.status = 'cancelled';
			subAgent.result = {
				success: false,
				error: 'Interrupted by user or parent agent',
				completedAt,
				durationMs,
				tokenUsage: subAgent.tokenCollector.getUsage(),
				exitReason: 'interrupted',
			};
			this._emit(eventSink, {
				type: SubAgentEventType.Interrupted,
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				timestamp: completedAt,
				error: 'Interrupted by user or parent agent',
				durationMs,
				exitReason: 'interrupted',
				groupId,
			});
			return subAgent.result;
		}

		if (exit._tag === 'failure') {
			const error = exit.error;
			const errMsg = error instanceof Error ? error.message : String(error);
			const exitReason: SubAgentExitReason = error instanceof SubAgentTimeoutError ? 'timeout' : 'error';
			subAgent.result = {
				success: false,
				error: errMsg,
				completedAt,
				durationMs,
				tokenUsage: subAgent.tokenCollector.getUsage(),
				exitReason,
			};
			subAgent.status = 'error';
			// 异常失败同样登记会话复用（「一个 subagent 执行完毕所有任务」）：
			// 失败前的探索上下文仍在会话中，后续单任务 delegate_task follow-up
			// 续跑同一 sessionId，避免冷启动丢失上下文。interrupted 不登记——
			// 父 turn 已取消，不会再有后续委派。
			this._markReusable(subAgent);
			this._emit(eventSink, {
				type: SubAgentEventType.Failed,
				subAgentId: subAgent.id,
				subAgentType: subAgent.type,
				task: subAgent.task,
				parentId: subAgent.parentAgentId,
				timestamp: completedAt,
				error: errMsg,
				durationMs,
				exitReason,
				groupId,
			});
			return subAgent.result;
		}

		// ── Success path: apply the Completion Gate verdict ──
		const { execResult, structured } = exit.value;
		// Determine exit reason (idle stall → timeout)
		const exitReason: SubAgentExitReason = execResult.stalled
			? 'timeout'
			: (execResult.budgetExhausted ? 'max_iterations' : 'completed');

		const gateSuccess = exitReason === 'completed' && (!structured || structured.status === 'success');
		// ── Salvage（优雅收尾）：停滞超时/预算耗尽但已有真实探索产出时，
		// 降级为「部分成功」——output 透传给父代理。formatDelegationResult 对
		// failed 只透传 error，会把 N 轮迭代收集的发现全盘丢弃（2026-07-25 线上：
		// 21 轮迭代 40+ 工具调用的结果被 exitReason 一句话否决）。
		const okToolCalls = execResult.toolTrace.filter(t => t.status === 'ok').length;
		// (b) 正常收尾但自报 partial/blocked（2026-07-27 线上：子代理跑满 15 轮、
		//     产出 9249 字符结构化发现，仅因诚实自报「部分假设与实际有出入」而被
		//     判 failed，result.output 被 formatDelegationResult 整个丢弃）。这类
		//     runs exitReason='completed'（既非 timeout 也非 max_iterations），此前
		//     不在 salvage 覆盖内 → success=false → 发现报告全盘蒸发。打捞条件：
		//     有真实工具产出 + 做了实质工作，保留 output、标 RESULT: partial（非 failed）。
		//     ⚠ 护栏：Explore 型必须**真正调用过探索工具**才打捞——否则 noRealExploration
		//     门控降级的「空洞 partial」（只调 index_repository 就交差）会被误打捞。
		//     真正的 failed（gate status==='failed' 或 errored）不打捞，仍透传 error。
		const usedRealExploration = execResult.toolTrace.some(t => _EXPLORE_REAL_TOOLS.has(t.toolName));
		const substantiveWork = subAgent.type === SubAgentType.Explore ? usedRealExploration : okToolCalls > 0;
		const completedPartial = exitReason === 'completed'
			&& !!structured
			&& (structured.status === 'partial' || structured.status === 'blocked')
			&& okToolCalls > 0
			&& substantiveWork;
		const salvageable = !gateSuccess
			&& (exitReason === 'timeout' || exitReason === 'max_iterations')
			&& okToolCalls > 0;
		const effectiveSuccess = gateSuccess || salvageable || completedPartial;
		const resultError = effectiveSuccess ? undefined : (
			structured
				? `Completion Gate: ${structured.status} — ${structured.reason}`
				: exitReason === 'timeout' ? 'Task timed out' : 'Task did not meet completion criteria'
		);
		subAgent.result = {
			success: effectiveSuccess,
			output: salvageable
				? `[部分完成 — ${exitReason === 'timeout' ? '模型响应停滞超时' : '预算/迭代耗尽'}，子代理未完成全部计划；以下为已获取的部分结果（${okToolCalls} 次工具调用）]\n\n${execResult.output}`
				: completedPartial
					? `[部分完成 — 子代理正常结束但自报 ${structured!.status}（如任务假设的文件/位置与实际有出入）；以下为已收集的发现（${okToolCalls} 次工具调用）]\n\n${execResult.output}`
					: execResult.output,
			error: resultError,
			completedAt,
			durationMs,
			apiCalls: execResult.apiCallCount,
			tokensUsed: execResult.tokensUsed,
			// ★ 2026-09-13：积分（与 tokensUsed 平行）。
			creditUsed: execResult.creditUsed,
			tokenUsage: subAgent.tokenCollector.getUsage(),
			// salvage 保留原 exitReason（父代理可见 partial 性质），gate 成功才归一 completed；
			// completedPartial 归一为 'partial'，让 formatDelegationResult 标 RESULT: partial。
			exitReason: gateSuccess ? 'completed' : (completedPartial ? 'partial' : exitReason),
			toolTrace: execResult.toolTrace,
			filesModified: execResult.filesModified.length > 0 ? execResult.filesModified : undefined,
			structured,
		};
		subAgent.status = effectiveSuccess ? 'done' : 'error';
		// 登记会话复用（done/error 均可被后续单任务 delegate_task follow-up 续跑）
		this._markReusable(subAgent);

		// P3：output_schema 结构化交接成功时，RESULT body 保持纯净 JSON——
		// 跳过 files-modified NOTE 与 COMPLETION GATE footer（对齐 MiMo
		// output_schema「schema requested ⇒ structured only, never prose」；
		// 校验：output 可解析为对象且 schema.required 键齐全）。
		const _cleanSchemaHandover = (() => {
			if (!subAgent.options.outputSchema) { return false; }
			const parsed = _tryParseJsonObject(subAgent.result.output ?? '');
			return !!parsed && _matchesRequiredKeys(parsed, subAgent.options.outputSchema);
		})();

		if (!_cleanSchemaHandover) {
			// ── File change coordination (inspired by Hermes file_state) ──
			// If the sub-agent modified files, append a warning to the output
			// so the parent agent knows to re-read those files.
			if (execResult.filesModified.length > 0) {
				const fileList = execResult.filesModified.join(', ');
				subAgent.result = {
					...subAgent.result,
					output: (subAgent.result.output ?? '') +
						`\n\n[NOTE: subagent modified files — re-read before editing: ${fileList}]`,
				};
			}
			// Append the Completion Gate verdict so the parent agent gets a reliable contract.
			subAgent.result = {
				...subAgent.result,
				output: (subAgent.result.output ?? '') +
					`\n\n[COMPLETION GATE] status=${structured.status} acceptanceMet=${structured.acceptanceMet} — ${structured.reason}`,
			};
		}

		this._emit(eventSink, {
			type: SubAgentEventType.Completed,
			subAgentId: subAgent.id,
			subAgentType: subAgent.type,
			task: subAgent.task,
			parentId: subAgent.parentAgentId,
			timestamp: Date.now(),
			output: execResult.output,
			durationMs,
			tokensUsed: execResult.tokensUsed,
			// ★ 2026-09-13：完成事件也带积分终值（与 tokensUsed 同一时机）。
			creditUsed: execResult.creditUsed,
			toolsCompleted: execResult.apiCallCount,
			exitReason,
			groupId,
		});

		return subAgent.result;
	}

	/**
	 * Build the Completion-Gate context from a sub-agent's task + execution result.
	 * Ground truth: files actually modified, whether it errored/truncated, and the
	 * acceptance criteria the parent spelled out in the task briefing (ACCEPTANCE clause).
	 */

	/**
	 * P2d: Query the DB TaskBoard for non-terminal tasks owned by this sub-agent.
	 * Returns undefined when no taskLookup is configured (caller did not wire DB
	 * access — gateResult falls back to output-marker inference only). On query
	 * failure, returns undefined (fail-open — a transient DB error must NEVER
	 * trap the agent in the gate, mirrors MiMo-Code's orElseSucceed(() => [])).
	 */
	private async _queryIncompleteTasks(subAgent: SubAgentInstance): Promise<readonly IIncompleteTask[] | undefined> {
		if (!this._taskLookup) { return undefined; }
		try {
			return await this._taskLookup({
				ownerAgentId: subAgent.id,
				parentSessionId: subAgent.options.parentSessionId,
			});
		} catch {
			return undefined;
		}
	}

	/**
	 * Execute multiple sub-agents in parallel (respecting maxConcurrent).
	 * Inspired by OpenCode's parallel explore pattern.
	 *
	 * Uses Promise.allSettled so that one sub-agent failure does NOT
	 * abort the entire batch. Failed sub-agents produce a SubAgentResult
	 * with success=false, and the caller can inspect each result individually.
	 */
	async executeMultipleSubAgents(
		subAgentIds: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		eventSink?: SubAgentEventSink,
		groupId?: string,
		/** P3: 父→子取消传播。同一父 turn 信号，扇出给每个并行子 agent。 */
		abortSignal?: AbortSignal,
		/**
		 * Per-call concurrency override. When provided, batches use this limit
		 * instead of the instance-level _maxConcurrent (e.g. plan_explore wants
		 * all N areas truly parallel, not throttled to the global default of 3).
		 */
		maxConcurrent?: number,
	): Promise<Map<string, SubAgentResult>> {
		const results = new Map<string, SubAgentResult>();
		const limit = Math.max(1, maxConcurrent ?? this._maxConcurrent);

		// Effect model: semaphore-bounded rolling window (forEachPar) replaces
		// hand-rolled batching — as soon as one sub-agent finishes, the next starts.
		// allSettled semantics are preserved: one sub-agent failure does NOT abort
		// the rest, and results map 1:1 to subAgentIds.
		const settled = await forEachPar(subAgentIds, limit, (subAgentId) =>
			this.executeSubAgent(subAgentId, executeFn, eventSink, groupId, abortSignal)
		);

		settled.forEach((outcome, i) => {
			const subAgentId = subAgentIds[i];
			if (outcome.status === 'fulfilled') {
				results.set(subAgentId, outcome.value);
			} else {
				// executeSubAgent itself never rejects (fiber exit → failed
				// SubAgentResult) — this branch is a safety net for truly
				// exceptional cases (e.g. precondition throws).
				results.set(subAgentId, {
					success: false,
					error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
					completedAt: Date.now(),
				});
			}
		});

		return results;
	}

	/**
	 * Convenience: create and execute in one call.
	 */
	async dispatch(
		parentAgentId: string,
		task: string,
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		options?: SubAgentOptions,
		eventSink?: SubAgentEventSink,
		/** P3: 父→子取消传播。传入父 turn 的 AbortSignal。 */
		abortSignal?: AbortSignal,
	): Promise<SubAgentResult> {
		const subAgentId = this.createSubAgent(parentAgentId, task, options);
		return this.executeSubAgent(subAgentId, executeFn, eventSink, undefined, abortSignal);
	}

	/**
	 * Convenience: dispatch multiple explore agents in parallel.
	 * Inspired by OpenCode's Phase 1: parallel explore.
	 *
	 * @param perTaskOptions Optional per-task options override. If not provided,
	 *                       defaults to { type: Explore, priority: high, context }.
	 *                       v17: also accepts `worktreePath` for per-task worktree.
	 */
	async dispatchParallelExplore(
		parentAgentId: string,
		tasks: string[],
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		context?: string,
		perTaskOptions?: Array<Pick<SubAgentOptions, 'priority' | 'maxIterations' | 'timeout' | 'worktreePath' | 'type' | 'toolsets' | 'model' | 'parentChatMode' | 'parentWorkMode' | 'excludedTools' | 'agentId' | 'systemPrompt' | 'allowedTools'>>,

		eventSink?: SubAgentEventSink,
		/** P3: 父→子取消传播。传入父 turn 的 AbortSignal。 */
		abortSignal?: AbortSignal,
		/** Per-call concurrency override; defaults to the instance _maxConcurrent. */
		maxConcurrent?: number,
	): Promise<SubAgentResult[]> {
		const subAgentIds = tasks.map((task, idx) =>
			this.createSubAgent(parentAgentId, task, {
				// Default to Explore (read-only investigate) for parallel fan-out,
				// but honor an explicit per-task type (e.g. General for parallel writes).
				type: perTaskOptions?.[idx]?.type ?? SubAgentType.Explore,
				context,
				priority: perTaskOptions?.[idx]?.priority ?? 'high',
				maxIterations: perTaskOptions?.[idx]?.maxIterations,
				timeout: perTaskOptions?.[idx]?.timeout,
				// v17: propagate worktree to each parallel explore subagent.
				worktreePath: perTaskOptions?.[idx]?.worktreePath,
				// v17: propagate per-task toolset scope + model override.
				toolsets: perTaskOptions?.[idx]?.toolsets,
				model: perTaskOptions?.[idx]?.model,
				parentChatMode: perTaskOptions?.[idx]?.parentChatMode,
				parentWorkMode: perTaskOptions?.[idx]?.parentWorkMode,
				// A：只读探索子代理隐藏索引管理工具（防"只索引即停"）。
				excludedTools: perTaskOptions?.[idx]?.excludedTools,
				// agentId 驱动（2026-07-27）：并行探索默认解析到内置 code-explorer，
				// 携带其真实 systemPrompt / tools 白名单实例化子代理。
				agentId: perTaskOptions?.[idx]?.agentId,
				systemPrompt: perTaskOptions?.[idx]?.systemPrompt,
				allowedTools: perTaskOptions?.[idx]?.allowedTools,
			})
		);

		// Cluster all parallel explore agents under one group so the UI can render
		// them as a single grouped SubAgentCard.
		const groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const resultMap = await this.executeMultipleSubAgents(subAgentIds, executeFn, eventSink, groupId, abortSignal, maxConcurrent);
		// Preserve 1:1 index alignment with `tasks` (callers rely on results[i] ≡ tasks[i]).
		// A missing entry (should never happen — executeMultipleSubAgents sets every id)
		// is replaced by a failed placeholder rather than filtered out, which would shift
		// all subsequent indices and desynchronize titles/cards.
		return subAgentIds.map(id => resultMap.get(id) ?? {
			success: false,
			error: `sub-agent result missing for ${id}`,
			completedAt: Date.now(),
		});
	}

	// ─── Status & Management ─────────────────────────────────────────────

	/** 当前运行中的子代理数量（供 delegate_task 并发截断保护使用）。 */
	get activeSubAgentCount(): number {
		let count = 0;
		for (const agent of this._activeSubAgents.values()) {
			if (agent.status === 'running') { count++; }
		}
		return count;
	}

	getSubAgentStatus(subAgentId: string): SubAgentStatusReport | undefined {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) { return undefined; }
		return {
			id: subAgent.id,
			type: subAgent.type,
			status: subAgent.status,
			task: subAgent.task,
			createdAt: subAgent.createdAt,
			budget: subAgent.budget.getSummary(),
		};
	}

	getAllSubAgents(): SubAgentStatusReport[] {
		return Array.from(this._activeSubAgents.values()).map(sa => ({
			id: sa.id,
			type: sa.type,
			status: sa.status,
			task: sa.task,
			createdAt: sa.createdAt,
			budget: sa.budget.getSummary(),
		}));
	}

	/**
	 * Get the permission profile for a sub-agent type.
	 */
	getPermissions(type: SubAgentType) {
		return SUB_AGENT_PERMISSIONS[type];
	}

	/**
	 * Check if a tool is allowed for a given sub-agent.
	 */
	isToolAllowed(type: SubAgentType, toolName: string): boolean {
		// 实现已搬至 subAgentPureHelpers.ts（零 this 依赖的纯逻辑，2026-09-20 第二刀）；
		// 保留公开方法签名以兼容调用方（接口声明见 agentToolIsolator.ts）。
		return isToolAllowedForType(type, toolName);
	}

	/**
	 * Interrupt a running sub-agent.
	 * Inspired by Hermes-Agent's interrupt signal propagation:
	 * 1. Marks the sub-agent as interrupted so _executeWithBudget breaks out
	 * 2. Recursively interrupts any child sub-agents spawned by this one
	 * 3. Sets status to 'cancelled'
	 *
	 * @returns true if the sub-agent was found and interrupted, false otherwise
	 */
	interruptSubAgent(subAgentId: string): boolean {
		const subAgent = this._activeSubAgents.get(subAgentId);
		if (!subAgent) { return false; }

		// Effect model: cooperative cancellation via the per-instance InterruptSignal.
		// The signal is sticky — if the sub-agent is still pending, its fiber will
		// observe the interruption at the first interruption point once it starts.
		this._interruptSignals.get(subAgentId)?.interrupt('user');
		subAgent.status = 'cancelled';

		// Recursively interrupt all child sub-agents (inspired by Hermes)
		for (const [id, agent] of this._activeSubAgents.entries()) {
			if (agent.parentAgentId === subAgentId && agent.status === 'running') {
				this.interruptSubAgent(id);
			}
		}

		return true;
	}

	/**
	 * Cancel a sub-agent (legacy — now delegates to interruptSubAgent).
	 * @deprecated Use interruptSubAgent instead for recursive propagation.
	 */
	cancelSubAgent(subAgentId: string): boolean {
		return this.interruptSubAgent(subAgentId);
	}

	/**
	 * Interrupt ALL running sub-agents.
	 * Useful when the parent agent itself is interrupted and needs to
	 * clean up all child agents.
	 */
	interruptAll(): void {
		for (const [id, agent] of this._activeSubAgents.entries()) {
			if (agent.status === 'running') {
				this.interruptSubAgent(id);
			}
		}
	}

	cleanup(): void {
		for (const [id, subAgent] of this._activeSubAgents.entries()) {
			if (subAgent.status === 'done' || subAgent.status === 'error' || subAgent.status === 'cancelled') {
				this._activeSubAgents.delete(id);
				this._interruptSignals.delete(id);
			}
		}
	}

	get parentBudget(): IterationBudget { return this._parentBudget; }

	// ─── Private Helpers ─────────────────────────────────────────────────

	/**
	 * Build messages array for the sub-agent.
	 * Injects context (e.g., repo_overview) if provided.
	 */

	/**
	 * Build system prompt based on SubAgentType.
	 * Inspired by OpenCode's per-agent prompt files.
	 */
	private _buildSystemPrompt(subAgent: SubAgentInstance): string {
		return buildSubAgentSystemPrompt(subAgent, this.responseLanguageSetting, this.languageSetting);
	}

	/**
	 * Format bytes into a human-readable string (e.g., "1.5 KB", "2.3 MB").
	 */

	/**
	 * Execute the sub-agent with budget tracking and fine-grained event emission.
	 *
	 * Budget consumption is the SOLE responsibility of this method.
	 * The executeFn receives the budget object for read-only checks only
	 * (e.g., budget.hasRemaining()) — it must NOT call budget.consume().
	 * This avoids double-counting when tool_end and tool_result fire
	 * for the same tool invocation.
	 *
	 * Inspired by Hermes-Agent's _run_single_child which tracks:
	 * - api_calls count
	 * - tool_trace (tool name, args/result size, status)
	 * - token usage (input/output)
	 */
	private async _executeWithBudget(
		executeFn: (request: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta>,
		request: IAgentTurnRequest,
		budget: IterationBudget,
		tokenCollector: SubagentTokenCollector,
		emitEvent?: _BoundEmit,
		/** P3: 中断信号源（fiber InterruptSignal）+ attempt 级 stall watchdog。 */
		control?: _AttemptControl,
		/** 总时长上限（ms，2026-07-26 MiMo 对齐）：>0 时超限时走 stalled/salvage 路径（保产出），0=禁用。 */
		wallClockTimeoutMs: number = 0,
	): Promise<_ExecResult> {
		// 用分块数组累积，末尾一次性 join，避免流式 `+=` 产生 ConsString 绳索串
		// （output 最终进入 subAgent.result.output 长期留存，是最危险的泄漏点之一）
		let outputChunks: string[] = [];
		let apiCallCount = 0;
		let budgetExhausted = false;
		let stalled = false;
		let interrupted = false;
		let tokensUsed: { input: number; output: number } | undefined;
		/** ★ 2026-09-13：累计积分（网关末块 usage.credit）—— 与 tokensUsed 平行采集。 */
		let creditUsed = 0;
		const toolTrace: SubAgentToolTraceEntry[] = [];
		const filesModified: string[] = [];
		let currentToolName: string | undefined;
		let currentToolArgsSize = 0;
		let currentToolArgs: Record<string, unknown> | undefined;
		// Raw JSON string accumulated from streamed `tool_args` deltas. The main
		// execution path does NOT populate `tool_start.metadata`, so the only
		// reliable source of tool arguments is the `tool_args` content stream.
		// We concatenate every chunk (handles both single-shot and streamed
		// argument deltas) and JSON.parse it at `tool_end`.
		let currentToolArgsRawChunks: string[] = [];
		// Size and (on error) text of the most recent tool_result, used to fill
		// SubAgentToolTraceEntry.resultSizeBytes / error at the following tool_end.
		let currentToolResultSize = 0;
		let currentToolResultText: string | undefined;

		// ── 流式追踪（定位 "subagent 草草结束/无输出" 类 bug）──
		const _t0Stream = Date.now();
		let _deltaCount = 0;
		let _textDeltaCount = 0;
		let _textBytes = 0;
		let _lastTextPreview = '';
		let _prevDeltaAt = 0;
		// P1: 单响应软上限计时（2026-07-26）。0 = 等待新响应开始；首个内容 delta 起表。
		// tool_end/'done'（模型流结束标记）归零——工具执行时间不计入响应窗口
		// （执行自有 toolExecutionGuard 兜底，嵌套 delegate 可达 630s）。
		let _responseStartAt = 0;
		// ── 收敛检测：search_files 调用限制 + 无新文件发现计数 ──
		// 2026-07-26 分析日志 1785068621468：subagent 在 UE5 大代码库上做线性扫描
		// （127 次 search_files + 74 次 file_read 其中 21 次重复），15min 超时。
		// 限制 search_files 调用次数，并在连续 N 次迭代无新文件发现时注入收敛提示。
		const _searchFilesCount = { value: 0 };
		const _SEARCH_FILES_LIMIT = 30;
		const _CONVERGENCE_THRESHOLD = 5;
		let _consecutiveNoNewFiles = 0;
		const _uniqueFilesFound = new Set<string>();
		const stream = executeFn(request, budget);
		// Effect model — hung-stream escape hatch: if the fiber is interrupted
		// while the stream produces no further deltas, actively return() the
		// generator so the for-await loop unwinds (the loop's post-check then
		// reports the interruption). Only registered for LIVE interrupts — a
		// pre-interrupted signal is handled by the first delta's interruption
		// point, guaranteeing the stream always starts (start-then-cancel order).
		const iterator = stream[Symbol.asyncIterator]();
		let unlinkInterrupt: (() => void) | undefined;
		if (control && !control.signal.interrupted) {
			unlinkInterrupt = control.signal.onInterrupt(() => {
				iterator.return?.().catch(() => { /* best-effort unwind */ });
			});
		}
		try {
			for await (const delta of stream) {
				_deltaCount++;
				const _now = Date.now();
				// DELTA GAP 检测：>10s 空窗（定位"模型在等什么"）
				if (_prevDeltaAt > 0 && _now - _prevDeltaAt > 10_000) {
					this._log?.('warn', `[SubAgent stream] DELTA GAP | ${_now - _prevDeltaAt}ms delta#${_deltaCount - 1}→#${_deltaCount} elapsed=${Math.round((_now - _t0Stream) / 1000)}s agent=${request.agentId}`);
				}
				_prevDeltaAt = _now;
				// ── Text accumulation + heartbeat ──
				if (delta.type === 'text' && delta.content) {
					outputChunks.push(delta.content);
					// 实时文本滚动：text delta 发 TextDelta 事件，inlineTraceSink 累积到 card.streamingOutput
					if (emitEvent) {
						emitEvent({ type: SubAgentEventType.TextDelta, textDelta: delta.content });
					}
					_textDeltaCount++;
					_textBytes += delta.content.length;
					_lastTextPreview = delta.content.length > 80 ? delta.content.slice(0, 80) + '…' : delta.content;
					if (_textDeltaCount % 10 === 0) {
						this._log?.('info', `[SubAgent stream] text heartbeat | delta#${_deltaCount} textDeltas=${_textDeltaCount} textBytes=${_textBytes} elapsed=${Math.round((_now - _t0Stream) / 1000)}s last="${_lastTextPreview}" agent=${request.agentId}`);
					}
				}

				// ── Thinking (inspired by Hermes TASK_THINKING) ──
				if (delta.type === 'thinking' && emitEvent) {
					const text = typeof delta.content === 'string' ? delta.content : '';
					if (text) {
						emitEvent({
							type: SubAgentEventType.Thinking,
							thinkingText: text.slice(0, 200),
						});
					}
				}

				// ── Tool started ──
				// 子代理 tool_start/tool_end 通过 fireSubAgentTrace 旁路总线实时推送到
				// SubAgentCard（不走 agentTurnExecutor 的 delta 流，不会触发 orphan 检测）。
				if (delta.type === 'tool_start') {
					currentToolName = delta.toolName || 'unknown';
					currentToolArgsSize = 0;
					currentToolArgs = undefined;
					currentToolArgsRawChunks = [];
					currentToolResultSize = 0;
					currentToolResultText = undefined;
					if (delta.metadata) {
						try {
							currentToolArgsSize = JSON.stringify(delta.metadata).length;
							currentToolArgs = delta.metadata;
						} catch { /* ignore */ }
					}
					this._log?.('info', `[SubAgent stream] tool_start | ${currentToolName} (argsSize~${currentToolArgsSize}B) delta#${_deltaCount} elapsed=${Math.round((Date.now() - _t0Stream) / 1000)}s agent=${request.agentId}`);
					if (emitEvent) {
						let argsPreview: string | undefined;
						if (delta.metadata) {
							try { argsPreview = JSON.stringify(delta.metadata).slice(0, 200); } catch { /* ignore */ }
						}
						emitEvent({
							type: SubAgentEventType.ToolStarted,
							toolName: currentToolName,
							toolArgsPreview: argsPreview,
							toolsCompleted: apiCallCount,
						});
					}
				}

				// ── Tool arguments streaming ──
				if (delta.type === 'tool_args' && delta.content) {
					currentToolArgsSize += delta.content.length;
					// Accumulate the raw argument JSON so it can be parsed at tool_end.
					// This is the primary source of args for file-change detection,
					// since tool_start.metadata is empty on the main execution path.
					currentToolArgsRawChunks.push(delta.content);
				}

				// ── Tool result (captured for trace size / error text) ──
				if (delta.type === 'tool_result' && typeof delta.content === 'string') {
					currentToolResultSize = delta.content.length;
					currentToolResultText = delta.content;
				}

				// ── Tool completed (inspired by Hermes TASK_TOOL_COMPLETED) ──
				if (delta.type === 'tool_end') {
					apiCallCount++;
					const toolStatus: 'ok' | 'error' = delta.success === false ? 'error' : 'ok';
					// 在此将分块累积的 raw args 拼成最终字符串（仅末尾 join 一次，不产生绳索串）
					const currentToolArgsRaw = currentToolArgsRawChunks.join('');

					// Resolve tool arguments: prefer the accumulated `tool_args` JSON
					// stream (authoritative on the main path); fall back to metadata
					// seeded at tool_start. Without this, file-change detection never
					// fires because tool_start carries no parameters.
					if (!currentToolArgs && currentToolArgsRaw) {
						try {
							const parsed = JSON.parse(currentToolArgsRaw);
							if (parsed && typeof parsed === 'object') {
								currentToolArgs = parsed as Record<string, unknown>;
							}
						} catch { /* incomplete or non-JSON args — ignore */ }
					}
					if (currentToolArgsRaw && !currentToolArgsSize) {
						currentToolArgsSize = currentToolArgsRaw.length;
					}

					const traceEntry: SubAgentToolTraceEntry = {
						toolName: currentToolName || 'unknown',
						status: toolStatus,
						argsSizeBytes: currentToolArgsSize || undefined,
						resultSizeBytes: currentToolResultSize || undefined,
						error: toolStatus === 'error' ? (currentToolResultText?.slice(0, 500) || undefined) : undefined,
					};
					toolTrace.push(traceEntry);
					this._log?.('info', `[SubAgent stream] tool_end | ${currentToolName} status=${toolStatus} resultSize=${currentToolResultSize}B apiCalls=${apiCallCount} delta#${_deltaCount} elapsed=${Math.round((Date.now() - _t0Stream) / 1000)}s agent=${request.agentId}`);

					// ── File change coordination (inspired by Hermes file_state) ──
					// Track files modified by file-writing tools so the parent agent
					// can be warned that its cached file reads may be stale.
					if (currentToolName && currentToolArgs && toolStatus === 'ok') {
						const filePath = extractModifiedFile(currentToolName, currentToolArgs);
						if (filePath && !filesModified.includes(filePath)) {
							filesModified.push(filePath);
						}
					}

					// 通过 fireSubAgentTrace 旁路总线实时推送工具完成事件到 SubAgentCard
					if (emitEvent) {
						// P4: 结构化截断（previewStructured 模块级实现：先解内容包装，
						// 对象保留顶层 key 截断 value，数组给元素摘要，不产生索引键垃圾）
						let resultPreview: string | undefined;
						if (currentToolResultText !== undefined) {
							resultPreview = previewStructured(currentToolResultText, 500);
						} else if (currentToolResultSize > 0) {
							resultPreview = `[result: ${formatBytes(currentToolResultSize)}]`;
						}
						let argsPreview: string | undefined;
						if (currentToolArgsRaw) {
							argsPreview = previewStructured(currentToolArgsRaw, 200);
						} else if (currentToolArgs) {
							try { argsPreview = JSON.stringify(currentToolArgs); } catch { /* ignore */ }
							if (argsPreview && argsPreview.length > 200) { argsPreview = argsPreview.slice(0, 200) + '…'; }
						}
						emitEvent({
							type: SubAgentEventType.ToolCompleted,
							toolName: currentToolName || 'unknown',
							toolStatus,
							toolsCompleted: apiCallCount,
							toolResultPreview: resultPreview,
							toolArgsPreview: argsPreview,
						});
					}

					// ── search_files 调用限制 + search_code 引导 ──
					if (currentToolName === 'search_files') {
						_searchFilesCount.value++;
						// 在达到限制前，先引导使用 search_code
						if (_searchFilesCount.value === 8) {
							this._log?.('info', `[SubAgent convergence] search_files count 8, suggesting search_code agent=${request.agentId}`);
							outputChunks.push(`\n\n[SYSTEM] You have called search_files ${_searchFilesCount.value} times. If you are looking for content patterns (variable usage, function calls, text matches), use search_code instead — it searches ALL file contents at once. search_files only lists file NAMES, not content.`);
						}
						if (_searchFilesCount.value > _SEARCH_FILES_LIMIT) {
							this._log?.('warn', `[SubAgent convergence] search_files limit reached (${_SEARCH_FILES_LIMIT}), injecting stop hint agent=${request.agentId}`);
							outputChunks.push(`\n\n[SYSTEM] You have called search_files ${_searchFilesCount.value} times (limit: ${_SEARCH_FILES_LIMIT}). STOP searching and START reading the files you have already found. If you have enough information, produce your final output NOW.`);
						}
					}

					// ── search_code 未使用检测 ──
					// 如果 search_files 被频繁调用但 search_code 从未被调用，引导使用 search_code
					if (currentToolName === 'search_files' && _searchFilesCount.value === 5) {
						const searchCodeCalls = toolTrace.filter(t => t.toolName === 'search_code').length;
						if (searchCodeCalls === 0) {
							this._log?.('info', `[SubAgent convergence] search_files used ${_searchFilesCount.value}x but search_code never used, suggesting search_code agent=${request.agentId}`);
							outputChunks.push(`\n\n[SYSTEM] HINT: You are using search_files repeatedly. If you need to find WHERE a pattern appears in file CONTENTS (not just file names), use search_code with a regex pattern. Example: search_code(pattern="CollectGarbage", filePattern="*.cpp")`);
						}
					}

					// ── file_read 重复读取检测 ──
					if (currentToolName === 'file_read' && currentToolArgs) {
						const filePath = String(currentToolArgs['path'] ?? currentToolArgs['file_path'] ?? '');
						if (filePath && _uniqueFilesFound.has(filePath)) {
							// 文件已在 search_files 中发现过，正常读取
						} else if (filePath) {
							// 检查是否已读过（简单路径匹配）
							const readFiles = toolTrace.filter(t => t.toolName === 'file_read').length;
							if (readFiles > 20) {
								this._log?.('warn', `[SubAgent convergence] file_read count ${readFiles} exceeds 20, may be reading too many files agent=${request.agentId}`);
							}
						}
					}

					// ── 收敛检测：跟踪新文件发现 ──
					// search_files 结果中的文件路径提取（简单启发式：匹配含 / 或 \ 的路径片段）
					if (currentToolName === 'search_files' && currentToolResultText) {
						const beforeSize = _uniqueFilesFound.size;
						const pathMatches = currentToolResultText.match(/[A-Za-z]:[\\/][^\s"',;|]+\.(cpp|h|hpp|cs|ts|js|py|rs|java|go|rb|c|cc|cxx|hxx|inl|md|txt|json|xml|yaml|yml|toml|cfg|ini|bat|sh|ps1)/gi);
						if (pathMatches) {
							for (const p of pathMatches) { _uniqueFilesFound.add(p); }
						}
						if (_uniqueFilesFound.size === beforeSize) {
							_consecutiveNoNewFiles++;
						} else {
							_consecutiveNoNewFiles = 0;
						}
						if (_consecutiveNoNewFiles >= _CONVERGENCE_THRESHOLD) {
							this._log?.('warn', `[SubAgent convergence] ${_consecutiveNoNewFiles} consecutive iterations with no new files, injecting convergence hint agent=${request.agentId}`);
							outputChunks.push(`\n\n[SYSTEM] You have not discovered any new files in the last ${_consecutiveNoNewFiles} search iterations. The files you need are likely already found. STOP searching and START reading/analyzing them. If you have enough information, produce your final output NOW.`);
							_consecutiveNoNewFiles = 0; // Reset to avoid spamming hints
						}
					}

					budget.consume(1);
					if (!budget.hasRemaining()) {
						outputChunks.push('\n\n[Budget exhausted — sub-agent stopped]');
						budgetExhausted = true;
						break;
					}
				}

				// ── Usage/token tracking ──
				if (delta.type === 'usage' && delta.usage) {
					// Accumulate across multiple usage events (one per LLM turn) rather
					// than overwriting, so multi-iteration sub-agents report total cost.
					const inTok = delta.usage.inputTokens ?? 0;
					const outTok = delta.usage.outputTokens ?? 0;
					if (!tokensUsed) {
						tokensUsed = { input: inTok, output: outTok };
					} else {
						tokensUsed.input += inTok;
						tokensUsed.output += outTok;
					}
					// Record to SubagentTokenCollector for detailed per-turn tracking
					// (inspired by deer-flow SubagentTokenCollector)
					tokenCollector.recordUsage({
						inputTokens: inTok,
						outputTokens: outTok,
						cacheHitTokens: delta.usage.cachedTokens,
						cacheWriteTokens: delta.usage.cacheWriteTokens,
					});
					// ★ 2026-09-13：积分累计 —— 网关末块 usage.credit（`IModelUsage.credit`）。
					//   subagent 级此前**完全没有**采集积分（只有消息级 tokenUsage.credit），
					//   而卡片左下角需要展示「本次委派花了多少积分」。
					if (typeof delta.usage.credit === 'number') {
						creditUsed += delta.usage.credit;
					}
					// ★ 2026-09-13（用户需求「subagent 工具卡片执行过程中实时显示 token 消耗」）：
					//   每个 LLM turn 的 usage 到达时立刻 emit 一条 Progress 事件，带上**累计**用量。
					//   此前 tokensUsed 只在 Completed 事件里下发 → 执行期间卡片完全看不到消耗，
					//   要等子代理跑完才有数字。
					//   复用 Progress 而非新增事件类型：它已是「轻量状态更新」通道，且
					//   reduceCardState 对该事件的字段是增量赋值，不破坏既有语义。
					if (emitEvent) {
						emitEvent({
							type: SubAgentEventType.Progress,
							tokensUsed: { ...tokensUsed },
							creditUsed,
						});
					}
				}

				// ── Terminal events ──
				// ⚠ 'done' 不能作为终止信号：executeAgentTurn 会在「每个迭代的 provider 流结束」
				// 透传一个 done（languageModelsBridge 流尾统一 yield done，executor 经
				// _adaptModelDelta 原样转发，见 agentChatService L1894 注释「agent loop 中每次
				// LLM turn 结束都会 yield done」）。若在 done 处 break，for-await 会 return() 掉
				// executor 生成器 —— 本轮工具调用尚未执行、后续迭代全部夭折，子代理带着
				// 「开场白」文本空转返回（2026-07-25 线上事故：3 个 code-explorer 子代理各自
				// 仅 1 次 LLM 调用、0 次工具执行、4s 内"成功"返回）。
				// 正确做法：done 只是迭代边界事件，继续消费；executeAgentTurn 在真正的轮末
				// yield 自己的 done 后生成器自然 return，for-await 随之结束。
				if (delta.type === 'error') {
					break;
				}

				// ── Interruption point (Effect model): user interrupt or parent abort (P3) ──
				try {
					control?.signal.throwIfInterrupted();
				} catch (e) {
					if (!isFiberInterrupt(e)) { throw e; }
					outputChunks.push('\n\n[Interrupted by user or parent agent]');
					interrupted = true;
					if (emitEvent) {
						emitEvent({
							type: SubAgentEventType.Interrupted,
							exitReason: 'interrupted',
						});
					}
					break;
				}

				// ── Stall watchdog（2026-07-26 MiMo-Code 分层超时对齐重构，attempt-local）──
				// 活动语义（P1）：模型流期间「内容级 delta」计活——长最终答案的持续流式输出
				// 是健康状态，不再误判停滞（旧语义仅 tool_start/tool_end 计活：线上事故
				// 1785037741973 中，子代理阻塞等待嵌套 delegate 子代理 150.8s，看门狗在
				// 子代理完成前 37ms 误杀父代理；>阈值的最终答案流同理会误杀）。
				// usage/done/phase_change/memory_injected 等帧外事件不计活（对齐 MiMo：
				// keep-alive 只证明连接活着，不证明模型在产出）。
				// 工具执行窗口（P0）：tool_start→pause / tool_end→resume（引用计数），
				// 覆盖「参数流式 + 全部在飞工具执行」整段盲区；工具执行由 toolExecutionGuard
				// 兜底（编排工具 630s）。tool_args 虽处暂停窗口仍是模型活动 → tick 记录。
				if (delta.type === 'tool_start') {
					control?.watchdog.pause();
				} else if (delta.type === 'tool_end') {
					control?.watchdog.resume();
				}
				if (_STALL_CONTENT_DELTA_TYPES.has(delta.type)) {
					control?.watchdog.tick();
				}
				if (control?.isStalled()) {
					outputChunks.push('\n\n[Stalled — no progress for too long, aborted]');
					stalled = true;
					break;
				}
				// Wall-clock 总时长上限（2026-07-26 规则变更：要求限时，MiMo 对齐）——
				// 与停滞看门狗同一 delta 检查点：超时走 stalled/salvage 路径（保留产出 +
				// P1 禁工具总结），对齐 MiMo「timeout 状态照交结果」而非硬失败。
				// 注：完全零 delta 的极端挂起不经过此点，由外层 timeout() 组合器硬杀。
				if (wallClockTimeoutMs > 0 && _now - _t0Stream > wallClockTimeoutMs) {
					outputChunks.push(`\n\n[总时长上限 ${Math.round(wallClockTimeoutMs / 1000)}s 已到，保留已完成结果并收尾]`);
					stalled = true;
					break;
				}
				// ── P1: 单响应软上限（对齐 MiMo chunkTimeout=480s）──
				// 连续模型响应段（两次工具边界之间的内容流）超过 responseSoftCapMs → 判停滞，
				// 防止「空谈永动」（无限文本流从不调用工具）。tool_end/'done' 归零：
				// 工具执行时间不计入响应窗口。健康长答案（实测 80s 级）充分放行。
				if (delta.type === 'tool_end' || delta.type === 'done') {
					_responseStartAt = 0;
				} else if (_STALL_CONTENT_DELTA_TYPES.has(delta.type)) {
					if (_responseStartAt === 0) {
						_responseStartAt = _now;
					} else if (_now - _responseStartAt > this.responseSoftCapMs) {
						outputChunks.push(`\n\n[Stalled — single response exceeded soft cap (${Math.round(this.responseSoftCapMs / 1000)}s), aborted]`);
						stalled = true;
						break;
					}
				}
			}
		} finally {
			unlinkInterrupt?.();
		}
		// The generator may have been unwound externally (hung-stream escape hatch)
		// without passing an interruption point — still report the interruption.
		if (!interrupted && control?.signal.interrupted && !stalled) {
			outputChunks.push('\n\n[Interrupted by user or parent agent]');
			interrupted = true;
		}
		// ── 交接日志：子 agent 结束时的完整总结（定位"为什么 output 这么少"）──
		const _duration = Date.now() - _t0Stream;
		this._log?.('info', `[SubAgent handover] DONE | agent=${request.agentId} duration=${_duration}ms totalDeltas=${_deltaCount} textDeltas=${_textDeltaCount} textBytes=${_textBytes} toolCalls=${apiCallCount} tokens=${tokensUsed ? `in=${tokensUsed.input}/out=${tokensUsed.output}` : 'n/a'} stalled=${stalled} interrupted=${interrupted} budgetExhausted=${budgetExhausted} outputLen=${outputChunks.join('').length} lastTextPreview="${_lastTextPreview}"`);

		// ── 弱输出兜底：LLM 只产生极短文本（如"I'll start"这类占位语，无实质内容）
		// 或完全无 text delta（只有 tool calls）时，若不干预，gateResult('') /
		// gateResult('I'll start') 会默认判 success（无错误/无截断），最终父 agent
		// 只看到一句空话，看不到子代理实际做了什么——这正是"subagent 不干活"的
		// 表现之一（子代理其实调用了工具，但输出内容空洞，父 agent 误判为无产出）。
		// 从 tool traces 合成结构化摘要追加到弱输出之后，确保父 agent 始终能看到
		// 子代理实际执行的工具轨迹，即使模型没有生成有意义的文字总结。
		const _rawOutput = outputChunks.join('');
		const _isEmptyOutput = _rawOutput.trim().length === 0;
		// 弱输出阈值：短于 40 字符且非空——大概率是"I'll start..."/"Let me..."之类的
		// 未完成占位语，而非真正的分析结论。
		const _isWeakOutput = !_isEmptyOutput && _rawOutput.trim().length < 40;
		if ((_isEmptyOutput || _isWeakOutput) && toolTrace.length > 0) {
			// 探测"只调用了 index_repository（建索引）就自然结束"这种典型的过早终止——
			// LLM 把索引启动的确认信息误当成任务完成信号，未继续调用 search_graph 等
			// 真正的探索工具。这是本次日志问题 2 的具体根因，显式标注便于父 agent
			// 及排障人员识别，而不是简单认为「探索完成但无发现」。
			const _exploreToolNames = new Set(['search_graph', 'query_graph', 'get_code_snippet', 'trace_path', 'get_architecture', 'search_files', 'file_read']);
			const _onlyIndexed = toolTrace.length > 0 && toolTrace.every(t => t.toolName === 'index_repository') && !toolTrace.some(t => _exploreToolNames.has(t.toolName));
			const summaryLines: string[] = [];
			if (_onlyIndexed) {
				// 用 'partial'（SubAgentGateStatus 合法值）而非自造状态词，确保
				// parseReturnHeader 能正确解析并让 Completion Gate 按「未完成」处理，
				// 而不是被默认判定为 success。
				summaryLines.push(`**Status**: partial`);
				summaryLines.push(`**Summary**: Sub-agent only called \`index_repository\` (index build) and then stopped ` +
					`without performing any actual exploration (search_graph/query_graph/get_code_snippet/etc). ` +
					`No real findings were produced — this looks like a premature stop after indexing. ` +
					`The parent agent should re-delegate this task or perform the exploration directly.`);
			} else if (_isWeakOutput) {
				// 保留模型原始（弱）文本作为上下文，避免信息丢失。
				summaryLines.push(`**Status**: success`);
				summaryLines.push(`**Summary**: Model output was too short ("${_rawOutput.trim()}") to be a real finding. ` +
					`Falling back to tool execution trace below — the parent agent should treat this as a ` +
					`potentially incomplete exploration and verify or re-delegate if the trace looks insufficient.`);
			} else {
				summaryLines.push(`**Status**: success`);
				summaryLines.push(`**Summary**: Executed ${apiCallCount} tool call(s) — no text summary was generated by the model.`);
			}
			summaryLines.push('', '**Tool execution trace**:');
			for (const t of toolTrace) {
				const statusIcon = t.status === 'ok' ? '✅' : '❌';
				const argsPreview = t.argsSizeBytes ? ` (${t.argsSizeBytes}B args)` : '';
				const resultPreview = t.resultSizeBytes ? ` → ${t.resultSizeBytes}B result` : '';
				summaryLines.push(`- ${statusIcon} \`${t.toolName}\`${argsPreview}${resultPreview}`);
			}
			if (filesModified.length > 0) {
				summaryLines.push('', `**Files touched**: ${filesModified.join(', ')}`);
			}
			outputChunks.push('\n\n' + summaryLines.join('\n'));
			this._log?.('info', `[SubAgent handover] synthesized output from ${toolTrace.length} tool traces ` +
				`(${_isEmptyOutput ? 'empty' : 'weak'} LLM text, rawLen=${_rawOutput.trim().length}) agent=${request.agentId}`);
		}

		return { output: outputChunks.join(''), apiCallCount, budgetExhausted, tokensUsed, creditUsed, toolTrace, filesModified, stalled, interrupted };
	}

	/** Safely deliver a lifecycle event to the sink, swallowing any sink errors. */
	private _emit(sink: SubAgentEventSink | undefined, event: SubAgentLifecycleEvent): void {
		if (!sink) { return; }
		try {
			sink(event);
		} catch {
			// Event delivery must never break sub-agent execution.
		}
	}

	/**
	 * Extract a file path from a tool call if the tool is a file-modifying tool.
	 * Inspired by Hermes-Agent's file_state coordination which tracks which files
	 * sub-agents read/write to warn the parent about stale cache.
	 */
}