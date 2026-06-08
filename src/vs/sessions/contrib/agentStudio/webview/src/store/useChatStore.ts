/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Store (Zustand)
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import { create } from 'zustand';
import { sendRequest, postMessage } from '../bridge/messageClient';
import { subscribeStream, onStreamComplete, getStreamState, resetStream, resetStreamSilent, switchActiveStream, buildChatMessagesFromState, type StreamState, type StreamError, isPhaseActive } from '../bridge/streamHandler';
import { useEmployeeStore } from './useEmployeeStore';

/**
 * Phantom tool names — DEPRECATED: visibility is now controlled solely by
 * `defaultShow`. Kept as empty set for backward compatibility.
 */
const PHANTOM_TOOL_NAMES = new Set<string>([]);

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
	/** Final output */
	output?: string;
	/** Error message */
	error?: string;
	/** Group ID for parallel batch grouping (e.g., "batch-1") */
	groupId?: string;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'tool' | 'system' | 'checkpoint';
	content: string;
	thinking?: string;
	toolCalls?: { id: string; name: string; arguments: string; result?: string; status: string; defaultShow?: boolean; displayName?: string; renderType?: string; serverExecuted?: boolean; textPosition?: number }[];
	/**
	 * Hermes-style 回合标识（2026-06-05 治本根因修复）。
	 * 同一次用户请求触发的多轮 agentOS loop 会持久化多条 assistant 消息共享同一
	 * turnId。EmployeeChat 渲染时把相邻同 turnId 的 assistant 消息聚合成一个气泡，
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
	/** Current chat mode: craft / ask / plan / workflow */
	chatMode: 'craft' | 'ask' | 'plan' | 'workflow';

	// Actions
	setActiveAgent: (agentId: string) => void;
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
	setChatMode: (mode: 'craft' | 'ask' | 'plan' | 'workflow') => void;
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
}

