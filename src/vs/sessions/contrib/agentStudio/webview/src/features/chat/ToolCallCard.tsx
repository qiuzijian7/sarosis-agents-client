/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Tool Call Card Component (Void-style unified shell)
 *
 *  A full rewrite that replicates Void's unified tool card architecture
 *  (SidebarChat.tsx). A single `ToolHeaderWrapper` shell drives ALL tool types:
 *    rounded bordered card → clickable title row (chevron + italic desc) →
 *    right status area (spinner / error / N results) → smooth-height dropdown
 *    body → collapsible bottom error area.
 *
 *  Key Void concepts ported:
 *  - titleOfBuiltinToolName: status-aware title text (done / proposed / running)
 *  - toolNameToDesc: extracts file name / command / query as the italic desc1
 *  - per-tool resultWrapper: read_file / ls_dir / search / edit / run_command /
 *    generic / MCP — each renders into the unified shell
 *  - ToolRequestAcceptRejectButtons: approval UI
 *  - BottomChildren: collapsible error / lint area
 *
 *  Replaces the previous multi-card patchwork (ConfirmationCard / ProgressCard /
 *  ResultCard / GenericToolCallCard / renderType dispatch). The public prop
 *  contract `{ toolCall: ToolMessage }` is preserved.
 *
 *  Ref: void sidebar-tsx/SidebarChat.tsx (ToolHeaderWrapper, titleOfBuiltinToolName,
 *       toolNameToDesc, builtinToolNameToComponent, ToolRequestAcceptRejectButtons)
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useCallback, useMemo } from 'react';
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter';
import { sanitizeToolResultText } from '../../utils/assistantVisibleText';
import { openFile, type OpenFileOptions } from '../../bridge/fileBridge';
import { sendRequest } from '../../bridge/messageClient';
import { applyToolApprovalResolved } from '../../bridge/streamHandler';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useChatStore } from '../../store/useChatStore';
import type { ToolMessage } from '../../types/chatTypes';
import {
	ToolHeaderWrapper,
	ToolChildrenWrapper,
	CodeChildren,
	ListableToolItem,
	BottomChildren,
	LoadingTitle,
	type ToolHeaderParams,
} from './ToolHeaderWrapper';

// ─── Props ────────────────────────────────────────────────────────────────

interface ToolCallCardProps {
	/**
	 * Accepts either a fully-normalized ToolMessage (from AgentChat via
	 * toolCallStateToToolMessage) OR a raw store tool-call object (from
	 * ChatMessage, which passes message.toolCalls items directly). The
	 * normalizer below tolerates both shapes.
	 */
	toolCall: ToolMessage | RawToolCall;
}

/** Raw store tool-call shape (ChatMessage passes these directly). */
interface RawToolCall {
	id: string;
	name: string;
	arguments?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	/**
	 * Streaming ToolMessages carry an explicit status; history-restored
	 * RawToolCalls (persisted by agentChatService) do NOT. Optional here so the
	 * `normalize` fallback can infer the phase from result/error/serverExecuted.
	 */
	status?: string;
	error?: string;
	defaultShow?: boolean;
	displayName?: string;
	renderType?: string;
	serverExecuted?: boolean;
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	exitCode?: number;
	duration?: number;
	canceled?: boolean;
	mcpServerName?: string;
	diagnostics?: ReadonlyArray<{ message: string; line?: number; severity: 'error' | 'warning' }>;
}

// ─── Normalized internal view of a tool call ────────────────────────────────

type ToolPhase = 'running' | 'success' | 'error' | 'rejected' | 'canceled' | 'approval_required' | 'pending';

interface NormalizedTool {
	id: string;
	name: string;
	params: Record<string, unknown>;
	/** pretty-printed JSON of params (for generic display) */
	argsJson: string;
	/** extracted plain-text result */
	resultText: string;
	phase: ToolPhase;
	error?: string;
	defaultShow?: boolean;
	displayName?: string;
	renderType?: string;
	securityLevel?: 'safe' | 'cautious' | 'dangerous';
	exitCode?: number;
	duration?: number;
	mcpServerName?: string;
	diagnostics?: ReadonlyArray<{ message: string; line?: number; severity: 'error' | 'warning' }>;
}

