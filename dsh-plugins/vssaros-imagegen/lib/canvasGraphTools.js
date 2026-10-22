/**
 * 节点图的 Agent 工具：canvas_add_node / canvas_link / canvas_run。
 *
 * 节点图的真源在宿主（state.canvasGraph）⇒ 不画布页开着也能建图、连线、跑图；
 * 画布页开着时会把改动拉下来显示（两边是同一份数据）。
 *
 * 三件套：canvas_state 看图 → canvas_add_node 加节点 → canvas_link 连线 → canvas_run 跑图。
 * 工具名可能撞车 ⇒ 注册前预检，被占就降级成 vssaros_ 前缀（见 lib/index.js）。
 */
import { GRAPH_KIND_NAMES, GRAPH_KINDS, addNode, linkNodes } from './canvasGraph.js';

export const CANVAS_ADD_NODE_TOOL = 'canvas_add_node';
export const CANVAS_LINK_TOOL = 'canvas_link';
export const CANVAS_RUN_TOOL = 'canvas_run';

/** 节点类型 → 中文名。 */
const KIND_NAMES = GRAPH_KIND_NAMES;

/** 摘要一段（人话）。 */
function graphBrief(graph) {
	return '当前图：' + graph.nodes.length + ' 个节点、' + graph.edges.length + ' 条连线。';
}

/** 节点标题（人话）。 */
function nodeTitle(node) {
	const text = String(node.label || node.prompt || node.text || '').replace(/\s+/g, ' ').trim();
	return text ? text.slice(0, 40) : node.id;
}

/** canvas_add_node：加一个节点。 */
function addNodeTool(state) {
	return {
		name: CANVAS_ADD_NODE_TOOL,
		description: [
			'在画布工作台的节点工作流图里加一个节点（画布页开着的话会立刻看到）。',
			'节点类型 kind：text（文本/提示词）、image（要生成的那张图）、ref（参考素材）。',
			'★ 连线才有依赖关系：text 节点的文字会被下游图片节点当提示词继承；',
			'  ref 节点的参考图会被下游图片节点当图生图的参考图。',
			'参数：kind（必填）、text（内容；image 节点可写成 prompt）、prompt（image 节点专用）、',
			'label（名字）、model / provider / size / quality（图像节点参数）、image_id（ref 节点的参考图 id）。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: GRAPH_KINDS, description: '节点类型：text / image / ref' },
				text: { type: 'string', description: '节点内容（text 节点=文字；image 节点=提示词）' },
				prompt: { type: 'string', description: 'image 节点专用：生图提示词' },
				label: { type: 'string', description: '节点名字（画布上显示）' },
				model: { type: 'string', description: '图像模型 id（image 节点）' },
				provider: { type: 'string', description: '图像 provider id（image 节点）' },
				size: { type: 'string', description: '输出尺寸，如 1024x1024（image 节点）' },
				quality: { type: 'string', description: '生成质量档（image 节点）' },
				image_id: { type: 'string', description: 'ref 节点的参考图 id（之前出图的 id）' },
			},
			required: ['kind'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					text: { type: 'string' },
					nodeId: { type: 'string' },
					nodes: { type: 'integer' },
					edges: { type: 'integer' },
				},
				required: ['ok', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
		},
		execute: async (params) => {
			const store = state.canvasGraph;
			if (!store) { throw new Error('节点图仓库没装好（宿主侧 canvasGraph 缺失）'); }
			const kind = String(params?.kind ?? '').trim();
			if (!GRAPH_KINDS.includes(kind)) {
				throw new Error('kind 只认 text / image / ref（收到：' + (kind || '空') + '）');
			}
			const current = store.get();
			const text = String(params?.text ?? '').trim();
			const prompt = String(params?.prompt ?? (kind === 'image' ? text : '')).trim();
			// 没给坐标 ⇒ 错开摆（否则全叠在一起，看不出是一堆节点）。
			const offset = current.nodes.length * 36;
			const { graph, node } = addNode(current, {
				kind,
				label: params?.label,
				text: kind === 'image' ? '' : text,
				prompt,
				model: params?.model,
				provider: params?.provider,
				size: params?.size,
				quality: params?.quality,
				imageId: params?.image_id,
				x: params?.x,
				y: params?.y ?? offset,
			});
			const result = store.set(graph);
			return {
				ok: true,
				text: '已加节点 ' + node.id + '（' + (KIND_NAMES[kind] || kind) + '）：' + nodeTitle(node)
					+ '。' + graphBrief(result.graph),
				nodeId: node.id,
				nodes: result.graph.nodes.length,
				edges: result.graph.edges.length,
			};
		},
	};
}

