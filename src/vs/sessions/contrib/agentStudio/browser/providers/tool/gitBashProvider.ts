/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License.
 *  See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
//
// Git Bash 环境归一（Hermes 方案，2026-08-18 落地）
//
// 背景：Windows 上 agent 的 terminal/execute_code 命令经常是 Unix 方言
// （head/tail/grep/sed/awk），cmd.exe/PowerShell 下必失败。此前靠
// detectUnixOnlyCommand 拦截 + 报错纠错（下游堵漏）。
//
// Hermes-Agent 的策略是「环境归一」而非「命令翻译」：让 Windows 上真实存在
// 一套 POSIX 工具链（Git Bash 自带 coreutils），agent 终端直接跑 bash，
// Unix 方言命令从「必失败」变「天然正确」。Hermes 官方注释：
//   "terminal tool runs commands through Git Bash, same strategy Claude Code
//    uses. This sidesteps the POSIX-vs-Windows gap without rewriting every tool."
//
// 本模块提供：
//   1. detectGitBash()  —— 进程级缓存的 Git Bash 探测（候选链 + fileService 存在性检查）
//   2. gitBashShellEnvironment() —— PTY 终端用 env（CHERE_INVOKING 保持 cwd、
//      MSYS_NO_PATHCONV 禁止路径改写，对齐 Hermes）
//   3. coreutilsDir()   —— spawn 模式（execute_code）注入 PATH 前缀用的
//      coreutils 目录（Git 安装根下 usr\bin），对齐 Hermes _prepend_git_bash_dirs

import { URI } from '../../../../../../base/common/uri.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';

export interface IGitBashInfo {
	/** bash.exe 绝对路径（…\Git\bin\bash.exe） */
	bashPath: string;
	/** Git 安装根目录（…\Git），其下 usr\bin 含 coreutils */
	gitRoot: string;
}

/** Git Bash 安装候选链（按优先级）。用户可用 SAROS_GIT_BASH_PATH 覆盖。 */
function gitBashCandidates(): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (p: string) => { if (p && !seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); candidates.push(p); } };

	// 0. 用户显式覆盖（对齐 Hermes HERMES_GIT_BASH_PATH 的逃生舱设计）
	const override = (typeof process !== 'undefined' && process.env?.SAROS_GIT_BASH_PATH) || undefined;
	if (override) { push(override); }

	// 1. PATH 反推（实测：Git 常装在非默认盘，如 D:\Program Files\Git —— 固定路径
	//    探测不到；而 git.exe 所在的 <root>\cmd 一定在 PATH）。扫描 PATH 中形如
	//    `<root>\Git\cmd` / `<root>\Git\bin` / `<root>\Git\mingw64\bin` 的条目，
	//    反推 gitRoot 后拼 <root>\bin\bash.exe。天然排除 WSL 的 System32\bash.exe
	//    （Hermes 明确避开 WSL bash——它跳进 WSL 虚拟机，路径/环境完全不同）。
	const pathEnv = (typeof process !== 'undefined' && process.env?.['PATH']) || '';
	for (const entry of pathEnv.split(';')) {
		const m = entry.trim().match(/^(.*\\Git)\\(cmd|bin|mingw64\\bin|usr\\bin)$/i);
		if (m) { push(`${m[1]}\\bin\\bash.exe`); }
	}

	// 2. 常见固定安装位置（Program Files / x86 / 用户级安装）
	const programFiles = (typeof process !== 'undefined' && process.env?.['ProgramFiles']) || 'C:\\Program Files';
	const programFilesX86 = (typeof process !== 'undefined' && process.env?.['ProgramFiles(x86)']) || 'C:\\Program Files (x86)';
	const localAppData = (typeof process !== 'undefined' && process.env?.['LOCALAPPDATA']) || '';
	push(`${programFiles}\\Git\\bin\\bash.exe`);
	push(`${programFilesX86}\\Git\\bin\\bash.exe`);
	if (localAppData) { push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`); }
	return candidates;
}

// ── 进程级缓存（探测一次，全 agent 会话共享）────────────────────────
let _cached: Promise<IGitBashInfo | undefined> | undefined;

/**
 * 探测 Git Bash（仅 Windows）。找到返回 { bashPath, gitRoot }，否则 undefined。
 * 探测结果进程级缓存（含"未找到"——避免每条命令重复探测文件系统）。
 */
export function detectGitBash(fileService: IFileService, logService: ILogService): Promise<IGitBashInfo | undefined> {
	if (!isWindows) { return Promise.resolve(undefined); }
	if (_cached) { return _cached; }
	_cached = (async () => {
		for (const candidate of gitBashCandidates()) {
			try {
				if (await fileService.exists(URI.file(candidate))) {
					// bash.exe 形态：<gitRoot>\bin\bash.exe（标准）或 <gitRoot>\usr\bin\bash.exe
					// （用户覆盖可能传后者）。gitRoot 用于推导 coreutils（usr\bin）。
					const rootMatch = candidate.match(/^(.*\\Git)\\(?:usr\\)?bin\\bash\.exe$/i);
					const gitRoot = rootMatch
						? rootMatch[1]
						: candidate.slice(0, candidate.length - '\\bin\\bash.exe'.length);
					logService.info(`[GitBashProvider] git-bash detected: ${candidate} (gitRoot=${gitRoot})`);
					return { bashPath: candidate, gitRoot };
				}
			} catch { /* 单候选探测失败继续下一个 */ }
		}
		logService.info('[GitBashProvider] git-bash NOT found — terminal/execute_code stay on Windows-native shell (Unix-command guard active)');
		return undefined;
	})();
	return _cached;
}

/**
 * PTY 终端模式（terminal 工具）专用 env。
 * - CHERE_INVOKING=1：login shell 不跳转到 HOME，保持创建终端时传入的 cwd
 *   （Git Bash 默认 --login 会 cd ~，这是“打开就变 home 目录”的根源）。
 * - MSYS_NO_PATHCONV=1 / MSYS2_ARG_CONV_EXCL=*：禁用 MSYS 自动路径转换，
 *   避免 `/c/foo` ↔ `C:\foo` 之外还有参数级改写（如 `--flag=/x` 被改写）。
 *   对齐 Hermes terminal 实现的 env 注入。
 */
export function gitBashShellEnvironment(): Record<string, string> {
	return {
		CHERE_INVOKING: '1',
		MSYS_NO_PATHCONV: '1',
		MSYS2_ARG_CONV_EXCL: '*',
	};
}

/**
 * spawn 模式（execute_code，bash -c 非登录非交互）的 PATH 前缀目录。
 * 非登录 bash 不会 source /etc/profile，PATH 不含 /usr/bin → coreutils 不可用，
 * 故显式注入 <gitRoot>\usr\bin（Windows 格式 PATH；MSYS bash 启动时自动转换为
 * /usr/bin 优先的 MSYS 格式）。对齐 Hermes _prepend_git_bash_dirs。
 */
export function coreutilsDir(info: IGitBashInfo): string {
	return `${info.gitRoot}\\usr\\bin`;
}

/** 测试钩子：重置进程级缓存。 */
export function _resetGitBashCacheForTests(): void {
	_cached = undefined;
}
