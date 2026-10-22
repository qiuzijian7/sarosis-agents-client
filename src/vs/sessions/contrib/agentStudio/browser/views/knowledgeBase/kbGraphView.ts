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
 *   - 交互：单击仅选中节点/边（视觉反馈，不触发响应）、点击空白清除、
 *           双击节点才触发响应（fire onNodeClick，由宿主打开编辑器）+ 高亮相邻节点、
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
//
// 设计色值为「Dark+ 主题下的默认观感」，同时映射到 VS Code 主题变量。
// resolveTheme() 在渲染时读取这些 CSS 变量（回退到设计色值），
// 因此图谱会随编辑器主题切换而更新，而非把色值写死。
// ---------------------------------------------------------------------------

/** 一组语义色的「设计默认值 + VS Code 主题变量名」映射 */
interface IThemeColor {
	/** 设计默认色值（无主题变量或变量为空时回退） */
	fallback: string;
	/** VS Code CSS 变量名（省略则以 fallback 为准） */
	varName?: string;
}

const THEME_COLOR_KEYS = {
	// ── 节点 / 边强调色 ──
	primaryNormal: { fallback: '#6366F1', varName: '--vscode-focusBorder' }, // Indigo — 选中态
	primaryHover: { fallback: '#4F46E5' },
	primaryGlow: { fallback: '#818CF8' },
	successNormal: { fallback: '#8B5CF6' }, // Violet — 默认节点色
	successHover: { fallback: '#7C3AED' },
	warningNormal: { fallback: '#FFD700', varName: '--vscode-editorWarning-foreground' }, // Cyber Gold — 高亮态
	warningHover: { fallback: '#F59E0B' },
	warningGlow: { fallback: '#FDE68A' },
	// ── 中性色 ──
	neutralLight: { fallback: '#64748B', varName: '--vscode-descriptionForeground' },
	neutralLighter: { fallback: '#F1F5F9', varName: '--vscode-editor-background' },
	neutralMuted: { fallback: '#94A3B8' },
	// ── 文本 / 描边 ──
	textLabel: { fallback: '#1E293B', varName: '--vscode-editor-foreground' },
	textDescription: { fallback: '#64748B', varName: '--vscode-descriptionForeground' },
	textContrast: { fallback: '#FFFFFF', varName: '--vscode-editor-background' },
	textHalo: { fallback: '#FFFFFF', varName: '--vscode-editor-background' },
} satisfies Record<string, IThemeColor>;

/** 解析后的主题色板 */
type IResolvedTheme = Record<keyof typeof THEME_COLOR_KEYS, string>;

/** 读取单个 VS Code CSS 变量，空值回退到设计色值 */
function readThemeVar(el: HTMLElement | undefined, spec: IThemeColor): string {
	if (!spec.varName || !el) {
		return spec.fallback;
	}
	const value = getComputedStyle(el).getPropertyValue(spec.varName).trim();
	return value || spec.fallback;
}

/** 依据宿主元素解析整套主题色板（渲染时调用，可热跟随主题） */
function resolveTheme(host: HTMLElement | undefined): IResolvedTheme {
	const resolved = {} as IResolvedTheme;
	for (const key of Object.keys(THEME_COLOR_KEYS) as (keyof IResolvedTheme)[]) {
		resolved[key] = readThemeVar(host, THEME_COLOR_KEYS[key]);
	}
	return resolved;
}

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
	/** 节点碰撞半径（防止重叠），40 → 28 允许节点更紧凑排布 */
	COLLIDE_RADIUS: 28,
	/** 标签相对于节点中心的底部偏移 */
	LABEL_OFFSET: 15,
	/** 标签背景圆角 */
	LABEL_BG_RADIUS: 6,
	/** 标签内边距 [vertical, horizontal] */
	LABEL_PADDING: [2, 6] as [number, number],
	/**
	 * ★ 2026-10-19：**低于这个缩放就不画默认态标签**（选中/hover/邻居不受限，永远画）。
	 *   原因：标签是"白底 + 12px 小字"，缩得小的时候会糊成一片（真机反馈"满屏小方块"），
	 *   而缩放回来又瞬间恢复 ⇒ 保留了"看名字"的能力，只是不再全程噪声。
	 */
	LABEL_MIN_SCALE: 0.6,
	/** 标签最多显示几个字（原 12 —— 中文标题普遍 8-15 字，放到 18 更完整） */
	LABEL_MAX_CHARS: 18,
};

