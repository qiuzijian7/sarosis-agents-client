/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { Event } from "../../base/common/event.js";
import type {
	Employee,
	Workspace,
	Delegation,
	ChatMessage,
	AgentStudioSession,
	Connection,
	WorkspaceLayout,
	TaskBoardRecord,
	TaskBoardStatus,
	AgentExportData,
	OrchestrationPlan,
	PlanTask,
	ConfigMdCapability,
} from "./agentStudioTypes.js";

// --- Agent Studio Service ---

export const IAgentStudioService =
	createDecorator<IAgentStudioService>("agentStudioService");

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

	// Agent Model Config — persist provider/model/agent selection to agent.yaml
	updateEmployeeModelConfig(
		employeeId: string,
		config: { providerId: string; modelId: string; agentId?: string },
	): Promise<void>;
	getEmployeeModelConfig(
		employeeId: string,
	): Promise<
		{ providerId: string; modelId: string; agentId?: string } | undefined
	>;

	// Agent Canvas Position & Connections — persist to agent.yaml for reload survival
	updateEmployeePosition(
		employeeId: string,
		position: { x: number; y: number },
	): Promise<void>;
	getEmployeePosition(
		employeeId: string,
	): Promise<{ x: number; y: number } | undefined>;
	updateEmployeeConnections(
		employeeId: string,
		connections: Array<{
			id: string;
			sourceId: string;
			targetId: string;
			type: string;
			label?: string;
		}>,
	): Promise<void>;

	// Import / Export — portable agent instance bundles
	exportEmployee(id: string): Promise<AgentExportData>;
	importEmployee(
		data: AgentExportData,
		workspaceId?: string,
	): Promise<Employee>;
}

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
	| "questions";
	readonly content?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly metadata?: Record<string, unknown>;
	readonly progress?: number;
	readonly stage?: string;
	/** UI display name for tool card (from model's display_name field) */
	readonly displayName?: string;
	/** Render type for tool card (e.g. RunTerminal, CodeEditor, ListItems) */
	readonly renderType?: string;
	/** Whether to show this tool call card by default (default true) */
	readonly defaultShow?: boolean;
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

export interface IChatSendOptions {
	readonly model?: string;
	readonly agentId?: string; // selected Agent ID (e.g. Knot Agent)
	readonly systemPrompt?: string;
	readonly temperature?: number;
	readonly workspaceId?: string;
	/** Fork-scoped Agent session ID (undefined = Root default session) */
	readonly agentSessionId?: string;
	// allow-any-unicode-next-line
	/** 用户通过 /skill 命令显式激活的技能 ID 列表 */
	readonly explicitSkillIds?: readonly string[];
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
	cancelStream(employeeId: string, agentSessionId?: string): void;

	/** Append a message to the chat history for an employee and persist. */
	appendMessage(employeeId: string, message: ChatMessage): Promise<void>;
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

	getTasks(workspaceId?: string): Promise<TaskBoardRecord[]>;
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
		taskInfo?: { title: string; description?: string; assigneeId?: string; assigneeName?: string; sourceId?: string },
	): Promise<void>;

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
}

// --- ConfigMD Service ---

export const IConfigMdService =
	createDecorator<IConfigMdService>("configMdService");

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

