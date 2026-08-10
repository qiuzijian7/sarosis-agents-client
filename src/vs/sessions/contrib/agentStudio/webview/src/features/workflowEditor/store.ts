/*---------------------------------------------------------------------------------------------
 *  Workflow Editor Zustand Store
 *
 *  Manages workflow nodes, edges, selection, and workflow metadata.
 *  Mirrors cc-wf-studio's workflow-store.ts but simplified for our use case.
 *
 *  Time-travel: wrapped with zundo `temporal` middleware so nodes/edges/metadata
 *  changes can be undone/redone (Ctrl+Z / Ctrl+Shift+Z). Tracking is paused during
 *  node dragging so a drag results in a single undo step.
 *
 *  The canvas backend is LiteGraph (ComfyUI). The store keeps a framework-agnostic
 *  node/edge model (position/data/style only — no ReactFlow types) that the
 *  LiteGraph canvas two-way syncs with the graph.
 *
 *  Node categories: Basic Nodes (prompt, agent, skill, tool, task),
 *  Control Flow (ifElse, switch, askUser),
 *  Layout (group).
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { temporal } from 'zundo';
import type {
	IStoredWorkflow,
	WorkflowGraphNode,
	WorkflowGraphConnection,
} from '../../types/workflowStorage';
import type { WorkflowExecutionStatus, IWorkflowNodeExecutionState } from '../../types/workflowExecution';

// ─── Framework-agnostic node/edge model ────────────────────────────────────────

export interface WorkflowEditorNode {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: Record<string, unknown> & { label?: string };
	selected?: boolean;
	parentId?: string;
	style?: { width?: number; height?: number };
	zIndex?: number;
}

export interface WorkflowEditorEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
	type?: string;
	data?: Record<string, unknown>;
	animated?: boolean;
	selected?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let _nodeCounter = 0;
function uid(prefix: string): string {
	return `${prefix}-${Date.now()}-${++_nodeCounter}`;
}

const DEFAULT_START: WorkflowEditorNode = {
	id: 'start',
	type: 'start',
	position: { x: 80, y: 250 },
	data: { label: 'Start' },
};

const DEFAULT_END: WorkflowEditorNode = {
	id: 'end',
	type: 'end',
	position: { x: 600, y: 250 },
	data: { label: 'End' },
};

// ─── Node category ──────────────────────────────────────────────────────────

export type NodeCategory = 'basic' | 'controlFlow' | 'layout' | 'system';

export interface NodeTypeSelector {
	type: string;
	label: string;
	description: string;
	icon: string;
}

export const nodeCategories: Array<{ category: NodeCategory; label: string; items: NodeTypeSelector[] }> = [
	{
		category: 'system',
		label: 'System Nodes',
		items: [
			{ type: 'start',      label: 'Start',        description: 'Entry point of the workflow',          icon: '▶️' },
			{ type: 'end',        label: 'End',          description: 'Exit point of the workflow',           icon: '⏹️' },
		],
	},
	{
		category: 'basic',
		label: 'Basic Nodes',
		items: [
			{ type: 'prompt',     label: 'Prompt',      description: 'Template with variable substitution',  icon: '💬' },
			{ type: 'agent',      label: 'Agent',        description: 'Execute a specific agent',            icon: '🤖' },
			{ type: 'skill',      label: 'Skill',        description: 'Execute a skill',                     icon: '⚡' },
			{ type: 'tool',       label: 'Tool',         description: 'Execute a tool with parameters',      icon: '🔧' },
		],
	},
	{
		category: 'controlFlow',
		label: 'Control Flow',
		items: [
			{ type: 'ifElse',     label: 'If/Else',      description: 'Binary conditional (True/False)',     icon: '↔️' },
			{ type: 'switch',     label: 'Switch',        description: 'Multi-way branching (2-N cases)',     icon: '🔀' },
			{ type: 'askUser',    label: 'Ask User',      description: 'Branch based on user selection',     icon: '❓' },
		],
	},
	{
		category: 'layout',
		label: 'Layout',
		items: [
			{ type: 'group',      label: 'Group',         description: 'Visual grouping container',          icon: '▦' },
		],
	},
];

/** Flat list for PropertyPanel lookup & StartMenu quick buttons */
export const nodeTypeSelectors: NodeTypeSelector[] = nodeCategories.flatMap(c => c.items);

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

interface WorkflowEditorState {
	// Graph state (framework-agnostic; LiteGraph canvas syncs bidirectionally)
	nodes: WorkflowEditorNode[];
	edges: WorkflowEditorEdge[];
	selectedNodeId: string | null;

