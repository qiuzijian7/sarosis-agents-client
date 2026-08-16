/*---------------------------------------------------------------------------------------------
 *  CropEditor — 交互式裁剪编辑器（ComfyTV CropStage 增强）。
 *
 *  在画布上显示上游图像，拖拽裁剪框（四角/四边缩放 + 内部移动 + 空白拖选新框），
 *  实时输出像素 x/y/width/height 到节点 values（执行器 cropRect 直接消费）。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	CROP_HANDLES, dragCrop, dragNewCrop, enforceAspect, fullCrop, fullCropNorm, hitTestCrop,
	normToPx, pxToNorm, type CropHandle, type CropRectNorm, type CropRectPx,
} from './comfyHost/cropEditor';

export interface CropEditorProps {
	/** 初始像素矩形（来自 values.x/y/width/height）。 */
	initial: CropRectPx;
	/** 上游图像 URL（无则显示占位网格）。 */
	imageRef?: string;
	/** 源图像尺寸变化时通知（用于初始矩形 clamp 到真实尺寸）。 */
	onCropChange: (rect: CropRectPx) => void;
}

const VIEW_W = 360;
const VIEW_MAX_H = 300;

// 对齐 ComfyTV 的长宽比选项（w/h）。null = 自由比例。
const ASPECT_OPTIONS: Array<{ label: string; value: number | null }> = [
	{ label: '自由', value: null },
	{ label: '1:1', value: 1 },
	{ label: '3:4', value: 3 / 4 },
	{ label: '4:3', value: 4 / 3 },
	{ label: '16:9', value: 16 / 9 },
	{ label: '9:16', value: 9 / 16 },
];

