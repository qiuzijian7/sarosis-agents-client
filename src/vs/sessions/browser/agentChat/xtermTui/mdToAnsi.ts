/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Markdown → ANSI converter for the xterm.js CLI chat panel.
 *
 * Ported from Hermes-Agent ui-tui/src/components/markdown.tsx.
 * Parses markdown text and converts it to ANSI escape sequences for
 * rendering in an xterm.js terminal instance.
 *
 * Supported markdown features:
 *  - Headings (# ## ### etc.)
 *  - Code blocks (```lang ... ```) with syntax highlighting
 *  - Inline code (`code`)
 *  - Bold (**text** / __text__)
 *  - Italic (*text* / _text_)
 *  - Strikethrough (~~text~~)
 *  - Highlight (==text==)
 *  - Links [text](url) and bare URLs
 *  - Unordered lists (- / * / +)
 *  - Ordered lists (1. 2. etc.)
 *  - Task lists [x] / [ ]
 *  - Blockquotes (>)
 *  - Tables
 *  - Horizontal rules (---)
 *  - Diff code blocks (green/red background)
 */

import { Ansi, type AnsiTheme } from './ansiTheme.js';
import { highlightCodeBlock, isHighlightable } from './syntaxHighlight.js';

export interface MdRenderOptions {
	/** Terminal column count (for wrapping) */
	cols: number;
	/** Compact mode: no blank lines between blocks */
	compact?: boolean;
	/** Left padding (in characters) */
	paddingLeft?: number;
	/** ANSI theme */
	t: AnsiTheme;
}

// ── Regexes (ported from Hermes markdown.tsx) ──────────────────────────

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/;
const BULLET_RE = /^(\s*)[-+*]\s+(.*)$/;
const TASK_RE = /^\[( |x|X)\]\s+(.*)$/;
const NUMBERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*(?:>\s*)+/;
const TABLE_DIVIDER_CELL_RE = /^:?-{3,}:?$/;

// Inline markdown regex — order matters (leftmost match wins)
const INLINE_RE = new RegExp(
	[
		`!\\[(.*?)\\]\\(((?:[^\\s()]|\\([^\\s()]*\\))+?)\\)`,  // 1,2 image
		`\\[(.+?)\\]\\(((?:[^\\s()]|\\([^\\s()]*\\))+?)\\)`,  // 3,4 link
		`~~(.+?)~~`,         // 5    strike
		`\`([^\\\`]+)\``,     // 6    code
		`\\*\\*(.+?)\\*\\*`,  // 7    bold *
		`__(.+?)__`,          // 8    bold _
		`\\*(.+?)\\*`,        // 9    italic *
		`_(.+?)_`,            // 10   italic _
		`==(.+?)==`,          // 11   highlight
		`(https?:\\/\\/[^\\s<]+)`,  // 12   bare URL
	].join('|'),
	'g',
);

// ── Helpers ────────────────────────────────────────────────────────────

const indentDepth = (s: string) => Math.floor(s.replace(/\t/g, '  ').length / 2);

const splitRow = (row: string) =>
	row
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map(c => c.trim());

const isTableDivider = (row: string) => {
	const cells = splitRow(row);
	return cells.length > 1 && cells.every(c => TABLE_DIVIDER_CELL_RE.test(c));
};

/** Strip inline markdown markup to get plain text (for table width calc) */
function stripInlineMarkup(v: string): string {
	return v
		.replace(/!\[(.*?)\]\(((?:[^\s()]|\([^\s()]*\))+?)\)/g, '[image: $1] $2')
		.replace(/\[(.+?)\]\(((?:[^\s()]|\([^\s()]*\))+?)\)/g, '$1')
		.replace(/~~(.+?)~~/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/__(.+?)__/g, '$1')
		.replace(/\*(.+?)\*/g, '$1')
		.replace(/_(.+?)_/g, '$1')
		.replace(/==(.+?)==/g, '$1');
}

// ── Inline markdown → ANSI ─────────────────────────────────────────────

/** Render inline markdown (bold, italic, code, links) as ANSI string */
function renderInlineAnsi(text: string, t: AnsiTheme): string {
	let result = '';
	let last = 0;

	for (const m of text.matchAll(INLINE_RE)) {
		const idx = m.index ?? 0;
		if (idx > last) {
			result += text.slice(last, idx);
		}

		if (m[1] !== undefined && m[2] !== undefined) {
			// Image
			result += `${Ansi.fg(t.color.muted)}[image: ${m[1]}] ${m[2]}${Ansi.reset}`;
		} else if (m[3] !== undefined && m[4] !== undefined) {
			// Link
			result += `${Ansi.fg(t.color.accent)}${Ansi.underline}${m[3]}${Ansi.reset}`;
		} else if (m[5] !== undefined) {
			// Strikethrough
			result += `${Ansi.strikethrough}${m[5]}${Ansi.reset}`;
		} else if (m[6] !== undefined) {
			// Inline code
			result += `${Ansi.fg(t.color.ok)}${m[6]}${Ansi.reset}`;
		} else if (m[7] !== undefined) {
			// Bold *
			result += `${Ansi.bold}${renderInlineAnsi(m[7], t)}${Ansi.reset}`;
		} else if (m[8] !== undefined) {
			// Bold _
			result += `${Ansi.bold}${renderInlineAnsi(m[8], t)}${Ansi.reset}`;
		} else if (m[9] !== undefined) {
			// Italic *
			result += `${Ansi.italic}${renderInlineAnsi(m[9], t)}${Ansi.reset}`;
		} else if (m[10] !== undefined) {
			// Italic _
			result += `${Ansi.italic}${renderInlineAnsi(m[10], t)}${Ansi.reset}`;
		} else if (m[11] !== undefined) {
			// Highlight
			result += `${Ansi.inverse}${Ansi.bold}${m[11]}${Ansi.reset}`;
		} else if (m[12] !== undefined) {
			// Bare URL — trim trailing punctuation
			const url = m[12].replace(/[),.;:!?]+$/, '');
			result += `${Ansi.fg(t.color.accent)}${Ansi.underline}${url}${Ansi.reset}`;
			if (url.length < m[12].length) {
				result += m[12].slice(url.length);
			}
		}

		last = idx + m[0].length;
	}

	if (last < text.length) {
		result += text.slice(last);
	}

	return result;
}

