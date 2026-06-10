import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export const AgentNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const agentId = (data.agentId as string) || '';
	const config = data.agentConfig as { providerId?: string; modelId?: string } | undefined;

	return (
		<BaseNode {...props} color="#f97316" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>🤖</span>
				<span style={{ fontWeight: 600 }}>Agent</span>
			</div>
			<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>
				{(data.label as string) || 'Agent'}
			</div>
			{agentId ? (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					ID: {agentId.slice(0, 20)}{agentId.length > 20 ? '...' : ''}
				</div>
			) : (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
					No agent selected
				</div>
			)}
			{config?.modelId && (
				<div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginTop: '2px' }}>
					{config.modelId}
				</div>
			)}
		</BaseNode>
	);
});
AgentNode.displayName = 'AgentNode';
