/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Agent Session Switcher
 *  Dropdown in chat header to switch/create/rename per-agent sessions.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useEffect } from 'react';
import { useChatStore, type AgentSessionInfo } from '../../store/useChatStore';

export function AgentSessionSwitcher(): React.ReactElement | null {
	const {
		activeAgentSessionId,
		agentSessions,
		createAgentSession,
		switchAgentSession,
		renameAgentSession,
		deleteAgentSession,
	} = useChatStore();

	const [isOpen, setIsOpen] = useState(false);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const dropdownRef = useRef<HTMLDivElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setIsOpen(false);
				setRenamingId(null);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, []);

	useEffect(() => {
		if (renamingId && renameInputRef.current) {
			renameInputRef.current.focus();
			renameInputRef.current.select();
		}
	}, [renamingId]);

	const currentId = activeAgentSessionId;
	const currentSession = agentSessions.find(s => s.id === currentId);
	const label = currentSession?.name || (agentSessions.length === 0 ? '新对话' : '选择对话');

	const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
		e.stopPropagation();
		if (confirm('确定删除此对话？')) {
			await deleteAgentSession(sessionId);
		}
	};

	const handleStartRename = (e: React.MouseEvent, session: AgentSessionInfo) => {
		e.stopPropagation();
		setRenamingId(session.id);
		setRenameValue(session.name);
	};

	const handleConfirmRename = async () => {
		if (renamingId && renameValue.trim()) {
			await renameAgentSession(renamingId, renameValue.trim());
		}
		setRenamingId(null);
		setRenameValue('');
	};

	return (
		<div className="agent-session-switcher" ref={dropdownRef}>
			<button
				className="agent-session-trigger"
				onClick={() => setIsOpen(!isOpen)}
				title="切换对话"
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
				</svg>
				<span className="agent-session-label">{label}</span>
				{agentSessions.length > 1 && (
					<span className="agent-session-count">{agentSessions.length}</span>
				)}
				<svg className="agent-session-arrow" viewBox="0 0 12 12" width="8" height="8">
					<path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
				</svg>
			</button>

			{isOpen && (
				<div className="agent-session-dropdown">
					{agentSessions.map((session: AgentSessionInfo) => (
						<div
							key={session.id}
							className={`agent-session-item ${currentId === session.id ? 'active' : ''}`}
							onClick={() => { if (!renamingId) { switchAgentSession(session.id); setIsOpen(false); } }}
						>
							{renamingId === session.id ? (
								<input
									ref={renameInputRef}
									className="agent-session-rename-input"
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') { handleConfirmRename(); }
										if (e.key === 'Escape') { setRenamingId(null); }
									}}
									onBlur={() => handleConfirmRename()}
									onClick={(e) => e.stopPropagation()}
								/>
							) : (
								<>
									<span className="agent-session-item-name">{session.name}</span>
									<span className="agent-session-item-meta">
										{session.messageCount > 0 ? `${session.messageCount} 条` : '空'}
									</span>
									<button
										className="agent-session-item-action"
										onClick={(e) => handleStartRename(e, session)}
										title="重命名"
									>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
											<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
											<path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
										</svg>
									</button>
									<button
										className="agent-session-item-action agent-session-item-delete"
										onClick={(e) => handleDelete(e, session.id)}
										title="删除"
									>
										×
									</button>
								</>
							)}
						</div>
					))}

					<div className="agent-session-divider" />

					<button
						className="agent-session-item agent-session-create"
						onClick={() => { createAgentSession(); setIsOpen(false); }}
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<path d="M12 4v16m8-8H4" />
						</svg>
						<span>新建对话</span>
					</button>
				</div>
			)}
		</div>
	);
}