// ── Code block rendering ──────────────────────────────────────────────

function renderCodeBlock(code: string, lang: string, cols: number, t: AnsiTheme): string {
	const lines = code.split('\n');
	const parts: string[] = [];
	const padLeft = '  ';

	// Language label
	if (lang) {
		parts.push(`${Ansi.fg(t.color.muted)}\u2500 ${lang}${Ansi.reset}\r\n`);
	}

	const isDiff = lang === 'diff';
	const highlightable = !isDiff && isHighlightable(lang);

	if (highlightable) {
		// Syntax highlighted code
		const highlighted = highlightCodeBlock(code, lang, t);
		for (const line of highlighted) {
			parts.push(`${padLeft}${line}\r\n`);
		}
	} else if (isDiff) {
		// Diff: green/red background
		for (const line of lines) {
			const add = line.startsWith('+');
			const del = line.startsWith('-');
			const hunk = line.startsWith('@@');

			if (add) {
				parts.push(`${Ansi.bg(t.color.diffAddedBg)}${Ansi.fg(t.color.diffAdded)}${padLeft}${line}${Ansi.reset}\r\n`);
			} else if (del) {
				parts.push(`${Ansi.bg(t.color.diffRemovedBg)}${Ansi.fg(t.color.diffRemoved)}${padLeft}${line}${Ansi.reset}\r\n`);
			} else if (hunk) {
				parts.push(`${Ansi.fg(t.color.muted)}${padLeft}${line}${Ansi.reset}\r\n`);
			} else {
				parts.push(`${Ansi.dim}${padLeft}${line}${Ansi.reset}\r\n`);
			}
		}
	} else {
		// Plain code block
		for (const line of lines) {
			parts.push(`${Ansi.dim}${padLeft}${line}${Ansi.reset}\r\n`);
		}
	}

	return parts.join('');
}

