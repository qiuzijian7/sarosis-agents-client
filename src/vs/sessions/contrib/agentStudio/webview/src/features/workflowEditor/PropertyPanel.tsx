/*---------------------------------------------------------------------------------------------
 *  PropertyPanel — floating panel that shows properties for the selected node.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback } from 'react';
import { useWorkflowEditorStore } from './store';
import { nodeTypeSelectors } from './store';

export const PropertyPanel: React.FC = () => {
	const selectedNodeId = useWorkflowEditorStore(s => s.selectedNodeId);
	const isOpen = useWorkflowEditorStore(s => s.isPropertyPanelOpen);
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const updateNodeData = useWorkflowEditorStore(s => s.updateNodeData);
	const removeNode = useWorkflowEditorStore(s => s.removeNode);
	const setSelectedNode = useWorkflowEditorStore(s => s.setSelectedNode);

	const selectedNode = nodes.find(n => n.id === selectedNodeId);
	const data = (selectedNode?.data || {}) as Record<string, unknown>;

	const handleChange = useCallback((field: string, value: unknown) => {
		if (selectedNodeId) {
			updateNodeData(selectedNodeId, { [field]: value });
		}
	}, [selectedNodeId, updateNodeData]);

	if (!isOpen || !selectedNode || selectedNode.type === 'start' || selectedNode.type === 'end') {
		return null;
	}

	const isDeletable = selectedNode.type !== 'start' && selectedNode.type !== 'end';
	const nodeInfo = nodeTypeSelectors.find(n => n.type === selectedNode.type);

	return (
		<div style={{
			position: 'absolute',
			top: 5,
			right: 5,
			bottom: 5,
			width: '260px',
			backgroundColor: 'var(--vscode-sideBar-background)',
			border: '1px solid var(--vscode-panel-border)',
			borderRadius: '8px',
			zIndex: 10,
			display: 'flex',
			flexDirection: 'column',
			overflow: 'hidden',
			boxShadow: '0 4px 12px var(--vscode-widget-shadow)',
		}}>
			{/* Header */}
			<div style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				padding: '10px 12px',
				borderBottom: '1px solid var(--vscode-panel-border)',
			}}>
				<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
					<span>{nodeInfo?.icon || '📌'}</span>
					<span style={{ fontWeight: 600, fontSize: '13px' }}>
						{nodeInfo?.label || selectedNode.type}
					</span>
				</div>
				<div style={{ display: 'flex', gap: '4px' }}>
					{isDeletable && (
						<button onClick={() => { removeNode(selectedNode.id); setSelectedNode(null); }}
							title="Delete node"
							style={{
								background: 'none', border: 'none', color: 'var(--vscode-errorForeground)',
								cursor: 'pointer', fontSize: '14px', padding: '2px 6px',
							}}>×</button>
					)}
					<button onClick={() => setSelectedNode(null)}
						title="Close"
						style={{
							background: 'none', border: 'none', color: 'var(--vscode-descriptionForeground)',
							cursor: 'pointer', fontSize: '14px', padding: '2px 6px',
						}}>✕</button>
				</div>
			</div>

			{/* Body */}
			<div style={{ padding: '12px', overflow: 'auto', flex: 1 }}>
				{/* Name */}
				<Field label="Name">
					<input
						type="text"
						value={(data.label as string) || ''}
						onChange={e => handleChange('label', e.target.value)}
						style={inputStyle}
						placeholder="Node name"
					/>
				</Field>

				{/* Task-specific */}
				{selectedNode.type === 'task' && (
					<>
						<Field label="Executor ID">
							<input
								type="text"
								value={(data.executorId as string) || ''}
								onChange={e => handleChange('executorId', e.target.value)}
								style={inputStyle}
								placeholder="e.g., agent-123"
							/>
						</Field>
						<Field label="Task ID">
							<input
								type="text"
								value={(data.taskId as string) || ''}
								onChange={e => handleChange('taskId', e.target.value)}
								style={inputStyle}
								placeholder="e.g., task-456"
							/>
						</Field>
					</>
				)}

				{/* Condition-specific */}
				{selectedNode.type === 'condition' && (
					<Field label="Condition expression">
						<textarea
							value={(data.condition as string) || ''}
							onChange={e => handleChange('condition', e.target.value)}
							style={{ ...inputStyle, minHeight: '48px', resize: 'vertical' }}
							placeholder="e.g., $result.status === 'ok'"
						/>
					</Field>
				)}

				{/* Loop-specific */}
				{selectedNode.type === 'loop' && (
					<>
						<Field label="Items source">
							<input
								type="text"
								value={((data.loopConfig as { items: string })?.items) || ''}
								onChange={e => handleChange('loopConfig', { ...((data.loopConfig as object) || {}), items: e.target.value })}
								style={inputStyle}
								placeholder="e.g., $input.tasks"
							/>
						</Field>
						<Field label="Item variable">
							<input
								type="text"
								value={((data.loopConfig as { itemVariable: string })?.itemVariable) || 'item'}
								onChange={e => handleChange('loopConfig', { ...((data.loopConfig as object) || {}), itemVariable: e.target.value })}
								style={inputStyle}
							/>
						</Field>
					</>
				)}
			</div>
		</div>
	);
};

/* ── Helpers ───────────────────────────────────────────────── */

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
	<div style={{ marginBottom: '12px' }}>
		<label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)', marginBottom: '4px', textTransform: 'uppercase' }}>
			{label}
		</label>
		{children}
	</div>
);

const inputStyle: React.CSSProperties = {
	width: '100%',
	padding: '6px 8px',
	border: '1px solid var(--vscode-input-border)',
	borderRadius: '4px',
	backgroundColor: 'var(--vscode-input-background)',
	color: 'var(--vscode-input-foreground)',
	fontSize: '12px',
	fontFamily: 'var(--vscode-font-family)',
	boxSizing: 'border-box',
};
