/*---------------------------------------------------------------------------------------------
 * Unit test: picker「点选即发布」—— publishPickerSelection（2026-09-12 修用户反馈
 * 「picker 节点中，多选图像，下游动态表情包中，参考图像没有更新」）。
 *
 * 根因：picker 是 no-Run 节点（卡片无运行按钮）→ 点选只写 widget 值、**快照库不动**
 *   → 下游（动态表情包）读 store.byNode(picker) 拿到的永远是上次运行的旧选择 ✗。
 *
 * ★ 两个必须守住的契约：
 *   1. 选中 N 张 → 快照恰好 N 条（下游按 `latestRoundOf().cells` 收集，多余条目
 *      会被当成额外参考图）；
 *   2. **重复点选不得累积** —— `MediaSnapshotStore.put` 忽略传入 index、按
 *      「已有最大 +1」追加（刻意保留历史）→ 不清空就会 8+3=11 条 ✗✗。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { publishPickerSelection } from '../../webview/src/features/workflowEditor/comfyHost/workflowRunShared.js';
import { MediaSnapshotStore, createMemoryBackend } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';

const PICKER = 'pk1';
const UP = 'up1';

/** 上游节点放 3 张图（ref = r0/r1/r2，按归档顺序）。 */
function makeStore(): MediaSnapshotStore {
	const store = new MediaSnapshotStore(createMemoryBackend());
	for (const ref of ['r0', 'r1', 'r2']) {
		store.put({ nodeId: UP, port: 'output', key: `${UP}:output:0`, index: 0, media: { kind: 'image', ref } }, true);
	}
	return store;
}

function pickerRefs(store: MediaSnapshotStore): string[] {
	return store.byNode(PICKER).map(e => e.media.ref).sort();
}

function publish(store: MediaSnapshotStore, values: Record<string, unknown>): Promise<unknown> {
	return publishPickerSelection({ store, snapKey: PICKER, type: 'ComfyTV.ImagePickerStage', values, upstreams: [UP] });
}

test('★ 多选 selected_indices → 快照恰好等于选中的那几张', async () => {
	const store = makeStore();
	const r = await publish(store, { selected_indices: '[0,1,2]' }) as { status: string };
	assert.strictEqual(r.status, 'success');
	assert.deepStrictEqual(pickerRefs(store), ['r0', 'r1', 'r2']);
});

test('★★ 重复点选不累积（清空后重写，而非追加）', async () => {
	const store = makeStore();
	await publish(store, { selected_indices: '[0,1,2]' });
	assert.strictEqual(store.byNode(PICKER).length, 3);
	// 取消到只剩 1 张 → 必须**恰好** 1 条（put 忽略 index 会追加成 3+1=4 ✗）
	await publish(store, { selected_indices: '[1]' });
	const refs = pickerRefs(store);
	assert.strictEqual(refs.length, 1, `重复发布不得累积，实际 ${refs.length} 条`);
	assert.deepStrictEqual(refs, ['r1']);
});

test('★ 「全部」视图 directRefs → 直接按 ref 发布（无需池序号）', async () => {
	const store = makeStore();
	await publish(store, { directRefs: '["x1","x2"]', selected_indices: '' });
	assert.deepStrictEqual(pickerRefs(store), ['x1', 'x2']);
});

test('★ 选中为空 → 回退单选首张（旧数据 / 取消到空集的既有语义）', async () => {
	const store = makeStore();
	const r = await publish(store, { selected_indices: '', directRefs: '', selected_index: 1 }) as { status: string };
	assert.strictEqual(r.status, 'success');
	assert.strictEqual(store.byNode(PICKER).length, 1);
});

test('★ 无上游候选且无选中 → error（不写入任何快照）', async () => {
	const store = new MediaSnapshotStore(createMemoryBackend());
	const r = await publishPickerSelection({ store, snapKey: PICKER, type: 'ComfyTV.ImagePickerStage', values: {}, upstreams: [] }) as { status: string };
	assert.strictEqual(r.status, 'error');
	assert.strictEqual(store.byNode(PICKER).length, 0);
});
