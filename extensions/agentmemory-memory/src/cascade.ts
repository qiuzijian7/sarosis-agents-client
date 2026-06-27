/*---------------------------------------------------------------------------------------------
 *  级联标记 — 当记忆被取代时，联动标记关联的图节点/边/兄弟记忆为 stale。
 *  参考 agentmemory src/functions/cascade.ts
 *
 *  核心场景：
 *    1. 用户写入了新版本的 API 文档 → 旧文档被 superseded
 *    2. 旧文档关联的图节点（函数/类/接口）应标记为 stale
 *    3. 引用旧文档的兄弟记忆也应标记为可能过时
 *
 *  依赖：需要访问 KnowledgeGraph 和 long-term 记忆条目
 *--------------------------------------------------------------------------------------------*/

import type { KnowledgeGraph } from './knowledgeGraph.js';

export interface CascadeResult {
	flaggedNodes: number;
	flaggedEdges: number;
	flaggedMemories: number;
	total: number;
}

export interface CascadeEntry {
	id: string;
	content: string;
	concepts: string[];
	sourceObservationIds?: string[];
	supersededBy?: string;
	metadata?: Record<string, unknown>;
}

export interface CascadeGraphNode {
	id: string;
	type: string;
	name: string;
	sourceObservationIds?: string[];
	stale?: boolean;
}

export class CascadeManager {
	/**
	 * 当一条记忆被取代时，级联标记关联资源为 stale
	 *
	 * @param supersededEntry 被取代的记忆条目
	 * @param allEntries 该 agent 所有长期记忆条目
	 * @param graph 该 agent 的知识图谱
	 */
	cascadeFromSupersede(
		supersededEntry: CascadeEntry,
		allEntries: CascadeEntry[],
		graph?: KnowledgeGraph,
	): CascadeResult {
		let flaggedNodes = 0;
		let flaggedEdges = 0;
		let flaggedMemories = 0;

		const obsIds = new Set(supersededEntry.sourceObservationIds ?? []);

		// 1. 标记关联的图节点为 stale
		if (graph && obsIds.size > 0) {
			const graphNodes = graph.getNodes();
			for (const node of graphNodes) {
				if ((node as unknown as { stale?: boolean }).stale) continue;
				const nodeObs = node.sourceMemoryIds ?? [];
				const overlap = nodeObs.some(id => obsIds.has(id));
				if (overlap) {
					graph.markNodeStale(node.id);
					flaggedNodes++;
				}
			}

			// 2. 标记关联的边为 stale
			const graphEdges = graph.getEdges();
			for (const edge of graphEdges) {
				if ((edge as unknown as { stale?: boolean }).stale) continue;
				const edgeObs = edge.sourceMemoryIds ?? [];
				const overlap = edgeObs.some(id => obsIds.has(id));
				if (overlap) {
					graph.markEdgeStale(edge.id);
					flaggedEdges++;
				}
			}
		}

		// 3. 标记共享概念的兄弟记忆（概念重叠 ≥ 2 视为可能受影响）
		const supersededConcepts = new Set(
			(supersededEntry.concepts ?? []).map(c => c.toLowerCase()),
		);
		if (supersededConcepts.size >= 2) {
			for (const mem of allEntries) {
				if (mem.id === supersededEntry.id) continue;
				if (mem.supersededBy) continue;

				const sharedCount = (mem.concepts ?? []).filter(c =>
					supersededConcepts.has(c.toLowerCase()),
				).length;
				if (sharedCount >= 2) {
					// 在 metadata 中标记为可能过时（不直接 supersede，只做软标记）
					if (mem.metadata) {
						mem.metadata['possiblyStaleDueTo'] = supersededEntry.id;
					}
					flaggedMemories++;
				}
			}
		}

		return {
			flaggedNodes,
			flaggedEdges,
			flaggedMemories,
			total: flaggedNodes + flaggedEdges + flaggedMemories,
		};
	}

	/**
	 * 批量清理 stale 标记（当新记忆覆盖了旧区域时）
	 */
	clearStaleFlags(entries: CascadeEntry[]): number {
		let cleared = 0;
		for (const entry of entries) {
			if (entry.metadata?.['possiblyStaleDueTo']) {
				delete entry.metadata['possiblyStaleDueTo'];
				cleared++;
			}
		}
		return cleared;
	}
}
