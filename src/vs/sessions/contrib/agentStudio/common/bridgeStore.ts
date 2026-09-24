/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 渠道绑定状态存储的**公共契约与纯逻辑**（被主进程通道、渲染层 store、单测共用）。
 *
 * 为什么单独放 common：
 *   · `electron-main/bridgeStoreChannel.ts` 依赖 `electron`，**不能被单测 import**
 *     （会拉起 electron 依赖）；
 *   · 渲染层 store（`browser/bridge/bridgeIpcStores.ts`）与主进程必须对
 *     「文件名白名单 / 目录 / 路径拼接」有同一份定义，否则会出现「写得进读不出」；
 *   · 这里刻意**不 import `node:path`**（本模块会被浏览器侧单测加载）——自己做极简
 *     路径拼接（输入来自 Electron 的 userData 路径，形态可控）。
 */

/** 允许读写的文件名白名单（相对 `<userData>/bridge`）。 */
export const BRIDGE_STORE_FILES = ['bindings.json', 'sessionMap.json', 'usage.json'] as const;

export type BridgeStoreFile = typeof BRIDGE_STORE_FILES[number];

/** 单文件写入上限（绑定/映射都是小 JSON；防御性上限）。 */
export const MAX_BRIDGE_STORE_WRITE_BYTES = 8 * 1024 * 1024;

/** 目录分隔符推断（Windows 路径带反斜杠；其余按正斜杠）。 */
function separatorOf(p: string): string {
	return p.includes('\\') ? '\\' : '/';
}

/** 去掉尾部分隔符（`C:\a\` → `C:\a`；`/a/` → `/a`）。 */
function trimTrailingSeparators(p: string): string {
	return p.replace(/[\\/]+$/, '');
}

/** 存储目录（纯函数）：`<userData>/bridge` —— 与启动目录（cwd）无关，跨启动稳定。 */
export function resolveBridgeStoreDir(userDataPath: string): string {
	const base = trimTrailingSeparators(userDataPath);
	if (!base) { return 'bridge'; }
	return `${base}${separatorOf(base)}bridge`;
}

/** 存储文件绝对路径（纯函数）。 */
export function bridgeStoreFilePath(storeDir: string, file: BridgeStoreFile): string {
	const base = trimTrailingSeparators(storeDir);
	return base ? `${base}${separatorOf(base)}${file}` : file;
}

/**
 * 在 bridge 目录下拼任意段（纯函数）。用于 `attachments/` 子目录这类**不在白名单**的路径段
 * —— 白名单 `BRIDGE_STORE_FILES` 只管「文件名」，目录段由本函数拼（仍受调用方控制，不接受 IPC 传入）。
 */
export function joinBridgePath(storeDir: string, segment: string): string {
	const base = trimTrailingSeparators(storeDir);
	const seg = trimTrailingSeparators(segment.replace(/^[\\/]+/, ''));
	return base ? `${base}${separatorOf(base)}${seg}` : seg;
}

/** 文件名白名单校验（纯函数）：只允许 bridge 目录下的三个已知 JSON，杜绝任意路径读写。 */
export function isAllowedBridgeStoreFile(file: unknown): file is BridgeStoreFile {
	return typeof file === 'string' && (BRIDGE_STORE_FILES as readonly string[]).includes(file);
}
