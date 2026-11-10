// @vssaros/dsh-mcp — MCP 供应链预检（OSV 恶意包查询），**dsh 侧真源**。
//
// 背景：`src/vs/.../agentStudio/browser/mcpSupplyChain.ts` 是 IDE 侧残留（按 2026-11-09 口径
// 不是产品能力、不往那边加）。但「装第三方 MCP 包前查恶意包」是有价值的安全闸，所以在这里
// 按同一套契约重新实现（JS，纯逻辑 + 可注入 fetch），接进 dsh 侧的两个安装写口：
//   `mcp_install` / `mcp_import(apply)`。
//
// 三条纪律（与参考实现一致）：
//   1. **只拦恶意包**：OSV 公告 id 以 `MAL-*` 开头（含 aliases），普通 CVE 忽略；
//   2. **网络失败 fail-open 且不缓存失败**：断网不该让 MCP 装不上，但绝不能把失败当"已验证"缓存；
//   3. **只查解析得出包名的命令**：本地路径 / git URL / 自有二进制一律跳过（宁可漏报不误拦）。
// 不做版本级查询（`npx -y pkg` 每次都可能拿新版本），缓存键只到包名，TTL 1h。
//
// 开关：`VSSAROS_MCP_OSV=0` 关闭（内网/离线环境）；缺省启用。

export const OSV_ENDPOINT = 'https://api.osv.dev/v1/querybatch';
export const OSV_TIMEOUT_MS = 5_000;
export const OSV_CACHE_TTL_MS = 60 * 60_000;

export const isOsvEnabled = (env = process.env) => env?.VSSAROS_MCP_OSV !== '0';

/** 命令切 token（尊重引号，宽容解析：解析失败不该抛）。 */
export function tokenizeCommand(command) {
	const out = [];
	let cur = '';
	let quote;
	for (const ch of String(command ?? '')) {
		if (quote) { if (ch === quote) { quote = undefined; } else { cur += ch; } continue; }
		if (ch === '"' || ch === '\'') { quote = ch; continue; }
		if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
		cur += ch;
	}
	if (cur) { out.push(cur); }
	return out;
}

export function commandBaseName(token) {
	return (String(token ?? '').trim().split(/[\\/]/).pop() ?? '')
		.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** 归一化包名；返回 undefined = 不是注册表包（本地路径/URL/git/通配）⇒ 跳过查询。 */
export function normalizePackageName(raw) {
	let s = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
	if (!s) { return undefined; }
	if (/^(\.|\/|\\|~)/.test(s) || /^[a-z]+:\/\//i.test(s) || /^git[+@]/i.test(s) || /[*?]/.test(s)) { return undefined; }
	s = s.replace(/\[[^\]]*\]$/, '').split(';')[0].trim();
	if (s.startsWith('@')) {
		const rest = s.slice(1);
		const at = rest.indexOf('@');
		s = at >= 0 ? `@${rest.slice(0, at)}` : s;
	} else {
		s = s.split(/[<>=!~@]/)[0];
	}
	s = s.trim();
	if (!s || s === '@') { return undefined; }
	return /^[@A-Za-z0-9][A-Za-z0-9._@/-]*$/.test(s) ? s : undefined;
}

const VALUE_FLAGS = new Set(['-p', '--package', '--prefix', '--registry', '--userconfig', '-c', '--call']);
const BOOL_FLAGS = new Set(['-y', '--yes', '--quiet', '-q', '--silent', '-g', '--global', '-D', '--save-dev', '--ignore-scripts', '--prefer-offline', '--no-install']);

function refsFromTokens(tokens, ecosystem) {
	const out = [];
	const push = raw => {
		const name = normalizePackageName(raw ?? '');
		if (name && !out.some(r => r.ecosystem === ecosystem && r.name === name)) { out.push({ name, ecosystem }); }
	};
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t) { continue; }
		if (t.startsWith('-')) {
			const eq = t.indexOf('=');
			if (eq > 0) {
				if (VALUE_FLAGS.has(t.slice(0, eq))) { push(t.slice(eq + 1)); }
				continue;
			}
			if (VALUE_FLAGS.has(t)) { push(tokens[i + 1]); i++; }
			continue;  // BOOL_FLAGS 与其它未知 flag 都跳过
		}
		push(t);
	}
	return out;
}

/** 从 stdio server 的 command+args 提取包引用（只认已知包管理器，其余返回空）。 */
export function extractPackages(command, args) {
	const argv = [String(command ?? ''), ...(Array.isArray(args) ? args.map(String) : [])].filter(Boolean);
	if (!argv.length) { return []; }
	const base = commandBaseName(argv[0]);
	const rest = argv.slice(1);
	switch (base) {
		case 'npx': case 'bunx': return refsFromTokens(rest, 'npm');
		case 'pnpm': case 'yarn': return rest[0] === 'dlx' ? refsFromTokens(rest.slice(1), 'npm') : [];
		case 'npm': {
			const sub = (rest[0] ?? '').toLowerCase();
			return ['exec', 'x', 'install', 'i', 'add'].includes(sub) ? refsFromTokens(rest.slice(1), 'npm') : [];
		}
		case 'uvx': case 'px': return refsFromTokens(rest, 'PyPI');
		case 'uv': {
			if (rest[0] === 'tool' && rest[1] === 'run') { return refsFromTokens(rest.slice(2), 'PyPI'); }
			if (rest[0] === 'pip' && ['install', 'i'].includes((rest[1] ?? '').toLowerCase())) { return refsFromTokens(rest.slice(2), 'PyPI'); }
			return [];
		}
		case 'pipx': return rest[0] === 'run' ? refsFromTokens(rest.slice(1), 'PyPI') : [];
		case 'pip': case 'pip3':
			return ['install', 'i'].includes((rest[0] ?? '').toLowerCase()) ? refsFromTokens(rest.slice(1), 'PyPI') : [];
		default: return [];  // 自有二进制不查
	}
}

