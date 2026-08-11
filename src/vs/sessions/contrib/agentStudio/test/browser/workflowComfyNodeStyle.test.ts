/*---------------------------------------------------------------------------------------------
 *  Unit tests for comfyNodeStyle error overlay. Mocks CanvasRenderingContext2D
 *  to verify drawNodeErrorBanner / drawNodeStateOverlay skip the full-node
 *  red stroke (LiteGraph's `boxcolor` already turns red on error) and only
 *  paint the bottom banner.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { drawNodeErrorBanner, drawNodeStateOverlay, comfyTitleText, comfyDrawWidgets } from '../../webview/src/features/workflowEditor/comfyNodeStyle.js';

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

	test('manually arranges widgets: widget.y is cumulative below title (no y=0 stacking)', () => {
		const { ctx, calls } = makeCtx();
		const n = node({
			widgets: [
				{ name: 'providerId', value: '' },
				{ name: 'modelId', value: '' },
			],
		});
		comfyDrawWidgets.call(n, ctx, undefined);
		// Two widgets → yCursor 30, 56 (30 + 26); label center y = yCursor + wH/2.
		const labelYs = calls.filter(c => c.method === 'fillText').map(c => Number(c.args[2]));
		assert.ok(labelYs.includes(43), 'expected providerId label at y=43 (30 + 26/2)');
		assert.ok(labelYs.includes(69), 'expected modelId label at y=69 (56 + 26/2)');
		assert.ok(!labelYs.every(y => y === 43), 'widgets must not all stack at the same y');
	});

	test('multiline widget (>22px) bumps next widget.y, no overlap', () => {
		const { ctx, calls } = makeCtx();
		const n = node({
			widgets: [
				{ name: 'prompt', value: 'multi\nline', type: 'textarea' },
				{ name: 'size', value: '1024x1024' },
			],
		});
		comfyDrawWidgets.call(n, ctx, undefined);
		// prompt widget uses computeSize() (returns ~60+4 for multiline). 2nd
		// widget must sit AFTER the first — not overlap at the same y.
		const labelYs = calls.filter(c => c.method === 'fillText').map(c => Number(c.args[2]));
		const uniqueYs = new Set(labelYs);
		assert.ok(uniqueYs.size >= 2, 'expected distinct y values for two widgets, no overlap');
	});

	test('node size is grown to wrap all widgets', () => {
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
		assert.ok(n.size[1] > 80, `expected size[1] to grow past 80, got ${n.size[1]}`);
	});

	test('collapsed node skips widgets entirely', () => {
		const { ctx, calls } = makeCtx();
		const n = node({ widgets: [{ name: 'providerId', value: '' }] });
		n.collapsed = true;
		comfyDrawWidgets.call(n, ctx, undefined);
		assert.strictEqual(calls.length, 0, 'collapsed node should draw nothing');
	});
});
