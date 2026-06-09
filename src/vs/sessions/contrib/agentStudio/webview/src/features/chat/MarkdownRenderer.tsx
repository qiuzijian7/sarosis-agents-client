/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Shared Markdown Renderer
 *
 *  Unified markdown rendering for both streaming and completed messages.
 *  Ensures consistent rendering with:
 *  - Code syntax highlighting (react-syntax-highlighter)
 *  - Code block collapse/expand with copy button
 *  - Links open in new tab
 *  - Tables with wrapper for horizontal scroll
 *  - Task list support
 *
 *  Used by both AgentChat.tsx (streaming) and ChatMessage.tsx (completed).
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useCallback, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sendRequest } from '../../bridge/messageClient';
import { openFile } from '../../bridge/fileBridge';
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter';

// ── Lazy-loaded syntax highlighting (~47% of bundle) ───────────────
// SyntaxHighlighter drags in highlight.js (1369 KB) + refractor (922 KB).
// The chat first-paint has no code blocks yet, so LazySyntaxHighlighter
// defers these heavy libraries until a code block is actually rendered.

/* ── Constants ────────────────────────────────────────────────── */

/** Maximum text length before we skip full Markdown rendering for performance */
const MAX_MARKDOWN_LENGTH = 40_000;
/** Code blocks larger than this are collapsed by default */
const LARGE_CODE_THRESHOLD = 30;

/* ── Streaming markdown helpers ───────────────────────────────── */

/** Matches a table separator row like `|---|---|` or `| --- | --- |` */
const TABLE_SEPARATOR_RE = /^\s*\|?[\s\-:|]+\|?\s*$/;

/** Detects a line that is part of a markdown table (has pipe characters). */
function isTableRow(line: string): boolean {
	return line.includes('|');
}

/**
 * Pre-processes markdown content to fix common syntax issues and spacing
 * inconsistencies. Applied identically for BOTH streaming and completed
 * messages to guarantee rendering consistency.
 *
 * Problems addressed:
 * 1. Unicode bullet lists (•) are converted to standard markdown (-) so
 *    remark recognizes them as <ul> items instead of plain paragraphs.
 * 2. Missing space after ordered list markers (1.text -> 1. text) so remark
 *    recognizes them as list items rather than plain paragraphs.
 * 3. Fixed-width text tables (space-aligned columns without |) are converted
 *    to real markdown tables so column alignment is preserved.
 * 4. Excessive blank lines between list items are collapsed to prevent
 *    "loose" list rendering with extra <p> wrappers that add unwanted spacing.
 * 5. General runs of 3+ blank lines are collapsed to 2.
 *
 * NOTE: We deliberately do NOT force a space after heading markers
 * (##Title -> ## Title). Per CommonMark a heading requires a space after the
 * leading "#" run, so lines like "#1", "#fff", "#!/bin/bash" must stay plain
 * text. This mirrors the void project's non-interfering approach.
 */
function normalizeStreamingMarkdown(content: string): string {
	// Normalize line endings to \n for consistent regex matching
	let result = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	// NOTE: We intentionally do NOT force a space after heading markers
	//   (e.g. "##Title" -> "## Title"). Per CommonMark, an ATX heading
	//   requires a space after the leading "#" run; without it the line is a
	//   plain paragraph. The previous aggressive normalization turned ANY line
	//   starting with 1-6 "#" immediately followed by a non-space char into a
	//   heading, which mis-rendered ordinary text such as "#1", "#fff",
	//   "#!/bin/bash", "#include", "#123issue" as large headings. Aligning with
	//   the void project, we leave such lines untouched and let remark-gfm
	//   apply standard CommonMark behavior.

	// 2. Convert Unicode bullet lists to standard markdown lists.
	result = result.replace(/^(\s*)•[ \t]/gm, '$1- ');

	// 3. Fix missing space after ordered list markers: "1.text" -> "1. text"
	//    Many models output "1.agent-browser" instead of "1. agent-browser".
	//    Without the space, remark won't recognize it as a list item.
	result = result.replace(/^([ \t]*\d+\.)(\S)/gm, '$1 $2');

	// 4. Convert fixed-width text tables to markdown tables.
	result = normalizeFixedWidthTables(result);

	// 5. Collapse blank lines between consecutive list items to make "tight" lists.
	//    This prevents remark from adding <p> wrappers inside <li> which causes
	//    extra vertical spacing (loose list rendering).
	//    We run this in a loop because collapsing one pair might expose another.
	let prev: string;
	do {
		prev = result;
		// Handle: unordered list items (-/*/+)
		result = result.replace(/^([ \t]*[-*+][ \t]+[^\n]*)\n\n+([ \t]*[-*+][ \t]+)/gm, '$1\n$2');
		// Handle: ordered list items (1. )
		result = result.replace(/^([ \t]*\d+\.[ \t]+[^\n]*)\n\n+([ \t]*\d+\.[ \t]+)/gm, '$1\n$2');
	} while (result !== prev);

	// 6. Collapse blank lines between a list item and its continuation/sub-items.
	//    When streaming, list continuation lines (indented text under a list item)
	//    often arrive separated by blank lines, causing them to break out of the
	//    list context. We collapse the blank line so they stay attached.
	result = result.replace(/^([ \t]*(?:[-*+]|\d+\.)[ \t]+[^\n]*)\n\n+([ \t]{2,}\S)/gm, '$1\n$2');

	// 7. General safety: collapse 3+ consecutive newlines to 2.
	result = result.replace(/\n{3,}/g, '\n\n');

	return result;
}

