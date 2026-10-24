/*---------------------------------------------------------------------------------------------
 *  Cursor crash guard (Windows)
 *
 *  ★★ 2026-10-24 root cause (dev machine, 9 identical dumps, reproduced with a 1-line page):
 *
 *    Chromium renders these CSS cursors from cursor RESOURCES embedded in the exe
 *    (LoadCursor(hModule, IDC_*_custom)):
 *        col-resize row-resize vertical-text cell zoom-in zoom-out grab grabbing copy alias
 *    When that LoadCursor fails, Electron 39 (Chromium) logs
 *        ui/wm/core/cursor_loader.cc:200 Failed to load a platform cursor of type kColumnResize
 *    and right after that a CHECK fires -> ImmediateCrash -> the WHOLE app dies with
 *    0xC000001D (browser process; no JS frame on the stack, so nothing we can catch).
 *
 *    On the dev machine LoadCursor failed with ERROR_NOT_ENOUGH_MEMORY because the session's
 *    USER atom table was exhausted (16320/16384 entries, ~14.7k leaked by another program).
 *    Loading a resource cursor needs a new atom; even Windows' own comctl32/mshtml resource
 *    cursors failed the same way. Every other cursor kind is a preloaded SYSTEM cursor and
 *    keeps working -- which is why the app only died when the mouse crossed e.g. a column
 *    resize handle ("hovering the preset chip").
 *
 *  We cannot patch Chromium, but each risky cursor has a visually close SYSTEM cursor. So we
 *  rewrite the CSS before it can reach the cursor loader, in every frame of every WebContents:
 *    - existing style sheets (incl. @media/@supports/@layer/nesting/@import, adopted sheets,
 *      open shadow roots) and inline `style` attributes;
 *    - new <style>/<link> elements and `style` attribute changes (MutationObserver; the
 *      callback is a microtask, so it runs before the next style recalc / cursor update).
 *      This is what catches `el.style.cursor = ...`: in Chromium 142 `cursor` is a plain data
 *      property on CSSStyleDeclaration.prototype, so there is no setter to wrap;
 *    - JS writes: style.setProperty / style.cssText / setAttribute('style') /
 *      CSSStyleSheet.insertRule|replace|replaceSync / attachShadow / adoptedStyleSheets.
 *  Opt-out: env VSSAROS_CURSOR_GUARD=0.
 *
 *  Known gap: a frame is protected from its `dom-ready`; a risky cursor under a resting mouse
 *  during the first paint of a frame is not covered (no main-world hook runs earlier).
 *--------------------------------------------------------------------------------------------*/

import { app, webFrameMain, type WebContents, type WebFrameMain } from 'electron';

/** Risky CSS cursor keyword -> safe SYSTEM cursor keyword (measured on Electron 39.8.8). */
export const CURSOR_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
	'col-resize': 'ew-resize',
	'row-resize': 'ns-resize',
	'vertical-text': 'text',
	'cell': 'crosshair',
	'zoom-in': 'pointer',
	'zoom-out': 'pointer',
	'-webkit-zoom-in': 'pointer',
	'-webkit-zoom-out': 'pointer',
	'grab': 'move',
	'grabbing': 'move',
	'-webkit-grab': 'move',
	'-webkit-grabbing': 'move',
	'copy': 'default',
	'alias': 'default',
});

export interface ICursorCrashGuardLogger {
	info(message: string): void;
	trace(message: string): void;
}

/**
 * Page-side guard (runs in the MAIN world through `WebFrameMain.executeJavaScript`).
 * Kept as plain JS text on purpose: `Function.prototype.toString()` of transpiled/minified
 * code may reference bundler helpers that do not exist inside the page.
 * Idempotent: a second injection returns `'already'`.
 */
