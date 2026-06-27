/*---------------------------------------------------------------------------------------------
 *  多维标签 — dimension:value 标签系统，支持多维过滤。
 *  参考 agentmemory src/functions/facets.ts
 *
 *  用途：给记忆打上多维标签，支持按维度组合过滤。
 *  示例：
 *    tag(memId, 'category', 'bug')
 *    tag(memId, 'severity', 'high')
 *    tag(memId, 'module', 'auth')
 *    query({ category: 'bug', severity: 'high' })  // 查找 auth 模块的高优先级 bug
 *--------------------------------------------------------------------------------------------*/

export interface Facet {
	id: string;
	targetId: string;        // memoryId
	targetType: 'memory' | 'observation' | 'action';
	dimension: string;       // e.g. 'category', 'severity', 'module', 'status'
	value: string;            // e.g. 'bug', 'high', 'auth', 'fixed'
	createdAt: string;
}

const FACET_DIMENSIONS = new Set([
	'category',    // bug, feature, refactor, docs, test, config
	'severity',    // critical, high, medium, low
	'module',      // auth, database, ui, api, middleware
	'status',      // open, in-progress, fixed, resolved, wontfix
	'tag',         // free-form tags
	'language',    // typescript, python, rust, go
	'priority',    // p0, p1, p2, p3
	'framework',   // react, vue, express, fastify
]);

export class FacetManager {
	private _facets: Facet[] = [];
	private _byTarget = new Map<string, Facet[]>();
	private _byDimension = new Map<string, Map<string, Set<string>>>(); // dimension → value → targetIds

	/** Tag a memory with a dimension:value facet */
	tag(targetId: string, targetType: Facet['targetType'], dimension: string, value: string): void {
		// Check if already tagged
		const existing = this._byTarget.get(targetId);
		if (existing?.some(f => f.dimension === dimension && f.value === value)) return;

		const facet: Facet = {
			id: `facet-${targetId}-${dimension}-${value}`,
			targetId,
			targetType,
			dimension,
			value,
			createdAt: new Date().toISOString(),
		};
		this._facets.push(facet);

		// Index by target
		const byTarget = this._byTarget.get(targetId) ?? [];
		byTarget.push(facet);
		this._byTarget.set(targetId, byTarget);

		// Index by dimension → value → targetIds
		let dimMap = this._byDimension.get(dimension);
		if (!dimMap) {
			dimMap = new Map();
			this._byDimension.set(dimension, dimMap);
		}
		let valueSet = dimMap.get(value);
		if (!valueSet) {
			valueSet = new Set();
			dimMap.set(value, valueSet);
		}
		valueSet.add(targetId);
	}

	/** Untag a specific facet */
	untag(targetId: string, dimension: string, value: string): void {
		this._facets = this._facets.filter(f =>
			!(f.targetId === targetId && f.dimension === dimension && f.value === value)
		);
		const byTarget = this._byTarget.get(targetId);
		if (byTarget) {
			this._byTarget.set(targetId, byTarget.filter(f =>
				!(f.dimension === dimension && f.value === value)
			));
		}
		const dimMap = this._byDimension.get(dimension);
		if (dimMap) {
			const valueSet = dimMap.get(value);
			if (valueSet) valueSet.delete(targetId);
		}
	}

	/** Remove all facets for a target */
	removeTarget(targetId: string): void {
		this._facets = this._facets.filter(f => f.targetId !== targetId);
		this._byTarget.delete(targetId);
		// Clean dimension index
		for (const dimMap of this._byDimension.values()) {
			for (const valueSet of dimMap.values()) {
				valueSet.delete(targetId);
			}
		}
	}

	/** Get all facets for a target */
	getFacets(targetId: string): Facet[] {
		return this._byTarget.get(targetId) ?? [];
	}

	/**
	 * Query targets by facet filters.
	 * All filters must match (AND logic).
	 * Example: query({ category: 'bug', severity: 'high' })
	 */
	query(filters: Record<string, string | string[]>): string[] {
		const filterEntries = Object.entries(filters);
		if (filterEntries.length === 0) return [];

		let resultSets: Set<string>[] = [];
		for (const [dimension, valueOrValues] of filterEntries) {
			const values = Array.isArray(valueOrValues) ? valueOrValues : [valueOrValues];
			const matching = new Set<string>();
			for (const value of values) {
				const dimMap = this._byDimension.get(dimension);
				if (dimMap) {
					const ids = dimMap.get(value);
					if (ids) {
						for (const id of ids) matching.add(id);
					}
				}
			}
			resultSets.push(matching);
		}

		// Intersect all sets (AND logic)
		if (resultSets.length === 0) return [];
		let result = resultSets[0];
		for (let i = 1; i < resultSets.length; i++) {
			result = new Set([...result].filter(x => resultSets[i].has(x)));
		}
		return Array.from(result);
	}

	/** Get all values for a dimension */
	getDimensionValues(dimension: string): string[] {
		const dimMap = this._byDimension.get(dimension);
		if (!dimMap) return [];
		return Array.from(dimMap.keys());
	}

	/** Get all dimensions */
	getDimensions(): string[] {
		return Array.from(this._byDimension.keys());
	}

	/** Get statistics */
	getStats(): { totalFacets: number; dimensions: number; targets: number } {
		return {
			totalFacets: this._facets.length,
			dimensions: this._byDimension.size,
			targets: this._byTarget.size,
		};
	}

	/** Check if a dimension is a known/predefined one */
	static isKnownDimension(dimension: string): boolean {
		return FACET_DIMENSIONS.has(dimension);
	}

	get knownDimensions(): string[] {
		return Array.from(FACET_DIMENSIONS);
	}

	clear(): void {
		this._facets = [];
		this._byTarget.clear();
		this._byDimension.clear();
	}
}
