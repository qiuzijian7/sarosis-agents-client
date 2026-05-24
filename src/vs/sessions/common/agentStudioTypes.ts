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
 * Agent type determines capabilities within a workspace.
 * - planner: Can decompose goals into tasks (orchestration). Multiple allowed per workspace.
 * - worker: Executes assigned tasks. No orchestration capabilities.
 */
export const enum AgentType {
	/** Can decompose goals into sub-tasks. Multiple planners allowed per workspace. */
	Planner = 'planner',
	/** Regular worker agent — executes tasks. */
	Worker = 'worker',
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
	// allow-any-unicode-next-line
	/** 技能 ID 列表 - agent 引用的技能 */
	skills?: string[];
	// allow-any-unicode-next-line
	/** 技能版本记录 - 记录每个技能的版本号，用于检测更新 */
	skillVersions?: Record<string, string>;
	// allow-any-unicode-next-line
	/** 缺失的技能数量（在技能库中找不到的技能） - 用于 UI 警告徽章 */
	skillErrorCount?: number;
	// allow-any-unicode-next-line
	/** 缺失的技能 ID 列表 - 用于 UI 对话框显示 */
	missingSkillIds?: string[];
	status: EmployeeStatus;
	/**
	 * Agent type: planner (can orchestrate), pm (can dispatch, max 1 per workspace), worker (default).
	 * Defaults to 'worker' if unset.
	 */
	agentType?: AgentType;
	teamId?: string;
	workspaceId?: string;
	position?: { x: number; y: number };
	/** LLM temperature (0-2), persisted per agent */
	temperature?: number;
	/** Max tokens for LLM response, persisted per agent */
	maxTokens?: number;
	/**
	 * Connections (edges) this agent participates in (as source or target).
	 * Persisted to employees.json so hierarchy survives window reload.
	 */
	connections?: Array<{ id: string; sourceId: string; targetId: string; type: string; label?: string }>;
	tokenUsage?: number;
	/** Path to the agent instance directory under .sarosisworkspace/agents/{slug}/ */
	agentDir?: string;
	/**
	 * Bootstrap templates from a preset, used when creating the agent instance directory.
	 * Not persisted to employees.json — only used during creation.
	 */
	bootstrapTemplates?: AgentBootstrapTemplates;
	/**
	 * ConfigMD — Markdown file as the canonical data source, rendered as HTML.
	 * The MD file is the single source of truth; the HTML view is computed from it.
	 * HTML interactions (clicks, form edits) are translated into patches that mutate
	 * the MD file, which then triggers re-rendering. Supports custom parser per agent.
	 */
	configMd?: AgentConfigMd;
	createdAt: string;
	updatedAt: string;
}

// allow-any-unicode-next-line
// ─── ConfigMD (Markdown ↔ HTML bidirectional sync) ────────────────────────────

/**
 * Capability tokens that a ConfigMD-rendered HTML view can request.
 * Only capabilities listed in the agent's `configMd.capabilities` are allowed.
 */
export type ConfigMdCapability =
	| 'md.read'             // Read the MD file content
	| 'md.write'            // Apply patches that mutate the MD file
	| 'chat.send'           // Trigger sending a message to the model
	| 'chat.history'        // Read chat history
	| 'agent.status'        // Read agent status
	| 'agent.config'        // Read agent configuration (read-only)
	| 'notification'        // Show notifications in the Agent Studio UI
	| 'clipboard';          // Access clipboard (read/write)

/**
 * Agent's ConfigMD configuration.
 * The agent maintains a Markdown file (`mdPath`) which is parsed (by built-in or
 * custom parser) into HTML. The MD↔HTML sync is bidirectional and real-time.
 */
export interface AgentConfigMd {
	/**
	 * Path to the Markdown source file, relative to agentDir.
	 * E.g. "config.md", "ui/dashboard.md".
	 * Defaults to "config.md" if omitted.
	 */
	mdPath: string;

	/**
	 * Optional path to a custom MD→HTML parser script, relative to agentDir.
	 * The script must export an object with a `parse(markdown, ctx)` function
	 * (and optionally `applyHtmlPatch`, `directives`).
	 * If omitted, the built-in parser (marked + DOMPurify + anchor handling) is used.
	 * E.g. "ui/parser.js".
	 */
	parserPath?: string;

	/**
	 * Optional path to a custom CSS file injected into the HTML preview, relative to agentDir.
	 * E.g. "ui/styles.css".
	 */
	stylesPath?: string;

