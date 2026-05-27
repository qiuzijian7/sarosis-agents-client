/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Checkpoint Card Component
 *
 *  Inspired by Void's CheckPoint component:
 *  - Visual divider between conversation turns
 *  - Ghost state for "time travel" navigation
 *  - Shows checkpoint type (user_edit / tool_edit)
 *  - Click to restore state at that checkpoint
 *
 *  Ref: Void sidebar-tsx/SidebarChat.tsx (CheckPoint, currCheckpointIdx)
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useCallback } from 'react';

export interface CheckpointData {
	id: string;
	/** Type of checkpoint */
	type: 'user_edit' | 'tool_edit' | 'message_boundary';
	/** Timestamp */
	timestamp: string;
	/** Description of what changed */
	description?: string;
	/** Number of files modified since last checkpoint */
	filesChanged?: number;
	/** Whether this checkpoint is in "ghost" state (not the current state) */
	isGhost?: boolean;
	/** Whether the checkpoint navigation is disabled (streaming, etc.) */
	isDisabled?: boolean;
}

interface CheckpointCardProps {
	checkpoint: CheckpointData;
	/** Callback to restore state at this checkpoint */
	onRestore?: (checkpointId: string) => void;
}

const CheckpointCardRaw = function CheckpointCard({ checkpoint, onRestore }: CheckpointCardProps): React.ReactElement {
	const { type, timestamp, description, filesChanged, isGhost, isDisabled } = checkpoint;

	const handleClick = useCallback(() => {
		if (isDisabled || !onRestore) { return; }
		onRestore(checkpoint.id);
	}, [isDisabled, onRestore, checkpoint.id]);

	const typeLabel = type === 'user_edit'
		? '用户编辑'
		: type === 'tool_edit'
			? '工具编辑'
			: '消息节点';

	const typeIcon = type === 'user_edit'
		? (
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
				<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
				<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
			</svg>
		)
		: type === 'tool_edit'
			? (
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<polyline points="16 18 22 12 16 6" />
					<polyline points="8 6 2 12 8 18" />
				</svg>
			)
			: (
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<circle cx="12" cy="12" r="3" />
				</svg>
			);

	const formatTime = (ts: string) => {
		return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
	};

	return (
		<div
			className={`checkpoint-card ${isGhost ? 'ghost' : 'active'} ${isDisabled ? 'disabled' : ''}`}
			onClick={handleClick}
			role="button"
			tabIndex={isDisabled ? -1 : 0}
			title={isGhost ? '点击恢复到此检查点' : '当前状态'}
		>
			<div className="checkpoint-line" />
			<div className="checkpoint-content">
				<span className="checkpoint-icon">{typeIcon}</span>
				<span className="checkpoint-type">{typeLabel}</span>
				{filesChanged !== undefined && filesChanged > 0 && (
					<span className="checkpoint-files">{filesChanged} 文件变更</span>
				)}
				{description && (
					<span className="checkpoint-desc">{description}</span>
				)}
				<span className="checkpoint-time">{formatTime(timestamp)}</span>
				{isGhost && !isDisabled && (
					<span className="checkpoint-restore-hint">↩ 恢复</span>
				)}
			</div>
		</div>
	);
};

export const CheckpointCard = memo(CheckpointCardRaw);
