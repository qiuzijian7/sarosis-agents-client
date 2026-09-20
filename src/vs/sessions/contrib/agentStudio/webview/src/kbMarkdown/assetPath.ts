/* 图文显示：相对路径图片 → webview 可加载 URL 的纯函数（无 React 依赖，可单测）。
 *
 * 宿主（KbBlocksEditorPane）把「当前笔记所在目录」经 asWebviewUri 转成
 * assetBaseUri 注入 `__KB_INIT__`，并加入 webview localResourceRoots；
 * 本模块把笔记里的相对图片引用（`x.png` / `./img/x.png` / `../x.png`）
 * 归一并拼接到该前缀。http(s)/data/绝对路径原样返回（不干预）。
 */

import { isRelativeLocalHref } from './relativePath';

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
 * 解析图片 src：相对本地路径拼接 assetBaseUri；其余（http/https/data/blob/绝对路径）原样返回。
 * 路径段逐一 encodeURIComponent（中文目录名必须编码；assetBaseUri 本身已被 asWebviewUri 编码）。
 */
export function resolveAssetSrc(src: string | undefined, assetBaseUri: string | undefined): string | undefined {
	if (!src || !assetBaseUri || !isRelativeLocalHref(src)) { return src; }
	const clean = normalizeRelativeRef(src);
	if (!clean) { return src; }
	return `${assetBaseUri.replace(/\/+$/, '')}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}
