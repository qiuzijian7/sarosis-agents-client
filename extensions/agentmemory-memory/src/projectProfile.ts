/*---------------------------------------------------------------------------------------------
 *  项目画像 — 自动生成项目上下文（top concepts/files/conventions）。
 *  参考 agentmemory src/functions/profile.ts
 *
 *  从历史记忆中聚合统计，生成项目级别的智能摘要。
 *--------------------------------------------------------------------------------------------*/

import { PatternDetector, type PatternDetectionResult } from './patternDetector.js';

export interface ProjectProfile {
	project: string;
	updatedAt: string;
	summary: string;
	topConcepts: Array<{ concept: string; frequency: number }>;
	topFiles: Array<{ file: string; frequency: number }>;
	conventions: string[];
	commonErrors: string[];
	recentActivity: string[];
	sessionCount: number;
	totalMemories: number;
}

interface InternalEntry {
	id: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

const CONVENTION_RE = /\b(?:we use|we should|convention is|always|never|must|should|prefer|standard|guideline)\b/gi;
const ERROR_RE = /\b(?:error|fail|exception|crash|bug|issue|problem)[:\s]+([^\n.]{10,80})/gi;

export class ProjectProfileBuilder {
	private _detector = new PatternDetector();

	build(project: string, entries: InternalEntry[]): ProjectProfile {
		const now = new Date().toISOString();
		const activeEntries = entries.filter(e => !e.metadata?.['supersededBy']);

		// Detect patterns
		const patterns = this._detector.detect(activeEntries);

		// Extract conventions
		const conventions = this._extractConventions(activeEntries);

		// Extract common errors
		const commonErrors = this._extractErrors(activeEntries);

		// Recent activity (last 5 entries)
		const recentActivity = [...activeEntries]
			.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
			.slice(0, 5)
			.map(e => e.content.replace(/\s+/g, ' ').slice(0, 100));

		// Generate summary
		const summary = this._generateSummary(project, patterns, conventions);

		return {
			project,
			updatedAt: now,
			summary,
			topConcepts: patterns.topConcepts,
			topFiles: patterns.topFiles,
			conventions,
			commonErrors,
			recentActivity,
			sessionCount: new Set(activeEntries.map(e => e.metadata?.['sessionKey'])).size,
			totalMemories: activeEntries.length,
		};
	}

	private _extractConventions(entries: InternalEntry[]): string[] {
		const conventions = new Set<string>();
		for (const entry of entries) {
			const sentences = entry.content.split(/[.\n]/);
			for (const s of sentences) {
				if (CONVENTION_RE.test(s) && s.trim().length > 10 && s.trim().length < 200) {
					conventions.add(s.trim());
				}
			}
		}
		return Array.from(conventions).slice(0, 10);
	}

	private _extractErrors(entries: InternalEntry[]): string[] {
		const errors = new Set<string>();
		for (const entry of entries) {
			for (const match of entry.content.matchAll(ERROR_RE)) {
				errors.add(match[1].trim());
			}
		}
		return Array.from(errors).slice(0, 10);
	}

	private _generateSummary(project: string, patterns: PatternDetectionResult, conventions: string[]): string {
		const parts: string[] = [];
		parts.push(`Project: ${project} (${patterns.totalAnalyzed} memories analyzed)`);

		if (patterns.topConcepts.length > 0) {
			parts.push(`Key concepts: ${patterns.topConcepts.slice(0, 5).map(c => c.concept).join(', ')}`);
		}
		if (patterns.topFiles.length > 0) {
			parts.push(`Key files: ${patterns.topFiles.slice(0, 3).map(f => f.file).join(', ')}`);
		}
		if (patterns.patterns.length > 0) {
			parts.push(`Recurring patterns: ${patterns.patterns.slice(0, 3).map(p => `${p.concept}(${p.frequency}x)`).join(', ')}`);
		}
		if (conventions.length > 0) {
			parts.push(`Conventions: ${conventions.length} detected`);
		}

		return parts.join('\n');
	}
}
