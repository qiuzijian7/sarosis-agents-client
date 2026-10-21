/*---------------------------------------------------------------------------------------------
 *  requestGuard.mjs — 网关的「谁能调我」判据（2026-10-20）
 *
 *  背景（代码评估 P0）：网关原来对**所有**响应写 `Access-Control-Allow-Origin: *`，OPTIONS 一律 204，
 *  除 `/mesh/*` 外**没有任何鉴权** ⇒ 本机任意网页都能跨域调用 `POST /provider/deleteMemory`、
 *  `/provider/removeAgent`、`PUT /kv/...`。浏览器里的网页是这里唯一现实的攻击面：
 *  能在本机跑进程的攻击者本来就能直接读写 `state_store.db`，鉴权挡不住它。
 *
 *  判据（纯函数，零 I/O —— 单测直接钉）：
 *   ① **没有 `Origin` 头 ⇒ 放行**。合法调用方几乎都是 Node：dsh 插件（`vssaros-memory` /
 *      `vssaros-agents`）、主进程探活、`curl`。Node 的 fetch/undici **不发** Origin。
 *      浏览器对**跨域的 CORS 请求与所有 POST/PUT/DELETE** 都会带 Origin ⇒ 网页发起的写请求一定带它。
 *      （不带 Origin 的浏览器请求只有 `<img>` / 导航这类 no-cors GET：网关的 GET 全是只读、响应对页面不透明。）
 *   ② **带 `Origin` ⇒ 必须在白名单**：IDE 渲染进程 `vscode-file://vscode-app`、webview `vscode-webview://…`，
 *      以及 `AGENTMEMORY_ALLOWED_ORIGINS`（逗号分隔，精确匹配；`*` = 恢复旧的全放行，只做排障逃生口）。
 *      ⚠ `null` 不在白名单：沙箱 iframe / `file://` 页面发的就是 `Origin: null`，放行它等于没设防。
 *   ③ **Host 头必须是回环地址**（防 DNS rebinding：恶意域名解析到 127.0.0.1 后，请求同源、
 *      不带跨域 Origin，但 Host 是那个域名）。只在网关绑定回环地址时检查；
 *      `AGENTMEMORY_HOST=0.0.0.0`（mesh 跨机）时对端用局域网 IP 访问 ⇒ 不查 Host（`/mesh/*` 另有 Bearer）。
 *--------------------------------------------------------------------------------------------*/

/** 内置允许的 Origin：IDE 渲染进程（精确值）与 webview（按 scheme 前缀，webview 的 host 是随机 id）。 */
export const BUILTIN_EXACT_ORIGINS = Object.freeze(['vscode-file://vscode-app']);
export const BUILTIN_ORIGIN_SCHEMES = Object.freeze(['vscode-webview://']);

/** 回环 Host 名（不含端口）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * 解析 `AGENTMEMORY_ALLOWED_ORIGINS`。
 * @param {string | undefined} raw
 * @returns {{ any: boolean, exact: Set<string> }}
 */
export function parseAllowedOrigins(raw) {
	const items = String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
	return { any: items.includes('*'), exact: new Set(items.filter(s => s !== '*')) };
}

/**
 * 某个 Origin 是否被允许。
 * @param {string} origin
 * @param {{ any: boolean, exact: Set<string> }} extra
 * @returns {boolean}
 */
export function isAllowedOrigin(origin, extra) {
	if (extra?.any) { return true; }
	if (extra?.exact?.has(origin)) { return true; }
	if (BUILTIN_EXACT_ORIGINS.includes(origin)) { return true; }
	return BUILTIN_ORIGIN_SCHEMES.some(scheme => origin.startsWith(scheme) && origin.length > scheme.length);
}

/**
 * Host 头是否指向回环地址（端口不限：同机别的端口转发进来也还是本机）。
 * @param {string | undefined} hostHeader
 * @returns {boolean}
 */
export function isLoopbackHost(hostHeader) {
	if (typeof hostHeader !== 'string' || !hostHeader) { return false; }
	const h = hostHeader.trim().toLowerCase();
	const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
	return LOOPBACK_HOSTS.has(name);
}

/** 绑定地址是不是回环（决定要不要查 Host）。 */
export function isLoopbackBind(bindHost) {
	const b = String(bindHost ?? '').trim().toLowerCase();
	return b === '' || b === '127.0.0.1' || b === 'localhost' || b === '::1' || b === '[::1]';
}

/**
 * 判一次请求。
 * @param {{ origin?: string, host?: string }} headers - 只看这两个头。
 * @param {{ bindHost?: string, allowed: { any: boolean, exact: Set<string> } }} policy
 * @returns {{ ok: true, allowOrigin?: string } | { ok: false, status: number, reason: string }}
 *   `allowOrigin`：要回写到 `Access-Control-Allow-Origin` 的值（回显本次 Origin；无 Origin 时不写）。
 */
export function checkRequest(headers, policy) {
	const origin = typeof headers?.origin === 'string' ? headers.origin.trim() : '';
	if (isLoopbackBind(policy?.bindHost) && !isLoopbackHost(headers?.host)) {
		return { ok: false, status: 421, reason: `host not allowed: ${String(headers?.host ?? '(missing)').slice(0, 80)}` };
	}
	if (!origin) { return { ok: true }; }
	if (!isAllowedOrigin(origin, policy?.allowed ?? { any: false, exact: new Set() })) {
		return { ok: false, status: 403, reason: `origin not allowed: ${origin.slice(0, 80)}` };
	}
	return { ok: true, allowOrigin: origin };
}
