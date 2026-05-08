/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Workspace Canvas (ReactFlow)
 *  Migrated from sarosis-webui WorkspaceCanvas.tsx
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo, useRef } from 'react';
import {
	ReactFlow,
	Controls,
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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { EmployeeNode } from './EmployeeNode';
import { ConnectionEdge } from './ConnectionEdge';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';
import { sendRequest } from '../../bridge/messageClient';

const nodeTypes: NodeTypes = {
	employee: EmployeeNode,
};

const edgeTypes: EdgeTypes = {
	connection: ConnectionEdge,
};

export function WorkspaceCanvas(): React.ReactElement {
	const { nodes: storeNodes, edges: storeEdges, activeWorkspaceId, updateNodes, updateEdges, saveLayout } = useWorkspaceStore();
	const { employees, selectEmployee } = useEmployeeStore();
	const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

	// Build ReactFlow nodes from employees + stored positions
	const initialNodes = useMemo<Node[]>(() => {
		return employees.map((emp) => {
			const storedNode = storeNodes.find(n => n.id === emp.id);
			return {
				id: emp.id,
				type: 'employee',
				position: storedNode?.position || emp.position || { x: Math.random() * 600, y: Math.random() * 400 },
				data: { employee: emp },
			};
		});
	}, [employees, storeNodes]);

	const initialEdges = useMemo<Edge[]>(() => {
		return storeEdges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: 'connection',
			animated: true,
			data: e.data,
		}));
	}, [storeEdges]);

	const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

	const onConnect = useCallback(async (params: Connection) => {
		if (!activeWorkspaceId || !params.source || !params.target) { return; }
		setEdges((eds) => addEdge({ ...params, type: 'connection', animated: true }, eds));

		// Persist connection
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
		// Update stored nodes with new position
		updateNodes(
			nodes.map(n => ({
				id: n.id,
				type: n.type || 'employee',
				position: n.id === node.id ? node.position : n.position,
				data: n.data as Record<string, unknown>,
			}))
		);
		// Debounced save
		saveLayout();
	}, [nodes, updateNodes, saveLayout]);

	const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
		selectEmployee(node.id);
	}, [selectEmployee]);

	const onInit = useCallback((instance: ReactFlowInstance) => {
		reactFlowInstance.current = instance;
	}, []);

	// Handle drag-and-drop from employee list
	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
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
			data: { employee },
		};

		setNodes((nds) => [...nds.filter(n => n.id !== employee.id), newNode]);

		// Update position in store
		if (activeWorkspaceId) {
			await sendRequest('employees.update', {
				id: employee.id,
				data: { position, workspaceId: activeWorkspaceId },
			});
		}
	}, [activeWorkspaceId, setNodes]);

	return (
		<div className="canvas-wrapper" style={{ width: '100%', height: '100%' }}>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				onNodeDragStop={onNodeDragStop}
				onNodeClick={onNodeClick}
				onInit={onInit}
				onDragOver={onDragOver}
				onDrop={onDrop}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				fitView
				proOptions={{ hideAttribution: true }}
				defaultEdgeOptions={{ animated: true }}
			>
				<Controls />
				<Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--vscode-editorIndentGuide-background)" />
			</ReactFlow>
		</div>
	);
}
