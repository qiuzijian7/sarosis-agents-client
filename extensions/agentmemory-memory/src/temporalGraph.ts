/*---------------------------------------------------------------------------------------------
 *  时序图 — 时间感知的知识图谱。
 *  参考 agentmemory src/functions/temporal-graph.ts
 *
 *  与 KnowledgeGraph 的区别：
 *    - KnowledgeGraph：静态图（节点+边，无时间维度）
 *    - TemporalGraph：时序图（边有 valid_from/valid_to，支持版本化）
 *
 *  核心能力：
 *    1. addTemporalEdge(source, target, type, validFrom, validTo) — 添加时序边
 *    2. getActiveRelationships(atTime) — 获取某时间点活跃的关系
 *    3. getRelationshipHistory(nodeId) — 获取节点的关系演变历史
 *    4. closeRelationship(edgeId, validTo) — 关闭关系（valid_to = now）
 *    5. detectTemporalConflicts() — 检测同一时间段的矛盾关系
 *--------------------------------------------------------------------------------------------*/

export type TemporalEdgeType =
	| 'uses' | 'imports' | 'modifies' | 'causes' | 'fixes'
	| 'depends_on' | 'related_to' | 'works_at' | 'prefers'
	| 'blocked_by' | 'caused_by' | 'avoids' | 'succeeded_by';

export interface TemporalEdge {
	id: string;
	type: TemporalEdgeType;
	sourceNodeId: string;
	targetNodeId: string;
	weight: number;
	validFrom: number;     // ISO timestamp → ms
	validTo: number;       // ISO timestamp → ms, 0 = current/ongoing
	reasoning?: string;
	sentiment?: 'positive' | 'negative' | 'neutral';
	sourceMemoryIds: string[];
	version: number;       // 版本号（同一关系更新时递增）
	createdAt: string;
}

export interface TemporalNode {
	id: string;
	name: string;
	type: string;
	properties: Record<string, string>;
	aliases: string[];
	firstSeenAt: number;
	lastSeenAt: number;
}

export interface TemporalConflict {
	nodeId: string;
	edge1Id: string;
	edge2Id: string;
	reason: string;
}

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const NOW = 0;  // validTo=0 表示 ongoing/current

export class TemporalGraph {
	private _nodes = new Map<string, TemporalNode>();
	private _edges = new Map<string, TemporalEdge>();
	private _bySource = new Map<string, TemporalEdge[]>();
	private _byTarget = new Map<string, TemporalEdge[]>();
	private _nameIndex = new Map<string, string>();  // name(lowercase) → nodeId
	private _versionCounter = new Map<string, number>();  // edgeKey → next version

	private _edgeKey(source: string, target: string, type: TemporalEdgeType): string {
		return `${source}|${target}|${type}`;
	}

	/**
	 * 添加或更新节点
	 */
	addNode(name: string, type: string, properties?: Record<string, string>, aliases?: string[]): TemporalNode {
		const key = name.toLowerCase();
		let node = this._nodes.get(this._nameIndex.get(key) ?? '');
		const now = Date.now();

		if (node) {
			node.lastSeenAt = now;
			if (properties) {
				Object.assign(node.properties, properties);
			}
			if (aliases) {
				for (const a of aliases) {
					if (!node.aliases.includes(a)) {
						node.aliases.push(a);
					}
				}
			}
			return node;
		}

		const id = generateId('tn');
		node = {
			id,
			name,
			type,
			properties: properties ?? {},
			aliases: aliases ?? [],
			firstSeenAt: now,
			lastSeenAt: now,
		};
		this._nodes.set(id, node);
		this._nameIndex.set(key, id);
		return node;
	}

	/**
	 * 添加时序边
	 * 如果存在同 source→target→type 的 ongoing 边，先关闭它（版本化）
	 */
	addEdge(
		sourceNodeId: string,
		targetNodeId: string,
		type: TemporalEdgeType,
		opts?: {
			weight?: number;
			validFrom?: number;
			validTo?: number;
			reasoning?: string;
			sentiment?: 'positive' | 'negative' | 'neutral';
			sourceMemoryIds?: string[];
		},
	): TemporalEdge {
		const edgeKey = this._edgeKey(sourceNodeId, targetNodeId, type);
		const now = Date.now();

		// 关闭现有的 ongoing 边（版本化）
		const existing = (this._bySource.get(sourceNodeId) ?? [])
			.filter(e => e.targetNodeId === targetNodeId && e.type === type && e.validTo === NOW);
		for (const old of existing) {
			old.validTo = now;
		}

		// 递增版本号
		const version = (this._versionCounter.get(edgeKey) ?? 0) + 1;
		this._versionCounter.set(edgeKey, version);

		const edge: TemporalEdge = {
			id: generateId('te'),
			type,
			sourceNodeId,
			targetNodeId,
			weight: opts?.weight ?? 1.0,
			validFrom: opts?.validFrom ?? now,
			validTo: opts?.validTo ?? NOW,
			reasoning: opts?.reasoning,
			sentiment: opts?.sentiment ?? 'neutral',
			sourceMemoryIds: opts?.sourceMemoryIds ?? [],
			version,
			createdAt: new Date().toISOString(),
		};

		this._edges.set(edge.id, edge);

		// 索引
		const bySrc = this._bySource.get(sourceNodeId) ?? [];
		bySrc.push(edge);
		this._bySource.set(sourceNodeId, bySrc);

		const byTgt = this._byTarget.get(targetNodeId) ?? [];
		byTgt.push(edge);
		this._byTarget.set(targetNodeId, byTgt);

		return edge;
	}

