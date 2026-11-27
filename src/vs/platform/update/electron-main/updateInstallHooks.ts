/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「安装更新之前」的钩子（2026-10-31）。
 *
 * 背景（用户报障："更新安装完毕后，为什么会显示『要完成 VsSaros 的安装，安装程序必须重新启动您的电脑』"）：
 *   win32 的**自动**安装走 `updateService.win32.ts` 的 `doApplyUpdate()`，它给安装包传的是
 *   `/verysilent … /nocloseapplications` —— 那个开关的含义是**不让安装器去关闭占用文件的进程**
 *   ⇒ 凡是还被占用的文件，Inno 只能排到"重启时替换"（`restartreplace`）⇒ 收尾时就弹这条中文提示。
 *   （兜底那条 `doQuitAndInstall()` 现在也用 `/verysilent`，且**不带** `/nocloseapplications` ⇒
 *   安装器会自己尝试关进程，所以不会显示安装向导。）
 *
 * ⇒ 要消掉它，只有一条路：**在 spawn 安装包之前，我们自己把占用者收掉**。
 *
 * ⚠ 分层：本文件在 **platform** 层，只提供"注册 + 运行"，**不许**反向依赖 sessions ——
 *   "到底要收什么"由 sessions 侧的 `DshHarnessChannel` 注册进来（它才持有 dsh Host 的句柄）。
 *
 * 三条纪律：
 *   ① **串行**跑（多个占用者之间也可能互相等，别并发）；
 *   ② 每条带超时和取消信号；
 *   ③ 失败或超时阻断安装，保留可重试状态。
 */

import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { ILogService } from '../../log/common/log.js';

export type BeforeUpdateInstallHook = (token: CancellationToken) => Promise<void> | void;

/**
 * 单条钩子的超时。
 *
 * 覆盖两次活动查询与 Host 退出确认；超时取消准备并拒绝安装。
 */
export const BEFORE_UPDATE_HOOK_TIMEOUT_MS = 25_000;

const hooks = new Set<BeforeUpdateInstallHook>();

/** 注册一条"安装更新前"的钩子；返回 disposable（注销）。 */
export function registerBeforeUpdateInstallHook(hook: BeforeUpdateInstallHook): IDisposable {
	hooks.add(hook);
	return toDisposable(() => hooks.delete(hook));
}

/** Preparation errors and timeouts veto installation; no installer is started on failure. */
export async function runBeforeUpdateInstallHooks(logService?: ILogService, timeoutMs = BEFORE_UPDATE_HOOK_TIMEOUT_MS): Promise<void> {
	for (const hook of [...hooks]) {
		const cancellation = new CancellationTokenSource();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.resolve().then(() => hook(cancellation.token)),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						cancellation.cancel();
						reject(new Error('stop-failed: update preparation timed out'));
					}, timeoutMs);
				}),
			]);
		} catch (e) {
			logService?.warn(`update#beforeInstall veto: ${String((e as Error)?.message ?? e)}`);
			throw e;
		} finally {
			if (timer !== undefined) { clearTimeout(timer); }
			cancellation.dispose(true);
		}
	}
}
