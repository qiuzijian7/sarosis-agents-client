/*---------------------------------------------------------------------------------------------
 *  mediaSnapshot — extract + normalize ComfyUI runner outputs into media snapshots,
 *  and derive thumbnail sizing. Pure functions, unit-testable.
 *
 *  ComfyUI /history outputs look like:
 *    { "3": { "images": [ { "filename": "…", "subfolder": "", "type": "output" } ] },
 *      "7": { "gifs": [ … ], "audio": [ … ] } }
 *  We normalize to a compact MediaRef list for snapshot storage + card previews.
 *--------------------------------------------------------------------------------------------*/

export type MediaKind = 'image' | 'video' | 'audio' | 'text' | 'unknown';

export interface MediaRef {
	kind: MediaKind;
	/** display/original reference (URL / filename / text) */
	ref: string;
	/** optional extra metadata (e.g. subfolder/type for ComfyUI /view paths) */
	meta?: Record<string, unknown>;
	/**
	 * ComfyTV fx-chain threading: when the output is an fx-threaded video
	 * (`{"__fxvideo__": {"url", "chain"}}`), `ref` holds the underlying video
	 * URL (for previews) and `fxChain` holds the full packed value so the next
	 * fx stage re-injects it as its `video` input (single ffmpeg render at the
	 * FX Chain terminal).
	 */
	fxChain?: string;
}

export interface MediaSnapshotEntry {
	nodeId: string;
	/** port name the output came from ('' when unknown) */
	port: string;
	/** stable key: `${nodeId}:${port}:${index}` */
	key: string;
	media: MediaRef;
	/** element index within the slot (used for ordering/thumbnail pick) */
	index?: number;
}

const KIND_BY_SLOT: Record<string, MediaKind> = {
	images: 'image',
	gifs: 'video',
	videos: 'video',
	audio: 'audio',
	outputs: 'unknown',
};

function kindOfListName(name: string): MediaKind {
	return KIND_BY_SLOT[name] ?? 'unknown';
}

/** Normalize one output slot (e.g. `images`) into MediaRef[]. */
export function normalizeOutputSlot(name: string, value: unknown): MediaRef[] {
	if (!Array.isArray(value)) {
		// text-ish output → single text ref
		if (typeof value === 'string') { return [{ kind: 'text', ref: value }]; }
		return [{ kind: 'unknown', ref: JSON.stringify(value) }];
	}
	const kind = kindOfListName(name);
	return value.map((item) => {
		if (typeof item === 'string') {
			return { kind, ref: item };
		}
		if (item && typeof item === 'object') {
			const rec = item as Record<string, unknown>;
			const ref = (rec.filename as string | undefined)
				?? (rec.url as string | undefined)
				?? (rec.path as string | undefined)
				?? (rec.name as string | undefined)
				?? JSON.stringify(item);
			return { kind, ref, meta: { subfolder: rec.subfolder, type: rec.type } };
		}
		return { kind, ref: JSON.stringify(item) };
	});
}

/** Extract all media entries from a ComfyUI /history outputs object. */
export function extractMediaOutputs(
	outputs: Record<string, unknown> | undefined,
	nodeId: string,
	port = '',
): MediaSnapshotEntry[] {
	if (!outputs) { return []; }
	const entries: MediaSnapshotEntry[] = [];
	for (const [slotName, value] of Object.entries(outputs)) {
		const media = normalizeOutputSlot(slotName, value);
		media.forEach((m, i) => {
			entries.push({
				nodeId,
				port: port || slotName,
				key: `${nodeId}:${port || slotName}:${i}`,
				media: m,
			});
		});
	}
	return entries;
}

/** Build a /view? URL for a ComfyUI file ref. */
export function comfyViewUrl(baseUrl: string, filename: string, subfolder = '', type = 'output'): string {
	const qs = new URLSearchParams({ filename, subfolder, type });
	return `${baseUrl.replace(/\/$/, '')}/view?${qs.toString()}`;
}

/** Thumbnail sizing: keep aspect ratio, clamp to a max edge. Pure. */
export function thumbnailSize(
	naturalWidth: number,
	naturalHeight: number,
	maxEdge = 320,
): { width: number; height: number } {
	if (!naturalWidth || !naturalHeight) { return { width: maxEdge, height: maxEdge }; }
	const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
	return {
		width: Math.max(1, Math.round(naturalWidth * scale)),
		height: Math.max(1, Math.round(naturalHeight * scale)),
	};
}

/** Stable snapshot key for a node's primary output (card preview). */
export function primarySnapshotKey(nodeId: string, port = ''): string {
	return `${nodeId}:${port || 'output'}:0`;
}
