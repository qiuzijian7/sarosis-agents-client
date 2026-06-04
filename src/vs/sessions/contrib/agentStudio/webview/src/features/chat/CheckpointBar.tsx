/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Checkpoint Bar
 *
 *  A floating, **non-persistent** info bar shown above the composer
 *  whenever a tool_edit checkpoint exists. Mirrors the Void chat
 *  "checkpoint pill" UX — collapsed summary with 保留/撤销/查看变更
 *  actions, plus a click-to-expand popover listing per-file
 *  +N/-N diff stats.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useChatStore, type CheckpointData, type CheckpointFileChange } from '../../store/useChatStore';

interface CheckpointBarProps {
	/** Optional className for layout overrides. */
	className?: string;
}

export const CheckpointBar: React.FC<CheckpointBarProps> = ({ className }) => {
	// Subscribe to messages so the bar re-renders when checkpoints arrive / mutate.
	const messages = useChatStore(s => s.messages);
	const jumpToCheckpoint = useChatStore(s => s.jumpToCheckpoint);
	const keepCheckpoint = useChatStore(s => s.keepCheckpoint);
	const openCheckpointDiff = useChatStore(s => s.openCheckpointDiff);

	// Derive the latest renderable checkpoint from message list.
	const latest: CheckpointData | undefined = useMemo(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== 'checkpoint' || !m.checkpoint) { continue; }
			const cp = m.checkpoint;
			if (cp.type !== 'tool_edit') { continue; }
			if (cp.isGhost || cp.isDisabled || cp.isKept) { continue; }
			return cp;
		}
		return undefined;
	}, [messages]);

	const [popoverOpen, setPopoverOpen] = useState(false);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// Click-outside-to-close.
	// 注意：检测范围是整个 .checkpoint-bar 根容器（含 summary 按钮 / 操作按钮），
	// 而非仅 popover。否则点击 summary 按钮时，mousedown 会先把 popover 判为
	// "外部点击"而关闭，紧接着 click 的 handleToggle 又重新打开 → 永远关不掉。
	useEffect(() => {
		if (!popoverOpen) { return; }
		const onDoc = (e: MouseEvent) => {
			if (!rootRef.current) { return; }
			if (e.target instanceof Node && rootRef.current.contains(e.target)) { return; }
			setPopoverOpen(false);
		};
		document.addEventListener('mousedown', onDoc);
		return () => document.removeEventListener('mousedown', onDoc);
	}, [popoverOpen]);

	const handleKeep = useCallback(() => {
		if (!latest) { return; }
		keepCheckpoint(latest.id);
		setPopoverOpen(false);
	}, [latest, keepCheckpoint]);

	const handleUndo = useCallback(() => {
		if (!latest) { return; }
		jumpToCheckpoint(latest.id);
		setPopoverOpen(false);
	}, [latest, jumpToCheckpoint]);

	const handleViewFile = useCallback((f: CheckpointFileChange) => {
		if (!latest) { return; }
		// employeeId / sessionId 由 store 内部从 active 字段补全，
		// 不能依赖 latest.employeeId（CheckpointData 不携带该字段）。
		openCheckpointDiff(latest.id, f.uri);
	}, [latest, openCheckpointDiff]);

	const handleToggle = useCallback(() => {
		setPopoverOpen(v => !v);
	}, []);

	if (!latest) { return null; }

	const files: CheckpointFileChange[] = latest.files ?? [];
	const fileCount = files.length || (latest.filesChanged ?? 0);
	const totalAdditions = files.reduce((sum, f) => sum + (f.additions || 0), 0);
	const totalDeletions = files.reduce((sum, f) => sum + (f.deletions || 0), 0);

	return (
		<div className={`checkpoint-bar${className ? ` ${className}` : ''}`} ref={rootRef}>
			<button
				type="button"
				className="checkpoint-bar-summary"
				onClick={handleToggle}
				title={popoverOpen ? '收起检查点详情' : '查看检查点详情'}
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
					<polyline points="20 6 9 17 4 12" />
				</svg>
				<span className="checkpoint-bar-files-label">{fileCount} 个文件</span>
				<span className="checkpoint-bar-divider">·</span>
				<span className="checkpoint-bar-checkpoint-label">检查点</span>
				{(totalAdditions > 0 || totalDeletions > 0) && (
					<span className="checkpoint-bar-diff-stats">
						{totalAdditions > 0 && <span className="checkpoint-bar-additions">+{totalAdditions}</span>}
						{totalDeletions > 0 && <span className="checkpoint-bar-deletions">-{totalDeletions}</span>}
					</span>
				)}
				<svg
					className={`checkpoint-bar-chevron${popoverOpen ? ' is-open' : ''}`}
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden
				>
					{/* 默认向上；popover 展开（is-open）时 CSS rotate(180deg) → 向下 */}
					<polyline points="6 15 12 9 18 15" />
				</svg>
			</button>

			<div className="checkpoint-bar-actions">
				<button
					type="button"
					className="checkpoint-bar-action checkpoint-bar-action-keep"
					onClick={handleKeep}
					title="保留当前更改并关闭检查点"
				>
					保留
				</button>
				<button
					type="button"
					className="checkpoint-bar-action checkpoint-bar-action-undo"
					onClick={handleUndo}
					title="撤销到此检查点之前"
				>
					撤销
				</button>
				<button
					type="button"
					className="checkpoint-bar-action checkpoint-bar-action-view"
					onClick={handleToggle}
					title="展开/收起变更详情"
				>
					查看变更
				</button>
			</div>

			{popoverOpen && (
				<div className="checkpoint-bar-popover" ref={popoverRef}>
					<div className="checkpoint-bar-popover-header">
						<span>检查点变更</span>
						<button
							type="button"
							className="checkpoint-bar-popover-close"
							onClick={() => setPopoverOpen(false)}
							title="关闭"
							aria-label="关闭"
						>
							×
						</button>
					</div>
					{files.length === 0 ? (
						<div className="checkpoint-bar-popover-empty">
							{latest.description || '没有可显示的文件变更明细。'}
						</div>
					) : (
						<ul className="checkpoint-bar-file-list">
							{files.map(f => (
								<li key={f.uri} className="checkpoint-bar-file-item" title={f.fsPath} onClick={() => handleViewFile(f)}>
									<span className="checkpoint-bar-file-name">{f.fileName}</span>
									<span className="checkpoint-bar-file-stats">
										{f.additions > 0 && <span className="checkpoint-bar-additions">+{f.additions}</span>}
										{f.deletions > 0 && <span className="checkpoint-bar-deletions">-{f.deletions}</span>}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
};
