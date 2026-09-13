/*---------------------------------------------------------------------------------------------
 *  文件富化 — 工具调用前注入文件相关记忆。
 *  参考 agentmemory src/functions/enrich.ts
 *
 *  当 Agent 即将操作文件时，检索与该文件相关的历史记忆，
 *  为 Agent 提供额外的文件上下文（之前遇到的错误、约定、模式等）。
 *--------------------------------------------------------------------------------------------*/

interface InternalEntry {
	id: string;
	content: string;
	type: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
	strength: number;
	supersededBy?: string;
}

export interface EnrichmentResult {
	filePath: string;
	relatedMemories: Array<{
		id: string;
		content: string;
		score: number;
		type: string;
	}>;
	knownErrors: string[];
	conventions: string[];
	recentChanges: string[];
	totalContext: string;
}

const FILE_RE = /(?:src\/|test\/|lib\/|app\/|extensions\/|packages\/)?[\w-]+\/[\w./-]+\.(?:ts|js|json|md|py|go|rs|java|cpp|jsx|tsx|vue|css|html|yml|yaml|sh|mjs)/;

export class FileEnricher {
	/**
	 * Enrich context for a file operation.
	 * Searches memories for entries mentioning this file.
	 */
	enrich(filePath: string, longEntries: InternalEntry[], limit: number = 5): EnrichmentResult {
		const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
		const basename = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';

		// Find memories that mention this file
		const related = longEntries
			.filter(e => !e.supersededBy)
			.map(e => {
				const content = e.content.toLowerCase();
				let score = 0;

				// Exact path match
				if (content.includes(normalizedPath)) score += 3;
				// Basename match
				if (basename && content.includes(basename)) score += 2;
				// Metadata files match
				const metaFiles = (e.metadata?.['files'] as string[]) ?? [];
				if (metaFiles.some(f => f.toLowerCase().includes(basename))) score += 2;
				if (metaFiles.some(f => f.toLowerCase().includes(normalizedPath))) score += 3;

				return { entry: e, score };
			})
			.filter(r => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		const relatedMemories = related.map(r => ({
			id: r.entry.id,
			content: r.entry.content.slice(0, 200),
			score: r.score,
			type: r.entry.type,
		}));

		// Extract known errors related to this file
		const knownErrors = related
			.map(r => r.entry.content)
			.join('\n')
			.match(/(?:error|fail|exception|bug)[:\s]+([^\n.]{10,80})/gi)
			?.map(m => m.trim()) ?? [];

		// Extract conventions
		const conventions = related
			.map(r => r.entry.content)
			.join('\n')
			.match(/(?:should|must|always|never|convention|规范|必须)[^\n.]{10,80}/gi)
			?.map(m => m.trim()) ?? [];

		// Recent changes (sorted by timestamp)
		const recentChanges = [...related]
			.sort((a, b) => (b.entry.timestamp ?? 0) - (a.entry.timestamp ?? 0))
			.slice(0, 3)
			.map(r => r.entry.content.replace(/\s+/g, ' ').slice(0, 100));

		// Build context string
		const parts: string[] = [];
		parts.push(`## File Context: ${filePath}`);
		if (relatedMemories.length > 0) {
			parts.push(`Found ${relatedMemories.length} related memories:`);
			for (const m of relatedMemories) {
				parts.push(`- [${m.score}] ${m.content}`);
			}
		}
		if (knownErrors.length > 0) {
			parts.push(`\nKnown errors (${knownErrors.length}):`);
			for (const e of knownErrors.slice(0, 3)) parts.push(`- ${e}`);
		}
		if (conventions.length > 0) {
			parts.push(`\nConventions (${conventions.length}):`);
			for (const c of conventions.slice(0, 3)) parts.push(`- ${c}`);
		}

		return {
			filePath,
			relatedMemories,
			knownErrors: [...new Set(knownErrors)].slice(0, 5),
			conventions: [...new Set(conventions)].slice(0, 5),
			recentChanges,
			totalContext: parts.join('\n'),
		};
	}

	/** Quick check if a file path is worth enriching */
	shouldEnrich(filePath: string): boolean {
		return FILE_RE.test(filePath);
	}
}