/** Map the various status strings (unified + legacy) to a single phase. */
function mapPhase(status: string, error: string | undefined, canceled: boolean | undefined): ToolPhase {
	if (canceled) { return 'canceled'; }
	switch (status) {
		case 'running': return 'running';
		case 'pending': return 'pending';
		case 'success':
		case 'completed':
		case 'done': return error ? 'error' : 'success';
		case 'error':
		case 'invalid_params': return 'error';
		case 'rejected': return 'rejected';
		case 'canceled': return 'canceled';
		case 'approval_required': return 'approval_required';
		case 'confirmed': return 'running';
		default: return 'pending';
	}
}

/**
 * Extract the human-readable text from a parsed content payload.
 * Handles:
 *   - an array of content parts: [{ type: 'text', text: '...' }, ...]
 *   - an object with a `content` array: { content: [{ text: '...' }] }
 *   - an object with a top-level `text` string
 * Returns null when no text-shaped content is found.
 */
/** Normalize CRLF/CR line endings to LF so <pre> renders cleanly. */
function normalizeNewlines(s: string): string {
	return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function extractContentText(parsed: unknown): string | null {
	if (Array.isArray(parsed)) {
		const texts = parsed
			.filter((c: any) => c && typeof c === 'object' && typeof c.text === 'string')
			.map((c: any) => c.text as string);
		return texts.length > 0 ? normalizeNewlines(texts.join('\n')) : null;
	}
	if (parsed && typeof parsed === 'object') {
		const obj = parsed as { content?: Array<{ type?: string; text?: string }>; text?: string };
		if (Array.isArray(obj.content)) {
			const texts = obj.content
				.filter(c => c && typeof c.text === 'string')
				.map(c => c.text as string);
			if (texts.length > 0) { return normalizeNewlines(texts.join('\n')); }
		}
		if (typeof obj.text === 'string') { return normalizeNewlines(obj.text); }
	}
	return null;
}

/**
 * Open a file from a tool card, always attaching the active workspaceId so
 * the host can resolve *relative* paths (e.g. "product.json") against the
 * workspace root. Absolute paths are unaffected.
 */
function openFileFromCard(path: string, options?: OpenFileOptions): void {
	let workspaceId: string | undefined;
	try {
		workspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? undefined;
	} catch {
		/* store unavailable — host will fall back to absolute-path handling */
	}
	void openFile(path, { ...options, ...(workspaceId ? { workspaceId } : {}) });
}

/** Extract plain text from a ToolResult | string | null | unknown. */
function resultToText(result: unknown): string {
	return deepUnwrapResult(result, 0);
}

/**
 * Recursively unwrap a tool result down to its innermost plain text.
 *
 * The backend frequently delivers results that are *doubly* (or even triply)
 * wrapped: a committed ToolMessage stores `{ content: [{ type: 'text',
 * text: <X> }] }`, where `<X>` is itself the host's `safeStringifyToolResult`
 * output — which may ALSO be a stringified content-parts array like
 * `[{"type":"text","text":"file1\nfile2"}]`. Unwrapping only one layer left
 * the inner JSON string intact, and downstream consumers (e.g. parseListItems)
 * then JSON.parsed the content-parts array and rendered each part object as
 * `[object Object]`. We loop the unwrap so the caller always gets real text.
 */
function deepUnwrapResult(result: unknown, depth: number): string {
	if (!result) { return ''; }
	// Hard recursion guard — content payloads are shallow in practice.
	if (depth > 4) {
		return typeof result === 'string' ? normalizeNewlines(result) : '';
	}
	if (typeof result === 'string') {
		const trimmed = result.trim();
		const looksLikeJson =
			(trimmed.startsWith('[') && trimmed.endsWith(']')) ||
			(trimmed.startsWith('{') && trimmed.endsWith('}'));
		if (looksLikeJson && (trimmed.includes('"text"') || trimmed.includes('"content"'))) {
			try {
				const parsed = JSON.parse(trimmed);
				const extracted = extractContentText(parsed);
				// extracted may itself be another content-parts JSON string
				// → keep unwrapping until we reach genuine plain text.
				if (extracted !== null) { return deepUnwrapResult(extracted, depth + 1); }
			} catch {
				/* not valid JSON — fall through and return the raw string */
			}
		}
		return normalizeNewlines(result);
	}
	if (typeof result === 'object') {
		const extracted = extractContentText(result);
		if (extracted !== null) { return deepUnwrapResult(extracted, depth + 1); }
		try { return JSON.stringify(result, null, 2); } catch { return String(result); }
	}
	return String(result);
}

/** Normalize either a ToolMessage or a RawToolCall into NormalizedTool. */
function normalize(tc: ToolMessage | RawToolCall): NormalizedTool {
	const anyTc = tc as RawToolCall & ToolMessage;

	// params: prefer object `params`; otherwise parse `arguments` JSON string
	let params: Record<string, unknown> = {};
	if (anyTc.params && typeof anyTc.params === 'object') {
		params = anyTc.params as Record<string, unknown>;
	} else if (typeof anyTc.arguments === 'string') {
		try { params = JSON.parse(anyTc.arguments || '{}'); } catch { params = {}; }
	}

	let argsJson = '';
	try {
		argsJson = Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : '';
	} catch { argsJson = ''; }

	const rawResultText = resultToText(anyTc.result);
	const resultText = rawResultText ? sanitizeToolResultText(rawResultText) : '';

	// Derive a status string. Streaming ToolMessages always carry an explicit
	// `status`. History-restored RawToolCalls (persisted in
	// agentChatService.ts) do NOT — they only store id/name/arguments/result/
	// displayName/renderType/defaultShow/serverExecuted. Without a status the
	// raw `mapPhase(String(undefined))` falls into its `default: 'pending'`
	// branch, which makes a *completed* historical card render the animated
	// LoadingTitle ("正在读取文件...") forever after a window refresh.
	//
	// Fallback inference (only when status is missing/blank):
	//   - error present                → 'error'
	//   - canceled flag                → handled by mapPhase
	//   - a result was recorded        → 'success' (the call finished)
	//   - serverExecuted (no result)   → 'success' (server ran it to completion)
	//   - otherwise                    → leave to mapPhase (pending/running)
	const hasStatus = typeof anyTc.status === 'string' && anyTc.status.trim().length > 0;
	let statusForPhase: string;
	if (hasStatus) {
		statusForPhase = anyTc.status;
	} else if (anyTc.error) {
		statusForPhase = 'error';
	} else if (anyTc.result !== undefined && anyTc.result !== null) {
		statusForPhase = 'success';
	} else if (anyTc.serverExecuted) {
		statusForPhase = 'success';
	} else {
		// Genuinely incomplete (e.g. a live stream mid-flight without status).
		statusForPhase = 'pending';
	}

	const phase = mapPhase(statusForPhase, anyTc.error, anyTc.canceled);

	return {
		id: anyTc.id,
		name: anyTc.name,
		params,
		argsJson,
		resultText,
		phase,
		error: anyTc.error,
		defaultShow: anyTc.defaultShow,
		displayName: anyTc.displayName,
		renderType: anyTc.renderType,
		securityLevel: anyTc.securityLevel,
		exitCode: anyTc.exitCode,
		duration: anyTc.duration,
		mcpServerName: anyTc.mcpServerName,
		diagnostics: anyTc.diagnostics,
	};
}

// ─── Title state machine (Void titleOfBuiltinToolName) ──────────────────────
// each entry: [done/proposed text, running text]

const BUILTIN_TITLES: Record<string, { done: string; running: string }> = {
	// ── 项目真实内置工具名（builtinToolProvider / bundledTools）──
	file_read: { done: '读取文件', running: '正在读取文件' },
	file_write: { done: '写入文件', running: '正在写入文件' },
	file_list: { done: '查看目录', running: '正在查看目录' },
	search_files: { done: '搜索内容', running: '正在搜索内容' },
	patch: { done: '编辑文件', running: '正在编辑文件' },
	terminal: { done: '执行终端命令', running: '正在执行终端命令' },
	process: { done: '管理进程', running: '正在管理进程' },
	http_get: { done: '请求网页', running: '正在请求网页' },
	web_search: { done: '网络搜索', running: '正在网络搜索' },
	web_fetch: { done: '抓取网页', running: '正在抓取网页' },
	recall: { done: '检索记忆', running: '正在检索记忆' },
	memory: { done: '记忆操作', running: '正在记忆操作' },
	read_skill: { done: '读取技能', running: '正在读取技能' },
	skill_view: { done: '读取技能', running: '正在读取技能' },
	list_skills: { done: '列出技能', running: '正在列出技能' },
	skills_list: { done: '列出技能', running: '正在列出技能' },
	skill_manage: { done: '管理技能', running: '正在管理技能' },
	delegate_task: { done: '委派任务', running: '正在委派任务' },
	get_current_time: { done: '获取时间', running: '正在获取时间' },
	math_eval: { done: '计算', running: '正在计算' },
	echo: { done: 'Echo', running: 'Echo' },
	todo: { done: '更新待办', running: '正在更新待办' },
	execute_code: { done: '执行代码', running: '正在执行代码' },
	session_search: { done: '搜索会话', running: '正在搜索会话' },
	// ── void 旧别名（兼容，避免回归）──
	read_file: { done: '读取文件', running: '正在读取文件' },
	read: { done: '读取文件', running: '正在读取文件' },
	ls_dir: { done: '查看目录', running: '正在查看目录' },
	list_files: { done: '查看目录', running: '正在查看目录' },
	get_dir_tree: { done: '查看目录树', running: '正在查看目录树' },
	search_pathnames_only: { done: '按文件名搜索', running: '正在按文件名搜索' },
	search_for_files: { done: '搜索', running: '正在搜索' },
	search_content: { done: '搜索内容', running: '正在搜索内容' },
	search_in_file: { done: '在文件中搜索', running: '正在文件中搜索' },
	grep: { done: '搜索内容', running: '正在搜索内容' },
	create_file_or_folder: { done: '创建', running: '正在创建' },
	delete_file_or_folder: { done: '删除', running: '正在删除' },
	edit_file: { done: '编辑文件', running: '正在编辑文件' },
	edit: { done: '编辑文件', running: '正在编辑文件' },
	replace_in_file: { done: '编辑文件', running: '正在编辑文件' },
	apply_patch: { done: '编辑文件', running: '正在编辑文件' },
	rewrite_file: { done: '写入文件', running: '正在写入文件' },
	write_file: { done: '写入文件', running: '正在写入文件' },
	write: { done: '写入文件', running: '正在写入文件' },
	run_command: { done: '执行终端命令', running: '正在执行终端命令' },
	run_persistent_command: { done: '执行终端命令', running: '正在执行终端命令' },
	run_terminal_cmd: { done: '执行终端命令', running: '正在执行终端命令' },
	open_persistent_terminal: { done: '打开终端', running: '正在打开终端' },
	kill_persistent_terminal: { done: '关闭终端', running: '正在关闭终端' },
	read_lint_errors: { done: '读取诊断', running: '正在读取诊断' },
};

/** Get the title node for a tool, status-aware (Void getTitle). */
function getTitle(tool: NormalizedTool): React.ReactNode {
	const key = (tool.name || '').toLowerCase();
	const builtin = BUILTIN_TITLES[key];

	if (!builtin) {
		// MCP / unknown tool
		const label = tool.displayName || tool.name || 'MCP';
		const prefix =
			tool.phase === 'success' ? '调用了'
				: tool.phase === 'running' ? '正在调用'
					: '调用';
		const title = tool.mcpServerName ? `${prefix} ${tool.mcpServerName} · ${label}` : `${prefix} ${label}`;
		if (tool.phase === 'running' || tool.phase === 'approval_required' || tool.phase === 'pending') {
			return <LoadingTitle>{title}</LoadingTitle>;
		}
		return title;
	}

	if (tool.phase === 'running' || tool.phase === 'pending') {
		return <LoadingTitle>{builtin.running}</LoadingTitle>;
	}
	return builtin.done;
}

// ─── Description extraction (Void toolNameToDesc) ───────────────────────────

function getBasename(p: string): string {
	if (!p) { return ''; }
	const parts = p.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] || p;
}

