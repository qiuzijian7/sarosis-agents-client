/**
 * Cookie 通道的**纯逻辑**（零依赖、无 fs）：站点解析与围栏 / 域名匹配 / 净化 / 分类 / 存档形状。
 *
 * ## 为什么需要它（2026-10-13，用户拍板"做 cookie 通道"）
 *
 * 登录态有三级解法，优先级**不可颠倒**（调研 8 个开源项目后的结论，见
 * `doc/web-login-crawl-plan.md`）：
 *   ① 直接复用用户真实浏览器（browser-harness / OpenCLI / openclaw 的 extension relay 都走这条）；
 *   ② 把 cookie 从一个会话搬到另一个会话（openclaw 的 `action=importprofile`）；
 *   ③ agent 自己填账号密码 —— **三家都不做，我们也不做**。
 *
 * 本模块服务第 ② 级：它**只是搬运工**，不做任何"绕过"。
 *
 * ## 六条硬约束（改这里之前先读）
 *
 * ① **cookie 值只落盘、绝不进工具返回值 / 日志 / 报错文案** —— 返回值里只有计数与名字（名字本身
 *    不足以冒充身份）。凭据进模型上下文就等于泄漏给推理链路。
 * ② **默认关闭**：`allowCookieIO` 为假时 export/import 直接拒（`inspect` 只读计数不受影响）。
 * ③ **只接受 https**（或本地回环 http，供开发自测）—— 明文 http 上搬运凭据是另一类风险。
 * ④ **存档路径不可由调用方指定**：import 永远只读"本站点默认存档"那一个文件（`cookieStorePath`），
 *    否则就是一个任意文件读取面。
 * ⑤ 域名匹配必须做后缀边界判断（`a.example.com` 不该拿到 `notexample.com` 的 cookie）。
 * ⑥ 读出来的存档一律**过一遍净化**（`sanitizeCookie`）—— 磁盘上的东西是不可信输入。
 */

/** 存档格式版本：改字段必须升版本（读侧按版本分派，未知版本一律拒 —— 宁可读不出来也不误注入）。 */
export const COOKIE_STORE_VERSION = 1;

/** 存档目录名（放在 `<home>/.vssaros/` 下，与专属调试 profile 同域）。 */
export const COOKIE_STORE_DIRNAME = 'browser-cookies';

/** 本地回环主机（只有这些允许走明文 http —— 开发自测用，不是给真实站点开的口子）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 解析一个站点 URL（用于确定域名与合法性）。
 *
 * 返回 `undefined` 表示"这不是一个可以搬运凭据的地址"（畸形 / 非 http(s) / 无主机名）——
 * 调用方一律**当作拒绝**处理，不要"猜一个域名出来"。
 */
export function parseSiteUrl(raw) {
	const text = typeof raw === 'string' ? raw.trim() : '';
	if (!text) { return undefined; }
	let url;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}
	const protocol = url.protocol;
	if (protocol !== 'https:' && protocol !== 'http:') { return undefined; }
	const host = url.hostname.toLowerCase();
	if (!host) { return undefined; }
	return { url: url.href, host, protocol, isLoopback: LOOPBACK_HOSTS.has(host) };
}

/** 只接受 https（或本地回环 http）。明文 http 上的凭据搬运一律拒绝。 */
export function isAllowedSiteUrl(site) {
	if (!site || typeof site !== 'object') { return false; }
	return site.protocol === 'https:' || site.isLoopback === true;
}

/**
 * 域名匹配（**后缀边界**判断）：
 * `cookieDomain=.example.com` 应当匹配 `www.example.com`，但 `notexample.com` **不**匹配。
 * 直接 `endsWith(domain)` 就会漏掉这个边界 —— 那是一个安全漏洞，不是小事。
 */
export function cookieDomainMatches(domain, host) {
	const d = String(domain ?? '').trim().toLowerCase().replace(/^\./, '');
	const h = String(host ?? '').trim().toLowerCase();
	if (!d || !h) { return false; }
	return h === d || h.endsWith(`.${d}`);
}

/** 取某站点名下的 cookie（其余站点的 cookie 一律不进后续流程）。 */
export function filterCookiesForSite(cookies, host) {
	const list = Array.isArray(cookies) ? cookies : [];
	return list.filter(c => !!c && typeof c.name === 'string' && c.name.length > 0 && cookieDomainMatches(c.domain, host));
}

/**
 * "看起来像登录态"的 cookie 名启发式。
 *
 * ⚠ 它**只用于报数**（"这个域名下有 3 条疑似登录态"），**绝不用于授权判定** ——
 * 名字可以随便起，靠名字决定"能不能读某页"就是把猜测当事实。判断登录是否真生效，
 * 另有页面证据（见 `loginProbe.js` 的 `judgeLoginState`）。
 */
