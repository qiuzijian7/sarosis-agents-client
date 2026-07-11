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
	/** Target agent name (must match an existing Agent.name or ICustomAgent.name) */
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
export enum SandboxMode {
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
	/** Maximum tokens for a single model response (overrides Agent.maxTokens if set) */
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
export enum AgentTarget {
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
export enum AgentSource {
	/** Created locally by the user */
	Local = 'local',
	/** Part of the built-in preset collection */
	Builtin = 'builtin',
	/** Contributed by a VS Code extension */
	Extension = 'extension',
	/** Imported from external source (e.g. shared JSON) */
	Imported = 'imported',
}

export enum AgentStatus {
	Idle = 'idle',
	Working = 'working',
	Thinking = 'thinking',
	Error = 'error',
	Offline = 'offline',
}

export enum ConnectionType {
	Subagent = 'subagent',
	Collaboration = 'collaboration',
	DataFlow = 'data-flow',
}

export enum DelegationStatus {
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
export enum AgentType {
	/** Can decompose goals into sub-tasks. Multiple planners allowed per workspace. */
	Planner = 'planner',
	/** Regular worker agent — executes tasks. */
	Worker = 'worker',
}

/**
 * Portable export format for an agent instance.
 * Contains the agent definition metadata and all bootstrap/config files from the agent directory.
 * Used for import/export across workspaces.
 */
export interface AgentExportData {
	/** Export format version for forward compatibility */
	readonly version: 1;
	/** Timestamp of the export */
	readonly exportedAt: string;
	/** Agent definition (instance/runtime fields like id are not exported) */
	readonly agent: Partial<Agent>;
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
		/** ConfigHtml: HTML 源文件内容（用于跨工作区导入导出） */
		readonly configHtml?: string;
		/** ConfigHTML: 渲染后的 HTML 入口文件名（如 "index.html"） */
		readonly htmlEntry?: string;
		/** ConfigHTML: 渲染后的 HTML 内容 */
		readonly htmlContent?: string;
		/** ConfigHTML: 自定义样式内容 */
		readonly htmlStyles?: string;
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

/**
 * Agent — a chat-ready agent definition.
 * 所有 agent 定义的唯一数据源是 `~/.saros/agents/{agentId}/agent.json`
 * （初始安装时从内置预设落地，用户创建的 agent 也写入该目录）。
 *
 * Agents are NOT instantiated from presets —
 * the preset IS the agent.  There is no separate "deploy" / "create instance"
 * step; selecting an agent opens its chat directly.
 */
export interface Agent {
	readonly id: string;
	name: string;
	role: string;
	description: string;
	icon: string;
	avatar?: string;
	model: string;
	skills: string[];
	tools?: string[];
	/**
	 * 启用的工具集 ID 列表。
	 * 只发送属于这些工具集的工具给 LLM（空/未设置 = 全部工具集）。
	 *
	 * 对齐 Hermes 的 `agent.enabled_toolsets`：非代码类 Agent 可以只启用
	 * 相关工具集，减少无关工具对 LLM 的噪音。
	 *
	 * 可用值：core / mcp-bridge / tool-search / workflow / delegation /
	 *         memory / skill / browser / kanban / utility / mcp
	 */
	enabledToolsets?: string[];
	/**
	 * 禁用的工具集 ID 列表（减法，在 enabledToolsets 之后应用）。
	 *
	 * 对齐 Hermes 的 `agent.disabled_toolsets`：在 `enabled_toolsets` 之后
	 * 作为减法步骤应用，确保即使工具集被 enabled 包含也可以被禁用。
	 *
	 * **重要**：禁用的 toolset 中的工具**仅当**它们不在 Always 优先级的
	 * 核心 toolset（core / mcp-bridge / tool-search）中时才会被移除。
	 * 这是 Hermes `bundle_non_core_tools` 的核心保护机制。
	 */
	disabledToolsets?: string[];
	category: string;
	systemPrompt?: string;
	temperature?: number;
	handOffs?: IAgentHandOff[];
	hooks?: IAgentHooks;
	visibility?: IAgentVisibility;
	agents?: string[];
	confidenceThreshold?: number;
	parallelStrategy?: 'voting' | 'coverage';
	source: 'builtin' | 'custom';
	status?: AgentStatus;
	sortOrder?: number;

