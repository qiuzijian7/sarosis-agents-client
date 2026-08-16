/*---------------------------------------------------------------------------------------------
 *  Saros Agents — Mindmap Agent Tools
 *
 *  通过 Agent 工具暴露画布编辑能力：读取大纲、添加子节点、触发布局。
 *  走 builtinToolProvider 的 ctx.register() 模式注册。
 *  工具归属 toolset: "canvas"（新增，优先级 Low）。
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './builtinToolProvider.js';
import type { IMindmapData } from '../../../common/mindmap/mindmapTypes.js';
import { getActiveCanvasPane } from '../../canvasEditor/canvasEditorPane.js';
import { buildForest, getDirectChildNodes } from '../../../common/mindmap/treeModel.js';

export interface IMindmapToolContext {
	register(reg: IBuiltinToolRegistration): IDisposable;
	logService: ILogService;
}

/** 获取活跃画布的数据引用（只读视图） */
function getActiveCanvasData(): { data: IMindmapData; heading: string } | null {
	const pane = getActiveCanvasPane();
	if (!pane?.controller) { return null; }
	const data = pane.controller.data;
	const heading = data.mindmap ? '思维导图' : '画布';
	return { data, heading };
}

export function registerMindmapTools(ctx: IMindmapToolContext): void {
	const text = (s: string) => [{ type: 'text' as const, text: s }];

	// ── mindmap_read_outline ──────────────────────────────────────────

	ctx.register({
		definition: {
			name: 'mindmap_read_outline',
			description: [
				'Read the current mindmap/canvas as a tree outline.',
				'Returns root nodes with their direct child counts + full text.',
				'Use this to understand the canvas structure before editing.',
			].join(' '),
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			category: 'mindmap',
			source: 'saros.builtin-tools',
			toolset: 'canvas',
		},
		handler: async () => {
			const canvas = getActiveCanvasData();
			if (!canvas) { return text('(no canvas editor is open)'); }

			const forest = buildForest(canvas.data);
			if (forest.length === 0) { return text(`(empty ${canvas.heading})`); }

			const lines: string[] = [];
			lines.push(`=== ${canvas.heading} ===`);

			const render = (roots: typeof forest, indent: string): void => {
				for (const root of roots) {
					const label = root.node.text || root.node.content || '(empty)';
					const childCount = root.children.length;
					lines.push(`${indent}${label} [id:${root.node.id}]${childCount > 0 ? ` (${childCount} children)` : ''}`);
					if (root.children.length > 0) {
						render(root.children, indent + '  ');
					}
				}
			};

			render(forest, '');
			return text(lines.join('\n'));
		},
	});

	// ── mindmap_add_child ─────────────────────────────────────────────

	ctx.register({
		definition: {
			name: 'mindmap_add_child',
			description: [
				'Add a child node to a specified node in the active canvas/mindmap.',
				'The parent node id and child text are required.',
				'After adding, auto-trigger layout to prevent overlaps.',
				'Saves the canvas file automatically.',
			].join(' '),
			inputSchema: {
				type: 'object',
				properties: {
					parentNodeId: {
						type: 'string',
						description: 'ID of the parent node (from mindmap_read_outline output in [id:xxx] format)',
					},
					text: {
						type: 'string',
						description: 'Text content for the new child node',
					},
				},
				required: ['parentNodeId', 'text'],
				additionalProperties: false,
			},
			category: 'mindmap',
			source: 'saros.builtin-tools',
			toolset: 'canvas',
		},
		handler: async (args) => {
			const parentId = String(args['parentNodeId'] ?? '').trim();
			const childText = String(args['text'] ?? '').trim();
			if (!parentId || !childText) {
				return text('Error: parentNodeId and text are required');
			}

			const pane = getActiveCanvasPane();
			if (!pane?.controller) { return text('Error: no canvas editor is open'); }

			// Check parent exists
			const parentExists = pane.controller.data.nodes.find(n => n.id === parentId);
			if (!parentExists) {
				return text(`Error: node "${parentId}" not found in canvas`);
			}

			// Select parent and add child
			pane.controller.selectNode(parentId);
			pane.cmdAddChild();
			// The new child is created as empty; we need to set text
			// addChild focuses the new node — set its text
			const newChildId = getDirectChildNodes(parentId, pane.controller.data)
				.pop()?.id;

			if (newChildId) {
				const newNode = pane.controller.data.nodes.find(n => n.id === newChildId);
				if (newNode) {
					newNode.text = childText;
				}
			}

			// Trigger relayout + save
			pane.cmdRelayout();

			return text(newChildId
				? `Added child "${childText}" (id:${newChildId}) to parent ${parentId}`
				: `Added child "${childText}" under ${parentId}`);
		},
	});

	// ── mindmap_relayout ───────────────────────────────────────────────

	ctx.register({
		definition: {
			name: 'mindmap_relayout',
			description: [
				'Trigger automatic layout recalculation for the active mindmap/canvas.',
				'Use after adding or moving multiple nodes to fix overlapping.',
			].join(' '),
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			category: 'mindmap',
			source: 'saros.builtin-tools',
			toolset: 'canvas',
		},
		handler: async () => {
			const pane = getActiveCanvasPane();
			if (!pane?.controller) { return text('Error: no canvas editor is open'); }

			pane.cmdRelayout();
			return text('Layout recalculated successfully');
		},
	});

	// ── mindmap_list_nodes ─────────────────────────────────────────────

	ctx.register({
		definition: {
			name: 'mindmap_list_nodes',
			description: [
				'List all nodes in the active canvas as a flat table (id + text + parent).',
				'Use this to quickly find node IDs for editing.',
			].join(' '),
			inputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			category: 'mindmap',
			source: 'saros.builtin-tools',
			toolset: 'canvas',
		},
		handler: async () => {
			const canvas = getActiveCanvasData();
			if (!canvas) { return text('(no canvas editor is open)'); }

			const lines: string[] = [];
			lines.push(`=== ${canvas.heading} — ${canvas.data.nodes.length} nodes, ${canvas.data.edges.length} edges ===`);
			lines.push('');

			// Find parent for each node
			const parentMap = new Map<string, string>();
			for (const edge of canvas.data.edges) {
				parentMap.set(edge.toNode, edge.fromNode);
			}

			for (const node of canvas.data.nodes) {
				const parentId = parentMap.get(node.id) || '(root)';
				const label = node.text || node.content || '(empty)';
				lines.push(`${node.id} | ${label.slice(0, 50)} | parent: ${parentId}`);
			}

			return text(lines.join('\n'));
		},
	});
}
