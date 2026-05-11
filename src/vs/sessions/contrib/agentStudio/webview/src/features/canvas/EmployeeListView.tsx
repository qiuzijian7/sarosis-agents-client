// @ts-nocheck
/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee List View (alternative to canvas)
 *  Matching sarosis-webui EmployeeList layout and functionality:
 *  - PM zone / Employee zone separation
 *  - Drag-and-drop reorder with visual indicator (before/after)
 *  - Inline rename (double-click)
 *  - Status dot + label
 *  - PM badge
 *  - Menu button (delete)
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useCallback } from 'react';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';
import { sendRequest } from '../../bridge/messageClient';

// Status configuration matching sarosis-webui STATUS_MAP
const STATUS_MAP: Record<string, { label: string; dot: string; color: string; animated: boolean }> = {
	idle: { label: '空闲', dot: '#9ca3af', color: '#9ca3af', animated: false },
	working: { label: '工作中', dot: '#4ade80', color: '#4ade80', animated: true },
	thinking: { label: '思考中', dot: '#7cb9ff', color: '#7cb9ff', animated: true },
	error: { label: '出错', dot: '#e94560', color: '#e94560', animated: false },
	offline: { label: '离线', dot: 'rgba(255,255,255,0.2)', color: '#6b7280', animated: false },
};

interface EmployeeListViewProps {
	employees: Employee[];
	selectedEmployeeId: string | null;
	onSelectEmployee: (id: string) => void;
	onDeleteEmployee: (id: string) => void;
	onRefresh: () => void;
	workspaceId?: string;
}

export function EmployeeListView({
	employees,
	selectedEmployeeId,
	onSelectEmployee,
	onDeleteEmployee,
	onRefresh,
	workspaceId,
}: EmployeeListViewProps): React.ReactElement {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editName, setEditName] = useState('');
	const [dragSourceId, setDragSourceId] = useState<string | null>(null);
	const [dragOverId, setDragOverId] = useState<string | null>(null);
	const [dragOverSide, setDragOverSide] = useState<'before' | 'after' | null>(null);

	// Separate PM and normal employees
	const pmEmployees = employees.filter(e => e.isPM);
	const normalEmployees = employees.filter(e => !e.isPM);

	const handleStartRename = useCallback((empId: string, currentName: string) => {
		setEditingId(empId);
		setEditName(currentName);
	}, []);

	const handleConfirmRename = useCallback(async (empId: string) => {
		if (!editName.trim()) return;
		try {
			await sendRequest('employees.update', { id: empId, data: { name: editName.trim() } });
			setEditingId(null);
			onRefresh();
		} catch (err) {
			console.error('Failed to rename:', err);
		}
	}, [editName, onRefresh]);

	const handleDragStart = useCallback((e: React.DragEvent, empId: string) => {
		setDragSourceId(empId);
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', empId);
	}, []);

	const handleDragOver = useCallback((e: React.DragEvent, empId: string) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';

		if (!dragSourceId || dragSourceId === empId) return;

		const rect = e.currentTarget.getBoundingClientRect();
		const midY = rect.top + rect.height / 2;
		const side = e.clientY < midY ? 'before' : 'after';

		setDragOverId(empId);
		setDragOverSide(side);
	}, [dragSourceId]);

	const handleDrop = useCallback(async (e: React.DragEvent, targetEmpId: string) => {
		e.preventDefault();
		const sourceId = dragSourceId || e.dataTransfer.getData('text/plain');
		if (!sourceId || sourceId === targetEmpId) return;
		if (!workspaceId) return;

		const sourceEmp = employees.find(e => e.id === sourceId);
		const targetEmp = employees.find(e => e.id === targetEmpId);
		if (!sourceEmp || !targetEmp) return;

		// Cannot reorder across zones
		if (sourceEmp.isPM !== targetEmp.isPM) return;

		// Build new order
		const pmList = employees
			.filter(e => e.isPM)
			.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999))
			.map(e => e.id);

		const normalList = employees
			.filter(e => !e.isPM)
			.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999))
			.map(e => e.id);

		const targetList = sourceEmp.isPM ? pmList : normalList;

		// Remove source, find insert position
		const newList = targetList.filter(id => id !== sourceId);
		const targetIndex = newList.indexOf(targetEmpId);
		const insertIndex = dragOverSide === 'after' ? targetIndex + 1 : targetIndex;
		newList.splice(insertIndex, 0, sourceId);

		// Merge into full order
		const newOrder = sourceEmp.isPM ? [...newList, ...normalList] : [...pmList, ...newList];

		try {
			await sendRequest('workspace.updateLayout', {
				workspaceId,
				employeeOrder: newOrder,
			});
			onRefresh();
		} catch (err) {
			console.error('Failed to reorder:', err);
		}

		setDragSourceId(null);
		setDragOverId(null);
		setDragOverSide(null);
	}, [dragSourceId, dragOverSide, workspaceId, employees, onRefresh]);

	const handleDragEnd = useCallback(() => {
		setDragSourceId(null);
		setDragOverId(null);
		setDragOverSide(null);
	}, []);

	if (employees.length === 0) {
		return (
			<div className="emp-list-empty">
				<div className="emp-list-empty-icon">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
					</svg>
				</div>
				<p className="emp-list-empty-text">还没有员工</p>
				<p className="emp-list-empty-hint">点击"添加员工"按钮创建你的第一个 AI 员工</p>
			</div>
		);
	}

	const renderSection = (title: string, emps: Employee[]) => {
		if (emps.length === 0) return null;

		return (
			<React.Fragment key={title}>
				<div className="emp-list-zone-header">{title}</div>
				{emps.map(emp => (
					<EmployeeListItem
						key={emp.id}
						employee={emp}
						isSelected={emp.id === selectedEmployeeId}
						isEditing={emp.id === editingId}
						editName={editName}
						dragOverSide={dragOverId === emp.id ? dragOverSide : null}
						onSelect={() => onSelectEmployee(emp.id)}
						onDelete={() => onDeleteEmployee(emp.id)}
						onStartRename={() => handleStartRename(emp.id, emp.name)}
						onConfirmRename={() => handleConfirmRename(emp.id)}
						onEditNameChange={setEditName}
						onDragStart={handleDragStart}
						onDragOver={handleDragOver}
						onDrop={handleDrop}
						onDragEnd={handleDragEnd}
					/>
				))}
			</React.Fragment>
		);
	};

	return (
		<div className="emp-list-container">
			{renderSection('PM 专区', pmEmployees)}
			{renderSection('员工专区', normalEmployees)}
		</div>
	);
}

