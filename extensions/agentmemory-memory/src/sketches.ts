/*---------------------------------------------------------------------------------------------
 *  临时行动图（Sketches）— 临时性的行动计划，可提升为永久或丢弃。
 *  1:1 复刻 agentmemory src/functions/sketches.ts
 *
 *  Sketch 是一组 Action 的临时容器，带过期时间。适用于：
 *    - 试探性计划（不确定是否执行的方案）
 *    - 临时任务编排（快速创建一组关联行动）
 *    - 探索性工作流（先草拟再决定是否固化）
 *
 *  生命周期：active → promoted（提升为永久）/ discarded（丢弃）/ expired（过期自动清理）
 *--------------------------------------------------------------------------------------------*/

import type { Action, ActionEdge } from './actions.js';

export type SketchStatus = 'active' | 'promoted' | 'discarded';

export interface Sketch {
	id: string;
	title: string;
	description: string;
	status: SketchStatus;
	actionIds: string[];
	project?: string;
	createdAt: string;
	expiresAt: string;
	promotedAt?: string;
	discardedAt?: string;
}

export interface SketchAction extends Action {
	sketchId: string;
}

export interface SketchCreateOptions {
	title: string;
	description?: string;
	expiresInMs?: number;
	project?: string;
}

export interface SketchAddActionOptions {
	sketchId: string;
	title: string;
	description?: string;
	priority?: number;
	dependsOn?: string[];
}

export interface SketchPromoteResult {
	sketchId: string;
	promotedIds: string[];
}

export interface SketchDiscardResult {
	sketchId: string;
	discardedCount: number;
}

