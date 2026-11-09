/**
 * ★ 2026-11-06（P1，对齐 DS Bot `browser_screenshot`）：截当前页面，交给模型**看**。
 *
 * 文字快照看不出布局错乱、遮挡、配色、文字溢出这类问题；测试在浏览器里点测时要能看到画面。
 * 截图走 CDP `Page.captureScreenshot`（JPEG，默认质量 70，只截可视区域），字节存成 DSH 附件
 *（`ctx.get('attachments').saveImage`），工具结果里放一个引用它的图片块 —— 工具结果里**不能**直接内联
 * base64（DS Bot `mount.js` 同口径：会破坏会话的传输编码）。拿不到附件服务时只回文字说明，不假装截到了。
 * 截图是只读动作：不改页面状态 ⇒ 不需要审批。
 */

export const SCREENSHOT_LIMITS = Object.freeze({ qualityMin: 30, qualityMax: 90, qualityDefault: 70 });

/**
 * 2026-11-09（§4 安全闸，对齐 DS Bot `session.js:508-516` 的 180KB 上限）：
 * 工具结果里绝不放过大的图片附件。base64 → 字节数只做估算（去掉尾部 padding 后 ×3/4），
 * 不解码，避免为了判大小再吃一份内存。
 */
export const MAX_SCREENSHOT_BYTES = 180 * 1024;

/** @returns 拒绝原因，或 undefined（可放行）。 */
export function screenshotSizeProblem(base64) {
	const text = String(base64 ?? '').replace(/=+$/, '');
	const bytes = Math.floor(text.length * 3 / 4);
	if (!bytes) return '截图为空，没有生成图片附件。';
	if (bytes > MAX_SCREENSHOT_BYTES) {
		return `截图约 ${Math.round(bytes / 1024)}KB，超过 ${Math.round(MAX_SCREENSHOT_BYTES / 1024)}KB 上限，未生成附件。`
			+ '请降低 quality 或关掉 fullPage 后重试；页面内容不变，也可以先用 snapshot 读文字。';
	}
	return undefined;
}

/** 归一化截图参数：只认 `quality`（30–90，默认 70）与 `fullPage`（截整页，默认否）。 */
export function normalizeScreenshotParams(params) {
	const raw = Number(params?.quality);
	const quality = Number.isFinite(raw)
		? Math.min(SCREENSHOT_LIMITS.qualityMax, Math.max(SCREENSHOT_LIMITS.qualityMin, Math.round(raw)))
		: SCREENSHOT_LIMITS.qualityDefault;
	return { quality, fullPage: params?.fullPage === true };
}

/** 截图结果给模型读的那行字。 */
export function screenshotText({ url, title, width, height, fullPage, attached }) {
	const where = `${title ? `「${String(title).slice(0, 80)}」` : ''}${url ? ` ${String(url).slice(0, 200)}` : ''}`.trim();
	const size = width && height ? `${width}×${height}` : '';
	if (!attached) { return `截到了${where ? ` ${where}` : ''}，但这台 Host 没有附件服务，图片没法交给你看（只能用 snapshot 读文字）。`; }
	return `当前页面截图${where ? `：${where}` : ''}${size ? `（${fullPage ? '整页' : '可视区域'} ${size}）` : ''}。图片在下面。`;
}
