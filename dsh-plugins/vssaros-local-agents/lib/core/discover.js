// 本机 CLI 探测与环境净化（P0）。
//
// 两条纪律：
// ① 不做全盘 PATH 枚举 / 不调 which —— 只对固定命令名做 existsSync 文件检查，
//    GUI 启动时 PATH 稀疏，额外补几个常见安装目录即可。
// ② CLI 用**自己的登录与套餐**：子进程环境必须剔除本产品与常见 provider 的
//    key，否则我们的 key 会覆盖 CLI 登录或顺着 CLI 泄漏出去。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 前缀匹配的敏感变量：宁可多剔，不可漏。 */
export const SENSITIVE_PREFIXES = [
	'DSH_', 'DS_BOT_', 'VSSAROS_', 'ELECTRON_RUN_AS_NODE',
];
export const SENSITIVE_NAMES = [
	'OPENAI_API_KEY', 'OPENAI_BASE_URL',
	'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY',
	'ACP_BACKEND',
];

export function isSensitiveEnvName(name) {
	const upper = String(name).toUpperCase();
	return SENSITIVE_NAMES.includes(upper) || SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** 返回给 child_process 的干净环境（不修改 process.env）。 */
export function cleanEnv(env = process.env) {
	const out = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || isSensitiveEnvName(key)) continue;
		out[key] = value;
	}
	return out;
}

/** Windows 上 npm 全局包是 .cmd 垫片，必须连扩展名一起试。 */
export function executableNames(command, platform = process.platform) {
	if (platform !== 'win32') return [command];
	if (/\.(?:exe|cmd|bat)$/i.test(command)) return [command];
	return [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
}

/** PATH + Windows npm 全局 + 常见用户级 bin 目录，去重并保持顺序。 */
export function searchDirs(env = process.env, platform = process.platform) {
	const dirs = [];
	const push = (dir) => { if (typeof dir === 'string' && dir.trim() && !dirs.includes(dir)) dirs.push(dir); };
	for (const dir of String(env.PATH ?? '').split(delimiter)) push(dir);
	if (platform === 'win32') {
		if (env.APPDATA) push(join(env.APPDATA, 'npm'));
		push(join(homedir(), 'AppData', 'Roaming', 'npm'));
		push(join(homedir(), '.local', 'bin'));
	} else {
		for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) push(dir);
		push(join(homedir(), '.local', 'bin'));
		push(join(homedir(), 'bin'));
	}
	return dirs;
}

/**
 * 找可执行文件。绝对路径直接用；纯程序名按 searchDirs 顺序找。
 * @returns 绝对路径或 undefined
 */
export function findExecutable(command, dirs = searchDirs(), platform = process.platform) {
	if (typeof command !== 'string' || !command.trim()) return undefined;
	const trimmed = command.trim();
	if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('~')) {
		const expanded = trimmed.startsWith('~') ? join(homedir(), trimmed.slice(2)) : trimmed;
		for (const name of executableNames(expanded, platform)) {
			if (existsSync(name)) return name;
		}
		return undefined;
	}
	for (const dir of dirs) {
		for (const name of executableNames(trimmed, platform)) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/** 版本只用于设置页显示：10s 超时、取 stdout+stderr 首个非空行、失败返回 undefined。 */
export function probeVersion(binary, args = ['--version'], run = spawnSync) {
	try {
		const result = run(binary, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
		const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
		return text.split('\n').map((line) => line.trim()).find(Boolean);
	} catch {
		return undefined;
	}
}
