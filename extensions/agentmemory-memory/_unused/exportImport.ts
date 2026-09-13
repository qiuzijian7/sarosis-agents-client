/*---------------------------------------------------------------------------------------------
 *  导出/导入 — 通用的记忆导出和导入功能。
 *  参考 agentmemory src/functions/export-import.ts + obsidian-export.ts
 *
 *  支持格式：
 *    1. JSON     — 完整结构化导出（包含所有字段）
 *    2. Markdown — 可读的 Markdown 格式（适合人类阅读）
 *    3. Obsidian — Obsidian Vault 格式（带 frontmatter + [[wiki links]]）
 *
 *  核心能力：
 *    1. exportJson(agentId) — 导出为 JSON
 *    2. exportMarkdown(agentId) — 导出为 Markdown
 *    3. exportObsidian(agentId) — 导出为 Obsidian 格式
 *    4. importJson(json) — 从 JSON 导入
 *    5. importMarkdown(md) — 从 Markdown 导入
 *--------------------------------------------------------------------------------------------*/

export interface ExportEntry {
	id: string;
	type: string;
	content: string;
	timestamp: number;
	importance?: number;
	strength: number;
	accessCount: number;
	metadata?: Record<string, unknown>;
	supersededBy?: string;
}

export interface ExportPackage {
	version: string;
	exportedAt: string;
	agentId: string;
	entries: ExportEntry[];
	stats: {
		totalEntries: number;
		longTermCount: number;
		shortTermCount: number;
	};
}

export interface ImportResult {
	imported: number;
	skipped: number;
	errors: string[];
}

const EXPORT_VERSION = '1.0.0';

export class ExportImportManager {
	/**
	 * 导出为 JSON
	 */
	exportJson(agentId: string, entries: ExportEntry[], shortTermCount: number = 0): string {
		const pkg: ExportPackage = {
			version: EXPORT_VERSION,
			exportedAt: new Date().toISOString(),
			agentId,
			entries,
			stats: {
				totalEntries: entries.length + shortTermCount,
				longTermCount: entries.length,
				shortTermCount,
			},
		};
		return JSON.stringify(pkg, null, 2);
	}

	/**
	 * 导出为 Markdown
	 */
	exportMarkdown(agentId: string, entries: ExportEntry[]): string {
		const lines: string[] = [];
		lines.push(`# Memory Export: ${agentId}`);
		lines.push('');
		lines.push(`> Exported at: ${new Date().toISOString()}`);
		lines.push(`> Total entries: ${entries.length}`);
		lines.push('');

		// 按类型分组
		const byType = new Map<string, ExportEntry[]>();
		for (const e of entries) {
			const list = byType.get(e.type) ?? [];
			list.push(e);
			byType.set(e.type, list);
		}

		for (const [type, typeEntries] of byType) {
			lines.push(`## ${type} (${typeEntries.length})`);
			lines.push('');

			for (const entry of typeEntries) {
				const date = new Date(entry.timestamp).toISOString();
				const importance = entry.importance ? ` [${entry.importance}/10]` : '';
				const strength = ` (strength: ${(entry.strength * 100).toFixed(0)}%)`;
				const superseded = entry.supersededBy ? ` ~~superseded~~` : '';

				lines.push(`### ${date}${importance}${strength}${superseded}`);
				lines.push('');
				lines.push(entry.content);
				lines.push('');

				// 附加元数据
				if (entry.metadata) {
					const tags = entry.metadata['tags'];
					if (Array.isArray(tags) && tags.length > 0) {
						lines.push(`**Tags:** ${tags.join(', ')}`);
						lines.push('');
					}
					const concepts = entry.metadata['concepts'];
					if (Array.isArray(concepts) && concepts.length > 0) {
						lines.push(`**Concepts:** ${concepts.join(', ')}`);
						lines.push('');
					}
				}
				lines.push('---');
				lines.push('');
			}
		}

		return lines.join('\n');
	}

