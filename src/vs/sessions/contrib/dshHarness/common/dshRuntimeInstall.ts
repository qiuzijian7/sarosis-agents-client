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
 * 解析唯一内置运行时之前做文件级体检：关键构件缺失就报告安装包不完整，
 * 不切换版本，也不把损坏副本交给 Host。
 *
 * 检查 CLI 与工具核心的构件，不遍历完整依赖树。`dsh --version` 不加载工具插件，
 * 因此版本探测成功并不能证明 `dsh-tools` 的包声明、注册表和执行管线完整。
 */
export function runtimeInstallMissing(
	exists: (absPath: string) => boolean,
	installDir: string,
): string[] {
	const required = [
		'node_modules/@deepseek-ai/dsh/package.json',
		'node_modules/@deepseek-ai/dsh/lib/bin.js',
		'node_modules/@deepseek-ai/dsh-app-boot/package.json',
		'node_modules/@deepseek-ai/dsh-tools/package.json',
		'node_modules/@deepseek-ai/dsh-tools/lib/index.js',
		'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js',
	];
	// 统一用 `/` 拼接：Windows 的 fs 也认正斜杠，这样判据在单测里可以完全不碰平台差异。
	const base = installDir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
	return required.filter(rel => !exists(`${base}/${rel}`));
}
