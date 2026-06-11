import React, { useEffect, useState } from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';
import { useWorkflowEditorStore } from '../store';
import { sendRequest } from '../../../bridge/messageClient';

const ieInput: React.CSSProperties = {
	width: '100%', padding: '2px 5px', fontSize: '11px',
	background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border)', borderRadius: '2px',
	boxSizing: 'border-box', marginTop: '2px',
};
const ieSelect: React.CSSProperties = { ...ieInput, cursor: 'pointer' };
const ieTextarea: React.CSSProperties = { ...ieInput, minHeight: '36px', resize: 'vertical' };
const ieLabel: React.CSSProperties = { fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px', display: 'block' };

export const SkillNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const selected = props.selected;
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const [skills, setSkills] = useState<{ id: string; name: string }[]>([]);

	useEffect(() => {
		if (selected && skills.length === 0) {
			sendRequest<unknown, { id: string; name: string }[]>('skills.list', {}).then(r => setSkills(Array.isArray(r) ? r : [])).catch(() => {});
		}
	}, [selected, skills.length]);

	const skillName = (data.skillName as string) || '';
	const skillId = (data.skillId as string) || '';

	return (
		<BaseNode {...props} color="#eab308" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>⚡</span>
				<span style={{ fontWeight: 600 }}>Skill</span>
			</div>
			{selected ? (
				<>
					<input style={ieInput} value={(data.label as string) || ''} onChange={e => updateNodeData(props.id, { label: e.target.value })} placeholder="Node name" />
					<span style={ieLabel}>Skill</span>
					<select style={ieSelect} value={skillId} onChange={e => {
						const found = skills.find(s => s.id === e.target.value);
						updateNodeData(props.id, { skillId: e.target.value, skillName: found?.name || '' });
						if (found) updateNodeData(props.id, { label: found.name });
					}}>
						<option value="">— Select skill —</option>
						{skills.map(s => (<option key={s.id} value={s.id}>{s.name}</option>))}
					</select>
					<span style={ieLabel}>Input</span>
					<textarea style={ieTextarea} value={(data.prompt as string) || ''} onChange={e => updateNodeData(props.id, { prompt: e.target.value })} placeholder="Skill input (optional)" />
				</>
			) : (
				<>
					<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '2px' }}>{(data.label as string) || 'Skill'}</div>
					{skillName ? (
						<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>{skillName}</div>
					) : (
						<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>No skill selected</div>
					)}
				</>
			)}
		</BaseNode>
	);
});
SkillNode.displayName = 'SkillNode';