	/** 资源版本号（商城下载/升级溯源用，语义化版本） */
	version?: string;
	/** 商城 storeId（= slug，升级检查溯源用） */
	storeId?: string;

	/** Agent type: planner (can orchestrate) or worker (default). */
	agentType?: AgentType;

	/**
	 * Sandbox mode — controls the level of restriction on agent tool access.
	 * Part of the agent DEFINITION (same in every workspace), so it belongs on
	 * the global Agent. When set, it takes precedence over `tools` for access
	 * control (e.g. ReadOnly restricts to read-only tools regardless of `tools`).
	 */
	sandbox?: SandboxMode;

	// ── ⚠️ DO NOT add per-workspace runtime fields here ─────────────────────
	// `Agent` is a GLOBAL singleton definition: a given agent id (e.g. 'coder')
	// has exactly ONE record shared across every workspace. Per-(workspace×agent)
	// runtime state — workspaceId / worktreePath / worktreeBranch / agentDir /
	// memoryConfig.entries — is INSTANCE state and lives on `AgentBinding`
	// (persisted per workspace in agent-bindings.json). Putting instance state
	// on the global record causes last-write-wins corruption when the same agent
	// runs in multiple workspaces. See AgentBinding below.

	/**
	 * HTML-based config view.
	 * The `config.html` file is the single source of truth for the agent's
	 * interactive config panel in ConfigHtml.
	 * NOTE: this is part of the agent DEFINITION (same in every workspace),
	 * so it correctly belongs on the global Agent, not on AgentBinding.
	 */
	configHtml?: AgentConfigHtml;

	createdAt: string;
	updatedAt: string;
}

/**
 * AgentBinding — the per-(workspace × agent) runtime instance state.
 *
 * `Agent` is a global singleton definition; `AgentBinding` is the workspace-local
 * record that captures everything specific to running that agent inside ONE
 * workspace. Persisted at `{workspace}/.sarosworkspace/agent-bindings.json`
 * keyed by agentId, so two workspaces running the same agent never clobber each
 * other's worktree / memory / instance dir.
 *
 * Resolution at runtime: the driver only has `agentId` + `sessionId`; it resolves
 * the owning workspace via `getSession(sessionId).workspaceId`, then loads the
 * binding via `getAgentBinding(workspaceId, agentId)`.
 */
export interface AgentBinding {
	/** The global agent this binding instantiates. */
	readonly agentId: string;
	/** Workspace this binding belongs to. */
	readonly workspaceId: string;
	/** Git worktree directory this agent works in within this workspace (its isolated sandbox root). */
	worktreePath?: string;
	/** Branch name of the agent's worktree. */
	worktreeBranch?: string;
	/** Directory under {workspace}/.sarosworkspace/agents/{slug}/ holding instance files. */
	agentDir?: string;
	/**
	 * Memory configuration — controls L0/L1 recall + Persona injection at runtime.
	 * Per-workspace because persona `entries` and recall `scope` are instance state.
	 */
	memoryConfig?: AgentMemoryConfig;
	createdAt: string;
	updatedAt: string;
}

/**
 * Memory configuration shared by Agent.
 * Controls how the agent's L0/L1 memory is loaded and injected into prompts,
 * plus the user-maintained Persona Memory entries.
 */
export interface AgentMemoryConfig {
	enabled: boolean;
	maxEntries: number;
	strategy: 'summary' | 'full' | 'sliding_window';
	windowSize?: number;
	/**
	 * Recall scope:
	 *   - 'agent'     → only this agent's own L1 memory (strictest isolation)
	 *   - 'global'    → whole-library (cross-agent sharing)
	 * Defaults to 'agent' when undefined.
	 */
	scope?: 'agent' | 'global';
	entries: Array<{
		id: string;
		key: string;
		value: string;
		category?: string;
		createdAt?: string;
		updatedAt?: string;
	}>;
}

// allow-any-unicode-next-line
// ─── ConfigHtml (HTML config view) ───────────────────────────────────────

/**
 * Capability tokens that a ConfigHtml-rendered HTML view can request.
 */
export type ConfigHtmlCapability =
	| 'chat.send'           // Trigger sending a message to the model
	| 'chat.history'        // Read chat history
	| 'agent.status'        // Read agent status
	| 'agent.config'        // Read agent configuration (read-only)
	| 'notification'        // Show notifications in the Agent Studio UI
	| 'clipboard';          // Access clipboard (read/write)

/**
 * Agent's ConfigHtml configuration.
 * The agent maintains a self-contained HTML file (`htmlPath`) which is rendered
 * directly in the ConfigHtml preview panel.
 */
export interface AgentConfigHtml {
	/**
	 * ConfigHTML: HTML entry filename（relative to agentDir, e.g. "config.html"）.
	 */
	htmlPath?: string;

