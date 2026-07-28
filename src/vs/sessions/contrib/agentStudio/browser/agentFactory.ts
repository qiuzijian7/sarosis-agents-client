/*---------------------------------------------------------------------------------------------
 *  Agent Factory
 *
 *  Implements multi-dimensional scoring ported from Ruflo queen-coordinator.scoreAgent.
 *  Handles agent scoring, selection, creation, pool reuse, and connection wiring.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentStudioService } from '../common/agentStudio.js';
import type { Agent, OrchestrationPlan } from '../common/types.js';
import { PlanTaskStatus } from '../common/types.js';
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
 * - Enforce visibility rules: agents with agentInvocable=false cannot be sub-agents
 */
export class AgentFactory {

	private readonly _usedAgentIds = new Set<string>();

	constructor(
		private readonly agentStudioService: IAgentStudioService,
		private readonly logService: ILogService,
	) { }

	/**
	 * Check if an agent can be invoked as a sub-agent.
	 * Enforces the visibility.agentInvocable rule (aligned with VS Code's
	 * runSubagentTool which checks ICustomAgent.visibility.agentInvocable).
	 */
	isAgentInvocable(agent: Agent): boolean {
		if (!agent.visibility) { return true; }
		return agent.visibility.agentInvocable;
	}

	/**
	 * Check if an agent can be invoked by a user.
	 */
	isAgentUserInvocable(agent: Agent): boolean {
		if (!agent.visibility) { return true; }
		return agent.visibility.userInvocable;
	}

	/**
	 * Check if a parent agent is allowed to invoke a specific child agent.
	 * Enforces the parent's `agents` allowlist (aligned with ICustomAgent.agents).
	 */
	isSubagentAllowed(parent: Agent, childName: string): boolean {
		if (!parent.agents || parent.agents.length === 0 || parent.agents.includes('*')) {
			return true;
		}
		return parent.agents.includes(childName);
	}

