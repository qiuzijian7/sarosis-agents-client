/*---------------------------------------------------------------------------------------------
 *  LiteGraphCanvas — React wrapper around the ComfyUI LiteGraph canvas.
 *
 *  The workflow editor's single canvas backend (ReactFlow has been removed).
 *  Responsibilities:
 *   1. Create LGraph + LGraphCanvas on an <canvas> ref.
 *   2. Register the three tiers of node types (Saros.* / ComfyTV.* / native)
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
import { LiteGraph, LGraph, LGraphCanvas, LGraphGroup, LLink, LGraphNode } from '@comfyorg/litegraph';
import { useWorkflowEditorStore } from './store';
import {
	resolveShortcutAction, isEditableTarget, toggleModeForNodes, toggleCollapseForNodes,
	createGroupForNodes, removeGroupsContaining, NODE_MODE_MUTE, NODE_MODE_BYPASS,
} from './shortcuts';
import { registerSarosNodes, registerDefaultComfyTVStages, getNodeSpec, isPortTypeCompatible, isValidLiteGraphConnection, canConnectLayers, registerComfyUINativeNode, syncNodePortsToSpec, getAllSpecs } from './comfyHost/registry';
import { ConnectionDropMenu, type CompatibleNodeItem } from './comfyHost/ConnectionDropMenu';
import { registerSarosLiteGraphNodes } from './comfyHost/sarosLiteGraphNodes';
import { toLiteGraph, fromLiteGraph } from './comfyHost/ComfyGraphAdapter';
import { filterNodesForLiteGraph, findUnsupportedNodes } from './comfyHost/canvasNodeFilter';
import { CardStateStore } from './comfyHost/cardState';
import { attachOverlayLayer, createWidgetBridgeHost, widgetAreaInsets, LITEGRAPH_TITLE_HEIGHT, type OverlayNode, type OverlayOccluder, type WidgetBridgeHost } from './comfyHost/widgetBridge';

/** Distance from a point to a line segment. */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax; const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * dx; const cy = ay + t * dy;
	return Math.hypot(px - cx, py - cy);
}

/**
 * Hit-test a connection link in graph coordinates. litegraph 0.17.2 has no
 * `getLinkOnPos`, so we sample each link's quadratic Bézier (control points
 * on the horizontal axis, mirroring `LGraphCanvas.drawLink`) and pick the
 * first link within `threshold` graph units of the point.
 */
export function findLinkAt(graph: LGraph, x: number, y: number, threshold = 12): LLink | undefined {
	for (const link of graph.links.values()) {
		const origin = graph.getNodeById(link.origin_id);
		const target = graph.getNodeById(link.target_id);
		if (!origin || !target) { continue; }
		const p0 = origin.getOutputPos(link.origin_slot);
		const p1 = target.getInputPos(link.target_slot);
		if (!p0 || !p1) { continue; }
		const mid = (p1[0] - p0[0]) * 0.5;
		const c1 = [p0[0] + mid, p0[1]];
		const c2 = [p1[0] - mid, p1[1]];
		let px = p0[0]; let py = p0[1];
		for (let i = 1; i <= 24; i++) {
			const t = i / 24;
			const mt = 1 - t;
			const qx = mt * mt * p0[0] + 2 * mt * t * c1[0] + t * t * p1[0];
			const qy = mt * mt * p0[1] + 2 * mt * t * c1[1] + t * t * p1[1];
			if (distToSegment(x, y, px, py, qx, qy) <= threshold) { return link; }
			px = qx; py = qy;
		}
	}
	return undefined;
}
import { getDomFormWidget, setDomFormContentHeight, takeFormHeightDirty, clearFormHeightDirty, markFormHeightDirty, ensureDomFormWidget } from './comfyHost/domWidget';
import { hasStageEditor, stageMinHeight } from './comfyHost/stageCardRegistry';
import { claimStageUid, releaseStageUidByOwner, readStageUid } from './comfyHost/stageIdentity';
import { getNodeCardMeta, createNodeCard, ORCH_RICH_NODE_TYPES } from './comfyHost/nodeCard';
import { patchInlineWidgetEditor } from './comfyHost/inlineWidgetEditor';
import type { MediaSnapshotEntry } from './comfyHost/mediaSnapshot';
import { buildMinimapScene, minimapToGraph, applyMinimapPan, renderMinimap } from './minimap';
import { applyComfyNodeStyle } from './comfyNodeStyle';
import { spawnFollowUp, spawnAssetLoader, ASSET_DRAG_MIME } from './comfyHost/actionSpawn';
import { parseGuiWorkflow, guiToApi, type ComfyGuiWorkflow } from './comfyHost/comfyApiAdapter';
import { MediaSnapshotStore } from './comfyHost/mediaSnapshotStore';
import { registerSnapshotSource, unregisterSnapshotSource } from './comfyHost/workflowSnapshotBridgeWebview';
import { createIndexedDBBackend } from './comfyHost/indexedDBBackend';
import { mediaImport } from './mediaAssets';
import { shouldCollectMedia, parseDataUrl } from './comfyHost/mediaCollect';
import type { WorkflowGraphNode, WorkflowGraphConnection } from '../../types/workflowStorage';

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

let sarosRegistered = false;
let crossLayerGatePatched = false;
let zoomToFitPatched = false;

/**
 * Implement `LGraphCanvas.prototype.zoomToFit` (LiteGraph 0.17 has no such
 * method — the existing `lc.zoomToFit?.()` calls were no-ops). Fits all graph
 * nodes into the canvas viewport by computing their bounding box and setting
 * `ds.scale`/`ds.offset`. Handles nodes at NEGATIVE graph coordinates (the
 * "DOM cards disappeared" root cause — cards existed but were positioned above
 * the viewport because their nodes had negative `pos.y` and the canvas never
 * auto-fitted on first load).
 *
 * Screen math (matches LGraphCanvas.toCanvasContext): screen = (pos + offset) * scale.
 */
function patchZoomToFit(): void {
	if (zoomToFitPatched) { return; }
	const proto = LGraphCanvas.prototype as unknown as {
		zoomToFit?: () => void;
		graph?: { nodes?: Array<{ pos: [number, number]; size?: [number, number] }> };
		canvas?: {
			clientWidth: number; clientHeight: number;
			getBoundingClientRect?: () => { width: number; height: number };
			parentElement?: { getBoundingClientRect?: () => { width: number; height: number }; clientWidth: number; clientHeight: number } | null;
		} | null;
		ds?: { scale: number; offset: [number, number] };
		setDirty?: (fg: boolean, bg: boolean) => void;
	};
	if (!proto.zoomToFit) {
		proto.zoomToFit = function (this: NonNullable<typeof proto>) {
			const nodes = this.graph?.nodes;
			if (!nodes?.length || !this.ds || !this.canvas) { return; }
			// Prefer the schema/native node cluster (the nodes that actually
			// carry a DOM card) over the whole graph. Orchestration nodes
			// (react/llm) can live far away in negative coordinates; centering
			// on the *whole* graph then pushes the card-bearing nodes off the
			// 100%-zoom viewport, which reads as "DOM disappeared". Focusing
			// on the card cluster keeps the cards visible at full size.
			const cardNodes = nodes.filter(n => {
				const p = (n.properties ?? {}) as Record<string, unknown>;
				const type = String((n.properties as Record<string, unknown> | undefined)?.['__liteType'] ?? n.type ?? '');
				const spec = getNodeSpec(type);
				return !!spec && (spec.kind === 'schema' || spec.kind === 'native');
			});
			const focus = cardNodes.length ? cardNodes : nodes;
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const n of focus) {
				const x = n.pos[0], y = n.pos[1];
				const w = n.size?.[0] ?? 0, h = n.size?.[1] ?? 0;
				minX = Math.min(minX, x); minY = Math.min(minY, y);
				maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
			}
			// Measure the CSS size of the overlay's coordinate HOST — the canvas
			// container (`.wf-comfy-overlay` is a child with inset:0). The canvas
			// backing store lags behind (505px vs CSS 827px) and its clientWidth
			// reads stale right after init; the container's getBoundingClientRect
			// is the live CSS size the overlay layer actually spans. Using the
			// canvas here produced an offset that placed cards off-screen.
			const hostRect = this.canvas.parentElement?.getBoundingClientRect?.() ?? this.canvas.getBoundingClientRect?.();
			const cw = hostRect?.width || this.canvas.clientWidth || 800;
			const ch = hostRect?.height || this.canvas.clientHeight || 600;
			// Fit the CARD cluster into the viewport (ComfyUI behavior), with a
			// 0.35 floor. The card cluster is genuinely spread out (e.g. 1835px
			// wide in a 827px viewport → fitScale ≈ 0.41); fitting it guarantees
			// ALL card-bearing nodes are visible on load. The user zooms in for
			// fine detail. The earlier "fixed scale=1" left 3 of 4 cards
			// off-screen (spread 1835px > viewport 827px) — that was the real
			// "DOM disappeared" symptom.
			const PAD = 80;
			const fitScale = Math.min(
				(cw - PAD) / Math.max(1, maxX - minX),
				(ch - PAD) / Math.max(1, maxY - minY),
			);
			const scale = Math.max(0.35, Math.min(1, fitScale));
			this.ds.scale = scale;
			const cx = (minX + maxX) / 2;
			const cy = (minY + maxY) / 2;
			this.ds.offset[0] = cw / (2 * scale) - cx;
			this.ds.offset[1] = ch / (2 * scale) - cy;
			this.setDirty?.(true, true);
			};
	}
	zoomToFitPatched = true;
}

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

/** Register Saros node classes onto the LiteGraph singleton (idempotent). */
function ensureSarosRegistration(): void {
	if (sarosRegistered) { return; }
	registerSarosNodes();
	registerSarosLiteGraphNodes();
	// ComfyTV schema stages MUST be registered before the first
	// `syncStoreToGraph()` runs (same effect, a few lines below). React runs
	// child effects before parent effects, so WorkflowEditorPanel's
	// `registerDefaultComfyTVStages()` (parent effect) executes AFTER this
	// child effect — meaning the first configure() would filter out every
	// ComfyTV schema node (`getNodeSpec` returns undefined), and their DOM
	// cards would never mount. Registering the defaults here guarantees the
	// registry is warm before the graph is first built. The parent still
	// re-registers (idempotent).
	registerDefaultComfyTVStages();
	patchZoomToFit();

	// Cross-layer connection gate (P1 — see doc/workflow-pipeline-fusion-design.md).
	// LiteGraph's own `isValidConnection` only sees port *types*, not node *kinds*,
	// so an orchestration node (react/llm) could otherwise link directly to a media
	// node (native). Patch `LGraphNode.prototype.connect` to reject cross-layer
	// links before they form. Runs once (idempotent via sarosRegistered).
	if (!crossLayerGatePatched) {
		const origConnect = LGraphNode.prototype.connect;
		LGraphNode.prototype.connect = function (
			this: { type?: unknown; connect: typeof LGraphNode.prototype.connect },
			slot: unknown,
			targetNode: { type?: unknown } | undefined,
			targetSlot: unknown,
		) {
			const srcSpec = getNodeSpec(String(this.type ?? ''));
			const dstSpec = getNodeSpec(String(targetNode?.type ?? ''));
			if (srcSpec && dstSpec && !canConnectLayers(srcSpec.kind, dstSpec.kind)) {
				// Reject silently (matches isValidConnection's return-null contract).
				return null;
			}
			return origConnect.call(this, slot, targetNode, targetSlot);
		};
		crossLayerGatePatched = true;
	}

	sarosRegistered = true;
}

export interface LiteGraphCanvasHandle {
	/** Parse + import a ComfyUI GUI workflow into the graph. Returns issues list. */
	importComfyWorkflow(raw: unknown): string[];
	/** Export the current graph as a ComfyUI API /prompt payload. */
	exportApi(): ComfyGuiWorkflow | null;
	/** Access the media snapshot store (for NodeEditorPopup). */
	snapshotStore(): MediaSnapshotStore | null;
	/**
	 * nodeId（`__sarosId`）→ 快照归档键（stageUid）。
	 *
	 * ★ 运行链路（单节点 Run / 全图 Run / 双击弹窗）必须用它把归档键统一到
	 *   stageUid：卡片读侧就是 stageUid，写 nodeId 会导致「跑成功但 OUTPUT
	 *   不刷新」。上游 id 同样要过一遍（`store.byNode` 查的是归档键）。
	 *   幂等：内部走 `claimStageUid`，节点尚无 uid 时就地生成并写入 properties。
	 */
	stageUidOf(nodeId: string): string | undefined;
	/**
	 * 选中并把某节点滚到视口中心（不改缩放）。
	 * 用于「代码投影 → 画布」定位：点脚本行高亮对应画布节点。
	 * 返回 false = 图上没有该 nodeId（画布未就绪或节点已删）。
	 */
	revealNode(nodeId: string): boolean;
	/** Execution-state store driving card run button / progress / error / output. */
	cardStateStore(): CardStateStore;
	/** Remove a group from the graph (nodes keep their positions). */
	removeGroup(group: LGraphGroup): void;
	/** P2: currently selected nodes (LiteGraph lc.selected_nodes), mapped to
	 *  { sarosId, type, data } for Subflow wrapping. */
	getSelectedNodes(): Array<{ id: string; type: string; data: Record<string, unknown> }>;
	/** Reset the canvas pan/zoom to the origin (canvas right-click "Reset View"). */
	resetView(): void;
	/** Clone a node by its LiteGraph numeric id (canvas node menu "Clone"). */
	cloneNode(nodeId: number): void;
	/** Remove a connection by its LiteGraph link id (link menu "Disconnect"). */
	removeLink(linkId: number): void;
	/** Snap all selected nodes to the 8px grid (canvas menu "Align"). */
	alignSelected(): void;
	/**
	 * W6: 执行路径可视化——两端都在 ran 的连线标绿（激活路径），target 在
	 * skipped 的连线置灰（gate 分支未激活）；其余恢复默认色。传空数组清除。
	 */
	markRouteEdges(ranIds: string[], skippedIds: string[]): void;
	/** Create an empty group at a graph position (canvas menu "Add Group"). */
	addGroupAt(graphX: number, graphY: number): void;
	/** Paste the internal clipboard at the mouse position (canvas menu "Paste"). */
	pasteFromClipboard(): void;
	/** Underlying LiteGraph canvas instance (for coordinate conversion, etc.). */
	canvasInstance(): LGraphCanvas | null;
	/**
	 * FollowCursor ghost 落位：进入「待放置」模式，节点以半透明矩形跟随光标，
	 * 点击画布才真正 `store.addNode`。graphX/graphY 为初始位置（缺省画布中心）。
	 * 对齐 ComfyUI `Comfy.NodeSearchBoxImpl.FollowCursor`（默认开）。
	 */
	beginGhostPlace(type: string, graphX?: number, graphY?: number): void;
	/** 取消 ghost 落位（Esc / 右键）。 */
	cancelGhostPlace(): void;
}

