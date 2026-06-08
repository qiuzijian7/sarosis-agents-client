/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Root App Component
 *  Supports two modes:
 *    A) Independent panel mode — renders a single panel based on window.__AGENT_STUDIO_PANEL_TYPE__
 *       ('chat')
 *    B) Legacy full layout — single-zone chat layout when panelType is undefined
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useCallback, useState, Component, type ReactNode } from 'react';
import { WorkspaceToolbar } from './features/title/WorkspaceToolbar';
import { AgentChat as EmployeeChat } from './features/chat/EmployeeChat';
import { AgentEditorPane } from './features/agentEditor/AgentEditorPane';
import { CreateAgentModal } from './features/employees/CreateAgentModal';
import { TaskBoardPanel } from './features/taskboard/TaskBoardPanel';
import { WorkflowEditorPanel } from './features/workflowEditor/WorkflowEditorPanel';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { useAgentStore } from './store/useAgentStore';
import { useProviderStore } from './store/useProviderStore';
import { useChatStore } from './store/useChatStore';
import { sendRequest } from './bridge/messageClient';
import { perfTrace } from './utils/perfTrace';

// Read the panel type injected by the VS Code host
type PanelType = 'chat' | 'taskboard' | 'workflow-editor' | 'agent-settings' | undefined;
const panelType: PanelType = (window as any).__AGENT_STUDIO_PANEL_TYPE__ as PanelType;

/* ── Error Boundary for debugging render crashes ─────────────── */
interface ErrorBoundaryProps {
	children: React.ReactNode;
	panelType: string;
}
interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}
class PanelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}
	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}
	componentDidCatch(error: Error, info: React.ErrorInfo): void {
		console.error(`[${this.props.panelType}] React render error:`, error, info);
	}
	render(): React.ReactNode {
		if (this.state.hasError) {
			return (
				<div style={{ padding: 20, color: '#f48771', fontFamily: 'monospace', fontSize: 12 }}>
					<h3>{this.props.panelType} Render Error</h3>
					<pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
						{this.state.error?.message}
						{'\n\n'}
						{this.state.error?.stack}
					</pre>
				</div>
			);
		}
		return this.props.children;
	}
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * Independent panel components (rendered when panelType is set)
 * ═══════════════════════════════════════════════════════════════════════════════ */

function ChatPanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
	const { loadProviders } = useProviderStore();

	useEffect(() => {
		// Load workspaces and providers; agents will be loaded once activeWorkspaceId is set
		perfTrace.mark('chat-panel-mount');
		loadWorkspaces().then(() => {
			perfTrace.mark('workspaces-loaded');
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				const pick = store.workspaces.find(w => !!(w as any).path) ?? store.workspaces[0];
				store.setActiveWorkspace(pick.id);
			}
			// Fallback: if no workspaces registered, try loading agents directly.
			if (store.workspaces.length === 0) {
				useAgentStore.getState().loadAgents().then(() => perfTrace.mark('agents-loaded'));
			}
		});
		loadProviders();
	}, []);

	useEffect(() => {
		if (activeWorkspaceId) {
			useAgentStore.getState().loadAgents(activeWorkspaceId).then(() => perfTrace.mark('agents-loaded'));
		}
	}, [activeWorkspaceId]);

	useEffect(() => {
		const onEmployeesChanged = () => {
			// Read activeWorkspaceId from store at event-time (not from stale closure).
			const currentActiveId = useWorkspaceStore.getState().activeWorkspaceId;
			useAgentStore.getState().loadAgents(currentActiveId || undefined);
		};
		const onActiveWorkspaceChanged = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId && detail.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
				setActiveWorkspace(detail.workspaceId);
			}
		};
		window.addEventListener('agentStudio:employees-changed', onEmployeesChanged);
		window.addEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
		return () => {
			window.removeEventListener('agentStudio:employees-changed', onEmployeesChanged);
			window.removeEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
		};
	}, [activeWorkspaceId, setActiveWorkspace]);

	// Phase 3: register the (agentId, agentSessionId) currently visible
	// in this chat panel with the host. The host needs this so that imgui
	// form submits originating in a separate ConfigMD preview pane can be
	// routed back into the same Fork session the user is looking at, and
	// so that multiple chat panels don't double-handle the same submit.
	//
	// We use zustand's plain `subscribe` (no selector middleware required)
	// and dedupe by comparing previous values. The initial state is also
	// flushed once on mount so the host learns about the currently selected
	// agent even if the user never switches.
	useEffect(() => {
		let prevAgentId: string | null | undefined = undefined;
		let prevAgentSessionId: string | null | undefined = undefined;
		const flush = (agentId: string | null, agentSessionId: string | null) => {
			if (agentId === prevAgentId && agentSessionId === prevAgentSessionId) {
				return;
			}
			prevAgentId = agentId;
			prevAgentSessionId = agentSessionId;
			console.log(`[ChatPanel] notify host chat.activeSessionChanged: agentId=${agentId} agentSessionId=${agentSessionId}`);
			sendRequest('chat.activeSessionChanged', {
				agentId,
				agentSessionId,
			}).catch((err: unknown) =>
				console.warn('[ChatPanel] chat.activeSessionChanged failed:', err)
			);
		};
		// Flush initial state.
		const initial = useChatStore.getState();
		flush(initial.activeAgentId, initial.activeAgentSessionId);
		// Subscribe to subsequent changes.
		const unsubscribe = useChatStore.subscribe((state) => {
			flush(state.activeAgentId, state.activeAgentSessionId);
		});
		return () => {
			unsubscribe();
			// On unmount (panel closed), clear the registration.
			sendRequest('chat.activeSessionChanged', {
				agentId: null,
				agentSessionId: null,
			}).catch(() => { /* shutting down */ });
		};
	}, []);

	return (
		<div className="panel-standalone">
			<PanelErrorBoundary panelType="ChatPanel">
				<EmployeeChat />
			</PanelErrorBoundary>
		</div>
	);
}

function TaskboardPanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();

	useEffect(() => {
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				const pick = store.workspaces.find(w => !!(w as any).path) ?? store.workspaces[0];
				store.setActiveWorkspace(pick.id);
			}
		});
	}, []);

	useEffect(() => {
		if (activeWorkspaceId) {
			useAgentStore.getState().loadAgents(activeWorkspaceId);
		}
	}, [activeWorkspaceId]);

	useEffect(() => {
		const onActiveWorkspaceChanged = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId && detail.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
				setActiveWorkspace(detail.workspaceId);
			}
		};
		window.addEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
		return () => window.removeEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
	}, [setActiveWorkspace]);

	return (
		<div className="panel-standalone">
			<div className="panel-standalone-content">
				<PanelErrorBoundary panelType="TaskboardPanel">
					<TaskBoardPanel />
				</PanelErrorBoundary>
			</div>
		</div>
	);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * Full layout (legacy mode, rendered when panelType is undefined)
 * ═══════════════════════════════════════════════════════════════════════════════ */

function FullLayout(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId } = useWorkspaceStore();
	const { loadProviders } = useProviderStore();

	// Initialize on mount
	useEffect(() => {
		// Load workspaces and providers; agents will be loaded once activeWorkspaceId is set
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				const pick = store.workspaces.find(w => !!(w as any).path) ?? store.workspaces[0];
				store.setActiveWorkspace(pick.id);
			}
		});
		loadProviders();
	}, []);

	// Reload agents when workspace changes
	useEffect(() => {
		if (activeWorkspaceId) {
			useAgentStore.getState().loadAgents(activeWorkspaceId);
		}
	}, [activeWorkspaceId]);

	// Listen for host events
	useEffect(() => {
		const onEmployeesChanged = () => {
			// Read activeWorkspaceId from store at event-time (not from stale closure).
			const currentActiveId = useWorkspaceStore.getState().activeWorkspaceId;
			useAgentStore.getState().loadAgents(currentActiveId || undefined);
		};
		const onWorkspaceChanged = () => { loadWorkspaces(); };

		window.addEventListener('agentStudio:employees-changed', onEmployeesChanged);
		window.addEventListener('agentStudio:workspace-changed', onWorkspaceChanged);

		return () => {
			window.removeEventListener('agentStudio:employees-changed', onEmployeesChanged);
			window.removeEventListener('agentStudio:workspace-changed', onWorkspaceChanged);
		};
	}, [loadWorkspaces, activeWorkspaceId]);


	const handleAddEmployee = useCallback(() => {
		setShowAddEmployeeModal(true);
	}, []);

	const [showAddEmployeeModal, setShowAddEmployeeModal] = useState(false);

	const handleRefresh = useCallback(() => {
		if (activeWorkspaceId) {
			useAgentStore.getState().loadAgents(activeWorkspaceId);
		}
	}, [activeWorkspaceId]);

	return (
		<div className="app-root">
			{/* ① Title Bar */}
			<WorkspaceToolbar
				onAddEmployee={handleAddEmployee}
				onRefresh={handleRefresh}
			/>

			{/* Main content area: chat */}
			<div className="main-content">
				{/* ② Chat panel (full width) */}
				<div className="workspace-panel">
					<EmployeeChat />
				</div>
			</div>

			{/* Create Agent Modal */}
			<CreateAgentModal
				isOpen={showAddEmployeeModal}
				onClose={() => {
					setShowAddEmployeeModal(false);
					if (activeWorkspaceId) {
						useAgentStore.getState().loadAgents(activeWorkspaceId);
					}
				}}
				workspaceId={activeWorkspaceId || undefined}
			/>
		</div>
	);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * AgentSettingsPanel — standalone panel for agent settings (editor pane)
 * ═══════════════════════════════════════════════════════════════════════════════ */

function AgentSettingsPanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
	const { loadProviders } = useProviderStore();

	// Read the agentId from host-injected initial data
	const [agentId, setAgentId] = useState<string | null>(null);

	useEffect(() => {
		const initialData = (window as unknown as Record<string, unknown>).__AGENT_STUDIO_INITIAL_DATA__ as
			{ type: string; agentId: string } | null | undefined;
		if (initialData?.type === 'agent-settings' && initialData.agentId) {
			setAgentId(initialData.agentId);
		}
	}, []);

	useEffect(() => {
		console.log('[AgentSettingsPanel] init useEffect fired');
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				const pick = store.workspaces.find(w => !!(w as any).path) ?? store.workspaces[0];
				store.setActiveWorkspace(pick.id);
			}
		});
		loadProviders();
		// Load agents so AgentEditorPane can read systemPrompt/skills
		console.log('[AgentSettingsPanel] calling loadAgents...');
		useAgentStore.getState().loadAgents().then(() => {
			const { agents } = useAgentStore.getState();
			console.log('[AgentSettingsPanel] loadAgents completed, agents count:', agents.length);
		});
	}, []);

	useEffect(() => {
		if (activeWorkspaceId) {
			useAgentStore.getState().loadAgents(activeWorkspaceId);
		}
	}, [activeWorkspaceId]);

	useEffect(() => {
		const onEmployeesChanged = () => {
			const currentActiveId = useWorkspaceStore.getState().activeWorkspaceId;
			useAgentStore.getState().loadAgents(currentActiveId || undefined);
		};
		const onActiveWorkspaceChanged = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId && detail.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
				setActiveWorkspace(detail.workspaceId);
			}
		};
		window.addEventListener('agentStudio:employees-changed', onEmployeesChanged);
		window.addEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
		return () => {
			window.removeEventListener('agentStudio:employees-changed', onEmployeesChanged);
			window.removeEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
		};
	}, [setActiveWorkspace]);

	const handleClose = useCallback(() => {
		// Post a message to the host to close the editor pane
		window.postMessage({ type: 'agentStudio:close-self' }, '*');
	}, []);

	if (!agentId) {
		return (
			<div className="panel-standalone">
				<div style={{ padding: 20, color: '#888' }}>Loading agent settings...</div>
			</div>
		);
	}

	return (
		<div className="panel-standalone">
			<PanelErrorBoundary panelType="AgentSettingsPanel">
				<AgentEditorPane
					agentId={agentId}
					onClose={handleClose}
				/>
			</PanelErrorBoundary>
		</div>
	);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * App entry — routes to the correct panel based on panelType
 * ═══════════════════════════════════════════════════════════════════════════════ */

export function App(): React.ReactElement {
	switch (panelType) {
		case 'chat':
			return <ChatPanel />;
		case 'taskboard':
			return <TaskboardPanel />;
		case 'workflow-editor':
			return <WorkflowEditorPanel />;
		case 'agent-settings':
			return <AgentSettingsPanel />;
		default:
			return <FullLayout />;
	}
}
