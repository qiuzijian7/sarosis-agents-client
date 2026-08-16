/*---------------------------------------------------------------------------------------------
 *  Unit tests for comfyTvLoader — ComfyTV stage metadata → schema node registration.
 *  Verifies kind mapping, registration, dedupe, and graceful HTTP failure.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	comfyTVStageToSpec,
	comfyTVKindToPort,
	registerComfyTVStages,
	loadComfyTVStages,
} from '../../webview/src/features/workflowEditor/comfyHost/comfyTvLoader.js';
import { getNodeSpec, unregisterNodeSpec, registerComfyTVNode, patchComfyTVWorkflowOptions, COMFYTV_IMAGE_WORKFLOWS, getAllSpecs } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';
import { COMFYTV_STAGE_META } from '../../webview/src/features/workflowEditor/comfyHost/comfyTVStageMeta.generated.js';

function cleanup(types: string[]): void {
	for (const t of types) { unregisterNodeSpec(t); }
}

suite('comfyTvLoader', () => {

	suite('comfyTVKindToPort', () => {

		test('maps known kinds to port types', () => {
			assert.strictEqual(comfyTVKindToPort('image'), 'IMAGE');
			assert.strictEqual(comfyTVKindToPort('image-batch'), 'IMAGE');
			assert.strictEqual(comfyTVKindToPort('video'), 'VIDEO');
			assert.strictEqual(comfyTVKindToPort('audio'), 'AUDIO');
			assert.strictEqual(comfyTVKindToPort('text'), 'TEXT');
			assert.strictEqual(comfyTVKindToPort('model'), 'ANY');
			assert.strictEqual(comfyTVKindToPort(undefined), 'ANY');
		});
	});

	suite('comfyTVStageToSpec', () => {

		test('builds a schema spec with kind port', () => {
			const spec = comfyTVStageToSpec({
				node_id: 'ComfyTV.ImageStage',
				kind: 'image',
				workflow_kind: 'image',
			});
			assert.strictEqual(spec.type, 'ComfyTV.ImageStage');
			assert.strictEqual(spec.kind, 'schema');
			assert.strictEqual(spec.outputs[0].type, 'IMAGE');
			assert.strictEqual(spec.comfyTV?.workflowKind, 'image');
			assert.strictEqual(spec.title, 'ImageStage');
		});

		test('variant appears in the title', () => {
			const spec = comfyTVStageToSpec({
				node_id: 'ComfyTV.TextToImageStage',
				kind: 'image',
				variant: 'sdxl',
			});
			assert.match(spec.title, /sdxl/);
		});
	});

	suite('registerComfyTVStages', () => {

		test('registers all valid stages and skips duplicates', () => {
			cleanup(['ComfyTV.A', 'ComfyTV.B']);
			const first = registerComfyTVStages({
				stages: [
					{ node_id: 'ComfyTV.A', kind: 'image' },
					{ node_id: 'ComfyTV.B', kind: 'audio' },
				],
			});
			assert.strictEqual(first.registered.length, 2);
			assert.strictEqual(first.skipped.length, 0);
			assert.strictEqual(getNodeSpec('ComfyTV.A')?.outputs[0].type, 'IMAGE');
			assert.strictEqual(getNodeSpec('ComfyTV.B')?.outputs[0].type, 'AUDIO');

			const second = registerComfyTVStages({ stages: [{ node_id: 'ComfyTV.A', kind: 'image' }] });
			assert.strictEqual(second.registered.length, 0);
			assert.strictEqual(second.skipped.length, 1);
			assert.match(second.skipped[0], /duplicate/);
			cleanup(['ComfyTV.A', 'ComfyTV.B']);
		});

		test('skips entries without node_id', () => {
			const result = registerComfyTVStages({ stages: [{ kind: 'image' } as never] });
			assert.strictEqual(result.registered.length, 0);
			assert.strictEqual(result.skipped.length, 1);
			assert.match(result.skipped[0], /missing node_id/);
		});

		test('empty response registers nothing', () => {
			const result = registerComfyTVStages({});
			assert.deepStrictEqual(result.registered, []);
			assert.deepStrictEqual(result.skipped, []);
		});
	});

	suite('ComfyTV ImageStage 控件对齐（对齐 generators.py）', () => {

		test('registerDefaultComfyTVStages 的 ImageStage 回退控件与 ComfyTV 上游一致（workflow/resolution/aspect_ratio/batch_size）', () => {
			cleanup(['ComfyTV.ImageStage']);
			// 直接调用回退注册
			const { registerDefaultComfyTVStages } = require('../../webview/src/features/workflowEditor/comfyHost/registry.js') as typeof import('../../webview/src/features/workflowEditor/comfyHost/registry.js');
			registerDefaultComfyTVStages();
			const spec = getNodeSpec('ComfyTV.ImageStage');
			assert.ok(spec, 'ImageStage 已注册');
			const names = (spec!.widgets ?? []).map(w => w.name);
			// ComfyTV 真实字段：workflow/resolution/aspect_ratio/batch_size/prompt，
			// 无 seed/width/height/steps（分辨率由 resolution+aspect_ratio 推导）。
			assert.deepStrictEqual(names, ['workflow', 'resolution', 'aspect_ratio', 'batch_size', 'prompt']);
			assert.strictEqual(spec!.widgets!.find(w => w.name === 'workflow')!.default, COMFYTV_IMAGE_WORKFLOWS[0]);
			const resolution = spec!.widgets!.find(w => w.name === 'resolution')!;
			assert.ok((resolution.options ?? []).includes('1K'));
			cleanup(['ComfyTV.ImageStage']);
		});

		test('registerComfyTVNode 覆盖时保留已有 widgets + 端口（/comfytv/stages 元数据无 widgets/ports）', () => {
			cleanup(['ComfyTV.ImageStage']);
			// 先注册带控件 + Autogrow 端口（模拟回退表的 texts/images）
			registerComfyTVNode({
				type: 'ComfyTV.ImageStage',
				kind: 'image',
				workflowKind: 'image-to-image',
				inputs: [{ name: 'texts', type: 'COMFYTV_TEXT' }, { name: 'images', type: 'COMFYTV_IMAGE' }],
				outputs: [{ name: 'images', type: 'COMFYTV_IMAGES' }],
				widgets: [
					{ name: 'workflow', type: 'COMBO', default: 'Local SD1.5', options: ['Local SD1.5'] },
					{ name: 'prompt', type: 'TEXT', default: '' },
				],
			});
			// 再用 /comfytv/stages 元数据覆盖（无 widgets、空 ports）→ 控件与端口不能丢
			registerComfyTVNode({ type: 'ComfyTV.ImageStage', kind: 'image', workflowKind: 'image', inputs: [], outputs: [] });
			const spec = getNodeSpec('ComfyTV.ImageStage')!;
			assert.strictEqual((spec.widgets ?? []).length, 2, '覆盖后控件保留');
			assert.strictEqual(spec.widgets![0].name, 'workflow');
			assert.strictEqual(spec.inputs.length, 2, '覆盖后 Autogrow 输入端口保留');
			assert.strictEqual(spec.inputs[0].name, 'texts');
			assert.strictEqual(spec.outputs[0].name, 'images');
			cleanup(['ComfyTV.ImageStage']);
		});

		test('patchComfyTVWorkflowOptions 填充 workflow 控件 options（ComfyTV 上游 labels_for 等价）', () => {
			cleanup(['ComfyTV.ImageStage']);
			registerComfyTVNode({
				type: 'ComfyTV.ImageStage',
				kind: 'image',
				widgets: [{ name: 'workflow', type: 'COMBO', default: '', options: [] }],
			});
			patchComfyTVWorkflowOptions(['Local SD1.5', 'Local SD1.5 I2I', 'Image Ideogram4 T2I']);
			const wf = getNodeSpec('ComfyTV.ImageStage')!.widgets!.find(w => w.name === 'workflow')!;
			assert.deepStrictEqual(wf.options, ['Local SD1.5', 'Local SD1.5 I2I', 'Image Ideogram4 T2I']);
			cleanup(['ComfyTV.ImageStage']);
		});

		test('patchComfyTVWorkflowOptions 空列表不动作', () => {
			cleanup(['ComfyTV.ImageStage']);
			registerComfyTVNode({ type: 'ComfyTV.ImageStage', kind: 'image', widgets: [{ name: 'workflow', type: 'COMBO', default: '', options: [] }] });
			patchComfyTVWorkflowOptions([]);
			assert.deepStrictEqual(getNodeSpec('ComfyTV.ImageStage')!.widgets!.find(w => w.name === 'workflow')!.options, []);
			cleanup(['ComfyTV.ImageStage']);
		});
	});

	suite('registerDefaultComfyTVStages 全量复刻', () => {

		test('171 个 ComfyTV stage 全部注册（与 get_node_list 对齐）', () => {
			const { registerDefaultComfyTVStages } = require('../../webview/src/features/workflowEditor/comfyHost/registry.js') as typeof import('../../webview/src/features/workflowEditor/comfyHost/registry.js');
			registerDefaultComfyTVStages();
			const all = getAllSpecs();
			const overrideNative = new Set([
				// 浏览器本地 editor/instant 覆盖（非运行型 stage）
				'ComfyTV.RelightStage', 'ComfyTV.PosterStage', 'ComfyTV.LayerEditorStage',
				'ComfyTV.StoryboardEditorStage', 'ComfyTV.MaterialStage', 'ComfyTV.Scene3DStage',
				'ComfyTV.CropStage', 'ComfyTV.RotateStage', 'ComfyTV.MirrorStage',
			]);
			for (const meta of COMFYTV_STAGE_META) {
				const spec = getNodeSpec(meta.nodeId);
				assert.ok(spec, `${meta.nodeId} 未注册`);
				if (overrideNative.has(meta.nodeId)) { continue; } // native 覆盖例外
				assert.strictEqual(spec!.comfyTV?.stageKind, meta.kind, `${meta.nodeId} kind 不匹配`);
				assert.strictEqual(spec!.title, meta.title, `${meta.nodeId} title 不匹配`);
			}
			// 清理（避免污染其它测试）
			for (const meta of COMFYTV_STAGE_META) { unregisterNodeSpec(meta.nodeId); }
			// 清理 bridge/instant/editor 等手动注册节点
			for (const spec of all) {
				if (spec.type.startsWith('ComfyTV.')) { unregisterNodeSpec(spec.type); }
			}
		});

		test('ImageStage 控件精确对齐（workflow/resolution/aspect_ratio/batch_size/prompt）', () => {
			const { registerDefaultComfyTVStages } = require('../../webview/src/features/workflowEditor/comfyHost/registry.js') as typeof import('../../webview/src/features/workflowEditor/comfyHost/registry.js');
			registerDefaultComfyTVStages();
			const spec = getNodeSpec('ComfyTV.ImageStage')!;
			const names = (spec.widgets ?? []).map(w => w.name);
			assert.deepStrictEqual(names, ['workflow', 'resolution', 'aspect_ratio', 'batch_size', 'prompt']);
			assert.strictEqual(spec.inputs.length, 2);
			assert.strictEqual(spec.outputs.length, 2);
			for (const meta of COMFYTV_STAGE_META) { unregisterNodeSpec(meta.nodeId); }
		});

		test('VideoStage 控件精确对齐（workflow/resolution/aspect_ratio/duration_s/generate_audio/prompt）', () => {
			const { registerDefaultComfyTVStages } = require('../../webview/src/features/workflowEditor/comfyHost/registry.js') as typeof import('../../webview/src/features/workflowEditor/comfyHost/registry.js');
			registerDefaultComfyTVStages();
			const spec = getNodeSpec('ComfyTV.VideoStage')!;
			const names = (spec.widgets ?? []).map(w => w.name);
			assert.deepStrictEqual(names, ['workflow', 'resolution', 'aspect_ratio', 'duration_s', 'generate_audio', 'prompt']);
			assert.strictEqual(spec.outputs[0].name, 'videos');
			for (const meta of COMFYTV_STAGE_META) { unregisterNodeSpec(meta.nodeId); }
		});

		test('泛型 stage 注册 schema + workflow widget + kind 输出端口', () => {
			const { registerDefaultComfyTVStages } = require('../../webview/src/features/workflowEditor/comfyHost/registry.js') as typeof import('../../webview/src/features/workflowEditor/comfyHost/registry.js');
			registerDefaultComfyTVStages();
			const spec = getNodeSpec('ComfyTV.GlowStage')!; // 泛型 video stage
			assert.strictEqual(spec.kind, 'schema');
			assert.strictEqual(spec.outputs[0].type, 'COMFYTV_VIDEO');
			assert.strictEqual(spec.comfyTV?.stageKind, 'video');
			const names = (spec.widgets ?? []).map(w => w.name);
			assert.deepStrictEqual(names, ['workflow']);
			for (const meta of COMFYTV_STAGE_META) { unregisterNodeSpec(meta.nodeId); }
		});
	});

	suite('loadComfyTVStages (HTTP)', () => {

		test('fetches and registers stages', async () => {
			cleanup(['ComfyTV.C']);
			const fakeFetch = async (url: string) => ({
				ok: true,
				status: 200,
				json: async () => ({ stages: [{ node_id: 'ComfyTV.C', kind: 'video' }] }),
			});
			const result = await loadComfyTVStages('http://x:8188', fakeFetch as never);
			assert.strictEqual(result.error, undefined);
			assert.strictEqual(result.registered.length, 1);
			assert.strictEqual(getNodeSpec('ComfyTV.C')?.outputs[0].type, 'VIDEO');
			cleanup(['ComfyTV.C']);
		});

		test('trims trailing slash from baseUrl', async () => {
			const called: string[] = [];
			const fakeFetch = async (url: string) => {
				called.push(url);
				return { ok: true, status: 200, json: async () => ({ stages: [] }) };
			};
			await loadComfyTVStages('http://x:8188/', fakeFetch as never);
			// 首次是 stages；其后可能异步拉 workflows（options 填充）。
			assert.strictEqual(called[0], 'http://x:8188/comfytv/stages');
			assert.ok(called.every(u => !u.startsWith('http://x:8188//')), '无双斜杠');
		});

		test('non-ok response → error, no registration', async () => {
			const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
			const result = await loadComfyTVStages('http://x:8188', fakeFetch as never);
			assert.match(result.error ?? '', /404/);
			assert.strictEqual(result.registered.length, 0);
		});

		test('network throw → error, graceful', async () => {
			const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
			const result = await loadComfyTVStages('http://x:8188', fakeFetch as never);
			assert.match(result.error ?? '', /ECONNREFUSED/);
			assert.strictEqual(result.registered.length, 0);
		});
	});
});
