/*---------------------------------------------------------------------------------------------
 *  menuItems — pure builders for the right-click menus (node / canvas).
 *
 *  Replicates the litegraph 0.17.2 node menu (es.js getNodeMenuOptions) on top
 *  of the React overlay: run / edit (title, collapse, pin) / clone / colors /
 *  properties / remove. Pure so it is unit-testable without a canvas.
 *--------------------------------------------------------------------------------------------*/

/** What the menu needs to know about the right-clicked node. */
export interface NodeActionsContext {
	/** LiteGraph type, e.g. "Saros.ModelImageGen" / "ComfyTV.ImageStage". */
	type: string;
	/** Display title (schema → spec.title; plain for native). */
	title: string;
	/** node spec kind: schema (ComfyTV/Saros form card), native (ComfyUI), legacy (no spec). */
	kind: 'schema' | 'native' | 'legacy';
	/** LiteGraph instance state. */
	pinned: boolean;
	collapsed: boolean;
	/** Whether this node has an executable run path. */
	canRun: boolean;
}

export interface MenuItem {
	id: string;
	label: string;
	/** Small glyph (emoji / codicon char). */
	icon?: string;
	danger?: boolean;
	disabled?: boolean;
	separator?: boolean;
	submenu?: MenuItem[];
	/** Render a small color swatch before the label (used by link color submenu). */
	color?: string;
	/** Show a check mark (used to mark the active link color). */
	checked?: boolean;
	onPick: () => void;
}

/**
 * Centralized menu copy (M3 — the ComfyUI `contextMenu.*` translation table
 * equivalent). Kept in one object so renames / i18n / tests stay in sync.
 */
export const MENU_TEXT = {
	nodeRun: '运行节点',
	editTitle: '重命名…',
	collapse: '折叠',
	expand: '展开',
	pin: '固定',
	unpin: '取消固定',
	clone: '克隆',
	colors: '颜色',
	colorDefault: '默认',
	properties: '属性…',
	remove: '删除',
	addNode: '添加节点…',
	paste: '粘贴',
	addGroup: '添加分组',
	align: '对齐网格',
	runWorkflow: '运行工作流',
	resetView: '重置视图',
	groupPin: '固定',
	groupUnpin: '取消固定',
	groupTitle: '标题…',
	groupFont: '字号…',
	groupRemove: '删除分组',
	disconnectPort: '断开此端口连线',
	disconnectInput: '断开此输入端口连线',
	disconnectOutput: '断开此输出端口连线',
	disconnectLink: '断开连线',
	deleteLink: '删除连线',
	renameLink: '重命名连线…',
	linkColor: '连线颜色',
	linkColorDefault: '默认',
	link: '连线',
	linkHandle: '连线手柄',
	addReroute: '添加路由点',
	canvas: '画布',
	convertToGroupNode: '转换为组节点（已弃用）',
	manageGroupNodes: '管理组节点',
	convertToGroup: '封装为组',
	saveSelectedAsTemplate: '保存选中为模板',
	nodeTemplates: '节点模板',
} as const;

/** Handlers the panel wires to the node menu items. */
export interface NodeActionsHandlers {
	run(): void;
	editTitle(): void;
	toggleCollapse(): void;
	togglePin(): void;
	clone(): void;
	setColor(color: string, bgcolor?: string): void;
	openProperties(): void;
	remove(): void;
}

const NODE_COLOR_PRESETS = [
	{ label: '默认', color: '', bgcolor: '' },
	{ label: '蓝', color: '#3b82f6', bgcolor: '#1e3a5f' },
	{ label: '青', color: '#06b6d4', bgcolor: '#134e4a' },
	{ label: '紫', color: '#8b5cf6', bgcolor: '#3b1f5c' },
	{ label: '粉', color: '#ec4899', bgcolor: '#4a1942' },
	{ label: '橙', color: '#f59e0b', bgcolor: '#451a03' },
	{ label: '绿', color: '#22c55e', bgcolor: '#14532d' },
	{ label: '红', color: '#ef4444', bgcolor: '#450a0a' },
];

