/*---------------------------------------------------------------------------------------------
 *  ConfigHtml Canvas — in-iframe editable runtime injector
 *
 *  The `confightml` skill generates a *self-contained* single-page HTML document
 *  whose editable regions are marked with the frontend-slides-editable DOM
 *  contract (`data-edit-slot`, `[data-slide-object][data-oid]`,
 *  `<html data-template-edit-mode="slots|components">`) but WITHOUT any editor
 *  runtime. This module injects a compact, single-document-scoped editor runtime
 *  (edit toggle, drag/resize freeform objects, contenteditable slots, undo/redo,
 *  snap guides, save) into that HTML so it becomes browser-editable inside the
 *  sandboxed Canvas iframe.
 *
 *  Because the Canvas iframe runs with `sandbox="allow-scripts"` (opaque origin,
 *  no localStorage, no allow-same-origin), persistence flows OUT of the iframe
 *  via `window.parent.postMessage`. The parent (WorkspaceCanvas) listens for
 *  `{ source: 'confightml-editor', type: 'save', html }` and writes it back to
 *  disk through `configmd.writeSource`.
 *--------------------------------------------------------------------------------------------*/

/** Marker so the parent can distinguish messages coming from the injected runtime. */
export const CONFIGHTML_EDITOR_SOURCE = 'confightml-editor';

/** Sentinel that flags an HTML document as already runtime-injected. */
const RUNTIME_MARKER = '__CONFIGHTML_EDITOR_RUNTIME__';

/**
 * Why the injected runtime must carry the parent webview's CSP nonce.
 *
 * A `srcdoc` iframe INHERITS the embedding document's Content-Security-Policy,
 * and the browser ANDs every applicable policy together — the effective policy
 * is the *intersection*, so a child can only ever make the inherited policy
 * STRICTER, never looser. The Agent Studio webview ships a strict nonce-based
 * CSP (`script-src 'nonce-XXX'`, no `'unsafe-inline'`). Two consequences:
 *
 *  1. A plain inline `<script>` we inject is blocked (it has no nonce), so the
 *     editor runtime never boots — preview renders but shows NO toolbar and
 *     nothing is editable.
 *  2. Injecting a permissive `<meta>` CSP does NOT help and actively HURTS: the
 *     inherited `'nonce-XXX'` policy intersected with a meta `'unsafe-inline'`
 *     policy allows NEITHER our nonce'd script NOR an unsafe-inline one.
 *
 * The only correct fix is to stamp the SAME nonce the parent uses onto the
 * `<script>`/`<style>` tags we inject, so they satisfy the inherited policy.
 * The nonce is surfaced to the React layer as `window.__AGENT_STUDIO_CSP_NONCE__`
 * by the webview controller and threaded down to `injectEditorRuntime`.
 */

/**
 * Base document style injected so an AI-generated HTML renders IDENTICALLY to
 * the left-hand editor preview (HtmlPreviewEditorPane._wrapHtmlForWebview).
 *
 * MUST stay byte-for-byte in sync with that pane's `baseStyle`. Both paths
 * normalize margins/padding and give the document a default background, text
 * color and a modern sans-serif font stack — otherwise a document that omits
 * its own `body { font-family / background }` falls back to the iframe's raw
 * browser defaults (serif font, transparent background, 8px body margin) in
 * the Canvas while showing the styled defaults in the left pane, producing the
 * "renders differently in Canvas vs. editor" bug.
 *
 * This is injected as the FIRST style in <head> (before the document's own
 * <style>) so the document's authored styles still win — matching the pane.
 * It carries an id so `cleanedHtml()` can strip it on save (never persisted).
 */
const BASE_DOC_STYLE =
	'html,body{margin:0;padding:0;}' +
	'body{background:#ffffff;color:#1e1e1e;' +
	'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;}' +
	'@media (prefers-color-scheme: dark){body{background:#1e1e1e;color:#d4d4d4;}}';

/** id of the injected base-style tag (stripped on save). */
const BASE_STYLE_ID = 'che-base-style';

