/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置 User Message XML TagProvider 实现。
 *
 * 标签优先级（数组顺序 = 输出顺序，对齐 CodeBuddy 格式）：
 *   1. user_info              — 系统环境（OS / Shell / Workspace / 时间）
 *   2. rules                  — 工作区规则（含子标签 workspace_rules / agent_memories）
 *   3. git_status             — Git 变更快照
 *   4. project_context        — 项目上下文（含子标签 project_guidance / project_layout）
 *   5. conversation_summary   — 对话历史摘要（cb_summary）
 *   6. working_memory_content — 长期记忆内容
 *   7. additional_data        — 运行时元信息
 *   8. system_reminder        — 行为提醒
 *
 * 所有标签为**同级兄弟关系**，不是嵌套关系。
 * 输出格式参考 CodeBuddy：
 *   <user_info>
 *   OS Version: win32
 *   ...
 *   </user_info>
 *   <rules>
 *   ...
 *   <agent_requestable_workspace_rules description="...">...</agent_requestable_workspace_rules>
 *   <memories description="...">...</memories>
 *   </rules>
 *   <git_status>...</git_status>
 *   <project_context>...</project_context>
 *   ...
 *
 *   {actual user query}
 */

import { IUserMessageTagProvider, IEnrichContext } from './userMessageEnricher.js';
import { canvasContextStore, type CanvasContextSnapshot } from './canvasContextStore.js';

// ═══════════════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════════════

