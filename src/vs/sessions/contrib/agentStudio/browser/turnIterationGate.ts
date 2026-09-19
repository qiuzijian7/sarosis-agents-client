/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 每轮循环顶的门控段（原 `executeAgentTurnDirect` 内联，agentTurnExecutor.ts
 * `while` 循环体首段）。
 *
 * 职责（按执行顺序）：
 *   1. 显式 abort 检查点（每轮顶检查，不在迭代间隙期等待）
 *   2. 运行中 steering 注入（见 common/loopGate.ts）
 *   3. 预算门控裁决（见 common/turnStopGate.ts classifyIterationStop，
 *      内部复用 common/loopGate.ts classifyBudgetGate）
 *   4. 收尾轮判定：禁用工具 + 注入收尾提醒
 *   5. 临近预算预警（只注入一次）
 *   6. 软预算收尾提醒（超阈值首次注入，之后按 REFIRE 周期重复）
 *   7. 策略 prepareIteration 调用（可改写 messages / 覆盖本轮工具面）
 *
 * ## 为什么用「回调 + 访问器」而不是返回值
 *
 * 本段内 `messages` 被重绑定 6 次、`enabledTools` 被重绑定 2 次，且策略会**原地改写**
 * 传入的 messages 数组。靠返回值回传会丢失中间态（策略原地写 + 后续 appendMessages
 * 重绑定会静默丢弃），故改为接收 `setMessages` 回调：每次变更立即落回调用方并触发
 * `syncMessages()`，与 agentTurnExecutor 既有的「赋值 + 同步」纪律保持一致。
 *
 * `wrapUp` 同理——其真相源在 runState.wrapUp，本段既读又写（forced / done /
 * reasonReminderInjected / hardLimitReminderInjected / budgetLowWarned），
 * 经 accessor 读写而非传值快照。
 *
 * @module agentStudio/turnIterationGate
 */

import type { AgentRunMessage, AgentWrapUpState } from '../common/agentRunState.js';
import type { IterationBudget } from '../common/iterationBudget.js';
import type { ITurnLoopState } from '../common/turnLoopState.js';
import type { PreLoopContext, IAgentLoopStrategy } from '../common/agentLoopStrategy.js';
import type { IToolDefinition, IModelSelection, IModelProvider, IAgentTurnRequest } from '../common/providers.js';
import type { DeliveryQueue } from '../common/deliveryQueue.js';
import { injectSteeringMessages } from '../common/loopGate.js';
import { classifyIterationStop } from '../common/turnStopGate.js';
import { buildForkContext, prefixCacheAligned } from '../common/forkContext.js';
import type { IForkContext } from '../common/forkContext.js';
import {
	budgetLowWarning,
	softBudgetWrapUpReminder,
	hardLimitWrapUpReminder,
} from '../common/loopReminders.js';

/** 门控段实际读到的 host 面（只声明用到的成员，避免拖入整个 host 类型）。 */
export interface IGateHost {
	_logService: {
		info(message: string): void;
		warn(message: string, ...args: unknown[]): void;
	};
}

/**
 * 门控段依赖的轮次上下文。
 *
 * 刻意不传整个 `runState` —— 本段只需要 `work`（供 PreLoopContext）和 `phase`
 * 之外的少量派生值，传全量会让「本段实际依赖什么」变得不可见。
 */
export interface IIterationGateDeps {
	readonly host: IGateHost;
	readonly request: IAgentTurnRequest;
	readonly loopState: ITurnLoopState;
	readonly budget: IterationBudget;
	readonly strategy: IAgentLoopStrategy | undefined;
	readonly steeringQueue: DeliveryQueue | undefined;
	readonly turnAbortSignal: AbortSignal;
	readonly modelProvider: IModelProvider | undefined;
	readonly selection: IModelSelection;
	readonly chatOnly: unknown;
	readonly trivialRequest: boolean;
	readonly workState: PreLoopContext['workState'];
	/** 本 turn 起始时间戳（软预算计时基准） */
	readonly turnStartedAt: number;
}

