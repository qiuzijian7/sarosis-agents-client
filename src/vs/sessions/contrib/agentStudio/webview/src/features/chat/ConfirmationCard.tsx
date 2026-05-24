/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Confirmation Card Component
 *
 *  Displays confirmation request with Approve/Reject buttons
 *  Mirrors VS Code's chatConfirmationContentPart.ts pattern
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
		return (
			<div className="confirmation-card submitted">
				<div className="confirmation-header">
					<span className="confirmation-icon">
						{confirmation.status === 'approved' ? '✓' : confirmation.status === 'rejected' ? '✕' : '−'}
					</span>
					<span className="confirmation-title">
						{confirmation.status === 'approved' ? '已批准' : confirmation.status === 'rejected' ? '已拒绝' : '已取消'}
					</span>
				</div>
			</div>
		);
	}

	return (
		<div className="confirmation-card">
			<div className="confirmation-header">
				<span className="confirmation-icon">{confirmation.icon || '⚠️'}</span>
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
					<div className="confirmation-message">{confirmation.message}</div>
					{confirmation.detail && (
						<div className="confirmation-detail">{confirmation.detail}</div>
					)}
					<div className="confirmation-buttons">
						{confirmation.buttons.map((btn) => (
							<button
								key={btn.id}
								className={`confirmation-btn ${btn.primary ? 'primary' : ''} ${btn.danger ? 'danger' : ''}`}
								title={btn.tooltip}
								onClick={() => handleApprove(btn.id)}
							>
								{btn.icon && <span className="btn-icon">{btn.icon}</span>}
								{btn.label}
							</button>
						))}
						<button className="confirmation-btn secondary" onClick={handleReject}>
							拒绝
						</button>
					</div>
				</div>
			)}
		</div>
	);
});
