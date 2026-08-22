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

/** sandbox process 的最小结构（只用到 env / shellEnv）。 */
interface ISandboxProcessLike {
	readonly env?: Record<string, string | undefined>;
	shellEnv?(): Promise<Record<string, string | undefined>>;
}
interface ISandboxGlobalLike {
	readonly vscode?: { readonly process?: ISandboxProcessLike };
}

/**
 * sandbox renderer 暴露的 process（`globalThis.vscode.process`）。
 *
 * ⚠ 为什么运行时取而不 `import { process } from base/parts/sandbox/electron-browser/globals.js`：
 * 本文件在 `browser` 层，静态 import `electron-browser` 会触发 layer 校验
 * （local/code-layering + local/code-import-patterns）。而 `execute_code` 走
 * 主进程 IPC 时也是运行时读 `globalThis.vscode`（compatibilityTools.ts），
 * 此处沿用同一既有做法。
 */
function sandboxProcess(): ISandboxProcessLike | undefined {
	return (globalThis as unknown as ISandboxGlobalLike)?.vscode?.process;
}

export interface IGitBashInfo {
	/** bash.exe 绝对路径（…\Git\bin\bash.exe） */
	bashPath: string;
	/** Git 安装根目录（…\Git），其下 usr\bin 含 coreutils */
	gitRoot: string;
}

/** 环境变量表（来源：sandbox process.env 或 shellEnv()）。 */
type EnvMap = Record<string, string | undefined>;

/**
 * 大小写不敏感读环境变量。
 *
 * ⚠ 两个 Windows 坑（2026-08-21 实证，日志 1787292837471）：
 *  1. Node 在 win32 给 `process.env` 装了大小写不敏感代理（`.PATH` / `.Path` 都能取），
 *     但 sandbox preload 暴露的是 `{ ...process.env }` —— **spread 后代理丢失**，
 *     只剩精确 own key。Windows 原生 key 常为 `Path`，硬编码 `env['PATH']` 取不到。
 *  2. 因此这里必须遍历 key 做 `/^name$/i` 匹配，不能直接索引。
 */
function envGet(env: EnvMap, name: string): string | undefined {
	const direct = env[name];
	if (direct !== undefined) { return direct; }
	const lower = name.toLowerCase();
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === lower) { return env[key]; }
	}
	return undefined;
}