/**
 * 力导向参数（★ 2026-10-19 P1：工具条 ⚙ 面板可调）。
 *
 * 原先是 `_simulateStep` 里的三个魔数（0.16 / 0.2 / 0.008）—— 用户既看不出含义也改不了 ✗，
 * 而"图摊得太开 / 挤成一团"恰恰是最常见的调参诉求（Obsidian 就有 Forces 面板）。
 * 值域只是面板滑杆的**提示**，代码不做强校验（让用户能调到极端再调回来 ✓）。
 */
export interface IGraphForces {
	/** 排斥强度（理想边长系数）：越大节点越散，默认 0.16 */
	repulsion: number;
	/** 连线吸引强度：越大相连节点越紧，默认 0.20 */
	spring: number;
	/** 向心强度：越大整体越聚拢，默认 0.008 */
	center: number;
}

export const DEFAULT_GRAPH_FORCES: IGraphForces = { repulsion: 0.16, spring: 0.2, center: 0.008 };

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

/** 依据主题色板生成三态节点样式（渲染时求值，支持主题热切换） */
function buildNodeStyles(theme: IResolvedTheme): Record<VisualState, INodeStyle> {
	return {
		[VisualState.DEFAULT]: {
			fill: theme.successNormal,          // Violet — 默认节点色
			stroke: theme.textContrast,
			lineWidth: 1.5,
			shadowBlur: 15,
			shadowColor: `${theme.successNormal}80`,
			labelFontWeight: 500,
			labelFill: theme.textLabel,
			labelFontSize: 12,
		},
		[VisualState.SELECTED]: {
			fill: theme.primaryNormal,          // Indigo — 选中态
			stroke: theme.textContrast,
			lineWidth: 3,
			shadowBlur: 30,
			shadowColor: `${theme.primaryGlow}B0`,
			labelFontWeight: 800,
			labelFill: theme.primaryNormal,
			labelFontSize: 14,
		},
		[VisualState.HIGHLIGHTED]: {
			fill: theme.warningNormal,          // Cyber Gold — 高亮态
			stroke: theme.textContrast,
			lineWidth: 3,
			shadowBlur: 35,
			shadowColor: `${theme.warningNormal}A0`,
			labelFontWeight: 800,
			labelFill: '#000000',
			labelFontSize: 14,
		},
	};
}

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