	/**
	 * ConfigHTML: HTML 资源安装目录（absolute path, set by installer）.
	 */
	htmlInstallDir?: string;

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
	 * - 'source': Show only the HTML source editor
	 */
	defaultView?: 'preview' | 'source';

	/** Whether the user can edit HTML source directly in the panel. Default: true. */
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

	/** Whether to auto-show the ConfigHtml panel when the agent is selected. Default: true. */
	autoShow?: boolean;

	/**
	 * Debounce delay (ms) for HTML edits before persisting to disk.
	 * Default: 300.
	 */
	syncDebounceMs?: number;
}

/**
 * A related code repository associated with a workspace.
 * Each entry maps to: one git root in SCM, one allowed root in the file sandbox,
 * and one folder root in the ActivityBar workspace tree.
 */
export interface RelatedFolder {
	/** Absolute path of the related folder. */
	readonly path: string;
	/** Display name (defaults to the directory basename). */
	name?: string;
	/** ISO timestamp when this folder was associated. */
	addedAt: string;
	/** Whether this folder is a git repository (probed at runtime; persistence optional). */
	isGitRepo?: boolean;
}

export interface Workspace {
	readonly id: string;
	name: string;
	description?: string;
	/**
	 * Workspace home directory. On creation this should point to an (ideally empty)
	 * folder used to store .sarosworkspace metadata, agent artifacts, worktrees, etc.
	 * Kept optional for backward compatibility with legacy "virtual" workspaces.
	 */
	path?: string;
	/**
	 * Associated local code repositories (core of multi-repo management).
	 * Each entry becomes a git root in SCM, an allowed sandbox root, and a tree root.
	 * Defaults to an empty array for legacy data (see migrateWorkspace).
	 */
	relatedFolders: RelatedFolder[];
	/** Agent definition IDs bound to this workspace. */
	agents: string[];
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
	/**
	 * File exclusion patterns sourced from a .code-workspace file's
	 * `settings.files.exclude`. When set, the workspace explorer tree
	 * hides entries matching these glob patterns (same semantics as
	 * VS Code's native files.exclude). Keys are glob patterns, values
	 * are boolean (true = excluded).
	 */
	filesExclude?: Record<string, boolean>;
}

/**
 * Normalize a possibly-legacy persisted workspace record into the current shape.
 * Backward-compatible & non-destructive: legacy records without `relatedFolders`
 * get an empty array; workspaces without `path` are kept (UI prompts to bind a home dir).
 */
export function migrateWorkspace(raw: any): Workspace {
	if (!raw || typeof raw !== 'object') {
		return raw as Workspace;
	}
	if (!Array.isArray(raw.relatedFolders)) {
		raw.relatedFolders = [];
	} else {
		// Sanitize entries: ensure each has a path and addedAt.
		raw.relatedFolders = raw.relatedFolders
			.filter((f: any) => f && typeof f.path === 'string' && f.path.length > 0)
			.map((f: any) => ({
				path: f.path,
				name: typeof f.name === 'string' ? f.name : undefined,
				addedAt: typeof f.addedAt === 'string' ? f.addedAt : new Date().toISOString(),
				isGitRepo: typeof f.isGitRepo === 'boolean' ? f.isGitRepo : undefined,
			}));
	}
	if (!Array.isArray(raw.agents)) {
		raw.agents = [];
	}
	return raw as Workspace;
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
	/** Message origin: 'user' = human-typed, 'task' = programmatic task execution.
	 *  Task messages skip de-duplication in appendMessage (P2-7 fix). */
	source?: 'user' | 'task';
	content: string;
	/** Agent 实例 ID。 */
	agentId?: string;
	/** Workspace Session (Fork) ID */
	sessionId?: string;
	/** Agent-level session ID within a Fork */
	agentSessionId?: string;
	toolCalls?: ToolCall[];
	/**
	 * 阶段E（数据模型根因重构）：assistant 消息的**有序内容片段**。
	 * 取代 `textPosition`（字符偏移）作为文本与工具卡交织的唯一真相——
	 * 渲染只需按 `parts` 数组顺序遍历，结构上不可能错位。
	 *
	 * 兼容策略：
	 * - 新写入的 assistant 消息总是带 `parts`；`content`/`toolCalls` 作为派生字段保留
	 *   （供 LLM 上下文拼接、token/checkpoint 等旧消费者读取）。
	 * - 旧数据无 `parts` 时，由 {@link deriveMessageParts} 在读取期按
	 *   `content` + `toolCalls.textPosition` 即时派生（非破坏性，不改磁盘）。
	 */
	parts?: MessagePart[];
	thinking?: string;
	timestamp: string;
	/**
	 * Hermes-style 回合标识（2026-06-05 治本根因修复）。
	 * 同一次用户请求触发的 agentOS 多轮 loop 会持久化多条 assistant 消息
	 * （每个 iteration 一条，content+toolCalls 紧跟其 tool 结果），它们共享
	 * 同一个 turnId。webview 据此把多条 assistant 聚合成一个气泡（UI 外观不变），
	 * 而磁盘/回灌时保持 assistant→tool→assistant 的正确因果链。
	 * 旧数据无此字段时，每条 assistant 各自独立成一个气泡（向后兼容）。
	 */
	turnId?: string;
	tokenUsage?: {
		input: number;
		output: number;
		total: number;
		/** KV Cache: tokens read from cache (Anthropic cache_read_input_tokens / OpenAI cached_tokens). */
		cached?: number;
		/** KV Cache: tokens written to cache (Anthropic cache_creation_input_tokens). */
		cacheWrite?: number;
		/** Tokens read from prompt cache (缓存命中, same as cached but explicit). */
		cachedRead?: number;
		/** Tokens NOT in cache that had to be processed fresh (缓存未命中). Computed if not provided. */
		cacheMiss?: number;
		/** Reasoning/thinking tokens (思考过程). */
		reasoning?: number;
		/** Cache hit rate as percentage, e.g. 51.6 for 51.6% (缓存命中率). */
		cacheHitRate?: number;
		/** Billing credits consumed by this turn (from gateway final-chunk usage.credit, e.g. CodeBuddy). */
		credit?: number;
	};
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
	/**
	 * v6: persisted sub-agent execution trace for a completed workflow run.
	 * Synthesized by the webview's `commitWorkflowExecution` and reloaded from
	 * disk on session restore so the SubAgentCard survives a window reload.
	 * Typed as `any[]` here because SubAgentInfo lives in the webview layer
	 * (useChatStore.ts) and is only consumed for UI rendering; the host treats
	 * it as opaque JSON for round-trip persistence.
	 */
	subAgents?: any[];
	/**
	 * v6: persisted AskUser answers for a completed workflow run. Same
	 * rationale as `subAgents` — webview-only rendering, opaque on the host.
	 */
	askUsers?: any[];
	/**
	 * Live workflow execution state keyed by executionId.
	 * Persisted so the workflow trace UI survives window reload.
	 * Opaque on the host; structured in the webview by LiveWorkflowExecution.
	 */
	workflowExecutions?: Record<string, any>;
	/**
	 * Ordered log of workflow lifecycle events (start, end, subagent_start, …).
	 * Persisted so the webview can rebuild the event log after reload.
	 */
	workflowEvents?: any[];
	/**
	 * Live collect-variable slots keyed by variable name.
	 * Persisted so the webview can restore partially-filled forms after reload.
	 */
	collectVariables?: Record<string, any>;
	/** Structured task metadata — when set, the chat renderer skips regex-based
	 *  prompt parsing and builds the task card directly from this data. */
	taskCard?: TaskCardData;
}

/** Structured task prompt card data — used by the chat renderer instead of
 *  regex-parsing the text content.  Eliminates the "serialize→regex-parse"
 *  anti-pattern. */
export interface TaskCardData {
	readonly title: string;
	readonly description: string;
	readonly source?: string;
	readonly taskId?: string;
	readonly dependencies?: readonly string[];
	/** Attachment file names for display (e.g. "tapd-img-1.png"). */
	readonly attachments?: readonly { name: string; mimeType: string }[];
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
	/**
	 * @deprecated 阶段E 起改用有序 `ChatMessage.parts` 作为交织真相。
	 * 本字段仅用于读取期把旧数据迁移成 `parts`（见 {@link deriveMessageParts}），
	 * 不再参与流式/渲染/落盘路径。
	 */
	textPosition?: number;
}

// ============================================================================
// 有序消息片段（阶段E：消除 textPosition 的根因模型）
// ============================================================================

/** 文本片段 */
export interface TextMessagePart {
	readonly kind: 'text';
	text: string;
}

/** 工具调用片段 */
export interface ToolMessagePart {
	readonly kind: 'tool';
	tool: ToolCall;
}

/**
 * assistant 消息的有序内容片段。渲染按数组顺序遍历：
 * 文本段 → markdown，工具段 → 工具卡。顺序即真相，无需 textPosition。
 */
export type MessagePart = TextMessagePart | ToolMessagePart;

/**
 * 读取期迁移器：把旧格式 assistant 消息（`content` + 内嵌 `toolCalls[textPosition]`）
 * 派生为有序 `parts`。非破坏性——不改磁盘，仅在内存重建顺序。
 *
 * 规则：
 * - 已有 `parts` 直接返回（新数据）。
 * - 有 textPosition 的工具按偏移把 `content` 切成交替的 text/tool 片段。
 * - 无 textPosition 的工具统一排在文本之后（与旧"unpositioned 末尾"渲染一致）。
 * - 非 assistant 或无工具的消息：仅一个文本片段（content 非空时）。
 */
export function deriveMessageParts(msg: Pick<ChatMessage, 'role' | 'content' | 'toolCalls' | 'parts'>): MessagePart[] {
	if (msg.parts && msg.parts.length > 0) {
		return msg.parts;
	}
	const content = msg.content ?? '';
	const toolCalls = msg.toolCalls ?? [];
	if (toolCalls.length === 0) {
		return content.length > 0 ? [{ kind: 'text', text: content }] : [];
	}

	const positioned = toolCalls
		.filter(tc => typeof tc.textPosition === 'number' && (tc.textPosition as number) >= 0)
		.sort((a, b) => (a.textPosition as number) - (b.textPosition as number));
	const unpositioned = toolCalls.filter(tc => typeof tc.textPosition !== 'number' || (tc.textPosition as number) < 0);

	const parts: MessagePart[] = [];
	let lastPos = 0;
	for (const tc of positioned) {
		const pos = Math.min(Math.max(tc.textPosition as number, 0), content.length);
		if (pos > lastPos) {
			const seg = content.slice(lastPos, pos);
			if (seg.length > 0) {
				parts.push({ kind: 'text', text: seg });
			}
		}
		parts.push({ kind: 'tool', tool: tc });
		lastPos = Math.max(lastPos, pos);
	}
	if (lastPos < content.length) {
		const seg = content.slice(lastPos);
		if (seg.length > 0) {
			parts.push({ kind: 'text', text: seg });
		}
	} else if (positioned.length === 0 && content.length > 0) {
		parts.push({ kind: 'text', text: content });
	}
	for (const tc of unpositioned) {
		parts.push({ kind: 'tool', tool: tc });
	}
	return parts;
}

/**
 * 由有序 `parts` 反推扁平派生字段（content = 文本段拼接，toolCalls = 工具段列表）。
 * 落盘时同步写入，保证旧消费者（LLM 上下文/token/checkpoint）仍可读。
 */
export function flattenMessageParts(parts: readonly MessagePart[]): { content: string; toolCalls: ToolCall[] } {
	let content = '';
	const toolCalls: ToolCall[] = [];
	for (const p of parts) {
		if (p.kind === 'text') {
			content += p.text;
		} else {
			toolCalls.push(p.tool);
		}
	}
	return { content, toolCalls };
}

export class AgentStudioSession {
	readonly id: string;
	name: string;
	workspaceId: string;
	/** Currently active agent id in this session. */
	activeAgentId?: string;
	createdAt: string;
	updatedAt: string;
	archived?: boolean;

