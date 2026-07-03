/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ANSI theme system for the xterm.js CLI chat panel.
 *
 * Ported from Hermes-Agent ui-tui/src/theme.ts, adapted for VS Code's
 * CSS-variable-based theming. Colors are resolved at runtime from
 * --vscode-* CSS variables and mapped to ANSI 256-color codes.
 */

export interface AnsiThemeColors {
	primary: number;
	accent: number;
	border: number;
	text: number;
	muted: number;
	error: number;
	warn: number;
	ok: number;
	diffAdded: number;
	diffRemoved: number;
	diffAddedBg: number;
	diffRemovedBg: number;
	shellDollar: number;
	statusFg: number;
}

export interface AnsiTheme {
	color: AnsiThemeColors;
	brand: {
		prompt: string;   // ❯
		tool: string;     // ┊
	};
}

/** ANSI escape sequence builder */
export const Ansi = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	italic: '\x1b[3m',
	underline: '\x1b[4m',
	strikethrough: '\x1b[9m',
	inverse: '\x1b[7m',
	fg: (n: number) => `\x1b[38;5;${n}m`,
	bg: (n: number) => `\x1b[48;5;${n}m`,
	fgRgb: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
	bgRgb: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,
	cursorUp: (n: number) => `\x1b[${n}A`,
	cursorDown: (n: number) => `\x1b[${n}B`,
	cursorTo: (col: number, row?: number) => row !== undefined ? `\x1b[${row + 1};${col + 1}H` : `\x1b[${col + 1}G`,
	clearLine: '\x1b[2K',
	clearLineRight: '\x1b[0K',
	saveCursor: '\x1b7',
	restoreCursor: '\x1b8',
	newLine: '\r\n',
} as const;

// ── Color math (ported from Hermes theme.ts) ──────────────────────────

function parseHex(h: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
	if (!m) { return null; }
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function parseRgb(rgb: string): [number, number, number] | null {
	const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(rgb.trim());
	if (!m) { return null; }
	return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function parseColor(s: string): [number, number, number] | null {
	if (!s) { return null; }
	return parseHex(s) ?? parseRgb(s);
}

function rgbToAnsi256(r: number, g: number, b: number): number {
	// Grayscale check
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max === min) {
		// Grayscale
		if (r < 8) { return 16; }
		if (r > 248) { return 231; }
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	// 6x6x6 color cube
	const sixR = r < 95 ? 0 : Math.floor((r - 95) / 40) + 1;
	const sixG = g < 95 ? 0 : Math.floor((g - 95) / 40) + 1;
	const sixB = b < 95 ? 0 : Math.floor((b - 95) / 40) + 1;
	return 16 + 36 * sixR + 6 * sixG + sixB;
}

/** Parse any CSS color string (hex / rgb / rgba) → ANSI 256 code */
function colorToAnsi256(color: string): number {
	const rgb = parseColor(color);
	if (!rgb) { return 255; } // default white
	return rgbToAnsi256(rgb[0], rgb[1], rgb[2]);
}

/** Read a VS Code CSS variable and convert to ANSI 256 */
function cssVarToAnsi(varName: string, fallback: string): number {
	const el = document.documentElement;
	const style = getComputedStyle(el);
	const value = style.getPropertyValue(varName).trim() || fallback;
	return colorToAnsi256(value);
}

/**
 * Create an ANSI theme from VS Code's CSS variables.
 * Falls back to dark-theme defaults if variables are not available.
 */
export function createAnsiThemeFromCssVars(): AnsiTheme {
	return {
		color: {
			primary: cssVarToAnsi('--vscode-textLink-foreground', '#4aa3ff'),
			accent: cssVarToAnsi('--vscode-textLink-foreground', '#4aa3ff'),
			border: cssVarToAnsi('--vscode-panel-border', '#444444'),
			text: cssVarToAnsi('--vscode-foreground', '#d4d4d4'),
			muted: cssVarToAnsi('--vscode-descriptionForeground', '#888888'),
			error: cssVarToAnsi('--vscode-errorForeground', '#f48771'),
			warn: cssVarToAnsi('--vscode-editorWarning-foreground', '#cca700'),
			ok: cssVarToAnsi('--vscode-testing-iconPassed', '#4ade80'),
			diffAdded: colorToAnsi256('#4ade80'),
			diffRemoved: colorToAnsi256('#f48771'),
			diffAddedBg: colorToAnsi256('rgba(74,222,128,0.12)'),
			diffRemovedBg: colorToAnsi256('rgba(244,135,113,0.12)'),
			shellDollar: colorToAnsi256('#4dabf7'),
			statusFg: cssVarToAnsi('--vscode-descriptionForeground', '#888888'),
		},
		brand: {
			prompt: '\u276f',  // ❯
			tool: '\u250a',     // ┊
		},
	};
}

// ── Helper functions ──────────────────────────────────────────────────

/** Apply a foreground color, returning the ANSI prefix */
export function fg(n: number): string { return Ansi.fg(n); }

/** Apply a background color, returning the ANSI prefix */
export function bg(n: number): string { return Ansi.bg(n); }

/** Wrap text in a foreground color with reset */
export function colorize(text: string, color: number): string {
	return `${Ansi.fg(color)}${text}${Ansi.reset}`;
}

/** Wrap text in bold with reset */
export function bold(text: string): string {
	return `${Ansi.bold}${text}${Ansi.reset}`;
}

/** Wrap text in dim with reset */
export function dim(text: string): string {
	return `${Ansi.dim}${text}${Ansi.reset}`;
}

/** Wrap text in italic with reset */
export function italic(text: string): string {
	return `${Ansi.italic}${text}${Ansi.reset}`;
}

/** Repeat a character to create a horizontal rule */
export function hr(char: string, cols: number, color: number): string {
	return colorize(char.repeat(Math.max(1, cols)), color);
}

/** Format milliseconds as a human-readable duration */
export function formatDuration(ms: number): string {
	const s = ms / 1000;
	if (s < 10) { return `${s.toFixed(1)}s`; }
	if (s < 60) { return `${Math.round(s)}s`; }
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return `${m}m${rem}s`;
}

/** Format a token count with k suffix for large numbers */
export function formatK(n: number): string {
	if (n >= 1000) { return `${(n / 1000).toFixed(1)}k`; }
	return String(n);
}