// ── Employee List Item ────────────────────────────────────────────────────

interface EmployeeListItemProps {
	employee: Employee;
	isSelected: boolean;
	isEditing: boolean;
	editName: string;
	dragOverSide: 'before' | 'after' | null;
	onSelect: () => void;
	onDelete: () => void;
	onStartRename: () => void;
	onConfirmRename: () => void;
	onEditNameChange: (name: string) => void;
	onDragStart: (e: React.DragEvent, empId: string) => void;
	onDragOver: (e: React.DragEvent, empId: string) => void;
	onDrop: (e: React.DragEvent, empId: string) => void;
	onDragEnd: () => void;
}

const EmployeeListItem: React.FC<EmployeeListItemProps> = ({
	employee,
	isSelected,
	isEditing,
	editName,
	dragOverSide,
	onSelect,
	onDelete,
	onStartRename,
	onConfirmRename,
	onEditNameChange,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
}) => {
	const statusInfo = STATUS_MAP[employee.status] || STATUS_MAP.idle;
	const avatarUrl = employee.avatar
		|| (employee.avatarStyle && employee.avatarSeed
			? `https://api.dicebear.com/7.x/${employee.avatarStyle}/svg?seed=${employee.avatarSeed}`
			: `https://api.dicebear.com/7.x/bottts/svg?seed=${employee.id}`);

	return (
		<div
			className={`emp-list-item ${isSelected ? 'emp-list-selected' : ''} ${
				dragOverSide === 'before' ? 'emp-list-drag-over-before' : ''
			} ${dragOverSide === 'after' ? 'emp-list-drag-over-after' : ''}`}
			onClick={() => {
				console.warn(`[EmployeeListItem] onClick: employee=${employee.name}(${employee.id})`);
				onSelect();
			}}
			draggable
			onDragStart={(e) => onDragStart(e, employee.id)}
			onDragOver={(e) => onDragOver(e, employee.id)}
			onDrop={(e) => onDrop(e, employee.id)}
			onDragEnd={onDragEnd}
		>
			{/* Drag handle */}
			<div className="emp-list-drag-handle" title="拖拽排序">
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
					<circle cx="9" cy="6" r="1" />
					<circle cx="15" cy="6" r="1" />
					<circle cx="9" cy="12" r="1" />
					<circle cx="15" cy="12" r="1" />
					<circle cx="9" cy="18" r="1" />
					<circle cx="15" cy="18" r="1" />
				</svg>
			</div>

			{/* Avatar */}
			<div className="emp-list-avatar" style={{ background: statusInfo.bg }}>
				<img src={avatarUrl} alt={employee.name} className="emp-list-avatar-img" />
			</div>

			{/* Info */}
			<div className="emp-list-info">
				{isEditing ? (
					<input
						type="text"
						value={editName}
						onChange={(e) => onEditNameChange(e.target.value)}
						onBlur={onConfirmRename}
						onKeyDown={(e) => e.key === 'Enter' && onConfirmRename()}
						className="emp-list-rename-input"
						autoFocus
						onClick={(e) => e.stopPropagation()}
					/>
				) : (
					<div className="emp-list-name" onDoubleClick={onStartRename}>
						{employee.name}
						{employee.isPM && (
							<span className="emp-pm-badge active" title="项目经理">PM</span>
						)}
					</div>
				)}
				<div className="emp-list-role">{employee.role}</div>
			</div>

			{/* Status */}
			<div className="emp-list-status">
				<span className={`emp-status-dot ${statusInfo.animated ? 'emp-dot-animated' : ''}`} style={{ background: statusInfo.dot }} />
				<span className="emp-status-label" style={{ color: statusInfo.color }}>{statusInfo.label}</span>
			</div>

			{/* Menu button */}
			<button
				className="emp-list-menu-btn"
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
			>
				⋯
			</button>
		</div>
	);
};

export default EmployeeListView;
