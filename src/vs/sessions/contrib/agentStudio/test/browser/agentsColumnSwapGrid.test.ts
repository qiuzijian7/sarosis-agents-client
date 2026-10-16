/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import {
	ISerializableView,
	Orientation,
	SerializableGrid,
} from '../../../../../base/browser/ui/grid/grid.js';
import { getAgentsEditorColumnTargetLocation } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { createAgentsLayoutGridDescriptor } from '../../../../browser/layoutProfile.js';

/**
 * ★★ 「编辑器列 ⇄ Agent 列」换位的**行为级**验证（2026-10-13）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 真机上的换位不是那个纯函数，而是两个窗口各自的一次
 * `grid.moveViewTo(agentView, getAgentsEditorColumnTargetLocation(side))`：
 *   - sessions 窗口：`sessions/browser/workbench.ts#moveAgentsEditorColumn()`
 *     ← **用户日常跑的就是这个窗口**（dev 页面 `sessions-dev.html`）；
 *   - 「IDE 底座 + Agent 布局」窗口：`workbench/browser/layout.ts#moveAgentsEditorColumn()`。
 *
 * 它的正确性取决于 grid 内部的下标推算（`GridView.moveViewTo` → `Grid.getViewLocation`
 * → `equals(sourceParentLocation, targetParentLocation)` → `BranchNode.moveChild`）。
 * 纯函数单测（`layoutProfile.test.ts`）**覆盖不到**这一段，而它恰是本方案的关键假设：
 * 「只挪 Agent 这一个叶子，编辑器列（含 Panel）就会**整体**让位」。
 *
 * ⚠ 本文件刻意覆盖**两种窗口形态**（见 `SHAPES`）：它们的 contentRow 子节点数**不同**
 *   （「IDE 底座」窗口尾部多两个不可见记账节点）—— 共享下标必须在这两种形态下都对。
 *
 * ⚠ 运行方式：agentStudio 的 browser runner（esbuild + jsdom，见 `domStub.mjs`）——
 *   `node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs <本文件>`
 *
 * ⚠ partId 用**哨兵值**而不是 `Parts.*`：`layoutProfile.ts` 的 id/orientation 全是注入的
 *   （它要求零运行时 import），照它的设计走才能既贴近生产用法又不引入多余依赖。
 */

/** 记录每次 `layout()` 入参的假视图 —— 断言的是**几何量**，不是内部树形。 */
class RecordingView implements ISerializableView {

	readonly element = document.createElement('div');
	readonly onDidChange = Event.None;

	readonly minimumWidth = 0;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;

	width = 0;
	height = 0;
	top = 0;
	left = 0;

	constructor(readonly id: string) { }

	layout(width: number, height: number, top: number, left: number): void {
		this.width = width;
		this.height = height;
		this.top = top;
		this.left = left;
	}

	toJSON(): object {
		return { type: this.id };
	}
}

const IDS = {
	titleBar: '__titlebar__',
	sidebar: '__sidebar__',
	editor: '__editor__',
	panel: '__panel__',
	agent: '__agent__',
	auxiliaryBar: '__aux__',
	statusBar: '__status__',
} as const;

const WIDTH = 1600;
const HEIGHT = 1000;

/**
 * 两种窗口形态。
 * - `sessions`：contentRow = [Sidebar, EditorColumn, Agent]（无记账节点）。
 * - `ide`：额外以 `visible:false, size:0` 追加 auxBar（contentRow 尾部）/ statusBar（根尾部），
 *   只为让标准 `Layout` 的记账找得到它们（见 `layoutProfile.ts` 的
 *   `includeLayoutBookkeepingParts`）—— 所以 `'right'` 的落点下标 2 在两个形态下都成立。
 */
const SHAPES = {
	sessions: { includeLayoutBookkeepingParts: false as const, partIds: {
		titleBar: IDS.titleBar,
		sidebar: IDS.sidebar,
		editor: IDS.editor,
		panel: IDS.panel,
		agentEditor: IDS.agent,
	} },
	ide: { includeLayoutBookkeepingParts: true as const, partIds: {
		titleBar: IDS.titleBar,
		sidebar: IDS.sidebar,
		editor: IDS.editor,
		panel: IDS.panel,
		agentEditor: IDS.agent,
		auxiliaryBar: IDS.auxiliaryBar,
		statusBar: IDS.statusBar,
	} },
} as const;

type ShapeName = keyof typeof SHAPES;

/** 按「窗口形态 + 方位」搭出**真实 grid**，返回句柄集合。 */
function buildGrid(shape: ShapeName, agentColumnSide: 'left' | 'right') {
	const views: Record<string, RecordingView> = {};
	for (const id of Object.values(IDS)) {
		views[id] = new RecordingView(id);
	}

	const descriptor = createAgentsLayoutGridDescriptor({
		width: WIDTH,
		height: HEIGHT,
		sidebarContentExpanded: true,
		sidebarExpandedWidth: 240,
		panelVisible: true,
		partIds: SHAPES[shape].partIds,
		verticalOrientation: Orientation.VERTICAL,
		titleBarHeight: 30,
		includeLayoutBookkeepingParts: SHAPES[shape].includeLayoutBookkeepingParts,
		agentColumnSide,
	});

	// ⚠ `fromJSON` 收到的是叶子的 `data`（即 `{ type: partId }`）—— 与生产同形
	// （`layout.ts:2288` / `sessions/browser/workbench.ts` 的 `fromJSON`）。
	const grid = SerializableGrid.deserialize(
		descriptor,
		{ fromJSON: (json: { type: string }) => views[json.type] },
		{ proportionalLayout: false },
	);
	grid.layout(WIDTH, HEIGHT);

	return { grid, views };
}

