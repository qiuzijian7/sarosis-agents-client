/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Chat Panel
 *  Matches sarosis-webui layout:
 *  - Chat header with ⚡ provider + avatar + name + status
 *  - Session info bar (PM / members / tasks)
 *  - Message list with auto-scroll
 *  - Streaming indicator
 *  - Full Composer with provider/model pill
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '../../store/useChatStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { useProviderStore } from '../../store/useProviderStore';
import { ChatMessageComponent } from './ChatMessage';
import { StreamingText } from './StreamingText';
import { ChatComposer } from './ChatComposer';

export function EmployeeChat(): React.ReactElement {
	const { messages, streamState, sendMessage, cancelStream, activeEmployeeId, setActiveEmployee } = useChatStore();
	const { employees, selectedEmployeeId } = useEmployeeStore();
	const { selection } = useProviderStore();
	const messagesEndRef = useRef<HTMLDivElement>(null);

	// Sync selected employee with chat
	useEffect(() => {
		if (selectedEmployeeId && selectedEmployeeId !== activeEmployeeId) {
			setActiveEmployee(selectedEmployeeId);
		}
	}, [selectedEmployeeId, activeEmployeeId, setActiveEmployee]);

	// Auto-scroll to bottom on new messages or streaming updates
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, streamState.textBuffer]);

	const activeEmployee = employees.find(e => e.id === activeEmployeeId);

	const handleSend = useCallback((content: string) => {
		if (content.trim()) {
			sendMessage(content);
		}
	}, [sendMessage]);

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

	return (
		<div className="employee-chat">
			{/* Chat Header */}
			<div className="chat-header">
				{/* Provider icon */}
				<div className="chat-header-provider" title={activeEmployee.provider || selection?.providerName ? `Provider: ${activeEmployee.provider || selection?.providerName}` : undefined}>
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
					<span className="chat-header-name">{activeEmployee.name}</span>
					<span className="chat-header-role">
						{activeEmployee.role}
						<span className={`chat-header-status ${statusClass}`}>{statusText}</span>
					</span>
				</div>
				<div className="chat-header-actions">
					<button className="chat-header-btn" title="编辑 Agent">
						<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
						</svg>
					</button>
					<button className="chat-header-btn" title="设置">
						<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
						</svg>
					</button>
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
			<div className="chat-messages">
				{messages.map((msg) => (
					<ChatMessageComponent key={msg.id} message={msg} />
				))}

				{/* Streaming indicator */}
				{streamState.isStreaming && (
					<div className="chat-message assistant">
						<div className="message-content message-streaming">
							{streamState.thinkingBuffer && (
								<details className="thinking-block" open>
									<summary className="thinking-summary">思考中...</summary>
									<div className="thinking-content">
										<StreamingText text={streamState.thinkingBuffer} />
									</div>
								</details>
							)}
							{streamState.textBuffer && (
								<div className="message-text">
									<StreamingText text={streamState.textBuffer} />
								</div>
							)}
							{streamState.errorMessage && (
								<div className="message-text" style={{ color: 'var(--vscode-errorForeground, #f48771)' }}>
									⚠️ {streamState.errorMessage}
								</div>
							)}
							{!streamState.textBuffer && !streamState.thinkingBuffer && !streamState.errorMessage && (
								<div className="typing-indicator">
									<span className="typing-dot">●</span>
									<span className="typing-dot">●</span>
									<span className="typing-dot">●</span>
								</div>
							)}
							{/* Streaming tool calls */}
							{streamState.toolCalls.length > 0 && (
								<div className="tool-calls">
									{streamState.toolCalls.map((tc) => (
										<details key={tc.id} className="tool-call-block" open={tc.status === 'running'}>
											<summary className="tool-call-name">
												🔧 {tc.name}
												<span className={`tool-status ${tc.status === 'done' ? 'done' : 'running'}`}>
													{tc.status === 'done' ? '完成' : '运行中'}
												</span>
											</summary>
											{tc.arguments && <pre className="tool-args">{tc.arguments}</pre>}
											{tc.result && <pre className="tool-result">{tc.result}</pre>}
										</details>
									))}
								</div>
							)}
						</div>
						<div className="message-footer">
							<span className="message-time">
								{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
							</span>
						</div>
					</div>
				)}

				<div ref={messagesEndRef} />
			</div>

		{/* Composer */}
		<ChatComposer
			onSend={handleSend}
			onCancel={cancelStream}
			isLoading={streamState.isStreaming}
		/>
		</div>
	);
}
