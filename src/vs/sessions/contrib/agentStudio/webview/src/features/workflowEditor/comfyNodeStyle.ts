/*---------------------------------------------------------------------------------------------
 *  comfyNodeStyle — ComfyUI-style node visuals for LiteGraph.
 *
 *  P0: yellow connections; P1: title bar (⌄ caret + output-type chips); P2:
 *  dark node palette + ComfyUI-style rounded widgets.
 *
 *  Widgets: LiteGraph renders each widget through `drawWidgets`, but its
 *  INTERACTIONS (click to edit, number drag, combo dropdown) live in
 *  `#processNodeClick` / the widget's own mouse handlers — so overriding the
 *  draw pass to a ComfyUI look is safe and does not break input.
 *--------------------------------------------------------------------------------------------*/
import { ComboWidget, LiteGraph as LiteGraphNS, LGraphCanvas } from '@comfyorg/litegraph';

const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

/** Output type → chip color (mirrors ComfyUI's bright type labels). */
const OUTPUT_TYPE_COLORS: Record<string, string> = {
	IMAGE: '#ffd700',
	VIDEO: '#3b82f6',
	AUDIO: '#eab308',
	TEXT: '#a855f7',
	MODEL: '#a78bfa',
	CONDITIONING: '#fbbf24',
	CLIP: '#a3e635',
	VAE: '#f87171',
	LATENT: '#fb7185',
	SAROS_JSON: '#9ca3af',
	ANY: '#e5e7eb',
	'*': '#c0a000',
};

const TEXT_FG = '#d0d0d0';
const TEXT_MUTED = '#8a8a8a';

interface ComfyTitleNode {
	title?: string;
	type?: string;
	collapsed?: boolean;
	pinned?: boolean;
	outputs?: Array<{ type?: string; name?: string }>;
	renderingSize?: [number, number];
	getTitle?(): string;
}

interface WidgetLike {
	name?: string;
	label?: string;
	type?: string;
	value?: unknown;
	options?: { values?: string[] };
	y?: number;
	last_y?: number;
	computedHeight?: number;
	width?: number;
	height?: number;
	advanced?: boolean;
	disabled?: boolean;
	computedDisabled?: boolean;
	hidden?: boolean;
}

