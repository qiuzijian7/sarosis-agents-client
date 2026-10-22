/**
 * 节点式生图画布的**数据模型**（P0，2026-10-21）。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────────────
 * 画布从"自由绘制"扩到"节点工作流"后，同一份数据要同时满足三个需求：
 *   ① 页面要能渲染（节点 + 连线 + 参数面板）；
 *   ② 宿主（Agent 工具）要能读改它（加节点、连线、跑图）；
 *   ③ 要能**落盘成通用格式**（JSON Canvas 1.0 ⇒ Obsidian Canvas / dsh-noteboard 互通）。
 * 这三件事的公共部分就是"模型" ⇒ 抽到这里（页面与宿主共用一份实现，不抄第二遍 ✗）。
 *
 * ── 数据形状 ──────────────────────────────────────────────────────────────────
 * 节点（node）：
 *   { id, kind, x, y, width, height, label, text, prompt, model, provider, size,
 *     quality, imageId, status, error }
 *   `kind` 只有三种：**text（文本）/ image（图片）/ ref（参考素材）**。
 *   ⚠ 为什么只做三种：LibTV 那类节点画布的价值在"连线 = 数据依赖"，
 *   而节点种类一多，模型和用户都学不会（调研结论：先做 3 类，跑通再加）。
 * 连线（edge）：{ id, fromNode, fromSide, toNode, toSide } —— **刻意与 JSON Canvas 同形**
 *   ⇒ 导入导出是**字段直传**，不用做映射表（少一层漂移）。
 *
 * ── 乐观并发（revision）────────────────────────────────────────────────────────
 * 页面与宿主**都能改**这份数据 ⇒ 谁后写谁覆盖会丢东西。
 * 规矩：每次改动 `revision + 1`；推送时带上"我是基于哪个 revision 改的"（baseRevision）。
 *   · baseRevision 对得上 ⇒ 直接采纳（无冲突）。
 *   · 对不上 ⇒ 说明另一边也改过 ⇒ **合并**（按 id 取并集，同 id 以推送方为准），
 *     并把 `conflict` 标出来（要如实告诉用户"两边都改了，已合并"）。
 *   ⚠ 不用"最后写者赢"：那会让用户刚拖的节点凭空消失（用户会当成 bug ✗）。
 *
 * ── JSON Canvas 1.0 互通 ─────────────────────────────────────────────────────
 * 导出：{ nodes: [{id,x,y,width,height,type,text,url,color,ext}], edges: [{id,fromNode,...}] }
 * 导入：认 `ext.kind`（我们的私有字段 ⇒ 往返无损）；没有 `ext` 时按 `type` 猜
 *   （text → 文本；link/file → 参考素材）。
 */

export const GRAPH_KINDS = ['text', 'image', 'ref'];
/** 节点类型 → 中文名（模型与人看的摘要都用它）。 */
export const GRAPH_KIND_NAMES = { text: '文本', image: '图片', ref: '参考素材' };
/** 运行状态 → 中文名。 */
export const GRAPH_STATUS_NAMES = { idle: '待运行', running: '运行中', done: '已完成', error: '失败' };
/** 节点默认尺寸（按 kind）。 */
const DEFAULT_SIZE = { text: [240, 128], image: [240, 196], ref: [220, 178] };
/** 合法状态集合。 */
const STATUSES = ['idle', 'running', 'done', 'error'];

/** 空图。 */
export function emptyGraph() {
	return { nodes: [], edges: [] };
}

/** 数字兜底。 */
function num(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/** 字符串兜底。 */
function str(value) {
	return typeof value === 'string' ? value : '';
}

/**
 * 归一一个节点（宽容：任何脏数据都不该让整张图崩掉）。
 * @param {object} raw
 * @param {number} [index] 兜底 id 用
 */
export function normalizeNode(raw, index = 0) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const ext = source.ext && typeof source.ext === 'object' ? source.ext : {};
	let kind = str(source.kind).trim() || str(ext.kind).trim();
	if (!GRAPH_KINDS.includes(kind)) {
		// 没有私有 kind ⇒ 从 JSON Canvas 的 type 猜（导入路径）。
		const type = str(source.type).trim();
		if (type === 'text') { kind = 'text'; }
		else if (type === 'link' || type === 'file') { kind = 'ref'; }
		else { kind = 'text'; }
	}
	const size = DEFAULT_SIZE[kind];
	const status = STATUSES.includes(str(source.status)) ? str(source.status) : 'idle';
	return {
		id: str(source.id).trim() || ('n' + (index + 1)),
		kind,
		x: Math.round(num(source.x, 0)),
		y: Math.round(num(source.y, 0)),
		width: Math.max(80, Math.round(num(source.width, size[0]))),
		height: Math.max(48, Math.round(num(source.height, size[1]))),
		label: str(source.label).trim() || str(ext.label).trim(),
		text: str(source.text),
		prompt: str(source.prompt) || str(ext.prompt),
		model: str(source.model) || str(ext.model),
		provider: str(source.provider) || str(ext.provider),
		size: str(source.size) || str(ext.size),
		quality: str(source.quality) || str(ext.quality),
		imageId: str(source.imageId) || str(ext.imageId),
		status,
		error: str(source.error) || str(ext.error),
	};
}

