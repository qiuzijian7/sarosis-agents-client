/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Tool Call Card Component
 *
 *  Enhanced tool call card inspired by OpenClaw's tool-cards.ts and Void's SmallProseWrapper:
 *  - Collapsed summary with icon + tool name + status indicator
 *  - Expanded view with formatted input/output sections
 *  - Streaming argument preview (partial JSON display)
 *  - Result truncation with "show more" toggle
 *  - Copy button for args/results
 *  - Error state styling
 *  - Duration display
 *  - renderType-based rendering: ListItems / RunTerminal / CodeApply
 *
 *  Void-inspired enhancements:
 *  - Line numbers for read_file (SmallProseWrapper pattern)
 *  - Diff view for edit_file (red/green highlighting)
 *  - Apply hover button for code blocks
 *  - Tool approval UI (approve/reject buttons)
 *  - Lint diagnostics after edit_file
 *  - Exit code for terminal commands
 *  - Search highlight for search_files
 *  - Clickable file path hyperlinks
 *
 *  Ref: OpenClaw ui/src/ui/chat/tool-cards.ts
 *  Ref: Void sidebar-tsx/SidebarChat.tsx (SmallProseWrapper, ToolRequestAcceptRejectButtons)
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useCallback, useMemo, useState } from 'react';
import { sanitizeToolResultText } from '../../utils/assistantVisibleText';
import { ToolDisplayRegistry } from '../../utils/toolDisplayRegistry';
import { openFile } from '../../bridge/fileBridge';
import { sendRequest } from '../../bridge/messageClient';

/**
 * Phantom tool names — DEPRECATED: visibility is now controlled solely by
 * `defaultShow`. Kept as empty set for backward compatibility.
 */
const PHANTOM_TOOL_NAMES = new Set<string>([]);

export interface ToolCallData {
	id: string;
	name: string;
	arguments: string;
	result?: string;
	status: string;
	/** Duration in ms (if available) */
	duration?: number;
	/** Error message (if failed) */
	error?: string;
	/** Whether to show this tool call card in the chat UI. Default true. */
	defaultShow?: boolean;
	/** UI 显示名称（来自模型的 display_name 字段） */
	displayName?: string;
	/** 渲染类型（如 RunTerminal、CodeApply、ListItems 等） */
	renderType?: string;
	/** 工具已在服务端执行（如 Knot AG-UI），客户端不需要再执行 */
	serverExecuted?: boolean;
	/** Security level for approval UI */
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	/** Exit code from terminal commands */
	exitCode?: number;
	/** Lint/diagnostic errors after edit_file */
	diagnostics?: Array<{ message: string; line?: number; severity: 'error' | 'warning' }>;
}

interface ToolCallCardProps {
	toolCall: ToolCallData;
}

/** Max chars to show in result preview before truncating */
const RESULT_PREVIEW_LIMIT = 500;
/** Max chars to show in expanded result before "show all" */
const RESULT_EXPANDED_LIMIT = 5000;

/** Recognized renderType values */
const KNOWN_RENDER_TYPES = new Set(['ListItems', 'RunTerminal', 'CodeApply']);

// ─── Knot document format (from Knot AG-UI <document> tags) ───────────────────

interface KnotDocument {
	sub_content?: string;
	sub_content_tip?: string;
	sub_content_event?: string;
	sub_content_event_value?: string;
	path?: string;
}

function parseKnotDocument(raw: string): KnotDocument | null {
	try {
		const parsed = JSON.parse(raw);
		if (parsed && (parsed.sub_content !== undefined || parsed.sub_content_event !== undefined || parsed.path !== undefined)) {
			return parsed as KnotDocument;
		}
	} catch { /* not JSON or not a Knot document */ }
	return null;
}

/**
 * Resolve display info via ToolDisplayRegistry.
 * Returns emoji, title/label, and detail summary.
 */
function useToolDisplay(name: string, args: string) {
	return useMemo(() => ToolDisplayRegistry.resolve(name, args), [name, args]);
}

/**
 * Extract file path from tool arguments (supports file_path, filePath, path).
 */
function extractFilePath(args: string): string | null {
	try {
		const parsed = JSON.parse(args || '{}');
		return parsed.file_path || parsed.filePath || parsed.path || null;
	} catch {
		return null;
	}
}

