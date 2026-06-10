import React from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';

export const SwitchNode: React.FC<NodeProps> = React.memo(({ id, data, selected }) => {
	const d = data as Record<string, unknown>;
	const branches = (d.branches as Array<{ id: string; label: string; condition: string }>) || [];
	const evalTarget = (d.evaluationTarget as string) || '';
	const updateNodeInternals = useUpdateNodeInternals();

	useEffect(() => { updateNodeInternals(id); }, [id, branches.length, updateNodeInternals]);

	return (
		<div className="wf-node" style={{
			position: 'relative', padding: '12px 14px', borderRadius: '8px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#a855f7'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			minWidth: '170px', maxWidth: '280px',
			fontSize: '13px', lineHeight: 1.5, color: 'var(--vscode-foreground)',
		}}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
				<span style={{ fontSize: '14px' }}>🔀</span>
				<span style={{ fontWeight: 600, fontSize: '12px', textTransform: 'uppercase' }}>Switch</span>
			</div>
			<div style={{ fontSize: '11px', color: 'var(--vscode-badge-foreground)', backgroundColor: 'var(--vscode-badge-background)', padding: '2px 6px', borderRadius: '3px', marginBottom: '8px', display: 'inline-block' }}>
				{branches.length}-way Branch
			</div>
			<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '4px' }}>
				{(d.label as string) || 'Switch'}
			</div>
			{evalTarget && (
				<div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginBottom: '6px' }}>
					Evaluates: {evalTarget}
				</div>
			)}
			{branches.map((b, i) => (
				<div key={b.id} style={{ fontSize: '11px', marginBottom: '4px', padding: '3px 6px', backgroundColor: 'var(--vscode-textBlockQuote-background)', borderLeft: `3px solid ${i < branches.length - 1 ? 'var(--vscode-charts-blue)' : 'var(--vscode-charts-orange)'}`, borderRadius: '3px' }}>
					<span style={{ fontWeight: 600 }}>{b.label}</span>
					{b.condition && <span style={{ color: 'var(--vscode-descriptionForeground)', marginLeft: '6px', fontSize: '10px' }}>{b.condition}</span>}
				</div>
			))}
			<Handle type="target" position={Position.Left} id="input"
				style={{ width: 10, height: 10, backgroundColor: '#a855f7', border: '2px solid var(--vscode-editor-background)' }} />
			{branches.map((b, i) => (
				<Handle key={b.id} type="source" position={Position.Right} id={`branch-${i}`}
					style={{ width: 10, height: 10, backgroundColor: '#a855f7', border: '2px solid var(--vscode-editor-background)', top: `${((i + 1) / (branches.length + 1)) * 100}%` }} />
			))}
		</div>
	);
});
SwitchNode.displayName = 'SwitchNode';
