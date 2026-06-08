/*---------------------------------------------------------------------------------------------
 *  WorkflowEditorPanel — main panel component for the workflow-editor webview.
 *
 *  Layout (3-column):
 *   ┌────────────┬────────────────────────┬──────────────┐
 *   │ NodePalette│   WorkflowCanvas       │ PropertyPanel│
 *   │ (collapsible)│ (ReactFlow)          │ (floating)   │
 *   └────────────┴────────────────────────┴──────────────┘
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { WorkflowCanvas } from './WorkflowCanvas';
import { NodePalette } from './NodePalette';
import { PropertyPanel } from './PropertyPanel';
import { useWorkflowEditorStore } from './store';
import { sendRequest } from '../../bridge/messageClient';
import type { IStoredWorkflow } from '../../types/workflowStorage';

export const WorkflowEditorPanel: React.FC = () => {
	const [paletteCollapsed, setPaletteCollapsed] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

	const loadWorkflow = useWorkflowEditorStore(s => s.loadWorkflow);
	const workflowId = useWorkflowEditorStore(s => s.workflowId);
	const workflowName = useWorkflowEditorStore(s => s.workflowName);
	const toWorkflowData = useWorkflowEditorStore(s => s.toWorkflowData);
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const edges = useWorkflowEditorStore(s => s.edges);

	// Load initial data from the host-injected __AGENT_STUDIO_INITIAL_DATA__
	useEffect(() => {
		if (loaded) { return; }
		const initialData = (window as unknown as Record<string, unknown>).__AGENT_STUDIO_INITIAL_DATA__ as
			{ type: string; workflow: IStoredWorkflow } | null | undefined;

		if (initialData?.type === 'workflow' && initialData.workflow) {
			loadWorkflow(initialData.workflow);
			setLoaded(true);
		}
	}, [loaded, loadWorkflow]);

	// Keyboard shortcut: Ctrl+S to save
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				void handleSave();
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, [nodes, edges, workflowId, workflowName]);

	const handleSave = useCallback(async () => {
		if (saving || !workflowId) { return; }
		setSaving(true);
		setSaveStatus('saving');
		try {
			const { nodes: gnodes, connections } = toWorkflowData();
			const result = await sendRequest('workflow.save', {
				workflow: {
					id: workflowId,
					nodes: gnodes,
					connections,
				},
			}) as { success: boolean };
			setSaveStatus(result?.success ? 'saved' : 'error');
		} catch {
			setSaveStatus('error');
		} finally {
			setSaving(false);
			setTimeout(() => setSaveStatus('idle'), 3000);
		}
	}, [saving, workflowId, toWorkflowData]);

	return (
		<ReactFlowProvider>
			<div style={{
				width: '100%',
				height: '100%',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}>
				{/* Toolbar */}
				<div style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '6px 12px',
					borderBottom: '1px solid var(--vscode-panel-border)',
					backgroundColor: 'var(--vscode-titleBar-activeBackground)',
				}}>
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						<span style={{ fontWeight: 600, fontSize: '13px' }}>{workflowName || 'Workflow Editor'}</span>
						<span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
							{nodes.length} nodes · {edges.length} connections
						</span>
					</div>
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						<span style={{ fontSize: '11px', color: saveStatus === 'saved' ? '#22c55e' : saveStatus === 'error' ? '#ef4444' : 'var(--vscode-descriptionForeground)' }}>
							{saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : saveStatus === 'error' ? 'Save failed' : ''}
						</span>
						<button onClick={handleSave} disabled={saving}
							style={{
								padding: '4px 12px',
								border: '1px solid var(--vscode-button-border)',
								borderRadius: '4px',
								backgroundColor: 'var(--vscode-button-background)',
								color: 'var(--vscode-button-foreground)',
								cursor: saving ? 'not-allowed' : 'pointer',
								fontSize: '12px',
								opacity: saving ? 0.5 : 1,
							}}>
							{saving ? 'Saving...' : 'Save'}
						</button>
					</div>
				</div>

				{/* Main area */}
				<div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
					<NodePalette collapsed={paletteCollapsed} onToggle={() => setPaletteCollapsed(!paletteCollapsed)} />
					<div style={{ flex: 1, position: 'relative' }}>
						<WorkflowCanvas />
						<PropertyPanel />
					</div>
				</div>
			</div>
		</ReactFlowProvider>
	);
};
