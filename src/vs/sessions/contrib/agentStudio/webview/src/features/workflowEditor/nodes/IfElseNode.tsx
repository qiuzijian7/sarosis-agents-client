import React from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';
import { useWorkflowEditorStore } from '../store';

const ieInput: React.CSSProperties = {
	width: '100%', padding: '2px 5px', fontSize: '11px',
	background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border)', borderRadius: '2px',
	boxSizing: 'border-box', marginTop: '2px',
};

export const IfElseNode: React.FC<NodeProps> = React.memo(({ id, data, selected }) => {
	const d = data as Record<string, unknown>;
	const branches = (d.branches as Array<{ id: string; label: string; condition: string }>) || [];
	const condition = (d.condition as string) || '';
	const updateNodeInternals = useUpdateNodeInternals();
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);

	useEffect(() => { updateNodeInternals(id); }, [id, branches.length, updateNodeInternals]);

	const n = branches.length || 2;

	return (
		<div className="wf-node" style={{
			position: 'relative', padding: '12px 14px', borderRadius: '8px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#ef4444'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			minWidth: selected ? '240px' : '170px', maxWidth: '300px',
			fontSize: '13px', lineHeight: 1.5, color: 'var(--vscode-foreground)',
		}}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
				<span style={{ fontSize: '14px' }}>↔️</span>
				<span style={{ fontWeight: 600, fontSize: '12px', textTransform: 'uppercase' }}>If/Else</span>
			</div>
			{selected ? (
				<>
					<input style={ieInput} value={(d.label as string) || ''} onChange={e => updateNodeData(id, { label: e.target.value })} placeholder="Node name" />
					<div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px' }}>Condition</div>
					<input style={ieInput} value={condition} onChange={e => updateNodeData(id, { condition: e.target.value })} placeholder="e.g. output === 'ok'" />
				</>
			) : (
				<>
					<div style={{ fontSize: '11px', color: 'var(--vscode-badge-foreground)', backgroundColor: 'var(--vscode-badge-background)', padding: '2px 6px', borderRadius: '3px', marginBottom: '8px', display: 'inline-block' }}>2-way Branch</div>
					<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}>{(d.label as string) || 'If/Else'}</div>
					{branches.map((b, i) => (
						<div key={b.id} style={{ fontSize: '11px', marginBottom: '6px', padding: '4px 8px', backgroundColor: 'var(--vscode-textBlockQuote-background)', borderLeft: `3px solid ${i === 0 ? '#22c55e' : '#ef4444'}`, borderRadius: '3px' }}>
							<div style={{ fontWeight: 600 }}>{b.label}</div>
							{b.condition && <div style={{ color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic', fontSize: '10px' }}>{b.condition}</div>}
						</div>
					))}
				</>
			)}
			<Handle type="target" position={Position.Left} id="input" style={{ width: 10, height: 10, backgroundColor: '#ef4444', border: '2px solid var(--vscode-editor-background)' }} />
			{Array.from({ length: n }).map((_, i) => (
				<Handle key={`branch-${i}`} type="source" position={Position.Right} id={`branch-${i}`}
					style={{ width: 10, height: 10, backgroundColor: '#ef4444', border: '2px solid var(--vscode-editor-background)', top: `${((i + 1) / (n + 1)) * 100}%` }} />
			))}
		</div>
	);
});
IfElseNode.displayName = 'IfElseNode';
