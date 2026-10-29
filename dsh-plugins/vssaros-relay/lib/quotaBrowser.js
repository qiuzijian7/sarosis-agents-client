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
	if (session.headless) {
		throw new Error('浏览器插件当前是无头模式，没有可见窗口可以登录 —— 关掉无头模式后再试');
	}
	const before = (await readWoaCookies(browserService)).cookie;
	log(`[quota] 浏览器里还没有 woa 会话 ⇒ 打开登录页（${TOKEN_URL}）`);
	await session.open(WOA_LOGIN_PROFILE, TOKEN_URL);
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, pollMs));
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
export async function collectQuotaViaBrowser(browserService, options = {}) {
	const log = options.log ?? (() => { });
	const session = browserService?.loginSession;
	if (!session) {
		return { ok: false, error: '需要浏览器插件（@vssaros/dsh-browser）才能采集额度' };
	}
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