/** Darken a `#rrggbb` color by multiplying each channel by `factor`. */
export function darkenColor(hex: string, factor: number): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) { return hex; }
	const n = parseInt(m[1], 16);
	const r = Math.round(((n >> 16) & 255) * factor);
	const g = Math.round(((n >> 8) & 255) * factor);
	const b = Math.round((n & 255) * factor);
	return `rgb(${r}, ${g}, ${b})`;
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	const radius = Math.max(0, Math.min(r, w / 2, h / 2));
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.lineTo(x + w - radius, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
	ctx.lineTo(x + w, y + h - radius);
	ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
	ctx.lineTo(x + radius, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
	ctx.lineTo(x, y + radius);
	ctx.quadraticCurveTo(x, y, x + radius, y);
	ctx.closePath();
}

/** ComfyUI-style title text (P1). Bound as `onDrawTitleText`.
 *
 * NOTE: LiteGraph's `toCanvasContext` already applies `ctx.scale(scale)` to the
 * whole canvas, so everything drawn here is in *canvas* (pre-zoom) units. Using
 * `11 * scale` here would double-scale the title (quadratic growth on zoom),
 * which is why we use fixed pixels — exactly like `comfyDrawWidgets`. */
export function comfyTitleText(this: ComfyTitleNode, ctx: CanvasRenderingContext2D, title_height: number, size: [number, number], _scale: number): void {
	const [w] = size;
	const fontSize = 11;
	const padX = 8;
	ctx.save();
	ctx.textBaseline = 'middle';
	ctx.font = `${fontSize}px ${FONT}`;
	// collapse caret (left)
	ctx.fillStyle = '#8a8a8a';
	const caret = this.collapsed ? '›' : '⌄';
	ctx.fillText(caret, padX, -title_height / 2);
	const caretW = ctx.measureText(caret).width + 6;
	// title
	ctx.fillStyle = '#e6e6e6';
	ctx.fillText(String(this.getTitle?.() ?? this.title ?? this.type ?? ''), padX + caretW, -title_height / 2);
	// NOTE: no right-aligned output type chips — ComfyTV's reference UI does
	// NOT draw type labels in the title bar. The chips (COMFYTV_IMAGES etc.)
	// crowded the title and looked like internal implementation detail.
	ctx.restore();
}

/**
 * ComfyUI-style widget rendering (P2). Replaces LiteGraph's drawWidgets with a
 * rounded dark field + label; interactions are untouched (they live in the
 * widget's own mouse handling). `this` is the node.
 *
 * LiteGraph 0.17 layout note: `LGraphCanvas.drawNode` calls `node.arrange()`
 * EVERY FRAME before drawing widgets, and `arrange()` assigns each widget its
 * `y` / `computedHeight` BELOW the port rows (ports live at body-relative
 * y=14/34/… — the title bar is drawn ABOVE `pos[1]`, so widget coordinates do
 * NOT include a title-height offset). This function must therefore DRAW ONLY:
 * re-laying widgets out from a hard-coded `titleBottom = 30` (the previous
 * approach) double-counted the title and stacked the first widget on top of
 * the second port row (the "参数遮挡端口" bug).
 */
export function comfyDrawWidgets(
	this: {
		widgets?: WidgetLike[];
		size: [number, number];
		collapsed?: boolean;
		isWidgetVisible?(w: WidgetLike): boolean;
		computeSize?(): [number, number];
	},
	ctx: CanvasRenderingContext2D,
	_options: unknown,
): void {
	if (!this.widgets || this.collapsed) { return; }
	const nodeWidth = this.size[0];
	const H = 22;
	const isVisible = (w: WidgetLike): boolean => (this.isWidgetVisible ? this.isWidgetVisible(w) : true);

	ctx.save();
	ctx.textBaseline = 'middle';
	for (const widget of this.widgets) {
		if (!widget || !isVisible(widget)) { continue; }
		// addDOMWidget-style widgets (schema form panels): LiteGraph's
		// `node.arrange()` owns their y/computedHeight and the DOM overlay
		// renders the content — never re-position or canvas-draw them here.
		// Deliberately do NOT set `last_y`: `getWidgetOnPos` requires it, so
		// leaving it undefined keeps the widget un-hittable — clicks on the
		// card's empty areas fall through to the canvas, preserving node
		// selection, drag and double-click-to-edit exactly as before.
		if (widget.type === 'dom') { continue; }
		// `widget.y` / `widget.computedHeight` are owned by `node.arrange()`
		// (runs in `drawNode` every frame) — draw at the arranged position.
		const y = widget.y ?? 0;
		// Mirror LiteGraph's built-in `drawWidgets`: set `last_y` so
		// `getWidgetOnPos` can hit-test the widget on click. Without this,
		// `widget.last_y` stays undefined and clicks never reach the widget —
		// every text/combo/number field on schema-style nodes is dead.
		widget.last_y = y;
		widget.computedDisabled = !!widget.disabled;
		const width = widget.width || nodeWidth;
		// Per-widget height: LiteGraph 0.17 BaseWidget may compute > 22 (multiline).
		const wH = widget.computedHeight ? Math.max(H, widget.computedHeight) : H;
		const label = widget.label ?? widget.name ?? '';
		const type = widget.type ?? 'text';
		const disabled = !!widget.disabled || !!widget.computedDisabled;
		ctx.globalAlpha = disabled ? 0.45 : 1;
		ctx.font = `11px ${FONT}`;
		// label (left)
		ctx.textAlign = 'left';
		ctx.fillStyle = TEXT_MUTED;
		ctx.fillText(label, 8, y + wH / 2);
		const labelW = Math.min(width * 0.35, 120);
		const fieldX = labelW + 12;
		const fieldW = width - fieldX - 8;

		if (type === 'button') {
			ctx.fillStyle = '#2a2a2a';
			roundedRectPath(ctx, fieldX, y + 2, fieldW, wH - 4, 4);
			ctx.fill();
			ctx.strokeStyle = 'rgba(255,255,255,0.12)';
			ctx.lineWidth = 1;
			ctx.stroke();
			ctx.fillStyle = '#ccc';
			ctx.textAlign = 'center';
			ctx.fillText(String(widget.value ?? label), fieldX + fieldW / 2, y + wH / 2);
			continue;
		}
		if (type === 'toggle' || type === 'boolean') {
			ctx.fillStyle = widget.value ? '#4a9eff' : '#2a2a2a';
			roundedRectPath(ctx, fieldX, y + 3, 14, 14, 3);
			ctx.fill();
			ctx.strokeStyle = 'rgba(255,255,255,0.15)';
			ctx.stroke();
			continue;
		}

		// field backdrop
		ctx.fillStyle = '#1a1a1a';
		roundedRectPath(ctx, fieldX, y + 2, fieldW, wH - 4, 4);
		ctx.fill();
		ctx.strokeStyle = widget.advanced ? 'rgba(56,139,253,0.8)' : 'rgba(255,255,255,0.08)';
		ctx.lineWidth = 1;
		ctx.stroke();

		ctx.fillStyle = TEXT_FG;
		if (type === 'number' || type === 'slider') {
			// ComfyUI 风格 stepper：左侧 − 按钮（< 40px 区域）+ 中央数字（点击弹 prompt 编辑）+）右侧 + 按钮（> width - 40px 区域）。
			// LiteGraph 0.17 NumberWidget.onClick 已原生分流（x<40→-, x>width-40→+, else→canvas.prompt），
			// 本函数只画两侧 − / + 占位符让用户视觉看到，避免误以为只读。
			const val = Number(widget.value ?? 0);
			const stepBtnW = 24;
			const minusCenterX = fieldX + stepBtnW / 2;
			const plusCenterX = fieldX + fieldW - stepBtnW / 2;
			const textY = y + wH / 2;
			// −
			ctx.textAlign = 'center';
			ctx.fillStyle = TEXT_MUTED;
			ctx.fillText('−', minusCenterX, textY);
			// +
			ctx.fillText('+', plusCenterX, textY);
			// 中央数字
			ctx.textAlign = 'center';
			ctx.fillStyle = TEXT_FG;
			ctx.fillText(String(val), fieldX + fieldW / 2, textY);
		} else if (type === 'combo' || type === 'select') {
			// 字段背景已由上面 203-208 行的 field backdrop 统一填过（深色 IDE 风），
			// 这里只画值与 ▾ 箭头——与 number/text 一致。
			ctx.textAlign = 'right';
			const opts = widget.options?.values ?? [];
			const cur = opts.includes(widget.value as string) ? widget.value : String(widget.value ?? '');
			ctx.fillStyle = TEXT_FG;
			ctx.fillText(String(cur), fieldX + fieldW - 22, y + wH / 2);
			ctx.fillStyle = TEXT_MUTED;
			ctx.fillText('▾', fieldX + fieldW - 10, y + wH / 2);
		} else {
			// text / textarea / string / fallback
			ctx.textAlign = 'left';
			const v = String(widget.value ?? '');
			ctx.fillText(v.length > 18 ? `${v.slice(0, 18)}…` : v, fieldX + 8, y + wH / 2);
		}
		ctx.globalAlpha = 1;
		ctx.textAlign = 'left';
	}
	ctx.restore();
}

/**
 * Draw a ComfyUI-style error banner at the bottom of a node. The red outer
 * border is **not** drawn here — LiteGraph's `drawNode` already colors
 * `boxcolor` red on error (`setIsExecutingError` / `onExecuted` failure), so
 * adding another full-node stroke here would render a double red border
 * around the node. Keep this function to the bottom banner + text only.
 */
export function drawNodeErrorBanner(ctx: CanvasRenderingContext2D, w: number, h: number, error: string): void {
	ctx.save();
	// bottom banner
	const bannerH = 20;
	ctx.fillStyle = 'rgba(255, 80, 80, 0.14)';
	roundedRectPath(ctx, 1, h - bannerH - 1, w - 2, bannerH, 4);
	ctx.fill();
	ctx.fillStyle = '#ff6b6b';
	ctx.font = `11px ${FONT}`;
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'left';
	const text = error.length > 44 ? `${error.slice(0, 44)}…` : error;
	ctx.fillText(`⚠ Error: ${text}`, 8, h - bannerH / 2);
	ctx.restore();
}

/** Execution-state border colors (ComfyUI-like). W2: skipped = 灰虚线（分支未激活）。 */
const STATE_BORDER: Record<string, string> = {
	running: '#4a9eff',
	success: '#2ecc71',
	error: '#ff5b5b',
	skipped: '#6b7280',
};;

/**
 * Draw a node execution-state overlay: running → blue border, success → green
 * border, error → red border + bottom banner. Pure; only draws when `state`
 * is one of running/success/error.
 */
export function drawNodeStateOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, state: string | undefined, error?: string): void {
	if (!state || !(state in STATE_BORDER)) { return; }
	if (state === 'error') {
		drawNodeErrorBanner(ctx, w, h, error ?? '执行失败');
		return;
	}
	ctx.save();
	ctx.strokeStyle = STATE_BORDER[state];
	ctx.lineWidth = 2;
	// W2: skipped = 灰虚线（分支未激活，非错误），与实线执行态区分
	if (state === 'skipped') { ctx.setLineDash([5, 4]); }
	roundedRectPath(ctx, 1, 1, w - 2, h - 2, 8);
	ctx.stroke();
	ctx.restore();
}

