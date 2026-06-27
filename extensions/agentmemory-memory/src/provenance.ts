/*---------------------------------------------------------------------------------------------
 *  溯源 — 追溯记忆到原始观察。
 *  参考 agentmemory src/functions/verify.ts
 *
 *  构建记忆→观察的溯源链，支持：
 *    - 查询某条记忆来自哪些原始观察
 *    - 查询某个观察衍生了哪些记忆
 *    - 验证记忆的来源完整性
 *--------------------------------------------------------------------------------------------*/

export interface ProvenanceNode {
	memoryId: string;
	memoryType: 'observation' | 'long_term' | 'episodic' | 'semantic' | 'procedural' | 'lesson';
	sourceObservationIds: string[];
	sourceMemoryIds: string[];
	createdAt: string;
}

export interface ProvenanceChain {
	memoryId: string;
	chain: ProvenanceNode[];
	depth: number;
	complete: boolean; // false if any source is missing
}

export class ProvenanceTracker {
	private _nodes = new Map<string, ProvenanceNode>();
	private _reverseIndex = new Map<string, string[]>(); // observationId → memoryIds that derived from it

	/**
	 * Record the provenance of a new memory.
	 * Links the memory to its source observations/memories.
	 */
	record(memoryId: string, type: ProvenanceNode['memoryType'], sourceIds: string[]): void {
		const node: ProvenanceNode = {
			memoryId,
			memoryType: type,
			sourceObservationIds: sourceIds.filter(id => id.startsWith('obs-') || id.startsWith('short-')),
			sourceMemoryIds: sourceIds,
			createdAt: new Date().toISOString(),
		};
		this._nodes.set(memoryId, node);

		// Build reverse index
		for (const sourceId of sourceIds) {
			const arr = this._reverseIndex.get(sourceId) ?? [];
			arr.push(memoryId);
			this._reverseIndex.set(sourceId, arr);
		}
	}

	/**
	 * Trace a memory back to its source observations.
	 * Follows the chain recursively up to maxDepth.
	 */
	trace(memoryId: string, maxDepth: number = 5): ProvenanceChain {
		const chain: ProvenanceNode[] = [];
		const visited = new Set<string>();
		let complete = true;

		const traceRecursive = (id: string, depth: number) => {
			if (depth > maxDepth || visited.has(id)) return;
			visited.add(id);

			const node = this._nodes.get(id);
			if (!node) {
				complete = false;
				return;
			}

			chain.push(node);

			// Recursively trace sources
			for (const sourceId of node.sourceMemoryIds) {
				if (sourceId !== id) {
					traceRecursive(sourceId, depth + 1);
				}
			}
		};

		traceRecursive(memoryId, 0);

		return {
			memoryId,
			chain,
			depth: chain.length,
			complete,
		};
	}

	/**
	 * Find all memories that were derived from a specific observation.
	 */
	findDerived(observationId: string): string[] {
		return this._reverseIndex.get(observationId) ?? [];
	}

	/**
	 * Verify the provenance of a memory.
	 * Returns false if any source is missing or the chain is broken.
	 */
	verify(memoryId: string): { valid: boolean; missingSources: string[] } {
		const chain = this.trace(memoryId);
		const missingSources: string[] = [];

		for (const node of chain.chain) {
			for (const sourceId of node.sourceMemoryIds) {
				if (!this._nodes.has(sourceId) && !sourceId.startsWith('obs-')) {
					missingSources.push(sourceId);
				}
			}
		}

		return { valid: chain.complete && missingSources.length === 0, missingSources };
	}

	/**
	 * Get statistics about the provenance graph.
	 */
	getStats(): { totalMemories: number; totalLinks: number; avgSources: number } {
		let totalLinks = 0;
		for (const node of this._nodes.values()) {
			totalLinks += node.sourceMemoryIds.length;
		}
		return {
			totalMemories: this._nodes.size,
			totalLinks,
			avgSources: this._nodes.size > 0 ? totalLinks / this._nodes.size : 0,
		};
	}

	/** Remove a memory from the provenance graph */
	remove(memoryId: string): void {
		const node = this._nodes.get(memoryId);
		if (node) {
			for (const sourceId of node.sourceMemoryIds) {
				const arr = this._reverseIndex.get(sourceId);
				if (arr) {
					const idx = arr.indexOf(memoryId);
					if (idx >= 0) arr.splice(idx, 1);
				}
			}
		}
		this._nodes.delete(memoryId);
	}

	clear(): void {
		this._nodes.clear();
		this._reverseIndex.clear();
	}
}
