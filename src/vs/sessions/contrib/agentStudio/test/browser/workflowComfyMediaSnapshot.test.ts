/*---------------------------------------------------------------------------------------------
 *  Unit tests for mediaSnapshot + mediaSnapshotStore — ComfyUI output extraction,
 *  thumbnail sizing, view URLs, and the snapshot store with an in-memory backend.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	normalizeOutputSlot,
	extractMediaOutputs,
	comfyViewUrl,
	thumbnailSize,
	primarySnapshotKey,
} from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshot.js';
import {
	MediaSnapshotStore,
	createMemoryBackend,
} from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

suite('mediaSnapshot', () => {

	suite('normalizeOutputSlot', () => {

		test('images array → image refs with meta', () => {
			const refs = normalizeOutputSlot('images', [
				{ filename: 'a.png', subfolder: 'x', type: 'output' },
				{ filename: 'b.png' },
			]);
			assert.strictEqual(refs.length, 2);
			assert.strictEqual(refs[0].kind, 'image');
			assert.strictEqual(refs[0].ref, 'a.png');
			assert.deepStrictEqual(refs[0].meta, { subfolder: 'x', type: 'output' });
			assert.strictEqual(refs[1].ref, 'b.png');
		});

		test('gifs → video kind', () => {
			const refs = normalizeOutputSlot('gifs', [{ filename: 'out.gif' }]);
			assert.strictEqual(refs[0].kind, 'video');
		});

		test('string value → text kind', () => {
			const refs = normalizeOutputSlot('outputs', 'hello');
			assert.strictEqual(refs[0].kind, 'text');
			assert.strictEqual(refs[0].ref, 'hello');
		});

		test('non-string non-array → unknown JSON', () => {
			const refs = normalizeOutputSlot('outputs', 42);
			assert.strictEqual(refs[0].kind, 'unknown');
			assert.strictEqual(refs[0].ref, '42');
		});

		test('url refs preferred over filename', () => {
			const refs = normalizeOutputSlot('images', [{ url: 'https://cdn/a.png' }]);
			assert.strictEqual(refs[0].ref, 'https://cdn/a.png');
		});
	});

	suite('extractMediaOutputs', () => {

		test('flattens all slots with keys', () => {
			const entries = extractMediaOutputs(
				{ images: [{ filename: 'a.png' }], audio: [{ filename: 'v.wav' }] },
				'n3',
			);
			assert.strictEqual(entries.length, 2);
			assert.strictEqual(entries[0].key, 'n3:images:0');
			assert.strictEqual(entries[0].media.kind, 'image');
			assert.strictEqual(entries[1].media.kind, 'audio');
		});

		test('undefined outputs → []', () => {
			assert.deepStrictEqual(extractMediaOutputs(undefined, 'n1'), []);
		});

		test('custom port name overrides slot', () => {
			const entries = extractMediaOutputs({ images: [{ filename: 'a.png' }] }, 'n1', 'image');
			assert.strictEqual(entries[0].port, 'image');
			assert.strictEqual(entries[0].key, 'n1:image:0');
		});
	});

	suite('comfyViewUrl', () => {

		test('builds /view URL', () => {
			const url = comfyViewUrl('http://x:8188/', 'a.png', 'sub', 'output');
			assert.strictEqual(url, 'http://x:8188/view?filename=a.png&subfolder=sub&type=output');
		});

		test('trims trailing slash', () => {
			const url = comfyViewUrl('http://x:8188', 'a.png');
			assert.strictEqual(url.startsWith('http://x:8188/view'), true);
		});
	});

	suite('thumbnailSize', () => {

		test('clamps large edge', () => {
			assert.deepStrictEqual(thumbnailSize(1024, 1792, 320), { width: 183, height: 320 });
		});

		test('keeps small images as-is', () => {
			assert.deepStrictEqual(thumbnailSize(200, 150, 320), { width: 200, height: 150 });
		});

		test('zero dims → maxEdge fallback', () => {
			assert.deepStrictEqual(thumbnailSize(0, 0, 320), { width: 320, height: 320 });
		});
	});

	suite('primarySnapshotKey', () => {
		test('stable key', () => {
			assert.strictEqual(primarySnapshotKey('n3'), 'n3:output:0');
			assert.strictEqual(primarySnapshotKey('n3', 'image'), 'n3:image:0');
		});
	});
});

suite('mediaSnapshotStore', () => {

	suite('in-memory backend', () => {

		test('save + load round-trip', async () => {
			const backend = createMemoryBackend();
			const key = await backend.save('k1', 'data');
			assert.strictEqual(key, 'k1');
			assert.strictEqual(await backend.load('k1'), 'data');
			await backend.remove('k1');
			assert.strictEqual(await backend.load('k1'), null);
		});
	});

	suite('persistence (refs = history, refresh recovery)', () => {

		test('put persists ref metadata via backend meta', async () => {
			const backend = createMemoryBackend();
			const store = new MediaSnapshotStore(backend);
			await store.savePayload('n1', 'image', 0, 'data', 'image');
			const metas = await backend.listMeta!();
			assert.strictEqual(metas.length, 1);
			assert.strictEqual(metas[0].key, 'n1:image:0');
			assert.strictEqual(metas[0].media.ref, 'n1:image:0');
			assert.strictEqual(metas[0].media.kind, 'image');
		});

		test('remove clears backend meta too', async () => {
			const backend = createMemoryBackend();
			const store = new MediaSnapshotStore(backend);
			await store.savePayload('n1', 'image', 0, 'data');
			await store.remove('n1:image:0');
			assert.deepStrictEqual(await backend.listMeta!(), []);
		});

		test('hydrate restores persisted refs into a fresh store and notifies', async () => {
			const backend = createMemoryBackend();
			const source = new MediaSnapshotStore(backend);
			await source.savePayload('n9', 'image', 2, 'b', 'image');

			const restored = new MediaSnapshotStore(backend);
			let calls = 0;
			restored.subscribe(() => { calls++; });
			const v0 = restored.getSnapshot();
			await restored.hydrate();
			assert.strictEqual(restored.has('n9:image:2'), true);
			assert.strictEqual(restored.get('n9:image:2')!.kind, 'image');
			assert.strictEqual(calls, 1);
			assert.strictEqual(restored.getSnapshot(), v0 + 1);
		});

		test('hydrate does not mask in-memory refs from a concurrent session', async () => {
			const backend = createMemoryBackend();
			const source = new MediaSnapshotStore(backend);
			await source.savePayload('n1', 'image', 0, 'old');
			// simulate a live session that holds a newer URL ref for the key
			const live = new MediaSnapshotStore(backend);
			live.put({ nodeId: 'n1', port: 'image', key: 'n1:image:0', media: { kind: 'image', ref: 'http://live/now.png' }, index: 0 });
			await live.hydrate();
			assert.strictEqual(live.get('n1:image:0')!.ref, 'http://live/now.png');
		});

		test('persistent store never evicts refs', async () => {
			const backend = createMemoryBackend();
			const store = new MediaSnapshotStore(backend, { persistent: true, maxPreviewRefs: 1 });
			await store.savePayload('n1', 'image', 0, 'a');
			await store.savePayload('n1', 'image', 1, 'b');
			await store.savePayload('n2', 'image', 0, 'c');
			assert.strictEqual(store.has('n1:image:0'), true);
			assert.strictEqual(store.has('n1:image:1'), true);
			assert.strictEqual(store.has('n2:image:0'), true);
			assert.strictEqual((await backend.listMeta!()).length, 3);
		});

		test('eviction in a volatile store drops backend meta for the evicted ref', async () => {
			const backend = createMemoryBackend();
			const store = new MediaSnapshotStore(backend, { maxPreviewRefs: 1 });
			await store.savePayload('n1', 'image', 0, 'a');
			await store.savePayload('n2', 'image', 0, 'b');
			assert.strictEqual(store.has('n1:image:0'), false);
			const metas = await backend.listMeta!();
			assert.deepStrictEqual(metas.map(m => m.key), ['n2:image:0']);
		});

		test('getPayload returns locally-saved payload', async () => {
			const backend = createMemoryBackend();
			const store = new MediaSnapshotStore(backend);
			await store.savePayload('n1', 'image', 0, 'hello');
			assert.strictEqual(await store.getPayload('n1:image:0'), 'hello');
		});
	});

	suite('store operations', () => {

		test('put/get by node and eviction LRU', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend(), { maxPreviewRefs: 2 });
			await store.savePayload('n1', 'image', 0, 'a');
			await store.savePayload('n1', 'image', 1, 'b');
			// before exceeding the cap both entries are present
			assert.strictEqual(store.has('n1:image:0'), true);
			assert.strictEqual(store.has('n1:image:1'), true);

			await store.savePayload('n2', 'image', 0, 'c');
			// oldest (n1:image:0) evicted; most recent two kept
			assert.strictEqual(store.has('n1:image:0'), false);
			assert.strictEqual(store.has('n1:image:1'), true);
			assert.strictEqual(store.has('n2:image:0'), true);
		});

		test('byNode returns sorted entries with index', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend(), { maxPreviewRefs: 50 });
			await store.savePayload('n9', 'image', 1, 'b');
			await store.savePayload('n9', 'image', 0, 'a');
			const entries = store.byNode('n9');
			assert.strictEqual(entries.length, 2);
			assert.strictEqual(entries[0].index, 0);
			assert.strictEqual(entries[1].index, 1);
		});

		test('remove drops ref + backend', async () => {
			const backend = createMemoryBackend();
			const store = new MediaSnapshotStore(backend);
			await store.savePayload('n1', 'image', 0, 'x');
			await store.remove('n1:image:0');
			assert.strictEqual(store.has('n1:image:0'), false);
			assert.strictEqual(await backend.load('n1:image:0'), null);
		});

		test('clear wipes refs', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			await store.savePayload('n1', 'image', 0, 'x');
			store.clear();
			assert.strictEqual(store.has('n1:image:0'), false);
		});

		test('savePayload infers kind from Blob vs string', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			const key1 = await store.savePayload('n1', 'image', 0, new Blob(['x']));
			const key2 = await store.savePayload('n1', 'text', 0, 'plain');
			assert.strictEqual(store.get(key1)!.kind, 'image');
			assert.strictEqual(store.get(key2)!.kind, 'text');
		});
	});

	suite('subscribe (useSyncExternalStore contract)', () => {

		test('notifies listeners on put/remove/clear and bumps version', async () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			let calls = 0;
			const unsub = store.subscribe(() => { calls++; });
			const v0 = store.getSnapshot();
			await store.savePayload('n1', 'image', 0, 'x');
			assert.strictEqual(calls, 1);
			assert.strictEqual(store.getSnapshot(), v0 + 1);
			await store.remove('n1:image:0');
			assert.strictEqual(calls, 2);
			store.clear();
			assert.strictEqual(calls, 3);
			unsub();
			await store.savePayload('n2', 'image', 0, 'y');
			assert.strictEqual(calls, 3, 'unsubscribed listener must not fire');
		});

		test('getSnapshot is stable across calls without mutation', () => {
			const store = new MediaSnapshotStore(createMemoryBackend());
			assert.strictEqual(store.getSnapshot(), store.getSnapshot());
		});
	});
});
