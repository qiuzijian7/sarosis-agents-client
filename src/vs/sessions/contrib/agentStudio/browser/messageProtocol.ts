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
	| 'configmd.htmlGenerate'    // ConfigHtml: ask the confightml skill to generate full HTML
	| 'configmd.listAgents'      // list all agents that have config.md configured
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
	| 'memory.listL0'           // list L0 raw conversation turns for an agent (TDB-AM)
	| 'memory.listL1'           // list L1 distilled memories for an agent (TDB-AM)
	| 'memory.deleteL0'         // hard-delete L0 record(s) by id
	| 'memory.deleteL1'         // hard-delete L1 record(s) by id
	| 'skills.list'
	| 'workflow.get'
	| 'workflow.save';              // save workflow nodes+connections from webview editor

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
	| 'configmd.sourceChanged'    // MD content updated (file watcher / external edit)
	| 'configmd.htmlRendered'     // new HTML rendered (push to preview)
	| 'configmd.command'          // model-issued command for HTML view
	| 'configmd.message'          // model-issued message for HTML view
	| 'configmd.error'           // sync/render error
	| 'chat.toolApprovalRequest'
	| 'workflow.loaded'          // host sends workflow data to webview editor
	| 'workflow.saved'           // host confirms save to webview
	| 'workflow.stateApplied';   // host pushes AI-generated workflow state to webview editor

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
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_args' | 'tool_end' | 'tool_result' | 'error' | 'done' | 'content_replace' | 'usage' | 'phase_change' | 'context_compacted' | 'discard_prior_text';
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
	readonly agentId: string;
	}

export interface IConfigMdReadSourcePayload {
	readonly agentId: string;
	}

export interface IConfigMdWriteSourcePayload {
	readonly agentId: string;
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
	readonly agentId: string;
		readonly patches: IConfigMdPatchOp[];
	readonly origin?: 'editor' | 'html' | 'model' | 'external';
	readonly baseVersion?: number;
}

export interface IConfigMdRenderHtmlPayload {
	readonly agentId: string;
		readonly markdown?: string;  // optional override; defaults to current file
}

export interface IConfigMdEventPayload {
	readonly agentId: string;
		readonly eventName: string;
	readonly payload?: unknown;
	readonly agentSessionId?: string;
}

export interface IConfigMdChatSendPayload {
	readonly agentId: string;
		readonly message: string;
	readonly context?: string;
	readonly showInChat?: boolean;
	readonly agentSessionId?: string;
}

export interface IConfigMdHtmlGeneratePayload {
	readonly agentId: string;
		readonly message: string;
	/** Current HTML in the editor (so the model can do incremental edits). */
	readonly currentHtml?: string;
	readonly model?: string;
}

export interface IConfigMdNotifyPayload {
	readonly agentId: string;
		readonly message: string;
	readonly level?: 'info' | 'success' | 'warning' | 'error';
}

// ─── ConfigMD Event Payloads (Host → WebView) ───────────────────────────────

export interface IConfigMdSourceChangedPayload {
	readonly agentId: string;
		readonly markdown: string;
	readonly version: number;
	readonly origin: 'editor' | 'html' | 'model' | 'external';
}

export interface IConfigMdHtmlRenderedPayload {
	readonly agentId: string;
		readonly html: string;
	readonly version: number;
	readonly stylesContent?: string;
}

export interface IConfigMdCommandPayload {
	readonly agentId: string;
		readonly command: {
		readonly name: string;
		readonly params: Record<string, unknown>;
		readonly id: string;
	};
}

export interface IConfigMdUploadParserPayload {
	readonly agentId: string;
		readonly content: string;
	readonly fileName?: string;
}

export interface IConfigMdUploadStylesPayload {
	readonly agentId: string;
		readonly content: string;
	readonly fileName?: string;
}

export interface IConfigMdRemoveParserPayload {
	readonly agentId: string;
	}

export interface IConfigMdInfoPayload {
	readonly agentId: string;
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
 * Either an absolute filesystem path or an agent-relative reference may be supplied.
 */
export interface IFileOpenPayload {
	/** Absolute filesystem path (preferred). */
	readonly path?: string;
	/** Alternative: agent id + relative kind, resolved by host. */
		readonly agentId?: string;
	/** Which configMd-related file to open (only used when agentId is present). */
	readonly kind?: 'configMd' | 'configMdParser' | 'configMdStyles';
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

// ─── Memory inspection (TDB-AM gateway proxy) ─────────────────────────────────

/**
 * Common request shape for `memory.listL0` / `memory.listL1`.
 *
 * Both calls are scoped by **agentId**. The host derives the gateway
 * `session_key` from it (`agent:<agentId>`) — identical to the rule used by
 * `TdbAmMemoryProvider.deriveSessionKey()` so the panel sees exactly what the
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