export const useChatStore = create<ChatState>((set, get) => {
	// Helper: update the active agent's status in the employee store
	function syncAgentStatus(status: 'idle' | 'thinking' | 'working') {
		const activeId = get().activeAgentId;
		if (!activeId) return;
		useEmployeeStore.setState(state => ({
			employees: state.employees.map(e =>
				e.id === activeId ? { ...e, status } : e
			),
		}));
	}

	// Subscribe to stream state updates (live streaming indicator)
	subscribeStream((streamState) => {
		// Ignore stream updates that don't belong to the currently active agent/session.
		// This prevents stale deltas from a previous chat from leaking into the
		// currently displayed chat after the user switches employees.
		const { activeAgentId, activeAgentSessionId } = get();
		if (isPhaseActive(streamState.phase) && streamState.agentId && streamState.agentId !== activeAgentId) {
			return;
		}
		if (isPhaseActive(streamState.phase) && streamState.sessionId && activeAgentSessionId &&
			streamState.sessionId !== activeAgentSessionId) {
			return;
		}

		set({ streamState });

		// Sync employee status based on streaming phase (precise state machine)
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

		// Guard: discard completion events for a different employee/session
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
			// Restore employee status AFTER messages are committed
			try { syncAgentStatus('idle'); } catch { /* ignore */ }
			console.log('[ChatStore] Error message committed', { level: structuredError.level, retryable: structuredError.retryable });
			return;
		}

		// Prefer the host-assembled message (hostMessage) as the authoritative source
		// because it accumulates ALL deltas server-side without any risk of missing
		// chunks due to RAF cancellation, background-stream switching, or other
		// webview-side timing issues. Fall back to the webview-side buffers only
		// when the host didn't provide the field.
		// Additionally, as a defensive measure, always pick the LONGER of the two
		// sources — this guards against any scenario where the webview buffer is
		// truncated (e.g. switch-related timing) or the hostMessage is unexpectedly
		// incomplete (e.g. error mid-stream where host still sends partial content).
		const hostText = (hostMessage?.content as string) || '';
		const hostThinking = (hostMessage?.thinking as string) || '';
		const textContent = hostText.length >= finalState.textBuffer.length ? hostText : finalState.textBuffer;
		const thinkingContent = hostThinking.length >= finalState.thinkingBuffer.length ? hostThinking : finalState.thinkingBuffer;

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

		// DEBUG: Detect content mismatch between streaming buffer and host message
		if (hostText && finalState.textBuffer && hostText !== finalState.textBuffer) {
			console.warn('[ChatStore] ⚠️ CONTENT MISMATCH between stream buffer and host message!', {
				bufferFirst100: finalState.textBuffer.substring(0, 100),
				hostFirst100: hostText.substring(0, 100),
				bufferLast100: finalState.textBuffer.substring(Math.max(0, finalState.textBuffer.length - 100)),
				hostLast100: hostText.substring(Math.max(0, hostText.length - 100)),
				// Check heading normalization difference
				bufferHeadings: (finalState.textBuffer.match(/^#{1,6}.{0,30}/gm) || []).slice(0, 5),
				hostHeadings: (hostText.match(/^#{1,6}.{0,30}/gm) || []).slice(0, 5),
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
			set(state => {
				console.log('[ChatStore] Committing assistant message, current messages count:', state.messages.length, ', new msg id:', assistantMessage.id);
				return {
					messages: [...state.messages, assistantMessage],
					streamState: getStreamState(),
				};
			});
		} else {
			console.warn('[ChatStore] onStreamComplete: No content to build message from! This should not happen in normal flow.');
			// Still sync streamState even when there is no content
			set({ streamState: getStreamState() });
		}

		// Restore employee status AFTER messages and streamState are committed.
		// This must come last to avoid triggering React re-renders that could
		// see an intermediate state where streaming stopped but no message exists.
		try { syncAgentStatus('idle'); } catch { /* ignore */ }
		console.log('[ChatStore] onStreamComplete done, employee status restored to idle');
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

		setActiveAgent: (agentId: string) => {
			const current = get().activeAgentId;
			console.log(`[ChatStore] setActiveAgent: ${current} → ${agentId}`);
			if (current === agentId) {
				return;
			}

			// Check if in Fork mode — use fork's agentSessionId
			let forkSessionId: string | null = null;
			try {
				const { useWorkspaceSessionStore } = require('./useWorkspaceSessionStore');
				forkSessionId = useWorkspaceSessionStore.getState().getAgentSessionId(agentId);
			} catch { /* store not available */ }

			// Save current stream to background and restore any saved stream for the new employee.
			// Must be done atomically with updating activeAgentId so subscribeStream
			// doesn't discard the restored stream due to stale activeAgentId.
			const newStreamState = switchActiveStream(agentId, forkSessionId);

			// Save current agent's messages to cache, restore cached messages for target agent
			const { messages: currentMessages, cachedMessages } = get();
			const newCache = { ...cachedMessages };
			if (current && currentMessages.length > 0) {
				newCache[current] = currentMessages;
			}
			const restoredMessages = newCache[agentId] || [];

			set({
				activeAgentId: agentId,
				activeAgentSessionId: forkSessionId,
				messages: restoredMessages,
				inputValue: '',
				agentSessions: [],
				streamState: newStreamState,
				chatMode: 'craft',
				cachedMessages: newCache,
			});

			if (forkSessionId) {
				// Fork mode: directly load fork session
				get().loadHistoryForSession(agentId, forkSessionId);
			} else {
				// Root mode: load sessions list ONLY (for sidebar display).
				// 🔒 修复（2026-06-05）：之前会自动把 `activeAgentSessionId` 设到
				// sessions[0]（最近一条）并 loadHistoryForSession，导致用户切到
				// employee 那一刻就隐式"恢复"了上一次几百轮的旧 session，再发消息
				// 时 sendMessage 看到 activeAgentSessionId 非空就直接复用，整段历史
				// 被回灌给模型（log 里 305 条跨主题/跨 worktree 串台即此故障——
				// 之前修的 sendMessage 兜底分支根本走不到，因为 activeAgentSessionId
				// 早被这里自动激活了）。
				//
				// 新行为：只把 sessions 列表填到侧边栏，**不自动激活最近一条**。
				// activeAgentSessionId 保持 null，sendMessage 会走 `agentSession.create`
				// 开全新空 session。要恢复旧会话必须从历史列表显式点选。
				sendRequest<{ agentId: string }, AgentSessionInfo[]>(
					'agentSession.list',
					{ agentId },
				).then(sessions => {
					if (get().activeAgentId !== agentId) { return; }
					set({ agentSessions: sessions || [] });
					// Intentionally do NOT auto-activate sessions[0]. Leave
					// activeAgentSessionId === null so the next sendMessage opens
					// a fresh empty session with no historical context.
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

				// Restore any decomposition progress messages for this employee
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

			// Restore employee status
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
			// employee — otherwise the user would see a phantom message in
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
			const { activeAgentId, cachedMessages } = get();
			if (!activeAgentId) { return; }
			const newStreamState = switchActiveStream(activeAgentId, sessionId);
			// Clear cached messages for this agent — switching sessions invalidates the cache
			const newCache = { ...cachedMessages };
			delete newCache[activeAgentId];
			set({ activeAgentSessionId: sessionId, messages: [], streamState: newStreamState, cachedMessages: newCache });
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
				const { useEmployeeStore } = await import('./useEmployeeStore');
				const { useWorkspaceStore } = await import('./useWorkspaceStore');
				const employee = useEmployeeStore.getState().employees.find(e => e.id === activeAgentId);
				const workspaceId = employee?.workspaceId || useWorkspaceStore.getState().activeWorkspaceId;

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
	};
});
