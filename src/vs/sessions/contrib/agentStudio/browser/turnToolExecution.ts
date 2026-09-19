/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具执行三段式骨架（prepare → execute → finalize）。
 *
 * ## 为什么需要本模块
 *
 * `agentTurnExecutor.ts` 有**三条**工具执行路径，各自重复了权限拦截与结果后处理：
 *
 * | 路径 | 位置 | 说明 |
 * |---|---|---|
 * | headSerial | `:4384` | delegate 分区拆分后的非 delegate 前置串行段 |
 * | parallelStreaming | `:4426` | 并行流式路径 |
 * | serial | `:4451` | 保守默认串行路径 |
 *
 * headSerial 与 serial 的「沙箱违规 → 弹确认 → 等决策 → 重执行」两段近乎逐字
 * 重复（各约 30 行），而并行路径**完全没有**这段 —— 这正是名单式重复实现必然
 * 产生的行为分叉。
 *
 * pi 的做法（`agent-loop.ts:607 / :677 / :720`）把单个工具调用的生命周期切成三个
 * 阶段函数，批次策略（串行 / 并行）只决定**怎么编排**这三段，而不重复实现它们。
 *
 * 本模块**只保留收尾阶段** `finalizeToolCall`（对齐 pi `:720`：沙箱确认 / 结果字段
 * 合并 / 错误兜底），三条执行路径共用它，行为分叉由此消除。前两段（准备 / 执行）
 * 曾照搬 pi 骨架，因与生产形状不匹配已于 2026-09-17 删除 —— 理由见下方删除注释。
 *
 * 另外移植 pi `agent-loop.ts:379-404` 的 `stopReason === 'length'` 截断保护：
 * 流式工具参数用「尽力而为」的 JSON 抢救解析器收尾，被输出上限截断的消息可能
 * 产出**参数能解析、也能通过校验、但内容静默不完整**的工具调用。这类调用一个都
 * 不能执行，必须逐个报错让模型重发。
 *
 * ## 设计约束
 *
 * 阶段函数保持**依赖注入**而非直接摸 `host`：`finalizeToolCall` 的副作用全部通过
 * 显式 deps 接口传入，使其可以在没有 AgentOS 实例的情况下单测。
 *
 * @module agentStudio/turnToolExecution
 */

/** 工具调用的最小形状（与 `toolCallUtils.ts` 的 `IToolCallInfo` 结构兼容）。 */
export interface ITurnToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: unknown;
}

/** 工具执行结果的最小形状（与执行器回传结构兼容）。 */
export interface ITurnToolResult {
	toolCallId: string;
	content: unknown;
	success: boolean;
	metadata?: Record<string, unknown>;
	/** 整批终止信号（`shouldTerminateToolBatch` 消费）。 */
	terminate?: boolean;
}

/** 构造错误结果 —— 对齐 pi `createErrorToolResult`（`agent-loop.ts:767`）。 */
export function createErrorToolResult(call: ITurnToolCall, message: string): ITurnToolResult {
	return {
		toolCallId: call.id,
		content: message,
		success: false,
	};
}

/**
 * ─── 曾有 `prepareToolCall` / `executePreparedCall` / `resolveToolExecutionMode`，
 * 2026-09-17 删除 ───────────────────────────────────────────────────────────
 *
 * 三者是照搬 pi 三段式（`agent-loop.ts:607 / :677`）的前两段，实现与单测齐全但
 * **生产零消费**。删除而非接线，是因为生产侧的准备阶段与它们的形状根本对不上：
 *
 * | 维度 | 已删函数的假设 | `agentTurnExecutor.ts` 实际 |
 * |---|---|---|
 * | 粒度 | 逐调用，返回 prepared/immediate | 批次级，filter 出 allowed/denied 两个数组 |
 * | 判据数 | 5 | 7 —— 多出 ping-pong、工具循环、护栏 no-progress |
 * | 判据性质 | 全是单调用属性 | ping-pong 是**整批**属性（命中则全批拦截） |
 * | 副作用 | 纯函数 | 过滤途中 `reduceRunState(RECORD_TOOL_CALL)`、`patchGuardrails` |
 * | 拦截产出 | 一个 reason 枚举 | 逐个 yield tool_start/result/end + append message + 三档升级 |
 *
 * 三个硬冲突（任一都足以否掉接线）：
 *  1. `prepareToolCall(call, deps)` 签名里没有「整批」概念，ping-pong 表达不了；
 *     靠 deps 闭包捕获外部标志 = 没收口。
 *  2. `RECORD_TOOL_CALL` 必须在过滤过程中写入（无论是否 loop 都记录），且
 *     `streakKey` 依赖 `thinkingContent` —— 纯函数做不到。
 *  3. `hard-permission-denied` 在生产侧含**计划文件豁免**，需要「拒绝但豁免」
 *     第三态，`denyReason: () => string | undefined` 的两态返回值装不下。
 *
 * `executePreparedCall` 同样对不上：生产有三条执行路径（headSerial / 并行流式 /
 * serial），host 侧接口是**批量** `_executeToolCalls(calls)` 与
 * `_executeToolCallsParallelStreaming(calls)`，没有「执行单个已准备调用」的语义。
 *
 * `resolveToolExecutionMode` 是 `prepareToolCall` 的唯一消费者，随之删除。
 * 注意 `IToolDefinition.executionMode`（`common/providers.ts:1186`）**仍然保留**：
 * 那是声明式顺序性迁移的目标形态，只是现存工具尚无一个声明，判据还全靠
 * `agentTurnExecutor.ts` 的名单（`CHURN_MULTI_TARGET_WRITE_TOOLS` 等）兜底。
 *
 * ⚠ 不要因为「pi 有三段式而我们只剩一段」就把它们加回来。留在生产的是
 * `finalizeToolCall` —— 它能接线恰恰因为收尾阶段确实是逐调用、且原本有三份
 * 重复实现可消。前两段没有这个前提。
 */