	/**
	 * Panel display mode.
	 * - 'side': Show alongside the chat panel (split view)
	 * - 'replace': Replace the default chat panel entirely
	 * - 'tab': Show in an independent tab panel
	 */
	displayMode: 'side' | 'replace' | 'tab';

	/**
	 * Default view when the panel opens.
	 * - 'preview': Show only the HTML preview
	 * - 'source': Show only the MD source editor
	 * - 'split': Show MD editor and HTML preview side-by-side
	 */
	defaultView?: 'preview' | 'source' | 'split';

	/** Whether the user can edit MD source directly in the panel. Default: true. */
	editable?: boolean;

	/**
	 * Panel size configuration.
	 */
	size?: {
		width?: string;
		height?: string;
		minWidth?: string;
		minHeight?: string;
		resizable?: boolean;
	};

	/**
	 * iframe sandbox security level for the rendered HTML preview.
	 * - 'strict': sandbox="allow-scripts" (default)
	 * - 'standard': sandbox="allow-scripts allow-forms allow-popups"
	 * - 'permissive': sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
	 */
	sandboxLevel?: 'strict' | 'standard' | 'permissive';

	/** Whether to auto-show the ConfigMD panel when the agent is selected. Default: true. */
	autoShow?: boolean;

	/**
	 * Debounce delay (ms) for MD edits before triggering re-render and file write.
	 * Default: 300.
	 */
	syncDebounceMs?: number;

