/*---------------------------------------------------------------------------------------------
 *  Unit tests for domWidget — the addDOMWidget-style bridge: LiteGraph owns
 *  the widget-area layout (arrange/computeSize), the React card only renders
 *  content and feeds its measured height back.
 *  All helpers are pure / duck-typed so they run under the node test runner.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	DOM_FORM_WIDGET_NAME,
	DOM_WIDGET_TYPE,
	DOM_WIDGET_VPAD,
	estimateFormHeight,
	estimateFormTop,
	ensureDomFormWidget,
	getDomFormWidget,
	setDomFormContentHeight,
	markFormHeightDirty,
	takeFormHeightDirty,
	clearFormHeightDirty,
	type DomWidgetNode,
} from '../../webview/src/features/workflowEditor/comfyHost/domWidget.js';

/** Minimal fake node (no LiteGraph): widgets array + size + setSize. */
function fakeNode(): DomWidgetNode & { setSizeCalls: [number, number][] } {
	const setSizeCalls: [number, number][] = [];
	return {
		widgets: undefined,
		size: [230, 300],
		setSizeCalls,
		setSize(s: [number, number]) { setSizeCalls.push(s); this.size = s; },
		setDirtyCanvas() { /* no-op */ },
	};
}

suite('domWidget', () => {

	suite('estimates (pure)', () => {
		test('estimateFormHeight grows per control row and prompt', () => {
			const base = estimateFormHeight({ controlCount: 0, hasPrompt: false });
			const one = estimateFormHeight({ controlCount: 1, hasPrompt: false });
			const prompt = estimateFormHeight({ controlCount: 0, hasPrompt: true });
			assert.ok(one > base, 'more controls → taller');
			assert.ok(prompt > base, 'prompt adds height');
			assert.strictEqual(one - base, 28);
		});

		test('★ estimateFormTop 返回 body 相对坐标（max(ports) × SLOT_HEIGHT + 6）', () => {
			// ★ 契约同步（2026-09-11）：实现已改为 **body 相对坐标**（见 domWidget.ts
			//   注释：litegraph 0.17 的标题栏绘制在 pos[1] **之上** → node-local y=0
			//   是节点 body 顶部而非标题栏；`arrange()` 从 (slots bottom) + 2 =
			//   maxPorts × SLOT_HEIGHT + 6 开始排 widget，此处精确镜像该值）。
			//   旧期望「30 + title bar」已不适用。SLOT_HEIGHT = 20（模块内常量，未导出）。
			const SLOT = 20;
			assert.strictEqual(estimateFormTop(0, 0), 0 * SLOT + 6);
			assert.strictEqual(estimateFormTop(1, 1), 1 * SLOT + 6);
			assert.strictEqual(estimateFormTop(3, 1), estimateFormTop(1, 3), '取 input/output 较大者');
			assert.strictEqual(estimateFormTop(3, 1), 3 * SLOT + 6);
		});
	});

	suite('ensureDomFormWidget', () => {
		test('attaches one inert dom widget (push fallback path)', () => {
			const node = fakeNode();
			const w = ensureDomFormWidget(node, { estimateHeight: 200, estimateTop: 52 });
			assert.ok(node.widgets, 'widgets array created');
			assert.strictEqual(node.widgets!.length, 1);
			assert.strictEqual(w.type, DOM_WIDGET_TYPE);
			assert.strictEqual(w.name, DOM_FORM_WIDGET_NAME);
			assert.strictEqual(w.y, 52, 'initial y = estimated widget-area top');
			assert.strictEqual(w.userHeight, 200);
			assert.strictEqual(w.computedHeight, 200 + DOM_WIDGET_VPAD);
			assert.strictEqual(w.serialize, false, 'never persisted into the workflow JSON');
			assert.strictEqual(w.mouse(), false, 'pointer-inert: canvas drag/select keeps working');
			assert.doesNotThrow(() => w.draw());
			assert.deepStrictEqual(w.computeSize(210), [210, 200]);
		});

		test('uses addCustomWidget when available and is idempotent', () => {
			const node = fakeNode();
			const added: unknown[] = [];
			node.addCustomWidget = (w: unknown) => {
				added.push(w);
				node.widgets = node.widgets ?? [];
				node.widgets.push(w as never);
				return w;
			};
			const a = ensureDomFormWidget(node, { estimateHeight: 100, estimateTop: 32 });
			const b = ensureDomFormWidget(node, { estimateHeight: 999, estimateTop: 32 });
			assert.strictEqual(a, b, 'second call returns the existing widget');
			assert.strictEqual(added.length, 1, 'addCustomWidget used exactly once');
			assert.strictEqual(b.userHeight, 100, 'not overwritten by the second call');
		});
	});

	suite('setDomFormContentHeight', () => {
		test('feeds measured height into layout and resizes the node', () => {
			const node = fakeNode();
			const w = ensureDomFormWidget(node, { estimateHeight: 200, estimateTop: 52 });
			const changed = setDomFormContentHeight(node, 260.2);
			assert.strictEqual(changed, true);
			assert.strictEqual(w.userHeight, 261, 'rounded up');
			assert.strictEqual(w.computedHeight, 261 + DOM_WIDGET_VPAD);
			// node height = widget.y + content + bottom slack
			assert.deepStrictEqual(node.setSizeCalls.at(-1), [230, Math.ceil(52 + 261 + 8)]);
		});

		test('no-op when the height is unchanged', () => {
			const node = fakeNode();
			ensureDomFormWidget(node, { estimateHeight: 200, estimateTop: 52 });
			setDomFormContentHeight(node, 200);
			assert.strictEqual(setDomFormContentHeight(node, 200), false, 'same height → no resize');
		});

		test('clamps tiny contents to a sane minimum', () => {
			const node = fakeNode();
			const w = ensureDomFormWidget(node, { estimateHeight: 200, estimateTop: 52 });
			setDomFormContentHeight(node, 4);
			assert.strictEqual(w.userHeight, 40);
		});

		test('survives nodes without the widget / without a graph', () => {
			const node = fakeNode();
			assert.strictEqual(setDomFormContentHeight(node, 100), false);
			// arrange() throwing (NullGraphError when not attached) is tolerated
			const w = ensureDomFormWidget(node, { estimateHeight: 200, estimateTop: 52 });
			node.arrange = () => { throw new Error('NullGraphError'); };
			assert.strictEqual(setDomFormContentHeight(node, 300), true);
			assert.strictEqual(w.userHeight, 300);
		});
	});

	suite('dirty tracking', () => {
		test('mark → take once; take again is false; clear resets', () => {
			clearFormHeightDirty();
			assert.strictEqual(takeFormHeightDirty('n1'), false);
			markFormHeightDirty('n1');
			assert.strictEqual(takeFormHeightDirty('n1'), true, 'first take consumes');
			assert.strictEqual(takeFormHeightDirty('n1'), false, 'second take is clean');
			markFormHeightDirty('n2');
			clearFormHeightDirty('n2');
			assert.strictEqual(takeFormHeightDirty('n2'), false);
		});
	});

	suite('getDomFormWidget', () => {
		test('finds only the form widget', () => {
			const node = fakeNode();
			node.widgets = [{ type: 'text', name: 'prompt' } as never];
			assert.strictEqual(getDomFormWidget(node), undefined);
			const w = ensureDomFormWidget(node, { estimateHeight: 100, estimateTop: 32 });
			assert.strictEqual(node.widgets!.length, 2, 'coexists with canvas widgets');
			assert.strictEqual(getDomFormWidget(node), w);
		});
	});
});
