/*---------------------------------------------------------------------------------------------
 *  HtmlEditor — VSCode-style code editor for HTML source.
 *
 *  Same architecture as MarkdownEditor (transparent textarea over a syntax-highlighted
 *  <pre> layer with a synced gutter), but tokenizes HTML instead of Markdown:
 *    • Tags, attribute names, attribute values, comments
 *    • Embedded <style> / <script> bodies rendered as plain code
 *    • Line numbers like VSCode
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

interface HtmlEditorProps {
	value: string;
	onChange?: (next: string) => void;
	readOnly?: boolean;
	placeholder?: string;
	minHeight?: string;
	className?: string;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Highlight the inside of a single tag (between `<` and `>`), e.g.
 *   div class="x" data-oid="o1"
 * Returns sanitized HTML with spans for tag name / attr name / attr value.
 */
function highlightTagInner(inner: string): string {
	// First token = tag name (may start with `/`).
	const m = /^(\/?[a-zA-Z][\w:-]*)([\s\S]*)$/.exec(inner);
	if (!m) { return escapeHtml(inner); }
	const tagName = m[1];
	const rest = m[2];
	let out = `<span class="ht-tk-tagname">${escapeHtml(tagName)}</span>`;

	// Walk the rest, highlighting attr="value" / attr='value' / attr / =
	let i = 0;
	const len = rest.length;
	let guard = 0;
	while (i < len) {
		const before = i;
		const ch = rest[i];
		// Whitespace run
		if (/\s/.test(ch)) {
			let j = i + 1;
			while (j < len && /\s/.test(rest[j])) { j++; }
			out += escapeHtml(rest.slice(i, j));
			i = j;
		} else if (ch === '=') {
			out += '<span class="ht-tk-punct">=</span>';
			i++;
		} else if (ch === '"' || ch === "'") {
			const close = rest.indexOf(ch, i + 1);
			const end = close === -1 ? len : close + 1;
			out += `<span class="ht-tk-attrvalue">${escapeHtml(rest.slice(i, end))}</span>`;
			i = end;
		} else if (ch === '/' || ch === '>') {
			out += `<span class="ht-tk-punct">${escapeHtml(ch)}</span>`;
			i++;
		} else {
			// Attribute name run
			let j = i + 1;
			while (j < len && !/[\s='"\/>]/.test(rest[j])) { j++; }
			out += `<span class="ht-tk-attrname">${escapeHtml(rest.slice(i, j))}</span>`;
			i = j;
		}
		if (i === before) { out += escapeHtml(rest.slice(i)); break; }
		if (++guard > len * 4 + 100) { out += escapeHtml(rest.slice(i)); break; }
	}
	return out;
}

/**
 * Whole-document HTML highlighter. Splits into segments: comments, tags, and
 * text, wrapping each with token spans. Returns one HTML string per source line
 * so the <pre> layer can render line-by-line and stay aligned with the gutter.
 */
function highlightAll(source: string): { lineHtmls: string[] } {
	// Produce a single highlighted HTML string, then split on the original
	// newlines. We track newlines by highlighting the source as a stream and
	// re-emitting '\n' verbatim.
	let html = '';
	let i = 0;
	const len = source.length;
	let guard = 0;
	while (i < len) {
		const before = i;
		// Comment <!-- ... -->
		if (source.startsWith('<!--', i)) {
			const end = source.indexOf('-->', i + 4);
			const stop = end === -1 ? len : end + 3;
			html += `<span class="ht-tk-comment">${escapeHtml(source.slice(i, stop))}</span>`;
			i = stop;
		} else if (source[i] === '<') {
			const end = source.indexOf('>', i + 1);
			const stop = end === -1 ? len : end + 1;
			const inner = source.slice(i + 1, end === -1 ? len : end);
			html += '<span class="ht-tk-punct">&lt;</span>';
			html += highlightTagInner(inner);
			if (end !== -1) { html += '<span class="ht-tk-punct">&gt;</span>'; }
			i = stop;
		} else {
			// Text run until next '<'
			let j = source.indexOf('<', i);
			if (j === -1) { j = len; }
			html += escapeHtml(source.slice(i, j));
			i = j;
		}
		if (i === before) { html += escapeHtml(source.slice(i)); break; }
		if (++guard > len * 2 + 100) { html += escapeHtml(source.slice(i)); break; }
	}
	// Split into lines on the (escaped) newlines. Because escapeHtml leaves
	// '\n' untouched, splitting on '\n' is safe and keeps spans intact only if
	// no span straddles a newline. To be safe against multi-line spans (e.g. a
	// multi-line comment), we instead highlight line-by-line below.
	void html; // (the streaming version above is kept for reference)

	// ── Line-oriented pass with carry-over state for multi-line comments ──
	const lines = source.split('\n');
	const out: string[] = [];
	let inComment = false;
	for (const line of lines) {
		const r = highlightLineWithState(line, inComment);
		out.push(r.html || '\u200b');
		inComment = r.inComment;
	}
	return { lineHtmls: out };
}

function highlightLineWithState(line: string, inComment: boolean): { html: string; inComment: boolean } {
	let html = '';
	let i = 0;
	const len = line.length;
	let stillComment = inComment;
	let guard = 0;

	if (inComment) {
		const end = line.indexOf('-->');
		if (end === -1) {
			return { html: `<span class="ht-tk-comment">${escapeHtml(line)}</span>`, inComment: true };
		}
		html += `<span class="ht-tk-comment">${escapeHtml(line.slice(0, end + 3))}</span>`;
		i = end + 3;
		stillComment = false;
	}

	while (i < len) {
		const before = i;
		if (line.startsWith('<!--', i)) {
			const end = line.indexOf('-->', i + 4);
			if (end === -1) {
				html += `<span class="ht-tk-comment">${escapeHtml(line.slice(i))}</span>`;
				return { html, inComment: true };
			}
			html += `<span class="ht-tk-comment">${escapeHtml(line.slice(i, end + 3))}</span>`;
			i = end + 3;
		} else if (line[i] === '<') {
			const end = line.indexOf('>', i + 1);
			const inner = line.slice(i + 1, end === -1 ? len : end);
			html += '<span class="ht-tk-punct">&lt;</span>';
			html += highlightTagInner(inner);
			if (end !== -1) { html += '<span class="ht-tk-punct">&gt;</span>'; i = end + 1; }
			else { i = len; }
		} else {
			let j = line.indexOf('<', i);
			if (j === -1) { j = len; }
			html += escapeHtml(line.slice(i, j));
			i = j;
		}
		if (i === before) { html += escapeHtml(line.slice(i)); break; }
		if (++guard > len * 4 + 100) { html += escapeHtml(line.slice(i)); break; }
	}
	return { html, inComment: stillComment };
}

// ─── Component ───────────────────────────────────────────────────────────────

export const HtmlEditor: React.FC<HtmlEditorProps> = ({
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
			className={`md-editor html-editor ${className || ''}`}
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
