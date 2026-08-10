/*---------------------------------------------------------------------------------------------
 *  Scene3DEditor — 2.5D isometric scene editor for the ComfyTV 3D Scene stage
 *  (P3 MVP). Place box/cylinder/sphere primitives on an iso ground grid, drag
 *  to reposition, tune size/height/color, and debounce-upload the composite as
 *  the stage's `captured_image`. scene_state JSON aligned with ComfyTV.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	addSceneObject, defaultSceneDoc, parseSceneDoc, patchSceneObject, projectIso,
	removeSceneObject, renderScene, sceneDocToJson, screenToGround,
	type SceneDoc, type ScenePrimitiveKind,
} from './comfyHost/scene3dEditor';

export interface Scene3DEditorProps {
	initialState: string;
	runners: ComfyRunnerRegistry;
	preference: string;
	onStateChange: (json: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const VIEW = 360;
const UPLOAD_DEBOUNCE_MS = 1200;

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '3px 6px', fontSize: 11, outline: 'none',
};

export function Scene3DEditor({ initialState, runners, preference, onStateChange, onRenderUploaded }: Scene3DEditorProps): React.JSX.Element {
	const [doc, setDoc] = React.useState<SceneDoc>(() => parseSceneDoc(initialState, VIEW, VIEW));
	const [selectedId, setSelectedId] = React.useState<string | null>(doc.objects[0]?.id ?? null);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const dragRef = React.useRef<{ id: string } | null>(null);
	const uploadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;

	const selected = doc.objects.find(o => o.id === selectedId) ?? null;

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
			form.append('image', blob, 'scene.png');
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const url = `${runner.baseUrl}/view?filename=${encodeURIComponent(String(data?.name ?? ''))}&subfolder=${encodeURIComponent(String(data?.subfolder ?? ''))}&type=${String(data?.type ?? 'output')}`;
			onRenderUploaded(url);
		} catch {
			onRenderUploaded(null);
		}
	}, [onRenderUploaded]);

	React.useEffect(() => () => { if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); } }, []);

	const commit = React.useCallback((next: SceneDoc) => {
		setDoc(next);
		onStateChange(sceneDocToJson(next));
		scheduleUpload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onStateChange]);

	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		ctx.clearRect(0, 0, VIEW, VIEW);
		ctx.fillStyle = '#17181c';
		ctx.fillRect(0, 0, VIEW, VIEW);
		renderScene(ctx, doc);
		// selection ring
		if (selected) {
			const base = projectIso(selected.x, selected.y, selected.height, VIEW, VIEW);
			ctx.strokeStyle = '#fff';
			ctx.lineWidth = 2;
			ctx.setLineDash?.([4, 3]);
			ctx.beginPath?.();
			ctx.ellipse?.(base.sx, base.sy, selected.size * base.k * 0.9, selected.size * base.k * 0.45, 0, 0, Math.PI * 2);
			ctx.stroke?.();
			ctx.setLineDash?.([]);
		}
	}, [doc, selected]);

	const localPx = (e: React.PointerEvent<HTMLCanvasElement>): { sx: number; sy: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { sx: ((e.clientX - rect.left) / rect.width) * VIEW, sy: ((e.clientY - rect.top) / rect.height) * VIEW };
	};

	const hitTest = (sx: number, sy: number): string | null => {
		for (let i = doc.objects.length - 1; i >= 0; i--) {
			const o = doc.objects[i];
			const base = projectIso(o.x, o.y, 0, VIEW, VIEW);
			const r = o.size * base.k * 1.2;
			if (Math.hypot(sx - base.sx, sy - base.sy) < r) { return o.id; }
		}
		return null;
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { sx, sy } = localPx(e);
		const id = hitTest(sx, sy);
		if (id) {
			setSelectedId(id);
			dragRef.current = { id };
		} else {
			setSelectedId(null);
			dragRef.current = null;
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!dragRef.current) { return; }
		const { sx, sy } = localPx(e);
		const ground = screenToGround(sx, sy, VIEW, VIEW);
		commit(patchSceneObject(doc, dragRef.current.id, { x: ground.x, y: ground.y }));
	};

	const onPointerUp = () => { dragRef.current = null; };

	const addPrimitive = (kind: ScenePrimitiveKind) => {
		const next = addSceneObject(doc, kind);
		setSelectedId(next.objects[next.objects.length - 1].id);
		commit(next);
	};

	const patchSelected = (p: Partial<{ name: string; color: string; size: number; height: number }>) => {
		if (!selectedId) { return; }
		commit(patchSceneObject(doc, selectedId, p));
	};

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
				<button style={miniBtn} onClick={() => addPrimitive('box')}>+ 长方体</button>
				<button style={miniBtn} onClick={() => addPrimitive('cylinder')}>+ 圆柱</button>
				<button style={miniBtn} onClick={() => addPrimitive('sphere')}>+ 球体</button>
				{selected && (
					<button style={miniBtn} onClick={() => { if (selectedId) { commit(removeSceneObject(doc, selectedId)); setSelectedId(null); } }}>🗑</button>
				)}
			</div>
			<canvas
				ref={canvasRef}
				width={VIEW}
				height={VIEW}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				style={{ width: '100%', borderRadius: 8, touchAction: 'none', cursor: 'grab', background: '#17181c', display: 'block' }}
			/>
			{selected && (
				<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>名称</span>
						<input value={selected.name} onChange={e => patchSelected({ name: e.target.value })} style={{ ...inputStyle }} />
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>颜色</span>
						<input type="color" value={selected.color} onChange={e => patchSelected({ color: e.target.value })}
							style={{ width: '100%', height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }} />
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>尺寸 {selected.size.toFixed(2)}</span>
						<input type="range" min={0.05} max={1} step={0.01} value={selected.size} onChange={e => patchSelected({ size: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
						<span style={{ fontSize: 10, color: '#aaa' }}>高度 {selected.height.toFixed(2)}</span>
						<input type="range" min={0.05} max={1} step={0.01} value={selected.height} onChange={e => patchSelected({ height: Number(e.target.value) })} style={{ accentColor: '#4a9eff' }} />
					</label>
				</div>
			)}
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				等距摆场（拖拽对象移动）；调整后约 1.2 秒自动拍摄上传。
			</div>
		</div>
	);
}

const miniBtn: React.CSSProperties = {
	padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
	background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
	border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
};
