/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Store (Zustand)
 *
 *  Phase 2: Chat streaming is now handled natively by NativeChatEditorPane.
 *  This store is retained ONLY for workflow trace state (liveWorkflowExecutions,
 *  liveWorkflowEvents, etc.) used by the WorkflowEditorPanel and index.tsx.
 *  The streamHandler import has been replaced with inline no-op stubs.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import { create } from 'zustand';
import { sendRequest, postMessage } from '../bridge/messageClient';
import { useAgentStore } from './useAgentStore';

// ── streamHandler stubs (Phase 2: streamHandler.ts deleted) ──
// These were chat streaming functions. Chat is now native; these are no-ops.
interface StreamState { [key: string]: unknown }
interface StreamError { [key: string]: unknown }
function subscribeStream(_a: string, _b: string, _h: object): () => void { return () => {}; }
function onStreamComplete(_a: string, _m: unknown): void {}
function getStreamState(_a: string): StreamState | null { return null; }
function resetStream(_a: string): void {}
function resetStreamSilent(_a: string): void {}
function switchActiveStream(_a: string): void {}
function buildChatMessagesFromState(): unknown[] { return []; }
function isPhaseActive(_p: string): boolean { return false; }

/**
 * Phantom tool names — DEPRECATED: visibility is now controlled solely by
 * `defaultShow`. Kept as empty set for backward compatibility.
 */
const PHANTOM_TOOL_NAMES = new Set<string>([]);

// ─── Live Workflow Execution (P4) ──────────────────────────────────────
// A workflow run attached to a specific owner-agent chat session. Rendered
// as a transient <SubAgentCard> at the bottom of the chat messages list.
// When execution ends, the run is committed as a permanent assistant message
// with `subAgents[]` so it survives page reload via chat.history.

export interface LiveWorkflowToolCall {
	id: string;
	name: string;
	arguments?: string;
	result?: string;
	status?: 'pending' | 'running' | 'done' | 'error';
}

export interface LiveWorkflowSubAgent {
	id: string;             // nodeId
	name: string;           // node label
	type: string;           // 'agent' | 'task' | 'prompt' | ...
	task: string;
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	/** Accumulated plain text from text deltas. */
	streamedText?: string;
	/** Accumulated thinking/reasoning content. */
	streamedThinking?: string;
	/** Tool calls emitted during this node (only for agent nodes). */
	toolCalls: LiveWorkflowToolCall[];
	/** Final output (set on subagent_end). */
	output?: string;
	error?: string;
	startTime: number;
	endTime?: number;
}

export interface LiveWorkflowExecution {
	executionId: string;
	workflowName: string;
	status: 'running' | 'completed' | 'failed' | 'cancelled';
	currentNodeId?: string;
	subAgents: LiveWorkflowSubAgent[];
	startTime: number;
	endTime?: number;
}

/**
 * P4 v4: a single AskUser request shown as an interactive card in the workflow
 * owner agent's chat. While `status === 'pending'` the card lets the user pick
 * an option (or several) and submit. Once `status === 'answered'` / 'cancelled' /
 * 'expired' the card flips to a read-only summary.
 */
export interface LiveWorkflowAskUser {
	id: string;              // `${executionId}:${nodeId}` — unique across the session
	executionId: string;
	nodeId: string;
	nodeName: string;
	question: string;
	options: IAskUserOption[];
	multiSelect: boolean;
	/** Indices into `options` (single-select: length 1, multi-select: ≥ 1). */
	selectedIndices: number[];
	status: 'pending' | 'answered' | 'cancelled' | 'expired';
	/** Final selection (option labels) once answered. */
	selection?: string | string[];
	createdAt: number;
	answeredAt?: number;
}

/** Lightweight option for AskUser card. Mirrors the host's IAskUserOption. */
export interface IAskUserOption {
	label: string;
	description?: string;
}

/**
 * v6: a pending variable collection shown as an interactive card in the
 * workflow owner agent's chat before execution starts. The user fills in
 * text values for each template variable and submits.
 */
export interface LiveCollectVariable {
	id: string;              // executionId (one per execution)
	executionId: string;
	variables: Array<{ name: string; defaultValue?: string }>;
	/** Currently entered values keyed by variable name. */
	values: Record<string, string>;
	status: 'pending' | 'submitted' | 'skipped';
	createdAt: number;
}

/**
 * v5b: a single entry in the execution timeline panel. Captured from the
 * trace event stream (subagent_start / delta / subagent_end / ask_user /
 * ask_user_end / execution_end). Cleared on page reload.
 */
export interface LiveWorkflowEvent {
	/** Unique id (auto-generated or `${executionId}:${nodeId}:${kind}`). */
	id: string;
	executionId: string;
	sessionId: string;
	/** Wall-clock time of the event (Date.now() at capture time). */
	timestamp: number;
	/** Event kind (mirrors IWorkflowTraceEvent['kind']). */
	kind: 'subagent_start' | 'delta' | 'subagent_end' | 'ask_user' | 'ask_user_end' | 'collect_variables' | 'collect_variables_end' | 'execution_end' | 'breakpoint_hit';
	nodeId: string;
	nodeName?: string;
	nodeType?: string;
	/** Optional human-readable text (delta content, ask question, error, etc.). */
	summary?: string;
	/** For subagent_start: the task description. */
	task?: string;
	/** For subagent_end: done or error. */
	status?: string;
}

export interface ChatMessageMetadata {
	type: 'orchestration_plan';
	planId: string;
}

// Per-file change summary for the checkpoint bar (matches host ICheckpointFileChange)
export interface CheckpointFileChange {
	uri: string;
	fileName: string;
	fsPath: string;
	additions: number;
	deletions: number;
}

// Checkpoint data for time-travel navigation (Void-inspired)
export interface CheckpointData {
	id: string;
	type: 'user_edit' | 'tool_edit' | 'message_boundary';
	timestamp: string;
	description?: string;
	filesChanged?: number;
	/** Detailed per-file changes (additions/deletions) — populated for tool_edit checkpoints. */
	files?: CheckpointFileChange[];
	isGhost?: boolean;
	isDisabled?: boolean;
	/** Set after the user clicks "保留" — the checkpoint bar should hide itself. */
	isKept?: boolean;
}

// Reference item for ReferencesCard
export interface ReferenceItem {
	id: string;
	kind: 'file' | 'code' | 'url' | 'symbol' | 'text';
	name: string;
	uri?: string;
	range?: { startLine: number; startCol: number; endLine: number; endCol: number };
	description?: string;
	state?: 'not-modified' | 'modified' | 'pending' | 'excluded';
}

// Progress message for ProgressCard
export interface ProgressMessage {
	id: string;
	content: string;
	status: 'pending' | 'in-progress' | 'completed' | 'error';
	icon?: 'spinner' | 'check' | 'warning' | 'error';
	timestamp?: string;
}

// Confirmation request for ConfirmationCard
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

export interface ConfirmationButton {
	id: string;
	label: string;
	tooltip?: string;
	primary?: boolean;
	danger?: boolean;
	icon?: string;
}

// Todo item for TodoListCard
export interface TodoItem {
	id: string;
	label: string;
	completed: boolean;
	description?: string;
	assignee?: string;
}

// Tip message for TipCard
export interface TipMessage {
	id: string;
	content: string;
	icon?: string;
	action?: {
		label: string;
		tooltip?: string;
		onClick: () => void;
	};
}

// Suggested question for QuestionCarouselCard
export interface SuggestedQuestion {
	id: string;
	label: string;
	tooltip?: string;
	category?: string;
}

// Sub-agent info for SubAgentCard (parallel execution display)
export interface SubAgentInfo {
	/** Unique sub-agent invocation ID */
	id: string;
	/**
	 * v26: human-readable sub-agent name (e.g. the workflow node label
	 * like "在控制台打印一个hello world" or the agent's own name for
	 * agent-type nodes). Previously missing from this interface — the
	 * SubAgentRow rendered `<span className="subagent-name">` with an
	 * empty string and a TS2339 was silently swallowed, so the parallel
	 * execution card showed the row type (通用) + spinner but no name.
	 * The cardSubAgents mapping in `LiveWorkflowTraceView` now passes
	 * `sa.name` (from the `subagent_start` trace event payload, which
	 * is the workflow node's label) into this field.
	 */
	name?: string;
	/** Sub-agent type (explore/general/scout) */
	type: 'explore' | 'general' | 'scout';
	/** Task description */
	task: string;
	/** Parent agent ID */
	parentAgentId?: string;
	/** Current status */
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	/** Progress text */
	progress?: string;
	/**
	 * v24: live LLM streaming content (delta accumulation) for this
	 * sub-agent. Distinct from `output` (which is the final value set on
	 * subagent_end). The SubAgentRow uses this for the in-progress
	 * streaming card and falls back to `output` once the agent finishes.
	 */
	streamedText?: string;
	/** Final output */
	output?: string;
	/** Error message */
	error?: string;
	/** Group ID for parallel batch grouping (e.g., "batch-1") */
	groupId?: string;
	/**
	 * P4 v3: streamed thinking/reasoning content for this sub-agent
	 * (Phase-2 reasoning text emitted before the final answer).
	 */
	thinking?: string;
	/**
	 * P4 v3: tool call trace from this sub-agent execution.
	 * Each entry is a lightweight record (not a full ToolMessage):
	 * `arguments` and `result` are pre-stringified by the host.
	 */
	toolTrace?: SubAgentToolCallTrace[];
}

/** Lightweight tool-call record attached to a sub-agent trace (P4 v3). */
export interface SubAgentToolCallTrace {
	id: string;
	name: string;
	arguments?: string;
	result?: string;
	status?: 'pending' | 'running' | 'done' | 'error';
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'tool' | 'system' | 'checkpoint';
	content: string;
	/**
	 * Agent-level session ID (within the owning agent). Round-tripped with
	 * the host so `chat.append` can target the correct session even when the
	 * message is synthesized locally (e.g. workflow `wf_run_*` assistant msg).
	 */
	agentSessionId?: string;
	thinking?: string;
	toolCalls?: { id: string; name: string; arguments: string; result?: string; status: string; defaultShow?: boolean; displayName?: string; renderType?: string; serverExecuted?: boolean; textPosition?: number }[];
	/**
	 * Hermes-style 回合标识（2026-06-05 治本根因修复）。
	 * 同一次用户请求触发的多轮 agentOS loop 会持久化多条 assistant 消息共享同一
	 * turnId。AgentChat 渲染时把相邻同 turnId 的 assistant 消息聚合成一个气泡，
	 * 保持 UI 外观不变。旧数据无此字段时每条独立成气泡（向后兼容）。
	 */
	turnId?: string;
	tokenUsage?: {
		input: number;
		output: number;
		total: number;
		/** KV Cache: tokens read from prompt cache (Anthropic / OpenAI). */
		cached?: number;
		/** KV Cache: tokens written to cache (Anthropic cache_creation_input_tokens). */
		cacheWrite?: number;
		/** Billing credits consumed by this turn (gateway final-chunk usage.credit). */
		credit?: number;
	};
	timestamp: string;
	/** Structured error info for system error messages (VS Code Copilot Chat pattern) */
	error?: StreamError;
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
	/** Sub-agent executions (parallel or sequential) - VS Code chatSubagentContentPart pattern */
		subAgents?: SubAgentInfo[];
		/**
		 * v5d: answered AskUser cards persisted alongside the workflow run.
		 * Each entry is a completed (status='answered') LiveWorkflowAskUser.
		 * Renders as read-only AskUserCard in the assistant message bubble.
		 */
		askUsers?: LiveWorkflowAskUser[];
		/**
		 * LiveWorkflowTraceView: workflow execution trace attached to this message.
		 * Key = executionId, value = execution state with subAgents + toolCalls.
		 * Persisted so the trace card survives reload.
		 */
		workflowExecutions?: Record<string, LiveWorkflowExecution>;
		/**
		 * LiveWorkflowTraceView: workflow events timeline.
		 * Persisted so the events timeline survives reload.
		 */
		workflowEvents?: LiveWorkflowEvent[];
		/**
		 * LiveWorkflowTraceView: collect-variables requests.
		 * Persisted so the collect-variables card survives reload.
		 */
		collectVariables?: Record<string, LiveCollectVariable>;
		/** Checkpoint data for time-travel navigation (Void-inspired) */
	checkpoint?: CheckpointData;
	/** User-uploaded attachments (images/files) - Void-inspired attachment support */
	attachments?: Array<{
		id: string;
		type: 'image' | 'file';
		name: string;
		mimeType: string;
		/** For images: base64 data (without prefix); for text files: raw content */
		data: string;
		size: number;
		isPasted?: boolean;
	}>;
}

