/**
 * ★ 2026-11-06（P1，对齐 DS Bot 浏览器插件「打开 / 点击 / 输入不问」的体验，但只对本机地址放开）：
 * 本机地址（localhost / 127.0.0.1 / ::1 / *.localhost）上的动作免审批。
 *
 * 为什么只放本机：本工具驱动的是**你真实的 Chrome**（带登录态），在外部站点上点击 / 输入可能发帖、下单、改设置；
 * 而本机地址是 bot 自己起的预览服务（网页开发 → 测试的闭环里，测试要连点几十下），没有你的账号。
 *
 * 判据（纯函数，见 `localExemptionOf`）：
 *   · `navigate`：目标地址是本机的 http(s) 地址；
 *   · `click` / `type` / `pressEnter` / `pressKey`：**当前页面**是本机地址（点击可能把页面带走，
 *     但离开本机后的下一次动作又会按外部站点逐次问）；
 *   · `back` / `reset` / `login` / `cookies` / `storage` / `evaluate` 不在内：
 *     `back` 的去向不知道，其余几个本来就有各自的闸，不能因为地址是本机就放过。
 * `askLocal: true` 恢复逐次确认。
 */

/** 本机地址的主机名（不分大小写；`*.localhost` 也算，RFC 6761）。 */
export function isLoopbackHost(hostname) {
	const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
	if (!host) { return false; }
	if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') { return true; }
	return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** 这个地址是不是本机的 http(s) 地址；解析不了 ⇒ false。 */
export function isLocalUrl(url) {
	let parsed;
	try { parsed = new URL(String(url ?? '').trim()); } catch { return false; }
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { return false; }
	return isLoopbackHost(parsed.hostname);
}

/** 当前页面是本机地址时可以免问的动作。 */
export const LOCAL_PAGE_OPS = Object.freeze(['click', 'type', 'pressEnter', 'pressKey']);

/**
 * 这次动作能不能因为「只碰本机地址」免审批。
 * @param op 浏览器 op
 * @param params 调用参数（navigate 读 `url`）
 * @param currentUrl 本会话当前页面的地址（读不到就传空串）
 * @param options `{ askLocal }`：true ⇒ 一律不免
 * @returns 免问的理由（写日志用）；不能免 ⇒ undefined
 */
export function localExemptionOf(op, params, currentUrl, options = {}) {
	if (options.askLocal) { return undefined; }
	if (op === 'navigate') { return isLocalUrl(params?.url) ? `navigate → ${String(params.url).slice(0, 120)}` : undefined; }
	if (LOCAL_PAGE_OPS.includes(op)) { return isLocalUrl(currentUrl) ? `${op} @ ${String(currentUrl).slice(0, 120)}` : undefined; }
	return undefined;
}