/** Extract italic desc1 (file name / command / query) from params. */
function getDesc1(tool: NormalizedTool): { desc1: React.ReactNode; desc1Info?: string } {
	const p = tool.params;
	const key = (tool.name || '').toLowerCase();

	const filePath = (p.file_path || p.filePath || p.path || p.uri) as string | undefined;
	const query = (p.query || p.pattern || p.search_query) as string | undefined;
	const command = (p.command || p.cmd) as string | undefined;

	switch (key) {
		case 'file_read':
		case 'read_file':
		case 'read':
		case 'file_write':
		case 'patch':
		case 'edit_file':
		case 'edit':
		case 'replace_in_file':
		case 'apply_patch':
		case 'rewrite_file':
		case 'write_file':
		case 'write':
		case 'create_file_or_folder':
		case 'delete_file_or_folder':
		case 'read_lint_errors': {
			if (filePath) {
				let desc: string = getBasename(filePath);
				// read_file: append line range if present
				const start = p.start_line ?? p.startLine ?? p.offset;
				const end = p.end_line ?? p.endLine;
				if ((key === 'file_read' || key === 'read_file' || key === 'read') && (start !== undefined && start !== null)) {
					desc += ` (${start}${end !== undefined && end !== null ? '-' + end : ''})`;
				}
				return { desc1: desc, desc1Info: filePath };
			}
			return { desc1: '' };
		}
		case 'file_list':
		case 'ls_dir':
		case 'list_files':
		case 'get_dir_tree': {
			if (filePath) {
				const base = getBasename(filePath);
				return { desc1: base || (filePath === '.' ? '.' : '/'), desc1Info: filePath };
			}
			return { desc1: '' };
		}
		case 'search_files':
		case 'search_pathnames_only':
		case 'search_for_files':
		case 'search_content':
		case 'search_in_file':
		case 'grep': {
			return { desc1: query ? `"${query}"` : '', desc1Info: filePath };
		}
		case 'terminal':
		case 'run_command':
		case 'run_persistent_command':
		case 'run_terminal_cmd': {
			return { desc1: command ? `"${command}"` : '' };
		}
		default: {
			// MCP / generic: show first string param value, or file path / query
			if (filePath) { return { desc1: getBasename(filePath), desc1Info: filePath }; }
			if (query) { return { desc1: `"${query}"` }; }
			if (command) { return { desc1: `"${command}"` }; }
			const firstStr = Object.values(p).find(v => typeof v === 'string' && v.length > 0) as string | undefined;
			if (firstStr) {
				return { desc1: firstStr.length > 60 ? firstStr.slice(0, 60) + '…' : firstStr };
			}
			return { desc1: '' };
		}
	}
}

