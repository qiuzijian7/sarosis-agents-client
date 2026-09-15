/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { Orientation } from '../../../../../base/browser/ui/grid/grid.js';
import {
	AGENT_EDITOR_MIN_WIDTH,
	createAgentsLayoutGridDescriptor,
	EDITOR_MIN_WIDTH,
	IAgentsLayoutGridInput,
	PANEL_HEIGHT_RATIO,
	SIDEBAR_COLLAPSED_WIDTH,
} from '../../../../browser/layoutProfile.js';

/**
 * Agent 布局 grid 描述符的**纯函数**单测 —— 「IDE 底座 + Agent 布局」方案的行为基线。
 *
 * 为什么这里能跑而其它布局代码不能：`layoutProfile.ts` 刻意做到**零运行时 import**
 * （`Parts.*` / `Orientation.VERTICAL` / titlebar 高度全部由调用方注入）。它原本依赖的
 * `grid.js` / `layoutService.js` 在加载期引用 `window`，运行时 import 会 `window is not defined`。
 *
 * 测试设计：partIds / orientation / titleBarHeight 全部传**哨兵值**，再断言 grid 里出现的是
 * 注入值 —— 这样若有人把 `Parts.TITLEBAR_PART` 之类硬编码回函数内部，本文件当场失败。
 */

const SENTINEL_PARTS = {
	titleBar: '__titlebar__',
	sidebar: '__sidebar__',
	editor: '__editor__',
	panel: '__panel__',
	agentEditor: '__agentEditor__',
} as const;

const SENTINEL_ORIENTATION = '__vertical__' as unknown as Orientation;
const SENTINEL_TITLEBAR_HEIGHT = 37;