interface LiteGraphCanvasProps {
	className?: string;
	style?: React.CSSProperties;
	/** nodeId (logical __sarosId) + LiteGraph node type (e.g. "ComfyTV.ImageStage") */
	onNodeDoubleClick?: (nodeId: string, nodeType: string) => void;
	/** Card ▶ run button (`wf-node-run`). Kept separate from double-click:
	 *  double-click opens the editor; the card button executes the node.
	 *  `stageUid` 是快照归档键（见 stageIdentity）：run 链路必须用它而非 nodeId
	 *  写快照，否则写 nodeId、读 stageUid，OUTPUT 永远不刷新。 */
	onNodeRun?: (nodeId: string, nodeType: string, stageUid?: string) => void;
	/** Namespaces the persistent media-snapshot backend per workflow, so node
	 *  keys (`n1:image:0`) don't collide across workflow tabs. */
	workflowId?: string;
	/** Right-click on the canvas → open the node menu at the clicked graph position. */
	onCanvasContextMenu?: (graphX: number, graphY: number, clientX: number, clientY: number) => void;
	/** Right-click on a group → open the group menu. */
	onGroupContextMenu?: (group: LGraphGroup, graphX: number, graphY: number, clientX: number, clientY: number) => void;
	/** Right-click on a node → open the node actions menu (M1). The node is
	 *  selected first (right-click-to-select, aligned with ComfyUI). */
	onNodeContextMenu?: (node: LGraphNode, graphX: number, graphY: number, clientX: number, clientY: number) => void;
	/** Right-click on a connection link → open the link menu (disconnect). */
	onLinkContextMenu?: (link: LLink, graphX: number, graphY: number, clientX: number, clientY: number) => void;
	/** Ctrl+Enter on the canvas → run the workflow (ComfyUI "Queue prompt"). */
	onRequestRun?: () => void;
	/** Double-click on empty canvas → open the node search box (ComfyUI-style). */
	onCanvasDoubleClick?: (graphX: number, graphY: number, clientX: number, clientY: number) => void;
}

// ── Media auto-collect (P1) ─────────────────────────────────────────────
// Dedupes by workflow + ref: each distinct produced media URL is imported
// into the host media library exactly once per session. blob: URLs are
// session-transient and skipped. Pure decision logic lives in
// comfyHost/mediaCollect.ts (unit-tested); this function only performs the
// side effect (mediaImport IPC).
const collectedAssetKeys = new Set<string>();
function collectAsset(workflowId: string, entry: MediaSnapshotEntry): void {
	const decision = shouldCollectMedia(workflowId, entry.media.ref, collectedAssetKeys);
	if (!decision) { return; }
	collectedAssetKeys.add(decision.key);
	// Generated results arrive as self-contained data: URLs (runStageWorkflow
	// materializes ComfyUI /view refs). Passing that as `ref` means "index
	// only, do not persist" — the host would stuff megabytes of base64 into
	// the SQLite ref column and never write a file, so the library showed
	// entries with no saved image. Decode it and hand over `base64` + `ext`
	// so MediaStore.importAsset mirrors it into the media directory.
	const parsed = parseDataUrl(entry.media.ref);
	const req = parsed
		? {
			base64: parsed.base64,
			ext: parsed.ext,
			mime: parsed.mime,
			kind: entry.media.kind,
			workflowId: workflowId || undefined,
			nodeId: entry.nodeId,
			provider: decision.provider,
		}
		: {
			ref: entry.media.ref,
			kind: entry.media.kind,
			workflowId: workflowId || undefined,
			nodeId: entry.nodeId,
			provider: decision.provider,
		};
	void mediaImport(req).catch(() => {
		// Allow a later run to retry instead of silently dropping the asset.
		collectedAssetKeys.delete(decision.key);
	});
}

