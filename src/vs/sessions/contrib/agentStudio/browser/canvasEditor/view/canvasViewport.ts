/*---------------------------------------------------------------------------------------------
 *  Saros Agents — Canvas Viewport
 *
 *  Pan/zoom 容器 + DOM 节点渲染 + SVG 边渲染 + 交互。
 *  对齐 Mindvas Canvas API 的交互模型（选择、拖拽、子树拖拽、内联编辑）。
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../../base/browser/dom.js';
import type { IMindmapData, IMindmapEdge } from '../../../common/mindmap/mindmapTypes.js';
import { getVisibleNodeIds, getGroupMemberIds } from '../../../common/mindmap/treeModel.js';
import { LayoutEngine } from '../../../common/mindmap/layoutEngine.js';

// ═══════════════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════════════

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
/** 节点高度自动适配内容时的上限（超过则出现内部滚动条），复刻 infinite_canvas_vscode 的可滚动节点 */
const MAX_AUTO_NODE_HEIGHT = 600;

/**
 * 视觉常量 —— 与 infinite_canvas_vscode（webview/src/InfiniteCanvasSimple.js）1:1 对齐。
 * 该参考实现使用 Canvas 2D 立即模式绘制；此处以 DOM/SVG 复刻其外观与交互，
 * 因此所有色值 / 尺寸 / 阈值均直接沿用参考实现中的硬编码常量。
 */
const CANVAS_STYLE = {
	/** 背景网格：50px 方格，线色 #333 */
	gridSize: 50,
	gridColor: '#333333',

	/** 文本节点 */
	nodeBg: '#3c3c3c',
	nodeBorder: '#414141',
	nodeText: '#cccccc',
	nodeRadius: 12,
	nodeFontSize: 16,
	nodePadding: 10,

	/** 文件节点 */
	fileNodeBg: '#2d2d2d',
	fileNodeBorder: '#4a5568',
	fileHeaderBg: '#1e1e1e',
	fileHeaderHeight: 40,

	/** 选中态 */
	selectionColor: '#007fd4',
	selectionWidth: 2,

	/** 连接点（四向） */
	connectPointColor: '#22c55e',
	connectPointHover: '#10b981',
	connectPointRadius: 12,
	connectPointHoverRadius: 16,

	/** 连线 */
	edgeColor: '#569cd6',
	edgeSelectedColor: '#2196f3',
	edgeWidth: 2,
	edgeSelectedWidth: 3,
	/** 箭头长度（连线末端在节点前 arrowOffset 处收笔） */
	arrowLength: 18,
	arrowOffset: 16,

	/** 框选矩形 */
	selectRectFill: 'rgba(59, 130, 246, 0.1)',
	selectRectStroke: '#3b82f6',

	/** Resize 手柄 */
	resizeHandleSize: 8,

	/** Markdown 标题色与字号（h1..h6） */
	headingColor: '#4a9eff',
	headingSizes: [22, 20, 18, 17, 16, 15],
	mutedColor: '#888888',
} as const;

/** 8 向 resize 手柄 */
type ResizeDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
/** 4 向连接点 */
type ConnectSide = 'top' | 'right' | 'bottom' | 'left';

// ═══════════════════════════════════════════════════════════════════════════
// CanvasViewport
// ═══════════════════════════════════════════════════════════════════════════

function formatTick(v: number): string {
	const abs = Math.abs(v);
	if (abs >= 10000) { return (v / 1000).toFixed(0) + 'k'; }
	if (abs >= 1000) { return (v / 1000).toFixed(1) + 'k'; }
	return String(Math.round(v));
}

export class CanvasViewport {

	readonly container: HTMLElement;
	private _gridEl!: HTMLElement;
	private _viewport: HTMLElement;
	private _nodeLayer: HTMLElement;
	private _svgLayer: SVGElement;
	private _svgEdgesGroup: SVGElement;

	// Pan/zoom state
	private _panX = 0;
	private _panY = 0;
	private _zoom = 1;
	private _isPanning = false;
	private _panStartX = 0;
	private _panStartY = 0;
	private _panOriginX = 0;
	private _panOriginY = 0;

	// Node → element mapping
	private _nodeEls = new Map<string, HTMLElement>();
	// Edge → path element mapping
	private _edgePaths = new Map<string, SVGPathElement>();

	// 手动 resize 过的节点（不再自动适配高度，复刻参考实现「可手动调整尺寸」的行为）
	private _manualSizeNodes = new Set<string>();
	// 记录上次 setRenderData 的数据引用，切换文件时清空手动尺寸集合
	private _lastDataRef: IMindmapData | null = null;

	// Selection state
	private _selectedNodeIds = new Set<string>();
	private _editingNodeId: string | null = null;

	// Drag state
	private _dragNodeId: string | null = null;
	private _dragStartX = 0;
	private _dragStartY = 0;
	private _dragNodeOrigX = 0;
	private _dragNodeOrigY = 0;
	/** Subtree descendants (for subtree drag) */
	private _subtreeDescendantIds: Set<string> | null = null;
	/** 是否已超过拖拽阈值（避免点击误触发） */
	private _dragActive = false;
	private _dragThreshold = 4;

	// Box-selection (rubber band) state
	private _isSelecting = false;
	private _selStartX = 0;
	private _selStartY = 0;
	private _selectionBoxEl: HTMLElement | null = null;

	// minimap + ruler（复刻无限画布概览与标尺）
	private _minimapEl: HTMLDivElement | null = null;
	private _minimapSvg: SVGSVGElement | null = null;
	private _minimapContentG: SVGGElement | null = null;
	private _minimapViewportRect: SVGRectElement | null = null;
	private _minimapScale = 1;
	private _minimapOffsetX = 0;
	private _minimapOffsetY = 0;
	private _rulerTopSvg: SVGSVGElement | null = null;
	private _rulerLeftSvg: SVGSVGElement | null = null;

	// Free-connect (drag from node handle to create edge) state
	private _connectFromId: string | null = null;
	private _connectHoveredId: string | null = null;
	private _connectLineEl: SVGPathElement | null = null;

	// Hover state
	private _hoverNodeId: string | null = null;

	// Callbacks
	onNodeClick: ((nodeId: string, e: MouseEvent) => void) | null = null;
	onNodeDblClick: ((nodeId: string) => void) | null = null;
	onNodeDragEnd: ((nodeId: string, x: number, y: number, subtreeIds: string[]) => void) | null = null;
	onNodeTextChanged: ((nodeId: string, text: string) => void) | null = null;
	onBackgroundClick: (() => void) | null = null;
	onBackgroundDblClick: ((x: number, y: number) => void) | null = null;
	onEdgeHandleClick: ((edgeId: string, fromNodeId: string, toNodeId: string) => void) | null = null;
	onSelectionEnd: ((ids: string[]) => void) | null = null;
	onConnectEnd: ((fromNodeId: string, toNodeId: string) => void) | null = null;
	onHoverNode: ((nodeId: string | null) => void) | null = null;
	/** 键盘快捷键路由：viewport 捕获到非 Escape 按键且非编辑态时回调，由 Pane 决定如何响应。返回 true 表示已消费（已 preventDefault/stopPropagation）。 */
	onKeyDown: ((e: KeyboardEvent) => boolean) | null = null;
	/** 节点引用链接（node:<id>）被点击时回调，由 Pane 跳转/聚焦目标节点。 */
	onNodeLinkClick: ((nodeId: string) => void) | null = null;
	/** 折叠/展开角标点击（节点 id）。 */
	onToggleExpand: ((nodeId: string) => void) | null = null;
	/** 节点 resize 结束：尺寸已由 viewport 直接写回数据节点，Pane 负责刷新与持久化。 */
	onNodeResizeEnd: ((nodeId: string, width: number, height: number) => void) | null = null;
	/** Ctrl+点击节点 → 跳转到源码（节点 id）。 */
	onNavigateToSource: ((nodeId: string) => void) | null = null;
	/** 连线选中变化（null 表示取消选中）。 */
	onEdgeSelect: ((edgeId: string | null) => void) | null = null;
	/** 请求删除当前选中的连线（Delete/Backspace 触发）。 */
	onEdgeDeleteRequest: ((edgeId: string) => void) | null = null;
	/** 活动节点变化（视口中心最近节点，pan/zoom/适应 时触发），供大纲双向高亮。 */
	onActiveNodeChange: ((nodeId: string | null) => void) | null = null;

	// Resize state（8 向手柄拖拽改 width/height）
	private _resizeNodeId: string | null = null;
	private _resizeHandle: ResizeDir | null = null;
	private _resizeOrig: { x: number; y: number; width: number; height: number } | null = null;
	private _resizeStartX = 0;
	private _resizeStartY = 0;
	// 最小尺寸对齐参考实现 handleResize 的 minWidth/minHeight
	private readonly _resizeMinW = 100;
	private readonly _resizeMinH = 60;

	// Group（分组）图层与元素：半透明包围盒，置于节点层之下
	private _groupLayer!: HTMLElement;
	private _groupEls = new Map<string, HTMLElement>();
	// 当前「活动」节点（视口中心最近节点），用于大纲双向高亮
	private _activeNodeId: string | null = null;

	constructor(parent: HTMLElement) {
		this.container = DOM.$('div.canvas-viewport');
		// 可聚焦：键盘快捷键（Tab/Shift+Enter/Del/方向键等）依赖容器获得焦点才能触发
		this.container.tabIndex = 0;
		this.container.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background);cursor:grab;user-select:none;outline:none;';

		// Viewport (transform container)
		// 注意：必须有真实尺寸（100%×100%），否则作为子元素的 SVG 边层
		// （width:100%;height:100%）会得到 0×0 的 SVG viewport，从而裁剪掉所有连线路径，
		// 表现为「节点可见但连线不显示」。pointer-events:none 让空白处的事件落到
		// 外层父级（pan/zoom 监听在 parent 的 capture 阶段，不受影响）；节点 div 自身
		// 用 pointer-events:all 重新接收事件。
		// 背景网格层：置于 container（未变换）上，随 transform 更新 background-size/position。
		// 这样网格线始终保持 1 屏幕像素粗细（等价于参考实现的 ctx.lineWidth = 1 / scale），
		// 若放在被 scale 的 _viewport 上，高倍缩放时网格线会被一起放粗。
		this._gridEl = DOM.$('div.canvas-grid-layer');
		this._gridEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
		this.container.appendChild(this._gridEl);

		this._viewport = DOM.$('div.canvas-viewport-transform');
		this._viewport.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;transform-origin:0 0;z-index:1;';

		// Node layer
		this._nodeLayer = DOM.$('div.canvas-node-layer');
		this._nodeLayer.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;';

