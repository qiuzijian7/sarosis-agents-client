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
import { registerSarosNodes } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

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

	// camelCase Saros 类型需在注册表中存在，toSarosType 的「精确匹配保留」分支才会命中。
	registerSarosNodes();

	suite('toLiteGraphType / toSarosType', () => {

		test('namespaced round trip', () => {
			assert.strictEqual(toLiteGraphType('prompt'), 'Saros.Prompt');
			// 2026-08-31 修复：camelCase 命名空间类型不再整段小写（曾把
			// Saros.ModelImageGen 变成 Saros.modelimagegen → 画布过滤丢弃 → 保存丢失）。
			// 旧断言期望 'Saros.Prompt' → 'prompt'（去前缀小写），现精确匹配注册表
			// 时原样返回；未注册的旧小写仍走 normalizeNodeType 迁移。
			assert.strictEqual(toSarosType('Saros.Prompt'), 'Saros.Prompt');
		});

		test('already-namespaced passes through', () => {
			assert.strictEqual(toLiteGraphType('Saros.Prompt'), 'Saros.Prompt');
			assert.strictEqual(toLiteGraphType('ComfyTV.ImageStage'), 'ComfyTV.ImageStage');
			assert.strictEqual(toSarosType('KSampler'), 'KSampler');
		});

		test('camelCase Saros type preserved verbatim (ModelImageGen bug)', () => {
			// ★ 根因回归：Saros.ModelImageGen 被旧 toSarosType 小写成
			// Saros.modelimagegen → filterNodesForLiteGraph 丢弃 → 保存后节点消失。
			assert.strictEqual(toSarosType('Saros.ModelImageGen'), 'Saros.ModelImageGen');
			assert.strictEqual(toSarosType('Saros.IfElse'), 'Saros.IfElse');
			assert.strictEqual(toSarosType('Saros.AskUser'), 'Saros.AskUser');
		});

		test('unregistered Saros type falls back to legacy lowercase migration', () => {
			// 注册表未注册的 Saros.* 类型仍走旧小写路径（ReactFlow 时代兼容）。
			assert.strictEqual(toSarosType('Saros.UnknownThing'), 'unknownthing');
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
			// 2026-08-31：注册表内的命名空间类型原样保留（不再去前缀小写）。
			assert.strictEqual(prompt.type, 'Saros.Prompt');
			assert.strictEqual(prompt.data?.prompt, 'hello {{x}}');
			assert.strictEqual(prompt.position.x, 320.35);
			// de-namespaced type
			assert.strictEqual(nodes.find(n => n.id === 'start')!.type, 'Saros.Start');
		});

		test('camelCase schema node survives graph→store round-trip (ModelImageGen bug)', () => {
			// ★ 复现用户报告：连线创建 ModelImageGen → syncGraphToStore 小写化 →
			//   autoSave 丢节点。修复后 type 原样往返。
			const { graph } = toLiteGraph([
				{ id: 'mig-1', type: 'Saros.ModelImageGen', name: '模型文生图', position: { x: 100, y: 100 } },
			], []);
			const { nodes } = fromLiteGraph(graph);
			assert.strictEqual(nodes.length, 1);
			assert.strictEqual(nodes[0].type, 'Saros.ModelImageGen');
		});

		test('duplicate __sarosId (LiteGraph clone) gets deduped at serialization boundary', () => {
			// ★ 2026-09-02：LiteGraph 原生 duplicate/paste 整份复制 properties
			//   （含 __sarosId）→ 两个节点同 id → 卡片/快照/控制事件全部串线
			//   （实测：原 LoadImage 卡片被顶掉、图像消失）。fromLiteGraph 必须
			//   给撞车者生成唯一 id（--dup<liteId> 后缀）。
			const graph = {
				last_node_id: 2,
				last_link_id: 0,
				nodes: [
					{ id: 30, type: 'ComfyTV.ImageLoaderStage', pos: [0, 0], size: [300, 200], properties: { __sarosId: 'loadimage-stage-3', __sarosStageUid: 'uid-a', image: 'data:image/png;base64,AAA' } },
					{ id: 34, type: 'ComfyTV.ImageLoaderStage', pos: [400, 0], size: [300, 200], properties: { __sarosId: 'loadimage-stage-3', __sarosStageUid: 'uid-b', image: 'data:image/png;base64,AAA' } },
				],
				links: [],
			} as unknown as Parameters<typeof fromLiteGraph>[0];
			const { nodes } = fromLiteGraph(graph);
			assert.strictEqual(nodes.length, 2);
			const ids = nodes.map(n => n.id);
			assert.notStrictEqual(ids[0], ids[1], '两个节点的 id 不得相同');
			assert.strictEqual(ids[0], 'loadimage-stage-3');
			assert.strictEqual(ids[1], 'loadimage-stage-3--dup34');
			// properties.image（粘贴的数据 URL）原样保留在 data 里
			assert.strictEqual((nodes[0].data as Record<string, unknown>)['image'], 'data:image/png;base64,AAA');
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
