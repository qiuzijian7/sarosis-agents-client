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
	IConfigHtmlCommand,
	ConfigHtmlChangeOrigin,
	ChatStreamDelta,
} from '../common/agentStudio.js';
import type { ConfigHtmlCapability, ChatMessage, AgentConfigHtml } from '../../../common/agentStudioTypes.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
// constants import no longer needed (WORKSPACE_DATA_DIR/AGENTS_DIR) — using getAgentDir()
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
 * Fused agent view used by ConfigHtml: agent DEFINITION (name/configHtml) merged
 * with per-workspace RUNTIME state (agentDir/workspaceId from the binding).
 * Replaces the legacy unified `Agent` shape after Agent retirement.
 */
interface AgentRuntimeView {
	id: string;
	name: string;
	configHtml?: AgentConfigHtml;
	agentDir?: string;
	workspaceId?: string;
}

/**
 * Dedicated system prompt for the ConfigHtml AI box. Kept in sync (in spirit)
 * with `resources/.agents/skills/confightml/SKILL.md`. The skill body is also
 * injected via `explicitSkillIds: ['confightml']`; this constant is a safety
 * net so the host still steers the model even if skill resolution fails.
 */
const CONFIGHTML_SYSTEM_PROMPT = [
	'你是 ConfigHtml 面板的页面生成助手。用户描述需求，你产出一个**完整、自包含、零依赖、可在浏览器内编辑**的单文件 HTML 文档。',
	'',
	'文件名与路径约束（强制）：',
	'- 文件名固定为 config.html，不可改名。',
	'- 文件路径为 ~/.saros/agents/{agentId}/config.html。',
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
	'数据持久化：config.json：',
	'- 若页面需要保存用户设置/表单值/开关状态等动态数据，不要嵌入 HTML 注释锚点，改用同目录下的 config.json 文件。',
	'- 编辑模式下输入的值会自动持久化到 HTML 属性（input→value, checkbox→checked, select→selected），保存时随 HTML 一起写入磁盘。',
	'',
	'AgentConfigHtml 协议 API（页面中可用的全部方法）：',
	'- connect() → Promise：建立连接（可选，其他方法会自动连接）。',
	'- chatSend(msg, {showInChat?}) → Promise<void>：单向发送消息给 Agent（Agent 回复在聊天面板里，不回流到页面）。',
	'- chatSendStream(msg, {onDelta, onDone}) → {cancel()}：流式发送+接收回复。onDelta({type, content, fullText, toolName, toolResult}) 每 token/工具事件触发；onDone(ok, fullText, error) 流结束时触发。返回的 {cancel()} 可中断。',
	'- sendEvent(name, payload?) → Promise<void>：发送自定义事件。notify(msg, level?) → Promise<void>：显示通知。',
	'- on(\'command\', fn) / on(\'message\', fn)：监听宿主推送。',
	'',
	'若用户提供了"当前 config.html 内容"，请在其基础上做增量修改，并输出修改后的完整文档。',
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
interface IAgentHtmlState {
	markdown: string;
	html: string;
	stylesContent?: string;
	customParser?: IMdParser;
	version: number;
	mdUri: URI;
	disposables: DisposableStore;
	pendingWriteOrigin?: ConfigHtmlChangeOrigin;
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

// ─── Legacy internal types (for dead/transitional code paths) ───────────────────

interface _LegacyPatchOp {
	readonly op: 'replace-anchor' | 'replace-bind' | 'append' | 'prepend' | 'replace-section' | 'replace-all';
	readonly anchor?: string;
	readonly heading?: string;
	readonly content: string;
}

interface _LegacyCommand {
	readonly name: string;
	readonly params: Record<string, unknown>;
	readonly id: string;
}

interface _LegacyState {
	readonly markdown: string;
	readonly html: string;
	readonly version: number;
	readonly stylesContent?: string;
	readonly parserSource?: 'builtin' | 'custom';
}

// ─── Patch application ───────────────────────────────────────────────────────

function applyPatchOps(markdown: string, patches: _LegacyPatchOp[]): string {
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

	// _onDidChangeSource removed (ConfigHtml no longer tracks MD source changes)

	private readonly _onDidRenderHtml = this._register(new Emitter<{ agentId: string; html: string; version: number; stylesContent?: string }>());
	readonly onDidRenderHtml: Event<{ agentId: string; html: string; version: number; stylesContent?: string }> = this._onDidRenderHtml.event;

	// ─── LLM 写入确认 ─────────────────────────────────────────────────────
	/** Agents with "始终同意" write permission — skip confirmation for model writes. */
	private readonly _alwaysAllowModelWrite = new Set<string>();
	/** Pending LLM write confirmations: requestId → { resolve, agentId }. */
	private readonly _pendingModelWriteConfirms = new Map<string, { resolve: (ok: boolean) => void; agentId: string }>();
	/** Fired when an LLM-originated write needs user approval. */
	private readonly _onDidRequestModelWriteConfirm = this._register(new Emitter<{ requestId: string; agentId: string; contentLen: number; preview: string }>());
	readonly onDidRequestModelWriteConfirm: Event<{ requestId: string; agentId: string; contentLen: number; preview: string }> = this._onDidRequestModelWriteConfirm.event;

	/**
	 * Called by the webview controller when the user approves/denies a model write.
	 * @param decision 'approve' | 'deny' | 'always'
	 */
	resolveModelWriteConfirm(requestId: string, decision: 'approve' | 'deny' | 'always'): void {
		const pending = this._pendingModelWriteConfirms.get(requestId);
		if (!pending) { return; }
		this._pendingModelWriteConfirms.delete(requestId);
		if (decision === 'always') {
			this._alwaysAllowModelWrite.add(pending.agentId);
			this.logService.info(`[ConfigHtml] model write always-approve set: agentId=${pending.agentId}`);
		}
		pending.resolve(decision !== 'deny');
	}

	/** Internal: ask user to confirm an LLM-originated write. Returns true if approved. */
	private async _confirmModelWrite(agentId: string, contentLen: number, preview: string): Promise<boolean> {
		if (this._alwaysAllowModelWrite.has(agentId)) { return true; }
		const requestId = 'mwconfirm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
		return new Promise<boolean>((resolve) => {
			this._pendingModelWriteConfirms.set(requestId, { resolve, agentId });
			this._onDidRequestModelWriteConfirm.fire({ requestId, agentId, contentLen, preview: preview.slice(0, 500) });
			this.logService.info(`[ConfigHtml] model write confirm requested: agentId=${agentId} requestId=${requestId} len=${contentLen}`);
		});
	}

	private readonly _onDidEmitCommand = this._register(new Emitter<{ agentId: string; command: IConfigHtmlCommand }>());
	readonly onDidEmitCommand: Event<{ agentId: string; command: IConfigHtmlCommand }> = this._onDidEmitCommand.event;

	private readonly _onDidReceiveHtmlEvent = this._register(new Emitter<{ agentId: string; eventName: string; payload: unknown }>());
	readonly onDidReceiveHtmlEvent: Event<{ agentId: string; eventName: string; payload: unknown }> = this._onDidReceiveHtmlEvent.event;

	private readonly _onDidRequestChatSend = this._register(new Emitter<{ agentId: string; message: string; agentSessionId?: string; workspaceId?: string; workspaceSessionId?: string }>());
	readonly onDidRequestChatSend: Event<{ agentId: string; message: string; agentSessionId?: string; workspaceId?: string; workspaceSessionId?: string }> = this._onDidRequestChatSend.event;

	private readonly _onStreamDelta = this._register(new Emitter<{ requestId: string; agentId: string; delta: ChatStreamDelta }>());
	readonly onStreamDelta: Event<{ requestId: string; agentId: string; delta: ChatStreamDelta }> = this._onStreamDelta.event;

	private readonly _onStreamDone = this._register(new Emitter<{ requestId: string; agentId: string; ok: boolean; fullText?: string; error?: string }>());
	readonly onStreamDone: Event<{ requestId: string; agentId: string; ok: boolean; fullText?: string; error?: string }> = this._onStreamDone.event;

	private readonly _agents = new Map<string, IAgentHtmlState>();
	private readonly _streamSessions = new Map<string, { agentId: string; cancel: () => void }>();
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
		@ITerminalService private readonly _terminalService: ITerminalService,
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

	// ─── Resource: getHtml / writeHtml ─────────────────────────────────────

	async getHtml(agentId: string): Promise<{ html: string; version: number }> {
		// TODO: implement reading config.html from agent dir
		const state = await this._ensureState(agentId);
		if (!state) { throw new Error(`Agent '${agentId}' not found`); }
		return { html: state.html, version: state.version };
	}

	async writeHtml(
		agentId: string,
		html: string,
		options?: { origin?: ConfigHtmlChangeOrigin; baseVersion?: number },
	): Promise<{ version: number }> {
		const state = await this._ensureState(agentId);
		if (!state) { throw new Error(`Agent '${agentId}' not found`); }
		// 写盘
		const origin = options?.origin || 'html';
		// LLM 写入需要用户确认
		if (origin === 'model') {
			const ok = await this._confirmModelWrite(agentId, html.length, html);
			if (!ok) {
				this.logService.info(`[ConfigHtml] writeHtml denied by user: agentId=${agentId}`);
				return { version: state.version };
			}
		}
		state.pendingWriteOrigin = origin;
		state.selfWriteEpoch++;
		try {
			await this.fileService.writeFile(state.mdUri, VSBuffer.fromString(html));
		} catch (err) {
			this.logService.error(`[ConfigHtml] Failed to write ${state.mdUri.fsPath}:`, err);
			throw err;
		}
		// 更新内存状态
		state.markdown = html;
		state.html = html;
		state.version++;
		this._onDidRenderHtml.fire({ agentId, html: state.html, version: state.version });
		return { version: state.version };
	}

	// ─── Streaming chat (Observable pattern) ────────────────────────────────

	async handleChatSendStream(
		requestId: string,
		agentId: string,
		message: string,
		onDelta: (delta: ChatStreamDelta) => void,
		onDone: (ok: boolean, fullText?: string, error?: string) => void,
		options?: { agentSessionId?: string },
	): Promise<void> {
		let fullText = '';
		let cancelled = false;

		const cancel = () => { cancelled = true; this.agentChatService.cancelStream(agentId, options?.agentSessionId); };
		this._streamSessions.set(requestId, { agentId, cancel });

		try {
			await this.agentChatService.sendMessage(
				agentId,
				message,
				{
					agentSessionId: options?.agentSessionId,
					explicitSkillIds: [], // no extra skills needed for config.html chat
				},
				(rawDelta: any) => {
					if (cancelled) { return; }
					const d = rawDelta as { type: string; content?: string; fullText?: string; toolName?: string; toolArgs?: string; toolResult?: string; error?: string };
					switch (d.type) {
						case 'text':
						case 'thinking':
							fullText = d.fullText ?? (fullText + (d.content ?? ''));
							onDelta({ type: d.type as 'text' | 'thinking', content: d.content, fullText });
							break;
						case 'tool_start':
							onDelta({ type: 'tool_start', toolName: d.toolName });
							break;
						case 'tool_end':
						case 'tool_result':
							onDelta({ type: 'tool_end', toolName: d.toolName, toolResult: d.content });
							break;
						case 'done':
							// Will be handled by onDone after sendMessage resolves
							break;
						default:
							// forward unknown types as text if they have content
							if (d.content) {
								onDelta({ type: 'text', content: d.content, fullText });
							}
					}
				},
			);
			if (!cancelled) {
				onDelta({ type: 'done' });
				onDone(true, fullText);
			} else {
				onDone(false, fullText, 'Cancelled');
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			onDone(false, fullText, errorMsg);
		} finally {
			this._streamSessions.delete(requestId);
		}
	}

	cancelStream(requestId: string, _agentId: string): void {
		const session = this._streamSessions.get(requestId);
		if (session) {
			session.cancel();
			this._streamSessions.delete(requestId);
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

	async checkCapability(agentId: string, capability: ConfigHtmlCapability): Promise<void> {
		const view = await this._resolveAgentView(agentId);
		if (!view) {
			throw new Error(`Agent '${agentId}' not found`);
		}
		// For ConfigHtml, all capabilities are allowed by default (no capability whitelist)
		const defaultAllowed: ConfigHtmlCapability[] = ['chat.send', 'chat.history', 'agent.status', 'agent.config', 'notification', 'clipboard'];
		if (!defaultAllowed.includes(capability)) {
			throw new Error(`ConfigHtml capability '${capability}' not allowed for agent '${view.name}'`);
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

	// ─── Key-Value Data Store ─────────────────────────────────────────────

	/** In-memory cache of KV stores, keyed by agentId. */
	private readonly _kvStores = new Map<string, Map<string, unknown>>();

	/** Resolve the KV store file URI: ~/.vssaros/agents/{agentId}/data/kv.json */
	private async _resolveKvUri(agentId: string): Promise<URI> {
		const view = await this._resolveAgentView(agentId);
		if (!view) { throw new Error(`Agent '${agentId}' not found`); }
		const dirUri = await this._resolveAgentDirUri(view);
		if (!dirUri) { throw new Error(`Agent directory not resolved for '${agentId}'`); }
		const dataDir = URI.joinPath(dirUri, 'data');
		try { await this.fileService.resolve(dataDir); } catch { await this.fileService.createFolder(dataDir); }
		return URI.joinPath(dataDir, 'kv.json');
	}

	/** Load KV store from disk (or create empty if file doesn't exist). */
	private async _ensureKvStore(agentId: string): Promise<Map<string, unknown>> {
		const cached = this._kvStores.get(agentId);
		if (cached) { return cached; }
		const store = new Map<string, unknown>();
		try {
			const kvUri = await this._resolveKvUri(agentId);
			const buf = await this.fileService.readFile(kvUri);
			const data = JSON.parse(buf.value.toString());
			if (data && typeof data === 'object') {
				for (const [k, v] of Object.entries(data)) { store.set(k, v); }
			}
		} catch { /* file doesn't exist yet — empty store */ }
		this._kvStores.set(agentId, store);
		return store;
	}

	/** Flush KV store to disk. */
	private async _flushKvStore(agentId: string): Promise<void> {
		const store = this._kvStores.get(agentId);
		if (!store) { return; }
		const obj: Record<string, unknown> = {};
		store.forEach((v, k) => { obj[k] = v; });
		const kvUri = await this._resolveKvUri(agentId);
		await this.fileService.writeFile(kvUri, VSBuffer.fromString(JSON.stringify(obj, null, 2)));
	}

	async kvGet(agentId: string, key: string): Promise<unknown | undefined> {
		const store = await this._ensureKvStore(agentId);
		return store.get(key);
	}

	async kvSet(agentId: string, key: string, value: unknown): Promise<void> {
		const store = await this._ensureKvStore(agentId);
		store.set(key, value);
		await this._flushKvStore(agentId);
		this.logService.info(`[ConfigHtml] kvSet: agentId=${agentId} key=${key}`);
	}

	async kvDelete(agentId: string, key: string): Promise<void> {
		const store = await this._ensureKvStore(agentId);
		store.delete(key);
		await this._flushKvStore(agentId);
		this.logService.info(`[ConfigHtml] kvDelete: agentId=${agentId} key=${key}`);
	}

	async kvList(agentId: string, prefix?: string): Promise<string[]> {
		const store = await this._ensureKvStore(agentId);
		const keys = Array.from(store.keys());
		return prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
	}

	// ─── Terminal Execution ─────────────────────────────────────────────────

	/**
	 * Run a command in the integrated terminal and return immediately.
	 * Creates a new terminal instance and shows real-time output.
	 *
	 * Used by ConfigHtml to execute `python script.py`, `node script.js`, etc.
	 * with progress displayed in the VS Saros integrated terminal panel.
	 */
	async handleRunTerminal(
		agentId: string,
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): Promise<void> {
		const view = await this._resolveAgentView(agentId);
		if (!view) {
			this.logService.error(`[ConfigHtml] handleRunTerminal: Agent '${agentId}' not found`);
			return;
		}

		const cwdRaw = options?.cwd || view.agentDir || undefined;
		const env = options?.env || {};

		// Validate cwd — if the configured directory doesn't exist, omit it
		// so the terminal can fall back to its default (workspace root / home).
		let cwd: string | undefined = cwdRaw;
		if (cwd) {
			try {
				const cwdStat = await this.fileService.resolve(URI.file(cwd));
				if (!cwdStat.isDirectory) {
					this.logService.warn(`[ConfigHtml] handleRunTerminal: cwd '${cwd}' is not a directory, falling back to default`);
					cwd = undefined;
				}
			} catch {
				this.logService.warn(`[ConfigHtml] handleRunTerminal: cwd '${cwd}' does not exist, falling back to default`);
				cwd = undefined;
			}
		}

		const name = `ConfigHtml: ${command} ${args.join(' ')}`;
		this.logService.info(`[ConfigHtml] handleRunTerminal: ${name} (cwd=${cwd || '<default>'})`);

		try {
			const terminal = await this._terminalService.createTerminal({
				config: {
					name,
					executable: command,
					args: args,
					cwd: cwd,
					env: env,
					waitOnExit: true,  // 脚本结束后保持终端打开，方便查看输出
				},
			});

			// Reveal the terminal so the user sees the output
			this._terminalService.setActiveInstance(terminal);
			await this._terminalService.revealTerminal(terminal);
		} catch (err) {
			this.logService.error(`[ConfigHtml] handleRunTerminal error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ─── State Resolution ──────────────────────────────────────────────────

	/**
	 * Fused runtime view of an agent, replacing the legacy `getAgent()` call.
	 *
	 * The old `Agent` record co-located DEFINITION fields (name/configMd) and
	 * per-workspace RUNTIME fields (agentDir/workspaceId). Those are now split:
	 *   - definition  → `getAgent(agentId)`            (global, ~/.saros/agents/{id}/agent.json)
	 *   - runtime     → `getAgentBinding(wsId, agentId)` (per-workspace, agent-bindings.json)
	 *
	 * This helper recombines them into the shape ConfigMD code already consumes
	 * (`.name`, `.configMd`, `.agentDir`, `.workspaceId`), so call sites stay
	 * unchanged. Returns `undefined` when the agent definition is missing.
	 */
	private async _resolveAgentView(agentId: string): Promise<AgentRuntimeView | undefined> {
		const agent = await this.agentStudioService.getAgent(agentId);
		if (!agent) { return undefined; }
		const workspaceId = this.agentStudioService.getActiveWorkspaceId();
		let binding: { agentDir?: string } | undefined;
		if (workspaceId) {
			binding = await this.agentStudioService.getAgentBinding(workspaceId, agentId);
		}
		return {
			id: agent.id,
			name: agent.name,
			configHtml: agent.configHtml,
			agentDir: binding?.agentDir,
			workspaceId,
		};
	}

	/**
	 * Resolve the absolute filesystem URI for an agent's config directory.
	 *
	 * New layout (unified): `~/.saros/agents/{agentId}/`
	 * This directory contains agent.json, .agent.md, config.html, and HTML assets.
	 *
	 * Returns `undefined` only if the agent definition is missing.
	 */
	private async _resolveAgentDirUri(view: AgentRuntimeView): Promise<URI | undefined> {
		if (!view?.id) { return undefined; }
		// Use the unified agent directory: ~/.saros/agents/{agentId}/
		return this.agentStudioService.getAgentDir(view.id);
	}

	private async _ensureState(agentId: string): Promise<IAgentHtmlState | null> {
		const existing = this._agents.get(agentId);
		if (existing) { return existing; }

		const view = await this._resolveAgentView(agentId);
		if (!view?.id) {
			return null;
		}

		// Auto-enable configHtml if not explicitly configured — the new
		// unified directory layout always has a writable agent dir.
		const cfg: AgentConfigHtml = view.configHtml ?? { htmlPath: 'config.html' } as AgentConfigHtml;

		const agentDirUri = await this._resolveAgentDirUri(view);
		if (!agentDirUri) { return null; }

		// Ensure the agent directory exists
		try {
			await this.fileService.resolve(agentDirUri);
		} catch {
			await this.fileService.createFolder(agentDirUri);
		}

		// ConfigHtml migration: the panel now stores raw HTML in `config.html`.
		// Resolution order:
		//   1) explicit cfg.mdPath (respect whatever was configured)
		//   2) existing config.html on disk (new ConfigHtml panels)
		//   3) existing config.md on disk (legacy ConfigMD panels — kept as-is)
		//   4) neither exists → create config.html with an HTML scaffold
		let mdRel = cfg.htmlPath;
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
				? buildDefaultConfigHtml(view.name)
				: `# ${view.name}'s Panel\n\n<!-- agent-state:notes -->\n_(Empty)_\n<!-- /agent-state:notes -->\n`;
			try {
				await this.fileService.writeFile(mdUri, VSBuffer.fromString(markdown));
			} catch (err) {
				this.logService.warn(`[ConfigMD] Failed to scaffold ${mdUri.fsPath}:`, err);
			}
		}

		// ConfigHtml: no custom styles/parser loading (these were MD-specific, now removed)

		// Initial render
		const html = this._renderInternal(markdown, undefined, agentId);

		// File watcher
		const disposables = new DisposableStore();
		try {
			disposables.add(this.fileService.watch(mdUri));
		} catch (err) {
			this.logService.warn(`[ConfigMD] watch failed for ${mdUri.fsPath}:`, err);
		}

		const state: IAgentHtmlState = {
			markdown,
			html,
			stylesContent: undefined,
			customParser: undefined,
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
			this._onDidRenderHtml.fire({ agentId: agentId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		} catch (err) {
			this.logService.warn(`[ConfigMD] external change re-read failed:`, err);
		}
	}

	async resolveState(agentId: string): Promise<_LegacyState | null> {
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
		const st = await this._ensureState(agentId);
		if (!st) { throw new Error(`ConfigHtml not configured for ${agentId}`); }
		return { markdown: st.markdown, version: st.version };
	}

	async writeSource(
		agentId: string,
		markdown: string,
		options?: { origin?: ConfigHtmlChangeOrigin; baseVersion?: number },
	): Promise<{ version: number }> {
		const st = await this._ensureState(agentId);
		if (!st) { throw new Error(`ConfigHtml not configured for ${agentId}`); }
		const origin = options?.origin || 'editor';
		if (options?.baseVersion != null && options.baseVersion !== st.version) {
			throw new Error(`Stale write: baseVersion=${options.baseVersion}, current=${st.version}`);
		}
		if (markdown === st.markdown) {
			return { version: st.version };
		}
		// LLM 写入需要用户确认
		if (origin === 'model') {
			const ok = await this._confirmModelWrite(agentId, markdown.length, markdown);
			if (!ok) {
				this.logService.info(`[ConfigHtml] writeSource denied by user: agentId=${agentId}`);
				return { version: st.version };
			}
		}
		st.markdown = markdown;
		st.version++;
		st.pendingWriteOrigin = origin;
		st.selfWriteEpoch++;
		try {
			await this.fileService.writeFile(st.mdUri, VSBuffer.fromString(markdown));
		} catch (err) {
			this.logService.error(`[ConfigHtml] Failed to write ${st.mdUri.fsPath}:`, err);
			throw err;
		}
		st.html = this._renderInternal(markdown, st.customParser, agentId);
		this._onDidRenderHtml.fire({ agentId: agentId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		return { version: st.version };
	}

	async applyPatch(
		agentId: string,
		patches: _LegacyPatchOp[],
		options?: { origin?: ConfigHtmlChangeOrigin; baseVersion?: number },
	): Promise<{ version: number; markdown: string }> {
		const st = await this._ensureState(agentId);
		if (!st) { throw new Error(`ConfigHtml not configured for ${agentId}`); }
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
		const view = await this._resolveAgentView(agentId);
		if (!view?.id) {
			throw new Error(`Agent not found for ${agentId}`);
		}
		const agentDirUri = await this._resolveAgentDirUri(view);
		if (!agentDirUri) {
			throw new Error(`Cannot resolve agent directory for ${agentId}`);
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

		// 非 imgui.submit 的 HTML 事件仅作为通知处理（已通过
		// `_onDidReceiveHtmlEvent` 广播给订阅者），**不得**自动触发聊天
		// 或启动 agent loop。否则 preview 在加载/渲染时自动发出的事件
		// （例如 `readStats`、各类 telemetry/生命周期事件）会在用户未
		// 点击发送的情况下启动 agent loop。
		//
		// 真正需要向 agent 发送消息的路径只有两条，二者都经由
		// `onDidRequestChatSend` 进入统一的 `_handleChatSend` 流程：
		//   - `confightml.chatSend`（用户在预览里显式点击发送）
		//   - `imgui.submit` 且 action 为 send_to_chat / run_skill
		this.logService.info(
			`[ConfigMD] handleHtmlEvent: received non-chat event '${eventName}' (notification only — NOT forwarded to chat, no agent loop started)`,
		);
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
	 *                  full _LegacyPatchOp[] schema is accepted, mirroring
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
		//      this view). Last resort.
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
					await this.applyPatch(agentId, ops as _LegacyPatchOp[], { origin: 'html' });
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

	/**
	 * 宿主侧触发一次聊天发送（等价于在预览里点击发送）。供原生 UI（如知识库视图按钮）调用，
	 * 自动按当前激活会话把消息发给指定 agent。
	 */
	requestChatSend(agentId: string, message: string): void {
		this._sendChatMessage(agentId, message);
	}

	async handleChatSend(
		agentId: string,
		message: string,
		options?: { context?: string; showInChat?: boolean; agentSessionId?: string },
	): Promise<ChatMessage> {
		await this.checkCapability(agentId, 'chat.send');
		this._checkRateLimit(agentId);
		const view = await this._resolveAgentView(agentId);
		const fullMsg = options?.context
			? `[Context from ConfigMD]\n${options.context}\n\n${message}`
			: message;
		const chatMessage = await this.agentChatService.sendMessage(
			agentId,
			fullMsg,
			{ agentSessionId: options?.agentSessionId, workspaceId: view?.workspaceId },
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
		const view = await this._resolveAgentView(agentId);

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
				workspaceId: view?.workspaceId,
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

	sendCommandToHtml(agentId: string, command: IConfigHtmlCommand): void {
		this._onDidEmitCommand.fire({ agentId: agentId, command });
	}

	// ─── Custom Parser / Styles Management ────────────────────────────────

	async uploadParser(agentId: string, content: string, fileName?: string): Promise<{ parserPath: string }> {
		const view = await this._resolveAgentView(agentId);
		if (!view?.id) {
			throw new Error(`Agent not found for ${agentId}`);
		}
		const agentDirUri = await this._resolveAgentDirUri(view);
		if (!agentDirUri) {
			throw new Error(`Cannot resolve agent directory for ${agentId}`);
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

		// Persist parserPath to view record
		const cfg = { ...(view.configHtml || { htmlPath: 'config.html', displayMode: 'side' as const }) };
		// parserPath removed from AgentConfigHtml; skip persisting
		await this.agentStudioService.updateAgent(agentId, { configHtml: cfg });

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
		const view = await this._resolveAgentView(agentId);
		if (!view?.id) {
			throw new Error(`Agent not found for ${agentId}`);
		}
		const agentDirUri = await this._resolveAgentDirUri(view);
		if (!agentDirUri) {
			throw new Error(`Cannot resolve agent directory for ${agentId}`);
		}
		const safeName = (fileName || 'styles.css').replace(/[^\w.\-]/g, '_');
		const relPath = `ui/${safeName.endsWith('.css') ? safeName : safeName + '.css'}`;
		const targetUri = URI.joinPath(agentDirUri, relPath);

		await this.fileService.writeFile(targetUri, VSBuffer.fromString(content));

		const cfg = { ...(view.configHtml || { htmlPath: 'config.html', displayMode: 'side' as const }) };
		// stylesPath removed from AgentConfigHtml; skip persisting
		await this.agentStudioService.updateAgent(agentId, { configHtml: cfg });

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
		const view = await this._resolveAgentView(agentId);
		if (!view?.configHtml) { return; }
		// parserPath removed from AgentConfigHtml; restore is a no-op
		const cfg = { ...view.configHtml };
		await this.agentStudioService.updateAgent(agentId, { configHtml: cfg });

		const st = this._agents.get(agentId);
		if (st) {
			st.customParser = undefined;
			st.html = this._renderInternal(st.markdown, undefined, agentId);
			st.version++;
			this._onDidRenderHtml.fire({ agentId: agentId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		}
		this.logService.info(`[ConfigMD] Removed custom parser for ${agentId}, fallback to built-in`);
	}

	async getInfo(agentId: string): Promise<{ parserSource: 'builtin' | 'custom'; hasStyles: boolean }> {
		const st = this._agents.get(agentId);
		const parserSource: 'builtin' | 'custom' = st?.customParser ? 'custom' : 'builtin';
		return {
			parserSource,
			hasStyles: !!(st?.stylesContent),
		};
	}

	// ─── Model Output Parsing ──────────────────────────────────────────────

	parseModelOutput(content: string): { patches: _LegacyPatchOp[]; commands: _LegacyCommand[]; cleanText: string } {
		const patches: _LegacyPatchOp[] = [];
		const commands: _LegacyCommand[] = [];

		PATCH_BLOCK_REGEX.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PATCH_BLOCK_REGEX.exec(content)) !== null) {
			try {
				const parsed = JSON.parse(m[1]);
				const arr = Array.isArray(parsed) ? parsed : [parsed];
				for (const it of arr) {
					if (it && typeof it.op === 'string' && typeof it.content === 'string') {
						patches.push(it as _LegacyPatchOp);
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