/** 门控段的可变视图（读写回调用方状态）。 */
export interface IIterationGateState {
	/** 当前 messages 数组（每次变更后必须立即回写） */
	messages(): AgentRunMessage[];
	setMessages(next: AgentRunMessage[]): void;
	/** 当前可用工具面（本段可能被策略覆盖或在收尾轮清空） */
	enabledTools(): IToolDefinition[];
	setEnabledTools(next: IToolDefinition[]): void;
	/** 收尾门控状态（真相源在 runState.wrapUp） */
	wrapUp(): AgentWrapUpState;
	patchWrapUp(patch: Partial<AgentWrapUpState>): void;
}

/** 门控段产出的裁决结果，调用方据此决定是否继续本轮。 */
export interface IterationGateOutcome {
	/** true = 本 turn 应跳出主循环（abort 或预算硬停） */
	readonly shouldBreak: boolean;
	/** 本轮是否为收尾轮（工具已禁用），供后续段判定 */
	readonly isWrapUpRound: boolean;
}

/**
 * 每轮循环顶的门控段。
 *
 * 纯计算 + 受控写：不 yield 任何 UI 事件，也不调用 LLM。
 * `setMessages` / `setEnabledTools` / `patchWrapUp` 是唯一的对外写入面。
 */
export function runIterationGate(
	deps: IIterationGateDeps,
	state: IIterationGateState,
	maxToolIterations: number,
	softBudgetReminderRefireMs: number,
	budgetLowRemainingThreshold: number,
): IterationGateOutcome {
	const { host, request, loopState, budget, strategy, steeringQueue, turnAbortSignal } = deps;
	const setMessages = state.setMessages;

	// ─── V3: 显式 abort 检查点（每轮顶检查，不在迭代间隙期等待）──
	if (turnAbortSignal.aborted) {
		host._logService.warn(`[AgentOS] Turn aborted at iteration ${loopState.iteration} — stopping loop`);
		return { shouldBreak: true, isWrapUpRound: false };
	}

	// ─── 运行中消息注入（对齐 pi agent-loop.ts:200-209）──────────────────
	// 用户可能在上一轮工具执行期间继续输入。这类消息不能等 turn 结束——那时
	// 模型已基于陈旧上下文作答。在每轮 LLM 调用前领取并注入，使新输入参与本轮。
	// 实现见 injectSteeringMessages（租约语义单测覆盖）。
	if (steeringQueue) {
		const steeringResult = injectSteeringMessages(
			steeringQueue,
			request.agentId,
			loopState.iteration,
			`turn-${loopState.iteration}-${Date.now()}`,
			state.messages(),
			(current, content) => [...current, { role: 'user', content } as AgentRunMessage],
			host._logService,
		);
		if (steeringResult.injectedCount > 0) {
			setMessages(steeringResult.messages);
		}
	}

	// ─── 预算门控 + 收尾轮判定（判定收口到 turnStopGate）──────────────────
	// classifyIterationStop 内部按原顺序串起 classifyBudgetGate 与
	// 「forced || iteration > max」；日志 / patchWrapUp 等副作用保留原地。
	// ⚠ strategyRequestedStop 刻意传 false：原实现此处**没有**策略终止分支，
	// 该字段要等阶段 3（strategy 契约接线）才有真值来源，提前传 true 会改行为。
	const iterationVerdict = classifyIterationStop(
		{
			iteration: loopState.iteration,
			hasRemainingBudget: budget.hasRemaining(),
			isGraceArmed: budget.isGraceArmed(),
			wrapUpDone: state.wrapUp().done,
			wrapUpForced: state.wrapUp().forced,
			strategyRequestedStop: false,
		},
		{ maxToolIterations },
	);
	if (iterationVerdict.kind === 'stop') {
		host._logService.warn(`[AgentOS] Iteration budget exhausted (${budget.getSummary()}) — stopping loop (wrap-up round already done)`);
		return { shouldBreak: true, isWrapUpRound: false };
	}
	// 预算触发的收尾必须落回 runState：下游读的是 `wrapUp().forced`
	// （本函数下方的 Diag 日志、以及轮内其他分支），只靠局部变量会漂移。
	// reason 能唯一区分来源 —— 'budget-exhausted' 仅在 budgetGate==='wrap-up' 时产生。
	if (iterationVerdict.kind === 'wrap-up' && iterationVerdict.reason === 'budget-exhausted') {
		host._logService.warn(`[AgentOS] Iteration budget exhausted (${budget.getSummary()}) — entering final wrap-up round (tools disabled)`);
		state.patchWrapUp({ forced: true });
	}

	// ─── 收尾轮判定：撞硬上限（iteration 超出 MAX）或预算耗尽请求 ──
	const isWrapUpRound = iterationVerdict.kind === 'wrap-up';
	if (isWrapUpRound) {
		host._logService.info(
			`[AgentOS][Diag] wrap-up trigger: iter=${loopState.iteration} force=${state.wrapUp().forced} ` +
			`overMax=${loopState.iteration > maxToolIterations} budget=${budget.getSummary()} ` +
			`grace=${budget.isGraceArmed()}`,
		);
		state.patchWrapUp({ done: true });
		host._logService.warn(
			`[AgentOS] FINAL WRAP-UP ROUND (iteration ${loopState.iteration}, max ${maxToolIterations}) — ` +
			`tools DISABLED, model must produce final answer from gathered context` +
			(state.wrapUp().reasonReminderInjected ? ' (reason-specific reminder already injected)' : '')
		);
		// ⚠ 2026-08-22：零进展空转路径已注入过 `allBlockedWrapUpReminder`，此处不可
		// 再叠加 `hardLimitWrapUpReminder(MAX_TOOL_ITERATIONS)` —— 后者会告诉模型
		// 「你已用满 100 轮」，而实际只跑了 5 轮（零进展提前收尾），**措辞与事实
		// 矛盾会让模型困惑**（它可能据此判断上下文已被截断而放弃作答）。
		// 收尾的三重保障（工具置空 / toolChoice:'none' / 提醒）仍完整，只是提醒
		// 换成了贴合真实原因的那一条。
		if (!state.wrapUp().reasonReminderInjected && !state.wrapUp().hardLimitReminderInjected) {
			// ─── 收尾提醒的注入方式：system 消息 + 紧贴冻结前缀 ────────────
			// 改前是 `messages.push({ role: 'user', ... })` —— 两个问题：
			//   ① **角色错配**：冲突指令（stable 层「需要工具时 emit a NATIVE
			//      function call」）在 **system** 里，而纠正它的提醒却是 **user**
			//      消息。模型对 system 的遵循权重高于 user，靠 user 消息末尾那句
			//      "overrides ALL other instructions" 去压 system 指令，胜算很低。
			//   ② **位置太远**：push 到末尾 = 淹没在全部对话历史之后；而冲突指令在
			//      开头。两者相隔整段历史，模型很难把它们关联成"后者覆盖前者"。
			// 改为：system 角色 + 插入在所有前置 system 消息之后（复用 330 行
			// volatile 层的同款插入模式），使其**紧贴**冻结前缀中的冲突指令。
			// 这不打断前缀缓存 —— 冻结前缀仍是最长公共前缀，本条只是其后的增量。
			// ⚠ 数字必须取**本次收尾真正生效**的那个上限，分两种来源：
			//   · 预算耗尽（`wrapUp().forced`，由上方 :166-169 依
			//     `reason==='budget-exhausted'` 置位）→ `budget.maxIterations`
			//   · 撞硬上限保险丝（iteration > max）→ `maxToolIterations`
			//
			// 为何必须分流：`maxToolIterations` 是 `MAX_TOOL_ITERATIONS = 100`
			// （子代理 background 时 1000），而预算默认 90、可由 `budgetMaxTotal`
			// 任意收紧。绝大多数真实收尾走预算路径，此时传 100 就等于告诉模型
			// 「你已用满 100 轮」而它只跑了 12 轮 —— 与 :185-190 为零进展路径
			// 规避掉的是**同一类**「措辞与事实矛盾」缺陷，这里把同一个判断补齐
			// 到预算路径上。数字在文案里出现两次（`loopReminders.ts:220` 与
			// `:226`，后者要求模型向用户复述），失真会一并传导到最终答复。
			//
			// 注：此分流在 2026-09-18 之前是**无效**的 —— 当时 ① 档预警借
			// `armGraceCall()` 做去重，导致 `classifyBudgetGate` 永久放行、
			// 收尾只能由硬上限兜底，`forced` 恒为 false。该缺陷已在
			// `hermesReActStrategy.ts:55` 修复（改用策略实例私有标志）。
			const effectiveMaxIterations = state.wrapUp().forced ? budget.maxIterations : maxToolIterations;
			const wrapUpContent = hardLimitWrapUpReminder(effectiveMaxIterations);
			let wrapUpInsertIdx = 0; // 轮内临时值，刻意不收口（见 agentRunState.ts「runState 收口边界」）
			const currentMessages = state.messages();
			for (let i = 0; i < currentMessages.length; i++) {
				if (currentMessages[i]?.role === 'system') { wrapUpInsertIdx = i + 1; } else { break; }
			}
			setMessages(insertBefore(currentMessages, wrapUpInsertIdx, { role: 'system', content: wrapUpContent } as AgentRunMessage));
			state.patchWrapUp({ hardLimitReminderInjected: true });
			host._logService.info(
				`[AgentOS] Wrap-up reminder injected as SYSTEM tier at idx=${wrapUpInsertIdx} ` +
				`(adjacent to frozen prefix, ${wrapUpContent.length} chars)`,
			);
		}
		// 空数组（非 undefined）：下方 `if (iterationToolDefs)` 判定为 truthy，
		// 从而把 enabledTools 覆盖为空 → provider 收不到任何工具，模型无法再调用。
		loopState.iterationToolDefs = [];
	} else if (!state.wrapUp().budgetLowWarned) {
		// ─── 临近预算预警（只注入一次）──
		// 让模型知道剩余轮次，避免在末轮启动 delegate_task 这类结果无人消费的昂贵操作。
		//
		// ⚠ 2026-09-18：分母必须取 `budget`，不能取 `maxToolIterations`。
		// 后者是**硬上限保险丝**（MAX_TOOL_ITERATIONS=100 / 子代理 1000），与真正
		// 生效的迭代预算（IterationBudget，默认 90，可由 budgetMaxTotal 覆盖）是两套
		// 独立数字。原实现用 `maxToolIterations - iteration + 1 <= 3`，要求跑到第 98
		// 轮才触发；而循环在 `budget.hasRemaining()` 转假时（第 N 轮，N 通常远小于 98）
		// 就已进入收尾 —— 该分支因此**永不可达**，budgetLowWarning 成了死代码，
		// 「末轮启动 delegate_task 导致成果全丢」这个它本该修复的故障其实一直没被兜住。
		const remaining = budget.remaining;
		if (remaining <= budgetLowRemainingThreshold) {
			state.patchWrapUp({ budgetLowWarned: true });
			host._logService.warn(`[AgentOS] Iteration budget low (${remaining}/${budget.maxIterations} remaining) — injecting warning`);
			setMessages([...state.messages(), { role: 'user', content: budgetLowWarning(remaining, budget.maxIterations) } as AgentRunMessage]);
		}
	}
	// ─── 软预算收尾提醒（超阈值首次注入；之后每 REFIRE 周期重复，不打断执行）──
	if (request.softDeadlineMs && request.softDeadlineMs > 0) {
		const elapsedMs = Date.now() - deps.turnStartedAt;
		if (elapsedMs >= request.softDeadlineMs && elapsedMs >= loopState.softBudgetNextReminderAtMs) {
			loopState.softBudgetNextReminderAtMs = elapsedMs + softBudgetReminderRefireMs;
			const agentTag = request.subAgent?.background ? `[subAgent:${request.agentId}]` : '[main]';
			host._logService.warn(
				`[AgentOS] ${agentTag} Soft budget exceeded (${Math.round(elapsedMs / 1000)}s >= ${Math.round(request.softDeadlineMs / 1000)}s) — injecting wrap-up reminder`
			);
			setMessages([...state.messages(), {
				role: 'user',
				content: softBudgetWrapUpReminder(Math.round(elapsedMs / 1000), Math.round(request.softDeadlineMs / 1000)),
			} as AgentRunMessage]);
		}
	} else if (request.subAgent?.background && loopState.iteration === 1) {
		// 诊断：子代理首轮却无 softDeadlineMs — 说明 unifiedSubAgentDispatch 链路未送达
		host._logService.warn(
			`[AgentOS] [subAgent:${request.agentId}] softDeadlineMs is NOT set — ` +
			`wrap-up reminder will NOT be injected. Check unifiedSubAgentDispatch request construction.`,
		);
	}
	// ─── 策略：本轮准备（预算低时注入「整理总结」提醒）──
	{
		let strategyReminder: string | undefined;
		if (strategy?.prepareIteration) {
			// ⚠ 与 preLoop 同源风险：策略拿到的是 messages **引用**，可原地改写。
			// 每轮把当前数组交给策略、返回后重新对齐，保证任何策略原地写都不会被
			// 后续 `messages = appendMessages(...)` 的重绑定静默丢弃。
			const iterCtx: PreLoopContext = {
				host: host as unknown as PreLoopContext['host'], request, chatMode: String(deps.chatOnly),
				modelProvider: deps.modelProvider, modelId: deps.selection.modelId, selection: deps.selection,
				messages: state.messages(), signal: turnAbortSignal, budget, workState: deps.workState,
				toolDefs: state.enabledTools(), iteration: loopState.iteration,
			};
			const sp = strategy.prepareIteration(iterCtx, budget);
			if (iterCtx.messages !== state.messages()) {
				setMessages(iterCtx.messages as AgentRunMessage[]);
			}
			strategyReminder = sp.reminderMessage;
			// 捕获策略对本轮工具面的覆盖（如 delegation 范式限制 supervisor 工具）。
			// 仅当策略显式返回 toolDefs 时才覆盖；其余范式返回 undefined → 沿用全工具。
			// 收尾轮例外：工具面必须保持为空，否则策略（如 delegation 返回 supervisor
			// 工具集）会把 `_iterationToolDefs = []` 冲掉，模型又能调 delegate_task。
			if (sp.toolDefs && !isWrapUpRound) { loopState.iterationToolDefs = sp.toolDefs; }
			// 捕获策略级硬权限谓词，交由执行器的运行时拦截段消费。
			// ⚠ 必须每轮无条件重新赋值（策略未返回则落 undefined）——
			// 谓词与工具面同周期，残留上一轮的判据会造成过期拦截。
			// 收尾轮同样保留：收尾轮工具面为空，但若模型仍幻觉出工具调用，
			// 运行时拦截是最后一道防线，不该因收尾而放松。
			loopState.iterationHardPermission = sp.hardPermission;
		}
		// MiMo-Code 处理方式：策略级 reminder 统一作为 user 消息注入
		// （synthetic user part），而非 system 角色 —— 避免破坏 system 前缀缓存，
		// 与 beforeTerminate 的 nudgeMessage（亦为 user 角色）保持一致。
		if (strategyReminder) {
			setMessages([...state.messages(), { role: 'user', content: strategyReminder } as AgentRunMessage]);
		}
	}

	// 应用 iterationToolDefs 覆盖（原在「每轮重新收集工具」之后，此处紧随策略段，
	// 保持与原执行顺序一致：策略段 → 覆盖 → trivial 过滤）。
	if (loopState.iterationToolDefs) {
		state.setEnabledTools(loopState.iterationToolDefs);
	}

	return { shouldBreak: false, isWrapUpRound };
}

