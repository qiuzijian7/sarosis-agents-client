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
import { getNodeSpec, unregisterNodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

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
			let called = '';
			const fakeFetch = async (url: string) => {
				called = url;
				return { ok: true, status: 200, json: async () => ({ stages: [] }) };
			};
			await loadComfyTVStages('http://x:8188/', fakeFetch as never);
			assert.strictEqual(called, 'http://x:8188/comfytv/stages');
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
