/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `saros-media://<assetId>` 短引用的**提取与替换** —— 纯函数 ✓ 零 DOM/IO ✓（可单测 ✓）。
 *
 * 背景：图片生成工具（`image_generate`）为避免 base64 进 LLM 上下文，结果里只放媒体库
 * 短引用（`imageGenTools.ts` ✓）；UI 需要真实 data URL 才能渲染 <img>。
 * 本模块只负责「文本 ↔ 引用」的**纯变换**；取 URL 的 IO（mediaBackend.getAsDataUrl）
 * 由调用方注入 ✓（本模块不感知后端 ✓）。
 *
 * ⚠ 只改 UI 显示，**不改落盘历史**（历史里仍是短引用 ✓ 语义不变 ✓）。
 */

export const SAROS_MEDIA_SCHEME = 'saros-media://';

const SAROS_MEDIA_REF_RE = /saros-media:\/\/([A-Za-z0-9_-]+)/g;

/** 提取文本里的全部 assetId（**去重** ✓ 保持首次出现顺序 ✓ 无引用 ⇒ 空数组 ✓）。 */
export function extractSarosMediaIds(text: string): string[] {
	if (!text.includes(SAROS_MEDIA_SCHEME)) { return []; }
	const seen = new Set<string>();
	for (const m of text.matchAll(SAROS_MEDIA_REF_RE)) {
		seen.add(m[1]);
	}
	return [...seen];
}

/**
 * 把文本里的短引用替换为 data URL。
 * @param urlById id → data URL 映射（**缺失的 id 保留短引用** ✓ 解析失败不丢信息 ✓）
 * @returns `resolved` = 实际替换掉的 id 数（供日志/判空 ✓）
 */
export function replaceSarosMediaRefs(
	text: string,
	urlById: ReadonlyMap<string, string>,
): { text: string; resolved: number } {
	const ids = extractSarosMediaIds(text);
	if (ids.length === 0) { return { text, resolved: 0 }; }
	let replaced = text;
	let resolved = 0;
	for (const id of ids) {
		const url = urlById.get(id);
		if (!url) { continue; }
		replaced = replaced.split(`${SAROS_MEDIA_SCHEME}${id}`).join(url);
		resolved++;
	}
	return { text: replaced, resolved };
}
