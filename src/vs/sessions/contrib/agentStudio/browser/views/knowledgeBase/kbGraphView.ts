/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbGraphView.ts — Canvas 力导向图可视化。
 *
 *  配色系统「紫罗兰宝石 (Vibrant Amethyst)」对齐 ontosight visual-config。
 *  零外部依赖，使用 HTML5 Canvas 渲染。
 *
 *  特性：
 *   - 节点：外发光阴影 + 白描边 + 三态色（DEFAULT/SELECTED/HIGHLIGHTED）
 *          + Halo 标签 + 半透明白底圆角 + 底部放置
 *   - 边：三态色 + 发光光纤效果 + 边标签（关系类型）白底
 *   - 力导向布局：Eades 算法 + 碰撞半径 40 + 防重叠
 *   - 交互：点击选中节点/边、点击空白清除、双击高亮相邻节点、
 *           拖拽 + 滚轮缩放 + 平移
 *
 *  数据格式：
 *   - 节点：{ id, label, type, color? }
 *   - 边：{ source, target, type }
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface IGraphNode {
	id: string;
	label: string;
	type: 'doc' | 'tag';
	color?: string;
	/** 连线数（用于节点大小计算，对齐 SiYuan log2(Defs) * size） */
	refs?: number;
	defs?: number;
}

export interface IGraphLink {
	source: string;
	target: string;
	type: 'wikilink' | 'blockref' | 'tag';
}

export interface IGraphClickEvent {
	node?: IGraphNode;
	link?: IGraphLink;
}

// 内部渲染节点
interface IRenderNode {
	data: IGraphNode;
	x: number;
	y: number;
	vx: number;
	vy: number;
	radius: number;
	color: string;
}

// 内部渲染边（携带原始数据以支持标签 + 选中）
interface IRenderEdge {
	source: IRenderNode;
	target: IRenderNode;
	data: IGraphLink;
}

// ---------------------------------------------------------------------------
// ontosight 视觉状态枚举
// ---------------------------------------------------------------------------

const enum VisualState {
	DEFAULT = 0,
	SELECTED = 1,
	HIGHLIGHTED = 2,
}

// ---------------------------------------------------------------------------
// ontosight 配色系统：紫罗兰宝石 (Vibrant Amethyst)
// ---------------------------------------------------------------------------

const COLOR_PALETTE = {
	primary: {
		normal: '#6366F1',      // Indigo — 选中态
		hover: '#4F46E5',
		glow: '#818CF8',
	},
	success: {
		normal: '#8B5CF6',      // Violet — 默认节点色（紫罗兰宝石）
		hover: '#7C3AED',
	},
	warning: {
		normal: '#FFD700',      // Cyber Gold — 高亮态
		hover: '#F59E0B',
		glow: '#FDE68A',
	},
	neutral: {
		light: '#64748B',       // Slate-500
		lighter: '#F1F5F9',     // Slate-100
		muted: '#94A3B8',
	},
};

const TEXT_PALETTE = {
	label: '#1E293B',          // Slate-800
	description: '#64748B',    // Slate-500
	contrast: '#FFFFFF',
	halo: '#FFFFFF',           // 描边色
};

// 边标签关系类型 → 可读名称
const EDGE_LABEL_MAP: Record<string, string> = {
	wikilink: '引用',
	blockref: '块引用',
	tag: '标签',
};

// ---------------------------------------------------------------------------
// 布局常量
// ---------------------------------------------------------------------------

const LAYOUT = {
	/** 节点碰撞半径（防止重叠） */
	COLLIDE_RADIUS: 40,
	/** 标签相对于节点中心的底部偏移 */
	LABEL_OFFSET: 15,
	/** 标签背景圆角 */
	LABEL_BG_RADIUS: 6,
	/** 标签内边距 [vertical, horizontal] */
	LABEL_PADDING: [2, 6] as [number, number],
};