	constructor(data: {
		id: string;
		name: string;
		workspaceId: string;
		activeAgentId?: string;
		createdAt: string;
		updatedAt: string;
		archived?: boolean;
	}) {
		this.id = data.id;
		this.name = data.name;
		this.workspaceId = data.workspaceId;
		this.activeAgentId = data.activeAgentId;
		this.createdAt = data.createdAt;
		this.updatedAt = data.updatedAt;
		this.archived = data.archived;
	}
}

export enum TaskBoardStatus {
	/** New: awaiting decomposition / refinement before it is actionable */
	Triage = 'triage',
	Todo = 'todo',
	/** New: refined and claimable, ready to start */
	Ready = 'ready',
	Running = 'running',
	/** New: blocked by a dependency or external condition */
	Blocked = 'blocked',
	Done = 'done',
	Cancelled = 'cancelled',
	Archived = 'archived',
}

export enum TaskSource {
	Manual = 'manual',
	Delegation = 'delegation',
	/** Imported from a TAPD workitem (story / bug / task) via the TAPD MCP. */
	Tapd = 'tapd',
	/** Created from a board hyperlink opened in the embedded editor window. */
	BoardLink = 'boardLink',
	/** Imported from a web page scraped via the integrated browser (web_scrape_to_board). */
	Web = 'web',
}

/**
 * A "看板超链接" (board hyperlink): an external board webpage the user can pin
 * to the task board. Clicking it opens the page in the integrated browser
 * (Electron WebContentsView, via IBrowserViewWorkbenchService), where the user
 * can right-click → "创建看板任务" to scrape items into the task board's 待办
 * column. The integrated browser shares the user's existing SSO/login state.
 */
export interface BoardLink {
	readonly id: string;
	name: string;
	url: string;
	createdAt: string;
}

export interface TaskBoardRecord {
	readonly id: string;
	title: string;
	description?: string;
	status: TaskBoardStatus;
	source: TaskSource;
	sourceId?: string; // delegation ID if source=delegation; TAPD URL if source=tapd; browser pageId if source=web
	/** Original TAPD workitem URL when the task was imported from TAPD. */
	tapdUrl?: string;
	/** Original web page URL when the task was imported from a web page (source=web). */
	sourceUrl?: string;
	/** User-provided reference URL (e.g. a TAPD story link) shown on the task card and editable via the task editor. */
	url?: string;
	assigneeId?: string;
	assigneeName?: string;
	worktreePath?: string;
	workspaceId: string;
	/**
	 * Board this task belongs to (multi-board isolation, P2).
	 * Absent/empty → implicitly belongs to the workspace's DEFAULT_BOARD_ID
	 * (backward compatible with tasks created before boards existed).
	 */
	boardId?: string;
	priority?: 'low' | 'medium' | 'high';
	/** IDs of tasks that must complete before this one can start */
	dependencies?: string[];
	/**
	 * File attachments linked to this task (P2). Only metadata is stored inline;
	 * the binary content lives in a side file under the data dir's `attachments/`
	 * folder (see AgentTaskBoardService), keyed by task id + attachment id.
	 */
	attachments?: TaskAttachment[];
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	/** v10: associated workflow ID (set when creating task with a workflow agent). */
	workflowId?: string;
	/** v11: user-provided values for workflow template variables ({{var}} patterns). */
	variableValues?: Record<string, string>;
	/** v12: LM provider to use for this task (e.g. 'codebuddy'). If unset, the agent's default provider is used. */
	providerId?: string;
	/** v12: Model ID to use for this task (e.g. 'deepseek-v4-pro-ioa'). If unset, the agent's default model is used. */
	modelId?: string;
}

/**
 * Metadata for a file attached to a task (multi-board / attachments, P2).
 * The actual bytes are persisted in a separate side file, not inline in JSON,
 * so large uploads never bloat taskboard.json.
 */
export interface TaskAttachment {
	readonly id: string;
	/** Original file name as uploaded by the user. */
	name: string;
	/** MIME type, e.g. 'image/png', 'application/pdf'. */
	mimeType: string;
	/** Size in bytes. */
	size: number;
	createdAt: string;
}

/**
 * The implicit default board every workspace has. Tasks without an explicit
 * boardId are treated as belonging to this board, so legacy data keeps working.
 */
export const DEFAULT_BOARD_ID = 'default';

/**
 * A board groups task cards within a workspace (multi-board isolation, P2).
 * Boards are scoped to a workspace: filtering tasks is `workspaceId` + `boardId`.
 */
export interface TaskBoard {
	readonly id: string;
	name: string;
	/** Owning workspace; boards never cross workspaces. */
	workspaceId: string;
	/** Display order in the board selector (ascending). */
	order?: number;
	createdAt: string;
	updatedAt: string;
}

// allow-any-unicode-next-line
// ─── Workspace Session (Fork) ───────────────────────────────────────────────

/**
 * Workspace mode
 * - root: Original workspace, canvas is fully editable
 * - fork: Branch created by scheduled task or manually, canvas is read-only
 */
export enum WorkspaceMode {
	Root = 'root',
	Fork = 'fork',
}

/**
 * Source of a Fork
 */
export enum WorkspaceSessionSource {
	/** Created automatically by a scheduled task */
	ScheduledTask = 'scheduled_task',
	/** Created manually by the user */
	Manual = 'manual',
}

/**
 * Runtime status of a Fork
 */
export enum WorkspaceSessionStatus {
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
	/** Agent instance ID (matches Agent.id) */
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
export enum OrchestrationPlanStatus {
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
export enum PlanTaskStatus {
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
export enum TaskReviewStatus {
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
	/** The agent assigned to this task — may be auto-created */
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

	/** LM provider override — when set with modelId, overrides the agent's
	 *  default provider for this task's sendMessage call. */
	providerId?: string;
	/** Model ID override — when set with providerId, overrides the agent's
	 *  default model for this task's sendMessage call. */
	modelId?: string;

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
	/** The planner agent who created this plan */
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