	/**
	 * Capability whitelist — only listed capabilities can be invoked by the HTML.
	 * Requests for unlisted capabilities are rejected.
	 */
	capabilities?: ConfigMdCapability[];
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
	/** Root/Fork management info */
	rootInfo?: WorkspaceRootInfo;
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

export interface ChatMessageMetadata {
	type: 'orchestration_plan';
	planId: string;
}

// Reference item for ReferencesCard (VS Code chatReferencesContentPart pattern)
export interface ReferenceItem {
	id: string;
	kind: 'file' | 'code' | 'url' | 'symbol' | 'text';
	name: string;
	uri?: string;
	range?: { startLine: number; startCol: number; endLine: number; endCol: number };
	description?: string;
	state?: 'not-modified' | 'modified' | 'pending' | 'excluded';
}

// Progress message for ProgressCard (VS Code chatProgressContentPart pattern)
export interface ProgressMessage {
	id: string;
	content: string;
	status: 'pending' | 'in-progress' | 'completed' | 'error';
	icon?: 'spinner' | 'check' | 'warning' | 'error';
	timestamp?: string;
}

// Confirmation button for ConfirmationCard
export interface ConfirmationButton {
	id: string;
	label: string;
	tooltip?: string;
	primary?: boolean;
	danger?: boolean;
	icon?: string;
}

// Confirmation request for ConfirmationCard (VS Code chatConfirmationContentPart pattern)
export interface ConfirmationRequest {
	id: string;
	title: string;
	message: string;
	detail?: string;
	buttons: ConfirmationButton[];
	status: 'pending' | 'approved' | 'rejected' | 'cancelled';
	icon?: string;
}

// Todo item for TodoListCard (VS Code chatTodoListWidget pattern)
export interface TodoItem {
	id: string;
	label: string;
	completed: boolean;
	description?: string;
	assignee?: string;
}

// Tip message for TipCard (VS Code chatTipContentPart pattern)
export interface TipMessage {
	id: string;
	content: string;
	icon?: string;
	action?: {
		label: string;
		tooltip?: string;
		actionId?: string;
	};
}

// Suggested question for QuestionCarouselCard (VS Code chatQuestionCarouselPart pattern)
export interface SuggestedQuestion {
	id: string;
	label: string;
	tooltip?: string;
	category?: string;
}

export interface ChatMessage {
	readonly id: string;
	role: 'user' | 'assistant' | 'tool' | 'system';
	content: string;
	employeeId: string;
	/** Workspace Session (Fork) ID */
	sessionId?: string;
	/** Agent-level session ID within a Fork */
	agentSessionId?: string;
	toolCalls?: ToolCall[];
	thinking?: string;
	timestamp: string;
	tokenUsage?: { input: number; output: number; total: number };
	/** Metadata for special message types (e.g., orchestration_plan for inline plan approval) */
	metadata?: ChatMessageMetadata;
	/** References used by AI (files, code, etc.) - VS Code chatReferencesContentPart pattern */
	references?: ReferenceItem[];
	/** Progress messages showing task execution status - VS Code chatProgressContentPart pattern */
	progress?: ProgressMessage | ProgressMessage[];
	/** Confirmation request requiring user approval - VS Code chatConfirmationContentPart pattern */
	confirmation?: ConfirmationRequest;
	/** Todo list for task tracking - VS Code chatTodoListWidget pattern */
	todos?: TodoItem[];
	/** Dismissible tips - VS Code chatTipContentPart pattern */
	tips?: TipMessage[];
	/** Suggested questions for user to ask - VS Code chatQuestionCarouselPart pattern */
	questions?: SuggestedQuestion[];
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
	/** IDs of tasks that must complete before this one can start */
	dependencies?: string[];
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

// allow-any-unicode-next-line
// ─── Workspace Session (Fork) ───────────────────────────────────────────────

/**
 * Workspace mode
 * - root: Original workspace, canvas is fully editable
 * - fork: Branch created by scheduled task or manually, canvas is read-only
 */
export const enum WorkspaceMode {
	Root = 'root',
	Fork = 'fork',
}

/**
 * Source of a Fork
 */
export const enum WorkspaceSessionSource {
	/** Created automatically by a scheduled task */
	ScheduledTask = 'scheduled_task',
	/** Created manually by the user */
	Manual = 'manual',
}

/**
 * Runtime status of a Fork
 */
export const enum WorkspaceSessionStatus {
	/** Created, waiting for execution */
	Pending = 'pending',
	/** Running */
	Running = 'running',
	/** Completed */
	Completed = 'completed',
	/** Error during execution */
	Error = 'error',
	/** Archived */
	Archived = 'archived',
}

/**
 * An Agent's session entry within a Fork.
 * Lazily created — only materialised when the Agent is actually invoked in this Fork.
 */
export interface AgentSessionEntry {
	/** Agent instance ID (matches Employee.id) */
	readonly agentId: string;
	/** This Agent's session ID within this Fork */
	readonly sessionId: string;
	/** Session creation time */
	readonly createdAt: string;
	/** Session last active time */
	updatedAt: string;
	/** Message count in this session */
	messageCount: number;
	/** Session status */
	status: 'active' | 'idle' | 'completed' | 'error';
}

/**
 * WorkspaceSession — a Fork instance of a Workspace.
 * Each scheduled task creates a Fork containing independent sessions for participating Agents.
 */
export interface WorkspaceSession {
	/** Unique ID, format: workspace_session_{shortId} */
	readonly id: string;
	/** Owning Workspace ID */
	readonly workspaceId: string;
	/** Display name (e.g. "Scheduled Task #3 - 2026-05-17") */
	name: string;
	/** Fork source */
	source: WorkspaceSessionSource;
	/** Associated scheduled task ID (if source = ScheduledTask) */
	scheduledTaskId?: string;
	/** Idempotency key to prevent duplicate forks on retry */
	idempotencyKey?: string;
	/** Fork runtime status */
	status: WorkspaceSessionStatus;
	/**
	 * Agent session entries in this Fork.
	 * Lazily populated — starts empty; entries added when an Agent is first invoked.
	 */
	agentSessions: AgentSessionEntry[];
	/**
	 * Snapshot of Agent IDs at Fork-creation time.
	 * Even if Root later adds/removes Agents, the Fork retains this snapshot.
	 */
	readonly snapshotAgentIds: string[];
	/** Creation time */
	readonly createdAt: string;
	/** Last update time */
	updatedAt: string;
	/** Completion time */
	completedAt?: string;
	/** Error message */
	error?: string;
}

/**
 * Root/Fork management info, attached to each Workspace.
 */
export interface WorkspaceRootInfo {
	/** Currently active Fork session ID, null = Root mode */
	activeSessionId: string | null;
	/** Current mode */
	mode: WorkspaceMode;
}

// allow-any-unicode-next-line
// ─── Task Orchestration ─────────────────────────────────────────────────────

/**
 * Status of an orchestration plan (the overall plan lifecycle).
 */
export const enum OrchestrationPlanStatus {
	/** Planner generated the plan, waiting for user approval */
	PendingApproval = 'pending_approval',
	/** User approved, executing agent creation & task dispatch */
	Approved = 'approved',
	/** Plan is being executed (agents created, tasks running) */
	Executing = 'executing',
	/** All tasks completed */
	Completed = 'completed',
	/** User rejected the plan */
	Rejected = 'rejected',
	/** Execution encountered an error */
	Error = 'error',
}

/**
 * Status of an individual planned task within an orchestration.
 */
export const enum PlanTaskStatus {
	/** Waiting for dependencies or approval */
	Pending = 'pending',
	/** Actively running */
	Running = 'running',
	/** Paused by user */
	Paused = 'paused',
	/** Completed successfully */
	Done = 'done',
	/** Cancelled by user */
	Cancelled = 'cancelled',
	/** Error during execution */
	Error = 'error',
}

/**
 * Task review status for human-in-the-loop approval workflow.
 */
export const enum TaskReviewStatus {
	/** Task is completed and waiting for human review */
	Pending = 'pending',
	/** Task has been reviewed and approved by human */
	Approved = 'approved',
	/** Task has been reviewed and rejected by human */
	Rejected = 'rejected',
}

/**
 * A comment on a task, used for human-in-the-loop collaboration.
 */
export interface TaskComment {
	/** Unique comment ID */
	readonly id: string;
	/** Author name or ID */
	author: string;
	/** Comment content */
	content: string;
	/** Creation timestamp */
	createdAt: string;
}

/**
 * A single task within an orchestration plan.
 * Each task has a unique ID, may depend on other tasks, and is assigned to an agent.
 */
export interface PlanTask {
	/** Unique task ID, format: orch_task_{shortId} */
	readonly id: string;
	/** Human-readable task name */
	title: string;
	/** Detailed description of what the agent should do */
	description?: string;
	/** Current task status */
	status: PlanTaskStatus;
	/** IDs of tasks that must complete before this one can start */
	dependencies: string[];
	/** The agent (employee) assigned to this task — may be auto-created */
	assigneeId?: string;
	/** Display name of the assigned agent */
	assigneeName?: string;
	/** Role of the agent (used for auto-creation) */
	assigneeRole?: string;
	/** Whether the agent needs to be auto-created (doesn't exist yet) */
	autoCreateAgent: boolean;
	/** Priority: 'critical'=0, 'high'=1, 'medium'=2, 'low'=3 */
	priority: number;
	/** Depth level in the dependency tree (computed by topological sort, 0 = root) */
	depth: number;
	/** Number of times this task has been retried after failure */
	retryCount: number;
	/** Maximum retry attempts before permanent failure (default: 3) */
	maxRetries: number;
	/** Timeout in ms; running tasks exceeding this are marked as error (default: 300000 = 5min) */
	timeoutMs: number;
	/** Result message on completion */
	result?: string;
	/** Error message if failed */
	error?: string;
	/** Timestamps */
	createdAt: string;
	startedAt?: string;
	completedAt?: string;

