import React from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';

export const IfElseNode: React.FC<NodeProps> = React.memo(({ id, data, selected }) => {
	const d = data as Record<string, unknown>;
	const branches = (d.branches as Array<{ id: string; label: string; condition: string }>) || [];
	const updateNodeInternals = useUpdateNodeInternals();

	useEffect(() => { updateNodeInternals(id); }, [id, branches.length, updateNodeInternals]);

	return (
		<div className="wf-node" style={{
			position: 'relative', padding: '12px 14px', borderRadius: '8px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#ef4444'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			minWidth: '170px', maxWidth: '280px',
			fontSize: '13px', lineHeight: 1.5, color: 'var(--vscode-foreground)',
		}}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
				<span style={{ fontSize: '14px' }}>↔️</span>
				<span style={{ fontWeight: 600, fontSize: '12px', textTransform: 'uppercase' }}>If/Else</span>
			</div>
			<div style={{ fontSize: '11px', color: 'var(--vscode-badge-foreground)', backgroundColor: 'var(--vscode-badge-background)', padding: '2px 6px', borderRadius: '3px', marginBottom: '8px', display: 'inline-block' }}>
				2-way Branch
			</div>
			<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}>
				{(d.label as string) || 'If/Else'}
			</div>
			{branches.map((b, i) => (
				<div key={b.id} style={{ fontSize: '11px', marginBottom: '6px', padding: '4px 8px', backgroundColor: 'var(--vscode-textBlockQuote-background)', borderLeft: `3px solid ${i === 0 ? '#22c55e' : '#ef4444'}`, borderRadius: '3px' }}>
					<div style={{ fontWeight: 600 }}>{b.label}</div>
					{b.condition && <div style={{ color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', fontSize: '10px' }}>{b.condition}</div>}
				</div>
			))}
			<Handle type="target" position={Position.Left} id="input"
				style={{ width: 10, height: 10, backgroundColor: '#ef4444', border: '2px solid var(--vscode-editor-background)' }} />
			{branches.map((b, i) => (
				<Handle key={b.id} type="source" position={Position.Right} id={`branch-${i}`}
					style={{ width: 10, height: 10, backgroundColor: '#ef4444', border: '2px solid var(--vscode-editor-background)', top: `${((i + 1) / (branches.length + 1)) * 100}%` }} />
			))}
		</div>
	);
});
IfElseNode.displayName = 'IfElseNode';