function nowISO(): string {
	return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function osName(): string {
	// browser-safe：renderer 层无 Node 全局 `process`，需运行时探测
	const nodePlatform = (typeof process !== 'undefined') ? process.platform : undefined;
	if (nodePlatform) {
		return nodePlatform === 'win32' ? 'win32'
			: nodePlatform === 'darwin' ? 'darwin'
			: nodePlatform === 'linux' ? 'linux'
			: String(nodePlatform);
	}
	// 回退：从 userAgent 推断（Electron renderer 可用 navigator）
	const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
	if (/windows nt/i.test(ua)) { return 'win32'; }
	if (/mac os x|macintosh/i.test(ua)) { return 'darwin'; }
	if (/linux/i.test(ua)) { return 'linux'; }
	return 'unknown';
}

function shellName(): string {
	// browser-safe：renderer 层无 `process`，无法探知 shell，降级为 unknown 而非抛错
	if (typeof process !== 'undefined') {
		const s = process.env.SHELL || process.env.COMSPEC || '';
		if (s.includes('powershell') || s.includes('pwsh')) { return 'PowerShell (Core)'; }
		if (s.includes('cmd.exe')) { return 'cmd'; }
		if (s.includes('bash')) { return 'bash'; }
		if (s.includes('zsh')) { return 'zsh'; }
		return s || 'unknown';
	}
	return 'unknown';
}

/** 给 XML 子标签拼 `<tagName description="...">content</tagName>`。扩展 Provider 时可用此辅助。 */
export function tag(tagName: string, description: string | undefined, content: string): string {
	const desc = description ? ` description="${description.replace(/"/g, '&quot;')}"` : '';
	return `<${tagName}${desc}>\n${content}\n</${tagName}>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 1: user_info — 系统环境
// ═══════════════════════════════════════════════════════════════════════════

export class UserInfoTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'user_info';
	readonly tagDescription = '';

	buildContent(_ctx: IEnrichContext): string {
		return [
			`OS Version: ${osName()}`,
			`Shell: ${shellName()}`,
			`Current date: ${nowISO()}`,
			'Note: Prefer using absolute paths over relative paths as tool call args when possible.',
		].join('\n');
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 2: rules — 工作区规则 + Agent 记忆
// ═══════════════════════════════════════════════════════════════════════════

export class RulesTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'rules';
	readonly tagDescription = '';

	/** 由外部设置（agentDriverService 构建时填充）。 */
	rulesSections: Array<{ tag: string; description: string; content: string }> = [];

	buildContent(_ctx: IEnrichContext): string | null {
		const parts: string[] = [];
		parts.push(
			'The rules section has a number of possible rules/memories/context that you should consider.',
			'In each subsection, we provide instructions about what information the subsection contains',
			'and how you should consider/follow the contents of the subsection.',
		);
		for (const s of this.rulesSections) {
			parts.push(tag(s.tag, s.description, s.content));
		}
		return parts.join('\n\n');
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 3: git_status
// ═══════════════════════════════════════════════════════════════════════════

export class GitStatusTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'git_status';
	readonly tagDescription = 'Git status snapshot at conversation start (will not update).';

	/** 由外部设置。 */
	gitStatusContent: string | null = null;

	buildContent(_ctx: IEnrichContext): string | null {
		if (!this.gitStatusContent) { return null; }
		const lines = this.gitStatusContent.split('\n');
		const MAX_LINES = 50;
		if (lines.length > MAX_LINES) {
			return `${lines.slice(0, MAX_LINES).join('\n')}\n... (${lines.length - MAX_LINES} more lines omitted)`;
		}
		return this.gitStatusContent;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 4: project_context — 项目指导 + 文件树
// ═══════════════════════════════════════════════════════════════════════════

export class ProjectContextTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'project_context';
	readonly tagDescription = '';

	/** 由外部设置。 */
	guidanceContent: string | null = null;
	/** 由外部设置。 */
	layoutContent: string | null = null;

	buildContent(_ctx: IEnrichContext): string | null {
		const parts: string[] = [];
		if (this.guidanceContent) {
			parts.push(tag('project_guidance',
				'The project guidance below is generated by scanning the entire project.',
				this.guidanceContent));
		}
		if (this.layoutContent) {
			parts.push(tag('project_layout',
				'Below is a snapshot of the current workspace\'s file structure at the start of the conversation.',
				this.layoutContent));
		}
		if (parts.length === 0) { return null; }
		return parts.join('\n\n');
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 5: conversation_summary — 对话摘要（cb_summary）
// ═══════════════════════════════════════════════════════════════════════════

export class ConversationSummaryTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'cb_summary';
	readonly tagDescription = 'Summary of the conversation so far. Use this to understand context that may have been compressed or omitted from the messages list.';

	/** 由外部设置。 */
	summaryContent: string | null = null;

	buildContent(_ctx: IEnrichContext): string | null {
		return this.summaryContent || null;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 6: working_memory_content — 长期记忆
// ═══════════════════════════════════════════════════════════════════════════

export class WorkingMemoryTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'working_memory_content';
	readonly tagDescription = 'Long-term memory content — cross-session project knowledge. Check these when context is needed.';

	/** 由外部设置。 */
	workingMemoryContent: string | null = null;

	buildContent(_ctx: IEnrichContext): string | null {
		return this.workingMemoryContent || null;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 7: additional_data
// ═══════════════════════════════════════════════════════════════════════════

export class AdditionalDataTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'additional_data';
	readonly tagDescription = '';

	buildContent(ctx: IEnrichContext): string | null {
		const parts: string[] = [];
		if (ctx.request.agentId) {
			parts.push(`Agent: ${ctx.request.agentId}`);
		}
		if (ctx.request.workMode) {
			parts.push(`Mode: ${ctx.request.workMode === 'plan' ? 'Plan (read-only)' : 'Work (read-write)'}`);
		}
		if (ctx.request.chatOnly) {
			parts.push(`Chat-only mode: enabled (no file-writing tools)`);
		}
		if (parts.length === 0) { return null; }
		return parts.join('\n');
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 8: canvas_context — Agent-driven canvas state snapshot
// ═══════════════════════════════════════════════════════════════════════════

export interface CanvasContextFormatOptions {
	/** Max nodes to list (default 30). */
	maxNodes?: number;
}

const SAFE_XML_RE = /[<>&]/g;
const SAFE_XML_MAP: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;' };

function escapeXmlText(s: string): string {
	return s.replace(SAFE_XML_RE, ch => SAFE_XML_MAP[ch] || ch);
}

/**
 * Format a canvas context snapshot into tag content lines.
 * Pure + exported for unit tests (no DOM / store dependency).
 * Node label / error text are XML-escaped (the content sits inside <canvas_context>).
 */
export function formatCanvasContextContent(snapshot: CanvasContextSnapshot, options: CanvasContextFormatOptions = {}): string {
	const maxNodes = options.maxNodes ?? 30;
	const lines: string[] = [];
	const total = snapshot.nodes.length;
	const shown = snapshot.nodes.slice(0, maxNodes);

	for (const n of shown) {
		const stateLabel = n.runState === 'success' ? '成功'
			: n.runState === 'error' ? '失败'
			: n.runState === 'running' ? '运行中'
			: '待执行';
		const detail = n.runState === 'error' && n.errorMsg ? `，错误: ${escapeXmlText(n.errorMsg)}` : '';
		const dur = n.durationMs != null ? `，耗时 ${n.durationMs}ms` : '';
		lines.push(`- ${escapeXmlText(n.label)} [${escapeXmlText(n.type)}] → ${stateLabel}${detail}${dur}`);
	}
	if (total > shown.length) {
		lines.push(`- ... 另有 ${total - shown.length} 个节点未列出`);
	}
	if (lines.length === 0) {
		lines.push('- （画布当前无节点）');
	}
	if (snapshot.lastOpsSummary?.length) {
		lines.push('');
		lines.push('最近画布操作:');
		for (const s of snapshot.lastOpsSummary) { lines.push(`  ${s}`); }
	}
	return lines.join('\n');
}

export class CanvasContextTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'canvas_context';
	readonly tagDescription = 'Current workflow canvas state — nodes and their latest execution results (run state, errors, durations). Check this when the user references images/nodes generated on the canvas.';

	/** Injectable for tests; defaults to the shared store. */
	store: { get(workflowId: string): CanvasContextSnapshot | undefined } = canvasContextStore;

	buildContent(ctx: IEnrichContext): string | null {
		const workflowId = ctx.request.workflowTrigger?.workflowId ?? 'default';
		const snapshot = this.store.get(workflowId);
		if (!snapshot) { return null; }
		return formatCanvasContextContent(snapshot);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider 9: system_reminder
// ═══════════════════════════════════════════════════════════════════════════

export class SystemReminderTagProvider implements IUserMessageTagProvider {
	readonly tagName = 'system_reminder';
	readonly tagDescription = 'System reminders apply to all messages.';

	buildContent(ctx: IEnrichContext): string | null {
		const reminders: string[] = [];
		// 2026-08-06 修正：工作记忆经 working_memory_content 标签**只读**注入，
		// 数据源为 agentmemory 记忆系统（MemoryProvider 策展上下文）。
		// 模型无需自行做记忆持久化——原 "must update .codebuddy/memory/" 强指令
		// 曾导致模型在工作区根目录凭空造文件（该目录是错误路径），故改为只读提示。
		reminders.push(
			'Working memory is provided read-only in the <working_memory_content> tag when present. '
			+ 'Memory persistence is handled by the system — you do not need to save it yourself.'
		);
		if (ctx.agent && !ctx.agent.tools?.some(t => typeof t === 'string' && (t === 'file_write' || t === 'patch'))) {
			reminders.push('This is a read-only agent — it cannot modify files on disk. Focus on research and planning.');
		}
		return reminders.join('\n');
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// 工厂
// ═══════════════════════════════════════════════════════════════════════════

export function createBuiltinTagProviders(): IUserMessageTagProvider[] {
	return [
		new UserInfoTagProvider(),
		new RulesTagProvider(),
		new GitStatusTagProvider(),
		new ProjectContextTagProvider(),
		new ConversationSummaryTagProvider(),
		new WorkingMemoryTagProvider(),
		new AdditionalDataTagProvider(),
		new CanvasContextTagProvider(),
		new SystemReminderTagProvider(),
	];
}
