/*---------------------------------------------------------------------------------------------
 *  mediaCollect.ts — 生成图片自动收录（P1）的纯判定逻辑。
 *
 *  与 LiteGraphCanvas.collectAsset 解耦，便于单测：每次新产生的媒体 ref 是否应
 *  收录进媒体库、以什么 provider 标注、去重 key 是什么。
 *--------------------------------------------------------------------------------------------*/

export interface CollectMediaDecision {
	/** `${workflowId}:${ref}` 去重 key */
	readonly key: string;
	readonly provider: string;
}

/**
 * 判定一条媒体 ref 是否应自动收录：
 *  - 空 ref / blob:（会话级临时 URL）→ 不收录（null）
 *  - 同一 workflow + ref 已收录过 → 不收录（null，去重）
 *  - 否则返回去重 key 与 provider（http(s) URL = comfyui / 其余 = local）
 */
export function shouldCollectMedia(
	workflowId: string,
	ref: string,
	collected: ReadonlySet<string>,
): CollectMediaDecision | null {
	if (!ref || ref.startsWith('blob:')) { return null; }
	const key = `${workflowId}:${ref}`;
	if (collected.has(key)) { return null; }
	return { key, provider: /^https?:\/\//i.test(ref) ? 'comfyui' : 'local' };
}

/** 解析出的 data: URL 载荷。 */
export interface ParsedDataUrl {
	/** 纯 base64 载荷（不含 `data:...;base64,` 前缀） */
	readonly base64: string;
	readonly mime: string;
	/** 落盘扩展名（不含点） */
	readonly ext: string;
}

/** mime → 落盘扩展名。未列出的走 subtype 兜底。 */
const MIME_TO_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'image/avif': 'avif',
	'image/bmp': 'bmp',
	'image/svg+xml': 'svg',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
};

/**
 * 拆解 base64 形式的 data URL：`data:image/png;base64,iVBOR...`。
 *
 * 生成结果经 `materializeComfyImageRefs` 物化后就是这种自包含 data URL。把它
 * 拆成 base64 + ext 交给 host，`MediaStore.importAsset` 才会真正写文件到媒体库
 * （只传 `ref` 按契约是「仅索引不落盘」，会把几 MB base64 塞进 SQLite 的 ref 列
 * 且永远不产生文件）。
 *
 * 非 data URL / 非 base64 编码 / 空载荷 → null（调用方回退为 URL 引用）。
 */
export function parseDataUrl(ref: string): ParsedDataUrl | null {
	if (!ref || !ref.startsWith('data:')) { return null; }
	const comma = ref.indexOf(',');
	if (comma < 0) { return null; }
	// header = `image/png;base64`（也可能带 charset 等其它参数）
	const header = ref.slice('data:'.length, comma);
	if (!/;\s*base64\s*$/i.test(header)) { return null; }
	const base64 = ref.slice(comma + 1).trim();
	if (!base64) { return null; }
	const mime = header.replace(/;\s*base64\s*$/i, '').split(';')[0].trim().toLowerCase()
		|| 'application/octet-stream';
	const subtype = (mime.split('/')[1] ?? '').replace(/[^a-z0-9]/g, '');
	const ext = MIME_TO_EXT[mime] ?? (subtype || 'bin');
	return { base64, mime, ext };
}