suite('Agents layout grid descriptor (pure)', () => {

	const base: IAgentsLayoutGridInput = {
		width: 1600,
		height: 1000,
		sidebarContentExpanded: true,
		sidebarExpandedWidth: 300,
		panelVisible: false,
		partIds: SENTINEL_PARTS,
		verticalOrientation: SENTINEL_ORIENTATION,
		titleBarHeight: SENTINEL_TITLEBAR_HEIGHT,
	};

	const kids = (node: any): any[] => node.data as any[];
	const contentRowOf = (grid: any): any => kids(grid.root)[1];
	const editorColumnOf = (grid: any): any => kids(contentRowOf(grid))[1];

	test('★ 注入值被原样使用（partIds / orientation / titleBarHeight 都没有硬编码）', () => {
		const grid = createAgentsLayoutGridDescriptor(base) as any;
		assert.strictEqual(grid.orientation, SENTINEL_ORIENTATION, 'orientation 应原样转发注入值');
		const [titleBar] = kids(grid.root);
		assert.strictEqual(titleBar.data.type, SENTINEL_PARTS.titleBar);
		assert.strictEqual(titleBar.size, SENTINEL_TITLEBAR_HEIGHT);
	});

	test('结构：Root(VERTICAL) = TitleBar + contentRow；contentRow = Sidebar | EditorColumn | AgentEditor', () => {
		const grid = createAgentsLayoutGridDescriptor(base) as any;
		assert.strictEqual(grid.width, 1600);
		assert.strictEqual(grid.height, 1000);
		assert.strictEqual(grid.root.type, 'branch');
		assert.strictEqual(grid.root.size, 1000, 'root 高度应为容器高度');

		const [sideBar, editorColumn, agentEditor] = kids(contentRowOf(grid));
		assert.deepStrictEqual(
			[sideBar.data.type, editorColumn.type, agentEditor.data.type],
			[SENTINEL_PARTS.sidebar, 'branch', SENTINEL_PARTS.agentEditor],
			'顺序必须是 Sidebar | EditorColumn | AgentEditor',
		);
	});

	test('EditorColumn(VERTICAL) = Editor + Panel', () => {
		const grid = createAgentsLayoutGridDescriptor(base) as any;
		const [editor, panel] = kids(editorColumnOf(grid));
		assert.strictEqual(editor.data.type, SENTINEL_PARTS.editor);
		assert.strictEqual(panel.data.type, SENTINEL_PARTS.panel);
	});

	test('★★ 侧栏节点始终 visible（回归护栏：曾把整个侧栏从 grid 移除）', () => {
		const collapsed = createAgentsLayoutGridDescriptor({ ...base, sidebarContentExpanded: false }) as any;
		const sideBar = kids(contentRowOf(collapsed))[0];
		assert.strictEqual(sideBar.visible, true, '折叠态侧栏仍必须留在 grid 里');
		assert.strictEqual(sideBar.size, SIDEBAR_COLLAPSED_WIDTH, '折叠态宽度 = 48px 图标条');
	});

	test('侧栏展开态宽度来自持久化的拖拽值', () => {
		const grid = createAgentsLayoutGridDescriptor({ ...base, sidebarExpandedWidth: 412 }) as any;
		assert.strictEqual(kids(contentRowOf(grid))[0].size, 412);
	});

	test('宽度规则：AgentEditor = max(480, width/2)；Editor = max(320, 剩余)', () => {
		const grid = createAgentsLayoutGridDescriptor(base) as any; // width=1600, sidebar=300
		assert.strictEqual(kids(contentRowOf(grid))[2].size, Math.max(AGENT_EDITOR_MIN_WIDTH, 800));
		assert.strictEqual(editorColumnOf(grid).size, Math.max(EDITOR_MIN_WIDTH, 1600 - 300 - 800));
	});

	test('★ 窄容器下宽度不出现负值（Editor 被下限兜住）', () => {
		const grid = createAgentsLayoutGridDescriptor({ ...base, width: 400, sidebarExpandedWidth: 300 }) as any;
		assert.ok(
			editorColumnOf(grid).size >= EDITOR_MIN_WIDTH,
			`Editor 宽度应被下限兜住，实际 ${editorColumnOf(grid).size}`,
		);
	});

	test('★ Panel 不可见 → size=0 且 visible=false（不是从 grid 移除）', () => {
		const hidden = createAgentsLayoutGridDescriptor({ ...base, panelVisible: false }) as any;
		const hiddenPanel = kids(editorColumnOf(hidden))[1];
		assert.strictEqual(hiddenPanel.visible, false);
		assert.strictEqual(hiddenPanel.size, 0);

		const shown = createAgentsLayoutGridDescriptor({ ...base, panelVisible: true }) as any;
		const shownPanel = kids(editorColumnOf(shown))[1];
		assert.strictEqual(shownPanel.visible, true);
		const contentHeight = base.height - SENTINEL_TITLEBAR_HEIGHT;
		assert.strictEqual(shownPanel.size, Math.round(contentHeight * PANEL_HEIGHT_RATIO));
	});

	test('Editor 高度 = contentHeight − panelHeight（panel 可见时被挤矮）', () => {
		const contentHeight = base.height - SENTINEL_TITLEBAR_HEIGHT;

		const hidden = createAgentsLayoutGridDescriptor({ ...base, panelVisible: false }) as any;
		assert.strictEqual(kids(editorColumnOf(hidden))[0].size, contentHeight, 'panel 隐藏时 editor 占满内容高度');

		const shown = createAgentsLayoutGridDescriptor({ ...base, panelVisible: true }) as any;
		assert.strictEqual(
			kids(editorColumnOf(shown))[0].size,
			contentHeight - Math.round(contentHeight * PANEL_HEIGHT_RATIO),
		);
	});

	test('纯函数：同一输入两次调用结果一致，且不修改入参', () => {
		const input: IAgentsLayoutGridInput = { ...base };
		assert.deepStrictEqual(
			createAgentsLayoutGridDescriptor(input),
			createAgentsLayoutGridDescriptor(input),
		);
		assert.deepStrictEqual(input, base, '入参不得被修改');
	});
});
