/**
 * ego lite CLI（`ego-browser`）的**定位**与**执行** —— 纯函数 + 一次 spawn，便于单测。
 *
 * ## 两个真问题（我们的实现与"照抄上游 heredoc 用法"的差别）
 *
 * ① **PATH 可能是陈旧的**。Windows 上 ego lite 的 onboarding 才把 `ego-browser` 写进 PATH，而
 *    PATH 只对**之后**启动的进程生效（上游 `references/install.md` 明确写了这条）。dsh Host 是
 *    长驻进程，用户装完 app 再去聊天框里让模型 `ego-browser skill` ⇒ 大概率 `command not found`。
 *    ⇒ 这里**不依赖 PATH**：先按已知安装位置探测（config / 环境变量 / PATH / 常见目录四条），
 *    探测结果与"试过哪些地方"都要能如实报出来（否则用户只会看到一句"没找到"，无从下手）。
 *
 * ② **Windows 没有 heredoc**。上游给 PowerShell 用户的替代是 `ego-browser nodejs -e "..."`，
 *    但 `-e` 会把脚本塞进命令行（引号/换行/长度三重风险）。这里改为**把脚本写进子进程 stdin**
 *    —— 与 bash 的 `<<'EOF'` 在语义上逐字等价（CLI 本来就是读 stdin），且**不落临时文件**。
 *
 * ## 关于 .cmd 垫片
 *
 * Windows 上 `ego-browser` 通常是 `.cmd` 垫片（npm 风格）。node 不能直接 spawn 一个批处理
 * （会 EINVAL/ENOENT）⇒ 必须经 `cmd.exe /d /s /c`。这里用 `windowsVerbatimArguments` +
 * 整体加引号那一招（`/s` 会剥掉最外层一对引号），路径带空格时也成立。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** CLI 的可执行名（不带扩展名）。 */
export const CLI_BASENAME = 'ego-browser';

/** 缺省超时：ego 的页面动作本来就比 CDP 直连慢一点（快照/等待），120s 是"复杂一屏"的量级。 */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 600_000;

/** 探测脚本的超时（只问版本/任务空间，不该慢）。 */
export const PROBE_TIMEOUT_MS = 30_000;

/** 某个平台上「可执行文件」的全部候选文件名（按优先级）。 */
export function executableNames(platform) {
	return platform === 'win32'
		? [`${CLI_BASENAME}.cmd`, `${CLI_BASENAME}.exe`, `${CLI_BASENAME}.bat`, CLI_BASENAME]
		: [CLI_BASENAME];
}

/**
 * **已知安装位置**（PATH 之外的兜底）。
 *
 * ⚠ 这里刻意不写死"某个版本的目录名"：ego lite 的安装布局由它自己决定，我们只覆盖
 * "它的 CLI 最可能出现在哪儿"（Windows 用户级安装 / 系统级安装 / 常见 npm 全局 bin）。
 * 命中不了也不致命 —— 用户可用 `config.cliPath` 或 `VSSAROS_EGO_CLI` 显式指定。
 */
export function candidateDirs({ platform = process.platform, env = process.env, home = homedir() } = {}) {
	const out = [];
	if (platform === 'win32') {
		const localAppData = (env.LOCALAPPDATA ?? '').trim();
		const programFiles = (env.PROGRAMFILES ?? '').trim();
		const programFilesX86 = (env['PROGRAMFILES(X86)'] ?? '').trim();
		for (const base of [localAppData, programFiles, programFilesX86]) {
			if (!base) { continue; }
			out.push(join(base, 'ego lite'));
			out.push(join(base, 'ego-lite'));
			out.push(join(base, 'Programs', 'ego lite'));
			out.push(join(base, 'Programs', 'ego-lite'));
		}
		out.push(join(home, '.local', 'bin'));
		out.push(join(home, 'AppData', 'Local', 'ego lite', 'bin'));
	} else {
		out.push(join(home, '.local', 'bin'));
		out.push('/usr/local/bin');
		out.push('/opt/homebrew/bin');
		out.push(join(home, 'bin'));
	}
	return out;
}

/** PATH 里的目录（去掉空项与引号；Windows 的分隔符是 `;`）。 */
export function pathDirs(pathValue, platform = process.platform) {
	const sep = platform === 'win32' ? ';' : ':';
	return String(pathValue ?? '')
		.split(sep)
		.map(p => p.trim().replace(/^"(.*)"$/, '$1'))
		.filter(Boolean);
}

/**
 * 解析 CLI 的绝对路径。
 *
 * 返回 `{ path, source, tried }`：`source` ∈ `config` / `env` / `path` / `known`；
 * 找不到时返回 `{ path: undefined, tried }`（`tried` 是给用户看的"我试过这些"）。
 *
 * ⚠ 这里**只做存在性判断**，不去执行 `--version`：解析要在工具调用里随时可用，
 * 而"执行一次"意味着起进程（可能拉起 app、可能卡住）⇒ 那属于 `ego_status` 的 `probe`。
 */