/** Build the node right-click menu (aligned with litegraph getMenuOptions). */
export function buildNodeActions(ctx: NodeActionsContext, h: NodeActionsHandlers): MenuItem[] {
	const items: MenuItem[] = [];

	if (ctx.canRun) {
		items.push({ id: 'run', label: MENU_TEXT.nodeRun, icon: '▶', onPick: h.run });
		items.push({ id: 'sep0', separator: true, label: '', onPick: () => undefined });
	}

	items.push({ id: 'editTitle', label: MENU_TEXT.editTitle, icon: '✎', onPick: h.editTitle });
	items.push({
		id: 'collapse',
		label: ctx.collapsed ? MENU_TEXT.expand : MENU_TEXT.collapse,
		icon: ctx.collapsed ? '▸' : '▾',
		onPick: h.toggleCollapse,
	});
	items.push({
		id: 'pin',
		label: ctx.pinned ? MENU_TEXT.unpin : MENU_TEXT.pin,
		icon: '📌',
		onPick: h.togglePin,
	});
	items.push({ id: 'sep1', separator: true, label: '', onPick: () => undefined });

	items.push({ id: 'clone', label: MENU_TEXT.clone, icon: '⧉', onPick: h.clone });
	items.push({
		id: 'colors',
		label: MENU_TEXT.colors,
		icon: '🎨',
		submenu: NODE_COLOR_PRESETS.map(p => ({
			id: `color:${p.color || 'default'}`,
			label: p.label,
			icon: p.color ? '' : '–',
			onPick: () => h.setColor(p.color, p.bgcolor),
		})),
	});
	items.push({ id: 'sep2', separator: true, label: '', onPick: () => undefined });

	if (ctx.kind !== 'legacy') {
		items.push({ id: 'properties', label: MENU_TEXT.properties, icon: '⚙', onPick: h.openProperties });
		items.push({ id: 'sep3', separator: true, label: '', onPick: () => undefined });
	}

	items.push({ id: 'remove', label: MENU_TEXT.remove, icon: '🗑', danger: true, onPick: h.remove });
	return items;
}

/** What the menu needs to know about the canvas right-click. */
export interface CanvasActionsContext {
	/** Currently selected node count (>1 → alignment group). */
	selectedCount: number;
	canPaste: boolean;
	/**
	 * 「添加节点」二级级联菜单（复刻 ComfyUI：sampling/loaders/conditioning/…）。
	 * 传入时 `Add Node` 项展示 submenu；不传则退化为 `openNodeSearch` 浮窗。
	 * 构造见 `NodeContextMenu.buildAddNodeSubmenu`。
	 */
	addNodeSubmenu?: MenuItem[];
}

export interface CanvasActionsHandlers {
	openNodeSearch(): void;
	paste(): void;
	addGroup(): void;
	runWorkflow(): void;
	resetView(): void;
	/** Multi-select only: snap selected nodes to the 8px grid. */
	alignSelected(): void;
	/** Multi-select only: convert selected nodes to a sub-graph (group). */
	convertToGroup(): void;
	/** Manage existing groups (rename / recolor / reorder). */
	manageGroups(): void;
	/** Save selected nodes as a reusable template. */
	saveSelectedAsTemplate(): void;
	/** Open the node templates palette. */
	openNodeTemplates(): void;
}

/** Build the canvas right-click menu (order + separators mirror ComfyUI's
 *  canvas menu: Add Node / Add Group / Paste / Convert / Manage ┄ Run Workflow
 *  / Reset View). */
