/*---------------------------------------------------------------------------------------------
 *  Unit tests for buildParallelExecutionPlan (docs/Agent-画布编排设计方案.md P1).
 *  Pure layer computation — no async, no DOM.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildParallelExecutionPlan, type ExecutionNodeLike, type ExecutionEdgeLike } from '../../webview/src/features/workflowEditor/comfyHost/executionGraph.js';

suite('buildParallelExecutionPlan', () => {

	test('empty graph → no layers, no cycle', () => {
		const plan = buildParallelExecutionPlan([], [], () => true);
		assert.deepStrictEqual(plan.layers, []);
		assert.strictEqual(plan.hasCycle, false);
	});

	test('single node is its own layer', () => {
		const plan = buildParallelExecutionPlan([{ id: 'a' }], [], () => true);
		assert.strictEqual(plan.layers.length, 1);
		assert.deepStrictEqual(plan.layers[0].map(s => s.id), ['a']);
	});

	test('independent roots share layer 0', () => {
		const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const plan = buildParallelExecutionPlan(nodes, [], () => true);
		assert.strictEqual(plan.layers.length, 1);
		assert.strictEqual(plan.layers[0].length, 3);
	});

	test('linear chain A→B→C produces three single-step layers', () => {
		const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
		const plan = buildParallelExecutionPlan(nodes, edges, () => true);
		assert.strictEqual(plan.layers.length, 3);
		assert.deepStrictEqual(plan.layers.map(l => l.map(s => s.id)), [['a'], ['b'], ['c']]);
	});

	test('diamond A→{B,C}→D groups B and C in the same layer', () => {
		const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
		const edges = [
			{ source: 'a', target: 'b' },
			{ source: 'a', target: 'c' },
			{ source: 'b', target: 'd' },
			{ source: 'c', target: 'd' },
		];
		const plan = buildParallelExecutionPlan(nodes, edges, () => true);
		assert.strictEqual(plan.layers.length, 3);
		assert.deepStrictEqual(plan.layers[0].map(s => s.id), ['a']);
		assert.deepStrictEqual(plan.layers[1].map(s => s.id).sort(), ['b', 'c']);
		assert.deepStrictEqual(plan.layers[2].map(s => s.id), ['d']);
	});

	test('every edge goes from an earlier layer to a later one', () => {
		const nodes: ExecutionNodeLike[] = [];
		const edges: ExecutionEdgeLike[] = [];
		// 12-node layered DAG.
		const layers = [['n0', 'n1'], ['n2', 'n3'], ['n4'], ['n5', 'n6', 'n7'], ['n8'], ['n9', 'n10'], ['n11']];
		for (const l of layers) { for (const id of l) { nodes.push({ id }); } }
		for (let li = 1; li < layers.length; li++) {
			for (const id of layers[li]) {
				edges.push({ source: layers[li - 1][0], target: id });
			}
		}
		const plan = buildParallelExecutionPlan(nodes, edges, () => true);
		assert.strictEqual(plan.hasCycle, false);
		const layerIndex = new Map<string, number>();
		plan.layers.forEach((l, i) => l.forEach(s => layerIndex.set(s.id, i)));
		for (const e of edges) {
			assert.ok(layerIndex.get(e.source)! < layerIndex.get(e.target)!, `${e.source} layer < ${e.target} layer`);
		}
	});

	test('non-executable nodes are skipped and excluded from layers', () => {
		const nodes = [
			{ id: 's', type: 'Sarosis.Start' },
			{ id: 'img', type: 'Sarosis.ModelImageGen' },
			{ id: 'e', type: 'Sarosis.End' },
		];
		const edges = [
			{ source: 's', target: 'img' },
			{ source: 'img', target: 'e' },
		];
		const plan = buildParallelExecutionPlan(nodes, edges, t => t === 'Sarosis.ModelImageGen');
		assert.deepStrictEqual(plan.layers.map(l => l.map(s => s.id)), [['img']]);
		// Skipped preserves topological order (Start before End).
		assert.deepStrictEqual(plan.skipped, ['s', 'e']);
	});

	test('cycle short-circuits to no layers and marks skipped', () => {
		const nodes = [{ id: 'a' }, { id: 'b' }];
		const edges = [
			{ source: 'a', target: 'b' },
			{ source: 'b', target: 'a' },
		];
		const plan = buildParallelExecutionPlan(nodes, edges, () => true);
		assert.strictEqual(plan.hasCycle, true);
		assert.deepStrictEqual(plan.layers, []);
	});

	test('layer step upstreams are attached for snapshot injection', () => {
		const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const edges = [
			{ source: 'a', target: 'b' },
			{ source: 'a', target: 'c' },
		];
		const plan = buildParallelExecutionPlan(nodes, edges, () => true);
		const c = plan.layers.flat().find(s => s.id === 'c');
		assert.deepStrictEqual(c?.upstreams, ['a']);
	});
});
