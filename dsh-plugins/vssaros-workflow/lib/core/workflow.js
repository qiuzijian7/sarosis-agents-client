// @vssaros/dsh-workflow — core（纯业务逻辑，零 I/O、零 dsh 依赖）。
//
// 契约真源 = `src/vs/sessions/contrib/agentStudio/common/workflowStorage.ts` 的 `IStoredWorkflow` +
// **本机真实文件**（`~/.vssaros/workflows/wf-dynamic-emoji/workflow.json`，6 节点 7 边）：
//
//   { id, name, description, steps: [], isActive, createdAt, updatedAt,
//     presetId: 'workflow-agent', agentId?, workspaceId,
//     nodes: [{ id, type, name, position: {x,y}, data, style }],
//     connections: [{ id, from, to, fromPort, toPort }],
//     breakpoints?: string[], version, category, author, visibility, tags }
//
// **双模态**（真源注释明说）：`steps` 是线性步骤（向后兼容、执行器用），`nodes`+`connections` 是节点图
// （ReactFlow 编辑器用）；为空时 fallback 到 steps。本模块 v0 只读，两种都认。
//
// 画布：v0 **不用** React 19 webview（方案 6.11.5 ③ 把"能否复用"列为待定项），改为**服务端渲染 SVG**：
// 纯函数、可被探针直接断言、零前端依赖。position 已被真机数据证实存在。

/** 未知/非法输入一律返回带原因的 error，不猜结构。 */
export function parseWorkflow(text, { id, workspaceId } = {}) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { error: `不是合法 JSON：${String(e?.message ?? e)}` };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { error: `顶层不是对象：${Array.isArray(raw) ? 'array' : typeof raw}` };
	}
	if (typeof raw.id !== 'string' || !raw.id) {
		return { error: `缺 id（工作流的身份靠它）` };
	}
	const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(isNode).map(node => ({
		id: String(node.id),
		type: typeof node.type === 'string' ? node.type : undefined,
		name: typeof node.name === 'string' && node.name ? node.name : String(node.id),
		x: finite(node.position?.x),
		y: finite(node.position?.y),
	})) : [];
	const edges = Array.isArray(raw.connections) ? raw.connections.filter(isEdge).map(edge => ({
		id: typeof edge.id === 'string' ? edge.id : `${edge.from}->${edge.to}`,
		from: String(edge.from),
		to: String(edge.to),
		fromPort: typeof edge.fromPort === 'string' ? edge.fromPort : undefined,
		toPort: typeof edge.toPort === 'string' ? edge.toPort : undefined,
	})) : [];
	return {
		workflow: {
			id: raw.id,
			name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
			description: typeof raw.description === 'string' ? raw.description : undefined,
			// 声明了 nodes 但不是数组 → 如实标出（不静默当空图）
			nodesShapeWrong: raw.nodes !== undefined && !Array.isArray(raw.nodes),
			edgesShapeWrong: raw.connections !== undefined && !Array.isArray(raw.connections),
			steps: Array.isArray(raw.steps) ? raw.steps.length : (raw.steps === undefined ? 0 : -1),
			isActive: raw.isActive === true,
			createdAt: finite(raw.createdAt),
			updatedAt: finite(raw.updatedAt),
			presetId: typeof raw.presetId === 'string' ? raw.presetId : undefined,
			agentId: typeof raw.agentId === 'string' ? raw.agentId : undefined,
			workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : workspaceId,
			version: typeof raw.version === 'string' ? raw.version : undefined,
			category: typeof raw.category === 'string' ? raw.category : undefined,
			author: typeof raw.author === 'string' ? raw.author : undefined,
			visibility: raw.visibility === 'public' || raw.visibility === 'private' ? raw.visibility : undefined,
			tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string') : [],
			breakpoints: Array.isArray(raw.breakpoints) ? raw.breakpoints.filter(b => typeof b === 'string') : [],
			nodes,
			edges,
			/** 节点图与线性步骤都空 ⇒ 空壳工作流 */
			empty: nodes.length === 0 && (!Array.isArray(raw.steps) || raw.steps.length === 0),
			source: 'file',
			...(id ? { fileId: id } : {}),
		},
	};
}

function isNode(node) {
	return !!node && typeof node === 'object' && (typeof node.id === 'string' || typeof node.id === 'number');
}

function isEdge(edge) {
	return !!edge && typeof edge === 'object' && edge.from !== undefined && edge.to !== undefined;
}

