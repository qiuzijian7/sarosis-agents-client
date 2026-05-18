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
import type {
	IConfigMdService,
	IConfigMdCommand,
	IConfigMdPatchOp,
	IConfigMdState,
	ConfigMdChangeOrigin,
	IAgentStudioService,
	IAgentChatService,
} from '../common/agentStudio.js';
import type { ConfigMdCapability, ChatMessage } from '../../../common/agentStudioTypes.js';

/** Regex for `configmd-patch` JSON code blocks. */
const PATCH_BLOCK_REGEX = /```configmd-patch\s*\n([\s\S]*?)\n```/g;
/** Regex for `configmd-command` JSON code blocks. */
const COMMAND_BLOCK_REGEX = /```configmd-command\s*\n([\s\S]*?)\n```/g;
/** Rate-limit: max chat-send-style calls per agent per minute. */
const RATE_LIMIT_PER_MINUTE = 30;

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
	parse(markdown: string, ctx?: { employeeId: string }): string;
	applyHtmlPatch?(markdown: string, patch: unknown, ctx?: { employeeId: string }): string;
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
`;
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

export class ConfigMdService extends Disposable implements IConfigMdService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSource = this._register(new Emitter<{ employeeId: string; markdown: string; version: number; origin: ConfigMdChangeOrigin }>());
	readonly onDidChangeSource: Event<{ employeeId: string; markdown: string; version: number; origin: ConfigMdChangeOrigin }> = this._onDidChangeSource.event;

	private readonly _onDidRenderHtml = this._register(new Emitter<{ employeeId: string; html: string; version: number; stylesContent?: string }>());
	readonly onDidRenderHtml: Event<{ employeeId: string; html: string; version: number; stylesContent?: string }> = this._onDidRenderHtml.event;

	private readonly _onDidEmitCommand = this._register(new Emitter<{ employeeId: string; command: IConfigMdCommand }>());
	readonly onDidEmitCommand: Event<{ employeeId: string; command: IConfigMdCommand }> = this._onDidEmitCommand.event;

	private readonly _onDidReceiveHtmlEvent = this._register(new Emitter<{ employeeId: string; eventName: string; payload: unknown }>());
	readonly onDidReceiveHtmlEvent: Event<{ employeeId: string; eventName: string; payload: unknown }> = this._onDidReceiveHtmlEvent.event;

	private readonly _agents = new Map<string, IAgentMdState>();
	private readonly _rateLimits = new Map<string, { count: number; resetAt: number }>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		private readonly agentStudioService: IAgentStudioService,
		private readonly agentChatService: IAgentChatService,
	) {
		super();
	}

	override dispose(): void {
		for (const [id] of this._agents) {
			this.disposeAgent(id);
		}
		super.dispose();
	}

	disposeAgent(employeeId: string): void {
		const st = this._agents.get(employeeId);
		if (st) {
			st.disposables.dispose();
			this._agents.delete(employeeId);
		}
	}

	// ─── Capability Check ──────────────────────────────────────────────────

	async checkCapability(employeeId: string, capability: ConfigMdCapability): Promise<void> {
		const employee = await this.agentStudioService.getEmployee(employeeId);
		if (!employee) {
			throw new Error(`Employee '${employeeId}' not found`);
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

	private _checkRateLimit(employeeId: string): void {
		const now = Date.now();
		let entry = this._rateLimits.get(employeeId);
		if (!entry || now > entry.resetAt) {
			entry = { count: 0, resetAt: now + 60_000 };
			this._rateLimits.set(employeeId, entry);
		}
		entry.count++;
		if (entry.count > RATE_LIMIT_PER_MINUTE) {
			throw new Error(`ConfigMD rate limit exceeded for agent '${employeeId}'`);
		}
	}

	// ─── State Resolution ──────────────────────────────────────────────────

	private async _ensureState(employeeId: string): Promise<IAgentMdState | null> {
		const existing = this._agents.get(employeeId);
		if (existing) { return existing; }

		const employee = await this.agentStudioService.getEmployee(employeeId);
		if (!employee?.configMd || !employee.agentDir) {
			return null;
		}

		const cfg = employee.configMd;
		const mdRel = cfg.mdPath || 'config.md';
		const mdUri = URI.joinPath(URI.file(employee.agentDir), mdRel);

		// Read MD (create empty file if missing)
		let markdown = '';
		try {
			const buf = await this.fileService.readFile(mdUri);
			markdown = buf.value.toString();
		} catch {
			// Create the file with a default scaffold
			markdown = `# ${employee.name}'s Panel\n\n<!-- agent-state:notes -->\n_(Empty)_\n<!-- /agent-state:notes -->\n`;
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
				const sUri = URI.joinPath(URI.file(employee.agentDir), cfg.stylesPath);
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
				const pUri = URI.joinPath(URI.file(employee.agentDir), cfg.parserPath);
				const pBuf = await this.fileService.readFile(pUri);
				customParser = this._loadParserScript(pBuf.value.toString(), employeeId);
			} catch (err) {
				this.logService.warn(`[ConfigMD] Failed to load custom parser ${cfg.parserPath}:`, err);
			}
		}

		// Initial render
		const html = this._renderInternal(markdown, customParser, employeeId);

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
		this._agents.set(employeeId, state);

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
				void this._onExternalChange(employeeId);
			}),
		);

		return state;
	}

	private _loadParserScript(source: string, employeeId: string): IMdParser | undefined {
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
			this.logService.warn(`[ConfigMD] Custom parser for ${employeeId} did not export parse()`);
		} catch (err) {
			this.logService.warn(`[ConfigMD] Failed to evaluate custom parser for ${employeeId}:`, err);
		}
		return undefined;
	}

	private _renderInternal(markdown: string, parser: IMdParser | undefined, employeeId: string): string {
		try {
			if (parser) {
				const html = parser.parse(markdown, { employeeId });
				return sanitizeHtml(html);
			}
		} catch (err) {
			this.logService.warn(`[ConfigMD] Custom parser threw, falling back to built-in:`, err);
		}
		return sanitizeHtml(builtInRenderMarkdown(markdown));
	}

	private async _onExternalChange(employeeId: string): Promise<void> {
		const st = this._agents.get(employeeId);
		if (!st) { return; }
		try {
			const buf = await this.fileService.readFile(st.mdUri);
			const md = buf.value.toString();
			if (md === st.markdown) { return; }
			st.markdown = md;
			st.version++;
			st.html = this._renderInternal(md, st.customParser, employeeId);
			this._onDidChangeSource.fire({ employeeId, markdown: md, version: st.version, origin: 'external' });
			this._onDidRenderHtml.fire({ employeeId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		} catch (err) {
			this.logService.warn(`[ConfigMD] external change re-read failed:`, err);
		}
	}

	async resolveState(employeeId: string): Promise<IConfigMdState | null> {
		const st = await this._ensureState(employeeId);
		if (!st) { return null; }
		return {
			markdown: st.markdown,
			html: st.html,
			version: st.version,
			stylesContent: st.stylesContent,
			parserSource: st.customParser ? 'custom' : 'builtin',
		};
	}

	async readSource(employeeId: string): Promise<{ markdown: string; version: number }> {
		await this.checkCapability(employeeId, 'md.read');
		const st = await this._ensureState(employeeId);
		if (!st) { throw new Error(`ConfigMD not configured for ${employeeId}`); }
		return { markdown: st.markdown, version: st.version };
	}

	async writeSource(
		employeeId: string,
		markdown: string,
		options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
	): Promise<{ version: number }> {
		await this.checkCapability(employeeId, 'md.write');
		const st = await this._ensureState(employeeId);
		if (!st) { throw new Error(`ConfigMD not configured for ${employeeId}`); }
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
		st.html = this._renderInternal(markdown, st.customParser, employeeId);
		this._onDidChangeSource.fire({ employeeId, markdown, version: st.version, origin });
		this._onDidRenderHtml.fire({ employeeId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		return { version: st.version };
	}

	async applyPatch(
		employeeId: string,
		patches: IConfigMdPatchOp[],
		options?: { origin?: ConfigMdChangeOrigin; baseVersion?: number },
	): Promise<{ version: number; markdown: string }> {
		await this.checkCapability(employeeId, 'md.write');
		const st = await this._ensureState(employeeId);
		if (!st) { throw new Error(`ConfigMD not configured for ${employeeId}`); }
		if (options?.baseVersion != null && options.baseVersion !== st.version) {
			throw new Error(`Stale patch: baseVersion=${options.baseVersion}, current=${st.version}`);
		}
		const newMd = applyPatchOps(st.markdown, patches);
		const res = await this.writeSource(employeeId, newMd, { origin: options?.origin || 'html' });
		return { version: res.version, markdown: newMd };
	}

	async renderHtml(employeeId: string, markdown?: string): Promise<{ html: string; version: number }> {
		const st = await this._ensureState(employeeId);
		if (!st) { throw new Error(`ConfigMD not configured for ${employeeId}`); }
		const md = markdown ?? st.markdown;
		const html = this._renderInternal(md, st.customParser, employeeId);
		if (markdown === undefined) {
			st.html = html;
		}
		this._onDidRenderHtml.fire({ employeeId, html, version: st.version, stylesContent: st.stylesContent });
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
	async previewToFile(employeeId: string): Promise<{ path: string; version: number }> {
		const employee = await this.agentStudioService.getEmployee(employeeId);
		if (!employee?.agentDir) {
			throw new Error(`Agent directory not found for ${employeeId}`);
		}
		const st = await this._ensureState(employeeId);
		if (!st) { throw new Error(`ConfigMD not configured for ${employeeId}`); }

		// Always re-render from current markdown to reflect the latest edits
		// through the active parser (custom or built-in).
		const html = this._renderInternal(st.markdown, st.customParser, employeeId);
		st.html = html;

		const doc = buildStandalonePreviewDoc(html, st.stylesContent);
		const previewUri = URI.joinPath(URI.file(employee.agentDir), '.preview.html');
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
		employeeId: string,
		eventName: string,
		payload: unknown,
		agentSessionId?: string,
	): Promise<void> {
		await this.checkCapability(employeeId, 'chat.send');
		this._checkRateLimit(employeeId);
		this._onDidReceiveHtmlEvent.fire({ employeeId, eventName, payload });

		const wrapped = `[ConfigMD HTML Event: ${eventName}]\n${JSON.stringify(payload, null, 2)}`;
		try {
			const employee = await this.agentStudioService.getEmployee(employeeId);
			const chatMessage = await this.agentChatService.sendMessage(
				employeeId,
				wrapped,
				{ agentSessionId, workspaceId: employee?.workspaceId },
				() => undefined,
			);
			if (chatMessage?.content) {
				await this._consumeModelOutput(employeeId, chatMessage.content);
			}
		} catch (err) {
			this.logService.error(`[ConfigMD] handleHtmlEvent failed for ${employeeId}:`, err);
		}
	}

	async handleChatSend(
		employeeId: string,
		message: string,
		options?: { context?: string; showInChat?: boolean; agentSessionId?: string },
	): Promise<ChatMessage> {
		await this.checkCapability(employeeId, 'chat.send');
		this._checkRateLimit(employeeId);
		const employee = await this.agentStudioService.getEmployee(employeeId);
		const fullMsg = options?.context
			? `[Context from ConfigMD]\n${options.context}\n\n${message}`
			: message;
		const chatMessage = await this.agentChatService.sendMessage(
			employeeId,
			fullMsg,
			{ agentSessionId: options?.agentSessionId, workspaceId: employee?.workspaceId },
			() => undefined,
		);
		if (chatMessage?.content) {
			await this._consumeModelOutput(employeeId, chatMessage.content);
		}
		return chatMessage;
	}

	private async _consumeModelOutput(employeeId: string, content: string): Promise<void> {
		const { patches, commands } = this.parseModelOutput(content);
		if (patches.length > 0) {
			try {
				await this.applyPatch(employeeId, patches, { origin: 'model' });
			} catch (err) {
				this.logService.warn(`[ConfigMD] Failed to apply model patches:`, err);
			}
		}
		for (const cmd of commands) {
			this.sendCommandToHtml(employeeId, cmd);
		}
	}

	sendCommandToHtml(employeeId: string, command: IConfigMdCommand): void {
		this._onDidEmitCommand.fire({ employeeId, command });
	}

	// ─── Custom Parser / Styles Management ────────────────────────────────

	async uploadParser(employeeId: string, content: string, fileName?: string): Promise<{ parserPath: string }> {
		const employee = await this.agentStudioService.getEmployee(employeeId);
		if (!employee?.agentDir) {
			throw new Error(`Agent directory not found for ${employeeId}`);
		}
		const safeName = (fileName || 'parser.js').replace(/[^\w.\-]/g, '_');
		const relPath = `ui/${safeName.endsWith('.js') ? safeName : safeName + '.js'}`;
		const targetUri = URI.joinPath(URI.file(employee.agentDir), relPath);

		// Validate the script can be loaded
		const candidate = this._loadParserScript(content, employeeId);
		if (!candidate) {
			throw new Error('解析器脚本无效：必须导出包含 parse(markdown, ctx) 的对象');
		}

		await this.fileService.writeFile(targetUri, VSBuffer.fromString(content));

		// Persist parserPath to employee record
		const cfg = { ...(employee.configMd || { mdPath: 'config.md', displayMode: 'side' as const }) };
		cfg.parserPath = relPath;
		await this.agentStudioService.updateEmployee(employeeId, { configMd: cfg });

		// Update in-memory state and re-render
		const st = this._agents.get(employeeId);
		if (st) {
			st.customParser = candidate;
			st.html = this._renderInternal(st.markdown, st.customParser, employeeId);
			st.version++;
			this._onDidRenderHtml.fire({ employeeId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		}

		this.logService.info(`[ConfigMD] Uploaded custom parser to ${relPath} for ${employeeId}`);
		return { parserPath: relPath };
	}

	async uploadStyles(employeeId: string, content: string, fileName?: string): Promise<{ stylesPath: string }> {
		const employee = await this.agentStudioService.getEmployee(employeeId);
		if (!employee?.agentDir) {
			throw new Error(`Agent directory not found for ${employeeId}`);
		}
		const safeName = (fileName || 'styles.css').replace(/[^\w.\-]/g, '_');
		const relPath = `ui/${safeName.endsWith('.css') ? safeName : safeName + '.css'}`;
		const targetUri = URI.joinPath(URI.file(employee.agentDir), relPath);

		await this.fileService.writeFile(targetUri, VSBuffer.fromString(content));

		const cfg = { ...(employee.configMd || { mdPath: 'config.md', displayMode: 'side' as const }) };
		cfg.stylesPath = relPath;
		await this.agentStudioService.updateEmployee(employeeId, { configMd: cfg });

		const st = this._agents.get(employeeId);
		if (st) {
			st.stylesContent = content;
			st.version++;
			this._onDidRenderHtml.fire({ employeeId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		}

		this.logService.info(`[ConfigMD] Uploaded custom styles to ${relPath} for ${employeeId}`);
		return { stylesPath: relPath };
	}

	async removeParser(employeeId: string): Promise<void> {
		const employee = await this.agentStudioService.getEmployee(employeeId);
		if (!employee?.configMd) { return; }
		const cfg = { ...employee.configMd };
		delete cfg.parserPath;
		await this.agentStudioService.updateEmployee(employeeId, { configMd: cfg });

		const st = this._agents.get(employeeId);
		if (st) {
			st.customParser = undefined;
			st.html = this._renderInternal(st.markdown, undefined, employeeId);
			st.version++;
			this._onDidRenderHtml.fire({ employeeId, html: st.html, version: st.version, stylesContent: st.stylesContent });
		}
		this.logService.info(`[ConfigMD] Removed custom parser for ${employeeId}, fallback to built-in`);
	}

	async getInfo(employeeId: string): Promise<{ parserSource: 'builtin' | 'custom'; parserPath?: string; stylesPath?: string; hasStyles: boolean }> {
		const employee = await this.agentStudioService.getEmployee(employeeId);
		const cfg = employee?.configMd;
		const st = this._agents.get(employeeId);
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
