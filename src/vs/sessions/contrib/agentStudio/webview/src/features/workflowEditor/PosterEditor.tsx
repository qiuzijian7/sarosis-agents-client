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
	defaultPosterElements, applyPosterLayout, parsePosterLayout, renderPoster,
	newElementDef, nextElementId, type PosterElement,
	hitTestPosterHandle, applyPosterDrag, posterHandlePosN, posterAngleTo,
	normalizePosterRot, cursorForPoster, handlePtsN, HANDLE, type PosterDragMode,
	parsePosterGuides, posterGridOn, posterGuideHitIndex, type PosterGuide,
	posterImageProps, applyImgDrag, applyImgScale, SIZE_PRESETS, sizePresetFor,
} from './comfyHost/posterEditor';
import {
	arrange, buildSnapTargets, applySnap,
	type ArrangeOp, type SnapGuide,
} from './comfyHost/posterArrange';

export interface PosterEditorProps {
	initialLayout: string;
	images: Array<{ ref: string }>;
	runners: ComfyRunnerRegistry;
	preference: string;
	width: number;
	height: number;
	onSizeChange: (w: number, h: number) => void;
	onLayoutChange: (layoutJson: string) => void;
	onRenderUploaded: (url: string | null) => void;
}

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

export function PosterEditor({ initialLayout, images, runners, preference, width, height, onSizeChange, onLayoutChange, onRenderUploaded }: PosterEditorProps): React.JSX.Element {
	const canvasW = Math.max(64, width | 0);
	const canvasH = Math.max(64, height | 0);
	const viewW = 360;
	const viewH = Math.round((viewW * canvasH) / canvasW);
	const init = React.useMemo(() => parsePosterLayout(initialLayout), [initialLayout]);
	const [elements, setElements] = React.useState<PosterElement[]>(() => applyPosterLayout(defaultPosterElements(), init));
	const [layout, setLayout] = React.useState<typeof init>(init);
	const [selectedIds, setSelectedIds] = React.useState<string[]>(['title']);
	const [imgEditId, setImgEditId] = React.useState<string | null>(null);
	const [marquee, setMarquee] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	const [snapGuides, setSnapGuides] = React.useState<SnapGuide[]>([]);
	const canvasRef = React.useRef<HTMLCanvasElement>(null);
	const dragRef = React.useRef<{ id: string; mode: PosterDragMode; startN: { nx: number; ny: number }; start: { x: number; y: number; w: number; h: number }; groupBases: Array<{ id: string; x: number; y: number; w: number; h: number }> | null } | null>(null);
	const rotDragRef = React.useRef<{ id: string; baseDeg: number; grab: number } | null>(null);
	const guideDragRef = React.useRef<number | null>(null);
	const imgDragRef = React.useRef<{ id: string; startN: { nx: number; ny: number }; start: { scale: number; x: number; y: number } } | null>(null);
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

	const selected = selectedIds.length === 1 ? selectedIds[0] : null;
	const single = selectedIds.length === 1;
	const selectedEl = selected ? elements.find(e => e.id === selected) ?? null : null;
	const guides = React.useMemo<PosterGuide[]>(() => parsePosterGuides(layout), [layout]);
	const gridOn = React.useMemo(() => posterGridOn(layout), [layout]);
	const selectOnly = (id: string) => setSelectedIds([id]);
	const toggleSelect = (id: string) =>
		setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

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
		const scale = viewW / canvasW;
		ctx.scale(scale, scale);
		renderPoster(ctx, elements, slotImages, canvasW, canvasH, '#101014');
		// 网格（12 等分，元素之下）
		if (gridOn) {
			ctx.strokeStyle = 'rgba(120,140,160,0.18)';
			ctx.lineWidth = 1 / scale;
			for (let i = 1; i < 12; i++) {
				const X = (canvasW * i) / 12;
				const Y = (canvasH * i) / 12;
				ctx.beginPath(); ctx.moveTo(X, 0); ctx.lineTo(X, canvasH); ctx.stroke();
				ctx.beginPath(); ctx.moveTo(0, Y); ctx.lineTo(canvasW, Y); ctx.stroke();
			}
		}
		// 多选描边（无手柄）
		if (selectedIds.length > 1) {
			ctx.strokeStyle = '#46b4e6';
			ctx.lineWidth = 1.5 / scale;
			for (const id of selectedIds) {
				const el = elements.find(e => e.id === id);
				if (!el) { continue; }
				ctx.strokeRect((el.x ?? 0) * canvasW, (el.y ?? 0) * canvasH, (el.w ?? 0) * canvasW, (el.h ?? 0) * canvasH);
			}
		}
		if (selected) {
			const el = elements.find(e => e.id === selected);
			if (el) {
				const sx = (el.x ?? 0) * canvasW;
				const sy = (el.y ?? 0) * canvasH;
				const sw = (el.w ?? 0) * canvasW;
				const sh = (el.h ?? 0) * canvasH;
				const rot = el.rot ?? 0;
				const imgEdit = imgEditId !== null && imgEditId === selected;
				const accent = imgEdit ? '#3fd6a0' : '#46b4e6';
				ctx.save();
				if (rot) {
					ctx.translate(sx + sw / 2, sy + sh / 2);
					ctx.rotate((rot * Math.PI) / 180);
					ctx.translate(-(sx + sw / 2), -(sy + sh / 2));
				}
				ctx.strokeStyle = accent;
				ctx.lineWidth = 2 / scale;
				ctx.strokeRect(sx, sy, sw, sh);
				if (!rot && !imgEdit) {
					const hs = 8 / scale;
					ctx.fillStyle = accent;
					for (const [nx2, ny2] of handlePtsN({ x: sx / canvasW, y: sy / canvasH, w: sw / canvasW, h: sh / canvasH })) {
						ctx.fillRect(nx2 * canvasW - hs / 2, ny2 * canvasH - hs / 2, hs, hs);
					}
				}
				ctx.restore();
				// 旋转手柄（随 rot 旋转；图像内编辑模式下不绘制）
				if (!imgEdit) {
					const nP = posterHandlePosN(el, 'n');
					const rP = posterHandlePosN(el, 'rotate');
					ctx.strokeStyle = accent;
					ctx.lineWidth = 1 / scale;
					ctx.beginPath();
					ctx.moveTo(nP.x * canvasW, nP.y * canvasH);
					ctx.lineTo(rP.x * canvasW, rP.y * canvasH);
					ctx.stroke();
					ctx.beginPath();
					ctx.arc(rP.x * canvasW, rP.y * canvasH, 4 / scale, 0, Math.PI * 2);
					ctx.fill();
				}
			}
		}
		// 参考线（虚线，最上层）
		if (guides.length) {
			ctx.setLineDash([5, 4]);
			ctx.strokeStyle = '#22d3ee';
			ctx.lineWidth = 1 / scale;
			for (const g of guides) {
				ctx.beginPath();
				if (g.axis === 'x') {
					const X = g.pos * canvasW;
					ctx.moveTo(X, 0); ctx.lineTo(X, canvasH);
				} else {
					const Y = g.pos * canvasH;
					ctx.moveTo(0, Y); ctx.lineTo(canvasW, Y);
				}
				ctx.stroke();
			}
			ctx.setLineDash([]);
		}
		// 吸附参考线（红色，最上层）
		if (snapGuides.length) {
			ctx.strokeStyle = '#ff5a6a';
			ctx.lineWidth = 1 / scale;
			for (const g of snapGuides) {
				ctx.beginPath();
				if (g.axis === 'x') {
					const X = g.pos * canvasW;
					ctx.moveTo(X, 0); ctx.lineTo(X, canvasH);
				} else {
					const Y = g.pos * canvasH;
					ctx.moveTo(0, Y); ctx.lineTo(canvasW, Y);
				}
				ctx.stroke();
			}
		}
		// marquee 框选
		if (marquee) {
			const x0 = Math.min(marquee.x0, marquee.x1) * canvasW;
			const y0 = Math.min(marquee.y0, marquee.y1) * canvasH;
			const w = Math.abs(marquee.x1 - marquee.x0) * canvasW;
			const h = Math.abs(marquee.y1 - marquee.y0) * canvasH;
			ctx.fillStyle = 'rgba(59,130,246,0.12)';
			ctx.strokeStyle = '#3b82f6';
			ctx.lineWidth = 1 / scale;
			ctx.fillRect(x0, y0, w, h);
			ctx.strokeRect(x0, y0, w, h);
		}
	}, [elements, selected, selectedIds, slotImages, guides, gridOn, imgEditId, snapGuides, marquee, canvasW, canvasH, viewW, viewH]);

	// ── pointer (move / 8 向 resize / 旋转) ────────────────────────────────
	const localN = (e: React.PointerEvent<HTMLCanvasElement>): { nx: number; ny: number } => {
		const rect = e.currentTarget.getBoundingClientRect();
		return { nx: (e.clientX - rect.left) / rect.width, ny: (e.clientY - rect.top) / rect.height };
	};

	const activeIdxOf = (): number => elements.findIndex(el => el.id === selected);

	/** 吸附目标：边界 + 其他元素边缘/中点 + 网格 + 参考线。 */
	const snapTargetsFor = (excludeIds: string[]) => buildSnapTargets(
		elements.filter(e => !excludeIds.includes(e.id)).map(e => ({ x: e.x ?? 0, y: e.y ?? 0, w: e.w ?? 0, h: e.h ?? 0 })),
		{ w: 1, h: 1 },
		{
			gridX: gridOn ? 1 / 12 : undefined,
			guideXs: guides.filter(g => g.axis === 'x').map(g => g.pos),
			guideYs: guides.filter(g => g.axis === 'y').map(g => g.pos),
		},
	);

	const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { nx, ny } = localN(e);
		// 0. 图像内编辑拖拽（最高优先级：imgEdit 模式下点图片框 → 平移图片）
		if (imgEditId) {
			const editEl = elements.find(el => el.id === imgEditId);
			if (editEl) {
				const ex = editEl.x ?? 0; const ey = editEl.y ?? 0;
				const ew = editEl.w ?? 0; const eh = editEl.h ?? 0;
				if (nx >= ex && nx <= ex + ew && ny >= ey && ny <= ey + eh) {
					e.preventDefault();
					e.currentTarget.setPointerCapture(e.pointerId);
					selectOnly(editEl.id);
					imgDragRef.current = { id: editEl.id, startN: { nx, ny }, start: posterImageProps(editEl) };
					return;
				}
			}
		}
		const activeIdx = activeIdxOf();
		// 1. 旋转手柄（仅单选中元素）
		if (activeIdx >= 0) {
			const el = elements[activeIdx];
			const rp = posterHandlePosN(el, 'rotate');
			if (Math.hypot(nx - rp.x, ny - rp.y) <= HANDLE * 1.5) {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				const cx = (el.x ?? 0) + (el.w ?? 0) / 2;
				const cy = (el.y ?? 0) + (el.h ?? 0) / 2;
				rotDragRef.current = { id: el.id, baseDeg: el.rot ?? 0, grab: posterAngleTo(cx, cy, nx, ny) };
				return;
			}
		}
		// 2. resize / move
		const hit = hitTestPosterHandle(elements, nx, ny, activeIdx);
		if (!hit) {
			dragRef.current = null;
			// 3. 参考线命中（空白处，非 shift）
			const gi = posterGuideHitIndex(guides, nx, ny);
			if (gi >= 0 && !e.shiftKey) {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				guideDragRef.current = gi;
				return;
			}
			// 4. marquee 框选（空白处，非 shift；shift 保留给 additive 场景）
			if (!e.shiftKey) {
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				setMarquee({ x0: nx, y0: ny, x1: nx, y1: ny });
				setSelectedIds([]);
			}
			return;
		}
		const el = elements[hit.idx];
		e.currentTarget.setPointerCapture(e.pointerId);
		// shift 点击切换选择，不进入拖拽
		if (e.shiftKey) {
			toggleSelect(el.id);
			return;
		}
		if (!selectedIds.includes(el.id)) { selectOnly(el.id); }
		// move 时若当前已是多选，记录整组起始矩形做 group move
		const groupBases = hit.mode === 'move' && selectedIds.length > 1
			? selectedIds.map(id => {
				const e2 = elements.find(x => x.id === id);
				return { id, x: e2?.x ?? 0, y: e2?.y ?? 0, w: e2?.w ?? 0, h: e2?.h ?? 0 };
			})
			: null;
		dragRef.current = {
			id: el.id,
			mode: hit.mode,
			startN: { nx, ny },
			start: { x: el.x ?? 0, y: el.y ?? 0, w: el.w ?? 0, h: el.h ?? 0 },
			groupBases,
		};
	};

	const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
		const { nx, ny } = localN(e);
		if (rotDragRef.current) {
			const d = rotDragRef.current;
			const el = elements.find(x => x.id === d.id);
			if (!el) { return; }
			const cx = (el.x ?? 0) + (el.w ?? 0) / 2;
			const cy = (el.y ?? 0) + (el.h ?? 0) / 2;
			let deg = d.baseDeg + (posterAngleTo(cx, cy, nx, ny) - d.grab) * 180 / Math.PI;
			if (e.shiftKey) { deg = Math.round(deg / 15) * 15; }
			deg = normalizePosterRot(deg);
			const next = { ...layout };
			const ov = { ...(next[d.id] ?? {}) } as Record<string, unknown>;
			ov.rot = Math.round(deg * 10) / 10;
			next[d.id] = ov;
			commit(next);
			return;
		}
		if (imgDragRef.current) {
			const d = imgDragRef.current;
			const el = elements.find(x => x.id === d.id);
			if (!el) { return; }
			const w = el.w ?? 0.01;
			const h = el.h ?? 0.01;
			const r = applyImgDrag(d.start, (nx - d.startN.nx) / w, (ny - d.startN.ny) / h);
			const next = { ...layout };
			const ov = { ...(next[d.id] ?? {}) } as Record<string, unknown>;
			ov.img_x = r.x; ov.img_y = r.y;
			next[d.id] = ov;
			commit(next);
			return;
		}
		if (dragRef.current) {
			const d = dragRef.current;
			const dx = nx - d.startN.nx;
			const dy = ny - d.startN.ny;
			const next = { ...layout };
			// group move：整组平移 + 吸附
			if (d.groupBases && d.groupBases.length > 1) {
				const base = d.groupBases.find(b => b.id === d.id) ?? d.groupBases[0]!;
				const raw = { x: base.x + dx, y: base.y + dy, w: base.w, h: base.h };
				const snap = applySnap('move', raw, snapTargetsFor(selectedIds), { thrX: 0.015, thrY: 0.015, minWH: 0.02 });
				const sdx = snap.rect.x - base.x;
				const sdy = snap.rect.y - base.y;
				setSnapGuides(snap.guides);
				for (const b of d.groupBases) {
					const ov = { ...(next[b.id] ?? {}) } as Record<string, unknown>;
					ov.x = Math.max(0, Math.min(1 - b.w, b.x + sdx));
					ov.y = Math.max(0, Math.min(1 - b.h, b.y + sdy));
					next[b.id] = ov;
				}
				commit(next);
				return;
			}
			// 单 move / resize
			let rect = applyPosterDrag(d.mode, d.start, dx, dy);
			if (d.mode === 'move') {
				const snap = applySnap('move', rect, snapTargetsFor([d.id]), { thrX: 0.015, thrY: 0.015, minWH: 0.02 });
				rect = snap.rect;
				setSnapGuides(snap.guides);
			} else {
				setSnapGuides([]);
			}
			const ov = { ...(next[d.id] ?? {}) } as Record<string, unknown>;
			ov.x = rect.x; ov.y = rect.y; ov.w = rect.w; ov.h = rect.h;
			next[d.id] = ov;
			commit(next);
			return;
		}
		if (marquee) {
			setMarquee({ x0: marquee.x0, y0: marquee.y0, x1: nx, y1: ny });
			return;
		}
		if (guideDragRef.current !== null) {
			const idx = guideDragRef.current;
			const g = guides[idx];
			if (g) {
				const list = Array.isArray(layout.__guides__) ? (layout.__guides__ as PosterGuide[]).slice() : [];
				if (list[idx]) {
					list[idx] = { ...list[idx], pos: Math.max(0, Math.min(1, g.axis === 'x' ? nx : ny)) };
					setLayout({ ...layout, __guides__: list }); // 只重绘，松手再 commit
				}
			}
			return;
		}
		// hover 光标
		const activeIdx = activeIdxOf();
		if (activeIdx >= 0) {
			const rp = posterHandlePosN(elements[activeIdx], 'rotate');
			if (Math.hypot(nx - rp.x, ny - rp.y) <= HANDLE * 1.5) {
				e.currentTarget.style.cursor = 'grab';
				return;
			}
		}
		const hit = hitTestPosterHandle(elements, nx, ny, activeIdx);
		e.currentTarget.style.cursor = cursorForPoster(hit ? hit.mode : null);
	};

	const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
		}
		if (guideDragRef.current !== null) {
			const idx = guideDragRef.current;
			guideDragRef.current = null;
			const { nx, ny } = localN(e);
			// 拖出画布（>2% 容差）→ 删除参考线
			if (nx < -0.02 || ny < -0.02 || nx > 1.02 || ny > 1.02) {
				const list = Array.isArray(layout.__guides__) ? (layout.__guides__ as PosterGuide[]).slice() : [];
				if (list[idx]) {
					list.splice(idx, 1);
					commit({ ...layout, __guides__: list });
				}
			} else {
				commit(layout);
			}
			return;
		}
		if (marquee) {
			const x0 = Math.min(marquee.x0, marquee.x1);
			const y0 = Math.min(marquee.y0, marquee.y1);
			const x1 = Math.max(marquee.x0, marquee.x1);
			const y1 = Math.max(marquee.y0, marquee.y1);
			const hits = elements.filter(el => {
				const ex = el.x ?? 0; const ey = el.y ?? 0;
				const ew = el.w ?? 0; const eh = el.h ?? 0;
				return ex + ew > x0 && ex < x1 && ey + eh > y0 && ey < y1;
			}).map(el => el.id);
			setMarquee(null);
			setSnapGuides([]);
			if (hits.length) { setSelectedIds(hits); }
			return;
		}
		dragRef.current = null;
		rotDragRef.current = null;
		imgDragRef.current = null;
		setSnapGuides([]);
	};

	// ── controls ───────────────────────────────────────────────────────────
	const patchSelected = (patch: Partial<PosterElement>) => {
		if (!selected) { return; }
		const next = { ...layout };
		next[selected] = { ...(next[selected] ?? {}), ...patch };
		commit(next);
	};

	const addElement = (type: 'text' | 'shape' | 'image') => {
		const id = nextElementId();
		const def = newElementDef(type, id);
		// 加入 __added__（对齐 ComfyTV addElement：新元素进 __added__ 数组）
		const added = Array.isArray(layout.__added__) ? (layout.__added__ as PosterElement[]) : [];
		const next = { ...layout, __added__: [...added, def] };
		selectOnly(id);
		commit(next);
	};

	/** 对多选元素应用 arrange（对齐/分布）。 */
	const applyArrange = (op: ArrangeOp) => {
		if (selectedIds.length < 2) { return; }
		const rects = selectedIds.map(id => {
			const e = elements.find(x => x.id === id);
			return { x: e?.x ?? 0, y: e?.y ?? 0, w: e?.w ?? 0, h: e?.h ?? 0 };
		});
		const deltas = arrange(rects, op);
		const next = { ...layout };
		selectedIds.forEach((id, i) => {
			const d = deltas[i];
			if (!d) { return; }
			const e = elements.find(x => x.id === id);
			if (!e) { return; }
			const ov = { ...(next[id] ?? {}) } as Record<string, unknown>;
			ov.x = Math.max(0, Math.min(1 - (e.w ?? 0), (e.x ?? 0) + d.dx));
			ov.y = Math.max(0, Math.min(1 - (e.h ?? 0), (e.y ?? 0) + d.dy));
			next[id] = ov;
		});
		commit(next);
	};

	const toggleGrid = () => {
		commit({ ...layout, __grid__: !gridOn });
	};

	const addGuide = (axis: 'x' | 'y') => {
		const list = Array.isArray(layout.__guides__) ? (layout.__guides__ as PosterGuide[]).slice() : [];
		commit({ ...layout, __guides__: [...list, { axis, pos: 0.5 }] });
	};

	const onSizePreset = (label: string) => {
		const p = SIZE_PRESETS.find(x => x.label === label);
		if (p) { onSizeChange(p.w, p.h); }
	};

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
			<canvas
				ref={canvasRef}
				width={viewW}
				height={viewH}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				style={{ width: '100%', borderRadius: 8, touchAction: 'none', cursor: 'default', background: '#101014', display: 'block' }}
			/>
			<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
				<span style={{ fontSize: 10, color: '#aaa', flexShrink: 0 }}>尺寸</span>
				<select
					value={sizePresetFor(canvasW, canvasH) ?? `__custom__`}
					onChange={e => onSizePreset(e.target.value)}
					style={{ ...inputStyle, flex: 1, minWidth: 0 }}
				>
					{SIZE_PRESETS.map(p => (
						<option key={p.label} value={p.label}>{p.label}</option>
					))}
					{!sizePresetFor(canvasW, canvasH) && (
						<option value="__custom__">自定义 {canvasW}×{canvasH}</option>
					)}
				</select>
			</div>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
				<button style={chipStyle} onClick={() => addElement('text')}>+ 文本</button>
				<button style={chipStyle} onClick={() => addElement('shape')}>+ 图形</button>
				<button style={chipStyle} onClick={() => addElement('image')}>+ 图片</button>
				<button style={{ ...chipStyle, borderColor: gridOn ? '#3b82f6' : undefined }} onClick={toggleGrid} title="网格">⌗</button>
				<button style={chipStyle} onClick={() => addGuide('x')} title="加竖参考线">┊+</button>
				<button style={chipStyle} onClick={() => addGuide('y')} title="加横参考线">┄+</button>
			</div>
			{selectedIds.length >= 2 && (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
					<span style={{ fontSize: 10, color: '#aaa', alignSelf: 'center', marginRight: 2 }}>对齐</span>
					{(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom', 'hspread', 'vspread', 'hgap', 'vgap'] as ArrangeOp[]).map(op => (
						<button key={op} style={chipStyle} onClick={() => applyArrange(op)} title={op}>{op}</button>
					))}
				</div>
			)}
			{selectedEl && (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
					<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
						{selectedEl.label} · {selectedEl.type}（拖拽移动 · 8 向缩放 · 旋转）
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
					{selectedEl.type === 'shape' && (
						<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
							<label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#aaa' }}>
								<span>形状</span>
								<select value={selectedEl.shape ?? 'rect'} onChange={e => patchSelected({ shape: e.target.value as 'rect' | 'ellipse' | 'line' })} style={{ ...inputStyle }}>
									<option value="rect">矩形</option>
									<option value="ellipse">椭圆</option>
									<option value="line">线段</option>
								</select>
							</label>
							<label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#aaa' }}>
								<span>填充色</span>
								<input type="color" value={/^#[0-9a-fA-F]{6}$/.test(selectedEl.fill ?? '') ? selectedEl.fill : '#ffffff'}
									onChange={e => patchSelected({ fill: e.target.value })} style={{ width: 40, height: 26, padding: 0, border: '1px solid rgba(255,255,255,.2)', borderRadius: 5, background: 'transparent', cursor: 'pointer' }} />
							</label>
						</div>
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
							<button
								style={{ ...chipStyle, width: '100%', borderColor: imgEditId === selected ? '#3fd6a0' : undefined, color: imgEditId === selected ? '#3fd6a0' : undefined }}
								onClick={() => setImgEditId(imgEditId === selected ? null : selected)}
								title="图像内编辑：拖拽平移 + 缩放"
							>✥ 图像调整{imgEditId === selected ? '（拖动图片平移）' : ''}</button>
							{imgEditId === selected && (
								<label style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontSize: 10, color: '#aaa' }}>
									<span style={{ flexShrink: 0 }}>缩放</span>
									<input
										type="range" min={1} max={4} step={0.02}
										value={posterImageProps(selectedEl).scale}
										onChange={e => {
											const s = Number(e.target.value);
											const p = applyImgScale(posterImageProps(selectedEl), s);
											patchSelected({ img_scale: p.scale, img_x: p.x, img_y: p.y });
										}}
										style={{ flex: 1 }}
									/>
									<span style={{ flexShrink: 0, width: 30, textAlign: 'right' }}>{posterImageProps(selectedEl).scale.toFixed(2)}×</span>
								</label>
							)}
						</div>
					)}
					<div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
						<label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
							<span style={{ fontSize: 10, color: '#aaa' }}>旋转（°）</span>
							<input type="number" value={selectedEl.rot ?? 0} step={1} min={-180} max={180}
								onChange={e => patchSelected({ rot: Number(e.target.value) || 0 })} style={{ ...inputStyle }} />
						</label>
						<button style={{ ...chipStyle, marginBottom: 1 }} onClick={() => patchSelected({ rot: 0 })}>重置</button>
					</div>
				</div>
			)}
			<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
				排版后约 1.2 秒自动渲染上传；无 Run 按钮。
			</div>
		</div>
	);
}
