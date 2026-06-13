import React, { useState, useRef, useEffect, useMemo } from 'react';
import { type NodeProps } from '@xyflow/react';
import { BaseNode } from './BaseNode';
import { useWorkflowEditorStore } from '../store';
import { extractVariables, formatVariableBadge } from '../utils/templateUtils';
import { VariableAutocomplete, buildCandidates } from '../utils/VariableAutocomplete';

const ieInput: React.CSSProperties = {
	width: '100%', padding: '2px 5px', fontSize: '11px',
	background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border)', borderRadius: '2px',
	boxSizing: 'border-box', marginTop: '2px',
};
const ieTextarea: React.CSSProperties = { ...ieInput, minHeight: '60px', resize: 'vertical' };

export const PromptNode: React.FC<NodeProps> = React.memo((props) => {
	const data = props.data as Record<string, unknown>;
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const promptText = (data.prompt as string) || '';
	const variableBadge = formatVariableBadge(promptText);
	const detectedVariables = extractVariables(promptText);

	// Pull current workflow graph (for upstream node detection).
	const allNodes = useWorkflowEditorStore(s => s.nodes);
	const allEdges = useWorkflowEditorStore(s => s.edges);

	// v14: build the full autocomplete candidate list — context + workflow +
	// per-node static + upstream node outputs. Used by the {{ autocomplete.
	const candidates = useMemo(() => buildCandidates({
		nodeData: data,
		nodeId: props.id,
		nodes: allNodes as Array<{ id: string; data?: Record<string, unknown> }>,
		edges: allEdges as Array<{ source: string; target: string }>,
	}), [data, props.id, allNodes, allEdges]);

	// Insert-variable dropdown (legacy cc-wf-studio parity)
	const [showPicker, setShowPicker] = useState(false);
	const pickerRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (!showPicker) { return; }
		const handler = (e: MouseEvent) => {
			if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
				setShowPicker(false);
			}
		};
		window.addEventListener('mousedown', handler);
		return () => window.removeEventListener('mousedown', handler);
	}, [showPicker]);

	const insertVariable = (name: string) => {
		const ta = textareaRef.current;
		const token = `{{${name}}}`;
		if (ta) {
			const start = ta.selectionStart ?? promptText.length;
			const end = ta.selectionEnd ?? promptText.length;
			const next = promptText.substring(0, start) + token + promptText.substring(end);
			updateNodeData(props.id, { prompt: next });
			setTimeout(() => {
				ta.focus();
				ta.setSelectionRange(start + token.length, start + token.length);
			}, 0);
		} else {
			updateNodeData(props.id, { prompt: promptText + token });
		}
		setShowPicker(false);
	};

	return (
		<BaseNode {...props} color="#8b5cf6" handles={{ target: true, source: true }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
				<span style={{ fontSize: '14px' }}>💬</span>
				<span style={{ fontWeight: 600 }}>Prompt</span>
				{variableBadge && (
					<span
						title={`Detected variables: ${detectedVariables.join(', ')}`}
						style={{
							marginLeft: 'auto',
							fontSize: '9px',
							fontWeight: 600,
							padding: '1px 5px',
							borderRadius: '8px',
							background: 'var(--vscode-badge-background, #4d4d4d)',
							color: 'var(--vscode-badge-foreground, #ffffff)',
						}}
					>
						{variableBadge}
					</span>
				)}
			</div>
				<input style={ieInput} value={(data.label as string) || ''} onChange={e => updateNodeData(props.id, { label: e.target.value })} placeholder="Prompt node name" />
				{/* v14: textarea + {{ }} IntelliSense autocomplete */}
				<div style={{ position: 'relative' }}>
					<textarea
						ref={textareaRef}
						style={ieTextarea}
						value={promptText}
						onChange={e => updateNodeData(props.id, { prompt: e.target.value })}
						placeholder="Type {{ for variable autocomplete, e.g. Build a {{feature}} using {{stack}}"
					/>
					<VariableAutocomplete
						targetRef={textareaRef}
						text={promptText}
						onChange={next => updateNodeData(props.id, { prompt: next })}
						candidates={candidates}
						id={`prompt-node-ac-${props.id}`}
					/>
				</div>
				{/* Variable tools row (legacy dropdown for click-driven UX) */}
				<div style={{ position: 'relative', marginTop: '4px' }}>
					<button
						onClick={() => setShowPicker(s => !s)}
						style={{
							fontSize: '10px', padding: '1px 6px', cursor: 'pointer',
							background: 'var(--vscode-button-secondaryBackground)',
							color: 'var(--vscode-button-secondaryForeground)',
							border: 'none', borderRadius: '3px',
						}}
					>＋ Insert variable</button>
					{showPicker && (
						<div
							ref={pickerRef}
							style={{
								position: 'absolute', top: '100%', left: 0, zIndex: 50,
								background: 'var(--vscode-menu-background, #252526)',
								border: '1px solid var(--vscode-menu-border, #454545)',
								borderRadius: '4px',
								padding: '4px 0',
								minWidth: '180px',
								maxHeight: '200px', overflowY: 'auto',
								boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
							}}
						>
							<div style={{ padding: '4px 10px', fontSize: '9px', color: 'var(--vscode-descriptionForeground)', textTransform: 'uppercase' }}>
								Available variables
							</div>
							{candidates.length === 0 && (
								<div style={{ padding: '4px 10px', fontSize: '10px', color: 'var(--vscode-descriptionForeground)' }}>
									(no variables configured)
								</div>
							)}
							{candidates.map((c, idx) => (
								<button
									key={c.name + '_' + idx}
									onClick={() => insertVariable(c.name)}
									style={{
										display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
										padding: '3px 10px', fontSize: '11px', gap: 8,
										background: 'none', border: 'none', color: 'var(--vscode-menu-foreground, #ccc)',
										cursor: 'pointer', fontFamily: 'var(--vscode-editor-font-family, monospace)',
									}}
									onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-menu-selectionBackground, #094771)')}
									onMouseLeave={e => (e.currentTarget.style.background = 'none')}
								>
									<span style={{ color: 'var(--vscode-charts-blue, #4fc1ff)' }}>{`{{${c.name}}}`}</span>
									{c.tag && (
										<span style={{ color: 'var(--vscode-descriptionForeground, #999)', fontSize: 9, marginLeft: 'auto' }}>{c.tag}</span>
									)}
								</button>
							))}
						</div>
					)}
				</div>
				{detectedVariables.length > 0 && (
					<div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
						{detectedVariables.map(name => (
							<span
								key={name}
								style={{
									fontSize: '9px',
									padding: '1px 5px',
									borderRadius: '2px',
									background: 'var(--vscode-textCodeBlock-background, #1e1e1e)',
									color: 'var(--vscode-charts-blue, #4fc1ff)',
									fontFamily: 'var(--vscode-editor-font-family, monospace)',
								}}
							>
								{`{{${name}}}`}
							</span>
						))}
					</div>
				)}
		</BaseNode>
	);
});
PromptNode.displayName = 'PromptNode';
