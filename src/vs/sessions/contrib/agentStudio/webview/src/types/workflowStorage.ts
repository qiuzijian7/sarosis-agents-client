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
}

export interface WorkflowNodePosition {
	x: number;
	y: number;
}

export interface WorkflowNodeData {
	label?: string;
	taskId?: string;
	condition?: string;
	branches?: Array<{ id: string; label: string; condition: string }>;
	parallelSteps?: string[];
	loopConfig?: { items: string; itemVariable: string };
	executorId?: string;
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
	[key: string]: unknown;
}
