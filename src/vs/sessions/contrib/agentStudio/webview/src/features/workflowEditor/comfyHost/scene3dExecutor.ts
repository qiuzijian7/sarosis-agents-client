/*---------------------------------------------------------------------------------------------
 *  scene3dExecutor — local execution of the ComfyTV 3D Scene stage (2.5D MVP).
 *  Re-emits the captured composite snapshot produced by the embedded editor.
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';

export interface Scene3DNodeInput {
	nodeId: string;
	/** 快照归档键（= stageUid）。缺省回退 nodeId。 */
	snapshotKey?: string;
	values: Record<string, unknown>;
	store: MediaSnapshotStore;
}

/** Emit the capture composite produced by the embedded scene editor. */
export async function runScene3DNode(input: Scene3DNodeInput): Promise<SingleNodeRunResult> {
	const render = input.store.byNode(input.snapshotKey ?? input.nodeId).find(e => e.media.kind === 'image');
	if (!render) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中摆场并拍摄。', entries: [] };
	}
	return { promptId: '', status: 'success', entries: [render] };
}
