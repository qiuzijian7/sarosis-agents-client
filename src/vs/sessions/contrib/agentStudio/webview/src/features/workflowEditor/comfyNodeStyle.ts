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
	SAROSIS_JSON: '#9ca3af',
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

/** ComfyUI-style title text (P1). Bound as `onDrawTitleText`. */
export function comfyTitleText(this: ComfyTitleNode, ctx: CanvasRenderingContext2D, title_height: number, size: [number, number], scale: number): void {
	const [w] = size;
	const fontSize = Math.max(10, 11 * scale);
	const padX = 8 * scale;
	ctx.save();
	ctx.textBaseline = 'middle';
	ctx.font = `${fontSize}px ${FONT}`;
	// collapse caret (left)
	ctx.fillStyle = '#8a8a8a';
	const caret = this.collapsed ? '›' : '⌄';
	ctx.fillText(caret, padX, -title_height / 2);
	const caretW = ctx.measureText(caret).width + 6 * scale;
	// title
	ctx.fillStyle = '#e6e6e6';
	ctx.fillText(String(this.getTitle?.() ?? this.title ?? this.type ?? ''), padX + caretW, -title_height / 2);
	// right-aligned output type chips
	const types: Array<{ label: string; color: string }> = [];
	for (const out of this.outputs ?? []) {
		const t = String(out?.type ?? out?.name ?? '').toUpperCase();
		if (t && t !== 'ANY') {
			types.push({ label: t, color: OUTPUT_TYPE_COLORS[t] ?? OUTPUT_TYPE_COLORS['*'] });
		}
	}
	if (types.length > 0) {
		ctx.font = `${Math.max(8, 9 * scale)}px ${FONT}`;
		ctx.textAlign = 'right';
		const rightPad = padX + 4 * scale;
		let rightX = w - rightPad;
		for (let i = types.length - 1; i >= 0; i--) {
			const t = types[i];
			ctx.fillStyle = t.color;
			const tw = ctx.measureText(t.label).width;
			if (rightX - tw < padX + caretW + 20 * scale) { break; }
			ctx.fillText(t.label, rightX, -title_height / 2);
			rightX -= tw + 6 * scale;
		}
		ctx.textAlign = 'start';
	}
	ctx.restore();
}

/**
 * ComfyUI-style widget rendering (P2). Replaces LiteGraph's drawWidgets with a
 * rounded dark field + label; interactions are untouched (they live in the
 * widget's own mouse handling). `this` is the node.
 */
export function comfyDrawWidgets(
	this: {
		widgets?: WidgetLike[];
		size: [number, number];
		collapsed?: boolean;
		isWidgetVisible?(w: WidgetLike): boolean;
	},
	ctx: CanvasRenderingContext2D,
	_options: unknown,
): void {
	if (!this.widgets || this.collapsed) { return; }
	const nodeWidth = this.size[0];
	const H = 22;
	ctx.save();
	ctx.textBaseline = 'middle';
	for (const widget of this.widgets) {
		if (!widget || (this.isWidgetVisible ? !this.isWidgetVisible(widget) : false)) { continue; }
		const y = widget.y ?? 0;
		const width = widget.width || nodeWidth;
		const label = widget.label ?? widget.name ?? '';
		const type = widget.type ?? 'text';
		const disabled = !!widget.disabled || !!widget.computedDisabled;
		ctx.globalAlpha = disabled ? 0.45 : 1;
		ctx.font = `11px ${FONT}`;
		// label (left)
		ctx.textAlign = 'left';
		ctx.fillStyle = TEXT_MUTED;
		ctx.fillText(label, 8, y + H / 2);
		const labelW = Math.min(width * 0.35, 120);
		const fieldX = labelW + 12;
		const fieldW = width - fieldX - 8;

		if (type === 'button') {
			ctx.fillStyle = '#2a2a2a';
			roundedRectPath(ctx, fieldX, y + 2, fieldW, H - 4, 4);
			ctx.fill();
			ctx.strokeStyle = 'rgba(255,255,255,0.12)';
			ctx.lineWidth = 1;
			ctx.stroke();
			ctx.fillStyle = '#ccc';
			ctx.textAlign = 'center';
			ctx.fillText(String(widget.value ?? label), fieldX + fieldW / 2, y + H / 2);
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
		roundedRectPath(ctx, fieldX, y + 2, fieldW, H - 4, 4);
		ctx.fill();
		ctx.strokeStyle = widget.advanced ? 'rgba(56,139,253,0.8)' : 'rgba(255,255,255,0.08)';
		ctx.lineWidth = 1;
		ctx.stroke();

		ctx.fillStyle = TEXT_FG;
		if (type === 'number' || type === 'slider') {
			ctx.textAlign = 'right';
			ctx.fillText(String(widget.value ?? 0), fieldX + fieldW - 8, y + H / 2);
		} else if (type === 'combo' || type === 'select') {
			ctx.textAlign = 'right';
			const opts = widget.options?.values ?? [];
			const cur = opts.includes(widget.value as string) ? widget.value : String(widget.value ?? '');
			ctx.fillText(String(cur), fieldX + fieldW - 22, y + H / 2);
			ctx.fillStyle = TEXT_MUTED;
			ctx.fillText('⌄', fieldX + fieldW - 10, y + H / 2);
		} else {
			// text / textarea / string / fallback
			ctx.textAlign = 'left';
			const v = String(widget.value ?? '');
			ctx.fillText(v.length > 18 ? `${v.slice(0, 18)}…` : v, fieldX + 8, y + H / 2);
		}
		ctx.globalAlpha = 1;
		ctx.textAlign = 'left';
	}
	ctx.restore();
}

/** Draw a ComfyUI-style error banner + red border at the bottom of a node. */
export function drawNodeErrorBanner(ctx: CanvasRenderingContext2D, w: number, h: number, error: string): void {
	ctx.save();
	// red border around the whole node
	ctx.strokeStyle = '#ff5b5b';
	ctx.lineWidth = 2;
	roundedRectPath(ctx, 1, 1, w - 2, h - 2, 8);
	ctx.stroke();
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

/** Execution-state border colors (ComfyUI-like). */
const STATE_BORDER: Record<string, string> = {
	running: '#4a9eff',
	success: '#2ecc71',
	error: '#ff5b5b',
};

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
	roundedRectPath(ctx, 1, 1, w - 2, h - 2, 8);
	ctx.stroke();
	ctx.restore();
}

/**
 * Apply ComfyUI visuals. Idempotent; call once at canvas init.
 *  - P1: node prototype `onDrawTitleText` + `onDrawTitleBox`
 *  - P2: dark node palette (LiteGraph constants) + ComfyUI `drawWidgets`
 *  - P3: `onDrawForeground` — execution-state border/banner (running/success/error)
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
		const state = getNodeState?.(String(this.properties?.['__sarosisId'] ?? this.id ?? ''));
		if (!state) { return; }
		const [w, h] = this.renderingSize ?? this.size ?? [0, 0];
		if (w <= 0 || h <= 0) { return; }
		drawNodeStateOverlay(ctx, w, h, state.runState, state.errorMsg);
	};
}
