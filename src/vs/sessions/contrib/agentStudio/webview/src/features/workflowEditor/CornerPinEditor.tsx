/*---------------------------------------------------------------------------------------------
 *  CornerPinEditor — four-corner drag editor for the ComfyTV Corner Pin stage
 *  (P3). Draws the upstream video's first frame (when available) under a
 *  draggable quadrilateral (TL/TR/BR/BL); corners are stored in ComfyTV's
 *  normalized JSON contract. The stage itself is an fx-chain builder, so this
 *  editor only persists `corners` into the node values.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	CORNER_LABELS, clampCorner, cornersToJson, parseCorners,
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
	const [corners, setCorners] = React.useState<Corners>(() => parseCorners(initialCorners));
	const [dragIndex, setDragIndex] = React.useState(-1);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const videoRefEl = React.useRef<HTMLVideoElement | null>(null);
	const [frameReady, setFrameReady] = React.useState(false);

	// Load the upstream video's first frame as the backdrop (best effort).
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
			const vw = video.videoWidth; const vh = video.videoHeight;
			const scale = Math.min(VIEW_W / vw, VIEW_H / vh);
			const dw = vw * scale; const dh = vh * scale;
			ctx.drawImage(video, (VIEW_W - dw) / 2, (VIEW_H - dh) / 2, dw, dh);
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
			const x = p[0] * VIEW_W; const y = p[1] * VIEW_H;
			if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
		});
		ctx.closePath();
		ctx.stroke();
		// handles
		corners.forEach((p, i) => {
			const x = p[0] * VIEW_W; const y = p[1] * VIEW_H;
			ctx.fillStyle = i === dragIndex ? '#fff' : '#4a9eff';
			ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
			ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
			ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke();
			ctx.fillStyle = '#fff';
			ctx.font = '9px system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(CORNER_LABELS[i], x, y - 14);
		});
	}, [corners, dragIndex, frameReady]);

	const localN = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { x, y } = localN(e);
		for (let i = 0; i < corners.length; i++) {
			if (Math.hypot(corners[i][0] - x, corners[i][1] - y) < 0.05) {
				setDragIndex(i);
				return;
			}
		}
		setDragIndex(-1);
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (dragIndex < 0) { return; }
		const { x, y } = localN(e);
		const next = [...corners] as Corners;
		next[dragIndex] = clampCorner([x, y]);
		setCorners(next);
		onCornersChange(cornersToJson(next));
	};

	const onPointerUp = () => { setDragIndex(-1); };

	const reset = () => {
		const next = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]] as Corners;
		setCorners(next);
		onCornersChange(cornersToJson(next));
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
				{cornersToJson(corners)}
			</div>
		</div>
	);
}