export const LiteGraphCanvas = React.forwardRef<LiteGraphCanvasHandle, LiteGraphCanvasProps>(
	function LiteGraphCanvas({ className, style, onNodeDoubleClick, onNodeRun, onCanvasContextMenu, onGroupContextMenu, onNodeContextMenu, onRequestRun, onCanvasDoubleClick, workflowId }: LiteGraphCanvasProps, ref): React.JSX.Element {
	const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
	const graphRef = React.useRef<LGraph | null>(null);
	const canvasInstanceRef = React.useRef<LGraphCanvas | null>(null);
	const containerRef = React.useRef<HTMLDivElement | null>(null);
	const minimapRef = React.useRef<HTMLCanvasElement | null>(null);
	/** 连线松手弹出的「可连接节点列表」菜单状态。null = 不显示。 */
	const [connMenu, setConnMenu] = React.useState<{
		anchor: { x: number; y: number };
		items: CompatibleNodeItem[];
		ctx: {
			srcNodeId: string;
			srcPort: string;
			srcPortType: string;
			connectingTo: 'input' | 'output';
			graphX: number;
			graphY: number;
		};
	} | null>(null);
	/**
	 * FollowCursor ghost 落位（对齐 ComfyUI `Comfy.NodeSearchBoxImpl.FollowCursor`）：
	 * 搜索浮窗选中节点后**不立即落位**，节点以半透明 ghost 矩形跟随光标，点击画布才
	 * 落位。x/y = graph 坐标（节点左上角），null = 不在 ghost 模式。
	 */
	const [ghost, setGhost] = React.useState<{ type: string; x: number; y: number } | null>(null);
	const suppressStoreSync = React.useRef(false);
	const snapshotStoreRef = React.useRef<MediaSnapshotStore | null>(null);
	/** 已完成 nodeId → stageUid 快照迁移的 uid 集合（每节点只迁一次）。 */
	const migratedUidsRef = React.useRef<Set<string>>(new Set());
	// ⚠ `workflowId` 由 zustand 的 `loadWorkflow()` **异步**填充，首帧为空；而下面的
	// snapshot store 只在首帧惰性创建一次。若 `onAsset` 直接闭包捕获 `workflowId`，
	// 它会被永久冻结在初始空值上 —— 于是每个自动收集的资产写进 media.db 时
	// `workflow_id = NULL`，而媒体库「当前工作流」过滤是 `WHERE workflow_id = ?`，
	// 永远匹配不到（表现：图片确实落盘了，但媒体库一片空白）。
	// 用每帧更新的 ref 读实时值。
	const workflowIdRef = React.useRef(workflowId);
	workflowIdRef.current = workflowId;
	if (!snapshotStoreRef.current) {
		// P0 persistence: refs live in IndexedDB (namespaced per workflow) so
		// generated-image previews survive a tab refresh. The persistent store
		// never evicts — the persisted refs ARE the history. hydrate() restores
		// them asynchronously; cards re-render once the refs come back.
		const dbName = workflowId ? `vssaros-media-${workflowId}` : 'vssaros-media';
		snapshotStoreRef.current = new MediaSnapshotStore(
			createIndexedDBBackend({ dbName }),
			{
				persistent: true,
				// P1 auto-collect: every produced media ref is also indexed in
				// the host media library (media.db), so the gallery shows the
				// workflow's generated images even before a manual "save".
				onAsset: (entry) => {
					if (entry.media.kind !== 'image') { return; }
					collectAsset(workflowIdRef.current ?? '', entry);
				},
			},
		);
		void snapshotStoreRef.current.hydrate();
		// M2 dynamic workflow bridge: register this store as an answerable
		// snapshot source for host-side nodeOutput() queries / SAROS_JSON archives.
		registerSnapshotSource(workflowId ?? 'default', snapshotStoreRef.current);
	}
	// Store identity follows the workflow: re-register when workflowId changes
	// (the store itself is recreated per dbName in that case by the block above).
	React.useEffect(() => {
		if (snapshotStoreRef.current) {
			registerSnapshotSource(workflowId ?? 'default', snapshotStoreRef.current);
		}
		return () => unregisterSnapshotSource(workflowId ?? 'default');
	}, [workflowId]);
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
		let resizeFitTimer: ReturnType<typeof setTimeout> | undefined;

		ensureSarosRegistration();
		// Type-aware connection validation (image→image, text→text, ANY wildcard).
		LiteGraph.isValidConnection = isValidLiteGraphConnection;
		// ★ 交互约定对齐 ComfyUI 默认（legacy 模式，源自 ComfyUI 前端 settingStore：
		//   `canvasNavigationMode='legacy'` + `leftMouseClickBehavior='panning'`）：
		//   左键拖空白 = 平移；ctrl/meta+左键 = 框选；左键拖节点 = 移动；滚轮 = 缩放。
		//   不设 canvasNavigationMode（保持 LiteGraph 默认 "legacy"）。
		const graph = new LGraph();
		const liteCanvas = new LGraphCanvas(canvas, graph);
		// Suppress LiteGraph's native context menu ("Add Node" / "Add Group").
		// We render our own React-based right-click menu (NodeActionsMenu).
		// Without this override, processMouseDown registers pointer.onClick which
		// fires processContextMenu on pointerup → creates a .litecontextmenu DOM
		// that races with our React onContextMenu handler (closeAllContextMenus
		// can lose the race → two menus appear simultaneously).
		liteCanvas.processContextMenu = function (_node?: LGraphNode, _event?: unknown): void {
			/* no-op — handled by React onContextMenu */
		};

		// ⚠️ 死代码（2026-08-19 确认）：下面这个 `liteCanvas.processMouseDown` override
		// **从未生效** —— LGraphCanvas 构造函数（new LGraphCanvas → setCanvas →
		// bindEvents）里 `this._mousedown_callback = this.processMouseDown.bind(this)`
		// 已把「原始」processMouseDown 固定进 canvas 的 pointerdown listener，此处对
		// `liteCanvas.processMouseDown` 的赋值不影响已 bind 的 callback（区别于
		// processContextMenu，后者是运行时 `pointer.onClick ??= () => this.processContextMenu`
		// 读取，override 才生效）。
		// 框选（ctrl/meta+左键）实际由 LiteGraph **原生** `#processPrimaryButton →
		// #setupNodeSelectionDrag` 处理（canvasNavigationMode 默认 "legacy"）。
		// 此前「无法框选」的真因是下方 dragPointerDown 在 container capture 阶段
		// stopPropagation 拦死了原生 pointerdown（已修：ctrl 框选意图不拦截）。
		// 保留此段仅为兼容性兜底，勿据其注释理解框选实现。
		const lc = liteCanvas as unknown as {
			adjustMouseEvent(e: MouseEvent): void;
			getNodeOnPos(x: number, y: number): unknown;
			pointer: {
				down(e: MouseEvent): void;
				onClick?: (e: MouseEvent) => void;
				onDragStart?: () => void;
				onDragEnd?: (e: MouseEvent) => void;
				finally?: () => void;
			};
			dragging_rectangle: Float32Array | null;
			processSelect(item: unknown, e: MouseEvent): void;
			select(item: unknown): void;
			deselect(item: unknown): void;
			selectedItems: Set<unknown>;
			selected_nodes: Record<string, unknown>;
			onSelectionChange?: (sel: unknown) => void;
			graph: { _nodes: Array<{ boundingRect?: Float32Array }>; groups?: Array<{ _bounding?: Float32Array; recomputeInsideNodes?: () => void }> };
		};
		const rectsOverlap = (a: Float32Array, b: Float32Array): boolean =>
			a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
		const containsRect = (a: Float32Array, b: Float32Array): boolean =>
			a[0] <= b[0] && a[0] + a[2] >= b[0] + b[2] && a[1] <= b[1] && a[1] + a[3] >= b[1] + b[3];
		const selectInRect = (ev: MouseEvent, dragRect: Float32Array): void => {
			const w = Math.abs(dragRect[2]);
			const h = Math.abs(dragRect[3]);
			if (dragRect[2] < 0) dragRect[0] -= w;
			if (dragRect[3] < 0) dragRect[1] -= h;
			dragRect[2] = w;
			dragRect[3] = h;
			const hit: unknown[] = [];
			for (const node of lc.graph._nodes) {
				if (node?.boundingRect && rectsOverlap(dragRect, node.boundingRect)) hit.push(node);
			}
			for (const group of lc.graph.groups ?? []) {
				if (group._bounding && containsRect(dragRect, group._bounding)) {
					group.recomputeInsideNodes?.();
					hit.push(group);
				}
			}
			if (ev.shiftKey) {
				for (const item of hit) lc.select(item);
			} else if (ev.altKey) {
				for (const item of hit) lc.deselect(item);
			} else {
				for (const item of lc.selectedItems) if (!hit.includes(item)) lc.deselect(item);
				for (const item of hit) lc.select(item);
			}
			lc.onSelectionChange?.(lc.selected_nodes);
		};
		const origProcessMouseDown = liteCanvas.processMouseDown.bind(liteCanvas);
		liteCanvas.processMouseDown = function (e: MouseEvent): void {
			const ctrlOrMeta = e.ctrlKey || e.metaKey;
			if (ctrlOrMeta && !e.altKey && e.button === 0) {
				lc.adjustMouseEvent(e);
				const node = lc.getNodeOnPos((e as MouseEvent & { canvasX: number }).canvasX, (e as MouseEvent & { canvasY: number }).canvasY);
				// 仅空白处：节点上的 ctrl 框选由 LiteGraph 原生 setupNodeSelectionDrag 处理
				if (!node) {
					lc.pointer.down(e);
					const dragRect = new Float32Array(4);
					dragRect[0] = (e as MouseEvent & { canvasX: number }).canvasX;
					dragRect[1] = (e as MouseEvent & { canvasY: number }).canvasY;
					dragRect[2] = 1;
					dragRect[3] = 1;
					lc.pointer.onClick = (eUp) => lc.processSelect(null, eUp);
					lc.pointer.onDragStart = () => { lc.dragging_rectangle = dragRect; };
					lc.pointer.onDragEnd = (upEvent) => {
						selectInRect(upEvent, dragRect);
						lc.dragging_rectangle = null;
					};
					lc.pointer.finally = () => { lc.dragging_rectangle = null; };
					return;
				}
			}
			return origProcessMouseDown(e);
		};

		// ComfyUI-style connections: yellow, slightly thicker. (P0 visual parity —
		// deeper node / widget restyle (rounded backdrop, ⌄ caret, output type
		// chips) is a larger undertaking and tracked as a follow-up.)
		(liteCanvas as unknown as { connectionColor: string }).connectionColor = '#c0a000';
		(liteCanvas as unknown as { linkColor: string }).linkColor = '#c0a000';
		(liteCanvas as unknown as { link_width: number }).link_width = 2;
		// Replace LiteGraph's floating `.graphdialog` prompt with an in-place DOM
		// input overlay over the widget itself (ComfyUI-style inline editing).
		patchInlineWidgetEditor(liteCanvas as unknown as Parameters<typeof patchInlineWidgetEditor>[0]);
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
			// Re-center the card cluster when the panel is resized. The overlay
			// spans the container (inset:0), so offset/scale must be recomputed
			// against the NEW container size — otherwise a narrower/wider panel
			// leaves cards off-screen again ("DOM disappeared" on resize).
			// Debounced to the resize settle so we don't fight the layout.
			if (resizeFitTimer) { clearTimeout(resizeFitTimer); }
			resizeFitTimer = setTimeout(() => {
				(canvasInstanceRef.current as any)?.zoomToFit?.();
			}, 80);
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
		// ── ComfyUI legacy 平移状态（空白处左键拖拽 → pan）──
		let panRef: { startClientX: number; startClientY: number; startOffsetX: number; startOffsetY: number } | null = null;
		const panPointerMove = (e: PointerEvent) => {
			if (!panRef) { return; }
			const dx = (e.clientX - panRef.startClientX) / liteCanvas.ds.scale;
			const dy = (e.clientY - panRef.startClientY) / liteCanvas.ds.scale;
			liteCanvas.ds.offset[0] = panRef.startOffsetX + dx;
			liteCanvas.ds.offset[1] = panRef.startOffsetY + dy;
			liteCanvas.setDirty?.(true, true);
		};
		const panPointerUp = () => {
			panRef = null;
		};
		// 挂到 container 的 capture phase 后，事件 target 可能是 DOM 卡片内的
		// input/select/textarea/button —— 这些必须让用户正常交互，不能进入
		// 节点拖拽逻辑（否则用户改 batch_size 时节点被拖走）。
		const isInteractiveTarget = (t: EventTarget | null): boolean => {
			if (!(t instanceof HTMLElement)) { return false; }
			const tag = t.tagName;
			if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') { return true; }
			if (t.isContentEditable) { return true; }
			// 笔刷/绘画类 <canvas>（如 MaskPainter 的擦除笔刷）：自身处理 pointer
			// 拖拽绘制，必须跳过节点拖拽，否则笔刷拖拽会与节点移动冲突。
			if (t instanceof HTMLCanvasElement && t.getAttribute('data-no-node-drag') === 'true') { return true; }
			// WF-node-action / wf-node-control 派生的可点击容器（含 cursor:pointer）
			if (t.style.cursor === 'pointer' || t.getAttribute('role') === 'button') { return true; }
			return false;
		};
		const dragPointerDown = (e: PointerEvent) => {
			if (e.button !== 0) { return; }
			// target 是可交互控件（input/select/textarea/button）→ 让控件处理，不抢拖拽
			if (isInteractiveTarget(e.target)) { return; }
			// ★ ctrl/meta + 左键 = 框选（ComfyUI legacy 原生 rubber-band 多选），
			//   不是平移/节点拖拽。本 listener 挂在 container **capture** phase，
			//   先于 LiteGraph 的 processMouseDown（canvas capture）触发。框选意图
			//   一律**不拦截**，让事件继续传给 LiteGraph 原生
			//   #processPrimaryButton → #setupNodeSelectionDrag（条件
			//   ctrlOrMeta && !altKey && leftMouseClickBehavior==='panning'）。
			if ((e.ctrlKey || e.metaKey) && !e.altKey) {
				dragRef = null;
				return;
			}
			const rect = canvas.getBoundingClientRect();
			const cx = (e.clientX - rect.left) / liteCanvas.ds.scale - liteCanvas.ds.offset[0];
			const cy = (e.clientY - rect.top) / liteCanvas.ds.scale - liteCanvas.ds.offset[1];
			const hit = graph.getNodeOnPos(cx, cy);

			// ── ComfyUI legacy：左键拖空白 = 平移画布（自定义 panRef，绕过
			//    LiteGraph 原生 dragging_canvas，因 DOM overlay 层挡 hit-test）──
			if (!hit) {
				dragRef = null;
				e.stopPropagation();
				e.preventDefault();
				container.setPointerCapture(e.pointerId);
				panRef = {
					startClientX: e.clientX,
					startClientY: e.clientY,
					startOffsetX: liteCanvas.ds.offset[0],
					startOffsetY: liteCanvas.ds.offset[1],
				};
				return;
			}
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
			// eslint-disable-next-line no-console
			console.warn('[dragDown] dragRef SET, origPos=', dragRef.origPos);
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
			// 关键：拖拽期间只 setDirty 重绘，**不调 graph.change()**。graph.change()
			// 会触发 on_change → syncGraphToStore → store→graph 的 syncStoreToGraph
			// → configure() 重建全部节点，销毁 dragRef.node → 后续 move 更新旧对象
			// 无效 → 节点「拖不动」。改为纯重绘，结束时在 dragPointerUp 里同步一次。
			liteCanvas.setDirty?.(true, true);
		};
		const dragPointerUp = (e?: Event) => {
			if (!dragRef) { return; }
			if (dragRef?.graphBefore) {
				graph.afterChange(dragRef.node);
			}
			const hadDrag = dragRef !== null;
			dragRef = null;
			try {
				// e may be missing for losepointercapture / safety fallbacks
				if (e && 'pointerId' in e) {
					container.releasePointerCapture((e as PointerEvent).pointerId);
				} else {
					// Best-effort: release any active capture without knowing the id.
					// Browsers silently ignore if no capture is active.
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(container as any).releasePointerCapture?.(-1);
				}
			} catch { /* already released or never captured */ }
			// 拖拽结束后手动回写 store 一次（最终位置），触发 store→graph 的
			// syncStoreToGraph 使 DOM 卡片对齐新位置。
			if (hadDrag) {
				graph.change();
			}
		};
		// 改挂到 container 的 capture phase：DOM 卡片层 (wf-comfy-overlay) 是 container
		// 的子元素，且卡片内部 input/select 等子元素有 `pointer-events:auto`。如果
		// 用户点击点正好落在这些元素之上（hit-test 命中 button 而非 canvas），挂在
		// canvas 上的 bubble listener 收不到事件 → dragRef 永远不设置 → 节点拖不动。
		// container 是它们的公共祖先，capture phase 不受 hit-test 影响，能稳定触发。
		container.addEventListener('pointerdown', dragPointerDown, { capture: true });

		// ── Critical fix for Bug #2 (node drag never stops) ──────────────────
		// pointerdown 在 container capture phase 调了 stopPropagation() +
		// setPointerCapture(container)。如果 pointerup 只挂在 window (bubble)，
		// 实测在某些情况下事件链被截断导致 up 丢失 → dragRef 永不清除 → 节点
		// "粘在鼠标上"。修复：同时在 container (capture) 和 window (bubble) 各挂
		// 一份 up/cancel，外加 losepointercapture 兜底，三重保险确保清除。
		container.addEventListener('pointerup', dragPointerUp, { capture: true });
		container.addEventListener('pointercancel', dragPointerUp, { capture: true });
		container.addEventListener('losepointercapture', dragPointerUp);
		// Also keep window listeners for drags that leave the container area.
		window.addEventListener('pointermove', dragPointerMove);
		window.addEventListener('pointerup', dragPointerUp);
		window.addEventListener('pointercancel', dragPointerUp);

		// ComfyUI legacy 平移 listeners（仅 panRef 激活时生效；跨 container 区域仍平移）。
		window.addEventListener('pointermove', panPointerMove);
		window.addEventListener('pointerup', panPointerUp);
		window.addEventListener('pointercancel', panPointerUp);

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
				case 'fit': (lc as any).zoomToFit?.(); break;
				case 'run': onRequestRunRef.current?.(); break;
			}
			g.change();
		};
		container.addEventListener('keydown', handleKeyDown);

		graphRef.current = graph;
		canvasInstanceRef.current = liteCanvas;

		// ── 连线松手空白处 → 弹出「可连接节点列表」菜单（对齐 ComfyUI/ComfyTV）──
		// 关闭 LiteGraph 内置搜索框（我们用自己的 React 菜单以保证 UI 一致性）。
		(LiteGraph as unknown as { release_link_on_empty_shows_menu: boolean }).release_link_on_empty_shows_menu = false;
		const lcEvents = (liteCanvas.linkConnector as unknown as {
			events: { addEventListener: (t: string, cb: (e: unknown) => void) => void; removeEventListener: (t: string, cb: (e: unknown) => void) => void };
		}).events;
		const onLinkDroppedOnCanvas = (e: unknown) => {
			// LiteGraph 的 CustomEventTarget.dispatch(type, detail) 用
			// new CustomEvent(type, { detail }) 派发 → 监听器收到的是 CustomEvent，
			// 真正的 CanvasPointerEvent 在 e.detail 里（含 clientX/clientY + graph 空间的 canvasX/canvasY）。
			const pe = (e as CustomEvent).detail as (PointerEvent & { canvasX?: number; canvasY?: number });
			console.warn('[LinkDrop] dropped-on-canvas fired', { connectingTo: (liteCanvas.linkConnector as { state: { connectingTo: unknown } }).state.connectingTo, hasClientX: typeof pe?.clientX === 'number', clientX: pe?.clientX, clientY: pe?.clientY });
			const connector = liteCanvas.linkConnector as unknown as {
				state: { connectingTo: 'input' | 'output' | undefined };
				renderLinks: Array<{ node: LGraphNode; fromSlot: { name: string; type: string | number }; fromSlotIndex: number }>;
			};
			const connectingTo = connector.state.connectingTo;
			const firstLink = connector.renderLinks?.[0];
			if (!connectingTo || !firstLink?.node || !pe) {
				console.warn('[LinkDrop] bail: no connectingTo/renderLink/pe', { connectingTo, hasFirstLink: !!firstLink, hasNode: !!firstLink?.node });
				return;
			}
			const srcNode = firstLink.node as unknown as { properties?: { __sarosId?: string }; id: number };
			const srcId = srcNode.properties?.__sarosId ?? String(srcNode.id);
			// 源端口信息直接从 renderLink.fromSlot 取（对齐 LiteGraph 官方 showSearchBox 逻辑）。
			const srcPort = firstLink.fromSlot.name;
			const srcType = String(firstLink.fromSlot.type);
			console.warn('[LinkDrop] source', { srcId, srcPort, srcType, connectingTo });
			// 计算兼容节点（端口类型匹配）
			const specs = getAllSpecs();
			const items: CompatibleNodeItem[] = [];
			for (const spec of specs) {
				if (connectingTo === 'input') {
					const inPort = spec.inputs?.find(p => isPortTypeCompatible(srcType, p.type));
					if (inPort) {
						items.push({ type: spec.type, title: spec.title, category: spec.category, portName: inPort.name, portType: inPort.type });
					}
				} else {
					const outPort = spec.outputs?.find(p => isPortTypeCompatible(p.type, srcType));
					if (outPort) {
						items.push({ type: spec.type, title: spec.title, category: spec.category, portName: outPort.name, portType: outPort.type });
					}
				}
			}
			console.warn('[LinkDrop] compatible items', { count: items.length, totalSpecs: specs.length });
			if (items.length === 0) { return; }
			// 屏幕坐标 → 容器相对坐标（菜单锚点）
			const rect = container.getBoundingClientRect();
			const ax = pe.clientX - rect.left;
			const ay = pe.clientY - rect.top;
			// 落点 graph 坐标（用于新建节点）：优先用 LiteGraph ship 的 canvasX/canvasY
			const ds = liteCanvas.ds;
			const gx = typeof pe.canvasX === 'number' ? pe.canvasX : (pe.clientX - rect.left) / ds.scale - ds.offset[0];
			const gy = typeof pe.canvasY === 'number' ? pe.canvasY : (pe.clientY - rect.top) / ds.scale - ds.offset[1];
			setConnMenu({ anchor: { x: ax, y: ay }, items, ctx: { srcNodeId: srcId, srcPort, srcPortType: srcType, connectingTo, graphX: gx, graphY: gy } });
		};
		lcEvents.addEventListener('dropped-on-canvas', onLinkDroppedOnCanvas);

		// selection → store
		liteCanvas.onNodeDeselected = () => {
			storeApi.getState().setSelectedNode(null);
		};

		// graph change → store (debounced)
		graph.on_change = () => {
			if (suppressStoreSync.current) { return; }
			// 拖拽期间（dragRef 非空）不回写 store：回写会触发 store→graph 的
			// syncStoreToGraph → configure() 重建全部节点，导致 dragRef.node 指向
			// 已销毁的旧节点对象 → dragPointerMove 更新无效 → 节点「拖不动」。
			// 拖拽结束时 dragPointerUp 会手动同步一次最终位置。
			if (dragRef) { return; }
			// do the store sync on next tick to coalesce drag updates
			window.setTimeout(() => syncGraphToStore(graph, storeApi.getState().setNodes, storeApi.getState().setEdges), 0);
		};

		liteCanvas.startRendering();
		// initial load from store
		syncStoreToGraph(graph, storeApi.getState().nodes, storeApi.getState().edges, undefined, liteCanvas);
		// Auto-fit after first load so nodes at negative graph coordinates (dragged
		// above the origin) are pulled into view — otherwise their DOM cards sit
		// off-screen and read as "DOM disappeared". Double-rAF: the first frame
		// lets React commit the canvas element, the second ensures the canvas has
		// a non-zero layout (clientWidth/Height measured inside zoomToFit were
		// reading a stale 507px on the first frame — the "一闪消失" root cause).
		requestAnimationFrame(() => {
			requestAnimationFrame(() => canvasInstanceRef.current?.zoomToFit?.());
		});

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
		// Last self-heal remount timestamp per node (cooldown against render-error loops).
		const cardRemountAt = new Map<string, number>();
		// Grace-period counter for "seen is empty" → suppress transient bulk
		// unmounts caused by syncStoreToGraph → graph.configure() → graph.clear()
		// creating a one-frame window where graph.nodes is empty. Without
		// grace, every store→graph sync would unmount+remount *all* DOM cards,
		// which both thrashes React and (with React 18 concurrent rendering)
		// occasionally fails to remount — producing the "frequent DOM cards
		// disappearing" symptom. After 1 frame of genuine emptiness we
		// accept that the graph really has no nodes and proceed with unmount.
		let emptySeenStreak = 0;
		let overlayRaf = 0;
		// ── 层级：完全对齐 ComfyUI（getDomWidgetZIndex + useDomClipping）────────
		// ① 层序 = `graph.nodes.indexOf(node)` → 写进容器的 CSS z-index
		//    （overlay layer 有 isolation:isolate，同一 stacking context 内可靠），
		//    与 LiteGraph 画 canvas 的顺序同源（bringToFront 把节点移到数组末尾）。
		// ② canvas 与 DOM 是两个合成层、无法交错层叠 → 对每个卡片用 clip-path
		//    挖掉所有层级更高节点的 renderArea（widgetBridge 内做），这样上层节点的
		//    canvas 标题栏/背景不会被下层 DOM 卡片盖住。
		// ComfyUI 既不重排 DOM 顺序，也没有 hover 提升 —— 这里同样都不做。
		// DOM 顺序只在 canvasIdx 序列真正变化时同步一次（纯兜底，避免每帧 reflow）。
		let lastOrderSignature = '';
		const containerOrder: Array<{ id: string; container: HTMLElement; canvasIdx: number }> = [];
		const syncOverlay = () => {
			overlayRaf = requestAnimationFrame(syncOverlay);
			const g = graphRef.current;
			const lc = canvasInstanceRef.current;
			if (!g || !lc) { return; }
			const ds = lc.ds;
			const nodesForSync: OverlayNode[] = [];
			const seen = new Set<string>();
			containerOrder.length = 0;
			// 层序完全跟随 `g._nodes` 下标（canvasIdx）。**不做 hover 提升**：
			// canvas 侧的绘制顺序不会因 hover 变化，DOM 侧一旦提升就与 canvas 失配，
			// 这正是此前"非 hover 正常、hover 时穿插"的根因（ComfyUI 也没有 hover 提升）。
		const selectedIds = new Set<string>();
		// `selected_nodes` lives on LGraphCanvas (NOT on LGraph — reading
		// g.selected_nodes yields undefined and the selection ring never
		// renders). The per-node `selected` flag is checked in the loop below
		// as a second source of truth.
		for (const k of Object.keys(lc.selected_nodes ?? {})) {
			const n = g.getNodeById(k);
			if (!n) { continue; }
			const p = (n.properties ?? {}) as Record<string, unknown>;
			selectedIds.add(String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? n.id));
		}
			// ── Deferred height fixes (applied AFTER bridge.sync below) ────
			// We must measure BEFORE sync (need auto/visible on the raw container)
			// but APPLY the fix AFTER sync (otherwise bridge.sync overwrites the
			// container height back to the stale widgetRect.height). See #57.
			const deferredHeightFixes: Array<{ node: typeof graph._nodes[0]; h: number }> = [];
			// ── 遮挡源：graph 中**全部**节点（含没有 DOM 卡片的）─────────────
			// Bug：Saros agent / 提示词节点（spec.kind 为 react / llm，参数直接画在
			// canvas 上）以及折叠节点都会在下面的循环里被 `continue` 跳过，从不进入
			// nodesForSync。而 overlay 整层压在 canvas 之上，纯 canvas 绘制的节点
			// 不可能靠 z-index 盖住 DOM 卡片 —— 唯一手段是把它的 renderArea 从
			// 层级更低的卡片里挖掉。此前裁剪清单只由 nodesForSync 构建，于是
			// agent / 提示词节点永远缺席 → 与之重叠的 image stage 卡片始终盖在
			// 它们上面（表现为「层级始终在 image stage 下方」，且拖动/置顶都无效）。
			// 这里独立遍历一次 g.nodes（`get nodes()` 直接返回 `_nodes`，故下标 i
			// 就是 canvasIdx / ComfyUI getDomWidgetZIndex）收集全量遮挡源。
			const occluders: OverlayOccluder[] = [];
			for (let i = 0; i < g.nodes.length; i++) {
				const on = g.nodes[i];
				const oRaw = (on as unknown as { renderArea?: ArrayLike<number> }).renderArea;
				let oArea: ArrayLike<number> | undefined = oRaw && oRaw.length === 4 && (oRaw[2] > 0 || oRaw[3] > 0) ? oRaw : undefined;
				if (!oArea) {
					// renderArea 尚未由 LiteGraph measure 阶段填充：用 pos/size 兜底
					// （标题栏画在 pos[1] 之上，故 y 上移一个标题高度）。
					const ps = (on as unknown as { _posSize?: Float32Array })._posSize;
					const px = ps ? ps[0] : on.pos[0];
					const py = ps ? ps[1] : on.pos[1];
					const pw = (ps ? ps[2] : 0) || on.size[0];
					const ph = (ps ? ps[3] : 0) || on.size[1];
					oArea = [px, py - LITEGRAPH_TITLE_HEIGHT, pw, ph + LITEGRAPH_TITLE_HEIGHT];
				}
				occluders.push({ zIndex: i, renderArea: oArea });
			}
			for (let nodeIdx = 0; nodeIdx < g.nodes.length; nodeIdx++) {
				const n = g.nodes[nodeIdx];
				const props = (n.properties ?? {}) as Record<string, unknown>;
				const nodeId = String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? n.id);
				seen.add(nodeId);
				const type = String(props['__liteType'] ?? n.type ?? '');
				const spec = getNodeSpec(type);
				// ★★ 编排富卡片（Saros.Start/Prompt/Agent/Skill/Tool/IfElse/…）：
				//   这些节点是 `kind:'react'`，**原本会被下面的守卫直接 continue**，
				//   于是完全没有 DOM overlay —— 这是「参数 UI 缺失」多轮未修好的**真因**：
				//   NodeCard 的富卡逻辑、ORCH_RICH 的 formWidget/高度反馈全都写在
				//   continue 之后，属于死代码区，永远执行不到。
				//   现在把它们从守卫里排除，走与 schema 节点相同的 DOM 通路
				//   （canvas widget 已在 sarosLiteGraphNodes 里全部标 hidden，
				//   不会与 DOM 卡双绘）。
				const isOrchRich = ORCH_RICH_NODE_TYPES.has(type);
				// Only ComfyTV (schema) + ComfyUI-native + 编排富卡片节点得到 overlay。
				// 其余 Saros react/llm 节点仍在 canvas 上自绘 widget —— 盖一张不透明
				// 卡片会挡住参数字段与穿过节点的连线（表现为「参数被 UI 挡住」）。
				if (!spec || ((spec.kind === 'react' || spec.kind === 'llm') && !isOrchRich)) {
				// DOM-card "消失" 诊断：spec 未命中时卡片会被跳过（canvas 参数 widget
				// 仍由 arrange() 绘制 → 表现为"参数还在、DOM 卡片消失"）。打点定位。
				if (!spec) {
						// eslint-disable-next-line no-console
						console.warn('[syncOverlay] spec miss ' + JSON.stringify({ nodeId, type, liteType: props['__liteType'], nType: n.type }));
					} else if (type.startsWith('Saros.')) {
						// 编排节点被守卫跳过时打点：定位「某类节点参数 UI 缺失」。
						// 若这里出现 Saros.Agent 等，说明该类型未登记进 ORCH_RICH_NODE_TYPES。
						// eslint-disable-next-line no-console
						console.warn('[syncOverlay] orch node skipped (no DOM card) ' + JSON.stringify({ nodeId, type, kind: spec.kind, isOrchRich }));
					}
				continue;
				}
			// Collapsed nodes have no widget area — LiteGraph compresses them
			// to a thin title bar, so rendering the card at the full body
			// would still show the parameter panel below the title. Skip
			// the overlay entirely; `releaseContainer` removes any stale card.
			if (n.collapsed) {
				bridge.releaseContainer(nodeId);
				cardUnmounts.delete(nodeId);
				clearFormHeightDirty(nodeId);
				continue;
			}
			// fullCover 必须在这里（之前的两个分支都用）声明：原生内嵌编辑器节点
			//（Crop/Rotate/Mirror/Material/…）走的是「fullCover + ensureDomFormWidget」
			// 路径，height feedback 也需要这条开关把它们纳入（之前仅 schema 才能测，
			// 原生节点即使 React 端 markFormHeightDirty 也无人消费 → 高度永远不增长），
			// 否则卡片卡在 100px fallbackY（fallbackY 兜底），控件被截断。
			const nt = n.type ?? '';
			// 端口名/类型是**序列化的实例数据**（constructor 里按 spec 建一次），
			// 改注册表 spec 只影响新建节点，已存在/已存盘的节点会永远停在旧端口名
			//（如 Rotate 的 `input`/`output` 而非 `Image`/`Image`）。这里按帧兜底
			// 纠正；只改名不动槽位数量，连线按下标寻址故不会断。
			if (syncNodePortsToSpec(n as unknown as Parameters<typeof syncNodePortsToSpec>[0])) {
				// 与同文件其余 6 处一致用可选链 —— LGraphCanvas 实例在某些版本下
				// 暴露的是 `setDirtyCanvas`，未对齐的 `setDirty` 直接抛
				// `TypeError: N.setDirty is not a function`，syncOverlay 每帧抛一次
				// 把整个节点 UI 抹掉。
				canvas.setDirty?.(true, true);
			}
			const fullCover = hasStageEditor(nt);
			// ★ 编排富卡片：卡片里有 DOM 参数控件（provider/model/agent 下拉 +
			//   prompt textarea，复用 ImageStage 那套组件），必须和 schema 节点一样
			//   挂 `__saros_form` widget 参与**高度反馈**，否则走 fallbackY 兜底
			//   （≈100px）→ 控件被裁掉。
			//   注意**不设 fullCover** —— 这些节点要保留端口行（insets 分支）。
			//   ⚠ 复用上面守卫处算好的 `isOrchRich`（基于 `type`，含 `__liteType`
			//   兜底），**不要**用 `nt = n.type` 重算 —— 两者对反序列化节点可能不等。
			const orchRich = isOrchRich;
			// NOTE: no min-height bump for schema nodes — the addDOMWidget
			// form widget owns the node height (arrange/computeSize + the
			// measure feedback below), so a fixed 320px floor would fight it.
			const container = bridge.ensureContainer(nodeId);
			// Height feedback: the card marked itself dirty after a render →
			// measure the true content height once and feed it into
			// LiteGraph's layout (widget height + node size).
			if ((spec.kind === 'schema' || fullCover || orchRich) && takeFormHeightDirty(nodeId)) {
				const hostEl = container.firstElementChild as HTMLElement | null;
				if (hostEl) {
					// ── Critical fix for Bug #3 (height feedback deadlock) ──────
					// The widgetBridge container has overflow:hidden + an explicit
					// pixel height (from LiteGraph's previous layout). The inner
					// wrapper (hostEl) has height:100%, so scrollHeight returns at
					// most the CONTAINER height — never the natural content size.
					// This creates a chicken-and-egg loop where the node can never
					// grow past its initial estimate.
					//
					// Fix: briefly lift the height constraint so scrollHeight reports
					// the true content extent, then restore.
					const prevHeight = container.style.height;
					const prevOverflow = container.style.overflow;
					container.style.height = 'auto';
					container.style.overflow = 'visible';
					const contentH = hostEl.scrollHeight;
					container.style.height = prevHeight;
					container.style.overflow = prevOverflow;

					// ── Sanity guard: reject bogus measurements (#58) ──────────
					// React may not have committed DOM yet when we measure in this
					// rAF frame → scrollHeight returns a tiny value (e.g. 55px for a
					// node that should be ~290px). Guard: if measured H is < 60% of
					// the previous known height, skip — the real measurement will
					// arrive in a future frame after React commits.
					const prevHNum = parseFloat(prevHeight) || 0;
					if (contentH > 0 && (!prevHNum || contentH >= prevHNum * 0.6)) {
						deferredHeightFixes.push({ node: n as unknown as Parameters<typeof setDomFormContentHeight>[0], h: contentH });
						// eslint-disable-next-line no-console
						console.warn('[heightFb]', { nodeId: nodeId.slice(0, 12), contentH, prevH: prevHeight.slice(0, -2) });
					} else {
						// eslint-disable-next-line no-console
						console.warn('[heightFb SKIP] bogus', { nodeId: nodeId.slice(0, 12), contentH, prevH: prevHeight.slice(0, -2), ratio: prevHNum ? (contentH / prevHNum).toFixed(2) : '?' });
					}
				}
			}
			// Base z follows draw order (graph.nodes index). Hovered /
			// selected nodes get a big boost so their card stays on top.
			// Stacking is governed by DOM appendChild order, not by z-index (实测 z-index
			// 在 widgetBridge 容器的 transform: scale stacking context 内不稳定——
			// 数值大者不一定在上，依赖 DOM 位置)。syncOverlay 末尾会按 canvasIdx
			// 升序 reappend 所有容器，DOM 后者自然在上，hover/selected 节点额外 reappend
			// 到最末。
			// DOM-card self-heal: if the React root vanished (e.g. an uncaught
			// render error made React unmount the root, or the host element was
			// otherwise lost) the container stays positioned but paints nothing —
			// the "dom 消失" bug. Detect the empty container and re-mount the card.
			// Cooldown 1s/node so a persistent render error doesn't tight-loop.
			if (cardUnmounts.has(nodeId) && !container.firstElementChild) {
				const lastRetry = cardRemountAt.get(nodeId) ?? 0;
				const now = Date.now();
				if (now - lastRetry > 1000) {
					cardRemountAt.set(nodeId, now);
					cardUnmounts.get(nodeId)?.();
					cardUnmounts.delete(nodeId);
				}
			}
			if (!cardUnmounts.has(nodeId)) {
				const meta = getNodeCardMeta(spec, props);
				// 计算上游节点 id 列表（g.links 中 target_id === n.id 的 origin_id，
				// 映射回 store 层的 __sarosId）。
				// 对齐 ComfyUI/ComfyTV 的范式：**不按节点类型白名单判断「谁需要上游」**，
				// 而是对所有节点机械收集——连线本身即真源。是否需要/如何使用上游数据，
				// 由消费侧（nodeCard 的 UI 决策）自行决定。这彻底消除了此前
				// 「生产侧 needsUpstream 与消费侧 needUpstreamImage 两份白名单必须
				// 手工同步」的根源（第 71 轮 Erase 空白画布就是漏同步的教训）。
				// ★ 上游 key 必须用 **stageUid**（快照归档键），不能用 nodeId。
				//   上一轮把「写入侧」（runStageWorkflow/runSingleNode/runInstantNode）
				//   改成按 stageUid 归档后，ImageStage 的新快照落在 `uid-…:output:0`；
				//   这里若仍按 `__sarosId`（= nodeId）收集上游 key，下游
				//   `byNode(nodeId)` 查不到新快照 → **下游节点图像永远不刷新**
				//   （用户实测：ImageStage 自己 OUTPUT 刷了、Rotate/Eras/Mate 没刷）。
				//   claimStageUid 幂等，确保 origin 有 uid（不依赖主循环处理顺序）。
				const upstreamNodeIds: string[] = [];
				for (const link of g.links.values()) {
					if (link.target_id === n.id) {
						const origin = g.getNodeById(link.origin_id);
						if (!origin) { continue; }
						const oid = claimStageUid(origin as unknown as Parameters<typeof claimStageUid>[0]);
						if (!upstreamNodeIds.includes(oid)) { upstreamNodeIds.push(oid); }
					}
				}
				// ── 持久 stage uid（媒体快照归档键）─────────────────────────
				// nodeId 由 nextNodeId() 按「同类最大序号+1」生成，**删除后会复用**，
				// 而快照持久且永不淘汰 → 新建同类节点会读到已删节点的输出图。
				// uid 用 randomUUID 且随 graph.serialize() 持久化，永不复用。
				const stageUid = claimStageUid(n as unknown as Parameters<typeof claimStageUid>[0]);
				// ★ 注册 nodeId → stageUid 别名（幂等）：快照归档键是 uid，但
				//   运行链路（state.edges 的 upstreams）、双击编辑器、collectUpstream
				//   等大量读取方仍用 nodeId 查询。registerAlias 让 byNode(nodeId)
				//   查不到时自动命中 uid 名下归档 → 下游节点图像才能刷新。
				snapshotStoreRef.current?.registerAlias(nodeId, stageUid);
				// 老工作流没有 uid：把按旧 nodeId 归档的历史快照迁到 uid 名下，
				// 否则升级后历史输出图会「消失」（等价 ComfyTV adoptOutputs）。
				// migratedUids 保证每个节点只迁一次。
				if (!migratedUidsRef.current.has(stageUid)) {
					migratedUidsRef.current.add(stageUid);
					snapshotStoreRef.current?.renameNode(nodeId, stageUid);
				}
				const unmount = createNodeCard(container, meta, {
					snapshotStore: snapshotStoreRef.current ?? undefined,
					cardStateStore: cardStateStoreRef.current ?? undefined,
					nodeId,
					stageUid,
					upstreamNodeIds: upstreamNodeIds.length > 0 ? upstreamNodeIds : undefined,
				});
				cardUnmounts.set(nodeId, unmount);
				if (spec.kind === 'schema') {
					// Schema nodes are visually DOM-led, but selection must still be
					// visible. Keep the LiteGraph canvas selection stroke (drawn as a
					// box around the whole node — the DOM card only covers the widget
					// area, so the box reads clearly around the title bar / node
					// perimeter). Only the `error` stroke is suppressed, since the
					// error ring is owned by the DOM layer (overlayRingColor) and a
					// canvas double-draw would clash.
					const nodeAny = n as unknown as { strokeStyles?: Record<string, unknown> };
					if (nodeAny.strokeStyles) {
						delete nodeAny.strokeStyles['error'];
					}
					nodeAny.onDrawForeground = () => { /* state ring lives in the DOM layer */ };
				}
			}
			// ComfyTV-style: card sits INSIDE the widget area — below the canvas
			// title bar AND below the port rows.
			// Schema nodes (addDOMWidget): the form widget's LiteGraph-assigned
			// rect drives the overlay (y + computedHeight from node.arrange()),
			// so the card always matches the widget area exactly, at any zoom,
			// with any port count. Other kinds fall back to the inset formula.
			// 注：fullCover 已在 collapsed 检查之后提前声明（让 height-feedback 同样能用）。
			// schema 节点由 registerSchemaLiteGraphNode 通过 ensureDomFormWidget 附加；
			// 原生内嵌编辑器节点在本循环靠下方的 fullCover 分支 ensureDomFormWidget。
			// 两者都需要被读出 formWidget = getDomFormWidget(n)，否则走 fallbackY 兜底
			// （=max(paramsCount*24 + maxPorts*20 + 6, 100)），卡片高度被压到 ~100px，
			// 编辑器控件（ANGLE 滑块 / Horizontal flip / MATERIAL PBR 滑块 / Generate 按钮
			// 等）被全部截断。
			const formWidget = (spec.kind === 'schema' || fullCover || orchRich)
				? getDomFormWidget(n as unknown as Parameters<typeof getDomFormWidget>[0])
				: undefined;
			// Fallback y：构造时 LiteGraph arrange 还没跑（formWidget.y undefined），
			// 走 insets fallback 会把 DOM 卡片画在参数 widget 之上、遮住 widget。
			// 改用「port rows + n 个 litegraph widget」累加作为兜底起始 y（body 相对
			// 坐标——0.17 中标题栏在 pos[1] 上方，坐标原点不含标题高度），与
			// arrange() 的结果一致：startY = maxPorts*20 + 6，每个 widget 高 24。
			// arrange 跑后会被 formWidget.y 覆盖（widgetBridge 实时同步 formWidget.y）。
			const ARRANGE_WIDGET_ROW = 24;
			const paramsCount = (n.widgets ?? []).filter(w => w.name !== '__saros_form').length;
			const fallbackY = Math.max(n.inputs?.length ?? 0, n.outputs?.length ?? 0) * 20 + 6
				+ paramsCount * ARRANGE_WIDGET_ROW;
			const widgetRect = formWidget && typeof formWidget.y === 'number' && formWidget.computedHeight > 0
				? { y: formWidget.y, height: formWidget.computedHeight }
				// Fallback to a minimum visible height (100px) so the card body
				// is at least painted when the form widget hasn't been laid out
				// yet (e.g. immediately after node creation before arrange runs).
				// The earlier "height:0" silently hid the entire card.
				: { y: fallbackY, height: Math.max(fallbackY, 100) };
			// 之前 z-index 块被删后忘了保留 `const isSelected = ...` —— 下面
			// nodesForSync / containerOrder 仍引用 isSelected → ReferenceError
			// → syncOverlay 抛错 → DOM 卡片位置永远停在初值 (0,0)。重新声明。
			const isSelected = selectedIds.has(nodeId) || !!(n as unknown as { selected?: boolean }).selected;
			// LiteGraph 0.17 内部用 Float32Array(4) 存 [posX, posY, sizeW, sizeH]，
			// `n.pos` / `n.size` getter 返回的是 subarray 的视图（共享底层 buffer）。
			// 当 _posSize 被某处 `n.size = [a, b]` 整体替换时，subarray 视图仍指向
			// 旧 buffer，**getter 返回的就是 stale 值**（实测 size[0]=0 但容器 width 320）。
			// 直接读 `_posSize[0..3]` 拿真实数据，确保 OverlayNode 传给 widgetBridge
			// 的 width/height 是 canvas 实际尺寸。
			const rawPosSize = (n as unknown as { _posSize?: Float32Array })._posSize;
			const realPos: [number, number] = rawPosSize ? [rawPosSize[0], rawPosSize[1]] : n.pos;
			const realSize: [number, number] = rawPosSize ? [rawPosSize[2] || n.size[0], rawPosSize[3] || n.size[1]] : n.size;
			// ComfyUI getDomWidgetZIndex：层级 = 节点在 graph.nodes 中的下标。
			const canvasIdx = (g._nodes as unknown as Array<LGraphNode>).indexOf(n);
			// renderArea（graph 单位 [x,y,w,h]，含标题栏与外部装饰）供 DOM 裁剪使用。
			// LiteGraph 每帧在 measure 阶段刷新它；缺失时用 pos/size 兜底（标题栏在
			// pos[1] 之上，故 y 上移一个标题高度）。
			const rawArea = (n as unknown as { renderArea?: ArrayLike<number> }).renderArea;
			const renderArea: ArrayLike<number> = rawArea && rawArea.length === 4 && (rawArea[2] > 0 || rawArea[3] > 0)
				? rawArea
				: [realPos[0], realPos[1] - LITEGRAPH_TITLE_HEIGHT, realSize[0], realSize[1] + LITEGRAPH_TITLE_HEIGHT];
			// fullCover：有内嵌编辑器的节点（Crop/Rotate/Mirror/Outpaint/GridSplit/
			// ColorGrade/Multiangle/Panorama/Relight/Material/KenBurns 及所有 schema
			// 节点）卡片占满整个节点 body，无 insets。
			// 判据统一来自 stageCardRegistry（此前是硬编码 6 项，导致 Outpaint /
			// GridSplit / ColorGrade / Multiangle 走了 insets 分支并被截断）。
			// 注：`nt` / `fullCover` 已在 collapsed 检查之后提前声明，避免重复。
			// 原生编辑器节点需要 __saros_form widget 才能参与高度反馈循环
			// （setDomFormContentHeight 依赖此 widget 调整节点尺寸）。
			// schema 节点已在 registerSchemaLiteGraphNode 中通过 ensureDomFormWidget 附加，
			// 但 ComfyTV.* 原生节点由 ComfyUI 自身注册，没有 form widget → 高度永远不增长。
			if ((fullCover || orchRich) && !getDomFormWidget(n as unknown as Parameters<typeof getDomFormWidget>[0])) {
				ensureDomFormWidget(n as unknown as Parameters<typeof ensureDomFormWidget>[0], {
					// 按节点声明的最小高度做首帧估算（对齐 ComfyTV
					// RICH_STAGE_MIN_HEIGHTS + getMinHeight）。固定 320 对
					// Rotate(520) / Multiangle(640) 等严重偏小，首帧只能看到
					// 图像顶部一条，要等反馈循环多轮才收敛。
					// 编排富卡片内容轻（身份卡 + 2 个下拉 + 1 个 textarea），
					// 用 150 起步，反馈循环会立刻收敛到真实高度。
					estimateHeight: orchRich && !fullCover ? 150 : stageMinHeight(nt),
					estimateTop: (Math.max(n.inputs?.length ?? 0, n.outputs?.length ?? 0, 0)) * 20 + 6,
				});
				if (orchRich) {
					// 编排富卡片挂上 form widget 时打点一次（每节点仅首次进入本分支）。
					// 有这行说明 DOM 通路已生效；配合 [orchCard] 的 controls 数量即可
					// 判断「没渲染」是通路问题还是数据源问题。
					// eslint-disable-next-line no-console
					console.warn('[orchForm] attached ' + JSON.stringify({ nodeId, type, fullCover }));
				}
			}
			nodesForSync.push({
				id: nodeId,
				node: { pos: realPos, size: realSize },
				fullCover,
				insets: fullCover ? undefined : (widgetRect ? undefined : widgetAreaInsets(n.inputs?.length ?? 0, n.outputs?.length ?? 0)),
				widgetRect,
				selected: isSelected,
				state: cardStateStoreRef.current?.get(nodeId)?.runState,
				zIndex: canvasIdx,
				renderArea,
			});
			containerOrder.push({ id: nodeId, container, canvasIdx });
			}
			// drop cards for nodes that were removed from the graph
			let unmountedCount = 0;
			// Grace period: skip unmount when seen is empty (transient
			// graph.clear() window during syncStoreToGraph → graph.configure()).
			if (seen.size === 0 && cardUnmounts.size > 0) {
				emptySeenStreak++;
				if (emptySeenStreak < 2) {
					// Preserve all cards this frame — graph is mid-reconfigure.
					// Mount logic still runs (above), so when nodes return
					// next frame, they reuse the existing React roots.
					seen; // keep linter quiet about unused in branch
				} else {
					// Two consecutive frames with no nodes → graph really empty.
					for (const [id, unmount] of cardUnmounts) {
						unmount();
						bridge.releaseContainer(id);
						cardUnmounts.delete(id);
						cardRemountAt.delete(id);
						clearFormHeightDirty(id);
						unmountedCount++;
					}
				}
			} else {
				emptySeenStreak = 0;
				for (const [id, unmount] of cardUnmounts) {
					if (!seen.has(id)) {
						unmount();
						bridge.releaseContainer(id);
						cardUnmounts.delete(id);
						cardRemountAt.delete(id);
						clearFormHeightDirty(id);
						// 释放 uid 占用（节点已从 graph 移除，只剩 nodeId）。
						// 注意**不清理快照** —— 节点可能只是被折叠/暂时移出视口，
						// 且 uid 永不复用，残留快照不会错配到新节点。
						releaseStageUidByOwner(id);
						// ★ 同时注销 nodeId → uid 别名：nodeId 会被 nextNodeId()
						//   复用，残留别名会让新建的同名节点读到已删节点 uid 名下
						//   的输出图（串号）。注销幂等且自愈 —— 若该节点只是短暂
						//   离开 graph，下一帧 registerAlias 会原样恢复。
						snapshotStoreRef.current?.unregisterAlias(id);
						unmountedCount++;
					}
				}
			}
			// DOM-card "消失" 诊断：一次 sync 里 unmount 的卡片数。
			// 偶发单节点移除是正常的；批量 unmount（>1）说明该帧 graph.nodes 被清空
			// 或整个图被重建（syncStoreToGraph → graph.clear）→ 与 React effect 重建
			// / store 改动 / SpecRegistry 刷新 时序相关。
			if (unmountedCount > 1) {
				// eslint-disable-next-line no-console
				console.warn('[syncOverlay] bulk card unmount ' + JSON.stringify({ unmountedCount, seen: [...seen], totalTracked: cardUnmounts.size + unmountedCount, emptySeenStreak }));
			}
			bridge.sync(nodesForSync, { x: ds.offset[0], y: ds.offset[1], scale: ds.scale }, occluders);
			// ── Apply deferred height fixes AFTER bridge.sync() ───────────
			// bridge.sync() overwrites container height to widgetRect.height
			// (stale from previous frame). We measured true contentH before sync
			// with auto/visible; now apply setSize so LiteGraph picks it up on
			// the NEXT frame's arrange(). See #57 "sudden growth after drag".
			for (const fix of deferredHeightFixes) {
				setDomFormContentHeight(fix.node, fix.h);
			}
			deferredHeightFixes.length = 0;
			// 层级由 widgetBridge 写入的 CSS z-index 决定（ComfyUI getDomWidgetZIndex）。
			// DOM 顺序只作为兜底同步一次：仅当 canvasIdx 序列真正变化（新增/删除节点、
			// bringToFront）时才 reappend，避免每帧 appendChild 触发无谓 reflow。
			if (containerOrder.length > 0) {
				containerOrder.sort((a, b) => a.canvasIdx - b.canvasIdx);
				const signature = containerOrder.map(e => e.id).join('|');
				if (signature !== lastOrderSignature) {
					lastOrderSignature = signature;
					for (const entry of containerOrder) {
						overlay.layer.appendChild(entry.container);
					}
				}
			} else if (lastOrderSignature !== '') {
				lastOrderSignature = '';
			}
		};
		syncOverlay();

		// Card ▶ run button → execute the node (distinct from double-click,
		// which only opens the editor). Falls back to the double-click path
		// when no run handler is wired.
		const handleNodeRun = (e: Event) => {
			const nodeId = (e as CustomEvent<{ nodeId: string }>).detail?.nodeId;
			if (!nodeId) { return; }
			const node = graph.nodes.find(n => String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? n.id) === nodeId);
			if (!node) { return; }
			const props = (node.properties ?? {}) as Record<string, unknown>;
			const nodeType = String(props['__liteType'] ?? node.type ?? '');
			// ★ 快照归档键 = stageUid（不是 nodeId）。nodeCard 用 stageUid 读快照，
			//   run 链路必须用同一个 key 写，否则 OUTPUT 永远不刷新（见 stageIdentity）。
			const stageUid = readStageUid(node as unknown as Parameters<typeof readStageUid>[0]);
			const handler = onNodeRunRef.current ?? onNodeDoubleClickRef.current;
			handler?.(nodeId, nodeType, stageUid);
		};
		window.addEventListener('wf-node-run', handleNodeRun);

		// Card ACTIONS（Edit Image / Relight / Presets…，ComfyTV 语义）→ 打开编辑器，
		// 与 ▶ 运行按钮（wf-node-run）区分：actions 从不执行生成。
		const handleNodeEdit = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId: string; action?: string }>).detail;
			if (!detail?.nodeId) { return; }
			const node = graph._nodes.find(n => String(n.properties?.['__sarosId'] ?? n.id) === detail.nodeId);
			if (!node) { return; }
			const props = (node.properties ?? {}) as Record<string, unknown>;
			const nodeType = String(props['__liteType'] ?? node.type ?? '');
			onNodeDoubleClickRef.current?.(detail.nodeId, nodeType);
		};
		window.addEventListener('wf-node-edit', handleNodeEdit);

		// Card ACTIONS follow-up spawn (ComfyTV semantics): an action item or a
		// preset was clicked → create the corresponding node and connect it.
		const handleNodeAction = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId: string; actionId: string }>).detail;
			if (!detail?.nodeId || !detail?.actionId) { return; }
			spawnFollowUp(detail.nodeId, detail.actionId);
		};
		window.addEventListener('wf-node-action', handleNodeAction);

		// Inline prompt editing on cards → write back into BOTH node.properties (LiteGraph
		// 原生画布持久化) AND useWorkflowEditorStore 的 node.data（执行链路用：
		// runSingleSchemaNode 读 state.nodes.find(n=>n.id===nodeId).data 喂给
		// runNodeOrStage → resolveBindingValue('main_prompt') → 实际生效的 prompt）。
		// 原版只写 node.properties 导致用户输入的提示词永远拿不到（"two apple"
		// 未注入 → 生成默认图像）。
		const handleNodePrompt = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId: string; prompt: string }>).detail;
			if (!detail?.nodeId) { return; }
			const node = graph.nodes.find(n => String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? n.id) === detail.nodeId);
			if (!node) { return; }
			node.properties.prompt = detail.prompt;
			// 同步写到 zustand store 的 node.data（执行链路数据源），与 handleNodeControl 保持一致。
			useWorkflowEditorStore.getState().updateNodeData(detail.nodeId, { prompt: detail.prompt });
			graph.change?.();
			graph.setDirtyCanvas?.(true, true);
		};
		window.addEventListener('wf-node-prompt', handleNodePrompt);

		// Inline parameter controls (workflow/resolution/batch_size/…) → write back
		// into BOTH node.properties (LiteGraph 原生画布持久化) AND useWorkflowEditorStore
		// 的 node.data（执行链路用：runSingleSchemaNode 读 `state.nodes.find(n=>n.id===nodeId).data` 喂给
		// runNodeOrStage → injectWorkflowValues → 实际生效的 values）。原版只写
		// node.properties 导致 widget 改后 values 拿不到新值（batch_size=2 永远不生效）。
		const handleNodeControl = (e: Event) => {
			const detail = (e as CustomEvent<{ nodeId: string; name: string; value: unknown }>).detail;
			if (!detail?.nodeId || !detail.name) { return; }
			const node = graph.nodes.find(n => String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? n.id) === detail.nodeId);
			if (!node) { return; }
			node.properties[detail.name] = detail.value;
			// 同步写到 zustand store 的 node.data（执行链路数据源）。
			// 用 .getState().updateNodeData 直接 mutate，不触发 store 订阅重渲染（LiteGraph
			// 自身已 setDirtyCanvas）。
			useWorkflowEditorStore.getState().updateNodeData(detail.nodeId, { [detail.name]: detail.value });
			graph.change?.();
			graph.setDirtyCanvas?.(true, true);
		};
		window.addEventListener('wf-node-control', handleNodeControl);

		// 媒体库资产拖入画布 → 创建 Asset Loader 节点（对齐 ComfyTV
		// handleAssetDrop）。window 级监听：拖拽源在媒体库 modal（已随 dragstart
		// 关闭），drop 目标是画布，需在 dragover preventDefault 才允许 drop。
		const handleAssetDragOver = (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes(ASSET_DRAG_MIME)) { return; }
			e.preventDefault();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
		};
		const handleAssetDrop = (e: DragEvent) => {
			const raw = e.dataTransfer?.getData(ASSET_DRAG_MIME);
			if (!raw) { return; }
			e.preventDefault();
			let data: { id?: string; kind?: string } = {};
			try { data = JSON.parse(raw); } catch { return; }
			if (!data.id || !data.kind) { return; }
			// client → graph 坐标（同 pointerdown 的命中换算）。
			const rect = canvas.getBoundingClientRect();
			const ds = liteCanvas.ds;
			const x = (e.clientX - rect.left) / ds.scale - ds.offset[0];
			const y = (e.clientY - rect.top) / ds.scale - ds.offset[1];
			spawnAssetLoader(data.id, data.kind, { x, y });
		};
		window.addEventListener('dragover', handleAssetDragOver);
		window.addEventListener('drop', handleAssetDrop);

		// ── 剪贴板粘贴增强 ─────────────────────────────────────────────
		// 粘贴图片 → 自动创建 ComfyTV.ImageLoaderStage 节点展示（data.image 存
		// data URL + 写快照 store 立即展示）；粘贴文字 → 自动创建 Saros.Prompt
		// 节点（data.prompt = 文字）。与 LiteGraph 节点粘贴（Ctrl+V 走内部
		// localStorage 'litegrapheditor_clipboard'）互斥：有复制的节点时文字
		// 粘贴不抢处理，让 processKey 粘贴节点；图片粘贴始终抢（节点粘贴不涉图）。
		const handleCanvasPaste = (e: ClipboardEvent) => {
			if (isEditableTarget(e.target)) { return; }
			const cd = e.clipboardData;
			if (!cd) { return; }
			const state = useWorkflowEditorStore.getState();
			const rect = canvas.getBoundingClientRect();
			const ds = liteCanvas.ds;
			const cx = typeof e.clientX === 'number' ? e.clientX : rect.left + rect.width / 2;
			const cy = typeof e.clientY === 'number' ? e.clientY : rect.top + rect.height / 2;
			const x = (cx - rect.left) / ds.scale - ds.offset[0];
			const y = (cy - rect.top) / ds.scale - ds.offset[1];

			// 1) 图片优先：剪贴板含 image 文件 → 创建 ImageLoaderStage 并展示
			const imageItem = Array.from(cd.items ?? []).find(it => it.kind === 'file' && it.type.startsWith('image/'));
			if (imageItem) {
				const blob = imageItem.getAsFile();
				if (blob) {
					e.preventDefault();
					const reader = new FileReader();
					reader.onload = () => {
						const dataUrl = typeof reader.result === 'string' ? reader.result : '';
						if (!dataUrl) { return; }
						const newId = state.addNode('ComfyTV.ImageLoaderStage', { x, y });
						if (newId) {
							state.updateNodeData(newId, { image: dataUrl });
							// 写快照 store → 卡片立即展示（下一帧 renameNode 迁移到 stageUid）。
							snapshotStoreRef.current?.put({
								nodeId: newId, port: 'output', key: `${newId}:output:0`,
								media: { kind: 'image', ref: dataUrl }, index: 0,
							});
						}
					};
					reader.readAsDataURL(blob);
					return;
				}
			}

			// 2) 纯文本 → 创建 Saros.Prompt（节点内部粘贴冲突保护）
			const text = cd.getData('text/plain');
			if (text && text.trim()) {
				const hasNodeClipboard = typeof window !== 'undefined' && !!window.localStorage?.getItem('litegrapheditor_clipboard');
				if (hasNodeClipboard) { return; } // 让 LiteGraph 粘贴节点
				e.preventDefault();
				const newId = state.addNode('Saros.Prompt', { x, y });
				if (newId) {
					state.updateNodeData(newId, { prompt: text.trim() });
				}
			}
		};
		window.addEventListener('paste', handleCanvasPaste);

		return () => {
			window.removeEventListener('wf-node-run', handleNodeRun);
			window.removeEventListener('wf-node-edit', handleNodeEdit);
			window.removeEventListener('wf-node-action', handleNodeAction);
			window.removeEventListener('wf-node-prompt', handleNodePrompt);
			window.removeEventListener('wf-node-control', handleNodeControl);
			window.removeEventListener('dragover', handleAssetDragOver);
			window.removeEventListener('drop', handleAssetDrop);
			window.removeEventListener('paste', handleCanvasPaste);
			cancelAnimationFrame(overlayRaf);
			for (const unmount of cardUnmounts.values()) { unmount(); }
			cardUnmounts.clear();
			overlay.destroy();
			liteCanvas.stopRendering();
			resizeObserver.disconnect();
			if (resizeFitTimer) { clearTimeout(resizeFitTimer); }
			container.removeEventListener('wheel', wheelHandler, true);
			container.removeEventListener('pointerdown', dragPointerDown, true);
			window.removeEventListener('pointermove', dragPointerMove);
			window.removeEventListener('pointerup', dragPointerUp);
			window.removeEventListener('pointercancel', dragPointerUp);
			window.removeEventListener('pointermove', panPointerMove);
			window.removeEventListener('pointerup', panPointerUp);
			window.removeEventListener('pointercancel', panPointerUp);
		container.removeEventListener('pointerup', resetLinkConnector);
		container.removeEventListener('pointercancel', resetLinkConnector);
		lcEvents.removeEventListener('dropped-on-canvas', onLinkDroppedOnCanvas);
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
		// Compute graph node set by __sarosId (logical id) so position-only
		// updates don't trigger a full re-configure (which would clobber drag
		// state). We only re-sync when the *set* of nodes diverges — i.e. a
		// new node was added or an existing one was removed.
		const graphIds = new Set<string>(
			graph.nodes.map(n => {
				const p = (n.properties ?? {}) as Record<string, unknown>;
				return String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? n.id);
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
		// edge 差异检测：把 graph.links 端点映射到 __sarosId（与 store edges 的
		// source/target 同一 id 空间），任一边多出/缺失都触发同步。
		// ⚠ 端点必须用 __sarosId，不能用 LiteGraph 的 numeric node id：store edges
		// 的 key 形如 `start->agent-...`（saros），若这里用 numeric id 则 key 形如
		// `3->5`，两端永远对不上 → hasNewEdge 恒为 true → 每次 store 写入都全量
		// configure() → 死循环（height-feedback 的 setSize→graph.change→syncGraphToStore
		// →setNodes 每帧触发），每次 configure 重建所有节点，既丢掉 lc.selected_nodes
		// （选中高亮一闪消失）又重置 userHeight（#59 高度抖动）。
		const graphEdgeKeys = new Set<string>();
		for (const link of graph.links.values()) {
			const on = graph.getNodeById(link.origin_id);
			const tn = graph.getNodeById(link.target_id);
			const osid = String((on?.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? link.origin_id);
			const tsid = String((tn?.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? link.target_id);
			graphEdgeKeys.add(`${osid}->${tsid}`);
		}
		const storeEdgeKeys = new Set(edges.map(e => `${e.source}->${e.target}`));
		let hasNewEdge = false;
		for (const k of storeEdgeKeys) {
			if (!graphEdgeKeys.has(k)) { hasNewEdge = true; break; }
		}
		let hasRemovedEdge = false;
		if (!hasNewEdge) {
			for (const k of graphEdgeKeys) {
				if (!storeEdgeKeys.has(k)) { hasRemovedEdge = true; break; }
			}
		}
	if (hasNew || hasRemoved || hasNewEdge || hasRemovedEdge) {
		// Suppress the graph.on_change triggered by configure() to avoid
		// bouncing back into the store (the store just authored this).
		suppressStoreSync.current = true;
		try {
			syncStoreToGraph(graph, nodes, edges, graph._groups.map(g => g.serialize()), canvasInstanceRef.current);
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
			const sarosId = (n.properties as Record<string, unknown> | undefined)?.['__sarosId'] as string | undefined;
			const props = (n.properties ?? {}) as Record<string, unknown>;
			const nodeType = String(props.__liteType ?? n.type ?? '');
			onNodeDoubleClick(sarosId as string | undefined ?? String(n.id), nodeType);
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
				const saved = snapshotSelection(canvasInstanceRef.current);
				graph.configure({
					...imported,
					id: 'wf',
					groups: imported.groups ?? [],
				} as Parameters<LGraph['configure']>[0]);
				restoreSelection(graph, canvasInstanceRef.current, saved);
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
		stageUidOf(nodeId: string): string | undefined {
			const g = graphRef.current;
			if (!g || !nodeId) { return undefined; }
			const node = g.nodes.find(n => String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? n.id) === nodeId);
			if (!node) { return undefined; }
			// claimStageUid 而非 readStageUid：节点可能还没被 syncOverlay 处理过
			// （新建即运行），此处就地补齐 uid 并登记占用（幂等）。
			return claimStageUid(node as unknown as Parameters<typeof claimStageUid>[0]);
		},
		revealNode(nodeId: string): boolean {
			const g = graphRef.current;
			const lc = canvasInstanceRef.current;
			if (!g || !lc || !nodeId) { return false; }
			const node = g.nodes.find(n => String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? n.id) === nodeId);
			if (!node) { return false; }
			lc.selectNode(node, false);
			// 视口居中（保持当前缩放）。坐标契约与 zoomToFit 一致：
			// offset = 视口尺寸 / (2 * scale) - 节点中心。量测用 canvas 的**父容器**
			// —— canvas 自身的 clientWidth 会滞后于 CSS 尺寸（见 zoomToFit 注释）。
			const el = lc.canvas as HTMLCanvasElement | undefined;
			const rect = el?.parentElement?.getBoundingClientRect?.() ?? el?.getBoundingClientRect?.();
			const cw = rect?.width || el?.clientWidth || 800;
			const ch = rect?.height || el?.clientHeight || 600;
			const scale = lc.ds.scale || 1;
			const cx = node.pos[0] + (node.size?.[0] ?? 0) / 2;
			const cy = node.pos[1] + (node.size?.[1] ?? 0) / 2;
			lc.ds.offset[0] = cw / (2 * scale) - cx;
			lc.ds.offset[1] = ch / (2 * scale) - cy;
			lc.setDirty?.(true, true);
			return true;
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
		resetView(): void {
			const lc = canvasInstanceRef.current;
			if (!lc) { return; }
			lc.ds.offset = [0, 0];
			lc.ds.scale = 1;
			lc.setDirty(true, true);
		},
		cloneNode(nodeId: number): void {
			const g = graphRef.current;
			const lc = canvasInstanceRef.current;
			if (!g || !lc) { return; }
			const src = g.getNodeById(nodeId);
			if (!src) { return; }
			const copy = (g as any).cloneNode(src) as LGraphNode | undefined;
			if (copy) {
				// Offset so the clone doesn't sit exactly on top of the source.
				copy.pos = [src.pos[0] + 24, src.pos[1] + 24];
				g.change();
				lc.selectNode(copy, false);
			}
		},
		removeLink(linkId: number): void {
			const g = graphRef.current;
			const lc = canvasInstanceRef.current;
			if (!g || !lc) { return; }
			if (g.links.has(linkId)) {
				g.removeLink(linkId);
				g.change();
				lc.setDirty(true, true);
			}
		},
		alignSelected(): void {
			const g = graphRef.current;
			const lc = canvasInstanceRef.current;
			if (!g || !lc) { return; }
			const selectedNodes = (lc as any).selected_nodes as Record<string, LGraphNode> | undefined;
			if (!selectedNodes) { return; }
			for (const node of selectedNodes.values()) {
				node.pos[0] = Math.round(node.pos[0] / 8) * 8;
				node.pos[1] = Math.round(node.pos[1] / 8) * 8;
			}
			g.change();
			lc.setDirty(true, true);
		},
		markRouteEdges(ranIds: string[], skippedIds: string[]): void {
			const g = graphRef.current;
			const lc = canvasInstanceRef.current;
			if (!g || !lc) { return; }
			// sarosId（__sarosId）→ LiteGraph numeric id
			const numOf = (sarosId: string): number | null => {
				for (const n of g.nodes) {
					const sid = (n as unknown as { properties?: Record<string, unknown> }).properties?.__sarosId;
					if (sid === sarosId || String(n.id) === sarosId) { return n.id; }
				}
				return null;
			};
			const numRan = new Set(ranIds.map(numOf).filter((x): x is number => x !== null));
			const numSkipped = new Set(skippedIds.map(numOf).filter((x): x is number => x !== null));
			for (const link of g.links.values()) {
				if (!link) { continue; }
				if (numRan.has(link.origin_id) && numRan.has(link.target_id)) {
					(link as unknown as { color?: string }).color = '#2ecc71';
				} else if (numSkipped.has(link.target_id)) {
					(link as unknown as { color?: string }).color = 'rgba(107,114,128,0.5)';
				} else {
					(link as unknown as { color?: string }).color = '';
				}
			}
			g.change();
			lc.setDirty(true, true);
		},
		addGroupAt(graphX: number, graphY: number): void {
			const g = graphRef.current;
			const lc = canvasInstanceRef.current;
			if (!g || !lc) { return; }
			// Mirrors litegraph's built-in Add Group (LGraphCanvas.onGroupAdd):
			// a blank group at the click position; rename via the group menu.
			const group = new LGraphGroup('Group');
			group.pos = [graphX, graphY];
			g.add(group);
			g.change();
			lc.setDirty(true, true);
		},
		canvasInstance(): LGraphCanvas | null {
			return canvasInstanceRef.current;
		},
		beginGhostPlace(type: string, graphX?: number, graphY?: number): void {
			let x = graphX;
			let y = graphY;
			// 未给位置 → 画布中心（对齐 ComfyUI getNewNodeLocation 的 getCanvasCenter 分支）。
			if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) {
				const lc = canvasInstanceRef.current;
				const rect = containerRef.current?.getBoundingClientRect?.() ?? (lc?.canvas as HTMLCanvasElement | undefined)?.getBoundingClientRect?.();
				const cw = rect?.width || 800;
				const ch = rect?.height || 600;
				const scale = lc?.ds?.scale ?? 1;
				const off = lc?.ds?.offset ?? [0, 0];
				x = cw / (2 * scale) - (off[0] ?? 0);
				y = ch / (2 * scale) - (off[1] ?? 0);
			}
			setGhost({ type, x, y });
		},
		cancelGhostPlace(): void {
			setGhost(null);
		},
		pasteFromClipboard(): void {
			const lc = canvasInstanceRef.current;
			if (!lc) { return; }
			lc.pasteFromClipboard();
		},
		getSelectedNodes(): Array<{ id: string; type: string; data: Record<string, unknown> }> {
			const lc = canvasInstanceRef.current;
			const g = graphRef.current;
			if (!lc || !g) { return []; }
			const out: Array<{ id: string; type: string; data: Record<string, unknown> }> = [];
			for (const k of Object.keys(lc.selected_nodes ?? {})) {
				const n = g.getNodeById(k);
				if (!n) { continue; }
				// sarosId (logical) is stored in properties.__sarosId; fall back
				// to the LiteGraph numeric id stringified.
				const sarosId = String((n.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? k);
				out.push({
					id: sarosId,
					type: String((n.properties as Record<string, unknown> | undefined)?.__liteType ?? n.type ?? ''),
					data: (n.properties as Record<string, unknown> | undefined)?.__data as Record<string, unknown> ?? {},
				});
			}
			return out;
			},
			}), [storeApi, ref]);

			// ★ ghost 落位模式：Esc 取消（对齐 ComfyUI 搜索框 Esc 关闭）。
			//   用 window 级监听而非捕获层 onKeyDown —— 捕获层可能拿不到键盘焦点。
			React.useEffect(() => {
				if (!ghost) { return; }
				const onKey = (e: KeyboardEvent) => {
					if (e.key === 'Escape') { setGhost(null); }
				};
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, [ghost]);

			/** 从连线松手菜单选中某节点：在落点创建节点并自动连线。 */
			const handleConnDropSelect = React.useCallback((item: CompatibleNodeItem) => {
			if (!connMenu) { return; }
			const { ctx } = connMenu;
			const store = storeApi.getState();
			const newId = store.addNode(item.type, { x: ctx.graphX, y: ctx.graphY });
			// 连线方向：数据始终从 source 流向 target。
			// connectingTo==='input'  → 从 OUTPUT 端口拖出，new 节点是下游（target）
			// connectingTo==='output' → 从 INPUT 端口拖出，new 节点是上游（source）
			const edge = ctx.connectingTo === 'input'
				? { source: ctx.srcNodeId, sourceHandle: ctx.srcPort, target: newId, targetHandle: item.portName }
				: { source: newId, sourceHandle: item.portName, target: ctx.srcNodeId, targetHandle: ctx.srcPort };
			store.setEdges([...store.edges, edge as unknown as typeof store.edges[number]]);
			// 关闭菜单 + 复位连线拖拽状态
			setConnMenu(null);
			canvasInstanceRef.current?.linkConnector?.reset();
			}, [connMenu, storeApi]);

			return (
		<div
			ref={containerRef}
			className={`wf-litegraph-canvas ${className ?? ''}`}
			style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }}
		onContextMenu={(e) => {
			e.preventDefault();
			// LiteGraph's native context menu is suppressed (processContextMenu
			// overridden to no-op in the init effect).  This handler is the sole
			// source of right-click menus.
			const rect = e.currentTarget.getBoundingClientRect();
			const liteCanvas = canvasInstanceRef.current;
			const graph = graphRef.current;
			if (!liteCanvas || !graph) { return; }
			const ds = liteCanvas.ds;
			const gx = (e.clientX - rect.left) / ds.scale - ds.offset[0];
			const gy = (e.clientY - rect.top) / ds.scale - ds.offset[1];
			// Right-click on a node → node actions menu (M1). Select it first
			// (right-click-to-select, aligned with ComfyUI) so actions act on
			// the clicked node even when it wasn't selected.
			const node = graph.getNodeOnPos(gx, gy);
			if (node) {
				liteCanvas.selectNode(node, false);
				onNodeContextMenu?.(node, gx, gy, e.clientX, e.clientY);
				return;
			}
			// Right-click on a group → group menu (rename/recolor/pin/remove).
			const group = graph.getGroupOnPos(gx, gy);
			if (group) {
				onGroupContextMenu?.(group, gx, gy, e.clientX, e.clientY);
				return;
			}
			// Right-click on a connection → link menu (disconnect).
			const link = findLinkAt(graph, gx, gy);
			if (link) {
				onLinkContextMenu?.(link, gx, gy, e.clientX, e.clientY);
				return;
			}
			onCanvasContextMenu?.(gx, gy, e.clientX, e.clientY);
		}}
		onDoubleClick={(e) => {
			// ★ ComfyUI 交互：双击空白处打开节点搜索框。节点/分组/连线上的双击
			//   不触发（节点双击由 LiteGraph 内部的 onNodeDblClicked → onNodeDoubleClick
			//   处理，这里只是空白搜索入口，需排除命中的对象避免冲突）。
			const liteCanvas = canvasInstanceRef.current;
			const graph = graphRef.current;
			if (!liteCanvas || !graph) { return; }
			const rect = e.currentTarget.getBoundingClientRect();
			const ds = liteCanvas.ds;
			const gx = (e.clientX - rect.left) / ds.scale - ds.offset[0];
			const gy = (e.clientY - rect.top) / ds.scale - ds.offset[1];
			if (graph.getNodeOnPos(gx, gy)) { return; }
			if (graph.getGroupOnPos(gx, gy)) { return; }
			if (findLinkAt(graph, gx, gy)) { return; }
			onCanvasDoubleClick?.(gx, gy, e.clientX, e.clientY);
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
				{/* 连线松手空白处 → 可连接节点列表（对齐 ComfyUI/ComfyTV link-release 菜单） */}
				{connMenu && (
					<ConnectionDropMenu
						anchor={connMenu.anchor}
						items={connMenu.items}
						onSelect={handleConnDropSelect}
						onClose={() => {
							setConnMenu(null);
							canvasInstanceRef.current?.linkConnector?.reset();
						}}
					/>
				)}
				{/* ★ FollowCursor ghost 落位：全屏捕获层抢占指针事件（屏蔽 LiteGraph 的
				    平移/框选/右键菜单），节点以半透明虚线矩形跟随光标，左键落位、
				    右键或 Esc 取消。zIndex 远高于 widget overlay 与 minimap。 */}
				{ghost && (() => {
					const lc = canvasInstanceRef.current;
					const ds = lc?.ds;
					const scale = ds?.scale ?? 1;
					const sx = (ghost.x + (ds?.offset?.[0] ?? 0)) * scale;
					const sy = (ghost.y + (ds?.offset?.[1] ?? 0)) * scale;
					const toGraph = (clientX: number, clientY: number) => {
						const rect = containerRef.current?.getBoundingClientRect();
						if (!rect || !ds) { return { x: ghost.x, y: ghost.y }; }
						return {
							x: (clientX - rect.left) / (ds.scale || 1) - (ds.offset?.[0] ?? 0),
							y: (clientY - rect.top) / (ds.scale || 1) - (ds.offset?.[1] ?? 0),
						};
					};
					return (
						<div
							style={{ position: 'absolute', inset: 0, zIndex: 10000, cursor: 'crosshair' }}
							onPointerMove={(e) => {
								const p = toGraph(e.clientX, e.clientY);
								setGhost({ type: ghost.type, x: p.x, y: p.y });
							}}
							onClick={(e) => {
								e.stopPropagation();
								const p = toGraph(e.clientX, e.clientY);
								// 节点左上角对齐点击处（与右键级联/连线松手落位语义一致）。
								storeApi.getState().addNode(ghost.type, { x: p.x, y: p.y });
								setGhost(null);
							}}
							onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setGhost(null); }}
						>
							<div
								style={{
									position: 'absolute', left: sx, top: sy, width: 180, height: 80,
									border: '1.5px dashed rgba(140,190,255,0.95)',
									background: 'rgba(60,120,220,0.16)',
									borderRadius: 6, pointerEvents: 'none',
									display: 'flex', alignItems: 'center', justifyContent: 'center',
								}}
							>
								<span style={{ color: '#cfe4ff', fontSize: 12, fontFamily: 'var(--vscode-font-family, monospace)', padding: '0 8px', textAlign: 'center', overflow: 'hidden' }}>{ghost.type}</span>
							</div>
							<div
								style={{
									position: 'absolute', left: sx, top: sy + 80 + 8,
									background: '#202020', border: '1px solid rgba(255,255,255,0.22)',
									color: '#cfcfcf', fontSize: 11, padding: '3px 9px', borderRadius: 4,
									pointerEvents: 'none', whiteSpace: 'nowrap',
								}}
							>
								点击放置 · Esc / 右键取消
							</div>
						</div>
					);
				})()}
				</div>
				);
				});
