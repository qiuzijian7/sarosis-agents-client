/*---------------------------------------------------------------------------------------------
 *  widgetBridge — mount React card DOM inside LiteGraph canvas nodes.
 *
 *  The installed @comfyorg/litegraph fork does not ship `addDOMWidget` (that is a
 *  ComfyUI-frontend patch). We implement an equivalent overlay bridge:
 *   - a single absolutely-positioned overlay layer on top of the LGraphCanvas <canvas>
 *   - one container per node, translated/scaled to match `node.pos` * canvas zoom
 *   - containers are hidden while not connected to a live node
 *
 *  Position math is pure and unit-testable (see `nodeToOverlayRect`).
 *  DOM access is injected (`doc`) so the host logic runs in node tests.
 *--------------------------------------------------------------------------------------------*/

/** Minimal document surface used by the bridge (injectable for tests). */
export interface MinimalDocument {
	createElement(tag: string): HTMLElement;
	querySelectorAll(selectors: string): NodeListOf<Element>;
}

/** Viewport state of the canvas we sync against. */
export interface CanvasViewport {
	x: number;   // graph-space offset (DragAndScale.offset)
	y: number;
	scale: number; // zoom factor
}

/** Default insets used by `sync` when an overlay node doesn't override them.
 *  - SIDE: 8px so LiteGraph's port dots (drawn at the node edge) stay visible
 *  - TOP:  22px so LiteGraph's own title bar (≈22px tall) is not painted over
 *  - BOTTOM: 8px so connection points / output labels stay visible */
const DEFAULT_SIDE_INSET = 8;
const DEFAULT_TOP_INSET = 22;
const DEFAULT_BOTTOM_INSET = 8;

/** One overlay node. `fullCover: true` (schema stages, which hide the canvas
 *  title bar) lets the card cover the whole node rect so the entire node is a
 *  single DOM layer and z-order follows draw order cleanly. */
export interface OverlayNode {
	id: string;
	node: { pos: [number, number]; size?: [number, number] };
	/** Cover the full node rect (title included). Use for nodes whose canvas
	 *  title bar is suppressed (`title_mode = NO_TITLE`). */
	fullCover?: boolean;
	/** Draw a selection ring around the card. Only honored with `fullCover`:
	 *  for those nodes the whole node visual IS the DOM card, so the ring must
	 *  live in the DOM layer too — LiteGraph's own canvas-drawn selection
	 *  stroke sits below the overlay and gets clipped by other nodes' cards,
	 *  which reads as a broken z-order (the ring "passes behind" a lower
	 *  node's panel while this card is on top). The container's z-index is
	 *  already boosted by the caller when selected, so the ring stays on top. */
	selected?: boolean;
	/** Execution state (`running`/`success`/`error`). Same layering argument
	 *  as `selected`: the canvas-drawn state border would be clipped by other
	 *  nodes' cards, so for fullCover nodes the colored ring is drawn here in
	 *  the DOM layer. State rings take priority over the selection ring. */
	state?: string;
}

/** Ring colors per overlay state (mirror drawNodeStateOverlay's palette). */
const STATE_RING_COLOR: Record<string, string> = {
	running: 'rgba(74,158,255,0.95)',
	success: 'rgba(46,204,113,0.95)',
	error: 'rgba(255,91,91,0.95)',
};
const SELECTED_RING_COLOR = 'rgba(255,255,255,0.9)';

/** Resolve the DOM ring color for an overlay node (null = no ring). */
export function overlayRingColor(fullCover: boolean | undefined, selected: boolean | undefined, state: string | undefined): string | null {
	if (!fullCover) { return null; }
	if (state && state in STATE_RING_COLOR) { return STATE_RING_COLOR[state]; }
	if (selected) { return SELECTED_RING_COLOR; }
	return null;
}

/**
 * Compute the overlay rectangle (in overlay-layer CSS px) for a LiteGraph node.
 * LiteGraph node.pos is in graph coordinates; the canvas draws at
 *   screen = (pos + offset) * scale
 * (see DragAndScale.toCanvasContext: scale() then translate(), and
 * convertOffsetToCanvas). Applying the offset AFTER the scale leaves the
 * cards drifting away from their nodes as soon as the view is panned/zoomed.
 */
export function nodeToOverlayRect(
	node: { pos: [number, number]; size?: [number, number] },
	viewport: CanvasViewport,
	defaultWidth = 220,
	defaultHeight = 150,
): { left: number; top: number; width: number; height: number } {
	const scale = viewport.scale;
	const width = node.size?.[0] ?? defaultWidth;
	const height = node.size?.[1] ?? defaultHeight;
	return {
		left: (node.pos[0] + viewport.x) * scale,
		top: (node.pos[1] + viewport.y) * scale,
		width: width * scale,
		height: height * scale,
	};
}

/**
 * Tiny bridge instance per overlay layer.
 * The caller (a React component) provides the mount callback that renders a card.
 */
