/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Node (ReactFlow custom node)
 *  Vertical card layout matching sarosis-webui EmployeeNode style:
 *  Avatar (top) → Name + Role → Model badge → Skills/Token tags (bottom)
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useState, useRef, useEffect } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Employee } from '../../store/useEmployeeStore';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { openAgentConfigMd, previewAgentConfigMd } from '../../bridge/fileBridge';

interface EmployeeNodeData {
	employee: Employee;
	isSelected?: boolean;
	onSelect?: (empId: string) => void;
	onDelete?: (empId: string) => void;
}

// Status color/style configuration matching sarosis-webui STATUS_MAP
const STATUS_MAP: Record<string, { label: string; color: string; bg: string; dot: string; animated: boolean }> = {
	idle: { label: '空闲', color: '#9ca3af', bg: 'rgba(255,255,255,0.05)', dot: '#9ca3af', animated: false },
	working: { label: '工作中', color: '#4ade80', bg: 'rgba(74,222,128,0.08)', dot: '#4ade80', animated: true },
	thinking: { label: '思考中', color: '#7cb9ff', bg: 'rgba(124,185,255,0.08)', dot: '#7cb9ff', animated: true },
	error: { label: '出错', color: '#e94560', bg: 'rgba(233,69,96,0.08)', dot: '#e94560', animated: false },
	offline: { label: '离线', color: '#6b7280', bg: 'rgba(255,255,255,0.02)', dot: 'rgba(255,255,255,0.2)', animated: false },
};

