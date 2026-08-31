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
import { isWindowsPlatform, type ShellDialect } from './shellDialect.js';

/** 操作系统显示名。 */
export function osDisplayName(): string {
	if (isWindows) { return 'Windows'; }
	if (isMacintosh) { return 'macOS'; }
	if (isLinux) { return 'Linux'; }
	if (isWeb) { return 'Web (Browser)'; }
	return 'Unknown';
}

/**
 * 生成「## Operating Environment」段落（stable 层注入）。
 *
 * @param dialect 当前 shell 方言，由**调用方（browser 层）运行时探测后经
 *   `resolveShellDialect()` 传入** —— 本模块在 common 层，不能反向依赖 browser 层的
 *   `gitBashProvider`（layer 校验会拦），故只接收判定结果。
 *   `undefined` = 未探测/探测失败。
 */
export function buildEnvironmentDirective(options?: { dialect?: ShellDialect }): string {
	const os = osDisplayName();
	if (isWindowsPlatform()) {
		// ★ 2026-08-30（日志 20260829T232635）：此前这一段**静态写死**「via
		// PowerShell/cmd.exe + 用 Select-Object / Select-String / Get-Content」，
		// 而 execute_code / terminal 实际经 Git Bash 以 bash 执行（Hermes 环境归一，
		// 见 gitBashProvider.ts）。模型照本段写 PowerShell cmdlet →
		// `Select-Object: command not found`（exit 127），白烧一整轮。
		// 方言真源是 `common/shellDialect.ts` 的 resolveShellDialect()，由运行时
		// Git Bash 探测结果驱动，不能是平台常量。
		if (options?.dialect === 'posix') {
			return [
				'## Operating Environment',
				'',
				`The current operating system is ${os}. The terminal and execute_code tools run commands via Git Bash (a POSIX shell).`,
				'POSIX commands (head, tail, grep, sed, awk, find, ls, cat) ARE available.',
				'PowerShell cmdlets (Select-Object, Select-String, Get-Content, Get-ChildItem, Write-Host, ...) are NOT — they do not exist in this shell, and using one fails with "command not found" (exit 127). Use the POSIX equivalents (head/tail/grep/sed/awk) instead, and never wrap a command in `powershell -Command`.',
				'For code search, prefer the dedicated search_code / search_files tools over shell pipelines.',
				'',
			].join('\n');
		}
		// 未探测 / 探测失败：两段并列，不再断言某一种方言（说错比不说更贵 —— 模型会照着错的写）。
		// 写错方言时执行前护栏会拦下并给出正确写法（见 executeCodeGuards）。
		return [
			'## Operating Environment',
			'',
			`The current operating system is ${os}. The terminal and execute_code tools run commands via Git Bash (POSIX) when it is installed; otherwise they fall back to PowerShell/cmd.exe.`,
			'Do not assume either dialect: if a command fails with "command not found" or "is not recognized as an internal or external command", you used the wrong dialect for this shell — switch to the other one.',
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
