
/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Chat Panel
 *
 *  Full-featured chat panel supporting:
 *  - Chat header with provider icon + avatar + name + status
 *  - Session info bar (PM / members / tasks)
 *  - Message list with auto-scroll
 *  - Enhanced streaming indicator with thinking card, tool calls, streaming text
 *  - Full Composer with provider/model pill
 *
 *  Ref: sarosis-webui EmployeeChat.tsx main chat layout
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChatStore, type ChatMessage } from '../../store/useChatStore';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';
import { useProviderStore } from '../../store/useProviderStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { ChatMessageComponent } from './ChatMessage';
import { ChatComposer } from './ChatComposer';
import { CheckpointBar } from './CheckpointBar';
import { ToolCallCard } from './ToolCallCard';
import { SubAgentCard } from './SubAgentCard';
import { MarkdownRenderer, InterleavedMarkdownRenderer } from './MarkdownRenderer';
import { AgentSessionSwitcher } from './AgentSessionSwitcher';
import { WorktreeSwitcher } from './WorktreeSwitcher';
import { sanitizeStreamingText, sanitizeToolResultText } from '../../utils/assistantVisibleText';
import type { StreamError, StreamPhase } from '../../bridge/streamHandler';
import { isPhaseActive, toolCallStateToToolMessage } from '../../bridge/streamHandler';
import { ChatHistoryPage } from './ChatHistoryPage';

/**
 * Phantom tool names — DEPRECATED: visibility is now controlled solely by
 * `defaultShow`. Kept as empty set for backward compatibility.
 */
const PHANTOM_TOOL_NAMES = new Set<string>([]);


/* ── Streaming Bubble Component (VS Code pattern: separate memoized component) ── */

/**
 * Extracted streaming message bubble.
 * Inspired by VS Code's ChatMarkdownContentPart + IncrementalDOMMorpher:
 * - Independently memoized so parent list doesn't re-render on each delta
 * - Only re-renders when its specific props (textBuffer, thinkingBuffer, etc.) change
 * - Tool calls are individually memoized via ToolCallCard's own memo wrapper
 */
