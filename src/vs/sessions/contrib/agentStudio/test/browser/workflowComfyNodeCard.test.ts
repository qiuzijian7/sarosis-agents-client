/*---------------------------------------------------------------------------------------------
 *  Unit tests for nodeCard — React card metadata derivation (pure part).
 *  Covers title resolution, kind labelling, widget summary and schema detail.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { getNodeCardMeta } from '../../webview/src/features/workflowEditor/comfyHost/nodeCard.js';
import type { NodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

suite('nodeCard (getNodeCardMeta)', () => {

	suite('title resolution', () => {

		test('prefers properties.title then label then spec.title then type', () => {
			const spec: NodeSpec = { type: 'Test.X', kind: 'react', title: 'SpecTitle', category: 'c', inputs: [], outputs: [] };
			assert.strictEqual(getNodeCardMeta(spec, { title: 'PT' }).title, 'PT');
			assert.strictEqual(getNodeCardMeta(spec, { label: 'PL' }).title, 'PL');
			assert.strictEqual(getNodeCardMeta(spec, {}).title, 'SpecTitle');
			assert.strictEqual(getNodeCardMeta({ ...spec, title: '' }, {}).title, 'Test.X');
		});

		test('falls back to "Node" when nothing known', () => {
			assert.strictEqual(getNodeCardMeta(undefined, {}).title, 'Node');
		});
	});

	suite('kind labelling', () => {

		test('maps spec.kind to display labels', () => {
			assert.strictEqual(getNodeCardMeta({ type: 'A', kind: 'react', category: 'c', inputs: [], outputs: [] }, {}).kindLabel, 'React');
			assert.strictEqual(getNodeCardMeta({ type: 'A', kind: 'schema', category: 'c', inputs: [], outputs: [] }, {}).kindLabel, 'schema→React');
			assert.strictEqual(getNodeCardMeta({ type: 'A', kind: 'native', category: 'c', inputs: [], outputs: [] }, {}).kindLabel, 'ComfyUI 原生');
		});

		test('missing spec defaults to react', () => {
			assert.strictEqual(getNodeCardMeta(undefined, {}).kind, 'react');
		});
	});

	suite('widget summary', () => {

		test('builds summary from spec widgets + property values', () => {
			const spec: NodeSpec = {
				type: 'KSampler', kind: 'native', title: 'KSampler', category: 's',
				inputs: [], outputs: [],
				widgets: [
					{ name: 'seed', type: 'INT', default: 0 },
					{ name: 'steps', type: 'INT', default: 20 },
					{ name: 'cfg', type: 'FLOAT', default: 7 },
				],
			};
			const meta = getNodeCardMeta(spec, { seed: 42 });
			assert.match(meta.widgetSummary ?? '', /seed=42/);
			assert.match(meta.widgetSummary ?? '', /steps/); // missing value → name only
		});

		test('no widgets → no summary', () => {
			assert.strictEqual(getNodeCardMeta({ type: 'X', kind: 'react', category: 'c', inputs: [], outputs: [] }, {}).widgetSummary, undefined);
		});

		test('ComfyTV schema stage shows default widgets (prompt/seed/…)', () => {
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
				inputs: [], outputs: [],
				widgets: [
					{ name: 'prompt', type: 'TEXT', default: '' },
					{ name: 'seed', type: 'INT', default: -1 },
					{ name: 'width', type: 'INT', default: 512 },
				],
				comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, { prompt: 'test1', seed: 42 });
			assert.match(meta.widgetSummary ?? '', /prompt=test1/);
			assert.match(meta.widgetSummary ?? '', /seed=42/);
		});

		test('ComfyTV schema stage exposes prompt text + quick actions', () => {
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
				inputs: [], outputs: [], widgets: [],
				comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, { prompt: 'a cat' });
			assert.strictEqual(meta.prompt, 'a cat');
			assert.ok(meta.actions?.includes('Edit Image'));
			assert.ok(meta.actions?.includes('Relight'));
			assert.strictEqual(meta.hasPrompt, true);
			assert.strictEqual(meta.brand, 'ComfyTV');
		});

		test('react node has no prompt/actions', () => {
			const meta = getNodeCardMeta({ type: 'Sarosis.Prompt', kind: 'react', category: 'c', inputs: [], outputs: [] }, {});
			assert.strictEqual(meta.prompt, undefined);
			assert.strictEqual(meta.actions, undefined);
		});

		test('schema stage derives inline controls (COMBO/INT, excludes prompt)', () => {
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
				inputs: [], outputs: [], widgets: [
					{ name: 'prompt', type: 'TEXT', default: '' },
					{ name: 'workflow', type: 'COMBO', default: 'turbo', options: ['turbo', 'ultra'] },
					{ name: 'batch_size', type: 'INT', default: 2, min: 0, max: 10 },
				],
				comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, { workflow: 'ultra' });
			assert.ok(meta.controls);
			assert.strictEqual(meta.controls!.length, 2);
			assert.ok(!meta.controls!.some(c => c.name === 'prompt'));
			const wf = meta.controls!.find(c => c.name === 'workflow');
			assert.strictEqual(wf!.type, 'COMBO');
			assert.strictEqual(wf!.value, 'ultra');
			assert.deepStrictEqual(wf!.options, ['turbo', 'ultra']);
			const bs = meta.controls!.find(c => c.name === 'batch_size');
			assert.strictEqual(bs!.min, 0);
			assert.strictEqual(bs!.max, 10);
		});
	});

	suite('schema detail', () => {

		test('renders comfyTV stage info', () => {
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
				inputs: [], outputs: [], comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, {});
			assert.match(meta.schemaDetail ?? '', /stage: image/);
			assert.match(meta.schemaDetail ?? '', /wf: image/);
		});

		test('no comfyTV → undefined detail', () => {
			assert.strictEqual(getNodeCardMeta({ type: 'X', kind: 'react', category: 'c', inputs: [], outputs: [] }, {}).schemaDetail, undefined);
		});
	});

	suite('port passthrough', () => {

		test('copies inputs/outputs from spec', () => {
			const spec: NodeSpec = {
				type: 'Dual', kind: 'react', title: 'D', category: 'c',
				inputs: [{ name: 'in', type: 'TEXT' }],
				outputs: [{ name: 'out', type: 'IMAGE' }],
			};
			const meta = getNodeCardMeta(spec, {});
			assert.strictEqual(meta.inputs[0].name, 'in');
			assert.strictEqual(meta.outputs[0].type, 'IMAGE');
		});

		test('missing spec → empty ports', () => {
			const meta = getNodeCardMeta(undefined, {});
			assert.deepStrictEqual(meta.inputs, []);
			assert.deepStrictEqual(meta.outputs, []);
		});
	});
});
