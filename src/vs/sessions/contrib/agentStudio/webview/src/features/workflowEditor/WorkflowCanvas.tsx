/*---------------------------------------------------------------------------------------------
 *  WorkflowCanvas — ReactFlow canvas with node types, background, and controls.
 *
 *  Wires in all borrowed interaction features:
 *   - CanvasToolbar (interaction/scroll/edge-animation/minimap toggles)
 *   - StartMenu (empty-state overlay)
 *   - DeletableEdge (custom edge with delete button) + connection validation
 *   - Undo/Redo (Ctrl+Z / Ctrl+Shift+Z), copy/paste/duplicate (Ctrl+C/V/D)
 *   - Drag pauses undo tracking so a drag = one undo step
 *   - Delete confirmation dialog for nodes
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { sendRequest } from '../../bridge/messageClient';
import {
	ReactFlow,
	Background,
	Controls,
	MiniMap,
	Panel,
	useReactFlow,
	type NodeTypes,
	type EdgeTypes,
	type Node,
	type Edge,
	type Connection,
	type IsValidConnection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { StartNode } from './nodes/StartNode';
import { EndNode } from './nodes/EndNode';
import { TaskNode } from './nodes/TaskNode';
import { PromptNode } from './nodes/PromptNode';
import { AgentNode } from './nodes/AgentNode';
import { SkillNode } from './nodes/SkillNode';
import { ToolNode } from './nodes/ToolNode';
import { IfElseNode } from './nodes/IfElseNode';
import { SwitchNode } from './nodes/SwitchNode';
import { AskUserNode } from './nodes/AskUserNode';
import { GroupNode } from './nodes/GroupNode';
import { DeletableEdge } from './edges/DeletableEdge';
import { CanvasToolbar } from './CanvasToolbar';
import { StartMenu } from './StartMenu';
import { ConfirmDialog } from './ConfirmDialog';
import {
	useWorkflowEditorStore,
	undo as doUndo,
	redo as doRedo,
	pauseTracking,
	resumeTracking,
} from './store';

const nodeTypes: NodeTypes = {
	start: StartNode,
	end: EndNode,
	task: TaskNode,
	prompt: PromptNode,
	agent: AgentNode,
	skill: SkillNode,
	tool: ToolNode,
	ifElse: IfElseNode,
	switch: SwitchNode,
	askUser: AskUserNode,
	group: GroupNode,
};

const edgeTypes: EdgeTypes = {
	deletable: DeletableEdge,
};

const nodeColor = (node: Node): string => {
	switch (node.type) {
		case 'start': return '#22c55e';
		case 'end': return '#ef4444';
		case 'task': return '#3b82f6';
		case 'prompt': return '#8b5cf6';
		case 'agent': return '#f97316';
		case 'skill': return '#eab308';
		case 'tool': return '#10b981';
		case 'ifElse': return '#ef4444';
		case 'switch': return '#a855f7';
		case 'askUser': return '#06b6d4';
		case 'group': return '#888780';
		default: return '#888780';
	}
};

let _clipboard: Node | null = null;

export const WorkflowCanvas: React.FC = () => {
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const edges = useWorkflowEditorStore(s => s.edges);
	const onNodesChange = useWorkflowEditorStore(s => s.onNodesChange);
	const onEdgesChange = useWorkflowEditorStore(s => s.onEdgesChange);
	const onConnect = useWorkflowEditorStore(s => s.onConnect);
	const setSelectedNode = useWorkflowEditorStore(s => s.setSelectedNode);
	const interactionMode = useWorkflowEditorStore(s => s.interactionMode);
	const scrollMode = useWorkflowEditorStore(s => s.scrollMode);
	const isEdgeAnimationEnabled = useWorkflowEditorStore(s => s.isEdgeAnimationEnabled);
	const workflowBreakpoints = useWorkflowEditorStore(s => s.workflowBreakpoints);
	const minimapMode = useWorkflowEditorStore(s => s.minimapMode);
	const executionId = useWorkflowEditorStore(s => s.executionId);
	const executionStatus = useWorkflowEditorStore(s => s.executionStatus);
	const currentNodeId = useWorkflowEditorStore(s => s.currentNodeId);
	const nodeExecutionStates = useWorkflowEditorStore(s => s.nodeExecutionStates);

	const { screenToFlowPosition } = useReactFlow();

	// Delete-confirmation state
	const [pendingDelete, setPendingDelete] = useState<{ ids: string[]; label: string } | null>(null);
	// Auto-show minimap while interacting (for 'auto' mode)
	const [isInteracting, setIsInteracting] = useState(false);
	const interactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
		setSelectedNode(node.id);
	}, [setSelectedNode]);

	const onPaneClick = useCallback(() => {
		setSelectedNode(null);
	}, [setSelectedNode]);

	// ── Connection validation ──
	const isValidConnection = useCallback<IsValidConnection>((conn: Connection | Edge) => {
		const source = conn.source;
		const target = conn.target;
		if (!source || !target) { return false; }
		// No self-loops
		if (source === target) { return false; }
		// Start has no inputs, End has no outputs
		const targetNode = nodes.find(n => n.id === target);
		const sourceNode = nodes.find(n => n.id === source);
		if (targetNode?.type === 'start') { return false; }
		if (sourceNode?.type === 'end') { return false; }
		// No duplicate edges
		const exists = edges.some(e => e.source === source && e.target === target);
		if (exists) { return false; }
		return true;
	}, [nodes, edges]);

	// ── Drag pauses undo tracking (drag = single undo step) ──
	const onNodeDragStart = useCallback(() => {
		pauseTracking();
		markInteracting();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const onNodeDragStop = useCallback(() => {
		resumeTracking();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const markInteracting = useCallback(() => {
		setIsInteracting(true);
		if (interactTimer.current) { clearTimeout(interactTimer.current); }
		interactTimer.current = setTimeout(() => setIsInteracting(false), 1500);
	}, []);

	// ── Edge delete (from DeletableEdge custom event) ──
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as { edgeId: string };
			if (detail?.edgeId) {
				useWorkflowEditorStore.getState().deleteEdge(detail.edgeId);
			}
		};
		window.addEventListener('workflowEditor:deleteEdge', handler);
		return () => window.removeEventListener('workflowEditor:deleteEdge', handler);
	}, []);

	// ── Keyboard shortcuts: undo/redo, copy/paste/duplicate ──
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			// Skip when typing in inputs
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
				return;
			}
			const mod = e.ctrlKey || e.metaKey;
			if (!mod) { return; }

			const key = e.key.toLowerCase();
			const store = useWorkflowEditorStore.getState();

			if (key === 'z' && !e.shiftKey) {
				e.preventDefault();
				doUndo();
			} else if ((key === 'z' && e.shiftKey) || key === 'y') {
				e.preventDefault();
				doRedo();
			} else if (key === 'c') {
				// Copy selected node
				const sel = store.selectedNodeId;
				if (sel && sel !== 'start' && sel !== 'end') {
					const node = store.nodes.find(n => n.id === sel);
					if (node) { _clipboard = node; }
				}
			} else if (key === 'v') {
				// Paste clipboard node at an offset
				if (_clipboard) {
					e.preventDefault();
					const newId = store.duplicateNode(_clipboard.id) ?? null;
					// If the original was deleted, recreate from clipboard
					if (!newId && _clipboard.type) {
						store.addNode(_clipboard.type, {
							x: _clipboard.position.x + 40,
							y: _clipboard.position.y + 40,
						});
					}
				}
			} else if (key === 'd') {
				// Duplicate selected node
				const sel = store.selectedNodeId;
				if (sel && sel !== 'start' && sel !== 'end') {
					e.preventDefault();
					store.duplicateNode(sel);
				}
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);

	// ── Intercept node deletion to confirm first ──
	const onNodesDelete = useCallback((deleted: Node[]) => {
		// ReactFlow already removed them visually; we re-add via store if needed.
		// Simpler: prevent default deletion by handling delete key ourselves below.
		const removable = deleted.filter(n => n.id !== 'start' && n.id !== 'end');
		if (removable.length === 0) { return; }
		// The store already reflects removal through onNodesChange; nothing else needed.
	}, []);

	// Custom delete-key handling with confirmation (supports multi-select)
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key !== 'Delete' && e.key !== 'Backspace') { return; }
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) {
				return;
			}
			const store = useWorkflowEditorStore.getState();
			// Collect all selected nodes from ReactFlow's selection state (box-select + Ctrl+click)
			const selectedIds = store.nodes
				.filter(n => n.selected && n.id !== 'start' && n.id !== 'end')
				.map(n => n.id);
			if (selectedIds.length === 0) { return; }
			e.preventDefault();
			e.stopPropagation();
			if (selectedIds.length === 1) {
				const node = store.nodes.find(n => n.id === selectedIds[0]);
				const label = (node?.data?.label as string) || selectedIds[0];
				setPendingDelete({ ids: selectedIds, label });
			} else {
				setPendingDelete({ ids: selectedIds, label: `${selectedIds.length} nodes` });
			}
		};
		// Capture phase so we run before ReactFlow's own delete handler
		window.addEventListener('keydown', handler, true);
		return () => window.removeEventListener('keydown', handler, true);
	}, []);

	const confirmDelete = useCallback(() => {
		if (!pendingDelete) { return; }
		const store = useWorkflowEditorStore.getState();
		for (const id of pendingDelete.ids) {
			store.removeNode(id);
		}
		setPendingDelete(null);
	}, [pendingDelete]);

	// ── Effective interaction props ──
	const panOnDrag = useMemo(() => {
		// pan mode: drag pans canvas; select mode: drag selects (box)
		return interactionMode === 'pan';
	}, [interactionMode]);

	const selectionOnDrag = useMemo(() => interactionMode === 'select', [interactionMode]);

	// scroll mode: classic = zoom on scroll; pan = pan on scroll
	const panOnScroll = scrollMode === 'pan';
	const zoomOnScroll = scrollMode === 'classic';

	// ── Animated edges ──
	const displayEdges = useMemo<Edge[]>(() => {
		if (isEdgeAnimationEnabled) {
			return edges.map(e => ({ ...e, animated: true, type: e.type || 'deletable' }));
		}
		return edges.map(e => ({ ...e, animated: false, type: e.type || 'deletable' }));
	}, [edges, isEdgeAnimationEnabled]);

	// ── Nodes with execution state (P3) ──
	const displayNodes = useMemo<Node[]>(() => {
		// v5a: read workflowBreakpoints from store and inject as node data
		const bpSet = new Set(useWorkflowEditorStore.getState().workflowBreakpoints);
		if (!executionId) {
			return nodes.map(n => ({
				...n,
				data: { ...n.data, hasBreakpoint: bpSet.has(n.id) },
			}));
		}
		return nodes.map(n => {
			const nodeState = nodeExecutionStates[n.id];
			const isCurrent = n.id === currentNodeId;
			return {
				...n,
				data: {
					...n.data,
					hasBreakpoint: bpSet.has(n.id),
					executionState: nodeState?.status || 'pending',
					isCurrentNode: isCurrent,
					executionError: nodeState?.error,
				},
			};
		});
	}, [nodes, executionId, currentNodeId, nodeExecutionStates, workflowBreakpoints]);

	// ── MiniMap visibility ──
	const showMinimap = useMemo(() => {
		if (minimapMode === 'always') { return true; }
		if (minimapMode === 'hidden') { return false; }
		return isInteracting; // auto
	}, [minimapMode, isInteracting]);

	const handleAddNode = useCallback((type: string) => {
		const pos = screenToFlowPosition({
			x: window.innerWidth / 2,
			y: window.innerHeight / 2,
		});
		useWorkflowEditorStore.getState().addNode(type, pos);
	}, [screenToFlowPosition]);

	// ── v5a: Right-click context menu (toggle breakpoint) ─────────────
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string; hasBreakpoint: boolean } | null>(null);
	const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
		event.preventDefault();
		setContextMenu({
			x: event.clientX,
			y: event.clientY,
			nodeId: node.id,
			hasBreakpoint: !!(node.data as { hasBreakpoint?: boolean })?.hasBreakpoint,
		});
	}, []);

	// Close on any click outside the menu.
	useEffect(() => {
		if (!contextMenu) { return; }
		const handler = () => setContextMenu(null);
		window.addEventListener('click', handler);
		return () => window.removeEventListener('click', handler);
	}, [contextMenu]);

	const workflowId = useWorkflowEditorStore(s => s.workflowId);
	const toggleWorkflowBreakpoint = useWorkflowEditorStore(s => s.toggleWorkflowBreakpoint);
	const handleToggleBreakpoint = useCallback(async () => {
		if (!contextMenu) { return; }
		const { nodeId, hasBreakpoint } = contextMenu;
		const executionId = useWorkflowEditorStore.getState().executionId ?? undefined;
		// Optimistic local update
		toggleWorkflowBreakpoint(nodeId);
		try {
			if (hasBreakpoint) {
				await sendRequest('workflow.breakpoint.clear', { workflowId, nodeId, executionId });
			} else {
				await sendRequest('workflow.breakpoint.set', { workflowId, nodeId, executionId });
			}
		} catch (err) {
			// Rollback on failure.
			console.error('[WorkflowCanvas] toggle breakpoint RPC failed:', err);
			toggleWorkflowBreakpoint(nodeId);
		}
		setContextMenu(null);
	}, [contextMenu, workflowId, toggleWorkflowBreakpoint]);

	return (
		<div style={{ position: 'absolute', inset: 0 }}>
			<ReactFlow
				nodes={displayNodes}
				edges={displayEdges}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				onNodesDelete={onNodesDelete}
				onNodeClick={onNodeClick}
				onPaneClick={onPaneClick}
				onNodeContextMenu={onNodeContextMenu}
				onNodeDragStart={onNodeDragStart}
				onNodeDragStop={onNodeDragStop}
				onMove={markInteracting}
				isValidConnection={isValidConnection}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				defaultEdgeOptions={{ type: 'deletable' }}
				fitView
				snapToGrid
				snapGrid={[15, 15]}
				deleteKeyCode={null}
				panOnDrag={panOnDrag}
				selectionOnDrag={selectionOnDrag}
				panOnScroll={panOnScroll}
				zoomOnScroll={zoomOnScroll}
				multiSelectionKeyCode="Control"
			>
				<Background gap={15} size={1} color="var(--vscode-panel-border)" />
				<Controls />
				{showMinimap && (
					<MiniMap
						nodeColor={nodeColor}
						maskColor="var(--vscode-widget-shadow)"
						style={{ backgroundColor: 'var(--vscode-editor-background)' }}
					/>
				)}
				<Panel position="top-right">
					<CanvasToolbar />
				</Panel>
			</ReactFlow>

			{/* Empty-state start menu overlay */}
			<StartMenu onAddFirstNode={handleAddNode} />

			{/* Delete confirmation dialog */}
			<ConfirmDialog
				open={!!pendingDelete}
				title="Delete node?"
				message={pendingDelete
					? pendingDelete.ids.length > 1
						? `Delete ${pendingDelete.ids.length} nodes? This will also remove their connections.`
						: `Delete "${pendingDelete.label}"? This will also remove its connections.`
					: ''}
				confirmLabel="Delete"
				cancelLabel="Cancel"
				onConfirm={confirmDelete}
				onCancel={() => setPendingDelete(null)}
			/>

			{/* v5a: right-click context menu (toggle breakpoint) */}
			{contextMenu && (
				<div
					className="wf-context-menu"
					style={{ top: contextMenu.y, left: contextMenu.x }}
					onClick={(e) => e.stopPropagation()}
				>
					<button
						className="wf-context-menu-item"
						onClick={handleToggleBreakpoint}
					>
						<span className="wf-context-menu-icon">●</span>
						{contextMenu.hasBreakpoint ? '取消断点' : '设断点'}
					</button>
				</div>
			)}
		</div>
	);
};
