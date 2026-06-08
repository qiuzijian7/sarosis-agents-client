/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Orchestration Plan Inline (Chat Message)
 *  Inline plan approval panel embedded inside a chat message bubble.
 *  Shows the planner's decomposition for user approval/rejection.
 *---------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
	useOrchestrationStore,
	type OrchestrationPlan,
	type PlanTask,
} from '../../store/useOrchestrationStore';
import { useAgentStore } from '../../store/useAgentStore';
import { sendRequest } from '../../bridge/messageClient';

// ─── Status styling ─────────────────────────────────────────────────────────

const PLAN_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
	pending_approval: { label: '等待确认', color: '#f59e0b' },
	approved: { label: '已批准', color: '#3b82f6' },
	executing: { label: '执行中', color: '#3b82f6' },
	completed: { label: '已完成', color: '#10b981' },
	rejected: { label: '已拒绝', color: '#6b7280' },
	error: { label: '执行错误', color: '#ef4444' },
};

// ─── Sub-components ───────────────────────────────────────────────────────

function PlanTaskMini({ task }: { task: PlanTask }) {
	const statusConfig = PLAN_STATUS_CONFIG[task.status] || { label: task.status, color: '#6b7280' };
	
	return (
		<div className="orch-plan-inline-task">
			<span className="orch-plan-inline-task-status" style={{ color: statusConfig.color }}>
				{task.status === 'pending' ? '⏳' : task.status === 'running' ? '⚡' : task.status === 'done' ? '✅' : '❌'}
			</span>
			<span className="orch-plan-inline-task-title">{task.title}</span>
			{task.assigneeName && (
				<span className="orch-plan-inline-task-agent">👤 {task.assigneeName}</span>
			)}
		</div>
	);
}

// ─── Main Inline Component ───────────────────────────────────────────────

interface OrchestrationPlanInlineProps {
	planId: string;
	onClose?: () => void;
}

