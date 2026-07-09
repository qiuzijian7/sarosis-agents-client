/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbGraphView.ts — Canvas 力导向图可视化（对齐 SiYuan Graph.ts）。
 *
 *  零外部依赖，使用 HTML5 Canvas 渲染，实现与 SiYuan vis-network 等价的：
 *   - 力导向布局（Eades 算法简化版）
 *   - 节点着色（按类型：文档/标签/标题）
 *   - 边渲染（引用 vs 树层级颜色区分）
 *   - 拖拽 + 滚轮缩放 + 点击导航
 *
 *  数据格式对齐 SiYuan GraphNode / GraphLink：
 *   - 节点：{ id, label, type, color? }
 *   - 边：{ source, target, type }
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

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

// 内部渲染边
interface IRenderEdge {
	source: IRenderNode;
	target: IRenderNode;
	type: string;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const NODE_COLORS: Record<string, string> = {
	doc: '#40a6ff',
	tag: '#ff8c00',
};

const LINK_COLORS: Record<string, string> = {
	wikilink: '#40a6ff',
	blockref: '#a0a0a0',
	tag: '#ff8c00',
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
	private _animationId = 0;

	// 事件
	private readonly _onNodeClick = this._register(new Emitter<IGraphClickEvent>());
	readonly onNodeClick: Event<IGraphClickEvent> = this._onNodeClick.event;

	constructor() {
		super();
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

		// 创建渲染节点
		for (const n of nodes) {
			const rn: IRenderNode = {
				data: n,
				x: this._centerX + (Math.random() - 0.5) * 200,
				y: this._centerY + (Math.random() - 0.5) * 200,
				vx: 0,
				vy: 0,
				radius: this._computeNodeRadius(n),
				color: n.color ?? NODE_COLORS[n.type] ?? '#888',
			};
			this._nodes.push(rn);
			this._nodeMap.set(n.id, rn);
		}

		// 创建渲染边
		for (const l of links) {
			const source = this._nodeMap.get(l.source);
			const target = this._nodeMap.get(l.target);
			if (source && target) {
				this._edges.push({ source, target, type: l.type });
			}
		}

		// 启动力导向布局
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
		this._ctx.scale(dpr, dpr);
		this._centerX = rect.width / 2;
		this._centerY = rect.height / 2;
	}

	override dispose(): void {
		cancelAnimationFrame(this._animationId);
		if (this._canvas) {
			this._canvas.removeEventListener('mousedown', this._onMouseDown);
			this._canvas.removeEventListener('mousemove', this._onMouseMove);
			this._canvas.removeEventListener('mouseup', this._onMouseUp);
			this._canvas.removeEventListener('wheel', this._onWheel);
			this._canvas.removeEventListener('click', this._onClick);
		}
		super.dispose();
	}

	// -----------------------------------------------------------------------
	// 力导向布局（简化 Eades 弹簧算法）
	// -----------------------------------------------------------------------

	private _startSimulation(): void {
		this._alpha = 1;
		this._iterations = 0;
		cancelAnimationFrame(this._animationId);
		this._tick();
	}

	private _tick = (): void => {
		if (this._alpha < 0.01 && this._iterations > 100) {
			this._draw();
			return;
		}

		this._simulateStep();
		this._alpha *= 0.98; // 冷却
		this._iterations++;
		this._draw();

		this._animationId = requestAnimationFrame(this._tick);
	};

	private _simulateStep(): void {
		const area = this._centerX * 2 * this._centerY * 2;
		const k = Math.sqrt(area / (this._nodes.length || 1)) * 0.2;
		const alpha = this._alpha;

		// 斥力（Coulomb）
		for (let i = 0; i < this._nodes.length; i++) {
			for (let j = i + 1; j < this._nodes.length; j++) {
				const a = this._nodes[i];
				const b = this._nodes[j];
				if (a === this._dragging || b === this._dragging) { continue; }
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
				const force = (k * k) / dist * alpha;
				dx /= dist;
				dy /= dist;
				a.vx -= dx * force;
				a.vy -= dy * force;
				b.vx += dx * force;
				b.vy += dy * force;
			}
		}

		// 引力（Hooke，沿边方向）
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
		ctx.clearRect(0, 0, w, h);

		ctx.save();
		ctx.translate(this._offsetX + this._centerX, this._offsetY + this._centerY);
		ctx.scale(this._scale, this._scale);
		ctx.translate(-this._centerX, -this._centerY);

		// 边
		for (const edge of this._edges) {
			const color = LINK_COLORS[edge.type] || '#666';
			ctx.strokeStyle = color;
			ctx.lineWidth = 1;
			ctx.globalAlpha = 0.5;
			ctx.beginPath();
			ctx.moveTo(edge.source.x, edge.source.y);
			ctx.lineTo(edge.target.x, edge.target.y);
			ctx.stroke();
		}

		// 节点
		for (const node of this._nodes) {
			ctx.globalAlpha = 1;
			ctx.fillStyle = node.color;
			ctx.beginPath();
			ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
			ctx.fill();

			// 悬停效果
			if (node === this._hoveredNode) {
				ctx.strokeStyle = '#fff';
				ctx.lineWidth = 2;
				ctx.stroke();
			}

			// 标签
			ctx.fillStyle = '#fff';
			ctx.font = '10px sans-serif';
			ctx.textAlign = 'center';
			const label = node.data.label.slice(0, 12);
			ctx.fillText(label, node.x, node.y + node.radius + 12);
		}

		ctx.restore();
	}

	// -----------------------------------------------------------------------
	// 交互
	// -----------------------------------------------------------------------

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

	private _onMouseMove = (e: MouseEvent): void => {
		if (this._dragging) {
			const { mx, my } = this._getMousePos(e);
			this._dragging.x = mx - this._dragStartX;
			this._dragging.y = my - this._dragStartY;
			this._dragging.vx = 0;
			this._dragging.vy = 0;
			return;
		}
		if (e.buttons & 1) {
			// Pan
			this._offsetX = e.clientX - this._dragStartX;
			this._offsetY = e.clientY - this._dragStartY;
			return;
		}
		const { mx, my } = this._getMousePos(e);
		this._hoveredNode = this._findNodeAt(mx, my);
	};

	private _onMouseUp = (): void => {
		this._dragging = null;
	};

	private _onWheel = (e: WheelEvent): void => {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.9 : 1.1;
		this._scale = Math.max(0.1, Math.min(3, this._scale * delta));
	};

	private _onClick = (e: MouseEvent): void => {
		if (this._dragging) { return; }
		const { mx, my } = this._getMousePos(e);
		const node = this._findNodeAt(mx, my);
		if (node) {
			this._onNodeClick.fire({ node: node.data });
		}
	};

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