// ---------------------------------------------------------------------------
// 节点样式（三态）
// ---------------------------------------------------------------------------

interface INodeStyle {
	fill: string;
	stroke: string;
	lineWidth: number;
	shadowBlur: number;
	shadowColor: string;
	labelFontWeight: number;
	labelFill: string;
	labelFontSize: number;
}

const NODE_STYLES: Record<VisualState, INodeStyle> = {
	[VisualState.DEFAULT]: {
		fill: COLOR_PALETTE.success.normal,          // Violet #8B5CF6
		stroke: '#FFFFFF',
		lineWidth: 1.5,
		shadowBlur: 15,
		shadowColor: `${COLOR_PALETTE.success.normal}80`,
		labelFontWeight: 500,
		labelFill: TEXT_PALETTE.label,
		labelFontSize: 12,
	},
	[VisualState.SELECTED]: {
		fill: COLOR_PALETTE.primary.normal,          // Indigo #6366F1
		stroke: '#FFFFFF',
		lineWidth: 3,
		shadowBlur: 30,
		shadowColor: `${COLOR_PALETTE.primary.glow}B0`,
		labelFontWeight: 800,
		labelFill: COLOR_PALETTE.primary.normal,
		labelFontSize: 14,
	},
	[VisualState.HIGHLIGHTED]: {
		fill: COLOR_PALETTE.warning.normal,          // Cyber Gold #FFD700
		stroke: '#FFFFFF',
		lineWidth: 3,
		shadowBlur: 35,
		shadowColor: `${COLOR_PALETTE.warning.normal}A0`,
		labelFontWeight: 800,
		labelFill: '#000000',
		labelFontSize: 14,
	},
};

// ---------------------------------------------------------------------------
// 边样式（三态）— 发光光纤 (Glowing Optical Fibers)
// ---------------------------------------------------------------------------

interface IEdgeStyle {
	stroke: string;
	lineWidth: number;
	opacity: number;
	shadowBlur: number;
	shadowColor: string;
	labelFill: string;
	labelFontSize: number;
	labelFontWeight: number;
	labelBgFill: string;
	labelBgOpacity: number;
}

const EDGE_STYLES: Record<VisualState, IEdgeStyle> = {
	[VisualState.DEFAULT]: {
		stroke: '#CBD5E1',                           // Slate-300
		lineWidth: 1.2,
		opacity: 0.45,
		shadowBlur: 0,
		shadowColor: 'transparent',
		labelFill: '#1E293B',
		labelFontSize: 11,
		labelFontWeight: 700,
		labelBgFill: '#FFFFFF',
		labelBgOpacity: 0.75,
	},
	[VisualState.SELECTED]: {
		stroke: COLOR_PALETTE.primary.normal,        // Indigo
		lineWidth: 3,
		opacity: 1,
		shadowBlur: 10,
		shadowColor: `${COLOR_PALETTE.primary.normal}80`,
		labelFill: COLOR_PALETTE.primary.normal,
		labelFontSize: 12,
		labelFontWeight: 800,
		labelBgFill: '#FFFFFF',
		labelBgOpacity: 0.85,
	},
	[VisualState.HIGHLIGHTED]: {
		stroke: COLOR_PALETTE.warning.normal,        // Cyber Gold
		lineWidth: 3.5,
		opacity: 1,
		shadowBlur: 10,
		shadowColor: `${COLOR_PALETTE.warning.normal}60`,
		labelFill: '#000000',
		labelFontSize: 12,
		labelFontWeight: 800,
		labelBgFill: '#FFFFFF',
		labelBgOpacity: 0.85,
	},
};

// ---------------------------------------------------------------------------
// KbGraphView
// ---------------------------------------------------------------------------

export class KbGraphView extends Disposable {

	private _container!: HTMLElement;
	private _canvas!: HTMLCanvasElement;
	private _ctx!: CanvasRenderingContext2D;

