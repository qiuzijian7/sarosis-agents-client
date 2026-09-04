/*---------------------------------------------------------------------------------------------
 *  OutpaintEditor — 交互式外扩（outpaint）编辑器（对齐 ComfyTV OutpaintStageCard）。
 *
 *  中央显示上游图像，四周半透明棋盘格 padding 区（dashed 主色边框），四边各有圆形
 *  拖拽手柄，拖动实时改 pad_left/top/right/bottom（image px，clamp 0..4096 step 8），
 *  旁显 NNNpx 徽标；下方数字输入框 + feathering + 输出尺寸预览。
 *  所有改动通过 onCommit 写回节点（wf-node-control）。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { loadCanvasImageWithProxy } from './canvasImageLoad';

export interface OutpaintPadState {
	left: number;
	top: number;
	right: number;
	bottom: number;
	feathering: number;
}

export interface OutpaintEditorProps {
	/** 初始 padding（来自 values.pad_* / feathering）。 */
	initial?: Partial<OutpaintPadState>;
	/** 上游图像 URL（无则显示占位棋盘格）。 */
	imageRef?: string;
	/** 任一参数变化时写回（patch 形式）。 */
	onCommit: (patch: Partial<OutpaintPadState>) => void;
}

const MAX_PAD = 4096;
const STEP = 8;
const MAX_FEATHER = 256;
/** 图像显示宽度的兜底初值（首帧 ResizeObserver 还没测到宽度时用）。
 *  ★ 不再是固定显示宽度 —— 节点卡片内容区仅 256px，写死 300px 必然横向溢出
 *  （见 visual/visual.spec.mjs 的 horizontal-overflow 规则）。 */
const IMG_FALLBACK_W = 200;

const clampStep = (v: number, max: number): number => {
	let n = Math.round(v / STEP) * STEP;
	if (n < 0) { n = 0; }
	if (n > max) { n = max; }
	return n;
};

