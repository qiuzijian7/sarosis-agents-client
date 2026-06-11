/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Board Panel (Kanban)
 *  6-column kanban over a 7-status model:
 *    triage | (todo+ready) | (running+blocked) | done | cancelled | archived
 *  Columns may aggregate multiple statuses; dropStatus defines the status applied on drop
 *  (null = column rejects drops, e.g. the running column which holds protected tasks).
 *  Supports drag-and-drop status change, collapse/expand
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTaskBoardStore, type TaskBoardStatus, type TaskSource } from '../../store/useTaskBoardStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useAgentStore } from '../../store/useAgentStore';
import { useDelegationStore } from '../../store/useDelegationStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { sendRequest } from '../../bridge/messageClient';
import { useDiagnosticsStore } from '../../store/useDiagnosticsStore';
import { useSwarmStore } from '../../store/useSwarmStore';
import { TaskCard } from './TaskCard';
import { CreateTaskModal, type CreateTaskFormData } from './CreateTaskModal';
import { OrchestrationPlanModal } from '../orchestration/OrchestrationPlanModal';
import { registerAgentColors } from '../../utils/agentColors';

// Column configuration.
// - statuses: which task statuses are shown in this column (aggregation)
// - dropStatus: the status applied when a card is dropped here (null = no drop allowed)
interface ColumnDef {
	key: string;
	statuses: TaskBoardStatus[];
	dropStatus: TaskBoardStatus | null;
	label: string;
	icon: string;
	color: string;
}

const COLUMNS: ColumnDef[] = [
	{ key: 'triage', statuses: ['triage'], dropStatus: 'triage', label: '待规划', icon: '🗂', color: '#a855f7' },
	{ key: 'todo', statuses: ['todo', 'ready'], dropStatus: 'todo', label: '待执行', icon: '📋', color: '#f59e0b' },
	{ key: 'running', statuses: ['running', 'blocked'], dropStatus: null, label: '执行中', icon: '⚡', color: '#3b82f6' },
	{ key: 'done', statuses: ['done'], dropStatus: 'done', label: '执行结束', icon: '✅', color: '#10b981' },
	{ key: 'cancelled', statuses: ['cancelled'], dropStatus: 'cancelled', label: '取消执行', icon: '⏹', color: '#6b7280' },
	{ key: 'archived', statuses: ['archived'], dropStatus: 'archived', label: '归档', icon: '📦', color: '#8b5cf6' },
];

// Collapse toggle icon
const CollapseIcon = ({ collapsed }: { collapsed: boolean }) => (
	<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
		<path d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
	</svg>
);

