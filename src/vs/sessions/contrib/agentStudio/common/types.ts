/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const enum EmployeeStatus {
	Idle = 'idle',
	Working = 'working',
	Thinking = 'thinking',
	Error = 'error',
	Offline = 'offline',
}

export const enum ConnectionType {
	Subagent = 'subagent',
	Collaboration = 'collaboration',
	DataFlow = 'data-flow',
}

export const enum DelegationStatus {
	Pending = 'pending',
	Running = 'running',
	Done = 'done',
	Error = 'error',
	Cancelled = 'cancelled',
}

export interface Employee {
	readonly id: string;
	name: string;
	role: string;
	email?: string;
	avatar?: string;
	presetId?: string;
	model?: string;
	customPrompt?: string;
	skills?: EmployeeSkill[];
	status: EmployeeStatus;
	teamId?: string;
	workspaceId?: string;
	position?: { x: number; y: number };
	tokenUsage?: number;
	createdAt: string;
	updatedAt: string;
}

export interface EmployeeSkill {
	readonly id: string;
	name: string;
	enabled: boolean;
	description?: string;
}

export interface Workspace {
	readonly id: string;
	name: string;
	description?: string;
	path?: string;
	employees: string[]; // employee IDs
	connections: Connection[];
	layout?: WorkspaceLayout;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceLayout {
	nodes: WorkspaceNode[];
	edges: WorkspaceEdge[];
	viewport?: { x: number; y: number; zoom: number };
}

export interface WorkspaceNode {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: Record<string, unknown>;
}

export interface WorkspaceEdge {
	id: string;
	source: string;
	target: string;
	type?: string;
	data?: Record<string, unknown>;
}

export interface Connection {
	readonly id: string;
	sourceId: string;
	targetId: string;
	type: ConnectionType;
	label?: string;
}

export interface Delegation {
	readonly id: string;
	title: string;
	description?: string;
	assigneeId: string;
	assignerId?: string;
	workspaceId: string;
	status: DelegationStatus;
	parentTaskId?: string;
	dependencies?: string[];
	result?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface ChatMessage {
	readonly id: string;
	role: 'user' | 'assistant' | 'tool' | 'system';
	content: string;
	employeeId: string;
	sessionId?: string;
	toolCalls?: ToolCall[];
	thinking?: string;
	timestamp: string;
	tokenUsage?: { input: number; output: number; total: number };
}

export interface ToolCall {
	readonly id: string;
	name: string;
	arguments: string;
	result?: string;
	status?: 'running' | 'done' | 'error';
}

export interface AgentStudioSession {
	readonly id: string;
	name: string;
	workspaceId: string;
	activeEmployeeId?: string;
	createdAt: string;
	updatedAt: string;
	archived?: boolean;
}

// ─── Task Board ─────────────────────────────────────────────────────────────────

export const enum TaskBoardStatus {
	Todo = 'todo',
	Running = 'running',
	Done = 'done',
	Cancelled = 'cancelled',
	Archived = 'archived',
}

export const enum TaskSource {
	Manual = 'manual',
	Delegation = 'delegation',
}

export interface TaskBoardRecord {
	readonly id: string;
	title: string;
	description?: string;
	status: TaskBoardStatus;
	source: TaskSource;
	sourceId?: string; // delegation ID if source=delegation
	assigneeId?: string;
	assigneeName?: string;
	workspaceId: string;
	priority?: 'low' | 'medium' | 'high';
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}
