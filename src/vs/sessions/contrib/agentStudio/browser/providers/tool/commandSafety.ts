/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 命令安全护栏：HARDLINE 不可绕过地板（对齐 Hermes-Agent 的 HARDLINE_PATTERNS）。
 *
 * 纯逻辑模块（无 VS Code 依赖，可独立单测），对齐 terminalCommandGuards.ts /
 * executeCodeGuards.ts 的模式。
 *
 * 语义：HARDLINE 命中的命令是「灾难性、不可逆」的（删根目录 / 格式化磁盘 /
 * 覆写块设备 / fork bomb / 杀所有进程）。即使工具审批通过（用户点了允许）、
 * 即使 autonomous / yolo 模式，也【永不执行】——这是安全地板，不是审批项。
 *
 * 与 ToolApprovalService 的分工：
 *  - HARDLINE（本模块）：在 handler 最前置执行，命中即抛 NonRetryableToolError，
 *    审批流程根本不会介入，任何路由（inherit / auto-deny / interactive）都无法放行。
 *  - securityLevel=Dangerous 审批：拦截「可逆但有副作用」的命令（rm 子目录、
 *    git push --force 等），由审批门决定。
 */

/** 单条 hardline 命令形态：正则 + 可读标签。 */
export interface IHardlinePattern {
	/** 形态标识（日志用）。 */
	readonly id: string;
	/** 命中正则（对整条命令字符串测试）。 */
	readonly pattern: RegExp;
	/** 人类可读描述（错误消息用）。 */
	readonly label: string;
}

/**
 * HARDLINE 不可绕过地板模式表。第一条命中即生效。
 * 注意宁缺毋滥：只匹配「明确以灾难性破坏为目的」的命令形态，
 * 避免误伤正常构建/清理命令（如 `rm -rf ./node_modules`、`git clean -fd`）。
 */
export const HARDLINE_PATTERNS: readonly IHardlinePattern[] = [
	{
		// 删除文件系统根 / 家目录（rm -rf /、rm -rf /*、rm -rf ~、rm -rf $HOME，
		// 含标志拆分的 `rm -r -f /`）。目标必须是根/家目录，不拦 `rm -rf /tmp/x`。
		id: 'rm-root',
		pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:"|')?(\/|\/\*|~|\$HOME|\$\{HOME\})(?:\s|$)/,
		label: 'rm -rf / or ~ (delete filesystem root or home directory)',
	},
	{
		// 格式化 / 重建文件系统（mkfs、mkfs.ext4、mke2fs、mkswap）
		id: 'format-disk',
		pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|mkswap)\b/i,
		label: 'mkfs/mke2fs/mkswap (format or rebuild a filesystem)',
	},
	{
		// dd 覆写裸块设备（of=/dev/sda、/dev/nvme0n1、/dev/disk* 等）
		id: 'dd-overwrite-block-device',
		pattern: /\bdd\b[^|;&]*\bof=(?:"|')?\/dev\/(?:sd|hd|disk|nvme|vd|xvd|mmcblk|ram)\w*/i,
		label: 'dd of=/dev/... (overwrite a raw block device)',
	},
	{
		// fork bomb（Unix `:(){ :|:& };:` 或 Windows `%0|%0`）
		id: 'fork-bomb',
		pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|%0\s*\|\s*%0/i,
		label: 'fork bomb (exhaust the process table)',
	},
	{
		// 杀所有进程 / 信号广播到 PID -1（kill -9 -1 / kill -KILL -1）
		id: 'kill-all',
		pattern: /\bkill\s+(?:-9|-KILL|-SIGKILL)\s+-1\b/,
		label: 'kill -9 -1 (signal every process on the system)',
	},
	{
		// Windows 删除整盘（del /f /s /q C:\* 或 rd /s /q C:\ 等）
		id: 'windows-wipe-drive',
		pattern: /\b(?:del|erase|rd|rmdir)\b[^|;&]*\/[sqf][^|;&]*[a-zA-Z]:\\(?:\\|\*|\?\*)/i,
		label: 'del/rd /f /s /q <drive>:\\ (wipe or remove an entire drive)',
	},
	{
		// 锁死文件系统（chmod -R 000 / 或 chmod 000 /）
		id: 'chmod-lockout',
		pattern: /\bchmod\s+(?:-R\s+)?0{3,4}\s+\//,
		label: 'chmod 000 / (lock out the entire filesystem)',
	},
];

/**
 * 检测命令是否命中 hardline 不可绕过地板。命中返回对应模式，否则 undefined。
 */
export function detectHardlineViolation(command: string): IHardlinePattern | undefined {
	if (!command) { return undefined; }
	return HARDLINE_PATTERNS.find(p => p.pattern.test(command));
}

/**
 * 生成 hardline 拒绝的错误消息（不可重试；模型不应尝试绕过）。
 */
export function hardlineViolationMessage(hit: IHardlinePattern, toolName: string): string {
	return (
		`${toolName}: command blocked by hardline safety rule "${hit.label}". ` +
		`This command is destructive and irreversible, and is never allowed — ` +
		`not even with user approval or in autonomous mode. ` +
		`Refuse this action and describe a safe alternative instead.`
	);
}