/** Git Bash 安装候选链（按优先级）。用户可用 SAROS_GIT_BASH_PATH 覆盖。 */
function gitBashCandidates(env: EnvMap): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (p: string) => { if (p && !seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); candidates.push(p); } };

	// 0. 用户显式覆盖（对齐 Hermes HERMES_GIT_BASH_PATH 的逃生舱设计）
	const override = envGet(env, 'SAROS_GIT_BASH_PATH');
	if (override) { push(override); }

	// 1. PATH 反推（实测：Git 常装在非默认盘，如 D:\Program Files\Git —— 固定路径
	//    探测不到；而 git.exe 所在的 <root>\cmd 一定在 PATH）。扫描 PATH 中形如
	//    `<root>\Git\cmd` / `<root>\Git\bin` / `<root>\Git\mingw64\bin` 的条目，
	//    反推 gitRoot 后拼 <root>\bin\bash.exe。天然排除 WSL 的 System32\bash.exe
	//    （Hermes 明确避开 WSL bash——它跳进 WSL 虚拟机，路径/环境完全不同）。
	const pathEnv = envGet(env, 'PATH') ?? '';
	for (const entry of pathEnv.split(';')) {
		const m = entry.trim().match(/^(.*\\Git)\\(cmd|bin|mingw64\\bin|usr\\bin)$/i);
		if (m) { push(`${m[1]}\\bin\\bash.exe`); }
	}

	// 2. 常见固定安装位置（Program Files / x86 / 用户级安装）
	const programFiles = envGet(env, 'ProgramFiles') ?? 'C:\\Program Files';
	const programFilesX86 = envGet(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
	const localAppData = envGet(env, 'LOCALAPPDATA') ?? '';
	push(`${programFiles}\\Git\\bin\\bash.exe`);
	push(`${programFilesX86}\\Git\\bin\\bash.exe`);
	if (localAppData) { push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`); }

	// 3. 非默认盘兜底（实证：本机 Git 装在 D:\Program Files\Git，而 renderer 侧
	//    env 可能缺 PATH → 步骤 1 反推为空、步骤 2 只指向 C 盘 → 全部落空）。
	//    穷举常见数据盘的标准/绿色安装位置，代价仅几次 fileService.exists()。
	for (const drive of ['D', 'E', 'F', 'G']) {
		push(`${drive}:\\Program Files\\Git\\bin\\bash.exe`);
		push(`${drive}:\\Git\\bin\\bash.exe`);
	}
	return candidates;
}

/**
 * 读取用于探测的环境变量表。
 *
 * ⚠ 根因（2026-08-21 实证）：sandbox renderer **没有全局 `process`** —— 它挂在
 * `globalThis.vscode.process`（见 base/parts/sandbox/electron-browser/globals.ts）。
 * 旧代码写 `typeof process !== 'undefined' && process.env?.['PATH']`，在 renderer
 * 里恒为 falsy → PATH 为空 → 候选链只剩 C 盘固定路径 → Git 装在 D 盘就必然
 * 「NOT found」（日志 1787292837471 L1883 / 1787281768872 L5501 实测）。
 *
 * 正确姿势：用 sandbox 暴露的 `process.shellEnv()`（= IShellEnvironmentService 的
 * 实现本体），它经主进程解析，保证含完整 PATH（即使应用不是从终端启动）。
 * 失败/超时则退回 `sandboxProcess.env`，再退回空表（由固定候选兜底）。
 */
async function resolveProbeEnv(logService: ILogService): Promise<EnvMap> {
	const proc = sandboxProcess();
	if (!proc) {
		logService.info('[GitBashProvider] sandbox process unavailable — relying on fixed candidates only');
		return {};
	}
	try {
		if (typeof proc.shellEnv === 'function') {
			const shellEnv = await withTimeout(
				Promise.resolve(proc.shellEnv()),
				SHELL_ENV_TIMEOUT_MS,
				undefined as EnvMap | undefined,
			);
			if (shellEnv && Object.keys(shellEnv).length > 0) { return shellEnv; }
			logService.info('[GitBashProvider] shellEnv() empty or timed out — falling back to sandbox process.env');
		}
	} catch (err) {
		logService.info(`[GitBashProvider] shellEnv() failed (${err instanceof Error ? err.message : String(err)}) — falling back to sandbox process.env`);
	}
	try {
		return proc.env ?? {};
	} catch {
		return {};
	}
}

// ── 进程级缓存（探测一次，全 agent 会话共享）────────────────────────
let _cached: Promise<IGitBashInfo | undefined> | undefined;

/** 单个候选路径的存在性探测上限。见 detectGitBash 注释。 */
const PROBE_TIMEOUT_MS = 2_000;
/** 整体探测上限（所有候选之和）。 */
const TOTAL_PROBE_TIMEOUT_MS = 6_000;
/** shellEnv() 解析上限（走主进程 IPC，不能拖垮探测链）。 */
const SHELL_ENV_TIMEOUT_MS = 3_000;

/** 给 promise 套一个超时（超时返回 fallback，不抛错）。 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		let settled = false;
		const t = setTimeout(() => { if (!settled) { settled = true; resolve(fallback); } }, ms);
		p.then(
			(v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
			() => { if (!settled) { settled = true; clearTimeout(t); resolve(fallback); } },
		);
	});
}

/**
 * 探测 Git Bash（仅 Windows）。找到返回 { bashPath, gitRoot }，否则 undefined。
 * 探测结果进程级缓存（含"未找到"——避免每条命令重复探测文件系统）。
 *
 * ⚠ 超时保护（2026-08-20，修「LLM 卡住、聊天框一直处理中」事故）：
 * `fileService.exists()` 走 IPC 到文件服务，遇到不可达路径（断开的网络驱动器、
 * 挂起的挂载点、被安全软件拦截的路径）可能长时间不返回甚至永不返回。而本函数
 * 的结果是**进程级 Promise 缓存**——一次挂起就会让之后所有 execute_code /
 * terminal 调用永久 await 同一个悬挂 Promise，整个 agent loop 挂死。
 * 因此：① 每个候选单独限时 ② 整体再限时 ③ 超时按「未找到」处理（回退
 * Windows 原生 shell + Unix 命令护栏，功能降级但绝不挂起）。
 *
 * ⚠ env 来源（2026-08-21 修「Git Bash 已装却检测不到」）：见 resolveProbeEnv。
 */
export function detectGitBash(fileService: IFileService, logService: ILogService): Promise<IGitBashInfo | undefined> {
	if (!isWindows) { return Promise.resolve(undefined); }
	if (_cached) { return _cached; }
	const probeAll = (async (): Promise<IGitBashInfo | undefined> => {
		const env = await resolveProbeEnv(logService);
		const candidates = gitBashCandidates(env);
		const pathLen = (envGet(env, 'PATH') ?? '').length;
		// 可诊断日志：上次排查耗时很久，就是因为「NOT found」没说清 PATH 到底读到没有。
		logService.info(
			`[GitBashProvider] probing ${candidates.length} candidate(s) (envKeys=${Object.keys(env).length}, PATH len=${pathLen})`,
		);
		for (const candidate of candidates) {
			try {
				// 单候选限时：不可达路径不拖垮整条探测链
				const exists = await withTimeout(
					Promise.resolve(fileService.exists(URI.file(candidate))),
					PROBE_TIMEOUT_MS,
					false,
				);
				if (exists) {
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
		logService.info(
			`[GitBashProvider] git-bash NOT found after probing ${candidates.length} candidate(s) ` +
			`(PATH len=${pathLen}) — terminal/execute_code stay on Windows-native shell (Unix-command guard active). ` +
			'Hint: set SAROS_GIT_BASH_PATH (system-level env var) to the bash.exe path and restart.',
		);
		return undefined;
	})();
	// 整体兜底：即使逐候选限时全部生效，也再加一道总闸，保证本 Promise 必定 settle
	_cached = withTimeout(probeAll, TOTAL_PROBE_TIMEOUT_MS, undefined).then((r) => {
		if (r === undefined) {
			// 可能是真的没找到（上面已打日志），也可能是总闸超时——补一条可诊断日志
			logService.info('[GitBashProvider] detection settled with no git-bash (not found or probe timed out)');
		}
		return r;
	});
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
