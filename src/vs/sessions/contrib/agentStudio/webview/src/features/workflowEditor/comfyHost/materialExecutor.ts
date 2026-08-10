/*---------------------------------------------------------------------------------------------
 *  materialExecutor — local execution of the ComfyTV Material stage.
 *
 *  The embedded material-ball editor uploads the preview snapshot; running the
 *  node re-emits that image plus the PBR material JSON (both outputs).
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { MediaSnapshotEntry } from './mediaSnapshot.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { materialStateToJson, parseMaterialState } from './materialEditor.js';

export interface MaterialNodeInput {
	nodeId: string;
	values: Record<string, unknown>;
	store: MediaSnapshotStore;
}

/** Emit material-ball image (when present) + material JSON text. */
export async function runMaterialNode(input: MaterialNodeInput): Promise<SingleNodeRunResult> {
	const { nodeId, values, store } = input;
	const mine = store.byNode(nodeId);
	const image = mine.find(e => e.media.kind === 'image');
	const material = parseMaterialState(typeof values.material_state === 'string' ? values.material_state : '');
	const entries: MediaSnapshotEntry[] = [];
	if (image) { entries.push(image); }
	entries.push({
		nodeId,
		port: 'output',
		key: `${nodeId}:output:1`,
		media: { kind: 'text', ref: materialStateToJson(material) },
		index: 1,
	});
	if (!image) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中编辑材质。', entries };
	}
	return { promptId: '', status: 'success', entries };
}
