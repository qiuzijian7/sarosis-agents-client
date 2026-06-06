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

	return (
		<div
			className="wf-node"
			style={{
				position: 'relative',
				padding: '12px 14px',
				borderRadius: '8px',
				border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : color}`,
				backgroundColor: 'var(--vscode-editor-background)',
				minWidth: '160px',
				maxWidth: '280px',
				fontSize: '13px',
				lineHeight: '1.5',
				color: 'var(--vscode-foreground)',
				boxShadow: selected ? '0 0 0 1px var(--vscode-focusBorder)' : undefined,
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
