/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Checkpoint Bar
 *
 *  A floating, **non-persistent** info bar shown above the composer
 *  whenever a tool_edit checkpoint exists. Mirrors the Void chat
 *  "checkpoint pill" UX:
 *
 *  语义（聚合 / 全部检查点）：
 *    - 文件数量 = 所有 tool_edit 检查点修改过的文件**去重总数**。
 *    - 点击文件数（展开按钮）= 向下展开，列出**所有被修改过的文件**（聚合去重）；
 *      点击某行 → 打开该文件「最初内容 vs 当前内容」的 diff。
 *    - 保留 = 标记所有检查点为 kept（bar 消失，文件保持当前状态）。
 *    - 撤销 = 把所有被改过的文件还原到**最初**状态（新建文件删除），bar 消失。
 *    - 查看变更 = 在**一个多文件 diff 窗口**中显示所有修改文件的 diff。
 *
 *  布局自上而下：
 *    1. 检查点选择器（向上弹出 popover）：列出全部检查点，每项两行
 *       —「检查点 N」+ 其对应的用户输入预览；当前选中项右侧显示 ✓，
 *       其余项 hover 显示「定位」。点击某项 → 选中它并滚动聊天框到
 *       对应的用户输入点（纯导航，不改文件）。
 *    2. 主体行：左侧「▾ N 个文件 · 检查点 K」，右侧 保留 / 撤销 / 查看变更。
 *    3. 文件列表（点击文件数后向下展开）：聚合去重的全部修改文件。
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useChatStore, type CheckpointData, type ChatMessage } from '../../store/useChatStore';

interface CheckpointBarProps {
	/** Optional className for layout overrides. */
	className?: string;
}

/** 选择器中渲染的单个检查点条目（携带定位锚点 messageId）。 */
interface CheckpointEntry {
	cp: CheckpointData;
	/** 该检查点对应的"用户输入点"消息 id（其之前最近的一条 user 消息）。 */
	anchorMessageId: string | null;
	/** 该用户输入点的文本预览（用于选择器展示）。 */
	anchorPreview: string;
	/** 该检查点序号（从 1 开始，按时间顺序）。 */
	index: number;
}

/** 聚合去重后的单个文件（跨所有检查点）。 */
interface AggregatedFile {
	uri: string;
	fileName: string;
	fsPath: string;
	/** 跨所有检查点累加的新增行数。 */
	additions: number;
	/** 跨所有检查点累加的删除行数。 */
	deletions: number;
	/** 该文件**最早**出现的检查点 id —— 打开单文件 diff 时以它的快照作为「最初内容」基准。 */
	earliestCheckpointId: string;
}

/** 从文件名取扩展名（小写，无点），用于左侧类型角标。 */
function fileExt(fileName: string): string {
	const i = fileName.lastIndexOf('.');
	if (i <= 0 || i === fileName.length - 1) { return ''; }
	return fileName.slice(i + 1).toLowerCase();
}

