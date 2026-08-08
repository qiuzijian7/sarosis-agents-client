/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { Event } from "../../base/common/event.js";
import { URI } from "../../base/common/uri.js";
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
	BoardLink,
	TaskAttachment,
	OrchestrationPlan,
	PlanTask,
	ConfigHtmlCapability,
} from "./agentStudioTypes.js";
import type { IWorktreeWorkspaceOptions } from "../contrib/worktree/common/worktreeTypes.js";

// --- Agent Preset type ---

/** Agent preset from .agent.md — for CreateAgentModal quick-preset panel. */
export interface AgentPreset {
	id: string;
	name: string;
	role: string;
	icon: string;
	description: string;
	model: string;
	systemPrompt: string;
	skills?: string[];
	tools?: string[];
	category?: string;
	source?: string;
}

// --- Agent folder install types ---

/** webkitdirectory 选择器产出的单个文件（相对路径已去掉根文件夹首段） */
export interface IAgentFolderUploadFile {
	/** POSIX 相对路径（如 `.agent.md`、`scripts/run.sh`） */
	readonly relativePath: string;
	readonly data: Uint8Array;
}

/** 从文件夹安装 agent 的结果 */
export interface IAgentInstallResult {
	readonly success: boolean;
	readonly agentId: string;
	readonly agentName: string;
	readonly error?: string;
}

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
	/** Request the KB view to refresh its tree (e.g. after background KB agent import completes). */
	requestKbRefresh(): void;
	/** Fired when the KB view should refresh (e.g. after background KB agent import). */
	readonly onDidRequestKbRefresh: Event<void>;
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
	/**
	 * 从 ~/.saros/agents/{id}/.agent.md 扫描生成 preset 列表，
	 * 供 CreateAgentModal 「快速创建」面板使用。与 agent 目录唯一真相源对齐。
	 */
	getAgentPresets(): Promise<AgentPreset[]>;
	/** Resolve the per-agent directory: ~/.saros/agents/{agentId}/ */
	getAgentDir(agentId: string): Promise<URI>;
	/** Resolve the OS user home directory path (e.g. /home/user). */
	resolveUserHome(): Promise<string>;
	/**
	 * Schema 驱动的智能内容分类（对齐 llm_wiki：LLM 依据活动 vault 的 kb-schema.json
	 * 进行语义类型判断，为唯一分类路径）。返回最匹配的类型 + 置信度。
	 * LLM 不可用时安全降级为 schema 默认类型（source='fallback'），不做关键词猜测。
	 */
	classifyContent(content: string): Promise<{ category: string; label: string; confidence: number; reasoning: string; source: 'llm' | 'fallback' }>;

	/**
	 * Hyper-Extract 风格技能提取：用 LLM structured output 判断内容是否值得沉淀为技能。
	 * isSkill=false 时直接拒绝；isSkill=true 时返回完整的 name/description/prompt/scripts。
	 * 失败时自动降级到纯启发式提取（extractSkillComponents）。
	 */
	extractSkillContent(content: string, opts?: { providerId?: string; modelId?: string }): Promise<{ isSkill: boolean; name: string; description: string; prompt: string; category?: string; scripts?: Array<{ filename: string; content: string; language: string }>; source: 'llm' | 'heuristic'; reason: string }>;

	createAgent(data: Partial<Agent>): Promise<Agent>;
	updateAgent(id: string, data: Partial<Agent>): Promise<void>;
	deleteAgent(id: string): Promise<void>;
	/**
	 * 从本地文件夹安装 agent：文件夹根目录需包含 `.agent.md`。
	 * 整体复制到 `~/.vssaros/agents/<id>/`（过滤 .git/__pycache__/node_modules 等垃圾），
	 * 初始化 .git 版本管理并触发 onDidChangeAgents。
	 * id 冲突（已存在同 id agent）时拒绝安装。
	 * @param files webkitdirectory 选择器产出的相对路径文件列表（已去掉根文件夹首段）
	 */
	installAgentFromFolder(files: readonly IAgentFolderUploadFile[]): Promise<IAgentInstallResult>;
	/**
	 * 判定当前登录用户是否可上传（发布到商城）该 agent。
	 * - 内置 agent（source==='builtin'）不可上传（系统资产）。
	 * - owner 为空：允许认领式上传（兼容存量 / 未登录创建的 agent）。
	 * - owner 非空：仅 owner 本人可上传，避免多人维护时互相覆盖。
	 */
	canUploadAgent(agent: Agent): boolean;
	/** 当前登录用户的内部 ID（taihu:staffid:xxx），未登录返回 undefined */
	readonly currentUserId: string | undefined;
	/** 上传成功后认领 owner：把 agent.owner 设为当前用户（用于存量 agent 首次上传）。 */
	claimAgentOwnership(agentId: string): Promise<void>;
	getLastSelectedAgentId(): Promise<string | null>;
	setLastSelectedAgentId(id: string | null): Promise<void>;

	// Agent Bindings — per-(workspace × agent) runtime instance state.
	// `Agent` is a global definition; bindings hold workspace-local runtime
	// state (worktree, agentDir, memoryConfig) so the same agent running in two
	// workspaces never clobbers the other. Persisted at
	// `{workspace}/.sarosworkspace/agent-bindings.json` keyed by agentId.
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
	 * Returns array of worktree items with optional change counts.
	 */
	getWorktrees(workspaceId: string): Promise<Array<{
		path: string;
		branch: string;
		outgoingChanges?: number;
		incomingChanges?: number;
		uncommittedChanges?: number;
	}>>;

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
	| "assistant_turn" // Hermes-style 消息边界：agentOS 每个 iteration 的 assistant 边界，供 chatService 按回合切分持久化
	| "tool_approval_request"
	| "tool_approval_resolved"
	| "ask_user_start"
	| "ask_user_progress"
	| "todo_list"
	| "question_carousel"
	| "tip"
	| "workflow_start"
	| "workflow_end"
	| "workflow_subagent_start"
	| "workflow_subagent_end"
	| "workflow_delta"
	| "workflow_ask_user"
	| "workflow_ask_user_end"
	| "workflow_collect_variables"
	| "workflow_collect_variables_end"
	| "workflow_breakpoint_hit"
	| "memory_extracted"
	| "memory_writing" | "memory_written" | "memory_write_failed"
	| "memory_episodic_extracted" | "memory_semantic_extracted" | "memory_procedural_extracted"
	| "memory_injected"
	| "skill_extracted"
	| "codebase_operation";
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
	/** Text position offset for tool call in the message content (used for rendering). */
	readonly textPosition?: number;
	/** Security level for tool approval requests. */
	readonly securityLevel?: string;
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
		/** Total tokens (some gateways provide total_tokens in final chunk; defaults to input+output). */
		readonly totalTokens?: number;
		/** Reasoning tokens (OpenAI `completion_tokens_details.reasoning_tokens`, 对齐子代理 subagentTokenCollector.reasoningTokens 口径). */
		readonly reasoning?: number;
		/** Billing credits consumed by this call (from gateway final-chunk usage.credit, e.g. CodeBuddy). */
		readonly credit?: number;
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
		readonly autoConfirmOptions?: Array<{ readonly id: string; readonly label: string }>;
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
	/** Tool arguments (for tool_approval_request delta type) */
	readonly toolArgs?: string;
	/** AskUser fields (for ask_user_start/ask_user_progress delta types) */
	readonly askUserId?: string;
	readonly executionId?: string;
	readonly nodeId?: string;
	readonly nodeName?: string;
	readonly question?: string;
	readonly options?: Array<{ readonly label: string; readonly description?: string }>;
	readonly multiSelect?: boolean;
	readonly status?: string;
	readonly selection?: string | string[];
	/** Todos (for todo_list delta type) */
	readonly todos?: Array<{ readonly id: string; readonly label: string; readonly completed: boolean; readonly description?: string; readonly assignee?: string }>;
	/** Questions (for question_carousel delta type) */
	readonly questions?: Array<{ readonly id: string; readonly label: string; readonly tooltip?: string; readonly category?: string }>;
	/** Tip fields (for tip delta type) */
	readonly tipId?: string;
	readonly icon?: string;
	readonly action?: { readonly label: string; readonly tooltip?: string; readonly actionId?: string };
	/** Workflow fields */
	readonly workflowName?: string;
	readonly currentNodeId?: string;
	readonly subAgentName?: string;
	readonly task?: string;
	readonly output?: string;
	readonly error?: string;
	readonly thinking?: string;
	readonly eventId?: string;
	readonly sessionId?: string;
	readonly nodeType?: string;
	readonly collectId?: string;
	readonly variables?: Array<{ name: string; defaultValue?: string }>;
	readonly values?: Record<string, string>;
	readonly summary?: string;
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
	/**
	 * 用户通过 /workflow <id>（别名 /wf）或 bare /{wf-xxx} 命令触发的工作流执行请求。
	 * 设置后本 turn 进入工作流模式：控制权交给 DAG，按工作流配置严格逐节点执行，
	 * 工作流结束即 turn 结束，最终输出锚定为本 turn 的 assistant 回答。
	 */
	readonly workflowTrigger?: {
		readonly workflowId: string;
		readonly input?: string;
	};
	/** @deprecated 已移除 ChatMode（craft/plan/ask/workflow）。改为 chatOnly 开关。 */
	readonly chatMode?: ChatMode;
	/** Chat-only 模式开关（开启时禁用写文件工具，React 范式下同时禁用 delegate_task）。默认关闭。 */
	readonly chatOnly?: boolean;
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
	/** Mark this message as a programmatic task execution so it skips de-duplication
	 *  in appendMessage (P2-7 fix).  Human-typed messages default to source='user'. */
	readonly source?: 'user' | 'task';
	/** Structured task card data — when set, the renderer builds the task prompt
	 *  card from this data instead of regex-parsing the text content. */
	readonly taskCard?: import('../common/agentStudioTypes.js').TaskCardData;
	/**
	 * Fork 前缀缓存上下文（MiMo ForkContext）。fork 会话经 session.forkContext 透传，
	 * 使本请求 (system+tools) 与父级冻结前缀对齐 → 请求构造端注入 cache 断点、命中
	 * provider prompt cache。非 fork 会话省略 → undefined（零行为变更）。
	 */
	readonly forkContext?: import('../contrib/agentStudio/common/forkContext.js').IForkContext;
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