	private _nodes: IRenderNode[] = [];
	private _edges: IRenderEdge[] = [];
	private _nodeMap = new Map<string, IRenderNode>();

	// 力导向参数
	private _centerX = 0;
	private _centerY = 0;
	private _alpha = 0;
	private _iterations = 0;

	// 交互状态
	private _scale = 1;
	private _offsetX = 0;
	private _offsetY = 0;
	private _dragging: IRenderNode | null = null;
	private _dragStartX = 0;
	private _dragStartY = 0;
	private _hoveredNode: IRenderNode | null = null;
	private _hoveredEdge: IRenderEdge | null = null;
	private _animationId = 0;

	// 选中与高亮（ontosight 三态）
	private _selectedNode: IRenderNode | null = null;
	private _selectedEdge: IRenderEdge | null = null;
	/** 双击高亮某节点时，记录其相邻节点 ID 集合 */
	private _highlightedNodes: Set<string> = new Set();
	/** 双击高亮时，关联的边集合 */
	private _highlightedEdges: Set<IRenderEdge> = new Set();

	// 诊断状态
	private _simRunning = false;
	private _drawScheduled = false;
	private _drawCount = 0;

	// 事件
	private readonly _onNodeClick = this._register(new Emitter<IGraphClickEvent>());
	readonly onNodeClick: Event<IGraphClickEvent> = this._onNodeClick.event;

	private readonly _onEdgeClick = this._register(new Emitter<IGraphClickEvent>());
	readonly onEdgeClick: Event<IGraphClickEvent> = this._onEdgeClick.event;

	private readonly _onClearSelection = this._register(new Emitter<void>());
	readonly onClearSelection: Event<void> = this._onClearSelection.event;

	constructor(@ILogService private readonly logService: ILogService) {
		super();
	}

	// -----------------------------------------------------------------------
	// 诊断日志
	// -----------------------------------------------------------------------

	private _dbg(msg: string, ...args: unknown[]): void {
		this.logService?.trace(`[KbGraphView] ${msg}`, ...args);
	}

	private _info(msg: string, ...args: unknown[]): void {
		this.logService?.info(`[KbGraphView] ${msg}`, ...args);
	}

	private _warn(msg: string, ...args: unknown[]): void {
		this.logService?.warn(`[KbGraphView] ${msg}`, ...args);
	}

	// -----------------------------------------------------------------------
	// 生命周期
	// -----------------------------------------------------------------------

	render(parent: HTMLElement): void {
		this._container = $('div.kb-graph-container');
		this._container.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:var(--vscode-editor-background);';

		this._canvas = document.createElement('canvas');
		this._canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
		this._container.appendChild(this._canvas);
		parent.appendChild(this._container);

		this._ctx = this._canvas.getContext('2d')!;

		// 事件绑定
		this._canvas.addEventListener('mousedown', this._onMouseDown);
		this._canvas.addEventListener('mousemove', this._onMouseMove);
		this._canvas.addEventListener('mouseup', this._onMouseUp);
		this._canvas.addEventListener('wheel', this._onWheel);
		this._canvas.addEventListener('click', this._onClick);
		this._canvas.addEventListener('dblclick', this._onDblClick);

		// Resize
		this._registerResizeObserver();

		this._centerX = this._canvas.width / 2;
		this._centerY = this._canvas.height / 2;
	}