export const CheckpointBar: React.FC<CheckpointBarProps> = ({ className }) => {
	// Subscribe to messages so the bar re-renders when checkpoints arrive / mutate.
	const messages = useChatStore(s => s.messages);
	const undoAllCheckpoints = useChatStore(s => s.undoAllCheckpoints);
	const keepAllCheckpoints = useChatStore(s => s.keepAllCheckpoints);
	const openAllCheckpointsDiff = useChatStore(s => s.openAllCheckpointsDiff);
	const openCheckpointDiff = useChatStore(s => s.openCheckpointDiff);

	// ── 收集全部 tool_edit 检查点，并为每个检查点解析其"用户输入点" ──
	// 用户输入点 = 该检查点在 messages 中位置之前、最近的一条 user 消息。
	// 这是触发本次工具编辑的输入，点击选择器项时滚动定位到它。
	const entries: CheckpointEntry[] = useMemo(() => {
		const result: CheckpointEntry[] = [];
		let lastUserMsg: ChatMessage | null = null;
		let seq = 0;
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (m.role === 'user') {
				lastUserMsg = m;
				continue;
			}
			if (m.role === 'checkpoint' && m.checkpoint && m.checkpoint.type === 'tool_edit') {
				seq += 1;
				const preview = (lastUserMsg?.content || '').trim().replace(/\s+/g, ' ').slice(0, 80)
					|| m.checkpoint.description
					|| '检查点';
				result.push({
					cp: m.checkpoint,
					anchorMessageId: lastUserMsg?.id ?? null,
					anchorPreview: preview,
					index: seq,
				});
			}
		}
		return result;
	}, [messages]);

	// 是否存在仍可操作（保留/撤销）的活动检查点——只要有任意非 ghost/非 kept
	// 的 tool_edit 检查点即可。保留/撤销作用于**全部**检查点。
	const hasActiveCheckpoint = useMemo(() => {
		return entries.some(e => !e.cp.isGhost && !e.cp.isDisabled && !e.cp.isKept);
	}, [entries]);

	// ── 聚合去重文件列表（跨所有 tool_edit 检查点）──
	// entries 已按时间升序；对每个文件 URI 首次遇到的检查点即「最早」快照所在，
	// 增删数累加（反映该文件一共改了多少），earliestCheckpointId 保持首次。
	const aggregatedFiles: AggregatedFile[] = useMemo(() => {
		const map = new Map<string, AggregatedFile>();
		for (const e of entries) {
			const files = e.cp.files;
			if (!files || files.length === 0) { continue; }
			for (const f of files) {
				const existing = map.get(f.uri);
				if (existing) {
					existing.additions += f.additions;
					existing.deletions += f.deletions;
				} else {
					map.set(f.uri, {
						uri: f.uri,
						fileName: f.fileName,
						fsPath: f.fsPath,
						additions: f.additions,
						deletions: f.deletions,
						earliestCheckpointId: e.cp.id,
					});
				}
			}
		}
		return Array.from(map.values());
	}, [entries]);

	const totalFileCount = aggregatedFiles.length;

	// 选择器当前高亮项（默认最新检查点）。仅用于导航定位，不影响"全部"操作。
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selectedEntry: CheckpointEntry | undefined = useMemo(() => {
		if (selectedId) {
			const hit = entries.find(e => e.cp.id === selectedId);
			if (hit) { return hit; }
		}
		return entries.length > 0 ? entries[entries.length - 1] : undefined;
	}, [entries, selectedId]);

	const [pickerOpen, setPickerOpen] = useState(false);
	// 文件列表展开状态（点击文件数后向下展开）。
	const [filesOpen, setFilesOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const pickerRef = useRef<HTMLDivElement | null>(null);

	// Click-outside-to-close（仅对选择器 popover）。
	useEffect(() => {
		if (!pickerOpen) { return; }
		const onDoc = (e: MouseEvent) => {
			if (!rootRef.current) { return; }
			if (e.target instanceof Node && rootRef.current.contains(e.target)) { return; }
			setPickerOpen(false);
		};
		document.addEventListener('mousedown', onDoc);
		return () => document.removeEventListener('mousedown', onDoc);
	}, [pickerOpen]);

	// 保留全部 → 标记所有检查点 kept，bar 消失。
	const handleKeep = useCallback(() => {
		keepAllCheckpoints();
		setPickerOpen(false);
	}, [keepAllCheckpoints]);

	// 撤销全部 → 所有文件还原到最初状态，bar 消失。
	const handleUndo = useCallback(() => {
		undoAllCheckpoints();
		setPickerOpen(false);
	}, [undoAllCheckpoints]);

	// 查看全部变更 → 打开一个多文件 diff 窗口。
	const handleViewChanges = useCallback(() => {
		openAllCheckpointsDiff();
	}, [openAllCheckpointsDiff]);

	// 点击文件数 → 切换文件列表展开/收起。
	const handleToggleFiles = useCallback(() => {
		setFilesOpen(v => !v);
		setPickerOpen(false);
	}, []);

	// 点击文件列表中的某行 → 打开该文件「最初内容 vs 当前内容」的 diff。
	const handleOpenFileDiff = useCallback((file: AggregatedFile) => {
		openCheckpointDiff(file.earliestCheckpointId, file.uri);
	}, [openCheckpointDiff]);

	// 滚动聊天框到某检查点对应的用户输入点。
	const scrollToAnchor = useCallback((anchorMessageId: string | null) => {
		if (!anchorMessageId) { return; }
		requestAnimationFrame(() => {
			const el = document.querySelector<HTMLElement>(
				`[data-message-id="${CSS.escape(anchorMessageId)}"]`
			);
			if (el) {
				el.scrollIntoView({ behavior: 'smooth', block: 'start' });
				el.classList.add('chat-message-jump-highlight');
				window.setTimeout(() => el.classList.remove('chat-message-jump-highlight'), 1200);
			}
		});
	}, []);

	// 点击选择器中的检查点项 → 选中它 + 滚动到对应用户输入点（纯导航）。
	const handleSelectCheckpoint = useCallback((entry: CheckpointEntry) => {
		setSelectedId(entry.cp.id);
		setPickerOpen(false);
		scrollToAnchor(entry.anchorMessageId);
	}, [scrollToAnchor]);

	const handleTogglePicker = useCallback(() => {
		setPickerOpen(v => !v);
		setFilesOpen(false);
	}, []);

	// 没有任何 tool_edit 检查点时不渲染 bar。
	if (entries.length === 0 || !selectedEntry) { return null; }

	return (
		<div className={`checkpoint-bar${className ? ` ${className}` : ''}`} ref={rootRef}>
			{/* ── 检查点选择器（向上弹出）───────────────────────────── */}
			{pickerOpen && (
				<div className="checkpoint-bar-picker" ref={pickerRef}>
					<ul className="checkpoint-bar-cp-list">
						{/* 最新的排在最上方，便于快速定位最近一次编辑。 */}
						{[...entries].reverse().map(entry => {
							const isSelected = selectedEntry.cp.id === entry.cp.id;
							return (
								<li
									key={entry.cp.id}
									className={`checkpoint-bar-cp-item${isSelected ? ' is-selected' : ''}${entry.cp.isKept ? ' is-kept' : ''}`}
									onClick={() => handleSelectCheckpoint(entry)}
								>
									<div className="checkpoint-bar-cp-main">
										<div className="checkpoint-bar-cp-title">检查点 {entry.index}</div>
										<div className="checkpoint-bar-cp-preview">{entry.anchorPreview}</div>
									</div>
									{isSelected ? (
										<svg className="checkpoint-bar-cp-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
											<polyline points="20 6 9 17 4 12" />
										</svg>
									) : (
										<span className="checkpoint-bar-cp-revert">定位</span>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			)}

			{/* ── 主体行 ─────────────────────────────────────────────── */}
			<div className="checkpoint-bar-main">
				<button
					type="button"
					className="checkpoint-bar-summary"
					onClick={handleToggleFiles}
					title={filesOpen ? '收起文件列表' : '展开查看所有修改的文件'}
				>
					<svg
						className={`checkpoint-bar-chevron${filesOpen ? ' is-open' : ''}`}
						width="12" height="12" viewBox="0 0 24 24"
						fill="none" stroke="currentColor" strokeWidth="2"
						strokeLinecap="round" strokeLinejoin="round" aria-hidden
					>
						{/* 默认向下（文件列表向下展开）；展开后翻转朝上 */}
						<polyline points="6 9 12 15 18 9" />
					</svg>
					<span className="checkpoint-bar-files-label">{totalFileCount} 个文件</span>
				</button>

				<button
					type="button"
					className="checkpoint-bar-cp-toggle"
					onClick={handleTogglePicker}
					title={pickerOpen ? '收起检查点列表' : '查看所有检查点'}
				>
					<span className="checkpoint-bar-checkpoint-label">检查点 {selectedEntry.index}</span>
					<svg
						className={`checkpoint-bar-chevron${pickerOpen ? ' is-open' : ''}`}
						width="12" height="12" viewBox="0 0 24 24"
						fill="none" stroke="currentColor" strokeWidth="2"
						strokeLinecap="round" strokeLinejoin="round" aria-hidden
					>
						{/* 默认向上（选择器从上方弹出）；展开后翻转 */}
						<polyline points="6 15 12 9 18 15" />
					</svg>
				</button>

				<div className="checkpoint-bar-spacer" />

				{hasActiveCheckpoint && (
					<div className="checkpoint-bar-actions">
						<button
							type="button"
							className="checkpoint-bar-action checkpoint-bar-action-keep"
							onClick={handleKeep}
							title="保留全部更改并关闭检查点"
						>
							保留
						</button>
						<button
							type="button"
							className="checkpoint-bar-action checkpoint-bar-action-undo"
							onClick={handleUndo}
							title="撤销全部更改，将所有文件还原到最初状态"
						>
							撤销
						</button>
					</div>
				)}
				<button
					type="button"
					className="checkpoint-bar-action checkpoint-bar-action-view"
					onClick={handleViewChanges}
					title="在一个窗口中查看所有修改的文件"
				>
					查看变更
				</button>
			</div>

			{/* ── 文件变更列表（点击文件数后向下展开）──────────────────
			 * 聚合去重的全部修改文件；点击某行打开该文件的 diff。
			 * ─────────────────────────────────────────────────────── */}
			{filesOpen && (
				<div className="checkpoint-bar-files">
					{aggregatedFiles.length === 0 ? (
						<div className="checkpoint-bar-files-empty">没有可显示的文件变更。</div>
					) : (
						<ul className="checkpoint-bar-file-list">
							{aggregatedFiles.map(file => {
								const ext = fileExt(file.fileName);
								return (
									<li
										key={file.uri}
										className="checkpoint-bar-file-item"
										onClick={() => handleOpenFileDiff(file)}
										title={`${file.fsPath}\n点击查看该文件的变更对比`}
									>
										<span className="checkpoint-bar-file-icon" data-ext={ext}>
											{ext || '·'}
										</span>
										<span className="checkpoint-bar-file-name">{file.fileName}</span>
										<span className="checkpoint-bar-file-path">{file.fsPath}</span>
										<span className="checkpoint-bar-file-stats">
											{file.additions > 0 && (
												<span className="checkpoint-bar-additions">+{file.additions}</span>
											)}
											<span className="checkpoint-bar-deletions">-{file.deletions}</span>
										</span>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			)}
		</div>
	);
};
