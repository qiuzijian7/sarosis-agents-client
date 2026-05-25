/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Confirmation Card Component
 *
 *  Displays confirmation request with Approve/Reject buttons
 *  Mirrors VS Code's chatConfirmationContentPart.ts pattern
 *
 *  Supports plan-approval type: shows structured plan tasks for review,
 *  with "批准并执行" (approve + auto-execute) and "仅批准" (approve without execute).
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useState } from 'react';

export interface ConfirmationRequest {
	id: string;
	title: string;
	message: string;
	detail?: string;
	buttons: ConfirmationButton[];
	status: 'pending' | 'approved' | 'rejected' | 'cancelled';
	icon?: string;
	/** Plan-mode specific fields */
	type?: 'plan-approval';
	planSummary?: string;
	tasks?: Array<{
		title: string;
		description: string;
		files?: string[];
		complexity?: 'low' | 'medium' | 'high';
		suggestedRole?: string;
		dependencies?: number[];
	}>;
	nextMode?: 'craft' | 'ask';
}

export interface ConfirmationButton {
	id: string;
	label: string;
	tooltip?: string;
	primary?: boolean; // true = primary button (blue), false = secondary (grey)
	danger?: boolean; // true = danger style (red)
	icon?: string;
}

interface ConfirmationCardProps {
	confirmation: ConfirmationRequest;
	onApprove?: (buttonId: string) => void;
	onReject?: () => void;
	collapsed?: boolean;
}

const COMPLEXITY_LABELS: Record<string, { label: string; color: string }> = {
	low: { label: '低', color: '#34d399' },
	medium: { label: '中', color: '#fbbf24' },
	high: { label: '高', color: '#f87171' },
};

const STATUS_DISPLAY: Record<string, { icon: string; text: string }> = {
	approved: { icon: '✓', text: '已批准 — 正在创建 Agent 并执行...' },
	rejected: { icon: '✕', text: '已拒绝' },
	cancelled: { icon: '−', text: '已取消' },
};

export const ConfirmationCard = memo(function ConfirmationCard({
	confirmation,
	onApprove,
	onReject,
	collapsed = false,
}: ConfirmationCardProps): React.ReactElement {
	const [isCollapsed, setIsCollapsed] = useState(collapsed);
	const [isSubmitted, setIsSubmitted] = useState(confirmation.status !== 'pending');

	const handleApprove = (buttonId: string) => {
		setIsSubmitted(true);
		onApprove?.(buttonId);
	};

	const handleReject = () => {
		setIsSubmitted(true);
		onReject?.();
	};

	if (isSubmitted) {
		const display = STATUS_DISPLAY[confirmation.status] || STATUS_DISPLAY.cancelled;
		return (
			<div className="confirmation-card submitted">
				<div className="confirmation-header">
					<span className="confirmation-icon">{display.icon}</span>
					<span className="confirmation-title">{display.text}</span>
				</div>
			</div>
		);
	}

	const isPlanApproval = confirmation.type === 'plan-approval';

	return (
		<div className={`confirmation-card${isPlanApproval ? ' plan-approval' : ''}`}>
			<div className="confirmation-header">
				<span className="confirmation-icon">{confirmation.icon || (isPlanApproval ? '📋' : '⚠️')}</span>
				<span className="confirmation-title">{confirmation.title}</span>
				<span
					className={`confirmation-toggle ${isCollapsed ? 'collapsed' : ''}`}
					onClick={() => setIsCollapsed(!isCollapsed)}
					role="button"
					aria-expanded={!isCollapsed}
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>
			{!isCollapsed && (
				<div className="confirmation-body">
					{isPlanApproval && confirmation.planSummary ? (
						<>
							<div className="confirmation-message">{confirmation.planSummary}</div>
							{confirmation.tasks && confirmation.tasks.length > 0 && (
								<div className="plan-tasks">
									{confirmation.tasks.map((task, i) => (
										<div key={i} className="plan-task-item">
											<div className="plan-task-header">
												<span className="plan-task-index">{i + 1}</span>
												<span className="plan-task-title">{task.title}</span>
												{task.complexity && (
													<span
														className="plan-task-complexity"
														style={{ color: COMPLEXITY_LABELS[task.complexity]?.color }}
													>
														{COMPLEXITY_LABELS[task.complexity]?.label || task.complexity}
													</span>
												)}
												{task.suggestedRole && (
													<span className="plan-task-role">{task.suggestedRole}</span>
												)}
											</div>
											<div className="plan-task-desc">{task.description}</div>
											{task.files && task.files.length > 0 && (
												<div className="plan-task-files">
													{task.files.map((f, j) => (
														<span key={j} className="plan-task-file">{f}</span>
													))}
												</div>
											)}
											{task.dependencies && task.dependencies.length > 0 && (
												<div className="plan-task-deps">
													依赖: {task.dependencies.map(d => `#${d + 1}`).join(', ')}
												</div>
											)}
										</div>
									))}
								</div>
							)}
							{confirmation.nextMode && (
								<div className="plan-next-mode">
									执行模式: <strong>{confirmation.nextMode === 'craft' ? 'Craft (Agent)' : 'Ask (问答)'}</strong>
								</div>
							)}
						</>
					) : (
						<>
							<div className="confirmation-message">{confirmation.message}</div>
							{confirmation.detail && (
								<div className="confirmation-detail">{confirmation.detail}</div>
							)}
						</>
					)}
					<div className="confirmation-buttons">
						{isPlanApproval ? (
							// Plan-approval: show approve+execute and approve-only buttons
							<>
								<button
									className="confirmation-btn primary"
									title="批准计划，自动创建 Agent 实例并执行所有任务"
									onClick={() => handleApprove('approve-execute')}
								>
									<span className="btn-icon">🚀</span>
									批准并执行
								</button>
								<button
									className="confirmation-btn"
									title="批准计划，创建任务到看板但不自动执行"
									onClick={() => handleApprove('approve-only')}
								>
									仅批准
								</button>
							</>
						) : (
							// Standard confirmation: use the provided buttons
							confirmation.buttons.map((btn) => (
								<button
									key={btn.id}
									className={`confirmation-btn ${btn.primary ? 'primary' : ''} ${btn.danger ? 'danger' : ''}`}
									title={btn.tooltip}
									onClick={() => handleApprove(btn.id)}
								>
									{btn.icon && <span className="btn-icon">{btn.icon}</span>}
									{btn.label}
								</button>
							))
						)}
						<button className="confirmation-btn secondary" onClick={handleReject}>
							拒绝
						</button>
					</div>
				</div>
			)}
		</div>
	);
});
