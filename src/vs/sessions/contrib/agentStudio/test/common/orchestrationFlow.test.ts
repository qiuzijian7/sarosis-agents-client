/*---------------------------------------------------------------------------------------------
 *  Orchestration Flow — full-path regression tests
 *
 *  Covers the end-to-end user-intent flow:
 *      user message → task decomposition → (DAG) → 依次按任务执行 (sequential /
 *      dependency-respecting execution via sub-agents).
 *
 *  Three focused suites:
 *    1. TaskDecomposer        — 任务拆分 (goal → PlanTask[])
 *    2. taskDag               — 拓扑排序 + 就绪队列（"依次按任务执行"的纯逻辑核心）
 *    3. Orchestration Flow    — 集成：decompose → topologicalSort → 顺序调度执行
 *
 *  The pure logic is deterministic (no LLM / network); `_decomposeGoalWithAI`
 *  is the LLM path used by TaskOrchestrationService.createPlan at runtime.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TaskDecomposer } from '../../browser/taskDecomposer.js';
import { topologicalSort, getReadyTasks } from '../../common/taskDag.js';
import { PlanTaskStatus } from '../../common/types.js';
import type { PlanTask } from '../../common/types.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeTask(id: string, deps: string[] = [], opts: Partial<PlanTask> = {}): PlanTask {
	return {
		id,
		title: opts.title ?? id,
		description: opts.description,
		status: opts.status ?? PlanTaskStatus.Pending,
		dependencies: deps,
		assigneeName: opts.assigneeName,
		assigneeRole: opts.assigneeRole,
		autoCreateAgent: opts.autoCreateAgent ?? false,
		priority: opts.priority ?? 2,
		depth: opts.depth ?? 0,
		retryCount: opts.retryCount ?? 0,
		maxRetries: opts.maxRetries ?? 3,
		timeoutMs: opts.timeoutMs ?? 300_000,
		createdAt: opts.createdAt ?? new Date().toISOString(),
	};
}

/** Simulate the orchestration scheduler: repeatedly pick ready tasks, "execute"
 *  (sub-agent) them, mark done, and continue until all tasks are Done.
 *  Records the execution order. Used to prove the flow honors dependencies. */
function runScheduler(tasks: PlanTask[], maxConcurrency: number): string[] {
	// Operate directly on the passed tasks (mutates status to Done) so callers
	// can assert final state. Each test builds fresh task objects.
	const work = tasks;
	const order: string[] = [];
	let guard = 0;
	while (work.some(t => t.status !== PlanTaskStatus.Done)) {
		if (++guard > 10_000) { throw new Error('scheduler loop guard tripped (possible deadlock)'); }
		const ready = getReadyTasks(work, maxConcurrency);
		if (ready.length === 0) { break; } // nothing ready → remaining tasks blocked
		for (const t of ready) {
			// Invariant: every dependency must already be Done.
			const depsDone = t.dependencies.every(depId => {
				const dep = work.find(d => d.id === depId);
				return dep && dep.status === PlanTaskStatus.Done;
			});
			assert.ok(depsDone, `task "${t.id}" started before its dependencies completed`);
			t.status = PlanTaskStatus.Running;
			order.push(t.id); // <-- represents sub-agent execution
			t.status = PlanTaskStatus.Done;
			t.completedAt = new Date().toISOString();
		}
	}
	return order;
}

// ═════════════════════════════════════════════════════════════════════════════
// Suite 1 — TaskDecomposer (任务拆分)
// ═════════════════════════════════════════════════════════════════════════════