function finite(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 汇总（只算已知量；`steps: -1` 表示 steps 字段形态不对，如实标出）。 */
export function summarizeWorkflows(workflows) {
	const sorted = [...workflows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
	const byType = new Map();
	for (const workflow of sorted) {
		for (const node of workflow.nodes) {
			const key = node.type ?? '(未声明 type)';
			byType.set(key, (byType.get(key) ?? 0) + 1);
		}
	}
	return {
		count: sorted.length,
		active: sorted.filter(workflow => workflow.isActive).length,
		withGraph: sorted.filter(workflow => workflow.nodes.length > 0).length,
		nodes: [...byType.values()].reduce((sum, n) => sum + n, 0),
		nodeTypes: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
		sorted,
	};
}

/**
 * **孤立节点**计数：没有被**任何一条已知边**碰到的节点（两端的 from / to 都算 ✓）。
 *
 * 为什么值得单列一个纯函数：页面上那个「待整理」筛选（A 稿）就是「空壳 **或** 有孤立节点」——
 * 它是**读出来的事实**（`workflow_get` 早就在算"边指向图外"那一半 ✓，这是另一半 ✓），不是猜的。
 * 真实用例就在本机：`wf-test1` 3 节点 / 1 边（start→end），`Saros.ModelImageGen` 谁都没连。
 *
 * ⚠ 指向**图外**节点的边（如 `m1 → ghost`）只证明 m1 有连线 ✓，不会凭空造出一个节点 ✓。
 * 空图返回 0（没有节点就说不上"孤立"✓），坏输入返回 0 —— 这是计数，不该抛 ✗。
 */
export function countIsolatedNodes(workflow) {
	const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
	if (!nodes.length) {
		return 0;
	}
	const touched = new Set();
	for (const edge of Array.isArray(workflow?.edges) ? workflow.edges : []) {
		touched.add(String(edge?.from));
		touched.add(String(edge?.to));
	}
	return nodes.filter(node => !touched.has(String(node?.id))).length;
}

const NODE_W = 168;
const NODE_H = 48;
/** 节点没给 position 时的兜底排布（按数组顺序排一行）。 */
const FALLBACK_GAP_X = 200;
const FALLBACK_GAP_Y = 90;

/**
 * 服务端 SVG 画布（v0）。
 * - 只画**已知**的边（两端节点都在图中的才算）；
 * - 节点缺 position 时按索引排布（不假装知道布局引擎的算法）；
 * - 纯函数：同输入同输出（护 KV cache 的同一条道理）。
 */
export function renderSvgCanvas(workflow, { padding = 24 } = {}) {
	const nodes = workflow.nodes.map((node, index) => ({
		...node,
		x: node.x ?? index * FALLBACK_GAP_X,
		y: node.y ?? (index % 2) * FALLBACK_GAP_Y,
	}));
	if (!nodes.length) {
		return { svg: '', width: 0, height: 0 };
	}
	const minX = Math.min(...nodes.map(n => n.x));
	const minY = Math.min(...nodes.map(n => n.y));
	const maxX = Math.max(...nodes.map(n => n.x + NODE_W));
	const maxY = Math.max(...nodes.map(n => n.y + NODE_H));
	const width = maxX - minX + padding * 2;
	const height = maxY - minY + padding * 2;
	const place = node => ({ x: node.x - minX + padding, y: node.y - minY + padding });
	const byId = new Map(nodes.map(node => [node.id, place(node)]));
	const known = nodes.filter(node => byId.has(node.id));
	const escaped = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

	const lines = workflow.edges.map(edge => {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (!from || !to) {
			return '';
		}
		const x1 = from.x + NODE_W / 2;
		const y1 = from.y + NODE_H;
		const x2 = to.x + NODE_W / 2;
		const y2 = to.y;
		// 三次贝塞尔：垂直方向留出弧线，避免与节点框重叠
		return `<path d="M ${x1} ${y1} C ${x1} ${y1 + 28}, ${x2} ${y2 - 28}, ${x2} ${y2}" class="edge" marker-end="url(#arrow)"/>`;
	}).join('');
	const boxes = known.map(node => {
		const at = byId.get(node.id);
		return `<g class="node"><rect x="${at.x}" y="${at.y}" width="${NODE_W}" height="${NODE_H}" rx="6"/>`
			+ `<text x="${at.x + 10}" y="${at.y + 20}" class="title">${escaped(node.name.slice(0, 18))}</text>`
			+ `<text x="${at.x + 10}" y="${at.y + 36}" class="type">${escaped((node.type ?? '未声明 type').slice(0, 22))}</text></g>`;
	}).join('');
	const dangling = workflow.edges.filter(edge => !byId.has(edge.from) || !byId.has(edge.to)).length;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`
		+ '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="arrowHead"/></marker></defs>'
		+ `${lines}${boxes}</svg>`;
	return { svg, width, height, dangling };
}
