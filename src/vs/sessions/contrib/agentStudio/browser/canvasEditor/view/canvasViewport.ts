/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Canvas Viewport
 *
 *  Pan/zoom 容器 + DOM 节点渲染 + SVG 边渲染 + 交互。
 *  对齐 Mindvas Canvas API 的交互模型（选择、拖拽、子树拖拽、内联编辑）。
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../../base/browser/dom.js';
import type { IMindmapData, IMindmapEdge } from '../../../common/mindmap/mindmapTypes.js';

// ═══════════════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════════════

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

// ═══════════════════════════════════════════════════════════════════════════
// CanvasViewport
// ═══════════════════════════════════════════════════════════════════════════

export class CanvasViewport {

	readonly container: HTMLElement;
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

	// Callbacks
	onNodeClick: ((nodeId: string, e: MouseEvent) => void) | null = null;
	onNodeDblClick: ((nodeId: string) => void) | null = null;
	onNodeDragEnd: ((nodeId: string, x: number, y: number) => void) | null = null;
	onNodeTextChanged: ((nodeId: string, text: string) => void) | null = null;
	onBackgroundClick: (() => void) | null = null;
	onBackgroundDblClick: ((x: number, y: number) => void) | null = null;
	onEdgeHandleClick: ((edgeId: string, fromNodeId: string, toNodeId: string) => void) | null = null;

	constructor(parent: HTMLElement) {
		this.container = DOM.$('div.canvas-viewport');
		this.container.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background);cursor:grab;user-select:none;';

		// Viewport (transform container)
		this._viewport = DOM.$('div.canvas-viewport-transform');
		this._viewport.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;transform-origin:0 0;';

		// Node layer
		this._nodeLayer = DOM.$('div.canvas-node-layer');
		this._nodeLayer.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;';

		// SVG edge layer
		this._svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this._svgLayer.setAttribute('class', 'canvas-edge-layer');
		this._svgLayer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
		this._svgEdgesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		this._svgLayer.appendChild(this._svgEdgesGroup);

		this._viewport.appendChild(this._nodeLayer);
		this._viewport.appendChild(this._svgLayer);
		this.container.appendChild(this._viewport);
		// 关键：把 container 挂到父容器，否则整个画布层脱离文档树（节点/边都在 container 内）
		// 导致编辑器打开后画布空白（仅工具条可见）。此前遗漏此挂载步骤。
		parent.appendChild(this.container);

