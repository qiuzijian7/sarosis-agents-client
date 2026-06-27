/*---------------------------------------------------------------------------------------------
 *  Obsidian Vault 导出 — 将记忆导出为 Obsidian 兼容的 Markdown 文件。
 *  1:1 复刻 agentmemory src/functions/obsidian-export.ts
 *
 *  导出结构：
 *    vault/
 *      MOC.md           — Map of Content（索引页）
 *      memories/*.md    — 长期记忆（带 frontmatter + 双链）
 *      lessons/*.md     — 经验教训
 *      crystals/*.md    — 结晶化行动链
 *      sessions/*.md    — 会话记录
 *
 *  每个文件包含 YAML frontmatter + 正文 + Obsidian 双链 [[id]]。
 *--------------------------------------------------------------------------------------------*/

import type { Lesson } from './lessons.js';
import type { Crystal } from './crystallize.js';

interface ExportMemory {
	id: string;
	type: string;
	title?: string;
	content?: string;
	concepts?: string[];
	files?: string[];
	relatedIds?: string[];
	supersedes?: string[];
	createdAt?: string;
	updatedAt?: string;
	strength?: number;
	version?: number;
	isLatest?: boolean;
}

interface ExportSession {
	id: string;
	project?: string;
	status?: string;
	startedAt?: string;
	endedAt?: string;
	observationCount?: number;
	cwd?: string;
}

export interface ObsidianExportOptions {
	vaultDir?: string;
	types?: string[];
}

export interface ObsidianExportResult {
	success: boolean;
	exported: { memories: number; lessons: number; crystals: number; sessions: number };
	errors?: Array<{ id: string; error: string }>;
	vaultDir?: string;
}

function sanitize(name: string): string {
	return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);
}

function safeArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function safeString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function safeTimestamp(value: unknown): number {
	if (typeof value !== 'string') return 0;
	const time = new Date(value).getTime();
	return Number.isFinite(time) ? time : 0;
}

function toFrontmatter(obj: Record<string, unknown>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			lines.push(`${key}: [${value.map(v => JSON.stringify(String(v))).join(', ')}]`);
		} else {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		}
	}
	lines.push('---');
	return lines.join('\n');
}

function memoryToMd(m: ExportMemory): string {
	const concepts = safeArray<string>(m.concepts);
	const files = safeArray<string>(m.files);
	const relatedIds = safeArray<string>(m.relatedIds);
	const supersedes = safeArray<string>(m.supersedes);
	const title = safeString(m.title, m.id);

	const fm = toFrontmatter({
		id: m.id,
		type: m.type,
		created: m.createdAt,
		updated: m.updatedAt,
		strength: m.strength,
		version: m.version,
		concepts,
		files,
	});

	const relatedLines = relatedIds.map(id => `- [[${id}]]`).join('\n');
	const supersedesLines = supersedes.map(id => `- [[${id}]] (superseded)`).join('\n');

	const sections = [
		fm, '',
		`# ${title}`, '',
		safeString(m.content),
	];

	if (concepts.length > 0) {
		sections.push('', '## Concepts', concepts.map(c => `#${c.replace(/\s+/g, '-')}`).join(' '));
	}
	if (relatedLines) {
		sections.push('', '## Related', relatedLines);
	}
	if (supersedesLines) {
		sections.push('', '## Supersedes', supersedesLines);
	}

	return sections.join('\n');
}

function lessonToMd(l: Lesson): string {
	const tags = safeArray<string>(l.tags);
	const sourceIds = safeArray<string>((l as any).sourceIds);
	const content = safeString(l.content);
	const headline = content ? content.slice(0, 80) : l.id;

	const fm = toFrontmatter({
		id: l.id,
		type: 'lesson',
		source: (l as any).source,
		confidence: (l as any).confidence,
		reinforcements: (l as any).reinforcements,
		created: l.createdAt,
		updated: l.updatedAt,
		project: (l as any).project,
		tags,
		decayRate: (l as any).decayRate,
	});

	const sourceLinks = sourceIds.map(id => `- [[${id}]]`).join('\n');

	const sections = [
		fm, '',
		`# Lesson: ${headline}`, '',
		content,
	];

	if ((l as any).context) {
		sections.push('', '## Context', (l as any).context);
	}
	if (tags.length > 0) {
		sections.push('', '## Tags', tags.map(t => `#${t.replace(/\s+/g, '-')}`).join(' '));
	}
	if (sourceLinks) {
		sections.push('', '## Sources', sourceLinks);
	}

	return sections.join('\n');
}

function crystalToMd(c: Crystal): string {
	const keyOutcomes = safeArray<string>(c.keyOutcomes);
	const lessons = safeArray<string>(c.lessons);
	const filesAffected = safeArray<string>(c.filesAffected);
	const sourceActionIds = safeArray<string>(c.sourceActionIds);
	const narrative = safeString(c.narrative);
	const headline = narrative ? narrative.slice(0, 80) : c.id;

	const fm = toFrontmatter({
		id: c.id,
		type: 'crystal',
		created: c.createdAt,
		project: (c as any).project,
		sessionId: (c as any).sessionId,
		filesAffected,
	});

	const actionLinks = sourceActionIds.map(id => `- [[${id}]]`).join('\n');

	const sections = [
		fm, '',
		`# Crystal: ${headline}`, '',
		narrative, '',
		'## Key Outcomes',
		...keyOutcomes.map(o => `- ${o}`),
	];

	if (lessons.length > 0) {
		sections.push('', '## Lessons', ...lessons.map(l => `- ${l}`));
	}
	if (filesAffected.length > 0) {
		sections.push('', '## Files', ...filesAffected.map(f => `- \`${f}\``));
	}
	if (actionLinks) {
		sections.push('', '## Source Actions', actionLinks);
	}

	return sections.join('\n');
}

