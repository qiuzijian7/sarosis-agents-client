/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Workspace Sidebar
 *  Tree-style sidebar: workspaces as collapsible groups, employees as items.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useCallback } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';

// Icons as inline SVG for zero-dependency rendering
const ChevronDown = () => (
	<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
		<path d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
	</svg>
);
const ChevronRight = () => (
	<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
		<path d="M5.928 7.976l4.357-4.357.618.62L6.547 8.594v-.618L10.903 12.333l-.618.619L5.928 8.594v-.618z" />
	</svg>
);
const AddIcon = () => (
	<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
		<path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z" />
	</svg>
);

interface WorkspaceGroupProps {
	workspace: { id: string; name: string; description?: string };
	employees: Employee[];
	isActive: boolean;
	isExpanded: boolean;
	onToggle: () => void;
	onSelect: () => void;
	selectedEmployeeId: string | null;
	onSelectEmployee: (id: string) => void;
}

function WorkspaceGroup({
	workspace,
	employees,
	isActive,
	isExpanded,
	onToggle,
	onSelect,
	selectedEmployeeId,
	onSelectEmployee,
}: WorkspaceGroupProps): React.ReactElement {
	const statusColor: Record<string, string> = {
		idle: '#4ade80',
		working: '#3b82f6',
		thinking: '#f59e0b',
		error: '#ef4444',
		offline: '#6b7280',
	};

	return (
		<div className="workspace-group">
			{/* Workspace header */}
			<div
				className={`workspace-header ${isActive ? 'active' : ''}`}
				onClick={() => { onSelect(); onToggle(); }}
			>
				<span className="workspace-chevron">
					{isExpanded ? <ChevronDown /> : <ChevronRight />}
				</span>
				<span className="workspace-icon">📁</span>
				<span className="workspace-name">{workspace.name}</span>
				<span className="workspace-count">{employees.length}</span>
			</div>

			{/* Employee items */}
			{isExpanded && (
				<div className="workspace-employees">
					{employees.map((emp) => (
						<div
							key={emp.id}
							className={`employee-item ${emp.id === selectedEmployeeId ? 'selected' : ''}`}
							onClick={() => onSelectEmployee(emp.id)}
						>
							<span
								className="employee-status-dot"
								style={{ backgroundColor: statusColor[emp.status] || '#6b7280' }}
							/>
							<img
								className="employee-avatar"
								src={emp.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${emp.id}`}
								alt=""
							/>
							<div className="employee-info">
								<span className="employee-name">{emp.name}</span>
								<span className="employee-role">{emp.role}</span>
							</div>
						</div>
					))}
					{employees.length === 0 && (
						<div className="empty-hint">No agents in this workspace</div>
					)}
				</div>
			)}
		</div>
	);
}

export function WorkspaceSidebar(): React.ReactElement {
	const { workspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
	const { employees, selectedEmployeeId, selectEmployee, searchQuery, setSearchQuery } = useEmployeeStore();
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

	// Auto-expand active workspace
	React.useEffect(() => {
		if (activeWorkspaceId && !expandedIds.has(activeWorkspaceId)) {
			setExpandedIds(prev => new Set([...prev, activeWorkspaceId]));
		}
	}, [activeWorkspaceId]);

	const toggleExpand = useCallback((id: string) => {
		setExpandedIds(prev => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const handleSelectEmployee = useCallback((empId: string) => {
		selectEmployee(empId);
	}, [selectEmployee]);

	// Group employees by workspace
	const getEmployeesForWorkspace = (wsId: string): Employee[] => {
		let filtered = employees.filter(e => e.workspaceId === wsId);
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			filtered = filtered.filter(e =>
				e.name.toLowerCase().includes(q) || e.role.toLowerCase().includes(q)
			);
		}
		return filtered;
	};

	// Employees not assigned to any workspace
	const unassignedEmployees = (() => {
		let filtered = employees.filter(e => !e.workspaceId);
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			filtered = filtered.filter(e =>
				e.name.toLowerCase().includes(q) || e.role.toLowerCase().includes(q)
			);
		}
		return filtered;
	})();

	return (
		<div className="workspace-sidebar">
			{/* Header */}
			<div className="sidebar-header">
				<span className="sidebar-title">Workspaces</span>
				<button className="sidebar-action" title="New Workspace">
					<AddIcon />
				</button>
			</div>

			{/* Search */}
			<div className="sidebar-search">
				<input
					type="text"
					className="search-input"
					placeholder="Search agents..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
				/>
			</div>

			{/* Workspace tree */}
			<div className="sidebar-tree">
				{workspaces.map((ws) => (
					<WorkspaceGroup
						key={ws.id}
						workspace={ws}
						employees={getEmployeesForWorkspace(ws.id)}
						isActive={ws.id === activeWorkspaceId}
						isExpanded={expandedIds.has(ws.id)}
						onToggle={() => toggleExpand(ws.id)}
						onSelect={() => setActiveWorkspace(ws.id)}
						selectedEmployeeId={selectedEmployeeId}
						onSelectEmployee={handleSelectEmployee}
					/>
				))}

				{/* Unassigned employees */}
				{unassignedEmployees.length > 0 && (
					<WorkspaceGroup
						workspace={{ id: '__unassigned__', name: 'Unassigned' }}
						employees={unassignedEmployees}
						isActive={false}
						isExpanded={expandedIds.has('__unassigned__')}
						onToggle={() => toggleExpand('__unassigned__')}
						onSelect={() => {}}
						selectedEmployeeId={selectedEmployeeId}
						onSelectEmployee={handleSelectEmployee}
					/>
				)}

				{/* Empty state */}
				{workspaces.length === 0 && employees.length === 0 && (
					<div className="sidebar-empty">
						<p>No workspaces yet</p>
						<p className="sidebar-empty-hint">Create a workspace to get started</p>
					</div>
				)}
			</div>
		</div>
	);
}