/**
 * Extract search query from tool arguments.
 */
function extractSearchQuery(args: string): string | null {
	try {
		const parsed = JSON.parse(args || '{}');
		return parsed.query || parsed.pattern || parsed.search_query || null;
	} catch {
		return null;
	}
}

/**
 * Format duration for display.
 */
function formatDuration(ms: number): string {
	if (ms < 1000) { return `${ms}ms`; }
	if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// ─── Diff computation for edit_file ──────────────────────────────────────────

interface DiffLine {
	type: 'context' | 'add' | 'remove';
	content: string;
	lineNumber?: number;
}

/**
 * Compute a simple diff between old and new content.
 * Uses line-by-line comparison with LCS approximation.
 */
function computeDiff(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');
	const result: DiffLine[] = [];

	// Simple approach: find common prefix and suffix, mark middle as changed
	let prefixLen = 0;
	while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
		prefixLen++;
	}

	let suffixLen = 0;
	while (
		suffixLen < (oldLines.length - prefixLen) &&
		suffixLen < (newLines.length - prefixLen) &&
		oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	// Context lines before
	for (let i = 0; i < prefixLen; i++) {
		result.push({ type: 'context', content: oldLines[i], lineNumber: i + 1 });
	}

	// Removed lines
	for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
		result.push({ type: 'remove', content: oldLines[i], lineNumber: i + 1 });
	}

	// Added lines
	for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
		result.push({ type: 'add', content: newLines[i], lineNumber: i + 1 });
	}

	// Context lines after
	for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
		result.push({ type: 'context', content: oldLines[i], lineNumber: i + 1 });
	}

	return result;
}

/**
 * Try to parse unified diff from edit_file arguments or result.
 * Returns DiffLine[] if a diff is found, null otherwise.
 */
function tryParseDiff(toolCall: ToolCallData): DiffLine[] | null {
	try {
		const args = JSON.parse(toolCall.arguments || '{}');

		// Check for diff/patch format in arguments
		const diffContent = args.diff || args.patch || args.old_string !== undefined;
		if (!diffContent) { return null; }

		// If we have old_string and new_string, compute diff
		if (args.old_string !== undefined && args.new_string !== undefined) {
			return computeDiff(args.old_string, args.new_string);
		}

		// If we have raw diff content
		if (args.diff || args.patch) {
			const rawDiff = (args.diff || args.patch) as string;
			const lines = rawDiff.split('\n');
			const result: DiffLine[] = [];
			for (const line of lines) {
				if (line.startsWith('+') && !line.startsWith('+++')) {
					result.push({ type: 'add', content: line.substring(1) });
				} else if (line.startsWith('-') && !line.startsWith('---')) {
					result.push({ type: 'remove', content: line.substring(1) });
				} else {
					result.push({ type: 'context', content: line.startsWith(' ') ? line.substring(1) : line });
				}
			}
			return result;
		}

		return null;
	} catch {
		return null;
	}
}

// ─── renderType-specific renderers ────────────────────────────────────────────

interface KnotListItem {
	content?: string;
	content_tip?: string;
	suffix_content?: string;
	item_type?: 'file' | 'directory';
	item_click_event?: string;
	item_click_value?: string;
}

