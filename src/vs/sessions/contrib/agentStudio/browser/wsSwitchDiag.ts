/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作区切换「卡住」诊断（2026-09-16，用户报「每次切换工作区时 app 就卡住」）。
 *
 * ── 为什么需要一套专门的探针 ──────────────────────────────────────────────
 *
 * 用户给的 `vscode-app-1789531766651.log`（6969 行）有两个致命的信息缺口：
 *
 *  ① **没有时间戳** —— 本仓日志格式是 `file:line  LEVEL [Tag] msg`，只有调用点、没有时间
 *     ⇒ 事后**无法**从日志算出任何一步耗时；
 *  ② **主线程被同步阻塞时日志也 flush 不出去** ⇒ 日志的**最后一行只是阻塞前最后落盘的那条**，
 *     离真正卡住的位置可能还差好几步。
 *
 * 实测那份日志的末几行恰好是切换链的中段：
 * ```
 * [WorkspaceSwitch] entry=sidebar-dropdown | action=initializeWorkspaceInPlace …   ← _enterWorkspaceFile
 * [WorkspaceFolderSync] onDidChangeWorkspaceFolders | added=3 removed=2
 * [CodebaseMemory] _initWorkspaceFileConfig: rootUri=…
 * [AgenticPromptsService] listPromptFiles(type=agent) called                       ← 日志到此为止
 * ```
 * 这条链上**任何一处同步重活**都会造成同样现象：配置模型整套重算（`configurationService
 * .initialize`）、图谱解压+反序列化（实测 8.2MB ⇒ 21.6s / 17.9 万节点，**同步**做在主线程）、
 * 索引 prune、扩展宿主重启…… 只靠「最后一行」无法区分。
 *
 * ── 本模块给的两个互补手段 ────────────────────────────────────────────────
 *
 *  ① `wsStage(name)` —— 极廉价的**阶段标记**（只写一个字符串 + 时间戳，**不落盘**）：
 *     切换链 / 图谱加载在进入下一步前更新它。可以放心放在热路径上。
 *
 *  ② `startMainThreadWatchdog()` —— **主线程看门狗**（默认 200ms 一拍），两个互补指标：
 *     **(a) 漂移**（定时器实际间隔超出 `intervalMs + thresholdMs`）⇒ 抓**连续阻塞**，
 *         `[WsSwitchDiag] ⛔ 主线程阻塞 ≈3230ms（心跳应 200ms）｜阶段=graph: 解析 JSON…｜该阶段已持续 ≈3300ms｜堆=2140MB`
 *     **(b) 排队延迟**（每拍排一个 0ms 任务，量它多久被跑到）⇒ 抓**切片式饱和**，
 *         `[WsSwitchDiag] ⚠ 交互延迟：最近 5s 内最慢一次排队 ≈420ms（样本 25 次；阶段=…）`
 *     两者都**事后补报**（阻塞结束后立刻写，所以一定能落盘）；恢复时再报一条总时长。
 *
 * ★★★ 2026-09-16 实测教训（**为什么必须有 (b)**）：第一版只有 (a)，真机复现「切换后卡住」时
 * **一条都没报** —— 因为最重的那段（`_parseGraphStreaming`，实测 **10.2s / 单 folder**）是
 * **手写逐字符 JSON 解析**且**每 8ms 让出一次**：主线程**没有**连续阻塞，却**被占满了 10s**。
 * 漂移法对「切片式饱和」是**盲的**（定时器照常按时跑，只是每次都要排在 8ms 的活后面），
 * 而 (b) 量到的正是「用户点一下要等多久」，两种形态都能覆盖、还能互相区分（几百 ms vs 几 s）。
 *
 * 为什么不用 `PerformanceObserver('longtask')`：
 *   · 它按「单个任务 ≥50ms」上报 —— **切片式饱和下每个任务只有 8ms** ⇒ 同样看不见（与 (a) 同样的盲区）；
 *   · 且依赖 API 可用性（部分 Electron / 未开启时拿不到）。
 *
 * ── 设计约束 ─────────────────────────────────────────────────────────────
 *  · 诊断**绝不能**影响主流程：所有输出经 `wsDiagLog` 并吞掉异常；
 *  · 常态下**零输出**（只有阻塞超阈值才写）⇒ 不会淹没有效日志；
 *  · 上报有条数上限（`WS_BLOCK_REPORT_MAX`）—— 万一进了「卡住→恢复→又卡住」的循环，
 *    也不会把日志刷爆。
 *
 * 抓取：`Select-String -Pattern '\[WsSwitchDiag\]'`；阶段标记另见 `WS_STAGE_TAG` 前缀常量。
 */

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/** 日志标签（grep 用）。 */
export const WS_DIAG_TAG = '[WsSwitchDiag]';
/** 阶段标记的名字前缀（`wsStage()` 写入的内容，出现在看门狗报告里）。 */
export const WS_STAGE_TAG = 'stage:';

