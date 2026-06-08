/*---------------------------------------------------------------------------------------------
 *  ConfirmDialog — generic confirmation dialog for node/edge deletion.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

interface ConfirmDialogProps {
	open: boolean;
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
	open,
	title,
	message,
	confirmLabel = 'Delete',
	cancelLabel = 'Cancel',
	onConfirm,
	onCancel,
}) => {
	if (!open) { return null; }

	return (
		<div style={{
			position: 'absolute',
			inset: 0,
			zIndex: 100,
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			backgroundColor: 'rgba(0,0,0,0.4)',
		}} onClick={onCancel}>
			<div style={{
				backgroundColor: 'var(--vscode-editor-background)',
				border: '1px solid var(--vscode-panel-border)',
				borderRadius: '8px',
				padding: '20px 24px',
				minWidth: '320px',
				maxWidth: '420px',
				boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
			}} onClick={e => e.stopPropagation()}>
				<h3 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: 600, color: 'var(--vscode-foreground)' }}>
					{title}
				</h3>
				<p style={{ margin: '0 0 20px', fontSize: '13px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.5 }}>
					{message}
				</p>
				<div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
					<button
						onClick={onCancel}
						style={{
							padding: '5px 14px',
							border: '1px solid var(--vscode-button-border)',
							borderRadius: '4px',
							backgroundColor: 'transparent',
							color: 'var(--vscode-foreground)',
							cursor: 'pointer',
							fontSize: '12px',
						}}
					>
						{cancelLabel}
					</button>
					<button
						onClick={onConfirm}
						style={{
							padding: '5px 14px',
							border: '1px solid var(--vscode-inputValidation-errorBorder)',
							borderRadius: '4px',
							backgroundColor: 'var(--vscode-inputValidation-errorBackground)',
							color: 'var(--vscode-inputValidation-errorForeground)',
							cursor: 'pointer',
							fontSize: '12px',
							fontWeight: 500,
						}}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
};
