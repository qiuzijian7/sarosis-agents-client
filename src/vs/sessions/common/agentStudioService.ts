/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { Event } from "../../base/common/event.js";
import type {
	Agent,
	AgentBinding,
	Workspace,
	Delegation,
	ChatMessage,
	AgentStudioSession,
	Connection,
	WorkspaceLayout,
	TaskBoardRecord,
	TaskBoardStatus,
	TaskBoard,
	TaskAttachment,
	OrchestrationPlan,
	PlanTask,
	ConfigMdCapability,
} from "./agentStudioTypes.js";
import type { IWorktreeWorkspaceOptions } from "../contrib/worktree/common/worktreeTypes.js";

// --- Agent Studio Service ---

export const IAgentStudioService =
	createDecorator<IAgentStudioService>("agentStudioService");

export interface IAgentStudioService {
	readonly _serviceBrand: undefined;

	// Events
	readonly onDidChangeWorkspace: Event<string>;
	readonly onDidChangeSessions: Event<void>;
	readonly onDidSelectAgent: Event<string | null>;
	/** Fired when the host needs the chat panel to inject a prompt into the active agent conversation. */
	readonly onDidRequestInjectPrompt: Event<{ agentId: string; message: string }>;
	/** Fired when agents change (custom agent CRUD). */
	readonly onDidChangeAgents: Event<void>;
	/**
	 * Fired when the active (currently selected) workspace changes.
	 * Payload is the active workspace id, or undefined when cleared.
	 * This is the central hook that drives sandbox roots, SCM folder sync,
	 * the ActivityBar tree filter, and canvas switching.
	 */
	readonly onDidChangeActiveWorkspace: Event<string | undefined>;

	// Agent selection
	fireSelectAgent(agentId: string | null): void;
	/** Request the chat panel to inject a prompt into the conversation for the given agent. */
	requestInjectPrompt(agentId: string, message: string): void;

	// Agents — chat-ready agent definitions (builtins + custom presets)
	getAgents(): Promise<Agent[]>;
	getAgent(id: string): Promise<Agent | undefined>;
	createAgent(data: Partial<Agent>): Promise<Agent>;
	updateAgent(id: string, data: Partial<Agent>): Promise<void>;
	deleteAgent(id: string): Promise<void>;
	getLastSelectedAgentId(): Promise<string | null>;
	setLastSelectedAgentId(id: string | null): Promise<void>;

	// Agent Bindings — per-(workspace × agent) runtime instance state.
	// `Agent` is a global definition; bindings hold workspace-local runtime
	// state (worktree, agentDir, memoryConfig) so the same agent running in two
	// workspaces never clobbers the other. Persisted at
	// `{workspace}/.sarosisworkspace/agent-bindings.json` keyed by agentId.
	/** All bindings for a workspace. */
	getAgentBindings(workspaceId: string): Promise<AgentBinding[]>;
	/** A single binding, or undefined if the agent has never run in this workspace. */
	getAgentBinding(workspaceId: string, agentId: string): Promise<AgentBinding | undefined>;
	/** Create or merge-update a binding (partial patch on the existing record). */
	upsertAgentBinding(workspaceId: string, agentId: string, patch: Partial<AgentBinding>): Promise<AgentBinding>;
	/** Remove a binding (e.g. when the worktree is torn down). */
	deleteAgentBinding(workspaceId: string, agentId: string): Promise<void>;

	// Workspaces
	getWorkspaces(): Promise<Workspace[]>;
	getWorkspace(id: string): Promise<Workspace | undefined>;
	createWorkspace(data: Partial<Workspace>): Promise<Workspace>;
	updateWorkspace(id: string, data: Partial<Workspace>): Promise<Workspace>;
	deleteWorkspace(id: string): Promise<void>;
	updateWorkspaceLayout(id: string, layout: WorkspaceLayout): Promise<void>;
	setLastActiveWorkspaceId(id: string | null): Promise<void>;
	getLastActiveWorkspaceId(): Promise<string | null>;

	// --- Related Folders (multi-repo management) ---------------------------------------

	/** Associate a local code repository folder with a workspace (deduped by path). */
	addRelatedFolder(workspaceId: string, folderPath: string): Promise<Workspace>;
	/** Remove a related folder association from a workspace. */
	removeRelatedFolder(workspaceId: string, folderPath: string): Promise<Workspace>;

	// --- Active Workspace (runtime selection, distinct from persisted lastActive) ------