/**
 * 归一一条连线。
 * @param {object} raw
 * @param {number} [index]
 */
export function normalizeEdge(raw, index = 0) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const fromNode = str(source.fromNode).trim() || str(source.from).trim();
	const toNode = str(source.toNode).trim() || str(source.to).trim();
	return {
		id: str(source.id).trim() || ('e' + (index + 1)),
		fromNode,
		toNode,
		fromSide: str(source.fromSide).trim() || 'right',
		toSide: str(source.toSide).trim() || 'left',
	};
}

/**
 * 归一整张图：去重 id、丢掉悬空连线。
 * @param {object} raw
 */
export function normalizeGraph(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
	const nodes = [];
	const ids = new Set();
	rawNodes.forEach((item, index) => {
		const node = normalizeNode(item, index);
		if (ids.has(node.id)) {
			// id 撞了 ⇒ 改名（否则后面的 map/查表全乱）。
			node.id = node.id + '-' + nodes.length;
		}
		ids.add(node.id);
		nodes.push(node);
	});
	const rawEdges = Array.isArray(source.edges) ? source.edges : [];
	const edges = [];
	const edgeIds = new Set();
	rawEdges.forEach((item, index) => {
		const edge = normalizeEdge(item, index);
		if (!edge.fromNode || !edge.toNode) { return; }
		// 自环（自己依赖自己）⇒ 丢掉（那必然是死循环，跑不出东西）。
		if (edge.fromNode === edge.toNode) { return; }
		if (!ids.has(edge.fromNode) || !ids.has(edge.toNode)) { return; }
		if (edgeIds.has(edge.id)) { return; }
		edgeIds.add(edge.id);
		edges.push(edge);
	});
	return { nodes, edges };
}

/**
 * 合并两张图（按 id 取并集；同 id 以 `incoming` 为准）。
 * ⚠ 用于"页面与宿主同时改了"的场景 ⇒ 不丢任何一边的改动。
 */
export function mergeGraph(base, incoming) {
	const a = normalizeGraph(base);
	const b = normalizeGraph(incoming);
	const byId = new Map();
	for (const node of a.nodes) { byId.set(node.id, node); }
	for (const node of b.nodes) { byId.set(node.id, node); }
	const edges = new Map();
	for (const edge of a.edges) { edges.set(edge.id, edge); }
	for (const edge of b.edges) { edges.set(edge.id, edge); }
	return normalizeGraph({ nodes: [...byId.values()], edges: [...edges.values()] });
}

/**
 * 拓扑序（Kahn）⇒ 跑图顺序。
 * @returns {{order: string[], cycleNodes: string[]}} `cycleNodes` 非空 = 图里有环（跑不了）
 */
export function topoOrder(graph) {
	const g = normalizeGraph(graph);
	const indegree = new Map();
	const outgoing = new Map();
	for (const node of g.nodes) {
		indegree.set(node.id, 0);
		outgoing.set(node.id, []);
	}
	for (const edge of g.edges) {
		if (!indegree.has(edge.toNode) || !indegree.has(edge.fromNode)) { continue; }
		indegree.set(edge.toNode, indegree.get(edge.toNode) + 1);
		outgoing.get(edge.fromNode).push(edge.toNode);
	}
	const queue = g.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
	const order = [];
	while (queue.length > 0) {
		const id = queue.shift();
		order.push(id);
		for (const next of outgoing.get(id) || []) {
			const left = indegree.get(next) - 1;
			indegree.set(next, left);
			if (left === 0) { queue.push(next); }
		}
	}
	const done = new Set(order);
	const cycleNodes = g.nodes.map(node => node.id).filter(id => !done.has(id));
	return { order, cycleNodes };
}

/**
 * 图 ⇒ JSON Canvas 1.0。
 * ⚠ `ext` 里放我们的私有字段（kind/prompt/model/…）⇒ 往返无损；
 *   没有 ext 的第三方文件也能读（按 type 猜 kind）。
 */