/**
 * ★ 生产代码的换位**原句**（两个窗口都是这一句）。
 * 抽成函数是为了让下面每条用例都用"生产会调用的那次调用"，而不是测试自己编一个。
 */
function applyProductionSwap(grid: SerializableGrid<ISerializableView>, views: Record<string, RecordingView>, side: 'left' | 'right'): void {
	grid.moveViewTo(views[IDS.agent], getAgentsEditorColumnTargetLocation(side));
}

/** 断言「编辑器列（含 Panel）与 Agent 列的相对位置」。 */
function assertLayout(
	views: Record<string, RecordingView>,
	expected: 'right' | 'left',
	label: string,
): void {
	// ⚠ 这张表是按 **partId**（`__sidebar__` …）建的，不是按语义名 —— 按语义名取会全 undefined。
	const sidebar = views[IDS.sidebar];
	const agent = views[IDS.agent];
	const editor = views[IDS.editor];
	const panel = views[IDS.panel];

	// 1) 侧栏恒在最左（Q1）
	assert.ok(sidebar.left < agent.left && sidebar.left < editor.left, `${label}: 侧栏必须仍在最左`);

	if (expected === 'right') {
		assert.ok(editor.left < agent.left, `${label}: 编辑器列应在 Agent 列**左**侧`);
	} else {
		assert.ok(agent.left < editor.left, `${label}: Agent 列应在编辑器列**左**侧`);
	}

	// 2) ★★ Panel 恒随编辑器列（Q2）：同 left、在 editor 下方、等宽
	assert.strictEqual(panel.left, editor.left, `${label}: Panel 必须与编辑器**同列**（不得跟着 Agent 列走）`);
	assert.ok(panel.top > editor.top, `${label}: Panel 必须在编辑器**下方**`);
	assert.strictEqual(panel.width, editor.width, `${label}: Panel 必须与编辑器**等宽**`);
}

suite('Agents column swap (real SerializableGrid)', () => {

	test('★ 共享落点函数：left ⇒ [1,1]、right ⇒ [1,3]（两个窗口共用这一处定义）', () => {
		// ⚠ `right` 是 3 而不是 2：`BranchNode.moveChild` 对**向前**移动会 `to -= 1`
		// （`gridview.ts:553-555`）⇒ 写 2 会被减成 1 ⇒ `moveChild(1,1)` 直接 return（点了没反应）。
		assert.deepStrictEqual(getAgentsEditorColumnTargetLocation('left'), [1, 1]);
		assert.deepStrictEqual(getAgentsEditorColumnTargetLocation('right'), [1, 3]);
	});

	for (const shape of Object.keys(SHAPES) as ShapeName[]) {
		suite(`窗口形态：${shape}`, () => {

			test('初始态：agentColumnSide 决定首帧顺序（无需任何重排）', () => {
				assertLayout(buildGrid(shape, 'right').views, 'right', `${shape} 初始 right`);
				assertLayout(buildGrid(shape, 'left').views, 'left', `${shape} 初始 left`);
			});

			test('★★ 运行时：right → left（生产原句：moveViewTo + 共享落点）', () => {
				const { grid, views } = buildGrid(shape, 'right');
				assertLayout(views, 'right', `${shape} 交换前`);

				applyProductionSwap(grid, views, 'left');

				assertLayout(views, 'left', `${shape} 交换后`);
			});

			test('★★ 运行时：left → right（生产原句：moveViewTo + 共享落点）', () => {
				const { grid, views } = buildGrid(shape, 'left');
				assertLayout(views, 'left', `${shape} 交换前`);

				applyProductionSwap(grid, views, 'right');

				assertLayout(views, 'right', `${shape} 交换后`);
			});

			test('★ 来回交换幂等：right → left → right 回到原位置（含宽度）', () => {
				const { grid, views } = buildGrid(shape, 'right');
				const before = { left: views[IDS.agent].left, width: views[IDS.agent].width };

				applyProductionSwap(grid, views, 'left');
				assertLayout(views, 'left', `${shape} 去左`);

				applyProductionSwap(grid, views, 'right');
				assertLayout(views, 'right', `${shape} 回右`);

				assert.strictEqual(views[IDS.agent].left, before.left, '来回一次后 Agent 列应回到原位置');
				assert.strictEqual(views[IDS.agent].width, before.width, '宽度也应回到原值');
			});
		});
	}

	test('★ 「IDE 底座」形态：记账叶子不参与换位（auxBar 恒最右、statusBar 恒最下）', () => {
		const { grid, views } = buildGrid('ide', 'right');
		applyProductionSwap(grid, views, 'left');

		assert.ok(views[IDS.auxiliaryBar].left > views[IDS.editor].left, 'auxBar 必须仍在最右（换位不得把它带偏）');
		assert.ok(views[IDS.statusBar].top > views[IDS.editor].top, 'statusBar 必须仍在最下');
	});
});
