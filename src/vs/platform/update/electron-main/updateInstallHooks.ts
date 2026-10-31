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
 *   （手动那条 `doQuitAndInstall()` 用的是 `/silent`，**不带** `/nocloseapplications` ⇒ 安装器会自己
 *   尝试关进程，所以手动点"一键升级"很少出现这条提示。）
 *
 * ⇒ 要消掉它，只有一条路：**在 spawn 安装包之前，我们自己把占用者收掉**。
 *
 * ⚠ 分层：本文件在 **platform** 层，只提供"注册 + 运行"，**不许**反向依赖 sessions ——
 *   "到底要收什么"由 sessions 侧的 `DshHarnessChannel` 注册进来（它才持有 dsh Host 的句柄）。
 *
 * 三条纪律：
 *   ① **串行**跑（多个占用者之间也可能互相等，别并发）；
 *   ② 每条**带超时**（卡死的钩子不许把安装拖住 —— 装不上比"多弹一次重启提示"更糟）；
 *   ③ 失败**只记日志、不阻断**（兜底就是安装器的 `restartreplace`，不是半装）。
 */

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { ILogService } from '../../log/common/log.js';

export type BeforeUpdateInstallHook = () => Promise<void> | void;

/**
 * 单条钩子的超时。
 *
 * 取 8s：`dshHostSupervisor._killChild()` 是 `taskkill /T /F` + 5s 后 SIGKILL 兜底 ⇒ 最坏 ~5s，
 * 留 3s 余量。超时只是"不再等"（钩子仍会继续跑完），不会取消释放动作。
 */
export const BEFORE_UPDATE_HOOK_TIMEOUT_MS = 8_000;

const hooks = new Set<BeforeUpdateInstallHook>();

/** 注册一条"安装更新前"的钩子；返回 disposable（注销）。 */
export function registerBeforeUpdateInstallHook(hook: BeforeUpdateInstallHook): IDisposable {
	hooks.add(hook);
	return toDisposable(() => hooks.delete(hook));
}

/** 安装前收尾：串行 + 单条超时 + 失败只记日志。 */
export async function runBeforeUpdateInstallHooks(logService?: ILogService): Promise<void> {
	if (hooks.size === 0) {
		return;
	}
	for (const hook of [...hooks]) {
		try {
			await Promise.race([
				Promise.resolve(hook()),
				new Promise<void>(resolve => setTimeout(resolve, BEFORE_UPDATE_HOOK_TIMEOUT_MS)),
			]);
		} catch (e) {
			logService?.warn(`update#beforeInstall hook failed（安装时可能仍会撞文件锁）：${String((e as Error)?.message ?? e)}`);
		}
	}
}
