// @vssaros/dsh-memory — 后台任务队列（把 fire-and-forget 变成**可控**的）。
//
// 为什么需要它：`agent/turn-stopping` 是 `@mode serial` 且**会被 await**（官方契约原话
// "Awaited before the boundary commits"，见 `lib/index.js` 的钩子注释 ✓）⇒ 钩子里只能
// fire-and-forget 把活排到后台。但**裸的 `void (async () => …)()` 有三个洞**：
//   ① **没有并发上限** —— 连续几个回合会在同一刻打出多份请求（对本地网关、对模型都是压力 ✗），
//      而"回合密度"用户完全不可控（一次连续对话就是十几个回合 ✓）；
//   ② **没有超时** —— 一个挂住的请求会永久占住一个并发槽 ⇒ 后续任务全被堵死 ✗
//      （没超时的队列比没有队列更危险：它把"偶尔慢"变成"永久停" ✗）；
//   ③ **不可观测** —— "后台到底失败了几次"只能靠翻日志 ✗。
// 本文件就补这三样：**并发上限 + 每任务超时 + 计数**。
//
// ⚠ 溢出策略：**拒新的、不丢旧的** ✓ —— 队列满时丢掉"用户刚制造的那件事"，比丢掉一件陈年
// 待办糟糕得多（与草稿治理的取舍同向：旧的可丢、新的不可丢 ✓）。
// ⚠ 零依赖、全注入（`now` / `logger` / `onSettle`）⇒ 探针能**同步驱动**它，不必等真实时钟 ✓。
//
// ⚠ 与 `lib/index.js` 里那条钩子的关系：钩子仍然**同步返回**（契约要求 ✓）；本队列只是让
// "返回之后发生什么"变得有界、可测 ✓。

/**
 * 建一个后台任务队列。
 *
 * ⚠⚠ **`unrefTimers` 这个开关踩过坑**（2026-10-13 实测，见 `p3-50`）：超时定时器默认 `unref`
 *（理由：后台队列不该拖着 headless 一次性任务不退出 ✓ —— 这与 `mock-llm.mjs:143-147` 记的
 * "headless 跑完一回合就退出" 是同一件事 ✓）。**但**当那个定时器是进程里**唯一**待处理的句柄时，
 * Node 会认为无事可做 ⇒ **直接退出**、超时永不 fire ⇒ 表现为 `Detected unsettled top-level await`
 * 并在 `await hangResult` 处**静默死掉** ✗✗（探针里就这么中了一次）。
 * ⇒ 所以它必须是**可注入的**：生产用默认 `true`（不拖住退出 ✓）、探针/测试用 `false`（确定性 ✓）。
 *
 * @param {{concurrency?: number, timeoutMs?: number, maxPending?: number, logger?: {warn?: Function},
 *   now?: () => number, unrefTimers?: boolean}} [options] - 配置。
 * @returns {{push: (task: Function) => Promise<{ok: boolean, value?: unknown, error?: string, skipped?: string}>,
 *   stats: () => object, size: () => number, idle: () => Promise<void>}} 队列。
 */
export function createTaskQueue(options = {}) {
	const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : 1;
	const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000;
	const maxPending = Number.isInteger(options.maxPending) && options.maxPending > 0 ? options.maxPending : 16;
	const unrefTimers = options.unrefTimers !== false;
	const logger = options.logger;
	const now = typeof options.now === 'function' ? options.now : Date.now;

	/** 待跑的任务（`{task, resolve}`）。 */
	const pending = [];
	/** 正在跑的并发数。 */
	let running = 0;
	let warnedOnce = false;
	const stats = { pushed: 0, settled: 0, failed: 0, timedOut: 0, dropped: 0, maxRunning: 0 };

	const warnOnce = message => {
		if (warnedOnce) { return; }
		warnedOnce = true;
		try { logger?.warn?.(`[vssaros-memory] 后台队列：${message}（后续同类不再重复报告）`); } catch { /* 绝不再抛 ✓ */ }
	};

	/** 跑一个任务（带超时）；**任何情况都不抛** —— 它跑在后台，异常必须就地消失 ✓。 */
	async function run(entry) {
		running++;
		stats.maxRunning = Math.max(stats.maxRunning, running);
		let timer = null;
		try {
			// ⚠ 超时用 `Promise.race` + 一个**会 settle 的**超时 promise：这样即使任务本身永不返回，
			// 这个槽位也会被释放 ✓（"永远挂住"是 ② 那个洞的本质 ✗）。
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`后台任务超时（${timeoutMs}ms）`)), timeoutMs);
				// ⚠ 默认 unref（不拖着进程不退出 ✓），**但探针必须传 `unrefTimers: false`** ——
				// 否则当它是进程里唯一的待处理句柄时，Node 直接退出、超时永不 fire ✗✗（文件头有完整的坑记录）
				if (unrefTimers && typeof timer?.unref === 'function') { timer.unref(); }
			});
			const value = await Promise.race([Promise.resolve().then(entry.task), timeout]);
			stats.settled++;
			entry.resolve({ ok: true, value });
		} catch (error) {
			const message = String(error?.message ?? error);
			if (/后台任务超时/.test(message)) { stats.timedOut++; } else { stats.failed++; }
			warnOnce(message);
			entry.resolve({ ok: false, error: message });
		} finally {
			if (timer !== null) { clearTimeout(timer); }
			running--;
			pump();
		}
	}

	/** 把等待中的任务填到并发上限。 */
	function pump() {
		while (running < concurrency && pending.length > 0) {
			void run(pending.shift());
		}
	}

	/**
	 * 排一个任务。
	 * @param {Function} task - 无参函数（可返回 Promise）。
	 * @returns {Promise<{ok: boolean, value?: unknown, error?: string, skipped?: string}>} 结果（**绝不 reject** ✓）。
	 */
	function push(task) {
		if (typeof task !== 'function') {
			return Promise.resolve({ ok: false, error: 'task 不是函数' });
		}
		if (pending.length >= maxPending) {
			stats.dropped++;
			warnOnce(`待跑任务已达上限 ${maxPending}，本条被拒（**拒新的、不丢旧的** ✓）`);
			return Promise.resolve({ ok: false, skipped: 'queue-full' });
		}
		stats.pushed++;
		return new Promise(resolve => {
			pending.push({ task, resolve });
			pump();
		});
	}

	/** 等到"当前所有已排任务"settle（探针用；不做超时保护 ⇒ 调用方自己加 ✓）。 */
	async function idle() {
		while (running > 0 || pending.length > 0) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
	}

	return {
		push,
		idle,
		size: () => pending.length + running,
		stats: () => ({ ...stats, pending: pending.length, running, concurrency, timeoutMs, maxPending, at: now() }),
	};
}
