/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * imgui block processor — converts ` ```imgui ` fenced code blocks inside
 * ConfigMD markdown into interactive HTML form widgets.
 *
 * DSL: function-style, one widget per line. Example:
 *   ```imgui
 *   heading("调研参数")
 *   input_text(id="topic", label="研究主题", placeholder="输入关键词")
 *   slider(id="depth", label="深度", min=1, max=5, value=3)
 *   select(id="lang", label="语言", options=["zh","en","ja"], value="zh")
 *   checkbox(id="cite", label="附引用")
 *   button(id="submit", label="开始", action="send_to_chat",
 *          template="主题={topic}, 深度={depth}, 语言={lang}, 引用={cite}")
 *   ```
 *
 * Supported widgets (Phase 1):
 *   heading(text)
 *   text(text)
 *   input_text(id, label, placeholder?, value?)
 *   textarea(id, label, rows?, placeholder?, value?)
 *   slider(id, label, min, max, value?, step?)
 *   number(id, label, min?, max?, value?, step?)
 *   select(id, label, options=[...], value?)
 *   checkbox(id, label, value?)
 *   button(id, label, action, template?, variant?)
 *   divider()
 *
 * Supported actions (Phase 1):
 *   send_to_chat — collect form values, render `template`, post message to host
 *
 * Security: every user-provided string is HTML-escaped at render time;
 * widget attributes are whitelisted; unknown widgets are rendered as a
 * highlighted error placeholder, not skipped (so authors notice typos).
 */

// ─── AST types ────────────────────────────────────────────────────────────

export type ImguiArgValue = string | number | boolean | string[];

export interface ImguiWidget {
	readonly kind: string;
	readonly args: Record<string, ImguiArgValue>;
	readonly raw: string;
	readonly lineNo: number;
	readonly error?: string;
}

// ─── Parser ───────────────────────────────────────────────────────────────

/**
 * Parse a single DSL line like `slider(id="depth", label="深度", min=1, max=5)`
 * into `{ kind: 'slider', args: { id: 'depth', label: '深度', min: 1, max: 5 } }`.
 */
function parseLine(line: string, lineNo: number): ImguiWidget | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
		return null;
	}
	const m = /^([a-zA-Z_][\w]*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(trimmed);
	if (!m) {
		return { kind: '__error__', args: {}, raw: line, lineNo, error: `语法错误：期望 widget(args) 形式` };
	}
	const kind = m[1];
	const argsBody = m[2].trim();
	const args: Record<string, ImguiArgValue> = {};

	// Tokenise on top-level commas (skip commas inside strings / brackets).
	const parts = splitTopLevel(argsBody, ',');
	let positionalIdx = 0;
	for (const partRaw of parts) {
		const part = partRaw.trim();
		if (!part) { continue; }
		const eq = findTopLevelEq(part);
		if (eq < 0) {
			// Positional arg → assign to a synthetic key so renderer can pick it up.
			const v = parseValue(part);
			if (v !== undefined) {
				args[`__pos${positionalIdx++}`] = v;
			}
		} else {
			const key = part.slice(0, eq).trim();
			const valStr = part.slice(eq + 1).trim();
			const v = parseValue(valStr);
			if (v !== undefined) {
				args[key] = v;
			}
		}
	}
	return { kind, args, raw: line, lineNo };
}

function findTopLevelEq(s: string): number {
	let depth = 0;
	let inStr: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (c === '\\') { i++; continue; }
			if (c === inStr) { inStr = null; }
			continue;
		}
		if (c === '"' || c === "'") { inStr = c; continue; }
		if (c === '[' || c === '(' || c === '{') { depth++; continue; }
		if (c === ']' || c === ')' || c === '}') { depth--; continue; }
		if (c === '=' && depth === 0) { return i; }
	}
	return -1;
}

function splitTopLevel(s: string, sep: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr: string | null = null;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (c === '\\') { i++; continue; }
			if (c === inStr) { inStr = null; }
			continue;
		}
		if (c === '"' || c === "'") { inStr = c; continue; }
		if (c === '[' || c === '(' || c === '{') { depth++; continue; }
		if (c === ']' || c === ')' || c === '}') { depth--; continue; }
		if (c === sep && depth === 0) {
			out.push(s.slice(start, i));
			start = i + 1;
		}
	}
	out.push(s.slice(start));
	return out;
}

function parseValue(s: string): ImguiArgValue | undefined {
	const t = s.trim();
	if (!t) { return undefined; }
	// String literal
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return unquote(t);
	}
	// Array of strings/numbers
	if (t.startsWith('[') && t.endsWith(']')) {
		const inner = t.slice(1, -1);
		const items = splitTopLevel(inner, ',').map(x => x.trim()).filter(x => x.length > 0);
		const result: string[] = [];
		for (const it of items) {
			const v = parseValue(it);
			if (v === undefined) { continue; }
			result.push(typeof v === 'string' ? v : String(v));
		}
		return result;
	}
	// Boolean
	if (t === 'true') { return true; }
	if (t === 'false') { return false; }
	// Number
	if (/^-?\d+(\.\d+)?$/.test(t)) { return Number(t); }
	// Bareword → treat as string
	return t;
}

function unquote(s: string): string {
	const inner = s.slice(1, -1);
	return inner
		.replace(/\\n/g, '\n')
		.replace(/\\t/g, '\t')
		.replace(/\\r/g, '\r')
		.replace(/\\"/g, '"')
		.replace(/\\'/g, "'")
		.replace(/\\\\/g, '\\');
}

/** Parse a full imgui block source (multi-line) into a list of widgets. */
export function parseImguiBlock(src: string): ImguiWidget[] {
	const physicalLines = src.split('\n');
	// First pass: join continuation lines so `widget(arg1,\n  arg2)` becomes
	// a single logical line. A line is considered "open" if it has more
	// `(` / `[` / `{` than `)` / `]` / `}` (ignoring chars inside string
	// literals). The next physical line(s) are appended until the brackets
	// balance. This lets authors freely wrap long button(...) calls across
	// several lines, which is the most common cause of "expected widget(args)"
	// errors in practice.
	const logical: Array<{ text: string; lineNo: number }> = [];
	let buffer = '';
	let bufferStart = 0;
	let depth = 0;
	for (let i = 0; i < physicalLines.length; i++) {
		const line = physicalLines[i];
		if (buffer.length === 0) {
			bufferStart = i + 1;
			buffer = line;
		} else {
			buffer += '\n' + line;
		}
		depth += bracketDelta(line);
		if (depth <= 0) {
			logical.push({ text: buffer, lineNo: bufferStart });
			buffer = '';
			depth = 0;
		}
	}
	const out: ImguiWidget[] = [];
	if (buffer.length > 0) {
		// Unclosed at EOF — emit a synthetic error widget so the user sees
		// the location of the missing close bracket. We DON'T just feed the
		// unbalanced text to parseLine() because that would yield a generic
		// "expected widget(args)" message that doesn't hint at the actual
		// cause (a button(...) that wraps multiple lines and forgot to close).
		// Note: we still push earlier balanced statements first via the
		// loop below; this branch only annotates the trailing tail.
		const trailing: ImguiWidget = {
			kind: '__error__',
			args: {},
			raw: buffer,
			lineNo: bufferStart,
			error: `括号未闭合：从第 ${bufferStart} 行开始的语句缺少匹配的 ) / ] / }`,
		};
		// Render preceding balanced widgets first.
		for (const { text, lineNo } of logical) {
			const w = parseLine(text, lineNo);
			if (w) { out.push(w); }
		}
		out.push(trailing);
		return out;
	}

	for (const { text, lineNo } of logical) {
		const w = parseLine(text, lineNo);
		if (w) { out.push(w); }
	}
	return out;
}

/**
 * Count the net bracket-depth change introduced by a single physical line,
 * ignoring brackets that appear inside string literals (single or double
 * quoted, with `\` escape).
 */
function bracketDelta(line: string): number {
	let depth = 0;
	let inStr: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inStr) {
			if (c === '\\') { i++; continue; }
			if (c === inStr) { inStr = null; }
			continue;
		}
		if (c === '"' || c === "'") { inStr = c; continue; }
		if (c === '(' || c === '[' || c === '{') { depth++; }
		else if (c === ')' || c === ']' || c === '}') { depth--; }
	}
	return depth;
}

// ─── Renderer ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
	return escapeHtml(s);
}

/** Render one widget into HTML. */
function renderWidget(w: ImguiWidget, formId: string): string {
	if (w.kind === '__error__') {
		return `<div class="imgui-row imgui-error">⚠ 第 ${w.lineNo} 行：${escapeHtml(w.error || 'parse error')}<pre>${escapeHtml(w.raw)}</pre></div>`;
	}
	const a = w.args;
	const id = typeof a.id === 'string' ? a.id : '';
	const label = typeof a.label === 'string' ? a.label : (typeof a.__pos0 === 'string' ? a.__pos0 : '');

	switch (w.kind) {
		case 'heading':
		case 'h2':
		case 'h3': {
			const text = typeof a.__pos0 === 'string' ? a.__pos0 : (typeof a.text === 'string' ? a.text : '');
			return `<h3 class="imgui-heading">${escapeHtml(text)}</h3>`;
		}
		case 'text':
		case 'p': {
			const text = typeof a.__pos0 === 'string' ? a.__pos0 : (typeof a.text === 'string' ? a.text : '');
			return `<p class="imgui-text">${escapeHtml(text)}</p>`;
		}
		case 'divider':
		case 'separator':
			return `<hr class="imgui-divider"/>`;
		case 'spacer':
			return `<div class="imgui-spacer"></div>`;

		case 'input_text': {
			if (!id) { return invalid(w, 'input_text 缺少 id'); }
			const placeholder = typeof a.placeholder === 'string' ? a.placeholder : '';
			const value = a.value !== undefined ? String(a.value) : '';
			return `<label class="imgui-row"><span class="imgui-label">${escapeHtml(label)}</span><input class="imgui-input" type="text" data-imgui-id="${escapeAttr(id)}" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(value)}"/></label>`;
		}
		case 'textarea': {
			if (!id) { return invalid(w, 'textarea 缺少 id'); }
			const rows = typeof a.rows === 'number' ? a.rows : 4;
			const placeholder = typeof a.placeholder === 'string' ? a.placeholder : '';
			const value = a.value !== undefined ? String(a.value) : '';
			return `<label class="imgui-row imgui-row-block"><span class="imgui-label">${escapeHtml(label)}</span><textarea class="imgui-textarea" data-imgui-id="${escapeAttr(id)}" rows="${rows}" placeholder="${escapeAttr(placeholder)}">${escapeHtml(value)}</textarea></label>`;
		}
		case 'slider': {
			if (!id) { return invalid(w, 'slider 缺少 id'); }
			const min = typeof a.min === 'number' ? a.min : 0;
			const max = typeof a.max === 'number' ? a.max : 100;
			const step = typeof a.step === 'number' ? a.step : 1;
			const value = typeof a.value === 'number' ? a.value : min;
			// Note: live value display is wired up by the SDK (input listener),
			// not by an inline `oninput=` attribute, because the host's
			// HTML sanitizer strips all `on*=` handlers.
			return `<label class="imgui-row"><span class="imgui-label">${escapeHtml(label)}</span><span class="imgui-slider-wrap"><input class="imgui-slider" type="range" data-imgui-id="${escapeAttr(id)}" min="${min}" max="${max}" step="${step}" value="${value}"/><output class="imgui-slider-value" data-imgui-output-for="${escapeAttr(id)}">${value}</output></span></label>`;
		}
		case 'number': {
			if (!id) { return invalid(w, 'number 缺少 id'); }
			const min = typeof a.min === 'number' ? `min="${a.min}"` : '';
			const max = typeof a.max === 'number' ? `max="${a.max}"` : '';
			const step = typeof a.step === 'number' ? `step="${a.step}"` : '';
			const value = a.value !== undefined ? String(a.value) : '';
			return `<label class="imgui-row"><span class="imgui-label">${escapeHtml(label)}</span><input class="imgui-input" type="number" data-imgui-id="${escapeAttr(id)}" ${min} ${max} ${step} value="${escapeAttr(value)}"/></label>`;
		}
		case 'select':
		case 'combo': {
			if (!id) { return invalid(w, 'select 缺少 id'); }
			const options = Array.isArray(a.options) ? a.options : [];
			const value = a.value !== undefined ? String(a.value) : '';
			const opts = options.map(o => {
				const sel = o === value ? 'selected' : '';
				return `<option value="${escapeAttr(o)}" ${sel}>${escapeHtml(o)}</option>`;
			}).join('');
			return `<label class="imgui-row"><span class="imgui-label">${escapeHtml(label)}</span><select class="imgui-select" data-imgui-id="${escapeAttr(id)}">${opts}</select></label>`;
		}
		case 'radio': {
			if (!id) { return invalid(w, 'radio 缺少 id'); }
			const options = Array.isArray(a.options) ? a.options : [];
			const value = a.value !== undefined ? String(a.value) : '';
			// All radio inputs in this group share the same `name` attribute
			// (= the data-imgui-id) so the browser handles single-selection.
			// We mark only the input that carries `data-imgui-id` so the SDK
			// collector picks it up; the rest are siblings.
			const inputs = options.map((o, idx) => {
				const checked = o === value ? 'checked' : '';
				const isFirst = idx === 0;
				// Only the FIRST radio in the group carries data-imgui-id so
				// our collector hits it once. We use the radio-group's checked
				// value at submit time via a dedicated SDK pathway (see SDK).
				const tag = isFirst
					? `data-imgui-id="${escapeAttr(id)}" data-imgui-radio-group="${escapeAttr(id)}"`
					: `data-imgui-radio-group="${escapeAttr(id)}"`;
				return `<label class="imgui-radio-item"><input type="radio" name="rg-${escapeAttr(id)}" value="${escapeAttr(o)}" ${checked} ${tag}/>${escapeHtml(o)}</label>`;
			}).join('');
			return `<div class="imgui-row imgui-row-block"><span class="imgui-label">${escapeHtml(label)}</span><div class="imgui-radio-group">${inputs}</div></div>`;
		}
		case 'checkbox': {
			if (!id) { return invalid(w, 'checkbox 缺少 id'); }
			const checked = a.value === true ? 'checked' : '';
			return `<label class="imgui-row imgui-checkbox-row"><input class="imgui-checkbox" type="checkbox" data-imgui-id="${escapeAttr(id)}" ${checked}/><span class="imgui-label">${escapeHtml(label)}</span></label>`;
		}
		case 'progress': {
			// Read-only display widget. value 0..max, default max=100.
			const max = typeof a.max === 'number' ? a.max : 100;
			const value = typeof a.value === 'number' ? a.value : 0;
			// Optionally bind to a state id so `imgui.set` host pushes can update it.
			const idAttr = id ? ` data-imgui-id="${escapeAttr(id)}"` : '';
			const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
			return `<div class="imgui-row"><span class="imgui-label">${escapeHtml(label)}</span><div class="imgui-progress"${idAttr} data-imgui-max="${max}" data-imgui-value="${value}"><div class="imgui-progress-fill" style="width:${pct.toFixed(1)}%"></div><span class="imgui-progress-text">${value}/${max}</span></div></div>`;
		}
		case 'badge': {
			const text = typeof a.__pos0 === 'string' ? a.__pos0 : (typeof a.text === 'string' ? a.text : '');
			const color = typeof a.color === 'string' ? a.color : 'default';
			const idAttr = id ? ` data-imgui-id="${escapeAttr(id)}"` : '';
			return `<span class="imgui-badge imgui-badge-${escapeAttr(color)}"${idAttr}>${escapeHtml(text)}</span>`;
		}
		case 'row_start':
		case 'row': {
			// Open a horizontal flex container. Closed by row_end().
			return `<div class="imgui-hrow">`;
		}
		case 'row_end':
		case 'end_row':
			return `</div>`;
		case 'column_start':
		case 'column': {
			return `<div class="imgui-hcol">`;
		}
		case 'column_end':
		case 'end_column':
			return `</div>`;
		case 'button': {
			if (!id) { return invalid(w, 'button 缺少 id'); }
			const action = typeof a.action === 'string' ? a.action : 'send_to_chat';
			const template = typeof a.template === 'string' ? a.template : '';
			const variant = typeof a.variant === 'string' ? a.variant : 'primary';
			const confirm = typeof a.confirm === 'string' ? a.confirm : '';
			// Optional payload (JSON-stringified) for actions that need
			// structured data beyond the rendered template (e.g. patch ops,
			// skill name, anchor name). Authors specify it as a string —
			// we pass it through verbatim and the SDK ships it as-is.
			const payload = typeof a.payload === 'string' ? a.payload : '';
			const anchor = typeof a.anchor === 'string' ? a.anchor : '';
			const skill = typeof a.skill === 'string' ? a.skill : '';
			// Phase 3: optional `state` anchor. When set, the host will
			// snapshot the form's current values into agent.md at this
			// anchor (as a fenced JSON code block) BEFORE running the
			// button's main action. This lets the agent read the form
			// state in any subsequent prompt — closing the loop between
			// "user filled imgui form" and "agent sees structured input".
			const stateAnchor = typeof a.state === 'string' ? a.state : '';
			return `<button type="button" class="imgui-button imgui-button-${escapeAttr(variant)}"`
				+ ` data-imgui-id="${escapeAttr(id)}"`
				+ ` data-imgui-action="${escapeAttr(action)}"`
				+ ` data-imgui-template="${escapeAttr(template)}"`
				+ (confirm ? ` data-imgui-confirm="${escapeAttr(confirm)}"` : '')
				+ (payload ? ` data-imgui-payload="${escapeAttr(payload)}"` : '')
				+ (anchor ? ` data-imgui-anchor="${escapeAttr(anchor)}"` : '')
				+ (skill ? ` data-imgui-skill="${escapeAttr(skill)}"` : '')
				+ (stateAnchor ? ` data-imgui-state="${escapeAttr(stateAnchor)}"` : '')
				+ `>${escapeHtml(label)}</button>`;
		}
		default:
			return invalid(w, `未知 widget '${w.kind}'`);
	}
}

