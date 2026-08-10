/*---------------------------------------------------------------------------------------------
 *  posterExecutor — local execution of the ComfyTV Poster stage.
 *
 *  The embedded PosterEditor uploads the composed PNG (anti-debounced); running
 *  the node simply re-emits that snapshot locally (the stage's backend render
 *  is equivalent — no GPU involved).
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';

export interface PosterNodeInput {
	nodeId: string;
	values: Record<string, unknown>;
	store: MediaSnapshotStore;
}

/** Emit the poster snapshot produced by the embedded editor. */
export async function runPosterNode(input: PosterNodeInput): Promise<SingleNodeRunResult> {
	const render = input.store.byNode(input.nodeId).find(e => e.media.kind === 'image');
	if (!render) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中排版并生成海报。', entries: [] };
	}
	return { promptId: '', status: 'success', entries: [render] };
}
