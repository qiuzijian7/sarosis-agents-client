/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `SandboxGuard._rewritePathArgs` 纯函数契约测试。
 *
 * 该函数负责把工具参数里的路径值从「被沙箱拒绝的 requestedPath」改写成
 * 「用户点 UseSuggested 采纳的 suggestedPath」（agentSandboxGuard.ts:105-135）。
 *
 * 关键不变量（与 workspacePathResolver.ts:75-78 的实现约定一致）：
 *   - `requestedPath` 全程原样存放、未经归一化，因此匹配采用**严格相等**；
 *     这是设计自洽，不是缺陷。本测试把该语义显式锁死，防止有人"顺手"改成
 *     归一化比较而意外改写用户并未意图变更的路径字段。
 *   - 改写是**递归**的，覆盖 args 对象任意深度的字符串字段。
 *   - 输入是字符串（工具原始 arguments JSON）时，返回的是**重新序列化的 JSON 字符串**；
 *     输入已是对象时，返回对象（且不修改入参——深拷贝）。
 *   - 任何解析失败 / 非对象输入都必须原样返回，不得抛异常（guard 层不允许崩）。
 *
 * 运行方式（自仓库根）：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *     src/vs/sessions/contrib/agentStudio/test/browser/sandboxRewritePathArgs.test.ts
 */

import assert from 'assert';

import { SandboxGuard } from '../../browser/agentSandboxGuard.js';

const REQUESTED = 'C:\\__agent_test__\\secret\\a.ts';
const SUGGESTED = 'C:\\__agent_test__\\allowed\\a.ts';

function makeGuard(): SandboxGuard {
	// _rewritePathArgs 是纯函数，不触碰任何依赖；给出最小 deps 仅为构造实例。
	return new SandboxGuard({} as any);
}

suite('SandboxGuard._rewritePathArgs 路径改写契约', () => {

	test('严格相等匹配：值等于 requestedPath 的字段被改写为 suggestedPath', () => {
		const guard = makeGuard();
		const out = guard._rewritePathArgs(
			JSON.stringify({ path: REQUESTED, content: 'x' }),
			REQUESTED, SUGGESTED,
		) as string;

		const parsed = JSON.parse(out);
		assert.strictEqual(parsed.path, SUGGESTED, 'path 字段应被改写');
		assert.strictEqual(parsed.content, 'x', '非路径字段不得被动');
	});

	test('递归改写：嵌套对象任意深度的匹配字段都被改写', () => {
		const guard = makeGuard();
		const out = guard._rewritePathArgs(
			JSON.stringify({ outer: { inner: { file: REQUESTED } }, list: [{ p: REQUESTED }] }),
			REQUESTED, SUGGESTED,
		) as string;

		const parsed = JSON.parse(out);
		assert.strictEqual(parsed.outer.inner.file, SUGGESTED, '二级嵌套应被改写');
		assert.strictEqual(parsed.list[0].p, SUGGESTED, '数组元素内的字段应被改写');
	});

	test('非严格相等不匹配：大小写 / 尾随分隔符 / 相对形式均不改写', () => {
		const guard = makeGuard();
		const variants = [
			REQUESTED.toUpperCase(),
			REQUESTED + '\\',
			'./a.ts',
			'a.ts',
		];

		for (const variant of variants) {
			const out = guard._rewritePathArgs(
				JSON.stringify({ path: variant }), REQUESTED, SUGGESTED,
			) as string;
			assert.strictEqual(
				JSON.parse(out).path, variant,
				`非严格相等的路径不得被改写：${variant}`,
			);
		}
	});

	test('字符串输入返回重新序列化的 JSON 字符串', () => {
		const guard = makeGuard();
		const out = guard._rewritePathArgs(
			JSON.stringify({ path: REQUESTED }), REQUESTED, SUGGESTED,
		);

		assert.strictEqual(typeof out, 'string', '字符串入参应返回字符串');
		assert.strictEqual(JSON.parse(out as string).path, SUGGESTED);
	});

	test('对象输入就地深拷贝：返回对象且不修改入参', () => {
		const guard = makeGuard();
		const input = { path: REQUESTED };
		const out = guard._rewritePathArgs(input, REQUESTED, SUGGESTED) as Record<string, unknown>;

		assert.strictEqual(typeof out, 'object', '对象入参应返回对象');
		assert.strictEqual(out.path, SUGGESTED, '返回对象应已改写');
		assert.strictEqual(input.path, REQUESTED, '入参对象不得被就地修改');
	});

	test('非法 JSON / 非对象输入原样返回且不抛异常', () => {
		const guard = makeGuard();
		const badJson = '{ not json ';
		const nonObject = 42;

		assert.strictEqual(guard._rewritePathArgs(badJson, REQUESTED, SUGGESTED), badJson, '非法 JSON 应原样返回');
		assert.strictEqual(guard._rewritePathArgs(nonObject, REQUESTED, SUGGESTED), nonObject, '非对象应原样返回');
		assert.strictEqual(guard._rewritePathArgs(undefined, REQUESTED, SUGGESTED), undefined, 'undefined 应原样返回');
	});
});
