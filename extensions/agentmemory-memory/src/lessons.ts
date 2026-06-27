/*---------------------------------------------------------------------------------------------
 *  课程学习 — 从记忆中提取教训，带衰减和强化。
 *  参考 agentmemory src/functions/lessons.ts
 *
 *  规则：
 *    - 从长期记忆中提取 "lesson" 类型的条目
 *    - 教训有自己的衰减周期（独立于记忆强度）
 *    - 频繁访问的教训被强化（reinforcements++）
 *    - 低置信度教训自动衰减
 *--------------------------------------------------------------------------------------------*/

export interface Lesson {
	id: string;
	content: string;
	context: string;
	confidence: number;
	reinforcements: number;
	source: 'manual' | 'consolidation' | 'error_pattern';
	sourceIds: string[];
	tags: string[];
	createdAt: string;
	updatedAt: string;
	lastReinforcedAt?: string;
	lastDecayedAt?: string;
	decayRate: number;
	deleted?: boolean;
}

const LESSON_DECAY_DAYS = 60;
const LESSON_DECAY_FACTOR = 0.95;
const LESSON_MIN_CONFIDENCE = 0.2;

// Patterns that indicate a lesson-worthy statement
const LESSON_PATTERNS = [
	/\b(?:should|must|always|never|remember to|don't forget|important to|make sure)\b/gi,
	/\b(?:lesson learned|takeaway|key point|note that|be careful)\b/gi,
	/\b(?:avoid|prevent|ensure|guarantee)\b/gi,
];

const ERROR_PATTERN_RE = /(?:error|fail|exception|crash|bug)[:\s]+([^\n.]{10,120})/gi;

interface InternalEntry {
	id: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

export class LessonExtractor {
	private _lessons = new Map<string, Lesson[]>();
	private _lastExtracted = new Map<string, number>();

	/**
	 * Extract lessons from long-term memory entries.
	 * Only runs if not extracted in the last 24 hours (throttle).
	 */
	extract(agentId: string, entries: InternalEntry[]): Lesson[] {
		const lastRun = this._lastExtracted.get(agentId) ?? 0;
		const now = Date.now();
		if (now - lastRun < 24 * 60 * 60 * 1000) {
			return this._lessons.get(agentId) ?? [];
		}
		this._lastExtracted.set(agentId, now);

		const existing = this._lessons.get(agentId) ?? [];
		const existingContents = new Set(existing.map(l => l.content.toLowerCase()));
		const newLessons: Lesson[] = [];

		for (const entry of entries) {
			if (entry.metadata?.['supersededBy']) continue;

			// Check for lesson patterns
			for (const pattern of LESSON_PATTERNS) {
				const matches = [...entry.content.matchAll(pattern)];
				if (matches.length > 0) {
					// Extract the sentence containing the pattern
					const sentences = entry.content.split(/[.\n]/);
					for (const s of sentences) {
						if (pattern.test(s) && s.trim().length > 15 && s.trim().length < 200) {
							const content = s.trim();
							if (!existingContents.has(content.toLowerCase())) {
								existingContents.add(content.toLowerCase());
								newLessons.push({
									id: `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
									content,
									context: entry.content.slice(0, 200),
									confidence: 0.6,
									reinforcements: 1,
									source: 'consolidation',
									sourceIds: [entry.id],
									tags: ['auto-extracted'],
									createdAt: new Date().toISOString(),
									updatedAt: new Date().toISOString(),
									decayRate: LESSON_DECAY_FACTOR,
								});
							}
						}
					}
				}
			}

			// Extract error patterns as lessons
			for (const match of entry.content.matchAll(ERROR_PATTERN_RE)) {
				const errorText = `Avoid: ${match[1].trim()}`;
				if (!existingContents.has(errorText.toLowerCase())) {
					existingContents.add(errorText.toLowerCase());
					newLessons.push({
						id: `lesson-err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						content: errorText,
						context: entry.content.slice(0, 200),
						confidence: 0.7,
						reinforcements: 1,
						source: 'error_pattern',
						sourceIds: [entry.id],
						tags: ['error', 'auto-extracted'],
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						decayRate: LESSON_DECAY_FACTOR,
					});
				}
			}
		}

		// Merge with existing
		const all = [...existing, ...newLessons];

		// Apply decay
		this._applyDecay(all);

		// Remove low-confidence lessons
		const filtered = all.filter(l => !l.deleted && l.confidence >= LESSON_MIN_CONFIDENCE);

		this._lessons.set(agentId, filtered);
		return filtered;
	}

	/** Apply Ebbinghaus decay to lessons */
	private _applyDecay(lessons: Lesson[]): void {
		const now = Date.now();
		for (const lesson of lessons) {
			const lastAccess = lesson.lastReinforcedAt ?? lesson.createdAt;
			const daysSince = (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
			if (daysSince > LESSON_DECAY_DAYS) {
				const periods = Math.floor(daysSince / LESSON_DECAY_DAYS);
				lesson.confidence = Math.max(LESSON_MIN_CONFIDENCE, lesson.confidence * Math.pow(lesson.decayRate, periods));
				lesson.lastDecayedAt = new Date().toISOString();
			}
		}
	}

	/** Reinforce a lesson (called when a lesson is accessed/relevant) */
	reinforce(agentId: string, lessonId: string): void {
		const lessons = this._lessons.get(agentId);
		if (!lessons) return;
		const lesson = lessons.find(l => l.id === lessonId);
		if (lesson) {
			lesson.reinforcements++;
			lesson.confidence = Math.min(1, lesson.confidence + 0.05);
			lesson.lastReinforcedAt = new Date().toISOString();
			lesson.updatedAt = new Date().toISOString();
		}
	}

	/** Get all active lessons for an agent */
	getLessons(agentId: string): Lesson[] {
		return this._lessons.get(agentId) ?? [];
	}

	/** Get top lessons by confidence */
	getTopLessons(agentId: string, limit: number = 10): Lesson[] {
		const lessons = this._lessons.get(agentId) ?? [];
		return [...lessons]
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, limit);
	}

	/** Search lessons by keyword */
	search(agentId: string, query: string, limit: number = 10): Lesson[] {
		const lessons = this._lessons.get(agentId) ?? [];
		const lower = query.toLowerCase();
		return lessons
			.filter(l => l.content.toLowerCase().includes(lower) || l.context.toLowerCase().includes(lower))
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, limit);
	}

	/** Manually add a lesson */
	add(agentId: string, content: string, context: string = '', tags: string[] = []): Lesson {
		const lessons = this._lessons.get(agentId) ?? [];
		const lesson: Lesson = {
			id: `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			content,
			context,
			confidence: 0.8,
			reinforcements: 1,
			source: 'manual',
			sourceIds: [],
			tags,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			decayRate: LESSON_DECAY_FACTOR,
		};
		lessons.push(lesson);
		this._lessons.set(agentId, lessons);
		return lesson;
	}

	/** Delete a lesson */
	delete(agentId: string, lessonId: string): void {
		const lessons = this._lessons.get(agentId);
		if (!lessons) return;
		const lesson = lessons.find(l => l.id === lessonId);
		if (lesson) {
			lesson.deleted = true;
			lesson.updatedAt = new Date().toISOString();
		}
	}

	clear(agentId: string): void {
		this._lessons.delete(agentId);
		this._lastExtracted.delete(agentId);
	}

	get count(): number {
		let total = 0;
		for (const lessons of this._lessons.values()) {
			total += lessons.filter(l => !l.deleted).length;
		}
		return total;
	}
}
