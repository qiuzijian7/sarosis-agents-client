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
}

export interface MemoryBackendEntry {
	key: string;
	data: Blob | string;
}

/** Simple in-memory backend (tests + transient runs). */
export function createMemoryBackend(): MediaSnapshotBackend & { entries: Map<string, MemoryBackendEntry> } {
	const entries = new Map<string, MemoryBackendEntry>();
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
		},
	};
}

export class MediaSnapshotStore {
	private readonly refs = new Map<string, MediaRef>();
	/** most-recently-used order for preview eviction */
	private readonly lru: string[] = [];
	private readonly maxPreviewRefs: number;
	private readonly listeners = new Set<() => void>();
	/** opaque version bumped on every mutation (for useSyncExternalStore) */
	private version = 0;

	constructor(
		private readonly backend: MediaSnapshotBackend,
		opts?: { maxPreviewRefs?: number },
	) {
		this.maxPreviewRefs = opts?.maxPreviewRefs ?? 200;
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
		this.evict();
		this.notify();
	}

	get(key: string): MediaRef | undefined {
		return this.refs.get(key);
	}

	has(key: string): boolean {
		return this.refs.has(key);
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
		while (this.lru.length > this.maxPreviewRefs) {
			const old = this.lru.pop();
			if (old !== undefined) {
				this.refs.delete(old);
				void this.backend.remove(old);
			}
		}
	}
}