	/** The id of the currently active workspace, or undefined if none selected. */
	getActiveWorkspaceId(): string | undefined;
	/**
	 * Set the active workspace. Drives the full linkage:
	 * ① sandbox root set ② SCM folder sync ③ ActivityBar tree filter ④ canvas switch.
	 * Also persists as lastActiveWorkspaceId.
	 */
	setActiveWorkspace(workspaceId: string | undefined): Promise<void>;
	/**
	 * Resolve the workspace id the webview should default to on launch.
	 * Resolution order: in-memory active id → reverse-lookup by the IDE's
	 * currently opened folder → persisted lastActive id → first workspace
	 * with a bound `path` → workspaces[0]. Returns null when there are no
	 * workspaces at all.
	 */
	resolveDefaultActiveWorkspaceId(): Promise<string | null>;

	// Connections
	getConnections(workspaceId: string): Promise<Connection[]>;
	addConnection(
		workspaceId: string,
		connection: Omit<Connection, "id">,
	): Promise<Connection>;
	removeConnection(workspaceId: string, connectionId: string): Promise<void>;

	// Sessions
	getSessions(): Promise<AgentStudioSession[]>;
	getSession(id: string): Promise<AgentStudioSession | undefined>;
	createSession(data: Partial<AgentStudioSession>): Promise<AgentStudioSession>;
	deleteSession(id: string): Promise<void>;

	// --- Worktree Integration (opencode-compatible) -------------------------------------

	/**
	 * Create a workspace with worktree isolation.
	 * Handles the full lifecycle: makeWorktreeInfo → createFromInfo → waitReady.
	 * Compatible with opencode's session-worktree binding pattern.
	 */
	createWorkspaceWithWorktree(
		name: string,
		options?: IWorktreeWorkspaceOptions,
	): Promise<Workspace>;

	/**
	 * Assign an existing worktree to a workspace.
	 * Updates Workspace.worktreePath and Workspace.worktreeBranch.
	 */
	assignWorktreeToWorkspace(
		workspaceId: string,
		worktreePath: string,
		worktreeBranch?: string,
	): Promise<void>;

	/**
	 * Reset the worktree associated with a workspace to its default state.
	 * Requires the workspace to have a worktreePath set.
	 */
	resetWorkspaceWorktree(workspaceId: string): Promise<void>;

	/**
	 * Remove the worktree associated with a workspace and clear the binding.
	 */
	removeWorkspaceWorktree(workspaceId: string): Promise<void>;

	/**
	 * List git worktrees for a workspace.
	 * Returns array of { path, branch } objects.
	 */
	getWorktrees(workspaceId: string): Promise<Array<{ path: string; branch: string }>>;

	/** Event fired when a workspace's worktree status changes */
	readonly onDidChangeWorktreeState: Event<{ workspaceId: string; status: string; message?: string }>;
}

// --- Stream Phase (Void-inspired: IsRunningType 5-state model) ---

/**
 * 精确表达 Agent 循环的每个阶段，替代 boolean isStreaming。
 * 与 contrib/agentStudio/common/providers.ts 中的 StreamPhase 定义保持同步。
 *
 * 注意：此处独立定义而非从 contrib 导入，因为 sessions/common/ 不能依赖 contrib/。
 */
export type StreamPhase =
	| 'idle'              // 完全空闲
	| 'llm_streaming'     // LLM 正在流式输出
	| 'tool_executing'    // 工具正在执行
	| 'awaiting_approval' // 等待用户审批
	| 'compressing'       // 正在压缩上下文
	| 'error';            // 错误状态

// --- Agent Chat Service ---

export const IAgentChatService =
	createDecorator<IAgentChatService>("agentChatService");

