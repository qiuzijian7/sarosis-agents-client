/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Root App Component
 *  Supports two modes:
 *    A) Independent panel mode — renders a single panel based on window.__AGENT_STUDIO_PANEL_TYPE__
 *       ('canvas' | 'chat' | 'taskboard')
 *    B) Legacy full layout — four-zone layout when panelType is undefined
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState, useCallback } from 'react';
import { WorkspaceToolbar, type ViewMode } from './features/title/WorkspaceToolbar';
import { WorkspaceCanvas } from './features/canvas/WorkspaceCanvas';
import { EmployeeListView } from './features/canvas/EmployeeListView';
import { TaskBoardPanel } from './features/taskboard/TaskBoardPanel';
import { EmployeeChat } from './features/chat/EmployeeChat';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { useEmployeeStore } from './store/useEmployeeStore';
import { useDelegationStore } from './store/useDelegationStore';
import { useTaskBoardStore } from './store/useTaskBoardStore';

// Read the panel type injected by the VS Code host
type PanelType = 'canvas' | 'chat' | 'taskboard' | undefined;
const panelType: PanelType = (window as any).__AGENT_STUDIO_PANEL_TYPE__ as PanelType;

/* ═══════════════════════════════════════════════════════════════════════════════
 * Independent panel components (rendered when panelType is set)
 * ═══════════════════════════════════════════════════════════════════════════════ */

function CanvasPanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId } = useWorkspaceStore();
	const { loadEmployees, employees, selectEmployee, selectedEmployeeId } = useEmployeeStore();

	const [viewMode, setViewMode] = useState<ViewMode>('canvas');

	useEffect(() => {
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				store.setActiveWorkspace(store.workspaces[0].id);
			}
		});
		loadEmployees();
	}, []);

	useEffect(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	useEffect(() => {
		const onEmployeesChanged = () => { loadEmployees(activeWorkspaceId || undefined); };
		const onWorkspaceChanged = () => { loadWorkspaces(); };
		window.addEventListener('agentStudio:employees-changed', onEmployeesChanged);
		window.addEventListener('agentStudio:workspace-changed', onWorkspaceChanged);
		return () => {
			window.removeEventListener('agentStudio:employees-changed', onEmployeesChanged);
			window.removeEventListener('agentStudio:workspace-changed', onWorkspaceChanged);
		};
	}, [loadEmployees, loadWorkspaces, activeWorkspaceId]);

	const handleSelectEmployee = useCallback((id: string) => {
		selectEmployee(id);
	}, [selectEmployee]);

	const handleAddEmployee = useCallback(() => {
		console.log('[AgentStudio] Add employee');
	}, []);

	const handleRefresh = useCallback(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	const workspaceEmployees = employees.filter(e => e.workspaceId === activeWorkspaceId);

	return (
		<div className="panel-standalone">
			<WorkspaceToolbar
				viewMode={viewMode}
				onViewModeChange={setViewMode}
				onAddEmployee={handleAddEmployee}
				onRefresh={handleRefresh}
			/>
			<div className="panel-standalone-content">
				{viewMode === 'canvas' ? (
					<WorkspaceCanvas />
				) : (
					<EmployeeListView
						employees={workspaceEmployees}
						selectedEmployeeId={selectedEmployeeId}
						onSelectEmployee={handleSelectEmployee}
					/>
				)}
			</div>
		</div>
	);
}

function ChatPanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId } = useWorkspaceStore();
	const { loadEmployees } = useEmployeeStore();

	useEffect(() => {
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				store.setActiveWorkspace(store.workspaces[0].id);
			}
		});
		loadEmployees();
	}, []);

	useEffect(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	useEffect(() => {
		const onEmployeesChanged = () => { loadEmployees(activeWorkspaceId || undefined); };
		window.addEventListener('agentStudio:employees-changed', onEmployeesChanged);
		return () => {
			window.removeEventListener('agentStudio:employees-changed', onEmployeesChanged);
		};
	}, [loadEmployees, activeWorkspaceId]);

	return (
		<div className="panel-standalone">
			<EmployeeChat />
		</div>
	);
}

