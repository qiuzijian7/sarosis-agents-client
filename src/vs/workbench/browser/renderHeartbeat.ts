/*---------------------------------------------------------------------------------------------
 *  renderHeartbeat.ts — **渲染进程心跳**（窗口主线程 / 合成器卡死取证用）
 *
 * ## 为什么需要（与主进程心跳配对，2026-09-19）
 *
 * 主进程已有 `vs/code/electron-main/mainHeartbeat.ts`（18:20–18:22 实测 `maxLag ≤16ms` ⇒
 * 那两次"app 卡死"**不在主进程**）。但"卡死"的另一半发生在**窗口侧**：
 *   · JS 线程被同步阻塞（渲染主线程跑 agent 轮、流式渲染、图谱补丁…）⇒ UI 不响应；
 *   · 或 JS 线程正常但**合成器/GPU 侧不绘制**（rAF 停摆）⇒ 看起来也"卡死"。
 * 两者都**不会**在主进程心跳里体现 ⇒ 需要一条同样"秒级可判"的窗口侧脉搏。
 *
 * ## 与既有诊断的分工（避免重复建设 —— 本仓已有三套，且都保留）
 *   · `[WsSwitchDiag]`：看门狗，**事件驱动** —— 某个被观测阶段跑慢时报「本窗口主线程被阻塞 N ms」。
 *     缺点：**没有脉搏**，它不说话就无法区分"没事"与"整段被冻住"。
 *   · `[FocusTrace]`：**焦点事件驱动** —— 量化"点一下到能绘制"的延迟。
 *     缺点：没有焦点事件就不产生数据。
 *   · `[StreamPerf]`：流式 delta 批次耗时（agent 面板局部）。
 *   ⇒ 三者的共同缺口是**连续性**：没人能回答"14:03:16 起窗口就没再动过"。
 *     本模块就补这一条：**不依赖任何业务事件**，固定间隔打点；打点消失 = 线程被占住。
 *
 * ## 核心指标
 *   · `lag`   = 本拍**应到**时刻与**实到**时刻之差（= 主线程这一拍被占用了多久）——主判据；
 *   · `longtask`（PerformanceObserver）—— 浏览器原生"主线程被独占 >50ms"事件，
 *     给出**精确时长**与**开始时刻**（注意：它在长任务**结束后**才回调，所以它补的是
 *     "心跳那一拍没打出来时，到底被占了多久"）；
 *   · `raf`   —— 窗口**可见**期间的连续 rAF 间隔最大值。JS 线程若一直正常而 rAF 长时间停摆，
 *     说明卡在**合成器/GPU**侧（不是 JS）——这是与"线程被占"完全不同的处置方向。
 *     ⚠ 窗口隐藏/最小化时浏览器**本来就**不派 rAF ⇒ 一律以 `visibilityState` 为闸门并重置，
 *     绝不把"切走了"误报成"卡住了"。
 *
 * ## 日志形态（按 `[RenderHeartbeat]` grep；**每行都内嵌墙钟 `ts=`**）
 * ```
 * [RenderHeartbeat] started: interval=5000ms slowTick>=400ms longTask>=500ms rafStall>=2000ms win=1 …
 * [RenderHeartbeat] ts=2026-09-19T18:45:12.301 tick#6 uptime=30s maxLag=9ms longTasks=2/38ms rafMax=33ms vis=visible heap=512MB
 * [RenderHeartbeat] SLOW ts=… tick#7 lag=612ms maxLag=612ms …
 * [RenderHeartbeat] LONG_TASK ts=… 1832ms @ts=2026-09-19T18:45:10.402 (窗口内 3 次/合计 2140ms)
 * [RenderHeartbeat] RAF_STALL ts=… 2450ms（可见期间未绘制 ⇒ 疑似合成器/GPU，JS 心跳仍在跑）
 * ```
 * ⚠ **为什么要内嵌 `ts=`**：`ILogService` 的落盘时间戳是**主进程写入时刻**（renderer → main 走 IPC），
 *   线程被冻住时积压的行会在解冻后**同一秒**全部落盘 ⇒ 只看落盘时间戳会**看不见那段断层** ✗。
 *   消息体里的 `ts=` 才是"拍子实际发生时刻" ⇒ 断层判据以它为准 ✓。
 *
 * ## 判读（三步）
 *   1. `grep '\[RenderHeartbeat\]' <窗口>/renderer.log | tail -5`；取最后一个 `ts=` = **最后可用时刻**；
 *   2. 末行是 `SLOW`/`LONG_TASK` ⇒ **JS 线程被占**：`LONG_TASK` 给时长与开始时刻，直接对齐业务日志；
 *   3. 末行是 `RAF_STALL`（且当时 `vis=visible`）⇒ **不是 JS 问题**，查合成器/GPU/窗口侧。
 *
 * ## 噪音与开关
 *   · 常态行每 `presenceEveryTicks` 拍（默认 6 拍 ≈ 30s）一条，`maxLag` 在打印后**重置**（窗口统计）；
 *   · 超阈值的 `SLOW` / `LONG_TASK` / `RAF_STALL` 立即打印，但**限流**（默认每分钟 ≤12 条），
 *     被压掉的条数会在下一分钟的那条里汇总，**不静默**（本仓一贯要求）；
 *   · 零依赖：只依赖 `ILogService`；DOM/PerformanceObserver 全部**特性探测**，缺失即降级（node 下可跑）。
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { formatRenderActivityWindow } from '../../base/common/renderActivityTrace.js';
import { ILogService } from '../../platform/log/common/log.js';

export const RENDER_HEARTBEAT_TAG = '[RenderHeartbeat]';

export interface IRenderHeartbeatOptions {
	/** 心跳间隔（ms）。默认 5000。 */
	readonly intervalMs?: number;
	/** 单拍 lag 超过它即打 `SLOW`。默认 400。 */
	readonly slowTickMs?: number;
	/** 每隔多少拍打一条常态行（默认 6 ≈ 30s）。 */
	readonly presenceEveryTicks?: number;
	/** 单个 long task 超过它立即打 `LONG_TASK`（默认 500）。更短的只累计进常态行。 */
	readonly longTaskWarnMs?: number;
	/** 可见期间 rAF 间隔超过它即打 `RAF_STALL`（默认 2000）。 */
	readonly rafStallWarnMs?: number;
	/** 每分钟最多打多少条告警（防退化时刷屏）。默认 12。 */
	readonly maxWarnsPerMinute?: number;
}