/** 在指定下标前插入一条消息（不修改入参）。 */
function insertBefore<T>(items: readonly T[], index: number, item: T): T[] {
	const next = [...items];
	next.splice(index, 0, item);
	return next;
}

/**
 * 计算本轮的 fork 冻结前缀（原 `executeAgentTurnDirect` 内联 S2 段）。
 *
 * 冻结前缀 = (systemPrompt, tools) 的稳定指纹。请求构造端（MessageFormatConverter +
 * BYOK provider）据此在**前缀边界**注入 cache_control 断点，从而命中父级已写入的
 * prompt cache，而不是为一个重计费的稳定大前缀反复付费。
 *
 * ## 为什么指纹基于 effectiveSystemPrompt
 *
 * 它才是**实际发送的第一条 system 消息**（含 model 相关 enforcement）。用原始
 * stable 层做指纹会导致「指纹 / 缓存断点 / modelOptions」三者不一致 —— 指纹说对齐、
 * 断点却落在别处，缓存静默不命中且无从察觉。
 *
 * ## 顺序约束（易错点）
 *
 * 必须先读 `_lastForkContextBySession` 的**旧值**（= 上一轮）再写入本轮新值。
 * 顺序写反会「自对齐」—— 拿自己的指纹跟自己比，恒为 true，缓存诊断彻底失效。
 *
 * @returns 本轮应回填给请求的 parentFork（供请求构造端对齐用）。
 */
