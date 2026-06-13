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
const ieTextarea: React.CSSProperties = { ...ieInput, minHeight: '32px', resize: 'vertical', fontFamily: 'monospace' };
const ieLabel: React.CSSProperties = { fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px', display: 'block' };

export const ToolNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const toolName = (data.toolName as string) || '';

	return (
		<BaseNode {...props} color="#64748b" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>🔧</span>
				<span style={{ fontWeight: 600 }}>Tool</span>
			</div>
			{/* Editors (always visible) */}
			<input style={ieInput} value={(data.label as string) || ''} onChange={e => updateNodeData(props.id, { label: e.target.value })} placeholder="Node name" />
			<span style={ieLabel}>Tool Name</span>
			<input style={ieInput} value={toolName} onChange={e => updateNodeData(props.id, { toolName: e.target.value })} placeholder="e.g. read_file" />
			<span style={ieLabel}>Parameters (JSON)</span>
			<textarea style={ieTextarea} value={(data.params as string) || ''} onChange={e => updateNodeData(props.id, { params: e.target.value })} placeholder='{"key": "value"}' />
		</BaseNode>
	);
});
ToolNode.displayName = 'ToolNode';
