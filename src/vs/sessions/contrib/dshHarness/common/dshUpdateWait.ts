/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 等"应用更新"进入可安装状态，并**说清没就绪的原因**。
 *
 * ## 为什么单独成模块
 * 这段逻辑踩过一次很贵的坑，必须能用**假状态序列**做行为测试（`test/common/dshUpdateWait.test.ts`）：
 *
 * ★★ 2026-11-04 真机：点「一键升级」几乎**立刻**弹「下载超时（3 分钟内没就绪）」，根本不到 3 分钟。
 *   旧实现把 `Idle` / `Disabled` / `Uninitialized` **一见到就返回 false** ⇒ 三种完全不同的原因
 *   全被报成"3 分钟超时"，文案把用户和排查者一起带偏 ✗✗：
 *     · `Disabled` —— 这个构建的更新服务被禁用（portable / `update.mode=none` / 非安装副本）；
 *     · `Idle` 且**一直不动** —— `checkForUpdates` 内部直接 return 了：
 *       `abstractUpdateService.checkForUpdates` 在 `_suspended`（**另一个 VsSaros 实例正持有 update client**）
 *       或 `mode === 'none'` 时什么都不做 ⇒ 状态压根不会翻成 `CheckingForUpdates`；
 *     · 真的在下载但慢 —— 安装包 **≈477MB**（实测 `content-length=499983787`），180s 对慢网偏短。
 *
 * ## 现在的判据
 * - `Ready` / `Downloaded` ⇒ 成功；
 * - `Disabled` / `Uninitialized` ⇒ 立即失败，原因 `disabled`；
 * - `Idle` **不**立即失败：宽限期（`graceMs`）内继续观察（`checkForUpdates` 是 fire-and-forget，
 *   状态可能稍后才翻）；宽限期过后仍一直 Idle 且持续 `idleStuckMs` ⇒ 原因 `not-started`；
 * - 到点还没就绪 ⇒ 原因 `timeout`。
 */

import { StateType } from '../../../../platform/update/common/update.js';

export type UpdateWaitReason = 'ready' | 'disabled' | 'not-started' | 'timeout';

export interface IUpdateWaitResult {
	readonly ok: boolean;
	readonly reason: UpdateWaitReason;
	/** 更新服务自报的错误（`State.error`），有就带上 —— 别再让用户靠猜。 */
	readonly detail?: string;
}

/** 只读 state 的形状（`IUpdateService.state` 的子集，便于测试注入）。 */
export interface IUpdateWaitState {
	readonly type: StateType;
	readonly error?: Error | string;
}

export interface IUpdateWaitOptions {
	/** 轮询间隔。 */
	readonly pollMs?: number;
	/** 宽限期：这段时间内 `Idle` 不算失败。 */
	readonly graceMs?: number;
	/** 宽限期过后，`Idle` 还要持续多久才判 `not-started`。 */
	readonly idleStuckMs?: number;
	/** 注入时钟/睡眠（测试用）。 */
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * 等更新就绪。
 *
 * @param readState 读当前更新服务状态（每次轮询调一次）。
 * @param timeoutMs 总等待上限。
 */
export async function waitForUpdateReady(
	readState: () => IUpdateWaitState,
	timeoutMs: number,
	options: IUpdateWaitOptions = {},
): Promise<IUpdateWaitResult> {
	const pollMs = options.pollMs ?? 500;
	const graceMs = options.graceMs ?? 5_000;
	const idleStuckMs = options.idleStuckMs ?? 15_000;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

	const started = now();
	let idleSince: number = readState().type === StateType.Idle ? started : -1;
	while (now() - started < timeoutMs) {
		const state = readState();
		const type = state.type;
		if (type === StateType.Ready || type === StateType.Downloaded) {
			return { ok: true, reason: 'ready' };
		}
		if (type === StateType.Disabled || type === StateType.Uninitialized) {
			return { ok: false, reason: 'disabled', ...(state.error ? { detail: String((state.error as Error)?.message ?? state.error) } : {}) };
		}
		if (type === StateType.Idle) {
			if (idleSince < 0) {
				idleSince = now();
			}
			// ⚠ 两段时间是**串行**的：先给 `graceMs` 宽限，之后**才开始**计 `idleStuckMs`。
			//   写成 `now - started > grace && now - idleSince > stuck` 会退化成 max(grace, stuck)
			//   （stuck 更大时宽限期等于白给）——测试用例 2 抓到过一次。
			const idleMeasuredFrom = Math.max(idleSince, started + graceMs);
			if (now() >= idleMeasuredFrom && now() - idleMeasuredFrom > idleStuckMs) {
				return { ok: false, reason: 'not-started', ...(state.error ? { detail: String((state.error as Error)?.message ?? state.error) } : {}) };
			}
		} else {
			idleSince = -1;   // CheckingForUpdates / Downloading / Updating… ⇒ 确实在动
		}
		await sleep(pollMs);
	}
	return { ok: false, reason: 'timeout' };
}
