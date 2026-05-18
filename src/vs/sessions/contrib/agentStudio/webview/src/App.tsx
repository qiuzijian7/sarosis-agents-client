/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Root App Component
 *  Supports two modes:
 *    A) Independent panel mode — renders a single panel based on window.__AGENT_STUDIO_PANEL_TYPE__
 *       ('canvas' | 'chat')
 *    B) Legacy full layout — two-zone layout when panelType is undefined
 *
 *  Canvas panel matches sarosis-webui workspace layout:
 *  - WorkspaceToolbar (top bar: workspace selector + view mode toggle + actions)
 *  - WorkspaceCanvas (main area: canvas/list mode with MiniMap, Controls, Background)
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useCallback, useState } from 'react';
import { WorkspaceToolbar } from './features/title/WorkspaceToolbar';
import { WorkspaceCanvas } from './features/canvas/WorkspaceCanvas';
import { EmployeeChat } from './features/chat/EmployeeChat';
import { AgentEditorPane } from './features/agentEditor/AgentEditorPane';
import { CreateAgentModal } from './features/employees/CreateAgentModal';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { useEmployeeStore } from './store/useEmployeeStore';
import { useProviderStore } from './store/useProviderStore';

// Read the panel type injected by the VS Code host
type PanelType = 'canvas' | 'chat' | undefined;
const panelType: PanelType = (window as any).__AGENT_STUDIO_PANEL_TYPE__ as PanelType;

/* ═══════════════════════════════════════════════════════════════════════════════
 * Independent panel components (rendered when panelType is set)
 * ═══════════════════════════════════════════════════════════════════════════════ */

function CanvasPanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
	const { loadEmployees } = useEmployeeStore();

	useEffect(() => {
		// Only load workspaces here; employees will be loaded once activeWorkspaceId is set
		// (avoids redundant employees.list call without workspaceId).
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				store.setActiveWorkspace(store.workspaces[0].id);
			}
		});
	}, []);

	useEffect(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	useEffect(() => {
		const onEmployeesChanged = () => {
			// Skip if no active workspace yet — initial load will be handled by the effect above
			if (activeWorkspaceId) {
				loadEmployees(activeWorkspaceId);
			}
		};
		const onWorkspaceChanged = () => { loadWorkspaces(); };
		const onActiveWorkspaceChanged = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.workspaceId && detail.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
				setActiveWorkspace(detail.workspaceId);
			}
		};
		window.addEventListener('agentStudio:employees-changed', onEmployeesChanged);
		window.addEventListener('agentStudio:workspace-changed', onWorkspaceChanged);
		window.addEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
		return () => {
			window.removeEventListener('agentStudio:employees-changed', onEmployeesChanged);
			window.removeEventListener('agentStudio:workspace-changed', onWorkspaceChanged);
			window.removeEventListener('agentStudio:workspace-active-changed', onActiveWorkspaceChanged);
		};
	}, [loadEmployees, loadWorkspaces, activeWorkspaceId, setActiveWorkspace]);

	return (
		<div className="panel-standalone">
			<div className="panel-standalone-content">
				<WorkspaceCanvas />
			</div>
		</div>
	);
}

function ChatPanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
	const { loadEmployees } = useEmployeeStore();
	const { loadProviders } = useProviderStore();

	// Editor pane state for standalone chat panel mode
	const [editorPaneOpen, setEditorPaneOpen] = useState(false);
	const [editorPaneEmployeeId, setEditorPaneEmployeeId] = useState<string | null>(null);

	const handleOpenEditorPane = useCallback((employeeId: string) => {
		setEditorPaneEmployeeId(employeeId);
		setEditorPaneOpen(true);
	}, []);

	const handleCloseEditorPane = useCallback(() => {
		setEditorPaneOpen(false);
		setEditorPaneEmployeeId(null);
	}, []);

	// Listen for direct close event from AgentEditorPane
	useEffect(() => {
		const handler = () => handleCloseEditorPane();
		window.addEventListener('agentStudio:close-editor-pane', handler);
		return () => window.removeEventListener('agentStudio:close-editor-pane', handler);
	}, [handleCloseEditorPane]);

	useEffect(() => {
		// Load workspaces and providers; employees will be loaded once activeWorkspaceId is set
		// (avoids redundant employees.list call without workspaceId).
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				store.setActiveWorkspace(store.workspaces[0].id);
			}
		});
		loadProviders();
	}, []);

	useEffect(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	useEffect(() => {
		const onEmployeesChanged = () => {
			if (activeWorkspaceId) {
				loadEmployees(activeWorkspaceId);
			}
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
	}, [loadEmployees, activeWorkspaceId, setActiveWorkspace]);

	return (
		<div className="panel-standalone">
			{editorPaneOpen && editorPaneEmployeeId ? (
				<AgentEditorPane
					employeeId={editorPaneEmployeeId}
					onClose={handleCloseEditorPane}
				/>
			) : (
				<EmployeeChat onOpenEditorPane={handleOpenEditorPane} />
			)}
		</div>
	);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * Full layout (legacy mode, rendered when panelType is undefined)
 * ═══════════════════════════════════════════════════════════════════════════════ */

function FullLayout(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId } = useWorkspaceStore();
	const { loadEmployees } = useEmployeeStore();
	const { loadProviders } = useProviderStore();

	// Editor pane state: when open, left panel shows AgentEditorPane instead of WorkspaceCanvas
	const [editorPaneOpen, setEditorPaneOpen] = useState(false);
	const [editorPaneEmployeeId, setEditorPaneEmployeeId] = useState<string | null>(null);

	const handleOpenEditorPane = useCallback((employeeId: string) => {
		setEditorPaneEmployeeId(employeeId);
		setEditorPaneOpen(true);
	}, []);

	const handleCloseEditorPane = useCallback(() => {
		setEditorPaneOpen(false);
		setEditorPaneEmployeeId(null);
	}, []);

	// Listen for direct close event from AgentEditorPane
	useEffect(() => {
		const handler = () => handleCloseEditorPane();
		window.addEventListener('agentStudio:close-editor-pane', handler);
		return () => window.removeEventListener('agentStudio:close-editor-pane', handler);
	}, [handleCloseEditorPane]);

	// Initialize on mount
	useEffect(() => {
		// Load workspaces and providers; employees will be loaded once activeWorkspaceId is set
		// (avoids redundant employees.list call without workspaceId).
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				store.setActiveWorkspace(store.workspaces[0].id);
			}
		});
		loadProviders();
	}, []);

	// Reload employees when workspace changes
	useEffect(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	// Listen for host events
	useEffect(() => {
		const onEmployeesChanged = () => {
			if (activeWorkspaceId) {
				loadEmployees(activeWorkspaceId);
			}
		};
		const onWorkspaceChanged = () => { loadWorkspaces(); };

		window.addEventListener('agentStudio:employees-changed', onEmployeesChanged);
		window.addEventListener('agentStudio:workspace-changed', onWorkspaceChanged);

		return () => {
			window.removeEventListener('agentStudio:employees-changed', onEmployeesChanged);
			window.removeEventListener('agentStudio:workspace-changed', onWorkspaceChanged);
		};
	}, [loadEmployees, loadWorkspaces, activeWorkspaceId]);


	const handleAddEmployee = useCallback(() => {
		setShowAddEmployeeModal(true);
	}, []);

	const [showAddEmployeeModal, setShowAddEmployeeModal] = useState(false);

	const handleRefresh = useCallback(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	return (
		<div className="app-root">
			{/* ① Title Bar */}
			<WorkspaceToolbar
				onAddEmployee={handleAddEmployee}
				onRefresh={handleRefresh}
			/>

			{/* Main content area: canvas + chat */}
			<div className="main-content">
				{/* ② Left: WorkspaceCanvas or AgentEditorPane */}
				<div className="workspace-panel">
					{editorPaneOpen && editorPaneEmployeeId ? (
						<AgentEditorPane
							employeeId={editorPaneEmployeeId}
							onClose={handleCloseEditorPane}
						/>
					) : (
						<WorkspaceCanvas />
					)}
				</div>

				{/* ③ Right: Employee Chat */}
				<div className="chat-panel">
					<EmployeeChat onOpenEditorPane={handleOpenEditorPane} />
				</div>
			</div>

			{/* Create Agent Modal */}
			<CreateAgentModal
				isOpen={showAddEmployeeModal}
				onClose={() => {
					setShowAddEmployeeModal(false);
					if (activeWorkspaceId) {
						loadEmployees(activeWorkspaceId);
					}
				}}
				workspaceId={activeWorkspaceId || undefined}
			/>
		</div>
	);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * App entry — routes to the correct panel based on panelType
 * ═══════════════════════════════════════════════════════════════════════════════ */

export function App(): React.ReactElement {
	switch (panelType) {
		case 'canvas':
			return <CanvasPanel />;
		case 'chat':
			return <ChatPanel />;
		default:
			return <FullLayout />;
	}
}
