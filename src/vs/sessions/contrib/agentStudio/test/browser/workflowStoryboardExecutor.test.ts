/*---------------------------------------------------------------------------------------------
 * P3: StoryboardEditor 执行器（runStoryboardEditorNode）单测。
 *
 * 覆盖三条关键路径（对齐 storyboardExecutor.ts 注释）：
 *   1. image 端口：编辑器已上传封面 → 原样 re-emit；
 *   2. images 批次端口：board_state 解析每板 → port='images' 多 index 归档；
 *   3. 无快照 / 无图 board 的边界行为。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { runStoryboardEditorNode } from '../../webview/src/features/workflowEditor/comfyHost/storyboardExecutor.js';
import { MediaSnapshotStore, createMemoryBackend } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

const NODE = 'sb1';

function makeStore(): MediaSnapshotStore {
	return new MediaSnapshotStore(createMemoryBackend());
}

function makeInput(store: MediaSnapshotStore, over: Record<string, unknown> = {}) {
	return {
		nodeId: NODE,
		values: {},
		store,
		...over,
	};
}

/** 在 store 里写入一张封面图快照（模拟内嵌编辑器 commit 上传后的归档）。 */
function seedCover(store: MediaSnapshotStore, ref = 'https://x/cover.png'): void {
	store.put({ nodeId: NODE, port: 'output', key: `${NODE}:output:0`, index: 0, media: { kind: 'image', ref } });
}

function boardStateJson(boards: unknown[]): string {
	return JSON.stringify({
		version: 1, width: 1280, height: 720, defaultBoardTimingMs: 2000,
		boards,
	});
}

suite('StoryboardEditor 执行器（runStoryboardEditorNode）', () => {

	test('无 image 快照 → 友好报错', async () => {
		const store = makeStore();
		const r = await runStoryboardEditorNode(makeInput(store));
		assert.strictEqual(r.status, 'error');
		assert.match(r.error ?? '', /请先在节点弹窗中绘制分镜/);
		assert.deepStrictEqual(r.entries, []);
	});

	test('有 image 快照 → 原样 re-emit 封面', async () => {
		const store = makeStore();
		seedCover(store);
		const r = await runStoryboardEditorNode(makeInput(store));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries.length, 1);
		assert.strictEqual(r.entries[0].media.kind, 'image');
		assert.strictEqual(r.entries[0].media.ref, 'https://x/cover.png');
		assert.strictEqual(r.entries[0].port, 'output');
	});

	test('board_state 多板 → 每张有图板归档到 images 批次端口', async () => {
		const store = makeStore();
		seedCover(store);
		const r = await runStoryboardEditorNode(makeInput(store, {
			values: {
				board_state: boardStateJson([
					{ uid: 'AAAAA', name: '镜头 1', newShot: true, compositeUrl: 'https://x/board1.png' },
					{ uid: 'BBBBB', name: '镜头 2', newShot: false, refUrl: 'https://x/board2.png' },
				]),
			},
		}));
		assert.strictEqual(r.status, 'success');
		// entries[0] = 封面 re-emit；后续 = 每板一张
		assert.strictEqual(r.entries.length, 3);
		const batch = r.entries.filter(e => e.port === 'images');
		assert.strictEqual(batch.length, 2);
		assert.strictEqual(batch[0].media.ref, 'https://x/board1.png');
		assert.strictEqual(batch[0].index, 0);
		assert.strictEqual(batch[0].media.meta?.batch, '1');
		assert.strictEqual(batch[0].media.meta?.label, '镜头 1');
		assert.strictEqual(batch[1].media.ref, 'https://x/board2.png');
		assert.strictEqual(batch[1].index, 1);
		assert.strictEqual(batch[1].media.meta?.label, '镜头 2');
	});

	test('无图 board 跳过批次（boardImageUrl 为 null），index 连续', async () => {
		const store = makeStore();
		seedCover(store);
		const r = await runStoryboardEditorNode(makeInput(store, {
			values: {
				board_state: boardStateJson([
					{ uid: 'AAAAA', newShot: true, compositeUrl: 'https://x/board1.png' },
					{ uid: 'BBBBB', newShot: false },                          // 无图 → 跳过
					{ uid: 'CCCCC', newShot: false, refUrl: 'https://x/board3.png' },
				]),
			},
		}));
		assert.strictEqual(r.status, 'success');
		const batch = r.entries.filter(e => e.port === 'images');
		assert.strictEqual(batch.length, 2);
		// 跳过无图板不占 index，批次 index 保持连续
		assert.strictEqual(batch[0].index, 0);
		assert.strictEqual(batch[0].media.ref, 'https://x/board1.png');
		assert.strictEqual(batch[1].index, 1);
		assert.strictEqual(batch[1].media.ref, 'https://x/board3.png');
	});

	test('board_state 空串 / 非字符串 → 仅封面，无 images 批次', async () => {
		const store = makeStore();
		seedCover(store);
		// 空串
		const r1 = await runStoryboardEditorNode(makeInput(store, { values: { board_state: '' } }));
		assert.strictEqual(r1.status, 'success');
		assert.strictEqual(r1.entries.length, 1);
		assert.strictEqual(r1.entries[0].port, 'output');
		// 非字符串（对象）→ 同样不解析
		const r2 = await runStoryboardEditorNode(makeInput(store, { values: { board_state: { boards: [] } } }));
		assert.strictEqual(r2.status, 'success');
		assert.strictEqual(r2.entries.length, 1);
	});

	test('snapshotKey 缺省回退 nodeId（归档键一致性）', async () => {
		const store = makeStore();
		seedCover(store);
		const r = await runStoryboardEditorNode(makeInput(store));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries[0].nodeId, NODE);
	});

	test('snapshotKey 显式指定 → 从该键名下读快照', async () => {
		const store = makeStore();
		const uid = 'uid-storyboard-1';
		// 编辑器归档键 = stageUid（非 nodeId）
		store.put({ nodeId: uid, port: 'output', key: `${uid}:output:0`, index: 0, media: { kind: 'image', ref: 'https://x/uid-cover.png' } });
		const r = await runStoryboardEditorNode(makeInput(store, { snapshotKey: uid }));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(r.entries[0].media.ref, 'https://x/uid-cover.png');
		assert.strictEqual(r.entries[0].nodeId, uid);
	});
});
