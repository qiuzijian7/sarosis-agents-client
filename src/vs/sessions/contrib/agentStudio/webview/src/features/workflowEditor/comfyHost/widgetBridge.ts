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

import { buildClipPath, renderAreaToLayerRect, type ClipRect } from './domClipping.js';

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
const DEFAULT_SIDE_INSET = 15;
const DEFAULT_TOP_INSET = 50;
const DEFAULT_BOTTOM_INSET = 8;

/** LiteGraph layout constants (litegraph.es.js: NODE_TITLE_HEIGHT / NODE_SLOT_HEIGHT). */
export const LITEGRAPH_TITLE_HEIGHT = 30;
export const LITEGRAPH_SLOT_HEIGHT = 20;

/** Card insets in GRAPH units — the region of the node the DOM card covers.
 *  Mirrors LiteGraph's widget area so canvas-drawn ports/title stay visible. */
export interface OverlayInsets {
	left: number;
	right?: number;
	top: number;
	bottom?: number;
}

/** Widget-area insets for a node with the given slot counts.
 *  top = title bar + one row per port pair, so the card starts below the pins
 *  (LiteGraph stacks input/output slots vertically under the title). */
export function widgetAreaInsets(inputCount: number, outputCount: number): OverlayInsets {
	const rows = Math.max(inputCount, outputCount, 0);
	return {
		left: DEFAULT_SIDE_INSET,
		right: DEFAULT_SIDE_INSET,
		top: LITEGRAPH_TITLE_HEIGHT + rows * LITEGRAPH_SLOT_HEIGHT,
		bottom: DEFAULT_BOTTOM_INSET,
	};
}

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
	/** Card insets in GRAPH units (see `widgetAreaInsets`). Omit for defaults. */
	insets?: OverlayInsets;
	/** addDOMWidget mode: the exact widget rectangle LiteGraph's `arrange()`
	 *  assigned to the node's form widget (graph units). When present, this
	 *  wins over `insets` — the overlay stops deriving layout itself and just
	 *  tracks the rectangle LiteGraph computed (side margins still apply so
	 *  port dots stay clear). */
	widgetRect?: { y: number; height: number };
	/** ComfyUI `getDomWidgetZIndex()`: 节点在 `graph.nodes` 中的下标。DOM 卡片的
	 *  层级**只**由它决定（与 LiteGraph 绘制 canvas 的顺序同源），不做 hover 提升。 */
	zIndex?: number;
	/** 节点 `renderArea`（graph 单位 `[x, y, w, h]`，含标题栏/外部装饰）。
	 *  用于 ComfyUI 式 DOM 裁剪：层级更低的卡片会挖掉这块区域，从而让
	 *  层级更高节点的 canvas 主体不被下层 DOM 遮挡。 */
	renderArea?: ArrayLike<number>;
}

/**
 * 「只参与裁剪、不拥有 DOM 卡片」的节点。
 *
 * canvas 与 DOM 是两个独立合成层，overlay 整体压在 canvas 之上，**任何**
 * 纯 canvas 绘制的节点都不可能靠 z-index 盖住 DOM 卡片。唯一手段是把它的
 * `renderArea` 从层级更低的卡片里挖掉（ComfyUI `useDomClipping` 的思路）。
 *
 * 因此裁剪清单必须覆盖 **graph 里的全部节点**，而不只是有卡片的那些：
 * Saros 的 agent / 提示词节点（`spec.kind` 为 `react` / `llm`，参数直接画在
 * canvas 上）与折叠节点都没有卡片，若不作为遮挡源提供，与它们重叠的
 * image stage 卡片就会永远盖在上面 —— 即「agent / 提示词节点层级始终在
 * image stage 下方」。
 */
