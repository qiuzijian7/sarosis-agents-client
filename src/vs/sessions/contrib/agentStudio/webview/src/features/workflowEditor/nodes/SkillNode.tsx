import React from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';

export const SkillNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const skillName = (data.skillName as string) || '';

	return (
		<BaseNode {...props} color="#eab308" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>⚡</span>
				<span style={{ fontWeight: 600 }}>Skill</span>
			</div>
			<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>
				{(data.label as string) || 'Skill'}
			</div>
			{skillName ? (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					{skillName}
				</div>
			) : (
				<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
					No skill selected
				</div>
			)}
		</BaseNode>
	);
});
SkillNode.displayName = 'SkillNode';
