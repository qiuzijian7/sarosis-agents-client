/*---------------------------------------------------------------------------------------------
 *  markdownImport — Markdown 标题树 → 思维导图数据。
 *
 *  与 markmap 能力互补：markmap 渲染「整篇文档」为静态脑图；本项目需要的是把
 *  Markdown 大纲导入为**可编辑**脑图节点（每个 # 标题 = 一个主题节点，正文首段
 *  作 note）。仅解析 #~###### 标题层级，不处理表格/代码块内的 #。
 *
 *  返回 MindMapNodeData[]（parentId 指向最近的上层标题）。
 *--------------------------------------------------------------------------------------------*/

import type { MindMapNodeData } from './radialLayout';

interface ParseState {
	/** 各层级最近一次出现的节点 id（栈）。 */
	lastAtLevel: Record<number, string | null>;
	nodes: MindMapNodeData[];
	counter: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** 解析 Markdown 文本为脑图节点列表。空输入返回空数组。 */
export function markdownToMindMap(md: string, rootTitle = '文档'): MindMapNodeData[] {
	const state: ParseState = { lastAtLevel: {}, nodes: [], counter: 0 };
	const lines = md.split(/\r?\n/);
	let inFence = false;
	let pendingNote: string | null = null;

	// 根节点（承载文档标题）
	const rootId = `mm-${++state.counter}`;
	state.nodes.push({ id: rootId, parentId: null, title: rootTitle });
	state.lastAtLevel[0] = rootId;

	for (const raw of lines) {
		const line = raw.trimEnd();
		if (/^```/.test(line)) { inFence = !inFence; continue; }
		if (inFence) { continue; }

		const m = HEADING_RE.exec(line);
		if (!m) {
			// 非标题行：作为「最近标题」的 note（仅取非空首段）
			if (line.trim() && pendingNote === null && state.nodes.length > 1) {
				const lastId = lastNonRoot(state);
				if (lastId) {
					const node = state.nodes.find(n => n.id === lastId);
					if (node && !node.note) { node.note = line.trim(); }
				}
			}
			continue;
		}

		const level = m[1].length;
		const title = m[2].trim();
		const id = `mm-${++state.counter}`;
		const parentLevel = findParentLevel(state, level);
		const parentId = parentLevel === 0 ? rootId : state.lastAtLevel[parentLevel];
		state.nodes.push({ id, parentId: parentId ?? rootId, title });
		state.lastAtLevel[level] = id;
		// 清空更深层级（它们不再是当前节点的父）
		for (let l = level + 1; l <= 6; l++) { state.lastAtLevel[l] = null; }
		pendingNote = null;
	}

	return state.nodes;
}

function lastNonRoot(state: ParseState): string | null {
	for (let i = state.nodes.length - 1; i >= 0; i--) {
		if (state.nodes[i].parentId !== null) { return state.nodes[i].id; }
	}
	return null;
}

/** 找最近的、层级比 level 小且已有节点的层。 */
function findParentLevel(state: ParseState, level: number): number {
	for (let l = level - 1; l >= 0; l--) {
		if (state.lastAtLevel[l] !== null && state.lastAtLevel[l] !== undefined) { return l; }
	}
	return 0;
}
