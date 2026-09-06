/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { extractPartialFields } from '../../common/partialJson.js';

suite('partialJson — 工具参数流式预览（2026-09-06，doc/tool-args-streaming-preview-design.md 阶段 2）', () => {

	test('完整 JSON → 提取全部顶层标量字段，complete=true', () => {
		const r = extractPartialFields('{"path":"a/b.ts","limit":10,"deep":true}');
		assert.deepStrictEqual(r.fields, { path: 'a/b.ts', limit: '10', deep: 'true' });
		assert.strictEqual(r.truncated.size, 0);
		assert.strictEqual(r.complete, true);
	});

	test('完整 JSON 含嵌套 object/array → 嵌套字段跳过、其后字段保留', () => {
		const r = extractPartialFields('{"a":"1","b":{"c":2},"d":[1,2],"e":"4"}');
		assert.deepStrictEqual(r.fields, { a: '1', e: '4' });
		assert.strictEqual(r.complete, true);
	});

	test('截断于长字符串中间 → 补全闭合、值截断标记', () => {
		const long = 'x'.repeat(500);
		const r = extractPartialFields(`{"content":"${long}`);
		assert.strictEqual(r.fields.content, long.slice(0, 200));
		assert.ok(r.truncated.has('content'));
		assert.strictEqual(r.complete, false);
	});

	test('截断于短字符串中间 → 补全后值完整、无截断标记', () => {
		const r = extractPartialFields('{"path":"src/vs/ma');
		assert.strictEqual(r.fields.path, 'src/vs/ma');
		assert.strictEqual(r.truncated.size, 0);
	});

	test('截断于悬空反斜杠 → 丢弃转义符后闭合', () => {
		// 输入实际串: {"path":"line1\nline2\  （\n 为合法转义，尾部 \ 悬空 → 丢弃）
		const r = extractPartialFields('{"path":"line1\\nline2\\');
		assert.strictEqual(r.fields.path, 'line1\nline2');
	});

	test('值含转义引号 → 正确解析', () => {
		const r = extractPartialFields('{"command":"echo \\"hi');
		assert.strictEqual(r.fields.command, 'echo "hi');
	});

	test('字面反斜杠（\\\\）完整转义 → 正确解析', () => {
		const r = extractPartialFields('{"path":"a\\\\');
		assert.strictEqual(r.fields.path, 'a\\');
	});

	test('截断于嵌套对象值中 → 此前字段保留、嵌套不误报', () => {
		const r = extractPartialFields('{"path":"a.ts","opts":{"x":1');
		assert.strictEqual(r.fields.path, 'a.ts');
		assert.ok(!('opts' in r.fields));
	});

	test('截断处 Unicode 代理对裂开 → 回退一个 code unit', () => {
		const r = extractPartialFields('{"name":"\uD83D');
		assert.deepStrictEqual(r.fields, { name: '' });
	});

	test('完整代理对在值尾 → 不误丢', () => {
		const r = extractPartialFields('{"name":"中文😀');
		assert.strictEqual(r.fields.name, '中文😀');
	});

	test('file_write 典型形态：path 在头部、大 content 中途截断 → path 仍可提取', () => {
		const r = extractPartialFields('{"path":"src/a.ts","content":"line1\\nline2');
		assert.strictEqual(r.fields.path, 'src/a.ts');
		assert.strictEqual(r.fields.content, 'line1\nline2');
	});

	test('空串 / 非对象开头 / key 中途截断 → 空结果不抛错', () => {
		for (const s of ['', '   ', 'null', '[1,2', '"str', '{"path"', '{"unterminated']) {
			const r = extractPartialFields(s);
			assert.ok(r.fields && r.truncated instanceof Set && typeof r.complete === 'boolean');
		}
	});
});
