/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Communication protocol between Host (Extension Host) and WebView (React App).
 * All messages are serialized as JSON via postMessage.
 */

// ─── Message Types ──────────────────────────────────────────────────────────────

export type MessageDirection = 'toHost' | 'toWebview';
export const MessageDirection = {
	ToHost: 'toHost' as const,
	ToWebview: 'toWebview' as const,
};

// Request types (WebView → Host)
export type RequestType =
	| 'employees.list'
	| 'employees.get'
	| 'employees.create'
	| 'employees.update'
	| 'employees.delete'
	| 'employees.selected'
	| 'workspace.list'
	| 'workspace.get'
	| 'workspace.create'
	| 'workspace.delete'
	| 'workspace.update'
	| 'workspace.updateLayout'
	| 'workspace.connections.list'
	| 'workspace.connections.add'
	| 'workspace.connections.remove'
	| 'chat.send'
	| 'chat.history'
	| 'chat.clear'
	| 'chat.cancel'
	| 'delegation.list'
	| 'delegation.get'
	| 'delegation.create'
	| 'delegation.update'
	| 'delegation.delete'
	| 'delegation.autoPlan'
	| 'taskBoard.list'
	| 'taskBoard.create'
	| 'taskBoard.update'
	| 'taskBoard.delete'
	| 'taskBoard.archive'
	| 'session.list'
	| 'session.get'
	| 'session.create'
	| 'session.delete'
	| 'providers.list'
	| 'providers.select'
	| 'providers.openSettings';

// Event types (Host → WebView, unsolicited)
export type EventType =
	| 'chat.stream.delta'
	| 'chat.stream.complete'
	| 'chat.stream.error'
	| 'employee.selected'
	| 'employees.changed'
	| 'workspace.changed'
	| 'workspace.activeChanged'
	| 'delegations.changed'
	| 'taskBoard.changed'
	| 'session.activated'
	| 'theme.changed'
	| 'providers.changed';

// ─── Message Interfaces ─────────────────────────────────────────────────────────

export interface IRequestMessage<T = unknown> {
	readonly id: string;
	readonly direction: 'toHost';
	readonly type: RequestType;
	readonly payload: T;
}

export interface IResponseMessage<T = unknown> {
	readonly id: string;
	readonly direction: 'toWebview';
	readonly type: `${RequestType}.response`;
	readonly data?: T;
	readonly error?: IProtocolError;
}

export interface IEventMessage<T = unknown> {
	readonly direction: 'toWebview';
	readonly type: EventType;
	readonly data: T;
}

export interface IProtocolError {
	readonly code: string;
	readonly message: string;
}

// ─── Stream Event Payloads ──────────────────────────────────────────────────────

export interface IChatStreamDeltaPayload {
	readonly employeeId: string;
	readonly sessionId: string;
	readonly chunks: IChatStreamChunk[];
}

export interface IChatStreamChunk {
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'error' | 'done';
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export interface IChatStreamCompletePayload {
	readonly employeeId: string;
	readonly sessionId: string;
	readonly message: unknown; // ChatMessage
}

export interface IChatStreamErrorPayload {
	readonly employeeId: string;
	readonly sessionId: string;
	readonly error: string;
}

// ─── Request Payloads ───────────────────────────────────────────────────────────

export interface IChatSendPayload {
	readonly employeeId: string;
	readonly message: string;
	readonly model?: string;
	readonly systemPrompt?: string;
	readonly temperature?: number;
	readonly workspaceId?: string;
}

export interface IEmployeeCreatePayload {
	readonly name: string;
	readonly role: string;
	readonly email?: string;
	readonly presetId?: string;
	readonly model?: string;
	readonly customPrompt?: string;
	readonly workspaceId?: string;
}

export interface IEmployeeUpdatePayload {
	readonly id: string;
	readonly data: Record<string, unknown>;
}

export interface IWorkspaceLayoutPayload {
	readonly workspaceId: string;
	readonly nodes: unknown[];
	readonly edges: unknown[];
	readonly viewport?: { x: number; y: number; zoom: number };
}

export interface IConnectionPayload {
	readonly workspaceId: string;
	readonly sourceId: string;
	readonly targetId: string;
	readonly type: string;
	readonly label?: string;
}

export interface IAutoPlanPayload {
	readonly goal: string;
	readonly workspaceId: string;
}

// ─── Union types for type-safe dispatch ─────────────────────────────────────────

export type HostMessage = IRequestMessage;
export type WebviewMessage = IResponseMessage | IEventMessage;

// ─── Provider Payloads ──────────────────────────────────────────────────────

export interface IProviderInfo {
	readonly id: string;
	readonly name: string;
	readonly authStatus: string; // 'Authenticated' | 'NotConfigured' | 'Failed' | 'Validating'
	readonly supportsAgents?: boolean;
	readonly models: IProviderModelInfo[];
	readonly agents?: IProviderAgentInfo[];
}

export interface IProviderModelInfo {
	readonly id: string;
	readonly name: string;
}

export interface IProviderAgentInfo {
	readonly id: string;
	readonly name: string;
	readonly models?: string[];
}

export interface IProviderSelectPayload {
	readonly providerId: string;
	readonly modelId: string;
	readonly agentId?: string;
}
