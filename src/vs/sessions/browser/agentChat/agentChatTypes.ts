/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent Chat — Type definitions (ported from saros-webui)

import { AgentStatus } from '../../common/agentStudioTypes.js';

/** Chat message with streaming/tool-call/thinking support */
export interface IAgentChatMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'system';
	content: string;
	readonly timestamp: number;
	isStreaming?: boolean;
	/** Precise stream phase (replaces boolean isStreaming for UI display) */
	streamPhase?: StreamPhase;
	/** Hermes turn id — shared by multiple assistant messages from same user request, used for aggregation */
	turnId?: string;
	toolCalls?: IToolCall[];
	/**
	 * 阶段E：有序内容片段（text|tool）。存在时作为渲染唯一真相，
	 * 按数组顺序遍历，取代 textPosition 交织。content/toolCalls 仍保留为派生兼容字段。
	 */
	parts?: IMessagePart[];
	thinking?: string;
	isThinking?: boolean;
	currentStep?: string;           // 'call_llm' | 'execute_tool' | custom
	tokenUsage?: { input: number; output: number; total: number };
	metadata?: Record<string, unknown>;
	attachments?: IChatAttachment[];
	subAgents?: ISubAgentData[];
	confirmation?: IConfirmationData;
	/** AskUser cards attached to this message (workflow interactive input) */
	askUsers?: ILiveWorkflowAskUser[];
	/** Todo list for task tracking */
	todos?: ITodoItem[];
	/** Suggested questions for user to ask */
	questions?: ISuggestedQuestion[];
	/** References used by AI (files, code, etc.) */
	references?: IReferenceItem[];
	/** Tip message (dismissible) */
	tip?: ITipMessage;
	/** Progress messages for tool execution */
	progress?: IProgressMessage[];
	/** LiveWorkflowTraceView: workflow executions attached to this message */
	workflowExecutions?: Record<string, ILiveWorkflowExecution>;
	/** LiveWorkflowTraceView: workflow events timeline */
	workflowEvents?: ILiveWorkflowEvent[];
	/** LiveWorkflowTraceView: collect variables requests */
	collectVariables?: Record<string, ILiveCollectVariable>;
}

/** File/image attachment for chat messages */
export interface IChatAttachment {
	id: string;
	type: 'image' | 'file';
	name: string;
	mimeType: string;
	data: string; // base64
	size: number;
	isPasted?: boolean;
}

/** Sub-agent spawned during a conversation turn */
export interface ISubAgentData {
	id: string;
	type: 'explore' | 'general' | 'scout';
	task: string;
	parentAgentId?: string;
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	progress?: string;
	output?: string;
	error?: string;
	groupId?: string;
	/** Enhanced blocks (matches React SubAgentCard block system) */
	inputBlocks?: ISubAgentBlock[];
	thinkingBlocks?: ISubAgentBlock[];
	toolTraces?: ISubAgentToolTrace[];
	outputBlocks?: ISubAgentBlock[];
}

export interface ISubAgentBlock {
	id: string;
	title?: string;
	content: string;
	collapsed?: boolean;
}

export interface ISubAgentToolTrace {
	id: string;
	name: string;
	status: 'running' | 'done' | 'error';
	args?: string;
	result?: string;
}

/** Ask/Confirmation data for interactive cards */
export interface IConfirmationData {
	id: string;
	title: string;
	message: string;
	detail?: string;
	buttons: Array<{ id: string; label: string; primary?: boolean; danger?: boolean }>;
	status: 'pending' | 'approved' | 'rejected' | 'cancelled';
	/** Security level badge */
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	/** Auto-confirm options (once/session/workspace/always) */
	autoConfirmOptions?: Array<{ id: string; label: string }>;
	/** Terminal command (for terminal confirmation cards) */
	command?: string;
	/** Tool call name (to identify terminal tools) */
	toolName?: string;
}

/** Tool call within a message */
export interface IToolCall {
	id: string;
	name: string;
	args?: string;
	result?: string;
	status?: 'running' | 'completed' | 'error';
	displayName?: string;
	renderType?: string;
	defaultShow?: boolean;
	/**
	 * @deprecated 阶段E 起改用有序 `IAgentChatMessage.parts`。仅迁移期可读。
	 */
	textPosition?: number;
	/** File path associated with this tool call (e.g., for edit_file tools) */
	filePath?: string;
	/** Execution duration in milliseconds */
	duration?: number;
	/** Error message if the tool failed */
	error?: string;
	/** Process exit code (for terminal tools) */
	exitCode?: number;
}