	// Workflow metadata
	workflowId: string;
	workflowName: string;
	workflowDescription: string;

	// v5a: workflow-level breakpoints (set of nodeIds, persisted via host)
	workflowBreakpoints: string[];

	// UI state
	isPropertyPanelOpen: boolean;

	// Default agent config for new agent nodes (inherited from workflow's bound agent)
	defaultAgentConfig: { agentId?: string; providerId?: string; modelId?: string };

	// Execution state (P3: execution status visualization)
	executionId: string | null;
	executionStatus: WorkflowExecutionStatus | null;
	currentNodeId: string | null;
	nodeExecutionStates: Record<string, IWorkflowNodeExecutionState>;
	breakpoints: string[];

	// Direct setters (batch operations / paste / LiteGraph sync)
	setNodes: (nodes: WorkflowEditorNode[]) => void;
	setEdges: (edges: WorkflowEditorEdge[]) => void;

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
	setDefaultAgentConfig: (config: { agentId?: string; providerId?: string; modelId?: string }) => void;

	// Execution state actions (P3)
	setExecutionState: (executionId: string | null, status: WorkflowExecutionStatus | null, currentNodeId: string | null, nodeStates: Record<string, IWorkflowNodeExecutionState>) => void;
	setBreakpoints: (breakpoints: string[]) => void;
	setWorkflowBreakpoints: (breakpoints: string[]) => void;
	toggleWorkflowBreakpoint: (nodeId: string) => void;
	clearExecutionState: () => void;

	// Validation
	validateWorkflow: () => WorkflowValidationResult;

	// Load / Serialize
	loadWorkflow: (wf: IStoredWorkflow) => void;
	clearWorkflow: () => void;
	toWorkflowData: () => { nodes: WorkflowGraphNode[]; connections: WorkflowGraphConnection[] };
}

// ─── Default data factories per node type ───────────────────────────────────