/** Snapshot the currently-selected node ids (by __sarosId, fallback numeric id)
 *  so selection survives a graph.configure() rebuild. Selection lives on the
 *  LGraphCanvas (`lc.selected_nodes`), NOT on the graph — configure() rebuilds
 *  every node object, so the old `selected_nodes` references dead nodes and the
 *  highlight ring vanishes. */
function snapshotSelection(liteCanvas: LGraphCanvas | null | undefined): Set<string> {
	const sel = new Set<string>();
	const sn = (liteCanvas as unknown as { selected_nodes?: Record<string, LGraphNode> } | null | undefined)?.selected_nodes;
	if (!sn) { return sel; }
	for (const key of Object.keys(sn)) {
		const node = sn[key];
		const sid = (node?.properties as Record<string, unknown> | undefined)?.__sarosId as string | undefined;
		sel.add(sid ?? key);
	}
	return sel;
}

/** Rebind `lc.selected_nodes` to the rebuilt nodes and keep each node's
 *  `.selected` flag consistent with the canvas selection map.
 *  ⚠ `lc.selected_nodes` is keyed by the node's NUMERIC LiteGraph id
 *  (that's what `LGraphCanvas.selectNode`/`deselectNode` use and what the
 *  canvas draw iterates), NOT by `__sarosId`. So we always re-insert using
 *  `String(node.id)`; `__sarosId` is only used to *match* a rebuilt node back
 *  to a saved selection. Using `__sarosId` as the key made LiteGraph look up
 *  the selection by an unknown id → no stroke drawn → 选中高亮不显示. */
