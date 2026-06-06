import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export const TaskNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	return (
		<BaseNode {...props} color="#3b82f6" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>📋</span>
				<span style={{ fontWeight: 600 }}>Task</span>
			</div>
			<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>{(data.label as string) || 'Task'}</div>
			{data.executorId ? (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					Executor: {(data.executorId as string).slice(0, 16)}...
				</div>
			) : null}
		</BaseNode>
	);
});
TaskNode.displayName = 'TaskNode';
