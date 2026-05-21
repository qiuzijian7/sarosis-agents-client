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
 *  Used by both EmployeeChat.tsx (streaming) and ChatMessage.tsx (completed).
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useCallback, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

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
 * 1. Missing space after heading markers (##Title -> ## Title). Models often
 *    output headings without the required space, causing them to render as
 *    plain text instead of <h2>..<h6> elements.
 * 2. Unicode bullet lists (•) are converted to standard markdown (-) so
 *    remark recognizes them as <ul> items instead of plain paragraphs.
 * 3. Missing space after ordered list markers (1.text -> 1. text) so remark
 *    recognizes them as list items rather than plain paragraphs.
 * 4. Fixed-width text tables (space-aligned columns without |) are converted
 *    to real markdown tables so column alignment is preserved.
 * 5. Excessive blank lines between list items are collapsed to prevent
 *    "loose" list rendering with extra <p> wrappers that add unwanted spacing.
 * 6. General runs of 3+ blank lines are collapsed to 2.
 */
function normalizeStreamingMarkdown(content: string): string {
	// Normalize line endings to \n for consistent regex matching
	let result = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	// 1. Fix missing space after heading markers: ##Title -> ## Title
	//    Uses \S instead of [^#\s] to safely handle emoji surrogate pairs.
	result = result.replace(/^([ \t]*#{1,6})(\S)(.*)$/gm, '$1 $2$3');

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
 * Code block with collapse functionality.
 * Inspired by OpenClaw's markdown.ts which auto-collapses JSON blocks
 * and provides copy buttons + language labels.
 */
export function CodeBlockWithCollapse({
	code,
	language,
	isJson,
	isLarge,
	defaultExpanded,
}: {
	code: string;
	language: string;
	isJson: boolean;
	isLarge: boolean;
	defaultExpanded?: boolean;
}): React.ReactElement {
	// JSON blocks and large blocks are collapsed by default (OpenClaw pattern)
	const [expanded, setExpanded] = useState(defaultExpanded ?? !(isJson || isLarge));
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		navigator.clipboard?.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}).catch(() => { });
	}, [code]);

	const lineCount = code.split('\n').length;

	return (
		<div className={`code-block-wrapper ${!expanded ? 'collapsed' : ''}`}>
			<div className="code-block-header">
				<span className="code-block-lang">{language}</span>
				{(isJson || isLarge) && (
					<button
						className="code-block-toggle"
						onClick={() => setExpanded(!expanded)}
						title={expanded ? '折叠' : `展开 (${lineCount} 行)`}
					>
						{expanded ? '▼ 折叠' : `▶ 展开 (${lineCount} 行)`}
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
				<SyntaxHighlighter
					style={oneDark}
					language={language}
					PreTag="div"
					customStyle={{
						margin: 0,
						borderRadius: '0 0 6px 6px',
						fontSize: '12px',
						lineHeight: '1.5',
					}}
					showLineNumbers={lineCount > 10}
					wrapLongLines={true}
				>
					{code}
				</SyntaxHighlighter>
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
			return (
				<CodeBlockWithCollapse
					code={codeStr}
					language={match[1]}
					isJson={isJson}
					isLarge={isLarge}
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
	const isJson = language.toLowerCase() === 'json';
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

	// DEBUG: Check if normalization is fixing headings
	if (content !== normalizedContent) {
		const rawHeadings = (content.match(/^#{1,6}\S.*/gm) || []);
		const fixedHeadings = (normalizedContent.match(/^#{1,6}\S.*/gm) || []);
		if (rawHeadings.length > 0 || fixedHeadings.length > 0) {
			console.log('[MarkdownRenderer] Heading normalization:', {
				rawHeadings: rawHeadings.slice(0, 3),
				fixedHeadings: fixedHeadings.slice(0, 3),
				contentLen: content.length,
				normalizedLen: normalizedContent.length,
			});
		}
	}

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
