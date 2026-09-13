/**
 * 计数信号量 —— 多 agent 协同的**并发闸门**。
 *
 * ## 为什么需要（设计来源：open-multi-agent `utils/semaphore.ts`）
 *
 * 画布现有并行模式（`runGraphExecutionParallel`）按「层」barrier 执行：同层节点
 * 用 `runConcurrent(…, parallelConcurrency)` 一次性扇出。这在**静态图**上没问题，
 * 但多 agent 协同有两个场景会失效：
 *   1. **动态派发**：运行期新增的 agent（委派/主管模式）不在预建层里，无处挂并发限制；
 *   2. **异构资源池**：provider 步骤（可并发 4）与 ComfyUI 步骤（必须串行）需要
 *      **各自独立的闸门**，而不是共用一个数字。
 *
 * 信号量把「并发上限」从「层调度的一次性参数」变成**可长期持有的资源凭证**：
 * 任何时刻、任何来源的任务都经 `run()` 进入，池满即排队，天然支持运行期插入。
 *
 * 实现要点：FIFO 队列 + 释放时**直接把槽位交给下一个等待者**（不先减后加），
 * 保证不会出现「释放瞬间被新任务插队」的饥饿问题。
 */

export interface Semaphore {
	/** 当前占用中的槽位数。 */
	readonly active: number;
	/** 等待中的任务数。 */
	readonly pending: number;
	/** 当前上限（可运行时调整，如按 provider 限流动态收紧）。 */
	readonly max: number;
	/** 占用一个槽位（池满则排队等待）。 */
	acquire(): Promise<void>;
	/** 释放一个槽位（有等待者则直接移交）。 */
	release(): void;
	/** acquire → fn → release 的便捷包装（fn 抛错也保证释放）。 */
	run<T>(fn: () => Promise<T>): Promise<T>;
	/** 运行时调整上限（收紧不会打断已占用者，只影响后续 acquire）。 */
	setMax(next: number): void;
}

export function createSemaphore(max: number): Semaphore {
	if (!Number.isFinite(max) || max < 1) {
		throw new Error(`createSemaphore: max 必须是 >= 1 的有限数（收到 ${String(max)}）`);
	}
	let limit = Math.floor(max);
	let current = 0;
	const waiters: Array<() => void> = [];

	const acquire = (): Promise<void> => {
		if (current < limit) {
			current++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => { waiters.push(resolve); });
	};

	const release = (): void => {
		const next = waiters.shift();
		if (next) {
			// 槽位**移交**给等待者：current 不变，避免「先减后加」窗口被插队
			next();
			return;
		}
		current = Math.max(0, current - 1);
	};

	return {
		get active() { return current; },
		get pending() { return waiters.length; },
		get max() { return limit; },
		acquire,
		release,
		async run<T>(fn: () => Promise<T>): Promise<T> {
			await acquire();
			try {
				return await fn();
			} finally {
				release();
			}
		},
		setMax(next: number): void {
			if (!Number.isFinite(next) || next < 1) { return; }
			limit = Math.floor(next);
			// 放宽上限：把新增的槽位立即发给等待者（若原来卡在旧上限）
			while (current < limit && waiters.length > 0) {
				current++;
				const w = waiters.shift();
				w?.();
			}
		},
	};
}

/**
 * 并发池：对一组任务按 `concurrency` 限流执行，返回**顺序对齐**的结果数组。
 *
 * 与 `Promise.all` 的区别：不会一次性把所有任务铺开（避免瞬时 N 个 LLM 请求）；
 * 与「分层 barrier」的区别：任务完成即释放槽位给下一个（无层间空等）。
 * 单个任务抛错 → 该位置返回 `{ ok:false, error }`，**不中断其他任务**
 * （对齐 open-multi-agent `runParallel` 的 `allSettled` 语义：失败也要回填）。
 */
export async function runPooled<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
	const sem = createSemaphore(Math.max(1, Math.min(concurrency, items.length || 1)));
	const out: Array<{ ok: true; value: R } | { ok: false; error: Error }> = new Array(items.length);
	await Promise.all(items.map((item, index) => sem.run(async () => {
		try {
			out[index] = { ok: true, value: await fn(item, index) };
		} catch (err) {
			out[index] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
		}
	})));
	return out;
}