// ─── Result parsing helpers ─────────────────────────────────────────────────

interface ListItem {
	name: string;
	path?: string;
	isDirectory?: boolean;
}

/** Try to parse the tool result text into a list of items (for ls_dir/search). */
function parseListItems(resultText: string): ListItem[] | null {
	if (!resultText) { return null; }
	try {
		const parsed = JSON.parse(resultText);
		const arr =
			Array.isArray(parsed) ? parsed
				: Array.isArray(parsed?.items) ? parsed.items
					: Array.isArray(parsed?.children) ? parsed.children
						: Array.isArray(parsed?.list) ? parsed.list
							: Array.isArray(parsed?.uris) ? parsed.uris
								: null;
		if (!arr) { return null; }
		const mapped: ListItem[] = [];
		for (const it of arr) {
			if (typeof it === 'string') {
				mapped.push({ name: getBasename(it), path: it });
				continue;
			}
			if (!it || typeof it !== 'object') {
				// Non-object, non-string entry — skip rather than String(it).
				continue;
			}
			const anyIt = it as Record<string, unknown>;
			const path = (anyIt.path || anyIt.uri || anyIt.fsPath || anyIt.file || '') as string;
			// Guard: a content-part object `{ type:'text', text:'...' }` is NOT a
			// file/list entry. If there's no path AND no name-ish field, this is
			// almost certainly an un-unwrapped content part — skip it so we never
			// render `[object Object]`.
			const nameRaw = anyIt.name || anyIt.content;
			if (!path && !nameRaw) { continue; }
			const name = (nameRaw || getBasename(path)) as string;
			if (!name) { continue; }
			// file_list returns { name, type: 'dir' | 'file', size }; also tolerate
			// other shapes (isDirectory / item_type / type === 'directory').
			const isDirectory =
				anyIt.isDirectory === true ||
				anyIt.item_type === 'directory' ||
				anyIt.type === 'directory' ||
				anyIt.type === 'dir';
			mapped.push({ name: `${name}${isDirectory && !String(name).endsWith('/') ? '/' : ''}`, path, isDirectory });
		}
		return mapped.length > 0 ? mapped : null;
	} catch {
		// plain-text fallback: split lines
		const lines = resultText.split('\n').map(l => l.trim()).filter(Boolean);
		if (lines.length === 0) { return null; }
		return lines.map(l => ({ name: l }));
	}
}

