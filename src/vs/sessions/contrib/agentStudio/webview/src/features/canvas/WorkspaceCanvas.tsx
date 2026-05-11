/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Workspace Canvas (ReactFlow)
 *  Matching sarosis-webui WorkspaceCanvas layout and functionality:
 *  - Canvas mode: ReactFlow with MiniMap, Controls, Background
 *  - List mode: EmployeeListView with PM/Employee zones + drag reorder
 *  - Mode toggle bar with employee count
 *  - Connection management (create/delete)
 *  - Node drag + position persistence
 *  - External drag-and-drop from sidebar
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
	ReactFlow,
	Controls,
	MiniMap,
	Background,
	BackgroundVariant,
	useNodesState,
	useEdgesState,
	addEdge,
	Connection,
	NodeTypes,
	EdgeTypes,
	ReactFlowInstance,
	Node,
	Edge,
	EdgeChange,
	Edge as XYEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { EmployeeNode } from './EmployeeNode';
import { ConnectionEdge } from './ConnectionEdge';
import { EmployeeListView } from './EmployeeListView';
import { CreateAgentModal } from '../employees/CreateAgentModal';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';
import { sendRequest } from '../../bridge/messageClient';

type ViewMode = 'canvas' | 'list';

const nodeTypes: NodeTypes = {
	employee: EmployeeNode,
};

const edgeTypes: EdgeTypes = {
	connection: ConnectionEdge,
};

