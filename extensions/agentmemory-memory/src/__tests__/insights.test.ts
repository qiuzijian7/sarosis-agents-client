/*---------------------------------------------------------------------------------------------
 *  Q4/Q6: Routines + Insights 测试
 *  Q4: Routines — register/run/list/runHistory
 *  Q6: Insights — 跨概念簇模式发现
 *--------------------------------------------------------------------------------------------*/
import { describe, it, assert, assertEqual } from './testRunner.js';

// --- Q4: Routines ---

interface RoutineStep { order: number; title: string; description: string; dependsOn: number[]; }
interface Routine {
	id: string; name: string; description: string; steps: RoutineStep[];
	createdAt: number; frozen: boolean; tags: string[];
}

class RoutineManager {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	private routines = new Map<string, Routine>();
	private runHistory = new Map<string, Array<{ id: string; status: string; startedAt: number; completedAt?: number }>>();

	register(name: string, steps: Array<{ title: string; description: string; dependsOn?: number[] }>, tags: string[] = []): Routine {
		const id = `routine-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const r: Routine = {
			id, name, description: `Routine: ${name}`, steps: steps.map((s, i) => ({
				order: i + 1, title: s.title, description: s.description, dependsOn: s.dependsOn ?? [],
			})), createdAt: Date.now(), frozen: false, tags,
		};
		this.routines.set(id, r);
		return r;
	}

	list(frozen?: boolean): Routine[] {
		let all = Array.from(this.routines.values());
		if (frozen !== undefined) all = all.filter(r => r.frozen === frozen);
		return all.sort((a, b) => b.createdAt - a.createdAt);
	}

	get(id: string): Routine | undefined { return this.routines.get(id); }

	run(routineId: string): { runId: string; status: string } | null {
		const r = this.routines.get(routineId);
		if (!r) return null;
		const runId = `run-${Date.now()}`;
		const entry: { id: string; status: string; startedAt: number; completedAt?: number } = { id: runId, status: 'running', startedAt: Date.now() };
		if (!this.runHistory.has(routineId)) this.runHistory.set(routineId, []);
		this.runHistory.get(routineId)!.push(entry);
		// 立即完成
		entry.status = 'completed';
		entry.completedAt = Date.now();
		return { runId, status: 'completed' };
	}

	getRunHistory(routineId: string): Array<{ id: string; status: string; startedAt: number; completedAt?: number }> {
		return this.runHistory.get(routineId) ?? [];
	}
}

// --- Q6: Insights ---

/** 跨概念簇的 pattern 类型 */
interface Insight {
	id: string;
	type: 'cross_pattern' | 'knowledge_gap' | 'refactor_opportunity';
	description: string;
	concepts: string[];
	confidence: number;
	createdAt: number;
}

class InsightGenerator {
	private insights = new Map<string, Insight[]>();

	/**
	 * 从多概念簇中发现跨模式
	 * 对齐 agentmemory generateInsights
	 */
	generate(agentId: string, concepts: Array<{ concept: string; frequency: number }>, memories: Array<{ content: string }>): Insight[] {
		const results: Insight[] = [];

		// cross_pattern: 高频率共现的概念
		if (concepts.length >= 3) {
			const top = concepts.sort((a, b) => b.frequency - a.frequency).slice(0, 5);
			results.push({
				id: `insight-${Date.now()}`,
				type: 'cross_pattern',
				description: `High-frequency concepts cluster: ${top.map(c => c.concept).join(', ')}`,
				concepts: top.map(c => c.concept),
				confidence: Math.min(0.9, top[0].frequency / 20),
				createdAt: Date.now(),
			});
		}

		// knowledge_gap: 提到了但缺少详细内容的领域
		const mentionPattern = /need to learn|should explore|not sure about|need more info on/i;
		const gaps = memories.filter(m => mentionPattern.test(m.content));
		if (gaps.length > 0) {
			results.push({
				id: `insight-${Date.now() + 1}`,
				type: 'knowledge_gap',
				description: `${gaps.length} knowledge gaps detected in recent memories`,
				concepts: [],
				confidence: Math.min(0.7, gaps.length / 10),
				createdAt: Date.now(),
			});
		}

		if (!this.insights.has(agentId)) this.insights.set(agentId, []);
		this.insights.get(agentId)!.push(...results);
		return results;
	}

	list(agentId: string): Insight[] {
		return this.insights.get(agentId) ?? [];
	}

	clear(agentId: string): void { this.insights.delete(agentId); }
}

export function runRoutineAndInsightTests(): void {
	describe('RoutineManager (Q4)', () => {
		const rm = new RoutineManager();

		it('registers a new routine', () => {
			const r = rm.register('Deploy Pipeline', [
				{ title: 'Run tests', description: 'Run unit and integration tests' },
				{ title: 'Build', description: 'Build production bundle', dependsOn: [1] },
				{ title: 'Deploy', description: 'Deploy to staging', dependsOn: [2] },
			], ['deployment', 'production']);
			assertEqual(r.name, 'Deploy Pipeline');
			assertEqual(r.steps.length, 3);
			assertEqual(r.tags.length, 2);
		});

		it('list returns routines sorted by createdAt desc', () => {
			rm.register('Backup DB', [{ title: 'Backup', description: 'Backup database' }]);
			const list = rm.list();
			assert(list.length >= 2, 'has routines');
			assert(list[0].createdAt >= list[1].createdAt, 'sorted desc');
		});

		it('runs a routine and records history', () => {
			const r = rm.register('Health Check', [{ title: 'Check', description: 'Check health' }]);
			const result = rm.run(r.id);
			assert(result !== null, 'run returned result');
			assertEqual(result!.status, 'completed');
			const history = rm.getRunHistory(r.id);
			assertEqual(history.length, 1, 'run history recorded');
		});

		it('run returns null for unknown routine', () => {
			assertEqual(rm.run('unknown-id'), null);
		});
	});

	describe('InsightGenerator (Q6)', () => {
		const ig = new InsightGenerator();

		it('generates cross_pattern insight for high-frequency concepts', () => {
			const insights = ig.generate('agent-1', [
				{ concept: 'TypeScript', frequency: 30 },
				{ concept: 'React', frequency: 25 },
				{ concept: 'Webpack', frequency: 20 },
				{ concept: 'ESLint', frequency: 15 },
				{ concept: 'Jest', frequency: 10 },
			], []);
			assert(insights.length >= 1, 'cross_pattern insight generated');
			assertEqual(insights[0].type, 'cross_pattern');
		});

		it('generates knowledge_gap insight for missing knowledge', () => {
			const insights = ig.generate('agent-1',
				[{ concept: 'Rust', frequency: 5 }],
				[{ content: 'need to learn more about WebAssembly integration' }]
			);
			const gap = insights.find(i => i.type === 'knowledge_gap');
			assert(gap !== undefined, 'knowledge_gap insight found');
		});

		it('list returns insights for an agent', () => {
			ig.generate('agent-2', [{ concept: 'Go', frequency: 10 }, { concept: 'Docker', frequency: 8 }, { concept: 'K8s', frequency: 6 }], []);
			const list = ig.list('agent-2');
			assert(list.length >= 1, 'insights listed');
		});
	});
}