function EmployeeNodeComponent({ data }: NodeProps & { data: EmployeeNodeData }): React.ReactElement {
	const { employee, isSelected, onSelect, onDelete } = data;
	const [imgError, setImgError] = useState(false);
	const [isEditingName, setIsEditingName] = useState(false);
	const [editName, setEditName] = useState(employee.name);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const statusInfo = STATUS_MAP[employee.status] || STATUS_MAP.idle;

	// Focus input when entering edit mode
	useEffect(() => {
		if (isEditingName && nameInputRef.current) {
			nameInputRef.current.focus();
			nameInputRef.current.select();
		}
	}, [isEditingName]);

	// Sync editName when employee.name changes externally
	useEffect(() => {
		if (!isEditingName) {
			setEditName(employee.name);
		}
	}, [employee.name, isEditingName]);

	const handleNameDoubleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		setEditName(employee.name);
		setIsEditingName(true);
	};

	const handleNameCommit = async () => {
		const trimmed = editName.trim();
		if (trimmed && trimmed !== employee.name) {
			try {
				await useEmployeeStore.getState().updateEmployee(employee.id, { name: trimmed });
			} catch (err) {
				console.error('[EmployeeNode] rename failed:', err);
				setEditName(employee.name); // revert on error
			}
		} else {
			setEditName(employee.name); // revert if empty or unchanged
		}
		setIsEditingName(false);
	};

	const handleNameKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleNameCommit();
		} else if (e.key === 'Escape') {
			setEditName(employee.name);
			setIsEditingName(false);
		}
	};

	const avatarUrl = employee.avatar
		|| (employee.avatarStyle && employee.avatarSeed
			? `https://api.dicebear.com/7.x/${employee.avatarStyle}/svg?seed=${employee.avatarSeed}`
			: `https://api.dicebear.com/7.x/bottts/svg?seed=${employee.id}`);

	const modelLabel = employee.model ? employee.model.split('/').pop()?.slice(0, 12) || '' : '';

	// Token usage: support both number and object formats
	const totalTokens = typeof employee.tokenUsage === 'object'
		? employee.tokenUsage.total
		: employee.tokenUsage || 0;

	const enabledSkills = (employee.skills || []).filter(s => s.enabled);

	return (
		<div
			className={`employee-node ${isSelected ? 'selected' : ''} ${statusInfo.animated ? 'status-animated' : ''}`}
			style={{ background: statusInfo.bg }}
			onClick={() => {
				console.warn(`[EmployeeNode] onClick: employee=${employee.name}(${employee.id}), onSelect=${!!onSelect}`);
				onSelect?.(employee.id);
			}}
		>
			{/* Connection handles */}
			<Handle type="target" position={Position.Top} className="employee-node-handle" />
			<Handle type="source" position={Position.Bottom} className="employee-node-handle" />

			{/* Card body - vertical layout */}
			<div className="employee-node-body">
				{/* Avatar area */}
				<div className="employee-node-avatar-area">
					<div
						className="employee-card-avatar"
						style={{ borderColor: statusInfo.dot }}
					>
						{!imgError ? (
							<img
								src={avatarUrl}
								alt={employee.name}
								className="employee-card-avatar-img"
								onError={() => setImgError(true)}
								draggable={false}
							/>
						) : (
							<div className="employee-card-avatar-fallback">
								{employee.name.charAt(0).toUpperCase()}
							</div>
						)}
					</div>
					{/* Status indicator dot */}
					<div
						className={`employee-status-dot ${statusInfo.animated ? 'animate-pulse' : ''}`}
						style={{ backgroundColor: statusInfo.dot }}
						title={statusInfo.label}
					/>
				</div>

				{/* Info area */}
				<div className="employee-node-info">
					{isEditingName ? (
						<input
							ref={nameInputRef}
							className="employee-card-name-input"
							value={editName}
							onChange={(e) => setEditName(e.target.value)}
							onBlur={handleNameCommit}
							onKeyDown={handleNameKeyDown}
							onClick={(e) => e.stopPropagation()}
							maxLength={50}
						/>
					) : (
						<div className="employee-card-name" onDoubleClick={handleNameDoubleClick} title="双击重命名">{employee.name}</div>
					)}
					<div className="employee-card-role">
						<span>{employee.role}</span>
					</div>
					{/* Model badge */}
					{modelLabel && (
						<div className="employee-card-model-row">
							<span className="employee-card-badge model-badge">
								<svg className="badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
								</svg>
								{modelLabel}
							</span>
						</div>
					)}
				</div>

				{/* Open ConfigMD file button - shown only when configMd is configured */}
				{(employee as any).configMd && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							void previewAgentConfigMd(employee.id).catch((err) => {
								console.error('[EmployeeNode] preview configMd failed:', err);
							});
						}}
						className="employee-node-open-md"
						title="预览 ConfigMD（渲染为 HTML 后在编辑器中打开）"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
							<circle cx="12" cy="12" r="3" strokeWidth={2} />
						</svg>
					</button>
				)}

				{/* Delete button - top right */}
				<button
					onClick={(e) => {
						e.stopPropagation();
						onDelete?.(employee.id);
					}}
					className="employee-node-delete"
					title="删除员工"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
					</svg>
				</button>
			</div>

			{/* ConfigMD indicator - clickable to open the MD source file */}
			{(employee as any).configMd && (
				<div
					className="employee-node-configmd"
					title="点击在编辑器中打开 ConfigMD 源文件"
					role="button"
					onClick={(e) => {
						e.stopPropagation();
						void openAgentConfigMd(employee.id).catch((err) => {
							console.error('[EmployeeNode] open configMd failed:', err);
						});
					}}
				>
					<span className="employee-node-configmd-icon">📝</span>
					<span>MD Panel</span>
				</div>
			)}

			{/* Bottom tags bar - Skills / Token */}
			{(enabledSkills.length > 0 || totalTokens > 0) && (
				<div className="employee-node-tags">
					{enabledSkills.slice(0, 2).map(skill => (
						<span key={skill.id} className="employee-card-skill">{skill.name}</span>
					))}
					{enabledSkills.length > 2 && (
						<span className="employee-card-skill-more">+{enabledSkills.length - 2}</span>
					)}
					{totalTokens > 0 && (
						<span className="employee-card-token">
							<svg className="token-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
							</svg>
							{(totalTokens / 1000).toFixed(1)}k
						</span>
					)}
				</div>
			)}
		</div>
	);
}

export const EmployeeNode = memo(EmployeeNodeComponent);
