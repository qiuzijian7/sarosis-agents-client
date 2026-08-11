/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Canvas Context Store — host-side cache of the workflow canvas state.
 *
 * Docs: docs/Agent-画布编排设计方案.md P0 → `<canvas_context>` tag.
 *
 * The LiteGraph canvas lives in the webview (memory-only). When the webview
 * replies to a canvas ops request (workflow.canvasOpsResult) it attaches a
 * canvas state snapshot; the controller stores it here. The
 * CanvasContextTagProvider reads this store and emits the `<canvas_context>`
 * XML tag into the next user message, so the Agent can "see" node results.
 *
 * Keyed by workflowId (or 'default' when unknown). Only the latest snapshot
 * per workflow is kept; snapshots expire to bound memory.
 */

export type CanvasNodeRunState = 'idle' | 'running' | 'success' | 'error';

export interface CanvasNodeSnapshot {
	id: string;
	/** Display label (e.g. "图像-1"), falls back to id. */
	label: string;
	/** Node type, e.g. Sarosis.ModelImageGen. */
	type: string;
	runState: CanvasNodeRunState;
	errorMsg?: string;
	durationMs?: number;
}

export interface CanvasEdgeSnapshot {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
}

export interface CanvasContextSnapshot {
	nodes: CanvasNodeSnapshot[];
	/** Canvas connections (node graph edges). */
	edges?: CanvasEdgeSnapshot[];
	/** Op summary lines from the last canvas_apply_ops batch (for traceability). */
	lastOpsSummary?: string[];
	/** ISO time the snapshot was taken. */
	updatedAt: string;
}

const SNAPSHOT_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_WORKFLOWS = 20;

export class CanvasContextStore {
	private readonly _snapshots = new Map<string, CanvasContextSnapshot>();

	set(workflowId: string, snapshot: CanvasContextSnapshot): void {
		this._prune();
		// Bound the map so a hostile/looping webview cannot grow memory unbounded.
		if (!this._snapshots.has(workflowId) && this._snapshots.size >= MAX_WORKFLOWS) {
			const oldest = this._snapshots.keys().next().value;
			if (oldest !== undefined) { this._snapshots.delete(oldest); }
		}
		this._snapshots.set(workflowId, snapshot);
	}

	get(workflowId: string): CanvasContextSnapshot | undefined {
		const s = this._snapshots.get(workflowId);
		if (!s) { return undefined; }
		// Expire stale snapshots.
		const age = Date.now() - new Date(s.updatedAt).getTime();
		if (age > SNAPSHOT_TTL_MS) {
			this._snapshots.delete(workflowId);
			return undefined;
		}
		return s;
	}

	clear(workflowId: string): void {
		this._snapshots.delete(workflowId);
	}

	clearAll(): void {
		this._snapshots.clear();
	}

	get size(): number {
		return this._snapshots.size;
	}

	private _prune(): void {
		const cutoff = Date.now() - SNAPSHOT_TTL_MS;
		for (const [id, s] of this._snapshots) {
			if (new Date(s.updatedAt).getTime() < cutoff) { this._snapshots.delete(id); }
		}
	}
}

/** Application-wide singleton (same pattern as workflowAppliedEmitter). */
export const canvasContextStore = new CanvasContextStore();
