/*---------------------------------------------------------------------------------------------
 *  CoderTrace Debug Store — collects [CoderTrace] messages from the host
 *  and makes them available to the DebugOverlay component.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';

export interface TraceEntry {
	id: number;
	timestamp: number;
	message: string;
}

interface DebugTraceState {
	entries: TraceEntry[];
	visible: boolean;
	addEntry: (message: string) => void;
	toggleVisible: () => void;
	clear: () => void;
}

let _nextId = 0;

export const useDebugTraceStore = create<DebugTraceState>((set) => ({
	entries: [],
	visible: false,
	addEntry: (message: string) =>
		set((state) => ({
			entries: [
				...state.entries.slice(-199), // keep last 200
				{ id: _nextId++, timestamp: Date.now(), message },
			],
		})),
	toggleVisible: () => set((state) => ({ visible: !state.visible })),
	clear: () => set({ entries: [] }),
}));
