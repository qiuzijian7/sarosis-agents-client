/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shell 方言**单一真源**。
 *
 * ## 为什么需要这个模块（2026-08-30，日志 20260829T232635）
 *
 * 「当前 shell 是什么方言」此前在**三处各自判定**，判出三个互相冲突的答案：
 *   ① `environmentDirective.ts` —— 静态写死「Windows = PowerShell/cmd.exe」；
 *   ② `shellPlatformPrompt.ts` —— 有 `ShellDialect` 类型，但方言值由调用方硬编码传入；
 *   ③ `compatibilityTools.ts` / `coreTools.ts` —— 各自内联
 *      `(!isWindows ? 'posix' : (gitBash ? 'posix' : 'cmd'))`，**同一行写了两遍**。
 *
 * 后果：模型照 ① 写 PowerShell cmdlet，而实际执行走 ③ 判出的 Git Bash →
 * `Select-Object: command not found`（exit 127）。这是本次四类告警的**共同根因**。
 *
 * 本模块把判定收敛为**一个纯函数**：探测结果进、方言出。消费方一律调它，
 * 不再各自推导。
 *
 * ## 为什么放 common 层
 *
 * 判定只依赖 `isWindows` / `isWeb` 这类平台常量（无任何 I/O），common 与 browser
 * 两层都能用。此前 `ShellDialect` 类型定义在 browser 层的 `shellPlatformPrompt.ts`，
 * 导致 common 层的 `environmentDirective.ts` 无法引用它、只能退化成布尔参数，
 * 于是又多一份「布尔 ↔ 方言」的转换逻辑。
 *
 * 纯函数、无 I/O，便于单测。
 */

import { isWindows, isWeb } from '../../../../base/common/platform.js';

/** 当前生效的 shell 方言。 */
export type ShellDialect = 'posix' | 'powershell' | 'cmd';

/** 是否 Windows 原生 shell 语义（PowerShell/cmd），Web 环境不算。 */
export function isWindowsPlatform(): boolean {
	return isWindows && !isWeb;
}

/**
 * 由 Git Bash 探测结果解析当前 shell 方言。
 *
 * @param hasGitBash Git Bash（POSIX shell）是否可用。
 *   **必须传探测结果**，不得由平台常量推断 —— 这正是本次事故的根因：
 *   Windows 上装了 Git Bash 时，命令实际跑在 POSIX shell 里。
 *   非 Windows 平台传什么都返回 `'posix'`（探测方本就只在 Windows 上跑）。
 *
 * @returns `'posix'`（含 Git Bash 与所有非 Windows 平台）或 `'cmd'`。
 *   当前不会产出 `'powershell'` —— 保留该分支是为了让下游的 cmdlet 护栏
 *   （`dialect !== 'powershell'`）在将来真接入 PowerShell 时自动让位。
 */
export function resolveShellDialect(hasGitBash: boolean | undefined): ShellDialect {
	if (!isWindowsPlatform()) { return 'posix'; }
	return hasGitBash ? 'posix' : 'cmd';
}