const PAGE_SCRIPT_BODY = String.raw`
'use strict';
var w = window;
if (w.__vssarosCursorGuard) { return 'already'; }
var state = { version: 1, fixed: 0, errors: 0, ms: 0 };
w.__vssarosCursorGuard = state;
var t0 = Date.now();

var KEYWORD_AT_END = /(^|,)(\s*)([-a-zA-Z]+)\s*$/;
function sanitizeValue(value) {
	if (typeof value !== 'string' || value.length === 0) { return undefined; }
	var m = KEYWORD_AT_END.exec(value);
	if (!m) { return undefined; }
	var safe = MAP[m[3].toLowerCase()];
	if (!safe) { return undefined; }
	return value.slice(0, m.index) + m[1] + m[2] + safe;
}
var DECL = /((?:^|[\s;{])(?:--[-\w]*cursor[-\w]*|cursor)\s*:\s*)([^;{}]+)/gi;
function sanitizeText(text) {
	if (typeof text !== 'string' || text.indexOf('ursor') < 0) { return text; }
	return text.replace(DECL, function (all, head, val) {
		var imp = /\s*!\s*important\s*$/i.exec(val);
		var core = imp ? val.slice(0, imp.index) : val;
		var trimmed = core.replace(/\s+$/, '');
		var fixed = sanitizeValue(trimmed);
		if (fixed === undefined) { return all; }
		state.fixed++;
		return head + fixed + core.slice(trimmed.length) + (imp ? imp[0] : '');
	});
}
state.sanitizeValue = sanitizeValue;
state.sanitizeText = sanitizeText;

var D = w.CSSStyleDeclaration && w.CSSStyleDeclaration.prototype;
var rawSetProperty = D && D.setProperty;
function fixStyle(style) {
	if (!style || !rawSetProperty) { return; }
	try {
		var v = style.getPropertyValue('cursor');
		if (v) {
			var s = sanitizeValue(v);
			if (s !== undefined) { rawSetProperty.call(style, 'cursor', s, style.getPropertyPriority('cursor')); state.fixed++; }
		}
		for (var i = 0; i < style.length; i++) {
			var name = style[i];
			if (name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45 && name.indexOf('cursor') >= 0) {
				var cs = sanitizeValue(style.getPropertyValue(name).trim());
				if (cs !== undefined) { rawSetProperty.call(style, name, cs, style.getPropertyPriority(name)); state.fixed++; }
			}
		}
	} catch (e) { state.errors++; }
}
function walkRules(rules, depth) {
	if (!rules || depth > 16) { return; }
	for (var i = 0; i < rules.length; i++) {
		var r = rules[i];
		if (r.style) { fixStyle(r.style); }
		if (r.cssRules && r.cssRules.length) { walkRules(r.cssRules, depth + 1); }
		if (r.styleSheet) { walkSheet(r.styleSheet, depth + 1); }
	}
}
function walkSheet(sheet, depth) {
	if (!sheet) { return; }
	var rules;
	try { rules = sheet.cssRules; } catch (e) { return; }
	walkRules(rules, depth || 0);
}
function watchLink(link) {
	if (link.sheet) { walkSheet(link.sheet, 0); }
	try { link.addEventListener('load', function () { walkSheet(link.sheet, 0); }); } catch (e) { state.errors++; }
}
function onAdded(node) {
	if (node.nodeType === 3) {
		var p = node.parentNode;
		if (p && p.tagName === 'STYLE' && p.sheet) { walkSheet(p.sheet, 0); }
		return;
	}
	if (node.nodeType !== 1) { return; }
	var tag = node.tagName;
	if (tag === 'STYLE') { if (node.sheet) { walkSheet(node.sheet, 0); } }
	else if (tag === 'LINK') { watchLink(node); }
	if (node.shadowRoot) { adoptRoot(node.shadowRoot); }
	var a = node.getAttribute ? node.getAttribute('style') : null;
	if (a && a.indexOf('ursor') >= 0) { fixStyle(node.style); }
	if (node.firstElementChild) {
		var inner = node.querySelectorAll('style,link,[style*="ursor"]');
		for (var i = 0; i < inner.length; i++) {
			var e = inner[i];
			if (e.tagName === 'STYLE') { if (e.sheet) { walkSheet(e.sheet, 0); } }
			else if (e.tagName === 'LINK') { watchLink(e); }
			else { fixStyle(e.style); }
		}
	}
}
function onMutations(records) {
	for (var i = 0; i < records.length; i++) {
		var rec = records[i];
		var t = rec.target;
		if (rec.type === 'attributes') {
			// el.style.cursor = 'col-resize' and friends end up here (microtask, before the next
			// style recalc / cursor update). Fast path: read one property, one map lookup.
			try {
				var st = t.style;
				// Inline custom properties (--x-cursor) are covered by the setProperty/cssText/
				// setAttribute wrappers; keep this path free of cssText serialization.
				var cv = st && st.cursor;
				if (cv && sanitizeValue(cv) !== undefined) { fixStyle(st); }
			} catch (e) { state.errors++; }
			continue;
		}
		if (t && t.tagName === 'STYLE' && t.sheet) { walkSheet(t.sheet, 0); }
		var added = rec.addedNodes;
		for (var j = 0; j < added.length; j++) {
			try { onAdded(added[j]); } catch (e) { state.errors++; }
		}
	}
}
var seenRoots = typeof WeakSet === 'function' ? new WeakSet() : null;
function adoptRoot(root) {
	if (!root || (seenRoots && seenRoots.has(root))) { return; }
	if (seenRoots) { seenRoots.add(root); }
	try { var ss = root.styleSheets; for (var i = 0; i < ss.length; i++) { walkSheet(ss[i], 0); } } catch (e) { state.errors++; }
	try { var ad = root.adoptedStyleSheets; if (ad) { for (var j = 0; j < ad.length; j++) { walkSheet(ad[j], 0); } } } catch (e) { state.errors++; }
	try { var els = root.querySelectorAll('[style*="ursor"]'); for (var k = 0; k < els.length; k++) { fixStyle(els[k].style); } } catch (e) { state.errors++; }
	try { var all = root.querySelectorAll('*'); for (var n = 0; n < all.length; n++) { if (all[n].shadowRoot) { adoptRoot(all[n].shadowRoot); } } } catch (e) { state.errors++; }
	try { new MutationObserver(onMutations).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] }); } catch (e) { state.errors++; }
}
function patchSetter(proto, prop, transform) {
	try {
		var d = Object.getOwnPropertyDescriptor(proto, prop);
		if (!d || !d.set || !d.configurable) { return false; }
		Object.defineProperty(proto, prop, {
			configurable: true, enumerable: d.enumerable, get: d.get,
			set: function (v) { return d.set.call(this, transform(v)); }
		});
		return true;
	} catch (e) { state.errors++; return false; }
}
function wrapTextArg(proto, method, argIndex) {
	if (!proto || typeof proto[method] !== 'function') { return; }
	var raw = proto[method];
	proto[method] = function () {
		var args = Array.prototype.slice.call(arguments);
		if (typeof args[argIndex] === 'string') { args[argIndex] = sanitizeText(args[argIndex]); }
		return raw.apply(this, args);
	};
}

if (D) {
	// style.cursor = ... goes through Chromium's named-property interceptor on the instance;
	// it has no prototype setter to wrap. Those writes are caught by the attribute observer.
	patchSetter(D, 'cssText', function (v) { return typeof v === 'string' ? sanitizeText(v) : v; });
	if (rawSetProperty) {
		D.setProperty = function (name, value, priority) {
			if (typeof name === 'string' && typeof value === 'string' && (name === 'cursor' || (name.charCodeAt(0) === 45 && name.indexOf('cursor') >= 0))) {
				var s = sanitizeValue(value.trim());
				if (s !== undefined) { state.fixed++; value = s; }
			}
			return rawSetProperty.call(this, name, value, priority);
		};
	}
}
var E = w.Element && w.Element.prototype;
if (E && typeof E.setAttribute === 'function') {
	var rawSetAttribute = E.setAttribute;
	E.setAttribute = function (name, value) {
		if (name === 'style' && typeof value === 'string' && value.indexOf('ursor') >= 0) { value = sanitizeText(value); }
		return rawSetAttribute.call(this, name, value);
	};
}
if (E && typeof E.attachShadow === 'function') {
	var rawAttachShadow = E.attachShadow;
	E.attachShadow = function (init) {
		var root = rawAttachShadow.call(this, init);
		try { adoptRoot(root); } catch (e) { state.errors++; }
		return root;
	};
}
var S = w.CSSStyleSheet && w.CSSStyleSheet.prototype;
wrapTextArg(S, 'insertRule', 0);
wrapTextArg(S, 'replace', 0);
wrapTextArg(S, 'replaceSync', 0);
wrapTextArg(S, 'addRule', 1);
wrapTextArg(w.CSSGroupingRule && w.CSSGroupingRule.prototype, 'insertRule', 0);
function patchAdopted(proto) {
	if (!proto) { return; }
	patchSetter(proto, 'adoptedStyleSheets', function (v) {
		try { for (var i = 0; i < v.length; i++) { walkSheet(v[i], 0); } } catch (e) { state.errors++; }
		return v;
	});
}
patchAdopted(w.Document && w.Document.prototype);
patchAdopted(w.ShadowRoot && w.ShadowRoot.prototype);

adoptRoot(document);
state.ms = Date.now() - t0;
return 'installed fixed=' + state.fixed + ' ms=' + state.ms;
`;