/** CSS for the editor chrome (toolbar, handles, selection, edit affordances). */
const RUNTIME_CSS = `
:root {
  --che-chrome-bg: rgba(28, 28, 32, 0.92);
  --che-chrome-border: rgba(255, 255, 255, 0.16);
  --che-chrome-text: #f2f2f5;
  --che-chrome-muted: rgba(242, 242, 245, 0.6);
  --che-chrome-accent: #4f9dff;
  --che-chrome-surface: rgba(255, 255, 255, 0.08);
  --che-chrome-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
}
/* Positioned at the top-RIGHT, pushed down below the React "Root (editable)"
   bar that floats above the iframe (.canvas-view-toggle, top:8px right:8px,
   ~36px tall). The two bars live in different documents (this toolbar is
   inside the srcdoc iframe; the Root bar is in the parent React layer), so we
   can't nest them — instead we align this one right and drop it just under the
   Root bar so it visually sits directly beneath it. */
#che-toolbar {
  position: fixed; top: 44px; right: 8px; left: auto; z-index: 2147483600;
  display: flex; align-items: center; gap: 4px;
  padding: 4px; border-radius: 10px;
  background: var(--che-chrome-bg);
  border: 1px solid var(--che-chrome-border);
  box-shadow: var(--che-chrome-shadow);
  font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--che-chrome-text);
  -webkit-user-select: none; user-select: none;
}
#che-toolbar button {
  appearance: none; border: 1px solid transparent; background: transparent;
  color: var(--che-chrome-text); cursor: pointer; border-radius: 7px;
  padding: 5px 10px; font-size: 12px; font-weight: 500; line-height: 1;
  display: inline-flex; align-items: center; gap: 5px;
}
#che-toolbar button:hover { background: var(--che-chrome-surface); }
#che-toolbar button.che-active { background: var(--che-chrome-accent); color: #fff; }
#che-toolbar button:disabled { opacity: 0.4; cursor: default; }
#che-toolbar button:disabled:hover { background: transparent; }
#che-toolbar .che-sep { width: 1px; height: 18px; background: var(--che-chrome-border); margin: 0 2px; }
#che-toolbar .che-hint { font-size: 11px; color: var(--che-chrome-muted); padding: 0 6px; max-width: 320px; }
#che-toolbar .che-dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: #ffb454; margin-left: 2px; display: none; }
body.che-dirty #che-toolbar .che-dirty-dot { display: inline-block; }

/* Edit-mode global cursor + disable native links/anchors so clicks select */
body.che-edit { cursor: default; }
body.che-edit a { pointer-events: auto; }

/* Hover highlight box (follows the element under the pointer in edit mode). */
#che-hover {
  position: fixed; z-index: 2147483200; pointer-events: none; display: none;
  border: 1px solid rgba(79, 157, 255, 0.7); border-radius: 2px;
  background: rgba(79, 157, 255, 0.06);
}
/* The element currently being edited as text. */
.che-text-editing {
  outline: 2px solid var(--che-chrome-accent) !important; outline-offset: 1px;
  cursor: text !important; min-height: 1em;
}

/* Floating selection overlay (single-select): tracks the selected element's
 * bounding box and carries the resize + delete affordances. Using a detached
 * overlay (instead of injecting handles into the target) keeps grid/flex
 * layouts intact and avoids polluting the saved HTML. */
#che-overlay {
  position: fixed; z-index: 2147483300; pointer-events: none; display: none;
  border: 2px solid var(--che-chrome-accent); border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.15);
}
#che-overlay .che-ov-resize {
  position: absolute; right: -7px; bottom: -7px; width: 13px; height: 13px;
  border-radius: 3px; background: var(--che-chrome-accent); border: 2px solid #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.4); cursor: nwse-resize; pointer-events: auto;
}
#che-overlay .che-ov-delete {
  position: absolute; top: -12px; right: -12px; width: 22px; height: 22px;
  border-radius: 50%; padding: 0; line-height: 18px; text-align: center;
  background: #e2503f; color: #fff; border: 2px solid #fff; cursor: pointer;
  font-size: 14px; font-weight: 700; pointer-events: auto;
}
#che-overlay .che-ov-move {
  position: absolute; top: -12px; left: -12px; width: 22px; height: 22px;
  border-radius: 50%; padding: 0; line-height: 18px; text-align: center;
  background: var(--che-chrome-accent); color: #fff; border: 2px solid #fff;
  cursor: move; font-size: 12px; pointer-events: auto;
}
/* Outline for additional (multi-select) elements. */
.che-multi-selected { outline: 2px dashed var(--che-chrome-accent) !important; outline-offset: 1px; }

/* Snap guides */
.che-guide { position: fixed; z-index: 2147482000; background: var(--che-chrome-accent); pointer-events: none; }
.che-guide.che-guide-v { width: 1px; top: 0; bottom: 0; }
.che-guide.che-guide-h { height: 1px; left: 0; right: 0; }

/* ── Rich-text format toolbar (drawer-style, ported from
   frontend-slides-editable's #rteToolbar). Shows whenever a text element is
   being edited inline (NOT only when a run is selected). Main row = B/I/U +
   "字体"/"字号"/"颜色" drawer triggers; clicking a trigger expands a card below
   with the detailed choices. Supports a COLLAPSED caret (apply style without
   pre-selecting text — wraps an invisible zero-width <span>). Applies styles by
   wrapping the range in <span style="…">. Lives in the chrome z-stack. */
#che-rte {
  position: fixed; z-index: 2147483550; display: none;
  flex-direction: column; align-items: stretch; gap: 0;
  min-width: 188px; max-width: min(320px, 92vw);
  padding: 6px; border-radius: 10px;
  background: var(--che-chrome-bg); border: 1px solid var(--che-chrome-border);
  box-shadow: var(--che-chrome-shadow); color: var(--che-chrome-text);
  font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-user-select: none; user-select: none;
}
#che-rte.che-rte-show { display: flex; }
#che-rte-main { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
#che-rte button {
  appearance: none; border: 1px solid var(--che-chrome-border);
  background: var(--che-chrome-surface); color: var(--che-chrome-text);
  cursor: pointer; border-radius: 6px; padding: 4px 8px; font-size: 12px;
  line-height: 1; display: inline-flex; align-items: center; justify-content: center;
}
#che-rte button:hover { border-color: var(--che-chrome-accent); }
#che-rte button.che-active { background: var(--che-chrome-accent); color: #fff; border-color: var(--che-chrome-accent); }
#che-rte .che-rte-b { font-weight: 700; }
#che-rte .che-rte-i { font-style: italic; font-family: Georgia, serif; }
#che-rte .che-rte-u { text-decoration: underline; }
#che-rte .che-rte-trigger { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
#che-rte .che-rte-trigger.is-open {
  background: var(--che-chrome-accent); color: #fff; border-color: var(--che-chrome-accent);
}
#che-rte-panels { display: flex; flex-direction: column; gap: 0; }
#che-rte .che-rte-card {
  margin-top: 6px; padding: 8px; border-radius: 8px;
  border: 1px solid var(--che-chrome-border); background: var(--che-chrome-surface);
}
#che-rte .che-rte-card[hidden] { display: none !important; }
#che-rte .che-rte-card-inner { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
#che-rte .che-rte-card-inner.che-rte-card-font { grid-template-columns: repeat(2, minmax(0, 1fr)); }
#che-rte .che-rte-card-inner button { padding: 6px 6px; font-size: 11px; }
#che-rte .che-rte-meta {
  grid-column: 1 / -1; margin-bottom: 2px; font-size: 10px;
  color: var(--che-chrome-text); opacity: 0.6; text-transform: uppercase; letter-spacing: 0.06em;
}
#che-rte .che-rte-px-custom {
  grid-column: 1 / -1; display: none; flex-wrap: wrap; align-items: center; gap: 6px;
  margin-top: 4px; padding-top: 6px; border-top: 1px solid var(--che-chrome-border);
}
#che-rte .che-rte-px-custom.is-open { display: flex; }
#che-rte .che-rte-px-custom input[type="number"] {
  width: 4.5rem; padding: 4px 6px; border-radius: 6px; font-size: 12px;
  border: 1px solid var(--che-chrome-border); background: var(--che-chrome-bg); color: var(--che-chrome-text);
}
/* Color drawer: swatches grid + native picker */
#che-rte .che-rte-card-color { grid-template-columns: repeat(6, minmax(0, 1fr)); }
#che-rte .che-rte-swatch {
  width: 100%; height: 22px; padding: 0; border-radius: 5px; cursor: pointer;
  border: 1px solid rgba(128,128,128,0.35);
}
#che-rte .che-rte-color-pick {
  grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; margin-top: 4px;
  padding-top: 6px; border-top: 1px solid var(--che-chrome-border);
}
#che-rte .che-rte-color-pick input[type="color"] {
  width: 28px; height: 24px; padding: 0; border: 1px solid var(--che-chrome-border);
  border-radius: 5px; background: var(--che-chrome-bg); cursor: pointer;
}

@media print { #che-toolbar, #che-overlay, #che-hover, .che-guide, #che-rte { display: none !important; } }
`;

/**
 * Runtime JS injected into the iframe. This is a MARKER-FREE, universal editor:
 * unlike the frontend-slides-editable runtime (which only edits elements tagged
 * with `[data-slide-object]` / `[data-edit-slot]`), this version lets the user
 * edit ANY element in an arbitrary AI-generated document. That is essential
 * because the model does not reliably emit the editable-contract markers, so a
 * marker-dependent editor finds nothing to edit (symptom: toolbar shows but
 * clicking 编辑 does nothing).
 *
 * Mechanics (ported from the reference runtime, adapted to be marker-free):
 *  - Click any element to select it (floating overlay shows resize + delete).
 *  - Drag to move via `transform: translate(...)` — this keeps the element in
 *    normal flow so siblings do NOT reflow (critical for grid/flex dashboards;
 *    absolute-positioning would collapse the layout).
 *  - Drag the corner handle to resize (width/height in px).
 *  - Double-click to edit text in place (contenteditable).
 *  - Delete / Backspace (or the × handle) removes the element.
 *  - Ctrl/Cmd+click multi-selects; snap guides align to parent center + siblings.
 *  - Full undo/redo (move/resize/text/delete). Ctrl+S posts the cleaned HTML to
 *    the parent (WorkspaceCanvas) which writes it back to config.html.
 *
 * Elements are identified by a lazily-assigned internal `data-che-id` attribute
 * (stripped on save). Movement is stored as our own appended `translate(...)`
 * on top of any pre-existing inline transform (preserved via `data-che-basetf`).
 */
