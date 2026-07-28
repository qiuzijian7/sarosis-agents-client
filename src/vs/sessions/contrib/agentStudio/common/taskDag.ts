/*---------------------------------------------------------------------------------------------
 *  AgentOS — Task DAG algorithms (pure, zero runtime dependency)
 *
 *  Kahn-style topological sort + ready-task selection for orchestration plans.
 *  Extracted from `browser/taskOrchestrationService.ts` so the "依次按任务执行"
 *  (sequential / dependency-respecting task execution) logic is unit-testable
 *  without the heavy DI container. Single source of truth: the service now
 *  delegates to these pure functions.
 *
 *  Mirrors the codebase's pure-common-module pattern (agentGraph.ts /
 *  agentRunState.ts). No VSCode / Electron imports.
 *--------------------------------------------------------------------------------------------*/

import { PlanTaskStatus } from '../../../common/agentStudioTypes.js';
import type { PlanTask } from '../../../common/agentStudioTypes.js';

/**
 * Kahn-style topological sort. Returns tasks in execution order.
 * Throws on circular dependency. Within the same topological layer,
 * tasks are sorted by priority (lower number = higher priority).
 * Also computes `depth` for each task as a side-effect.
 */
export function topologicalSort(tasks: PlanTask[]): PlanTask[] {
	const taskMap = new Map(tasks.map(t => [t.id, t]));

	// Build in-degree counts
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>(); // depId → dependentIds (reverse)
	for (const t of tasks) {
		inDegree.set(t.id, t.dependencies.length);
		for (const depId of t.dependencies) {
			if (!adj.has(depId)) { adj.set(depId, []); }
			adj.get(depId)!.push(t.id);
		}
	}

	// Seed queue with zero in-degree tasks
	let queue = tasks.filter(t => (inDegree.get(t.id) ?? 0) === 0);
	const sorted: PlanTask[] = [];
	let currentDepth = 0;

	while (queue.length > 0) {
		// Sort current layer by priority (ascending = higher priority first)
		queue.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2));

		const nextQueue: PlanTask[] = [];
		for (const task of queue) {
			task.depth = currentDepth;
			sorted.push(task);

			// Decrement in-degree of dependents
			for (const depId of adj.get(task.id) || []) {
				const deg = (inDegree.get(depId) ?? 1) - 1;
				inDegree.set(depId, deg);
				if (deg === 0) {
					const depTask = taskMap.get(depId);
					if (depTask) { nextQueue.push(depTask); }
				}
			}
		}
		queue = nextQueue;
		currentDepth++;
	}

	if (sorted.length !== tasks.length) {
		const missing = tasks.filter(t => !sorted.includes(t)).map(t => t.id);
		throw new Error(`检测到循环依赖，涉及任务: ${missing.join(', ')}`);
	}

	return sorted;
}

/**
 * Get all "ready" tasks (pending, all deps done) sorted by priority,
 * up to the concurrency limit.
 *
 * Pure variant of the service's `_getReadyTasks(plan)`: takes the task list
 * and an explicit `maxConcurrency` instead of reading them off the plan.
 */
export function getReadyTasks(tasks: PlanTask[], maxConcurrency: number): PlanTask[] {
	const running = tasks.filter(t => t.status === PlanTaskStatus.Running).length;
	const slots = maxConcurrency - running;
	if (slots <= 0) { return []; }

	return tasks
		.filter(t => t.status === PlanTaskStatus.Pending)
		.filter(t => {
			return t.dependencies.every(depId => {
				const dep = tasks.find(d => d.id === depId);
				return dep && dep.status === PlanTaskStatus.Done;
			});
		})
		.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
		.slice(0, slots);
}
