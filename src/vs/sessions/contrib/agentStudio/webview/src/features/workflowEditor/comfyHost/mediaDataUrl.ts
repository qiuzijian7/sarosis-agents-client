/*---------------------------------------------------------------------------------------------
 *  data URL → Blob URL（2026-09-12 修「媒体库视频点击后变黑」）。
 *
 *  根因：媒体库视频此前把 `mediaGetAsDataUrl` 返回的 **几 MB base64 data URL** 直接赋给
 *  `<video src>` → Chromium 加载大 data URL 失败 → **黑块** ✗（`MediaGallery.tsx:235` 的
 *  注释已记录同类问题，但只改成「点击按需解析」，没换掉 data URL 这个载体 ✗）。
 *
 *  修法：解析出字节 → `Blob` → `URL.createObjectURL` → `<video src="blob:…">` ✓
 *  （blob URL 对大体量媒体可靠；CSP 的 `media-src` 已放行 `blob:` ✓）。
 *
 *  本模块只放**纯解析**（可单测）；Blob/URL 的创建留在调用方（Node 单测环境无
 *  `URL.createObjectURL` ✗）。
 *--------------------------------------------------------------------------------------------*/

/**
 * 解析 data URL → mime + 字节。非法/损坏输入返回 `null`（调用方回退原 URL）。
 *
 * 支持 `data:<mime>;base64,<payload>` 与百分号编码形态（后者极少见，但 Canvas 导出可能产生）。
 */
export function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
	if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) { return null; }
	const comma = dataUrl.indexOf(',');
	if (comma < 0) { return null; }
	const header = dataUrl.slice(5, comma);          // 去掉 'data:'
	const payload = dataUrl.slice(comma + 1);
	const isBase64 = /;base64$/i.test(header);
	const mime = header.replace(/;base64$/i, '') || 'application/octet-stream';
	try {
		if (isBase64) {
			const bin = atob(payload);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
			return { mime, bytes };
		}
		const decoded = decodeURIComponent(payload);
		const bytes = new Uint8Array(decoded.length);
		for (let i = 0; i < decoded.length; i++) { bytes[i] = decoded.charCodeAt(i); }
		return { mime, bytes };
	} catch {
		return null;   // base64 损坏 / 百分号编码非法
	}
}
