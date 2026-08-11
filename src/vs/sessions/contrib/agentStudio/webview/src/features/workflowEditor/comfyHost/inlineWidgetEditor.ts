/*---------------------------------------------------------------------------------------------
 *  inlineWidgetEditor — replace LGraphCanvas#prompt() with an in-place DOM input
 *  overlay. LiteGraph's default opens a floating `.graphdialog` element at the
 *  click position (canvas.prompt → DOM appendChild with absolute left/top +
 *  inline left/top styling). That pop-up is awkward for tight node layouts and
 *  requires the user to leave the node to type.
 *
 *  ComfyUI's reference behavior: clicking a text widget opens an `<input>`
 *  (or `<textarea>` for multiline) directly OVER the widget's field area, so
 *  the user types exactly where they clicked and the value commits on
 *  Enter/blur. We mirror that here by patching the canvas instance's `prompt`
 *  method — only this canvas instance is affected, leaving LiteGraph itself
 *  untouched.
 *
 *  Position math (mirrors what `comfyDrawWidgets` does for drawing):
 *   - labelW = min(nodeWidth * 0.35, 120)        (canvas pixels)
 *   - fieldX = labelW + 12                       (canvas pixels)
 *   - fieldY = widget.y + 2                      (canvas pixels)
 *   - fieldW = nodeWidth - fieldX - 8            (canvas pixels)
 *   - fieldH = max(22, widget.computedHeight) - 4
 *  Convert to screen: ((canvasPos - ds.offset) * ds.scale) + rect.left/top.
 *--------------------------------------------------------------------------------------------*/

import type { LGraphNode } from '@comfyorg/litegraph';

interface InlineEditorOpts {
	value: string;
	multiline: boolean;
	pos: { left: number; top: number; width: number; height: number };
	onCommit: (v: string | null) => void;
}

/** Render a DOM input over the widget's field area. Returns a dispose fn. */
function showInlineEditor(opts: InlineEditorOpts): () => void {
	const { pos, value, multiline, onCommit } = opts;
	const tag = multiline ? 'textarea' : 'input';
	const input = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
	input.className = 'litegraph-inline-editor';
	input.value = value;
	if (!multiline) { (input as HTMLInputElement).type = 'text'; }
	// Inline style — keep CSS in globals.css for theming.
	input.style.position = 'fixed';
	input.style.left = `${pos.left}px`;
	input.style.top = `${pos.top}px`;
	input.style.width = `${pos.width}px`;
	input.style.height = `${pos.height}px`;
	input.style.zIndex = '1000';
	document.body.appendChild(input);

	let disposed = false;
	const dispose = () => {
		if (disposed) { return; }
		disposed = true;
		try { document.body.removeChild(input); } catch { /* element already gone */ }
	};
	let committed = false;
	const commit = (v: string | null): void => {
		if (committed) { return; }
		committed = true;
		dispose();
		onCommit(v);
	};

	input.addEventListener('keydown', (e: KeyboardEvent) => {
		// Stop propagation so the canvas's own keydown handler (Ctrl+A/C/V, etc.)
		// doesn't intercept Enter / Escape while the user is typing.
		e.stopPropagation();
		if (e.key === 'Escape') {
			e.preventDefault();
			commit(null);
		} else if (e.key === 'Enter') {
			// For textarea, allow Shift+Enter to insert newline; bare Enter commits.
			if (multiline && e.shiftKey) { return; }
			e.preventDefault();
			commit(input.value);
		}
	});

	// Commit on blur — typing elsewhere should save, not silently revert.
	input.addEventListener('blur', () => {
		// setTimeout so a click on a context menu option still fires before dispose.
		setTimeout(() => commit(input.value), 0);
	});

	// Focus + select existing text after the element is in the DOM.
	setTimeout(() => { input.focus(); input.select(); }, 0);

	return dispose;
}

