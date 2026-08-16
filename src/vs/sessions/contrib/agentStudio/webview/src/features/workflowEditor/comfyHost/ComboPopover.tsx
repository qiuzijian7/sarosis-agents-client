/*---------------------------------------------------------------------------------------------
 *  ComboPopover — 自绘 ComfyTV 风格下拉控件。
 *
 *  对齐 ComfyTV ComfyTVSelect.vue（reka-ui Combobox）：深色主题（非白底）、
 *  圆角、popper 定位（挂在 trigger 下方、左对齐、宽度跟随 trigger）。
 *
 *  关键修正：popover 通过 createPortal 挂到 document.body。原实现把 popover
 *  渲染在卡片 DOM 内（widgetBridge 的 overlay 容器带 `transform: scale()`），
 *  `position: fixed` 在有 transform 祖先时会以该祖先为 containing block，
 *  而 getBoundingClientRect() 返回的是 viewport 坐标 —— 两者坐标系不一致，
 *  缩放 ≠1 时下拉位置错位（用户反馈「下拉框 UI 位置错误」）。portal 到 body
 *  后 fixed 相对 viewport，定位正确。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { createPortal } from 'react-dom';

export interface ComboPopoverOption {
	label: string;
	value: string;
	group?: string;
}

export interface ComboPopoverProps {
	value: string;
	options: ComboPopoverOption[];
	onChange: (value: string) => void;
	/** ComfyTV 风格 = false（深色）。true 时回退白底（历史遗留，默认不用）。 */
	light?: boolean;
	id?: string;
	ariaLabel?: string;
}

// ComfyTV tailwind.css 主题 token（深色回退值）。
const TV = {
	fg: '#e0e0e0',
	bg: '#1e1e1e',
	secondaryBg: 'rgba(255,255,255,0.06)',
	secondaryHover: 'rgba(255,255,255,0.10)',
	secondarySelected: 'rgba(78,168,255,0.20)',
	border: 'rgba(255,255,255,0.20)',
	borderSubtle: 'rgba(255,255,255,0.12)',
	muted: '#888888',
};

export const ComboPopover: React.FC<ComboPopoverProps> = ({ value, options, onChange, light = false, id, ariaLabel }) => {
	const [open, setOpen] = React.useState(false);
	const [activeIdx, setActiveIdx] = React.useState(0);
	const triggerRef = React.useRef<HTMLButtonElement | null>(null);
	const popRef = React.useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = React.useState<{ left: number; top: number; width: number } | null>(null);

	React.useEffect(() => {
		const i = options.findIndex(o => o.value === value);
		setActiveIdx(i >= 0 ? i : 0);
	}, [value, options]);

	React.useEffect(() => {
		if (!open || !triggerRef.current) { setPos(null); return; }
		const rect = triggerRef.current.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// popover 最小宽度 = trigger 宽度，最大 360（对齐 ComfyTV min-w=trigger / max-w=360）。
		const popW = Math.max(rect.width, 120);
		let left = rect.left;
		if (left + popW > vw - 8) { left = Math.max(8, vw - popW - 8); }
		// 下方放不下（剩余 < 240 且上方更宽裕）则翻到上方（ComfyTV popper flip 语义）。
		const estMaxH = 240;
		let top = rect.bottom + 2;
		if (top + estMaxH > vh - 8) { top = Math.max(8, rect.top - estMaxH - 2); }
		setPos({ left, top, width: popW });
	}, [open]);

	React.useEffect(() => {
		if (!open) { return; }
		const onDocPointer = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (t && (triggerRef.current?.contains(t) || popRef.current?.contains(t))) { return; }
			setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
		};
		document.addEventListener('pointerdown', onDocPointer, true);
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('pointerdown', onDocPointer, true);
			document.removeEventListener('keydown', onKey, true);
		};
	}, [open]);

	const onTriggerKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			setOpen(true);
		}
	};

	const onListKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(options.length - 1, i + 1)); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
		else if (e.key === 'Enter') {
			e.preventDefault();
			const o = options[activeIdx];
			if (o) { onChange(o.value); setOpen(false); triggerRef.current?.focus(); }
		} else if (e.key === 'Home') { e.preventDefault(); setActiveIdx(0); }
		else if (e.key === 'End') { e.preventDefault(); setActiveIdx(options.length - 1); }
	};

	const current = options.find(o => o.value === value);
	const displayLabel = current?.label ?? value ?? '';

	// 触发器：深色 ComfyTV 风格（h 28px、rounded 8、secondary-background、chevron-down）。
	const triggerStyle: React.CSSProperties = light
		? {
			display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
			width: '100%', minWidth: 0, padding: '4px 8px',
			background: '#ffffff', color: '#222', border: '1px solid #cfcfcf', borderRadius: 6,
			fontSize: 11, lineHeight: '16px', cursor: 'pointer', userSelect: 'none',
		}
		: {
			display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
			width: '100%', minWidth: 0, boxSizing: 'border-box',
			height: 28, padding: '2px 10px',
			background: TV.secondaryBg, color: TV.fg,
			border: `1px solid ${open ? TV.border : TV.borderSubtle}`, borderRadius: 8,
			fontSize: 12, lineHeight: '16px',
			cursor: 'pointer', userSelect: 'none',
			transition: 'border-color .12s ease',
		};

	const popover = open && pos ? (
		<div
			ref={popRef}
			role="listbox"
			tabIndex={-1}
			onKeyDown={onListKeyDown}
			style={{
				position: 'fixed', left: pos.left, top: pos.top,
				width: pos.width, minWidth: 120, maxWidth: 360,
				maxHeight: 240, overflowY: 'auto',
				background: TV.bg, color: TV.fg,
				border: `1px solid ${TV.borderSubtle}`, borderRadius: 8,
				boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
				padding: '4px', zIndex: 100000,
				boxSizing: 'border-box',
			}}
		>
			{options.length === 0
				? <div style={{ padding: '6px 10px', fontSize: 12, color: TV.muted }}>（无选项）</div>
				: 				options.map((o, i) => {
					const selected = o.value === value;
					const active = i === activeIdx;
					const showGroup = !!o.group && (i === 0 || options[i - 1].group !== o.group);
					return (
						<React.Fragment key={o.value}>
							{showGroup && (
								<div style={{ padding: '5px 8px 3px', fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: TV.muted, textTransform: 'uppercase' }}>
									{o.group}
								</div>
							)}
							<div
								role="option"
								aria-selected={selected}
								onMouseEnter={() => setActiveIdx(i)}
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									onChange(o.value);
									setOpen(false);
									triggerRef.current?.focus();
								}}
								style={{
									display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
									padding: '5px 8px',
									fontSize: 12, lineHeight: '16px',
									borderRadius: 4,
									cursor: 'pointer',
									background: selected ? TV.secondarySelected : (active ? TV.secondaryHover : 'transparent'),
									color: TV.fg,
									fontWeight: selected ? 600 : 400,
								}}
							>
								<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{o.label}</span>
								{selected && <span aria-hidden style={{ fontSize: 11, color: TV.fg, flexShrink: 0 }}>✓</span>}
							</div>
						</React.Fragment>
					);
				})}
		</div>
	) : null;

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				id={id}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				onClick={() => setOpen(o => !o)}
				onKeyDown={onTriggerKeyDown}
				style={triggerStyle}
			>
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, textAlign: 'left' }}>
					{displayLabel || '—'}
				</span>
				<span aria-hidden style={{ fontSize: 10, color: light ? '#666' : TV.muted, flexShrink: 0 }}>▾</span>
			</button>
			{popover && createPortal(popover, document.body)}
		</>
	);
};
