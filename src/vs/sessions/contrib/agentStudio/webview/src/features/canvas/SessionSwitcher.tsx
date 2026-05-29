/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Session Switcher Component
 *  Dropdown to switch between Root and Fork sessions.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useEffect } from 'react';
import { useWorkspaceSessionStore, type WorkspaceSession } from '../../store/useWorkspaceSessionStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

function statusIcon(status: string): string {
	switch (status) {
		case 'running': return '🔄';
		case 'pending': return '⏳';
		case 'completed': return '✅';
		case 'error': return '❌';
		case 'archived': return '📦';
		default: return '📋';
	}
}

function formatDate(iso: string): string {
	try {
		const d = new Date(iso);
		return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	} catch {
		return iso;
	}
}

export function SessionSwitcher(): React.ReactElement {
	const { sessions, activeSessionId, mode, switchToSession, switchToRoot, createFork, deleteSession } = useWorkspaceSessionStore();
	const { activeWorkspaceId } = useWorkspaceStore();
	const [isOpen, setIsOpen] = useState(false);
	const [showCreateDialog, setShowCreateDialog] = useState(false);
	const [newForkName, setNewForkName] = useState('');
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Close dropdown when clicking outside
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, []);

	const activeSession = sessions.find(s => s.id === activeSessionId);
	const label = mode === 'root' ? 'Root (可编辑)' : (activeSession?.name || 'Fork');

	const handleCreateFork = async () => {
		if (!activeWorkspaceId || !newForkName.trim()) { return; }
		const fork = await createFork({
			workspaceId: activeWorkspaceId,
			name: newForkName.trim(),
			source: 'manual',
		});
		setShowCreateDialog(false);
		setNewForkName('');
		if (fork) {
			await switchToSession(fork.id);
		}
		setIsOpen(false);
	};

	const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
		e.stopPropagation();
		if (confirm('确定删除此 Fork？')) {
			await deleteSession(sessionId);
		}
	};

	// Filter out archived sessions from the main list
	const visibleSessions = sessions.filter((s): s is NonNullable<typeof s> => s != null && s.status !== 'archived');

	return (
		<div className="session-switcher" ref={dropdownRef}>
			<button
				className={`session-switcher-trigger ${mode === 'fork' ? 'fork-mode' : ''}`}
				onClick={() => setIsOpen(!isOpen)}
				title="切换 Session"
			>
				<span className="session-switcher-icon">{mode === 'root' ? '🏠' : '🔀'}</span>
				<span className="session-switcher-label">{label}</span>
				<svg className="session-switcher-arrow" viewBox="0 0 12 12" width="10" height="10">
					<path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
				</svg>
			</button>

			{isOpen && (
				<div className="session-switcher-dropdown">
					{/* Root option */}
					<button
						className={`session-switcher-item ${mode === 'root' ? 'active' : ''}`}
						onClick={() => { switchToRoot(); setIsOpen(false); }}
					>
						<span className="session-item-icon">🏠</span>
						<span className="session-item-label">Root (主工作区)</span>
						{mode === 'root' && <span className="session-item-check">✓</span>}
					</button>

					{visibleSessions.length > 0 && <div className="session-switcher-divider" />}

					{/* Fork sessions */}
					{visibleSessions.map((session: WorkspaceSession) => (
						<button
							key={session.id}
							className={`session-switcher-item ${activeSessionId === session.id ? 'active' : ''}`}
							onClick={() => { switchToSession(session.id); setIsOpen(false); }}
						>
							<span className="session-item-icon">{statusIcon(session.status)}</span>
							<span className="session-item-label">
								{session.name}
								<span className="session-item-date">{formatDate(session.createdAt)}</span>
							</span>
							{activeSessionId === session.id && <span className="session-item-check">✓</span>}
							<button
								className="session-item-delete"
								onClick={(e) => handleDeleteSession(e, session.id)}
								title="删除"
							>
								×
							</button>
						</button>
					))}

					<div className="session-switcher-divider" />

					{/* Create Fork button */}
					{!showCreateDialog ? (
						<button
							className="session-switcher-item session-create-btn"
							onClick={() => setShowCreateDialog(true)}
						>
							<span className="session-item-icon">➕</span>
							<span className="session-item-label">手动创建 Fork</span>
						</button>
					) : (
						<div className="session-create-dialog">
							<input
								type="text"
								className="session-create-input"
								placeholder="Fork 名称..."
								value={newForkName}
								onChange={(e) => setNewForkName(e.target.value)}
								onKeyDown={(e) => { if (e.key === 'Enter') { handleCreateFork(); } }}
								autoFocus
							/>
							<div className="session-create-actions">
								<button className="session-create-confirm" onClick={handleCreateFork}>创建</button>
								<button className="session-create-cancel" onClick={() => { setShowCreateDialog(false); setNewForkName(''); }}>取消</button>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
