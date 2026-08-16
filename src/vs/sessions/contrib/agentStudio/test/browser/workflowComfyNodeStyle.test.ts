/*---------------------------------------------------------------------------------------------
 *  Unit tests for comfyNodeStyle error overlay. Mocks CanvasRenderingContext2D
 *  to verify drawNodeErrorBanner / drawNodeStateOverlay skip the full-node
 *  red stroke (LiteGraph's `boxcolor` already turns red on error) and only
 *  paint the bottom banner.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { applyComfyNodeStyle, drawNodeErrorBanner, drawNodeStateOverlay, comfyTitleText, comfyDrawWidgets } from '../../webview/src/features/workflowEditor/comfyNodeStyle.js';

function makeCtx() {
	const calls: { method: string; args: unknown[] }[] = [];
	const fonts: string[] = [];
	const ctx = new Proxy({} as CanvasRenderingContext2D, {
		get(_t, prop: string) {
			if (prop === 'canvas') { return { width: 200, height: 200 }; }
			if (prop === 'font') { return fonts[fonts.length - 1] ?? ''; }
			if (prop === 'fillStyle' || prop === 'strokeStyle' || prop === 'textAlign' || prop === 'textBaseline') {
				return '';
			}
			if (prop === 'lineWidth') { return 1; }
			if (prop === 'measureText') {
				return (text: string) => { calls.push({ method: 'measureText', args: [text] }); return { width: String(text).length * 7 }; };
			}
			return (...args: unknown[]) => { calls.push({ method: prop, args }); };
		},
		set(_t, prop: string, value: unknown) {
			if (prop === 'font') { fonts.push(String(value)); }
			return true;
		},
	});
	return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, fonts };
}

suite('comfyNodeStyle — drawNodeErrorBanner', () => {

	test('does NOT stroke a full-node red border (LiteGraph boxcolor already turns red)', () => {
		const { ctx, calls } = makeCtx();
		drawNodeErrorBanner(ctx, 200, 300, 'API 500');
		const strokes = calls.filter(c => c.method === 'stroke');
		assert.strictEqual(strokes.length, 0, `expected no stroke() calls, got ${strokes.length}`);
	});

	test('fills the bottom banner', () => {
		const { ctx, calls } = makeCtx();
		drawNodeErrorBanner(ctx, 200, 300, 'Failed to fetch');
		const fills = calls.filter(c => c.method === 'fill');
		assert.ok(fills.length >= 1, 'expected at least one fill() for the banner');
		const r = calls.some(c => c.method === 'fillText' && String(c.args[0]).includes('Failed to fetch'));
		assert.ok(r, 'expected the error text to be drawn via fillText');
	});

	test('truncates long error messages with ellipsis', () => {
		const { ctx, calls } = makeCtx();
		const long = 'X'.repeat(120);
		drawNodeErrorBanner(ctx, 200, 300, long);
		const drawn = calls.find(c => c.method === 'fillText');
		assert.ok(drawn, 'expected fillText call');
		const text = String(drawn!.args[0]);
		assert.ok(text.length <= 60, 'expected truncated text');
		assert.ok(text.endsWith('…'), 'expected ellipsis at the end');
	});
});

suite('comfyNodeStyle — drawNodeStateOverlay', () => {

	test('error state: banner only, no full-node stroke', () => {
		const { ctx, calls } = makeCtx();
		drawNodeStateOverlay(ctx, 200, 300, 'error', 'boom');
		const strokes = calls.filter(c => c.method === 'stroke');
		assert.strictEqual(strokes.length, 0, `expected no stroke() for error, got ${strokes.length}`);
		assert.ok(calls.some(c => c.method === 'fillText' && String(c.args[0]).includes('boom')));
	});

	test('running state: single full-node stroke (no banner)', () => {
		const { ctx, calls } = makeCtx();
		drawNodeStateOverlay(ctx, 200, 300, 'running');
		const strokes = calls.filter(c => c.method === 'stroke');
		assert.strictEqual(strokes.length, 1, 'expected one full-node stroke for running');
		assert.ok(!calls.some(c => c.method === 'fillText'), 'running state should not draw any banner text');
	});

	test('success state: single full-node stroke (no banner)', () => {
		const { ctx, calls } = makeCtx();
		drawNodeStateOverlay(ctx, 200, 300, 'success');
		assert.strictEqual(calls.filter(c => c.method === 'stroke').length, 1);
		assert.ok(!calls.some(c => c.method === 'fillText'));
	});

	test('unknown state: no-op (no strokes, no banner)', () => {
		const { ctx, calls } = makeCtx();
		drawNodeStateOverlay(ctx, 200, 300, 'idle');
		assert.strictEqual(calls.filter(c => c.method === 'stroke').length, 0);
		assert.ok(!calls.some(c => c.method === 'fillText'));
	});
});

suite('comfyNodeStyle — comfyTitleText zoom consistency', () => {

	function drawTitle(scale: number) {
		const { ctx, calls, fonts } = makeCtx();
		comfyTitleText.call(
			{ title: '模型文生图', collapsed: false, outputs: [{ type: 'IMAGE' }, { type: 'ANY' }] },
			ctx, 30, [200, 120], scale,
		);
		return { calls, fonts };
	}

	test('font size is fixed (11px) regardless of scale — no quadratic zoom', () => {
		const sizes = [0.5, 1, 2].map(s => {
			const { fonts } = drawTitle(s);
			return fonts.find(f => f.startsWith('11px'));
		});
		assert.ok(sizes[0] && sizes[1] && sizes[2], 'expected font assignments');
		for (const f of sizes) { assert.ok(f!.startsWith('11px'), `expected 11px font, got ${f}`); }
	});

	test('collapse caret is drawn at the same canvas position for every zoom', () => {
		const xs = [0.5, 1, 2].map(s => {
			const { calls } = drawTitle(s);
			const ft = calls.find(c => c.method === 'fillText');
			return Number(ft?.args[1]);
		});
		assert.strictEqual(xs[0], xs[1]);
		assert.strictEqual(xs[1], xs[2]);
	});

	test('no right-aligned type chips are drawn (ComfyTV reference)', () => {
		// ComfyTV's title bar shows only the collapse caret + title — no
		// COMFYTV_IMAGES / COMFYTV_IMAGE chips. The chips crowded the title
		// and looked like internal implementation detail.
		const { calls } = drawTitle(1);
		const fillTexts = calls.filter(c => c.method === 'fillText');
		// Only 2 fillText calls: caret + title (no type chips).
		assert.strictEqual(fillTexts.length, 2, 'expected only caret + title, no type chips');
	});
});

suite('comfyNodeStyle — comfyDrawWidgets layout', () => {

	type FakeWidget = { y?: number; computedHeight?: number; name: string; value?: unknown; type?: string; label?: string; width?: number; disabled?: boolean; advanced?: boolean };
	function node({ widgets, size = [220, 100] }: { widgets: FakeWidget[]; size?: [number, number] }) {
		const node = {
			widgets,
			size,
			collapsed: false,
			isWidgetVisible() { return true; },
		};
		return node as unknown as {
			widgets: FakeWidget[]; size: [number, number]; collapsed: boolean;
			isWidgetVisible(): boolean;
		};
	}

	test('draws at arrange()-assigned widget.y (does NOT re-stack at 0)', () => {
		// Layout (widget.y / computedHeight) is owned by node.arrange(), which
		// runs in drawNode every frame. comfyDrawWidgets only *draws* at the
		// already-arranged position — it must never re-stack widgets at y=0.
		const { ctx, calls } = makeCtx();
		const arranged = [
			{ name: 'providerId', value: '', y: 30, computedHeight: 22 },
			{ name: 'modelId', value: '', y: 56, computedHeight: 22 },
		];
		const n = node({ widgets: arranged });
		comfyDrawWidgets.call(n, ctx, undefined);
		// label center y = widget.y + wH/2 = 30+11=41, 56+11=67.
		const labelYs = calls.filter(c => c.method === 'fillText').map(c => Number(c.args[2]));
		assert.ok(labelYs.includes(41), 'expected providerId label at y=41 (30 + 22/2)');
		assert.ok(labelYs.includes(67), 'expected modelId label at y=67 (56 + 22/2)');
		// arrange() stays the single source of truth: comfyDrawWidgets must not
		// mutate widget.y.
		assert.strictEqual(arranged[0].y, 30, 'providerId.y untouched');
		assert.strictEqual(arranged[1].y, 56, 'modelId.y untouched');
	});

	test('multiline widget (computedHeight>22) is vertically centered on computedHeight', () => {
		// A textarea widget reports computedHeight (>22) via arrange(); its
		// label must center on computedHeight, not the default 22.
		const { ctx, calls } = makeCtx();
		const arranged = [
			{ name: 'prompt', value: 'multi\nline', type: 'textarea', y: 30, computedHeight: 60 },
			{ name: 'size', value: '1024x1024', y: 92, computedHeight: 22 },
		];
		const n = node({ widgets: arranged });
		comfyDrawWidgets.call(n, ctx, undefined);
		const labelYs = calls.filter(c => c.method === 'fillText').map(c => Number(c.args[2]));
		// prompt label centers on 60 → 30 + 60/2 = 60; size → 92 + 22/2 = 103.
		assert.ok(labelYs.includes(60), 'expected multiline prompt label centered on computedHeight (y=60)');
		assert.ok(labelYs.includes(103), 'expected size label at y=103');
		const uniqueYs = new Set(labelYs);
		assert.ok(uniqueYs.size >= 2, 'expected distinct y values for the two widgets, no overlap');
	});

	test('does NOT grow node.size — arrange() owns sizing', () => {
		// Older behavior grew node.size inside comfyDrawWidgets; sizing now
		// lives in arrange()/computeSize. Guard against a regression that
		// would let comfyDrawWidgets mutate node.size again.
		const { ctx } = makeCtx();
		const n = node({
			widgets: [
				{ name: 'providerId', value: '' },
				{ name: 'modelId', value: '' },
				{ name: 'prompt', value: 'p', type: 'textarea' },
			],
			size: [220, 80],
		});
		comfyDrawWidgets.call(n, ctx, undefined);
		assert.strictEqual(n.size[1], 80, 'comfyDrawWidgets must not mutate node.size');
	});

	test('collapsed node skips widgets entirely', () => {
		const { ctx, calls } = makeCtx();
		const n = node({ widgets: [{ name: 'providerId', value: '' }] });
		n.collapsed = true;
		comfyDrawWidgets.call(n, ctx, undefined);
		assert.strictEqual(calls.length, 0, 'collapsed node should draw nothing');
	});

	test('dom widgets (addDOMWidget) are never re-positioned, drawn, or hit-testable', () => {
		const { ctx, calls } = makeCtx();
		const dom = { name: '__saros_form', type: 'dom', y: 52, computedHeight: 204, value: undefined };
		const text = { name: 'seed', value: 1 };
		const n = node({ widgets: [dom, text] });
		comfyDrawWidgets.call(n, ctx, undefined);
		assert.strictEqual(dom.y, 52, 'y stays at the arrange()-assigned position');
		assert.strictEqual(dom.computedHeight, 204, 'computedHeight untouched');
		assert.strictEqual((dom as { last_y?: number }).last_y, undefined,
			'no last_y → getWidgetOnPos never returns it → clicks fall through to the canvas (drag/select/dblclick preserved)');
		// Only the text widget paints (label + value); nothing drawn for 'dom'.
		const fillTexts = calls.filter(c => c.method === 'fillText').map(c => String(c.args[0]));
		assert.ok(fillTexts.includes('seed'), 'regular widget still drawn');
		assert.ok(!fillTexts.some(t => t.includes('saros_form')), 'dom widget not drawn on canvas');
	});
});

// ─── ctx that records fill/stroke state (not just call counts) ───────────────
function makeCtxFull() {
	const state: Record<string, unknown> = {};
	const calls: { method: string; args: unknown[] }[] = [];
	const ctx = new Proxy({} as CanvasRenderingContext2D, {
		get(_t, prop: string) {
			if (prop === 'canvas') { return { width: 200, height: 200 }; }
			if (prop === 'measureText') {
				return (text: string) => { calls.push({ method: 'measureText', args: [text] }); return { width: String(text).length * 7 }; };
			}
			if (prop in state) { return state[prop]; }
			return (...args: unknown[]) => { calls.push({ method: prop, args }); };
		},
		set(_t, prop: string, value: unknown) { state[prop] = value; return true; },
	});
	return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, state };
}

suite('comfyNodeStyle — applyComfyNodeStyle palette constants', () => {

	test('rewrites LiteGraph dark palette + title color', () => {
		// Mirrors the runtime canvas-init call (LiteGraphCanvas boot).
		// LiteGraph is passed by reference; we assert on the same object the
		// runtime would mutate, so a local mock captures the exact writes.
		const liteCanvas: Record<string, unknown> = {};
		const LiteGraphMock: Record<string, unknown> = {};
		const FakeNode = function () {} as unknown as { prototype: Record<string, unknown> };
		applyComfyNodeStyle(liteCanvas as never, FakeNode, LiteGraphMock as never);
		assert.strictEqual(liteCanvas['node_title_color'], '#e6e6e6', 'title text color is #e6e6e6');
		assert.strictEqual(LiteGraphMock['NODE_DEFAULT_COLOR'], '#2a2a2a', 'node default color dark');
		assert.strictEqual(LiteGraphMock['NODE_DEFAULT_BGCOLOR'], '#1f1f1f', 'node bg dark');
		assert.strictEqual(LiteGraphMock['NODE_DEFAULT_BOXCOLOR'], '#4a4a4a', 'node box dark');
		assert.strictEqual(LiteGraphMock['WIDGET_OUTLINE_COLOR'], '#3a3a3a', 'widget outline dark');
	});

	test('execution-state overlay stroke colors (running/success)', () => {
		const r = makeCtxFull();
		drawNodeStateOverlay(r.ctx, 220, 150, 'running');
		assert.strictEqual(r.state['strokeStyle'], '#4a9eff', 'running border is blue');
		const s = makeCtxFull();
		drawNodeStateOverlay(s.ctx, 220, 150, 'success');
		assert.strictEqual(s.state['strokeStyle'], '#2ecc71', 'success border is green');
	});
});
