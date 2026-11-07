/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 原生桥与 Node 运行时路径的通用工具。
 *
 * ★ 2026-11-07（移除 config.html）：原本寄居在 `configHtmlConfig.ts` 里。该文件的
 *   config.html 专属类型 / 端口 / URL / 服务拉起参数在 IDE 侧 UI 全部退役后已无消费者，
 *   遂把仍被 4 处生产代码引用的这两个函数外提到本文件，原文件整体删除。
 */

/**
 * Node 可执行文件路径。本模块是 **common 层**，renderer（浏览器环境无 `process`）、
 * Electron 主进程与 node 测试脚本都可能读取 ⇒ 必须防御式取，取不到返回 undefined，
 * 由主进程兜底 `process.execPath`。
 */
export function nodeExecPath(): string | undefined {
	try {
		return typeof process !== 'undefined' ? process.execPath : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 取 preload（contextBridge）暴露的原生 ipcRenderer 桥，用于 renderer → 主进程 invoke。
 * 注意键名：项目 preload 暴露的是 **`globalThis.vscode`**（worktreeService / webTools /
 * compatibilityTools 均如此使用），历史代码里误写成 `vscodeBridge` 导致永远判空
 * （表现为「点了没反应」）。这里两个键都兼容，并统一各处取桥方式。
 */
export function nativeIpcBridge(): { ipcRenderer?: { invoke?: (ch: string, ...args: unknown[]) => Promise<unknown> } } | undefined {
	const g = globalThis as unknown as Record<string, unknown>;
	for (const key of ['vscode', 'vscodeBridge']) {
		const b = g[key] as { ipcRenderer?: { invoke?: (ch: string, ...args: unknown[]) => Promise<unknown> } } | undefined;
		if (b?.ipcRenderer?.invoke) { return b; }
	}
	return undefined;
}
