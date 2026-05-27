/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Communication protocol between Host (Extension Host) and WebView (React App).
 * All messages are serialized as JSON via postMessage.
 */

// ─── Message Types ──────────────────────────────────────────────────────────────

/** Maximum nesting depth for agent-to-agent invocations (prevents infinite recursion) */
export const MAX_AGENT_NESTING_DEPTH = 5;

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
	| 'workspace.createWithWorktree'
	| 'workspace.assignWorktree'
	| 'workspace.resetWorktree'
	| 'workspace.removeWorktree'
	| 'workspace.delete'
	| 'workspace.update'
	| 'workspace.updateLayout'
	| 'workspace.setActive'
	| 'workspace.getActive'
	| 'workspace.connections.list'
	| 'workspace.connections.add'
	| 'workspace.connections.remove'
	| 'chat.send'
	| 'chat.history'
	| 'chat.clear'
	| 'chat.cancel'
	| 'chat.activeSessionChanged'  // webview tells host which (employeeId,agentSessionId) is currently visible
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
	| 'taskBoard.openOverview'
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
	| 'orchestration.approveWithoutExecute'
	| 'orchestration.reject'
	| 'orchestration.getPlan'
	| 'orchestration.listPlans'
	| 'orchestration.updatePlan'
	| 'orchestration.taskAction'
	| 'orchestration.approveTask'
	| 'orchestration.rejectTask'
	| 'orchestration.commentTask'
	| 'orchestration.blockTask'
	| 'orchestration.unblockTask'
	| 'confightml.event'  // legacy: redirected to configmd.event
	| 'configmd.getResource'      // resolve { md, html, parserScript, stylesContent }
	| 'configmd.readSource'       // read raw MD content
	| 'configmd.writeSource'      // overwrite MD content (from MD editor)
	| 'configmd.applyPatch'       // apply structured patch (from HTML view)
	| 'configmd.renderHtml'       // (re)render HTML from current MD
	| 'configmd.event'            // forward HTML event to agent/model
	| 'configmd.chatSend'         // send message to model (capability: chat.send)
	| 'configmd.chatHistory'      // read chat history
	| 'configmd.notify'           // show notification
	| 'configmd.uploadParser'     // upload custom MD→HTML parser script
	| 'configmd.uploadStyles'     // upload custom CSS for preview
	| 'configmd.removeParser'     // restore built-in parser
	| 'configmd.getInfo'          // get parser/styles info
	| 'configmd.previewToFile'    // render & write a standalone .preview.html file
	| 'files.open'                // open a file in the host editor as text
	| 'files.openHtmlPreview'     // open an HTML file as a rendered webview preview
	| 'files.openUntitledText'    // open an in-memory text buffer as an untitled editor
	| 'files.applyCode'           // apply code content to a file (Void-inspired Apply Code Blocks)
	| 'chat.jumpToCheckpoint'     // navigate to a checkpoint (Void-inspired time-travel)
	| 'chat.toolApprove'          // approve/reject a tool call (Void-inspired ToolApproval)
	| 'skills.list';              // list all registered skills

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
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'error' | 'done' | 'content_replace' | 'subagent_start' | 'subagent_progress' | 'subagent_end';
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	/** Sub-agent invocation ID for grouping sub-agent deltas */
	readonly subAgentId?: string;
	/** Sub-agent metadata (type, task, parent) — sent with subagent_start */
	readonly subAgentMeta?: {
		readonly type: 'explore' | 'general' | 'scout';
		readonly task: string;
		readonly parentAgentId?: string;
	};
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
	/**
	 * Current nesting depth of agent invocations.
	 * 0 = top-level, 1 = invoked by another agent, etc.
	 * The host enforces a max depth limit (default: 5).
	 */
	readonly nestingDepth?: number;
	/**
	 * ID of the parent agent that invoked this agent (if nestingDepth > 0).
	 */
	readonly parentAgentId?: string;
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
export type OrchestrationTaskAction = 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'comment' | 'block' | 'unblock';

export interface IOrchestrationTaskActionPayload {
	readonly planId: string;
	readonly taskId: string;
	readonly action: OrchestrationTaskAction;
}

// ─── Human-in-the-Loop Payloads ─────────────────────────────────────

export interface IOrchestrationApproveTaskPayload {
	readonly planId: string;
	readonly taskId: string;
	readonly comment?: string;
}

export interface IOrchestrationRejectTaskPayload {
	readonly planId: string;
	readonly taskId: string;
	readonly comment?: string;
}

export interface IOrchestrationCommentTaskPayload {
	readonly planId: string;
	readonly taskId: string;
	readonly comment: string;
}

export interface IOrchestrationBlockTaskPayload {
	readonly planId: string;
	readonly taskId: string;
	readonly reason?: string;
}

