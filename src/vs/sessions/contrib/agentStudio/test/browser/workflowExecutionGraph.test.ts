/*---------------------------------------------------------------------------------------------
 *  Unit tests for executionGraph — pure workflow-wide graph analysis.
 *
 *  Covers computeExecutionOrder (Kahn), collectUpstreamNodeIds, and
 *  buildExecutionPlan (executable-node filtering + per-step upstreams).
 *  These are the building blocks of runGraphExecution and the planned
 *  parallel execution plan (docs/Agent-画布编排设计方案.md P1).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	computeExecutionOrder,
	collectUpstreamNodeIds,
	buildExecutionPlan,
	buildParallelExecutionPlan,
	splitLayerByWriters,
	type ExecutionNodeLike,
	type ExecutionEdgeLike,
} from '../../webview/src/features/workflowEditor/comfyHost/executionGraph.js';

suite('executionGraph', () => {

	suite('computeExecutionOrder', () => {

		test('empty graph → empty order, no cycle', () => {
			const r = computeExecutionOrder([], []);
			assert.deepStrictEqual(r.order, []);
			assert.strictEqual(r.hasCycle, false);
		});

		test('single node without edges', () => {
			const r = computeExecutionOrder([{ id: 'a' }], []);
			assert.deepStrictEqual(r.order, ['a']);
			assert.strictEqual(r.hasCycle, false);
		});

		test('linear chain A→B→C runs upstream first', () => {
			const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
			const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
			const r = computeExecutionOrder(nodes, edges);
			assert.deepStrictEqual(r.order, ['a', 'b', 'c']);
			assert.strictEqual(r.hasCycle, false);
		});

		test('diamond A→{B,C}→D keeps both branches before D', () => {
			const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
			const edges = [
				{ source: 'a', target: 'b' },
				{ source: 'a', target: 'c' },
				{ source: 'b', target: 'd' },
				{ source: 'c', target: 'd' },
			];
			const r = computeExecutionOrder(nodes, edges);
			assert.strictEqual(r.hasCycle, false);
			assert.deepStrictEqual(r.order, ['a', 'b', 'c', 'd']);
		});

		test('multiple roots all execute', () => {
			const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
			const edges = [
				{ source: 'a', target: 'c' },
				{ source: 'b', target: 'c' },
			];
			const r = computeExecutionOrder(nodes, edges);
			assert.strictEqual(r.hasCycle, false);
			assert.strictEqual(r.order.length, 3);
			// a and b both precede c
			const aIdx = r.order.indexOf('a');
			const bIdx = r.order.indexOf('b');
			const cIdx = r.order.indexOf('c');
			assert.ok(aIdx < cIdx, 'a must run before c');
			assert.ok(bIdx < cIdx, 'b must run before c');
		});

		test('cycle is detected and order is the acyclic prefix', () => {
			const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
			const edges = [
				{ source: 'a', target: 'b' },
				{ source: 'b', target: 'c' },
				{ source: 'c', target: 'a' },
			];
			const r = computeExecutionOrder(nodes, edges);
			assert.strictEqual(r.hasCycle, true);
			// Kahn stops with the queue empty → only the acyclic prefix (here empty)
			assert.strictEqual(r.order.length, 0);
		});

		test('self-loop is a cycle', () => {
			const nodes = [{ id: 'a' }];
			const edges = [{ source: 'a', target: 'a' }];
			const r = computeExecutionOrder(nodes, edges);
			assert.strictEqual(r.hasCycle, true);
		});

		test('dangling edges (unknown source/target) are ignored', () => {
			const nodes = [{ id: 'a' }, { id: 'b' }];
			const edges = [
				{ source: 'ghost', target: 'a' },
				{ source: 'a', target: 'ghost' },
			];
			const r = computeExecutionOrder(nodes, edges);
			assert.strictEqual(r.hasCycle, false);
			assert.deepStrictEqual(r.order, ['a', 'b']);
		});

		test('upstream always precedes downstream (property check over random DAG)', () => {
			// 12-node layered DAG: each node depends on any nodes in earlier layers.
			const layers = [
				['n0', 'n1'],
				['n2', 'n3', 'n4'],
				['n5', 'n6'],
				['n7', 'n8', 'n9', 'n10'],
				['n11'],
			];
			const nodes: ExecutionNodeLike[] = layers.flat().map(id => ({ id }));
			const edges: ExecutionEdgeLike[] = [];
			let seen = new Set<string>();
			for (let li = 1; li < layers.length; li++) {
				for (const id of layers[li]) {
					// 2–3 random dependencies from any earlier layer
					const pool = layers.slice(0, li).flat().filter(() => Math.random() > 0.5);
					const deps = pool.length ? pool.slice(0, 2 + (pool.length % 2)) : [];
					for (const dep of deps) { edges.push({ source: dep, target: id }); }
				}
			}
			const r = computeExecutionOrder(nodes, edges);
			assert.strictEqual(r.hasCycle, false);
			assert.strictEqual(r.order.length, nodes.length);
			const idx = new Map(r.order.map((id, i) => [id, i]));
			for (const e of edges) {
				assert.ok(idx.get(e.source)! < idx.get(e.target)!, `${e.source} must precede ${e.target}`);
			}
			void seen;
		});
	});

	suite('collectUpstreamNodeIds', () => {

		test('returns direct upstream node ids in edge order', () => {
			const edges = [
				{ source: 'a', target: 'd' },
				{ source: 'b', target: 'd' },
				{ source: 'c', target: 'd' },
			];
			assert.deepStrictEqual(collectUpstreamNodeIds('d', edges), ['a', 'b', 'c']);
		});

		test('deduplicates repeated edges from the same source', () => {
			const edges = [
				{ source: 'a', target: 'd' },
				{ source: 'a', target: 'd' },
				{ source: 'b', target: 'd' },
			];
			assert.deepStrictEqual(collectUpstreamNodeIds('d', edges), ['a', 'b']);
		});

		test('empty when the node has no incoming edges', () => {
			assert.deepStrictEqual(collectUpstreamNodeIds('d', [{ source: 'a', target: 'b' }]), []);
		});

		test('ignores edges pointing elsewhere', () => {
			const edges = [
				{ source: 'a', target: 'b' },
				{ source: 'b', target: 'c' },
			];
			assert.deepStrictEqual(collectUpstreamNodeIds('c', edges), ['b']);
		});
	});

	suite('buildExecutionPlan', () => {

		test('keeps only executable nodes, skipping the rest', () => {
			const nodes: ExecutionNodeLike[] = [
				{ id: 'start', type: 'Saros.Start' },
				{ id: 'img', type: 'Saros.ModelImageGen' },
				{ id: 'end', type: 'Saros.End' },
			];
			const edges = [
				{ source: 'start', target: 'img' },
				{ source: 'img', target: 'end' },
			];
			const isExec = (t: string) => t === 'Saros.ModelImageGen';
			const plan = buildExecutionPlan(nodes, edges, isExec);
			assert.strictEqual(plan.hasCycle, false);
			assert.deepStrictEqual(plan.steps.map(s => s.id), ['img']);
			assert.deepStrictEqual(plan.steps[0].type, 'Saros.ModelImageGen');
			assert.deepStrictEqual(plan.steps[0].upstreams, ['start']);
			assert.deepStrictEqual(plan.skipped, ['start', 'end']);
		});

		test('executable step upstreams are direct edges only', () => {
			const nodes: ExecutionNodeLike[] = [
				{ id: 'a', type: 'Saros.ModelImageGen' },
				{ id: 'b', type: 'Saros.ModelImageGen' },
				{ id: 'c', type: 'Saros.ModelImageGen' },
			];
			const edges = [
				{ source: 'a', target: 'b' },
				{ source: 'b', target: 'c' },
			];
			const plan = buildExecutionPlan(nodes, edges, () => true);
			const byId = new Map(plan.steps.map(s => [s.id, s]));
			assert.deepStrictEqual(byId.get('b')!.upstreams, ['a']);
			assert.deepStrictEqual(byId.get('c')!.upstreams, ['b']);
		});

		test('non-executable-only graph yields empty steps, no cycle', () => {
			const nodes: ExecutionNodeLike[] = [
				{ id: 'x', type: 'Saros.Prompt' },
				{ id: 'y', type: 'Saros.Group' },
			];
			const plan = buildExecutionPlan(nodes, [], () => false);
			assert.strictEqual(plan.hasCycle, false);
			assert.deepStrictEqual(plan.steps, []);
			assert.deepStrictEqual(plan.skipped.sort(), ['x', 'y']);
		});

		test('cycle propagates to the plan', () => {
			const nodes: ExecutionNodeLike[] = [
				{ id: 'a', type: 'Saros.ModelImageGen' },
				{ id: 'b', type: 'Saros.ModelImageGen' },
			];
			const edges = [
				{ source: 'a', target: 'b' },
				{ source: 'b', target: 'a' },
			];
			const plan = buildExecutionPlan(nodes, edges, () => true);
			assert.strictEqual(plan.hasCycle, true);
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// buildParallelExecutionPlan — 并行分层 + P0① 写者分层
// （此前该函数**零测试**；本节同时补上基础分层覆盖）
// ─────────────────────────────────────────────────────────────────────────────
suite('buildParallelExecutionPlan — 写者分层（P0①）', () => {

	const allExec = () => true;

	test('基线分层：无依赖节点同层；diamond 分三层；未传 isWriteStep 不拆', () => {
		const flat = buildParallelExecutionPlan([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [], allExec);
		assert.strictEqual(flat.layers.length, 1);
		assert.deepStrictEqual(flat.layers[0].map(s => s.id), ['a', 'b', 'c']);
		assert.deepStrictEqual(flat.serializedWriters, [], '缺省不拆分（存量行为不变）');

		const diamond = buildParallelExecutionPlan(
			[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
			[
				{ source: 'a', target: 'b' }, { source: 'a', target: 'c' },
				{ source: 'b', target: 'd' }, { source: 'c', target: 'd' },
			],
			allExec,
		);
		assert.deepStrictEqual(diamond.layers.map(l => l.map(s => s.id)), [['a'], ['b', 'c'], ['d']]);
	});

	test('★ 同层两个写者 → 各占一层（写者不并发）', () => {
		const nodes: ExecutionNodeLike[] = [
			{ id: 'w1', type: 'Saros.Agent' },
			{ id: 'w2', type: 'Saros.Agent' },
			{ id: 'r1', type: 'Saros.Prompt' },
		];
		const plan = buildParallelExecutionPlan(nodes, [], allExec, null, undefined, s => s.id !== 'r1');
		assert.deepStrictEqual(plan.layers.map(l => l.map(s => s.id)), [['w1'], ['w2'], ['r1']]);
		assert.deepStrictEqual(plan.serializedWriters, ['w1', 'w2'], '被串行化的写者应可观测');
	});

	test('★ 只读节点仍整批并发（并行探索零回归）', () => {
		const nodes: ExecutionNodeLike[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const plan = buildParallelExecutionPlan(nodes, [], allExec, null, undefined, () => false);
		assert.strictEqual(plan.layers.length, 1, '全只读 → 层数不变');
		assert.strictEqual(plan.layers[0].length, 3);
		assert.deepStrictEqual(plan.serializedWriters, []);
	});

	test('读写混合保持原有顺序（遇写者即切分，确定性优先）', () => {
		const nodes: ExecutionNodeLike[] = [{ id: 'r1' }, { id: 'w1' }, { id: 'r2' }, { id: 'w2' }];
		const plan = buildParallelExecutionPlan(nodes, [], allExec, null, undefined, s => s.id.startsWith('w'));
		assert.deepStrictEqual(plan.layers.map(l => l.map(s => s.id)), [['r1'], ['w1'], ['r2'], ['w2']]);
	});

	test('跨层依赖不受影响：同层写者拆开后仍在共同上游之后', () => {
		const nodes: ExecutionNodeLike[] = [{ id: 'root' }, { id: 'w1' }, { id: 'w2' }];
		const edges: ExecutionEdgeLike[] = [
			{ source: 'root', target: 'w1' },
			{ source: 'root', target: 'w2' },
		];
		const plan = buildParallelExecutionPlan(nodes, edges, allExec, null, undefined, () => true);
		assert.deepStrictEqual(plan.layers.map(l => l.map(s => s.id)), [['root'], ['w1'], ['w2']]);
		assert.strictEqual(plan.layers[0][0].id, 'root', '上游必须仍在最前');
	});

	test('写者本已独占一层 → 不额外增层', () => {
		const nodes: ExecutionNodeLike[] = [{ id: 'r' }, { id: 'w' }];
		const plan = buildParallelExecutionPlan(nodes, [{ source: 'r', target: 'w' }], allExec, null, undefined, s => s.id === 'w');
		assert.deepStrictEqual(plan.layers.map(l => l.map(s => s.id)), [['r'], ['w']]);
		assert.deepStrictEqual(plan.serializedWriters, ['w']);
	});

	test('不可执行节点被 skipped，且不参与拆分', () => {
		const nodes: ExecutionNodeLike[] = [
			{ id: 'g', type: 'Saros.Group' },
			{ id: 'w1', type: 'Saros.Agent' },
			{ id: 'w2', type: 'Saros.Agent' },
		];
		const plan = buildParallelExecutionPlan(nodes, [], t => t !== 'Saros.Group', null, undefined, () => true);
		assert.deepStrictEqual(plan.skipped, ['g']);
		assert.deepStrictEqual(plan.layers.map(l => l.map(s => s.id)), [['w1'], ['w2']]);
	});

	test('作用域外节点不参与拆分（outOfScope）', () => {
		const nodes: ExecutionNodeLike[] = [{ id: 'w1' }, { id: 'w2' }, { id: 'outside' }];
		const plan = buildParallelExecutionPlan(nodes, [], allExec, new Set(['w1', 'w2']), undefined, () => true);
		assert.deepStrictEqual(plan.outOfScope, ['outside']);
		assert.deepStrictEqual(plan.layers.map(l => l.map(s => s.id)), [['w1'], ['w2']]);
	});

	test('环路：layers 与 serializedWriters 均为空', () => {
		const plan = buildParallelExecutionPlan(
			[{ id: 'a' }, { id: 'b' }],
			[{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
			allExec, null, undefined, () => true,
		);
		assert.strictEqual(plan.hasCycle, true);
		assert.deepStrictEqual(plan.layers, []);
		assert.deepStrictEqual(plan.serializedWriters, []);
	});

	test('splitLayerByWriters：纯函数边界（空层 / 全读 / 全写 / 单元素）', () => {
		const mk = (id: string) => ({ id, type: 't', upstreams: [], flowUpstreams: [] });
		assert.deepStrictEqual(splitLayerByWriters([], () => true), []);
		assert.deepStrictEqual(
			splitLayerByWriters([mk('a'), mk('b')], () => false).map(l => l.map(s => s.id)),
			[['a', 'b']],
		);
		assert.deepStrictEqual(
			splitLayerByWriters([mk('a'), mk('b')], () => true).map(l => l.map(s => s.id)),
			[['a'], ['b']],
		);
		assert.deepStrictEqual(
			splitLayerByWriters([mk('a')], () => true).map(l => l.map(s => s.id)),
			[['a']],
		);
		const collected: string[] = [];
		splitLayerByWriters([mk('a'), mk('b')], s => s.id === 'a', collected);
		assert.deepStrictEqual(collected, ['a']);
	});
});