/**
 * Task execution info — passed from the task board to the orchestration
 * service when a task transitions to 'running'.  Contains the task metadata
 * needed to construct the LLM prompt and select the provider/model.
 */
export interface ITaskExecutionInfo {
	readonly title: string;
	readonly description?: string;
	readonly assigneeId?: string;
	readonly assigneeName?: string;
	readonly sourceId?: string;
	readonly worktreePath?: string;
	readonly workflowId?: string;
	readonly variableValues?: Record<string, string>;
	readonly attachments?: IChatAttachmentSend[];
	/** LM provider override (e.g. 'codebuddy'). When set together with modelId,
	 *  overrides the agent's default provider for this single execution. */
	readonly providerId?: string;
	/** Model ID override (e.g. 'deepseek-v4-pro-ioa'). */
	readonly modelId?: string;
}

export interface IAgentChatService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when the agent session list for any agent changes
	 * (session created, renamed, deleted, or updated).
	 * The payload carries the agentId whose sessions changed.
	 */
	readonly onDidChangeAgentSessions: Event<{ agentId: string }>;

	/**
	 * Fired for every delta during any sendMessage call (task execution, user chat, etc.).
	 * Allows external panels (kanban, task overview) to observe streaming in real-time.
	 */
	readonly onDidStreamDelta: Event<{ agentId: string; sessionId: string; delta: IChatStreamDelta }>;

	/**
	 * 广播一条 user 消息（本地发送、构造 userMsg 后立即调用），让同 agent + 同 session
	 * 的其它窗口（如 popout 独立窗口）同步显示该用户消息气泡。
	 * message 为发起 pane 构造的 IAgentChatMessage；此处用 unknown 避免 common 层
	 * 依赖 browser 层类型（agentChatTypes）。
	 */
	fireUserMessageAdded(agentId: string, sessionId: string, message: unknown): void;

	sendMessage(
		agentId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage>;

	getHistory(agentId: string, sessionId?: string): Promise<ChatMessage[]>;
	clearHistory(agentId: string, sessionId?: string): Promise<void>;
	cancelStream(agentId: string, agentSessionId?: string): void;

	/**
	 * 尝试获取会话跨实例锁（多开 --instance 同会话双开只读）。
	 * acquired=false 表示另一实例正在编辑（含持锁实例 ID）；锁过期自动接管。
	 */
	tryAcquireSessionLock(agentId: string, sessionId: string): Promise<{ acquired: boolean; holderInstanceId?: string }>;

	/** 释放当前持有的会话锁（仅删自己的锁）。 */
	releaseSessionLock(): Promise<void>;

	/** Append a message to the chat history for an agent and persist. */
	appendMessage(agentId: string, message: ChatMessage): Promise<void>;

	/**
	 * Update an existing message in the chat history (by id) and persist.
	 * Used by workflow trace updates (workflowExecutions/events/collectVariables)
	 * which modify an existing assistant message in-place.
	 */
	updateMessage(agentId: string, sessionId: string | undefined, messageId: string, updates: Partial<ChatMessage>): Promise<void>;

	/**
	 * Create a new agent session (e.g. for workflow execution isolation).
	 * Returns the session metadata including the session id.
	 */
	createAgentSession(agentId: string, name?: string): Promise<{ id: string; name: string; createdAt: string; updatedAt: string; messageCount: number }>;

	/**
	 * List all sessions for an agent.
	 * Returns array of session metadata sorted by updatedAt descending.
	 */
	listAgentSessions(agentId: string): Promise<Array<{ id: string; name: string; createdAt: string; updatedAt: string; messageCount: number }>>;

	/**
	 * Rename an agent session.
	 */
	renameAgentSession(agentId: string, sessionId: string, newName: string): Promise<void>;

	/**
	 * Delete an agent session and its message history.
	 */
	deleteAgentSession(agentId: string, sessionId: string): Promise<void>;

	/**
	 * Fork (deep-copy) an existing agent session into a brand-new session.
	 *
	 * Copies the full message history and any externalised tool-result sidecar
	 * files at the file level (fast, preserves refs) and registers a fresh
	 * session in the index. The fork gets a new id and deliberately drops the
	 * external provider thread binding (providerSessionId), so it can diverge
	 * without affecting the source session — the "试探性会话 / fork" primitive
	 * (aligns with LangGraph copy_thread).
	 */
	forkAgentSession(agentId: string, sessionId: string, newName?: string, parentForkContext?: import('../contrib/agentStudio/common/forkContext.js').IForkContext): Promise<{ id: string; name: string; createdAt: string; updatedAt: string; messageCount: number }>;

	/**
	 * Get the most recently active session for an agent.
	 * If no sessions exist, auto-create one.
	 * Returns the AgentSessionMeta of the active session.
	 */
	getOrCreateActiveSession(agentId: string, name?: string): Promise<{ id: string; name: string; createdAt: string; updatedAt: string; messageCount: number }>;

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

	/**
	 * Submit AskUser response (workflow interactive input).
	 */
	submitAskUser(agentId: string, sessionId: string, executionId: string, nodeId: string, selection: string | string[]): Promise<void>;

	/**
	 * Apply code to file (from AI-generated code).
	 */
	applyCode(agentId: string, sessionId: string, code: string, language: string, filePath?: string): Promise<void>;
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

	/** Fired when board hyperlinks are added or removed. */
	readonly onDidChangeBoardLinks: Event<void>;

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

	// ─── Board hyperlinks (看板超链接) ──────────────────────────────────
	/** List all pinned board hyperlinks. */
	listBoardLinks(): Promise<BoardLink[]>;
	/** Add a new board hyperlink by name + URL. */
	addBoardLink(name: string, url: string): Promise<BoardLink>;
	/** Update an existing board hyperlink's name and/or URL. */
	updateBoardLink(id: string, name: string, url: string): Promise<BoardLink>;
	/** Remove a board hyperlink by id. */
	removeBoardLink(id: string): Promise<void>;

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

	/**
	 * Download a URL to a local temp file and return its absolute path.
	 * Used by the TAPD-import flow and the task detail modal to fetch images/files
	 * from an authenticated source (e.g. a logged-in TAPD session). The download
	 * is delegated to the Playwright browser context that holds the auth cookies.
	 * Returns undefined if the download fails (caller should silently skip).
	 *
	 * @param opts.sessionId Playwright session id (defaults to the Saros Claw agent).
	 * @param opts.viewId Browser view id whose context provides the auth cookies.
	 *   When omitted, a tracked TAPD page is located automatically if possible.
	 */
	downloadUrlToTemp(url: string, opts?: { sessionId?: string; viewId?: string }): Promise<string | undefined>;

	/**
	 * Download a URL (e.g. a TAPD work-item attachment) through the Playwright
	 * browser context (so authenticated cookies are present) and return the file
	 * as base64 together with its inferred name, mimeType and a temp file path.
	 * The caller can attach the result to a task via `addAttachment`, or read the
	 * temp path / base64 for other uses. Returns `undefined` on failure or when
	 * the response is not a real file (e.g. an HTML login page).
	 *
	 * @param url The file URL to download.
	 * @param opts.sessionId Playwright session id (defaults to the Saros Claw agent).
	 * @param opts.viewId Browser view id whose context provides the auth cookies.
	 *   When omitted, a tracked TAPD page is located automatically if possible.
	 * @param opts.filename Override the saved file name (e.g. the TAPD attachment
	 *   name) instead of deriving it from the URL.
	 * @param opts.subDir Optional sub-directory (e.g. the TAPD task id) created
	 *   under the task-downloads root to namespace attachments per task.
	 * @param opts.extractZip When true (or auto-detected for `.zip` downloads),
	 *   the archive is extracted after download and `extractedFiles` lists its
	 *   entries (relative to the download root, with image entries embedded as
	 *   data URIs to bypass webview CSP).
	 */
	downloadUrlForAttachment(url: string, opts?: { sessionId?: string; viewId?: string; filename?: string; subDir?: string; extractZip?: boolean }): Promise<{
		name: string;
		mimeType: string;
		base64: string;
		tempPath: string;
		isZip?: boolean;
		extractedFiles?: { name: string; relPath: string; isImage: boolean; dataUri?: string }[];
	} | undefined>;
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
	 * Decompose a goal into tasks. Any agent can drive orchestration.
	 * Returns a plan in PendingApproval status.
	 */
	createPlan(
		goal: string,
		workspaceId: string,
		plannerId: string,
		agentSessionId?: string,
	): Promise<OrchestrationPlan>;

	/**
	 * Create a plan from pre-decomposed tasks (e.g. from Plan Mode's exit_plan_mode).
	 * Unlike createPlan(), this does NOT re-run AI decomposition — it persists the
	 * already-approved tasks directly. Dependencies may be referenced by task title
	 * or 1-based index.
	 * Returns a plan in PendingApproval status.
	 */
	createPlanFromTasks(
		goal: string,
		workspaceId: string,
		plannerId: string,
		tasks: Array<{
			title: string;
			description?: string;
			files?: string[];
			complexity?: string;
			suggestedRole?: string;
			dependencies?: string[];
		}>,
		agentSessionId?: string,
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
		taskInfo?: ITaskExecutionInfo,
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

/**
 * Simplified stream delta used by ConfigHtml streaming chat (Observable pattern).
 */
export interface ChatStreamDelta {
	readonly type: 'text' | 'thinking' | 'tool_start' | 'tool_end' | 'done';
	readonly content?: string;
	readonly fullText?: string;
	readonly toolName?: string;
	readonly toolArgs?: string;
	readonly toolResult?: string;
}

export const IConfigHtmlService =
	createDecorator<IConfigHtmlService>("configHtmlService");

/**
 * A command parsed from model output, destined for the ConfigHtml view.
 */
export interface IConfigHtmlCommand {
	readonly name: string;
	readonly params: Record<string, unknown>;
	readonly id: string;
}

/**
 * Origin of an HTML content change — used to suppress echo loops.
 */
export type ConfigHtmlChangeOrigin = "editor" | "html" | "model" | "external";

export interface IConfigHtmlService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when a new HTML render is available.
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
		command: IConfigHtmlCommand;
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
	 * Fired when an imgui button requests a chat send.
	 */
	readonly onDidRequestChatSend: Event<{
		agentId: string;
		message: string;
		agentSessionId?: string;
		workspaceId?: string;
		workspaceSessionId?: string;
	}>;

	/**
	 * 宿主侧触发一次聊天发送（等价于在预览里点击发送）。供原生 UI（如知识库视图按钮）调用，
	 * 自动按当前激活会话把消息发给指定 agent。
	 */
	requestChatSend(agentId: string, message: string): void;

	/**
	 * Fired when an LLM-origin write to config.html needs user confirmation.
	 * The UI layer should present a confirmation card and call
	 * `resolveModelWriteConfirm` with the user's decision.
	 */
	readonly onDidRequestModelWriteConfirm: Event<{
		requestId: string;
		agentId: string;
		contentLen: number;
		preview: string;
	}>;

	/**
	 * Resolve a pending model-write confirmation request.
	 */
	resolveModelWriteConfirm(
		requestId: string,
		decision: "approve" | "deny" | "always",
	): void;

	// --- Resource & State --------------------------------------------------

	/**
	 * Read the agent's `config.html` content.
	 */
	getHtml(agentId: string): Promise<{ html: string; version: number }>;

	/**
	 * Write the agent's `config.html` content.
	 */
	writeHtml(
		agentId: string,
		html: string,
		options?: { origin?: ConfigHtmlChangeOrigin; baseVersion?: number },
	): Promise<{ version: number }>;

	/**
	 * Render the current HTML into a standalone document and write to
	 * `<agentDir>/.preview.html`.
	 */
	previewToFile(agentId: string): Promise<{ path: string; version: number }>;

	/**
	 * ConfigHtml AI box — model generates a full self-contained HTML document.
	 */
	htmlGenerate(
		agentId: string,
		message: string,
		options?: { currentHtml?: string; model?: string },
	): Promise<{ html: string; raw: string }>;

	// --- HTML Event Handling ---------------------------------------------

	handleHtmlEvent(
		agentId: string,
		eventName: string,
		payload: unknown,
		agentSessionId?: string,
	): Promise<void>;

	handleChatSend(
		agentId: string,
		message: string,
		options?: {
			context?: string;
			showInChat?: boolean;
			agentSessionId?: string;
		},
	): Promise<ChatMessage>;

	// --- Terminal Execution ----------------------------------------------

	/**
	 * Run a command in the integrated terminal and return immediately.
	 * The terminal shows real-time stdout/stderr output.
	 * This is used by ConfigHtml to execute Python/Node/etc scripts
	 * with progress displayed in the VS Saros integrated terminal.
	 */
	handleRunTerminal(
		agentId: string,
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): Promise<void>;

	// --- Key-Value Data Store --------------------------------------------
	// Persistent KV storage at ~/.vssaros/agents/{agentId}/data/kv.json

	/** Read a value by key. Returns undefined if not found. */
	kvGet(agentId: string, key: string): Promise<unknown | undefined>;
	/** Write a value by key. Overwrites existing. */
	kvSet(agentId: string, key: string, value: unknown): Promise<void>;
	/** Delete a key. No-op if key doesn't exist. */
	kvDelete(agentId: string, key: string): Promise<void>;
	/** List all keys, optionally filtered by prefix. */
	kvList(agentId: string, prefix?: string): Promise<string[]>;

	// --- Push to HTML view ----------------------------------------------

	sendCommandToHtml(agentId: string, command: IConfigHtmlCommand): void;

	// --- Active Agent Session Registry -----------------------------------

	setActiveAgentSession(
		agentId: string,
		agentSessionId: string | undefined,
	): void;

	getActiveAgentSession(agentId: string): string | undefined;

	// --- Capability Check -----------------------------------------------

	checkCapability(
		agentId: string,
		capability: ConfigHtmlCapability,
	): Promise<void>;

	/**
	 * Dispose any per-agent watchers/state.
	 */

	// --- Streaming chat (Observable pattern) -------------------------------

	handleChatSendStream(
		requestId: string,
		agentId: string,
		message: string,
		onDelta: (delta: ChatStreamDelta) => void,
		onDone: (ok: boolean, fullText?: string, error?: string) => void,
		options?: { agentSessionId?: string },
	): Promise<void>;

	cancelStream(requestId: string, agentId: string): void;

	// --- Event for stream deltas (host → webview relay) -------------------

	readonly onStreamDelta: Event<{
		requestId: string;
		agentId: string;
		delta: ChatStreamDelta;
	}>;

	readonly onStreamDone: Event<{
		requestId: string;
		agentId: string;
		ok: boolean;
		fullText?: string;
		error?: string;
	}>;

	disposeAgent(agentId: string): void;
}

