/*---------------------------------------------------------------------------------------------
 *  记忆关系 — 记忆间的结构化关系图。
 *  参考 agentmemory src/functions/relations.ts
 *
 *  关系类型：
 *    supersedes — 新记忆取代旧记忆（已在 contradiction detection 中实现）
 *    extends    — 新记忆扩展旧记忆（补充信息）
 *    derives    — 新记忆从旧记忆推导
 *    contradicts — 新记忆与旧记忆矛盾（但未取代）
 *    related     — 泛化关联
 *--------------------------------------------------------------------------------------------*/

export type RelationType = 'supersedes' | 'extends' | 'derives' | 'contradicts' | 'related';

export interface MemoryRelation {
	id: string;
	type: RelationType;
	sourceId: string;      // 新记忆 ID
	targetId: string;       // 旧记忆 ID
	confidence: number;
	reasoning?: string;
	createdAt: string;
}

export class RelationGraph {
	private _relations: MemoryRelation[] = [];
	private _bySource = new Map<string, MemoryRelation[]>();
	private _byTarget = new Map<string, MemoryRelation[]>();

	/** Add a relation between two memories */
	add(type: RelationType, sourceId: string, targetId: string, confidence: number = 0.8, reasoning?: string): void {
		const relation: MemoryRelation = {
			id: `rel-${type}-${sourceId}-${targetId}-${Date.now()}`,
			type,
			sourceId,
			targetId,
			confidence,
			reasoning,
			createdAt: new Date().toISOString(),
		};
		this._relations.push(relation);

		// Index by source
		const bySrc = this._bySource.get(sourceId) ?? [];
		bySrc.push(relation);
		this._bySource.set(sourceId, bySrc);

		// Index by target
		const byTgt = this._byTarget.get(targetId) ?? [];
		byTgt.push(relation);
		this._byTarget.set(targetId, byTgt);
	}

	/** Get all relations from a memory (what this memory supersedes/extends/etc.) */
	getFrom(memoryId: string): MemoryRelation[] {
		return this._bySource.get(memoryId) ?? [];
	}

	/** Get all relations to a memory (what supersedes/extends this memory) */
	getTo(memoryId: string): MemoryRelation[] {
		return this._byTarget.get(memoryId) ?? [];
	}

	/** Check if a memory is superseded by another */
	isSuperseded(memoryId: string): boolean {
		return this._byTarget.get(memoryId)?.some(r => r.type === 'supersedes') ?? false;
	}

	/** Get the memory that supersedes this one */
	getSuperseder(memoryId: string): string | undefined {
		return this._byTarget.get(memoryId)?.find(r => r.type === 'supersedes')?.sourceId;
	}

	/** Get all related memories (any relation type) */
	getRelated(memoryId: string): string[] {
		const related = new Set<string>();
		for (const r of this.getFrom(memoryId)) {
			related.add(r.targetId);
		}
		for (const r of this.getTo(memoryId)) {
			related.add(r.sourceId);
		}
		return Array.from(related);
	}

	/** Get all relations of a specific type */
	getByType(type: RelationType): MemoryRelation[] {
		return this._relations.filter(r => r.type === type);
	}

	/** Remove all relations involving a memory */
	removeMemory(memoryId: string): void {
		this._relations = this._relations.filter(r =>
			r.sourceId !== memoryId && r.targetId !== memoryId
		);
		this._bySource.delete(memoryId);
		this._byTarget.delete(memoryId);
		// Rebuild indices
		for (const [src, rels] of this._bySource) {
			this._bySource.set(src, rels.filter(r => r.targetId !== memoryId));
		}
		for (const [tgt, rels] of this._byTarget) {
			this._byTarget.set(tgt, rels.filter(r => r.sourceId !== memoryId));
		}
	}

	get count(): number { return this._relations.length; }

	getStats(): Record<RelationType, number> {
		const stats = {} as Record<RelationType, number>;
		for (const r of this._relations) {
			stats[r.type] = (stats[r.type] ?? 0) + 1;
		}
		return stats;
	}

	clear(): void {
		this._relations = [];
		this._bySource.clear();
		this._byTarget.clear();
	}
}