/** 文本内容片段（阶段E 有序模型） */
export interface ITextMessagePart {
	readonly kind: 'text';
	text: string;
}

/** 工具调用片段（阶段E 有序模型） */
export interface IToolMessagePart {
	readonly kind: 'tool';
	tool: IToolCall;
}

/**
 * assistant 消息有序片段。渲染按顺序遍历：文本段→markdown，工具段→工具卡。
 * 顺序即真相，无需 textPosition。
 */
export type IMessagePart = ITextMessagePart | IToolMessagePart;

/** 由有序片段派生扁平字段（content=文本拼接，toolCalls=工具列表）。 */
export function flattenMessageParts(parts: readonly IMessagePart[]): { content: string; toolCalls: IToolCall[] } {
	let content = '';
	const toolCalls: IToolCall[] = [];
	for (const p of parts) {
		if (p.kind === 'text') {
			content += p.text;
		} else {
			toolCalls.push(p.tool);
		}
	}
	return { content, toolCalls };
}

/**
 * 读取期迁移：由 content + 内嵌 toolCalls（含 textPosition）派生有序 parts。
 * 与持久化层 deriveMessageParts 同算法，但作用于 UI 侧 IToolCall。
 * 规则：positioned 工具按偏移切分文本；unpositioned 工具排在末尾；
 * 无工具时仅一个文本片段（content 非空）。
 */
export function deriveUiMessageParts(content: string, toolCalls: readonly IToolCall[]): IMessagePart[] {
	const text = content ?? '';
	const tcs = toolCalls ?? [];
	if (tcs.length === 0) {
		return text.length > 0 ? [{ kind: 'text', text }] : [];
	}
	const positioned = tcs
		.filter(tc => typeof tc.textPosition === 'number' && (tc.textPosition as number) >= 0)
		.slice()
		.sort((a, b) => (a.textPosition as number) - (b.textPosition as number));
	const unpositioned = tcs.filter(tc => typeof tc.textPosition !== 'number' || (tc.textPosition as number) < 0);

	const parts: IMessagePart[] = [];
	let lastPos = 0;
	for (const tc of positioned) {
		const pos = Math.min(Math.max(tc.textPosition as number, 0), text.length);
		if (pos > lastPos) {
			const seg = text.slice(lastPos, pos);
			if (seg.length > 0) { parts.push({ kind: 'text', text: seg }); }
		}
		parts.push({ kind: 'tool', tool: tc });
		lastPos = Math.max(lastPos, pos);
	}
	if (lastPos < text.length) {
		const seg = text.slice(lastPos);
		if (seg.length > 0) { parts.push({ kind: 'text', text: seg }); }
	} else if (positioned.length === 0 && text.length > 0) {
		parts.push({ kind: 'text', text });
	}
	for (const tc of unpositioned) {
		parts.push({ kind: 'tool', tool: tc });
	}
	return parts;
}

/** 将一个持久化 ToolCall（任意来源字段名）规整为 UI 的 IToolCall。 */
export function adaptPersistedToolCall(c: any, i: number): IToolCall {
	return {
		id: c?.id ?? `tc-${i}`,
		name: c?.name ?? 'tool',
		// 持久化字段名为 `arguments`，兼容历史可能写入的 `args`。
		args: typeof c?.arguments === 'string'
			? c.arguments
			: (typeof c?.args === 'string'
				? c.args
				: (c?.arguments !== undefined
					? JSON.stringify(c.arguments)
					: (c?.args !== undefined ? JSON.stringify(c.args) : undefined))),
		result: typeof c?.result === 'string' ? c.result : (c?.result ? JSON.stringify(c.result) : undefined),
		// 持久化 status 'running'|'done'|'error' → UI 'running'|'completed'|'error'（保留 error 失败态）。
		status: c?.status === 'running' ? 'running' : (c?.status === 'error' ? 'error' : 'completed'),
		// textPosition 仅供本次派生 parts 使用，不再向后传递。
		textPosition: typeof c?.textPosition === 'number' ? c.textPosition : undefined,
		displayName: typeof c?.displayName === 'string' ? c.displayName : undefined,
		renderType: typeof c?.renderType === 'string' ? c.renderType : undefined,
		defaultShow: typeof c?.defaultShow === 'boolean' ? c.defaultShow : undefined,
		error: typeof c?.error === 'string' ? c.error : undefined,
		filePath: typeof c?.filePath === 'string' ? c.filePath : undefined,
		duration: typeof c?.duration === 'number' ? c.duration : undefined,
		exitCode: typeof c?.exitCode === 'number' ? c.exitCode : undefined,
	};
}

