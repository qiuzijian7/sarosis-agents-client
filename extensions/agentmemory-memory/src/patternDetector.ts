/*---------------------------------------------------------------------------------------------
 *  模式检测器 — 识别跨会话的重复主题和模式。
 *  参考 agentmemory src/functions/patterns.ts
 *
 *  统计记忆中的 concepts/files 频率，识别高频模式。
 *--------------------------------------------------------------------------------------------*/

export interface DetectedPattern {
	concept: string;
	frequency: number;
	memoryIds: string[];
	confidence: number;
}

export interface PatternDetectionResult {
	patterns: DetectedPattern[];
	topFiles: Array<{ file: string; frequency: number }>;
	topConcepts: Array<{ concept: string; frequency: number }>;
	totalAnalyzed: number;
}

interface InternalEntry {
	id: string;
	content: string;
	metadata?: Record<string, unknown>;
	concepts?: string[];
	files?: string[];
}

export class PatternDetector {
	/**
	 * Detect recurring patterns from a list of memory entries.
	 * Counts concept/file frequency across memories.
	 */
	detect(entries: InternalEntry[]): PatternDetectionResult {
		const conceptFreq = new Map<string, { count: number; memoryIds: string[] }>();
		const fileFreq = new Map<string, { count: number; memoryIds: string[] }>();

		for (const entry of entries) {
			// Extract concepts from metadata or re-extract from content
			const concepts = (entry.metadata?.['concepts'] as string[])
				?? this._extractConcepts(entry.content);
			const files = (entry.metadata?.['files'] as string[])
				?? this._extractFiles(entry.content);

			for (const concept of concepts) {
				const lower = concept.toLowerCase();
				const existing = conceptFreq.get(lower) ?? { count: 0, memoryIds: [] };
				existing.count++;
				if (!existing.memoryIds.includes(entry.id)) {
					existing.memoryIds.push(entry.id);
				}
				conceptFreq.set(lower, existing);
			}

			for (const file of files) {
				const existing = fileFreq.get(file) ?? { count: 0, memoryIds: [] };
				existing.count++;
				if (!existing.memoryIds.includes(entry.id)) {
					existing.memoryIds.push(entry.id);
				}
				fileFreq.set(file, existing);
			}
		}

		// Convert to patterns (frequency >= 2)
		const patterns: DetectedPattern[] = [];
		for (const [concept, data] of conceptFreq) {
			if (data.count >= 2) {
				patterns.push({
					concept,
					frequency: data.count,
					memoryIds: data.memoryIds,
					confidence: Math.min(1, data.count / Math.max(1, entries.length)),
				});
			}
		}
		patterns.sort((a, b) => b.frequency - a.frequency);

		const topFiles = Array.from(fileFreq.entries())
			.map(([file, data]) => ({ file, frequency: data.count }))
			.sort((a, b) => b.frequency - a.frequency)
			.slice(0, 10);

		const topConcepts = Array.from(conceptFreq.entries())
			.map(([concept, data]) => ({ concept, frequency: data.count }))
			.sort((a, b) => b.frequency - a.frequency)
			.slice(0, 10);

		return {
			patterns: patterns.slice(0, 15),
			topFiles,
			topConcepts,
			totalAnalyzed: entries.length,
		};
	}

	private _extractConcepts(text: string): string[] {
		const words = text.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, ' ')
			.split(/\s+/)
			.filter(w => w.length > 4);
		const freq = new Map<string, number>();
		for (const w of words) {
			freq.set(w, (freq.get(w) ?? 0) + 1);
		}
		return [...freq.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([w]) => w);
	}

	private _extractFiles(text: string): string[] {
		const matches = text.match(/[\w-]+\/[\w./-]+\.\w+/g) ?? [];
		return [...new Set(matches)].slice(0, 5);
	}
}
