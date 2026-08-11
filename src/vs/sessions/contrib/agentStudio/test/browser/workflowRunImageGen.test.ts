/*---------------------------------------------------------------------------------------------
 *  Unit tests for workflowRun P1 provider image-gen support:
 *   - isExecutableSpec / isLLMImageNode (plan membership)
 *   - runProviderImage (imagegen.generate RPC → snapshot entries)
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	isExecutableSpec,
	isLLMImageNode,
	runProviderImage,
	runProviderPickerNode,
	resolveFirstImageGenDefaults,
	parseProviderPickerConfig,
	collectUpstreamProviderConfig,
	isLoadImageNode,
	resolveLoadImageInputForNode,
} from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

/** In-memory backend so the real MediaSnapshotStore works in tests. */
function makeStore(): MediaSnapshotStore {
	const map = new Map<string, unknown>();
	return new MediaSnapshotStore({
		async save(key, data) { map.set(key, data); return key; },
		async load(key) { return map.get(key) ?? null; },
		async remove(key) { map.delete(key); },
	});
}

// ─── Spec predicates ──────────────────────────────────────────────────────────

suite('workflowRun — isExecutableSpec / isLLMImageNode', () => {

	test('schema/native are Comfy-executable; llm is executable via provider', () => {
		assert.strictEqual(isExecutableSpec({ kind: 'schema' }), true);
		assert.strictEqual(isExecutableSpec({ kind: 'native' }), true);
		assert.strictEqual(isExecutableSpec({ kind: 'llm' }), true);
		assert.strictEqual(isExecutableSpec({ kind: 'react' }), false);
		assert.strictEqual(isExecutableSpec(undefined), false);
	});

	test('isLLMImageNode only matches kind llm', () => {
		assert.strictEqual(isLLMImageNode({ kind: 'llm' }), true);
		assert.strictEqual(isLLMImageNode({ kind: 'schema' }), false);
		assert.strictEqual(isLLMImageNode({ kind: 'llm', backendKind: 'provider' }), true);
	});
});

// ─── resolveFirstImageGenDefaults ────────────────────────────────────────────

suite('workflowRun — resolveFirstImageGenDefaults', () => {

	test('picks first authenticated provider with an image-gen model', () => {
		const d = resolveFirstImageGenDefaults([
			{ id: 'a', authStatus: 'pending', models: [{ id: 'x', supportsImageGen: true }] },
			{ id: 'b', authStatus: 'authenticated', models: [{ id: 'y', supportsImageGen: true }] },
		]);
		assert.deepStrictEqual(d, { providerId: 'b', modelId: 'y' });
	});

	test('skips providers without image-gen models', () => {
		const d = resolveFirstImageGenDefaults([
			{ id: 'a', authStatus: 'authenticated', models: [{ id: 'x' }] },
			{ id: 'b', authStatus: 'authenticated', models: [{ id: 'y', supportsImageGen: true }] },
		]);
		assert.deepStrictEqual(d, { providerId: 'b', modelId: 'y' });
	});

	test('returns undefined when nothing matches', () => {
		assert.strictEqual(resolveFirstImageGenDefaults(undefined), undefined);
		assert.strictEqual(resolveFirstImageGenDefaults([]), undefined);
		assert.strictEqual(resolveFirstImageGenDefaults([{ id: 'a', authStatus: 'pending', models: [] }]), undefined);
	});
});

// ─── runProviderImage ─────────────────────────────────────────────────────────

