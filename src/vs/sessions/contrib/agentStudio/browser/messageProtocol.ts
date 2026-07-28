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
	| 'agents.list'
	| 'agents.presets'
	| 'agents.get'
	| 'agents.create'
	| 'agents.update'
	| 'agents.delete'
	| 'agents.selected'
	| 'agents.getLastSelected'
	| 'agents.openSettings'
	| 'workspace.list'
	| 'workspace.get'
	| 'workspace.create'
	| 'workspace.delete'
	| 'workspace.update'
	| 'workspace.updateLayout'
	| 'workspace.getActive'
	| 'workspace.setActive'
	| 'workspace.connections.list'
	| 'workspace.connections.add'
	| 'workspace.connections.remove'
	| 'chat.send'
	| 'chat.history'
	| 'chat.append'              // v6: webview commits a synthesized message (e.g. wf_run_* with subAgents) to host
	| 'chat.clear'
	| 'chat.cancel'
	| 'chat.activeSessionChanged'  // webview tells host which (agentId,agentSessionId) is currently visible
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
	| 'board.list'
	| 'board.create'
	| 'board.rename'
	| 'board.delete'
	| 'attachment.add'
	| 'attachment.remove'
	| 'attachment.read'
	| 'session.list'
	| 'session.get'
	| 'session.create'
	| 'session.delete'
	| 'providers.list'
	| 'providers.select'
	| 'providers.getSelection'
	| 'providers.getSelectionForAgent'
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
	| 'agentSession.fork'
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
	| 'confightml.event'            // forward HTML event to agent/model
	| 'confightml.getHtml'          // read agent's config.html content
	| 'confightml.writeHtml'        // write agent's config.html content
	| 'confightml.chatSend'         // send message to model (capability: chat.send)
	| 'confightml.notify'           // show notification
	| 'confightml.previewToFile'    // render & write a standalone .preview.html file
	| 'confightml.htmlGenerate'    // ConfigHtml: ask the confightml skill to generate full HTML
	| 'confightml.chatSendStream'  // send message with streaming delta callbacks
	| 'confightml.chatCancelStream'// cancel an active stream session
	| 'confightml.runTerminal'     // run a command (python/node/...) in integrated terminal
	| 'confightml.kvGet'          // read a key-value pair from agent data store
	| 'confightml.kvSet'          // write a key-value pair to agent data store
	| 'confightml.kvDelete'       // delete a key from agent data store
	| 'confightml.kvList'         // list keys with optional prefix
	| 'files.open'                // open a file in the host editor as text
	| 'files.openHtmlPreview'     // open an HTML file as a rendered webview preview
	| 'files.openUntitledText'    // open an in-memory text buffer as an untitled editor
	| 'files.applyCode'           // apply code content to a file (Void-inspired Apply Code Blocks)
	| 'chat.addCheckpoint'       // create a new checkpoint (Void-inspired time-travel)
	| 'chat.getCheckpoint'       // get checkpoint details
	| 'chat.listCheckpoints'     // list checkpoints for a session
	| 'chat.deleteCheckpoint'     // delete a checkpoint
	| 'chat.jumpToCheckpoint'     // navigate to a checkpoint (Void-inspired time-travel)
	| 'chat.openCheckpointDiff'   // open diff editor for a checkpoint file (WebView → Host)
	| 'chat.revertAllCheckpoints' // revert ALL checkpoints to earliest snapshots (撤销)
	| 'chat.keepAllCheckpoints' // delete ALL checkpoints from disk (保留)
	| 'chat.openAllCheckpointsDiff' // open multi-file diff for all touched files (查看变更)
	| 'chat.toolApprove'          // approve/reject a pending tool call
	| 'worktree.list'           // list git worktrees for a workspace
	| 'agent.worktree.switch'   // switch the active agent's binding to a different worktree path
	| 'memory.listL0'           // list L0 raw conversation turns for an agent (AgentMemory)
	| 'memory.listL1'           // list L1 distilled memories for an agent (AgentMemory)
	| 'memory.deleteL0'         // hard-delete L0 record(s) by id
	| 'memory.deleteL1'         // hard-delete L1 record(s) by id
	| 'skills.list'
	| 'workflow.get'
	| 'workflow.save'              // save workflow nodes+connections from webview editor
	| 'workflow.execute'           // execute workflow (WebView → Host)
	| 'workflow.pause'            // pause workflow execution (WebView → Host)
	| 'workflow.resume'           // resume workflow execution (WebView → Host)
	| 'workflow.cancel'           // cancel workflow execution (WebView → Host)
	| 'workflow.breakpoint.set'   // v5a: persist a breakpoint on a workflow node (WebView → Host)
	| 'workflow.breakpoint.clear' // v5a: clear a workflow-level breakpoint (WebView → Host)
	| 'workflow.breakpoint.get'   // v5a: fetch persisted breakpoints (WebView → Host)
	| 'workflow.list'            // v10: list all workflows (WebView → Host)
	| 'workflow.reorder'         // v19: reorder workflow list (WebView → Host)
	| 'workflow.open'            // v19: open a workflow in the editor (WebView → Host)
	| 'workflow.submitVariables'; // v6: submit pre-execution variable values (WebView → Host)

