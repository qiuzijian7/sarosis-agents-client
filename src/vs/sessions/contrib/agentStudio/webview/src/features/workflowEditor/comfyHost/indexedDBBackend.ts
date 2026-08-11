/*---------------------------------------------------------------------------------------------
 *  indexedDBBackend — persistent MediaSnapshotBackend backed by IndexedDB.
 *
 *  Two object stores:
 *    - `refs`     (keyPath 'key')   — media ref metadata. The refs ARE the history:
 *      most executors only produce URL refs (ComfyUI /view, data: URLs), so persisting
 *      the ref is enough to recover snapshots after a page refresh — payloads stay on
 *      the provider side and keep working.
 *    - `payloads` (key 'key')       — raw Blob/string payloads saved via savePayload()
 *      (local editor renders etc.).
 *
 *  The webview renderer is sandboxed but IndexedDB is available. The factory takes an
 *  optional IDBFactory for tests/embedded embedders; a missing IndexedDB falls back to
 *  a no-op backend so the canvas still renders.
 *--------------------------------------------------------------------------------------------*/

import type { MediaSnapshotBackend } from './mediaSnapshotStore.js';
import type { MediaRef } from './mediaSnapshot.js';

export interface IndexedDBBackendOptions {
	idb?: IDBFactory;
	dbName?: string;
}

const DB_VERSION = 1;
const REFS_STORE = 'refs';
const PAYLOADS_STORE = 'payloads';

function openDb(idb: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = idb.open(name, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(REFS_STORE)) {
				db.createObjectStore(REFS_STORE, { keyPath: 'key' });
			}
			if (!db.objectStoreNames.contains(PAYLOADS_STORE)) {
				db.createObjectStore(PAYLOADS_STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
	});
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
	});
}

function put(db: IDBDatabase, store: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
	const tx = db.transaction(store, 'readwrite');
	const req = key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
	return request(req);
}

function del(db: IDBDatabase, store: string, key: IDBValidKey): Promise<undefined> {
	const tx = db.transaction(store, 'readwrite');
	return request(tx.objectStore(store).delete(key));
}

function get(db: IDBDatabase, store: string, key: IDBValidKey): Promise<unknown> {
	const tx = db.transaction(store, 'readonly');
	return request(tx.objectStore(store).get(key));
}

function getAll(db: IDBDatabase, store: string): Promise<unknown[]> {
	const tx = db.transaction(store, 'readonly');
	return request(tx.objectStore(store).getAll());
}

export function createIndexedDBBackend(opts: IndexedDBBackendOptions = {}): MediaSnapshotBackend {
	const idbFactory = opts.idb ?? globalThis.indexedDB;
	if (!idbFactory) {
		// No IndexedDB in this embedder — keep the canvas functional (memory
		// semantics, nothing persisted).
		return {
			async save(key) { return key; },
			async load() { return null; },
			async remove() { /* no-op */ },
		};
	}
	const dbName = opts.dbName ?? 'vssaros-media';
	const dbPromise = openDb(idbFactory, dbName);

	return {
		async save(key, data) {
			const db = await dbPromise;
			await put(db, PAYLOADS_STORE, data, key);
			return key;
		},
		async load(key) {
			const db = await dbPromise;
			const value = await get(db, PAYLOADS_STORE, key);
			return (value as Blob | string | undefined) ?? null;
		},
		async remove(key) {
			const db = await dbPromise;
			await del(db, PAYLOADS_STORE, key);
		},
		async saveMeta(key, media: MediaRef) {
			const db = await dbPromise;
			await put(db, REFS_STORE, { key, media });
		},
		async removeMeta(key) {
			const db = await dbPromise;
			await del(db, REFS_STORE, key);
		},
		async listMeta() {
			const db = await dbPromise;
			const rows = await getAll(db, REFS_STORE);
			return rows.map((r: { key: string; media: MediaRef }) => ({ key: r.key, media: r.media }));
		},
	};
}
