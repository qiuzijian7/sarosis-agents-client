/*---------------------------------------------------------------------------------------------
 *  PosterEditor — embedded poster layout editor for the ComfyTV Poster stage
 *  (P3). Renders template elements (title/subtitle text, image cells) onto a
 *  2D canvas at the node's native 1240×1754 size, lets the user drag elements
 *  and edit properties, and debounce-uploads the composed PNG. The `layout`
 *  overrides blob is stored verbatim in ComfyTV's format (portable).
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import type { ComfyRunnerRegistry } from './comfyHost/comfyRunner';
import {
	defaultPosterElements, applyPosterLayout, parsePosterLayout, renderPoster, hitTestPosterElement,
	type PosterElement,
} from './comfyHost/posterEditor';

export interface PosterEditorProps {
	initialLayout: string;
	images: Array<{ ref: string }>;
	runners: ComfyRunnerRegistry;
	preference: string;
	onLayoutChange: (layoutJson: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

const CANVAS_W = 1240;
const CANVAS_H = 1754;
const VIEW_W = 360;
const VIEW_H = Math.round((VIEW_W * CANVAS_H) / CANVAS_W);
const UPLOAD_DEBOUNCE_MS = 1200;

const inputStyle: React.CSSProperties = {
	background: '#111', color: '#e6e6e6', border: '1px solid rgba(255,255,255,.14)',
	borderRadius: 5, padding: '4px 7px', fontSize: 12, outline: 'none',
};
const chipStyle: React.CSSProperties = {
	padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10,
	background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
	border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
};

export function PosterEditor({ initialLayout, images, runners, preference, onLayoutChange, onRenderUploaded }: PosterEditorProps): React.JSX.Element {
	const init = React.useMemo(() => parsePosterLayout(initialLayout), [initialLayout]);
	const [elements, setElements] = React.useState<PosterElement[]>(() => applyPosterLayout(defaultPosterElements(), init));
	const [layout, setLayout] = React.useState<typeof init>(init);
	const [selected, setSelected] = React.useState<string | null>('title');
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const dragRef = React.useRef<{ id: string; ox: number; oy: number } | null>(null);
	const uploadTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const runnersRef = React.useRef(runners); runnersRef.current = runners;
	const preferenceRef = React.useRef(preference); preferenceRef.current = preference;

	const slotImages = React.useMemo(() => {
		const out: Array<HTMLImageElement | undefined> = [];
		for (const img of images) {
			const el = new Image();
			el.src = img.ref;
			out.push(el);
		}
		return out;
	}, [images]);

	const selectedEl = elements.find(e => e.id === selected) ?? null;

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
			form.append('image', blob, 'poster.png');
			const resp = await runner.fetchApi('/upload/image', { method: 'POST', body: form });
			const data = await resp.json();
			const url = `${runner.baseUrl}/view?filename=${encodeURIComponent(String(data?.name ?? ''))}&subfolder=${encodeURIComponent(String(data?.subfolder ?? ''))}&type=${String(data?.type ?? 'output')}`;
			onRenderUploaded(url);
		} catch {
			onRenderUploaded(null);
		}
	}, [onRenderUploaded]);

	React.useEffect(() => () => { if (uploadTimerRef.current) { clearTimeout(uploadTimerRef.current); } }, []);

	const commit = React.useCallback((nextLayout: typeof layout) => {
		setLayout(nextLayout);
		setElements(applyPosterLayout(defaultPosterElements(), nextLayout));
		onLayoutChange(JSON.stringify(nextLayout));
		scheduleUpload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onLayoutChange]);

	// ── draw ───────────────────────────────────────────────────────────────
	React.useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.imageSmoothingEnabled = true;
		const scale = VIEW_W / CANVAS_W;
		ctx.scale(scale, scale);
		renderPoster(ctx, elements, slotImages, CANVAS_W, CANVAS_H, '#101014');
		if (selected) {
			const el = elements.find(e => e.id === selected);
			if (el) {
				ctx.strokeStyle = '#3b82f6';
				ctx.lineWidth = 3 / scale;
				ctx.strokeRect(el.x * CANVAS_W, el.y * CANVAS_H, el.w * CANVAS_W, el.h * CANVAS_H);
			}
		}
	}, [elements, selected, slotImages]);

	// ── pointer (drag to move) ─────────────────────────────────────────────
	const localN = (e: React.PointerEvent<HTMLCanvasElement>): { nx: number; ny: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { nx: (e.clientX - rect.left) / rect.width, ny: (e.clientY - rect.top) / rect.height };
	};

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { nx, ny } = localN(e);
		const idx = hitTestPosterElement(elements, nx, ny);
		if (idx >= 0) {
			const el = elements[idx];
			setSelected(el.id);
			dragRef.current = { id: el.id, ox: nx - el.x, oy: ny - el.y };
		} else {
			dragRef.current = null;
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (!dragRef.current) { return; }
		const { nx, ny } = localN(e);
		const next = { ...layout };
		const ov = { ...(next[dragRef.current.id] ?? {}) };
		ov.x = Math.max(0, Math.min(1 - 0.05, nx - dragRef.current.ox));
		ov.y = Math.max(0, Math.min(1 - 0.05, ny - dragRef.current.oy));
		next[dragRef.current.id] = ov;
		commit(next);
	};

	const onPointerUp = () => { dragRef.current = null; };

	// ── controls ───────────────────────────────────────────────────────────
	const patchSelected = (patch: Partial<PosterElement>) => {
		if (!selected) { return; }
		const next = { ...layout };
		next[selected] = { ...(next[selected] ?? {}), ...patch };
		commit(next);
	};

	const addElement = (type: 'text' | 'rect') => {
		const id = `${type}_${Date.now().toString(36).slice(-4)}`;
		const def: PosterElement = type === 'text'
			? { id, type: 'text', label: '新文本', x: 0.1, y: 0.4, w: 0.6, h: 0.08, font: 'body', font_size: 36, align: 'left', color: '#ffffff', text: 'Double-click to edit' }
			: { id, type: 'rect', label: '色块', x: 0.1, y: 0.5, w: 0.4, h: 0.2, fill: 'rgba(255,255,255,.14)' };
		const next = { ...layout, [id]: def };
		setSelected(id);
		commit(next);
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
				style={{ width: '100%', borderRadius: 8, touchAction: 'none', cursor: 'grab', background: '#101014', display: 'block' }}
			/>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
				<button style={chipStyle} onClick={() => addElement('text')}>+ 文本</button>
				<button style={chipStyle} onClick={() => addElement('rect')}>+ 色块</button>
			</div>
			{selectedEl && (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
					<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
						{selectedEl.label} · {selectedEl.type}（拖拽移动）
					</div>
					{selectedEl.type === 'text' && (
						<>
							<input
								value={selectedEl.text ?? selectedEl.label}
								onChange={e => patchSelected({ text: e.target.value })}
								placeholder={selectedEl.label}
								style={{ ...inputStyle }}
							/>
							<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
								<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
									<span style={{ fontSize: 10, color: '#aaa' }}>字号</span>
									<input type="number" min={8} max={200} value={selectedEl.font_size ?? 24}
										onChange={e => patchSelected({ font_size: Number(e.target.value) })} style={{ ...inputStyle }} />
								</label>
								<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
									<span style={{ fontSize: 10, color: '#aaa' }}>对齐</span>
									<select value={selectedEl.align ?? 'left'} onChange={e => patchSelected({ align: e.target.value as 'left' | 'center' | 'right' })}
										style={{ ...inputStyle }}>
										<option value="left">左</option>
										<option value="center">中</option>
										<option value="right">右</option>
									</select>
								</label>
								<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
									<span style={{ fontSize: 10, color: '#aaa' }}>颜色</span>
									<input type="color" value={/^#[0-9a-fA-F]{6}$/.test(selectedEl.color ?? '') ? selectedEl.color : '#ffffff'}
										onChange={e => patchSelected({ color: e.target.value })} style={{ width: '100%', height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }} />
								</label>
							</div>
						</>
					)}
					{selectedEl.type === 'rect' && (
						<label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
							<span style={{ fontSize: 10, color: '#aaa' }}>填充色</span>
							<input type="color" value={/^#[0-9a-fA-F]{6}$/.test(selectedEl.fill ?? '') ? selectedEl.fill : '#ffffff'}
								onChange={e => patchSelected({ fill: e.target.value })} style={{ width: 40, height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }} />
						</label>
					)}
					{selectedEl.type === 'image' && (
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
							<span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', width: '100%' }}>选择图片（来自上游）</span>
							{images.map((img, i) => (
								<button
									key={i}
									onClick={() => patchSelected({ slot: i })}
									style={{
										padding: 2, borderRadius: 4, cursor: 'pointer', border: (selectedEl.slot ?? 0) === i ? '2px solid #3b82f6' : '1px solid rgba(255,255,255,.2)',
										background: '#000',
									}}
								>
									<img src={img.ref} alt="" style={{ width: 44, height: 60, objectFit: 'cover', borderRadius: 2, display: 'block' }} />
								</button>
							))}
							{images.length === 0 && <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>无上游图片：请先连接图像生成节点</span>}
						</div>
					)}
				</div>
			)}
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				排版后约 1.2 秒自动渲染上传；无 Run 按钮。
			</div>
		</div>
	);
}
