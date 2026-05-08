/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Node (ReactFlow custom node)
 *--------------------------------------------------------------------------------------------*/

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Employee } from '../../store/useEmployeeStore';

interface EmployeeNodeData {
	employee: Employee;
}

const STATUS_COLORS: Record<string, { bg: string; border: string; dot: string }> = {
	idle: { bg: 'var(--vscode-editor-background)', border: 'var(--vscode-panel-border)', dot: '#4ade80' },
	working: { bg: 'var(--vscode-editor-background)', border: '#3b82f6', dot: '#3b82f6' },
	thinking: { bg: 'var(--vscode-editor-background)', border: '#f59e0b', dot: '#f59e0b' },
	error: { bg: 'var(--vscode-editor-background)', border: '#ef4444', dot: '#ef4444' },
	offline: { bg: 'var(--vscode-editor-background)', border: 'var(--vscode-panel-border)', dot: '#6b7280' },
};

function EmployeeNodeComponent({ data }: NodeProps & { data: EmployeeNodeData }): React.ReactElement {
	const { employee } = data;
	const statusStyle = STATUS_COLORS[employee.status] || STATUS_COLORS.idle;

	const avatarUrl = employee.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${employee.id}`;
	const modelLabel = employee.model ? employee.model.slice(-12) : '';
	const enabledSkills = (employee.skills || []).filter(s => s.enabled);

	return (
		<div
			className="employee-node"
			style={{
				backgroundColor: statusStyle.bg,
				border: `2px solid ${statusStyle.border}`,
				borderRadius: '8px',
				padding: '10px',
				minWidth: '160px',
				maxWidth: '200px',
				position: 'relative',
			}}
		>
			{/* Connection handles */}
			<Handle type="target" position={Position.Top} style={{ background: '#555' }} />
			<Handle type="source" position={Position.Bottom} style={{ background: '#555' }} />

			{/* Status dot */}
			<div
				style={{
					position: 'absolute',
					top: '8px',
					right: '8px',
					width: '8px',
					height: '8px',
					borderRadius: '50%',
					backgroundColor: statusStyle.dot,
					animation: employee.status === 'working' ? 'pulse 1.5s infinite' : undefined,
				}}
			/>

			{/* Avatar */}
			<div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
				<img
					src={avatarUrl}
					alt={employee.name}
					style={{
						width: '28px',
						height: '28px',
						borderRadius: '50%',
						backgroundColor: 'var(--vscode-input-background)',
					}}
					onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
				/>
				<div style={{ overflow: 'hidden' }}>
					<div style={{
						fontWeight: 600,
						fontSize: '12px',
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						color: 'var(--vscode-foreground)',
					}}>
						{employee.name}
					</div>
					<div style={{
						fontSize: '10px',
						color: 'var(--vscode-descriptionForeground)',
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}>
						{employee.role}
					</div>
				</div>
			</div>

			{/* Model label */}
			{modelLabel && (
				<div style={{
					fontSize: '10px',
					color: 'var(--vscode-textLink-foreground)',
					marginBottom: '4px',
					whiteSpace: 'nowrap',
					overflow: 'hidden',
					textOverflow: 'ellipsis',
				}}>
					{modelLabel}
				</div>
			)}

			{/* Skills tags */}
			{enabledSkills.length > 0 && (
				<div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
					{enabledSkills.slice(0, 2).map(skill => (
						<span key={skill.id} style={{
							fontSize: '9px',
							padding: '1px 4px',
							borderRadius: '3px',
							backgroundColor: 'var(--vscode-badge-background)',
							color: 'var(--vscode-badge-foreground)',
						}}>
							{skill.name}
						</span>
					))}
					{enabledSkills.length > 2 && (
						<span style={{
							fontSize: '9px',
							padding: '1px 4px',
							color: 'var(--vscode-descriptionForeground)',
						}}>
							+{enabledSkills.length - 2}
						</span>
					)}
				</div>
			)}

			{/* Token usage */}
			{employee.tokenUsage != null && employee.tokenUsage > 0 && (
				<div style={{
					fontSize: '9px',
					color: 'var(--vscode-descriptionForeground)',
					marginTop: '4px',
				}}>
					{Math.round(employee.tokenUsage / 1000)}k tokens
				</div>
			)}
		</div>
	);
}

export const EmployeeNode = memo(EmployeeNodeComponent);