		// Event bindings
		this._bindEvents(parent);
		this._updateTransform();
	}

	// ── 变换 ───────────────────────────────────────────────────────────

	private _updateTransform(): void {
		this._viewport.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
	}

	get panX(): number { return this._panX; }
	get panY(): number { return this._panY; }
	get zoom(): number { return this._zoom; }

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
		this._selectedNodeIds = selectedIds;
		this._editingNodeId = editingId;

		const dataNodeIds = new Set(data.nodes.map(n => n.id));

		// 移除已删除的节点
		for (const [id, el] of this._nodeEls) {
			if (!dataNodeIds.has(id)) {
				el.remove();
				this._nodeEls.delete(id);
			}
		}

		// 创建/更新节点
		for (const node of data.nodes) {
			if (node.type === 'group') { continue; } // groups rendered separately
			let el = this._nodeEls.get(node.id);
			if (!el) {
				el = this._createNodeElement(node);
				this._nodeLayer.appendChild(el);
				this._nodeEls.set(node.id, el);
			}
			this._updateNodeElement(el, node);
		}

		// 更新边
		this._syncEdges(data);
	}

	private _createNodeElement(node: { id: string }): HTMLElement {
		const el = DOM.$('div.canvas-node');
		el.dataset.nodeId = node.id;
		el.style.cssText = 'position:absolute;border-radius:8px;border:2px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background);pointer-events:all;overflow:hidden;transition:box-shadow .15s;';
		return el;
	}

	private _updateNodeElement(el: HTMLElement, node: { id: string; x: number; y: number; width: number; height: number; text?: string; content?: string; color?: string }): void {
		el.style.left = node.x + 'px';
		el.style.top = node.y + 'px';
		el.style.width = node.width + 'px';
		el.style.height = node.height + 'px';

		const isSelected = this._selectedNodeIds.has(node.id);
		const isEditing = this._editingNodeId === node.id;

		if (isSelected) {
			el.style.borderColor = 'var(--vscode-focusBorder)';
			el.style.boxShadow = '0 0 0 1px var(--vscode-focusBorder)';
		} else {
			el.style.borderColor = node.color ? `var(--canvas-color-${node.color})` : 'var(--vscode-panel-border)';
			el.style.boxShadow = 'none';
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
				textEl.style.cssText = 'padding:8px 12px;font-size:13px;line-height:1.5;color:var(--vscode-editor-foreground);white-space:pre-wrap;word-break:break-word;pointer-events:none;';
				el.appendChild(textEl);
			}
			const textEl = el.querySelector('.canvas-node-text') as HTMLElement;
			if (textEl && textEl.textContent !== targetText) {
				textEl.textContent = targetText;
			}
		}
	}

	// ── 边渲染 ─────────────────────────────────────────────────────────

	private _edgeHandles = new Map<string, SVGCircleElement>();

	private _syncEdges(data: IMindmapData): void {
		const dataEdgeIds = new Set(data.edges.map(e => e.id));

		for (const [id, path] of this._edgePaths) {
			if (!dataEdgeIds.has(id)) {
				path.remove();
				this._edgePaths.delete(id);
			}
		}
		for (const [id, circle] of this._edgeHandles) {
			if (!dataEdgeIds.has(id)) {
				circle.remove();
				this._edgeHandles.delete(id);
			}
		}

		for (const edge of data.edges) {
			let path = this._edgePaths.get(edge.id);
			if (!path) {
				path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute('fill', 'none');
				path.setAttribute('stroke', 'var(--vscode-panel-border)');
				path.setAttribute('stroke-width', '2');
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

		const fromX = this._getSideX(fromNode, edge.fromSide);
		const fromY = fromNode.y + fromNode.height / 2;
		const toX = this._getSideX(toNode, edge.toSide);
		const toY = toNode.y + toNode.height / 2;

		// 贝塞尔曲线
		const dx = Math.abs(toX - fromX) * 0.5;
		const d = `M${fromX},${fromY} C${fromX + dx},${fromY} ${toX - dx},${toY} ${toX},${toY}`;
		path.setAttribute('d', d);

		// Edge style
		if (edge.color) {
			path.setAttribute('stroke', `var(--canvas-color-${edge.color})`);
		} else {
			path.setAttribute('stroke', 'var(--vscode-panel-border)');
		}
		path.setAttribute('stroke-width', '2');
	}

	private _updateEdgeHandle(handle: SVGCircleElement, edge: IMindmapEdge, data: IMindmapData): void {
		const fromNode = data.nodes.find(n => n.id === edge.fromNode);
		const toNode = data.nodes.find(n => n.id === edge.toNode);
		if (!fromNode || !toNode) {
			handle.setAttribute('visibility', 'hidden');
			return;
		}
		handle.removeAttribute('visibility');

		const fromX = this._getSideX(fromNode, edge.fromSide);
		const fromY = fromNode.y + fromNode.height / 2;
		const toX = this._getSideX(toNode, edge.toSide);
		const toY = toNode.y + toNode.height / 2;

		// Midpoint of Bezier curve (t=0.5)
		const t = 0.5;
		const cp1x = fromX + Math.abs(toX - fromX) * 0.5;
		const cx = (1 - t) ** 3 * fromX + 3 * (1 - t) ** 2 * t * cp1x + 3 * (1 - t) * t ** 2 * cp1x + t ** 3 * toX;
		const cy = (1 - t) ** 3 * fromY + 3 * (1 - t) ** 2 * t * fromY + 3 * (1 - t) * t ** 2 * toY + t ** 3 * toY;

		handle.setAttribute('cx', String(cx));
		handle.setAttribute('cy', String(cy));
	}

	private _getSideX(node: { x: number; width: number }, side: string): number {
		switch (side) {
			case 'left': return node.x;
			case 'right': return node.x + node.width;
			default: return node.x + node.width / 2;
		}
	}

	// ── 交互事件 ───────────────────────────────────────────────────────

	private _bindEvents(parent: HTMLElement): void {
		// Wheel → zoom
		parent.addEventListener('wheel', (e: WheelEvent) => {
			e.preventDefault();
			const rect = parent.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;

			const factor = e.deltaY < 0 ? 1.1 : 0.9;
			const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom * factor));

			// Zoom towards mouse
			this._panX = mx - (mx - this._panX) * (newZoom / this._zoom);
			this._panY = my - (my - this._panY) * (newZoom / this._zoom);
			this._zoom = newZoom;
			this._updateTransform();
		}, { passive: false });

		// Middle-mouse pan
		parent.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button === 1 || (e.button === 0 && e.altKey && !e.target || !(e.target as HTMLElement).closest('.canvas-node'))) {
				// Middle-click or Alt+click on background → pan
				this._isPanning = true;
				this._panStartX = e.clientX;
				this._panStartY = e.clientY;
				this._panOriginX = this._panX;
				this._panOriginY = this._panY;
				this.container.style.cursor = 'grabbing';
				e.preventDefault();
			}
		});

		parent.addEventListener('pointermove', (e: PointerEvent) => {
			if (this._isPanning) {
				this._panX = this._panOriginX + (e.clientX - this._panStartX);
				this._panY = this._panOriginY + (e.clientY - this._panStartY);
				this._updateTransform();
				return;
			}

			if (this._dragNodeId) {
				const dx = (e.clientX - this._dragStartX) / this._zoom;
				const dy = (e.clientY - this._dragStartY) / this._zoom;
				const nx = this._dragNodeOrigX + dx;
				const ny = this._dragNodeOrigY + dy;

				// Move dragged node
				const el = this._nodeEls.get(this._dragNodeId);
				if (el) {
					el.style.left = nx + 'px';
					el.style.top = ny + 'px';
				}

				// Move subtree descendants
				if (this._subtreeDescendantIds) {
					for (const descId of this._subtreeDescendantIds) {
						const descEl = this._nodeEls.get(descId);
						if (descEl) {
							const origNode = this._lastRenderData?.nodes.find(n => n.id === descId);
							if (origNode) {
								descEl.style.left = (origNode.x + dx) + 'px';
								descEl.style.top = (origNode.y + dy) + 'px';
							}
						}
					}
				}
			}
		});

		parent.addEventListener('pointerup', (e: PointerEvent) => {
			if (this._isPanning) {
				this._isPanning = false;
				this.container.style.cursor = 'grab';
				return;
			}

			if (this._dragNodeId) {
				const dx = (e.clientX - this._dragStartX) / this._zoom;
				const dy = (e.clientY - this._dragStartY) / this._zoom;
				this.onNodeDragEnd?.(this._dragNodeId, this._dragNodeOrigX + dx, this._dragNodeOrigY + dy);
				this._dragNodeId = null;
				this._subtreeDescendantIds = null;
			}
		});

		// Mouse leave → reset
		parent.addEventListener('pointerleave', () => {
			if (this._isPanning) {
				this._isPanning = false;
				this.container.style.cursor = 'grab';
			}
			if (this._dragNodeId) {
				// Cancel drag
				this._dragNodeId = null;
				this._subtreeDescendantIds = null;
			}
		});

		// Capture-phase pointerdown for node interaction
		parent.addEventListener('pointerdown', (e: PointerEvent) => {
			const target = e.target as HTMLElement;
			const nodeEl = target.closest('.canvas-node') as HTMLElement | null;

			if (nodeEl) {
				const nodeId = nodeEl.dataset.nodeId!;
				const isAlt = e.altKey;

				if (isAlt) {
					// Alt+click → select entire tree (bubble to controller)
					this.onNodeClick?.(nodeId, e);
					e.preventDefault();
					e.stopPropagation();
					return;
				}

				// Start drag
				this._dragNodeId = nodeId;
				this._dragStartX = e.clientX;
				this._dragStartY = e.clientY;
				const node = this._lastRenderData?.nodes.find(n => n.id === nodeId);
				this._dragNodeOrigX = node?.x ?? 0;
				this._dragNodeOrigY = node?.y ?? 0;

				// Collect subtree descendants if not Alt+drag
				if (!e.altKey) {
					this._subtreeDescendantIds = this._collectSubtreeDescendants(nodeId);
				}

				this.onNodeClick?.(nodeId, e);
			} else {
				this.onBackgroundClick?.();
			}
		}, true);

		// Double click → edit
		parent.addEventListener('dblclick', (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			const nodeEl = target.closest('.canvas-node') as HTMLElement | null;
			if (nodeEl) {
				this.onNodeDblClick?.(nodeEl.dataset.nodeId!);
			} else {
				// Dbl click on background → compute approximate canvas position
				const rect = this.container.getBoundingClientRect();
				const cx = (e.clientX - rect.left - this._panX) / this._zoom;
				const cy = (e.clientY - rect.top - this._panY) / this._zoom;
				this.onBackgroundDblClick?.(cx, cy);
			}
		});

		// Input listeners for contenteditable
		parent.addEventListener('blur', (e: FocusEvent) => {
			const target = e.target as HTMLElement;
			const nodeEl = target.closest('.canvas-node') as HTMLElement | null;
			if (nodeEl && nodeEl.getAttribute('contenteditable')) {
				const nodeId = nodeEl.dataset.nodeId!;
				this.onNodeTextChanged?.(nodeId, nodeEl.textContent || '');
			}
		}, true);
	}

	private _lastRenderData: IMindmapData | null = null;

	setRenderData(data: IMindmapData): void {
		this._lastRenderData = data;
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
		this._edgePaths.clear();
		this.container.remove();
	}
}