/** Convert a widget's canvas-space rect to screen-space (px in viewport).
 *
 * LiteGraph's `toCanvasContext` does `ctx.scale(s); ctx.translate(offset)` —
 * the resulting matrix is `T*S`, so drawing at canvas coord X lands at screen
 * pixel `s * (X + offset) + rect.left`. `ds.offset` is stored in PRE-scale
 * canvas units (verified via `convertEventToCanvasOffset`):
 *   `canvasX = clientX_rel / scale - offset[0]`  ⇔  `screenRelX = scale * (canvasX + offset[0])`
 * So the correct forward formula is `scale * (canvasX + offset) + rect.left`,
 * NOT `(canvasX - offset) * scale + rect.left`.
 */
function widgetToScreen(
	liteCanvas: { canvas: HTMLCanvasElement; ds: { scale: number; offset: [number, number] } },
	node: { pos: [number, number]; size: [number, number] },
	widget: { y: number; width?: number; computedHeight?: number },
): { left: number; top: number; width: number; height: number } | null {
	const ds = liteCanvas.ds;
	const rect = liteCanvas.canvas.getBoundingClientRect();
	if (!rect.width) { return null; }

	// Mirror comfyDrawWidgets' field math (canvas pixels).
	const nodeWidth = widget.width || node.size[0];
	const labelW = Math.min(nodeWidth * 0.35, 120);
	const fieldX = labelW + 12;
	const fieldW = Math.max(40, nodeWidth - fieldX - 8);
	const H = Math.max(22, widget.computedHeight ?? 22);
	const fieldH = H - 4;
	const fieldY = widget.y + 2;

	const left = (node.pos[0] + fieldX + ds.offset[0]) * ds.scale + rect.left;
	const top = (node.pos[1] + fieldY + ds.offset[1]) * ds.scale + rect.top;
	return {
		left,
		top,
		width: fieldW * ds.scale,
		height: fieldH * ds.scale,
	};
}

/**
 * Patch the given LGraphCanvas instance so widget clicks open an inline DOM
 * input over the widget itself instead of a floating dialog. The original
 * `prompt()` is preserved and used as a fallback when we can't locate a widget
 * (e.g. free-floating prompts issued by other code).
 */
export function patchInlineWidgetEditor(
	liteCanvas: LGraphCanvas & { prompt: (title: string, value: string, cb: (v: string | null) => void, e: { canvasX?: number; canvasY?: number }, multiline?: boolean) => unknown },
): void {
	const originalPrompt = liteCanvas.prompt.bind(liteCanvas);

	liteCanvas.prompt = function patchedPrompt(
		title: string,
		value: string,
		callback: (v: string | null) => void,
		event: { canvasX?: number; canvasY?: number } | undefined,
		multiline = false,
	): unknown {
		// Locate the widget under the cursor. `getWidgetOnPos` requires our
		// comfyDrawWidgets to set `widget.last_y` (see comfyNodeStyle.ts).
		const cx = event?.canvasX;
		const cy = event?.canvasY;
		if (cx == null || cy == null) {
			return originalPrompt(title, value, callback, event, multiline);
		}
		const node = liteCanvas.node_over;
		if (!node || typeof (node as unknown as LGraphNode).getWidgetOnPos !== 'function') {
			return originalPrompt(title, value, callback, event, multiline);
		}
		const widget = (node as unknown as LGraphNode).getWidgetOnPos(cx, cy);
		if (!widget) {
			return originalPrompt(title, value, callback, event, multiline);
		}

		const pos = widgetToScreen(liteCanvas, node, widget);
		if (!pos) {
			return originalPrompt(title, value, callback, event, multiline);
		}

		// Some widgets (e.g. number) want to evaluate arithmetic expressions
		// before storing. The original NumberWidget.onClick does this inline
		// in its callback; mirror that here so downstream code (comfyDrawWidgets
		// etc.) sees the same numeric value it would have seen with the dialog.
		const commit: (v: string | null) => void = (v) => {
			if (v === null) { callback(null); return; }
			if (widget.type === 'number') {
				if (/^[\d\s()*+/-]+|\d+\.\d+$/.test(v)) {
					try { v = String(eval(v)); } catch { /* leave as-is */ }
				}
				const n = Number(v);
				if (isNaN(n)) { callback(null); return; }
			}
			callback(v);
		};

		return showInlineEditor({
			value: String(value ?? ''),
			multiline: !!multiline || !!widget.options?.multiline,
			pos,
			onCommit: commit,
		});
	};
}