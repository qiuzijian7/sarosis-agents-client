
/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Agent Chat Panel
 *
 *  Full-featured chat panel supporting:
 *  - Chat header with provider icon + avatar + name + status
 *  - Session info bar (PM / members / tasks)
 *  - Message list with auto-scroll
 *  - Enhanced streaming indicator with thinking card, tool calls, streaming text
 *  - Full Composer with provider/model pill
 *
 *  Ref: sarosis-webui AgentChat.tsx main chat layout
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChatStore, type ChatMessage, type LiveWorkflowExecution, type LiveWorkflowSubAgent, type LiveWorkflowAskUser, type LiveCollectVariable } from '../../store/useChatStore';
import { useAgentStore, type Agent } from '../../store/useAgentStore';
import { useProviderStore } from '../../store/useProviderStore';
import { sendRequest } from '../../bridge/messageClient';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { ChatMessageComponent } from './ChatMessage';
import { ChatComposer } from './ChatComposer';
import { CheckpointBar } from './CheckpointBar';
import { ToolCallCard } from './ToolCallCard';
import { SubAgentCard } from './SubAgentCard';
import { AskUserCard } from './AskUserCard';
import { ExecutionTimelinePanel } from '../workflowEditor/ExecutionTimelinePanel';
import { MarkdownRenderer, InterleavedMarkdownRenderer } from './MarkdownRenderer';
import { AgentSessionSwitcher } from './AgentSessionSwitcher';
import { sanitizeStreamingText, sanitizeToolResultText } from '../../utils/assistantVisibleText';
import type { StreamError, StreamPhase } from '../../bridge/streamHandler';
import { isPhaseActive, toolCallStateToToolMessage } from '../../bridge/streamHandler';
import { ChatHistoryPage } from './ChatHistoryPage';
import { perfTrace } from '../../utils/perfTrace';

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
	suppressText,
}: {
	textBuffer: string;
	thinkingBuffer: string;
	toolCalls: Array<{ id: string; name: string; arguments: string; result?: string; status: string; defaultShow?: boolean; displayName?: string; renderType?: string; serverExecuted?: boolean; textPosition?: number }>;
	subAgents: Array<{ id: string; type: 'explore' | 'general' | 'scout'; task: string; parentAgentId?: string; status: string; progress?: string; output?: string; error?: string; groupId?: string }>;
	errorMessage: string | null;
	streamError: StreamError | null;
	phase: StreamPhase;
	suppressText?: boolean;
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
					<SubAgentCard subAgents={subAgents as any} isStreaming={true} />
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

					// v30: when a workflow is executing, the delta text content
					// is already rendered inside the SubAgentCard's output block
					// (via LiveWorkflowTraceView). Suppress the StreamingBubble's
					// own textBuffer rendering to avoid showing it twice. We still
					// render toolCallNodes standalone — they aren't duplicated in
					// the workflow trace (the trace uses a different compact
					// SubAgentToolTraceBlock layout).
					const effectiveText = suppressText ? '' : sanitizedText;

					// Case A: there IS streaming text → interleave tool cards inside markdown
					if (effectiveText) {
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
										content={effectiveText}
										showCursor
										toolCallNodes={toolCallNodes}
										toolPositions={toolPositions}
									/>
								) : (
									<MarkdownRenderer
										content={effectiveText}
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

// ─── P4: Live workflow execution trace (transient, in-memory) ────────────

interface LiveWorkflowTraceViewProps {
	execution: LiveWorkflowExecution;
	/** v4: pending AskUser requests for this session (rendered as interactive cards). */
	askUsers: LiveWorkflowAskUser[];
	/** v6: pending variable collection card for this session. */
	collectVariables: LiveCollectVariable[];
}

const LiveWorkflowTraceViewRaw = React.memo(function LiveWorkflowTraceView({ execution, askUsers, collectVariables }: LiveWorkflowTraceViewProps): React.ReactElement | null {
	// Only show subagents that are real workflow nodes (skip synthetic root '__workflow__').
	const subAgents = execution.subAgents.filter(sa => sa.id !== '__workflow__');

	// Filter askUser entries to those that belong to THIS execution (a session
	// could in theory have multiple executions — render only the current one).
	const executionAskUsers = askUsers.filter(a => a.executionId === execution.executionId);
	// v6: filter collect variables to this execution
	const executionCollectVariables = collectVariables.filter(c => c.executionId === execution.executionId);
	const hasContent = subAgents.length > 0 || executionAskUsers.length > 0 || executionCollectVariables.length > 0;

	if (!hasContent) {
		// Show a minimal banner so the user knows a workflow is running.
		return (
			<div className="message assistant" style={{ padding: '8px 12px' }}>
				<div className="workflow-trace-banner">
					<span className="shimmer">▶ {execution.workflowName}</span>
					<span className="workflow-trace-status">运行中…</span>
				</div>
			</div>
		);
	}

	// Map our LiveWorkflowSubAgent → the SubAgentInfo shape SubAgentCard expects.
	const cardSubAgents = subAgents.map(sa => ({
		id: sa.id,
		// v26: forward the node label so the SubAgentRow header can show
		// "在控制台打印一个hello world" / "({{$prev.output}}" / the agent name
		// instead of an empty string. Without this, `{agent.name}` in
		// SubAgentRow was rendering nothing (and the TS2339 was swallowed
		// because SubAgentInfo never declared a `name` field). The label
		// comes from the `subagent_start` trace event's `nodeName` field
		// (workflow node label, with `data.label || node.name || node.id`
		// fallback chain in the host).
		name: sa.name,
		type: 'general' as const,
		task: sa.task || sa.name,
		parentAgentId: undefined,
		status: sa.status === 'cancelled' ? 'cancelled' as const
			: sa.status === 'error' ? 'error' as const
				: sa.status === 'done' ? 'done' as const
					: 'running' as const,
		progress: sa.status === 'running' ? (sa.streamedText ? sa.streamedText.slice(-200) : '执行中...') : undefined,
		// v24: forward the live streamed text so the new SubAgentOutputBlock
		// can render a "tool card"-style collapsible view of the model's
		// response while it's still streaming. `output` is kept as the
		// post-execution fallback (set on subagent_end).
		streamedText: sa.streamedText,
		output: sa.output ?? (sa.streamedText ? sa.streamedText.slice(0, 4000) : ''),
		error: sa.error,
		// P4 v3: pass through thinking + toolTrace so SubAgentCard can render them.
		thinking: sa.streamedThinking,
		toolTrace: sa.toolCalls,
	}));

	const isRunning = execution.status === 'running';

	// v25: chronological render order. The pre-execution variable collection
	// cards MUST come BEFORE the SubAgentCard so the chat panel reflects
	// the actual lifecycle of a workflow run:
	//   1. ▶ user clicks Run → variable collection card appears (user fills
	//      `{{userVar}}` values)
	//   2. user submits → parallel sub-agent cards start populating
	//   3. mid-execution AskUser cards may appear (interactive)
	//
	// The previous order (SubAgentCard → variables → AskUser) put the
	// variable card AFTER the parallel execution cards, which is the
	// opposite of the real timeline and made it look like the user was
	// being asked to fill variables AFTER everything had already
	// finished. This is purely a JSX re-order; the data flow is
	// unchanged (host fires `collect_variables` first, then
	// `subagent_start`).
	//
	// AskUser stays at the END because those cards are interactive and
	// the user needs to see them at the bottom of the panel where their
	// attention naturally lands when the workflow pauses. The previous
	// AskUser-at-end comment is preserved below for grep-ability.
	return (
		<div className="message assistant" style={{ padding: '8px 12px' }}>
			<div className="workflow-trace-header" style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				padding: '4px 8px',
				marginBottom: '6px',
				borderRadius: '4px',
				background: 'var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1))',
			}}>
				<span style={{ fontSize: '12px', fontWeight: 600 }}>
					{isRunning ? <span className="shimmer">▶ 工作流执行中</span> : '✓ 工作流已结束'} — {execution.workflowName}
				</span>
				<span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					{subAgents.length} 节点 · {subAgents.filter(sa => sa.status === 'done').length} 完成
					{subAgents.filter(sa => sa.status === 'error').length > 0 && ` · ${subAgents.filter(sa => sa.status === 'error').length} 失败`}
				</span>
			</div>
			{/* v6 + v25: render variable collection cards FIRST (pre-execution
			    input). The host fires `collect_variables` before
			    `subagent_start`, so the chronological order in the chat
			    panel should also be: collect → execute → ask. */}
			{executionCollectVariables.length > 0 && (
				<div className="collect-variables-list">
					{executionCollectVariables.map(cv => (
						<div key={cv.id} className="collect-variables-card" style={{
							margin: '8px 0',
							padding: '10px 12px',
							border: '1px solid var(--vscode-panel-border)',
							borderRadius: '6px',
							backgroundColor: 'var(--vscode-editor-background)',
						}}>
							<div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--vscode-foreground)' }}>
								📝 请填入工作流变量
							</div>
							{cv.status === 'pending' ? (
								<>
									{cv.variables.map(v => (
										<div key={v.name} style={{ marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
											<label style={{
												fontSize: '11px',
												fontFamily: 'monospace',
												color: 'var(--vscode-textLink-foreground)',
												minWidth: '120px',
											}}>
												{'{{' + v.name + '}}'}
											</label>
											<input
												type="text"
												value={cv.values[v.name] ?? ''}
												onChange={e => {
													const sid = useChatStore.getState().activeAgentSessionId;
													if (!sid) { return; }
													useChatStore.getState().updateCollectVariableValue(sid, cv.id, v.name, e.target.value);
												}}
												placeholder={v.defaultValue || '输入值…'}
												style={{
													flex: 1,
													fontSize: '12px',
													padding: '4px 8px',
													border: '1px solid var(--vscode-input-border)',
													borderRadius: '4px',
													backgroundColor: 'var(--vscode-input-background)',
													color: 'var(--vscode-input-foreground)',
													outline: 'none',
												}}
												onFocus={e => {
													e.currentTarget.style.borderColor = 'var(--vscode-focusBorder)';
												}}
												onBlur={e => {
													e.currentTarget.style.borderColor = 'var(--vscode-input-border)';
												}}
											/>
										</div>
									))}
									<div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
										<button
											onClick={() => {
												const sid = useChatStore.getState().activeAgentSessionId;
												if (!sid) { return; }
												void useChatStore.getState().submitCollectVariables(sid, cv.id, cv.values);
											}}
											style={{
												padding: '4px 14px',
												fontSize: '12px',
												fontWeight: 600,
												border: 'none',
												borderRadius: '4px',
												backgroundColor: 'var(--vscode-button-background)',
												color: 'var(--vscode-button-foreground)',
												cursor: 'pointer',
											}}
										>
											提交并执行
										</button>
										<button
											onClick={() => {
												const sid = useChatStore.getState().activeAgentSessionId;
												if (!sid) { return; }
												useChatStore.getState().cancelCollectVariables(sid, cv.id);
											}}
											style={{
												padding: '4px 14px',
												fontSize: '12px',
												border: '1px solid var(--vscode-panel-border)',
												borderRadius: '4px',
												backgroundColor: 'transparent',
												color: 'var(--vscode-descriptionForeground)',
												cursor: 'pointer',
											}}
										>
											跳过
										</button>
									</div>
								</>
							) : cv.status === 'submitted' ? (
								<div style={{ fontSize: '11px', color: 'var(--vscode-charts-green, #34d399)' }}>
									✅ 变量已提交
								</div>
							) : (
								<div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
									⊘ 变量已跳过
								</div>
							)}
						</div>
					))}
				</div>
			)}
			{subAgents.length > 0 && <SubAgentCard subAgents={cardSubAgents as any} isStreaming={isRunning} />}
			{/* v4: render pending / answered AskUser cards at the END (after subagents
			    and after pre-execution variable collection). This matches the
			    expected workflow lifecycle: collect variables → execute subagents →
			    ask user → finish. Interactive AskUser cards sit at the bottom where
			    the user's attention naturally lands when execution pauses. */}
			{executionAskUsers.length > 0 && (
				<div className="askuser-list">
					{executionAskUsers.map(ask => {
						// Look up the active sessionId at click time (it can change while
						// the AskUser is still pending if the user switches sessions).
						return (
							<AskUserCard
								key={ask.id}
								askUser={ask}
								onSubmit={(selection) => {
									const sid = useChatStore.getState().activeAgentSessionId;
									if (!sid) { return; }
									void useChatStore.getState().submitAskUser(sid, ask.id, selection);
								}}
								onSelectionChange={(idx) => {
									const sid = useChatStore.getState().activeAgentSessionId;
									if (!sid) { return; }
									useChatStore.getState().updateAskUserSelection(sid, ask.id, idx);
								}}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
});

const LiveWorkflowTraceView = LiveWorkflowTraceViewRaw;

export function AgentChat(): React.ReactElement {
	const { messages, streamState, sendMessage, cancelStream, activeAgentId, setActiveAgent, isLoading, chatMode, activeAgentSessionId, liveWorkflowExecutions, liveAskUsers, liveCollectVariables, liveWorkflowEvents, cancelCurrentWorkflow } = useChatStore();
	// v22: derive "any workflow is currently executing" from the live map.
	// Used by the ChatComposer to switch its send button into a stop button.
	// Recomputed on every render (cheap; liveWorkflowExecutions is a flat object).
	const hasRunningWorkflow = useMemo(() => {
		return Object.values(liveWorkflowExecutions).some(e => e.status === 'running');
	}, [liveWorkflowExecutions]);
	const { agents, selectedAgentId, selectAgent } = useAgentStore();
	const { selection, loadSelectionForAgent } = useProviderStore();
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
	// ── User message list dropdown (会话消息列表) ──────────────────
	const [showMessageNav, setShowMessageNav] = useState(false);
	const messageNavRef = useRef<HTMLDivElement>(null);
	const messageNavTriggerRef = useRef<HTMLButtonElement>(null);
	// ── Worktree dropdown (切换 agent 处理的目录) ───────────────────
	const [worktrees, setWorktrees] = useState<Array<{ path: string; branch: string; repoRoot?: string; repoName?: string }>>([]);
	const [showWorktreeMenu, setShowWorktreeMenu] = useState(false);
	const [currentWorktreePath, setCurrentWorktreePath] = useState<string | null>(null);
	const worktreeMenuRef = useRef<HTMLDivElement>(null);
	const worktreeMenuTriggerRef = useRef<HTMLButtonElement>(null);
	// Track previous agent to detect agent switches (used by useLayoutEffect below)
	const prevAgentIdRef = useRef<string | null>(activeAgentId);
	// Agent selector dropdown
	const [dropdownOpen, setDropdownOpen] = useState(false);
	const [dropdownFilter, setDropdownFilter] = useState('');
	const dropdownRef = useRef<HTMLDivElement>(null);
	const dropdownTriggerRef = useRef<HTMLDivElement>(null);
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

	// Sync selected agent with chat
	useEffect(() => {
		if (selectedAgentId && selectedAgentId !== activeAgentId) {
			setActiveAgent(selectedAgentId);
		}
	}, [selectedAgentId, activeAgentId, setActiveAgent]);

	// When activeAgentId changes, load the provider/model selection from agent.yaml
	useEffect(() => {
		if (activeAgentId) {
			loadSelectionForAgent(activeAgentId);
		}
	}, [activeAgentId, loadSelectionForAgent]);

	// Track loading state for scroll behavior
	useEffect(() => {
		if (isLoading) {
			wasLoadingRef.current = true;
		}
	}, [isLoading]);

	// Auto-scroll to bottom: instant after history load, smooth for new messages/streaming.
	// Only auto-scroll if user hasn't manually scrolled away (isAtBottomRef tracks this).
	useLayoutEffect(() => {
		const el = chatMessagesRef.current;
		if (!el) { return; }

		// Detect agent switch: force scroll to bottom on all subsequent renders
		// until new messages are loaded (wasLoadingRef ensures instant scroll when they arrive).
		const isAgentSwitch = prevAgentIdRef.current !== activeAgentId;
		if (isAgentSwitch) {
			prevAgentIdRef.current = activeAgentId;
			wasLoadingRef.current = true; // ensures instant scroll when messages load
		}

		// When loading (agent switch or history load), always scroll to bottom
		// regardless of current scroll position.
		if (wasLoadingRef.current) {
			isAtBottomRef.current = true;
			setShowScrollBtn(false);
			wasLoadingRef.current = false;
			messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
			return;
		}

		// Only auto-scroll if user is at (or near) the bottom.
		// isAtBottomRef is the canonical source — managed by scroll/wheel/touch handlers.
		if (!isAtBottomRef.current) { return; }

		// Verify the DOM confirms we're at bottom (belt-and-suspenders)
		const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distFromBottom >= 80) {
			isAtBottomRef.current = false;
			updateScrollDownButton(false);
			return;
		}

		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, streamState.textBuffer, streamState.thinkingBuffer, streamState.toolCalls, updateScrollDownButton, activeAgentId]);

	// ── 智能自动滚动：监听 scroll + wheel 事件 ─────────────────────
	// 规则：
	//   1. 用户滚轮向上滚动 → 立即解除自动滚动，显示"回到底部"按钮
	//   2. 用户手动滚动到底部 → 恢复自动滚动
	//   3. 点击"回到底部"按钮 → 恢复自动滚动并滚动到底部
	//   4. LLM 输出时：仅在已到底部的情况下自动滚动
	useEffect(() => {
		const el = chatMessagesRef.current;
		if (!el) { return; }
		const THRESHOLD = 80; // px from bottom to consider "at bottom"

		const checkAtBottom = () => {
			const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			return distFromBottom < THRESHOLD;
		};

		const handleScroll = () => {
			const atBottom = checkAtBottom();
			if (atBottom) {
				// 用户滚到了底部 → 恢复自动滚动
				isAtBottomRef.current = true;
			}
			updateScrollDownButton(atBottom);
		};

		const handleWheel = (e: WheelEvent) => {
			// 只关心垂直滚动方向
			if (Math.abs(e.deltaY) < 1) { return; }
			if (e.deltaY < 0) {
				// 向上滚动 → 用户主动查看历史，立即解除自动滚动
				isAtBottomRef.current = false;
				updateScrollDownButton(false);
				// 取消正在进行的 smooth scrollIntoView 动画
				el.scrollTop = el.scrollTop;
			} else if (e.deltaY > 0) {
				// 向下滚动 → 检查是否到了底部
				// 使用 requestAnimationFrame 等 scroll 事件更新后再判断
				requestAnimationFrame(() => {
					if (checkAtBottom()) {
						isAtBottomRef.current = true;
						updateScrollDownButton(true);
					}
				});
			}
		};

		// 触摸设备：用户触碰消息区域时解除自动滚动
		const handleTouchStart = () => {
			isAtBottomRef.current = false;
			updateScrollDownButton(false);
		};

		// Initialise
		handleScroll();
		el.addEventListener('scroll', handleScroll, { passive: true });
		el.addEventListener('wheel', handleWheel, { passive: true });
		el.addEventListener('touchstart', handleTouchStart, { passive: true });
		return () => {
			el.removeEventListener('scroll', handleScroll);
			el.removeEventListener('wheel', handleWheel);
			el.removeEventListener('touchstart', handleTouchStart);
		};
	}, [updateScrollDownButton, activeAgentId]);

	// Scroll to bottom handler — re-enables auto-scroll and scrolls to bottom
	const handleScrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
		// Re-enable auto-scroll
		isAtBottomRef.current = true;
		setShowScrollBtn(false);
	}, []);

	// v22: Scroll to top handler — jumps to the first message and pauses
	// auto-scroll. Helpful when a workflow run produces a long trace and
	// the user wants to review the original "Run workflow: ..." trigger
	// message that was pushed off-screen by the auto-scroll-to-bottom
	// behavior.
	const handleScrollToTop = useCallback(() => {
		const el = chatMessagesRef.current;
		if (!el) { return; }
		el.scrollTo({ top: 0, behavior: 'smooth' });
		// Pause auto-scroll so subsequent new content doesn't yank the view
		// back down.
		isAtBottomRef.current = false;
		setShowScrollBtn(true);
	}, []);

	// 会话消息列表：按时间正序排列的用户消息（含首条关键词摘要）
	const userMessages = useMemo(() => {
		return messages
			.filter(m => m.role === 'user' && m.content.trim())
			.map(m => ({
				id: m.id,
				content: m.content,
				summary: m.content.trim().slice(0, 80).replace(/\n/g, ' ') + (m.content.length > 80 ? '…' : ''),
				timestamp: m.timestamp,
			}));
	}, [messages]);

	// 滚动到指定消息
	const handleScrollToMessage = useCallback((msgId: string) => {
		const container = chatMessagesRef.current;
		if (!container) { return; }
		const el = container.querySelector(`[data-message-id="${msgId}"]`) as HTMLElement | null;
		if (!el) { return; }
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		// 不再自动跟随：滚动到历史消息意味着用户正在查看历史
		isAtBottomRef.current = false;
		updateScrollDownButton(false);
		setShowMessageNav(false);
	}, [updateScrollDownButton]);

	const activeAgent = agents.find(a => a.id === activeAgentId);

	// Filtered agents for dropdown search
	const filteredAgents = useMemo(() => {
		const filter = dropdownFilter.toLowerCase().trim();
		if (!filter) { return agents; }
		return agents.filter(a =>
			a.name.toLowerCase().includes(filter) ||
			(a.role && a.role.toLowerCase().includes(filter))
		);
	}, [agents, dropdownFilter]);

	// Close agent dropdown on outside click
	useEffect(() => {
		if (!dropdownOpen) { return; }
		const handleClickOutside = (e: MouseEvent) => {
			if (
				dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
				dropdownTriggerRef.current && !dropdownTriggerRef.current.contains(e.target as Node)
			) {
				setDropdownOpen(false);
				setDropdownFilter('');
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [dropdownOpen]);

	// Close message nav on outside click
	useEffect(() => {
		if (!showMessageNav) { return; }
		const handleClickOutside = (e: MouseEvent) => {
			if (
				messageNavRef.current && !messageNavRef.current.contains(e.target as Node) &&
				messageNavTriggerRef.current && !messageNavTriggerRef.current.contains(e.target as Node)
			) {
				setShowMessageNav(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [showMessageNav]);

	// ── Worktree 列表加载 ─────────────────────────────────────
	useEffect(() => {
		let cancelled = false;
		const loadWorktrees = async () => {
			const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
			if (!workspaceId) {
				setWorktrees([]);
				setCurrentWorktreePath(null);
				return;
			}
			try {
				const list = await sendRequest<{ workspaceId: string }, Array<{ path: string; branch: string; repoRoot?: string; repoName?: string }>>(
					'worktree.list', { workspaceId },
				);
				if (cancelled) { return; }
				const wts = Array.isArray(list) ? list : [];
				setWorktrees(wts);
				// 默认选中当前 workspace 所在 worktree
				const ws = useWorkspaceStore.getState().workspaces.find(w => w.id === workspaceId);
				if (ws?.worktreePath) {
					setCurrentWorktreePath(ws.worktreePath);
				} else if (wts.length > 0) {
					// fallback: main worktree (isMain=true) 或第一条
					const main = wts.find(w => w.path === ws?.worktreePath) || wts[0];
					setCurrentWorktreePath(main.path);
				} else {
					setCurrentWorktreePath(null);
				}
			} catch (err) {
				console.warn('[AgentChat] worktree.list failed:', err);
				if (!cancelled) {
					setWorktrees([]);
					setCurrentWorktreePath(null);
				}
			}
		};
		loadWorktrees();
		return () => { cancelled = true; };
	}, [activeAgentId]);

	// 监听 worktree.changed / agent.worktree.changed 事件刷新
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as { workspaceId?: string; agentId?: string; worktreePath?: string; worktreeBranch?: string };
			if (detail?.workspaceId && detail.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) { return; }
			if (detail?.worktreePath) { setCurrentWorktreePath(detail.worktreePath); }
		};
		window.addEventListener('agentStudio:agent-worktree-changed', handler);
		window.addEventListener('agentStudio:worktree-changed', handler as EventListener);
		return () => {
			window.removeEventListener('agentStudio:agent-worktree-changed', handler);
			window.removeEventListener('agentStudio:worktree-changed', handler as EventListener);
		};
	}, []);

	// Close worktree menu on outside click
	useEffect(() => {
		if (!showWorktreeMenu) { return; }
		const handleClickOutside = (e: MouseEvent) => {
			if (
				worktreeMenuRef.current && !worktreeMenuRef.current.contains(e.target as Node) &&
				worktreeMenuTriggerRef.current && !worktreeMenuTriggerRef.current.contains(e.target as Node)
			) {
				setShowWorktreeMenu(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [showWorktreeMenu]);

	const handleSelectWorktree = useCallback(async (wt: { path: string; branch: string }) => {
		const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
		if (!workspaceId || !activeAgentId) { return; }
		setCurrentWorktreePath(wt.path);
		setShowWorktreeMenu(false);
		try {
			await sendRequest('agent.worktree.switch', {
				workspaceId,
				agentId: activeAgentId,
				worktreePath: wt.path,
				worktreeBranch: wt.branch,
			});
		} catch (err) {
			console.warn('[AgentChat] agent.worktree.switch failed:', err);
		}
	}, [activeAgentId]);

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

			// Only show progress for the currently active planner/agent
			// or if no specific planner is targeted
			if (detail.plannerId && activeAgentId && detail.plannerId !== activeAgentId) {
				return;
			}

			const progressMessage: ChatMessage = {
				id: `decomp_${detail.stage}_${Date.now()}`,
				role: 'system',
				content: detail.message,
				metadata: {
					type: 'decomposition_progress' as any,
					stage: detail.stage,
					plannerName: detail.plannerName,
					taskTitle: detail.taskTitle,
					goal: detail.goal,
					subTaskCount: detail.subTaskCount,
				} as any,
				timestamp: new Date().toISOString(),
			};
			useChatStore.setState(state => ({
				messages: [...state.messages, progressMessage]
			}));
			// Also persist so it survives chat-tab switches
			const targetAgentId = detail.plannerId || activeAgentId;
			if (targetAgentId) {
				useChatStore.getState().addDecompositionProgress(targetAgentId, progressMessage);
				// Clear progress history when decomposition finishes so old
				// progress messages don't pile up across multiple /plan calls.
				if (detail.stage === 'complete' || detail.stage === 'error' || detail.stage === 'fallback') {
					useChatStore.setState(state => ({
						decompositionProgress: {
							...state.decompositionProgress,
							[targetAgentId]: [progressMessage],
						},
					}));
				}
			}
		};

		window.addEventListener('agentStudio:decomposition-progress', handleDecompositionProgress);
		return () => window.removeEventListener('agentStudio:decomposition-progress', handleDecompositionProgress);
	}, [activeAgentId]);

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
			const plannerId = activeAgentId;
			if (!workspaceId) {
				console.error('[AgentChat] No active workspace for plan command');
				return;
			}
			if (!plannerId) {
				console.error('[AgentChat] No active agent for plan command');
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
				console.error('[AgentChat] Failed to create plan:', err);
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
	}, [activeAgentId]);

	// Compute superior and subordinates from connections + subagentOf
	const { superior, subordinates } = useMemo(() => {
		if (!activeAgent) { return { superior: undefined as Agent | undefined, subordinates: [] as Agent[] }; }
		const conns = activeAgent.connections || [];
		// Agents (presets) don't have sub-agent relationships — return empty.
		return { superior: undefined, subordinates: [] };
	}, [activeAgent, agents]);

	const taskCount = messages.filter(m => m.role === 'assistant').length;

	// ─── Hermes-style 回合聚合（2026-06-05 治本根因修复，方案 C）──────────────
	// 后端现在把同一次用户请求的 agentOS 多轮 loop 持久化为**多条** assistant 消息
	// （每个 iteration 一条，共享同一 turnId），以保证磁盘/回灌时的 assistant→tool→
	// assistant 因果链正确。但 UI 上这些应聚合成**一个**气泡，保持外观不变。
	// 这里把相邻、同 turnId 的 assistant 消息合并成一条虚拟消息：
	//   - content：各轮文本按顺序拼接（空文本轮跳过，避免多余空行）
	//   - toolCalls：各轮工具卡按顺序合并，并通过 textPosition 让工具卡插入到
	//     **该轮文本结尾**，从而在一个气泡里呈现 "文本1 → 工具卡1 → 文本2 → 工具卡2"
	//     的正确时序（InterleavedMarkdownRenderer 据 textPosition 定位）。
	// 无 turnId（旧数据 / 直连单条）时原样透传，不受影响。
	const displayMessages = useMemo(() => {
		const out: ChatMessage[] = [];
		let i = 0;
		while (i < messages.length) {
			const m = messages[i];
			// 仅聚合带 turnId 的 assistant；其它消息原样透传
			if (m.role !== 'assistant' || !m.turnId) {
				out.push(m);
				i++;
				continue;
			}
			// 收集相邻同 turnId 的 assistant 连续段
			const group: ChatMessage[] = [];
			let j = i;
			while (
				j < messages.length &&
				messages[j].role === 'assistant' &&
				messages[j].turnId === m.turnId
			) {
				group.push(messages[j]);
				j++;
			}
			if (group.length === 1) {
				// 单条无需合并
				out.push(group[0]);
			} else {
				// 合并多条：拼接文本，工具卡定位到各自轮次文本结尾
				let mergedContent = '';
				const mergedToolCalls: NonNullable<ChatMessage['toolCalls']> = [];
				for (const g of group) {
					const text = (g.content ?? '').trim();
					if (text) {
						if (mergedContent) { mergedContent += '\n\n'; }
						mergedContent += text;
					}
					const tcs = Array.isArray(g.toolCalls) ? g.toolCalls : [];
					const anchor = mergedContent.length; // 该轮文本结尾偏移
					for (const tc of tcs) {
						mergedToolCalls.push({ ...tc, textPosition: anchor });
					}
				}
				// 卡片数据 / token usage 取最后一条（后端已仅挂在最后一条上）
				const last = group[group.length - 1];
				out.push({
					...last,
					content: mergedContent,
					toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : undefined,
				});
			}
			i = j;
		}
		return out;
	}, [messages]);

	// Auto-init: select Sarosis Claw by default on startup
	const autoInitRef = useRef(false);
	useEffect(() => {
		if (autoInitRef.current) { return; }
		if (!agents || agents.length === 0) { return; }
		if (activeAgentId || selectedAgentId) { return; }
		autoInitRef.current = true;

		const claw = agents.find(a => a.id === 'sarosis-claw' || a.name === 'Sarosis Claw');
		if (claw) {
			console.log('[AgentChat] Auto-selecting Sarosis Claw:', claw.id);
			selectAgent(claw.id, true);
		}
	}, [agents, activeAgentId, selectedAgentId, selectAgent]);

	// Click handler to switch to another agent's chat
	const handleSwitchAgent = useCallback((agentId: string) => {
		if (agentId === activeAgentId) { return; }
		selectAgent(agentId, true);
		setActiveAgent(agentId);
	}, [activeAgentId, selectAgent, setActiveAgent]);

	// ── Perf: mark the FIRST successful chat paint ──────────────────────────
	// The terminal node of the first-load timeline. Fires once, when the real
	// chat UI (header + composer) is about to render — i.e. activeAgent and
	// selectedAgentId are both ready (before this we show the empty/loading
	// state). requestAnimationFrame defers to after the browser paints the
	// committed DOM so the measured time reflects what the user actually sees.
	const firstPaintRef = useRef(false);
	useEffect(() => {
		if (firstPaintRef.current) { return; }
		if (activeAgent && selectedAgentId) {
			firstPaintRef.current = true;
			requestAnimationFrame(() => perfTrace.finish('chat-first-paint'));
		}
	}, [activeAgent, selectedAgentId]);

	// Empty state - no agent selected
	if (!activeAgent || !selectedAgentId) {
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

	const statusText = activeAgent.status === 'idle' ? '空闲'
		: activeAgent.status === 'working' ? '工作中'
			: activeAgent.status === 'thinking' ? '思考中'
				: activeAgent.status === 'error' ? '错误'
					: activeAgent.status === 'offline' ? '离线'
						: activeAgent.status;

	const statusClass = activeAgent.status === 'idle' ? 'status-idle'
		: activeAgent.status === 'working' ? 'status-working'
			: activeAgent.status === 'thinking' ? 'status-thinking'
				: activeAgent.status === 'error' ? 'status-error'
					: 'status-offline';

	// NOTE: ConfigMD is no longer shown in the chat panel. It now lives only
	// inside the AgentEditorPane (settings dialog) under the "ConfigMD" tab,
	// reachable via the ⚙ Settings button in the chat header.

	return (
		<>
			<div className="agent-chat-root">
			<div className="agent-chat">
				{/* Chat Header */}
				<div className="chat-header">

					{/* Agent selector trigger (dropdown) */}
					<div
						className={`chat-header-agent-selector ${dropdownOpen ? 'open' : ''}`}
						ref={dropdownTriggerRef}
						onClick={() => { setDropdownOpen(!dropdownOpen); }}
					>
						<svg className="chat-header-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="6 9 12 15 18 9" />
						</svg>
						<img
							src={activeAgent.avatar
								|| (activeAgent.avatarStyle && activeAgent.avatarSeed
									? `https://api.dicebear.com/7.x/${activeAgent.avatarStyle}/svg?seed=${activeAgent.avatarSeed}`
									: `https://api.dicebear.com/7.x/bottts/svg?seed=${activeAgent.id}`)}
							alt={activeAgent.name}
							className="chat-header-avatar"
						/>
						<div className="chat-header-info">
							<span className="chat-header-name">{activeAgent.name}</span>
							<span className="chat-header-role">
								{activeAgent.role}
								<span className={`chat-header-status ${statusClass}`}>{statusText}</span>
							</span>
						</div>
					</div>

					{/* Agent dropdown */}
					{dropdownOpen && (
						<div className="chat-agent-dropdown" ref={dropdownRef}>
							<div className="chat-agent-dropdown-search">
								<svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<circle cx="11" cy="11" r="8" />
									<line x1="21" y1="21" x2="16.65" y2="16.65" />
								</svg>
								<input
									className="chat-agent-dropdown-input"
									type="text"
									placeholder="搜索 Agent..."
									value={dropdownFilter}
									onChange={(e) => setDropdownFilter(e.target.value)}
									onKeyDown={(e) => { if (e.key === 'Escape') { setDropdownOpen(false); setDropdownFilter(''); } }}
									autoFocus
								/>
							</div>
							<div className="chat-agent-dropdown-list">
								{filteredAgents.length === 0 ? (
									<div className="chat-agent-dropdown-no-results">未找到匹配的 Agent</div>
								) : (
									filteredAgents.map(agent => (
										<div
											key={agent.id}
											className={`chat-agent-dropdown-item ${agent.id === activeAgentId ? 'active' : ''}`}
											onClick={() => {
												selectAgent(agent.id, true);
												setActiveAgent(agent.id);
												setDropdownOpen(false);
												setDropdownFilter('');
											}}
										>
											<img
												className="chat-agent-dropdown-avatar"
												src={agent.avatar
													|| (agent.avatarStyle && agent.avatarSeed
														? `https://api.dicebear.com/7.x/${agent.avatarStyle}/svg?seed=${agent.avatarSeed}`
														: `https://api.dicebear.com/7.x/bottts/svg?seed=${agent.id}`)}
												alt={agent.name}
											/>
											<div className="chat-agent-dropdown-info">
												<span className="chat-agent-dropdown-name">{agent.name}</span>
												<span className="chat-agent-dropdown-role">{agent.role || ''}</span>
											</div>
										</div>
									))
									)}
							</div>
						</div>
					)}

					<div className="chat-header-actions">
						{/* Worktree 下拉：切换 agent 处理的目录 */}
						<div className="chat-header-worktree" style={{ position: 'relative' }}>
							<button
								ref={worktreeMenuTriggerRef}
								className={`chat-header-worktree-btn ${showWorktreeMenu ? 'active' : ''}`}
								title={currentWorktreePath ? `当前 Worktree: ${currentWorktreePath}` : '选择 Worktree'}
								onClick={() => setShowWorktreeMenu(!showWorktreeMenu)}
								disabled={worktrees.length === 0}
							>
								<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<circle cx="6" cy="6" r="2" strokeWidth={2} strokeLinecap="round" />
									<circle cx="6" cy="18" r="2" strokeWidth={2} strokeLinecap="round" />
									<circle cx="18" cy="6" r="2" strokeWidth={2} strokeLinecap="round" />
									<path strokeWidth={2} strokeLinecap="round" d="M6 8v8M8 6h4a4 4 0 014 4v0" />
								</svg>
								<span className="chat-header-worktree-branch">
									{(() => {
										const cur = worktrees.find(w => w.path === currentWorktreePath);
										return cur?.branch || (worktrees[0]?.branch ?? 'Worktree');
									})()}
								</span>
								<svg width="10" height="10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<polyline points="6 9 12 15 18 9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
								</svg>
							</button>
							{showWorktreeMenu && worktrees.length > 0 && (
								<div className="chat-worktree-dropdown" ref={worktreeMenuRef}>
									<div className="chat-worktree-dropdown-header">切换 Worktree</div>
									<div className="chat-worktree-dropdown-list">
										{worktrees.map(wt => (
											<div
												key={wt.path}
												className={`chat-worktree-dropdown-item ${wt.path === currentWorktreePath ? 'active' : ''}`}
												onClick={() => handleSelectWorktree(wt)}
												title={wt.path}
											>
												<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
													<circle cx="6" cy="6" r="2" strokeWidth={2} />
													<circle cx="6" cy="18" r="2" strokeWidth={2} />
													<path strokeWidth={2} d="M6 8v8" />
												</svg>
												<div className="chat-worktree-dropdown-info">
													<span className="chat-worktree-dropdown-branch">{wt.branch}</span>
													<span className="chat-worktree-dropdown-path">{wt.path}</span>
												</div>
												{wt.path === currentWorktreePath && (
													<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<polyline points="20 6 9 17 4 12" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
													</svg>
												)}
											</div>
										))}
									</div>
								</div>
							)}
						</div>
						{/* 会话消息列表下拉 */}
						<div className="chat-header-message-nav" style={{ position: 'relative' }}>
							<button
								ref={messageNavTriggerRef}
								className={`chat-header-btn ${showMessageNav ? 'active' : ''}`}
								title="会话消息列表"
								onClick={() => setShowMessageNav(!showMessageNav)}
								disabled={userMessages.length === 0}
							>
								<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h10M4 18h16" />
								</svg>
							</button>
							{showMessageNav && userMessages.length > 0 && (
								<div className="chat-message-nav-dropdown" ref={messageNavRef}>
									<div className="chat-message-nav-header">会话消息</div>
									<div className="chat-message-nav-list">
										{userMessages.map((msg, idx) => (
											<div
												key={msg.id}
												className="chat-message-nav-item"
												onClick={() => handleScrollToMessage(msg.id)}
											>
												<span className="chat-message-nav-index">#{userMessages.length - idx}</span>
												<span className="chat-message-nav-summary">{msg.summary}</span>
											</div>
										))}
									</div>
								</div>
							)}
						</div>
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
						<button className="chat-header-btn" title="设置" onClick={() => {
							if (activeAgent?.id) {
								sendRequest('agents.openSettings', { agentId: activeAgent.id, agentName: activeAgent.name }).catch(err =>
									console.warn('[AgentChat] agents.openSettings failed:', err)
								);
							}
						}}>
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
						{displayMessages.map((msg) => (
							<ChatMessageComponent key={msg.id} message={msg} />
						))}

						{/* ── Streaming indicator (VS Code-inspired: memoized component) ────── */}
						{isPhaseActive(streamState.phase) && streamState.agentId === activeAgentId && (
							<StreamingBubble
								textBuffer={streamState.textBuffer}
								thinkingBuffer={streamState.thinkingBuffer}
								toolCalls={streamState.toolCalls}
								subAgents={streamState.subAgents}
								errorMessage={streamState.errorMessage}
								streamError={streamState.error}
								phase={streamState.phase}
								suppressText={hasRunningWorkflow}
							/>
						)}

						{/* ── P4: live workflow execution trace (owner-agent chat) ──────── */}
						{activeAgentSessionId && liveWorkflowExecutions[activeAgentSessionId] && (
						<LiveWorkflowTraceView
							execution={liveWorkflowExecutions[activeAgentSessionId]}
							askUsers={liveAskUsers[activeAgentSessionId] ?? []}
							collectVariables={liveCollectVariables[activeAgentSessionId] ?? []}
						/>
						)}

						<div ref={messagesEndRef} />
					</div>

					{/* v5b: execution timeline panel (bottom-anchored) */}
					{activeAgentSessionId && (liveWorkflowEvents[activeAgentSessionId]?.length ?? 0) > 0 && (
						<ExecutionTimelinePanel sessionId={activeAgentSessionId} />
					)}

					{/* v22: Scroll-to-top button — appears when there are messages above
					   the visible viewport, so the user can quickly jump back to
					   the first chat message (often a long workflow trigger that
					   was scrolled off-screen by auto-scroll). Positioned to the
					   left of the scroll-to-bottom button. */}
					<button
						className="chat-scroll-top-btn"
						onClick={handleScrollToTop}
						title="滚动到顶部 / 第一个消息"
						style={{
							display: (showScrollBtn && messages.length > 1) ? 'flex' : 'none',
							right: 56, // sit just left of the scroll-to-bottom button
						}}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="18 15 12 9 6 15" />
						</svg>
					</button>

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
				// v22: when a workflow is running, the stop button cancels the
				// workflow (not just the chat stream). The composer's
				// send/stop toggle picks the right action based on its
				// isLoading prop and whether the input has text.
				onCancel={isPhaseActive(streamState.phase) ? cancelStream : cancelCurrentWorkflow}
				isLoading={isPhaseActive(streamState.phase) || hasRunningWorkflow}
				onCommand={handleCommand}
			/>
		</div>
		{showHistory && <ChatHistoryPage onClose={() => setShowHistory(false)} />}
	</div>
	</>
	);
}