/**
 * 统一的持久化消息 → 面板消息适配（阶段E：两个宿主共用入口）。
 * - 过滤独立 'tool' 角色消息（返回 null）；工具卡片由 assistant 的有序 parts 承载。
 * - assistant 消息总是带 parts（优先用已存的 parts，否则由 content+toolCalls 派生）。
 * 调用方：`history.map(adaptPersistedChatMessage).filter((m): m is IAgentChatMessage => !!m)`。
 */
export function adaptPersistedChatMessage(m: any): IAgentChatMessage | null {
	if (!m) { return null; }
	if (m.role === 'tool') { return null; }
	const role: IAgentChatMessage['role'] = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'assistant' : 'system');
	const ts = (() => {
		const t = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : Number(m.timestamp);
		return Number.isFinite(t) ? t : Date.now();
	})();
	const toolCalls: IToolCall[] | undefined = Array.isArray(m.toolCalls)
		? m.toolCalls.map((c: any, i: number) => adaptPersistedToolCall(c, i))
		: undefined;

	let parts: IMessagePart[] | undefined;
	if (role === 'assistant') {
		if (Array.isArray(m.parts) && m.parts.length > 0) {
			// 新格式：parts 已落盘，工具片段内的 tool 字段同样规整为 IToolCall。
			parts = m.parts.map((p: any): IMessagePart =>
				p?.kind === 'tool'
					? { kind: 'tool', tool: adaptPersistedToolCall(p.tool, 0) }
					: { kind: 'text', text: typeof p?.text === 'string' ? p.text : '' }
			);
		} else {
			// 旧格式：由 content + toolCalls(textPosition) 派生。
			parts = deriveUiMessageParts(m.content ?? '', toolCalls ?? []);
		}
	}

	return {
		id: m.id,
		role,
		content: m.content ?? '',
		timestamp: ts,
		turnId: m.turnId,
		thinking: m.thinking,
		toolCalls,
		parts,
		isStreaming: m.isStreaming,
		streamPhase: m.streamPhase,
		metadata: m.metadata,
		tokenUsage: m.tokenUsage,
	};
}

/** Status display mapping */
export const STATUS_MAP: Record<AgentStatus, { label: string; color: string; bg: string; dot: string; animated: boolean }> = {
	[AgentStatus.Idle]:     { label: '空闲',   color: '#9ca3af',  bg: 'rgba(255,255,255,0.05)', dot: '#9ca3af',  animated: false },
	[AgentStatus.Working]:  { label: '工作中', color: '#4ade80',  bg: 'rgba(74,222,128,0.08)',  dot: '#4ade80',  animated: true  },
	[AgentStatus.Thinking]: { label: '思考中', color: '#7cb9ff',  bg: 'rgba(124,185,255,0.08)', dot: '#7cb9ff',  animated: true  },
	[AgentStatus.Error]:     { label: '出错',   color: '#e94560',  bg: 'rgba(233,69,96,0.08)',   dot: '#e94560',  animated: false },
	[AgentStatus.Offline]:   { label: '离线',   color: '#6b7280',  bg: 'rgba(255,255,255,0.02)', dot: 'rgba(255,255,255,0.2)', animated: false },
};

/** Agent info passed to the chat panel */
export interface IAgentInfo {
	readonly id: string;
	readonly name: string;
	readonly role: string;
	readonly avatarUrl?: string;
	/** Icon emoji for the agent (e.g. '🦞', '👨‍💻') — used as fallback when avatarUrl is not available */
	readonly icon?: string;
	readonly status: AgentStatus;
	readonly isPM?: boolean;
	readonly customPrompt?: string;
	readonly model?: string;
	readonly provider?: string;
	/** Agent type — only 'planner' supports plan mode */
	readonly agentType?: 'general' | 'planner' | string;
}

/** Provider info for model selector */
export interface IProviderInfo {
	readonly id: string;
	readonly label: string;
	/** Whether the provider supports agent selection (e.g. knot) */
	readonly supportsAgents?: boolean;
	/** Available agents for this provider (only if supportsAgents is true) */
	readonly agents?: IProviderAgentInfo[];
}

