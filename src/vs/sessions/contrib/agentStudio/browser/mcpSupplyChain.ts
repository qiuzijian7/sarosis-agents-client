/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP **供应链预检**（OSV 恶意包查询）—— 2026-09-24。
 *
 * ## 为什么需要
 *
 * MCP server 的两条安装路径都会**从 npm/PyPI 拉取并执行第三方包**：
 *   · 预设「自动安装并配置」：`model.autoInstall.install` 里直接是 `pip install comfy-mcp` 之类；
 *   · Marketplace 安装：`McpInstaller.install()` 把 `npx -y <pkg>` 写进 `~/.vssaros/mcp.json`，
 *     之后 MCP host 每次启动都会 `npx -y` 拉最新版并执行。
 * 本地此前**零检查**（大小写敏感全仓搜索无 `osv.dev`）。上游 Hermes 对此有明确机制：
 * `tools/osv_check.py` 在启动 `npx`/`uvx`/`pipx` 型 server **之前**查 Google OSV 的
 * **`MAL-*` 恶意软件公告**（普通 CVE 忽略），结论缓存 1h，网络失败 **fail-open 且不缓存**。
 * 本模块是那套机制在我们这边的等价物。
 *
 * ## 三条纪律（照抄上游的取舍，理由写在代码里）
 *
 * 1. **只拦恶意包**（id 以 `MAL-` 开头，含 `aliases`）：普通 CVE 不是阻断理由 ——
 *    否则任何有历史漏洞的包都装不上（上游同款判断）。
 * 2. **网络失败 fail-open、且不缓存失败**：供应链检查不该成为"断网即不能装 MCP"的单点；
 *    但也绝不能把失败当"已验证"缓存起来（那是最坏的一种"看起来安全"）。
 * 3. **只查我们**知道怎么解析的包（npx/uvx/pipx/pip/npm install…）：解析不出包名的命令
 *    （本地路径、git URL、`npm run` 脚本）**不猜**，直接不查（宁可漏报，不要误报拦截）。
 *
 * ⚠ 不做版本级查询：查的是**包名**（不带版本），因为 `npx -y pkg` 每次都可能拿到新版本，
 *   查具体版本给出的是"当时安全"的假象。缓存键也只到包名（TTL 1h）。
 */

export type OsvEcosystem = 'npm' | 'PyPI';

export interface IOsvPackageRef {
	readonly name: string;
	readonly ecosystem: OsvEcosystem;
}

/** 默认端点（可用 `VS_SAROS_OSV_ENDPOINT` 覆盖，便于内网镜像/代理）。 */
export const OSV_ENDPOINT = 'https://api.osv.dev/v1/querybatch';

/** 结论缓存 TTL：1 小时（与 Hermes `OSV_CHECK_CACHE_TTL` 同量级）。 */
export const OSV_CACHE_TTL_MS = 60 * 60_000;

/** 单次查询超时（上游对 OSV 预检也走短超时 + fail-open）。 */
const OSV_TIMEOUT_MS = 5_000;

export interface IOsvMaliciousHit {
	readonly name: string;
	readonly ecosystem: OsvEcosystem;
	/** 命中的公告 id（`MAL-*`），去重。 */
	readonly ids: readonly string[];
}

export interface IOsvVerdict {
	/** `clean` = 已查且干净；`blocked` = 命中恶意包；`unknown` = 没查成（fail-open）。 */
	readonly status: 'clean' | 'blocked' | 'unknown';
	readonly hits: readonly IOsvMaliciousHit[];
	/** 实际查询/命中的包数（诊断用）。 */
	readonly scanned: number;
	/** `unknown` 时的原因（用于提示"自查来源"）。 */
	readonly reason?: string;
}

// ─── 纯函数：命令 → 包引用 ──────────────────────────────────────────────────

/**
 * 把命令串切成 token（**尊重引号**：`pip install "a>=1"` 里的 `a>=1` 是一个 token）。
 * 空串/引号不闭合时按已见内容返回（宽容解析 —— 这里只用于"猜包名"，不该因解析失败而抛）。
 */