export function buildCanvasActions(ctx: CanvasActionsContext, h: CanvasActionsHandlers): MenuItem[] {
	const items: MenuItem[] = [
		// Group 1 — editing primitives
		// Add Node：复刻 ComfyUI 的二级级联菜单（sampling/loaders/conditioning/...）。
		// 传入 submenu 时显示 ▸ 箭头；不传时退化为 openNodeSearch 浮窗（搜索式 add node）。
		{ id: 'addNode', label: MENU_TEXT.addNode, icon: '⊕', submenu: ctx.addNodeSubmenu, onPick: h.openNodeSearch },
		{ id: 'addGroup', label: MENU_TEXT.addGroup, icon: '▦', onPick: h.addGroup },
	];
	if (ctx.canPaste) {
		items.push({ id: 'paste', label: MENU_TEXT.paste, icon: '⧉', onPick: h.paste });
	}
	// Group 2 — group-node management (ComfyUI: "Convert to Group Node (Deprecated)" +
	// "Manage Group Nodes", greyed out when nothing applicable). We expose them as
	// disabled placeholders so the layout stays faithful.
	items.push({
		id: 'convertToGroupNode',
		label: MENU_TEXT.convertToGroupNode,
		icon: '⬢',
		disabled: true,
		onPick: () => undefined,
	});
	items.push({
		id: 'manageGroupNodes',
		label: MENU_TEXT.manageGroupNodes,
		icon: '⬢',
		disabled: true,
		onPick: () => undefined,
	});
	items.push({ id: 'sep0', separator: true, label: '', onPick: () => undefined });

	// Group 3 — alignment + run/reset
	if (ctx.selectedCount > 1) {
		items.push({ id: 'align', label: MENU_TEXT.align, icon: '⊞', onPick: h.alignSelected });
		items.push({
			id: 'convertToGroup',
			label: MENU_TEXT.convertToGroup,
			icon: '⬢',
			onPick: h.convertToGroup,
		});
	}
	items.push({ id: 'runWorkflow', label: MENU_TEXT.runWorkflow, icon: '▶', onPick: h.runWorkflow });
	items.push({ id: 'resetView', label: MENU_TEXT.resetView, icon: '⌖', onPick: h.resetView });

	items.push({ id: 'sep1', separator: true, label: '', onPick: () => undefined });

	// Group 4 — templates (ComfyUI "Save Selected as Template" / "Node Templates")
	items.push({
		id: 'saveSelectedAsTemplate',
		label: MENU_TEXT.saveSelectedAsTemplate,
		icon: '★',
		disabled: ctx.selectedCount < 1,
		onPick: h.saveSelectedAsTemplate,
	});
	items.push({
		id: 'nodeTemplates',
		label: MENU_TEXT.nodeTemplates,
		icon: '◫',
		submenu: [],
		onPick: h.openNodeTemplates,
	});
	return items;
}

// ── Group menu (aligns with litegraph group.getMenuOptions) ────────────────

/** What the group menu needs to know about the right-clicked group. */
export interface GroupActionsContext {
	pinned: boolean;
	title: string;
}

export interface GroupActionsHandlers {
	/** Open the edit popup focused on the title field. */
	editTitle(): void;
	/** Open the edit popup focused on the font-size field. */
	editFont(): void;
	togglePin(): void;
	setColor(color: string | undefined): void;
	remove(): void;
}

/** Build the group right-click menu (Pin ┄ Title / Color / Font size ┄ Remove). */
export function buildGroupActions(ctx: GroupActionsContext, h: GroupActionsHandlers): MenuItem[] {
	return [
		{
			id: 'pin',
			label: ctx.pinned ? MENU_TEXT.groupUnpin : MENU_TEXT.groupPin,
			icon: '📌',
			onPick: h.togglePin,
		},
		{ id: 'sep0', separator: true, label: '', onPick: () => undefined },
		{ id: 'title', label: MENU_TEXT.groupTitle, icon: '✎', onPick: h.editTitle },
		{
			id: 'color',
			label: MENU_TEXT.colors,
			icon: '🎨',
			submenu: NODE_COLOR_PRESETS.map(p => ({
				id: `color:${p.color || 'default'}`,
				label: p.label,
				icon: p.color ? '' : '–',
				onPick: () => h.setColor(p.color || undefined, p.bgcolor),
			})),
		},
		{ id: 'font', label: MENU_TEXT.groupFont, icon: 'A', onPick: h.editFont },
		{ id: 'sep1', separator: true, label: '', onPick: () => undefined },
		{ id: 'remove', label: MENU_TEXT.groupRemove, icon: '🗑', danger: true, onPick: h.remove },
	];
}

// ── Port disconnect (right-click on a connected node port) ─────────────────

/** A connected port hit by the node right-click (→ prepend "disconnect"). */
export interface PortDisconnectAction {
	input: boolean;
	slot: number;
	/** Input: single link id. Output: link id list. */
	links: number[];
}

/** Build the "disconnect this port" item for a hit connected port. */
export function buildPortDisconnectAction(port: PortDisconnectAction, onPick: () => void): MenuItem {
	return {
		id: 'disconnectPort',
		label: port.input ? MENU_TEXT.disconnectInput : MENU_TEXT.disconnectOutput,
		icon: '✂',
		danger: true,
		onPick,
	};
}

