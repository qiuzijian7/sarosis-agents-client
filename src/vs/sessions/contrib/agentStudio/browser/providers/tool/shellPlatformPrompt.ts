/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-platform shell guidance for the `terminal` / `execute_code` tool descriptions.
 *
 * 设计动机（2026-08-21，借鉴 opencode `tool/shell/prompt.ts`）：
 * 本项目原先靠**运行时护栏**纠正 shell 方言错误（Unix-only 命令拦截 + PowerShell
 * cmdlet 反向拦截）。护栏是事后拦截 —— 模型先写错、被拒、再改写，至少浪费 1 轮
 * LLM 往返；实测日志 1787292837471 里出现「Unix head → 被拦 → 改用 PowerShell
 * cmdlet 裸用 → exit 255 → 才写对」的三轮试错。
 *
 * opencode 的做法是**事前预防**：按当前 shell 生成「别用 X 用 Y」映射表写进工具
 * 描述，直接掐掉模型选错的动机。成本近零（描述文本走 prompt prefix cache，一次
 * 付费长期摊薄），且与运行时护栏互补 —— 描述负责「大多数情况不写错」，护栏负责
 * 「万一写错必被拦」。
 *
 * 纯字符串模块：无 I/O、无 VS Code 依赖，便于单测。
 */

/** 当前生效的 shell 方言（由 Git Bash 探测结果 + 平台共同决定）。 */
export type ShellDialect = 'posix' | 'powershell' | 'cmd';

/**
 * 「别用 shell 做这件事，用这个工具」映射表 —— 三种方言共用的语义，
 * 只是被替代的 shell 命令不同。
 *
 * 为什么值得写进描述：这些任务用索引化工具（search_code/search_files）比 shell
 * 管道更快更准（无需 spawn、无输出截断、无方言差异），且 patch 的编辑是原子的、
 * 可作为 diff 审查 —— 实测日志里模型用 Python 脚本「读文件→定位行号→拼接替换」
 * 改代码，正是本表想消除的行为。
 */
interface IPreferredToolMapping {
	/** 任务描述（如 'Content search'） */
	readonly task: string;
	/** 应当使用的本产品工具 */
	readonly tool: string;
	/** 该方言下应避免的 shell 写法 */
	readonly avoid: Partial<Record<ShellDialect, string>>;
}

const PREFERRED_TOOL_MAPPINGS: readonly IPreferredToolMapping[] = [
	{
		task: 'Search file CONTENT',
		tool: 'search_code',
		avoid: { posix: 'grep / rg', powershell: 'Select-String', cmd: 'findstr' },
	},
	{
		task: 'Find FILES by name/glob',
		tool: 'search_files',
		avoid: { posix: 'find / ls', powershell: 'Get-ChildItem', cmd: 'dir /s' },
	},
	{
		task: 'Understand code structure / call chains',
		tool: 'search_graph / query_graph / get_architecture',
		avoid: { posix: 'grep pipelines', powershell: 'Select-String pipelines', cmd: 'findstr pipelines' },
	},
	{
		task: 'Read a file',
		tool: 'file_read',
		avoid: { posix: 'cat / head / tail', powershell: 'Get-Content', cmd: 'type' },
	},
	{
		task: 'Edit a file',
		tool: 'patch',
		avoid: { posix: 'sed -i / awk', powershell: 'Set-Content', cmd: 'copy / echo >' },
	},
	{
		task: 'Create / overwrite a file',
		tool: 'file_write',
		avoid: { posix: 'heredoc > file', powershell: 'Out-File / here-string', cmd: 'echo > file' },
	},
];

/** 渲染映射表为紧凑的多行文本（每行一条，`任务: 用 X（不要用 Y）`）。 */
function renderPreferredTools(dialect: ShellDialect): string {
	const lines: string[] = [];
	for (const m of PREFERRED_TOOL_MAPPINGS) {
		const avoid = m.avoid[dialect];
		lines.push(avoid ? `${m.task}: use ${m.tool} (NOT ${avoid})` : `${m.task}: use ${m.tool}`);
	}
	return lines.join('; ');
}

/**
 * 生成某方言的 shell 说明段（写进 terminal / execute_code 的 description）。
 *
 * @param dialect  当前 shell 方言
 * @param toolName 工具名（用于自指措辞）
 */
export function shellPlatformGuidance(dialect: ShellDialect, toolName: string): string {
	const preferred = ` Prefer purpose-built tools over shell pipelines — ${renderPreferredTools(dialect)}.` +
		' These are indexed (no spawn, no output truncation, no shell-dialect pitfalls) and patch edits are atomic and reviewable as a diff.' +
		` Reserve ${toolName} for things only a shell can do: builds, tests, package managers, git, and CLI scripts.`;

	switch (dialect) {
		case 'posix':
			return ' Runs on a POSIX shell — bash/zsh commands (head/tail/grep/sed/awk/cat/ls/find) are available.' + preferred;

		case 'powershell':
			return ' Runs on Windows PowerShell — Unix-only commands (head/tail/grep/sed/awk) are NOT available and are rejected before execution;' +
				' use PowerShell equivalents (Select-Object -First N, Select-String, Get-Content).' +
				' When you do need a PowerShell cmdlet inside a pipeline, wrap the WHOLE pipeline: powershell -NoProfile -Command "<pipeline>"' +
				' — piping straight into a cmdlet from cmd.exe fails with exit 255.' +
				' Output is truncated automatically, so do NOT add Select-Object -First / more just to limit it.' +
				preferred;

		case 'cmd':
			return ' Runs on Windows cmd.exe — Unix-only commands (head/tail/grep/sed/awk) are NOT available and are rejected before execution.' +
				' PowerShell cmdlets (Select-String, Get-Content, Out-String) do NOT exist in cmd.exe either:' +
				' wrap the WHOLE pipeline as powershell -NoProfile -Command "<pipeline>" when you need them' +
				' — piping straight into a cmdlet fails with exit 255.' +
				' Output is truncated automatically, so do NOT add more / Select-Object just to limit it.' +
				preferred;
	}
}

/**
 * 生成「Git Bash 可能存在」场景下的 Windows 说明段。
 *
 * 为什么需要这个变体：工具描述是**注册期静态文本**，而 Git Bash 探测是**运行期
 * 异步**（detectGitBash 走 fileService IPC）—— 注册时无法确知方言。故 Windows 上
 * 采用「主声明 POSIX + 回退提示」双段式：装了 Git Bash（开发机常态）模型第一
 * 选择写 Unix 即对；没装则运行时护栏兜底纠错。
 */
export function windowsDualShellGuidance(toolName: string): string {
	return ' On Windows the command runs via Git Bash (POSIX) when installed — head/tail/grep/sed/awk/cat/ls/find are available;' +
		' use forward-slash paths (C:/dir/file); wrap Windows-native commands as cmd /c <command> or powershell -NoProfile -Command "...".' +
		' If Git Bash is NOT installed the command falls back to PowerShell/cmd.exe, where Unix-only commands are rejected before execution' +
		' with the PowerShell equivalent, and PowerShell cmdlets must be wrapped as powershell -NoProfile -Command "<pipeline>"' +
		' (piping straight into a cmdlet from cmd.exe fails with exit 255).' +
		` Prefer purpose-built tools over shell pipelines — ${renderPreferredTools('posix')}.` +
		' These are indexed (no spawn, no output truncation, no shell-dialect pitfalls) and patch edits are atomic and reviewable as a diff.' +
		` Reserve ${toolName} for things only a shell can do: builds, tests, package managers, git, and CLI scripts.`;
}
