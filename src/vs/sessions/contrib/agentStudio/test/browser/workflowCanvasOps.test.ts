/*---------------------------------------------------------------------------------------------
 *  Unit tests for canvasOps — the pure, atomic "Agent-driven canvas" execution kernel
 *  (docs/Agent-画布编排设计方案.md P0). Exercises applyCanvasOps, resolveNodeRef,
 *  nextAutoName and nextNodeId without any LiteGraph/React dependency.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	applyCanvasOps,
	resolveNodeRef,
	nextAutoName,
	nextNodeId,
	type CanvasModel,
	type CanvasNode,
} from '../../webview/src/features/workflowEditor/comfyHost/canvasOps.js';

/** Small registry stub so tests don't depend on the real Saros registration. */
function specStub(type: string) {
	if (type === 'Saros.Prompt') {
		return { inputs: [{ name: 'value', type: 'SAROSIS_JSON' }], outputs: [{ name: 'output', type: 'TEXT' }] };
	}
	if (type === 'Saros.ModelImageGen') {
		return { inputs: [{ name: 'prompt', type: 'TEXT' }], outputs: [{ name: 'image', type: 'IMAGE' }] };
	}
	return undefined;
}

function baseModel(): CanvasModel {
	return {
		nodes: [
			{ id: 'n1', type: 'Saros.Prompt', position: { x: 0, y: 0 }, data: { label: '提示-1', prompt: 'a cat' } },
			{ id: 'n2', type: 'Saros.ModelImageGen', position: { x: 200, y: 0 }, data: { label: '图像-1' } },
		],
		edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'output', targetHandle: 'prompt' }],
	};
}

suite('canvasOps — applyCanvasOps', () => {

	test('add_node creates a node with auto id, auto name and default position', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'add_node', type: 'Saros.ModelImageGen' }], { getSpec: specStub });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.nodes.length, 3);
		const added = r.model.nodes[2];
		assert.strictEqual(added.type, 'Saros.ModelImageGen');
		assert.strictEqual(added.data.label, 'ModelImageGen-1', 'auto-name uses the type-derived kind when no prior name matches');
		assert.ok(added.position.x >= 0 && added.position.y >= 0);
		assert.strictEqual(r.results[0].summary.includes('added node'), true);
	});

	test('add_node auto-name continues the counter across repeated adds', () => {
		const r = applyCanvasOps(baseModel(), [
			{ op: 'add_node', type: 'Saros.ModelImageGen' },
			{ op: 'add_node', type: 'Saros.ModelImageGen' },
		], { getSpec: specStub });
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(r.model.nodes.slice(2).map(n => n.data.label), ['ModelImageGen-1', 'ModelImageGen-2']);
	});

	test('add_node with explicit id/label/position/data is honored', () => {
		const r = applyCanvasOps(baseModel(), [{
			op: 'add_node', type: 'Saros.Prompt', id: 'p9', label: '风格提示',
			position: { x: 10, y: 20 }, data: { prompt: 'neon' },
		}], { getSpec: specStub });
		assert.strictEqual(r.ok, true);
		const n = r.model.nodes.find(x => x.id === 'p9');
		assert.ok(n);
		assert.strictEqual(n.position.x, 10);
		assert.strictEqual(n.data.label, '风格提示');
		assert.strictEqual(n.data.prompt, 'neon');
	});

	test('add_node rejects unknown types', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'add_node', type: 'No.SuchNode' }], { getSpec: specStub });
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /未注册的节点类型/);
	});

	test('add_node with duplicate explicit id fails', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'add_node', type: 'Saros.Prompt', id: 'n1' }], { getSpec: specStub });
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /已存在/);
	});

	test('update_node patches data by label reference (three-tier resolution)', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'update_node', node: '提示-1', patch: { prompt: 'a dog' } }], { getSpec: specStub });
		assert.strictEqual(r.ok, true);
		const n = r.model.nodes.find(x => x.id === 'n1');
		assert.strictEqual(n?.data.prompt, 'a dog');
	});

	test('update_node resolves case-insensitively', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'update_node', node: '提示-1', patch: { negativePrompt: 'blur' } }], { getSpec: specStub });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.nodes[0].data.negativePrompt, 'blur');
	});

	test('update_node with unknown ref fails', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'update_node', node: 'ghost', patch: {} }], { getSpec: specStub });
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /找不到节点/);
	});

	test('delete_node removes the node and its incident edges', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'delete_node', node: 'n1' }], { getSpec: specStub });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.nodes.length, 1);
		assert.strictEqual(r.model.edges.length, 0, 'incident edge removed');
	});

	test('connect creates an edge and dedupes identical links', () => {
		const model: CanvasModel = { nodes: baseModel().nodes, edges: [] };
		const r1 = applyCanvasOps(model, [{ op: 'connect', source: 'n1', target: 'n2', sourceHandle: 'output', targetHandle: 'prompt' }], { getSpec: specStub });
		assert.strictEqual(r1.ok, true);
		assert.strictEqual(r1.model.edges.length, 1);
		const r2 = applyCanvasOps(r1.model, [{ op: 'connect', source: 'n1', target: 'n2', sourceHandle: 'output', targetHandle: 'prompt' }], { getSpec: specStub });
		assert.strictEqual(r2.ok, true);
		assert.strictEqual(r2.model.edges.length, 1, 'duplicate edge is not added twice');
	});

	test('connect with incompatible port types fails', () => {
		// ModelImageGen.image (IMAGE) → ModelImageGen.prompt (TEXT) is incompatible.
		const model: CanvasModel = { nodes: baseModel().nodes, edges: [] };
		const r = applyCanvasOps(model, [{ op: 'connect', source: 'n2', target: 'n2', sourceHandle: 'image', targetHandle: 'prompt' }], { getSpec: specStub });
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /端口类型不兼容/);
	});

	test('disconnect removes the matching edge and reports success', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'disconnect', source: 'n1', target: 'n2' }], { getSpec: specStub });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.edges.length, 0);
	});

	test('disconnect of a nonexistent link fails', () => {
		const model: CanvasModel = { nodes: baseModel().nodes, edges: [] };
		const r = applyCanvasOps(model, [{ op: 'disconnect', source: 'n1', target: 'n2' }], { getSpec: specStub });
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /没有连线/);
	});

	test('select resolves a node id and clears with null', () => {
		const r1 = applyCanvasOps(baseModel(), [{ op: 'select', node: '图像-1' }], { getSpec: specStub });
		assert.strictEqual(r1.ok, true);
		assert.strictEqual(r1.selectedNodeId, 'n2');
		const r2 = applyCanvasOps(baseModel(), [{ op: 'select', node: null }], { getSpec: specStub });
		assert.strictEqual(r2.selectedNodeId, null);
	});

	test('select of unknown node fails', () => {
		const r = applyCanvasOps(baseModel(), [{ op: 'select', node: 'ghost' }], { getSpec: specStub });
		assert.strictEqual(r.ok, false);
	});

	test('a failing op mid-batch rolls the ENTIRE batch back', () => {
		const original = baseModel();
		const r = applyCanvasOps(original, [
			{ op: 'add_node', type: 'Saros.Prompt', id: 'p-new', label: '新提示' },
			{ op: 'delete_node', node: 'n1' },
			{ op: 'add_node', type: 'No.SuchNode' },   // fails → rollback
		], { getSpec: specStub });
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.failedOpIndex, 2);
		// Rolled back to the exact original model (deep-equal).
		assert.deepStrictEqual(r.model, original);
	});

	test('batch order is preserved in results and model', () => {
		const r = applyCanvasOps(baseModel(), [
			{ op: 'add_node', type: 'Saros.Prompt', id: 'p1' },
			{ op: 'add_node', type: 'Saros.ModelImageGen', id: 'g1' },
		], { getSpec: specStub });
		assert.strictEqual(r.ok, true);
		assert.deepStrictEqual(r.model.nodes.map(n => n.id), ['n1', 'n2', 'p1', 'g1']);
		assert.strictEqual(r.results.length, 2);
	});
});