export interface IChatStreamDelta {
	readonly type:
	| "text"
	| "thinking"
	| "tool_start"
	| "tool_args"
	| "tool_end"
	| "tool_result"
	| "tool_progress"
	| "done"
	| "error"
	| "content_replace"
	| "references"
	| "progress"
	| "confirmation"
	| "todos"
	| "tips"
	| "questions"
	| "usage"
	| "phase_change"
	| "context_compacted"
	| "sub_agent_start"
	| "sub_agent_progress"
	| "sub_agent_end"
	| "discard_prior_text" // Hermes synthetic-recovery 等价物：丢弃此前的幻觉/过渡文本，防止 conversation rot
	| "assistant_turn"; // Hermes-style 消息边界：agentOS 每个 iteration 的 assistant 边界，供 chatService 按回合切分持久化
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly metadata?: Record<string, unknown>;
	readonly progress?: number;
	readonly stage?: string;
	/** Whether the tool call succeeded (only meaningful on `tool_end`). */
	readonly success?: boolean;
	/**
	 * Stream phase — allows explicit phase transitions from Host.
	 * When present, the WebView will set StreamState.phase to this value.
	 *
	 * Phases: 'idle' | 'llm_streaming' | 'tool_executing' | 'awaiting_approval' | 'compressing' | 'error'
	 */
	readonly phase?: StreamPhase;
	/**
	 * 上下文压缩后回传的"压缩后估算输入 token"（type === 'context_compacted' 时携带）。
	 * 镜像于 contrib/agentStudio/common/providers.ts IChatStreamDelta.compactedInputTokens —
	 * 因 common/ 不能 import contrib/，此处内联同一字段。WebView 据此把圆环进度条基线
	 * 立即下调，实现压缩后圆圈同步回落。
	 */
	readonly compactedInputTokens?: number;
	/**
	 * Sub-agent lifecycle fields (carried on `sub_agent_*` delta types).
	 * Kept 1:1 aligned with the WebView-side StreamChunk so the controller can
	 * forward the delta verbatim to drive the SubAgentCard. Mirror of the same
	 * fields in `contrib/agentStudio/common/providers.ts` IChatStreamDelta —
	 * inlined here because `common/` cannot import from `contrib/`.
	 */
	readonly subAgentId?: string;
	readonly subAgentType?: 'explore' | 'general' | 'scout';
	readonly subAgentTask?: string;
	readonly subAgentParentId?: string;
	readonly subAgentStatus?: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	readonly subAgentProgress?: string;
	readonly subAgentOutput?: string;
	readonly subAgentError?: string;
	readonly subAgentGroupId?: string;
	/**
	 * Host-side full text snapshot (Void-inspired fullTextSoFar pattern).
	 * When present, the WebView uses this instead of incrementally
	 * appending `content` to textBuffer.
	 */
	readonly fullText?: string;
	/**
	 * Host-side full thinking snapshot (parallel to fullText).
	 * When present, the WebView uses this instead of incrementally
	 * appending `content` to thinkingBuffer.
	 */
	readonly fullThinking?: string;
	/**
	 * Token usage statistics (only meaningful when `type === 'usage'`).
	 *
	 * Mirrored structurally from `IModelUsage` in
	 * `contrib/agentStudio/common/providers.ts`. We deliberately inline the
	 * shape here rather than import the contrib type, because `common/`
	 * cannot depend on `contrib/` under the layered-architecture rule.
	 */
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		/** Cache-hit input tokens (OpenAI `cached_tokens` / Anthropic `cache_read_input_tokens`). */
		readonly cachedTokens?: number;
		/** Cache-write tokens (Anthropic `cache_creation_input_tokens`). */
		readonly cacheWriteTokens?: number;
	};
	/** UI display name for tool card (from model's display_name field) */
	readonly displayName?: string;
	/** Render type for tool card (e.g. RunTerminal, CodeEditor, ListItems) */
	readonly renderType?: string;
	/** Whether to show this tool call card by default (default true) */
	readonly defaultShow?: boolean;
	/** Whether the tool was executed on the server side */
	readonly serverExecuted?: boolean;
	// New fields for card data (VS Code Copilot Chat pattern)
	/** References data (for references delta type) */
	readonly references?: Array<{
		readonly id: string;
		readonly kind: 'file' | 'code' | 'url' | 'symbol' | 'text';
		readonly name: string;
		readonly uri?: string;
		readonly range?: { startLine: number; startCol: number; endLine: number; endCol: number };
		readonly description?: string;
		readonly state?: 'not-modified' | 'modified' | 'pending' | 'excluded';
	}>;
	/** Progress data (for progress delta type) */
	readonly progressData?: Array<{
		readonly id: string;
		readonly content: string;
		readonly status: 'pending' | 'in-progress' | 'completed' | 'error';
		readonly icon?: 'spinner' | 'check' | 'warning' | 'error';
		readonly timestamp?: string;
	}>;
	/** Confirmation data (for confirmation delta type) */
	readonly confirmationData?: {
		readonly id: string;
		readonly title: string;
		readonly message: string;
		readonly detail?: string;
		readonly buttons: Array<{
			readonly id: string;
			readonly label: string;
			readonly tooltip?: string;
			readonly primary?: boolean;
			readonly danger?: boolean;
			readonly icon?: string;
		}>;
		readonly status: 'pending' | 'approved' | 'rejected' | 'cancelled';
		readonly icon?: string;
	};
	/** Todos data (for todos delta type) */
	readonly todosData?: Array<{
		readonly id: string;
		readonly label: string;
		readonly completed: boolean;
		readonly description?: string;
		readonly assignee?: string;
	}>;
	/** Tips data (for tips delta type) */
	readonly tipsData?: Array<{
		readonly id: string;
		readonly content: string;
		readonly icon?: string;
		readonly action?: {
			readonly label: string;
			readonly tooltip?: string;
			readonly actionId?: string;
		};
	}>;
	/** Questions data (for questions delta type) */
	readonly questionsData?: Array<{
		readonly id: string;
		readonly label: string;
		readonly tooltip?: string;
		readonly category?: string;
	}>;
}

