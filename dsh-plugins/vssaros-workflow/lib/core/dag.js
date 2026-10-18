// @vssaros/dsh-workflow — DAG 图工具（纯函数，零 IO）。
//
// 移植自 legacy `workflowExecutionService.ts` 的图遍历片段（_getNextNodes / 邻接表 / 端口路由），
// 语义逐项对齐 ✓（对账探针 p3-103 钉住）。

/** 建邻接表：from → [{ targetId, fromPort }]。 */
export function buildAdjacency(connections) {
	const adj = new Map();
	for (const c of connections ?? []) {
		const from = String(c?.from ?? c?.source ?? '');
		const to = String(c?.to ?? c?.target ?? '');
		if (!from || !to) { continue; }
		const list = adj.get(from) ?? [];
		list.push({ targetId: to, fromPort: c.fromPort ?? c.sourcePort ?? undefined });
		adj.set(from, list);
	}
	return adj;
}

/** 后继节点（无条件全量）。 */
export function nextNodes(nodeId, adj) {
	return (adj.get(nodeId) ?? []).map(c => c.targetId);
}

/** AskUser 端口路由：只走选中项对应的 fromPort 边；没有匹配边 ⇒ 回退全量（旧图兼容 ✓）。 */
export function askUserNextNodes(nodeId, adj, selectedIndices) {
	const connections = adj.get(nodeId) ?? [];
	const ports = new Set(selectedIndices.map(i => `option-${i}`));
	const matched = connections.filter(c => c.fromPort && ports.has(c.fromPort));
	if (matched.length === 0) { return nextNodes(nodeId, adj); }
	return matched.map(c => c.targetId);
}

/** 拓扑执行顺序（Kahn；环 ⇒ 报错，不静默乱序 ✗）。 */
export function topoOrder(nodes, connections) {
	const ids = nodes.map(n => String(n.id));
	const indegree = new Map(ids.map(id => [id, 0]));
	const adj = buildAdjacency(connections);
	for (const [, list] of adj) {
		for (const c of list) {
			indegree.set(c.targetId, (indegree.get(c.targetId) ?? 0) + 1);
		}
	}
	const queue = ids.filter(id => (indegree.get(id) ?? 0) === 0);
	const order = [];
	while (queue.length > 0) {
		const id = queue.shift();
		order.push(id);
		for (const c of adj.get(id) ?? []) {
			const d = (indegree.get(c.targetId) ?? 0) - 1;
			indegree.set(c.targetId, d);
			if (d === 0) { queue.push(c.targetId); }
		}
	}
	if (order.length !== ids.length) {
		const stuck = ids.filter(id => !order.includes(id));
		throw new Error(`工作流图有环（拓扑排序走不完）：卡住 ${stuck.join(', ')}`);
	}
	return order;
}
