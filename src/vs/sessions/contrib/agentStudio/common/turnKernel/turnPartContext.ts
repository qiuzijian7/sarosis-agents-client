/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turn Part 的公共契约 —— 装配件（L1）与驱动层（L2）之间的唯一边界。
 *
 * ## 为什么需要这一层
 *
 * `agentTurnExecutor.ts` 的主函数体内有约 1300 行内联闭包，它们靠**词法捕获**
 * 读写 `messages` / `runState` / `guardrails` 等十余个可变量。这使得任何一段都
 * 无法单独实例化 —— 既不能单测，也不能被另一个驱动（如 pi 的 `agentLoop`）复用。
 *
 * 本模块把那些捕获显式化为两个入参：
 *   · `deps`  —— 本轮不变的依赖（只读，构造一次）
 *   · `state` —— 可变状态的**受控读写面**（getter + 显式 setter）
 *
 * ## 为什么是 getter 而不是直接传值
 *
 * 因为 `messages` 在主循环内被**重绑定**（`messages = appendMessages(...)`），
 * 且部分下游会**原地改写**数组。若按值传入，装配件拿到的是调用时刻的旧引用，
 * 中间态会静默丢失。`turnIterationGate.IIterationGateState` 已用 getter 范式
 * 解决过同一问题（见该文件 `:22-26` 的成文论证），本契约是它的推广而非新发明。
 *
 * ## 与 pi 的对应关系
 *
 * `ITurnPartDeps` 的字段集刻意贴近 pi 的 `AgentLoopConfig`（`pi/packages/agent/src/types.ts`）
 * 所暴露的上下文，使同一批装配件既能被内置 while 内核驱动，也能注册为 pi 的
 * config 回调。两处差异（pi 的 transcript 是 branded 类型、回调禁止 throw）由
 * 驱动层适配器吸收，装配件本身不感知。
 *
 * @module agentStudio/turnKernel/turnPartContext
 */

import type { IAgentTurnRequest, IModelProvider, IModelSelection, IToolDefinition } from '../providers.js';
import type { AgentGuardrailCounters, AgentRunMessage, AgentRunState, AgentWrapUpState } from '../agentRunState.js';
import type { ITurnLoopState } from '../turnLoopState.js';
import type { IterationBudget } from '../iterationBudget.js';
import type { TurnHookBus } from '../turnHookBus.js';
import type { DeliveryQueue } from '../deliveryQueue.js';

/**
 * 装配件共同需要的最小日志面。
 *
 * 刻意不用 `ILogService`：那是带 `_serviceBrand` 的完整服务接口，装配件只写
 * 四个级别。窄接口让「本段实际用了什么」可见，也让测试 stub 保持三行。
 */
export interface ITurnPartLog {
	info(message: string): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string | Error, ...args: unknown[]): void;
	debug?(message: string): void;
}

/**
 * 本轮不变的依赖（只读）。
 *
 * 构造一次、贯穿整个 turn。任何**逐轮变化**的量都不属于这里 —— 它们在
 * `ITurnPartState` 里通过 getter 暴露，否则装配件会读到过期快照。
 */
export interface ITurnPartDeps {
	readonly log: ITurnPartLog;
	readonly request: IAgentTurnRequest;

	/** 本轮 LLM 通道。无 provider 时主流程已走降级，装配件可假定非空。 */
	readonly modelProvider: IModelProvider;
	readonly selection: IModelSelection;

	/** 循环级可变状态容器（字段本身可变，容器引用不变）。 */
	readonly loopState: ITurnLoopState;
	readonly budget: IterationBudget;
	readonly hookBus: TurnHookBus;

	/** 中途插话队列；无插话通道时为 undefined。 */
	readonly steeringQueue: DeliveryQueue | undefined;

	/** 本 turn 的中止信号（每 turn 独立 controller）。 */
	readonly turnAbortSignal: AbortSignal;

	/** 本 turn 起始时间戳（ms），软预算计时基准。 */
	readonly turnStartedAt: number;
}

/**
 * 可变状态的受控读写面。
 *
 * ## 硬约束：装配件内禁止 `let messages = ...`
 *
 * 所有消息变更必须走 `setMessages`。装配件若自持一份局部绑定，调用方看不到
 * 变更，而后续段又会基于调用方的旧引用继续追加 —— 表现为消息丢失或重复。
 * 这是 `turnIterationGate` 当初改用回调的原因，此处沿用同一纪律。
 */
export interface ITurnPartState {
	/** 当前消息数组。每次变更后必须立即 `setMessages` 回写。 */
	messages(): AgentRunMessage[];
	setMessages(next: AgentRunMessage[]): void;

	/** 本轮生效的工具面（可被策略覆盖，收尾轮清空）。 */
	enabledTools(): IToolDefinition[];
	setEnabledTools(next: IToolDefinition[]): void;

	/** 运行状态快照读取（真相源是 reducer 持有的 runState）。 */
	runState(): AgentRunState;

	/** 收尾门控状态（真相源在 `runState.wrapUp`）。 */
	wrapUp(): AgentWrapUpState;
	patchWrapUp(patch: Partial<AgentWrapUpState>): void;

	/** 工具级护栏计数器。 */
	guardrails(): AgentGuardrailCounters;

	/**
	 * 护栏计数补丁。
	 *
	 * ⚠ 调用方必须保持「patch 后立刻比较阈值」的原子序。把 patch 攒起来批量
	 * 提交会让同一批内的后续判定读到过期计数，护栚静默失效 —— 三个连续计数
	 * （连续失败 / 终态空输出 / 文本搜索连击）都依赖这条时序。
	 */
	patchGuardrails(patch: Partial<AgentGuardrailCounters>): void;
}

/**
 * 装配件的完整上下文。
 *
 * 装配件签名统一为 `(ctx: ITurnPartContext, ...本段特有参数)`，便于驱动层
 * 用同一个 ctx 串起全部装配件，也便于测试用一个 stub 覆盖全部段。
 */
export interface ITurnPartContext {
	readonly deps: ITurnPartDeps;
	readonly state: ITurnPartState;
}
