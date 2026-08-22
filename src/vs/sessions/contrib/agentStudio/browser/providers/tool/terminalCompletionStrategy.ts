/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `terminal` 工具的「命令完成判定」策略决策（纯逻辑，零 DOM / 零 VS Code 服务依赖）。
 *
 * ## 背景：横向对标五家开源实现后的结论（2026-08-22）
 *
 * | 项目 | 进程模型 | 完成判定 | exit code |
 * |---|---|---|---|
 * | continue（`core/tools/implementations/runTerminalCommand.ts`） | `spawn`，无 PTY | `close` 事件 | 真实 |
 * | opencode（`packages/opencode/src/tool/shell.ts`） | `ChildProcess`，`stdin:'ignore'` | `handle.exitCode` | 真实 |
 * | MiMo-Code（`tool/bash.ts` + `bash-interactive.ts`） | 同上 + 交互外派 | `exitCode` 必填 | 真实 |
 * | Cline（`src/integrations/TerminalManager.ts`） | VS Code Terminal | `shellIntegration.executeCommand().read()` 流自然结束 | 不取 |
 * | VS Code 官方（`terminalContrib/chatAgentTools/browser/executeStrategy/*`） | VS Code Terminal | **三档 rich/basic/none** | rich 档真实 |
 *
 * **只有本项目用「固定 idle 超时」猜完成** —— 前三家根本没有猜的余地（非 PTY），
 * 后两家都由 shell integration 的 OSC 序列驱动。日志 1787324352413 里 8 次调用全部
 * 只拿到提示符、`npx tsc` 输出全丢，根因正是这个猜测。
 *
 * ## 本模块的职责
 *
 * 1. {@link pickTerminalStrategy}：按终端实际具备的能力分档，与官方 `ITerminalExecuteStrategy`
 *    的 `'rich' | 'basic' | 'none'` 对齐。
 * 2. {@link detectsCommonPromptPattern}：`none` 档的兜底启发式 —— idle 到点后先看
 *    最后一行像不像 shell 提示符，不像就说明命令还在跑、应延长等待。
 *
 * 逻辑之所以抽成纯函数：分档与阈值语义必须能被单测钉住。上一轮「首次输出宽限」是
 * 直接写在执行函数里的常量，无法单测，只能靠下一份日志验证 —— 代价太高。
 */

/** 命令完成判定档位（与 VS Code 官方 `ITerminalExecuteStrategy.type` 同名同义）。 */
export type TerminalStrategyType = 'rich' | 'basic' | 'none';

/** 分档输入：终端当前具备的能力。 */
export interface ITerminalStrategyInput {
	/** 是否拿到了 `TerminalCapability.CommandDetection` 实现。 */
	readonly hasCommandDetection: boolean;
	/** `ICommandDetectionCapability.hasRichCommandDetection`。 */
	readonly hasRichCommandDetection: boolean;
}

/**
 * 选择完成判定策略。
 *
 * - `rich`  ：shell integration 完整可用 → `onCommandFinished` 事件 + **真实 exitCode**
 *             + `ITerminalCommand.getOutput()`（按 marker 取，天然不含提示符与回显）。
 * - `basic` ：有 CommandDetection 但非 rich → 仍可用事件判完成，exitCode 多数可用。
 * - `none`  ：无能力（自定义 executable 的 Git Bash 常落此档）→ idle + 提示符启发式。
 */
export function pickTerminalStrategy(input: ITerminalStrategyInput): TerminalStrategyType {
	if (!input.hasCommandDetection) { return 'none'; }
	return input.hasRichCommandDetection ? 'rich' : 'basic';
}

/** 提示符检测结果（`reason` 仅用于日志，便于事后从日志复盘判定过程）。 */
export interface IPromptDetectionResult {
	readonly detected: boolean;
	readonly reason: string;
}

