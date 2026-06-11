import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';
import { useWorkflowEditorStore } from '../store';

const ieInput: React.CSSProperties = {
	width: '100%', padding: '2px 5px', fontSize: '11px',
	background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border)', borderRadius: '2px',
	boxSizing: 'border-box', marginTop: '2px',
};
const ieTextarea: React.CSSProperties = { ...ieInput, minHeight: '36px', resize: 'vertical' };
const ieLabel: React.CSSProperties = { fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px', display: 'block' };

export const TaskNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const selected = props.selected;
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);

	return (
		<BaseNode {...props} color="#3b82f6" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>📋</span>
				<span style={{ fontWeight: 600 }}>Task</span>
			</div>
			{selected ? (
				<>
					<input style={ieInput} value={(data.label as string) || ''} onChange={e => updateNodeData(props.id, { label: e.target.value })} placeholder="Task name" />
					<span style={ieLabel}>Description</span>
					<textarea style={ieTextarea} value={(data.prompt as string) || ''} onChange={e => updateNodeData(props.id, { prompt: e.target.value })} placeholder="What should this task do?" />
				</>
			) : (
				<>
					<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>{(data.label as string) || 'Task'}</div>
					{data.executorId ? (
						<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
							Executor: {(data.executorId as string).slice(0, 16)}...
						</div>
					) : null}
				</>
			)}
		</BaseNode>
	);
});
TaskNode.displayName = 'TaskNode';
