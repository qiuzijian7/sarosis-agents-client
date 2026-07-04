/*---------------------------------------------------------------------------------------------
 *  LessonExtractor 单元测试 — 教训提取、衰减、强化
 *--------------------------------------------------------------------------------------------*/
import { LessonExtractor } from '../lessons.js';
import { describe, it, assert, assertEqual } from './testRunner.js';

export function runLessonsTests(): void {
describe('LessonExtractor — extract', () => {
	it('extracts lessons with should/must/always patterns', () => {
		const le = new LessonExtractor();
		const entries = [
			{ id: 'e1', content: 'You should always validate input before processing', metadata: {}, timestamp: 1 },
			{ id: 'e2', content: 'We must remember to close database connections', metadata: {}, timestamp: 2 },
		];
		const lessons = le.extract('agent-1', entries);
		assert(lessons.length > 0, `extracted: ${lessons.length}`);
		const should = lessons.find(l => l.content.includes('should always validate'));
		assert(should !== undefined, 'found should pattern');
	});

	it('extracts error patterns as lessons', () => {
		const le = new LessonExtractor();
		const entries = [
			{ id: 'e1', content: 'Error: failed to connect to database timeout exceeded', metadata: {}, timestamp: 1 },
		];
		const lessons = le.extract('agent-2', entries);
		const errorLesson = lessons.find(l => l.content.startsWith('Avoid:'));
		assert(errorLesson !== undefined, 'found error pattern lesson');
		assert(errorLesson!.source === 'error_pattern', 'source is error_pattern');
		assert(errorLesson!.confidence === 0.7, 'confidence 0.7');
	});

	it('dedup: same lesson not extracted twice', () => {
		const le = new LessonExtractor();
		const entries = [
			{ id: 'e1', content: 'You should always test your code', metadata: {}, timestamp: 1 },
		];
		const first = le.extract('agent-3', entries);
		const firstCount = first.length;

		// Second call within 24h returns cached (throttled)
		const second = le.extract('agent-3', entries);
		assertEqual(second.length, firstCount, 'same count (cached)');
	});

	it('skips entries with supersededBy metadata', () => {
		const le = new LessonExtractor();
		const entries = [
			{ id: 'e1', content: 'You should never skip this lesson', metadata: { supersededBy: 'e2' }, timestamp: 1 },
		];
		const lessons = le.extract('agent-4', entries);
		const found = lessons.find(l => l.content.includes('never skip'));
		assert(found === undefined, 'superseded entry skipped');
	});

	it('throttle: skips extraction within 24h', () => {
		const le = new LessonExtractor();
		le.extract('agent-5', [
			{ id: 'e1', content: 'You must check permissions', metadata: {}, timestamp: 1 },
		]);
		// Second extraction within 24h — should return cached results
		const lessons = le.extract('agent-5', [
			{ id: 'e2', content: 'Always log errors to file', metadata: {}, timestamp: 2 },
		]);
		// Should NOT contain the new lesson (throttled)
		const newFound = lessons.find(l => l.content.includes('log errors'));
		assert(newFound === undefined, 'new extraction throttled');
	});
});

describe('LessonExtractor — reinforce', () => {
	it('reinforce increases confidence and reinforcements', () => {
		const le = new LessonExtractor();
		// Use add() directly to avoid regex lastIndex state issues from extract()
		le.add('agent-6', 'You should always use transactions', 'database context');
		const lessons = le.getLessons('agent-6');
		assert(lessons.length > 0, 'has lessons');
		const lesson = lessons[0];
		const beforeConf = lesson.confidence;
		const beforeRein = lesson.reinforcements;

		le.reinforce('agent-6', lesson.id);
		const after = le.getLessons('agent-6').find(l => l.id === lesson.id)!;
		assert(after.reinforcements === beforeRein + 1, `reinforced: ${after.reinforcements}`);
		assert(after.confidence > beforeConf, `confidence increased: ${after.confidence} > ${beforeConf}`);
		assert(after.lastReinforcedAt !== undefined, 'has lastReinforcedAt');
	});

	it('reinforce caps confidence at 1.0', () => {
		const le = new LessonExtractor();
		le.add('agent-7', 'Test lesson', 'ctx');
		const lesson = le.getLessons('agent-7')[0];
		lesson.confidence = 0.99;

		le.reinforce('agent-7', lesson.id);
		const after = le.getLessons('agent-7').find(l => l.id === lesson.id)!;
		assert(after.confidence <= 1.0, `capped at 1.0: ${after.confidence}`);
	});

	it('reinforce on unknown agent is no-op', () => {
		const le = new LessonExtractor();
		le.reinforce('unknown', 'nonexistent');
		// Should not throw
		assert(true, 'no exception');
	});
});

describe('LessonExtractor — manual add/delete', () => {
	it('add creates a manual lesson', () => {
		const le = new LessonExtractor();
		const lesson = le.add('agent-8', 'Always backup before deploy', 'deployment context', ['deploy', 'backup']);
		assertEqual(lesson.source, 'manual', 'source is manual');
		assertEqual(lesson.confidence, 0.8, 'confidence 0.8');
		assertEqual(lesson.tags.length, 2, 'has tags');
		assert(le.getLessons('agent-8').length > 0, 'in list');
	});

	it('delete marks lesson as deleted (soft delete)', () => {
		const le = new LessonExtractor();
		le.add('agent-9', 'Test lesson');
		const lesson = le.getLessons('agent-9')[0];
		le.delete('agent-9', lesson.id);
		const active = le.getLessons('agent-9').filter(l => !l.deleted);
		assert(active.length === 0, 'soft deleted, not in active list');
	});
});

describe('LessonExtractor — search', () => {
	it('search matches content and context', () => {
		const le = new LessonExtractor();
		le.add('agent-10', 'Use transactions for data integrity', 'database context');
		const results = le.search('agent-10', 'transaction');
		assert(results.length > 0, 'found by content');
	});

	it('search returns empty for unknown agent', () => {
		const le = new LessonExtractor();
		const results = le.search('unknown', 'anything');
		assertEqual(results.length, 0, 'empty for unknown');
	});
});

describe('LessonExtractor — getTopLessons', () => {
	it('returns sorted by confidence', () => {
		const le = new LessonExtractor();
		le.add('agent-11', 'Low priority', 'ctx');
		le.add('agent-11', 'High priority', 'ctx');
		le.add('agent-11', 'Medium priority', 'ctx');

		// Manually set different confidences
		const lessons = le.getLessons('agent-11');
		lessons[0].confidence = 0.3;
		lessons[1].confidence = 0.9;
		lessons[2].confidence = 0.6;

		const top = le.getTopLessons('agent-11', 3);
		assert(top[0].confidence >= top[1].confidence, 'sorted desc');
		assert(top[1].confidence >= top[2].confidence, 'sorted desc 2');
	});

	it('respects limit', () => {
		const le = new LessonExtractor();
		for (let i = 0; i < 10; i++) {
			le.add('agent-12', `Lesson ${i}`, 'ctx');
		}
		const top = le.getTopLessons('agent-12', 3);
		assert(top.length <= 3, `respects limit: ${top.length}`);
	});
});

describe('LessonExtractor — count', () => {
	it('count aggregates across agents', () => {
		const le = new LessonExtractor();
		le.add('a1', 'Lesson 1');
		le.add('a2', 'Lesson 2');
		le.add('a3', 'Lesson 3');
		assert(le.count === 3, `count: ${le.count}`);
	});

	it('count excludes deleted', () => {
		const le = new LessonExtractor();
		le.add('a1', 'Lesson 1');
		le.add('a1', 'Lesson 2');
		const lessons = le.getLessons('a1');
		le.delete('a1', lessons[0].id);
		assert(le.count === 1, `count after delete: ${le.count}`);
	});
});

describe('LessonExtractor — clear', () => {
	it('clear removes all lessons for agent', () => {
		const le = new LessonExtractor();
		le.add('agent-clear', 'Lesson 1');
		le.add('agent-clear', 'Lesson 2');
		assert(le.getLessons('agent-clear').length > 0, 'has lessons');
		le.clear('agent-clear');
		assertEqual(le.getLessons('agent-clear').length, 0, 'cleared');
	});
});
}
