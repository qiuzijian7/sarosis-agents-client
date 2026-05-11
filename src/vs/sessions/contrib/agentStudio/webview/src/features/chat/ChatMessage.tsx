/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Message Component
 *  Matches sarosis-webui layout:
 *  - No role label header above bubble
 *  - Footer with time + token count at bottom
 *  - Thinking block (collapsible)
 *  - Tool calls (collapsible with status)
 *--------------------------------------------------------------------------------------------*/

import React, { memo } from 'react';
import type { ChatMessage } from '../../store/useChatStore';

interface ChatMessageProps {
	message: ChatMessage;
	isStreaming?: boolean;
}

function ChatMessageRaw({ message, isStreaming = false }: ChatMessageProps): React.ReactElement {
	const isUser = message.role === 'user';

	const formatTime = (timestamp: string | number) => {
		return new Date(timestamp).toLocaleTimeString('zh-CN', {
			hour: '2-digit',
			minute: '2-digit',
		});
	};

	return (
		<div className={`chat-message ${message.role}`}>
			<div className={`message-content ${isStreaming ? 'message-streaming' : ''}`}>
				{/* Thinking block */}
				{message.thinking && (
					<details className="thinking-block">
						<summary className="thinking-summary">思考过程</summary>
						<div className="thinking-content">{message.thinking}</div>
					</details>
				)}

				{/* Main content */}
				<div className="message-text">
					{message.content}
					{isStreaming && <span className="cursor-blink">▊</span>}
				</div>

				{/* Tool calls */}
				{message.toolCalls && message.toolCalls.length > 0 && (
					<div className="tool-calls">
						{message.toolCalls.map((tc) => (
							<details key={tc.id} className="tool-call-block">
								<summary className="tool-call-name">
									🔧 {tc.name}
									<span className={`tool-status ${tc.status}`}>{tc.status}</span>
								</summary>
								{tc.arguments && (
									<pre className="tool-args">{tc.arguments}</pre>
								)}
								{tc.result && (
									<pre className="tool-result">{tc.result}</pre>
								)}
							</details>
						))}
					</div>
				)}
			</div>

			{/* Footer: time + token count */}
			<div className="message-footer">
				<span className="message-time">{formatTime(message.timestamp)}</span>
			</div>
		</div>
	);
}

export const ChatMessageComponent = memo(ChatMessageRaw);
