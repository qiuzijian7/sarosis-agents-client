/*---------------------------------------------------------------------------------------------
 *  Agent Factory
 *
 *  Implements multi-dimensional scoring ported from Ruflo queen-coordinator.scoreAgent.
 *  Handles agent scoring, selection, creation, pool reuse, and connection wiring.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentStudioService } from '../common/agentStudio.js';
import type { Employee, OrchestrationPlan } from '../common/types.js';
import { AgentType, PlanTaskStatus } from '../common/types.js';
import { ILogService } from '../../../../platform/log/common/log.js';

// ─── Score Weights (ported from Ruflo queen-coordinator) ────────────────────

const SCORE_WEIGHT_CAPABILITY = 0.40;
const SCORE_WEIGHT_LOAD = 0.30;
const SCORE_WEIGHT_AVAILABILITY = 0.30;

// ═══════════════════════════════════════════════════════════════════════════════

/**
 * AgentFactory — agent scoring, selection, creation, and connection management.
 *
 * Responsibilities:
 * - Score existing agents against task requirements (capability/load/availability)
 * - Reuse agents from pool when possible (name match → score match)
 * - Auto-create agents when no suitable candidate exists
 * - Wire connections between agents based on task dependency graph
 */
export class AgentFactory {

	private readonly _usedAgentIds = new Set<string>();

	constructor(
		private readonly agentStudioService: IAgentStudioService,
		private readonly logService: ILogService,
	) { }

	/**
	 * Reset the agent pool for a new execution cycle.
	 * Called at the start of each plan execution to allow full reuse.
	 */
	resetPool(): void {
		this._usedAgentIds.clear();
	}

	/**
	 * Assign agents to all tasks in the plan.
	 * Strategy:
	 * 1. Reuses existing agents by name match first (pool reuse).
	 * 2. Falls back to scoring-based selection from available agents.
	 * 3. Auto-creates agents when no suitable candidate exists.
	 */
	async assignAgents(plan: OrchestrationPlan): Promise<void> {
		const existingEmployees = await this.agentStudioService.getEmployees(plan.workspaceId);
		const existingByName = new Map(existingEmployees.map(e => [e.name.toLowerCase(), e]));

		for (const task of plan.tasks) {
			if (task.status === PlanTaskStatus.Done || task.status === PlanTaskStatus.Cancelled) {
				continue;
			}

			// Already assigned
			if (task.assigneeId) {
				this._usedAgentIds.add(task.assigneeId);
				continue;
			}

			// Strategy 1: Name match (pool reuse)
			if (task.assigneeName) {
				const existing = existingByName.get(task.assigneeName.toLowerCase());
				if (existing) {
					task.assigneeId = existing.id;
					this._usedAgentIds.add(existing.id);
					this.logService.info(`[AgentFactory] Reused agent "${existing.name}" for task "${task.title}"`);
					continue;
				}
			}

			// Strategy 2: Score-based selection
			const allEmps = await this.agentStudioService.getEmployees(plan.workspaceId);
			const best = this._selectBestAgent(allEmps, task.assigneeRole || '', this._usedAgentIds);
			if (best) {
				task.assigneeId = best.id;
				task.assigneeName = best.name;
				this._usedAgentIds.add(best.id);
				this.logService.info(`[AgentFactory] Score-matched agent "${best.name}" for task "${task.title}"`);
				continue;
			}

			// Strategy 3: Auto-create
			if (task.autoCreateAgent) {
				try {
					const newEmp = await this.agentStudioService.createEmployee({
						name: task.assigneeName || `Agent-${task.title.slice(0, 20)}`,
						role: task.assigneeRole || 'Agent',
						agentType: AgentType.Worker,
						workspaceId: plan.workspaceId,
					} as Partial<Employee>);
					task.assigneeId = newEmp.id;
					task.assigneeName = newEmp.name;
					this._usedAgentIds.add(newEmp.id);
					existingByName.set(newEmp.name.toLowerCase(), newEmp);
					this.logService.info(`[AgentFactory] Created agent "${newEmp.name}" for task "${task.title}"`);
				} catch (err) {
					task.status = PlanTaskStatus.Error;
					task.error = `Failed to create agent: ${String(err)}`;
					this.logService.error(`[AgentFactory] Failed to create agent "${task.assigneeName}": ${err}`);
				}
			}
		}
	}

