/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Worktree Badge Component
 *  Displays worktree status indicator for a workspace.
 *  Shows: branch icon + branch name + status dot (pending/ready/failed)
 *--------------------------------------------------------------------------------------------*/

import React, { memo } from 'react';

export type WorktreeBadgeStatus = 'none' | 'pending' | 'ready' | 'failed';

interface WorktreeBadgeProps {
	status: WorktreeBadgeStatus;
	branch?: string;
	directory?: string;
	onClick?: () => void;
}

const STATUS_CONFIG: Record<WorktreeBadgeStatus, { icon: string; color: string; bg: string; label: string; animated: boolean }> = {
	none: {
		icon: '📁',
		color: 'var(--vscode-descriptionForeground)',
		bg: 'transparent',
		label: '在主仓库工作',
		animated: false,
	},
	pending: {
		icon: '⏳',
		color: 'var(--vscode-notificationsWarningIcon-foreground, #cca700)',
		bg: 'rgba(204, 167, 0, 0.1)',
		label: 'Worktree 创建中...',
		animated: true,
	},
	ready: {
		icon: '🌿',
		color: 'var(--vscode-notificationsInfoIcon-foreground, #3794ff)',
		bg: 'rgba(55, 148, 255, 0.08)',
		label: 'Worktree 已就绪',
		animated: false,
	},
	failed: {
		icon: '❌',
		color: 'var(--vscode-notificationsErrorIcon-foreground, #f14c4c)',
		bg: 'rgba(241, 76, 76, 0.08)',
		label: 'Worktree 创建失败',
		animated: false,
	},
};

export const WorktreeBadge = memo(function WorktreeBadge({
	status,
	branch,
	directory,
	onClick,
}: WorktreeBadgeProps): React.ReactElement | null {
	if (status === 'none') {
		return null;
	}

	const config = STATUS_CONFIG[status];

	return (
		<div
			className={`worktree-badge worktree-badge-${status} ${config.animated ? 'worktree-badge-animated' : ''}`}
			style={{
				color: config.color,
				backgroundColor: config.bg,
			}}
			title={`${config.label}${branch ? `\n分支: ${branch}` : ''}${directory ? `\n目录: ${directory}` : ''}`}
			onClick={onClick}
		>
			<span className="worktree-badge-icon">{config.icon}</span>
			{branch && (
				<span className="worktree-badge-branch">{branch}</span>
			)}
			{status === 'pending' && (
				<span className="worktree-badge-spinner" />
			)}
		</div>
	);
});
