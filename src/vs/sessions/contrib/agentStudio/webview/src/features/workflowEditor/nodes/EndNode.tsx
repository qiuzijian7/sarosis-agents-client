import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const EndNode: React.FC<NodeProps> = React.memo(({ data, selected }) => {
	const label = (data as Record<string, unknown>).label as string || 'End';
	return (
		<div style={{
			padding: '10px 20px',
			borderRadius: '20px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#ef4444'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			fontSize: '13px',
			fontWeight: 600,
			color: '#ef4444',
		}}>
			{label}
			<Handle type="target" position={Position.Left} id="in"
				style={{ width: 10, height: 10, backgroundColor: '#ef4444', border: '2px solid var(--vscode-editor-background)' }} />
		</div>
	);
});
EndNode.displayName = 'EndNode';
