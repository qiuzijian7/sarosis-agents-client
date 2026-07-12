/*---------------------------------------------------------------------------------------------
 *  Agent Studio - Task Overview EditorPane (Native DOM)
 *
 *  VS Code native kanban board using DOM rendering instead of webview/React.
 *  Direct service calls, no postMessage overhead, instant rendering.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { GroupsOrder, IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import {
	IAgentTaskBoardService,
	IAgentStudioService,
	IAgentChatService,
	ITaskOrchestrationService,
} from '../common/agentStudio.js';
import { IKanbanDiagnosticsService } from '../common/kanbanDiagnosticsService.js';
import { ISwarmService } from '../common/swarmService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { TaskBoardNativeRenderer, type TaskBoardRenderData, type TaskBoardFilter, type EmployeeInfo, type SwarmInfo } from './taskBoardNativeRenderer.js';
import { ScheduleViewRenderer, injectScheduleStyles, type ScheduleDraft, type ScheduleEditPrefill } from './scheduleViewRenderer.js';
import { IAgentSchedulerService, ScheduleState, OverlapPolicy } from '../common/agentScheduler.js';
import type { IScheduleInfo, IScheduleTriggerEvent, IScheduleInput, ICronScheduleConfig, IIntervalConfig, IOneShotConfig } from '../common/agentScheduler.js';
import { TaskDetailEditorInput } from './taskDetailEditorInput.js';
import { TaskBoardStatus, TaskSource, type TaskBoardRecord } from '../../../common/agentStudioTypes.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * Task Overview EditorPane — Native DOM kanban board.
 *
 * Architecture: we own a `<div>` container and use TaskBoardNativeRenderer
 * to render the kanban UI with vanilla DOM. Services are called directly
 * (no postMessage bridge), and service events trigger automatic UI refreshes.
 */