		// SVG edge layer
		this._svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this._svgLayer.setAttribute('class', 'canvas-edge-layer');
		this._svgLayer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
		// 箭头 marker —— 复刻参考实现 drawArrowhead：
		//   长度 18、张角 ±π/6、尾部带 0.6 倍内凹缺口（凹形箭头），fill #569cd6。
		//   局部坐标（尖端在原点、指向 +x）：tip(0,0) / (-15.59,+9) / (-10.8,0) / (-15.59,-9)
		//   平移 +18 后得到 viewBox 0..18，refX=18（尖端对齐路径终点）。
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		defs.appendChild(this._createArrowMarker('canvas-edge-arrow', CANVAS_STYLE.edgeColor));
		defs.appendChild(this._createArrowMarker('canvas-edge-arrow-selected', CANVAS_STYLE.edgeSelectedColor));
		this._svgLayer.appendChild(defs);
		this._svgEdgesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this._svgLayer.appendChild(this._svgEdgesGroup);

		this._viewport.appendChild(this._nodeLayer);
		this._viewport.appendChild(this._svgLayer);

		// 临时连接线（自由连接时显示，跟随 viewport 变换）
		this._connectLineEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		this._connectLineEl.setAttribute('fill', 'none');
		this._connectLineEl.setAttribute('stroke', CANVAS_STYLE.connectPointHover);
		this._connectLineEl.setAttribute('stroke-width', '2');
		this._connectLineEl.setAttribute('stroke-dasharray', '5 5');
		this._connectLineEl.style.opacity = '0';
		this._connectLineEl.style.pointerEvents = 'none';
		this._svgEdgesGroup.appendChild(this._connectLineEl);

		// 框选矩形（覆盖层，屏幕坐标，不随 viewport 变换）
		this._selectionBoxEl = DOM.$('div.canvas-selection-box');
		this._selectionBoxEl.style.cssText = 'position:absolute;border:1px dashed ' + CANVAS_STYLE.selectRectStroke + ';' +
			'background:' + CANVAS_STYLE.selectRectFill + ';display:none;pointer-events:none;z-index:50;';
		this.container.appendChild(this._selectionBoxEl);

		this.container.appendChild(this._viewport);
		// 关键：把 container 挂到父容器，否则整个画布层脱离文档树（节点/边都在 container 内）
		// 导致编辑器打开后画布空白（仅工具条可见）。此前遗漏此挂载步骤。
		parent.appendChild(this.container);

		// Event bindings
		this._bindEvents(parent);

		// minimap + ruler（复刻无限画布概览 / 标尺）
		this._createMinimap();
		this._createRulers();

