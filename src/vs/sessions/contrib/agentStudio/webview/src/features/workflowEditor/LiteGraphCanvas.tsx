/*---------------------------------------------------------------------------------------------
 *  LiteGraphCanvas — React wrapper around the ComfyUI LiteGraph canvas.
 *
 *  The workflow editor's single canvas backend (ReactFlow has been removed).
 *  Responsibilities:
 *   1. Create LGraph + LGraphCanvas on an <canvas> ref.
 *   2. Register the three tiers of node types (Sarosis.* / ComfyTV.* / native)
 *      via the comfyHost registry.
 *   3. Two-way sync with useWorkflowEditorStore:
 *        store → graph  (loadWorkflow / store change → configure)
 *        graph → store  (on_change → toWorkflowData → store.setNodes/setEdges)
 *   4. widgetBridge overlay: mount React cards over LiteGraph canvas nodes.
 *
 *  Keeps all direct LiteGraph calls inside this component; the rest of the
 *  webview talks to the store as before.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { LiteGraph, LGraph, LGraphCanvas, LGraphGroup, LGraphNode } from '@comfyorg/litegraph';
import { useWorkflowEditorStore } from './store';
import {
	resolveShortcutAction, isEditableTarget, toggleModeForNodes, toggleCollapseForNodes,
	createGroupForNodes, removeGroupsContaining, NODE_MODE_MUTE, NODE_MODE_BYPASS,
} from './shortcuts';
import { registerSarosisNodes, getNodeSpec, isPortTypeCompatible, isValidLiteGraphConnection, registerComfyUINativeNode } from './comfyHost/registry';
import { registerSarosisLiteGraphNodes } from './comfyHost/sarosisLiteGraphNodes';
import { toLiteGraph, fromLiteGraph } from './comfyHost/ComfyGraphAdapter';
import { filterNodesForLiteGraph, findUnsupportedNodes } from './comfyHost/canvasNodeFilter';
import { CardStateStore } from './comfyHost/cardState';
import { attachOverlayLayer, createWidgetBridgeHost, type WidgetBridgeHost } from './comfyHost/widgetBridge';
import { getNodeCardMeta, createNodeCard } from './comfyHost/nodeCard';
import { buildMinimapScene, minimapToGraph, applyMinimapPan, renderMinimap } from './minimap';
import { applyComfyNodeStyle } from './comfyNodeStyle';
import { parseGuiWorkflow, guiToApi, type ComfyGuiWorkflow } from './comfyHost/comfyApiAdapter';
import { MediaSnapshotStore, createMemoryBackend } from './comfyHost/mediaSnapshotStore';
import type { WorkflowGraphNode, WorkflowGraphConnection } from '../../../types/workflowStorage';

/**
 * Pure helper: compute a node's new position from a pointermove delta. Pulled
 * out of the event handler so the e2e tests can verify the math directly
 * (the handler itself needs a real DOM / PointerEvent to run).
 */
export function applyNodeDragDelta(
	origPos: [number, number],
	clientDx: number,
	clientDy: number,
	scale: number,
): [number, number] {
	return [
		origPos[0] + clientDx / scale,
		origPos[1] + clientDy / scale,
	];
}

let sarosisRegistered = false;

/**
 * Draw a fixed-step screen-pixel grid (32px minor, 64px major). The grid is
 * deliberately invariant under canvas scale: we draw it in **screen pixels**,
 * not in graph space, so zooming in/out only shifts the offset but never
 * stretches the spacing.
 *
 * Major step = 2× minor (not 4×) keeps the grid visually compact on typical
 * 600–900px canvas sizes — a 128px major grid felt too sparse.
 *
 * Pure: takes a `ctx` (any object with `fillStyle` + `fillRect` — easy to fake
 * in tests) plus the current viewport and emits draw calls. The caller is
 * expected to have reset the canvas transform to identity.
 */
export function drawCanvasGrid(
	ctx: { fillStyle: string; fillRect: (x: number, y: number, w: number, h: number) => void },
	width: number,
	height: number,
	scale: number,
	offsetX: number,
	offsetY: number,
): void {
	const minor = 32;
	const major = minor * 2;
	// Convert graph-space offset to screen space (the *visible* shift of the grid)
	const sx = offsetX * scale;
	const sy = offsetY * scale;
	// First grid line ≥ 0 (in screen space) for each axis, aligned to the step.
	const startX = ((sx % minor) + minor) % minor;
	const startY = ((sy % minor) + minor) % minor;
	ctx.fillStyle = '#2a2a2a';
	for (let x = startX; x < width; x += minor) {
		ctx.fillRect(x, 0, 1, height);
	}
	for (let y = startY; y < height; y += minor) {
		ctx.fillRect(0, y, width, 1);
	}
	// Major grid every 4 cells
	const startMX = ((sx % major) + major) % major;
	const startMY = ((sy % major) + major) % major;
	ctx.fillStyle = '#333333';
	for (let x = startMX; x < width; x += major) {
		ctx.fillRect(x, 0, 1, height);
	}
	for (let y = startMY; y < height; y += major) {
		ctx.fillRect(0, y, width, 1);
	}
}

/** Register Sarosis node classes onto the LiteGraph singleton (idempotent). */
function ensureSarosisRegistration(): void {
	if (sarosisRegistered) { return; }
	registerSarosisNodes();
	registerSarosisLiteGraphNodes();
	sarosisRegistered = true;
}

