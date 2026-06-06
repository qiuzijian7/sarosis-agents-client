import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export const ConditionNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const branches = (data.branches as Array<{ id: string; label: string; condition: string }>) || [];
	return (
		<BaseNode {...props} color="#f59e0b" handles={{ target: true, source: true }}
			sourceHandleIds={branches.map((b, i) => `branch-${i}`)}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>🔀</span>
				<span style={{ fontWeight: 600 }}>Condition</span>
			</div>
			<div style={{ fontSize: '12px', marginBottom: '4px' }}>{(data.label as string) || 'Condition'}</div>
			{branches.map((branch, i) => (
				<div key={branch.id} style={{
					fontSize: '11px',
					color: 'var(--vscode-descriptionForeground)',
					borderLeft: `3px solid ${i === 0 ? '#22c55e' : '#ef4444'}`,
					paddingLeft: '6px',
					marginTop: '2px',
				}}>
					{branch.label}{branch.condition ? `: ${branch.condition}` : ''}
				</div>
			))}
		</BaseNode>
	);
});
ConditionNode.displayName = 'ConditionNode';
