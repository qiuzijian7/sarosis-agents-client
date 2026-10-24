/**
 * 「登录会话」—— 给**同一 Host 进程里的其他插件**用的窄口子（2026-10-22）。
 *
 * 需求（用户选的方案 ①）：LightAI 在 dsh 侧登录 = "用本仓的浏览器插件打开登录页、登录后自动读取 Cookie"。
 * 所以 bridge 插件要能：① 在**用户看得见**的浏览器里打开登录页（并切到前台）；② 登录后读那个站点的
 * 会话 Cookie（含 HttpOnly）；③ 完事关掉那个 tab。
 *
 * ── 为什么是"窄口子"而不是把 CDP 客户端整个交出去 ──────────────────────────────────────
 *   `browser` 工具对模型有两道闸（`allowCookieIO` 开关 + 逐次审批）——那是因为**模型**能调它。
 *   这里的调用方是 Host 插件、触发者是**用户在设置页点「登录」**（显式意图），凭据只进 Host 的凭据存储
 *   （不进模型上下文、不落 `browser-cookies/` 存档）⇒ 不走那两道闸；但口子必须收窄到"只能做这件事"：
 *   · 只认**登记过的站点**（{@link LOGIN_PROFILES}：站点域名后缀 + 允许读的 cookie 名）——
 *     调用方不能拿它去读任意站点的 cookie ✓；
 *   · 只回**登记过的那几个 cookie 名**（不回整站 cookie）✓；只认 https ✓；
 *   · tab 用**专属归属键**（`vssaros-login:<profile>`）—— 与模型工具的会话 tab 互不抢、不串 ✓。
 *   · 无头模式（headless）没有可见窗口 ⇒ 打不开登录页 ⇒ **明说**，不假装在等 ✓。
 *
 * ⚠ 这一层收不到 CDP 事件（`CdpConnection` 丢弃事件）⇒ "等用户登录完"由调用方**轮询** `cookies()`。
 */

import { cookieDomainMatches, parseSiteUrl } from './cookies.js';

/** tab 归属键前缀（与模型工具的会话键——dsh 的 agent id——不可能撞上）。 */
export const LOGIN_OWNER_PREFIX = 'vssaros-login:';

/**
 * 登记过的登录站点。新增站点 = 在这里加一行（显式、可审计）✓。
 * `hostSuffix`：登录页 / 读 cookie 的站点必须是它或它的子域（按域名边界比，`notaigclsp.com` 不算）；
 * `cookieNames`：只允许读这几个名字。
 */
export const LOGIN_PROFILES = Object.freeze({
	lightai: Object.freeze({ hostSuffix: 'aigclsp.com', cookieNames: Object.freeze(['sessionid', 'uid']) }),
});

function profileOf(name) {
	const p = Object.prototype.hasOwnProperty.call(LOGIN_PROFILES, name) ? LOGIN_PROFILES[name] : undefined;
	if (!p) {
		throw new Error(`没有登记的登录站点：${String(name)}（只认 ${Object.keys(LOGIN_PROFILES).join(' / ')}）`);
	}
	return p;
}

/** url ⇒ 站点（必须 https、且在登记的域名后缀之下）。 */
function siteFor(profile, url) {
	const site = parseSiteUrl(url);
	if (!site || !/^https:\/\//i.test(String(url))) {
		throw new Error(`登录页必须是 https 地址：${String(url)}`);
	}
	if (!cookieDomainMatches(profile.hostSuffix, site.host)) {
		throw new Error(`登录页 ${site.host} 不在登记的站点 ${profile.hostSuffix} 之下`);
	}
	return site;
}

/**
 * @param {object} deps
 * @param {import('./client.js').BrowserCdpClient} deps.baseClient 无会话绑定的客户端（`forSession` 取 tab 视图）
 * @param {(method: string, params?: object) => Promise<any>} deps.browserCommand 浏览器级命令（不带 sessionId）
 * @param {boolean} deps.headless 浏览器插件是否无头
 * @param {(line: string) => void} [deps.log]
 */
export function createLoginSessions({ baseClient, browserCommand, headless, log = () => { } }) {
	/** profile → 绑定 tab 的视图（同一站点重复登录 ⇒ 复用同一个 tab ✓）。 */
	const views = new Map();
	const viewOf = name => {
		let v = views.get(name);
		if (!v) {
			v = baseClient.forSession(LOGIN_OWNER_PREFIX + name);
			views.set(name, v);
		}
		return v;
	};

	return {
		/** 诊断用：无头时 `open` 必然失败。 */
		headless: !!headless,
		profiles: Object.keys(LOGIN_PROFILES),

		/** 在可见浏览器里打开登录页并切到前台。 */
		async open(name, url) {
			const profile = profileOf(name);
			siteFor(profile, url);
			if (headless) {
				throw new Error('浏览器插件当前是无头模式（headless），没有可见窗口可以登录 —— 关掉无头模式后再试');
			}
			const page = await viewOf(name).openForLogin(String(url));
			// 新建的 tab 不会自己跑到前台（尤其接管的是用户自己的 Chrome 时）⇒ 显式激活一次；失败不致命
			try { await browserCommand('Target.activateTarget', { targetId: page.targetId }); } catch { /* 老浏览器 / 已关 */ }
			log(`[vssaros-browser] 登录会话：已打开 ${name} 登录页`);
			return { opened: true };
		},

		/**
		 * 读登记站点的会话 cookie（只回登记过的名字；值为空的不回）。
		 * 浏览器级 `Storage.getCookies`（含 HttpOnly，不需要页面）。
		 */
		async cookies(name, url) {
			const profile = profileOf(name);
			const site = siteFor(profile, url);
			const res = await browserCommand('Storage.getCookies', {});
			const all = Array.isArray(res?.cookies) ? res.cookies : [];
			return all
				.filter(c => c && profile.cookieNames.includes(c.name) && typeof c.value === 'string' && c.value
					&& cookieDomainMatches(String(c.domain ?? ''), site.host))
				.map(c => ({ name: c.name, value: c.value, domain: String(c.domain ?? ''), expires: typeof c.expires === 'number' ? c.expires : -1 }));
		},

		/** 关掉本站点登录用的那个 tab（只关自己开的；用户自己的 tab 不碰）。 */
		async close(name) {
			profileOf(name);
			const v = views.get(name);
			if (!v) { return { closed: false }; }
			try { await v.closeOwnedPage(); } catch { /* 用户已经手动关了 */ }
			return { closed: true };
		},
	};
}
