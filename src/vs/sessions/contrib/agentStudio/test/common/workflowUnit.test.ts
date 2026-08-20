/*---------------------------------------------------------------------------------------------
 *  WF-U 单元测试 — common/workflow 纯模块：
 *  types(meta 校验/错误分级) / schemaSubset / realm(materializeFromRealm)。
 *  对应实施计划 §2.3（U1/U2/U3/U4）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	WorkflowError, isFatalWorkflowError, validateWorkflowMeta,
} from '../../common/workflow/types.js';
import { assertObjectJsonSchema } from '../../common/workflow/schemaSubset.js';
import { MaterializeError, materializeFromRealm } from '../../common/workflow/realm.js';

suite('workflow — meta 校验 (U2)', () => {

	test('合法 meta 通过', () => {
		const m = validateWorkflowMeta({ name: 'audit-concurrency', description: '审计并发注解', phases: [{ title: '扫描' }, { title: '汇总', detail: 'd' }] });
		assert.strictEqual(m.name, 'audit-concurrency');
		assert.strictEqual(m.phases?.length, 2);
		assert.strictEqual(m.phases?.[1].detail, 'd');
	});

	test('缺 name/description → META_INVALID', () => {
		assert.throws(() => validateWorkflowMeta({ description: 'x' }), (e: unknown) => e instanceof WorkflowError && e.code === 'META_INVALID');
		assert.throws(() => validateWorkflowMeta({ name: 'a-b' }), (e: unknown) => e instanceof WorkflowError && e.code === 'META_INVALID');
	});

	test('name 非 kebab-case → META_INVALID', () => {
		assert.throws(() => validateWorkflowMeta({ name: 'Audit Concurrency', description: 'x' }), (e: unknown) => e.code === 'META_INVALID');
		assert.throws(() => validateWorkflowMeta({ name: '', description: 'x' }), (e: unknown) => e.code === 'META_INVALID');
	});

	test('phases 非法形态 → META_INVALID', () => {
		assert.throws(() => validateWorkflowMeta({ name: 'a', description: 'x', phases: 'nope' }), (e: unknown) => e.code === 'META_INVALID');
		assert.throws(() => validateWorkflowMeta({ name: 'a', description: 'x', phases: [{ no: 'title' }] }), (e: unknown) => e.code === 'META_INVALID');
	});
});

suite('workflow — schema 子集 (U2)', () => {

	test('合法子集通过（全关键词组合）', () => {
		assertObjectJsonSchema({
			type: 'object',
			properties: {
				title: { type: 'string', enum: ['a', 'b'] },
				n: { type: 'integer' },
				tags: { type: 'array', items: { type: 'string' } },
				kind: { const: 'findings' },
				alt: { oneOf: [{ type: 'string' }, { type: 'number' }] },
			},
			required: ['title'],
			additionalProperties: false,
		});
	});

	test('超集关键词 → UNSUPPORTED_SCHEMA', () => {
		assert.throws(() => assertObjectJsonSchema({ type: 'string', pattern: '^a' }), (e: unknown) => e instanceof WorkflowError && e.code === 'UNSUPPORTED_SCHEMA');
		assert.throws(() => assertObjectJsonSchema({ type: 'object', properties: { x: { type: 'number', minimum: 1 } } }), (e: unknown) => e.code === 'UNSUPPORTED_SCHEMA');
		assert.throws(() => assertObjectJsonSchema({ format: 'date' }), (e: unknown) => e.code === 'UNSUPPORTED_SCHEMA');
	});

	test('非对象根 / 非法 type → UNSUPPORTED_SCHEMA', () => {
		assert.throws(() => assertObjectJsonSchema([1]), (e: unknown) => e.code === 'UNSUPPORTED_SCHEMA');
		assert.throws(() => assertObjectJsonSchema({ type: 'magic' }), (e: unknown) => e.code === 'UNSUPPORTED_SCHEMA');
	});
});

suite('workflow — materializeFromRealm (U3)', () => {

	test('plain JSON 全通过且深拷贝（无引用共享）', () => {
		const input = { a: [1, { b: 'x' }], c: null, d: true, e: 0.5 };
		const out = materializeFromRealm(input, 'workflow result') as typeof input;
		assert.deepStrictEqual(out, input);
		assert.notStrictEqual(out.a, input.a, '数组不得共享引用');
		assert.notStrictEqual(out.a[1], input.a[1], '嵌套对象不得共享引用');
	});

	test('undefined → null（JSON 语义）', () => {
		assert.strictEqual(materializeFromRealm(undefined, 'r'), null);
	});

	test('拒绝函数（路径含字段名）', () => {
		assert.throws(() => materializeFromRealm({ f: () => 1 }, 'r'), (e: unknown) => {
			assert.ok(e instanceof MaterializeError);
			assert.ok((e as MaterializeError).path.includes('f'));
			return true;
		});
	});

	test('拒绝 symbol / bigint', () => {
		assert.throws(() => materializeFromRealm({ s: Symbol('x') }, 'r'), (e: unknown) => e instanceof MaterializeError);
		assert.throws(() => materializeFromRealm({ b: 1n }, 'r'), (e: unknown) => e instanceof MaterializeError);
	});

	test('拒绝循环引用', () => {
		const a: Record<string, unknown> = {};
		a.self = a;
		assert.throws(() => materializeFromRealm(a, 'r'), (e: unknown) => e instanceof MaterializeError && /circular/.test(e.message));
	});

	test('拒绝稀疏数组', () => {
		const sparse = new Array(3);
		sparse[0] = 1; sparse[2] = 3;
		assert.throws(() => materializeFromRealm(sparse, 'r'), (e: unknown) => e instanceof MaterializeError && /sparse/.test(e.message));
	});

	test('拒绝非有限数', () => {
		assert.throws(() => materializeFromRealm({ x: NaN }, 'r'), (e: unknown) => e instanceof MaterializeError);
		assert.throws(() => materializeFromRealm({ x: Infinity }, 'r'), (e: unknown) => e instanceof MaterializeError);
	});

	test('拒绝 Map/Set/Date/RegExp/类实例（带构造名）', () => {
		for (const v of [new Map(), new Set(), new Date(0), /re/, new (class Thing { })()]) {
			assert.throws(() => materializeFromRealm({ v }, 'r'), (e: unknown) => e instanceof MaterializeError);
		}
	});

	test('顶层合法标量返回（42 / "str"）', () => {
		assert.strictEqual(materializeFromRealm(42, 'r'), 42);
		assert.strictEqual(materializeFromRealm('str', 'r'), 'str');
	});
});

suite('workflow — 错误分级 (U4)', () => {

	test('WorkflowError 全码表 fatal 且带 [code] 前缀', () => {
		const codes = ['SCRIPT_PARSE', 'META_INVALID', 'INVALID_ARGUMENT', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_SCHEMA', 'AGENT_CAP', 'ITEM_CAP', 'AGENT_START', 'AGENT_RESULT', 'CANCELLED', 'RESULT_UNSERIALIZABLE'] as const;
		for (const code of codes) {
			const e = new WorkflowError('m', code);
			assert.ok(isFatalWorkflowError(e), code);
			assert.ok(e.message.startsWith(`[${code}]`), code);
		}
	});

	test('脚本伪造的普通对象不可通过 instanceof 判定（不可伪造）', () => {
		const forged = { isWF: true, wfCode: 'CANCELLED', message: 'fake' };
		assert.strictEqual(isFatalWorkflowError(forged), false);
		assert.strictEqual(isFatalWorkflowError(new Error('plain')), false);
	});
});
