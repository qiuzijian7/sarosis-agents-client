/*---------------------------------------------------------------------------------------------
 *  mainThreadWatchdog.ts — 主线程「停更」看门狗（2026-10-22，卡死取证用）
 *
 * ## 为什么必须是**独立 worker**
 *
 * 主线程被 native 调用阻塞时（`Runtime.evaluate` 不回复、CPU 0%、所有定时器停摆），
 * **主线程自己什么都做不了** —— 想落盘一行诊断也做不到 ✗。唯一还能跑的是**另一条线程**。
 * 于是：worker 每秒读一次 `mainThreadBreadcrumb` 的共享槽，
 *   · 主线程还在动 ⇒ 时间戳在更新 ⇒ 什么都不做（零成本）；
 *   · 主线程停更 > `stallMs`（默认 **8000ms**）⇒ 追加一行到 `main-hang.log`：
 *     **最后阶段 + 停更时长 + 进程 CPU 占用率 + RSS**。
 *
 * `cpu=%` 是判读的关键（process-wide，worker 读得到）：
 *   · ≈0% ⇒ **在等**（锁 / IO / 子进程 / 同步 IPC）—— 三期卡死都是这一类；
 *   · 高   ⇒ **在算**（某个 O(n²) 或超大序列化）⇒ 方向完全不同。
 *
 * ## 现场怎么读
 *
 * ```
 * # <logsHome>/main-hang.log
 * [2026-10-22T19:46:36.201Z] STALL 8s phase=credit-route cpu=0% rss=730MB pid=117980
 * ```
 * ⇒ "主线程进 `credit-route` 之后停更 8 秒、期间 CPU 0%" ⇒ 直接指向那段代码。
 *
 * ⚠ 设计约束：worker 用 `eval: true` 内联源码（**不新增构建入口** —— 主进程是 esbuild
 * 单文件 bundle，多一个 worker 文件就要多一条构建产物，得不偿失 ✗）；`unref()` 不阻止退出。
 *--------------------------------------------------------------------------------------------*/

import { Worker } from 'node:worker_threads';
import { Disposable, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { ILogService } from '../../platform/log/common/log.js';
import { initMainThreadBreadcrumb, MAIN_PHASES } from './mainThreadBreadcrumb.js';

export const MAIN_WATCHDOG_TAG = '[MainWatchdog]';

export interface IMainThreadWatchdogOptions {
	/** 诊断落盘路径（`<logsHome>/main-hang.log`）。 */
	readonly logPath: string;
	/** 停更多久算卡死（默认 8000ms）。 */
	readonly stallMs?: number;
	/** worker 轮询间隔（默认 1000ms）。 */
	readonly checkMs?: number;
}

/**
 * worker 内联源码（**纯 JS**，不能用 TS 语法 —— `eval: true` 直接执行）。
 *
 * 只做三件事：读共享槽 / 判停更 / append 一行。**不 require 任何本项目模块**（隔离 ✓）。
 */
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { buffer, phases, logPath, stallMs, checkMs } = workerData;
const slots = new BigInt64Array(buffer);
let reportedAt = 0;
let lastCpu = process.cpuUsage();
let lastAt = Date.now();
const timer = setInterval(() => {
	const phase = Number(Atomics.load(slots, 0));
	const at = Number(Atomics.load(slots, 1));
	const stall = Date.now() - at;
	if (stall < stallMs) { reportedAt = 0; return; }
	if (at === reportedAt) { return; }
	reportedAt = at;
	const nowCpu = process.cpuUsage();
	const wallMs = Math.max(1, Date.now() - lastAt);
	const cpuMs = ((nowCpu.user - lastCpu.user) + (nowCpu.system - lastCpu.system)) / 1000;
	const cpuPct = Math.round((cpuMs / wallMs) * 100);
	const line = '[' + new Date().toISOString() + '] STALL ' + Math.round(stall / 1000) + 's'
		+ ' phase=' + (phases[phase] || ('#' + phase))
		+ ' cpu=' + cpuPct + '%'
		+ ' rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB'
		+ ' pid=' + process.pid + '\\n';
	try { fs.appendFileSync(logPath, line); } catch (e) { /* 落盘失败也别炸 worker */ }
	lastCpu = nowCpu;
	lastAt = Date.now();
}, checkMs);
// ⚠ **不许** unref：worker 里除了这个 timer 没有任何 ref ⇒ unref 会让 worker 立刻退出，
//   看门狗静默失效（实测：一条 STALL 都抓不到 ✗）。生命周期由主线程 dispose() 的 terminate() 决定 ✓。
`.trim();

/**
 * 启动看门狗（应在主进程**日志设施就绪之后**调用，与 `startMainHeartbeat` 并列）。
 *
 * 关掉：`SAROSIS_MAIN_WATCHDOG=0`；调参：`SAROSIS_MAIN_WATCHDOG_STALL_MS`。
 */
export function startMainThreadWatchdog(logService: ILogService, options: IMainThreadWatchdogOptions): IDisposable {
	if (process.env['SAROSIS_MAIN_WATCHDOG'] === '0') {
		return Disposable.None;
	}
	const envStall = Number(process.env['SAROSIS_MAIN_WATCHDOG_STALL_MS']);
	const stallMs = options.stallMs ?? (Number.isFinite(envStall) && envStall > 0 ? envStall : 8_000);
	const checkMs = options.checkMs ?? 1_000;
	const buffer = initMainThreadBreadcrumb();

	let worker: Worker;
	try {
		worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: { buffer, phases: MAIN_PHASES, logPath: options.logPath, stallMs, checkMs },
		});
	} catch (err) {
		// 看门狗起不来不能拖垮启动（它只是取证工具 ✓）
		logService.warn(`${MAIN_WATCHDOG_TAG} 启动失败（不影响业务）：${err instanceof Error ? err.message : String(err)}`);
		return Disposable.None;
	}
	worker.on('error', err => logService.warn(`${MAIN_WATCHDOG_TAG} worker error: ${err instanceof Error ? err.message : String(err)}`));
	worker.unref();

	logService.info(`${MAIN_WATCHDOG_TAG} started: stall>= ${stallMs}ms check=${checkMs}ms → ${options.logPath}`);

	return toDisposable(() => { void worker.terminate(); });
}