// Event types (Host → WebView, unsolicited)
export type EventType =
	| 'chat.stream.delta'
	| 'chat.stream.complete'
	| 'chat.stream.error'
	| 'chat.userMessageAppended'
	| 'agent.selected'
	| 'agents.changed'
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
	| 'agentSessions.changed'      // agent session list changed (create/rename/delete/update)
	| 'worktree.changed'          // git worktree list changed (create/remove) — refresh worktree dropdowns
	| 'agent.worktree.changed'    // active agent's binding worktree changed (switch) — refresh dropdowns + tool roots
	| 'confightml.htmlRendered'     // new HTML rendered (push to preview)
	| 'confightml.command'          // model-issued command for HTML view
	| 'confightml.error'           // sync/render error
	| 'confightml.chatStreamDelta'  // stream delta from agent response
	| 'confightml.chatStreamDone'   // stream complete (success or error)
	| 'chat.toolApprovalRequest'
	| 'chat.injectPrompt'        // host requests webview to inject a prompt into the chat (e.g. workflow run)
	| 'workflow.loaded'          // host sends workflow data to webview editor
	| 'workflow.saved'           // host confirms save to webview
	| 'workflow.stateApplied'    // host pushes AI-generated workflow state to webview editor
	| 'workflow.executionUpdate' // host pushes execution state updates to webview editor
	| 'workflow.executionTrace'; // P4: host pushes subagent trace (start/delta/end) to owner agent's chat

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
	readonly agentId: string;
		readonly sessionId: string;
	readonly chunks: IChatStreamChunk[];
}

