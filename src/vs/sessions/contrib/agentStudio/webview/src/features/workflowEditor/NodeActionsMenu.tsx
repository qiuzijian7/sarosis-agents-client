/*---------------------------------------------------------------------------------------------
 *  NodeActionsMenu — right-click menu for canvas nodes (M1–M3 of the ComfyUI
 *  menu replica). Renders the MenuItem[] tree built by menuItems.ts with the
 *  same visual language as NodeContextMenu.
 *
 *  设计：递归 MenuList 组件，支持任意层级 submenu：
 *   - 一级菜单（depth=0）：键盘/焦点/居中定位
 *   - 子菜单（depth>0）：absolute 浮出 + 180ms grace timer + 局部 active/openSub
 *   - 带 submenu 的项点击只展开，不触发 onPick；Enter/ArrowRight 同理
 *   - 同一时间只一个 submenu 打开；hover 切换
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { MenuItem } from './menuItems';

export interface NodeActionsMenuState {
	clientX: number;
	clientY: number;
	/** Display title shown in the menu header. */
	title: string;
	items: MenuItem[];
}

const ITEM_H = 26;
const SUB_ITEM_H = 24;
const SUB_CLOSE_GRACE_MS = 180;
const SUB_MAX_H = 'min(70vh, 520px)';

const hoverBg = 'rgba(255,255,255,0.08)';
const menuBg = '#202020';
const menuBorder = 'rgba(255,255,255,0.12)';
const menuShadow = '0 8px 28px rgba(0,0,0,0.6)';