export function toJsonCanvas(graph) {
	const g = normalizeGraph(graph);
	return {
		nodes: g.nodes.map(node => {
			const out = {
				id: node.id,
				x: node.x,
				y: node.y,
				width: node.width,
				height: node.height,
				type: node.kind === 'text' ? 'text' : 'link',
				text: node.kind === 'text' ? node.text : (node.prompt || node.text || ''),
			};
			if (node.kind !== 'text') {
				out.url = node.imageId ? ('image:' + node.imageId) : '';
			}
			out.color = node.kind === 'image' ? '6' : (node.kind === 'ref' ? '4' : '1');
			out.ext = {
				kind: node.kind,
				// ★ `text` 也要存一份（**精确值**）：导出时 `text` 字段给的是"给人看的"
				//   （图片节点显示提示词）⇒ 不存原值就会在往返里被改写（丢字段 ✗）。
				text: node.text,
				label: node.label,
				prompt: node.prompt,
				model: node.model,
				provider: node.provider,
				size: node.size,
				quality: node.quality,
				imageId: node.imageId,
				status: node.status,
				error: node.error,
			};
			return out;
		}),
		edges: g.edges.map(edge => ({
			id: edge.id,
			fromNode: edge.fromNode,
			fromSide: edge.fromSide,
			toNode: edge.toNode,
			toSide: edge.toSide,
		})),
	};
}

/**
 * JSON Canvas 1.0 ⇒ 图。
 * @param {object} json
 */
export function fromJsonCanvas(json) {
	const source = json && typeof json === 'object' ? json : {};
	const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
	const nodes = rawNodes.map(item => {
		const node = item && typeof item === 'object' ? item : {};
		const ext = node.ext && typeof node.ext === 'object' ? node.ext : {};
		const kind = GRAPH_KINDS.includes(str(ext.kind)) ? str(ext.kind) : '';
		const out = Object.assign({}, node);
		if (kind) {
			out.kind = kind;
			// 有 ext.text ⇒ 用**精确值**（导出时的原文）；没有才按 type 猜。
			out.text = Object.prototype.hasOwnProperty.call(ext, 'text') ? str(ext.text) : str(node.text);
			// ⚠ 同理 ext.prompt：**空串也是精确值**（用 `||` 会被"猜"覆盖 ⇒ 往返丢字段 ✗）。
			out.prompt = Object.prototype.hasOwnProperty.call(ext, 'prompt')
				? str(ext.prompt)
				: (str(node.prompt) || (kind === 'text' ? '' : str(node.text)));
		} else {
			// 第三方文件：没有私有字段 ⇒ 按 type 猜，并尽量把 text 当提示词。
			out.kind = node.type === 'text' ? 'text' : 'ref';
			out.prompt = node.type === 'text' ? '' : str(node.text);
		}
		return out;
	});
	const rawEdges = Array.isArray(source.edges) ? source.edges : [];
	const edges = rawEdges.map(item => {
		const edge = item && typeof item === 'object' ? item : {};
		return {
			id: str(edge.id),
			fromNode: str(edge.fromNode),
			fromSide: str(edge.fromSide) || 'right',
			toNode: str(edge.toNode),
			toSide: str(edge.toSide) || 'left',
		};
	});
	return normalizeGraph({ nodes, edges });
}

/**
 * 加一个节点（宿主侧工具用）。
 * @param {object} graph
 * @param {object} node 节点草稿（至少给 kind）
 * @returns {{graph: object, node: object}} 新图 + 落定的节点
 */
export function addNode(graph, node) {
	const g = normalizeGraph(graph);
	const draft = node && typeof node === 'object' ? node : {};
	const id = str(draft.id).trim() || ('n' + (Date.now().toString(36)) + '-' + g.nodes.length);
	const existing = g.nodes.find(item => item.id === id);
	const created = normalizeNode(Object.assign({}, draft, { id }), g.nodes.length);
	const nodes = existing
		? g.nodes.map(item => (item.id === id ? created : item))
		: g.nodes.concat([created]);
	return { graph: { nodes, edges: g.edges }, node: created };
}

/**
 * 连两个节点（宿主侧工具用）。
 * ⚠ 已有同一条连线 ⇒ 不重复加（幂等）。
 */
export function linkNodes(graph, fromId, toId) {
	const g = normalizeGraph(graph);
	const from = str(fromId).trim();
	const to = str(toId).trim();
	if (!from || !to) {
		return { graph: g, edge: undefined, error: '连线要两个节点 id' };
	}
	if (from === to) {
		return { graph: g, edge: undefined, error: '不能自己连自己' };
	}
	if (!g.nodes.some(node => node.id === from) || !g.nodes.some(node => node.id === to)) {
		return { graph: g, edge: undefined, error: '连线两端必须都在图里（' + from + ' → ' + to + '）' };
	}
	const duplicated = g.edges.find(edge => edge.fromNode === from && edge.toNode === to);
	if (duplicated) {
		return { graph: g, edge: duplicated, duplicate: true };
	}
	const edge = normalizeEdge({
		id: 'e-' + from + '-' + to,
		fromNode: from,
		toNode: to,
		fromSide: 'right',
		toSide: 'left',
	}, g.edges.length);
	return { graph: { nodes: g.nodes, edges: g.edges.concat([edge]) }, edge };
}