/**
 * 判断一行文本是否像 shell 提示符。
 *
 * 移植自 VS Code 官方 `executeStrategy.ts::detectsCommonPromptPattern`，**刻意不直接
 * import** —— 那是 `workbench/contrib/terminalContrib/chatAgentTools/` 内部实现（非
 * 公开 API，且随上游重构可能变动）。此处保留同一份判据并注明来源，改上游时按需同步。
 *
 * 相比按命令名猜「是否慢启动」（上一轮的 `isSlowStartCommand`），这个判据**普适且
 * 无需维护命令名单**：命令没跑完时最后一行不会是提示符。
 */
export function detectsCommonPromptPattern(cursorLine: string): IPromptDetectionResult {
	if (cursorLine.trim().length === 0) {
		return { detected: false, reason: 'content is empty or whitespace-only' };
	}
	// PowerShell: `PS C:\path>`
	if (/PS\s+[A-Za-z]:\\.*>\s*$/.test(cursorLine)) {
		return { detected: true, reason: 'PowerShell prompt' };
	}
	// cmd.exe: `C:\path>`
	if (/^[A-Za-z]:\\.*>\s*$/.test(cursorLine)) {
		return { detected: true, reason: 'Command Prompt' };
	}
	// bash/zsh: 以 `$` 结尾
	if (/\$\s*$/.test(cursorLine)) {
		return { detected: true, reason: 'bash-style prompt' };
	}
	// root: 以 `#` 结尾
	if (/#\s*$/.test(cursorLine)) {
		return { detected: true, reason: 'root prompt' };
	}
	// Python REPL
	if (/^>>>\s*$/.test(cursorLine)) {
		return { detected: true, reason: 'Python REPL prompt' };
	}
	// starship 等自定义提示符
	if (/\u276f\s*$/.test(cursorLine)) {
		return { detected: true, reason: 'starship prompt' };
	}
	// 通用：以 `>` / `%` 结尾
	if (/[>%]\s*$/.test(cursorLine)) {
		return { detected: true, reason: 'generic prompt' };
	}
	return { detected: false, reason: `no prompt pattern in last line: "${cursorLine.slice(-60)}"` };
}

/**
 * 取文本最后一个非空行（用于提示符判定）。
 *
 * 注意**不要 trim 整体再取**：提示符行常以空格结尾（`$ `），而尾随换行必须先剔除。
 */
export function lastNonEmptyLine(text: string): string {
	if (!text) { return ''; }
	const lines = text.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim().length > 0) { return lines[i]; }
	}
	return '';
}

/** `none` 档的等待窗口决策输入。 */
export interface IIdleWaitInput {
	/** 距上次收到数据已静默的毫秒数达到了基础 idle 阈值时调用本决策。 */
	readonly collectedOutput: string;
	/** 已为本次命令等待的总毫秒数（自 sendText 起）。 */
	readonly elapsedMs: number;
	/** 允许的最长等待（通常是 clamp 后的 timeout）。 */
	readonly maxWaitMs: number;
}

/** `none` 档 idle 到点后的动作。 */
export type IdleWaitAction =
	| { readonly kind: 'done'; readonly reason: string }
	| { readonly kind: 'extend'; readonly reason: string };

/**
 * `none` 档：基础 idle 到点后，判断该收工还是延长等待。
 *
 * 对齐官方 `waitForIdleWithPromptHeuristics`（idle 后不像提示符就把窗口延长到 10×）：
 *  - 最后一行像提示符 → shell 已回到提示符，命令确实结束；
 *  - 不像 → 命令很可能还在跑（启动期静默、长时间无输出的构建），延长；
 *  - 已达 `maxWaitMs` → 无论如何收工（由上层 timeout 兜底，避免无限等待）。
 */
export function decideIdleWaitAction(input: IIdleWaitInput): IdleWaitAction {
	if (input.elapsedMs >= input.maxWaitMs) {
		return { kind: 'done', reason: `max wait ${input.maxWaitMs}ms reached` };
	}
	const tail = lastNonEmptyLine(input.collectedOutput);
	const prompt = detectsCommonPromptPattern(tail);
	if (prompt.detected) {
		return { kind: 'done', reason: `prompt detected (${prompt.reason})` };
	}
	return { kind: 'extend', reason: `no prompt yet (${prompt.reason})` };
}
