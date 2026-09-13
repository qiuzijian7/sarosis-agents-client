/*---------------------------------------------------------------------------------------------
 *  动作追踪 — 任务/动作的状态管理 + 依赖边。
 *  1:1 复刻 agentmemory src/functions/actions.ts
 *
 *  Action 是可执行的工作单元，有状态、优先级、依赖关系。
 *  ActionEdge 描述动作间的关系（requires/unlocks/spawned_by/gated_by/conflicts_with）。
 *--------------------------------------------------------------------------------------------*/

export type ActionStatus = 'pending' | 'active' | 'blocked' | 'done' | 'cancelled' | 'failed';
export type ActionEdgeType = 'requires' | 'unlocks' | 'spawned_by' | 'gated_by' | 'conflicts_with';

export interface Action {
	id: string;
	title: string;
	description: string;
	status: ActionStatus;
	priority: number;          // 1-10
	createdAt: string;
	updatedAt: string;
	createdBy: string;
	project?: string;
	tags: string[];
	parentId?: string;
	sourceObservationIds: string[];
	sourceMemoryIds: string[];
	sketchId?: string;
	assignedTo?: string;
	crystallizedInto?: string;
}

export interface ActionEdge {
	id: string;
	type: ActionEdgeType;
	sourceActionId: string;
	targetActionId: string;
	createdAt: string;
}

const VALID_EDGE_TYPES: ActionEdgeType[] = ['requires', 'unlocks', 'spawned_by', 'gated_by', 'conflicts_with'];

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class ActionManager {
	private _actions = new Map<string, Action>();
	private _edges: ActionEdge[] = [];
	private _edgesBySource = new Map<string, ActionEdge[]>();
	private _edgesByTarget = new Map<string, ActionEdge[]>();

	create(opts: {
		title: string;
		description?: string;
		priority?: number;
		createdBy?: string;
		project?: string;
		tags?: string[];
		parentId?: string;
		sourceObservationIds?: string[];
		sourceMemoryIds?: string[];
	}): Action | null {
		if (!opts.title?.trim()) return null;

		if (opts.parentId && !this._actions.has(opts.parentId)) return null;

		const now = new Date().toISOString();
		const action: Action = {
			id: generateId('act'),
			title: opts.title.trim(),
			description: (opts.description ?? '').trim(),
			status: 'pending',
			priority: Math.max(1, Math.min(10, opts.priority ?? 5)),
			createdAt: now,
			updatedAt: now,
			createdBy: opts.createdBy ?? 'unknown',
			project: opts.project,
			tags: opts.tags ?? [],
			parentId: opts.parentId,
			sourceObservationIds: opts.sourceObservationIds ?? [],
			sourceMemoryIds: opts.sourceMemoryIds ?? [],
		};

		this._actions.set(action.id, action);

		// If has parent, add spawned_by edge
		if (opts.parentId) {
			this.addEdge(action.id, opts.parentId, 'spawned_by');
			// Parent with requires edge becomes blocked
			const parentEdges = this._edgesByTarget.get(opts.parentId) ?? [];
			if (parentEdges.some(e => e.type === 'requires' && e.sourceActionId === opts.parentId)) {
				action.status = 'blocked';
			}
		}

		return action;
	}

	addEdge(sourceActionId: string, targetActionId: string, type: ActionEdgeType): boolean {
		if (!this._actions.has(sourceActionId) || !this._actions.has(targetActionId)) return false;
		if (!VALID_EDGE_TYPES.includes(type)) return false;

		const edge: ActionEdge = {
			id: generateId('ae'),
			type,
			sourceActionId,
			targetActionId,
			createdAt: new Date().toISOString(),
		};
		this._edges.push(edge);

		const bySrc = this._edgesBySource.get(sourceActionId) ?? [];
		bySrc.push(edge);
		this._edgesBySource.set(sourceActionId, bySrc);

		const byTgt = this._edgesByTarget.get(targetActionId) ?? [];
		byTgt.push(edge);
		this._edgesByTarget.set(targetActionId, byTgt);

		// If requires edge, block the source action
		if (type === 'requires') {
			const source = this._actions.get(sourceActionId);
			if (source && source.status === 'pending') {
				source.status = 'blocked';
				source.updatedAt = new Date().toISOString();
			}
		}

		return true;
	}

	update(id: string, updates: Partial<Pick<Action, 'title' | 'description' | 'priority' | 'status' | 'tags' | 'assignedTo'>>): boolean {
		const action = this._actions.get(id);
		if (!action) return false;
		Object.assign(action, updates, { updatedAt: new Date().toISOString() });

		// If status changed to done, unblock dependents
		if (updates.status === 'done') {
			this._unblockDependents(id);
		}
		return true;
	}

	private _unblockDependents(actionId: string): void {
		const edges = this._edgesBySource.get(actionId) ?? [];
		for (const edge of edges) {
			if (edge.type === 'unlocks' || edge.type === 'requires') {
				const dependent = this._actions.get(edge.targetActionId);
				if (dependent && dependent.status === 'blocked') {
					// Check all requires edges are satisfied
					const reqEdges = (this._edgesByTarget.get(dependent.id) ?? [])
						.filter(e => e.type === 'requires');
					const allDone = reqEdges.every(e => {
						const dep = this._actions.get(e.sourceActionId);
						return dep?.status === 'done';
					});
					if (allDone) {
						dependent.status = 'pending';
						dependent.updatedAt = new Date().toISOString();
					}
				}
			}
		}
	}

	get(id: string): Action | null { return this._actions.get(id) ?? null; }
	list(filter?: { status?: ActionStatus; project?: string; tags?: string[] }): Action[] {
		let actions = Array.from(this._actions.values());
		if (filter?.status) actions = actions.filter(a => a.status === filter.status);
		if (filter?.project) actions = actions.filter(a => a.project === filter.project);
		if (filter?.tags) actions = actions.filter(a => filter.tags!.some(t => a.tags.includes(t)));
		return actions.sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));
	}

	getEdges(actionId: string): ActionEdge[] {
		return [...(this._edgesBySource.get(actionId) ?? []), ...(this._edgesByTarget.get(actionId) ?? [])];
	}

	getChildren(parentId: string): Action[] {
		return Array.from(this._actions.values()).filter(a => a.parentId === parentId);
	}

	delete(id: string): boolean {
		const existed = this._actions.delete(id);
		this._edges = this._edges.filter(e => e.sourceActionId !== id && e.targetActionId !== id);
		this._edgesBySource.delete(id);
		this._edgesByTarget.delete(id);
		for (const [aid, edges] of this._edgesBySource) {
			this._edgesBySource.set(aid, edges.filter(e => e.targetActionId !== id));
		}
		for (const [aid, edges] of this._edgesByTarget) {
			this._edgesByTarget.set(aid, edges.filter(e => e.sourceActionId !== id));
		}
		return existed;
	}

	getStats(): { total: number; byStatus: Record<string, number>; totalEdges: number; blocked: number } {
		const byStatus: Record<string, number> = {};
		for (const a of this._actions.values()) {
			byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
		}
		return { total: this._actions.size, byStatus, totalEdges: this._edges.length, blocked: byStatus['blocked'] ?? 0 };
	}

	clear(): void { this._actions.clear(); this._edges = []; this._edgesBySource.clear(); this._edgesByTarget.clear(); }
}
