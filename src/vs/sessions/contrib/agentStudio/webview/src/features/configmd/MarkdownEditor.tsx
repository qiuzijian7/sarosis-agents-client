/*---------------------------------------------------------------------------------------------
 *  MarkdownEditor — VSCode-style code editor for Markdown source.
 *
 *  Implementation: a transparent textarea is overlaid on top of a syntax-highlighted
 *  <pre> layer, with a synchronised line-number gutter on the left. This gives:
 *    • Real native editing (cursor, IME, undo/redo, copy/paste)
 *    • Tokenized Markdown syntax highlighting
 *    • Line numbers like VSCode
 *    • Theme variable support
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

interface MarkdownEditorProps {
	value: string;
	onChange?: (next: string) => void;
	readOnly?: boolean;
	placeholder?: string;
	minHeight?: string;
	className?: string;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

type Token = { text: string; cls?: string };

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Token-level Markdown highlighter — fast, line-oriented, good enough for editor display.
 * Returns sanitized HTML.
 */
function highlightLine(line: string, inFence: boolean): { html: string; toggleFence: boolean } {
	// Code fence boundary
	if (/^```/.test(line)) {
		return { html: `<span class="md-tk-fence">${escapeHtml(line)}</span>`, toggleFence: true };
	}
	if (inFence) {
		return { html: `<span class="md-tk-code">${escapeHtml(line)}</span>`, toggleFence: false };
	}
	// HTML comment / agent anchor
	if (/^<!--/.test(line) || /-->/.test(line)) {
		return { html: `<span class="md-tk-anchor">${escapeHtml(line)}</span>`, toggleFence: false };
	}
	// Heading
	const h = /^(#{1,6})(\s+)(.*)$/.exec(line);
	if (h) {
		return {
			html:
				`<span class="md-tk-heading-mark">${escapeHtml(h[1])}</span>` +
				`${escapeHtml(h[2])}` +
				`<span class="md-tk-heading">${escapeHtml(h[3])}</span>`,
			toggleFence: false,
		};
	}
	// Blockquote
	const bq = /^(\s*>+\s?)(.*)$/.exec(line);
	if (bq) {
		return {
			html: `<span class="md-tk-quote-mark">${escapeHtml(bq[1])}</span>${highlightInline(bq[2])}`,
			toggleFence: false,
		};
	}
	// Todo list
	const todo = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/.exec(line);
	if (todo) {
		return {
			html:
				`<span class="md-tk-list">${escapeHtml(todo[1])}</span>` +
				`<span class="md-tk-task">${escapeHtml(todo[2])}</span>` +
				`<span class="md-tk-list">${escapeHtml(todo[3])}</span>` +
				`${highlightInline(todo[4])}`,
			toggleFence: false,
		};
	}
	// Unordered list
	const ul = /^(\s*[-*+]\s+)(.*)$/.exec(line);
	if (ul) {
		return {
			html: `<span class="md-tk-list">${escapeHtml(ul[1])}</span>${highlightInline(ul[2])}`,
			toggleFence: false,
		};
	}
	// Ordered list
	const ol = /^(\s*\d+\.\s+)(.*)$/.exec(line);
	if (ol) {
		return {
			html: `<span class="md-tk-list">${escapeHtml(ol[1])}</span>${highlightInline(ol[2])}`,
			toggleFence: false,
		};
	}
	// HR
	if (/^(\s*)([-*_])\2{2,}\s*$/.test(line)) {
		return { html: `<span class="md-tk-hr">${escapeHtml(line)}</span>`, toggleFence: false };
	}
	// Plain
	return { html: highlightInline(line) || '\u200b', toggleFence: false };
}

function highlightInline(text: string): string {
	if (!text) { return ''; }
	const parts: string[] = [];
	let i = 0;
	const len = text.length;
	// Hard safety guard: bail out if we somehow fail to advance `i` on an
	// iteration. Without this, a malformed input (e.g. an unclosed backtick
	// or `**` token) used to cause `parts.push(...)` to run forever, which
	// eventually overflowed the array and threw `RangeError: Invalid array
	// length` — taking down the entire ConfigMD tab. We log loudly when this
	// happens so it can be diagnosed instead of silently freezing the UI.
	let watchdog = 0;
	while (i < len) {
		const before = i;
		const ch = text[i];
		// Inline code `xxx`
		if (ch === '`') {
			const j = text.indexOf('`', i + 1);
			if (j > i) {
				parts.push(`<span class="md-tk-code-inline">${escapeHtml(text.slice(i, j + 1))}</span>`);
				i = j + 1;
				continue;
			}
		}
		// Bold ** **
		if (ch === '*' && text[i + 1] === '*') {
			const j = text.indexOf('**', i + 2);
			if (j > i + 1) {
				parts.push(`<span class="md-tk-bold">${escapeHtml(text.slice(i, j + 2))}</span>`);
				i = j + 2;
				continue;
			}
		}
		// Italic * *
		if (ch === '*') {
			const j = text.indexOf('*', i + 1);
			if (j > i) {
				parts.push(`<span class="md-tk-italic">${escapeHtml(text.slice(i, j + 1))}</span>`);
				i = j + 1;
				continue;
			}
		}
		// Link [txt](url)
		if (ch === '[') {
			const m = /^\[([^\]]+)\]\(([^)]+)\)/.exec(text.slice(i));
			if (m) {
				parts.push(
					`<span class="md-tk-link-text">${escapeHtml('[' + m[1] + ']')}</span>` +
					`<span class="md-tk-link-url">${escapeHtml('(' + m[2] + ')')}</span>`,
				);
				i += m[0].length;
				continue;
			}
		}
		// Default: accumulate plain run. We start at i+1 (not i) so that the
		// special trigger char (`, *, [) is consumed verbatim when it doesn't
		// open a valid token — guaranteeing forward progress on every loop.
		let j = i + 1;
		while (j < len && !'`*['.includes(text[j])) { j++; }
		parts.push(escapeHtml(text.slice(i, j)));
		i = j;
		// Watchdog: should never fire, but if it does we abort cleanly.
		if (i === before) {
			// eslint-disable-next-line no-console
			console.warn(`[MarkdownEditor] highlightInline failed to advance at i=${i}; aborting to avoid infinite loop`);
			break;
		}
		if (++watchdog > len * 4 + 100) {
			// eslint-disable-next-line no-console
			console.warn(`[MarkdownEditor] highlightInline watchdog tripped (len=${len}, parts=${parts.length}); aborting`);
			break;
		}
	}
	return parts.join('');
}

