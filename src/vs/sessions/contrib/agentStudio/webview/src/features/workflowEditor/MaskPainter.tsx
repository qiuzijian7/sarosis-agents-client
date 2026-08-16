/*---------------------------------------------------------------------------------------------
 *  MaskPainter — 交互式擦除/内绘 mask 编辑器（ComfyTV EraseStage/InpaintStage 增强）。
 *
 *  在源图上画笔涂抹（红色半透明=要擦除区域），橡皮恢复，矩形/椭圆框选；
 *  commitMask 对齐 ComfyTV：白底 + destination-out → PNG → 上传 ComfyUI
 *  `comfytv/painter/` 子目录 → 生成 annotated path `comfytv/painter/xxx.png [input]`
 *  写入节点 mask_data，供 erase/inpaint workflow 消费。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	drawMaskOps, maskOpsToJson, parseMaskOps, renderMaskBlob,
	type MaskOp, type MaskShapeOp, type MaskStrokeOp, type MaskFillOp, type MaskLabelOp, type MaskTool,
} from './comfyHost/maskPainter';

export interface MaskPainterProps {
	/** 源图像 URL（作为涂抹参考背景）。 */
	imageRef?: string;
	/** 已持久化的 ops JSON（重开编辑器恢复）。 */
	initialOps?: string;
	/** 是否显示（inpaint 需要额外 prompt，erase 不需要）。 */
	showPrompt?: boolean;
	initialPrompt?: string;
	onPromptChange?: (prompt: string) => void;
	runners: ComfyRunnerRegistry;
	preference: string;
	/** mask 上传成功后回调 annotated path；op 变化时回调 ops JSON。 */
	onMaskChange: (annotated: string) => void;
	onOpsChange: (opsJson: string) => void;
}

const VIEW_W = 360;
const VIEW_MAX_H = 300;
const TOOLS: Array<{ id: MaskTool; label: string }> = [
	{ id: 'brush', label: '🖌 笔刷' },
	{ id: 'eraser', label: '⌫ 橡皮' },
	{ id: 'fill', label: '🪣 填充' },
	{ id: 'rect', label: '▭ 矩形' },
	{ id: 'ellipse', label: '◯ 椭圆' },
	{ id: 'label', label: '🔖 编号' },
];

