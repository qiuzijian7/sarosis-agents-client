/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// --- Shared Types for Agent Studio ---

// ─── Agent Interop Types (aligned with VS Code ICustomAgent) ─────────────────

/**
 * Declarative hand-off from one agent to another.
 * Aligned with VS Code's IHandOff format for .agent.md compatibility.
 */
export interface IAgentHandOff {
	/** Target agent name (must match an existing Employee.name or ICustomAgent.name) */
	readonly agent: string;
	/** Display label for the hand-off button */
	readonly label: string;
	/** Prompt sent to the target agent */
	readonly prompt: string;
	/** If true, automatically send without user confirmation */
	readonly send?: boolean;
	/** Switch to a specific model when handing off (qualified name, e.g. "GPT-5 (copilot)") */
	readonly model?: string;
}

/**
 * Lifecycle hooks for an agent.
 * Aligned with VS Code's ChatRequestHooks for .agent.md compatibility.
 * Extended with PreToolUse/PostToolUse for tool-level granularity.
 */
export interface IAgentHooks {
	/** Hooks that run when the agent starts */
	start?: IAgentHookEntry[];
	/** Hooks that run when the agent stops (completes or is cancelled) */
	stop?: IAgentHookEntry[];
	/** Hooks that run before each request is sent to the model */
	preRequest?: IAgentHookEntry[];
	/** Hooks that run after each model response */
	postRequest?: IAgentHookEntry[];
	/** Hooks that run when the agent stops as a sub-agent (remapped from stop in sub-agent context) */
	subagentStop?: IAgentHookEntry[];
	/**
	 * Hooks that run before each tool invocation.
	 * Aligned with VS Code's ChatRequestHooks.PreToolUse.
	 * Can inspect/modify tool arguments, or block the invocation entirely.
	 */
	preToolUse?: IAgentToolHookEntry[];
	/**
	 * Hooks that run after each tool invocation completes.
	 * Aligned with VS Code's ChatRequestHooks.PostToolUse.
	 * Can inspect/modify tool results, or trigger side effects.
	 */
	postToolUse?: IAgentToolHookEntry[];
}

/**
 * A single hook entry.
 */
export interface IAgentHookEntry {
	/** Type of the hook action */
	readonly type: 'prompt' | 'command' | 'script';
	/** The hook content (prompt text, command string, or script path) */
	readonly content: string;
	/** Optional description shown in the UI */
	readonly description?: string;
}

/**
 * A tool-level hook entry.
 * Extends IAgentHookEntry with tool-specific filtering and result modification.
 * Aligned with VS Code's PreToolUse/PostToolUse hook types.
 */
export interface IAgentToolHookEntry extends IAgentHookEntry {
	/**
	 * Optional tool name filter. If set, the hook only fires for tools
	 * whose name matches this pattern (supports glob-like patterns:
	 * - "readFile" — exact match
	 * - "read*" — prefix match
	 * - "*" — all tools (default)
	 */
	readonly toolPattern?: string;
	/**
	 * For PreToolUse hooks: if true, the hook can block the tool invocation.
	 * When the hook returns a non-empty result, the tool invocation is
	 * cancelled and the hook result is returned instead.
	 */
	readonly blockable?: boolean;
}

/**
 * Visibility control for an agent.
 * Mirrors VS Code's ICustomAgentVisibility.
 */
export interface IAgentVisibility {
	/** Show in the user-facing agent picker */
	readonly userInvocable: boolean;
	/** Can be invoked as a sub-agent by other agents */
	readonly agentInvocable: boolean;
}

/**
 * Sandbox mode for an agent.
 * Controls the level of restriction on agent tool access and file system operations.
 * Inspired by OpenHuman's SandboxMode and OpenClaw's AgentSandboxConfig.
 */
export const enum SandboxMode {
	/** No restrictions — agent can use all declared tools freely (default) */
	None = 'none',
	/** Read-only — agent can only read files and search, cannot edit/execute */
	ReadOnly = 'readOnly',
	/** Sandboxed — agent runs in a restricted environment with limited capabilities */
	Sandboxed = 'sandboxed',
}

