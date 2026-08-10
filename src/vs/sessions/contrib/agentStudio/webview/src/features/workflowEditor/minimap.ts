/*---------------------------------------------------------------------------------------------
 *  minimap — ComfyUI-style minimap layout math (pure, DOM-free).
 *
 *  The minimap is a small canvas in the bottom-right corner. It projects the
 *  workflow's graph space (nodes + current viewport) onto a fixed-size box:
 *
 *    - nodes  → colored rects (collapsed nodes are skipped)
 *    - viewport (what's currently visible on the main canvas) → a white frame
 *
 *  Clicking / dragging the minimap pans the main canvas. All projection math
 *  lives here as pure functions so the e2e tests can verify it.
 *--------------------------------------------------------------------------------------------*/

export interface MinimapNodeLike {
	id: string;
	pos: [number, number];
	size: [number, number];
	color?: string;
	collapsed?: boolean;
}

export interface MinimapViewport {
	/** DragAndScale.offset (graph space) */
	offsetX: number;
	offsetY: number;
	scale: number;
	/** main canvas CSS size (px) */
	canvasW: number;
	canvasH: number;
}

export interface MinimapRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MinimapNodeRect extends MinimapRect {
	color: string;
}

export interface MinimapScene {
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
	nodeRects: MinimapNodeRect[];
	viewportRect: MinimapRect;
	empty: boolean;
}

/** Graph-space bounding box of all (non-collapsed) nodes. Pure. */
export function computeGraphBounds(
	nodes: MinimapNodeLike[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
	if (nodes.length === 0) { return null; }
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const n of nodes) {
		if (n.collapsed) { continue; }
		minX = Math.min(minX, n.pos[0]);
		minY = Math.min(minY, n.pos[1]);
		maxX = Math.max(maxX, n.pos[0] + (n.size[0] ?? 1));
		maxY = Math.max(maxY, n.pos[1] + (n.size[1] ?? 1));
	}
	if (!isFinite(minX)) { return null; }
	return { minX, minY, maxX, maxY };
}

/**
 * Build the minimap scene: node rects (graph space → minimap px) + the viewport
 * frame. Graph bounds are letterboxed into `mmW × mmH` with `padding`. Pure.
 */
export function buildMinimapScene(
	nodes: MinimapNodeLike[],
	viewport: MinimapViewport,
	mmW: number,
	mmH: number,
	padding = 6,
): MinimapScene {
	const bounds = computeGraphBounds(nodes);
	if (!bounds) {
		return { bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, nodeRects: [], viewportRect: { x: 0, y: 0, w: 0, h: 0 }, empty: true };
	}
	const contentW = Math.max(1, mmW - 2 * padding);
	const contentH = Math.max(1, mmH - 2 * padding);
	const spanX = Math.max(1, bounds.maxX - bounds.minX);
	const spanY = Math.max(1, bounds.maxY - bounds.minY);
	const px = (gx: number) => padding + ((gx - bounds.minX) / spanX) * contentW;
	const py = (gy: number) => padding + ((gy - bounds.minY) / spanY) * contentH;

	const nodeRects: MinimapNodeRect[] = [];
	for (const n of nodes) {
		if (n.collapsed) { continue; }
		nodeRects.push({
			x: px(n.pos[0]),
			y: py(n.pos[1]),
			w: Math.max(2, (n.size[0] / spanX) * contentW),
			h: Math.max(2, (n.size[1] / spanY) * contentH),
			color: n.color ?? '#3b82f6',
		});
	}

	// viewport (graph space): the visible region on the main canvas
	const vpLeft = -viewport.offsetX;
	const vpTop = -viewport.offsetY;
	const vpW = viewport.scale > 0 ? viewport.canvasW / viewport.scale : 0;
	const vpH = viewport.scale > 0 ? viewport.canvasH / viewport.scale : 0;
	const viewportRect: MinimapRect = {
		x: px(vpLeft),
		y: py(vpTop),
		w: Math.max(1, (vpW / spanX) * contentW),
		h: Math.max(1, (vpH / spanY) * contentH),
	};
	return { bounds, nodeRects, viewportRect, empty: false };
}

/**
 * Convert a minimap pixel to graph-space coordinates (for click-to-jump).
 * Pure.
 */
export function minimapToGraph(
	x: number,
	y: number,
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
	mmW: number,
	mmH: number,
	padding = 6,
): [number, number] {
	const contentW = Math.max(1, mmW - 2 * padding);
	const contentH = Math.max(1, mmH - 2 * padding);
	const spanX = Math.max(1, bounds.maxX - bounds.minX);
	const spanY = Math.max(1, bounds.maxY - bounds.minY);
	return [
		bounds.minX + ((x - padding) / contentW) * spanX,
		bounds.minY + ((y - padding) / contentH) * spanY,
	];
}

/**
 * Pan the main canvas so the minimap cursor point stays put: a +Δg movement in
 * graph space moves the viewport by −Δg (screen = (graph + offset) × scale).
 * Pure.
 */
export function applyMinimapPan(
	offset: [number, number],
	startGraph: [number, number],
	currentGraph: [number, number],
): [number, number] {
	return [
		offset[0] - (currentGraph[0] - startGraph[0]),
		offset[1] - (currentGraph[1] - startGraph[1]),
	];
}

/**
 * Paint a minimap scene onto a canvas context (fake-able in tests: only uses
 * fillStyle / fillRect / strokeRect / lineWidth / strokeStyle).
 */
export function renderMinimap(
	ctx: {
		fillStyle?: string;
		strokeStyle?: string;
		lineWidth?: number;
		fillRect(x: number, y: number, w: number, h: number): void;
		strokeRect(x: number, y: number, w: number, h: number): void;
	},
	mmW: number,
	mmH: number,
	scene: MinimapScene,
): void {
	ctx.fillStyle = '#141419';
	ctx.fillRect(0, 0, mmW, mmH);
	if (scene.empty) { return; }
	for (const r of scene.nodeRects) {
		ctx.fillStyle = r.color;
		ctx.fillRect(r.x, r.y, r.w, r.h);
	}
	// viewport frame: translucent fill + bright border
	ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
	ctx.fillRect(scene.viewportRect.x, scene.viewportRect.y, scene.viewportRect.w, scene.viewportRect.h);
	ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
	ctx.lineWidth = 1;
	ctx.strokeRect(scene.viewportRect.x, scene.viewportRect.y, scene.viewportRect.w, scene.viewportRect.h);
}