export function MaskPainter({ imageRef, initialOps, showPrompt, initialPrompt, onPromptChange, runners, preference, onMaskChange, onOpsChange }: MaskPainterProps): React.JSX.Element {
	const initialOpsRef = React.useRef<MaskOp[] | null>(null);
	if (initialOpsRef.current === null) { initialOpsRef.current = parseMaskOps(initialOps); }
	const [ops, setOps] = React.useState<MaskOp[]>(initialOpsRef.current);
	const labelCounterRef = React.useRef(
		Math.max(0, ...initialOpsRef.current.filter(o => o.type === 'label').map(o => (o as MaskLabelOp).n)),
	);
	const [tool, setTool] = React.useState<MaskTool>('brush');
	const [brushSize, setBrushSize] = React.useState(0.02);
	const [opacity, setOpacity] = React.useState(0.7);
	const [hardness, setHardness] = React.useState(1);
	const [imgSize, setImgSize] = React.useState<{ w: number; h: number } | null>(null);
	const [imgReady, setImgReady] = React.useState(false);
	const [uploading, setUploading] = React.useState(false);
	const [lastMask, setLastMask] = React.useState<string>('');
	const [pointerPos, setPointerPos] = React.useState<{ x: number; y: number } | null>(null);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const imgElRef = React.useRef<HTMLImageElement | null>(null);
	const draftRef = React.useRef<{ type: 'rect' | 'ellipse'; x0: number; y0: number; x1: number; y1: number } | null>(null);
	const strokeRef = React.useRef<{ opIndex: number } | null>(null);
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;
	const opsRef = React.useRef(ops); opsRef.current = ops;
	const onOpsChangeRef = React.useRef(onOpsChange); onOpsChangeRef.current = onOpsChange;

	// 加载源图，获取真实尺寸（mask 尺寸 = 源图尺寸，ComfyUI 后端对齐）
	React.useEffect(() => {
		if (!imageRef) { setImgSize(null); setImgReady(false); return; }
		const img = new Image();
		imgElRef.current = img;
		img.crossOrigin = 'anonymous';
		const onLoad = () => { setImgSize({ w: img.naturalWidth, h: img.naturalHeight }); setImgReady(true); };
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

	// 视图尺寸
	const viewH = React.useMemo(() => {
		if (!imgSize) { return 220; }
		const ratio = imgSize.h / imgSize.w;
		return Math.min(VIEW_MAX_H, Math.max(120, Math.round(VIEW_W * ratio)));
	}, [imgSize]);

	const commitOps = React.useCallback((next: MaskOp[]) => {
		setOps(next);
		opsRef.current = next;
		onOpsChangeRef.current(maskOpsToJson(next));
	}, []);

	// ── draw ───────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		ctx.clearRect(0, 0, VIEW_W, viewH);
		ctx.fillStyle = '#17181c';
		ctx.fillRect(0, 0, VIEW_W, viewH);
		// 源图背景
		const img = imgElRef.current;
		if (imgReady && img && img.naturalWidth) {
			ctx.drawImage(img, 0, 0, VIEW_W, viewH);
		}
		// 半透明红色覆盖层 = 笔迹（要擦除区域）。先用 drawMaskOps 在临时层画
		// 出软（灰度）蒙版，再染红并绘制；软笔刷/opacity 在蒙版里已用 alpha 表达。
		ctx.save();
		const tmp = document.createElement('canvas');
		tmp.width = VIEW_W; tmp.height = viewH;
		const tctx = tmp.getContext('2d')!;
		drawMaskOps(tctx, ops, VIEW_W, viewH);
		// 黑色蒙版 → 红色（保留 alpha 形状）。eraser 产生的透明区域保持透明。
		tctx.globalCompositeOperation = 'source-in';
		tctx.fillStyle = 'rgba(239,68,68,0.9)';
		tctx.fillRect(0, 0, VIEW_W, viewH);
		tctx.globalCompositeOperation = 'source-over';
		// 编号圆点：在染红层上用白字标出数字
		const lbls = ops.filter(o => o.type === 'label') as MaskLabelOp[];
		tctx.font = 'bold 11px sans-serif';
		tctx.textAlign = 'center';
		tctx.textBaseline = 'middle';
		for (const l of lbls) {
			tctx.fillStyle = '#fff';
			tctx.fillText(String(l.n), l.x * VIEW_W, l.y * viewH);
		}
		ctx.globalAlpha = 0.6;
		ctx.drawImage(tmp, 0, 0, VIEW_W, viewH);
		ctx.globalAlpha = 1;
		ctx.restore();

		// ── Draft shape preview（矩形/椭圆拖拽中的实时预览）────────────
		if (draftRef.current) {
			const d = draftRef.current;
			ctx.save();
			ctx.globalAlpha = 0.75;
			ctx.strokeStyle = '#ef4444';
			ctx.lineWidth = Math.max(1.5, (brushSize * VIEW_W) / 4);
			ctx.lineJoin = 'round';
			ctx.setLineDash([5, 4]);
			const dx0 = d.x0 * VIEW_W, dy0 = d.y0 * viewH;
			const dx1 = d.x1 * VIEW_W, dy1 = d.y1 * viewH;
			ctx.beginPath();
			if (d.type === 'rect') {
				ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
			} else {
				const cx = (dx0 + dx1) / 2, cy = (dy0 + dy1) / 2;
				const rx = Math.abs(dx1 - dx0) / 2, ry = Math.abs(dy1 - dy0) / 2;
				ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
			}
			ctx.stroke();
			ctx.setLineDash([]);
			// 角点标记
			const corners = [[dx0, dy0], [dx1, dy0], [dx1, dy1], [dx0, dy1]];
			ctx.fillStyle = '#ef4444';
			for (const [cx, cy] of corners) { ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5); }
			ctx.restore();
		}

		// ── 自定义工具光标（覆盖 CSS cursor，提供精确尺寸反馈）─────────
		if (pointerPos && imgReady) {
			const px = pointerPos.x * VIEW_W;
			const py = pointerPos.y * viewH;
			ctx.save();
			if (tool === 'brush' || tool === 'eraser') {
				// 圆形光标：大小 = brushSize 映射到视图像素
				const radius = Math.max(3, (brushSize * VIEW_W) / 2);
				ctx.strokeStyle = tool === 'eraser' ? '#60a5fa' : '#ffffff';
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(px, py, radius, 0, Math.PI * 2);
				ctx.stroke();
				// 中心准星
				ctx.beginPath();
				ctx.moveTo(px - 4, py); ctx.lineTo(px + 4, py);
				ctx.moveTo(px, py - 4); ctx.lineTo(px, py + 4);
				ctx.stroke();
			} else if (tool === 'fill') {
				// 填充桶图标
				ctx.font = '15px sans-serif';
				ctx.fillStyle = '#facc15';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText('🪣', px, py);
			}
			// rect/ellipse 的光标反馈已由 draft preview 承担
			ctx.restore();
		}
	}, [ops, imgReady, viewH, imgSize, pointerPos, tool, brushSize]);

	// ── painting ───────────────────────────────────────────────────────────
	const localN = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return {
			x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
			y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
		};
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { x, y } = localN(e);
		setPointerPos({ x, y });
		if (tool === 'brush' || tool === 'eraser') {
			const op: MaskStrokeOp = { type: tool, points: [[x, y]], size: brushSize, opacity, hardness };
			const next = [...opsRef.current, op];
			commitOps(next);
			strokeRef.current = { opIndex: next.length - 1 };
		} else if (tool === 'fill') {
			// 填充：从点击点 flood fill 连通区域（对齐 ComfyTV applyFill）。
			const op: MaskFillOp = { type: 'fill', x, y, opacity };
			commitOps([...opsRef.current, op]);
		} else if (tool === 'label') {
			// 编号圆点：自增计数（对齐 ComfyTV placeLabel）。
			labelCounterRef.current += 1;
			const op: MaskLabelOp = { type: 'label', x, y, n: labelCounterRef.current, size: brushSize };
			commitOps([...opsRef.current, op]);
		} else {
			draftRef.current = { type: tool, x0: x, y0: y, x1: x, y1: y };
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { x, y } = localN(e);
		setPointerPos({ x, y });
		if (strokeRef.current) {
			const idx = strokeRef.current.opIndex;
			const cur = opsRef.current[idx];
			if (cur && (cur.type === 'brush' || cur.type === 'eraser')) {
				const next = [...opsRef.current];
				next[idx] = { ...cur, points: [...cur.points, [x, y]] };
				commitOps(next);
			}
		} else if (draftRef.current) {
			draftRef.current.x1 = x;
			draftRef.current.y1 = y;
			setOps([...opsRef.current]); // force redraw
		}
	};

	const onPointerUp = () => {
		setPointerPos(null);
		if (draftRef.current) {
			const d = draftRef.current;
			const op: MaskShapeOp = {
				type: d.type, x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
				w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0), size: brushSize,
			};
			if (op.w > 0.005 || op.h > 0.005) { commitOps([...opsRef.current, op]); }
		}
		draftRef.current = null;
		strokeRef.current = null;
	};

	const clear = () => { commitOps([]); setLastMask(''); };

	// ── commitMask（对齐 ComfyTV usePainter.commitMask）────────────────────
	const commitMask = React.useCallback(async () => {
		const runner = runnersRef.current.resolve(preferenceRef.current);
		if (!runner?.fetchApi) {
			onMaskChange('');
			return;
		}
		const w = imgSize?.w ?? 1024;
		const h = imgSize?.h ?? 1024;
		const blob = await renderMaskBlob(opsRef.current, w, h);
		if (!blob) { onMaskChange(''); return; }
		setUploading(true);
		try {
			const form = new FormData();
			form.append('image', blob, `comfytv-painter-${Date.now()}.png`);
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const name = String(data?.name ?? '');
			const sub = String(data?.subfolder ?? '');
			const annotated = `${sub ? sub + '/' : ''}${name} [input]`;
			setLastMask(annotated);
			onMaskChange(annotated);
		} catch {
			onMaskChange('');
		} finally {
			setUploading(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [imgSize, onMaskChange]);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			{showPrompt && (
				<label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
					<span style={{ color: 'var(--vscode-descriptionForeground)' }}>提示词（inpaint 用）</span>
					<textarea
						value={initialPrompt ?? ''}
						onChange={e => onPromptChange?.(e.target.value)}
						rows={2}
						style={{ background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)', borderRadius: 5, padding: '6px 8px', fontSize: 12, outline: 'none', fontFamily: 'inherit', resize: 'vertical' }}
					/>
				</label>
			)}
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
				{TOOLS.map(t => (
					<button
						key={t.id}
						onClick={() => setTool(t.id)}
						style={{
							padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
							background: tool === t.id ? 'rgba(59,130,246,.25)' : 'rgba(255,255,255,.05)',
							color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
						}}
					>
						{t.label}
					</button>
				))}
			</div>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				{(tool === 'brush' || tool === 'eraser' || tool === 'rect' || tool === 'ellipse' || tool === 'label') && (
					<label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
						粗细
						<input type="range" min={3} max={80} value={Math.round(brushSize * 2000)}
							onChange={e => setBrushSize(Number(e.target.value) / 2000)}
							style={{ width: 70, accentColor: '#4a9eff' }} />
					</label>
				)}
				{/* 对齐 ComfyTV PainterStageCard：opacity 除橡皮外显示，hardness 仅笔刷显示 */}
				{tool !== 'eraser' && tool !== 'fill' && tool !== 'label' && (
					<label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
						不透明度 {Math.round(opacity * 100)}%
						<input type="range" min={0} max={100} value={Math.round(opacity * 100)}
							onChange={e => setOpacity(Number(e.target.value) / 100)}
							style={{ width: 70, accentColor: '#4a9eff' }} />
					</label>
				)}
				{tool === 'brush' && (
					<label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
						硬度 {Math.round(hardness * 100)}%
						<input type="range" min={0} max={100} value={Math.round(hardness * 100)}
							onChange={e => setHardness(Number(e.target.value) / 100)}
							style={{ width: 70, accentColor: '#4a9eff' }} />
					</label>
				)}
			</div>
			<canvas
				ref={canvasRef}
				width={VIEW_W}
				height={viewH}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				data-no-node-drag="true"
				style={{
					width: '100%', borderRadius: 8, touchAction: 'none', display: 'block', background: '#101014',
					cursor: (tool === 'brush' || tool === 'eraser' || tool === 'fill' || tool === 'rect' || tool === 'ellipse')
						? 'none' : 'crosshair',
				}}
			/>
			<div style={{ display: 'flex', gap: 8 }}>
				<button
					onClick={() => { void commitMask(); }}
					disabled={uploading || ops.length === 0}
					style={{ padding: '4px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 11, background: 'rgba(59,130,246,.2)', color: 'var(--vscode-foreground)', border: '1px solid rgba(59,130,246,.4)', fontFamily: 'inherit' }}
				>
					{uploading ? '上传中…' : '应用 mask'}
				</button>
				<button
					onClick={clear}
					style={{ padding: '4px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 11, background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit' }}
				>
					↺ 清除
				</button>
			</div>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				{lastMask
					? <>mask：<span style={{ fontFamily: 'monospace' }}>{lastMask}</span></>
					: '涂抹 = 要擦除区域（红）；恢复 = 保留（白）。点「应用 mask」上传后，再点「生成」。'}
			</div>
		</div>
	);
}