export interface OverlayOccluder {
	/** 节点在 `graph.nodes` 中的下标（与卡片 `OverlayNode.zIndex` 同一量纲）。 */
	zIndex: number;
	/** 节点 `renderArea`（graph 单位 `[x, y, w, h]`）。 */
	renderArea: ArrayLike<number>;
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
	/** reposition all active containers from a snapshot of nodes + viewport.
	 *  `occluders`（可选）= graph 中**全部**节点的层级 + renderArea，用于 DOM
	 *  裁剪。提供时它是唯一裁剪源（`nodes` 自带的 renderArea 不再重复计入，
	 *  否则 evenodd 下同一矩形被挖两次会相互抵消）。见 `OverlayOccluder`。 */
	sync(nodes: OverlayNode[], viewport: CanvasViewport, occluders?: readonly OverlayOccluder[]): void;
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
			// overflow: visible (NOT hidden) so schema-node port bars can sit
			// on the node edge with labels just outside — card shadow is
			// applied on the inner card root, so it still renders correctly.
			el.style.overflow = 'visible';
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
		sync(nodes, viewport, occluders): void {
			// Cards default to sitting just below LiteGraph's title bar and
			// INSIDE the port circles. Nodes that suppress the canvas title
			// bar (schema stages) pass fullCover → the card covers the whole
			// node rect so the entire node is one DOM layer.
			//
			// INSETS ARE IN GRAPH (design) UNITS, not screen px. LiteGraph draws
			// the title bar and port dots in graph units scaled by the zoom, so
			// a constant screen-px inset would shrink/grow relative to the ports
			// and cover them at any zoom != 1 (that was the "缩放时遮挡 pin" bug).
			// Multiplying by `scale` keeps the card locked to the same graph-space
			// region — exactly the widget area — at every zoom level.
			//
			// Defaults mirror LiteGraph's own widget area:
			//  - left/right: `BaseWidget.margin` = 15. Port circles are drawn at
			//    x = NODE_SLOT_HEIGHT/2 = 10 with radius 4–5 → they span x=5..15,
			//    so widgets starting at 15 never cover them.
			//  - top: NODE_TITLE_HEIGHT (30) + one slot row (NODE_SLOT_HEIGHT 20).
			//    Callers that know the node's real slot count should pass
			//    `insets.top` = 30 + max(inputs, outputs) * 20 so the card starts
			//    below the port rows (see LiteGraphCanvas).
			//  - bottom: 8 so output labels near the bottom stay readable.
			const seen = new Set<string>();
			// ── ComfyUI 式层级：DOM 裁剪需要"谁在我之上"的清单 ──────────────
			// `zIndex` = 节点在 graph.nodes 中的下标（ComfyUI getDomWidgetZIndex），
			// 与 LiteGraph 画 canvas 的顺序同源。canvas 与 DOM 是两个合成层，
			// 无法交错层叠，因此对每个卡片挖掉所有**层级更高**节点的 renderArea
			// （ComfyUI useDomClipping 的推广版：原版只挖当前选中节点）。
			//
			// 优先使用调用方给的 `occluders`（覆盖 graph 全部节点）：只有这样，
			// 纯 canvas 绘制、没有卡片的节点（Saros agent / 提示词、折叠节点）才
			// 能挖穿层级更低的 image stage 卡片，否则它们会被永久遮住。
			// 未提供时退回「仅卡片节点」（旧行为，保持既有单测语义）。
			// 注意：两者不可叠加 —— buildClipPath 用 evenodd，同一矩形挖两次会
			// 相互抵消，反而恢复成不裁剪。
			const clipSources: Array<{ z: number; rect: ClipRect }> = [];
			if (occluders && occluders.length > 0) {
				for (const o of occluders) {
					clipSources.push({
						z: o.zIndex,
						rect: renderAreaToLayerRect(o.renderArea, [viewport.x, viewport.y], viewport.scale),
					});
				}
			} else {
				for (const n of nodes) {
					if (!n.renderArea) { continue; }
					clipSources.push({
						z: n.zIndex ?? 0,
						rect: renderAreaToLayerRect(n.renderArea, [viewport.x, viewport.y], viewport.scale),
					});
				}
			}
			for (const { id, node, fullCover, selected, state, insets, widgetRect, zIndex } of nodes) {
				seen.add(id);
				const el = ensureContainer(id);
				const rect = nodeToOverlayRect(node, viewport);
				const scale = viewport.scale;
				const SIDE_INSET = insets?.left ?? DEFAULT_SIDE_INSET;
				const RIGHT_INSET = insets?.right ?? insets?.left ?? DEFAULT_SIDE_INSET;
				// addDOMWidget mode: top = the widget's LiteGraph-assigned y;
				// height = the widget's computedHeight (NOT node-minus-insets).
				const TOP_INSET = widgetRect?.y ?? insets?.top ?? DEFAULT_TOP_INSET;
				const BOTTOM_INSET = insets?.bottom ?? DEFAULT_BOTTOM_INSET;
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
				// Insets are GRAPH units. `fullCover` keeps the card flush with
				// the node rect (the caller suppressed the canvas title bar and
				// owns the whole node visual).
				//
				// addDOMWidget (widgetRect) mode: the card is FLUSH with the node
				// body (inset 0) so its edges align exactly with the node
				// background. This only works because NodeCard's root draws its
				// accent edge with an INSET box-shadow instead of a `border`:
				// a border sits outside the content box and would overflow the
				// node by its width (that was the "widget 超出节点范围" bug).
				// A side margin here would instead leave the node background
				// visible as a gutter on both sides ("无法对齐").
				const insetL = fullCover || widgetRect ? 0 : SIDE_INSET;
				const insetR = fullCover || widgetRect ? 0 : RIGHT_INSET;
				// 顶部**绝不能**对 fullCover 归零。
				//
				// LiteGraph 0.17 的坐标原点是 node body 顶部（标题栏画在 pos[1]
				// 之上），端口行就在 body 内 y=(i+0.7)*20 处。若 insetT=0，卡片从
				// body 顶端铺满 → **端口圆点与 Image 标签被整行盖住**，连线看起来
				// 是「插在卡片背后」（ComfyTV 参考 UI 里端口行清晰可见）。
				//
				// TOP_INSET 已经是 `widgetRect.y ?? insets.top ?? DEFAULT`，而
				// widgetRect.y 来自 LiteGraph `arrange()` 分配给 form widget 的 y
				// （必定在端口行下方）；arrange 未跑时调用方给的 fallbackY 也是
				// `maxPorts*20 + 6 + …`，同样在端口行下方。
				const insetT = TOP_INSET;
				const insetB = fullCover ? 0 : BOTTOM_INSET;
				// Position in screen px: the graph-unit inset scales with zoom so
				// the card stays locked to the widget area of the node.
				el.style.left = `${rect.left + insetL * scale}px`;
				el.style.top = `${rect.top + insetT * scale}px`;
				el.style.width = `${Math.max(0, designW - insetL - insetR)}px`;
				// addDOMWidget mode: the card height IS the widget's
				// computedHeight (LiteGraph laid it out); otherwise derive it
				// from the node height minus insets.
				// 高度以 LiteGraph 给 form widget 的 computedHeight 为准（含
				// fullCover）——卡片顶部已下移到端口行下方，若仍用
				// `designH - insetT` 会因 insetT 变大而缩短，或在 designH 尚未被
				// 高度反馈循环撑大时溢出节点底部。
				el.style.height = widgetRect
					? `${Math.max(0, widgetRect.height)}px`
					: `${Math.max(0, designH - insetT - insetB)}px`;
				el.style.transform = `scale(${scale})`;
				el.style.transformOrigin = '0 0';
				el.style.display = 'block';
				// Defensive: child `min-width: max-content` (native <select>, <input>)
				// can otherwise push the container wider than the node rect in
				// content-box sizing. Lock the container to border-box + min-width:0
				// so the inner NodeCard is forced to clip / shrink instead of
				// expanding the DOM layer past the canvas node background.
				el.style.boxSizing = 'border-box';
				el.style.minWidth = '0';
				el.style.maxWidth = '100%';
				// addDOMWidget (widgetRect) mode: clip to the widget rectangle so
				// card content can NEVER paint outside the node bounds — even in
				// the one frame before the height-feedback loop grows the node.
				// Schema-node ports/title are canvas-drawn, so DOM clipping is
				// safe here. Non-schema nodes keep overflow:visible (their DOM
				// port bars intentionally sit on/over the node edge).
				// 即使 DOM overlay 与 canvas node 的层序会错（DOM overlay 整体在 canvas 之上），
			// 卡片内容也必须在节点 rect 内裁剪，避免下层节点的 DOM 卡片溢出盖到上层
			// 节点（曾导致「右侧节点 DOM 溢出盖住左侧节点 widget」）。卡内容视觉裁剪到
			// 自己的 node 范围即可，让 canvas node 重叠时按 g._nodes 重排后的层序绘制。
			el.style.overflow = 'hidden';
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
				// ── 层级：ComfyUI getDomWidgetZIndex ─────────────────────────
				// z-index 直接等于节点在 graph.nodes 中的下标（+1 规避 `0`/`auto`
				// 的歧义）。overlay layer 有 `isolation: isolate`，所有卡片是它的
				// 直接子元素，因此这些 z-index 在同一个 stacking context 内比较，
				// 结果稳定 —— 不需要每帧重排 DOM，也不做 hover 提升（ComfyUI 也没有）。
				const z = (zIndex ?? 0) + 1;
				el.style.zIndex = String(z);
				// ── 裁剪：ComfyUI useDomClipping ─────────────────────────────
				// 挖掉所有层级更高节点的 renderArea：DOM 卡片整体在 canvas 之上，
				// 只有把这块区域从下层卡片里"抠掉"，上层节点的 canvas 标题栏/背景
				// 才不会被下层 DOM 盖住（这正是重叠节点"UI 穿插"的根因）。
				const elRect: ClipRect = {
					x: rect.left + insetL * scale,
					y: rect.top + insetT * scale,
					width: Math.max(0, designW - insetL - insetR) * scale,
					height: (widgetRect && !fullCover
						? Math.max(0, widgetRect.height)
						: Math.max(0, designH - insetT - insetB)) * scale,
				};
				const holes: ClipRect[] = [];
				for (const src of clipSources) {
					if (src.z > z - 1) { holes.push(src.rect); }
				}
				const clip = buildClipPath(elRect, holes, scale);
				el.style.clipPath = clip || 'none';
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
		// ComfyUI 的 DomWidgets 根容器带 `class="isolate"`（Tailwind → isolation:isolate）。
		// 它建立一个独立 stacking context，使所有卡片的 z-index 只在本层内比较，
		// 与外部（canvas、面板、菜单）互不干扰 —— 这是 z-index 方案稳定的前提。
		layer.style.isolation = 'isolate';
		canvasContainer.appendChild(layer);
	}
	return {
		layer,
		destroy() {
			layer.remove();
		},
	};
}
