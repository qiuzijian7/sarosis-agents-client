/*---------------------------------------------------------------------------------------------
 *  maxgraphFactory — 基于真实 @maxgraph/core 的 IMaxGraphLike 实现。
 *
 *  把 maxGraph 的 Graph 实例包装成渲染器需要的最小契约（IMaxGraphLike），
 *  使 maxGraphRenderer.ts 无需直接依赖 @maxgraph/core 的具体 API 形态，
 *  真实 Graph 与最小接口之间只在此文件耦合。
 *
 *  ⚠️ 当前选用 batteries-included 的 Graph（自动加载默认插件/样式），
 *  适合评估与原型；生产环境可后续切换到 BaseGraph 做 tree-shaking 优化。
 *--------------------------------------------------------------------------------------------*/

import { Graph, type Cell, type CellStyle, type FitPlugin } from '@maxgraph/core';
import type { IMaxGraphLike } from './maxGraphRenderer';
import type { IMindMapRenderNode } from './maxGraphRenderer.types';

/** 思维导图节点样式：圆角矩形 + 浅色填充，区分根/子节点。
 *
 *  注意：maxgraph 0.24 的 CellStyle 是**对象**而非 mxGraph 的 "k=v;k=v" 样式串
 *  （见 @maxgraph/core types.d.ts 的 `CellStyle = CellStateStyle & {...}`，
 *  Cell.style 的 @default 为 `{}`）。因此这里直接以对象字面量声明样式。 */
const NODE_STYLE_ROOT: CellStyle = {
	rounded: true,
	whiteSpace: 'wrap',
	fillColor: '#4F46E5',
	strokeColor: '#4338CA',
	fontColor: '#FFFFFF',
	fontStyle: 1,
};
const NODE_STYLE_CHILD: CellStyle = {
	rounded: true,
	whiteSpace: 'wrap',
	fillColor: '#EEF2FF',
	strokeColor: '#C7D2FE',
	fontColor: '#1E1B4B',
};

/**
 * 创建一个真实的 maxGraph 渲染实例，满足 IMaxGraphLike 契约。
 * 渲染器（MaxGraphMindMapRenderer）通过 MaxGraphFactory 拿到它，不直接 import @maxgraph/core。
 */
export function createMaxGraph(container: HTMLElement): IMaxGraphLike {
	const graph = new Graph(container);
	// 关闭默认的双击编辑/单元格编辑，思维导图是只读展示型画布。
	graph.setCellsEditable(false);
	graph.setPanning(true);
	graph.setCellsMovable(true);

	// id -> Cell 映射，供 addEdges 解析连线端点。
	const cellById = new Map<string, Cell>();

	return {
		clear(): void {
			cellById.clear();
			graph.batchUpdate(() => {
				const parent = graph.getDefaultParent();
				const children = parent.getChildCells(true, true);
				graph.removeCells(children);
			});
		},

		addNodes(nodes: IMindMapRenderNode[]): number {
			graph.batchUpdate(() => {
				const parent = graph.getDefaultParent();
				for (const node of nodes) {
					const cell = graph.insertVertex(
						parent,
						null,
						node.title,
						node.position.x,
						node.position.y,
						node.width,
						node.height,
						node.depth === 0 ? NODE_STYLE_ROOT : NODE_STYLE_CHILD,
					);
					cellById.set(node.id, cell);
				}
			});
			return nodes.length;
		},

		addEdges(edges: Array<{ id: string; source: string; target: string }>): number {
			graph.batchUpdate(() => {
				const parent = graph.getDefaultParent();
				for (const edge of edges) {
					const source = cellById.get(edge.source);
					const target = cellById.get(edge.target);
					if (!source || !target) {
						// eslint-disable-next-line no-console
						console.warn(`[maxgraphFactory] 跳过缺失端点的边 ${edge.id} (${edge.source} -> ${edge.target})`);
						continue;
					}
					graph.insertEdge({ parent, source, target, value: '' });
				}
			});
			return edges.length;
		},

		fitView(): void {
			// maxgraph 0.24 没有 graph.fit() 实例方法；视口适配由 FitPlugin 提供，
			// 需通过 graph.getPlugin<FitPlugin>('fit') 取得插件实例后调用 fit()（或 fitCenter()）。
			graph.getPlugin<FitPlugin>('fit')?.fit();
		},

		destroy(): void {
			cellById.clear();
			graph.destroy();
		},
	};
}