	/** 加载图谱数据并开始布局渲染 */
	loadGraph(nodes: IGraphNode[], links: IGraphLink[]): void {
		this._nodes = [];
		this._edges = [];
		this._nodeMap.clear();

		// 重置选中与高亮状态
		this._selectedNode = null;
		this._selectedEdge = null;
		this._highlightedNodes.clear();
		this._highlightedEdges.clear();

		// 创建渲染节点
		for (const n of nodes) {
			const rn: IRenderNode = {
				data: n,
				x: this._centerX + (Math.random() - 0.5) * 200,
				y: this._centerY + (Math.random() - 0.5) * 200,
				vx: 0,
				vy: 0,
				radius: this._computeNodeRadius(n),
				color: n.color ?? COLOR_PALETTE.success.normal, // 默认紫罗兰宝石色
			};
			this._nodes.push(rn);
			this._nodeMap.set(n.id, rn);
		}

		// 创建渲染边
		for (const l of links) {
			const source = this._nodeMap.get(l.source);
			const target = this._nodeMap.get(l.target);
			if (source && target) {
				this._edges.push({ source, target, data: l });
			}
		}

		this._info(`loadGraph 完成：节点=${this._nodes.length}, 边=${this._edges.length}`);
		if (this._nodes.length > 800) {
			this._warn(`节点数=${this._nodes.length} 较大：力导向每帧约 ${this._nodes.length * this._nodes.length} 次斥力计算`);
		}
		this._startSimulation();
	}

	/** 重新执行力导向布局 */
	relayout(): void {
		if (this._nodes.length === 0) { return; }
		this._startSimulation();
	}

	resize(): void {
		if (!this._canvas) { return; }
		const rect = this._container.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this._canvas.width = rect.width * dpr;
		this._canvas.height = rect.height * dpr;
		this._canvas.style.width = rect.width + 'px';
		this._canvas.style.height = rect.height + 'px';
		this._ctx.setTransform(1, 0, 0, 1, 0, 0); // reset transform before scale
		this._ctx.scale(dpr, dpr);
		this._centerX = rect.width / 2;
		this._centerY = rect.height / 2;
		this._dbg(`resize canvas=${rect.width}x${rect.height} dpr=${dpr}`);
		this._requestDraw();
	}

	override dispose(): void {
		cancelAnimationFrame(this._animationId);
		if (this._canvas) {
			this._canvas.removeEventListener('mousedown', this._onMouseDown);
			this._canvas.removeEventListener('mousemove', this._onMouseMove);
			this._canvas.removeEventListener('mouseup', this._onMouseUp);
			this._canvas.removeEventListener('wheel', this._onWheel);
			this._canvas.removeEventListener('click', this._onClick);
			this._canvas.removeEventListener('dblclick', this._onDblClick);
		}
		super.dispose();
	}

	// -----------------------------------------------------------------------
	// 力导向布局（Eades 算法 + 碰撞半径 40 + 防重叠）
	// -----------------------------------------------------------------------

	private _startSimulation(): void {
		this._alpha = 1;
		this._iterations = 0;
		cancelAnimationFrame(this._animationId);
		this._simRunning = true;
		this._info(`启动力导向布局：节点=${this._nodes.length}, 边=${this._edges.length}, 单帧斥力计算≈${this._nodes.length * this._nodes.length}`);
		this._tick();
	}

	private _tick = (): void => {
		if (this._alpha < 0.01 && this._iterations > 100) {
			this._simRunning = false;
			this._info(`力导向布局已收敛（迭代=${this._iterations}, alpha=${this._alpha.toFixed(4)}, 节点=${this._nodes.length}）`);
			this._draw();
			return;
		}

		this._simulateStep();
		this._alpha *= 0.98;
		this._iterations++;
		this._draw();

		this._animationId = requestAnimationFrame(this._tick);
	};

