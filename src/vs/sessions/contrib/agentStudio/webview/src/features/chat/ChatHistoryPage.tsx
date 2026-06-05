/*---------------------------------------------------------------------------------------------
 *  Chat History Page
 *  Displayed when user clicks the history button in chat header.
 *  Similar layout to AgentEditorPane: header + content area.
 *  Features: inline edit, inline delete confirm, drag-and-drop reorder, active session marker.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useChatStore, type AgentSession } from '../../store/useChatStore';

/* ── Props ─────────────────────────────────────────────────────── */
interface ChatHistoryPageProps {
	onClose: () => void;
}

/* ═════════════════════════════════════════════════════════
 *  ChatHistoryPage Component
 * ═════════════════════════════════════════════════════════ */

export function ChatHistoryPage({ onClose }: ChatHistoryPageProps): React.ReactElement {
	const {
		agentSessions,
		activeAgentSessionId,
		activeEmployeeId,
		switchAgentSession,
		renameAgentSession,
		deleteAgentSession,
		createAgentSession,
		reorderAgentSessions,
		loadAgentSessions,
	} = useChatStore();

	// Inline edit state
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editName, setEditName] = useState('');
	const editInputRef = useRef<HTMLInputElement>(null);

	// Inline delete confirm state
	const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);

	// Drag-and-drop state
	const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
	const [dropTargetId, setDropTargetId] = useState<string | null>(null);
	const [dropPosition, setDropPosition] = useState<'before' | 'after'>('after');

	// Load sessions on mount
	useEffect(() => {
		if (activeEmployeeId) {
			loadAgentSessions(activeEmployeeId);
		}
	}, [loadAgentSessions, activeEmployeeId]);

	// Focus edit input when entering edit mode
	useEffect(() => {
		if (editingSessionId && editInputRef.current) {
			editInputRef.current.focus();
			editInputRef.current.select();
		}
	}, [editingSessionId]);

	const handleSwitchSession = useCallback((sessionId: string) => {
		switchAgentSession(sessionId);
		onClose(); // Close history page after switching
	}, [switchAgentSession, onClose]);

	// ── Edit handlers ─────────────────────────────────────
	const startEditing = useCallback((session: AgentSession) => {
		setEditingSessionId(session.id);
		setEditName(session.name || '');
		setDeletingSessionId(null);
		setDraggedItemId(null);
	}, []);

	const saveEdit = useCallback(() => {
		if (editingSessionId && editName.trim()) {
			renameAgentSession(editingSessionId, editName.trim());
		}
		setEditingSessionId(null);
		setEditName('');
	}, [editingSessionId, editName, renameAgentSession]);

	const cancelEdit = useCallback(() => {
		setEditingSessionId(null);
		setEditName('');
	}, []);

	const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveEdit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancelEdit();
		}
	}, [saveEdit, cancelEdit]);

	// ── Delete handlers ──────────────────────────────────
	const startDeleteConfirm = useCallback((sessionId: string) => {
		setDeletingSessionId(sessionId);
		setEditingSessionId(null);
		setDraggedItemId(null);
	}, []);

	const confirmDelete = useCallback(() => {
		if (deletingSessionId) {
			deleteAgentSession(deletingSessionId);
			setDeletingSessionId(null);
		}
	}, [deletingSessionId, deleteAgentSession]);

	const cancelDelete = useCallback(() => {
		setDeletingSessionId(null);
	}, []);

	// ── Drag-and-drop handlers ───────────────────────────
	const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => {
		setDraggedItemId(sessionId);
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', sessionId);
	}, []);

	const handleDragOver = useCallback((e: React.DragEvent, sessionId: string) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		if (sessionId === draggedItemId) { return; }

		// Determine drop position (before/after) based on mouse Y within the item
		const rect = (e.target as HTMLElement).closest('.chat-history-item')?.getBoundingClientRect();
		if (rect) {
			const midY = rect.top + rect.height / 2;
			setDropPosition(e.clientY < midY ? 'before' : 'after');
		} else {
			setDropPosition('after');
		}
		setDropTargetId(sessionId);
	}, [draggedItemId]);

	const handleDragLeave = useCallback(() => {
		setDropTargetId(null);
	}, []);

	const handleDrop = useCallback((e: React.DragEvent, targetSessionId: string) => {
		e.preventDefault();
		if (!draggedItemId || draggedItemId === targetSessionId) { return; }

		// Build new order: remove dragged item, insert at drop position
		const newOrder = [...agentSessions];
		const draggedIdx = newOrder.findIndex(s => s.id === draggedItemId);
		const targetIdx = newOrder.findIndex(s => s.id === targetSessionId);
		if (draggedIdx === -1 || targetIdx === -1) { return; }

		const [dragged] = newOrder.splice(draggedIdx, 1);
		let insertIdx = dropPosition === 'before' ? targetIdx : targetIdx + 1;
		// Adjust insertIdx if we removed an item before it
		if (draggedIdx < insertIdx) { insertIdx -= 1; }
		newOrder.splice(insertIdx, 0, dragged);

		// Persist new order
		reorderAgentSessions(newOrder.map(s => s.id));

		setDraggedItemId(null);
		setDropTargetId(null);
	}, [draggedItemId, dropPosition, agentSessions, reorderAgentSessions]);

	const handleDragEnd = useCallback(() => {
		setDraggedItemId(null);
		setDropTargetId(null);
		setDropPosition('after');
	}, []);

	const handleCreateSession = useCallback(() => {
		console.log('[ChatHistoryPage] "+ 新建对话" button clicked');
		const result = createAgentSession();
		// createAgentSession is async — log the resolution outcome too
		Promise.resolve(result)
			.then(() => console.log('[ChatHistoryPage] createAgentSession() resolved'))
			.catch((err) => console.error('[ChatHistoryPage] createAgentSession() rejected:', err));
	}, [createAgentSession]);

	return (
		<div className="chat-history-pane">
			{/* ── Header ────────────────────────────────────────── */}
			<div className="chat-history-header">
				<div className="chat-history-title">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="10" />
						<polyline points="12 6 12 12 16 14" />
					</svg>
					<span>聊天历史</span>
				</div>
				<button className="chat-history-close" onClick={onClose} title="关闭历史面板">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="16" height="16">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			{/* ── Content ───────────────────────────────────── */}
			<div className="chat-history-content">
				{agentSessions.length === 0 ? (
					<div className="chat-history-empty">暂无聊天记录</div>
				) : (
					<div className="chat-history-list">
						{agentSessions.map(session => {
							const isEditing = editingSessionId === session.id;
							const isDeleting = deletingSessionId === session.id;
							const isDragged = draggedItemId === session.id;
							const isDropTarget = dropTargetId === session.id && draggedItemId !== session.id;

							return (
								<div
									key={session.id}
									className={[
										'chat-history-item',
										session.id === activeAgentSessionId ? 'active' : '',
										isEditing ? 'editing' : '',
										isDeleting ? 'deleting' : '',
										isDragged ? 'dragged' : '',
										isDropTarget ? `drop-target drop-${dropPosition}` : '',
									].filter(Boolean).join(' ')}
									draggable={!isEditing && !isDeleting}
									onDragStart={(e) => handleDragStart(e, session.id)}
									onDragOver={(e) => handleDragOver(e, session.id)}
									onDragLeave={handleDragLeave}
									onDrop={(e) => handleDrop(e, session.id)}
									onDragEnd={handleDragEnd}
								>
									{/* Drag handle */}
									{!isEditing && !isDeleting && (
										<div className="chat-history-drag-handle" title="拖拽排序">
											<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" opacity="0.4">
												<circle cx="3" cy="2" r="1.2" />
												<circle cx="7" cy="2" r="1.2" />
												<circle cx="3" cy="5" r="1.2" />
												<circle cx="7" cy="5" r="1.2" />
												<circle cx="3" cy="8" r="1.2" />
												<circle cx="7" cy="8" r="1.2" />
												<circle cx="3" cy="11" r="1.2" />
												<circle cx="7" cy="11" r="1.2" />
											</svg>
										</div>
									)}

									{/* Normal mode: show name + time */}
									{!isEditing && !isDeleting && (
										<>
											<div className="chat-history-item-info" onClick={() => handleSwitchSession(session.id)}>
												<span className="chat-history-item-name">
													{session.name || '新对话'}
													{session.id === activeAgentSessionId && (
														<span className="chat-history-active-badge" title="当前会话">
															<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
																<polyline points="20 6 9 17 4 12" />
															</svg>
														</span>
													)}
												</span>
												<span className="chat-history-item-time">
													{new Date(session.updatedAt).toLocaleDateString()}
												</span>
											</div>
											<div className="chat-history-item-actions">
												<button
													className="chat-history-item-btn"
													title="重命名"
													onClick={(e) => {
														e.stopPropagation();
														startEditing(session);
													}}
												>
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
														<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
														<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
													</svg>
												</button>
												<button
													className="chat-history-item-btn delete-btn"
													title="删除"
													onClick={(e) => {
														e.stopPropagation();
														startDeleteConfirm(session.id);
													}}
												>
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
														<polyline points="3 6 5 6 21 6" />
														<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
													</svg>
												</button>
											</div>
										</>
									)}

									{/* Edit mode: show input */}
									{isEditing && (
										<div className="chat-history-item-edit">
											<input
												ref={editInputRef}
												className="chat-history-edit-input"
												value={editName}
												onChange={(e) => setEditName(e.target.value)}
												onKeyDown={handleEditKeyDown}
												onClick={(e) => e.stopPropagation()}
											/>
											<div className="chat-history-item-edit-actions">
												<button className="chat-history-edit-save" onClick={saveEdit} title="保存">
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
														<polyline points="20 6 9 17 4 12" />
													</svg>
												</button>
												<button className="chat-history-edit-cancel" onClick={cancelEdit} title="取消">
													<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
														<line x1="18" y1="6" x2="6" y2="18" />
														<line x1="6" y1="6" x2="18" y2="18" />
													</svg>
												</button>
											</div>
										</div>
									)}

									{/* Delete confirm mode: show confirm buttons */}
									{isDeleting && (
										<div className="chat-history-item-delete-confirm">
											<span className="chat-history-delete-text">确定删除？</span>
											<div className="chat-history-item-delete-actions">
												<button className="chat-history-delete-confirm-btn" onClick={confirmDelete}>确定</button>
												<button className="chat-history-delete-cancel-btn" onClick={cancelDelete}>取消</button>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* ── Footer ───────────────────────────────────── */}
			<div className="chat-history-footer">
				<button className="chat-history-new-btn" onClick={handleCreateSession}>
					+ 新建对话
				</button>
			</div>
		</div>
	);
}