/**
 * 拍子判定（纯函数）。
 *
 * ⚠ 与 `vs/code/electron-main/mainHeartbeat.ts` 的 `classifyHeartbeatTick` **同判据、各自实现**：
 * 刻意不为这 3 行算术建跨层共享 util —— 渲染包引入 `vs/code/electron-main/*` 会把主进程模块
 * 拖进渲染 bundle（架构污染 ≫ 收益）。两侧策略本就不同（渲染侧另有 longtask/raf 判据）。
 */
export type HeartbeatTickVerdict = 'presence' | 'slow' | null;

export function classifyRenderHeartbeatTick(
	tick: number,
	lagMs: number,
	options: IRenderHeartbeatOptions = {},
): HeartbeatTickVerdict {
	const slowTickMs = options.slowTickMs ?? 400;
	const presenceEveryTicks = options.presenceEveryTicks ?? 6;
	if (lagMs >= slowTickMs) { return 'slow'; }
	return (tick % presenceEveryTicks === 0) ? 'presence' : null;
}

/** 本地墙钟 ISO（`2026-09-19T18:45:12.301`）—— 供 `ts=` 用（落盘时间戳不可信，见模块头）。 */
export function localStamp(ms: number): string {
	const d = new Date(ms);
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
		`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function envInt(name: string): number | undefined {
	try {
		const raw = globalThis.process?.env?.[name];
		if (!raw) { return undefined; }
		const n = Number(raw);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	} catch { return undefined; }
}

function envFlag(name: string): boolean {
	try { return Boolean(globalThis.process?.env?.[name]); } catch { return false; }
}

/**
 * 启动渲染进程心跳；返回 disposable（窗口关闭时随 workbench 一起释放）。
 *
 * ⚠ 必须在**日志设施就绪后**调用（`workbench.ts` 的 `startup()` 里，`ILogService` 可解析之后）。
 */
export function startRenderHeartbeat(logService: ILogService, options: IRenderHeartbeatOptions = {}): IDisposable {
	const intervalMs = options.intervalMs ?? envInt('SAROSIS_RENDER_HEARTBEAT_MS') ?? 5_000;
	const slowTickMs = options.slowTickMs ?? 400;
	const presenceEveryTicks = options.presenceEveryTicks ?? 6;
	const longTaskWarnMs = options.longTaskWarnMs ?? 500;
	const rafStallWarnMs = options.rafStallWarnMs ?? 2_000;
	const maxWarnsPerMinute = options.maxWarnsPerMinute ?? 12;
	// 关闭开关：环境变量或（渲染侧调试常用）window 上挂一个 flag 即可热关。
	if (envFlag('SAROSIS_RENDER_HEARTBEAT_OFF') || (globalThis as { __SAROSIS_RENDER_HEARTBEAT_OFF?: boolean }).__SAROSIS_RENDER_HEARTBEAT_OFF === true) {
		return toDisposable(() => { /* nothing to stop */ });
	}

	const hasDom = typeof document !== 'undefined' && typeof requestAnimationFrame === 'function';
	const hasObserver = typeof PerformanceObserver !== 'undefined'
		&& (() => {
			try { return (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes?.includes('longtask') ?? false; }
			catch { return false; }
		})();
	const winId = (globalThis as { vscodeWindowId?: number }).vscodeWindowId;

	// ── 状态 ────────────────────────────────────────────────────────────────
	let disposed = false;
	let tick = 0;
	const startedAt = Date.now();
	let expectedAt = startedAt + intervalMs;
	let maxLagMs = 0;
	let longTaskCount = 0;
	let longTaskTotalMs = 0;
	let longTaskWorstMs = 0;
	let rafMaxMs = 0;
	let lastRafAt = 0;
	// 告警限流（防"退化时刷屏"把日志冲掉 —— 退化期恰恰最需要日志有结构）
	let warnWindowStart = Date.now();
	let warnsInWindow = 0;
	let suppressedWarns = 0;

	const heapMb = (): number | undefined => {
		try {
			const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
			return mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1048576) : undefined;
		} catch { return undefined; }
	};

	const shouldWarn = (): boolean => {
		const now = Date.now();
		if (now - warnWindowStart >= 60_000) {
			warnWindowStart = now;
			warnsInWindow = 0;
			if (suppressedWarns > 0) {
				const n = suppressedWarns;
				suppressedWarns = 0;
				logService.warn(`${RENDER_HEARTBEAT_TAG} ts=${localStamp(now)} (上一分钟有 ${n} 条告警被限流 —— 渲染侧当时处于持续退化，非静默丢弃)`);
			}
		}
		if (warnsInWindow >= maxWarnsPerMinute) { suppressedWarns++; return false; }
		warnsInWindow++;
		return true;
	};

	const presenceFields = (now: number): string =>
		`tick#${tick} uptime=${Math.round((now - startedAt) / 1000)}s maxLag=${maxLagMs}ms ` +
		`longTasks=${longTaskCount}${longTaskCount ? `/${longTaskTotalMs}ms(worst=${longTaskWorstMs}ms)` : ''} ` +
		`rafMax=${hasDom ? `${rafMaxMs}ms` : 'n/a'} ` +
		`vis=${hasDom ? document.visibilityState : 'n/a'}` +
		`${heapMb() !== undefined ? ` heap=${heapMb()}MB` : ''}`;

	/** 取走窗口统计（打印后重置 ⇒ "最近一段"才有意义）。 */
	const takeWindow = (): { longTasks: number; longTotal: number; longWorst: number; rafMax: number } => {
		const snap = { longTasks: longTaskCount, longTotal: longTaskTotalMs, longWorst: longTaskWorstMs, rafMax: rafMaxMs };
		longTaskCount = 0; longTaskTotalMs = 0; longTaskWorstMs = 0; rafMaxMs = 0;
		return snap;
	};

	// ── longtask：浏览器原生"主线程被独占"事件（≥50ms）──────────────────────
	// 价值：长任务**结束后**才回调 ⇒ 即便心跳那一拍被吞掉，也能补出"被占了多久、从几时开始"。
	let observer: PerformanceObserver | undefined;
	if (hasObserver) {
		try {
			observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					const dur = Math.round(entry.duration);
					longTaskCount++;
					longTaskTotalMs += dur;
					if (dur > longTaskWorstMs) { longTaskWorstMs = dur; }
					if (dur >= longTaskWarnMs && shouldWarn()) {
						// perf.now 与 Date.now 的偏移换算：给出该长任务的**墙钟开始时刻**
						const startWall = Date.now() - (performance.now() - entry.startTime);
						// 归因（2026-09-20）：把时间段内打过标记的热点拼进日志行
						// （`因=[umd×12, delta:text×40]`）—— 缺它时只能猜是谁占的主线程。
						logService.warn(
							`${RENDER_HEARTBEAT_TAG} LONG_TASK ts=${localStamp(Date.now())} 时长=${dur}ms @ts=${localStamp(startWall)}` +
							`（阈值 ${longTaskWarnMs}ms；本窗口内累计 ${longTaskCount} 次/${longTaskTotalMs}ms）` +
							` 因=[${formatRenderActivityWindow(startWall, startWall + dur)}]`,
						);
					}
				}
			});
			observer.observe({ entryTypes: ['longtask'] });
		} catch { observer = undefined; }
	}

	// ── rAF：可见期间是否真的在绘制（区分 JS 卡 vs 合成器/GPU 卡）─────────────
	let rafHandle: number | undefined;
	const rafTick = (t: number) => {
		if (disposed) { return; }
		if (lastRafAt > 0) {
			const gap = Math.round(t - lastRafAt);
			if (gap > rafMaxMs) { rafMaxMs = gap; }
			if (gap >= rafStallWarnMs && shouldWarn()) {
				logService.warn(
					`${RENDER_HEARTBEAT_TAG} RAF_STALL ts=${localStamp(Date.now())} 间隔=${gap}ms ` +
					`（窗口可见但连续未绘制 ⇒ 疑似合成器/GPU 侧，JS 心跳同期 ${maxLagMs < slowTickMs ? '正常' : '也在卡'}）`,
				);
			}
		}
		lastRafAt = t;
		rafHandle = requestAnimationFrame(rafTick);
	};
	/** 可见性变化：重置 rAF 基线（隐藏期浏览器本就不派 rAF，绝不据此误报"卡住"）。 */
	const onVisibilityChange = () => {
		if (disposed) { return; }
		lastRafAt = 0;
		logService.info(`${RENDER_HEARTBEAT_TAG} ts=${localStamp(Date.now())} visibility → ${document.visibilityState}（rAF 基线已重置，避免把"切走"误报成"卡住"）`);
	};
	if (hasDom) {
		try {
			document.addEventListener('visibilitychange', onVisibilityChange);
			rafHandle = requestAnimationFrame(rafTick);
		} catch { /* 降级：无 rAF 也能靠 tick + longtask */ }
	}

	logService.info(
		`${RENDER_HEARTBEAT_TAG} started: interval=${intervalMs}ms slowTick>=${slowTickMs}ms longTask>=${longTaskWarnMs}ms ` +
		`rafStall>=${rafStallWarnMs}ms${winId !== undefined ? ` win=${winId}` : ''} ` +
		`observer=${observer ? 'longtask' : 'n/a'} — 判读：本模块**每行内嵌 ts=**（落盘时间戳由主进程写入时才盖，被冻住后会整批同秒落盘 ⇒ 不可用于判断层）；` +
		`最后一条的 ts= 即"本窗口最后一次可用"。详见模块头。`,
	);

	const timer = setInterval(() => {
		if (disposed) { return; }
		const now = Date.now();
		const lagMs = now - expectedAt;          // = 主线程这一拍被占用多久
		tick++;
		expectedAt = now + intervalMs;
		if (lagMs > maxLagMs) { maxLagMs = lagMs; }

		const verdict = classifyRenderHeartbeatTick(tick, lagMs, { slowTickMs, presenceEveryTicks });
		if (verdict === 'slow') {
			if (shouldWarn()) {
				logService.warn(`${RENDER_HEARTBEAT_TAG} SLOW ts=${localStamp(now)} lag=${lagMs}ms ${presenceFields(now)}`);
			}
		} else if (verdict === 'presence') {
			logService.info(`${RENDER_HEARTBEAT_TAG} ts=${localStamp(now)} ${presenceFields(now)}`);
			maxLagMs = lagMs > 0 ? lagMs : 0;
			takeWindow();
		}
	}, intervalMs);
	try { (timer as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }

	return toDisposable(() => {
		disposed = true;
		clearInterval(timer);
		try { observer?.disconnect(); } catch { /* ignore */ }
		if (hasDom) {
			try { document.removeEventListener('visibilitychange', onVisibilityChange); } catch { /* ignore */ }
			if (rafHandle !== undefined) { try { cancelAnimationFrame(rafHandle); } catch { /* ignore */ } }
		}
	});
}
