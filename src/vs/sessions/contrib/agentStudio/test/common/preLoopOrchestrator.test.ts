import assert from 'assert';
import { preLoopOrchestrate, formatCurrentTaskReminder, formatExplorationFindings } from '../../common/preLoopOrchestrator.js';
import type { ParsedPlanTask, PreLoopAssessment } from '../../common/preLoopOrchestrator.js';

// 辅助：构造一个"无需探索、直接给计划"的 assessment
const noExplore = (planTasks: ParsedPlanTask[] = [], reason = 'simple'): PreLoopAssessment => ({
	needsExploration: false,
	explorationAreas: [],
	planTasks,
	reason,
});

// 辅助：构造一个"需探索"的 assessment
const needsExplore = (areas: string[], reason = 'complex'): PreLoopAssessment => ({
	needsExploration: true,
	explorationAreas: areas,
	planTasks: [],
	reason,
});

describe('preLoopOrchestrator — LLM 自主判断编排', () => {
	it('LLM 判定无需探索 + 直接给计划 → 短路返回计划', async () => {
		const tasks: ParsedPlanTask[] = [{ title: '改个名', description: 'rename fn' }];
		const r = await preLoopOrchestrate('把 foo 改名为 bar', {
			assessFn: async () => noExplore(tasks, 'trivial rename'),
		});
		assert.strictEqual(r.planTasks.length, 1);
		assert.strictEqual(r.findings, undefined);
		assert.strictEqual(r.assessment.needsExploration, false);
	});

	it('LLM 判定无需探索 + 空计划 → 直接进原 loop', async () => {
		const r = await preLoopOrchestrate('什么是 Promise', {
			assessFn: async () => noExplore([], 'simple question'),
		});
		assert.strictEqual(r.planTasks.length, 0);
		assert.strictEqual(r.findings, undefined);
	});

	it('LLM 判定需探索 → 探索 + 生成计划', async () => {
		let exploreCalled = false;
		let planCalled = false;
		const r = await preLoopOrchestrate('重构整个认证模块并优化性能', {
			assessFn: async () => needsExplore(['认证模块架构', '性能瓶颈'], 'complex refactor'),
			exploreFn: async (areas, goal) => {
				exploreCalled = true;
				assert.strictEqual(areas.length, 2);
				assert.ok(goal.length > 0);
				return { findings: '## 发现\n- 认证在 src/auth', successCount: 2, failCount: 0 };
			},
			planGenerator: async (msg, findings) => {
				planCalled = true;
				assert.ok(findings && findings.includes('src/auth'));
				return [
					{ title: '分析架构', description: '读 src/auth', complexity: 'medium' },
					{ title: '重构认证', description: '改 token', complexity: 'high' },
				];
			},
		});
		assert.strictEqual(exploreCalled, true);
		assert.strictEqual(planCalled, true);
		assert.strictEqual(r.planTasks.length, 2);
		assert.ok(r.findings && r.findings.includes('src/auth'));
		assert.strictEqual(r.assessment.needsExploration, true);
	});

	it('LLM 判定需探索但无 exploreFn → 用 assessment 计划（空）降级', async () => {
		const r = await preLoopOrchestrate('复杂任务', {
			assessFn: async () => needsExplore(['area1']),
		});
		assert.strictEqual(r.findings, undefined);
		assert.strictEqual(r.planTasks.length, 0);
	});

	it('LLM 判定需探索 + 有初步计划 + 无 planGenerator → 用初步计划', async () => {
		const initial: ParsedPlanTask[] = [{ title: '初步任务' }];
		const r = await preLoopOrchestrate('复杂任务', {
			assessFn: async () => ({ needsExploration: true, explorationAreas: ['a'], planTasks: initial, reason: 'x' }),
			exploreFn: async () => ({ findings: 'findings', successCount: 1, failCount: 0 }),
		});
		assert.strictEqual(r.planTasks.length, 1);
		assert.strictEqual(r.planTasks[0].title, '初步任务');
		assert.ok(r.findings);
	});

	it('探索失败 → 降级仍生成计划（无 findings）', async () => {
		const r = await preLoopOrchestrate('复杂任务', {
			assessFn: async () => needsExplore(['a', 'b']),
			exploreFn: async () => { throw new Error('explore failed'); },
			planGenerator: async (msg, findings) => {
				assert.strictEqual(findings, undefined);
				return [{ title: 'fallback', description: msg.slice(0, 50) }];
			},
		});
		assert.strictEqual(r.findings, undefined);
		assert.strictEqual(r.planTasks.length, 1);
	});

	it('planGenerator 失败 → 用 assessment 初步计划降级', async () => {
		const initial: ParsedPlanTask[] = [{ title: '初步' }];
		const r = await preLoopOrchestrate('复杂任务', {
			assessFn: async () => ({ needsExploration: true, explorationAreas: ['a'], planTasks: initial, reason: 'x' }),
			exploreFn: async () => ({ findings: 'f', successCount: 1, failCount: 0 }),
			planGenerator: async () => { throw new Error('plan failed'); },
		});
		assert.strictEqual(r.planTasks.length, 1);
		assert.strictEqual(r.planTasks[0].title, '初步');
	});

	it('assessFn 失败 → 降级空计划直接进 loop', async () => {
		const r = await preLoopOrchestrate('任何任务', {
			assessFn: async () => { throw new Error('llm down'); },
		});
		assert.strictEqual(r.planTasks.length, 0);
		assert.strictEqual(r.assessment.needsExploration, false);
	});

	it('needsExploration=true 但 areas 空 → 跳过探索用 assessment 计划', async () => {
		const initial: ParsedPlanTask[] = [{ title: 't1' }];
		const r = await preLoopOrchestrate('复杂任务', {
			assessFn: async () => ({ needsExploration: true, explorationAreas: [], planTasks: initial, reason: 'x' }),
			exploreFn: async () => { throw new Error('should not explore empty areas'); },
		});
		assert.strictEqual(r.findings, undefined);
		assert.strictEqual(r.planTasks.length, 1);
		assert.strictEqual(r.planTasks[0].title, 't1');
	});

	it('planGenerator 返回空 → 用空队列降级直接进 loop', async () => {
		const r = await preLoopOrchestrate('复杂任务', {
			assessFn: async () => ({ needsExploration: true, explorationAreas: ['a'], planTasks: [], reason: 'x' }),
			exploreFn: async () => ({ findings: 'f', successCount: 1, failCount: 0 }),
			planGenerator: async () => [],
		});
		assert.strictEqual(r.planTasks.length, 0);
		assert.ok(r.findings);
	});

	it('无 planGenerator + needsExploration=false + planTasks 非空 → 直接用初步计划', async () => {
		const initial: ParsedPlanTask[] = [{ title: '初步1' }, { title: '初步2' }];
		const r = await preLoopOrchestrate('简单任务 LLM 直接给计划', {
			assessFn: async () => ({ needsExploration: false, explorationAreas: [], planTasks: initial, reason: 'llm gives plan directly' }),
		});
		assert.strictEqual(r.planTasks.length, 2);
		assert.strictEqual(r.findings, undefined);
	});
});