function restoreSelection(graph: LGraph, liteCanvas: LGraphCanvas | null | undefined, saved: Set<string>): void {
	const sn = (liteCanvas as unknown as { selected_nodes?: Record<string, LGraphNode> } | null | undefined)?.selected_nodes;
	if (!sn) { return; }
	for (const k of Object.keys(sn)) { delete sn[k]; }
	for (const node of graph._nodes) {
		const sid = (node.properties as Record<string, unknown> | undefined)?.__sarosId as string | undefined;
		const numericKey = String(node.id);
		const isSaved = saved.has(sid ?? numericKey);
		if (isSaved) {
			sn[numericKey] = node as LGraphNode;
			(node as unknown as { selected: boolean }).selected = true;
		} else {
			(node as unknown as { selected: boolean }).selected = false;
		}
	}
}

/**
 * Post-configure link repair: graph.configure() (LiteGraph 0.17) leaves links
 * present in `graph.links` but unregistered on the node slots, causing:
 *   1) No visible connection lines — drawConnections walks node **inputs** and
 *      reads `input.link`; a null value means "not connected" so nothing is drawn.
 *   2) Picker upstream traversal / type checks seeing a disconnected slot.
 *
 * ⚠ LiteGraph slot shape asymmetry (see @comfyorg/litegraph interfaces.d.ts):
 *   - `INodeInputSlot.link:  LinkId | null`   → SINGULAR (an input takes 1 link)
 *   - `INodeOutputSlot.links: LinkId[] | null` → PLURAL  (an output fans out)
 * Writing an array onto the input side (`input.links`) is a no-op for rendering.
 */
