/*---------------------------------------------------------------------------------------------
 *  useMediaSnapshot — React binding for MediaSnapshotStore.
 *
 *  Cards subscribe to the store so thumbnails appear as soon as a Comfy node
 *  produces output (without remounting the card).
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { MediaSnapshotStore } from './mediaSnapshotStore';
import type { MediaRef, MediaSnapshotEntry } from './mediaSnapshot';

function useStoreVersion(store: MediaSnapshotStore | undefined): number {
	return React.useSyncExternalStore(
		React.useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => { /* no-op */ }), [store]),
		React.useCallback(() => store?.getSnapshot() ?? 0, [store]),
		React.useCallback(() => store?.getSnapshot() ?? 0, [store]),
	);
}

/**
 * Subscribe to a store and return the media ref for a key (or undefined).
 * `getSnapshot` returns the store version so the component re-renders on mutation;
 * we then look up the ref freshly.
 */
export function useMediaSnapshotRef(store: MediaSnapshotStore | undefined, key: string): MediaRef | undefined {
	const version = useStoreVersion(store);
	void version;
	return store?.get(key);
}

/**
 * Subscribe to a store and return ALL snapshot entries for a node (batch output).
 * Cards show a thumbnail grid when a stage emits multiple media items.
 */
export function useNodeSnapshots(store: MediaSnapshotStore | undefined, nodeId: string | undefined): MediaSnapshotEntry[] {
	const version = useStoreVersion(store);
	void version;
	if (!store || !nodeId) { return []; }
	return store.byNode(nodeId);
}