export interface SketchGcResult {
	collected: number;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SketchManager {
	private _sketches = new Map<string, Sketch>();
	private _actions = new Map<string, SketchAction>();
	private _edges: ActionEdge[] = [];

	/**
	 * 创建临时行动图
	 */
	create(opts: SketchCreateOptions): Sketch {
		if (!opts.title?.trim()) {
			throw new Error('title is required');
		}
		const now = new Date();
		const expiresInMs = opts.expiresInMs ?? 3600000; // default 1 hour
		const sketch: Sketch = {
			id: generateId('sk'),
			title: opts.title.trim(),
			description: (opts.description ?? '').trim(),
			status: 'active',
			actionIds: [],
			project: opts.project,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
		};
		this._sketches.set(sketch.id, sketch);
		return sketch;
	}

	/**
	 * 向 sketch 添加行动（带依赖）
	 */
	addAction(opts: SketchAddActionOptions): { action: SketchAction; edges: ActionEdge[] } {
		const sketch = this._sketches.get(opts.sketchId);
		if (!sketch) throw new Error('sketch not found');
		if (sketch.status !== 'active') throw new Error('sketch is not active');

		// 验证依赖存在于同一 sketch 中
		if (opts.dependsOn && opts.dependsOn.length > 0) {
			const sketchActionSet = new Set(sketch.actionIds);
			for (const depId of opts.dependsOn) {
				if (!sketchActionSet.has(depId)) {
					throw new Error(`dependency ${depId} not found in this sketch`);
				}
			}
		}

		const now = new Date().toISOString();
		const action: SketchAction = {
			id: generateId('act'),
			title: opts.title.trim(),
			description: (opts.description ?? '').trim(),
			status: 'pending',
			priority: Math.max(1, Math.min(10, opts.priority ?? 5)),
			createdAt: now,
			updatedAt: now,
			createdBy: 'sketch',
			project: sketch.project,
			tags: [],
			sourceObservationIds: [],
			sourceMemoryIds: [],
			sketchId: sketch.id,
		};

		this._actions.set(action.id, action);

		const createdEdges: ActionEdge[] = [];
		if (opts.dependsOn && opts.dependsOn.length > 0) {
			for (const depId of opts.dependsOn) {
				const edge: ActionEdge = {
					id: generateId('ae'),
					type: 'requires',
					sourceActionId: action.id,
					targetActionId: depId,
					createdAt: now,
				};
				this._edges.push(edge);
				createdEdges.push(edge);
			}
		}

		sketch.actionIds.push(action.id);
		this._sketches.set(sketch.id, sketch);

		return { action, edges: createdEdges };
	}

	/**
	 * 提升 sketch 为永久行动（移除 sketchId 标记，action 变为独立行动）
	 */
	promote(sketchId: string, project?: string): SketchPromoteResult {
		const sketch = this._sketches.get(sketchId);
		if (!sketch) throw new Error('sketch not found');
		if (sketch.status !== 'active') throw new Error('sketch is not active');

		const promotedIds: string[] = [];
		for (const actionId of sketch.actionIds) {
			const action = this._actions.get(actionId);
			if (action) {
				delete (action as Partial<SketchAction>).sketchId;
				if (project) action.project = project;
				action.updatedAt = new Date().toISOString();
				this._actions.set(action.id, action);
				promotedIds.push(action.id);
			}
		}

		sketch.status = 'promoted';
		sketch.promotedAt = new Date().toISOString();
		this._sketches.set(sketch.id, sketch);

		return { sketchId, promotedIds };
	}

	/**
	 * 丢弃 sketch 及其所有行动和边
	 */
	discard(sketchId: string): SketchDiscardResult {
		const sketch = this._sketches.get(sketchId);
		if (!sketch) throw new Error('sketch not found');
		if (sketch.status !== 'active') throw new Error('sketch is not active');

		const actionIdSet = new Set(sketch.actionIds);

		// 删除关联的边
		this._edges = this._edges.filter(edge => {
			if (actionIdSet.has(edge.sourceActionId) || actionIdSet.has(edge.targetActionId)) {
				return false;
			}
			return true;
		});

		// 删除行动
		for (const actionId of sketch.actionIds) {
			this._actions.delete(actionId);
		}

		sketch.status = 'discarded';
		sketch.discardedAt = new Date().toISOString();
		this._sketches.set(sketch.id, sketch);

		return { sketchId, discardedCount: sketch.actionIds.length };
	}

	/**
	 * 列出 sketch（可按状态/项目过滤）
	 */
	list(filter?: { status?: SketchStatus; project?: string }): Array<Sketch & { actionCount: number }> {
		let sketches = [...this._sketches.values()];
		if (filter?.status) {
			sketches = sketches.filter(s => s.status === filter.status);
		}
		if (filter?.project) {
			sketches = sketches.filter(s => s.project === filter.project);
		}
		sketches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return sketches.map(s => ({ ...s, actionCount: s.actionIds.length }));
	}

	/**
	 * 获取单个 sketch
	 */
	get(sketchId: string): Sketch | undefined {
		return this._sketches.get(sketchId);
	}

	/**
	 * 获取 sketch 中的所有行动
	 */
	getActions(sketchId: string): SketchAction[] {
		const sketch = this._sketches.get(sketchId);
		if (!sketch) return [];
		return sketch.actionIds
			.map(id => this._actions.get(id))
			.filter((a): a is SketchAction => !!a);
	}

	/**
	 * GC — 清理过期的 active sketch
	 */
	gc(): SketchGcResult {
		const now = Date.now();
		let collected = 0;

		for (const [id, sketch] of this._sketches) {
			if (sketch.status !== 'active') continue;
			if (new Date(sketch.expiresAt).getTime() > now) continue;

			// 过期清理 = 丢弃
			const actionIdSet = new Set(sketch.actionIds);
			this._edges = this._edges.filter(edge => {
				if (actionIdSet.has(edge.sourceActionId) || actionIdSet.has(edge.targetActionId)) {
					return false;
				}
				return true;
			});
			for (const actionId of sketch.actionIds) {
				this._actions.delete(actionId);
			}
			sketch.status = 'discarded';
			sketch.discardedAt = new Date().toISOString();
			this._sketches.set(id, sketch);
			collected++;
		}

		return { collected };
	}

	/**
	 * 统计
	 */
	getStats(): { total: number; active: number; promoted: number; discarded: number; totalActions: number; totalEdges: number } {
		let active = 0, promoted = 0, discarded = 0;
		for (const s of this._sketches.values()) {
			if (s.status === 'active') active++;
			else if (s.status === 'promoted') promoted++;
			else if (s.status === 'discarded') discarded++;
		}
		return {
			total: this._sketches.size,
			active, promoted, discarded,
			totalActions: this._actions.size,
			totalEdges: this._edges.length,
		};
	}
}