function defaultDataForType(type: string): Record<string, unknown> {
	const base: Record<string, unknown> = { label: '' };

	switch (type) {
		case 'prompt':
			return { ...base, label: '提示', prompt: '', variables: {} };
		case 'agent':
			return { ...base, label: 'Agent', agentId: '', agentConfig: { providerId: '', modelId: '' }, prompt: '{{input}}' };
		case 'skill':
			return { ...base, label: 'Skill', skillName: '', skillArgs: {} };
		case 'tool':
			return { ...base, label: 'Tool', toolName: '', toolParams: {} };
		case 'task':
			return { ...base, label: '任务', executorId: '', taskId: '' };
		case 'ifElse':
			return {
				...base, label: 'If/Else', evaluationTarget: '',
				branches: [
					{ id: uid('branch'), label: 'True', condition: '' },
					{ id: uid('branch'), label: 'False', condition: '' },
				],
			};
		case 'switch':
			return {
				...base, label: 'Switch', evaluationTarget: '',
				branches: [
					{ id: uid('branch'), label: 'Case 1', condition: '' },
					{ id: uid('branch'), label: 'Case 2', condition: '' },
					{ id: uid('branch'), label: 'Default', condition: '' },
				],
			};
		case 'condition':
			return {
				...base, label: 'Condition', condition: '',
				branches: [
					{ id: uid('branch'), label: 'True', condition: '' },
					{ id: uid('branch'), label: 'False', condition: '' },
				],
			};
		case 'loop':
			return { ...base, label: 'Loop', loopConfig: { items: '', itemVariable: 'item', maxIterations: 10 } };
		case 'parallel':
			return { ...base, label: 'Parallel', parallelSteps: [] };
		case 'askUser':
			return {
				...base, label: 'Ask User', questionText: 'Select an option',
				options: [
					{ label: 'Option 1', description: '' },
					{ label: 'Option 2', description: '' },
				],
				multiSelect: false, useAiSuggestions: false,
			};
		case 'group':
			return { ...base, label: 'Group', isCollapsed: false };
		default:
			return { ...base, label: type };
	}
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
			defaultAgentConfig: {},
			workflowBreakpoints: [],

			// Execution state (P3)
			executionId: null,
			executionStatus: null,
			currentNodeId: null,
			nodeExecutionStates: {},
			breakpoints: [],

			// ── Direct setters ──

			setNodes: (nodes) => set({ nodes }),
			setEdges: (edges) => set({ edges }),

			// ── Actions ──

			setSelectedNode: (id) => {
				set({ selectedNodeId: id, isPropertyPanelOpen: id !== null });
			},

			addNode: (type, position) => {
				const id = uid(type);
				const data = defaultDataForType(type);

				// Inherit default agent config from the workflow's bound agent
				if (type === 'agent') {
					const defCfg = get().defaultAgentConfig;
					if (defCfg.agentId) {
						data.agentId = defCfg.agentId;
					}
					if (defCfg.providerId || defCfg.modelId) {
						data.agentConfig = {
							providerId: (defCfg.providerId || '') as string,
							modelId: (defCfg.modelId || '') as string,
						};
					}
				}

				// Group nodes need a default size
				const style = type === 'group' ? { width: 400, height: 300 } : undefined;
				const zIndex = type === 'group' ? -1001 : undefined;

				const newNode: WorkflowEditorNode = { id, type, position, data, ...(style ? { style } : {}), ...(zIndex !== undefined ? { zIndex } : {}) };
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
				const clone: WorkflowEditorNode = {
					...source,
					id: newId,
					position: { x: source.position.x + 40, y: source.position.y + 40 },
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
			setDefaultAgentConfig: (config) => set({ defaultAgentConfig: config }),

			// ── Execution state actions (P3) ──

			setExecutionState: (executionId, status, currentNodeId, nodeStates) => set({
				executionId,
				executionStatus: status,
				currentNodeId,
				nodeExecutionStates: nodeStates,
			}),

			setBreakpoints: (breakpoints) => set({ breakpoints }),

			// v5a: workflow-level breakpoints
			setWorkflowBreakpoints: (breakpoints) => set({ workflowBreakpoints: breakpoints }),
			toggleWorkflowBreakpoint: (nodeId) => set(state => {
				const has = state.workflowBreakpoints.includes(nodeId);
				return {
					workflowBreakpoints: has
						? state.workflowBreakpoints.filter(id => id !== nodeId)
						: [...state.workflowBreakpoints, nodeId],
				};
			}),

			clearExecutionState: () => set({
				executionId: null,
				executionStatus: null,
				currentNodeId: null,
				nodeExecutionStates: {},
				breakpoints: [],
			}),

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

				for (const n of nodes) {
					const inCount = incoming.get(n.id) ?? 0;
					const outCount = outgoing.get(n.id) ?? 0;
					// Group nodes don't need connections
					if (n.type === 'group') { continue; }
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

				// Cycle detection
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

				const nodes: WorkflowEditorNode[] = [];
				const edges: WorkflowEditorEdge[] = [];
				// v5a: workflow-level breakpoints loaded from the host JSON
				const breakpoints = new Set<string>(wf.breakpoints ?? []);

				if (wf.nodes && wf.nodes.length > 0) {
					for (const gn of wf.nodes) {
						nodes.push({
							id: gn.id,
							type: gn.type,
							position: gn.position,
							data: {
								...gn.data,
								label: gn.name,
								// v5a: mark breakpoint in node data so the renderer can show indicator
								hasBreakpoint: breakpoints.has(gn.id),
							},
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
									branches: step.type === 'condition' || step.type === 'ifElse'
										? [{ id: uid('branch'), label: 'True', condition: step.condition || '' },
										   { id: uid('branch'), label: 'False', condition: '' }]
										: step.type === 'switch'
											? [{ id: uid('branch'), label: 'Case 1', condition: '' },
											   { id: uid('branch'), label: 'Default', condition: '', isDefault: true }]
											: undefined,
									parallelSteps: step.parallelSteps,
									loopConfig: step.loopConfig,
								},
							});
							edges.push({
								id: `e-${prevId}-${stepId}`,
								source: prevId,
								target: stepId,
								type: 'default',
							});
							prevId = stepId;
						}
					}
					nodes.push({ ...DEFAULT_END, position: { x: 250 + (wf.steps?.length || 0) * 180, y: 250 } });
					edges.push({
						id: `e-${prevId}-end`,
						source: prevId,
						target: 'end',
						type: 'default',
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
							type: 'default',
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
					workflowBreakpoints: Array.from(breakpoints),
				});
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
			limit: 50,
			partialize: (state) => ({
				nodes: state.nodes,
				edges: state.edges,
				workflowName: state.workflowName,
				workflowDescription: state.workflowDescription,
			}),
			equality: (a, b) => JSON.stringify(a) === JSON.stringify(b),
		}
	)
);

// ─── Temporal helpers ─────────────────────────────────────────────────────────

export function undo(): void {
	useWorkflowEditorStore.temporal.getState().undo();
}

export function redo(): void {
	useWorkflowEditorStore.temporal.getState().redo();
}

export function pauseTracking(): void {
	useWorkflowEditorStore.temporal.getState().pause();
}

export function resumeTracking(): void {
	useWorkflowEditorStore.temporal.getState().resume();
}
