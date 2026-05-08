/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Workspace Toolbar (Title Bar)
 *  Contains: workspace dropdown selector, employee count, view mode toggle, actions
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';

// Icons
const ChevronDown = () => (
	<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
		<path d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
	</svg>
);
const GridIcon = () => (
	<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
		<path d="M2 2h5v5H2V2zm7 0h5v5H9V2zM2 9h5v5H2V9zm7 0h5v5H9V9z" opacity="0.85" />
	</svg>
);
const ListIcon = () => (
	<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
		<path d="M2 3h12v1H2V3zm0 4h12v1H2V7zm0 4h12v1H2v-1z" />
	</svg>
);
const AddIcon = () => (
	<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
		<path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z" />
	</svg>
);
const RefreshIcon = () => (
	<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
		<path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.528 1.228.528 1.934 0 2.136-1.731 3.866-3.866 3.866-2.136 0-3.866-1.731-3.866-3.866 0-1.899 1.37-3.476 3.172-3.8V5.07l3.5-2.07-3.5-2.07v1.318C5.034 2.674 3.2 4.82 3.2 7.51c0 2.92 2.37 5.29 5.29 5.29 2.92 0 5.29-2.37 5.29-5.29 0-.684-.13-1.338-.329-1.901z" />
	</svg>
);

export type ViewMode = 'canvas' | 'list';

interface WorkspaceToolbarProps {
	viewMode: ViewMode;
	onViewModeChange: (mode: ViewMode) => void;
	onAddEmployee: () => void;
	onRefresh: () => void;
}

export function WorkspaceToolbar({ viewMode, onViewModeChange, onAddEmployee, onRefresh }: WorkspaceToolbarProps): React.ReactElement {
	const { workspaces, activeWorkspaceId, setActiveWorkspace, loadWorkspaces } = useWorkspaceStore();
	const { employees } = useEmployeeStore();
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

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
			}
		};
		if (isDropdownOpen) {
			document.addEventListener('mousedown', handleClickOutside);
		}
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [isDropdownOpen]);

	const handleSelectWorkspace = useCallback((id: string) => {
		setActiveWorkspace(id);
		setIsDropdownOpen(false);
	}, [setActiveWorkspace]);

	return (
		<div className="toolbar">
			{/* Left side: workspace selector */}
			<div className="toolbar-left">
				<button
					ref={buttonRef}
					className="workspace-selector"
					onClick={() => setIsDropdownOpen(!isDropdownOpen)}
					title="Select workspace"
				>
					<span className="workspace-selector-icon">🏢</span>
					<span className="workspace-selector-name">
						{currentWorkspace?.name || 'Select Workspace'}
					</span>
					<ChevronDown />
				</button>

				{employeeCount > 0 && (
					<span className="toolbar-badge">{employeeCount} agents</span>
				)}
			</div>

			{/* Right side: actions */}
			<div className="toolbar-right">
				<button
					className={`toolbar-btn ${viewMode === 'canvas' ? 'active' : ''}`}
					onClick={() => onViewModeChange('canvas')}
					title="Canvas view"
				>
					<GridIcon />
				</button>
				<button
					className={`toolbar-btn ${viewMode === 'list' ? 'active' : ''}`}
					onClick={() => onViewModeChange('list')}
					title="List view"
				>
					<ListIcon />
				</button>
				<div className="toolbar-divider" />
				<button className="toolbar-btn" onClick={onAddEmployee} title="Add agent">
					<AddIcon />
				</button>
				<button className="toolbar-btn" onClick={onRefresh} title="Refresh">
					<RefreshIcon />
				</button>
			</div>

			{/* Dropdown */}
			{isDropdownOpen && (
				<div className="workspace-dropdown" ref={dropdownRef}>
					<div className="dropdown-header">Workspaces</div>
					{workspaces.length === 0 && (
						<div className="dropdown-empty">No workspaces</div>
					)}
					{workspaces.map(ws => (
						<div
							key={ws.id}
							className={`dropdown-item ${ws.id === activeWorkspaceId ? 'active' : ''}`}
							onClick={() => handleSelectWorkspace(ws.id)}
						>
							<span className="dropdown-item-icon">📁</span>
							<span className="dropdown-item-name">{ws.name}</span>
							{ws.id === activeWorkspaceId && (
								<span className="dropdown-item-check">✓</span>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
