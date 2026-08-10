/*---------------------------------------------------------------------------------------------
 *  Unit tests for comfyObjectInfoLoader — /object_info dynamic native-node registration.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	registerObjectInfoNodes,
	loadObjectInfoNodes,
	type ComfyObjectInfo,
} from '../../webview/src/features/workflowEditor/comfyHost/comfyObjectInfoLoader.js';
import { getNodeSpec, unregisterNodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

const SAMPLE_INFO: ComfyObjectInfo = {
	KSampler: {
		input: {
			required: {
				seed: ['INT', { default: 0 }],
				steps: ['INT', { default: 20 }],
				model: ['MODEL'],
			},
		},
		output: ['LATENT'],
		output_name: ['LATENT'],
		display_name: 'KSampler',
		category: 'sampling',
	},
	LoadImage: {
		input: { required: { image: ['STRING', { default: 'x.png' }] } },
		output: ['IMAGE', 'MASK'],
		output_name: ['IMAGE', 'MASK'],
		display_name: 'Load Image',
		category: 'image/loaders',
	},
	NotCategory: {
		input: {},
		output: ['IMAGE'],
		output_name: ['IMAGE'],
		display_name: 'Other',
		category: 'advanced',
	},
};

function cleanup(names: string[]): void {
	for (const n of names) { unregisterNodeSpec(n); }
}

suite('comfyObjectInfoLoader', () => {

	suite('registerObjectInfoNodes', () => {

		test('registers native nodes with derived widgets', () => {
			cleanup(['KSampler', 'LoadImage', 'NotCategory']);
			const result = registerObjectInfoNodes(SAMPLE_INFO);
			assert.strictEqual(result.total, 3);
			assert.strictEqual(result.registered.length, 3);
			const ks = getNodeSpec('KSampler');
			assert.ok(ks);
			assert.strictEqual(ks!.kind, 'native');
			assert.strictEqual(ks!.inputs[0].name, 'seed');
			assert.strictEqual(ks!.widgets!.length, 3);
			cleanup(['KSampler', 'LoadImage', 'NotCategory']);
		});

		test('category filter skips non-matching entries', () => {
			cleanup(['KSampler', 'LoadImage', 'NotCategory']);
			const result = registerObjectInfoNodes(SAMPLE_INFO, {
				categoryFilter: c => (c ?? '').startsWith('sampling') || (c ?? '').startsWith('image'),
			});
			assert.strictEqual(result.registered.length, 2);
			assert.strictEqual(result.skipped.length, 1);
			assert.strictEqual(result.skipped[0], 'NotCategory');
			cleanup(['KSampler', 'LoadImage', 'NotCategory']);
		});

		test('duplicate registration reported as skipped', () => {
			cleanup(['Dup']);
			registerObjectInfoNodes({ Dup: { output: ['IMAGE'], output_name: ['IMAGE'] } });
			const again = registerObjectInfoNodes({ Dup: { output: ['IMAGE'], output_name: ['IMAGE'] } });
			assert.strictEqual(again.registered.length, 0);
			assert.strictEqual(again.skipped.length, 1);
			cleanup(['Dup']);
		});

		test('multi-output nodes map all outputs', () => {
			cleanup(['LoadImage']);
			registerObjectInfoNodes({ LoadImage: SAMPLE_INFO.LoadImage });
			const spec = getNodeSpec('LoadImage')!;
			assert.strictEqual(spec.outputs.length, 2);
			assert.strictEqual(spec.outputs[0].name, 'IMAGE');
			assert.strictEqual(spec.outputs[1].name, 'MASK');
			cleanup(['LoadImage']);
		});
	});

	suite('loadObjectInfoNodes (HTTP)', () => {

		test('fetches and registers', async () => {
			cleanup(['KSampler']);
			const fakeFetch = async (url: string) => ({
				ok: true,
				status: 200,
				json: async () => ({ KSampler: SAMPLE_INFO.KSampler }),
			});
			const result = await loadObjectInfoNodes('http://x:8188', fakeFetch as never);
			assert.strictEqual(result.error, undefined);
			assert.strictEqual(result.registered.length, 1);
			assert.ok(getNodeSpec('KSampler'));
			cleanup(['KSampler']);
		});

		test('trims trailing slash', async () => {
			let called = '';
			const fakeFetch = async (url: string) => {
				called = url;
				return { ok: true, status: 200, json: async () => ({}) };
			};
			await loadObjectInfoNodes('http://x:8188/', fakeFetch as never);
			assert.strictEqual(called, 'http://x:8188/object_info');
		});

		test('non-ok → error, graceful', async () => {
			const fakeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
			const result = await loadObjectInfoNodes('http://x:8188', fakeFetch as never);
			assert.match(result.error ?? '', /500/);
			assert.strictEqual(result.registered.length, 0);
		});

		test('network throw → error, graceful', async () => {
			const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
			const result = await loadObjectInfoNodes('http://x:8188', fakeFetch as never);
			assert.match(result.error ?? '', /ECONNREFUSED/);
			assert.strictEqual(result.total, 0);
		});

		test('applies category filter through fetch path', async () => {
			cleanup(['KSampler']);
			const fakeFetch = async () => ({
				ok: true, status: 200, json: async () => SAMPLE_INFO,
			});
			const result = await loadObjectInfoNodes('http://x:8188', fakeFetch as never, {
				categoryFilter: c => c === 'sampling',
			});
			assert.strictEqual(result.registered.length, 1);
			assert.ok(getNodeSpec('KSampler'));
			cleanup(['KSampler']);
		});
	});
});
