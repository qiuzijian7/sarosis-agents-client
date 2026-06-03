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
	useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { EmployeeNode } from './EmployeeNode';
import { ConnectionEdge } from './ConnectionEdge';
import { EmployeeListView } from './EmployeeListView';
import { CreateAgentModal } from '../employees/CreateAgentModal';
import { SessionSwitcher } from './SessionSwitcher';
import { ForkReadOnlyBanner } from './ForkReadOnlyBanner';
import { injectEditorRuntime, CONFIGHTML_EDITOR_SOURCE } from './canvasHtmlEditorRuntime';
import { writeSource } from '../configmd/configMdBridge';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';
import { useWorkspaceSessionStore } from '../../store/useWorkspaceSessionStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { sendRequest } from '../../bridge/messageClient';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { getAgentColor } from '../../utils/agentColors';

type ViewMode = 'canvas' | 'list' | 'html';

const nodeTypes: NodeTypes = {
	employee: EmployeeNode,
};

const edgeTypes: EdgeTypes = {
	connection: ConnectionEdge,
};

export function WorkspaceCanvas(): React.ReactElement {
	const { nodes: storeNodes, edges: storeEdges, activeWorkspaceId, updateNodes, updateEdges, saveLayout, isReadOnly } = useWorkspaceStore();
	const { employees, selectEmployee, deleteEmployee, loadEmployees, exportEmployee, importEmployee } = useEmployeeStore();
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

	// Canvas layout direction with localStorage persistence
	const [layoutDirection, setLayoutDirection] = useState<'vertical' | 'horizontal'>(() => {
		try {
			const saved = localStorage.getItem('hermes-canvas-layout-direction');
			return saved === 'horizontal' ? 'horizontal' : 'vertical';
		} catch {
			return 'vertical';
		}
	});

	// Sync displayMode to localStorage
	const handleViewModeChange = useCallback((mode: ViewMode) => {
		setDisplayMode(mode);
		try { localStorage.setItem('hermes-display-mode', mode); } catch {}
	}, []);

	// NOTE: handleLayoutDirectionToggle is defined later (after node/edge state
	// and persistence helpers are available) because toggling the direction now
	// also re-arranges the card positions to match the new flow orientation.

	// HTML view selected agent ID
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [htmlViewContent, setHtmlViewContent] = useState<string>('');
	const [htmlViewLoading, setHtmlViewLoading] = useState(false);
	const [htmlViewAgents, setHtmlViewAgents] = useState<Array<{ id: string; name: string; role: string; workspaceId: string }>>([]);
	const [isHtmlDropdownOpen, setIsHtmlDropdownOpen] = useState(false);

	// ─── Context menu for right-click copy/paste ─────────────────
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

	// ─── Clipboard for copy/paste ─────────────────────────────────
	interface ClipboardData {
		nodes: Node[];
		edges: Edge[];
		timestamp: number;
	}
	const clipboardRef = useRef<ClipboardData | null>(null);

	// Flag to suppress useEffect node rebuild during paste operation.
	// When true, the employees-watching useEffect skips rebuilding nodes
	// so that handlePaste has full control over node creation + positioning.
	const isPastingRef = useRef(false);

	const handleSelectedAgentIdChange = useCallback((agentId: string | null) => {
		setSelectedAgentId(agentId);
	}, []);

	// ConfigHtml preview bridge: the ConfigHtml editor (a different webview
	// instance) asked — via the host — to show this agent's config.html here.
	// Switch to HTML display mode and select the agent; the existing effect
	// below then loads the HTML via configmd.getResource.
	useEffect(() => {
		const onShowInCanvas = (e: Event) => {
			const detail = (e as CustomEvent).detail as { employeeId?: string } | undefined;
			const employeeId = detail?.employeeId;
			if (!employeeId) {
				return;
			}
			handleViewModeChange('html');
			setSelectedAgentId(employeeId);
		};
		window.addEventListener('agentStudio:configmd-show-in-canvas', onShowInCanvas);
		return () => window.removeEventListener('agentStudio:configmd-show-in-canvas', onShowInCanvas);
	}, [handleViewModeChange]);

	// Load agents with config.md when HTML dropdown opens
	useEffect(() => {
		if (isHtmlDropdownOpen) {
			const loadAgents = async () => {
				try {
					const result: any = await sendRequest('configmd.listAgents', {});
					setHtmlViewAgents(result || []);
				} catch (err) {
					console.error('[WorkspaceCanvas] Failed to load agents with config.md:', err);
					setHtmlViewAgents([]);
				}
			};
			void loadAgents();
		}
	}, [isHtmlDropdownOpen]);

	// Load HTML content when selectedAgentId changes and displayMode is 'html'
	useEffect(() => {
		if (displayMode === 'html' && selectedAgentId) {
			setHtmlViewLoading(true);
			const loadHtml = async () => {
				try {
					const result = await sendRequest('configmd.getResource', { employeeId: selectedAgentId });
					const rawHtml = (result as any)?.html || '';
					// Inject the in-iframe editable runtime so the preview is
					// browser-editable (drag/resize objects, edit text slots,
					// undo/redo, save). The runtime posts the cleaned HTML back
					// to the parent on save (see the message listener below).
					//
					// The Canvas iframe uses `srcdoc`, which INHERITS this
					// webview's strict nonce-based CSP. CSP policies only
					// intersect, so the only way the injected inline runtime
					// <script> is allowed to execute is to carry the SAME nonce
					// the parent webview uses. The controller surfaces it as
					// `window.__AGENT_STUDIO_CSP_NONCE__`.
					const cspNonce = (window as any).__AGENT_STUDIO_CSP_NONCE__ as string | undefined;
					setHtmlViewContent(rawHtml ? injectEditorRuntime(rawHtml, cspNonce) : '');
				} catch (err) {
					console.error('[WorkspaceCanvas] Failed to load HTML content:', err);
					setHtmlViewContent('');
				} finally {
					setHtmlViewLoading(false);
				}
			};
			void loadHtml();
		} else {
			setHtmlViewContent('');
			setHtmlViewLoading(false);
		}
	}, [displayMode, selectedAgentId]);

	// Listen for save/dirty messages posted by the injected editor runtime
	// inside the Canvas HTML iframe. On save, persist the edited HTML back to
	// the agent's config.html via the host.
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			const data = e.data as { source?: string; type?: string; html?: string } | undefined;
			if (!data || data.source !== CONFIGHTML_EDITOR_SOURCE) {
				return;
			}
			if (data.type === 'save' && typeof data.html === 'string' && selectedAgentId) {
				void writeSource(selectedAgentId, data.html, { origin: 'editor' })
					.catch((err) => console.error('[WorkspaceCanvas] save edited HTML failed:', err));
			}
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [selectedAgentId]);

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
					layoutDirection,
				},
			};
		});
	}, [employees, storeNodes, selectEmployee, findNonOverlappingPosition, layoutDirection]);

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

	// Sync layoutDirection to all nodes when it changes
	useEffect(() => {
		setNodes(prevNodes => prevNodes.map(n => ({
			...n,
			data: { ...n.data, layoutDirection },
		})));
	}, [layoutDirection, setNodes]);

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
		// Skip rebuild during paste operation — handlePaste manages nodes directly.
		if (isPastingRef.current) {
			console.log('[WorkspaceCanvas] employees changed during paste — skipping rebuild');
			return;
		}
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
						layoutDirection,
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
		// Explicitly mark the clicked node as selected in ReactFlow's internal state.
		// This is necessary because selectionOnDrag + panOnDrag=[1] can sometimes
		// prevent ReactFlow from automatically marking a single-clicked node as selected.
		setNodes(prevNodes => prevNodes.map(n => ({
			...n,
			selected: n.id === node.id,
		})));
	}, [selectEmployee, setNodes]);

	const onInit = useCallback((instance: ReactFlowInstance) => {
		reactFlowInstance.current = instance;
	}, []);

	// ─── Layout direction toggle (also re-arranges card positions) ──────
	// When the user switches between vertical and horizontal layout we not
	// only flip the connection-handle orientation (handled inside
	// EmployeeNode) but ALSO re-arrange the cards so the overall flow reads
	// in the new direction:
	//   - vertical   → cards stacked top→bottom (a grid that grows downward)
	//   - horizontal → cards laid left→right   (a grid that grows rightward)
	// Connected agents (source → target) are kept in dependency order so the
	// arrows follow the chosen reading direction.
	const handleLayoutDirectionToggle = useCallback(() => {
		setLayoutDirection(prev => {
			const next = prev === 'vertical' ? 'horizontal' : 'vertical';
			try { localStorage.setItem('hermes-canvas-layout-direction', next); } catch {}

			// Transpose node positions: swap x and y coordinates (reflection
			// along y = -x). This preserves the relative spatial arrangement
			// of cards while converting a vertical layout to horizontal or
			// vice-versa.
			const currentNodes = nodesRef.current;
			if (currentNodes.length === 0) { return next; }

			const newPosById = new Map<string, { x: number; y: number }>();
			for (const n of currentNodes) {
				// Simply swap x ↔ y to transpose the layout
				newPosById.set(n.id, { x: n.position.y, y: n.position.x });
			}

			// Apply to ReactFlow nodes immediately (also refresh layoutDirection).
			setNodes(prevNodes => prevNodes.map(n => ({
				...n,
				position: newPosById.get(n.id) || n.position,
				data: { ...n.data, layoutDirection: next },
			})));

			// Note: Handle position update is handled by EmployeeNode's own
			// useEffect which watches `layoutDirection` in node.data and calls
			// updateNodeInternals via double-rAF after the DOM re-paints.

			// Persist new positions (best-effort) so they survive reload.
			if (!isReadOnly) {
				const updated = currentNodes.map(n => ({
					id: n.id,
					type: n.type || 'employee',
					position: newPosById.get(n.id) || n.position,
					data: {},
				}));
				updateNodes(updated);
				for (const n of updated) {
					sendRequest('employees.update', { id: n.id, data: { position: n.position } })
						.catch(err => console.error('[WorkspaceCanvas] layout reflow employees.update failed:', err));
				}
				saveLayout().catch(err => console.error('[WorkspaceCanvas] layout reflow saveLayout failed:', err));
			}

			return next;
		});
	}, [isReadOnly, setNodes, updateNodes, saveLayout]);

	// ─── Copy / Paste keyboard handlers ──────────────────────────
	const handleCopy = useCallback(() => {
		if (!reactFlowInstance.current) { return; }
		let selectedNodes = reactFlowInstance.current.getNodes().filter(n => n.selected);

		// Fallback: if ReactFlow has no selection, use the store's selectedEmployeeId.
		// This handles the case where clicking a node only updates our store but not
		// ReactFlow's internal selection (e.g. in VS Code webview where click events
		// may not propagate ReactFlow's selection logic correctly).
		if (selectedNodes.length === 0) {
			const selectedId = useEmployeeStore.getState().selectedEmployeeId;
			if (selectedId) {
				const node = reactFlowInstance.current.getNodes().find(n => n.id === selectedId);
				if (node) {
					selectedNodes = [node];
					console.log(`[WorkspaceCanvas] Copy fallback: using store selectedEmployeeId "${selectedId}"`);
				}
			}
		}

		if (selectedNodes.length === 0) {
			console.warn('[WorkspaceCanvas] Copy: no nodes selected (neither ReactFlow selection nor store)');
			return;
		}
		const selectedNodeIds = new Set(selectedNodes.map(n => n.id));
		// Only copy edges where both endpoints are in the selection
		const selectedEdges = reactFlowInstance.current.getEdges().filter(
			e => selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target)
		);
		clipboardRef.current = { nodes: selectedNodes, edges: selectedEdges, timestamp: Date.now() };
		console.log(`[WorkspaceCanvas] Copied ${selectedNodes.length} nodes, ${selectedEdges.length} edges`);
	}, []);

	const handlePaste = useCallback(async () => {
		if (!clipboardRef.current) {
			console.warn('[WorkspaceCanvas] Paste: clipboard is empty (nothing copied yet)');
			return;
		}
		if (!reactFlowInstance.current) {
			console.warn('[WorkspaceCanvas] Paste: ReactFlow instance not ready');
			return;
		}
		if (isReadOnly) {
			console.warn('[WorkspaceCanvas] Paste: canvas is read-only');
			return;
		}
		const { nodes: copiedNodes, edges: copiedEdges } = clipboardRef.current;

		// Resolve workspace ID — prefer store's activeWorkspaceId, fallback to the
		// workspaceId field on the first copied employee (covers the case where
		// the canvas displays agents but workspace.setActive was never called).
		let resolvedWorkspaceId = activeWorkspaceId;
		if (!resolvedWorkspaceId) {
			const firstEmp = useEmployeeStore.getState().employees.find(e => e.id === copiedNodes[0]?.id);
			resolvedWorkspaceId = firstEmp?.workspaceId ?? null;
			if (resolvedWorkspaceId) {
				console.log(`[WorkspaceCanvas] Paste: activeWorkspaceId was null, resolved from employee.workspaceId: ${resolvedWorkspaceId}`);
			}
		}
		if (!resolvedWorkspaceId) {
			// Last resort: try to get workspaceId from workspaces list (first workspace)
			const workspaces = useWorkspaceStore.getState().workspaces;
			resolvedWorkspaceId = workspaces[0]?.id ?? null;
			if (resolvedWorkspaceId) {
				console.log(`[WorkspaceCanvas] Paste: resolved from first workspace in store: ${resolvedWorkspaceId}`);
			}
		}
		if (!resolvedWorkspaceId) {
			console.warn('[WorkspaceCanvas] Paste: no active workspace ID and no fallback available');
			return;
		}

		// CRITICAL: If activeWorkspaceId was null, update the store NOW so that
		// any subsequent `employees.changed` event handlers (in App.tsx) will
		// use the correct workspace ID when calling loadEmployees().
		if (!activeWorkspaceId) {
			console.log(`[WorkspaceCanvas] Paste: setting store activeWorkspaceId to ${resolvedWorkspaceId}`);
			useWorkspaceStore.setState({ activeWorkspaceId: resolvedWorkspaceId });
		}

		console.log(`[WorkspaceCanvas] Paste started: ${copiedNodes.length} nodes, workspace=${resolvedWorkspaceId}`);

		// Offset for paste (shift slightly so pasted nodes don't overlap originals)
		const OFFSET = 40;
		const idMap = new Map<string, string>(); // old id → new id

		// Suppress useEffect rebuild while we import employees.
		// importEmployee updates Zustand store.employees → which would normally
		// trigger the useEffect to rebuild all nodes. That rebuild would produce
		// duplicate IDs because we also manually add nodes below.
		isPastingRef.current = true;

		// 1. Create new employee instances via export → import
		for (const node of copiedNodes) {
			try {
				console.log(`[WorkspaceCanvas] Paste: exporting employee "${node.id}"...`);
				const exportData = await exportEmployee(node.id);
				console.log(`[WorkspaceCanvas] Paste: importing clone of "${node.id}"...`);
				// Create via import (which clones the agent dir, config, etc.)
				const newEmployee = await importEmployee(exportData, resolvedWorkspaceId!);
				idMap.set(node.id, newEmployee.id);
				console.log(`[WorkspaceCanvas] Paste: cloned "${node.id}" → "${newEmployee.id}"`);
			} catch (err) {
				console.error(`[WorkspaceCanvas] Failed to clone employee ${node.id}:`, err);
			}
		}

		if (idMap.size === 0) {
			console.warn('[WorkspaceCanvas] Paste: all clone attempts failed, no nodes to paste');
			isPastingRef.current = false;
			return;
		}

		// 2. Build new nodes with offset positions
		const newNodes: Node[] = [];
		for (const node of copiedNodes) {
			const newId = idMap.get(node.id);
			if (!newId) { continue; }
			const emp = useEmployeeStore.getState().employees.find(e => e.id === newId);
			if (!emp) { continue; }
			newNodes.push({
				id: newId,
				type: 'employee',
				position: { x: node.position.x + OFFSET, y: node.position.y + OFFSET },
				draggable: true,
				selectable: true,
				data: {
					employee: emp,
					isSelected: false,
					onSelect: (empId: string) => selectEmployee(empId),
					onDelete: (empId: string) => { void deleteEmployee(empId); },
					layoutDirection,
				},
			});
		}

		// 3. Create new edges (only between successfully cloned nodes)
		const newEdges: Edge[] = [];
		for (const edge of copiedEdges) {
			const newSource = idMap.get(edge.source);
			const newTarget = idMap.get(edge.target);
			if (!newSource || !newTarget) { continue; }
			try {
				await sendRequest('workspace.connections.add', {
					workspaceId: resolvedWorkspaceId,
					sourceId: newSource,
					targetId: newTarget,
					type: 'subagent',
				});
				newEdges.push({
					id: `e-${newSource}-${newTarget}`,
					source: newSource,
					target: newTarget,
					type: 'connection',
					animated: true,
					style: { stroke: 'var(--vscode-textLink-foreground, #3b82f6)', strokeWidth: 2 },
				});
			} catch (err) {
				console.error(`[WorkspaceCanvas] Failed to add connection ${newSource}→${newTarget}:`, err);
			}
		}

		// 4. Add new nodes/edges to ReactFlow state (merge, not replace)
		setNodes(prev => {
			// Filter out any duplicates that might have slipped through
			const existingIds = new Set(prev.map(n => n.id));
			const uniqueNewNodes = newNodes.filter(n => !existingIds.has(n.id));
			return [...prev, ...uniqueNewNodes];
		});
		setEdges(prev => [...prev, ...newEdges]);

		// 5. Persist layout
		try {
			// Update store nodes/edges with the new data
			const currentStoreNodes = useWorkspaceStore.getState().nodes;
			const currentStoreEdges = useWorkspaceStore.getState().edges;
			updateNodes([...currentStoreNodes, ...newNodes.map(n => ({ id: n.id, position: n.position }))]);
			updateEdges([...currentStoreEdges, ...newEdges.map(e => ({
				id: e.id, source: e.source, target: e.target, type: e.type, data: e.data,
			}))]);
			await saveLayout();
		} catch (err) {
			console.error('[WorkspaceCanvas] Failed to save layout after paste:', err);
		}

		// 6. Persist positions to employees.json via employees.update
		for (const node of newNodes) {
			try {
				await sendRequest('employees.update', {
					id: node.id,
					data: { position: node.position },
				});
			} catch (err) {
				console.error(`[WorkspaceCanvas] Failed to persist position for pasted node ${node.id}:`, err);
			}
		}

		// 7. Select newly pasted nodes
		setNodes(prev => prev.map(n => ({
			...n,
			selected: newNodes.some(nn => nn.id === n.id),
		})));

		// Re-enable the employees useEffect after the current render cycle.
		// Use setTimeout(0) to ensure any queued React re-renders from the
		// importEmployee store updates have already been processed.
		setTimeout(() => {
			isPastingRef.current = false;
		}, 0);

		console.log(`[WorkspaceCanvas] Pasted ${newNodes.length} nodes, ${newEdges.length} edges`);
	}, [activeWorkspaceId, isReadOnly, exportEmployee, importEmployee, selectEmployee, deleteEmployee, layoutDirection, setNodes, setEdges, updateNodes, updateEdges, saveLayout]);

	// Global keyboard shortcut handler for copy/paste
	// Uses document-level listener because ReactFlow's onKeyDown only fires when
	// the ReactFlow container has focus — in a VS Code WebView this is unreliable.
	//
	// Supports both Ctrl+C/V and Ctrl+Shift+C/V (in case VS Code intercepts plain Ctrl+C/V).
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Only handle when not in an input/textarea
			const target = event.target as HTMLElement;
			if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
				return;
			}

			// IMPORTANT: exclude Shift so we do NOT swallow VS Code's native
			// Ctrl+Shift+C / Ctrl+Shift+V (and avoid interfering with other
			// Ctrl+Shift+* shortcuts that bubble through the webview, e.g.
			// the command palette). Only plain Ctrl/Cmd + C/V is ours.
			const ctrlOrMeta = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
			const isCopy = ctrlOrMeta && (event.key === 'c' || event.key === 'C');
			const isPaste = ctrlOrMeta && (event.key === 'v' || event.key === 'V');

			if (isCopy) {
				console.log('[WorkspaceCanvas] Copy shortcut detected, selectedNodes:',
					reactFlowInstance.current?.getNodes().filter(n => n.selected).length ?? 0);
				event.preventDefault();
				event.stopPropagation();
				handleCopy();
			} else if (isPaste) {
				console.log('[WorkspaceCanvas] Paste shortcut detected, clipboard:',
					clipboardRef.current ? `${clipboardRef.current.nodes.length} nodes` : 'empty');
				event.preventDefault();
				event.stopPropagation();
				handlePaste();
			}
		};

		// Use capture phase to intercept before VS Code's handler
		document.addEventListener('keydown', handleKeyDown, true);
		return () => document.removeEventListener('keydown', handleKeyDown, true);
	}, [handleCopy, handlePaste]);

	// ─── Context menu (right-click) for copy/paste ───────────────
	const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
		event.preventDefault();
		setContextMenu({ x: event.clientX, y: event.clientY });
	}, []);

	const onNodeContextMenu = useCallback((event: React.MouseEvent, _node: Node) => {
		event.preventDefault();
		setContextMenu({ x: event.clientX, y: event.clientY });
	}, []);

	// Close context menu on any click outside
	useEffect(() => {
		const closeMenu = () => setContextMenu(null);
		document.addEventListener('click', closeMenu);
		return () => document.removeEventListener('click', closeMenu);
	}, []);

	const handleContextMenuCopy = useCallback(() => {
		handleCopy();
		setContextMenu(null);
	}, [handleCopy]);

	const handleContextMenuPaste = useCallback(() => {
		handlePaste();
		setContextMenu(null);
	}, [handlePaste]);

	const handleContextMenuDelete = useCallback(async () => {
		if (!reactFlowInstance.current) { return; }
		const selectedNodes = reactFlowInstance.current.getNodes().filter(n => n.selected);
		for (const node of selectedNodes) {
			try {
				await deleteEmployee(node.id);
			} catch (err) {
				console.error(`[WorkspaceCanvas] Failed to delete employee ${node.id}:`, err);
			}
		}
		setContextMenu(null);
	}, [deleteEmployee]);

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
		// 强化二次确认：明确告知用户对话与记忆会一并清除
		const emp = employees.find(e => e.id === empId);
		const name = emp?.name ?? empId;
		const ok = window.confirm(
			`确定要删除 Agent "${name}" 吗？\n\n` +
			`⚠️ 此操作将同时永久删除该 Agent 的：\n` +
			`  • 全部对话历史（L0）\n` +
			`  • 全部已提取的长期记忆（L1）\n` +
			`  • Agent 配置文件目录\n\n` +
			`此操作不可撤销。`
		);
		if (!ok) return;
		try {
			await deleteEmployee(empId);
		} catch (err) {
			console.error('Failed to delete employee:', err);
		}
	}, [deleteEmployee, employees]);

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
				// @ts-ignore
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
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'canvas' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('canvas')}
								title="画布视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
								</svg>
							</button>
							<button
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'list' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('list')}
								title="列表视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
								</svg>
							</button>
							<button
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'html' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('html')}
								title="HTML 视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0-5v.01M15 21h-6a2 2 0 01-2-2V5a2 2 0 012-2h8a2 2 0 012 2v.01M15 3h-6a2 2 0 00-2 2v14a2 2 0 002 2h6a2 2 0 002-2V5a2 2 0 00-2-2z" />
								</svg>
							</button>
							<div className="canvas-toggle-divider" />
							<button
								className="canvas-html-dropdown-btn"
								onClick={() => setIsHtmlDropdownOpen(prev => !prev)}
								title="选择 Agent"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ width: '10px', height: '10px' }}>
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
							</button>
							{isHtmlDropdownOpen && (
								<div className="canvas-html-dropdown">
									{htmlViewAgents.length === 0 ? (
										<div className="canvas-html-dropdown-empty">暂无已配置 config.md 的 Agent</div>
									) : (
										htmlViewAgents.map(agent => (
											<div
												key={agent.id}
												className={`canvas-html-dropdown-item ${selectedAgentId === agent.id ? 'active' : ''}`}
												onClick={() => { setSelectedAgentId(agent.id); setIsHtmlDropdownOpen(false); }}
											>
												{agent.name}
											</div>
										))
									)}
								</div>
							)}
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
							onNodeContextMenu={onNodeContextMenu}
							onPaneContextMenu={onPaneContextMenu}
							onInit={onInit}
							onDragOver={onDragOver}
							onDrop={onDrop}
							nodeTypes={nodeTypes}
							edgeTypes={edgeTypes}
							nodesDraggable={true}
							nodesConnectable={!isReadOnly}
							elementsSelectable={true}
							selectionOnDrag={false}
							panOnDrag={true}
							panOnScroll={true}
							selectionKeyCode="Shift"
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
							{/* Layout direction toggle - floating above the zoom controls (bottom-left) */}
							<button
								className={`canvas-layout-direction-btn ${layoutDirection === 'vertical' ? 'vertical' : 'horizontal'}`}
								onClick={handleLayoutDirectionToggle}
								title={layoutDirection === 'vertical' ? '垂直布局（当前）- 点击切换为水平布局' : '水平布局（当前）- 点击切换为垂直布局'}
							>
								{layoutDirection === 'vertical' ? (
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-4 4m4-4l4 4" />
									</svg>
								) : (
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14m0 0l-4-4m4 4l-4 4" />
									</svg>
								)}
							</button>
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

						{/* Context menu for copy/paste/delete */}
						{contextMenu && (
							<div
								className="canvas-context-menu"
								style={{ left: contextMenu.x, top: contextMenu.y }}
							>
								<div className="canvas-context-menu-item" onClick={handleContextMenuCopy}>
									<span className="canvas-context-menu-label">复制 Agent</span>
									<span className="canvas-context-menu-shortcut">Ctrl+C</span>
								</div>
								<div
									className={`canvas-context-menu-item ${!clipboardRef.current ? 'disabled' : ''}`}
									onClick={clipboardRef.current ? handleContextMenuPaste : undefined}
								>
									<span className="canvas-context-menu-label">粘贴 Agent</span>
									<span className="canvas-context-menu-shortcut">Ctrl+V</span>
								</div>
								<div className="canvas-context-menu-divider" />
								<div className="canvas-context-menu-item danger" onClick={handleContextMenuDelete}>
									<span className="canvas-context-menu-label">删除选中</span>
									<span className="canvas-context-menu-shortcut">Delete</span>
								</div>
							</div>
						)}

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
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'canvas' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('canvas')}
								title="画布视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
								</svg>
							</button>
							<button
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'list' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('list')}
								title="列表视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
								</svg>
							</button>
							<button
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'html' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('html')}
								title="HTML 视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0-5v.01M15 21h-6a2 2 0 01-2-2V5a2 2 0 012-2h8a2 2 0 012 2v.01M15 3h-6a2 2 0 00-2 2v14a2 2 0 002 2h6a2 2 0 002-2V5a2 2 0 00-2-2z" />
								</svg>
							</button>
							<div className="canvas-toggle-divider" />
							<button
								className="canvas-html-dropdown-btn"
								onClick={() => setIsHtmlDropdownOpen(prev => !prev)}
								title="选择 Agent"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ width: '10px', height: '10px' }}>
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
							</button>
							{isHtmlDropdownOpen && (
								<div className="canvas-html-dropdown">
									{htmlViewAgents.length === 0 ? (
										<div className="canvas-html-dropdown-empty">暂无已配置 config.md 的 Agent</div>
									) : (
										htmlViewAgents.map(agent => (
											<div
												key={agent.id}
												className={`canvas-html-dropdown-item ${selectedAgentId === agent.id ? 'active' : ''}`}
												onClick={() => { setSelectedAgentId(agent.id); setIsHtmlDropdownOpen(false); }}
											>
												{agent.name}
											</div>
										))
									)}
								</div>
							)}
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

				{/* HTML view mode */}
				{displayMode === 'html' && (
					<div className="canvas-html-view-area">
						{/* Floating view toggle bar - visible in HTML mode too */}
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
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'canvas' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('canvas')}
								title="画布视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
								</svg>
							</button>
							<button
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'list' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('list')}
								title="列表视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
								</svg>
							</button>
							<button
								className={`canvas-view-toggle-btn ${(displayMode as any) === 'html' ? 'active' : ''}`}
								onClick={() => handleViewModeChange('html')}
								title="HTML 视图"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0-5v.01M15 21h-6a2 2 0 01-2-2V5a2 2 0 012-2h8a2 2 0 012 2v.01M15 3h-6a2 2 0 00-2 2v14a2 2 0 002 2h6a2 2 0 002-2V5a2 2 0 00-2-2z" />
								</svg>
							</button>
							<div className="canvas-toggle-divider" />
							<button
								className="canvas-html-dropdown-btn"
								onClick={() => setIsHtmlDropdownOpen(prev => !prev)}
								title="选择 Agent"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ width: '10px', height: '10px' }}>
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
								</svg>
							</button>
							{isHtmlDropdownOpen && (
								<div className="canvas-html-dropdown">
									{htmlViewAgents.length === 0 ? (
										<div className="canvas-html-dropdown-empty">暂无已配置 config.md 的 Agent</div>
									) : (
										htmlViewAgents.map(agent => (
											<div
												key={agent.id}
												className={`canvas-html-dropdown-item ${selectedAgentId === agent.id ? 'active' : ''}`}
												onClick={() => { setSelectedAgentId(agent.id); setIsHtmlDropdownOpen(false); }}
											>
												{agent.name}
											</div>
										))
									)}
								</div>
							)}
						</div>

						{htmlViewLoading && <div className="canvas-html-loading">加载中...</div>}
						{!htmlViewLoading && htmlViewContent && (
							<iframe className="canvas-html-iframe" srcDoc={htmlViewContent} sandbox="allow-scripts" />
						)}
						{!htmlViewLoading && !htmlViewContent && (
							<div className="canvas-html-empty">请选择一个 Agent 查看其 config.html</div>
						)}
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