// ── Table rendering ────────────────────────────────────────────────────

function renderTable(rows: string[][], cols: number, t: AnsiTheme): string {
	if (rows.length === 0) { return ''; }

	const numCols = rows[0]!.length;
	const cellWidth = (raw: string) => stripInlineMarkup(raw).length;

	// Calculate column widths
	const idealWidths = rows[0]!.map((_, ci) =>
		Math.max(...rows.map(r => cellWidth(r[ci] ?? '')), 3),
	);

	// Available width
	const gapOverhead = (numCols - 1) * 2;
	const available = cols - 2 - gapOverhead; // 2 for paddingLeft

	// Scale down if needed
	let columnWidths = idealWidths;
	const totalIdeal = idealWidths.reduce((a, b) => a + b, 0);
	if (totalIdeal > available) {
		const scale = available / totalIdeal;
		columnWidths = idealWidths.map(w => Math.max(3, Math.floor(w * scale)));
	}

	const sep = columnWidths.map(w => '\u2500'.repeat(Math.max(1, w))).join('  ');

	const parts: string[] = [];

	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri]!;
		const isHeader = ri === 0;
		const isDivider = ri === 1 && rows.length > 2 && isTableDividerRow(row);

		if (isDivider) { continue; }

		const cells = row.slice(0, numCols);
		const line = cells.map((cell, ci) => {
			const text = stripInlineMarkup(cell);
			const width = columnWidths[ci] ?? 3;
			const padded = text + ' '.repeat(Math.max(0, width - text.length));
			return padded;
		}).join('  ');

		if (isHeader) {
			parts.push(`${Ansi.bold}${Ansi.fg(t.color.accent)}  ${line}${Ansi.reset}\r\n`);
			if (rows.length > 1) {
				parts.push(`${Ansi.fg(t.color.muted)}  ${sep}${Ansi.reset}\r\n`);
			}
		} else {
			parts.push(`  ${line}\r\n`);
		}
	}

	return parts.join('');
}

function isTableDividerRow(row: string[]): boolean {
	return row.every(c => TABLE_DIVIDER_CELL_RE.test(c.trim()));
}

// ── Main markdown renderer ─────────────────────────────────────────────

/**
 * Convert markdown text to ANSI escape sequences.
 * 
 * @param text Markdown source text
 * @param opts Render options (cols, theme, etc.)
 * @returns ANSI-formatted string ready for terminal.write()
 */
