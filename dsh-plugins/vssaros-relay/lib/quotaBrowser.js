// 额度采集的**浏览器侧**通道（2026-10-28）。
//
// ── 为什么走浏览器，而不是 Electron 窗口 / 手动粘贴 ──────────────────────────────
//   · `token.woa.com` / `aitoken.woa.com` 的个人额度只认 **passport 会话 cookie**（`.woa.com`，httpOnly）。
//   · dsh Host 是 Node 进程 ⇒ 读不到 Chrome 的 cookie（App-Bound Encryption，SYSTEM 也解不开）✗
//   · 在 **Electron 窗口**里登录：企业 SSO（iOA 推送）在那种上下文里**收不到回执**
//     （实测：页面永远停在「Verification successful…」⇒ 换不到票）✗
//   · 在**真实浏览器**里登录：回执正常；而且浏览器进程里 cookie **已解密** ⇒ 直接可读 ✓
//
// ── 机制（与 LightAI 完全同构，抄 `vssaros-bridge/lib/lightai.js`）────────────────
//   ① `loginSession.cookies(profile, url)` ⇒ 浏览器级 `Storage.getCookies`（含 HttpOnly）
//   ② 没有 ⇒ `loginSession.open(profile, url)` ⇒ 在用户可见的浏览器里打开登录页
//   ③ 轮询 `cookies()` ⇒ 值变了就是登录成功 ⇒ `close(profile)` 关掉那个 tab ⇒ 立刻采集
//
// ── 安全边界 ────────────────────────────────────────────────────────────────────
//   · 只读**登记站点**（`vssaros-browser` 的 LOGIN_PROFILES：域名后缀 + cookie 名白名单）✓
//   · cookie 只进 dsh 凭据库 / 内存，**上报给中转站的只有额度数字** ✓

import { collectQuota } from './quota.js';

/** 浏览器插件里登记的站点名（`vssaros-browser/lib/core/loginSession.js` 的 LOGIN_PROFILES）。 */
export const WOA_LOGIN_PROFILE = 'woa';
/** 额度看板（同时也是登录入口）。 */
export const TOKEN_URL = 'https://token.woa.com/';
/** 真实额度（人员额度分配明细）。 */
export const AITOKEN_URL = 'https://aitoken.woa.com/';
/**
 * 采集用的**独立会话**（独立 tab）—— 2026-10-30。
 *
 * 为什么单独一个：登录 tab（`woa`）给用户操作，采集 tab（`woa-api`）用来在页面里 fetch。
 * 分开 ⇒ 采集不会把用户正在登录的页面导航走 ✓
 */
export const QUOTA_API_PROFILE = 'woa-api';

/** cookie 列表 ⇒ `Cookie:` 头字符串（空值丢掉）。 */
function toCookieHeader(cookies) {
	return (Array.isArray(cookies) ? cookies : [])
		.filter((cookie) => cookie && cookie.name && cookie.value)
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join('; ');
}

/**
 * 从**真实浏览器**里读 woa 会话 cookie。
 *
 * ⚠ token.woa.com 与 aitoken.woa.com 同属 `.woa.com` ⇒ passport 写的一份 cookie
 *   对两个站都有效 ⇒ 读一次即可（两个 URL 都会返回同一批 `.woa.com` cookie）✓
 *
 * ★★ 2026-10-29（真机：打包版 Host 首启慢 18 秒）：`session.cookies()` 走 CDP 到**专属 Chrome 实例**，
 *   那个实例是**冷启动**的 ⇒ 首次调用要等 18 秒（真机：`host-52014a34.log` 里
 *   `[vssaros-relay] [quota] 浏览器里没有 woa 会话` 出现在 host uptime 24.8s，
 *   而 `[vssaros-bridge] apply` 也在 24.8s ⇒ **Host ready 被这次采集拖住了 18 秒**）✗✗。
 *   ⇒ 这里加**硬超时**（默认 5s）：读不到就当"没有会话"，让额度采集稍后再试，
 *     绝不让它挡住 Host 就绪 ✗（额度是锦上添花，Host 起不来是致命的）。
 *
 * @param {any} browserService `ctx.vssarosBrowser`（含 `loginSession`）
 * @param {{timeoutMs?: number, log?: (line: string) => void}} [options]
 * @returns {Promise<{cookie: string, names: string[]}>}
 */
