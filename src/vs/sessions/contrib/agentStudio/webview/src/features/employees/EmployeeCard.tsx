/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Card (draggable to canvas)
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback } from 'react';
import type { Employee } from '../../store/useEmployeeStore';

interface EmployeeCardProps {
	employee: Employee;
	isSelected: boolean;
	onClick: () => void;
}

export function EmployeeCard({ employee, isSelected, onClick }: EmployeeCardProps): React.ReactElement {
	const handleDragStart = useCallback((e: React.DragEvent) => {
		e.dataTransfer.setData('application/agent-studio-employee', JSON.stringify(employee));
		e.dataTransfer.effectAllowed = 'move';
	}, [employee]);

	const statusColor = {
		idle: '#4ade80',
		working: '#3b82f6',
		thinking: '#f59e0b',
		error: '#ef4444',
		offline: '#6b7280',
	}[employee.status] || '#6b7280';

	return (
		<div
			className={`employee-card ${isSelected ? 'selected' : ''}`}
			onClick={onClick}
			draggable
			onDragStart={handleDragStart}
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
				padding: '8px 12px',
				cursor: 'pointer',
				borderRadius: '4px',
				backgroundColor: isSelected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
				color: isSelected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
			}}
		>
			{/* Status dot */}
			<div style={{
				width: '6px',
				height: '6px',
				borderRadius: '50%',
				backgroundColor: statusColor,
				flexShrink: 0,
			}} />

			{/* Avatar */}
			<img
				src={employee.avatar
					|| (employee.avatarStyle && employee.avatarSeed
						? `https://api.dicebear.com/7.x/${employee.avatarStyle}/svg?seed=${employee.avatarSeed}`
						: `https://api.dicebear.com/7.x/bottts/svg?seed=${employee.id}`)}
				alt=""
				style={{ width: '24px', height: '24px', borderRadius: '50%' }}
			/>

			{/* Info */}
			<div style={{ overflow: 'hidden', flex: 1 }}>
				<div style={{
					fontSize: '12px',
					fontWeight: 500,
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis',
				}}>
					{employee.name}
				</div>
				<div style={{
					fontSize: '10px',
					color: isSelected ? 'inherit' : 'var(--vscode-descriptionForeground)',
					opacity: isSelected ? 0.8 : 1,
				}}>
					{employee.role}
				</div>
			</div>
		</div>
	);
}
