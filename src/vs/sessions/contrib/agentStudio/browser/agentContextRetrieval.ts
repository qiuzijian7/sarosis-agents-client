/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 消息 token 粗估（char/4，与 ContextManager._estimateTokens 同口径）。
 *
 * IDE 侧的记忆检索/外置/注入能力已于 2026-11-10 整体退役（记忆只在 dsh 侧）；
 * 本文件仅保留这个与记忆无关的通用估算函数。
 */

/**
 * 粗略估算消息输入 token（char/4，与 ContextManager._estimateTokens 口径一致）。
 */
export function estimateMessagesTokens(messages: ReadonlyArray<any>): number {
	const IMAGE_TOKEN_COST = 1500;
	let totalChars = 0;
	let imageTokens = 0;
	for (const m of messages) {
		if (!m) { continue; }
		const shadow: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
			if (k === 'contentParts' && Array.isArray(v)) {
				shadow[k] = v.map((p: any) => (p && p.type === 'image' ? { type: 'image', data: '[stripped]' } : p));
			} else {
				shadow[k] = v;
			}
		}
		if (Array.isArray(shadow.contentParts)) {
			imageTokens += shadow.contentParts.filter((p: any) => p?.type === 'image').length * IMAGE_TOKEN_COST;
		}
		try {
			totalChars += JSON.stringify(shadow).length;
		} catch {
			totalChars += (typeof m.content === 'string' ? m.content.length : 0);
		}
	}
	return Math.ceil(totalChars / 4) + imageTokens;
}