export type ChatMode = 'craft' | 'ask' | 'plan' | 'workflow';

export interface IChatSendOptions {
	readonly model?: string;
	/** Provider ID override (e.g. 'byok', 'knot-agui'). When set together with
	 *  `model`, the pair overrides the global active model selection for this
	 *  single sendMessage call — used by workflow node-level provider/model. */
	readonly providerId?: string;
	readonly agentId?: string; // selected Agent ID (e.g. Knot Agent)
	readonly systemPrompt?: string;
	readonly temperature?: number;
	readonly workspaceId?: string;
	/** Fork-scoped Agent session ID (undefined = Root default session) */
	readonly agentSessionId?: string;
	// allow-any-unicode-next-line
	/** 用户通过 /skill 命令显式激活的技能 ID 列表 */
	readonly explicitSkillIds?: readonly string[];
	/** Current chat mode: craft (full access), ask (read-only tools), plan (decomposition only), workflow (craft + downstream agents) */
	readonly chatMode?: ChatMode;
	/**
	 * 推理/思考（thinking）配置。由聊天输入框的 thinking UI 控件产生，
	 * 经 host 透传到 IModelOptions.reasoning，最终由各 model provider 映射到原生 API 参数。
	 */
	readonly reasoning?: {
		readonly enabled: boolean;
		readonly budget?: number;
		readonly effort?: 'low' | 'medium' | 'high';
	};
	/**
	 * 用户上传的附件（图片/文件）— Void-inspired image/file upload。
	 * 图片附件将转换为各 LLM API 的多模态消息格式（OpenAI image_url / Anthropic image source）。
	 */
	readonly attachments?: readonly IChatAttachmentSend[];
	/**
	 * 任务级 worktree 路径（来自 TaskBoardRecord.worktreePath）。
	 * 当设置时，agent 执行的工作目录应优先使用此路径（高于 AgentBinding.worktreePath）。
	 */
	readonly worktreePath?: string;
}

/**
 * 附件传输格式 — 从 WebView 经 Host 到 AgentOS 的附件数据。
 */
export interface IChatAttachmentSend {
	readonly id: string;
	readonly type: 'image' | 'file';
	readonly name: string;
	readonly mimeType: string;
	/** base64 编码内容（图片和二进制文件）或原文（文本文件） */
	readonly data: string;
	readonly size: number;
	readonly isPasted?: boolean;
}

export interface IAgentChatService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when the agent session list for any agent changes
	 * (session created, renamed, deleted, or updated).
	 * The payload carries the agentId whose sessions changed.
	 */
	readonly onDidChangeAgentSessions: Event<{ agentId: string }>;

	sendMessage(
		agentId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage>;

	getHistory(agentId: string, sessionId?: string): Promise<ChatMessage[]>;
	clearHistory(agentId: string, sessionId?: string): Promise<void>;
	cancelStream(agentId: string, agentSessionId?: string): void;

	/** Append a message to the chat history for an agent and persist. */
	appendMessage(agentId: string, message: ChatMessage): Promise<void>;

	/**
	 * Create a new agent session (e.g. for workflow execution isolation).
	 * Returns the session metadata including the session id.
	 */
	createAgentSession(agentId: string, name?: string): Promise<{ id: string; name: string; createdAt: string; updatedAt: string; messageCount: number }>;

	/**
	 * Delete chat messages after a given message ID (for checkpoint time-travel).
	 * Keeps messages up to and including the target message.
	 */
	deleteMessagesAfter(agentId: string, sessionId: string | undefined, messageId: string): Promise<void>;

	/**
	 * Replace the entire chat history for an agent session. Used by the
	 * workflow execution engine to write back compressed messages after
	 * the Provider layer performs context compaction, so subsequent
	 * `getHistory` calls don't reload the full uncompressed history.
	 */
	replaceHistory(agentId: string, sessionId: string | undefined, messages: ChatMessage[]): Promise<void>;
}