export interface WidgetBridgeHost {
	readonly layer: HTMLElement;
	/** create or reuse a container for a node */
	ensureContainer(nodeId: string): HTMLElement;
	/** remove the container for a node (on node dispose) */
	releaseContainer(nodeId: string): void;
	/** reposition all active containers from a snapshot of nodes + viewport */
	sync(nodes: OverlayNode[], viewport: CanvasViewport): void;
}

export function createWidgetBridgeHost(layer: HTMLElement, doc: MinimalDocument = globalThis.document): WidgetBridgeHost {
	const containers = new Map<string, HTMLElement>();

	function ensureContainer(nodeId: string): HTMLElement {
		let el = containers.get(nodeId);
		if (!el) {
			el = doc.createElement('div');
			el.className = 'wf-comfy-widget';
			el.style.position = 'absolute';
			// Click-through: the container covers the node's whole rect, so
			// 'auto' would swallow every pointerdown/wheel/dblclick before it
			// reaches the LiteGraph canvas (nodes become un-draggable). Cards
			// are presentational; any future interactive child must opt back
			// in with its own pointerEvents:auto.
			el.style.pointerEvents = 'none';
			el.style.overflow = 'hidden';
			el.style.zIndex = '1';
			el.dataset.nodeId = nodeId;
			layer.appendChild(el);
			containers.set(nodeId, el);
		}
		return el;
	}

	return {
		layer,
		ensureContainer,
		releaseContainer(nodeId: string): void {
			const el = containers.get(nodeId);
			if (el) {
				el.remove();
				containers.delete(nodeId);
			}
		},
		sync(nodes, viewport): void {
			// Cards default to sitting just below LiteGraph's title bar (22px)
			// and inside the port dots (8px). Nodes that suppress the canvas
			// title bar (schema stages) pass fullCover → the card covers the
			// whole node rect so the entire node is one DOM layer.
			const SIDE_INSET = 8;
			const TOP_INSET = 22;
			const BOTTOM_INSET = 8;
			// hide any container whose node is not in this snapshot
			const seen = new Set<string>();
			for (const { id, node, fullCover, selected, state } of nodes) {
				seen.add(id);
				const el = ensureContainer(id);
				const rect = nodeToOverlayRect(node, viewport);
				const scale = viewport.scale;
				// The container keeps its DESIGN size (unscaled CSS px) and is
				// visually scaled with `transform: scale(scale)`. The card
				// inside then lays out once at design size and zooms as one
				// unit — text, grids and paddings scale with the canvas zoom
				// exactly like LiteGraph's canvas-drawn widgets. Without this,
				// the container width/height were set in screen px while the
				// card content stayed fixed-size: zooming made the text
				// overflow/clip and reflow on every wheel frame = "layout
				// chaos" inside nodes.
				const designW = rect.width / scale;   // = node.size[0]
				const designH = rect.height / scale;  // = node.size[1]
				// Insets are expressed in SCREEN px; convert to design px so
				// the port-dot/title-bar margins stay constant on screen.
				const sideInset = SIDE_INSET / scale;
				const topInsetD = (fullCover ? 0 : TOP_INSET) / scale;
				const bottomInsetD = (fullCover ? 0 : BOTTOM_INSET) / scale;
				el.style.left = `${rect.left + SIDE_INSET}px`;
				el.style.top = `${rect.top + (fullCover ? 0 : TOP_INSET)}px`;
				el.style.width = `${Math.max(0, designW - 2 * sideInset)}px`;
				el.style.height = `${Math.max(0, designH - topInsetD - bottomInsetD)}px`;
				el.style.transform = `scale(${scale})`;
				el.style.transformOrigin = '0 0';
				el.style.display = 'block';
				// Selection / execution-state ring in the DOM layer (fullCover
				// nodes only — see OverlayNode.selected/state). boxShadow
				// paints OUTSIDE the element and is not affected by the
				// container's overflow:hidden; the 8px radius matches the
				// NodeCard's own border-radius so the ring hugs the card.
				const ring = overlayRingColor(fullCover, selected, state);
				if (ring) {
					el.style.borderRadius = '8px';
					el.style.boxShadow = `0 0 0 2px ${ring}`;
				} else {
					el.style.boxShadow = 'none';
				}
			}
			for (const [id, el] of containers) {
				if (!seen.has(id)) {
					el.style.display = 'none';
				}
			}
		},
	};
}

/**
 * Attach the overlay layer to a canvas container and keep it sized with it.
 * Returns a destroy function.
 */
export function attachOverlayLayer(
	canvasContainer: HTMLElement,
	doc: MinimalDocument = globalThis.document,
): { layer: HTMLElement; destroy: () => void } {
	let layer = Array.from(canvasContainer.querySelectorAll<HTMLElement>('.wf-comfy-overlay'))[0];
	if (!layer) {
		layer = doc.createElement('div');
		layer.className = 'wf-comfy-overlay';
		layer.style.position = 'absolute';
		layer.style.inset = '0';
		layer.style.pointerEvents = 'none';
		layer.style.zIndex = '10';
		canvasContainer.appendChild(layer);
	}
	return {
		layer,
		destroy() {
			layer.remove();
		},
	};
}