export interface AgentSessionInfo {
	id: string;
	name: string;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
	/** External provider session ID (e.g. Knot threadId) */
	providerSessionId?: string;
}

interface ChatState {
	messages: ChatMessage[];
	streamState: StreamState;
	inputValue: string;
	isLoading: boolean;
	activeAgentId: string | null;
	/** Current agent session ID (null = 'default') */
	activeAgentSessionId: string | null;
	/** List of sessions for the current agent (Root mode) */
	agentSessions: AgentSessionInfo[];
	/**
	 * Decomposition progress messages per agent, keyed by agentId.
	 * These are NOT persisted to the host; they survive agent switches
	 * so the user still sees "analyzing goal..." progress after switching
	 * back to a planner chat.
	 */
	decompositionProgress: Record<string, ChatMessage[]>;
	/**
	 * Cached chat messages per agent, keyed by agentId.
	 * When switching between agents, the current agent's messages are saved
	 * here so the user can switch back without losing chat context.
	 * NOT persisted — cleared on page reload.
	 */
	cachedMessages: Record<string, ChatMessage[]>;
	/** Current chat mode: craft / ask / plan */
	chatMode: 'craft' | 'ask' | 'plan';

	/**
	 * P4: live workflow executions keyed by sessionId. Each entry represents
	 * an in-progress or recently-completed workflow run whose trace is being
	 * rendered in the chat panel. Cleared on page reload (not persisted).
	 */
	liveWorkflowExecutions: Record<string, LiveWorkflowExecution>;

	/**
	 * P4 v4: pending AskUser requests keyed by sessionId. Each entry is a
	 * single request waiting for user input. Cleared on page reload (not
	 * persisted); committed as part of the workflow run on `execution_end`.
	 */
	liveAskUsers: Record<string, LiveWorkflowAskUser[]>;

	/**
	 * v6: pending variable collection card shown before workflow execution.
	 * Keyed by sessionId (the workflow owner agent's session).
	 */
	liveCollectVariables: Record<string, LiveCollectVariable[]>;

	/**

	/**
	 * v5b: time-ordered log of workflow events for the session timeline panel.
	 * Capped at MAX_TIMELINE_EVENTS to avoid unbounded growth; oldest events
	 * are dropped first.
	 */
	liveWorkflowEvents: Record<string, LiveWorkflowEvent[]>;

	// Actions
	setActiveAgent: (agentId: string, opts?: { autoActivateLatestSession?: boolean }) => void;
	loadHistory: (agentId: string) => Promise<void>;
	/** Load history for a specific agentSessionId (used by session switching) */
	loadHistoryForSession: (agentId: string, agentSessionId?: string) => Promise<void>;
	sendMessage: (message: string, attachments?: Array<{
		id: string;
		type: 'image' | 'file';
		name: string;
		mimeType: string;
		data: string;
		size: number;
		isPasted?: boolean;
	}>) => Promise<void>;
	cancelStream: () => void;
	setInputValue: (value: string) => void;
	clearMessages: () => void;
	/**
	 * Append a user message that originated *outside* the chat input
	 * (e.g. an imgui form submitted from a ConfigMD preview pane).
	 *
	 * The host-side controller has already persisted this message and
	 * kicked off a `chat.stream.*` cycle; this method just mirrors the
	 * optimistic local append that `sendMessage` performs for typed input,
	 * so the user sees a bubble for what they sent. Scoped by
	 * `agentId`: ignored if it doesn't match the active agent.
	 */
	appendExternalUserMessage: (agentId: string, message: ChatMessage) => void;
	/** Load all sessions for the current agent */
	loadAgentSessions: (agentId: string) => Promise<void>;
	/** Create a new session for the current agent and switch to it */
	createAgentSession: () => Promise<void>;
	/** Switch to a different session for the current agent */
	switchAgentSession: (sessionId: string) => Promise<void>;
	/** Rename an agent session */
	renameAgentSession: (sessionId: string, newName: string) => Promise<void>;
	/** Delete an agent session */
	deleteAgentSession: (sessionId: string) => Promise<void>;
	/** Reorder agent sessions in the current order array (UI-only, no persistence yet) */
	reorderAgentSessions: (orderedIds: string[]) => void;
	/** Append a decomposition progress message for the given agent */
	addDecompositionProgress: (agentId: string, message: ChatMessage) => void;
	/** Set the current chat mode */
	setChatMode: (mode: 'craft' | 'ask' | 'plan') => void;
	/** Approve a plan-approval confirmation card → create OrchestrationPlan → auto-execute */
	approvePlanConfirmation: (confirmation: ConfirmationRequest, buttonId: string) => Promise<void>;
	/** Reject a plan-approval confirmation card */
	rejectPlanConfirmation: (confirmation: ConfirmationRequest) => void;
	/** Add a checkpoint after a message boundary (Void-inspired time-travel) */
	addCheckpoint: (checkpoint: CheckpointData) => void;
	/** Navigate to a checkpoint (restore state) */
	jumpToCheckpoint: (checkpointId: string) => void;
	/** Mark all checkpoints as ghost except the one at the given id */
	setActiveCheckpoint: (checkpointId: string) => void;
	/** Mark a checkpoint as "kept" so the checkpoint bar hides itself. */
	keepCheckpoint: (checkpointId: string) => void;
	/** Open a diff editor (snapshot vs current) for a checkpoint file. */
	openCheckpointDiff: (checkpointId: string, fileUri: string) => void;
	/**
	 * 撤销全部检查点：把所有被改过的文件还原到最初状态，并隐藏 bar。
	 * 作用于所有 tool_edit 检查点（而非单个）。
	 */
	undoAllCheckpoints: () => void;
	/** 保留全部检查点：移除所有 checkpoint 消息，bar 隐藏，文件保持当前状态。 */
	keepAllCheckpoints: () => void;
	/** 在一个多文件 diff 窗口中显示所有检查点的全部变更。 */
	openAllCheckpointsDiff: () => void;
	/** Get the latest non-ghost / non-kept tool_edit checkpoint (for the always-floating bar). */
	getLatestCheckpoint: () => CheckpointData | undefined;

	// ─── P4: Live workflow execution methods (v2) + AskUser (v4) ───────────
	/** Begin a new workflow run. Called when the host fires `subagent_start` with
	 *  the synthetic `__workflow__` root node. */
	startWorkflowExecution: (executionId: string, sessionId: string, workflowName: string) => void;
	/** Add a node's subagent entry to the live execution. */
	startWorkflowSubAgent: (sessionId: string, subAgent: LiveWorkflowSubAgent) => void;
	/** Append a streaming delta to a node's accumulated text/thinking/toolCalls. */
	appendWorkflowTraceDelta: (sessionId: string, nodeId: string, delta: unknown) => void;
	/** Mark a subagent as done/error. */
	endWorkflowSubAgent: (
		sessionId: string,
		nodeId: string,
		// v21: 'cancelled' is fired when the user clicked Cancel while the
		// node was mid-stream. The host aborted the underlying LLM call and
		// surfaced it via subagent_end status — the card flips to a
		// "cancelled" badge instead of the success badge.
		status: 'done' | 'error' | 'cancelled',
		output?: string,
		error?: string,
	) => void;
	/** Finalize a workflow run: drop from live map + (if active session matches)
	 *  append a permanent assistant message with the SubAgentInfo trace. */
	commitWorkflowExecution: (
		sessionId: string,
		status: 'completed' | 'failed' | 'cancelled',
	) => void;
	/** Drop a live execution without committing. */
	discardWorkflowExecution: (sessionId: string) => void;
	/** v22: cancel all running workflow executions. Used by the chat
	 *  composer's send/stop toggle — when a workflow is running, clicking
	 *  the button cancels the workflow instead of sending a new message. */
	cancelCurrentWorkflow: () => Promise<void>;

	// v4 AskUser methods
	/** Register a new pending AskUser request for the given session. */
	startAskUser: (
		sessionId: string,
		askUser: Omit<LiveWorkflowAskUser, 'id' | 'selectedIndices' | 'status' | 'createdAt'>,
	) => void;
	/** Update the locally-selected option indices for a pending AskUser (pure UI). */
	updateAskUserSelection: (sessionId: string, askUserId: string, selectedIndices: number[]) => void;
	/** Submit the user's selection (sends `workflow.resume` and optimistically flips the card). */
	submitAskUser: (sessionId: string, askUserId: string, selection: string | string[]) => Promise<void>;
	/** Mark a pending AskUser as cancelled or expired. */
	cancelAskUser: (sessionId: string, askUserId: string, status: 'cancelled' | 'expired') => void;

	// v6: Variable collection methods
	/** Register a pending variable collection for the given session. */
	startCollectVariables: (
		sessionId: string,
		collect: Omit<LiveCollectVariable, 'id' | 'values' | 'status' | 'createdAt'>,
	) => void;
	/** Update a variable's value in the collection form (pure UI). */
	updateCollectVariableValue: (sessionId: string, collectId: string, varName: string, value: string) => void;
	/** Submit variable values (sends `workflow.submitVariables`). */
	submitCollectVariables: (sessionId: string, collectId: string, values: Record<string, string>) => Promise<void>;
	/** Mark a variable collection as skipped. */
	cancelCollectVariables: (sessionId: string, collectId: string) => void;

