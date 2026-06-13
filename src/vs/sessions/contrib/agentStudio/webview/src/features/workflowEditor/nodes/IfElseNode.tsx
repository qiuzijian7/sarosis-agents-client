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

/** Per-branch condition editor (avoids useRef inside .map()) */
const BranchConditionEditor: React.FC<{
	branch: { id: string; label: string; condition: string };
	index: number;
	candidates: string[];
	nodeId: string;
	updateNodeData: (id: string, data: Record<string, unknown>) => void;
	branches: Array<{ id: string; label: string; condition: string }>;
}> = React.memo(({ branch, index, candidates, nodeId, updateNodeData, branches }) => {
	const inputRef = useRef<HTMLInputElement>(null);

	const updateBranchLabel = (label: string) => {
		const next = branches.map((br, j) => j === index ? { ...br, label } : br);
		updateNodeData(nodeId, { branches: next });
	};

	const updateBranchCondition = (condition: string) => {
		const next = branches.map((br, j) => j === index ? { ...br, condition } : br);
		updateNodeData(nodeId, { branches: next });
	};

	return (
		<div style={{ marginBottom: '4px', marginTop: '4px' }}>
			<div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)' }}>
				{index === 0 ? 'TRUE' : 'FALSE'} branch
			</div>
			<input style={ieInput} value={branch.label} onChange={e => updateBranchLabel(e.target.value)} placeholder="Branch label" />
			<div style={{ position: 'relative' }}>
				<input
					ref={inputRef}
					style={ieInput}
					value={branch.condition ?? ''}
					onChange={e => updateBranchCondition(e.target.value)}
					placeholder="Type {{ for variable autocomplete, e.g. {{$prev}} === 'ok'"
				/>
				<VariableAutocomplete
					targetRef={inputRef}
					text={branch.condition ?? ''}
					onChange={updateBranchCondition}
					candidates={candidates}
					id={`ifelse-node-ac-${nodeId}-${index}`}
				/>
			</div>
		</div>
	);
});
BranchConditionEditor.displayName = 'BranchConditionEditor';

export const IfElseNode: React.FC<NodeProps> = React.memo(({ id, data, selected }) => {
	const d = data as Record<string, unknown>;
	const branches = (d.branches as Array<{ id: string; label: string; condition: string }>) || [];
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
	const conditionRef = useRef<HTMLInputElement>(null);

		return (
		<div className="wf-node" style={{
			position: 'relative', padding: '12px 14px', borderRadius: '8px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#ef4444'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			minWidth: '240px', maxWidth: '300px',
			fontSize: '13px', lineHeight: 1.5, color: 'var(--vscode-foreground)',
		}}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
				<span style={{ fontSize: '14px' }}>↔️</span>
				<span style={{ fontWeight: 600, fontSize: '12px', textTransform: 'uppercase' }}>If/Else</span>
			</div>
			<input style={ieInput} value={(d.label as string) || ''} onChange={e => updateNodeData(id, { label: e.target.value })} placeholder="Node name" />
			<div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px' }}>Branches</div>
			{branches.map((b, i) => (
				<BranchConditionEditor
					key={b.id}
					branch={b}
					index={i}
					candidates={candidates}
					nodeId={id}
					updateNodeData={updateNodeData}
					branches={branches}
				/>
			))}
			<Handle type="target" position={Position.Left} id="input" style={{ width: 10, height: 10, backgroundColor: '#ef4444', border: '2px solid var(--vscode-editor-background)' }} />
			{Array.from({ length: n }).map((_, i) => (
				<Handle key={`branch-${i}`} type="source" position={Position.Right} id={`branch-${i}`}
					style={{ width: 10, height: 10, backgroundColor: '#ef4444', border: '2px solid var(--vscode-editor-background)', top: `${((i + 1) / (n + 1)) * 100}%` }} />
			))}
		</div>
	);
});
IfElseNode.displayName = 'IfElseNode';