export async function readWoaCookies(browserService, options = {}) {
	const session = browserService?.loginSession;
	const timeoutMs = Number(options.timeoutMs ?? 5 * 1000);
	const log = options.log ?? (() => { });
	if (!session || typeof session.cookies !== 'function') {
		return { cookie: '', names: [] };
	}
	let cookies = [];
	try {
		// ⚠ 超时兜底：Chrome 冷启动可能十几秒；这里**不无限等**。
		cookies = await Promise.race([
			session.cookies(WOA_LOGIN_PROFILE, TOKEN_URL),
			new Promise((resolve) => {
				const t = setTimeout(() => resolve(undefined), timeoutMs);
				t.unref?.();
			}),
		]) ?? [];
		if (!Array.isArray(cookies)) {
			log(`[quota] 读浏览器 cookie 超时（${timeoutMs}ms，浏览器可能正在冷启动）⇒ 本次不采集`);
			cookies = [];
		}
	} catch {
		cookies = [];
	}
	const names = (Array.isArray(cookies) ? cookies : []).map((cookie) => String(cookie?.name || '')).filter(Boolean);
	return { cookie: toCookieHeader(cookies), names };
}

/**
 * 在**用户可见的浏览器**里打开登录页，等登录完成（cookie 变化）后关掉那个 tab。
 *
 * @param {any} browserService
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 等待上限（默认 5 分钟）
 * @param {number} [options.pollMs]    轮询间隔（默认 2 秒）
 * @param {(line: string) => void} [options.log]
 */
export async function loginInBrowser(browserService, options = {}) {
	const session = browserService?.loginSession;
	const log = options.log ?? (() => { });
	const timeoutMs = Number(options.timeoutMs ?? 5 * 60 * 1000);
	const pollMs = Number(options.pollMs ?? 2000);
	if (!session || typeof session.open !== 'function' || typeof session.cookies !== 'function') {
		throw new Error('额度采集需要浏览器插件（@vssaros/dsh-browser）—— 请在「内置插件」里启用它');
	}
	// ★ 2026-10-30（用户要求：手动点「浏览器登录」必须弹**有头**浏览器）：
	//   原来这里有句「无头就直接抛错」，而它在 `ensureHeaded()` **之前** ⇒
	//   永远走不到切有头那一步 ⇒ 每次登录都失败（页面显示"无头模式…"）✗✗
	//   ⇒ 改成：**能切就先切有头**（切不动才报错）；
	//      `session.headless` 只是构造时的快照，不代表当前模式，不能拿它当拦截条件 ✓
	if (typeof session.ensureHeaded === 'function') {
		await session.ensureHeaded();
	} else if (session.headless) {
		throw new Error('浏览器插件当前是无头模式，没有可见窗口可以登录 —— 关掉无头模式后再试');
	}
	// 登录前的 cookie 快照（切有头之后再取：切模式会重启 Chrome，取早了就对不上）✓
	const before = (await readWoaCookies(browserService)).cookie;
	log(`[quota] 浏览器里还没有 woa 会话 ⇒ 打开登录页（${TOKEN_URL}，可见窗口）`);
	await session.open(WOA_LOGIN_PROFILE, TOKEN_URL);
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, pollMs));
			// ★ 2026-10-30：**首选「能不能在页面里取到额度」**作为登录成功信号 ——
			//   新版 Chrome（153+）自动化读不到 cookie ⇒ "cookie 变化"这个信号已经失效 ✗
			//   ⇒ 直接看数据出不出来（最可靠，也不需要我们碰 cookie）✓
			const inPage = await collectQuotaInPage(session, { log, quiet: true });
			if (inPage) {
				log('[quota] 已能在浏览器页面内取到额度 ⇒ 登录完成');
				return true;
			}
			// 回退信号（老浏览器插件能读 cookie 时有效）
			const now = (await readWoaCookies(browserService)).cookie;
			if (now && now !== before) {
				log('[quota] 浏览器会话 cookie 已更新 ⇒ 登录完成');
				return true;
			}
		}
		throw new Error('登录超时（5 分钟内浏览器里没有出现新的 woa 会话）');
	} finally {
		try { await session.close(WOA_LOGIN_PROFILE); } catch { /* 用户已经关了 */ }
		// ★ 2026-10-28（用户要求「无感」）：交互结束 ⇒ 把专属实例切回**无头**
		//   ⇒ 那个可见的 Chrome 窗口随之消失；之后采集全部在后台无感进行 ✓
		try { await session.ensureHeadless?.(); } catch { /* 切不回去也不影响已拿到的 cookie */ }
	}
}

/**
 * 采集额度（**全自动**：先复用浏览器里已有的会话，没有就在浏览器里登录一次）。
 *
 * @param {any} browserService
 * @param {object} [options]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ok: boolean, quota?: any, error?: string, needsLogin?: boolean}>}
 */
