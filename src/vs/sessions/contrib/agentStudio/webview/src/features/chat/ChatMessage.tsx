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

import React, { memo, useCallback, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatMessage } from '../../store/useChatStore';
import { ToolCallCard } from './ToolCallCard';
import { sanitizeAssistantContent, isPureToolCallJson } from '../../utils/assistantVisibleText';

interface ChatMessageProps {
	message: ChatMessage;
	isStreaming?: boolean;
}

/** Maximum text length before we skip full Markdown rendering for performance */
const MAX_MARKDOWN_LENGTH = 40_000;
/** Code blocks larger than this are collapsed by default */
const LARGE_CODE_THRESHOLD = 30;

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
	const [thinkingCollapsed, setThinkingCollapsed] = useState(true); // Collapsed by default (OpenClaw pattern)
	const [jsonExpanded, setJsonExpanded] = useState(false);

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
	const displayContent = useMemo(() => {
		if (!message.content) { return ''; }
		if (isUser) { return message.content; }
		const sanitized = sanitizeAssistantContent(message.content);
		return sanitized;
	}, [message.content, isUser]);

	// Render markdown content for assistant messages
	// Enhanced with OpenClaw patterns: auto-collapse JSON, large code blocks, copy button
	const renderMarkdown = useCallback((content: string) => {
		// Performance guard: very long messages get plain-text rendering (OpenClaw pattern)
		if (content.length > MAX_MARKDOWN_LENGTH) {
			return (
				<pre className="message-plain-text">{content.substring(0, MAX_MARKDOWN_LENGTH)}
					{'\n\n... [内容过长，已截断显示]'}
				</pre>
			);
		}

		return (
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					code({ className, children, ...props }: any) {
						const match = /language-(\w+)/.exec(className || '');
						const codeStr = String(children).replace(/\n$/, '');
						const lineCount = codeStr.split('\n').length;
						const isJson = match?.[1]?.toLowerCase() === 'json';
						const isLarge = lineCount > LARGE_CODE_THRESHOLD;

						if (match) {
							return (
								<CodeBlockWithCollapse
									code={codeStr}
									language={match[1]}
									isJson={isJson}
									isLarge={isLarge}
								/>
							);
						}
						return (
							<code className={`inline-code ${className || ''}`} {...props}>
								{children}
							</code>
						);
					},
					// Links open in new tab
					a({ href, children, ...props }: any) {
						return (
							<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
								{children}
							</a>
						);
					},
					// Tables with proper styling
					table({ children, ...props }: any) {
						return (
							<div className="table-wrapper">
								<table {...props}>{children}</table>
							</div>
						);
					},
					// Task list support (OpenClaw uses markdown-it-task-lists)
					li({ children, className, ...props }: any) {
						if (className === 'task-list-item') {
							return <li className="task-list-item" {...props}>{children}</li>;
						}
						return <li {...props}>{children}</li>;
					},
				}}
			>
				{content}
			</ReactMarkdown>
		);
	}, []);

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
								<div className="thinking-markdown">
									{renderMarkdown(message.thinking)}
								</div>
							</div>
						)}
					</div>
				)}

				{/* ── Tool calls ────────────────────────────── */}
				{message.toolCalls && message.toolCalls.length > 0 && (
					<div className="tool-calls-section">
						{message.toolCalls.map((tc) => (
							<ToolCallCard key={tc.id} toolCall={tc} />
						))}
					</div>
				)}

				{/* ── Main content ──────────────────────────── */}
				{displayContent && (
					<div className="message-text">
						{isStreaming && !isUser ? (
							// During streaming: plain text + cursor
							<span className="streaming-text-content">{displayContent}<span className="cursor-blink">▊</span></span>
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
							<div className="markdown-body">
								{renderMarkdown(displayContent)}
							</div>
						) : (
							// User messages: plain text
							displayContent
						)}
					</div>
				)}
			</div>

			{/* ── Footer: time + token count ────────────── */}
			<div className="message-footer">
				<span className="message-time">{formatTime(message.timestamp)}</span>
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

/**
 * Code block with collapse functionality.
 * Inspired by OpenClaw's markdown.ts which auto-collapses JSON blocks
 * and provides copy buttons + language labels.
 */
function CodeBlockWithCollapse({
	code,
	language,
	isJson,
	isLarge,
	defaultExpanded,
}: {
	code: string;
	language: string;
	isJson: boolean;
	isLarge: boolean;
	defaultExpanded?: boolean;
}): React.ReactElement {
	// JSON blocks and large blocks are collapsed by default (OpenClaw pattern)
	const [expanded, setExpanded] = useState(defaultExpanded ?? !(isJson || isLarge));
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		navigator.clipboard?.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}).catch(() => { });
	}, [code]);

	const lineCount = code.split('\n').length;

	return (
		<div className={`code-block-wrapper ${!expanded ? 'collapsed' : ''}`}>
			<div className="code-block-header">
				<span className="code-block-lang">{language}</span>
				{(isJson || isLarge) && (
					<button
						className="code-block-toggle"
						onClick={() => setExpanded(!expanded)}
						title={expanded ? '折叠' : `展开 (${lineCount} 行)`}
					>
						{expanded ? '▼ 折叠' : `▶ 展开 (${lineCount} 行)`}
					</button>
				)}
				<button
					className="code-block-copy"
					onClick={handleCopy}
					title={copied ? '已复制!' : '复制代码'}
				>
					{copied ? (
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					) : (
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
							<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
						</svg>
					)}
				</button>
			</div>
			{expanded && (
				<SyntaxHighlighter
					style={oneDark}
					language={language}
					PreTag="div"
					customStyle={{
						margin: 0,
						borderRadius: '0 0 6px 6px',
						fontSize: '12px',
						lineHeight: '1.5',
					}}
					showLineNumbers={lineCount > 10}
					wrapLongLines={true}
				>
					{code}
				</SyntaxHighlighter>
			)}
		</div>
	);
}

export const ChatMessageComponent = memo(ChatMessageRaw, (prev, next) => {
	// Custom shallow compare: only re-render when content actually changes
	const pm = prev.message;
	const nm = next.message;
	return (
		pm.id === nm.id &&
		pm.content === nm.content &&
		pm.thinking === nm.thinking &&
		pm.toolCalls === nm.toolCalls &&
		pm.tokenUsage === nm.tokenUsage &&
		prev.isStreaming === next.isStreaming
	);
});
