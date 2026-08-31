/*---------------------------------------------------------------------------------------------
 *  maxGraphRenderer — 思维导图画布的 maxGraph 渲染骨架。
 *
 *  目标：把脑图渲染从 LiteGraph 切到 maxGraph，同时完全不触碰 workflowEditor 的
 *  LiteGraph 链路（MindMapNode.ts / ComfyGraphAdapter / widgetBridge 保持不变）。
 *
 *  设计：
 *    - 本文件对外只暴露 MaxGraphMindMapRenderer 类，消费 IMindMapRenderModel
 *      （见 ./maxGraphRenderer.types.ts），与布局引擎（layoutEngine.computeLayout /
 *      computeRadialLayout）解耦。
 *    - 为避免当前未安装 maxgraph 时污染主工程的 TS 编译，这里不直接 import 'maxgraph'，
 *      而是面向一个最小接口 IMaxGraphLike（仅声明我们要用到的 API 表面），通过注入的
 *      factory 创建真实实例。maxgraph 安装后，把 factory 实现替换为 new Graph(...) 即可，
 *      其余逻辑无需改动。
 *
 *  ⚠️ 待办（选项 B 的后续步骤）：
 *    1. 在 agent-studio-webview/package.json 加入 "maxgraph": "^0.x" 并执行 npm i。
 *    2. 用真实 maxGraph Graph/Node/Edge API 替换 IMaxGraphLike 注入实现与 drawNode/drawEdge。
 *    3. 接入 Canvas 交互（拖拽节点、缩放、连线）——当前仅做静态渲染。
 *--------------------------------------------------------------------------------------------*/

import type { IMindMapRenderModel, IMindMapRenderNode } from './maxGraphRenderer.types';

/**
 * 渲染器用到的 maxGraph 最小 API 表面。
 * 真实 maxgraph 的 Graph 实例需满足此契约；当前用空实现占位，安装依赖后替换。
 */
export interface IMaxGraphLike {
	/** 清空画布（删除所有 cell）。 */
	clear(): void;
	/** 批量添加节点（返回数量，纯用于断言/日志）。 */
	addNodes(nodes: IMindMapRenderNode[]): number;
	/** 批量添加边。 */
	addEdges(edges: Array<{ id: string; source: string; target: string }>): number;
	/** 把视口平移/缩放到全部内容可见。 */
	fitView(): void;
	/** 销毁实例、解绑 DOM 事件。 */
	destroy(): void;
}

/** 创建真实 maxGraph 实例的工厂（依赖注入点）。 */
export type MaxGraphFactory = (container: HTMLElement) => IMaxGraphLike;

/** 默认空实现工厂——在未安装 maxgraph 时让工程可编译/可跑（不渲染任何内容，仅留日志）。 */
const noopFactory: MaxGraphFactory = (container) => {
	// 占位：真实实现应在此 new Graph(container) 后 addNodes/addEdges。
	container.dataset.maxgraphState = 'noop';
	// eslint-disable-next-line no-console
	console.warn('[maxGraphRenderer] maxgraph 未安装，使用 noop 渲染器（不绘制任何内容）。');
	return {
		clear: () => {},
		addNodes: (ns) => ns.length,
		addEdges: (es) => es.length,
		fitView: () => {},
		destroy: () => { delete container.dataset.maxgraphState; },
	};
};

export interface MaxGraphRendererOptions {
	/** 注入真实 maxGraph 工厂；缺省使用 noopFactory（保证未安装依赖时可编译运行）。 */
	factory?: MaxGraphFactory;
}

export class MaxGraphMindMapRenderer {
	private graph: IMaxGraphLike | null = null;
	private readonly factory: MaxGraphFactory;
	private readonly container: HTMLElement;
	private currentModel: IMindMapRenderModel | null = null;

	constructor(container: HTMLElement, options: MaxGraphRendererOptions = {}) {
		this.container = container;
		this.factory = options.factory ?? noopFactory;
		this.graph = this.factory(container);
	}

	/**
	 * 用新的渲染模型刷新画布。坐标已由布局引擎算好（caller 负责调用
	 * computeLayout / computeRadialLayout 并提供 positions）。
	 */
	render(model: IMindMapRenderModel): void {
		this.currentModel = model;
		if (!this.graph) { return; }
		this.graph.clear();
		this.graph.addNodes(model.nodes);
		this.graph.addEdges(model.edges);
		this.graph.fitView();
	}

	/** 返回当前模型（供调试/后续交互使用）。 */
	getModel(): IMindMapRenderModel | null {
		return this.currentModel;
	}

	/** 销毁渲染器，释放 maxGraph 实例与 DOM 绑定。 */
	dispose(): void {
		this.graph?.destroy();
		this.graph = null;
		this.currentModel = null;
	}
}