export function OrchestrationPlanInline({ planId, onClose }: OrchestrationPlanInlineProps): React.ReactElement | null {
	// IMPORTANT: subscribe to the raw `plans` array (stable reference between
	// store updates) and derive the matching plan with useMemo. Returning the
	// result of `.find(...)` directly from a Zustand selector returns a stable
	// object reference today, but if upstream code ever starts replacing plan
	// objects on every event update, the selector would return a fresh ref each
	// render and trip React 19's getSnapshot equality check (error #185
	// "Maximum update depth exceeded"). useMemo closes that risk.
	const plans = useOrchestrationStore(s => s.plans);
	const plan = useMemo(
		() => plans.find(p => p.id === planId),
		[plans, planId],
	);
	const { isLoading, error, approvePlan, rejectPlan } = useOrchestrationStore();
	const { agents } = useAgentStore();

	// Fallback: subscribe to the custom event dispatched by index.tsx when
	// the host pushes an orchestration.planUpdated event. This ensures the
	// component re-renders even if the Zustand selector somehow misses the
	// change (e.g. stale closure over planId).
	const [, forceUpdate] = useState(0);
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as OrchestrationPlan | undefined;
			if (detail && detail.id === planId) {
				console.log(`[OrchestrationPlanInline] planUpdated event for ${planId}, status=${detail.status}`);
				forceUpdate(n => n + 1);
			}
		};
		window.addEventListener('agentStudio:orchestration-plan-updated', handler);
		return () => window.removeEventListener('agentStudio:orchestration-plan-updated', handler);
	}, [planId]);

	const isPendingApproval = plan?.status === 'pending_approval';
	const isExecuting = plan?.status === 'executing' || plan?.status === 'approved';

	const handleApprove = useCallback(async () => {
		if (!plan) { return; }
		await approvePlan(plan.id);
	}, [plan, approvePlan]);

	const handleReject = useCallback(async () => {
		if (!plan) { return; }
		await rejectPlan(plan.id);
	}, [plan, rejectPlan]);

	const planStatusConfig = plan ? PLAN_STATUS_CONFIG[plan.status] : null;

	const plannerName = plan
		? agents.find(e => e.id === plan.plannerId)?.name || 'Unknown Planner'
		: '';

	const stats = useMemo(() => {
		if (!plan) { return null; }
		const tasks = plan.tasks.filter((t): t is NonNullable<typeof t> => t != null);
		return {
			total: tasks.length,
			pending: tasks.filter(t => t && t.status === 'pending').length,
			running: tasks.filter(t => t && t.status === 'running').length,
			done: tasks.filter(t => t && t.status === 'done').length,
			agents: new Set(tasks.filter(t => t != null).map(t => t.assigneeName)).size,
		};
	}, [plan]);

	if (!plan) {
		return (
			<div className="orch-plan-inline orch-plan-inline-not-found">
				<div className="orch-plan-inline-header">
					<span className="orch-plan-inline-title">⚠️ 计划未找到</span>
				</div>
				<p>计划 ID: {planId}</p>
			</div>
		);
	}

	return (
		<div className="orch-plan-inline">
			{/* Header */}
			<div className="orch-plan-inline-header">
				<span className="orch-plan-inline-title">📋 任务计划</span>
				{planStatusConfig && (
					<span
						className="orch-plan-status-badge"
						style={{ backgroundColor: planStatusConfig.color + '20', color: planStatusConfig.color }}
					>
						{planStatusConfig.label}
					</span>
				)}
				{onClose && (
					<button className="orch-inline-close" onClick={onClose} title="关闭">✕</button>
				)}
			</div>

			{/* Plan summary */}
			<div className="orch-plan-inline-summary">
				<div className="orch-plan-inline-goal">
					<strong>目标:</strong>{' '}
					<span
						className="orch-plan-goal-link"
						title="点击打开任务看板"
						onClick={() => {
							sendRequest('taskBoard.openOverview', { taskTitle: plan.goal }).catch(err => {
								console.warn('[OrchestrationPlanInline] Failed to open task overview:', err);
							});
						}}
					>
						{plan.goal}
					</span>
				</div>
				<div className="orch-plan-inline-desc">
					{plan.summary.replace(/[。\s]*⚠️?\s*无\s*PM/g, '')}
				</div>

			<div className="orch-plan-inline-roles">
				<span className="orch-role-tag planner">📐 Planner: {plannerName}</span>
			</div>

				{stats && (
					<div className="orch-plan-inline-stats">
						<span className="orch-stat">📋 {stats.total} 任务</span>
						<span className="orch-stat">🤖 {stats.agents} Agent</span>
						{stats.running > 0 && (
							<span className="orch-stat">⚡ {stats.running} 执行中</span>
						)}
						{stats.done > 0 && (
							<span className="orch-stat">✅ {stats.done} 完成</span>
						)}
					</div>
				)}
			</div>

			{/* Task list (mini) */}
			<div className="orch-plan-inline-tasks">
				{plan.tasks
					.filter((t): t is NonNullable<typeof t> => t != null)
					.sort((a, b) => a.depth - b.depth || a.priority - b.priority)
					.slice(0, 5)  // Show only first 5 tasks in inline view
					.map(task => (
						<PlanTaskMini key={task.id} task={task} />
					))}
				{plan.tasks.filter((t): t is NonNullable<typeof t> => t != null).length > 5 && (
					<div className="orch-plan-inline-more">
						... 还有 {plan.tasks.filter((t): t is NonNullable<typeof t> => t != null).length - 5} 个任务（请在任务看板中查看完整列表）
					</div>
				)}
			</div>

			{/* Error banner */}
			{error && (
				<div className="orch-error-banner">❌ {error}</div>
			)}

			{/* Action buttons */}
			<div className="orch-plan-inline-actions">
				{isPendingApproval && (
					<>
						<button
							type="button"
							className="btn-secondary"
							onClick={handleReject}
							disabled={isLoading}
						>
							❌ 拒绝
						</button>
						<button
							type="button"
							className="btn-primary"
							onClick={handleApprove}
							disabled={isLoading}
						>
							{isLoading ? '执行中...' : '✅ 批准执行'}
						</button>
					</>
				)}
				{!isPendingApproval && (
					<div className="orch-plan-inline-status-message">
						{plan.status === 'approved' && '✅ 计划已批准，正在执行...'}
						{plan.status === 'executing' && '⚡ 计划执行中...'}
						{plan.status === 'completed' && '✅ 计划已完成'}
						{plan.status === 'rejected' && '❌ 计划已拒绝'}
						{plan.status === 'error' && '❌ 计划执行出错'}
					</div>
				)}
			</div>
		</div>
	);
}
