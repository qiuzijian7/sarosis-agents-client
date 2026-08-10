/*---------------------------------------------------------------------------------------------
 *  storyboardExecutor — local execution of the ComfyTV Storyboard Editor stage.
 *
 *  The embedded editor composites + uploads the cover board; running the node
 *  re-emits that snapshot (execute is pure bookkeeping).
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';

export interface StoryboardNodeInput {
	nodeId: string;
	values: Record<string, unknown>;
	store: MediaSnapshotStore;
}

/** Emit the cover composite produced by the embedded storyboard editor. */
export async function runStoryboardEditorNode(input: StoryboardNodeInput): Promise<SingleNodeRunResult> {
	const render = input.store.byNode(input.nodeId).find(e => e.media.kind === 'image');
	if (!render) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中绘制分镜。', entries: [] };
	}
	return { promptId: '', status: 'success', entries: [render] };
}