export interface LiteGraphCanvasHandle {
	/** Parse + import a ComfyUI GUI workflow into the graph. Returns issues list. */
	importComfyWorkflow(raw: unknown): string[];
	/** Export the current graph as a ComfyUI API /prompt payload. */
	exportApi(): ComfyGuiWorkflow | null;
	/** Media snapshot store backing card thumbnails. */
	snapshotStore(): MediaSnapshotStore | null;
	/** Execution-state store driving card run button / progress / error / output. */
	cardStateStore(): CardStateStore;
	/** Remove a group from the graph (nodes keep their positions). */
	removeGroup(group: LGraphGroup): void;
}

interface LiteGraphCanvasProps {
	className?: string;
	style?: React.CSSProperties;
	/** nodeId (logical __sarosisId) + LiteGraph node type (e.g. "ComfyTV.ImageStage") */
	onNodeDoubleClick?: (nodeId: string, nodeType: string) => void;
	/** Card ▶ run button (`wf-node-run`). Kept separate from double-click:
	 *  double-click opens the editor; the card button executes the node. */
	onNodeRun?: (nodeId: string, nodeType: string) => void;
	/** Right-click on the canvas → open the node menu at the clicked graph position. */
	onCanvasContextMenu?: (graphX: number, graphY: number, clientX: number, clientY: number) => void;
	/** Right-click on a group → open the group menu. */
	onGroupContextMenu?: (group: LGraphGroup, graphX: number, graphY: number, clientX: number, clientY: number) => void;
	/** Ctrl+Enter on the canvas → run the workflow (ComfyUI "Queue prompt"). */
	onRequestRun?: () => void;
}

