/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书 CLI 的渲染层封装（薄壳）。
 *
 * 只做一件事：把 `vscode:larkCliStatus` / `vscode:larkCliInstall` 包成 Promise，
 * 并保证**永不抛** —— 非 Electron 宿主 / preload 未注入时返回 `available:false`，
 * 让 UI 显示「不可用」而不是把页签渲染打断（同 `nativeIpcBridge` 注释里提到的历史坑：
 * 取桥方式写错会表现为「点了没反应」）。
 *
 * 真逻辑在 `electron-main/larkCliChannel.ts`（探测/安装需要 child_process）。
 */

import { nativeIpcBridge } from '../common/configHtmlConfig.js';
import type { ILarkCliRunResult, ILarkCliStatus } from '../common/larkCli.js';

/** 桥不可用时的统一状态（UI 据此显示灰色「不可用」）。 */
function unavailable(error: string): ILarkCliStatus {
	return { available: false, installed: false, error };
}

/** 探测 CLI 状态。 */
export async function getLarkCliStatus(): Promise<ILarkCliStatus> {
	const bridge = nativeIpcBridge();
	if (!bridge?.ipcRenderer?.invoke) {
		return unavailable('IPC 桥不可用（非 Electron 或 preload 未注入）');
	}
	try {
		const r = await bridge.ipcRenderer.invoke('vscode:larkCliStatus') as Partial<ILarkCliStatus> | undefined;
		return {
			available: true,
			installed: !!r?.installed,
			version: r?.version,
			path: r?.path,
			latestVersion: r?.latestVersion,
			error: r?.error,
		};
	} catch (err) {
		return { available: true, installed: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** 安装 / 升级（同一条命令：重跑即升级）。 */
export async function installLarkCli(): Promise<ILarkCliRunResult> {
	const bridge = nativeIpcBridge();
	if (!bridge?.ipcRenderer?.invoke) {
		return { ok: false, message: 'IPC 桥不可用（非 Electron 或 preload 未注入），无法在主进程执行安装命令' };
	}
	try {
		const r = await bridge.ipcRenderer.invoke('vscode:larkCliInstall') as Partial<ILarkCliRunResult> | undefined;
		return { ok: !!r?.ok, message: r?.message ?? (r?.ok ? '完成' : '未知错误'), output: r?.output };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}