/**
 * Detects fixed-width text tables (space-aligned columns without `|` pipes)
 * and converts them to standard markdown tables.
 *
 * Example input:
 *   #     名称       描述
 *   42 knot-agent-editor 查看和修改...
 *   43 knot-cli      通过 knot-cli...
 *
 * Becomes:
 *   | # | 名称 | 描述 |
 *   | --- | --- | --- |
 *   | 42 | knot-agent-editor | 查看和修改... |
 */
function normalizeFixedWidthTables(content: string): string {
	const lines = content.split('\n');
	const result: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// Quick reject: must have 2+ segments separated by 3+ spaces
		const trimmed = line.trim();
		const segments = trimmed.split(/\s{3,}/).map(s => s.trim()).filter(Boolean);

		if (segments.length < 2 || line.includes('|') || /^\s*```/.test(line)) {
			result.push(line);
			i++;
			continue;
		}

		// Collect contiguous lines that look like the same table.
		// Allow single blank lines between rows (models often add them during streaming)
		const tableLines: string[] = [line];
		let j = i + 1;
		let hasNumberedRow = /^\s*\d+\s/.test(trimmed);

		while (j < lines.length) {
			const nextLine = lines[j];

			// Allow skipping ONE blank line between table rows
			if (nextLine.trim() === '') {
				const afterBlank = lines[j + 1];
				if (afterBlank) {
					const afterSegs = afterBlank.trim().split(/\s{3,}/).map(s => s.trim()).filter(Boolean);
					if (afterSegs.length >= 2 && !afterBlank.includes('|') && !/^\s*```/.test(afterBlank)) {
						// Skip the blank line and continue collecting
						j++;
						continue;
					}
				}
				break;
			}

			const nextSegs = nextLine.trim().split(/\s{3,}/).map(s => s.trim()).filter(Boolean);
			if (nextSegs.length >= 2 && !nextLine.includes('|') && !/^\s*```/.test(nextLine)) {
				if (/^\s*\d+\s/.test(nextLine.trim())) { hasNumberedRow = true; }
				tableLines.push(nextLine);
				j++;
			} else {
				break;
			}
		}

		// Only convert if at least 2 rows AND at least one row starts with a number
		// (reduces false positives on normal sentences with extra spaces)
		if (tableLines.length >= 2 && hasNumberedRow) {
			result.push(...convertLinesToMarkdownTable(tableLines));
			i = j;
			continue;
		}

		result.push(line);
		i++;
	}

	return result.join('\n');
}

/** Convert a group of fixed-width lines into a markdown table. */
function convertLinesToMarkdownTable(lines: string[]): string[] {
	// Split each line by 3+ spaces
	const rows = lines.map(l =>
		l.trim().split(/\s{3,}/).map(s => s.trim()).filter(s => s.length > 0)
	);

	const maxCols = Math.max(...rows.map(r => r.length));
	if (maxCols < 2) { return lines; }

	// Pad rows so every row has the same column count
	const padded = rows.map(r => {
		while (r.length < maxCols) { r.push(''); }
		return r;
	});

	const out: string[] = [];
	out.push('| ' + padded[0].join(' | ') + ' |');
	out.push('|' + padded[0].map(() => ' --- ').join('|') + '|');
	for (let k = 1; k < padded.length; k++) {
		out.push('| ' + padded[k].join(' | ') + ' |');
	}
	return out;
}

/**
 * During streaming, remark-gfm cannot recognize a table until the separator
 * row (`|---|---|`) is fully received. This causes the table to render as
 * plain text paragraphs while streaming, creating a visual jump when the
 * separator finally arrives and the table "snaps" into place.
 *
 * This helper detects contiguous pipe-table blocks and ensures exactly ONE
 * separator row exists after the first row (header). It processes tables as
 * whole blocks to avoid injecting multiple separators between data rows
 * (which would break into multiple single-row tables).
 */
function normalizeStreamingTables(content: string): string {
	const lines = content.split('\n');
	const result: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		// Not a table row — pass through
		if (!isTableRow(line) || TABLE_SEPARATOR_RE.test(line)) {
			result.push(line);
			i++;
			continue;
		}

		// Found the start of a potential table block.
		// Collect all contiguous pipe-table lines (rows + separators).
		// Also skip single blank lines between rows (models often add them during streaming).
		const tableBlock: string[] = [line];
		let j = i + 1;
		while (j < lines.length) {
			const next = lines[j];
			if (isTableRow(next) || TABLE_SEPARATOR_RE.test(next)) {
				tableBlock.push(next);
				j++;
			} else if (next.trim() === '' && j + 1 < lines.length && isTableRow(lines[j + 1])) {
				// Skip blank line between table rows
				j++;
			} else {
				break;
			}
		}

		// Check if a separator row already exists in this block
		const hasSeparator = tableBlock.some(l => TABLE_SEPARATOR_RE.test(l));

		if (hasSeparator) {
			// Table is well-formed — output as-is
			for (const tl of tableBlock) { result.push(tl); }
		} else if (tableBlock.length >= 2) {
			// No separator found — inject one after the first row (header)
			result.push(tableBlock[0]);
			const cells = tableBlock[0].split('|').map(s => s.trim()).filter(Boolean);
			if (cells.length >= 2) {
				result.push('|' + cells.map(() => ' --- ').join('|') + '|');
			}
			for (let k = 1; k < tableBlock.length; k++) {
				result.push(tableBlock[k]);
			}
		} else {
			// Single pipe-row, no next row yet — output as-is
			result.push(tableBlock[0]);
		}

		i = j;
	}

	return result.join('\n');
}

/* ── CodeBlockWithCollapse ────────────────────────────────────── */

/**
 * Code block with collapse functionality + Apply button (Void-inspired BlockCodeApplyWrapper).
 * Inspired by OpenClaw's markdown.ts which auto-collapses JSON blocks
 * and provides copy buttons + language labels.
 *
 * When a code block has a file path hint in the preceding paragraph
 * (e.g., "In `src/foo.ts`:") or the language tag includes a file path
 * (e.g., ```typescript:path=src/foo.ts), the Apply button appears on
 * hover and allows one-click application of the code to that file.
 */
