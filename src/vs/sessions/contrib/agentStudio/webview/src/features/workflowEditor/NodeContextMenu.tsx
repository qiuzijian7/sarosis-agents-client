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
import { buildComfyPaletteItems, type PaletteItem, subscribeNodeRegistry, getNodeRegistryVersion } from './comfyHost/registry';
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

/** Build all menu groups (static orchestration + dynamic ComfyTV/native). Pure. */
export function buildMenuGroups(): MenuGroup[] {
	const staticCats = nodeCategories.map<MenuGroup>(c => ({
		id: c.category,
		label: c.label.toUpperCase(),
		color: CATEGORY_COLORS[c.category],
		items: c.items as PaletteItem[],
	}));
	return [
		...staticCats,
		{ id: 'llm', label: 'PROVIDER 文生图', color: '#06b6d4', items: buildComfyPaletteItems('llm') },
		{ id: 'comfyTV', label: 'COMFYTV STAGES', color: '#e879f9', items: buildComfyPaletteItems('schema') },
		{ id: 'comfyUI', label: 'COMFYUI NATIVE', color: '#f59e0b', items: buildComfyPaletteItems('native') },
		// 过滤空组：如 'llm'（PROVIDER 文生图）当前无任何 kind='llm' 节点（ModelImageGen
		// 已迁移为 kind='schema'），空分组不该出现在搜索浮窗/级联菜单里（点开是空）。
	].filter(g => g.items.length > 0);
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
}> = ({ menu, onPick, onClose }) => {
	const addNode = useWorkflowEditorStore(s => s.addNode);
	const [query, setQuery] = React.useState('');
	// re-render when the registry gains nodes (runner loads)
	React.useSyncExternalStore(subscribeNodeRegistry, getNodeRegistryVersion, getNodeRegistryVersion);

	const groups = React.useMemo(buildMenuGroups, []);
	const visible = React.useMemo(() => filterMenuGroups(groups, query), [groups, query]);

	const top = Math.max(8, Math.min(menu.clientY, (window.innerHeight ?? 0) - MENU_MAX_H - 12));
	const left = Math.max(8, Math.min(menu.clientX, (window.innerWidth ?? 0) - MENU_W - 12));

	const pick = (type: string) => {
		addNode(type, { x: menu.graphX, y: menu.graphY });
		onPick(type);
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
		>
			{/* search */}
			<div style={{ padding: 8, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
				<input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Escape') { onClose(); }
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
			<div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 10px' }}>
				{visible.length === 0 && (
					<div style={{ color: '#777', fontSize: 11, padding: '14px 6px', textAlign: 'center' }}>
						没有匹配的节点
					</div>
				)}
				{visible.map(g => (
					<div key={g.id} style={{ marginBottom: 10 }}>
						<div style={{
							fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
							color: g.color, textTransform: 'uppercase',
							margin: '6px 2px 4px', paddingBottom: 3,
							borderBottom: `1px solid ${g.color}33`,
						}}>
							{g.label}
						</div>
						{g.items.map(it => (
							<button
								key={it.type}
								onClick={() => pick(it.type)}
								title={it.description}
								style={{
									display: 'flex', alignItems: 'center', gap: 8, width: '100%',
									textAlign: 'left', background: 'transparent', border: 'none',
									borderRadius: 5, padding: '5px 8px', cursor: 'pointer',
									color: '#e6e6e6',
								}}
								onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; }}
								onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
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
						))}
					</div>
				))}
			</div>
		</div>
	);
};
