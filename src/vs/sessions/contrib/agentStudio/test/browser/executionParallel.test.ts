/*---------------------------------------------------------------------------------------------
 *  Unit tests for buildParallelExecutionPlan (docs/Agent-画布编排设计方案.md P1).
 *  Pure layer computation — no async, no DOM.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildParallelExecutionPlan, isEdgeActive, computeInactiveNodes, type ExecutionNodeLike, type ExecutionEdgeLike } from '../../webview/src/features/workflowEditor/comfyHost/executionGraph.js';

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
			{ id: 's', type: 'Saros.Start' },
			{ id: 'img', type: 'Saros.ModelImageGen' },
			{ id: 'e', type: 'Saros.End' },
		];
		const edges = [
			{ source: 's', target: 'img' },
			{ source: 'img', target: 'e' },
		];
		const plan = buildParallelExecutionPlan(nodes, edges, t => t === 'Saros.ModelImageGen');
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

	// ─── W2: port-aware branch routing ────────────────────────────────────────────

	suite('W2 port-aware routing (isEdgeActive / computeInactiveNodes)', () => {
		const gate = new Set(['gate']);

		test('gate branch only activates the matching sourceHandle edge', () => {
			const edges = [
				{ source: 'gate', target: 't', sourceHandle: 'true' },
				{ source: 'gate', target: 'f', sourceHandle: 'false' },
			];
			const branch = new Map([['gate', 'true']]);
			assert.strictEqual(isEdgeActive(edges[0], branch, gate), true);
			assert.strictEqual(isEdgeActive(edges[1], branch, gate), false);
		});

		test('edge without sourceHandle is always active (legacy graphs)', () => {
			const edges = [{ source: 'gate', target: 'x' }];
			assert.strictEqual(isEdgeActive(edges[0], new Map([['gate', 'false']]), gate), true);
		});

		test('edge from a non-gate source is always active', () => {
			const edges = [{ source: 'data', target: 'x', sourceHandle: 'true' }];
			assert.strictEqual(isEdgeActive(edges[0], new Map([['gate', 'false']]), gate), true);
		});

		test('gate not yet executed → edge stays active (serial reach order)', () => {
			const edges = [{ source: 'gate', target: 'x', sourceHandle: 'false' }];
			assert.strictEqual(isEdgeActive(edges[0], new Map(), gate), true);
		});

		test('inactive branch propagates skips to downstream, OR-join survives', () => {
			// gate →(true) t1 → j ; gate →(false) f1 → j ; j = join node
			const nodes = [{ id: 'gate' }, { id: 't1' }, { id: 'f1' }, { id: 'j' }];
			const edges = [
				{ source: 'gate', target: 't1', sourceHandle: 'true' },
				{ source: 'gate', target: 'f1', sourceHandle: 'false' },
				{ source: 't1', target: 'j' },
				{ source: 'f1', target: 'j' },
			];
			const inactive = computeInactiveNodes(nodes, edges, new Map([['gate', 'true']]), gate);
			assert.strictEqual(inactive.has('t1'), false);
			assert.strictEqual(inactive.has('f1'), true);
			assert.strictEqual(inactive.has('j'), false); // 还有一条 active 入边（t1→j）
		});

		test('whole branch subtree becomes inactive when join only fed by it', () => {
			// gate →(false) f1 → f2（f2 唯一入边来自 f1）
			const nodes = [{ id: 'gate' }, { id: 'f1' }, { id: 'f2' }];
			const edges = [
				{ source: 'gate', target: 'f1', sourceHandle: 'false' },
				{ source: 'f1', target: 'f2' },
			];
			const inactive = computeInactiveNodes(nodes, edges, new Map([['gate', 'true']]), gate);
			assert.strictEqual(inactive.has('f1'), true);
			assert.strictEqual(inactive.has('f2'), true); // skip 传导
		});
	});