/** 执行阶段产出。 */
export interface IToolExecutionOutcome {
	readonly call: ITurnToolCall;
	readonly result: ITurnToolResult;
}

/** 沙箱决策的最小形状（真实类型见 host `_awaitSandboxConfirmation`）。 */
export interface ISandboxResolution {
	readonly decision: unknown;
	readonly reExecuted?: ITurnToolResult;
}

/**
 * 收尾阶段依赖。
 *
 * `TDelta` 泛型化而非直接用 `IChatStreamDelta`：本模块不构造任何 delta，只把
 * `resolveSandbox` 产出的流**原样转发**，故无需知道其形状。好处是单测可以用
 * 字符串当 delta，不必伪造完整的 provider 类型。
 */
export interface IToolFinalizationDeps<TDelta> {
	/**
	 * 是否为沙箱违规结果。
	 *
	 * 三条路径原先各自内联 `!sr.success && host._isSandboxViolation(sr) &&
	 * !handledSandboxIds.has(sr.toolCallId)` —— 其中 `handledSandboxIds` 去重
	 * 由本模块统一持有，调用方不再各存一份 Set。
	 */
	readonly isSandboxViolation: (result: ITurnToolResult) => boolean;
	/**
	 * 弹确认卡片、等用户决策、按决策重执行 —— 整个交互由调用方注入。
	 *
	 * 是 **async generator** 而非 `Promise`：这段交互必须「先把确认卡片推给 UI，
	 * 再阻塞等用户点按钮」，即在一次 await 的前后各推一个 delta。`Promise` 只能
	 * 在 resolve 后一次性交还控制权，卡片就会在决策**之后**才出现在 UI 上。
	 */
	readonly resolveSandbox: (
		call: ITurnToolCall,
		result: ITurnToolResult,
	) => AsyncGenerator<TDelta, ISandboxResolution, void>;
	/** 结果观测（对应 host `_observeToolResult`）。 */
	readonly observe?: (call: ITurnToolCall, result: ITurnToolResult) => void;
}

/**
 * 收尾阶段 —— 对齐 pi `finalizeExecutedToolCall`（`agent-loop.ts:720`）。
 *
 * 承接原三条路径重复的沙箱确认段（headSerial / serial 各约 25 行逐字重复，
 * 而并行路径**完全没有**这段 —— 同一个沙箱违规走并行路径时用户拿不到确认卡片，
 * 工具直接失败。收口到此处即消除该行为分叉）。
 *
 * `handledSandboxIds` 在此集中去重：同一 toolCallId 一轮内只提示一次，重执行后
 * 若仍被拦截则直接保留失败，避免重提示死循环。
 *
 * 本函数是 async generator，产出值为 `resolveSandbox` 转发的 delta，**返回值**
 * 才是最终结果 —— 调用方须用 `const outcome = yield* finalizeToolCall(...)`
 * 接收，写成 `for await` 会丢掉返回值。
 *
 * @param handledSandboxIds 跨批次共享的去重集合，由调用方按迭代创建。
 */
export async function* finalizeToolCall<TDelta>(
	executed: IToolExecutionOutcome,
	deps: IToolFinalizationDeps<TDelta>,
	handledSandboxIds: Set<string>,
): AsyncGenerator<TDelta, IToolExecutionOutcome, void> {
	let finalResult = executed.result;

	const needsSandbox = deps.isSandboxViolation(finalResult)
		&& !handledSandboxIds.has(finalResult.toolCallId);

	if (needsSandbox) {
		handledSandboxIds.add(finalResult.toolCallId);
		const resolution = yield* deps.resolveSandbox(executed.call, finalResult);
		if (resolution.reExecuted) {
			finalResult = resolution.reExecuted;
		}
	}

	deps.observe?.(executed.call, finalResult);
	return { call: executed.call, result: finalResult };
}

/**
 * 截断保护 —— 移植 pi `failToolCallsFromTruncatedMessage`（`agent-loop.ts:379-404`）。
 *
 * 触发条件：assistant 消息因输出 token 上限被截断（`stopReason === 'length'`）
 * 且仍带出了工具调用。流式参数由「尽力而为」的 JSON 抢救解析器收尾，故这些调用
 * 的参数**可能解析通过、校验通过，但内容静默不完整** —— 一个都不能执行。
 *
 * 逐个产出错误结果，让模型看到明确原因并用完整参数重发。
 */
export function failToolCallsFromTruncatedMessage(calls: readonly ITurnToolCall[]): IToolExecutionOutcome[] {
	return calls.map(call => ({
		call,
		result: createErrorToolResult(
			call,
			`Tool call "${call.name}" was not executed: the response hit the output token limit, `
			+ 'so its arguments may be truncated. Re-issue the tool call with complete arguments.',
		),
	}));
}

/**
 * 是否需要启用截断保护。
 *
 * 独立成谓词而非内联，因为 provider 对 finishReason 的拼写不统一
 * （`length` / `max_tokens` 都表示同一件事），判据必须只有一处。
 */
export function isTruncatedByOutputLimit(stopReason: string | undefined): boolean {
	return stopReason === 'length' || stopReason === 'max_tokens';
}