	/**
	 * 导出为 Obsidian 格式（带 frontmatter + wiki links）
	 */
	exportObsidian(agentId: string, entries: ExportEntry[]): string {
		const lines: string[] = [];

		// Frontmatter
		lines.push('---');
		lines.push(`agent: "${agentId}"`);
		lines.push(`exported: ${new Date().toISOString()}`);
		lines.push(`total: ${entries.length}`);
		lines.push('tags:');
		lines.push('  - agentmemory');
		lines.push('  - export');
		lines.push('---');
		lines.push('');

		lines.push(`# Memory: ${agentId}`);
		lines.push('');

		// 构建概念索引（用于 wiki links）
		const conceptIndex = new Map<string, string[]>();
		for (const entry of entries) {
			const concepts = (entry.metadata?.['concepts'] as string[]) ?? [];
			for (const c of concepts) {
				const list = conceptIndex.get(c) ?? [];
				list.push(entry.id);
				conceptIndex.set(c, list);
			}
		}

		for (const entry of entries) {
			const date = new Date(entry.timestamp).toISOString().slice(0, 10);
			lines.push(`## [[${date}]] - ${entry.id}`);
			lines.push('');

			// Frontmatter for this entry
			lines.push('**Type:** ' + entry.type);
			if (entry.importance) lines.push(`  **Importance:** ${entry.importance}/10`);
			lines.push(`  **Strength:** ${(entry.strength * 100).toFixed(0)}%`);
			lines.push('');

			lines.push(entry.content);
			lines.push('');

			// Wiki links to concepts
			const concepts = (entry.metadata?.['concepts'] as string[]) ?? [];
			if (concepts.length > 0) {
				lines.push('**Related:** ' + concepts.map(c => `[[${c}]]`).join(' '));
				lines.push('');
			}

			lines.push('---');
			lines.push('');
		}

		// 概念索引页
		if (conceptIndex.size > 0) {
			lines.push('# Concept Index');
			lines.push('');
			for (const [concept, entryIds] of Array.from(conceptIndex.entries()).sort()) {
				lines.push(`## [[${concept}]]`);
				lines.push(`- Referenced by: ${entryIds.map(id => `[[${id}]]`).join(', ')}`);
				lines.push('');
			}
		}

		return lines.join('\n');
	}

	/**
	 * 从 JSON 导入
	 */
	importJson(json: string): ImportResult {
		try {
			const pkg = JSON.parse(json) as ExportPackage;
			if (!pkg.entries || !Array.isArray(pkg.entries)) {
				return { imported: 0, skipped: 0, errors: ['Invalid format: missing entries array'] };
			}

			let imported = 0;
			let skipped = 0;
			const errors: string[] = [];

			for (const entry of pkg.entries) {
				if (!entry.id || !entry.content) {
					skipped++;
					continue;
				}
				if (entry.content.trim().length === 0) {
					skipped++;
					continue;
				}
				imported++;
			}

			return { imported, skipped, errors };
		} catch (err) {
			return { imported: 0, skipped: 0, errors: [err instanceof Error ? err.message : String(err)] };
		}
	}

	/**
	 * 从 Markdown 导入（解析 ### 标题下的内容）
	 */
	importMarkdown(md: string): ImportResult {
		const lines = md.split('\n');
		let imported = 0;
		let skipped = 0;
		const errors: string[] = [];

		let currentContent: string[] = [];
		let inEntry = false;

		for (const line of lines) {
			if (line.startsWith('### ')) {
				// 保存前一个条目
				if (inEntry && currentContent.length > 0) {
					const content = currentContent.join('\n').trim();
					if (content.length > 0) {
						imported++;
					} else {
						skipped++;
					}
				}
				inEntry = true;
				currentContent = [];
			} else if (line === '---') {
				// 条目分隔符
				if (inEntry && currentContent.length > 0) {
					const content = currentContent.join('\n').trim();
					if (content.length > 0) {
						imported++;
					} else {
						skipped++;
					}
				}
				inEntry = false;
				currentContent = [];
			} else if (inEntry && !line.startsWith('**') && !line.startsWith('>')) {
				currentContent.push(line);
			}
		}

		// 处理最后一个条目
		if (inEntry && currentContent.length > 0) {
			const content = currentContent.join('\n').trim();
			if (content.length > 0) {
				imported++;
			} else {
				skipped++;
			}
		}

		if (imported === 0 && skipped === 0) {
			errors.push('No entries found in Markdown');
		}

		return { imported, skipped, errors };
	}

	/**
	 * 导出统计
	 */
	getExportStats(entries: ExportEntry[]): {
		byType: Record<string, number>;
		avgStrength: number;
		totalConcepts: number;
		uniqueFiles: number;
	} {
		const byType: Record<string, number> = {};
		let totalStrength = 0;
		const concepts = new Set<string>();
		const files = new Set<string>();

		for (const entry of entries) {
			byType[entry.type] = (byType[entry.type] ?? 0) + 1;
			totalStrength += entry.strength;

			const entryConcepts = (entry.metadata?.['concepts'] as string[]) ?? [];
			for (const c of entryConcepts) concepts.add(c);

			const entryFiles = (entry.metadata?.['files'] as string[]) ?? [];
			for (const f of entryFiles) files.add(f);
		}

		return {
			byType,
			avgStrength: entries.length > 0 ? totalStrength / entries.length : 0,
			totalConcepts: concepts.size,
			uniqueFiles: files.size,
		};
	}
}
