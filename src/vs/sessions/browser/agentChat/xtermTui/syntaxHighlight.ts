/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lightweight syntax highlighter for the xterm.js CLI chat panel.
 *
 * Ported from Hermes-Agent ui-tui/src/lib/syntax.ts.
 * A simple tokenizer that recognizes keywords, strings, numbers, comments
 * for common languages. Not a full parser — just enough for readable
 * code blocks in the terminal.
 */

import type { AnsiTheme } from './ansiTheme.js';

export type Token = [color: number, text: string];  // color 0 = default

interface LangSpec {
	comment: string | null;    // null = no comment syntax
	keywords: Set<string>;
}

const KW = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const TS_KEYWORDS = KW(`
	abstract as async await break case catch class const continue debugger default delete do else enum export extends
	false finally for from function get if implements import in instanceof interface is let new null of package private
	protected public readonly return set static super switch this throw true try type typeof undefined var void while
	with yield
`);

const PY_KEYWORDS = KW(`
	False None True and as assert async await break class continue def del elif else except finally for from global if
	import in is lambda nonlocal not or pass raise return try while with yield self cls
`);

const SH_KEYWORDS = KW(`
	if then else elif fi for in do done while until case esac function return break continue local export readonly
	declare typeset echo printf source
`);

const GO_KEYWORDS = KW(`
	break case chan const continue default defer else fallthrough for func go goto if import interface map package range
	return select struct switch type var nil true false
`);

const RUST_KEYWORDS = KW(`
	as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut
	pub ref return self Self static struct super trait true type unsafe use where while yield
`);

const SQL_KEYWORDS = KW(`
	select from where and or not in is null as by group order limit offset insert into values update set delete create
	table drop alter add column primary key foreign references join left right inner outer on distinct
`);

const YAML_KEYWORDS = KW(`true false null yes no on off`);

const LANGS: Record<string, LangSpec> = {
	go: { comment: '//', keywords: GO_KEYWORDS },
	json: { comment: null, keywords: KW('true false null') },
	py: { comment: '#', keywords: PY_KEYWORDS },
	rust: { comment: '//', keywords: RUST_KEYWORDS },
	sh: { comment: '#', keywords: SH_KEYWORDS },
	sql: { comment: '--', keywords: SQL_KEYWORDS },
	ts: { comment: '//', keywords: TS_KEYWORDS },
	yaml: { comment: '#', keywords: YAML_KEYWORDS },
};

const ALIAS: Record<string, string> = {
	bash: 'sh',
	javascript: 'ts',
	js: 'ts',
	jsx: 'ts',
	python: 'py',
	rs: 'rust',
	shell: 'sh',
	tsx: 'ts',
	typescript: 'ts',
	yml: 'yaml',
	zsh: 'sh',
	css: 'ts',
	less: 'ts',
	scss: 'ts',
};

const resolve = (lang: string): LangSpec | null => {
	const normalized = lang.toLowerCase().trim();
	return LANGS[ALIAS[normalized] ?? normalized] ?? null;
};

/** Whether the given language has syntax highlighting support */
export function isHighlightable(lang: string): boolean {
	return resolve(lang) !== null;
}

// Token regex: strings, numbers, identifiers
const TOKEN_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*/g;

/**
 * Highlight a single line of code.
 * Returns an array of [color, text] tokens.
 * Color 0 means "default" (use the terminal's default foreground).
 */
export function highlightLine(line: string, lang: string, t: AnsiTheme): Token[] {
	const spec = resolve(lang);
	if (!spec) {
		return [[0, line]];
	}

	const tokens: Token[] = [];
	let last = 0;
	const commentChar = spec.comment;

	for (const m of line.matchAll(TOKEN_RE)) {
		const idx = m.index ?? 0;
		const text = m[0];

		// Emit preceding text (whitespace / punctuation)
		if (idx > last) {
			tokens.push([0, line.slice(last, idx)]);
		}

		// String literal
		if (text[0] === '"' || text[0] === "'" || text[0] === '`') {
			tokens.push([t.color.ok, text]);
		}
		// Number
		else if (/^\d/.test(text)) {
			tokens.push([t.color.warn, text]);
		}
		// Keyword
		else if (spec.keywords.has(text)) {
			tokens.push([t.color.accent, text]);
		}
		// Boolean / null for JSON
		else if (text === 'true' || text === 'false' || text === 'null') {
			tokens.push([t.color.warn, text]);
		}
		// Regular identifier
		else {
			// Check if a comment follows on this line
			tokens.push([0, text]);
		}

		last = idx + text.length;
	}

	// Emit trailing text
	if (last < line.length) {
		const trailing = line.slice(last);

		// Check for inline comment
		if (commentChar && trailing.includes(commentChar)) {
			const commentIdx = trailing.indexOf(commentChar);
			if (commentIdx > 0) {
				tokens.push([0, trailing.slice(0, commentIdx)]);
			}
			tokens.push([t.color.muted, trailing.slice(commentIdx)]);
		} else {
			tokens.push([0, trailing]);
		}
	}

	return tokens;
}

/**
 * Render a full code block with syntax highlighting.
 * Returns an array of ANSI-formatted lines (without trailing newlines).
 */
export function highlightCodeBlock(code: string, lang: string, t: AnsiTheme): string[] {
	const lines = code.split('\n');
	const result: string[] = [];

	for (const line of lines) {
		const tokens = highlightLine(line, lang, t);
		const parts: string[] = [];

		for (const [color, text] of tokens) {
			if (color === 0) {
				parts.push(text);
			} else {
				parts.push(`\x1b[38;5;${color}m${text}\x1b[0m`);
			}
		}

		result.push(parts.join(''));
	}

	return result;
}
