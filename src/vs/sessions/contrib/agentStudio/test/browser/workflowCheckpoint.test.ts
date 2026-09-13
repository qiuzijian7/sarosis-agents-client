/*---------------------------------------------------------------------------------------------
 *  工作流断点（checkpoint）存取契约 + 崩溃一致性判定 测试。
 *
 *  背景：`_saveCheckpoint()` 一直在写盘，但**没有任何 load 通路** —— 「只写不读」使断点
 *  续跑不可用，且存取两侧**没有共享契约**（写入格式内联在服务里，改字段无提示）。
 *
 *  本文件钉住三件事：
 *    A. `buildWorkflowCheckpoint` —— 写出格式（与读入成对，round-trip 必须无损）
 *    B. `parseWorkflowCheckpoint` —— 读入校验（磁盘内容不可信：手改 / 旧版 / 半截写）
 *    C. ★`planWorkflowResume` —— 崩溃一致性：**绝不把崩溃时 running 的节点当成功**
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	buildWorkflowCheckpoint,
	parseWorkflowCheckpoint,
	planWorkflowResume,
	type IWorkflowCheckpoint,
} from '../../common/workflowCheckpoint.js';

/** 构造一个已校验的 checkpoint（供 plan 测试直接用）。 */
function checkpointOf(nodeStates: Record<string, { status: string; output?: string | null }>): IWorkflowCheckpoint {
	return {
		executionId: 'exec-1',
		workflowId: 'wf-1',
		nodeStates: Object.fromEntries(
			Object.entries(nodeStates).map(([id, s]) => [id, { status: s.status, output: s.output ?? null }]),
		),
	};
}

suite('工作流断点 / 写出契约（buildWorkflowCheckpoint）', () => {

	test('节点状态归一：缺省字段写为 null（磁盘格式稳定，读入侧不必猜）', () => {
		const cp = buildWorkflowCheckpoint({
			executionId: 'e1',
			workflowId: 'w1',
			status: 'running',
			nodeStates: [['n1', { status: 'completed', output: 'hello' }]],
			timestamp: '2026-09-11T00:00:00.000Z',
		});
		assert.deepStrictEqual(cp.nodeStates.n1, {
			status: 'completed', output: 'hello', error: null, startTime: null, endTime: null,
		});
		assert.strictEqual(cp.executionId, 'e1');
		assert.strictEqual(cp.workflowId, 'w1');
		assert.strictEqual(cp.status, 'running');
		assert.strictEqual(cp.timestamp, '2026-09-11T00:00:00.000Z');
	});

	test('context 值逐键 JSON 序列化（对象 → JSON 串）', () => {
		const cp = buildWorkflowCheckpoint({
			executionId: 'e1', workflowId: 'w1', nodeStates: [],
			context: { s: 'plain', o: { a: 1 }, n: 42 },
		});
		assert.strictEqual(cp.context?.s, '"plain"');
		assert.strictEqual(cp.context?.o, '{"a":1}');
		assert.strictEqual(cp.context?.n, '42');
	});

	test('context 含循环引用也不炸（退化为 String，不能因序列化失败丢整个断点）', () => {
		const circular: Record<string, unknown> = { name: 'x' };
		circular.self = circular;
		const cp = buildWorkflowCheckpoint({
			executionId: 'e1', workflowId: 'w1', nodeStates: [], context: { circular },
		});
		assert.strictEqual(typeof cp.context?.circular, 'string');
	});

	test('sharedMemory 转成可 JSON 化的二元组数组', () => {
		const cp = buildWorkflowCheckpoint({
			executionId: 'e1', workflowId: 'w1', nodeStates: [],
			sharedMemory: [['k1', 'v1'], ['k2', 'v2']],
		});
		assert.deepStrictEqual(cp.sharedMemory, [['k1', 'v1'], ['k2', 'v2']]);
	});

	test('timestamp 缺省时自动生成 ISO 串', () => {
		const cp = buildWorkflowCheckpoint({ executionId: 'e1', workflowId: 'w1', nodeStates: [] });
		assert.ok(cp.timestamp && !Number.isNaN(Date.parse(cp.timestamp)), cp.timestamp);
	});
});

