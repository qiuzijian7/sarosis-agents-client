/**
 * 图字节的公共解析（宿主侧）：data URL / base64 → 字节 + 媒体类型。
 *
 * 为什么单独一个模块：`lib/index.js`（生图链路）与 `lib/studioApi.js`（页面导入图）
 *   都要把"外面给的 data URL"变成字节 ⇒ 抄第二遍就会漂（尤其媒体类型白名单）✗。
 */

/** dsh 的 attachment 只认这四种图片类型（`ImageMediaType`）。 */
export const ALLOWED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** provider 没给 MIME 时的兜底（绝大多数 provider 返 PNG）。 */
export const DEFAULT_MEDIA_TYPE = 'image/png';

/**
 * 把媒体类型收敛到 dsh 允许的四种。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeMediaType(value) {
	const raw = String(value ?? '').trim().toLowerCase();
	if (ALLOWED_MEDIA_TYPES.includes(raw)) {
		return raw;
	}
	// `image/jpg` 这类常见别名
	if (raw === 'image/jpg') {
		return 'image/jpeg';
	}
	return DEFAULT_MEDIA_TYPE;
}

/**
 * base64 → 字节（Node 自带 Buffer，不引依赖）。
 * @param {unknown} value
 * @returns {Uint8Array | undefined}
 */
export function decodeBase64(value) {
	const text = String(value ?? '').trim();
	if (!text) {
		return undefined;
	}
	// 容忍带 data URL 前缀的 base64
	const payload = text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text;
	try {
		return new Uint8Array(Buffer.from(payload, 'base64'));
	} catch {
		return undefined;
	}
}

/**
 * data URL → { bytes, mediaType }。
 *
 * ⚠ 认不出/不是 data URL ⇒ undefined（调用方要**明确报错**，别静默当空图）。
 * @param {unknown} value
 * @returns {{ bytes: Uint8Array, mediaType: string } | undefined}
 */
export function decodeDataUrl(value) {
	const text = String(value ?? '').trim();
	if (!text.startsWith('data:')) {
		return undefined;
	}
	const comma = text.indexOf(',');
	if (comma < 0) {
		return undefined;
	}
	const header = text.slice(5, comma);
	const payload = text.slice(comma + 1);
	let bytes;
	if (header.includes(';base64')) {
		bytes = decodeBase64(payload);
	} else {
		// 非 base64 的 data URL（百分号编码）—— 画布推上来的选区截图两种都出现过。
		try {
			bytes = new Uint8Array(new TextEncoder().encode(decodeURIComponent(payload)));
		} catch {
			bytes = undefined;
		}
	}
	if (!bytes || bytes.length === 0) {
		return undefined;
	}
	return { bytes, mediaType: normalizeMediaType(header.split(';')[0]) };
}