describe('formatExplorationFindings — 探索结果格式化', () => {
	it('包含 EXPLORATION FINDINGS 标题与 findings 内容', () => {
		const r = formatExplorationFindings('## 认证模块\n位于 src/auth');
		assert.ok(r.includes('EXPLORATION FINDINGS'));
		assert.ok(r.includes('## 认证模块'));
		assert.ok(r.includes('system-reminder'));
	});

	it('空 findings 仍生成结构', () => {
		const r = formatExplorationFindings('');
		assert.ok(r.includes('EXPLORATION FINDINGS'));
		assert.ok(r.includes('system-reminder'));
	});
});

describe('formatCurrentTaskReminder — 任务提醒格式化', () => {
	it('包含任务序号与标题', () => {
		const task: ParsedPlanTask = { title: '实现登录', description: '写登录逻辑' };
		const r = formatCurrentTaskReminder(task, 0, 3);
		assert.ok(r.includes('(1/3)'));
		assert.ok(r.includes('实现登录'));
		assert.ok(r.includes('task 1 of 3'));
		assert.ok(r.includes('task 2/3'));
	});

	it('包含文件与 deliverable', () => {
		const task: ParsedPlanTask = { title: 'T', files: ['a.ts', 'b.ts'], deliverable: 'PR' };
		const r = formatCurrentTaskReminder(task, 2, 5);
		assert.ok(r.includes('a.ts'));
		assert.ok(r.includes('Deliverable: PR'));
		assert.ok(r.includes('(3/5)'));
	});
});
