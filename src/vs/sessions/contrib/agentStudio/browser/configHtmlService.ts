/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService, FileChangeType } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import {
	IConfigHtmlService,
	IAgentStudioService,
	IAgentChatService,
} from '../common/agentStudio.js';
import type {
	IConfigMdCommand,
	IConfigMdPatchOp,
	IConfigMdState,
	ConfigMdChangeOrigin,
} from '../common/agentStudio.js';
import type { ConfigMdCapability, ChatMessage, Employee } from '../../../common/agentStudioTypes.js';
import { WORKSPACE_DATA_DIR, AGENTS_DIR } from '../common/constants.js';
import { postProcessImguiBlocks, IMGUI_SDK_SCRIPT, IMGUI_SDK_STYLES } from './imguiBlockProcessor.js';
import { IAgentOSService } from '../common/agentOS.js';
import { ToolSecurityLevel } from '../common/providers.js';
import type {
	IModelProvider,
	IModelDelta,
	IToolDefinition,
	IChatMessage,
	IModelOptions,
} from '../common/providers.js';

/** Regex for `configmd-patch` JSON code blocks. */
const PATCH_BLOCK_REGEX = /```configmd-patch\s*\n([\s\S]*?)\n```/g;
/** Regex for `configmd-command` JSON code blocks. */
const COMMAND_BLOCK_REGEX = /```configmd-command\s*\n([\s\S]*?)\n```/g;
/** Rate-limit: max chat-send-style calls per agent per minute. */
const RATE_LIMIT_PER_MINUTE = 30;

/**
 * Dedicated system prompt for the ConfigHtml AI box. Kept in sync (in spirit)
 * with `resources/.agents/skills/confightml/SKILL.md`. The skill body is also
 * injected via `explicitSkillIds: ['confightml']`; this constant is a safety
 * net so the host still steers the model even if skill resolution fails.
 */
const CONFIGHTML_SYSTEM_PROMPT = [
	'你是 ConfigHtml 面板的页面生成助手。用户描述需求，你产出一个**完整、自包含、零依赖、可在浏览器内编辑**的单文件 HTML 文档。',
	'',
	'输出方式（重要）：',
	'- 你被提供了一个名为 `emit_html` 的工具（function）。你**必须调用该工具**，把完整 HTML 文档作为 `html` 参数传入。',
	'- 不要把 HTML 写在普通回复文本里；不要做任何解释。直接调用 `emit_html`。',
	'- 若运行环境不支持函数调用，则退而求其次：只输出**一个** ```html 代码块，块内是从 <!DOCTYPE html> 到 </html> 的完整文档，块外不写任何文字。',
	'',
	'HTML 硬性要求：',
	'1. `html` 参数 / 代码块内是从 <!DOCTYPE html> 到 </html> 的完整文档。',
	'2. 零外部依赖：禁止任何外链 CSS/JS/字体/图片 CDN。所有 CSS 写进 <style>，所有 JS 写进 <script>，使用系统字体栈。',
	'3. 不要编写编辑器运行时（拖拽/缩放/撤销等由宿主注入），你只产出内容结构与样式。',
	'4. 可编辑契约：可编辑文本节点加 `data-edit-slot data-slot-type="text|image|metric|table-cell"`；需要自由拖拽的对象加 `data-slide-object data-oid="唯一id"`；根 <html> 加 `data-template-edit-mode="slots"`。',
	'5. 结构清晰、语义化标签、合理留白，确保宿主可定位每个可编辑元素。',
	'',
	'若用户提供了“当前 config.html 内容”，请在其基础上做增量修改，并输出修改后的完整文档。',
].join('\n');

/**
 * The `emit_html` function-calling tool. Forcing the model to return the page
 * as a STRUCTURED tool-call argument (rather than parsing a ```html fence out
 * of free text) makes extraction deterministic — this is the root-cause fix
 * for "模型未返回可用的 HTML": some models wrap the document in prose, omit the
 * fence, or stream it as tool parts, all of which broke the regex extractor.
 */
const EMIT_HTML_TOOL: IToolDefinition = {
	name: 'emit_html',
	description:
		'提交生成好的完整单文件 HTML 文档。必须调用本工具来交付结果，HTML 从 <!DOCTYPE html> 到 </html> 完整放入 html 参数。',
	inputSchema: {
		type: 'object',
		properties: {
			html: {
				type: 'string',
				description:
					'完整、自包含、零依赖的单文件 HTML 文档（含 <!DOCTYPE html> … </html>）。所有 CSS 写进 <style>，所有 JS 写进 <script>。',
			},
		},
		required: ['html'],
	},
	securityLevel: ToolSecurityLevel.Safe,
};

/**
 * Extract the first ```html fenced code block from a model reply. Falls back to
 * the trimmed raw text when no fenced block is present (the model may have
 * returned bare HTML).
 */
function extractHtmlBlock(raw: string): string {
	if (!raw) {
		return '';
	}
	const fenced = /```html\s*\n([\s\S]*?)\n```/i.exec(raw);
	if (fenced && fenced[1]) {
		return fenced[1].trim();
	}
	// Fallback: any fenced block, then bare text.
	const anyFence = /```[a-zA-Z]*\s*\n([\s\S]*?)\n```/.exec(raw);
	if (anyFence && anyFence[1] && /<[a-zA-Z!]/.test(anyFence[1])) {
		return anyFence[1].trim();
	}
	return raw.trim();
}

/**
 * Heuristic: is this source a complete, standalone HTML document (as opposed
 * to a Markdown panel or an HTML fragment)? Used to decide whether the preview
 * pipeline should emit the source verbatim (ConfigHtml mode) or run it through
 * the Markdown renderer + sanitizer + template wrapper (legacy ConfigMD mode).
 */
function isFullHtmlDocument(src: string): boolean {
	if (!src) { return false; }
	const head = src.slice(0, 600).toLowerCase();
	return head.includes('<!doctype html') || /<html[\s>]/.test(head);
}

/**
 * Default scaffold for a fresh `config.html` panel: a minimal, self-contained,
 * zero-dependency document that already follows the editable contract
 * (`data-edit-slot` / `data-template-edit-mode`) so the Canvas runtime can pick
 * it up immediately.
 */
function buildDefaultConfigHtml(agentName: string): string {
	const safeName = String(agentName || 'Agent')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return `<!DOCTYPE html>
<html lang="zh-CN" data-template-edit-mode="slots">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeName} · Panel</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    line-height: 1.6;
    color: #1f2328;
    background: #ffffff;
    padding: 40px 28px;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  .lead { color: #57606a; margin: 0 0 28px; }
  .card {
    border: 1px solid #d0d7de;
    border-radius: 10px;
    padding: 20px 22px;
    margin: 14px 0;
  }
  .card h2 { font-size: 17px; margin: 0 0 6px; }
  .card p { margin: 0; color: #424a53; }
</style>
</head>
<body>
  <div class="wrap">
    <h1 data-edit-slot data-slot-type="text">${safeName} 的面板</h1>
    <p class="lead" data-edit-slot data-slot-type="text">在上方用 AI 描述你想要的页面，或直接编辑这段 HTML。</p>
    <div class="card">
      <h2 data-edit-slot data-slot-type="text">开始使用</h2>
      <p data-edit-slot data-slot-type="text">这是一个零依赖、可在浏览器内编辑的单文件 HTML 文档。</p>
    </div>
  </div>
</body>
</html>
`;
}

/** Per-agent runtime state. */
interface IAgentMdState {
	markdown: string;
	html: string;
	stylesContent?: string;
	customParser?: IMdParser;
	version: number;
	mdUri: URI;
	disposables: DisposableStore;
	pendingWriteOrigin?: ConfigMdChangeOrigin;
	/** Suppress next `external` event for this monotonic write count. */
	selfWriteEpoch: number;
}

/** Custom parser API contract. */
interface IMdParser {
	parse(markdown: string, ctx?: { agentId: string }): string;
	applyHtmlPatch?(markdown: string, patch: unknown, ctx?: { agentId: string }): string;
}

