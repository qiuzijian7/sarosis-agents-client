/*---------------------------------------------------------------------------------------------
 *  Shared BaseNode component — provides common styling and DeleteButton.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface BaseNodeData {
	label?: string;
	[key: string]: unknown;
}

interface BaseNodeProps extends NodeProps {
	children: React.ReactNode;
	color: string;
	/** Which handles to render; default both */
	handles?: { target?: boolean; source?: boolean };
	sourceHandleIds?: string[];
}

export const BaseNode: React.FC<BaseNodeProps> = ({
	id,
	data,
	selected,
	children,
	color,
	handles,
	sourceHandleIds,
}) => {
	const showTarget = handles?.target !== false;
	const showSource = handles?.source !== false;
	const sources = sourceHandleIds || ['output'];

	// Execution state highlighting (P3)
	const isCurrentNode = (data as Record<string, unknown>).isCurrentNode as boolean | undefined;
	const executionState = (data as Record<string, unknown>).executionState as string | undefined;
	const executionError = (data as Record<string, unknown>).executionError as string | undefined;

	// Border color: selected > current > default
	const borderColor = selected
		? 'var(--vscode-focusBorder)'
		: isCurrentNode
			? '#22c55e' // green for current executing node
			: color;

	// Background color: error > success > default
	const backgroundColor = executionError
		? 'rgba(239, 68, 68, 0.1)' // red tint for error
		: executionState === 'completed'
			? 'rgba(34, 197, 94, 0.1)' // green tint for completed
			: 'var(--vscode-editor-background)';

	return (
		<div
			className={`wf-node${isCurrentNode ? ' wf-node-current' : ''}${executionError ? ' wf-node-error' : ''}`}
			style={{
				position: 'relative',
				padding: '12px 14px',
				borderRadius: '8px',
				border: `2px solid ${borderColor}`,
				backgroundColor,
				minWidth: '160px',
				maxWidth: '280px',
				fontSize: '13px',
				lineHeight: '1.5',
				color: 'var(--vscode-foreground)',
				boxShadow: selected
					? '0 0 0 1px var(--vscode-focusBorder)'
					: isCurrentNode
						? '0 0 0 2px #22c55e, 0 0 8px rgba(34, 197, 94, 0.4)'
						: undefined,
				// Pulse animation for current node
				...(isCurrentNode ? { animation: 'wf-pulse 2s infinite' } : {}),
			}}
		>
			{children}
			{showTarget && (
				<Handle
					type="target"
					position={Position.Left}
					id="input"
					style={{
						width: '10px',
						height: '10px',
						backgroundColor: color,
						border: '2px solid var(--vscode-editor-background)',
					}}
				/>
			)}
			{showSource && sources.map((sid, i) => (
				<Handle
					key={sid}
					type="source"
					position={Position.Right}
					id={sid}
					style={{
						width: '10px',
						height: '10px',
						backgroundColor: color,
						border: '2px solid var(--vscode-editor-background)',
						top: sources.length > 1 ? `${((i + 1) / (sources.length + 1)) * 100}%` : '50%',
					}}
				/>
			))}
		</div>
	);
};