/** canvas_link：连两个节点（连线 = 数据依赖）。 */
function linkTool(state) {
	return {
		name: CANVAS_LINK_TOOL,
		description: [
			'在节点工作流图里连一条线（from → to）：**连线就是数据依赖**。',
			'下游图片节点会继承上游 text 节点的文字当提示词，并拿上游 ref / 已完成 image 节点的产出图当参考图。',
			'参数：from（上游节点 id）、to（下游节点 id）。节点 id 用 canvas_state 或 canvas_add_node 的回执。',
			'★ 重复连同一条线不会报错（幂等），但会告诉你"已经连过了"。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				from: { type: 'string', description: '上游节点 id' },
				to: { type: 'string', description: '下游节点 id' },
			},
			required: ['from', 'to'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					text: { type: 'string' },
					nodes: { type: 'integer' },
					edges: { type: 'integer' },
				},
				required: ['ok', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
		},
		execute: async (params) => {
			const store = state.canvasGraph;
			if (!store) { throw new Error('节点图仓库没装好（宿主侧 canvasGraph 缺失）'); }
			const from = String(params?.from ?? '').trim();
			const to = String(params?.to ?? '').trim();
			if (!from || !to) { throw new Error('from 与 to 都要给（节点 id）'); }
			const outcome = linkNodes(store.get(), from, to);
			if (outcome.error) { throw new Error(outcome.error); }
			if (outcome.duplicate) {
				return { ok: true, text: '这两个节点已经连过了（没重复加）。' + graphBrief(store.get()) };
			}
			const result = store.set(outcome.graph);
			return {
				ok: true,
				text: '已连线：' + from + ' → ' + to + '。' + graphBrief(result.graph),
				nodes: result.graph.nodes.length,
				edges: result.graph.edges.length,
			};
		},
	};
}

/** canvas_run：按拓扑序跑图。 */
function runTool(state) {
	return {
		name: CANVAS_RUN_TOOL,
		description: [
			'跑这张节点工作流图：按**拓扑序**执行（上游先跑），产出图回到节点上。',
			'text 节点的文字会被下游图片节点当提示词继承；上游 ref / 已完成 image 节点的产出图会当参考图（图生图）。',
			'参数：node_id（可选，只跑这一个节点；不给就整张图跑）。',
			'★ 单个节点失败不会中断其余（失败原因会逐条返回）。',
			'★ 会调用图像模型（可能产生费用）⇒ 需要用户批准。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				node_id: { type: 'string', description: '只跑这一个节点（可选；不给就整张图跑）' },
			},
			required: [],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					text: { type: 'string' },
					results: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								nodeId: { type: 'string' },
								title: { type: 'string' },
								ok: { type: 'boolean' },
								imageId: { type: 'string' },
								error: { type: 'string' },
							},
						},
					},
				},
				required: ['ok', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
		},
		execute: async (params) => {
			if (typeof state.runCanvasGraph !== 'function') {
				throw new Error('执行引擎没装好（宿主侧 runCanvasGraph 缺失）');
			}
			const outcome = await state.runCanvasGraph(state, { nodeId: params?.node_id });
			const results = Array.isArray(outcome?.results) ? outcome.results : [];
			const lines = results.map(item => (item.ok
				? '✓ ' + item.title + '（图 id：' + (item.imageId || '无') + '）'
				: '✗ ' + item.title + '：' + String(item.error || '失败')));
			const okCount = results.filter(item => item.ok).length;
			const text = '跑图结束：成功 ' + okCount + ' / 共 ' + results.length + ' 个节点。'
				+ (lines.length > 0 ? '\n' + lines.join('\n') : '');
			return { ok: outcome?.ok !== false, text, results };
		},
	};
}

/**
 * 节点图工具定义。
 * @param {object} state 宿主侧状态（`state.canvasGraph` = 节点图仓库）
 */
export function canvasGraphToolDefinitions(state) {
	return [addNodeTool(state), linkTool(state), runTool(state)];
}
