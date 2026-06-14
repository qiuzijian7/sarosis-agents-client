/*---------------------------------------------------------------------------------------------
 *  WorkflowEditorPanel — main panel component for the workflow-editor webview.
 *
 *  Layout:
 *   ┌─────────────────────────────────────────┐
 *   │               Toolbar                    │
 *   ├─────────────────────────────────────────┤
 *   │  📝 任务描述：[        editable...       ] │
 *   ├─────────────────────────────────────────┤
 *   │ ┌──────────┐                            │
 *   │ │NodePalette│▶  ◀──────────┐            │
 *   │ │(overlay) │   WorkflowCanvas│          │
 *   │ └──────────┘               │            │
 *   └────────────────────────────┴────────────┘
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState, useCallback, useRef } from 'react';
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
	const [paletteWidth, setPaletteWidth] = useState(200); // v40: resizable palette width
	const [editingDescription, setEditingDescription] = useState(false); // v41: multi-line edit toggle
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
	const workflowDescription = useWorkflowEditorStore(s => s.workflowDescription);
	const setWorkflowDescription = useWorkflowEditorStore(s => s.setWorkflowDescription);
	const toWorkflowData = useWorkflowEditorStore(s => s.toWorkflowData);
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const edges = useWorkflowEditorStore(s => s.edges);
	const setDefaultAgentConfig = useWorkflowEditorStore(s => s.setDefaultAgentConfig);

	// Agents list (to look up the workflow's bound agent)
	const agents = useAgentStore(s => s.agents);

	// v18: When a workflow is loaded, auto-switch the chat panel to its bound agent
	// and restore the agent's most recent session.
	const autoSwitchChatToWorkflowAgent = useCallback(async (workflowAgentId: string) => {
		if (!workflowAgentId) { return; }
		try {
			const mod = await import('../../store/useChatStore');
			const chatStore = mod.useChatStore.getState();
			console.log(`[WorkflowEditor] auto-switching chat to workflow agent: ${workflowAgentId}`);
			chatStore.setActiveAgent(workflowAgentId, { autoActivateLatestSession: true });
		} catch (err) {
			console.warn('[WorkflowEditor] failed to auto-switch chat panel:', err);
		}
	}, []);

	// Load initial data from the host-injected __AGENT_STUDIO_INITIAL_DATA__
	useEffect(() => {
		if (loaded) { return; }
		const initialData = (window as unknown as Record<string, unknown>).__AGENT_STUDIO_INITIAL_DATA__ as
			{ type: string; workflow: IStoredWorkflow } | null | undefined;

		if (initialData?.type === 'workflow' && initialData.workflow) {
			loadWorkflow(initialData.workflow);
			setLoaded(true);
			// v18: auto-switch chat panel to workflow's bound agent
			if (initialData.workflow.agentId) {
				autoSwitchChatToWorkflowAgent(initialData.workflow.agentId);
			}
		}
	}, [loaded, loadWorkflow, autoSwitchChatToWorkflowAgent]);

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
					// v18: also auto-switch chat panel when workflow state is applied
					autoSwitchChatToWorkflowAgent(detail.workflow.agentId);
				}
			}
		};
		window.addEventListener('agentStudio:workflow-state-applied', handler);
		return () => window.removeEventListener('agentStudio:workflow-state-applied', handler);
	}, [loadWorkflow, agents, setDefaultAgentConfig, autoSwitchChatToWorkflowAgent]);

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
			const state = useWorkflowEditorStore.getState();
			const name = state.workflowName;
			const description = state.workflowDescription;
			const result = await sendRequest('workflow.save', {
				workflow: {
					id: workflowId,
					nodes: gnodes,
					connections,
					name,
					description,
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

	// ═══════════════════════════════════════════════════════════════════
	// v38: Auto-save — debounce-persist workflow after node/edge changes.
	// Without this, provider/model changes in agent nodes only live in
	// Zustand memory and are lost on reload. Fires 2s after the last edit.
	// ═══════════════════════════════════════════════════════════════════
	const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const autoSave = useCallback(async () => {
		const state = useWorkflowEditorStore.getState();
		if (!state.workflowId) { return; }
		try {
			const { nodes: gnodes, connections } = state.toWorkflowData();
			await sendRequest('workflow.save', {
				workflow: {
					id: state.workflowId,
					nodes: gnodes,
					connections,
					name: state.workflowName,
					description: state.workflowDescription,
				},
			});
		} catch {
			// Silently ignore auto-save errors (manual save still reports)
		}
	}, []);
	useEffect(() => {
		if (!loaded || !workflowId) { return; }
		clearTimeout(autoSaveTimerRef.current);
		autoSaveTimerRef.current = setTimeout(() => { autoSave(); }, 2000);
		return () => clearTimeout(autoSaveTimerRef.current);
	}, [nodes, edges, loaded, workflowId, autoSave]);

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
					// 🔧 2026-06-12 fix: only auto-switch when we're not already on the
					// target agent+session. Without this guard the second switch wipes
					// `liveWorkflowExecutions[newSessionId]` (which the trace event
					// handler just populated via `startWorkflowExecution`), causing
					// all subsequent subagent_start events to be dropped silently —
					// resulting in no tool cards showing in the chat panel. The trace
					// event's own auto-switch already handles the actual transition.
					const cur = mod.useChatStore.getState();
					if (cur.activeAgentId !== sessionInfo.workflowAgentId ||
						cur.activeAgentSessionId !== sessionInfo.sessionId) {
						mod.useChatStore.getState().setActiveAgent(sessionInfo.workflowAgentId);
						await mod.useChatStore.getState().switchAgentSession(sessionInfo.sessionId);
						console.log(`[WorkflowEditor] auto-switched to owner agent ${sessionInfo.workflowAgentId} session ${sessionInfo.sessionId}`);
					}
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

	// v40: Resize handler for NodePalette panel
	const handleResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = paletteWidth;
		const onMouseMove = (ev: MouseEvent) => {
			const dx = ev.clientX - startX;
			const newWidth = Math.max(120, Math.min(400, startWidth + dx));
			setPaletteWidth(newWidth);
		};
		const onMouseUp = () => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
		};
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
	}, [paletteWidth]);

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

				{/* v41: Editable task description bar — single-line display, multi-line on click */}
				<div style={{
					display: 'flex',
					alignItems: editingDescription ? 'flex-start' : 'center',
					padding: editingDescription ? '6px 12px' : '4px 12px',
					borderBottom: '1px solid var(--vscode-panel-border)',
					backgroundColor: editingDescription
						? 'var(--vscode-input-background)'
						: 'var(--vscode-editor-background)',
					gap: '8px',
					transition: 'padding 0.12s ease, background-color 0.12s ease',
				}}>
					<span style={{
						fontSize: '11px',
						fontWeight: 500,
						color: 'var(--vscode-descriptionForeground)',
						whiteSpace: 'nowrap',
						flexShrink: 0,
						paddingTop: editingDescription ? '5px' : '0',
					}}>
						📝 任务描述
					</span>
					{!editingDescription ? (
						/* Default: single-line display, click to edit */
						<div
							onClick={() => setEditingDescription(true)}
							title="点击编辑任务描述"
							style={{
								flex: 1,
								padding: '3px 6px',
								fontSize: '12px',
								color: workflowDescription
									? 'var(--vscode-foreground)'
									: 'var(--vscode-descriptionForeground)',
								fontStyle: workflowDescription ? 'normal' : 'italic',
								cursor: 'text',
								borderRadius: '2px',
								border: '1px solid transparent',
								overflow: 'hidden',
								whiteSpace: 'nowrap',
								textOverflow: 'ellipsis',
								userSelect: 'none',
							}}
							onMouseEnter={e => {
								e.currentTarget.style.borderColor = 'var(--vscode-focusBorder)';
								e.currentTarget.style.background = 'var(--vscode-input-background)';
							}}
							onMouseLeave={e => {
								e.currentTarget.style.borderColor = 'transparent';
								e.currentTarget.style.background = 'transparent';
							}}
						>
							{workflowDescription || '描述这个工作流的任务目标与流程...'}
						</div>
					) : (
						/* Editing: multi-line textarea */
						<div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
							<textarea
								autoFocus
								value={workflowDescription}
								onChange={e => setWorkflowDescription(e.target.value)}
								placeholder="描述这个工作流的任务目标与流程..."
								rows={Math.max(2, (workflowDescription.match(/\n/g) || []).length + 1)}
								style={{
									width: '100%',
									border: '1px solid var(--vscode-focusBorder)',
									borderRadius: '2px',
									background: 'var(--vscode-input-background)',
									color: 'var(--vscode-foreground)',
									padding: '4px 8px',
									fontSize: '12px',
									lineHeight: 1.5,
									outline: 'none',
									resize: 'vertical',
									fontFamily: 'inherit',
									minHeight: '40px',
								}}
								onBlur={() => setEditingDescription(false)}
								onKeyDown={e => {
									// Escape collapses without saving changes beyond current value
									if (e.key === 'Escape') {
										(e.target as HTMLTextAreaElement).blur();
									}
								}}
							/>
							<div style={{
								fontSize: '10px',
								color: 'var(--vscode-descriptionForeground)',
								marginTop: '2px',
								paddingLeft: '2px',
							}}>
								Esc 退出编辑 · 支持多行描述
							</div>
						</div>
					)}
				</div>

			{/* Main area — palette overlays canvas, canvas always full-width */}
			<div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
				{/* v41: Palette floats above the canvas as an absolute overlay.
				     When collapsed it slides off-screen; canvas width is never affected. */}
				<div style={{
					position: 'absolute',
					left: paletteCollapsed ? -paletteWidth : 0,
					top: 0,
					bottom: 0,
					zIndex: 10,
					transition: 'left 0.22s ease',
					display: 'flex',
				}}>
					<NodePalette
						collapsed={paletteCollapsed}
						onToggle={() => setPaletteCollapsed(!paletteCollapsed)}
						width={paletteWidth}
					/>
					{/* Resize handle — attached to palette right edge, part of overlay */}
					{!paletteCollapsed && (
						<div
							onMouseDown={handleResizeStart}
							style={{
								width: '4px',
								cursor: 'col-resize',
								backgroundColor: 'transparent',
								transition: 'background-color 0.15s ease',
							}}
							onMouseEnter={e => { (e.target as HTMLElement).style.backgroundColor = 'var(--vscode-focusBorder)'; }}
							onMouseLeave={e => { (e.target as HTMLElement).style.backgroundColor = 'transparent'; }}
						/>
					)}
				</div>

				{/* Collapsed-state floating trigger — slides in when palette is hidden */}
				{paletteCollapsed && (
					<button
						onClick={() => setPaletteCollapsed(false)}
						title="Show Nodes panel"
						style={{
							position: 'absolute',
							left: 6,
							top: 8,
							zIndex: 11,
							width: 26,
							height: 26,
							borderRadius: 4,
							border: '1px solid var(--vscode-panel-border)',
							backgroundColor: 'var(--vscode-sideBar-background)',
							color: 'var(--vscode-foreground)',
							cursor: 'pointer',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							fontSize: 11,
							opacity: 0.85,
							boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
							transition: 'opacity 0.15s ease',
						}}
						onMouseEnter={e => { (e.target as HTMLElement).style.opacity = '1'; }}
						onMouseLeave={e => { (e.target as HTMLElement).style.opacity = '0.85'; }}
					>
						▶
					</button>
				)}

				{/* Canvas — always fills the full area */}
				<div style={{ width: '100%', height: '100%' }}>
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
