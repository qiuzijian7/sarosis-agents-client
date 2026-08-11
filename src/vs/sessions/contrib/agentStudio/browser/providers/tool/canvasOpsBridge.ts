/*---------------------------------------------------------------------------------------------
 *  Canvas Ops Bridge — host-side request/response bridge for "Agent-driven canvas".
 *
 *  Docs: docs/Agent-画布编排设计方案.md P0.
 *
 *  Flow:
 *    1. An agent canvas_* tool calls requestCanvasOps(ops) → registers a pending
 *       promise keyed by requestId and fires canvasOpsRequestEmitter.
 *    2. The agentStudioWebviewController subscribes to the emitter and pushes a
 *       `workflow.canvasOps` event (carrying requestId + ops) to the webview.
 *    3. The webview applies the ops (applyCanvasOps) and replies via the
 *       `workflow.canvasOpsResult` request (carrying requestId + result).
 *    4. The controller forwards the result to resolveCanvasOps(requestId, result),
 *       which resolves the tool's pending promise.
 *
 *  Deliberately decoupled (same pattern as workflowShared.workflowAppliedEmitter):
 *  the tool layer never touches the controller directly.
 *
 *  The op model is intentionally JSON-shaped (plain objects) because it crosses
 *  the host↔webview boundary — types live in the webview's canvasOps.ts, mirrored
 *  here structurally for the host side.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../../base/common/event.js';

// ─── Ops (structural mirror of webview canvasOps.ts CanvasOp) ──────────────────

export type CanvasOp =
	| { op: 'add_node'; type: string; id?: string; label?: string; position?: { x: number; y: number }; data?: Record<string, unknown> }
	| { op: 'update_node'; node: string; patch: Record<string, unknown> }
	| { op: 'delete_node'; node: string }
	| { op: 'connect'; source: string; target: string; sourceHandle?: string; targetHandle?: string; id?: string }
	| { op: 'disconnect'; source: string; target: string; sourceHandle?: string; targetHandle?: string }
	| { op: 'select'; node?: string | null }
	| { op: 'undo' }
	| { op: 'redo' };

export interface CanvasOpsResult {
	model?: {
		nodes: Array<{ id: string; type: string; data?: Record<string, unknown> }>;
		edges: Array<{ id: string; source: string; target: string }>;
	};
	results?: Array<{ opIndex: number; summary: string; ids?: string[] }>;
	ok: boolean;
	error?: string;
	failedOpIndex?: number;
	selectedNodeId?: string | null;
}

export interface CanvasOpsRequest {
	requestId: string;
	ops: CanvasOp[];
}

/** Fired by the tool layer; the controller subscribes and forwards to the webview. */
export const canvasOpsRequestEmitter = new Emitter<CanvasOpsRequest>();

interface PendingOps {
	resolve: (result: CanvasOpsResult) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const pendingOps = new Map<string, PendingOps>();

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Request the webview to apply a batch of canvas ops. Returns a promise that
 * resolves with the applied result (or rejects on timeout / webview absence).
 */
export function requestCanvasOps(ops: CanvasOp[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<CanvasOpsResult> {
	const requestId = `cop_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	return new Promise<CanvasOpsResult>((resolve, reject) => {
		const timer = timeoutMs > 0
			? setTimeout(() => {
				pendingOps.delete(requestId);
				reject(new Error(`canvas_apply_ops: 画布未在 ${timeoutMs}ms 内响应（请确认已打开工作流画布）`));
			}, timeoutMs)
			: undefined;
		pendingOps.set(requestId, { resolve, reject, timer });
		canvasOpsRequestEmitter.fire({ requestId, ops });
	});
}

/** Called by the controller when the webview replies with a canvas ops result. */
export function resolveCanvasOps(requestId: string, result: CanvasOpsResult): boolean {
	const pending = pendingOps.get(requestId);
	if (!pending) { return false; }
	pendingOps.delete(requestId);
	if (pending.timer) { clearTimeout(pending.timer); }
	pending.resolve(result);
	return true;
}

/** Test helper: reject any in-flight request (e.g. webview closed). */
export function rejectAllPendingCanvasOps(err?: Error): void {
	for (const [, pending] of pendingOps) {
		if (pending.timer) { clearTimeout(pending.timer); }
		pending.reject(err ?? new Error('canvas_apply_ops: 画布不可用'));
	}
	pendingOps.clear();
}

/** Number of in-flight requests (test/diagnostics). */
export function getPendingCanvasOpsCount(): number {
	return pendingOps.size;
}