/**
 * Patch ComboWidget so its dropdown menu anchors below the widget field
 * (not at mouse cursor) and matches the field width — matching native <select>
 * behavior and ComfyUI's visual expectation.
 *
 * 视觉：保留 LiteGraph 原生 ContextMenu（`.litecontextmenu.dark` 黑底 + hover 白底
 * "ComfyUI signature look"，见 globals.css 6666-6678 行）。仅调整位置（widget 下方对齐）
 * 与宽度（与字段对齐），不改主题。
 *
 * 必须：call after LiteGraph 加载（imports @comfyorg/litegraph）。
 */
export function patchComboDropdownPositioning(): void {
	// 直接用 ESM import——不要走 globalThis.LiteGraph，ESM import 不会挂到全局，
	// 早退检查会漏掉（patch 实际从未生效，所有覆写无效）。
	const OrigOnClick = (ComboWidget as unknown as { prototype?: { onClick?: unknown } }).prototype?.onClick;
	if (typeof OrigOnClick !== 'function') { return; }
	void LiteGraphNS; // 引用以避免被 tree-shake 掉

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ComboProto = ComboWidget as unknown as { prototype: Record<string, unknown> };
	// LiteGraph 0.17 调用 widget.onClick 的方式是传**单个对象参数**：
	//   widgetInstance.onClick({ e, node, canvas })
	// （见 litegraph.es.js:10265 `pointer.onClick = () => widgetInstance.onClick({...})`）。
	// 签名必须是单对象 + 解构，不能写 3 个独立参数——否则 node/canvas 是 undefined，
	// 位置计算在 `canvas.ds.scale` 处抛 TypeError，位置设置代码永远不执行。
	ComboProto.prototype.onClick = function (
		this: {
			// LiteGraph 0.17 用 `last_y`（不是 `y`）作为 widget 顶部坐标——由
			// `#arrangeWidgets`（drawWidgets 子过程）每帧写入；`y` 是 class field default=0
			// 不被赋位置值。
			last_y?: number;
			width?: number; height?: number; computedHeight?: number;
			options: { values?: unknown };
			name?: string;
		},
		args: {
			e: { canvasX: number; canvasY: number; clientX: number; clientY: number };
			node: { pos: [number, number]; size: [number, number]; widgets?: Array<{ name?: string; type?: string; last_y?: number; computedHeight?: number; height?: number }> };
			canvas: { ds: { offset: [number, number]; scale: number }; canvas: HTMLCanvasElement | undefined };
		},
	): void {
		const { e, node } = args;
		// Call original first — it creates the ContextMenu but we'll reposition after.
		OrigOnClick.call(this, args);

		// 防御：`args.canvas` 在 LiteGraph 0.17 某些调用路径下可能缺失，导致后续
		// `canvas.ds.scale` 抛 "Cannot read properties of undefined (reading 'ds')"
		// （日志里反复出现，且是 Uncaught TypeError）。用全局 active_canvas 兜底；
		// 若仍无 ds，则跳过精确定位——原生菜单已打开 / 箭头增减已执行，交互不受
		// 影响，仅下拉框退化回 LiteGraph 默认锚点。
		const fallbackCanvas = (LGraphCanvas as unknown as { active_canvas?: typeof args.canvas }).active_canvas;
		const canvas = args.canvas ?? fallbackCanvas;
		if (!canvas || !canvas.ds) {
			// eslint-disable-next-line no-console
			console.warn('[combo.onClick] canvas/ds missing — skip reposition', {
				hasArgCanvas: !!args.canvas,
				hasActiveCanvas: !!fallbackCanvas,
				argKeys: args ? Object.keys(args) : 'args-undefined',
			});
			return;
		}

		// Reposition: find the just-created context menu root element.
		const menu = document.querySelector('.litecontextmenu:last-child') as HTMLElement | null;
		if (!menu) { return; }

		// ─── 搜索框（ComfyUI 风格，顶部 input）───
		// LiteGraph 0.17 ContextMenu 不支持搜索；我们插入一个 input 到菜单顶部，
		// 监听 input 事件对 litemenu-entry 项做大小写不敏感过滤。
		const allEntries = Array.from(menu.querySelectorAll<HTMLElement>('.litemenu-entry'));
		if (allEntries.length > 0) {
			// 隐藏原生 title（"Values"），不遮挡我们的搜索框
			const titleEl = menu.querySelector<HTMLElement>('.litemenu-title');
			if (titleEl) { titleEl.style.display = 'none'; }
			// 构造搜索框
			const search = document.createElement('input');
			search.type = 'text';
			search.placeholder = '搜索…';
			search.className = 'litemenu-search';
			search.autocomplete = 'off';
			search.spellcheck = false;
			Object.assign(search.style, {
				width: 'calc(100% - 16px)', boxSizing: 'border-box',
				margin: '8px', padding: '6px 10px',
				background: '#1a1a1a', color: '#e6e6e6',
				border: '1px solid #3a3a3a', borderRadius: '4px',
				fontSize: '12px', outline: 'none',
				fontFamily: 'inherit',
			});
			// 阻止搜索框点击冒泡触发 LiteGraph 外部点击关闭逻辑（LiteGraph 0.17
			// 已经 pointerdown capture 阶段检查 containsNode，本框在 menu 内会放过）。
			// 但阻止 keydown 冒泡到 canvas key 监听
			search.addEventListener('keydown', (ev) => ev.stopPropagation());
			search.addEventListener('pointerdown', (ev) => ev.stopPropagation());
			search.addEventListener('click', (ev) => ev.stopPropagation());
			const filterEntries = (q: string) => {
				const needle = q.trim().toLowerCase();
				for (const ent of allEntries) {
					if (ent.classList.contains('separator')) { continue; }
					const text = (ent.textContent ?? '').toLowerCase();
					ent.style.display = needle === '' || text.includes(needle) ? '' : 'none';
				}
			};
			search.addEventListener('input', () => filterEntries(search.value));
			menu.insertBefore(search, menu.firstChild);
			// 自动聚焦
			queueMicrotask(() => search.focus());
		}

		// ─── Compute popover anchor ───
		// Use `widget.last_y` (LiteGraph 0.17 field set by `#arrangeWidgets`) as the
		// widget top in node coordinates. Fall back to scanning node.widgets by
		// name (LiteGraph binds the hit widget through processMouseAction; the
		// `this` here may be a BaseWidget subclass instance without last_y).
		const scale = Math.max(0.001, canvas.ds.scale);
		const widgetH = this.computedHeight ?? this.height ?? 22;
		let widgetTopY = this.last_y;
		if (widgetTopY == null && node.widgets) {
			const w = node.widgets.find(w => w.name === this.name);
			if (w?.last_y != null) { widgetTopY = w.last_y; }
		}
		// Absolute fallback: use the mouse click's canvasY → node-relative y.
		// This guarantees the menu anchors *somewhere sensible* even if the
		// node was never drawn (first frame before arrangeWidgets runs).
		if (widgetTopY == null) {
			widgetTopY = (e.canvasY - node.pos[1]) - widgetH / 2;
		}
		const widgetBottomY = widgetTopY + widgetH;

		// Screen coords: canvas DOM origin + (graph coords × scale).
		const canvasRect = canvas.canvas?.getBoundingClientRect();
		const canvasLeft = canvasRect?.left ?? 0;
		const canvasTop = canvasRect?.top ?? 0;
		const nodeScreenX = canvasLeft + (node.pos[0] + canvas.ds.offset[0]) * scale;
		const widgetScreenY = canvasTop + (node.pos[1] + canvas.ds.offset[1]) * scale + widgetBottomY * scale;

		// ─── Popover width: align to the COMBO FIELD, not the node ───
		// 复刻 ComfyUI 用户期望：弹窗宽度等于**字段列**（即右侧输入框）而非整个节点。
		// 公式与 comfyDrawWidgets (comfyNodeStyle.ts:178-180) 严格一致：
		//   labelW = min(width * 0.35, 120)
		//   fieldX = labelW + 12
		//   fieldW = width - fieldX - 8
		// `width` 优先取 `this.width`（LiteGraph 0.17 widget 在节点内宽度，含 label），
		// 兜底用 node.size[0]（节点宽）。
		const widgetW = this.width || node.size[0];
		const labelW = Math.min(widgetW * 0.35, 120);
		const fieldX = labelW + 12;
		const fieldW = widgetW - fieldX - 8;
		// 屏幕坐标 = canvas DOM 偏移 + (节点 x + 字段 x) × scale
		const fieldScreenX = canvasLeft + (node.pos[0] + canvas.ds.offset[0]) * scale + fieldX * scale;
		const popScreenX = fieldScreenX;
		const popScreenW = Math.max(80, fieldW * scale);

		// Viewport clamp — flip horizontally / vertically if overflow.
		const vw = window.innerWidth, vh = window.innerHeight;
		menu.style.position = 'fixed';
		menu.style.left = `${popScreenX}px`;
		menu.style.top = `${widgetScreenY}px`;
		menu.style.width = `${popScreenW}px`;
		menu.style.minWidth = `${popScreenW}px`;
		const r = menu.getBoundingClientRect();
		if (r.right > vw - 8) { menu.style.left = `${Math.max(8, vw - r.width - 8)}px`; }
		if (r.bottom > vh - 8) { menu.style.top = `${Math.max(8, r.top - r.height - widgetH * scale - 4)}px`; }
		};
}

