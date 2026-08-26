/*---------------------------------------------------------------------------------------------
 *  storyboardExecutor — local execution of the ComfyTV Storyboard Editor stage.
 *
 *  三输出端口（对齐 ComfyTV storyboard_editor.py）：
 *    image  → 封面图（首板 composite/ref）
 *    images → 批次（每板一张，按 port='images' 多 index 归档）
 *    video  → animatic（本项目 renderer 无 PyAV，执行时 re-emit 封面作为占位；
 *             真正的 WebM animatic 由编辑器「导出动图」按钮产出）
 *  内嵌编辑器已合成 + 上传封面；run 是纯归档 bookkeeping。
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { MediaSnapshotEntry } from './mediaSnapshot.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { parseBoardState, boardImageUrl } from './storyboardEditor.js';

export interface StoryboardNodeInput {
	nodeId: string;
	/** 快照归档键（= stageUid）。缺省回退 nodeId。 */
	snapshotKey?: string;
	values: Record<string, unknown>;
	store: MediaSnapshotStore;
}

/** Emit cover（image）+ batch（images）snapshots produced by the embedded editor. */
export async function runStoryboardEditorNode(input: StoryboardNodeInput): Promise<SingleNodeRunResult> {
	const snapKey = input.snapshotKey ?? input.nodeId;
	const store = input.store;

	// 1) image 端口：已有 image 快照（编辑器上传）→ 原样 re-emit
	const render = store.byNode(snapKey).find(e => e.media.kind === 'image');
	if (!render) {
		return { promptId: '', status: 'error', error: '请先在节点弹窗中绘制分镜。', entries: [] };
	}

	// 2) images 批次端口：从 board_state 解析所有板 → 每个 board 一个 image 快照（port='images'）
	const boardStateRaw = typeof input.values?.board_state === 'string' ? input.values.board_state : '';
	const entries: MediaSnapshotEntry[] = [render];
	if (boardStateRaw) {
		const doc = parseBoardState(boardStateRaw, Number(input.values?.width) || 1280, Number(input.values?.height) || 720);
		let idx = 0;
		for (const b of doc.boards) {
			const url = boardImageUrl(b);
			if (!url) { continue; }
			entries.push({
				nodeId: snapKey,
				port: 'images',
				key: `${snapKey}:images:${idx}`,
				index: idx,
				media: { kind: 'image', ref: url, meta: { batch: '1', label: b.name ?? '' } },
			});
			idx += 1;
		}
	}

	return { promptId: '', status: 'success', entries };
}
