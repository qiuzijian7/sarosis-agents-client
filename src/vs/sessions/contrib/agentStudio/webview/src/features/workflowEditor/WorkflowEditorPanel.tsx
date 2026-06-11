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
import { useWorkflowEditorStore, undo as doUndo, redo as doRedo } from './store';
import { sendRequest } from '../../bridge/messageClient';
import { useAgentStore } from '../../store/useAgentStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import type { IStoredWorkflow } from '../../types/workflowStorage';

export const WorkflowEditorPanel: React.FC = () => {
	const [paletteCollapsed, setPaletteCollapsed] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
	const [validationMsg, setValidationMsg] = useState<string | null>(null);

	// Execution state (P3: execution control UI)
	const [executionId, setExecutionId] = useState<string | null>(null);
	const [executionStatus, setExecutionStatus] = useState<string | null>(null);
	const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);

	// v12: ensure workspace store is populated so child components can read activeWorkspaceId
	const loadWorkspaces = useWorkspaceStore(s => s.loadWorkspaces);
	useEffect(() => {
		loadWorkspaces();
	}, [loadWorkspaces]);

	const loadWorkflow = useWorkflowEditorStore(s => s.loadWorkflow);
	const workflowId = useWorkflowEditorStore(s => s.workflowId);
	const workflowName = useWorkflowEditorStore(s => s.workflowName);
	const setWorkflowName = useWorkflowEditorStore(s => s.setWorkflowName);
	const toWorkflowData = useWorkflowEditorStore(s => s.toWorkflowData);
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const edges = useWorkflowEditorStore(s => s.edges);
	const setDefaultAgentConfig = useWorkflowEditorStore(s => s.setDefaultAgentConfig);

	// Agents list (to look up the workflow's bound agent)
	const agents = useAgentStore(s => s.agents);

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

	// Sync default agent config from the workflow's bound agent.
	// When a new agent node is created, it inherits this agent's provider/model.
	useEffect(() => {
		const wf = (window as unknown as Record<string, unknown>).__AGENT_STUDIO_INITIAL_DATA__ as
			{ type: string; workflow: IStoredWorkflow } | null | undefined;
		if (!wf?.workflow?.agentId || !agents.length) { return; }

		const workflowAgent = agents.find(a => a.id === wf.workflow.agentId);
		if (workflowAgent) {
			setDefaultAgentConfig({
				agentId: workflowAgent.id,
				providerId: workflowAgent.providerId || '',
				modelId: workflowAgent.modelId || (typeof workflowAgent.model === 'string' ? workflowAgent.model as string : ''),
			});
		}
	}, [agents, loaded, setDefaultAgentConfig]);

	// Listen for AI-driven workflow changes pushed from Host
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as {
				workflow: IStoredWorkflow;
				description?: string;
			} | undefined;
			if (detail?.workflow) {
				console.log(`[WorkflowEditor] Received workflow.stateApplied → id=${detail.workflow.id}`);
				loadWorkflow(detail.workflow);
				// Re-sync default agent config from the reloaded workflow
				if (detail.workflow.agentId && agents.length) {
					const wfAgent = agents.find(a => a.id === detail.workflow.agentId);
					if (wfAgent) {
						setDefaultAgentConfig({
							agentId: wfAgent.id,
							providerId: wfAgent.providerId || '',
							modelId: wfAgent.modelId || (typeof wfAgent.model === 'string' ? wfAgent.model as string : ''),
						});
					}
				}
			}
		};
		window.addEventListener('agentStudio:workflow-state-applied', handler);
		return () => window.removeEventListener('agentStudio:workflow-state-applied', handler);
	}, [loadWorkflow, agents, setDefaultAgentConfig]);

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

	// Listen for workflow execution updates from Host (P3: execution control)
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as {
				executionId: string;
				status: string;
				currentNodeId?: string;
				nodeStates: Record<string, {
					status: string;
					startTime?: string;
					endTime?: string;
					error?: string;
					output?: unknown;
				}>;
				breakpoints?: string[];
			} | undefined;
			
			if (detail) {
				console.log(`[WorkflowEditor] Received workflow.executionUpdate:`, detail);
				setExecutionId(detail.executionId);
				setExecutionStatus(detail.status);
				setCurrentNodeId(detail.currentNodeId || null);
				
				// Update store with execution state
				const { setExecutionState, setBreakpoints } = useWorkflowEditorStore.getState();
				setExecutionState(
					detail.executionId,
					detail.status as 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
					detail.currentNodeId || null,
					detail.nodeStates
				);
				
				if (detail.breakpoints) {
					setBreakpoints(detail.breakpoints);
				}
			}
		};
	
		window.addEventListener('agentStudio:workflow-execution-update', handler);
		return () => window.removeEventListener('agentStudio:workflow-execution-update', handler);
	}, []);

	const handleSave = useCallback(async () => {
		if (saving || !workflowId) { return; }
		setSaving(true);
		setSaveStatus('saving');
		try {
			const { nodes: gnodes, connections } = toWorkflowData();
			const name = useWorkflowEditorStore.getState().workflowName;
			const result = await sendRequest('workflow.save', {
				workflow: {
					id: workflowId,
					nodes: gnodes,
					connections,
					name,
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

	const handleExecute = useCallback(async () => {
		if (!workflowId) { return; }
		try {
			const result = await sendRequest('workflow.execute', {
				workflowId,
			}) as { executionId: string };
			setExecutionId(result?.executionId || null);
			setExecutionStatus('running');

			// P4: host returns the owner-agent session info so the user can
			// jump straight into the chat panel where the live trace is rendered.
			const sessionInfo = (result as any)?.sessionInfo as
				| { workflowAgentId: string; sessionId: string; workflowName: string }
				| undefined;
			if (sessionInfo?.workflowAgentId && sessionInfo?.sessionId) {
				const chatStore = (window as any).__AGENT_STUDIO_CHAT_STORE__;
				// Prefer direct store hook (cleaner), fall back to global if not exposed
				try {
					const mod = await import('../../store/useChatStore');
					mod.useChatStore.getState().setActiveAgent(sessionInfo.workflowAgentId);
					await mod.useChatStore.getState().switchAgentSession(sessionInfo.sessionId);
					console.log(`[WorkflowEditor] auto-switched to owner agent ${sessionInfo.workflowAgentId} session ${sessionInfo.sessionId}`);
				} catch (err) {
					console.warn('[WorkflowEditor] failed to auto-switch chat panel:', err);
				}
			}
		} catch (err) {
			console.error('[WorkflowEditor] Failed to execute workflow:', err);
		}
	}, [workflowId]);

	const handlePause = useCallback(async () => {
		if (!executionId) { return; }
		try {
			await sendRequest('workflow.pause', { executionId });
		} catch (err) {
			console.error('[WorkflowEditor] Failed to pause workflow:', err);
		}
	}, [executionId]);

	const handleResume = useCallback(async () => {
		if (!executionId) { return; }
		try {
			// For now, resume with empty input (AskUser node will handle real input)
			await sendRequest('workflow.resume', { executionId, userInput: '' });
		} catch (err) {
			console.error('[WorkflowEditor] Failed to resume workflow:', err);
		}
	}, [executionId]);

	const handleCancel = useCallback(async () => {
		if (!executionId) { return; }
		try {
			await sendRequest('workflow.cancel', { executionId });
			setExecutionId(null);
			setExecutionStatus(null);
			setCurrentNodeId(null);
		} catch (err) {
			console.error('[WorkflowEditor] Failed to cancel workflow:', err);
		}
	}, [executionId]);

	const handleValidate = useCallback(() => {
		const result = useWorkflowEditorStore.getState().validateWorkflow();
		if (result.valid && result.issues.length === 0) {
			setValidationMsg('✓ Workflow is valid');
		} else {
			const errors = result.issues.filter(i => i.level === 'error').length;
			const warnings = result.issues.filter(i => i.level === 'warning').length;
			const first = result.issues[0]?.message ?? '';
			setValidationMsg(`${errors} error(s), ${warnings} warning(s) · ${first}`);
		}
		setTimeout(() => setValidationMsg(null), 5000);
	}, []);

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
						<input
							type="text"
							value={workflowName}
							onChange={e => setWorkflowName(e.target.value)}
							placeholder="Workflow Name"
							style={{
								fontWeight: 600,
								fontSize: '13px',
								border: '1px solid transparent',
								borderRadius: '2px',
								background: 'transparent',
								color: 'var(--vscode-foreground)',
								padding: '2px 4px',
								width: '180px',
								outline: 'none',
							}}
							onFocus={e => {
								e.target.style.borderColor = 'var(--vscode-focusBorder)';
								e.target.style.background = 'var(--vscode-input-background)';
							}}
							onBlur={e => {
								e.target.style.borderColor = 'transparent';
								e.target.style.background = 'transparent';
							}}
						/>
						<span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
							{nodes.length} nodes · {edges.length} connections
						</span>
					</div>
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						<span style={{ fontSize: '11px', color: validationMsg?.startsWith('✓') ? '#22c55e' : validationMsg ? '#f59e0b' : saveStatus === 'saved' ? '#22c55e' : saveStatus === 'error' ? '#ef4444' : 'var(--vscode-descriptionForeground)' }}>
							{validationMsg
								? validationMsg
								: saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : saveStatus === 'error' ? 'Save failed' : ''}
						</span>
						<button onClick={() => doUndo()} title="Undo (Ctrl+Z)" style={iconBtnStyle}>↶</button>
						<button onClick={() => doRedo()} title="Redo (Ctrl+Shift+Z)" style={iconBtnStyle}>↷</button>
						<button onClick={handleValidate} title="Validate workflow" style={iconBtnStyle}>✓</button>
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
						{/* Execution control buttons (P3) */}
						{!executionStatus || executionStatus === 'completed' || executionStatus === 'failed' || executionStatus === 'cancelled' ? (
							<button onClick={handleExecute} title="Run workflow" style={{
								padding: '4px 12px',
								border: '1px solid #22c55e',
								borderRadius: '4px',
								backgroundColor: '#22c55e',
								color: 'white',
								cursor: 'pointer',
								fontSize: '12px',
								fontWeight: 600,
							}}>
								▶ Run
							</button>
						) : executionStatus === 'running' ? (
							<>
								<button onClick={handlePause} title="Pause execution" style={{
									padding: '4px 12px',
									border: '1px solid #f59e0b',
									borderRadius: '4px',
									backgroundColor: '#f59e0b',
									color: 'white',
									cursor: 'pointer',
									fontSize: '12px',
									fontWeight: 600,
								}}>
									⏸ Pause
								</button>
								<button onClick={handleCancel} title="Cancel execution" style={{
									padding: '4px 12px',
									border: '1px solid #ef4444',
									borderRadius: '4px',
									backgroundColor: '#ef4444',
									color: 'white',
									cursor: 'pointer',
									fontSize: '12px',
									fontWeight: 600,
								}}>
									✕ Cancel
								</button>
							</>
						) : executionStatus === 'paused' ? (
							<>
								<button onClick={handleResume} title="Resume execution" style={{
									padding: '4px 12px',
									border: '1px solid #22c55e',
									borderRadius: '4px',
									backgroundColor: '#22c55e',
									color: 'white',
									cursor: 'pointer',
									fontSize: '12px',
									fontWeight: 600,
								}}>
									▶ Resume
								</button>
								<button onClick={handleCancel} title="Cancel execution" style={{
									padding: '4px 12px',
									border: '1px solid #ef4444',
									borderRadius: '4px',
									backgroundColor: '#ef4444',
									color: 'white',
									cursor: 'pointer',
									fontSize: '12px',
									fontWeight: 600,
								}}>
									✕ Cancel
								</button>
							</>
						) : null}
					</div>
				</div>

				{/* Main area */}
				<div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
					<NodePalette collapsed={paletteCollapsed} onToggle={() => setPaletteCollapsed(!paletteCollapsed)} />
					<div style={{ flex: 1, position: 'relative' }}>
						<WorkflowCanvas />
					</div>
				</div>
			</div>
		</ReactFlowProvider>
	);
};

const iconBtnStyle: React.CSSProperties = {
	width: '26px',
	height: '26px',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	border: '1px solid var(--vscode-button-border)',
	borderRadius: '4px',
	backgroundColor: 'transparent',
	color: 'var(--vscode-foreground)',
	cursor: 'pointer',
	fontSize: '14px',
};

export default WorkflowEditorPanel;