export function CodeBlockWithCollapse({
	code,
	language,
	isJson,
	isLarge,
	defaultExpanded,
	filePath,
}: {
	code: string;
	language: string;
	isJson: boolean;
	isLarge: boolean;
	defaultExpanded?: boolean;
	/** Optional file path for Apply button (detected from markdown context) */
	filePath?: string;
}): React.ReactElement {
	// JSON blocks and large blocks are collapsed by default (OpenClaw pattern)
	const [expanded, setExpanded] = useState(defaultExpanded ?? !(isJson || isLarge));
	const [copied, setCopied] = useState(false);
	const [applied, setApplied] = useState(false);

	const handleCopy = useCallback(() => {
		navigator.clipboard?.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}).catch(() => { });
	}, [code]);

	const handleApply = useCallback(() => {
		if (!filePath || applied) { return; }
		sendRequest('files.applyCode' as any, {
			path: filePath,
			content: code,
		}).then(() => {
			setApplied(true);
			setTimeout(() => setApplied(false), 3000);
		}).catch((err) => {
			console.error('[CodeBlockWithCollapse] Apply failed:', err);
		});
	}, [filePath, code, applied]);

	const handleOpenFile = useCallback(() => {
		if (filePath) { openFile(filePath); }
	}, [filePath]);

	const lineCount = code.split('\n').length;
	const canApply = !!filePath && !isJson;

	return (
		<div className={`code-block-wrapper ${!expanded ? 'collapsed' : ''}`}>
			<div className="code-block-header">
				<span className="code-block-lang">{language}</span>
				{filePath && (
					<code
						className="code-block-file-path"
						onClick={handleOpenFile}
						title="点击打开文件"
					>
						{filePath}
					</code>
				)}
				{(isJson || isLarge) && (
					<button
						className="code-block-toggle"
						onClick={() => setExpanded(!expanded)}
						title={expanded ? '折叠' : `展开 (${lineCount} 行)`}
					>
						{expanded ? '▼ 折叠' : `▶ 展开 (${lineCount} 行)`}
					</button>
				)}
				{canApply && (
					<button
						className={`code-block-apply-btn ${applied ? 'applied' : ''}`}
						onClick={handleApply}
						title={applied ? '已应用!' : '应用到文件'}
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							{applied
								? <polyline points="20 6 9 17 4 12" />
								: <><path d="M12 5v14M5 12h14" /></>
							}
						</svg>
						{applied ? '已应用' : '应用'}
					</button>
				)}
				<button
					className="code-block-copy"
					onClick={handleCopy}
					title={copied ? '已复制!' : '复制代码'}
				>
					{copied ? (
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					) : (
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
							<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
						</svg>
					)}
				</button>
			</div>
			{expanded && (
				<LazySyntaxHighlighter code={code} language={language} lineCount={lineCount} />
			)}
		</div>
	);
}

