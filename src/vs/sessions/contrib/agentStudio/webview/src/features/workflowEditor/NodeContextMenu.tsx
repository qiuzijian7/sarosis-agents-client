/*---------------------------------------------------------------------------------------------
 *  NodeContextMenu — ComfyUI-style right-click "Add Node" menu.
 *
 *  Replaces the left Nodes panel: right-click on the canvas opens a floating
 *  menu with a search box at the top and node groups below (System / Basic /
 *  Control Flow / Layout / ComfyTV STAGES / ComfyUI NATIVE). Picking a node
 *  creates it at the clicked graph position.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useWorkflowEditorStore, nodeCategories, type NodeCategory } from './store';
import { type PaletteItem, subscribeNodeRegistry, getNodeRegistryVersion } from './comfyHost/registry';
import { comfyGroups } from './NodePalette';
import type { MenuItem } from './menuItems';

export interface NodeContextMenuState {
	clientX: number;
	clientY: number;
	graphX: number;
	graphY: number;
}

export interface MenuGroup {
	id: string;
	label: string;
	color: string;
	items: PaletteItem[];
}

/**
 * 复刻 ComfyUI 右键菜单层级：把"添加节点"从扁平搜索浮窗改为二级级联菜单。
 * 一级=Add Node；二级=节点分组（system/basic/controlFlow/layout + llm/comfyTV/comfyUI，
 * 空组被 buildMenuGroups 过滤）；三级=每个分组下的具体节点（叶子）。
 * NodeActionsMenu 已支持任意层 submenu；本函数只构造二级 + 三级。
 */
export function buildAddNodeSubmenu(addNode: (type: string) => void): MenuItem[] {
	return buildMenuGroups().map<MenuItem>(g => ({
		id: `addNode:${g.id}`,
		label: g.label,
		// 用分组色的小方块作为图标（NodeActionsMenu 渲染 icon 字符 18px）
		icon: '◆',
		submenu: g.items.map<MenuItem>(it => ({
			id: `addNode:${g.id}:${it.type}`,
			label: it.label,
			icon: it.icon,
			onPick: () => addNode(it.type),
		})),
	}));
}

const CATEGORY_COLORS: Record<NodeCategory, string> = {
	system: '#6b7280',
	basic: '#3b82f6',
	controlFlow: '#f59e0b',
	layout: '#8b5cf6',
};

/** Build all menu groups (static orchestration + dynamic provider/ComfyTV/native). Pure. */
export function buildMenuGroups(): MenuGroup[] {
	const staticCats = nodeCategories.map<MenuGroup>(c => ({
		id: c.category,
		label: c.label.toUpperCase(),
		color: CATEGORY_COLORS[c.category],
		items: c.items as PaletteItem[],
	}));
	// ★ 动态分组复用 NodePalette.comfyGroups()（单一事实源）：Provider（Saros
	//   系列直连 API）/ ComfyTV Stages / ComfyUI Native 的划分与节点面板完全一致
	//   ——之前这里自建 llm/comfyTV/native 三组，与面板的 API 组拆分逻辑漂移
	//   （Saros 节点曾同时出现在双击菜单的 COMFYTV STAGES 里）。
	const dynamic = comfyGroups().map<MenuGroup>(g => ({
		id: g.key,
		label: g.label.toUpperCase(),
		color: g.color,
		items: g.items,
	}));
	// 过滤空组：空分组不该出现在搜索浮窗/级联菜单里（点开是空）。
	return [...staticCats, ...dynamic].filter(g => g.items.length > 0);
}

/** Filter groups by query (label or type, case-insensitive). Pure. */
export function filterMenuGroups(groups: MenuGroup[], query: string): MenuGroup[] {
	const q = query.trim().toLowerCase();
	if (!q) { return groups; }
	return groups
		.map(g => ({ ...g, items: g.items.filter(it => it.label.toLowerCase().includes(q) || it.type.toLowerCase().includes(q)) }))
		.filter(g => g.items.length > 0);
}

const MENU_W = 340;
const MENU_MAX_H = 460;

