/*---------------------------------------------------------------------------------------------
 * 剪贴板粘贴图片 → ImageLoaderStage 直通：runLoaderNode 读 data.image（data URL）
 * 直接产出 image 快照（不依赖 mediaAssetId / 弹窗选择）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { runNodeOrStage } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore, createMemoryBackend } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import type { IComfyRunner } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';

function makeInput(over: Record<string, unknown>): Parameters<typeof runNodeOrStage>[0] {
	return {
		runner: null as unknown as IComfyRunner,
		nodeId: 'img1',
		type: 'ComfyTV.ImageLoaderStage',
		getSpec: () => undefined,
		values: {},
		store: new MediaSnapshotStore(createMemoryBackend()),
		...over,
	} as Parameters<typeof runNodeOrStage>[0];
}

suite('剪贴板粘贴图片 → ImageLoaderStage 直通', () => {

	test('data.image (data URL) 直接产出 image 快照', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const r = await runNodeOrStage(makeInput({ store, values: { image: 'data:image/png;base64,AAAA' } }));
		assert.strictEqual(r.status, 'success');
		const snap = store.get('img1:output:0');
		// MediaRef 顶层结构：{ kind, ref, meta? }（非 media.kind）
		assert.strictEqual(snap?.kind, 'image');
		assert.strictEqual(snap?.ref, 'data:image/png;base64,AAAA');
	});

	test('http URL 图片同样直通', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const r = await runNodeOrStage(makeInput({ store, values: { image: 'https://example.com/a.png' } }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(store.get('img1:output:0')?.ref, 'https://example.com/a.png');
	});

	test('无 image 且无 mediaAssetId 且无历史快照 → 友好报错', async () => {
		const store = new MediaSnapshotStore(createMemoryBackend());
		const r = await runNodeOrStage(makeInput({ store, values: {} }));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /请先在节点弹窗中选择文件/);
	});
});
