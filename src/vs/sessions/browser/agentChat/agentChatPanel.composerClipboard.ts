/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 输入框「富剪贴板」的**格式契约**（2026-09-19 抽成独立模块）。
 *
 * ── 为什么要独立一个文件 ────────────────────────────────────────────────
 * 这条格式有两端，而且**跨模块**：
 *   · 写端：composer 的复制/剪切（`_handleComposerCopyCut`）✓ 与**消息气泡的复制按钮** ✓；
 *   · 读端：composer 的粘贴（`_restoreComposerPaste`）✓。
 * 格式一旦漂移**不会报错，只会静默退化**（粘贴回来 pill 又丢 ✗）⇒ 需要一个**轻量**模块承载它，
 * 让两侧共用同一份定义 ✓，也让单测能**不依赖 DOM** 直接锁住它 ✓
 *（`agentChatPanel.composerClipboard.test.ts` ✓ —— 之前把它写在 `composer.ts` 里会导致单测
 *  被迫 import 整个面板模块链、进而需要 jsdom ✗）。
 *
 * ⚠ 只放**纯数据/纯函数**，不要 import 任何浏览器或面板模块 ✓（否则又变重 ✗）。
 */

import type { IChatAttachment } from './agentChatTypes.js';

/** 剪贴板自定义 MIME（写端 `setData` 与读端 `getData` 必须用同一个 ✓）。 */
export const COMPOSER_CLIPBOARD_MIME = 'application/vnd.vssaros-composer';

/**
 * ★ 2026-09-19：把「消息文本 + 附件」序列化为 composer 可识别的**富剪贴板**载荷 ✓。
 *
 * 背景（用户报告）：「用户发送的气泡 UI 中，点击复制后，再粘贴消息到输入框中，其中的图片等 pill 丢失」✗
 * 根因：输入框本就有富剪贴板机制 ✓，但**气泡的复制按钮只写了 `text/plain`** ✗
 * ⇒ 粘贴时读不到自定义 MIME，自然只剩文字 ✓。本函数让气泡复用**同一格式** ✓
 * ⇒ 粘贴侧（`_restoreComposerPaste`）**零改动**就能把 pill 全部重建 ✓✓。
 *
 * 载荷形状（与 composer 内部复制一致）：`{ v: 1, segments: [...] }` ✓，
 * 附件段的字段必须包含 `name` / `mimeType` / `data` ✓ ——
 * 少了前两个粘贴侧会**直接跳过** ✗，少了 `data` 则"pill 在但内容空" ✗✗。
 *
 * ⚠ 自定义 MIME **无法**用 `navigator.clipboard.writeText()` 写入 ✗ ⇒ 调用方需配合
 *   「临时 `copy` 事件 + `execCommand('copy')`」（与 composer 内部复制同一手法 ✓）。
 * ⚠ 刻意**不写** `attId`：那是"输入框内芯片 id"✓，消息里的附件没有对应芯片 ✓，
 *   粘贴侧本就会为新附件生成新 id ✓（写了反而可能指向不存在的芯片 ✗）。
 */
export function buildComposerClipboardFromMessage(
	text: string,
	attachments?: readonly IChatAttachment[],
): { mime: string; json: string; text: string } {
	const segments: Array<Record<string, unknown>> = [];
	if (text) { segments.push({ type: 'text', text }); }
	for (const a of attachments ?? []) {
		segments.push({
			type: 'attachment',
			name: a.name,
			mimeType: a.mimeType,
			data: a.data,
			size: a.size,
			attType: a.type,
			isPasted: a.isPasted,
			filePath: a.filePath,
			// ★ 2026-09-19 补：带上片段种类 ⇒ 粘贴回来仍是「代码片段 / 日志片段」✓
			// （漏了它 ⇒ chip 退化成普通文件（显示 `code-snippet.txt` ✗），内容不丢但语义丢了 ✓）
			kind: a.kind,
		});
	}
	return { mime: COMPOSER_CLIPBOARD_MIME, json: JSON.stringify({ v: 1, segments }), text };
}
