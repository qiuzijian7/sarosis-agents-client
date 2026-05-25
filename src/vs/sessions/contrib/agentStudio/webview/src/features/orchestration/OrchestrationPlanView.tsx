/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Orchestration Plan View (Inline)
 *  Embeddable version of the plan dialog for use inside TaskBoardPanel.
 *  Shows the planner's decomposition for user approval/rejection.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
	useOrchestrationStore,
	type OrchestrationPlan,
	type PlanTask,
} from '../../store/useOrchestrationStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';

// ─── Status styling ─────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
	pending: { label: '待执行', color: '#f59e0b', icon: '⏳' },
	running: { label: '执行中', color: '#3b82f6', icon: '⚡' },
	paused: { label: '已暂停', color: '#8b5cf6', icon: '⏸' },
	done: { label: '已完成', color: '#10b981', icon: '✅' },
	cancelled: { label: '已取消', color: '#6b7280', icon: '⏹' },
	error: { label: '错误', color: '#ef4444', icon: '❌' },
};

const PLAN_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
	pending_approval: { label: '等待确认', color: '#f59e0b' },
	approved: { label: '已批准', color: '#3b82f6' },
	executing: { label: '执行中', color: '#3b82f6' },
	completed: { label: '已完成', color: '#10b981' },
	rejected: { label: '已拒绝', color: '#6b7280' },
	error: { label: '执行错误', color: '#ef4444' },
};

// ─── Sub-components (copied from OrchestrationPlanDialog) ───────────────────

function TaskDependencyBadge({ deps, allTasks }: { deps: string[]; allTasks: PlanTask[] }) {
	if (deps.length === 0) { return null; }
	const depNames = deps.map(depId => {
		const depTask = allTasks.find(t => t.id === depId);
		return depTask ? depTask.title.slice(0, 20) : depId.slice(-6);
	});
	return (
		<div className="orch-task-deps">
			<span className="orch-task-deps-label">依赖:</span>
			{depNames.map((name, i) => (
				<span key={i} className="orch-task-dep-badge">{name}</span>
			))}
		</div>
	);
}

