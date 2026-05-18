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
	| 'employees.export'
	| 'employees.import'
	| 'employees.syncPositions'
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
	| 'providers.getSelection'
	| 'providers.getSelectionForEmployee'
	| 'providers.openSettings'
	| 'workspaceSession.list'
	| 'workspaceSession.get'
	| 'workspaceSession.create'
	| 'workspaceSession.delete'
	| 'workspaceSession.archive'
	| 'workspaceSession.switch'
	| 'workspaceSession.switchRoot'
	| 'workspaceSession.updateStatus'
	| 'agentSession.list'
	| 'agentSession.create'
	| 'agentSession.rename'
	| 'agentSession.delete'
	| 'agentSession.getActive'
	| 'orchestration.plan'
	| 'orchestration.approve'
	| 'orchestration.reject'
	| 'orchestration.getPlan'
	| 'orchestration.listPlans'
	| 'orchestration.taskAction'
	| 'confightml.event'  // legacy: redirected to configmd.event
	| 'configmd.getResource'      // resolve { md, html, parserScript, stylesContent }
	| 'configmd.readSource'       // read raw MD content
	| 'configmd.writeSource'      // overwrite MD content (from MD editor)
	| 'configmd.applyPatch'       // apply structured patch (from HTML view)
	| 'configmd.renderHtml'       // (re)render HTML from current MD
	| 'configmd.event'            // forward HTML event to agent/model
	| 'configmd.chatSend'         // send message to model (capability: chat.send)
	| 'configmd.chatHistory'      // read chat history
	| 'configmd.notify';          // show notification

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
	| 'providers.changed'
	| 'workspace.sessionCreated'
	| 'workspace.sessionChanged'
	| 'workspace.sessionUpdated'
	| 'workspace.modeChanged'
	| 'orchestration.planCreated'
	| 'orchestration.planUpdated'
	| 'orchestration.taskUpdated'
	| 'configmd.sourceChanged'    // MD content updated (file watcher / external edit)
	| 'configmd.htmlRendered'     // new HTML rendered (push to preview)
	| 'configmd.command'          // model-issued command for HTML view
	| 'configmd.message'          // model-issued message for HTML view
	| 'configmd.error';           // sync/render error

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
	/** Fork-scoped Agent session ID */
	readonly agentSessionId?: string;
}

export interface IEmployeeCreatePayload {
	readonly name: string;
	readonly role: string;
	readonly email?: string;
	readonly presetId?: string;
	readonly model?: string;
	readonly customPrompt?: string;
	readonly workspaceId?: string;
	/** Bootstrap templates for agent instance directory files (transient, not persisted) */
	readonly bootstrapTemplates?: {
		readonly agentsMd?: string;
		readonly soulMd?: string;
		readonly identityMd?: string;
		readonly toolsMd?: string;
		readonly memoryMd?: string;
	};
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

// ─── Import / Export Payloads ───────────────────────────────────────────────────

export interface IEmployeeExportPayload {
	readonly id: string;
}

export interface IEmployeeImportPayload {
	/** The full AgentExportData JSON object */
	readonly exportData: Record<string, unknown>;
	/** Target workspace to import into */
	readonly workspaceId?: string;
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
	/** The active employee whose agent.yaml should be updated with the selection */
	readonly employeeId?: string;
}

// ─── Workspace Session (Fork) Payloads ──────────────────────────────────────

export interface IWorkspaceSessionCreatePayload {
	readonly workspaceId: string;
	readonly name: string;
	readonly source: 'scheduled_task' | 'manual';
	readonly scheduledTaskId?: string;
	readonly idempotencyKey?: string;
}

export interface IWorkspaceSessionSwitchPayload {
	readonly sessionId: string;
}

export interface IWorkspaceSessionStatusPayload {
	readonly sessionId: string;
	readonly status: string;
	readonly error?: string;
}

// ─── Orchestration Payloads ─────────────────────────────────────────────────

export interface IOrchestrationPlanPayload {
	readonly goal: string;
	readonly workspaceId: string;
	/** The planner agent creating this plan (must have agentType='planner') */
	readonly plannerId: string;
}

export interface IOrchestrationApprovePayload {
	readonly planId: string;
}

export interface IOrchestrationRejectPayload {
	readonly planId: string;
}

export interface IOrchestrationGetPlanPayload {
	readonly planId: string;
}

export interface IOrchestrationListPlansPayload {
	readonly workspaceId?: string;
}

/** Actions a user can perform on a single orchestration task */
export type OrchestrationTaskAction = 'retry' | 'pause' | 'resume' | 'cancel';

export interface IOrchestrationTaskActionPayload {
	readonly planId: string;
	readonly taskId: string;
	readonly action: OrchestrationTaskAction;
}

// ─── ConfigMD Payloads ──────────────────────────────────────────────────────

export interface IConfigMdResourcePayload {
	readonly employeeId: string;
}

export interface IConfigMdReadSourcePayload {
	readonly employeeId: string;
}

export interface IConfigMdWriteSourcePayload {
	readonly employeeId: string;
	readonly markdown: string;
	/** Origin of the change to suppress echo loops */
	readonly origin?: 'editor' | 'html' | 'model' | 'external';
	/** Monotonic version supplied by client; rejected if stale (optimistic concurrency) */
	readonly baseVersion?: number;
}

/**
 * Patch operations on the canonical MD file.
 * - replace-anchor: replace the body of an `<!-- agent-state:NAME --> ... <!-- /agent-state:NAME -->` block
 * - replace-bind: replace inline `<!-- agent-bind:NAME -->X<!-- /agent-bind:NAME -->`
 * - append: append text at the end of the document
 * - prepend: prepend text at the beginning
 * - replace-section: replace a heading-anchored section by heading text
 * - replace-all: overwrite the whole file (last resort)
 */
export interface IConfigMdPatchOp {
	readonly op:
		| 'replace-anchor'
		| 'replace-bind'
		| 'append'
		| 'prepend'
		| 'replace-section'
		| 'replace-all';
	readonly anchor?: string;
	readonly heading?: string;
	readonly content: string;
}

export interface IConfigMdApplyPatchPayload {
	readonly employeeId: string;
	readonly patches: IConfigMdPatchOp[];
	readonly origin?: 'editor' | 'html' | 'model' | 'external';
	readonly baseVersion?: number;
}

export interface IConfigMdRenderHtmlPayload {
	readonly employeeId: string;
	readonly markdown?: string;  // optional override; defaults to current file
}

export interface IConfigMdEventPayload {
	readonly employeeId: string;
	readonly eventName: string;
	readonly payload?: unknown;
	readonly agentSessionId?: string;
}

export interface IConfigMdChatSendPayload {
	readonly employeeId: string;
	readonly message: string;
	readonly context?: string;
	readonly showInChat?: boolean;
	readonly agentSessionId?: string;
}

export interface IConfigMdNotifyPayload {
	readonly employeeId: string;
	readonly message: string;
	readonly level?: 'info' | 'success' | 'warning' | 'error';
}

// ─── ConfigMD Event Payloads (Host → WebView) ───────────────────────────────

export interface IConfigMdSourceChangedPayload {
	readonly employeeId: string;
	readonly markdown: string;
	readonly version: number;
	readonly origin: 'editor' | 'html' | 'model' | 'external';
}

export interface IConfigMdHtmlRenderedPayload {
	readonly employeeId: string;
	readonly html: string;
	readonly version: number;
	readonly stylesContent?: string;
}

export interface IConfigMdCommandPayload {
	readonly employeeId: string;
	readonly command: {
		readonly name: string;
		readonly params: Record<string, unknown>;
		readonly id: string;
	};
}
