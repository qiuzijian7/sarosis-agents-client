/* Top-level KB note renderer. Reads `window.__KB_INIT__` (injected by the host
 * `KbBlocksEditorPane`), renders the markdown via the react-markdown pipeline,
 * and wires navigation / editing / backlinks back to the host over postMessage.
 *
 * Replaces the old BlockSuite/AFFiNE editor: `.md` is the single source of truth;
 * edits in source mode are serialized straight back to disk via `kbblocks.save`.
 *
 * Architecture (aligned with Glyph's useTabs.ts edit pipeline):
 *   content     — last known disk content (source of truth for preview)
 *   editContent — in-flight editing buffer (dirty flag controls auto-save)
 *   Mode switching: view→edit/split copies content→editContent.
 *   Auto-save: 2s debounce when dirty && (edit || split).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { extractOutline, findHeadingId, type IOutlineItem } from './outline';
import { collectDomOutline } from './domOutline';
import { toggleTaskCheckbox } from './taskToggle';
import { MarkdownSourceEditor } from './MarkdownSourceEditor';
import { postMessage, initMessageClient } from '../bridge/messageClient';
// Inlined at build time by the katex-css esbuild plugin (CSS + font data URIs).
// @ts-ignore - virtual module provided by the bundler
import katexCss from 'katex/dist/katex.min.css';

interface KbInitData {
	docId: string;
	markdown?: string;
	workspaceFiles?: { uri: string; name: string }[];
	currentFilePath?: string;
	/** When set (from a `[[note#heading]]` jump), scroll here after first render. */
	heading?: string;
}

interface ISerializedBacklink {
	uri: string;
	name: string;
	snippet: string;
	type: 'ref' | 'mention';
}
interface IBacklinksPayload {
	backlinks: ISerializedBacklink[];
	backmentions: { uri: string; name: string; snippet: string }[];
}

type EditorMode = 'preview' | 'source' | 'split';

const AUTO_SAVE_DELAY = 2000; // Aligned with Glyph