const StreamingBubble = memo(function StreamingBubble({
	textBuffer,
	thinkingBuffer,
	toolCalls,
	subAgents,
	errorMessage,
	streamError,
	phase,
}: {
	textBuffer: string;
	thinkingBuffer: string;
	toolCalls: Array<{ id: string; name: string; arguments: string; result?: string; status: string; defaultShow?: boolean; displayName?: string; renderType?: string; serverExecuted?: boolean; textPosition?: number }>;
	subAgents: Array<{ id: string; type: 'explore' | 'general' | 'scout'; task: string; parentAgentId?: string; status: string; progress?: string; output?: string; error?: string; groupId?: string }>;
	errorMessage: string | null;
	streamError: StreamError | null;
	phase: StreamPhase;
}): React.ReactElement {
	// Thinking card in streaming bubble: default expanded, but user can collapse it
	const [thinkingCollapsed, setThinkingCollapsed] = useState(false);
	// Memoize sanitized text to avoid re-running sanitizer when buffer hasn't changed
	const sanitizedText = useMemo(
		() => {
			if (!textBuffer) { return ''; }
			return sanitizeStreamingText(textBuffer);
		},
		[textBuffer]
	);

	return (
		<div className="chat-message assistant">
			<div className="message-content message-streaming">

				{/* Thinking card — active with spinner, default expanded during streaming */}
				{thinkingBuffer && (
					<div className="thinking-card active">
						<div
							className="thinking-card-header"
							onClick={() => setThinkingCollapsed(!thinkingCollapsed)}
							role="button"
							aria-expanded={!thinkingCollapsed}
						>
							<span className="thinking-card-icon">
								<svg className="thinking-spinner" width="14" height="14" viewBox="0 0 24 24"
									fill="none" stroke="currentColor" strokeWidth="2">
									<path d="M21 12a9 9 0 11-6.219-8.56" />
								</svg>
							</span>
							<span className="thinking-card-title">
								{phase === 'llm_streaming' ? '思考中...' : '思考过程'}
							</span>
							<span className={`thinking-card-toggle ${thinkingCollapsed ? 'collapsed' : ''}`}>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
									<polyline points="6 9 12 15 18 9" />
								</svg>
							</span>
						</div>
						{!thinkingCollapsed && (
							<div className="thinking-card-body">
								<MarkdownRenderer content={thinkingBuffer} className="thinking-stream markdown-body" />
							</div>
						)}
					</div>
				)}

				{/* Streaming sub-agents */}
				{subAgents && subAgents.length > 0 && (
					<SubAgentCard subAgents={subAgents} isStreaming={true} />
				)}

				{/* Streaming text content + tool calls (interleaved) */}
				{(() => {
					const safeToolCalls = Array.isArray(toolCalls) ? toolCalls : [];
					const visibleToolCalls = safeToolCalls.filter(tc => tc && tc.defaultShow !== false);
					const toolCallNodes = visibleToolCalls.map(tc => (
						<ToolCallCard key={tc.id} toolCall={toolCallStateToToolMessage({
							...tc,
							status: tc.status as 'running' | 'done' | 'error' | 'approval_required',
							result: tc.result ? sanitizeToolResultText(tc.result) : tc.result,
						})} />
					));

					// Case A: there IS streaming text → interleave tool cards inside markdown
					if (sanitizedText) {
						// Build position map from textPosition hints (recorded at tool_start time)
						const toolPositions = new Map<string, number>();
						for (const tc of visibleToolCalls) {
							if (tc.textPosition !== undefined) {
								toolPositions.set(tc.id, tc.textPosition);
							}
						}
						return (
							<div className="message-text">
								{toolCallNodes.length > 0 ? (
									<InterleavedMarkdownRenderer
										content={sanitizedText}
										showCursor
										toolCallNodes={toolCallNodes}
										toolPositions={toolPositions}
									/>
								) : (
									<MarkdownRenderer
										content={sanitizedText}
										showCursor
									/>
								)}
							</div>
						);
					}

					// Case B: NO text yet but tool cards exist (e.g. a tool requiring
					// approval fired before any assistant text streamed). Render the
					// cards standalone so the approval UI is visible — otherwise the
					// user can never approve and the stream stays stuck.
					if (toolCallNodes.length > 0) {
						return <div className="message-text">{toolCallNodes}</div>;
					}

					return null;
				})()}

				{/* Error message */}
				{errorMessage && (
					<div className={`message-text stream-error ${streamError?.level === 'warning' ? 'stream-error-warning' : ''}`}>
						{streamError?.level === 'warning' ? '⚠️' : '❌'} {errorMessage}
					</div>
				)}

				{/* Phase-based typing indicator — only when nothing else is showing */}
				{!textBuffer && !thinkingBuffer && !errorMessage && (!toolCalls || toolCalls.length === 0) && (!subAgents || subAgents.length === 0) && (
					<div className="typing-indicator">
						<span className="typing-dot">●</span>
						<span className="typing-dot">●</span>
						<span className="typing-dot">●</span>
						<span className="typing-phase-label">
							{phase === 'tool_executing' ? '正在执行工具...'
								: phase === 'awaiting_approval' ? '等待您确认...'
								: phase === 'compressing' ? '正在压缩上下文...'
								: '思考中...'}
						</span>
					</div>
				)}

			</div>
			<div className="message-footer">
				<span className="message-time">
					{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
				</span>
			</div>
		</div>
	);
});

/* ── Props ───────────────────────────────────────────────────── */
interface EmployeeChatProps {
	onOpenEditorPane?: (employeeId: string) => void;
}

export function EmployeeChat({ onOpenEditorPane }: EmployeeChatProps): React.ReactElement {
	const { messages, streamState, sendMessage, cancelStream, activeEmployeeId, setActiveEmployee, isLoading, chatMode } = useChatStore();
	const { employees, selectedEmployeeId, selectEmployee } = useEmployeeStore();
	const { selection, loadSelectionForEmployee } = useProviderStore();
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const chatMessagesRef = useRef<HTMLDivElement>(null);
	/** Track whether we just loaded history (vs. a new message arriving).
	 *  When history loads we want instant scroll; for new messages we use smooth. */
	const wasLoadingRef = useRef(false);
	/** Whether auto-scroll should follow new content (user is at the bottom). */
	const isAtBottomRef = useRef(true);
	/** Whether scroll-to-bottom button should be visible (React state so re-renders don't reset it). */
	const [showScrollBtn, setShowScrollBtn] = useState(false);
	// History page visibility
	const [showHistory, setShowHistory] = useState(false);
	// Track previous employee to detect employee switches (used by useLayoutEffect below)
	const prevEmployeeIdRef = useRef<string | null>(activeEmployeeId);
	// Pending plan info: when /plan is sent, we store goal/planId here until the plan
	// status changes from pending_approval to approved/executing/rejected.
	// The dialog lives in the Task Board panel; chat only shows the result.
	const pendingPlanGoalRef = useRef<string | null>(null);
	const pendingPlanIdRef = useRef<string | null>(null);
	const prevPlanStatusRef = useRef<Record<string, string>>({});

	/**
	 * Update scroll-down button visibility.
	 * Uses React state instead of direct DOM manipulation to survive re-renders.
	 */
	const updateScrollDownButton = useCallback((atBottom: boolean) => {
		setShowScrollBtn(!atBottom);
	}, []);

	// Sync selected employee with chat
	useEffect(() => {
		if (selectedEmployeeId && selectedEmployeeId !== activeEmployeeId) {
			setActiveEmployee(selectedEmployeeId);
		}
	}, [selectedEmployeeId, activeEmployeeId, setActiveEmployee]);

	// When activeEmployeeId changes, load the provider/model selection from agent.yaml
	useEffect(() => {
		if (activeEmployeeId) {
			loadSelectionForEmployee(activeEmployeeId);
		}
	}, [activeEmployeeId, loadSelectionForEmployee]);

	// Track loading state for scroll behavior
	useEffect(() => {
		if (isLoading) {
			wasLoadingRef.current = true;
		}
	}, [isLoading]);

	// Auto-scroll to bottom: instant after history load, smooth for new messages/streaming.
	// Only auto-scroll if user is already at (or near) the bottom.
	useLayoutEffect(() => {
		const el = chatMessagesRef.current;
		if (!el) { return; }

		// Detect employee switch: force scroll to bottom on all subsequent renders
		// until new messages are loaded (wasLoadingRef ensures instant scroll when they arrive).
		const isEmployeeSwitch = prevEmployeeIdRef.current !== activeEmployeeId;
		if (isEmployeeSwitch) {
			prevEmployeeIdRef.current = activeEmployeeId;
			wasLoadingRef.current = true; // ensures instant scroll when messages load
		}

		const THRESHOLD = 80;
		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		const atBottom = distFromBottom < THRESHOLD;

		// When loading (employee switch or history load), always scroll to bottom
		// regardless of current scroll position. Otherwise only scroll if already near bottom.
		if (wasLoadingRef.current) {
			isAtBottomRef.current = true;
			setShowScrollBtn(false);
			wasLoadingRef.current = false;
			messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
			return;
		}

		isAtBottomRef.current = atBottom;
		updateScrollDownButton(atBottom);
		if (!atBottom) { return; }
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, streamState.textBuffer, streamState.thinkingBuffer, streamState.toolCalls, updateScrollDownButton, activeEmployeeId]);

	// Listen to scroll events on the message list — mirrors VS Code's onDidScroll handler.
	// This is the sole authority for button visibility (just like VS Code).
	// IMPORTANT: activeEmployeeId in deps so listener re-binds when employee changes
	// (on first mount the ref may be null if no employee is selected yet).
	useEffect(() => {
		const el = chatMessagesRef.current;
		if (!el) { return; }
		const THRESHOLD = 80; // px from bottom to consider "at bottom"
		const handleScroll = () => {
			const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			const atBottom = distFromBottom < THRESHOLD;
			isAtBottomRef.current = atBottom;
			updateScrollDownButton(atBottom);
		};
		// Initialise once so the button shows if content already overflows.
		handleScroll();
		el.addEventListener('scroll', handleScroll, { passive: true });
		return () => { el.removeEventListener('scroll', handleScroll); };
	}, [updateScrollDownButton, activeEmployeeId]);

	// Scroll to bottom handler — mirrors VS Code's scrollDownButton.onDidClick
	const handleScrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
		// Immediately mark as at-bottom and hide button
		isAtBottomRef.current = true;
		setShowScrollBtn(false);
	}, []);

	const activeEmployee = employees.find(e => e.id === activeEmployeeId);

	// Rename state for chat header
	const [isEditingChatName, setIsEditingChatName] = useState(false);
	const [editChatName, setEditChatName] = useState('');
	const chatNameInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isEditingChatName && chatNameInputRef.current) {
			chatNameInputRef.current.focus();
			chatNameInputRef.current.select();
		}
	}, [isEditingChatName]);

	// Listen for AI decomposition progress events and display in chat
	useEffect(() => {
		const handleDecompositionProgress = (e: Event) => {
			const detail = (e as CustomEvent).detail as {
				plannerId?: string;
				plannerName?: string;
				stage: string;
				message: string;
				taskTitle?: string;
				goal?: string;
				subTaskCount?: number;
			};
			if (!detail) { return; }

			// Only show progress for the currently active planner/employee
			// or if no specific planner is targeted
			if (detail.plannerId && activeEmployeeId && detail.plannerId !== activeEmployeeId) {
				return;
			}

			const progressMessage: ChatMessage = {
				id: `decomp_${detail.stage}_${Date.now()}`,
				role: 'system',
				content: detail.message,
				metadata: {
					type: 'decomposition_progress',
					stage: detail.stage,
					plannerName: detail.plannerName,
					taskTitle: detail.taskTitle,
					goal: detail.goal,
					subTaskCount: detail.subTaskCount,
				},
				timestamp: new Date().toISOString(),
			};
			useChatStore.setState(state => ({
				messages: [...state.messages, progressMessage]
			}));
			// Also persist so it survives chat-tab switches
			const targetEmployeeId = detail.plannerId || activeEmployeeId;
			if (targetEmployeeId) {
				useChatStore.getState().addDecompositionProgress(targetEmployeeId, progressMessage);
				// Clear progress history when decomposition finishes so old
				// progress messages don't pile up across multiple /plan calls.
				if (detail.stage === 'complete' || detail.stage === 'error' || detail.stage === 'fallback') {
					useChatStore.setState(state => ({
						decompositionProgress: {
							...state.decompositionProgress,
							[targetEmployeeId]: [progressMessage],
						},
					}));
				}
			}
		};

		window.addEventListener('agentStudio:decomposition-progress', handleDecompositionProgress);
		return () => window.removeEventListener('agentStudio:decomposition-progress', handleDecompositionProgress);
	}, [activeEmployeeId]);

	// Watch for plan status changes: when a /plan command's plan moves from
	// pending_approval to approved/executing/rejected, add the result messages to chat.
	// The orchestration dialog lives in the Task Board panel, not in chat.
	const { plans: orchestrationPlans } = useOrchestrationStore();

	useEffect(() => {
		if (!pendingPlanIdRef.current || !pendingPlanGoalRef.current) { return; }

		const planId = pendingPlanIdRef.current;
		const goal = pendingPlanGoalRef.current;
		const plan = orchestrationPlans.find(p => p.id === planId);
		if (!plan) { return; }

		const prevStatus = prevPlanStatusRef.current[planId];
		if (prevStatus === plan.status) { return; }
		prevPlanStatusRef.current[planId] = plan.status;

		// Only react when leaving pending_approval
		if (prevStatus !== 'pending_approval') { return; }

		// Clear pending state
		pendingPlanGoalRef.current = null;
		pendingPlanIdRef.current = null;

		if (plan.status === 'approved' || plan.status === 'executing') {
			// Approved — add user message (the backend persists plan/approval messages)
			const userMessage: ChatMessage = {
				id: `user_${Date.now()}`,
				role: 'user',
				content: `/plan ${goal}`,
				timestamp: new Date().toISOString(),
			};
			useChatStore.setState(state => ({
				messages: [...state.messages, userMessage]
			}));
		} else if (plan.status === 'rejected') {
			// Rejected — add user message (the backend persists the rejection message)
			const userMessage: ChatMessage = {
				id: `user_${Date.now()}`,
				role: 'user',
				content: `/plan ${goal}`,
				timestamp: new Date().toISOString(),
			};
			useChatStore.setState(state => ({
				messages: [...state.messages, userMessage]
			}));
		}
		// If status changed to something else (e.g. error), don't add messages.
	}, [orchestrationPlans]);

	const handleChatNameDoubleClick = useCallback(() => {
		if (!activeEmployee) { return; }
		setEditChatName(activeEmployee.name);
		setIsEditingChatName(true);
	}, [activeEmployee]);

	const handleChatNameCommit = useCallback(async () => {
		const trimmed = editChatName.trim();
		if (activeEmployee && trimmed && trimmed !== activeEmployee.name) {
			try {
				await useEmployeeStore.getState().updateEmployee(activeEmployee.id, { name: trimmed });
			} catch (err) {
				console.error('[EmployeeChat] rename failed:', err);
				setEditChatName(activeEmployee.name);
			}
		}
		setIsEditingChatName(false);
	}, [activeEmployee, editChatName]);

	const handleChatNameKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleChatNameCommit();
		} else if (e.key === 'Escape') {
			setEditChatName(activeEmployee?.name || '');
			setIsEditingChatName(false);
		}
	}, [handleChatNameCommit, activeEmployee]);

	const handleSend = useCallback((content: string, attachments?: Array<{
		id: string;
		type: 'image' | 'file';
		name: string;
		mimeType: string;
		data: string;
		size: number;
		isPasted?: boolean;
	}>) => {
		if (content.trim() || (attachments && attachments.length > 0)) {
			sendMessage(content, attachments);
		}
	}, [sendMessage]);

	const handleCommand = useCallback(async (commandId: string, args: string) => {
		if (commandId === 'plan') {
			const goal = args || '默认目标';
			const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
			const plannerId = activeEmployeeId;
			if (!workspaceId) {
				console.error('[EmployeeChat] No active workspace for plan command');
				return;
			}
			if (!plannerId) {
				console.error('[EmployeeChat] No active employee for plan command');
				return;
			}

			// Don't add user message yet — wait for plan approval in dialog
			try {
				const plan = await useOrchestrationStore.getState().createPlan(goal, workspaceId, plannerId);

				if (plan) {
					// Store pending plan info; messages will be added after user approves/rejects
					pendingPlanGoalRef.current = goal;
					pendingPlanIdRef.current = plan.id;

					// Add the plan card to chat immediately so the user sees the result
					// (the backend also persists an identical message to chat history)
					const planMessage: ChatMessage = {
						id: `plan_${plan.id}`,
						role: 'system',
						content: `✅ 任务计划已创建，请在下方面板中审批：`,
						metadata: { type: 'orchestration_plan', planId: plan.id },
						timestamp: plan.updatedAt,
					};
					useChatStore.setState(state => ({
						messages: [...state.messages, planMessage]
					}));
				}
			} catch (err) {
				console.error('[EmployeeChat] Failed to create plan:', err);
				// On failure, add error message immediately
				const errorMessage: ChatMessage = {
					id: `error_${Date.now()}`,
					role: 'system',
					content: `❌ 创建任务计划失败: ${err instanceof Error ? err.message : String(err)}`,
					timestamp: new Date().toISOString(),
				};
				useChatStore.setState(state => ({
					messages: [...state.messages, errorMessage]
				}));
			}
		}
	}, [activeEmployeeId]);

	// Compute superior and subordinates from connections + subagentOf
	const { superior, subordinates } = useMemo(() => {
		if (!activeEmployee) { return { superior: undefined as Employee | undefined, subordinates: [] as Employee[] }; }
		const conns = activeEmployee.connections || [];
		// Superior: connection where current agent is the target (subagent)
		let superiorId = activeEmployee.subagentOf || undefined;
		if (!superiorId) {
			const supConn = conns.find(c => c.type === 'subagent' && c.targetId === activeEmployee.id);
			if (supConn) { superiorId = supConn.sourceId; }
		}
		const superior = superiorId ? employees.find(e => e.id === superiorId) : undefined;
		// Subordinates: connections where current agent is the source
		const subIds = new Set<string>();
		conns.filter(c => c.type === 'subagent' && c.sourceId === activeEmployee.id).forEach(c => subIds.add(c.targetId));
		// Also include agents whose subagentOf points to current agent
		employees.forEach(e => { if (e.subagentOf === activeEmployee.id) { subIds.add(e.id); } });
		const subordinates = Array.from(subIds).map(id => employees.find(e => e.id === id)).filter(Boolean) as Employee[];
		return { superior, subordinates };
	}, [activeEmployee, employees]);

	const taskCount = messages.filter(m => m.role === 'assistant').length;

	// Click handler to switch to another agent's chat
	const handleSwitchAgent = useCallback((employeeId: string) => {
		if (employeeId === activeEmployeeId) { return; }
		selectEmployee(employeeId, true);
		setActiveEmployee(employeeId);
	}, [activeEmployeeId, selectEmployee, setActiveEmployee]);

	// Empty state - no employee selected
	if (!activeEmployee || !selectedEmployeeId) {
		return (
			<div className="chat-empty">
				<div className="chat-empty-inner">
					<div className="chat-empty-icon">💬</div>
					<h2 className="chat-empty-title">Agent Studio</h2>
					<p className="chat-empty-desc">选择一个 Agent 开始对话</p>
				</div>
			</div>
		);
	}

	const statusText = activeEmployee.status === 'idle' ? '空闲'
		: activeEmployee.status === 'working' ? '工作中'
			: activeEmployee.status === 'thinking' ? '思考中'
				: activeEmployee.status === 'error' ? '错误'
					: activeEmployee.status === 'offline' ? '离线'
						: activeEmployee.status;

	const statusClass = activeEmployee.status === 'idle' ? 'status-idle'
		: activeEmployee.status === 'working' ? 'status-working'
			: activeEmployee.status === 'thinking' ? 'status-thinking'
				: activeEmployee.status === 'error' ? 'status-error'
					: 'status-offline';

	// NOTE: ConfigMD is no longer shown in the chat panel. It now lives only
	// inside the AgentEditorPane (settings dialog) under the "ConfigMD" tab,
	// reachable via the ⚙ Settings button in the chat header.

	return (
		<>
			<div className="employee-chat-root">
			<div className="employee-chat">
				{/* Chat Header */}
				<div className="chat-header">


					<img
						src={activeEmployee.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${activeEmployee.id}`}
						alt={activeEmployee.name}
						className="chat-header-avatar"
					/>
					<div className="chat-header-info">
						{isEditingChatName ? (
							<input
								ref={chatNameInputRef}
								className="chat-header-name-input"
								value={editChatName}
								onChange={(e) => setEditChatName(e.target.value)}
								onBlur={handleChatNameCommit}
								onKeyDown={handleChatNameKeyDown}
								maxLength={50}
							/>
						) : (
							<span className="chat-header-name" onDoubleClick={handleChatNameDoubleClick} title="双击重命名">{activeEmployee.name}</span>
						)}
						<span className="chat-header-role">
							{activeEmployee.role}
							<span className={`chat-header-status ${statusClass}`}>{statusText}</span>
						</span>
					</div>
					<div className="chat-header-actions">
						<WorktreeSwitcher />
						<button className="chat-header-btn" title="创建会话" onClick={() => { useChatStore.getState().clearMessages(); }}>
							<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16M4 12h16" />
							</svg>
						</button>
						<button className="chat-header-btn" title="聊天历史" onClick={() => setShowHistory(true)}>
							<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<circle cx="12" cy="12" r="10" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
								<polyline points="12 6 12 12 16 14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
							</svg>
						</button>
						<button className="chat-header-btn" title="设置" onClick={() => onOpenEditorPane?.(activeEmployee?.id || '')}>
							<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
							</svg>
						</button>
					</div>
				</div>

				{/* Session Info Bar */}
				<div className="chat-session-info">
					{/* Mode badge */}
					<span className={`chat-mode-badge mode-${chatMode}`}>
						{chatMode === 'craft' && '⚡ Craft'}
						{chatMode === 'ask' && '💡 Ask'}
						{chatMode === 'plan' && '📋 Plan'}
						{chatMode === 'workflow' && '✓ Workflow'}
					</span>
					<span className="session-info-sep">|</span>
					{superior && (
						<span className="session-info-hierarchy">
							<span className="hierarchy-label">上级</span>
							<span className="hierarchy-agent" onClick={() => handleSwitchAgent(superior.id)} title={`切换到 ${superior.name}`}>
								{superior.name}
							</span>
						</span>
					)}
					{superior && subordinates.length > 0 && <span className="session-info-sep">|</span>}
					{subordinates.length > 0 && (
						<span className="session-info-hierarchy">
							<span className="hierarchy-label">下级</span>
							{subordinates.map((sub, i) => (
								<React.Fragment key={sub.id}>
									<span className="hierarchy-agent" onClick={() => handleSwitchAgent(sub.id)} title={`切换到 ${sub.name}`}>
										{sub.name}
									</span>
									{i < subordinates.length - 1 && <span className="hierarchy-comma">,</span>}
								</React.Fragment>
							))}
						</span>
					)}
					{(superior || subordinates.length > 0) && <span className="session-info-sep">|</span>}
					<span>任务: {taskCount}</span>
				</div>

				{/* Message List Container: wraps the scrollable list + scroll-down button */}
				<div className="chat-messages-container">
					<div className="chat-messages" ref={chatMessagesRef}>
						{messages.map((msg) => (
							<ChatMessageComponent key={msg.id} message={msg} />
						))}

						{/* ── Streaming indicator (VS Code-inspired: memoized component) ────── */}
						{isPhaseActive(streamState.phase) && streamState.employeeId === activeEmployeeId && (
							<StreamingBubble
								textBuffer={streamState.textBuffer}
								thinkingBuffer={streamState.thinkingBuffer}
								toolCalls={streamState.toolCalls}
								subAgents={streamState.subAgents}
								errorMessage={streamState.errorMessage}
								streamError={streamState.error}
								phase={streamState.phase}
							/>
						)}

						<div ref={messagesEndRef} />
					</div>

					{/* Scroll-to-bottom button: always in DOM, visibility via React state */}
					<button
						className="chat-scroll-bottom-btn"
						onClick={handleScrollToBottom}
						title="滚动到底部"
						style={{ display: showScrollBtn ? 'flex' : 'none' }}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</button>
				</div>

				{/* Checkpoint info bar (non-persistent — only when a checkpoint exists) */}
				<CheckpointBar />

				{/* Composer */}
			<ChatComposer
				onSend={handleSend}
				onCancel={cancelStream}
				isLoading={isPhaseActive(streamState.phase)}
				onCommand={handleCommand}
			/>
		</div>
		{showHistory && <ChatHistoryPage onClose={() => setShowHistory(false)} />}
	</div>
	</>
	);
}