// --- Agent Delegation Service ---

export const IAgentDelegationService = createDecorator<IAgentDelegationService>(
	"agentDelegationService",
);

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

// --- Agent Task Board Service ---

export const IAgentTaskBoardService = createDecorator<IAgentTaskBoardService>(
	"agentTaskBoardService",
);

export interface IAgentTaskBoardService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTaskBoard: Event<void>;

	/** Fired when boards are created/renamed/deleted (multi-board isolation, P2). */
	readonly onDidChangeBoards: Event<void>;

	getTasks(workspaceId?: string, boardId?: string): Promise<TaskBoardRecord[]>;
	getTask(id: string): Promise<TaskBoardRecord | undefined>;
	createTask(data: Partial<TaskBoardRecord>): Promise<TaskBoardRecord>;
	updateTask(
		id: string,
		data: Partial<TaskBoardRecord>,
	): Promise<TaskBoardRecord>;
	updateTaskStatus(
		id: string,
		status: TaskBoardStatus,
	): Promise<TaskBoardRecord>;
	deleteTask(id: string): Promise<void>;
	archiveTask(id: string): Promise<TaskBoardRecord>;

	// ─── Board management (multi-board isolation, P2) ───────────────────────
	/** List boards for a workspace; always includes the implicit default board. */
	listBoards(workspaceId?: string): Promise<TaskBoard[]>;
	/** Create a new board within a workspace. */
	createBoard(name: string, workspaceId: string): Promise<TaskBoard>;
	/** Rename an existing board (the default board can be renamed too). */
	renameBoard(boardId: string, name: string): Promise<TaskBoard>;
	/** Delete a board; its tasks are reassigned to the workspace's default board. */
	deleteBoard(boardId: string): Promise<void>;

	// ─── Attachments (P2) ───────────────────────────────────────────────────
	/**
	 * Attach a file to a task. The binary content is stored in a side file;
	 * only metadata is returned and persisted on the task record.
	 * @param base64Content file bytes encoded as base64.
	 */
	addAttachment(taskId: string, name: string, mimeType: string, base64Content: string): Promise<TaskAttachment>;
	/** Remove an attachment from a task and delete its side file. */
	removeAttachment(taskId: string, attachmentId: string): Promise<void>;
	/** Read an attachment's content back as base64 (for download/preview). */
	readAttachment(taskId: string, attachmentId: string): Promise<string>;
}

// --- Task Orchestration Service ---

export const ITaskOrchestrationService =
	createDecorator<ITaskOrchestrationService>("taskOrchestrationService");

export type OrchestrationTaskAction = "retry" | "pause" | "resume" | "cancel" | "approve" | "reject" | "comment" | "block" | "unblock";

export interface ITaskOrchestrationService {
	readonly _serviceBrand: undefined;

	readonly onDidChangePlan: Event<OrchestrationPlan>;
	readonly onDidChangeTask: Event<{ planId: string; task: PlanTask }>;
	/** Fired when the user requests to focus/highlight a task in the task board */
	readonly onDidFocusTask: Event<string>;

	/**
	 * Focus/highlight a task in the Task Overview board by title.
	 * The TaskOverviewEditorPane listens to this and scrolls to the matching card.
	 */
	focusTaskInBoard(taskTitle: string): void;

	/**
	 * Use the planner to decompose a goal into tasks.
	 * Only agents with agentType='planner' may call this.
	 * Returns a plan in PendingApproval status.
	 */
	createPlan(
		goal: string,
		workspaceId: string,
		plannerId: string,
	): Promise<OrchestrationPlan>;

	/**
	 * Approve the plan: auto-create agents, connections, task board items, then execute.
	 */
	approvePlan(planId: string): Promise<OrchestrationPlan>;

	/**
	 * Reject the plan: mark as rejected, no side effects.
	 */
	rejectPlan(planId: string): Promise<OrchestrationPlan>;

