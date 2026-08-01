/*---------------------------------------------------------------------------------------------
 *  Sarosis Agents — Mindmap Data Model
 *
 *  JSON Canvas 格式的数据模型，与 kbMindmapGenerator 产物兼容。
 *  对齐 JSON Canvas spec 1.0（text/file/link/group 节点类型）。
 *--------------------------------------------------------------------------------------------*/

// ─── 节点 ────────────────────────────────────────────────────────────────

export interface IMindmapNode {
	id: string;
	type: 'text' | 'file' | 'link' | 'group';
	x: number;
	y: number;
	width: number;
	height: number;
	/** 节点内文本（JSON Canvas spec 主字段） */
	text: string;
	/** 兼容 kbMindmapGenerator 旧字段 */
	content?: string;
	color?: string;
	/**
	 * 该节点子树是否展开（思维导图折叠/展开）。
	 * 默认 undefined 视为展开；false 表示折叠其后代（节点本身仍可见，后代隐藏且不参与布局/渲染）。
	 */
	expanded?: boolean;
	/**
	 * 源码出处（Ctrl+点击节点跳转到 file:line）。
	 * 由 kbMindmapGenerator 在生成节点时填充（来自 KB 条目的源文件/行），
	 * 用于从思维导图回溯到源码。
	 */
	source?: { file: string; line?: number; column?: number };
}

/** 获取节点文本，兼容 text 和 content 两种字段名 */
export function getNodeText(node: IMindmapNode): string {
	return node.text || node.content || '';
}

/** 设置节点文本 */
export function setNodeText(node: IMindmapNode, text: string): void {
	node.text = text;
}

// ─── 边 ──────────────────────────────────────────────────────────────────

export interface IMindmapEdge {
	id: string;
	fromNode: string;
	fromSide: 'top' | 'right' | 'bottom' | 'left';
	toNode: string;
	toSide: 'top' | 'right' | 'bottom' | 'left';
	fromEnd?: 'none' | 'arrow';
	toEnd?: 'none' | 'arrow';
	color?: string;
	label?: string;
}

// ─── Canvas 数据 ─────────────────────────────────────────────────────────

export interface IMindmapData {
	nodes: IMindmapNode[];
	edges: IMindmapEdge[];
	mindmap?: boolean;
	/**
	 * 思维导图布局方向模式：
	 * - 'right'：所有分支向右侧展开
	 * - 'left'：所有分支向左侧展开
	 * - 'both'：左右平衡（经典思维导图，每一层左右交替）
	 * - 'tree'：自上而下树状（逻辑树 / 组织架构图）
	 * - 'flower'：中心发散（经典放射状 / 花瓣）
	 * 默认 undefined 视为 'both'，但兼容旧数据——未显式设置时按现有 x 坐标推断左右。
	 */
	direction?: MindmapDirection;
}

// ─── 分支方向 ────────────────────────────────────────────────────────────

export type BranchDirection = 'left' | 'right';

/** 全局布局方向模式（见 IMindmapData.direction） */
export type MindmapDirection = 'right' | 'left' | 'both' | 'tree' | 'flower';

// ─── 位置 ────────────────────────────────────────────────────────────────

export interface INodePosition {
	x: number;
	y: number;
}

// ─── 布局配置 ────────────────────────────────────────────────────────────

export interface ILayoutConfig {
	horizontalGap: number;
	verticalGap: number;
	nodeWidth: number;
	nodeHeight: number;
}

export const DEFAULT_LAYOUT_CONFIG: ILayoutConfig = {
	horizontalGap: 80,
	verticalGap: 20,
	nodeWidth: 300,
	nodeHeight: 60,
};

// ─── 节点操作配置 ────────────────────────────────────────────────────────

export interface INodeOpsConfig {
	nodeWidth: number;
	nodeHeight: number;
	horizontalGap: number;
	verticalGap: number;
}

// ─── 辅助类型 ────────────────────────────────────────────────────────────

/** 垂直范围（layout contour 用） */
export interface IDepthExtent {
	top: number;
	bottom: number;
}