/* ── Shared ReactMarkdown components config ───────────────────── */

/**
 * Custom component overrides for ReactMarkdown.
 * Shared between streaming and completed message rendering
 * to ensure visual consistency.
 */
const markdownComponents = {
	code({ className, children, ...props }: any) {
		const match = /language-(\w+)/.exec(className || '');
		const codeStr = String(children).replace(/\n$/, '');
		const lineCount = codeStr.split('\n').length;
		const isJson = match?.[1]?.toLowerCase() === 'json';
		const isLarge = lineCount > LARGE_CODE_THRESHOLD;

		if (match) {
			// Check for file path in language tag: ```typescript:path=src/foo.ts
			let filePath: string | undefined;
			const langPart = match[1];
			const pathInLang = /(\w+):path=(.+)/.exec(className || '');
			const actualLang = pathInLang ? pathInLang[1] : langPart;
			if (pathInLang) {
				filePath = pathInLang[2];
			}

			return (
				<CodeBlockWithCollapse
					code={codeStr}
					language={actualLang}
					isJson={isJson}
					isLarge={isLarge}
					filePath={filePath}
				/>
			);
		}
		return (
			<code className={`inline-code ${className || ''}`} {...props}>
				{children}
			</code>
		);
	},
	// Links open in new tab
	a({ href, children, ...props }: any) {
		return (
			<a href={href} target="_blank" rel="noopener noreferrer" {...props}>
				{children}
			</a>
		);
	},
	// Tables with proper styling
	table({ children, ...props }: any) {
		return (
			<div className="table-wrapper">
				<table {...props}>{children}</table>
			</div>
		);
	},
	// Task list support (OpenClaw uses markdown-it-task-lists)
	li({ children, className, ...props }: any) {
		if (className === 'task-list-item') {
			return <li className="task-list-item" {...props}>{children}</li>;
		}
		return <li {...props}>{children}</li>;
	},
};

/* ── Content Part Splitting (VS Code pattern: split into typed parts) ─── */

/** A renderable content part — inspired by VS Code's IChatRendererContent */
interface ContentPart {
	kind: 'markdown' | 'codeblock';
	content: string;
	language?: string;
	/** Stable key for React reconciliation (avoids re-mount) */
	key: string;
}

/**
 * Split normalized markdown into stable content parts.
 * This is the key insight from VS Code's architecture: instead of re-parsing
 * the entire markdown on every streaming frame, we split it into parts and
 * only re-render the part that actually changed (usually the last one).
 *
 * Fenced code blocks become separate `codeblock` parts so they can be
 * independently memoized and avoid re-triggering the full markdown AST parse.
 */
