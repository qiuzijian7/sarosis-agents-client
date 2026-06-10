import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export const ToolNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const toolName = (data.toolName as string) || '';
	const params = data.toolParams as Record<string, string> | undefined;

	return (
		<BaseNode {...props} color="#10b981" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>🔧</span>
				<span style={{ fontWeight: 600 }}>Tool</span>
			</div>
			<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>
				{(data.label as string) || 'Tool'}
			</div>
			{toolName ? (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					{toolName}
					{params && Object.keys(params).length > 0 &&
						` (${Object.keys(params).length} param${Object.keys(params).length > 1 ? 's' : ''})`}
				</div>
			) : (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
					No tool selected
				</div>
			)}
		</BaseNode>
	);
});
ToolNode.displayName = 'ToolNode';
