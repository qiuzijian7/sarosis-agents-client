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
import { ITaskOrchestrationService, IAgentStudioService, IAgentTaskBoardService, IAgentChatService } from '../common/agentStudio.js';
import type { OrchestrationTaskAction } from '../common/agentStudio.js';
import type { OrchestrationPlan, PlanTask, Agent, ChatMessage } from '../common/types.js';
import { OrchestrationPlanStatus, PlanTaskStatus, TaskBoardStatus, TaskSource, AgentType } from '../common/types.js';
import { TaskReviewStatus, TaskComment } from '../../../common/agentStudioTypes.js';
import { AGENT_STUDIO_DATA_PATH_SETTING, AGENT_STUDIO_DEFAULT_AGENT_SETTING } from '../common/constants.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { TaskDecomposer } from './taskDecomposer.js';
import { AgentFactory } from './agentFactory.js';
import { CanvasLayoutEngine } from './canvasLayoutEngine.js';
import { IAgentOSService } from '../common/agentOS.js';
import type { IAgentTurnRequest, IChatStreamDelta } from '../common/providers.js';
// ─── New unified imports ──────────────────────────────────────────────────
import { UnifiedSubAgentDispatch } from '../common/unifiedSubAgentDispatch.js';
import { StructuredOutputParser } from './structuredOutputParser.js';
import { RepoOverviewProvider } from './repoOverviewProvider.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IterationBudget } from '../common/iterationBudget.js';

const DATA_FILE_ORCHESTRATION = 'orchestration-plans.json';

// ─── Defaults (aligned with Ruflo) ──────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_SPAWN_DEPTH = 2;

// ═══════════════════════════════════════════════════════════════════════════════

