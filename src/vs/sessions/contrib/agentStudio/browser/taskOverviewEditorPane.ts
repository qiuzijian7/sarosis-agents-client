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
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import {
	IAgentTaskBoardService,
	IAgentStudioService,
	ITaskOrchestrationService,
} from '../common/agentStudio.js';
import { IKanbanDiagnosticsService } from '../common/kanbanDiagnosticsService.js';
import { ISwarmService } from '../common/swarmService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { TaskBoardNativeRenderer, type TaskBoardRenderData, type TaskBoardFilter, type EmployeeInfo, type SwarmInfo } from './taskBoardNativeRenderer.js';
import { TaskBoardStatus, TaskSource, type TaskBoardRecord } from '../../../common/agentStudioTypes.js';

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

	// Filter state
	private _boardFilterWsId = 'all';
	private _employeeFilter = 'all';
	private _hiddenColumnKeys = new Set<string>();
	private _focusedTaskId: string | null = null;

	// Cached employee info (loaded once)
	private _allEmployees: EmployeeInfo[] = [];

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
	) {
		super(TaskOverviewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.task-overview-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);
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
		this._renderer?.dispose();
		this._renderer = undefined;
		this._container = undefined;
		super.dispose();
	}

	// ─── Initialization ─────────────────────────────────────────────────

	private _initialize(_input: EditorInput): void {
		if (!this._container) { return; }

		// Create renderer
		this._renderer = new TaskBoardNativeRenderer();
		this._renderer.create(this._container);

		// Subscribe to renderer events
		this._register(this._renderer.onStatusChange(({ taskId, status, source }) => {
			this._taskBoardService.updateTaskStatus(taskId, status);
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

		this._register(this._renderer.onPlanRequest(() => {
			// Open orchestration plan dialog
			this._logService.info('[TaskOverviewEditorPane] Plan request — opening orchestration dialog');
			// TODO: open OrchestrationPlanModal equivalent
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

		this._register(this._renderer.onChatJump(({ agentId, agentName }) => {
			void this._handleChatJump(agentId, agentName);
		}));

		this._register(this._renderer.onSwarmCancel((swarmId) => {
			this._swarmService.cancelSwarm(swarmId);
		}));

		// Subscribe to service events for automatic refresh
		this._register(this._taskBoardService.onDidChangeTaskBoard(() => {
			void this._refresh();
		}));

		this._register(this._taskBoardService.onDidChangeBoards(() => {
			void this._refresh();
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

	private async _refresh(): Promise<void> {
		if (!this._renderer || !this._container) { return; }

		try {
			// Load agents (all, for assignee dropdown)
			if (this._allEmployees.length === 0) {
				try {
					const agents = await this._agentStudioService.getAgents();
					this._allEmployees = agents.map(e => ({ id: e.id, name: e.name }));
				} catch {
					this._allEmployees = [];
				}
			}

			// Load tasks
			const wsId = this._boardFilterWsId === 'all' ? undefined : this._boardFilterWsId;
			const tasks = await this._taskBoardService.getTasks(wsId);

			// Load workspaces
			const workspaces = await this._agentStudioService.getWorkspaces();

			// Load swarms
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
			};

			this._renderer.render(renderData);

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
		const result = await this._renderer.showCreateTaskModal(
			this._container,
			this._allEmployees,
			allTasks,
		);

		if (result) {
			const wsId = this._boardFilterWsId === 'all'
				? (this._agentStudioService.getActiveWorkspaceId() || undefined)
				: this._boardFilterWsId;

			// Create task in todo, then auto-start execution by transitioning to running.
			// updateTaskStatus → running triggers the Agent dispatch chain in AgentTaskBoardService:
			//   ensureTaskAgent() → assign agent   →   executeTaskForBoard() → agent picks up task
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
			} as any);
			// Auto-start: transition to running to trigger agent dispatch chain
			this._taskBoardService.updateTaskStatus(created.id, 'running' as TaskBoardStatus);
		}
	}

	// ─── Task Detail ────────────────────────────────────────────────────

	private async _handleTaskDetail(
		task: TaskBoardRecord,
		employees: EmployeeInfo[],
		allTasks: TaskBoardRecord[],
	): Promise<void> {
		if (!this._renderer || !this._container) { return; }

		const result = await this._renderer.showTaskDetailModal(
			this._container,
			task,
			employees,
			allTasks,
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
		}
		// Refresh is automatic via onDidChangeTaskBoard event
	}

	// ─── Chat Jump ──────────────────────────────────────────────────────

	private async _handleChatJump(agentId: string, agentName: string): Promise<void> {
		// 1. Find existing chat tab for this agent
		for (const group of this._editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */)) {
			for (const editor of group.editors) {
				if ((editor as any).typeId === 'workbench.editors.nativeChatInput' && (editor as any).agentId === agentId) {
					// Found — focus the tab
					await group.openEditor(editor, { pinned: true });
					for (const pane of this._editorService.visibleEditorPanes) {
						if ((pane as any).input === editor) {
							// Force history reload: setInput skips reload for same chatId.
							// Call _selectAndLoadAgent directly to re-fetch session & messages.
							void (pane as any)._selectAndLoadAgent?.(agentId);
							(pane as any).focusInput?.();
							return;
						}
					}
					return;
				}
			}
		}

		// 2. Not found — create a new chat tab for this agent.
		// Task execution is fire-and-forget, so messages may not be persisted yet.
		// The new tab's setInput→_selectAndLoadAgent will load whatever is available.
		try {
			const { NativeChatEditorInput } = await import('./nativeChatEditorInput.js');
			const input = NativeChatEditorInput.create(undefined, agentId, undefined, agentName);
			await this._editorService.openEditor(input, { pinned: true });
		} catch (err) {
			this._logService.error('[TaskOverviewEditorPane] Failed to open chat for agent:', err);
		}
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
