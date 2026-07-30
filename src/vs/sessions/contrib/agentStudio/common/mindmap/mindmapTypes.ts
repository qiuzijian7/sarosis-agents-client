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
}

// ─── 分支方向 ────────────────────────────────────────────────────────────

export type BranchDirection = 'left' | 'right';

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
