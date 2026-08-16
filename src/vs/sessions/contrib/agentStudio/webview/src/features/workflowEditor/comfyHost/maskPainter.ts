/*---------------------------------------------------------------------------------------------
 *  maskPainter — 交互式擦除/内绘 mask 的纯逻辑（ComfyTV EraseStage/InpaintStage 增强）。
 *
 *  对齐 ComfyTV usePainter.ts 的 mask 语义：
 *    - 笔迹（brush）= 要擦除/编辑的区域 → 最终 mask 里为透明
 *    - eraser 擦掉的 = 保留区域 → 最终 mask 里为白色
 *    - fill（吸管式 flood fill）= 把连通区域标记为编辑区
 *    - label = 编号圆点（多区域分割标注）
 *    - commitMask（usePainter.ts:561-599）：白底 + destination-out 扣掉用户画布 → PNG
 *
 *  软笔刷：hardness<1 时用径向渐变产生软边，opacity<1 时产生半透明（灰度）蒙版，
 *  完全对齐 ComfyTV 的 getEffectiveBrushSize / drawCircle / compositeStrokeToMain。
 *  全部纯函数/离屏 canvas，可单测（不依赖 DOM 交互）。
 *--------------------------------------------------------------------------------------------*/

export type MaskTool = 'brush' | 'eraser' | 'fill' | 'rect' | 'ellipse' | 'label';

export interface MaskStrokeOp {
	type: 'brush' | 'eraser';
	points: Array<[number, number]>;
	size: number;
	opacity?: number;
	hardness?: number;
}
export interface MaskShapeOp {
	type: 'rect' | 'ellipse';
	x: number; y: number; w: number; h: number;
	size: number;
	opacity?: number;
}
export interface MaskFillOp { type: 'fill'; x: number; y: number; opacity: number }
export interface MaskLabelOp { type: 'label'; x: number; y: number; n: number; size: number }
export type MaskOp = MaskStrokeOp | MaskShapeOp | MaskFillOp | MaskLabelOp;

// ── 软笔刷尺寸（对齐 ComfyTV brushUtils.ts）────────────────────────────────────
function getEffectiveBrushSize(radius: number, hardness: number): number {
	const MAX_SCALE = 1.5;
	const scale = 1.0 + (1.0 - hardness) * (MAX_SCALE - 1.0);
	return radius * scale;
}
function getEffectiveHardness(radius: number, hardness: number, effectiveSize: number): number {
	if (effectiveSize <= 0) { return 0; }
	return (radius * hardness) / effectiveSize;
}

// ── flood fill（对齐 ComfyTV widgets/painter/floodFill.ts）────────────────────
interface PixelBuffer { data: Uint8ClampedArray; width: number; height: number }
const FILL_TOLERANCE = 32;

function floodFill(
	buf: PixelBuffer,
	startX: number,
	startY: number,
	alpha: number,
	tolerance = FILL_TOLERANCE,
): boolean {
	const { data, width, height } = buf;
	const x0 = Math.floor(startX);
	const y0 = Math.floor(startY);
	if (x0 < 0 || x0 >= width || y0 < 0 || y0 >= height) { return false; }

	const targetAlpha = data[(y0 * width + x0) * 4 + 3];
	const fillAlpha = Math.max(0, Math.min(255, Math.round(alpha)));
	const matches = (a: number) => Math.abs(a - targetAlpha) <= tolerance;

	const visited = new Uint8Array(width * height);
	const stack: number[] = [y0 * width + x0];
	let changed = false;

	while (stack.length > 0) {
		const idx = stack.pop()!;
		if (visited[idx]) { continue; }
		visited[idx] = 1;
		const p = idx * 4;
		if (!matches(data[p + 3])) { continue; }
		data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = fillAlpha;
		changed = true;
		const x = idx % width;
		if (x > 0 && !visited[idx - 1]) { stack.push(idx - 1); }
		if (x < width - 1 && !visited[idx + 1]) { stack.push(idx + 1); }
		if (idx >= width && !visited[idx - width]) { stack.push(idx - width); }
		if (idx < width * (height - 1) && !visited[idx + width]) { stack.push(idx + width); }
	}
	return changed;
}

/** 在 (x,y) 处盖一个径向渐变或实心圆（软硬笔刷）。 */
function stampCircle(
	ctx: CanvasRenderingContext2D,
	x: number, y: number,
	effR: number, hardness: number, opacity: number,
): void {
	if (effR <= 0) { return; }
	if (hardness >= 1) {
		ctx.fillStyle = `rgba(0,0,0,${opacity})`;
		ctx.beginPath();
		ctx.arc(x, y, effR, 0, Math.PI * 2);
		ctx.fill();
	} else {
		const eh = Math.max(0.001, getEffectiveHardness(effR, hardness, effR));
		const grad = ctx.createRadialGradient(x, y, 0, x, y, effR);
		grad.addColorStop(0, `rgba(0,0,0,${opacity})`);
		grad.addColorStop(eh, `rgba(0,0,0,${opacity})`);
		grad.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.fillStyle = grad;
		ctx.beginPath();
		ctx.arc(x, y, effR, 0, Math.PI * 2);
		ctx.fill();
	}
}

/** 沿线段盖圆（软笔刷插值采样，硬笔刷直接画连线段）。 */
function stampSegment(
	ctx: CanvasRenderingContext2D,
	from: [number, number], to: [number, number],
	effR: number, hardness: number, opacity: number,
): void {
	if (hardness >= 1) {
		ctx.strokeStyle = `rgba(0,0,0,${opacity})`;
		ctx.lineWidth = effR * 2;
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(from[0], from[1]);
		ctx.lineTo(to[0], to[1]);
		ctx.stroke();
		stampCircle(ctx, to[0], to[1], effR, hardness, opacity);
	} else {
		const dx = to[0] - from[0];
		const dy = to[1] - from[1];
		const dist = Math.hypot(dx, dy);
		const step = Math.max(1, effR / 2);
		const steps = Math.max(1, Math.ceil(dist / step));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			stampCircle(ctx, from[0] + dx * t, from[1] + dy * t, effR, hardness, opacity);
		}
	}
}

