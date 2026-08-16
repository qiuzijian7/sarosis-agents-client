/*---------------------------------------------------------------------------------------------
 *  Unit tests for reversePromptRun — reverse-prompt orchestration (P2).
 *  RPC + store are injected; no host channel needed.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { runReversePrompt, resolveNode } from '../../webview/src/features/workflowEditor/comfyHost/reversePromptRun.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

async function makeStore(withImage: boolean): Promise<MediaSnapshotStore> {
	const store = new MediaSnapshotStore({
		async save(key, data) { return key; },
		async load() { return null; },
		async remove() { },
	});
	if (withImage) {
		// The image lives on the UPSTREAM node (prompt1) so byNode(prompt1) finds it.
		await store.savePayload('prompt1', 'image', 0, 'snap:prompt1:0', 'image');
	}
	return store;
}

const nodes = [
	{ id: 'prompt1', data: { label: '提示-1' } },
	{ id: 'img1', type: 'Saros.ModelImageGen', data: { label: '图像-1', providerId: 'p1', modelId: 'm-text' } },
];

const edges = [{ source: 'prompt1', target: 'img1' }];

const providers = [{
	id: 'p1', name: 'P1', authStatus: 'authenticated',
	models: [{ id: 'm-text', name: 'M', supportsImages: true }],
}];

const mockReversePrompt = async () => ({ text: 'a neon cyberpunk city at night' });

async function baseInput(overrides?: Record<string, unknown>) {
	return {
		target: '图像-1',
		store: await makeStore(true),
		nodes,
		edges,
		providers,
		reversePrompt: mockReversePrompt,
		...(overrides ?? {}),
	};
}

suite('runReversePrompt', () => {

	test('resolves upstream image, routes provider/model, writes prompt', async () => {
		const r = await runReversePrompt(await baseInput() as never);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.nodeId, 'img1');
		assert.strictEqual(r.prompt, 'a neon cyberpunk city at night');
	});

	test('unknown target node fails', async () => {
		const r = await runReversePrompt(await baseInput({ target: 'ghost' }) as never);
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /找不到节点/);
	});

	test('no upstream image fails', async () => {
		const r = await runReversePrompt(await baseInput({ store: await makeStore(false) }) as never);
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /没有可用的图片快照/);
	});

	test('no authenticated provider fails', async () => {
		const r = await runReversePrompt(await baseInput({ providers: [] }) as never);
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /已认证 Provider/);
	});

	test('RPC throwing surfaces the error', async () => {
		const r = await runReversePrompt(await baseInput({
			reversePrompt: async () => { throw new Error('网络超时'); },
		}) as never);
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /网络超时/);
	});

	test('empty model text fails', async () => {
		const r = await runReversePrompt(await baseInput({
			reversePrompt: async () => ({ text: '   ' }),
		}) as never);
		assert.strictEqual(r.ok, false);
		assert.match(r.error ?? '', /未返回描述/);
	});
});

suite('resolveNode', () => {

	test('id match', () => {
		assert.strictEqual(resolveNode(nodes, 'img1')?.id, 'img1');
	});

	test('label match', () => {
		assert.strictEqual(resolveNode(nodes, '图像-1')?.id, 'img1');
	});

	test('case-insensitive label', () => {
		assert.strictEqual(resolveNode(nodes, '图像-1')?.id, 'img1');
	});

	test('unknown returns undefined', () => {
		assert.strictEqual(resolveNode(nodes, 'ghost'), undefined);
	});
});
