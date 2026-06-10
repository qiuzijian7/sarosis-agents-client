import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export const PromptNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const promptText = (data.prompt as string) || '';
	const preview = promptText.length > 80 ? promptText.substring(0, 80) + '...' : promptText;

	return (
		<BaseNode {...props} color="#8b5cf6" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>💬</span>
				<span style={{ fontWeight: 600 }}>Prompt</span>
			</div>
			<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>
				{(data.label as string) || 'Prompt'}
			</div>
			{promptText ? (
				<div style={{
					fontSize: '11px', color: 'var(--vscode-descriptionForeground)',
					lineHeight: 1.4, fontStyle: 'italic',
					maxHeight: '48px', overflow: 'hidden',
				}}>
					{preview}
				</div>
			) : (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
					No prompt content
				</div>
			)}
		</BaseNode>
	);
});
PromptNode.displayName = 'PromptNode';
