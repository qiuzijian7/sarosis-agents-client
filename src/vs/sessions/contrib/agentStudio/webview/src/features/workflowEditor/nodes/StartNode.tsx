import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const StartNode: React.FC<NodeProps> = React.memo(({ data, selected }) => {
	const label = (data as Record<string, unknown>).label as string || 'Start';
	return (
		<div style={{
			padding: '10px 20px',
			borderRadius: '20px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#22c55e'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			fontSize: '13px',
			fontWeight: 600,
			color: '#22c55e',
		}}>
			{label}
			<Handle type="source" position={Position.Right} id="out"
				style={{ width: 10, height: 10, backgroundColor: '#22c55e', border: '2px solid var(--vscode-editor-background)' }} />
		</div>
	);
});
StartNode.displayName = 'StartNode';