function invalid(w: ImguiWidget, msg: string): string {
	return `<div class="imgui-row imgui-error">⚠ 第 ${w.lineNo} 行：${escapeHtml(msg)}<pre>${escapeHtml(w.raw)}</pre></div>`;
}

/** Render an entire imgui block source string into an HTML <form>. */
export function renderImguiBlock(src: string, formId: string): string {
	let widgets: ImguiWidget[];
	try {
		widgets = parseImguiBlock(src);
	} catch (err) {
		// Defensive: a thrown exception means we have a parser bug, not a
		// user error. Show it in-pane so the bug doesn't silently corrupt
		// the entire preview.
		const msg = err instanceof Error ? err.message : String(err);
		return `<form class="imgui-form" data-imgui-form="${escapeAttr(formId)}" onsubmit="return false;">\n`
			+ `<div class="imgui-row imgui-error">⚠ imgui 解析器异常：${escapeHtml(msg)}<pre>${escapeHtml(src)}</pre></div>\n`
			+ `</form>`;
	}
	const body = widgets.map(w => {
		try {
			return renderWidget(w, formId);
		} catch (err) {
			// One bad widget shouldn't take down the whole form.
			const msg = err instanceof Error ? err.message : String(err);
			return `<div class="imgui-row imgui-error">⚠ 第 ${w.lineNo} 行渲染失败：${escapeHtml(msg)}<pre>${escapeHtml(w.raw)}</pre></div>`;
		}
	}).join('\n');
	return `<form class="imgui-form" data-imgui-form="${escapeAttr(formId)}" onsubmit="return false;">\n${body}\n</form>`;
}

