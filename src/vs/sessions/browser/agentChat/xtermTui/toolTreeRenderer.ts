/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tool trail tree renderer for the xterm.js CLI chat panel.
 *
 * Ported from Hermes-Agent ui-tui/src/components/thinking.tsx (ToolTrail).
 * Renders tool calls, thinking, and subagent trees as ANSI strings
 * with tree-branch characters (├─ └─ │) and collapsible sections.
 *
 * Structure:
 *  ├─ ▸ Thinking (~123 tokens)           ← collapsible
 *  │   └─ thinking text...
 *  ├─ ▸ Tool calls (3)  ~456 tokens       ← collapsible
 *  │   ├─ ● spinner tool_name [args] (2.3s)
 *  │   ├─ ● ✓ tool_name result preview
 *  │   └─ ● ✗ tool_name error message
 *  └─ Σ ~579 total
 */

import { Ansi, type AnsiTheme, formatDuration, formatK } from './ansiTheme.js';

// ── Types ─────────────────────────────────────────────────────────────

export type ToolStatus = 'running' | 'success' | 'error' | 'pending';

export interface ToolCallInfo {
	id: string;
	name: string;
	args?: string;
	result?: string;
	status: ToolStatus;
	startedAt?: number;
	durationMs?: number;
	displayName?: string;
	/** Sub-agent tool calls (for Task/Delegate tools) */
	subTools?: ToolCallInfo[];
	/** Error message (when status === 'error') */
	error?: string;
}

export interface ThinkingInfo {
	text: string;
	isRunning: boolean;
	durationMs?: number;
	tokenCount?: number;
}

export interface ToolRenderOptions {
	/** Terminal column count */
	cols: number;
	/** ANSI theme */
	t: AnsiTheme;
	/** Expanded section IDs: 'thinking', 'tools', 'tool-<id>-result', etc. */
	expandedSections: Set<string>;
	/** Current spinner frame for running indicators */
	spinnerFrame: string;
}
// (cols is used by callers for width calculation in future; currently the
// tree width adapts to content)

// ── Tree branch characters ─────────────────────────────────────────────

type TreeBranch = 'mid' | 'last';
type TreeRails = readonly boolean[];

const TREE_MID = '\u251c\u2500 ';  // ├─
const TREE_LAST = '\u2514\u2500 ';  // └─
const TREE_PIPE = '\u2502   ';       // │
const TREE_SPACE = '    ';           // (spaces)

function nextRails(rails: TreeRails, branch: TreeBranch): boolean[] {
	return [...rails, branch === 'mid'];
}

function treeLead(rails: TreeRails, branch: TreeBranch): string {
	const stem = rails.map(on => on ? TREE_PIPE : TREE_SPACE).join('');
	return `${stem}${branch === 'mid' ? TREE_MID : TREE_LAST}`;
}

// ── Tool icon mapping ──────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
	// Shell / terminal
	bash: '$', terminal: '$', run_command: '$', run_terminal_cmd: '$',
	execute_code: '$', process: '$',
	// File read
	read: '\u2192', read_file: '\u2192', file_read: '\u2192',
	// File write / edit
	write: '\u2190', write_file: '\u2190', rewrite_file: '\u2190', file_write: '\u2190',
	edit: '\u2190', edit_file: '\u2190', replace_in_file: '\u2190',
	apply_patch: '\u2190', patch: '\u2190',
	// Search
	grep: '\u2731', search_content: '\u2731', search_files: '\u2731', search_in_file: '\u2731',
	file_list: '\u2731', ls_dir: '\u2731', list_files: '\u2731', get_dir_tree: '\u2731',
	search_pathnames_only: '\u2731', search_for_files: '\u2731',
	// Web
	web_fetch: '%', http_get: '%', web_search: '\u25c8',
	// Task / subagent
	delegate_task: '\u2502', task: '\u2502', subagent: '\u2502',
	// Skill
	skill_manage: '\u2192', read_skill: '\u2192',
	list_skills: '\u2192',
	// Todo
	todo: '\u2699', todowrite: '\u2699',
	// Clarify / question
	clarify: '\u2192', question: '\u2192',
	// Memory
	memory_remember: '\u2699', memory_list: '\u2699', recall: '\u2699',
	// Kanban
	kanban_create: '\u2699', kanban_complete: '\u2699', kanban_block: '\u2699',
	kanban_unblock: '\u2699', kanban_show: '\u2699', kanban_list: '\u2699',
	// Workflow
	workflow_list: '\u2699', workflow_get: '\u2699', workflow_apply: '\u2699',
};