export interface IConfigMdService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when the MD source has changed (from any origin).
	 * Subscribers should NOT trigger another write with the same content.
	 */
	readonly onDidChangeSource: Event<{
		employeeId: string;
		markdown: string;
		version: number;
		origin: ConfigMdChangeOrigin;
	}>;

	/**
	 * Fired when a new HTML render is available (after MD changes or explicit re-render).
	 */
	readonly onDidRenderHtml: Event<{
		employeeId: string;
		html: string;
		version: number;
		stylesContent?: string;
	}>;

	/**
	 * Fired when a model-issued command should be pushed to the HTML view.
	 */
	readonly onDidEmitCommand: Event<{
		employeeId: string;
		command: IConfigMdCommand;
	}>;

	/**
	 * Fired when an HTML view sends a custom event back to the agent.
	 */
	readonly onDidReceiveHtmlEvent: Event<{
		employeeId: string;
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
		employeeId: string;
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
	resolveState(employeeId: string): Promise<IConfigMdState | null>;

	/**
	 * Read the raw MD source for an agent.
	 */
	readSource(
		employeeId: string,
	): Promise<{ markdown: string; version: number }>;

	/**
	 * Overwrite the MD source. Triggers re-render & onDidChangeSource.
	 * Optimistic concurrency: if `baseVersion` is provided and stale, throws.
	 */
	writeSource(
		employeeId: string,
		markdown: string,
		options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
	): Promise<{ version: number }>;

	/**
	 * Apply a sequence of patches to the MD source.
	 */
	applyPatch(
		employeeId: string,
		patches: IConfigMdPatchOp[],
		options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
	): Promise<{ version: number; markdown: string }>;

	/**
	 * Render (or re-render) the HTML for an agent's current MD content.
	 * If `markdown` provided, render it without persisting.
	 */
	renderHtml(
		employeeId: string,
		markdown?: string,
	): Promise<{ html: string; version: number }>;

	/**
	 * Render the current MD into a complete standalone HTML document and write
	 * it to `<agentDir>/.preview.html`. Returns the absolute filesystem path
	 * so callers can open the file in the host editor.
	 */
	previewToFile(employeeId: string): Promise<{ path: string; version: number }>;

	// --- HTML Event Handling ---------------------------------------------

	/**
	 * Forward a custom HTML event to the agent's chat (and parse model commands).
	 */
	handleHtmlEvent(
		employeeId: string,
		eventName: string,
		payload: unknown,
		agentSessionId?: string,
	): Promise<void>;

	/**
	 * Send a chat message from the HTML view (capability: chat.send).
	 */
	handleChatSend(
		employeeId: string,
		message: string,
		options?: {
			context?: string;
			showInChat?: boolean;
			agentSessionId?: string;
		},
	): Promise<ChatMessage>;

	// --- Push to HTML view ----------------------------------------------

	sendCommandToHtml(employeeId: string, command: IConfigMdCommand): void;

	// --- Active Agent Session Registry -----------------------------------

	/**
	 * Register the agent session a chat panel is currently showing for a
	 * given employee. The HtmlPreviewEditorPane uses this when forwarding
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
		employeeId: string,
		agentSessionId: string | undefined,
	): void;

	/**
	 * Read the currently registered active agent session for an employee,
	 * or `undefined` if no chat panel has registered one.
	 */
	getActiveAgentSession(employeeId: string): string | undefined;

	// --- Capability Check -----------------------------------------------

	checkCapability(
		employeeId: string,
		capability: ConfigMdCapability,
	): Promise<void>;

	// --- Custom Parser / Styles Management -------------------------------

	/**
	 * Upload a custom MD→HTML parser script. Persists to agentDir/ui/parser.js,
	 * updates agent.yaml.configMd.parserPath, and triggers a re-render.
	 */
	uploadParser(
		employeeId: string,
		content: string,
		fileName?: string,
	): Promise<{ parserPath: string }>;

	/**
	 * Upload a custom CSS file. Persists to agentDir/ui/styles.css,
	 * updates agent.yaml.configMd.stylesPath, and triggers a re-render.
	 */
	uploadStyles(
		employeeId: string,
		content: string,
		fileName?: string,
	): Promise<{ stylesPath: string }>;

	/**
	 * Remove the custom parser, fall back to built-in parser, and trigger re-render.
	 */
	removeParser(employeeId: string): Promise<void>;

	/**
	 * Get current parser/styles info for the agent.
	 */
	getInfo(employeeId: string): Promise<{
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
	disposeAgent(employeeId: string): void;
}

