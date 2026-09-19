/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「消息气泡复制 → 粘贴回输入框」的**剪贴板格式契约**（2026-09-19）。
 *
 * ── 用户报告 ──────────────────────────────────────────────────────────
 * 「用户发送的气泡 UI 中，点击复制后，再粘贴消息到输入框中，其中的图片等 pill 丢失」✗
 *
 * ── 根因 ──────────────────────────────────────────────────────────────
 * 输入框**本来就有**一套富剪贴板机制 ✓：复制/剪切带 chip 的内容时写
 * `COMPOSER_CLIPBOARD_MIME`（`application/vnd.vssaros-composer`）+ 纯文本 ✓，
 * 粘贴时优先读它并 `_restoreComposerPaste()` 重建 chip（图片/技能/工作流 ✓）。
 * 但**消息气泡的复制按钮只写 `text/plain`** ✗ ⇒ 粘贴回来自然只剩文字、pill 全丢 ✓。
 *
 * ── 修法 ──────────────────────────────────────────────────────────────
 * 气泡复制改为调用 `buildComposerClipboardFromMessage()`（composer 侧导出的**同一格式** ✓）
 * ⇒ 粘贴侧**零改动**即可恢复 pill ✓✓。
 *
 * ── 本文件锁什么 ───────────────────────────────────────────────────────
 * 这条链路两端相隔两个模块、**格式一旦漂移不会报错、只会静默退化**（pill 又丢 ✗）⇒ 必须钉住：
 *   ① `v: 1` + `segments` 的结构 ✓；② 附件段必须带 `name`/`mimeType`/`data`（粘贴侧靠它们重建 ✓，
 *   少了 `name`/`mimeType` 会被直接跳过 ✗，少了 `data` 则"pill 在、内容空" ✗✗）；
 *   ③ 文本段在前、附件段在后 ✓；④ 无附件时不该出现附件段 ✓。
 *
 * 运行：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/browser/agentChat/agentChatPanel.composerClipboard.test.ts
 */

import * as assert from 'assert';
// ⚠ 从**轻量模块**导入（不要从 `agentChatPanel.composer.js` 导入 ✗ —— 那会拖进整个面板模块链，
//   单测就会因 `window is not defined` 而必须依赖 jsdom ✓）
import { buildComposerClipboardFromMessage, COMPOSER_CLIPBOARD_MIME } from './agentChatPanel.composerClipboard.js';

/** 造一个与真实附件同形的对象（字段见 `IChatAttachment` ✓）。 */
function att(over: Partial<{ id: string; type: 'image' | 'file' | 'folder'; name: string; mimeType: string; data: string; size: number; filePath: string; kind: 'snippet' | 'log' }> = {}) {
	return {
		id: over.id ?? 'att-1',
		type: over.type ?? ('image' as const),
		name: over.name ?? 'shot.png',
		mimeType: over.mimeType ?? 'image/png',
		data: over.data ?? 'BASE64DATA',
		size: over.size ?? 123,
		filePath: over.filePath,
		// ★ 2026-09-19：文本片段种类（可选 ✓；`undefined` 表示普通附件 ✓）
		kind: over.kind,
	};
}

/** 解析载荷（顺带断言基本结构 ✓）。 */
function parse(json: string): { v: number; segments: Array<Record<string, unknown>> } {
	const o = JSON.parse(json) as { v?: number; segments?: Array<Record<string, unknown>> };
	assert.strictEqual(o.v, 1, '必须带版本号 v:1（粘贴侧按它判断 ✓）');
	assert.ok(Array.isArray(o.segments) && o.segments.length > 0, 'segments 必须非空 ✓');
	return { v: 1, segments: o.segments };
}