export const LiteGraphCanvas = React.forwardRef<LiteGraphCanvasHandle, LiteGraphCanvasProps>(
	function LiteGraphCanvas({ className, style, onNodeDoubleClick, onNodeRun, onCanvasContextMenu, onGroupContextMenu, onRequestRun }: LiteGraphCanvasProps, ref): React.JSX.Element {
	const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
	const graphRef = React.useRef<LGraph | null>(null);
	const canvasInstanceRef = React.useRef<LGraphCanvas | null>(null);
	const containerRef = React.useRef<HTMLDivElement | null>(null);
	const minimapRef = React.useRef<HTMLCanvasElement | null>(null);
	const suppressStoreSync = React.useRef(false);
	const snapshotStoreRef = React.useRef<MediaSnapshotStore | null>(null);
	if (!snapshotStoreRef.current) {
		snapshotStoreRef.current = new MediaSnapshotStore(createMemoryBackend());
	}
	const cardStateStoreRef = React.useRef<CardStateStore | null>(null);
	if (!cardStateStoreRef.current) {
		cardStateStoreRef.current = new CardStateStore();
	}

	const storeApi = React.useMemo(() => useWorkflowEditorStore, []);
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const edges = useWorkflowEditorStore(s => s.edges);
	// Keep the latest onRequestRun callback without re-running the init effect.
	const onRequestRunRef = React.useRef(onRequestRun);
	onRequestRunRef.current = onRequestRun;
	const onNodeDoubleClickRef = React.useRef(onNodeDoubleClick);
	onNodeDoubleClickRef.current = onNodeDoubleClick;
	const onNodeRunRef = React.useRef(onNodeRun);
	onNodeRunRef.current = onNodeRun;

	// ── init: create graph + canvas + overlay ──────────────────────────────
	React.useEffect(() => {
		const canvas = canvasRef.current;
		const container = containerRef.current;
		if (!canvas || !container) { return; }

		ensureSarosisRegistration();
		// Type-aware connection validation (image→image, text→text, ANY wildcard).
		LiteGraph.isValidConnection = isValidLiteGraphConnection;
		const graph = new LGraph();
		const liteCanvas = new LGraphCanvas(canvas, graph);
		// ComfyUI-style connections: yellow, slightly thicker. (P0 visual parity —
		// deeper node / widget restyle (rounded backdrop, ⌄ caret, output type
		// chips) is a larger undertaking and tracked as a follow-up.)
		(liteCanvas as unknown as { connectionColor: string }).connectionColor = '#c0a000';
		(liteCanvas as unknown as { linkColor: string }).linkColor = '#c0a000';
		(liteCanvas as unknown as { link_width: number }).link_width = 2;
		// ComfyUI node look for ALL nodes: title bar (⌄ + type chips), dark
		// palette, rounded widgets, yellow connections, error banners.
		applyComfyNodeStyle(liteCanvas, LGraphNode, LiteGraph, (nodeId) => {
			const s = cardStateStoreRef.current?.get(nodeId);
			if (!s) { return undefined; }
			return { runState: s.runState, errorMsg: s.errorMsg };
		});

		// Size the canvas BACKING STORE to the container. A bare <canvas>
		// starts at 300×150 and LGraphCanvas never resizes it (its `autoresize`
		// only fires on mousemove), so without this the canvas is CSS-stretched
		// several ×: the grid looks huge, wheel-zoom anchors land off-cursor,
		// and graph hit-tests miss nodes (drag feels dead). A ResizeObserver
		// keeps backing == CSS size when panels are resized.
		const applyCanvasSize = () => {
			const w = container.clientWidth;
			const h = container.clientHeight;
			if (w > 0 && h > 0) { liteCanvas.resize(w, h); }
		};
		applyCanvasSize();
		const resizeObserver = new ResizeObserver(applyCanvasSize);
		resizeObserver.observe(container);

		// Background color + custom grid. Painted on the FRONT canvas via
		// `onRender` (runs after the bg-composite, before nodes) instead of
		// `onRenderBackground`: litegraph 0.17.2 composites the offscreen
		// bgcanvas with drawImage(bg, 0, 0, bg.width / devicePixelRatio, …),
		// so anything painted on the bgcanvas shrinks on HiDPI displays.
		// Painting here keeps the grid correct at any DPR. The transform is
		// reset to identity so the grid is drawn in canvas pixels and never
		// stretches with zoom.
		liteCanvas.clear_background_color = '#1e1e1e';
		liteCanvas.onRender = (fgCanvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.fillStyle = '#1e1e1e';
			ctx.fillRect(0, 0, fgCanvas.width, fgCanvas.height);
			drawCanvasGrid(ctx, fgCanvas.width, fgCanvas.height, liteCanvas.ds.scale, liteCanvas.ds.offset[0], liteCanvas.ds.offset[1]);
			ctx.restore();
			// Draw groups + established links on the FRONT canvas. LiteGraph
			// 0.17.2 renders both onto the offscreen bgcanvas
			// (drawBackCanvas → drawGroups/drawConnections), which is
			// composited BEFORE this hook — so the opaque background fill
			// above would paint over them and the canvas would show nodes but
			// no wires / no group boxes. Re-drawing them here (after the fill,
			// before nodes) keeps them visible and under the nodes, matching
			// ComfyUI's default layering (groups → links → nodes).
			ctx.save();
			liteCanvas.ds.toCanvasContext(ctx);
			liteCanvas.drawGroups(canvas, ctx);
			liteCanvas.drawConnections(ctx);
			ctx.restore();
		};

		// Wheel zoom anchored at the mouse cursor. Bound on the CONTAINER in
		// the capture phase with stopPropagation so litegraph's own wheel
		// listener (bound on the canvas in its constructor) never fires —
		// otherwise both handlers zoom and the speed doubles.
		// `ds.changeScale(scale, [clientX, clientY])` takes CLIENT coords (it
		// subtracts the canvas rect itself) and keeps the cursor point stable
		// in graph space. Factor is continuous in deltaY so precision
		// touchpads / pinch (small deltaY, many events) zoom smoothly while a
		// wheel notch (|deltaY|≈100) lands near the classic 1.1× step.
		const wheelHandler = (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const ds = liteCanvas.ds;
			const factor = Math.pow(1.001, -e.deltaY);
			const next = Math.max(ds.min_scale, Math.min(ds.max_scale, ds.scale * factor));
			if (next === ds.scale) { return; }
			ds.changeScale(next, [e.clientX, e.clientY]);
			graph.change();
		};
		container.addEventListener('wheel', wheelHandler, { passive: false, capture: true });

		// ── Custom node drag (bypasses LiteGraph's flaky onDragStart chain) ──
		// LiteGraph 0.17.2 only wires `pointer.onDragStart` at the END of
		// `#processNodeClick` (after widget / port / collapse / resize checks),
		// and the pointer needs to move >6px or >150ms to fire it. In practice
		// the wiring fails for many hit positions and the user just sees the
		// node get selected but never move. We listen in the bubble phase,
		// capture the drag state on pointerdown when we hit a node, and move
		// `node.pos` ourselves on pointermove. We wrap the mutation in
		// `graph.beforeChange/afterChange` so the move is one undo step.
		// LiteGraph's own selection (`pointer.onClick = processSelect`) still
		// runs in parallel and selects the node for the user.
		type DragRef = {
			node: { pos: [number, number]; pinned?: boolean; size: [number, number] };
			origPos: [number, number];
			startClientX: number;
			startClientY: number;
			graphBefore: boolean;
		};
		let dragRef: DragRef | null = null;
		const dragPointerDown = (e: PointerEvent) => {
			if (e.button !== 0) { return; }
			const rect = canvas.getBoundingClientRect();
			const cx = (e.clientX - rect.left) / liteCanvas.ds.scale - liteCanvas.ds.offset[0];
			const cy = (e.clientY - rect.top) / liteCanvas.ds.scale - liteCanvas.ds.offset[1];
			const hit = graph.getNodeOnPos(cx, cy);
			if (!hit) { dragRef = null; return; }
			if (hit.pinned) { dragRef = null; return; }
			// Clicking on an input/output slot is the LINK-DRAG gesture — hand it
			// back to LiteGraph's linkConnector instead of dragging the node.
			// Use the direct `getInputOnPos` / `getOutputOnPos` API (graph coords)
			// rather than `getSlotOnPos` which depends on a possibly-stale cached
			// `boundingRect`.
			if (hit.getInputOnPos?.([cx, cy]) || hit.getOutputOnPos?.([cx, cy])) {
				dragRef = null;
				return;
			}
			dragRef = {
				node: hit as DragRef['node'],
				origPos: [hit.pos[0], hit.pos[1]],
				startClientX: e.clientX,
				startClientY: e.clientY,
				graphBefore: false,
			};
		};
		const dragPointerMove = (e: PointerEvent) => {
			if (!dragRef) { return; }
			const clientDx = e.clientX - dragRef.startClientX;
			const clientDy = e.clientY - dragRef.startClientY;
			const next = applyNodeDragDelta(
				dragRef.origPos,
				clientDx,
				clientDy,
				liteCanvas.ds.scale,
			);
			if (!dragRef.graphBefore) {
				graph.beforeChange(dragRef.node);
				dragRef.graphBefore = true;
			}
			dragRef.node.pos[0] = next[0];
			dragRef.node.pos[1] = next[1];
			graph.change();
		};
		const dragPointerUp = () => {
			if (dragRef?.graphBefore) {
				graph.afterChange(dragRef.node);
			}
			dragRef = null;
		};
		canvas.addEventListener('pointerdown', dragPointerDown);
		// Listen on window so a fast drag past the canvas edge keeps moving.
		window.addEventListener('pointermove', dragPointerMove);
		window.addEventListener('pointerup', dragPointerUp);
		window.addEventListener('pointercancel', dragPointerUp);

		// Belt-and-suspenders linkConnector reset on container pointerup/cancel.
		// LiteGraph's `pointer.finally` only runs on a clean pointerup; if the
		// gesture is cancelled mid-drag (e.g. window blur, lost capture),
		// `linkConnector.isConnecting` stays `true` and the next
		// `dragNewFromOutput` throws "Already dragging links." silently. We force
		// a reset here so the next pin-drag always works.
		const resetLinkConnector = () => {
			const lc = (liteCanvas as unknown as { linkConnector?: { isConnecting: boolean; reset: (force?: boolean) => void; connectingTo?: unknown } }).linkConnector;
			if (lc && lc.isConnecting) { lc.reset(true); }
			(liteCanvas as unknown as { dragging_node?: unknown }).dragging_node = null;
		};
		container.addEventListener('pointerup', resetLinkConnector);
		container.addEventListener('pointercancel', resetLinkConnector);

		// ── ComfyUI-style node-operation shortcuts ──────────────────────────
		// LiteGraph binds `processKey` (Ctrl+A/C/V, Delete/Backspace, Space
		// pan, Escape) on the CANVAS element — but a bare <canvas> is never
		// keyboard-focusable, so we give it a tabIndex and focus it on any
		// pointerdown inside the container. The ComfyUI extras litegraph does
		// NOT provide (mute/bypass/collapse/duplicate/group/ungroup/fit/run)
		// are handled here on the container; keydown bubbles up from the
		// focused canvas to reach this handler.
		canvas.tabIndex = 0;
		canvas.style.outline = 'none';
		const focusCanvas = () => { canvas.focus(); };
		container.addEventListener('pointerdown', focusCanvas, { capture: true });

		const handleKeyDown = (e: KeyboardEvent) => {
			if (isEditableTarget(e.target)) { return; }
			const action = resolveShortcutAction(e);
			if (!action) { return; }
			e.preventDefault();
			e.stopPropagation();
			const lc = canvasInstanceRef.current;
			const g = graphRef.current;
			if (!lc || !g) { return; }
			const selected = Object.values(lc.selected_nodes as Record<string, LGraphNode>);
			switch (action) {
				case 'mute': toggleModeForNodes(selected, NODE_MODE_MUTE); break;
				case 'bypass': toggleModeForNodes(selected, NODE_MODE_BYPASS); break;
				case 'collapse': toggleCollapseForNodes(selected); break;
				case 'duplicate':
					if (selected.length) {
						lc.copyToClipboard();
						lc.pasteFromClipboard({ connectInputs: true });
					}
					break;
				case 'group': createGroupForNodes(g, selected); break;
				case 'ungroup': removeGroupsContaining(g, [...g._groups], selected); break;
				case 'fit': lc.zoomToFit?.(); break;
				case 'run': onRequestRunRef.current?.(); break;
			}
			g.change();
		};
		container.addEventListener('keydown', handleKeyDown);

		graphRef.current = graph;
		canvasInstanceRef.current = liteCanvas;

		// selection → store
		liteCanvas.onNodeDeselected = () => {
			storeApi.getState().setSelectedNode(null);
		};

		// graph change → store (debounced)
		graph.on_change = () => {
			if (suppressStoreSync.current) { return; }
			// do the store sync on next tick to coalesce drag updates
			window.setTimeout(() => syncGraphToStore(graph, storeApi.getState().setNodes, storeApi.getState().setEdges), 0);
		};

		liteCanvas.startRendering();
		// initial load from store
		syncStoreToGraph(graph, storeApi.getState().nodes, storeApi.getState().edges);

		// ── ComfyTV-style card overlay: mount React cards above canvas nodes ──
		// The overlay layer + widgetBridge host sit on top of the <canvas> and
		// render one `NodeCard` per graph node (run button / progress / error /
		// output preview). A rAF loop keeps the DOM cards aligned with node
		// positions as the canvas pans/zooms and nodes are added/removed.
		// Cards are pointer-events:none (presentational); double-click still
		// opens the NodeEditorPopup for editing.
		const overlay = attachOverlayLayer(container);
		const bridge: WidgetBridgeHost = createWidgetBridgeHost(overlay.layer);
		const cardUnmounts = new Map<string, () => void>();
		let overlayRaf = 0;
		const syncOverlay = () => {
			overlayRaf = requestAnimationFrame(syncOverlay);
			const g = graphRef.current;
			const lc = canvasInstanceRef.current;
			if (!g || !lc) { return; }
			const ds = lc.ds;
			const nodesForSync: Array<{ id: string; node: { pos: [number, number]; size?: [number, number] }; fullCover?: boolean; selected?: boolean; state?: string }> = [];
			const seen = new Set<string>();
			// z-index: cards must follow the node DRAW ORDER (graph.nodes array
			// order — later nodes paint on top). We use the array index as the
			// base z-index so a card for a "higher" node always sits above cards
			// of "lower" nodes. Hovered / selected nodes get an extra boost so
			// their card stays on top even when overlapping.
			const hoverId = (() => {
				const n = lc.node_over as LGraphNode | undefined;
				if (!n) { return null; }
				const p = (n.properties ?? {}) as Record<string, unknown>;
				return String(p['__sarosisId'] ?? n.id);
			})();
		const selectedIds = new Set<string>();
		// `selected_nodes` lives on LGraphCanvas (NOT on LGraph — reading
		// g.selected_nodes yields undefined and the selection ring never
		// renders). The per-node `selected` flag is checked in the loop below
		// as a second source of truth.
		for (const k of Object.keys(lc.selected_nodes ?? {})) {
			const n = g.getNodeById(k);
			if (!n) { continue; }
			const p = (n.properties ?? {}) as Record<string, unknown>;
			selectedIds.add(String(p['__sarosisId'] ?? n.id));
		}
			for (let nodeIdx = 0; nodeIdx < g.nodes.length; nodeIdx++) {
				const n = g.nodes[nodeIdx];
				const props = (n.properties ?? {}) as Record<string, unknown>;
				const nodeId = String(props['__sarosisId'] ?? n.id);
				seen.add(nodeId);
				const type = String(props['__liteType'] ?? n.type ?? '');
				const spec = getNodeSpec(type);
				// Only ComfyTV (schema) + ComfyUI-native nodes get an overlay card.
				// Sarosis react nodes already draw their widgets on the canvas.
				if (!spec || spec.kind === 'react') { continue; }
				// Bump height for ComfyTV schema nodes (no class default → 60px).
				// Native nodes already compute a reasonable size from widgets.
				if (spec.kind === 'schema' && (n.size?.[1] ?? 0) < 320) {
					n.size = [Math.max(n.size?.[0] ?? 220, 230), 320];
				}
			const container = bridge.ensureContainer(nodeId);
			// Base z follows draw order (graph.nodes index). Hovered /
			// selected nodes get a big boost so their card stays on top.
			const isSelected = selectedIds.has(nodeId) || !!(n as unknown as { selected?: boolean }).selected;
			const baseZ = nodeIdx + 1;
			const boosted = (nodeId === hoverId || isSelected) ? 1000 : 0;
			container.style.zIndex = String(baseZ + boosted);
			if (!cardUnmounts.has(nodeId)) {
				const meta = getNodeCardMeta(spec, props);
				const unmount = createNodeCard(container, meta, {
					snapshotStore: snapshotStoreRef.current ?? undefined,
					cardStateStore: cardStateStoreRef.current ?? undefined,
					nodeId,
				});
				cardUnmounts.set(nodeId, unmount);
				if (spec.kind === 'schema') {
					// Schema nodes are one DOM layer (fullCover): suppress ALL
					// canvas-drawn borders (selection stroke, error stroke,
					// execution-state overlay). They sit below the overlay and
					// get clipped by other nodes' cards, which reads as a
					// broken z-order. The bridge re-draws them as DOM rings
					// via `selected`/`state` below (see overlayRingColor).
					const nodeAny = n as unknown as { strokeStyles?: Record<string, unknown>; onDrawForeground?: unknown };
					if (nodeAny.strokeStyles) {
						delete nodeAny.strokeStyles['selected'];
						delete nodeAny.strokeStyles['error'];
					}
					nodeAny.onDrawForeground = () => { /* state ring lives in the DOM layer */ };
				}
			}
			// Schema stages hide their canvas title bar (NO_TITLE class), so
			// the card covers the whole node rect — the whole node becomes
			// one DOM layer and z-order follows draw order cleanly.
			nodesForSync.push({
				id: nodeId,
				node: { pos: n.pos, size: n.size },
				fullCover: spec.kind === 'schema',
				selected: isSelected,
				state: cardStateStoreRef.current?.get(nodeId)?.runState,
			});
			}
			// drop cards for nodes that were removed from the graph
			for (const [id, unmount] of cardUnmounts) {
				if (!seen.has(id)) {
					unmount();
					bridge.releaseContainer(id);
					cardUnmounts.delete(id);
				}
			}
			bridge.sync(nodesForSync, { x: ds.offset[0], y: ds.offset[1], scale: ds.scale });
		};
		syncOverlay();

		// Card ▶ run button → execute the node (distinct from double-click,
		// which only opens the editor). Falls back to the double-click path
		// when no run handler is wired.
		const handleNodeRun = (e: Event) => {
			const nodeId = (e as CustomEvent<{ nodeId: string }>).detail?.nodeId;
			if (!nodeId) { return; }
			const node = graph.nodes.find(n => String((n.properties as Record<string, unknown> | undefined)?.['__sarosisId'] ?? n.id) === nodeId);
			if (!node) { return; }
			const props = (node.properties ?? {}) as Record<string, unknown>;
			const nodeType = String(props['__liteType'] ?? node.type ?? '');
			const handler = onNodeRunRef.current ?? onNodeDoubleClickRef.current;
			handler?.(nodeId, nodeType);
		};
		window.addEventListener('wf-node-run', handleNodeRun);

		// Inline prompt editing on cards → write back into node.properties so
		// the store (graph.change → syncGraphToStore) and editor popup see it.
		const handleNodePrompt = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId: string; prompt: string }>).detail;
			if (!detail?.nodeId) { return; }
			const node = graph.nodes.find(n => String((n.properties as Record<string, unknown> | undefined)?.['__sarosisId'] ?? n.id) === detail.nodeId);
			if (!node) { return; }
			node.properties.prompt = detail.prompt;
			graph.change?.();
			graph.setDirtyCanvas?.(true, true);
		};
		window.addEventListener('wf-node-prompt', handleNodePrompt);

		// Inline parameter controls (workflow/resolution/…) → write back into
		// node.properties the same way as the prompt editor.
		const handleNodeControl = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId: string; name: string; value: unknown }>).detail;
			if (!detail?.nodeId || !detail.name) { return; }
			const node = graph.nodes.find(n => String((n.properties as Record<string, unknown> | undefined)?.['__sarosisId'] ?? n.id) === detail.nodeId);
			if (!node) { return; }
			node.properties[detail.name] = detail.value;
			graph.change?.();
			graph.setDirtyCanvas?.(true, true);
		};
		window.addEventListener('wf-node-control', handleNodeControl);

		return () => {
			window.removeEventListener('wf-node-run', handleNodeRun);
			window.removeEventListener('wf-node-prompt', handleNodePrompt);
			window.removeEventListener('wf-node-control', handleNodeControl);
			cancelAnimationFrame(overlayRaf);
			for (const unmount of cardUnmounts.values()) { unmount(); }
			cardUnmounts.clear();
			overlay.destroy();
			liteCanvas.stopRendering();
			resizeObserver.disconnect();
			container.removeEventListener('wheel', wheelHandler, true);
			canvas.removeEventListener('pointerdown', dragPointerDown);
			window.removeEventListener('pointermove', dragPointerMove);
			window.removeEventListener('pointerup', dragPointerUp);
			window.removeEventListener('pointercancel', dragPointerUp);
		container.removeEventListener('pointerup', resetLinkConnector);
		container.removeEventListener('pointercancel', resetLinkConnector);
		container.removeEventListener('pointerdown', focusCanvas, true);
		container.removeEventListener('keydown', handleKeyDown);
		graph.clear();
		graphRef.current = null;
		canvasInstanceRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── ComfyUI-style minimap: small canvas bottom-right; draws node rects +
	// ── the current viewport frame; click / drag pans the main canvas. ────
	React.useEffect(() => {
		const minimapEl = minimapRef.current;
		if (!minimapEl) { return; }
		const MM_W = 200, MM_H = 125;

		const readScene = () => {
			const graph = graphRef.current;
			const liteCanvas = canvasInstanceRef.current;
			const canvas = containerRef.current?.querySelector(':scope > canvas[data-testid="litegraph-canvas"]') as HTMLCanvasElement | null;
			if (!graph || !liteCanvas || !canvas) {
				return buildMinimapScene([], { offsetX: 0, offsetY: 0, scale: 1, canvasW: 1, canvasH: 1 }, MM_W, MM_H);
			}
			const ds = liteCanvas.ds;
			const nodes = graph.nodes.map(n => ({
				id: String(n.id),
				pos: [n.pos[0], n.pos[1]] as [number, number],
				size: [n.size[0] || 1, n.size[1] || 1] as [number, number],
				color: n.color || '#3b82f6',
				collapsed: !!n.collapsed,
			}));
			return buildMinimapScene(nodes, {
				offsetX: ds.offset[0],
				offsetY: ds.offset[1],
				scale: ds.scale,
				canvasW: canvas.clientWidth,
				canvasH: canvas.clientHeight,
			}, MM_W, MM_H);
		};

		const draw = () => {
			const mctx = minimapEl.getContext('2d');
			if (!mctx) { return; }
			const dpr = window.devicePixelRatio || 1;
			if (minimapEl.width !== MM_W * dpr) {
				minimapEl.width = MM_W * dpr;
				minimapEl.height = MM_H * dpr;
			}
			mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			renderMinimap(mctx, MM_W, MM_H, readScene());
		};

		draw();
		let raf = 0;
		const loop = () => { draw(); raf = requestAnimationFrame(loop); };
		raf = requestAnimationFrame(loop);

		// interaction: click → jump; drag → pan (cursor-follow)
		let dragging = false;
		let startGraph: [number, number] | null = null;
		let startOffset: [number, number] | null = null;
		const toLocal = (e: PointerEvent) => {
			const r = minimapEl.getBoundingClientRect();
			return [e.clientX - r.left, e.clientY - r.top] as [number, number];
		};
		const onDown = (e: PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const graph = graphRef.current;
			const liteCanvas = canvasInstanceRef.current;
			if (!graph || !liteCanvas) { return; }
			const [mx, my] = toLocal(e);
			const scene = readScene();
			const [gx, gy] = minimapToGraph(mx, my, scene.bounds, MM_W, MM_H);
			const canvas = containerRef.current?.querySelector(':scope > canvas[data-testid="litegraph-canvas"]') as HTMLCanvasElement | null;
			if (canvas) {
				const ds = liteCanvas.ds;
				ds.offset[0] = canvas.clientWidth / 2 / ds.scale - gx;
				ds.offset[1] = canvas.clientHeight / 2 / ds.scale - gy;
				graph.change();
			}
			dragging = true;
			startGraph = [gx, gy];
			startOffset = [...liteCanvas.ds.offset];
			minimapEl.setPointerCapture?.(e.pointerId);
		};
		const onMove = (e: PointerEvent) => {
			if (!dragging || !startGraph || !startOffset) { return; }
			const graph = graphRef.current;
			const liteCanvas = canvasInstanceRef.current;
			if (!graph || !liteCanvas) { return; }
			const [mx, my] = toLocal(e);
			const scene = readScene();
			const [gx, gy] = minimapToGraph(mx, my, scene.bounds, MM_W, MM_H);
			const next = applyMinimapPan(startOffset, startGraph, [gx, gy]);
			const ds = liteCanvas.ds;
			ds.offset[0] = next[0];
			ds.offset[1] = next[1];
			graph.change();
		};
		const onUp = (e: PointerEvent) => {
			dragging = false;
			startGraph = null;
			startOffset = null;
			minimapEl.releasePointerCapture?.(e.pointerId);
		};
		minimapEl.addEventListener('pointerdown', onDown);
		minimapEl.addEventListener('pointermove', onMove);
		minimapEl.addEventListener('pointerup', onUp);
		minimapEl.addEventListener('pointercancel', onUp);

		return () => {
			cancelAnimationFrame(raf);
			minimapEl.removeEventListener('pointerdown', onDown);
			minimapEl.removeEventListener('pointermove', onMove);
			minimapEl.removeEventListener('pointerup', onUp);
			minimapEl.removeEventListener('pointercancel', onUp);
		};
	}, []);

	// ── store → graph (diff-based: only when graph lacks a store node) ────
	React.useEffect(() => {
		const graph = graphRef.current;
		if (!graph) { return; }
		// Compute graph node set by __sarosisId (logical id) so position-only
		// updates don't trigger a full re-configure (which would clobber drag
		// state). We only re-sync when the *set* of nodes diverges — i.e. a
		// new node was added or an existing one was removed.
		const graphIds = new Set<string>(
			graph.nodes.map(n => {
				const p = (n.properties ?? {}) as Record<string, unknown>;
				return String(p['__sarosisId'] ?? n.id);
			}),
		);
		const storeIds = new Set(nodes.map(n => n.id));
		let hasNew = false;
		for (const n of nodes) {
			if (!graphIds.has(n.id)) { hasNew = true; break; }
		}
		let hasRemoved = false;
		if (!hasNew) {
			for (const id of graphIds) {
				if (!storeIds.has(id)) { hasRemoved = true; break; }
			}
		}
	if (hasNew || hasRemoved) {
		// Suppress the graph.on_change triggered by configure() to avoid
		// bouncing back into the store (the store just authored this).
		suppressStoreSync.current = true;
		try {
			syncStoreToGraph(graph, nodes, edges, graph._groups.map(g => g.serialize()));
		} finally {
				setTimeout(() => { suppressStoreSync.current = false; }, 0);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodes, edges]);

	// ── double click on node → open card editor ────────────────────────────
	React.useEffect(() => {
		const liteCanvas = canvasInstanceRef.current;
		if (!liteCanvas || !onNodeDoubleClick) { return; }
		liteCanvas.onNodeDblClicked = (n: LGraphNode) => {
			const sarosisId = (n.properties as Record<string, unknown> | undefined)?.['__sarosisId'];
			const props = (n.properties ?? {}) as Record<string, unknown>;
			const nodeType = String(props.__liteType ?? n.type ?? '');
			onNodeDoubleClick(sarosisId as string | undefined ?? String(n.id), nodeType);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onNodeDoubleClick]);

	// ── imperative API: import ComfyUI workflow / export API prompt ─────────
	React.useImperativeHandle(ref, () => ({
		importComfyWorkflow(raw: unknown): string[] {
			const graph = graphRef.current;
			if (!graph) { return ['canvas not ready']; }
			const { graph: imported, issues } = parseGuiWorkflow(raw);
			// Ensure native node types are registered before configure().
			for (const n of imported.nodes) {
				if (!getNodeSpec(n.type)) {
					registerComfyUINativeNode({ class_name: n.type, display_name: n.type });
				}
			}
			suppressStoreSync.current = true;
			try {
				graph.configure({
					...imported,
					id: 'wf',
					groups: imported.groups ?? [],
				} as Parameters<LGraph['configure']>[0]);
				// auto-fit after import
				requestAnimationFrame(() => canvasInstanceRef.current?.zoomToFit?.());
			} finally {
				suppressStoreSync.current = false;
			}
			// push to store
			window.setTimeout(() => syncGraphToStore(graph, storeApi.getState().setNodes, storeApi.getState().setEdges), 0);
			return issues;
		},
		exportApi(): ComfyGuiWorkflow | null {
			const graph = graphRef.current;
			if (!graph || graph.nodes.length === 0) { return null; }
			const serialized = graph.serialize();
			const wf = serialized as unknown as ComfyGuiWorkflow;
			return wf;
		},
		snapshotStore(): MediaSnapshotStore | null {
			return snapshotStoreRef.current;
		},
		cardStateStore(): CardStateStore {
			return cardStateStoreRef.current!;
		},
		removeGroup(group: LGraphGroup): void {
			const g = graphRef.current;
			if (!g) { return; }
			g.remove(group);
			g.change();
		},
	}), [storeApi, ref]);

	return (
		<div
			ref={containerRef}
			className={`wf-litegraph-canvas ${className ?? ''}`}
			style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }}
		onContextMenu={(e) => {
			e.preventDefault();
			// LiteGraph opens its own (CSS-less) context menu on the right-click
			// pointerdown, before this React handler runs — close it so only our
			// React menu is shown.
			LiteGraph.closeAllContextMenus?.(window);
			const rect = e.currentTarget.getBoundingClientRect();
			const liteCanvas = canvasInstanceRef.current;
			const graph = graphRef.current;
			if (!liteCanvas || !graph) { return; }
			const ds = liteCanvas.ds;
			const gx = (e.clientX - rect.left) / ds.scale - ds.offset[0];
			const gy = (e.clientY - rect.top) / ds.scale - ds.offset[1];
			// Right-click on a group → group menu (rename/recolor/pin/remove).
			const group = graph.getGroupOnPos(gx, gy);
			if (group) {
				onGroupContextMenu?.(group, gx, gy, e.clientX, e.clientY);
				return;
			}
			onCanvasContextMenu?.(gx, gy, e.clientX, e.clientY);
		}}
	>
		<canvas
			ref={canvasRef}
			tabIndex={0}
			style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', outline: 'none' }}
			data-testid="litegraph-canvas"
		/>
			{/* ComfyUI-style minimap: nodes + viewport frame; click/drag pans */}
			<canvas
				ref={minimapRef}
				style={{
					position: 'absolute', right: 12, bottom: 12, width: 200, height: 125,
					zIndex: 30, borderRadius: 8, border: '1px solid rgba(255,255,255,.18)',
					boxShadow: '0 2px 12px rgba(0,0,0,.5)', cursor: 'crosshair', background: '#141419',
				}}
				data-testid="minimap-canvas"
			/>
		</div>
	);
	});
