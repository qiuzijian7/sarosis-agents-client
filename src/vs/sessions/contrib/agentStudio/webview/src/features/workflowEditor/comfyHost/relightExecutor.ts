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
	values: Record<string, unknown>;
	store: MediaSnapshotStore;
}

/** Emit light_render (image snapshot) + light_prompt (text) locally. */
export async function runRelightNode(input: RelightNodeInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store } = input;
	const mine = store.byNode(nodeId);
	const render = mine.find(e => e.media.kind === 'image');
	if (!render) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中摆灯并生成参考图。', entries: [] };
	}
	const prompt = typeof values?.main_prompt === 'string' ? values.main_prompt : '';
	const textEntry: MediaSnapshotEntry = {
		nodeId,
		port: 'output',
		key: `${nodeId}:output:1`,
		media: { kind: 'text', ref: prompt },
		index: 1,
	};
	store.put(textEntry);
	return { promptId: '', status: 'success', entries: [render, textEntry] };
}
