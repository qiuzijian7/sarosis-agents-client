/*---------------------------------------------------------------------------------------------
 *  ConnectionDropMenu — 从节点端口拖拽连线松手后，显示「可连接节点列表」。
 *
 *  对齐 ComfyUI/ComfyTV 的 link-release 菜单：在松手位置浮出可搜索的节点列表，
 *  仅列出端口类型兼容的节点；选中后由调用方创建节点并自动连线。
 *
 *  注意：本组件只负责 UI 与筛选展示，连线逻辑由 onSelect(type) 回调交给 LiteGraphCanvas。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

export interface CompatibleNodeItem {
	/** 节点类型，如 "ComfyTV.MirrorStage"。 */
	type: string;
	/** 显示标题，如 "Mirror"。 */
	title: string;
	/** 类别分组，如 "image" / "video" / "system"。 */
	category: string;
	/** 匹配到的对端端口名（用于连线），如 "image"。 */
	portName: string;
	/** 匹配端口的类型，如 "IMAGE"。 */
	portType: string;
}

export interface ConnectionDropMenuProps {
	/** 锚点（相对画布容器的屏幕坐标）。 */
	anchor: { x: number; y: number };
	/** 兼容节点列表。 */
	items: CompatibleNodeItem[];
	/** 选中某节点类型。 */
	onSelect: (item: CompatibleNodeItem) => void;
	/** 关闭菜单。 */
	onClose: () => void;
}

const MENU_WIDTH = 240;

export function ConnectionDropMenu({ anchor, items, onSelect, onClose }: ConnectionDropMenuProps): React.JSX.Element {
	const [query, setQuery] = React.useState('');
	const [active, setActive] = React.useState(0);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const menuRef = React.useRef<HTMLDivElement>(null);

	// 过滤（按标题/类型/类别，大小写不敏感）
	const filtered = React.useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) { return items; }
		return items.filter(it =>
			it.title.toLowerCase().includes(q) ||
			it.type.toLowerCase().includes(q) ||
			it.category.toLowerCase().includes(q),
		);
	}, [items, query]);

	// 自动聚焦搜索框
	React.useEffect(() => {
		inputRef.current?.focus();
		setActive(0);
	}, []);

	// 点击外部 / Esc 关闭
	React.useEffect(() => {
		const onDocPointer = (e: PointerEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		const onKeyGlobal = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { onClose(); }
		};
		window.addEventListener('pointerdown', onDocPointer, true);
		window.addEventListener('keydown', onKeyGlobal);
		return () => {
			window.removeEventListener('pointerdown', onDocPointer, true);
			window.removeEventListener('keydown', onKeyGlobal);
		};
	}, [onClose]);

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActive(i => Math.min(i + 1, filtered.length - 1));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActive(i => Math.max(i - 1, 0));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const it = filtered[active];
			if (it) { onSelect(it); }
		}
	};

	return (
		<div
			ref={menuRef}
			style={{
				position: 'absolute',
				left: anchor.x,
				top: anchor.y,
				width: MENU_WIDTH,
				zIndex: 1000,
				background: '#1e1e1e',
				border: '1px solid #3c3c3c',
				borderRadius: 6,
				boxShadow: '0 4px 16px rgba(0,0,0,.5)',
				overflow: 'hidden',
				fontSize: 12,
				color: '#d4d4d8',
				pointerEvents: 'auto',
			}}
			onKeyDown={onKeyDown}
		>
			{/* 搜索框（ComfyUI 风格：顶部暗色输入框） */}
			<input
				ref={inputRef}
				value={query}
				onChange={e => { setQuery(e.target.value); setActive(0); }}
				placeholder="搜索节点…"
				style={{
					width: '100%',
					boxSizing: 'border-box',
					padding: '7px 10px',
					border: 'none',
					borderBottom: '1px solid #333',
					background: '#252526',
					color: '#e4e4e7',
					fontSize: 12,
					outline: 'none',
				}}
			/>
			{/* 列表 */}
			<div style={{ maxHeight: 280, overflowY: 'auto' }}>
				{filtered.length === 0 ? (
					<div style={{ padding: '10px 12px', color: '#888', fontSize: 11 }}>无可连接节点</div>
				) : (
					filtered.map((it, i) => (
						<div
							key={it.type}
							onMouseEnter={() => setActive(i)}
							onMouseDown={(e) => { e.preventDefault(); onSelect(it); }}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: 8,
								padding: '6px 10px',
								cursor: 'pointer',
								background: i === active ? 'rgba(96,165,250,.18)' : 'transparent',
								borderLeft: i === active ? '2px solid #60a5fa' : '2px solid transparent',
							}}
						>
							<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{it.title}
							</span>
							<span style={{
								fontSize: 9,
								color: '#888',
								background: '#2a2a2a',
								padding: '1px 5px',
								borderRadius: 3,
								flexShrink: 0,
							}}>
								{it.portType}
							</span>
						</div>
					))
				)}
			</div>
		</div>
	);
}