	// allow-any-unicode-next-line
	// ─── Human-in-the-Loop Fields ─────────────────────────────────────────────
	/** Whether this task needs human review after completion */
	needsReview?: boolean;
	/** Review status (pending/approved/rejected) */
	reviewStatus?: TaskReviewStatus;
	/** Review comment from human */
	reviewComment?: string;
	/** Human who reviewed this task */
	reviewedBy?: string;
	/** Review timestamp */
	reviewedAt?: string;
	/** Comments on this task (human-agent collaboration) */
	comments?: TaskComment[];
	/** Whether this task is blocked by human */
	isBlocked?: boolean;
	/** Reason why this task is blocked */
	blockedReason?: string;
	/** Human who blocked this task */
	blockedBy?: string;
	/** Block timestamp */
	blockedAt?: string;
}

/**
 * An orchestration plan generated by the planner.
 * Contains all tasks, their dependency graph, and the plan status.
 */
export interface OrchestrationPlan {
	/** Unique plan ID, format: orch_plan_{shortId} */
	readonly id: string;
	/** The original user goal that triggered this plan */
	goal: string;
	/** Summary of what the planner decided */
	summary: string;
	/** Overall plan status */
	status: OrchestrationPlanStatus;
	/** All tasks in this plan */
	tasks: PlanTask[];
	/** Workspace this plan belongs to */
	workspaceId: string;
	/** The planner agent (Employee) who created this plan */
	plannerId: string;
	/** Max number of tasks running concurrently (default: 3) */
	maxConcurrency: number;
	/** Timestamps */
	createdAt: string;
	updatedAt: string;
	/** Approval timestamp */
	approvedAt?: string;
	/** Completion timestamp */
	completedAt?: string;
}