suite('消息气泡复制 → 输入框粘贴 的格式契约（2026-09-19）', () => {

	test('★★★ MIME 必须是 composer 认识的那个（否则粘贴侧读不到，pill 必丢）', () => {
		const p = buildComposerClipboardFromMessage('hi', [att()]);
		assert.strictEqual(p.mime, COMPOSER_CLIPBOARD_MIME);
		assert.strictEqual(p.mime, 'application/vnd.vssaros-composer');
	});

	test('★★★ 文本 + 图片附件：文本段在前、附件段在后，且字段足以让粘贴侧重建', () => {
		const p = buildComposerClipboardFromMessage('看看这张图', [att()]);
		const { segments } = parse(p.json);
		assert.strictEqual(segments[0].type, 'text');
		assert.strictEqual(segments[0].text, '看看这张图');
		const a = segments[1];
		assert.strictEqual(a.type, 'attachment');
		// ⚠ 这三项是"能不能重建"的关键：`name`/`mimeType` 缺失 ⇒ 粘贴侧直接跳过 ✗；
		//   `data` 缺失 ⇒ pill 在但**内容空** ✗✗（正是用户报的"图片丢失"）
		assert.strictEqual(a.name, 'shot.png');
		assert.strictEqual(a.mimeType, 'image/png');
		assert.strictEqual(a.data, 'BASE64DATA', '附件内容必须原样带上，否则粘贴回来是空 pill ✗');
		assert.strictEqual(a.attType, 'image');
		assert.strictEqual(a.size, 123);
	});

	test('★★★ 多附件（图片 + 代码片段）：数量与顺序保持不变', () => {
		const p = buildComposerClipboardFromMessage('两条', [
			att({ id: 'a1', name: 'shot.png', mimeType: 'image/png' }),
			att({ id: 'a2', name: 'code-snippet.txt', mimeType: 'text/plain', data: 'const a = 1;', type: 'file' }),
		]);
		const { segments } = parse(p.json);
		assert.strictEqual(segments.length, 3, '1 文本 + 2 附件');
		assert.deepStrictEqual(segments.map(s => s.type), ['text', 'attachment', 'attachment']);
		assert.strictEqual(segments[1].name, 'shot.png');
		assert.strictEqual(segments[2].name, 'code-snippet.txt');
		assert.strictEqual(segments[2].attType, 'file');
		assert.strictEqual(segments[2].data, 'const a = 1;');
	});

	test('★★ 纯附件（无文本）：不得产生空文本段（粘贴侧会插入多余空白 ✗）', () => {
		const p = buildComposerClipboardFromMessage('', [att()]);
		const { segments } = parse(p.json);
		assert.strictEqual(segments.length, 1);
		assert.strictEqual(segments[0].type, 'attachment');
	});

	test('★★ 无附件：只有文本段（调用方只在有附件时才走富剪贴板 ✓，此处锁住边界）', () => {
		const p = buildComposerClipboardFromMessage('只有文字', []);
		const { segments } = parse(p.json);
		assert.strictEqual(segments.length, 1);
		assert.strictEqual(segments[0].type, 'text');
		// 纯文本也应该给调用方一份（外部程序粘贴时至少拿到文字 ✓）
		assert.strictEqual(p.text, '只有文字');
	});

	test('★★★ 代码片段必须带上 kind（否则粘贴回来退化成普通文件 chip ✗）', () => {
		const p = buildComposerClipboardFromMessage('看这段', [
			att({ type: 'file', name: 'code-snippet.txt', mimeType: 'text/plain', data: 'const a = 1;', kind: 'snippet' }),
		]);
		const a = parse(p.json).segments[1];
		assert.strictEqual(a.kind, 'snippet', 'kind 必须随附件一起过剪贴板 ✗（丢了就显示成 code-snippet.txt ✗）');
		assert.strictEqual(a.attType, 'file');
		assert.strictEqual(a.data, 'const a = 1;', '内容始终不能丢 ✓（这是比 kind 更重要的底线）');
	});

	test('★★★ 日志片段同理（kind=log），普通附件则不带 kind（undefined）', () => {
		const logSeg = parse(buildComposerClipboardFromMessage('', [
			att({ type: 'file', name: 'log-snippet.txt', mimeType: 'text/plain', data: 'ERROR x', kind: 'log' }),
		]).json).segments[0];
		assert.strictEqual(logSeg.kind, 'log');

		const plainSeg = parse(buildComposerClipboardFromMessage('', [att()]).json).segments[0];
		assert.strictEqual(plainSeg.kind, undefined, '普通图片/文件不该被标成片段 ✓');
	});
});
