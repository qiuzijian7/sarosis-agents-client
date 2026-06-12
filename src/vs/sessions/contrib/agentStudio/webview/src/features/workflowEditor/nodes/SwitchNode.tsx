import React from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import { useWorkflowEditorStore } from '../store';
import { VariableAutocomplete, buildCandidates } from '../utils/VariableAutocomplete';

const ieInput: React.CSSProperties = {
	width: '100%', padding: '2px 5px', fontSize: '11px',
	background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border)', borderRadius: '2px',
	boxSizing: 'border-box', marginTop: '2px',
};

export const SwitchNode: React.FC<NodeProps> = React.memo(({ id, data, selected }) => {
	const d = data as Record<string, unknown>;
	const branches = (d.branches as Array<{ id: string; label: string; condition: string }>) || [];
	const evalTarget = (d.evaluationTarget as string) || '';
	const updateNodeInternals = useUpdateNodeInternals();
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);

	useEffect(() => { updateNodeInternals(id); }, [id, branches.length, updateNodeInternals]);

	const n = branches.length || 2;

	// v15: autocomplete candidates
	const allNodes = useWorkflowEditorStore(s => s.nodes);
	const allEdges = useWorkflowEditorStore(s => s.edges);
	const candidates = useMemo(() => buildCandidates({
		nodeData: d,
		nodeId: id,
		nodes: allNodes as Array<{ id: string; data?: Record<string, unknown> }>,
		edges: allEdges as Array<{ source: string; target: string }>,
	}), [d, id, allNodes, allEdges]);
	const switchOnRef = useRef<HTMLInputElement>(null);

	return (
		<div className="wf-node" style={{
			position: 'relative', padding: '12px 14px', borderRadius: '8px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#a855f7'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			minWidth: selected ? '240px' : '170px', maxWidth: '300px',
			fontSize: '13px', lineHeight: 1.5, color: 'var(--vscode-foreground)',
		}}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
				<span style={{ fontSize: '14px' }}>🔀</span>
				<span style={{ fontWeight: 600, fontSize: '12px', textTransform: 'uppercase' }}>Switch</span>
			</div>
			{selected ? (
				<>
					<input style={ieInput} value={(d.label as string) || ''} onChange={e => updateNodeData(id, { label: e.target.value })} placeholder="Node name" />
					<div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px' }}>Switch On</div>
					<div style={{ position: 'relative' }}>
						<input
							ref={switchOnRef}
							style={ieInput}
							value={evalTarget}
							onChange={e => updateNodeData(id, { evaluationTarget: e.target.value })}
							placeholder="Type {{ for variable autocomplete, e.g. {{status}}"
						/>
						<VariableAutocomplete
							targetRef={switchOnRef}
							text={evalTarget}
							onChange={next => updateNodeData(id, { evaluationTarget: next })}
							candidates={candidates}
							id={`switch-node-ac-${id}`}
						/>
					</div>
					<div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px' }}>Branches</div>
					{branches.map((b, i) => (
						<div key={b.id} style={{ marginBottom: '3px' }}>
							<input style={ieInput} value={b.label} onChange={e => {
								const next = branches.map((br, j) => j === i ? { ...br, label: e.target.value } : br);
								updateNodeData(id, { branches: next });
							}} placeholder="Branch label" />
						</div>
					))}
					<button onClick={() => {
						const next = [...branches, { id: `case_${branches.length + 1}`, label: `Case ${branches.length + 1}`, condition: '' }];
						updateNodeData(id, { branches: next });
					}} style={{ fontSize: '10px', padding: '1px 6px', cursor: 'pointer', marginTop: '2px', background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: 'none', borderRadius: '3px' }}>+ Branch</button>
				</>
			) : (
				<>
					<div style={{ fontSize: '11px', color: 'var(--vscode-badge-foreground)', backgroundColor: 'var(--vscode-badge-background)', padding: '2px 6px', borderRadius: '3px', marginBottom: '8px', display: 'inline-block' }}>{n}-way Switch</div>
					<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}>{(d.label as string) || 'Switch'}</div>
					{evalTarget && <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>on: {evalTarget}</div>}
					{branches.map((b, i) => (
						<div key={b.id} style={{ fontSize: '11px', marginBottom: '4px', padding: '3px 6px', backgroundColor: 'var(--vscode-textBlockQuote-background)', borderLeft: '3px solid var(--vscode-charts-purple)', borderRadius: '3px' }}>{b.label}</div>
					))}
				</>
			)}
			<Handle type="target" position={Position.Left} id="input" style={{ width: 10, height: 10, backgroundColor: '#a855f7', border: '2px solid var(--vscode-editor-background)' }} />
			{Array.from({ length: n }).map((_, i) => (
				<Handle key={`branch-${i}`} type="source" position={Position.Right} id={`branch-${i}`}
					style={{ width: 10, height: 10, backgroundColor: '#a855f7', border: '2px solid var(--vscode-editor-background)', top: `${((i + 1) / (n + 1)) * 100}%` }} />
			))}
		</div>
	);
});
SwitchNode.displayName = 'SwitchNode';