export function buildCursorGuardScript(map: Readonly<Record<string, string>> = CURSOR_REPLACEMENTS): string {
	return `(function (MAP) {${PAGE_SCRIPT_BODY}})(${JSON.stringify(map)});`;
}

/**
 * Install the guard for every WebContents (windows, WebContentsViews, webviews, DevTools)
 * and every frame in them. Windows only. Returns whether it was installed.
 */
export function installCursorCrashGuard(logger: ICursorCrashGuardLogger): boolean {
	if (process.platform !== 'win32') {
		return false;
	}
	const mode = String(process.env['VSSAROS_CURSOR_GUARD'] ?? '').trim().toLowerCase();
	if (mode === '0' || mode === 'off' || mode === 'false') {
		logger.info('[CursorGuard] disabled by VSSAROS_CURSOR_GUARD=' + mode + ' (risky CSS cursors may crash the app when LoadCursor fails)');
		return false;
	}

	const script = buildCursorGuardScript();
	let reported = 0;

	const inject = (frame: WebFrameMain | null | undefined) => {
		if (!frame) {
			return;
		}
		try {
			if (frame.isDestroyed() || frame.detached) {
				return;
			}
		} catch {
			return;
		}
		let url = '';
		try { url = frame.url; } catch { /* frame went away */ }
		frame.executeJavaScript(script).then(result => {
			if (typeof result === 'string' && result.startsWith('installed')) {
				const line = `[CursorGuard] ${result} in ${url.slice(0, 120)}`;
				if (reported++ < 30) {
					logger.info(line);
				} else {
					logger.trace(line);
				}
			}
		}, () => { /* navigated away / sandboxed frame without scripts: nothing to guard */ });
	};

	app.on('web-contents-created', (_event, contents: WebContents) => {
		contents.on('frame-created', (_e, details) => {
			const frame = details.frame;
			if (frame) {
				frame.on('dom-ready', () => inject(frame));
			}
		});
		contents.on('dom-ready', () => {
			try { inject(contents.mainFrame); } catch { /* destroyed */ }
		});
		contents.on('did-frame-finish-load', (_e, _isMainFrame, frameProcessId, frameRoutingId) => {
			try { inject(webFrameMain.fromId(frameProcessId, frameRoutingId)); } catch { /* frame gone */ }
		});
	});

	logger.info('[CursorGuard] enabled: CSS cursors ' + Object.keys(CURSOR_REPLACEMENTS).join('/') + ' are rewritten to system cursors (avoids the 0xC000001D crash when Windows cannot load resource cursors). Opt-out: VSSAROS_CURSOR_GUARD=0');
	return true;
}