function repairLinksAfterConfigure(graph: LGraph): void {
	const raw = (graph as unknown as { links?: unknown }).links;
	if (!raw) { return; }

	const entries: Array<{ id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number }> =
		raw instanceof Map
			? [...(raw as Map<number, { id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number }>).values()]
			: Array.isArray(raw)
				? (raw as Array<{ id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number }>)
				: [];

	let repaired = 0;
	for (const lk of entries) {
		const oNode = graph.getNodeById?.(lk.origin_id);
		const tNode = graph.getNodeById?.(lk.target_id);
		if (!oNode || !tNode) { continue; }

		const oSlot = oNode.outputs?.[lk.origin_slot];
		const tSlot = tNode.inputs?.[lk.target_slot];
		if (!oSlot || !tSlot) { continue; }

		// Output side: push into the `links` array (fan-out).
		if (!Array.isArray(oSlot.links)) { (oSlot as { links: number[] }).links = []; }
		if (!(oSlot.links as number[]).includes(lk.id)) {
			(oSlot.links as number[]).push(lk.id);
			repaired++;
		}
		// Input side: assign the SINGULAR `link` id — this is what
		// drawConnections reads to render the wire.
		if ((tSlot as { link: number | null }).link !== lk.id) {
			(tSlot as { link: number | null }).link = lk.id;
			repaired++;
		}
	}
	if (repaired > 0) {
		// eslint-disable-next-line no-console
		console.warn(`[repairLinksAfterConfigure] registered ${repaired} slot-link references across ${entries.length} links`);
	}
}