export interface IChatStreamChunk {
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'error' | 'done' | 'content_replace' | 'usage' | 'phase_change' | 'context_compacted' | 'discard_prior_text' | 'memory_extracted' | 'memory_injected' | 'codebase_operation';
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	/**
	 * Stream phase — allows the Host to explicitly control phase transitions.
	 * When present on any chunk type, the WebView will set StreamState.phase
	 * to this value (overriding type-based inference).
	 * On `type: 'phase_change'`, this field is required.
	 *
	 * Phases: 'idle' | 'llm_streaming' | 'tool_executing' | 'awaiting_approval' | 'compressing' | 'error'
	 */
	readonly phase?: string;
	/**
	 * Host-side full text snapshot (Void-inspired fullTextSoFar).
	 * When present, WebView uses this instead of incremental content accumulation.
	 */
	readonly fullText?: string;
	/**
	 * Host-side full thinking snapshot.
	 * When present, WebView uses this instead of incremental thinking accumulation.
	 */
	readonly fullThinking?: string;
	/**
	 * Display name for tool call cards (e.g. "Read File" instead of "read_file").
	 * Set by the LLM via _meta.display_name or by AgentOS tool metadata.
	 */
	readonly displayName?: string;
	/**
	 * Render type hint for tool call cards (e.g. "ListItems", "RunTerminal", "CodeApply").
	 * Controls which renderer the ToolCallCard component uses.
	 */
	readonly renderType?: string;
	/**
	 * Whether the tool call card should be visible in the chat.
	 * When false, the tool is executed silently without showing a card.
	 * Default: true (undefined → true).
	 */
	readonly defaultShow?: boolean;
	/**
	 * Whether the tool was executed server-side (no local execution needed).
	 */
	readonly serverExecuted?: boolean;
	/**
	 * Success flag for tool_end chunks.
	 * true = tool completed successfully, false = tool failed.
	 */
	readonly success?: boolean;
	/**
	 * Character position in the text buffer where this tool call started.
	 * Used by InterleavedMarkdownRenderer to position tool cards inline.
	 */
	readonly textPosition?: number;
	/**
	 * KV Cache / token usage metrics (Anthropic Prompt Caching, OpenAI cached_tokens, …).
	 * Sent on `type: 'usage'` chunks; the webview accumulates these and renders
	 * them in the message footer as a "cache hit" badge.
	 */
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly cachedTokens?: number;
		readonly cacheWriteTokens?: number;
	};
	/**
	 * 上下文压缩后回传的"压缩后估算输入 token"（type === 'context_compacted' 时携带）。
	 * WebView 据此把圆环进度条基线立即下调，实现压缩后圆圈同步回落。
	 * 详见 common/providers.ts IChatStreamDelta.compactedInputTokens。
	 */
	readonly compactedInputTokens?: number;
	/** 上下文压缩详情（type === 'context_compacted' 时携带） */
	readonly compressionOriginalCount?: number;
	readonly compressionCompressedCount?: number;
	readonly compressionTokensSaved?: number;
	readonly compressionDurationMs?: number;
}

export interface IChatStreamCompletePayload {
	readonly agentId: string;
		readonly sessionId: string;
	readonly message: unknown; // ChatMessage
}

export interface IChatStreamErrorPayload {
	readonly agentId: string;
		readonly sessionId: string;
	readonly error: string;
}

// ─── Request Payloads ───────────────────────────────────────────────────────────

export interface IChatSendPayload {
	readonly agentId: string;
		readonly message: string;
	readonly model?: string;
	readonly systemPrompt?: string;
	readonly temperature?: number;
	readonly workspaceId?: string;
	/** Fork-scoped Agent session ID */
	readonly agentSessionId?: string;
	/** 用户上传的附件（图片/文件）— Void-inspired image/file upload */
	readonly attachments?: IChatAttachmentPayload[];
}

/**
 * 附件 payload — 跨 WebView→Host 序列化传输。
 * 与 common/providers.ts 的 IChatAttachment 对齐，但为纯 JSON 可序列化结构。
 */
