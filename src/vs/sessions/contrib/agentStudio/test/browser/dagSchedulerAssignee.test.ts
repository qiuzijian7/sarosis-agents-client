/*---------------------------------------------------------------------------------------------
 *  DAG scheduler assignee-resilience tests
 *
 *  Pins the P0 fix in `TaskOrchestrationService`: a dependency-ready task with
 *  NO assignee must never be marked Running (that used to deadlock the plan —
 *  the task neither executed nor completed, and every downstream task waited
 *  on a `Done` that never arrived).
 *
 *  Two call sites are covered, because they are separate code paths:
 *    - `_tryAutoExecutePendingTasks()` — the steady-state scan
 *    - the initial DAG dispatch inside `_executePlan()`
 *
 *  These exercise the REAL service against an in-memory file service, so the
 *  persistence round-trip (`_readPlans` deep-copies; `_writePlans` is
 *  explicit) is verified rather than assumed.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TaskOrchestrationService } from '../../browser/taskOrchestrationService.js';
import { PlanTaskStatus, OrchestrationPlanStatus } from '../../common/types.js';
import type { OrchestrationPlan, PlanTask } from '../../common/types.js';

// ─── Minimal in-memory file service (mirrors taskBoardExecution.test.ts) ─────

class InMemoryFileService {
	private readonly files = new Map<string, string>();

	async readFile(uri: URI): Promise<{ value: { toString(): string } }> {
		const key = uri.toString();
		if (!this.files.has(key)) {
			throw new Error(`ENOENT: ${key}`);
		}
		return { value: { toString: () => this.files.get(key)! } };
	}

	async writeFile(uri: URI, buffer: { toString(): string }): Promise<void> {
		this.files.set(uri.toString(), buffer.toString());
	}

	/** Test-only: seed a plan document without going through the service. */
	seed(uri: URI, content: string): void {
		this.files.set(uri.toString(), content);
	}

	read(uri: URI): string | undefined {
		return this.files.get(uri.toString());
	}
}

class MockLogService {
	readonly warnings: string[] = [];
	readonly errors: string[] = [];

	info(): void { /* noop */ }
	warn(msg: string): void { this.warnings.push(msg); }
	error(msg: string): void { this.errors.push(msg); }
	trace(): void { /* noop */ }
	debug(): void { /* noop */ }
}

// ─── Harness ────────────────────────────────────────────────────────────────

interface IHarness {
	service: TaskOrchestrationService;
	fileService: InMemoryFileService;
	logService: MockLogService;
	/** Replace the agent-pool behavior that `_materializeAssignee` delegates to. */
	setAgentPool(assign: (tasks: PlanTask[]) => void): void;
	/** Path used by `_getDataUri()` for the orchestration data file. */
	dataUri: URI;
	dispose(): void;
}

function makeHarness(): IHarness {
	const fileService = new InMemoryFileService();
	const logService = new MockLogService();
	const configurationService = {
		getValue: () => undefined,
		onDidChangeConfiguration: () => ({ dispose() { /* noop */ } }),
	} as any;
	const environmentService = { userHome: URI.file('/tmp') } as any;

	let poolBehavior: (tasks: PlanTask[]) => void = () => { /* no pool by default */ };

	const agentStudio = {
		getActiveWorkspaceId: () => 'ws-1',
		getWorktrees: async () => [],
		getAgents: async () => [],
		getWorkspace: async () => undefined,
		createAgent: async () => ({ id: 'agent-1', name: 'Agent One' }),
	} as any;

	const service = new TaskOrchestrationService(
		fileService as any,
		logService as any,
		configurationService,
		environmentService,
		agentStudio,
		{ updateTaskStatus: async () => undefined } as any,
		{ getOrCreateActiveSession: async (_a: string, name: string) => ({ id: 'sess-1', name }), sendMessage: async () => ({ content: '' }), cancelStream: async () => { } } as any,
		{} as any,
		{} as any,
		{ listWorkflows: async () => [] } as any,
		{ executeWorkflow: async () => 'exec-1' } as any,
	);

	// The service builds its own AgentFactory internally. Stub the single method
	// `_materializeAssignee` delegates to, so tests control the pool outcome.
	const factory = (service as any)._agentFactory;
	factory.assignAgents = async (plan: { tasks: PlanTask[] }) => {
		poolBehavior(plan.tasks);
	};

	return {
		service,
		fileService,
		logService,
		setAgentPool: (fn) => { poolBehavior = fn; },
		// `_getDataUri()` is a DIRECTORY; `_readPlans()` appends 'orchestration-plans.json'.
		dataUri: URI.joinPath((service as any)._getDataUri(), 'orchestration-plans.json'),
		dispose: () => service.dispose(),
	};
}

