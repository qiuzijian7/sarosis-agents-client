/*---------------------------------------------------------------------------------------------
 *  Turn Event Sink — 把 turn 的增量输出从「生成器 yield」解耦为「回调 emit」。
 *
 *  ⚠ 存在理由（拆分 agentTurnExecutor 的唯一前置条件）
 *  ────────────────────────────────────────────────────────────────────────────
 *  `executeAgentTurnDirect` 是 4099 行的 async generator，体内有 79 处**裸
 *  `yield`** 直接发射 `IChatStreamDelta`。裸 yield 是拆分的硬障碍：
 *
 *    · 任何含裸 yield 的代码段都**只能**留在 generator 里；搬到别的模块就必须
 *      把那个模块也写成 `async function*` 再 `yield*` 回来 —— 行数挪走了，
 *      调用链反而更深，测试也没变简单（测一个片段仍需驱动整条生成器）。
 *    · 相比之下 `emit` 是普通函数参数：可注入 mock、可断言事件序列、被调用的
 *      步骤函数是普通 `async function`，能直接 export 出去单测。
 *
 *  对标 pi（`G:/CustomWorkspaces/AIProjects/pi`）
 *  ────────────────────────────────────────────────────────────────────────────
 *  pi 的循环内核**没有生成器**：`runLoop`（`packages/agent/src/agent-loop.ts:156`）
 *  签名是 `(..., emit: AgentEventSink, ...) => Promise<void>`，所有 token delta /
 *  工具事件都走 `await emit({ type: ... })`。生成器只存在于最外层适配：
 *  `agentLoop`（`:32`）不 await 主循环，而是 `void runAgentLoop(...)` 并把 emit
 *  实现为 `stream.push(event)`，返回一个 `EventStream`（`:146-149`）。
 *
 *  `TurnEventSink` 即 pi `AgentEventSink` 的对应物；`asGenerator` 即 pi
 *  `createAgentStream` 的对应物。有了这层，claw 的步骤函数与 pi 的
 *  `(state, ctx) => Promise<Result>` 形状一致，两边可互相移植。
 *
 *  为什么不复用 `DeliveryQueue`
 *  ────────────────────────────────────────────────────────────────────────────
 *  `common/deliveryQueue.ts` 是 **steering 专用**队列：带去重、优先级、容量淘汰
 *  等策略。事件管道要求的是**严格保序、零丢弃、零改写**的透明通道 —— 语义正好
 *  相反。混用会让 steering 的淘汰策略静默吃掉 UI 事件。
 *---------------------------------------------------------------------------------------------*/

import type { IChatStreamDelta } from './providers.js';

/**
 * turn 增量事件的接收端。
 *
 * 对齐 pi `AgentEventSink`（`agent-loop.ts:96` 的 `emit` 参数）。
 *
 * ⚠ 返回 `Promise` 的实现**必须被 await**：`asGenerator` 依赖 emit 的完成时机
 * 施加背压，不 await 会让事件顺序相对于业务逻辑漂移（典型症状：`tool_end`
 * 先于 `tool_start` 到达 UI）。
 */
export type TurnEventSink = (delta: IChatStreamDelta) => void | Promise<void>;

/**
 * 把「回调形态的 run 函数」适配回 `AsyncGenerator`，供既有调用方零改动消费。
 *
 * 语义保证（这三条是替换 79 处裸 yield 的正确性前提）：
 *
 *  1. **保序**：emit 的调用顺序 === 产出顺序，FIFO，无重排。
 *  2. **背压**：`emit` 返回的 Promise 直到该事件被消费者取走后才 resolve。
 *     这是与裸 yield 行为等价的关键 —— 裸 `yield x` 本身就会挂起生成器直到
 *     消费者调用 `next()`。若 emit 立即 resolve，生产侧会跑在消费侧之前，
 *     破坏「yield 之后的代码可假设该事件已被送达」这一既有假设。
 *  3. **返回值透传**：`run` 的解析值成为生成器的 return 值（`TReturn`），
 *     与 `executeAgentTurnDirect` 返回 `AgentCommand | undefined` 的契约一致。
 *
 * 异常与取消：`run` 抛出的错误在事件全部排空后重抛给消费者；消费者提前
 * `break`（触发 generator 的 `return()`）时，`finally` 会解除生产侧的等待，
 * 避免 `run` 永久挂在某次 emit 上泄漏。
 *
 * @param run 业务主体。收到 `emit` 用于发射增量，返回最终结果。
 * @returns 与原生成器行为等价的 `AsyncGenerator`。
 */
export async function* asGenerator<TReturn>(
	run: (emit: TurnEventSink) => Promise<TReturn>,
): AsyncGenerator<IChatStreamDelta, TReturn> {
	/** 待消费事件 + 其「已送达」信号。emit 等在 delivered 上实现背压。 */
	type Pending = { readonly delta: IChatStreamDelta; readonly delivered: () => void };

	const queue: Pending[] = [];
	/**
	 * 已出队、正卡在 `yield` 上等待确认送达的事件。
	 *
	 * 必须独立于 `queue` 持有：消费者在 `yield` 处 `break` 时，generator 会直接
	 * 跳进 `finally`，此时该事件已被 `shift()` 移出队列，靠排空 `queue` 够不到它，
	 * 其 `delivered` 将永不兑现 —— 生产侧 `run` 就永久挂在那一次 emit 上。
	 */
	let inFlight: Pending | undefined;
	/** 消费者在队列空时挂在这里，等生产者 emit 唤醒。 */
	let wakeConsumer: (() => void) | undefined;
	let runSettled = false;
	let runError: unknown;
	let disposed = false;

	const emit: TurnEventSink = (delta) => {
		// 消费者已放弃（break/throw）：静默丢弃后续事件，不能再挂起 —— 否则 run
		// 会永久停在这里，连带 host 侧的 turn 资源无法释放。
		if (disposed) { return; }
		return new Promise<void>((resolveDelivered) => {
			queue.push({ delta, delivered: resolveDelivered });
			wakeConsumer?.();
			wakeConsumer = undefined;
		});
	};

	const runPromise = run(emit).then(
		(value) => { runSettled = true; return value; },
		(error) => { runSettled = true; runError = error; return undefined as TReturn; },
	);
	// 唤醒可能已挂起的消费者：run 结束时队列可能是空的，没有 emit 来唤醒它。
	void runPromise.then(() => { wakeConsumer?.(); wakeConsumer = undefined; });

	try {
		while (true) {
			while (queue.length > 0) {
				const pending = queue.shift()!;
				inFlight = pending;
				yield pending.delta;
				// 先 yield 再放行生产侧：确保「emit 已 resolve」蕴含「消费者已收到」。
				inFlight = undefined;
				pending.delivered();
			}
			if (runSettled) { break; }
			await new Promise<void>((resolveWake) => { wakeConsumer = resolveWake; });
		}

		if (runError !== undefined) { throw runError; }
		return await runPromise;
	} finally {
		// 消费者提前退出时解除所有生产侧等待，防止 run 泄漏。
		disposed = true;
		inFlight?.delivered();
		inFlight = undefined;
		for (const pending of queue) { pending.delivered(); }
		queue.length = 0;
		wakeConsumer = undefined;
	}
}
