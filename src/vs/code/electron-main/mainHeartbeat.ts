/*---------------------------------------------------------------------------------------------
 *  mainHeartbeat.ts — **主进程 JS 线程心跳**（app 卡死取证用）
 *
 * ## 为什么需要（2026-09-19 两次卡死的直接产物）
 *
 * 两起卡死的共同指纹：**主进程 `Runtime.evaluate` 不回复、CPU ≈ 0**（= 在等，不是在算）、
 * 而窗口侧日志同时停止（渲染进程日志要经主进程落盘）。当时的困境是**只能定位到"主进程被同步阻塞"**
 * 这一层 —— 因为主进程侧**没有任何高频心跳**，唯一的低频信号是 agentmemory 网关的
 * **5 分钟**周期 sweep（13:48 / 13:53 / 13:58 / 14:03 …），只能把阻塞时刻夹逼到 5 分钟窗口内。
 *
 * 本模块补上那个"秒级可判"的信号：
 *   · JS 线程活着 ⇒ 每 `intervalMs` 打点（默认 5s，其中每 6 拍输出一条常态行 ≈ 30s）；
 *   · JS 线程被同步阻塞 ⇒ **定时器根本不会触发** ⇒ 日志里出现**时间戳断层**，
 *     断层起点即"最后一次可用"时刻（精度 = intervalMs），可直接与当时的其它日志对齐；
 *   · 被"拖慢"（不是完全阻塞，而是每次卡 1–3s）⇒ 打出 `SLOW` 行并带 lag，
 *     能看到 `lag` **单调变大**的退化趋势（比"突然死掉"更有诊断价值）。
 *
 * ## 设计约束（刻意的）
 *   · **零依赖**：只依赖 `ILogService`，不碰文件/网络/IPC —— 心跳本身绝不能成为阻塞源；
 *   · 用 `performance.now()` 之外的 `Date.now()` 差值算 lag：定时器回调的**应到时刻**与
 *     **实到时刻**之差，正是"主线程被占用了多久"的度量；
 *   · `unref()`：不因心跳而阻止进程退出；
 *   · 默认开启、可用环境变量关掉（`SAROSIS_MAIN_HEARTBEAT=0`）与调参，便于排障时加大频率。
 *
 * ## 判读方法（写在这里，避免后人重推）
 *   1. `grep '\[MainHeartbeat\]' main.log | tail -5` —— 最后一条的时间戳 = 最后一次可用；
 *   2. 若最后是 `SLOW` 行 ⇒ 是**渐进退化**，看 lag 增长速率与期间日志；
 *   3. 若最后是常态行且之后**长时间空白** ⇒ 硬阻塞，把该时间戳 ±intervalMs 作为阻塞起点，
 *      去对齐 `main.log` / `renderer.log` 的最后几行（通常就是"最后在做的那件事"）。
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { ILogService } from '../../platform/log/common/log.js';

export const MAIN_HEARTBEAT_TAG = '[MainHeartbeat]';

export interface IMainHeartbeatOptions {
	/** 心跳间隔（ms）。默认 5000。 */
	readonly intervalMs?: number;
	/** 单拍 lag 超过它即判为「被拖慢」并打 warn。默认 400。 */
	readonly slowTickMs?: number;
	/** 每隔多少拍输出一条常态行（默认 6 拍 ≈ 30s）。 */
	readonly presenceEveryTicks?: number;
}

/** 每次 tick 的判定结果（纯函数，便于单测/复用）。 */
export type HeartbeatTickVerdict = 'presence' | 'slow' | null;

/**
 * 纯判定：这一拍该输出什么。
 *
 * 提取成纯函数的目的：**让"多久算慢、多久报一次"可被单测钉住**，而不是散在定时器回调里。
 */
export function classifyHeartbeatTick(
	tick: number,
	lagMs: number,
	options: IMainHeartbeatOptions = {},
): HeartbeatTickVerdict {
	const slowTickMs = options.slowTickMs ?? 400;
	const presenceEveryTicks = options.presenceEveryTicks ?? 6;
	if (lagMs >= slowTickMs) { return 'slow'; }
	return (tick % presenceEveryTicks === 0) ? 'presence' : null;
}

function readEnvInt(name: string): number | undefined {
	const raw = process.env[name];
	if (!raw) { return undefined; }
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 启动主进程心跳。返回的 disposable 用于停止（正常只会在退出流程里用）。
 *
 * ⚠ 必须在**日志设施就绪之后**调用（`main.ts` 的 `services.set(ILogService, logService)` 之后）。
 * 那之前 `bufferLogger` 尚未接上文件 logger，日志会被缓冲 —— 不影响正确性（后续会补写），
 * 但心跳的"第一行"会晚于启动出现，判读时别把它当成"启动即卡"。
 */
export function startMainHeartbeat(logService: ILogService, options: IMainHeartbeatOptions = {}): IDisposable {
	const intervalMs = options.intervalMs ?? readEnvInt('SAROSIS_MAIN_HEARTBEAT_MS') ?? 5_000;
	const slowTickMs = options.slowTickMs ?? 400;
	const presenceEveryTicks = options.presenceEveryTicks ?? 6;
	if (process.env['SAROSIS_MAIN_HEARTBEAT'] === '0') {
		return Disposable.None;
	}

	let tick = 0;
	let maxLagMs = 0;
	const startedAt = Date.now();
	let expectedAt = startedAt + intervalMs;

	logService.info(
		`${MAIN_HEARTBEAT_TAG} started: interval=${intervalMs}ms slow>= ${slowTickMs}ms ` +
		`presenceEvery=${presenceEveryTicks}tick — 判读：本行若长时间不更新 = 主进程 JS 线程被同步阻塞，` +
		`最后一条的时间戳即"最后一次可用"（详见模块头注释）`,
	);

	const timer = setInterval(() => {
		const now = Date.now();
		// lag = 本拍**应到**时刻与**实到**时刻之差 = 主线程这一拍被占用的时间
		const lagMs = now - expectedAt;
		tick++;
		expectedAt = now + intervalMs;
		if (lagMs > maxLagMs) { maxLagMs = lagMs; }

		const verdict = classifyHeartbeatTick(tick, lagMs, { slowTickMs, presenceEveryTicks });
		if (verdict === 'slow') {
			logService.warn(
				`${MAIN_HEARTBEAT_TAG} SLOW tick#${tick} lag=${lagMs}ms (max=${maxLagMs}ms) ` +
				`uptime=${Math.round((now - startedAt) / 1000)}s rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`,
			);
		} else if (verdict === 'presence') {
			logService.info(
				`${MAIN_HEARTBEAT_TAG} tick#${tick} uptime=${Math.round((now - startedAt) / 1000)}s ` +
				`maxLag=${maxLagMs}ms rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`,
			);
			// 常态行重置窗口统计：让"最近一段时间"的 maxLag 有意义（否则一次早期抖动会永久污染）
			maxLagMs = lagMs > 0 ? lagMs : 0;
		}
	}, intervalMs);

	// 不因心跳而阻止进程退出（Node/Electron 的 Timeout 均有 unref）
	try { (timer as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }

	return toDisposable(() => { clearInterval(timer); });
}
