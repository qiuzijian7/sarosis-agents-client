/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Card (individual kanban card)
 *  Displays task info, supports drag, status actions, dependencies, retry/pause/cancel
 *  Enhanced: priority badge, description preview, dependency status, navigate-to-chat
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useState } from 'react';
import { type TaskBoardRecord, type TaskBoardStatus, type TaskSource, useTaskBoardStore } from '../../store/useTaskBoardStore';
import { type Employee, useEmployeeStore } from '../../store/useEmployeeStore';

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

const PRIORITY_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
	high: { label: '高', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)' },
	medium: { label: '中', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)' },
	low: { label: '低', color: '#6b7280', bg: 'rgba(107, 114, 128, 0.12)' },
};

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
	const [copied, setCopied] = useState(false);

	const assignee = task.assigneeId ? employees.find(e => e.id === task.assigneeId) : null;
	const fromEmp = task.fromEmployeeId ? employees.find(e => e.id === task.fromEmployeeId) : null;

	// Cross-reference dependency status
	const allTasks = useTaskBoardStore(s => s.tasks);
	const depStatusMap = new Map<string, TaskBoardStatus>();
	if (task.dependencies && task.dependencies.length > 0) {
		for (const depId of task.dependencies) {
			const depTask = allTasks.find(t => t.id === depId);
			depStatusMap.set(depId, depTask?.status ?? 'todo');
		}
	}

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

	const handleCopyId = useCallback(() => {
		navigator.clipboard.writeText(task.id).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [task.id]);

	const handleNavigateChat = useCallback(() => {
		if (task.assigneeId) {
			useEmployeeStore.getState().selectEmployee(task.assigneeId);
		}
	}, [task.assigneeId]);

	const priorityInfo = task.priority ? PRIORITY_CONFIG[task.priority] : null;

	return (
		<div
			className={`task-card ${isDragging ? 'dragging' : ''} ${!isDraggable ? 'no-drag' : ''} ${priorityInfo ? `priority-${task.priority}` : ''}`}
			draggable={isDraggable}
			onDragStart={handleDragStart}
			onDragEnd={onDragEnd}
		>
			{/* Card header: Task ID + priority + source badge */}
			<div className="task-card-header">
				<div className="task-card-header-left">
					<span className="task-card-id-label">ID</span>
					<span className="task-card-id" title={`完整ID: ${task.id}`}>{shortId}</span>
					<button className="task-card-copy-id" onClick={handleCopyId} title="复制完整ID">
						{copied ? '✓' : '📋'}
					</button>
				</div>
				<div className="task-card-header-right">
					{priorityInfo && (
						<span className="task-card-priority" style={{ color: priorityInfo.color, backgroundColor: priorityInfo.bg }}>
							{priorityInfo.label}
						</span>
					)}
					{isDelegation && <span className="task-card-badge delegation">委派</span>}
					{!isDelegation && <span className="task-card-badge manual">手动</span>}
				</div>
			</div>

			{/* Title */}
			<div className="task-card-title">{task.title || '未命名任务'}</div>

			{/* Description preview */}
			{task.description && task.description !== task.title && (
				<div className="task-card-desc">{task.description.length > 80 ? task.description.slice(0, 80) + '...' : task.description}</div>
			)}

			{/* Dependencies display with status */}
			{task.dependencies && task.dependencies.length > 0 ? (
				<div className="task-card-dependencies">
					<span className="task-card-deps-label">依赖:</span>
					{task.dependencies.map((depId) => {
						const depStatus = depStatusMap.get(depId);
						const isDone = depStatus === 'done';
						const isRunning = depStatus === 'running';
						return (
							<span
								key={depId}
								className={`task-card-dep-tag ${isDone ? 'done' : isRunning ? 'running' : 'pending'}`}
								title={`依赖任务 ${depId.slice(-6)} - 状态: ${depStatus || '未知'}`}
							>
								{isDone ? '✓' : isRunning ? '⏳' : '○'} #{depId.slice(-6)}
							</span>
						);
					})}
				</div>
			) : (
				<div className="task-card-dependencies">
					<span className="task-card-deps-label">依赖:</span>
					<span className="task-card-dep-none">无</span>
				</div>
			)}

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
					<span className="task-card-assignee-icon">🤖</span>
					<span className="task-card-assignee-name">{assignee.name}</span>
					{assignee.role && <span className="task-card-assignee-role"> · {assignee.role}</span>}
				</div>
			)}
			{/* Show assigneeName even if not found in employees list (e.g. auto-created) */}
			{!assignee && task.assigneeName && (
				<div className="task-card-assignee">
					<span className="task-card-assignee-icon">🤖</span>
					<span className="task-card-assignee-name">{task.assigneeName}</span>
				</div>
			)}

			{/* Footer: time + actions */}
			<div className="task-card-footer">
				<span className="task-card-time">{timeStr}</span>
				<div className="task-card-actions">
					{/* Navigate to agent chat */}
					{task.assigneeId && (
						<button
							className="task-card-action chat"
							onClick={handleNavigateChat}
							title="跳转到 Agent 聊天"
						>💬 聊天</button>
					)}
					{/* Todo: 执行 + 取消 */}
					{task.status === 'todo' && (
						<>
							<button
								className="task-card-action execute"
								onClick={() => onStatusChange(task.id, 'running', task.source)}
								title="执行任务"
							>▶ 执行</button>
							<button
								className="task-card-action cancel"
								onClick={() => onStatusChange(task.id, 'cancelled', task.source)}
								title="取消任务"
							>✕ 取消</button>
						</>
					)}
					{/* Running: 暂停 + 取消 + 重试 */}
					{task.status === 'running' && (
						<>
							<button
								className="task-card-action pause"
								onClick={() => onStatusChange(task.id, 'todo', task.source)}
								title="暂停任务"
							>⏸ 暂停</button>
							<button
								className="task-card-action cancel"
								onClick={() => onStatusChange(task.id, 'cancelled', task.source)}
								title="取消任务"
							>✕ 取消</button>
							<button
								className="task-card-action retry"
								onClick={() => onStatusChange(task.id, 'todo', task.source)}
								title="重试任务"
							>🔄 重试</button>
						</>
					)}
					{/* Done: 重试 + 归档 */}
					{task.status === 'done' && (
						<>
							<button
								className="task-card-action retry"
								onClick={() => onStatusChange(task.id, 'todo', task.source)}
								title="重试任务"
							>🔄 重试</button>
							<button
								className="task-card-action archive"
								onClick={() => onArchive(task.id, task.source)}
								title="归档任务"
							>📦 归档</button>
						</>
					)}
					{/* Cancelled: 重试 + 删除 */}
					{task.status === 'cancelled' && (
						<>
							<button
								className="task-card-action retry"
								onClick={() => onStatusChange(task.id, 'todo', task.source)}
								title="重试任务"
							>🔄 重试</button>
							{task.source === 'task-board' && (
								<button
									className="task-card-action delete"
									onClick={() => onDelete(task.id, task.source)}
									title="删除任务"
								>🗑 删除</button>
							)}
						</>
					)}
					{/* Archived: 恢复 + 删除 */}
					{task.status === 'archived' && (
						<>
							<button
								className="task-card-action restore"
								onClick={() => onStatusChange(task.id, 'todo', task.source)}
								title="恢复任务"
							>↩ 恢复</button>
							{task.source === 'task-board' && (
								<button
									className="task-card-action delete"
									onClick={() => onDelete(task.id, task.source)}
									title="删除任务"
								>🗑 删除</button>
							)}
						</>
					)}
				</div>
			</div>

			{/* Result/error if done */}
			{task.status === 'done' && task.result && (
				<div className="task-card-result">
					<span className="task-card-result-label">结果:</span>
					<span className="task-card-result-text">{task.result.slice(0, 120)}{task.result.length > 120 ? '...' : ''}</span>
				</div>
			)}
			{task.status === 'done' && task.error && (
				<div className="task-card-error">
					<span className="task-card-error-label">错误:</span>
					<span className="task-card-error-text">{task.error.slice(0, 120)}{task.error.length > 120 ? '...' : ''}</span>
				</div>
			)}
		</div>
	);
}
