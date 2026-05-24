/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Progress Card Component
 *
 *  Displays task execution progress with spinner/checkmark icons
 *  Mirrors VS Code's chatProgressContentPart.ts pattern
 *--------------------------------------------------------------------------------------------*/

import React, { memo } from 'react';

export interface ProgressMessage {
	id: string;
	content: string;
	status: 'pending' | 'in-progress' | 'completed' | 'error';
	icon?: 'spinner' | 'check' | 'warning' | 'error';
	timestamp?: string;
}

interface ProgressCardProps {
	progress: ProgressMessage | ProgressMessage[];
	showSpinner?: boolean;
	collapsible?: boolean;
	defaultExpanded?: boolean;
}

export const ProgressCard = memo(function ProgressCard({
	progress,
	showSpinner = true,
	collapsible = false,
	defaultExpanded = true,
}: ProgressCardProps): React.ReactElement {
	const [isExpanded, setIsExpanded] = React.useState(defaultExpanded);

	const progressList = Array.isArray(progress) ? progress : [progress];

	if (progressList.length === 0) { return <></>; }

	const getIcon = (status: ProgressMessage['status'], icon?: string): React.ReactNode => {
		if (icon === 'spinner' || status === 'in-progress') {
			return (
				<svg className="progress-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<path d="M21 12a9 9 0 11-6.219-8.56" />
				</svg>
			);
		}
		if (icon === 'warning' || status === 'error') {
			return <span className="progress-icon-warning">⚠️</span>;
		}
		if (status === 'completed') {
			return <span className="progress-icon-check">✓</span>;
		}
		return <span className="progress-icon-pending">○</span>;
	};

	const renderProgressItem = (item: ProgressMessage) => (
		<div key={item.id} className={`progress-step ${item.status}`}>
			<span className="progress-icon">
				{getIcon(item.status, item.icon)}
			</span>
			<span className="progress-content">
				{item.content}
			</span>
			{item.timestamp && (
				<span className="progress-timestamp">
					{new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
				</span>
			)}
		</div>
	);

	if (collapsible && progressList.length > 1) {
		return (
			<div className="progress-card collapsible">
				<div
					className="progress-header"
					onClick={() => setIsExpanded(!isExpanded)}
					role="button"
					aria-expanded={isExpanded}
				>
					<span className="progress-header-icon">
						{showSpinner && progressList.some(p => p.status === 'in-progress') ? (
							<svg className="progress-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<path d="M21 12a9 9 0 11-6.219-8.56" />
							</svg>
						) : (
							<span className="progress-icon-check">✓</span>
						)}
					</span>
					<span className="progress-header-title">
						{progressList.filter(p => p.status === 'completed').length}/{progressList.length} 步骤完成
					</span>
					<span className={`progress-toggle ${isExpanded ? '' : 'collapsed'}`}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</span>
				</div>
				{isExpanded && (
					<div className="progress-list">
						{progressList.map(renderProgressItem)}
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="progress-card">
			{progressList.map(renderProgressItem)}
		</div>
	);
});