export function resolveEgoCli({
	explicit,
	platform = process.platform,
	env = process.env,
	home = homedir(),
	exists = existsSync,
} = {}) {
	const names = executableNames(platform);
	const tried = [];
	const pickIn = (dir, source) => {
		if (!dir) { return undefined; }
		for (const name of names) {
			const full = join(dir, name);
			tried.push(`${full}${source === 'path' ? '（PATH）' : ''}`);
			if (exists(full)) { return { path: full, source, tried }; }
		}
		return undefined;
	};

	const explicitPath = typeof explicit === 'string' ? explicit.trim() : '';
	if (explicitPath) {
		tried.push(`${explicitPath}（config.cliPath）`);
		if (exists(explicitPath)) { return { path: explicitPath, source: 'config', tried }; }
	}
	const envPath = typeof env.VSSAROS_EGO_CLI === 'string' ? env.VSSAROS_EGO_CLI.trim() : '';
	if (envPath) {
		tried.push(`${envPath}（VSSAROS_EGO_CLI）`);
		if (exists(envPath)) { return { path: envPath, source: 'env', tried }; }
	}
	for (const dir of pathDirs(env.PATH, platform)) {
		const hit = pickIn(dir, 'path');
		if (hit) { return hit; }
	}
	for (const dir of candidateDirs({ platform, env, home })) {
		const hit = pickIn(dir, 'known');
		if (hit) { return hit; }
	}
	return { path: undefined, tried };
}

/** 给 Windows 的一个参数加引号（路径里不会有 `"`，不需要转义）。 */
function quoteWin(value) {
	return `"${value}"`;
}

/**
 * 组装"这次要执行什么"。
 *
 * 纯函数（可单测）：给定 cli 路径与参数，返回 `{ command, args, options }`。
 * `.cmd` / `.bat` 在 Windows 上必须经 `cmd.exe`（见文件头 ③）。
 */
export function buildSpawnPlan({ cliPath, args = [], platform = process.platform, comspec = process.env.ComSpec || 'cmd.exe' }) {
	if (platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
		const line = [quoteWin(cliPath), ...args.map(a => (/[\s"]/.test(a) ? quoteWin(a) : a))].join(' ');
		return {
			command: comspec,
			args: ['/d', '/s', '/c', `"${line}"`],
			options: { windowsVerbatimArguments: true, shim: true },
		};
	}
	return { command: cliPath, args, options: { shim: false } };
}

/** 超时归一：缺省用兜底值，夹在 [MIN, MAX]（模型给的数不该把 Host 挂死两小时）。 */
export function clampTimeout(raw, fallback = DEFAULT_TIMEOUT_MS) {
	const value = Number.isFinite(raw) ? Math.floor(raw) : fallback;
	return Math.min(Math.max(value, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * 执行一次 `ego-browser <args>`，把 `stdin` 写进去后关闭（等价于 heredoc）。
 *
 * 返回 `{ code, signal, timedOut, stdout, stderr }` —— **不抛**（调用方按 code/输出决定怎么报）：
 * 失败文案要说准（是"没装"、"app 没运行"还是"脚本自己报错"），那需要原始 stderr。
 */
export function runEgoCli({
	cliPath,
	args = [],
	stdin = '',
	timeoutMs = DEFAULT_TIMEOUT_MS,
	cwd,
	env = process.env,
	platform = process.platform,
}) {
	const plan = buildSpawnPlan({ cliPath, args, platform });
	return new Promise(resolve => {
		let child;
		try {
			child = spawn(plan.command, plan.args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				// ★ Host 是 node.exe，没有可继承的控制台：漏了它每次调用都闪一个 conhost 窗口
				//   （2026-10-17 真机「点 agent 条目闪一叠 console 窗口」的同一根因）。
				windowsHide: true,
				...(cwd ? { cwd } : {}),
				env,
				...plan.options,
			});
		} catch (error) {
			resolve({ code: -1, signal: null, timedOut: false, stdout: '', stderr: String(error?.message ?? error) });
			return;
		}

		const stdout = [];
		const stderr = [];
		let timedOut = false;
		let settled = false;
		const finish = payload => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			resolve(payload);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			// 先杀进程树：Windows 上 cmd.exe 被杀不等于它拉起的 node/app 助手也结束。
			if (platform === 'win32' && child.pid) {
				try {
					const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
					killer.on?.('error', () => undefined);
					killer.unref?.();
				} catch { /* 杀不掉就退回 child.kill */ }
			}
			try { child.kill(); } catch { /* 已退出 */ }
		}, timeoutMs);
		timer.unref?.();

		child.stdout?.on?.('data', chunk => stdout.push(String(chunk)));
		child.stderr?.on?.('data', chunk => stderr.push(String(chunk)));
		child.on?.('error', error => finish({
			code: -1, signal: null, timedOut: false,
			stdout: stdout.join(''), stderr: `${stderr.join('')}${String(error?.message ?? error)}`,
		}));
		child.on?.('close', (code, signal) => finish({
			code: typeof code === 'number' ? code : -1,
			signal: signal ?? null,
			timedOut,
			stdout: stdout.join(''),
			stderr: stderr.join(''),
		}));

		try {
			child.stdin?.on?.('error', () => undefined);   // 子进程早退时的 EPIPE 不该炸掉工具
			child.stdin?.end?.(stdin);
		} catch { /* 同上 */ }
	});
}