/** Store → graph: configure from workflow JSON via the adapter. */
function syncStoreToGraph(
	graph: LGraph,
	storeNodes: Array<{ id: string; type: string; position: { x: number; y: number }; data?: Record<string, unknown>; style?: { width?: number; height?: number } }>,
	storeEdges: Array<{ id: string; source: string; target: string }>,
	existingGroups?: Array<Record<string, unknown>>,
): void {
	const wfNodes: WorkflowGraphNode[] = storeNodes.map(n => ({
		id: n.id,
		type: n.type as WorkflowGraphNode['type'],
		name: (n.data?.label as string | undefined) ?? n.id,
		position: { x: n.position.x, y: n.position.y },
		...((n.data && Object.keys(n.data).length) ? { data: n.data as WorkflowGraphNode['data'] } : {}),
		...(n.style?.width ? { style: { width: n.style.width, height: n.style.height ?? 150 } } : {}),
	}));
	const wfConnections: WorkflowGraphConnection[] = storeEdges.map(e => ({
		id: e.id,
		from: e.source,
		to: e.target,
	}));
	const { graph: serialized } = toLiteGraph(wfNodes, wfConnections);
	// Drop any node without a registered LiteGraph spec — LiteGraph has no way
	// to render them and would draw a giant empty rectangle with resize handles.
	// Sarosis.* nodes ARE registered (see sarosisLiteGraphNodes.ts) so they pass
	// the filter. See canvasNodeFilter tests.
	const filtered = filterNodesForLiteGraph(serialized, t => getNodeSpec(t) !== undefined);
	// configure expects the ISerialisedGraph shape (groups required). Groups
	// live only on the LiteGraph instance (not in the store), so carry over
	// the current graph's groups — otherwise every store→graph resync would
	// drop the user's groups.
	graph.configure({
		...filtered.keep,
		id: 'wf',
		groups: [...(filtered.keep.groups ?? []), ...(existingGroups ?? [])],
	} as Parameters<LGraph['configure']>[0]);
}

/** Graph → store: read graph.serialize() through the adapter into the store. */
function syncGraphToStore(
	graph: LGraph,
	setNodes: (nodes: unknown[]) => void,
	setEdges: (edges: unknown[]) => void,
): void {
	const serialized = graph.serialize() as Parameters<typeof fromLiteGraph>[0];
	const { nodes, connections } = fromLiteGraph(serialized);
	setNodes(nodes.map(n => ({
		id: n.id,
		type: n.type,
		position: n.position,
		...((n.data && Object.keys(n.data).length) ? { data: n.data } : {}),
		...(n.style?.width ? { style: n.style } : {}),
	})) as never);
	setEdges(connections.map(c => ({
		id: c.id,
		source: c.from,
		target: c.to,
	})) as never);
}

// Re-export helpers used by tests / palette integration.
export { toLiteGraph, fromLiteGraph, isPortTypeCompatible, getNodeSpec };