	// v5b: Execution timeline
	/**
	 * Append a new event to the session timeline (capped at MAX_TIMELINE_EVENTS).
	 * Called by the trace router for delta/subagent_start/subagent_end/ask_user etc.
	 */
	appendWorkflowEvent: (sessionId: string, event: Omit<LiveWorkflowEvent, 'id' | 'timestamp'>) => void;
	/** Clear the timeline (called on execution_end / discard). */
	clearWorkflowEvents: (sessionId: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => {
	// Helper: update the active agent's status in the agent store
	function syncAgentStatus(status: 'idle' | 'thinking' | 'working') {
		const activeId = get().activeAgentId;
		if (!activeId) return;
		useAgentStore.setState(state => ({
			agents: state.agents.map(e =>
				e.id === activeId ? { ...e, status } : e
			),
		}));
	}

	// Subscribe to stream state updates (live streaming indicator)
	subscribeStream((streamState) => {
		// Ignore stream updates that don't belong to the currently active agent/session.
		// This prevents stale deltas from a previous chat from leaking into the
		// currently displayed chat after the user switches agents.
		const { activeAgentId, activeAgentSessionId } = get();
		if (isPhaseActive(streamState.phase) && streamState.agentId && streamState.agentId !== activeAgentId) {
			return;
		}
		if (isPhaseActive(streamState.phase) && streamState.sessionId && activeAgentSessionId &&
			streamState.sessionId !== activeAgentSessionId) {
			return;
		}

		set({ streamState });

		// Sync agent status based on streaming phase (precise state machine)
		if (isPhaseActive(streamState.phase)) {
			switch (streamState.phase) {
				case 'llm_streaming':
					if (streamState.thinkingBuffer && !streamState.textBuffer) {
						syncAgentStatus('thinking');
					} else {
						syncAgentStatus('working');
					}
					break;
				case 'tool_executing':
					syncAgentStatus('working');
					break;
				case 'awaiting_approval':
					syncAgentStatus('thinking'); // "waiting for input" → thinking indicator
					break;
				case 'compressing':
					syncAgentStatus('thinking');
					break;
				case 'error':
					syncAgentStatus('idle');
					break;
				default:
					syncAgentStatus('thinking');
			}
		}
	});

	// When a stream completes (or errors), build the final message and add to history.
	// IMPORTANT: we must atomically update `messages` AND `streamState` in a single
	// set() call so that React sees both changes in the same render batch.
	// Otherwise the streaming bubble disappears (isStreaming→false) before the
	// persisted assistant message appears, causing the chat UI to flash empty.
	onStreamComplete((finalState, hostMessage?: any) => {
		console.log('[ChatStore] onStreamComplete fired:', {
			phase: finalState.phase,
			isStreaming: finalState.isStreaming,
			textBufferLen: finalState.textBuffer.length,
			thinkingBufferLen: finalState.thinkingBuffer.length,
			errorMessage: finalState.errorMessage,
			hostMessage: hostMessage ? {
				id: hostMessage.id,
				role: hostMessage.role,
				contentLen: hostMessage.content?.length ?? 0,
				contentPreview: hostMessage.content?.substring(0, 80),
				thinkingLen: hostMessage.thinking?.length ?? 0,
				error: hostMessage.error,
			} : null,
		});

		// Guard: discard completion events for a different agent/session
		// than the one currently active. This can happen when a stream
		// from a previous chat finishes after the user has switched.
		const { activeAgentId, activeAgentSessionId } = get();
		if (finalState.agentId && finalState.agentId !== activeAgentId) {
			console.warn(`[ChatStore] onStreamComplete: discarding message for different agent ` +
				`(streamAgent=${finalState.agentId}, activeAgent=${activeAgentId})`);
			resetStreamSilent();
			set({ streamState: getStreamState() });
			try { syncAgentStatus('idle'); } catch { /* ignore */ }
			return;
		}
		if (finalState.sessionId && activeAgentSessionId && finalState.sessionId !== activeAgentSessionId) {
			console.warn(`[ChatStore] onStreamComplete: discarding message for different session ` +
				`(streamSession=${finalState.sessionId}, activeSession=${activeAgentSessionId})`);
			resetStreamSilent();
			set({ streamState: getStreamState() });
			try { syncAgentStatus('idle'); } catch { /* ignore */ }
			return;
		}

		// Guard: if the user already cancelled this stream (via cancelStream()),
		// the partial content has been committed as a `cancelled_*` message.
		// The host-side abort still triggers a `chat.stream.complete` event —
		// discard it to avoid duplicate messages (VS Code Copilot Chat pattern).
		const { messages } = get();
		const lastMsg = messages[messages.length - 1];
		if (lastMsg && lastMsg.id.startsWith('cancelled_')) {
			console.log('[ChatStore] onStreamComplete: discarding — stream was already cancelled by user');
			resetStreamSilent();
			set({ streamState: getStreamState() });
			return;
		}

		if (finalState.errorMessage) {
			// API returned an error — show it as a system error message
			// Use structured error info if available (VS Code Copilot Chat pattern)
			const structuredError = finalState.error || { message: finalState.errorMessage, level: 'error' as const };
			const errorIcon = structuredError.level === 'warning' ? '⚠️' : structuredError.level === 'info' ? 'ℹ️' : '❌';
			const errorMessage: ChatMessage = {
				id: `error_${Date.now()}`,
				role: 'system',
				content: `${errorIcon} ${finalState.errorMessage}`,
				timestamp: new Date().toISOString(),
				error: structuredError,
			};
			// Reset silently (no notify) then atomically commit error + streamState
			resetStreamSilent();
			set(state => ({
				messages: [...state.messages, errorMessage],
				streamState: getStreamState(),
			}));
			// Restore agent status AFTER messages are committed
			try { syncAgentStatus('idle'); } catch { /* ignore */ }
			console.log('[ChatStore] Error message committed', { level: structuredError.level, retryable: structuredError.retryable });
			return;
		}

		// Prefer the host-assembled message (hostMessage) as the authoritative source
		// because it accumulates ALL deltas server-side without any risk of missing
		// chunks due to RAF cancellation, background-stream switching, or other
		// webview-side timing issues.
		//
		// Content resolution rules:
		// 1. When one source has content and the other doesn't → use the one with content.
		// 2. When both have content and they represent the SAME response
		//    (one is a prefix of the other) → pick the LONGER one (defense against
		//    webview buffer truncation or partial host messages).
		// 3. When both have content but they're DIFFERENT responses
		//    (neither is a prefix of the other) → TRUST the HOST message.
		//    This guards against multi-turn agent loops where the webview buffer
		//    accumulates raw text from ALL turns while the host message carries
		//    only the LAST turn's sanitized content (see agentChatService::assistant_turn).
		const hostText = (hostMessage?.content as string) || '';
		const hostThinking = (hostMessage?.thinking as string) || '';

		// Detect whether both sources represent the same model response
		const sameTextResponse = !hostText || !finalState.textBuffer ||
			finalState.textBuffer.startsWith(hostText) ||
			hostText.startsWith(finalState.textBuffer);
		const sameThinkingResponse = !hostThinking || !finalState.thinkingBuffer ||
			finalState.thinkingBuffer.startsWith(hostThinking) ||
			hostThinking.startsWith(finalState.thinkingBuffer);

		const textContent = sameTextResponse
			? (hostText.length >= finalState.textBuffer.length ? hostText : finalState.textBuffer)
			: hostText;
		const thinkingContent = sameThinkingResponse
			? (hostThinking.length >= finalState.thinkingBuffer.length ? hostThinking : finalState.thinkingBuffer)
			: hostThinking;

		console.log('[ChatStore] Building assistant message:', {
			textContentLen: textContent.length,
			textContentPreview: textContent.substring(0, 80),
			thinkingContentLen: thinkingContent.length,
			usedHostText: textContent === hostText,
			usedHostThinking: thinkingContent === hostThinking,
			hostTextLen: hostText.length,
			hostThinkingLen: hostThinking.length,
			bufferTextLen: finalState.textBuffer.length,
			bufferThinkingLen: finalState.thinkingBuffer.length,
		});

		// DEBUG: Detect content mismatch between streaming buffer and host message.
		// When they don't share a common prefix, this indicates a multi-turn agent
		// loop where the buffer accumulated old-turn text while the host carries
		// the final turn's sanitized content.
		if (hostText && finalState.textBuffer && !sameTextResponse) {
			console.warn('[ChatStore] ⚠️ CROSS-TURN CONTENT MISMATCH — webview buffer carries different model turn than host message!', {
				bufferFirst100: finalState.textBuffer.substring(0, 100),
				hostFirst100: hostText.substring(0, 100),
				bufferLast100: finalState.textBuffer.substring(Math.max(0, finalState.textBuffer.length - 100)),
				hostLast100: hostText.substring(Math.max(0, hostText.length - 100)),
				bufferLen: finalState.textBuffer.length,
				hostLen: hostText.length,
				action: 'using host (authoritative sanitized content)',
			});
		} else if (hostText && finalState.textBuffer && hostText !== finalState.textBuffer) {
			console.warn('[ChatStore] ⚠️ SAME-TURN CONTENT MISMATCH — lengths differ but share prefix', {
				bufferLen: finalState.textBuffer.length,
				hostLen: hostText.length,
				bufferFirst80: finalState.textBuffer.substring(0, 80),
				hostFirst80: hostText.substring(0, 80),
				action: textContent === hostText ? 'using host (longer)' : 'using buffer (longer)',
			});
		}

		// Reset silently (no notify → no intermediate subscribeStream callback)
		// so we can atomically commit messages + streamState in a single set().
		resetStreamSilent();

		// Build unified ChatMessage[] from StreamState (adapter: StreamState → ChatMessage)
		const unifiedMessages = buildChatMessagesFromState(finalState);
		console.log('[ChatStore] Unified ChatMessage[] built:', unifiedMessages.length, unifiedMessages);

		if (textContent || thinkingContent) {
			// KV Cache: prefer the host-assembled message's tokenUsage when available
			// (canonical, accumulated server-side); fall back to the webview-side
			// stream accumulator. Persisting on the message lets the chat footer
			// render "N tokens (cache: M)" badges and survives page reloads.
			const hostUsage = (hostMessage?.tokenUsage as ChatMessage['tokenUsage']) || undefined;
			let finalUsage: ChatMessage['tokenUsage'] | undefined = hostUsage;
			if (!finalUsage && finalState.usage?.seen) {
				finalUsage = {
					input: finalState.usage.input,
					output: finalState.usage.output,
					total: finalState.usage.input + finalState.usage.output,
					cached: finalState.usage.cached > 0 ? finalState.usage.cached : undefined,
					cacheWrite: finalState.usage.cacheWrite > 0 ? finalState.usage.cacheWrite : undefined,
				};
			}
			const assistantMessage: ChatMessage = {
				id: hostMessage?.id || `asst_${Date.now()}`,
				role: 'assistant',
				content: textContent || '(思考完成)',
				thinking: thinkingContent || undefined,
				toolCalls: finalState.toolCalls.map(tc => ({
					id: tc.id,
					name: tc.name,
					arguments: tc.arguments,
					result: tc.result,
					// Stream has completed — any tool still marked 'running' must be
					// finalized so the UI doesn't keep spinning forever. If we have a
					// result, treat it as success; otherwise mark as 'done' (best effort).
					status: tc.status === 'running' ? 'done' : tc.status,
					defaultShow: tc.defaultShow,
					displayName: tc.displayName,
					renderType: tc.renderType,
					serverExecuted: tc.serverExecuted,
					textPosition: tc.textPosition,
				})),
				timestamp: new Date().toISOString(),
				tokenUsage: finalUsage,
				// Copy new card data fields from hostMessage (VS Code Copilot Chat pattern)
				references: (hostMessage?.references as ChatMessage['references']) || undefined,
				progress: (hostMessage?.progress as ChatMessage['progress']) || undefined,
				confirmation: (hostMessage?.confirmation as ChatMessage['confirmation']) || undefined,
				todos: (hostMessage?.todos as ChatMessage['todos']) || undefined,
				tips: (hostMessage?.tips as ChatMessage['tips']) || undefined,
				questions: (hostMessage?.questions as ChatMessage['questions']) || undefined,
				subAgents: (hostMessage?.subAgents as ChatMessage['subAgents']) || finalState.subAgents.length > 0
					? finalState.subAgents.map(sa => ({
						id: sa.id,
						type: sa.type,
						task: sa.task,
						parentAgentId: sa.parentAgentId,
						status: sa.status,
						progress: sa.progress,
						output: sa.output,
						error: sa.error,
					})) : undefined,
			};
			// Atomically commit the new message AND the reset streamState
			// so React never sees "no streaming bubble + no message" in between.
			// 如果本轮触发了上下文压缩，在助手消息之前插入压缩提示系统消息，
			// 让压缩提示卡片在流结束后仍然保留在聊天历史中。
			const compressionMsg: ChatMessage | null = finalState.compressionInfo ? {
				id: `compression_${Date.now()}`,
				role: 'system',
				content: `📦 上下文已压缩：${finalState.compressionInfo.originalCount} 条消息 → ${finalState.compressionInfo.compressedCount} 条消息` +
					(finalState.compressionInfo.tokensSaved > 0
						? ` · 节省 ${finalState.compressionInfo.tokensSaved.toLocaleString()} tokens`
						: ''),
				timestamp: new Date(finalState.compressionInfo.timestamp).toISOString(),
			} : null;
			set(state => {
				console.log('[ChatStore] Committing assistant message, current messages count:', state.messages.length, ', new msg id:', assistantMessage.id);
				const newMsgs = compressionMsg
					? [...state.messages, compressionMsg, assistantMessage]
					: [...state.messages, assistantMessage];
				return {
					messages: newMsgs,
					streamState: getStreamState(),
				};
			});
		} else {
			console.warn('[ChatStore] onStreamComplete: No content to build message from! This should not happen in normal flow.');
			// Still sync streamState even when there is no content
			set({ streamState: getStreamState() });
		}

		// Restore agent status AFTER messages and streamState are committed.
		// This must come last to avoid triggering React re-renders that could
		// see an intermediate state where streaming stopped but no message exists.
		try { syncAgentStatus('idle'); } catch { /* ignore */ }
		console.log('[ChatStore] onStreamComplete done, agent status restored to idle');
	});

	return {
		messages: [],
		streamState: getStreamState(),
		inputValue: '',
		isLoading: false,
		activeAgentId: null,
		activeAgentSessionId: null,
		agentSessions: [],
		decompositionProgress: {},
		cachedMessages: {},
		chatMode: 'craft',
		liveWorkflowExecutions: {},
		liveAskUsers: {},
		liveCollectVariables: {},
		liveWorkflowEvents: {},

		setActiveAgent: (agentId: string, opts?: { autoActivateLatestSession?: boolean }) => {
			const current = get().activeAgentId;
			console.log(`[ChatStore] setActiveAgent: ${current} → ${agentId}`, opts);
			if (current === agentId) {
				return;
			}

			// Check if in Fork mode — use fork's agentSessionId
			let forkSessionId: string | null = null;
			try {
				const { useWorkspaceSessionStore } = require('./useWorkspaceSessionStore');
				forkSessionId = useWorkspaceSessionStore.getState().getAgentSessionId(agentId);
			} catch { /* store not available */ }

			// Save current stream to background and restore any saved stream for the new agent.
			// Must be done atomically with updating activeAgentId so subscribeStream
			// doesn't discard the restored stream due to stale activeAgentId.
			const newStreamState = switchActiveStream(agentId, forkSessionId);

			// Save current agent's messages to cache, restore cached messages for target agent
			const { messages: currentMessages, activeAgentSessionId: prevSessionId, cachedMessages, liveWorkflowExecutions, liveAskUsers, liveCollectVariables, liveWorkflowEvents } = get();
			const newCache = { ...cachedMessages };
			if (current && currentMessages.length > 0) {
				newCache[current] = currentMessages;
			}
			const restoredMessages = newCache[agentId] || [];

			// v6 (refined): wipe only the previous agent's live workflow state so
			// the panel closes when switching agents. Preserve the new agent's
			// session live state (e.g. live workflow execution that was just
			// populated by startWorkflowExecution in the same trace event handler
			// — wiping it caused all subsequent subagent_start events to silently
			// fail their `if (!exec) return` guard, leading to missing tool cards).
			const newLiveExec = { ...liveWorkflowExecutions };
			const newLiveAsk = { ...liveAskUsers };
			const newLiveCollect = { ...liveCollectVariables };
			const newLiveEvents = { ...liveWorkflowEvents };
			if (current && prevSessionId) {
				// Wipe only the previous (current→old) agent's session entries.
				delete newLiveExec[prevSessionId];
				delete newLiveAsk[prevSessionId];
				delete newLiveCollect[prevSessionId];
				delete newLiveEvents[prevSessionId];
			}

			set({
				activeAgentId: agentId,
				activeAgentSessionId: forkSessionId,
				messages: restoredMessages,
				inputValue: '',
				agentSessions: [],
				streamState: newStreamState,
				chatMode: 'craft',
				cachedMessages: newCache,
				liveWorkflowExecutions: newLiveExec,
				liveAskUsers: newLiveAsk,
				liveCollectVariables: newLiveCollect,
				liveWorkflowEvents: newLiveEvents,
			});

			if (forkSessionId) {
				// Fork mode: directly load fork session
				get().loadHistoryForSession(agentId, forkSessionId);
			} else {
				// Root mode: load sessions list (for sidebar display).
				// 🔒 修复（2026-06-05）：默认不自动激活最近一条 session，
				// activeAgentSessionId 保持 null，sendMessage 会走 `agentSession.create`
				// 开全新空 session。要恢复旧会话必须从历史列表显式点选。
				//
				// ✅ 2026-06-12 增强：新增 `autoActivateLatestSession` 选项，
				// 用于 workflow 编辑器打开时自动恢复对应 agent 的最近 session。
				const autoActivate = opts?.autoActivateLatestSession === true;
				sendRequest<{ agentId: string }, AgentSessionInfo[]>(
					'agentSession.list',
					{ agentId },
				).then(sessions => {
					if (get().activeAgentId !== agentId) { return; }
					set({ agentSessions: sessions || [] });
					if (autoActivate && sessions && sessions.length > 0) {
						// Auto-activate the most recent session
						const latest = sessions[0];
						console.log(`[ChatStore] auto-activating latest session: ${latest.id}`);
						get().switchAgentSession(latest.id);
					}
				}).catch(err => {
					console.error('[ChatStore] Failed to load agent sessions:', err);
				});
			}
		},

		loadHistory: async (agentId: string) => {
			return get().loadHistoryForSession(agentId, get().activeAgentSessionId ?? undefined);
		},

		loadHistoryForSession: async (agentId: string, agentSessionId?: string) => {
			console.log(`[ChatStore] loadHistoryForSession: agentId=${agentId}, agentSessionId=${agentSessionId}`);
			set({ isLoading: true, activeAgentSessionId: agentSessionId ?? null });
			try {
				const messages = await sendRequest<{ agentId: string; sessionId?: string }, ChatMessage[]>(
					'chat.history',
					{ agentId, sessionId: agentSessionId }
				);
				// Guard: don't overwrite messages if the active agent has changed
				const currentActive = get().activeAgentId;
				if (currentActive !== agentId) {
					console.warn(`[ChatStore] loadHistoryForSession: active agent changed (${currentActive} vs ${agentId}), discarding stale history`);
					set({ isLoading: false });
					return;
				}
				console.log(`[ChatStore] loadHistoryForSession: received ${messages?.length ?? 0} messages for ${agentId}`);

				// ── Filter out orchestration_plan messages that don't belong to this agent ──
				let finalMessages = (messages || []).filter(m => {
					if (m.metadata?.type === 'orchestration_plan') {
						// Only keep plan messages whose plannerId matches the current agent
						const { useOrchestrationStore } = require('./useOrchestrationStore');
						const plan = useOrchestrationStore.getState().plans.find((p: { id: string; plannerId?: string }) => p.id === m.metadata!.planId);
						if (plan && plan.plannerId !== agentId) {
							console.log(`[ChatStore] Filtering out plan ${plan.id} (plannerId=${plan.plannerId}) from agent ${agentId}`);
							return false;
						}
					}
					return true;
				});

				// ── Deduplicate messages by id (single-pass) ──
				// Host guarantees message ID uniqueness; no need for content+timestamp
				// bucketing (which could cause false positives with fast exchanges).
				// Orchestration_plan messages are deduped by planId in the same pass.
				const seenIds = new Set<string>();
				const seenPlanIds = new Set<string>();
				const deduped: ChatMessage[] = [];
				for (let i = finalMessages.length - 1; i >= 0; i--) {
					const m = finalMessages[i];
					// Skip by id
					if (seenIds.has(m.id)) {
						continue;
					}
					seenIds.add(m.id);
					// Skip duplicate orchestration_plan messages by planId
					if (m.metadata?.type === 'orchestration_plan' && m.metadata.planId) {
						if (seenPlanIds.has(m.metadata.planId)) {
							console.log(`[ChatStore] loadHistoryForSession: removing duplicate plan message for ${m.metadata.planId}`);
							continue;
						}
						seenPlanIds.add(m.metadata.planId);
					}
					deduped.unshift(m);
				}
				finalMessages = deduped;

				try {
					const { useOrchestrationStore } = require('./useOrchestrationStore');
					const { useWorkspaceStore } = require('./useWorkspaceStore');
					const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;

					// Ensure plans are loaded before checking
					if (workspaceId && useOrchestrationStore.getState().plans.length === 0) {
						console.log('[ChatStore] Plans not loaded yet, loading plans first...');
						await useOrchestrationStore.getState().loadPlans(workspaceId);
					}

					const plans = useOrchestrationStore.getState().plans;
					console.log(`[ChatStore] loadHistoryForSession: plans count=${plans.length}, statuses=${plans.map((p: { status: string }) => p.status).join(',')}`);
					// Include all non-rejected plans (pending_approval, approved, executing, completed)
					// so the plan UI doesn't disappear when switching back to the planner chat.
					const activePlans = plans.filter((p: { status: string }) =>
						p.status !== 'rejected' && p.status !== 'error'
					);
					console.log(`[ChatStore] loadHistoryForSession: activePlans count=${activePlans.length}`);

					// Avoid duplicating plan messages that may already exist in history
					const existingPlanIds = new Set(
						finalMessages
							.filter(m => m.metadata?.type === 'orchestration_plan')
							.map(m => m.metadata!.planId)
					);

					for (const plan of activePlans) {
						// 只有当前 agent 是该 plan 的 planner 时才显示任务计划卡片
						if (plan.plannerId !== agentId) { continue; }
						if (existingPlanIds.has(plan.id)) { continue; }
						console.log(`[ChatStore] Re-creating orchestration_plan message for plan ${plan.id} (status=${plan.status})`);
						const statusText = plan.status === 'pending_approval' ? '任务计划已创建，请在下方面板中审批：'
							: plan.status === 'executing' || plan.status === 'approved' ? '任务计划执行中：'
								: plan.status === 'completed' ? '任务计划已完成：'
									: '任务计划：';
						const planMessage: ChatMessage = {
							id: `plan_${plan.id}`,
							role: 'system',
							content: `✅ ${statusText}`,
							metadata: { type: 'orchestration_plan', planId: plan.id },
							timestamp: plan.updatedAt,
						};
						finalMessages = [...finalMessages, planMessage];
					}
				} catch (err) {
					console.warn('[ChatStore] Failed to check for active plans:', err);
				}

				// Restore any decomposition progress messages for this agent
				// so "analyzing goal..." hints survive chat-tab switches.
				const progressMsgs = get().decompositionProgress[agentId] || [];
				if (progressMsgs.length > 0) {
					const existingIds = new Set(finalMessages.map(m => m.id));
					const newProgress = progressMsgs.filter(m => !existingIds.has(m.id));
					if (newProgress.length > 0) {
						console.log(`[ChatStore] Restoring ${newProgress.length} decomposition progress messages for ${agentId}`);
						finalMessages = [...finalMessages, ...newProgress];
					}
				}

				// Sort all messages by timestamp to ensure correct chronological order
				// (progress messages restored from memory may have earlier timestamps
				// than history messages loaded from the host, so a final sort is needed).
				finalMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

				// Strip hidden tool calls (defaultShow=false) from loaded history.
				// Visibility is now controlled solely by defaultShow.
				finalMessages = finalMessages.map(m => {
					if (m.toolCalls && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
						const filtered = m.toolCalls.filter(tc => tc && tc.defaultShow !== false);
						if (filtered.length !== m.toolCalls.length) {
							return { ...m, toolCalls: filtered };
						}
					}
					return m;
				});

				// ── Re-hydrate persisted checkpoints (fix: CheckpointBar disappears
				// after reload) ──────────────────────────────────────────────────
				// Checkpoint cards are normally created live via the
				// `chat.checkpointCreated` push event and only ever live in this
				// store's in-memory `messages`. `chat.history` does NOT return
				// checkpoint messages — checkpoints are persisted separately by the
				// host CheckpointService (scoped by agentId+sessionId). So after
				// a window reload there are zero `role:'checkpoint'` messages and the
				// bar (which requires at least one tool_edit checkpoint) renders null.
				// Here we pull the persisted checkpoints back and merge the tool_edit
				// ones in as checkpoint messages so the bar survives reloads.
				try {
					const persisted = await sendRequest<
						{ agentId: string; sessionId: string },
						Array<{
							id: string;
							type: 'user_edit' | 'tool_edit';
							createdAt: number;
							label?: string;
							description?: string;
							isGhost?: boolean;
							messageId?: string;
							files?: CheckpointFileChange[];
							fileSnapshotIds?: string[];
						}>
					>('chat.listCheckpoints', { agentId, sessionId: agentSessionId ?? '' });

					// Bail if the active agent changed while awaiting.
					if (get().activeAgentId !== agentId) {
						set({ isLoading: false });
						return;
					}

					if (Array.isArray(persisted) && persisted.length > 0) {
						const existingIds = new Set(finalMessages.map(m => m.id));
						const cpMessages: ChatMessage[] = [];
						for (const cp of persisted) {
							// Only tool_edit checkpoints get a bar card (user_edit are
							// empty message-boundary anchors). Skip duplicates already
							// present (e.g. live-created during the same session).
							if (cp.type !== 'tool_edit') { continue; }
							if (existingIds.has(cp.id)) { continue; }
							cpMessages.push({
								id: cp.id,
								role: 'checkpoint',
								content: '',
								timestamp: new Date(cp.createdAt).toISOString(),
								checkpoint: {
									id: cp.id,
									type: 'tool_edit',
									timestamp: new Date(cp.createdAt).toISOString(),
									description: cp.description || cp.label,
									filesChanged: cp.files?.length ?? cp.fileSnapshotIds?.length ?? 0,
									files: cp.files,
									isGhost: cp.isGhost ?? false,
								},
							});
						}
						if (cpMessages.length > 0) {
							console.log(`[ChatStore] loadHistoryForSession: re-hydrated ${cpMessages.length} checkpoint(s)`);
							finalMessages = [...finalMessages, ...cpMessages];
							// Re-sort so checkpoints land right after their triggering turn.
							finalMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
						}
					}
				} catch (err) {
					console.warn('[ChatStore] loadHistoryForSession: failed to re-hydrate checkpoints:', err);
				}

				set({ messages: finalMessages, isLoading: false });
			} catch (err) {
				console.error('[ChatStore] Failed to load history:', err);
				set({ isLoading: false });
			}
		},

		sendMessage: async (message: string, attachments?: Array<{
			id: string;
			type: 'image' | 'file';
			name: string;
			mimeType: string;
			data: string;
			size: number;
			isPasted?: boolean;
		}>) => {
			// Guard: never send empty messages without attachments
			if ((!message || !message.trim()) && (!attachments || attachments.length === 0)) { return; }
			let { activeAgentId, activeAgentSessionId, streamState, chatMode } = get();
			if (!activeAgentId) { return; }

			// ── 解析 /skill <id> 命令，提取显式激活的技能 ID ──
			const explicitSkillIds: string[] = [];
			const seenSkillIds = new Set<string>();
			const skillPattern = /\/skill\s+(\S+)/g;
			let match: RegExpExecArray | null;
			while ((match = skillPattern.exec(message)) !== null) {
				const id = match[1].toLowerCase();
				if (!seenSkillIds.has(id)) {
					seenSkillIds.add(id);
					explicitSkillIds.push(id);
				}
			}

			// ── Auto-cancel current stream if still running (VS Code Copilot Chat
			// "steering" pattern: sending a new message interrupts the current one) ──
			if (isPhaseActive(streamState.phase)) {
				console.log('[ChatStore] sendMessage: auto-cancelling active stream before sending new message');
				get().cancelStream();
			}

			const sessionName = message.trim().substring(0, 30);

			// If no session assigned yet, create a FRESH one (don't reuse latest).
			// 🔒 修复（2026-06-05）：之前用 `agentSession.getActive` →
			// 后端 `getOrCreateActiveSession` 只要 index 非空就返回最近一条 existing
			// session，导致"无 active session 发消息"会复用最近一条几百轮的旧 session，
			// 把整段历史回灌给模型（log 里 313 条跨主题/跨 worktree 串台即此故障）。
			// 改为 `agentSession.create` 明确新建：用户没有显式选择 session 时永远开
			// 新会话，不带任何历史。要恢复旧会话必须显式从历史列表选中。
			if (!activeAgentSessionId) {
				try {
					const meta = await sendRequest<{ agentId: string; name?: string }, AgentSessionInfo>(
						'agentSession.create',
						{ agentId: activeAgentId, name: sessionName },
					);
					if (meta?.id) {
						activeAgentSessionId = meta.id;
						set({ activeAgentSessionId: meta.id });
						get().loadAgentSessions(activeAgentId);
					}
				} catch (err) {
					console.error('[ChatStore] Failed to auto-create session before send:', err);
				}
			} else {
				// Session exists — if this is the first message (no messages yet),
				// rename the session to the user's first message
				const currentMessages = get().messages;
				if (currentMessages.length === 0) {
					// 🔒 防御性兜底（2026-06-05）：messages 为空 ≠ session 在磁盘上为空。
					// 例如用户点 "+ 新建对话" 时若 store.createAgentSession 因某种原因没真正
					// 把 RPC 发到 host（看到的现象：log 里完全没有 agentSession.create 调用，
					// 但 sessionId 仍指向上一条几轮历史的 session），sendMessage 会误以为这
					// 是新会话，走 rename 分支，把当前 user 消息追加到旧 session 末尾，导致
					// 整段旧历史被 B 方案重新回灌给模型。
					// 这里检查 agentSessions 列表里当前 session 的 messageCount——如果
					// 磁盘上已有消息，说明视图清空与底层 session 不一致，强制开全新会话。
					const { agentSessions: list } = get();
					const meta = list.find(s => s.id === activeAgentSessionId);
					const diskMessageCount = (meta as any)?.messageCount ?? 0;
					if (diskMessageCount > 0) {
						console.warn(
							`[ChatStore] sendMessage: messages=[] but session ${activeAgentSessionId} has ${diskMessageCount} msgs on disk — forcing fresh session to avoid history bleed`,
						);
						try {
							const fresh = await sendRequest<{ agentId: string; name?: string }, AgentSessionInfo>(
								'agentSession.create',
								{ agentId: activeAgentId, name: sessionName },
							);
							if (fresh?.id) {
								activeAgentSessionId = fresh.id;
								set({ activeAgentSessionId: fresh.id });
								get().loadAgentSessions(activeAgentId);
							}
						} catch (err) {
							console.error('[ChatStore] Defensive create-fresh-session failed:', err);
						}
					} else if (sessionName) {
						get().renameAgentSession(activeAgentSessionId, sessionName);
					}
				}
			}

			// Resolve Fork context
			let workspaceSessionId: string | undefined;
			let workspaceId: string | undefined;
			try {
				const { useWorkspaceSessionStore } = require('./useWorkspaceSessionStore');
				const sessionState = useWorkspaceSessionStore.getState();
				workspaceSessionId = sessionState.activeSessionId ?? undefined;
				const { useWorkspaceStore: wsStore } = require('./useWorkspaceStore');
				workspaceId = wsStore.getState().activeWorkspaceId ?? undefined;
			} catch { /* store not available */ }

			// Resolve current model's thinking/reasoning config (if enabled)
			let reasoning: { enabled: boolean; budget?: number; effort?: 'low' | 'medium' | 'high' } | undefined;
			try {
				const { useProviderStore } = require('./useProviderStore');
				const cfg = useProviderStore.getState().currentReasoningConfig?.();
				if (cfg && cfg.enabled) {
					reasoning = { enabled: true, budget: cfg.budget, effort: cfg.effort };
				}
			} catch { /* provider store not available */ }

			// Add user message optimistically
			const userMessage: ChatMessage = {
				id: `user_${Date.now()}`,
				role: 'user',
				content: message,
				timestamp: new Date().toISOString(),
				attachments: attachments && attachments.length > 0 ? attachments : undefined,
			};
			set(state => ({
				messages: [...state.messages, userMessage],
				inputValue: '',
			}));

			try {
				await sendRequest('chat.send', {
					agentId: activeAgentId,
					message,
					agentSessionId: activeAgentSessionId ?? undefined,
					workspaceSessionId,
					workspaceId,
					explicitSkillIds: explicitSkillIds.length > 0 ? explicitSkillIds : undefined,
					chatMode,
					reasoning,
					attachments: attachments && attachments.length > 0 ? attachments : undefined,
				});
				// After send completes, refresh session list to update messageCount
				get().loadAgentSessions(activeAgentId!);
			} catch (err) {
				console.error('[ChatStore] Failed to send message:', err);
				const errorMsg = err instanceof Error ? err.message : String(err);
				const errorMessage: ChatMessage = {
					id: `error_${Date.now()}`,
					role: 'system',
					content: `⚠️ 发送失败: ${errorMsg}`,
					timestamp: new Date().toISOString(),
				};
				set(state => ({ messages: [...state.messages, errorMessage] }));
				resetStream();
			}
		},

		cancelStream: () => {
			const { activeAgentId, activeAgentSessionId, streamState } = get();
			console.log(`[ChatStore] cancelStream: activeAgentId=${activeAgentId}, activeAgentSessionId=${activeAgentSessionId}`);

			// ── Preserve already-generated content (VS Code Copilot Chat pattern) ──
			// Instead of discarding everything, commit partial content as a cancelled message.
			const partialText = streamState.textBuffer || '';
			const partialThinking = streamState.thinkingBuffer || '';
			// CRITICAL: also preserve any tool calls that were in flight when the
			// user pressed stop. Without this, those tool cards vanish from history
			// (or, worse, remain "running" in stale state). Force every running
			// tool to a terminal state so cards never spin forever.
			const partialToolCalls = (streamState.toolCalls || []).map(tc => ({
				id: tc.id,
				name: tc.name,
				arguments: tc.arguments,
				result: tc.result,
				status: (tc.status === 'running' ? 'done' : tc.status) as 'pending' | 'running' | 'done' | 'error',
				defaultShow: tc.defaultShow,
				displayName: tc.displayName,
				renderType: tc.renderType,
				serverExecuted: tc.serverExecuted,
				textPosition: tc.textPosition,
			}));

			// Reset the stream state first (stops the streaming bubble)
			resetStreamSilent();

			if (partialText || partialThinking || partialToolCalls.length > 0) {
				// Commit partial content as a cancelled assistant message
				const cancelledMessage: ChatMessage = {
					id: `cancelled_${Date.now()}`,
					role: 'assistant',
					content: partialText || '(已停止生成)',
					thinking: partialThinking || undefined,
					toolCalls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
					timestamp: new Date().toISOString(),
				};
				set(state => ({
					messages: [...state.messages, cancelledMessage],
					streamState: getStreamState(),
				}));
				console.log('[ChatStore] cancelStream: committed partial content as cancelled message', {
					textLen: partialText.length,
					thinkingLen: partialThinking.length,
					toolCalls: partialToolCalls.length,
				});
			} else {
				set({ streamState: getStreamState() });
			}

			// Notify host to abort the upstream stream
			if (activeAgentId) {
				sendRequest('chat.cancel', { agentId: activeAgentId, agentSessionId: activeAgentSessionId ?? undefined }).catch(() => { });
			}

			// Restore agent status
			try { syncAgentStatus('idle'); } catch { /* ignore */ }
		},

		setInputValue: (value) => set({ inputValue: value }),

		clearMessages: () => {
			console.log('[ChatStore] clearMessages called');
			const { activeAgentId, cachedMessages } = get();
			resetStream();
			if (activeAgentId) {
				const newCache = { ...cachedMessages };
				delete newCache[activeAgentId];
				set({ messages: [], cachedMessages: newCache });
			} else {
				set({ messages: [] });
			}
		},

		appendExternalUserMessage: (agentId, message) => {
			const { activeAgentId, messages } = get();
			// Only mirror the bubble if it belongs to the currently visible
			// agent — otherwise the user would see a phantom message in
			// an unrelated chat pane.
			if (activeAgentId !== agentId) {
				console.log(`[ChatStore] appendExternalUserMessage skipped: target=${agentId} active=${activeAgentId}`);
				return;
			}
			// De-dupe by id in case the same event arrives twice (e.g. fast
			// double-click on an imgui submit button).
			if (messages.some(m => m.id === message.id)) {
				return;
			}
			console.log(`[ChatStore] appendExternalUserMessage: ${agentId} id=${message.id} len=${message.content.length}`);
			set(state => ({ messages: [...state.messages, message] }));
		},

		// ─── Agent Session Management (Root mode) ───

		loadAgentSessions: async (agentId: string) => {
			try {
				const sessions = await sendRequest<{ agentId: string }, AgentSessionInfo[]>(
					'agentSession.list',
					{ agentId },
				);
				set({ agentSessions: sessions || [] });
			} catch (err) {
				console.error('[ChatStore] Failed to load agent sessions:', err);
			}
		},

		createAgentSession: async () => {
			const { activeAgentId, activeAgentSessionId: prevSessionId, messages: prevMessages, cachedMessages } = get();
			console.log(
				`[ChatStore] createAgentSession: BEGIN agentId=${activeAgentId} ` +
				`prevSessionId=${prevSessionId} prevMessagesCount=${prevMessages.length}`,
			);
			if (!activeAgentId) {
				console.warn('[ChatStore] createAgentSession: aborted — no activeAgentId');
				return;
			}
			try {
				console.log('[ChatStore] createAgentSession: sending RPC agentSession.create...');
				const meta = await sendRequest<{ agentId: string }, AgentSessionInfo>(
					'agentSession.create',
					{ agentId: activeAgentId },
				);
				console.log(
					`[ChatStore] createAgentSession: RPC returned meta=${JSON.stringify(meta)}`,
				);
				if (meta?.id) {
					const newStreamState = switchActiveStream(activeAgentId, meta.id);
					// Clear cached messages for this agent — creating a new session invalidates the cache
					const newCache = { ...cachedMessages };
					delete newCache[activeAgentId];
					set({ activeAgentSessionId: meta.id, messages: [], streamState: newStreamState, cachedMessages: newCache });
					console.log(
						`[ChatStore] createAgentSession: state updated activeAgentSessionId=${meta.id} messages=[]`,
					);
					get().loadHistoryForSession(activeAgentId, meta.id);
					get().loadAgentSessions(activeAgentId);
					console.log('[ChatStore] createAgentSession: DONE (loadHistory + loadSessions dispatched)');
				} else {
					console.warn('[ChatStore] createAgentSession: meta has no id, skip state update');
				}
			} catch (err) {
				console.error('[ChatStore] createAgentSession: FAILED', err);
			}
		},

		switchAgentSession: async (sessionId: string) => {
			const { activeAgentId, activeAgentSessionId: prevSessionId, cachedMessages, liveWorkflowEvents, liveAskUsers, liveCollectVariables, liveWorkflowExecutions } = get();
			if (!activeAgentId) { return; }
			// 🔧 2026-06-12 fix: only clear the PREVIOUS session's live state, not
			// the new one. The new session's liveWorkflowExecutions entry may
			// have just been populated by the workflow trace router (routeWorkflowTrace
			// → startWorkflowExecution) and wiping it causes all subsequent
			// subagent_start events to silently fail their `if (!exec) return`
			// guard — resulting in no tool cards showing in the chat panel.
			// The previous session's data is stale and safe to drop.
			const newStreamState = switchActiveStream(activeAgentId, sessionId);
			// Clear cached messages for this agent — switching sessions invalidates the cache
			const newCache = { ...cachedMessages };
			delete newCache[activeAgentId];
			// v6 (refined): clear only the PREVIOUS session's workflow live state and
			// timeline events. The committed assistant message in `messages` is preserved
			// (it's already persisted to the host via `chat.append`).
			const newLiveExec = { ...liveWorkflowExecutions };
			const newLiveAsk = { ...liveAskUsers };
			const newLiveCollect = { ...liveCollectVariables };
			const newLiveEvents = { ...liveWorkflowEvents };
			if (prevSessionId && prevSessionId !== sessionId) {
				delete newLiveExec[prevSessionId];
				delete newLiveAsk[prevSessionId];
				delete newLiveCollect[prevSessionId];
				delete newLiveEvents[prevSessionId];
			}
			set({
				activeAgentSessionId: sessionId,
				messages: [],
				streamState: newStreamState,
				cachedMessages: newCache,
				liveWorkflowExecutions: newLiveExec,
				liveAskUsers: newLiveAsk,
				liveCollectVariables: newLiveCollect,
				liveWorkflowEvents: newLiveEvents,
			});
			get().loadHistoryForSession(activeAgentId, sessionId);
		},

		renameAgentSession: async (sessionId: string, newName: string) => {
			const { activeAgentId } = get();
			if (!activeAgentId) { return; }
			try {
				await sendRequest('agentSession.rename', {
					agentId: activeAgentId,
					sessionId,
					name: newName,
				});
				// Update local list
				set(state => ({
					agentSessions: state.agentSessions.map(s =>
						s.id === sessionId ? { ...s, name: newName } : s,
					),
				}));
			} catch (err) {
				console.error('[ChatStore] Failed to rename session:', err);
			}
		},

		deleteAgentSession: async (sessionId: string) => {
			const { activeAgentId, activeAgentSessionId, cachedMessages } = get();
			if (!activeAgentId) { return; }
			try {
				await sendRequest('agentSession.delete', {
					agentId: activeAgentId,
					sessionId,
				});
				// If we deleted the active session, switch back to default
				if (activeAgentSessionId === sessionId) {
					const newStreamState = switchActiveStream(activeAgentId, null);
					// Clear cached messages — deleting the active session invalidates the cache
					const newCache = { ...cachedMessages };
					delete newCache[activeAgentId];
					set({ activeAgentSessionId: null, messages: [], streamState: newStreamState, cachedMessages: newCache });
					get().loadHistoryForSession(activeAgentId, undefined);
				}
				// Reload session list
				get().loadAgentSessions(activeAgentId);
			} catch (err) {
				console.error('[ChatStore] Failed to delete agent session:', err);
			}
		},

		reorderAgentSessions: (orderedIds: string[]) => {
			set(state => {
				const map = new Map(state.agentSessions.map(s => [s.id, s]));
				const reordered = orderedIds
					.map(id => map.get(id))
					.filter((s): s is AgentSessionInfo => !!s);
				// Append any sessions missing from orderedIds (defensive)
				const seen = new Set(orderedIds);
				const trailing = state.agentSessions.filter(s => !seen.has(s.id));
				return { agentSessions: [...reordered, ...trailing] };
			});
		},

		addDecompositionProgress: (agentId: string, message: ChatMessage) => {
			set(state => {
				const existing = state.decompositionProgress[agentId] || [];
				// Avoid duplicates by id
				if (existing.some(m => m.id === message.id)) {
					return state;
				}
				return {
					decompositionProgress: {
						...state.decompositionProgress,
						[agentId]: [...existing, message],
					},
				};
			});
		},

		setChatMode: (mode: 'craft' | 'ask' | 'plan' | 'workflow') => {
			set({ chatMode: mode });
		},

		approvePlanConfirmation: async (confirmation: ConfirmationRequest, buttonId: string) => {
			if (confirmation.type !== 'plan-approval') { return; }

			const { activeAgentId } = get();
			if (!activeAgentId) { return; }

			// 1. Mark the confirmation as approved in local state
			set(state => ({
				messages: state.messages.map(m =>
					m.confirmation?.id === confirmation.id
						? { ...m, confirmation: { ...m.confirmation!, status: 'approved' as const } }
						: m
				),
			}));

			const autoExecute = buttonId === 'approve-execute';

			try {
				const { useAgentStore } = await import('./useAgentStore');
				const { useWorkspaceStore } = await import('./useWorkspaceStore');
				const agent = useAgentStore.getState().agents.find(e => e.id === activeAgentId);
				const workspaceId = agent?.workspaceId || useWorkspaceStore.getState().activeWorkspaceId;

				if (!workspaceId) {
					console.error('[ChatStore] approvePlanConfirmation: no workspaceId found');
					return;
				}

				// 2. Create an OrchestrationPlan from the plan data
				const planGoal = confirmation.planSummary || 'Plan execution';
				const plan = await sendRequest<
					{ goal: string; workspaceId: string; plannerId: string },
					any
				>('orchestration.plan', {
					goal: planGoal,
					workspaceId,
					plannerId: activeAgentId,
				}, 0); // no timeout — plan creation may take a while

				if (!plan?.id) {
					console.error('[ChatStore] approvePlanConfirmation: plan creation returned no id');
					return;
				}

				// 3. Approve the plan — auto-execute or approve-only
				if (autoExecute) {
					await sendRequest<{ planId: string }, any>(
						'orchestration.approve',
						{ planId: plan.id },
					);
				} else {
					await sendRequest<{ planId: string }, any>(
						'orchestration.approveWithoutExecute',
						{ planId: plan.id },
					);
				}

				// 4. Switch chat mode to the recommended next mode (default: craft)
				const nextMode = confirmation.nextMode || 'craft';
				set({ chatMode: nextMode });

				// 5. Add a system message confirming the action
				const actionMsg: ChatMessage = {
					id: `plan_exec_${Date.now()}`,
					role: 'system',
					content: autoExecute
						? `✅ 计划已批准，正在创建 Agent 实例并自动执行 ${plan.tasks?.length || 0} 个任务...`
						: `✅ 计划已批准，${plan.tasks?.length || 0} 个任务已创建到看板。您可以在任务看板中手动启动执行。`,
					timestamp: new Date().toISOString(),
				};
				set(state => ({ messages: [...state.messages, actionMsg] }));

			} catch (err) {
				console.error('[ChatStore] approvePlanConfirmation failed:', err);
				// Add an error system message
				const errMsg: ChatMessage = {
					id: `plan_err_${Date.now()}`,
					role: 'system',
					content: `❌ 计划执行启动失败: ${err instanceof Error ? err.message : String(err)}`,
					timestamp: new Date().toISOString(),
				};
				set(state => ({ messages: [...state.messages, errMsg] }));
			}
		},

		rejectPlanConfirmation: (confirmation: ConfirmationRequest) => {
			// Mark the confirmation as rejected in local state
			set(state => ({
				messages: state.messages.map(m =>
					m.confirmation?.id === confirmation.id
						? { ...m, confirmation: { ...m.confirmation!, status: 'rejected' as const } }
						: m
				),
			}));

			// Add a rejection message
			const rejectMsg: ChatMessage = {
				id: `plan_reject_${Date.now()}`,
				role: 'system',
				content: '❌ 计划已拒绝。您可以继续对话调整方案，或重新规划。',
				timestamp: new Date().toISOString(),
			};
			set(state => ({ messages: [...state.messages, rejectMsg] }));
		},

		addCheckpoint: (checkpoint: CheckpointData) => {
			const checkpointMessage: ChatMessage = {
				id: checkpoint.id,
				role: 'checkpoint',
				content: '',
				timestamp: checkpoint.timestamp,
				checkpoint,
			};
			set(state => ({ messages: [...state.messages, checkpointMessage] }));
		},

		jumpToCheckpoint: (checkpointId: string) => {
			const state = get();
			const agentId = state.activeAgentId;
			const sessionId = state.activeAgentSessionId;
			// Send a request to the host to restore the checkpoint state (file
			// contents on disk). The host scopes storage by agentId+sessionId.
			sendRequest('chat.jumpToCheckpoint', {
				checkpointId,
				agentId: agentId ?? '',
				sessionId: sessionId ?? '',
			}).catch(err => {
				console.error('[ChatStore] jumpToCheckpoint failed:', err);
			});
			// Mark all checkpoints after the target as ghost, and truncate the
			// chat history back to the checkpoint (Void-inspired time travel).
			get().setActiveCheckpoint(checkpointId);
			set(state => {
				const targetIdx = state.messages.findIndex(m => m.id === checkpointId);
				if (targetIdx < 0) { return state; }
				// 截断到目标检查点（含）。同时把目标检查点本身标记为 isKept，
				// 否则 CheckpointBar.latest 仍会选中它（其过滤条件是
				// isGhost||isDisabled||isKept），导致“撤销”后 bar 不消失。
				// 撤销 = 该检查点的变更已回滚，bar 不应再悬浮提示。
				const truncated = state.messages.slice(0, targetIdx + 1).map((m, idx) => {
					if (idx === targetIdx && m.role === 'checkpoint' && m.checkpoint) {
						return { ...m, checkpoint: { ...m.checkpoint, isKept: true } };
					}
					return m;
				});
				return { messages: truncated };
			});
		},

		openCheckpointDiff: (checkpointId: string, fileUri: string) => {
			const state = get();
			// 关键：agentId / sessionId 取自 store 的 active 字段，而非
			// checkpoint 对象——CheckpointData 不携带这两个字段（与
			// jumpToCheckpoint 一致）。否则后端拿到 undefined 找不到快照，
			// getFileSnapshots 返回空 → 提前 return → diff 打不开。
			postMessage('chat.openCheckpointDiff', {
				checkpointId,
				fileUri,
				agentId: state.activeAgentId ?? '',
				sessionId: state.activeAgentSessionId ?? '',
			});
		},

		undoAllCheckpoints: () => {
			const state = get();
			const agentId = state.activeAgentId;
			const sessionId = state.activeAgentSessionId;

			// 找到第一个 tool_edit 检查点，及其之前最近的一条 user 消息
			// （= 触发全部编辑的最初输入点）。撤销 = 回到该输入点之后、
			// 任何编辑发生之前的状态，所以截断保留到那条 user 消息（含）。
			const msgs = state.messages;
			let firstCpIdx = -1;
			for (let i = 0; i < msgs.length; i++) {
				const m = msgs[i];
				if (m.role === 'checkpoint' && m.checkpoint && m.checkpoint.type === 'tool_edit') {
					firstCpIdx = i;
					break;
				}
			}
			let truncateAfterMessageId: string | undefined;
			if (firstCpIdx >= 0) {
				for (let i = firstCpIdx - 1; i >= 0; i--) {
					if (msgs[i].role === 'user') {
						truncateAfterMessageId = msgs[i].id;
						break;
					}
				}
			}

			// 通知 host 把所有文件还原到最初状态并 ghost 全部检查点。
			sendRequest('chat.revertAllCheckpoints', {
				agentId: agentId ?? '',
				sessionId: sessionId ?? '',
				truncateAfterMessageId,
			}).catch(err => {
				console.error('[ChatStore] undoAllCheckpoints failed:', err);
			});

			// 本地截断聊天历史：保留到最初 user 输入点（含）。若找不到锚点
			// （无 user 消息），则退化为移除所有 checkpoint 消息使 bar 消失。
			set(state => {
				if (truncateAfterMessageId) {
					const idx = state.messages.findIndex(m => m.id === truncateAfterMessageId);
					if (idx >= 0) {
						return { messages: state.messages.slice(0, idx + 1) };
					}
				}
				return {
					messages: state.messages.filter(
						m => !(m.role === 'checkpoint' && m.checkpoint?.type === 'tool_edit')
					),
				};
			});
		},

		/** 保留全部检查点：移除 checkpoint 消息 + 删除磁盘数据，reload 后不重现。 */
		keepAllCheckpoints: () => {
			const state = get();
			// Remove checkpoint messages from store (bar disappears immediately).
			set(state => ({
				messages: state.messages.filter(m =>
					!(m.role === 'checkpoint' && m.checkpoint?.type === 'tool_edit'),
				),
			}));
			// Delete all on-disk checkpoint data so reload will not re-show the bar.
			postMessage('chat.keepAllCheckpoints', {
				agentId: state.activeAgentId ?? '',
				sessionId: state.activeAgentSessionId ?? '',
			});
		},

		openAllCheckpointsDiff: () => {
			const state = get();
			postMessage('chat.openAllCheckpointsDiff', {
				agentId: state.activeAgentId ?? '',
				sessionId: state.activeAgentSessionId ?? '',
			});
		},

		setActiveCheckpoint: (checkpointId: string) => {
			set(state => {
				const targetIdx = state.messages.findIndex(m => m.id === checkpointId);
				if (targetIdx < 0) { return state; }
				return {
					messages: state.messages.map((m, idx) => {
						if (m.role !== 'checkpoint' || !m.checkpoint) { return m; }
						return {
							...m,
							checkpoint: {
								...m.checkpoint,
								isGhost: idx > targetIdx,
							},
						};
					}),
				};
			});
		},

		keepCheckpoint: (checkpointId: string) => {
			set(state => ({
				messages: state.messages.map(m => {
					if (m.role !== 'checkpoint' || !m.checkpoint) { return m; }
					if (m.checkpoint.id !== checkpointId) { return m; }
					return {
						...m,
						checkpoint: { ...m.checkpoint, isKept: true },
					};
				}),
			}));
		},

		getLatestCheckpoint: () => {
			const { messages } = get();
			// Walk from newest → oldest to find the most recent renderable tool_edit checkpoint.
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i];
				if (m.role !== 'checkpoint' || !m.checkpoint) { continue; }
				const cp = m.checkpoint;
				if (cp.type !== 'tool_edit') { continue; }
				if (cp.isGhost || cp.isDisabled || cp.isKept) { continue; }
				return cp;
			}
			return undefined;
		},

		removeMessagesAfter: (messageId: string) => {
			set(state => {
				const targetIdx = state.messages.findIndex(m => m.id === messageId);
				if (targetIdx < 0) { return state; }
				// Keep messages up to and including targetIdx
				return {
					messages: state.messages.slice(0, targetIdx + 1),
				};
			});
		},

		// ─── P4: Live workflow execution handlers ─────────────────────────

		/**
		 * Begin tracking a new workflow execution. Called on `subagent_start`
		 * with nodeId='__workflow__' (the workflow-level start event).
		 */
		startWorkflowExecution: (executionId: string, sessionId: string, workflowName: string) => {
			console.log(`[ChatStore] startWorkflowExecution: executionId=${executionId} sessionId=${sessionId}`);
			set(state => ({
				liveWorkflowExecutions: {
					...state.liveWorkflowExecutions,
					[sessionId]: {
						executionId,
						workflowName,
						status: 'running',
						subAgents: [],
						startTime: Date.now(),
					},
				},
			}));
		},

		/**
		 * Start a sub-agent (workflow node). Called when host fires
		 * `subagent_start` with a real nodeId.
		 */
		startWorkflowSubAgent: (sessionId: string, subAgent: LiveWorkflowSubAgent) => {
			console.log(`[ChatStore] startWorkflowSubAgent: sessionId=${sessionId} nodeId=${subAgent.id} name=${subAgent.name}`);
			set(state => {
				let exec = state.liveWorkflowExecutions[sessionId];
				if (!exec) {
					// Fallback: __workflow__ root event was missed (e.g. timing race
					// or event dropped). Auto-create the execution container so the
					// sub-agent card can still render.
					console.warn(`[ChatStore] startWorkflowSubAgent: execution not found for session=${sessionId}, auto-creating fallback container`);
					exec = {
						executionId: `fallback_${sessionId}`,
						workflowName: subAgent.name || 'Workflow',
						status: 'running' as const,
						subAgents: [],
						startTime: Date.now(),
					};
				}
				// If a previous entry for this node exists (e.g. from a previous run),
				// replace it. Otherwise append.
				const existingIdx = exec.subAgents.findIndex(sa => sa.id === subAgent.id);
				const nextSubAgents = existingIdx >= 0
					? exec.subAgents.map((sa, i) => i === existingIdx ? subAgent : sa)
					: [...exec.subAgents, subAgent];
				return {
					liveWorkflowExecutions: {
						...state.liveWorkflowExecutions,
						[sessionId]: {
							...exec,
							currentNodeId: subAgent.id,
							subAgents: nextSubAgents,
						},
					},
				};
			});
		},

		/**
		 * Append a streaming delta to the active sub-agent. `delta` is a
		 * sanitized IChatStreamDelta-like object (text/thinking/tool_start/
		 * tool_args/tool_result/usage).
		 */
		appendWorkflowTraceDelta: (sessionId: string, nodeId: string, delta: any) => {
			set(state => {
				const exec = state.liveWorkflowExecutions[sessionId];
				if (!exec) { return state; }
				const subAgentIdx = exec.subAgents.findIndex(sa => sa.id === nodeId);
				if (subAgentIdx < 0) { return state; }
				const subAgent = exec.subAgents[subAgentIdx];

				// Apply delta to the sub-agent (similar logic to AgentChatService).
				let next: LiveWorkflowSubAgent = { ...subAgent };
				if (delta.type === 'text' && typeof delta.content === 'string') {
					next.streamedText = (next.streamedText ?? '') + delta.content;
				} else if (delta.type === 'thinking' && typeof delta.content === 'string') {
					next.streamedThinking = (next.streamedThinking ?? '') + delta.content;
				} else if (delta.type === 'content_replace' && typeof delta.content === 'string') {
					// upstream extracted tool calls → replace text buffer
					next.streamedText = delta.content;
				} else if (delta.type === 'tool_start' && delta.toolCallId && delta.toolName) {
					const existing = next.toolCalls.find(tc => tc.id === delta.toolCallId);
					if (!existing) {
						next.toolCalls = [
							...next.toolCalls,
							{
								id: delta.toolCallId,
								name: delta.toolName,
								arguments: '',
								status: 'running',
							},
						];
					}
				} else if (delta.type === 'tool_args' && delta.toolCallId && typeof delta.content === 'string') {
					next.toolCalls = next.toolCalls.map(tc =>
						tc.id === delta.toolCallId
							? { ...tc, arguments: (tc.arguments ?? '') + delta.content }
							: tc,
					);
				} else if (delta.type === 'tool_result' && delta.toolCallId) {
					next.toolCalls = next.toolCalls.map(tc =>
						tc.id === delta.toolCallId
							? { ...tc, result: delta.content, status: delta.success === false ? 'error' : 'done' }
							: tc,
					);
				}

				const newSubAgents = exec.subAgents.map((sa, i) => i === subAgentIdx ? next : sa);
				return {
					liveWorkflowExecutions: {
						...state.liveWorkflowExecutions,
						[sessionId]: {
							...exec,
							subAgents: newSubAgents,
						},
					},
				};
			});
		},

		/**
		 * Mark a sub-agent as done (or error). Called on `subagent_end`.
		 */
		endWorkflowSubAgent: (sessionId: string, nodeId: string,
			// v21: 'cancelled' is fired when the user clicked Cancel while the
			// node was mid-stream. The host aborted the underlying LLM call and
			// surfaced it via subagent_end status — the card flips to a
			// "cancelled" badge instead of the success badge.
			status: 'done' | 'error' | 'cancelled',
			output?: string, error?: string) => {
			console.log(`[ChatStore] endWorkflowSubAgent: sessionId=${sessionId} nodeId=${nodeId} status=${status}`);
			set(state => {
				const exec = state.liveWorkflowExecutions[sessionId];
				if (!exec) { return state; }
				const subAgentIdx = exec.subAgents.findIndex(sa => sa.id === nodeId);
				if (subAgentIdx < 0) { return state; }
				const subAgent = exec.subAgents[subAgentIdx];
				const updated: LiveWorkflowSubAgent = {
					...subAgent,
					status,
					output: output ?? subAgent.output,
					error: error ?? subAgent.error,
					endTime: Date.now(),
				};
				return {
					liveWorkflowExecutions: {
						...state.liveWorkflowExecutions,
						[sessionId]: {
							...exec,
							subAgents: exec.subAgents.map((sa, i) => i === subAgentIdx ? updated : sa),
						},
					},
				};
			});
		},

		/**
		 * Commit the live execution as a permanent assistant message and
		 * remove it from the live map. Called on `execution_end`.
		 */
		commitWorkflowExecution: (sessionId: string, status: 'completed' | 'failed' | 'cancelled') => {
			console.log(`[ChatStore] commitWorkflowExecution: sessionId=${sessionId} status=${status}`);
			// Captured for the post-commit host persistence. The `set()` updater
			// below MUST stay a pure function (no side effects / no async work),
			// otherwise React 19's useSyncExternalStore can invoke it twice and
			// double-fire the persist request. We collect what to persist here
			// and fire the request AFTER set() returns.
			let _persistPayload: { agentId: string; message: ChatMessage; executionId: string } | undefined;
			set(state => {
				const exec = state.liveWorkflowExecutions[sessionId];
				if (!exec) { return state; }

				// Build a permanent assistant message carrying the subagent trace.
				// Format subAgents as the existing SubAgentInfo shape so the
				// SubAgentCard component renders it correctly.
				const subAgentsForMessage = exec.subAgents
					.filter(sa => sa.id !== '__workflow__') // skip synthetic root
					.map(sa => ({
						id: sa.id,
						name: sa.name,
						type: 'general' as const,
						task: sa.task,
						parentAgentId: state.activeAgentId ?? undefined,
						status: sa.status === 'cancelled' ? 'cancelled' as const
							: sa.status === 'error' ? 'error' as const
								: sa.status === 'done' ? 'done' as const
									: 'pending' as const,
						progress: sa.status === 'running' ? sa.streamedText?.slice(-200) : undefined,
						output: sa.output ?? (sa.streamedText ? sa.streamedText.slice(0, 4000) : ''),
						error: sa.error,
						// P4 v3: persist thinking + tool trace so the card still
						// renders them after page reload / chat history restore.
						thinking: sa.streamedThinking,
						toolTrace: sa.toolCalls,
					}));

				// v5d: also capture answered AskUser cards so the run history can
				// replay the user's choices. Filter to only 'answered' status
				// (cancelled/expired are noise; pending would be a bug).
				const askUsersForMessage = (state.liveAskUsers[sessionId] ?? [])
					.filter(a => a.status === 'answered');

				// v7: flatten all subAgent tool calls into top-level toolCalls
				// so that Native Chat's AgentChatPanel can render ToolCallCards.
				const allToolCalls = exec.subAgents.flatMap(sa =>
					(sa.toolCalls ?? []).map(tc => ({
						id: tc.id,
						name: tc.name,
						args: tc.arguments,
						result: tc.result,
						status: (tc.status === 'done' ? 'completed' as const : tc.status) as ('running' | 'completed' | 'error' | undefined),
					}))
				);

				const assistantMessage: ChatMessage = {
					id: `wf_run_${exec.executionId}`,
					role: 'assistant',
					content: `▶ Workflow run: **${exec.workflowName}** — ${status === 'completed' ? '✓ 完成' : status === 'failed' ? '✗ 失败' : '已取消'}`,
					timestamp: new Date(exec.startTime).toISOString(),
					subAgents: subAgentsForMessage,
					// v7: include top-level toolCalls for NativeChat rendering
					...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
					// v5d: persist only when there are answered AskUser cards
					// (omit the field entirely when empty to keep messages lean).
					...(askUsersForMessage.length > 0 ? { askUsers: askUsersForMessage } : {}),
				};

				// Drop from live map (keep the message permanently in `messages`).
				const nextLive = { ...state.liveWorkflowExecutions };
				const nextAsk = { ...state.liveAskUsers };
				// v6 (refined): KEEP the timeline events after execution completes.
				// The user wants the timeline to remain visible after a run finishes
				// so they can review what happened; it only clears on session switch
				// (handled by `clearWorkflowEvents` in `switchAgentSession` / `setActiveAgent`).
				const nextEvents = state.liveWorkflowEvents;
				delete nextLive[sessionId];
				delete nextAsk[sessionId];

				// Only append if the active session matches; if user switched away
				// during the run, skip appending to avoid polluting another session.
				const isActiveSession = state.activeAgentSessionId === sessionId;

				// Bug fix: also persist the assistant message to the host so that
				// the workflow run trace (subAgents + toolTrace + askUsers) survives
				// a window reload. Previously this only mutated in-memory messages,
				// so the tool cards disappeared after Cmd+R.
				// NOTE: we only CAPTURE the payload here; the actual async
				// `chat.append` request is fired AFTER set() returns to keep this
				// updater pure (see _persistPayload declaration above).
				if (isActiveSession && state.activeAgentId) {
					// Ensure the message carries an agentSessionId so the host's
					// noSession guard doesn't drop it.
					const persistable: ChatMessage = {
						...assistantMessage,
						agentSessionId: sessionId,
					};
					_persistPayload = {
						agentId: state.activeAgentId,
						message: persistable,
						executionId: exec.executionId,
					};
				}

				if (!isActiveSession) {
					return { liveWorkflowExecutions: nextLive, liveAskUsers: nextAsk, liveCollectVariables: state.liveCollectVariables, liveWorkflowEvents: nextEvents };
				}
				return {
					messages: [...state.messages, assistantMessage],
					liveWorkflowExecutions: nextLive,
					liveAskUsers: nextAsk,
					liveCollectVariables: state.liveCollectVariables,
					liveWorkflowEvents: nextEvents,
				};
			});

			// Fire-and-forget host persistence AFTER set() returns, so the
			// updater stays pure. The in-memory message already rendered.
			if (_persistPayload) {
				const { agentId, message, executionId } = _persistPayload;
				void (async () => {
					try {
						await sendRequest('chat.append', { agentId, message });
						console.log(`[ChatStore] commitWorkflowExecution: persisted wf_run_${executionId} to host`);
					} catch (err) {
						console.warn(`[ChatStore] commitWorkflowExecution: chat.append failed for wf_run_${executionId}`, err);
					}
				})();
			}
		},

		/**
		 * Drop a live execution without committing (e.g. on user cancel or
		 * session switch). The execution's trace is lost (not persisted).
		 */
		discardWorkflowExecution: (sessionId: string) => {
			set(state => {
				if (!state.liveWorkflowExecutions[sessionId]) { return state; }
				const next = { ...state.liveWorkflowExecutions };
				const nextAsk = { ...state.liveAskUsers };
				const nextCollect = { ...state.liveCollectVariables };
				const nextEvents = { ...state.liveWorkflowEvents };
				delete next[sessionId];
				delete nextAsk[sessionId];
				delete nextCollect[sessionId];
				delete nextEvents[sessionId];
				return { liveWorkflowExecutions: next, liveAskUsers: nextAsk, liveCollectVariables: nextCollect, liveWorkflowEvents: nextEvents };
			});
		},

		// ─── v22: Cancel running workflow from chat panel ───────────────────

		/**
		 * Find the currently-running workflow execution (if any) and send a
		 * `workflow.cancel` RPC to the host to abort it. The host's
		 * `cancelExecution` aborts the in-flight LLM stream and resolves any
		 * pending AskUser / variable-collection promises, so the UI updates
		 * within milliseconds of the click.
		 *
		 * This is wired up to the chat composer's send/stop toggle so the
		 * user can stop a running workflow from the chat panel (the
		 * `onCancel` callback) without having to go back to the workflow
		 * editor toolbar.
		 */
		cancelCurrentWorkflow: async (): Promise<void> => {
			const liveExecs = get().liveWorkflowExecutions;
			const running: Array<{ sessionId: string; executionId: string }> = [];
			for (const [sid, exec] of Object.entries(liveExecs)) {
				if (exec.status === 'running') {
					running.push({ sessionId: sid, executionId: exec.executionId });
				}
			}
			if (running.length === 0) {
				console.log('[ChatStore] cancelCurrentWorkflow: no running workflow');
				return;
			}
			console.log(`[ChatStore] cancelCurrentWorkflow: cancelling ${running.length} execution(s)`);
			await Promise.allSettled(
				running.map(({ executionId }) =>
					sendRequest('workflow.cancel', { executionId }).catch(err => {
						console.warn(`[ChatStore] cancelCurrentWorkflow: cancel ${executionId} failed`, err);
					}),
				),
			);
		},

		// ─── v5b: Execution timeline ─────────────────────────────────────

		/** Cap on the number of events per session — oldest dropped first. */
		// v5b: kept as a private constant in this module to avoid bloating the API.
		// v5b note: declared inside the create() closure as a closure-captured const.
		appendWorkflowEvent: (sessionId: string, event) => {
			set(state => {
				const list = state.liveWorkflowEvents[sessionId] ?? [];
				const id = `${event.executionId}:${event.nodeId}:${event.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
				const next = [...list, { ...event, id, timestamp: Date.now() }];
				// Cap at 200 events per session; drop oldest.
				const MAX_EVENTS = 200;
				if (next.length > MAX_EVENTS) { next.splice(0, next.length - MAX_EVENTS); }
				return { liveWorkflowEvents: { ...state.liveWorkflowEvents, [sessionId]: next } };
			});
		},

		clearWorkflowEvents: (sessionId: string) => {
			set(state => {
				if (!state.liveWorkflowEvents[sessionId]) { return state; }
				const next = { ...state.liveWorkflowEvents };
				delete next[sessionId];
				return { liveWorkflowEvents: next };
			});
		},

		// ─── P4 v4: Live AskUser handlers ─────────────────────────────────

		/**
		 * Register a new pending AskUser request for the given session. The
		 * caller is the trace router in `webview/src/index.tsx`; the AskUserCard
		 * will render this entry and post the user's response back via
		 * `submitAskUser`.
		 */
		startAskUser: (sessionId: string, askUser: Omit<LiveWorkflowAskUser, 'id' | 'selectedIndices' | 'status' | 'createdAt'>) => {
			const id = `${askUser.executionId}:${askUser.nodeId}`;
			console.log(`[ChatStore] startAskUser: id=${id} sessionId=${sessionId} question="${askUser.question.substring(0, 40)}"`);
			set(state => {
				const existing = state.liveAskUsers[sessionId] ?? [];
				// Dedup: if an entry with the same id is already there, skip.
				if (existing.some(a => a.id === id)) { return state; }
				const entry: LiveWorkflowAskUser = {
					id,
					...askUser,
					selectedIndices: [],
					status: 'pending',
					createdAt: Date.now(),
				};
				return {
					liveAskUsers: {
						...state.liveAskUsers,
						[sessionId]: [...existing, entry],
					},
				};
			});
		},

		/**
		 * v4: update the locally-selected option indices for a pending AskUser.
		 * Pure UI state — no network call. The actual submission happens in
		 * `submitAskUser`.
		 */
		updateAskUserSelection: (sessionId: string, askUserId: string, selectedIndices: number[]) => {
			set(state => {
				const list = state.liveAskUsers[sessionId];
				if (!list) { return state; }
				const next = list.map(a => a.id === askUserId ? { ...a, selectedIndices } : a);
				return { liveAskUsers: { ...state.liveAskUsers, [sessionId]: next } };
			});
		},

		/**
		 * v4: submit the user's selection. Sends `workflow.resume` to the host
		 * (which routes to resumeExecution → unblocks pauseExecution) and
		 * optimistically flips the card to "answered" state. If the host call
		 * fails, the card rolls back to "pending".
		 */
		submitAskUser: async (sessionId: string, askUserId: string, selection: string | string[]) => {
			// Optimistic update first.
			set(state => {
				const list = state.liveAskUsers[sessionId];
				if (!list) { return state; }
				const next = list.map(a => a.id === askUserId
					? { ...a, status: 'answered' as const, selection, answeredAt: Date.now() }
					: a);
				return { liveAskUsers: { ...state.liveAskUsers, [sessionId]: next } };
			});

			// Find the entry to get executionId.
			const entry = get().liveAskUsers[sessionId]?.find(a => a.id === askUserId);
			if (!entry) {
				console.warn(`[ChatStore] submitAskUser: entry ${askUserId} not found`);
				return;
			}

			try {
				await sendRequest('workflow.resume', {
					executionId: entry.executionId,
					userInput: selection,
				});
				console.log(`[ChatStore] submitAskUser: sent workflow.resume for ${askUserId}`);
			} catch (err) {
				// Rollback on failure.
				console.error(`[ChatStore] submitAskUser: workflow.resume failed for ${askUserId}`, err);
				set(state => {
					const list = state.liveAskUsers[sessionId];
					if (!list) { return state; }
					const next = list.map(a => a.id === askUserId
						? { ...a, status: 'pending' as const, selection: undefined, answeredAt: undefined }
						: a);
					return { liveAskUsers: { ...state.liveAskUsers, [sessionId]: next } };
				});
			}
		},

		/**
		 * v4: mark a pending AskUser as cancelled (host fired ask_user_end
		 * with status='cancelled', e.g. workflow was cancelled). The card flips
		 * to a read-only "cancelled" state.
		 */
		cancelAskUser: (sessionId: string, askUserId: string, status: 'cancelled' | 'expired') => {
			console.log(`[ChatStore] cancelAskUser: id=${askUserId} status=${status}`);
			set(state => {
				const list = state.liveAskUsers[sessionId];
				if (!list) { return state; }
				const next = list.map(a => a.id === askUserId && a.status === 'pending'
					? { ...a, status, answeredAt: Date.now() }
					: a);
				return { liveAskUsers: { ...state.liveAskUsers, [sessionId]: next } };
			});
		},

		// ── v6: Variable collection actions ────────────────────────────

		startCollectVariables: (sessionId, collect) => {
			const id = collect.executionId;
			console.log(`[ChatStore] startCollectVariables: id=${id} sessionId=${sessionId} vars=${collect.variables.map(v => v.name).join(',')}`);
			// Init values map with empty strings
			const values: Record<string, string> = {};
			for (const v of collect.variables) {
				values[v.name] = v.defaultValue ?? '';
			}
			set(state => {
				const existing = state.liveCollectVariables[sessionId] ?? [];
				if (existing.some(c => c.id === id)) { return state; }
				const entry: LiveCollectVariable = {
					...collect,
					id,
					values,
					status: 'pending',
					createdAt: Date.now(),
				};
				return {
					liveCollectVariables: { ...state.liveCollectVariables, [sessionId]: [...existing, entry] },
				};
			});
		},

		updateCollectVariableValue: (sessionId, collectId, varName, value) => {
			set(state => {
				const list = state.liveCollectVariables[sessionId];
				if (!list) { return state; }
				const next = list.map(c =>
					c.id === collectId && c.status === 'pending'
						? { ...c, values: { ...c.values, [varName]: value } }
						: c
				);
				return { liveCollectVariables: { ...state.liveCollectVariables, [sessionId]: next } };
			});
		},

		submitCollectVariables: async (sessionId, collectId, values) => {
			// Optimistic update
			set(state => {
				const list = state.liveCollectVariables[sessionId];
				if (!list) { return state; }
				const next = list.map(c =>
					c.id === collectId && c.status === 'pending'
						? { ...c, status: 'submitted' as const, values }
						: c
				);
				return { liveCollectVariables: { ...state.liveCollectVariables, [sessionId]: next } };
			});

			const entry = get().liveCollectVariables[sessionId]?.find(c => c.id === collectId);
			if (!entry) {
				console.warn(`[ChatStore] submitCollectVariables: entry ${collectId} not found`);
				return;
			}

			try {
				await sendRequest('workflow.submitVariables', {
					executionId: entry.executionId,
					values,
				});
				console.log(`[ChatStore] submitCollectVariables: sent workflow.submitVariables for ${collectId}`);
			} catch (err) {
				console.error(`[ChatStore] submitCollectVariables: workflow.submitVariables failed for ${collectId}`, err);
				// Rollback
				set(state => {
					const list = state.liveCollectVariables[sessionId];
					if (!list) { return state; }
					const next = list.map(c =>
						c.id === collectId ? { ...c, status: 'pending' as const } : c
					);
					return { liveCollectVariables: { ...state.liveCollectVariables, [sessionId]: next } };
				});
			}
		},

		cancelCollectVariables: (sessionId, collectId) => {
			set(state => {
				const list = state.liveCollectVariables[sessionId];
				if (!list) { return state; }
				const next = list.map(c =>
					c.id === collectId && c.status === 'pending'
						? { ...c, status: 'skipped' as const }
						: c
				);
				return { liveCollectVariables: { ...state.liveCollectVariables, [sessionId]: next } };
			});
		},
	};
});
