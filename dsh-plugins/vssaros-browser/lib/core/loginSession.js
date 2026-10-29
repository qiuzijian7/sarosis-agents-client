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
	/**
	 * ★ 2026-10-28：**企业内网额度看板**（token.woa.com / aitoken.woa.com）。
	 *
	 * 为什么需要它：`token.woa.com` / `aitoken.woa.com` 的个人额度只认 **passport 会话 cookie**
	 * （`.woa.com` 域，httpOnly）。dsh Host 是 Node 进程 ⇒ 读不到 Chrome 的 cookie
	 * （App-Bound Encryption，SYSTEM 也解不开）⇒ **只能从真实浏览器进程里读**。
	 *
	 * 走这里的三个好处（与 LightAI 同构）：
	 *   ① `Storage.getCookies` 拿的是**浏览器进程里已解密的** cookie ⇒ 绕开 ABE ✓
	 *   ② `open()` 在**用户可见的浏览器**里开登录页 ⇒ 企业 SSO（iOA 推送）在真实浏览器里
	 *      **回执正常**（在 Electron 窗口里实测收不到，见 quotaSync 的教训）✓
	 *   ③ 窄口子不变：只认登记域名 + 只回登记 cookie 名 ✓
	 *
	 * ⚠ cookie 名取的是企业 SSO 的**常见会话 cookie 名**（不猜具体某一个）——
	 *   拿到哪几个就用哪几个（Cookie 头是拼在一起的）⇒ 判定标准是"能不能让
	 *   `token.woa.com` 返回带 `pt` 的页面"，而不是"名字对不对" ✓
	 */
	woa: Object.freeze({
		hostSuffix: 'woa.com',
		cookieNames: Object.freeze([
			'RIO_TOKEN', 'P_RIO_TOKEN', 'p_skey', 'skey', 'ptui_token', 'ptoken', 'ptui',
			'SSO_ID', 'Ticket', 'ticket', 'LoginTicket', 'staff_session', 'StaffSession',
			'sessionid', 'uid', 'jwt', 'token', 'Token', 'login_uin', 'wxuin',
		]),
	}),
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
export function createLoginSessions({ baseClient, browserCommand, headless, ensureHeaded, ensureHeadless, log = () => { } }) {
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

	/**
	 * 确保当前浏览器是**有头**的（手动登录入口专用）。
	 *
	 * ★ 2026-10-30（用户要求）：手动点「浏览器登录」时**必须弹出可见窗口**。
	 *   平时是**无头**（用户无感）⇒ 这里把它切回有头；Chrome 不允许同 profile
	 *   两个实例并存 ⇒ 切换由 host 负责（先杀无头实例 → 用同一 profile 拉有头实例）✓
	 *   切换失败 ⇒ 抛**明确**错误（页面能显示人话），绝不静默失败 ✗
	 */
	const ensureHeadedOrThrow = async () => {
		if (typeof ensureHeaded === 'function') {
			await ensureHeaded();
			return;
		}
		if (headless) {
			throw new Error('浏览器插件当前是无头模式（headless），没有可见窗口可以登录 —— 关掉无头模式后再试');
		}
	};

	return {
		/** 诊断用：无头时 `open` 必然失败。 */
		headless: !!headless,
		profiles: Object.keys(LOGIN_PROFILES),

		/**
		 * 交互结束后**回到无头**（用户无感）—— 2026-10-28。
		 * 调用方（额度采集等）在登录成功后调它 ⇒ 可见窗口随即消失 ✓
		 */
		async ensureHeadless() {
			if (typeof ensureHeadless === 'function') {
				await ensureHeadless();
			}
		},

		/**
		 * 确保当前浏览器是**有头**的（手动登录入口专用）。
		 *
		 * ★ 2026-10-30（用户要求）：手动点「浏览器登录」时**必须弹出可见窗口**。
		 *   平时是**无头**（用户无感）⇒ 这里把它切回有头；Chrome 不允许同 profile
		 *   两个实例并存 ⇒ 切换由 host 负责（先杀无头实例 → 用同一 profile 拉有头实例）✓
		 *   切换失败 ⇒ 抛**明确**错误（页面能显示人话），绝不静默失败 ✗
		 */
		async ensureHeaded() {
			await ensureHeadedOrThrow();
		},

		/**
		 * 在登记站点的页面里**同源 fetch**（2026-10-30 新增）。
		 *
		 * ★ 为什么必须走这里：Chrome 153+ 对 cookie 全面启用 **App-Bound Encryption**
		 *   ⇒ 自动化客户端 `Storage.getCookies` **读不到 cookie**（实测 Chrome 156：
		 *   有头/无头都是 0 个）✗ ⇒ 「读 cookie 再自己 fetch」这条路已经废了。
		 *   ⇒ 只能**让浏览器自己发请求**：在目标域的页面里 `fetch(同源路径)` ⇒
		 *      cookie 由浏览器带上、**不出浏览器**；我们只拿到响应里的数字 ✓
		 *
		 * @param {string} name  登记站点名（`LOGIN_PROFILES` 的 key）
		 * @param {string} url   目标页（必须是**同源**的那一页 ⇒ fetch 才是同源、不被 CORS 拦）
		 * @param {string} path  同源相对路径（如 `/api/query-quota?platform=all`）
		 * @returns {Promise<{status:number, ok:boolean, text:string}>}
		 */
		async fetchInSite(name, url, path) {
			const view = viewOf(name);
			// 确保这个会话的 tab 停在目标域（同源 ⇒ 下面的 fetch 不会被 CORS 拦）
			await view.openForLogin(String(url));
			const expression = `(async () => {
				const pt = (document.querySelector('meta[name="pt"]') || {}).content || '';
				const headers = { 'Accept': 'application/json, text/plain, */*' };
				if (pt) { headers['x-page-token'] = pt; }
				try {
					const res = await fetch(${JSON.stringify(String(path))}, { method: 'GET', credentials: 'include', headers });
					const text = await res.text();
					return { status: res.status, ok: res.ok, text: text.slice(0, 200000) };
				} catch (error) {
					return { status: 0, ok: false, text: String((error && error.message) || error) };
				}
			})()`;
			const result = await view.evaluateAsync(expression, 30_000);
			if (!result || typeof result !== 'object') {
				throw new Error('页面内 fetch 没有返回结果');
			}
			return result;
		},

		/** 在可见浏览器里打开登录页并切到前台。 */
		async open(name, url) {
			const profile = profileOf(name);
			siteFor(profile, url);
			// ★ 手动登录 ⇒ 先确保是**有头**（有头时是幂等的，直接返回）
			await ensureHeadedOrThrow();
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
