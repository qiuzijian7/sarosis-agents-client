/*---------------------------------------------------------------------------------------------
 *  Tests for HermesReActStrategy — interceptToolCall 观测接线（委托记账）
 *  + prepareIteration 预算提醒 + beforeTerminate（MiMo TaskGate）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { HermesReActStrategy } from '../../browser/strategies/hermesReActStrategy.js';
import { IterationBudget } from '../../common/iterationBudget.js';
import type { InterceptResult } from '../../common/agentLoopStrategy.js';
import { registerSessionTaskLookup, getSessionTaskLookup } from '../../browser/sessionTaskGateBridge.js';
import type { IIncompleteTask } from '../../common/taskGate.js';

const stubCtx = { toolDefs: [{ name: 'search_files' }] } as any;

/** 驱动 async generator 一次，取 InterceptResult。 */
async function intercept(strategy: HermesReActStrategy, name: string): Promise<InterceptResult> {
	const gen = strategy.interceptToolCall(stubCtx, { name });
	const first = await gen.next();
	return first.value as InterceptResult;
}

/** 连续 intercept 多个工具名。 */
async function interceptAll(strategy: HermesReActStrategy, names: string[]): Promise<void> {
	for (const n of names) {
		await intercept(strategy, n);
	}
}

suite('HermesReActStrategy — interceptToolCall 观测（委托记账）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('观测语义：所有调用 handled=false（不消费）', async () => {
		const s = new HermesReActStrategy();
		for (const name of ['search_files', 'file_read', 'delegate_task', 'terminal']) {
			const res = await intercept(s, name);
			assert.strictEqual(res.handled, false, `${name} must not be consumed`);
		}
	});

	test('delegate_task 计入委托轮：takeDelegationRound 一次性返回 true', async () => {
		const s = new HermesReActStrategy();
		await intercept(s, 'delegate_task');
		assert.strictEqual((s as any).takeDelegationRound(), true, '委托轮必须记账（修复 interceptToolCall 休眠导致的 refund 失效）');
		assert.strictEqual((s as any).takeDelegationRound(), false, '记账必须一次性复位');
	});
});

suite('HermesReActStrategy — prepareIteration（预算提醒；委托建议已移除）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('大量直接探索调用不再触发 DELEGATION SUGGESTION（功能已移除）', async () => {
		const s = new HermesReActStrategy();
		const budget = new IterationBudget(50);
		await interceptAll(s, [
			'search_files', 'search_files', 'search_graph', 'search_files',
			'query_graph', 'get_code_snippet', 'trace_path', 'search_files',
		]);
		assert.strictEqual(s.prepareIteration(stubCtx, budget).reminderMessage, undefined,
			'探索计数提醒已移除，任何次数的直查都不注入委托建议');
	});

	test('预算低 → 注入总结提醒（保留）', async () => {
		const s = new HermesReActStrategy();
		const budget = new IterationBudget(10);
		budget.consume(9); // remaining=1 → ratio=0.1 ≤ 0.1 → 预算提醒
		const reminder = s.prepareIteration(stubCtx, budget).reminderMessage;
		assert.ok(reminder?.includes('迭代预算即将耗尽'), '预算提醒必须保留');
		assert.ok(!reminder?.includes('DELEGATION SUGGESTION'), '不得再出现委托建议文案');
	});

	test('toolDefs 透传（不覆盖工具面）', async () => {
		const s = new HermesReActStrategy();
		const budget = new IterationBudget(50);
		const plan = s.prepareIteration(stubCtx, budget);
		assert.deepStrictEqual(plan.toolDefs, stubCtx.toolDefs);
	});
});

suite('HermesReActStrategy — beforeTerminate（MiMo-Code TaskGate 处理方式）', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const gateCtx = (agentId: string) => ({
		...stubCtx,
		host: { _logService: { info: () => { } } },
		request: { agentId },
	}) as any;

	test('零检索收尾 + 任务板未接线 → 放行（旧 RETRIEVAL REQUIRED guard 已移除）', async () => {
		const restore = getSessionTaskLookup();
		registerSessionTaskLookup(undefined);
		try {
			const s = new HermesReActStrategy();
			const res = await s.beforeTerminate(gateCtx('agent-hermes-notwired'), new IterationBudget(50));
			assert.strictEqual(res.allow, true, '零检索不再强制 grounding —— MiMo/Hermes 原版均无此机制');
		} finally {
			registerSessionTaskLookup(restore);
		}
	});

	test('零检索 + 任务板无未完成任务 → 放行（纯问答不误拦截）', async () => {
		const restore = getSessionTaskLookup();
		registerSessionTaskLookup(async () => []);
		try {
			const s = new HermesReActStrategy();
			const res = await s.beforeTerminate(gateCtx('agent-hermes-clean'), new IterationBudget(50));
			assert.strictEqual(res.allow, true, '任务板干净时必须放行，无论是否检索过');
		} finally {
			registerSessionTaskLookup(restore);
		}
	});

	test('有未完成任务 → 拦截并注入 TaskGate 重入提醒（非 RETRIEVAL 文案）', async () => {
		const tasks: IIncompleteTask[] = [{ id: 'ht1', status: 'Running', summary: '未完成的重构' }];
		const restore = getSessionTaskLookup();
		registerSessionTaskLookup(async () => tasks);
		try {
			const s = new HermesReActStrategy();
			const res = await s.beforeTerminate(gateCtx('agent-hermes-gate'), new IterationBudget(50));
			assert.strictEqual(res.allow, false, 'DB 真相有未完成任务时必须拦截收尾');
			assert.ok(res.nudgeMessage?.includes('<system-reminder>'), '重入提醒必须是 system-reminder 包装');
			assert.ok(res.nudgeMessage?.includes('ht1'), '提醒必须列出未完成任务 id');
			assert.ok(!res.nudgeMessage?.includes('RETRIEVAL REQUIRED'), '不得再出现旧 grounding 文案');
		} finally {
			registerSessionTaskLookup(restore);
		}
	});

	test('重入封顶 MAX_TASK_GATE_MAIN_REACT(3) 后放行（防无限循环）', async () => {
		const tasks: IIncompleteTask[] = [{ id: 'ht2', status: 'Todo', summary: '永远做不完' }];
		const restore = getSessionTaskLookup();
		registerSessionTaskLookup(async () => tasks);
		try {
			const s = new HermesReActStrategy();
			const ctx = gateCtx('agent-hermes-cap');
			for (let i = 1; i <= 3; i++) {
				const res = await s.beforeTerminate(ctx, new IterationBudget(50));
				assert.strictEqual(res.allow, false, `第 ${i} 次重入必须拦截`);
			}
			const final = await s.beforeTerminate(ctx, new IterationBudget(50));
			assert.strictEqual(final.allow, true, '达 cap 后必须放行');
		} finally {
			registerSessionTaskLookup(restore);
		}
	});

	test('lookup 查询异常 → 失败开放放行', async () => {
		const restore = getSessionTaskLookup();
		registerSessionTaskLookup(async () => { throw new Error('DB down'); });
		try {
			const s = new HermesReActStrategy();
			const res = await s.beforeTerminate(gateCtx('agent-hermes-fail'), new IterationBudget(50));
			assert.strictEqual(res.allow, true, 'DB 错误绝不困住 loop');
		} finally {
			registerSessionTaskLookup(restore);
		}
	});
});
