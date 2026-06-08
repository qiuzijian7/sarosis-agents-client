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
// CheckpointCard 已停止在消息流中渲染（改为 CheckpointBar 显示在输入框上方），
// 此处保留导入会触发 unused-import lint，故移除。如需恢复时间旅行卡片，请重新引入。

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

/**
 * Build a usable image src from a persisted attachment.
 * Stored attachments keep raw base64 (without the data: prefix) plus the mime
 * type, so we reconstruct the data URL here. If the data already looks like a
 * full data URL (legacy / pasted), pass it through untouched.
 */
function attachmentImageSrc(att: { data: string; mimeType: string }): string {
	const data = att.data || '';
	if (data.startsWith('data:')) { return data; }
	const mime = att.mimeType || 'image/png';
	return `data:${mime};base64,${data}`;
}

function ChatMessageRaw({ message, isStreaming = false }: ChatMessageProps): React.ReactElement {
	const isUser = message.role === 'user';
	const isSystemError = message.role === 'system' && message.id.startsWith('error_');
	const [thinkingCollapsed, setThinkingCollapsed] = useState(true); // Collapsed by default (OpenClaw pattern)
	const [jsonExpanded, setJsonExpanded] = useState(false);
	// Lightbox preview for image attachments (Void-inspired full-size viewer)
	const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

	// Subscribe to the orchestration plan that this message renders.
	// ChatMessageRaw is wrapped in React.memo; while the custom comparator
	// returns false for orchestration_plan messages (so it re-renders when
	// the parent list re-renders), the parent list only re-renders when the
	// messages array changes.  By subscribing to the plan status here we
	// force this component to re-render whenever the plan is
	// approved/rejected/updated, bypassing the memo barrier entirely.
	const _orchPlanStatus = message.metadata?.type === 'orchestration_plan'
		? useOrchestrationStore(s => s.plans.find(p => p.id === message.metadata!.planId)?.status)
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

	// Always sanitize assistant content using the unified pipeline.
	// This catches tool-call artifacts that may remain even when no toolCalls
	// were detected (e.g. model outputs raw JSON that was extracted by the
	// backend's _tryExtractToolCallsFromText, but the content_replace delta
	// arrives after the message was already persisted).
	//
	// Additional defense: strip literal "undefined" pollution. Historical
	// messages persisted to disk before the upstream coercion fixes were
	// rolled out may contain runs of "undefined" coming from `${undefined}`
	// template stringification in the IModelDelta pipeline. Removing them
	// at render time cleans up old sessions without needing to migrate
	// the JSON files on disk.
	const displayContent = useMemo(() => {
		if (!message.content) { return ''; }
		if (isUser) { return message.content; }
		const sanitized = sanitizeAssistantContent(message.content);
		const cleaned = sanitized.includes('undefined')
			? sanitized.replace(/(?:undefined)+/g, '')
			: sanitized;
		// DEBUG: Log completed message content for consistency diagnosis
		console.log('[ChatMessage] displayContent computed:', {
			rawLen: message.content.length,
			sanitizedLen: cleaned.length,
			first200: cleaned.substring(0, 200),
			// Check if ## headings have space already (should have after host processing)
			headingsRaw: (message.content.match(/^#{1,6}\S.*/gm) || []).slice(0, 3),
			headingsSanitized: (cleaned.match(/^#{1,6}\S.*/gm) || []).slice(0, 3),
		});
		return cleaned;
	}, [message.content, isUser]);

	// ── Checkpoint message (Void-inspired time-travel anchor) ──────────────
	// 历史决策：曾以内联 CheckpointCard（"工具编辑 | N 文件变更 | <file>"）形式
	// 渲染在消息流中。但产品决定只保留输入框上方的 CheckpointBar 作为唯一入口
	// （非常驻摘要 + 保留/撤销/查看变更），消息流里不再展示这类条目，避免视觉重复。
	// 数据本身保留在 messages 中（CheckpointBar 依赖 messages 派生 latest），
	// 只是不渲染。如未来需要在消息流中提供时间旅行 UI，再恢复 CheckpointCard。
	if (message.role === 'checkpoint') {
		return null as unknown as React.ReactElement;
	}

	return (
		// data-message-id：供 CheckpointBar 的 checkpoint 选择器定位滚动锚点用。
		// 切换 checkpoint item 时，会 querySelector(`[data-message-id="..."]`)
		// 找到对应用户输入点并 scrollIntoView。
		<div className={`chat-message ${message.role}`} data-message-id={message.id}>
			<div className={`message-content ${isStreaming ? 'message-streaming' : ''}`}>
				{/* ── Attachments (Void-inspired): images render as a thumbnail grid,
				     other files as chips. Shown above the text content. ─────────── */}
				{message.attachments && message.attachments.length > 0 && (
					<div className="message-attachments">
						{message.attachments.map(att => (
							att.type === 'image' ? (
								<button
									key={att.id}
									type="button"
									className="message-attachment-image"
									title={att.name}
									onClick={() => setLightboxSrc(attachmentImageSrc(att))}
								>
									<img src={attachmentImageSrc(att)} alt={att.name} loading="lazy" />
								</button>
							) : (
								<div key={att.id} className="message-attachment-file" title={att.name}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
										<polyline points="14 2 14 8 20 8" />
									</svg>
									<span className="message-attachment-name">{att.name}</span>
								</div>
							)
						))}
					</div>
				)}

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
						{...({
							progress: message.progress,
							showSpinner: isStreaming,
							collapsible: Array.isArray(message.progress) && message.progress.length > 1,
							defaultExpanded: true,
						} as any)}
					/>
				)}

				{/* ── Confirmation card (VS Code: chatConfirmationContentPart pattern) ─── */}
				{message.confirmation && (
					<ConfirmationCard
						{...({
							confirmation: message.confirmation,
							onApprove: (buttonId: string) => {
								console.log('[ChatMessage] Confirmation approved:', buttonId);
								// TODO: Handle confirmation approve
							},
							onReject: () => {
								console.log('[ChatMessage] Confirmation rejected');
								// TODO: Handle confirmation reject
							},
							collapsed: false,
						} as any)}
					/>
				)}

				{/* ── Tool calls (Disabled: now handled by InterleavedMarkdownRenderer below) ─── */}
							{/* {message.toolCalls && message.toolCalls.length > 0 && (
					<div className="tool-calls-section">
						{message.toolCalls
							.filter(tc => tc.defaultShow !== false)
							.map((tc) => (
								<ToolCallCard key={tc.id} toolCall={tc} />
							))}
					</div>
				)} */}

				{/* ── Main content ──────────────────────────── */}
				{displayContent && (
					<div className="message-text">
						{/* Orchestration plan inline (special message type) */}
						{message.metadata?.type === 'orchestration_plan' ? (
							<OrchestrationPlanInline planId={message.metadata.planId} />
						) : message.metadata?.type === 'decomposition_progress' ? (
							// Decomposition progress message with styled indicator
							<div className="decomposition-progress-msg">
								<span className={`decomposition-stage decomposition-stage-${((message.metadata as any).stage as string) || 'info'}`}>
									{displayContent}
								</span>
							</div>
						) : isStreaming && !isUser ? (
							// During streaming: live markdown rendering (OpenClaw pattern)
							<MarkdownRenderer content={displayContent} showCursor />
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
							// Completed assistant messages: full Markdown rendering with interleaved tool calls (Void pattern)
							(() => {
								const safeToolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
								const visibleToolCalls = safeToolCalls.filter(tc => tc && tc.defaultShow !== false);
								const toolCallNodes = visibleToolCalls.map(tc => (
									<ToolCallCard key={tc.id} toolCall={tc} />
								));
								// Build position map from textPosition hints (recorded at tool_start time)
								const toolPositions = new Map<string, number>();
								for (const tc of visibleToolCalls) {
									if (tc.textPosition !== undefined) {
										toolPositions.set(tc.id, tc.textPosition);
									}
								}
								return toolCallNodes.length > 0 ? (
									<InterleavedMarkdownRenderer
										content={displayContent}
										toolCallNodes={toolCallNodes}
										toolPositions={toolPositions}
									/>
								) : (
									<MarkdownRenderer content={displayContent} />
								);
							})()
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
						title={
							`输入: ${message.tokenUsage.input} / 输出: ${message.tokenUsage.output}` +
							(message.tokenUsage.cached ? ` / 缓存命中: ${message.tokenUsage.cached}` : '') +
							(message.tokenUsage.cacheWrite ? ` / 缓存写入: ${message.tokenUsage.cacheWrite}` : '') +
							(message.tokenUsage.credit ? ` / 消耗积分: ${message.tokenUsage.credit}` : '')
						}
					>
						{message.tokenUsage.total} tokens
						{message.tokenUsage.cached && message.tokenUsage.cached > 0 ? (
							<span className="message-cache-hit" style={{ marginLeft: 6, opacity: 0.85 }}>
								🎯 cache {message.tokenUsage.cached}
							</span>
						) : null}
						{message.tokenUsage.credit && message.tokenUsage.credit > 0 ? (
							<span className="message-credit" style={{ marginLeft: 6, opacity: 0.85 }}>
								💎 {message.tokenUsage.credit}
							</span>
						) : null}
					</span>
				)}
			</div>

			{/* ── Lightbox: full-size image preview (Void-inspired) ───────────── */}
			{lightboxSrc && (
				<div
					className="message-image-lightbox"
					role="dialog"
					aria-modal="true"
					onClick={() => setLightboxSrc(null)}
				>
					<img src={lightboxSrc} alt="预览" onClick={e => e.stopPropagation()} />
					<button
						className="message-image-lightbox-close"
						onClick={() => setLightboxSrc(null)}
						title="关闭"
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			)}
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
		pm.attachments === nm.attachments &&
		pm.checkpoint === nm.checkpoint &&
		prev.isStreaming === next.isStreaming
	);
});
