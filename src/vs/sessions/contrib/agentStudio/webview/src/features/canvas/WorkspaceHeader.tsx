/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Workspace Header
 *  Positioned inside the editor area, below the toolbar.
 *  Contains: workspace selector dropdown + employee count badge + view mode toggle
 *  Dropdown includes: current workspace info, workspace list, create new workspace
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { WorktreeBadge } from './WorktreeBadge';
import { sendRequest } from '../../bridge/messageClient';

export type ViewMode = 'canvas' | 'list' | 'html';

interface WorkspaceHeaderProps {
	viewMode: ViewMode;
	onViewModeChange: (mode: ViewMode) => void;
	selectedAgentId?: string | null;
	onSelectedAgentIdChange?: (agentId: string | null) => void;
}

export function WorkspaceHeader({
	viewMode,
	onViewModeChange,
	selectedAgentId,
	onSelectedAgentIdChange,
}: WorkspaceHeaderProps): React.ReactElement {
	const { workspaces, activeWorkspaceId, setActiveWorkspace, createWorkspace, createWorkspaceWithWorktree } = useWorkspaceStore();
	const { employees } = useEmployeeStore();
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
	const [isCreating, setIsCreating] = useState(false);
	const [newWorkspaceName, setNewWorkspaceName] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const [isHtmlDropdownOpen, setIsHtmlDropdownOpen] = useState(false);
	const [htmlViewAgents, setHtmlViewAgents] = useState<Array<{ id: string; name: string; role: string; workspaceId: string }>>([]);

	const currentWorkspace = workspaces.find(w => w.id === activeWorkspaceId);
	const employeeCount = employees.filter(e => e.workspaceId === activeWorkspaceId).length;

	// Close dropdown on outside click
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (
				dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
				buttonRef.current && !buttonRef.current.contains(e.target as Node)
			) {
				setIsDropdownOpen(false);
				setIsCreating(false);
				setNewWorkspaceName('');
			}
		};
		if (isDropdownOpen) {
			document.addEventListener('mousedown', handleClickOutside);
		}
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [isDropdownOpen]);

	// Calculate dropdown position
	useEffect(() => {
		if (isDropdownOpen && buttonRef.current) {
			const btn = buttonRef.current;
			const rect = btn.getBoundingClientRect();
			const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
			const margin = 4;

			const MIN_DROPDOWN_W = 320;
			const MAX_DROPDOWN_W = Math.min(vw - 16, 480);
			const btnW = Math.round(rect.width);
			const wantW = Math.max(MIN_DROPDOWN_W, Math.min(MAX_DROPDOWN_W, btnW));

			let left = rect.left;
			if (left + wantW > vw - 8) {
				left = Math.max(8, rect.right - wantW);
			}

			setDropdownPosition({
				top: rect.bottom + margin,
				left: left,
				width: wantW,
			});
		}
	}, [isDropdownOpen]);

	// Focus input when entering create mode
	useEffect(() => {
		if (isCreating && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isCreating]);

	// Load agents with config.md when HTML dropdown opens
	useEffect(() => {
		if (isHtmlDropdownOpen) {
			const loadAgents = async () => {
				try {
					const result = await sendRequest('configmd.listAgents', {});
					setHtmlViewAgents((result as any) || []);
				} catch (err) {
					console.error('Failed to load agents with config.md:', err);
					setHtmlViewAgents([]);
				}
			};
			void loadAgents();
		}
	}, [isHtmlDropdownOpen]);

	const toggleDropdown = useCallback(() => {
		setIsDropdownOpen(prev => !prev);
		if (isDropdownOpen) {
			setIsCreating(false);
			setNewWorkspaceName('');
		}
	}, [isDropdownOpen]);

	const handleSelectWorkspace = useCallback((id: string) => {
		setActiveWorkspace(id);
		setIsDropdownOpen(false);
		setIsCreating(false);
		setNewWorkspaceName('');
	}, [setActiveWorkspace]);

	const handleStartCreate = useCallback(() => {
		setIsCreating(true);
		setNewWorkspaceName('');
	}, []);

	const handleCancelCreate = useCallback(() => {
		setIsCreating(false);
		setNewWorkspaceName('');
	}, []);

	const handleSubmitCreate = useCallback(async () => {
		const name = newWorkspaceName.trim();
		if (!name || isSubmitting) return;

		setIsSubmitting(true);
		try {
			const newId = await createWorkspace(name);
			if (newId) {
				setIsDropdownOpen(false);
				setIsCreating(false);
				setNewWorkspaceName('');
			}
		} finally {
			setIsSubmitting(false);
		}
	}, [newWorkspaceName, isSubmitting, createWorkspace]);

	const handleCreateKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleSubmitCreate();
		} else if (e.key === 'Escape') {
			handleCancelCreate();
		}
	}, [handleSubmitCreate, handleCancelCreate]);

	return (
		<div className="workspace-header">
			{/* Left: workspace selector */}
			<div className="ws-header-left">
				<svg className="ws-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
				</svg>

				<button
					ref={buttonRef}
					onClick={toggleDropdown}
					className="ws-header-select-btn"
				>
					<span className="ws-header-select-label">
						{currentWorkspace?.name || '选择工作区...'}
					</span>
					<svg className={`ws-header-chevron ${isDropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
					</svg>
				</button>

				{/* Dropdown */}
				{isDropdownOpen && (
					<div
						ref={dropdownRef}
						className="ws-header-dropdown"
						style={{
							top: `${dropdownPosition.top}px`,
							left: `${dropdownPosition.left}px`,
							width: `${dropdownPosition.width}px`,
							minWidth: `${dropdownPosition.width}px`,
							maxWidth: `${dropdownPosition.width}px`,
						}}
					>
						{currentWorkspace && (
							<>
								<div className="ws-hd-current-header">
									<div className="ws-hd-current-label">当前工作区</div>
									<div className="ws-hd-current-name">{currentWorkspace.name}</div>
								</div>
								<div className="ws-hd-divider" />
							</>
						)}

						{/* Workspace list */}
						<div className="ws-hd-list">
							{workspaces.map((ws) => (
								<div
									key={ws.id}
									className={`ws-hd-opt ${ws.id === activeWorkspaceId ? 'active' : ''}`}
									onClick={() => handleSelectWorkspace(ws.id)}
								>
									<div className="ws-hd-opt-info">
										<span className="ws-hd-opt-name">{ws.name}</span>
										{ws.worktreeBranch && (
											<span className="ws-hd-opt-worktree-branch">
												🌿 {ws.worktreeBranch}
											</span>
										)}
										{ws.worktreeStatus === 'pending' && (
											<span className="ws-hd-opt-worktree-status pending">⏳</span>
										)}
										{ws.worktreeStatus === 'failed' && (
											<span className="ws-hd-opt-worktree-status failed">❌</span>
										)}
									</div>
									{ws.id === activeWorkspaceId && (
										<svg className="ws-hd-opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
										</svg>
									)}
								</div>
							))}
						</div>

						<div className="ws-hd-divider" />

						{/* Create workspace section */}
						{isCreating ? (
							<div className="ws-hd-create-form">
								<input
									ref={inputRef}
									type="text"
									className="ws-hd-create-input"
									placeholder="输入工作区名称..."
									value={newWorkspaceName}
									onChange={(e) => setNewWorkspaceName(e.target.value)}
									onKeyDown={handleCreateKeyDown}
									disabled={isSubmitting}
									maxLength={50}
								/>
								<div className="ws-hd-create-actions">
									<button
										className="ws-hd-create-btn ws-hd-create-confirm"
										onClick={handleSubmitCreate}
										disabled={!newWorkspaceName.trim() || isSubmitting}
										title="确认创建"
									>
										{isSubmitting ? (
											<span className="ws-hd-spinner" />
										) : (
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
												<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
											</svg>
										)}
									</button>
									<button
										className="ws-hd-create-btn ws-hd-create-cancel"
										onClick={handleCancelCreate}
										disabled={isSubmitting}
										title="取消"
									>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
										</svg>
									</button>
								</div>
							</div>
						) : (
							<>
								<div
									className="ws-hd-opt ws-hd-opt-action"
									onClick={handleStartCreate}
								>
									<svg className="ws-hd-opt-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
									</svg>
									<span className="ws-hd-opt-name">创建新工作区</span>
								</div>
								<div
									className="ws-hd-opt ws-hd-opt-action"
									onClick={() => {
										// Quick create with isolated worktree
										const name = `工作区 ${workspaces.length + 1}`;
										void createWorkspaceWithWorktree(name, { mode: 'create' });
										setIsDropdownOpen(false);
									}}
								>
									<svg className="ws-hd-opt-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
									</svg>
									<span className="ws-hd-opt-name">🌿 隔离 Worktree 工作区</span>
								</div>
							</>
						)}
					</div>
				)}

				{/* Employee count */}
				<div className="ws-header-emp-count">
					<svg className="ws-header-emp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
					</svg>
					<span className="ws-header-emp-text">{employeeCount}</span>
				</div>

				{/* Worktree badge */}
				{currentWorkspace && (
					<WorktreeBadge
						status={currentWorkspace.worktreeStatus ?? 'none'}
						branch={currentWorkspace.worktreeBranch}
						directory={currentWorkspace.worktreePath}
					/>
				)}
			</div>

			{/* Right: view mode toggle */}
			<div className="ws-header-right">
				<button
					className={`ws-header-mode-btn ${viewMode === 'canvas' ? 'active' : ''}`}
					onClick={() => onViewModeChange('canvas')}
					title="画布视图"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
					</svg>
				</button>
				<button
					className={`ws-header-mode-btn ${viewMode === 'list' ? 'active' : ''}`}
					onClick={() => onViewModeChange('list')}
					title="列表视图"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
					</svg>
				</button>
				{/* HTML view button with dropdown */}
				<div className="ws-header-html-view-group">
					<button
						className={`ws-header-mode-btn ${viewMode === 'html' ? 'active' : ''}`}
						onClick={() => onViewModeChange('html')}
						title="HTML 视图"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 2v6h6" />
						</svg>
					</button>
					<button
						className="ws-header-html-dropdown-btn"
						onClick={(e) => {
							e.stopPropagation();
							setIsHtmlDropdownOpen(!isHtmlDropdownOpen);
						}}
						title="选择 Agent"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" />
						</svg>
					</button>
				</div>
				{isHtmlDropdownOpen && (
					<div className="ws-header-html-dropdown">
						{htmlViewAgents.map(agent => (
							<div
								key={agent.id}
								className="ws-header-html-dropdown-item"
								onClick={() => {
									onViewModeChange('html');
									onSelectedAgentIdChange?.(agent.id);
									setIsHtmlDropdownOpen(false);
								}}
							>
								{agent.name} ({agent.role})
							</div>
						))}
						{htmlViewAgents.length === 0 && (
							<div className="ws-header-html-dropdown-empty">没有配置 config.md 的 Agent</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