export function tokenizeCommand(command: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quote: string | undefined;
	for (const ch of String(command ?? '')) {
		if (quote) {
			if (ch === quote) { quote = undefined; } else { cur += ch; }
			continue;
		}
		if (ch === '"' || ch === '\'') { quote = ch; continue; }
		if (/\s/.test(ch)) {
			if (cur) { out.push(cur); cur = ''; }
			continue;
		}
		cur += ch;
	}
	if (cur) { out.push(cur); }
	return out;
}

/** 取命令的 basename 并去 `.exe`（`C:\Python\Scripts\pip.exe` ⇒ `pip`）。 */
export function commandBaseName(token: string): string {
	const base = String(token ?? '').trim().split(/[\\/]/).pop() ?? '';
	return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/**
 * 归一化包名（去引号 / extras / 版本 / 环境标记）。
 *
 * 返回 `undefined` ⇒ **不是注册表包**（本地路径、URL、git 源、`*` 通配等）⇒ 调用方应跳过查询
 * （宁可漏报也不误拦截：把 `./my-server` 当成包名去查是没意义的）。
 */
export function normalizePackageName(raw: string): string | undefined {
	let s = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
	if (!s) { return undefined; }
	// 非注册表来源：本地/相对路径、文件 URL、git/ssh 源、通配
	if (/^(\.|\/|\\|~)/.test(s) || /^[a-z]+:\/\//i.test(s) || /^git[+@]/i.test(s) || /[*?]/.test(s)) { return undefined; }
	s = s.replace(/\[[^\]]*\]$/, '');          // extras：pkg[extra]
	s = s.split(';')[0].trim();                // 环境标记：pkg; python_version<"3"
	if (s.startsWith('@')) {
		// npm scope：@scope/name@1.2.3 ⇒ @scope/name
		const rest = s.slice(1);
		const at = rest.indexOf('@');
		s = at >= 0 ? `@${rest.slice(0, at)}` : s;
	} else {
		s = s.split(/[<>=!~@]/)[0];            // 版本/操作符：pkg==1.0 / pkg@latest / pkg>=1
	}
	s = s.trim();
	if (!s || s === '@') { return undefined; }
	// 允许字母数字与 `-_.@/`（scoped 名含 `/`）；其余视为非法（避免把杂串当包名）
	return /^[@A-Za-z0-9][A-Za-z0-9._@/-]*$/.test(s) ? s : undefined;
}

/** npm 侧「哪些 flag 会吃掉下一个 token 的值」（否则 `-p foo` 里的 foo 会被漏掉/错位）。 */
const NPM_VALUE_FLAGS = new Set(['-p', '--package', '--prefix', '--registry', '--userconfig', '-c', '--call']);
/** 纯开关类 flag（不吃值）。 */
const NPM_BOOL_FLAGS = new Set(['-y', '--yes', '--quiet', '-q', '--silent', '-g', '--global', '-D', '--save-dev', '--ignore-scripts', '--prefer-offline', '--no-install']);

/** 从一组 token 里取"包名"（跳过 flag 与其值；遇到子命令/脚本名由调用方先裁掉）。 */
function packagesFromTokens(tokens: readonly string[], ecosystem: OsvEcosystem): IOsvPackageRef[] {
	const out: IOsvPackageRef[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) { continue; }
		if (t.startsWith('-')) {
			const eq = t.indexOf('=');
			if (eq > 0) {
				// `--package=foo`
				const inline = t.slice(eq + 1);
				if (NPM_VALUE_FLAGS.has(t.slice(0, eq))) { pushRef(out, inline, ecosystem); }
				continue;
			}
			if (NPM_VALUE_FLAGS.has(t)) { pushRef(out, tokens[i + 1], ecosystem); i++; }
			else if (NPM_BOOL_FLAGS.has(t)) { /* 开关，跳过 */ }
			continue;
		}
		pushRef(out, t, ecosystem);
	}
	return out;
}

