/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「这份已装的 dsh 副本还能不能用」的判据（纯逻辑，注入 `exists` 便于单测）。
 *
 * ## 为什么需要（2026-10-29 真机：打包 exe 启动就报「控制桥不可用」）
 *
 * 用户的 `~/.vssaros/dsh-runtime/0.2.1-alpha.3` 里
 * `node_modules/@deepseek-ai/dsh-app-boot` 是**一个空目录**（迁移时复制不全）。
 * `state.json` 的 `current` 指向它 ⇒ 运行时管理器优先选托管版本 ⇒
 * `dsh --version` 直接 `ERR_MODULE_NOT_FOUND` ⇒ Host 根本没起来 ⇒
 * 主进程 `bridge` 永远是 `undefined` ⇒ 桌面窗口报「startSession: 控制桥不可用」，
 * 而**两个方案的日志里都看不出"是运行时副本坏了"** —— 这次是靠手工跑 `bin.js --version`
 * 才定位到的 ✗。
 *
 * ⇒ 选运行时之前先做一次**廉价**的文件级体检（不 spawn 子进程）：关键构件缺任何一项，
 *   就跳过这份、回落到下一个候选（bundled / global），并留一行日志说明缺什么。
 *
 * ⚠ 判据只查"必然存在的构件"，不查完整依赖树：
 *   `@deepseek-ai/dsh`（入口包）、它的 `lib/bin.js`、以及 `@deepseek-ai/dsh-app-boot`
 *   —— 后者是 `bin.js` 的第一个 import，缺它必崩（本次就是这个）。
 */
export function runtimeInstallMissing(
	exists: (absPath: string) => boolean,
	installDir: string,
): string[] {
	const required = [
		'node_modules/@deepseek-ai/dsh/package.json',
		'node_modules/@deepseek-ai/dsh/lib/bin.js',
		'node_modules/@deepseek-ai/dsh-app-boot/package.json',
	];
	// 统一用 `/` 拼接：Windows 的 fs 也认正斜杠，这样判据在单测里可以完全不碰平台差异。
	const base = installDir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
	return required.filter(rel => !exists(`${base}/${rel}`));
}