/**
 * 解析 `/api/query-quota` 的响应（页内 fetch 回来的**文本**）。
 *
 * ★ 口径（与 `lib/quota.js` 一致）：额度/剩余就在这个响应里 ——
 *   `total_quota`（总额度）/ `total_used`（本月已用）/ `remaining`（剩余）✓
 *
 * @param {string} text
 * @returns {null | {ok: true, source: string, month: string, total_quota: number|null, used: number|null, remaining: number|null, total_consumed: null, updated_at: string}}
 */
function parseQuotaResponse(text) {
	let body = null;
	try { body = JSON.parse(String(text ?? '')); } catch { return null; }
	if (!body || typeof body !== 'object') { return null; }
	const personal = (body.personal && typeof body.personal === 'object') ? body.personal : {};
	const used = body.total_used ?? body.personal_used ?? null;
	const totalQuota = body.total_quota ?? body.quota ?? personal.quota ?? null;
	const remaining = body.remaining ?? body.personal_remaining ?? personal.remaining ?? null;
	if (used == null && totalQuota == null) { return null; }
	const now = new Date();
	return {
		ok: true,
		source: 'browser-page',
		month: String(body.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`),
		total_quota: totalQuota == null ? null : Number(totalQuota),
		used: used == null ? null : Number(used),
		remaining: remaining == null ? null : Number(remaining),
		total_consumed: null,
		staff: String(body.staff || body.login_name || '') || undefined,
		updated_at: now.toISOString(),
	};
}

/**
 * 在浏览器**页面里**同源 fetch 额度接口 ⇒ 拿到额度数字（cookie 全程不出浏览器）。
 *
 * ★ 为什么必须这样（2026-10-30 实测）：Chrome 153+ 对 cookie 全面启用 **App-Bound
 *   Encryption** ⇒ 自动化客户端 `Storage.getCookies` **读不到 cookie**
 *   （实测 Chrome 156：有头 0 个、无头 0 个）✗ ⇒ 「读 cookie 再自己 fetch」这条路已废。
 *   ⇒ 只能让**浏览器自己发请求**（页面同源 fetch）⇒ 我们只拿响应里的数字 ✓
 *
 * @param {any} session `browserService.loginSession`
 * @param {{log?: (line: string) => void, quiet?: boolean}} [options]
 * @returns {Promise<null | object>} 取到额度返回 quota 对象，取不到返回 null
 */
export async function collectQuotaInPage(session, options = {}) {
	const log = options.log ?? (() => { });
	if (!session || typeof session.fetchInSite !== 'function') { return null; }
	try {
		const res = await session.fetchInSite(QUOTA_API_PROFILE, TOKEN_URL, '/api/query-quota?platform=all');
		const quota = parseQuotaResponse(res?.text);
		if (quota && !options.quiet) {
			log('[quota] 已在浏览器页面内取到额度（cookie 未离开浏览器）');
		}
		return quota;
	} catch (error) {
		if (!options.quiet) {
			log(`[quota] 页面内取额度失败：${String((error && error.message) || error)}`);
		}
		return null;
	}
}

/**
 * @param {any} browserService `ctx.vssarosBrowser`（含 `loginSession`）
 * @param {{log?: (line: string) => void}} [options]
 * @returns {Promise<{ok: boolean, quota?: any, error?: string, needsLogin?: boolean}>}
 */
export async function collectQuotaViaBrowser(browserService, options = {}) {
	const log = options.log ?? (() => { });
	const session = browserService?.loginSession;
	if (!session) {
		return { ok: false, error: '需要浏览器插件（@vssaros/dsh-browser）才能采集额度' };
	}

	// ★ 首选「页内同源 fetch」（Chrome 153+ 的唯一可行路径，见 collectQuotaInPage 的说明）
	const inPage = await collectQuotaInPage(session, { log });
	if (inPage) {
		return { ok: true, quota: inPage, error: '' };
	}
	// 回退：老浏览器插件（Chrome 能读 cookie 的那些）⇒ 用 cookie 直接 fetch
	const cookies = await readWoaCookies(browserService);
	if (!cookies.cookie) {
		log('[quota] 浏览器里没有 woa 会话 ⇒ 需要登录一次');
		return { ok: false, needsLogin: true, error: '浏览器里还没有 woa 登录态' };
	}
	// 一份 `.woa.com` cookie 对两个站都有效 ⇒ 同一个 Cookie 头喂两个接口 ✓
	const quota = await collectQuota({
		tokenCookie: cookies.cookie,
		aitokenCookie: cookies.cookie,
	});
	return { ok: !!quota.ok, quota, error: quota.error || '' };
}
