/*---------------------------------------------------------------------------------------------
 *  layerExecutor — local execution of the ComfyTV Layer Editor stage.
 *
 *  The embedded artboard editor composites + uploads the artwork; running the
 *  node re-emits that snapshot (the stage's execute is pure bookkeeping).
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';

export interface LayerNodeInput {
	nodeId: string;
	values: Record<string, unknown>;
	store: MediaSnapshotStore;
}

/** Emit the composite snapshot produced by the embedded artboard editor. */
export async function runLayerEditorNode(input: LayerNodeInput): Promise<SingleNodeRunResult> {
	const render = input.store.byNode(input.nodeId).find(e => e.media.kind === 'image');
	if (!render) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中绘制并合成画面。', entries: [] };
	}
	return { promptId: '', status: 'success', entries: [render] };
}
