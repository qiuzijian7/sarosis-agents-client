/*---------------------------------------------------------------------------------------------
 *  Task Orchestration Service
 *
 *  Algorithms ported from Ruflo v3 (@claude-flow/swarm):
 *  - DAG dependency graph with bidirectional adjacency lists
 *  - Kahn-style topological sort with cycle detection
 *  - DFS cycle prevention on dependency insertion
 *  - Automatic downstream unblocking on task completion
 *  - Task timeout monitoring (default 5 min)
 *  - Auto-retry with back-off (default 3 attempts)
 *  - Concurrency limiter (default 3 parallel tasks)
 *  - Multi-dimensional agent scoring (capability / load / availability)
 *  - Type-based task decomposition strategy (coding → design→impl→test)
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ITaskOrchestrationService, IAgentStudioService, IAgentTaskBoardService } from '../common/agentStudio.js';
import type { OrchestrationTaskAction } from '../common/agentStudio.js';
import type { OrchestrationPlan, PlanTask, Employee } from '../common/types.js';
import { OrchestrationPlanStatus, PlanTaskStatus, TaskBoardStatus, TaskSource, AgentType } from '../common/types.js';
import { AGENT_STUDIO_DATA_PATH_SETTING } from '../common/constants.js';

const DATA_FILE_ORCHESTRATION = 'orchestration-plans.json';

// ─── Defaults (aligned with Ruflo) ──────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_MAX_CONCURRENCY = 3;

// Canvas layout constants
const CANVAS_ROW_HEIGHT = 220;
const CANVAS_COL_WIDTH = 300;
const CANVAS_ORIGIN_X = 150;
const CANVAS_ORIGIN_Y = 100;

// ─── Agent scoring weights (ported from Ruflo queen-coordinator) ────────────

const SCORE_WEIGHT_CAPABILITY = 0.40;
const SCORE_WEIGHT_LOAD = 0.30;
const SCORE_WEIGHT_AVAILABILITY = 0.30;

// ─── Type-based decomposition templates (ported from Ruflo queen) ───────────

interface DecompTemplate {
	phases: Array<{ suffix: string; role: string; agentName: string }>;
	sequential: boolean;
}

const DECOMP_TEMPLATES: Record<string, DecompTemplate> = {
	coding: {
		phases: [
			{ suffix: '设计与规划', role: 'Architect', agentName: 'Designer' },
			{ suffix: '实现', role: 'Software Developer', agentName: 'Developer' },
			{ suffix: '测试', role: 'QA Engineer', agentName: 'QA Tester' },
		],
		sequential: true,
	},
	testing: {
		phases: [
			{ suffix: '测试分析', role: 'QA Analyst', agentName: 'QA Analyst' },
			{ suffix: '测试执行', role: 'QA Engineer', agentName: 'QA Tester' },
		],
		sequential: true,
	},
	research: {
		phases: [
			{ suffix: '信息收集', role: 'Researcher', agentName: 'Researcher' },
			{ suffix: '分析总结', role: 'Analyst', agentName: 'Analyst' },
		],
		sequential: true,
	},
	deployment: {
		phases: [
			{ suffix: '构建打包', role: 'Build Engineer', agentName: 'Builder' },
			{ suffix: '部署发布', role: 'DevOps Engineer', agentName: 'DevOps' },
		],
		sequential: true,
	},
};

// ═══════════════════════════════════════════════════════════════════════════════

export class TaskOrchestrationService extends Disposable implements ITaskOrchestrationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePlan = this._register(new Emitter<OrchestrationPlan>());
	readonly onDidChangePlan: Event<OrchestrationPlan> = this._onDidChangePlan.event;

	private readonly _onDidChangeTask = this._register(new Emitter<{ planId: string; task: PlanTask }>());
	readonly onDidChangeTask: Event<{ planId: string; task: PlanTask }> = this._onDidChangeTask.event;

	/** Timeout check interval handle */
	private _timeoutTimer: ReturnType<typeof setInterval> | undefined;
	/** Serialise file writes to avoid race conditions */
	private _writeLock = false;

	private _dataUri: URI | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
	) {
		super();
		this._startTimeoutMonitor();
	}

	override dispose(): void {
		if (this._timeoutTimer) { clearInterval(this._timeoutTimer); }
		super.dispose();
	}

	// ═══ Data Persistence (with simple write lock) ══════════════════════════════

	private _getDataUri(): URI {
		if (!this._dataUri) {
			const customPath = this.configurationService.getValue<string>(AGENT_STUDIO_DATA_PATH_SETTING);
			if (customPath) {
				this._dataUri = URI.file(customPath);
			} else {
				this._dataUri = URI.file(process.env.HOME || process.env.USERPROFILE || '~')
					.with({ path: `${process.env.HOME || process.env.USERPROFILE || '~'}/.agent-studio/data` });
			}
		}
		return this._dataUri;
	}

	private async _readPlans(): Promise<OrchestrationPlan[]> {
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_ORCHESTRATION);
			const content = await this.fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as OrchestrationPlan[];
		} catch {
			return [];
		}
	}

	private async _writePlans(plans: OrchestrationPlan[]): Promise<void> {
		// Simple spin-lock to serialise concurrent writes
		while (this._writeLock) {
			await new Promise(r => setTimeout(r, 10));
		}
		this._writeLock = true;
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_ORCHESTRATION);
			const content = VSBuffer.fromString(JSON.stringify(plans, null, 2));
			await this.fileService.writeFile(uri, content);
		} finally {
			this._writeLock = false;
		}
	}

	private _generateId(prefix: string): string {
		return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	// ═══ DAG Algorithms (ported from Ruflo task-orchestrator.ts) ═════════════════

	/**
	 * DFS cycle detection — would adding `dependency` as a dep of `taskId` create a cycle?
	 * Ported from Ruflo `wouldCreateCycle`.
	 */
	private _wouldCreateCycle(tasks: PlanTask[], taskId: string, newDependency: string): boolean {
		const depsMap = new Map(tasks.map(t => [t.id, new Set(t.dependencies)]));
		const visited = new Set<string>();
		const stack = [newDependency];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (current === taskId) { return true; }
			if (visited.has(current)) { continue; }
			visited.add(current);
			const deps = depsMap.get(current);
			if (deps) { stack.push(...deps); }
		}
		return false;
	}

	/**
	 * Kahn-style topological sort. Returns tasks in execution order.
	 * Throws on circular dependency. Within the same topological layer,
	 * tasks are sorted by priority (lower number = higher priority).
	 * Also computes `depth` for each task as a side-effect.
	 *
	 * Ported from Ruflo `Task.resolveExecutionOrder` + `DagBridge.topologicalSort`.
	 */
	private _topologicalSort(tasks: PlanTask[]): PlanTask[] {
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
	 * Build a bidirectional adjacency-list representation of the dependency graph.
	 * Returns { forward: task→deps, reverse: task→dependents }.
	 *
	 * Ported from Ruflo `TaskOrchestrator.dependencyGraph` / `dependentGraph`.
	 */
	private _buildDependencyGraphs(tasks: PlanTask[]): {
		forward: Map<string, Set<string>>; // task → its dependencies
		reverse: Map<string, Set<string>>; // task → tasks that depend on it
	} {
		const forward = new Map<string, Set<string>>();
		const reverse = new Map<string, Set<string>>();
		for (const t of tasks) {
			forward.set(t.id, new Set(t.dependencies));
			if (!reverse.has(t.id)) { reverse.set(t.id, new Set()); }
			for (const depId of t.dependencies) {
				if (!reverse.has(depId)) { reverse.set(depId, new Set()); }
				reverse.get(depId)!.add(t.id);
			}
		}
		return { forward, reverse };
	}

	/**
	 * After a task completes, check its dependents and unblock any that are now ready.
	 * Respects maxConcurrency.
	 *
	 * Ported from Ruflo `TaskOrchestrator.unblockDependentTasks`.
	 */
	private _unblockDependentTasks(plan: OrchestrationPlan, completedTaskId: string): PlanTask[] {
		const { reverse } = this._buildDependencyGraphs(plan.tasks);
		const nowRunning = plan.tasks.filter(t => t.status === PlanTaskStatus.Running).length;
		const maxConc = plan.maxConcurrency || DEFAULT_MAX_CONCURRENCY;
		const promoted: PlanTask[] = [];

		const dependents = reverse.get(completedTaskId) || new Set();
		// Sort dependents by priority so higher-priority tasks get promoted first
		const sortedDeps = [...dependents]
			.map(id => plan.tasks.find(t => t.id === id)!)
			.filter(Boolean)
			.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2));

		for (const task of sortedDeps) {
			if (task.status !== PlanTaskStatus.Pending) { continue; }
			// Check all deps complete
			const allDepsComplete = task.dependencies.every(depId => {
				const dep = plan.tasks.find(t => t.id === depId);
				return dep && dep.status === PlanTaskStatus.Done;
			});
			if (allDepsComplete && (nowRunning + promoted.length) < maxConc) {
				task.status = PlanTaskStatus.Running;
				task.startedAt = new Date().toISOString();
				promoted.push(task);
			}
		}
		return promoted;
	}

	/**
	 * Get all "ready" tasks (pending, all deps done) sorted by priority,
	 * up to the concurrency limit.
	 *
	 * Ported from Ruflo `TaskOrchestrator.getNextTask` (batch version).
	 */
	private _getReadyTasks(plan: OrchestrationPlan): PlanTask[] {
		const running = plan.tasks.filter(t => t.status === PlanTaskStatus.Running).length;
		const maxConc = plan.maxConcurrency || DEFAULT_MAX_CONCURRENCY;
		const slots = maxConc - running;
		if (slots <= 0) { return []; }

		return plan.tasks
			.filter(t => t.status === PlanTaskStatus.Pending)
			.filter(t => {
				return t.dependencies.every(depId => {
					const dep = plan.tasks.find(d => d.id === depId);
					return dep && dep.status === PlanTaskStatus.Done;
				});
			})
			.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
			.slice(0, slots);
	}

	// ═══ Agent Scoring (ported from Ruflo queen-coordinator.scoreAgent) ══════════

	/**
	 * Multi-dimensional agent score for task assignment.
	 * Returns a number in [0, 1]. Higher = better fit.
	 */
	private _scoreAgent(agent: Employee, taskRole: string): number {
		// Capability: how well does the agent's role match the task's required role?
		const capabilityScore = this._calcCapabilityScore(agent, taskRole);

		// Load: fewer tasks = higher score (simplified; no real-time load tracking yet)
		const loadScore = agent.status === 'idle' ? 1.0
			: agent.status === 'working' ? 0.4
				: agent.status === 'thinking' ? 0.6
					: 0.1;

		// Availability
		const availabilityScore = (agent.status === 'idle' || agent.status === 'thinking') ? 1.0
			: agent.status === 'working' ? 0.3
				: 0.0;

		return (
			capabilityScore * SCORE_WEIGHT_CAPABILITY +
			loadScore * SCORE_WEIGHT_LOAD +
			availabilityScore * SCORE_WEIGHT_AVAILABILITY
		);
	}

	private _calcCapabilityScore(agent: Employee, taskRole: string): number {
		if (!taskRole) { return 0.5; }
		const agentRole = (agent.role || '').toLowerCase();
		const required = taskRole.toLowerCase();

		// Exact match
		if (agentRole === required) { return 1.0; }

		// Partial match (agent role contains task role keywords or vice versa)
		const keywords = required.split(/[\s/\\-]+/);
		const matched = keywords.filter(kw => agentRole.includes(kw)).length;
		if (matched > 0) { return 0.5 + 0.3 * (matched / keywords.length); }

		return 0.3; // baseline
	}

	/**
	 * Select the best-fit agent for a task from the workspace employees.
	 * Returns the employee or undefined if none suitable.
	 */
	private _selectBestAgent(employees: Employee[], taskRole: string, excludeIds: Set<string>): Employee | undefined {
		const candidates = employees.filter(e =>
			!excludeIds.has(e.id) &&
			e.agentType !== AgentType.Planner &&
			e.agentType !== AgentType.PM
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
		return best;
	}

	// ═══ Timeout Monitor (ported from Ruflo Task.isTimedOut) ═════════════════════

	private _startTimeoutMonitor(): void {
		// Check every 30 seconds for timed-out tasks
		this._timeoutTimer = setInterval(() => this._checkTimeouts(), 30_000);
	}

	private async _checkTimeouts(): Promise<void> {
		try {
			const plans = await this._readPlans();
			let dirty = false;

			for (const plan of plans) {
				if (plan.status !== OrchestrationPlanStatus.Executing) { continue; }

				for (const task of plan.tasks) {
					if (task.status !== PlanTaskStatus.Running || !task.startedAt) { continue; }
					const elapsed = Date.now() - new Date(task.startedAt).getTime();
					if (elapsed > (task.timeoutMs || DEFAULT_TIMEOUT_MS)) {
						this.logService.warn(`[Orchestration] Task ${task.id} timed out after ${elapsed}ms`);
						this._failTask(plan, task, `Task timed out after ${Math.round(elapsed / 1000)}s`);
						dirty = true;
					}
				}
			}

			if (dirty) {
				await this._writePlans(plans);
			}
		} catch (err) {
			this.logService.warn('[Orchestration] Timeout check error:', err);
		}
	}

	/**
	 * Fail a task with auto-retry logic. Ported from Ruflo `Task.fail()`.
	 * If retryCount < maxRetries, re-queues the task instead of permanent failure.
	 */
	private _failTask(plan: OrchestrationPlan, task: PlanTask, error: string): void {
		task.error = error;
		task.retryCount = (task.retryCount || 0) + 1;
		const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;

		if (task.retryCount >= maxRetries) {
			task.status = PlanTaskStatus.Error;
			task.completedAt = new Date().toISOString();
			this.logService.error(`[Orchestration] Task ${task.id} permanently failed (${task.retryCount}/${maxRetries}): ${error}`);
		} else {
			task.status = PlanTaskStatus.Pending;
			task.startedAt = undefined;
			task.assigneeId = undefined; // release agent for re-assignment
			this.logService.info(`[Orchestration] Task ${task.id} queued for retry (${task.retryCount}/${maxRetries})`);
		}

		this._onDidChangeTask.fire({ planId: plan.id, task });

		// Check if plan is terminal
		this._checkPlanCompletion(plan);
	}

	private _checkPlanCompletion(plan: OrchestrationPlan): void {
		const allTerminal = plan.tasks.every(t =>
			t.status === PlanTaskStatus.Done ||
			t.status === PlanTaskStatus.Cancelled ||
			t.status === PlanTaskStatus.Error
		);
		if (allTerminal) {
			const hasError = plan.tasks.some(t => t.status === PlanTaskStatus.Error);
			plan.status = hasError ? OrchestrationPlanStatus.Error : OrchestrationPlanStatus.Completed;
			plan.completedAt = new Date().toISOString();
			plan.updatedAt = plan.completedAt;
			this._onDidChangePlan.fire(plan);
		}
	}

	// ═══ Goal Decomposition (ported from Ruflo queen-coordinator.decomposeTask) ══

	/**
	 * Type-based decomposition strategy.
	 * Detects task type from goal text, then applies a template (Ruflo pattern).
	 */
	private _decomposeGoal(goal: string, existingAgentNames: Set<string>): PlanTask[] {
		const now = new Date().toISOString();
		const goalLower = goal.toLowerCase();

		// Detect task type from content
		const taskType = this._detectTaskType(goalLower);

		// Simple task — short description, no decomposition needed (Ruflo: desc < 200 chars)
		const isSimple = goal.length < 80 && !this._hasMultipleParts(goalLower);
		if (isSimple) {
			return [this._createTask({
				title: goal.slice(0, 80),
				description: goal,
				agentName: this._inferAgentName(goal, 0),
				role: this._inferRole(goal),
				existingAgentNames,
				deps: [],
				priority: 2,
				now,
			})];
		}

		// Check if we have a decomposition template for this type
		const template = DECOMP_TEMPLATES[taskType];
		if (template) {
			return this._decomposeWithTemplate(goal, template, existingAgentNames, now);
		}

		// Fallback: split by natural-language delimiters
		return this._decomposeByDelimiters(goal, existingAgentNames, now);
	}

	private _detectTaskType(text: string): string {
		if (/cod(?:e|ing)|implement|开发|编码|编程|写代码|实现/.test(text)) { return 'coding'; }
		if (/test|测试|qa|验证/.test(text)) { return 'testing'; }
		if (/research|调研|研究|分析/.test(text)) { return 'research'; }
		if (/deploy|部署|发布|上线/.test(text)) { return 'deployment'; }
		return 'generic';
	}

	private _hasMultipleParts(text: string): boolean {
		return /[,，;；、]|\band\b|\bthen\b|然后|接着|之后|并且|同时/.test(text);
	}

	private _decomposeWithTemplate(
		goal: string, template: DecompTemplate, existing: Set<string>, now: string,
	): PlanTask[] {
		const tasks: PlanTask[] = [];
		let prevId: string | undefined;

		for (let i = 0; i < template.phases.length; i++) {
			const phase = template.phases[i];
			const deps: string[] = [];
			if (template.sequential && prevId) {
				// Cycle-safe: validate before adding dependency
				if (!this._wouldCreateCycle(tasks, prevId, prevId)) {
					deps.push(prevId);
				}
			}

			const task = this._createTask({
				title: `${phase.suffix}: ${goal.slice(0, 50)}`,
				description: `[${phase.suffix}] ${goal}`,
				agentName: phase.agentName,
				role: phase.role,
				existingAgentNames: existing,
				deps,
				priority: i + 1,
				now,
			});
			tasks.push(task);
			prevId = task.id;
		}
		return tasks;
	}

	private _decomposeByDelimiters(goal: string, existing: Set<string>, now: string): PlanTask[] {
		const separators = /[,，;；、]|\band\b|\bthen\b|然后|接着|之后/gi;
		const parts = goal.split(separators).map(p => p.trim()).filter(p => p.length > 3);

		if (parts.length <= 1) {
			return [this._createTask({
				title: goal.slice(0, 80),
				description: goal,
				agentName: this._inferAgentName(goal, 0),
				role: this._inferRole(goal),
				existingAgentNames: existing,
				deps: [],
				priority: 2,
				now,
			})];
		}

		const hasSequential = /then|接着|然后|之后|最后/.test(goal.toLowerCase());
		const tasks: PlanTask[] = [];
		let prevId: string | undefined;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const deps: string[] = [];
			if (hasSequential && prevId) {
				// Cycle-safe: validate before adding dependency
				if (!this._wouldCreateCycle(tasks, part /* new task placeholder */, prevId)) {
					deps.push(prevId);
				}
			}

			const task = this._createTask({
				title: part.slice(0, 60) + (part.length > 60 ? '...' : ''),
				description: part,
				agentName: this._inferAgentName(part, i),
				role: this._inferRole(part),
				existingAgentNames: existing,
				deps,
				priority: i + 1,
				now,
			});
			tasks.push(task);
			if (hasSequential) { prevId = task.id; }
		}
		return tasks;
	}

	private _createTask(opts: {
		title: string; description: string; agentName: string; role: string;
		existingAgentNames: Set<string>; deps: string[]; priority: number; now: string;
	}): PlanTask {
		return {
			id: this._generateId('orch_task'),
			title: opts.title,
			description: opts.description,
			status: PlanTaskStatus.Pending,
			dependencies: opts.deps,
			assigneeName: opts.agentName,
			assigneeRole: opts.role,
			autoCreateAgent: !opts.existingAgentNames.has(opts.agentName.toLowerCase()),
			priority: opts.priority,
			depth: 0, // computed later by topological sort
			retryCount: 0,
			maxRetries: DEFAULT_MAX_RETRIES,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			createdAt: opts.now,
		};
	}

	private _inferAgentName(text: string, index: number): string {
		const d = text.toLowerCase();
		if (/design|设计|ui|界面|ux/.test(d)) { return 'Designer'; }
		if (/test|测试|qa/.test(d)) { return 'QA Tester'; }
		if (/doc|文档|document/.test(d)) { return 'Technical Writer'; }
		if (/review|审核|检查|code.?review/.test(d)) { return 'Reviewer'; }
		if (/deploy|部署|发布|ci.?cd/.test(d)) { return 'DevOps'; }
		if (/database|数据库|db|数据|sql/.test(d)) { return 'Data Engineer'; }
		if (/api|backend|后端|服务端|server/.test(d)) { return 'Backend Developer'; }
		if (/frontend|前端|page|页面|css|html/.test(d)) { return 'Frontend Developer'; }
		if (/arch|架构|设计方案/.test(d)) { return 'Architect'; }
		return `Worker ${index + 1}`;
	}

	private _inferRole(text: string): string {
		const d = text.toLowerCase();
		if (/design|设计/.test(d)) { return 'Designer'; }
		if (/test|测试/.test(d)) { return 'QA Engineer'; }
		if (/doc|文档/.test(d)) { return 'Technical Writer'; }
		if (/review|审核/.test(d)) { return 'Code Reviewer'; }
		if (/deploy|部署/.test(d)) { return 'DevOps Engineer'; }
		if (/arch|架构/.test(d)) { return 'Software Architect'; }
		return 'Software Developer';
	}

	// ═══ Plan CRUD ══════════════════════════════════════════════════════════════

	async createPlan(goal: string, workspaceId: string, plannerId: string): Promise<OrchestrationPlan> {
		this.logService.info(`[Orchestration] Creating plan for goal: "${goal}" in workspace: ${workspaceId}, planner: ${plannerId}`);

		const planner = await this.agentStudioService.getEmployee(plannerId);
		if (!planner) { throw new Error(`Planner agent not found: ${plannerId}`); }
		if (planner.agentType !== AgentType.Planner) {
			throw new Error(`Agent "${planner.name}" is not a planner (type: ${planner.agentType || 'worker'}).`);
		}

		const existingEmployees = await this.agentStudioService.getEmployees(workspaceId);
		const existingNames = new Set(existingEmployees.map(e => e.name.toLowerCase()));
		const pm = existingEmployees.find(e => e.agentType === AgentType.PM);

		const tasks = this._decomposeGoal(goal, existingNames);

		// Validate DAG — topological sort will throw on cycle
		this._topologicalSort(tasks);

		const now = new Date().toISOString();
		const plan: OrchestrationPlan = {
			id: this._generateId('orch_plan'),
			goal,
			summary: this._generateSummary(tasks, pm),
			status: OrchestrationPlanStatus.PendingApproval,
			tasks,
			workspaceId,
			plannerId,
			pmId: pm?.id,
			maxConcurrency: DEFAULT_MAX_CONCURRENCY,
			createdAt: now,
			updatedAt: now,
		};

		const plans = await this._readPlans();
		plans.push(plan);
		await this._writePlans(plans);
		this._onDidChangePlan.fire(plan);
		return plan;
	}

	async approvePlan(planId: string): Promise<OrchestrationPlan> {
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		if (plan.status !== OrchestrationPlanStatus.PendingApproval) {
			throw new Error(`Plan ${planId} is not pending approval (status: ${plan.status})`);
		}

		const employees = await this.agentStudioService.getEmployees(plan.workspaceId);
		const pms = employees.filter(e => e.agentType === AgentType.PM);
		if (pms.length === 0) { throw new Error('此 Workspace 没有 PM。请先创建 PM 才能调度任务。'); }
		if (pms.length > 1) { throw new Error(`此 Workspace 有 ${pms.length} 个 PM，仅允许 1 个。`); }
		if (!plan.pmId) { plan.pmId = pms[0].id; }

		plan.status = OrchestrationPlanStatus.Approved;
		plan.approvedAt = new Date().toISOString();
		plan.updatedAt = plan.approvedAt;
		await this._writePlans(plans);
		this._onDidChangePlan.fire(plan);

		try {
			await this._executePlan(plan);
		} catch (err) {
			this.logService.error('[Orchestration] Plan execution failed:', err);
			plan.status = OrchestrationPlanStatus.Error;
			plan.updatedAt = new Date().toISOString();
			await this._writePlans(plans);
			this._onDidChangePlan.fire(plan);
		}
		return plan;
	}

	async rejectPlan(planId: string): Promise<OrchestrationPlan> {
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		plan.status = OrchestrationPlanStatus.Rejected;
		plan.updatedAt = new Date().toISOString();
		await this._writePlans(plans);
		this._onDidChangePlan.fire(plan);
		return plan;
	}

	async getPlan(planId: string): Promise<OrchestrationPlan | undefined> {
		return (await this._readPlans()).find(p => p.id === planId);
	}

	async listPlans(workspaceId?: string): Promise<OrchestrationPlan[]> {
		const plans = await this._readPlans();
		return workspaceId ? plans.filter(p => p.workspaceId === workspaceId) : plans;
	}

	async taskAction(planId: string, taskId: string, action: OrchestrationTaskAction): Promise<PlanTask> {
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) { throw new Error(`Task not found: ${taskId}`); }

		const now = new Date().toISOString();

		switch (action) {
			case 'retry':
				if (task.status !== PlanTaskStatus.Error && task.status !== PlanTaskStatus.Cancelled) {
					throw new Error(`Cannot retry task in status: ${task.status}`);
				}
				task.status = PlanTaskStatus.Pending;
				task.error = undefined;
				task.startedAt = undefined;
				task.completedAt = undefined;
				task.retryCount = 0;
				break;
			case 'pause':
				if (task.status !== PlanTaskStatus.Running && task.status !== PlanTaskStatus.Pending) {
					throw new Error(`Cannot pause task in status: ${task.status}`);
				}
				task.status = PlanTaskStatus.Paused;
				break;
			case 'resume':
				if (task.status !== PlanTaskStatus.Paused) {
					throw new Error(`Cannot resume task in status: ${task.status}`);
				}
				task.status = PlanTaskStatus.Pending;
				break;
			case 'cancel':
				if (task.status === PlanTaskStatus.Done || task.status === PlanTaskStatus.Cancelled) {
					throw new Error(`Cannot cancel task in status: ${task.status}`);
				}
				task.status = PlanTaskStatus.Cancelled;
				task.completedAt = now;
				break;
		}

		plan.updatedAt = now;

		// After status change, try to promote downstream tasks
		if (action === 'retry' || action === 'resume') {
			const ready = this._getReadyTasks(plan);
			for (const r of ready) {
				r.status = PlanTaskStatus.Running;
				r.startedAt = now;
				this._onDidChangeTask.fire({ planId, task: r });
			}
		}

		this._checkPlanCompletion(plan);
		await this._writePlans(plans);
		await this._syncTaskBoardStatus(task);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	/**
	 * Mark a task as completed (called by agent execution or external callback).
	 * Triggers automatic unblocking of downstream dependent tasks.
	 */
	async completeTask(planId: string, taskId: string, result?: string): Promise<PlanTask> {
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) { throw new Error(`Task not found: ${taskId}`); }
		if (task.status !== PlanTaskStatus.Running) {
			throw new Error(`Cannot complete task in status: ${task.status}`);
		}

		const now = new Date().toISOString();
		task.status = PlanTaskStatus.Done;
		task.result = result;
		task.completedAt = now;
		plan.updatedAt = now;

		// Unblock downstream dependents (core DAG propagation)
		const promoted = this._unblockDependentTasks(plan, task.id);
		for (const p of promoted) {
			this._onDidChangeTask.fire({ planId, task: p });
		}

		this._checkPlanCompletion(plan);
		await this._writePlans(plans);
		await this._syncTaskBoardStatus(task);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	// ═══ Plan Execution ═════════════════════════════════════════════════════════

	private async _executePlan(plan: OrchestrationPlan): Promise<void> {
		this.logService.info(`[Orchestration] Executing plan: ${plan.id}`);

		const plans = await this._readPlans();
		const planRef = plans.find(p => p.id === plan.id);
		if (!planRef) { return; }

		planRef.status = OrchestrationPlanStatus.Executing;
		planRef.updatedAt = new Date().toISOString();
		await this._writePlans(plans);
		this._onDidChangePlan.fire(planRef);

		// ── Step 1: Topological sort to validate + compute depths ──
		try {
			this._topologicalSort(planRef.tasks);
		} catch (err) {
			throw new Error(`DAG validation failed: ${err instanceof Error ? err.message : err}`);
		}

		// ── Step 2: Auto-create agents + intelligent assignment ──
		const existingEmployees = await this.agentStudioService.getEmployees(plan.workspaceId);
		const existingByName = new Map(existingEmployees.map(e => [e.name.toLowerCase(), e]));
		const usedAgentIds = new Set<string>();

		for (const task of planRef.tasks) {
			if (task.autoCreateAgent && task.assigneeName) {
				const existing = existingByName.get(task.assigneeName.toLowerCase());
				if (existing) {
					task.assigneeId = existing.id;
				} else {
					try {
						const newEmp = await this.agentStudioService.createEmployee({
							name: task.assigneeName,
							role: task.assigneeRole || 'Agent',
							workspaceId: plan.workspaceId,
						} as Record<string, unknown>);
						task.assigneeId = newEmp.id;
						existingByName.set(task.assigneeName.toLowerCase(), newEmp);
						this.logService.info(`[Orchestration] Auto-created agent: ${newEmp.name} (${newEmp.id})`);
					} catch (err) {
						this._failTask(planRef, task, `Failed to create agent: ${String(err)}`);
					}
				}
			} else if (!task.assigneeId && task.assigneeRole) {
				// Use agent scoring to find the best match
				const allEmps = [...existingByName.values()];
				const best = this._selectBestAgent(allEmps, task.assigneeRole, usedAgentIds);
				if (best) {
					task.assigneeId = best.id;
					task.assigneeName = best.name;
				}
			}
			if (task.assigneeId) { usedAgentIds.add(task.assigneeId); }
		}

		// ── Step 3: Auto-create connections ──
		const connections = await this.agentStudioService.getConnections(plan.workspaceId);
		const existingConnSet = new Set(connections.map(c => `${c.sourceId}-${c.targetId}`));

		for (const task of planRef.tasks) {
			if (task.dependencies.length > 0 && task.assigneeId) {
				for (const depTaskId of task.dependencies) {
					const depTask = planRef.tasks.find(t => t.id === depTaskId);
					if (depTask?.assigneeId && depTask.assigneeId !== task.assigneeId) {
						const key = `${depTask.assigneeId}-${task.assigneeId}`;
						if (!existingConnSet.has(key)) {
							try {
								await this.agentStudioService.addConnection(plan.workspaceId, {
									sourceId: depTask.assigneeId,
									targetId: task.assigneeId,
									type: 'subagent' as never,
									label: 'orchestration',
								});
								existingConnSet.add(key);
							} catch { /* ignore */ }
						}
					}
				}
			}
		}

		// ── Step 4: Auto-layout canvas ──
		await this._autoArrangeCanvas(planRef);

		// ── Step 5: Create task board items ──
		for (const task of planRef.tasks) {
			if (task.status !== PlanTaskStatus.Error) {
				try {
					await this.taskBoardService.createTask({
						title: task.title,
						description: task.description,
						status: TaskBoardStatus.Todo,
						source: TaskSource.Delegation,
						sourceId: task.id,
						assigneeId: task.assigneeId,
						assigneeName: task.assigneeName,
						workspaceId: plan.workspaceId,
						priority: task.priority <= 1 ? 'high' : task.priority <= 3 ? 'medium' : 'low',
					} as Record<string, unknown>);
				} catch { /* ignore */ }
			}
		}

		// ── Step 6: Start ready tasks (respecting concurrency limit) ──
		const ready = this._getReadyTasks(planRef);
		for (const task of ready) {
			task.status = PlanTaskStatus.Running;
			task.startedAt = new Date().toISOString();
		}

		planRef.updatedAt = new Date().toISOString();
		await this._writePlans(plans);
		this._onDidChangePlan.fire(planRef);
	}

	// ═══ Canvas Auto-Layout ═════════════════════════════════════════════════════

	private async _autoArrangeCanvas(plan: OrchestrationPlan): Promise<void> {
		try {
			const employees = await this.agentStudioService.getEmployees(plan.workspaceId);
			const workspace = await this.agentStudioService.getWorkspace(plan.workspaceId);
			if (!workspace) { return; }

			// Use topological depth for layout
			const depthMap = new Map<string, number>();
			for (const task of plan.tasks) {
				if (task.assigneeId) {
					const current = depthMap.get(task.assigneeId) ?? 0;
					depthMap.set(task.assigneeId, Math.max(current, task.depth));
				}
			}

			const depthGroups = new Map<number, string[]>();
			for (const [agentId, depth] of depthMap) {
				if (!depthGroups.has(depth)) { depthGroups.set(depth, []); }
				depthGroups.get(depth)!.push(agentId);
			}

			const nodes = (workspace.layout?.nodes || []).map(n => ({ ...n }));
			const nodeMap = new Map(nodes.map(n => [n.id, n]));
			const maxRowWidth = Math.max(...[...depthGroups.values()].map(g => g.length), 1);

			for (const [depth, agentIds] of [...depthGroups.entries()].sort(([a], [b]) => a - b)) {
				const rowWidth = agentIds.length * CANVAS_COL_WIDTH;
				const totalWidth = maxRowWidth * CANVAS_COL_WIDTH;
				const startX = CANVAS_ORIGIN_X + (totalWidth - rowWidth) / 2;
				const y = CANVAS_ORIGIN_Y + depth * CANVAS_ROW_HEIGHT;

				agentIds.forEach((agentId, index) => {
					const x = startX + index * CANVAS_COL_WIDTH;
					const existing = nodeMap.get(agentId);
					if (existing) {
						existing.position = { x, y };
					} else {
						const emp = employees.find(e => e.id === agentId);
						nodes.push({ id: agentId, type: 'employee', position: { x, y }, data: emp ? { employee: emp } : {} });
					}
				});
			}

			const conns = await this.agentStudioService.getConnections(plan.workspaceId);
			const edges = conns.map(c => ({ id: c.id, source: c.sourceId, target: c.targetId, type: 'connection', data: { label: c.label } }));

			await this.agentStudioService.updateWorkspaceLayout(plan.workspaceId, { nodes, edges, viewport: workspace.layout?.viewport } as never);
		} catch (err) {
			this.logService.warn('[Orchestration] Auto-arrange failed:', err);
		}
	}

	// ═══ Task Board Sync ════════════════════════════════════════════════════════

	private async _syncTaskBoardStatus(task: PlanTask): Promise<void> {
		try {
			const tasks = await this.taskBoardService.getTasks();
			const boardTask = tasks.find(t => t.sourceId === task.id);
			if (boardTask) {
				const statusMap: Record<string, TaskBoardStatus> = {
					[PlanTaskStatus.Pending]: TaskBoardStatus.Todo,
					[PlanTaskStatus.Running]: TaskBoardStatus.Running,
					[PlanTaskStatus.Paused]: TaskBoardStatus.Todo,
					[PlanTaskStatus.Done]: TaskBoardStatus.Done,
					[PlanTaskStatus.Cancelled]: TaskBoardStatus.Cancelled,
					[PlanTaskStatus.Error]: TaskBoardStatus.Done,
				};
				const newStatus = statusMap[task.status];
				if (newStatus && newStatus !== boardTask.status) {
					await this.taskBoardService.updateTaskStatus(boardTask.id, newStatus);
				}
			}
		} catch { /* ignore */ }
	}

	// ═══ Summary ════════════════════════════════════════════════════════════════

	private _generateSummary(tasks: PlanTask[], pm?: { name: string }): string {
		const agentCount = new Set(tasks.map(t => t.assigneeName)).size;
		const taskCount = tasks.length;
		const autoCreateCount = tasks.filter(t => t.autoCreateAgent).length;

		// Determine execution strategy (Ruflo-style)
		const hasDeps = tasks.some(t => t.dependencies.length > 0);
		const strategy = taskCount === 1 ? 'sequential'
			: !hasDeps && taskCount > 2 ? 'parallel'
				: hasDeps && taskCount > 3 ? 'pipeline'
					: 'hybrid';

		let summary = `计划包含 ${taskCount} 个任务，分配给 ${agentCount} 个 Agent，策略: ${strategy}`;
		if (autoCreateCount > 0) {
			summary += `（${autoCreateCount} 个需自动创建）`;
		}
		summary += pm ? `。PM: ${pm.name}` : `。⚠️ 无 PM`;
		return summary;
	}
}