	/**
	 * 获取某时间点活跃的关系
	 */
	getActiveRelationships(nodeId: string, atTime?: number): TemporalEdge[] {
		const ts = atTime ?? Date.now();
		const edges = [
			...(this._bySource.get(nodeId) ?? []),
			...(this._byTarget.get(nodeId) ?? []),
		];
		return edges.filter(e =>
			e.validFrom <= ts && (e.validTo === NOW || e.validTo >= ts),
		);
	}

	/**
	 * 获取节点的关系演变历史
	 */
	getRelationshipHistory(nodeId: string): Array<{ edge: TemporalEdge; status: 'ongoing' | 'ended' | 'future' }> {
		const now = Date.now();
		const edges = [
			...(this._bySource.get(nodeId) ?? []),
			...(this._byTarget.get(nodeId) ?? []),
		];
		return edges
			.sort((a, b) => a.validFrom - b.validFrom)
			.map(edge => ({
				edge,
				status: edge.validTo === NOW ? 'ongoing' as const
					: edge.validTo < now ? 'ended' as const
						: 'future' as const,
			}));
	}

	/**
	 * 关闭关系
	 */
	closeRelationship(edgeId: string, validTo?: number): boolean {
		const edge = this._edges.get(edgeId);
		if (!edge || edge.validTo !== NOW) return false;
		edge.validTo = validTo ?? Date.now();
		return true;
	}

	/**
	 * 检测同一时间段的矛盾关系
	 */
	detectTemporalConflicts(): TemporalConflict[] {
		const conflicts: TemporalConflict[] = [];
		const now = Date.now();

		for (const [nodeId, edges] of this._bySource) {
			// 按 target+type 分组
			const groups = new Map<string, TemporalEdge[]>();
			for (const e of edges) {
				const key = `${e.targetNodeId}|${e.type}`;
				const group = groups.get(key) ?? [];
				group.push(e);
				groups.set(key, group);
			}

			for (const [, group] of groups) {
				if (group.length < 2) continue;
				// 检查时间重叠
				for (let i = 0; i < group.length; i++) {
					for (let j = i + 1; j < group.length; j++) {
						const e1 = group[i];
						const e2 = group[j];
						const e1End = e1.validTo === NOW ? now : e1.validTo;
						const e2End = e2.validTo === NOW ? now : e2.validTo;
						// 检查重叠
						if (e1.validFrom < e2End && e2.validFrom < e1End) {
							// 检查矛盾（sentiment 相反）
							if (e1.sentiment !== e2.sentiment && e1.sentiment !== 'neutral' && e2.sentiment !== 'neutral') {
								conflicts.push({
									nodeId,
									edge1Id: e1.id,
									edge2Id: e2.id,
									reason: `conflicting sentiment (${e1.sentiment} vs ${e2.sentiment}) on same relationship`,
								});
							}
						}
					}
				}
			}
		}

		return conflicts;
	}

	/**
	 * 获取统计
	 */
	getStats(): { nodes: number; edges: number; ongoingEdges: number; endedEdges: number; avgVersionPerEdge: number } {
		const edges = Array.from(this._edges.values());
		const ongoing = edges.filter(e => e.validTo === NOW).length;
		const ended = edges.filter(e => e.validTo !== NOW).length;
		const totalVersions = Array.from(this._versionCounter.values()).reduce((s, v) => s + v, 0);
		return {
			nodes: this._nodes.size,
			edges: edges.length,
			ongoingEdges: ongoing,
			endedEdges: ended,
			avgVersionPerEdge: edges.length > 0 ? Math.round(totalVersions / edges.length * 10) / 10 : 0,
		};
	}

	/**
	 * 获取节点
	 */
	getNode(id: string): TemporalNode | null {
		return this._nodes.get(id) ?? null;
	}

	/**
	 * 按名称查找节点
	 */
	findNode(name: string): TemporalNode | null {
		const id = this._nameIndex.get(name.toLowerCase());
		return id ? (this._nodes.get(id) ?? null) : null;
	}

	/**
	 * 清除所有
	 */
	clear(): void {
		this._nodes.clear();
		this._edges.clear();
		this._bySource.clear();
		this._byTarget.clear();
		this._nameIndex.clear();
		this._versionCounter.clear();
	}
}
