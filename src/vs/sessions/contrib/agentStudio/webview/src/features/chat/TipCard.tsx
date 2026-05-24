/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Tip Card Component
 *
 *  Displays a dismissible tip message
 *  Mirrors VS Code's chatTipContentPart.ts pattern
 *--------------------------------------------------------------------------------------------*/

import React, { memo } from 'react';

export interface TipMessage {
	id: string;
	content: string;
	icon?: string;
	action?: {
		label: string;
		tooltip?: string;
		onClick: () => void;
	};
}

interface TipCardProps {
	tip: TipMessage;
	onDismiss?: (id: string) => void;
}

export const TipCard = memo(function TipCard({
	tip,
	onDismiss,
}: TipCardProps): React.ReactElement | null {
	const [dismissed, setDismissed] = React.useState(false);

	if (dismissed) { return null; }

	const handleDismiss = () => {
		setDismissed(true);
		onDismiss?.(tip.id);
	};

	return (
		<div className="tip-card">
			<span className="tip-icon">{tip.icon || '💡'}</span>
			<span className="tip-content">{tip.content}</span>
			{tip.action && (
				<button
					className="tip-action-btn"
					title={tip.action.tooltip}
					onClick={tip.action.onClick}
				>
					{tip.action.label}
				</button>
			)}
			<button
				className="tip-dismiss-btn"
				onClick={handleDismiss}
				title="关闭提示"
				aria-label="关闭提示"
			>
				×
			</button>
		</div>
	);
});