export interface IChatAttachmentPayload {
	readonly id: string;
	readonly type: 'image' | 'file';
	readonly name: string;
	readonly mimeType: string;
	/** base64 编码内容（图片和二进制文件）或原文（文本文件） */
	readonly data: string;
	readonly size: number;
	readonly isPasted?: boolean;
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
	/** Agent ID identifying which agent's selection target. */
	readonly agentId?: string;
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
	/** The agent creating this plan (any agent can orchestrate). */
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

// ─── ConfigHtml Payloads ──────────────────────────────────────────────────────

export interface IConfigHtmlGetHtmlPayload {
	readonly agentId: string;
}

export interface IConfigHtmlWriteHtmlPayload {
	readonly agentId: string;
	readonly html: string;
	/** Origin of the change to suppress echo loops */
	readonly origin?: 'editor' | 'html' | 'model' | 'external';
	/** Monotonic version supplied by client; rejected if stale (optimistic concurrency) */
	readonly baseVersion?: number;
}

export interface IConfigHtmlEventPayload {
	readonly agentId: string;
	readonly eventName: string;
	readonly payload?: unknown;
	readonly agentSessionId?: string;
}

export interface IConfigHtmlChatSendPayload {
	readonly agentId: string;
	readonly message: string;
	readonly context?: string;
	readonly showInChat?: boolean;
	readonly agentSessionId?: string;
}

export interface IConfigHtmlHtmlGeneratePayload {
	readonly agentId: string;
	readonly message: string;
	/** Current HTML in the editor (so the model can do incremental edits). */
	readonly currentHtml?: string;
	readonly model?: string;
}

export interface IConfigHtmlNotifyPayload {
	readonly agentId: string;
	readonly message: string;
	readonly level?: 'info' | 'success' | 'warning' | 'error';
}

// ─── ConfigHtml Event Payloads (Host → WebView) ───────────────────────────────

export interface IConfigHtmlHtmlRenderedPayload {
	readonly agentId: string;
	readonly html: string;
	readonly version: number;
	readonly stylesContent?: string;
}

export interface IConfigHtmlCommandPayload {
	readonly agentId: string;
	readonly command: {
		readonly name: string;
		readonly params: Record<string, unknown>;
		readonly id: string;
	};
}

// ─── ConfigHtml Stream Payloads ────────────────────────────────────────────

export interface IConfigHtmlChatSendStreamPayload {
	readonly requestId: string;
	readonly agentId: string;
	readonly message: string;
	readonly agentSessionId?: string;
}

export interface IConfigHtmlChatCancelStreamPayload {
	readonly requestId: string;
	readonly agentId: string;
}

export interface IConfigHtmlRunTerminalPayload {
	readonly agentId: string;
	readonly command: string;
	readonly args: string[];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
}

export interface IConfigHtmlKvGetPayload {
	readonly agentId: string;
	readonly key: string;
}

export interface IConfigHtmlKvSetPayload {
	readonly agentId: string;
	readonly key: string;
	readonly value: unknown;
}

export interface IConfigHtmlKvDeletePayload {
	readonly agentId: string;
	readonly key: string;
}

export interface IConfigHtmlKvListPayload {
	readonly agentId: string;
	readonly prefix?: string;
}

export interface IConfigHtmlChatStreamDeltaPayload {
	readonly requestId: string;
	readonly agentId: string;
	readonly delta: {
		readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_end' | 'done';
		readonly content?: string;
		readonly fullText?: string;
		readonly toolName?: string;
		readonly toolArgs?: string;
		readonly toolResult?: string;
	};
}

export interface IConfigHtmlChatStreamDonePayload {
	readonly requestId: string;
	readonly agentId: string;
	readonly ok: boolean;
	readonly fullText?: string;
	readonly error?: string;
}

// ─── Files Payloads ────────────────────────────────────────────────────────

/**
 * Open a file in the host's center editor area.
 * Either an absolute filesystem path or an agent-relative reference may be supplied.
 */
export interface IFileOpenPayload {
	/** Absolute filesystem path (preferred). */
	readonly path?: string;
	/** Alternative: agent id + relative kind, resolved by host. */
		readonly agentId?: string;
	/** Which config file to open (only used when agentId is present). */
	readonly kind?: 'configHtml';
	/** Whether to keep focus on the current view. Default: false. */
	readonly preserveFocus?: boolean;
	/** Whether to open as a pinned (non-preview) editor. Default: false. */
	readonly pinned?: boolean;
	/**
	 * Optional 1-based line number to reveal/select after opening. Used by
	 * tool cards (e.g. file_read with `start_line`) to jump to the relevant
	 * line. Ignored when absent.
	 */
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
 * Used by the ConfigHtml preview workflow to load sample content into a
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
 * Apply code content to a file (Void-inspired Apply Code Blocks).
 * Writes the code content to the specified file path, replacing existing content.
 */
export interface IFileApplyCodePayload {
	/** Absolute filesystem path of the file to write. */
	readonly path: string;
	/** New content to write to the file. */
	readonly content: string;
}

/**
 * Navigate to a checkpoint (Void-inspired time-travel navigation).
 */
export interface IChatJumpToCheckpointPayload {
	/** The checkpoint ID to restore. */
	readonly checkpointId: string;
	/** The agent ID (for multi-agent support). */
	readonly agentId: string;
		/** The session ID (for multi-session support). */
	readonly sessionId: string;
	/**
	 * The chat message ID to truncate persisted history after (inclusive).
	 * When provided, the host deletes all messages after this one from disk so
	 * the rollback survives a window reload. Omitted for pure file-only restores.
	 */
	readonly truncateAfterMessageId?: string;
}

/**
 * Open a diff editor for a file at checkpoint time vs. current file content.
 * WebView sends this when the user clicks a file in the checkpoint popover.
 * Host handler writes the snapshot content to a temp file and opens a DiffEditorInput.
 */
export interface IChatOpenCheckpointDiffPayload {
	/** The checkpoint ID. */
	readonly checkpointId: string;
	/** The file URI (as string) to diff. */
	readonly fileUri: string;
	/** The agent ID (for storage scoping). */
	readonly agentId: string;
		/** The session ID (for storage scoping). */
	readonly sessionId: string;
}

/**
 * Revert ALL checkpoints at once (checkpoint bar 撤销 button). Restores every
 * touched file to its earliest pre-edit snapshot and ghosts all checkpoints.
 */
export interface IChatRevertAllCheckpointsPayload {
	/** The agent ID (for storage scoping). */
	readonly agentId: string;
		/** The session ID (for storage scoping). */
	readonly sessionId: string;
	/**
	 * The chat message ID to truncate persisted history after (inclusive).
	 * Typically the user message that preceded the very first checkpoint.
	 */
	readonly truncateAfterMessageId?: string;
}

/**
 * Payload for "keep all checkpoints": remove all persisted checkpoint data.
 * After this call the checkpoint bar will never reappear after reload.
 */
export interface IChatKeepAllCheckpointsPayload {
	/** The agent ID (for storage scoping). */
	readonly agentId: string;
		/** The session ID (for storage scoping). */
	readonly sessionId: string;
}

/**
 * Open a single multi-file diff window showing ALL changes across every
 * checkpoint (checkpoint bar 查看变更 button). Original = earliest snapshot,
 * modified = current on-disk content.
 */
export interface IChatOpenAllCheckpointsDiffPayload {
	/** The agent ID (for storage scoping). */
	readonly agentId: string;
		/** The session ID (for storage scoping). */
	readonly sessionId: string;
}

/**
 * Request webview to show tool approval UI (Host → WebView).
 */
export interface IChatToolApprovalRequestPayload {
	/** The tool call ID that needs approval. */
	readonly toolCallId: string;
	/** The tool name. */
	readonly toolName: string;
	/** The tool arguments. */
	readonly arguments: Record<string, unknown>;
	/** The security level of the tool. */
	readonly securityLevel: 'safe' | 'cautious' | 'dangerous';
	/** Reason why approval is needed. */
	readonly reason?: string;
}

/**
 * Approve or reject a pending tool call (Void-inspired ToolApproval).
 */
export interface IChatToolApprovePayload {
	/** The tool call ID to approve or reject. */
	readonly toolCallId: string;
	/** The decision: 'allow_once' | 'allow_session' | 'allow_workspace' | 'allow_always' | 'deny'. */
	readonly decision: 'allow_once' | 'allow_session' | 'allow_workspace' | 'allow_always' | 'deny';
}

/**
 * Create a new checkpoint.
 */
export interface IChatAddCheckpointPayload {
	/** The agent ID. */
	readonly agentId: string;
		/** The session ID. */
	readonly sessionId: string;
	/** Checkpoint type. */
	readonly type: 'user_edit' | 'tool_edit';
	/** Optional label. */
	readonly label?: string;
	/** Optional description. */
	readonly description?: string;
	/** File URIs to snapshot (content provided separately). */
	readonly fileUris: string[];
	/** The chat message ID associated with this checkpoint (for time-travel). */
	readonly messageId?: string;
}

/**
 * Get checkpoint details.
 */
export interface IChatGetCheckpointPayload {
	/** The checkpoint ID. */
	readonly checkpointId: string;
	/** The agent ID (for storage scoping). */
	readonly agentId: string;
		/** The session ID (for storage scoping). */
	readonly sessionId: string;
}

/**
 * List checkpoints for a session.
 */
export interface IChatListCheckpointsPayload {
	/** The agent ID. */
	readonly agentId: string;
		/** The session ID. */
	readonly sessionId: string;
}

/**
 * Delete a checkpoint.
 */
export interface IChatDeleteCheckpointPayload {
	/** The checkpoint ID. */
	readonly checkpointId: string;
	/** The agent ID (for storage scoping). */
	readonly agentId: string;
		/** The session ID (for storage scoping). */
	readonly sessionId: string;
}

// ─── Memory inspection (AgentMemory gateway proxy) ─────────────────────────────────

/**
 * Common request shape for `memory.listL0` / `memory.listL1`.
 *
 * Both calls are scoped by **agentId**. The host derives the gateway
 * `session_key` from it (`agent:<agentId>`) — identical to the rule used by
 * `AgentMemoryProvider.deriveSessionKey()` so the panel sees exactly what the
 * runtime writes.
 */
export interface IMemoryListPayload {
	/** Agent whose memory layer is being inspected. */
	readonly agentId: string;
	/** Max rows to return (gateway clamps to 500). Default 200. */
	readonly limit?: number;
}

/** Single L0 turn item returned by `memory.listL0`. */
export interface IMemoryL0Item {
	readonly recordId: string;
	readonly sessionKey: string;
	readonly sessionId: string;
	readonly role: string;
	readonly messageText: string;
	readonly recordedAt: string;
	readonly timestamp: number;
}

/** Single L1 distilled memory item returned by `memory.listL1`. */
export interface IMemoryL1Item {
	readonly recordId: string;
	readonly content: string;
	readonly updatedTime: string;
}

export interface IMemoryListL0Response {
	readonly items: readonly IMemoryL0Item[];
	readonly total: number;
}

export interface IMemoryListL1Response {
	readonly items: readonly IMemoryL1Item[];
	readonly total: number;
}

/**
 * Hard-delete memory record(s). Used by per-row delete buttons in the
 * agent editor's Memory tab. The gateway is the only writer to the
 * underlying SQLite tables, so deletion goes through the same proxy
 * channel as listing.
 */
export interface IMemoryDeletePayload {
	readonly agentId: string;
	/** Record IDs to delete. The host forwards them to the gateway as-is. */
	readonly recordIds: readonly string[];
}

export interface IMemoryDeleteResponse {
	readonly deleted: number;
	readonly failed: readonly string[];
}

// ─── Workflow AI Editing Payloads ──────────────────────────────────────────

/**
 * Payload for `workflow.stateApplied` event.
 * Host pushes AI-generated workflow changes to the webview editor.
 * The webview's WorkflowEditorPanel loads this data into its Zustand store.
 */
export interface IWorkflowStateAppliedPayload {
	/** The workflow data (matching IStoredWorkflow shape). */
	readonly workflow: {
		readonly id: string;
		readonly name?: string;
		readonly description?: string;
		readonly nodes?: ReadonlyArray<{
			readonly id: string;
			readonly type: string;
			readonly name?: string;
			readonly label?: string;
			readonly position: { readonly x: number; readonly y: number };
			readonly data?: Record<string, unknown>;
			readonly parentId?: string;
			readonly style?: { readonly width?: number; readonly height?: number };
		}>;
		readonly connections?: ReadonlyArray<{
			readonly id: string;
			readonly from: string;
			readonly to: string;
			readonly fromPort?: string;
			readonly toPort?: string;
			readonly condition?: string;
		}>;
	};
	/** Optional description of what changed (for UI feedback). */
	readonly description?: string;
}

// ─── Workflow Execution Payloads ─────────────────────────────────────────

/**
 * Payload for `workflow.execute` request (WebView → Host).
 * WebView requests the host to start executing a workflow.
 */
export interface IWorkflowExecutePayload {
	/** Workflow ID to execute. */
	readonly workflowId: string;
	/** Optional agent ID to use for execution (overrides workflow.agentId). */
	readonly agentId?: string;
}

/**
 * Payload for `workflow.pause` request (WebView → Host).
 * WebView requests the host to pause workflow execution (e.g., at AskUser node).
 */
export interface IWorkflowPausePayload {
	/** Execution ID. */
	readonly executionId: string;
}

/**
 * Payload for `workflow.resume` request (WebView → Host).
 * WebView sends user input to resume a paused workflow.
 */
export interface IWorkflowResumePayload {
	/** Execution ID. */
	readonly executionId: string;
	/** User input (string for single input, string[] for multi-select). */
	readonly userInput: string | string[];
}

/**
 * Payload for `workflow.cancel` request (WebView → Host).
 * WebView requests the host to cancel workflow execution.
 */
export interface IWorkflowCancelPayload {
	/** Execution ID. */
	readonly executionId: string;
}

/**
 * v5a: Payload for `workflow.breakpoint.set` request (WebView → Host).
 * WebView tells the host to persist a breakpoint on a workflow node.
 */
export interface IWorkflowBreakpointSetPayload {
	/** Workflow ID (the breakpoint is persisted at the workflow level). */
	readonly workflowId: string;
	/** Node ID within the workflow. */
	readonly nodeId: string;
	/**
	 * Optional execution ID — if provided, also applies the breakpoint to
	 * the running execution for immediate effect.
	 */
	readonly executionId?: string;
}

/**
 * v5a: Payload for `workflow.breakpoint.clear` request (WebView → Host).
 */
export interface IWorkflowBreakpointClearPayload {
	readonly workflowId: string;
	readonly nodeId: string;
	readonly executionId?: string;
}

/**
 * v5a: Payload for `workflow.breakpoint.get` request (WebView → Host).
 * Returns the persisted breakpoints for a workflow.
 */
export interface IWorkflowBreakpointGetPayload {
	readonly workflowId: string;
}

/**
 * Payload for `workflow.executionUpdate` event (Host → WebView).
 * Host pushes execution state updates to the webview editor.
 */
export interface IWorkflowExecutionUpdatePayload {
	/** Execution ID. */
	readonly executionId: string;
	/** Current execution status. */
	readonly status: string; // 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
	/** Currently executing node ID (if any). */
	readonly currentNodeId?: string;
	/** Node execution states map (nodeId → state). */
	readonly nodeStates: Record<string, {
		readonly status: string; // 'pending' | 'running' | 'completed' | 'failed' | 'paused'
		readonly startTime?: string;
		readonly endTime?: string;
		readonly error?: string;
		readonly output?: unknown;
	}>;
	/** Breakpoint node IDs. */
	readonly breakpoints?: string[];
}

/**
 * Payload for `workflow.executionTrace` event (Host → WebView). P4: per-node
 * trace forwarded to the workflow owner agent's chat panel so it can render
 * each node as a subagent card (with nested tool calls / thinking / LLM text).
 */
export interface IWorkflowExecutionTracePayload {
	readonly executionId: string;
	readonly sessionId: string;
	readonly workflowAgentId: string;
	/** 'subagent_start' | 'delta' | 'subagent_end' | 'execution_end' */
	readonly kind: string;
	/** Node id (or '__workflow__' for the overall workflow run). */
	readonly nodeId: string;
	/** Subagent metadata for start/end. */
	readonly nodeName?: string;
	readonly nodeType?: string;
	readonly task?: string;
	/** Stream delta payload (for kind='delta'). */
	readonly delta?: unknown;
	/** Final output / error (for kind='subagent_end'). */
	readonly output?: string;
	readonly error?: string;
	readonly status?: string; // 'done' | 'error' | 'completed' | 'failed' | 'cancelled'
}