/** Agent info for provider's agent list */
export interface IProviderAgentInfo {
	readonly id: string;
	readonly name: string;
	readonly models?: string[];
}

/** Model info for model selector */
export interface IModelInfo {
	readonly id: string;
	readonly label: string;
	readonly provider: string;
	/** Whether the model supports image input (vision capability) */
	readonly supportsImages?: boolean;
	/** Maximum input tokens (context window limit) */
	readonly maxInputTokens?: number;
}

/** Stream phase — precise state machine for streaming lifecycle (Void-inspired 5-state model).
 *
 *  State transitions:
 *    idle → llm_streaming → tool_executing → llm_streaming → ... → idle
 *    idle → llm_streaming → awaiting_approval → tool_executing → ... → idle
 *    idle → llm_streaming → compressing → llm_streaming → ... → idle
 *    * → error → idle
 */
export type StreamPhase = 'idle' | 'llm_streaming' | 'tool_executing' | 'awaiting_approval' | 'compressing' | 'error';

/** Chat mode — mirrors webview ChatMode */
export type ChatMode = 'craft' | 'ask' | 'plan';

/** Mode option metadata for the composer mode dropdown */
export interface IModeOption {
	readonly id: ChatMode;
	readonly label: string;
	readonly description: string;
	readonly icon: string;       // SVG path d=
}

/** Header dropdown panel types (toolbar buttons) */
export type HeaderPanelType =
	| 'worktree'
	| 'message-nav'
	| 'history'
	| 'settings'
	| null;

/** Worktree info for header dropdown */
export interface IWorktreeItem {
	readonly path: string;
	readonly branch: string;
}

/** Lightweight summary of a user message — fed into the message-nav dropdown */
export interface IMessageNavItem {
	readonly id: string;
	readonly summary: string;
	readonly timestamp: number;
}

/** Session info bar payload */
export interface ISessionInfo {
	readonly mode: ChatMode;
	readonly superior?: { id: string; name: string };
	readonly subordinates?: ReadonlyArray<{ id: string; name: string }>;
	readonly taskCount: number;
}

/** Agent session metadata for the chat-history side panel */
export interface IAgentSessionMeta {
	readonly id: string;
	readonly name: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
}

/** Token usage snapshot used to render the context-usage ring */
export interface IContextUsage {
	readonly used: number;
	readonly limit: number;
	readonly percent: number; // 0-100
	readonly ratio: number;   // 0-1
}

/** Checkpoint info for the CheckpointBar */
export interface ICheckpointInfo {
	readonly id: string;
	readonly label: string;
	readonly timestamp: number;
	readonly fileCount: number;
	readonly files: ReadonlyArray<{ path: string; status: 'modified' | 'created' | 'deleted' }>;
}

// ── AskUser Card ─────────────────────────────────────────
// Interactive card for workflow user input

/** Lightweight option for AskUser card */
export interface IAskUserOption {
	readonly label: string;
	readonly description?: string;
}

/** AskUser entry — interactive card in workflow owner agent's chat */
export interface ILiveWorkflowAskUser {
	readonly id: string;              // `${executionId}:${nodeId}`
	readonly executionId: string;
	readonly nodeId: string;
	readonly nodeName: string;
	readonly question: string;
	readonly options: ReadonlyArray<IAskUserOption>;
	readonly multiSelect: boolean;
	selectedIndices: number[];
	readonly status: 'pending' | 'answered' | 'cancelled' | 'expired';
	readonly selection?: string | ReadonlyArray<string>;
	readonly createdAt: number;
	readonly answeredAt?: number;
}

// ── TodoList Card ────────────────────────────────────────

/** Todo item for TodoListCard */
export interface ITodoItem {
	readonly id: string;
	readonly label: string;
	readonly completed: boolean;
	readonly description?: string;
	readonly assignee?: string;
}

// ── QuestionCarousel Card ────────────────────────────────

/** Suggested question for QuestionCarouselCard */
export interface ISuggestedQuestion {
	readonly id: string;
	readonly label: string;
	readonly tooltip?: string;
	readonly category?: string;
}

// ── References Card ──────────────────────────────────────