/** 心跳间隔（毫秒）—— 同时是「阻塞时长」的测量粒度。 */
export const WS_HEARTBEAT_MS = 200;
/** 阻塞**上报阈值**（毫秒）：低于它的抖动（GC、大 DOM 更新）不值得写日志。 */
export const WS_BLOCK_REPORT_MS = 2000;
/** 单次会话最多上报多少条「阻塞」记录（防刷屏）。 */
export const WS_BLOCK_REPORT_MAX = 30;

/**
 * **交互延迟**上报阈值（毫秒）：事件循环里排一个最小任务，量它多久才被跑到。
 *
 * ★ 为什么要这个指标（2026-09-16 实测缺口的直接反思）：
 * 第一版只看「**连续**阻塞 ≥ 2s」，结果真机实测**一条都没报** —— 而现象是「切换后卡住几十秒」。
 * 原因：图谱加载里最重的那段（`_parseGraphStreaming`，实测 **10.2s**）是**手写逐字符 JSON 解析**
 * 且**每 8ms 让出一次** ⇒ 主线程**没有**连续阻塞，却**被占满了整整 10s**。
 * 漂移法对「切片式饱和」是盲的：定时器照常按时跑，只是每次跑之前都得排在 8ms 的活后面。
 *
 * 而「排一个 0ms 任务、量它多久被跑到」**同时**覆盖两种形态：
 *   · 连续阻塞 ⇒ 排队时长 ≈ 阻塞时长；
 *   · 切片式饱和 ⇒ 排队时长 ≈ 单次切片（8ms 级，且用户点一下就是这个等待）。
 * 所以它是比漂移更贴近「用户感知」的主指标，且顺带能区分二者（几百 ms vs 几 s）。
 */
export const WS_LATENCY_WARN_MS = 300;
/** 延迟统计窗口（毫秒）：每个窗口结算一次「最慢排队」。 */
export const WS_LATENCY_WINDOW_MS = 5000;

let _stage = 'startup（尚未进入任何被标记的阶段）';
let _stageSince = Date.now();

/**
 * 记下「当前处于哪一步」。**只写两个模块级变量，不落盘** ⇒ 可以放在热路径上。
 *
 * 约定：名字里带上「谁 + 在做什么」（如 `graph: 加载 "S1Game" 的图谱（同步解压）`），
 * 因为看门狗只会把**这个名字**原样打出来，它得自己说明问题。
 */
export function wsStage(name: string): void {
	_stage = name;
	_stageSince = Date.now();
}

/** 当前阶段名（供其它诊断补上下文）。 */
export function wsStageName(): string {
	return _stage;
}

/** 当前阶段已持续多少毫秒（看门狗用它区分「卡在阶段入口」与「阶段里卡久了」）。 */
export function wsStageAge(now: number = Date.now()): number {
	return now - _stageSince;
}

/**
 * 「本窗口主线程最长一次被占住」的**真实**累加器（毫秒）。
 *
 * ★ 2026-09-18：为什么需要它 —— `asyncSlice.takeMaxSliceMs()` **只在切片循环调用
 * `sliceBudgetExceeded()` 时被喂** ⇒ 它只能看见**切片内部**的单次占用 ✗。真机实测：
 * 给增量索引各阶段接上它后 8 个阶段**一个阻塞标记都没打** ✗，而同期看门狗却报
 * `交互延迟 ≈585ms` ✓ ⇒ 典型**假阴性**（那些阶段根本不走 `sliceBudgetExceeded` ✓）。
 *
 * 本值改由**看门狗自己**喂（它本来就在测两件真东西）：
 *   · 心跳漂移 `drift`（定时器晚到多久 ⇒ 连续阻塞 ✓）；
 *   · 排队延迟 `delay`（`setTimeout(0)` 多久被跑到 ⇒ **切片式饱和也测得到** ✓✓）。
 * 取两者最大值累加 ⇒ 覆盖两种形态 ✓。
 *
 * 调用口径（读 + **清零**，同 `takeMaxSliceMs` ✓）：在一段可命名工作的边界读一次，即得
 * 「该段内主线程最长被占多久」⇒ 与段总耗时（含 await）一起看，才能区分
 * 「**真占主线程**」与「只是在等 worker/磁盘」✗✓（后者耗时高但不卡交互）。
 *
 * ⚠ 读值清零 ⇒ 多个消费者会互相"抢"，**同一窗口只应有一个消费者** ✓。
 */