suite('工作流断点 / 读入校验（parseWorkflowCheckpoint）', () => {

	test('★ round-trip：写出 → JSON → 读入 无损（save/load 同一契约）', () => {
		const built = buildWorkflowCheckpoint({
			executionId: 'e1',
			workflowId: 'w1',
			status: 'failed',
			timestamp: '2026-09-11T01:02:03.000Z',
			nodeStates: [
				['a', { status: 'completed', output: 'out-a', startTime: 't0', endTime: 't1' }],
				['b', { status: 'running' }],
				['c', { status: 'failed', error: 'boom' }],
			],
			context: { k: 'v' },
			sharedMemory: [['m', '1']],
		});
		const parsed = parseWorkflowCheckpoint(JSON.stringify(built));
		assert.strictEqual(parsed.ok, true);
		if (!parsed.ok) { return; }
		assert.deepStrictEqual(parsed.checkpoint, built);
	});

	test('JSON 语法错误 → ok:false 且带原因（不能抛异常炸掉恢复流程）', () => {
		const r = parseWorkflowCheckpoint('{ not json');
		assert.strictEqual(r.ok, false);
		if (r.ok) { return; }
		assert.ok(r.error.includes('JSON'), r.error);
	});

	test('非对象 / 数组 / null → ok:false', () => {
		for (const raw of ['[]', '"str"', 'null', '42']) {
			assert.strictEqual(parseWorkflowCheckpoint(raw).ok, false, raw);
		}
	});

	test('结构性字段缺失 → ok:false（executionId / workflowId / nodeStates）', () => {
		const base = { executionId: 'e', workflowId: 'w', nodeStates: {} };
		const cases: Array<Record<string, unknown>> = [
			{ ...base, executionId: undefined },
			{ ...base, workflowId: undefined },
			{ ...base, nodeStates: undefined },
			{ ...base, nodeStates: [] },
		];
		for (const c of cases) {
			assert.strictEqual(parseWorkflowCheckpoint(JSON.stringify(c)).ok, false, JSON.stringify(c));
		}
	});

	test('无 status 的节点条目被丢弃 → 该节点会被判为需重跑（保守）', () => {
		const r = parseWorkflowCheckpoint(JSON.stringify({
			executionId: 'e', workflowId: 'w',
			nodeStates: { a: { status: 'completed' }, b: { output: 'x' }, c: 'garbage' },
		}));
		assert.strictEqual(r.ok, true);
		if (!r.ok) { return; }
		assert.deepStrictEqual(Object.keys(r.checkpoint.nodeStates), ['a']);
	});

	test('缺 context / sharedMemory（旧版本或半截写）→ ok:true 且给空缺省', () => {
		const r = parseWorkflowCheckpoint(JSON.stringify({ executionId: 'e', workflowId: 'w', nodeStates: {} }));
		assert.strictEqual(r.ok, true);
		if (!r.ok) { return; }
		assert.deepStrictEqual(r.checkpoint.context, {});
		assert.deepStrictEqual(r.checkpoint.sharedMemory, []);
	});

	test('脏数据容错：context 非字符串值被丢弃、sharedMemory 非法项被跳过', () => {
		const r = parseWorkflowCheckpoint(JSON.stringify({
			executionId: 'e', workflowId: 'w', nodeStates: {},
			context: { ok: 'v', bad: 42, bad2: { a: 1 } },
			sharedMemory: [['k', 'v'], ['only-one'], [1, 2], 'nope'],
		}));
		assert.strictEqual(r.ok, true);
		if (!r.ok) { return; }
		assert.deepStrictEqual(r.checkpoint.context, { ok: 'v' });
		assert.deepStrictEqual(r.checkpoint.sharedMemory, [['k', 'v']]);
	});
});

