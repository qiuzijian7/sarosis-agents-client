/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISerializedGrid, ISerializedLeafNode, ISerializedNode, Orientation } from '../../base/browser/ui/grid/grid.js';

/**
 * Agent 布局（Agents 窗口 / 目标：标准 IDE 底座上的 Agent 布局）的 **grid 描述符**。
 *
 * ## 为什么单独成文件
 *
 * 这套 grid 原本内联在 `sessions/browser/workbench.ts` 的
 * `createDesktopGridDescriptor()` 里 —— 96 行、只依赖 3 个状态值，本质是**纯数据构造**。
 * 抽出来的目的：让「IDE 底座 + Agent 布局」方案能把同一套布局**复用到标准 workbench**，
 * 而不必复制粘贴（复制出来的第二份必然漂移）。
 *
 * ## ★ 为什么 `Parts` / `Orientation` / titlebar 高度是**注入**的
 *
 * `Parts` 来自 `workbench/services/layout/browser/layoutService.js`、
 * `Orientation` 来自 `base/browser/ui/grid/grid.js` —— 这两个模块**在加载期就引用 `window`**
 * （`var mainWindow = window`）。只要本文件运行时 import 它们，就**无法在 node 测试环境里单测**
 * （实测 `ReferenceError: window is not defined`）。
 *
 * 所以这里全部改为**参数注入**，本模块只保留 `import type`（编译期擦除）⇒ **零运行时 import**
 * ⇒ 可直接单测（见 `test/browser/layoutProfile.test.ts`）。注入点见
 * `workbench.ts#createDesktopGridDescriptor`。
 *
 * ## 布局结构
 *
 * ```
 * Root (VERTICAL)
 * ├─ TitleBar                [height = titleBarHeight, 全宽]
 * └─ contentRow (HORIZONTAL) [height = height - titleBarHeight]
 *     ├─ Sidebar             [width = 展开宽 或 48px 图标条]
 *     ├─ EditorColumn (VERTICAL) [width = 剩余宽度]
 *     │   ├─ Editor（文件区）  [height = contentHeight - panelHeight]
 *     │   └─ Panel            [height = 35% × contentHeight，不可见时为 0]
 *     └─ AgentEditor         [width = max(480, width/2)]
 * ```
 *
 * ⚠ 与标准 workbench 的差异（复用时必须处理）：标准 workbench 还有
 * `ACTIVITYBAR_PART` / `AUXILIARYBAR_PART` / `STATUSBAR_PART`，且侧栏与 activity bar 是**两个**
 * grid 节点；本 profile 把 activity bar 折进 Sidebar（48px 折叠态）。
 */

/** 侧栏折叠（只剩 activity bar 图标条）时的宽度。 */
export const SIDEBAR_COLLAPSED_WIDTH = 48;

/** Agent 编辑器区最小宽度 —— 低于此值画布/聊天不可用。 */
export const AGENT_EDITOR_MIN_WIDTH = 480;

/** 文件编辑器区最小宽度。 */
export const EDITOR_MIN_WIDTH = 320;

/** 面板高度占内容高度的比例。 */
export const PANEL_HEIGHT_RATIO = 0.35;

/** 本布局用到的部件 id（由调用方注入 `Parts.*`）。 */
export interface IAgentsLayoutPartIds {
	readonly titleBar: string;
	readonly sidebar: string;
	readonly editor: string;
	readonly panel: string;
	readonly agentEditor: string;

	// ★ 以下三个**只在本 profile 被标准 workbench 复用时**才需要，
	// 见 `IAgentsLayoutGridEnv.includeLayoutBookkeepingParts`。sessions 窗口不需要。
	readonly activityBar?: string;
	readonly auxiliaryBar?: string;
	readonly statusBar?: string;
}

/**
 * 环境常量注入 —— 目的是让本模块**零运行时 import**（见文件头说明）。
 */
export interface IAgentsLayoutGridEnv {
	readonly partIds: IAgentsLayoutPartIds;
	/** `Orientation.VERTICAL`。 */
	readonly verticalOrientation: Orientation;
	/** `DEFAULT_CUSTOM_TITLEBAR_HEIGHT`。 */
	readonly titleBarHeight: number;

	/**
	 * ★ 是否为**标准 workbench** 补上它记账所需的部件节点（activity bar / aux bar / statusbar）。
	 *
	 * 标准 `Layout` 的记账逻辑**假设「8 部件全集都在 grid 里」**：
	 * - `getMaximumEditorDimensions()` 读 `activityBarPartView.minimumWidth`；
	 * - `createWorkbenchLayout()` 注册的 `storageService.onWillSaveState` 处理器读
	 *   `workbenchGrid.getViewCachedVisibleSize(auxiliaryBarPartView)` —— 该方法**本就是
	 *   给隐藏视图用的**，但视图必须先存在于 grid，否则抛 `View not found`。
	 *
	 * 所以被标准 workbench 复用时，这三个部件要以 `visible: false` + `size: 0` 挂进 grid：
	 * 不占空间、不影响外观，只让 `Layout` 的记账找得到它们。
	 *
	 * sessions 窗口**不开**（它整套 `Layout` 都换掉了，不吃这套记账）。
	 */
	readonly includeLayoutBookkeepingParts?: boolean;
}