		this._updateTransform();
	}

	// ── 变换 ───────────────────────────────────────────────────────────

	private _updateTransform(): void {
		this._viewport.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
		this._updateGrid();
		this._updateMinimapViewport();
		this._updateRulers();
		this._updateActiveNode();
	}

	// ── 活动节点（大纲双向高亮）──────────────────────────────────────

	private _updateActiveNode(): void {
		if (!this._lastRenderData) { return; }
		const center = this.getViewportCenter();
		let bestId: string | null = null;
		let bestDist = Infinity;
		for (const n of this._lastRenderData.nodes) {
			if (n.type === 'group') { continue; }
			const cx = (n.x ?? 0) + (n.width ?? 0) / 2;
			const cy = (n.y ?? 0) + (n.height ?? 0) / 2;
			const d = (cx - center.x) ** 2 + (cy - center.y) ** 2;
			if (d < bestDist) { bestDist = d; bestId = n.id; }
		}
		if (bestId !== this._activeNodeId) {
			this._activeNodeId = bestId;
			this._applyActiveClass(bestId);
			this.onActiveNodeChange?.(bestId);
		}
	}

	private _applyActiveClass(id: string | null): void {
		for (const [nid, el] of this._nodeEls) {
			el.classList.toggle('canvas-node-active', nid === id);
		}
	}

	/** 外部（大纲 hover）设置活动节点：仅高亮节点，不反向触发 onActiveNodeChange 以免回环。 */
	setActiveNodeId(id: string | null): void {
		if (id === this._activeNodeId) { return; }
		this._activeNodeId = id;
		this._applyActiveClass(id);
	}

	/**
	 * 网格绘制 —— 复刻参考实现 drawGrid：50px 世界单位方格、线色 #333、线宽恒 1 屏幕像素。
	 * 这里用两组 1px 的 linear-gradient 模拟纵横线，间距随 zoom 缩放、相位随 pan 平移。
	 */
	private _updateGrid(): void {
		if (!this._gridEl) { return; }
		const step = CANVAS_STYLE.gridSize * this._zoom;
		// 缩放过小时网格会变成噪点，参考实现同样会因线太密而糊，这里直接隐藏
		if (step < 6) {
			this._gridEl.style.backgroundImage = 'none';
			return;
		}
		const c = CANVAS_STYLE.gridColor;
		this._gridEl.style.backgroundImage =
			`linear-gradient(to right, ${c} 1px, transparent 1px),` +
			`linear-gradient(to bottom, ${c} 1px, transparent 1px)`;
		this._gridEl.style.backgroundSize = `${step}px ${step}px`;
		this._gridEl.style.backgroundPosition = `${this._panX % step}px ${this._panY % step}px`;
	}

	/** 当前视口中心对应的画布世界坐标（粘贴落点等使用） */
	getViewportCenter(): { x: number; y: number } {
		const rect = this.container.getBoundingClientRect();
		return {
			x: (rect.width / 2 - this._panX) / this._zoom,
			y: (rect.height / 2 - this._panY) / this._zoom,
		};
	}

	/** 生成凹形箭头 marker（复刻 drawArrowhead 的几何） */
	private _createArrowMarker(id: string, color: string): SVGMarkerElement {
		const L = CANVAS_STYLE.arrowLength;
		const a = Math.PI / 6;
		const half = L * Math.sin(a);              // 9
		const backX = L - L * Math.cos(a);         // 18 - 15.588 = 2.412
		const notchX = L - L * 0.6;                // 18 - 10.8 = 7.2
		const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
		marker.setAttribute('id', id);
		marker.setAttribute('viewBox', `0 0 ${L} ${half * 2}`);
		marker.setAttribute('refX', String(L));
		marker.setAttribute('refY', String(half));
		marker.setAttribute('markerWidth', String(L / 2));
		marker.setAttribute('markerHeight', String(half));
		marker.setAttribute('orient', 'auto-start-reverse');
		marker.setAttribute('markerUnits', 'strokeWidth');
		const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p.setAttribute('d', `M${L},${half} L${backX},${half * 2} L${notchX},${half} L${backX},0 Z`);
		p.setAttribute('fill', color);
		marker.appendChild(p);
		return marker;
	}

	get panX(): number { return this._panX; }
	get panY(): number { return this._panY; }
	get zoom(): number { return this._zoom; }

	// ── minimap / ruler（复刻无限画布概览与标尺）─────────────────────────

	/** 将视口中心移动到指定世界坐标（保持当前缩放），minimap 点击/拖拽导航使用 */
	centerOnWorldPoint(wx: number, wy: number): void {
		const rect = this.container.getBoundingClientRect();
		this._panX = rect.width / 2 - wx * this._zoom;
		this._panY = rect.height / 2 - wy * this._zoom;
		this._updateTransform();
	}

	/** 容器尺寸变化后重绘 minimap 内容 + 标尺（pane layout 时调用） */
	relayout(): void {
		this._renderMinimap();
		this._updateRulers();
	}

	private _createMinimap(): void {
		const SVGNS = 'http://www.w3.org/2000/svg';
		const el = document.createElement('div');
		el.className = 'canvas-minimap';
		const svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
		svg.setAttribute('width', '100%');
		svg.setAttribute('height', '100%');
		const g = document.createElementNS(SVGNS, 'g') as SVGGElement;
		svg.appendChild(g);
		const vpRect = document.createElementNS(SVGNS, 'rect') as SVGRectElement;
		vpRect.setAttribute('class', 'mm-viewport');
		svg.appendChild(vpRect);
		el.appendChild(svg);
		el.addEventListener('pointerdown', (e: PointerEvent) => {
			e.stopPropagation();
			this._onMinimapPointer(e);
		});
		el.addEventListener('wheel', (e: WheelEvent) => { e.stopPropagation(); }, { passive: true });
		el.addEventListener('dblclick', (e: MouseEvent) => { e.stopPropagation(); });
		this.container.appendChild(el);
		this._minimapEl = el;
		this._minimapSvg = svg;
		this._minimapContentG = g;
		this._minimapViewportRect = vpRect;
	}

	private _onMinimapPointer(e: PointerEvent): void {
		this._navigateFromMinimap(e);
		const move = (ev: PointerEvent) => this._navigateFromMinimap(ev);
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	private _navigateFromMinimap(e: PointerEvent): void {
		if (!this._minimapSvg) { return; }
		const r = this._minimapSvg.getBoundingClientRect();
		const lx = e.clientX - r.left;
		const ly = e.clientY - r.top;
		const wx = (lx - this._minimapOffsetX) / this._minimapScale;
		const wy = (ly - this._minimapOffsetY) / this._minimapScale;
		this.centerOnWorldPoint(wx, wy);
	}

	private _renderMinimap(): void {
		if (!this._minimapContentG || !this._minimapSvg || !this._lastRenderData) { return; }
		const nodes = this._lastRenderData.nodes;
		const edges = this._lastRenderData.edges;
		const mmW = this._minimapSvg.clientWidth || 220;
		const mmH = this._minimapSvg.clientHeight || 160;
		if (mmW === 0 || mmH === 0) { return; }

		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of nodes) {
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x + n.width);
			maxY = Math.max(maxY, n.y + n.height);
		}
		if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1000; maxY = 1000; }
		const cw = Math.max(maxX - minX, 1);
		const ch = Math.max(maxY - minY, 1);
		const margin = Math.max(cw, ch) * 0.12 + 40;
		minX -= margin; minY -= margin; maxX += margin; maxY += margin;
		const worldW = maxX - minX;
		const worldH = maxY - minY;
		const scale = Math.min(mmW / worldW, mmH / worldH);
		const offX = (mmW - worldW * scale) / 2 - minX * scale;
		const offY = (mmH - worldH * scale) / 2 - minY * scale;
		this._minimapScale = scale;
		this._minimapOffsetX = offX;
		this._minimapOffsetY = offY;

		const SVGNS = 'http://www.w3.org/2000/svg';
		const g = this._minimapContentG;
		while (g.firstChild) { g.removeChild(g.firstChild); }

		// 连线
		for (const e of edges) {
			const a = this._nodeDataMap.get(e.fromNode);
			const b = this._nodeDataMap.get(e.toNode);
			if (!a || !b) { continue; }
			const line = document.createElementNS(SVGNS, 'line') as SVGLineElement;
			line.setAttribute('class', 'mm-edge');
			line.setAttribute('x1', String(offX + (a.x + a.width / 2) * scale));
			line.setAttribute('y1', String(offY + (a.y + a.height / 2) * scale));
			line.setAttribute('x2', String(offX + (b.x + b.width / 2) * scale));
			line.setAttribute('y2', String(offY + (b.y + b.height / 2) * scale));
			g.appendChild(line);
		}
		// 节点（含 group）
		for (const n of nodes) {
			const rect = document.createElementNS(SVGNS, 'rect') as SVGRectElement;
			const selected = this._selectedNodeIds.has(n.id);
			rect.setAttribute('class', selected ? 'mm-node mm-node--selected' : 'mm-node');
			rect.setAttribute('x', String(offX + n.x * scale));
			rect.setAttribute('y', String(offY + n.y * scale));
			rect.setAttribute('width', String(Math.max(n.width * scale, 2)));
			rect.setAttribute('height', String(Math.max(n.height * scale, 2)));
			rect.setAttribute('rx', '1');
			g.appendChild(rect);
		}
		this._updateMinimapViewport();
	}

	private _updateMinimapViewport(): void {
		if (!this._minimapViewportRect) { return; }
		const rect = this.container.getBoundingClientRect();
		const vw = rect.width || 1;
		const vh = rect.height || 1;
		const wx1 = -this._panX / this._zoom;
		const wy1 = -this._panY / this._zoom;
		const wx2 = (vw - this._panX) / this._zoom;
		const wy2 = (vh - this._panY) / this._zoom;
		const x = this._minimapOffsetX + wx1 * this._minimapScale;
		const y = this._minimapOffsetY + wy1 * this._minimapScale;
		const w = (wx2 - wx1) * this._minimapScale;
		const h = (wy2 - wy1) * this._minimapScale;
		this._minimapViewportRect.setAttribute('x', String(x));
		this._minimapViewportRect.setAttribute('y', String(y));
		this._minimapViewportRect.setAttribute('width', String(Math.max(w, 2)));
		this._minimapViewportRect.setAttribute('height', String(Math.max(h, 2)));
	}

	private _createRulers(): void {
		const SVGNS = 'http://www.w3.org/2000/svg';
		const top = document.createElement('div');
		top.className = 'canvas-ruler canvas-ruler--top';
		const topSvg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
		top.appendChild(topSvg);
		const left = document.createElement('div');
		left.className = 'canvas-ruler canvas-ruler--left';
		const leftSvg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
		left.appendChild(leftSvg);
		const corner = document.createElement('div');
		corner.className = 'canvas-ruler--corner';
		this.container.appendChild(top);
		this.container.appendChild(left);
		this.container.appendChild(corner);
		this._rulerTopSvg = topSvg;
		this._rulerLeftSvg = leftSvg;
	}

	private _updateRulers(): void {
		if (!this._rulerTopSvg || !this._rulerLeftSvg) { return; }
		const rect = this.container.getBoundingClientRect();
		const vw = rect.width || 1;
		const vh = rect.height || 1;
		const TOP_H = 22;
		const LEFT_W = 22;
		const SVGNS = 'http://www.w3.org/2000/svg';

		// 自适应步长：屏幕 ~90px 对应一个整刻度
		const niceStep = (x: number): number => {
			if (x <= 0) { return 1; }
			const exp = Math.floor(Math.log10(x));
			const base = Math.pow(10, exp);
			const f = x / base;
			let n: number;
			if (f < 1.5) { n = 1; } else if (f < 3) { n = 2; } else if (f < 7) { n = 5; } else { n = 10; }
			return n * base;
		};
		const step = niceStep(90 / this._zoom);

		// 顶部标尺
		const topSvg = this._rulerTopSvg;
		while (topSvg.firstChild) { topSvg.removeChild(topSvg.firstChild); }
		topSvg.setAttribute('width', String(vw));
		topSvg.setAttribute('height', String(TOP_H));
		const startWX = -this._panX / this._zoom;
		const endWX = (vw - this._panX) / this._zoom;
		const firstWX = Math.floor(startWX / step) * step;
		for (let wx = firstWX; wx <= endWX; wx += step) {
			const sx = wx * this._zoom + this._panX;
			if (sx < LEFT_W) { continue; }
			const line = document.createElementNS(SVGNS, 'line') as SVGLineElement;
			line.setAttribute('class', 'tick tick-major');
			line.setAttribute('x1', String(sx));
			line.setAttribute('y1', String(TOP_H - 6));
			line.setAttribute('x2', String(sx));
			line.setAttribute('y2', String(TOP_H));
			topSvg.appendChild(line);
			const text = document.createElementNS(SVGNS, 'text') as SVGTextElement;
			text.setAttribute('class', 'label');
			text.setAttribute('x', String(sx + 2));
			text.setAttribute('y', String(TOP_H - 8));
			text.textContent = formatTick(wx);
			topSvg.appendChild(text);
		}

		// 左侧标尺
		const leftSvg = this._rulerLeftSvg;
		while (leftSvg.firstChild) { leftSvg.removeChild(leftSvg.firstChild); }
		leftSvg.setAttribute('width', String(LEFT_W));
		leftSvg.setAttribute('height', String(vh));
		const startWY = -this._panY / this._zoom;
		const endWY = (vh - this._panY) / this._zoom;
		const firstWY = Math.floor(startWY / step) * step;
		for (let wy = firstWY; wy <= endWY; wy += step) {
			const sy = wy * this._zoom + this._panY;
			if (sy < TOP_H) { continue; }
			const line = document.createElementNS(SVGNS, 'line') as SVGLineElement;
			line.setAttribute('class', 'tick tick-major');
			line.setAttribute('x1', String(LEFT_W - 6));
			line.setAttribute('y1', String(sy));
			line.setAttribute('x2', String(LEFT_W));
			line.setAttribute('y2', String(sy));
			leftSvg.appendChild(line);
			const text = document.createElementNS(SVGNS, 'text') as SVGTextElement;
			text.setAttribute('class', 'label');
			text.setAttribute('x', String(2));
			text.setAttribute('y', String(sy - 2));
			text.textContent = formatTick(wy);
			leftSvg.appendChild(text);
		}
	}

	zoomTo(x: number, y: number, z: number): void {
		this._zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
		this._panX = x;
		this._panY = y;
		this._updateTransform();
	}

		centerOn(bounds: { minX: number; minY: number; maxX: number; maxY: number }, padding = 50): void {
		const w = bounds.maxX - bounds.minX + padding * 2;
		const h = bounds.maxY - bounds.minY + padding * 2;
		const rect = this.container.getBoundingClientRect();
		// 容器尚未完成布局（宽高为 0，如 EditorPane.setInput 期间尚未 layout）时跳过，
		// 避免 zoom 被算成 0 导致整个画布 scale(0) 不可见；待 EditorPane.layout() 拿到
		// 真实尺寸后再调用 _fitViewport 重新自适应。
		if (rect.width === 0 || rect.height === 0) { return; }
		const zoomX = rect.width / w;
		const zoomY = rect.height / h;
		this._zoom = Math.min(zoomX, zoomY, 1);
		this._panX = -bounds.minX * this._zoom + (rect.width - w * this._zoom) / 2 + padding * this._zoom;
		this._panY = -bounds.minY * this._zoom + (rect.height - h * this._zoom) / 2 + padding * this._zoom;
		this._updateTransform();
	}

	// ── 节点渲染 ───────────────────────────────────────────────────────

	syncNodes(data: IMindmapData, selectedIds: Set<string>, editingId: string | null): void {
		this._lastRenderData = data;
		// 切换到不同文件时清空「手动 resize」标记，恢复内容自适应高度
		if (data !== this._lastDataRef) {
			this._manualSizeNodes.clear();
			this._lastDataRef = data;
		}
		this._selectedNodeIds = selectedIds;
		this._editingNodeId = editingId;

		// 始终用最新数据刷新节点数据表，否则新增子/兄节点不在表中，
		// 拖拽时 _dragOrigCoords 为空导致无法拖动（setRenderData 之外也必须同步）。
		this._nodeDataMap.clear();
		for (const n of data.nodes) { this._nodeDataMap.set(n.id, n); }

		const dataNodeIds = new Set(data.nodes.map(n => n.id));
		const visible = getVisibleNodeIds(data);

		// 移除已删除或折叠隐藏的节点
		for (const [id, el] of this._nodeEls) {
			if (!dataNodeIds.has(id) || !visible.has(id)) {
				el.remove();
				this._nodeEls.delete(id);
			}
		}

		// 创建/更新节点
		let heightChanged = false;
		for (const node of data.nodes) {
			if (node.type === 'group') { continue; } // groups rendered separately
			if (!visible.has(node.id)) { continue; } // 折叠隐藏的后代不渲染
			const hasChildren = data.edges.some(e => e.fromNode === node.id);
			let el = this._nodeEls.get(node.id);
			if (!el) {
				el = this._createNodeElement(node);
				this._nodeLayer.appendChild(el);
				this._nodeEls.set(node.id, el);
			}
			this._updateNodeElement(el, node, hasChildren);

			// 自动按内容高度适配：复刻 infinite_canvas_vscode 的 createNodeWithText
			// （节点高度随文本自适应）。手动 resize 过的节点不覆盖，保留用户设定尺寸。
			if (this._editingNodeId !== node.id && !this._manualSizeNodes.has(node.id)) {
				const textEl = el.querySelector('.canvas-node-text') as HTMLElement | null;
				if (textEl) {
					const natural = textEl.scrollHeight;
					// 只增不减：内容超过当前高度才撑高；绝不把显式高度（如文件里的 80px）压小，
					// 否则会无谓触发重排、破坏文件原有布局（修复「布局混乱」）。
					const needed = Math.max(this._resizeMinH, Math.min(natural, MAX_AUTO_NODE_HEIGHT));
					const fitH = Math.max(node.height ?? 0, needed);
					if (Math.abs((node.height ?? 0) - fitH) > 1) {
						node.height = fitH;
						el.style.height = fitH + 'px';
						heightChanged = true;
					}
				}
			}
		}

		// 高度变化后重新布局，修正兄弟节点的垂直间距（避免重叠）；
		// 与参考实现「先测量文本高度、再布局」的顺序一致。
		// 仅当文件显式指定了布局方向时才自动重排；否则（带显式坐标的文件）保留原坐标，
		// 避免用默认方向重排而打散既有布局（修复「布局混乱」）。
		if (heightChanged && data.direction) {
			this._relayoutFromViewport(data);
		}

		// 渲染分组节点：半透明包围盒（由成员几何计算，实现「布局计算包围盒」），置于节点层之下。
		for (const node of data.nodes) {
			if (node.type !== 'group') { continue; }
			if (!visible.has(node.id)) { continue; }
			let gel = this._groupEls.get(node.id);
			if (!gel) {
				gel = this._createGroupElement(node);
				this._groupLayer.appendChild(gel);
				this._groupEls.set(node.id, gel);
			}
			this._updateGroupElement(gel, node, data);
		}

		// 更新边
		this._syncEdges(data, visible);

		this._renderMinimap();
	}

	/**
	 * 视口侧重新布局：自动适配高度导致节点尺寸变化后，用最新尺寸重排，
	 * 修正兄弟节点的垂直间距（避免重叠）。与参考实现「先测量文本高度、再布局」顺序一致。
	 * 不复用控制器布局引擎实例，默认配置与此处一致（控制器未调用 setConfig）。
	 */
	private _relayoutFromViewport(data: IMindmapData): void {
		const layout = new LayoutEngine().computeLayout(data);
		for (const [id, pos] of layout.positions) {
			const node = this._nodeDataMap.get(id);
			if (!node) { continue; }
			node.x = pos.x;
			node.y = pos.y;
			const el = this._nodeEls.get(id);
			if (el) {
				el.style.left = pos.x + 'px';
				el.style.top = pos.y + 'px';
			}
		}
	}

	// ── 分组（group）渲染 ───────────────────────────────────────────────

	private _createGroupElement(group: IMindmapData['nodes'][number]): HTMLElement {
		const el = document.createElement('div');
		el.className = 'canvas-group';
		el.setAttribute('data-group-id', group.id);
		el.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;border-radius:12px;z-index:0;';
		const label = document.createElement('div');
		label.className = 'canvas-group-label';
		label.style.cssText = 'position:absolute;top:-18px;left:6px;font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;';
		el.appendChild(label);
		return el;
	}

	private _updateGroupElement(el: HTMLElement, group: IMindmapData['nodes'][number], data: IMindmapData): void {
		const members = getGroupMemberIds(data, group.id);
		let x = group.x ?? 0;
		let y = group.y ?? 0;
		let w = group.width ?? 0;
		let h = group.height ?? 0;
		// 有成员时：包围盒 = 成员节点并集 + padding（对齐参考实现 createGroup 行为）。
		// 无成员时：保留节点自身的 width/height（来自 .canvas 文件或手动设定）。
		if (members.length > 0) {
			const pad = 24;
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const id of members) {
				const n = this._nodeDataMap.get(id);
				if (!n) { continue; }
				minX = Math.min(minX, n.x ?? 0);
				minY = Math.min(minY, n.y ?? 0);
				maxX = Math.max(maxX, (n.x ?? 0) + (n.width ?? 0));
				maxY = Math.max(maxY, (n.y ?? 0) + (n.height ?? 0));
			}
			x = minX - pad;
			y = minY - pad;
			w = (maxX - minX) + pad * 2;
			h = (maxY - minY) + pad * 2;
			group.x = x;
			group.y = y;
			group.width = w;
			group.height = h;
		}
		el.style.left = x + 'px';
		el.style.top = y + 'px';
		el.style.width = Math.max(w, 40) + 'px';
		el.style.height = Math.max(h, 40) + 'px';
		const label = el.querySelector('.canvas-group-label') as HTMLElement | null;
		if (label) { label.textContent = group.text || '分组'; }
		el.classList.toggle('selected', this._selectedNodeIds.has(group.id));
	}

	private _createNodeElement(node: { id: string }): HTMLElement {
		const el = DOM.$('div.canvas-node');
		el.dataset.nodeId = node.id;
		el.style.cssText = `position:absolute;border-radius:${CANVAS_STYLE.nodeRadius}px;border:1px solid ${CANVAS_STYLE.nodeBorder};` +
			`background:${CANVAS_STYLE.nodeBg};pointer-events:all;overflow:visible;transition:box-shadow .15s,border-color .15s;`;

		// 四向连接点（top/right/bottom/left）—— 复刻参考实现 drawConnectionPoints：
		// 绿色实心圆 #22c55e + 外发光 + 白色内点；hover 时放大并变为 #10b981。
		// 参考实现半径 12（hover 16），此处换算为直径 24px / 32px。
		const R = CANVAS_STYLE.connectPointRadius * 2;
		const mkHandle = (dir: ConnectSide): HTMLElement => {
			const h = DOM.$('div.canvas-connect-handle');
			h.dataset.nodeId = node.id;
			h.dataset.dir = dir;
			const off = -(R / 2) + 'px';
			const pos =
				dir === 'left' ? `left:${off};top:50%;transform:translateY(-50%);` :
				dir === 'right' ? `right:${off};top:50%;transform:translateY(-50%);` :
				dir === 'top' ? `top:${off};left:50%;transform:translateX(-50%);` :
				`bottom:${off};left:50%;transform:translateX(-50%);`;
			h.style.cssText = `position:absolute;${pos}width:${R}px;height:${R}px;border-radius:50%;` +
				`background:${CANVAS_STYLE.connectPointColor};box-shadow:0 0 12px rgba(34,197,94,0.8);` +
				'display:flex;align-items:center;justify-content:center;' +
				'opacity:0;pointer-events:all;cursor:crosshair;transition:opacity .12s,width .1s,height .1s,background .1s;z-index:6;';
			// 白色内点（参考实现 radius 3，hover 4）
			const inner = DOM.$('div.canvas-connect-dot');
			inner.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#ffffff;pointer-events:none;';
			h.appendChild(inner);
			return h;
		};
		el.appendChild(mkHandle('top'));
		el.appendChild(mkHandle('right'));
		el.appendChild(mkHandle('bottom'));
		el.appendChild(mkHandle('left'));

		// 折叠/展开角标：节点有后代时显示，点击切换子树折叠/展开
		const badge = DOM.$('div.canvas-collapse-badge');
		badge.dataset.nodeId = node.id;
		badge.style.cssText =
			'position:absolute;top:-9px;right:-9px;width:18px;height:18px;border-radius:50%;' +
			'background:var(--vscode-button-background);color:var(--vscode-button-foreground);' +
			'font-size:11px;line-height:18px;text-align:center;cursor:pointer;display:none;' +
			'align-items:center;justify-content:center;z-index:7;user-select:none;';
		el.appendChild(badge);

		// 源码跳转角标：仅当 node.source 存在时显示（见 _updateNodeElement），提示可 Ctrl+点击跳转
		const srcBadge = DOM.$('div.canvas-source-badge');
		srcBadge.dataset.nodeId = node.id;
		srcBadge.title = 'Ctrl+点击跳转到源码';
		srcBadge.style.cssText = 'position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;line-height:18px;text-align:center;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:6;user-select:none;';
		srcBadge.textContent = '↗';
		el.appendChild(srcBadge);

		// Resize 手柄（8 向：4 角 + 4 边中点）—— 复刻参考实现 drawResizeHandles：
		// 8×8 方块、填充 #007fd4、1px 白色描边；选中且非编辑时显示。
		const S = CANVAS_STYLE.resizeHandleSize;
		const half = -(S / 2) + 'px';
		const RESIZE_SPEC: Record<ResizeDir, { pos: string; cursor: string }> = {
			nw: { pos: `left:${half};top:${half};`, cursor: 'nwse-resize' },
			n: { pos: `left:50%;top:${half};margin-left:${half};`, cursor: 'ns-resize' },
			ne: { pos: `right:${half};top:${half};`, cursor: 'nesw-resize' },
			e: { pos: `right:${half};top:50%;margin-top:${half};`, cursor: 'ew-resize' },
			se: { pos: `right:${half};bottom:${half};`, cursor: 'nwse-resize' },
			s: { pos: `left:50%;bottom:${half};margin-left:${half};`, cursor: 'ns-resize' },
			sw: { pos: `left:${half};bottom:${half};`, cursor: 'nesw-resize' },
			w: { pos: `left:${half};top:50%;margin-top:${half};`, cursor: 'ew-resize' },
		};
		for (const dir of Object.keys(RESIZE_SPEC) as ResizeDir[]) {
			const spec = RESIZE_SPEC[dir];
			const h = DOM.$('div.canvas-resize-handle');
			h.dataset.nodeId = node.id;
			h.dataset.handle = dir;
			h.style.cssText = `position:absolute;${spec.pos}width:${S}px;height:${S}px;` +
				`background:${CANVAS_STYLE.selectionColor};border:1px solid #ffffff;box-sizing:border-box;` +
				`opacity:0;pointer-events:all;cursor:${spec.cursor};transition:opacity .12s;z-index:8;`;
			el.appendChild(h);
		}

		return el;
	}

	private _updateNodeElement(el: HTMLElement, node: { id: string; type?: 'text' | 'file' | 'link' | 'group'; x: number; y: number; width: number; height: number; text?: string; content?: string; file?: string; color?: string; expanded?: boolean; source?: { file: string; line?: number; column?: number } }, hasChildren: boolean): void {
		el.style.left = node.x + 'px';
		el.style.top = node.y + 'px';
		el.style.width = node.width + 'px';
		el.style.height = node.height + 'px';

		// 折叠/展开角标
		const badge = el.querySelector('.canvas-collapse-badge') as HTMLElement | null;
		if (badge) {
			if (hasChildren) {
				badge.style.display = 'flex';
				badge.textContent = node.expanded === false ? '▶' : '▼';
				badge.title = node.expanded === false ? '展开子树' : '折叠子树';
			} else {
				badge.style.display = 'none';
			}
		}

		const isSelected = this._selectedNodeIds.has(node.id);
		const isEditing = this._editingNodeId === node.id;

		// 背景 / 边框配色 —— 对齐参考实现：文件节点 #2d2d2d/#4a5568（2px），文本节点 #3c3c3c/#414141（1px）
		const isFile = node.type === 'file';
		if (isFile) {
			el.style.background = CANVAS_STYLE.fileNodeBg;
			el.style.borderColor = CANVAS_STYLE.fileNodeBorder;
		} else {
			el.style.background = CANVAS_STYLE.nodeBg;
			el.style.borderColor = node.color ? `var(--canvas-color-${node.color})` : CANVAS_STYLE.nodeBorder;
		}

		if (isSelected) {
			el.style.borderColor = CANVAS_STYLE.selectionColor;
			el.style.borderWidth = CANVAS_STYLE.selectionWidth + 'px';
			el.style.boxShadow = `0 0 0 1px ${CANVAS_STYLE.selectionColor}`;
		} else {
			el.style.borderWidth = isFile ? '2px' : '1px';
			el.style.boxShadow = 'none';
		}
		el.classList.toggle('selected', isSelected);

		// 文件节点表头（40px、#1e1e1e、📄 + 文件名）—— 复刻参考实现 drawFileNode 的 header
		if (isFile) {
			let header = el.querySelector('.canvas-file-header') as HTMLElement | null;
			if (!header) {
				header = DOM.$('div.canvas-file-header');
				header.style.cssText = `position:absolute;left:0;top:0;right:0;height:${CANVAS_STYLE.fileHeaderHeight}px;` +
					`background:${CANVAS_STYLE.fileHeaderBg};display:flex;align-items:center;gap:6px;` +
					'padding:0 10px;box-sizing:border-box;font-size:16px;font-weight:700;color:#cccccc;' +
					'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;z-index:2;';
				el.insertBefore(header, el.firstChild);
			}
			const fileName = (node.file || '').split(/[\\/]/).pop() || '未命名文件';
			header.replaceChildren(
				Object.assign(document.createElement('span'), { textContent: '📄' }),
				Object.assign(document.createElement('span'), { textContent: fileName })
			);
		} else {
			el.querySelector('.canvas-file-header')?.remove();
		}

		// resize 手柄：仅选中且非编辑时显示
		const showResize = isSelected && !isEditing;
		el.querySelectorAll('.canvas-resize-handle').forEach(h => {
			(h as HTMLElement).style.opacity = showResize ? '1' : '0';
			(h as HTMLElement).style.pointerEvents = showResize ? 'all' : 'none';
		});
		// 源码跳转角标：仅当 node.source 存在时显示
		const srcBadge = el.querySelector('.canvas-source-badge') as HTMLElement | null;
		if (srcBadge) {
			srcBadge.style.display = node.source ? 'flex' : 'none';
		}

		// Ensure contenteditable content
		const targetText = node.text || node.content || '';
		if (isEditing) {
			if (!el.getAttribute('contenteditable')) {
				el.setAttribute('contenteditable', 'true');
				el.style.whiteSpace = 'pre-wrap';
				el.style.wordBreak = 'break-word';
				el.style.outline = 'none';
				el.style.padding = '8px 12px';
				el.style.fontSize = '13px';
				el.style.lineHeight = '1.5';
				el.style.color = 'var(--vscode-editor-foreground)';
				if (el.textContent !== targetText) {
					el.textContent = targetText;
				}
				el.focus();
			}
		} else {
			if (el.getAttribute('contenteditable')) {
				el.removeAttribute('contenteditable');
				el.blur();
			}
			// Display as inert div with innerHTML-like content
			if (!el.querySelector('.canvas-node-text')) {
				const textEl = DOM.$('div.canvas-node-text');
				// 字号/内边距对齐参考实现（16px / 10px）；overflow:auto + 自定义滚动条复刻节点内滚动
				textEl.style.cssText = `padding:${CANVAS_STYLE.nodePadding}px;font-size:${CANVAS_STYLE.nodeFontSize}px;` +
					`line-height:1.4;color:${CANVAS_STYLE.nodeText};white-space:pre-wrap;word-break:break-word;` +
					'overflow-wrap:anywhere;overflow-x:hidden;overflow-y:auto;width:100%;height:100%;box-sizing:border-box;pointer-events:all;';
				el.appendChild(textEl);
			}
			const textEl = el.querySelector('.canvas-node-text') as HTMLElement;
			if (textEl) {
				// 文件节点需为 40px 表头让位
				textEl.style.paddingTop = (node.type === 'file' ? CANVAS_STYLE.fileHeaderHeight + CANVAS_STYLE.nodePadding : CANVAS_STYLE.nodePadding) + 'px';
				// 安全渲染 Markdown（仅构造 DOM，不使用 innerHTML）
				textEl.replaceChildren(this._renderMarkdown(targetText));
				// 将 node:<id> 渲染为可点击引用（不影响编辑态，编辑时显示纯文本）
				this._linkifyNodeRefs(textEl);
			}
		}
	}

	// 将节点文本中的 `node:<id>` 引用转换为可点击 span（安全 DOM 操作，禁用 innerHTML）。
	// 仅在展示态调用（编辑态显示纯文本），避免污染 contenteditable。
	private _linkifyNodeRefs(root: HTMLElement): void {
		const NODE_REF = /node:([A-Za-z0-9_-]+)/g;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		let n: Node | null;
		while ((n = walker.nextNode())) { textNodes.push(n as Text); }
		for (const textNode of textNodes) {
			const text = textNode.nodeValue ?? '';
			NODE_REF.lastIndex = 0;
			if (!NODE_REF.test(text)) { continue; }
			NODE_REF.lastIndex = 0;
			const frag = document.createDocumentFragment();
			let last = 0;
			let m: RegExpExecArray | null;
			while ((m = NODE_REF.exec(text))) {
				if (m.index > last) { frag.appendChild(document.createTextNode(text.slice(last, m.index))); }
				const id = m[1];
				const span = document.createElement('span');
				span.className = 'canvas-node-link';
				span.setAttribute('data-ref-id', id);
				span.textContent = m[0];
				frag.appendChild(span);
				last = m.index + m[0].length;
			}
			if (last < text.length) { frag.appendChild(document.createTextNode(text.slice(last))); }
			textNode.parentNode?.replaceChild(frag, textNode);
		}
	}

	// ─── Markdown 渲染（安全 DOM 构造，禁用 innerHTML） ────────────────────
	// 复刻参考实现 markdownRenderer.js 的块级支持范围与视觉规格：
	//   #..###### → 蓝色 #4a9eff 加粗，字号 22/20/18/17/16/15，line-height 1.4
	//   - / * / + → 圆点列表；1. → 有序列表
	//   > 引用     → 左侧竖线 + 弱化色
	//   ```       → 代码块
	//   ---       → 分隔线
	//   - [ ]/[x] → 复选框
	private _renderMarkdown(text: string): HTMLElement {
		const container = document.createElement('div');
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.gap = '4px';

		const lines = text.split('\n');
		let codeBuf: string[] | null = null;

		for (const raw of lines) {
			const line = raw;

			// 代码块围栏
			const fence = line.trimStart().startsWith('```');
			if (fence) {
				if (codeBuf === null) {
					codeBuf = [];
				} else {
					container.appendChild(this._makeCodeBlock(codeBuf.join('\n')));
					codeBuf = null;
				}
				continue;
			}
			if (codeBuf !== null) { codeBuf.push(line); continue; }

			// 水平分隔线
			if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
				const hr = document.createElement('div');
				hr.style.cssText = 'height:1px;background:rgba(255,255,255,0.18);margin:4px 0;';
				container.appendChild(hr);
				continue;
			}

			// 标题 #..######
			const h = /^(#{1,6})\s+(.*)$/.exec(line);
			if (h) {
				const level = h[1].length;
				const el = document.createElement('div');
				el.style.color = CANVAS_STYLE.headingColor;
				el.style.fontWeight = '700';
				el.style.fontSize = CANVAS_STYLE.headingSizes[level - 1] + 'px';
				el.style.lineHeight = '1.4';
				this._renderInline(h[2], el);
				container.appendChild(el);
				continue;
			}

			// 引用 >
			const q = /^\s*>\s?(.*)$/.exec(line);
			if (q) {
				const el = document.createElement('div');
				el.style.cssText = 'border-left:3px solid rgba(255,255,255,0.25);padding-left:8px;color:' + CANVAS_STYLE.mutedColor + ';';
				this._renderInline(q[1], el);
				container.appendChild(el);
				continue;
			}

			// 复选框 - [ ] / - [x]
			const cb = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
			if (cb) {
				container.appendChild(this._makeListItem(cb[1].length, cb[2].toLowerCase() === 'x' ? '☑' : '☐', cb[3]));
				continue;
			}

			// 无序列表
			const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
			if (ul) {
				container.appendChild(this._makeListItem(ul[1].length, '•', ul[2]));
				continue;
			}

			// 有序列表
			const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
			if (ol) {
				container.appendChild(this._makeListItem(ol[1].length, ol[2] + '.', ol[3]));
				continue;
			}

			const lineEl = document.createElement('div');
			this._renderInline(line, lineEl);
			container.appendChild(lineEl);
		}

		if (codeBuf !== null) { container.appendChild(this._makeCodeBlock(codeBuf.join('\n'))); }
		return container;
	}

	private _makeListItem(indent: number, marker: string, content: string): HTMLElement {
		const row = document.createElement('div');
		row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;';
		row.style.paddingLeft = Math.floor(indent / 2) * 14 + 'px';
		const dot = document.createElement('span');
		dot.textContent = marker;
		dot.style.cssText = 'flex:0 0 auto;opacity:0.85;';
		const body = document.createElement('span');
		body.style.cssText = 'flex:1 1 auto;min-width:0;';
		this._renderInline(content, body);
		row.appendChild(dot);
		row.appendChild(body);
		return row;
	}

	private _makeCodeBlock(code: string): HTMLElement {
		const pre = document.createElement('pre');
		pre.textContent = code;
		pre.style.cssText = 'margin:2px 0;padding:6px 8px;background:rgba(0,0,0,0.32);border-radius:4px;' +
			'font-family:var(--vscode-editor-font-family, monospace);font-size:12px;line-height:1.45;' +
			'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;';
		return pre;
	}

	private _renderInline(text: string, parent: HTMLElement): void {
		const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			if (m.index > last) {
				parent.appendChild(document.createTextNode(text.slice(last, m.index)));
			}
			if (m[2] !== undefined) {
				const b = document.createElement('strong');
				b.textContent = m[2];
				b.style.fontWeight = '700';
				b.style.color = '#ffffff';
				parent.appendChild(b);
			} else if (m[4] !== undefined) {
				const c = document.createElement('code');
				c.textContent = m[4];
				c.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
				c.style.fontSize = '12px';
				c.style.background = 'rgba(255,255,255,0.08)';
				c.style.padding = '0 4px';
				c.style.borderRadius = '3px';
				parent.appendChild(c);
			} else if (m[6] !== undefined) {
				const i = document.createElement('em');
				i.textContent = m[6];
				i.style.fontStyle = 'italic';
				i.style.color = CANVAS_STYLE.mutedColor;
				parent.appendChild(i);
			} else if (m[8] !== undefined) {
				const a = document.createElement('a');
				a.textContent = m[8];
				a.href = m[9];
				a.target = '_blank';
				a.rel = 'noopener noreferrer';
				a.style.color = '#4daafc';
				a.style.textDecoration = 'underline';
				parent.appendChild(a);
			}
			last = re.lastIndex;
		}
		if (last < text.length) {
			parent.appendChild(document.createTextNode(text.slice(last)));
		}
	}

	// ── 边渲染 ─────────────────────────────────────────────────────────

	private _edgeHandles = new Map<string, SVGCircleElement>();

	private _syncEdges(data: IMindmapData, visible: Set<string>): void {
		const dataEdgeIds = new Set(data.edges.map(e => e.id));

		for (const [id, path] of this._edgePaths) {
			if (!dataEdgeIds.has(id)) {
				path.remove();
				this._edgePaths.delete(id);
			}
		}
		for (const [id, hit] of this._edgeHitPaths) {
			if (!dataEdgeIds.has(id)) {
				hit.remove();
				this._edgeHitPaths.delete(id);
			}
		}
		if (this._selectedEdgeId && !dataEdgeIds.has(this._selectedEdgeId)) {
			this._selectedEdgeId = null;
		}
		for (const [id, circle] of this._edgeHandles) {
			if (!dataEdgeIds.has(id)) {
				circle.remove();
				this._edgeHandles.delete(id);
			}
		}

		for (const edge of data.edges) {
			// 折叠分支的边需移除（端点被隐藏）
			if (!visible.has(edge.fromNode) || !visible.has(edge.toNode)) {
				const p = this._edgePaths.get(edge.id);
				if (p) { p.remove(); this._edgePaths.delete(edge.id); }
				const hp = this._edgeHitPaths.get(edge.id);
				if (hp) { hp.remove(); this._edgeHitPaths.delete(edge.id); }
				const c = this._edgeHandles.get(edge.id);
				if (c) { c.remove(); this._edgeHandles.delete(edge.id); }
				continue;
			}
			let path = this._edgePaths.get(edge.id);
			if (!path) {
				// 命中判定用的透明加粗路径 —— 复刻参考实现 getConnectionAtPoint 的
				// distanceToLineSegment(tolerance = 8)，这里用 16px 透明描边等效实现。
				const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				hit.setAttribute('fill', 'none');
				hit.setAttribute('stroke', 'transparent');
				hit.setAttribute('stroke-width', '16');
				hit.setAttribute('cursor', 'pointer');
				hit.style.pointerEvents = 'stroke';
				hit.dataset.edgeId = edge.id;
				hit.addEventListener('pointerdown', (ev) => {
					ev.stopPropagation();
					this.selectEdge(edge.id);
				});
				this._svgEdgesGroup.appendChild(hit);
				this._edgeHitPaths.set(edge.id, hit);

				path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute('fill', 'none');
				path.setAttribute('stroke', CANVAS_STYLE.edgeColor);
				path.setAttribute('stroke-width', String(CANVAS_STYLE.edgeWidth));
				path.style.pointerEvents = 'none';
				this._svgEdgesGroup.appendChild(path);
				this._edgePaths.set(edge.id, path);
			}
			this._updateEdgePath(path, edge, data);

			// Connection handle (insert node between)
			let handle = this._edgeHandles.get(edge.id);
			if (!handle) {
				handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
				handle.setAttribute('r', '5');
				handle.setAttribute('fill', 'var(--vscode-panel-border)');
				handle.setAttribute('stroke', 'var(--vscode-editor-background)');
				handle.setAttribute('stroke-width', '1.5');
				handle.setAttribute('cursor', 'pointer');
				handle.style.opacity = '0';
				handle.style.transition = 'opacity 0.15s';
				handle.dataset.edgeId = edge.id;
				handle.dataset.fromNode = edge.fromNode;
				handle.dataset.toNode = edge.toNode;
				const h = handle;
				h.addEventListener('pointerenter', () => { h.style.opacity = '0.8'; });
				h.addEventListener('pointerleave', () => { h.style.opacity = '0'; });
				h.addEventListener('click', (e) => {
					if (e.altKey) {
						e.preventDefault();
						e.stopPropagation();
						this.onEdgeHandleClick?.(edge.id, edge.fromNode, edge.toNode);
					}
				});
				this._svgEdgesGroup.appendChild(handle);
				this._edgeHandles.set(edge.id, handle);
			}
			this._updateEdgeHandle(handle, edge, data);
		}
	}

	private _updateEdgePath(path: SVGPathElement, edge: IMindmapEdge, data: IMindmapData): void {
		const fromNode = data.nodes.find(n => n.id === edge.fromNode);
		const toNode = data.nodes.find(n => n.id === edge.toNode);
		if (!fromNode || !toNode) {
			path.setAttribute('d', '');
			return;
		}

		const from = this._getAnchor(fromNode, edge.fromSide);
		const to = this._getAnchor(toNode, edge.toSide);
		const isFromH = edge.fromSide === 'left' || edge.fromSide === 'right';
		const isToH = edge.toSide === 'left' || edge.toSide === 'right';
		const c1x = isFromH ? from.x + (to.x - from.x) * 0.5 : from.x;
		const c1y = isFromH ? from.y : from.y + (to.y - from.y) * 0.5;
		const c2x = isToH ? to.x - (to.x - from.x) * 0.5 : to.x;
		const c2y = isToH ? to.y : to.y - (to.y - from.y) * 0.5;

		// 参考实现在距目标 arrowOffset(16) 处收笔并把箭头尖端画在该点，
		// 使箭头不贴死节点边缘。这里沿末端切线方向回退 16 得到同样效果。
		const tanX = to.x - c2x;
		const tanY = to.y - c2y;
		const tanLen = Math.hypot(tanX, tanY) || 1;
		const off = CANVAS_STYLE.arrowOffset;
		const ex = to.x - (tanX / tanLen) * off;
		const ey = to.y - (tanY / tanLen) * off;

		const d = `M${from.x},${from.y} C${c1x},${c1y} ${c2x},${c2y} ${ex},${ey}`;
		path.setAttribute('d', d);
		this._edgeHitPaths.get(edge.id)?.setAttribute('d', d);

		// 描边样式：选中 → #2196f3 / 3px / 虚线 5,5；否则 #569cd6 / 2px / 实线
		const selected = this._selectedEdgeId === edge.id;
		if (selected) {
			path.setAttribute('stroke', CANVAS_STYLE.edgeSelectedColor);
			path.setAttribute('stroke-width', String(CANVAS_STYLE.edgeSelectedWidth));
			path.setAttribute('stroke-dasharray', '5 5');
			path.setAttribute('marker-end', 'url(#canvas-edge-arrow-selected)');
		} else {
			path.setAttribute('stroke', edge.color ? `var(--canvas-color-${edge.color})` : CANVAS_STYLE.edgeColor);
			path.setAttribute('stroke-width', String(CANVAS_STYLE.edgeWidth));
			path.removeAttribute('stroke-dasharray');
			path.setAttribute('marker-end', 'url(#canvas-edge-arrow)');
		}
	}

	// ── 连线选中 ───────────────────────────────────────────────────────

	private _selectedEdgeId: string | null = null;
	private _edgeHitPaths = new Map<string, SVGPathElement>();

	/** 当前选中的连线 id（供外部执行删除等操作） */
	get selectedEdgeId(): string | null { return this._selectedEdgeId; }

	/** 选中一条连线（传 null 清空选中）并刷新其描边样式 */
	selectEdge(edgeId: string | null): void {
		if (this._selectedEdgeId === edgeId) { return; }
		const prev = this._selectedEdgeId;
		this._selectedEdgeId = edgeId;
		if (this._lastRenderData) {
			for (const id of [prev, edgeId]) {
				if (!id) { continue; }
				const p = this._edgePaths.get(id);
				const e = this._lastRenderData.edges.find(x => x.id === id);
				if (p && e) { this._updateEdgePath(p, e, this._lastRenderData); }
			}
		}
		this.onEdgeSelect?.(edgeId);
	}

	private _updateEdgeHandle(handle: SVGCircleElement, edge: IMindmapEdge, data: IMindmapData): void {
		const fromNode = data.nodes.find(n => n.id === edge.fromNode);
		const toNode = data.nodes.find(n => n.id === edge.toNode);
		if (!fromNode || !toNode) {
			handle.setAttribute('visibility', 'hidden');
			return;
		}
		handle.removeAttribute('visibility');

		const from = this._getAnchor(fromNode, edge.fromSide);
		const to = this._getAnchor(toNode, edge.toSide);
		const isFromH = edge.fromSide === 'left' || edge.fromSide === 'right';
		const isToH = edge.toSide === 'left' || edge.toSide === 'right';
		const c1x = isFromH ? from.x + (to.x - from.x) * 0.5 : from.x;
		const c1y = isFromH ? from.y : from.y + (to.y - from.y) * 0.5;
		const c2x = isToH ? to.x - (to.x - from.x) * 0.5 : to.x;
		const c2y = isToH ? to.y : to.y - (to.y - from.y) * 0.5;

		// Midpoint of Bezier curve (t=0.5)
		const t = 0.5;
		const cx = (1 - t) ** 3 * from.x + 3 * (1 - t) ** 2 * t * c1x + 3 * (1 - t) * t ** 2 * c2x + t ** 3 * to.x;
		const cy = (1 - t) ** 3 * from.y + 3 * (1 - t) ** 2 * t * c1y + 3 * (1 - t) * t ** 2 * c2y + t ** 3 * to.y;

		handle.setAttribute('cx', String(cx));
		handle.setAttribute('cy', String(cy));
	}

	private _getAnchor(node: { x: number; y: number; width: number; height: number }, side: string): { x: number; y: number } {
		const cx = node.x + node.width / 2;
		const cy = node.y + node.height / 2;
		switch (side) {
			case 'left': return { x: node.x, y: cy };
			case 'right': return { x: node.x + node.width, y: cy };
			case 'top': return { x: cx, y: node.y };
			case 'bottom': return { x: cx, y: node.y + node.height };
			default: return { x: cx, y: cy };
		}
	}

	// ── 交互事件 ───────────────────────────────────────────────────────

	private _bindEvents(parent: HTMLElement): void {
		// ── Wheel → zoom ──
		parent.addEventListener('wheel', (e: WheelEvent) => {
			e.preventDefault();
			if (this._minimapEl && this._minimapEl.contains(e.target as Node)) { return; }
			const rect = parent.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			const factor = e.deltaY < 0 ? 1.1 : 0.9;
			const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom * factor));
			this._panX = mx - (mx - this._panX) * (newZoom / this._zoom);
			this._panY = my - (my - this._panY) * (newZoom / this._zoom);
			this._zoom = newZoom;
			this._updateTransform();
		}, { passive: false });

		// ── PointerDown（capture：节点 / 连接手柄 / 背景 统一分发）──
		parent.addEventListener('pointerdown', (e: PointerEvent) => {
			const target = e.target as HTMLElement;
			// minimap 自身处理点击/拖拽导航，不触发背景平移或框选
			if (this._minimapEl && this._minimapEl.contains(target)) { return; }

			// 节点引用链接（node:<id>）：不触发节点拖拽/选中，交由 click 处理跳转
			if (target.closest('.canvas-node-link')) {
				e.stopPropagation();
				return;
			}

			// 点击画布（非编辑态）→ 让容器聚焦，从而键盘快捷键可触发
			if (!this._editingNodeId) {
				this.container.focus({ preventScroll: true });
			}

			// 0) 折叠/展开角标：点击切换子树折叠/展开（不触发拖拽/选中）
			const badge = target.closest('.canvas-collapse-badge') as HTMLElement | null;
			if (badge) {
				const nodeId = badge.dataset.nodeId;
				if (nodeId) {
					this.onToggleExpand?.(nodeId);
				}
				e.preventDefault();
				e.stopPropagation();
				return;
			}

			// 1) 自由连接：从节点连接点拖出边
			const handle = target.closest('.canvas-connect-handle') as HTMLElement | null;
			if (handle && e.button === 0) {
				const fromId = handle.dataset.nodeId!;
				this.selectEdge(null);
				this._connectFromId = fromId;
				this._connectHoveredId = null;
				// 起点取被按下的那个连接点（top/right/bottom/left），而非节点中心 —— 对齐参考实现
				const fromNode = this._nodeDataMap.get(fromId);
				const side = handle.dataset.dir as ConnectSide | undefined;
				this._connectStartPoint = (fromNode && side)
					? this._getAnchor(fromNode, side)
					: this._getNodeCenter(fromId);
				this._updateConnectLine(this._connectStartPoint, this._connectStartPoint);
				if (this._connectLineEl) { this._connectLineEl.style.opacity = '1'; }
				e.preventDefault();
				e.stopPropagation();
				return;
			}

			// 1.5) Resize 手柄：从节点 8 向手柄拖拽改 width/height
			const resizeHandle = target.closest('.canvas-resize-handle') as HTMLElement | null;
			if (resizeHandle && e.button === 0) {
				const nodeId = resizeHandle.dataset.nodeId!;
				const corner = resizeHandle.dataset.handle as ResizeDir;
				const node = this._nodeDataMap.get(nodeId);
				if (node) {
					this._resizeNodeId = nodeId;
					this._resizeHandle = corner;
					this._resizeOrig = { x: node.x, y: node.y, width: node.width, height: node.height };
					this._resizeStartX = e.clientX;
					this._resizeStartY = e.clientY;
					e.preventDefault();
					e.stopPropagation();
					return;
				}
			}

			// 2) 节点主体
			const nodeEl = target.closest('.canvas-node') as HTMLElement | null;
			if (nodeEl && e.button === 0) {
				const nodeId = nodeEl.dataset.nodeId!;
				this.selectEdge(null);
				// Ctrl+点击 → 跳转到源码（不进入拖拽）
				if (e.ctrlKey) {
					this.onNodeClick?.(nodeId, e);
					this.onNavigateToSource?.(nodeId);
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				this.onNodeClick?.(nodeId, e);
				if (e.altKey && !e.shiftKey) {
					// Alt+click → 选中整棵树（由 controller 处理）
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				// 准备拖拽（超过阈值后激活）
				this._dragNodeId = nodeId;
				this._dragActive = false;
				this._dragStartX = e.clientX;
				this._dragStartY = e.clientY;
				const node = this._nodeDataMap.get(nodeId);
				this._dragNodeOrigX = node?.x ?? 0;
				this._dragNodeOrigY = node?.y ?? 0;
			// 记录被拖拽集合：默认节点本身 + 子树；按住 Shift 仅移动当前节点（不带动子树）
			this._dragOrigCoords.clear();
			if (node) { this._dragOrigCoords.set(nodeId, { x: node.x, y: node.y }); }
			if (!e.shiftKey) {
				this._subtreeDescendantIds = this._collectSubtreeDescendants(nodeId);
				if (this._subtreeDescendantIds) {
					for (const descId of this._subtreeDescendantIds) {
						const d = this._nodeDataMap.get(descId);
						if (d) { this._dragOrigCoords.set(descId, { x: d.x, y: d.y }); }
					}
				}
			} else {
				this._subtreeDescendantIds = null;
			}
				e.preventDefault();
				return;
			}

			// 3) 背景：中键 / Alt → 平移；否则 → 框选
			this.selectEdge(null);
			if (e.button === 1 || (e.button === 0 && e.altKey)) {
				this._isPanning = true;
				this._panStartX = e.clientX;
				this._panStartY = e.clientY;
				this._panOriginX = this._panX;
				this._panOriginY = this._panY;
				this.container.style.cursor = 'grabbing';
				e.preventDefault();
			} else if (e.button === 0) {
				this._isSelecting = true;
				const rect = parent.getBoundingClientRect();
				this._selStartX = e.clientX - rect.left;
				this._selStartY = e.clientY - rect.top;
				if (this._selectionBoxEl) {
					this._selectionBoxEl.style.left = this._selStartX + 'px';
					this._selectionBoxEl.style.top = this._selStartY + 'px';
					this._selectionBoxEl.style.width = '0px';
					this._selectionBoxEl.style.height = '0px';
					this._selectionBoxEl.style.display = 'block';
				}
				this.onBackgroundClick?.();
				e.preventDefault();
			}
		}, true);

		// ── PointerMove ──
		parent.addEventListener('pointermove', (e: PointerEvent) => {
			if (this._isPanning) {
				this._panX = this._panOriginX + (e.clientX - this._panStartX);
				this._panY = this._panOriginY + (e.clientY - this._panStartY);
				this._updateTransform();
				return;
			}

			if (this._connectFromId) {
				const rect = parent.getBoundingClientRect();
				const canvasPt = {
					x: (e.clientX - rect.left - this._panX) / this._zoom,
					y: (e.clientY - rect.top - this._panY) / this._zoom,
				};
				this._updateConnectLine(this._connectStartPoint, canvasPt);
				const overEl = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
				const overNode = overEl?.closest('.canvas-node') as HTMLElement | null;
				const overId = overNode?.dataset.nodeId ?? null;
				if (overId !== this._connectHoveredId) {
					if (this._connectHoveredId) { this._setConnectHighlight(this._connectHoveredId, false); }
					if (overId && overId !== this._connectFromId) { this._setConnectHighlight(overId, true); }
					this._connectHoveredId = (overId && overId !== this._connectFromId) ? overId : null;
				}
				return;
			}

			if (this._dragNodeId) {
				if (!this._dragActive) {
					const dist = Math.hypot(e.clientX - this._dragStartX, e.clientY - this._dragStartY);
					if (dist < this._dragThreshold) { return; }
					this._dragActive = true;
				}
				const dx = (e.clientX - this._dragStartX) / this._zoom;
				const dy = (e.clientY - this._dragStartY) / this._zoom;
				this._applyDragDelta(dx, dy);
				return;
			}

			if (this._resizeNodeId && this._resizeOrig) {
				const dx = (e.clientX - this._resizeStartX) / this._zoom;
				const dy = (e.clientY - this._resizeStartY) / this._zoom;
				this._applyResize(dx, dy);
				return;
			}

			if (this._isSelecting) {
				const rect = parent.getBoundingClientRect();
				const cx = e.clientX - rect.left;
				const cy = e.clientY - rect.top;
				const x = Math.min(cx, this._selStartX);
				const y = Math.min(cy, this._selStartY);
				const w = Math.abs(cx - this._selStartX);
				const h = Math.abs(cy - this._selStartY);
				if (this._selectionBoxEl) {
					this._selectionBoxEl.style.left = x + 'px';
					this._selectionBoxEl.style.top = y + 'px';
					this._selectionBoxEl.style.width = w + 'px';
					this._selectionBoxEl.style.height = h + 'px';
				}
				return;
			}

			// 普通移动：更新 hover 与连接点显隐
			this._updateHover(e, parent);
		});

		// ── PointerUp ──
		parent.addEventListener('pointerup', (e: PointerEvent) => {
			if (this._isPanning) {
				this._isPanning = false;
				this.container.style.cursor = 'grab';
				return;
			}

			if (this._connectFromId) {
				const fromId = this._connectFromId;
				const targetId = this._connectHoveredId;
				if (this._connectLineEl) { this._connectLineEl.style.opacity = '0'; }
				if (this._connectHoveredId) { this._setConnectHighlight(this._connectHoveredId, false); }
				this._connectFromId = null;
				this._connectHoveredId = null;
				if (targetId && targetId !== fromId) {
					this.onConnectEnd?.(fromId, targetId);
				}
				return;
			}

			if (this._dragNodeId) {
				if (this._dragActive) {
					const dx = (e.clientX - this._dragStartX) / this._zoom;
					const dy = (e.clientY - this._dragStartY) / this._zoom;
					const finalX = this._dragNodeOrigX + dx;
					const finalY = this._dragNodeOrigY + dy;
					const subtree = this._subtreeDescendantIds ? [...this._subtreeDescendantIds] : [];
					this.onNodeDragEnd?.(this._dragNodeId, finalX, finalY, subtree);
				}
				this._dragNodeId = null;
				this._subtreeDescendantIds = null;
				this._dragActive = false;
				this._dragOrigCoords.clear();
				return;
			}

		if (this._resizeNodeId) {
			const id = this._resizeNodeId;
			const node = this._nodeDataMap.get(id);
			// 记为「手动 resize」，后续不再被内容自适应高度覆盖
			this._manualSizeNodes.add(id);
			this._resizeNodeId = null;
				this._resizeHandle = null;
				this._resizeOrig = null;
				if (node) {
					this.onNodeResizeEnd?.(id, node.width, node.height);
				}
				return;
			}

			if (this._isSelecting) {
				this._isSelecting = false;
				if (this._selectionBoxEl) { this._selectionBoxEl.style.display = 'none'; }
				const rect = parent.getBoundingClientRect();
				const cx = e.clientX - rect.left;
				const cy = e.clientY - rect.top;
				const x1 = (Math.min(cx, this._selStartX) - this._panX) / this._zoom;
				const y1 = (Math.min(cy, this._selStartY) - this._panY) / this._zoom;
				const x2 = (Math.max(cx, this._selStartX) - this._panX) / this._zoom;
				const y2 = (Math.max(cy, this._selStartY) - this._panY) / this._zoom;
				const ids: string[] = [];
				if (this._lastRenderData) {
					for (const n of this._lastRenderData.nodes) {
						if (n.x < x2 && n.x + n.width > x1 && n.y < y2 && n.y + n.height > y1) {
							ids.push(n.id);
						}
					}
				}
				this.onSelectionEnd?.(ids);
				return;
			}
		});

		// ── PointerLeave：取消进行中的操作 ──
		parent.addEventListener('pointerleave', () => {
			if (this._isPanning) { this._isPanning = false; this.container.style.cursor = 'grab'; }
			if (this._dragNodeId) { this._dragNodeId = null; this._subtreeDescendantIds = null; this._dragActive = false; this._dragOrigCoords.clear(); }
			if (this._resizeNodeId) { this._resizeNodeId = null; this._resizeHandle = null; this._resizeOrig = null; }
			if (this._isSelecting && this._selectionBoxEl) { this._selectionBoxEl.style.display = 'none'; this._isSelecting = false; }
			if (this._connectFromId) {
				if (this._connectLineEl) { this._connectLineEl.style.opacity = '0'; }
				if (this._connectHoveredId) { this._setConnectHighlight(this._connectHoveredId, false); }
				this._connectFromId = null; this._connectHoveredId = null;
			}
			this._updateHover(null, null);
		});

		// ── 节点引用链接点击：跳转/聚焦目标节点 ──
		this._nodeLayer.addEventListener('click', (e: MouseEvent) => {
			const linkEl = (e.target as HTMLElement).closest('.canvas-node-link') as HTMLElement | null;
			if (linkEl) {
				const refId = linkEl.getAttribute('data-ref-id');
				if (refId) {
					e.preventDefault();
					e.stopPropagation();
					this.onNodeLinkClick?.(refId);
				}
			}
		});

		// ── 键盘：Escape 取消连线/框选/清除连线选中；非 Escape 且非编辑态 → 路由到 onKeyDown（对齐参考实现 handleKeyDown） ──
		parent.addEventListener('keydown', (e: KeyboardEvent) => {
			// 编辑态下：Escape 提交编辑；其余按键交给 contenteditable 默认行为
			if (this._editingNodeId) {
				if (e.key === 'Escape') {
					const editEl = this._nodeLayer.querySelector(`[data-node-id="${this._editingNodeId}"][contenteditable="true"]`) as HTMLElement | null;
					if (editEl) { editEl.blur(); }
					e.preventDefault();
					e.stopPropagation();
				}
				return;
			}
			if (e.key !== 'Escape') {
				if (this.onKeyDown?.(e)) { e.preventDefault(); e.stopPropagation(); }
				return;
			}
			let handled = false;
			if (this._connectFromId) {
				if (this._connectLineEl) { this._connectLineEl.style.opacity = '0'; }
				if (this._connectHoveredId) { this._setConnectHighlight(this._connectHoveredId, false); }
				this._connectFromId = null;
				this._connectHoveredId = null;
				this.container.style.cursor = 'default';
				handled = true;
			}
			if (this._isSelecting && this._selectionBoxEl) {
				this._selectionBoxEl.style.display = 'none';
				this._isSelecting = false;
				handled = true;
			}
			if (this._selectedEdgeId) {
				this.selectEdge(null);
				handled = true;
			}
			if (handled) { e.preventDefault(); e.stopPropagation(); }
		});

		// ── Double click → edit / create ──
		parent.addEventListener('dblclick', (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			const nodeEl = target.closest('.canvas-node') as HTMLElement | null;
			if (nodeEl) {
				this.onNodeDblClick?.(nodeEl.dataset.nodeId!);
			} else {
				const rect = this.container.getBoundingClientRect();
				const cx = (e.clientX - rect.left - this._panX) / this._zoom;
				const cy = (e.clientY - rect.top - this._panY) / this._zoom;
				this.onBackgroundDblClick?.(cx, cy);
			}
		});

		// ── contenteditable blur → 文本变更 ──
		parent.addEventListener('blur', (e: FocusEvent) => {
			const target = e.target as HTMLElement;
			const nodeEl = target.closest('.canvas-node') as HTMLElement | null;
			if (nodeEl && nodeEl.getAttribute('contenteditable')) {
				const nodeId = nodeEl.dataset.nodeId!;
				this.onNodeTextChanged?.(nodeId, nodeEl.textContent || '');
			}
		}, true);
	}

	// ── 辅助方法：拖拽边跟随 / 自由连接 / hover ──

	private _getNodeCenter(id: string): { x: number; y: number } {
		const n = this._nodeDataMap.get(id);
		if (!n) { return { x: 0, y: 0 }; }
		return { x: n.x + n.width / 2, y: n.y + n.height / 2 };
	}

	private _updateConnectLine(from: { x: number; y: number }, to: { x: number; y: number }): void {
		if (!this._connectLineEl) { return; }
		const dx = Math.abs(to.x - from.x) * 0.5 + 20;
		const d = `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
		this._connectLineEl.setAttribute('d', d);
	}

	private _setConnectHighlight(id: string, on: boolean): void {
		const el = this._nodeEls.get(id);
		if (el) { el.style.boxShadow = on ? '0 0 0 3px var(--vscode-focusBorder)' : ''; }
	}

	private _updateHover(e: PointerEvent | null, parent: HTMLElement | null): void {
		let nodeId: string | null = null;
		if (e && parent) {
			const target = e.target as HTMLElement;
			if (!target.closest('.canvas-connect-handle') && !target.closest('.canvas-resize-handle')) {
				const nodeEl = target.closest('.canvas-node') as HTMLElement | null;
				nodeId = nodeEl?.dataset.nodeId ?? null;
			}
		}
		if (nodeId === this._hoverNodeId) { return; }
		this._hoverNodeId = nodeId;
		this.onHoverNode?.(nodeId);
		for (const [id, el] of this._nodeEls) {
			const show = id === nodeId || this._selectedNodeIds.has(id);
			const handles = el.querySelectorAll('.canvas-connect-handle');
			handles.forEach(h => {
				(h as HTMLElement).style.opacity = show ? '1' : '0';
				(h as HTMLElement).style.pointerEvents = show ? 'all' : 'none';
			});
		}
	}

	private _applyDragDelta(dx: number, dy: number): void {
		if (!this._lastRenderData) { return; }
		const moved = new Set<string>();
		for (const [id, orig] of this._dragOrigCoords) {
			const nx = orig.x + dx;
			const ny = orig.y + dy;
			const node = this._nodeDataMap.get(id);
			const el = this._nodeEls.get(id);
			if (node) { node.x = nx; node.y = ny; }
			if (el) { el.style.left = nx + 'px'; el.style.top = ny + 'px'; }
			moved.add(id);
		}
		this._updateEdgesForIds(moved);
	}

	/**
	 * 拖拽四角手柄调整节点 width/height（并相应平移 x/y 以保持对角锚点不变），
	 * 直接写回 _nodeDataMap（即数据节点引用），并实时刷新元素尺寸与相连边。
	 */
	private _applyResize(dx: number, dy: number): void {
		if (!this._resizeNodeId || !this._resizeOrig || !this._resizeHandle) { return; }
		const o = this._resizeOrig;
		const h = this._resizeHandle;
		let x = o.x;
		let y = o.y;
		let width = o.width;
		let height = o.height;

		// 8 向：按手柄名分解为「是否影响左/右/上/下边」
		const movesLeft = h === 'nw' || h === 'w' || h === 'sw';
		const movesRight = h === 'ne' || h === 'e' || h === 'se';
		const movesTop = h === 'nw' || h === 'n' || h === 'ne';
		const movesBottom = h === 'sw' || h === 's' || h === 'se';

		if (movesRight) { width = o.width + dx; }
		if (movesLeft) { width = o.width - dx; x = o.x + dx; }
		if (movesBottom) { height = o.height + dy; }
		if (movesTop) { height = o.height - dy; y = o.y + dy; }

		// 钳制最小尺寸，并修正锚点（被固定的边保持不动）
		if (width < this._resizeMinW) {
			if (movesLeft) { x = o.x + (o.width - this._resizeMinW); }
			width = this._resizeMinW;
		}
		if (height < this._resizeMinH) {
			if (movesTop) { y = o.y + (o.height - this._resizeMinH); }
			height = this._resizeMinH;
		}

		const node = this._nodeDataMap.get(this._resizeNodeId);
		const el = this._nodeEls.get(this._resizeNodeId);
		if (node) {
			node.x = x; node.y = y;
			node.width = width; node.height = height;
		}
		if (el) {
			el.style.left = x + 'px';
			el.style.top = y + 'px';
			el.style.width = width + 'px';
			el.style.height = height + 'px';
		}
		this._updateEdgesForIds(new Set([this._resizeNodeId]));
	}

	private _updateEdgesForIds(ids: Set<string>): void {
		if (!this._lastRenderData) { return; }
		for (const edge of this._lastRenderData.edges) {
			if (ids.has(edge.fromNode) || ids.has(edge.toNode)) {
				const path = this._edgePaths.get(edge.id);
				if (path) { this._updateEdgePath(path, edge, this._lastRenderData); }
			}
		}
	}

	private _lastRenderData: IMindmapData | null = null;
	private _nodeDataMap = new Map<string, IMindmapData['nodes'][number]>();
	private _dragOrigCoords = new Map<string, { x: number; y: number }>();
	private _connectStartPoint = { x: 0, y: 0 };

	setRenderData(data: IMindmapData): void {
		this._lastRenderData = data;
		this._nodeDataMap.clear();
		for (const n of data.nodes) { this._nodeDataMap.set(n.id, n); }
	}

	// ── 子树收集 ───────────────────────────────────────────────────────

	_subtreeDescendantMap: Map<string, Set<string>> = new Map();

	private _collectSubtreeDescendants(nodeId: string): Set<string> {
		const cached = this._subtreeDescendantMap.get(nodeId);
		if (cached) { return cached; }
		// Will be populated before drag begins
		return new Set();
	}

	setSubtreeDescendants(nodeId: string, descendantIds: Set<string>): void {
		this._subtreeDescendantMap.set(nodeId, descendantIds);
	}

	// ── 清理 ───────────────────────────────────────────────────────────

	dispose(): void {
		this._nodeEls.clear();
		this._groupEls.clear();
		this._edgePaths.clear();
		this.container.remove();
	}
}
