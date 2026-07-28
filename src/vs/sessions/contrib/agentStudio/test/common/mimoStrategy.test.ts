/*---------------------------------------------------------------------------------------------
 *  Tests for MiMoStrategy（主会话 TaskGate）+ paradigmOverride 注册表 + switch_paradigm 工具。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IterationBudget } from '../../common/iterationBudget.js';
import {
	setParadigmOverride, getParadigmOverride, clearParadigmOverride,
	SWITCHABLE_PARADIGMS,
} from '../../common/paradigmOverride.js';
import { registerSessionTaskLookup, getSessionTaskLookup } from '../../browser/sessionTaskGateBridge.js';
import { HermesReActStrategy } from '../../browser/strategies/hermesReActStrategy.js';
import { MiMoStrategy } from '../../browser/strategies/mimoStrategy.js';
import { registerCompatibilityTools, type CompatToolContext } from '../../browser/providers/tool/compatibilityTools.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';
import type { PreLoopContext } from '../../common/agentLoopStrategy.js';
import type { IIncompleteTask } from '../../common/taskGate.js';
import type { IAgentOSService } from '../../common/agentOS.js';

function resultText(result: unknown): string {
	const arr = result as Array<{ type: string; text?: string }>;
	return arr.map(c => c.text ?? '').join('\n');
}

function stubPreLoopContext(agentId: string): PreLoopContext {
	return {
		host: { _logService: { info: () => { }, warn: () => { }, error: () => { } } } as unknown as PreLoopContext['host'],
		request: { agentId } as PreLoopContext['request'],
		chatMode: '', modelProvider: undefined, modelId: '', selection: undefined,
		messages: [], signal: undefined as any, budget: new IterationBudget(50), workState: {} as any,
		toolDefs: [], iteration: 0,
	} as unknown as PreLoopContext;
}

suite('paradigmOverride — runtime switching registry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('set / get / clear cycle', () => {
		clearParadigmOverride('agent-switch-1');
		assert.strictEqual(getParadigmOverride('agent-switch-1'), undefined);
		setParadigmOverride('agent-switch-1', 'mimo');
		assert.strictEqual(getParadigmOverride('agent-switch-1'), 'mimo');
		setParadigmOverride('agent-switch-1', 'budgeted-react');
		assert.strictEqual(getParadigmOverride('agent-switch-1'), 'budgeted-react');
		clearParadigmOverride('agent-switch-1');
		assert.strictEqual(getParadigmOverride('agent-switch-1'), undefined);
	});

	test('undefined value clears (idempotent)', () => {
		setParadigmOverride('agent-switch-2', 'react');
		setParadigmOverride('agent-switch-2', undefined);
		assert.strictEqual(getParadigmOverride('agent-switch-2'), undefined);
	});

	test('agents are isolated', () => {
		setParadigmOverride('agent-A', 'mimo');
		setParadigmOverride('agent-B', 'readonly');
		assert.strictEqual(getParadigmOverride('agent-A'), 'mimo');
		assert.strictEqual(getParadigmOverride('agent-B'), 'readonly');
		clearParadigmOverride('agent-A');
		clearParadigmOverride('agent-B');
	});

	test('SWITCHABLE_PARADIGMS includes mimo + budgeted-react and excludes graph', () => {
		assert.ok(SWITCHABLE_PARADIGMS.includes('mimo'));
		assert.ok(SWITCHABLE_PARADIGMS.includes('budgeted-react'));
		assert.ok(!SWITCHABLE_PARADIGMS.includes('graph' as any), 'graph 走独立路由，不应可热切换');
	});
});

suite('MiMoStrategy — paradigm identity + 主会话 TaskGate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('paradigm === "mimo"，与 Hermes 区分', () => {
		assert.strictEqual(new HermesReActStrategy().paradigm, 'budgeted-react');
		assert.strictEqual(new MiMoStrategy().paradigm, 'mimo');
	});

	test('继承 Hermes：预算门控与委托记账照常工作', async () => {
		const s = new MiMoStrategy();
		const budget = new IterationBudget(50);
		// 探索计数追踪（继承自 Hermes）
		const gen = s.interceptToolCall(stubPreLoopContext('a'), { name: 'search_files' });
		await gen.next();
		// 委托记账（继承）
		const gen2 = s.interceptToolCall(stubPreLoopContext('a'), { name: 'delegate_task' });
		await gen2.next();
		assert.ok((s as any).takeDelegationRound(), '委托轮 refund 记账必须继承生效');
		// 预算门控（继承）
		const almostEmpty = new IterationBudget(2);
		almostEmpty.consume(2);
		assert.strictEqual(s.shouldTerminate(stubPreLoopContext('a'), almostEmpty), true, '预算耗尽应终止');
	});

	test('beforeTerminate：任务板未接线 → allow（失败开放退化为 Hermes）', async () => {
		// 确保未注册 lookup（其他套件可能注册过 —— 用独立 agentId 隔离副作用）
		const s = new MiMoStrategy();
		const ctx = stubPreLoopContext('agent-mimo-notwired');
		const res = await s.beforeTerminate!(ctx, new IterationBudget(50));
		assert.strictEqual(res.allow, true, 'lookup 未注册时必须失败开放允许结束');
	});

	test('beforeTerminate：有未完成任务 → 注入重入提醒继续（allow=false）', async () => {
		const tasks: IIncompleteTask[] = [
			{ id: 't1', status: 'Running', summary: '未完成的根因分析' },
		];
		const restoreLookup = getSessionTaskLookup();
		registerSessionTaskLookup(async () => tasks);
		try {
			const s = new MiMoStrategy();
			const res = await s.beforeTerminate!(stubPreLoopContext('agent-mimo-gate'), new IterationBudget(50));
			assert.strictEqual(res.allow, false, '有未完成任务时必须拦截终止');
			assert.ok(res.nudgeMessage && res.nudgeMessage.length > 0, '必须带重入提醒文本');
			assert.ok(res.nudgeMessage!.includes('t1') || res.nudgeMessage!.includes('未完成'), '提醒必须提及未完成任务');
		} finally {
			if (restoreLookup) { registerSessionTaskLookup(restoreLookup); }
		}
	});

	test('beforeTerminate：重入封顶 MAX_TASK_GATE_MAIN_REACT(3) 后放行', async () => {
		const tasks: IIncompleteTask[] = [{ id: 't2', status: 'Todo', summary: '永远做不完' }];
		const restoreLookup = getSessionTaskLookup();
		registerSessionTaskLookup(async () => tasks);
		try {
			const s = new MiMoStrategy();
			const ctx = stubPreLoopContext('agent-mimo-cap');
			// 前 3 次：拦截 + nudge
			for (let i = 1; i <= 3; i++) {
				const res = await s.beforeTerminate!(ctx, new IterationBudget(50));
				assert.strictEqual(res.allow, false, `第 ${i} 次重入必须拦截（cap 未达）`);
			}
			// 第 4 次：达上限 → 放行（避免无限循环）
			const res = await s.beforeTerminate!(ctx, new IterationBudget(50));
			assert.strictEqual(res.allow, true, '重入次数超 MAX_TASK_GATE_MAIN_REACT 后必须放行');
		} finally {
			if (restoreLookup) { registerSessionTaskLookup(restoreLookup); }
		}
	});

	test('beforeTerminate：查询抛异常 → 失败开放放行', async () => {
		const restoreLookup = getSessionTaskLookup();
		registerSessionTaskLookup(async () => { throw new Error('DB down'); });
		try {
			const s = new MiMoStrategy();
			const res = await s.beforeTerminate!(stubPreLoopContext('agent-mimo-fail'), new IterationBudget(50));
			assert.strictEqual(res.allow, true, '查询异常时必须失败开放，绝不困住 loop');
		} finally {
			if (restoreLookup) { registerSessionTaskLookup(restoreLookup); }
		}
	});

	test('beforeTerminate：无未完成任务 → 直接放行', async () => {
		const restoreLookup = getSessionTaskLookup();
		registerSessionTaskLookup(async () => []);
		try {
			const s = new MiMoStrategy();
			const res = await s.beforeTerminate!(stubPreLoopContext('agent-mimo-clean'), new IterationBudget(50));
			assert.strictEqual(res.allow, true);
		} finally {
			if (restoreLookup) { registerSessionTaskLookup(restoreLookup); }
		}
	});
});

suite('switch_paradigm 工具 — 写入覆盖 + 校验 + 提示', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let tool: IBuiltinToolRegistration;
	setup(() => {
		const registrations: IBuiltinToolRegistration[] = [];
		const stubCtx: CompatToolContext = {
			register: (d) => { registrations.push(d); },
			agentOS: {} as IAgentOSService,
			fileService: {} as CompatToolContext['fileService'],
			logService: { info: () => { }, warn: () => { }, error: () => { } } as unknown as CompatToolContext['logService'],
			id: 'test.compat',
			resolveAndCheckWorkspacePath: async (_a, p) => p,
		};
		registerCompatibilityTools(stubCtx);
		tool = registrations.find(r => r.definition.name === 'switch_paradigm')!;
		assert.ok(tool, 'switch_paradigm 必须被注册');
	});
	teardown(() => {
		clearParadigmOverride('agent-switch-tool');
	});

	test('happy path: 切到 mimo 写入覆盖 + 提示下一 turn 生效 + 缓存重建成本', async () => {
		const result = await tool.handler({ paradigm: 'mimo' }, undefined, 'agent-switch-tool');
		const out = resultText(result);
		assert.strictEqual(getParadigmOverride('agent-switch-tool'), 'mimo');
		assert.ok(out.includes('mimo'));
		assert.ok(out.includes('NEXT turn'), '必须明确仅下一 turn 生效');
		assert.ok(out.includes('prompt cache rebuilds'), '必须提示缓存重建的一次性成本');
		assert.ok(out.includes('task board') || out.includes('kanban'), 'mimo 必须提示任务板语义');
	});

	test('paradigm=default 清除覆盖', async () => {
		setParadigmOverride('agent-switch-tool', 'mimo');
		await tool.handler({ paradigm: 'default' }, undefined, 'agent-switch-tool');
		assert.strictEqual(getParadigmOverride('agent-switch-tool'), undefined);
	});

	test('未知范式 → Error 文本，不写入', async () => {
		const result = await tool.handler({ paradigm: 'nonexistent' }, undefined, 'agent-switch-tool');
		assert.ok(resultText(result).startsWith('Error:'));
		assert.strictEqual(getParadigmOverride('agent-switch-tool'), undefined);
	});

	test('缺 agentId → Error', async () => {
		const result = await tool.handler({ paradigm: 'mimo' });
		assert.ok(resultText(result).startsWith('Error:'));
	});
});