export function KbMarkdownApp(): React.ReactElement {
	const init = (window as unknown as { __KB_INIT__?: KbInitData }).__KB_INIT__;
	const docId = init?.docId ?? 'kb:probe';
	const diskContent = init?.markdown ?? '';
	const workspaceFiles = init?.workspaceFiles ?? [];
	const currentFilePath = init?.currentFilePath ?? docId;

	// ── Double-buffer state (aligned with Glyph's FileState) ──────────────
	const [content, setContent] = useState(diskContent);          // last-known disk content
	const [editContent, setEditContent] = useState(diskContent); // editing buffer (may be stale)
	const [dirty, setDirty] = useState(false);                   // editContent ≠ saved content

	const [mode, setMode] = useState<EditorMode>('preview');
	const [showToc, setShowToc] = useState(false);
	const [flipped, setFlipped] = useState(false);
	const [zoom, setZoom] = useState(0); // 0=100% 1=115% 2=130%
	const ZOOM_LEVELS = [1, 1.15, 1.3];
	const [copied, setCopied] = useState(false);
	const [backlinks, setBacklinks] = useState<IBacklinksPayload | null>(null);

	// Track whether content has ever changed from the initial value (treat the
	// initial empty string as "not yet edited", so auto-save doesn't fire on
	// mount for an empty file).
	const initialDiskRef = useRef(diskContent);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();

	useEffect(() => {
		if (katexCss && !document.getElementById('kb-katex-css')) {
			const style = document.createElement('style');
			style.id = 'kb-katex-css';
			style.textContent = katexCss;
			document.head.appendChild(style);
		}
	}, []);

	useEffect(() => {
		postMessage('kbblocks.ready', { docId });
	}, [docId]);

	useEffect(() => {
		initMessageClient((type, data) => {
			if (type === 'kbblocks.backlinks') setBacklinks(data as IBacklinksPayload);
			// External file change: host tells us the file was modified outside
			// (e.g. another editor saved). Reload content from the notification.
			if (type === 'kbblocks.fileChanged' && typeof data === 'object' && data && 'markdown' in data) {
				const newContent = String((data as { markdown?: string }).markdown ?? '');
				setContent(newContent);
				// If not dirty, also update the edit buffer so source/split mode
				// reflect the latest disk state.
				if (!dirty) {
					setEditContent(newContent);
				}
			}
		});
		// Deliberately exclude `dirty` from deps — the handler above reads the
		// closure-captured value which is fine for a fire-and-forget callback.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── Mode switching: sync editContent ← content when entering edit modes ──
	const setModeAndSync = useCallback((next: EditorMode) => {
		setMode((prev) => {
			// Entering edit/split from view: initialise edit buffer from disk content.
			if (prev === 'preview' && (next === 'source' || next === 'split')) {
				setEditContent(content);
				setDirty(false);
			}
			return next;
		});
	}, [content]);

	// ── Auto-save: debounced write when dirty in edit/split mode ───────────
	const effectiveContent = mode === 'preview' ? content : editContent;
	const doSave = useCallback((md: string, kind?: string) => {
		setContent(md);
		setDirty(false);
		postMessage('kbblocks.save', kind ? { markdown: md, kind } : { markdown: md });
	}, []);

	useEffect(() => {
		if (mode === 'preview') return;
		if (!dirty) return;
		// Don't auto-save the initial empty content on first mount.
		if (editContent === initialDiskRef.current) return;

		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			doSave(editContent);
		}, AUTO_SAVE_DELAY);

		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, [editContent, dirty, mode, doSave]);

	// ── Derived values ─────────────────────────────────────────────────────
	const outline = useMemo<IOutlineItem[]>(() => extractOutline(effectiveContent), [effectiveContent]);

	const [domOutline, setDomOutline] = useState<IOutlineItem[] | null>(null);
	const markdownContainerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (mode !== 'preview') { setDomOutline(null); return; }
		const raf = requestAnimationFrame(() => {
			setDomOutline(collectDomOutline(markdownContainerRef.current));
		});
		return () => cancelAnimationFrame(raf);
	}, [effectiveContent, mode]);

	// ── Navigation callbacks ───────────────────────────────────────────────
	const onOpenWikilink = useCallback((uri: string, heading?: string) => {
		postMessage('kbblocks.openDoc', heading ? { uri, heading } : { uri });
	}, []);
	const onOpenRelativeFile = useCallback(
		(href: string) => {
			postMessage('kbblocks.openRelative', { href, fromUri: currentFilePath });
		},
		[currentFilePath],
	);
	const onOpenExternal = useCallback((url: string) => {
		postMessage('kbblocks.openExternal', { url });
	}, []);

	// ── Task toggle (aligned with Glyph's toggleTask) ──────────────────────
	const onToggleTask = useCallback((line: number) => {
		const source = mode === 'preview' ? content : editContent;
		const next = toggleTaskCheckbox(source, line);
		if (next == null || next === source) return;

		if (mode === 'preview') {
			// View mode: write straight to disk (content is the single source).
			setContent(next);
			setEditContent(next);
			postMessage('kbblocks.save', { markdown: next, kind: 'taskToggle' });
		} else {
			// Edit/split mode: update buffer; auto-save handles persistence.
			setEditContent(next);
			setDirty(true);
			// Persist immediately for task toggle (it's a single-line change,
			// no point waiting for the debounce).
			postMessage('kbblocks.save', { markdown: next, kind: 'taskToggle' });
			setContent(next);
			setDirty(false);
		}
	}, [content, editContent, mode]);

	// ── Copy ────────────────────────────────────────────────────────────────
	const copyMarkdown = useCallback(() => {
		postMessage('kbblocks.copy', { markdown: effectiveContent });
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1200);
	}, [effectiveContent]);

	// ── Scroll helpers ──────────────────────────────────────────────────────
	const scrollToId = useCallback((id: string) => {
		document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}, []);

	const pendingHeading = init?.heading;
	useEffect(() => {
		if (!pendingHeading) return;
		const t = window.setTimeout(() => {
			const id = domOutline && domOutline.length
				? findHeadingId(domOutline, pendingHeading) ?? findHeadingId(outline, pendingHeading)
				: findHeadingId(outline, pendingHeading);
			if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}, 0);
		return () => window.clearTimeout(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingHeading, domOutline]);

	// ── Preview content (shared between view and split modes) ───────────────
	const previewEl = (
		<div className="kb-front-scroll" ref={mode === 'preview' ? markdownContainerRef : undefined}>
			<div className={`kb-markdown kb-zoom-${zoom}`}>
				<MarkdownContent
					content={content}
					filePath={currentFilePath}
					workspaceFiles={workspaceFiles}
					onOpenWikilink={onOpenWikilink}
					onOpenRelativeFile={onOpenRelativeFile}
					onOpenExternal={onOpenExternal}
					onToggleTask={onToggleTask}
				/>
			</div>
		</div>
	);

	// ── Empty state (preview mode only) ─────────────────────────────────────
	const emptyEl = (
		<div className="kb-empty">
			<div className="kb-empty-icon">📄</div>
			<div className="kb-empty-title">空白文件</div>
			<div className="kb-empty-hint">点击工具栏的「源码」按钮开始编写 Markdown</div>
		</div>
	);

	// ── Render ──────────────────────────────────────────────────────────────
	return (
		<div className="kb-markdown-root">
		<div className="kb-toolbar">
			<div className="kb-tool-row">
				<button
					className={`kb-tool-btn ${mode === 'preview' ? 'kb-tool-btn--active' : ''}`}
					title="预览 (Ctrl+1)"
					aria-label="预览"
					onClick={() => setModeAndSync('preview')}
				>
					{/* eye icon */}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
				</button>
				<button
					className={`kb-tool-btn ${mode === 'source' ? 'kb-tool-btn--active' : ''}`}
					title="源码 (Ctrl+2)"
					aria-label="源码"
					onClick={() => setModeAndSync('source')}
				>
					{/* code icon */}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
				</button>
				<button
					className={`kb-tool-btn ${mode === 'split' ? 'kb-tool-btn--active' : ''}`}
					title="分屏 (Ctrl+3)"
					aria-label="分屏"
					onClick={() => setModeAndSync('split')}
				>
					{/* split / columns icon */}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>
				</button>
				<button
					className={`kb-tool-btn ${showToc ? 'kb-tool-btn--active' : ''}`}
					title="大纲"
					aria-label="大纲"
					onClick={() => setShowToc((v) => !v)}
				>
					{/* list icon */}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
				</button>
				<button
					className={`kb-tool-btn ${zoom > 0 ? 'kb-tool-btn--active' : ''}`}
					title={`放大 (${Math.round(ZOOM_LEVELS[zoom] * 100)}%)`}
					aria-label="放大"
					onClick={() => setZoom((z) => (z + 1) % ZOOM_LEVELS.length)}
				>
					{/* zoom-in icon */}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
				</button>
				<button
					className={`kb-tool-btn ${flipped ? 'kb-tool-btn--active' : ''}`}
					title="翻面（反馈 / 提及）"
					aria-label="翻面"
					onClick={() => setFlipped((v) => !v)}
				>
					{/* flip / refresh icon */}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
				</button>
				<button
					className="kb-tool-btn"
					title="复制 Markdown"
					aria-label="复制"
					onClick={copyMarkdown}
				>
					{/* copy icon */}
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
				</button>
				{dirty && <span className="kb-dirty-indicator" title="有未保存的修改">●</span>}
			</div>
			<span className="kb-version">pipeline v0.3</span>
			{copied && <span className="kb-copied">已复制!</span>}
		</div>

		{showToc && (
			<div className="kb-toc">
				<div className="kb-toc-title">大纲</div>
				{(() => {
					const tocItems = domOutline && domOutline.length ? domOutline : outline;
					return tocItems.length === 0 ? (
						<div className="kb-toc-empty">（暂无标题）</div>
					) : (
						tocItems.map((item, idx) => (
							<div
								key={idx}
								className="kb-toc-item"
								style={{ paddingLeft: `${(item.level - 1) * 14 + 8}px` }}
								onClick={() => scrollToId(item.id)}
							>
								{item.text || '(空标题)'}
							</div>
						))
					);
				})()}
			</div>
		)}

		<div className="kb-pane">
			<div className="kb-flip-front">
				{mode === 'preview' ? (
							content.trim().length === 0 ? emptyEl : previewEl
						) : mode === 'split' ? (
							<div className="kb-split">
									<div className="kb-split-left">
									<MarkdownSourceEditor
										content={editContent}
										onChange={(val) => { setEditContent(val); setDirty(true); }}
										workspaceFiles={workspaceFiles}
									/>
								</div>
								<div className="kb-split-right">
									{content.trim().length === 0 ? emptyEl : (
										<div className="kb-front-scroll" ref={markdownContainerRef}>
											<div className={`kb-markdown kb-zoom-${zoom}`}>
												<MarkdownContent
													content={content}
													filePath={currentFilePath}
													workspaceFiles={workspaceFiles}
													onOpenWikilink={onOpenWikilink}
													onOpenRelativeFile={onOpenRelativeFile}
													onOpenExternal={onOpenExternal}
													onToggleTask={onToggleTask}
												/>
											</div>
										</div>
									)}
								</div>
							</div>
						) : (
							<MarkdownSourceEditor
								content={editContent}
								onChange={(val) => { setEditContent(val); setDirty(true); }}
								workspaceFiles={workspaceFiles}
							/>
						)}
					</div>
			{flipped && (
				<div className="kb-side-panel">
					<div className="kb-side-panel-title">反馈 / 提及</div>
					<div className="kb-meta">
						<span>字数 {content.length}</span>
						<span>标题 {extractOutline(content).length}</span>
						<span>反链 {(backlinks?.backlinks.length ?? 0) + (backlinks?.backmentions.length ?? 0)}</span>
					</div>
					{!backlinks || (backlinks.backlinks.length === 0 && backlinks.backmentions.length === 0) ? (
						<div className="kb-backlinks-empty">（暂无反链 / 提及）</div>
					) : (
						<>
							{backlinks.backlinks.map((b, i) => (
								<div
									key={`b-${i}`}
									className="kb-backlink-card"
									onClick={() => postMessage('kbblocks.openDoc', { uri: b.uri })}
								>
									<div className="kb-backlink-name">{b.name || '(未知文档)'}</div>
									<div className="kb-backlink-snippet">{b.snippet || ''}</div>
								</div>
							))}
							{backlinks.backmentions.map((m, i) => (
								<div
									key={`m-${i}`}
									className="kb-backlink-card"
									onClick={() => postMessage('kbblocks.openDoc', { uri: m.uri })}
								>
									<div className="kb-backlink-name">{m.name || '(未知文档)'}</div>
									<div className="kb-backlink-snippet">{m.snippet || ''}</div>
								</div>
							))}
						</>
					)}
				</div>
			)}
		</div>
		</div>
	);
}