function getToolIcon(name: string): string {
	return TOOL_ICONS[name] ?? '\u2699';  // ⚙ fallback
}

// ── Status icon/color mapping ──────────────────────────────────────────

function getStatusIcon(status: ToolStatus, spinnerFrame: string): string {
	switch (status) {
		case 'running': return spinnerFrame;
		case 'success': return '\u2713';  // ✓
		case 'error': return '\u2717';    // ✗
		case 'pending': return '~';
	}
}

function getStatusColor(status: ToolStatus, t: AnsiTheme): number {
	switch (status) {
		case 'running': return t.color.accent;
		case 'success': return t.color.ok;
		case 'error': return t.color.error;
		case 'pending': return t.color.muted;
	}
}

// ── Arg formatting ─────────────────────────────────────────────────────

function formatToolArgs(args: string | undefined): string {
	if (!args) { return ''; }
	try {
		const parsed = JSON.parse(args);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			const entries = Object.entries(parsed)
				.filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
				.slice(0, 3);
			if (entries.length === 0) { return ''; }
			return ` [${entries.map(([k, v]) => `${k}=${v}`).join(', ')}]`;
		}
	} catch { /* not JSON */ }
	if (args.length > 60) { return ' ' + args.slice(0, 60) + '...'; }
	return ' ' + args;
}

// ── Chevron (collapsible header) ───────────────────────────────────────

function renderChevron(
	title: string,
	open: boolean,
	t: AnsiTheme,
	count?: number,
	suffix?: string,
	tone: 'dim' | 'error' | 'warn' = 'dim',
): string {
	const chevron = open ? '\u25be' : '\u25b8';  // ▾ / ▸
	const color = tone === 'error' ? t.color.error : tone === 'warn' ? t.color.warn : t.color.muted;

	let line = `${Ansi.fg(t.color.accent)}${chevron} ${Ansi.reset}`;
	line += `${Ansi.fg(color)}${title}${Ansi.reset}`;
	if (typeof count === 'number') { line += ` (${count})`; }
	if (suffix) {
		line += `  ${Ansi.dim}${Ansi.fg(t.color.muted)}${suffix}${Ansi.reset}`;
	}
	return line;
}

// ── Thinking renderer ──────────────────────────────────────────────────

function renderThinking(
	thinking: ThinkingInfo,
	rails: TreeRails,
	branch: TreeBranch,
	opts: ToolRenderOptions,
): string {
	const { t, expandedSections, spinnerFrame } = opts;
	const parts: string[] = [];
	const expanded = expandedSections.has('thinking');

	// Header
	const tokenLabel = thinking.tokenCount ? `  ~${formatK(thinking.tokenCount)} tokens` : '';
	parts.push(treeLead(rails, branch));

	if (thinking.isRunning) {
		parts.push(`${Ansi.bold}${Ansi.fg(t.color.text)}Thinking${Ansi.reset}`);
		parts.push(` ${Ansi.fg(t.color.accent)}${spinnerFrame}${Ansi.reset}`);
	} else {
		parts.push(`${Ansi.fg(t.color.muted)}Thinking${Ansi.reset}`);
	}
	if (tokenLabel) {
		parts.push(`${Ansi.dim}${Ansi.fg(t.color.muted)}${tokenLabel}${Ansi.reset}`);
	}
	parts.push('\r\n');

	// Body (expanded)
	if (expanded) {
		const childRails = nextRails(rails, branch);
		const lines = thinking.text.split('\n');

		for (let li = 0; li < lines.length; li++) {
			const line = lines[li]!;
			const isLast = li === lines.length - 1;
			parts.push(treeLead(childRails, isLast ? 'last' : 'mid'));
			parts.push(`${Ansi.fg(t.color.muted)}${line || ' '}${Ansi.reset}\r\n`);
		}

		// Stream cursor at end
		if (thinking.isRunning) {
			parts.push(`${Ansi.fg(t.color.accent)}\u258d${Ansi.reset}`);  // ▍
		}
	}

	return parts.join('');
}

