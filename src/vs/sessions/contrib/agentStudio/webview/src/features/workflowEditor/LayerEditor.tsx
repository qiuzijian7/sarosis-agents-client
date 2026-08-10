/*---------------------------------------------------------------------------------------------
 *  LayerEditor — artboard editor for the ComfyTV Layer Editor stage (P3 MVP).
 *  Layers + paint ops (brush / eraser / rect / circle / text) composited on a
 *  2D canvas; the flattened result is debounce-uploaded to ComfyUI input/.
 *  The `layer_state` document JSON is stored in ComfyTV-compatible fields.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	addLayerOp, clampN, defaultLayerDoc, drawLayerDoc, layerDocToJson, newLayerId, parseLayerDoc,
	type LayerDoc, type LayerInfo, type LayerOp, type LayerOpType,
} from './comfyHost/layerEditor';

export interface LayerEditorProps {
	initialDoc: string;
	width: number;
	height: number;
	runners: ComfyRunnerRegistry;
	preference: string;
	onDocChange: (json: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const UPLOAD_DEBOUNCE_MS = 1200;
const TOOLS: Array<{ id: LayerOpType | 'select'; label: string }> = [
	{ id: 'brush', label: '🖌 画笔' },
	{ id: 'eraser', label: '⌫ 橡皮' },
	{ id: 'rect', label: '▭ 矩形' },
	{ id: 'circle', label: '◯ 圆形' },
	{ id: 'text', label: 'T 文字' },
];

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '4px 7px', fontSize: 12, outline: 'none',
};

export function LayerEditor({ initialDoc, width, height, runners, preference, onDocChange, onRenderUploaded }: LayerEditorProps): React.JSX.Element {
	const [doc, setDoc] = React.useState<LayerDoc>(() => parseLayerDoc(initialDoc, width, height));
	const [activeLayerId, setActiveLayerId] = React.useState<string | null>(doc.layers[0]?.id ?? null);
	const [tool, setTool] = React.useState<LayerOpType>('brush');
	const [color, setColor] = React.useState('#ffffff');
	const [brushSize, setBrushSize] = React.useState(0.01);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const dragRef = React.useRef<{ opIndex: number; points: Array<[number, number]> } | null>(null);
	const draftRef = React.useRef<{ type: 'rect' | 'circle'; x0: number; y0: number; x1: number; y1: number } | null>(null);
	const uploadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;

	const VIEW_W = 360;
	const scale = VIEW_W / doc.width;
	const VIEW_H = Math.round(doc.height * scale);

	const activeLayer = doc.layers.find(l => l.id === activeLayerId) ?? null;

	const scheduleUpload = React.useCallback(() => {
		if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); }
		uploadTimerRef.current = setTimeout(() => { void uploadRender(); }, UPLOAD_DEBOUNCE_MS);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [uploadRender]);

	const uploadRender = React.useCallback(async () => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const runner = runnersRef.current.resolve(preferenceRef.current);
		if (!runner?.fetchApi) { onRenderUploaded(null); return; }
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
		if (!blob) { return; }
		try {
			const form = new FormData();
			form.append('image', blob, 'layered.png');
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const url = `${runner.baseUrl}/view?filename=${encodeURIComponent(String(data?.name ?? ''))}&subfolder=${encodeURIComponent(String(data?.subfolder ?? ''))}&type=${String(data?.type ?? 'output')}`;
			onRenderUploaded(url);
		} catch {
			onRenderUploaded(null);
		}
	}, [onRenderUploaded]);

	React.useEffect(() => () => { if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); } }, []);

	const commit = React.useCallback((next: LayerDoc) => {
		setDoc(next);
		onDocChange(layerDocToJson(next));
		scheduleUpload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onDocChange]);

	// ── draw ───────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = '#101014';
		ctx.fillRect(0, 0, VIEW_W, VIEW_H);
		ctx.imageSmoothingEnabled = true;
		ctx.scale(scale, scale);
		drawLayerDoc(ctx, doc);
		// draft shape while dragging
		const d = draftRef.current;
		if (d) {
			ctx.fillStyle = color;
			ctx.globalAlpha = 0.35;
			if (d.type === 'rect') {
				ctx.fillRect(Math.min(d.x0, d.x1) * doc.width, Math.min(d.y0, d.y1) * doc.height, Math.abs(d.x1 - d.x0) * doc.width, Math.abs(d.y1 - d.y0) * doc.height);
			} else {
				const cx = ((d.x0 + d.x1) / 2) * doc.width;
				const cy = ((d.y0 + d.y1) / 2) * doc.height;
				ctx.beginPath();
				ctx.arc(cx, cy, Math.hypot(d.x1 - d.x0, d.y1 - d.y0) * doc.width / 2, 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.globalAlpha = 1;
		}
	}, [doc, color, scale, VIEW_H, VIEW_W]);

	// ── painting ───────────────────────────────────────────────────────────
	const localN = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { x: clampN((e.clientX - rect.left) / rect.width), y: clampN((e.clientY - rect.top) / rect.height) };
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!activeLayer) { return; }
		const { x, y } = localN(e);
		if (tool === 'brush' || tool === 'eraser') {
			const op: LayerOp = { type: tool, color, size: brushSize, points: [[x, y]] };
			let next = addLayerOp(doc, activeLayer.id, op);
			setDoc(next);
			onDocChange(layerDocToJson(next));
			scheduleUpload();
			dragRef.current = { opIndex: next.layers.find(l => l.id === activeLayer.id)!.ops.length - 1, points: [[x, y]] };
		} else if (tool === 'rect' || tool === 'circle') {
			draftRef.current = { type: tool, x0: x, y0: y, x1: x, y1: y };
		} else if (tool === 'text') {
			const text = window.prompt('输入文字：');
			if (text) {
				const op: LayerOp = { type: 'text', color, size: brushSize, x, y, text, fontSize: 0.06 };
				commit(addLayerOp(doc, activeLayer.id, op));
			}
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { x, y } = localN(e);
		if (dragRef.current) {
			const li = doc.layers.findIndex(l => l.id === activeLayerId);
			if (li < 0) { return; }
			const ops = [...doc.layers[li].ops];
			const op = ops[dragRef.current.opIndex];
			if (op && op.type === 'stroke' || op?.type === 'eraser') {
				ops[dragRef.current.opIndex] = { ...op, points: [...(op.points ?? []), [x, y]] };
			}
			const next = { ...doc, layers: doc.layers.map((l, i) => (i === li ? { ...l, ops } : l)) };
			setDoc(next);
			onDocChange(layerDocToJson(next));
			scheduleUpload();
			dragRef.current.points.push([x, y]);
		} else if (draftRef.current) {
			draftRef.current.x1 = x;
			draftRef.current.y1 = y;
			setDoc({ ...doc }); // force redraw
		}
	};

	const onPointerUp = () => {
		if (draftRef.current && activeLayer) {
			const d = draftRef.current;
			const op: LayerOp = {
				type: d.type,
				color,
				size: brushSize,
				x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
				w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
			};
			if (op.w! > 0.005 || op.h! > 0.005) { commit(addLayerOp(doc, activeLayer.id, op)); }
		}
		draftRef.current = null;
		dragRef.current = null;
	};

	// ── layers ─────────────────────────────────────────────────────────────
	const addLayer = () => {
		const layer: LayerInfo = { id: newLayerId(), name: `图层 ${doc.layers.length + 1}`, visible: true, opacity: 1, ops: [] };
		const next = { ...doc, layers: [...doc.layers, layer] };
		setActiveLayerId(layer.id);
		commit(next);
	};

	const removeLayer = () => {
		if (!activeLayerId || doc.layers.length <= 1) { return; }
		const next = { ...doc, layers: doc.layers.filter(l => l.id !== activeLayerId) };
		setActiveLayerId(next.layers[next.layers.length - 1].id);
		commit(next);
	};

	const moveLayer = (dir: -1 | 1) => {
		const idx = doc.layers.findIndex(l => l.id === activeLayerId);
		const target = idx + dir;
		if (idx < 0 || target < 0 || target >= doc.layers.length) { return; }
		const layers = [...doc.layers];
		[layers[idx], layers[target]] = [layers[target], layers[idx]];
		commit({ ...doc, layers });
	};

	const toggleLayerVisible = (id: string) => {
		commit({ ...doc, layers: doc.layers.map(l => (l.id === id ? { ...l, visible: !l.visible } : l)) });
	};

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
				<label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginLeft: 4 }}>
					颜色
					<input type="color" value={color} onChange={e => setColor(e.target.value)}
						style={{ width: 26, height: 22, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }} />
				</label>
				<label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
					粗细
					<input type="range" min={2} max={40} value={Math.round(brushSize * 2000)}
						onChange={e => setBrushSize(Number(e.target.value) / 2000)}
						style={{ width: 70, accentColor: '#4a9eff' }} />
				</label>
			</div>
			<canvas
				ref={canvasRef}
				width={VIEW_W}
				height={VIEW_H}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				style={{ width: '100%', borderRadius: 8, touchAction: 'none', cursor: tool === 'text' ? 'text' : 'crosshair', background: '#101014', display: 'block' }}
			/>
			<div style={{ display: 'flex', gap: 8 }}>
				<div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 150, overflowY: 'auto' }}>
					{doc.layers.map(l => (
						<div
							key={l.id}
							onClick={() => setActiveLayerId(l.id)}
							style={{
								display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', borderRadius: 5, cursor: 'pointer',
								background: l.id === activeLayerId ? 'rgba(59,130,246,.18)' : 'rgba(255,255,255,.04)',
								border: '1px solid rgba(255,255,255,.1)', fontSize: 11, color: 'var(--vscode-foreground)',
							}}
						>
							<input type="checkbox" checked={l.visible} onClick={e => e.stopPropagation()}
								onChange={() => toggleLayerVisible(l.id)} style={{ accentColor: '#4a9eff', cursor: 'pointer' }} />
							<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
							<span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)' }}>{l.ops.length}</span>
						</div>
					))}
				</div>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
					<button style={smallBtn} onClick={addLayer}>＋</button>
					<button style={smallBtn} onClick={() => moveLayer(1)}>↑</button>
					<button style={smallBtn} onClick={() => moveLayer(-1)}>↓</button>
					<button style={smallBtn} onClick={removeLayer} disabled={doc.layers.length <= 1}>🗑</button>
				</div>
			</div>
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				图层 + 画笔/橡皮/形状/文字；绘制后约 1.2 秒自动合成上传。
			</div>
		</div>
	);
}

const smallBtn: React.CSSProperties = {
	width: 26, height: 24, padding: 0, borderRadius: 5, cursor: 'pointer', fontSize: 12,
	background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
	border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
};
