/*---------------------------------------------------------------------------------------------
 *  记忆验证 — 交叉验证记忆准确性 + 引用追溯。
 *  参考 agentmemory src/functions/verify.ts
 *
 *  核心能力：
 *    1. verify(memoryId) — 验证记忆的来源引用是否完整
 *    2. getCitations(memoryId) — 获取记忆的引用链
 *    3. checkConsistency(memoryId) — 检查记忆与同主题记忆是否一致
 *    4. validateAgainstSources(memoryId, sources) — 与实际源文件对比
 *
 *  验证结果：
 *    - valid: 所有来源引用都存在
 *    - partial: 部分引用缺失
 *    - invalid: 来源完全缺失或矛盾
 *--------------------------------------------------------------------------------------------*/

export interface Citation {
	observationId: string;
	title: string;
	type: string;
	timestamp: number;
	sessionId: string;
	confidence: number;
}

export interface VerifyResult {
	memoryId: string;
	status: 'valid' | 'partial' | 'invalid' | 'orphan';
	citations: Citation[];
	citationCount: number;
	missingSources: string[];
	contradictions: Array<{ memoryId: string; similarity: number; reason: string }>;
	verifiedAt: string;
}

export interface VerifyEntry {
	id: string;
	content: string;
	type: string;
	metadata?: Record<string, unknown>;
	timestamp: number;
	supersededBy?: string;
}

export interface VerifySource {
	id: string;
	content: string;
	exists: boolean;
}

export class MemoryVerifier {
	/**
	 * 验证记忆的来源完整性
	 */
	verify(
		memoryId: string,
		entry: VerifyEntry,
		allEntries: VerifyEntry[],
		provenanceSources?: string[],
	): VerifyResult {
		const citations: Citation[] = [];
		const missingSources: string[] = [];

		// 获取来源 ID
		const sourceIds = provenanceSources ?? (entry.metadata?.['sourceIds'] as string[]) ?? [entry.id];

		// 验证每个来源是否存在
		for (const sourceId of sourceIds) {
			const source = allEntries.find(e => e.id === sourceId);
			if (source && !source.supersededBy) {
				citations.push({
					observationId: source.id,
					title: (source.metadata?.['title'] as string) ?? source.content.slice(0, 80),
					type: source.type,
					timestamp: source.timestamp,
					sessionId: (source.metadata?.['sessionId'] as string) ?? '',
					confidence: (source.metadata?.['confidence'] as number) ?? 0.7,
				});
			} else if (sourceId !== entry.id) {
				missingSources.push(sourceId);
			}
		}

		// 检查同主题矛盾
		const contradictions: Array<{ memoryId: string; similarity: number; reason: string }> = [];
		const concepts = (entry.metadata?.['concepts'] as string[]) ?? [];
		if (concepts.length >= 2) {
			const conceptSet = new Set(concepts.map(c => c.toLowerCase()));
			for (const other of allEntries) {
				if (other.id === entry.id) continue;
				if (other.supersededBy) continue;

				const otherConcepts = (other.metadata?.['concepts'] as string[]) ?? [];
				const sharedCount = otherConcepts.filter(c => conceptSet.has(c.toLowerCase())).length;
				if (sharedCount >= 2) {
					// 简单相似度：共享概念比例
					const similarity = sharedCount / Math.max(concepts.length, otherConcepts.length);
					// 检查内容是否矛盾（简单检测：否定词）
					const entryNeg = /\b(not|never|don't|avoid|deprecated|removed|deleted)\b/i.test(entry.content);
					const otherNeg = /\b(not|never|don't|avoid|deprecated|removed|deleted)\b/i.test(other.content);
					if (entryNeg !== otherNeg && similarity > 0.5) {
						contradictions.push({
							memoryId: other.id,
							similarity,
							reason: 'potential contradiction (opposite polarity on shared concepts)',
						});
					}
				}
			}
		}

		// 确定状态
		let status: VerifyResult['status'];
		if (citations.length === 0 && missingSources.length === 0) {
			status = 'orphan';  // 无来源（自创记忆）
		} else if (missingSources.length === 0) {
			status = contradictions.length > 0 ? 'partial' : 'valid';
		} else if (citations.length > 0) {
			status = 'partial';
		} else {
			status = 'invalid';
		}

		return {
			memoryId,
			status,
			citations,
			citationCount: citations.length,
			missingSources,
			contradictions,
			verifiedAt: new Date().toISOString(),
		};
	}

	/**
	 * 获取记忆的引用链
	 */
	getCitations(memoryId: string, allEntries: VerifyEntry[]): Citation[] {
		const entry = allEntries.find(e => e.id === memoryId);
		if (!entry) return [];

		const sourceIds = (entry.metadata?.['sourceIds'] as string[]) ?? [entry.id];
		const citations: Citation[] = [];

		for (const sourceId of sourceIds) {
			const source = allEntries.find(e => e.id === sourceId);
			if (source && !source.supersededBy) {
				citations.push({
					observationId: source.id,
					title: (source.metadata?.['title'] as string) ?? source.content.slice(0, 80),
					type: source.type,
					timestamp: source.timestamp,
					sessionId: (source.metadata?.['sessionId'] as string) ?? '',
					confidence: (source.metadata?.['confidence'] as number) ?? 0.7,
				});
			}
		}

		return citations;
	}

	/**
	 * 批量验证
	 */
	verifyAll(allEntries: VerifyEntry[]): {
		total: number;
		valid: number;
		partial: number;
		invalid: number;
		orphan: number;
		results: VerifyResult[];
	} {
		const results = allEntries
			.filter(e => !e.supersededBy)
			.map(e => this.verify(e.id, e, allEntries));

		return {
			total: results.length,
			valid: results.filter(r => r.status === 'valid').length,
			partial: results.filter(r => r.status === 'partial').length,
			invalid: results.filter(r => r.status === 'invalid').length,
			orphan: results.filter(r => r.status === 'orphan').length,
			results,
		};
	}

	/**
	 * 与实际源文件对比验证
	 */
	validateAgainstSources(entry: VerifyEntry, sources: VerifySource[]): {
		matchCount: number;
		mismatchCount: number;
		staleCount: number;
		details: Array<{ sourceId: string; status: 'match' | 'mismatch' | 'stale' | 'missing' }>;
	} {
		const sourceIds = (entry.metadata?.['sourceIds'] as string[]) ?? [];
		const details: Array<{ sourceId: string; status: 'match' | 'mismatch' | 'stale' | 'missing' }> = [];
		let matchCount = 0;
		let mismatchCount = 0;
		let staleCount = 0;

		for (const sourceId of sourceIds) {
			const source = sources.find(s => s.id === sourceId);
			if (!source) {
				details.push({ sourceId, status: 'missing' });
				continue;
			}
			if (!source.exists) {
				details.push({ sourceId, status: 'stale' });
				staleCount++;
				continue;
			}
			// 简单匹配：检查记忆内容是否包含源内容的关键部分
			const sourceKey = source.content.slice(0, 100);
			if (entry.content.includes(sourceKey)) {
				details.push({ sourceId, status: 'match' });
				matchCount++;
			} else {
				details.push({ sourceId, status: 'mismatch' });
				mismatchCount++;
			}
		}

		return { matchCount, mismatchCount, staleCount, details };
	}
}
