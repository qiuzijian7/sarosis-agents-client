/*---------------------------------------------------------------------------------------------
 *  Workflow Editor Zustand Store
 *
 *  Manages ReactFlow nodes, edges, selection, and workflow metadata.
 *  Mirrors cc-wf-studio's workflow-store.ts but simplified for our use case.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
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

	// Actions
	setSelectedNode: (id: string | null) => void;
	addNode: (type: string, position: { x: number; y: number }) => void;
	removeNode: (id: string) => void;
	updateNodeData: (id: string, data: Record<string, unknown>) => void;
	toggleInteractionMode: () => void;
	toggleScrollMode: () => void;
	toggleEdgeAnimation: () => void;
	setMinimapMode: (mode: MinimapMode) => void;

	// Load / Serialize
	loadWorkflow: (wf: IStoredWorkflow) => void;
	toWorkflowData: () => { nodes: WorkflowGraphNode[]; connections: WorkflowGraphConnection[] };
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useWorkflowEditorStore = create<WorkflowEditorState>((set, get) => ({
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
		set({ edges: addEdge(connection, get().edges) });
	},

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

	updateNodeData: (id, data) => {
		set({
			nodes: get().nodes.map(n =>
				n.id === id ? { ...n, data: { ...n.data, ...data } } : n
			),
		});
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
					});
					prevId = stepId;
				}
			}
			nodes.push({ ...DEFAULT_END, position: { x: 250 + (wf.steps?.length || 0) * 180, y: 250 } });
			edges.push({
				id: `e-${prevId}-end`,
				source: prevId,
				target: 'end',
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

	toggleInteractionMode: () => set(state => ({ interactionMode: state.interactionMode === 'pan' ? 'select' : 'pan' })),
	toggleScrollMode: () => set(state => ({ scrollMode: state.scrollMode === 'classic' ? 'pan' : 'classic' })),
	toggleEdgeAnimation: () => set(state => ({ isEdgeAnimationEnabled: !state.isEdgeAnimationEnabled })),
	setMinimapMode: (mode: MinimapMode) => set({ minimapMode: mode }),
}));