function sessionToMd(s: ExportSession): string {
	const project = safeString(s.project, 'unknown');
	const status = safeString(s.status, 'unknown');
	const startedAt = safeString(s.startedAt, '');
	const cwd = safeString(s.cwd, '');

	const fm = toFrontmatter({
		id: s.id,
		type: 'session',
		project,
		status,
		started: startedAt || undefined,
		ended: s.endedAt,
		observations: s.observationCount,
	});

	return [
		fm, '',
		`# Session: ${project}`, '',
		`**Status:** ${status}`,
		startedAt ? `**Started:** ${startedAt}` : '',
		s.endedAt ? `**Ended:** ${s.endedAt}` : '',
		`**Observations:** ${s.observationCount ?? 0}`,
		cwd ? `**CWD:** \`${cwd}\`` : '',
	].filter(Boolean).join('\n');
}

export interface ObsidianExportDataSources {
	memories?: ExportMemory[];
	lessons?: Lesson[];
	crystals?: Crystal[];
	sessions?: ExportSession[];
}

/**
 * 导出记忆到 Obsidian vault 目录结构
 * 返回 Markdown 文件内容映射（文件路径 → 内容），由调用者负责写入磁盘。
 */
export function exportToObsidian(
	dataSources: ObsidianExportDataSources,
	_types?: string[],
): { files: Array<{ path: string; content: string }>; stats: { memories: number; lessons: number; crystals: number; sessions: number }; errors: Array<{ id: string; error: string }> } {
	const exportTypes = new Set(_types ?? ['memories', 'lessons', 'crystals', 'sessions']);
	const files: Array<{ path: string; content: string }> = [];
	const errors: Array<{ id: string; error: string }> = [];
	const stats = { memories: 0, lessons: 0, crystals: 0, sessions: 0 };

	const memoryMoc: string[] = [];
	const lessonMoc: string[] = [];
	const crystalMoc: string[] = [];
	const sessionMoc: string[] = [];

	// Memories
	if (exportTypes.has('memories') && dataSources.memories) {
		for (const m of dataSources.memories.filter(m => m.isLatest !== false)) {
			try {
				const filename = `${sanitize(m.id)}.md`;
				files.push({ path: `memories/${filename}`, content: memoryToMd(m) });
				stats.memories++;
				memoryMoc.push(`- [[memories/${sanitize(m.id)}|${safeString(m.title, m.id)}]] (${m.type}, strength: ${m.strength ?? 0})`);
			} catch (err) {
				errors.push({ id: m.id, error: err instanceof Error ? err.message : String(err) });
			}
		}
	}

	// Lessons
	if (exportTypes.has('lessons') && dataSources.lessons) {
		for (const l of dataSources.lessons.filter(l => !(l as any).deleted)) {
			try {
				const filename = `${sanitize(l.id)}.md`;
				files.push({ path: `lessons/${filename}`, content: lessonToMd(l) });
				stats.lessons++;
				const headline = safeString(l.content).slice(0, 60) || l.id;
				lessonMoc.push(`- [[lessons/${sanitize(l.id)}|${headline}]] (confidence: ${(l as any).confidence ?? 0})`);
			} catch (err) {
				errors.push({ id: l.id, error: err instanceof Error ? err.message : String(err) });
			}
		}
	}

	// Crystals
	if (exportTypes.has('crystals') && dataSources.crystals) {
		for (const c of dataSources.crystals) {
			try {
				const filename = `${sanitize(c.id)}.md`;
				files.push({ path: `crystals/${filename}`, content: crystalToMd(c) });
				stats.crystals++;
				const headline = safeString(c.narrative).slice(0, 60) || c.id;
				crystalMoc.push(`- [[crystals/${sanitize(c.id)}|${headline}]]`);
			} catch (err) {
				errors.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
			}
		}
	}

	// Sessions (recent 50)
	if (exportTypes.has('sessions') && dataSources.sessions) {
		const recent = dataSources.sessions
			.sort((a, b) => safeTimestamp(b.startedAt) - safeTimestamp(a.startedAt))
			.slice(0, 50);
		for (const s of recent) {
			try {
				const filename = `${sanitize(s.id)}.md`;
				files.push({ path: `sessions/${filename}`, content: sessionToMd(s) });
				stats.sessions++;
				sessionMoc.push(`- [[sessions/${sanitize(s.id)}|${safeString(s.project, 'unknown')} (${safeString(s.status, 'unknown')})]]`);
			} catch (err) {
				errors.push({ id: s.id, error: err instanceof Error ? err.message : String(err) });
			}
		}
	}

	// MOC (Map of Content)
	const exportedAt = new Date().toISOString();
	const moc = [
		'---', 'type: moc', `exported: ${exportedAt}`, '---', '',
		'# agentmemory vault', '',
		`Exported: ${exportedAt}`, '',
		`## Memories (${stats.memories})`, ...memoryMoc, '',
		`## Lessons (${stats.lessons})`, ...lessonMoc, '',
		`## Crystals (${stats.crystals})`, ...crystalMoc, '',
		`## Sessions (${stats.sessions})`, ...sessionMoc,
	].join('\n');
	files.push({ path: 'MOC.md', content: moc });

	return { files, stats, errors };
}
