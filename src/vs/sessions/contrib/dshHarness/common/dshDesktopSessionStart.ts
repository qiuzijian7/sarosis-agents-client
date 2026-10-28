/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 桌面窗口"自己的会话"启动的重试判据（2026-10-27）。
 *
 * 现场（真机 `logs/20261027T100853`）：
 *   · 10:09:07.734 Host ready
 *   · 10:09:08.551 `full window: 独立会话启动失败 ⇒ 回落官方默认页
 *                  vssaros-agents (@vssaros/dsh-agents): never started`
 *   · 10:09:19.129 mux route available **+11394 ms after Host ready**
 * ⇒ 会话创建发生在 Host 刚 ready 的 0.8s，而真正可用要等 11s 之后；且这条错误
 *   （`agent-preset/invalid: … never started` = 插件还没在 Host 进程里起来）会持续存在
 *   一段时间后自行消失（插件延迟挂载）⇒ **值得重试**，而不是一次性判死。
 *
 * 反过来，下面这些是**真失败**，重试只会拖慢报错、还会在 Host 上刷出一堆空会话：
 *   · 没有工作区目录（用户没开工作区）—— 等再久也不会有；
 *   · 明确的拒绝（unknown session / conflict / 权限 / 参数不合法）。
 *
 * 为什么单独一层纯函数：判据要能被表驱动断言 + 反向突变验证（本仓既有纪律），
 * 写在 contribution 里就只能靠真机复现 ✗。
 */

/** `session.start` 的重试判据（只吃错误文本，不看异常类型 —— 跨进程边界只有文本可靠）。 */
export type SessionStartRetry =
	/** 值得再试一次（插件延迟挂载 / Host 还在热起来）。 */
	| 'retry'
	/** 真失败：重试没有意义，直接把原因告诉用户。 */
	| 'fail';

/** 判为"值得重试"的错误文本特征（小写比较）。 */
const RETRYABLE_MARKERS: readonly string[] = [
	'never started',                 // agent-preset/invalid: <plugin> (@<pkg>): never started
	'agent-preset/invalid',
	// ★★ 2026-10-28（真机：桌面窗口弹出「会话启动失败（第1/3次）：[dshHarness] startSession:
	//   控制桥不可用（未安装伴生插件或 Host 未运行）」）：
	//   Host 进程被外部杀掉（`Host exited unexpectedly (code 4294967295)`）后 supervisor 会**自动重启**，
	//   真机这次重启花了 25.8s。而重启窗口期里 `_supervisor.bridge` 是 undefined ⇒ `startSession`
	//   抛的正是这条**中文**文案 —— 之前它不在特征表里 ⇒ 被判死 ⇒ 第 1 次就放弃，
	//   窗口停在提示条上（其实再等 20 秒就好了）✗✗。
	'控制桥不可用',
	'host 未运行',
	'host 意外退出',
	'host exited unexpectedly',
	'not ready',
	'starting',
	'socket hang up',
	'econnrefused',
	'econnreset',
	'etimedout',
	'timeout',
	'fetch failed',
	'no response',
	'unavailable',
];

/** 判为"真失败"的错误文本特征（优先于可重试：宁可让用户看到明确原因）。 */
const FATAL_MARKERS: readonly string[] = [
	'unknown session',
	'conflict',
	'permission',
	'unauthorized',
	'forbidden',
	'invalid argument',
	'no workspace',
];

/**
 * 一次 `session.start` 失败后该怎么办。
 *
 * @param message 错误文本（`String(err?.message ?? err)`）。
 * @param attempt 已经试过的次数（**从 1 开始**）。
 * @param maxAttempts 最多允许试几次（超过 ⇒ 一律 `fail`，不能无限重试 ✗）。
 */
export function decideSessionStartRetry(message: string, attempt: number, maxAttempts: number): SessionStartRetry {
	if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
		return 'fail';
	}
	if (!Number.isFinite(attempt) || attempt < 1 || attempt >= maxAttempts) {
		return 'fail';
	}
	const text = String(message ?? '').toLowerCase();
	if (!text) {
		return 'fail';   // 没有错误文本 ⇒ 别瞎重试（真机上这是"什么都不知道"，重试只是刷屏）
	}
	for (const marker of FATAL_MARKERS) {
		if (text.includes(marker)) {
			return 'fail';
		}
	}
	for (const marker of RETRYABLE_MARKERS) {
		if (text.includes(marker)) {
			return 'retry';
		}
	}
	return 'fail';
}

/**
 * 重试之间的等待（毫秒）：**指数退避 + 上限**。
 *
 * 为什么是 4s/12s/24s（累计 40s）：两种"等一等就好"的现场各自要一个量级 ——
 *   · mux 路由在 Host ready 之后约 **11s** 才可用；
 *   · Host 被外部杀掉后的**自动重启实测 25.8s**（2026-10-28 真机）。
 * 前两跳盖住前者、三跳合计盖住后者；再长就不合适了（桌面窗口是启动即开的界面，用户盯着它）。
 */
export function sessionStartRetryDelayMs(attempt: number): number {
	const delays = [4_000, 12_000, 24_000];
	const idx = Math.max(0, Math.min(delays.length - 1, (Number.isFinite(attempt) ? Math.trunc(attempt) : 0) - 1));
	return delays[idx];
}

/** 默认最多试几次（含第一次）。 */
export const SESSION_START_MAX_ATTEMPTS = 3;
