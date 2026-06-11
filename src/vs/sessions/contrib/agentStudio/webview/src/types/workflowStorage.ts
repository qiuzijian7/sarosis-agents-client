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
