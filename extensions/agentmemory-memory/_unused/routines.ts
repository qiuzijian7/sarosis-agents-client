/*---------------------------------------------------------------------------------------------
 *  例行任务 — 多步骤可复用的工作流编排。
 *  参考 agentmemory src/functions/routines.ts
 *
 *  从 Procedural Memory（重复工作流模式）中提炼出的可执行例程。
 *  每个例程包含有序步骤，步骤间可有依赖关系。
 *
 *  核心能力：
 *    1. create(name, steps) — 创建例程
 *    2. run(routineId) — 执行例程，记录每次执行
 *    3. list(frozen/tags) — 列出例程
 *    4. getRunHistory(routineId) — 获取执行历史
 *
 *  步骤依赖：步骤的 dependsOn 指定必须先完成的步骤 order。
 *--------------------------------------------------------------------------------------------*/

export interface RoutineStep {
	order: number;
	title: string;
	description: string;
	actionTemplate: Record<string, unknown>;
	dependsOn: number[];     // 依赖的 step order 列表
}

export interface Routine {
	id: string;
	name: string;
	description: string;
	steps: RoutineStep[];
	createdAt: string;
	updatedAt: string;
	frozen: boolean;               // 冻结后不可修改
	tags: string[];
	sourceProceduralIds: string[];  // 来源 Procedural Memory ID
}

export interface RoutineRunStep {
	order: number;
	title: string;
	status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
	startedAt?: string;
	completedAt?: string;
	result?: string;
	error?: string;
}

export interface RoutineRun {
	id: string;
	routineId: string;
	steps: RoutineRunStep[];
	status: 'running' | 'completed' | 'failed' | 'aborted';
	startedAt: string;
	completedAt?: string;
	totalDurationMs?: number;
	triggeredBy: string;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RoutineManager {
	private _routines = new Map<string, Routine>();
	private _runs = new Map<string, RoutineRun[]>();
	private _maxRunsPerRoutine = 50;

	/**
	 * 创建例程
	 */
	create(opts: {
		name: string;
		description?: string;
		steps: Array<Omit<RoutineStep, 'order' | 'dependsOn'> & { order?: number; dependsOn?: number[] }>;
		tags?: string[];
		frozen?: boolean;
		sourceProceduralIds?: string[];
	}): Routine | null {
		if (!opts.name || !opts.steps || opts.steps.length === 0) {
			return null;
		}

		// 验证步骤
		for (let i = 0; i < opts.steps.length; i++) {
			if (!opts.steps[i].title?.trim()) {
				return null;
			}
		}

		// 解析 order
		const orders = opts.steps.map((s, i) => s.order ?? i);
		const uniqueOrders = new Set(orders);
		if (uniqueOrders.size !== orders.length) {
			return null;
		}

		// 验证依赖
		for (const step of opts.steps) {
			const deps = step.dependsOn ?? [];
			for (const dep of deps) {
				if (!uniqueOrders.has(dep)) {
					return null;
				}
			}
		}

		const now = new Date().toISOString();
		const routine: Routine = {
			id: generateId('rtn'),
			name: opts.name.trim(),
			description: (opts.description ?? '').trim(),
			steps: opts.steps.map((s, i) => ({
				order: s.order ?? i,
				title: s.title,
				description: s.description ?? '',
				actionTemplate: s.actionTemplate ?? {},
				dependsOn: s.dependsOn ?? [],
			})),
			createdAt: now,
			updatedAt: now,
			frozen: opts.frozen ?? true,
			tags: opts.tags ?? [],
			sourceProceduralIds: opts.sourceProceduralIds ?? [],
		};

		this._routines.set(routine.id, routine);
		return routine;
	}

	/**
	 * 获取例程
	 */
	get(id: string): Routine | null {
		return this._routines.get(id) ?? null;
	}

	/**
	 * 列出例程
	 */
	list(filter?: { frozen?: boolean; tags?: string[] }): Routine[] {
		let routines = Array.from(this._routines.values());
		if (filter?.frozen !== undefined) {
			routines = routines.filter(r => r.frozen === filter.frozen);
		}
		if (filter?.tags && filter.tags.length > 0) {
			routines = routines.filter(r => filter.tags!.some(t => r.tags.includes(t)));
		}
		return routines.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/**
	 * 开始执行例程
	 */
	startRun(routineId: string, triggeredBy: string): RoutineRun | null {
		const routine = this._routines.get(routineId);
		if (!routine) return null;

		const run: RoutineRun = {
			id: generateId('run'),
			routineId,
			steps: routine.steps.map(s => ({
				order: s.order,
				title: s.title,
				status: 'pending' as const,
			})),
			status: 'running',
			startedAt: new Date().toISOString(),
			triggeredBy,
		};

		let runs = this._runs.get(routineId);
		if (!runs) {
			runs = [];
			this._runs.set(routineId, runs);
		}
		runs.push(run);
		// 限制历史数量
		if (runs.length > this._maxRunsPerRoutine) {
			runs.shift();
		}

		return run;
	}

	/**
	 * 更新步骤状态
	 */
	updateStep(runId: string, stepOrder: number, status: RoutineRunStep['status'], result?: string, error?: string): boolean {
		for (const runs of this._runs.values()) {
			const run = runs.find(r => r.id === runId);
			if (run) {
				const step = run.steps.find(s => s.order === stepOrder);
				if (step) {
					step.status = status;
					if (status === 'running') step.startedAt = new Date().toISOString();
					if (status === 'done' || status === 'failed' || status === 'skipped') {
						step.completedAt = new Date().toISOString();
					}
					if (result !== undefined) step.result = result;
					if (error !== undefined) step.error = error;
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * 完成例程执行
	 */
	completeRun(runId: string, status: 'completed' | 'failed' | 'aborted'): boolean {
		for (const runs of this._runs.values()) {
			const run = runs.find(r => r.id === runId);
			if (run) {
				run.status = status;
				run.completedAt = new Date().toISOString();
				const start = new Date(run.startedAt).getTime();
				const end = new Date(run.completedAt).getTime();
				run.totalDurationMs = end - start;
				return true;
			}
		}
		return false;
	}

	/**
	 * 获取执行历史
	 */
	getRunHistory(routineId: string, limit: number = 20): RoutineRun[] {
		const runs = this._runs.get(routineId);
		if (!runs) return [];
		return runs.slice(-limit).reverse();
	}

	/**
	 * 获取所有执行统计
	 */
	getStats(): { totalRoutines: number; totalRuns: number; avgStepsPerRoutine: number; successRate: number } {
		let totalRuns = 0;
		let successfulRuns = 0;
		for (const runs of this._runs.values()) {
			totalRuns += runs.length;
			successfulRuns += runs.filter(r => r.status === 'completed').length;
		}
		const routines = Array.from(this._routines.values());
		const avgSteps = routines.length > 0
			? routines.reduce((sum, r) => sum + r.steps.length, 0) / routines.length
			: 0;
		return {
			totalRoutines: routines.length,
			totalRuns,
			avgStepsPerRoutine: Math.round(avgSteps * 10) / 10,
			successRate: totalRuns > 0 ? successfulRuns / totalRuns : 0,
		};
	}

	/**
	 * 删除例程
	 */
	delete(id: string): boolean {
		const existed = this._routines.delete(id);
		this._runs.delete(id);
		return existed;
	}

	/**
	 * 清除所有状态
	 */
	clear(): void {
		this._routines.clear();
		this._runs.clear();
	}
}
