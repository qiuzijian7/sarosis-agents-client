/*---------------------------------------------------------------------------------------------
 *  Workflow Editor Zustand Store
 *
 *  Manages ReactFlow nodes, edges, selection, and workflow metadata.
 *  Mirrors cc-wf-studio's workflow-store.ts but simplified for our use case.
 *
 *  Time-travel: wrapped with zundo `temporal` middleware so nodes/edges/metadata
 *  changes can be undone/redone (Ctrl+Z / Ctrl+Shift+Z). Tracking is paused during
 *  node dragging so a drag results in a single undo step.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { temporal } from 'zundo';
import type { Node, Edge, OnNodesChange, OnEdgesChange, OnConnect } from '@xyflow/react';
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react';
import type {
	IStoredWorkflow,
	WorkflowGraphNode,
	WorkflowGraphConnection,
} from '../../types/workflowStorage';

// ─── Helpers ────────────────────────────────────────────────────────────────

let _nodeCounter = 0;
function uid(prefix: string): string {
	return `${prefix}-${Date.now()}-${++_nodeCounter}`;
}

const DEFAULT_START: Node = {
	id: 'start',
	type: 'start',
	position: { x: 80, y: 250 },
	data: { label: 'Start' },
};

const DEFAULT_END: Node = {
	id: 'end',
	type: 'end',
	position: { x: 600, y: 250 },
	data: { label: 'End' },
};

// ─── Selectors ───────────────────────────────────────────────────────────────

export const nodeTypeSelectors: Array<{ type: string; label: string; description: string; icon: string }> = [
	{ type: 'task', label: 'Task', description: 'A single task to execute', icon: '📋' },
	{ type: 'condition', label: 'Condition', description: 'Branch based on a condition', icon: '🔀' },
	{ type: 'parallel', label: 'Parallel', description: 'Run branches in parallel', icon: '⇉' },
	{ type: 'loop', label: 'Loop', description: 'Repeat over items', icon: '🔄' },
];

// ─── Validation ──────────────────────────────────────────────────────────────

export interface WorkflowValidationIssue {
	level: 'error' | 'warning';
	nodeId?: string;
	message: string;
}

export interface WorkflowValidationResult {
	valid: boolean;
	issues: WorkflowValidationIssue[];
}

// ─── Store Interface ─────────────────────────────────────────────────────────

export type InteractionMode = 'pan' | 'select';
export type ScrollMode = 'classic' | 'pan';
export type MinimapMode = 'hidden' | 'auto' | 'always';

interface WorkflowEditorState {
	// ReactFlow state
	nodes: Node[];
	edges: Edge[];
	selectedNodeId: string | null;

	// Workflow metadata
	workflowId: string;
	workflowName: string;
	workflowDescription: string;

	// UI state
	isPropertyPanelOpen: boolean;
	interactionMode: InteractionMode;
	scrollMode: ScrollMode;
	isEdgeAnimationEnabled: boolean;
	minimapMode: MinimapMode;

	// ReactFlow handlers
	onNodesChange: OnNodesChange;
	onEdgesChange: OnEdgesChange;
	onConnect: OnConnect;

	// Direct setters (batch operations / paste)
	setNodes: (nodes: Node[]) => void;
	setEdges: (edges: Edge[]) => void;

	// Actions
	setSelectedNode: (id: string | null) => void;
	addNode: (type: string, position: { x: number; y: number }) => void;
	removeNode: (id: string) => void;
	duplicateNode: (id: string) => string | null;
	deleteEdge: (id: string) => void;
	updateNodeData: (id: string, data: Record<string, unknown>) => void;

	// Metadata setters
	setWorkflowName: (name: string) => void;
	setWorkflowDescription: (desc: string) => void;

	// Interaction
	toggleInteractionMode: () => void;
	toggleScrollMode: () => void;
	toggleEdgeAnimation: () => void;
	setMinimapMode: (mode: MinimapMode) => void;

	// Validation
	validateWorkflow: () => WorkflowValidationResult;

	// Load / Serialize
	loadWorkflow: (wf: IStoredWorkflow) => void;
	clearWorkflow: () => void;
	toWorkflowData: () => { nodes: WorkflowGraphNode[]; connections: WorkflowGraphConnection[] };
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useWorkflowEditorStore = create<WorkflowEditorState>()(
	temporal(
		(set, get) => ({
			nodes: [DEFAULT_START, DEFAULT_END],
			edges: [],
			selectedNodeId: null,
			workflowId: '',
			workflowName: '',
			workflowDescription: '',
			isPropertyPanelOpen: false,
			interactionMode: 'pan' as InteractionMode,
			scrollMode: 'classic' as ScrollMode,
			isEdgeAnimationEnabled: true,
			minimapMode: 'auto' as MinimapMode,

			// ── ReactFlow handlers ──

			onNodesChange: (changes) => {
				set({ nodes: applyNodeChanges(changes, get().nodes) });
			},

			onEdgesChange: (changes) => {
				set({ edges: applyEdgeChanges(changes, get().edges) });
			},

			onConnect: (connection) => {
				set({ edges: addEdge({ ...connection, type: 'deletable' }, get().edges) });
			},

			// ── Direct setters ──

			setNodes: (nodes) => set({ nodes }),
			setEdges: (edges) => set({ edges }),

			// ── Actions ──

			setSelectedNode: (id) => {
				set({ selectedNodeId: id, isPropertyPanelOpen: id !== null });
			},

			addNode: (type, position) => {
				const id = uid(type);
				const data: Record<string, unknown> = { label: type.charAt(0).toUpperCase() + type.slice(1) };
				if (type === 'condition') {
					data.branches = [
						{ id: uid('branch'), label: 'True', condition: '' },
						{ id: uid('branch'), label: 'False', condition: '' },
					];
					data.condition = '';
				}
				if (type === 'task') {
					data.executorId = '';
					data.taskId = '';
				}
				if (type === 'loop') {
					data.loopConfig = { items: '', itemVariable: 'item' };
				}
				if (type === 'parallel') {
					data.parallelSteps = [];
				}

				const newNode: Node = { id, type, position, data };
				set({
					nodes: [...get().nodes, newNode],
					selectedNodeId: id,
					isPropertyPanelOpen: true,
				});
			},

			removeNode: (id) => {
				if (id === 'start' || id === 'end') { return; }
				set({
					nodes: get().nodes.filter(n => n.id !== id),
					edges: get().edges.filter(e => e.source !== id && e.target !== id),
					selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
					isPropertyPanelOpen: get().selectedNodeId === id ? false : get().isPropertyPanelOpen,
				});
			},

			duplicateNode: (id) => {
				if (id === 'start' || id === 'end') { return null; }
				const source = get().nodes.find(n => n.id === id);
				if (!source) { return null; }
				const newId = uid(source.type || 'node');
				const clone: Node = {
					...source,
					id: newId,
					position: { x: source.position.x + 40, y: source.position.y + 40 },
					// Deep-copy data so edits to the clone don't mutate the source
					data: JSON.parse(JSON.stringify(source.data ?? {})),
					selected: false,
				};
				set({
					nodes: [...get().nodes, clone],
					selectedNodeId: newId,
					isPropertyPanelOpen: true,
				});
				return newId;
			},

			deleteEdge: (id) => {
				set({ edges: get().edges.filter(e => e.id !== id) });
			},

			updateNodeData: (id, data) => {
				set({
					nodes: get().nodes.map(n =>
						n.id === id ? { ...n, data: { ...n.data, ...data } } : n
					),
				});
			},

			// ── Metadata setters ──

			setWorkflowName: (name) => set({ workflowName: name }),
			setWorkflowDescription: (desc) => set({ workflowDescription: desc }),

			// ── Interaction ──

			toggleInteractionMode: () => set(state => ({ interactionMode: state.interactionMode === 'pan' ? 'select' : 'pan' })),
			toggleScrollMode: () => set(state => ({ scrollMode: state.scrollMode === 'classic' ? 'pan' : 'classic' })),
			toggleEdgeAnimation: () => set(state => ({ isEdgeAnimationEnabled: !state.isEdgeAnimationEnabled })),
			setMinimapMode: (mode: MinimapMode) => set({ minimapMode: mode }),

			// ── Validation ──

			validateWorkflow: () => {
				const { nodes, edges } = get();
				const issues: WorkflowValidationIssue[] = [];

				const hasStart = nodes.some(n => n.type === 'start');
				const hasEnd = nodes.some(n => n.type === 'end');
				if (!hasStart) { issues.push({ level: 'error', message: 'Workflow is missing a Start node.' }); }
				if (!hasEnd) { issues.push({ level: 'error', message: 'Workflow is missing an End node.' }); }

				const incoming = new Map<string, number>();
				const outgoing = new Map<string, number>();
				for (const e of edges) {
					outgoing.set(e.source, (outgoing.get(e.source) ?? 0) + 1);
					incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
				}

				// Orphan / dangling node checks (excluding start/end special cases)
				for (const n of nodes) {
					const inCount = incoming.get(n.id) ?? 0;
					const outCount = outgoing.get(n.id) ?? 0;
					if (n.type === 'start') {
						if (outCount === 0) { issues.push({ level: 'warning', nodeId: n.id, message: 'Start node has no outgoing connection.' }); }
						continue;
					}
					if (n.type === 'end') {
						if (inCount === 0) { issues.push({ level: 'warning', nodeId: n.id, message: 'End node has no incoming connection.' }); }
						continue;
					}
					if (inCount === 0 && outCount === 0) {
						issues.push({ level: 'warning', nodeId: n.id, message: `Node "${(n.data?.label as string) || n.id}" is not connected to anything.` });
					} else if (inCount === 0) {
						issues.push({ level: 'warning', nodeId: n.id, message: `Node "${(n.data?.label as string) || n.id}" has no incoming connection.` });
					} else if (outCount === 0) {
						issues.push({ level: 'warning', nodeId: n.id, message: `Node "${(n.data?.label as string) || n.id}" has no outgoing connection.` });
					}
				}

				// Cycle detection (DFS over directed graph)
				const adj = new Map<string, string[]>();
				for (const e of edges) {
					const list = adj.get(e.source) ?? [];
					list.push(e.target);
					adj.set(e.source, list);
				}
				const WHITE = 0, GRAY = 1, BLACK = 2;
				const color = new Map<string, number>();
				nodes.forEach(n => color.set(n.id, WHITE));
				let cycleFound = false;
				const visit = (u: string): void => {
					color.set(u, GRAY);
					for (const v of adj.get(u) ?? []) {
						if (color.get(v) === GRAY) { cycleFound = true; return; }
						if (color.get(v) === WHITE) {
							visit(v);
							if (cycleFound) { return; }
						}
					}
					color.set(u, BLACK);
				};
				for (const n of nodes) {
					if (color.get(n.id) === WHITE) {
						visit(n.id);
						if (cycleFound) { break; }
					}
				}
				if (cycleFound) {
					issues.push({ level: 'error', message: 'Workflow contains a cycle (loops back on itself). Use a Loop node for iteration.' });
				}

				const valid = !issues.some(i => i.level === 'error');
				return { valid, issues };
			},

			// ── Load / Serialize ──

			loadWorkflow: (wf) => {
				if (!wf) { return; }

				const nodes: Node[] = [];
				const edges: Edge[] = [];

				if (wf.nodes && wf.nodes.length > 0) {
					for (const gn of wf.nodes) {
						nodes.push({
							id: gn.id,
							type: gn.type,
							position: gn.position,
							data: { ...gn.data, label: gn.name },
							...(gn.parentId && { parentId: gn.parentId }),
							...(gn.style && { style: gn.style }),
						});
					}
				} else {
					// Fallback: create from steps
					nodes.push(DEFAULT_START);
					let prevId = 'start';
					if (wf.steps && wf.steps.length > 0) {
						for (let i = 0; i < wf.steps.length; i++) {
							const step = wf.steps[i];
							const stepId = step.id || uid('task');
							nodes.push({
								id: stepId,
								type: step.type,
								position: { x: 250 + i * 180, y: 250 },
								data: {
									label: step.name,
									executorId: step.executorId,
									taskId: step.taskId,
									condition: step.condition,
									branches: step.type === 'condition'
										? [{ id: uid('branch'), label: 'True', condition: step.condition || '' },
										   { id: uid('branch'), label: 'False', condition: '' }]
										: undefined,
									parallelSteps: step.parallelSteps,
									loopConfig: step.loopConfig,
								},
							});
							edges.push({
								id: `e-${prevId}-${stepId}`,
								source: prevId,
								target: stepId,
								type: 'deletable',
							});
							prevId = stepId;
						}
					}
					nodes.push({ ...DEFAULT_END, position: { x: 250 + (wf.steps?.length || 0) * 180, y: 250 } });
					edges.push({
						id: `e-${prevId}-end`,
						source: prevId,
						target: 'end',
						type: 'deletable',
					});
				}

				if (wf.connections && wf.connections.length > 0) {
					for (const conn of wf.connections) {
						edges.push({
							id: conn.id,
							source: conn.from,
							target: conn.to,
							sourceHandle: conn.fromPort,
							targetHandle: conn.toPort,
							type: 'deletable',
							data: conn.condition ? { condition: conn.condition } : undefined,
						});
					}
				}

				set({
					nodes,
					edges,
					workflowId: wf.id,
					workflowName: wf.name,
					workflowDescription: wf.description || '',
					selectedNodeId: null,
					isPropertyPanelOpen: false,
				});
				// A fresh load should not be undoable back to the previous workflow.
				useWorkflowEditorStore.temporal.getState().clear();
			},

			clearWorkflow: () => {
				set({
					nodes: [DEFAULT_START, { ...DEFAULT_END }],
					edges: [],
					selectedNodeId: null,
					isPropertyPanelOpen: false,
				});
			},

			toWorkflowData: () => {
				const state = get();
				const graphNodes: WorkflowGraphNode[] = state.nodes.map(n => ({
					id: n.id,
					type: n.type as WorkflowGraphNode['type'],
					name: (n.data.label as string) || n.id,
					position: n.position,
					data: n.data as WorkflowGraphNode['data'],
					...(n.parentId && { parentId: n.parentId }),
					...(n.style && { style: n.style as { width?: number; height?: number } }),
				}));

				const connections: WorkflowGraphConnection[] = state.edges.map(e => ({
					id: e.id,
					from: e.source,
					to: e.target,
					fromPort: e.sourceHandle || undefined,
					toPort: e.targetHandle || undefined,
					condition: e.data?.condition as string | undefined,
				}));

				return { nodes: graphNodes, connections };
			},
		}),
		{
			// Only track graph + metadata in history. UI/selection state is excluded.
			limit: 50,
			partialize: (state) => ({
				nodes: state.nodes,
				edges: state.edges,
				workflowName: state.workflowName,
				workflowDescription: state.workflowDescription,
			}),
			// Avoid pushing duplicate history entries for no-op sets.
			equality: (a, b) => JSON.stringify(a) === JSON.stringify(b),
		}
	)
);

// ─── Temporal helpers ─────────────────────────────────────────────────────────

/** Undo the last tracked change. */
export function undo(): void {
	useWorkflowEditorStore.temporal.getState().undo();
}

/** Redo the last undone change. */
export function redo(): void {
	useWorkflowEditorStore.temporal.getState().redo();
}

/** Pause history tracking (e.g. during a drag gesture). */
export function pauseTracking(): void {
	useWorkflowEditorStore.temporal.getState().pause();
}

/** Resume history tracking and record the resulting state as one step. */
export function resumeTracking(): void {
	useWorkflowEditorStore.temporal.getState().resume();
}