export const SESSIONISH_HINTS = [
	'session', 'sid', 'token', 'auth', 'login', 'passport', 'ticket', 'jwt', 'csrf',
	'userid', 'account', 'member',
];

/**
 * **站点白名单**：那些"名字里没有通用语义词、但确实就是登录态"的 cookie。
 *
 * 为什么必须有它：知乎的登录 cookie 叫 `z_c0`、微博叫 `SUB` —— 通用启发式**一条都命中不了**，
 * 症状是"明明登录了却判没登录"（这不是假设：2026-10-13 写的守卫测试拿真实名字 `z_c0` 一跑就红，
 * 才发现通用词表覆盖不到主流中文站点）。
 *
 * 名字来自各站的公开常识，**不是逆向**；且只用于报数 —— 判错一侧的代价只是少报/多报一条名字，
 * 真正的结论另有页面证据兜底（见 `loginProbe.js` 的冲突处理）。
 *
 * ⚠ 维护口径：只收**确凿的**登录态 cookie 名，宁可漏也不要臆造（臆造的名字会把"看起来登录了"
 * 变成一个假的强信号）。短名字（`a1` / `ct0` / `SUB`）**只能**出现在这里，不得进通用列表
 * —— 放通用列表会误伤任何含它的名字。
 */
const SITE_COOKIE_HINTS = [
	{ host: 'zhihu.com', names: ['z_c0'] },
	{ host: 'xiaohongshu.com', names: ['web_session', 'a1', 'webid'] },
	{ host: 'bilibili.com', names: ['sessdata', 'bili_jct', 'dedeuserid'] },
	{ host: 'douyin.com', names: ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_csrf_token'] },
	{ host: 'weibo.com', names: ['sub', 'subp'] },
	{ host: 'youtube.com', names: ['sapisid', '__secure-1psid', 'sid'] },
	{ host: 'twitter.com', names: ['auth_token', 'ct0'] },
	{ host: 'x.com', names: ['auth_token', 'ct0'] },
	{ host: 'reddit.com', names: ['reddit_session', 'token_v2'] },
	{ host: 'github.com', names: ['user_session', 'logged_in'] },
	{ host: 'linkedin.com', names: ['li_at'] },
];

/** 该站点的白名单（命中不到就给空数组 —— "没有白名单"不等于"没有登录态"）。 */
function siteHintsFor(host) {
	const h = String(host ?? '').trim().toLowerCase();
	if (!h) { return []; }
	const entry = SITE_COOKIE_HINTS.find(e => h === e.host || h.endsWith(`.${e.host}`));
	return entry ? entry.names : [];
}

/**
 * "看起来像登录态"：通用语义词 **或** 站点白名单（精确名匹配）。
 * ⚠ 仅用于报数（见模块头）—— 不要拿它当"能不能读某页"的依据。
 */
export function looksLikeSessionCookie(name, host) {
	const n = String(name ?? '').toLowerCase();
	if (!n) { return false; }
	if (SESSIONISH_HINTS.some(hint => n.includes(hint))) { return true; }
	return siteHintsFor(host).includes(n);
}

/** cookie 集合的**可外传摘要**（只有数量与名字，**没有值**）。`host` 决定用哪一份站点白名单。 */
export function summarizeCookies(cookies, host) {
	const list = Array.isArray(cookies) ? cookies : [];
	const names = list.map(c => (typeof c?.name === 'string' ? c.name : '')).filter(n => n.length > 0);
	const sessionish = names.filter(name => looksLikeSessionCookie(name, host));
	return { total: names.length, sessionish, hasSessionish: sessionish.length > 0 };
}

/** 把主机名净化成安全的文件名片段（不允许路径分隔符 / 冒号 / 通配符等）。 */
export function safeHostSlug(host) {
	const raw = String(host ?? '').trim().toLowerCase();
	if (!raw) { return undefined; }
	const slug = raw.replace(/[^a-z0-9.-]/g, '_').replace(/^[._-]+/, '').replace(/[._-]+$/, '').slice(0, 80);
	return slug.length > 0 ? slug : undefined;
}

/**
 * 某站点的**存档路径**（调用方不可指定 —— 见模块头 ④）。
 * 与 `dedicatedProfileDir`（`core/chrome.js`）同形：`<home>/.vssaros/...`。
 */
export function cookieStorePath(homeDir, platform, host) {
	const slug = safeHostSlug(host);
	if (!slug) { return undefined; }
	const sep = platform === 'win32' ? '\\' : '/';
	return `${homeDir}${sep}.vssaros${sep}${COOKIE_STORE_DIRNAME}${sep}${slug}.json`;
}

/**
 * 净化一条 cookie（磁盘读写**双向**共用）。
 *
 * 白名单式：只保留 CDP `Network.setCookies` 认识的字段。**`expires <= 0` 一律丢弃** ——
 * CDP 用 `-1` 表示"会话 cookie"，原样写回去会被某些版本当成 1970 年 ⇒ 立刻过期的死 cookie。
 */
export function sanitizeCookie(cookie) {
	const c = cookie ?? {};
	const name = typeof c.name === 'string' ? c.name : '';
	const value = typeof c.value === 'string' ? c.value : '';
	if (!name) { return undefined; }
	const out = { name, value };
	if (typeof c.domain === 'string' && c.domain) { out.domain = c.domain; }
	if (typeof c.path === 'string' && c.path) { out.path = c.path; }
	if (typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires > 0) { out.expires = c.expires; }
	if (c.httpOnly === true) { out.httpOnly = true; }
	if (c.secure === true) { out.secure = true; }
	if (typeof c.sameSite === 'string' && c.sameSite) { out.sameSite = c.sameSite; }
	return out;
}

/** 存档信封（写入磁盘的形状；含 `savedAt` 便于用户自己判断新旧）。 */
export function cookieStoreEnvelope(host, cookies, savedAt) {
	const list = (Array.isArray(cookies) ? cookies : []).map(sanitizeCookie).filter(Boolean);
	return {
		version: COOKIE_STORE_VERSION,
		host: String(host ?? ''),
		savedAt: String(savedAt ?? ''),
		cookies: list,
	};
}

/**
 * 解析存档（**不抛错**，返回判别式结果 —— 与 web_search provider 的 `errors[]` 同纪律：
 * "读不出来"必须是一种可表达的、能如实告诉用户的状态，而不是异常）。
 */
export function parseCookieStoreEnvelope(rawText) {
	let data;
	try {
		data = JSON.parse(String(rawText ?? ''));
	} catch {
		return { ok: false, reason: 'not-json' };
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) { return { ok: false, reason: 'not-object' }; }
	if (data.version !== COOKIE_STORE_VERSION) { return { ok: false, reason: `version-mismatch(${String(data.version)})` }; }
	if (typeof data.host !== 'string' || !data.host) { return { ok: false, reason: 'missing-host' }; }
	if (!Array.isArray(data.cookies)) { return { ok: false, reason: 'missing-cookies' }; }
	const cookies = data.cookies.map(sanitizeCookie).filter(Boolean);
	if (cookies.length === 0) { return { ok: false, reason: 'no-usable-cookies' }; }
	return {
		ok: true,
		host: data.host,
		savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
		cookies,
	};
}

/** 归一 `cookies` op 的 action；未知值一律落到**只读**的 `inspect`（不认识的动作不许有副作用）。 */
export function normalizeCookieAction(raw) {
	const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	if (v === 'export' || v === 'import') { return v; }
	return 'inspect';
}

/** `cookies` op 的给模型报告（**只有计数与名字，没有值**）。 */
export function formatCookieReport(options) {
	const action = options?.action ?? 'inspect';
	const host = String(options?.host ?? '');
	const summary = options?.summary ?? { total: 0, sessionish: [], hasSessionish: false };
	const head = {
		inspect: `## Cookie inspect — ${host}`,
		export: `## Cookie export — ${host}`,
		import: `## Cookie import — ${host}`,
	}[action] ?? `## Cookie — ${host}`;

	const lines = [head, '', `Matched **${summary.total}** cookie(s) for this site.`];
	if (summary.hasSessionish) {
		lines.push(`Login-ish names (heuristic, names only): ${summary.sessionish.join(', ')}`);
	} else if (summary.total > 0) {
		lines.push('None of the cookie names look like a login/session cookie — this site may simply not be signed in yet.');
	}
	if (action === 'export') {
		lines.push('', `Saved to: ${String(options?.path ?? '(unknown)')}`);
		lines.push('⚠ That file holds live credentials for this site. Do NOT paste it anywhere, and do not commit it.');
	}
	if (action === 'import') {
		lines.push('', `Injected **${Number(options?.injected ?? 0)}** cookie(s) into the browser this toolset drives. Reload the page, then verify with \`op: "login"\` + \`done: true\`.`);
	}
	if (action === 'inspect') {
		lines.push('', 'This op is **read-only**: nothing was written and no cookie value was returned. To save/restore a session, use `action: "export"` / `"import"` (config `allowCookieIO` must be on, and each call asks for approval).');
	}
	if (summary.total === 0) {
		lines.push('', 'No cookie for this site means the site was never signed in **in this browser profile**. Ask the user to sign in there once (`op: "login"`), then check again.');
	}
	return lines.join('\n');
}