function highlightAll(source: string): { lineHtmls: string[] } {
	const lines = source.split('\n');
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		const r = highlightLine(line, inFence);
		out.push(r.html);
		if (r.toggleFence) { inFence = !inFence; }
	}
	return { lineHtmls: out };
}

// ─── Component ───────────────────────────────────────────────────────────────

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
	value,
	onChange,
	readOnly,
	placeholder,
	minHeight,
	className,
}) => {
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const preRef = useRef<HTMLPreElement | null>(null);
	const gutterRef = useRef<HTMLDivElement | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	const lineHtmls = useMemo(() => highlightAll(value || '').lineHtmls, [value]);
	const lineCount = lineHtmls.length;

	const syncScroll = useCallback(() => {
		const ta = taRef.current;
		const pre = preRef.current;
		const gutter = gutterRef.current;
		if (!ta || !pre || !gutter) { return; }
		pre.scrollTop = ta.scrollTop;
		pre.scrollLeft = ta.scrollLeft;
		gutter.scrollTop = ta.scrollTop;
	}, []);

	useLayoutEffect(() => { syncScroll(); }, [value, syncScroll]);

	const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		onChange?.(e.target.value);
	}, [onChange]);

	// Tab key inserts 2-space indent
	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Tab' && !readOnly) {
			e.preventDefault();
			const ta = e.currentTarget;
			const start = ta.selectionStart;
			const end = ta.selectionEnd;
			const insert = '  ';
			const next = ta.value.slice(0, start) + insert + ta.value.slice(end);
			onChange?.(next);
			requestAnimationFrame(() => {
				ta.selectionStart = ta.selectionEnd = start + insert.length;
			});
		}
	}, [onChange, readOnly]);

	useEffect(() => {
		const ta = taRef.current;
		if (!ta) { return; }
		ta.addEventListener('scroll', syncScroll, { passive: true });
		return () => ta.removeEventListener('scroll', syncScroll);
	}, [syncScroll]);

	const gutterWidth = String(lineCount).length;

	return (
		<div
			ref={wrapRef}
			className={`md-editor ${className || ''}`}
			style={{ minHeight: minHeight || '100%' }}
		>
			<div
				ref={gutterRef}
				className="md-editor-gutter"
				aria-hidden
				style={{ ['--md-gutter-width' as any]: `${gutterWidth}ch` }}
			>
				{Array.from({ length: lineCount }, (_, i) => (
					<div key={i} className="md-editor-lineno">{i + 1}</div>
				))}
			</div>
			<div className="md-editor-content">
				<pre ref={preRef} className="md-editor-highlight" aria-hidden>
					{lineHtmls.map((h, i) => (
						<div
							key={i}
							className="md-editor-line"
							dangerouslySetInnerHTML={{ __html: h || '\u200b' }}
						/>
					))}
				</pre>
				<textarea
					ref={taRef}
					className="md-editor-textarea"
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					readOnly={readOnly}
					placeholder={placeholder}
					spellCheck={false}
					autoCorrect="off"
					autoCapitalize="off"
				/>
			</div>
		</div>
	);
};