/** {@link createAgentsLayoutGridDescriptor} 的输入。 */
export interface IAgentsLayoutGridInput extends IAgentsLayoutGridEnv {
	/** 主容器宽度（px）。 */
	readonly width: number;
	/** 主容器高度（px）。 */
	readonly height: number;
	/**
	 * 侧栏**内容区**是否展开。
	 *
	 * ⚠ 这**不是**「侧栏是否可见」：48px 的 activity bar 图标条永不折叠，
	 * 侧栏节点在 grid 里**始终 visible**（历史缺陷：曾用 `visible: partVisibility.sidebar`
	 * 把整个侧栏从 grid 移除，导致重启后左侧栏完全消失）。
	 */
	readonly sidebarContentExpanded: boolean;
	/** 侧栏展开态宽度（来自持久化的用户拖拽结果）。 */
	readonly sidebarExpandedWidth: number;
	/** 面板是否可见（隐藏时高度为 0，而不是从 grid 移除）。 */
	readonly panelVisible: boolean;
}

/**
 * 构造 Agent 布局的 grid 描述符。
 *
 * **纯函数**：不读 `this`、不碰 DOM、无副作用、不修改入参 ⇒ 可直接单测。
 */
export function createAgentsLayoutGridDescriptor(input: IAgentsLayoutGridInput): ISerializedGrid {
	const {
		width, height, sidebarContentExpanded, sidebarExpandedWidth, panelVisible,
		partIds, verticalOrientation, titleBarHeight,
	} = input;

	// [Sarosis] Sidebar width is dynamic
	const sideBarSize = sidebarContentExpanded ? sidebarExpandedWidth : SIDEBAR_COLLAPSED_WIDTH;

	// Sizing rules
	const agentEditorWidth = Math.max(AGENT_EDITOR_MIN_WIDTH, Math.round(width / 2));
	const editorWidth = Math.max(EDITOR_MIN_WIDTH, width - sideBarSize - agentEditorWidth);

	// Panel sizing: 35% of the content height (below editor), hidden by default
	const contentHeight = height - titleBarHeight;
	const panelHeight = panelVisible ? Math.round(contentHeight * PANEL_HEIGHT_RATIO) : 0;

	// ── TitleBar: full-width top row ──
	const titleBarNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: partIds.titleBar },
		size: titleBarHeight,
		visible: true
	};

	// ── Sidebar ──
	// The sidebar node is ALWAYS visible in the grid — see IAgentsLayoutGridInput.sidebarContentExpanded.
	const sideBarNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: partIds.sidebar },
		size: sideBarSize,
		visible: true
	};

	// ── File Editor ──
	const editorNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: partIds.editor },
		size: Math.max(0, contentHeight - panelHeight),
		visible: true
	};

	// ── Panel (Output / Debug Console / Terminal) ──
	const panelNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: partIds.panel },
		size: panelHeight,
		visible: panelVisible
	};

	// ── Editor Column (VERTICAL): Editor | Panel ──
	const editorColumnNode: ISerializedNode = {
		type: 'branch',
		data: [editorNode, panelNode],
		size: editorWidth
	};

	// ── Agent Editor ──
	const agentEditorNode: ISerializedLeafNode = {
		type: 'leaf',
		data: { type: partIds.agentEditor },
		size: agentEditorWidth,
		visible: true
	};

	// ── Content row (HORIZONTAL): Sidebar | EditorColumn | Agent editor ──
	const contentRowChildren: ISerializedNode[] = [sideBarNode, editorColumnNode, agentEditorNode];
	const contentRow: ISerializedNode = {
		type: 'branch',
		data: contentRowChildren,
		size: Math.max(0, contentHeight)
	};

	// ── Root (VERTICAL): TitleBar | contentRow ──
	const rootChildren: ISerializedNode[] = [titleBarNode, contentRow];

	// ★ 标准 workbench 复用时：补上 `Layout` 记账需要的三个部件节点（见
	// `IAgentsLayoutGridEnv.includeLayoutBookkeepingParts`）。
	// `visible: false` + `size: 0` ⇒ 不占空间、不影响 agents 布局外观，
	// 但让 `getViewCachedVisibleSize()` / `getMaximumEditorDimensions()` 找得到它们。
	if (input.includeLayoutBookkeepingParts) {
		if (partIds.activityBar) {
			contentRowChildren.push({ type: 'leaf', data: { type: partIds.activityBar }, size: 0, visible: false });
		}
		if (partIds.auxiliaryBar) {
			contentRowChildren.push({ type: 'leaf', data: { type: partIds.auxiliaryBar }, size: 0, visible: false });
		}
		if (partIds.statusBar) {
			rootChildren.push({ type: 'leaf', data: { type: partIds.statusBar }, size: 0, visible: false });
		}
	}

	const result: ISerializedGrid = {
		root: {
			type: 'branch',
			size: height,
			data: rootChildren
		},
		orientation: verticalOrientation,
		width,
		height
	};

	return result;
}
