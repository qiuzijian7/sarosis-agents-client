/*---------------------------------------------------------------------------------------------
 *  maxGraphRenderer 类型定义（与 maxGraph 渲染器共用）。
 *
 *  这些类型只描述「渲染器对外契约」，不依赖 maxGraph / LiteGraph 实现。
 *  渲染器内部可把 IMindMapRenderNode 映射为 maxGraph 的 Node，把父子关系映射为 Edge。
 *--------------------------------------------------------------------------------------------*/

import type { MindMapNodeData } from './radialLayout';

/** 节点布局坐标（graph 单位）。与 common/mindmap/mindmapTypes 的 INodePosition 同形，
 * 此处本地定义以避免 webview rootDir 之外跨目录引用（TS6059）。 */
export interface INodePosition {
	x: number;
	y: number;
}

/** 单个待渲染节点（已带布局坐标）。 */
export interface IMindMapRenderNode {
	id: string;
	title: string;
	/** 节点中心/左上角坐标（graph 单位，来自布局引擎）。 */
	position: INodePosition;
	/** 是否为图片节点（内嵌图片缩略）。 */
	isImage: boolean;
	/** 图片 ref（data: / http(s): / 媒体库 key），仅 isImage 时有意义。 */
	imageRef?: string;
	/** 主题色（分支着色）。 */
	color?: string;
	/** 备注（富文本/纯文本）。 */
	note?: string;
	/** 节点框尺寸（graph 单位）。 */
	width: number;
	height: number;
	/** 节点深度（根=0）。用于区分根/子节点样式。布局引擎不返回，由这里从 parentId 链推导。 */
	depth: number;
}

/** 渲染器输入：扁平节点列表 + 父子边。坐标已就绪。 */
export interface IMindMapRenderModel {
	nodes: IMindMapRenderNode[];
	/** 边：parentId → childId（无环树）。 */
	edges: Array<{ id: string; source: string; target: string }>;
}

/** 从面板侧的 MindMapNodeData[] 构造渲染模型（坐标由调用方通过 positions 提供）。
 *  positions 来自 computeRadialLayout / computeLayout，统一为 Record 以兼容两种布局引擎。 */
export function toRenderModel(
	data: MindMapNodeData[],
	positions: Record<string, { x: number; y: number }>,
): IMindMapRenderModel {
	// 构建 id → 数据 索引，用于沿 parentId 链推导 depth。
	const byId = new Map<string, MindMapNodeData>();
	for (const d of data) { byId.set(d.id, d); }

	// 沿 parentId 向上计数得到节点深度（根 depth=0）。
	const computeDepth = (d: MindMapNodeData): number => {
		let depth = 0;
		let current = d.parentId ? byId.get(d.parentId) : undefined;
		while (current) {
			depth += 1;
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return depth;
	};

	const nodes: IMindMapRenderNode[] = data.map((d) => {
		const pos = positions[d.id];
		const isImage = (d.imageRefs?.length ?? 0) > 0;
		return {
			id: d.id,
			title: d.title,
			position: (pos ?? { x: 0, y: 0 }) as INodePosition,
			isImage,
			imageRef: d.imageRefs?.[0],
			color: undefined,
			note: d.note,
			width: isImage ? 220 : 200,
			height: isImage ? 120 : 56,
			depth: computeDepth(d),
		};
	});

	const edges = data
		.filter((d) => d.parentId)
		.map((d) => ({ id: `e-${d.parentId}-${d.id}`, source: d.parentId as string, target: d.id }));

	return { nodes, edges };
}