const RUNTIME_JS = `
(function () {
  if (window.${RUNTIME_MARKER}) { return; }
  window.${RUNTIME_MARKER} = true;

  var SOURCE = ${JSON.stringify(CONFIGHTML_EDITOR_SOURCE)};
  var SNAP_PX = 7;
  var DRAG_THRESHOLD = 3;
  var editMode = false;
  var dirty = false;
  var selection = [];          // array of selected elements (multi-select)
  var primaryEl = null;        // single element the overlay tracks
  var idCounter = 0;

  // ── Element identity (internal, stripped on save) ────────────────
  function cheId(el) {
    if (!el.getAttribute('data-che-id')) el.setAttribute('data-che-id', 'c' + (idCounter++));
    return el.getAttribute('data-che-id');
  }
  function byId(id) { return document.querySelector('[data-che-id="' + cssEsc(id) + '"]'); }
  function cssEsc(s) { return String(s).replace(/["\\\\]/g, '\\\\$&'); }

  // ── Transform-based translate (keeps element in flow) ────────────
  function baseTransform(el) {
    if (el.hasAttribute('data-che-basetf')) return el.getAttribute('data-che-basetf');
    // Capture any pre-existing INLINE transform once (CSS-class transforms are
    // left alone; our translate composes after them at runtime).
    var inline = el.style.transform || '';
    // Strip any translate we might have added before (defensive).
    var base = inline.replace(/translate\\([^)]*\\)/g, '').trim();
    el.setAttribute('data-che-basetf', base);
    return base;
  }
  function getOffset(el) {
    var tx = parseFloat(el.getAttribute('data-che-tx') || '0') || 0;
    var ty = parseFloat(el.getAttribute('data-che-ty') || '0') || 0;
    return { x: tx, y: ty };
  }
  function setOffset(el, x, y) {
    el.setAttribute('data-che-tx', String(x));
    el.setAttribute('data-che-ty', String(y));
    var base = baseTransform(el);
    el.style.transform = (base ? base + ' ' : '') + 'translate(' + x + 'px,' + y + 'px)';
  }

  // ── History stack ────────────────────────────────────────────────
  var undoStack = [], redoStack = [];
  function pushHistory(cmd) { undoStack.push(cmd); redoStack.length = 0; syncButtons(); markDirty(); }
  function applyInverse(cmd, redo) {
    var el = byId(cmd.id);
    if (cmd.type === 'move') {
      if (!el) return; var v = redo ? cmd.after : cmd.before; setOffset(el, v.x, v.y);
    } else if (cmd.type === 'resize') {
      if (!el) return; var v2 = redo ? cmd.after : cmd.before;
      el.style.width = v2.width; el.style.height = v2.height;
    } else if (cmd.type === 'text') {
      if (!el) return; el.innerHTML = redo ? cmd.after : cmd.before;
    } else if (cmd.type === 'delete') {
      if (redo) { var n = byId(cmd.id); if (n) n.remove(); }
      else {
        var parent = cmd.parent && document.querySelector(cmd.parent);
        if (parent) {
          var tmp = document.createElement('div'); tmp.innerHTML = cmd.outerHTML;
          var node = tmp.firstElementChild;
          if (node) parent.insertBefore(node, parent.children[cmd.index] || null);
        }
      }
    }
    repositionOverlay();
  }
  function undo() { var c = undoStack.pop(); if (!c) return; applyInverse(c, false); redoStack.push(c); clearSelection(); syncButtons(); markDirty(); }
  function redo() { var c = redoStack.pop(); if (!c) return; applyInverse(c, true); undoStack.push(c); clearSelection(); syncButtons(); markDirty(); }

  // ── Dirty tracking ───────────────────────────────────────────────
  function markDirty() {
    if (!dirty) { dirty = true; document.body.classList.add('che-dirty'); }
    post('dirty', { dirty: true });
  }
  function clearDirty() { dirty = false; document.body.classList.remove('che-dirty'); post('dirty', { dirty: false }); }
  function post(type, extra) {
    try { window.parent.postMessage(Object.assign({ source: SOURCE, type: type }, extra || {}), '*'); } catch (e) {}
  }

  // ── Chrome refs ──────────────────────────────────────────────────
  var overlay, ovResize, ovDelete, hoverBox;
  // Rich-text format bar refs + last good selection range (see RTE section).
  var rteBar, rteBtnB, rteBtnI, rteBtnU, rteColorInput;
  // Stashed selection (captured on pointerdown over the bar so a focus-stealing
  // control — number/color input — can restore it) + which drawer is open.
  var rteFormatStash = null;
  var rteOpenDrawer = null;
  function isChrome(node) {
    return node && node.closest && node.closest('#che-toolbar, #che-overlay, #che-hover, .che-guide, #che-rte');
  }

  // ── Selection ────────────────────────────────────────────────────
  function clearSelection() {
    selection.forEach(function (o) { o.classList.remove('che-multi-selected'); });
    selection = []; primaryEl = null; hideOverlay();
  }
  function selectElement(el, additive) {
    if (!el || el === document.body || el === document.documentElement || isChrome(el)) { return; }
    cheId(el);
    if (additive) {
      var i = selection.indexOf(el);
      if (i >= 0) { selection.splice(i, 1); el.classList.remove('che-multi-selected'); }
      else { selection.push(el); el.classList.add('che-multi-selected'); }
      primaryEl = selection[selection.length - 1] || null;
    } else {
      clearSelection();
      selection = [el]; primaryEl = el;
    }
    // single-select shows the full overlay; multi just outlines
    if (selection.length === 1) {
      el.classList.remove('che-multi-selected');
      showOverlay(el);
    } else {
      selection.forEach(function (o) { o.classList.add('che-multi-selected'); });
      hideOverlay();
    }
  }

  // ── Floating overlay (single-select handles) ─────────────────────
  function showOverlay(el) { primaryEl = el; overlay.style.display = 'block'; repositionOverlay(); }
  function hideOverlay() { if (overlay) overlay.style.display = 'none'; }
  function repositionOverlay() {
    if (!primaryEl || !overlay || overlay.style.display === 'none') return;
    if (!primaryEl.isConnected) { hideOverlay(); return; }
    var r = primaryEl.getBoundingClientRect();
    overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
  }

  // ── Pointer: select / drag-move / resize ─────────────────────────
  var dragState = null;
  function onPointerDown(e) {
    if (!editMode) return;
    var t = e.target;
    if (t.closest && t.closest('#che-toolbar, #che-rte')) return;
    // Resize handle?
    if (t === ovResize) {
      if (!primaryEl) return;
      e.preventDefault();
      var rr = primaryEl.getBoundingClientRect();
      dragState = { mode: 'resize', el: primaryEl, startX: e.clientX, startY: e.clientY,
        startW: rr.width, startH: rr.height, before: { width: primaryEl.style.width, height: primaryEl.style.height } };
      bindMove(); return;
    }
    if (t === ovDelete) { return; } // handled on click
    // Don't start drag while editing text inside the same element.
    if (t.isContentEditable || (t.closest && t.closest('.che-text-editing'))) return;

    var el = pickTarget(t);
    if (!el) { clearSelection(); return; }
    e.preventDefault();
    var additive = e.ctrlKey || e.metaKey;
    // If clicking an already-selected (primary) element without modifier, keep
    // selection and arm a drag; otherwise (re)select.
    if (!additive && selection.indexOf(el) === -1) { selectElement(el, false); }
    else if (additive) { selectElement(el, true); }

    // Arm move-drag for current selection (px translate offsets).
    var movable = selection.length ? selection : [el];
    var entries = movable.map(function (o) {
      cheId(o); var off = getOffset(o);
      return { id: o.getAttribute('data-che-id'), el: o, x0: off.x, y0: off.y, rect: o.getBoundingClientRect() };
    });
    dragState = { mode: 'pending', startX: e.clientX, startY: e.clientY, entries: entries, primaryRect: (primaryEl || el).getBoundingClientRect() };
    bindMove();
  }
  function bindMove() {
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
  }
  function pickTarget(node) {
    // Skip text nodes / chrome; never select html/body.
    var el = node;
    while (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || isChrome(el)) return null;
    if (el === document.body || el === document.documentElement) return null;
    return el;
  }

  function onPointerMove(e) {
    if (!dragState) return;
    var dx = e.clientX - dragState.startX, dy = e.clientY - dragState.startY;
    if (dragState.mode === 'pending') {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      dragState.mode = 'move';
    }
    if (dragState.mode === 'move') {
      var snapped = computeSnap(dragState.primaryRect, dx, dy);
      dx = snapped.dx; dy = snapped.dy;
      dragState.entries.forEach(function (en) { setOffset(en.el, en.x0 + dx, en.y0 + dy); });
      repositionOverlay();
    } else if (dragState.mode === 'resize') {
      var w = Math.max(20, dragState.startW + dx);
      var h = Math.max(14, dragState.startH + dy);
      dragState.el.style.width = w + 'px';
      dragState.el.style.height = h + 'px';
      repositionOverlay();
    }
  }
  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    hideGuides();
    if (!dragState) return;
    if (dragState.mode === 'move') {
      dragState.entries.forEach(function (en) {
        var off = getOffset(en.el);
        if (off.x !== en.x0 || off.y !== en.y0) {
          pushHistory({ type: 'move', id: en.id, before: { x: en.x0, y: en.y0 }, after: { x: off.x, y: off.y } });
        }
      });
    } else if (dragState.mode === 'resize') {
      var after = { width: dragState.el.style.width, height: dragState.el.style.height };
      var b = dragState.before;
      if (after.width !== b.width || after.height !== b.height) {
        pushHistory({ type: 'resize', id: dragState.el.getAttribute('data-che-id'), before: b, after: after });
      }
    }
    dragState = null;
  }

  // ── Snap guides (parent center + sibling edges) ──────────────────
  var guides = [];
  function hideGuides() { guides.forEach(function (g) { g.remove(); }); guides = []; }
  function computeSnap(rect, dx, dy) {
    hideGuides();
    if (!rect) return { dx: dx, dy: dy };
    var newLeft = rect.left + dx, newTop = rect.top + dy, w = rect.width, h = rect.height;
    var parent = primaryEl && primaryEl.parentElement ? primaryEl.parentElement.getBoundingClientRect() : null;
    var targetsX = [], targetsY = [];
    if (parent) { targetsX.push(parent.left + parent.width / 2); targetsY.push(parent.top + parent.height / 2); }
    // Sibling edges (limit scan for perf).
    var sibs = primaryEl && primaryEl.parentElement ? primaryEl.parentElement.children : [];
    for (var i = 0; i < sibs.length && i < 60; i++) {
      var s = sibs[i]; if (s === primaryEl || selection.indexOf(s) !== -1 || isChrome(s)) continue;
      var br = s.getBoundingClientRect();
      targetsX.push(br.left, br.left + br.width / 2, br.left + br.width);
      targetsY.push(br.top, br.top + br.height / 2, br.top + br.height);
    }
    var sx = trySnap([newLeft, newLeft + w / 2, newLeft + w], targetsX);
    var sy = trySnap([newTop, newTop + h / 2, newTop + h], targetsY);
    if (sx != null) { dx += sx.delta; drawGuide('v', sx.target); }
    if (sy != null) { dy += sy.delta; drawGuide('h', sy.target); }
    return { dx: dx, dy: dy };
  }
  function trySnap(edges, targets) {
    var best = null;
    edges.forEach(function (edge) {
      targets.forEach(function (t) {
        var d = t - edge;
        if (Math.abs(d) <= SNAP_PX && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, target: t };
      });
    });
    return best;
  }
  function drawGuide(dir, pos) {
    var g = document.createElement('div');
    g.className = 'che-guide che-guide-' + dir;
    if (dir === 'v') g.style.left = pos + 'px'; else g.style.top = pos + 'px';
    document.body.appendChild(g); guides.push(g);
  }

  // ── Hover highlight ──────────────────────────────────────────────
  function onPointerOver(e) {
    if (!editMode || dragState) { if (hoverBox) hoverBox.style.display = 'none'; return; }
    var el = pickTarget(e.target);
    if (!el || selection.indexOf(el) !== -1) { hoverBox.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.left = r.left + 'px'; hoverBox.style.top = r.top + 'px';
    hoverBox.style.width = r.width + 'px'; hoverBox.style.height = r.height + 'px';
  }
  function onPointerOut() { if (hoverBox) hoverBox.style.display = 'none'; }

  // ── Delete ───────────────────────────────────────────────────────
  function onClick(e) {
    if (!editMode) return;
    if (e.target === ovDelete) {
      e.preventDefault();
      if (primaryEl) deleteElement(primaryEl);
      return;
    }
    // Suppress native link navigation while editing.
    var a = e.target.closest && e.target.closest('a');
    if (a) { e.preventDefault(); }
  }
  function deleteElement(el) {
    if (!el || !el.parentElement) return;
    var parent = el.parentElement;
    var index = Array.prototype.indexOf.call(parent.children, el);
    cheId(el);
    pushHistory({ type: 'delete', id: el.getAttribute('data-che-id'), parent: cssPath(parent), index: index, outerHTML: el.outerHTML });
    selection = selection.filter(function (s) { return s !== el; });
    if (primaryEl === el) { primaryEl = null; hideOverlay(); }
    el.remove();
  }
  function cssPath(el) {
    if (el === document.body) return 'body';
    if (el.id) return '#' + cssEsc(el.id);
    var path = [], node = el;
    while (node && node !== document.body && node.parentElement) {
      var idx = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
      path.unshift(node.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      node = node.parentElement;
    }
    return 'body > ' + path.join(' > ');
  }

  // ── Text editing (double-click any element) ──────────────────────
  var textEditState = null;
  function beginTextEdit(el) {
    if (!el || el === document.body) return;
    endTextEdit();
    cheId(el);
    textEditState = { el: el, before: el.innerHTML };
    rtePendingBefore = null;
    el.setAttribute('contenteditable', 'true');
    el.classList.add('che-text-editing');
    el.focus();
    // place caret where possible
    try {
      var sel = window.getSelection();
      if (sel && sel.rangeCount === 0) { var rng = document.createRange(); rng.selectNodeContents(el); rng.collapse(false); sel.addRange(rng); }
    } catch (err) {}
    // Refresh toolbar state. On entering edit the caret is collapsed, so the
    // bar stays hidden — it only appears once the user actually selects text.
    updateRteToolbar();
  }
  function endTextEdit() {
    if (!textEditState) return;
    var el = textEditState.el;
    el.removeAttribute('contenteditable');
    el.classList.remove('che-text-editing');
    var after = el.innerHTML;
    if (after !== textEditState.before) {
      pushHistory({ type: 'text', id: el.getAttribute('data-che-id'), before: textEditState.before, after: after });
    }
    // Close the rich-text history session: any further edit on the same element
    // starts a NEW undo entry instead of mutating this one.
    var top = undoStack[undoStack.length - 1];
    if (top && top._rteSession) { top._rteSession = false; }
    rtePendingBefore = null;
    textEditState = null;
    hideRteBar();
    repositionOverlay();
  }
  function onDblClick(e) {
    if (!editMode) return;
    var el = pickTarget(e.target);
    if (!el) return;
    e.preventDefault();
    selectElement(el, false);
    beginTextEdit(el);
  }

  // ── Rich-text format bar (font-size / color / font-family / B,I,U) ──
  //
  // While editing text inline (contenteditable), selecting a run of characters
  // pops a small floating bar above the selection. Bold/italic/underline use
  // execCommand (it already wraps/unwraps cleanly); font-size/color/family use
  // a Range+<span style> wrap (execCommand('fontSize') only supports the legacy
  // 1-7 scale, so we apply CSS directly — ported from the reference runtime's
  // _applyInlineStyle). Every change re-snapshots the editing element's
  // innerHTML into ONE pending text-history entry so undo/redo stays coherent.
  var rtePendingBefore = null; // innerHTML snapshot when the current edit began

  var RTE_FONTS = [
    { label: '默认', value: '' },
    { label: '无衬线', value: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif' },
    { label: '衬线', value: 'Georgia,"Times New Roman","Songti SC",serif' },
    { label: '等宽', value: '"SF Mono","Cascadia Code",Consolas,"Courier New",monospace' },
    { label: '楷体', value: '"Kaiti SC","STKaiti",KaiTi,serif' },
    { label: '黑体', value: '"Heiti SC","PingFang SC","Microsoft YaHei",sans-serif' }
  ];
  var RTE_SIZES = ['12', '14', '16', '18', '20', '24', '28', '32', '40', '48', '64', '96'];
  var RTE_SWATCHES = ['#1e1e1e', '#ffffff', '#e2503f', '#e8833a', '#f5b400', '#3aa15a',
    '#2f80ed', '#7b5bd6', '#d6457b', '#888888', '#c0392b', '#16a085'];

  // Build the drawer-style toolbar: main row (B/I/U + 字体/字号/颜色 triggers) +
  // a panels column where each trigger expands a card with the choices.
  function buildRteBar() {
    rteBar = document.createElement('div'); rteBar.id = 'che-rte';

    var main = document.createElement('div'); main.id = 'che-rte-main';
    rteBtnB = mkRteBtn('che-rte-b', 'B', '加粗 (Ctrl+B)', function () { execInline('bold'); });
    rteBtnI = mkRteBtn('che-rte-i', 'I', '斜体 (Ctrl+I)', function () { execInline('italic'); });
    rteBtnU = mkRteBtn('che-rte-u', 'U', '下划线 (Ctrl+U)', function () { execInline('underline'); });
    var trgFont = mkTrigger('font', '字体');
    var trgSize = mkTrigger('size', '字号');
    var trgColor = mkTrigger('color', '颜色');
    main.appendChild(rteBtnB); main.appendChild(rteBtnI); main.appendChild(rteBtnU);
    main.appendChild(trgFont); main.appendChild(trgSize); main.appendChild(trgColor);
    rteBar.appendChild(main);

    var panels = document.createElement('div'); panels.id = 'che-rte-panels';

    // Font drawer
    var cardFont = mkCard('font');
    var innerFont = document.createElement('div'); innerFont.className = 'che-rte-card-inner che-rte-card-font';
    innerFont.appendChild(mkMeta('字体'));
    RTE_FONTS.forEach(function (f) {
      innerFont.appendChild(mkChoice(f.label, function () { applyInlineStyle({ fontFamily: f.value }); }));
    });
    cardFont.appendChild(innerFont); panels.appendChild(cardFont);

    // Size drawer
    var cardSize = mkCard('size');
    var innerSize = document.createElement('div'); innerSize.className = 'che-rte-card-inner';
    innerSize.appendChild(mkMeta('字号 (px)'));
    RTE_SIZES.forEach(function (s) {
      innerSize.appendChild(mkChoice(s, function () { applyInlineStyle({ fontSize: s + 'px' }); }));
    });
    // Custom px row
    var customWrap = document.createElement('div'); customWrap.className = 'che-rte-px-custom';
    var customInput = document.createElement('input');
    customInput.type = 'number'; customInput.min = '8'; customInput.max = '400'; customInput.step = '1';
    customInput.placeholder = '8–400'; customInput.setAttribute('inputmode', 'numeric');
    var customApply = mkChoice('应用', function () {
      var n = Math.round(Number(customInput.value));
      if (isFinite(n) && n >= 8 && n <= 400) applyInlineStyle({ fontSize: n + 'px' });
    });
    customInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); customApply.click(); }
    });
    var customBtn = mkChoice('自定义…', function () { customWrap.classList.toggle('is-open'); if (customWrap.classList.contains('is-open')) customInput.focus(); });
    innerSize.appendChild(customBtn);
    customWrap.appendChild(customInput); customWrap.appendChild(customApply);
    innerSize.appendChild(customWrap);
    cardSize.appendChild(innerSize); panels.appendChild(cardSize);

    // Color drawer
    var cardColor = mkCard('color');
    var innerColor = document.createElement('div'); innerColor.className = 'che-rte-card-inner che-rte-card-color';
    innerColor.appendChild(mkMeta('文字颜色'));
    RTE_SWATCHES.forEach(function (c) {
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'che-rte-swatch'; b.style.background = c; b.title = c;
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); applyInlineStyle({ color: c }); });
      innerColor.appendChild(b);
    });
    var pick = document.createElement('div'); pick.className = 'che-rte-color-pick';
    var pickLabel = mkMeta('自定义'); pickLabel.style.gridColumn = 'auto'; pickLabel.style.margin = '0';
    rteColorInput = document.createElement('input'); rteColorInput.type = 'color'; rteColorInput.value = '#e2503f';
    rteColorInput.addEventListener('input', function () { applyInlineStyle({ color: rteColorInput.value }); });
    pick.appendChild(pickLabel); pick.appendChild(rteColorInput);
    innerColor.appendChild(pick);
    cardColor.appendChild(innerColor); panels.appendChild(cardColor);

    rteBar.appendChild(panels);
    document.body.appendChild(rteBar);
  }
  function mkRteBtn(cls, label, title, fn) {
    var b = document.createElement('button'); b.type = 'button';
    b.className = cls; b.textContent = label; b.title = title;
    // mousedown + preventDefault: act BEFORE the contenteditable blurs so the
    // caret/selection stays alive.
    b.addEventListener('mousedown', function (ev) { ev.preventDefault(); fn(); });
    return b;
  }
  function mkTrigger(drawer, label) {
    var b = document.createElement('button'); b.type = 'button';
    b.className = 'che-rte-trigger'; b.textContent = label;
    b.setAttribute('data-rte-drawer', drawer);
    b.addEventListener('mousedown', function (ev) { ev.preventDefault(); toggleRteDrawer(drawer); });
    return b;
  }
  function mkCard(drawer) {
    var c = document.createElement('div'); c.className = 'che-rte-card';
    c.setAttribute('data-rte-panel', drawer); c.hidden = true;
    return c;
  }
  function mkMeta(text) { var s = document.createElement('span'); s.className = 'che-rte-meta'; s.textContent = text; return s; }
  function mkChoice(label, fn) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('mousedown', function (ev) { ev.preventDefault(); fn(); });
    return b;
  }

  // Open/close one drawer card (accordion: opening one closes the others).
  function toggleRteDrawer(drawer) {
    var willOpen = rteOpenDrawer !== drawer;
    rteOpenDrawer = willOpen ? drawer : null;
    if (!rteBar) return;
    rteBar.querySelectorAll('.che-rte-card').forEach(function (c) {
      c.hidden = c.getAttribute('data-rte-panel') !== rteOpenDrawer;
    });
    rteBar.querySelectorAll('.che-rte-trigger').forEach(function (t) {
      t.classList.toggle('is-open', t.getAttribute('data-rte-drawer') === rteOpenDrawer);
    });
    positionRteBar();
  }
  function closeRteDrawers() {
    rteOpenDrawer = null;
    if (!rteBar) return;
    rteBar.querySelectorAll('.che-rte-card').forEach(function (c) { c.hidden = true; });
    rteBar.querySelectorAll('.che-rte-trigger').forEach(function (t) { t.classList.remove('is-open'); });
  }

  // Stash the caret/selection while it still lives in the editable element, so a
  // focus-stealing control (number/color input) can restore it before applying.
  // Bound at document level on pointerdown (capture) — see boot().
  function rtePointerStash(e) {
    if (!editMode || !textEditState || !e.target || !e.target.closest) return;
    if (!e.target.closest('#che-rte')) return;
    stashRteSelection();
  }
  function stashRteSelection() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var r = sel.getRangeAt(0);
    if (textEditState && textEditState.el.contains(r.commonAncestorContainer)) {
      try { rteFormatStash = r.cloneRange(); } catch (_) { rteFormatStash = null; }
    }
  }
  function restoreRteSelection() {
    if (!rteFormatStash || !textEditState) return false;
    try {
      textEditState.el.focus();
      var sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(rteFormatStash);
      return true;
    } catch (_) { return false; }
  }

  // Wrap the current selection in <span style=…> applying the CSS patch. Works
  // even with a COLLAPSED caret: inserts an invisible zero-width span so the
  // next typed characters inherit the style (ported from reference runtime).
  function applyInlineStyle(patch) {
    if (!textEditState) return;
    var host = textEditState.el;
    restoreRteSelection();
    host.focus();
    var sel = window.getSelection();
    var range;
    if (!sel) return;
    if (!sel.rangeCount) {
      range = document.createRange(); range.selectNodeContents(host); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
    } else {
      range = sel.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) {
        range = document.createRange(); range.selectNodeContents(host); range.collapse(false);
        sel.removeAllRanges(); sel.addRange(range);
      }
    }
    var span = document.createElement('span');
    Object.keys(patch).forEach(function (k) { span.style[k] = patch[k]; });
    try {
      if (range.collapsed) {
        span.appendChild(document.createTextNode('\\u200b'));
        range.insertNode(span);
        var cr = document.createRange();
        cr.setStart(span.firstChild, 1); cr.collapse(true);
        sel.removeAllRanges(); sel.addRange(cr);
      } else {
        var contents = range.extractContents();
        span.appendChild(contents);
        range.insertNode(span);
        var nr = document.createRange(); nr.selectNodeContents(span);
        sel.removeAllRanges(); sel.addRange(nr);
        rteFormatStash = nr.cloneRange();
      }
    } catch (err) { return; }
    host.normalize();
    commitTextSnapshot(host);
    positionRteBar();
    syncRteState();
  }
  // execCommand path for bold/italic/underline (toggles cleanly).
  function execInline(cmd) {
    if (!textEditState) return;
    var host = textEditState.el;
    restoreRteSelection();
    host.focus();
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    if (!host.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
    try { document.execCommand('styleWithCSS', false, 'true'); } catch (e) {}
    try { document.execCommand(cmd, false, null); } catch (e2) { return; }
    stashRteSelection();
    commitTextSnapshot(host);
    syncRteState();
  }
  // Fold the latest innerHTML into the single pending text-history entry so the
  // whole inline-editing session (typing + formatting) is ONE undo step until
  // the user leaves the element.
  function commitTextSnapshot(host) {
    if (!textEditState) return;
    cheId(host);
    var id = host.getAttribute('data-che-id');
    var before = rtePendingBefore != null ? rtePendingBefore : textEditState.before;
    var top = undoStack[undoStack.length - 1];
    if (top && top.type === 'text' && top.id === id && top._rteSession) {
      top.after = host.innerHTML;
    } else {
      pushHistory({ type: 'text', id: id, before: before, after: host.innerHTML, _rteSession: true });
    }
    rtePendingBefore = before;
    textEditState.before = host.innerHTML;
  }

  // Reflect the selection's current bold/italic/underline into the bar.
  function syncRteState() {
    if (!rteBar) return;
    try {
      if (rteBtnB) rteBtnB.classList.toggle('che-active', document.queryCommandState('bold'));
      if (rteBtnI) rteBtnI.classList.toggle('che-active', document.queryCommandState('italic'));
      if (rteBtnU) rteBtnU.classList.toggle('che-active', document.queryCommandState('underline'));
    } catch (e) {}
  }

  function positionRteBar() {
    if (!rteBar || !textEditState) return;
    rteBar.classList.add('che-rte-show');
    var sel = window.getSelection();
    var rect = textEditState.el.getBoundingClientRect();
    if (sel && sel.rangeCount) {
      var r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && r.width > 1 && r.height > 1) rect = r;
    }
    var bw = rteBar.offsetWidth || 200, bh = rteBar.offsetHeight || 34;
    var vw = window.innerWidth, vh = window.innerHeight;
    var left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(6, Math.min(left, vw - bw - 6));
    var top = rect.top - bh - 8;
    if (top < 6) top = Math.min(rect.bottom + 8, vh - bh - 6); // flip below if no room above
    rteBar.style.left = left + 'px';
    rteBar.style.top = top + 'px';
  }
  function hideRteBar() { if (rteBar) rteBar.classList.remove('che-rte-show'); closeRteDrawers(); rteFormatStash = null; }

  // Driven by selectionchange (bound in boot): the toolbar is shown ONLY when
  // there is a real (non-collapsed) text selection inside the element being
  // edited. Merely placing/picking the caret (collapsed selection) hides it —
  // the bar appears once the user actually selects text, and disappears again
  // when the selection collapses.
  function updateRteToolbar() {
    if (!editMode || !textEditState) { hideRteBar(); return; }
    // If a toolbar control itself holds focus (color/number input steals focus
    // and collapses the document selection), keep the bar open — the stashed
    // selection is what the format will apply to.
    var ae = document.activeElement;
    if (rteBar && ae && rteBar.contains(ae)) { return; }
    var sel = window.getSelection();
    var hasTextSelection = !!(sel && sel.rangeCount && !sel.isCollapsed &&
      textEditState.el.contains(sel.getRangeAt(0).commonAncestorContainer));
    if (!hasTextSelection) { hideRteBar(); return; }
    // Keep the stash fresh while a real selection is active.
    stashRteSelection();
    positionRteBar();
    syncRteState();
  }
  function onSelectionChange() { updateRteToolbar(); }

  // ── Toolbar ──────────────────────────────────────────────────────
  var btnEdit, btnUndo, btnRedo, hint;
  function buildChrome() {
    var bar = document.createElement('div'); bar.id = 'che-toolbar';
    btnEdit = mkBtn('\\u270e 编辑', toggleEdit);
    var sep1 = sep();
    btnUndo = mkBtn('\\u21b6', undo); btnUndo.title = '撤销 (Ctrl+Z)';
    btnRedo = mkBtn('\\u21b7', redo); btnRedo.title = '重做 (Ctrl+Y)';
    var sep2 = sep();
    var btnSave = mkBtn('\\u2913 保存', save); btnSave.title = '保存 (Ctrl+S)';
    var dot = document.createElement('span'); dot.className = 'che-dirty-dot';
    hint = document.createElement('span'); hint.className = 'che-hint';
    hint.textContent = '点击选中 · 拖动移动 · 双击改文字 · 选中文字调格式 · Del 删除';
    hint.style.display = 'none';
    bar.appendChild(btnEdit); bar.appendChild(sep1);
    bar.appendChild(btnUndo); bar.appendChild(btnRedo); bar.appendChild(sep2);
    bar.appendChild(btnSave); bar.appendChild(dot); bar.appendChild(hint);
    document.body.appendChild(bar);

    // Floating selection overlay.
    overlay = document.createElement('div'); overlay.id = 'che-overlay';
    ovResize = document.createElement('div'); ovResize.className = 'che-ov-resize';
    ovDelete = document.createElement('button'); ovDelete.type = 'button'; ovDelete.className = 'che-ov-delete'; ovDelete.textContent = '\\u00d7'; ovDelete.title = '删除';
    overlay.appendChild(ovResize); overlay.appendChild(ovDelete);
    document.body.appendChild(overlay);

    // Hover highlight box.
    hoverBox = document.createElement('div'); hoverBox.id = 'che-hover';
    document.body.appendChild(hoverBox);

    // Rich-text selection format bar.
    buildRteBar();

    syncButtons();
  }
  function mkBtn(label, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); return b; }
  function sep() { var s = document.createElement('span'); s.className = 'che-sep'; return s; }
  function syncButtons() {
    if (btnUndo) btnUndo.disabled = undoStack.length === 0;
    if (btnRedo) btnRedo.disabled = redoStack.length === 0;
    if (btnEdit) btnEdit.classList.toggle('che-active', editMode);
  }

  function toggleEdit() {
    editMode = !editMode;
    document.body.classList.toggle('che-edit', editMode);
    if (!editMode) { endTextEdit(); clearSelection(); if (hoverBox) hoverBox.style.display = 'none'; hideRteBar(); }
    btnEdit.textContent = editMode ? '\\u2713 完成' : '\\u270e 编辑';
    if (hint) hint.style.display = editMode ? 'inline' : 'none';
    syncButtons();
  }

  // ── Serialize + save ─────────────────────────────────────────────
  function cleanedHtml() {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('#che-toolbar, #che-overlay, #che-hover, #che-rte, .che-guide, #che-runtime-style, #che-runtime-script, #${BASE_STYLE_ID}').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('.che-multi-selected').forEach(function (n) { n.classList.remove('che-multi-selected'); });
    clone.querySelectorAll('.che-text-editing').forEach(function (n) { n.classList.remove('che-text-editing'); });
    clone.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    // Strip internal identity/transform bookkeeping attrs (keep the composed
    // inline transform, which carries the user's moves).
    clone.querySelectorAll('[data-che-id]').forEach(function (n) { n.removeAttribute('data-che-id'); });
    clone.querySelectorAll('[data-che-tx]').forEach(function (n) { n.removeAttribute('data-che-tx'); });
    clone.querySelectorAll('[data-che-ty]').forEach(function (n) { n.removeAttribute('data-che-ty'); });
    clone.querySelectorAll('[data-che-basetf]').forEach(function (n) { n.removeAttribute('data-che-basetf'); });
    // Strip the CSP nonce we stamped onto the document's own <style>/<link>
    // (and our marker) so the persisted file is byte-clean and not tied to a
    // one-time nonce value.
    clone.querySelectorAll('[data-che-nonced]').forEach(function (n) { n.removeAttribute('nonce'); n.removeAttribute('data-che-nonced'); });
    var body = clone.querySelector('body');
    if (body) body.classList.remove('che-edit', 'che-dirty');
    return '<!DOCTYPE html>\\n' + clone.outerHTML;
  }
  function save() {
    endTextEdit();
    post('save', { html: cleanedHtml() });
    clearDirty();
  }

  // ── Keyboard ─────────────────────────────────────────────────────
  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    var tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }
  function onKeyDown(e) {
    var mod = e.ctrlKey || e.metaKey;
    // Ctrl/Cmd+S → save (always, even outside edit mode so an accidental
    // exit doesn't lose work).
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); return; }
    // When typing inside contenteditable/input, only Esc is meaningful.
    if (textEditState && e.key === 'Escape') { e.preventDefault(); endTextEdit(); return; }
    // Bold / italic / underline shortcuts while editing text inline.
    if (textEditState && mod && !e.shiftKey && !e.altKey) {
      var k = (e.key || '').toLowerCase();
      if (k === 'b') { e.preventDefault(); execInline('bold'); return; }
      if (k === 'i') { e.preventDefault(); execInline('italic'); return; }
      if (k === 'u') { e.preventDefault(); execInline('underline'); return; }
    }
    if (isTyping(e)) return;
    // 'E' toggles edit mode (no modifier).
    if (!mod && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); toggleEdit(); return; }
    if (!editMode) return;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.length) {
        e.preventDefault();
        // Snapshot — deleteElement mutates the selection array.
        selection.slice().forEach(function (el) { deleteElement(el); });
        clearSelection();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (textEditState) endTextEdit(); else clearSelection();
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────
  function boot() {
    buildChrome();
    document.addEventListener('pointerdown', onPointerDown, true);
    // Stash the live selection BEFORE a toolbar control (number/color input)
    // steals focus and collapses it. Capture-phase, runs ahead of onPointerDown
    // (which early-returns for #che-rte targets, so no conflict).
    document.addEventListener('pointerdown', rtePointerStash, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('resize', repositionOverlay, true);
    window.addEventListener('scroll', repositionOverlay, true);
    window.addEventListener('scroll', function () { if (textEditState) positionRteBar(); }, true);
    post('ready', { editable: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
`;

