/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Message Component
 *
 *  Full-featured message bubble supporting:
 *  - Markdown rendering with react-markdown + remark-gfm
 *  - Code syntax highlighting with react-syntax-highlighter
 *  - JSON code blocks auto-collapsed (OpenClaw pattern)
 *  - Large code blocks collapsible with toggle
 *  - Collapsible thinking card with Markdown rendering
 *  - Tool call cards (expandable, with formatted JSON input/output)
 *  - Token usage display in footer
 *  - Pure JSON detection for assistant messages
 *
 *  Ref: OpenClaw grouped-render.ts + markdown.ts patterns
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useMemo, useState } from 'react';
import type { ChatMessage } from '../../store/useChatStore';
import { useChatStore } from '../../store/useChatStore';
import { ToolCallCard } from './ToolCallCard';
import { MarkdownRenderer, InterleavedMarkdownRenderer, CodeBlockWithCollapse } from './MarkdownRenderer';
import { sanitizeAssistantContent, isPureToolCallJson } from '../../utils/assistantVisibleText';
import { OrchestrationPlanInline } from '../../features/orchestration/OrchestrationPlanInline';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
// New card components (VS Code chatContentParts pattern)
import { ReferencesCard } from './ReferencesCard';
import { ProgressCard } from './ProgressCard';
import { ConfirmationCard } from './ConfirmationCard';
import { TodoListCard } from './TodoListCard';
import { TipCard } from './TipCard';
import { QuestionCarouselCard } from './QuestionCarouselCard';
import { SubAgentCard } from './SubAgentCard';
import { CheckpointCard } from './CheckpointCard';
import type { CheckpointData } from '../../store/useChatStore';

/**
 * Phantom tool names — DEPRECATED: visibility is now controlled solely by
 * `defaultShow`. Kept as empty set for backward compatibility.
 */
const PHANTOM_TOOL_NAMES = new Set<string>([]);

interface ChatMessageProps {
	message: ChatMessage;
	isStreaming?: boolean;
}



/**
 * Detect if the message content is pure JSON (for display as collapsible block).
 * Returns false for tool-call-shaped JSON (those get ToolCallCards instead).
 */
function detectPureJson(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 2) { return false; }
	if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
		(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
		try {
			JSON.parse(trimmed);
			// Don't show as "JSON data" if it's a tool call
			return !isPureToolCallJson(trimmed);
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Format a JSON string with pretty-printing for display.
 */
function formatJsonForDisplay(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text.trim()), null, 2);
	} catch {
		return text;
	}
}

