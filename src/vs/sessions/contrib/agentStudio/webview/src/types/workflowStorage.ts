/*---------------------------------------------------------------------------------------------
 *  Webview-local mirror of host common/workflowStorage.ts type definitions.
 *  The host file lives at ../common/workflowStorage.ts but cannot be imported across
 *  the webview/host module boundary. Keep these in sync manually.
 *--------------------------------------------------------------------------------------------*/

export const enum WorkflowNodeType {
	Start = 'start',
	End = 'end',
	Task = 'task',
	Condition = 'condition',
	Parallel = 'parallel',
	Loop = 'loop',
	// New types — cc-wf-studio inspired
	Prompt = 'prompt',
	Agent = 'agent',
	Skill = 'skill',
	Tool = 'tool',
	IfElse = 'ifElse',
	Switch = 'switch',
	AskUser = 'askUser',
	Group = 'group',
	/** ComfyUI 兼容节点（LiteGraph 画布引入） */
	Comfy = 'comfy',
	/** ComfyTV 风格媒体 stage 节点 */
	ComfyStage = 'comfyStage',
}

export interface BranchDef {
	id: string;
	label: string;
	condition: string;
}

export interface AskUserOption {
	label: string;
	description?: string;
}

export interface WorkflowNodePosition {
	x: number;
	y: number;
}

export interface WorkflowNodeData {
	label?: string;
	taskId?: string;
	condition?: string;
	branches?: BranchDef[];
	parallelSteps?: string[];
	loopConfig?: { items: string; itemVariable: string; maxIterations?: number };
	executorId?: string;
	// Prompt node
	prompt?: string;
	variables?: Record<string, string>;
	// Agent node
	agentId?: string;
	agentConfig?: { providerId?: string; modelId?: string };
	// Skill node
	skillName?: string;
	skillArgs?: Record<string, string>;
	// Tool node
	toolName?: string;
	toolParams?: Record<string, string>;
	// IfElse / Switch
	evaluationTarget?: string;
	// AskUser
	questionText?: string;
	options?: AskUserOption[];
	multiSelect?: boolean;
	useAiSuggestions?: boolean;
	// Group
	isCollapsed?: boolean;
	[key: string]: unknown;
}

export interface WorkflowGraphNode {
	id: string;
	type: WorkflowNodeType;
	name: string;
	position: WorkflowNodePosition;
	data?: WorkflowNodeData;
	parentId?: string;
	style?: { width?: number; height?: number };
}

export interface WorkflowGraphConnection {
	id: string;
	from: string;
	to: string;
	fromPort?: string;
	toPort?: string;
	condition?: string;
}

export interface IStoredWorkflow {
	id: string;
	name: string;
	description?: string;
	presetId?: string;
	agentId?: string;
	workspaceId?: string;
	steps?: Array<{ id: string; type: string; [key: string]: unknown }>;
	nodes?: WorkflowGraphNode[];
	connections?: WorkflowGraphConnection[];
	createdAt?: string;
	updatedAt?: string;
	/** v5a: workflow-level breakpoints (node IDs). Persisted to the host JSON. */
	breakpoints?: string[];
	[key: string]: unknown;
}

// ─── 执行状态（2026-09-07 补定义）────────────────────────────────────────
// 原 `types/workflowExecution` 模块**已不存在**（仓库内零定义），但
// features/workflowEditor/store.ts 仍在导入 WorkflowExecutionStatus /
// IWorkflowNodeExecutionState → TS2307。此处按既有用法（executionStatus /
// nodeExecutionStates）补齐最小定义；字段保持可选 + 索引签名，避免对未知用途
// 施加过强约束（后续若还原真实形状，请替换为本定义）。
export type WorkflowExecutionStatus = 'idle' | 'running' | 'success' | 'error' | 'canceled';

export interface IWorkflowNodeExecutionState {
	status: WorkflowExecutionStatus;
	nodeId?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	[key: string]: unknown;
}