	/**
	 * Approve a plan without executing it.
	 * Tasks are created in the task board but not auto-started.
	 */
	approveWithoutExecute(planId: string): Promise<OrchestrationPlan>;

	/**
	 * Update a plan's editable fields (goal, summary).
	 * Only allowed when plan is in 'pending_approval' status.
	 */
	updatePlan(
		planId: string,
		updates: {
			goal?: string;
			summary?: string;
		},
	): Promise<OrchestrationPlan>;

	/**
	 * Get a specific plan by ID.
	 */
	getPlan(planId: string): Promise<OrchestrationPlan | undefined>;

	/**
	 * List all plans, optionally filtered by workspace.
	 */
	listPlans(workspaceId?: string): Promise<OrchestrationPlan[]>;

	/**
	 * Perform an action on a specific task within a plan.
	 */
	taskAction(
		planId: string,
		taskId: string,
		action: OrchestrationTaskAction,
	): Promise<PlanTask>;

	// allow-any-unicode-next-line
	// ─── Human-in-the-Loop Methods ─────────────────────────────────────

	/**
	 * Approve a completed task that needs human review.
	 */
	approveTask(planId: string, taskId: string, comment?: string): Promise<PlanTask>;

	/**
	 * Reject a completed task that needs human review.
	 */
	rejectTask(planId: string, taskId: string, comment?: string): Promise<PlanTask>;

	/**
	 * Add a comment to a task (human-agent collaboration).
	 */
	commentTask(planId: string, taskId: string, comment: string): Promise<PlanTask>;

	/**
	 * Block a task to prevent it from executing.
	 */
	blockTask(planId: string, taskId: string, reason?: string): Promise<PlanTask>;

	/**
	 * Unblock a previously blocked task.
	 */
	unblockTask(planId: string, taskId: string): Promise<PlanTask>;

	/**
	 * Ensure a task has an agent assigned. If the task already has an assigneeId,
	 * verify it still exists. If not, find or create a suitable agent.
	 * Used when a task board item transitions to 'running' (user clicks "approve").
	 */
	ensureTaskAgent(
		workspaceId: string,
		taskBoardRecordId: string,
		taskInfo?: { title: string; description?: string; assigneeId?: string; assigneeName?: string; sourceId?: string },
	): Promise<{ assigneeId: string; assigneeName: string } | undefined>;

	/**
	 * Execute a task board item by invoking the assigned agent.
	 * Sends the task description as a user message, streams the agent's response,
	 * and updates task status when done.
	 * Called by AgentTaskBoardService when a task transitions to 'running'.
	 */
	executeTaskForBoard(
		workspaceId: string,
		taskBoardRecordId: string,
		taskInfo?: { title: string; description?: string; assigneeId?: string; assigneeName?: string; sourceId?: string; worktreePath?: string },
	): Promise<void>;

	/**
	 * Execute a workflow starting from the given agent.
	 * The agent processes the user message, then upon completion,
	 * automatically drives downstream agents (connected via 'subagent'
	 * connections) to execute in topological order.
	 * Creates task board items for each step of the workflow.
	 * Returns the ID of the transient workflow plan for tracking.
	 */
	executeWorkflow(
		agentId: string,
		message: string,
		workspaceId: string,
		options?: { agentSessionId?: string },
	): Promise<string>;

	/**
	 * Update a task's editable fields (title, description, assignee, dependencies, priority).
	 * Only allowed when plan is in 'pending_approval' status.
	 */
	updateTask(
		planId: string,
		taskId: string,
		updates: {
			title?: string;
			description?: string;
			assigneeId?: string;
			assigneeName?: string;
			assigneeRole?: string;
			dependencies?: string[];
			priority?: number;
		},
	): Promise<PlanTask>;

	/**
	 * Use AI to decompose a single task into sub-tasks.
	 * Replaces the original task with the decomposed sub-tasks in the plan.
	 * Only allowed when plan is in 'pending_approval' status.
	 */
	decomposeTask(
		planId: string,
		taskId: string,
		workspaceId: string,
		plannerId: string,
	): Promise<OrchestrationPlan>;

	/**
	 * Register a callback for streaming events (chat.stream.delta/complete/error)
	 * generated during background task execution.
	 */
	setStreamEventCallback(callback: (eventType: string, payload: Record<string, unknown>) => void): void;