/**
 * Model specification with fallback chain.
 * When the primary model is unavailable, the runtime tries fallback models in order.
 * Inspired by OpenClaw's `{primary, fallbacks}` and VS Code's `model: string[]`.
 *
 * Usage:
 * - Simple string: `'claude-sonnet-4-20250514'` — single model, no fallback
 * - Array: `['claude-sonnet-4-20250514', 'gpt-4o']` — primary + fallbacks
 * - Structured: `{ primary: 'claude-sonnet-4-20250514', fallbacks: ['gpt-4o'] }` — explicit chain
 */
export type ModelSpec = string | string[] | IModelChain;

/**
 * Structured model chain with explicit primary and fallback list.
 */
export interface IModelChain {
	/** Primary model to use */
	readonly primary: string;
	/** Fallback models tried in order when primary is unavailable */
	readonly fallbacks?: string[];
}

/**
 * Iteration and timeout limits for an agent session.
 * Prevents runaway agents from consuming excessive resources.
 * Inspired by OpenHuman's `max_iterations` / `timeout_secs` and Hermes' `max_iterations`.
 */
export interface IAgentLimits {
	/** Maximum number of tool-use iterations per request (default: 0 = unlimited) */
	readonly maxIterations?: number;
	/** Timeout in seconds for a single agent request (default: 0 = unlimited) */
	readonly timeoutSecs?: number;
	/** Maximum tokens for a single model response (overrides Employee.maxTokens if set) */
	readonly maxResponseTokens?: number;
}

/**
 * Skill directive file configuration.
 * Links an agent to a specific SKILL.md file that defines its skill behavior.
 * Unlike `skills: string[]` (which are lightweight IDs), a skill directive file
 * provides the full skill definition including prompt, triggers, and recommended tools.
 *
 * Inspired by Hermes/OpenClaw's SKILL.md format and OpenHuman's `SubagentEntry::Skills`.
 */
export interface ISkillDirective {
	/**
	 * Path to the SKILL.md file, relative to the agent instance directory.
	 * E.g. "skills/code-review.md" or "SKILL.md"
	 * The file follows the standard SKILL.md format with YAML frontmatter + Markdown body.
	 */
	readonly path: string;
	/**
	 * Whether to auto-activate this skill when the agent starts.
	 * If true, the skill's prompt is injected at the start of every session.
	 * Default: false.
	 */
	readonly autoActivate?: boolean;
	/**
	 * Activation mode override:
	 * - 'manual': Only activate on explicit `/skill <name>` command
	 * - 'auto': Activate when user message matches skill's `match` keywords
	 * - 'always': Inject in every turn
	 * If unset, uses the skill's own `activation` field.
	 */
	readonly activation?: 'manual' | 'auto' | 'always';
}

/**
 * Target platform for an agent definition.
 * Aligned with VS Code's ICustomAgent.target field for cross-platform agent compatibility.
 * Determines which platform(s) the agent's instructions and tool references are designed for.
 */
export const enum AgentTarget {
	/** Optimized for GitHub Copilot */
	Copilot = 'copilot',
	/** Optimized for VS Code native chat */
	VSCode = 'vscode',
	/** Optimized for Claude / Anthropic */
	Claude = 'claude',
	/** Platform-agnostic / universal (default) */
	Universal = 'universal',
}

/**
 * Agent source type, tracking where the agent definition originated.
 * Aligned with VS Code's IAgentSource for security auditing and trust decisions.
 */
