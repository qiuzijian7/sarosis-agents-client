// @vssaros/dsh-agents — IM 图片的共用判定（2026-10-27）
//
// 为什么抽出来：Telegram 与 Discord 各自要判"这个 mime 能不能作为 prompt 的 image part"。
// 两处各写一份的后果是**漂移** —— 一边放行 webp、一边拒绝，同一个用户在不同渠道体验不一致。
// 抽成一处后，渠道适配器只负责"拿到字节"，判定标准只有这里一份。

/**
 * 只放行两种图片类型（LLM 侧最通用的两种）。
 *
 * ⚠ 其它（webp / gif / heic…）一律拒绝而不是"随便标一个"：
 *   标错 mediaType 比丢掉更糟 —— 上游会按错误格式去解码，得到的是一堆乱码或直接崩。
 *
 * @returns `'image/jpeg'` | `'image/png'` | `''`（空串 = 不支持）
 */
export function imageMediaTypeOf(mime) {
	const m = String(mime ?? '').trim().toLowerCase();
	if (m === 'image/jpeg' || m === 'image/jpg') { return 'image/jpeg'; }
	if (m === 'image/png') { return 'image/png'; }
	return '';
}

/** 单张图片上限：5MB（再大 prompt 装不下，且 IM 用户随手发的大图很常见）。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 单条消息最多带几张：2 张（与 `bindings.js` 派发侧的 `slice(0, 2)` 必须一致）。 */
export const MAX_IMAGES = 2;

/**
 * 出站发图用的 `multipart/form-data` 构造（2026-10-27）。
 *
 * 为什么手写而不引 FormData：Node 18+ 有 `FormData`/`Blob`，但 `fetch` 传 FormData 时
 * **boundary 由运行时生成、我们拿不到**，单测里就无法断言请求体形状。
 * 手写一个（只支持"若干文本字段 + 一个文件"）既够用，也能在单测里逐字节验证。
 *
 * @param fields 文本字段（`undefined`/`null` 会被跳过）
 * @param file   `{ field, filename, mimeType, buffer }`；不给就是纯文本表单
 */
export function buildMultipartFormData(fields, file) {
	const boundary = '----vssaros' + Math.random().toString(36).slice(2) + Date.now().toString(36);
	const chunks = [];
	for (const [k, v] of Object.entries(fields || {})) {
		if (v === undefined || v === null) { continue; }
		chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`, 'utf8'));
	}
	if (file && file.buffer) {
		chunks.push(Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
			+ `Content-Type: ${file.mimeType}\r\n\r\n`,
			'utf8',
		));
		chunks.push(file.buffer);
		chunks.push(Buffer.from('\r\n', 'utf8'));
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 图片扩展名（发图时的 filename 用它，避免被判成未知类型）。 */
export function imageExtensionOf(mediaType) {
	return String(mediaType) === 'image/png' ? 'png' : 'jpg';
}

/**
 * 从内容类型或文件名推断图片类型。
 *
 * 有些渠道不给 `content_type`（Discord 偶尔为空），只能看扩展名。
 * 推断不出来就返回空串 —— 宁可跳过，也不猜一个类型。
 */
export function imageMediaTypeOfFile(mime, fileName) {
	const raw = String(mime ?? '').trim().toLowerCase();
	const byMime = imageMediaTypeOf(raw);
	if (byMime) { return byMime; }
	/* ⚠ mime **明确给了**、且确实是图片类型但不受支持（image/webp / image/gif / image/heic）⇒ 直接拒。
	   不要退回扩展名 —— 那会把"webp 存成 .png"这种不一致误判成 png（我第一版就写错了，
	   被单测里那条 `imageMediaTypeOfFile('image/webp', 'a.png')` 当场抓住）。
	   只有 mime **没给或不是 image/*** 时，才退回看扩展名。 */
	if (raw.startsWith('image/')) { return ''; }
	const name = String(fileName ?? '').toLowerCase();
	if (name.endsWith('.jpg') || name.endsWith('.jpeg')) { return 'image/jpeg'; }
	if (name.endsWith('.png')) { return 'image/png'; }
	return '';
}