/**
 * Built-in lightweight Markdown→HTML renderer.
 * Supports headings, paragraphs, lists, todo-lists, code blocks, inline code,
 * bold/italic, links, and the special `<!-- agent-state:NAME -->...<!-- /agent-state:NAME -->`
 * + `<!-- agent-bind:NAME -->X<!-- /agent-bind:NAME -->` anchors which become
 * `<div data-agent-state="NAME">` / `<span data-agent-bind="NAME">` for the HTML view to target.
 */
function builtInRenderMarkdown(md: string): string {
	let src = md.replace(/\r\n/g, '\n');

	// Preserve <!-- agent-state:NAME -->...<!-- /agent-state:NAME --> blocks
	const stateBlocks: Array<{ name: string; body: string }> = [];
	src = src.replace(/<!--\s*agent-state:([\w.-]+)\s*-->([\s\S]*?)<!--\s*\/agent-state:\1\s*-->/g, (_m, name: string, body: string) => {
		const idx = stateBlocks.length;
		stateBlocks.push({ name, body });
		return `\u0000STATE${idx}\u0000`;
	});

	// Preserve <!-- agent-bind:NAME -->X<!-- /agent-bind:NAME --> inline binds
	const bindBlocks: Array<{ name: string; body: string }> = [];
	src = src.replace(/<!--\s*agent-bind:([\w.-]+)\s*-->([\s\S]*?)<!--\s*\/agent-bind:\1\s*-->/g, (_m, name: string, body: string) => {
		const idx = bindBlocks.length;
		bindBlocks.push({ name, body });
		return `\u0000BIND${idx}\u0000`;
	});

	const escape = (s: string) =>
		s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

	// Code fences
	const codeBlocks: string[] = [];
	src = src.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
		codeBlocks.push(`<pre class="cmd-code"><code class="lang-${escape(lang || 'text')}">${escape(code)}</code></pre>`);
		return `\u0000CODE${codeBlocks.length - 1}\u0000`;
	});

	// Split into lines and run a small block-level parser
	const lines = src.split('\n');
	const out: string[] = [];
	let inUl = false;
	let inOl = false;
	const closeLists = () => {
		if (inUl) { out.push('</ul>'); inUl = false; }
		if (inOl) { out.push('</ol>'); inOl = false; }
	};

	const renderInline = (text: string): string => {
		let t = escape(text);
		// links
		t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
		// bold then italic
		t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
		// inline code
		t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
		return t;
	};

	for (const rawLine of lines) {
		const line = rawLine;
		// Heading
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) {
			closeLists();
			const level = h[1].length;
			const slug = h[2].trim().toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
			out.push(`<h${level} id="h-${slug}">${renderInline(h[2])}</h${level}>`);
			continue;
		}
		// Todo list item
		const todo = /^[\-\*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
		if (todo) {
			if (inOl) { out.push('</ol>'); inOl = false; }
			if (!inUl) { out.push('<ul class="cmd-tasklist">'); inUl = true; }
			const checked = todo[1].toLowerCase() === 'x';
			const text = renderInline(todo[2]);
			out.push(`<li><label class="cmd-task"><input type="checkbox" data-agent-task ${checked ? 'checked' : ''}/> ${text}</label></li>`);
			continue;
		}
		// Unordered list item
		const ul = /^[\-\*]\s+(.*)$/.exec(line);
		if (ul) {
			if (inOl) { out.push('</ol>'); inOl = false; }
			if (!inUl) { out.push('<ul>'); inUl = true; }
			out.push(`<li>${renderInline(ul[1])}</li>`);
			continue;
		}
		// Ordered list item
		const ol = /^\d+\.\s+(.*)$/.exec(line);
		if (ol) {
			if (inUl) { out.push('</ul>'); inUl = false; }
			if (!inOl) { out.push('<ol>'); inOl = true; }
			out.push(`<li>${renderInline(ol[1])}</li>`);
			continue;
		}
		// Blank line
		if (!line.trim()) {
			closeLists();
			continue;
		}
		// Paragraph
		closeLists();
		out.push(`<p>${renderInline(line)}</p>`);
	}
	closeLists();

	let html = out.join('\n');

	// Restore code blocks
	html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeBlocks[parseInt(idx, 10)] || '');
	// Restore agent-state blocks (recursively render the inner body)
	html = html.replace(/\u0000STATE(\d+)\u0000/g, (_m, idx: string) => {
		const blk = stateBlocks[parseInt(idx, 10)];
		if (!blk) { return ''; }
		const inner = builtInRenderMarkdown(blk.body);
		return `<div data-agent-state="${escape(blk.name)}">${inner}</div>`;
	});
	// Restore agent-bind inline binds
	html = html.replace(/\u0000BIND(\d+)\u0000/g, (_m, idx: string) => {
		const blk = bindBlocks[parseInt(idx, 10)];
		if (!blk) { return ''; }
		return `<span data-agent-bind="${escape(blk.name)}">${renderInline(blk.body)}</span>`;
	});

	return html;
}

/**
 * Sanitize HTML — strips dangerous tags/attributes. Lightweight; for higher safety,
 * the iframe sandbox is the primary defense.
 */
