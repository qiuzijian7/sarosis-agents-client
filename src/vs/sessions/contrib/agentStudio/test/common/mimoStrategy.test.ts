/*---------------------------------------------------------------------------------------------
 *  Tests for MiMoStrategy（主会话 TaskGate）+ 已退役范式工具的反向契约。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IterationBudget } from '../../common/iterationBudget.js';
import { classifyIterationStop } from '../../common/turnStopGate.js';
import { registerSessionTaskLookup, getSessionTaskLookup } from '../../browser/sessionTaskGateBridge.js';
import { HermesReActStrategy } from '../../browser/strategies/hermesReActStrategy.js';
import { MiMoStrategy } from '../../browser/strategies/mimoStrategy.js';
import { registerCompatibilityTools, type CompatToolContext } from '../../browser/providers/tool/compatibilityTools.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';
import type { PreLoopContext } from '../../common/agentLoopStrategy.js';
import type { IIncompleteTask } from '../../common/taskGate.js';
import type { IAgentOSService } from '../../common/agentOS.js';

// ── 钉 legacy（2026-09-21 更新：范式工具与范式覆盖注册表**均已退役**）──────────
// `switch_paradigm` 曾由 `if (!isPiKernelEnabled())` 门控 —— 该工具与其门控已于 2026-09-21
// **正式退役并删除**（pi 路径没有范式机制 ⇒ 注册即空承诺；见 compatibilityTools.ts 的
// 「已正式退役」注释块）。随后其唯一运行时写入入口消失 ⇒ **`paradigmOverride` 注册表也整体下线**
// （范式改为每 turn 就地解析 `resumeFrom?.paradigm ?? request.paradigm`，见 agentTurnExecutor.ts
// 解析段注释与 common/paradigmOverride.ts 的删除记录）。故本文件不再有注册表用例。
// 下方内核开关仍显式关断：其余 legacy 语义（MiMo 策略 / 任务门）需要它。
(globalThis as { __SAROSIS_PI_KERNEL?: unknown }).__SAROSIS_PI_KERNEL = false;

function stubPreLoopContext(agentId: string): PreLoopContext {
	return {
		host: { _logService: { info: () => { }, warn: () => { }, error: () => { } } } as unknown as PreLoopContext['host'],
		request: { agentId } as PreLoopContext['request'],
		chatMode: '', modelProvider: undefined, modelId: '', selection: undefined,
		messages: [], signal: undefined as any, budget: new IterationBudget(50), workState: {} as any,
		toolDefs: [], iteration: 0,
	} as unknown as PreLoopContext;
}


suite('MiMoStrategy — paradigm identity + 主会话 TaskGate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('paradigm === "mimo"，与 Hermes 区分', () => {
		assert.strictEqual(new HermesReActStrategy().paradigm, 'budgeted-react');
		assert.strictEqual(new MiMoStrategy().paradigm, 'mimo');
	});

	test('继承 Hermes：预算门控与委托记账照常工作', async () => {
		const s = new MiMoStrategy();
		// 探索计数追踪（继承自 Hermes）
		const gen = s.interceptToolCall(stubPreLoopContext('a'), { name: 'search_files' });
		await gen.next();
		// 委托记账（继承）
		const gen2 = s.interceptToolCall(stubPreLoopContext('a'), { name: 'delegate_task' });
		await gen2.next();
		assert.ok((s as any).takeDelegationRound(), '委托轮 refund 记账必须继承生效');
		// 预算门控：`shouldTerminate` 已于 2026-09 从 IAgentLoopStrategy 移除
		// （职责归 `common/turnStopGate.ts` 的 classifyIterationStop，见
		// `common/turnHookBus.ts:17`）。策略不得再带该成员 —— 该约束由
		// `test/browser/agentTurnExecutorBehavior.test.ts:9085` 的契约守护锁定。
		// 这里改为验证真正生效的裁决路径：预算耗尽 + 收尾轮已跑过 → stop。
		assert.strictEqual(
			typeof (s as unknown as Record<string, unknown>).shouldTerminate,
			'undefined',
			'策略不得复活 shouldTerminate（旧语义会在绕过 skipMainLoop 的路径上首轮即终止）',
		);
		const almostEmpty = new IterationBudget(2);
		almostEmpty.consume(2);
		assert.strictEqual(
			classifyIterationStop(
				{
					iteration: 3,
					hasRemainingBudget: almostEmpty.hasRemaining(),
					isGraceArmed: almostEmpty.isGraceArmed(),
					wrapUpDone: true,
					wrapUpForced: false,
				},
				{ maxToolIterations: 100 },
			).kind,
			'stop',
			'预算耗尽且收尾轮已跑过 → 必须 stop',
		);
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

suite('【已正式退役】switch_paradigm（2026-09-21）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★★★ 退役契约：即便 legacy 内核开关关断，也不得再注册 switch_paradigm', () => {
		// 关键点：退役 ≠ 「换个开关还能回来」。门控代码已删除 ⇒ 无论内核开关如何，
		// 这个工具都不该出现在注册结果里（挡住"凭印象加回门控"）。
		const registrations: IBuiltinToolRegistration[] = [];
		const stubCtx: CompatToolContext = {
			register: (d) => { registrations.push(d); },
			agentOS: {} as IAgentOSService,
			fileService: {} as CompatToolContext['fileService'],
			logService: { info: () => { }, warn: () => { }, error: () => { } } as unknown as CompatToolContext['logService'],
			id: 'test.compat',
			resolveAndCheckWorkspacePath: async (_a, path) => path,
		};
		registerCompatibilityTools(stubCtx);
		assert.ok(!registrations.some(r => r.definition.name === 'switch_paradigm'),
			'switch_paradigm 已正式退役 —— 不得再注册（pi 路径没有范式机制；回归须按 pi 契约重新引入）✗');
	});
});
