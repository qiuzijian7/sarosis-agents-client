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
	status?: 'running' | 'completed';
	displayName?: string;
	renderType?: string;
	defaultShow?: boolean;
	/** Text-buffer length when this tool started — used to interleave tool cards inside markdown */
	textPosition?: number;
	/** File path associated with this tool call (e.g., for edit_file tools) */
	filePath?: string;
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
}

/** Model info for model selector */
export interface IModelInfo {
	readonly id: string;
	readonly label: string;
	readonly provider: string;
	/** Whether the model supports image input (vision capability) */
	readonly supportsImages?: boolean;
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
