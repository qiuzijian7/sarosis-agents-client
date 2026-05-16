/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Shared Types for Agent Studio ---

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

/**
 * Portable export format for an agent instance.
 * Contains the employee metadata and all bootstrap/config files from the agent directory.
 * Used for import/export across workspaces.
 */
export interface AgentExportData {
	/** Export format version for forward compatibility */
	readonly version: 1;
	/** Timestamp of the export */
	readonly exportedAt: string;
	/** Employee record (sensitive fields like id/workspaceId stripped) */
	readonly employee: Omit<Employee, 'id' | 'workspaceId' | 'agentDir' | 'bootstrapTemplates' | 'status' | 'tokenUsage' | 'position'>;
	/** agent.yaml content (JSON object) */
	readonly agentConfig: Record<string, unknown>;
	/** Bootstrap file contents */
	readonly files: {
		readonly agentsMd?: string;
		readonly soulMd?: string;
		readonly identityMd?: string;
		readonly toolsMd?: string;
		readonly memoryMd?: string;
	};
}

/**
 * Bootstrap file templates for agent instance directory.
 * When creating an agent from a preset, these templates are used to populate
 * the Markdown bootstrap files (AGENTS.md, SOUL.md, etc.) with preset-specific content.
 */
export interface AgentBootstrapTemplates {
	/** AGENTS.md — Operational instructions and workspace rules */
	agentsMd?: string;
	/** SOUL.md — Core personality, values, and boundaries */
	soulMd?: string;
	/** IDENTITY.md — Identity record (name, emoji, notes) */
	identityMd?: string;
	/** TOOLS.md — Local environment tool notes */
	toolsMd?: string;
	/** MEMORY.md — Initial long-term memory */
	memoryMd?: string;
}

export interface Employee {
	readonly id: string;
	name: string;
	role: string;
	email?: string;
	avatar?: string;
	presetId?: string;
	model?: string;
	provider?: string;
	customPrompt?: string;
	skills?: EmployeeSkill[];
	status: EmployeeStatus;
	teamId?: string;
	workspaceId?: string;
	position?: { x: number; y: number };
	tokenUsage?: number;
	/** Path to the agent instance directory under .sarosisworkspace/agents/{slug}/ */
	agentDir?: string;
	/**
	 * Bootstrap templates from a preset, used when creating the agent instance directory.
	 * Not persisted to employees.json — only used during creation.
	 */
	bootstrapTemplates?: AgentBootstrapTemplates;
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

export class AgentStudioSession {
	readonly id: string;
	name: string;
	workspaceId: string;
	activeEmployeeId?: string;
	createdAt: string;
	updatedAt: string;
	archived?: boolean;

	constructor(data: {
		id: string;
		name: string;
		workspaceId: string;
		activeEmployeeId?: string;
		createdAt: string;
		updatedAt: string;
		archived?: boolean;
	}) {
		this.id = data.id;
		this.name = data.name;
		this.workspaceId = data.workspaceId;
		this.activeEmployeeId = data.activeEmployeeId;
		this.createdAt = data.createdAt;
		this.updatedAt = data.updatedAt;
		this.archived = data.archived;
	}
}

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