suite('canvasOps — resolveNodeRef', () => {

	const nodes: CanvasNode[] = [
		{ id: 'a1', type: 'Saros.Prompt', position: { x: 0, y: 0 }, data: { label: 'Alpha' } },
		{ id: 'b2', type: 'Saros.ModelImageGen', position: { x: 0, y: 0 }, data: { label: 'beta' } },
	];

	test('exact id wins', () => {
		assert.strictEqual(resolveNodeRef(nodes, 'a1')?.id, 'a1');
	});

	test('label match', () => {
		assert.strictEqual(resolveNodeRef(nodes, 'Alpha')?.id, 'a1');
	});

	test('case-insensitive label match', () => {
		assert.strictEqual(resolveNodeRef(nodes, 'BETA')?.id, 'b2');
	});

	test('unknown returns undefined', () => {
		assert.strictEqual(resolveNodeRef(nodes, 'ghost'), undefined);
	});
});

suite('canvasOps — nextAutoName / nextNodeId', () => {

	test('auto-name continues the highest counter', () => {
		const nodes = [
			{ id: 'x1', type: 'x', position: { x: 0, y: 0 }, data: { label: '图像-1' } },
			{ id: 'x2', type: 'x', position: { x: 0, y: 0 }, data: { label: '图像-5' } },
		];
		assert.strictEqual(nextAutoName('图像', nodes), '图像-6');
	});

	test('auto-name starts at 1 when no match exists', () => {
		assert.strictEqual(nextAutoName('图像', []), '图像-1');
	});

	test('deleted names are not reused (counter never falls back)', () => {
		const nodes = [{ id: 'x1', type: 'x', position: { x: 0, y: 0 }, data: { label: '视频-3' } }];
		// Even though 视频-1/2 no longer exist, we continue at 4.
		assert.strictEqual(nextAutoName('视频', nodes), '视频-4');
	});

	test('nextNodeId sanitizes type and continues counter', () => {
		const nodes = [{ id: 'model-image-gen-2', type: 'x', position: { x: 0, y: 0 }, data: {} }];
		assert.strictEqual(nextNodeId('Saros.ModelImageGen', nodes), 'model-image-gen-3');
	});
});