let _maxBlockMs = 0;

/** 读取并清零「最长一次主线程占用」（口径见 `_maxBlockMs` ✓）。 */
export function takeMaxBlockMs(): number {
	const v = _maxBlockMs;
	_maxBlockMs = 0;
	return v;
}

/** 诊断输出：**任何异常都吞掉** —— 诊断绝不能影响主流程。 */
export function wsDiagLog(logService: ILogService | undefined, msg: string): void {
	try {
		logService?.info(`${WS_DIAG_TAG} ${msg}`);
	} catch { /* diagnostics must never break the flow */ }
}

/**
 * 执行**同步**一步：进入时打阶段标记，结束时记耗时。
 *
 * ⚠ 与 `wsStepAsync` 分开（不合并成「返回 thenable 就 await」的写法）：同步/异步的
 * **同步性**本身就是要测的东西 —— 合并后调用方看不出这里会不会阻塞主线程。
 */
export function wsStep<T>(logService: ILogService | undefined, name: string, fn: () => T): T {
	wsStage(name);
	const t0 = Date.now();
	try {
		return fn();
	} finally {
		wsDiagLog(logService, `${name} 完成（${Date.now() - t0}ms）`);
	}
}

/** 执行**异步**一步（阶段标记 + 耗时同上）。 */
export async function wsStepAsync<T>(logService: ILogService | undefined, name: string, fn: () => Promise<T>): Promise<T> {
	wsStage(name);
	const t0 = Date.now();
	try {
		return await fn();
	} finally {
		wsDiagLog(logService, `${name} 完成（${Date.now() - t0}ms）`);
	}
}

/**
 * 「主线程阻塞」报告的正文 —— **纯函数**（可单测）。
 *
 * `blockedMs` 取心跳的**漂移量**：定时器本应在 `last + intervalMs` 触发，实际晚了 `drift`
 * ⇒ 这段时间主线程没能跑定时器 ≈ 被同步占住了（GC / 同步重活 / 死循环都一样）。
 */
export function formatBlockReport(
	blockedMs: number,
	stage: string,
	stageAgeMs: number,
	heartbeatMs: number,
	heapMb?: number,
): string {
	const heap = typeof heapMb === 'number' ? `｜renderer 堆=${heapMb}MB` : '';
	return `⛔ 主线程阻塞 ≈${Math.round(blockedMs)}ms（心跳应 ${heartbeatMs}ms）` +
		`｜阶段=${stage}｜该阶段已持续 ≈${Math.round(stageAgeMs)}ms${heap}`;
}

/** 「阻塞结束」报告正文 —— **纯函数**（可单测）。 */
export function formatResumeReport(blockedMs: number, stage: string): string {
	return `✅ 主线程恢复（本次阻塞 ≈${Math.round(blockedMs)}ms，恢复时阶段=${stage}）`;
}

/**
 * 「交互延迟」报告正文 —— **纯函数**（可单测）。
 *
 * 语义：窗口内**最慢一次**「0ms 任务排队时长」超过阈值。它等于「用户点一下要等多久」，
 * 因此比「连续阻塞」更能解释「卡」（切片式饱和下前者常为 0，后者却可能是数百 ms）。
 */
export function formatLatencyReport(maxDelayMs: number, stage: string, windowMs: number, samples: number): string {
	return `⚠ 交互延迟：最近 ${Math.round(windowMs / 1000)}s 内最慢一次排队 ≈${Math.round(maxDelayMs)}ms` +
		`（样本 ${samples} 次；阶段=${stage}）—— 期间用户点一下就要等这么久`;
}