function splitContentParts(normalizedContent: string): ContentPart[] {
	const parts: ContentPart[] = [];
	const lines = normalizedContent.split('\n');
	let currentMarkdown: string[] = [];
	let inCodeBlock = false;
	let codeBlockLang = '';
	let codeBlockLines: string[] = [];
	let partIndex = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fenceMatch = /^(\s*`{3,})(\w*)/.exec(line);

		if (fenceMatch && !inCodeBlock) {
			// Start of code block — flush accumulated markdown
			if (currentMarkdown.length > 0) {
				const text = currentMarkdown.join('\n');
				if (text.trim()) {
					parts.push({ kind: 'markdown', content: text, key: `md-${partIndex++}` });
				}
				currentMarkdown = [];
			}
			inCodeBlock = true;
			codeBlockLang = fenceMatch[2] || 'text';
			codeBlockLines = [];
		} else if (inCodeBlock && /^\s*`{3,}\s*$/.test(line)) {
			// End of code block
			parts.push({
				kind: 'codeblock',
				content: codeBlockLines.join('\n'),
				language: codeBlockLang,
				key: `code-${partIndex++}`,
			});
			inCodeBlock = false;
			codeBlockLang = '';
			codeBlockLines = [];
		} else if (inCodeBlock) {
			codeBlockLines.push(line);
		} else {
			currentMarkdown.push(line);
		}
	}

	// Flush remaining
	if (inCodeBlock) {
		// Incomplete code block (still streaming) — render as code block anyway
		parts.push({
			kind: 'codeblock',
			content: codeBlockLines.join('\n'),
			language: codeBlockLang,
			key: `code-${partIndex++}`,
		});
	}
	if (currentMarkdown.length > 0) {
		const text = currentMarkdown.join('\n');
		if (text.trim()) {
			parts.push({ kind: 'markdown', content: text, key: `md-${partIndex++}` });
		}
	}

	return parts;
}

/* ── Memoized Part Renderers ─────────────────────────────────── */

/** Renders a single markdown part — memoized to avoid re-parse when unchanged */
const MarkdownPartRenderer = memo(function MarkdownPartRenderer({
	content,
}: {
	content: string;
}): React.ReactElement {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={markdownComponents}
		>
			{content}
		</ReactMarkdown>
	);
});

/** Renders a code block part — independently memoized */
const CodeBlockPartRenderer = memo(function CodeBlockPartRenderer({
	code,
	language,
}: {
	code: string;
	language: string;
}): React.ReactElement {
	const lineCount = code.split('\n').length;
	const isJson = language?.toLowerCase() === 'json';
	const isLarge = lineCount > LARGE_CODE_THRESHOLD;

	return (
		<CodeBlockWithCollapse
			code={code}
			language={language}
			isJson={isJson}
			isLarge={isLarge}
		/>
	);
});

/* ── Public Component ─────────────────────────────────────────── */

interface MarkdownRendererProps {
	content: string;
	className?: string;
	showCursor?: boolean;
}

/**
 * Unified Markdown renderer for both streaming and completed content.
 *
 * Architecture (inspired by VS Code Copilot Chat):
 * 1. Same normalization pipeline always applied (streaming = final)
 * 2. Content split into stable "parts" (markdown segments + code blocks)
 * 3. Each part is independently memoized — only the changed part re-renders
 * 4. Append-only optimization: when streaming appends to the last part,
 *    only that final part is re-parsed by react-markdown
 *
 * This eliminates the O(n) full re-parse on every streaming frame that
 * would otherwise happen with a single <ReactMarkdown> for the entire content.
 */
function MarkdownRendererInner({ content, className, showCursor }: MarkdownRendererProps): React.ReactElement {
	// Performance guard: very long messages get plain-text rendering
	if (content.length > MAX_MARKDOWN_LENGTH) {
		return (
			<pre className="message-plain-text">
				{content.substring(0, MAX_MARKDOWN_LENGTH)}
				{'\n\n... [内容过长，已截断显示]'}
			</pre>
		);
	}

	// Always apply the full normalization pipeline for BOTH streaming and
	// completed content. This is the key to rendering consistency.
	const normalizedContent = normalizeStreamingTables(normalizeStreamingMarkdown(content));

	// Split into parts for granular memoization (VS Code pattern)
	// useMemo ensures we don't re-split unless content actually changes.
	const parts = useMemo(() => splitContentParts(normalizedContent), [normalizedContent]);

	return (
		<div className={className ?? 'markdown-body'}>
			{parts.map((part) => {
				if (part.kind === 'codeblock') {
					return (
						<CodeBlockPartRenderer
							key={part.key}
							code={part.content}
							language={part.language || 'text'}
						/>
					);
				}
				return (
					<MarkdownPartRenderer
						key={part.key}
						content={part.content}
					/>
				);
			})}
			{showCursor && <span className="cursor-blink">▊</span>}
		</div>
	);
}

export const MarkdownRenderer = memo(MarkdownRendererInner);

/* ── Interleaved Markdown + Tool Calls ────────────────────────── */

