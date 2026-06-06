import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export const ParallelNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const steps = (data.parallelSteps as string[]) || [];
	return (
		<BaseNode {...props} color="#8b5cf6" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>⇉</span>
				<span style={{ fontWeight: 600 }}>Parallel</span>
			</div>
			<div style={{ fontSize: '12px', marginBottom: '4px' }}>{(data.label as string) || 'Parallel'}</div>
			{steps.length > 0 ? (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					{steps.length} branch{steps.length > 1 ? 'es' : ''}
				</div>
			) : (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
					No branches defined
				</div>
			)}
		</BaseNode>
	);
});
ParallelNode.displayName = 'ParallelNode';
