/*---------------------------------------------------------------------------------------------
 *  cardState — per-node execution state for the LiteGraph overlay cards.
 *
 *  ComfyTV-style feedback on the canvas: when a node runs, the card under it
 *  shows a running state + progress; on completion an output thumbnail;
 *  on failure an error banner. This store is the bridge between the executor
 *  (NodeEditorPopup / workflow runner) and the read-only React cards.
 *
 *  Pattern mirrors `mediaSnapshotStore`: plain class + React hook, so cards
 *  re-render when the state for their node changes.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

/** W2: 'skipped' = gate 分支路由未激活（连线端口未命中 / 上游 skip 传导），非错误 */
export type NodeRunState = 'idle' | 'running' | 'success' | 'error' | 'skipped';

export interface NodeCardState {
	runState: NodeRunState;
	/** 0..100, only meaningful while running */
	progress: number;
	errorMsg?: string;
	durationMs?: number;
	/** ISO time the run finished (for "rerun" affordance) */
	finishedAt?: number;
}

const IDLE: NodeCardState = { runState: 'idle', progress: 0 };

export class CardStateStore {
	private states = new Map<string, NodeCardState>();
	private listeners = new Set<() => void>();

	/** 0 when idle — lets useSyncExternalStore recompute */
	get(nodeId: string): NodeCardState {
		return this.states.get(nodeId) ?? IDLE;
	}

	set(nodeId: string, state: NodeCardState): void {
		this.states.set(nodeId, state);
		this.notify();
	}

	/** fold common transitions into one call; pure helper for tests */
	static transition(
		prev: NodeCardState | undefined,
		next: { runState?: NodeRunState; progress?: number; errorMsg?: string; durationMs?: number },
	): NodeCardState {
		const base = prev ?? IDLE;
		return {
			runState: next.runState ?? base.runState,
			progress: next.progress ?? base.progress,
			errorMsg: next.errorMsg ?? base.errorMsg,
			durationMs: next.durationMs ?? base.durationMs,
			finishedAt: next.runState === 'running' ? undefined : (next.runState ? Date.now() : base.finishedAt),
		};
	}

	clear(nodeId: string): void {
		this.states.delete(nodeId);
		this.notify();
	}

	clearAll(): void {
		this.states.clear();
		this.notify();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	private notify(): void {
		for (const l of this.listeners) { l(); }
	}
}

/**
 * React hook: returns the live execution state for a node id.
 * Cards call this and re-render whenever the store changes for any node.
 */
export function useNodeCardState(store: CardStateStore | undefined, nodeId: string | undefined): NodeCardState {
	const getSnapshot = React.useCallback(
		() => store?.get(nodeId ?? '') ?? IDLE,
		[store, nodeId],
	);
	// Force recompute on every store change (cheap: cards are small).
	const getServerSnapshot = React.useCallback(() => IDLE, []);
	const state = React.useSyncExternalStore(
		store?.subscribe ?? (() => () => {}),
		getSnapshot,
		getServerSnapshot,
	);
	return state;
}