interface InterleavedMarkdownProps extends MarkdownRendererProps {
	/** Tool call cards to interleave between content parts */
	toolCallNodes?: React.ReactNode[];
	/** Tool call position hints: maps toolCallId -> character offset in content.
	 *  Used to position tool cards at the exact position where tool_start occurred. */
	toolPositions?: Map<string, number>;
}

/**
 * Renders markdown content with tool call cards interleaved between content parts.
 *
 * Instead of grouping all tool cards at the top of the message, this component
 * distributes them throughout the text content so they appear near the relevant
 * paragraphs.  Tool cards are inserted in the gaps between markdown parts
 * (paragraphs / code blocks) for a natural reading flow.
 */
function InterleavedMarkdownRendererInner({ content, className, showCursor, toolCallNodes, toolPositions }: InterleavedMarkdownProps): React.ReactElement {
	// Performance guard
	if (content.length > MAX_MARKDOWN_LENGTH) {
		const plainTextNode = (
			<pre className="message-plain-text" key="plain">
				{content.substring(0, MAX_MARKDOWN_LENGTH)}
				{'\n\n... [内容过长，已截断显示]'}
			</pre>
		);
		return (
			<div className={className ?? 'markdown-body'}>
				{plainTextNode}
				{toolCallNodes}
				{showCursor && <span className="cursor-blink">▊</span>}
			</div>
		);
	}

	const normalizedContent = normalizeStreamingTables(normalizeStreamingMarkdown(content));
	const parts = useMemo(() => splitContentParts(normalizedContent), [normalizedContent]);
	const cards = toolCallNodes ?? [];

	// If no cards, delegate to standard renderer (avoid duplicating logic)
	if (cards.length === 0) {
		return (
			<div className={className ?? 'markdown-body'}>
				{parts.map((part) => {
					if (part.kind === 'codeblock') {
						return <CodeBlockPartRenderer key={part.key} code={part.content} language={part.language || 'text'} />;
					}
					return <MarkdownPartRenderer key={part.key} content={part.content} />;
				})}
				{showCursor && <span className="cursor-blink">▊</span>}
			</div>
		);
	}

	// ── Placeholder-based interleaving (precise ordering from backend) ──
	// When the backend inserts <!--TOOL_CARD:tool_call_id--> markers into the
	// text, we use them to position tool cards exactly where they belong.
	const TOOL_CARD_RE = /<!--TOOL_CARD:([^>]+)-->/g;
	const hasPlaceholders = TOOL_CARD_RE.test(normalizedContent);

	if (hasPlaceholders) {
		const sequence: React.ReactNode[] = [];
		const cardMap = new Map<string, React.ReactNode>();
		const renderedIds = new Set<string>();

		// Build map: toolCallId -> card node
		React.Children.forEach(cards, (node) => {
			if (React.isValidElement(node)) {
				const tcId = (node.props as any)?.toolCall?.id ?? node.key;
				if (tcId && typeof tcId === 'string') {
					cardMap.set(tcId, node);
				}
			}
		});

		// Reset regex state and walk through placeholders in order
		TOOL_CARD_RE.lastIndex = 0;
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = TOOL_CARD_RE.exec(normalizedContent)) !== null) {
			const textBefore = normalizedContent.slice(lastIndex, match.index);
			const toolCallId = match[1].trim();

			// Render text before this placeholder
			if (textBefore.trim()) {
				const fragParts = splitContentParts(textBefore);
				for (const part of fragParts) {
					if (part.kind === 'codeblock') {
						sequence.push(<CodeBlockPartRenderer key={`${part.key}-${lastIndex}`} code={part.content} language={part.language || 'text'} />);
					} else {
						sequence.push(<MarkdownPartRenderer key={`${part.key}-${lastIndex}`} content={part.content} />);
					}
				}
			}

			// Render the tool card (only once per id)
			if (!renderedIds.has(toolCallId)) {
				const card = cardMap.get(toolCallId);
				if (card) {
					sequence.push(<React.Fragment key={`tc-${toolCallId}`}>{card}</React.Fragment>);
					renderedIds.add(toolCallId);
				}
			}

			lastIndex = match.index + match[0].length;
			// Skip newline immediately after placeholder to avoid extra blank line in rendering.
			// A single \n after placeholder is just a visual separator in source, not content.
			if (normalizedContent[lastIndex] === '\n') {
				lastIndex++;
			}
		}

		// Render remaining text after last placeholder
		const textAfter = normalizedContent.slice(lastIndex);
		if (textAfter.trim()) {
			const fragParts = splitContentParts(textAfter);
			for (const part of fragParts) {
				if (part.kind === 'codeblock') {
					sequence.push(<CodeBlockPartRenderer key={`${part.key}-end`} code={part.content} language={part.language || 'text'} />);
				} else {
					sequence.push(<MarkdownPartRenderer key={`${part.key}-end`} content={part.content} />);
				}
			}
		}

		// Append any cards that weren't placed by a placeholder (orphans)
		for (let i = 0; i < cards.length; i++) {
			const node = cards[i];
			if (React.isValidElement(node)) {
				const tcId = (node.props as any)?.toolCall?.id ?? node.key;
				if (tcId && typeof tcId === 'string' && !renderedIds.has(tcId)) {
					sequence.push(<React.Fragment key={`tc-${tcId}-orphan`}>{node}</React.Fragment>);
					renderedIds.add(tcId);
				}
			}
		}

		return (
			<div className={className ?? 'markdown-body'}>
				{sequence}
				{showCursor && <span className="cursor-blink">▊</span>}
			</div>
		);
	}

	// ── Position-based interleaving (textPosition from tool_start) ──
	// When toolPositions are provided, we use the character offset recorded
	// at tool_start time to place cards at the exact position in the text.
	if (toolPositions && toolPositions.size > 0) {
		const sequence: React.ReactNode[] = [];
		const renderedIds = new Set<string>();

		// Build card map: toolCallId -> card node
		const cardMap = new Map<string, React.ReactNode>();
		React.Children.forEach(cards, (node) => {
			if (React.isValidElement(node)) {
				const tcId = (node.props as any)?.toolCall?.id ?? node.key;
				if (tcId && typeof tcId === 'string') {
					cardMap.set(tcId, node);
				}
			}
		});

		// Sort tool positions by offset for ordered placement.
		// CRITICAL: Filter out positions beyond content length — these occur when
		// textPosition was recorded against raw text (before sanitization stripped
		// tool-call artifacts). Including them would dump all text before the first
		// card and stack every remaining card at the end.
		const sortedPositions = Array.from(toolPositions.entries())
			.filter(([id, offset]) => cardMap.has(id) && offset < normalizedContent.length)
			.sort(([, a], [, b]) => a - b);

		// If NO valid positions remain after filtering, fall through to the
		// keyword-based fallback so cards get distributed naturally instead of
		// being dumped at the bottom.
		if (sortedPositions.length > 0) {
			// Walk through the normalizedContent character by character,
			// inserting tool cards at their recorded positions.
			let prevOffset = 0;
			let partIdx = 0;

			for (const [toolCallId, offset] of sortedPositions) {
				if (renderedIds.has(toolCallId)) { continue; }

				// Get the text segment before this tool card's position
				const textBefore = normalizedContent.slice(prevOffset, offset);
				if (textBefore.trim()) {
					const fragParts = splitContentParts(textBefore);
					for (const part of fragParts) {
						if (part.kind === 'codeblock') {
							sequence.push(<CodeBlockPartRenderer key={`pos-${partIdx}`} code={part.content} language={part.language || 'text'} />);
						} else {
							sequence.push(<MarkdownPartRenderer key={`pos-${partIdx}`} content={part.content} />);
						}
						partIdx++;
					}
				}

				// Insert the tool card
				const card = cardMap.get(toolCallId);
				if (card) {
					sequence.push(<React.Fragment key={`tc-${toolCallId}`}>{card}</React.Fragment>);
					renderedIds.add(toolCallId);
				}

				prevOffset = offset;
			}

			// Render remaining text after the last tool card
			const textAfter = normalizedContent.slice(prevOffset);
			if (textAfter.trim()) {
				const fragParts = splitContentParts(textAfter);
				for (const part of fragParts) {
					if (part.kind === 'codeblock') {
						sequence.push(<CodeBlockPartRenderer key={`pos-end-${partIdx}`} code={part.content} language={part.language || 'text'} />);
					} else {
						sequence.push(<MarkdownPartRenderer key={`pos-end-${partIdx}`} content={part.content} />);
					}
					partIdx++;
				}
			}

			// Append any orphan cards (no position info or invalid position)
			for (let i = 0; i < cards.length; i++) {
				const node = cards[i];
				if (React.isValidElement(node)) {
					const tcId = (node.props as any)?.toolCall?.id ?? node.key;
					if (tcId && typeof tcId === 'string' && !renderedIds.has(tcId)) {
						sequence.push(<React.Fragment key={`tc-${tcId}-orphan`}>{node}</React.Fragment>);
						renderedIds.add(tcId);
					}
				}
			}

			return (
				<div className={className ?? 'markdown-body'}>
					{sequence}
					{showCursor && <span className="cursor-blink">▊</span>}
				</div>
			);
		}
	}

	// ── FALLBACK: keyword-based distribution (when no placeholders or positions) ──
	// Distribute tool cards across the gaps between content parts.
	// Strategy: try to place cards near relevant content by matching keywords
	// in the tool call name/args against nearby text content. If no match,
	// fall back to even distribution across gaps.
	const result: React.ReactNode[] = [];
	const placedCards = new Set<number>();

	// Helper: extract keywords from a tool call card for matching
	function extractToolKeywords(card: React.ReactNode): string[] {
		const keyStr = JSON.stringify(card).toLowerCase();
		const keywords: string[] = [];
		// Extract tool name patterns
		const nameMatch = keyStr.match(/"name"\s*:\s*"([^"]+)"/);
		if (nameMatch) { keywords.push(nameMatch[1]); }
		// Extract file paths
		const pathMatches = keyStr.match(/(?:path|filepath|file_path)"?\s*[:=]\s*"([^"]+)"/gi);
		if (pathMatches) {
			pathMatches.forEach(m => {
				const p = m.replace(/.*?"([^"]+)".*/, '$1');
				if (p) { keywords.push(p.toLowerCase()); }
			});
		}
		return keywords;
	}

	// Phase 1: Place cards near matching content parts
	parts.forEach((part, i) => {
		// Render the content part
		if (part.kind === 'codeblock') {
			result.push(<CodeBlockPartRenderer key={part.key} code={part.content} language={part.language || 'text'} />);
		} else {
			result.push(<MarkdownPartRenderer key={part.key} content={part.content} />);
		}

		// Try to find a card whose keywords match this part's content
		const partText = (part.content || '').toLowerCase();
		for (let c = 0; c < cards.length; c++) {
			if (placedCards.has(c)) { continue; }
			const keywords = extractToolKeywords(cards[c]);
			const hasMatch = keywords.some(kw => partText.includes(kw));
			if (hasMatch) {
				result.push(<React.Fragment key={`tc-${c}`}>{cards[c]}</React.Fragment>);
				placedCards.add(c);
				break; // Only place one matching card per gap to avoid clustering
			}
		}
	});

	// Phase 2: Evenly distribute remaining unplaced cards across all gaps
	const remainingCards = cards.map((c, i) => ({ card: c, idx: i })).filter(c => !placedCards.has(c.idx));
	if (remainingCards.length > 0) {
		const gapCount = Math.max(parts.length, 1);
		const basePerGap = Math.floor(remainingCards.length / gapCount);
		const remainder = remainingCards.length % gapCount;
		let remainingIdx = 0;

		// Rebuild result: insert remaining cards at evenly spaced positions
		const newResult: React.ReactNode[] = [];
		let partIdx = 0;
		for (let i = 0; i < result.length; i++) {
			newResult.push(result[i]);
			// After each content part, insert assigned remaining cards
			if (partIdx < parts.length && result[i] && (result[i] as any).key && String((result[i] as any).key).startsWith('md-') || String((result[i] as any).key).startsWith('code-')) {
				const cardsForThisGap = basePerGap + (partIdx < remainder ? 1 : 0);
				for (let k = 0; k < cardsForThisGap && remainingIdx < remainingCards.length; k++) {
					const { card, idx } = remainingCards[remainingIdx];
					newResult.push(<React.Fragment key={`tc-${idx}`}>{card}</React.Fragment>);
					remainingIdx++;
				}
				partIdx++;
			}
		}
		// Append any still-remaining cards at the end
		while (remainingIdx < remainingCards.length) {
			const { card, idx } = remainingCards[remainingIdx];
			newResult.push(<React.Fragment key={`tc-${idx}`}>{card}</React.Fragment>);
			remainingIdx++;
		}
		result.length = 0;
		result.push(...newResult);
	}

	return (
		<div className={className ?? 'markdown-body'}>
			{result}
			{showCursor && <span className="cursor-blink">▊</span>}
		</div>
	);
}

export const InterleavedMarkdownRenderer = memo(InterleavedMarkdownRendererInner);
