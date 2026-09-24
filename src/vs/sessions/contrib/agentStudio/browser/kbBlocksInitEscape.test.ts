/*---------------------------------------------------------------------------------------------
 *  kbBlocksInitEscape.test.ts — `escapeJsonForInlineScript`（内联 script JSON 转义）测试。
 *
 *  背景：2026-09-24 用户实测 —— 笔记正文含 `</script>`（演示内嵌 HTML 的 demo 文档）时，
 *  `window.__KB_INIT__ = <raw JSON>` 的内联 script 被 HTML 解析器提前截断 ⇒ 整篇渲染空白。
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/kbBlocksInitEscape.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { escapeJsonForInlineScript } from './kbBlocksEditorPane.js';

suite('escapeJsonForInlineScript（内联 script 的 JSON 转义）', () => {

	test('含 </script> 的 JSON ⇒ 转义后不再含 "</" 序列，且解析还原不变', () => {
		const data = { content: '演示 <script>alert(1)</script> 与 <!-- 注释 --> 与 <a href="x">链接</a>' };
		const raw = JSON.stringify(data);
		assert.ok(raw.includes('</script>'), '前提：原始 JSON 确实含 </script>');

		const escaped = escapeJsonForInlineScript(raw);
		assert.ok(!escaped.includes('</'), '转义后不存在 "</" ⇒ HTML 解析器不会提前截断');
		assert.ok(!escaped.includes('<!--'), 'HTML 注释起始序列也不存在');
		assert.deepStrictEqual(JSON.parse(escaped), data, '转义是合法 JSON 转义，解析后逐字节还原');
	});

	test('不含 < 的 JSON ⇒ 原样返回', () => {
		const raw = JSON.stringify({ content: '普通文本 123' });
		assert.strictEqual(escapeJsonForInlineScript(raw), raw);
	});

	test('模拟 HTML 嵌入：转义后的 script 块不被截断', () => {
		const payload = escapeJsonForInlineScript(JSON.stringify({ c: '</script><script>evil()' }));
		const html = `<script>window.X = ${payload};</script>`;
		// HTML 解析器只认字面 `</script>` —— 转义后整块 script 里不存在它
		assert.strictEqual(html.split('</script>').length, 2, '只有一个（真正的）结束标签');
	});
});