const TERMINAL_TOOLS = new Set(['terminal', 'run_command', 'run_persistent_command', 'run_terminal_cmd', 'process', 'execute_code']);
const LIST_TOOLS = new Set(['file_list', 'search_files', 'ls_dir', 'list_files', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_content', 'search_in_file', 'grep']);
const READ_TOOLS = new Set(['file_read', 'read_file', 'read']);
const EDIT_TOOLS = new Set(['file_write', 'patch', 'edit_file', 'edit', 'replace_in_file', 'apply_patch', 'rewrite_file', 'write_file', 'write']);

// ─── Approval buttons (Void ToolRequestAcceptRejectButtons) ─────────────────

function ApprovalButtons({ tool }: { tool: NormalizedTool }): React.ReactElement {
	const resolve = useCallback((decision: string) => {
		applyToolApprovalResolved(tool.id);
		sendRequest('chat.toolApprove', { toolCallId: tool.id, decision }).catch(() => { });
	}, [tool.id]);

	const securityLabel = tool.securityLevel === 'dangerous'
		? '危险操作'
		: tool.securityLevel === 'cautious'
			? '需谨慎'
			: '需确认';

	return (
		<div className="tool-approval-row">
			<span className="tool-approval-label">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
				</svg>
				{securityLabel}
			</span>
			<button className="tool-approval-btn tool-approval-btn-primary" onClick={() => resolve('allow_once')} title="仅允许此次执行">
				允许一次
			</button>
			<button className="tool-approval-btn tool-approval-btn-secondary" onClick={() => resolve('allow_session')} title="在当前会话中自动允许">
				会话中允许
			</button>
			<button className="tool-approval-btn tool-approval-btn-secondary" onClick={() => resolve('allow_always')} title="始终自动允许此工具">
				始终允许
			</button>
			<button className="tool-approval-btn tool-approval-btn-reject" onClick={() => resolve('deny')}>
				拒绝
			</button>
		</div>
	);
}

// ─── Body renderers ──────────────────────────────────────────────────────────

/** Terminal output body. Mirrors void's CommandTool: shellscript syntax
 *  highlighting via SyntaxHighlighter, selectable text, horizontal scroll. */
function TerminalBody({ tool }: { tool: NormalizedTool }): React.ReactElement {
	const command = (tool.params.command || tool.params.cmd || '') as string;
	const lines: string[] = [];
	if (command) { lines.push(`$ ${command}`); }
	if (tool.resultText) { lines.push(tool.resultText); }
	const text = lines.join('\n');
	const isNonZero = tool.exitCode !== undefined && tool.exitCode !== 0;
	return (
		<ToolChildrenWrapper className="tool-children-terminal">
			<div className="tool-terminal-code">
				<LazySyntaxHighlighter
					code={text}
					language="shellscript"
					lineCount={0}
					wrapLongLines={false}
					codeTagProps={{ style: { fontFamily: 'var(--vscode-editor-font-family, monospace)' } }}
					customStyle={{
						padding: '6px 8px',
						borderRadius: '3px',
						background: 'transparent',
					}}
				/>
			</div>
			{tool.exitCode !== undefined && (
				<div className={`tool-exit-code ${isNonZero ? 'tool-exit-code-nonzero' : 'tool-exit-code-zero'}`}>
					{`exit code ${tool.exitCode}`}
				</div>
			)}
		</ToolChildrenWrapper>
	);
}

/** Generic code/text body. */
function CodeBody({ text }: { text: string }): React.ReactElement {
	return (
		<ToolChildrenWrapper>
			<CodeChildren>
				<pre>{text}</pre>
			</CodeChildren>
		</ToolChildrenWrapper>
	);
}

/** List body (ls_dir / search results). */
function ListBody({ items }: { items: ListItem[] }): React.ReactElement {
	return (
		<ToolChildrenWrapper>
			{items.map((item, i) => (
				<ListableToolItem
					key={i}
					name={item.name}
					className="tool-listable-item"
					onClick={item.path ? () => openFileFromCard(item.path as string) : undefined}
				/>
			))}
		</ToolChildrenWrapper>
	);
}

// ─── Main component ──────────────────────────────────────────────────────────

function ToolCallCardRaw({ toolCall }: ToolCallCardProps): React.ReactElement | null {
	const tool = useMemo(() => normalize(toolCall), [toolCall]);

	// Visibility controlled solely by defaultShow (false → hide).
	if (tool.defaultShow === false) { return null; }

	const key = (tool.name || '').toLowerCase();
	const title = getTitle(tool);
	const { desc1, desc1Info } = getDesc1(tool);

	const isError = tool.phase === 'error';
	const isRejected = tool.phase === 'rejected';
	const isCanceled = tool.phase === 'canceled';
	const isRunning = tool.phase === 'running' || tool.phase === 'pending';
	const isApproval = tool.phase === 'approval_required';
	const isSuccess = tool.phase === 'success';
	const isTerminalTool = TERMINAL_TOOLS.has(key);

	// Status-driven wrapper class (drives accent borders in CSS).
	const statusClass =
		isApproval ? 'tool-card-approval'
			: isError ? 'tool-card-error'
				: isRejected ? 'tool-card-rejected'
					: isCanceled ? 'tool-card-canceled'
						: '';

	// ── Build the file-open onClick (for read/edit tools) ──
	const filePath = (tool.params.file_path || tool.params.filePath || tool.params.path || tool.params.uri) as string | undefined;
	const openLine = (() => {
		const s = tool.params.start_line ?? tool.params.startLine ?? tool.params.offset;
		const n = typeof s === 'number' ? s : (typeof s === 'string' ? parseInt(s, 10) : NaN);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	})();
	const handleOpenFile = filePath ? () => { openFileFromCard(filePath, openLine ? { lineNumber: openLine } : undefined); } : undefined;

	// ── Build children (dropdown body) based on tool type ──
	let children: React.ReactNode = undefined;
	let numResults: number | undefined = undefined;
	let bottomChildren: React.ReactNode = undefined;

	if (isError) {
		// Error → collapsible bottom area (Void pattern).
		bottomChildren = (
			<BottomChildren title="错误">
				<pre>{tool.error || tool.resultText || '工具执行失败'}</pre>
			</BottomChildren>
		);
	} else if (isSuccess && tool.resultText) {
		if (READ_TOOLS.has(key)) {
			// read_file: NO dropdown — clicking the title opens the file directly
			// in the host's center editor (Void behavior). Leave `children`
			// undefined so the onClick=handleOpenFile path (below) takes effect
			// instead of the chevron expand/collapse interaction.
		} else if (TERMINAL_TOOLS.has(key)) {
			children = <TerminalBody tool={tool} />;
		} else if (LIST_TOOLS.has(key)) {
			const items = parseListItems(tool.resultText);
			if (items && items.length > 0) {
				numResults = items.length;
				children = <ListBody items={items} />;
			} else {
				children = <CodeBody text={tool.resultText} />;
			}
		} else if (EDIT_TOOLS.has(key)) {
			// edit: result shown as code; clicking the title expands the diff/result.
			children = <CodeBody text={tool.resultText} />;
		} else {
			// generic / MCP: show result as code; also show args if present.
			children = (
				<ToolChildrenWrapper>
					{tool.argsJson && (
						<CodeChildren>
							<pre>{tool.argsJson}</pre>
						</CodeChildren>
					)}
					<CodeChildren>
						<pre>{tool.resultText}</pre>
					</CodeChildren>
				</ToolChildrenWrapper>
			);
		}
	} else if (isRunning && tool.argsJson && !READ_TOOLS.has(key)) {
		// While running with no result yet, allow expanding to see args.
		// read_file is excluded so it never shows a dropdown — it stays a
		// single clickable row that opens the file.
		children = <CodeBody text={tool.argsJson} />;
	}

	// Diagnostics (lint) → bottom area when present and no error already.
	if (!isError && tool.diagnostics && tool.diagnostics.length > 0) {
		bottomChildren = (
			<BottomChildren title={`${tool.diagnostics.length} 个诊断问题`}>
				<pre>
					{tool.diagnostics.map(d =>
						`${d.severity === 'error' ? '✕' : '⚠'} ${d.line !== undefined ? 'L' + d.line + ': ' : ''}${d.message}`
					).join('\n')}
				</pre>
			</BottomChildren>
		);
	}

	// desc2: duration badge (only when finished).
	const desc2 = (tool.duration && !isRunning)
		? formatDuration(tool.duration)
		: undefined;

	const headerParams: ToolHeaderParams = {
		title,
		desc1,
		desc1Info: typeof desc1Info === 'string' ? desc1Info : undefined,
		desc2,
		isError,
		isRejected,
		isRunning,
		isSuccess,
		numResults,
		children,
		bottomChildren,
		onClick: (children === undefined && handleOpenFile) ? handleOpenFile : undefined,
		className: statusClass,
	};

	// ── Handle skip for running tools ──
	// Cancels the current agent loop AND auto-sends "继续" to resume execution,
	// mimicking the user clicking cancel + typing "继续" and pressing Enter.
	const handleSkipRunning = useCallback(() => {
		try {
			const store = useChatStore.getState();
			store.cancelStream();
			// Brief delay to let the cancel RPC dispatch before the follow-up
			setTimeout(() => {
				try {
					useChatStore.getState().sendMessage('继续');
				} catch (sendErr) {
					console.warn('[ToolCallCard] auto-continue sendMessage failed:', sendErr);
				}
			}, 50);
		} catch (err) {
			console.warn('[ToolCallCard] cancelStream failed:', err);
		}
	}, []);

	return (
		<>
			<ToolHeaderWrapper {...headerParams} />
			{isRunning && isTerminalTool && (
				<div className="tool-skip-row">
					<button
						className="tool-skip-btn"
						onClick={handleSkipRunning}
						title="跳过当前工具并自动继续执行"
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<polygon points="5 4 15 12 5 20 5 4" />
							<line x1="19" y1="5" x2="19" y2="19" />
						</svg>
						跳过并继续
					</button>
					<span className="tool-skip-hint">将跳过当前工具并自动继续执行</span>
				</div>
			)}
			{isApproval && <ApprovalButtons tool={tool} />}
			{isRejected && (
				<div className="tool-rejected-notice">用户已拒绝此工具调用</div>
			)}
		</>
	);
}

/** Format duration for the desc2 badge. */
function formatDuration(ms: number): string {
	if (ms < 1000) { return `${ms}ms`; }
	if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export const ToolCallCard = memo(ToolCallCardRaw);
