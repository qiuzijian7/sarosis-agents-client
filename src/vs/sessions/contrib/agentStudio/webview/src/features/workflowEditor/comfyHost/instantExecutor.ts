/*---------------------------------------------------------------------------------------------
 *  instantExecutor — run ComfyTV "instant" stages (Crop / Rotate / Mirror)
 *  fully in the browser: fetch the upstream image, apply the transform on a
 *  <canvas>, upload the PNG back to ComfyUI input/ and register a snapshot.
 *--------------------------------------------------------------------------------------------*/

import type { ComfyRunProgress, IComfyRunner } from './comfyRunner.js';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';
import type { SingleNodeRunResult } from './nodeExecutor.js';
import { applyInstantDraw, instantOutputSize } from './instantNodes.js';

export interface InstantNodeInput {
	runner: IComfyRunner;
	nodeId: string;
	type: string;
	values: Record<string, unknown>;
	upstreams?: string[];
	store: MediaSnapshotStore;
	onProgress?: (p: ComfyRunProgress) => void;
}

function firstUpstreamImage(store: MediaSnapshotStore, upstreams: string[] | undefined): string | undefined {
	for (const id of upstreams ?? []) {
		for (const entry of store.byNode(id)) {
			if (entry.media.kind === 'image' && entry.media.ref) { return entry.media.ref; }
		}
	}
	return undefined;
}

/** Browser-local execution of an instant stage. */
export async function runInstantNode(input: InstantNodeInput): Promise<SingleNodeRunResult> {
	const { runner, nodeId, type, values, upstreams, store, onProgress } = input;
	const src = firstUpstreamImage(store, upstreams);
	if (!src) {
		return { promptId: '', status: 'error', error: '即时节点需要上游图像输入（请先连接生成图像并执行）。', entries: [] };
	}
	if (!runner.fetchApi) {
		return { promptId: '', status: 'error', error: '该 Runner 不支持文件上传。', entries: [] };
	}
	try {
		onProgress?.({ value: 20 });
		const blob = await (await fetch(src)).blob();
		const bmp = await createImageBitmap(blob);
		const size = instantOutputSize(type, values, bmp.width, bmp.height);
		const canvas = document.createElement('canvas');
		canvas.width = size.w;
		canvas.height = size.h;
		const ctx = canvas.getContext('2d');
		if (!ctx) { return { promptId: '', status: 'error', error: '浏览器无法创建画布。', entries: [] }; }
		applyInstantDraw(ctx, type, values, bmp.width, bmp.height);
		onProgress?.({ value: 60 });
		const outBlob = await new Promise<Blob>((resolve) => {
			canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/png');
		});
		const form = new FormData();
		form.append('image', outBlob, 'instant.png');
		const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
		const data = await resp.json();
		const name = String(data?.name ?? '');
		const subfolder = String(data?.subfolder ?? '');
		const typeOut = String(data?.type ?? 'output');
		const ref = `${runner.baseUrl}/view?filename=${encodeURIComponent(name)}${subfolder ? '&subfolder=' + encodeURIComponent(subfolder) : ''}&type=${typeOut}`;
		const entry = {
			nodeId,
			port: 'output',
			key: `${nodeId}:output:0`,
			media: { kind: 'image' as const, ref },
			index: 0,
		};
		store.put(entry);
		onProgress?.({ value: 100 });
		return { promptId: '', status: 'success', entries: [entry], durationMs: 0 };
	} catch (err) {
		return { promptId: '', status: 'error', error: String(err), entries: [] };
	}
}
