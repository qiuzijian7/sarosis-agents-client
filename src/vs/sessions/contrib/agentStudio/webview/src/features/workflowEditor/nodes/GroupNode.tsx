import React from 'react';
import { type NodeProps, NodeResizer } from '@xyflow/react';

export const GroupNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;

	return (
		<>
			<NodeResizer
				color="var(--vscode-focusBorder)"
				isVisible={props.selected}
				minWidth={200}
				minHeight={100}
				handleStyle={{ width: 8, height: 8, borderRadius: '2px' }}
			/>
			<div className="wf-node" style={{
				position: 'relative', padding: '8px 12px', borderRadius: '8px',
				border: `1px solid ${props.selected ? 'var(--vscode-focusBorder)' : 'var(--vscode-panel-border)'}`,
				borderStyle: 'dashed',
				backgroundColor: 'transparent',
				width: '100%', height: '100%',
				minWidth: '160px',
				fontSize: '12px', lineHeight: 1.5, color: 'var(--vscode-foreground)',
			}}>
				<div style={{
					display: 'flex', alignItems: 'center', gap: '6px',
					fontSize: '11px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)',
					textTransform: 'uppercase', letterSpacing: '0.5px',
				}}>
					<span style={{ fontSize: '14px' }}>▦</span>
					<span>Group</span>
				</div>
				<div style={{ fontSize: '12px', fontWeight: 500, marginTop: '2px' }}>
					{(data.label as string) || 'Group'}
				</div>
			</div>
		</>
	);
});
GroupNode.displayName = 'GroupNode';