	/**
	 * Invalidate the cached repo overview. Call when workspace content changes.
	 */
	invalidateRepoOverview(): void;

	/**
	 * Access the unified sub-agent dispatch for direct sub-agent operations.
	 * Used by delegate_task tool and other runtime delegation paths.
	 * Typed as unknown here to avoid circular deps; cast at the call site.
	 */
	readonly subAgentDispatch: unknown;
}

// --- ConfigHtml Service ---

export const IConfigHtmlService =
	createDecorator<IConfigHtmlService>("configHtmlService");

/**
 * A patch operation against the canonical MD file.
 * @see IConfigMdPatchOp in messageProtocol.ts
 */
export interface IConfigMdPatchOp {
	readonly op:
	| "replace-anchor"
	| "replace-bind"
	| "append"
	| "prepend"
	| "replace-section"
	| "replace-all";
	readonly anchor?: string;
	readonly heading?: string;
	readonly content: string;
}

/**
 * A command parsed from model output, destined for the ConfigMD HTML view.
 * Model outputs commands inside ```configmd-command JSON code blocks.
 */
export interface IConfigMdCommand {
	readonly name: string;
	readonly params: Record<string, unknown>;
	readonly id: string;
}

/**
 * A snapshot of the current ConfigMD state for an agent.
 */
export interface IConfigMdState {
	/** Current MD content */
	readonly markdown: string;
	/** Current rendered HTML */
	readonly html: string;
	/** Monotonic version (incremented on each successful write) */
	readonly version: number;
	/** Optional injected CSS */
	readonly stylesContent?: string;
	/** Whether a custom parser script was used */
	readonly parserSource?: "builtin" | "custom";
}

/**
 * Origin of an MD change — used to suppress echo loops.
 */
export type ConfigMdChangeOrigin = "editor" | "html" | "model" | "external";