export const NodeContextMenu: React.FC<{
	menu: NodeContextMenuState;
	onPick: (type: string) => void;
	onClose: () => void;
	/**
	 * FollowCursor（对齐 ComfyUI `Comfy.NodeSearchBoxImpl.FollowCursor`）：
	 * true 时 pick 只回调 `onPick(type)`，由调用方进入 ghost 落位（节点跟随光标、
	 * 点击画布才落位）；默认 false = 选节点即落位在 `menu.graphX/graphY`。
	 */
	ghostMode?: boolean;
}> = ({ menu, onPick, onClose, ghostMode }) => {
	const addNode = useWorkflowEditorStore(s => s.addNode);
	const [query, setQuery] = React.useState('');
	const [active, setActive] = React.useState(0);
	const scrollRef = React.useRef<HTMLDivElement>(null);
	// re-render when the registry gains nodes (runner loads)
	React.useSyncExternalStore(subscribeNodeRegistry, getNodeRegistryVersion, getNodeRegistryVersion);

	const groups = React.useMemo(buildMenuGroups, []);
	const visible = React.useMemo(() => filterMenuGroups(groups, query), [groups, query]);

	// ★ 键盘导航（对齐 ComfyUI NodeSearchBox + ConnectionDropMenu）：把跨分组
	//   的节点扁平化，每个 item 带一个全局 flatIndex 供 ↑/↓/Enter 导航。
	const { renderGroups, flat } = React.useMemo(() => {
		let idx = 0;
		const groups = visible.map(g => ({
			...g,
			items: g.items.map(item => ({ item, flatIndex: idx++ })),
		}));
		return { renderGroups: groups, flat: groups.flatMap(g => g.items) };
	}, [visible]);

	// 查询变化时把高亮重置到顶部（否则 active 越界停留在旧项）。
	React.useEffect(() => { setActive(0); }, [query]);

	// active 变化 → 滚动到可视区（键盘长列表导航必需）。
	React.useEffect(() => {
		const el = scrollRef.current?.querySelector<HTMLElement>(`[data-flat-index="${active}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	}, [active]);

	const top = Math.max(8, Math.min(menu.clientY, (window.innerHeight ?? 0) - MENU_MAX_H - 12));
	const left = Math.max(8, Math.min(menu.clientX, (window.innerWidth ?? 0) - MENU_W - 12));

	const pick = (type: string) => {
		if (!ghostMode) {
			addNode(type, { x: menu.graphX, y: menu.graphY });
		}
		onPick(type);
	};

	const pickFlat = (i: number) => {
		const entry = flat[i];
		if (entry) { pick(entry.item.type); }
	};

	return (
		<div
			data-saros-menu
			style={{
				position: 'fixed',
				left, top, width: MENU_W, maxHeight: MENU_MAX_H,
				display: 'flex', flexDirection: 'column',
				background: '#202020', border: '1px solid rgba(255,255,255,0.12)',
				borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.6)',
				zIndex: 100, overflow: 'hidden',
			}}
			onContextMenu={(e) => e.preventDefault()}
			// ★ 关键修复：右键点击会触发 Chromium 的 autoscroll 模式，但
			//   `html, body, #root` 都是 `overflow:hidden`，主滚动容器不存在，
			//   autoscroll 找不到目标后会**吞掉 wheel 事件**，导致菜单滚轮
			//   滚动完全失效（"右键无法滚动"）。同时阻止右键 mousedown 默认
			//   行为可以避免 wheel 在右键按下状态下被消费。
			// 注意：只阻止右键 button=2 的默认行为，不影响左键/中键。
			onMouseDown={(e) => { if (e.button === 2) { e.preventDefault(); } }}
		>
			{/* search */}
			<div style={{ padding: 8, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
				<input
					// ★ 不再 autoFocus：input 获得焦点后，Chromium 会把 wheel 事件
					//   派发给 input（type=text 时不做任何事但**会阻止 wheel 冒泡到
					//   overflow:auto 父容器**），叠加右键 autoscroll 模式 → 菜单
					//   滚动完全失效。改为打开时聚焦到菜单根容器，下方滚动容器显式
					//   处理 wheel 事件 → 滚轮在右键状态下也能滚。
					ref={(el) => { if (el) { el.focus({ preventScroll: true }); } }}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						// ★ 键盘导航：↑/↓ 移动高亮、Enter 确认、Esc 关闭（对齐
						//   ComfyUI NodeSearchBox 与 ConnectionDropMenu 同款）。
						if (e.key === 'Escape') { onClose(); return; }
						const total = flat.length;
						if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, total - 1)); return; }
						if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); return; }
						if (e.key === 'Enter') { e.preventDefault(); pickFlat(active); return; }
					}}
					placeholder="搜索节点 / Search nodes…"
					style={{
						width: '100%', boxSizing: 'border-box',
						background: '#1a1a1a', color: '#ddd', border: '1px solid rgba(255,255,255,0.12)',
						borderRadius: 5, padding: '5px 8px', fontSize: 12, outline: 'none',
					}}
				/>
			</div>
			{/* groups */}
			<div
				ref={scrollRef}
				data-saros-scroll
				tabIndex={-1}
				style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 10px' }}
				// ★ 显式处理 wheel：嵌套 overflow:auto 容器在右键 autoscroll 模式
				//   下可能被 Chromium 跳过 wheel 派发；这里强制 deltaY 累加到 scrollTop
				//   → 滚轮在右键状态下也能滚动菜单。stopPropagation 阻止冒泡到祖先
				//   节点（防止 LiteGraphCanvas 的 wheel panning 干扰）。
				onWheel={(e) => {
					const el = e.currentTarget;
					el.scrollTop += e.deltaY;
					e.stopPropagation();
				}}
			>
				{visible.length === 0 && (
					<div style={{ color: '#777', fontSize: 11, padding: '14px 6px', textAlign: 'center' }}>
						没有匹配的节点
					</div>
				)}
				{renderGroups.map(g => (
					<div key={g.id} style={{ marginBottom: 10 }}>
						<div style={{
							fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
							color: g.color, textTransform: 'uppercase',
							margin: '6px 2px 4px', paddingBottom: 3,
							borderBottom: `1px solid ${g.color}33`,
						}}>
							{g.label}
						</div>
						{g.items.map(({ item: it, flatIndex }) => {
							const isActive = flatIndex === active;
							return (
								<button
									key={it.type}
									data-flat-index={flatIndex}
									onClick={() => pick(it.type)}
									onMouseEnter={() => setActive(flatIndex)}
									title={it.description}
									style={{
										display: 'flex', alignItems: 'center', gap: 8, width: '100%',
										textAlign: 'left', border: 'none',
										borderRadius: 5, padding: '5px 8px', cursor: 'pointer',
										color: '#e6e6e6',
										// 键盘高亮 + 鼠标 hover 同一视觉（React 状态驱动，替代 DOM 手动改 style）。
										background: isActive ? 'rgba(255,255,255,0.1)' : 'transparent',
										outline: isActive ? '1px solid rgba(96,165,250,0.5)' : 'none',
									}}
								>
									<span style={{ fontSize: 13, width: 18, textAlign: 'center', flexShrink: 0 }}>{it.icon}</span>
									<span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{it.label}</span>
									<span style={{
										marginLeft: 'auto', fontSize: 10, color: '#8a8a8a',
										whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150,
									}}>
										{it.type}
									</span>
								</button>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
};
