/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `toolCallUtils.safeStringifyToolResult` —— **统一脱敏出口**回归（2026-09-13）。
 *
 * 本函数是每个工具结果转文本的通用序列化器（`agentTurnExecutor` / `agentOSService`
 * 共 21 处调用），所以把脱敏放在这里能兜住**工具层管不到**的内容：
 * MCP 工具输出（server 侧内容无法在工具层判断）、`read_lints`、以及未来任何
 * 回显文件内容的工具。
 *
 * 两条硬约束（本文件锁定）：
 *   ① 含凭据时必须遮蔽；
 *   ② 输出必须**仍是合法 JSON** —— 脱敏发生在 `JSON.stringify` **之后**，掩码绝不能
 *      吞掉结构字符。这正是赋值形态 B 取 `(?:\\.|[^\s"'])+` 而非 `\S+` 的原因
 *      （`\S+` 会把闭引号一起吃掉：`{"TOKEN":"abc"}` → `{"TOKEN=<redacted>}` 直接坏掉）。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { safeStringifyToolResult, MAX_TOOL_RESULT_CHARS, coerceArgsToSchema } from '../../browser/toolCallUtils.js';
import { redactSecrets } from '../../common/redactSecrets.js';

suite('toolCallUtils — safeStringifyToolResult 统一脱敏出口', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★★ 工具结果里的凭据必须被遮蔽（工具层管不到的路径）', () => {
		// 模拟 MCP 工具 / read_lints 这类「工具层不主动脱敏」的输出
		const out = safeStringifyToolResult({ content: 'token=ghp_1234567890abcdefghij done' });
		assert.ok(!out.includes('ghp_1234567890abcdefghij'), out);
		assert.ok(out.includes('<redacted:GitHub>'), out);
	});

	test('★★ 输出必须仍是合法 JSON（掩码不得吞结构字符）', () => {
		const out = safeStringifyToolResult({
			TOKEN: 'abc123', nested: { PASSWORD: 'hunter2' }, plain: 'ok',
		});
		const parsed = JSON.parse(out); // 抛异常即失败
		assert.ok(!out.includes('abc123'), out);
		assert.ok(!out.includes('hunter2'), out);
		assert.strictEqual(parsed.plain, 'ok');
		assert.strictEqual(typeof parsed.TOKEN, 'string');
		assert.strictEqual(typeof parsed.nested.PASSWORD, 'string');
	});

	test('★ JSON 里嵌配置行（转义引号）：值必须整体遮蔽且 JSON 仍合法', () => {
		const out = safeStringifyToolResult({ note: 'MY_API_TOKEN="s3cretvalue"' });
		assert.ok(!out.includes('s3cretvalue'), out);
		assert.doesNotThrow(() => JSON.parse(out));
	});

	test('★ 控制组：普通工具结果逐字不变（不得误伤）', () => {
		const payload = { content: 'compiled 42 files in 1.2s', path: 'src/a.ts' };
		assert.strictEqual(safeStringifyToolResult(payload), JSON.stringify(payload));
	});

	test('★ 幂等：已脱敏内容再序列化一遍不改变掩码', () => {
		const once = safeStringifyToolResult({ content: 'id AKIAIOSFODNN7EXAMPLE' });
		assert.ok(once.includes('<redacted:AWS>'), once);
		const twice = safeStringifyToolResult({ content: once });
		assert.ok(twice.includes('<redacted:AWS>'), twice);
		assert.ok(!twice.includes('AKIAIOSFODNN7EXAMPLE'), twice);
	});

	test('★ 脱敏不绕过最终字符上限（先脱敏再截断）', () => {
		const huge = safeStringifyToolResult({ content: 'x'.repeat(MAX_TOOL_RESULT_CHARS + 5000) });
		assert.ok(huge.length <= MAX_TOOL_RESULT_CHARS + 200, `实际长度 ${huge.length}`);
	});

	/**
	 * ★★ 引号**不得重复**（2026-09-13 修，探针实测发现的旧缺陷）。
	 *
	 * 旧实现只吃「裸值」，而 replacer 会把**开引号**重新吐一遍 —— 闭引号仍在原文里
	 * → 结果多一个引号：`password: "hunter2"` → `password: "<redacted>""`。
	 * 纯文本下只是难看，**JSON 下就是结构损坏**（`{"TOKEN":"abc"}` 无法解析）。
	 * 修法：值文法把定界符纳入值，替换时原样保留（见 `common/redactSecrets.ts` 的 `_VALUE`）。
	 */
	test('★★ 引号值：保留定界符，不得多出引号', () => {
		assert.strictEqual(redactSecrets('password: "hunter2"'), 'password: "<redacted>"');
		assert.strictEqual(redactSecrets('{"TOKEN":"abc123"}'), '{"TOKEN":"<redacted>"}');
		assert.strictEqual(redactSecrets('password: "my secret pass"'), 'password: "<redacted>"');
	});

	/**
	 * ★★ JSON **带引号 key** 也必须命中（2026-09-13 修）。
	 *
	 * `"TOKEN":"x"` 里关键词后紧跟 `"`，旧结构的 `\s*[:=]\s*` 匹配不上 `":"`
	 * → **整条赋值规则对 JSON 完全失效** ⇒ 咽喉点会形同虚设。
	 */
	test('★★ JSON 带引号 key 必须命中（否则咽喉点形同虚设）', () => {
		assert.strictEqual(redactSecrets('{"TOKEN":"abc123"}'), '{"TOKEN":"<redacted>"}');
		assert.strictEqual(redactSecrets('{"PASSWORD":"x"}'), '{"PASSWORD":"<redacted>"}');
	});

	test('★ Authorization 方案词保留、凭据遮蔽', () => {
		assert.strictEqual(redactSecrets('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic <redacted>');
		// 已掩码内容幂等（不丢标签）
		assert.strictEqual(redactSecrets('Authorization: <redacted:Bearer>'), 'Authorization: <redacted:Bearer>');
	});

	test('★★★ 哨兵残片污染的键名 ⇒ 截断抢救（真机：unreal_find_asset 400 三连）', () => {
		// 真机（日志 1790077760068）：流式组帧把参数分隔哨兵漏进键名 ——
		//   `name_contains</arg_value:6124c78e><arg_key:6124c78e>name`
		// 顶层出现 schema 不认识的怪键 ⇒ 真参数被丢弃 ⇒ 桥端 400。
		// 修法：键名在首个哨兵残片处截断；截断后合法且不冲突 ⇒ 抢救（值保留 ✓）。
		const schema = {
			type: 'object',
			properties: {
				name_contains: { type: 'string' },
				max_results: { type: 'integer' },
			},
		};
		const r = coerceArgsToSchema(
			{ 'name_contains</arg_value:6124c78e><arg_key:6124c78e>name': 'Cube', max_results: 5 },
			schema,
		);
		assert.strictEqual(r.args['name_contains'], 'Cube', '污染键名必须截断抢救出真参数 ✗✓');
		assert.strictEqual(r.args['max_results'], 5, '正常参数不受影响 ✓');
		assert.ok(!Object.keys(r.args).some(k => k.includes('arg_value')), '哨兵残片不得留在键名里 ✗✓');
		assert.ok(r.warnings.some(w => w.includes('salvaged argument "name_contains"')),
			`必须留下抢救告警（实际 ${JSON.stringify(r.warnings)} ✗）`);
	});

	test('★★ 哨兵污染的键截断后与已有键冲突 ⇒ 丢弃怪键（不覆盖正确值 ✓）', () => {
		const schema = { type: 'object', properties: { name: { type: 'string' } } };
		const r = coerceArgsToSchema(
			{ name: 'right', 'name</arg_key:abc>': 'wrong' },
			schema,
		);
		assert.strictEqual(r.args['name'], 'right', '已有正确键 ⇒ 不得被抢救覆盖 ✗✓');
		assert.ok(r.warnings.some(w => w.includes('dropped argument with sentinel-tainted key')),
			'冲突的污染键必须丢弃并告警 ✓');
	});
});