suite('工作流断点 / ★崩溃一致性判定（planWorkflowResume）', () => {

	test('completed → 可复用，且带上 output（供下游 {{ref}} 取用）', () => {
		const plan = planWorkflowResume(checkpointOf({ a: { status: 'completed', output: 'A' } }), ['a']);
		assert.deepStrictEqual(plan.reusable, [{ nodeId: 'a', output: 'A' }]);
		assert.deepStrictEqual(plan.toRun, []);
	});

	test('completed 但无 output → 仍可复用（不算失败，下游取空）', () => {
		const plan = planWorkflowResume(checkpointOf({ a: { status: 'completed' } }), ['a']);
		assert.deepStrictEqual(plan.reusable, [{ nodeId: 'a' }]);
		assert.deepStrictEqual(plan.toRun, []);
	});

	test('★★ running → 必须重跑（崩溃时正在执行，副作用可能只做了一半，绝不能当成功）', () => {
		const plan = planWorkflowResume(checkpointOf({ a: { status: 'running' } }), ['a']);
		assert.deepStrictEqual(plan.toRun, ['a']);
		assert.strictEqual(plan.reasons.a, 'running');
		assert.deepStrictEqual(plan.reusable, []);
	});

	test('failed / cancelled / skipped / pending → 各自原因重跑', () => {
		const plan = planWorkflowResume(checkpointOf({
			f: { status: 'failed' }, c: { status: 'cancelled' }, s: { status: 'skipped' }, p: { status: 'pending' },
		}), ['f', 'c', 's', 'p']);
		assert.deepStrictEqual(plan.toRun, ['f', 'c', 's', 'p']);
		assert.deepStrictEqual(plan.reasons, { f: 'failed', c: 'cancelled', s: 'skipped', p: 'pending' });
	});

	test('未知状态 → 重跑（reason=unknown，保守）', () => {
		const plan = planWorkflowResume(checkpointOf({ a: { status: 'weird-state' } }), ['a']);
		assert.deepStrictEqual(plan.toRun, ['a']);
		assert.strictEqual(plan.reasons.a, 'unknown');
	});

	test('checkpoint 里不存在的节点（图在崩溃后被改过）→ 重跑且标记 added', () => {
		const plan = planWorkflowResume(checkpointOf({ a: { status: 'completed', output: 'A' } }), ['a', 'newNode']);
		assert.deepStrictEqual(plan.toRun, ['newNode']);
		assert.deepStrictEqual(plan.added, ['newNode']);
		assert.strictEqual(plan.reasons.newNode, 'pending');
	});

	test('★ 不变量：reusable 与 toRun 互斥，且并集 = 传入的全部节点', () => {
		const nodeIds = ['a', 'b', 'c', 'd', 'e'];
		const plan = planWorkflowResume(checkpointOf({
			a: { status: 'completed', output: 'A' },
			b: { status: 'running' },
			c: { status: 'failed' },
			// d 不在 checkpoint（图新增）
			e: { status: 'completed' },
		}), nodeIds);
		const reusableIds = plan.reusable.map(r => r.nodeId);
		assert.strictEqual(reusableIds.some(id => plan.toRun.includes(id)), false, '不得同时可复用又重跑');
		assert.deepStrictEqual([...reusableIds, ...plan.toRun].sort(), [...nodeIds].sort(), '并集必须覆盖全部节点');
	});

	test('toRun 保持传入的图顺序（确定性，便于日志/UI 对齐）', () => {
		const plan = planWorkflowResume(checkpointOf({ a: { status: 'failed' }, b: { status: 'running' } }), ['a', 'b']);
		assert.deepStrictEqual(plan.toRun, ['a', 'b']);
	});

	test('summary 反映可复用/重跑数量（含新增节点说明）', () => {
		const plan = planWorkflowResume(checkpointOf({ a: { status: 'completed' } }), ['a', 'b', 'c']);
		assert.ok(plan.summary.includes('可复用 1'), plan.summary);
		assert.ok(plan.summary.includes('需重跑 2'), plan.summary);
		assert.ok(plan.summary.includes('新增'), plan.summary);
	});

	test('空图 / 空 checkpoint → 空计划', () => {
		const plan = planWorkflowResume(checkpointOf({}), []);
		assert.deepStrictEqual(plan.reusable, []);
		assert.deepStrictEqual(plan.toRun, []);
	});
});
