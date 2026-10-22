/**
 * 节点图的执行引擎（宿主侧）：按拓扑序跑图。
 */
import { normalizeGraph, topoOrder } from './canvasGraph.js';

/** 文本截断（标题用）。 */
function clip(value, max = 24) {
	const text = String(value ?? '').replace(/\s+/g, ' ').trim();
	return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 账本里的图 id ⇒ data URL（给"图生图"当参考图）。 */
async function imageDataUrl(state, imageId) {
	const item = state.canvasImages?.find?.(String(imageId ?? ''));
	if (!item) { return undefined; }
	const attachments = state.attachments;
	if (!attachments || typeof attachments.readImage !== 'function') { return undefined; }
	const raw = await attachments.readImage(item.attachment);
	const bytes = raw?.bytes ? raw.bytes : (raw?.data ? raw.data : raw);
	if (!bytes) { return undefined; }
	const mediaType = item.mediaType || 'image/png';
	return 'data:' + mediaType + ';base64,' + Buffer.from(bytes).toString('base64');
}

/**
 * 跑一张节点图。
 *
 * @param {object} state 宿主状态（generateImage / editImage / canvasImages / canvasGraph）
 * @param {object} [options]
 * @param {object} [options.graph] 要跑的图（不给就用宿主仓库里那张）
 * @param {string} [options.nodeId] 只跑这一个节点
 * @returns {Promise<{ok: boolean, results: object[], graph: object, revision: number, cycles: string[]}>}
 */
export async function runCanvasGraph(state, options = {}) {
	// ★ **跑哪张图：以宿主仓库那份为准**（真源在宿主）。
	//   页面传上来的 graph 只是**兜底**（宿主仓库还是空的才用）——
	//   否则会出现"Agent 刚改完图、页面还没拉到 ⇒ 跑的是旧图"（用户以为改了却没生效 ✗）。
	const stored = state.canvasGraph?.get?.();
	const useStored = stored && Array.isArray(stored.nodes) && stored.nodes.length > 0;
	const source = useStored ? stored : (options.graph || stored || { nodes: [], edges: [] });
	const stale = !useStored && options.graph && Array.isArray(options.graph.nodes) && options.graph.nodes.length > 0;
	const graph = normalizeGraph(source);
	const byId = new Map(graph.nodes.map(node => [node.id, node]));
	const upstreamOf = new Map();
	for (const edge of graph.edges) {
		if (!upstreamOf.has(edge.toNode)) { upstreamOf.set(edge.toNode, []); }
		upstreamOf.get(edge.toNode).push(edge.fromNode);
	}
	const { order, cycleNodes } = topoOrder(graph);
	const results = [];

	// 环里的节点：跑不了 ⇒ 如实标出来（不静默跳过）。
	for (const id of cycleNodes) {
		const node = byId.get(id);
		if (!node) { continue; }
		node.status = 'error';
		node.error = '依赖成环 ⇒ 跑不了（把其中一条连线断开）';
		results.push({
			nodeId: id,
			title: clip(node.label || node.prompt || node.text || id),
			ok: false,
			error: node.error,
		});
	}

	// 只跑图片节点（文本/参考素材节点不产图）。
	const only = String(options.nodeId ?? '').trim();
	const targets = order
		.map(id => byId.get(id))
		.filter(node => node && node.kind === 'image' && (!only || node.id === only));
	if (only && targets.length === 0) {
		return {
			ok: false,
			results: [{ nodeId: only, title: only, ok: false, error: '这个节点不存在、不是图片节点，或它在依赖环里' }],
			graph,
			revision: state.canvasGraph?.getRevision?.() ?? 0,
			cycles: cycleNodes,
			usedPageGraph: stale === true,
		};
	}

	for (const node of targets) {
		const title = clip(node.label || node.prompt || node.text || node.id);
		node.status = 'running';
		node.error = '';
		const upstream = (upstreamOf.get(node.id) || []).map(id => byId.get(id)).filter(Boolean);
		// ① 提示词：自己的优先；没有 ⇒ 从上游文本节点继承。
		let prompt = String(node.prompt || '').trim();
		let inheritedFrom = '';
		if (!prompt) {
			const textUp = upstream.find(item => item.kind === 'text' && String(item.text || '').trim());
			if (textUp) {
				prompt = String(textUp.text).trim();
				inheritedFrom = textUp.id;
			}
		}
		if (!prompt) { prompt = String(node.text || '').trim(); }
		if (!prompt) {
			node.status = 'error';
			node.error = '这个图片节点没有提示词（也没从上游文本节点继承到）';
			results.push({ nodeId: node.id, title, ok: false, error: node.error });
			continue;
		}
		// ② 参考图：上游的参考素材 / 已完成的图片节点产出图。
		let referenceId = '';
		for (const item of upstream) {
			if (item.kind === 'ref' && item.imageId) { referenceId = item.imageId; break; }
			if (item.kind === 'image' && item.status === 'done' && item.imageId) { referenceId = item.imageId; break; }
		}
		try {
			let imageId = '';
			let usedReference = '';
			if (referenceId) {
				const dataUrl = await imageDataUrl(state, referenceId);
				if (!dataUrl) {
					throw new Error('上游参考图 ' + referenceId + ' 读不出来（附件不在了？）');
				}
				const result = await state.editImage(state, {
					prompt,
					image: dataUrl,
					model: node.model,
					askedSave: true,
				});
				imageId = result?.images?.[0]?.id || '';
				usedReference = referenceId;
				if (result?.degraded === true) {
					node.error = '注意：这个图像服务不支持图生图 ⇒ 参考图没被采纳（已按文字重新生成）';
				}
			} else {
				const result = await state.generateImage(state, {
					prompt,
					model: node.model,
					provider: node.provider,
					size: node.size,
					quality: node.quality,
					numImages: 1,
					askedSave: true,
				});
				imageId = result?.images?.[0]?.id || '';
			}
			if (!imageId) { throw new Error('provider 没给出可用的图 id'); }
			node.status = 'done';
			node.imageId = imageId;
			results.push({
				nodeId: node.id,
				title,
				ok: true,
				imageId,
				inheritedFrom,
				usedReference,
				note: node.error,
			});
		} catch (e) {
			node.status = 'error';
			node.error = String(e?.message ?? e);
			results.push({ nodeId: node.id, title, ok: false, error: node.error });
		}
	}

	// 写回宿主仓库（真源在宿主 ⇒ 页面下一次拉就能看到状态与产出图）。
	const saved = state.canvasGraph?.set?.(graph);
	return {
		ok: results.every(item => item.ok),
		results,
		graph,
		revision: saved?.revision ?? state.canvasGraph?.getRevision?.() ?? 0,
		cycles: cycleNodes,
		// 宿主仓库原本是空的 ⇒ 这次跑的是页面传来的那份（要如实说，别装作跑的是"最新那张"）。
		usedPageGraph: stale === true,
	};
}