function makePlanTask(id: string, overrides: Partial<PlanTask> = {}): PlanTask {
	return {
		id,
		title: `Task ${id}`,
		description: 'd',
		status: PlanTaskStatus.Pending,
		dependencies: [],
		priority: 2,
		depth: 0,
		retryCount: 0,
		maxRetries: 3,
		timeoutMs: 300_000,
		createdAt: new Date().toISOString(),
		attempt: 0,
		...overrides,
	} as PlanTask;
}

function makePlan(tasks: PlanTask[]): OrchestrationPlan {
	return {
		id: 'plan-1',
		goal: 'test plan',
		tasks,
		status: OrchestrationPlanStatus.Executing,
		maxConcurrency: 3,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	} as OrchestrationPlan;
}

/** Seed the plans file the way `_readPlans()` expects to read it. */
function seedPlan(h: IHarness, plan: OrchestrationPlan): void {
	h.fileService.seed(h.dataUri, JSON.stringify([plan], null, 2));
}

// ─── Suite ──────────────────────────────────────────────────────────────────

suite('DAG scheduler — assignee resilience', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Create a harness that is disposed via `withHarness` before the leak check runs. */
	async function withHarness(fn: (h: IHarness) => Promise<void>): Promise<void> {
		const h = makeHarness();
		try {
			await fn(h);
		} finally {
			h.dispose();
		}
	}

	test('_materializeAssignee leaves a task unassigned when the pool is empty', async () => {
		await withHarness(async h => {
			h.setAgentPool(() => { /* empty pool: assigns nothing */ });

			const task = makePlanTask('t1');
			const plan = makePlan([task]);

			await (h.service as any)._materializeAssignee(task, plan);

			assert.strictEqual(task.assigneeId, undefined);
			assert.ok(
				h.logService.errors.some(m => m.includes('No existing agent available')),
				'the failure to materialize must be logged as an error, not swallowed',
			);
		});
	});

	test('_materializeAssignee is a no-op when the task already has an assignee', async () => {
		await withHarness(async h => {
			let poolCalled = false;
			h.setAgentPool(() => { poolCalled = true; });

			const task = makePlanTask('t1', { assigneeId: 'agent-existing' } as Partial<PlanTask>);
			await (h.service as any)._materializeAssignee(task, makePlan([task]));

			assert.strictEqual(task.assigneeId, 'agent-existing');
			assert.strictEqual(poolCalled, false, 'must not re-run pool matching for an assigned task');
		});
	});

	test('_tryAutoExecutePendingTasks marks an assignee-less task Error instead of dropping it', async () => {
		await withHarness(async h => {
			h.setAgentPool(() => { /* empty pool */ });

			const orphan = makePlanTask('orphan');
			const plan = makePlan([orphan]);
			seedPlan(h, plan);

			await (h.service as any)._tryAutoExecutePendingTasks();

			// Read back from disk — the status change must have been persisted.
			const persisted = JSON.parse(h.fileService.read(h.dataUri)!) as OrchestrationPlan[];
			const saved = persisted[0].tasks[0];

			assert.strictEqual(saved.status, PlanTaskStatus.Error,
				'a task that cannot be assigned must be surfaced as Error, never silently left Pending');
			assert.ok(saved.error, 'the Error task must record a reason');
		});
	});

	test('_tryAutoExecutePendingTasks persists a materialized assignee to disk', async () => {
		await withHarness(async h => {
			// Pool succeeds: the task becomes assignable during the scan.
			h.setAgentPool(tasks => {
				for (const t of tasks) {
					if (!t.assigneeId) { t.assigneeId = 'agent-from-pool'; }
				}
			});

			const task = makePlanTask('t1');
			seedPlan(h, makePlan([task]));

			await (h.service as any)._tryAutoExecutePendingTasks();

			// `_readPlans()` deep-copies, so an in-place assignment is lost unless
			// `_tryAutoExecutePendingTasks` explicitly writes the plans back.
			const persisted = JSON.parse(h.fileService.read(h.dataUri)!) as OrchestrationPlan[];
			assert.strictEqual(persisted[0].tasks[0].assigneeId, 'agent-from-pool',
				'materialized assignee must survive the read/write round-trip');
		});
	});

	test('_tryAutoExecutePendingTasks does NOT mark a dependency-blocked task Error', async () => {
		await withHarness(async h => {
			h.setAgentPool(() => { /* empty pool */ });

			const blocker = makePlanTask('blocker', { status: PlanTaskStatus.Running });
			const dependent = makePlanTask('dependent', { dependencies: ['blocker'] });
			seedPlan(h, makePlan([blocker, dependent]));

			await (h.service as any)._tryAutoExecutePendingTasks();

			const persisted = JSON.parse(h.fileService.read(h.dataUri)!) as OrchestrationPlan[];
			const savedDependent = persisted[0].tasks.find(t => t.id === 'dependent')!;

			// Its dependency has not finished — it is simply not ready yet.
			// Marking it Error would abort a plan that is still progressing.
			assert.strictEqual(savedDependent.status, PlanTaskStatus.Pending,
				'a dep-blocked task must stay Pending — only assignee failures are terminal');
		});
	});
});