export function OutpaintEditor({ initial, imageRef, onCommit }: OutpaintEditorProps): React.JSX.Element {
	const [pads, setPads] = React.useState<OutpaintPadState>(() => ({
		left: Math.max(0, Math.round(initial?.left ?? 0)),
		top: Math.max(0, Math.round(initial?.top ?? 0)),
		right: Math.max(0, Math.round(initial?.right ?? 0)),
		bottom: Math.max(0, Math.round(initial?.bottom ?? 0)),
		feathering: Math.max(0, Math.round(initial?.feathering ?? 0)),
	}));
	const [imgSize, setImgSize] = React.useState<{ w: number; h: number } | null>(null);
	const [drag, setDrag] = React.useState<{ side: keyof OutpaintPadState; startX: number; startY: number; startVal: number } | null>(null);

	React.useEffect(() => {
		if (!imageRef || !imageRef.startsWith('http')) {
			setImgSize(null);
			return;
		}
		let cancelled = false;
		// 直连失败（provider 签名 URL 无 CORS 头）自动回退 host 代理转 data URL
		loadCanvasImageWithProxy(imageRef).then((img) => {
			if (cancelled) { return; }
			if (img) { setImgSize({ w: img.naturalWidth, h: img.naturalHeight }); }
			else { setImgSize(null); }
		});
		return () => { cancelled = true; };
	}, [imageRef]);

	const natW = imgSize?.w ?? 768;
	const natH = imgSize?.h ?? 512;
	// ★ 图像显示宽度随卡片宽度自适应（不再写死 300px）。
	//   grid 里图列用 `minmax(0, 1fr)` 吃掉左右 handle 之外的剩余空间，这里再用
	//   ResizeObserver 回读它的**实际**宽度，用于 scale（拖拽换算 + 高度）。
	//   这样打破了「scale ← 图宽 ← handle 宽 ← scale」的循环依赖：布局由 CSS 决定，
	//   JS 只做测量。首帧用 IMG_FALLBACK_W，第二帧收敛到真实值。
	const imgBoxRef = React.useRef<HTMLDivElement | null>(null);
	const [imgBoxW, setImgBoxW] = React.useState(IMG_FALLBACK_W);
	React.useEffect(() => {
		const el = imgBoxRef.current;
		if (!el || typeof ResizeObserver === 'undefined') { return; }
		const ro = new ResizeObserver((entries) => {
			const w = Math.round(entries[0]?.contentRect.width ?? 0);
			// >0 才更新，避免卡片折叠时把 scale 归零
			if (w > 0) { setImgBoxW(w); }
		});
		ro.observe(el);
		return () => { ro.disconnect(); };
	}, []);
	const imgDisplayW = Math.max(40, imgBoxW);
	// padding 按同比例显示。
	const scale = imgDisplayW / natW;
	const outW = natW + pads.left + pads.right;
	const outH = natH + pads.top + pads.bottom;

	const update = React.useCallback((next: Partial<OutpaintPadState>) => {
		setPads((prev) => {
			const merged = { ...prev, ...next };
			onCommit(merged);
			return merged;
		});
	}, [onCommit]);

	const beginDrag = (side: keyof OutpaintPadState) => (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
		setDrag({ side, startX: e.clientX, startY: e.clientY, startVal: pads[side] });
	};

	const onMove = (e: React.PointerEvent) => {
		if (!drag) { return; }
		const dx = (e.clientX - drag.startX) / scale;
		const dy = (e.clientY - drag.startY) / scale;
		let delta = 0;
		// 上/左拖动方向为正（向内扩展），下/右为负（向外扩展）。
		if (drag.side === 'left') { delta = -dx; }
		else if (drag.side === 'right') { delta = dx; }
		else if (drag.side === 'top') { delta = -dy; }
		else if (drag.side === 'bottom') { delta = dy; }
		if (drag.side === 'feathering') { return; }
		const next = clampStep(drag.startVal + delta, MAX_PAD);
		if (next !== pads[drag.side]) {
			update({ [drag.side]: next } as Partial<OutpaintPadState>);
		}
	};

	const endDrag = (e: React.PointerEvent) => {
		if (drag) {
			(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
			setDrag(null);
		}
	};

	const handleStrip = (side: 'left' | 'top' | 'right' | 'bottom'): React.CSSProperties => {
		const base: React.CSSProperties = {
			position: 'relative',
			background: 'repeating-conic-gradient(#2a2a32 0% 25%, #202028 0% 50%) 50% / 14px 14px',
			border: '1px dashed rgba(59,130,246,.7)',
			display: 'flex', alignItems: 'center', justifyContent: 'center',
			cursor: side === 'left' || side === 'right' ? 'ew-resize' : 'ns-resize',
			touchAction: 'none',
		};
		if (side === 'top' || side === 'bottom') { base.height = Math.max(14, pads[side] * scale); }
		else { base.width = Math.max(14, pads[side] * scale); }
		return base;
	};

	const numInput = (key: keyof OutpaintPadState, max: number, label: string) => (
		<label key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground, #858585)' }}>
			<span style={{ width: 46 }}>{label}</span>
			<input
				type="number"
				min={0}
				max={max}
				step={key === 'feathering' ? 1 : STEP}
				value={pads[key]}
				onChange={(e) => update({ [key]: clampStep(Number(e.target.value || 0), max) } as Partial<OutpaintPadState>)}
				style={{ width: 56, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.12)', color: 'inherit', borderRadius: 4, fontSize: 10, padding: '2px 4px' }}
			/>
		</label>
	);

	return (
		<div style={{ pointerEvents: 'auto', userSelect: 'none', minWidth: 0, boxSizing: 'border-box' }}>
			<div
				style={{
					display: 'grid',
					gridTemplateAreas: '"top top top" "left img right" "bottom bottom bottom"',
					gridTemplateRows: `${Math.max(14, pads.top * scale)}px auto ${Math.max(14, pads.bottom * scale)}px`,
					// 图列用 minmax(0,1fr)：吃掉左右 handle 之外的剩余宽度，永不溢出卡片。
					gridTemplateColumns: `${Math.max(14, pads.left * scale)}px minmax(0, 1fr) ${Math.max(14, pads.right * scale)}px`,
					justifyContent: 'center',
					background: '#16161c',
					borderRadius: 6,
					padding: 4,
					gap: 0,
					minWidth: 0,
					boxSizing: 'border-box',
				}}
				onPointerMove={onMove}
				onPointerUp={endDrag}
				onPointerLeave={endDrag}
			>
				<div style={{ ...handleStrip('top'), gridArea: 'top' }} onPointerDown={beginDrag('top')}>
					<HandleBadge value={pads.top} active={drag?.side === 'top'} />
				</div>
				<div style={{ ...handleStrip('left'), gridArea: 'left' }} onPointerDown={beginDrag('left')}>
					<HandleBadge value={pads.left} active={drag?.side === 'left'} />
				</div>
				<div ref={imgBoxRef} style={{ gridArea: 'img', overflow: 'hidden', border: '1px solid rgba(255,255,255,.15)', background: '#000', minWidth: 0, boxSizing: 'border-box' }}>
					{imageRef
						? <img src={imageRef} alt="" style={{ width: '100%', height: natH * scale, objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
						: <div style={{ width: '100%', height: natH * scale, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#666' }}>无上游图像</div>}
				</div>
				<div style={{ ...handleStrip('right'), gridArea: 'right' }} onPointerDown={beginDrag('right')}>
					<HandleBadge value={pads.right} active={drag?.side === 'right'} />
				</div>
				<div style={{ ...handleStrip('bottom'), gridArea: 'bottom' }} onPointerDown={beginDrag('bottom')}>
					<HandleBadge value={pads.bottom} active={drag?.side === 'bottom'} />
				</div>
			</div>

			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
				{numInput('left', MAX_PAD, 'Left')}
				{numInput('top', MAX_PAD, 'Top')}
				{numInput('right', MAX_PAD, 'Right')}
				{numInput('bottom', MAX_PAD, 'Bottom')}
				{numInput('feathering', MAX_FEATHER, 'Feather')}
			</div>
			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
				<span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'Consolas, monospace' }}>
					输出 {outW}×{outH}
				</span>
				<button
					type="button"
					onClick={() => update({ left: 0, top: 0, right: 0, bottom: 0, feathering: 0 })}
					style={{ fontSize: 9, padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,.15)', background: 'rgba(255,255,255,.06)', color: 'inherit', cursor: 'pointer' }}
				>重置</button>
			</div>
		</div>
	);
}

function HandleBadge({ value, active }: { value: number; active?: boolean }): React.JSX.Element {
	return (
		<span style={{
			fontSize: 9, fontFamily: 'Consolas, monospace', padding: '1px 5px', borderRadius: 4,
			background: active ? 'rgba(59,130,246,.9)' : 'rgba(59,130,246,.18)',
			color: active ? '#fff' : 'rgba(59,130,246,.95)', pointerEvents: 'none',
		}}>
			{value}px
		</span>
	);
}