	private _simulateStep(): void {
		const area = this._centerX * 2 * this._centerY * 2;
		const k = Math.sqrt(area / (this._nodes.length || 1)) * 0.2;
		const alpha = this._alpha;
		const collideRadius = LAYOUT.COLLIDE_RADIUS;

		// 斥力（Coulomb）+ 碰撞检测（防止重叠）
		for (let i = 0; i < this._nodes.length; i++) {
			for (let j = i + 1; j < this._nodes.length; j++) {
				const a = this._nodes[i];
				const b = this._nodes[j];
				if (a === this._dragging || b === this._dragging) { continue; }
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
				// 基础斥力
				const force = (k * k) / dist * alpha;
				// 碰撞半径 anti-overlap：距离小于碰撞半径时额外推力
				const minDist = a.radius + b.radius + collideRadius;
				const collisionForce = dist < minDist ? (minDist - dist) * alpha * 0.5 : 0;
				const totalForce = force + collisionForce;
				dx /= dist;
				dy /= dist;
				a.vx -= dx * totalForce;
				a.vy -= dy * totalForce;
				b.vx += dx * totalForce;
				b.vy += dy * totalForce;
			}
		}

		// 引力（Hooke）
		for (const edge of this._edges) {
			if (edge.source === this._dragging || edge.target === this._dragging) { continue; }
			let dx = edge.target.x - edge.source.x;
			let dy = edge.target.y - edge.source.y;
			const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
			const force = (dist - k * 2) * alpha * 0.1;
			dx /= dist;
			dy /= dist;
			edge.source.vx += dx * force;
			edge.source.vy += dy * force;
			edge.target.vx -= dx * force;
			edge.target.vy -= dy * force;
		}

		// 中心引力 + 速度衰减
		for (const node of this._nodes) {
			if (node === this._dragging) { continue; }
			node.vx += (this._centerX - node.x) * alpha * 0.001;
			node.vy += (this._centerY - node.y) * alpha * 0.001;
			node.vx *= 0.9;
			node.vy *= 0.9;
			node.x += node.vx;
			node.y += node.vy;
		}
	}

	// -----------------------------------------------------------------------
	// 渲染
	// -----------------------------------------------------------------------

	private _draw(): void {
		const ctx = this._ctx;
		const w = this._canvas.width / (window.devicePixelRatio || 1);
		const h = this._canvas.height / (window.devicePixelRatio || 1);
		this._drawCount++;
		if (this._drawCount % 30 === 1) {
			this._dbg(`重绘 #${this._drawCount} scale=${this._scale.toFixed(3)} offset=(${this._offsetX.toFixed(0)},${this._offsetY.toFixed(0)}) sim=${this._simRunning}`);
		}
		ctx.clearRect(0, 0, w, h);

		ctx.save();
		ctx.translate(this._offsetX + this._centerX, this._offsetY + this._centerY);
		ctx.scale(this._scale, this._scale);
		ctx.translate(-this._centerX, -this._centerY);

		// 边
		for (const edge of this._edges) {
			this._drawEdge(edge);
		}

		// 节点
		for (const node of this._nodes) {
			this._drawNode(node);
		}

		ctx.restore();
	}

	/** 获取节点的三态视觉状态 */
	private _getNodeState(node: IRenderNode): VisualState {
		if (this._highlightedNodes.has(node.data.id)) {
			return VisualState.HIGHLIGHTED;
		}
		if (node === this._selectedNode) {
			return VisualState.SELECTED;
		}
		return VisualState.DEFAULT;
	}

	/** 获取边的三态视觉状态 */
	private _getEdgeState(edge: IRenderEdge): VisualState {
		if (this._highlightedEdges.has(edge)) {
			return VisualState.HIGHLIGHTED;
		}
		if (edge === this._selectedEdge) {
			return VisualState.SELECTED;
		}
		return VisualState.DEFAULT;
	}

	// ---- 节点渲染 ----

	private _drawNode(node: IRenderNode): void {
		const ctx = this._ctx;
		const state = this._getNodeState(node);
		const style = NODE_STYLES[state];

		// 外发光阴影
		ctx.save();
		ctx.shadowBlur = style.shadowBlur;
		ctx.shadowColor = style.shadowColor;

		// 填充（紫罗兰宝石 / Indigo / 赛博金）
		ctx.fillStyle = style.fill;
		ctx.beginPath();
		ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
		ctx.fill();

		// 白描边
		ctx.shadowBlur = 0; // 重置阴影，只给填充加发光
		ctx.strokeStyle = style.stroke;
		ctx.lineWidth = style.lineWidth;
		ctx.beginPath();
		ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
		ctx.stroke();

		ctx.restore();

		// 悬停高亮环
		if (node === this._hoveredNode && node !== this._selectedNode && !this._highlightedNodes.has(node.data.id)) {
			ctx.save();
			ctx.strokeStyle = '#FFFFFF';
			ctx.lineWidth = 2;
			ctx.globalAlpha = 0.8;
			ctx.beginPath();
			ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
			ctx.stroke();
			ctx.restore();
		}

		// Halo 标签 + 半透明白底圆角 + 底部放置
		this._drawNodeLabel(node, style);
	}

