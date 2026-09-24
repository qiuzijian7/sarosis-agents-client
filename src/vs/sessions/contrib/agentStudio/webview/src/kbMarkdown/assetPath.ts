/* 图文显示：相对路径图片 → webview 可加载 URL 的纯函数（无 React 依赖，可单测）。
 *
 * 宿主（KbBlocksEditorPane）把「当前笔记所在目录」经 asWebviewUri 转成
 * assetBaseUri 注入 `__KB_INIT__`，并加入 webview localResourceRoots；
 * 本模块把笔记里的相对图片引用（`x.png` / `./img/x.png` / `../x.png`）
 * 归一并拼接到该前缀。http(s)/data/绝对路径原样返回（不干预）。
 */

import { isRelativeLocalHref } from './relativePath';

/** 媒体库资产引用 scheme（`saros-media://<assetId>`）。 */
export const KB_MEDIA_SCHEME = 'saros-media://';

/** src 是否媒体库引用。 */
export function isMediaAssetSrc(src: string | undefined): boolean {
	return !!src && src.startsWith(KB_MEDIA_SCHEME);
}

/** 提取 `saros-media://<id>` 的 assetId（非该协议返回 undefined）。 */
export function mediaAssetId(src: string | undefined): string | undefined {
	if (!isMediaAssetSrc(src)) { return undefined; }
	const id = (src as string).slice(KB_MEDIA_SCHEME.length).split(/[?#]/)[0].trim();
	return id || undefined;
}

/** 归一化相对引用（去 `./`、处理 `../` 与重复分隔符）。 */
export function normalizeRelativeRef(src: string): string {
	const out: string[] = [];
	for (const seg of src.replace(/\\/g, '/').split('/')) {
		if (seg === '' || seg === '.') { continue; }
		if (seg === '..') { out.pop(); continue; }
		out.push(seg);
	}
	return out.join('/');
}

/**
 * 路径段编码（**幂等**）。
 *
 * ## 为什么必须幂等（2026-09-25，实测 404 定案）
 *
 * 进来的 `src` **可能已经是编码过的** —— react-markdown 对图片 `href` 会先走一遍 URL 变换。
 * 此前这里无条件 `encodeURIComponent` ⇒ 中文目录名被**编码两次**：
 *
 *   `assets/GPT五档欧卡画风流程/frame-04.png`
 *     → react-markdown 先编 → `assets/GPT%E4%BA%94…/frame-04.png`
 *     → 本函数再编 `%` → `assets/GPT%25E4%25BA%2594…/frame-04.png`  ✗
 *   浏览器实际请求的就是后者 ⇒ **404**（而文件明明存在，`库` 段是单次编码所以正常）。
 *
 * 修法：先 `decodeURIComponent` 再 `encodeURIComponent` ⇒ 不管进来是裸中文还是已编码，
 * 出去都恰好一次编码。`decode` 失败（段里含**非转义**的 `%`，如 `100%.png`）时退回直接编码 ——
 * 那种情况下直接编码是唯一安全选择（`decodeURIComponent` 会抛 URIError）。
 */
export function encodePathSegmentIdempotent(seg: string): string {
	try {
		return encodeURIComponent(decodeURIComponent(seg));
	} catch {
		return encodeURIComponent(seg);
	}
}

/**
 * 解析图片 src：相对本地路径拼接 assetBaseUri；其余（http/https/data/blob/绝对路径）原样返回。
 * 路径段逐一编码（见 `encodePathSegmentIdempotent`：**幂等**，防 react-markdown 先编一次导致双重编码）。
 */
export function resolveAssetSrc(src: string | undefined, assetBaseUri: string | undefined): string | undefined {
	if (!src || !assetBaseUri || !isRelativeLocalHref(src)) { return src; }
	const clean = normalizeRelativeRef(src);
	if (!clean) { return src; }
	return `${assetBaseUri.replace(/\/+$/, '')}/${clean.split('/').map(encodePathSegmentIdempotent).join('/')}`;
}