// ─── Markdown integration ─────────────────────────────────────────────────

/**
 * Replace HTML-rendered imgui code blocks with interactive <form> widgets.
 *
 * This runs AFTER the markdown parser, so it operates on:
 *   <pre class="cmd-code"><code class="lang-imgui">...</code></pre>     (built-in renderer)
 *   <pre><code class="language-imgui">...</code></pre>                  (most third-party parsers)
 *
 * We did not pre-process raw markdown because emitting `<form>` etc. before
 * the parser would either be escaped by built-in renderers (which call
 * `escape()` on raw lines) or be interpreted as nested markdown by some
 * third-party parsers. Post-processing the rendered HTML is robust because
 * almost every markdown engine emits the standard <pre><code class="…"> shape
 * for fenced code blocks.
 *
 * The code body inside the <code> element is HTML-escaped, so we unescape
 * it back to the original DSL source before parsing.
 */
export function postProcessImguiBlocks(html: string): string {
	let formCounter = 0;
	const re = /<pre[^>]*>\s*<code[^>]*class="(?:lang|language)-imgui[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g;
	return html.replace(re, (_match, escapedSrc: string) => {
		formCounter++;
		const formId = `imgui-form-${formCounter}`;
		const src = unescapeHtmlEntities(escapedSrc);
		return renderImguiBlock(src, formId);
	});
}

