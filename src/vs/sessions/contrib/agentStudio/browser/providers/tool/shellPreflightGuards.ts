/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { detectHardlineViolation, hardlineViolationMessage } from './commandSafety.js';
import {
	detectBareSourceCode, bareSourceCodeGuardMessage,
	detectScriptSourceWrite, scriptSourceWriteGuardMessage,
} from './executeCodeGuards.js';
import { detectCommandObfuscation, obfuscationBlockedMessage } from '../../../common/shellStaticAnalysis.js';

/**
 * 两个 shell 工具（`execute_code` / `terminal`）**共用**的执行前护栏 —— 单一入口。
 *
 * ## 为什么必须共用（2026-09-13）
 * 此前这四条护栏是**各自内联**在两个 handler 里的，结果出现了真实的**不对称缺口**：
 *
 * | 护栏 | execute_code | terminal |
 * |---|---|---|
 * | HARDLINE 不可绕过地板 | ✅ | ✅ |
 * | 裸源码（多行源码当命令） | ✅ | ❌ **缺失** |
 * | 源码写入（脚本改源码） | ✅ | ✅ |
 * | 混淆 / 下载即执行 | ✅ | ❌ **缺失** |
 *
 * 最严重的后果：`curl … | bash` / `base64 -d | bash` / `iwr … | iex` 这类
 * **下载即执行（RCE / prompt-injection 向量）** 只挂在 `execute_code` 上 ——
 * **同一句命令走 `terminal` 就能绕过**（只剩审批兜底，而用户可能已对 terminal
 * 选过「始终允许」）。
 *
 * 把「命令字符串 → 拒绝理由」收敛成一个纯函数、两条路径都调它，
 * **结构上不可能再漂移**：新增/调整护栏只改这里，两个工具自动同时生效。
 *
 * ## 判定顺序（与 `execute_code` 既有顺序一致，勿随意调整）
 *   1. HARDLINE 不可绕过地板（灾难性 / 不可逆）
 *   2. 裸源码（多行源码当 command → shell 拿 `import` 当程序名，必然 exit 1）
 *   3. 源码写入（脚本直接写源码文件 → 不留 checkpoint、不过编辑审批）
 *   4. 混淆 / 下载即执行（`block:true` 的项明确恶意，直接拒绝）
 *
 * 顺序理由：**越不可逆、越明确的越靠前** —— 先给出最严重的定性，模型的纠偏才有针对性。
 */

/** 执行前护栏的拒绝结果。 */
export interface IShellPreflightRejection {
	/** 命中的护栏类别（日志分类用）。 */
	readonly kind: 'hardline' | 'bare-source' | 'source-write' | 'obfuscation';
	/** 供日志的细节（各护栏自行保证不含多余敏感信息）。 */
	readonly detail: string;
	/** 给模型的完整拒绝文案（可直接作为 `NonRetryableToolError` 的消息）。 */
	readonly message: string;
}

/**
 * 对模型传入的原始命令跑一遍**共用的**执行前护栏。
 *
 * @param command 模型传入的原始命令（**不要**传方言改写后的版本：护栏要判的是模型的原意）。
 * @param toolName 工具名（进错误文案，让模型知道是哪条路径被拦）。
 * @param cwd 命令的**实际运行目录**（两个工具都支持该参数）—— 只影响源码写入护栏的
 *   「目标是否产物」判定：相对路径会先拼成 `cwd/target` 再判。
 *   省略时保持原行为（裸文件名 fail-closed 按源码处理）。
 *   ⚠ 本函数**不解析命令里的 `cd`** —— `cd X && Y` 由 `agentTurnExecutor` 在执行前用
 *   `tryRewriteLeadingCd` 规范化成 `{command: Y, cwd: X}`（2026-09-06 方案 B），
 *   到这里已是 `cwd` 参数。**不要**在此再加一份 cd 解析（同一语义两份实现必然漂移）。
 * @returns 拒绝理由；未命中返回 `undefined`（放行，继续走各自工具的后续逻辑）。
 */
export function shellPreflightRejection(
	command: string, toolName: string, cwd?: string,
): IShellPreflightRejection | undefined {
	if (!command) { return undefined; }

	// 1) HARDLINE：灾难性、不可逆 —— 任何审批与自主模式都无法放行
	const hardline = detectHardlineViolation(command);
	if (hardline) {
		return {
			kind: 'hardline',
			detail: `${hardline.id} (${hardline.label})`,
			message: hardlineViolationMessage(hardline, toolName),
		};
	}

	// 2) 裸源码护栏：多行 Python/JS 源码直接当 command 传（日志 1787292837471）
	const bareSource = detectBareSourceCode(command);
	if (bareSource) {
		return {
			kind: 'bare-source',
			detail: `first line: ${bareSource}`,
			message: bareSourceCodeGuardMessage(bareSource, toolName),
		};
	}

	// 3) 源码写入护栏：脚本里 open(p,"w") / sed -i / writeFileSync 改源码（日志 1787319805992）
	//    ★ 传 `cwd`：否则 `cwd: "docs/kb-mockups"` + `> admin.html` 这类**产物写入**
	//      会被误拦（三条豁免规则都要求路径含目录段，裸名一个都不匹配）。
	const sourceWrite = detectScriptSourceWrite(command, cwd);
	if (sourceWrite) {
		return {
			kind: 'source-write',
			detail: `${sourceWrite.api}, target=${sourceWrite.target}`,
			message: scriptSourceWriteGuardMessage(sourceWrite, toolName),
		};
	}

	// 4) 混淆 / 下载即执行：block:true 的项（remote-pipe / decode-pipe / iex / invoke-expression）
	//    明确恶意，直接拒绝；其余（eval / 命令替换）仅由既有 BLOCKING_SHELL_TOKENS 决定审批。
	const blockedObfuscation = detectCommandObfuscation(command).find(f => f.block);
	if (blockedObfuscation) {
		return {
			kind: 'obfuscation',
			detail: `${blockedObfuscation.kind} matched \`${blockedObfuscation.matched}\``,
			message: obfuscationBlockedMessage(blockedObfuscation, toolName),
		};
	}

	return undefined;
}