suite('workflowRun — runProviderImage', () => {

	function baseInput(overrides?: Partial<Parameters<typeof runProviderImage>[0]>) {
		return {
			runner: {} as never,
			nodeId: 'n1',
			type: 'Sarosis.ModelImageGen',
			getSpec: () => ({ kind: 'llm' as const }),
			values: { providerId: 'openrouter', modelId: 'flux', prompt: 'a cat' },
			store: makeStore(),
			onProgress: () => {},
			...overrides,
		};
	}

	test('success: maps url image into snapshot entry under primary key', async () => {
		const store = makeStore();
		const r = await runProviderImage(baseInput({
			store,
			sendImageGen: async () => ({ images: [{ url: 'https://cdn/x.png' }] }),
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries.length, 1);
		assert.strictEqual(r.entries[0].nodeId, 'n1');
		assert.strictEqual(r.entries[0].key, 'n1:output:0');
		assert.strictEqual(r.entries[0].media.ref, 'https://cdn/x.png');
		assert.strictEqual(store.byNode('n1').length, 1);
	});

	test('success: b64 image becomes data URL; multiple images indexed', async () => {
		const r = await runProviderImage(baseInput({
			values: { providerId: 'p', modelId: 'm', prompt: 'x', numImages: 2 },
			sendImageGen: async () => ({ images: [{ b64: 'QUJD' }, { b64: 'REVG' }] }),
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries.length, 2);
		assert.strictEqual(r.entries[0].media.ref, 'data:image/png;base64,QUJD');
		assert.strictEqual(r.entries[1].key, 'n1:output:1');
	});

	test('size "WxH" wins over explicit width/height in payload', async () => {
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		await runProviderImage(baseInput({
			values: { providerId: 'p', modelId: 'm', prompt: 'x', size: '768x768', width: 1024, height: 1024 },
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(captured?.width, 768);
		assert.strictEqual(captured?.height, 768);
	});

	test('missing provider/model/prompt → friendly error, no send', async () => {
		let called = false;
		const r = await runProviderImage(baseInput({
			values: {},
			sendImageGen: async () => { called = true; return { images: [] }; },
		}));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /Provider 和文生图模型/);
		assert.strictEqual(called, false);
	});

	test('auto-routing: resolveImageGenDefaults fills missing provider/model', async () => {
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		const r = await runProviderImage(baseInput({
			values: { prompt: 'a cat' }, // no providerId/modelId
			resolveImageGenDefaults: async () => ({ providerId: 'openrouter', modelId: 'flux' }),
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.providerId, 'openrouter');
		assert.strictEqual(captured?.modelId, 'flux');
	});

	test('auto-routing: explicit values win over defaults', async () => {
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		const r = await runProviderImage(baseInput({
			values: { providerId: 'mine', modelId: 'my-model', prompt: 'x' },
			resolveImageGenDefaults: async () => ({ providerId: 'openrouter', modelId: 'flux' }),
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.providerId, 'mine');
		assert.strictEqual(captured?.modelId, 'my-model');
	});

	test('auto-routing: partial values keep explicit side, fill missing side', async () => {
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		const r = await runProviderImage(baseInput({
			values: { providerId: 'mine', prompt: 'x' }, // modelId missing
			resolveImageGenDefaults: async () => ({ providerId: 'openrouter', modelId: 'flux' }),
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.providerId, 'mine');
		assert.strictEqual(captured?.modelId, 'flux');
	});

	test('auto-routing: no defaults → friendly error', async () => {
		const r = await runProviderImage(baseInput({
			values: { prompt: 'x' },
			resolveImageGenDefaults: async () => undefined,
			sendImageGen: async () => ({ images: [{ url: 'u' }] }),
		}));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /Provider 和文生图模型/);
	});

	test('img2img: upstream IMAGE snapshot becomes imageInput', async () => {
		const store = makeStore();
		store.put({
			nodeId: 'upstream', port: 'output', key: 'upstream:output:0',
			media: { kind: 'image', ref: 'https://cdn/up.png' }, index: 0,
		});
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		const r = await runProviderImage(baseInput({
			store,
			upstreams: ['upstream'],
			values: { providerId: 'p', modelId: 'm', prompt: 'x' },
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.imageInput, 'https://cdn/up.png');
	});

	test('img2img: explicit values.imageInput wins over upstream snapshot', async () => {
		const store = makeStore();
		store.put({
			nodeId: 'upstream', port: 'output', key: 'upstream:output:0',
			media: { kind: 'image', ref: 'https://cdn/up.png' }, index: 0,
		});
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		const r = await runProviderImage(baseInput({
			store,
			upstreams: ['upstream'],
			values: { providerId: 'p', modelId: 'm', prompt: 'x', imageInput: 'https://cdn/direct.png' },
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.imageInput, 'https://cdn/direct.png');
	});

	test('img2img: no upstream image → imageInput undefined, still runs', async () => {
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		const r = await runProviderImage(baseInput({
			upstreams: ['upstream'],
			values: { providerId: 'p', modelId: 'm', prompt: 'x' },
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.imageInput, undefined);
	});

	test('provider picker config consumed from upstream TEXT snapshot', async () => {
		const store = makeStore();
		store.put({
			nodeId: 'picker', port: 'output', key: 'picker:output:0',
			media: { kind: 'text', ref: 'provider:openrouter:flux' }, index: 0,
		});
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		const r = await runProviderImage(baseInput({
			store,
			upstreams: ['picker'],
			values: { prompt: 'x' }, // no provider/model → picker
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.providerId, 'openrouter');
		assert.strictEqual(captured?.modelId, 'flux');
	});

	test('explicit values beat upstream picker config', async () => {
		const store = makeStore();
		store.put({
			nodeId: 'picker', port: 'output', key: 'picker:output:0',
			media: { kind: 'text', ref: 'provider:openrouter:flux' }, index: 0,
		});
		let captured: Parameters<NonNullable<Parameters<typeof runProviderImage>[0]['sendImageGen']>>[0] | undefined;
		const r = await runProviderImage(baseInput({
			store,
			upstreams: ['picker'],
			values: { providerId: 'mine', modelId: 'my-model', prompt: 'x' },
			sendImageGen: async (p) => { captured = p; return { images: [{ url: 'u' }] }; },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(captured?.providerId, 'mine');
		assert.strictEqual(captured?.modelId, 'my-model');
	});

	test('no injected sendImageGen → error', async () => {
		const r = await runProviderImage(baseInput());
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /未注入/);
	});

	test('empty images from backend → error', async () => {
		const r = await runProviderImage(baseInput({
			sendImageGen: async () => ({ images: [] }),
		}));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /未返回图片/);
	});

	test('RPC rejection surfaces message', async () => {
		const r = await runProviderImage(baseInput({
			sendImageGen: async () => { throw new Error('API 401'); },
		}));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /401/);
	});
});

// ─── Provider Picker ─────────────────────────────────────────────────────────

suite('workflowRun — parseProviderPickerConfig / collectUpstreamProviderConfig', () => {

	test('parses provider:providerId:modelId', () => {
		assert.deepStrictEqual(parseProviderPickerConfig('provider:openrouter:flux'), { providerId: 'openrouter', modelId: 'flux' });
	});

	test('rejects malformed / empty values', () => {
		assert.strictEqual(parseProviderPickerConfig(undefined), undefined);
		assert.strictEqual(parseProviderPickerConfig(''), undefined);
		assert.strictEqual(parseProviderPickerConfig('openrouter:flux'), undefined);
		assert.strictEqual(parseProviderPickerConfig('provider:openrouter'), undefined);
		assert.strictEqual(parseProviderPickerConfig('provider::flux'), undefined);
	});

	test('collectUpstreamProviderConfig finds first picker TEXT snapshot', () => {
		const store = makeStore();
		store.put({ nodeId: 'a', port: 'output', key: 'a:output:0', media: { kind: 'image', ref: 'u' }, index: 0 });
		store.put({ nodeId: 'b', port: 'output', key: 'b:output:0', media: { kind: 'text', ref: 'provider:p:m' }, index: 0 });
		assert.deepStrictEqual(collectUpstreamProviderConfig(store, ['a', 'b']), { providerId: 'p', modelId: 'm' });
		assert.strictEqual(collectUpstreamProviderConfig(store, ['a']), undefined);
		assert.strictEqual(collectUpstreamProviderConfig(store, undefined), undefined);
	});
});

suite('workflowRun — runProviderPickerNode', () => {

	function pickerInput(overrides?: Partial<Parameters<typeof runProviderPickerNode>[0]>) {
		return {
			runner: {} as never,
			nodeId: 'picker',
			type: 'Sarosis.ProviderPicker',
			getSpec: () => ({ kind: 'react' as const }),
			values: { providerId: 'openrouter', modelId: 'flux' },
			store: makeStore(),
			onProgress: () => {},
			...overrides,
		};
	}

	test('emits provider:providerId:modelId TEXT snapshot', async () => {
		const store = makeStore();
		const r = await runProviderPickerNode(pickerInput({ store }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries[0].media.kind, 'text');
		assert.strictEqual(r.entries[0].media.ref, 'provider:openrouter:flux');
		assert.strictEqual(store.byNode('picker')[0].media.ref, 'provider:openrouter:flux');
	});

	test('auto-routes when values are empty', async () => {
		const r = await runProviderPickerNode(pickerInput({
			values: {},
			resolveImageGenDefaults: async () => ({ providerId: 'openrouter', modelId: 'flux' }),
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries[0].media.ref, 'provider:openrouter:flux');
	});

	test('errors when nothing resolves', async () => {
		const r = await runProviderPickerNode(pickerInput({
			values: {},
			resolveImageGenDefaults: async () => undefined,
		}));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /Provider 和文生图模型/);
	});
});

// ─── LoadImage bridge ─────────────────────────────────────────────────────────

suite('workflowRun — isLoadImageNode / resolveLoadImageInputForNode', () => {

	function loadImageInput(overrides?: Partial<Parameters<typeof resolveLoadImageInputForNode>[0]>) {
		return {
			runner: {} as never,
			nodeId: 'load',
			type: 'LoadImage',
			getSpec: () => ({ kind: 'native' as const }),
			values: { image: 'http://cdn/provider.png' },
			store: makeStore(),
			onProgress: () => {},
			...overrides,
		};
	}

	test('isLoadImageNode matches class_type LoadImage', () => {
		assert.strictEqual(isLoadImageNode('LoadImage'), true);
		assert.strictEqual(isLoadImageNode('KSampler'), false);
	});

	test('comfy-view image passes through without upload', async () => {
		const view = 'http://127.0.0.1:8188/view?filename=x.png';
		const r = await resolveLoadImageInputForNode(loadImageInput({
			values: { image: view },
			resolveLoadImageRef: async () => { throw new Error('should not upload'); },
		}));
		assert.strictEqual(r.status, 'ok');
		if (r.status === 'ok') { assert.strictEqual(r.values.image, view); }
	});

	test('http provider ref is uploaded and image replaced with /view ref', async () => {
		const r = await resolveLoadImageInputForNode(loadImageInput({
			resolveLoadImageRef: async () => ({ ok: true, image: 'http://127.0.0.1:8188/view?filename=up.png' }),
		}));
		assert.strictEqual(r.status, 'ok');
		if (r.status === 'ok') { assert.strictEqual(r.values.image, 'http://127.0.0.1:8188/view?filename=up.png'); }
	});

	test('no provider ref on values → falls back to upstream IMAGE snapshot', async () => {
		const store = makeStore();
		store.put({
			nodeId: 'up', port: 'output', key: 'up:output:0',
			media: { kind: 'image', ref: 'http://cdn/up.png' }, index: 0,
		});
		const r = await resolveLoadImageInputForNode(loadImageInput({
			values: {},
			upstreams: ['up'],
			store,
			resolveLoadImageRef: async (ref) => ({ ok: true, image: `view:${ref}` }),
		}));
		assert.strictEqual(r.status, 'ok');
		if (r.status === 'ok') { assert.strictEqual(r.values.image, 'view:http://cdn/up.png'); }
	});

	test('upload failure → error result', async () => {
		const r = await resolveLoadImageInputForNode(loadImageInput({
			resolveLoadImageRef: async () => ({ ok: false, error: '上传图片失败' }),
		}));
		assert.strictEqual(r.status, 'error');
		if (r.status === 'error') { assert.match(r.result.error ?? '', /上传图片失败/); }
	});

	test('non-LoadImage node is untouched', async () => {
		const r = await resolveLoadImageInputForNode(loadImageInput({ type: 'KSampler', values: {} }));
		assert.strictEqual(r.status, 'ok');
		if (r.status === 'ok') { assert.deepStrictEqual(r.values, {}); }
	});
});
