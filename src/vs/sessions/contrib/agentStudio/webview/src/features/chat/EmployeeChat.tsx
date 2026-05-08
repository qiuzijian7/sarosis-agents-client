/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Chat Panel
 *  Simplified from sarosis-webui's EmployeeChat.tsx (176KB → focused on core chat)
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore, type ChatMessage } from '../../store/useChatStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { ChatMessageComponent } from './ChatMessage';
import { StreamingText } from './StreamingText';

export function EmployeeChat(): React.ReactElement {
	const { messages, streamState, inputValue, setInputValue, sendMessage, cancelStream, activeEmployeeId, setActiveEmployee } = useChatStore();
	const { employees, selectedEmployeeId } = useEmployeeStore();
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// Sync selected employee with chat
	useEffect(() => {
		if (selectedEmployeeId && selectedEmployeeId !== activeEmployeeId) {
			setActiveEmployee(selectedEmployeeId);
		}
	}, [selectedEmployeeId, activeEmployeeId, setActiveEmployee]);

	// Auto-scroll to bottom on new messages
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, streamState.textBuffer]);

	const activeEmployee = employees.find(e => e.id === activeEmployeeId);

	const handleSend = useCallback(() => {
		if (inputValue.trim()) {
			sendMessage(inputValue);
		}
	}, [inputValue, sendMessage]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}, [handleSend]);

	if (!activeEmployee) {
		return (
			<div className="chat-empty">
				<div>
					<p style={{ fontSize: '14px', marginBottom: '8px' }}>💬 Agent Studio</p>
					<p style={{ opacity: 0.7, fontSize: '12px' }}>Select an agent from the sidebar to start chatting</p>
				</div>
			</div>
		);
	}

	return (
		<div className="employee-chat">
			{/* Header */}
			<div className="chat-header">
				<img
					src={activeEmployee.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${activeEmployee.id}`}
					alt={activeEmployee.name}
					className="chat-header-avatar"
				/>
				<div className="chat-header-info">
					<span className="chat-header-name">{activeEmployee.name}</span>
					<span className="chat-header-role">{activeEmployee.role}</span>
				</div>
				{activeEmployee.model && (
					<span className="chat-header-model">{activeEmployee.model}</span>
				)}
			</div>

			{/* Messages */}
			<div className="chat-messages">
				{messages.map((msg) => (
					<ChatMessageComponent key={msg.id} message={msg} />
				))}

				{/* Streaming indicator */}
				{streamState.isStreaming && (
					<div className="chat-message assistant">
						<div className="message-content">
							{streamState.thinkingBuffer && (
								<div className="thinking-block">
									<StreamingText text={streamState.thinkingBuffer} />
								</div>
							)}
							{streamState.textBuffer && (
								<StreamingText text={streamState.textBuffer} />
							)}
							{!streamState.textBuffer && !streamState.thinkingBuffer && (
								<span className="typing-indicator">●●●</span>
							)}
						</div>
					</div>
				)}
				<div ref={messagesEndRef} />
			</div>

			{/* Input */}
			<div className="chat-input-container">
				<textarea
					ref={inputRef}
					className="chat-input"
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={`Message ${activeEmployee.name}...`}
					rows={1}
					disabled={streamState.isStreaming}
				/>
				<div className="chat-input-actions">
					{streamState.isStreaming ? (
						<button className="chat-btn stop" onClick={cancelStream} title="Stop">
							■
						</button>
					) : (
						<button
							className="chat-btn send"
							onClick={handleSend}
							disabled={!inputValue.trim()}
							title="Send"
						>
							↑
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
