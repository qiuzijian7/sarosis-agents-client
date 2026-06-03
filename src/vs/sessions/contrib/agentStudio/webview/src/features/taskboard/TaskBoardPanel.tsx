/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Board Panel (Kanban)
 *  6-column kanban over a 7-status model:
 *    triage | (todo+ready) | (running+blocked) | done | cancelled | archived
 *  Columns may aggregate multiple statuses; dropStatus defines the status applied on drop
 *  (null = column rejects drops, e.g. the running column which holds protected tasks).
 *  Supports drag-and-drop status change, collapse/expand
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTaskBoardStore, type TaskBoardStatus, type TaskSource } from '../../store/useTaskBoardStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { useDelegationStore } from '../../store/useDelegationStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { useDiagnosticsStore } from '../../store/useDiagnosticsStore';
import { useSwarmStore } from '../../store/useSwarmStore';
import { useBoardStore } from '../../store/useBoardStore';
import { TaskCard } from './TaskCard';
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
	const { tasks, isCollapsed, isLoading, toggleCollapse, loadTasks, updateTaskStatus, deleteTask, archiveTask, setDragTarget, focusedTaskId, focusTask } = useTaskBoardStore();
	const { activeWorkspaceId } = useWorkspaceStore();
	const { employees } = useEmployeeStore();
	const { loadDelegations } = useDelegationStore();
	const { isPlanDialogOpen, openPlanDialog, closePlanDialog, loadPlans, activePlan, plans: orchestrationPlans, setActivePlan } = useOrchestrationStore();
	const { diagnostics, isRunning: isDiagnosticsRunning, loadDiagnostics, runDiagnostics } = useDiagnosticsStore();
	const swarms = useSwarmStore(s => s.swarms);
	const loadSwarms = useSwarmStore(s => s.loadSwarms);
	const cancelSwarm = useSwarmStore(s => s.cancelSwarm);

	const boards = useBoardStore(s => s.boards);
	const loadBoards = useBoardStore(s => s.loadBoards);
	const createBoard = useBoardStore(s => s.createBoard);
	const renameBoard = useBoardStore(s => s.renameBoard);
	const deleteBoard = useBoardStore(s => s.deleteBoard);
	const switchBoard = useBoardStore(s => s.switchBoard);
	const activeBoardId = useBoardStore(s => (activeWorkspaceId ? (s.activeByWorkspace[activeWorkspaceId] ?? 'default') : 'default'));

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

	// Load tasks when workspace or active board changes
	useEffect(() => {
		if (activeWorkspaceId) {
			loadBoards(activeWorkspaceId);
			loadDelegations(activeWorkspaceId).then(() => {
				loadTasks(activeWorkspaceId, activeBoardId);
			});
			loadPlans(activeWorkspaceId);
			loadDiagnostics();
			loadSwarms(activeWorkspaceId);
		}
	}, [activeWorkspaceId, activeBoardId, loadDelegations, loadTasks, loadPlans, loadDiagnostics, loadSwarms, loadBoards]);

	// Register agent colors when employees change (ensures consistent color assignment)
	useEffect(() => {
		if (employees.length > 0) {
			registerAgentColors(employees.map(e => e.id));
		}
	}, [employees]);

	// Listen for task-board changes from host
	useEffect(() => {
		const handler = () => {
			if (activeWorkspaceId) { loadTasks(activeWorkspaceId, activeBoardId); }
		};
		window.addEventListener('agentStudio:taskboard-changed', handler);
		return () => window.removeEventListener('agentStudio:taskboard-changed', handler);
	}, [activeWorkspaceId, activeBoardId, loadTasks]);

	// Listen for board (multi-board) changes from host
	useEffect(() => {
		const handler = () => {
			if (activeWorkspaceId) { loadBoards(activeWorkspaceId); }
		};
		window.addEventListener('agentStudio:boards-changed', handler);
		return () => window.removeEventListener('agentStudio:boards-changed', handler);
	}, [activeWorkspaceId, loadBoards]);

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
		return tasks.filter(t => t && col.statuses.includes(t.status));
	}, [tasks]);

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

	// ─── Board selector handlers (multi-board isolation) ───────────────────
	const handleSwitchBoard = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
		if (activeWorkspaceId) { switchBoard(activeWorkspaceId, e.target.value); }
	}, [activeWorkspaceId, switchBoard]);

	const handleCreateBoard = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		if (!activeWorkspaceId) { return; }
		const name = window.prompt('新看板名称：', '新看板');
		if (name && name.trim()) { void createBoard(name.trim(), activeWorkspaceId); }
	}, [activeWorkspaceId, createBoard]);

	const handleRenameBoard = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		if (!activeWorkspaceId) { return; }
		const current = boards.find(b => b.id === activeBoardId);
		const name = window.prompt('重命名看板：', current?.name ?? '');
		if (name && name.trim()) { void renameBoard(activeBoardId, name.trim()); }
	}, [activeWorkspaceId, activeBoardId, boards, renameBoard]);

	const handleDeleteBoard = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		if (!activeWorkspaceId || activeBoardId === 'default') { return; }
		const current = boards.find(b => b.id === activeBoardId);
		if (window.confirm(`删除看板「${current?.name ?? ''}」？\n其下任务将移回默认看板。`)) {
			void deleteBoard(activeBoardId, activeWorkspaceId);
		}
	}, [activeWorkspaceId, activeBoardId, boards, deleteBoard]);

	// Active swarms for the current workspace (newest first).
	const swarmList = Object.values(swarms)
		.filter(s => !activeWorkspaceId || !s.workspaceId || s.workspaceId === activeWorkspaceId)
		.sort((a, b) => b.createdAt - a.createdAt);

	const handleRunDiagnostics = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		void runDiagnostics(activeWorkspaceId || undefined);
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

		{/* Orchestration Plan Modal */}
		<OrchestrationPlanModal
			isOpen={isPlanDialogOpen}
			onClose={handleClosePlanInput}
		/>

		{/* Board selector bar (multi-board isolation) */}
		{!isCollapsed && (
			<div className="task-board-boards">
				<span className="task-board-boards-label">看板</span>
				<select
					className="task-board-boards-select"
					value={activeBoardId}
					onChange={handleSwitchBoard}
					title="切换看板"
				>
					{boards.map(b => (
						<option key={b.id} value={b.id}>{b.name}</option>
					))}
				</select>
				<button
					className="task-board-boards-btn"
					onClick={handleCreateBoard}
					title="新建看板"
				>＋</button>
				<button
					className="task-board-boards-btn"
					onClick={handleRenameBoard}
					title="重命名当前看板"
				>✎</button>
				<button
					className="task-board-boards-btn danger"
					onClick={handleDeleteBoard}
					disabled={activeBoardId === 'default'}
					title={activeBoardId === 'default' ? '默认看板不可删除' : '删除当前看板'}
				>🗑</button>
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
				{COLUMNS.map(col => {
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
							</div>

							{/* Cards */}
							<div className="task-column-cards">
								{columnTasks.map(task => (
									<TaskCard
										key={task.id}
										task={task}
										employees={employees}
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
