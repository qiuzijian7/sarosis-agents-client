/*---------------------------------------------------------------------------------------------
 *  nodeStateMachine — workflow node execution state machine.
 *
 *  States (aligned with LiteGraph/ComfyTV runner semantics):
 *    idle → queued → running(0..100) → success | error | canceled
 *    running → blocked  (only via markBlockedBy, when an upstream failed)
 *
 *  Pure and unit-testable; no DOM / no store dependency.
 *--------------------------------------------------------------------------------------------*/

export type NodeState = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'canceled' | 'blocked';

export interface NodeStateSnapshot {
	state: NodeState;
	progress: number;      // 0..100, meaningful while running
	error?: string;        // set on error
	blockedBy?: string;    // node id that caused blocked
}

export class InvalidTransitionError extends Error {
	constructor(from: NodeState, to: NodeState) {
		super(`invalid state transition: ${from} → ${to}`);
		this.name = 'InvalidTransitionError';
	}
}

const VALID_TRANSITIONS: Record<NodeState, NodeState[]> = {
	idle: ['queued', 'running', 'error', 'canceled', 'blocked'],
	queued: ['running', 'canceled', 'blocked'],
	running: ['success', 'error', 'canceled', 'blocked'],
	success: [],
	error: [],
	canceled: [],
	blocked: [],
};

/** Current state (mutable per-node instance). */
export class NodeStateMachine {
	private _state: NodeState = 'idle';
	private _progress = 0;
	private _error: string | undefined;
	private _blockedBy: string | undefined;

	constructor(initial: NodeState = 'idle') {
		this._state = initial;
	}

	get state(): NodeState { return this._state; }
	get progress(): number { return this._progress; }
	get error(): string | undefined { return this._error; }
	get blockedBy(): string | undefined { return this._blockedBy; }

	canTransition(to: NodeState): boolean {
		return VALID_TRANSITIONS[this._state].includes(to);
	}

	transition(to: NodeState, opts: { error?: string; blockedBy?: string } = {}): void {
		if (!this.canTransition(to)) {
			throw new InvalidTransitionError(this._state, to);
		}
		this._state = to;
		if (to === 'error') { this._error = opts.error; }
		if (to === 'blocked') { this._blockedBy = opts.blockedBy; }
		if (to !== 'running') { this._progress = to === 'success' ? 100 : this._progress; }
	}

	/** Set progress (0..100). Only valid while running. Clamps input. */
	setProgress(pct: number): void {
		if (this._state !== 'running') {
			throw new InvalidTransitionError(this._state, 'running:setProgress');
		}
		this._progress = Math.max(0, Math.min(100, Math.round(pct)));
	}

	snapshot(): NodeStateSnapshot {
		return {
			state: this._state,
			progress: this._progress,
			error: this._error,
			blockedBy: this._blockedBy,
		};
	}
}

/** Pure helper: validate a full state list (used by tests & store hydration).
 *  Leading `idle` states are the natural starting point and are skipped. */
export function isStateOrderValid(states: NodeState[]): boolean {
	let prev: NodeState = 'idle';
	let started = false;
	for (const s of states) {
		if (!started && s === 'idle') { continue; }
		if (!started) { started = true; prev = 'idle'; }
		if (!VALID_TRANSITIONS[prev].includes(s)) { return false; }
		prev = s;
	}
	return true;
}

/** Compute the downstream blocked set for a failed node (pure, no instance). */
export function downstreamOf(failedNodeId: string, adjacency: Map<string, string[]>): string[] {
	const visited = new Set<string>();
	const queue = [...(adjacency.get(failedNodeId) ?? [])];
	while (queue.length) {
		const id = queue.shift()!;
		if (visited.has(id)) { continue; }
		visited.add(id);
		queue.push(...(adjacency.get(id) ?? []));
	}
	return [...visited];
}