/** Store → graph: configure from workflow JSON via the adapter. */
function syncStoreToGraph(
	graph: LGraph,
	storeNodes: Array<{ id: string; type: string; position: { x: number; y: number }; data?: Record<string, unknown>; style?: { width?: number; height?: number } }>,
	storeEdges: Array<{ id: string; source: string; target: string }>,
	existingGroups?: Array<Record<string, unknown>>,
	liteCanvas?: LGraphCanvas | null,
): void {
	// 诊断：打印同步的 nodes/edges 数量，帮助排查 action 创建节点后连线丢失
	// eslint-disable-next-line no-console
	console.warn('[syncStoreToGraph] nodes=', storeNodes.length, 'edges=', storeEdges.length,
		'edgeIds=', storeEdges.map(e => `${e.source}->${e.target}`));
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
		// ⚠ 保留端口名，否则 toLiteGraph 无法推断正确的源/目标 slot
		fromPort: e.sourceHandle ?? undefined,
		toPort: e.targetHandle ?? undefined,
	}));
	const { graph: serialized } = toLiteGraph(wfNodes, wfConnections);
	// Drop any node without a registered LiteGraph spec — LiteGraph has no way
	// to render them and would draw a giant empty rectangle with resize handles.
	// Saros.* nodes ARE registered (see sarosLiteGraphNodes.ts) so they pass
	// the filter. See canvasNodeFilter tests.
	const filtered = filterNodesForLiteGraph(serialized, t => getNodeSpec(t) !== undefined);
	// DOM-card "消失" 诊断：store→graph 同步时被过滤掉的节点（spec 未注册）。
	// 首次渲染时序 bug（ComfyTV 未注册就 configure）会让所有 schema 节点
	// 在这里被丢弃 → 卡片从未挂载 / 之后某次 resync 又消失。
	if (filtered.dropped?.length) {
		// eslint-disable-next-line no-console
		console.warn('[syncStoreToGraph] dropped nodes ' + JSON.stringify(filtered.dropped.map(d => d.type)));
	}
	// ── Preserve height-feedback state across configure() (#59) ──────────
	// graph.configure() REBUILDS every node from the serialized spec, which
	// re-runs each node's constructor → addDOMWidget → userHeight = estimate
	// (≈114px). This silently discards the measured height from the
	// height-feedback loop (e.g. 291px) and causes the node to collapse /
	// flicker on every store↔graph sync (drag-end, action spawn, etc).
	// Fix: snapshot userHeight keyed by __sarosId, restore it after configure.
	const savedHeights = new Map<string, number>();
	for (const existing of graph._nodes) {
		const sid = (existing.properties as Record<string, unknown> | undefined)?.__sarosId as string | undefined;
		if (!sid) { continue; }
		const w = (existing.widgets as Array<{ type?: string; userHeight?: number }> | undefined)?.find(w => w.type === 'dom');
		if (w?.userHeight !== undefined) { savedHeights.set(sid, w.userHeight); }
	}
	// Preserve selection across the rebuild (#选中高亮一闪消失): configure()
	// recreates every node, so lc.selected_nodes would point at dead nodes.
	const savedSelection = snapshotSelection(liteCanvas);
	// 诊断：configure 前的序列化图里是否真的带上了本文要连的 link
	// eslint-disable-next-line no-console
	console.warn('[syncStoreToGraph] BEFORE configure: keep.links.length=', (filtered.keep.links as unknown[] | undefined)?.length ?? 0,
		'keep.links=', JSON.stringify(filtered.keep.links ?? []));
	graph.configure({
		...filtered.keep,
		id: 'wf',
		groups: [...(filtered.keep.groups ?? []), ...(existingGroups ?? [])],
	} as Parameters<LGraph['configure']>[0]);
	// Restore measured heights; mark dirty so the next rAF re-measures precisely
	// (content may have changed since the snapshot, e.g. an expanded action panel).
	for (const rebuilt of graph._nodes) {
		const sid = (rebuilt.properties as Record<string, unknown> | undefined)?.__sarosId as string | undefined;
		if (!sid) { continue; }
		const h = savedHeights.get(sid);
		if (h === undefined) { continue; }
		const w = (rebuilt.widgets as Array<{ type?: string; userHeight?: number }> | undefined)?.find(w => w.type === 'dom');
		if (w) { w.userHeight = h; }
		markFormHeightDirty(sid);
	}
	// Restore selection (rebind lc.selected_nodes to the rebuilt nodes).
	restoreSelection(graph, liteCanvas, savedSelection);
	// 诊断：configure 后验证连线是否真的存在于 graph.links，以及两端节点是否
	// 把 link 注册到了 outputs[srcSlot].links / inputs[tgtSlot].links。
	const rawLinks = (graph as unknown as { links?: unknown }).links;
	const liveLinks: Array<{ id: number; origin_id?: number; target_id?: number; origin_slot?: number; target_slot?: number }> =
		rawLinks instanceof Map ? [...(rawLinks as Map<number, { id: number; origin_id?: number; target_id?: number; origin_slot?: number; target_slot?: number }>).values()]
			: Array.isArray(rawLinks) ? (rawLinks as Array<{ id: number; origin_id?: number; target_id?: number; origin_slot?: number; target_slot?: number }>) : [];
	// eslint-disable-next-line no-console
	console.warn('[syncStoreToGraph] after configure: graph.links is', rawLinks instanceof Map ? 'Map' : Array.isArray(rawLinks) ? 'array' : typeof rawLinks, 'count=', liveLinks.length);
	for (const lk of liveLinks) {
		const oNode = graph.getNodeById?.(lk.origin_id as number);
		const tNode = graph.getNodeById?.(lk.target_id as number);
		const oSlot = oNode?.outputs?.[lk.origin_slot as number];
		const tSlot = tNode?.inputs?.[lk.target_slot as number];
		const oOk = !!oSlot;
		const tOk = !!tSlot;
		// 节点是否把该 link 注册到 outputs[slot].links / inputs[slot].links ——
		// 这才是 LiteGraph 实际绘制连线、以及 picker 经图遍历取上游的依据。
		const oLinked = !!oSlot?.links?.includes?.(lk.id);
		const tLinked = (tSlot as { link?: number | null } | undefined)?.link === lk.id;
		// eslint-disable-next-line no-console
		console.warn('[syncStoreToGraph] LINK', JSON.stringify({
			id: lk.id, origin: lk.origin_id, origin_slot: lk.origin_slot,
			target: lk.target_id, target_slot: lk.target_slot,
			originNodeType: (oNode as unknown as { type?: string })?.type,
			targetNodeType: (tNode as unknown as { type?: string })?.type,
			originSlotExists: oOk, targetSlotExists: tOk,
			originRegistered: oLinked, targetRegistered: tLinked,
			originSlotName: oSlot?.name,
			targetSlotName: tSlot?.name,
		}));
	}
	// ── Post-configure link repair ──────────────────────────────────────
	// graph.configure() 在 LiteGraph 0.17 中有时不会将 link 正确注册到
	// node.outputs[slot].links / node.inputs[slot].links，导致连线不渲染且
	// picker 无法通过图遍历找到上游。此处遍历 graph.links 并手动补注册。
	repairLinksAfterConfigure(graph);
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
