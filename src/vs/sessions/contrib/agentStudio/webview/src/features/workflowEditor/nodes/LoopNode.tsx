import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export const LoopNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const loopConfig = data.loopConfig as { items: string; itemVariable: string } | undefined;
	return (
		<BaseNode {...props} color="#06b6d4" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>🔄</span>
				<span style={{ fontWeight: 600 }}>Loop</span>
			</div>
			<div style={{ fontSize: '12px', marginBottom: '4px' }}>{(data.label as string) || 'Loop'}</div>
			{loopConfig?.items ? (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					For each {loopConfig.itemVariable || 'item'} in {loopConfig.items}
				</div>
			) : (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
					No loop config
				</div>
			)}
		</BaseNode>
	);
});
LoopNode.displayName = 'LoopNode';
