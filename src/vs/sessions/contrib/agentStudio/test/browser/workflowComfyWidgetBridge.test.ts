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
			// WidgetBridge insets leave room for LiteGraph's port dots (8px) and
			// title bar (~22px): left = 15+8=23, top = 25+22=47.
			assert.strictEqual(el.style.left, '23px');
			assert.strictEqual(el.style.top, '47px');
			assert.strictEqual(el.style.width, '84px');
			assert.strictEqual(el.style.display, 'block');
		});

		test('sync keeps DESIGN size + transform scale so card content zooms as one unit', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'n', node: { pos: [10, 20], size: [100, 80] } },
			], { x: 5, y: 5, scale: 2 });
			const el = (layer as unknown as FakeElement).children[0];
			// rect.left=(10+5)*2=30 → left=30+8=38; rect.top=50 → top=50+22=72.
			assert.strictEqual(el.style.left, '38px');
			assert.strictEqual(el.style.top, '72px');
			// Design px (unscaled): width = 100 - 2*(8/2)=92; height = 80 - 22/2 - 8/2 = 65.
			assert.strictEqual(el.style.width, '92px');
			assert.strictEqual(el.style.height, '65px');
			assert.strictEqual(el.style.transform, 'scale(2)');
			assert.strictEqual(el.style.transformOrigin, '0 0');
		});

		test('fullCover at non-1 scale: design px = node size, insets convert back to screen px', () => {
			const layer = new FakeElement() as unknown as HTMLElement;
			const host = createWidgetBridgeHost(layer, fakeDocument);
			host.sync([
				{ id: 'fc', node: { pos: [0, 0], size: [230, 320] }, fullCover: true },
			], { x: 0, y: 0, scale: 0.5 });
			const el = (layer as unknown as FakeElement).children[0];
			// side inset 8/0.5=16 design px each side; top/bottom insets = 0.
			assert.strictEqual(el.style.width, '198px');
			assert.strictEqual(el.style.height, '320px');
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
