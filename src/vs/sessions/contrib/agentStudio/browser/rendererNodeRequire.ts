/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 渲染进程"尝试"加载 Node.js 模块 —— **在桌面客户端里必定返回 undefined**。
 *
 * ## 为什么必然失败
 * 桌面客户端渲染进程以 Chromium 沙箱运行（`windows.ts` 设置 `sandbox: true`）：
 * - 渲染进程没有 Node `require`；`globalThis.require` 被 `amdX.ts` 替换成 AMD
 *   加载器 shim，连 `fs` 这种内置模块都解析不了；
 * - 沙箱 preload 的 `require` 也只是受限 polyfill（仅 `electron`/`events`/
 *   `timers`/`url`），无法经 `contextBridge` 转发 `fs`/`isomorphic-git`。
 *
 * 因此本函数只作为**优雅降级入口**保留：调用方拿到 undefined 后应走降级分支，
 * 而不是把它当作"node 模块可用"的证据。
 *
 * ## 需要真正的 node 能力时怎么做
 * 把实现放到主进程（`node/*.ts`）并经 IPC channel 暴露给渲染进程 —— 参见
 * `gitVersionCore.ts` ↔ `node/gitVersionEngine.ts` ↔
 * `electron-main/gitVersionChannel.ts` 这条已验证的链路。
 *
 * 注意：主进程为 ESM（`package.json` 的 `"type": "module"`），node 侧加载 npm
 * 依赖须用 `createRequire(import.meta.url)`，裸 `require` 同样是未定义的。
 */
export function nodeRequire(id: string): any {
	// globalThis.require：渲染进程为 AMD shim（对 node 模块无效但调用安全）
	const g = globalThis as unknown as { require?: (mod: string) => unknown };
	if (typeof g.require === 'function') {
		try {
			return g.require(id);
		} catch {
			/* 模块不存在或非 node 环境，忽略 */
		}
	}

	return undefined;
}
