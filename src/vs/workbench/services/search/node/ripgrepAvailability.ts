/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ripgrep 二进制的**多级探测**（2026-09-07，彻底解决「打包产物缺 rg.exe → 搜索
 * 永久降级」问题，对齐 Continue/Cline 式运行时 fallback 与 Cursor 等 fork 的
 * vendor 做法形成的三层防御的最后一层）。
 *
 * 背景：@vscode/ripgrep 的 postinstall 从 GitHub release 下载平台二进制；打包机
 * CI 无 GITHUB_TOKEN/网络受限时下载失败 → bin/ 为空 → 打包产物（asar.unpacked）
 * 内没有 rg.exe → 运行时 spawn 恒 ENOENT → searchService 永久降级（Node walk，
 * 5000 文件预算 cap，大仓库假阴性频发，日志 1788746435013 系列实证）。
 *
 * 探测顺序（模块加载期一次性执行并缓存）：
 *  1. 打包内置路径（node_modules.asar.unpacked/@vscode/ripgrep/bin/rg）；
 *  2. 系统 PATH 中已安装的 rg（`where rg` / `which rg`）——对**已发布的旧安装包**
 *     也生效：用户装一次 rg 即可恢复全树搜索，无需重装 VsSaros。
 *
 * 版本兼容性：VS Code 的 rg 用法（--files / --json / -g 等）在 v11+ 全兼容，
 * 系统 rg（常见 v13/v14/v15）可直接使用，无需 --version 门控。
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import { rgPath } from '@vscode/ripgrep';

const rgDiskPathDefault = rgPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');

function probeRipgrep(): { path: string | undefined; source: string } {
	try {
		if (fs.existsSync(rgDiskPathDefault)) {
			return { path: rgDiskPathDefault, source: 'bundled (asar.unpacked)' };
		}
	} catch { /* fs 异常按缺失处理 */ }

	// 兜底：系统 PATH 中探测 rg（仅在内置缺失时执行一次；where/which 同步 ~几十 ms）。
	try {
		const cmd = process.platform === 'win32' ? 'where rg' : 'which rg';
		const firstLine = cp.execSync(cmd, { encoding: 'utf8', timeout: 5000 })
			.split(/\r?\n/)
			.map(l => l.trim())
			.find(l => l.length > 0);
		if (firstLine && fs.existsSync(firstLine)) {
			return { path: firstLine, source: 'system PATH' };
		}
	} catch { /* 系统未安装 rg → 保持缺失 */ }

	return { path: undefined, source: 'none' };
}

const probed = probeRipgrep();

/** 解析出的 rg 可执行文件路径；不可用时为空串（调用方必须先判 isRipgrepAvailable）。 */
export const rgDiskPath: string = probed.path ?? '';

export const isRipgrepAvailable: boolean = probed.path !== undefined;

/** rg 来源（bundled / system PATH / none）——诊断日志用。 */
export const ripgrepSource: string = probed.source;

/**
 * Human-readable hint shown to the user when ripgrep is unavailable.
 * Kept in sync with the build-side `ensureRipgrepBinaryTask` log message.
 */
export const RIPGREP_MISSING_HINT =
	`ripgrep binary not found (bundled: ${rgDiskPathDefault}, system PATH: not found). ` +
	`Full-tree search requires ripgrep. Fix one of: (1) re-install VsSaros (the build's ` +
	`ensureRipgrepBinaryTask copies rg into node_modules.asar.unpacked); (2) install rg ` +
	`into PATH (winget install BurntSushi.ripgrep.MSVC / choco install ripgrep); ` +
	`(3) copy @vscode/ripgrep/bin/rg[.exe] from a working install into ` +
	`<app>/node_modules.asar.unpacked/@vscode/ripgrep/bin/ manually.`;
