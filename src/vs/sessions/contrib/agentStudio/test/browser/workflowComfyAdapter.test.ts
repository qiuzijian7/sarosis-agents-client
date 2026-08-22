/*---------------------------------------------------------------------------------------------
 *  Unit tests for ComfyGraphAdapter — bidirectional conversion between
 *  sarosis workflow JSON and LiteGraph serialize format.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	toLiteGraph,
	fromLiteGraph,
	stableSerializeGraph,
	toLiteGraphType,
	toSarosType,
} from '../../webview/src/features/workflowEditor/comfyHost/ComfyGraphAdapter.js';

const SAMPLE_NODES = [
	{ id: 'start', type: 'start', name: 'Start', position: { x: 80, y: 250 } },
	{ id: 'prompt1', type: 'prompt', name: 'Prompt', position: { x: 320.345, y: 180.678 },
		data: { label: 'Prompt', prompt: 'hello {{x}}' } },
	{ id: 'end', type: 'end', name: 'End', position: { x: 900, y: 250 } },
];
const SAMPLE_CONNECTIONS = [
	{ id: 'e1', from: 'start', to: 'prompt1' },
	{ id: 'e2', from: 'prompt1', to: 'end' },
];

suite('ComfyGraphAdapter', () => {

	suite('toLiteGraphType / toSarosType', () => {

		test('namespaced round trip', () => {
			assert.strictEqual(toLiteGraphType('prompt'), 'Saros.Prompt');
			assert.strictEqual(toSarosType('Saros.Prompt'), 'prompt');
		});

		test('already-namespaced passes through', () => {
			assert.strictEqual(toLiteGraphType('Saros.Prompt'), 'Saros.Prompt');
			assert.strictEqual(toLiteGraphType('ComfyTV.ImageStage'), 'ComfyTV.ImageStage');
			assert.strictEqual(toSarosType('KSampler'), 'KSampler');
		});
	});

	suite('toLiteGraph', () => {

		test('converts nodes with sequential ids and position rounding', () => {
			const { graph, nodeIdMap } = toLiteGraph(SAMPLE_NODES, SAMPLE_CONNECTIONS);
			assert.strictEqual(graph.nodes.length, 3);
			assert.strictEqual(graph.last_node_id, 3);
			// position rounded to 2 decimals
			const prompt = graph.nodes.find(n => n.id === 2)!;
			assert.strictEqual(prompt.pos[0], 320.35);
			assert.strictEqual(prompt.pos[1], 180.68);
			// saros id preserved in properties
			assert.strictEqual(prompt.properties?.__sarosId, 'prompt1');
			// map
			assert.strictEqual(nodeIdMap.get(2), 'prompt1');
		});

		test('drops dangling connections', () => {
			const { graph } = toLiteGraph(SAMPLE_NODES, [
				{ id: 'e1', from: 'start', to: 'ghost' },
			]);
			assert.strictEqual(graph.links.length, 0);
		});

		test('links get ANY type when no port info', () => {
			const { graph } = toLiteGraph(SAMPLE_NODES, SAMPLE_CONNECTIONS);
			assert.strictEqual(graph.links.length, 2);
			assert.strictEqual(graph.links[0][5], 'ANY');
		});

		test('type mapping produces namespaced Saros.* types', () => {
			const { graph } = toLiteGraph(SAMPLE_NODES, SAMPLE_CONNECTIONS);
			assert.strictEqual(graph.nodes.find(n => n.id === 2)!.type, 'Saros.Prompt');
		});
	});

	suite('fromLiteGraph', () => {

		test('round-trip preserves node ids/positions/data', () => {
			const { graph } = toLiteGraph(SAMPLE_NODES, SAMPLE_CONNECTIONS);
			const { nodes, connections } = fromLiteGraph(graph);
			assert.strictEqual(nodes.length, 3);
			assert.strictEqual(connections.length, 2);

			const prompt = nodes.find(n => n.id === 'prompt1')!;
			assert.strictEqual(prompt.type, 'prompt');
			assert.strictEqual(prompt.data?.prompt, 'hello {{x}}');
			assert.strictEqual(prompt.position.x, 320.35);
			// de-namespaced type
			assert.strictEqual(nodes.find(n => n.id === 'start')!.type, 'start');
		});

		test('restores connections in order', () => {
			const { graph } = toLiteGraph(SAMPLE_NODES, SAMPLE_CONNECTIONS);
			const { connections } = fromLiteGraph(graph);
			assert.strictEqual(connections[0].from, 'start');
			assert.strictEqual(connections[0].to, 'prompt1');
			assert.strictEqual(connections[1].from, 'prompt1');
			assert.strictEqual(connections[1].to, 'end');
		});

		test('handles empty graph', () => {
			const { nodes, connections } = fromLiteGraph({ last_node_id: 0, last_link_id: 0, nodes: [], links: [] });
			assert.deepStrictEqual(nodes, []);
			assert.deepStrictEqual(connections, []);
		});

		test('skips links referencing missing nodes', () => {
			const { nodes, connections } = fromLiteGraph({
				last_node_id: 2, last_link_id: 1,
				nodes: [{ id: 1, type: 'Saros.Start', pos: [0, 0] }],
				links: [[1, 1, 0, 99, 0, 'ANY']],
			});
			assert.strictEqual(nodes.length, 1);
			assert.strictEqual(connections.length, 0);
		});

		test('unknown (native) node types pass through', () => {
			const { nodes } = fromLiteGraph({
				last_node_id: 1, last_link_id: 0,
				nodes: [{ id: 1, type: 'KSampler', pos: [10, 20] }],
				links: [],
			});
			assert.strictEqual(nodes[0].type, 'KSampler');
			assert.deepStrictEqual(nodes[0].position, { x: 10, y: 20 });
		});
	});

	suite('stableSerializeGraph', () => {

		test('produces deterministic output regardless of input order', () => {
			const g1 = {
				last_node_id: 2, last_link_id: 1,
				nodes: [
					{ id: 2, type: 'Saros.End', pos: [900, 250] },
					{ id: 1, type: 'Saros.Start', pos: [80, 250] },
				],
				links: [[1, 1, 0, 2, 0, 'ANY']],
			};
			const g2 = {
				last_node_id: 2, last_link_id: 1,
				nodes: [
					{ id: 1, type: 'Saros.Start', pos: [80, 250] },
					{ id: 2, type: 'Saros.End', pos: [900, 250] },
				],
				links: [[1, 1, 0, 2, 0, 'ANY']],
			};
			assert.strictEqual(stableSerializeGraph(g1), stableSerializeGraph(g2));
		});
	});

	suite('full round-trip stability', () => {

		test('toLiteGraph→fromLiteGraph preserves structure (ids, positions, connections)', () => {
			const input = {
				nodes: [
					{ id: 'start', type: 'start', name: 'Start', position: { x: 80, y: 250 } },
					{ id: 'agent1', type: 'agent', name: 'Agent', position: { x: 400.5, y: 300.25 },
						data: { label: 'Agent', agentId: 'a1' }, style: { width: 240, height: 140 } },
					{ id: 'end', type: 'end', name: 'End', position: { x: 800, y: 250 } },
				],
				connections: [
					{ id: 'e1', from: 'start', to: 'agent1' },
					{ id: 'e2', from: 'agent1', to: 'end' },
				],
			};
			const { graph } = toLiteGraph(input.nodes, input.connections);
			const { nodes, connections } = fromLiteGraph(graph);

			assert.deepStrictEqual(new Set(nodes.map(n => n.id)), new Set(['start', 'agent1', 'end']));
			const agent = nodes.find(n => n.id === 'agent1')!;
			assert.strictEqual(agent.data?.agentId, 'a1');
			assert.strictEqual(agent.position.x, 400.5);
			assert.strictEqual(agent.style?.width, 240);
			assert.strictEqual(connections.length, 2);
		});
	});
});
