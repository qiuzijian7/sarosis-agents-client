/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Chat Message Component
 *--------------------------------------------------------------------------------------------*/

import React, { memo } from 'react';
import type { ChatMessage } from '../../store/useChatStore';

interface ChatMessageProps {
	message: ChatMessage;
}

function ChatMessageRaw({ message }: ChatMessageProps): React.ReactElement {


	return (
		<div className={`chat-message ${message.role}`}>
			<div className="message-content">
				{/* Thinking block */}
				{message.thinking && (
					<details className="thinking-block">
						<summary>Thinking...</summary>
						<div className="thinking-content">{message.thinking}</div>
					</details>
				)}

				{/* Main content - render as simple text for now */}
				<div className="message-text">
					{message.content}
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

			{/* Timestamp */}
			<div className="message-meta">
				{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
			</div>
		</div>
	);
}

export const ChatMessageComponent = memo(ChatMessageRaw);
