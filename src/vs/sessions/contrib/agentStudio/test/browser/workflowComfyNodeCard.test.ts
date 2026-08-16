/*---------------------------------------------------------------------------------------------
 *  Unit tests for nodeCard — React card metadata derivation (pure part).
 *  Covers title resolution, kind labelling, widget summary and schema detail.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { getNodeCardMeta, resolveControlOptions } from '../../webview/src/features/workflowEditor/comfyHost/nodeCard.js';
import type { NodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

suite('nodeCard (getNodeCardMeta)', () => {

	suite('resolveControlOptions (provider/model dynamic combos)', () => {

		const providers = [
			{
				id: 'p1', name: 'Provider 1',
				models: [
					{ id: 'm1', name: 'Model 1', supportsImageGen: true },
					{ id: 'm2', name: 'Model 2', supportsImageGen: false },
				],
			},
			{ id: 'p2', name: 'Provider 2', models: [{ id: 'm3', name: 'Model 3', supportsImageGen: true }] },
		];

		test('provider combo lists authenticated image-gen providers as label/value', () => {
			const opts = resolveControlOptions({ name: 'provider', type: 'COMBO', options: [] }, {}, providers);
			assert.deepStrictEqual(opts, [
				{ label: 'Provider 1', value: 'p1' },
				{ label: 'Provider 2', value: 'p2' },
			]);
		});

		test('model combo follows the selected provider and filters image-gen models', () => {
			const opts = resolveControlOptions({ name: 'model', type: 'COMBO', options: [] }, { provider: 'p1' }, providers);
			// m2 has supportsImageGen=false → excluded.
			assert.deepStrictEqual(opts, [{ label: 'Model 1', value: 'm1' }]);
		});

		test('model combo with no provider selected returns undefined', () => {
			const opts = resolveControlOptions({ name: 'model', type: 'COMBO', options: [] }, {}, providers);
			assert.strictEqual(opts, undefined);
		});

		test('non-provider/model combos keep their static options', () => {
			const opts = resolveControlOptions({ name: 'workflow', type: 'COMBO', options: ['a', 'b'] }, {}, []);
			assert.deepStrictEqual(opts, ['a', 'b']);
		});

		test('model combo resolves through a provided effective provider draft (激活回退联动)', () => {
			// 节点 properties 为空但调用方已把 provider 兜底为第一个激活 provider 时，
			// model 应能列出该 provider 的可用模型（而非 undefined）。
			const opts = resolveControlOptions({ name: 'model', type: 'COMBO', options: [] }, { provider: 'p1' }, providers);
			assert.deepStrictEqual(opts, [{ label: 'Model 1', value: 'm1' }]);
		});
	});

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
				inputs: [], outputs: [],
				widgets: [{ name: 'prompt', type: 'TEXT', default: '' }],
				comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, { prompt: 'a cat' });
			assert.strictEqual(meta.prompt, 'a cat');
			// ACTIONS 是 {icon,label} 对象（对齐 ComfyTV STAGE_ACTIONS.icon+label）
			assert.ok(meta.actions?.some(a => a.label === 'Edit Image'));
			assert.ok(meta.actions?.some(a => a.label === 'Relight'));
			// imageActions = 6 个（edit / panorama / multiangle / relight / material /
			// preset），对齐 ComfyTV stageActions.ts 的 imageActions（同 6 项）。
			assert.strictEqual(meta.actions?.length, 6, 'image stage 应有 6 个 actions（对齐 ComfyTV）');
			assert.strictEqual(meta.hasPrompt, true);
			assert.strictEqual(meta.brand, 'ComfyTV');
		});

		test('ComfyTV 服务端返回变体 stageKind（如 image-to-image/t2i）也能命中 5 个 image actions', () => {
			// /comfytv/stages 元数据里 kind 字段不一定是 'image'，可能是 'image-to-image' /
			// 't2i' / 'i2i' 等；归一化后必须回退到 image 家族的 5 个 actions。
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: 'Image Stage', category: 'comfyTV',
				inputs: [{ name: 'input', type: 'ANY' }],
				outputs: [{ name: 'output', type: 'COMFYTV_IMAGES' }],
				widgets: [],
				comfyTV: { stageKind: 'image-to-image', workflowKind: 't2i' },
			};
			const meta = getNodeCardMeta(spec, { prompt: 'a cat' });
			assert.strictEqual(meta.actions?.length, 6, 'image 变体 stageKind 也应命中 6 个 actions');
			assert.ok(meta.actions?.some(a => a.label === 'Edit Image'));
		});

		test('video / audio 变体 stageKind 也能命中对应 actions', () => {
			const videoSpec: NodeSpec = {
				type: 'ComfyTV.VideoStage', kind: 'schema', title: 'Video', category: 'comfyTV',
				inputs: [], outputs: [], widgets: [],
				comfyTV: { stageKind: 'video-to-video', workflowKind: 'v2v' },
			};
			assert.strictEqual(getNodeCardMeta(videoSpec, {}).actions?.length, 2);
			const audioSpec: NodeSpec = {
				type: 'ComfyTV.AudioStage', kind: 'schema', title: 'Audio', category: 'comfyTV',
				inputs: [], outputs: [], widgets: [],
				comfyTV: { stageKind: 'speech-to-speech', workflowKind: 's2s' },
			};
			assert.strictEqual(getNodeCardMeta(audioSpec, {}).actions?.length, 1);
		});

		test('react node has no prompt/actions', () => {
			const meta = getNodeCardMeta({ type: 'Saros.Prompt', kind: 'react', category: 'c', inputs: [], outputs: [] }, {});
			assert.strictEqual(meta.prompt, undefined);
			assert.strictEqual(meta.actions, undefined);
		});

		test('provider/model controls accept legacy providerId/modelId property names', () => {
			// canvas_generate 等写入 providerId/modelId（旧命名），卡片控件须兼容。
			const spec: NodeSpec = {
				type: 'Saros.ModelImageGen', kind: 'schema', title: '模型文生图', category: 'c',
				inputs: [], outputs: [], widgets: [
					{ name: 'provider', type: 'COMBO', default: '', options: [] },
					{ name: 'model', type: 'COMBO', default: '', options: [] },
				],
				backendKind: 'provider',
			};
			const meta = getNodeCardMeta(spec, { providerId: 'p1', modelId: 'm1' });
			assert.ok(meta.controls);
			assert.strictEqual(meta.controls!.find(c => c.name === 'provider')!.value, 'p1');
			assert.strictEqual(meta.controls!.find(c => c.name === 'model')!.value, 'm1');
		});

		test('ComfyTV schema stage: 参数 DOM 化，controls 含 workflow/batch_size，prompt 走 textarea', () => {
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
			// ★ 语义已反转（对齐 ComfyTV applyHiddenWidgetFlags）：ComfyTV 节点
			//   的 canvas widget 全 hidden，参数（workflow/batch_size）由 StageCard
			//   的 DOM controls 渲染；prompt（TEXT）由专门 textarea 渲染，**不进**
			//   controls。toControls 对 spec.comfyTV 收集 COMBO/INT/FLOAT/BOOLEAN。
			assert.ok(meta.controls);
			assert.strictEqual(meta.controls!.length, 2, 'ComfyTV DOM controls 含 workflow + batch_size');
			assert.ok(meta.controls!.some(c => c.name === 'workflow'));
			assert.ok(meta.controls!.some(c => c.name === 'batch_size'));
			assert.ok(!meta.controls!.some(c => c.name === 'prompt'), 'prompt 不应在 controls（由 textarea 渲染）');
			const workflow = meta.controls!.find(c => c.name === 'workflow');
			assert.strictEqual(workflow!.value, 'ultra');
			const batch = meta.controls!.find(c => c.name === 'batch_size');
			assert.strictEqual(batch!.value, 2);
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
