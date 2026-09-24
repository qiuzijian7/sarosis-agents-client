/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 从 `image_generate` 的工具结果文本里提取**可渲染的图片 URL** —— 纯函数 ✓ 零 DOM ✓（可单测 ✓）。
 *
 * 两种形态（见 `_createImageGenResultCard` ✓）：
 *  ① `data:image/...;base64,...` —— pane 已把媒体库短引用（`saros-media://<id>`）解析成 data URL
 *     （仅 UI 显示 ✓ 落盘历史仍是短引用 ✓）；
 *  ② `http(s)://…` —— provider 直接返回的外链。
 *
 * ★ 2026-09-25（断点④修复 ✓）：http(s) URL **不再要求图片扩展名结尾** ✗ ——
 *   签名 URL / 无扩展名链接（如 `…/images/abc?sig=…`）此前匹配为空 ⇒ 图不显示 ✗。
 *   安全性由上下文保证：本结果文本由 `imageGenTools` 生成、受控 ✓（只列图片引用 ✓），
 *   且 `saros-media://` 短引用**不在** http 正则射程内（不会被误吞 ✓）。
 *   ⚠ CSP 不放行 `http:`（仅 https ✓ 见 mediaGalleryModel 注释）—— http 链接仍会匹配
 *   但渲染会被 CSP 拦（保持与旧行为一致 ✓ 不在这里裁剪 ✓）。
 */

const DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
// 不要求扩展名 ✓；排除空白/引号/括号/方括号/常见中文句读（防把后续文本吞进 URL ✗✓ 实测 `）。` 会被吞 ✗）
const HTTP_URL_RE = /https?:\/\/[^\s"')\]，。；）、]+/gi;

/** 提取全部图片 URL（**去重** ✓ 保持出现顺序 ✓ 无 ⇒ 空数组 ✓）。 */
export function extractImageGenResultUrls(resultText: string): string[] {
	if (!resultText) { return []; }
	const seen = new Set<string>();
	for (const re of [DATA_URL_RE, HTTP_URL_RE]) {
		re.lastIndex = 0; // 带 g 标志的正则必须重置 ✗（否则跨调用漏匹配 ✗✓）
		for (const m of resultText.matchAll(re)) {
			seen.add(m[0]);
		}
	}
	return [...seen];
}
