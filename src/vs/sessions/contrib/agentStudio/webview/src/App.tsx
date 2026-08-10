/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Root App Component
 *  Renders non-chat panels (workflow-editor, agent-settings, taskboard).
 *  Chat is handled natively by NativeChatEditorPane — the webview no longer
 *  renders a chat panel.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState, useCallback, Component } from 'react';
import { AgentEditorPane } from './features/agentEditor/AgentEditorPane';
import { TaskBoardPanel } from './features/taskboard/TaskBoardPanel';
import { useWorkspaceStore } from './store/useWorkspaceStore';

// Lazy-load the workflow editor — it pulls in LiteGraph (~large input) which is
// only needed when the user actually opens the workflow editor panel.
const WorkflowEditorPanel = React.lazy(() => import('./features/workflowEditor/WorkflowEditorPanel'));
import { useAgentStore } from './store/useAgentStore';
import { useProviderStore } from './store/useProviderStore';

// Read the panel type injected by the VS Code host
type PanelType = 'chat' | 'taskboard' | 'workflow-editor' | 'agent-settings' | '__pooled__' | undefined;
const initialPanelType: PanelType = (window as any).__AGENT_STUDIO_PANEL_TYPE__ as PanelType;

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
 * AgentSettingsPanel — standalone panel for agent settings (editor pane)
 * ═══════════════════════════════════════════════════════════════════════════════ */

function AgentSettingsPanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
	const { loadProviders } = useProviderStore();

	// Read agentId from host-injected initial data (set by App component)
	const agentId = (() => {
		const data = (window as unknown as Record<string, unknown>).__AGENT_STUDIO_INITIAL_DATA__ as
			{ type: string; agentId: string } | null | undefined;
		if (data?.type === 'agent-settings' && data.agentId) {
			return data.agentId;
		}
		return null;
	})();

	useEffect(() => {
		console.log('[AgentSettingsPanel] init useEffect fired, agentId:', agentId);
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
	}, [agentId]);

	useEffect(() => {
		if (activeWorkspaceId) {
			useAgentStore.getState().loadAgents(activeWorkspaceId);
		}
	}, [activeWorkspaceId]);

	useEffect(() => {
		const onAgentsChanged = () => {
			const currentActiveId = useWorkspaceStore.getState().activeWorkspaceId;
			useAgentStore.getState().loadAgents(currentActiveId || undefined);
		};
		const onActiveWorkspaceChanged = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId && detail.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
				setActiveWorkspace(detail.workspaceId);
			}
		};
		window.addEventListener('agentStudio:agents-changed', onAgentsChanged);
		window.addEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
		return () => {
			window.removeEventListener('agentStudio:agents-changed', onAgentsChanged);
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
 * App entry — routes to the correct panel based on panelType.
 * panelType is reactive: when a pooled webview is activated via the
 * 'agentStudio:pool-activate' custom event, the App re-renders with the
 * real panel type.
 * ═══════════════════════════════════════════════════════════════════════════════ */

export function App(): React.ReactElement {
	const [panelType, setPanelType] = useState<PanelType>(initialPanelType);
	const [initialData, setInitialData] = useState<unknown>(
		(window as any).__AGENT_STUDIO_INITIAL_DATA__ ?? null
	);

	useEffect(() => {
		const onPoolActivate = (e: Event) => {
			const detail = (e as CustomEvent).detail as { panelType?: PanelType; initialData?: unknown };
			const newType = detail?.panelType ?? undefined;
			// Update the global so any code that reads it directly still works
			(window as any).__AGENT_STUDIO_PANEL_TYPE__ = newType;
			if (detail?.initialData !== undefined) {
				(window as any).__AGENT_STUDIO_INITIAL_DATA__ = detail.initialData;
				setInitialData(detail.initialData);
			}
			setPanelType(newType === '__pooled__' ? undefined : newType);
		};
		window.addEventListener('agentStudio:pool-activate', onPoolActivate);
		return () => window.removeEventListener('agentStudio:pool-activate', onPoolActivate);
	}, []);

	// While pooled (waiting for activation), render nothing meaningful
	if (panelType === '__pooled__') {
		return (
			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--vscode-descriptionForeground)' }}>
				<span style={{ fontSize: 13, opacity: 0.7 }}>Agent Studio (warming...)</span>
			</div>
		);
	}

	switch (panelType) {
		case 'taskboard':
			return <TaskboardPanel />;
		case 'workflow-editor':
			return (
				<div className="panel-standalone" style={{ width: '100vw', height: '100vh' }}>
					<PanelErrorBoundary panelType="WorkflowEditorPanel">
						<React.Suspense fallback={<div style={{ padding: 20, color: 'var(--vscode-descriptionForeground)' }}>Loading workflow editor...</div>}>
							<WorkflowEditorPanel />
						</React.Suspense>
					</PanelErrorBoundary>
				</div>
			);
		case 'agent-settings': {
			// Use initialData as key to force re-mount when agentId changes (pool reuse)
			const agentId = (initialData as { type?: string; agentId?: string } | null)?.agentId;
			return <AgentSettingsPanel key={agentId ?? 'no-agent'} />;
		}
		default:
			// Chat is now handled natively by NativeChatEditorPane.
			// If we reach here, the webview was activated without a valid panel type.
			return (
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--vscode-descriptionForeground)' }}>
					<span style={{ fontSize: 13, opacity: 0.7 }}>Agent Studio</span>
				</div>
			);
	}
}