suite('Orchestration Flow — TaskDecomposer (任务拆分)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('simple short goal → single task, no dependencies', () => {
		const d = new TaskDecomposer();
		const tasks = d.decomposeGoal('整理一下周报', new Set());
		assert.strictEqual(tasks.length, 1);
		assert.strictEqual(tasks[0].dependencies.length, 0);
		assert.strictEqual(tasks[0].status, PlanTaskStatus.Pending);
		assert.strictEqual(tasks[0].autoCreateAgent, true); // "Worker 1" not a known agent
	});

	test('coding goal → 3 sequential phases (design → implement → test) with chained deps', () => {
		const d = new TaskDecomposer();
		// Multi-part (commas) + coding keyword → not "simple" → coding template.
		const tasks = d.decomposeGoal('实现用户登录功能，实现权限校验，实现会话管理', new Set());
		assert.strictEqual(tasks.length, 3);

		const [design, implement, test] = tasks;
		// Order: 设计与规划 → 实现 → 测试
		assert.match(design.title, /设计|规划/);
		assert.match(implement.title, /实现/);
		assert.match(test.title, /测试/);

		// Chained dependencies: implement depends on design, test depends on implement.
		assert.deepStrictEqual(design.dependencies, []);
		assert.strictEqual(implement.dependencies.length, 1);
		assert.strictEqual(implement.dependencies[0], design.id);
		assert.strictEqual(test.dependencies.length, 1);
		assert.strictEqual(test.dependencies[0], implement.id);

		// Priority increases along the chain.
		assert.ok(design.priority < implement.priority);
		assert.ok(implement.priority < test.priority);
	});

	test('research goal → 2 phases (collect → analyze) sequential', () => {
		const d = new TaskDecomposer();
		const tasks = d.decomposeGoal('调研竞品方案，分析功能差异，输出对比报告', new Set());
		assert.strictEqual(tasks.length, 2);
		assert.strictEqual(tasks[1].dependencies[0], tasks[0].id);
	});

	test('deployment goal → 2 phases (build → deploy) sequential', () => {
		const d = new TaskDecomposer();
		const tasks = d.decomposeGoal('部署服务到生产环境，发布新版本，执行回滚预案', new Set());
		assert.strictEqual(tasks.length, 2);
		assert.strictEqual(tasks[1].dependencies[0], tasks[0].id);
	});

	test('generic multi-part goal with "然后" → sequential deps across parts', () => {
		const d = new TaskDecomposer();
		// No coding/testing/research/deployment keyword → delimiter path.
		const tasks = d.decomposeGoal('整理文档，然后发送邮件，最后归档', new Set());
		assert.ok(tasks.length >= 2);
		// Each subsequent part depends on the previous one (hasSequential).
		for (let i = 1; i < tasks.length; i++) {
			assert.strictEqual(tasks[i].dependencies.length, 1);
			assert.strictEqual(tasks[i].dependencies[0], tasks[i - 1].id);
		}
	});

	test('existing agent names → autoCreateAgent=false; unknown → true', () => {
		const d = new TaskDecomposer();
		// Multi-part coding goal → coding template (Designer / Developer / QA Tester).
		const tasks = d.decomposeGoal('实现用户登录功能，实现权限校验，实现会话管理', new Set(['developer'])); // lowercase known
		// Match by assigned agent name (NOT title, which embeds the goal text).
		const developer = tasks.find(t => t.assigneeName === 'Developer')!;
		assert.ok(developer, 'should contain the implementation task');
		assert.strictEqual(developer.autoCreateAgent, false); // "Developer" matched existing
		const designer = tasks.find(t => t.assigneeName === 'Designer')!;
		assert.strictEqual(designer.autoCreateAgent, true); // "Designer" not in set
	});

	test('decomposed tasks form a valid DAG (topological sort succeeds)', () => {
		const d = new TaskDecomposer();
		const tasks = d.decomposeGoal('先调研需求，然后设计架构，最后实现', new Set());
		assert.doesNotThrow(() => topologicalSort(tasks));
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite 2 — taskDag (拓扑排序 + 就绪队列)
// ═════════════════════════════════════════════════════════════════════════════

suite('Orchestration Flow — taskDag (拓扑排序与就绪队列)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('topologicalSort puts dependencies before dependents (diamond A→B,C ; B,C→D)', () => {
		const tasks = [
			makeTask('D', ['B', 'C']),
			makeTask('B', ['A']),
			makeTask('C', ['A']),
			makeTask('A', []),
		];
		const sorted = topologicalSort(tasks);
		const pos = (id: string) => sorted.findIndex(t => t.id === id);
		assert.ok(pos('A') < pos('B'));
		assert.ok(pos('A') < pos('C'));
		assert.ok(pos('B') < pos('D'));
		assert.ok(pos('C') < pos('D'));
	});

	test('topologicalSort computes depth (root=0, children increment)', () => {
		const tasks = [
			makeTask('D', ['B', 'C']),
			makeTask('B', ['A']),
			makeTask('C', ['A']),
			makeTask('A', []),
		];
		topologicalSort(tasks);
		const byId = new Map(tasks.map(t => [t.id, t]));
		assert.strictEqual(byId.get('A')!.depth, 0);
		assert.strictEqual(byId.get('B')!.depth, 1);
		assert.strictEqual(byId.get('C')!.depth, 1);
		assert.strictEqual(byId.get('D')!.depth, 2);
	});

	test('topologicalSort throws on circular dependency', () => {
		const tasks = [
			makeTask('A', ['B']),
			makeTask('B', ['A']),
		];
		assert.throws(() => topologicalSort(tasks), /循环依赖/);
	});

	test('getReadyTasks returns only pending tasks whose deps are Done', () => {
		const tasks = [
			makeTask('A', [], { status: PlanTaskStatus.Done }),
			makeTask('B', ['A'], { status: PlanTaskStatus.Pending }),
			makeTask('C', [], { status: PlanTaskStatus.Pending }),
		];
		const ready = getReadyTasks(tasks, 3);
		const ids = ready.map(t => t.id).sort();
		assert.deepStrictEqual(ids, ['B', 'C']); // A is Done, not Pending
	});

	test('getReadyTasks respects concurrency slots (running reduces capacity)', () => {
		const tasks = [
			makeTask('A', [], { status: PlanTaskStatus.Running }), // occupies 1 slot
			makeTask('B', [], { status: PlanTaskStatus.Pending }),
			makeTask('C', [], { status: PlanTaskStatus.Pending }),
			makeTask('D', [], { status: PlanTaskStatus.Pending }),
		];
		// maxConcurrency=3, 1 running → 2 free slots → only B and C/Pending slice(0,2)
		const ready = getReadyTasks(tasks, 3);
		assert.strictEqual(ready.length, 2);
	});

	test('getReadyTasks returns [] when all slots are occupied by running tasks', () => {
		const tasks = [
			makeTask('A', [], { status: PlanTaskStatus.Running }),
			makeTask('B', [], { status: PlanTaskStatus.Running }),
			makeTask('C', [], { status: PlanTaskStatus.Running }),
			makeTask('D', [], { status: PlanTaskStatus.Pending }),
		];
		const ready = getReadyTasks(tasks, 3);
		assert.strictEqual(ready.length, 0);
	});

	test('getReadyTasks sorts pending tasks by priority (ascending)', () => {
		const tasks = [
			makeTask('low', [], { status: PlanTaskStatus.Pending, priority: 3 }),
			makeTask('high', [], { status: PlanTaskStatus.Pending, priority: 0 }),
			makeTask('mid', [], { status: PlanTaskStatus.Pending, priority: 2 }),
		];
		const ready = getReadyTasks(tasks, 3);
		assert.deepStrictEqual(ready.map(t => t.id), ['high', 'mid', 'low']);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite 3 — Orchestration Flow integration
//   用户消息 → 任务拆分 → 拓扑排序 → 依次按依赖顺序执行 (sub-agent)
// ═════════════════════════════════════════════════════════════════════════════

suite('Orchestration Flow — integration (decompose → topo → 顺序执行)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('coding goal: decomposed tasks execute strictly sequentially respecting deps (concurrency=1)', () => {
		const decomposer = new TaskDecomposer();
		const tasks = decomposer.decomposeGoal('实现用户登录功能，实现权限校验，实现会话管理', new Set());

		// topologicalSort defines the canonical execution order layer.
		const sorted = topologicalSort(tasks);
		assert.strictEqual(sorted.length, tasks.length);

		// Run the scheduler simulating one sub-agent at a time.
		const order = runScheduler(tasks, 1);

		assert.strictEqual(order.length, tasks.length);
		// Every task must run AFTER all of its dependencies.
		const indexOf = new Map(order.map((id, i) => [id, i]));
		for (const t of tasks) {
			for (const depId of t.dependencies) {
				assert.ok(indexOf.get(depId)! < indexOf.get(t.id)!,
					`dependency ${depId} must run before ${t.id}`);
			}
		}
		// Strictly sequential: design → implement → test.
		assert.strictEqual(order[0], tasks[0].id);
		assert.strictEqual(order[order.length - 1], tasks[tasks.length - 1].id);
	});

	test('parallel-allowed goal runs dependency layers but never violates deps (concurrency=3)', () => {
		// Diamond: A → {B, C} → D. Layers: [A], [B,C], [D].
		const tasks = [
			makeTask('D', ['B', 'C']),
			makeTask('B', ['A']),
			makeTask('C', ['A']),
			makeTask('A', []),
		];
		const order = runScheduler(tasks, 3);
		assert.strictEqual(order.length, 4);
		const indexOf = new Map(order.map((id, i) => [id, i]));
		for (const t of tasks) {
			for (const depId of t.dependencies) {
				assert.ok(indexOf.get(depId)! < indexOf.get(t.id)!,
					`dependency ${depId} must run before ${t.id}`);
			}
		}
		// A is always first; D is always last regardless of concurrency.
		assert.strictEqual(order[0], 'A');
		assert.strictEqual(order[order.length - 1], 'D');
	});

	test('full flow: decompose → topo → scheduler completes every task exactly once', () => {
		const decomposer = new TaskDecomposer();
		const goals = [
			'实现一个用户登录功能',
			'调研竞品并输出分析报告',
			'构建打包然后部署发布',
		];
		for (const goal of goals) {
			const tasks = decomposer.decomposeGoal(goal, new Set());
			const sorted = topologicalSort(tasks); // validates DAG
			const order = runScheduler(sorted, 3);
			// All tasks executed, each exactly once.
			assert.strictEqual(order.length, tasks.length);
			assert.strictEqual(new Set(order).size, tasks.length);
			// None left pending/running.
			for (const t of sorted) {
				assert.strictEqual(t.status, PlanTaskStatus.Done);
			}
		}
	});
});