export class TaskOrchestrationService extends Disposable implements ITaskOrchestrationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePlan = this._register(new Emitter<OrchestrationPlan>());
	readonly onDidChangePlan: Event<OrchestrationPlan> = this._onDidChangePlan.event;

	private readonly _onDidChangeTask = this._register(new Emitter<{ planId: string; task: PlanTask }>());
	readonly onDidChangeTask: Event<{ planId: string; task: PlanTask }> = this._onDidChangeTask.event;

	private readonly _onDidFocusTask = this._register(new Emitter<string>());
	readonly onDidFocusTask: Event<string> = this._onDidFocusTask.event;

	/** Timeout check interval handle */
	private _timeoutTimer: ReturnType<typeof setInterval> | undefined;
	/** Serialise file writes to avoid race conditions */
	private _writeLock = false;

	/** Callback to push chat stream events to the webview. Set by AgentStudioWebviewController. */
	private _streamEventCallback: ((eventType: string, payload: Record<string, unknown>) => void) | undefined;

	/**
	 * Tracks agent IDs that are currently executing a task.
	 * Used to determine if an agent is "busy" (has a running task) or "idle"
	 * for the purpose of auto-executing pending tasks.
	 * Key: assigneeId (agent ID), Value: count of running tasks for that agent.
	 */
	private readonly _runningAssignees = new Map<string, number>();

	private _dataUri: URI | undefined;

	/** Helper to fire a decomposition progress event to the webview chat UI. */
	private _fireDecompositionProgress(payload: {
		plannerId?: string;
		plannerName?: string;
		stage: string;
		message: string;
		taskTitle?: string;
		goal?: string;
		subTaskCount?: number;
	}): void {
		if (this._streamEventCallback) {
			this._streamEventCallback('orchestration.decompositionProgress', payload);
		}
	}

	// ─── Sub-modules ─────────────────────────────────────────────────────────
	private readonly _decomposer: TaskDecomposer;
	private readonly _agentFactory: AgentFactory;
	private readonly _layoutEngine: CanvasLayoutEngine;
	/** Unified sub-agent dispatch (replaces previous SubAgentManager + delegate_task) */
	private readonly _subAgentDispatch: UnifiedSubAgentDispatch;
	/** Structured output parser (replaces _parseAiResponseToPlanTasks) */
	private readonly _outputParser: StructuredOutputParser;
	/** Repo overview provider (injects codebase context into AI decomposition) */
	private readonly _repoOverviewProvider: RepoOverviewProvider;
	/** Cached repo overview (invalidated on workspace change) */
	private _cachedRepoOverview: string | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IAgentTaskBoardService private readonly taskBoardService: IAgentTaskBoardService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._decomposer = new TaskDecomposer();
		this._agentFactory = new AgentFactory(agentStudioService, logService);
		this._layoutEngine = new CanvasLayoutEngine(agentStudioService, logService);
		this._subAgentDispatch = new UnifiedSubAgentDispatch(undefined, DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_SPAWN_DEPTH);
		this._outputParser = new StructuredOutputParser(logService);
		this._repoOverviewProvider = new RepoOverviewProvider(fileService, logService);
		this._startTimeoutMonitor();
	}

	override dispose(): void {
		if (this._timeoutTimer) { clearInterval(this._timeoutTimer); }
		super.dispose();
	}

	/**
	 * Focus/highlight a task in the Task Overview board by title.
	 */
	focusTaskInBoard(taskTitle: string): void {
		this._onDidFocusTask.fire(taskTitle);
		this.logService.info(`[TaskOrchestrationService] Focus task in board: ${taskTitle}`);
	}

	// ═══ Data Persistence (with simple write lock) ══════════════════════════════

	private _getDataUri(): URI {
		if (!this._dataUri) {
			const customPath = this.configurationService.getValue<string>(AGENT_STUDIO_DATA_PATH_SETTING);
			if (customPath) {
				this._dataUri = URI.file(customPath);
			} else {
				// 默认：~/.agent-studio/data（跨平台兼容）
				this._dataUri = URI.joinPath((this.environmentService as INativeEnvironmentService).userHome, '.agent-studio', 'data');
			}
		}
		return this._dataUri;
	}

	private async _readPlans(): Promise<OrchestrationPlan[]> {
		try {
			const uri = URI.joinPath(this._getDataUri(), DATA_FILE_ORCHESTRATION);
			const content = await this.fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString()) as OrchestrationPlan[];
			// Defensive: filter out null/undefined/corrupted entries that could crash downstream .id access
			return Array.isArray(parsed) ? parsed.filter(p => p && typeof p === 'object' && p.id) : [];
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

						// Send timeout message to agent's chat box
						if (task.assigneeId) {
							try {
								const chatMessage = {
									id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
									role: 'system' as const,
									content: `⏱️ 任务执行超时: ${task.title}\n\n超时时间: ${Math.round(elapsed / 1000)}s\n任务ID: ${task.id}\n错误: ${task.error}`,
									agentId: task.assigneeId,
									agentSessionId: undefined,
									timestamp: new Date().toISOString(),
								};
								await this.agentChatService.appendMessage(task.assigneeId, chatMessage);
								this.logService.info(`[Orchestration] Sent timeout message to agent ${task.assigneeId} for task ${task.id}`);
							} catch (err) {
								this.logService.warn(`[Orchestration] Failed to send timeout message to agent ${task.assigneeId}:`, err);
							}
						}
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

	// ═══ Auto-Execution (idle agent → pending task) ═════════════════════════════

	/**
	 * Check if an agent is currently busy (executing at least one task).
	 */
	private _isAgentBusy(assigneeId: string): boolean {
		return (this._runningAssignees.get(assigneeId) ?? 0) > 0;
	}

	/**
	 * Mark an agent as having one more running task.
	 */
	private _markAgentBusy(assigneeId: string): void {
		const count = this._runningAssignees.get(assigneeId) ?? 0;
		this._runningAssignees.set(assigneeId, count + 1);
	}

	/**
	 * Mark an agent as having one fewer running task.
	 * When count reaches 0, the agent is considered idle again.
	 */
	private _markAgentIdle(assigneeId: string): void {
		const count = this._runningAssignees.get(assigneeId) ?? 0;
		if (count <= 1) {
			this._runningAssignees.delete(assigneeId);
		} else {
			this._runningAssignees.set(assigneeId, count - 1);
		}
	}

	/**
	 * Scan all executing plans for pending tasks whose assigned agent is idle,
	 * and auto-start them (respecting concurrency limits and DAG dependencies).
	 *
	 * This is called after a task completes (its agent becomes free) and after
	 * plan approval (initial kick-off). It replaces the previous pattern of
	 * only promoting downstream tasks on completion.
	 */
	private async _tryAutoExecutePendingTasks(): Promise<void> {
		try {
			const plans = await this._readPlans();

			for (const plan of plans) {
				if (plan.status !== OrchestrationPlanStatus.Executing) { continue; }

				const running = plan.tasks.filter(t => t.status === PlanTaskStatus.Running).length;
				const maxConc = plan.maxConcurrency || DEFAULT_MAX_CONCURRENCY;
				if (running >= maxConc) { continue; }

				// Find pending tasks that are ready (all deps done) and whose agent is idle
				const readyTasks = plan.tasks
					.filter(t => t.status === PlanTaskStatus.Pending)
					.filter(t => t.dependencies.every(depId => {
						const dep = plan.tasks.find(d => d.id === depId);
						return dep && dep.status === PlanTaskStatus.Done;
					}))
					.filter(t => t.assigneeId && !this._isAgentBusy(t.assigneeId))
					.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2));

				let slotsAvailable = maxConc - running;

				for (const task of readyTasks) {
					if (slotsAvailable <= 0) { break; }

					task.status = PlanTaskStatus.Running;
					task.startedAt = new Date().toISOString();
					// Note: _markAgentBusy is called inside _executeTask, so we don't
					// call it here to avoid double-counting.
					slotsAvailable--;

					this._onDidChangeTask.fire({ planId: plan.id, task });
					this.logService.info(`[Orchestration] Auto-executing pending task "${task.title}" (${task.id}) with idle agent ${task.assigneeId}`);

					// Notify chat about auto-execution
					if (task.assigneeId) {
						try {
							const chatMessage = {
								id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
								role: 'system' as const,
								content: `🚀 自动执行: ${task.title}\n\nAgent空闲，自动启动待执行任务`,
							agentId: task.assigneeId,
							agentSessionId: undefined,
								timestamp: new Date().toISOString(),
							};
							await this.agentChatService.appendMessage(task.assigneeId, chatMessage);
						} catch { /* ignore */ }
					}

					// Fire-and-forget: execute the task
					this._executeTask(plan.id, task).catch(err => {
						this.logService.error(`[Orchestration] Auto-executed task ${task.id} failed:`, err);
					});
				}

				if (readyTasks.length > 0) {
					plan.updatedAt = new Date().toISOString();
				}
			}

			// Persist any status changes
			await this._writePlans(plans);
			for (const plan of plans) {
				if (plan.status === OrchestrationPlanStatus.Executing) {
					this._onDidChangePlan.fire(plan);
				}
			}
		} catch (err) {
			this.logService.warn('[Orchestration] _tryAutoExecutePendingTasks error:', err);
		}
	}

	// ═══ Plan CRUD ══════════════════════════════════════════════════════════════

	/**
	 * Set the callback used to push chat stream events (chat.stream.start/delta/complete)
	 * to the webview. Called by AgentStudioWebviewController after construction.
	 */
	setStreamEventCallback(cb: (eventType: string, payload: Record<string, unknown>) => void): void {
		this._streamEventCallback = cb;
	}

	// ═══ Plan Editing (pending approval only) ═══════════════════════════════════

	/**
	 * Update a plan's editable fields. Only allowed when plan is pending approval.
	 */
	async updatePlan(
		planId: string,
		updates: {
			goal?: string;
			summary?: string;
		},
	): Promise<OrchestrationPlan> {
		this.logService.info(`[Orchestration] updatePlan: planId=${planId}`);

		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		if (plan.status !== OrchestrationPlanStatus.PendingApproval) {
			throw new Error(`Cannot edit plan: plan is ${plan.status}`);
		}

		if (updates.goal !== undefined) { plan.goal = updates.goal; }
		if (updates.summary !== undefined) { plan.summary = updates.summary; }

		plan.updatedAt = new Date().toISOString();
		await this._writePlans(plans);
		this._onDidChangePlan.fire(plan);
		return plan;
	}

	// ═══ Task Editing (pending approval only) ═══════════════════════════════════

	/**
	 * Update a task's editable fields. Only allowed when plan is pending approval.
	 */
	async updateTask(
		planId: string,
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			assigneeId?: string;
			assigneeName?: string;
			assigneeRole?: string;
			dependencies?: string[];
			priority?: number;
		},
	): Promise<PlanTask> {
		this.logService.info(`[Orchestration] updateTask: planId=${planId}, taskId=${taskId}`);

		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		if (plan.status !== OrchestrationPlanStatus.PendingApproval) {
			throw new Error(`Cannot edit tasks: plan is ${plan.status}`);
		}

		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) { throw new Error(`Task not found: ${taskId}`); }

		// Validate dependencies
		if (updates.dependencies !== undefined) {
			if (updates.dependencies.includes(taskId)) {
				throw new Error(`Task cannot depend on itself`);
			}
			const invalidDeps = updates.dependencies.filter(depId => !plan.tasks.some(t => t.id === depId));
			if (invalidDeps.length > 0) {
				throw new Error(`Invalid dependencies: ${invalidDeps.join(', ')}`);
			}
			const testTask = { ...task, dependencies: updates.dependencies };
			const testTasks = plan.tasks.map(t => t.id === taskId ? testTask : t);
			try {
				this._topologicalSort(testTasks);
			} catch {
				throw new Error(`Dependency change would create a cycle`);
			}
		}

		if (updates.title !== undefined) { task.title = updates.title; }
		if (updates.description !== undefined) { task.description = updates.description; }
		if (updates.assigneeId !== undefined) { task.assigneeId = updates.assigneeId; }
		if (updates.assigneeName !== undefined) { task.assigneeName = updates.assigneeName; }
		if (updates.assigneeRole !== undefined) { task.assigneeRole = updates.assigneeRole; }
		if (updates.dependencies !== undefined) { task.dependencies = updates.dependencies; }
		if (updates.priority !== undefined) { task.priority = updates.priority; }

		this._topologicalSort(plan.tasks);
		plan.updatedAt = new Date().toISOString();
		plan.summary = this._generateSummary(plan.tasks);

		await this._writePlans(plans);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	/**
	 * Use AI to decompose a single task into sub-tasks.
	 * Only allowed when plan is pending approval.
	 */
	async decomposeTask(
		planId: string,
		taskId: string,
		workspaceId: string,
		plannerId: string,
	): Promise<OrchestrationPlan> {
		this.logService.info(`[Orchestration] decomposeTask: planId=${planId}, taskId=${taskId}`);

		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		if (plan.status !== OrchestrationPlanStatus.PendingApproval) {
			throw new Error(`Cannot decompose tasks: plan is ${plan.status}`);
		}

		const originalTask = plan.tasks.find(t => t.id === taskId);
		if (!originalTask) { throw new Error(`Task not found: ${taskId}`); }

		const agents = await this.agentStudioService.getAgents();
		const agentNameToId = new Map<string, string>();
		agents.forEach(e => {
			if (e.name && e.id) {
				agentNameToId.set(e.name.toLowerCase(), e.id);
			}
		});

		const subTasks = await this._decomposeSingleTaskWithAI(originalTask, workspaceId, agents, plannerId);

		const originalIndex = plan.tasks.findIndex(t => t.id === taskId);
		const lastSubTaskId = subTasks[subTasks.length - 1]?.id;

		// Remove original task
		plan.tasks.splice(originalIndex, 1);

		// Update dependencies that pointed to original task
		for (const t of plan.tasks) {
			if (t.dependencies.includes(taskId) && lastSubTaskId) {
				t.dependencies = t.dependencies.map(depId => depId === taskId ? lastSubTaskId : depId);
			}
		}

		// Add sub-tasks with chained dependencies
		for (let i = 0; i < subTasks.length; i++) {
			const subTask = subTasks[i];
			if (i > 0) {
				subTask.dependencies = [...originalTask.dependencies, subTasks[i - 1].id];
			} else {
				subTask.dependencies = [...originalTask.dependencies];
			}
			subTask.dependencies = subTask.dependencies.filter(depId => depId !== subTask.id);
			plan.tasks.push(subTask);
		}

		this._topologicalSort(plan.tasks);
		plan.updatedAt = new Date().toISOString();
		plan.summary = this._generateSummary(plan.tasks);

		await this._writePlans(plans);
		this._onDidChangePlan.fire(plan);
		return plan;
	}

	/**
	 * Decompose a single task into sub-tasks using AI.
	 * Uses the planner agent's preset (customPrompt, skills, model) for better decomposition.
	 */
	private async _decomposeSingleTaskWithAI(
		task: PlanTask,
		workspaceId: string,
		agents: Agent[],
		plannerId?: string,
	): Promise<PlanTask[]> {
		this.logService.info(`[Orchestration] Decomposing task "${task.title}" with AI (plannerId=${plannerId || 'default'})`);

		// Resolve planner agent for its preset configuration
		let plannerAgent: Agent | undefined;
		let agentId: string;
		if (plannerId) {
			plannerAgent = await this.agentStudioService.getAgent(plannerId);
			if (plannerAgent) {
				agentId = plannerAgent.id;
				this.logService.info(`[Orchestration] Using planner agent "${plannerAgent.name}" (${plannerAgent.id}) for decomposition`);
			} else {
				this.logService.warn(`[Orchestration] Planner agent ${plannerId} not found, falling back to default`);
				agentId = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_AGENT_SETTING) || 'default';
			}
		} else {
			agentId = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_AGENT_SETTING) || 'default';
		}

		// Fire progress: starting decomposition
		this._fireDecompositionProgress({
			plannerId: plannerId || agentId,
			plannerName: plannerAgent?.name,
			stage: 'start',
			message: plannerAgent
				? `🔄 正在使用 ${plannerAgent.name} 分析并拆解任务「${task.title}」...`
				: `🔄 正在分析并拆解任务「${task.title}」...`,
			taskTitle: task.title,
		});

		const agentContext = agents.length > 0
			? `Available team members:\n${agents.map(e => `- ${e.name} (${e.agentType || 'worker'}, id: ${e.id})`).join('\n')}`
			: 'No team members available.';

		// Build system prompt: prepend planner's systemPrompt if available
		const plannerContext = plannerAgent?.systemPrompt
			? `\n\n--- Planner Agent Context ---\n${plannerAgent.systemPrompt}\n--- End Planner Context ---\n\n`
			: '';

		const systemPrompt = `${plannerContext}You are a task decomposition expert. Your ONLY job is to output valid JSON.

CRITICAL: YOUR ENTIRE RESPONSE MUST BE A VALID JSON OBJECT. NOTHING ELSE.

FORBIDDEN:
- NO conversational text
- NO markdown code blocks
- NO explanations before or after JSON
- NO nested structures

REQUIRED OUTPUT FORMAT:
{"tasks":[{"id":"T1","title":"Sub-task title","description":"Description","suggestedRole":"Role","suggestedAssignee":"Name or empty","dependencies":[],"priority":1}]}

FIELD NAMES (case-sensitive):
- "id", "title", "description", "suggestedRole", "suggestedAssignee", "dependencies", "priority"

${agentContext}

OUTPUT ONLY JSON. START WITH { AND END WITH }.`;

		const userMessage = `Decompose the following task into smaller, executable sub-tasks. Output ONLY valid JSON.

PARENT TASK: ${task.title}
DESCRIPTION: ${task.description || task.title}

REQUIRED OUTPUT FORMAT:
{"tasks": [{"id": "T1", "title": "Sub-task title", "description": "Description", "suggestedRole": "Developer", "suggestedAssignee": "", "dependencies": [], "priority": 1}]}

RULES:
- Start response with { and end with }
- NO text before/after JSON
- NO markdown code blocks
- Create 2-5 sub-tasks that are smaller and more specific
- Each sub-task should be independently executable
- Use suggestedAssignee field with existing team member names when appropriate`;

		const agentNameToId = new Map<string, string>();
		agents.forEach(e => {
			if (e.name && e.id) {
				agentNameToId.set(e.name.toLowerCase(), e.id);
			}
		});

		// Fire progress: calling AI model
		this._fireDecompositionProgress({
			plannerId: plannerId || agentId,
			plannerName: plannerAgent?.name,
			stage: 'calling_ai',
			message: plannerAgent
				? `🤖 ${plannerAgent.name} 正在思考如何拆解任务「${task.title}」...`
				: `🤖 AI 正在思考如何拆解任务「${task.title}」...`,
			taskTitle: task.title,
		});

		const request: IAgentTurnRequest = {
			agentId,
			sessionId: workspaceId,
			messages: [{ role: 'user', content: userMessage }],
			systemPrompt,
			explicitSkillIds: plannerAgent?.skills?.filter((s): s is string => typeof s === 'string') || [],
		};

		const stream = this.agentOSService.executeAgentTurn(request);
		let responseText = '';
		for await (const delta of stream) {
			if (delta.type === 'text' && delta.content) {
				responseText += delta.content;
			}
		}

		// Fire progress: parsing results
		this._fireDecompositionProgress({
			plannerId: plannerId || agentId,
			plannerName: plannerAgent?.name,
			stage: 'parsing',
			message: `📋 正在解析 AI 拆解结果...`,
			taskTitle: task.title,
		});

		const subTasks = this._convertParsedTasksToPlanTasks(
			this._outputParser.parseTaskDecomposition(responseText).tasks,
			agentNameToId,
		);

		// Fire progress: decomposition complete
		this._fireDecompositionProgress({
			plannerId: plannerId || agentId,
			plannerName: plannerAgent?.name,
			stage: 'complete',
			message: plannerAgent
				? `✅ ${plannerAgent.name} 已将任务「${task.title}」拆解为 ${subTasks.length} 个子任务`
				: `✅ 已将任务「${task.title}」拆解为 ${subTasks.length} 个子任务`,
			taskTitle: task.title,
			subTaskCount: subTasks.length,
		});

		return subTasks;
	}

	async createPlan(goal: string, workspaceId: string, plannerId: string): Promise<OrchestrationPlan> {
		this.logService.info(`[Orchestration] Creating plan for goal: "${goal}" in workspace: ${workspaceId}, planner: ${plannerId}`);

		const planner = await this.agentStudioService.getAgent(plannerId);
		if (!planner) { throw new Error(`Planner agent not found: ${plannerId}`); }
		const isPlanner = planner.agentType === AgentType.Planner
			|| (planner as any).presetId === 'planner'
			|| (planner as any).role?.toLowerCase().includes('planner')
			|| planner.name?.toLowerCase() === 'planner';
		if (!isPlanner) {
			throw new Error(`Agent "${planner.name}" is not a planner (type: ${planner.agentType || 'worker'}).`);
		}

		// Agents are global definitions; all are candidates for decomposition
		// (per-workspace runtime binding is resolved later at dispatch time).
		const existingAgents = await this.agentStudioService.getAgents();

		// Use AI-based decomposition
		this.logService.info(`[Orchestration] Using AI-based decomposition for goal: "${goal}"`);
		const tasks = await this._decomposeGoalWithAI(goal, workspaceId, existingAgents, plannerId);

		// Validate DAG — topological sort will throw on cycle
		this._topologicalSort(tasks);

		const now = new Date().toISOString();
		const plan: OrchestrationPlan = {
			id: this._generateId('orch_plan'),
			goal,
			summary: this._generateSummary(tasks),
			status: OrchestrationPlanStatus.PendingApproval,
			tasks,
			workspaceId,
			plannerId,
			maxConcurrency: DEFAULT_MAX_CONCURRENCY,
			createdAt: now,
			updatedAt: now,
		};

		const plans = await this._readPlans();
		plans.push(plan);
		await this._writePlans(plans);
		this._onDidChangePlan.fire(plan);

		// Persist plan message to planner's chat history so it survives page reloads
		try {
			const planMessage: ChatMessage = {
				id: `plan_${plan.id}`,
				role: 'system',
				content: `✅ 任务计划已创建，请在下方面板中审批：`,
			agentId: plannerId,
				metadata: { type: 'orchestration_plan', planId: plan.id },
				timestamp: now,
			};
			await this.agentChatService.appendMessage(plannerId, planMessage);
		} catch (err) {
			this.logService.warn('[Orchestration] Failed to persist plan message to chat history:', err);
		}

		return plan;
	}

	// ─── AI-based Goal Decomposition ─────────────────────────────────────

	/**
	 * Decompose a goal into PlanTasks using AI.
	 * This replaces the rule-based TaskDecomposer.decomposeGoal() with AI-powered decomposition.
	 *
	 * Improvements over previous implementation:
	 * 1. Injects codebase context (repo_overview) so AI understands the project
	 * 2. Uses StructuredOutputParser instead of fragile hand-written JSON extraction
	 * 3. Supports parallel explore sub-agents (inspired by OpenCode Phase 1)
	 */
	private async _decomposeGoalWithAI(goal: string, workspaceId: string, agents: Agent[], plannerId?: string): Promise<PlanTask[]> {
		this.logService.info(`[Orchestration] Starting AI-based goal decomposition for: "${goal}" (plannerId=${plannerId || 'default'})`);

		// Fire progress: starting goal decomposition
		let plannerName: string | undefined;
		if (plannerId) {
			const planner = await this.agentStudioService.getAgent(plannerId);
			plannerName = planner?.name;
		}
		this._fireDecompositionProgress({
			plannerId,
			plannerName,
			stage: 'start',
			message: plannerName
				? `🔄 正在使用 ${plannerName} 分析目标并拆解任务...`
				: `🔄 正在分析目标并拆解任务...`,
			goal,
		});

		try {
			// Step 0: Inject codebase context (repo_overview)
			let repoContext: string | undefined;
			try {
				repoContext = await this._getRepoOverview();
				if (repoContext) {
					this.logService.info(`[Orchestration] Injected repo overview context (${repoContext.length} chars)`);
				}
			} catch (err) {
				this.logService.warn(`[Orchestration] Failed to get repo overview, continuing without: ${err}`);
			}

			// Step 1: Call AI model (with codebase context)
			this.logService.info(`[Orchestration] Calling AI model for task decomposition`);
			const aiResponse = await this._callAIModelForDecomposition(goal, workspaceId, agents, plannerId, repoContext);
			this.logService.info(`[Orchestration] AI response received, length=${aiResponse.length}`);

			// Step 2: Parse AI response into PlanTask[] using StructuredOutputParser
			this.logService.info(`[Orchestration] Parsing AI response with StructuredOutputParser`);
			const { tasks: parsedTasks, errors } = this._outputParser.parseTaskDecomposition(aiResponse);

			if (errors.length > 0) {
				this.logService.warn(`[Orchestration] StructuredOutputParser reported ${errors.length} validation errors:`);
				for (const err of errors.slice(0, 5)) {
					this.logService.warn(`  - ${err.path}: ${err.message}`);
				}
			}

			if (parsedTasks.length === 0) {
				throw new Error('StructuredOutputParser returned 0 tasks');
			}

			this.logService.info(`[Orchestration] Parsed ${parsedTasks.length} tasks from AI response`);

			// Step 3: Convert parsed tasks to PlanTask[]
			const agentNameToId = new Map<string, string>();
			agents.forEach(e => {
				if (e.name && e.id) {
					agentNameToId.set(e.name.toLowerCase(), e.id);
				}
			});

			const tasks = this._convertParsedTasksToPlanTasks(parsedTasks, agentNameToId);
			this.logService.info(`[Orchestration] Converted ${tasks.length} tasks to PlanTask[]`);

			// Fire progress: decomposition complete
			this._fireDecompositionProgress({
				plannerId,
				plannerName,
				stage: 'complete',
				message: plannerName
					? `✅ ${plannerName} 已将目标拆解为 ${tasks.length} 个任务`
					: `✅ 已将目标拆解为 ${tasks.length} 个任务`,
				goal,
				subTaskCount: tasks.length,
			});

			return tasks;
		} catch (error) {
			this.logService.error(`[Orchestration] AI decomposition failed: ${error instanceof Error ? error.message : String(error)}`);

			// Fire progress: falling back to rule-based decomposition (neutral message)
			this._fireDecompositionProgress({
				plannerId,
				plannerName,
				stage: 'fallback',
				message: `🔄 正在使用规则引擎进行任务拆解...`,
				goal,
			});

			this.logService.info(`[Orchestration] Falling back to rule-based decomposition`);
			// Fallback to rule-based decomposition
			const existingNames = new Set(agents.map(e => e.name.toLowerCase()));
			return this._decomposer.decomposeGoal(goal, existingNames);
		}
	}

	/**
	 * Call AI model to decompose goal into tasks.
	 * Uses the planner agent's preset (customPrompt, skills, model) for better decomposition.
	 * Returns the raw AI response string.
	 *
	 * Improvement: now accepts optional repoContext for codebase-aware decomposition.
	 */
	private async _callAIModelForDecomposition(goal: string, workspaceId: string, agents: Agent[], plannerId?: string, repoContext?: string): Promise<string> {
		this.logService.info(`[Orchestration] _callAIModelForDecomposition: goal="${goal}", plannerId=${plannerId || 'default'}`);

		// Resolve planner agent for its preset configuration
		let plannerAgent: Agent | undefined;
		let agentId: string;
		if (plannerId) {
			plannerAgent = await this.agentStudioService.getAgent(plannerId);
			if (plannerAgent) {
				agentId = plannerAgent.id;
				this.logService.info(`[Orchestration] Using planner agent "${plannerAgent.name}" (${plannerAgent.id}) for goal decomposition`);
			} else {
				this.logService.warn(`[Orchestration] Planner agent ${plannerId} not found, falling back to default`);
				agentId = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_AGENT_SETTING) || 'default';
			}
		} else {
			agentId = this.configurationService.getValue<string>(AGENT_STUDIO_DEFAULT_AGENT_SETTING) || 'default';
		}

		// Fire progress: calling AI model
		this._fireDecompositionProgress({
			plannerId: plannerId || agentId,
			plannerName: plannerAgent?.name,
			stage: 'calling_ai',
			message: plannerAgent
				? `🤖 ${plannerAgent.name} 正在分析目标并生成任务拆解方案...`
				: `🤖 AI 正在分析目标并生成任务拆解方案...`,
			goal,
		});

		// Build agent context string
		const agentContext = agents.length > 0
			? `Available team members:\n${agents.map(e => `- ${e.name} (${e.agentType || 'worker'}, id: ${e.id})`).join('\n')}`
			: 'No team members available.';

		// Build system prompt: prepend planner's systemPrompt if available
		const plannerContext = plannerAgent?.systemPrompt
			? `\n\n--- Planner Agent Context ---\n${plannerAgent.systemPrompt}\n--- End Planner Context ---\n\n`
			: '';

		// Build system prompt - EXTREMELY STRICT JSON OUTPUT REQUIRED
		// Improvement: inject codebase context so decomposition is project-aware
		const repoContextSection = repoContext
			? `\n\n--- CODEBASE CONTEXT ---\n${repoContext}\n--- END CODEBASE CONTEXT ---\n\nUse the codebase context above to make informed decisions about task decomposition. For example:\n- If the project is a frontend-only app, don't create backend tasks\n- If the project uses a specific framework, suggest tasks aligned with that framework\n- Match suggested roles to the actual tech stack\n`
			: '';

		const systemPrompt = `${plannerContext}${repoContextSection}You are a task decomposition expert. Your ONLY job is to output valid JSON.

CRITICAL: YOUR ENTIRE RESPONSE MUST BE A VALID JSON OBJECT. NOTHING ELSE.

FORBIDDEN:
- NO conversational text (no "I'll help", no "Here is", no asking for clarification)
- NO markdown code blocks (no \`\`\`)
- NO explanations before or after JSON
- NO "goal" or "description" fields at root level
- NO wrapping tasks in "phases" or any nested structure

MANDATORY: Even if the goal is vague, simple, or unclear (e.g., a single word like "test16"), you MUST still output a valid JSON task list. Do NOT ask for clarification. Do NOT explain why the goal is unclear. Always return tasks.

REQUIRED OUTPUT FORMAT - EXACTLY THIS STRUCTURE:
{"tasks":[{"id":"T1","title":"Task title","description":"Task description","suggestedRole":"Role","suggestedAssignee":"Name or empty","dependencies":[],"priority":1}]}

FIELD NAMES - USE EXACTLY THESE (case-sensitive):
- "id" (not "task_id")
- "title" (not "task_name" or "name")
- "description" (not "task_description")
- "suggestedRole" (not "role" or "required_role")
- "suggestedAssignee" (not "assignee" or "owner")
- "dependencies" (not "depends_on")
- "priority" (not "priority_level")

AVAILABLE TEAM MEMBERS:
${agentContext}

EXAMPLE CONVERSATION:
User: Goal: Build a login page
You: {"tasks":[{"id":"T1","title":"Design login UI","description":"Create mockup","suggestedRole":"Designer","suggestedAssignee":"","dependencies":[],"priority":1},{"id":"T2","title":"Implement login backend","description":"API endpoint","suggestedRole":"Developer","suggestedAssignee":"","dependencies":[],"priority":1}]}

REMEMBER: OUTPUT ONLY JSON. NO OTHER TEXT. START WITH { AND END WITH }.`;

		const userMessage = `Decompose the following goal into executable tasks. Output ONLY a valid JSON object.

REQUIRED OUTPUT FORMAT (copy exactly):
{"tasks": [{"id": "T1", "title": "Task title", "description": "Description", "suggestedRole": "Developer", "suggestedAssignee": "", "dependencies": [], "priority": 1}]}

CRITICAL RULES:
- Start response with { and end with }
- NO text before/after JSON
- NO markdown code blocks
- Field names: id, title, description, suggestedRole, suggestedAssignee, dependencies, priority
- Use suggestedAssignee field with existing team member names when appropriate

Goal: ${goal}`;

		this.logService.info(`[Orchestration] Request: agentId=${agentId}, systemPrompt length=${systemPrompt.length}, userMessage length=${userMessage.length}`);
		this.logService.info(`[Orchestration] Calling AgentOS.executeAgentTurn with agentId=${agentId}`);

		const request: IAgentTurnRequest = {
			agentId,
			sessionId: workspaceId,
			messages: [
				{ role: 'user', content: userMessage }
			],
			systemPrompt,
			explicitSkillIds: plannerAgent?.skills?.filter((s): s is string => typeof s === 'string') || [],
		};

		const stream = this.agentOSService.executeAgentTurn(request);
		let responseText = '';
		let textDeltaCount = 0;
		const deltaTypes = new Set<string>();

		for await (const delta of stream) {
			deltaTypes.add(delta.type);
			if (delta.type === 'text' && delta.content) {
				responseText += delta.content;
				textDeltaCount++;
			} else if (delta.type === 'error') {
				this.logService.error(`[Orchestration] Received error delta: ${delta.content}`);
			}
		}

		this.logService.info(`[Orchestration] Stream complete. Delta types: [${Array.from(deltaTypes).join(', ')}], text deltas: ${textDeltaCount}, total length: ${responseText.length}`);
		this.logService.info(`[Orchestration] Response preview: ${responseText.substring(0, 300)}`);

		return responseText;
	}

	/**
	 * Convert parsed tasks from StructuredOutputParser into PlanTask[].
	 * This replaces the old _parseAiResponseToPlanTasks method.
	 */
	private _convertParsedTasksToPlanTasks(
		parsedTasks: Array<{
			id: string;
			title: string;
			description: string;
			suggestedRole: string;
			suggestedAssignee: string;
			dependencies: string[];
			priority: number;
		}>,
		agentNameToId: Map<string, string>,
	): PlanTask[] {
		const now = new Date().toISOString();
		const tasks: PlanTask[] = [];
		const taskIdMap = new Map<string, string>(); // AI task ID → PlanTask ID

		for (const taskData of parsedTasks) {
			const taskId = this._generateId('orch_task_ai');
			taskIdMap.set(taskData.id, taskId);

			// Resolve assignee
			let assigneeId = '';
			if (taskData.suggestedAssignee) {
				const resolvedId = agentNameToId.get(taskData.suggestedAssignee.toLowerCase());
				if (resolvedId) {
					assigneeId = resolvedId;
				}
			}

			const task: PlanTask = {
				id: taskId,
				title: taskData.title,
				description: taskData.description,
				status: PlanTaskStatus.Pending,
				dependencies: [], // Will be resolved after all tasks are created
				assigneeId,
				assigneeName: taskData.suggestedAssignee || undefined,
				assigneeRole: taskData.suggestedRole,
				autoCreateAgent: !taskData.suggestedAssignee,
				priority: taskData.priority,
				depth: 0,
				retryCount: 0,
				maxRetries: DEFAULT_MAX_RETRIES,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				createdAt: now,
			};

			tasks.push(task);
		}

		// Resolve dependencies (map AI task IDs → PlanTask IDs)
		for (let i = 0; i < parsedTasks.length; i++) {
			const taskData = parsedTasks[i];
			const task = tasks[i];
			if (taskData.dependencies && Array.isArray(taskData.dependencies)) {
				for (const depId of taskData.dependencies) {
					const resolvedDepId = taskIdMap.get(depId);
					if (resolvedDepId) {
						task.dependencies.push(resolvedDepId);
					}
				}
			}
		}

		return tasks;
	}

	/**
	 * Get a cached repo overview for the current workspace.
	 * The overview is generated once and cached until invalidated.
	 */
	private async _getRepoOverview(): Promise<string | undefined> {
		if (this._cachedRepoOverview) {
			return this._cachedRepoOverview;
		}

		try {
			const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
			if (workspaceFolders.length === 0) {
				return undefined;
			}

			const rootUri = workspaceFolders[0].uri;
			const overview = await this._repoOverviewProvider.getOverview(rootUri, 2);
			this._cachedRepoOverview = overview.summary;
			return this._cachedRepoOverview;
		} catch (err) {
			this.logService.warn(`[Orchestration] Failed to get repo overview: ${err}`);
			return undefined;
		}
	}

	/**
	 * Invalidate the cached repo overview (call when workspace changes).
	 */
	invalidateRepoOverview(): void {
		this._cachedRepoOverview = undefined;
	}

	/**
	 * Access the unified sub-agent dispatch for direct sub-agent operations.
	 * Used by delegate_task tool implementation.
	 */
	get subAgentDispatch(): UnifiedSubAgentDispatch {
		return this._subAgentDispatch;
	}

	async approvePlan(planId: string): Promise<OrchestrationPlan> {
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		if (plan.status !== OrchestrationPlanStatus.PendingApproval) {
			throw new Error(`Plan ${planId} is not pending approval (status: ${plan.status})`);
		}

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

	/**
	 * Approve a plan without executing it.
	 * Tasks are created in the task board but not auto-started.
	 */
	async approveWithoutExecute(planId: string): Promise<OrchestrationPlan> {
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		if (plan.status !== OrchestrationPlanStatus.PendingApproval) {
			throw new Error(`Plan ${planId} is not pending approval (status: ${plan.status})`);
		}

		plan.status = OrchestrationPlanStatus.Approved;
		plan.approvedAt = new Date().toISOString();
		plan.updatedAt = plan.approvedAt;
		await this._writePlans(plans);
		this._onDidChangePlan.fire(plan);

		// Create tasks in task board but do NOT start execution
		try {
			await this._createTasksFromPlan(plan);
			this.logService.info(`[Orchestration] Plan ${planId} approved without execution. Tasks created, ready to start manually.`);
		} catch (err) {
			this.logService.error('[Orchestration] Failed to create tasks from plan:', err);
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

		// Persist rejection message to planner's chat history so it survives page reloads
		try {
			const rejectMessage: ChatMessage = {
				id: `reject_${plan.id}_${Date.now()}`,
				role: 'system',
				content: `❌ 任务计划「${plan.goal}」已被拒绝。您可以重新发送 /plan 命令来创建新的计划。`,
			agentId: plan.plannerId,
				timestamp: plan.updatedAt,
			};
			await this.agentChatService.appendMessage(plan.plannerId, rejectMessage);
		} catch (err) {
			this.logService.warn('[Orchestration] Failed to persist rejection message to chat history:', err);
		}

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
			// ─── Human-in-the-Loop Actions ─────────────────────────────
			case 'approve':
				if (task.status !== PlanTaskStatus.Done || task.reviewStatus !== TaskReviewStatus.Pending) {
					throw new Error(`Cannot approve task in status: ${task.status}, reviewStatus: ${task.reviewStatus}`);
				}
				task.reviewStatus = TaskReviewStatus.Approved;
				task.reviewedBy = 'user'; // TODO: get actual user info
				task.reviewedAt = now;
				break;
			case 'reject':
				if (task.status !== PlanTaskStatus.Done || task.reviewStatus !== TaskReviewStatus.Pending) {
					throw new Error(`Cannot reject task in status: ${task.status}, reviewStatus: ${task.reviewStatus}`);
				}
				task.reviewStatus = TaskReviewStatus.Rejected;
				task.reviewedBy = 'user'; // TODO: get actual user info
				task.reviewedAt = now;
				// Reject means task needs to be redone
				task.status = PlanTaskStatus.Pending;
				task.result = undefined;
				task.completedAt = undefined;
				break;
			case 'comment':
				// Comment is handled separately in commentTask method
				throw new Error(`Use commentTask method to add comments`);
			case 'block':
				if (task.isBlocked) {
					throw new Error(`Task is already blocked`);
				}
				task.isBlocked = true;
				task.blockedBy = 'user'; // TODO: get actual user info
				task.blockedAt = now;
				break;
			case 'unblock':
				if (!task.isBlocked) {
					throw new Error(`Task is not blocked`);
				}
				task.isBlocked = false;
				task.blockedReason = undefined;
				break;
		}

		plan.updatedAt = now;

		// After status change, try to promote downstream tasks
		if (action === 'retry' || action === 'resume') {
			const ready = this._getReadyTasks(plan);
			for (const r of ready) {
				// If the assigned agent is busy, keep as Pending for auto-execution later
				if (r.assigneeId && this._isAgentBusy(r.assigneeId)) {
					this.logService.info(`[Orchestration] Ready task "${r.title}" (${r.id}) kept as Pending — agent ${r.assigneeId} is busy`);
					this._onDidChangeTask.fire({ planId, task: r });
					continue;
				}
				r.status = PlanTaskStatus.Running;
				r.startedAt = now;
				this._onDidChangeTask.fire({ planId, task: r });
				// Fire-and-forget: execute the ready task
				if (r.assigneeId) {
					this._executeTask(planId, r).catch(err => {
						this.logService.error(`[Orchestration] Ready task ${r.id} execution failed:`, err);
					});
				}
			}
		}

		this._checkPlanCompletion(plan);
		await this._writePlans(plans);
		await this._syncTaskBoardStatus(task);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	// ═══ Workflow Execution ═════════════════════════════════════════════════════

	/**
	 * Execute a workflow starting from the given agent.
	 *
	 * Algorithm:
	 * 1. Find the agent and its workspace connections
	 * 2. Build the downstream dependency graph from 'subagent' connections
	 * 3. Create a transient OrchestrationPlan with tasks for each agent in the chain
	 * 4. Execute the starting agent with the user's message
	 * 5. Upon completion, auto-drive downstream agents using the existing DAG engine
	 * 6. Create task board items for each step
	 *
	 * Returns the transient plan ID.
	 */
	async executeWorkflow(
		agentId: string,
		message: string,
		workspaceId: string,
		options?: { agentSessionId?: string },
	): Promise<string> {
		this.logService.info(`[Orchestration] executeWorkflow: agentId=${agentId}, workspaceId=${workspaceId}`);

		// ── Step 1: Get the starting agent ──
		const startAgent = await this.agentStudioService.getAgent(agentId);
		if (!startAgent) {
			throw new Error(`Agent not found: ${agentId}`);
		}

		// ── Step 2: Get workspace connections and build downstream graph ──
		const connections = await this.agentStudioService.getConnections(workspaceId);

		// Only follow 'subagent' connections where this agent is the source (or
		// a downstream agent is the source).  We build a full descendant tree.
		const subagentConns = connections.filter(c => c.type === 'subagent');

		// BFS to find all downstream agents from the start agent
		const agentChain = await this._buildDownstreamChain(agentId, subagentConns);

		if (agentChain.length === 0) {
			// No downstream agents — just execute the single agent normally
			// by creating a trivial 1-task plan
			this.logService.info(`[Orchestration] executeWorkflow: no downstream agents, single-agent workflow for ${agentId}`);
		}

		// ── Step 3: Create a transient OrchestrationPlan ──
		const planId = `wf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
		const tasks: PlanTask[] = [];
		const agentToTaskId = new Map<string, string>();

		// Create a task for each agent in the chain
		for (let i = 0; i < agentChain.length; i++) {
			const agent = agentChain[i];
			const taskId = `wft_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;
			agentToTaskId.set(agent.id, taskId);

			// Find dependencies: if this agent is the target of a subagent
			// connection from another agent in the chain, that's its dependency
			const deps: string[] = [];
			for (const conn of subagentConns) {
				if (conn.targetId === agent.id && agentToTaskId.has(conn.sourceId)) {
					deps.push(agentToTaskId.get(conn.sourceId)!);
				}
			}

			tasks.push({
				id: taskId,
				title: agent.name || `Workflow Step ${i + 1}`,
				description: i === 0 ? message : `上游任务输出`,
				status: PlanTaskStatus.Pending,
				dependencies: deps,
				assigneeId: agent.id,
				assigneeName: agent.name,
				assigneeRole: agent.role,
				autoCreateAgent: false,
				priority: i + 1,
				depth: i,
				retryCount: 0,
				maxRetries: DEFAULT_MAX_RETRIES,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				createdAt: new Date().toISOString(),
			});
		}

		// Topological sort to compute proper depths
		try {
			this._topologicalSort(tasks);
		} catch (err) {
			this.logService.warn(`[Orchestration] Workflow DAG validation warning: ${err}`);
		}

		const plan: OrchestrationPlan = {
			id: planId,
			goal: `[Workflow] ${startAgent.name}: ${message.slice(0, 80)}`,
			summary: `工作流执行: ${agentChain.map(a => a.name).join(' → ')}`,
			status: OrchestrationPlanStatus.Executing,
			tasks,
			workspaceId,
			plannerId: agentId,
			maxConcurrency: 1, // Workflow executes sequentially by default
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		// Persist the plan
		const plans = await this._readPlans();
		plans.push(plan);
		await this._writePlans(plans);
		this._onDidChangePlan.fire(plan);

		this.logService.info(`[Orchestration] Created workflow plan ${planId} with ${tasks.length} tasks`);

		// ── Step 4: Create task board items ──
		await this._createTaskBoardItems(plan);

		// ── Step 5: Execute the first (root) task ──
		// Find root tasks (no dependencies) and start them
		const rootTasks = tasks.filter(t => t.dependencies.length === 0);
		for (const rootTask of rootTasks) {
			rootTask.status = PlanTaskStatus.Running;
			rootTask.startedAt = new Date().toISOString();
		}
		await this._writePlans(plans);

		for (const rootTask of rootTasks) {
			// Mark the starting agent as busy
			if (rootTask.assigneeId) {
				this._markAgentBusy(rootTask.assigneeId);
			}

			this._onDidChangeTask.fire({ planId, task: rootTask });
			this._onDidChangePlan.fire(plan);

			// Execute the root task with the user's original message
			this._executeWorkflowTask(planId, rootTask, options?.agentSessionId).catch(err => {
				this.logService.error(`[Orchestration] Workflow task ${rootTask.id} execution failed:`, err);
			});
		}

		return planId;
	}

	/**
	 * Build a chain of agents starting from the given agent, following
	 * downstream 'subagent' connections (BFS traversal).
	 * Returns an array of Agent objects in topological order.
	 */
	private async _buildDownstreamChain(startAgentId: string, subagentConns: { sourceId: string; targetId: string }[]): Promise<Agent[]> {
		const visited = new Set<string>();
		const ordered: Agent[] = [];
		const queue: string[] = [startAgentId];
		visited.add(startAgentId);

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			const agent = await this.agentStudioService.getAgent(currentId);
			if (agent) {
				ordered.push(agent);
			}

			// Find direct downstream agents
			for (const conn of subagentConns) {
				if (conn.sourceId === currentId && !visited.has(conn.targetId)) {
					visited.add(conn.targetId);
					queue.push(conn.targetId);
				}
			}
		}

		return ordered;
	}

	/**
	 * Execute a single workflow task. Similar to _executeTask but
	 * includes the upstream result in the prompt for downstream agents.
	 */
	private async _executeWorkflowTask(planId: string, task: PlanTask, agentSessionId?: string): Promise<void> {
		if (!task.assigneeId) { return; }

		// Resolve the agent's current (or default) session
		let resolvedSessionId = agentSessionId;
		if (!resolvedSessionId) {
			try {
				const session = await (this.agentChatService as any).getOrCreateActiveSession(
					task.assigneeId,
					`工作流: ${task.title}`,
				);
				resolvedSessionId = session?.id as string | undefined;
			} catch {
				// Fall back to undefined
			}
		}

		const sessionIdForEvent = resolvedSessionId || '';

		// Notify the webview that a new session was created for this agent
		if (this._streamEventCallback && resolvedSessionId) {
			this._streamEventCallback('workspace.sessionUpdated', {
				agentId: task.assigneeId,
				agentSessionId: resolvedSessionId,
			});
		}

		// Build the task prompt — for downstream tasks, include the upstream result
		let taskPrompt: string;
		if (task.dependencies.length === 0) {
			// Root task: use the original user message
			taskPrompt = task.description || task.title;
		} else {
			// Downstream task: include upstream results
			const plans = await this._readPlans();
			const plan = plans.find(p => p.id === planId);
			const upstreamResults: string[] = [];
			if (plan) {
				for (const depId of task.dependencies) {
					const depTask = plan.tasks.find(t => t.id === depId);
					if (depTask?.result) {
						upstreamResults.push(`**${depTask.assigneeName || depTask.title}** 的输出:\n${depTask.result.slice(0, 2000)}`);
					}
				}
			}
			taskPrompt = `请基于上游任务的结果执行以下任务:\n\n**任务标题**: ${task.title}\n**任务描述**: ${task.description || task.title}\n\n**上游任务输出**:\n${upstreamResults.join('\n\n') || '(无上游输出)'}`;
		}

		try {
			const chatMessage = await this.agentChatService.sendMessage(
				task.assigneeId,
				taskPrompt,
				{ workspaceId: undefined, agentSessionId: resolvedSessionId },
				(delta) => {
					if (this._streamEventCallback) {
						this._streamEventCallback('chat.stream.delta', {
							agentId: task.assigneeId,
							sessionId: sessionIdForEvent,
							chunks: [delta],
						});
					}
				},
			);

			const resultContent = chatMessage.content || '';
			this.logService.info(`[Orchestration] Workflow task ${task.id} completed by agent ${task.assigneeId}`);

			// Notify the webview that the stream completed
			if (this._streamEventCallback) {
				this._streamEventCallback('chat.stream.complete', {
					agentId: task.assigneeId,
					sessionId: sessionIdForEvent,
					message: chatMessage,
				});
			}

			// Mark task as completed — this triggers downstream tasks via completeTask
			await this.completeTask(planId, task.id, resultContent);

			// Agent is now idle — try to auto-execute pending tasks
			this._markAgentIdle(task.assigneeId);
			this._tryAutoExecutePendingTasks().catch(err => {
				this.logService.warn('[Orchestration] Auto-execute check after workflow task completion failed:', err);
			});
		} catch (err) {
			this.logService.error(`[Orchestration] Workflow task ${task.id} execution error:`, err);
			this._markAgentIdle(task.assigneeId);

			// Notify the webview about the error
			if (this._streamEventCallback) {
				this._streamEventCallback('chat.stream.error', {
					agentId: task.assigneeId,
					sessionId: sessionIdForEvent,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Mark task as error so downstream tasks are not stuck
			try {
				const plans = await this._readPlans();
				const plan = plans.find(p => p.id === planId);
				const taskRef = plan?.tasks.find(t => t.id === task.id);
				if (taskRef && taskRef.status === PlanTaskStatus.Running) {
					taskRef.status = PlanTaskStatus.Error;
					taskRef.result = err instanceof Error ? err.message : String(err);
					taskRef.completedAt = new Date().toISOString();
					if (plan) { plan.updatedAt = taskRef.completedAt; }
					await this._writePlans(plans);
					await this._syncTaskBoardStatus(taskRef);
					this._onDidChangeTask.fire({ planId, task: taskRef });
					if (plan) { this._onDidChangePlan.fire(plan); }

					if (plan) {
						const promoted = this._unblockDependentTasks(plan, task.id);
						for (const p of promoted) {
							this._onDidChangeTask.fire({ planId, task: p });
						}
						this._checkPlanCompletion(plan);
					}
				}
			} catch (markErr) {
				this.logService.error(`[Orchestration] Failed to mark workflow task ${task.id} as error:`, markErr);
			}
		}
	}

	async completeTask(planId: string, taskId: string, result?: string): Promise<PlanTask | undefined> {
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

		// ─── Human-in-the-Loop: Set review status if task needs review ─────────────────
		if (task.needsReview) {
			task.reviewStatus = TaskReviewStatus.Pending;
		}

		// Send completion message to agent's chat box
		if (task.assigneeId) {
			try {
				const chatMessage = {
					id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					role: 'system' as const,
					content: `✅ 任务执行完成: ${task.title}\n\n${result ? `执行结果: ${result}` : '任务已完成'}\n任务ID: ${task.id}`,
				agentId: task.assigneeId,
				agentSessionId: undefined,
					timestamp: new Date().toISOString(),
				};
				await this.agentChatService.appendMessage(task.assigneeId, chatMessage);
				this.logService.info(`[Orchestration] Sent completion message to agent ${task.assigneeId} for task ${task.id}`);
			} catch (err) {
				this.logService.warn(`[Orchestration] Failed to send completion message to agent ${task.assigneeId}:`, err);
			}
		}

		// Unblock downstream dependents (core DAG propagation)
		const promoted = this._unblockDependentTasks(plan, task.id);
		for (const p of promoted) {
			// If the assigned agent is busy, revert to Pending so that
			// _tryAutoExecutePendingTasks can pick it up when the agent becomes idle.
			// This avoids leaving a task in Running state without actual execution.
			if (p.assigneeId && this._isAgentBusy(p.assigneeId)) {
				p.status = PlanTaskStatus.Pending;
				p.startedAt = undefined;
				this.logService.info(`[Orchestration] Promoted task "${p.title}" (${p.id}) reverted to Pending — agent ${p.assigneeId} is busy, will auto-execute later`);
			} else if (p.assigneeId) {
				// Agent is idle — execute immediately
				this._onDidChangeTask.fire({ planId, task: p });
				this._executeTask(planId, p).catch(err => {
					this.logService.error(`[Orchestration] Promoted task ${p.id} execution failed:`, err);
				});
				continue;
			}
			this._onDidChangeTask.fire({ planId, task: p });
		}

		this._checkPlanCompletion(plan);
		await this._writePlans(plans);
		await this._syncTaskBoardStatus(task);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	// ═══ Task Agent Assignment ═══════════════════════════════════════════════════

	/**
	 * Ensure a task has an agent assigned before execution.
	 * Called when user clicks "approve" to start a task.
	 *
	 * Strategy:
	 * 1. If task already has a valid assigneeId (agent still exists), keep it.
	 * 2. If task has an assigneeName, try to find an existing agent by name.
	 * 3. If task has a role, try scoring-based selection from existing agents.
	 * 4. If no suitable agent found, auto-create one.
	 *
	 * NOTE: Does NOT update task board records — the caller is responsible for that.
	 * Only updates the plan task if a corresponding one exists.
	 */
	async ensureTaskAgent(
		workspaceId: string,
		taskBoardRecordId: string,
		taskInfo?: { title: string; description?: string; assigneeId?: string; assigneeName?: string; sourceId?: string },
	): Promise<{ assigneeId: string; assigneeName: string } | undefined> {
		this.logService.info(`[Orchestration] ensureTaskAgent: workspaceId=${workspaceId}, taskBoardRecordId=${taskBoardRecordId}`);

		// Use provided task info or fall back to reading from task board
		let taskTitle = taskInfo?.title || 'Unknown Task';
		let currentAssigneeId = taskInfo?.assigneeId;
		let currentAssigneeName = taskInfo?.assigneeName;
		let sourceId = taskInfo?.sourceId;

		if (!taskInfo) {
			const boardTasks = await this.taskBoardService.getTasks(workspaceId);
			const boardTask = boardTasks.find(t => t.id === taskBoardRecordId);
			if (!boardTask) {
				this.logService.warn(`[Orchestration] ensureTaskAgent: Task board record ${taskBoardRecordId} not found`);
				return undefined;
			}
			taskTitle = boardTask.title;
			currentAssigneeId = boardTask.assigneeId;
			currentAssigneeName = boardTask.assigneeName;
			sourceId = boardTask.sourceId;
		}

		// Strategy 0: Already has a valid assignee — verify it still exists
		if (currentAssigneeId) {
			const agents = await this.agentStudioService.getAgents();
			const existing = agents.find(e => e.id === currentAssigneeId);
			if (existing) {
				this.logService.info(`[Orchestration] ensureTaskAgent: Task "${taskTitle}" already has valid agent "${existing.name}" (${existing.id})`);
				return { assigneeId: existing.id, assigneeName: existing.name };
			}
			this.logService.info(`[Orchestration] ensureTaskAgent: Assignee ${currentAssigneeId} no longer exists, re-assigning`);
		}

		// Find the corresponding plan task for role/assigneeName info
		let planTask: PlanTask | undefined;
		const plans = await this._readPlans();
		for (const plan of plans) {
			const found = plan.tasks.find(t => t.id === sourceId);
			if (found) { planTask = found; break; }
		}

		const agents = await this.agentStudioService.getAgents();
		const existingByName = new Map(agents.map(e => [e.name.toLowerCase(), e]));
		const taskRole = planTask?.assigneeRole || currentAssigneeName || 'Agent';
		const taskAssigneeName = planTask?.assigneeName || currentAssigneeName;

		// Strategy 1: Name match — reuse existing agent by name
		if (taskAssigneeName) {
			const existing = existingByName.get(taskAssigneeName.toLowerCase());
			if (existing) {
				this.logService.info(`[Orchestration] ensureTaskAgent: [Name match] Reused agent "${existing.name}" (${existing.id}) for task "${taskTitle}"`);
				if (planTask) {
					planTask.assigneeId = existing.id;
					planTask.assigneeName = existing.name;
					await this._writePlans(plans);
				}
				return { assigneeId: existing.id, assigneeName: existing.name };
			}
		}

		// Strategy 2: Score-based selection from existing agents
		const candidates = agents.filter(e =>
			e.status !== 'offline'
		);
		if (candidates.length > 0) {
			let best: Agent | undefined;
			let bestScore = -1;
			for (const agent of candidates) {
				const agentRole = (agent.role || '').toLowerCase();
				const required = taskRole.toLowerCase().trim();
				let score = 0.3;
				if (required && agentRole === required) { score = 1.0; }
				else if (required) {
					const keywords = required.split(/[\s,/\\-]+/).filter(k => k.length > 2);
					if (keywords.length > 0) {
						const matched = keywords.filter(kw => agentRole.includes(kw)).length;
						score = Math.max(0.1, matched / keywords.length);
					}
				}
				if (agent.status === 'idle') { score += 0.3; }
				else if (agent.status === 'working') { score += 0.1; }

				if (score > bestScore) {
					bestScore = score;
					best = agent;
				}
			}
			if (best && bestScore >= 0.1) {
				this.logService.info(`[Orchestration] ensureTaskAgent: [Score match] Selected agent "${best.name}" (${best.id}, score=${bestScore.toFixed(3)}) for task "${taskTitle}"`);
				if (planTask) {
					planTask.assigneeId = best.id;
					planTask.assigneeName = best.name;
					await this._writePlans(plans);
				}
				return { assigneeId: best.id, assigneeName: best.name };
			}
		}

		// Strategy 3: Auto-create agent
		const agentName = taskAssigneeName || `Agent-${taskTitle.slice(0, 20)}`;
		try {
			this.logService.info(`[Orchestration] ensureTaskAgent: [Auto-create] Creating agent "${agentName}" for task "${taskTitle}"`);
			const newAgent = await this.agentStudioService.createAgent({
				name: agentName,
				role: taskRole || 'Agent',
				agentType: AgentType.Worker,
				workspaceId,
			} as Partial<Agent>);
			if (planTask) {
				planTask.assigneeId = newAgent.id;
				planTask.assigneeName = newAgent.name;
				await this._writePlans(plans);
			}
			this.logService.info(`[Orchestration] ensureTaskAgent: Created agent "${newAgent.name}" (${newAgent.id}) for task "${taskTitle}"`);
			return { assigneeId: newAgent.id, assigneeName: newAgent.name };
		} catch (err) {
			this.logService.error(`[Orchestration] ensureTaskAgent: Failed to create agent: ${err}`);
			return undefined;
		}
	}

	/**
	 * Execute a task board item by invoking the assigned agent.
	 * Used when a task transitions to 'running' from the task board UI.
	 * Also pushes chat.stream.* events to the webview.
	 */
	async executeTaskForBoard(
		workspaceId: string,
		taskBoardRecordId: string,
		taskInfo?: { title: string; description?: string; assigneeId?: string; assigneeName?: string; sourceId?: string },
	): Promise<void> {
		const assigneeId = taskInfo?.assigneeId;
		if (!assigneeId) {
			this.logService.warn(`[Orchestration] executeTaskForBoard: no assigneeId for task ${taskBoardRecordId}`);
			return;
		}

		const taskTitle = taskInfo?.title || 'Unknown Task';
		const taskDesc = taskInfo?.description || taskTitle;
		const sourceId = taskInfo?.sourceId;

		// Find the corresponding plan task (if any) for the planId
		let planId: string | undefined;
		if (sourceId) {
			const plans = await this._readPlans();
			for (const plan of plans) {
				if (plan.tasks.find(t => t.id === sourceId)) {
					planId = plan.id;
					break;
				}
			}
		}

		// Resolve the agent's current session
		let agentSessionId: string | undefined;
		try {
			const session = await (this.agentChatService as any).getOrCreateActiveSession(
				assigneeId,
				`任务: ${taskTitle}`,
			);
			agentSessionId = session?.id as string | undefined;
		} catch { /* fall back to undefined */ }

		const sessionIdForEvent = agentSessionId || '';

		// Notify the webview that a new session was created for this agent
		if (this._streamEventCallback && agentSessionId) {
			this._streamEventCallback('workspace.sessionUpdated', {
				agentId: assigneeId,
				agentSessionId,
			});
		}

		// Build task prompt
		const taskPrompt = `请执行以下任务:\n\n**任务标题**: ${taskTitle}\n**任务描述**: ${taskDesc}\n**任务来源**: 任务看板`;

		// Mark agent as busy while executing this board task
		this._markAgentBusy(assigneeId);

		try {
			const chatMessage = await this.agentChatService.sendMessage(
				assigneeId,
				taskPrompt,
				{ workspaceId, agentSessionId },
				(delta) => {
					if (this._streamEventCallback) {
						this._streamEventCallback('chat.stream.delta', {
							agentId: assigneeId,
							sessionId: sessionIdForEvent,
							chunks: [delta],
						});
					}
				},
			);

			this.logService.info(`[Orchestration] executeTaskForBoard: task ${taskBoardRecordId} completed by agent ${assigneeId}`);

			// Notify the webview that the stream completed
			if (this._streamEventCallback) {
				this._streamEventCallback('chat.stream.complete', {
					agentId: assigneeId,
					sessionId: sessionIdForEvent,
					message: chatMessage,
				});
			}

			// Update task board status to Done (regardless of whether there's a linked plan task)
			await this.taskBoardService.updateTaskStatus(taskBoardRecordId, TaskBoardStatus.Done).catch(updateErr => {
				this.logService.warn(`[Orchestration] executeTaskForBoard: failed to update task board status for ${taskBoardRecordId}:`, updateErr);
			});

			// If we found a plan task, also update it
			if (planId && sourceId) {
				await this.completeTask(planId, sourceId, chatMessage.content).catch(err => {
					this.logService.warn(`[Orchestration] executeTaskForBoard: failed to complete plan task ${sourceId}:`, err);
				});
			}

			// Agent is now idle — try to auto-execute pending tasks
			this._markAgentIdle(assigneeId);
			this._tryAutoExecutePendingTasks().catch(err => {
				this.logService.warn('[Orchestration] Auto-execute check after board task completion failed:', err);
			});
		} catch (err) {
			this.logService.error(`[Orchestration] executeTaskForBoard: task ${taskBoardRecordId} execution error:`, err);

			if (this._streamEventCallback) {
				this._streamEventCallback('chat.stream.error', {
					agentId: assigneeId,
					sessionId: sessionIdForEvent,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Update task board status to Done even on error so the card doesn't stay in "running"
			await this.taskBoardService.updateTaskStatus(taskBoardRecordId, TaskBoardStatus.Done).catch(updateErr => {
				this.logService.warn(`[Orchestration] executeTaskForBoard: failed to update task board status on error for ${taskBoardRecordId}:`, updateErr);
			});

			// Agent is no longer busy — mark idle and try auto-execute
			this._markAgentIdle(assigneeId);
			this._tryAutoExecutePendingTasks().catch(err2 => {
				this.logService.warn('[Orchestration] Auto-execute check after board task error failed:', err2);
			});
		}
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
		await this._createTaskBoardItems(planRef);

		// ── Step 6: Start ready tasks (respecting concurrency limit) ──
		// On initial plan execution, agents are typically idle, but check anyway
		// for cases where an agent might already be running a task from another plan.
		const ready = this._getReadyTasks(planRef);
		for (const task of ready) {
			// If agent is busy with another task, keep as Pending for auto-execution
			if (task.assigneeId && this._isAgentBusy(task.assigneeId)) {
				this.logService.info(`[Orchestration] Ready task "${task.title}" (${task.id}) kept as Pending — agent ${task.assigneeId} is busy with another task`);
				continue;
			}
			task.status = PlanTaskStatus.Running;
			task.startedAt = new Date().toISOString();

			// Fire-and-forget: actually invoke the agent to execute the task
			if (task.assigneeId) {
				this._executeTask(planRef.id, task).catch(err => {
					this.logService.error(`[Orchestration] Task ${task.id} execution failed:`, err);
				});
			}
		}

		planRef.updatedAt = new Date().toISOString();
		await this._writePlans(plans);
		this._onDidChangePlan.fire(planRef);
	}

	/**
	 * Create task board items from plan tasks without starting execution.
	 */
	private async _createTaskBoardItems(planRef: OrchestrationPlan): Promise<void> {
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
						workspaceId: planRef.workspaceId,
						priority: task.priority <= 1 ? 'high' : task.priority <= 3 ? 'medium' : 'low',
					} as Record<string, unknown>);
				} catch (err) {
					this.logService.warn(`[Orchestration] Failed to create task board item for task ${task.id}:`, err);
				}
			}
		}
	}

	/**
	 * Create tasks from plan and set up agents/connections/layout,
	 * but do NOT start task execution.
	 */
	private async _createTasksFromPlan(plan: OrchestrationPlan): Promise<void> {
		this.logService.info(`[Orchestration] Creating tasks from plan (no execution): ${plan.id}`);

		const plans = await this._readPlans();
		const planRef = plans.find(p => p.id === plan.id);
		if (!planRef) { return; }

		// ── Step 1: Topological sort to validate + compute depths ──
		try {
			this._topologicalSort(planRef.tasks);
		} catch (err) {
			throw new Error(`DAG validation failed: ${err instanceof Error ? err.message : err}`);
		}

		// ── Step 2: Auto-create agents + intelligent assignment ──
		this._agentFactory.resetPool();
		await this._agentFactory.assignAgents(planRef);

		// ── Step 3: Auto-create connections ──
		await this._agentFactory.wireConnections(planRef);

		// ── Step 4: Auto-layout canvas ──
		await this._layoutEngine.autoArrangeCanvas(planRef);

		// ── Step 5: Create task board items (tasks stay in 'todo' status) ──
		await this._createTaskBoardItems(planRef);

		planRef.updatedAt = new Date().toISOString();
		await this._writePlans(plans);
		this._onDidChangePlan.fire(planRef);
	}

	/**
	 * Execute a single task by invoking the assigned agent.
	 * Sends the task description as a user message, streams the agent's response,
	 * and marks the task as completed (or errored) when done.
	 * Also pushes chat.stream.* events to the webview so the execution
	 * content appears in the agent's chat box in real-time.
	 */
	// ═══ Automatic Task Decomposition & SubAgent Creation ════════════════════

	/**
	 * Check if a task needs code exploration before execution.
	 * Uses heuristics and optional AI analysis to determine if the task
	 * would benefit from parallel code exploration via explore subagents.
	 */
	private async _needsCodeExploration(task: PlanTask): Promise<boolean> {
		// Heuristics: tasks that likely need code exploration
		const explorationKeywords = [
			'实现', 'implement', '开发', 'develop', '编码', 'code',
			'修复', 'fix', '调试', 'debug', '查找', 'find', '搜索', 'search',
			'分析', 'analyze', '理解', 'understand', '探索', 'explore',
			'重构', 'refactor', '优化', 'optimize', '改进', 'improve'
		];
		
		const taskText = `${task.title} ${task.description || ''}`.toLowerCase();
		const hasExplorationKeyword = explorationKeywords.some(keyword => 
			taskText.includes(keyword.toLowerCase())
		);

		// If task is simple (no dependencies, short description), skip exploration
		if (!hasExplorationKeyword || taskText.length < 20) {
			return false;
		}

		// Use AI to make a more informed decision
		try {
			const prompt = `Analyze if the following task requires code exploration before execution.

Task: ${task.title}
Description: ${task.description || task.title}

Does this task require exploring the codebase to understand existing code, find relevant files, or understand the architecture?

Answer with only "yes" or "no".`;

			const response = await this._collectStreamText(
				this.agentOSService.executeAgentTurn(
					{ agentId: '_planner', messages: [{ role: 'user', content: prompt }] }
				)
			);

			const answer = response.toLowerCase();
			return answer.includes('yes');
		} catch {
			// If AI check fails, fall back to heuristic
			return hasExplorationKeyword;
		}
	}

	/**
	 * Decompose a task into exploration subtasks using AI.
	 * Returns an array of exploration prompts for subagents.
	 */
	private async _decomposeTaskForExploration(task: PlanTask): Promise<string[]> {
		try {
			const repoOverview = await this._getRepoOverview();
			const prompt = `You are planning code exploration for a task. Based on the task and codebase overview, 
generate 2-4 focused exploration subtasks that will gather the necessary context.

**Task**: ${task.title}
**Description**: ${task.description || task.title}

**Codebase Overview**:
${repoOverview}

Generate exploration subtasks that will help understand:
1. Relevant files and modules
2. Existing patterns and architecture
3. Dependencies and imports
4. Similar implementations

Return a JSON array of strings, each being a focused exploration prompt for a subagent.
Example: ["Explore the authentication module to understand the login flow", "Search for similar API endpoint implementations"]

Only return the JSON array, no other text.`;

			const response = await this._collectStreamText(
				this.agentOSService.executeAgentTurn(
					{ agentId: '_planner', messages: [{ role: 'user', content: prompt }] }
				)
			);

			// Parse the response as JSON array
			const match = response.match(/\[[\s\S]*\]/);
			if (match) {
				const subtasks = JSON.parse(match[0]);
				if (Array.isArray(subtasks) && subtasks.length > 0) {
					return subtasks.slice(0, 4); // Max 4 exploration subtasks
				}
			}
			
			// Fallback: create a single exploration task
			return [`Explore the codebase to understand the context for: ${task.title}`];
		} catch (error) {
			this.logService.warn('[Orchestration] Failed to decompose task for exploration:', error);
			// Fallback: create a single exploration task
			return [`Explore the codebase to understand the context for: ${task.title}`];
		}
	}

	/**
	 * Execute explore subagents in parallel and return their results.
	 */
	private async _executeExploreSubAgents(
		parentAgentId: string,
		explorationTasks: string[],
	): Promise<string[]> {
		try {
			const repoOverview = await this._getRepoOverview();
			
			// Create executeFn that delegates to agentOSService.executeAgentTurn
			const executeFn = (request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> => {
				return this.agentOSService.executeAgentTurn(request);
			};

			// Dispatch parallel explore subagents
			const results = await this._subAgentDispatch.dispatchParallelExplore(
				parentAgentId,
				explorationTasks,
				executeFn,
				repoOverview
			);

			// Extract outputs from results
			return results
				.filter(r => r.success && r.output)
				.map(r => r.output!);
		} catch (error) {
			this.logService.error('[Orchestration] Failed to execute explore subagents:', error);
			return [];
		}
	}

	/** Collect all text deltas from an AsyncIterable<IChatStreamDelta> into a string. */
	private async _collectStreamText(stream: AsyncIterable<IChatStreamDelta>): Promise<string> {
		let output = '';
		for await (const delta of stream) {
			if (delta.type === 'text' && delta.content) {
				output += delta.content;
			}
			if (delta.type === 'done' || delta.type === 'error') {
				break;
			}
		}
		return output;
	}

	/**
	 * Summarize subagent results into a concise context for the main task.
	 */
	private async _summarizeSubAgentResults(
		task: PlanTask,
		subAgentResults: string[],
	): Promise<string> {
		if (subAgentResults.length === 0) {
			return '';
		}

		try {
			const combinedResults = subAgentResults.join('\n\n---\n\n');
			const prompt = `Summarize the following code exploration results into a concise context for task execution.

**Task**: ${task.title}
**Description**: ${task.description || task.title}

**Exploration Results**:
${combinedResults}

Provide a structured summary that includes:
1. Key files and modules identified
2. Relevant code patterns and architecture
3. Important findings for task execution
4. Any potential issues or dependencies

Keep the summary concise and focused on information needed to execute the task.`;

			const summary = await this._collectStreamText(
				this.agentOSService.executeAgentTurn(
					{ agentId: '_planner', messages: [{ role: 'user', content: prompt }] }
				)
			);

			return summary;
		} catch (error) {
			this.logService.warn('[Orchestration] Failed to summarize subagent results:', error);
			// Fallback: return combined results (truncated)
			return subAgentResults.join('\n\n').substring(0, 2000);
		}
	}

	// ═══ Task Execution (modified to include automatic exploration) ═══════════

	private async _executeTask(planId: string, task: PlanTask): Promise<void> {
		if (!task.assigneeId) { return; }

		// Mark agent as busy while executing this task
		this._markAgentBusy(task.assigneeId);

		// ─── Automatic Task Decomposition & Exploration ─────────────────
		let explorationContext = '';
		try {
			const needsExploration = await this._needsCodeExploration(task);
			if (needsExploration) {
				this.logService.info(`[Orchestration] Task ${task.id} needs code exploration, decomposing...`);
				
				// Notify webview about exploration start
				if (this._streamEventCallback) {
					this._streamEventCallback('orchestration.explorationStart', {
						taskId: task.id,
						taskTitle: task.title,
					});
				}

				// Decompose task into exploration subtasks
				const explorationTasks = await this._decomposeTaskForExploration(task);
				this.logService.info(`[Orchestration] Decomposed into ${explorationTasks.length} exploration subtasks`);

				// Execute explore subagents in parallel
				const subAgentResults = await this._executeExploreSubAgents(task.assigneeId, explorationTasks);
				this.logService.info(`[Orchestration] Exploration completed, got ${subAgentResults.length} results`);

				// Summarize results
				explorationContext = await this._summarizeSubAgentResults(task, subAgentResults);

				// Notify webview about exploration complete
				if (this._streamEventCallback) {
					this._streamEventCallback('orchestration.explorationComplete', {
						taskId: task.id,
						taskTitle: task.title,
						context: explorationContext,
					});
				}
			}
		} catch (error) {
			this.logService.warn('[Orchestration] Exploration failed, continuing without context:', error);
		}

		// Build task prompt with exploration context if available
		const taskPrompt = `请执行以下任务:\n\n**任务标题**: ${task.title}\n**任务描述**: ${task.description || task.title}\n**任务ID**: ${task.id}${task.dependencies.length > 0 ? `\n**依赖任务**: ${task.dependencies.join(', ')}` : ''}${explorationContext ? `\n\n**代码探索上下文**:\n${explorationContext}` : ''}`;

		// Resolve the agent's current (or default) session so messages are
		// persisted under the same key that the webview loads.
		let agentSessionId: string | undefined;
		try {
			const session = await (this.agentChatService as any).getOrCreateActiveSession(
				task.assigneeId,
				`任务: ${task.title}`,
			);
			agentSessionId = session?.id as string | undefined;
		} catch {
			// Fall back to undefined — messages go to the "no session" bucket
		}

		const sessionIdForEvent = agentSessionId || '';

		// Notify the webview that a new session was created for this agent
		if (this._streamEventCallback && agentSessionId) {
			this._streamEventCallback('workspace.sessionUpdated', {
				agentId: task.assigneeId,
				agentSessionId,
			});
		}

		try {
			// Send the task as a user message and get the agent's response,
			// forwarding stream deltas to the webview for real-time display.
			const chatMessage = await this.agentChatService.sendMessage(
				task.assigneeId,
				taskPrompt,
				{ workspaceId: undefined, agentSessionId },
				(delta) => {
					// Forward stream deltas to the webview
					if (this._streamEventCallback) {
						this._streamEventCallback('chat.stream.delta', {
							agentId: task.assigneeId,
							sessionId: sessionIdForEvent,
							chunks: [delta],
						});
					}
				},
			);

			// Extract result content from the assistant response
			const resultContent = chatMessage.content || '';
			this.logService.info(`[Orchestration] Task ${task.id} completed by agent ${task.assigneeId}`);

			// Notify the webview that the stream completed
			if (this._streamEventCallback) {
				this._streamEventCallback('chat.stream.complete', {
					agentId: task.assigneeId,
					sessionId: sessionIdForEvent,
					message: chatMessage,
				});
			}

			// Mark task as completed, which also triggers downstream tasks
			await this.completeTask(planId, task.id, resultContent);

			// Agent is now idle — try to auto-execute pending tasks for this agent
			this._markAgentIdle(task.assigneeId);
			this._tryAutoExecutePendingTasks().catch(err => {
				this.logService.warn('[Orchestration] Auto-execute check after task completion failed:', err);
			});
		} catch (err) {
			this.logService.error(`[Orchestration] Task ${task.id} execution error:`, err);

			// Agent is no longer busy — mark idle before error handling
			this._markAgentIdle(task.assigneeId);

			// Notify the webview about the error
			if (this._streamEventCallback) {
				this._streamEventCallback('chat.stream.error', {
					agentId: task.assigneeId,
					sessionId: sessionIdForEvent,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Mark task as error so downstream tasks are not stuck
			try {
				const plans = await this._readPlans();
				const plan = plans.find(p => p.id === planId);
				const taskRef = plan?.tasks.find(t => t.id === task.id);
				if (taskRef && taskRef.status === PlanTaskStatus.Running) {
					taskRef.status = PlanTaskStatus.Error;
					taskRef.result = err instanceof Error ? err.message : String(err);
					taskRef.completedAt = new Date().toISOString();
					if (plan) { plan.updatedAt = taskRef.completedAt; }
					await this._writePlans(plans);
					await this._syncTaskBoardStatus(taskRef);
					this._onDidChangeTask.fire({ planId, task: taskRef });
					if (plan) { this._onDidChangePlan.fire(plan); }

					// Still try to promote downstream tasks even on error
					if (plan) {
						const promoted = this._unblockDependentTasks(plan, task.id);
						for (const p of promoted) {
							this._onDidChangeTask.fire({ planId, task: p });
						}
						this._checkPlanCompletion(plan);
					}
				}
			} catch (markErr) {
				this.logService.error(`[Orchestration] Failed to mark task ${task.id} as error:`, markErr);
			}

			// Agent is now idle — try to auto-execute pending tasks
			this._tryAutoExecutePendingTasks().catch(err2 => {
				this.logService.warn('[Orchestration] Auto-execute check after task error failed:', err2);
			});
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

	private _generateSummary(tasks: PlanTask[]): string {
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
		return summary;
	}

	// ═══ Human-in-the-Loop Methods ══════════════════════════════════════════

	/**
	 * Approve a completed task that needs human review.
	 * Task must be in 'done' status and 'pending' review status.
	 */
	async approveTask(planId: string, taskId: string, comment?: string): Promise<PlanTask> {
		this.logService.info(`[Orchestration] approveTask: planId=${planId}, taskId=${taskId}`);
		
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) { throw new Error(`Task not found: ${taskId}`); }

		if (task.status !== PlanTaskStatus.Done || task.reviewStatus !== TaskReviewStatus.Pending) {
			throw new Error(`Cannot approve task in status: ${task.status}, reviewStatus: ${task.reviewStatus}`);
		}

		const now = new Date().toISOString();
		task.reviewStatus = TaskReviewStatus.Approved;
		task.reviewedBy = 'user'; // TODO: get actual user info
		task.reviewedAt = now;
		if (comment) {
			task.reviewComment = comment;
		}

		// Unblock downstream tasks
		const promoted = this._unblockDependentTasks(plan, task.id);
		for (const p of promoted) {
			this._onDidChangeTask.fire({ planId, task: p });
		}

		this._checkPlanCompletion(plan);
		await this._writePlans(plans);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	/**
	 * Reject a completed task that needs human review.
	 * Task will be reset to 'pending' status for re-execution.
	 */
	async rejectTask(planId: string, taskId: string, comment?: string): Promise<PlanTask> {
		this.logService.info(`[Orchestration] rejectTask: planId=${planId}, taskId=${taskId}`);
		
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) { throw new Error(`Task not found: ${taskId}`); }

		if (task.status !== PlanTaskStatus.Done || task.reviewStatus !== TaskReviewStatus.Pending) {
			throw new Error(`Cannot reject task in status: ${task.status}, reviewStatus: ${task.reviewStatus}`);
		}

		const now = new Date().toISOString();
		task.reviewStatus = TaskReviewStatus.Rejected;
		task.reviewedBy = 'user'; // TODO: get actual user info
		task.reviewedAt = now;
		if (comment) {
			task.reviewComment = comment;
		}

		// Reset task to pending for re-execution
		task.status = PlanTaskStatus.Pending;
		task.result = undefined;
		task.completedAt = undefined;
		task.startedAt = undefined;

		plan.updatedAt = now;
		await this._writePlans(plans);
		await this._syncTaskBoardStatus(task);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	/**
	 * Add a comment to a task (human-agent collaboration).
	 */
	async commentTask(planId: string, taskId: string, comment: string): Promise<PlanTask> {
		this.logService.info(`[Orchestration] commentTask: planId=${planId}, taskId=${taskId}`);
		
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) { throw new Error(`Task not found: ${taskId}`); }

		if (!task.comments) {
			task.comments = [];
		}

		const newComment: TaskComment = {
			id: this._generateId('comment'),
			author: 'user', // TODO: get actual user info
			content: comment,
			createdAt: new Date().toISOString(),
		};
		task.comments.push(newComment);

		const now = new Date().toISOString();
		plan.updatedAt = now;
		await this._writePlans(plans);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	/**
	 * Block a task to prevent it from executing.
	 */
	async blockTask(planId: string, taskId: string, reason?: string): Promise<PlanTask> {
		this.logService.info(`[Orchestration] blockTask: planId=${planId}, taskId=${taskId}`);
		
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) { throw new Error(`Task not found: ${taskId}`); }

		if (task.isBlocked) {
			throw new Error(`Task is already blocked`);
		}

		const now = new Date().toISOString();
		task.isBlocked = true;
		task.blockedBy = 'user'; // TODO: get actual user info
		task.blockedAt = now;
		if (reason) {
			task.blockedReason = reason;
		}

		// If task is running, pause it
		if (task.status === PlanTaskStatus.Running) {
			task.status = PlanTaskStatus.Paused;
		}

		plan.updatedAt = now;
		await this._writePlans(plans);
		await this._syncTaskBoardStatus(task);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}

	/**
	 * Unblock a previously blocked task.
	 */
	async unblockTask(planId: string, taskId: string): Promise<PlanTask> {
		this.logService.info(`[Orchestration] unblockTask: planId=${planId}, taskId=${taskId}`);
		
		const plans = await this._readPlans();
		const plan = plans.find(p => p.id === planId);
		if (!plan) { throw new Error(`Plan not found: ${planId}`); }
		const task = plan.tasks.find(t => t.id === taskId);
		if (!task) { throw new Error(`Task not found: ${taskId}`); }

		if (!task.isBlocked) {
			throw new Error(`Task is not blocked`);
		}

		const now = new Date().toISOString();
		task.isBlocked = false;
		task.blockedReason = undefined;

		// If task was paused due to blocking, resume it
		if (task.status === PlanTaskStatus.Paused) {
			task.status = PlanTaskStatus.Pending;
		}

		plan.updatedAt = now;
		await this._writePlans(plans);
		await this._syncTaskBoardStatus(task);
		this._onDidChangeTask.fire({ planId, task });
		this._onDidChangePlan.fire(plan);
		return task;
	}
}
