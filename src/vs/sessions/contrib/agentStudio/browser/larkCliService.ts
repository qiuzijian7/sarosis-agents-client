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
import {
	LARK_CLI_INSTALL_CHANNEL,
	LARK_CLI_RUN_CHANNEL,
	LARK_CLI_STATUS_CHANNEL,
	type ILarkCliExecResult,
	type ILarkCliRunResult,
	type ILarkCliStatus,
} from '../common/larkCli.js';

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
		const r = await bridge.ipcRenderer.invoke(LARK_CLI_STATUS_CHANNEL) as Partial<ILarkCliStatus> | undefined;
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

/**
 * 执行一条 `lark-cli <args…>`（2026-09-23：为「飞书文档 → markdown」导入新增）。
 *
 * 与 `getLarkCliStatus` 一样**永不抛**：桥不可用 / 调用异常都返回 `ok:false`，
 * 让调用方（知识库导入）能把「为什么读不到」直接讲给用户，而不是抛异常中断导入。
 * 原始 stdout/stderr 原样回传 ⇒ 解析交给 `common/larkCli.ts` 的纯函数（可单测）。
 */
export async function runLarkCli(args: string[], opts?: { timeoutMs?: number }): Promise<ILarkCliExecResult> {
	const bridge = nativeIpcBridge();
	if (!bridge?.ipcRenderer?.invoke) {
		return { ok: false, stdout: '', stderr: '', error: 'IPC 桥不可用（非 Electron 或 preload 未注入），无法在主进程执行 lark-cli' };
	}
	try {
		const r = await bridge.ipcRenderer.invoke(LARK_CLI_RUN_CHANNEL, args, opts?.timeoutMs) as Partial<ILarkCliExecResult> | undefined;
		return { ok: !!r?.ok, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '', error: r?.error };
	} catch (err) {
		return { ok: false, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
	}
}

/** 安装 / 升级（同一条命令：重跑即升级）。 */
export async function installLarkCli(): Promise<ILarkCliRunResult> {
	const bridge = nativeIpcBridge();
	if (!bridge?.ipcRenderer?.invoke) {
		return { ok: false, message: 'IPC 桥不可用（非 Electron 或 preload 未注入），无法在主进程执行安装命令' };
	}
	try {
		const r = await bridge.ipcRenderer.invoke(LARK_CLI_INSTALL_CHANNEL) as Partial<ILarkCliRunResult> | undefined;
		return { ok: !!r?.ok, message: r?.message ?? (r?.ok ? '完成' : '未知错误'), output: r?.output };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}
