/*---------------------------------------------------------------------------------------------
 *  Unit tests for comfyApiAdapter — ComfyUI GUI/API workflow JSON conversion.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	parseGuiWorkflow,
	guiToApi,
	apiToGui,
	resolveApiReferences,
	stripSarosisNodesForExport,
	type ComfyGuiWorkflow,
} from '../../webview/src/features/workflowEditor/comfyHost/comfyApiAdapter.js';

const GUI_WF: ComfyGuiWorkflow = {
	nodes: [
		{
			id: 1,
			type: 'CheckpointLoaderSimple',
			pos: [0, 0],
			inputs: [{ name: 'ckpt_name', type: 'COMBO', link: null, widget: { name: 'ckpt_name' } }],
			outputs: [{ name: 'MODEL', type: 'MODEL', links: [10] }],
			widgets_values: ['sd_xl_base_1.0.safetensors'],
		},
		{
			id: 2,
			type: 'CLIPTextEncode',
			pos: [200, 0],
			inputs: [
				{ name: 'clip', type: 'CLIP', link: 10 },
				{ name: 'text', type: 'STRING', link: null, widget: { name: 'text' } },
			],
			outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [11] }],
			widgets_values: ['a cat'],
		},
		{
			id: 3,
			type: 'KSampler',
			pos: [400, 0],
			inputs: [
				{ name: 'model', type: 'MODEL', link: 10 },
				{ name: 'positive', type: 'CONDITIONING', link: 11 },
				{ name: 'seed', type: 'INT', link: null, widget: { name: 'seed' } },
			],
			outputs: [{ name: 'LATENT', type: 'LATENT', links: [] }],
			widgets_values: [42],
		},
	],
	links: [
		[10, 1, 0, 2, 0, 'CLIP'],
		[11, 2, 0, 3, 1, 'CONDITIONING'],
	],
	version: 0.4,
};

suite('comfyApiAdapter', () => {

	suite('parseGuiWorkflow', () => {

		test('coerces nodes and links into LiteGraph shape', () => {
			const { graph, issues } = parseGuiWorkflow(GUI_WF);
			assert.deepStrictEqual(issues, []);
			assert.strictEqual(graph.nodes.length, 3);
			assert.strictEqual(graph.links.length, 2);
			assert.strictEqual(graph.last_node_id, 3);
			assert.strictEqual(graph.last_link_id, 11);
			assert.strictEqual(graph.nodes[0].type, 'CheckpointLoaderSimple');
			assert.deepStrictEqual(graph.nodes[0].pos, [0, 0]);
		});

		test('rejects non-object', () => {
			const { issues } = parseGuiWorkflow(null);
			assert.ok(issues.length > 0);
		});

		test('rejects missing nodes array', () => {
			const { issues } = parseGuiWorkflow({ links: [] });
			assert.ok(issues.some(i => i.includes('nodes')));
		});

		test('skips nodes without id/type', () => {
			const { graph, issues } = parseGuiWorkflow({ nodes: [{ id: 1, type: 'A' }, { type: 'B' }] } as never);
			assert.strictEqual(graph.nodes.length, 1);
			assert.ok(issues.length > 0);
		});

		test('sorts links by id and computes last ids', () => {
			const { graph } = parseGuiWorkflow({ nodes: [{ id: 5, type: 'X', pos: [0, 0] }], links: [[20, 5, 0, 5, 0, 'ANY'], [1, 5, 0, 5, 0, 'ANY']] } as never);
			assert.strictEqual(graph.links[0][0], 1);
			assert.strictEqual(graph.last_link_id, 20);
			assert.strictEqual(graph.last_node_id, 5);
		});
	});

	suite('guiToApi', () => {

		test('converts widgets and connections to /prompt format', () => {
			const api = guiToApi(GUI_WF);
			assert.strictEqual(api['1'].class_type, 'CheckpointLoaderSimple');
			assert.strictEqual(api['1'].inputs['ckpt_name'], 'sd_xl_base_1.0.safetensors');
			// connection: clip comes from node 1 slot 0
			assert.deepStrictEqual(api['2'].inputs['clip'], ['1', 0]);
			// widget text
			assert.strictEqual(api['2'].inputs['text'], 'a cat');
			// widget seed
			assert.strictEqual(api['3'].inputs['seed'], 42);
		});

		test('maps connections through links by link id', () => {
			const api = guiToApi(GUI_WF);
			assert.deepStrictEqual(api['3'].inputs['positive'], ['2', 0]);
		});
	});

	suite('resolveApiReferences', () => {

		test('collects all [nodeId, slot] references with source types', () => {
			const api = guiToApi(GUI_WF);
			const refs = resolveApiReferences(api);
			// node2.clip + node3.model + node3.positive = 3 connections
			assert.strictEqual(refs.length, 3);
			const clip = refs.find(r => r.field === 'clip')!;
			assert.strictEqual(clip.targetNode, '1');
			assert.strictEqual(clip.targetSlot, 0);
			assert.strictEqual(clip.sourceType, 'CheckpointLoaderSimple');
		});

		test('ignores non-reference values', () => {
			const refs = resolveApiReferences({ '1': { class_type: 'A', inputs: { seed: 5, flag: true } } });
			assert.strictEqual(refs.length, 0);
		});
	});

	suite('apiToGui (round-trip)', () => {

		test('reconstructs a graph from an api.json prompt', () => {
			const api = guiToApi(GUI_WF);
			const wf = apiToGui(api);
			assert.strictEqual(wf.nodes.length, 3);
			// widgets back as widget inputs
			assert.strictEqual(wf.nodes[0].inputs!.length, 1);
			// three connections (clip, model, positive)
			assert.strictEqual(wf.links!.length, 3);
		});

		test('drops references to missing nodes', () => {
			const wf = apiToGui({ '1': { class_type: 'A', inputs: { x: ['99', 0] } } });
			assert.strictEqual(wf.nodes.length, 1);
			assert.strictEqual(wf.links!.length, 0);
		});
	});

	suite('stripSarosisNodesForExport', () => {

		const isNonComfy = (t: string) => t === 'Sarosis.ModelImageGen' || t === 'Sarosis.Prompt';

		const MIXED: ComfyGuiWorkflow = {
			nodes: [
				{ id: 1, type: 'CheckpointLoaderSimple', pos: [0, 0], inputs: [], outputs: [], widgets_values: ['a'] },
				{ id: 2, type: 'Sarosis.Prompt', pos: [0, 0], inputs: [], outputs: [] },
				{ id: 3, type: 'Sarosis.ModelImageGen', pos: [0, 0], inputs: [{ name: 'prompt', type: 'TEXT', link: 100 }], outputs: [] },
				{ id: 4, type: 'KSampler', pos: [0, 0], inputs: [{ name: 'model', type: 'MODEL', link: 101 }], outputs: [] },
			],
			links: [
				[100, 2, 0, 3, 0, 'TEXT'],   // 2 → 3 (both removed)
				[101, 1, 0, 4, 0, 'MODEL'],  // 1 → 4 (kept)
			],
		};

		test('removes Sarosis nodes and dangling links, keeps Comfy nodes', () => {
			const { workflow, skipped } = stripSarosisNodesForExport(MIXED, isNonComfy);
			assert.deepStrictEqual(skipped, ['Sarosis.Prompt', 'Sarosis.ModelImageGen']);
			assert.deepStrictEqual(workflow.nodes.map(n => n.type), ['CheckpointLoaderSimple', 'KSampler']);
			assert.strictEqual(workflow.links!.length, 1);
			assert.deepStrictEqual(workflow.links![0], [101, 1, 0, 4, 0, 'MODEL']);
		});

		test('all-Sarosis workflow → empty nodes, no links', () => {
			const { workflow, skipped } = stripSarosisNodesForExport(
				{ nodes: [{ id: 9, type: 'Sarosis.Prompt', inputs: [], outputs: [] }], links: [] },
				isNonComfy,
			);
			assert.strictEqual(workflow.nodes.length, 0);
			assert.strictEqual(skipped.length, 1);
		});

		test('no non-Comfy nodes → unchanged workflow', () => {
			const { workflow, skipped } = stripSarosisNodesForExport(GUI_WF, isNonComfy);
			assert.strictEqual(workflow.nodes.length, GUI_WF.nodes.length);
			assert.strictEqual(skipped.length, 0);
		});
	});
});
