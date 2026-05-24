/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Card (individual kanban card)
 *  Displays task info, supports drag, status actions, dependencies, retry/pause/cancel
 *  Enhanced: priority badge, description preview, dependency status, navigate-to-chat
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useState } from 'react';
import { type TaskBoardRecord, type TaskBoardStatus, type TaskSource, useTaskBoardStore } from '../../store/useTaskBoardStore';
import { type Employee, useEmployeeStore } from '../../store/useEmployeeStore';
import { getAgentColor } from '../../utils/agentColors';

interface TaskCardProps {
	task: TaskBoardRecord;
	employees: Employee[];
	onStatusChange: (taskId: string, status: TaskBoardStatus, source: TaskSource) => void;
	onDelete: (taskId: string, source: TaskSource) => void;
	onArchive: (taskId: string, source: TaskSource) => void;
	onDragStart: (taskId: string) => void;
	onDragEnd: () => void;
	isDragging: boolean;
	isFocused?: boolean;
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
	isFocused,
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

	// Agent color: use assignee's color if task is assigned
	const agentColor = task.assigneeId ? getAgentColor(task.assigneeId) : null;

	return (
		<div
			className={`task-card ${isDragging ? 'dragging' : ''} ${!isDraggable ? 'no-drag' : ''} ${priorityInfo ? `priority-${task.priority}` : ''} ${isFocused ? 'focused' : ''} ${agentColor ? 'has-agent-color' : ''}`}
			data-task-id={task.id}
			draggable={isDraggable}
			onDragStart={handleDragStart}
			onDragEnd={onDragEnd}
			style={agentColor ? {
				'--agent-color': agentColor.primary,
				'--agent-color-light': agentColor.light,
				borderLeftColor: agentColor.primary,
			} as React.CSSProperties : undefined}
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
					<span className="task-card-route-to" style={agentColor ? { color: agentColor.primary } : undefined}>{assignee.name}</span>
				</div>
			)}
			{!fromEmp && assignee && (
				<div className="task-card-assignee">
					<span className="task-card-assignee-icon" style={agentColor ? { color: agentColor.primary } : undefined}>🤖</span>
					<span className="task-card-assignee-name" style={agentColor ? { color: agentColor.primary } : undefined}>{assignee.name}</span>
					{assignee.role && <span className="task-card-assignee-role"> · {assignee.role}</span>}
				</div>
			)}
			{/* Show assigneeName even if not found in employees list (e.g. auto-created) */}
			{!assignee && task.assigneeName && (
				<div className="task-card-assignee">
					<span className="task-card-assignee-icon" style={agentColor ? { color: agentColor.primary } : undefined}>🤖</span>
					<span className="task-card-assignee-name" style={agentColor ? { color: agentColor.primary } : undefined}>{task.assigneeName}</span>
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
						title="聊天"
					>💬</button>
				)}
				{/* 执行 */}
				{task.status === 'todo' && (
					<button
						className="task-card-action execute"
						onClick={() => onStatusChange(task.id, 'running', task.source)}
						title="执行"
					>▶</button>
				)}
				{/* 暂停 */}
				{task.status === 'running' && (
					<button
						className="task-card-action pause"
						onClick={() => onStatusChange(task.id, 'todo', task.source)}
						title="暂停"
					>⏸</button>
				)}
				{/* 重试（running/done/cancelled/archived 都可用） */}
				{(task.status === 'running' || task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') && (
					<button
						className="task-card-action retry"
						onClick={() => onStatusChange(task.id, 'todo', task.source)}
						title="重试"
					>🔄</button>
				)}
				{/* 取消（todo/running 可用） */}
				{(task.status === 'todo' || task.status === 'running') && (
					<button
						className="task-card-action cancel"
						onClick={() => onStatusChange(task.id, 'cancelled', task.source)}
						title="取消"
					>✕</button>
				)}
				{/* 归档（done 可用） */}
				{task.status === 'done' && (
					<button
						className="task-card-action archive"
						onClick={() => onArchive(task.id, task.source)}
						title="归档"
					>📦</button>
				)}
				{/* 恢复（archived 可用） */}
				{task.status === 'archived' && (
					<button
						className="task-card-action restore"
						onClick={() => onStatusChange(task.id, 'todo', task.source)}
						title="恢复"
					>↩</button>
				)}
				{/* 删除（cancelled/archived 的手动任务） */}
				{(task.status === 'cancelled' || task.status === 'archived') && task.source === 'task-board' && (
					<button
						className="task-card-action delete"
						onClick={() => onDelete(task.id, task.source)}
						title="删除"
					>🗑</button>
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