export const enum AgentSource {
	/** Created locally by the user */
	Local = 'local',
	/** Part of the built-in preset collection */
	Builtin = 'builtin',
	/** Contributed by a VS Code extension */
	Extension = 'extension',
	/** Imported from external source (e.g. shared JSON) */
	Imported = 'imported',
}

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
		/** Skill directive files (SKILL.md format) */
		readonly skillDirectives?: Record<string, string>;
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
	/**
	 * Model specification — supports single model, fallback chain, or structured chain.
	 * - Simple: `'claude-sonnet-4-20250514'` (backward compatible)
	 * - Array: `['claude-sonnet-4-20250514', 'gpt-4o']` (primary + fallbacks)
	 * - Structured: `{ primary: 'claude-sonnet-4-20250514', fallbacks: ['gpt-4o'] }`
	 *
	 * When a model is unavailable, the runtime tries the next model in the chain.
	 * Aligned with VS Code's `model: string[]` and OpenClaw's `{primary, fallbacks}`.
	 */
	model?: ModelSpec;
	/** @deprecated Use `model` with ModelSpec instead. Kept for serialization compat. */
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
	/**
	 * Skill directive files — links this agent to specific SKILL.md files.
	 * Unlike `skills` (lightweight IDs), directive files contain the full skill
	 * definition including prompt, triggers, and recommended tools.
	 * Inspired by Hermes/OpenClaw's SKILL.md format.
	 */
	skillDirectives?: ISkillDirective[];
	/**
	 * Tool references bound to this agent (Sarosis internal tool names).
	 * Only declared tools are injected into the LLM; all others are disabled for this agent.
	 *
	 * Current tool names (22 total):
	 *   grep_search, list_dir, search_files, read_file, replace_in_file, edit_file,
	 *   write_to_file, terminal, use_mcp_tool, fetch_mcp_tools, grep_mcp_tools,
	 *   use_skill, read_image, capture_screen, web_preview, get_env_info,
	 *   generate_picture, read_history_context, grep_history_context, cron,
	 *   notify, display_download_links
	 *
	 * Legacy aliases expanded automatically:
	 *   vscode → write_to_file, list_dir, search_files, read_file
	 *   read   → read_file, list_dir, search_files, grep_search
	 *   execute → terminal
	 * Old internal names also supported:
	 *   file_read → read_file, file_write → write_to_file, file_list → list_dir,
	 *   read_skill → use_skill, list_skills → use_skill
	 *
	 * If undefined or empty, all tools are allowed (no restriction).
	 */
	tools?: string[];
	/**
	 * Declarative hand-offs to other agents.
	 * When this agent completes, it can suggest or auto-trigger a hand-off to another agent
	 * with a specific prompt. Compatible with VS Code's ICustomAgent.handOffs format.
	 */
	handOffs?: IAgentHandOff[];
	/**
	 * Lifecycle hooks scoped to this agent.
	 * Supports Start / Stop / PreRequest / PostRequest hook points.
	 * Compatible with VS Code's ChatRequestHooks format.
	 */
	hooks?: IAgentHooks;
	/**
	 * Visibility control: whether the agent is visible in the user picker
	 * and/or invocable as a sub-agent by other agents.
	 */
	visibility?: IAgentVisibility;
	/**
	 * Sub-agent allowlist: names of agents this agent can invoke.
	 * If undefined or ['*'], all agents are available.
	 * If empty array, no sub-agents can be used.
	 */
	agents?: string[];
	/**
	 * Target platform for this agent's instructions and tool references.
	 * Aligned with VS Code's ICustomAgent.target.
	 * Determines compatibility with different LLM platforms.
	 * Default: 'universal' (platform-agnostic).
	 */
	target?: AgentTarget;
	/**
	 * Source tracking — where this agent definition originated.
	 * Used for trust decisions, security auditing, and UI indicators.
	 * Aligned with VS Code's IAgentSource.
	 */
	source?: AgentSource;
	/**
	 * If source is 'extension', the ID of the contributing extension.
	 */
	extensionId?: string;
	/**
	 * Session types this agent is applicable to (e.g. 'agent-mode', 'edit-mode').
	 * Aligned with VS Code's ICustomAgent.sessionTypes.
	 */
	sessionTypes?: string[];
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
	 * Sandbox mode — controls the level of restriction on agent tool access.
	 * - None: No restrictions (default, backward compatible)
	 * - ReadOnly: Agent can only read/search, cannot edit or execute
	 * - Sandboxed: Agent runs in a restricted environment
	 *
	 * When SandboxMode is set, it takes precedence over `tools` for access control:
	 * - ReadOnly automatically restricts to read-only tools regardless of `tools`
	 * - Sandboxed uses the `tools` list but with additional safety constraints
	 *
	 * Inspired by OpenHuman's SandboxMode and OpenClaw's AgentSandboxConfig.
	 */
	sandbox?: SandboxMode;
	/**
	 * Iteration and timeout limits for this agent's sessions.
	 * Prevents runaway agents from consuming excessive resources.
	 * Inspired by OpenHuman's `max_iterations` / `timeout_secs` and Hermes' `max_iterations`.
	 */
	limits?: IAgentLimits;
	/**
	 * Whether this agent can run in background mode.
	 * Background agents can continue execution without blocking the user's session.
	 * Inspired by OpenHuman's `background: bool`.
	 */
	background?: boolean;
	/**
	 * Connections (edges) this agent participates in (as source or target).
	 * Persisted to employees.json so hierarchy survives window reload.
	 */
	connections?: Array<{ id: string; sourceId: string; targetId: string; type: string; label?: string }>;
	tokenUsage?: number;
	/** Path to the agent instance directory under .sarosisworkspace/agents/{slug}/ */
	agentDir?: string;
	/**
	 * Minimum confidence threshold (0-100) for the agent's output to be
	 * accepted without human review. Inspired by Feature-Dev's
	 * code-reviewer confidence scoring. Only report findings with
	 * confidence >= this value.
	 */
	confidenceThreshold?: number;
	/**
	 * Strategy for parallel execution of multiple instances of this agent.
	 * - undefined: no parallel strategy (single instance)
	 * - 'voting': launch N instances, compare results, pick best / merge
	 * - 'coverage': launch N instances with different focuses, merge all
	 */
	parallelStrategy?: 'voting' | 'coverage';
	/**
	 * Bootstrap templates from a preset, used when creating the agent instance directory.
	 * Not persisted to employees.json — only used during creation.
	 */
	bootstrapTemplates?: AgentBootstrapTemplates;
	/**
	 * Git worktree directory this agent works in.
	 * Inherits from Workspace.worktreePath if not set.
	 * Set this only when an agent needs its own isolated worktree.
	 */
	worktreePath?: string;
	/** Branch name of the agent's worktree (overrides workspace-level) */
	worktreeBranch?: string;
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
	/**
	 * Git worktree directory for agent isolation.
	 * When set, agents in this workspace work in this isolated directory.
	 * Compatible with opencode's worktree binding pattern.
	 */
	worktreePath?: string;
	/** Branch name of the associated worktree (e.g. "opencode/feature-auth") */
	worktreeBranch?: string;
	/**
	 * Lifecycle status of the worktree (pending/ready/failed).
	 * Not persisted — computed at runtime from IWorktreeService state.
	 */
	worktreeStatus?: 'none' | 'pending' | 'ready' | 'failed';
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
	type: 'orchestration_plan' | 'workflow';
	planId?: string;
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
	/** Plan-mode specific fields */
	type?: 'plan-approval';
	planSummary?: string;
	tasks?: Array<{
		title: string;
		description: string;
		files?: string[];
		complexity?: 'low' | 'medium' | 'high';
		suggestedRole?: string;
		dependencies?: number[];
	}>;
	nextMode?: 'craft' | 'ask';
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
	/** UI 显示名称（来自模型的 display_name 字段） */
	displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeEditor 等） */
	renderType?: string;
	/** 是否默认展开显示工具卡（默认 true） */
	defaultShow?: boolean;
	/** 工具已在服务端执行（如 Knot AG-UI），客户端不需要再执行 */
	serverExecuted?: boolean;
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

// ─── ModelSpec Utility Functions ────────────────────────────────────────────

/**
 * Resolve the primary model from a ModelSpec.
 * - String: returns the string itself
 * - Array: returns the first element
 * - IModelChain: returns primary
 */
export function getPrimaryModel(model: ModelSpec | undefined): string | undefined {
	if (!model) { return undefined; }
	if (typeof model === 'string') { return model; }
	if (Array.isArray(model)) { return model[0]; }
	return model.primary;
}

/**
 * Resolve the full fallback chain from a ModelSpec.
 * Returns an array of model identifiers in priority order (primary first).
 */
export function getModelChain(model: ModelSpec | undefined): string[] {
	if (!model) { return []; }
	if (typeof model === 'string') { return [model]; }
	if (Array.isArray(model)) { return model; }
	return [model.primary, ...(model.fallbacks ?? [])];
}