export function TaskBoardPanel(): React.ReactElement {
	const { tasks, isCollapsed, isLoading, toggleCollapse, loadTasks, updateTaskStatus, createTask, deleteTask, archiveTask, setDragTarget, focusedTaskId, focusTask } = useTaskBoardStore();
	const { activeWorkspaceId, workspaces } = useWorkspaceStore();
	const { agents } = useAgentStore();
	const loadAgents = useAgentStore(s => s.loadAgents);
	// All agents are global (no per-workspace filtering) — `agents` already holds the full list.
	const allAgents = agents;

	// Worktree options: list ALL git worktrees from the active workspace
	// (mirrors Source Control Worktree view, not just agent-bound ones).
	const [worktreeList, setWorktreeList] = useState<{ path: string; branch: string; repoName?: string }[]>([]);
	const fetchWorktrees = useCallback(() => {
		const wsId = activeWorkspaceId;
		if (!wsId) { return Promise.resolve(); }
		return sendRequest<{ workspaceId: string }, Array<{ path: string; branch: string; repoRoot?: string; repoName?: string }>>(
			'worktree.list',
			{ workspaceId: wsId },
		).then(list => {
			console.log(`[TaskBoardPanel] worktree.list (wsId=${wsId}) → ${list?.length ?? 0} entries:`, list);
			setWorktreeList(
				(list || []).map(wt => ({
					path: wt.path,
					branch: wt.branch,
					repoName: wt.repoName,
				})),
			);
		}).catch(err => {
			console.warn('[TaskBoardPanel] worktree.list failed:', err);
			setWorktreeList([]);
		});
	}, [activeWorkspaceId]);
	// Re-fetch on workspace change.
	useEffect(() => {
		void fetchWorktrees();
	}, [fetchWorktrees]);
	// Refresh the worktree list whenever a worktree is created/removed elsewhere
	// (e.g. via the Worktree Switcher in the chat header).
	useEffect(() => {
		const handler = () => {
			void fetchWorktrees();
		};
		window.addEventListener('agentStudio:worktree-changed', handler);
		return () => window.removeEventListener('agentStudio:worktree-changed', handler);
	}, [fetchWorktrees]);
	const worktreeOptions = worktreeList;
	const { loadDelegations } = useDelegationStore();
	const { isPlanDialogOpen, openPlanDialog, closePlanDialog, loadPlans, activePlan, plans: orchestrationPlans, setActivePlan } = useOrchestrationStore();
	const { diagnostics, isRunning: isDiagnosticsRunning, loadDiagnostics, runDiagnostics } = useDiagnosticsStore();
	const swarms = useSwarmStore(s => s.swarms);
	const loadSwarms = useSwarmStore(s => s.loadSwarms);
	const cancelSwarm = useSwarmStore(s => s.cancelSwarm);

	// ─── Filters (board model simplified: one workspace == one board) ──────
	// The board dropdown is now a pure FILTER, not a CRUD surface. Its value is
	// either 'all' (show tasks from every workspace) or a specific workspaceId
	// (show only that workspace's board). Boards are no longer user-creatable
	// or deletable — each workspace implicitly owns exactly one board.
	const [boardFilterWsId, setBoardFilterWsId] = useState<string>('all');
	// Agent filter: 'all' or a specific assigneeId (derived from current tasks).
	const [agentFilter, setAgentFilter] = useState<string>('all');
	// Status-column visibility: a column key is hidden when present in this set.
	// Default = empty (all columns shown). Unchecking a checkbox hides its column.
	const [hiddenColumnKeys, setHiddenColumnKeys] = useState<Set<string>>(() => new Set());

	// Create-task modal (opened from the 待执行/todo column's + button).
	const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(false);

	// Re-fetch the worktree list every time the create-task modal opens,
	// ensuring the dropdown always matches the current Source Control state
	// (handles the case where the modal is opened before the initial load
	// completes, or after a worktree is added/removed).
	useEffect(() => {
		if (isCreateTaskOpen) {
			void fetchWorktrees();
		}
	}, [isCreateTaskOpen, fetchWorktrees]);

	// Submit handler for the create-task form. New tasks land in the todo
	// column ('todo' status) scoped to the currently-viewed workspace board.
	const handleCreateTask = useCallback((data: CreateTaskFormData) => {
		const wsId = boardFilterWsId === 'all' ? (activeWorkspaceId ?? undefined) : boardFilterWsId;
		void createTask({
			title: data.title,
			description: data.description,
			assigneeId: data.assigneeId,
			assigneeName: data.assigneeName,
			priority: data.priority,
			worktreePath: data.worktreePath || undefined,
			dependencies: data.dependencies,
			status: 'todo',
			source: 'task-board',
			workspaceId: wsId,
			workflowId: data.workflowId,
		});
	}, [createTask, boardFilterWsId, activeWorkspaceId]);

	const handleClosePlanInput = useCallback(() => {
		useOrchestrationStore.setState({ isPlanDialogOpen: false });
	}, []);

	// Track which pending plans have been auto-opened so we don't re-open them
	const autoOpenedPlanIdsRef = useRef<Set<string>>(new Set());

	// Auto-open the orchestration dialog when a new pending_approval plan arrives.
	// This handles /plan commands sent from the chat panel — the dialog shows in taskboard.
	// Even if the dialog is already open (e.g. showing an empty creation form),
	// we switch to showing the new pending plan.
	useEffect(() => {
		// Always pick the LATEST pending_approval plan (by createdAt desc),
		// not just the first one in the array. When multiple plans are pending
		// (e.g. test55 and test100), we want the newest one.
		const pendingPlans = orchestrationPlans
			.filter((p): p is NonNullable<typeof p> => p != null && p.status === 'pending_approval')
			.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
		const latestPending = pendingPlans[0];
		if (!latestPending) { return; }
		if (autoOpenedPlanIdsRef.current.has(latestPending.id)) { return; }

		autoOpenedPlanIdsRef.current.add(latestPending.id);
		setActivePlan(latestPending);
		openPlanDialog();
	}, [orchestrationPlans, setActivePlan, openPlanDialog]);

	const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
	const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
	const [diagnosticsToast, setDiagnosticsToast] = useState<string | null>(null);

	// Load tasks when the board filter changes.
	// - 'all'  → load tasks across every workspace (no workspaceId filter)
	// - wsId   → load only that workspace's board
	// Delegations / plans / diagnostics / swarms remain scoped to the active
	// workspace (they are not part of the cross-workspace board view).
	useEffect(() => {
		const ws = boardFilterWsId === 'all' ? undefined : boardFilterWsId;
		loadDelegations(activeWorkspaceId ?? undefined).then(() => {
			loadTasks(ws, undefined);
		});
		if (activeWorkspaceId) {
			loadPlans(activeWorkspaceId);
			loadDiagnostics();
			loadSwarms(activeWorkspaceId);
		}
	}, [activeWorkspaceId, boardFilterWsId, loadDelegations, loadTasks, loadPlans, loadDiagnostics, loadSwarms]);

	// Load all agents (global definitions) so the create-task modal's
	// assignee dropdown shows every available agent.
	useEffect(() => {
		loadAgents();
	}, [loadAgents]);

	// Register agent colors when agents change (ensures consistent color assignment)
	useEffect(() => {
		if (agents.length > 0) {
			registerAgentColors(agents.map(e => e.id));
		}
	}, [agents]);

	// Listen for task-board changes from host
	useEffect(() => {
		const handler = () => {
			const ws = boardFilterWsId === 'all' ? undefined : boardFilterWsId;
			loadTasks(ws, undefined);
		};
		window.addEventListener('agentStudio:taskboard-changed', handler);
		return () => window.removeEventListener('agentStudio:taskboard-changed', handler);
	}, [boardFilterWsId, loadTasks]);

	// Listen for focusTask messages from host (via custom event dispatched by index.tsx)
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.taskTitle) {
				const task = useTaskBoardStore.getState().tasks.find(t => t.title === detail.taskTitle);
				if (task) {
					focusTask(task.id);
					setTimeout(() => {
						const el = document.querySelector(`[data-task-id="${task.id}"]`);
						if (el) {
							el.scrollIntoView({ behavior: 'smooth', block: 'center' });
						}
					}, 300);
				}
			}
		};
		window.addEventListener('agentStudio:focusTask', handler as EventListener);
		return () => window.removeEventListener('agentStudio:focusTask', handler as EventListener);
	}, [focusTask]);

	const getTasksForColumn = useCallback((col: ColumnDef) => {
		return tasks.filter(t => {
			if (!t || !col.statuses.includes(t.status)) { return false; }
			// Agent filter ('all' = no filter, otherwise match assigneeId)
			if (agentFilter !== 'all' && t.assigneeId !== agentFilter) { return false; }
			return true;
		});
	}, [tasks, agentFilter]);

	// Drag handlers
	const handleDragStart = useCallback((taskId: string) => {
		setDraggingTaskId(taskId);
		setDragTarget(taskId);
	}, [setDragTarget]);

	const handleDragEnd = useCallback(() => {
		setDraggingTaskId(null);
		setDragOverColumn(null);
		setDragTarget(null);
	}, [setDragTarget]);

	const handleDragOver = useCallback((e: React.DragEvent, col: ColumnDef) => {
		if (col.dropStatus === null) { return; }
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		setDragOverColumn(col.key);
	}, []);

	const handleDragLeave = useCallback(() => {
		setDragOverColumn(null);
	}, []);

	const handleDrop = useCallback((e: React.DragEvent, col: ColumnDef) => {
		e.preventDefault();
		setDragOverColumn(null);

		const targetStatus = col.dropStatus;
		if (!targetStatus) { return; }
		if (!draggingTaskId) { return; }
		const task = tasks.find(t => t && t.id === draggingTaskId);
		if (!task || task.status === targetStatus) { return; }

		// Running tasks cannot be dragged away
		if (task.status === 'running') { return; }

		updateTaskStatus(draggingTaskId, targetStatus, task.source);
		setDraggingTaskId(null);
	}, [draggingTaskId, tasks, updateTaskStatus]);

	const handleStatusChange = useCallback((taskId: string, status: TaskBoardStatus, source: TaskSource) => {
		updateTaskStatus(taskId, status, source);
	}, [updateTaskStatus]);

	const handleDelete = useCallback((taskId: string, source: TaskSource) => {
		deleteTask(taskId, source);
	}, [deleteTask]);

	const handleArchive = useCallback((taskId: string, source: TaskSource) => {
		archiveTask(taskId, source);
	}, [archiveTask]);

	const totalTasks = tasks.length;
	const alertCount = diagnostics.length;
	const hasErrorAlert = diagnostics.some(d => d.severity === 'error' || d.severity === 'critical');

	// ─── Filter derivations ────────────────────────────────────────────────
	// Agent options derived from the assignees present on current tasks.
	// We prefer the agent record's name (from useAgentStore) but fall
	// back to the assigneeName stored on the task itself.
	const agentOptions = useMemo(() => {
		const seen = new Map<string, string>();
		for (const t of tasks) {
			if (!t || !t.assigneeId) { continue; }
			if (seen.has(t.assigneeId)) { continue; }
			const emp = agents.find(e => e.id === t.assigneeId);
			seen.set(t.assigneeId, emp?.name || t.assigneeName || t.assigneeId);
		}
		return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
	}, [tasks, agents]);

	// Columns currently visible (a column is hidden when its key is in hiddenColumnKeys).
	const visibleColumns = useMemo(
		() => COLUMNS.filter(c => !hiddenColumnKeys.has(c.key)),
		[hiddenColumnKeys]
	);

	// Toggle a status-column's visibility. Checkbox checked = visible.
	const toggleColumnVisibility = useCallback((key: string) => {
		setHiddenColumnKeys(prev => {
			const next = new Set(prev);
			if (next.has(key)) { next.delete(key); } else { next.add(key); }
			return next;
		});
	}, []);

	// Active swarms for the current workspace (newest first).
	const swarmList = Object.values(swarms)
		.filter(s => !activeWorkspaceId || !s.workspaceId || s.workspaceId === activeWorkspaceId)
		.sort((a, b) => b.createdAt - a.createdAt);

	const handleRunDiagnostics = useCallback(async (e: React.MouseEvent) => {
		e.stopPropagation();
		const list = await runDiagnostics(activeWorkspaceId || undefined);
		const count = (list as unknown as unknown[])?.length ?? 0;
		setDiagnosticsToast(count > 0 ? `巡检完成，发现 ${count} 项问题` : '巡检完成，暂未发现问题');
		setTimeout(() => setDiagnosticsToast(null), 3000);
	}, [runDiagnostics, activeWorkspaceId]);

	return (
		<div className="task-board-panel">
			{/* Header with collapse toggle */}
			<div className="task-board-header" onClick={toggleCollapse}>
				<div className="task-board-header-left">
					<CollapseIcon collapsed={isCollapsed} />
					<span className="task-board-title">任务看板</span>
					{totalTasks > 0 && <span className="task-board-count">{totalTasks}</span>}
				</div>
			<div className="task-board-header-right">
			<button
				className={`task-board-diagnostics-btn ${hasErrorAlert ? 'has-error' : alertCount > 0 ? 'has-warning' : ''}`}
				onClick={handleRunDiagnostics}
				disabled={isDiagnosticsRunning}
				title="看板健康巡检 - 检测卡住/失败/不可执行的任务"
			>
				{isDiagnosticsRunning ? '⏳ 巡检中' : '🩺 巡检'}
				{alertCount > 0 && <span className="task-board-alert-badge">{alertCount}</span>}
			</button>
			<button
				className="task-board-orchestrate-btn"
				onClick={(e) => { e.stopPropagation(); openPlanDialog(); }}
				title="任务编排 - AI 自动拆分任务、创建 Agent"
			>
				🎯 任务编排
			</button>
				{isLoading && <span className="task-board-loading">Loading...</span>}
			</div>
		</div>

		{/* Diagnostics toast (brief feedback after running health check) */}
		{diagnosticsToast && (
			<div className="task-board-toast">{diagnosticsToast}</div>
		)}

		{/* Orchestration Plan Modal */}
		<OrchestrationPlanModal
			isOpen={isPlanDialogOpen}
			onClose={handleClosePlanInput}
		/>

		{/* Create Task Modal (opened from 待执行 column's + button) */}
		<CreateTaskModal
			isOpen={isCreateTaskOpen}
			onClose={() => setIsCreateTaskOpen(false)}
			onCreate={handleCreateTask}
			agents={allAgents.map(e => ({ id: e.id, name: e.name }))}
			tasks={tasks.map(t => ({ id: t.id, title: t.title }))}
			worktreeOptions={worktreeOptions}
		/>

		{/* Filter bar: board(workspace) filter + agent filter + status-column toggles */}
		{!isCollapsed && (
			<div className="task-board-filters">
				{/* Board filter — 'all' or one workspace's board. Each workspace
				    implicitly owns exactly one board; boards are not creatable/deletable. */}
				<div className="task-board-filter-group">
					<span className="task-board-filter-label">看板</span>
					<select
						className="task-board-filter-select"
						value={boardFilterWsId}
						onChange={e => setBoardFilterWsId(e.target.value)}
						title="按工作区过滤任务"
					>
						<option value="all">全部看板</option>
						{workspaces.map(ws => (
							<option key={ws.id} value={ws.id}>{ws.name}工作区的看板</option>
						))}
					</select>
				</div>

				{/* Agent filter — derived from assignees on current tasks. */}
				<div className="task-board-filter-group">
					<span className="task-board-filter-label">员工</span>
					<select
						className="task-board-filter-select"
						value={agentFilter}
						onChange={e => setAgentFilter(e.target.value)}
						title="按负责员工过滤任务"
					>
						<option value="all">全部员工</option>
						{agentOptions.map(emp => (
							<option key={emp.id} value={emp.id}>{emp.name}</option>
						))}
					</select>
				</div>

				{/* Status-column toggles — checked = column visible. */}
				<div className="task-board-filter-columns">
					{COLUMNS.map(col => (
						<label
							key={col.key}
							className="task-board-filter-checkbox"
							title={`显示/隐藏「${col.label}」列`}
						>
							<input
								type="checkbox"
								checked={!hiddenColumnKeys.has(col.key)}
								onChange={() => toggleColumnVisibility(col.key)}
							/>
							<span className="task-board-filter-checkbox-icon">{col.icon}</span>
							<span>{col.label}</span>
						</label>
					))}
				</div>
			</div>
		)}

		{/* Active Swarm summary bar (multi-agent collaboration) */}
		{!isCollapsed && swarmList.length > 0 && (
			<div className="task-board-swarms">
				{swarmList.map(s => {
					const total = s.workers.length + (s.verifier ? 1 : 0) + (s.synthesizer ? 1 : 0);
					const doneCount =
						s.workers.filter(w => w.status === 'done').length +
						(s.verifier?.status === 'done' ? 1 : 0) +
						(s.synthesizer?.status === 'done' ? 1 : 0);
					const isActive = s.phase !== 'done' && s.phase !== 'cancelled' && s.phase !== 'failed' && s.phase !== 'interrupted';
					const phaseLabel: Record<string, string> = {
						planning: '规划中', running: '执行中', verifying: '校验中',
						synthesizing: '汇总中', done: '已完成', cancelled: '已取消', failed: '失败', interrupted: '已中断',
					};
					return (
						<div key={s.swarmId} className={`task-board-swarm-item phase-${s.phase}`} title={`Swarm: ${s.title}`}>
							<span className="task-board-swarm-icon">🐝</span>
							<span className="task-board-swarm-title">{s.title}</span>
							<span className={`task-board-swarm-phase phase-${s.phase}`}>{phaseLabel[s.phase] ?? s.phase}</span>
							<span className="task-board-swarm-progress">{doneCount}/{total}</span>
							{isActive && (
								<button
									className="task-board-swarm-cancel"
									onClick={(e) => { e.stopPropagation(); void cancelSwarm(s.swarmId); }}
									title="取消该 Swarm（中断尚未完成的 Worker）"
								>✕</button>
							)}
						</div>
					);
				})}
			</div>
		)}

		{/* Kanban columns */}
		{!isCollapsed && (
			<div className="task-board-columns">
				{visibleColumns.map(col => {
					const columnTasks = getTasksForColumn(col);
					const isDragOver = dragOverColumn === col.key;

					return (
						<div
							key={col.key}
							className={`task-board-column ${isDragOver ? 'drag-over' : ''}`}
							onDragOver={(e) => handleDragOver(e, col)}
							onDragLeave={handleDragLeave}
							onDrop={(e) => handleDrop(e, col)}
						>
							{/* Column header */}
							<div className="task-column-header">
								<span className="task-column-icon">{col.icon}</span>
								<span className="task-column-label">{col.label}</span>
								<span className="task-column-count" style={{ backgroundColor: col.color + '30', color: col.color }}>
									{columnTasks.length}
								</span>
								{/* 待规划列：+ 打开任务编排 UI；待执行列：+ 打开创建任务 UI */}
								{col.key === 'triage' && (
									<button
										className="task-column-add-btn"
										onClick={(e) => { e.stopPropagation(); openPlanDialog(); }}
										title="编排任务 - AI 自动拆分、创建 Agent"
									>
										＋
									</button>
								)}
								{col.key === 'todo' && (
									<button
										className="task-column-add-btn"
										onClick={(e) => { e.stopPropagation(); setIsCreateTaskOpen(true); }}
										title="创建任务"
									>
										＋
									</button>
								)}
							</div>

							{/* Cards */}
							<div className="task-column-cards">
								{columnTasks.map(task => (
									<TaskCard
										key={task.id}
										task={task}
										agents={agents}
										onStatusChange={handleStatusChange}
										onDelete={handleDelete}
										onArchive={handleArchive}
										onDragStart={handleDragStart}
										onDragEnd={handleDragEnd}
										isDragging={draggingTaskId === task.id}
										isFocused={focusedTaskId === task.id}
									/>
								))}
								{columnTasks.length === 0 && (
									<div className="task-column-empty">No tasks</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
		)}
		</div>
	);
}
