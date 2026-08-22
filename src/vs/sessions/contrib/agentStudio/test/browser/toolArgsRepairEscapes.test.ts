/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * repairToolArguments 的非法转义修复回归（2026-08-21）。
 *
 * 背景：模型常把制表符写成 `\x09`（也见 `\d` / `\p` / `\uZZ`）。`JSON.parse`
 * 会以 "Bad escaped character" 整体失败，而修复链里原本没有任何一步处理转义
 * （截断自动闭合 / Python 风格替换都不涉及），于是整个参数对象降级为 `{}`。
 * BYOK OpenAI 流式路径的参数就是字符串，会真实走到这里。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	sanitizeJsonEscapes,
	repairToolArguments,
	coerceToolCallArguments,
	classifyArgumentValidity,
} from '../../browser/toolCallUtils.js';

suite('toolCallUtils — JSON 非法转义修复', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('前置断言：\\x09 确实让原生 JSON.parse 失败', () => {
		assert.throws(() => JSON.parse('{"content":"a\\x09b"}'));
	});

	test('repairToolArguments 修复 \\x09 并保留其余字段', () => {
		const got = repairToolArguments('{"path":"src/a.ts","content":"a\\x09b"}');
		assert.ok(got);
		assert.strictEqual(got!.path, 'src/a.ts');
		assert.strictEqual(got!.content, 'a\\x09b'); // 非法转义按字面保留
	});

	test('coerceToolCallArguments 不再把含 \\x09 的参数降级成 {}', () => {
		const got = coerceToolCallArguments('{"path":"a.ts","content":"x\\x09y"}');
		assert.strictEqual(got.path, 'a.ts');
	});

	test('截断 + 非法转义组合仍可修复（转义修复在自动闭合之前）', () => {
		const got = repairToolArguments('{"path":"a.ts","content":"x\\x09y');
		assert.ok(got);
		assert.strictEqual(got!.path, 'a.ts');
	});

	test('字符串内裸控制字符被规范转义', () => {
		const got = repairToolArguments('{"content":"a\tb"}');
		assert.ok(got);
		assert.strictEqual(got!.content, 'a\tb');
	});

	test('合法 JSON 行为不变（恒等 + 直通）', () => {
		const legal = '{"a":"x\\ty","b":"\\u4e2d"}';
		assert.strictEqual(sanitizeJsonEscapes(legal), legal);
		const got = repairToolArguments(legal);
		assert.deepStrictEqual(got, { a: 'x\ty', b: '中' });
	});

	test('Python 风格修复（单引号 / None / True）不被回退', () => {
		const got = repairToolArguments("{'a': None, 'b': True}");
		assert.deepStrictEqual(got, { a: null, b: true });
	});

	test('classifyArgumentValidity 把含非法转义的完整对象判为 repairable', () => {
		assert.strictEqual(classifyArgumentValidity('{"a":"x\\x09"}'), 'repairable');
		assert.strictEqual(classifyArgumentValidity('{"a":1}'), 'valid');
		assert.strictEqual(classifyArgumentValidity('   '), 'empty');
	});

	test('sanitizeJsonEscapes 只在字符串内生效（缩进换行不动）', () => {
		const pretty = '{\n\t"a": "b"\n}';
		assert.strictEqual(sanitizeJsonEscapes(pretty), pretty);
	});
});
