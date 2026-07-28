/*---------------------------------------------------------------------------------------------
 *  Tests for the plan_register tool-driven queue registration (方案1):
 *  planQueueRegistry handle lifecycle + the plan_register tool handler
 *  writing an ordered task list into the active turn's execution queue.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { registerPlanQueueHandle, getPlanQueueHandle, type IPlanQueueHandle } from '../../common/planQueueRegistry.js';
import type { ParsedPlanTask } from '../../common/workMode.js';
import { registerCompatibilityTools, type CompatToolContext } from '../../browser/providers/tool/compatibilityTools.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';

/** 模拟 agentTurnExecutor 的队列句柄语义：setPlan 替换队列并把索引重置为 0。 */
function createFakeTurnQueue() {
	const state: { tasks: readonly ParsedPlanTask[]; currentIndex: number } = { tasks: [], currentIndex: -1 };
	const handle: IPlanQueueHandle = {
		setPlan: (tasks) => {
			state.tasks = tasks.map(t => ({ ...t }));
			state.currentIndex = 0;
		},
		getPlan: () => ({ tasks: state.tasks, currentIndex: state.currentIndex }),
	};
	return { state, handle };
}

/** 用 stub ctx 捕获 registerCompatibilityTools 注册的 plan_register 描述符。 */
function capturePlanRegisterTool(): IBuiltinToolRegistration {
	const registrations: IBuiltinToolRegistration[] = [];
	const stubCtx: CompatToolContext = {
		register: (d) => { registrations.push(d); },
		agentOS: {} as CompatToolContext['agentOS'],
		fileService: {} as CompatToolContext['fileService'],
		logService: { info: () => { }, warn: () => { }, error: () => { } } as unknown as CompatToolContext['logService'],
		id: 'test.compat',
		resolveAndCheckWorkspacePath: async (_a, p) => p,
	};
	registerCompatibilityTools(stubCtx);
	const tool = registrations.find(r => r.definition.name === 'plan_register');
	assert.ok(tool, 'plan_register must be registered by registerCompatibilityTools');
	return tool;
}

function resultText(result: unknown): string {
	const arr = result as Array<{ type: string; text?: string }>;
	return arr.map(c => c.text ?? '').join('\n');
}

suite('planQueueRegistry — handle lifecycle', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('register → get returns the handle; unregister removes it', () => {
		const { handle } = createFakeTurnQueue();
		const unregister = registerPlanQueueHandle('agent-a', handle);
		assert.strictEqual(getPlanQueueHandle('agent-a'), handle);
		unregister();
		assert.strictEqual(getPlanQueueHandle('agent-a'), undefined, 'unregistered handle must no longer be visible');
	});

	test('unregister only removes its own handle (overwrite protection)', () => {
		const first = createFakeTurnQueue();
		const second = createFakeTurnQueue();
		const unregisterFirst = registerPlanQueueHandle('agent-b', first.handle);
		registerPlanQueueHandle('agent-b', second.handle); // 后注册者覆盖
		unregisterFirst(); // 旧句柄的注销不得误删新句柄
		assert.strictEqual(getPlanQueueHandle('agent-b'), second.handle);
	});

	test('different agentIds are isolated', () => {
		const a = createFakeTurnQueue();
		const b = createFakeTurnQueue();
		registerPlanQueueHandle('agent-x', a.handle);
		registerPlanQueueHandle('agent-y', b.handle);
		assert.strictEqual(getPlanQueueHandle('agent-x'), a.handle);
		assert.strictEqual(getPlanQueueHandle('agent-y'), b.handle);
	});
});