/** ListItems renderer: displays a list of items from the result */
function ListItemsRenderer({ toolCall }: { toolCall: ToolCallData }): React.ReactElement {
	const searchQuery = useMemo(() => extractSearchQuery(toolCall.arguments), [toolCall.arguments]);

	const items = useMemo(() => {
		const raw = toolCall.result || '';
		if (!raw) { return []; }
		const cleaned = sanitizeToolResultText(raw);
		try {
			const parsed = JSON.parse(cleaned);
			// Support: string[], {items: [...]}, {list: [...]}, or object with array values
			if (Array.isArray(parsed)) { return parsed as (KnotListItem | string)[]; }
			if (parsed.items && Array.isArray(parsed.items)) { return parsed.items as (KnotListItem | string)[]; }
			if (parsed.list && Array.isArray(parsed.list)) { return parsed.list as (KnotListItem | string)[]; }
			// If parsed is an object, return entries as key-value pairs
			if (typeof parsed === 'object' && parsed !== null) {
				return Object.entries(parsed).map(([k, v]) => ({
					content: `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
				}));
			}
			return [{ content: cleaned }];
		} catch {
			// Fallback: split by newlines
			return cleaned.split('\n').filter(Boolean).map(line => ({ content: line }));
		}
	}, [toolCall.result]);

	const handleItemClick = useCallback((item: KnotListItem) => {
		if (item.item_click_event === 'open_editor' && item.item_click_value) {
			openFile(item.item_click_value);
		}
	}, []);

	/**
	 * Highlight search query matches in text.
	 */
	const highlightText = useCallback((text: string): React.ReactNode => {
		if (!searchQuery || !text) { return text; }
		const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const regex = new RegExp(`(${escaped})`, 'gi');
		const parts = text.split(regex);
		if (parts.length <= 1) { return text; }
		return (
			<>
				{parts.map((part, idx) =>
					regex.test(part)
						? <mark key={idx} className="tool-call-search-highlight">{part}</mark>
						: part
				)}
			</>
		);
	}, [searchQuery]);

	return (
		<div className="tool-call-render-list-items">
			{items.length > 0 ? (
				<ul className="tool-call-list">
					{items.map((item, idx) => {
						const isObj = item !== null && typeof item === 'object';
						const listItem: KnotListItem = isObj ? (item as KnotListItem) : { content: String(item) };
						const isDir = listItem.item_type === 'directory';
						const clickable = !!listItem.item_click_event;
						return (
							<li
								key={idx}
								className={`tool-call-list-item ${clickable ? 'clickable' : ''}`}
								onClick={() => handleItemClick(listItem)}
								title={listItem.content_tip || listItem.content}
							>
								<span className="tool-call-list-bullet">
									{isDir ? '📁' : '📄'}
								</span>
								<span className="tool-call-list-content">{highlightText(listItem.content || '')}</span>
								{listItem.suffix_content && (
									<span className="tool-call-list-suffix">{listItem.suffix_content}</span>
								)}
							</li>
						);
					})}
				</ul>
			) : (
				<span className="tool-call-empty">（无结果）</span>
			)}
		</div>
	);
}

/** RunTerminal renderer: displays terminal command and output */
function RunTerminalRenderer({ toolCall }: { toolCall: ToolCallData }): React.ReactElement {
	const command = useMemo(() => {
		try {
			const parsed = JSON.parse(toolCall.arguments || '{}');
			return parsed.command || parsed.cmd || '';
		} catch {
			return '';
		}
	}, [toolCall.arguments]);

	const output = useMemo(() => {
		const raw = toolCall.result || '';
		if (!raw) { return ''; }
		return sanitizeToolResultText(raw);
	}, [toolCall.result]);

	const exitCode = toolCall.exitCode;
	const isNonZeroExit = exitCode !== undefined && exitCode !== 0;

	return (
		<div className="tool-call-render-terminal">
			{command && (
				<div className="tool-call-terminal-cmd">
					<span className="tool-call-terminal-prompt">$</span>
					<code>{command}</code>
				</div>
			)}
			{output && (
				<pre className="tool-call-terminal-output">{output}</pre>
			)}
			{exitCode !== undefined && (
				<div className={`tool-call-exit-code ${isNonZeroExit ? 'non-zero' : 'zero'}`}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						{isNonZeroExit
							? <><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>
							: <polyline points="20 6 9 17 4 12" />
						}
					</svg>
					<span>Exit code: {exitCode}</span>
				</div>
			)}
		</div>
	);
}

// ─── CodeApply renderer with line numbers, diff view, apply button ──────────

/** CodeApply renderer: displays code changes with diff-like styling */
function CodeApplyRenderer({ toolCall }: { toolCall: ToolCallData }): React.ReactElement {
	const { filePath, code, language, offset, isEditFile, isReadFile } = useMemo(() => {
		try {
			const parsed = JSON.parse(toolCall.arguments || '{}');
			const toolName = (toolCall.name || '').toLowerCase();
			return {
				filePath: parsed.file_path || parsed.filePath || parsed.path || '',
				code: parsed.code || parsed.content || parsed.new_string || '',
				language: parsed.language || '',
				offset: parsed.offset ?? parsed.start_line ?? undefined,
				isEditFile: toolName === 'edit_file' || toolName === 'edit' || toolName === 'replace_in_file' || toolName === 'apply_patch',
				isReadFile: toolName === 'read_file' || toolName === 'read',
			};
		} catch {
			return { filePath: '', code: '', language: '', offset: undefined, isEditFile: false, isReadFile: false };
		}
	}, [toolCall.arguments, toolCall.name]);

	const result = useMemo(() => {
		const raw = toolCall.result || '';
		if (!raw) { return ''; }
		return sanitizeToolResultText(raw);
	}, [toolCall.result]);

	// Try to compute diff for edit_file tools
	const diffLines = useMemo(() => {
		if (isEditFile) {
			return tryParseDiff(toolCall);
		}
		return null;
	}, [isEditFile, toolCall]);

	// Parse read_file result into numbered lines
	const numberedLines = useMemo(() => {
		if (!isReadFile || !result) { return null; }
		const lines = result.split('\n');
		const startLine = offset ?? 1;
		return lines.map((line, idx) => ({
			lineNumber: startLine + idx,
			content: line,
		}));
	}, [isReadFile, result, offset]);

	const handleOpenFile = useCallback(() => {
		if (filePath) { openFile(filePath); }
	}, [filePath]);

	const handleOpenFileAtLine = useCallback((line: number) => {
		if (filePath) { openFile(`${filePath}:${line}`); }
	}, [filePath]);

	const handleApply = useCallback(() => {
		if (!filePath || !code) { return; }
		// Send an apply request to the host — this will write the code to the file
		sendRequest('files.applyCode', {
			path: filePath,
			content: code,
			toolCallId: toolCall.id,
		}).catch((err) => {
			console.error('[ToolCallCard] Apply failed:', err);
		});
	}, [filePath, code, toolCall.id]);

	return (
		<div className="tool-call-render-code-apply">
			{filePath && (
				<div className="tool-call-code-file-header">
					<div className="tool-call-code-file-info">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
							<polyline points="14 2 14 8 20 8" />
						</svg>
						<code
							className="tool-call-code-file-path tool-call-file-link"
							onClick={handleOpenFile}
							title="点击打开文件"
						>
							{filePath}
						</code>
					</div>
					<div className="tool-call-code-file-actions">
						{isEditFile && code && (
							<button className="tool-call-apply-btn" onClick={handleApply} title="应用代码变更">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
									<polyline points="20 6 9 17 4 12" />
								</svg>
								应用
							</button>
						)}
						<button className="tool-call-code-open-file" onClick={handleOpenFile}>
							查看文件
						</button>
					</div>
				</div>
			)}

			{/* Diff view for edit_file */}
			{diffLines && diffLines.length > 0 && (
				<div className="tool-call-diff-view">
					{diffLines.map((line, idx) => (
						<div key={idx} className={`tool-call-diff-line diff-${line.type}`}>
							<span className="tool-call-diff-line-number">
								{line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''}
								{line.lineNumber ?? ''}
							</span>
							<span className="tool-call-diff-line-content">{line.content}</span>
						</div>
					))}
				</div>
			)}

			{/* Numbered lines for read_file */}
			{numberedLines && !diffLines && (
				<div className="tool-call-numbered-code">
					{numberedLines.map((line, idx) => (
						<div
							key={idx}
							className="tool-call-code-line"
							onClick={() => handleOpenFileAtLine(line.lineNumber)}
							title={`点击跳转到第 ${line.lineNumber} 行`}
						>
							<span className="tool-call-line-number">{line.lineNumber}</span>
							<span className="tool-call-line-content">{line.content}</span>
						</div>
					))}
				</div>
			)}

			{/* Fallback: plain code preview (for write_file etc.) */}
			{code && !diffLines && !numberedLines && (
				<div className="tool-call-code-preview-wrapper">
					<pre className="tool-call-code-preview"><code>{code}</code></pre>
					{isEditFile && (
						<button className="tool-call-apply-float-btn" onClick={handleApply} title="应用代码变更">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<polyline points="20 6 9 17 4 12" />
							</svg>
							应用
						</button>
					)}
				</div>
			)}

			{/* Result (when not rendered as numbered lines) */}
			{result && !numberedLines && (
				<div className="tool-call-code-result">
					<span className="tool-call-code-result-label">结果:</span>
					<span>{result}</span>
				</div>
			)}

			{/* Lint diagnostics */}
			{toolCall.diagnostics && toolCall.diagnostics.length > 0 && (
				<div className="tool-call-diagnostics">
					<div className="tool-call-diagnostics-header">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="12" cy="12" r="10" />
							<line x1="12" y1="8" x2="12" y2="12" />
							<line x1="12" y1="16" x2="12.01" y2="16" />
						</svg>
						<span>{toolCall.diagnostics.length} 个诊断问题</span>
					</div>
					{toolCall.diagnostics.map((diag, idx) => (
						<div key={idx} className={`tool-call-diagnostic diagnostic-${diag.severity}`}>
							<span className="tool-call-diagnostic-icon">
								{diag.severity === 'error' ? '✕' : '⚠'}
							</span>
							{diag.line !== undefined && (
								<span className="tool-call-diagnostic-line">L{diag.line}</span>
							)}
							<span className="tool-call-diagnostic-message">{diag.message}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Tool Approval Buttons (Void-inspired) ──────────────────────────────────

function ToolApprovalButtons({ toolCall }: { toolCall: ToolCallData }): React.ReactElement {
	const handleApprove = useCallback(() => {
		sendRequest('chat.toolApprove', { toolCallId: toolCall.id, decision: 'allow_once' }).catch(() => {});
	}, [toolCall.id]);

	const handleApproveAlways = useCallback(() => {
		sendRequest('chat.toolApprove', { toolCallId: toolCall.id, decision: 'allow_always' }).catch(() => {});
	}, [toolCall.id]);

	const handleReject = useCallback(() => {
		sendRequest('chat.toolApprove', { toolCallId: toolCall.id, decision: 'deny' }).catch(() => {});
	}, [toolCall.id]);

	const securityLabel = toolCall.securityLevel === 'dangerous'
		? '危险操作'
		: toolCall.securityLevel === 'cautious'
			? '需谨慎'
			: '需确认';

	const securityClass = toolCall.securityLevel === 'dangerous'
		? 'dangerous'
		: toolCall.securityLevel === 'cautious'
			? 'cautious'
			: 'safe';

	return (
		<div className={`tool-call-approval ${securityClass}`}>
			<div className="tool-call-approval-header">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
				</svg>
				<span className="tool-call-approval-label">需要审批 · {securityLabel}</span>
			</div>
			<div className="tool-call-approval-actions">
				<button className="tool-call-approve-btn" onClick={handleApprove}>
					允许一次
				</button>
				<button className="tool-call-approve-always-btn" onClick={handleApproveAlways}>
					始终允许
				</button>
				<button className="tool-call-reject-btn" onClick={handleReject}>
					拒绝
				</button>
			</div>
		</div>
	);
}

// ─── Generic (default) tool call card ─────────────────────────────────────────

function GenericToolCallCard({ toolCall }: ToolCallCardProps): React.ReactElement {
	const [expanded, setExpanded] = useState(false);
	const [showFullResult, setShowFullResult] = useState(false);
	const [copiedField, setCopiedField] = useState<string | null>(null);

	const isRunning = toolCall.status === 'running' && !toolCall.result;
	const isError = toolCall.status === 'error' || !!toolCall.error;
	const isApprovalRequired = toolCall.status === 'approval_required';
	const isRejected = toolCall.status === 'rejected';

	const display = useToolDisplay(toolCall.name, toolCall.arguments);

	const formattedArgs = useMemo(() => {
		const raw = toolCall.arguments || '';
		if (!raw || raw === '{}') { return ''; }
		try {
			const parsed = JSON.parse(raw);
			return JSON.stringify(parsed, null, 2);
		} catch {
			return raw;
		}
	}, [toolCall.arguments]);

	const argsSummary = useMemo(() => {
		// Prefer registry-extracted detail (from detailKeys)
		if (display.detail) { return display.detail; }
		// Fallback: show first arg value or count
		const raw = toolCall.arguments || '';
		if (!raw || raw === '{}') { return ''; }
		try {
			const parsed = JSON.parse(raw);
			const keys = Object.keys(parsed);
			if (keys.length === 0) { return ''; }
			const firstKey = keys[0];
			const firstVal = parsed[firstKey];
			if (typeof firstVal === 'string') {
				const displayVal = firstVal.length > 50 ? firstVal.substring(0, 50) + '...' : firstVal;
				return displayVal;
			}
			return `${keys.length} 个参数`;
		} catch {
			return '';
		}
	}, [toolCall.arguments, display.detail]);

	const knotDoc = useMemo(() => {
		const raw = toolCall.result || '';
		if (!raw) { return null; }
		return parseKnotDocument(sanitizeToolResultText(raw));
	}, [toolCall.result]);

	const formattedResult = useMemo(() => {
		const raw = toolCall.result || '';
		if (!raw) { return ''; }
		const cleaned = sanitizeToolResultText(raw);
		if (knotDoc?.sub_content) {
			return knotDoc.sub_content;
		}
		try {
			const parsed = JSON.parse(cleaned);
			return JSON.stringify(parsed, null, 2);
		} catch {
			return cleaned;
		}
	}, [toolCall.result, knotDoc]);

	const isResultLong = formattedResult.length > RESULT_EXPANDED_LIMIT;
	const displayResult = showFullResult
		? formattedResult
		: formattedResult.substring(0, RESULT_EXPANDED_LIMIT);

	const handleCopy = useCallback((text: string, field: string) => {
		navigator.clipboard?.writeText(text).then(() => {
			setCopiedField(field);
			setTimeout(() => setCopiedField(null), 2000);
		}).catch(() => { });
	}, []);

	const statusClass = isApprovalRequired ? 'approval-required' : isRejected ? 'rejected' : isRunning ? 'running' : isError ? 'error' : 'completed';

	return (
		<div className={`tool-call-card ${statusClass}`}>
			{/* ── Collapsed Header ── */}
			<div
				className="tool-call-card-header"
				onClick={() => setExpanded(!expanded)}
				role="button"
				aria-expanded={expanded}
			>
				<span className="tool-call-icon">
					{isApprovalRequired ? (
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
							<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
						</svg>
					) : isRejected ? (
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
							<circle cx="12" cy="12" r="10" />
							<line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
						</svg>
					) : isRunning ? (
						<svg className="tool-spinner" width="14" height="14" viewBox="0 0 24 24"
							fill="none" stroke="currentColor" strokeWidth="2.5">
							<path d="M21 12a9 9 0 11-6.219-8.56" />
						</svg>
					) : isError ? (
						<svg width="14" height="14" viewBox="0 0 24 24"
							fill="none" stroke="currentColor" strokeWidth="2.5">
							<circle cx="12" cy="12" r="10" />
							<line x1="15" y1="9" x2="9" y2="15" />
							<line x1="9" y1="9" x2="15" y2="15" />
						</svg>
					) : (
						<svg width="14" height="14" viewBox="0 0 24 24"
							fill="none" stroke="currentColor" strokeWidth="2.5">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					)}
				</span>
				<span className="tool-call-card-name">
					<span className="tool-call-emoji">{display.emoji}</span>
					{toolCall.displayName || display.label}
				</span>
				{!expanded && argsSummary && (
					<span className="tool-call-card-summary" title={argsSummary}>
						{argsSummary}
					</span>
				)}
				{!expanded && (extractFilePath(toolCall.arguments) || knotDoc?.sub_content_event_value) && (
					<button
						className="tool-call-card-open-file"
						onClick={(e) => {
							e.stopPropagation();
							const fp = extractFilePath(toolCall.arguments) || knotDoc?.sub_content_event_value;
							if (fp) { openFile(fp); }
						}}
					>
						查看文件
					</button>
				)}
				{toolCall.duration && !isRunning && (
					<span className="tool-call-duration">
						{formatDuration(toolCall.duration)}
					</span>
				)}
				<span className={`tool-call-card-toggle ${expanded ? '' : 'collapsed'}`}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>

			{/* ── Approval UI ── */}
			{isApprovalRequired && (
				<ToolApprovalButtons toolCall={toolCall} />
			)}
			{isRejected && (
				<div className="tool-call-rejected-notice">
					<span>用户已拒绝此工具调用</span>
				</div>
			)}

			{/* ── Expanded Body ── */}
			{expanded && (
				<div className="tool-call-card-body">
					{formattedArgs && formattedArgs !== '{}' && (
						<div className="tool-call-section">
							<div className="tool-call-section-header">
								<span className="tool-call-section-title">输入</span>
								<button
									className="tool-call-copy-btn"
									onClick={(e) => { e.stopPropagation(); handleCopy(formattedArgs, 'args'); }}
									title="复制参数"
								>
									{copiedField === 'args' ? '✓' : '📋'}
								</button>
							</div>
							<pre className="tool-call-code">{formattedArgs}</pre>
						</div>
					)}

					{formattedResult && (
						<div className="tool-call-section">
							<div className="tool-call-section-header">
								<span className="tool-call-section-title">
									{isError ? '错误' : '输出'}
								</span>
								<button
									className="tool-call-copy-btn"
									onClick={(e) => { e.stopPropagation(); handleCopy(formattedResult, 'result'); }}
									title="复制结果"
								>
									{copiedField === 'result' ? '✓' : '📋'}
								</button>
							</div>
							<pre className={`tool-call-code ${isError ? 'error-output' : ''}`}>
								{displayResult}
								{isResultLong && !showFullResult && '\n...'}
							</pre>
							{isResultLong && (
								<button
									className="tool-call-show-more"
									onClick={() => setShowFullResult(!showFullResult)}
								>
									{showFullResult
										? `▲ 收起 (${formattedResult.length} 字符)`
										: `▼ 显示全部 (${formattedResult.length} 字符)`
									}
								</button>
							)}
						</div>
					)}

					{toolCall.error && !formattedResult && (
						<div className="tool-call-section">
							<div className="tool-call-section-header">
								<span className="tool-call-section-title">错误</span>
							</div>
							<pre className="tool-call-code error-output">{toolCall.error}</pre>
						</div>
					)}

					{isRunning && !formattedResult && (
						<div className="tool-call-running-indicator">
							<span className="tool-call-running-dots">
								<span className="typing-dot">●</span>
								<span className="typing-dot">●</span>
								<span className="typing-dot">●</span>
							</span>
							<span className="tool-call-running-text">执行中...</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Main ToolCallCard with renderType dispatch ──────────────────────────────

function ToolCallCardRaw({ toolCall }: ToolCallCardProps): React.ReactElement | null {
	// Visibility is controlled solely by defaultShow.
	// If defaultShow is false (or undefined for backward compat where defaultShow
	// was not sent), don't render this tool call card.
	if (toolCall.defaultShow === false) {
		return null;
	}

	// Resolve display info from registry (emoji, label, inferred renderType, etc.)
	const display = ToolDisplayRegistry.resolve(toolCall.name, toolCall.arguments);

	// Priority: explicit renderType from provider > inferred renderType from registry
	const explicitRenderType = toolCall.renderType
		? toolCall.renderType
		: undefined;
	const inferredRenderType = display.renderType;
	let effectiveRenderType = explicitRenderType || inferredRenderType;

	// Auto-detect renderType from result content when not explicitly provided
	// (e.g. Knot AG-UI may send items without a renderType)
	if (!effectiveRenderType || !KNOWN_RENDER_TYPES.has(effectiveRenderType)) {
		const raw = toolCall.result || '';
		if (raw) {
			const cleaned = sanitizeToolResultText(raw);
			try {
				const parsed = JSON.parse(cleaned);
				if (parsed.items && Array.isArray(parsed.items)) {
					effectiveRenderType = 'ListItems';
				} else if (Array.isArray(parsed)) {
					effectiveRenderType = 'ListItems';
				}
			} catch { /* not JSON, keep existing */ }
		}
	}

	// If effectiveRenderType exists and is known, dispatch to specialized renderer
	if (effectiveRenderType && KNOWN_RENDER_TYPES.has(effectiveRenderType)) {
		const isRunning = toolCall.status === 'running' && !toolCall.result;
		const isError = toolCall.status === 'error' || !!toolCall.error;
		const isApprovalRequired = toolCall.status === 'approval_required';
		const isRejected = toolCall.status === 'rejected';
		const statusClass = isApprovalRequired ? 'approval-required' : isRejected ? 'rejected' : isRunning ? 'running' : isError ? 'error' : 'completed';

		return (
			<div className={`tool-call-card ${statusClass}`}>
				{/* Card header */}
				<div className="tool-call-card-header tool-call-card-header-readonly">
					<span className="tool-call-icon">
						{isApprovalRequired ? (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
								<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
							</svg>
						) : isRejected ? (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
								<circle cx="12" cy="12" r="10" />
								<line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
							</svg>
						) : isRunning ? (
							<svg className="tool-spinner" width="14" height="14" viewBox="0 0 24 24"
								fill="none" stroke="currentColor" strokeWidth="2.5">
								<path d="M21 12a9 9 0 11-6.219-8.56" />
							</svg>
						) : isError ? (
							<svg width="14" height="14" viewBox="0 0 24 24"
								fill="none" stroke="currentColor" strokeWidth="2.5">
								<circle cx="12" cy="12" r="10" />
								<line x1="15" y1="9" x2="9" y2="15" />
								<line x1="9" y1="9" x2="15" y2="15" />
							</svg>
						) : (
							<svg width="14" height="14" viewBox="0 0 24 24"
								fill="none" stroke="currentColor" strokeWidth="2.5">
								<polyline points="20 6 9 17 4 12" />
							</svg>
						)}
					</span>
					<span className="tool-call-card-name">
						<span className="tool-call-emoji">{display.emoji}</span>
						{toolCall.displayName || display.label}
					</span>
					{display.detail && (
						<span className="tool-call-card-summary" title={display.detail}>
							{display.detail}
						</span>
					)}
					{effectiveRenderType === 'CodeApply' && extractFilePath(toolCall.arguments) && (
						<code
							className="tool-call-card-file-link"
							onClick={(e) => {
								e.stopPropagation();
								const fp = extractFilePath(toolCall.arguments);
								if (fp) { openFile(fp); }
							}}
							title="点击打开文件"
						>
							{extractFilePath(toolCall.arguments)}
						</code>
					)}
					{effectiveRenderType === 'CodeApply' && extractFilePath(toolCall.arguments) && (
						<button
							className="tool-call-card-open-file"
							onClick={(e) => {
								e.stopPropagation();
								const fp = extractFilePath(toolCall.arguments);
								if (fp) { openFile(fp); }
							}}
						>
							查看文件
						</button>
					)}
					{toolCall.duration && !isRunning && (
						<span className="tool-call-duration">
							{formatDuration(toolCall.duration)}
						</span>
					)}
				</div>
				{/* Approval UI */}
				{isApprovalRequired && (
					<ToolApprovalButtons toolCall={toolCall} />
				)}
				{isRejected && (
					<div className="tool-call-rejected-notice">
						<span>用户已拒绝此工具调用</span>
					</div>
				)}
				{/* Specialized body */}
				<div className="tool-call-card-body">
					{effectiveRenderType === 'ListItems' && <ListItemsRenderer toolCall={toolCall} />}
					{effectiveRenderType === 'RunTerminal' && <RunTerminalRenderer toolCall={toolCall} />}
					{effectiveRenderType === 'CodeApply' && <CodeApplyRenderer toolCall={toolCall} />}
				</div>
			</div>
		);
	}

	// Log unrecognized explicit renderType
	if (toolCall.renderType && !KNOWN_RENDER_TYPES.has(toolCall.renderType)) {
		console.warn(
			`[ToolCallCard] Unrecognized renderType: "${toolCall.renderType}" for tool "${toolCall.name}". ` +
			`Known types: ${Array.from(KNOWN_RENDER_TYPES).join(', ')}. Falling back to generic card.`
		);
	}

	// No renderType (explicit or inferred) → generic card (collapsible, with input/output sections)
	return <GenericToolCallCard toolCall={toolCall} />;
}

export const ToolCallCard = memo(ToolCallCardRaw);