/** 递归菜单列表——支持任意层级 submenu。每层维护自己的 active/openSub。 */
const MenuList: React.FC<{ items: MenuItem[]; depth: number }> = ({ items, depth }) => {
	const rootRef = React.useRef<HTMLDivElement | null>(null);
	const [active, setActive] = React.useState(0);
	const [openSub, setOpenSub] = React.useState(-1);
	const subTimer = React.useRef<number | undefined>(undefined);
	const isRoot = depth === 0;
	// 中间层（有 submenu 项）不能加 overflowY:auto——CSS 会让 overflow-x 同步变 auto，
	// 把横向浮出的下一级子菜单裁剪掉。只有终端层（全是叶子）才需要滚动。
	const hasNested = items.some(it => !!it.submenu);

	// Actionable items (skip separators/disabled), each with its real index.
	const actionable = React.useMemo(
		() => items.map((it, idx) => ({ it, idx })).filter(x => !x.it.separator && !x.it.disabled),
		[items],
	);

	React.useEffect(() => {
		if (isRoot) {
			rootRef.current?.focus({ preventScroll: true });
		}
		return () => window.clearTimeout(subTimer.current);
	}, [isRoot]);

	const openSubmenu = React.useCallback((idx: number) => {
		window.clearTimeout(subTimer.current);
		setOpenSub(idx);
	}, []);
	const scheduleCloseSub = React.useCallback(() => {
		window.clearTimeout(subTimer.current);
		subTimer.current = window.setTimeout(() => setOpenSub(-1), SUB_CLOSE_GRACE_MS);
	}, []);
	const cancelCloseSub = React.useCallback(() => window.clearTimeout(subTimer.current), []);

	const pick = React.useCallback((item: MenuItem) => { item.onPick(); }, []);

	// 带 submenu 的项：点击只展开子菜单；不带 submenu 才执行 onPick（与上轮一致）
	const pickOrExpand = React.useCallback((item: MenuItem, realIdx: number) => {
		if (item.submenu) { openSubmenu(realIdx); return; }
		if (!item.disabled) { pick(item); }
	}, [openSubmenu, pick]);

	// Keyboard navigation 只在根菜单接管——避免多焦点冲突；子菜单由 openSub 状态切换显示
	const onKeyDown = React.useCallback((e: React.KeyboardEvent) => {
		if (actionable.length === 0) { return; }
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault(); setActive(a => (a + 1) % actionable.length); setOpenSub(-1); break;
			case 'ArrowUp':
				e.preventDefault(); setActive(a => (a - 1 + actionable.length) % actionable.length); setOpenSub(-1); break;
			case 'ArrowRight': {
				e.preventDefault();
				const cur = actionable[active];
				if (cur?.it.submenu) { openSubmenu(cur.idx); }
				break;
			}
			case 'ArrowLeft':
				e.preventDefault(); setOpenSub(-1); break;
			case 'Enter': {
				const cur = actionable[active];
				if (cur) {
					if (cur.it.submenu) { openSubmenu(cur.idx); } else { pick(cur.it); }
				}
				break;
			}
			case 'Escape':
				e.preventDefault(); setOpenSub(-1); break;
		}
	}, [actionable, active, openSubmenu, pick]);

	return (
		<div
			ref={isRoot ? rootRef : undefined}
			tabIndex={isRoot ? 0 : undefined}
			role="menu"
			onKeyDown={isRoot ? onKeyDown : undefined}
			style={isRoot ? {
				minWidth: 220, padding: '4px', outline: 'none',
				background: menuBg, border: `1px solid ${menuBorder}`,
				borderRadius: 8, boxShadow: menuShadow,
			} : {
				// 子菜单容器自带背景/边框/阴影（在父项 absolute 弹出）
				minWidth: 150, padding: '4px',
				...(hasNested ? {} : { maxHeight: SUB_MAX_H, overflowY: 'auto' }),
				background: menuBg, border: `1px solid ${menuBorder}`,
				borderRadius: 8, boxShadow: menuShadow,
			}}
		>
			{items.map((it, realIdx) => {
				if (it.separator) {
					return (
						<div key={it.id} style={{ height: 1, background: menuBorder, margin: '4px 4px' }} />
					);
				}
				const isActive = actionable[active]?.idx === realIdx;
				const isSubOpen = openSub === realIdx;
				return (
					<div
						key={it.id}
						role="menuitem"
						aria-disabled={it.disabled || undefined}
						style={{
							position: 'relative',
							display: 'flex', alignItems: 'center', gap: 8,
							padding: '0 10px', height: isRoot ? ITEM_H : SUB_ITEM_H,
							borderRadius: 4,
							cursor: it.disabled ? 'default' : 'pointer',
							color: it.disabled ? '#777' : (it.danger ? '#ff6b6b' : '#e6e6e6'),
							opacity: it.disabled ? 0.6 : 1,
							background: isActive ? hoverBg : 'transparent',
						}}
						onMouseEnter={() => {
							if (it.disabled) { return; }
							const ai = actionable.findIndex(x => x.idx === realIdx);
							if (ai >= 0) { setActive(ai); }
							if (it.submenu) { openSubmenu(realIdx); }
						}}
						onMouseLeave={it.submenu ? scheduleCloseSub : undefined}
						onClick={() => pickOrExpand(it, realIdx)}
						onContextMenu={(e) => e.preventDefault()}
					>
						<span style={{ fontSize: 12, width: 18, textAlign: 'center', flexShrink: 0 }}>{it.icon}</span>
						<span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
						{it.submenu && <span style={{ marginLeft: 'auto', fontSize: 9, color: '#999' }}>▸</span>}
						{it.submenu && isSubOpen && (
							<div
								role="menu"
								onMouseEnter={cancelCloseSub}
								onMouseLeave={scheduleCloseSub}
								style={{
									position: 'absolute', top: -6, zIndex: 101,
									left: 'calc(100% + 2px)',
								}}
							>
								<MenuList items={it.submenu} depth={depth + 1} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
};

export const NodeActionsMenu: React.FC<{
	menu: NodeActionsMenuState;
	onClose: () => void;
}> = ({ menu, onClose }) => {
	// 计算 root 高度让 root 容器能正确定位（submenu 绝对定位不受 root 容器大小影响）
	const sepCount = menu.items.filter(i => i.separator).length;
	const rootH = menu.items.length * ITEM_H + sepCount * 8 + 8;
	const top = Math.max(8, Math.min(menu.clientY, (window.innerHeight ?? 0) - rootH - 12));
	const left = Math.max(8, Math.min(menu.clientX, (window.innerWidth ?? 0) - 230 - 12));

	// Esc 关闭整菜单：MenuList 内 Esc 只关当前 submenu；root Esc 应触发 onClose。
	// 实现：在 root 上挂 onKeyDown 拦截 Escape → 调用 onClose。
	const onRootKeyDown = React.useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Escape') { e.preventDefault(); onClose(); }
	}, [onClose]);

	return (
		<div
			style={{ position: 'fixed', left, top, zIndex: 100 }}
			onKeyDown={onRootKeyDown}
		>
			<MenuList items={menu.items} depth={0} />
		</div>
	);
};