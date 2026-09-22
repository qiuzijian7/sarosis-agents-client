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

import type { LGraphNode, LGraphCanvas } from '@comfyorg/litegraph';

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
 * ★ 2026-09-21：**安全算术求值**，用来替代原来的 `eval(v)` ✗。
 *
 * 为什么要换（两个理由，任一都足够 ✓）：
 *  1. **安全** ✗：原实现先过一道从 ComfyUI 抄来的正则
 *     `/^[\d\s()*+/-]+|\d+\.\d+$/` —— 那个 `|` 两侧都没锚定 ⇒
 *     只要**以数字开头**就算"通过" ✓ ⇒ `1;alert(1)` 这种输入会**被 eval 整段执行** ✗✓
 *     （webview 里就是任意代码执行 ✓）。本函数改为**只认算术字符 + 必须整串消费完** ✓，
 *     `1;alert(1)` 直接判为不合法 ✓。
 *  2. **构建** ✗：`eval` 触发 esbuild `[direct-eval]` 警告 ✓
 *     （"Using direct eval with a bundler is not recommended" ✓），且妨碍压缩优化 ✓。
 *
 * 语义与 ComfyUI 原行为**对齐** ✓：解析成功返回数值 ✓，失败返回 `null` ⇒
 * 调用方保持原文本不变（后续 `Number(v)` 判定照旧 ✓）。
 * 支持：十进制字面量 / `+ - * /` / `**` / 括号 / 一元正负 / 空白 ✓（优先级同数学 ✓）。
 * 不支持（不会静默改变原文本 ✓）：函数调用 / 变量 / 十六进制等 ✓
 * —— 这些仍走原来的 `Number(v)` 分支 ✓。
 * ⚠ 与原 eval 的两点**已知差异** ✓（都更严格 ✓，且仅影响刁钻输入 ✓）：
 *   · `1e3` / `0b101` ⇒ 本函数返回 null ⇒ 由 `Number(v)` 兜底 ⇒ **结果依旧相同** ✓；
 *   · `1_000`（数值分隔符）⇒ 原 eval 得 1000 ✓，现判不合法 ⇒ `Number` 为 NaN ⇒ 拒绝 ✗
 *     （用户想表达 1000 会看到"输入被清空"✓；如需支持，把 `_` 加入白名单并剥离即可 ✓）。
 *
 * ⚠ `1/0` 这类**非有限**结果按失败处理 ✗（原 eval 会得到 `"Infinity"` ✓，
 *   但那不是合法数值 ✓，按失败回退更安全 ✓）。
 */
function evalArithmeticExpression(expr: string): number | null {
	// 白名单：只允许数字、空白、小数点与四则运算符/括号 ✓
	if (!/^[\d\s.+\-*/()]+$/.test(expr) || !/\d/.test(expr)) { return null; }

	let i = 0;
	const skipWs = (): void => { while (i < expr.length && /\s/.test(expr[i])) { i++; } };

	/** factor := number | '(' sum ')' | ('+' | '-') factor */
	const parseFactor = (): number => {
		skipWs();
		const c = expr[i];
		if (c === '+') { i++; return parseFactor(); }
		if (c === '-') { i++; return -parseFactor(); }
		if (c === '(') {
			i++;
			const inner = parseSum();
			skipWs();
			if (expr[i] !== ')') { throw new Error('unbalanced ( '); }
			i++;
			return inner;
		}
		const start = i;
		while (i < expr.length && /[\d.]/.test(expr[i])) { i++; }
		if (i === start) { throw new Error('number expected'); }
		const n = Number(expr.slice(start, i));
		if (!isFinite(n)) { throw new Error('bad number'); }
		return n;
	};

	/** power := factor ('**' power)? —— **右结合** ✓，与 JS 一致 ✓（`2**3**2` = 512 ✓） */
	const parsePower = (): number => {
		const base = parseFactor();
		skipWs();
		if (expr[i] === '*' && expr[i + 1] === '*') {
			i += 2;
			return Math.pow(base, parsePower());
		}
		return base;
	};

	/** product := power (('*' | '/') power)* */
	const parseProduct = (): number => {
		let v = parsePower();
		for (;;) {
			skipWs();
			const op = expr[i];
			if (op !== '*' && op !== '/') { return v; }
			i++;
			const rhs = parsePower();
			v = op === '*' ? v * rhs : v / rhs;
		}
	};

	/** sum := product (('+' | '-') product)* */
	function parseSum(): number {
		let v = parseProduct();
		for (;;) {
			skipWs();
			const op = expr[i];
			if (op !== '+' && op !== '-') { return v; }
			i++;
			const rhs = parseProduct();
			v = op === '+' ? v + rhs : v - rhs;
		}
	}

	try {
		const result = parseSum();
		skipWs();
		// 必须整串消费完 ⇒ `1+2abc` 这类直接判失败 ✓（不留残余 ✓）
		if (i !== expr.length || !isFinite(result)) { return null; }
		return result;
	} catch {
		return null;
	}
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
		//
		// ★ 2026-09-21：**求值改用 `evalArithmeticExpression`** ✓ ——
		// 原来是 `eval(v)` ✗，既触发 esbuild `[direct-eval]` 警告 ✓，
		// 又因前置正则不锚定而可执行任意代码 ✗（详见该函数注释 ✓）。
		// 行为对齐 ✓：能求值就替换成结果 ✓，求不了就原样往下走 `Number(v)` ✓。
		const commit: (v: string | null) => void = (v) => {
			if (v === null) { callback(null); return; }
			if (widget.type === 'number') {
				const evaluated = evalArithmeticExpression(v);
				if (evaluated !== null) { v = String(evaluated); }
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