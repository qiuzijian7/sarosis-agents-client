/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../platform/instantiation/common/instantiation.js';
import { Event } from '../../base/common/event.js';
import type { Employee, Workspace, Delegation, ChatMessage, AgentStudioSession, Connection, WorkspaceLayout, TaskBoardRecord, TaskBoardStatus } from './agentStudioTypes.js';

// ─── Agent Studio Service ───────────────────────────────────────────────────────

export const IAgentStudioService = createDecorator<IAgentStudioService>('agentStudioService');

export interface IAgentStudioService {
	readonly _serviceBrand: undefined;

	// Events
	readonly onDidChangeEmployees: Event<void>;
	readonly onDidChangeWorkspace: Event<string>;
	readonly onDidChangeSessions: Event<void>;
	readonly onDidSelectEmployee: Event<string | null>;

	// Employee selection
	fireSelectEmployee(employeeId: string | null): void;

	// Employees
	getEmployees(workspaceId?: string): Promise<Employee[]>;
	getEmployee(id: string): Promise<Employee | undefined>;
	createEmployee(data: Partial<Employee>): Promise<Employee>;
	updateEmployee(id: string, data: Partial<Employee>): Promise<Employee>;
	deleteEmployee(id: string): Promise<void>;

	// Workspaces
	getWorkspaces(): Promise<Workspace[]>;
	getWorkspace(id: string): Promise<Workspace | undefined>;
	createWorkspace(data: Partial<Workspace>): Promise<Workspace>;
	updateWorkspace(id: string, data: Partial<Workspace>): Promise<Workspace>;
	deleteWorkspace(id: string): Promise<void>;
	updateWorkspaceLayout(id: string, layout: WorkspaceLayout): Promise<void>;

	// Connections
	getConnections(workspaceId: string): Promise<Connection[]>;
	addConnection(workspaceId: string, connection: Omit<Connection, 'id'>): Promise<Connection>;
	removeConnection(workspaceId: string, connectionId: string): Promise<void>;

	// Sessions
	getSessions(): Promise<AgentStudioSession[]>;
	getSession(id: string): Promise<AgentStudioSession | undefined>;
	createSession(data: Partial<AgentStudioSession>): Promise<AgentStudioSession>;
	deleteSession(id: string): Promise<void>;
}

// ─── Agent Chat Service ─────────────────────────────────────────────────────────

export const IAgentChatService = createDecorator<IAgentChatService>('agentChatService');

export interface IChatStreamDelta {
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'tool_progress' | 'done' | 'error';
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly metadata?: Record<string, unknown>;
	readonly progress?: number;
	readonly stage?: string;
}

export interface IChatSendOptions {
	readonly model?: string;
	readonly systemPrompt?: string;
	readonly temperature?: number;
	readonly workspaceId?: string;
}

export interface IAgentChatService {
	readonly _serviceBrand: undefined;

	sendMessage(
		employeeId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage>;

	getHistory(employeeId: string, sessionId?: string): Promise<ChatMessage[]>;
	clearHistory(employeeId: string, sessionId?: string): Promise<void>;
	cancelStream(employeeId: string): void;
}

// ─── Agent Delegation Service ───────────────────────────────────────────────────

export const IAgentDelegationService = createDecorator<IAgentDelegationService>('agentDelegationService');

export interface IAutoPlanResult {
	readonly delegations: Delegation[];
	readonly summary: string;
}

export interface IAgentDelegationService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeDelegations: Event<void>;

	getDelegations(workspaceId?: string): Promise<Delegation[]>;
	getDelegation(id: string): Promise<Delegation | undefined>;
	createDelegation(data: Partial<Delegation>): Promise<Delegation>;
	updateDelegation(id: string, data: Partial<Delegation>): Promise<Delegation>;
	deleteDelegation(id: string): Promise<void>;

	// Auto-Plan
	executePlan(goal: string, workspaceId: string): Promise<IAutoPlanResult>;
}

// ─── Agent Task Board Service ───────────────────────────────────────────────────

export const IAgentTaskBoardService = createDecorator<IAgentTaskBoardService>('agentTaskBoardService');

export interface IAgentTaskBoardService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTaskBoard: Event<void>;

	getTasks(workspaceId?: string): Promise<TaskBoardRecord[]>;
	getTask(id: string): Promise<TaskBoardRecord | undefined>;
	createTask(data: Partial<TaskBoardRecord>): Promise<TaskBoardRecord>;
	updateTask(id: string, data: Partial<TaskBoardRecord>): Promise<TaskBoardRecord>;
	updateTaskStatus(id: string, status: TaskBoardStatus): Promise<TaskBoardRecord>;
	deleteTask(id: string): Promise<void>;
	archiveTask(id: string): Promise<TaskBoardRecord>;
}