/** 依据主题色板生成三态边样式（渲染时求值，支持主题热切换） */
function buildEdgeStyles(theme: IResolvedTheme): Record<VisualState, IEdgeStyle> {
	return {
		[VisualState.DEFAULT]: {
			stroke: theme.neutralMuted,                  // Slate-300 附近的中性色
			lineWidth: 1.2,
			opacity: 0.45,
			shadowBlur: 0,
			shadowColor: 'transparent',
			labelFill: theme.textLabel,
			labelFontSize: 11,
			labelFontWeight: 700,
			labelBgFill: theme.textContrast,
			labelBgOpacity: 0.75,
		},
		[VisualState.SELECTED]: {
			stroke: theme.primaryNormal,                 // Indigo
			lineWidth: 3,
			opacity: 1,
			shadowBlur: 10,
			shadowColor: `${theme.primaryNormal}80`,
			labelFill: theme.primaryNormal,
			labelFontSize: 12,
			labelFontWeight: 800,
			labelBgFill: theme.textContrast,
			labelBgOpacity: 0.85,
		},
		[VisualState.HIGHLIGHTED]: {
			stroke: theme.warningNormal,                 // Cyber Gold
			lineWidth: 3.5,
			opacity: 1,
			shadowBlur: 10,
			shadowColor: `${theme.warningNormal}60`,
			labelFill: '#000000',
			labelFontSize: 12,
			labelFontWeight: 800,
			labelBgFill: theme.textContrast,
			labelBgOpacity: 0.85,
		},
	};
}

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
	/**
	 * ★ 2026-10-19：**hover 邻居高亮**（对齐 Obsidian「悬停即看连接」）用的**独立集合**。
	 *
	 * 为什么不复用 `_highlightedNodes`：那个是**双击钉住**的（持久，直到下次点击/双击），
	 * 而 hover 是**临时**的（鼠标移开就该消失）。共用一个集合的话，鼠标移开会把双击钉住的
	 * 高亮一起清掉 ✗。⇒ 状态判定时取两者**并集**，清理时只清自己那一对 ✓。
	 */
	private _hoverNeighborNodes: Set<string> = new Set();
	/** 同上：hover 邻居关联的边 */
	private _hoverNeighborEdges: Set<IRenderEdge> = new Set();

	/**
	 * ★ 2026-10-19（P1，对齐 Obsidian 的 Filters）：是否显示**孤立节点**（度数为 0）。
	 * 默认 `true` —— 隐藏后用户很容易误以为"笔记丢了"；真正需要时（库大、孤点淹没主体）才关掉。
	 */
	private _showOrphans = true;
	/**
	 * ★ 2026-10-19（P1，对齐 Obsidian 的 **Local graph**）：只渲染该节点 N 跳内的子图。
	 * `null` = 全图。深度目前固定 1（hover 邻居已覆盖 1 跳的"看连接"需求，
	 * 聚焦用于"把周围这一圈单独拎出来看"）。
	 */
	private _localFocus: { id: string; depth: number } | null = null;
	/**
	 * 聚焦可见集合的**缓存**（`null` = 不限制）。
	 * ⚠ 必须在 `_draw` 里读缓存而不是现算：BFS 是 O(N×E)，每帧算会打满主线程 ✗。
	 */
	private _focusCache: Set<string> | null = null;
	/** 度数表（id → 关联边数）：孤点判定 + 局部聚焦 BFS 用；loadGraph 时重建。 */
	private _degree = new Map<string, number>();
	/** ★ 2026-10-19（P1）：力导向参数（⚙ 面板可调，见 IGraphForces） */
	private _forces: IGraphForces = { ...DEFAULT_GRAPH_FORCES };
	/** 标签显示阈值（低于该缩放不画默认态标签；⚙ 面板可调） */
	private _labelMinScale = LAYOUT.LABEL_MIN_SCALE;

	// 诊断状态
	private _simRunning = false;
	private _drawScheduled = false;
	private _drawCount = 0;

	// 主题（渲染时解析；随编辑器主题变化刷新）
	private _theme: IResolvedTheme = resolveTheme(undefined);
	private _nodeStyles: Record<VisualState, INodeStyle> = buildNodeStyles(this._theme);
	private _edgeStyles: Record<VisualState, IEdgeStyle> = buildEdgeStyles(this._theme);

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

		// 解析主题（挂载后 container 已在文档中，可读到 CSS 变量）
		this._refreshTheme();

		// 事件绑定
		this._canvas.addEventListener('mousedown', this._onMouseDown);
		this._canvas.addEventListener('mousemove', this._onMouseMove);
		this._canvas.addEventListener('mouseup', this._onMouseUp);
		this._canvas.addEventListener('wheel', this._onWheel);
		this._canvas.addEventListener('click', this._onClick);
		this._canvas.addEventListener('dblclick', this._onDblClick);
		// ★ 2026-10-19：移出画布要清掉临时 hover 高亮（否则鼠标移走后邻居还亮着 ✗）
		this._canvas.addEventListener('mouseleave', this._onMouseLeave);

		// Resize
		this._registerResizeObserver();

		this._centerX = this._canvas.width / 2;
		this._centerY = this._canvas.height / 2;
	}

	/** 重新解析主题色板与派生样式（宿主主题变化时可再次调用） */
	private _refreshTheme(): void {
		this._theme = resolveTheme(this._container ?? document.body);
		this._nodeStyles = buildNodeStyles(this._theme);
		this._edgeStyles = buildEdgeStyles(this._theme);
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
				color: n.color ?? this._theme.successNormal, // 默认紫罗兰宝石色
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

		// ★ 2026-10-19（P1）：重建度数表（孤点开关 / 局部聚焦 BFS 都用它）；
		//   新数据到来时旧的聚焦目标可能已不存在 ⇒ 清掉，否则会画出一张空图 ✗。
		this._degree.clear();
		for (const e of this._edges) {
			this._degree.set(e.source.data.id, (this._degree.get(e.source.data.id) ?? 0) + 1);
			this._degree.set(e.target.data.id, (this._degree.get(e.target.data.id) ?? 0) + 1);
		}
		this._localFocus = null;
		this._focusCache = null;   // 新数据 ⇒ 聚焦缓存必须失效（否则会画出上一份图的子集 ✗）

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

	// -----------------------------------------------------------------------
	// P1（2026-10-19）：过滤（孤点）/ 局部聚焦 / 适应视图
	// -----------------------------------------------------------------------

	/**
	 * 计算局部聚焦的可见集合（BFS `depth` 跳）；`null` ⇒ 不限制（全图）。
	 *
	 * ⚠ 这是 **O(N×E)**（550 节点 × 550 边 ≈ 30 万次），**绝不能每帧算** ✗ ——
	 *   60fps 下会直接把主线程打满。⇒ 只在聚焦目标变化时算一次，结果存 `_focusCache`，
	 *   渲染时读缓存（见 `_focusSet()`）。
	 */
	private _computeFocusSet(): Set<string> | null {
		const focus = this._localFocus;
		if (!focus) { return null; }
		const start = this._nodeMap.get(focus.id);
		if (!start) { return null; }
		const keep = new Set<string>([focus.id]);
		let frontier: IRenderNode[] = [start];
		for (let d = 0; d < focus.depth && frontier.length > 0; d++) {
			const next: IRenderNode[] = [];
			for (const node of frontier) {
				for (const edge of this._edges) {
					const other = edge.source === node ? edge.target : (edge.target === node ? edge.source : null);
					if (other && !keep.has(other.data.id)) {
						keep.add(other.data.id);
						next.push(other);
					}
				}
			}
			frontier = next;
		}
		return keep;
	}

	/** 重算聚焦缓存（`setLocalFocus` / `loadGraph` 之后调用一次即可）。 */
	private _recomputeFocus(): void {
		this._focusCache = this._computeFocusSet();
	}

	/** 渲染期读聚焦缓存（O(1)；不要在 `_draw` 里调 `_computeFocusSet` ✗）。 */
	private _focusSet(): Set<string> | null {
		return this._focusCache;
	}

	/** 节点当前是否该画（聚焦过滤优先，其次孤点开关）。 */
	private _isNodeVisible(node: IRenderNode, focus: Set<string> | null): boolean {
		if (focus) { return focus.has(node.data.id); }
		if (!this._showOrphans && (this._degree.get(node.data.id) ?? 0) === 0) { return false; }
		return true;
	}

	/** 边是否该画：**两端都要可见** —— 否则会出现"连向一个看不见的点"的悬空线 ✗。 */
	private _isEdgeVisible(edge: IRenderEdge, focus: Set<string> | null): boolean {
		return this._isNodeVisible(edge.source, focus) && this._isNodeVisible(edge.target, focus);
	}

	/** 显示/隐藏孤立节点（度数为 0）。默认显示 —— 藏起来容易让人以为"笔记丢了"。 */
	setShowOrphans(show: boolean): void {
		if (this._showOrphans === show) { return; }
		this._showOrphans = show;
		this._requestDraw();
	}

	getShowOrphans(): boolean { return this._showOrphans; }

	/**
	 * 局部聚焦：只显示 `id` 的 `depth` 跳子图（对齐 Obsidian 的 Local graph）。
	 * @param id null ⇒ 回全图
	 */
	setLocalFocus(id: string | null, depth = 1): void {
		if (!id) {
			if (!this._localFocus) { return; }
			this._localFocus = null;
			this._recomputeFocus();   // 清缓存 ⇒ 恢复全图
			this._requestDraw();
			return;
		}
		if (!this._nodeMap.has(id)) { return; }   // 找不到就不动（不画空图 ✗）
		this._localFocus = { id, depth: Math.max(1, depth | 0) };
		this._recomputeFocus();       // ★ 只在这里算一次 BFS（渲染期读缓存 ✓）
		this._requestDraw();
	}

	/** 当前聚焦的节点 id（null = 全图） */
	getLocalFocusId(): string | null { return this._localFocus?.id ?? null; }

	/**
	 * 按标题模糊查找节点（⚙ 面板的「聚焦到某篇」用）。
	 *
	 * 匹配顺序：**精确**（忽略大小写）→ 首个**包含**匹配 ⇒ 命中返回 `data.id`，否则 `null`。
	 * ⚠ 先精确再包含：否则输"分析"时可能跳到第一篇名字里恰好含"分析"的无关笔记 ✗。
	 */
	findNodeByLabel(text: string): string | null {
		const q = String(text ?? '').trim().toLowerCase();
		if (!q) { return null; }
		let partial: string | null = null;
		for (const node of this._nodes) {
			const label = String(node.data.label ?? '').toLowerCase();
			if (label === q) { return node.data.id; }
			if (!partial && label.includes(q)) { partial = node.data.id; }
		}
		return partial;
	}

	/** 当前选中的节点 id（工具条「聚焦」用；没选中时调用方可用 hover 兜底） */
	getSelectedNodeId(): string | null { return this._selectedNode?.data.id ?? null; }

	/** 当前 hover 的节点 id（同上） */
	getHoveredNodeId(): string | null { return this._hoveredNode?.data.id ?? null; }

	/** 可见节点数（孤点/聚焦过滤后；工具条计数用） */
	getVisibleCount(): number {
		const focus = this._focusSet();
		let n = 0;
		for (const node of this._nodes) { if (this._isNodeVisible(node, focus)) { n++; } }
		return n;
	}

	/**
	 * 把整张图缩放到画布内（对齐 Obsidian 的"适应视图"）。
	 * 变换口径与 `_draw` 一致：`screen = (world - center) * scale + offset + center`
	 *   ⇒ 让世界包围盒中心落到画布中心，只需要 `offset = -(worldCenter - center) * scale` ✓。
	 */
	/**
	 * @param onlyVisible `true`（默认）= **只按当前可见节点**算包围盒 —— 聚焦/隐藏孤点时，
	 *   按全图算会把视野缩到整库尺度 ⇒ 聚焦等于白聚焦 ✗（这是本轮实测出来的）。
	 */
	fitToView(onlyVisible = true): void {
		if (!this._canvas || this._nodes.length === 0) { return; }
		const dpr = window.devicePixelRatio || 1;
		const w = this._canvas.width / dpr;
		const h = this._canvas.height / dpr;
		const focus = this._focusSet();
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const node of this._nodes) {
			if (onlyVisible && !this._isNodeVisible(node, focus)) { continue; }
			if (node.x < minX) { minX = node.x; }
			if (node.x > maxX) { maxX = node.x; }
			if (node.y < minY) { minY = node.y; }
			if (node.y > maxY) { maxY = node.y; }
		}
		// 一个可见节点都没有（过滤光了）⇒ 不动视野，交给画布中央的提示说明情况
		if (!Number.isFinite(minX) || !Number.isFinite(minY)) { return; }
		const pad = 60;
		const bw = Math.max(1, maxX - minX);
		const bh = Math.max(1, maxY - minY);
		const scale = Math.max(0.1, Math.min(3, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
		this._scale = scale;
		this._offsetX = -(((minX + maxX) / 2) - this._centerX) * scale;
		this._offsetY = -(((minY + maxY) / 2) - this._centerY) * scale;
		this._requestDraw();
	}

	/** 当前力参数（⚙ 面板初始化用） */
	getForces(): IGraphForces { return { ...this._forces }; }

	/**
	 * 更新力参数（★ 2026-10-19 P1，⚙ 面板驱动）。
	 *
	 * @param relayout 默认 `true` = **重新加热**布局（`alpha` 归 1 后重跑，**位置保留**）——
	 *   拖滑杆时用户要"立刻看到图变化"；若只想改值不重排（例如启动时恢复持久化配置），传 `false`。
	 * ⚠ `relayout()` 不会重置坐标（见它的实现）⇒ 拖滑杆不会把布局打散 ✓。
	 */
	setForces(patch: Partial<IGraphForces>, relayout = true): void {
		this._forces = { ...this._forces, ...patch };
		if (relayout) { this.relayout(); } else { this._requestDraw(); }
	}

	/** 标签显示阈值（低于该缩放不画默认态标签） */
	getLabelMinScale(): number { return this._labelMinScale; }

	/** 设置标签显示阈值（夹在 0.2–2.0；非数字按默认值处理） */
	setLabelMinScale(v: number): void {
		const n = Number.isFinite(v) ? v : LAYOUT.LABEL_MIN_SCALE;
		this._labelMinScale = Math.max(0.2, Math.min(2, n));
		this._requestDraw();
	}

	/** 当前图规模（工具条计数用；2026-10-19 —— 用户看到"20 个点 0 条线"就能自己判断是不是没建链接 ✓）。 */
	getStats(): { nodes: number; links: number } {
		return { nodes: this._nodes.length, links: this._edges.length };
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
			this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
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
		// 理想边长 = sqrt(面积/节点数) × **排斥强度**（原先是写死的 0.16；现在可调，见 IGraphForces）
		const k = Math.sqrt(area / (this._nodes.length || 1)) * this._forces.repulsion;
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
			// 弹簧引力：系数可调（默认 0.2 —— 越大相连节点被拉得越近）
			const force = (dist - k * 2) * alpha * this._forces.spring;
			dx /= dist;
			dy /= dist;
			edge.source.vx += dx * force;
			edge.source.vy += dy * force;
			edge.target.vx -= dx * force;
			edge.target.vy -= dy * force;
		}

		// 中心引力（0.001 → 0.008，显著增强以收敛整体散布）+ 速度衰减
		for (const node of this._nodes) {
			if (node === this._dragging) { continue; }
			// 中心引力：系数可调（默认 0.008 —— 越大整体越聚拢）
			node.vx += (this._centerX - node.x) * alpha * this._forces.center;
			node.vy += (this._centerY - node.y) * alpha * this._forces.center;
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

		// ★ 2026-10-19（P1）：过滤 —— 局部聚焦优先，其次孤点开关（两者都只影响**渲染**，
		//   被隐藏的节点仍然参与力导向计算 ⇒ 反复开关不会把布局打散 ✓）。
		const focus = this._focusSet();

		// 边（两端都要可见才画；否则会出现"连向一个看不见的点"的悬空线 ✗）
		for (const edge of this._edges) {
			if (!this._isEdgeVisible(edge, focus)) { continue; }
			this._drawEdge(edge);
		}

		// 节点
		let drawn = 0;
		for (const node of this._nodes) {
			if (!this._isNodeVisible(node, focus)) { continue; }
			this._drawNode(node);
			drawn++;
		}

		ctx.restore();

		// ★ 2026-10-19：**空图引导**（真机反馈："一堆散点，不知道是不是坏了"）。
		//   边只来自 `[[双链]]`；库里没有互链时画布必然是一堆孤立点 —— 这是**数据状态**，
		//   不是故障，但原先界面一句解释都没有 ⇒ 用户只能判成 bug ✗（与 Obsidian 的差距也在这里：
		//   它会用 Orphans 开关 / Filters 让你立刻明白"是没建链接"）。
		if (this._nodes.length === 0) {
			this._drawHintLine(w, h, '没有可显示的笔记', '先点右上角「🔄 构建图谱」扫描知识库（库 + 笔记）');
		} else if (drawn === 0) {
			// 被过滤光了要**说清是哪种过滤**（否则用户以为图和数据都没了 ✗）
			this._drawHintLine(w, h, '当前过滤条件下没有可见节点',
				focus ? '点工具条「⤢ 全图」退出聚焦' : '点工具条「◌ 孤点」把孤立笔记显示出来');
		} else if (this._edges.length === 0) {
			this._drawHintLine(w, h, `本库 ${this._nodes.length} 篇笔记，0 条双链`, '在笔记里写 [[另一篇笔记名]] 就会连线；也可点「重新布局」看分布');
		}
	}

	/**
	 * 画布中央的两行提示（空图 / 无边）。
	 * ⚠ 在 `ctx.restore()` **之后**用屏幕坐标绘制 ⇒ 不跟随缩放平移，任何视图下都居中可见 ✓。
	 */
	private _drawHintLine(w: number, h: number, title: string, detail: string): void {
		const ctx = this._ctx;
		const font = '"SF Pro Display", system-ui, -apple-system, sans-serif';
		ctx.save();
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillStyle = this._theme.textLabel;
		ctx.globalAlpha = 0.85;
		ctx.font = `600 13px ${font}`;
		ctx.fillText(title, w / 2, h / 2 - 12);
		ctx.globalAlpha = 0.6;
		ctx.font = `400 11px ${font}`;
		ctx.fillText(detail, w / 2, h / 2 + 12);
		ctx.restore();
	}

	/**
	 * 某节点的「自身 + 相邻节点 + 关联边」三件套。
	 *
	 * ★ 2026-10-19：抽出来给**双击（钉住）**与**hover（临时）**共用同一套算法
	 *   —— 原来这段写在 `_onDblClick` 里，hover 想加就得抄一遍（抄了就必然漂移 ✗）。
	 */
	private _neighborSetsOf(node: IRenderNode): { nodes: Set<string>; edges: Set<IRenderEdge> } {
		const nodes = new Set<string>([node.data.id]);
		const edges = new Set<IRenderEdge>();
		for (const edge of this._edges) {
			if (edge.source === node) {
				nodes.add(edge.target.data.id);
				edges.add(edge);
			} else if (edge.target === node) {
				nodes.add(edge.source.data.id);
				edges.add(edge);
			}
		}
		return { nodes, edges };
	}

	/** 更新 hover 邻居集合（node 为 null ⇒ 清空）。只在 hovered 变化时调用，不做逐帧计算。 */
	private _updateHoverNeighbors(node: IRenderNode | null): void {
		if (!node) {
			if (this._hoverNeighborNodes.size > 0 || this._hoverNeighborEdges.size > 0) {
				this._hoverNeighborNodes = new Set();
				this._hoverNeighborEdges = new Set();
			}
			return;
		}
		const { nodes, edges } = this._neighborSetsOf(node);
		this._hoverNeighborNodes = nodes;
		this._hoverNeighborEdges = edges;
	}

	/** 获取节点的三态视觉状态（双击钉住 ∪ hover 邻居 —— 任一命中都算 HIGHLIGHTED） */
	private _getNodeState(node: IRenderNode): VisualState {
		if (this._highlightedNodes.has(node.data.id) || this._hoverNeighborNodes.has(node.data.id)) {
			return VisualState.HIGHLIGHTED;
		}
		if (node === this._selectedNode) {
			return VisualState.SELECTED;
		}
		return VisualState.DEFAULT;
	}

	/** 获取边的三态视觉状态（同上，取并集） */
	private _getEdgeState(edge: IRenderEdge): VisualState {
		if (this._highlightedEdges.has(edge) || this._hoverNeighborEdges.has(edge)) {
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
		const style = this._nodeStyles[state];

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
			ctx.strokeStyle = this._theme.textHalo;
			ctx.lineWidth = 2;
			ctx.globalAlpha = 0.8;
			ctx.beginPath();
			ctx.arc(node.x, node.y, node.radius + 3, 0, Math.PI * 2);
			ctx.stroke();
			ctx.restore();
		}

		// Halo 标签 + 半透明白底圆角 + 底部放置
		if (this._shouldDrawLabel(node, state)) {
			this._drawNodeLabel(node, style);
		}
	}

	/**
	 * 是否画这个节点的标签（★ 2026-10-19，标签降噪）。
	 *
	 * 规则（从宽到窄）：
	 *   1. 选中 / 双击高亮 / hover 邻居 ⇒ **一定画**（这些是"我正在看它"的节点）；
	 *   2. hover 的那个节点自身 ⇒ 一定画；
	 *   3. 其余 ⇒ 只在 `scale >= LABEL_MIN_SCALE` 时画。
	 *
	 * 为什么这么切：标签是"白底 12px 小字"，缩小时会和节点糊成一片小方块（真机反馈），
	 * 而"放大就能看到名字"这条能力必须保留 ⇒ 用缩放阈值而不是一刀切关掉。
	 */
	private _shouldDrawLabel(node: IRenderNode, state: VisualState): boolean {
		if (state !== VisualState.DEFAULT) { return true; }
		if (node === this._hoveredNode) { return true; }
		// 阈值可调（⚙ 面板）；默认 LAYOUT.LABEL_MIN_SCALE = 0.6
		return this._scale >= this._labelMinScale;
	}

	/** 绘制节点标签：Halo 描边 + 半透明白底圆角 + 底部放置 */
	private _drawNodeLabel(node: IRenderNode, style: INodeStyle): void {
		const ctx = this._ctx;
		// ★ 2026-10-19：12 → 18 字（中文标题普遍 8–15 字，12 会截掉关键后缀，看不出是哪篇）
		const label = node.data.label.slice(0, LAYOUT.LABEL_MAX_CHARS);
		const fontSize = style.labelFontSize;
		const fontWeight = style.labelFontWeight;

		ctx.save();
		ctx.font = `${fontWeight} ${fontSize}px "SF Pro Display", system-ui, -apple-system, sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';

		// Halo 描边（确保在复杂背景下清晰）
		ctx.strokeStyle = this._theme.textHalo;
		ctx.lineWidth = 3;
		ctx.lineJoin = 'round';
		ctx.strokeText(label, node.x, node.y + node.radius + LAYOUT.LABEL_OFFSET);

		// 半透明白底圆角背景
		const metrics = ctx.measureText(label);
		const bw = metrics.width + LAYOUT.LABEL_PADDING[1] * 2;
		const bh = fontSize + LAYOUT.LABEL_PADDING[0] * 2;
		const bx = node.x - bw / 2;
		const by = node.y + node.radius + LAYOUT.LABEL_OFFSET - LAYOUT.LABEL_PADDING[0];

		// 半透明白底（固定浅色覆盖层，与主题色无关：用于在任意节点色上保证标签可读）
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
		const style = this._edgeStyles[state];

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
			// ★ 2026-10-19：**悬停即高亮邻居**（对齐 Obsidian「Hover over each circle to highlight
			//   that note's connections」）—— 原先只有双击才高亮，想"看看这篇连了谁"必须先双击，
			//   而双击还会顺带打开笔记（打断浏览 ✗）。
			this._updateHoverNeighbors(hoveredNode);
			this._requestDraw();
		}
	};

	/** 鼠标移出画布 ⇒ 清掉**临时** hover 状态（双击钉住的高亮不受影响 ✓） */
	private _onMouseLeave = (): void => {
		if (this._hoveredNode || this._hoveredEdge || this._hoverNeighborNodes.size > 0) {
			this._hoveredNode = null;
			this._hoveredEdge = null;
			this._updateHoverNeighbors(null);
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
		const oldScale = this._scale;
		const newScale = Math.max(0.1, Math.min(3, oldScale * delta));
		if (newScale === oldScale) { return; }

		// 以鼠标位置为中心缩放：保持鼠标下的世界坐标点在缩放前后不动。
		// 世界→屏幕变换：screen = (world - center) * scale + offset + center
		const rect = this._canvas.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		// 鼠标下的世界坐标（缩放前）
		const worldX = (mx - this._offsetX - this._centerX) / oldScale + this._centerX;
		const worldY = (my - this._offsetY - this._centerY) / oldScale + this._centerY;
		// 反解新 offset，使该世界点在新缩放下仍位于鼠标处
		this._offsetX = mx - (worldX - this._centerX) * newScale - this._centerX;
		this._offsetY = my - (worldY - this._centerY) * newScale - this._centerY;
		this._scale = newScale;
		this._requestDraw();
	};

	// ---- 单击 ----

	private _onClick = (e: MouseEvent): void => {
		if (this._dragging) { return; }
		const { mx, my } = this._getMousePos(e);
		const node = this._findNodeAt(mx, my);

		if (node) {
			// 单击仅选中节点（视觉反馈），不触发响应；响应改由双击触发
			this._selectedNode = node;
			this._selectedEdge = null;
			this._highlightedNodes.clear();
			this._highlightedEdges.clear();
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
		// 双击才触发节点响应（由宿主打开编辑器）
		this._onNodeClick.fire({ node: node.data });
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
