/**
 * VersionHistoryPanel — KB note git version history sidebar.
 *
 * Mirrors SoloMD's `HistoryPanel.vue`: lists every commit that touched the
 * active document (newest first), click a row to expand its unified-diff
 * inline, "Restore" button overwrites the working copy with that version.
 *
 * Communication with the host is via postMessage:
 *   → kbblocks.getVersionHistory  { requestId }
 *   → kbblocks.getVersionDiff     { requestId, sha }
 *   → kbblocks.restoreVersion     { sha }
 *   ← kbblocks.versionHistory     { requestId, commits }
 *   ← kbblocks.versionDiff        { requestId, diff }
 *   ← kbblocks.versionRestored    { sha, markdown }
 *   ← kbblocks.versionCommitted   { sha, shortSha }
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { postMessage } from '../bridge/messageClient';

// Type-only import — erased at build time. Path: webview/src/kbMarkdown/ →
// webview/src/ → webview/ → agentStudio/ → agentStudio/browser/kbVersionTypes.ts
interface KbCommitMeta {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	time: number;
}

interface KbDiffLine {
	kind: 'context' | 'add' | 'remove';
	text: string;
}

interface KbDiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: KbDiffLine[];
}

interface KbDiffResult {
	fromSha: string | null;
	toSha: string;
	hunks: KbDiffHunk[];
	unified: string;
}

interface VersionHistoryPanelProps {
	visible: boolean;
	onClose: () => void;
}

// Pending diff requests keyed by requestId
const pendingDiffRequests = new Map<string, (diff: KbDiffResult | null) => void>();

export function VersionHistoryPanel({ visible, onClose }: VersionHistoryPanelProps) {
	const [commits, setCommits] = useState<KbCommitMeta[]>([]);
	const [loading, setLoading] = useState(false);
	const [expandedSha, setExpandedSha] = useState<string | null>(null);
	const [diffCache, setDiffCache] = useState<Record<string, KbDiffResult | null>>({});
	const [restoring, setRestoring] = useState(false);
	const [toast, setToast] = useState<string | null>(null);
	const requestIdCounter = useRef(0);

	// Register global listeners for host responses (only once)
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data;
			if (!msg || msg.direction !== 'toWebview') return;

			if (msg.type === 'kbblocks.versionHistory' && msg.data) {
				const { requestId, commits: list } = msg.data as { requestId: string; commits: KbCommitMeta[] };
				// Update if this is the response we're waiting for
				setCommits(list || []);
				setLoading(false);
			} else if (msg.type === 'kbblocks.versionDiff' && msg.data) {
				const { requestId, diff } = msg.data as { requestId: string; diff: KbDiffResult | null };
				const resolve = pendingDiffRequests.get(requestId);
				if (resolve) {
					pendingDiffRequests.delete(requestId);
					resolve(diff);
				}
			} else if (msg.type === 'kbblocks.versionRestored' && msg.data) {
				const { sha, markdown } = msg.data as { sha: string; markdown: string };
				setRestoring(false);
				setToast(`已恢复到 ${sha.substring(0, 7)}`);
				// Clear diff cache — the file changed
				setDiffCache({});
				setExpandedSha(null);
				// Reload history
				requestHistory();
				setTimeout(() => setToast(null), 2500);
			} else if (msg.type === 'kbblocks.versionCommitted' && msg.data) {
				const { shortSha } = msg.data as { sha: string; shortSha: string };
				// A new commit was just saved — reload history
				if (visible) {
					requestHistory();
				}
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible]);

	const requestHistory = useCallback(() => {
		const requestId = `vh_${++requestIdCounter.current}_${Date.now()}`;
		setLoading(true);
		postMessage('kbblocks.getVersionHistory', { requestId });
		// Fallback timeout — if host doesn't respond in 5s, stop loading
		setTimeout(() => setLoading(false), 5000);
	}, []);

	// Request history when panel becomes visible
	useEffect(() => {
		if (visible) {
			setCommits([]);
			setDiffCache({});
			setExpandedSha(null);
			requestHistory();
		}
	}, [visible, requestHistory]);

	const toggleDiff = useCallback((sha: string) => {
		setExpandedSha(prev => prev === sha ? null : sha);
		if (!diffCache[sha]) {
			const requestId = `vd_${++requestIdCounter.current}_${Date.now()}`;
			postMessage('kbblocks.getVersionDiff', { requestId, sha });
			// Set up pending callback
			pendingDiffRequests.set(requestId, (diff) => {
				setDiffCache(prev => ({ ...prev, [sha]: diff }));
			});
			// Timeout fallback
			setTimeout(() => {
				if (pendingDiffRequests.has(requestId)) {
					pendingDiffRequests.delete(requestId);
					setDiffCache(prev => ({ ...prev, [sha]: null }));
				}
			}, 10000);
		}
	}, [diffCache]);

	const handleRestore = useCallback((sha: string) => {
		if (!confirm(`恢复到此版本？当前内容将在下次保存时作为新版本提交。`)) return;
		setRestoring(true);
		postMessage('kbblocks.restoreVersion', { sha });
	}, []);

	const timeAgo = useCallback((unix: number): string => {
		const now = Math.floor(Date.now() / 1000);
		const delta = Math.max(0, now - unix);
		if (delta < 60) return '刚刚';
		if (delta < 3600) return `${Math.floor(delta / 60)}分钟前`;
		if (delta < 86400) return `${Math.floor(delta / 3600)}小时前`;
		if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}天前`;
		const d = new Date(unix * 1000);
		return d.toISOString().slice(0, 10);
	}, []);

	if (!visible) return null;

	return (
		<div className="kb-version-panel">
			<div className="kb-version-header">
				<span className="kb-version-header-title">版本历史</span>
				{!loading && commits.length > 0 && (
					<span className="kb-version-count">{commits.length}</span>
				)}
				<button className="kb-version-close" onClick={onClose} title="关闭">×</button>
			</div>

			{loading && <div className="kb-version-empty">加载中...</div>}

			{!loading && commits.length === 0 && (
				<div className="kb-version-empty">
					<div className="kb-version-empty-icon">git</div>
					<div>暂无版本记录</div>
					<div className="kb-version-empty-hint">保存文件后会自动创建版本快照</div>
				</div>
			)}

			{!loading && commits.length > 0 && (
				<div className="kb-version-list">
					{commits.map((c) => (
						<div
							key={c.sha}
							className={`kb-version-item ${expandedSha === c.sha ? 'kb-version-item--open' : ''}`}
						>
							<div className="kb-version-row" onClick={() => toggleDiff(c.sha)}>
								<span className="kb-version-sha">{c.shortSha}</span>
								<span className="kb-version-time">{timeAgo(c.time)}</span>
								<span className="kb-version-msg">{c.message}</span>
							</div>

							{expandedSha === c.sha && (
								<div className="kb-version-diff-wrap">
									<div className="kb-version-diff-toolbar">
										<button
											className="kb-version-restore"
											disabled={restoring}
											onClick={() => handleRestore(c.sha)}
										>
											{restoring ? '恢复中...' : '恢复此版本'}
										</button>
										<span className="kb-version-author">{c.author}</span>
									</div>
									{diffCache[c.sha] === undefined ? (
										<div className="kb-version-diff-loading">加载 diff...</div>
									) : !diffCache[c.sha] ? (
										<div className="kb-version-diff-empty">无法获取 diff</div>
									) : (
										<pre className="kb-version-diff">
											{diffCache[c.sha]!.hunks.map((hunk, hi) => (
												<React.Fragment key={hi}>
													<span className="kb-version-hunk-hdr">
														@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
													</span>
													{'\n'}
													{hunk.lines.map((line, li) => (
														<span
															key={`${hi}-${li}`}
															className={`kb-version-diff-line kb-version-diff-line--${line.kind}`}
														>
															{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}{line.text}
															{'\n'}
														</span>
													))}
												</React.Fragment>
											))}
										</pre>
									)}
								</div>
							)}
						</div>
					))}
				</div>
			)}

			{toast && <div className="kb-version-toast">{toast}</div>}
		</div>
	);
}