export function CropEditor({ initial, imageRef, onCropChange }: CropEditorProps): React.JSX.Element {
	const [imgSize, setImgSize] = React.useState<{ w: number; h: number } | null>(null);
	// 归一化裁剪框；图像加载前用全图占位。
	const [crop, setCrop] = React.useState<CropRectNorm>(() => fullCropNorm());
	const [drag, setDrag] = React.useState<{ handle: CropHandle | 'new'; originNx: number; originNy: number; start: CropRectNorm } | null>(null);
	const [hoverHandle, setHoverHandle] = React.useState<CropHandle | null>(null);
	const [aspect, setAspect] = React.useState<number | null>(null);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const imgElRef = React.useRef<HTMLImageElement | null>(null);
	const [imgReady, setImgReady] = React.useState(false);
	// 防止初始值只应用一次（图像加载后）的锁
	const appliedInitRef = React.useRef(false);

	// 加载上游图像，获取真实尺寸
	React.useEffect(() => {
		if (!imageRef || !imageRef.startsWith('http')) {
			setImgSize(null);
			setImgReady(false);
			return;
		}
		const img = new Image();
		imgElRef.current = img;
		img.crossOrigin = 'anonymous';
		const onLoad = () => {
			setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
			setImgReady(true);
		};
		const onError = () => { setImgReady(false); setImgSize(null); };
		img.addEventListener('load', onLoad);
		img.addEventListener('error', onError);
		img.src = imageRef;
		return () => {
			img.removeEventListener('load', onLoad);
			img.removeEventListener('error', onError);
			img.removeAttribute('src');
		};
	}, [imageRef]);

	// 图像尺寸就绪后，把初始像素矩形 clamp 并转为归一化（仅一次）。
	React.useEffect(() => {
		if (!imgSize || appliedInitRef.current) { return; }
		appliedInitRef.current = true;
		const full = fullCrop(imgSize.w, imgSize.h);
		// 初始矩形全 0 或与默认 512 相同但图像更小 → 视为"未设置"，用全图。
		const isDefault = initial.x === 0 && initial.y === 0
			&& (initial.width === 512 || initial.width === 0)
			&& (initial.height === 512 || initial.height === 0);
		const px = isDefault ? full : {
			x: Math.min(initial.x, full.width),
			y: Math.min(initial.y, full.height),
			width: Math.min(initial.width || full.width, full.width),
			height: Math.min(initial.height || full.height, full.height),
		};
		setCrop(pxToNorm(px, imgSize.w, imgSize.h));
		onCropChange(px);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [imgSize]);

	// 切换长宽比后，把当前裁剪框重新约束到新比例（保持右下锚点）。
	React.useEffect(() => {
		if (aspect && imgSize) {
			const next = enforceAspect(crop, aspect, 'br');
			commit(next);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [aspect]);

	// 视图尺寸：按图像宽高比缩放，最大 VIEW_MAX_H。
	const viewH = React.useMemo(() => {
		if (!imgSize) { return 200; }
		const ratio = imgSize.h / imgSize.w;
		return Math.min(VIEW_MAX_H, Math.max(120, Math.round(VIEW_W * ratio)));
	}, [imgSize]);

	const commit = React.useCallback((n: CropRectNorm) => {
		setCrop(n);
		if (imgSize) { onCropChange(normToPx(n, imgSize.w, imgSize.h)); }
	}, [imgSize, onCropChange]);

	// ── draw ───────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		ctx.clearRect(0, 0, VIEW_W, viewH);
		ctx.fillStyle = '#17181c';
		ctx.fillRect(0, 0, VIEW_W, viewH);
		const img = imgElRef.current;
		if (imgReady && img && img.naturalWidth) {
			ctx.drawImage(img, 0, 0, VIEW_W, viewH);
		} else {
			// 占位网格
			ctx.strokeStyle = 'rgba(255,255,255,.08)';
			ctx.lineWidth = 1;
			for (let i = 1; i < 8; i++) {
				ctx.beginPath(); ctx.moveTo((VIEW_W / 8) * i, 0); ctx.lineTo((VIEW_W / 8) * i, viewH); ctx.stroke();
			}
			for (let i = 1; i < 5; i++) {
				ctx.beginPath(); ctx.moveTo(0, (viewH / 5) * i); ctx.lineTo(VIEW_W, (viewH / 5) * i); ctx.stroke();
			}
		}
		// 裁剪框外暗化
		const cx = crop.x * VIEW_W, cy = crop.y * viewH, cw = crop.w * VIEW_W, ch = crop.h * viewH;
		ctx.fillStyle = 'rgba(0,0,0,.55)';
		ctx.fillRect(0, 0, VIEW_W, cy);
		ctx.fillRect(0, cy, cx, ch);
		ctx.fillRect(cx + cw, cy, VIEW_W - cx - cw, ch);
		ctx.fillRect(0, cy + ch, VIEW_W, viewH - cy - ch);
		// 边框
		ctx.strokeStyle = '#4a9eff';
		ctx.lineWidth = 2;
		ctx.strokeRect(cx, cy, cw, ch);
		// 三分线（ComfyUI 构图辅助）
		ctx.strokeStyle = 'rgba(255,255,255,.25)';
		ctx.lineWidth = 1;
		for (let i = 1; i < 3; i++) {
			ctx.beginPath(); ctx.moveTo(cx + (cw / 3) * i, cy); ctx.lineTo(cx + (cw / 3) * i, cy + ch); ctx.stroke();
			ctx.beginPath(); ctx.moveTo(cx, cy + (ch / 3) * i); ctx.lineTo(cx + cw, cy + (ch / 3) * i); ctx.stroke();
		}
		// 手柄
		const H: Array<[CropHandle, number, number]> = [
			['tl', cx, cy], ['tr', cx + cw, cy], ['bl', cx, cy + ch], ['br', cx + cw, cy + ch],
			['l', cx, cy + ch / 2], ['r', cx + cw, cy + ch / 2], ['t', cx + cw / 2, cy], ['b', cx + cw / 2, cy + ch],
		];
		for (const [id, hx, hy] of H) {
			ctx.fillStyle = id === hoverHandle || drag?.handle === id ? '#fff' : '#4a9eff';
			ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2); ctx.fill();
			ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
			ctx.stroke();
		}
	}, [crop, imgReady, viewH, hoverHandle, drag]);

	const localN = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { x, y } = localN(e);
		const hit = hitTestCrop(crop, x, y, 0.05);
		if (hit) {
			setDrag({ handle: hit, originNx: x, originNy: y, start: crop });
		} else {
			// 空白处拖选新框
			setDrag({ handle: 'new', originNx: x, originNy: y, start: crop });
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { x, y } = localN(e);
		if (drag) {
			if (drag.handle === 'new') {
				commit(dragNewCrop(drag.originNx, drag.originNy, x, y, aspect));
			} else {
				commit(dragCrop(drag.handle, drag.start, drag.originNx, drag.originNy, x, y, aspect));
			}
			return;
		}
		setHoverHandle(hitTestCrop(crop, x, y, 0.05) === 'move' ? null : hitTestCrop(crop, x, y, 0.05));
	};

	const onPointerUp = () => { setDrag(null); };

	const reset = () => {
		if (!imgSize) { return; }
		const full = fullCrop(imgSize.w, imgSize.h);
		setCrop(fullCropNorm());
		onCropChange(full);
	};

	const pxRect = imgSize ? normToPx(crop, imgSize.w, imgSize.h) : null;

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<canvas
				ref={canvasRef}
				width={VIEW_W}
				height={viewH}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				style={{
					width: '100%', borderRadius: 8, touchAction: 'none',
					cursor: drag ? 'grabbing' : (hoverHandle ? 'crosshair' : 'grab'),
					background: '#17181c', display: 'block',
				}}
			/>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<button
					onClick={reset}
					style={{ padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10, background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit' }}
				>
					↺ 全图
				</button>
				<label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
					比例
					<select
						value={aspect === null ? 'free' : String(aspect)}
						onChange={e => setAspect(e.target.value === 'free' ? null : Number(e.target.value))}
						style={{ background: '#111', color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 4, fontSize: 10, padding: '2px 4px', fontFamily: 'inherit' }}
					>
						{ASPECT_OPTIONS.map(o => (
							<option key={o.label} value={o.value === null ? 'free' : String(o.value)}>{o.label}</option>
						))}
					</select>
				</label>
				<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
					拖动框边/角缩放，拖内部移动，空白处拖出新框
				</span>
			</div>
			{pxRect ? (
				<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace' }}>
					x:{pxRect.x} y:{pxRect.y} w:{pxRect.width} h:{pxRect.height}
					{imgSize ? ` / 源 ${imgSize.w}×${imgSize.h}` : ''}
				</div>
			) : (
				<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
					{imgSize ? '加载图像…' : '无上游图像：请先连接图像节点并执行'}
				</div>
			)}
		</div>
	);
}
