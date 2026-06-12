/*---------------------------------------------------------------------------------------------
 *  WorkflowListPanel — workflow list with drag-and-drop sorting.
 *
 *  Styling: reuses .emp-list-* CSS classes from globals.css
 *  DnD: native HTML5 Drag and Drop (same pattern as ChatHistoryPage)
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useCallback, useEffect } from 'react';
import { sendRequest } from '../../bridge/messageClient';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

interface WorkflowInfo {
	id: string;
	name: string;
	agentId?: string;
	agentName?: string;
	updatedAt?: string;
}

export const WorkflowListPanel: React.FC<{
	activeWorkflowId?: string | null;
	onSelectWorkflow: (workflowId: string) => void;
}> = ({ activeWorkflowId, onSelectWorkflow }) => {
	const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

	// Drag state
	const [draggedId, setDraggedId] = useState<string | null>(null);
	const [dropTargetId, setDropTargetId] = useState<string | null>(null);
	const [dropPosition, setDropPosition] = useState<'before' | 'after'>('after');

	// Load workflows
	const loadWorkflows = useCallback(async () => {
		setLoading(true);
		try {
			const result = await sendRequest<{ workspaceId?: string }, { workflows: WorkflowInfo[] }>(
				'workflow.list',
				{ workspaceId: activeWorkspaceId ?? undefined },
			);
			setWorkflows(result?.workflows ?? []);
		} catch (err) {
			console.error('[WorkflowListPanel] Failed to load workflows:', err);
		} finally {
			setLoading(false);
		}
	}, [activeWorkspaceId]);

	useEffect(() => {
		loadWorkflows();
	}, [loadWorkflows]);

	// Listen for workflow list changes from host
	useEffect(() => {
		const handler = () => { loadWorkflows(); };
		window.addEventListener('agentStudio:workflows-changed', handler);
		return () => window.removeEventListener('agentStudio:workflows-changed', handler);
	}, [loadWorkflows]);

	// Filter
	const filtered = searchQuery
		? workflows.filter(w =>
			w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			(w.agentName ?? '').toLowerCase().includes(searchQuery.toLowerCase())
		)
		: workflows;

	// ── Drag handlers ──
	const handleDragStart = useCallback((e: React.DragEvent, workflowId: string) => {
		setDraggedId(workflowId);
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', workflowId);
		(e.currentTarget as HTMLElement).classList.add('emp-list-dragging');
	}, []);

	const handleDragEnd = useCallback((e: React.DragEvent) => {
		(e.currentTarget as HTMLElement).classList.remove('emp-list-dragging');
		setDraggedId(null);
		setDropTargetId(null);
	}, []);

	const handleDragOver = useCallback((e: React.DragEvent, workflowId: string) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		if (workflowId === draggedId) { return; }

		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const midY = rect.top + rect.height / 2;
		const pos = e.clientY < midY ? 'before' : 'after';
		setDropPosition(pos);
		setDropTargetId(workflowId);
	}, [draggedId]);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const { clientX, clientY } = e;
		if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
			if (dropTargetId === el.getAttribute('data-wf-id')) {
				setDropTargetId(null);
			}
		}
	}, [dropTargetId]);

	const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
		e.preventDefault();
		if (!draggedId || draggedId === targetId) {
			setDraggedId(null);
			setDropTargetId(null);
			return;
		}

		const current = [...workflows];
		const draggedIdx = current.findIndex(w => w.id === draggedId);
		let targetIdx = current.findIndex(w => w.id === targetId);
		if (draggedIdx === -1 || targetIdx === -1) {
			setDraggedId(null);
			setDropTargetId(null);
			return;
		}

		// Remove dragged item
		const [dragged] = current.splice(draggedIdx, 1);
		// Adjust target index
		if (dropPosition === 'after') { targetIdx += 1; }
		if (draggedIdx < targetIdx) { targetIdx -= 1; }
		// Insert at target
		current.splice(targetIdx, 0, dragged);

		setWorkflows(current);
		setDraggedId(null);
		setDropTargetId(null);

		// Persist new order
		const orderedIds = current.map(w => w.id);
		sendRequest('workflow.reorder', { orderedIds }).catch(err => {
			console.error('[WorkflowListPanel] Failed to persist reorder:', err);
		});
	}, [draggedId, dropPosition, workflows]);

	return (
		<div className="emp-list-container" style={{ padding: '8px' }}>
			{/* Search */}
			<div style={{ marginBottom: '8px' }}>
				<input
					type="text"
					value={searchQuery}
					onChange={e => setSearchQuery(e.target.value)}
					placeholder="Search workflows..."
					style={{
						width: '100%', padding: '4px 8px', fontSize: '11px',
						background: 'var(--vscode-input-background)',
						color: 'var(--vscode-input-foreground)',
						border: '1px solid var(--vscode-input-border)',
						borderRadius: '4px', boxSizing: 'border-box',
					}}
				/>
			</div>

			{/* List */}
			{loading && filtered.length === 0 ? (
				<div style={{ padding: '16px', textAlign: 'center', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					Loading...
				</div>
			) : filtered.length === 0 ? (
				<div style={{ padding: '16px', textAlign: 'center', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
					{searchQuery ? 'No matching workflows' : 'No workflows yet'}
				</div>
			) : (
				filtered.map(wf => {
					const isActive = wf.id === activeWorkflowId;
					const isDragged = wf.id === draggedId;
					const isDropTarget = wf.id === dropTargetId;

					let dropClass = '';
					if (isDropTarget) {
						dropClass = dropPosition === 'before'
							? 'emp-list-drag-over-before'
							: 'emp-list-drag-over-after';
					}

					return (
						<div
							key={wf.id}
							data-wf-id={wf.id}
							className={[
								'emp-list-item',
								isActive ? 'emp-list-selected' : '',
								isDragged ? 'emp-list-dragging' : '',
								dropClass,
							].filter(Boolean).join(' ')}
							draggable
							onDragStart={(e) => handleDragStart(e, wf.id)}
							onDragEnd={handleDragEnd}
							onDragOver={(e) => handleDragOver(e, wf.id)}
							onDragLeave={handleDragLeave}
							onDrop={(e) => handleDrop(e, wf.id)}
							onClick={() => onSelectWorkflow(wf.id)}
							style={{ cursor: 'pointer' }}
						>
							{/* Drag handle */}
							<div
								className="emp-list-drag-handle"
								onMouseDown={e => e.stopPropagation()}
								title="Drag to reorder"
							>
								<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" opacity="0.5">
									<circle cx="2" cy="2" r="1.2" />
									<circle cx="8" cy="2" r="1.2" />
									<circle cx="2" cy="7" r="1.2" />
									<circle cx="8" cy="7" r="1.2" />
									<circle cx="2" cy="12" r="1.2" />
									<circle cx="8" cy="12" r="1.2" />
								</svg>
							</div>

							{/* Workflow icon */}
							<div className="emp-list-avatar" style={{ backgroundColor: 'var(--vscode-badge-background)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
								<span style={{ fontSize: '16px' }}>⚡</span>
							</div>

							{/* Info */}
							<div className="emp-list-info">
								<div className="emp-list-name">{wf.name || 'Untitled'}</div>
								{wf.agentName && (
									<div className="emp-list-role">{wf.agentName}</div>
								)}
							</div>
						</div>
					);
				})
			)}

			{/* Refresh button */}
			<div style={{ marginTop: '8px', textAlign: 'center' }}>
				<button
					onClick={loadWorkflows}
					style={{
						fontSize: '10px', padding: '2px 8px',
						background: 'var(--vscode-button-secondaryBackground)',
						color: 'var(--vscode-button-secondaryForeground)',
						border: 'none', borderRadius: '3px', cursor: 'pointer',
					}}
				>
					↻ Refresh
				</button>
			</div>
		</div>
	);
};