	/** 绘制节点标签：Halo 描边 + 半透明白底圆角 + 底部放置 */
	private _drawNodeLabel(node: IRenderNode, style: INodeStyle): void {
		const ctx = this._ctx;
		const label = node.data.label.slice(0, 12);
		const fontSize = style.labelFontSize;
		const fontWeight = style.labelFontWeight;

		ctx.save();
		ctx.font = `${fontWeight} ${fontSize}px "SF Pro Display", system-ui, -apple-system, sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';

		// Halo 描边（确保在复杂背景下清晰）
		ctx.strokeStyle = TEXT_PALETTE.halo;
		ctx.lineWidth = 3;
		ctx.lineJoin = 'round';
		ctx.strokeText(label, node.x, node.y + node.radius + LAYOUT.LABEL_OFFSET);

		// 半透明白底圆角背景
		const metrics = ctx.measureText(label);
		const bw = metrics.width + LAYOUT.LABEL_PADDING[1] * 2;
		const bh = fontSize + LAYOUT.LABEL_PADDING[0] * 2;
		const bx = node.x - bw / 2;
		const by = node.y + node.radius + LAYOUT.LABEL_OFFSET - LAYOUT.LABEL_PADDING[0];

		ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
		ctx.beginPath();
		this._roundRect(ctx, bx, by, bw, bh, LAYOUT.LABEL_BG_RADIUS);
		ctx.fill();

		// 标签文字
		ctx.fillStyle = style.labelFill;
		ctx.fillText(label, node.x, node.y + node.radius + LAYOUT.LABEL_OFFSET);

		ctx.restore();
	}

	// ---- 边渲染 ----

	private _drawEdge(edge: IRenderEdge): void {
		const ctx = this._ctx;
		const state = this._getEdgeState(edge);
		const style = EDGE_STYLES[state];

		ctx.save();
		ctx.globalAlpha = style.opacity;

		// 发光效果
		if (style.shadowBlur > 0) {
			ctx.shadowBlur = style.shadowBlur;
			ctx.shadowColor = style.shadowColor;
		}

		ctx.strokeStyle = style.stroke;
		ctx.lineWidth = style.lineWidth;
		ctx.beginPath();
		ctx.moveTo(edge.source.x, edge.source.y);
		ctx.lineTo(edge.target.x, edge.target.y);
		ctx.stroke();

		ctx.restore();

		// 边标签（关系类型），仅非默认态或悬停时显示
		const showLabel = state !== VisualState.DEFAULT || edge === this._hoveredEdge;
		if (showLabel) {
			this._drawEdgeLabel(edge, style);
		}
	}

	/** 绘制边标签：关系类型 + 白底 */
	private _drawEdgeLabel(edge: IRenderEdge, style: IEdgeStyle): void {
		const ctx = this._ctx;
		const label = EDGE_LABEL_MAP[edge.data.type] || edge.data.type;
		const fontSize = style.labelFontSize;
		const fontWeight = style.labelFontWeight;

		// 标签放在边的中点
		const mx = (edge.source.x + edge.target.x) / 2;
		const my = (edge.source.y + edge.target.y) / 2;

		ctx.save();
		ctx.font = `${fontWeight} ${fontSize}px "SF Pro Display", system-ui, -apple-system, sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		const metrics = ctx.measureText(label);
		const bw = metrics.width + 8;
		const bh = fontSize + 6;

		// 白底背景
		ctx.globalAlpha = style.labelBgOpacity;
		ctx.fillStyle = style.labelBgFill;
		ctx.beginPath();
		this._roundRect(ctx, mx - bw / 2, my - bh / 2, bw, bh, 4);
		ctx.fill();

		// 标签文字
		ctx.globalAlpha = 1;
		ctx.fillStyle = style.labelFill;
		ctx.fillText(label, mx, my);

		ctx.restore();
	}

