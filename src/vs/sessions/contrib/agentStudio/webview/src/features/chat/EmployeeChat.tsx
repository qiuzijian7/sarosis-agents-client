
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
import { ToolCallCard } from './ToolCallCard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { AgentSessionSwitcher } from './AgentSessionSwitcher';
import { sanitizeStreamingText, sanitizeToolResultText } from '../../utils/assistantVisibleText';
import type { StreamError } from '../../bridge/streamHandler';


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
	errorMessage,
	streamError,
}: {
	textBuffer: string;
	thinkingBuffer: string;
	toolCalls: Array<{ id: string; name: string; arguments: string; result?: string; status: string; defaultShow?: boolean; displayName?: string; renderType?: string }>;
	errorMessage: string | null;
	streamError: StreamError | null;
}): React.ReactElement {
	// Memoize sanitized text to avoid re-running sanitizer when buffer hasn't changed
	const sanitizedText = useMemo(
		() => {
			if (!textBuffer) { return ''; }
			const result = sanitizeStreamingText(textBuffer);
			// DEBUG: Log streaming content for consistency diagnosis
			console.log('[StreamingBubble] sanitizedText update:', {
				rawLen: textBuffer.length,
				sanitizedLen: result.length,
				// Show first few lines to check normalization
				first200: result.substring(0, 200),
				// Show if ## headings have space
				headingsRaw: (textBuffer.match(/^#{1,6}\S.*/gm) || []).slice(0, 3),
				headingsSanitized: (result.match(/^#{1,6}\S.*/gm) || []).slice(0, 3),
			});
			return result;
		},
		[textBuffer]
	);

	return (
		<div className="chat-message assistant">
			<div className="message-content message-streaming">

				{/* Thinking card — active with spinner */}
				{thinkingBuffer && (
					<div className="thinking-card active">
						<div className="thinking-card-header">
							<span className="thinking-card-icon">
								<svg className="thinking-spinner" width="14" height="14" viewBox="0 0 24 24"
									fill="none" stroke="currentColor" strokeWidth="2">
									<path d="M21 12a9 9 0 11-6.219-8.56" />
								</svg>
							</span>
							<span className="thinking-card-title">思考中...</span>
						</div>
						<div className="thinking-card-body">
							<MarkdownRenderer content={thinkingBuffer} className="thinking-stream markdown-body" />
						</div>
					</div>
				)}

				{/* Streaming tool calls */}
				{toolCalls.length > 0 && (
					<div className="tool-calls-section">
						{toolCalls.map((tc) => (
							<ToolCallCard key={tc.id} toolCall={{
								...tc,
								result: tc.result ? sanitizeToolResultText(tc.result) : tc.result,
							}} />
						))}
					</div>
				)}

				{/* Streaming text content — live markdown rendering */}
				{sanitizedText && (
					<div className="message-text">
						<MarkdownRenderer
							content={sanitizedText}
							showCursor
						/>
					</div>
				)}

				{/* Error message */}
				{errorMessage && (
					<div className={`message-text stream-error ${streamError?.level === 'warning' ? 'stream-error-warning' : ''}`}>
						{streamError?.level === 'warning' ? '⚠️' : '❌'} {errorMessage}
					</div>
				)}

				{/* Typing dots — only when nothing else is showing */}
				{!textBuffer && !thinkingBuffer && !errorMessage && toolCalls.length === 0 && (
					<div className="typing-indicator">
						<span className="typing-dot">●</span>
						<span className="typing-dot">●</span>
						<span className="typing-dot">●</span>
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
	const { messages, streamState, sendMessage, cancelStream, activeEmployeeId, setActiveEmployee, isLoading } = useChatStore();
	const { employees, selectedEmployeeId } = useEmployeeStore();
	const { selection, loadSelectionForEmployee } = useProviderStore();
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const chatMessagesRef = useRef<HTMLDivElement>(null);
	/** Track whether we just loaded history (vs. a new message arriving).
	 *  When history loads we want instant scroll; for new messages we use smooth. */
	const wasLoadingRef = useRef(false);
	/** Show "scroll to bottom" button when user has scrolled up. */
	const [showScrollBottom, setShowScrollBottom] = useState(false);
	/** Whether auto-scroll should follow new content (user is at the bottom). */
	const isAtBottomRef = useRef(true);

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
		const THRESHOLD = 80;
		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		const atBottom = distFromBottom < THRESHOLD;
		isAtBottomRef.current = atBottom;
		setShowScrollBottom(!atBottom);
		if (!atBottom) { return; }
		const behavior = wasLoadingRef.current ? 'instant' : 'smooth';
		wasLoadingRef.current = false;
		messagesEndRef.current?.scrollIntoView({ behavior });
	}, [messages, streamState.textBuffer, streamState.thinkingBuffer, streamState.toolCalls]);

	// Listen to scroll events on the message list to detect "at bottom" vs "scrolled up"
	useEffect(() => {
		const el = chatMessagesRef.current;
		if (!el) { return; }
		const THRESHOLD = 80; // px from bottom to consider "at bottom"
		const handleScroll = () => {
			const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			const atBottom = distFromBottom < THRESHOLD;
			isAtBottomRef.current = atBottom;
			setShowScrollBottom(!atBottom);
		};
		// Initialise once on mount so the button shows if content already overflows.
		handleScroll();
		el.addEventListener('scroll', handleScroll, { passive: true });
		return () => { el.removeEventListener('scroll', handleScroll); };
	}, []);

	// Scroll to bottom handler
	const handleScrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
		// Defer flag update to next frame so the scroll event handler
		// (fired synchronously by scrollIntoView) doesn't overwrite us.
		requestAnimationFrame(() => {
			isAtBottomRef.current = true;
			setShowScrollBottom(false);
		});
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

	const handleSend = useCallback((content: string) => {
		if (content.trim()) {
			sendMessage(content);
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
			
			// Add user message to chat
			const userMessage: ChatMessage = {
				id: `user_${Date.now()}`,
				role: 'user',
				content: `/plan ${goal}`,
				timestamp: new Date().toISOString(),
			};
			useChatStore.setState(state => ({
				messages: [...state.messages, userMessage]
			}));
			
			try {
				const plan = await useOrchestrationStore.getState().createPlan(goal, workspaceId, plannerId);
				
				// Add orchestration plan message for inline approval
				if (plan) {
					const planMessage: ChatMessage = {
						id: `plan_${Date.now()}`,
						role: 'system',
						content: `✅ 任务计划已创建，请在下方面板中审批：`,
						metadata: { type: 'orchestration_plan', planId: plan.id },
						timestamp: new Date().toISOString(),
					};
					useChatStore.setState(state => ({
						messages: [...state.messages, planMessage]
					}));
				}
			} catch (err) {
				console.error('[EmployeeChat] Failed to create plan:', err);
				// Add error message
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

	// Count team members and tasks
	const teamMembers = activeEmployeeId
		? employees.filter(e => e.teamId === activeEmployee?.teamId || e.id === activeEmployeeId).length
		: 0;
	const taskCount = messages.filter(m => m.role === 'assistant').length;

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
					{/* Provider icon */}
					<div className="chat-header-provider" title={selection?.providerName || activeEmployee.provider ? `Provider: ${selection?.providerName || activeEmployee.provider}` : undefined}>
						<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
						</svg>
					</div>

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
						<AgentSessionSwitcher />
						<button className="chat-header-btn" title="设置" onClick={() => onOpenEditorPane?.(activeEmployee?.id || '')}>
							<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
							</svg>
						</button>
						{/* 兼容 agentType 字段缺失的情况 */}
						{(activeEmployee?.agentType === 'planner' || activeEmployee?.presetId === 'planner' || activeEmployee?.role?.toLowerCase().includes('planner') || activeEmployee?.name?.toLowerCase() === 'planner') && (
							<button className="chat-header-btn" title="任务编排" onClick={() => useOrchestrationStore.getState().openPlanDialog()}>
								🎯
							</button>
						)}
					</div>
				</div>

				{/* Session Info Bar */}
				<div className="chat-session-info">
					<span>PM: {activeEmployee.name}</span>
					<span className="session-info-sep">|</span>
					<span>成员: {teamMembers}</span>
					<span className="session-info-sep">|</span>
					<span>任务: {taskCount}</span>
				</div>

				{/* Message List */}
				<div className="chat-messages" ref={chatMessagesRef}>
					{messages.map((msg) => (
						<ChatMessageComponent key={msg.id} message={msg} />
					))}

					{/* ── Streaming indicator (VS Code-inspired: memoized component) ────── */}
					{/* DEBUG: Always log streaming condition on every render */}
					{(() => {
						console.log('[EmployeeChat] render check:', {
							isStreaming: streamState.isStreaming,
							streamEmployeeId: streamState.employeeId,
							activeEmployeeId,
							textBufferLen: streamState.textBuffer.length,
							willRenderBubble: streamState.isStreaming && streamState.employeeId === activeEmployeeId,
						});
						return null;
					})()}
					{streamState.isStreaming && streamState.employeeId === activeEmployeeId && (
						<StreamingBubble
							textBuffer={streamState.textBuffer}
							thinkingBuffer={streamState.thinkingBuffer}
							toolCalls={streamState.toolCalls}
							errorMessage={streamState.errorMessage}
							streamError={streamState.error}
						/>
					)}

					<div ref={messagesEndRef} />

					{/* Scroll-to-bottom button: floats inside the message list */}
					{showScrollBottom && (
						<button
							className="chat-scroll-bottom-btn"
							onClick={handleScrollToBottom}
							title="滚动到底部"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
								<polyline points="6 9 12 15 18 9" />
							</svg>
						</button>
					)}
				</div>

				{/* Composer */}
			<ChatComposer
				onSend={handleSend}
				onCancel={cancelStream}
				isLoading={streamState.isStreaming}
				onCommand={handleCommand}
			/>
		</div>
	</div>
	</>
	);
}
