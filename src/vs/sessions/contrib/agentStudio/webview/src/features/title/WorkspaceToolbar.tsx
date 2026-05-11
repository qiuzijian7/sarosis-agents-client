/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Workspace Toolbar (Title Bar)
 *  Contains: workspace selector dropdown (with create) + action buttons (add, export, import, refresh).
 *  This is the top-level fixed header visible across all tabs (Chat, Task, Canvas).
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';

interface WorkspaceToolbarProps {
	onAddEmployee: () => void;
	onRefresh: () => void;
	onExport?: () => void;
	onImport?: () => void;
}

export function WorkspaceToolbar({
	onAddEmployee,
	onRefresh,
	onExport,
	onImport,
}: WorkspaceToolbarProps): React.ReactElement {
	const { workspaces, activeWorkspaceId, setActiveWorkspace, createWorkspace } = useWorkspaceStore();
	const { employees } = useEmployeeStore();
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
	const [isCreating, setIsCreating] = useState(false);
	const [newWorkspaceName, setNewWorkspaceName] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

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
		<div className="workspace-toolbar">
			{/* Left: workspace selector */}
			<div className="toolbar-left">
				<svg className="toolbar-ws-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
				</svg>

				<button
					ref={buttonRef}
					onClick={toggleDropdown}
					className="toolbar-ws-select-btn"
				>
					<span className="toolbar-ws-select-label">
						{currentWorkspace?.name || '选择工作区...'}
					</span>
					<svg className={`toolbar-ws-chevron ${isDropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
					</svg>
				</button>

				{/* Employee count badge */}
				<div className="toolbar-ws-emp-count">
					<svg className="toolbar-ws-emp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
					</svg>
					<span className="toolbar-ws-emp-text">{employeeCount}</span>
				</div>

				{/* Dropdown */}
				{isDropdownOpen && (
					<div
						ref={dropdownRef}
						className="toolbar-ws-dropdown"
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
								<div className="toolbar-ws-dd-current">
									<div className="toolbar-ws-dd-current-label">当前工作区</div>
									<div className="toolbar-ws-dd-current-name">{currentWorkspace.name}</div>
								</div>
								<div className="toolbar-ws-dd-divider" />
							</>
						)}

						{/* Workspace list */}
						<div className="toolbar-ws-dd-list">
							{workspaces.map((ws) => (
								<div
									key={ws.id}
									className={`toolbar-ws-dd-opt ${ws.id === activeWorkspaceId ? 'active' : ''}`}
									onClick={() => handleSelectWorkspace(ws.id)}
								>
									<div className="toolbar-ws-dd-opt-info">
										<span className="toolbar-ws-dd-opt-name">{ws.name}</span>
									</div>
									{ws.id === activeWorkspaceId && (
										<svg className="toolbar-ws-dd-opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
										</svg>
									)}
								</div>
							))}
						</div>

						<div className="toolbar-ws-dd-divider" />

						{/* Create workspace section */}
						{isCreating ? (
							<div className="toolbar-ws-dd-create-form">
								<input
									ref={inputRef}
									type="text"
									className="toolbar-ws-dd-create-input"
									placeholder="输入工作区名称..."
									value={newWorkspaceName}
									onChange={(e) => setNewWorkspaceName(e.target.value)}
									onKeyDown={handleCreateKeyDown}
									disabled={isSubmitting}
									maxLength={50}
								/>
								<div className="toolbar-ws-dd-create-actions">
									<button
										className="toolbar-ws-dd-create-btn toolbar-ws-dd-create-confirm"
										onClick={handleSubmitCreate}
										disabled={!newWorkspaceName.trim() || isSubmitting}
										title="确认创建"
									>
										{isSubmitting ? (
											<span className="toolbar-ws-dd-spinner" />
										) : (
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
												<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
											</svg>
										)}
									</button>
									<button
										className="toolbar-ws-dd-create-btn toolbar-ws-dd-create-cancel"
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
							<div
								className="toolbar-ws-dd-opt toolbar-ws-dd-opt-action"
								onClick={handleStartCreate}
							>
								<svg className="toolbar-ws-dd-opt-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
								</svg>
								<span className="toolbar-ws-dd-opt-name">创建新工作区</span>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Right: actions */}
			<div className="toolbar-right">
				{/* Add employee */}
				<button
					className="toolbar-btn toolbar-btn-primary"
					onClick={onAddEmployee}
					title="添加员工到画布"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
					</svg>
					<span className="toolbar-btn-label">添加员工</span>
				</button>

				{/* Refresh */}
				<button className="toolbar-btn" onClick={onRefresh} title="刷新">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
					</svg>
				</button>

				<div className="toolbar-divider" />

				{/* Export */}
				{onExport && (
					<button className="toolbar-btn" onClick={onExport} title="导出工作区">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
						</svg>
					</button>
				)}

				{/* Import */}
				{onImport && (
					<button className="toolbar-btn" onClick={onImport} title="导入工作区">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
						</svg>
					</button>
				)}
			</div>
		</div>
	);
}