export interface IConfigHtmlService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when the MD source has changed (from any origin).
	 * Subscribers should NOT trigger another write with the same content.
	 */
	readonly onDidChangeSource: Event<{
		agentId: string;
		markdown: string;
		version: number;
		origin: ConfigMdChangeOrigin;
	}>;

	/**
	 * Fired when a new HTML render is available (after MD changes or explicit re-render).
	 */
	readonly onDidRenderHtml: Event<{
		agentId: string;
		html: string;
		version: number;
		stylesContent?: string;
	}>;

	/**
	 * Fired when a model-issued command should be pushed to the HTML view.
	 */
	readonly onDidEmitCommand: Event<{
		agentId: string;
		command: IConfigMdCommand;
	}>;

	/**
	 * Fired when an HTML view sends a custom event back to the agent.
	 */
	readonly onDidReceiveHtmlEvent: Event<{
		agentId: string;
		eventName: string;
		payload: unknown;
	}>;

	/**
	 * Fired when an imgui button requests a chat send. The host's webview
	 * controller listens to this event and routes the message through the
	 * full `chat.send` pipeline (creating a user message, persisting it,
	 * and streaming deltas back to the chat panel UI). Subscribers must
	 * not double-send — only the controller that owns the chat webview
	 * should react.
	 *
	 * `workspaceId` is carried so the controller can pick the Fork-mode
	 * lazy-create path when it should — without it, a Fork-context submit
	 * would silently be persisted to the wrong (Root) session.
	 */
	readonly onDidRequestChatSend: Event<{
		agentId: string;
		message: string;
		agentSessionId?: string;
		workspaceId?: string;
		workspaceSessionId?: string;
	}>;

	// --- Resource & State --------------------------------------------------

	/**
	 * Resolve and load the ConfigMD state for an agent (reads MD file, parser, styles).
	 * Sets up the file watcher on first call.
	 */
	resolveState(agentId: string): Promise<IConfigMdState | null>;

	/**
	 * Read the raw MD source for an agent.
	 */
	readSource(
		agentId: string,
	): Promise<{ markdown: string; version: number }>;

	/**
	 * Overwrite the MD source. Triggers re-render & onDidChangeSource.
	 * Optimistic concurrency: if `baseVersion` is provided and stale, throws.
	 */
	writeSource(
		agentId: string,
		markdown: string,
		options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
	): Promise<{ version: number }>;

	/**
	 * Apply a sequence of patches to the MD source.
	 */
	applyPatch(
		agentId: string,
		patches: IConfigMdPatchOp[],
		options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
	): Promise<{ version: number; markdown: string }>;

	/**
	 * Render (or re-render) the HTML for an agent's current MD content.
	 * If `markdown` provided, render it without persisting.
	 */
	renderHtml(
		agentId: string,
		markdown?: string,
	): Promise<{ html: string; version: number }>;

	/**
	 * Render the current MD into a complete standalone HTML document and write
	 * it to `<agentDir>/.preview.html`. Returns the absolute filesystem path
	 * so callers can open the file in the host editor.
	 */
	previewToFile(agentId: string): Promise<{ path: string; version: number }>;

	/**
	 * ConfigHtml AI box: send a natural-language request to the model with the
	 * `confightml` skill activated and a dedicated system prompt, then extract
	 * the single ```html code block from the reply. Self-contained one-shot
	 * generation (does NOT route into the main chat panel).
	 */
	htmlGenerate(
		agentId: string,
		message: string,
		options?: { currentHtml?: string; model?: string },
	): Promise<{ html: string; raw: string }>;

	// --- HTML Event Handling ---------------------------------------------

	/**
	 * Forward a custom HTML event to the agent's chat (and parse model commands).
	 */
	handleHtmlEvent(
		agentId: string,
		eventName: string,
		payload: unknown,
		agentSessionId?: string,
	): Promise<void>;

	/**
	 * Send a chat message from the HTML view (capability: chat.send).
	 */
	handleChatSend(
		agentId: string,
		message: string,
		options?: {
			context?: string;
			showInChat?: boolean;
			agentSessionId?: string;
		},
	): Promise<ChatMessage>;

	// --- Push to HTML view ----------------------------------------------

	sendCommandToHtml(agentId: string, command: IConfigMdCommand): void;

	// --- Active Agent Session Registry -----------------------------------

	/**
	 * Register the agent session a chat panel is currently showing for a
	 * given agent. The HtmlPreviewEditorPane uses this when forwarding
	 * `imgui.submit` so the message lands in the same Fork session the user
	 * is looking at, instead of falling back to the default session.
	 *
	 * Pass `agentSessionId = undefined` to clear the registration when the
	 * panel is closed or the user switches to "default" session.
	 *
	 * Multiple chat panels can exist (e.g. multiple Forks open) — the last
	 * one to update wins. Webview panels race each other only if the user
	 * is rapidly toggling, which is harmless: imgui submits will follow the
	 * most recently focused panel.
	 */
	setActiveAgentSession(
		agentId: string,
		agentSessionId: string | undefined,
	): void;

	/**
	 * Read the currently registered active agent session for an agent,
	 * or `undefined` if no chat panel has registered one.
	 */
	getActiveAgentSession(agentId: string): string | undefined;

	// --- Capability Check -----------------------------------------------

	checkCapability(
		agentId: string,
		capability: ConfigMdCapability,
	): Promise<void>;

	// --- Custom Parser / Styles Management -------------------------------

	/**
	 * Upload a custom MD→HTML parser script. Persists to agentDir/ui/parser.js,
	 * updates agent.yaml.configMd.parserPath, and triggers a re-render.
	 */
	uploadParser(
		agentId: string,
		content: string,
		fileName?: string,
	): Promise<{ parserPath: string }>;

	/**
	 * Upload a custom CSS file. Persists to agentDir/ui/styles.css,
	 * updates agent.yaml.configMd.stylesPath, and triggers a re-render.
	 */
	uploadStyles(
		agentId: string,
		content: string,
		fileName?: string,
	): Promise<{ stylesPath: string }>;

	/**
	 * Remove the custom parser, fall back to built-in parser, and trigger re-render.
	 */
	removeParser(agentId: string): Promise<void>;

	/**
	 * Get current parser/styles info for the agent.
	 */
	getInfo(agentId: string): Promise<{
		parserSource: "builtin" | "custom";
		parserPath?: string;
		stylesPath?: string;
		hasStyles: boolean;
	}>;

	// --- Model Output Parsing -------------------------------------------

	/**
	 * Parse `configmd-patch` and `configmd-command` blocks from model output.
	 * Returns extracted patches and commands, plus the cleaned text.
	 */
	parseModelOutput(content: string): {
		patches: IConfigMdPatchOp[];
		commands: IConfigMdCommand[];
		cleanText: string;
	};

	/**
	 * Dispose any per-agent watchers/state.
	 */
	disposeAgent(agentId: string): void;
}

