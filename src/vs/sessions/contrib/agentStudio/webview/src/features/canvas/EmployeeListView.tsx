/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee List View (alternative to canvas)
 *  Vertical card list of employees with status, role, model info
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';

interface EmployeeListViewProps {
	employees: Employee[];
	selectedEmployeeId: string | null;
	onSelectEmployee: (id: string) => void;
}

const statusConfig: Record<string, { color: string; label: string }> = {
	idle: { color: '#4ade80', label: 'Idle' },
	working: { color: '#3b82f6', label: 'Working' },
	thinking: { color: '#f59e0b', label: 'Thinking' },
	error: { color: '#ef4444', label: 'Error' },
	offline: { color: '#6b7280', label: 'Offline' },
};

export function EmployeeListView({ employees, selectedEmployeeId, onSelectEmployee }: EmployeeListViewProps): React.ReactElement {
	if (employees.length === 0) {
		return (
			<div className="employee-list-empty">
				<p>No agents in this workspace</p>
				<p className="hint">Add agents to get started</p>
			</div>
		);
	}

	return (
		<div className="employee-list-view">
			{employees.map((emp) => {
				const status = statusConfig[emp.status] || statusConfig.offline;
				return (
					<div
						key={emp.id}
						className={`employee-list-card ${emp.id === selectedEmployeeId ? 'selected' : ''}`}
						onClick={() => onSelectEmployee(emp.id)}
					>
						<div className="employee-list-card-left">
							<img
								className="employee-list-avatar"
								src={emp.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${emp.id}`}
								alt={emp.name}
							/>
							<span
								className="employee-list-status"
								style={{ backgroundColor: status.color }}
								title={status.label}
							/>
						</div>
						<div className="employee-list-card-info">
							<div className="employee-list-card-name">{emp.name}</div>
							<div className="employee-list-card-role">{emp.role}</div>
						</div>
						<div className="employee-list-card-right">
							{emp.model && (
								<span className="employee-list-card-model">{emp.model}</span>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}