/** 把归一化坐标（0-1）的 ops 画到像素 canvas ctx 上（透明底）。 */
export function drawMaskOps(
	ctx: CanvasRenderingContext2D,
	ops: MaskOp[],
	width: number,
	height: number,
): void {
	ctx.globalCompositeOperation = 'source-over';
	ctx.globalAlpha = 1;
	ctx.clearRect(0, 0, width, height);

	for (const op of ops) {
		if (op.type === 'brush' || op.type === 'eraser') {
			const isEraser = op.type === 'eraser';
			const opacity = isEraser ? 1 : (op.opacity ?? 1);
			const hardness = isEraser ? 1 : (op.hardness ?? 1);
			const radius = Math.max(0.5, op.size * width / 2);
			const effR = getEffectiveBrushSize(radius, hardness);
			ctx.globalCompositeOperation = isEraser ? 'destination-out' : 'source-over';
			ctx.globalAlpha = 1;
			const pts = op.points;
			if (pts.length === 1) {
				const [nx, ny] = pts[0];
				stampCircle(ctx, nx * width, ny * height, effR, hardness, opacity);
			} else {
				let prev: [number, number] = [pts[0][0] * width, pts[0][1] * height];
				for (let i = 1; i < pts.length; i++) {
					const cur: [number, number] = [pts[i][0] * width, pts[i][1] * height];
					stampSegment(ctx, prev, cur, effR, hardness, opacity);
					prev = cur;
				}
			}
		} else if (op.type === 'rect' || op.type === 'ellipse') {
			// ComfyTV previewShape：描边轮廓（不填充），lineWidth = max(2, brushSize/4)。
			const opacity = op.opacity ?? 1;
			const lw = Math.max(2, (op.size * width) / 4);
			ctx.globalCompositeOperation = 'source-over';
			ctx.globalAlpha = opacity;
			ctx.strokeStyle = 'rgba(0,0,0,1)';
			ctx.lineWidth = lw;
			ctx.lineJoin = 'round';
			const px = op.x * width, py = op.y * height, pw = op.w * width, ph = op.h * height;
			ctx.beginPath();
			if (op.type === 'ellipse') {
				ctx.ellipse(px + pw / 2, py + ph / 2, Math.abs(pw) / 2, Math.abs(ph) / 2, 0, 0, Math.PI * 2);
			} else {
				ctx.strokeRect(px, py, pw, ph);
			}
			ctx.stroke();
		} else if (op.type === 'fill') {
			const fx = Math.floor(op.x * width);
			const fy = Math.floor(op.y * height);
			const img = ctx.getImageData(0, 0, width, height);
			floodFill({ data: img.data, width, height }, fx, fy, op.opacity * 255);
			ctx.putImageData(img, 0, 0);
		} else if (op.type === 'label') {
			// ComfyTV placeLabel：实心圆点（编号在预览层画）。
			const r = Math.max(8, (op.size * width) / 2);
			ctx.globalCompositeOperation = 'source-over';
			ctx.globalAlpha = 1;
			ctx.fillStyle = 'rgba(0,0,0,1)';
			ctx.beginPath();
			ctx.arc(op.x * width, op.y * height, r, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	ctx.globalCompositeOperation = 'source-over';
	ctx.globalAlpha = 1;
}

/**
 * 导出 mask PNG（对齐 ComfyTV commitMask）：
 * 白底 + destination-out 扣掉用户笔迹 → 白色=保留，透明=擦除区域。
 * 软笔刷产生灰度半透明蒙版，与 ComfyTV 一致。
 */
export async function renderMaskBlob(
	ops: MaskOp[],
	width: number,
	height: number,
): Promise<Blob | null> {
	const exportCanvas = document.createElement('canvas');
	exportCanvas.width = width;
	exportCanvas.height = height;
	const ectx = exportCanvas.getContext('2d');
	if (!ectx) { return null; }
	// 1. 白底
	ectx.fillStyle = '#ffffff';
	ectx.fillRect(0, 0, width, height);
	// 2. 在透明子 canvas 上画笔迹，再 destination-out 到白底
	const sub = document.createElement('canvas');
	sub.width = width;
	sub.height = height;
	const sctx = sub.getContext('2d');
	if (!sctx) { return null; }
	drawMaskOps(sctx, ops, width, height);
	ectx.globalCompositeOperation = 'destination-out';
	ectx.drawImage(sub, 0, 0);
	ectx.globalCompositeOperation = 'source-over';
	return await new Promise<Blob | null>((resolve) => exportCanvas.toBlob(resolve, 'image/png'));
}

/** 把 ops 序列化为可持久化 JSON（存储到 values 里以便重开编辑器恢复）。 */
export function maskOpsToJson(ops: MaskOp[]): string {
	return JSON.stringify(ops);
}

/** 反序列化 ops（防御：非法输入返回空数组）。 */
export function parseMaskOps(json: string | undefined): MaskOp[] {
	if (!json) { return []; }
	try {
		const v = JSON.parse(json) as unknown;
		if (!Array.isArray(v)) { return []; }
		return v.filter((o): o is MaskOp => {
			if (!o || typeof o !== 'object') { return false; }
			const t = (o as { type?: unknown }).type;
			return t === 'brush' || t === 'eraser' || t === 'rect' || t === 'ellipse'
				|| t === 'fill' || t === 'label';
		});
	} catch {
		return [];
	}
}