	/**
	 * Validate that a sub-agent invocation is permitted by checking both
	 * the child's agentInvocable and the parent's agents allowlist.
	 * @throws Error if the invocation is not permitted
	 */
	validateSubagentInvocation(parent: Agent, child: Agent): void {
		if (!this.isAgentInvocable(child)) {
			throw new Error(
				`Agent "${child.name}" is not invocable as a sub-agent (visibility.agentInvocable=false).`
			);
		}
		if (!this.isSubagentAllowed(parent, child.name)) {
			throw new Error(
				`Agent "${parent.name}" is not allowed to invoke "${child.name}". Allowed: [${parent.agents?.join(', ') || 'none'}]`
			);
		}
	}

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
	 * 2. Falls back to scoring-based selection from the *existing* agent pool only.
	 *
	 * NOTE: Agent auto-creation is intentionally DISABLED in orchestration.
	 * DAG/agent-loop tasks may only reuse project agents that already exist.
	 * Users create new agents themselves via the create-agent skill / `new_agent`
	 * tool / CreateAgent UI — which are NOT part of this orchestration path.
	 * If no existing agent matches a task, the task is left unassigned (caller
	 * handles it as an error), never silently auto-created.
	 */
	async assignAgents(plan: OrchestrationPlan): Promise<void> {
		// Agents are global definitions; all are candidates across workspaces.
		const existingAgents = await this.agentStudioService.getAgents();
		// Defensive: filter out any null/undefined entries from the service
		const validAgents = existingAgents.filter(e => e && e.id);
		const existingByName = new Map(validAgents.map(e => [e.name.toLowerCase(), e]));

		this.logService.info(`[AgentFactory] assignAgents: workspaceId=${plan.workspaceId}, tasks=${plan.tasks.length}, existingAgents=${existingAgents.length}, usedAgentIds=${this._usedAgentIds.size}`);

		for (const task of plan.tasks) {
			if (task.status === PlanTaskStatus.Done || task.status === PlanTaskStatus.Cancelled) {
				continue;
			}

			// Already assigned
			if (task.assigneeId) {
				this._usedAgentIds.add(task.assigneeId);
				this.logService.info(`[AgentFactory] Task "${task.title}" already assigned to agent ${task.assigneeId} (${task.assigneeName})`);
				continue;
			}

			// Strategy 1: Name match (pool reuse) - 优先使用名称匹配的已有agent
			if (task.assigneeName) {
				const existing = existingByName.get(task.assigneeName.toLowerCase());
				if (existing) {
					task.assigneeId = existing.id;
					this._usedAgentIds.add(existing.id);
					this.logService.info(`[AgentFactory] [Strategy 1] Reused agent "${existing.name}" (id=${existing.id}) for task "${task.title}"`);
					continue;
				} else {
					this.logService.info(`[AgentFactory] [Strategy 1] No name match for "${task.assigneeName}" in existing agents: [${existingAgents.map(e => e.name).join(', ')}]`);
				}
			}

		// Strategy 2: Score-based selection - 从已有agent中选择评分最高的
		// 编排任务仅允许使用当前项目中已有的 agent（agent loop / DAG 不再自动创建 agent）。
		// 因此始终尝试从现有 agent 池中匹配，绝不新建。
		{
			const best = this._selectBestAgent(validAgents, task.assigneeRole || '', this._usedAgentIds);
			if (best) {
				task.assigneeId = best.id;
				task.assigneeName = best.name;
				this._usedAgentIds.add(best.id);
				this.logService.info(`[AgentFactory] [Strategy 2] Score-matched agent "${best.name}" (id=${best.id}, role=${best.role}) for task "${task.title}" (role=${task.assigneeRole})`);
				continue;
			} else {
				this.logService.warn(`[AgentFactory] [Strategy 2] No suitable existing agent found for task "${task.title}" (role=${task.assigneeRole}). Agent creation is disabled in orchestration — task left unassigned.`);
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
	private _scoreAgent(agent: Agent, taskRole: string): number {
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

		const totalScore = (
			capabilityScore * SCORE_WEIGHT_CAPABILITY +
			loadScore * SCORE_WEIGHT_LOAD +
			availabilityScore * SCORE_WEIGHT_AVAILABILITY
		);

		this.logService.info(`[AgentFactory] _scoreAgent: agent="${agent.name}" (role=${agent.role}, status=${agent.status}), taskRole="${taskRole}", capability=${capabilityScore.toFixed(3)}, load=${loadScore}, availability=${availabilityScore}, total=${totalScore.toFixed(3)}`);

		return totalScore;
	}

	/**
	 * Capability score based on role keyword matching + tool overlap.
	 * - Role exact match = 1.0
	 * - Role keyword overlap = proportional
	 * - Tool match bonus: +0.1 per matching tool (capped at +0.3)
	 * - No match = 0.1 (baseline)
	 */
	private _calcCapabilityScore(agent: Agent, taskRole: string): number {
		const agentRole = (agent.role || '').toLowerCase();
		const required = taskRole.toLowerCase().trim();

		if (!required) { return 0.5; } // No role specified — neutral score
		if (agentRole === required) { return 1.0; } // Exact match

		// Partial match (agent role contains task role keywords or vice versa)
		const keywords = required.split(/[\s,/\\-]+/).filter(k => k.length > 2);
		if (keywords.length === 0) { return 0.3; }

		const matched = keywords.filter(kw => agentRole.includes(kw)).length;
		let score = Math.max(0.1, matched / keywords.length);

		// Tool match bonus: if the agent has tools that are relevant to the task
		if (agent.tools && agent.tools.length > 0) {
			// Tasks requiring code changes benefit from write/terminal tools
			const codeRelatedTools = ['write_to_file', 'edit_file', 'replace_in_file', 'terminal'];
			const readRelatedTools = ['read_file', 'list_dir', 'search_files', 'grep_search'];
			const isCodeTask = keywords.some(kw =>
				['code', 'implement', 'build', 'fix', 'refactor', 'deploy', 'test'].includes(kw)
			);
			const isReadTask = keywords.some(kw =>
				['research', 'analyze', 'review', 'search', 'find'].includes(kw)
			);

			let toolBonus = 0;
			if (isCodeTask) {
				toolBonus += Math.min(0.3, agent.tools.filter(t => codeRelatedTools.includes(t)).length * 0.15);
			}
			if (isReadTask) {
				toolBonus += Math.min(0.2, agent.tools.filter(t => readRelatedTools.includes(t)).length * 0.2);
			}
			score = Math.min(1.0, score + toolBonus);
		}

		// Skills match bonus (descriptive labels, lower weight than tools)
		if (agent.skills && agent.skills.length > 0) {
			const skillMatch = keywords.filter(kw =>
				agent.skills!.some(s => s.toLowerCase().includes(kw) || kw.includes(s.toLowerCase()))
			).length;
			score = Math.min(1.0, score + Math.min(0.1, skillMatch * 0.05));
		}

		return score;
	}

	/**
	 * Select the best available agent from a pool using scoring.
	 * Excludes already-used agents and PM agents (PMs don't execute tasks).
	 * Returns the agent or undefined if none suitable.
	 */
	private _selectBestAgent(agents: Agent[], taskRole: string, excludeIds: Set<string>): Agent | undefined {
		const candidates = agents.filter(e =>
			e && e.id &&
			!excludeIds.has(e.id) &&
			e.status !== 'offline' &&
			this.isAgentInvocable(e)  // Exclude agents that can't be invoked as sub-agents
		);

		this.logService.info(`[AgentFactory] _selectBestAgent: taskRole=${taskRole}, total=${agents.length}, candidates=${candidates.length}, excluded=${excludeIds.size}`);

		if (candidates.length === 0) {
			this.logService.info(`[AgentFactory] _selectBestAgent: No candidates available. Excluded IDs: [${Array.from(excludeIds).join(', ')}]`);
			return undefined;
		}

		let best: Agent | undefined;
		let bestScore = -1;

		for (const emp of candidates) {
			const score = this._scoreAgent(emp, taskRole);
			this.logService.info(`[AgentFactory] _selectBestAgent: candidate "${emp.name}" (id=${emp.id}, role=${emp.role}, status=${emp.status}) score=${score.toFixed(3)}`);
			if (score > bestScore) {
				bestScore = score;
				best = emp;
			}
		}

		// Only return if score meets minimum threshold (lowered to 0.1 to prefer existing agents over creating new ones)
		const MIN_SCORE_THRESHOLD = 0.1;
		if (bestScore >= MIN_SCORE_THRESHOLD) {
			this.logService.info(`[AgentFactory] _selectBestAgent: Best candidate "${best?.name}" (score=${bestScore.toFixed(3)}) >= ${MIN_SCORE_THRESHOLD} threshold`);
			return best;
		} else {
			this.logService.info(`[AgentFactory] _selectBestAgent: Best candidate "${best?.name}" (score=${bestScore.toFixed(3)}) < ${MIN_SCORE_THRESHOLD} threshold, returning undefined`);
			return undefined;
		}
	}
}
