/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Card (individual kanban card)
 *  Displays task info, supports drag, status actions
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback } from 'react';
import { type TaskBoardRecord, type TaskBoardStatus, type TaskSource } from '../../store/useTaskBoardStore';
import { type Employee } from '../../store/useEmployeeStore';

interface TaskCardProps {
	task: TaskBoardRecord;
	employees: Employee[];
	onStatusChange: (taskId: string, status: TaskBoardStatus, source: TaskSource) => void;
	onDelete: (taskId: string, source: TaskSource) => void;
	onArchive: (taskId: string, source: TaskSource) => void;
	onDragStart: (taskId: string) => void;
	onDragEnd: () => void;
	isDragging: boolean;
}

export function TaskCard({
	task,
	employees,
	onStatusChange,
	onDelete,
	onArchive,
	onDragStart,
	onDragEnd,
	isDragging,
}: TaskCardProps): React.ReactElement {
	const isDraggable = task.status !== 'running';
	const isDelegation = task.source === 'delegation';
	const shortId = `#${task.id.slice(-6)}`;

	const assignee = task.assigneeId ? employees.find(e => e.id === task.assigneeId) : null;
	const fromEmp = task.fromEmployeeId ? employees.find(e => e.id === task.fromEmployeeId) : null;

	const timeStr = task.createdAt ? new Date(task.createdAt).toLocaleString('zh-CN', {
		month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
	}) : '';

	const handleDragStart = useCallback((e: React.DragEvent) => {
		if (!isDraggable) {
			e.preventDefault();
			return;
		}
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', task.id);
		onDragStart(task.id);
	}, [isDraggable, task.id, onDragStart]);

	return (
		<div
			className={`task-card ${isDragging ? 'dragging' : ''} ${!isDraggable ? 'no-drag' : ''}`}
			draggable={isDraggable}
			onDragStart={handleDragStart}
			onDragEnd={onDragEnd}
		>
			{/* Card header: ID + source badge */}
			<div className="task-card-header">
				<span className="task-card-id">{shortId}</span>
				{isDelegation && <span className="task-card-badge delegation">委派</span>}
			</div>

			{/* Title */}
			<div className="task-card-title">{task.title || task.description || 'Untitled'}</div>

			{/* Delegation route */}
			{fromEmp && assignee && (
				<div className="task-card-route">
					<span className="task-card-route-from">{fromEmp.name}</span>
					<span className="task-card-route-arrow">→</span>
					<span className="task-card-route-to">{assignee.name}</span>
				</div>
			)}
			{!fromEmp && assignee && (
				<div className="task-card-assignee">
					<span className="task-card-assignee-label">→</span>
					<span>{assignee.name}</span>
				</div>
			)}

			{/* Footer: time + actions */}
			<div className="task-card-footer">
				<span className="task-card-time">{timeStr}</span>
				<div className="task-card-actions">
					{task.status === 'todo' && (
						<button
							className="task-card-action"
							onClick={() => onStatusChange(task.id, 'cancelled', task.source)}
							title="Cancel"
						>✕</button>
					)}
					{task.status === 'done' && (
						<button
							className="task-card-action"
							onClick={() => onArchive(task.id, task.source)}
							title="Archive"
						>📦</button>
					)}
					{(task.status === 'cancelled' || task.status === 'archived') && (
						<button
							className="task-card-action"
							onClick={() => onStatusChange(task.id, 'todo', task.source)}
							title="Restore"
						>↩</button>
					)}
					{task.source === 'task-board' && task.status !== 'running' && (
						<button
							className="task-card-action delete"
							onClick={() => onDelete(task.id, task.source)}
							title="Delete"
						>🗑</button>
					)}
				</div>
			</div>

			{/* Result/error if done */}
			{task.status === 'done' && task.result && (
				<div className="task-card-result">
					<span className="task-card-result-label">Result:</span>
					<span className="task-card-result-text">{task.result.slice(0, 80)}{task.result.length > 80 ? '...' : ''}</span>
				</div>
			)}
			{task.status === 'done' && task.error && (
				<div className="task-card-error">
					<span className="task-card-error-label">Error:</span>
					<span className="task-card-error-text">{task.error.slice(0, 80)}{task.error.length > 80 ? '...' : ''}</span>
				</div>
			)}
		</div>
	);
}
