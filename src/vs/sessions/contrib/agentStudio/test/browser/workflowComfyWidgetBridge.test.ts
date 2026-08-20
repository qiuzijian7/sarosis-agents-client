/*---------------------------------------------------------------------------------------------
 *  Unit tests for widgetBridge — React card overlay positioning over LiteGraph nodes.
 *  `nodeToOverlayRect` is pure math; `createWidgetBridgeHost` uses a fake DOM layer
 *  (the node test runner has no real `document`).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	nodeToOverlayRect,
	createWidgetBridgeHost,
	attachOverlayLayer,
	widgetAreaInsets,
	LITEGRAPH_TITLE_HEIGHT,
	LITEGRAPH_SLOT_HEIGHT,
	type MinimalDocument,
} from '../../webview/src/features/workflowEditor/comfyHost/widgetBridge.js';

/** Minimal fake DOM element + document used by the bridge. */
class FakeElement {
	private _style: Record<string, string> = {};
	dataset: Record<string, string> = {};
	className = '';
	children: FakeElement[] = [];
	parent: FakeElement | null = null;

	get style(): Record<string, string> {
		const target = this._style;
		return new Proxy(target, {
			get(t, k) { return t[String(k)]; },
			set(t, k, v) { t[String(k)] = String(v); return true; },
		});
	}
	// Simulate CSSStyleDeclaration.cssText parsing so `el.style.cssText = 'a:1;b:2'` works.
	get cssText(): string {
		return Object.entries(this._style).map(([k, v]) => `${k}:${v}`).join(';');
	}
	set cssText(v: string) {
		for (const part of v.split(';')) {
			const idx = part.indexOf(':');
			if (idx < 0) { continue; }
			const k = part.slice(0, idx).trim();
			const val = part.slice(idx + 1).trim();
			if (k) { this._style[k] = val; }
		}
	}

	appendChild(child: FakeElement): void {
		child.parent = this;
		this.children.push(child);
	}
	remove(): void {
		if (this.parent) {
			const i = this.parent.children.indexOf(this);
			if (i >= 0) { this.parent.children.splice(i, 1); }
			this.parent = null;
		}
	}
	querySelectorAll(sel: string): FakeElement[] {
		const results: FakeElement[] = [];
		const walk = (el: FakeElement) => {
			if (el.className.split(' ').includes(sel.slice(1))) { results.push(el); }
			for (const c of el.children) { walk(c); }
		};
		for (const c of this.children) { walk(c); }
		return results;
	}
}

const fakeDocument: MinimalDocument = {
	createElement: () => new FakeElement() as unknown as HTMLElement,
	querySelectorAll: () => ([] as unknown) as NodeListOf<Element>,
};