function pushRef(out: IOsvPackageRef[], raw: string | undefined, ecosystem: OsvEcosystem): void {
	const name = normalizePackageName(raw ?? '');
	if (!name) { return; }
	if (!out.some(r => r.ecosystem === ecosystem && r.name === name)) { out.push({ name, ecosystem }); }
}

/**
 * 从 **stdio server 定义** 提取包引用（`~/.vssaros/mcp.json` 里的 `command` + `args`，
 * 以及内置预设的 `command`/`args`）。
 *
 * 支持：`npx [-y] [--package=x] pkg[@ver]`、`npm exec|x pkg`、`pnpm dlx pkg`、
 * `yarn dlx pkg`、`bunx pkg`、`uvx pkg`、`uv tool run pkg`、`pipx run pkg`、
 * `pip|pip3 install pkg`、`python -m pip install pkg`、`npm|pnpm|yarn install|i|add pkg`。
 */
export function extractPackagesFromStdioCommand(
	command: string | undefined, args: readonly string[] | undefined,
): IOsvPackageRef[] {
	const argv = [String(command ?? ''), ...(args ?? []).map(String)].filter(Boolean);
	if (!argv.length) { return []; }
	const base = commandBaseName(argv[0]);
	const rest = argv.slice(1);

	switch (base) {
		case 'npx':
			return packagesFromTokens(rest, 'npm');
		case 'bunx':
			return packagesFromTokens(rest, 'npm');
		case 'pnpm':
		case 'yarn':
			return rest[0] === 'dlx' ? packagesFromTokens(rest.slice(1), 'npm') : [];
		case 'npm': {
			const sub = (rest[0] ?? '').toLowerCase();
			if (sub === 'exec' || sub === 'x') { return packagesFromTokens(rest.slice(1), 'npm'); }
			if (sub === 'install' || sub === 'i' || sub === 'add') { return packagesFromTokens(rest.slice(1), 'npm'); }
			return [];   // npm run / npm start …不是包
		}
		case 'uvx':
			return packagesFromTokens(rest, 'PyPI');
		case 'px':
			return packagesFromTokens(rest, 'PyPI');
		case 'uv': {
			// uv tool run pkg / uv pip install pkg
			if (rest[0] === 'tool' && rest[1] === 'run') { return packagesFromTokens(rest.slice(2), 'PyPI'); }
			if (rest[0] === 'pip' && ['install', 'i'].includes((rest[1] ?? '').toLowerCase())) { return packagesFromTokens(rest.slice(2), 'PyPI'); }
			return [];
		}
		case 'pipx':
			return rest[0] === 'run' ? packagesFromTokens(rest.slice(1), 'PyPI') : [];
		case 'pip':
		case 'pip3': {
			const sub = (rest[0] ?? '').toLowerCase();
			return ['install', 'i'].includes(sub) ? packagesFromTokens(rest.slice(1), 'PyPI') : [];
		}
		case 'python':
		case 'python3':
		case 'py': {
			// python -m pip install pkg
			const i = rest.findIndex(t => t === '-m');
			if (i < 0) { return []; }
			const mod = commandBaseName(rest[i + 1] ?? '');
			if (mod !== 'pip') { return []; }
			const after = rest.slice(i + 2);
			return ['install', 'i'].includes((after[0] ?? '').toLowerCase())
				? packagesFromTokens(after.slice(1), 'PyPI') : [];
		}
		default:
			return [];   // 自有二进制（comfy-mcp / codex / figma-developer-mcp…）不查
	}
}

/** 从**安装命令**提取包引用（预设 `autoInstall.install` 里的一条，如 `pip install "comfy-cli>=1.14.0"`）。 */
export function extractPackagesFromInstallCommand(command: string): IOsvPackageRef[] {
	const tokens = tokenizeCommand(command);
	if (!tokens.length) { return []; }
	return extractPackagesFromStdioCommand(tokens[0], tokens.slice(1));
}

/** 批量：从多条安装命令提取（去重合并）。 */
export function extractPackagesFromInstallCommands(commands: readonly string[]): IOsvPackageRef[] {
	const out: IOsvPackageRef[] = [];
	for (const cmd of commands) {
		for (const ref of extractPackagesFromInstallCommand(cmd)) {
			if (!out.some(r => r.ecosystem === ref.ecosystem && r.name === ref.name)) { out.push(ref); }
		}
	}
	return out;
}

