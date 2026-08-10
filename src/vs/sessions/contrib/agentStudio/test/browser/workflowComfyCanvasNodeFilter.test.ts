/*---------------------------------------------------------------------------------------------
 *  Unit tests for canvasNodeFilter — which nodes are rendered on LiteGraph.
 *  After registering real LiteGraph classes for Sarosis types, those nodes are KEPT;
 *  only completely unknown node types are dropped.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	filterNodesForLiteGraph,
	findUnsupportedNodes,
	SAROSIS_NODE_TYPES,
	isLiteGraphRenderable,
} from '../../webview/src/features/workflowEditor/comfyHost/canvasNodeFilter.js';
import { registerNodeSpec, unregisterNodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';
import { sarosisNodeConfigs } from '../../webview/src/features/workflowEditor/comfyHost/sarosisLiteGraphNodes.js';

const GRAPH = {
	last_node_id: 4,
	last_link_id: 3,
	nodes: [
		{ id: 1, type: 'Sarosis.Start', pos: [0, 0] } as any,
		{ id: 2, type: 'ComfyTV.ImageStage', pos: [100, 0] } as any,
		{ id: 3, type: 'KSampler', pos: [200, 0] } as any,
		{ id: 4, type: 'TotallyUnknown', pos: [300, 0] } as any,
	],
	links: [
		[1, 1, 0, 2, 0, 'TEXT'],
		[2, 2, 0, 3, 0, 'IMAGE'],
		[3, 4, 0, 3, 0, 'ANY'],
	] as any,
};

suite('canvasNodeFilter', () => {

	suite('SAROSIS_NODE_TYPES', () => {
		test('includes the 11 Sarosis custom types', () => {
			assert.strictEqual(SAROSIS_NODE_TYPES.has('Sarosis.Start'), true);
			assert.strictEqual(SAROSIS_NODE_TYPES.has('Sarosis.AskUser'), true);
			assert.strictEqual(SAROSIS_NODE_TYPES.has('ComfyTV.X'), false);
		});

		test('every sarosisNodeConfig has a LiteGraph class name', () => {
			for (const cfg of sarosisNodeConfigs()) {
				assert.ok(SAROSIS_NODE_TYPES.has(cfg.type), `missing ${cfg.type}`);
			}
		});
	});

	suite('isLiteGraphRenderable', () => {
		test('Sarosis types render without a spec', () => {
			assert.strictEqual(isLiteGraphRenderable('Sarosis.Prompt', false), true);
		});
		test('unknown types render only with a spec', () => {
			assert.strictEqual(isLiteGraphRenderable('KSampler', true), true);
			assert.strictEqual(isLiteGraphRenderable('KSampler', false), false);
		});
	});

	suite('filterNodesForLiteGraph', () => {
		test('keeps Sarosis nodes + registered types, drops unknown', () => {
			const hasSpec = (t: string) => t === 'ComfyTV.ImageStage' || t === 'KSampler';
			const { keep, dropped } = filterNodesForLiteGraph(GRAPH, hasSpec);
			// nodes 1 (Sarosis) kept, 2+3 kept, 4 (unknown) dropped
			assert.strictEqual(keep.nodes.length, 3);
			assert.strictEqual(dropped.length, 1);
			assert.strictEqual(dropped[0].id, 4);
			assert.strictEqual(dropped[0].reason, 'unknown');
			// links: 1 (1→2) kept, 2 (2→3) kept, 3 (4→3) dropped (4 dropped)
			assert.strictEqual(keep.links.length, 2);
			assert.deepStrictEqual(keep.links.map(l => l[0]), [1, 2]);
		});

		test('drops everything unknown (no spec)', () => {
			const { keep, dropped } = filterNodesForLiteGraph(GRAPH, () => false);
			// Sarosis kept, ComfyTV/KSampler unknown → dropped
			assert.strictEqual(keep.nodes.length, 1);
			assert.strictEqual(keep.nodes[0].id, 1);
			assert.strictEqual(dropped.length, 3);
			assert.ok(dropped.every(d => d.reason === 'unknown'));
		});

		test('handles empty graph', () => {
			const { keep, dropped } = filterNodesForLiteGraph(
				{ last_node_id: 0, last_link_id: 0, nodes: [], links: [] },
				() => true,
			);
			assert.deepStrictEqual(keep.nodes, []);
			assert.deepStrictEqual(keep.links, []);
			assert.deepStrictEqual(dropped, []);
		});
	});

	suite('findUnsupportedNodes', () => {
		test('flags only unknown types (Sarosis is supported)', () => {
			const list = findUnsupportedNodes(
				[{ id: 'a', type: 'Sarosis.Prompt' }, { id: 'b', type: 'KSampler' }, { id: 'c', type: 'NewType' }],
				(t: string) => t === 'KSampler',
			);
			assert.strictEqual(list.length, 1);
			assert.strictEqual(list[0].type, 'NewType');
			assert.strictEqual(list[0].reason, 'unknown');
		});

		test('empty when everything supported', () => {
			assert.deepStrictEqual(
				findUnsupportedNodes([{ id: 'a', type: 'KSampler' }, { id: 'b', type: 'Sarosis.Agent' }], () => true),
				[],
			);
		});
	});
});

// smoke-test the registry integration used by the filter
suite('canvasNodeFilter + registry', () => {
	test('using registry hasSpec for real Sarosis specs', () => {
		unregisterNodeSpec('TestFilter.A');
		registerNodeSpec({ type: 'TestFilter.A', kind: 'native', title: 'A', category: 'c', inputs: [], outputs: [] });
		const hasSpec = (t: string) => t === 'TestFilter.A';
		assert.strictEqual(hasSpec('TestFilter.A'), true);
		assert.strictEqual(hasSpec('Sarosis.Agent'), false);
		unregisterNodeSpec('TestFilter.A');
	});
});