	/**
	 * Auto-create connections between agents based on task dependencies.
	 * For each task with dependencies, creates a 'subagent' connection from
	 * the dependency's assignee to this task's assignee.
	 */
	async wireConnections(plan: OrchestrationPlan): Promise<void> {
		const existingConnections = await this.agentStudioService.getConnections(plan.workspaceId);
		const existingKeys = new Set(existingConnections.map(c => `${c.sourceId}-${c.targetId}`));

		for (const task of plan.tasks) {
			if (task.dependencies.length === 0 || !task.assigneeId) {
				continue;
			}

			for (const depTaskId of task.dependencies) {
				const depTask = plan.tasks.find(t => t.id === depTaskId);
				if (!depTask?.assigneeId) {
					continue;
				}

				// Skip self-connections and duplicates
				if (depTask.assigneeId === task.assigneeId) {
					continue;
				}
				const key = `${depTask.assigneeId}-${task.assigneeId}`;
				if (existingKeys.has(key)) {
					continue;
				}

				try {
					await this.agentStudioService.addConnection(plan.workspaceId, {
						sourceId: depTask.assigneeId,
						targetId: task.assigneeId,
						type: 'subagent' as never,
					});
					existingKeys.add(key);
					this.logService.info(`[AgentFactory] Wired connection: ${depTask.assigneeName} → ${task.assigneeName}`);
				} catch {
					// Connection may already exist — ignore
				}
			}
		}
	}

	// ─── Agent Scoring (ported from Ruflo queen-coordinator.scoreAgent) ──────

	/**
	 * Multi-dimensional agent score. Returns a number in [0, 1]. Higher = better fit.
	 * Dimensions: capability (0.40) + load (0.30) + availability (0.30)
	 */
	private _scoreAgent(agent: Employee, taskRole: string): number {
		const capabilityScore = this._calcCapabilityScore(agent, taskRole);

		// Load: fewer tasks = higher score (simplified; no real-time load tracking yet)
		const loadScore = agent.status === 'idle' ? 1.0
			: agent.status === 'working' ? 0.4
				: 0.1;

		// Availability: online and responsive agents score higher
		const availabilityScore = agent.status === 'idle' ? 1.0
			: agent.status === 'working' ? 0.3
				: agent.status === 'offline' ? 0.0
					: 0.2;

		return (
			capabilityScore * SCORE_WEIGHT_CAPABILITY +
			loadScore * SCORE_WEIGHT_LOAD +
			availabilityScore * SCORE_WEIGHT_AVAILABILITY
		);
	}

	/**
	 * Capability score based on role keyword matching.
	 * Exact match = 1.0, partial overlap = proportional, no match = 0.1 (baseline).
	 */
	private _calcCapabilityScore(agent: Employee, taskRole: string): number {
		const agentRole = (agent.role || '').toLowerCase();
		const required = taskRole.toLowerCase().trim();

		if (!required) { return 0.5; } // No role specified — neutral score
		if (agentRole === required) { return 1.0; } // Exact match

		// Partial match (agent role contains task role keywords or vice versa)
		const keywords = required.split(/[\s,/\\-]+/).filter(k => k.length > 2);
		if (keywords.length === 0) { return 0.3; }

		const matched = keywords.filter(kw => agentRole.includes(kw)).length;
		return Math.max(0.1, matched / keywords.length);
	}

	/**
	 * Select the best available agent from a pool using scoring.
	 * Excludes already-used agents and PM agents (PMs don't execute tasks).
	 * Returns the employee or undefined if none suitable.
	 */
	private _selectBestAgent(employees: Employee[], taskRole: string, excludeIds: Set<string>): Employee | undefined {
		const candidates = employees.filter(e =>
			!excludeIds.has(e.id) &&
			e.agentType !== AgentType.PM &&
			e.status !== 'offline'
		);

		if (candidates.length === 0) { return undefined; }

		let best: Employee | undefined;
		let bestScore = -1;

		for (const emp of candidates) {
			const score = this._scoreAgent(emp, taskRole);
			if (score > bestScore) {
				bestScore = score;
				best = emp;
			}
		}

		// Only return if score meets minimum threshold
		return bestScore >= 0.3 ? best : undefined;
	}
}
