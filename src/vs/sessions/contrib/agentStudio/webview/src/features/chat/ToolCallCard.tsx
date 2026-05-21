/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Tool Call Card Component
 *
 *  Enhanced tool call card inspired by OpenClaw's tool-cards.ts:
 *  - Collapsed summary with icon + tool name + status indicator
 *  - Expanded view with formatted input/output sections
 *  - Streaming argument preview (partial JSON display)
 *  - Result truncation with "show more" toggle
 *  - Copy button for args/results
 *  - Error state styling
 *  - Duration display
 *
 *  Ref: OpenClaw ui/src/ui/chat/tool-cards.ts
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useCallback, useMemo, useState } from 'react';
import { sanitizeToolResultText } from '../../utils/assistantVisibleText';

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
}

interface ToolCallCardProps {
	toolCall: ToolCallData;
}

/** Max chars to show in result preview before truncating */
const RESULT_PREVIEW_LIMIT = 500;
/** Max chars to show in expanded result before "show all" */
const RESULT_EXPANDED_LIMIT = 5000;

/**
 * Get a human-readable display name for a tool.
 * Maps internal tool names to friendly labels.
 */
function getToolDisplayName(name: string): string {
	const displayNames: Record<string, string> = {
		terminal: '终端命令',
		read_file: '读取文件',
		write_file: '写入文件',
		search_files: '搜索文件',
		list_files: '列出文件',
		edit_file: '编辑文件',
		web_search: '网络搜索',
		browser: '浏览器',
	};
	return displayNames[name] || name;
}

/**
 * Get an icon/emoji for a tool based on its name.
 */
function getToolIcon(name: string): string {
	const icons: Record<string, string> = {
		terminal: '⌨️',
		read_file: '📄',
		write_file: '✏️',
		search_files: '🔍',
		list_files: '📂',
		edit_file: '📝',
		web_search: '🌐',
		browser: '🖥️',
		memory: '🧠',
		todo: '📋',
	};
	return icons[name] || '🔧';
}

/**
 * Format duration for display.
 */
function formatDuration(ms: number): string {
	if (ms < 1000) { return `${ms}ms`; }
	if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function ToolCallCardRaw({ toolCall }: ToolCallCardProps): React.ReactElement | null {
	// If defaultShow is false, don't render this tool call card
	if (toolCall.defaultShow === false) {
		return null;
	}
	
	const [expanded, setExpanded] = useState(false);
	const [showFullResult, setShowFullResult] = useState(false);
	const [copiedField, setCopiedField] = useState<string | null>(null);

	const isRunning = toolCall.status === 'running';
	const isError = toolCall.status === 'error' || !!toolCall.error;

	// Cache formatted JSON to avoid re-parsing on every render
	const formattedArgs = useMemo(() => {
		const raw = toolCall.arguments || '';
		if (!raw || raw === '{}') { return ''; }
		try {
			const parsed = JSON.parse(raw);
			// For simple single-argument tools, show inline preview
			const keys = Object.keys(parsed);
			return JSON.stringify(parsed, null, 2);
		} catch {
			return raw;
		}
	}, [toolCall.arguments]);

	// Generate a one-line summary of the arguments for collapsed view
	const argsSummary = useMemo(() => {
		const raw = toolCall.arguments || '';
		if (!raw || raw === '{}') { return ''; }
		try {
			const parsed = JSON.parse(raw);
			const keys = Object.keys(parsed);
			if (keys.length === 0) { return ''; }
			// Show first meaningful argument value as summary
			const firstKey = keys[0];
			const firstVal = parsed[firstKey];
			if (typeof firstVal === 'string') {
				const display = firstVal.length > 50 ? firstVal.substring(0, 50) + '...' : firstVal;
				return display;
			}
			return `${keys.length} 个参数`;
		} catch {
			return '';
		}
	}, [toolCall.arguments]);

	const formattedResult = useMemo(() => {
		const raw = toolCall.result || '';
		if (!raw) { return ''; }
		// Sanitize tool result: strip reasoning tags and other artifacts
		const cleaned = sanitizeToolResultText(raw);
		try {
			const parsed = JSON.parse(cleaned);
			return JSON.stringify(parsed, null, 2);
		} catch {
			return cleaned;
		}
	}, [toolCall.result]);

	// Determine if result is truncated
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

	return (
		<div className={`tool-call-card ${isRunning ? 'running' : isError ? 'error' : 'completed'}`}>
			{/* ── Collapsed Header (OpenClaw: renderCollapsedToolSummary) ── */}
			<div
				className="tool-call-card-header"
				onClick={() => setExpanded(!expanded)}
				role="button"
				aria-expanded={expanded}
			>
				<span className="tool-call-icon">
					{isRunning ? (
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
					<span className="tool-call-emoji">{getToolIcon(toolCall.name)}</span>
					{getToolDisplayName(toolCall.name)}
				</span>
				{/* Args summary in collapsed view */}
				{!expanded && argsSummary && (
					<span className="tool-call-card-summary" title={argsSummary}>
						{argsSummary}
					</span>
				)}
				{/* Duration badge */}
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

			{/* ── Expanded Body (OpenClaw: renderExpandedToolCardContent) ── */}
			{expanded && (
				<div className="tool-call-card-body">
					{/* Input section */}
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

					{/* Output section */}
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

					{/* Error message (separate from result) */}
					{toolCall.error && !formattedResult && (
						<div className="tool-call-section">
							<div className="tool-call-section-header">
								<span className="tool-call-section-title">错误</span>
							</div>
							<pre className="tool-call-code error-output">{toolCall.error}</pre>
						</div>
					)}

					{/* Running state: streaming args indicator */}
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

export const ToolCallCard = memo(ToolCallCardRaw);
