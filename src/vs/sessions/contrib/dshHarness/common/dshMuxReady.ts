/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「等 mux 路由就绪再 startSession」的判据（2026-10-29）。
 *
 * 真机现场（~/.vssaros-dev/logs/20261029T101501）：
 *   10:15:26.047  ready in 24258 ms (bridge: connected)
 *   10:15:30.823  mux route available +4777 ms after Host ready (probe #12)
 * Host 说 ready 时 mux 升级路由还没注册，这 4.8s（历史样本到 11.4s）里任何 session.start 都会失败，
 * 桌面窗口只能退避重试（4s/12s），用户看到一条假的"启动失败"黄条。
 *
 * 所以：发起会话之前先等路由。判据单独抽成纯函数（本仓纪律：能表驱动断言 + 反向突变验证）。
 */

/** 等待期内的三种结局。 */
export type MuxWaitDecision =
	/** 路由已就绪（或本就无需等）⇒ 立刻发起会话。 */
	| 'proceed'
	/** 还没就绪，但还在等待窗口内 ⇒ 继续等。 */
	| 'wait'
	/** 等下去没意义（Host 没了 / 超过窗口）⇒ 照旧走原来的失败重试路径。 */
	| 'giveup';

/** 等待窗口上限：真机最坏样本 11.4s ⇒ 20s 足够覆盖，又不至于让用户干等太久。 */
export const MUX_READY_WAIT_TIMEOUT_MS = 20_000;

/** 轮询间隔：与主进程 _probeMuxAfterReady 的 200ms 同量级。 */
export const MUX_READY_POLL_INTERVAL_MS = 250;

/** decideMuxWait 只需要状态里的两件事，别把整个 status 绑进来（便于表驱动）。 */
export interface IMuxWaitStatus {
	/** Host 状态；running/starting 都继续等，stopped/error/stopping ⇒ 没得等。 */
	readonly state?: string;
	/** 主进程探测到 mux 路由已注册。 */
	readonly muxReady?: boolean;
}

/**
 * 一次"要不要继续等 mux 路由"的判定。
 *
 * @param status 最新的 Host 状态（拿不到时传 undefined ⇒ 继续等）。
 * @param elapsedMs 已经等了多久。
 * @param timeoutMs 等待窗口上限。
 */
export function decideMuxWait(status: IMuxWaitStatus | undefined, elapsedMs: number, timeoutMs: number): MuxWaitDecision {
	// Host 不在了 / 出错了 ⇒ 等也没用（后面走"真失败"路径更快）。
	// ⚠ `starting` **要继续等**：桌面窗口的 `ensureStarted()` 在"已 spawn"时就返回（不等 ready），
	//   那时状态正是 starting ⇒ 这里若判 giveup，等待就白做了（这正是本次要修的坑）。
	if (status && typeof status.state === 'string' && status.state !== 'running' && status.state !== 'starting') {
		return 'giveup';
	}
	// 路由已注册 ⇒ 可以发起了。
	if (status?.muxReady === true) {
		return 'proceed';
	}
	// 还没拿到状态 / 路由还没注册：只要还在窗口内就继续等。
	const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : MUX_READY_WAIT_TIMEOUT_MS;
	const waited = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
	return waited >= timeout ? 'giveup' : 'wait';
}