/**
 * Apply ComfyUI visuals. Idempotent; call once at canvas init.
 *  - P1: node prototype `onDrawTitleText` + `onDrawTitleBox`
 *  - P2: dark node palette (LiteGraph constants) + ComfyUI `drawWidgets`
 *  - P3: `onDrawForeground` — execution-state border/banner (running/success/error)
 *  - P4: combo dropdown anchoring (below widget, matching width)
 */
export function applyComfyNodeStyle(
	liteCanvas: { node_title_color?: string },
	LGraphNodeCtor: { prototype: Record<string, unknown> },
	LiteGraph: {
		NODE_DEFAULT_COLOR: string;
		NODE_DEFAULT_BGCOLOR: string;
		NODE_DEFAULT_BOXCOLOR: string;
		WIDGET_OUTLINE_COLOR: string;
	},
	getNodeState?: (nodeId: string) => { runState?: string; errorMsg?: string } | undefined,
): void {
	// title color
	liteCanvas.node_title_color = '#e6e6e6';
	// ComfyUI dark node palette
	LiteGraph.NODE_DEFAULT_COLOR = '#2a2a2a';
	LiteGraph.NODE_DEFAULT_BGCOLOR = '#1f1f1f';
	LiteGraph.NODE_DEFAULT_BOXCOLOR = '#4a4a4a';
	LiteGraph.WIDGET_OUTLINE_COLOR = '#3a3a3a';

	const proto = LGraphNodeCtor.prototype;
	// hide LiteGraph's default caret DOT (drawTitleBox) — comfyTitleText draws a ⌄.
	proto['onDrawTitleBox'] = function () { /* no-op */ };
	// dark title bar: node.color is often bright (Start=green, Agent=orange,
	// End=red) which drowns the white title text. ComfyUI uses a dark header +
	// bright text, so darken the header fill to ~40% luminance.
	proto['onDrawTitleBar'] = function (this: unknown, ctx: CanvasRenderingContext2D, title_height: number, size: [number, number], scale: number, fgcolor: string) {
		ctx.fillStyle = darkenColor(fgcolor || '#2a2a2a', 0.4);
		ctx.beginPath();
		roundedRectPath(ctx, 0, -title_height, size[0], title_height, 6);
		ctx.fill();
		void scale;
	};
	// P1: ComfyUI title bar
	proto['onDrawTitleText'] = function (this: ComfyTitleNode, ctx: CanvasRenderingContext2D, title_height: number, size: [number, number], scale: number) {
		comfyTitleText.call(this, ctx, title_height, size, scale);
	};
	// P2: ComfyUI rounded widgets
	proto['drawWidgets'] = function (this: Parameters<typeof comfyDrawWidgets>[0], ctx: CanvasRenderingContext2D, options: unknown) {
		comfyDrawWidgets.call(this, ctx, options);
	};
	// P3: execution-state overlay — running/success border + error banner
	proto['onDrawForeground'] = function (this: { id?: number; properties?: Record<string, unknown>; renderingSize?: [number, number]; size?: [number, number] }, ctx: CanvasRenderingContext2D) {
		const state = getNodeState?.(String(this.properties?.['__sarosId'] ?? this.id ?? ''));
		if (!state) { return; }
		const [w, h] = this.renderingSize ?? this.size ?? [0, 0];
		if (w <= 0 || h <= 0) { return; }
		drawNodeStateOverlay(ctx, w, h, state.runState, state.errorMsg);
	};
	// P4: combo dropdown anchors below widget field (not at cursor) + matches width
	patchComboDropdownPositioning();
}
