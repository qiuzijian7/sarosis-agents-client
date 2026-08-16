/*---------------------------------------------------------------------------------------------
 *  RotoMaskEditor — spline→mask editor for the ComfyTV Roto Mask stage (P3).
 *  Draw a closed Bezier spline on the upstream video's first frame: drag
 *  vertices (handles follow) or tangent handles, click empty space to append a
 *  vertex. Single keyframe (`t:0`) — multi-keyframe animation can be layered
 *  later. Feather/invert are persisted alongside the shape_keys JSON.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	addShapePoint, applySmooth, defaultShapePoints, moveShapePoint, moveShapeTangent, parseShapeKeys,
	removeShapePoint, shapeKeysToJson,
	type RotoPoint, type ShapeKeyframe,
} from './comfyHost/rotoMaskEditor';

export interface RotoMaskEditorProps {
	initialShapeKeys: string;
	videoRef?: string;
	initialFeather: number;
	initialInvert: boolean;
	onShapeChange: (shapeKeysJson: string, feather: number, invert: boolean) => void;
}

const VIEW_W = 360;
const VIEW_H = 204;

type DragKind = 'v' | 'l' | 'r';

export function RotoMaskEditor({ initialShapeKeys, videoRef, initialFeather, initialInvert, onShapeChange }: RotoMaskEditorProps): React.JSX.Element {
	const [keyframe, setKeyframe] = React.useState<ShapeKeyframe>(() => parseShapeKeys(initialShapeKeys) ?? { t: 0, points: defaultShapePoints() });
	const [feather, setFeather] = React.useState(initialFeather);
	const [invert, setInvert] = React.useState(initialInvert);
	const [smooth, setSmooth] = React.useState(true);
	const [drag, setDrag] = React.useState<{ kind: DragKind; index: number } | null>(null);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const videoRefEl = React.useRef<HTMLVideoElement | null>(null);
	const [frameReady, setFrameReady] = React.useState(false);

	React.useEffect(() => {
		if (!videoRef || !videoRef.startsWith('http')) { return; }
		const video = document.createElement('video');
		videoRefEl.current = video;
		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.crossOrigin = 'anonymous';
		const onData = () => { setFrameReady(true); };
		const onError = () => { setFrameReady(false); };
		video.addEventListener('loadeddata', onData);
		video.addEventListener('error', onError);
		video.src = videoRef;
		return () => {
			video.removeEventListener('loadeddata', onData);
			video.removeEventListener('error', onError);
			video.removeAttribute('src');
		};
	}, [videoRef]);

	const commit = React.useCallback((kf: ShapeKeyframe) => {
		setKeyframe(kf);
		onShapeChange(shapeKeysToJson([{ ...kf, t: 0 }]), feather, invert);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onShapeChange, feather, invert]);

	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		ctx.clearRect(0, 0, VIEW_W, VIEW_H);
		ctx.fillStyle = '#17181c';
		ctx.fillRect(0, 0, VIEW_W, VIEW_H);
		const video = videoRefEl.current;
		if (frameReady && video && video.videoWidth) {
			const scale = Math.min(VIEW_W / video.videoWidth, VIEW_H / video.videoHeight);
			const dw = video.videoWidth * scale; const dh = video.videoHeight * scale;
			ctx.drawImage(video, (VIEW_W - dw) / 2, (VIEW_H - dh) / 2, dw, dh);
		}
		const pts = keyframe.points;
		if (pts.length) {
			// spline fill + stroke
			ctx.beginPath();
			ctx.moveTo(pts[0].x * VIEW_W, pts[0].y * VIEW_H);
			for (let i = 0; i < pts.length; i++) {
				const p = pts[i]; const q = pts[(i + 1) % pts.length];
				ctx.bezierCurveTo(p.rx * VIEW_W, p.ry * VIEW_H, q.lx * VIEW_W, q.ly * VIEW_H, q.x * VIEW_W, q.y * VIEW_H);
			}
			ctx.closePath();
			ctx.fillStyle = 'rgba(74,158,255,.22)';
			ctx.fill();
			ctx.strokeStyle = '#4a9eff';
			ctx.lineWidth = 2;
			ctx.stroke();
			// handles + vertices
			pts.forEach((p, i) => {
				const x = p.x * VIEW_W; const y = p.y * VIEW_H;
				const lx = p.lx * VIEW_W; const ly = p.ly * VIEW_H;
				const rx = p.rx * VIEW_W; const ry = p.ry * VIEW_H;
				ctx.strokeStyle = 'rgba(255,255,255,.55)';
				ctx.lineWidth = 1;
				ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly); ctx.stroke();
				ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(rx, ry); ctx.stroke();
				ctx.fillStyle = '#fff';
				ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
				ctx.beginPath(); ctx.arc(rx, ry, 3, 0, Math.PI * 2); ctx.fill();
				ctx.fillStyle = i === drag?.index && drag.kind === 'v' ? '#fff' : '#4a9eff';
				ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
				ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
				ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
			});
		}
	}, [keyframe, drag, frameReady]);

	const localN = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { x, y } = localN(e);
		const pts = keyframe.points;
		// tangents first (smaller targets)
		for (let i = 0; i < pts.length; i++) {
			if (Math.hypot(pts[i].lx - x, pts[i].ly - y) < 0.035) { setDrag({ kind: 'l', index: i }); return; }
			if (Math.hypot(pts[i].rx - x, pts[i].ry - y) < 0.035) { setDrag({ kind: 'r', index: i }); return; }
		}
		for (let i = 0; i < pts.length; i++) {
			if (Math.hypot(pts[i].x - x, pts[i].y - y) < 0.05) { setDrag({ kind: 'v', index: i }); return; }
		}
		// empty space → append a vertex
		commit({ t: 0, points: addShapePoint(pts, x, y) });
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!drag) { return; }
		const { x, y } = localN(e);
		const pts = keyframe.points;
		if (drag.kind === 'v') { commit({ t: 0, points: moveShapePoint(pts, drag.index, x, y) }); }
		else {
			// 手动拖切线 → 切到手动模式（smooth 自动切线被覆盖）
			if (smooth) { setSmooth(false); }
			commit({ t: 0, points: moveShapeTangent(pts, drag.index, drag.kind, x, y) });
		}
	};

	const onPointerUp = () => { setDrag(null); };

	// 双击删除顶点（对齐 ComfyTV useRotoMaskEditor.onDbl）
	const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
		const { x, y } = localN(e);
		const pts = keyframe.points;
		for (let i = 0; i < pts.length; i++) {
			if (Math.hypot(pts[i].x - x, pts[i].y - y) < 0.05) {
				commit({ t: 0, points: removeShapePoint(pts, i) });
				return;
			}
		}
	};

	const removeVertex = () => {
		if (drag?.kind === 'v') {
			commit({ t: 0, points: removeShapePoint(keyframe.points, drag.index) });
		}
	};

	const toggleSmooth = (next: boolean) => {
		setSmooth(next);
		commit({ t: 0, points: applySmooth(keyframe.points, next) });
	};

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<canvas
				ref={canvasRef}
				width={VIEW_W}
				height={VIEW_H}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				onDoubleClick={onDoubleClick}
				style={{ width: '100%', borderRadius: 8, touchAction: 'none', cursor: 'crosshair', background: '#17181c', display: 'block' }}
			/>
			<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
				<label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
					<input type="checkbox" checked={smooth}
						onChange={e => toggleSmooth(e.target.checked)}
						style={{ accentColor: '#4a9eff' }} />
					平滑
				</label>
				<button
					onClick={removeVertex}
					disabled={keyframe.points.length <= 3}
					style={{ padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10, background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit' }}
				>
					🗑 删选中顶点
				</button>
				<label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
					羽化 {Math.round(feather)}px
					<input type="range" min={0} max={200} step={1} value={feather}
						onChange={e => { const v = Number(e.target.value); setFeather(v); onShapeChange(shapeKeysToJson([{ ...keyframe, t: 0 }]), v, invert); }}
						style={{ width: 90, accentColor: '#4a9eff' }} />
				</label>
				<label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
					<input type="checkbox" checked={invert}
						onChange={e => { const v = e.target.checked; setInvert(v); onShapeChange(shapeKeysToJson([{ ...keyframe, t: 0 }]), feather, v); }}
						style={{ accentColor: '#4a9eff' }} />
					反转
				</label>
			</div>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				点击画布空白处添加顶点，拖拽顶点/切线手柄调整样条，双击顶点删除；执行时输出动画蒙版视频。
			</div>
		</div>
	);
}