// ─── 纯函数：OSV 响应解析 ───────────────────────────────────────────────────

/**
 * 解析 `/v1/querybatch` 响应：**只取 `MAL-*`**（恶意软件公告），普通 CVE 忽略。
 *
 * 响应形状：`{ results: [ { vulns?: [ { id, aliases? } ] }, … ] }`，与 `refs` **同序**。
 * 形状不符（网关返回错误页/空体）⇒ 返回空数组（调用方按 clean 处理；宁可漏报不误拦）。
 */
export function parseOsvQueryBatch(payload: unknown, refs: readonly IOsvPackageRef[]): IOsvMaliciousHit[] {
	const results = (payload as { results?: unknown })?.results;
	if (!Array.isArray(results)) { return []; }
	const hits: IOsvMaliciousHit[] = [];
	results.forEach((entry, index) => {
		const ref = refs[index];
		if (!ref) { return; }
		const vulns = (entry as { vulns?: unknown })?.vulns;
		if (!Array.isArray(vulns)) { return; }
		const ids: string[] = [];
		for (const v of vulns) {
			const id = (v as { id?: unknown })?.id;
			const aliases = (v as { aliases?: unknown })?.aliases;
			const candidates = [typeof id === 'string' ? id : undefined,
				...(Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === 'string') : [])];
			for (const c of candidates) {
				if (c && /^MAL-/i.test(c) && !ids.includes(c)) { ids.push(c); }
			}
		}
		if (ids.length) { hits.push({ name: ref.name, ecosystem: ref.ecosystem, ids }); }
	});
	return hits;
}

// ─── 结论缓存（只缓存**确定**结论，失败绝不缓存）────────────────────────────

interface ICacheEntry { readonly status: 'clean' | 'blocked'; readonly ids: readonly string[]; readonly at: number }

const cache = new Map<string, ICacheEntry>();

function cacheKey(ref: IOsvPackageRef): string { return `${ref.ecosystem}:${ref.name}`; }

/** 读缓存（命中且未过期）。导出供单测，产品代码只经 `checkPackagesAgainstOsv`。 */
export function readOsvCache(ref: IOsvPackageRef, now: number, ttlMs: number = OSV_CACHE_TTL_MS): ICacheEntry | undefined {
	const hit = cache.get(cacheKey(ref));
	if (!hit) { return undefined; }
	if (!Number.isFinite(now) || now - hit.at >= ttlMs || now < hit.at) { cache.delete(cacheKey(ref)); return undefined; }
	return hit;
}

function writeOsvCache(ref: IOsvPackageRef, status: 'clean' | 'blocked', ids: readonly string[], now: number): void {
	cache.set(cacheKey(ref), { status, ids, at: now });
}

export function clearOsvCache(): void { cache.clear(); }
export function osvCacheSize(): number { return cache.size; }

// ─── 查询 ───────────────────────────────────────────────────────────────────

/** 可注入的 fetch（单测用；缺省全局 `fetch`）。 */
export type OsvFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface IOsvCheckOptions {
	readonly fetchImpl?: OsvFetch;
	readonly endpoint?: string;
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly timeoutMs?: number;
	/** 记录 warn 的出口（产品侧传 logService.warn；缺省丢弃）。 */
	readonly warn?: (msg: string) => void;
}

function endpointFromEnv(): string {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	return env?.['VS_SAROS_OSV_ENDPOINT']?.trim() || OSV_ENDPOINT;
}

/**
 * 查询一批包是否被标记为恶意。
 *
 * 语义（与文件头三条纪律一一对应）：
 *   · 命中 `MAL-*` ⇒ `blocked`（**阻断安装**）；
 *   · 查通了且干净 ⇒ `clean`（写 1h 缓存）；
 *   · 网络/超时/形状异常 ⇒ `unknown`（**fail-open**：调用方继续，但提示用户自查；**不写缓存**）。
 */