function TaskBoardStandalonePanel(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId } = useWorkspaceStore();
	const { loadDelegations } = useDelegationStore();
	const { loadTasks } = useTaskBoardStore();

	useEffect(() => {
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				store.setActiveWorkspace(store.workspaces[0].id);
			}
		});
	}, []);

	useEffect(() => {
		if (activeWorkspaceId) {
			loadDelegations(activeWorkspaceId);
			loadTasks(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadDelegations, loadTasks]);

	useEffect(() => {
		const onDelegationsChanged = () => {
			if (activeWorkspaceId) {
				loadDelegations(activeWorkspaceId);
				loadTasks(activeWorkspaceId);
			}
		};
		window.addEventListener('agentStudio:delegations-changed', onDelegationsChanged);
		window.addEventListener('agentStudio:taskboard-changed', onDelegationsChanged);
		return () => {
			window.removeEventListener('agentStudio:delegations-changed', onDelegationsChanged);
			window.removeEventListener('agentStudio:taskboard-changed', onDelegationsChanged);
		};
	}, [loadDelegations, loadTasks, activeWorkspaceId]);

	return (
		<div className="panel-standalone">
			<TaskBoardPanel />
		</div>
	);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * Full layout (legacy mode, rendered when panelType is undefined)
 * ═══════════════════════════════════════════════════════════════════════════════ */

function FullLayout(): React.ReactElement {
	const { loadWorkspaces, activeWorkspaceId } = useWorkspaceStore();
	const { loadEmployees, employees, selectEmployee, selectedEmployeeId } = useEmployeeStore();
	const { loadDelegations } = useDelegationStore();
	const { loadTasks } = useTaskBoardStore();

	const [viewMode, setViewMode] = useState<ViewMode>('canvas');

	// Initialize on mount
	useEffect(() => {
		loadWorkspaces().then(() => {
			const store = useWorkspaceStore.getState();
			if (store.workspaces.length > 0 && !store.activeWorkspaceId) {
				store.setActiveWorkspace(store.workspaces[0].id);
			}
		});
		loadEmployees();
	}, []);

	// Reload employees and tasks when workspace changes
	useEffect(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
			loadDelegations(activeWorkspaceId);
			loadTasks(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees, loadDelegations, loadTasks]);

	// Listen for host events
	useEffect(() => {
		const onEmployeesChanged = () => { loadEmployees(activeWorkspaceId || undefined); };
		const onWorkspaceChanged = () => { loadWorkspaces(); };
		const onDelegationsChanged = () => {
			if (activeWorkspaceId) {
				loadDelegations(activeWorkspaceId);
				loadTasks(activeWorkspaceId);
			}
		};

		window.addEventListener('agentStudio:employees-changed', onEmployeesChanged);
		window.addEventListener('agentStudio:workspace-changed', onWorkspaceChanged);
		window.addEventListener('agentStudio:delegations-changed', onDelegationsChanged);
		window.addEventListener('agentStudio:taskboard-changed', onDelegationsChanged);

		return () => {
			window.removeEventListener('agentStudio:employees-changed', onEmployeesChanged);
			window.removeEventListener('agentStudio:workspace-changed', onWorkspaceChanged);
			window.removeEventListener('agentStudio:delegations-changed', onDelegationsChanged);
			window.removeEventListener('agentStudio:taskboard-changed', onDelegationsChanged);
		};
	}, [loadEmployees, loadWorkspaces, loadDelegations, loadTasks, activeWorkspaceId]);

	const handleSelectEmployee = useCallback((id: string) => {
		selectEmployee(id);
	}, [selectEmployee]);

	const handleAddEmployee = useCallback(() => {
		console.log('[AgentStudio] Add employee');
	}, []);

	const handleRefresh = useCallback(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
			loadDelegations(activeWorkspaceId);
			loadTasks(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees, loadDelegations, loadTasks]);

	// Filter employees for current workspace
	const workspaceEmployees = employees.filter(e => e.workspaceId === activeWorkspaceId);

	return (
		<div className="app-root">
			{/* ① Title Bar */}
			<WorkspaceToolbar
				viewMode={viewMode}
				onViewModeChange={setViewMode}
				onAddEmployee={handleAddEmployee}
				onRefresh={handleRefresh}
			/>

			{/* Main content area: canvas/list + chat */}
			<div className="main-content">
				{/* ② Left: Workspace Canvas or Employee List */}
				<div className="workspace-panel">
					{viewMode === 'canvas' ? (
						<WorkspaceCanvas />
					) : (
						<EmployeeListView
							employees={workspaceEmployees}
							selectedEmployeeId={selectedEmployeeId}
							onSelectEmployee={handleSelectEmployee}
						/>
					)}
				</div>

				{/* ④ Right: Employee Chat */}
				<div className="chat-panel">
					<EmployeeChat />
				</div>
			</div>

			{/* ③ Bottom: Task Board */}
			<TaskBoardPanel />
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
		case 'taskboard':
			return <TaskBoardStandalonePanel />;
		default:
			return <FullLayout />;
	}
}
