/*---------------------------------------------------------------------------------------------
 *  CornerPinEditor — four-corner drag editor for the ComfyTV Corner Pin stage
 *  (P3). Draws the upstream video's first frame (when available) under a
 *  draggable quadrilateral (TL/TR/BR/BL); corners are stored in ComfyTV's
 *  **pixel-coordinate** JSON contract (aligned with useCornerPinEditor.ts).
 *  The stage itself is an fx-chain builder, so this editor only persists
 *  `corners` into the node values.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	CORNER_LABELS, clampCorner, defaultCorners, nearestCornerIndex, parseCorners, serializeCorners,
	type Corners,
} from './comfyHost/cornerPinEditor';

export interface CornerPinEditorProps {
	initialCorners: string;
	videoRef?: string;
	onCornersChange: (json: string) => void;
}

const VIEW_W = 360;
const VIEW_H = 204;

export function CornerPinEditor({ initialCorners, videoRef, onCornersChange }: CornerPinEditorProps): React.JSX.Element {
	// 视频实际分辨率未知前，corners 暂为空；加载后按 vw/vh 解析/默认。
	const [videoSize, setVideoSize] = React.useState<{ w: number; h: number } | null>(null);
	const [corners, setCorners] = React.useState<Corners>([[0, 0], [0, 0], [0, 0], [0, 0]]);
	const [dragIndex, setDragIndex] = React.useState(-1);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const videoRefEl = React.useRef<HTMLVideoElement | null>(null);
	const [frameReady, setFrameReady] = React.useState(false);
	const initializedRef = React.useRef(false);
	const videoSizeRef = React.useRef(videoSize); videoSizeRef.current = videoSize;

	// Load the upstream video's first frame + actual resolution (best effort).
	React.useEffect(() => {
		if (!videoRef || !videoRef.startsWith('http')) { return; }
		const video = document.createElement('video');
		videoRefEl.current = video;
		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.crossOrigin = 'anonymous';
		const onData = () => {
			setFrameReady(true);
			if (video.videoWidth > 0 && video.videoHeight > 0) {
				setVideoSize({ w: video.videoWidth, h: video.videoHeight });
			}
		};
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

	// 视频分辨率就绪后，解析初始 corners（像素）或默认全图。
	React.useEffect(() => {
		if (!videoSize || initializedRef.current) { return; }
		initializedRef.current = true;
		const parsed = parseCorners(initialCorners, videoSize.w, videoSize.h);
		setCorners(parsed);
		// 若初始为空/非法，回写默认值（保证 values 里有合法像素 corners）
		if (!initialCorners || !initialCorners.trim()) {
			onCornersChange(serializeCorners(parsed));
		}
	}, [videoSize, initialCorners, onCornersChange]);

	// 无视频时，用 1280×720 兜底分辨率（仍可编辑像素角点）。
	React.useEffect(() => {
		if (videoSize || initializedRef.current || videoRef) { return; }
		initializedRef.current = true;
		const fallback = { w: 1280, h: 720 };
		setVideoSize(fallback);
		const parsed = parseCorners(initialCorners, fallback.w, fallback.h);
		setCorners(parsed);
	}, [videoSize, videoRef, initialCorners, onCornersChange]);

	// fit scale（视频 → 视图）：保持宽高比居中。
	const fit = React.useMemo(() => {
		if (!videoSize) { return { scale: 1, ox: 0, oy: 0 }; }
		const s = Math.min(VIEW_W / videoSize.w, VIEW_H / videoSize.h);
		const dw = videoSize.w * s;
		const dh = videoSize.h * s;
		return { scale: s, ox: (VIEW_W - dw) / 2, oy: (VIEW_H - dh) / 2 };
	}, [videoSize]);

	// 像素 → 视图坐标
	const pxToView = (x: number, y: number): [number, number] => [fit.ox + x * fit.scale, fit.oy + y * fit.scale];
	// 视图坐标 → 像素
	const viewToPx = (x: number, y: number): [number, number] => [(x - fit.ox) / fit.scale, (y - fit.oy) / fit.scale];

	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		ctx.clearRect(0, 0, VIEW_W, VIEW_H);
		ctx.fillStyle = '#17181c';
		ctx.fillRect(0, 0, VIEW_W, VIEW_H);
		const video = videoRefEl.current;
		if (frameReady && video && video.videoWidth && videoSize) {
			ctx.drawImage(video, fit.ox, fit.oy, videoSize.w * fit.scale, videoSize.h * fit.scale);
		} else {
			ctx.strokeStyle = 'rgba(255,255,255,.12)';
			ctx.lineWidth = 1;
			for (let i = 1; i < 6; i++) {
				ctx.beginPath(); ctx.moveTo((VIEW_W / 6) * i, 0); ctx.lineTo((VIEW_W / 6) * i, VIEW_H); ctx.stroke();
				ctx.beginPath(); ctx.moveTo(0, (VIEW_H / 4) * i); ctx.lineTo(VIEW_W, (VIEW_H / 4) * i); ctx.stroke();
			}
		}
		// quadrilateral
		ctx.strokeStyle = '#4a9eff';
		ctx.lineWidth = 2;
		ctx.beginPath();
		corners.forEach((p, i) => {
			const [x, y] = pxToView(p[0], p[1]);
			if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
		});
		ctx.closePath();
		ctx.stroke();
		// handles
		corners.forEach((p, i) => {
			const [x, y] = pxToView(p[0], p[1]);
			ctx.fillStyle = i === dragIndex ? '#fff' : '#4a9eff';
			ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
			ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
			ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
			ctx.fillStyle = '#fff';
			ctx.font = '9px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(CORNER_LABELS[i], x, y - 14);
		});
	}, [corners, dragIndex, frameReady, fit, videoSize, pxToView]);

	const viewLocal = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
		const rect = e.currentTarget.getBoundingClientRect();
		return [(e.clientX - rect.left) / rect.width * VIEW_W, (e.clientY - rect.top) / rect.height * VIEW_H];
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const [vx, vy] = viewLocal(e);
		const [px, py] = viewToPx(vx, vy);
		const idx = nearestCornerIndex(corners, px, py);
		setDragIndex(idx);
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (dragIndex < 0 || !videoSize) { return; }
		const [vx, vy] = viewLocal(e);
		const [px, py] = viewToPx(vx, vy);
		const next = [...corners] as Corners;
		next[dragIndex] = clampCorner([px, py], videoSize.w, videoSize.h);
		setCorners(next);
		onCornersChange(serializeCorners(next));
	};

	const onPointerUp = () => { setDragIndex(-1); };

	const reset = () => {
		if (!videoSize) { return; }
		const next = defaultCorners(videoSize.w, videoSize.h);
		setCorners(next);
		onCornersChange(serializeCorners(next));
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
				style={{ width: '100%', borderRadius: 8, touchAction: 'none', cursor: 'grab', background: '#17181c', display: 'block' }}
			/>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<button
					onClick={reset}
					style={{ padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10, background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)', border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit' }}
				>
					↺ 重置角点
				</button>
				<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
					拖动四个角点做透视扭曲（TL/TR/BR/BL）
				</span>
			</div>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace' }}>
				{serializeCorners(corners)}{videoSize ? ` / 源 ${videoSize.w}×${videoSize.h}` : ''}
			</div>
		</div>
	);
}
