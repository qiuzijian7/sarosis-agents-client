/*---------------------------------------------------------------------------------------------
 *  Unit tests for imageGenBackend — provider/ComfyUI image-generation backends + pure helpers.
 *  Mirrors workflowComfyRunner.test.ts style (injectable network, no live server).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	parseSize,
	normalizeImageGenValues,
	buildProviderImageBody,
	providerImagesToMedia,
	buildComfyTxt2ImgPrompt,
	comfyOutputsToMedia,
	findUpstreamImageRef,
	buildLoadImageInput,
	createLLMProviderBackend,
	createComfyImageBackend,
	type ImageGenNodeValues,
	type IImageGenProviderLike,
} from '../../webview/src/features/workflowEditor/comfyHost/imageGenBackend.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

function makeStore(): MediaSnapshotStore {
	const map = new Map<string, unknown>();
	return new MediaSnapshotStore({
		async save(key, data) { map.set(key, data); return key; },
		async load(key) { return map.get(key) ?? null; },
		async remove(key) { map.delete(key); },
	});
}
import type { IComfyRunner } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';

// ─── Pure helpers ──────────────────────────────────────────────────────────────

suite('imageGenBackend — parseSize', () => {

	test('parses WxH variants', () => {
		assert.deepStrictEqual(parseSize('1024x1024'), { width: 1024, height: 1024 });
		assert.deepStrictEqual(parseSize('768X512'), { width: 768, height: 512 });
		assert.deepStrictEqual(parseSize('512×512'), { width: 512, height: 512 });
	});

	test('falls back to explicit width/height', () => {
		assert.deepStrictEqual(parseSize(undefined, 640, 480), { width: 640, height: 480 });
		assert.deepStrictEqual(parseSize('bad', 200, 100), { width: 200, height: 100 });
	});

	test('empty/invalid string or zero dims → {}', () => {
		assert.deepStrictEqual(parseSize(''), {});
		assert.deepStrictEqual(parseSize('0x0'), {});
		assert.deepStrictEqual(parseSize('bad'), {});
	});

	test('explicit undefined width/height → {}', () => {
		assert.deepStrictEqual(parseSize(undefined, undefined, undefined), {});
	});
});

suite('imageGenBackend — normalizeImageGenValues', () => {

	test('defaults numImages to 1, trims prompt', () => {
		const n = normalizeImageGenValues({ prompt: '  a cat  ' });
		assert.strictEqual(n.prompt, 'a cat');
		assert.strictEqual(n.numImages, 1);
		assert.strictEqual(n.negativePrompt, undefined);
		assert.strictEqual(n.modelId, undefined);
	});

	test('size string wins over width/height', () => {
		const n = normalizeImageGenValues({ prompt: 'x', size: '768x768', width: 1024, height: 1024 });
		assert.strictEqual(n.width, 768);
		assert.strictEqual(n.height, 768);
	});

	test('clamps numImages / drops non-positive steps', () => {
		const n = normalizeImageGenValues({ prompt: 'x', numImages: 4.9, steps: 0, seed: 42 });
		assert.strictEqual(n.numImages, 4);
		assert.strictEqual(n.steps, undefined);
		assert.strictEqual(n.seed, 42);
	});
});

suite('imageGenBackend — buildProviderImageBody', () => {

	test('core fields for txt2img', () => {
		const body = buildProviderImageBody({ prompt: 'cat', numImages: 1, modelId: 'flux', width: 1024, height: 1024 });
		assert.strictEqual(body.model, 'flux');
		assert.strictEqual(body.prompt, 'cat');
		assert.strictEqual(body.size, '1024x1024');
		assert.strictEqual(body.n, 1);
		assert.strictEqual(body.input_image, undefined);
	});

	test('negative prompt + seed + img2img input_image', () => {
		const body = buildProviderImageBody({
			prompt: 'dog', negativePrompt: 'blurry', seed: 7, numImages: 2, imageInput: 'https://img/x.png',
		});
		assert.strictEqual(body.negative_prompt, 'blurry');
		assert.strictEqual(body.seed, 7);
		assert.strictEqual(body.n, 2);
		assert.strictEqual(body.input_image, 'https://img/x.png');
	});
});

suite('imageGenBackend — providerImagesToMedia', () => {

	test('maps url and b64 to image refs', () => {
		const media = providerImagesToMedia({ images: [{ url: 'https://cdn/a.png' }, { b64: 'aGk=' }] });
		assert.strictEqual(media.length, 2);
		assert.strictEqual(media[0].kind, 'image');
		assert.strictEqual(media[0].ref, 'https://cdn/a.png');
		assert.strictEqual(media[1].ref, 'data:image/png;base64,aGk=');
	});

	test('skips empty entries', () => {
		const media = providerImagesToMedia({ images: [{}, { url: '' }, { b64: '' }, { url: 'x' }] });
		assert.strictEqual(media.length, 1);
		assert.strictEqual(media[0].ref, 'x');
	});
});

suite('imageGenBackend — buildComfyTxt2ImgPrompt', () => {

	test('produces a connected api.json with save node', () => {
		const prompt = buildComfyTxt2ImgPrompt({ prompt: 'cat', numImages: 1, width: 512, height: 768, steps: 20, seed: 123 });
		assert.ok(prompt.save);
		const sampler = prompt.sampler as { inputs: { seed: number; steps: number; positive: unknown } };
		assert.strictEqual(sampler.inputs.seed, 123);
		assert.strictEqual(sampler.inputs.steps, 20);
		assert.deepStrictEqual(sampler.inputs.positive, ['pos', 0]);
		const vae = prompt.vae as { inputs: { samples: unknown } };
		assert.deepStrictEqual(vae.inputs.samples, ['sampler', 0]);
	});

	test('negative prompt wired and defaults applied', () => {
		const prompt = buildComfyTxt2ImgPrompt({ prompt: 'x', negativePrompt: 'blur', numImages: 1 });
		const neg = prompt.neg as { inputs: { text: string } };
		assert.strictEqual(neg.inputs.text, 'blur');
		const sampler = prompt.sampler as { inputs: { steps: number } };
		assert.strictEqual(sampler.inputs.steps, 30); // DEFAULT_STEPS
	});
});

suite('imageGenBackend — comfyOutputsToMedia', () => {

	test('extracts save.images with meta', () => {
		const media = comfyOutputsToMedia({
			save: { images: [{ filename: 'sarosis_gen_00001.png', subfolder: '', type: 'output' }] },
		});
		assert.strictEqual(media.length, 1);
		assert.strictEqual(media[0].kind, 'image');
		assert.strictEqual(media[0].ref, 'sarosis_gen_00001.png');
		assert.deepStrictEqual(media[0].meta, { subfolder: '', type: 'output' });
	});

	test('empty / missing save node → []', () => {
		assert.deepStrictEqual(comfyOutputsToMedia(undefined), []);
		assert.deepStrictEqual(comfyOutputsToMedia({}), []);
		assert.deepStrictEqual(comfyOutputsToMedia({ save: {} }), []);
	});
});

// ─── Provider backend ─────────────────────────────────────────────────────────

suite('imageGenBackend — createLLMProviderBackend', () => {

	function fakeProvider(overrides?: Partial<IImageGenProviderLike>): IImageGenProviderLike {
		return {
			async listModels() { return [{ id: 'flux', supportsImageGen: true }]; },
			async generateImage(p) { return { images: [{ url: `https://img/${p.prompt}.png` }] }; },
			...overrides,
		};
	}

	test('testConnection ok when an image-gen model exists', async () => {
		const backend = createLLMProviderBackend({ id: 'p1', provider: fakeProvider() });
		const st = await backend.testConnection();
		assert.strictEqual(st.ok, true);
		assert.match(st.message ?? '', /1 image-gen model/);
	});

	test('testConnection fails without image-gen models', async () => {
		const backend = createLLMProviderBackend({
			id: 'p1',
			provider: fakeProvider({ listModels: async () => [{ id: 'gpt-4o' }] }),
		});
		const st = await backend.testConnection();
		assert.strictEqual(st.ok, false);
	});

	test('testConnection catches provider errors', async () => {
		const backend = createLLMProviderBackend({
			id: 'p1',
			provider: fakeProvider({ listModels: async () => { throw new Error('boom'); } }),
		});
		const st = await backend.testConnection();
		assert.strictEqual(st.ok, false);
		assert.match(st.message ?? '', /boom/);
	});

	test('generate maps provider images to media + meta', async () => {
		const backend = createLLMProviderBackend({ id: 'p1', provider: fakeProvider() });
		const out = await backend.generate({ prompt: 'cat', numImages: 1, modelId: 'flux', seed: 9 });
		assert.strictEqual(out.media.length, 1);
		assert.strictEqual(out.media[0].ref, 'https://img/cat.png');
		assert.strictEqual(out.meta?.providerId, 'p1');
		assert.strictEqual(out.meta?.modelId, 'flux');
	});

	test('generate throws when provider rejects', async () => {
		const backend = createLLMProviderBackend({
			id: 'p1',
			provider: fakeProvider({ generateImage: async () => { throw new Error('API 401'); } }),
		});
		await assert.rejects(() => backend.generate({ prompt: 'x', numImages: 1, modelId: 'flux' }), /401/);
	});
});

// ─── findUpstreamImageRef / buildLoadImageInput ──────────────────────────────

suite('imageGenBackend — findUpstreamImageRef', () => {

	test('returns first upstream IMAGE ref in execution order', () => {
		const store = makeStore();
		store.put({ nodeId: 'a', port: 'output', key: 'a:output:0', media: { kind: 'image', ref: 'u1' }, index: 0 });
		store.put({ nodeId: 'b', port: 'output', key: 'b:output:0', media: { kind: 'image', ref: 'u2' }, index: 0 });
		assert.strictEqual(findUpstreamImageRef(store, ['a', 'b']), 'u1');
	});

	test('skips non-image / empty refs', () => {
		const store = makeStore();
		store.put({ nodeId: 'a', port: 'output', key: 'a:output:0', media: { kind: 'text', ref: 'x' }, index: 0 });
		store.put({ nodeId: 'b', port: 'output', key: 'b:output:0', media: { kind: 'image', ref: '' }, index: 0 });
		store.put({ nodeId: 'c', port: 'output', key: 'c:output:0', media: { kind: 'image', ref: 'u3' }, index: 0 });
		assert.strictEqual(findUpstreamImageRef(store, ['a', 'b', 'c']), 'u3');
	});

	test('undefined upstreams → undefined', () => {
		assert.strictEqual(findUpstreamImageRef(makeStore(), undefined), undefined);
	});
});

suite('imageGenBackend — buildLoadImageInput', () => {

	test('maps ref to LoadImage image input', () => {
		assert.deepStrictEqual(buildLoadImageInput('http://cdn/a.png'), { image: 'http://cdn/a.png', upload: 'image' });
	});

	test('empty ref → undefined', () => {
		assert.strictEqual(buildLoadImageInput(undefined), undefined);
		assert.strictEqual(buildLoadImageInput(''), undefined);
	});
});

// ─── Comfy backend ────────────────────────────────────────────────────────────

suite('imageGenBackend — createComfyImageBackend', () => {

	function fakeRunner(overrides?: Partial<IComfyRunner>): IComfyRunner {
		return {
			id: 'local',
			kind: 'local',
			baseUrl: 'http://127.0.0.1:8188',
			async testConnection() { return { ok: true, version: 'v1.10.5' }; },
			async invoke() { return { promptId: 'p1', outputs: { save: { images: [{ filename: 'out.png' }] } }, status: 'success' }; },
			...overrides,
		};
	}

	test('testConnection forwards runner status', async () => {
		const backend = createComfyImageBackend({ id: 'c1', runner: fakeRunner() });
		const st = await backend.testConnection();
		assert.strictEqual(st.ok, true);
		assert.strictEqual(st.message, 'v1.10.5');
	});

	test('generate builds prompt + maps save outputs', async () => {
		let receivedPrompt: unknown;
		const runner = fakeRunner({
			async invoke(opts) {
				receivedPrompt = opts.prompt;
				return { promptId: 'p1', outputs: { save: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }, status: 'success' };
			},
		});
		const backend = createComfyImageBackend({ id: 'c1', runner });
		const out = await backend.generate({ prompt: 'cat', numImages: 1, width: 512, height: 512 });
		assert.ok(receivedPrompt);
		const sampler = (receivedPrompt as Record<string, { inputs: unknown }>).sampler.inputs as { steps: number };
		assert.strictEqual(sampler.steps, 30);
		assert.strictEqual(out.media.length, 1);
		assert.strictEqual(out.media[0].ref, 'out.png');
		assert.strictEqual(out.meta?.providerId, 'c1');
	});

	test('generate throws on non-success result', async () => {
		const runner = fakeRunner({ invoke: async () => ({ promptId: 'p1', outputs: {}, status: 'error', error: 'ComfyUI execution error' }) });
		const backend = createComfyImageBackend({ id: 'c1', runner });
		await assert.rejects(() => backend.generate({ prompt: 'x', numImages: 1 }), /ComfyUI execution error/);
	});
});