function PlanTaskItem({
	task,
	allTasks,
	showActions,
	onAction,
	isEditable,
	employees,
	onUpdate,
	onDecompose,
	isDecomposing,
}: {
	task: PlanTask;
	allTasks: PlanTask[];
	showActions: boolean;
	onAction?: (taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => void;
	isEditable?: boolean;
	employees: { id: string; name: string; role?: string }[];
	onUpdate?: (taskId: string, updates: Record<string, unknown>) => void;
	onDecompose?: (taskId: string) => void;
	isDecomposing?: boolean;
}) {
	const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
	const depthIndent = task.depth * 24;
	const [isEditing, setIsEditing] = useState(false);
	const [editTitle, setEditTitle] = useState(task.title);
	const [editDesc, setEditDesc] = useState(task.description || '');
	const [editAssigneeId, setEditAssigneeId] = useState(task.assigneeId || '');
	const [editPriority, setEditPriority] = useState(task.priority);
	const [editDeps, setEditDeps] = useState<string[]>(task.dependencies);

	const handleSave = useCallback(() => {
		if (!onUpdate) { return; }
		const assignee = employees.find(e => e.id === editAssigneeId);
		onUpdate(task.id, {
			title: editTitle,
			description: editDesc,
			assigneeId: editAssigneeId || undefined,
			assigneeName: assignee?.name || task.assigneeName,
			assigneeRole: assignee?.role || task.assigneeRole,
			priority: editPriority,
			dependencies: editDeps,
		});
		setIsEditing(false);
	}, [onUpdate, task.id, editTitle, editDesc, editAssigneeId, editPriority, editDeps, employees, task.assigneeName, task.assigneeRole]);

	const handleCancel = useCallback(() => {
		setEditTitle(task.title);
		setEditDesc(task.description || '');
		setEditAssigneeId(task.assigneeId || '');
		setEditPriority(task.priority);
		setEditDeps(task.dependencies);
		setIsEditing(false);
	}, [task]);

	if (isEditing) {
		const otherTasks = allTasks.filter(t => t.id !== task.id);
		return (
			<div className="orch-task-item orch-task-item-editing" style={{ marginLeft: depthIndent }}>
				<div className="orch-task-edit-form">
					<div className="form-field">
						<label>任务标题</label>
						<input
							type="text"
							value={editTitle}
							onChange={(e) => setEditTitle(e.target.value)}
							placeholder="任务标题"
						/>
					</div>
					<div className="form-field">
						<label>任务描述</label>
						<textarea
							value={editDesc}
							onChange={(e) => setEditDesc(e.target.value)}
							rows={2}
							placeholder="任务描述"
						/>
					</div>
					<div className="form-field-row">
						<div className="form-field">
							<label>分配 Agent</label>
							<select value={editAssigneeId} onChange={(e) => setEditAssigneeId(e.target.value)}>
								<option value="">-- 自动创建 --</option>
								{employees.map(e => (
									<option key={e.id} value={e.id}>{e.name} ({e.role || 'Agent'})</option>
								))}
							</select>
						</div>
						<div className="form-field">
							<label>优先级</label>
							<select value={editPriority} onChange={(e) => setEditPriority(Number(e.target.value))}>
								<option value={1}>1 - 最高</option>
								<option value={2}>2 - 高</option>
								<option value={3}>3 - 中</option>
								<option value={4}>4 - 低</option>
								<option value={5}>5 - 最低</option>
							</select>
						</div>
					</div>
					{otherTasks.length > 0 && (
						<div className="form-field">
							<label>依赖任务</label>
							<div className="orch-dep-checkboxes">
								{otherTasks.map(t => (
									<label key={t.id} className="orch-dep-checkbox">
										<input
											type="checkbox"
											checked={editDeps.includes(t.id)}
											onChange={(e) => {
												if (e.target.checked) {
													setEditDeps([...editDeps, t.id]);
												} else {
													setEditDeps(editDeps.filter(id => id !== t.id));
												}
											}}
										/>
										<span>{t.title}</span>
									</label>
								))}
							</div>
						</div>
					)}
					<div className="orch-task-edit-actions">
						<button className="btn-secondary" onClick={handleCancel}>取消</button>
						<button className="btn-primary" onClick={handleSave}>保存</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="orch-task-item" style={{ marginLeft: depthIndent }}>
			<div className="orch-task-item-header">
				<span className="orch-task-status-icon">{config.icon}</span>
				<span className="orch-task-title">{task.title}</span>
				<span
					className="orch-task-status-badge"
					style={{ backgroundColor: config.color + '20', color: config.color }}
				>
					{config.label}
				</span>
				{isEditable && (
					<div className="orch-task-header-actions">
						<button
							className="orch-task-header-btn"
							onClick={() => setIsEditing(true)}
							title="编辑任务"
						>
							✏️
						</button>
						<button
							className="orch-task-header-btn"
							onClick={() => onDecompose?.(task.id)}
							disabled={isDecomposing}
							title="AI 自动拆分任务"
						>
							{isDecomposing ? '⏳' : '🔀'}
						</button>
					</div>
				)}
			</div>

			{task.description && task.description !== task.title && (
				<div className="orch-task-desc">{task.description.slice(0, 120)}{task.description.length > 120 ? '...' : ''}</div>
			)}

			<div className="orch-task-meta">
				{task.assigneeName && (
					<span className="orch-task-agent">
						{task.autoCreateAgent ? '🆕 ' : ''}
						<span className="orch-task-agent-name">{task.assigneeName}</span>
						{task.assigneeRole && <span className="orch-task-agent-role"> ({task.assigneeRole})</span>}
					</span>
				)}
				<TaskDependencyBadge deps={task.dependencies} allTasks={allTasks} />
				{task.retryCount > 0 && (
					<span className="orch-task-retry-badge">🔄 {task.retryCount}/{task.maxRetries}</span>
				)}
				{task.status === 'running' && task.timeoutMs && (
					<span className="orch-task-timeout-badge">⏱ {Math.round(task.timeoutMs / 1000)}s</span>
				)}
			</div>

			{task.error && (
				<div className="orch-task-error">❌ {task.error}</div>
			)}

			{showActions && onAction && (
				<div className="orch-task-actions">
					{(task.status === 'error' || task.status === 'cancelled') && (
						<button className="orch-task-action-btn retry" onClick={() => onAction(task.id, 'retry')} title="重做">
							🔄 重做
						</button>
					)}
					{(task.status === 'running' || task.status === 'pending') && (
						<button className="orch-task-action-btn pause" onClick={() => onAction(task.id, 'pause')} title="暂停">
							⏸ 暂停
						</button>
					)}
					{task.status === 'paused' && (
						<button className="orch-task-action-btn resume" onClick={() => onAction(task.id, 'resume')} title="恢复">
							▶ 恢复
						</button>
					)}
					{task.status !== 'done' && task.status !== 'cancelled' && (
						<button className="orch-task-action-btn cancel" onClick={() => onAction(task.id, 'cancel')} title="取消">
							✕ 取消
						</button>
					)}
					{/* Human-in-the-Loop Actions */}
					{task.status === 'done' && task.reviewStatus === 'pending' && (
						<>
							<button className="orch-task-action-btn approve" onClick={() => onAction(task.id, 'approve')} title="审核通过">
								✅ 通过
							</button>
							<button className="orch-task-action-btn reject" onClick={() => onAction(task.id, 'reject')} title="审核拒绝">
								❌ 拒绝
							</button>
						</>
					)}
					{!task.isBlocked && task.status !== 'done' && (
						<button className="orch-task-action-btn block" onClick={() => onAction(task.id, 'block')} title="阻塞任务">
							🚫 阻塞
						</button>
					)}
					{task.isBlocked && (
						<button className="orch-task-action-btn unblock" onClick={() => onAction(task.id, 'unblock')} title="解除阻塞">
							🔓 解除
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function DependencyGraph({ tasks }: { tasks: PlanTask[] }) {
	const depthGroups = useMemo(() => {
		const groups = new Map<number, PlanTask[]>();
		for (const t of tasks) {
			if (!groups.has(t.depth)) { groups.set(t.depth, []); }
			groups.get(t.depth)!.push(t);
		}
		return [...groups.entries()].sort(([a], [b]) => a - b);
	}, [tasks]);

	return (
		<div className="orch-dep-graph">
			{depthGroups.map(([depth, groupTasks]) => (
				<div key={depth} className="orch-dep-row">
					{depth > 0 && (
						<div className="orch-dep-connectors">
							{groupTasks.map(t => (
								<span key={t.id} className="orch-dep-connector">↓</span>
							))}
						</div>
					)}
					<div className="orch-dep-nodes">
						{groupTasks.map(t => {
							const config = STATUS_CONFIG[t.status] || STATUS_CONFIG.pending;
							return (
								<div key={t.id} className="orch-dep-node" style={{ borderColor: config.color }}>
									<span className="orch-dep-node-icon">{config.icon}</span>
									<span className="orch-dep-node-name">{t.assigneeName || t.title.slice(0, 15)}</span>
								</div>
							);
						})}
					</div>
				</div>
			))}
		</div>
	);
}

// ─── Main Inline View ───────────────────────────────────────────────────────

interface OrchestrationPlanViewProps {
	onClose?: () => void;
}

export function OrchestrationPlanView({ onClose }: OrchestrationPlanViewProps): React.ReactElement {
	const {
		activePlan,
		isLoading,
		error,
		createPlan,
		approvePlan,
		approveWithoutExecute,
		rejectPlan,
		taskAction,
		approveTask,
		rejectTask,
		commentTask,
		blockTask,
		unblockTask,
		updatePlan,
		updateTask,
		decomposeTask,
		closePlanDialog,
	} = useOrchestrationStore();

	// When closing a pending_approval plan, reject it first.
	// For other statuses, just close the dialog.
	const handleClose = useCallback(async () => {
		if (activePlan?.status === 'pending_approval') {
			await rejectPlan(activePlan.id);
		} else {
			closePlanDialog();
		}
		onClose?.();
	}, [activePlan, rejectPlan, closePlanDialog, onClose]);
	const { activeWorkspaceId } = useWorkspaceStore();
	const { employees, getPlanners } = useEmployeeStore();

	const [goal, setGoal] = useState('');
	const [selectedPlannerId, setSelectedPlannerId] = useState<string>('');
	const [viewMode, setViewMode] = useState<'list' | 'graph'>('list');
	const [decomposingTaskId, setDecomposingTaskId] = useState<string | null>(null);
	const [isEditingGoal, setIsEditingGoal] = useState(false);
	const [editGoal, setEditGoal] = useState('');

	const isPendingApproval = activePlan?.status === 'pending_approval';
	const isExecuting = activePlan?.status === 'executing' || activePlan?.status === 'approved';

	const planners = useMemo(() => getPlanners(), [employees]);
	const hasPlanners = planners.length > 0;

	useEffect(() => {
		if (planners.length === 1 && !selectedPlannerId) {
			setSelectedPlannerId(planners[0].id);
		}
	}, [planners, selectedPlannerId]);

	const handleCreatePlan = useCallback(async () => {
		if (!goal.trim() || !activeWorkspaceId || !selectedPlannerId) { return; }
		await createPlan(goal, activeWorkspaceId, selectedPlannerId);
	}, [goal, activeWorkspaceId, selectedPlannerId, createPlan]);

	const handleApprove = useCallback(async () => {
		if (!activePlan) { return; }
		await approvePlan(activePlan.id);
	}, [activePlan, approvePlan]);

	const handleApproveWithoutExecute = useCallback(async () => {
		if (!activePlan) { return; }
		await approveWithoutExecute(activePlan.id);
	}, [activePlan, approveWithoutExecute]);

	const handleReject = useCallback(async () => {
		if (!activePlan) { return; }
		await rejectPlan(activePlan.id);
	}, [activePlan, rejectPlan]);

	// Edit plan goal
	const handleStartEditGoal = useCallback(() => {
		if (!activePlan) { return; }
		setEditGoal(activePlan.goal);
		setIsEditingGoal(true);
	}, [activePlan]);

	const handleSaveGoal = useCallback(async () => {
		if (!activePlan || !editGoal.trim()) { return; }
		await updatePlan(activePlan.id, { goal: editGoal.trim() });
		setIsEditingGoal(false);
	}, [activePlan, editGoal, updatePlan]);

	const handleCancelEditGoal = useCallback(() => {
		setIsEditingGoal(false);
		setEditGoal('');
	}, []);

	const handleTaskAction = useCallback(async (taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => {
		if (!activePlan) { return; }

		switch (action) {
			case 'approve':
				await approveTask(activePlan.id, taskId);
				break;
			case 'reject':
				await rejectTask(activePlan.id, taskId);
				break;
			case 'block':
				await blockTask(activePlan.id, taskId);
				break;
			case 'unblock':
				await unblockTask(activePlan.id, taskId);
				break;
			default:
				await taskAction(activePlan.id, taskId, action);
				break;
		}
	}, [activePlan, taskAction, approveTask, rejectTask, blockTask, unblockTask]);

	const handleUpdateTask = useCallback(async (taskId: string, updates: Record<string, unknown>) => {
		if (!activePlan) { return; }
		await updateTask(activePlan.id, taskId, updates);
	}, [activePlan, updateTask]);

	const handleDecomposeTask = useCallback(async (taskId: string) => {
		if (!activePlan || !activeWorkspaceId) { return; }
		// Use selected planner, or fall back to the plan's own plannerId
		const effectivePlannerId = selectedPlannerId || activePlan.plannerId;
		if (!effectivePlannerId) { return; }
		setDecomposingTaskId(taskId);
		try {
			await decomposeTask(activePlan.id, taskId, activeWorkspaceId, effectivePlannerId);
		} finally {
			setDecomposingTaskId(null);
		}
	}, [activePlan, activeWorkspaceId, selectedPlannerId, decomposeTask]);

	const planStatusConfig = activePlan ? PLAN_STATUS_CONFIG[activePlan.status] : null;

	const plannerName = activePlan
		? employees.find(e => e.id === activePlan.plannerId)?.name || 'Unknown Planner'
		: '';

	const stats = useMemo(() => {
		if (!activePlan) { return null; }
		const tasks = activePlan.tasks;
		return {
			total: tasks.length,
			pending: tasks.filter(t => t.status === 'pending').length,
			running: tasks.filter(t => t.status === 'running').length,
			done: tasks.filter(t => t.status === 'done').length,
			autoCreate: tasks.filter(t => t.autoCreateAgent).length,
			agents: new Set(tasks.map(t => t.assigneeName)).size,
		};
	}, [activePlan]);

	return (
		<div className="orch-plan-inline">
			{/* Header */}
			<div className="orch-dialog-header">
				<h3>任务编排</h3>
				{activePlan && planStatusConfig && (
					<span
						className="orch-plan-status-badge"
						style={{ backgroundColor: planStatusConfig.color + '20', color: planStatusConfig.color }}
					>
						{planStatusConfig.label}
					</span>
				)}
			{onClose && (
				<button className="orch-inline-close" onClick={handleClose} title={activePlan?.status === 'pending_approval' ? '拒绝并关闭' : '关闭'}>✕</button>
			)}
			</div>

			{/* Goal input (only if no active plan) */}
			{!activePlan && (
				<>
					<p className="orch-dialog-hint">
						描述你的目标，Planner 会自动拆分为子任务、创建 Agent、建立依赖关系和连线，然后开始调度执行。
					</p>

					<div className="orch-role-status">
						<div className={`orch-role-badge ${hasPlanners ? 'ok' : 'missing'}`}>
							{hasPlanners ? '✅' : '⚠️'} Planner: {hasPlanners ? `${planners.length} 个可用` : '未创建 — 请先创建一个 agentType=planner 的 Agent'}
						</div>
					</div>

					{hasPlanners && (
						<div className="form-field">
							<label>选择 Planner</label>
							<select
								value={selectedPlannerId}
								onChange={(e) => setSelectedPlannerId(e.target.value)}
							>
								<option value="">-- 选择 Planner Agent --</option>
								{planners.map(p => (
									<option key={p.id} value={p.id}>{p.name} ({p.role})</option>
								))}
							</select>
						</div>
					)}

					<div className="form-field">
						<label>目标描述</label>
						<textarea
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							rows={3}
							placeholder="例如：设计一个用户认证系统，包含登录、注册、密码重置功能..."
							autoFocus
							disabled={!hasPlanners}
						/>
					</div>

					{error && (
						<div className="orch-error-banner">❌ {error}</div>
					)}

					<div className="form-actions">
						{onClose && (
							<button type="button" className="btn-secondary" onClick={handleClose}>取消</button>
						)}
						<button
							type="button"
							className="btn-primary"
							onClick={handleCreatePlan}
							disabled={isLoading || !goal.trim() || !activeWorkspaceId || !selectedPlannerId}
						>
							{isLoading ? '分析中...' : '生成计划'}
						</button>
					</div>
				</>
			)}

			{/* Plan preview */}
			{activePlan && (
				<>
					<div className="orch-plan-summary">
						{isEditingGoal ? (
							<div className="orch-plan-goal-edit">
								<div className="form-field">
									<label>目标描述</label>
									<textarea
										value={editGoal}
										onChange={(e) => setEditGoal(e.target.value)}
										rows={2}
										placeholder="描述任务目标..."
										autoFocus
									/>
								</div>
								<div className="orch-goal-edit-actions">
									<button className="btn-secondary" onClick={handleCancelEditGoal}>取消</button>
									<button className="btn-primary" onClick={handleSaveGoal}>保存</button>
								</div>
							</div>
						) : (
							<div className="orch-plan-goal">
								<strong>目标:</strong> {activePlan.goal}
								{isPendingApproval && (
									<button
										className="orch-edit-goal-btn"
										onClick={handleStartEditGoal}
										title="编辑目标"
									>
										✏️
									</button>
								)}
							</div>
						)}
						<div className="orch-plan-desc">
							{activePlan.summary.replace(/[。\s]*⚠️?\s*无\s*PM/g, '')}
						</div>

						<div className="orch-plan-roles">
							<span className="orch-role-tag planner">📐 Planner: {plannerName}</span>
						</div>

						{stats && (
							<div className="orch-plan-stats">
								<span className="orch-stat">📋 {stats.total} 任务</span>
								<span className="orch-stat">🤖 {stats.agents} Agent</span>
								{stats.autoCreate > 0 && (
									<span className="orch-stat">🆕 {stats.autoCreate} 新建</span>
								)}
								{stats.running > 0 && (
									<span className="orch-stat">⚡ {stats.running} 执行中</span>
								)}
								{stats.done > 0 && (
									<span className="orch-stat">✅ {stats.done} 完成</span>
								)}
							</div>
						)}
					</div>

					<div className="orch-view-toggle">
						<button
							className={`orch-view-btn ${viewMode === 'list' ? 'active' : ''}`}
							onClick={() => setViewMode('list')}
						>
							列表视图
						</button>
						<button
							className={`orch-view-btn ${viewMode === 'graph' ? 'active' : ''}`}
							onClick={() => setViewMode('graph')}
						>
							依赖图
						</button>
					</div>

					{viewMode === 'list' ? (
						<div className="orch-task-list">
					{activePlan.tasks
						.sort((a, b) => a.depth - b.depth || a.priority - b.priority)
						.map(task => (
							<PlanTaskItem
								key={task.id}
								task={task}
								allTasks={activePlan.tasks}
								showActions={isExecuting}
								onAction={handleTaskAction}
								isEditable={isPendingApproval}
								employees={employees}
								onUpdate={handleUpdateTask}
								onDecompose={handleDecomposeTask}
								isDecomposing={decomposingTaskId === task.id}
							/>
						))}
						</div>
					) : (
						<DependencyGraph tasks={activePlan.tasks} />
					)}

					{error && (
						<div className="orch-error-banner">❌ {error}</div>
					)}

					<div className="form-actions">
						{isPendingApproval && (
							<>
								<button
									type="button"
									className="btn-secondary"
									onClick={handleReject}
									disabled={isLoading}
								>
									❌ 拒绝计划
								</button>
								<button
									type="button"
									className="btn-secondary"
									onClick={handleApproveWithoutExecute}
									disabled={isLoading}
									title="批准计划，创建任务到看板，但不自动执行"
								>
									📋 批准（仅拆分）
								</button>
								<button
									type="button"
									className="btn-primary"
									onClick={handleApprove}
									disabled={isLoading}
									title='批准并开始调度'
								>
									{isLoading ? '执行中...' : '✅ 批准并执行'}
								</button>
							</>
						)}
						{!isPendingApproval && onClose && (
							<button type="button" className="btn-secondary" onClick={handleClose}>
								关闭
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
}
