/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Board Panel (Kanban)
 *  5-column kanban: todo, running, done, cancelled, archived
 *  Supports drag-and-drop status change, collapse/expand
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { useTaskBoardStore, type TaskBoardStatus, type TaskSource } from '../../store/useTaskBoardStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { useDelegationStore } from '../../store/useDelegationStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { TaskCard } from './TaskCard';
import { OrchestrationPlanDialog } from '../orchestration/OrchestrationPlanDialog';

// Column configuration
const COLUMNS: { status: TaskBoardStatus; label: string; icon: string; color: string }[] = [
	{ status: 'todo', label: '待执行', icon: '📋', color: '#f59e0b' },
	{ status: 'running', label: '执行中', icon: '⚡', color: '#3b82f6' },
	{ status: 'done', label: '执行结束', icon: '✅', color: '#10b981' },
	{ status: 'cancelled', label: '取消执行', icon: '⏹', color: '#6b7280' },
	{ status: 'archived', label: '归档', icon: '📦', color: '#8b5cf6' },
];

// Collapse toggle icon
const CollapseIcon = ({ collapsed }: { collapsed: boolean }) => (
	<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
		<path d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
	</svg>
);

export function TaskBoardPanel(): React.ReactElement {
	const { tasks, isCollapsed, isLoading, toggleCollapse, loadTasks, updateTaskStatus, deleteTask, archiveTask, setDragTarget } = useTaskBoardStore();
	const { activeWorkspaceId } = useWorkspaceStore();
	const { employees } = useEmployeeStore();
	const { loadDelegations } = useDelegationStore();
	const { isPlanDialogOpen, openPlanDialog, closePlanDialog, loadPlans } = useOrchestrationStore();

	const [dragOverColumn, setDragOverColumn] = useState<TaskBoardStatus | null>(null);
	const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);

	// Load tasks when workspace changes
	useEffect(() => {
		if (activeWorkspaceId) {
			loadDelegations(activeWorkspaceId).then(() => {
				loadTasks(activeWorkspaceId);
			});
			loadPlans(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadDelegations, loadTasks, loadPlans]);

	// Listen for task-board changes from host
	useEffect(() => {
		const handler = () => {
			if (activeWorkspaceId) { loadTasks(activeWorkspaceId); }
		};
		window.addEventListener('agentStudio:taskboard-changed', handler);
		return () => window.removeEventListener('agentStudio:taskboard-changed', handler);
	}, [activeWorkspaceId, loadTasks]);

	const getTasksForColumn = useCallback((status: TaskBoardStatus) => {
		return tasks.filter(t => t.status === status);
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

	const handleDragOver = useCallback((e: React.DragEvent, status: TaskBoardStatus) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		setDragOverColumn(status);
	}, []);

	const handleDragLeave = useCallback(() => {
		setDragOverColumn(null);
	}, []);

	const handleDrop = useCallback((e: React.DragEvent, targetStatus: TaskBoardStatus) => {
		e.preventDefault();
		setDragOverColumn(null);

		if (!draggingTaskId) { return; }
		const task = tasks.find(t => t.id === draggingTaskId);
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
						className="task-board-orchestrate-btn"
						onClick={(e) => { e.stopPropagation(); openPlanDialog(); }}
						title="任务编排 - AI 自动拆分任务、创建 Agent"
					>
						🎯 任务编排
					</button>
					{isLoading && <span className="task-board-loading">Loading...</span>}
				</div>
			</div>

			{/* Kanban columns */}
			{!isCollapsed && (
				<div className="task-board-columns">
					{COLUMNS.map(col => {
						const columnTasks = getTasksForColumn(col.status);
						const isDragOver = dragOverColumn === col.status;

						return (
							<div
								key={col.status}
								className={`task-board-column ${isDragOver ? 'drag-over' : ''}`}
								onDragOver={(e) => handleDragOver(e, col.status)}
								onDragLeave={handleDragLeave}
								onDrop={(e) => handleDrop(e, col.status)}
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

			{/* Orchestration Plan Dialog */}
			{isPlanDialogOpen && (
				<OrchestrationPlanDialog onClose={closePlanDialog} />
			)}
		</div>
	);
}