// ── Link menu (right-click on a link / connection) ────────────────────────

/** What the menu needs to know about the right-clicked link. */
export interface LinkActionsContext {
	/** The LiteGraph link id being right-clicked. */
	linkId: number;
	/** Whether the link has a named type (typed links can be renamed). */
	isTyped: boolean;
	/** Current link color (hex) or undefined for default. */
	color?: string;
	/** "Add Node" cascading submenu (ComfyUI-style: sampling/loaders/…). */
	addNodeSubmenu?: MenuItem[];
}

/** Handlers the panel wires to the link menu items. */
export interface LinkActionsHandlers {
	/** Disconnect the link but keep its reroute node in the graph (ComfyUI "Disconnect"). */
	disconnect(): void;
	/** Fully delete the link (and its reroute nodes) from the graph (ComfyUI "Delete"). */
	delete(): void;
	/** Rename the typed link's connection (ComfyUI "Rename link" — typed links only). */
	rename(): void;
	/** Set the link color (ComfyUI link "Colors" submenu). */
	setColor(color: string): void;
	/** Open the node-search box to insert a node (ComfyUI "Add Node"). */
	openNodeSearch(): void;
	/** Insert a reroute node on the link (ComfyUI "Add Reroute"). Optional. */
	addReroute?(): void;
}

/**
 * Build the link right-click menu, mirroring ComfyUI's link context menu:
 *   - Disconnect  (keep the reroute node, just drop the connection)
 *   - Delete      (remove the link and any reroute nodes entirely)
 *   - Rename link (only for typed links — ctx.isTyped)
 *   - Colors ▸    (submenu of preset link colors)
 * Pure so it is unit-testable without a canvas — the panel only injects the
 * side-effects via `LinkActionsHandlers`.
 */
export function buildLinkActions(ctx: LinkActionsContext, h: LinkActionsHandlers): MenuItem[] {
	const colors: { id: string; label: string; value: string }[] = [
		{ id: 'link-red', label: MENU_TEXT.linkColorDefault === '默认' ? '红色' : 'Red', value: '#ff4d4f' },
		{ id: 'link-orange', label: '橙色', value: '#fa8c16' },
		{ id: 'link-yellow', label: '黄色', value: '#fadb14' },
		{ id: 'link-green', label: '绿色', value: '#52c41a' },
		{ id: 'link-cyan', label: '青色', value: '#13c2c2' },
		{ id: 'link-blue', label: '蓝色', value: '#1890ff' },
		{ id: 'link-purple', label: '紫色', value: '#722ed1' },
		{ id: 'link-pink', label: '粉色', value: '#eb2f96' },
		{ id: 'link-default', label: MENU_TEXT.linkColorDefault, value: '' },
	];

	const colorSubmenu: MenuItem[] = colors.map((c) => ({
		id: c.id,
		label: c.label,
		color: c.value || undefined,
		checked: (ctx.color ?? '') === c.value,
		onPick: () => h.setColor(c.value),
	}));

	const items: MenuItem[] = [
		// ComfyUI link-handle menu order: Add Node ▸ → Add Reroute → Disconnect → Delete → Rename → Colors ▸
		{
			id: 'addNode',
			label: MENU_TEXT.addNode,
			icon: '⊕',
			submenu: ctx.addNodeSubmenu,
			onPick: h.openNodeSearch,
		},
		{
			id: 'addReroute',
			label: MENU_TEXT.addReroute,
			icon: '⟲',
			disabled: !h.addReroute,
			onPick: () => h.addReroute?.(),
		},
		{
			id: 'disconnectLink',
			label: MENU_TEXT.disconnectLink,
			icon: '✂',
			onPick: h.disconnect,
		},
		{
			id: 'deleteLink',
			label: MENU_TEXT.deleteLink,
			icon: '🗑',
			danger: true,
			onPick: h.delete,
		},
	];

	if (ctx.isTyped) {
		items.push({
			id: 'renameLink',
			label: MENU_TEXT.renameLink,
			icon: '✎',
			onPick: h.rename,
		});
	}

	items.push({
		id: 'linkColor',
		label: MENU_TEXT.linkColor,
		icon: '🎨',
		submenu: colorSubmenu,
	});

	return items;
}