export function computeForkContext(
	host: { _logService: IGateHost['_logService']; _lastForkContextBySession: Map<string, IForkContext> },
	request: IAgentTurnRequest,
	effectiveSystemPrompt: string | undefined,
	enabledTools: readonly IToolDefinition[],
): IForkContext | undefined {
	const currentFork = buildForkContext(effectiveSystemPrompt ?? '', enabledTools);
	// 回填父级冻结前缀：优先 request.forkContext（turn 入口已回填 / 子 agent 从父级继承），
	// 否则回退到「上一轮迭代」存下的同会话冻结前缀。这样首次 turn 内从第 2 轮工具迭代起
	// 即与第 1 轮对齐 → 请求构造端注入 cache_control 断点 → 命中 prompt cache。
	// 注意顺序：先读旧值（上一轮）再写新值，否则会自对齐（恒 true）。
	const parentFork = request.forkContext
		?? (request.sessionId ? host._lastForkContextBySession.get(request.sessionId) : undefined);
	if (request.sessionId) {
		host._lastForkContextBySession.set(request.sessionId, currentFork);
	}
	const forkAligned = prefixCacheAligned(parentFork, effectiveSystemPrompt ?? '', enabledTools);
	// ── 归因：aligned=false 时区分「system 变了」还是「tools 变了」（2026-08-22）──
	// 原日志只有 aligned + 两个指纹值 —— 缓存断了完全不知道该去查提示词还是查工具集。
	// 这里在**不对齐时**额外拆两维：system 单独取指纹、tools 单独取指纹（工具名 diff
	// 直接给出增删项）。刻意只在 !aligned 时计算，对齐路径零额外开销。
	let forkReason = '';
	if (!forkAligned && parentFork) {
		const sysSame = parentFork.systemPrompt === (effectiveSystemPrompt ?? '');
		const parentNames = parentFork.tools.map((t: { name: string }) => t.name).sort();
		const childNames = [...enabledTools].map((t: any) => t.name).sort();
		const added = childNames.filter((n: string) => !parentNames.includes(n));
		const removed = parentNames.filter((n: string) => !childNames.includes(n));
		const toolsSetSame = added.length === 0 && removed.length === 0;
		const parts: string[] = [];
		parts.push(sysSame ? 'system=same' : `system=CHANGED(${parentFork.systemPrompt.length}→${(effectiveSystemPrompt ?? '').length} chars)`);
		if (!toolsSetSame) {
			parts.push(`tools=SET_CHANGED(${parentNames.length}→${childNames.length}` +
				`${added.length ? ` +[${added.slice(0, 8).join(',')}]` : ''}` +
				`${removed.length ? ` -[${removed.slice(0, 8).join(',')}]` : ''})`);
		} else if (sysSame) {
			// 两边工具名集合相同、system 也相同，指纹却不同 → 只能是某个工具的
			// description / inputSchema 变了（指纹含这两项）。这类漂移最隐蔽。
			parts.push('tools=SCHEMA_CHANGED(same names, different description/inputSchema)');
		} else {
			parts.push('tools=same');
		}
		forkReason = ` reason=[${parts.join(' ')}]`;
	}
	host._logService.info(
		`[AgentOS] Fork prefix-cache: aligned=${forkAligned} ` +
		`parentFp=${parentFork?.toolsFingerprint ?? '(none)'} ` +
		`childFp=${currentFork.toolsFingerprint} session=${request.sessionId ?? '(none)'}${forkReason}`,
	);
	return parentFork;
}