/** renderer 堆占用（MB）；取不到就 `undefined`（Chromium 之外 / 未开启 `performance.memory`）。 */
export function rendererHeapMB(): number | undefined {
	try {
		const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
		const used = mem?.usedJSHeapSize;
		return typeof used === 'number' ? Math.round(used / (1024 * 1024)) : undefined;
	} catch {
		return undefined;
	}
}

export interface IWatchdogOptions {
	/** 心跳间隔（毫秒）。 */
	intervalMs?: number;
	/** 连续阻塞上报阈值（毫秒）。 */
	thresholdMs?: number;
	/** 交互延迟上报阈值（毫秒）。 */
	latencyWarnMs?: number;
	/** 交互延迟统计窗口（毫秒）。 */
	latencyWindowMs?: number;
	/** 上报条数上限（阻塞与延迟各自计）。 */
	maxReports?: number;
}

/**
 * 启动主线程看门狗（见文件头说明）。返回的 disposable 用于停止。
 *
 * 同时跑两个互补指标：
 *  ① **漂移**（上次心跳到现在的额外延迟）⇒ 抓「连续阻塞」，报**阻塞时长**；
 *  ② **排队延迟**（每次心跳排一个 0ms 任务，量它多久被跑到）⇒ 抓「切片式饱和」，
 *     报**用户点一下要等多久**。第一版只有 ①，真机上对「10s 的 8ms 切片解析」完全盲
 *     （定时器照常按时跑）—— 这正是实测漏报的原因。
 */
export function startMainThreadWatchdog(logService: ILogService, options: IWatchdogOptions = {}): IDisposable {
	const intervalMs = options.intervalMs ?? WS_HEARTBEAT_MS;
	const thresholdMs = options.thresholdMs ?? WS_BLOCK_REPORT_MS;
	const latencyWarnMs = options.latencyWarnMs ?? WS_LATENCY_WARN_MS;
	const latencyWindowMs = options.latencyWindowMs ?? WS_LATENCY_WINDOW_MS;
	const maxReports = options.maxReports ?? WS_BLOCK_REPORT_MAX;

	let last = Date.now();
	let reports = 0;
	/** 连续阻塞的累计时长（跨多个心跳周期）：只在恢复时清零，供「恢复」行报总时长。 */
	let blockedAccum = 0;

	// ② 排队延迟探针的窗口状态
	let latencyWindowStart = Date.now();
	let latencyMax = 0;
	let latencySamples = 0;
	let latencyReports = 0;

	const handle = setInterval(() => {
		const now = Date.now();
		const drift = now - last - intervalMs;
		last = now;

		// ② 排队延迟探针：排一个最小任务，量「它多久才被跑到」。
		// 主线程若有活（含切片式饱和），这个任务就得排在后面 ⇒ 数值 ≈ 用户点一下的等待。
		const probeStart = Date.now();
		setTimeout(() => {
			const delay = Date.now() - probeStart;
			latencySamples++;
			if (delay > latencyMax) { latencyMax = delay; }
			// ★ 真阻塞累加（排队延迟版）：连"切片式饱和"也测得到（漂移法对它是盲的 ✓）
			if (delay > _maxBlockMs) { _maxBlockMs = delay; }
		}, 0);

		// 窗口结算（先结算再判阻塞：结算本身不该被下面的 `return` 跳过）
		if (now - latencyWindowStart >= latencyWindowMs) {
			if (latencyMax >= latencyWarnMs && latencyReports < maxReports) {
				latencyReports++;
				wsDiagLog(logService, formatLatencyReport(latencyMax, wsStageName(), now - latencyWindowStart, latencySamples));
			}
			latencyWindowStart = now;
			latencyMax = 0;
			latencySamples = 0;
		}

		// ★ 真阻塞累加（漂移版）：连续阻塞会被它抓到 ✓
		if (drift > _maxBlockMs) { _maxBlockMs = drift; }
		if (drift >= thresholdMs) {
			blockedAccum += drift;
			if (reports < maxReports) {
				reports++;
				// 阶段信息取**当前**值：阻塞期间没有代码能更新它 ⇒ 它就是「卡住时在哪一步」
				wsDiagLog(logService, formatBlockReport(drift, wsStageName(), wsStageAge(now), intervalMs, rendererHeapMB()));
			}
			return;
		}

		if (blockedAccum > 0) {
			wsDiagLog(logService, formatResumeReport(blockedAccum, wsStageName()));
			blockedAccum = 0;
		}
	}, intervalMs);

	return { dispose: () => clearInterval(handle) };
}
