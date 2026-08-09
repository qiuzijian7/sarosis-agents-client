/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 运行环境（OS / Shell）注入 system prompt stable 层的指令生成。
 *
 * 背景（2026-08-09，日志 1786264843850）：此前 OS 信息仅在 user_info 标签
 * （贴在 user message 上），system prompt 层无平台信息 → 模型在 Windows 上
 * 反复写 Unix 语法（`dir ... | head -50`）导致 terminal 失败。这里把当前
 * 操作系统与可用 shell 语法写进 system prompt，模型每轮决策时都可见。
 */

import { isWindows, isMacintosh, isLinux, isWeb } from '../../../../base/common/platform.js';

/** 操作系统显示名。 */
export function osDisplayName(): string {
	if (isWindows) { return 'Windows'; }
	if (isMacintosh) { return 'macOS'; }
	if (isLinux) { return 'Linux'; }
	if (isWeb) { return 'Web (Browser)'; }
	return 'Unknown';
}

/** 判断是否 Windows（PowerShell/cmd 语义）。 */
function isWindowsPlatform(): boolean {
	return isWindows && !isWeb;
}

/** 生成「## Operating Environment」段落（stable 层注入）。 */
export function buildEnvironmentDirective(): string {
	const os = osDisplayName();
	if (isWindowsPlatform()) {
		return [
			'## Operating Environment',
			'',
			`The current operating system is ${os}. The terminal tool executes commands via PowerShell/cmd.exe.`,
			'Unix-only commands (head, tail, grep, sed, awk, find, ls, cat) are NOT available. Use PowerShell equivalents:',
			'- `Select-Object -First <N>` instead of `head -N`',
			'- `Select-String` instead of `grep`',
			'- `Get-ChildItem` instead of `ls` / `find .`',
			'- `Get-Content` instead of `cat`',
			'- `Sort-Object` / `Select-Object` instead of `sort` / `head`',
			'For code search, prefer the dedicated search_code / search_files tools over shell pipelines.',
			'',
		].join('\n');
	}
	// 非 Windows：仅提示环境，不强行约束语法。
	return [
		'## Operating Environment',
		'',
		`The current operating system is ${os}. Terminal commands use standard Unix shell syntax.`,
		'',
	].join('\n');
}
