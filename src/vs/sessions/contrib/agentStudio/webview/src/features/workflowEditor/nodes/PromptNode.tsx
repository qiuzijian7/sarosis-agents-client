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
const ieTextarea: React.CSSProperties = { ...ieInput, minHeight: '60px', resize: 'vertical' };

export const PromptNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const selected = props.selected;
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const promptText = (data.prompt as string) || '';
	const preview = promptText.length > 80 ? promptText.substring(0, 80) + '...' : promptText;

	return (
		<BaseNode {...props} color="#8b5cf6" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>💬</span>
				<span style={{ fontWeight: 600 }}>Prompt</span>
			</div>
			{selected ? (
				<>
					<input style={ieInput} value={(data.label as string) || ''} onChange={e => updateNodeData(props.id, { label: e.target.value })} placeholder="Prompt node name" />
					<textarea style={ieTextarea} value={promptText} onChange={e => updateNodeData(props.id, { prompt: e.target.value })} placeholder="Enter prompt template..." />
				</>
			) : (
				<>
					<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>{(data.label as string) || 'Prompt'}</div>
					{promptText ? (
						<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', lineHeight: 1.4, fontStyle: 'italic', maxHeight: '48px', overflow: 'hidden' }}>{preview}</div>
					) : (
						<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>No prompt content</div>
					)}
				</>
			)}
		</BaseNode>
	);
});
PromptNode.displayName = 'PromptNode';