export class TaskOverviewEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.taskOverview';

	private _container: HTMLElement | undefined;
	private _renderer: TaskBoardNativeRenderer | undefined;
	private _isInitialized = false;

	// Plan D: Tab double-view (task board ⇄ schedule management)
	private _tabBar: HTMLElement | undefined;
	private _boardContainer: HTMLElement | undefined;
	private _scheduleContainer: HTMLElement | undefined;
	private _scheduleRenderer: ScheduleViewRenderer | undefined;
	private _boardTabBadge: HTMLElement | undefined;
	private _scheduleTabBadge: HTMLElement | undefined;
	private _boardTabBtn: HTMLElement | undefined;
	private _scheduleTabBtn: HTMLElement | undefined;
	private _activeView: 'board' | 'schedule' = 'board';
	// Timer that refreshes schedule countdowns while the schedule view is visible.
	private _scheduleTicker: any = null;

	// Drag suppression: when the user drags a card to a new column, the
	// renderer already moves the DOM element optimistically.  Skipping the
	// subsequent full _refresh() avoids a flash where the card disappears
	// during DOM clear and reappears after rebuild.
	private _suppressNextBoardRefresh = false;

	// rAF debounce: coalesce multiple onDidChangeTaskBoard fires into a single
	// _refresh() + render() within one animation frame. Without this, a single
	// updateTask can fire 2× (line 529 immediate + line 563 after ensureTaskAgent),
	// each triggering a full async _refresh() — causing overlapping renders and
	// redundant layout thrashing (P2-12 fix).
	private _refreshRafId: number | null = null;
	private _isRefreshing = false;
	private _refreshQueued = false;

	// Filter state
	private _boardFilterWsId = 'all';
	private _employeeFilter = 'all';
	private _hiddenColumnKeys = new Set<string>();
	private _focusedTaskId: string | null = null;

	// Task queuing: when an agent already has running tasks, new tasks are queued.
	// Key = assigneeId, value = array of queued task IDs.
	private _queuedTasks = new Map<string, string[]>();
	// Unsubscribe function for queued-task auto-start listener
	private _queueListenerDispose: { dispose(): void } | null = null;

	// Cached employee info (loaded once)
	private _allEmployees: EmployeeInfo[] = [];

	// Cached provider/model list (invalidated when language models change)
	private _providerListCache: { id: string; name: string; icon?: string; models: { id: string; name: string }[] }[] | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
		@IAgentTaskBoardService private readonly _taskBoardService: IAgentTaskBoardService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
		@ITaskOrchestrationService private readonly _taskOrchestrationService: ITaskOrchestrationService,
		@IKanbanDiagnosticsService private readonly _diagnosticsService: IKanbanDiagnosticsService,
		@ISwarmService private readonly _swarmService: ISwarmService,
		@IEditorService private readonly _editorService: IEditorService,
		@IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
		@IAgentChatService private readonly _agentChatService: IAgentChatService,
		@IBrowserViewWorkbenchService private readonly _browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ILanguageModelsService private readonly _lmService: ILanguageModelsService,
		@IAgentSchedulerService private readonly _schedulerService: IAgentSchedulerService,
	) {
		super(TaskOverviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		injectScheduleStyles();

		this._container = DOM.$('div.task-overview-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.overflow = 'hidden';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		parent.appendChild(this._container);

		// ── Tab bar (Plan D) ──
		this._tabBar = DOM.$('div.sched-tab-bar');
		this._boardTabBtn = DOM.$('button.sched-view-tab.active');
		this._boardTabBtn.appendChild(DOM.$('span.sched-tab-icon', undefined, '📋'));
		this._boardTabBtn.appendChild(DOM.$('span', undefined, '任务看板'));
		this._boardTabBadge = DOM.$('span.sched-tab-badge', undefined, '0');
		this._boardTabBtn.appendChild(this._boardTabBadge);
		this._boardTabBtn.onclick = () => this._switchView('board');
		this._tabBar.appendChild(this._boardTabBtn);

		this._scheduleTabBtn = DOM.$('button.sched-view-tab');
		this._scheduleTabBtn.appendChild(DOM.$('span.sched-tab-icon', undefined, '⏰'));
		this._scheduleTabBtn.appendChild(DOM.$('span', undefined, '定时任务'));
		this._scheduleTabBadge = DOM.$('span.sched-tab-badge', undefined, '0');
		this._scheduleTabBtn.appendChild(this._scheduleTabBadge);
		this._scheduleTabBtn.onclick = () => this._switchView('schedule');
		this._tabBar.appendChild(this._scheduleTabBtn);

		this._tabBar.appendChild(DOM.$('span.sched-tab-spacer'));
		this._container.appendChild(this._tabBar);

		// ── View containers ──
		this._boardContainer = DOM.$('div.task-overview-board');
		this._boardContainer.style.flex = '1 1 0';
		this._boardContainer.style.minHeight = '0';
		this._boardContainer.style.position = 'relative';
		this._boardContainer.style.overflow = 'hidden';
		this._container.appendChild(this._boardContainer);

		this._scheduleContainer = DOM.$('div.task-overview-schedule');
		this._scheduleContainer.style.flex = '1 1 0';
		this._scheduleContainer.style.minHeight = '0';
		this._scheduleContainer.style.position = 'relative';
		this._scheduleContainer.style.overflow = 'hidden';
		this._scheduleContainer.style.display = 'none';
		this._container.appendChild(this._scheduleContainer);
	}

	private _switchView(view: 'board' | 'schedule'): void {
		if (this._activeView === view) { return; }
		this._activeView = view;
		if (this._boardContainer) { this._boardContainer.style.display = view === 'board' ? '' : 'none'; }
		if (this._scheduleContainer) { this._scheduleContainer.style.display = view === 'schedule' ? '' : 'none'; }
		this._boardTabBtn?.classList.toggle('active', view === 'board');
		this._scheduleTabBtn?.classList.toggle('active', view === 'schedule');

		if (view === 'schedule') {
			void this._refreshSchedule();
			// Tick countdowns every 30s while visible.
			if (!this._scheduleTicker) {
				this._scheduleTicker = setInterval(() => {
					if (this._activeView === 'schedule') { void this._refreshSchedule(); }
				}, 30000);
			}
		} else if (this._scheduleTicker) {
			clearInterval(this._scheduleTicker);
			this._scheduleTicker = null;
		}
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		// First time initialization
		if (!this._isInitialized) {
			this._isInitialized = true;
			this._initialize(input);
		} else {
			// Refresh data when re-opened
			void this._refresh();
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override clearInput(): void {
		super.clearInput();
	}

	override dispose(): void {
		if (this._refreshRafId !== null) {
			cancelAnimationFrame(this._refreshRafId);
			this._refreshRafId = null;
		}
		if (this._scheduleTicker) {
			clearInterval(this._scheduleTicker);
			this._scheduleTicker = null;
		}
		this._renderer?.dispose();
		this._renderer = undefined;
		this._scheduleRenderer?.dispose();
		this._scheduleRenderer = undefined;
		this._boardContainer = undefined;
		this._scheduleContainer = undefined;
		this._container = undefined;
		super.dispose();
	}

	// ─── Initialization ─────────────────────────────────────────────────

	private _initialize(_input: EditorInput): void {
		if (!this._container || !this._boardContainer || !this._scheduleContainer) { return; }

		// Create renderer
		this._renderer = new TaskBoardNativeRenderer();
		this._renderer.create(this._boardContainer);

		// Create schedule view renderer (Plan D)
		this._scheduleRenderer = new ScheduleViewRenderer();
		this._scheduleRenderer.create(this._scheduleContainer);
		this._wireScheduleEvents();

		// Subscribe to renderer events
		this._register(this._renderer.onStatusChange(({ taskId, status, source }) => {
			const t0 = performance.now();
			console.info(`[PerfDiag] 🟠 PANE onStatusChange START taskId=${taskId} status=${status} t=${t0.toFixed(0)}ms`);
			// Optimistic DOM move already applied in drop handler — skip the
			// full _refresh() to avoid flash where card disappears & reappears.
			this._suppressNextBoardRefresh = true;
			// When transitioning to Running, open/focus the agent's chat in
			// the Agent Studio area AFTER the status update completes
			// (assignee is resolved in Phase 2, so we must await it).
			const isRunning = status === TaskBoardStatus.Running;
			// When a running task is dragged to another column (e.g. todo),
			// cancel the active agent execution so the task actually stops.
			if (status !== TaskBoardStatus.Running) {
				void (async () => {
					const task = await this._taskBoardService.getTask(taskId);
					if (task?.assigneeId) {
						this._agentChatService.cancelStream(task.assigneeId);
						console.info(`[PerfDiag] 🟠 PANE onStatusChange cancelled agent stream for ${task.assigneeId} (task ${taskId} → ${status})`);
					}
				})();
			}
			void (async () => {
				const updated = await this._taskBoardService.updateTaskStatus(taskId, status);
				if (isRunning && updated?.assigneeId) {
					void this._handleChatJump(
						updated.assigneeId,
						updated.assigneeName || updated.assigneeId,
						updated.workspaceId,
						updated.worktreePath,
					);
				}
			})();
		}));

		this._register(this._renderer.onDelete(({ taskId, source }) => {
			this._taskBoardService.deleteTask(taskId);
		}));

		this._register(this._renderer.onArchive(({ taskId, source }) => {
			this._taskBoardService.archiveTask(taskId);
		}));

		this._register(this._renderer.onCreateRequest(() => {
			void this._handleCreateTask();
		}));

		this._register(this._renderer.onDiagnosticsRequest((e) => {
			void this._handleRunDiagnostics();
		}));

		this._register(this._renderer.onTaskOpen(({ taskId, taskTitle }) => {
			// Legacy: open in TaskDetailEditor (kept for programmatic triggers)
			const input = TaskDetailEditorInput.getOrCreate(taskId, taskTitle || 'Task');
			void this._editorService.openEditor(input, { pinned: false });
		}));

		this._register(this._renderer.onTaskDetailRequest(({ task, employees, allTasks }) => {
			const t0 = performance.now();
			console.info(`[PerfDiag] 🟡 PANE onTaskDetailRequest START taskId=${task.id} t=${t0.toFixed(0)}ms`);
			void this._handleTaskDetail(task, employees, allTasks);
		}));

		this._register(this._renderer.onBoardFilterChange((wsId) => {
			this._boardFilterWsId = wsId;
			void this._refresh();
		}));

		this._register(this._renderer.onFilterChange((filter) => {
			this._employeeFilter = filter.employeeFilter;
			this._hiddenColumnKeys = filter.hiddenColumnKeys;
			void this._refresh();
		}));

		this._register(this._renderer.onChatJump(({ agentId, agentName, workspaceId, worktreePath }) => {
			void this._handleChatJump(agentId, agentName, workspaceId, worktreePath);
		}));

		// Card "⏰ 定时" button → open schedule config for that task (Plan D).
		this._register(this._renderer.onScheduleRequest(({ taskId }) => {
			void this._handleScheduleForTask(taskId);
		}));

		this._register(this._renderer.onSwarmCancel((swarmId) => {
			this._swarmService.cancelSwarm(swarmId);
		}));

		this._register(this._renderer.onTaskCancel(({ taskId, assigneeId }) => {
			// Cancel the agent's active stream (stops LLM generation)
			if (assigneeId) {
				this._agentChatService.cancelStream(assigneeId);
				console.info(`[PerfDiag] 🟠 onTaskCancel: cancelled stream for agent=${assigneeId} task=${taskId}`);
			}
			// Update task status to cancelled
			void this._taskBoardService.updateTaskStatus(taskId, TaskBoardStatus.Cancelled);
		}));

		// Board hyperlink (看板超链接) events
		this._register(this._renderer.onAddBoardLinkRequest(() => {
			void this._handleAddBoardLink();
		}));
		this._register(this._renderer.onOpenBoardLink(({ linkId }) => {
			void this._handleOpenBoardLink(linkId);
		}));
		this._register(this._renderer.onEditBoardLink(({ linkId, name, url }) => {
			void this._handleEditBoardLink(linkId, name, url);
		}));
		this._register(this._renderer.onDeleteBoardLink(({ linkId }) => {
			void this._handleDeleteBoardLink(linkId);
		}));

		// Subscribe to service events for automatic refresh
		this._register(this._taskBoardService.onDidChangeTaskBoard(() => {
			// Drag-triggered status changes do optimistic DOM movement in the
			// drop handler — skip the full _refresh() to avoid visual flash.
			if (this._suppressNextBoardRefresh) {
				this._suppressNextBoardRefresh = false;
				console.info('[PerfDiag] 🟠 onDidChangeTaskBoard SKIP (drag suppression), data already synced');
				return;
			}
			this._scheduleRefresh();
		}));

		this._register(this._taskBoardService.onDidChangeBoards(() => {
			this._scheduleRefresh();
		}));

		this._register(this._taskBoardService.onDidChangeBoardLinks(() => {
			this._scheduleRefresh();
		}));

		this._register(this._taskOrchestrationService.onDidFocusTask(async (taskTitle: string) => {
			const tasks = await this._getFilteredTasks();
			const task = tasks.find(t => t.title === taskTitle);
			if (task) {
				this._focusedTaskId = task.id;
				void this._refresh();
				setTimeout(() => {
					const el = this._container?.querySelector(`[data-task-id="${task.id}"]`);
					el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
				}, 100);
			}
		}));

		this._register(this._swarmService.onDidUpdateSwarm(() => {
			void this._refreshSwarms();
		}));

		// Load initial data
		void this._refresh();
	}

	// ─── Data Loading ───────────────────────────────────────────────────

	/**
	 * Coalesce multiple board-change notifications into a single _refresh()
	 * within one animation frame (~16ms).  onDidChangeTaskBoard can fire 2-3×
	 * for a single user action (e.g. updateTask fires immediately, then again
	 * after ensureTaskAgent ~1s later).  Without coalescing, each fire starts
	 * an overlapping async _refresh() → render(), causing redundant DOM rebuilds
	 * and layout thrashing (P2-12 fix).
	 */
	private _scheduleRefresh(): void {
		if (this._refreshRafId !== null) {
			// Already scheduled — this fire will be covered by the pending rAF.
			return;
		}
		this._refreshRafId = requestAnimationFrame(() => {
			this._refreshRafId = null;
			this._doRefresh();
		});
	}

	/**
	 * Execute _refresh() with an in-flight guard.  If a refresh is already
	 * running when another is requested, we queue one more and run it after
	 * the current one finishes — this ensures the latest data is always
	 * rendered without overlapping concurrent refreshes.
	 */
	private async _doRefresh(): Promise<void> {
		if (this._isRefreshing) {
			this._refreshQueued = true;
			return;
		}
		this._isRefreshing = true;
		try {
			await this._refresh();
		} finally {
			this._isRefreshing = false;
			if (this._refreshQueued) {
				this._refreshQueued = false;
				void this._doRefresh();
			}
		}
	}

	private async _refresh(): Promise<void> {
		if (!this._renderer || !this._container) { return; }

		try {
			// Parallelize all data loading — previously 4 sequential awaits
			// each involving disk I/O (getAgents does dir resolve + N file reads,
			// getTasks reads taskboard.json, getWorkspaces reads workspaces.json,
			// listBoardLinks reads boardLinks.json). Sequential = 2-4s total;
			// parallel = max of any single call (~1s).
			const wsId = this._boardFilterWsId === 'all' ? undefined : this._boardFilterWsId;

			const agentsPromise = this._allEmployees.length === 0
				? this._agentStudioService.getAgents()
					.then(agents => agents.map(e => ({ id: e.id, name: e.name, icon: e.icon })))
					.catch(() => [] as EmployeeInfo[])
				: Promise.resolve(this._allEmployees);

			const [agents, tasks, workspaces, boardLinks] = await Promise.all([
				agentsPromise,
				this._taskBoardService.getTasks(wsId),
				this._agentStudioService.getWorkspaces(),
				this._taskBoardService.listBoardLinks(),
			]);

			if (this._allEmployees.length === 0) {
				this._allEmployees = agents;
			}

			// Load swarms (in-memory, no disk I/O)
			let swarms: SwarmInfo[] = [];
			try {
				const activeWsId = this._agentStudioService.getActiveWorkspaceId() || undefined;
				const swarmMap = this._swarmService.listSwarms(activeWsId);
				swarms = Object.values(swarmMap)
					.filter((s: any) => !activeWsId || !s.workspaceId || s.workspaceId === activeWsId)
					.sort((a: any, b: any) => b.createdAt - a.createdAt)
					.map((s: any) => ({
						swarmId: s.swarmId,
						title: s.title,
						phase: s.phase,
						isActive: s.phase !== 'done' && s.phase !== 'cancelled' && s.phase !== 'failed' && s.phase !== 'interrupted',
						totalWorkers: (s.workers?.length ?? 0) + (s.verifier ? 1 : 0) + (s.synthesizer ? 1 : 0),
						doneWorkers: (s.workers?.filter((w: any) => w.status === 'done').length ?? 0) +
							(s.verifier?.status === 'done' ? 1 : 0) + (s.synthesizer?.status === 'done' ? 1 : 0),
					}));
			} catch {
				// Swarms not loaded yet
			}

		const filter: TaskBoardFilter = {
			boardFilterWsId: this._boardFilterWsId,
			employeeFilter: this._employeeFilter,
			hiddenColumnKeys: this._hiddenColumnKeys,
		};

		// Build the taskId → compact schedule-label map for card badges (Plan D).
		const scheduleByTaskId = new Map<string, string>();
		try {
			for (const rule of this._schedulerService.listAllSchedules(this._currentWorkspaceId())) {
				if (rule.state !== ScheduleState.Active) { continue; }
				const tid = this._scheduleTaskId(rule);
				if (tid) { scheduleByTaskId.set(tid, this._compactScheduleLabel(rule)); }
			}
		} catch { /* non-fatal */ }

		const renderData: TaskBoardRenderData = {
				tasks,
				employees: this._allEmployees,
				workspaces: workspaces.map(w => ({ id: w.id, name: w.name })),
				swarms,
				filter,
				isLoading: false,
				collapsed: false,
				draggingTaskId: null,
				dragOverColumn: null,
			focusedTaskId: this._focusedTaskId,
			boardLinks,
			scheduleByTaskId,
		};

			this._renderer.render(renderData);

			// Update the task-board tab badge (non-archived task count).
			if (this._boardTabBadge) {
				const visibleCount = tasks.filter(t => t.status !== ('archived' as TaskBoardStatus)).length;
				this._boardTabBadge.textContent = String(visibleCount);
			}
			this._updateScheduleBadge();

			// Clear focus after render
			this._focusedTaskId = null;

		} catch (err) {
			this._logService.error('[TaskOverviewEditorPane] Failed to refresh:', err);
			if (this._container) {
				DOM.clearNode(this._container);
				const errorEl = DOM.$('div');
				errorEl.style.padding = '20px';
				errorEl.style.color = 'var(--vscode-errorForeground, #f48771)';
				errorEl.textContent = `任务看板加载失败: ${err instanceof Error ? err.message : String(err)}`;
				this._container.appendChild(errorEl);
			}
		}
	}

	private async _refreshSwarms(): Promise<void> {
		if (!this._renderer) { return; }
		try {
			const activeWsId = this._agentStudioService.getActiveWorkspaceId() || undefined;
			const swarmMap = this._swarmService.listSwarms(activeWsId);
			const swarms: SwarmInfo[] = Object.values(swarmMap)
				.filter((s: any) => !activeWsId || !s.workspaceId || s.workspaceId === activeWsId)
				.sort((a: any, b: any) => b.createdAt - a.createdAt)
				.map((s: any) => ({
					swarmId: s.swarmId,
					title: s.title,
					phase: s.phase,
					isActive: s.phase !== 'done' && s.phase !== 'cancelled' && s.phase !== 'failed' && s.phase !== 'interrupted',
					totalWorkers: (s.workers?.length ?? 0) + (s.verifier ? 1 : 0) + (s.synthesizer ? 1 : 0),
					doneWorkers: (s.workers?.filter((w: any) => w.status === 'done').length ?? 0) +
						(s.verifier?.status === 'done' ? 1 : 0) + (s.synthesizer?.status === 'done' ? 1 : 0),
				}));
			this._renderer.updateSwarmBar(swarms);
		} catch {
			// Ignore swarm refresh errors
		}
	}

	private async _getFilteredTasks(): Promise<TaskBoardRecord[]> {
		const wsId = this._boardFilterWsId === 'all' ? undefined : this._boardFilterWsId;
		return await this._taskBoardService.getTasks(wsId);
	}

	// ─── Create Task ────────────────────────────────────────────────────

	private async _handleCreateTask(): Promise<void> {
		if (!this._renderer || !this._container) { return; }

		const allTasks = await this._getFilteredTasks();
		const workspaces = await this._agentStudioService.getWorkspaces();
		const activeWsId = this._agentStudioService.getActiveWorkspaceId() || '';
		const boardWsId = this._boardFilterWsId === 'all' ? activeWsId : this._boardFilterWsId;

		const result = await this._renderer.showCreateTaskModal(
			this._container,
			this._allEmployees,
			allTasks,
			workspaces.map(w => ({ id: w.id, name: w.name })),
			boardWsId,
			async (wsId: string) => {
				try {
					const raw = await this._agentStudioService.getWorktrees(wsId);
					return raw.map((wt: any) => ({
						path: wt.path,
						branch: wt.branch || wt.name || 'HEAD',
						repoRoot: wt.repoRoot,
						repoName: wt.repoName,
					}));
				} catch {
					return [];
				}
			},
			async (agentId: string) => {
				try {
					const sessions = await this._agentChatService.listAgentSessions(agentId);
					return sessions.map(s => ({ id: s.id, name: s.name, messageCount: (s as any).messageCount ?? 0, updatedAt: (s as any).updatedAt ?? '' }));
				} catch {
					return [];
				}
			},
		);

		if (!result) { return; }

		// Rename selected session if user edited the title (sync back to source data)
		if (result.agentSessionId && result.agentSessionName && result.assigneeId) {
			try {
				const sessions = await this._agentChatService.listAgentSessions(result.assigneeId);
				const target = sessions.find(s => s.id === result.agentSessionId);
				if (target && target.name !== result.agentSessionName) {
					await this._agentChatService.renameAgentSession(result.assigneeId, result.agentSessionId, result.agentSessionName!);
				}
			} catch {
				// Rename is optional, continue
			}
		}

		const wsId = result.workspaceId || boardWsId;
		const tCreate = performance.now();

		const created = await this._taskBoardService.createTask({
			title: result.title,
			description: result.description,
			assigneeId: result.assigneeId,
			assigneeName: result.assigneeName,
			priority: result.priority,
			dependencies: result.dependencies,
			status: 'todo' as TaskBoardStatus,
			source: 'manual' as TaskSource,
			workspaceId: wsId,
			worktreePath: result.worktreePath,
		} as any);

		console.info(`[TaskPerfDiag] _handleCreateTask: createTask returned elapsed=${(performance.now() - tCreate).toFixed(0)}ms`);

		// Upload attachments from rich description editor
		if (result.attachments && result.attachments.length > 0) {
			for (const att of result.attachments) {
				try {
					await this._taskBoardService.addAttachment(created.id, att.name, att.mimeType, att.base64Content);
				} catch {
					// Attachment upload is best-effort
				}
			}
		}

		// "仅创建"：创建后不自动执行（也不入队），直接返回。
		if (result.execute === false) {
			this._logService.info(`[TaskOverviewEditorPane] Task ${created.id} created without auto-execution (仅创建)`);
			return;
		}

		// Check if the assignee agent already has running tasks — if so, queue this one.
		if (result.assigneeId) {
			const agentRunningTasks = allTasks.filter(t =>
				t.assigneeId === result.assigneeId &&
				(t.status === 'running' as TaskBoardStatus || t.status === 'blocked' as TaskBoardStatus)
			);
			if (agentRunningTasks.length > 0) {
				// Queue: don't auto-start, just leave in 'todo'.
				// Auto-start when the agent's running task count drops to 0.
				const queue = this._queuedTasks.get(result.assigneeId) || [];
				queue.push(created.id);
				this._queuedTasks.set(result.assigneeId, queue);
				this._ensureQueueListener();
				this._logService.info(`[TaskOverviewEditorPane] Task ${created.id} queued for agent ${result.assigneeName || result.assigneeId} (${agentRunningTasks.length} running)`);
				return;
			}
		}

		// No running tasks for this agent — auto-start immediately.
		this._taskBoardService.updateTaskStatus(created.id, 'running' as TaskBoardStatus);
	}

	/** Ensure we listen for task board changes to auto-start queued tasks. */
	private _ensureQueueListener(): void {
		if (this._queueListenerDispose) { return; }
		this._queueListenerDispose = this._taskBoardService.onDidChangeTaskBoard(() => {
			void this._processQueuedTasks();
		});
		// Register cleanup
		this._register({ dispose: () => { this._queueListenerDispose?.dispose(); this._queueListenerDispose = null; } });
	}

	private async _processQueuedTasks(): Promise<void> {
		if (this._queuedTasks.size === 0) { return; }
		const tasks = await this._getAllTasksAsync();
		for (const [agentId, queuedIds] of this._queuedTasks.entries()) {
			if (queuedIds.length === 0) {
				this._queuedTasks.delete(agentId);
				continue;
			}
			const hasRunning = tasks.some(t =>
				t.assigneeId === agentId &&
				(t.status === ('running' as TaskBoardStatus) || t.status === ('blocked' as TaskBoardStatus))
			);
			if (!hasRunning && queuedIds.length > 0) {
				const nextTaskId = queuedIds.shift()!;
				this._taskBoardService.updateTaskStatus(nextTaskId, 'running' as TaskBoardStatus);
				this._logService.info(`[TaskOverviewEditorPane] Auto-starting queued task ${nextTaskId} for agent ${agentId}`);
				if (queuedIds.length === 0) {
					this._queuedTasks.delete(agentId);
				}
			}
		}
	}

	/** Async task fetch (no filter) for queue listener use. */
	private async _getAllTasksAsync(): Promise<TaskBoardRecord[]> {
		try {
			const wsId = this._boardFilterWsId === 'all' ? undefined : this._boardFilterWsId;
			return await this._taskBoardService.getTasks(wsId);
		} catch {
			return [];
		}
	}

	// ─── Task Detail ────────────────────────────────────────────────────

	private async _handleTaskDetail(
		task: TaskBoardRecord,
		employees: EmployeeInfo[],
		allTasks: TaskBoardRecord[],
	): Promise<void> {
		if (!this._renderer || !this._container) { return; }

		// Load workspaces for the workspace selector dropdown
		let workspaces: { id: string; name: string }[] = [];
		try {
			const wsList = await this._agentStudioService.getWorkspaces();
			workspaces = wsList.map(w => ({ id: w.id, name: w.name }));
		} catch { /* no workspaces — selector will be hidden */ }

		// Resolve workspace root for attachment path resolution
		let workspaceRoot: string | undefined;
		try {
			const activeId = this._agentStudioService.getActiveWorkspaceId();
			if (activeId) {
				const ws = await this._agentStudioService.getWorkspace(activeId);
				if (ws?.path) { workspaceRoot = ws.path; }
			}
		} catch { /* non-fatal */ }

		const result = await this._renderer.showTaskDetailModal(
			this._container,
			task,
			employees,
			allTasks,
			{
				workspaces,
				loadWorktrees: async (wsId: string) => {
					try {
						const raw = await this._agentStudioService.getWorktrees(wsId);
						return raw.map((wt: any) => ({
							path: wt.path,
							branch: wt.branch || wt.name || 'HEAD',
							repoRoot: wt.repoRoot,
							repoName: wt.repoName,
						}));
					} catch { return []; }
				},
				downloadUrl: (url: string) => this._taskBoardService.downloadUrlToTemp(url),
				workspaceRoot,
				openFile: (path: string) => {
					try {
						const fileUri = URI.isUri(path) ? path : URI.file(path);
						this._openerService.open(fileUri, { openExternal: true });
					} catch { /* invalid path — ignore */ }
				},
				providers: this._buildProviderModelList(),
			},
		);

		switch (result.action) {
			case 'statusChange':
				if (result.status && result.status !== task.status) {
					this._taskBoardService.updateTaskStatus(result.taskId, result.status);
				}
				break;
			case 'delete':
				this._taskBoardService.deleteTask(result.taskId);
				break;
			case 'archive':
				this._taskBoardService.archiveTask(result.taskId);
				break;
			case 'block':
				this._taskBoardService.updateTask(result.taskId, { status: 'blocked' as TaskBoardStatus } as any);
				break;
		case 'unblock':
			this._taskBoardService.updateTask(result.taskId, { status: 'todo' as TaskBoardStatus } as any);
			break;
		case 'edit': {
			const patch: Record<string, unknown> = {
				title: result.title,
				description: result.description,
				assigneeId: result.assigneeId,
				assigneeName: result.assigneeName,
				priority: result.priority,
				dependencies: result.dependencies,
				status: result.status,
			};
			// Include workspace/worktree only if user changed them from the defaults
			if (result.workspaceId !== undefined) { patch.workspaceId = result.workspaceId; }
			if (result.worktreePath !== undefined) { patch.worktreePath = result.worktreePath; }
			if (result.url !== undefined) { patch.url = result.url; }
			if (result.providerId !== undefined) { patch.providerId = result.providerId; }
			if (result.modelId !== undefined) { patch.modelId = result.modelId; }
			this._taskBoardService.updateTask(result.taskId, patch as any);
			break;
		}
	}
		// Refresh is automatic via onDidChangeTaskBoard event
	}

	/**
	 * Build a flat {provider → [models]} list for the task editor's
	 * provider/model selectors.  Uses ILanguageModelsService to query
	 * registered vendors and their model metadata.
	 */
	private _buildProviderModelList(): { id: string; name: string; icon?: string; models: { id: string; name: string }[] }[] {
		// Return cached list if available — provider/model registry rarely changes
		// during a session, so we avoid re-traversing all vendors on every modal open.
		if (this._providerListCache) { return this._providerListCache; }
		const vendors = this._lmService.getVendors();
		const result = vendors.map(v => {
			const vendorId = v.vendor;
			const modelIds = this._lmService.getLanguageModelIds().filter(mid =>
				mid.startsWith(vendorId + '/')
			);
			const models: { id: string; name: string }[] = [];
			for (const mid of modelIds) {
				const meta = this._lmService.lookupLanguageModel(mid);
				const bareId = mid.slice(vendorId.length + 1);
				models.push({
					id: bareId,
					name: meta?.name ?? bareId,
				});
			}
			return {
				id: vendorId,
				name: v.displayName ?? vendorId,
				icon: (v as any).icon,
				models,
			};
		});
		this._providerListCache = result;
		// Invalidate cache when language models change (provider added/removed)
		this._register(this._lmService.onDidChangeLanguageModels(() => {
			this._providerListCache = undefined;
		}));
		return result;
	}

	// ─── Chat Jump ──────────────────────────────────────────────────────

	private async _handleChatJump(agentId: string, agentName: string, workspaceId?: string, worktreePath?: string): Promise<void> {
		// Sync worktree binding first, so the chat pane picks it up when loading worktrees.
		if (workspaceId && worktreePath) {
			try {
				await this._agentStudioService.upsertAgentBinding(workspaceId, agentId, {
					worktreePath,
				} as any);
			} catch {
				// worktree binding is optional, continue
			}
		}

		// Get the Agent Studio editor part (right column).  Opens into the
		// Agent Studio area instead of the file editor area — the click on a
		// task card's 💬 button should focus/start the agent conversation
		// in the dedicated Agent Studio panel.
		const agentPart = (this._editorGroupsService as unknown as { agentPart?: IEditorGroupsService }).agentPart;
		const searchGroups = agentPart
			? agentPart.getGroups(GroupsOrder.CREATION_TIME)
			: this._editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);

		// 1. Find existing chat tab for this agent (prefer agentPart)
		for (const group of searchGroups) {
			for (const editor of group.editors) {
				const ed = editor as any;
				if ((ed.typeId === 'workbench.editors.nativeChatInput' || ed.typeId === 'workbench.editor.nativeChat') && ed.agentId === agentId) {
					// Found — focus the tab
					await group.openEditor(editor, { pinned: true });
					// Ensure the Agent Studio part is visible
					// Force layout to show the agent part in case it was hidden
					try {
						const { Parts } = await import('../../../../workbench/services/layout/browser/layoutService.js');
						const layoutService = (this as any)._layoutService;
						if (layoutService) {
							layoutService.setPartHidden(false, Parts.AGENT_EDITOR_PART);
						}
					} catch { /* best-effort */ }
					for (const pane of this._editorService.visibleEditorPanes) {
						if ((pane as any).input === editor) {
							// Sync worktree to chat panel UI
							if (worktreePath) {
								(pane as any)._chatPanel?.setSelectedWorktree?.(worktreePath);
							}
							(pane as any).focusInput?.();
							return;
						}
					}
					return;
				}
			}
		}

		// 2. Not found — create a new chat tab in the Agent Studio area.
		try {
			const { NativeChatEditorInput } = await import('./nativeChatEditorInput.js');
			const input = NativeChatEditorInput.create(undefined, agentId, undefined, agentName);

			// Open in agent part if available; fall back to editorService.
			if (agentPart?.activeGroup) {
				// Ensure the Agent Studio part is visible
				try {
					const { Parts } = await import('../../../../workbench/services/layout/browser/layoutService.js');
					const layoutService = (this as any)._layoutService;
					if (layoutService) {
						layoutService.setPartHidden(false, Parts.AGENT_EDITOR_PART);
					}
				} catch { /* best-effort */ }
				await agentPart.activeGroup.openEditor(input, { pinned: true });
			} else {
				await this._editorService.openEditor(input, { pinned: true });
			}
		} catch (err) {
			this._logService.error('[TaskOverviewEditorPane] Failed to open chat for agent:', err);
		}
	}

	// ─── Board Hyperlinks (看板超链接) ─────────────────────────────────

	private async _handleAddBoardLink(): Promise<void> {
		if (!this._renderer || !this._container) { return; }
		this._renderer.showAddBoardLinkModal(this._container, async (name, url) => {
			await this._taskBoardService.addBoardLink(name, url);
			// Refresh is automatic via onDidChangeBoardLinks event.
		});
	}

	private async _handleOpenBoardLink(linkId: string): Promise<void> {
		const links = await this._taskBoardService.listBoardLinks();
		const link = links.find(l => l.id === linkId);
		if (!link) { return; }

		this._logService.info(`[TaskOverviewEditorPane] _handleOpenBoardLink: id=${linkId}, name="${link.name}", url="${link.url}" (len=${link.url.length})`);

		// Use the native Integrated Browser (Electron WebContentsView) instead of
		// the sandboxed webview. This avoids CSP/sandbox restrictions and allows
		// sites like TAPD to do OAuth login normally. Each board link gets a
		// stable view ID derived from the link ID so the same link reuses one tab.
		const browserViewId = `board-link-${linkId}`;
		const input = this._browserViewWorkbenchService.getOrCreateLazy(browserViewId, {
			url: link.url,
			title: link.name,
		});

		this._logService.info(`[TaskOverviewEditorPane] BrowserEditorInput created: id=${browserViewId}, name="${input.getName()}", title="${input.getTitle()}", hasModel=${!!input.model}`);

		// Navigate to the latest URL in case the link was edited since last open.
		input.navigate(link.url);

		this._logService.info(`[TaskOverviewEditorPane] After navigate: name="${input.getName()}", title="${input.getTitle()}"`);

		// Open in the center editor area (groups[0]).
		const groups = this._editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
		const targetGroup = groups[0];
		await this._editorService.openEditor(input, { pinned: true }, targetGroup);
	}

	private async _handleDeleteBoardLink(linkId: string): Promise<void> {
		await this._taskBoardService.removeBoardLink(linkId);
	}

	private async _handleEditBoardLink(linkId: string, name: string, url: string): Promise<void> {
		if (!this._renderer || !this._container) { return; }
		// Reuse the add-link modal structure for editing, pre-filled with current values.
		this._renderer.showEditBoardLinkModal(this._container, { linkId, name, url }, async (newName, newUrl) => {
			await this._taskBoardService.updateBoardLink(linkId, newName, newUrl);
		});
	}

	// ─── Schedule (定时任务) — Plan D ────────────────────────────────────

	/** Wire schedule-renderer UI events and the scheduler-service events. */
	private _wireScheduleEvents(): void {
		if (!this._scheduleRenderer) { return; }

		// Renderer → CRUD
		this._register(this._scheduleRenderer.onCreateRequest(() => {
			void this._handleCreateSchedule();
		}));
		this._register(this._scheduleRenderer.onEditRequest(({ ruleId }) => {
			void this._handleEditSchedule(ruleId);
		}));
		this._register(this._scheduleRenderer.onDeleteRequest(({ ruleId }) => {
			this._schedulerService.removeSchedule(ruleId);
		}));
		this._register(this._scheduleRenderer.onToggleRequest(({ ruleId }) => {
			const rule = this._schedulerService.listAllSchedules(this._currentWorkspaceId()).find(r => r.id === ruleId);
			if (!rule) { return; }
			if (rule.state === ScheduleState.Active) {
				this._schedulerService.pauseSchedule(ruleId);
			} else if (rule.state === ScheduleState.Paused) {
				this._schedulerService.resumeSchedule(ruleId);
			}
		}));

		// Scheduler service → refresh view + tab badge
		this._register(this._schedulerService.onDidScheduleChange(() => {
			this._updateScheduleBadge();
			if (this._activeView === 'schedule') {
				// Schedule view is visible → re-render its table (incl. countdowns).
				void this._refreshSchedule();
			} else {
				// Board view is visible → re-render so task-card ⏰ badges stay
				// in sync with create/delete/pause of schedules.
				void this._refresh();
			}
		}));

		// Scheduler fired → drive task execution (move task to running).
		this._register(this._schedulerService.onDidTrigger((event) => {
			void this._handleScheduleFired(event);
		}));
	}

	/** When a schedule fires, start the associated task (set to running). */
	private async _handleScheduleFired(event: IScheduleTriggerEvent): Promise<void> {
		try {
			const taskId = event.input.context?.taskId as string | undefined;
			if (!taskId) {
				this._logService.info(`[TaskOverviewEditorPane] schedule ${event.scheduleName} fired but no taskId in context`);
				return;
			}
			const task = await this._taskBoardService.getTask(taskId);
			if (!task) {
				this._logService.warn(`[TaskOverviewEditorPane] schedule fired but task ${taskId} not found`);
				return;
			}
			// Only (re)start when it's not already running/blocked.
			if (task.status === ('running' as TaskBoardStatus) || task.status === ('blocked' as TaskBoardStatus)) {
				this._logService.info(`[TaskOverviewEditorPane] schedule fired but task ${taskId} already ${task.status}; skipping`);
				return;
			}
			this._logService.info(`[TaskOverviewEditorPane] schedule ${event.scheduleName} fired → starting task ${taskId}`);
			await this._taskBoardService.updateTaskStatus(taskId, 'running' as TaskBoardStatus);
		} catch (err) {
			this._logService.error('[TaskOverviewEditorPane] Failed to handle fired schedule:', err);
		}
	}

	/** Refresh the schedule table from the scheduler service + task list. */
	private async _refreshSchedule(): Promise<void> {
		if (!this._scheduleRenderer) { return; }
		try {
			const rules = this._schedulerService.listAllSchedules(this._currentWorkspaceId())
				.slice()
				.sort((a, b) => (a.nextFireAt ?? Infinity) - (b.nextFireAt ?? Infinity));
			const tasks = await this._getAllTasksAsync();
			this._scheduleRenderer.render(rules, tasks);
		} catch (err) {
			this._logService.error('[TaskOverviewEditorPane] Failed to refresh schedule view:', err);
		}
	}

	/** A compact human label for a rule, used on task-card schedule badges. */
	private _compactScheduleLabel(rule: IScheduleInfo): string {
		switch (rule.type) {
			case 'cron': {
				const expr = (rule.config as ICronScheduleConfig).cronExpression;
				return expr || 'Cron';
			}
			case 'interval': {
				const ms = (rule.config as IIntervalConfig).intervalMs || 0;
				if (ms >= 86400000) { return `每 ${Math.round(ms / 86400000)} 天`; }
				if (ms >= 3600000) { return `每 ${Math.round(ms / 3600000)} 小时`; }
				if (ms >= 60000) { return `每 ${Math.round(ms / 60000)} 分钟`; }
				return `每 ${Math.round(ms / 1000)} 秒`;
			}
			case 'one-shot': {
				const at = (rule.config as IOneShotConfig).triggerAt;
				return at ? new Date(at).toLocaleString() : '一次性';
			}
			case 'file-watch': return '文件监听';
			case 'event': return '事件触发';
			default: return '定时';
		}
	}

	/** Update the "定时任务" tab badge with the active-rule count. */
	private _updateScheduleBadge(): void {
		if (!this._scheduleTabBadge) { return; }
		try {
			const active = this._schedulerService.listAllSchedules(this._currentWorkspaceId()).filter(r => r.state === ScheduleState.Active).length;
			this._scheduleTabBadge.textContent = String(active);
		} catch { /* non-fatal */ }
	}

	private async _handleCreateSchedule(): Promise<void> {
		if (!this._scheduleRenderer || !this._container) { return; }
		const tasks = await this._getAllTasksAsync();
		this._scheduleRenderer.showScheduleModal(this._container, tasks, async (draft) => {
			await this._applyScheduleDraft(draft, tasks);
		});
	}

	private async _handleEditSchedule(ruleId: string): Promise<void> {
		if (!this._scheduleRenderer || !this._container) { return; }
		const rule = this._schedulerService.listAllSchedules(this._currentWorkspaceId()).find(r => r.id === ruleId);
		if (!rule) { return; }
		const tasks = await this._getAllTasksAsync();
		const prefill = this._toPrefill(rule);
		this._scheduleRenderer.showScheduleModal(this._container, tasks, async (draft) => {
			await this._applyScheduleDraft(draft, tasks);
		}, prefill);
	}

	/** Open the schedule modal from a task card — edits an existing rule for
	 *  the task if one exists, otherwise creates a new one pre-bound to it. */
	private async _handleScheduleForTask(taskId: string): Promise<void> {
		if (!this._scheduleRenderer || !this._container) { return; }
		const tasks = await this._getAllTasksAsync();
		const existing = this._schedulerService.listAllSchedules(this._currentWorkspaceId())
			.find(r => this._scheduleTaskId(r) === taskId);
		if (existing) {
			const prefill = this._toPrefill(existing);
			this._scheduleRenderer.showScheduleModal(this._container, tasks, async (draft) => {
				await this._applyScheduleDraft(draft, tasks);
			}, prefill);
		} else {
			// Pre-bind the modal to this task by passing only that task in the list.
			const target = tasks.find(t => t.id === taskId);
			const list = target ? [target, ...tasks.filter(t => t.id !== taskId)] : tasks;
			this._scheduleRenderer.showScheduleModal(this._container, list, async (draft) => {
				await this._applyScheduleDraft(draft, tasks);
			}, undefined, taskId);
		}
	}

	/** Read the task id stored inside a schedule's input-template context. */
	private _scheduleTaskId(rule: IScheduleInfo): string | undefined {
		const tpl = (rule.config as { inputTemplate?: IScheduleInput }).inputTemplate;
		return tpl?.context?.taskId as string | undefined;
	}

	/** Build a ScheduleEditPrefill from an existing schedule record. */
	private _toPrefill(rule: IScheduleInfo): ScheduleEditPrefill {
		const taskId = this._scheduleTaskId(rule) ?? '';
		const maxRetries = (rule.config as { executionPolicy?: { maxRetries?: number } }).executionPolicy?.maxRetries ?? 0;
		if (rule.type === 'cron') {
			return { id: rule.id, taskId, type: 'cron', cronExpression: (rule.config as ICronScheduleConfig).cronExpression, maxRetries };
		}
		if (rule.type === 'interval') {
			return { id: rule.id, taskId, type: 'interval', intervalMs: (rule.config as IIntervalConfig).intervalMs, maxRetries };
		}
		if (rule.type === 'one-shot') {
			return { id: rule.id, taskId, type: 'one-shot', triggerAt: (rule.config as IOneShotConfig).triggerAt, maxRetries };
		}
		// file-watch / event are not editable through the modal — default to cron.
		this._logService.warn(`[TaskOverviewEditorPane] editing ${rule.type} schedule via modal is unsupported; converting to cron`);
		return { id: rule.id, taskId, type: 'cron', cronExpression: '0 9 * * 1-5', maxRetries };
	}

	/** Apply a schedule draft: validate the task has an assignee, then (re-)register. */
	private async _applyScheduleDraft(draft: ScheduleDraft, tasks: TaskBoardRecord[]): Promise<void> {
		const task = tasks.find(t => t.id === draft.taskId);
		if (!task || !task.assigneeId) {
			this._logService.warn(`[TaskOverviewEditorPane] cannot schedule: task ${draft.taskId} has no assigned agent`);
			return;
		}
		// Editing: remove the old schedule, then (re-)register from the draft.
		if (draft.existingId) {
			this._schedulerService.removeSchedule(draft.existingId);
		}
		const inputTemplate: IScheduleInput = {
			messageTemplate: this._buildScheduleMessage(task),
			context: { taskId: task.id, workspaceId: task.workspaceId },
		};
		const executionPolicy = draft.maxRetries > 0
			? { overlap: OverlapPolicy.Skip, maxRetries: draft.maxRetries }
			: undefined;
		if (draft.type === 'cron') {
			this._schedulerService.registerCron({
				name: task.title,
				instanceId: task.assigneeId,
				cronExpression: draft.cronExpression || '0 9 * * 1-5',
				inputTemplate,
				enabled: true,
				executionPolicy,
			});
		} else if (draft.type === 'interval') {
			this._schedulerService.registerInterval({
				name: task.title,
				instanceId: task.assigneeId,
				intervalMs: draft.intervalMs || 3600000,
				inputTemplate,
				enabled: true,
				executionPolicy,
			});
		} else {
			this._schedulerService.registerOneShot({
				name: task.title,
				instanceId: task.assigneeId,
				triggerAt: draft.triggerAt || (Date.now() + 3600000),
				inputTemplate,
			});
		}
	}

	/** Build the message the agent receives when a scheduled task fires. */
	private _buildScheduleMessage(task: TaskBoardRecord): string {
		const desc = task.description ? `\n任务描述：${task.description}` : '';
		return `请开始执行以下定时任务：\n任务标题：${task.title}${desc}\n请在绑定的工作区中完成该任务，完成后更新任务状态。`;
	}

	/** Active workspace id for scheduler scoping (listAllSchedules currently returns all). */
	private _currentWorkspaceId(): string {
		return this._agentStudioService.getActiveWorkspaceId() || '';
	}

	// ─── Diagnostics ────────────────────────────────────────────────────

	private async _handleRunDiagnostics(): Promise<void> {
		try {
			const wsId = this._agentStudioService.getActiveWorkspaceId() || undefined;
			const results = await this._diagnosticsService.runDiagnostics(wsId);
			const count = (results as unknown as unknown[])?.length ?? 0;
			this._logService.info(`[TaskOverviewEditorPane] Diagnostics completed: ${count} issues found`);
		} catch (err) {
			this._logService.error('[TaskOverviewEditorPane] Diagnostics failed:', err);
		}
	}
}
