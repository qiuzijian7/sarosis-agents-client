/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Message Component
 *
 *  Full-featured message bubble supporting:
 *  - Markdown rendering with react-markdown + remark-gfm
 *  - Code syntax highlighting with react-syntax-highlighter
 *  - Collapsible thinking card (with spinner when active)
 *  - Tool call cards (expandable, with formatted JSON)
 *  - Token usage display in footer
 *
 *  Ref: sarosis-webui EmployeeChat.tsx ChatBubble pattern
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatMessage } from '../../store/useChatStore';
import { ToolCallCard } from './ToolCallCard';

interface ChatMessageProps {
	message: ChatMessage;
	isStreaming?: boolean;
}

function ChatMessageRaw({ message, isStreaming = false }: ChatMessageProps): React.ReactElement {
	const isUser = message.role === 'user';
	const [thinkingCollapsed, setThinkingCollapsed] = useState(false);

	const formatTime = (timestamp: string | number) => {
		return new Date(timestamp).toLocaleTimeString('zh-CN', {
			hour: '2-digit',
			minute: '2-digit',
		});
	};

	// Render markdown content for assistant messages
	const renderMarkdown = useCallback((content: string) => {
		return (
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					code({ className, children, ...props }: any) {
						const match = /language-(\w+)/.exec(className || '');
						const codeStr = String(children).replace(/\n$/, '');
						return match ? (
							<div className="code-block-wrapper">
								<div className="code-block-header">
									<span className="code-block-lang">{match[1]}</span>
									<button
										className="code-block-copy"
										onClick={() => {
											navigator.clipboard?.writeText(codeStr).catch(() => { });
										}}
										title="复制代码"
									>
										📋
									</button>
								</div>
								<SyntaxHighlighter
									style={oneDark}
									language={match[1]}
									PreTag="div"
									customStyle={{
										margin: 0,
										borderRadius: '0 0 6px 6px',
										fontSize: '12px',
										lineHeight: '1.5',
									}}
								>
									{codeStr}
								</SyntaxHighlighter>
							</div>
						) : (
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
				}}
			>
				{content}
			</ReactMarkdown>
		);
	}, []);

	return (
		<div className={`chat-message ${message.role}`}>
			<div className={`message-content ${isStreaming ? 'message-streaming' : ''}`}>
				{/* ── Thinking card ─────────────────────────── */}
				{message.thinking && (
					<div className={`thinking-card ${isStreaming ? 'active' : ''}`}>
						<div
							className="thinking-card-header"
							onClick={() => setThinkingCollapsed(!thinkingCollapsed)}
						>
							<span className="thinking-card-icon">
								{isStreaming ? (
									<svg className="thinking-spinner" width="14" height="14" viewBox="0 0 24 24"
										fill="none" stroke="currentColor" strokeWidth="2">
										<path d="M21 12a9 9 0 11-6.219-8.56" />
									</svg>
								) : '💭'}
							</span>
							<span className="thinking-card-title">
								{isStreaming ? '思考中...' : '思考过程'}
							</span>
							<span className={`thinking-card-toggle ${thinkingCollapsed ? 'collapsed' : ''}`}>
								▼
							</span>
						</div>
						{!thinkingCollapsed && (
							<div className="thinking-card-body">
								{message.thinking}
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
				{message.content && (
					<div className="message-text">
						{isStreaming && !isUser ? (
							// During streaming: plain text to avoid repeated Markdown parsing
							<span className="streaming-text-content">{message.content}</span>
						) : !isUser ? (
							// Completed assistant messages: full Markdown rendering
							<div className="markdown-body">
								{renderMarkdown(message.content)}
							</div>
						) : (
							// User messages: plain text
							message.content
						)}
						{isStreaming && <span className="cursor-blink">▊</span>}
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