function sanitizeHtml(html: string): string {
	// Strip <script>, <iframe>, <object>, <embed>, on*= handlers, javascript: URLs
	let s = html.replace(/<\s*(script|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
	s = s.replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*\/?\s*>/gi, '');
	s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
	s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
	s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
	s = s.replace(/javascript:/gi, '');
	return s;
}

/**
 * Wrap rendered HTML into a complete, self-contained document suitable for
 * writing to disk and opening in the host editor. The document includes
 * default preview styles plus any user-provided stylesContent.
 */
function buildStandalonePreviewDoc(html: string, stylesContent?: string): string {
	const baseStyles = `
:root { color-scheme: light dark; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
	font-size: 14px;
	line-height: 1.65;
	color: #d4d4d4;
	background: #1e1e1e;
	margin: 0;
	padding: 22px 28px 40px;
	max-width: 920px;
}
h1,h2,h3,h4,h5,h6 { line-height: 1.25; margin: 18px 0 8px; }
h1 { font-size: 1.7em; }
h2 { font-size: 1.4em; padding-bottom: 6px; border-bottom: 1px solid rgba(127,127,127,0.25); }
h3 { font-size: 1.18em; }
p { margin: 8px 0; }
a { color: #4ea1ff; }
ul, ol { padding-left: 1.5em; }
li { margin: 3px 0; }
code { background: rgba(127,127,127,0.18); padding: 1px 5px; border-radius: 3px; font-family: "Cascadia Code", Consolas, monospace; font-size: 12.5px; }
pre { background: #252526; padding: 12px 14px; border-radius: 6px; overflow-x: auto; border: 1px solid rgba(127,127,127,0.22); }
pre code { background: transparent; padding: 0; }
blockquote { border-left: 3px solid #4ea1ff; background: rgba(78,161,255,0.10); margin: 10px 0; padding: 8px 12px; border-radius: 0 4px 4px 0; }
hr { border: 0; border-top: 1px dashed rgba(127,127,127,0.30); margin: 24px 0; }
input[type="checkbox"] { margin-right: 6px; }
[data-agent-bind] { background: rgba(78,161,255,0.12); padding: 0 4px; border-radius: 2px; }
[data-agent-state] { padding: 2px 4px; border-left: 2px solid rgba(127,127,127,0.30); margin: 6px 0; }
@media (prefers-color-scheme: light) {
	body { color: #1e1e1e; background: #ffffff; }
	pre { background: #f5f5f5; border-color: rgba(127,127,127,0.22); }
}
${IMGUI_SDK_STYLES}
`;
	// IMPORTANT: The imgui SDK <script> is appended OUTSIDE of the rendered
	// markdown HTML (which has been passed through `sanitizeHtml`, stripping
	// scripts). It runs in the standalone preview document only, where the
	// host fully controls the source.
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>ConfigMD Preview</title>
<style>${baseStyles}
${stylesContent || ''}
</style>
</head>
<body>
${html}
<script>${IMGUI_SDK_SCRIPT}</script>
</body>
</html>
`;
}

// ─── Patch application ───────────────────────────────────────────────────────

function applyPatchOps(markdown: string, patches: IConfigMdPatchOp[]): string {
	let md = markdown;
	for (const p of patches) {
		switch (p.op) {
			case 'replace-all':
				md = p.content;
				break;
			case 'append':
				md = md + (md.endsWith('\n') ? '' : '\n') + p.content;
				break;
			case 'prepend':
				md = p.content + (p.content.endsWith('\n') ? '' : '\n') + md;
				break;
			case 'replace-anchor': {
				if (!p.anchor) { break; }
				const re = new RegExp(
					`(<!--\\s*agent-state:${escapeRegExp(p.anchor)}\\s*-->)([\\s\\S]*?)(<!--\\s*/agent-state:${escapeRegExp(p.anchor)}\\s*-->)`,
				);
				if (re.test(md)) {
					md = md.replace(re, `$1\n${p.content}\n$3`);
				} else {
					// Anchor not found — append a new block
					md += `\n\n<!-- agent-state:${p.anchor} -->\n${p.content}\n<!-- /agent-state:${p.anchor} -->\n`;
				}
				break;
			}
			case 'replace-bind': {
				if (!p.anchor) { break; }
				const re = new RegExp(
					`(<!--\\s*agent-bind:${escapeRegExp(p.anchor)}\\s*-->)([\\s\\S]*?)(<!--\\s*/agent-bind:${escapeRegExp(p.anchor)}\\s*-->)`,
				);
				if (re.test(md)) {
					md = md.replace(re, `$1${p.content}$3`);
				}
				break;
			}
			case 'replace-section': {
				if (!p.heading) { break; }
				const lines = md.split('\n');
				const headingTrim = p.heading.trim();
				const startIdx = lines.findIndex(l => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, '').trim() === headingTrim);
				if (startIdx < 0) { break; }
				const headingLevel = (lines[startIdx].match(/^(#{1,6})/) || ['', ''])[1].length;
				let endIdx = lines.length;
				for (let i = startIdx + 1; i < lines.length; i++) {
					const m = /^(#{1,6})\s+/.exec(lines[i]);
					if (m && m[1].length <= headingLevel) { endIdx = i; break; }
				}
				const before = lines.slice(0, startIdx + 1).join('\n');
				const after = lines.slice(endIdx).join('\n');
				md = `${before}\n${p.content}${after ? '\n' + after : ''}`;
				break;
			}
		}
	}
	return md;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ConfigHtmlService extends Disposable implements IConfigHtmlService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSource = this._register(new Emitter<{ agentId: string; markdown: string; version: number; origin: ConfigMdChangeOrigin }>());
	readonly onDidChangeSource: Event<{ agentId: string; markdown: string; version: number; origin: ConfigMdChangeOrigin }> = this._onDidChangeSource.event;

	private readonly _onDidRenderHtml = this._register(new Emitter<{ agentId: string; html: string; version: number; stylesContent?: string }>());
	readonly onDidRenderHtml: Event<{ agentId: string; html: string; version: number; stylesContent?: string }> = this._onDidRenderHtml.event;

	private readonly _onDidEmitCommand = this._register(new Emitter<{ agentId: string; command: IConfigMdCommand }>());
	readonly onDidEmitCommand: Event<{ agentId: string; command: IConfigMdCommand }> = this._onDidEmitCommand.event;

	private readonly _onDidReceiveHtmlEvent = this._register(new Emitter<{ agentId: string; eventName: string; payload: unknown }>());
	readonly onDidReceiveHtmlEvent: Event<{ agentId: string; eventName: string; payload: unknown }> = this._onDidReceiveHtmlEvent.event;

	private readonly _onDidRequestChatSend = this._register(new Emitter<{ agentId: string; message: string; agentSessionId?: string; workspaceId?: string; workspaceSessionId?: string }>());
	readonly onDidRequestChatSend: Event<{ agentId: string; message: string; agentSessionId?: string; workspaceId?: string; workspaceSessionId?: string }> = this._onDidRequestChatSend.event;

	private readonly _onDidRequestCanvasPreview = this._register(new Emitter<{ agentId: string }>());
	readonly onDidRequestCanvasPreview: Event<{ agentId: string }> = this._onDidRequestCanvasPreview.event;

	private readonly _agents = new Map<string, IAgentMdState>();
	private readonly _rateLimits = new Map<string, { count: number; resetAt: number }>();

	/**
	 * `agentId → agentSessionId` for the agent session currently visible
	 * in a chat panel. Populated by chat panel controllers via
	 * {@link setActiveAgentSession}; consumed by `_handleImguiSubmit` so that
	 * imgui form submits land in the same Fork session the user is looking
	 * at instead of dropping into the default session.
	 *
	 * `undefined` (i.e. no entry) means: no chat panel has registered, so
	 * imgui submits will fall through to the default-session behaviour
	 * (matching the pre-Phase-3 path).
	 */
	private readonly _activeAgentSessions = new Map<string, string>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@IAgentChatService private readonly agentChatService: IAgentChatService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
	) {
		super();
	}

	override dispose(): void {
		for (const [id] of this._agents) {
			this.disposeAgent(id);
		}
		super.dispose();
	}

	disposeAgent(agentId: string): void {
		const st = this._agents.get(agentId);
		if (st) {
			st.disposables.dispose();
			this._agents.delete(agentId);
		}
	}

	// ─── Active Agent Session Registry ─────────────────────────────────────

	setActiveAgentSession(agentId: string, agentSessionId: string | undefined): void {
		if (!agentId) { return; }
		const prev = this._activeAgentSessions.get(agentId);
		if (agentSessionId) {
			if (prev === agentSessionId) { return; }
			this._activeAgentSessions.set(agentId, agentSessionId);
		} else {
			if (prev === undefined) { return; }
			this._activeAgentSessions.delete(agentId);
		}
		this.logService.info(`[ConfigMD] active session: ${agentId} ${prev || '<none>'} → ${agentSessionId || '<none>'}`);
	}

	getActiveAgentSession(agentId: string): string | undefined {
		return this._activeAgentSessions.get(agentId);
	}

	// ─── Capability Check ──────────────────────────────────────────────────

	async checkCapability(agentId: string, capability: ConfigMdCapability): Promise<void> {
		const employee = await this.agentStudioService.getEmployee(agentId);
		if (!employee) {
			throw new Error(`Employee '${agentId}' not found`);
		}
		const allowed = employee.configMd?.capabilities;
		// If capabilities is not configured, allow read-only and chat capabilities by default
		if (!allowed) {
			const defaultAllowed: ConfigMdCapability[] = ['md.read', 'md.write', 'chat.send', 'chat.history', 'agent.status', 'agent.config'];
			if (!defaultAllowed.includes(capability)) {
				throw new Error(`ConfigMD capability '${capability}' not allowed by default for agent '${employee.name}'`);
			}
			return;
		}
		if (!allowed.includes(capability)) {
			throw new Error(
				`ConfigMD capability '${capability}' not allowed for agent '${employee.name}'. `
				+ `Allowed: [${allowed.join(', ')}]`,
			);
		}
	}

	private _checkRateLimit(agentId: string): void {
		const now = Date.now();
		let entry = this._rateLimits.get(agentId);
		if (!entry || now > entry.resetAt) {
			entry = { count: 0, resetAt: now + 60_000 };
			this._rateLimits.set(agentId, entry);
		}
		entry.count++;
		if (entry.count > RATE_LIMIT_PER_MINUTE) {
			throw new Error(`ConfigMD rate limit exceeded for agent '${agentId}'`);
		}
	}

	// ─── State Resolution ──────────────────────────────────────────────────

	/**
	 * Resolve the absolute filesystem URI for an employee's agent directory.
	 *
	 * `employee.agentDir` is just the leaf folder name (e.g. `researcher-nlmniq3`),
	 * NOT an absolute path. The actual location is
	 *   `<workspace.path>/<WORKSPACE_DATA_DIR>/<AGENTS_DIR>/<employee.agentDir>/`
	 *
	 * Returns `undefined` when the employee has no `agentDir` or the workspace
	 * has no `path` (e.g. global/in-memory workspaces).
	 */
	private async _resolveAgentDirUri(employee: Employee): Promise<URI | undefined> {
		if (!employee.agentDir) { return undefined; }
		if (!employee.workspaceId) {
			this.logService.warn(`[ConfigMD] Employee '${employee.id}' has no workspaceId; cannot resolve agent dir`);
			return undefined;
		}
		const workspace = await this.agentStudioService.getWorkspace(employee.workspaceId);
		if (!workspace?.path) {
			this.logService.warn(`[ConfigMD] Workspace '${employee.workspaceId}' has no path; cannot resolve agent dir for ${employee.id}`);
			return undefined;
		}
		return URI.joinPath(URI.file(workspace.path), WORKSPACE_DATA_DIR, AGENTS_DIR, employee.agentDir);
	}

	private async _ensureState(agentId: string): Promise<IAgentMdState | null> {
		const existing = this._agents.get(agentId);
		if (existing) { return existing; }

		const employee = await this.agentStudioService.getEmployee(agentId);
		if (!employee?.configMd || !employee.agentDir) {
			return null;
		}

		const agentDirUri = await this._resolveAgentDirUri(employee);
		if (!agentDirUri) { return null; }

		const cfg = employee.configMd;
		// ConfigHtml migration: the panel now stores raw HTML in `config.html`.
		// Resolution order:
		//   1) explicit cfg.mdPath (respect whatever was configured)
		//   2) existing config.html on disk (new ConfigHtml panels)
		//   3) existing config.md on disk (legacy ConfigMD panels — kept as-is)
		//   4) neither exists → create config.html with an HTML scaffold
		let mdRel = cfg.mdPath;
		if (!mdRel) {
			const htmlUri = URI.joinPath(agentDirUri, 'config.html');
			const legacyUri = URI.joinPath(agentDirUri, 'config.md');
			if (await this.fileService.exists(htmlUri)) {
				mdRel = 'config.html';
			} else if (await this.fileService.exists(legacyUri)) {
				mdRel = 'config.md';
			} else {
				mdRel = 'config.html';
			}
		}
		const mdUri = URI.joinPath(agentDirUri, mdRel);
		const isHtmlPanel = mdRel.toLowerCase().endsWith('.html');

		// Read source (create a default scaffold if the file is missing)
		let markdown = '';
		try {
			const buf = await this.fileService.readFile(mdUri);
			markdown = buf.value.toString();
		} catch {
			// Create the file with a default scaffold. HTML panels get a
			// minimal self-contained document; legacy markdown panels keep the
			// old anchor-based scaffold.
			markdown = isHtmlPanel
				? buildDefaultConfigHtml(employee.name)
				: `# ${employee.name}'s Panel\n\n<!-- agent-state:notes -->\n_(Empty)_\n<!-- /agent-state:notes -->\n`;
			try {
				await this.fileService.writeFile(mdUri, VSBuffer.fromString(markdown));
			} catch (err) {
				this.logService.warn(`[ConfigMD] Failed to scaffold ${mdUri.fsPath}:`, err);
			}
		}

		// Optional styles
		let stylesContent: string | undefined;
		if (cfg.stylesPath) {
			try {
				const sUri = URI.joinPath(agentDirUri, cfg.stylesPath);
				const sBuf = await this.fileService.readFile(sUri);
				stylesContent = sBuf.value.toString();
			} catch (err) {
				this.logService.warn(`[ConfigMD] Failed to read styles ${cfg.stylesPath}:`, err);
			}
		}

		// Optional custom parser (sandboxed via Function constructor)
		let customParser: IMdParser | undefined;
		if (cfg.parserPath) {
			try {
				const pUri = URI.joinPath(agentDirUri, cfg.parserPath);
				const pBuf = await this.fileService.readFile(pUri);
				customParser = this._loadParserScript(pBuf.value.toString(), agentId);
			} catch (err) {
				this.logService.warn(`[ConfigMD] Failed to load custom parser ${cfg.parserPath}:`, err);
			}
		}

		// Initial render
		const html = this._renderInternal(markdown, customParser, agentId);

		// File watcher
		const disposables = new DisposableStore();
		try {
			disposables.add(this.fileService.watch(mdUri));
		} catch (err) {
			this.logService.warn(`[ConfigMD] watch failed for ${mdUri.fsPath}:`, err);
		}

		const state: IAgentMdState = {
			markdown,
			html,
			stylesContent,
			customParser,
			version: 1,
			mdUri,
			disposables,
			selfWriteEpoch: 0,
		};
		this._agents.set(agentId, state);

		// Subscribe to file changes (external edits)
		disposables.add(
			this.fileService.onDidFilesChange((e) => {
				if (!e.contains(mdUri, FileChangeType.UPDATED) && !e.contains(mdUri, FileChangeType.ADDED)) {
					return;
				}
				// Suppress echo: if we just wrote, skip the next change event
				if (state.pendingWriteOrigin) {
					state.pendingWriteOrigin = undefined;
					return;
				}
				void this._onExternalChange(agentId);
			}),
		);

		return state;
	}

	private _loadParserScript(source: string, agentId: string): IMdParser | undefined {
		try {
			// Provide a minimal CommonJS-like environment.
			// Custom parsers may reference the global `marked` if they bring it themselves.
			const moduleObj: { exports: unknown } = { exports: {} };
			const exportsObj: Record<string, unknown> = {};
			// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
			const fn = new Function('module', 'exports', 'console', source);
			fn(moduleObj, exportsObj, { log: (..._a: unknown[]) => undefined, warn: (..._a: unknown[]) => undefined });
			const exported: unknown = (moduleObj.exports && Object.keys(moduleObj.exports as object).length)
				? moduleObj.exports
				: exportsObj;
			const candidate = (exported as { default?: unknown }).default ?? exported;
			if (candidate && typeof (candidate as IMdParser).parse === 'function') {
				return candidate as IMdParser;
			}
			this.logService.warn(`[ConfigMD] Custom parser for ${agentId} did not export parse()`);
		} catch (err) {
			this.logService.warn(`[ConfigMD] Failed to evaluate custom parser for ${agentId}:`, err);
		}
		return undefined;
	}

	private _renderInternal(markdown: string, parser: IMdParser | undefined, agentId: string): string {
		// ConfigHtml mode: a complete, self-contained HTML document is used
		// VERBATIM as its own rendered output. We must NOT run it through the
		// Markdown renderer (which would escape the markup) nor `sanitizeHtml`
		// (which would strip the inlined <style>/<script> that make it
		// self-contained and, in the Canvas, editable).
		if (isFullHtmlDocument(markdown)) {
			return markdown;
		}
		let rendered: string;
		try {
			if (parser) {
				rendered = parser.parse(markdown, { agentId: agentId });
			} else {
				rendered = builtInRenderMarkdown(markdown);
			}
		} catch (err) {
			this.logService.warn(`[ConfigMD] Custom parser threw, falling back to built-in:`, err);
			rendered = builtInRenderMarkdown(markdown);
		}
		// Post-process: replace ` ```imgui ` code blocks rendered as
		// `<pre><code class="lang-imgui">...</code></pre>` (built-in renderer)
		// or `<pre><code class="language-imgui">...</code></pre>` (most third-
		// party parsers) with the actual interactive <form> markup. This is
		// done AFTER the markdown step so we don't interfere with the parser
		// (which would otherwise escape the angle brackets).
		const sanitized = sanitizeHtml(rendered);
		return postProcessImguiBlocks(sanitized);
	}

	private async _onExternalChange(agentId: string): Promise<void> {
		const st = this._agents.get(agentId);
		if (!st) { return; }
		try {
			const buf = await this.fileService.readFile(st.mdUri);
			const md = buf.value.toString();
			if (md === st.markdown) { return; }
			st.markdown = md;
			st.version++;
			st.html = this._renderInternal(md, st.customParser, agentId);
			this._onDidChangeSource.fire({ agentId: agentId, markdown: md, version: st.version, origin: 'external' });
			this._onDidRenderHtml.fire({ agentId: agentId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		} catch (err) {
			this.logService.warn(`[ConfigMD] external change re-read failed:`, err);
		}
	}

	async resolveState(agentId: string): Promise<IConfigMdState | null> {
		const st = await this._ensureState(agentId);
		if (!st) { return null; }
		return {
			markdown: st.markdown,
			html: st.html,
			version: st.version,
			stylesContent: st.stylesContent,
			parserSource: st.customParser ? 'custom' : 'builtin',
		};
	}

	async readSource(agentId: string): Promise<{ markdown: string; version: number }> {
		await this.checkCapability(agentId, 'md.read');
		const st = await this._ensureState(agentId);
		if (!st) { throw new Error(`ConfigMD not configured for ${agentId}`); }
		return { markdown: st.markdown, version: st.version };
	}

	async writeSource(
		agentId: string,
		markdown: string,
		options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
	): Promise<{ version: number }> {
		await this.checkCapability(agentId, 'md.write');
		const st = await this._ensureState(agentId);
		if (!st) { throw new Error(`ConfigMD not configured for ${agentId}`); }
		const origin = options?.origin || 'editor';
		if (options?.baseVersion != null && options.baseVersion !== st.version) {
			throw new Error(`Stale write: baseVersion=${options.baseVersion}, current=${st.version}`);
		}
		if (markdown === st.markdown) {
			return { version: st.version };
		}
		st.markdown = markdown;
		st.version++;
		st.pendingWriteOrigin = origin;
		st.selfWriteEpoch++;
		try {
			await this.fileService.writeFile(st.mdUri, VSBuffer.fromString(markdown));
		} catch (err) {
			this.logService.error(`[ConfigMD] Failed to write ${st.mdUri.fsPath}:`, err);
			throw err;
		}
		st.html = this._renderInternal(markdown, st.customParser, agentId);
		this._onDidChangeSource.fire({ agentId: agentId, markdown, version: st.version, origin });
		this._onDidRenderHtml.fire({ agentId: agentId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		return { version: st.version };
	}

	async applyPatch(
		agentId: string,
		patches: IConfigMdPatchOp[],
		options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
	): Promise<{ version: number; markdown: string }> {
		await this.checkCapability(agentId, 'md.write');
		const st = await this._ensureState(agentId);
		if (!st) { throw new Error(`ConfigMD not configured for ${agentId}`); }
		if (options?.baseVersion != null && options.baseVersion !== st.version) {
			throw new Error(`Stale patch: baseVersion=${options.baseVersion}, current=${st.version}`);
		}
		const newMd = applyPatchOps(st.markdown, patches);
		const res = await this.writeSource(agentId, newMd, { origin: options?.origin || 'html' });
		return { version: res.version, markdown: newMd };
	}

	async renderHtml(agentId: string, markdown?: string): Promise<{ html: string; version: number }> {
		const st = await this._ensureState(agentId);
		if (!st) { throw new Error(`ConfigMD not configured for ${agentId}`); }
		const md = markdown ?? st.markdown;
		const html = this._renderInternal(md, st.customParser, agentId);
		if (markdown === undefined) {
			st.html = html;
		}
		this._onDidRenderHtml.fire({ agentId: agentId, html, version: st.version, stylesContent: st.stylesContent });
		return { html, version: st.version };
	}

	/**
	 * Render the current MD into a complete standalone HTML document and write
	 * it to `<agentDir>/.preview.html`. Returns the absolute filesystem path so
	 * the caller can open it in the host editor.
	 *
	 * The generated file is self-contained: it inlines stylesContent (if any)
	 * and a small set of default styles. It is regenerated on every call.
	 */
	async previewToFile(agentId: string): Promise<{ path: string; version: number }> {
		const employee = await this.agentStudioService.getEmployee(agentId);
		if (!employee?.agentDir) {
			throw new Error(`Agent directory not found for ${agentId}`);
		}
		const agentDirUri = await this._resolveAgentDirUri(employee);
		if (!agentDirUri) {
			throw new Error(`Cannot resolve agent directory for ${agentId} (workspace has no path)`);
		}
		const st = await this._ensureState(agentId);
		if (!st) { throw new Error(`ConfigMD not configured for ${agentId}`); }

		// ConfigHtml mode: when the source is already a complete, self-contained
		// HTML document (what the `confightml` skill produces), write it out
		// VERBATIM — no Markdown rendering, no sanitize, no template wrapper.
		// Sanitizing here would strip the inlined <style>/<script> that make the
		// document self-contained and (later) editable in the Canvas.
		let doc: string;
		if (isFullHtmlDocument(st.markdown)) {
			doc = st.markdown;
			st.html = st.markdown;
		} else {
			st.html = this._renderInternal(st.markdown, st.customParser, agentId);
			doc = buildStandalonePreviewDoc(st.html, st.stylesContent);
		}
		const previewUri = URI.joinPath(agentDirUri, '.preview.html');
		try {
			await this.fileService.writeFile(previewUri, VSBuffer.fromString(doc));
		} catch (err) {
			this.logService.error(`[ConfigMD] Failed to write preview ${previewUri.fsPath}:`, err);
			throw err;
		}
		this.logService.info(`[ConfigMD] Wrote preview to ${previewUri.fsPath}`);
		return { path: previewUri.fsPath, version: st.version };
	}

	// ─── HTML Event Handling ───────────────────────────────────────────────

	async handleHtmlEvent(
		agentId: string,
		eventName: string,
		payload: unknown,
		agentSessionId?: string,
	): Promise<void> {
		await this.checkCapability(agentId, 'chat.send');
		this._checkRateLimit(agentId);
		this._onDidReceiveHtmlEvent.fire({ agentId: agentId, eventName, payload });

		// imgui.submit: a button in an `imgui` block was clicked. Route by
		// `payload.action` instead of wrapping the event blindly.
		if (eventName === 'imgui.submit') {
			await this._handleImguiSubmit(agentId, payload, agentSessionId);
			return;
		}

		const wrapped = `[ConfigMD HTML Event: ${eventName}]\n${JSON.stringify(payload, null, 2)}`;
		try {
			const employee = await this.agentStudioService.getEmployee(agentId);
			const chatMessage = await this.agentChatService.sendMessage(
				agentId,
				wrapped,
				{ agentSessionId, workspaceId: employee?.workspaceId },
				() => undefined,
			);
			if (chatMessage?.content) {
				await this._consumeModelOutput(agentId, chatMessage.content);
			}
		} catch (err) {
			this.logService.error(`[ConfigMD] handleHtmlEvent failed for ${agentId}:`, err);
		}
	}

	/**
	 * Handle an `imgui.submit` event posted by the SDK in the preview HTML.
	 *
	 * Phase 2 supports the following actions. Unknown actions are logged
	 * and ignored. The SDK contract is fixed (the `payload` shape is the
	 * same across actions); each handler picks out the fields it needs.
	 *
	 *   send_to_chat — send `payload.message` (already template-rendered) as
	 *                  a chat message in the agent's active session.
	 *
	 *   run_skill    — send a chat message that begins with a skill hint,
	 *                  e.g. `[skill:web-search] {message}`. The model is
	 *                  expected to interpret the hint and call the skill.
	 *                  Button must declare `skill="..."`.
	 *
	 *   set_state    — atomically replace an `<!-- agent-state:NAME -->`
	 *                  block in the markdown source with `payload.message`
	 *                  (template-rendered content). Button must declare
	 *                  `anchor="..."`. Equivalent to a `replace-anchor`
	 *                  patch op but more ergonomic for simple updates.
	 *
	 *   patch        — apply an arbitrary list of patch operations supplied
	 *                  in `payload.payload` (parsed by the SDK as JSON). The
	 *                  full IConfigMdPatchOp[] schema is accepted, mirroring
	 *                  what the model itself would emit via a configmd-patch
	 *                  code block.
	 *
	 *   clear_chat   — clear the agent's chat history for the active session.
	 *
	 *   noop         — do nothing on the host side; useful when a button
	 *                  exists purely to trigger client-side behaviour the
	 *                  SDK already handled (currently unused, reserved).
	 */
	private async _handleImguiSubmit(
		agentId: string,
		payload: unknown,
		agentSessionId?: string,
	): Promise<void> {
		const p = (payload || {}) as {
			formId?: string;
			buttonId?: string;
			action?: string;
			template?: string;
			message?: string;
			values?: Record<string, unknown>;
			anchor?: string;
			skill?: string;
			stateAnchor?: string;
			payload?: unknown;
			/** Trusted ctx re-attached by the host pane (preferred). */
			_ctx?: { agentId?: string; workspaceId?: string; workspaceSessionId?: string; agentSessionId?: string };
			/** Untrusted ctx echoed by the SDK. Fallback only. */
			ctx?: { agentId?: string; workspaceId?: string; workspaceSessionId?: string; agentSessionId?: string };
		};
		const action = p.action || 'send_to_chat';

		// Resolve routing context. Priority order:
		//   1. `_ctx` re-attached by HtmlPreviewEditorPane on the host side
		//      (trusted: comes from EditorInput captured at preview-open).
		//   2. The explicit `agentSessionId` argument (e.g. handleHtmlEvent
		//      caller-supplied — currently unused for imgui but kept for
		//      forward compat).
		//   3. `ctx` echoed by the SDK from the inbound `imgui.ctx`. This
		//      is technically attacker-controlled if the preview HTML were
		//      ever sourced from outside the host, but in practice it
		//      always matches `_ctx` and gives us a sanity-check log.
		//   4. The active-session registry (chat panel currently showing
		//      this employee). Last resort.
		const ctxTrusted = p._ctx || {};
		const ctxEcho = p.ctx || {};
		const resolvedSessionId =
			ctxTrusted.agentSessionId
			|| agentSessionId
			|| ctxEcho.agentSessionId
			|| this._activeAgentSessions.get(agentId);
		const resolvedWorkspaceId = ctxTrusted.workspaceId || ctxEcho.workspaceId;
		const resolvedWorkspaceSessionId = ctxTrusted.workspaceSessionId || ctxEcho.workspaceSessionId;

		this.logService.info(
			`[ConfigMD] imgui.submit ${agentId} form=${p.formId} button=${p.buttonId} action=${action} `
			+ `→ ws=${resolvedWorkspaceId || '<none>'} forkSession=${resolvedWorkspaceSessionId || '<none>'} `
			+ `agentSession=${resolvedSessionId || '<none>'}`
		);
		if (ctxTrusted.agentSessionId && ctxEcho.agentSessionId
			&& ctxTrusted.agentSessionId !== ctxEcho.agentSessionId) {
			this.logService.warn(
				`[ConfigMD] imgui.submit ctx mismatch: trusted=${ctxTrusted.agentSessionId} echoed=${ctxEcho.agentSessionId} `
				+ `— honoring the trusted (host-attached) value`
			);
		}

		// Phase 3: state snapshot. If the button declared `state="<anchor>"`,
		// persist the form's current values into agent.md at that anchor as
		// a JSON code block, BEFORE running the main action. The agent can
		// then read the form state in any later prompt by referencing the
		// anchor (or by reading the whole agent.md). We swallow errors here
		// so a misnamed anchor doesn't block the user's primary intent.
		const stateAnchor = (p.stateAnchor || '').trim();
		if (stateAnchor && p.values) {
			const snapshot = '```json\n' + JSON.stringify(p.values, null, 2) + '\n```';
			try {
				await this.applyPatch(
					agentId,
					[{ op: 'replace-anchor', anchor: stateAnchor, content: snapshot }],
					{ origin: 'html' },
				);
				this.logService.info(`[ConfigMD] imgui state snapshot → anchor='${stateAnchor}' (form=${p.formId})`);
			} catch (err) {
				this.logService.warn(`[ConfigMD] imgui state snapshot failed for anchor='${stateAnchor}':`, err);
			}
		}

		switch (action) {
			case 'send_to_chat': {
				const message = (p.message || '').trim();
				if (!message) {
					this.logService.warn(`[ConfigMD] imgui send_to_chat: empty message (button has no template?), dropping`);
					return;
				}
				this._sendChatMessage(agentId, message, resolvedSessionId, resolvedWorkspaceId, resolvedWorkspaceSessionId);
				return;
			}
			case 'run_skill': {
				const skill = (p.skill || '').trim();
				if (!skill) {
					this.logService.warn(`[ConfigMD] imgui run_skill: missing 'skill' attribute on button, dropping`);
					return;
				}
				const body = (p.message || '').trim();
				const message = body
					? `[skill:${skill}] ${body}`
					: `[skill:${skill}] 请使用此 skill 完成相关任务。`;
				this._sendChatMessage(agentId, message, resolvedSessionId, resolvedWorkspaceId, resolvedWorkspaceSessionId);
				return;
			}
			case 'set_state': {
				const anchor = (p.anchor || '').trim();
				if (!anchor) {
					this.logService.warn(`[ConfigMD] imgui set_state: missing 'anchor' attribute on button, dropping`);
					return;
				}
				const content = p.message || '';
				try {
					await this.applyPatch(
						agentId,
						[{ op: 'replace-anchor', anchor, content }],
						{ origin: 'html' },
					);
				} catch (err) {
					this.logService.error(`[ConfigMD] imgui set_state failed for ${agentId} anchor=${anchor}:`, err);
				}
				return;
			}
			case 'patch': {
				// Accept patches via either `payload.payload` (parsed JSON) or
				// the rendered template (in case authors use template= for it).
				let ops: unknown = p.payload;
				if (ops === undefined) {
					try { ops = JSON.parse(p.message || ''); } catch { ops = undefined; }
				}
				if (!Array.isArray(ops)) {
					this.logService.warn(`[ConfigMD] imgui patch: payload is not an array of ops`);
					return;
				}
				try {
					await this.applyPatch(agentId, ops as IConfigMdPatchOp[], { origin: 'html' });
				} catch (err) {
					this.logService.error(`[ConfigMD] imgui patch failed for ${agentId}:`, err);
				}
				return;
			}
			case 'clear_chat': {
				try {
					await this.agentChatService.clearHistory(agentId, resolvedSessionId);
				} catch (err) {
					this.logService.error(`[ConfigMD] imgui clear_chat failed for ${agentId}:`, err);
				}
				return;
			}
			case 'noop':
				return;
			default:
				this.logService.warn(`[ConfigMD] Unknown imgui action '${action}' (Phase 2 supports send_to_chat / run_skill / set_state / patch / clear_chat / noop)`);
				return;
		}
	}

	/**
	 * Internal helper: route an imgui-originated chat message through the
	 * webview controller's full chat.send pipeline.
	 *
	 * We DO NOT call `agentChatService.sendMessage` directly here, because
	 * that path bypasses two essential responsibilities of the controller:
	 *   1. Persisting the user message to chat history (so the chat UI
	 *      shows the message the user "sent" via the imgui button).
	 *   2. Streaming `chat.stream.delta` events to the chat panel webview
	 *      so the in-flight thinking/text is visible.
	 *
	 * Instead we fire `onDidRequestChatSend`, which the controller listens
	 * to and forwards into its existing `_handleChatSend` flow — making
	 * imgui submits behaviorally identical to typing in the chat input.
	 *
	 * Phase 3: if the caller didn't supply an `agentSessionId` (the common
	 * case — preview pane doesn't track sessions), fall back to the active
	 * session registered by the chat panel controller. This makes imgui
	 * submits land in the Fork session the user is actually looking at.
	 */
	private _sendChatMessage(
		agentId: string,
		message: string,
		agentSessionId?: string,
		workspaceId?: string,
		workspaceSessionId?: string,
	): void {
		const resolvedSessionId = agentSessionId || this._activeAgentSessions.get(agentId);
		if (!agentSessionId && resolvedSessionId) {
			this.logService.info(`[ConfigMD] _sendChatMessage: resolved sessionId from registry: ${agentId} → ${resolvedSessionId}`);
		}
		this._onDidRequestChatSend.fire({
			agentId: agentId,
			message,
			agentSessionId: resolvedSessionId,
			workspaceId,
			workspaceSessionId,
		});
	}

	async handleChatSend(
		agentId: string,
		message: string,
		options?: { context?: string; showInChat?: boolean; agentSessionId?: string },
	): Promise<ChatMessage> {
		await this.checkCapability(agentId, 'chat.send');
		this._checkRateLimit(agentId);
		const employee = await this.agentStudioService.getEmployee(agentId);
		const fullMsg = options?.context
			? `[Context from ConfigMD]\n${options.context}\n\n${message}`
			: message;
		const chatMessage = await this.agentChatService.sendMessage(
			agentId,
			fullMsg,
			{ agentSessionId: options?.agentSessionId, workspaceId: employee?.workspaceId },
			() => undefined,
		);
		if (chatMessage?.content) {
			await this._consumeModelOutput(agentId, chatMessage.content);
		}
		return chatMessage;
	}

	private async _consumeModelOutput(agentId: string, content: string): Promise<void> {
		const { patches, commands } = this.parseModelOutput(content);
		if (patches.length > 0) {
			try {
				await this.applyPatch(agentId, patches, { origin: 'model' });
			} catch (err) {
				this.logService.warn(`[ConfigMD] Failed to apply model patches:`, err);
			}
		}
		for (const cmd of commands) {
			this.sendCommandToHtml(agentId, cmd);
		}
	}

	/**
	 * ConfigHtml: send a natural-language request to the model and get back a
	 * complete single-file HTML document.
	 *
	 * Strategy (root-cause fix for "模型未返回可用的 HTML"):
	 *   1. **Function calling (primary)** — call the active model provider's
	 *      `chat()` directly with a forced `emit_html` tool (toolChoice:
	 *      'required'). The model returns the document as a STRUCTURED tool-call
	 *      argument, so extraction is deterministic and immune to prose-wrapping,
	 *      missing code fences, or partial markdown that broke the regex parser.
	 *   2. **Text fallback** — if function calling is unavailable (e.g. the
	 *      active provider executes tools server-side, has no tools support, or
	 *      returned nothing usable), fall back to the legacy path:
	 *      `agentChatService.sendMessage` + `extractHtmlBlock`.
	 *
	 * Unlike `handleChatSend`, this does NOT route into the main chat panel — it
	 * is a self-contained one-shot generation used by the ConfigHtml AI box.
	 */
	async htmlGenerate(
		agentId: string,
		message: string,
		options?: { currentHtml?: string; model?: string },
	): Promise<{ html: string; raw: string }> {
		await this.checkCapability(agentId, 'chat.send');
		this._checkRateLimit(agentId);
		const employee = await this.agentStudioService.getEmployee(agentId);

		const systemPrompt = CONFIGHTML_SYSTEM_PROMPT;
		const userMsg = options?.currentHtml && options.currentHtml.trim()
			? `${message}\n\n---\n当前 config.html 内容（请在此基础上修改并输出完整文档）：\n\n\`\`\`html\n${options.currentHtml}\n\`\`\``
			: message;

		// ── 1. Function calling (primary path) ──────────────────────────────
		try {
			const fc = await this._htmlGenerateViaFunctionCall(
				agentId,
				systemPrompt,
				userMsg,
				options?.model,
			);
			if (fc && fc.html && fc.html.trim()) {
				return { html: fc.html.trim(), raw: fc.raw };
			}
			this.logService.info(
				'[ConfigHtml] Function-call path returned no HTML; falling back to text extraction.',
			);
		} catch (err) {
			this.logService.warn(
				'[ConfigHtml] Function-call generation failed; falling back to text extraction:',
				err,
			);
		}

		// ── 2. Text fallback (legacy path) ──────────────────────────────────
		const chatMessage = await this.agentChatService.sendMessage(
			agentId,
			userMsg,
			{
				systemPrompt,
				explicitSkillIds: ['confightml'],
				model: options?.model,
				workspaceId: employee?.workspaceId,
				// One-shot generation: no chat history session, no tool loop.
				chatMode: 'ask',
			},
			() => undefined,
		);

		const raw = chatMessage?.content || '';
		const html = extractHtmlBlock(raw);
		return { html, raw };
	}

	/**
	 * Drive the active model provider's `chat()` directly with a single forced
	 * `emit_html` tool, then read the `html` argument out of the resulting
	 * tool call. Returns `null` when function calling isn't viable (no active
	 * provider, server-side tool execution, or no tool call produced) so the
	 * caller can fall back to text extraction.
	 */
	private async _htmlGenerateViaFunctionCall(
		agentId: string,
		systemPrompt: string,
		userMsg: string,
		model?: string,
	): Promise<{ html: string; raw: string } | null> {
		const selection = this.agentOSService.getActiveModelSelection();
		if (!selection || !selection.providerId) {
			return null;
		}
		const provider: IModelProvider | undefined = this.agentOSService
			.getModelProviders()
			.find((p) => p.id === selection.providerId);
		if (!provider || typeof provider.chat !== 'function') {
			return null;
		}

		// Knot (and any provider that executes tools server-side) does NOT
		// surface the tool-call arguments back to the client — it would run
		// `emit_html` on the server and swallow the payload. Skip function
		// calling for those and let the caller fall back to text extraction.
		if (selection.providerId.toLowerCase().includes('knot')) {
			this.logService.info(
				'[ConfigHtml] Active provider is Knot (server-side tools); skipping function-call path.',
			);
			return null;
		}

		const modelId = model || selection.modelId;
		if (!modelId) {
			return null;
		}

		const messages: IChatMessage[] = [{ role: 'user', content: userMsg }];
		const modelOptions: IModelOptions = {
			temperature: 0.4,
			maxTokens: 8192,
			systemPrompt,
			tools: [EMIT_HTML_TOOL],
			// Force the model to call emit_html this turn — guarantees a
			// structured payload instead of free-form prose.
			toolChoice: 'required',
		};

		// Accumulate streamed tool-call argument fragments per tool id. Some
		// providers stream {name} first then argument chunks; others emit the
		// whole call in one delta. We key by id (falling back to name) and
		// concatenate the `arguments` strings.
		let activeKey = '';
		const argBuffers = new Map<string, string>();
		const nameByKey = new Map<string, string>();
		let textAccum = '';

		const stream = provider.chat(modelId, messages, modelOptions, {
			agentId: agentId,
		});
		for await (const delta of stream as AsyncIterable<IModelDelta>) {
			if (delta.type === 'text' && delta.content) {
				textAccum += delta.content;
			} else if (delta.type === 'tool_call' && delta.toolCall) {
				const tc = delta.toolCall;
				if (tc.name) {
					// New tool call (first chunk).
					activeKey = tc.id || tc.name;
					nameByKey.set(activeKey, tc.name);
					argBuffers.set(
						activeKey,
						(argBuffers.get(activeKey) || '') + (tc.arguments || ''),
					);
				} else {
					// Continuation chunk — append to the active call.
					const key = tc.id || activeKey;
					if (key) {
						argBuffers.set(
							key,
							(argBuffers.get(key) || '') + (tc.arguments || ''),
						);
					}
				}
			} else if (delta.type === 'error') {
				this.logService.warn(
					`[ConfigHtml] Function-call stream error: ${delta.error || delta.content || 'unknown'}`,
				);
			}
		}

		// Prefer the emit_html call; otherwise take the first tool call with args.
		let chosenArgs = '';
		for (const [key, name] of nameByKey) {
			if (name === EMIT_HTML_TOOL.name) {
				chosenArgs = argBuffers.get(key) || '';
				break;
			}
		}
		if (!chosenArgs) {
			for (const args of argBuffers.values()) {
				if (args && args.trim()) {
					chosenArgs = args;
					break;
				}
			}
		}
		if (!chosenArgs || !chosenArgs.trim()) {
			return null;
		}

		const html = this._extractHtmlFromToolArgs(chosenArgs);
		if (!html) {
			return null;
		}
		return { html, raw: textAccum || chosenArgs };
	}

	/**
	 * Pull the `html` field out of an emit_html tool call's argument string.
	 * Tolerates: well-formed JSON, JSON missing a closing brace (truncated
	 * streams), and a raw HTML string that was passed without JSON wrapping.
	 */
	private _extractHtmlFromToolArgs(argsStr: string): string {
		const trimmed = argsStr.trim();
		if (!trimmed) {
			return '';
		}
		// 1. Straight JSON parse.
		try {
			const obj = JSON.parse(trimmed);
			if (obj && typeof obj.html === 'string') {
				return obj.html.trim();
			}
		} catch {
			// fall through to tolerant parsing
		}
		// 2. Tolerant: locate the "html" field and decode the JSON string that
		//    follows it, even if the surrounding object is truncated.
		const keyIdx = trimmed.search(/"html"\s*:\s*"/);
		if (keyIdx >= 0) {
			const startQuote = trimmed.indexOf('"', trimmed.indexOf(':', keyIdx) + 1);
			if (startQuote >= 0) {
				let out = '';
				let escaped = false;
				for (let i = startQuote + 1; i < trimmed.length; i++) {
					const ch = trimmed[i];
					if (escaped) {
						// Decode standard JSON escapes.
						out +=
							ch === 'n' ? '\n'
								: ch === 't' ? '\t'
									: ch === 'r' ? '\r'
										: ch === '"' ? '"'
											: ch === '\\' ? '\\'
												: ch === '/' ? '/'
													: ch;
						escaped = false;
					} else if (ch === '\\') {
						escaped = true;
					} else if (ch === '"') {
						break; // end of string
					} else {
						out += ch;
					}
				}
				if (out.trim()) {
					return out.trim();
				}
			}
		}
		// 3. Last resort: the args were a bare HTML string.
		if (/<[a-zA-Z!]/.test(trimmed)) {
			return extractHtmlBlock(trimmed);
		}
		return '';
	}

	async requestCanvasPreview(agentId: string): Promise<void> {
		// Make sure the latest source is rendered/persisted so the Canvas
		// picks up fresh HTML via configmd.getResource.
		try {
			await this.resolveState(agentId);
		} catch {
			// best-effort; Canvas will still try to load
		}
		this._onDidRequestCanvasPreview.fire({ agentId: agentId });
	}

	sendCommandToHtml(agentId: string, command: IConfigMdCommand): void {
		this._onDidEmitCommand.fire({ agentId: agentId, command });
	}

	// ─── Custom Parser / Styles Management ────────────────────────────────

	async uploadParser(agentId: string, content: string, fileName?: string): Promise<{ parserPath: string }> {
		const employee = await this.agentStudioService.getEmployee(agentId);
		if (!employee?.agentDir) {
			throw new Error(`Agent directory not found for ${agentId}`);
		}
		const agentDirUri = await this._resolveAgentDirUri(employee);
		if (!agentDirUri) {
			throw new Error(`Cannot resolve agent directory for ${agentId} (workspace has no path)`);
		}
		const safeName = (fileName || 'parser.js').replace(/[^\w.\-]/g, '_');
		const relPath = `ui/${safeName.endsWith('.js') ? safeName : safeName + '.js'}`;
		const targetUri = URI.joinPath(agentDirUri, relPath);

		// Validate the script can be loaded
		const candidate = this._loadParserScript(content, agentId);
		if (!candidate) {
			throw new Error('解析器脚本无效：必须导出包含 parse(markdown, ctx) 的对象');
		}

		await this.fileService.writeFile(targetUri, VSBuffer.fromString(content));

		// Persist parserPath to employee record
		const cfg = { ...(employee.configMd || { mdPath: 'config.md', displayMode: 'side' as const }) };
		cfg.parserPath = relPath;
		await this.agentStudioService.updateEmployee(agentId, { configMd: cfg });

		// Update in-memory state and re-render
		const st = this._agents.get(agentId);
		if (st) {
			st.customParser = candidate;
			st.html = this._renderInternal(st.markdown, st.customParser, agentId);
			st.version++;
			this._onDidRenderHtml.fire({ agentId: agentId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		}

		this.logService.info(`[ConfigMD] Uploaded custom parser to ${relPath} for ${agentId}`);
		return { parserPath: relPath };
	}

	async uploadStyles(agentId: string, content: string, fileName?: string): Promise<{ stylesPath: string }> {
		const employee = await this.agentStudioService.getEmployee(agentId);
		if (!employee?.agentDir) {
			throw new Error(`Agent directory not found for ${agentId}`);
		}
		const agentDirUri = await this._resolveAgentDirUri(employee);
		if (!agentDirUri) {
			throw new Error(`Cannot resolve agent directory for ${agentId} (workspace has no path)`);
		}
		const safeName = (fileName || 'styles.css').replace(/[^\w.\-]/g, '_');
		const relPath = `ui/${safeName.endsWith('.css') ? safeName : safeName + '.css'}`;
		const targetUri = URI.joinPath(agentDirUri, relPath);

		await this.fileService.writeFile(targetUri, VSBuffer.fromString(content));

		const cfg = { ...(employee.configMd || { mdPath: 'config.md', displayMode: 'side' as const }) };
		cfg.stylesPath = relPath;
		await this.agentStudioService.updateEmployee(agentId, { configMd: cfg });

		const st = this._agents.get(agentId);
		if (st) {
			st.stylesContent = content;
			st.version++;
			this._onDidRenderHtml.fire({ agentId: agentId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		}

		this.logService.info(`[ConfigMD] Uploaded custom styles to ${relPath} for ${agentId}`);
		return { stylesPath: relPath };
	}

	async removeParser(agentId: string): Promise<void> {
		const employee = await this.agentStudioService.getEmployee(agentId);
		if (!employee?.configMd) { return; }
		const cfg = { ...employee.configMd };
		delete cfg.parserPath;
		await this.agentStudioService.updateEmployee(agentId, { configMd: cfg });

		const st = this._agents.get(agentId);
		if (st) {
			st.customParser = undefined;
			st.html = this._renderInternal(st.markdown, undefined, agentId);
			st.version++;
			this._onDidRenderHtml.fire({ agentId: agentId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		}
		this.logService.info(`[ConfigMD] Removed custom parser for ${agentId}, fallback to built-in`);
	}

	async getInfo(agentId: string): Promise<{ parserSource: 'builtin' | 'custom'; parserPath?: string; stylesPath?: string; hasStyles: boolean }> {
		const employee = await this.agentStudioService.getEmployee(agentId);
		const cfg = employee?.configMd;
		const st = this._agents.get(agentId);
		const parserSource: 'builtin' | 'custom' = st?.customParser ? 'custom' : (cfg?.parserPath ? 'custom' : 'builtin');
		return {
			parserSource,
			parserPath: cfg?.parserPath,
			stylesPath: cfg?.stylesPath,
			hasStyles: !!(st?.stylesContent),
		};
	}

	// ─── Model Output Parsing ──────────────────────────────────────────────

	parseModelOutput(content: string): { patches: IConfigMdPatchOp[]; commands: IConfigMdCommand[]; cleanText: string } {
		const patches: IConfigMdPatchOp[] = [];
		const commands: IConfigMdCommand[] = [];

		PATCH_BLOCK_REGEX.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PATCH_BLOCK_REGEX.exec(content)) !== null) {
			try {
				const parsed = JSON.parse(m[1]);
				const arr = Array.isArray(parsed) ? parsed : [parsed];
				for (const it of arr) {
					if (it && typeof it.op === 'string' && typeof it.content === 'string') {
						patches.push(it as IConfigMdPatchOp);
					}
				}
			} catch {
				this.logService.warn(`[ConfigMD] Failed to parse patch block: ${m[1]?.slice(0, 100)}`);
			}
		}

		COMMAND_BLOCK_REGEX.lastIndex = 0;
		while ((m = COMMAND_BLOCK_REGEX.exec(content)) !== null) {
			try {
				const parsed = JSON.parse(m[1]);
				commands.push({
					name: parsed.name || 'unknown',
					params: parsed.params || {},
					id: parsed.id || `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				});
			} catch {
				this.logService.warn(`[ConfigMD] Failed to parse command block: ${m[1]?.slice(0, 100)}`);
			}
		}

		const cleanText = content
			.replace(PATCH_BLOCK_REGEX, '')
			.replace(COMMAND_BLOCK_REGEX, '')
			.trim();

		return { patches, commands, cleanText };
	}
}
