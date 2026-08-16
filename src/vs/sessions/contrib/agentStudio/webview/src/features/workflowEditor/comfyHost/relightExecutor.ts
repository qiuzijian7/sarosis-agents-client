/*---------------------------------------------------------------------------------------------
 *  relightExecutor — local execution of the ComfyTV Relight stage.
 *
 *  ComfyTV's RelightStage.execute is pure bookkeeping (persist the uploaded
 *  light-ball render + emit main_prompt verbatim). We mirror that locally: the
 *  embedded editor stores the light-ball render as an image snapshot and the
 *  prompt as values.main_prompt; running the node emits both outputs without
 *  any backend queue.
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { MediaSnapshotEntry } from './mediaSnapshot.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';

export interface RelightNodeInput {
	nodeId: string;
	/** 快照归档键（= stageUid）。缺省回退 nodeId。 */
	snapshotKey?: string;
	values: Record<string, unknown>;
	store: MediaSnapshotStore;
}

/** Emit light_render (image snapshot) + light_prompt (text) locally. */
export async function runRelightNode(input: RelightNodeInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store } = input;
	const snapKey = input.snapshotKey ?? nodeId;
	const mine = store.byNode(snapKey);
	const render = mine.find(e => e.media.kind === 'image');
	if (!render) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中摆灯并生成参考图。', entries: [] };
	}
	const prompt = typeof values?.main_prompt === 'string' ? values.main_prompt : '';
	// ★ entry.nodeId 决定归档前缀（`store.put` 按 `${entry.nodeId}:${entry.port}:`
	//   重算 index，**忽略传入的 key**）→ 必须写 snapKey，否则文本输出落在
	//   nodeId 名下、而卡片按 stageUid 读，下游 light_prompt 拿不到值。
	const textEntry: MediaSnapshotEntry = {
		nodeId: snapKey,
		port: 'output',
		key: `${snapKey}:output:1`,
		media: { kind: 'text', ref: prompt },
		index: 1,
	};
	store.put(textEntry);
	return { promptId: '', status: 'success', entries: [render, textEntry] };
}