/**
 * Returns true if the given HTML already had the runtime injected (idempotency
 * guard for re-renders).
 */
export function hasEditorRuntime(html: string): boolean {
	return html.includes('id="che-runtime-script"');
}

/**
 * Inject the editable runtime (CSS + JS) into a full HTML document. The runtime
 * is appended just before `</body>` (CSS before `</head>` when present) so the
 * generated content renders first and the chrome layers on top.
 *
 * @param rawHtml the agent's config.html source.
 * @param nonce   the parent webview's active CSP nonce
 *                (`window.__AGENT_STUDIO_CSP_NONCE__`). The `srcdoc` Canvas
 *                iframe INHERITS the webview's strict nonce-based CSP
 *                (`script-src 'nonce-XXX'`, no `'unsafe-inline'`), and CSP
 *                policies only intersect — they can never be loosened from
 *                inside the document. So the ONLY way the injected inline
 *                `<script>` is allowed to run is to carry this very nonce.
 *                When omitted the runtime is injected without a nonce (it will
 *                only execute if the host happens to allow unsafe-inline).
 *
 * Idempotent: if the runtime is already present, the input is returned as-is.
 */
export function injectEditorRuntime(rawHtml: string, nonce?: string): string {
	if (!rawHtml || hasEditorRuntime(rawHtml)) {
		return rawHtml;
	}

	// The parent webview's CSP is `script-src 'nonce-XXX'` (no 'unsafe-inline')
	// and `style-src 'nonce-XXX' 'unsafe-inline'`. A `srcdoc` iframe inherits
	// it and the effective policy is the INTERSECTION, so we cannot relax it
	// with a <meta> CSP — we must satisfy the inherited policy by stamping the
	// SAME nonce onto the tags we inject. NOTE: although the parent's
	// style-src also lists 'unsafe-inline', CSP Level 3 IGNORES
	// 'unsafe-inline' whenever a nonce is present — so styles WITHOUT a
	// nonce are blocked too. That is why we stamp the nonce onto both our
	// injected tags AND the document's own <style>/<link> (see step 0).
	const nonceAttr = nonce ? ` nonce="${nonce}"` : '';

	const styleTag = `<style id="che-runtime-style"${nonceAttr}>${RUNTIME_CSS}</style>`;
	const scriptTag = `<script id="che-runtime-script"${nonceAttr}>${RUNTIME_JS}</script>`;

	let out = rawHtml;

	// 0. CRITICAL — stamp the parent's nonce onto the DOCUMENT'S OWN inline
	//    <style> tags and <link rel="stylesheet"> tags.
	//
	//    Root cause of the "renders differently in Canvas vs. the left editor
	//    pane" bug: the parent webview ships `style-src 'nonce-XXX'
	//    'unsafe-inline'`. Per CSP Level 3, when a nonce is present the
	//    `'unsafe-inline'` keyword is IGNORED for backward-compat — so any
	//    inline <style> WITHOUT a matching nonce is BLOCKED. A `srcdoc` iframe
	//    inherits this policy (intersection only), so the AI-generated HTML's
	//    own <style> blocks (titles, cards, layout, spacing) silently fail to
	//    apply in the Canvas, while the left pane — which injects its OWN
	//    permissive nonce-less meta CSP — renders them fine.
	//
	//    Fix: give the document's authored <style>/<link> the SAME nonce so
	//    they satisfy the inherited policy. We tag them with a marker attr so
	//    `cleanedHtml()` can strip BOTH the nonce and the marker on save,
	//    keeping the persisted file byte-clean (no editor-injected noise).
	if (nonce) {
		// <style ...>  (only those that don't already carry a nonce)
		out = out.replace(/<style\b(?![^>]*\bnonce=)([^>]*)>/gi,
			`<style data-che-nonced$1 nonce="${nonce}">`);
		// <link ... rel="stylesheet" ...>  (only those without a nonce)
		out = out.replace(/<link\b(?![^>]*\bnonce=)([^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*)>/gi,
			`<link data-che-nonced$1 nonce="${nonce}">`);
	}

	// 1. Inject the base document style as the FIRST style in <head> (before
	//    the document's own <style>) so the document renders with the SAME
	//    normalized defaults (margin/background/font) as the left-hand editor
	//    pane. Authored styles still override it. Carries an id so it is
	//    stripped on save (see cleanedHtml).
	const baseStyleTag = `<style id="${BASE_STYLE_ID}"${nonceAttr}>${BASE_DOC_STYLE}</style>`;
	if (/<head[^>]*>/i.test(out)) {
		out = out.replace(/(<head[^>]*>)/i, `$1${baseStyleTag}`);
	} else if (/<html[^>]*>/i.test(out)) {
		out = out.replace(/(<html[^>]*>)/i, `$1<head>${baseStyleTag}</head>`);
	} else if (/<body[^>]*>/i.test(out)) {
		out = out.replace(/(<body[^>]*>)/i, `$1${baseStyleTag}`);
	} else {
		out = `${baseStyleTag}${out}`;
	}

	// 2. Insert editor-chrome CSS before </head> if possible, otherwise prepend
	//    to <body>.
	if (/<\/head>/i.test(out)) {
		out = out.replace(/<\/head>/i, `${styleTag}</head>`);
	} else if (/<body[^>]*>/i.test(out)) {
		out = out.replace(/(<body[^>]*>)/i, `$1${styleTag}`);
	} else {
		out = `${styleTag}${out}`;
	}

	// 3. Insert JS before </body> if possible, otherwise append.
	if (/<\/body>/i.test(out)) {
		out = out.replace(/<\/body>/i, `${scriptTag}</body>`);
	} else {
		out = `${out}${scriptTag}`;
	}

	return out;
}
