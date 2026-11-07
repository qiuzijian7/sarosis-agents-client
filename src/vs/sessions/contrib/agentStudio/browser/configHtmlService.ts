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
import type { AgentConfigHtml } from '../../../common/agentStudioTypes.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
// constants import no longer needed (WORKSPACE_DATA_DIR/AGENTS_DIR) — using getAgentDir()
import { postProcessImguiBlocks } from './imguiBlockProcessor.js';
import { IAgentOSService } from '../common/agentOS.js';


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

// ─── Service ─────────────────────────────────────────────────────────────────

export class ConfigHtmlService extends Disposable implements IConfigHtmlService {
	declare readonly _serviceBrand: undefined;

	// _onDidChangeSource removed (ConfigHtml no longer tracks MD source changes)

	private readonly _onDidRenderHtml = this._register(new Emitter<{ agentId: string; html: string; version: number; stylesContent?: string }>());
	readonly onDidRenderHtml: Event<{ agentId: string; html: string; version: number; stylesContent?: string }> = this._onDidRenderHtml.event;

	// ★ 2026-11-07（移除 config.html）：LLM 写入确认链已整体退役 ——
	// fire 源 `_confirmModelWrite` 随 config.html 移除，事件永不触发。
	// ★ 2026-11-07（移除 config.html）：本段 config.html 专属方法已整体退役

	private readonly _onDidEmitCommand = this._register(new Emitter<{ agentId: string; command: IConfigHtmlCommand }>());
	readonly onDidEmitCommand: Event<{ agentId: string; command: IConfigHtmlCommand }> = this._onDidEmitCommand.event;

	private readonly _onDidReceiveHtmlEvent = this._register(new Emitter<{ agentId: string; eventName: string; payload: unknown }>());
	readonly onDidReceiveHtmlEvent: Event<{ agentId: string; eventName: string; payload: unknown }> = this._onDidReceiveHtmlEvent.event;


	private readonly _onStreamDelta = this._register(new Emitter<{ requestId: string; agentId: string; delta: ChatStreamDelta }>());
	readonly onStreamDelta: Event<{ requestId: string; agentId: string; delta: ChatStreamDelta }> = this._onStreamDelta.event;

	private readonly _onStreamDone = this._register(new Emitter<{ requestId: string; agentId: string; ok: boolean; fullText?: string; error?: string }>());
	readonly onStreamDone: Event<{ requestId: string; agentId: string; ok: boolean; fullText?: string; error?: string }> = this._onStreamDone.event;

	private readonly _agents = new Map<string, IAgentHtmlState>();
	// ★ 2026-11-07：内嵌聊天已移除，`_streamSessions` 随之退役。

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
		@IAgentChatService _agentChatService: IAgentChatService,
		@IAgentOSService _agentOSService: IAgentOSService,
		@ITerminalService _terminalService: ITerminalService,
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
	// ★ 2026-11-07（移除 config.html）：本段 config.html 专属方法已整体退役

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
	// ★ 2026-11-07（移除 config.html）：本段 config.html 专属方法已整体退役
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
	// ★ 2026-11-07（移除 config.html）：本段 config.html 专属方法已整体退役

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
	// ★ 2026-11-07（移除 config.html）：本段 config.html 专属方法已整体退役
}
