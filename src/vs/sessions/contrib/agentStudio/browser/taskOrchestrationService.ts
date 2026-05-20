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
 *
 *  Refactored into sub-modules:
 *  - TaskDecomposer: goal → PlanTask[] decomposition
 *  - AgentFactory: agent scoring, selection, creation, pool reuse
 *  - CanvasLayoutEngine: DAG-depth-based canvas auto-layout
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
import type { OrchestrationPlan, PlanTask } from '../common/types.js';
import { OrchestrationPlanStatus, PlanTaskStatus, TaskBoardStatus, TaskSource, AgentType } from '../common/types.js';
import { AGENT_STUDIO_DATA_PATH_SETTING } from '../common/constants.js';
import { TaskDecomposer } from './taskDecomposer.js';
import { AgentFactory } from './agentFactory.js';
import { CanvasLayoutEngine } from './canvasLayoutEngine.js';

const DATA_FILE_ORCHESTRATION = 'orchestration-plans.json';

// ─── Defaults (aligned with Ruflo) ──────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_MAX_CONCURRENCY = 3;

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

	// ─── Sub-modules ─────────────────────────────────────────────────────────
	private readonly _decomposer: TaskDecomposer;
	private readonly _agentFactory: AgentFactory;
	private readonly _layoutEngine: CanvasLayoutEngine;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
	) {
		super();
		this._decomposer = new TaskDecomposer();
		this._agentFactory = new AgentFactory(agentStudioService, logService);
		this._layoutEngine = new CanvasLayoutEngine(agentStudioService, logService);
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
	 * Kahn-style topological sort. Returns tasks in execution order.
	 * Throws on circular dependency. Within the same topological layer,
	 * tasks are sorted by priority (lower number = higher priority).
	 * Also computes `depth` for each task as a side-effect.
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

		// Delegate decomposition to TaskDecomposer
		const tasks = this._decomposer.decomposeGoal(goal, existingNames);

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

		// ── Step 2: Auto-create agents + intelligent assignment (delegated to AgentFactory) ──
		this._agentFactory.resetPool();
		await this._agentFactory.assignAgents(planRef);

		// ── Step 3: Auto-create connections (delegated to AgentFactory) ──
		await this._agentFactory.wireConnections(planRef);

		// ── Step 4: Auto-layout canvas (delegated to CanvasLayoutEngine) ──
		await this._layoutEngine.autoArrangeCanvas(planRef);

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
