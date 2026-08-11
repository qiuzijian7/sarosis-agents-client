/*---------------------------------------------------------------------------------------------
 *  mediaSnapshotStore — in-memory store for media snapshots produced by Comfy nodes.
 *
 *  Keyed by `${nodeId}:${port}:${index}`. The actual bitmap payload lives in a
 *  pluggable backend (blob URL cache / IndexedDB / file storage); this store only
 *  tracks refs + a small LRU of preview refs so cards can render thumbnails.
 *  Framework-agnostic, unit-testable with an injected backend.
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotEntry, MediaRef } from './mediaSnapshot.js';

export interface MediaSnapshotBackend {
	save(key: string, data: Blob | string): Promise<string>;
	load(key: string): Promise<Blob | string | null>;
	remove(key: string): Promise<void>;
	/** Persist the ref metadata for a key (refresh recovery — the ref is the
	 *  source of truth; payloads are URLs/refs, not raw bitmaps). */
	saveMeta?(key: string, media: MediaRef): Promise<void>;
	removeMeta?(key: string): Promise<void>;
	listMeta?(): Promise<Array<{ key: string; media: MediaRef }>>;
}

export interface MemoryBackendEntry {
	key: string;
	data: Blob | string;
}

/** Simple in-memory backend (tests + transient runs). */
export function createMemoryBackend(): MediaSnapshotBackend & { entries: Map<string, MemoryBackendEntry> } {
	const entries = new Map<string, MemoryBackendEntry>();
	const meta = new Map<string, MediaRef>();
	return {
		entries,
		async save(key, data) {
			entries.set(key, { key, data });
			return key;
		},
		async load(key) {
			return entries.get(key)?.data ?? null;
		},
		async remove(key) {
			entries.delete(key);
			meta.delete(key);
		},
		async saveMeta(key, media) {
			meta.set(key, media);
		},
		async removeMeta(key) {
			meta.delete(key);
		},
		async listMeta() {
			return Array.from(meta, ([key, media]) => ({ key, media }));
		},
	};
}

export class MediaSnapshotStore {
	private readonly refs = new Map<string, MediaRef>();
	/** most-recently-used order for preview eviction */
	private readonly lru: string[] = [];
	private readonly maxPreviewRefs: number;
	private readonly persistent: boolean;
	private readonly onAsset?: (entry: MediaSnapshotEntry) => void;
	private readonly listeners = new Set<() => void>();
	/** opaque version bumped on every mutation (for useSyncExternalStore) */
	private version = 0;

	constructor(
		private readonly backend: MediaSnapshotBackend,
		opts?: { maxPreviewRefs?: number; persistent?: boolean; onAsset?: (entry: MediaSnapshotEntry) => void },
	) {
		this.maxPreviewRefs = opts?.maxPreviewRefs ?? 200;
		// Persistent stores (IndexedDB / host file) never evict refs — the
		// persisted refs ARE the history; dropping them would silently erase
		// already-recovered snapshots. Ref entries are tiny (URL + kind), so
		// unbounded growth is acceptable for the workflow-scoped stores.
		this.persistent = opts?.persistent ?? false;
		this.onAsset = opts?.onAsset;
	}

	/** Subscribe to store mutations. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Snapshot accessor compatible with useSyncExternalStore's getSnapshot. */
	getSnapshot(): number {
		return this.version;
	}

	private notify(): void {
		this.version++;
		for (const fn of this.listeners) { fn(); }
	}

	/** Store an entry's media ref (caller is responsible for backend.save of payload). */
	put(entry: MediaSnapshotEntry): void {
		this.refs.set(entry.key, entry.media);
		this.touch(entry.key);
		// Persist the ref so a refresh can recover it (refs are the history;
		// the payload is the URL/ref itself for most executors).
		void this.backend.saveMeta?.(entry.key, entry.media);
		// Optional auto-collect into the host media library (generated-image
		// asset management P1). Fire-and-forget; dedup lives at the callback.
		this.onAsset?.(entry);
		this.evict();
		this.notify();
	}

	get(key: string): MediaRef | undefined {
		return this.refs.get(key);
	}

	has(key: string): boolean {
		return this.refs.has(key);
	}

	/** Restore refs previously persisted by the backend (refresh recovery).
	 *  In-memory refs from the current session win — persisted entries are only
	 *  added when absent, so a concurrent run is never masked. */
	async hydrate(): Promise<void> {
		if (!this.backend.listMeta) { return; }
		const metas = await this.backend.listMeta();
		let changed = false;
		for (const { key, media } of metas) {
			if (!this.refs.has(key)) {
				this.refs.set(key, media);
				this.lru.unshift(key);
				changed = true;
			}
		}
		if (changed) { this.notify(); }
	}

	/** Load a stored payload (for export/download of locally-saved blobs). */
	async getPayload(key: string): Promise<Blob | string | null> {
		return this.backend.load(key);
	}

	/** All entries for a node (for card previews / history). */
	byNode(nodeId: string): MediaSnapshotEntry[] {
		const out: MediaSnapshotEntry[] = [];
		for (const [key, media] of this.refs) {
			if (key.startsWith(`${nodeId}:`)) {
				const rest = key.slice(nodeId.length + 1);
				const lastColon = rest.lastIndexOf(':');
				const port = lastColon >= 0 ? rest.slice(0, lastColon) : '';
				const index = lastColon >= 0 ? Number(rest.slice(lastColon + 1)) : 0;
				out.push({ nodeId, port, key, media, index });
			}
		}
		return out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	}

	async remove(key: string): Promise<void> {
		this.refs.delete(key);
		const i = this.lru.indexOf(key);
		if (i >= 0) { this.lru.splice(i, 1); }
		this.notify();
		await this.backend.remove(key);
		await this.backend.removeMeta?.(key);
	}

	clear(): void {
		this.refs.clear();
		this.lru.length = 0;
		this.notify();
	}

	/** Persist a payload through the backend and record the ref. */
	async savePayload(nodeId: string, port: string, index: number, data: Blob | string, kind?: MediaRef['kind']): Promise<string> {
		const key = `${nodeId}:${port}:${index}`;
		await this.backend.save(key, data);
		const media: MediaRef = {
			kind: kind ?? (typeof data === 'string' ? 'text' : 'image'),
			ref: key,
		};
		this.put({ nodeId, port, key, media });
		return key;
	}

	private touch(key: string): void {
		const i = this.lru.indexOf(key);
		if (i >= 0) { this.lru.splice(i, 1); }
		this.lru.unshift(key);
	}

	private evict(): void {
		if (this.persistent) { return; }
		while (this.lru.length > this.maxPreviewRefs) {
			const old = this.lru.pop();
			if (old !== undefined) {
				this.refs.delete(old);
				void this.backend.remove(old);
				void this.backend.removeMeta?.(old);
			}
		}
	}
}


