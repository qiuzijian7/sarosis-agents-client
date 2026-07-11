/*---------------------------------------------------------------------------------------------
 *  kbBlocksCodec — pure codec helpers for the `.bsdoc` Yjs-snapshot sidecar.
 *
 *  These functions are intentionally free of any VS Code / `@blocksuite`
 *  import so they can be unit-tested under plain Node (see kbBlocksCodec.test.ts).
 *  `KbBlocksEditorPane` delegates its `.bsdoc` envelope handling here so the
 *  serialisation contract has a single, testable source of truth.
 *--------------------------------------------------------------------------------------------*/

/** djb2 non-cryptographic hash — tracks which `.md` content a snapshot came from. */
export function hashMd(md: string): string {
	let h = 5381;
	for (let i = 0; i < md.length; i++) {
		h = ((h << 5) + h + md.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16);
}

export interface IBsdocParsed {
	snapshot: string | undefined;
	srcHash: string | undefined;
	/** true when the sidecar was a raw base64 blob (pre-envelope format). */
	legacy: boolean;
}

/** Parse a `.bsdoc` sidecar into its snapshot + freshness metadata. */
export function parseBsdoc(raw: string): IBsdocParsed {
	const trimmed = (raw ?? '').trim();
	if (trimmed.startsWith('{')) {
		try {
			const env = JSON.parse(trimmed) as { v?: number; srcHash?: string; snapshot?: string };
			return { snapshot: env.snapshot, srcHash: env.srcHash, legacy: false };
		} catch {
			// fall through to legacy
		}
	}
	// Legacy raw base64 snapshot.
	return { snapshot: trimmed || undefined, srcHash: undefined, legacy: true };
}

/**
 * Build the freshness-tracked envelope written next to a `.md` note.
 *
 * `{ v: 1, srcHash, snapshot }` where `snapshot` is the base64 of
 * `Y.encodeStateAsUpdate(doc.spaceDoc)` and `srcHash` is `hashMd(markdown)` of
 * the exact `.md` text the snapshot was derived from. On the next open, a
 * matching `srcHash` means the snapshot is still authoritative; a mismatch
 * (external edit of `.md`) forces a re-seed from markdown.
 */
export function makeBsdocEnvelope(snapshot: string, srcHash: string): string {
	return JSON.stringify({ v: 1, srcHash, snapshot });
}

/** Map a note path to its `.bsdoc` sidecar path (`<note>.md` → `<note>.md.bsdoc`). */
export function sidecarPath(path: string): string {
	return path + '.bsdoc';
}

// ── Backlink serialization (AFFiNE "linked references" parity) ───────────────
// The shared KB kernel returns `URI` instances; the webview message bridge uses
// structured clone and would drop the `URI` prototype, so backlinks are
// flattened to plain strings before being posted to the webview.

export interface ISerializedBacklink {
	uri: string;
	name: string;
	snippet: string;
	type: 'ref' | 'mention';
}

export interface ISerializedBacklinks {
	backlinks: ISerializedBacklink[];
	backmentions: { uri: string; name: string; snippet: string }[];
}

/** Minimal shape the kernel returns — `uri` may be a `URI` or an already-string. */
export interface IBacklinkSource {
	uri: unknown;
	name: string;
	snippet: string;
	type?: 'ref' | 'mention';
}

export interface IBacklinkResultLike {
	backlinks: IBacklinkSource[];
	backmentions: IBacklinkSource[];
}

/** Render any URI-like value to a stable string. */
function uriToString(uri: unknown): string {
	if (uri == null) {
		return '';
	}
	if (typeof uri === 'string') {
		return uri;
	}
	// `URI` instances expose `toString()`; guard against missing it.
	const s = (uri as { toString?: () => string }).toString?.();
	return typeof s === 'string' ? s : String(uri);
}

/** Flatten a kernel backlink result into webview-safe plain objects. */
export function serializeBacklinks(result: IBacklinkResultLike): ISerializedBacklinks {
	return {
		backlinks: (result?.backlinks ?? []).map((b) => ({
			uri: uriToString(b.uri),
			name: b.name ?? '',
			snippet: b.snippet ?? '',
			type: b.type === 'mention' ? 'mention' : 'ref',
		})),
		backmentions: (result?.backmentions ?? []).map((m) => ({
			uri: uriToString(m.uri),
			name: m.name ?? '',
			snippet: m.snippet ?? '',
		})),
	};
}
