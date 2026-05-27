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
import { SessionSwitcher } from './SessionSwitcher';
import { ForkReadOnlyBanner } from './ForkReadOnlyBanner';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';
import { useWorkspaceSessionStore } from '../../store/useWorkspaceSessionStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { sendRequest } from '../../bridge/messageClient';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { getAgentColor } from '../../utils/agentColors';

type ViewMode = 'canvas' | 'list';

const nodeTypes: NodeTypes = {
	employee: EmployeeNode,
};

const edgeTypes: EdgeTypes = {
	connection: ConnectionEdge,
};

export function WorkspaceCanvas(): React.ReactElement {
	const { nodes: storeNodes, edges: storeEdges, activeWorkspaceId, updateNodes, updateEdges, saveLayout, isReadOnly } = useWorkspaceStore();
	const { employees, selectEmployee, deleteEmployee, loadEmployees } = useEmployeeStore();
	const { mode } = useWorkspaceSessionStore();
	const { openPlanDialog } = useOrchestrationStore();
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
	// ─── Node overlap constants ────────────────────────────────────────
	// NODE_WIDTH / NODE_HEIGHT define the bounding box used for overlap detection.
	// They must match (or slightly exceed) the CSS-rendered card size.
	const NODE_WIDTH = 280;
	const NODE_HEIGHT = 180;

	// Helper: check if two rectangles overlap
	const rectsOverlap = useCallback(
		(a: { x: number; y: number }, b: { x: number; y: number }) =>
			Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT,
		[]
	);

	// Helper: find a position on the grid that doesn't overlap existing positions
	const findNonOverlappingPosition = useCallback(
		(occupied: Array<{ x: number; y: number }>) => {
			const ORIGIN_X = 100;
			const ORIGIN_Y = 100;
			const COL_WIDTH = NODE_WIDTH + 20;   // card width + gap
			const ROW_HEIGHT = NODE_HEIGHT + 20;  // card height + gap
			const MAX_COLS = 4;

			for (let cell = 0; cell < 100; cell++) {
				const cx = ORIGIN_X + (cell % MAX_COLS) * COL_WIDTH;
				const cy = ORIGIN_Y + Math.floor(cell / MAX_COLS) * ROW_HEIGHT;
				const overlaps = occupied.some(p => rectsOverlap({ x: cx, y: cy }, p));
				if (!overlaps) { return { x: cx, y: cy }; }
			}
			const maxY = occupied.reduce((m, p) => Math.max(m, p.y), 0);
			return { x: ORIGIN_X, y: maxY + ROW_HEIGHT + 20 };
		},
		[rectsOverlap]
	);

	/**
	 * Check whether `candidate` overlaps any node other than `nodeId`.
	 */
	const isPositionOverlapping = useCallback(
		(candidate: { x: number; y: number }, nodeId: string, allNodes: Node[]): boolean => {
			return allNodes.some(n => n.id !== nodeId && rectsOverlap(candidate, n.position));
		},
		[rectsOverlap]
	);

	/**
	 * Resolve a candidate position so it does not overlap any other node.
	 * Spiral search; used for sidebar drop (new node creation), where there
	 * is no "previous valid position" to fall back to.
	 */
	const resolveNonOverlappingPosition = useCallback(
		(candidate: { x: number; y: number }, nodeId: string, allNodes: Node[]): { x: number; y: number } => {
			const others = allNodes.filter(n => n.id !== nodeId).map(n => n.position);
			if (!others.some(p => rectsOverlap(candidate, p))) {
				return candidate;
			}
			const STEP_X = NODE_WIDTH + 20;
			const STEP_Y = NODE_HEIGHT + 20;
			for (let ring = 1; ring <= 20; ring++) {
				const offsets: Array<{ x: number; y: number }> = [];
				for (let i = -ring; i <= ring; i++) {
					offsets.push({ x: i * STEP_X, y: -ring * STEP_Y });
					offsets.push({ x: i * STEP_X, y: ring * STEP_Y });
					if (i !== -ring && i !== ring) {
						offsets.push({ x: -ring * STEP_X, y: i * STEP_Y });
						offsets.push({ x: ring * STEP_X, y: i * STEP_Y });
					}
				}
				for (const off of offsets) {
					const pos = { x: candidate.x + off.x, y: candidate.y + off.y };
					if (!others.some(p => rectsOverlap(pos, p))) {
						return pos;
					}
				}
			}
			const maxY = others.reduce((m, p) => Math.max(m, p.y), 0);
			return { x: candidate.x, y: maxY + NODE_HEIGHT + 20 };
		},
		[rectsOverlap]
	);

	// ─── Drag state: last valid (non-overlapping) position during a drag ──
	// Tracks the most recent position visited during a drag where the node
	// did NOT overlap any other node. On drag stop, if the release point
	// overlaps, we revert to this remembered position instead of jumping
	// elsewhere (e.g. the original start) or running a spiral search.
	const lastValidDragPosRef = useRef<{ nodeId: string; position: { x: number; y: number } } | null>(null);

	const initialNodes = useMemo<Node[]>(() => {
		const assignedPositions: Array<{ x: number; y: number }> = [];
		const selectedEmployeeId = useEmployeeStore.getState().selectedEmployeeId;
		const activeWorkspace = useWorkspaceStore.getState().workspaces.find(w => w.id === activeWorkspaceId);
		return employees.map((emp) => {
			const storedNode = storeNodes.find(n => n.id === emp.id);
			const pos = storedNode?.position || emp.position || findNonOverlappingPosition(assignedPositions);
			assignedPositions.push(pos);
			// Worktree info: employee-level overrides workspace-level
			const worktreePath = (emp as any).worktreePath || activeWorkspace?.worktreePath;
			const worktreeBranch = (emp as any).worktreeBranch || activeWorkspace?.worktreeBranch;
			const worktreeStatus = worktreePath ? (activeWorkspace?.worktreeStatus ?? 'none') : 'none';
			return {
				id: emp.id,
				type: 'employee',
				position: pos,
				draggable: true,
				selectable: true,
				data: {
					employee: emp,
					isSelected: emp.id === selectedEmployeeId,
					onSelect: (empId: string) => selectEmployee(empId),
					onDelete: (empId: string) => handleDeleteEmployee(empId),
					worktreePath,
					worktreeBranch,
					worktreeStatus,
				},
			};
		});
	}, [employees, storeNodes, selectEmployee, findNonOverlappingPosition]);

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

	// Keep a ref to the latest `nodes` so that drag callbacks (which may be
	// cached by ReactFlow during an active drag gesture) can always read the
	// most up-to-date node positions for overlap detection.
	const nodesRef = useRef(nodes);
	nodesRef.current = nodes;

	// Sync nodes when employees change (add/remove agents).
	//
	// IMPORTANT: We deliberately depend ONLY on `employees` (not `storeNodes`)
	// to avoid a race condition during drag-and-drop:
	//   1. User drags node A onto node B (overlap).
	//   2. `onNodeDragStop` calls `setNodes` with the resolved (non-overlap)
	//      position AND `updateNodes` to write into zustand store.
	//   3. The zustand `storeNodes` reference change would otherwise re-trigger
	//      this effect, which then rebuilds nodes from `prevNodes` (whose A
	//      may still hold the overlap position depending on commit timing),
	//      visually snapping the card back.
	// By dropping `storeNodes` from deps, drag-stop becomes the single source
	// of truth for visual position updates; `storeNodes` is only used for
	// INITIAL placement of brand-new employees (read inline below).
	useEffect(() => {
		console.log('[WorkspaceCanvas] employees changed, count:', employees.length, 'employees:', employees.map(e => e.name));
		const selectedEmployeeId = useEmployeeStore.getState().selectedEmployeeId;
		setNodes(prevNodes => {
			console.log('[WorkspaceCanvas] rebuilding nodes, prevNodes:', prevNodes.length, 'employees:', employees.length);
			const assignedPositions: Array<{ x: number; y: number }> = [];
			// Collect positions of all existing (already-rendered) nodes first
			for (const n of prevNodes) { assignedPositions.push(n.position); }

			// Read the current store snapshot lazily — we only need it to
			// initialize positions of newly-added employees, not to override
			// existing ones that the user may have just dragged.
			const currentStoreNodes = useWorkspaceStore.getState().nodes;
			const activeWorkspace = useWorkspaceStore.getState().workspaces.find(w => w.id === activeWorkspaceId);

			const builtNodes = employees.map((emp) => {
				const existingNode = prevNodes.find(n => n.id === emp.id);
				const storedNode = currentStoreNodes.find(n => n.id === emp.id);

				let pos: { x: number; y: number };
				if (existingNode) {
					// Already on canvas – keep current position (user may have dragged it)
					pos = existingNode.position;
				} else if (storedNode?.position) {
					pos = storedNode.position;
				} else if (emp.position) {
					pos = emp.position;
				} else {
					// Brand new node – find a spot that doesn't overlap
					pos = findNonOverlappingPosition(assignedPositions);
				}
				assignedPositions.push(pos);

				// Worktree info: employee-level overrides workspace-level
				const worktreePath = (emp as any).worktreePath || activeWorkspace?.worktreePath;
				const worktreeBranch = (emp as any).worktreeBranch || activeWorkspace?.worktreeBranch;
				const worktreeStatus = worktreePath ? (activeWorkspace?.worktreeStatus ?? 'none') : 'none';

				return {
					id: emp.id,
					type: 'employee' as const,
					position: pos,
					draggable: true,
					selectable: true,
					data: {
						employee: emp,
						isSelected: emp.id === selectedEmployeeId,
						onSelect: (empId: string) => selectEmployee(empId),
						onDelete: (empId: string) => handleDeleteEmployee(empId),
						worktreePath,
						worktreeBranch,
						worktreeStatus,
					},
				};
			});
			console.log('[WorkspaceCanvas] builtNodes:', builtNodes.length);
			return builtNodes;
		});
	}, [employees, selectEmployee, setNodes, findNonOverlappingPosition]);

	// Sync edges when storeEdges change (initial load, workspace switch, etc.)
	useEffect(() => {
		console.log('[WorkspaceCanvas] storeEdges changed, count:', storeEdges.length);
		setEdges(storeEdges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: 'connection',
			animated: true,
			style: { stroke: 'var(--vscode-textLink-foreground, #3b82f6)', strokeWidth: 2 },
			data: e.data,
		})));
	}, [storeEdges, setEdges]);

	// Connection handlers
	const onConnect = useCallback(async (params: Connection) => {
		if (!activeWorkspaceId || !params.source || !params.target || isReadOnly) { return; }

		// 1. Update local ReactFlow state (optimistic UI)
		let updatedEdges: Edge[] = [];
		setEdges((eds) => {
			updatedEdges = addEdge({
				...params,
				type: 'connection',
				animated: true,
				style: { stroke: 'var(--vscode-textLink-foreground, #3b82f6)', strokeWidth: 2 },
			}, eds);
			return updatedEdges;
		});

		// 2. Persist connection via dedicated connections API
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

		// 3. Sync edges to store and persist layout so edges survive reload
		updateEdges(updatedEdges.map(e => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: e.type,
			data: e.data,
		})));
		try {
			await saveLayout();
		} catch (err) {
			console.error('[WorkspaceCanvas] Failed to save layout after connect:', err);
		}
	}, [activeWorkspaceId, setEdges, updateEdges, saveLayout, isReadOnly]);

	// ─── Drag lifecycle handlers ──────────────────────────────────────
	// During a drag we continuously remember the last position where the
	// node was NOT overlapping any other node. If the user releases on top
	// of another node, we snap back to that remembered position instead of
	// jumping back to where the drag started.
	const onNodeDragStart = useCallback((_event: React.MouseEvent, node: Node) => {
		// Initialize "last valid" with the node's starting position — that
		// position is, by definition, non-overlapping (the canvas guarantees
		// no two nodes overlap at rest).
		lastValidDragPosRef.current = {
			nodeId: node.id,
			position: { x: node.position.x, y: node.position.y },
		};
	}, []);

	const onNodeDrag = useCallback((_event: React.MouseEvent, node: Node) => {
		// Update "last valid" only when the current dragged position does
		// NOT overlap any other node. Use nodesRef to always read the latest
		// node positions, even if ReactFlow caches this callback during drag.
		if (!isPositionOverlapping(node.position, node.id, nodesRef.current)) {
			lastValidDragPosRef.current = {
				nodeId: node.id,
				position: { x: node.position.x, y: node.position.y },
			};
		}
	}, [isPositionOverlapping]);

	const onNodeDragStop = useCallback(async (_event: React.MouseEvent, node: Node) => {
		if (isReadOnly) {
			lastValidDragPosRef.current = null;
			return; // Don't persist layout changes in fork mode
		}

		// Resolve the final position. Strategy when the release point
		// (C in user's terms) overlaps another node:
		//
		//   1. PRIMARY: walk back from C toward the drag-start A along
		//      the straight line C→A and pick the first sample that is
		//      free. This always lands "on the path the user dragged",
		//      which is what the user perceives as "position B".
		//   2. FALLBACK: if for some reason C→A path is fully blocked
		//      (shouldn't happen since A itself is free), use the last
		//      non-overlapping position recorded during onNodeDrag.
		//   3. LAST RESORT: stay at A (the drag-start).
		const currentNodes = nodesRef.current;
		const releaseOverlaps = isPositionOverlapping(node.position, node.id, currentNodes);

		let resolvedPos = node.position;
		if (releaseOverlaps) {
			const start = lastValidDragPosRef.current?.nodeId === node.id
				? lastValidDragPosRef.current.position
				: null;

			// Step (1): retrace C → A and pick first free position.
			if (start) {
				const dx = start.x - node.position.x;
				const dy = start.y - node.position.y;
				const dist = Math.hypot(dx, dy);
				if (dist > 0) {
					// Sample every ~10px along the line, max 200 samples.
					const STEP = 10;
					const steps = Math.min(200, Math.max(1, Math.ceil(dist / STEP)));
					for (let i = 1; i <= steps; i++) {
						const t = i / steps;
						const candidate = {
							x: node.position.x + dx * t,
							y: node.position.y + dy * t,
						};
						if (!isPositionOverlapping(candidate, node.id, currentNodes)) {
							resolvedPos = candidate;
							break;
						}
					}
				}
			}

			// Step (2): if still overlapping, use sampled fallback (B from drag).
			if (resolvedPos === node.position) {
				const fallback = lastValidDragPosRef.current;
				if (fallback && fallback.nodeId === node.id) {
					resolvedPos = fallback.position;
				}
			}
		}

		const positionChanged = resolvedPos.x !== node.position.x || resolvedPos.y !== node.position.y;

		// Clear drag state
		lastValidDragPosRef.current = null;

		// If position was adjusted, update the ReactFlow node visually
		if (positionChanged) {
			setNodes(nds => nds.map(n => n.id === node.id ? { ...n, position: resolvedPos } : n));
		}

		console.log('[WorkspaceCanvas] onNodeDragStop:', {
			id: node.id,
			rawPos: node.position,
			resolvedPos,
			revertedDueToOverlap: releaseOverlaps,
			workspaceId: activeWorkspaceId,
		});

		// Update zustand store (serializable only — no callbacks)
		updateNodes(
			currentNodes.map(n => ({
				id: n.id,
				type: n.type || 'employee',
				position: n.id === node.id ? resolvedPos : n.position,
				data: {},
			}))
		);

		// 1) Persist directly to employees.json via the proven `employees.update`
		//    pathway. This is the SOURCE OF TRUTH for individual agent positions
		//    and is what survives a window reload (since canvas reconstructs
		//    positions from `emp.position` when no layout exists).
		try {
			await sendRequest('employees.update', {
				id: node.id,
				data: { position: resolvedPos },
			});
			console.log('[WorkspaceCanvas] employees.update OK for', node.id);
		} catch (err) {
			console.error('[WorkspaceCanvas] employees.update FAILED:', err);
		}

		// 2) Also persist layout to workspaces.json (best-effort double-write).
		try {
			await saveLayout();
			console.log('[WorkspaceCanvas] saveLayout OK');
		} catch (err) {
			console.error('[WorkspaceCanvas] saveLayout FAILED:', err);
		}
	}, [updateNodes, saveLayout, isReadOnly, isPositionOverlapping, setNodes, activeWorkspaceId]);

	const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
		console.warn(`[WorkspaceCanvas] onNodeClick: node.id=${node.id}`);
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
		// Sync remaining edges to store and persist layout
		const deletedIds = new Set(edgesToDelete.map(e => e.id));
		const remainingEdges = edges.filter(e => !deletedIds.has(e.id));
		updateEdges(remainingEdges.map(e => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: e.type,
			data: e.data,
		})));
		try {
			await saveLayout();
		} catch (err) {
			console.error('[WorkspaceCanvas] Failed to save layout after edge delete:', err);
		}
	}, [activeWorkspaceId, edges, updateEdges, saveLayout]);

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
		const rawPosition = reactFlowInstance.current.screenToFlowPosition({
			x: event.clientX,
			y: event.clientY,
		});

		// Resolve overlaps with existing nodes
		const currentNodes = reactFlowInstance.current.getNodes();
		const position = resolveNonOverlappingPosition(rawPosition, employee.id, currentNodes);

		const selectedEmployeeId = useEmployeeStore.getState().selectedEmployeeId;
		const activeWorkspace = useWorkspaceStore.getState().workspaces.find(w => w.id === activeWorkspaceId);
		const worktreePath = (employee as any).worktreePath || activeWorkspace?.worktreePath;
		const worktreeBranch = (employee as any).worktreeBranch || activeWorkspace?.worktreeBranch;
		const worktreeStatus = worktreePath ? (activeWorkspace?.worktreeStatus ?? 'none') : 'none';
		const newNode: Node = {
			id: employee.id,
			type: 'employee',
			position,
			data: {
				employee,
				isSelected: employee.id === selectedEmployeeId,
				onSelect: (empId: string) => selectEmployee(empId),
				onDelete: (empId: string) => handleDeleteEmployee(empId),
				worktreePath,
				worktreeBranch,
				worktreeStatus,
			},
		};

		setNodes((nds) => [...nds.filter(n => n.id !== employee.id), newNode]);

		if (activeWorkspaceId) {
			await sendRequest('employees.update', {
				id: employee.id,
				data: { position, workspaceId: activeWorkspaceId },
			});
		}
	}, [activeWorkspaceId, setNodes, selectEmployee, resolveNonOverlappingPosition]);

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

	// Subscribe to selectedEmployeeId changes to update node selection state
	const selectedEmployeeId = useEmployeeStore(state => state.selectedEmployeeId);
	
	useEffect(() => {
		setNodes(prevNodes => {
			let changed = false;
			const newNodes = prevNodes.map(node => {
				const emp = node.data?.employee;
				if (!emp) return node;
				const shouldBeSelected = emp.id === selectedEmployeeId;
				if (node.data.isSelected !== shouldBeSelected) {
					changed = true;
					return {
						...node,
						data: {
							...node.data,
							isSelected: shouldBeSelected,
						},
					};
				}
				return node;
			});
			return changed ? newNodes : prevNodes;
		});
	}, [selectedEmployeeId, setNodes]);

	return (
		<ErrorBoundary name="WorkspaceCanvas">
			<div className="canvas-container">
				{/* Fork read-only banner */}
				<ForkReadOnlyBanner />

				{/* Canvas mode */}
				{displayMode === 'canvas' && (
					<div className="canvas-flow-area" ref={reactFlowWrapper}>
						{/* Floating action bar (top-right corner of canvas) */}
						<div className="canvas-view-toggle">
							{/* Session Switcher */}
							<SessionSwitcher />
							<div className="canvas-toggle-divider" />

							{/* Conditionally show "Add Agent" button only in Root mode */}
							{!isReadOnly && (
								<>
									<button
										className="canvas-add-agent-btn"
										onClick={() => setShowCreateModal(true)}
										title="添加 Agent"
									>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
										</svg>
										<span className="canvas-add-agent-label">添加 Agent</span>
									</button>
									<button
										className="task-board-orchestrate-btn"
										onClick={() => openPlanDialog()}
										title="任务编排 - AI 自动拆分任务、创建 Agent"
									>
										🎯 任务编排
									</button>
									<div className="canvas-toggle-divider" />
								</>
							)}
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

						<ReactFlow
							nodes={nodes}
							edges={edges}
							onNodesChange={onNodesChange}
							onEdgesChange={handleEdgesChange}
							onConnect={onConnect}
							onNodeDragStart={onNodeDragStart}
							onNodeDrag={onNodeDrag}
							onNodeDragStop={onNodeDragStop}
							onNodeClick={onNodeClick}
							onInit={onInit}
							onDragOver={onDragOver}
							onDrop={onDrop}
							nodeTypes={nodeTypes}
							edgeTypes={edgeTypes}
							nodesDraggable={true}
							nodesConnectable={!isReadOnly}
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
								nodeColor={(node) => {
									try { return getAgentColor(node.id).primary; } catch { return 'var(--vscode-textLink-foreground, #3b82f6)'; }
								}}
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
						{/* Floating action bar (top-right corner of list) */}
						<div className="canvas-view-toggle">
							<SessionSwitcher />
							<div className="canvas-toggle-divider" />
							{!isReadOnly && (
								<>
									<button
										className="canvas-add-agent-btn"
										onClick={() => setShowCreateModal(true)}
										title="添加 Agent"
									>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
										</svg>
										<span className="canvas-add-agent-label">添加 Agent</span>
									</button>
									<button
										className="task-board-orchestrate-btn"
										onClick={() => openPlanDialog()}
										title="任务编排 - AI 自动拆分任务、创建 Agent"
									>
										🎯 任务编排
									</button>
									<div className="canvas-toggle-divider" />
								</>
							)}
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
		</ErrorBoundary>
	);
}