export function WorkspaceCanvas(): React.ReactElement {
	const { nodes: storeNodes, edges: storeEdges, activeWorkspaceId, updateNodes, saveLayout } = useWorkspaceStore();
	const { employees, selectEmployee, deleteEmployee, loadEmployees } = useEmployeeStore();
	const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

	// Create agent modal state
	const [showCreateModal, setShowCreateModal] = useState(false);

	// Display mode with localStorage persistence
	const [displayMode, setDisplayMode] = useState<ViewMode>(() => {
		try {
			const saved = localStorage.getItem('hermes-display-mode');
			return (saved === 'list' || saved === 'canvas') ? saved : 'canvas';
		} catch {
			return 'canvas';
		}
	});

	// Sync displayMode to localStorage
	const handleViewModeChange = useCallback((mode: ViewMode) => {
		setDisplayMode(mode);
		try { localStorage.setItem('hermes-display-mode', mode); } catch {}
	}, []);

	const reactFlowWrapper = useRef<HTMLDivElement>(null);

	// Build ReactFlow nodes from employees + stored positions
	const initialNodes = useMemo<Node[]>(() => {
		return employees.map((emp, index) => {
			const storedNode = storeNodes.find(n => n.id === emp.id);
			return {
				id: emp.id,
				type: 'employee',
				position: storedNode?.position || emp.position || {
					x: 100 + (index % 4) * 280,
					y: 100 + Math.floor(index / 4) * 200,
				},
				draggable: true,
				selectable: true,
				data: {
					employee: emp,
					isSelected: false,
					onSelect: (empId: string) => selectEmployee(empId),
					onDelete: (empId: string) => handleDeleteEmployee(empId),
				},
			};
		});
	}, [employees, storeNodes, selectEmployee]);

	const initialEdges = useMemo<Edge[]>(() => {
		return storeEdges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: 'connection',
			animated: true,
			style: { stroke: 'var(--vscode-textLink-foreground, #3b82f6)', strokeWidth: 2 },
			data: e.data,
		}));
	}, [storeEdges]);

	const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

	// Sync nodes when employees change (preserve current positions from drag)
	useEffect(() => {
		setNodes(prevNodes => {
			const builtNodes = employees.map((emp, index) => {
				const storedNode = storeNodes.find(n => n.id === emp.id);
				const existingNode = prevNodes.find(n => n.id === emp.id);
				return {
					id: emp.id,
					type: 'employee' as const,
					position: existingNode?.position || storedNode?.position || emp.position || {
						x: 100 + (index % 4) * 280,
						y: 100 + Math.floor(index / 4) * 200,
					},
					draggable: true,
					selectable: true,
					data: {
						employee: emp,
						isSelected: false,
						onSelect: (empId: string) => selectEmployee(empId),
						onDelete: (empId: string) => handleDeleteEmployee(empId),
					},
				};
			});
			return builtNodes;
		});
	}, [employees, storeNodes, selectEmployee, setNodes]);

	// Connection handlers
	const onConnect = useCallback(async (params: Connection) => {
		if (!activeWorkspaceId || !params.source || !params.target) { return; }
		setEdges((eds) => addEdge({
			...params,
			type: 'connection',
			animated: true,
			style: { stroke: 'var(--vscode-textLink-foreground, #3b82f6)', strokeWidth: 2 },
		}, eds));

		try {
			await sendRequest('workspace.connections.add', {
				workspaceId: activeWorkspaceId,
				sourceId: params.source,
				targetId: params.target,
				type: 'subagent',
			});
		} catch (err) {
			console.error('Failed to add connection:', err);
		}
	}, [activeWorkspaceId, setEdges]);

	const onNodeDragStop = useCallback((_event: React.MouseEvent, node: Node) => {
		updateNodes(
			nodes.map(n => ({
				id: n.id,
				type: n.type || 'employee',
				position: n.id === node.id ? node.position : n.position,
				data: n.data as Record<string, unknown>,
			}))
		);
		saveLayout();
	}, [nodes, updateNodes, saveLayout]);

	const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
		selectEmployee(node.id);
	}, [selectEmployee]);

	const onInit = useCallback((instance: ReactFlowInstance) => {
		reactFlowInstance.current = instance;
	}, []);

	// Handle edge deletion
	const handleEdgeDelete = useCallback(async (edgesToDelete: XYEdge[]) => {
		for (const edge of edgesToDelete) {
			try {
				if (activeWorkspaceId) {
					await sendRequest('workspace.connections.remove', {
						workspaceId: activeWorkspaceId,
						connectionId: edge.id,
					});
				}
			} catch (err) {
				console.error('Failed to delete connection:', err);
			}
		}
	}, [activeWorkspaceId]);

	// Handle edge changes (including removal)
	const handleEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
		changes.forEach((change) => {
			if (change.type === 'remove') {
				handleEdgeDelete([{ id: change.id } as XYEdge]);
			}
		});
		onEdgesChange(changes);
	}, [onEdgesChange, handleEdgeDelete]);

	// Handle drag-and-drop from sidebar
	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	}, []);

	const onDrop = useCallback(async (event: React.DragEvent) => {
		event.preventDefault();

		const employeeData = event.dataTransfer.getData('application/agent-studio-employee');
		if (!employeeData || !reactFlowInstance.current) { return; }

		const employee: Employee = JSON.parse(employeeData);
		const position = reactFlowInstance.current.screenToFlowPosition({
			x: event.clientX,
			y: event.clientY,
		});

		const newNode: Node = {
			id: employee.id,
			type: 'employee',
			position,
			data: {
				employee,
				isSelected: false,
				onSelect: (empId: string) => selectEmployee(empId),
				onDelete: (empId: string) => handleDeleteEmployee(empId),
			},
		};

		setNodes((nds) => [...nds.filter(n => n.id !== employee.id), newNode]);

		if (activeWorkspaceId) {
			await sendRequest('employees.update', {
				id: employee.id,
				data: { position, workspaceId: activeWorkspaceId },
			});
		}
	}, [activeWorkspaceId, setNodes, selectEmployee]);

	// List mode drop (no canvas coordinates needed)
	const onListDrop = useCallback(async (event: React.DragEvent) => {
		event.preventDefault();
		const employeeData = event.dataTransfer.getData('application/agent-studio-employee');
		if (!employeeData) { return; }
		// In list mode, no position update needed
	}, []);

	// Delete employee handler
	const handleDeleteEmployee = useCallback(async (empId: string) => {
		try {
			await deleteEmployee(empId);
		} catch (err) {
			console.error('Failed to delete employee:', err);
		}
	}, [deleteEmployee]);

	// Refresh handler
	const handleRefresh = useCallback(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	// Handler after agent is created
	const handleAgentCreated = useCallback(() => {
		if (activeWorkspaceId) {
			loadEmployees(activeWorkspaceId);
		}
	}, [activeWorkspaceId, loadEmployees]);

	return (
		<div className="canvas-container">
			{/* Floating action bar (top-right corner of canvas) */}
			<div className="canvas-view-toggle">
				<button
					className="canvas-add-agent-btn"
					onClick={() => setShowCreateModal(true)}
					title="创建 Agent"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
					</svg>
				</button>
				<div className="canvas-toggle-divider" />
				<button
					className={`canvas-view-toggle-btn ${displayMode === 'canvas' ? 'active' : ''}`}
					onClick={() => handleViewModeChange('canvas')}
					title="画布视图"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
					</svg>
				</button>
				<button
					className={`canvas-view-toggle-btn ${displayMode === 'list' ? 'active' : ''}`}
					onClick={() => handleViewModeChange('list')}
					title="列表视图"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
					</svg>
				</button>
			</div>

			{/* Canvas mode */}
			{displayMode === 'canvas' && (
				<div className="canvas-flow-area" ref={reactFlowWrapper}>
					<ReactFlow
						nodes={nodes}
						edges={edges}
						onNodesChange={onNodesChange}
						onEdgesChange={handleEdgesChange}
						onConnect={onConnect}
						onNodeDragStop={onNodeDragStop}
						onNodeClick={onNodeClick}
						onInit={onInit}
						onDragOver={onDragOver}
						onDrop={onDrop}
						nodeTypes={nodeTypes}
						edgeTypes={edgeTypes}
						nodesDraggable={true}
						nodesConnectable={true}
						elementsSelectable={true}
						fitView
						fitViewOptions={{ padding: 0.2 }}
						proOptions={{ hideAttribution: true }}
						defaultEdgeOptions={{
							type: 'connection',
							animated: true,
							style: { stroke: 'var(--vscode-textLink-foreground, #3b82f6)', strokeWidth: 2 },
						}}
						className="workspace-canvas"
					>
						<Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--vscode-editorIndentGuide-background, #374151)" />
						<Controls
							className="canvas-controls"
							showInteractive={false}
						/>
						<MiniMap
							className="canvas-minimap"
							nodeColor={() => 'var(--vscode-textLink-foreground, #3b82f6)'}
							maskColor="var(--vscode-editor-background, rgba(17, 24, 39, 0.8))"
						/>
					</ReactFlow>

					{/* Empty state */}
					{employees.length === 0 && (
						<div className="canvas-empty">
							<div className="canvas-empty-icon">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
								</svg>
							</div>
							<p className="canvas-empty-text">还没有 Agent</p>
							<p className="canvas-empty-hint">创建 Agent 来组织你的团队</p>
							<button
								className="canvas-empty-add-btn"
								onClick={() => setShowCreateModal(true)}
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
								</svg>
								创建 Agent
							</button>
						</div>
					)}
				</div>
			)}

			{/* List mode */}
			{displayMode === 'list' && (
				<div
					className="canvas-list-area"
					onDragOver={onDragOver}
					onDrop={onListDrop}
				>
					<EmployeeListView
						employees={employees}
						selectedEmployeeId={useEmployeeStore.getState().selectedEmployeeId}
						onSelectEmployee={selectEmployee}
						onDeleteEmployee={handleDeleteEmployee}
						onRefresh={handleRefresh}
						workspaceId={activeWorkspaceId || undefined}
					/>
				</div>
			)}

			{/* Create Agent Modal */}
			<CreateAgentModal
				isOpen={showCreateModal}
				onClose={() => {
					setShowCreateModal(false);
					handleAgentCreated();
				}}
				workspaceId={activeWorkspaceId || undefined}
			/>
		</div>
	);
}