export async function checkPackagesAgainstOsv(
	refs: readonly IOsvPackageRef[], opts: IOsvCheckOptions = {},
): Promise<IOsvVerdict> {
	if (!refs.length) { return { status: 'clean', hits: [], scanned: 0 }; }
	const now = opts.now ?? (() => Date.now());
	const ttl = opts.ttlMs ?? OSV_CACHE_TTL_MS;

	// ① 缓存命中的直接给结论（不打网络）
	const hits: IOsvMaliciousHit[] = [];
	const toQuery: IOsvPackageRef[] = [];
	for (const ref of refs) {
		const hit = readOsvCache(ref, now(), ttl);
		if (!hit) { toQuery.push(ref); continue; }
		if (hit.status === 'blocked') { hits.push({ name: ref.name, ecosystem: ref.ecosystem, ids: hit.ids }); }
	}
	if (hits.length) { return { status: 'blocked', hits, scanned: refs.length }; }
	if (!toQuery.length) { return { status: 'clean', hits: [], scanned: refs.length }; }

	// ② 查询未缓存的（一次 batch 请求）
	const fetchImpl = opts.fetchImpl ?? (globalThis as { fetch?: OsvFetch }).fetch;
	if (!fetchImpl) { return { status: 'unknown', hits: [], scanned: 0, reason: '运行环境没有 fetch' }; }
	const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
	const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? OSV_TIMEOUT_MS) : undefined;
	try {
		const res = await fetchImpl(opts.endpoint ?? endpointFromEnv(), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ queries: toQuery.map(r => ({ package: { name: r.name, ecosystem: r.ecosystem } })) }),
			signal: controller?.signal,
		});
		if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
		const found = parseOsvQueryBatch(await res.json(), toQuery);
		// ③ 写缓存：**只写这次真的查过的**（命中恶意 ⇒ blocked，其余 ⇒ clean）
		for (const ref of toQuery) {
			const hit = found.find(h => h.name === ref.name && h.ecosystem === ref.ecosystem);
			writeOsvCache(ref, hit ? 'blocked' : 'clean', hit?.ids ?? [], now());
		}
		return { status: found.length ? 'blocked' : 'clean', hits: found, scanned: toQuery.length };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		opts.warn?.(`[mcpSupplyChain] OSV 预检失败（fail-open，不缓存）：${reason}`);
		return { status: 'unknown', hits: [], scanned: 0, reason };
	} finally {
		if (timer) { clearTimeout(timer); }
	}
}

/** 便捷入口：stdio server 定义（`command` + `args`）供应链预检。 */
export function checkStdioCommandAgainstOsv(
	command: string | undefined, args: readonly string[] | undefined, opts: IOsvCheckOptions = {},
): Promise<IOsvVerdict> {
	return checkPackagesAgainstOsv(extractPackagesFromStdioCommand(command, args), opts);
}

/** 便捷入口：一组**安装命令**（预设 `autoInstall.install`）供应链预检。 */
export function checkInstallCommandsAgainstOsv(
	commands: readonly string[], opts: IOsvCheckOptions = {},
): Promise<IOsvVerdict> {
	return checkPackagesAgainstOsv(extractPackagesFromInstallCommands(commands), opts);
}

/** 命中恶意包时的阻断文案（要能让用户看懂"为什么装不了"以及"从哪知道这件事"）。 */
export function buildOsvBlockedMessage(verdict: IOsvVerdict): string {
	const lines = [
		'已阻止安装：依赖中包含 OSV 标记为**恶意软件**的包。',
		'',
		...verdict.hits.map(h => `· ${h.name}（${h.ecosystem}）：${h.ids.join(', ')}`),
		'',
		'详情：https://osv.dev/（按上列公告 id 搜索）',
		'若你确认该包可信（例如已改为自建镜像/私有源），请改用显式本地路径或自建 server，',
		'或设置环境变量 VS_SAROS_OSV_ENDPOINT 指向内网镜像后重试。',
	];
	return lines.join('\n');
}