/** Reference item for ReferencesCard */
export interface IReferenceItem {
	readonly id: string;
	readonly kind: 'file' | 'code' | 'url' | 'symbol' | 'text';
	readonly name: string;
	readonly uri?: string;
	readonly range?: { startLine: number; startCol: number; endLine: number; endCol: number };
	readonly description?: string;
	readonly state?: 'not-modified' | 'modified' | 'pending' | 'excluded';
}

// ── Tip Card ─────────────────────────────────────────────

/** Tip message for TipCard */
export interface ITipMessage {
	readonly id: string;
	readonly content: string;
	readonly icon?: string;
	readonly action?: {
		readonly label: string;
		readonly tooltip?: string;
		readonly actionId: string;  // callback identifier
	};
}

// ── Progress Card ────────────────────────────────────────

/** Progress message for ProgressCard */
export interface IProgressMessage {
	readonly id: string;
	readonly content: string;
	readonly status: 'pending' | 'in-progress' | 'completed' | 'error';
	readonly icon?: 'spinner' | 'check' | 'warning' | 'error';
	readonly timestamp?: string;
}

// ── LiveWorkflowTraceView Types ───────────────────────────

/** Sub-agent node in workflow execution trace */
export interface ILiveWorkflowSubAgent {
	readonly id: string;
	readonly name: string;
	readonly task?: string;
	readonly status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	readonly output?: string;
	readonly error?: string;
	readonly startTime: number;
	endTime?: number;
	/** Live streamed text (while running) */
	streamedText?: string;
	/** Live streamed thinking */
	streamedThinking?: string;
	/** Tool calls during execution */
	toolCalls?: Array<{ name: string; status: string; args?: string; result?: string }>;
}

/** Workflow execution trace */
export interface ILiveWorkflowExecution {
	readonly executionId: string;
	readonly workflowName: string;
	readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
	readonly currentNodeId?: string;
	readonly subAgents: ILiveWorkflowSubAgent[];
	readonly startTime: number;
	endTime?: number;
}

/** Collect variable for workflow (pre-execution input) */
export interface ILiveCollectVariable {
	readonly id: string;
	readonly executionId: string;
	readonly variables: Array<{ name: string; defaultValue?: string }>;
	readonly values: Record<string, string>;
	readonly status: 'pending' | 'submitted' | 'skipped';
	readonly createdAt: number;
}

/** Workflow event for timeline */
export interface ILiveWorkflowEvent {
	readonly id: string;
	readonly executionId: string;
	readonly sessionId: string;
	readonly timestamp: number;
	readonly kind: 'subagent_start' | 'delta' | 'subagent_end' | 'ask_user' | 'ask_user_end' | 'collect_variables' | 'collect_variables_end' | 'execution_end' | 'breakpoint_hit';
	readonly nodeId: string;
	readonly nodeName?: string;
	readonly nodeType?: string;
	readonly summary?: string;
	readonly ask?: string;
	readonly status?: string;
}

// ── TerminalConfirmationCard Types ───────────────────────────

/** Terminal command confirmation data */
export interface ITerminalConfirmation {
	readonly toolCallId: string;
	readonly command: string;
	readonly riskLevel: 'safe' | 'caution' | 'dangerous';
	readonly status: 'pending' | 'approved' | 'rejected';
}

/** Global unique message ID generator */
let _msgSeq = 0;
export function uniqueMsgId(): string {
	return `msg-${Date.now()}-${(++_msgSeq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Orchestration Plan Types (re-exported from agentStudioTypes) ───────────────────────────

export type { OrchestrationPlanStatus, PlanTaskStatus, TaskReviewStatus } from '../../common/agentStudioTypes.js';
export type { OrchestrationPlan, PlanTask, TaskComment } from '../../common/agentStudioTypes.js';

// ── Orchestration Plan Callback Types ─────────────────────────────────────

export interface IOrchestrationCallbacks {
	onApprovePlan: (planId: string) => void;
	onRejectPlan: (planId: string) => void;
	onApproveWithoutExecute: (planId: string) => void;
	onTaskAction: (planId: string, taskId: string, action: 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'block' | 'unblock') => void;
	onUpdatePlan: (planId: string, updates: Record<string, unknown>) => void;
	onUpdateTask: (planId: string, taskId: string, updates: Record<string, unknown>) => void;
	onDecomposeTask: (planId: string, taskId: string) => void;
	onClosePlanDialog: (planId: string) => void;
}

export { AgentStatus };
