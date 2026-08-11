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
				{ id: 'start', type: 'Sarosis.Start' },
				{ id: 'img', type: 'Sarosis.ModelImageGen' },
				{ id: 'end', type: 'Sarosis.End' },
			];
			const edges = [
				{ source: 'start', target: 'img' },
				{ source: 'img', target: 'end' },
			];
			const isExec = (t: string) => t === 'Sarosis.ModelImageGen';
			const plan = buildExecutionPlan(nodes, edges, isExec);
			assert.strictEqual(plan.hasCycle, false);
			assert.deepStrictEqual(plan.steps.map(s => s.id), ['img']);
			assert.deepStrictEqual(plan.steps[0].type, 'Sarosis.ModelImageGen');
			assert.deepStrictEqual(plan.steps[0].upstreams, ['start']);
			assert.deepStrictEqual(plan.skipped, ['start', 'end']);
		});

		test('executable step upstreams are direct edges only', () => {
			const nodes: ExecutionNodeLike[] = [
				{ id: 'a', type: 'Sarosis.ModelImageGen' },
				{ id: 'b', type: 'Sarosis.ModelImageGen' },
				{ id: 'c', type: 'Sarosis.ModelImageGen' },
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
				{ id: 'x', type: 'Sarosis.Prompt' },
				{ id: 'y', type: 'Sarosis.Group' },
			];
			const plan = buildExecutionPlan(nodes, [], () => false);
			assert.strictEqual(plan.hasCycle, false);
			assert.deepStrictEqual(plan.steps, []);
			assert.deepStrictEqual(plan.skipped.sort(), ['x', 'y']);
		});

		test('cycle propagates to the plan', () => {
			const nodes: ExecutionNodeLike[] = [
				{ id: 'a', type: 'Sarosis.ModelImageGen' },
				{ id: 'b', type: 'Sarosis.ModelImageGen' },
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