suite('plan_register tool — ordered task queue registration', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('happy path: tasks are written into the active turn queue; result carries the CURRENT TASK reminder', async () => {
		const tool = capturePlanRegisterTool();
		const queue = createFakeTurnQueue();
		registerPlanQueueHandle('agent-1', queue.handle);

		const result = await tool.handler({
			tasks: [
				{ title: 'Add retry logic', description: 'Wrap fetch in a 3-attempt retry; findings: network flakes observed in logs', deliverable: 'retry util + tests', files: ['src/fetch.ts'] },
				{ title: 'Wire retry into caller', description: 'Use the new retry util in the API client' },
				{ title: 'Update docs', description: 'Document the retry behavior in README' },
			],
		}, undefined, 'agent-1');

		// 队列已被写入且索引归零
		assert.strictEqual(queue.state.tasks.length, 3);
		assert.strictEqual(queue.state.currentIndex, 0);
		assert.strictEqual(queue.state.tasks[0].title, 'Add retry logic');
		assert.deepStrictEqual(queue.state.tasks[0].files, ['src/fetch.ts']);
		assert.strictEqual(queue.state.tasks[0].deliverable, 'retry util + tests');

		// 工具结果包含注册摘要 + 第一个任务提醒（LLM 立即知道开始任务 1）
		const out = resultText(result);
		assert.ok(out.includes('Registered 3 tasks'), 'result must confirm registration');
		assert.ok(out.includes('CURRENT TASK (1/3)'), 'result must carry the first task reminder');
		assert.ok(out.includes('Add retry logic'), 'reminder must name the first task');
	});

	test('re-registration replaces the previous queue and restarts at task 1', async () => {
		const tool = capturePlanRegisterTool();
		const queue = createFakeTurnQueue();
		registerPlanQueueHandle('agent-2', queue.handle);

		await tool.handler({ tasks: [{ title: 'Old task', description: 'stale' }] }, undefined, 'agent-2');
		const result = await tool.handler({
			tasks: [
				{ title: 'New task A', description: 'fresh' },
				{ title: 'New task B', description: 'fresh' },
			],
		}, undefined, 'agent-2');

		assert.strictEqual(queue.state.tasks.length, 2, 'queue must be REPLACED, not appended');
		assert.strictEqual(queue.state.tasks[0].title, 'New task A');
		assert.ok(resultText(result).includes('CURRENT TASK (1/2)'));
	});

	test('no active turn queue → soft fallback text with the ordered list (never blocks)', async () => {
		const tool = capturePlanRegisterTool();
		const result = await tool.handler({
			tasks: [
				{ title: 'Step one', description: 'd1' },
				{ title: 'Step two', description: 'd2' },
			],
		}, undefined, 'agent-without-turn');
		const out = resultText(result);
		assert.ok(out.includes('No active execution queue'), 'must signal the missing queue');
		assert.ok(out.includes('1. Step one') && out.includes('2. Step two'), 'fallback must preserve the ordered list');
	});

	test('empty / invalid tasks → error result', async () => {
		const tool = capturePlanRegisterTool();
		const queue = createFakeTurnQueue();
		registerPlanQueueHandle('agent-3', queue.handle);

		const emptyResult = await tool.handler({ tasks: [] }, undefined, 'agent-3');
		assert.ok(resultText(emptyResult).startsWith('Error:'), 'empty tasks must be rejected');

		const noTitlesResult = await tool.handler({ tasks: [{ description: 'no title here' }] }, undefined, 'agent-3');
		assert.ok(resultText(noTitlesResult).startsWith('Error:'), 'tasks without titles must be rejected');

		assert.strictEqual(queue.state.tasks.length, 0, 'rejected registrations must not touch the queue');
	});

	test('tasks with empty titles are filtered out; remaining tasks register normally', async () => {
		const tool = capturePlanRegisterTool();
		const queue = createFakeTurnQueue();
		registerPlanQueueHandle('agent-4', queue.handle);

		await tool.handler({
			tasks: [
				{ title: '', description: 'ghost' },
				{ title: 'Real task', description: 'kept' },
			],
		}, undefined, 'agent-4');

		assert.strictEqual(queue.state.tasks.length, 1);
		assert.strictEqual(queue.state.tasks[0].title, 'Real task');
	});

	test('handler tolerates missing agentId (no queue lookup crash)', async () => {
		const tool = capturePlanRegisterTool();
		const result = await tool.handler({
			tasks: [{ title: 'Solo task', description: 'd' }],
		});
		assert.ok(resultText(result).includes('No active execution queue'));
	});
});