	/** 辅助：绘制圆角矩形 */
	private _roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + w - r, y);
		ctx.arcTo(x + w, y, x + w, y + r, r);
		ctx.lineTo(x + w, y + h - r);
		ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
		ctx.lineTo(x + r, y + h);
		ctx.arcTo(x, y + h, x, y + h - r, r);
		ctx.lineTo(x, y + r);
		ctx.arcTo(x, y, x + r, y, r);
		ctx.closePath();
	}

	// -----------------------------------------------------------------------
	// 交互
	// -----------------------------------------------------------------------

	private _requestDraw(): void {
		if (this._drawScheduled) { return; }
		this._drawScheduled = true;
		this._animationId = requestAnimationFrame(() => {
			this._drawScheduled = false;
			this._draw();
		});
	}

	private _getMousePos(e: MouseEvent): { mx: number; my: number } {
		const rect = this._canvas.getBoundingClientRect();
		return {
			mx: (e.clientX - rect.left - this._offsetX) / this._scale + this._centerX - this._centerX / this._scale,
			my: (e.clientY - rect.top - this._offsetY) / this._scale + this._centerY - this._centerY / this._scale,
		};
	}

	private _findNodeAt(mx: number, my: number): IRenderNode | null {
		for (const node of this._nodes) {
			const dx = mx - node.x;
			const dy = my - node.y;
			if (dx * dx + dy * dy < (node.radius + 5) * (node.radius + 5)) {
				return node;
			}
		}
		return null;
	}

	/** 检测鼠标是否在某条边的附近（距离线段 < 6px） */
	private _findEdgeAt(mx: number, my: number): IRenderEdge | null {
		const threshold = 6;
		let closest: IRenderEdge | null = null;
		let closestDist = threshold;

		for (const edge of this._edges) {
			const dist = this._distToSegment(mx, my, edge.source.x, edge.source.y, edge.target.x, edge.target.y);
			if (dist < closestDist) {
				closestDist = dist;
				closest = edge;
			}
		}
		return closest;
	}

	/** 点到线段的最短距离 */
	private _distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
		const abx = bx - ax;
		const aby = by - ay;
		const apx = px - ax;
		const apy = py - ay;
		const ab2 = abx * abx + aby * aby;
		if (ab2 === 0) { return Math.sqrt(apx * apx + apy * apy); }
		let t = (apx * abx + apy * aby) / ab2;
		t = Math.max(0, Math.min(1, t));
		const cx = ax + t * abx;
		const cy = ay + t * aby;
		return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
	}

	// ---- 鼠标按下 ----

	private _onMouseDown = (e: MouseEvent): void => {
		const { mx, my } = this._getMousePos(e);
		const node = this._findNodeAt(mx, my);
		if (node) {
			this._dragging = node;
			this._dragStartX = mx - node.x;
			this._dragStartY = my - node.y;
		} else {
			this._dragStartX = e.clientX - this._offsetX;
			this._dragStartY = e.clientY - this._offsetY;
		}
	};

	// ---- 鼠标移动 ----

	private _onMouseMove = (e: MouseEvent): void => {
		if (this._dragging) {
			const { mx, my } = this._getMousePos(e);
			this._dragging.x = mx - this._dragStartX;
			this._dragging.y = my - this._dragStartY;
			this._dragging.vx = 0;
			this._dragging.vy = 0;
			this._requestDraw();
			return;
		}
		if (e.buttons & 1) {
			// Pan
			this._offsetX = e.clientX - this._dragStartX;
			this._offsetY = e.clientY - this._dragStartY;
			this._requestDraw();
			return;
		}
		const { mx, my } = this._getMousePos(e);
		const hoveredNode = this._findNodeAt(mx, my);
		const hoveredEdge = this._findEdgeAt(mx, my);

		const changed = hoveredNode !== this._hoveredNode || hoveredEdge !== this._hoveredEdge;
		if (changed) {
			// 悬停边时如果也悬停在节点上，优先节点
			this._hoveredNode = hoveredNode;
			this._hoveredEdge = hoveredNode ? null : hoveredEdge;
			this._requestDraw();
		}
	};

	// ---- 鼠标松开 ----

	private _onMouseUp = (): void => {
		this._dragging = null;
	};

	// ---- 滚轮缩放 ----

	private _onWheel = (e: WheelEvent): void => {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.9 : 1.1;
		this._scale = Math.max(0.1, Math.min(3, this._scale * delta));
		this._requestDraw();
	};

	// ---- 单击 ----

	private _onClick = (e: MouseEvent): void => {
		if (this._dragging) { return; }
		const { mx, my } = this._getMousePos(e);
		const node = this._findNodeAt(mx, my);

		if (node) {
			// 选中节点
			this._selectedNode = node;
			this._selectedEdge = null;
			this._highlightedNodes.clear();
			this._highlightedEdges.clear();
			this._onNodeClick.fire({ node: node.data });
			this._requestDraw();
			return;
		}

		const edge = this._findEdgeAt(mx, my);
		if (edge) {
			// 选中边
			this._selectedNode = null;
			this._selectedEdge = edge;
			this._highlightedNodes.clear();
			this._highlightedEdges.clear();
			this._onEdgeClick.fire({ link: edge.data });
			this._requestDraw();
			return;
		}

		// 点击空白 → 清除选中
		this._selectedNode = null;
		this._selectedEdge = null;
		this._highlightedNodes.clear();
		this._highlightedEdges.clear();
		this._onClearSelection.fire();
		this._requestDraw();
	};

	// ---- 双击高亮相邻节点 ----

	private _onDblClick = (e: MouseEvent): void => {
		if (this._dragging) { return; }
		const { mx, my } = this._getMousePos(e);
		const node = this._findNodeAt(mx, my);

		if (!node) {
			// 双击空白 → 清除高亮
			this._highlightedNodes.clear();
			this._highlightedEdges.clear();
			this._requestDraw();
			return;
		}

		// 双击节点 → 高亮该节点及其相邻节点
		const highlighted = new Set<string>();
		highlighted.add(node.data.id); // 自身高亮
		const highlightedEdges = new Set<IRenderEdge>();

		for (const edge of this._edges) {
			if (edge.source === node) {
				highlighted.add(edge.target.data.id);
				highlightedEdges.add(edge);
			} else if (edge.target === node) {
				highlighted.add(edge.source.data.id);
				highlightedEdges.add(edge);
			}
		}

		this._highlightedNodes = highlighted;
		this._highlightedEdges = highlightedEdges;
		this._selectedNode = null;
		this._selectedEdge = null;
		this._info(`双击高亮节点=${node.data.label}，相邻节点=${highlighted.size}，关联边=${highlightedEdges.size}`);
		this._requestDraw();
	};

	// -----------------------------------------------------------------------
	// 辅助
	// -----------------------------------------------------------------------

	private _computeNodeRadius(node: IGraphNode): number {
		const baseSize = 6;
		const defs = node.defs ?? 0;
		if (defs <= 0) { return baseSize; }
		return baseSize + Math.log2(defs + 1) * 4;
	}

	private _registerResizeObserver(): void {
		const ro = new ResizeObserver(() => this.resize());
		ro.observe(this._container);
		this._register({ dispose: () => ro.disconnect() });
	}
}