export function renderMarkdownToAnsi(text: string, opts: MdRenderOptions): string {
	const { cols, compact, paddingLeft = 0, t } = opts;
	const lines = text.split('\n');
	const parts: string[] = [];
	const pad = ' '.repeat(paddingLeft);
	let i = 0;

	const addGap = () => {
		if (!compact && parts.length > 0) {
			// Check if last part already ends with blank line
			const last = parts[parts.length - 1];
			if (last && !last.endsWith('\r\n\r\n')) {
				parts.push('\r\n');
			}
		}
	};

	while (i < lines.length) {
		const line = lines[i]!;

		// Skip blank lines in compact mode
		if (!line.trim()) {
			if (!compact) { addGap(); }
			i++;
			continue;
		}

		// ── Code block ──
		const fence = line.match(FENCE_RE);
		if (fence) {
			const lang = fence[2]!.trim().toLowerCase();
			const block: string[] = [];
			for (i++; i < lines.length; i++) {
				if (FENCE_CLOSE_RE.test(lines[i]!)) { break; }
				block.push(lines[i]!);
			}
			if (i < lines.length) { i++; } // skip closing fence

			addGap();
			parts.push(renderCodeBlock(block.join('\n'), lang, cols - paddingLeft, t));
			parts.push('\r\n');
			continue;
		}

		// ── Heading ──
		const heading = line.match(HEADING_RE)?.[2];
		if (heading) {
			addGap();
			const level = line.match(HEADING_RE)![1]!.length;
			const color = level <= 2 ? t.color.accent : t.color.primary;
			parts.push(`${pad}${Ansi.fg(color)}${Ansi.bold}${renderInlineAnsi(heading, t)}${Ansi.reset}\r\n`);
			i++;
			continue;
		}

		// ── Horizontal rule ──
		if (HR_RE.test(line)) {
			addGap();
			parts.push(`${pad}${Ansi.fg(t.color.border)}${'\u2500'.repeat(Math.min(36, cols - paddingLeft))}${Ansi.reset}\r\n`);
			i++;
			continue;
		}

		// ── Task list item ──
		const bullet = line.match(BULLET_RE);
		if (bullet) {
			const indent = indentDepth(bullet[1]!) * 2 + paddingLeft;
			const task = bullet[2]!.match(TASK_RE);
			if (task) {
				const marker = task[1]!.toLowerCase() === 'x' ? '\u2611' : '\u2610'; // ☑ / ☐
				parts.push(`${' '.repeat(indent)}${Ansi.fg(t.color.muted)}${marker} ${Ansi.reset}${renderInlineAnsi(task[2]!, t)}\r\n`);
			} else {
				parts.push(`${' '.repeat(indent)}${Ansi.fg(t.color.muted)}\u2022 ${Ansi.reset}${renderInlineAnsi(bullet[2]!, t)}\r\n`);
			}
			i++;
			continue;
		}

		// ── Numbered list ──
		const numbered = line.match(NUMBERED_RE);
		if (numbered) {
			const indent = indentDepth(numbered[1]!) * 2 + paddingLeft;
			parts.push(`${' '.repeat(indent)}${Ansi.fg(t.color.muted)}${numbered[2]}. ${Ansi.reset}${renderInlineAnsi(numbered[3]!, t)}\r\n`);
			i++;
			continue;
		}

		// ── Blockquote ──
		if (QUOTE_RE.test(line)) {
			const quoteLines: string[] = [];
			while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
				const prefix = lines[i]!.match(QUOTE_RE)?.[0] ?? '';
				quoteLines.push(lines[i]!.slice(prefix.length));
				i++;
			}
			for (const ql of quoteLines) {
				parts.push(`${pad}${Ansi.fg(t.color.muted)}\u2502 ${renderInlineAnsi(ql, t)}${Ansi.reset}\r\n`);
			}
			continue;
		}

		// ── Table ──
		if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]!)) {
			const rows: string[][] = [splitRow(line)];
			for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) {
				rows.push(splitRow(lines[i]!));
			}
			addGap();
			parts.push(renderTable(rows, cols - paddingLeft, t));
			parts.push('\r\n');
			continue;
		}

		// ── Regular paragraph ──
		parts.push(`${pad}${renderInlineAnsi(line, t)}\r\n`);
		i++;
	}

	return parts.join('');
}

// ── Streaming support ──────────────────────────────────────────────────

/**
 * Find the last stable block boundary in streaming text.
 * A stable boundary is a blank line outside of any code block.
 *
 * Ported from Hermes streamingMarkdown.tsx.
 * Used to split streaming text into a cached stable prefix and
 * a re-rendered unstable suffix for incremental updates.
 */
export function findStableBoundary(text: string): number {
	let codeOpen = false;
	let lastBoundary = 0;
	let offset = 0;
	const lines = text.split('\n');

	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();

		if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
			codeOpen = !codeOpen;
		}

		if (!codeOpen && !trimmed) {
			lastBoundary = offset + line.length + 1;
		}

		offset += line.length + 1;
	}

	return lastBoundary;
}

/**
 * Render streaming markdown: split at stable boundary, return both parts.
 * The stable prefix can be cached; only the unstable suffix needs re-rendering.
 */
export function renderStreamingMarkdown(
	text: string,
	opts: MdRenderOptions,
	cachedPrefix: string | null,
): { stableAnsi: string; unstableAnsi: string; newBoundary: number } {
	const boundary = findStableBoundary(text);
	const stableText = text.slice(0, boundary);
	const unstableText = text.slice(boundary);

	const stableAnsi = cachedPrefix ?? renderMarkdownToAnsi(stableText, opts);
	const unstableAnsi = renderMarkdownToAnsi(unstableText, opts);

	return {
		stableAnsi,
		unstableAnsi,
		newBoundary: boundary,
	};
}