// ── Single tool call renderer ──────────────────────────────────────────

function renderToolCall(
	tool: ToolCallInfo,
	rails: TreeRails,
	branch: TreeBranch,
	opts: ToolRenderOptions,
): string {
	const { t, expandedSections, spinnerFrame } = opts;
	const parts: string[] = [];
	const childRails = nextRails(rails, branch);

	// Main line: icon + name + args + duration
	const icon = getToolIcon(tool.name);
	const statusIcon = getStatusIcon(tool.status, spinnerFrame);
	const statusColor = getStatusColor(tool.status, t);
	const args = formatToolArgs(tool.args);
	const duration = tool.durationMs ? ` (${formatDuration(tool.durationMs)})` : '';

	parts.push(treeLead(rails, branch));
	parts.push(`${Ansi.fg(statusColor)}${statusIcon} ${Ansi.reset}`);
	parts.push(`${Ansi.fg(t.color.accent)}${icon} ${Ansi.reset}`);
	parts.push(`${tool.displayName || tool.name}${Ansi.dim}${args}${Ansi.reset}`);
	if (duration) {
		parts.push(`${Ansi.dim}${Ansi.fg(t.color.muted)}${duration}${Ansi.reset}`);
	}
	parts.push('\r\n');

	// Error detail (expanded)
	if (tool.status === 'error' && tool.error) {
		parts.push(treeLead(childRails, 'last'));
		parts.push(`${Ansi.fg(t.color.error)}${tool.error}${Ansi.reset}\r\n`);
	}

	// Result preview (expanded)
	if (tool.result && expandedSections.has(`tool-${tool.id}-result`)) {
		const resultLines = tool.result.split('\n');
		const maxLines = 5;
		const showLines = resultLines.slice(0, maxLines);

		for (let ri = 0; ri < showLines.length; ri++) {
			const isLastResult = ri === showLines.length - 1 && !tool.subTools?.length;
			parts.push(treeLead(childRails, isLastResult ? 'last' : 'mid'));
			parts.push(`${Ansi.dim}${showLines[ri]}${Ansi.reset}\r\n`);
		}

		if (resultLines.length > maxLines) {
			parts.push(treeLead(childRails, tool.subTools?.length ? 'mid' : 'last'));
			parts.push(`${Ansi.fg(t.color.muted)}... (${resultLines.length - maxLines} more)${Ansi.reset}\r\n`);
		}
	}

	// Sub-agent tools (recursive)
	if (tool.subTools && tool.subTools.length > 0) {
		for (let si = 0; si < tool.subTools.length; si++) {
			const subTool = tool.subTools[si]!;
			const subBranch: TreeBranch = si === tool.subTools.length - 1 ? 'last' : 'mid';
			parts.push(renderToolCall(subTool, childRails, subBranch, opts));
		}
	}

	return parts.join('');
}

// ── Main ToolTrail renderer ────────────────────────────────────────────

/**
 * Render the complete tool trail as an ANSI string.
 *
 * @param thinking Thinking info (null if no thinking)
 * @param tools Array of tool calls
 * @param opts Render options
 * @returns ANSI-formatted string with tree structure
 */
