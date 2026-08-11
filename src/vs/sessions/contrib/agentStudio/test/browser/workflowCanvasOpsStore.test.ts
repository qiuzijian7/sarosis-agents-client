/*---------------------------------------------------------------------------------------------
 *  Unit tests for applyCanvasOpsToStore — the webview-side bridge from Agent-driven
 *  canvas ops into the workflow store (docs/Agent-画布编排设计方案.md P0).
 *  Exercises regular ops (delegated to applyCanvasOps) and __generate_flow__ expansion.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { applyCanvasOpsToStore } from '../../webview/src/features/workflowEditor/WorkflowEditorPanel.js';
import { registerSarosisNodes } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

// The webview calls registerSarosisNodes() on mount; tests do the same so
// applyCanvasOps' getNodeSpec() finds Sarosis.* types.
suiteSetup(() => { registerSarosisNodes(); });

interface TestNode { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown>; }
interface TestEdge { id: string; source: string; target: string; }

function makeStore() {
	let nodes: TestNode[] = [];
	let edges: TestEdge[] = [];
	return {
		get nodes() { return nodes; },
		get edges() { return edges; },
		setNodes: (n: TestNode[]) => { nodes = n; },
		setEdges: (e: TestEdge[]) => { edges = e; },
	};
}

suite('applyCanvasOpsToStore', () => {

	test('regular ops apply atomically through the store', () => {
		const store = makeStore();
		store.setNodes([
			{ id: 'a', type: 'Sarosis.Prompt', position: { x: 0, y: 0 }, data: { label: '提示-1', prompt: 'cat' } },
		]);
		const r = applyCanvasOpsToStore(store as never, [
			{ op: 'add_node', type: 'Sarosis.Prompt', id: 'b', label: '提示-2', data: { prompt: 'dog' } },
			{ op: 'connect', source: 'a', target: 'b' },
		], []);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(store.nodes.length, 2);
		assert.strictEqual(store.edges.length, 1);
		assert.strictEqual(store.edges[0].source, 'a');
		assert.strictEqual(store.edges[0].target, 'b');
	});

	test('failing op mid-batch leaves the store untouched (rollback)', () => {
		const store = makeStore();
		store.setNodes([
			{ id: 'a', type: 'Sarosis.Prompt', position: { x: 0, y: 0 }, data: { label: '提示-1' } },
		]);
		const r = applyCanvasOpsToStore(store as never, [
			{ op: 'add_node', type: 'Sarosis.Prompt', id: 'b', label: '提示-2' },
			{ op: 'update_node', node: 'ghost', patch: {} },   // fails → rollback
		], []);
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.failedOpIndex, 1);
		assert.strictEqual(store.nodes.length, 1, 'store not mutated on rollback');
		assert.strictEqual(store.edges.length, 0);
	});

	test('__generate_flow__ expands into Prompt + ModelImageGen nodes and edges', () => {
		const store = makeStore();
		const r = applyCanvasOpsToStore(store as never, [
			{ op: 'add_node', type: '__generate_flow__', data: { goal: 'a cyberpunk city' } },
		], []);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.nodes.length, 2, 'prompt + image gen');
		assert.strictEqual(r.model.edges.length, 1, 'prompt → image gen');
		const types = r.model.nodes.map(n => n.type);
		assert.deepStrictEqual(types.sort(), ['Sarosis.ModelImageGen', 'Sarosis.Prompt']);
		assert.strictEqual(r.results[0].summary.includes('已生成画布流程'), true);
		// Store receives the expanded graph.
		assert.strictEqual(store.nodes.length, 2);
		assert.strictEqual(store.edges.length, 1);
	});

	test('__generate_flow__ honors variants and existing graph', () => {
		const store = makeStore();
		store.setNodes([
			{ id: 'seed', type: 'Sarosis.Prompt', position: { x: 0, y: 0 }, data: { label: '已有' } },
		]);
		const r = applyCanvasOpsToStore(store as never, [
			{ op: 'add_node', type: '__generate_flow__', data: {
				goal: 'base',
				variants: [{ prompt: 'v1' }, { prompt: 'v2' }],
			} },
		], []);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.nodes.length, 1 + 4, 'existing 1 + 2 prompts + 2 gens');
		assert.strictEqual(r.model.edges.length, 2, 'two prompt→gen pairs');
		// Existing node preserved.
		assert.ok(r.model.nodes.some(n => n.id === 'seed'));
	});

	test('__generate_flow__ with authenticated provider routes provider/model', () => {
		const store = makeStore();
		const providers = [{
			id: 'p1',
			name: 'P1',
			authStatus: 'authenticated',
			models: [{ id: 'm1', name: 'M1', supportsImageGen: true }],
		}];
		const r = applyCanvasOpsToStore(store as never, [
			{ op: 'add_node', type: '__generate_flow__', data: { goal: 'x' } },
		], providers as never);
		assert.strictEqual(r.ok, true);
		const gen = r.model.nodes.find(n => n.type === 'Sarosis.ModelImageGen');
		assert.strictEqual(gen?.data.providerId, 'p1');
		assert.strictEqual(gen?.data.modelId, 'm1');
	});

	test('__generate_flow__ with run:true still expands cleanly (run flag consumed by caller)', () => {
		const store = makeStore();
		const r = applyCanvasOpsToStore(store as never, [
			{ op: 'add_node', type: '__generate_flow__', data: { goal: 'x', run: true } },
		], []);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.nodes.length, 2);
		assert.strictEqual(store.nodes.length, 2);
	});

	test('__generate_flow__ with layout:true expands cleanly (layout consumed by caller)', () => {
		const store = makeStore();
		const r = applyCanvasOpsToStore(store as never, [
			{ op: 'add_node', type: '__generate_flow__', data: { goal: 'x', layout: true } },
		], []);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.nodes.length, 2);
		assert.strictEqual(store.nodes.length, 2);
	});

	test('undo op invokes the undo callback without mutating the model', () => {
		const store = makeStore();
		let undoCalled = 0;
		let redoCalled = 0;
		const r = applyCanvasOpsToStore(store as never, [{ op: 'undo' }], [], {
			undo: () => { undoCalled++; },
			redo: () => { redoCalled++; },
		});
		assert.strictEqual(r.ok, true);
		assert.strictEqual(undoCalled, 1);
		assert.strictEqual(redoCalled, 0);
		assert.strictEqual(r.results[0].summary.includes('撤销'), true);
		assert.strictEqual(store.nodes.length, 0, 'undo itself does not mutate the store model');
	});

	test('redo op invokes the redo callback', () => {
		const store = makeStore();
		let redoCalled = 0;
		const r = applyCanvasOpsToStore(store as never, [{ op: 'redo' }], [], {
			redo: () => { redoCalled++; },
		});
		assert.strictEqual(r.ok, true);
		assert.strictEqual(redoCalled, 1);
		assert.strictEqual(r.results[0].summary.includes('重做'), true);
	});

	test('a batch containing __generate_flow__ expands it and ignores trailing ops', () => {
		// canvas_generate issues exactly one __generate_flow__ op; any trailing
		// ops are not applied (the expanded graph replaces the canvas model).
		const store = makeStore();
		const r = applyCanvasOpsToStore(store as never, [
			{ op: 'add_node', type: '__generate_flow__', data: { goal: 'x' } },
			{ op: 'update_node', node: 'ghost', patch: {} },
		], []);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.model.nodes.length, 2);
		assert.strictEqual(store.nodes.length, 2);
	});
});