function ChatMessageRaw({ message, isStreaming = false }: ChatMessageProps): React.ReactElement {
	const isUser = message.role === 'user';
	const isSystemError = message.role === 'system' && message.id.startsWith('error_');
	const isCheckpoint = message.role === 'checkpoint';
	const [thinkingCollapsed, setThinkingCollapsed] = useState(true); // Collapsed by default (OpenClaw pattern)
	const [jsonExpanded, setJsonExpanded] = useState(false);

	// Checkpoint card rendering (Void-inspired time-travel navigation)
	if (isCheckpoint && message.checkpoint) {
		return (
			<CheckpointCard
				checkpoint={message.checkpoint}
				onRestore={(cpId) => {
					useChatStore.getState().jumpToCheckpoint(cpId);
				}}
			/>
		);
	}

	// Subscribe to the orchestration plan that this message renders.
	// ChatMessageRaw is wrapped in React.memo; while the custom comparator
	// returns false for orchestration_plan messages (so it re-renders when
	// the parent list re-renders), the parent list only re-renders when the
	// messages array changes.  By subscribing to the plan status here we
	// force this component to re-render whenever the plan is
	// approved/rejected/updated, bypassing the memo barrier entirely.
	const _orchPlanStatus = message.metadata?.type === 'orchestration_plan'
		? useOrchestrationStore(s => s.plans.find(p => p.id === message.metadata.planId)?.status)
		: undefined;
	void _orchPlanStatus; // subscription side-effect is the only purpose

	const formatTime = (timestamp: string | number) => {
		return new Date(timestamp).toLocaleTimeString('zh-CN', {
			hour: '2-digit',
			minute: '2-digit',
		});
	};

	// Detect if content is pure JSON (memoized)
	const isPureJson = useMemo(() => {
		if (!message.content || isUser || isStreaming) { return false; }
		if (message.toolCalls && message.toolCalls.length > 0) { return false; }
		return detectPureJson(message.content);
	}, [message.content, isUser, isStreaming, message.toolCalls]);

	// Filter visible tool calls once (shared between old top-section and new interleaved layout)
	const visibleToolCalls = useMemo(() => {
		if (!message.toolCalls || message.toolCalls.length === 0) { return []; }
		return message.toolCalls.filter(tc =>
			tc.defaultShow !== false
		);
	}, [message.toolCalls]);

	// Build tool-call card nodes for interleaved rendering
	const toolCallNodes = useMemo(() =>
		visibleToolCalls.map(tc => <ToolCallCard key={tc.id} toolCall={tc} />),
		[visibleToolCalls]
	);

	// Build tool position map for interleaved rendering (from textPosition recorded at tool_start)
	const toolPositions = useMemo(() => {
		const map = new Map<string, number>();
		for (const tc of visibleToolCalls) {
			if ((tc as any).textPosition !== undefined) {
				map.set(tc.id, (tc as any).textPosition);
			}
		}
		return map;
	}, [visibleToolCalls]);

	// Always sanitize assistant content using the unified pipeline.
	// This catches tool-call artifacts that may remain even when no toolCalls
	// were detected (e.g. model outputs raw JSON that was extracted by the
	// backend's _tryExtractToolCallsFromText, but the content_replace delta
	// arrives after the message was already persisted).
	const displayContent = useMemo(() => {
		if (!message.content) { return ''; }
		if (isUser) { return message.content; }
		return sanitizeAssistantContent(message.content);
	}, [message.content, isUser]);

	return (
		<div className={`chat-message ${message.role}`}>
			<div className={`message-content ${isStreaming ? 'message-streaming' : ''}`}>
				{/* ── Thinking card (OpenClaw: collapsed by default, Markdown rendered) ─── */}
				{message.thinking && (
					<div className={`thinking-card ${isStreaming ? 'active' : ''}`}>
						<div
							className="thinking-card-header"
							onClick={() => setThinkingCollapsed(!thinkingCollapsed)}
							role="button"
							aria-expanded={!thinkingCollapsed}
						>
							<span className="thinking-card-icon">
								{isStreaming ? (
									<svg className="thinking-spinner" width="14" height="14" viewBox="0 0 24 24"
										fill="none" stroke="currentColor" strokeWidth="2">
										<path d="M21 12a9 9 0 11-6.219-8.56" />
									</svg>
								) : (
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
										<path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
									</svg>
								)}
							</span>
							<span className="thinking-card-title">
								{isStreaming ? '思考中...' : '思考过程'}
							</span>
							<span className={`thinking-card-toggle ${thinkingCollapsed ? 'collapsed' : ''}`}>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
									<polyline points="6 9 12 15 18 9" />
								</svg>
							</span>
						</div>
						{!thinkingCollapsed && (
							<div className="thinking-card-body">
								{/* Render thinking as markdown too (OpenClaw: formatReasoningMarkdown) */}
								<MarkdownRenderer content={message.thinking} className="thinking-markdown" />
							</div>
						)}
					</div>
				)}

				{/* ── References card (VS Code: chatReferencesContentPart pattern) ─── */}
				{message.references && message.references.length > 0 && (
					<ReferencesCard
						references={message.references}
						defaultExpanded={false}
						onReferenceClick={(ref) => {
							// TODO: Handle reference click - open file/url/etc.
							console.log('[ChatMessage] Reference clicked:', ref);
						}}
					/>
				)}

				{/* ── Progress card (VS Code: chatProgressContentPart pattern) ─── */}
				{message.progress && (
					<ProgressCard
						progress={message.progress}
						showSpinner={isStreaming}
						collapsible={Array.isArray(message.progress) && message.progress.length > 1}
						defaultExpanded={true}
					/>
				)}

				{/* ── Confirmation card (VS Code: chatConfirmationContentPart pattern) ─── */}
				{message.confirmation && (
					<ConfirmationCard
						confirmation={message.confirmation}
						onApprove={(buttonId) => {
							useChatStore.getState().approvePlanConfirmation(message.confirmation!, buttonId);
						}}
						onReject={() => {
							useChatStore.getState().rejectPlanConfirmation(message.confirmation!);
						}}
						collapsed={false}
					/>
				)}

				{/* ── Sub-Agent execution cards (parallel/sequential) ─── */}
				{message.subAgents && message.subAgents.length > 0 && (
					<SubAgentCard subAgents={message.subAgents} isStreaming={isStreaming} />
				)}

				{/* ── Main content (with tool calls interleaved) ─────────── */}
				{displayContent && (
					<div className="message-text">
						{/* Orchestration plan inline (special message type) */}
						{message.metadata?.type === 'orchestration_plan' ? (
							<OrchestrationPlanInline planId={message.metadata.planId} />
						) : message.metadata?.type === 'decomposition_progress' ? (
							// Decomposition progress message with styled indicator
							<div className="decomposition-progress-msg">
								<span className={`decomposition-stage decomposition-stage-${(message.metadata.stage as string) || 'info'}`}>
									{displayContent}
								</span>
							</div>
						) : isStreaming && !isUser ? (
							// During streaming: live markdown rendering (OpenClaw pattern)
							// Tool calls are interleaved into the text when present
							toolCallNodes.length > 0 ? (
								<InterleavedMarkdownRenderer
									content={displayContent}
									showCursor
									toolCallNodes={toolCallNodes}
									toolPositions={toolPositions}
								/>
							) : (
								<MarkdownRenderer content={displayContent} showCursor />
							)
						) : isPureJson ? (
							// Pure JSON content: render as collapsible code block (OpenClaw pattern)
							<div className="json-content-block">
								<div
									className="json-content-header"
									onClick={() => setJsonExpanded(!jsonExpanded)}
									role="button"
									aria-expanded={jsonExpanded}
								>
									<span className="json-content-icon">{'{ }'}</span>
									<span className="json-content-label">JSON 数据</span>
									<span className={`json-content-toggle ${jsonExpanded ? '' : 'collapsed'}`}>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
											<polyline points="6 9 12 15 18 9" />
										</svg>
									</span>
								</div>
								{jsonExpanded && (
									<div className="json-content-body">
										<CodeBlockWithCollapse
											code={formatJsonForDisplay(displayContent)}
											language="json"
											isJson={true}
											isLarge={false}
											defaultExpanded={true}
										/>
									</div>
								)}
							</div>
						) : !isUser ? (
							// Completed assistant messages: full Markdown rendering
							// Tool calls are interleaved into the text when present
							toolCallNodes.length > 0 ? (
								<InterleavedMarkdownRenderer
									content={displayContent}
									toolCallNodes={toolCallNodes}
									toolPositions={toolPositions}
								/>
							) : (
								<MarkdownRenderer content={displayContent} />
							)
						) : (
							// User messages: plain text
							displayContent
						)}
					</div>
				)}

				{/* ── Todo List card (VS Code: chatTodoListWidget pattern) ─── */}
				{message.todos && message.todos.length > 0 && (
					<TodoListCard
						todos={message.todos}
						title="任务清单"
						readonly={!isStreaming}
						onToggle={(id, completed) => {
							console.log('[ChatMessage] Todo toggled:', id, completed);
							// TODO: Handle todo toggle
						}}
						onAdd={(label) => {
							console.log('[ChatMessage] Todo added:', label);
							// TODO: Handle todo add
						}}
					/>
				)}

				{/* ── Tip card (VS Code: chatTipContentPart pattern) ─── */}
				{message.tips && message.tips.map((tip) => (
					<TipCard
						key={tip.id}
						tip={tip}
						onDismiss={(id) => {
							console.log('[ChatMessage] Tip dismissed:', id);
							// TODO: Handle tip dismiss
						}}
					/>
				))}

				{/* ── Question Carousel card (VS Code: chatQuestionCarouselPart pattern) ─── */}
				{message.questions && message.questions.length > 0 && (
					<QuestionCarouselCard
						questions={message.questions}
						title="推荐问题"
						onQuestionClick={(question) => {
							console.log('[ChatMessage] Question clicked:', question);
							// TODO: Handle question click - send as user message
							const { sendMessage } = useChatStore.getState();
							sendMessage(question.label);
						}}
						showCategories={true}
					/>
				)}
			</div>

			{/* ── Retry button for retryable errors (VS Code Copilot Chat pattern) ── */}
			{isSystemError && message.error?.retryable && (
				<div className="message-error-actions">
					<button
						className="message-retry-btn"
						onClick={() => {
							// Find the last user message and resend it
							const { messages, sendMessage } = useChatStore.getState();
							const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
							if (lastUserMsg && lastUserMsg.content.trim()) {
								sendMessage(lastUserMsg.content);
							}
						}}
						title="重试上一条消息"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="1 4 1 10 7 10" />
							<path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
						</svg>
						重试
					</button>
					{message.error.isRateLimited && (
						<span className="message-error-hint">请求频率过高，稍后重试</span>
					)}
				</div>
			)}

			{/* ── Footer: time + token count + cancelled badge ────────────── */}
			<div className="message-footer">
				<span className="message-time">{formatTime(message.timestamp)}</span>
				{!isUser && message.id.startsWith('cancelled_') && (
					<span className="message-cancelled-badge" title="用户手动停止了生成">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<rect x="6" y="6" width="12" height="12" rx="2" />
						</svg>
						已停止
					</span>
				)}
				{!isUser && message.tokenUsage && message.tokenUsage.total > 0 && (
					<span className="message-tokens"
						title={`输入: ${message.tokenUsage.input} / 输出: ${message.tokenUsage.output}`}
					>
						{message.tokenUsage.total} tokens
					</span>
				)}
			</div>
		</div>
	);
}



export const ChatMessageComponent = memo(ChatMessageRaw, (prev, next) => {
	// Custom shallow compare: only re-render when content actually changes
	const pm = prev.message;
	const nm = next.message;

	// Messages that render content from external stores (e.g. orchestration plans)
	// must not be memoized, since their visual state depends on store data that
	// can change without the message object itself changing.
	if (pm.metadata?.type === 'orchestration_plan' || nm.metadata?.type === 'orchestration_plan') {
		return false;
	}

	return (
		pm.id === nm.id &&
		pm.content === nm.content &&
		pm.thinking === nm.thinking &&
		pm.toolCalls === nm.toolCalls &&
		pm.tokenUsage === nm.tokenUsage &&
		pm.metadata === nm.metadata &&
		pm.references === nm.references &&
		pm.progress === nm.progress &&
		pm.confirmation === nm.confirmation &&
		pm.todos === nm.todos &&
		pm.tips === nm.tips &&
		pm.questions === nm.questions &&
		pm.subAgents === nm.subAgents &&
		prev.isStreaming === next.isStreaming
	);
});