function unescapeHtmlEntities(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

// ─── Browser-side SDK (string constant, injected into preview HTML) ────────

/**
 * SDK script injected into the standalone preview document. Listens for
 * clicks on `[data-imgui-action]` buttons, collects sibling form values,
 * and posts a message to the host webview via `acquireVsCodeApi()`.
 *
 * Also listens for inbound `imgui.set` messages so the host can prefill
 * or reset form values programmatically (e.g. after a successful submit).
 */
export const IMGUI_SDK_SCRIPT = `(function(){
	// Cached context injected by the host pane on mount (imgui.ctx event).
	// Carries the (agentId, workspaceId, workspaceSessionId,
	// agentSessionId) tuple captured at the moment the preview was opened.
	// We attach it to every submit payload so the host can route imgui.submit
	// → chat.send to the exact session the user expects, even after they
	// switch agents / Forks in the chat panel.
	var __imguiCtx = {
		agentId: undefined,
		workspaceId: undefined,
		workspaceSessionId: undefined,
		agentSessionId: undefined
	};
	function collectValues(formEl){
		var out = {};
		// Regular controls (inputs / selects / textareas / checkboxes / sliders / numbers).
		formEl.querySelectorAll('[data-imgui-id]').forEach(function(el){
			var id = el.getAttribute('data-imgui-id');
			if (!id) return;
			// Radio group: read the checked sibling within the same group.
			if (el.type === 'radio') {
				var group = el.getAttribute('data-imgui-radio-group') || id;
				var picked = formEl.querySelector('input[type="radio"][data-imgui-radio-group="' + group + '"]:checked');
				out[id] = picked ? picked.value : '';
				return;
			}
			if (el.type === 'checkbox') { out[id] = el.checked; }
			else if (el.type === 'range' || el.type === 'number') { out[id] = el.value === '' ? '' : Number(el.value); }
			else if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') { out[id] = el.value; }
			// Display widgets (progress / badge): read the value attribute / textContent
			else if (el.classList && el.classList.contains('imgui-progress')) { out[id] = Number(el.getAttribute('data-imgui-value') || 0); }
			else if (el.classList && el.classList.contains('imgui-badge')) { out[id] = el.textContent || ''; }
		});
		return out;
	}
	function renderTemplate(tpl, values){
		if (!tpl) return '';
		return tpl.replace(/\\{(\\w+)\\}/g, function(_, k){
			return values.hasOwnProperty(k) ? String(values[k]) : '{' + k + '}';
		});
	}
	function getApi(){
		if (window.__vsapi) return window.__vsapi;
		try { window.__vsapi = acquireVsCodeApi(); return window.__vsapi; } catch(e) { return null; }
	}
	// Live slider → output sync (replaces stripped inline oninput= handlers).
	function syncSliderOutput(input){
		var id = input.getAttribute('data-imgui-id');
		if (!id) return;
		var out = document.querySelector('output[data-imgui-output-for="' + id.replace(/"/g, '\\\\"') + '"]');
		if (out) { out.textContent = input.value; }
	}
	function updateProgress(el, value, max){
		if (typeof max === 'number') { el.setAttribute('data-imgui-max', String(max)); }
		var m = Number(el.getAttribute('data-imgui-max') || 100);
		var v = Number(value);
		if (isNaN(v)) v = 0;
		el.setAttribute('data-imgui-value', String(v));
		var pct = m > 0 ? Math.max(0, Math.min(100, (v / m) * 100)) : 0;
		var fill = el.querySelector('.imgui-progress-fill');
		var text = el.querySelector('.imgui-progress-text');
		if (fill) fill.style.width = pct.toFixed(1) + '%';
		if (text) text.textContent = v + '/' + m;
	}
	// ── Persistence (sessionStorage by formId) ────────────────────────
	// Preserves user input across preview reloads / file rewrites within
	// the same webview session. Keyed by the workspace-relative file path
	// (parent window.location) plus the formId.
	function storageKey(formId){
		return 'imgui:' + (location.pathname || '') + ':' + formId;
	}
	// ── Context badge ─────────────────────────────────────────────────
	// Renders a small floating chip in the top-right of the preview that
	// shows which (workspace, agent, session) this preview is bound to.
	// Helps users keep track when they have multiple Forks open at once.
	// Idempotent: subsequent imgui.ctx events update the same badge.
	function renderCtxBadge(){
		try {
			var badge = document.getElementById('imgui-ctx-badge');
			if (!badge) {
				badge = document.createElement('div');
				badge.id = 'imgui-ctx-badge';
				badge.className = 'imgui-ctx-badge';
				document.body.appendChild(badge);
			}
			var emp = __imguiCtx.agentId || '—';
			var ws  = __imguiCtx.workspaceId || '—';
			var fsn = __imguiCtx.workspaceSessionId || '';
			var asn = __imguiCtx.agentSessionId || '—';
			var modeLabel = fsn ? 'Fork' : 'Root';
			var modeClass = fsn ? 'imgui-ctx-mode-fork' : 'imgui-ctx-mode-root';
			// Truncate long ids for display while keeping full ids in title.
			function shortId(s, n){
				if (!s || s === '—') return s;
				if (s.length <= n) return s;
				return s.substring(0, n - 3) + '…';
			}
			badge.innerHTML =
				'<span class="imgui-ctx-mode ' + modeClass + '">' + modeLabel + '</span>' +
				'<span class="imgui-ctx-row" title="agent: ' + escapeAttr(emp) + '">'+
				  '<span class="imgui-ctx-key">agent</span>'+
				  '<span class="imgui-ctx-val">' + escapeText(shortId(emp, 18)) + '</span>'+
				'</span>' +
				'<span class="imgui-ctx-row" title="workspace: ' + escapeAttr(ws) + '">'+
				  '<span class="imgui-ctx-key">ws</span>'+
				  '<span class="imgui-ctx-val">' + escapeText(shortId(ws, 14)) + '</span>'+
				'</span>' +
				(fsn ? (
				'<span class="imgui-ctx-row" title="fork session: ' + escapeAttr(fsn) + '">'+
				  '<span class="imgui-ctx-key">fork</span>'+
				  '<span class="imgui-ctx-val">' + escapeText(shortId(fsn, 14)) + '</span>'+
				'</span>'
				) : '') +
				'<span class="imgui-ctx-row" title="agent session: ' + escapeAttr(asn) + '">'+
				  '<span class="imgui-ctx-key">session</span>'+
				  '<span class="imgui-ctx-val">' + escapeText(shortId(asn, 14)) + '</span>'+
				'</span>';
		} catch (e) {
			try { console.warn('[imgui] renderCtxBadge failed', e); } catch(_){}
		}
	}
	function escapeText(s){
		return String(s == null ? '' : s)
			.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
	}
	function escapeAttr(s){
		return escapeText(s).replace(/"/g,'&quot;');
	}
	function saveForm(formEl){
		try {
			var formId = formEl.getAttribute('data-imgui-form');
			if (!formId) return;
			var v = collectValues(formEl);
			sessionStorage.setItem(storageKey(formId), JSON.stringify(v));
		} catch(e){ /* quota / storage disabled — non-fatal */ }
	}
	function restoreForm(formEl){
		try {
			var formId = formEl.getAttribute('data-imgui-form');
			if (!formId) return;
			var raw = sessionStorage.getItem(storageKey(formId));
			if (!raw) return;
			var values = JSON.parse(raw);
			applyValuesToForm(formEl, values);
		} catch(e){ /* parse/storage error — non-fatal */ }
	}
	function applyValuesToForm(scope, values){
		Object.keys(values).forEach(function(id){
			var el = scope.querySelector('[data-imgui-id="' + id + '"]');
			if (!el) return;
			if (el.type === 'radio') {
				var group = el.getAttribute('data-imgui-radio-group') || id;
				var match = scope.querySelector('input[type="radio"][data-imgui-radio-group="' + group + '"][value="' + String(values[id]).replace(/"/g, '\\\\"') + '"]');
				if (match) match.checked = true;
				return;
			}
			if (el.type === 'checkbox') { el.checked = !!values[id]; return; }
			if (el.classList && el.classList.contains('imgui-progress')) { updateProgress(el, values[id]); return; }
			if (el.classList && el.classList.contains('imgui-badge')) { el.textContent = String(values[id]); return; }
			el.value = String(values[id]);
			if (el.classList && el.classList.contains('imgui-slider')) { syncSliderOutput(el); }
		});
	}
	// Restore on load.
	document.querySelectorAll('[data-imgui-form]').forEach(function(f){ restoreForm(f); });
	// Save on every change (debounced).
	var saveTimer = null;
	document.addEventListener('input', function(e){
		var t = e.target;
		if (t && t.classList && t.classList.contains('imgui-slider')) { syncSliderOutput(t); }
		var formEl = t && t.closest && t.closest('[data-imgui-form]');
		if (!formEl) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(function(){ saveForm(formEl); }, 250);
	});
	document.addEventListener('change', function(e){
		var formEl = e.target && e.target.closest && e.target.closest('[data-imgui-form]');
		if (formEl) saveForm(formEl);
	});

	document.addEventListener('click', function(e){
		var btn = e.target && e.target.closest && e.target.closest('[data-imgui-action]');
		if (!btn) return;
		var formEl = btn.closest('[data-imgui-form]');
		var values = formEl ? collectValues(formEl) : {};
		var action = btn.getAttribute('data-imgui-action') || 'send_to_chat';
		var template = btn.getAttribute('data-imgui-template') || '';
		var rendered = renderTemplate(template, values);
		var formId = formEl ? formEl.getAttribute('data-imgui-form') : null;
		var confirmMsg = btn.getAttribute('data-imgui-confirm');
		var payloadAttr = btn.getAttribute('data-imgui-payload') || '';
		var anchor = btn.getAttribute('data-imgui-anchor') || '';
		var skill = btn.getAttribute('data-imgui-skill') || '';
		var stateAnchor = btn.getAttribute('data-imgui-state') || '';
		// Optional confirm step — note: webview doesn't support window.confirm,
		// so we use a 5s "armed" two-step gesture instead, mirroring the
		// pattern already used by the ConfigHtml Demo button.
		if (confirmMsg) {
			if (!btn.__armed) {
				btn.__armed = true;
				var oldText = btn.textContent;
				btn.textContent = '⚠ ' + confirmMsg + '（再次点击确认）';
				btn.classList.add('imgui-button-armed');
				setTimeout(function(){
					btn.__armed = false;
					btn.textContent = oldText;
					btn.classList.remove('imgui-button-armed');
				}, 5000);
				return;
			}
			btn.__armed = false;
			btn.classList.remove('imgui-button-armed');
		}
		var api = getApi();
		if (!api) {
			console.warn('[imgui] vscode api unavailable; submit dropped', { action: action, values: values });
			return;
		}
		// Try parsing payload as JSON; fallback to string passthrough.
		var payload = payloadAttr;
		if (payloadAttr) {
			try { payload = JSON.parse(payloadAttr); } catch(_){ /* keep as string */ }
		}
		api.postMessage({
			type: 'imgui.submit',
			payload: {
				formId: formId,
				buttonId: btn.getAttribute('data-imgui-id'),
				action: action,
				template: template,
				message: rendered,
				values: values,
				anchor: anchor || undefined,
				skill: skill || undefined,
				stateAnchor: stateAnchor || undefined,
				payload: payload || undefined,
				// Routing context: copied from the imgui.ctx message the
				// host pane sent us on mount. The host re-validates this
				// (the preview JS shouldn't be trusted as a routing
				// authority on its own), but echoing it makes diagnostics
				// — and any future SDK-level features that depend on
				// session — much easier.
				ctx: {
					agentId: __imguiCtx.agentId,
					workspaceId: __imguiCtx.workspaceId,
					workspaceSessionId: __imguiCtx.workspaceSessionId,
					agentSessionId: __imguiCtx.agentSessionId
				}
			}
		});
		btn.classList.add('imgui-button-active');
		setTimeout(function(){ btn.classList.remove('imgui-button-active'); }, 300);
	});
	// ── Inbound: host → preview commands ───────────────────────────────
	// imgui.set        — bulk-update form values { id → value }
	// imgui.set_one    — single value update     { id, value, max? }
	// imgui.toast      — transient notification banner inside the preview
	// imgui.reset      — reset a form to its initial values (clear sessionStorage)
	window.addEventListener('message', function(e){
		var m = e.data;
		if (!m || typeof m.type !== 'string') return;
		if (m.type === 'imgui.ctx') {
			// Host telling us which (agent, workspace, fork session,
			// agent session) this preview is bound to. Cache it for
			// subsequent submits.
			__imguiCtx = {
				agentId: m.agentId,
				workspaceId: m.workspaceId,
				workspaceSessionId: m.workspaceSessionId,
				agentSessionId: m.agentSessionId
			};
			try {
				console.log('[imgui] ctx received:', __imguiCtx);
			} catch(_){}
			// Also publish to a globally-readable hook for power-user JS
			// running inside the preview (e.g. theme tweaks that want to
			// show a session badge).
			try { window.__IMGUI_CTX__ = __imguiCtx; } catch(_){}
			renderCtxBadge();
			return;
		}
		if (m.type === 'imgui.set' || m.type === 'imgui.set_one') {
			var values = m.values || (m.id ? (function(){ var o = {}; o[m.id] = m.value; if (typeof m.max === 'number') o[m.id + '__max'] = m.max; return o; })() : {});
			applyValuesToForm(document, values);
			return;
		}
		if (m.type === 'imgui.toast') {
			showToast(m.message || '', m.variant || 'info', m.duration || 2400);
			return;
		}
		if (m.type === 'imgui.reset') {
			var formId = m.formId;
			document.querySelectorAll('[data-imgui-form]').forEach(function(f){
				if (formId && f.getAttribute('data-imgui-form') !== formId) return;
				try { sessionStorage.removeItem(storageKey(f.getAttribute('data-imgui-form'))); } catch(_){}
				// Re-apply DOM defaults via location.reload alternative: clear values manually.
				f.querySelectorAll('[data-imgui-id]').forEach(function(el){
					if (el.type === 'checkbox' || el.type === 'radio') { el.checked = el.defaultChecked; }
					else if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') { el.value = el.defaultValue || ''; if (el.classList && el.classList.contains('imgui-slider')) { syncSliderOutput(el); } }
				});
			});
			return;
		}
	});
	function showToast(text, variant, duration){
		var t = document.createElement('div');
		t.className = 'imgui-toast imgui-toast-' + variant;
		t.textContent = text;
		document.body.appendChild(t);
		// Force layout then animate in
		void t.offsetHeight;
		t.classList.add('imgui-toast-show');
		setTimeout(function(){
			t.classList.remove('imgui-toast-show');
			setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 250);
		}, duration);
	}
})();`;

export const IMGUI_SDK_STYLES = `
.imgui-form { display: flex; flex-direction: column; gap: 10px; padding: 16px; margin: 14px 0; background: rgba(127,127,127,0.06); border: 1px solid rgba(127,127,127,0.20); border-radius: 8px; }
.imgui-row { display: flex; align-items: center; gap: 10px; }
.imgui-row-block { flex-direction: column; align-items: stretch; }
.imgui-checkbox-row { gap: 6px; }
.imgui-label { min-width: 96px; font-size: 13px; opacity: 0.85; }
.imgui-input, .imgui-select, .imgui-textarea { flex: 1; min-width: 0; padding: 5px 8px; font: inherit; color: inherit; background: rgba(127,127,127,0.10); border: 1px solid rgba(127,127,127,0.30); border-radius: 4px; outline: none; }
.imgui-input:focus, .imgui-select:focus, .imgui-textarea:focus { border-color: #4ea1ff; }
.imgui-textarea { min-height: 60px; resize: vertical; font-family: "Cascadia Code", Consolas, monospace; font-size: 12.5px; }
.imgui-slider-wrap { flex: 1; display: flex; align-items: center; gap: 8px; }
.imgui-slider { flex: 1; }
.imgui-slider-value { min-width: 32px; text-align: right; font-family: monospace; font-size: 12px; opacity: 0.85; }
.imgui-checkbox { width: 16px; height: 16px; accent-color: #4ea1ff; }
.imgui-radio-group { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.imgui-radio-item { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; font-size: 13px; }
.imgui-radio-item input[type="radio"] { accent-color: #4ea1ff; }
.imgui-divider { border: 0; border-top: 1px dashed rgba(127,127,127,0.35); margin: 6px 0; }
.imgui-spacer { height: 6px; }
.imgui-heading { margin: 6px 0 2px; font-size: 1.05em; }
.imgui-text { margin: 2px 0; opacity: 0.9; }
.imgui-button { align-self: flex-start; padding: 6px 16px; font: inherit; border: none; border-radius: 4px; cursor: pointer; transition: transform 0.08s, opacity 0.15s, background 0.15s; }
.imgui-button-primary { background: #4ea1ff; color: #ffffff; }
.imgui-button-secondary { background: rgba(127,127,127,0.20); color: inherit; }
.imgui-button-danger { background: #d63f3f; color: #ffffff; }
.imgui-button:hover { opacity: 0.88; }
.imgui-button:active, .imgui-button-active { transform: translateY(1px); opacity: 0.7; }
.imgui-button-armed { background: #f0a020 !important; color: #000 !important; animation: imgui-pulse 1.2s ease-in-out infinite; }
@keyframes imgui-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.65; } }
.imgui-error { padding: 8px 12px; background: rgba(214,63,63,0.12); border-left: 3px solid #d63f3f; border-radius: 0 4px 4px 0; color: #ff8e8e; font-size: 13px; }
.imgui-error pre { margin: 6px 0 0; padding: 6px 8px; background: rgba(0,0,0,0.20); border-radius: 3px; font-size: 12px; white-space: pre-wrap; }
.imgui-progress { flex: 1; position: relative; height: 18px; background: rgba(127,127,127,0.18); border-radius: 9px; overflow: hidden; }
.imgui-progress-fill { height: 100%; background: linear-gradient(90deg, #4ea1ff, #6cc6ff); transition: width 0.3s ease; }
.imgui-progress-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-family: monospace; color: rgba(255,255,255,0.95); text-shadow: 0 1px 1px rgba(0,0,0,0.5); }
.imgui-badge { display: inline-block; padding: 2px 8px; font-size: 12px; border-radius: 10px; background: rgba(127,127,127,0.25); margin-right: 4px; }
.imgui-badge-success { background: rgba(58,180,90,0.25); color: #6cd48a; }
.imgui-badge-warning { background: rgba(240,160,32,0.25); color: #ffb45e; }
.imgui-badge-danger  { background: rgba(214,63,63,0.25); color: #ff8e8e; }
.imgui-badge-info    { background: rgba(78,161,255,0.25); color: #79b9ff; }
.imgui-hrow { display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
.imgui-hrow > .imgui-row { flex: 1 1 200px; }
.imgui-hcol { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; }
.imgui-toast { position: fixed; left: 50%; bottom: 32px; transform: translate(-50%, 12px); padding: 8px 16px; border-radius: 6px; font-size: 13px; background: rgba(40,40,40,0.95); color: #f0f0f0; box-shadow: 0 4px 16px rgba(0,0,0,0.4); pointer-events: none; opacity: 0; transition: opacity 0.2s, transform 0.2s; z-index: 9999; }
.imgui-toast-show { opacity: 1; transform: translate(-50%, 0); }
.imgui-toast-success { background: rgba(58,180,90,0.95); }
.imgui-toast-warning { background: rgba(240,160,32,0.95); color: #1e1e1e; }
.imgui-toast-error { background: rgba(214,63,63,0.95); }

/* Context badge (top-right pill showing workspace/agent/session binding). */
.imgui-ctx-badge {
	position: fixed; top: 10px; right: 12px; z-index: 9999;
	display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
	padding: 5px 8px;
	background: rgba(30,30,30,0.78);
	border: 1px solid rgba(127,127,127,0.30);
	border-radius: 14px;
	font: 11px/1.2 -apple-system, "Segoe UI", system-ui, sans-serif;
	color: rgba(255,255,255,0.92);
	backdrop-filter: blur(6px);
	-webkit-backdrop-filter: blur(6px);
	box-shadow: 0 2px 8px rgba(0,0,0,0.25);
	max-width: 60vw;
}
@media (prefers-color-scheme: light) {
	.imgui-ctx-badge { background: rgba(255,255,255,0.85); color: #1e1e1e; border-color: rgba(0,0,0,0.12); }
}
.imgui-ctx-mode {
	padding: 1px 7px; border-radius: 9px;
	font-weight: 600; font-size: 10px;
	letter-spacing: 0.04em; text-transform: uppercase;
}
.imgui-ctx-mode-fork { background: rgba(78,161,255,0.30); color: #aed6ff; }
.imgui-ctx-mode-root { background: rgba(180,180,180,0.25); color: rgba(255,255,255,0.85); }
@media (prefers-color-scheme: light) {
	.imgui-ctx-mode-fork { color: #1467c4; }
	.imgui-ctx-mode-root { color: #555; }
}
.imgui-ctx-row { display: inline-flex; align-items: center; gap: 4px; }
.imgui-ctx-key {
	opacity: 0.55; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
}
.imgui-ctx-val {
	font-family: "Cascadia Code", Consolas, ui-monospace, monospace;
	font-size: 11px;
	background: rgba(127,127,127,0.18);
	padding: 1px 5px;
	border-radius: 4px;
	max-width: 160px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
`;