/** 解析 /v1/querybatch 响应，只保留 MAL-*（与 refs 同序）。形状异常 ⇒ 空数组（按 clean 处理）。 */
export function parseOsvQueryBatch(payload, refs) {
	const results = payload?.results;
	if (!Array.isArray(results)) { return []; }
	const hits = [];
	results.forEach((entry, index) => {
		const ref = refs[index];
		if (!ref || !Array.isArray(entry?.vulns)) { return; }
		const ids = [];
		for (const v of entry.vulns) {
			const candidates = [typeof v?.id === 'string' ? v.id : undefined,
				...(Array.isArray(v?.aliases) ? v.aliases.filter(a => typeof a === 'string') : [])];
			for (const c of candidates) { if (c && /^MAL-/i.test(c) && !ids.includes(c)) { ids.push(c); } }
		}
		if (ids.length) { hits.push({ name: ref.name, ecosystem: ref.ecosystem, ids }); }
	});
	return hits;
}

const cache = new Map();
const cacheKey = ref => `${ref.ecosystem}:${ref.name}`;

export function readOsvCache(ref, now, ttlMs = OSV_CACHE_TTL_MS) {
	const hit = cache.get(cacheKey(ref));
	if (!hit) { return undefined; }
	if (!Number.isFinite(now) || now - hit.at >= ttlMs || now < hit.at) { cache.delete(cacheKey(ref)); return undefined; }
	return hit;
}

export function clearOsvCache() { cache.clear(); }

/**
 * `status`: clean（已查干净）/ blocked（命中恶意包，调用方必须阻断）/ unknown（fail-open）。
 * `fetchImpl` 可注入（守卫用假 fetch，不打网络）。
 */
export async function checkPackagesAgainstOsv(refs, opts = {}) {
	if (!refs.length) { return { status: 'clean', hits: [], scanned: 0 }; }
	const now = opts.now ?? (() => Date.now());
	const ttl = opts.ttlMs ?? OSV_CACHE_TTL_MS;
	const hits = [];
	const toQuery = [];
	for (const ref of refs) {
		const hit = readOsvCache(ref, now(), ttl);
		if (!hit) { toQuery.push(ref); continue; }
		if (hit.status === 'blocked') { hits.push({ name: ref.name, ecosystem: ref.ecosystem, ids: hit.ids }); }
	}
	if (hits.length) { return { status: 'blocked', hits, scanned: refs.length }; }
	if (!toQuery.length) { return { status: 'clean', hits: [], scanned: refs.length }; }
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
	if (!fetchImpl) { return { status: 'unknown', hits: [], scanned: 0, reason: '运行环境没有 fetch' }; }
	const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
	const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? OSV_TIMEOUT_MS) : undefined;
	try {
		const res = await fetchImpl(opts.endpoint ?? (opts.envEndpoint?.trim() || OSV_ENDPOINT), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ queries: toQuery.map(r => ({ package: { name: r.name, ecosystem: r.ecosystem } })) }),
			signal: controller?.signal,
		});
		if (!res?.ok) { throw new Error(`HTTP ${res?.status ?? '?'}`); }
		const found = parseOsvQueryBatch(await res.json(), toQuery);
		for (const ref of toQuery) {
			const hit = found.find(h => h.name === ref.name && h.ecosystem === ref.ecosystem);
			cache.set(cacheKey(ref), { status: hit ? 'blocked' : 'clean', ids: hit?.ids ?? [], at: now() });
		}
		return { status: found.length ? 'blocked' : 'clean', hits: found, scanned: toQuery.length };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		opts.warn?.(`[mcp-osv] 预检失败（fail-open，不缓存）：${reason}`);
		return { status: 'unknown', hits: [], scanned: 0, reason };
	} finally {
		if (timer) { clearTimeout(timer); }
	}
}

/** 便捷入口：一组 stdio server 条目（{command,args}）。 */
export async function checkStdioEntriesAgainstOsv(entries, opts = {}) {
	const refs = [];
	for (const entry of entries ?? []) {
		if (entry?.type && entry.type !== 'stdio') { continue; }
		for (const ref of extractPackages(entry?.command, entry?.args)) {
			if (!refs.some(r => r.ecosystem === ref.ecosystem && r.name === ref.name)) { refs.push(ref); }
		}
	}
	return checkPackagesAgainstOsv(refs, opts);
}

export function buildOsvBlockedMessage(verdict) {
	return [
		'已阻止安装：依赖中包含 OSV 标记为**恶意软件**的包。',
		'',
		...verdict.hits.map(h => `· ${h.name}（${h.ecosystem}）：${h.ids.join(', ')}`),
		'',
		'详情：https://osv.dev/（按上列公告 id 搜索）',
		'若确认该包可信，可设置 VSSAROS_MCP_OSV=0 关闭预检后重试（自行承担风险）。',
	].join('\n');
}
