/*---------------------------------------------------------------------------------------------
 *  Unit tests for the M1 right-click menus — pure builders in menuItems.ts.
 *  Asserts the node menu mirrors litegraph's getMenuOptions semantics and the
 *  canvas menu keeps "Add Node…" as the search entry.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	buildNodeActions,
	buildCanvasActions,
	buildGroupActions,
	buildPortDisconnectAction,
	type NodeActionsContext,
	type NodeActionsHandlers,
} from '../../webview/src/features/workflowEditor/menuItems.js';
import { findLinkAt } from '../../webview/src/features/workflowEditor/LiteGraphCanvas.js';

function handlers(overrides: Partial<NodeActionsHandlers> = {}): NodeActionsHandlers {
	const noop = () => undefined;
	return {
		run: noop, editTitle: noop, toggleCollapse: noop, togglePin: noop,
		clone: noop, setColor: noop, openProperties: noop, remove: noop,
		...overrides,
	};
}

suite('menuItems (M1 right-click menus)', () => {

	suite('buildNodeActions', () => {
		function ctx(overrides: Partial<NodeActionsContext> = {}): NodeActionsContext {
			return {
				type: 'Saros.ModelImageGen', title: '模型文生图', kind: 'schema',
				pinned: false, collapsed: false, canRun: true, ...overrides,
			};
		}

		test('schema node: run → edit → clone/colors → properties → remove', () => {
			const ids = buildNodeActions(ctx(), handlers()).filter(i => !i.separator).map(i => i.id);
			assert.deepStrictEqual(ids, ['run', 'editTitle', 'collapse', 'pin', 'clone', 'colors', 'properties', 'remove']);
		});

		test('collapse/pin labels flip with state (litegraph semantics)', () => {
			const open = buildNodeActions(ctx(), handlers());
			assert.strictEqual(open.find(i => i.id === 'collapse')!.label, '折叠');
			assert.strictEqual(open.find(i => i.id === 'pin')!.label, '固定');
			const closed = buildNodeActions(ctx({ collapsed: true, pinned: true }), handlers());
			assert.strictEqual(closed.find(i => i.id === 'collapse')!.label, '展开');
			assert.strictEqual(closed.find(i => i.id === 'pin')!.label, '取消固定');
		});

		test('run only when canRun (schema); native keeps properties, legacy loses them', () => {
			const native = buildNodeActions(ctx({ kind: 'native', canRun: false }), handlers());
			assert.ok(!native.some(i => i.id === 'run'), 'native node has no run item');
			assert.ok(native.some(i => i.id === 'properties'), 'native node has properties');
			const legacy = buildNodeActions(ctx({ kind: 'legacy', canRun: false }), handlers());
			assert.ok(!legacy.some(i => i.id === 'properties'), 'legacy (no spec) node has no properties');
			assert.ok(legacy.some(i => i.id === 'remove'), 'legacy node can still be removed');
		});

		test('remove is danger; colors has a default + palette submenu', () => {
			const items = buildNodeActions(ctx(), handlers());
			const remove = items.find(i => i.id === 'remove')!;
			assert.strictEqual(remove.danger, true);
			const colors = items.find(i => i.id === 'colors')!;
			assert.ok(colors.submenu && colors.submenu.length >= 6, 'color palette submenu present');
			assert.strictEqual(colors.submenu![0].label, '默认');
		});

		test('handlers wire through to onPick', () => {
			let removed = false;
			const items = buildNodeActions(ctx(), handlers({ remove: () => { removed = true; } }));
			items.find(i => i.id === 'remove')!.onPick();
			assert.strictEqual(removed, true);
		});
	});

	suite('buildCanvasActions', () => {
		const H = {
			openNodeSearch: () => undefined, paste: () => undefined, addGroup: () => undefined,
			runWorkflow: () => undefined, resetView: () => undefined, alignSelected: () => undefined,
			convertToGroup: () => undefined, manageGroups: () => undefined,
			saveSelectedAsTemplate: () => undefined, openNodeTemplates: () => undefined,
		};

		test('ComfyUI order: Add Node / Add Group / Paste(cond) / Convert·Manage(disabled) / ┄ / Run/Reset / ┄ / Save Template / Templates', () => {
			const ids = buildCanvasActions({ selectedCount: 0, canPaste: false }, H).map(i => i.id);
			// Strip separator ids but keep their position to assert the layout.
			const flat = ids.filter(id => id !== 'sep0' && id !== 'sep1');
			assert.deepStrictEqual(flat, [
				'addNode', 'addGroup', 'convertToGroupNode', 'manageGroupNodes',
				'runWorkflow', 'resetView', 'saveSelectedAsTemplate', 'nodeTemplates',
			]);
			// Separators land between the three logical groups.
			assert.ok(ids.indexOf('sep0') > ids.indexOf('manageGroupNodes'));
			assert.ok(ids.indexOf('sep1') > ids.indexOf('resetView'));
		});

		test('Convert / Manage are always disabled (no sub-graph engine yet)', () => {
			const items = buildCanvasActions({ selectedCount: 0, canPaste: false }, H);
			assert.strictEqual(items.find(i => i.id === 'convertToGroupNode')!.disabled, true);
			assert.strictEqual(items.find(i => i.id === 'manageGroupNodes')!.disabled, true);
		});

		test('paste appears only when a clipboard exists', () => {
			assert.ok(!buildCanvasActions({ selectedCount: 0, canPaste: false }, H).some(i => i.id === 'paste'));
			assert.ok(buildCanvasActions({ selectedCount: 0, canPaste: true }, H).some(i => i.id === 'paste'));
		});

		test('align + convertToGroup appear only when >1 selected (M2)', () => {
			const one = buildCanvasActions({ selectedCount: 1, canPaste: false }, H);
			assert.ok(!one.some(i => i.id === 'align'));
			assert.ok(!one.some(i => i.id === 'convertToGroup'));
			const multi = buildCanvasActions({ selectedCount: 2, canPaste: false }, H);
			assert.ok(multi.some(i => i.id === 'align'));
			assert.ok(multi.some(i => i.id === 'convertToGroup'));
			assert.strictEqual(multi.find(i => i.id === 'align')!.label, '对齐网格');
		});

		test('saveSelectedAsTemplate disabled when 0 selected, enabled at 1+', () => {
			assert.strictEqual(
				buildCanvasActions({ selectedCount: 0, canPaste: false }, H)
					.find(i => i.id === 'saveSelectedAsTemplate')!.disabled, true);
			assert.strictEqual(
				buildCanvasActions({ selectedCount: 1, canPaste: false }, H)
					.find(i => i.id === 'saveSelectedAsTemplate')!.disabled, false);
		});
	});

	suite('buildGroupActions (M2, mirrors litegraph group.getMenuOptions)', () => {
		test('Pin ┄ Title / Color / Font size ┄ Remove', () => {
			const h = {
				editTitle: () => undefined, editFont: () => undefined, togglePin: () => undefined,
				setColor: () => undefined, remove: () => undefined,
			};
			const ids = buildGroupActions({ pinned: false, title: 'G' }, h).filter(i => !i.separator).map(i => i.id);
			assert.deepStrictEqual(ids, ['pin', 'title', 'color', 'font', 'remove']);
			const color = buildGroupActions({ pinned: false, title: 'G' }, h).find(i => i.id === 'color')!;
			assert.ok(color.submenu && color.submenu[0].label === '默认', 'color submenu starts with default');
			const rm = buildGroupActions({ pinned: false, title: 'G' }, h).find(i => i.id === 'remove')!;
			assert.strictEqual(rm.danger, true);
		});

		test('pin label flips with state; setColor(undefined) clears', () => {
			let color: string | undefined = '#123';
			const h = {
				editTitle: () => undefined, editFont: () => undefined, togglePin: () => undefined,
				setColor: (c) => { color = c; }, remove: () => undefined,
			};
			const pinned = buildGroupActions({ pinned: true, title: 'G' }, h);
			assert.strictEqual(pinned.find(i => i.id === 'pin')!.label, '取消固定');
			const colorItem = buildGroupActions({ pinned: false, title: 'G' }, h).find(i => i.id === 'color')!;
			colorItem.submenu![0].onPick();
			assert.strictEqual(color, undefined, 'default resets the group color');
		});
	});

	suite('buildPortDisconnectAction (M2)', () => {
		test('danger disconnect item wired to onPick', () => {
			let picked = false;
			const it = buildPortDisconnectAction({ input: true, slot: 0, links: [7] }, () => { picked = true; });
			assert.strictEqual(it.id, 'disconnectPort');
			assert.ok(it.label.includes('输入'), 'labels the input port');
			assert.strictEqual(it.danger, true);
			it.onPick();
			assert.strictEqual(picked, true);
		});
	});

	suite('findLinkAt (M2 link hit-testing)', () => {
		function makeFakeGraph(): { graph: unknown; link: { origin_id: number; origin_slot: number; target_id: number; target_slot: number } } {
			const link = { origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 };
			// Duck-typed LGraph/LGraphNode surface (getOutputPos/InputPos mirror
			// LiteGraph: output on the right edge, input on the left edge).
			const a = {
				getOutputPos: () => [100 + 140 - 15, 130], // [225, 130]
			};
			const b = {
				getInputPos: () => [400 - 15, 130], // [385, 130]
			};
			const graph = {
				links: new Map([[5, link]]),
				getNodeById: (id: number) => (id === 1 ? a : b),
			};
			return { graph, link };
		}

		test('hits the connection near its midpoint and misses off-curve', () => {
			const { graph, link } = makeFakeGraph();
			const hit = findLinkAt(graph as never, 300, 130, 12);
			assert.strictEqual(hit, link, 'link found near the midpoint');
			assert.strictEqual(findLinkAt(graph as never, 300, 220, 12), undefined, 'far off the curve → miss');
		});

		test('no links → undefined', () => {
			const graph = { links: new Map(), getNodeById: () => undefined };
			assert.strictEqual(findLinkAt(graph as never, 0, 0, 12), undefined);
		});

		test('skips links with missing nodes (getNodeById → undefined)', () => {
			const graph = {
				links: new Map([[1, { origin_id: 9, origin_slot: 0, target_id: 10, target_slot: 0 }]]),
				getNodeById: () => undefined,
			};
			assert.strictEqual(findLinkAt(graph as never, 0, 0, 12), undefined);
		});
	});
});
