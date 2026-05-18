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

import React, { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '../../store/useChatStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { useProviderStore } from '../../store/useProviderStore';
import { ChatMessageComponent } from './ChatMessage';
import { StreamingText } from './StreamingText';
import { ChatComposer } from './ChatComposer';
import { ToolCallCard } from './ToolCallCard';
import { AgentSessionSwitcher } from './AgentSessionSwitcher';
import { ConfigMDPanel } from '../configmd/ConfigMDPanel';

export function EmployeeChat(): React.ReactElement {
	const { messages, streamState, sendMessage, cancelStream, activeEmployeeId, setActiveEmployee } = useChatStore();
	const { employees, selectedEmployeeId } = useEmployeeStore();
	const { selection, loadSelectionForEmployee } = useProviderStore();
	const messagesEndRef = useRef<HTMLDivElement>(null);

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

	// Auto-scroll to bottom on new messages or streaming updates
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, streamState.textBuffer, streamState.thinkingBuffer, streamState.toolCalls]);

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

	// ─── ConfigMD integration ────────────────────────────────────────────────
	const configMd = (activeEmployee as any).configMd as {
		mdPath?: string;
		parserPath?: string;
		stylesPath?: string;
		displayMode?: 'side' | 'replace' | 'tab';
		defaultView?: 'preview' | 'source' | 'split';
		editable?: boolean;
		sandboxLevel?: 'strict' | 'standard' | 'permissive';
		autoShow?: boolean;
		syncDebounceMs?: number;
		capabilities?: string[];
	} | undefined;

	const hasConfigMd = !!configMd;
	const configMdDisplayMode = configMd?.displayMode || 'side';

	// If displayMode is 'replace', render only the ConfigMD panel
	if (hasConfigMd && configMdDisplayMode === 'replace') {
		return (
			<div className="employee-chat configmd-replace-mode">
				{/* Chat Header (kept for context) */}
				<div className="chat-header">
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
				</div>
				<ConfigMDPanel
					employeeId={activeEmployee.id}
					config={configMd!}
					className="configmd-fullpanel"
				/>
			</div>
		);
	}

	return (
		<>
		<div className={`employee-chat ${hasConfigMd && configMdDisplayMode === 'side' ? 'with-configmd-side' : ''}`}>
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
					<span className="chat-header-name">{activeEmployee.name}</span>
					<span className="chat-header-role">
						{activeEmployee.role}
						<span className={`chat-header-status ${statusClass}`}>{statusText}</span>
					</span>
				</div>
				<div className="chat-header-actions">
					<AgentSessionSwitcher />
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

				{/* ── Streaming indicator (enhanced) ────────── */}
				{streamState.isStreaming && (
					<div className="chat-message assistant">
						<div className="message-content message-streaming">

							{/* Thinking card — active with spinner */}
							{streamState.thinkingBuffer && (
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
										<StreamingText text={streamState.thinkingBuffer} />
									</div>
								</div>
							)}

							{/* Streaming tool calls */}
							{streamState.toolCalls.length > 0 && (
								<div className="tool-calls-section">
									{streamState.toolCalls.map((tc) => (
										<ToolCallCard key={tc.id} toolCall={tc} />
									))}
								</div>
							)}

							{/* Streaming text content */}
							{streamState.textBuffer && (
								<div className="message-text">
									<StreamingText text={streamState.textBuffer} />
								</div>
							)}

							{/* Error message */}
							{streamState.errorMessage && (
								<div className="message-text stream-error">
									⚠️ {streamState.errorMessage}
								</div>
							)}

							{/* Typing dots — only when nothing else is showing */}
							{!streamState.textBuffer && !streamState.thinkingBuffer && !streamState.errorMessage && streamState.toolCalls.length === 0 && (
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

		{/* ConfigMD Side Panel */}
		{hasConfigMd && configMdDisplayMode === 'side' && (
			<div className="configmd-side-container">
				<ConfigMDPanel
					employeeId={activeEmployee.id}
					config={configMd!}
					className="configmd-side-panel"
				/>
			</div>
		)}
		</>
	);
}