export interface IOrchestrationUnblockTaskPayload {
	readonly planId: string;
	readonly taskId: string;
}

export interface ITaskBoardOpenOverviewPayload {
	/** Task title to highlight in the task board (matches TaskBoardRecord.title) */
	readonly taskTitle: string;
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

export interface IConfigMdUploadParserPayload {
	readonly employeeId: string;
	readonly content: string;
	readonly fileName?: string;
}

export interface IConfigMdUploadStylesPayload {
	readonly employeeId: string;
	readonly content: string;
	readonly fileName?: string;
}

export interface IConfigMdRemoveParserPayload {
	readonly employeeId: string;
}

export interface IConfigMdInfoPayload {
	readonly employeeId: string;
}

export interface IConfigMdInfo {
	readonly parserSource: 'builtin' | 'custom';
	readonly parserPath?: string;
	readonly stylesPath?: string;
	readonly hasStyles: boolean;
}

// ─── Files Payloads ────────────────────────────────────────────────────────

/**
 * Open a file in the host's center editor area.
 * Either an absolute filesystem path or an employee-relative reference may be supplied.
 */
export interface IFileOpenPayload {
	/** Absolute filesystem path (preferred). */
	readonly path?: string;
	/** Alternative: employee id + relative kind, resolved by host. */
	readonly employeeId?: string;
	/** Which configMd-related file to open (only used when employeeId is present). */
	readonly kind?: 'configMd' | 'configMdParser' | 'configMdStyles';
	/** Whether to keep focus on the current view. Default: false. */
	readonly preserveFocus?: boolean;
	/** Whether to open as a pinned (non-preview) editor. Default: false. */
	readonly pinned?: boolean;
	/** Line number to scroll to after opening (1-based). */
	readonly lineNumber?: number;
	/**
	 * Optional workspace context captured at the moment the preview is
	 * opened. Forwarded into the HTML preview's imgui SDK so form submits
	 * carry the right (workspace, session) tuple even after the chat panel
	 * changes selection. Only used by `files.openHtmlPreview`.
	 */
	readonly workspaceId?: string;
	/**
	 * Optional Fork (workspace) session id captured alongside `workspaceId`.
	 * Lets the host re-enter the Fork-mode lazy-create branch when an imgui
	 * submit arrives but no `agentSessionId` exists yet for that Fork.
	 */
	readonly workspaceSessionId?: string;
	/** Optional agent session id captured alongside `workspaceId`. */
	readonly agentSessionId?: string;
}

/**
 * Payload for `files.openUntitledText` — opens an in-memory text buffer as an
 * untitled editor in the host's center editor area. Unlike `files.open`,
 * nothing is read from / written to disk, and there is no risk of
 * overwriting an existing agent file.
 *
 * Used by the ConfigMD "Demo" button, which loads a sample DSL into a
 * throwaway editor for the user to inspect / copy from, rather than
 * mutating the agent's real config.md.
 */
export interface IFileOpenUntitledTextPayload {
	/** Required: the text content to display. */
	readonly contents: string;
	/**
	 * Optional language id used by the editor for syntax highlighting
	 * (e.g. "markdown", "plaintext", "json"). Defaults to "plaintext".
	 */
	readonly languageId?: string;
	/**
	 * Optional human-readable title shown on the tab. The host will
	 * synthesise a unique untitled URI; the title is purely cosmetic.
	 */
	readonly title?: string;
	/** Whether to keep focus on the current view. Default: false. */
	readonly preserveFocus?: boolean;
	/** Whether to open as a pinned (non-preview) editor. Default: true. */
	readonly pinned?: boolean;
}

/**
 * Payload for `files.applyCode` — applies code content to a file.
 * (Void-inspired Apply Code Blocks: one-click apply from chat UI)
 */
export interface IFileApplyCodePayload {
	/** Absolute filesystem path of the target file. */
	readonly path: string;
	/** The code content to apply (replaces the file content). */
	readonly content: string;
	/** Optional: the tool call ID that generated this code (for tracking). */
	readonly toolCallId?: string;
}

/**
 * Payload for `chat.jumpToCheckpoint` — navigate to a checkpoint.
 * (Void-inspired time-travel navigation)
 */
export interface IChatJumpToCheckpointPayload {
	/** The checkpoint ID to jump to. */
	readonly checkpointId: string;
}

/**
 * Payload for `chat.toolApprove` — approve or reject a pending tool call.
 * (Void-inspired ToolApproval system)
 */
export interface IChatToolApprovePayload {
	/** The tool call ID to approve/reject. */
	readonly toolCallId: string;
	/** The approval decision. */
	readonly decision: 'allow_once' | 'allow_always' | 'deny';
}