export function renderToolTrail(
	thinking: ThinkingInfo | null,
	tools: ToolCallInfo[],
	opts: ToolRenderOptions,
): string {
	const { t, expandedSections } = opts;
	const parts: string[] = [];

	const hasThinking = thinking && thinking.text.trim();
	const hasTools = tools.length > 0;

	if (!hasThinking && !hasTools) {
		return '';
	}

	// Build panels
	const panels: { header: string; key: string; open: boolean; body: string }[] = [];

	// Thinking panel
	if (hasThinking) {
		const expanded = expandedSections.has('thinking');
		const tokenLabel = thinking!.tokenCount ? `  ~${formatK(thinking!.tokenCount)} tokens` : '';
		panels.push({
			key: 'thinking',
			header: renderChevron('Thinking', expanded, t, undefined, tokenLabel.trim() || undefined,
				thinking!.isRunning ? 'warn' : 'dim'),
			open: expanded,
			body: expanded ? renderThinking(thinking!, [], 'last', opts) : '',
		});
	}

	// Tools panel
	if (hasTools) {
		const expanded = expandedSections.has('tools');
		panels.push({
			key: 'tools',
			header: renderChevron('Tool calls', expanded, t, tools.length),
			open: expanded,
			body: '',
		});
	}

	// Render tree
	for (let pi = 0; pi < panels.length; pi++) {
		const panel = panels[pi]!;
		const isLastPanel = pi === panels.length - 1;
		const branch: TreeBranch = isLastPanel ? 'last' : 'mid';

		// Header row
		parts.push(treeLead([], branch));
		parts.push(panel.header);
		parts.push('\r\n');

		// Body
		if (panel.open) {
			const childRails = nextRails([], branch);

			if (panel.key === 'thinking' && hasThinking) {
				// Render thinking body with child rails
				const thinkingParts: string[] = [];
				const lines = thinking!.text.split('\n');
				for (let li = 0; li < lines.length; li++) {
					const line = lines[li]!;
					const isLastLine = li === lines.length - 1;
					thinkingParts.push(treeLead(childRails, isLastLine ? 'last' : 'mid'));
					thinkingParts.push(`${Ansi.fg(t.color.muted)}${line || ' '}${Ansi.reset}\r\n`);
				}
				parts.push(thinkingParts.join(''));
			}

			if (panel.key === 'tools') {
				// Render each tool call
				for (let ti = 0; ti < tools.length; ti++) {
					const tool = tools[ti]!;
					const isLastTool = ti === tools.length - 1;
					const toolBranch: TreeBranch = isLastTool ? 'last' : 'mid';
					parts.push(renderToolCall(tool, childRails, toolBranch, opts));
				}
			}
		}
	}

	return parts.join('');
}

// ── User message renderer ───────────────────────────────────────────────

/**
 * Render a user message in TUI style.
 * Format: `❯ text`
 */
export function renderUserMessage(text: string, t: AnsiTheme): string {
	const prompt = t.brand.prompt;
	return `${Ansi.fg(t.color.ok)}${Ansi.bold}${prompt} ${Ansi.reset}${Ansi.fg(t.color.text)}${text}${Ansi.reset}\r\n\r\n`;
}

// ── Assistant footer renderer ──────────────────────────────────────────

/**
 * Render the assistant message footer: `▣ Mode · Model · Duration`
 */
export function renderAssistantFooter(
	mode: string,
	model: string,
	t: AnsiTheme,
	durationMs?: number,
	interrupted?: boolean,
): string {
	const parts: string[] = [];

	parts.push(`${Ansi.fg(t.color.accent)}\u25a3 ${Ansi.reset}`);  // ▣
	parts.push(`${Ansi.fg(t.color.text)}${mode.charAt(0).toUpperCase() + mode.slice(1)}${Ansi.reset}`);
	parts.push(`${Ansi.dim}${Ansi.fg(t.color.muted)} \u00b7 ${Ansi.reset}`);  // ·
	parts.push(`${Ansi.fg(t.color.muted)}${model}${Ansi.reset}`);

	if (durationMs) {
		parts.push(`${Ansi.dim}${Ansi.fg(t.color.muted)} \u00b7 ${formatDuration(durationMs)}${Ansi.reset}`);
	}

	if (interrupted) {
		parts.push(`${Ansi.dim}${Ansi.fg(t.color.muted)} \u00b7 interrupted${Ansi.reset}`);
	}

	parts.push('\r\n');
	return parts.join('');
}

// ── Spinner frames ──────────────────────────────────────────────────────

/** Braille spinner frames for running indicators */
export const SPINNER_FRAMES = [
	'\u280b',  // ⠋
	'\u2819',  // ⠙
	'\u2839',  // ⠹
	'\u2838',  // ⠸
	'\u283c',  // ⠼
	'\u2834',  // ⠴
	'\u2826',  // ⠦
	'\u2827',  // ⠧
	'\u2807',  // ⠇
	'\u280f',  // ⠏
];

/** Alternative spinner: think-style (helix-like) */
export const THINK_SPINNER_FRAMES = [
	'\u2801',  // ⠁
	'\u2802',  // ⠂
	'\u2804',  // ⠄
	'\u2840',  // ⡀
	'\u2880',  // ⢀
	'\u2820',  // ⠠
	'\u2810',  // ⠐
	'\u2808',  // ⠈
];