suite('widgetBridge', () => {

	suite('widgetAreaInsets (LiteGraph widget area)', () => {

		test('top clears the title bar plus one row per port pair', () => {
			// LiteGraph stacks input/output slots vertically under the title bar,
			// so the card must start below max(inputs, outputs) rows or it paints
			// over the pins.
			assert.strictEqual(widgetAreaInsets(0, 0).top, LITEGRAPH_TITLE_HEIGHT);
			assert.strictEqual(widgetAreaInsets(1, 1).top, LITEGRAPH_TITLE_HEIGHT + LITEGRAPH_SLOT_HEIGHT);
			assert.strictEqual(widgetAreaInsets(2, 2).top, LITEGRAPH_TITLE_HEIGHT + 2 * LITEGRAPH_SLOT_HEIGHT);
		});

		test('row count uses the larger of inputs/outputs', () => {
			assert.strictEqual(widgetAreaInsets(3, 1).top, widgetAreaInsets(1, 3).top);
			assert.strictEqual(widgetAreaInsets(3, 1).top, LITEGRAPH_TITLE_HEIGHT + 3 * LITEGRAPH_SLOT_HEIGHT);
		});

		test('side insets match BaseWidget.margin so port circles stay clear', () => {
			// Port circles are drawn at x = NODE_SLOT_HEIGHT/2 = 10 with radius
			// 4–5, spanning x = 5..15 — a 15px inset never covers them.
			const insets = widgetAreaInsets(1, 1);
			assert.strictEqual(insets.left, 15);
			assert.strictEqual(insets.right, 15);
			assert.strictEqual(insets.bottom, 8);
		});
	});

	suite('nodeToOverlayRect (pure math)', () => {

		test('identity viewport maps 1:1', () => {
			const rect = nodeToOverlayRect({ pos: [100, 200], size: [220, 150] }, { x: 0, y: 0, scale: 1 });
			assert.deepStrictEqual(rect, { left: 100, top: 200, width: 220, height: 150 });
		});

		test('scale multiplies position and size', () => {
			const rect = nodeToOverlayRect({ pos: [100, 200], size: [220, 150] }, { x: 0, y: 0, scale: 2 });
			assert.deepStrictEqual(rect, { left: 200, top: 400, width: 440, height: 300 });
		});

		test('offset (drag) translates', () => {
			const rect = nodeToOverlayRect({ pos: [100, 200] }, { x: 50, y: -30, scale: 1 });
			assert.deepStrictEqual(rect, { left: 150, top: 170, width: 220, height: 150 });
		});

		test('missing size uses defaults', () => {
			const rect = nodeToOverlayRect({ pos: [0, 0] }, { x: 0, y: 0, scale: 1 }, 240, 160);
			assert.strictEqual(rect.width, 240);
			assert.strictEqual(rect.height, 160);
		});
	});

	suite('createWidgetBridgeHost (DOM layer)', () => {

		test('sync creates positioned containers', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'n1', node: { pos: [10, 20], size: [100, 80] } },
			], { x: 5, y: 5, scale: 1 });

			const el = (layer as unknown as FakeElement).children[0];
			assert.ok(el, 'container should exist');
			// nodeToOverlayRect: left=(10+5)*1=15, top=(20+5)*1=25.
			// Default insets are GRAPH units mirroring LiteGraph's widget area:
			// left/right = BaseWidget.margin (15), top = NODE_TITLE_HEIGHT (30) +
			// one slot row (20) = 50, bottom = 8.
			// left = 15 + 15*1 = 30, top = 25 + 50*1 = 75, width = 100-30 = 70.
			assert.strictEqual(el.style.left, '30px');
			assert.strictEqual(el.style.top, '75px');
			assert.strictEqual(el.style.width, '70px');
			assert.strictEqual(el.style.display, 'block');
		});

		test('insets are graph units so the card stays on the widget area when zoomed', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'n', node: { pos: [10, 20], size: [100, 80] } },
			], { x: 5, y: 5, scale: 2 });
			const el = (layer as unknown as FakeElement).children[0];
			// rect.left=(10+5)*2=30, rect.top=(20+5)*2=50. The inset is scaled
			// with the zoom (30 + 15*2 = 60 / 50 + 50*2 = 150) — a screen-px
			// inset would drift off the ports as soon as the zoom changed.
			assert.strictEqual(el.style.left, '60px');
			assert.strictEqual(el.style.top, '150px');
			// Design px (unscaled) = node size minus the graph-unit insets.
			assert.strictEqual(el.style.width, '70px');
			assert.strictEqual(el.style.height, '22px');
			assert.strictEqual(el.style.transform, 'scale(2)');
			assert.strictEqual(el.style.transformOrigin, '0 0');
		});

		test('widgetRect (addDOMWidget): top/height come from LiteGraph layout, not insets', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			// widget.y=52 / computedHeight=204 as assigned by node.arrange()
			host.sync([
				{ id: 'w', node: { pos: [10, 20], size: [100, 300] }, widgetRect: { y: 52, height: 204 } },
			], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			// Flush with the node body: NodeCard's root uses an INSET box-shadow
			// (not a `border`), so same-width == pixel-aligned with the node bg.
			assert.strictEqual(el.style.left, '10px', 'left = node.left — widgetRect mode is flush so edges align with the node background');
			assert.strictEqual(el.style.top, '72px', 'top = node.top + widget.y');
			assert.strictEqual(el.style.width, '100px', 'width = full node width — a side margin would leave the node bg visible as a gutter');
			assert.strictEqual(el.style.height, '204px', 'height = widget.computedHeight (not node - insets)');
		});

		test('widgetRect mode clips the container (content never paints outside node bounds)', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'w', node: { pos: [10, 20], size: [100, 300] }, widgetRect: { y: 52, height: 204 } },
			], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			assert.strictEqual(el.style.overflow, 'hidden', 'widgetRect mode must clip — card content can never spill past the node rect');
		});

		test('card always clips to the node rect (overflow:hidden) — prevents spill over neighbors', () => {
			// 语义（2026-08-19 澄清）：DOM overlay 整体压在 canvas 之上，卡片内容
			// 必须裁剪到自己的 node rect，否则下层节点的 DOM 卡片会溢出盖到上层
			// 节点（「右侧节点 DOM 溢出盖住左侧节点 widget」）。无条件 overflow:hidden。
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'n', node: { pos: [10, 20], size: [100, 300] } },
			], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			assert.strictEqual(el.style.overflow, 'hidden');
		});

		test('widgetRect scales with zoom: position in screen px, size in design units', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'w', node: { pos: [10, 20], size: [100, 300] }, widgetRect: { y: 52, height: 204 } },
			], { x: 5, y: 5, scale: 2 });
			const el = (layer as unknown as FakeElement).children[0];
			// rect.left=(10+5)*2=30, rect.top=(20+5)*2=50; y inset = 52*2=104
			assert.strictEqual(el.style.left, '30px');
			assert.strictEqual(el.style.top, '154px');
			assert.strictEqual(el.style.height, '204px', 'design units — transform: scale does the zoom');
			assert.strictEqual(el.style.transform, 'scale(2)');
		});

		test('fullCover keeps the top inset from widgetRect (ports stay visible)', () => {
			// 语义（2026-08-19 澄清）：fullCover 的「顶部绝不能归零」——LiteGraph 0.17
			// 坐标原点是 body 顶，端口行在 body 内 y=(i+0.7)*20，top=0 会把端口圆点
			// 整行盖住。widgetRect.y 来自 arrange() 分配，必在端口行下方。
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'fc', node: { pos: [0, 0], size: [230, 320] }, fullCover: true, widgetRect: { y: 52, height: 204 } },
			], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			assert.strictEqual(el.style.top, '52px', 'top = widgetRect.y（端口行下方）');
			assert.strictEqual(el.style.height, '204px', 'height = widgetRect.height（LiteGraph 布局值）');
		});

		test('explicit insets override the defaults', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'n', node: { pos: [0, 0], size: [200, 200] }, insets: { left: 10, right: 20, top: 40, bottom: 5 } },
			], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			assert.strictEqual(el.style.left, '10px');
			assert.strictEqual(el.style.top, '40px');
			assert.strictEqual(el.style.width, '170px');  // 200 - 10 - 20
			assert.strictEqual(el.style.height, '155px'); // 200 - 40 - 5
		});

		test('fullCover at non-1 scale: sides flush, top inset reserved, design-unit zoom', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'fc', node: { pos: [0, 0], size: [230, 320] }, fullCover: true },
			], { x: 0, y: 0, scale: 0.5 });
			const el = (layer as unknown as FakeElement).children[0];
			// fullCover：左右铺满（inset 0），顶部仍让开端口行（DEFAULT_TOP_INSET=50），
			// 所以 height = 320 - 50 - 0(bottom) = 270。宽度/高度是 design 单位，
			// 由 transform:scale(0.5) 缩放。
			assert.strictEqual(el.style.width, '230px');
			assert.strictEqual(el.style.height, '270px');
			assert.strictEqual(el.style.transform, 'scale(0.5)');
		});

		test('ensureContainer reuses existing container', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			const a = host.ensureContainer('dup');
			const b = host.ensureContainer('dup');
			assert.strictEqual(a, b);
			assert.strictEqual((layer as unknown as FakeElement).children.length, 1);
		});

		test('sync hides containers for removed nodes', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([{ id: 'gone', node: { pos: [0, 0] } }], { x: 0, y: 0, scale: 1 });
			host.sync([], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			assert.strictEqual(el.style.display, 'none');
		});

		test('releaseContainer detaches the card (collapsed node path)', () => {
			// LiteGraphCanvas skips the overlay for collapsed nodes; it must
			// also tear down any card that was previously rendered, otherwise
			// the parameter panel stays visible below the collapsed title bar.
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([{ id: 'c', node: { pos: [0, 0] } }], { x: 0, y: 0, scale: 1 });
			assert.strictEqual((layer as unknown as FakeElement).children.length, 1, 'card attached after sync');
			host.releaseContainer('c');
			// releaseContainer removes the DOM node entirely (not just hides)
			// so the parameter panel truly disappears.
			assert.strictEqual((layer as unknown as FakeElement).children.length, 0, 'card detached after releaseContainer');
			// And the slot is reusable — re-syncing the same id brings the
			// card back instead of leaking a fresh DOM node each time.
			host.sync([{ id: 'c', node: { pos: [0, 0] } }], { x: 0, y: 0, scale: 1 });
			assert.strictEqual((layer as unknown as FakeElement).children.length, 1, 're-sync recreates the container');
		});

		test('releaseContainer removes DOM', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.ensureContainer('rm');
			host.releaseContainer('rm');
			assert.strictEqual((layer as unknown as FakeElement).children.length, 0);
		});

		test('ensureContainer defaults z-index to 1 (cards can be lifted via style.zIndex)', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			const el = host.ensureContainer('z');
			assert.strictEqual(el.style.zIndex, '1');
		});

		test('fullCover + selected draws a DOM selection ring (canvas stroke would be clipped by other cards)', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'sel', node: { pos: [0, 0], size: [230, 320] }, fullCover: true, selected: true },
			], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			assert.strictEqual(el.style.boxShadow, '0 0 0 2px rgba(255,255,255,0.9)');
			assert.strictEqual(el.style.borderRadius, '8px');
		});

		test('deselected / non-fullCover nodes get no DOM ring', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'a', node: { pos: [0, 0] }, fullCover: true, selected: false },
				{ id: 'b', node: { pos: [400, 0] }, fullCover: false, selected: true },
			], { x: 0, y: 0, scale: 1 });
			const els = (layer as unknown as FakeElement).children;
			assert.strictEqual(els[0].style.boxShadow, 'none');
			assert.strictEqual(els[1].style.boxShadow, 'none');
		});

		test('ring clears when selection is removed on a later sync', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([{ id: 'n', node: { pos: [0, 0] }, fullCover: true, selected: true }], { x: 0, y: 0, scale: 1 });
			host.sync([{ id: 'n', node: { pos: [0, 0] }, fullCover: true, selected: false }], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			assert.strictEqual(el.style.boxShadow, 'none');
		});

		test('execution-state ring: error > selected; running/success colors; state wins over selection', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'err', node: { pos: [0, 0] }, fullCover: true, selected: true, state: 'error' },
				{ id: 'run', node: { pos: [400, 0] }, fullCover: true, state: 'running' },
				{ id: 'ok', node: { pos: [800, 0] }, fullCover: true, state: 'success' },
				{ id: 'idle', node: { pos: [1200, 0] }, fullCover: true, state: 'idle' },
			], { x: 0, y: 0, scale: 1 });
			const els = (layer as unknown as FakeElement).children;
			// error wins over the white selection ring
			assert.strictEqual(els[0].style.boxShadow, '0 0 0 2px rgba(255,91,91,0.95)');
			assert.strictEqual(els[1].style.boxShadow, '0 0 0 2px rgba(74,158,255,0.95)');
			assert.strictEqual(els[2].style.boxShadow, '0 0 0 2px rgba(46,204,113,0.95)');
			// unknown state → no state ring (and not selected → no ring)
			assert.strictEqual(els[3].style.boxShadow, 'none');
		});

		test('state ring only applies to fullCover nodes', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'native', node: { pos: [0, 0] }, fullCover: false, state: 'error' },
			], { x: 0, y: 0, scale: 1 });
			const el = (layer as unknown as FakeElement).children[0];
			assert.strictEqual(el.style.boxShadow, 'none');
		});
	});

	suite('attachOverlayLayer', () => {

		test('creates a positioned overlay in the canvas container', () => {
			const container = new FakeElement() as unknown as HTMLElement;
			const { layer, destroy } = attachOverlayLayer(container, fakeDocument);
			const fake = layer as unknown as FakeElement;
			assert.ok(fake.className.includes('wf-comfy-overlay'));
			assert.strictEqual(fake.style.position, 'absolute');
			assert.strictEqual(fake.style.pointerEvents, 'none');
			destroy();
			assert.strictEqual((container as unknown as FakeElement).children.length, 0);
		});

		test('reuses existing overlay layer', () => {
			const container = new FakeElement() as unknown as HTMLElement;
			const first = attachOverlayLayer(container, fakeDocument);
			const second = attachOverlayLayer(container, fakeDocument);
			assert.strictEqual(first.layer, second.layer);
			assert.strictEqual((container as unknown as FakeElement).children.length, 1);
			first.destroy();
			second.destroy();
		});
	});
});
