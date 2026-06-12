/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Task Card (individual kanban card)
 *  Displays task info, supports drag, status actions, dependencies, retry/pause/cancel
 *  Enhanced: priority badge, description preview, dependency status, navigate-to-chat
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { type TaskBoardRecord, type TaskBoardStatus, type TaskSource, useTaskBoardStore } from '../../store/useTaskBoardStore';
import { type Agent, useAgentStore } from '../../store/useAgentStore';
import { useDiagnosticsStore } from '../../store/useDiagnosticsStore';
import { useSwarmStore } from '../../store/useSwarmStore';
import { getAgentColor } from '../../utils/agentColors';
import { sendRequest } from '../../bridge/messageClient';

interface TaskCardProps {
	task: TaskBoardRecord;
	agents: Agent[];
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

// Human-readable labels for diagnostic remediation actions.
const DIAGNOSTIC_ACTION_LABELS: Record<string, string> = {
	specify: '✨ 细化',
	decompose: '🧩 分解',
	unblock: '🔓 解除阻塞',
	reclaim: '↩ 重新认领',
	cancel: '✕ 取消',
};

// Swarm role badges: which node this task plays in a multi-agent swarm topology.
const SWARM_ROLE_CONFIG: Record<string, { label: string; icon: string; color: string; bg: string }> = {
	root: { label: 'Swarm 根', icon: '🐝', color: '#7c3aed', bg: 'rgba(124, 58, 237, 0.12)' },
	worker: { label: 'Worker', icon: '⚙️', color: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)' },
	verifier: { label: 'Verifier', icon: '🔍', color: '#0891b2', bg: 'rgba(8, 145, 178, 0.12)' },
	synthesizer: { label: 'Synthesizer', icon: '🧠', color: '#d97706', bg: 'rgba(217, 119, 6, 0.12)' },
};

const SWARM_PHASE_LABELS: Record<string, string> = {
	planning: '规划中',
	running: '执行中',
	verifying: '校验中',
	synthesizing: '汇总中',
	done: '已完成',
	cancelled: '已取消',
	failed: '失败',
	interrupted: '已中断',
};

export function TaskCard({
	task,
	agents,
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

	// ─── Attachments ──────────────────────────────────────────────────────
	const addAttachment = useTaskBoardStore(s => s.addAttachment);
	const removeAttachment = useTaskBoardStore(s => s.removeAttachment);
	const downloadAttachment = useTaskBoardStore(s => s.downloadAttachment);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);
	// Attachments only make sense for real (task-board) tasks, not delegation mirrors.
	const canAttach = task.source === 'task-board';

	const handlePickFile = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		fileInputRef.current?.click();
	}, []);

	const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files || files.length === 0) { return; }
		setUploading(true);
		try {
			for (let i = 0; i < files.length; i++) {
				await addAttachment(task.id, files[i]);
			}
		} finally {
			setUploading(false);
			if (fileInputRef.current) { fileInputRef.current.value = ''; }
		}
	}, [task.id, addAttachment]);

	const formatSize = useCallback((bytes: number): string => {
		if (bytes < 1024) { return `${bytes} B`; }
		if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}, []);

	const assignee = task.assigneeId ? agents.find(e => e.id === task.assigneeId) : null;
	const fromEmp = task.fromAgentId ? agents.find(e => e.id === task.fromAgentId) : null;

	// Cross-reference dependency status
	const allTasks = useTaskBoardStore(s => s.tasks);
	const specifyTask = useTaskBoardStore(s => s.specifyTask);
	const decomposeTask = useTaskBoardStore(s => s.decomposeTask);
	const triagePendingId = useTaskBoardStore(s => s.triagePendingId);
	const isTriagePending = triagePendingId === task.id;
	// Diagnostics attached to this task (alerts).
	// IMPORTANT: subscribe to the raw `diagnostics` array (stable reference between
	// updates) and derive the filtered list with useMemo. Returning the result of
	// `.filter(...)` directly from a Zustand selector creates a new array on every
	// render, which trips React 19's getSnapshot equality check and blows up the
	// kanban with error #185 ("Maximum update depth exceeded").
	const allDiagnostics = useDiagnosticsStore(s => s.diagnostics);
	const taskDiagnostics = useMemo(
		() => allDiagnostics.filter(d => d.taskId === task.id),
		[allDiagnostics, task.id],
	);
	const dismissDiagnostic = useDiagnosticsStore(s => s.dismissDiagnostic);
	const applyDiagnosticAction = useDiagnosticsStore(s => s.applyAction);
	const topDiagnostic = taskDiagnostics.length > 0
		? (taskDiagnostics.find(d => d.severity === 'critical')
			?? taskDiagnostics.find(d => d.severity === 'error')
			?? taskDiagnostics[0])
		: null;

	// Swarm membership: is this card a node in a multi-agent swarm topology?
	const swarm = useSwarmStore(s => s.getSwarmForTask(task.id));
	let swarmRole: 'root' | 'worker' | 'verifier' | 'synthesizer' | null = null;
	if (swarm) {
		if (swarm.rootTaskId === task.id) { swarmRole = 'root'; }
		else if (swarm.verifier?.taskId === task.id) { swarmRole = 'verifier'; }
		else if (swarm.synthesizer?.taskId === task.id) { swarmRole = 'synthesizer'; }
		else if (swarm.workers.some(w => w.taskId === task.id)) { swarmRole = 'worker'; }
	}
	const swarmRoleInfo = swarmRole ? SWARM_ROLE_CONFIG[swarmRole] : null;
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
			useAgentStore.getState().selectAgent(task.assigneeId);
		}
	}, [task.assigneeId]);

	// v10: start the associated workflow with the task description as context.
	const [startingWorkflow, setStartingWorkflow] = useState(false);
	const handleStartWorkflow = useCallback(async () => {
		if (!task.workflowId || startingWorkflow) { return; }
		setStartingWorkflow(true);
		try {
			await sendRequest('workflow.execute', {
				workflowId: task.workflowId,
				context: {
					taskTitle: task.title,
					taskDescription: task.description ?? task.title,
					// v17: propagate the task's worktree so workflow agents + their
					// subagents all execute inside the same worktree directory.
					worktreePath: task.worktreePath,
				},
			});
			// Also mark the task as running so it moves to the running column.
			onStatusChange(task.id, 'running', task.source);
		} catch (err) {
			console.error('[TaskCard] Failed to start workflow:', err);
		} finally {
			setStartingWorkflow(false);
		}
	}, [task.workflowId, task.title, task.description, task.id, task.source, startingWorkflow, onStatusChange]);

	const priorityInfo = task.priority ? PRIORITY_CONFIG[task.priority] : null;

	// Agent color: use assignee's color if task is assigned
	const agentColor = task.assigneeId ? getAgentColor(task.assigneeId) : null;

	return (
		<div
			className={`task-card ${isDragging ? 'dragging' : ''} ${!isDraggable ? 'no-drag' : ''} ${priorityInfo ? `priority-${task.priority}` : ''} ${isFocused ? 'focused' : ''} ${agentColor ? 'has-agent-color' : ''} ${topDiagnostic ? `has-diagnostic diagnostic-${topDiagnostic.severity}` : ''}`}
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
					{swarmRoleInfo && (
						<span
							className={`task-card-swarm-badge role-${swarmRole}`}
							style={{ color: swarmRoleInfo.color, backgroundColor: swarmRoleInfo.bg }}
							title={`Swarm「${swarm!.title}」· ${swarmRoleInfo.label} · 阶段: ${SWARM_PHASE_LABELS[swarm!.phase] ?? swarm!.phase}`}
						>
							{swarmRoleInfo.icon} {swarmRoleInfo.label}
						</span>
					)}
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

			{/* Attachments (P2) */}
			{canAttach && (
				<div className="task-card-attachments">
					<div className="task-card-attachments-header">
						<span className="task-card-attachments-label">
							📎 附件{task.attachments && task.attachments.length > 0 ? ` (${task.attachments.length})` : ''}
						</span>
						<button
							className="task-card-attach-btn"
							onClick={handlePickFile}
							disabled={uploading}
							title="上传附件"
						>{uploading ? '⏳' : '＋'}</button>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							style={{ display: 'none' }}
							onChange={handleFileChange}
						/>
					</div>
					{task.attachments && task.attachments.length > 0 && (
						<div className="task-card-attachment-list">
							{task.attachments.map(att => (
								<div className="task-card-attachment" key={att.id} title={`${att.name} · ${formatSize(att.size)}`}>
									<button
										className="task-card-attachment-name"
										onClick={(e) => { e.stopPropagation(); void downloadAttachment(task.id, att); }}
										title="点击下载"
									>
										<span className="task-card-attachment-icon">📄</span>
										<span className="task-card-attachment-text">{att.name}</span>
									</button>
									<span className="task-card-attachment-size">{formatSize(att.size)}</span>
									<button
										className="task-card-attachment-remove"
										onClick={(e) => { e.stopPropagation(); void removeAttachment(task.id, att.id); }}
										title="删除附件"
									>✕</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Diagnostic alert banner (kanban health check) */}
			{topDiagnostic && (
				<div className={`task-card-diagnostic severity-${topDiagnostic.severity}`} title={topDiagnostic.detail}>
					<span className="task-card-diagnostic-icon">
						{topDiagnostic.severity === 'critical' ? '🛑' : topDiagnostic.severity === 'error' ? '⚠️' : '⚡'}
					</span>
					<span className="task-card-diagnostic-text">{topDiagnostic.title}</span>
					<div className="task-card-diagnostic-actions">
						{topDiagnostic.actions
							.filter(a => a.type !== 'dismiss')
							.map((action, i) => (
								<button
									key={`${action.type}-${i}`}
									className={`task-card-diagnostic-btn action-${action.type}`}
									onClick={(e) => { e.stopPropagation(); void applyDiagnosticAction(topDiagnostic, action); }}
									disabled={isTriagePending}
									title={DIAGNOSTIC_ACTION_LABELS[action.type] ?? action.type}
								>{DIAGNOSTIC_ACTION_LABELS[action.type] ?? action.type}</button>
							))}
						<button
							className="task-card-diagnostic-btn action-dismiss"
							onClick={(e) => { e.stopPropagation(); void dismissDiagnostic(topDiagnostic.id); }}
							title="忽略此告警"
						>忽略</button>
					</div>
				</div>
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
			{/* Show assigneeName even if not found in agents list (e.g. auto-created) */}
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
				{/* AI 细化 / 分解：仅 triage 状态、且为 task-board 来源时可用 */}
				{task.status === 'triage' && task.source === 'task-board' && (
					<>
						<button
							className="task-card-action ai-specify"
							onClick={() => { if (!isTriagePending) { void specifyTask(task.id); } }}
							disabled={isTriagePending}
							title="AI 细化为结构化规格（Goal / Approach / 验收标准），并移入待执行"
						>{isTriagePending ? '⏳' : '✨'}</button>
						<button
							className="task-card-action ai-decompose"
							onClick={() => { if (!isTriagePending) { void decomposeTask(task.id); } }}
							disabled={isTriagePending}
							title="AI 分解为多个可执行子任务"
						>{isTriagePending ? '⏳' : '🧩'}</button>
					</>
				)}
				{/* 细化完成：triage → todo */}
				{task.status === 'triage' && (
					<button
						className="task-card-action execute"
						onClick={() => onStatusChange(task.id, 'todo', task.source)}
						title="完成规划，移入待执行"
					>📋</button>
				)}
				{/* 标记就绪：todo → ready */}
				{task.status === 'todo' && (
					<button
						className="task-card-action ready"
						onClick={() => onStatusChange(task.id, 'ready', task.source)}
						title="标记为就绪"
					>✔</button>
				)}
				{/* v10: 执行关联工作流 (todo/ready状态 + 有关联workflowId) */}
				{task.workflowId && (task.status === 'todo' || task.status === 'ready') && (
					<button
						className="task-card-action execute-workflow"
						onClick={(e) => { e.stopPropagation(); void handleStartWorkflow(); }}
						title="在工作流中执行此任务"
					>🔄</button>
				)}
				{/* 执行（todo/ready 可用） */}
				{(task.status === 'todo' || task.status === 'ready') && (
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
				{/* 解除阻塞：blocked → todo */}
				{task.status === 'blocked' && (
					<button
						className="task-card-action unblock"
						onClick={() => onStatusChange(task.id, 'todo', task.source)}
						title="解除阻塞"
					>🔓</button>
				)}
				{/* 重试（running/blocked/done/cancelled/archived 都可用） */}
				{(task.status === 'running' || task.status === 'blocked' || task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') && (
					<button
						className="task-card-action retry"
						onClick={() => onStatusChange(task.id, 'todo', task.source)}
						title="重试"
					>🔄</button>
				)}
				{/* 取消（triage/todo/ready/running/blocked 可用） */}
				{(task.status === 'triage' || task.status === 'todo' || task.status === 'ready' || task.status === 'running' || task.status === 'blocked') && (
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
