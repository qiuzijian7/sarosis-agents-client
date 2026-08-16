/*---------------------------------------------------------------------------------------------
 *  runnerStatusStore — global ComfyUI/ComfyTV runner readiness signal (P2).
 *
 *  The canvas cards for schema/native nodes show a "disconnected" placeholder
 *  instead of an executable run button when no ComfyUI runner is reachable.
 *  This module is the bridge between the host panel's runner probe
 *  (WorkflowEditorPanel → collectRunnerRows) and the read-only React cards.
 *
 *  Pattern mirrors cardState.ts / mediaSnapshotStore.ts: a plain class +
 *  React hook + a module singleton. Pure, DOM-free, unit-testable.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

export interface RunnerStatus {
	/** true when at least one runner responded healthy to /system_stats. */
	ready: boolean;
	/** human-readable base URL of the active runner (for diagnostics). */
	baseUrl?: string;
}

const INITIAL: RunnerStatus = { ready: false };

class RunnerStatusStore {
	private status: RunnerStatus = INITIAL;
	private listeners = new Set<() => void>();

	get(): RunnerStatus {
		return this.status;
	}

	set(status: RunnerStatus): void {
		this.status = status;
		this.notify();
	}

	setReady(ready: boolean, baseUrl?: string): void {
		this.set({ ready, baseUrl });
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	private notify(): void {
		for (const l of this.listeners) { l(); }
	}
}

let singleton: RunnerStatusStore | null = null;

/** Module-level singleton shared by the host panel and the canvas cards. */
export function getRunnerStatusStore(): RunnerStatusStore {
	if (!singleton) { singleton = new RunnerStatusStore(); }
	return singleton;
}

/** Reset the singleton (used by tests). */
export function resetRunnerStatusStore(): void {
	singleton = null;
}

/** React hook: re-render when the global runner readiness changes. */
export function useRunnerStatus(): RunnerStatus {
	const store = getRunnerStatusStore();
	return React.useSyncExternalStore(
		store.subscribe,
		() => store.get(),
		() => INITIAL,
	);
}
