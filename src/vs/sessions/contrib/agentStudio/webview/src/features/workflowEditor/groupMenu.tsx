/*---------------------------------------------------------------------------------------------
 *  groupMenu.tsx — ComfyUI-style group operations UI.
 *
 *  Right-clicking a group on the canvas opens `GroupMenu` (rename / recolor /
 *  resize-text / pin / remove); "Edit Group…" opens `GroupEditPopup` with a
 *  title field, colour swatches and a font-size number.  All state mutations
 *  go through pure helpers so the e2e suite can verify them without a DOM.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { LGraphGroup } from '@comfyorg/litegraph';

/** Pre-set group palette (mirrors litegraph's node_colors groupcolors). */
export const GROUP_COLORS: string[] = [
	'#4b6eaf', // pale blue
	'#5aa469', // green
	'#c78a44', // orange
	'#8e5f9d', // purple
	'#b06a6a', // red
	'#6a8ab0', // light blue
	'#5c8a8a', // teal
	'#6a6a8a', // slate
];

export interface GroupEditFields {
	title: string;
	color: string | undefined;
	font_size: number;
}

/** Apply edit fields back onto a live group. Pure-ish (mutates the group). */
export function applyGroupEdit(group: Pick<LGraphGroup, 'title' | 'color' | 'font_size'>, edit: GroupEditFields): void {
	group.title = edit.title.trim() || group.title;
	group.color = edit.color;
	if (Number.isFinite(edit.font_size) && edit.font_size > 0) {
		group.font_size = edit.font_size;
	}
}

export interface GroupMenuState {
	group: LGraphGroup;
	clientX: number;
	clientY: number;
}

const MENU_W = 240;

export const GroupMenu: React.FC<{
	menu: GroupMenuState;
	onEdit: () => void;
	onPin: () => void;
	onRemove: () => void;
	onClose: () => void;
}> = ({ menu, onEdit, onPin, onRemove, onClose }) => {
	const top = Math.max(8, Math.min(menu.clientY, (window.innerHeight ?? 0) - 180));
	const left = Math.max(8, Math.min(menu.clientX, (window.innerWidth ?? 0) - MENU_W - 12));

	const row: React.CSSProperties = {
		display: 'flex', alignItems: 'center', gap: 8, width: '100%',
		textAlign: 'left', background: 'transparent', border: 'none',
		borderRadius: 5, padding: '6px 10px', cursor: 'pointer', color: '#e6e6e6', fontSize: 12,
	};

	return (
		<div
			style={{
				position: 'fixed', left, top, width: MENU_W,
				display: 'flex', flexDirection: 'column',
				background: '#202020', border: '1px solid rgba(255,255,255,0.12)',
				borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.6)',
				zIndex: 100, padding: 6, gap: 2,
			}}
			onContextMenu={(e) => e.preventDefault()}
		>
			<div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', color: '#8a8a8a', textTransform: 'uppercase', padding: '4px 10px 2px' }}>
				Group · {menu.group.title}
			</div>
			<button style={row} onClick={onEdit}>✏️ Edit Group…</button>
			<button style={row} onClick={onPin}>{menu.group.pinned ? '📌 Unpin' : '📌 Pin'}</button>
			<button style={row} onClick={onRemove}>🗑 Remove Group</button>
		</div>
	);
};

export const GroupEditPopup: React.FC<{
	group: LGraphGroup;
	onSave: (edit: GroupEditFields) => void;
	onClose: () => void;
}> = ({ group, onSave, onClose }) => {
	const [title, setTitle] = React.useState(group.title);
	const [color, setColor] = React.useState<string | undefined>(group.color);
	const [fontSize, setFontSize] = React.useState(group.font_size || 24);

	return (
		<div
			style={{
				position: 'fixed', left: '50%', top: '42%', transform: 'translate(-50%, -50%)',
				width: 320, background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.14)',
				borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
				zIndex: 101, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
			}}
			onContextMenu={(e) => e.preventDefault()}
		>
			<div style={{ fontSize: 11, fontWeight: 700, color: '#9a9a9a', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
				Edit Group
			</div>
			<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
				<span style={{ fontSize: 11, color: '#aaa' }}>Title</span>
				<input
					autoFocus
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onKeyDown={(e) => { if (e.key === 'Enter') { onSave({ title, color, font_size: fontSize }); } if (e.key === 'Escape') { onClose(); } }}
					style={{
						background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,0.14)',
						borderRadius: 5, padding: '5px 8px', fontSize: 13, outline: 'none',
					}}
				/>
			</label>
			<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
				<span style={{ fontSize: 11, color: '#aaa' }}>Color</span>
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
					<button
						title="Default"
						onClick={() => setColor(undefined)}
						style={{
							width: 20, height: 20, borderRadius: 5, border: color === undefined ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)',
							background: 'linear-gradient(135deg,#555,#333)', cursor: 'pointer',
						}}
					/>
					{GROUP_COLORS.map(c => (
						<button
							key={c}
							onClick={() => setColor(c)}
							style={{
								width: 20, height: 20, borderRadius: 5,
								border: color === c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)',
								background: c, cursor: 'pointer',
							}}
						/>
					))}
				</div>
			</label>
			<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
				<span style={{ fontSize: 11, color: '#aaa' }}>Font size</span>
				<input
					type="number" min={10} max={64} value={fontSize}
					onChange={(e) => setFontSize(Number(e.target.value))}
					style={{
						background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,0.14)',
						borderRadius: 5, padding: '5px 8px', fontSize: 13, outline: 'none', width: 80,
					}}
				/>
			</label>
			<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
				<button onClick={onClose} style={{
					background: 'transparent', color: '#bbb', border: '1px solid rgba(255,255,255,0.18)',
					borderRadius: 5, padding: '5px 14px', fontSize: 12, cursor: 'pointer',
				}}>
					Cancel
				</button>
				<button onClick={() => onSave({ title, color, font_size: fontSize })} style={{
					background: '#3b82f6', color: '#fff', border: 'none',
					borderRadius: 5, padding: '5px 14px', fontSize: 12, cursor: 'pointer',
				}}>
					Save
				</button>
			</div>
		</div>
	);
};
