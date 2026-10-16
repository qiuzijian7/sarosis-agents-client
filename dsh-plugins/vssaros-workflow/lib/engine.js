// @vssaros/dsh-workflow — engine：Host 侧 worker_threads 能力自证 + worker 生命周期的小工具集。
//
// **v0 的边界（写清楚，免被误读成"引擎已迁完"）**：这里**不是**工作流引擎。方案 6.6 要求把
// VsSaros 的工作流引擎（现跑在渲染进程的 worker 里）迁到 Host 的 worker_threads、Agent 节点改调
// `ctx.agents`/`ctx.subagents`——那是一件大工程。本文件目前只提供：
//   ① `probeWorkerThreads()`：起一个真 worker、拿回 threadId 后立刻终止 —— 把"Host 能承载 worker_threads"
//      这条**前提**变成可断言的事实（真机探针每次都跑）；
//   ② `runWorker()`：一次性的 worker 调用原语（超时 + 强制终止 + 错误回传），供将来迁引擎时复用。
//
// 一处刻意的差别：worker 与 Host **同进程内的不同线程**，所以 `workerData` 只能传结构化克隆得动的东西
// （函数、类实例都不行）。将来传工作流定义要用纯 JSON。

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER_FILE = fileURLToPath(new URL('./worker.js', import.meta.url));

/**
 * 跑一次一次性 worker（拿到首条消息就终止）。
 * @returns `{ ok, message, threadId, ms }` 或 `{ ok: false, error, ms }`（**不抛**——调用方要能把它显示在页面上）
 */
export async function runWorker({ echo = 'ping', job, timeoutMs = 5000 } = {}) {
	const started = Date.now();
	let worker;
	try {
		// `job` 是纯 JSON（结构化克隆 ✓）；不传就是老的"能力自证"回显 ✓
		worker = new Worker(WORKER_FILE, { workerData: job ? { echo, job } : { echo } });
	} catch (e) {
		return { ok: false, error: `worker 启动失败：${String(e?.message ?? e)}`, ms: Date.now() - started };
	}
	try {
		const message = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`worker ${timeoutMs}ms 未回消息`)), timeoutMs);
			worker.once('message', value => {
				clearTimeout(timer);
				resolve(value);
			});
			worker.once('error', error => {
				clearTimeout(timer);
				reject(error);
			});
			worker.once('exit', code => {
				clearTimeout(timer);
				reject(new Error(`worker 提前退出（code ${code}）`));
			});
		});
		return { ok: true, message, threadId: message?.threadId, ms: Date.now() - started };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e), ms: Date.now() - started };
	} finally {
		// 一次性原语：无论成功失败都终止线程（否则 Host 会攒下悬挂线程）
		void worker.terminate();
	}
}

/**
 * 让 worker **真的干活**的第一步：在**线程内**读文件 + 解析工作流定义（复用纯函数 `core.parseWorkflow` ✓）。
 *
 * 为什么从这一步开始：方案要求把 VsSaros 的工作流引擎（现跑在渲染进程的 worker 里）迁到 Host 的
 * `worker_threads`，而"线程里能不能**拿到并解析**工作流定义"是那件事**第一个不可回避的前提** ——
 * 现在它是**可断言的事实** ✓，而不是等到真迁执行时才撞上的坑。
 *
 * 刻意不做：执行 / Agent 节点（要 `ctx.agents` / `ctx.subagents` 接线 ✓）/ 运行态与产物落盘 ✓。
 * @returns `{ ok, summary?, error?, threadId?, ms }`（**不抛** —— 调用方要能直接把它显示出来 ✓）
 */
export async function runWorkflowLoad({ path, id, timeoutMs = 8000 } = {}) {
	const result = await runWorker({ job: { type: 'load', path, id }, timeoutMs });
	if (!result.ok) {
		return { ok: false, error: result.error, ms: result.ms };
	}
	const message = result.message ?? {};
	return {
		ok: message.ok === true,
		...(message.ok === true
			? { summary: message.summary }
			: { error: String(message.error ?? '工作流加载失败（worker 未说明原因）') }),
		threadId: result.threadId,
		ms: result.ms,
	};
}

/** 能力自证：Host 进程能不能起 worker_threads（真机探针与页面都调它）。 */
export async function probeWorkerThreads({ echo = 'vssaros-workflow' } = {}) {
	const result = await runWorker({ echo, timeoutMs: 8000 });
	if (!result.ok) {
		return { ok: false, error: result.error, ms: result.ms };
	}
	return {
		ok: result.message?.echo === echo && typeof result.threadId === 'number' && result.threadId > 0,
		threadId: result.message?.threadId,
		pid: result.message?.pid,
		echo: result.message?.echo,
		ms: result.ms,
	};
}