/**
 * 删一个节点（连带删它身上的连线）。
 */
export function removeNode(graph, id) {
	const g = normalizeGraph(graph);
	const target = str(id).trim();
	if (!g.nodes.some(node => node.id === target)) {
		return { graph: g, removed: false };
	}
	return {
		graph: {
			nodes: g.nodes.filter(node => node.id !== target),
			edges: g.edges.filter(edge => edge.fromNode !== target && edge.toNode !== target),
		},
		removed: true,
	};
}

/**
 * 图 ⇒ 人话摘要（给 `canvas_state` 工具看）。
 * @param {object} graph
 * @param {object} [options]
 * @param {number} [options.limit] 最多列多少个节点
 */
export function graphDigest(graph, options = {}) {
	const limit = Number(options.limit) > 0 ? Number(options.limit) : 24;
	const g = normalizeGraph(graph);
	if (g.nodes.length === 0) {
		return ['节点工作流：空的（还没有节点）。'];
	}
	const lines = [];
	lines.push(`节点工作流：${g.nodes.length} 个节点、${g.edges.length} 条连线。`);
	const shown = g.nodes.slice(0, limit);
	shown.forEach((node, index) => {
		const kindName = GRAPH_KIND_NAMES[node.kind] || node.kind;
		const title = node.label || node.prompt || node.text || '';
		let line = `${index + 1}. ${kindName}`;
		if (title) {
			line += `「${String(title).replace(/\s+/g, ' ').slice(0, 40)}」`;
		}
		if (node.kind === 'image') {
			line += `（状态：${GRAPH_STATUS_NAMES[node.status] || node.status}`;
			if (node.imageId) { line += `，产出图 ${node.imageId}`; }
			if (node.error) { line += `，错误：${node.error}`; }
			line += '）';
		}
		if (node.model) { line += ` 模型=${node.model}`; }
		if (node.provider) { line += ` provider=${node.provider}`; }
		lines.push('  ' + line);
	});
	if (g.nodes.length > shown.length) {
		lines.push(`  …… 还有 ${g.nodes.length - shown.length} 个节点没列出来。`);
	}
	if (g.edges.length > 0) {
		const byId = new Map(g.nodes.map(node => [node.id, node]));
		const describe = id => {
			const node = byId.get(id);
			if (!node) { return id; }
			return String(node.label || node.prompt || node.text || node.id).replace(/\s+/g, ' ').slice(0, 20);
		};
		const parts = g.edges.slice(0, limit).map(edge => describe(edge.fromNode) + ' → ' + describe(edge.toNode));
		lines.push('连线：' + parts.join('、'));
		if (g.edges.length > limit) {
			lines.push(`  …… 还有 ${g.edges.length - limit} 条连线没列出来。`);
		}
	}
	const { cycleNodes } = topoOrder(g);
	if (cycleNodes.length > 0) {
		lines.push('⚠ 有环（跑不了）：' + cycleNodes.join('、'));
	}
	return lines;
}

/**
 * 图状态仓库（宿主侧唯一真源）：带乐观并发。
 *
 * - `apply`  = 外部（页面）推一版进来 ⇒ 带 baseRevision；不一致就**合并**。
 * - `set`    = 宿主自己改（Agent 工具）⇒ 直接替换。
 * - `reset`  = 清空。
 */
export function createGraphStore() {
	let graph = emptyGraph();
	let revision = 0;
	let conflict = false;
	return {
		/** 当前图。 */
		get() { return graph; },
		/** 当前版本号。 */
		getRevision() { return revision; },
		/** 上一次有没有发生过冲突合并。 */
		hasConflict() { return conflict; },
		/**
		 * 外部推一版进来（页面 ⇒ 宿主）。
		 * @param {object} next
		 * @param {object} [options]
		 * @param {number} [options.baseRevision] 推送方基于哪个版本改的
		 */
		apply(next, options = {}) {
			const incoming = normalizeGraph(next);
			const base = Number(options.baseRevision);
			const diverged = Number.isFinite(base) && base !== revision;
			if (diverged) {
				graph = mergeGraph(graph, incoming);
				conflict = true;
			} else {
				graph = incoming;
				conflict = false;
			}
			revision += 1;
			return { ok: true, revision, conflict, graph };
		},
		/** 宿主自己改（不走并发合并）。 */
		set(next) {
			graph = normalizeGraph(next);
			revision += 1;
			conflict = false;
			return { ok: true, revision, conflict: false, graph };
		},
		/** 清空。 */
		reset() {
			graph = emptyGraph();
			revision += 1;
			conflict = false;
			return { ok: true, revision, conflict: false, graph };
		},
		/** 诊断用。 */
		stats() {
			return { revision, nodes: graph.nodes.length, edges: graph.edges.length, conflict };
		},
	};
}
