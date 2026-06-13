import React from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import { useWorkflowEditorStore } from '../store';
import { extractVariables, formatVariableBadge } from '../utils/templateUtils';
import { VariableAutocomplete, buildCandidates } from '../utils/VariableAutocomplete';

const ieInput: React.CSSProperties = {
	width: '100%', padding: '2px 5px', fontSize: '11px',
	background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border)', borderRadius: '2px',
	boxSizing: 'border-box', marginTop: '2px',
};
const ieTextarea: React.CSSProperties = { ...ieInput, minHeight: '36px', resize: 'vertical', marginTop: '2px' };

export const AskUserNode: React.FC<NodeProps> = React.memo(({ id, data, selected }) => {
	const d = data as Record<string, unknown>;
	const options = (d.options as Array<{ label: string; description: string }>) || [];
	const multiSelect = d.multiSelect as boolean;
	const questionText = (d.question as string) || (d.questionText as string) || '';
	const updateNodeInternals = useUpdateNodeInternals();
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const update = (k: string, v: unknown) => updateNodeData(id, { [k]: v });

	useEffect(() => { updateNodeInternals(id); }, [id, options.length, updateNodeInternals]);

	const n = options.length || 2;

	// v15: autocomplete candidates
	const allNodes = useWorkflowEditorStore(s => s.nodes);
	const allEdges = useWorkflowEditorStore(s => s.edges);
	const candidates = useMemo(() => buildCandidates({
		nodeData: d,
		nodeId: id,
		nodes: allNodes as Array<{ id: string; data?: Record<string, unknown> }>,
		edges: allEdges as Array<{ source: string; target: string }>,
	}), [d, id, allNodes, allEdges]);
	const questionRef = useRef<HTMLTextAreaElement>(null);
	const variableBadge = formatVariableBadge(questionText);
	const detectedVariables = extractVariables(questionText);

	return (
		<div className="wf-node" style={{
			position: 'relative', padding: '12px 14px', borderRadius: '8px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#06b6d4'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			minWidth: '260px', maxWidth: '320px',
			fontSize: '13px', lineHeight: 1.5, color: 'var(--vscode-foreground)',
		}}>
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
					<span style={{ fontSize: '14px' }}>❓</span>
					<span style={{ fontWeight: 600, fontSize: '12px', textTransform: 'uppercase' }}>Ask User</span>
				</div>
				<div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
					{variableBadge && (
						<span title={`Detected variables: ${detectedVariables.join(', ')}`}
							style={{ fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '8px', background: 'var(--vscode-badge-background, #4d4d4d)', color: 'var(--vscode-badge-foreground, #ffffff)' }}>
							{variableBadge}
						</span>
					)}
					{multiSelect && <span style={{ fontSize: '9px', padding: '2px 6px', backgroundColor: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', borderRadius: '3px', fontWeight: 600 }}>Multi</span>}
				</div>
			</div>

			<input style={ieInput} value={(d.label as string) || ''} onChange={e => update('label', e.target.value)} placeholder="Node name" />
			<div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px' }}>Question</div>
			<div style={{ position: 'relative' }}>
				<textarea
					ref={questionRef}
					style={ieTextarea}
					value={questionText}
					onChange={e => update('question', e.target.value)}
					placeholder="Type {{ for variable autocomplete"
				/>
				<VariableAutocomplete
					targetRef={questionRef}
					text={questionText}
					onChange={next => update('question', next)}
					candidates={candidates}
					id={`askuser-node-ac-${id}`}
				/>
			</div>
			<label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px', fontSize: '10px' }}>
				<input type="checkbox" checked={!!multiSelect} onChange={e => update('multiSelect', e.target.checked)} /> Multi-select
			</label>
			<div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginTop: '6px' }}>Options</div>
			{options.map((opt, i) => (
				<div key={i} style={{ marginBottom: '4px' }}>
					<input style={ieInput} value={opt.label} onChange={e => {
						const next = options.map((o, j) => j === i ? { ...o, label: e.target.value } : o);
						update('options', next);
					}} placeholder="Option label" />
				</div>
			))}
			<button onClick={() => update('options', [...options, { label: `Option ${options.length + 1}`, description: '' }])}
				style={{ fontSize: '10px', padding: '1px 6px', cursor: 'pointer', marginTop: '2px', background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)', border: 'none', borderRadius: '3px' }}>+ Option</button>

			<Handle type="target" position={Position.Left} id="input" style={{ width: 10, height: 10, backgroundColor: '#06b6d4', border: '2px solid var(--vscode-editor-background)' }} />
			{Array.from({ length: Math.max(n, 2) }).map((_, i) => (
				<Handle key={`opt-${i}`} type="source" position={Position.Right} id={`option-${i}`}
					style={{ width: 10, height: 10, backgroundColor: '#06b6d4', border: '2px solid var(--vscode-editor-background)', top: `${((i + 1) / (n + 1)) * 100}%` }} />
			))}
		</div>
	);
});
AskUserNode.displayName = 'AskUserNode';
