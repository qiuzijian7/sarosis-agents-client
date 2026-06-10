import React from 'react';
import { Handle, Position, type NodeProps, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';

export const AskUserNode: React.FC<NodeProps> = React.memo(({ id, data, selected }) => {
	const d = data as Record<string, unknown>;
	const questionText = (d.questionText as string) || '';
	const options = (d.options as Array<{ label: string; description: string }>) || [];
	const multiSelect = d.multiSelect as boolean;
	const aiSuggestions = d.useAiSuggestions as boolean;
	const updateNodeInternals = useUpdateNodeInternals();

	useEffect(() => { updateNodeInternals(id); }, [id, options.length, updateNodeInternals]);

	return (
		<div className="wf-node" style={{
			position: 'relative', padding: '12px 14px', borderRadius: '8px',
			border: `2px solid ${selected ? 'var(--vscode-focusBorder)' : '#06b6d4'}`,
			backgroundColor: 'var(--vscode-editor-background)',
			minWidth: '200px', maxWidth: '300px',
			fontSize: '13px', lineHeight: 1.5, color: 'var(--vscode-foreground)',
		}}>
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
					<span style={{ fontSize: '14px' }}>❓</span>
					<span style={{ fontWeight: 600, fontSize: '12px', textTransform: 'uppercase' }}>Ask User</span>
				</div>
				<div style={{ display: 'flex', gap: '4px' }}>
					{aiSuggestions && <span style={{ fontSize: '9px', padding: '2px 6px', backgroundColor: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', borderRadius: '3px', fontWeight: 600 }}>AI</span>}
					{multiSelect && <span style={{ fontSize: '9px', padding: '2px 6px', backgroundColor: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', borderRadius: '3px', fontWeight: 600 }}>Multi</span>}
				</div>
			</div>
			<div style={{ fontSize: '12px', fontWeight: 500, marginBottom: '6px' }}>
				{(d.label as string) || 'Ask User'}
			</div>
			<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginBottom: '8px', lineHeight: 1.3 }}>
				{questionText || 'No question set'}
			</div>
			{options.map((opt, i) => (
				<div key={i} style={{
					fontSize: '11px', marginBottom: '4px', padding: '4px 8px',
					backgroundColor: 'var(--vscode-textBlockQuote-background)',
					borderLeft: '3px solid var(--vscode-charts-blue)',
					borderRadius: '3px',
				}}>
					<span style={{ fontWeight: 600 }}>{opt.label}</span>
					{opt.description && <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>{opt.description}</div>}
				</div>
			))}
			<Handle type="target" position={Position.Left} id="input"
				style={{ width: 10, height: 10, backgroundColor: '#06b6d4', border: '2px solid var(--vscode-editor-background)' }} />
			{options.map((_, i) => (
				<Handle key={`opt-${i}`} type="source" position={Position.Right} id={`option-${i}`}
					style={{ width: 10, height: 10, backgroundColor: '#06b6d4', border: '2px solid var(--vscode-editor-background)', top: `${((i + 1) / (options.length + 1)) * 100}%` }} />
			))}
		</div>
	);
});
AskUserNode.displayName = 'AskUserNode';
