/*---------------------------------------------------------------------------------------------
 *  定时任务工具（cronjob）单元测试
 *
 *  背景（2026-09-11）：与 drawio / session_search / vision_analyze / mediaGen 同源的半成品 ——
 *  `IAgentSchedulerService`（registerCron / listSchedules / pause / resume / remove /
 *  getExecutionHistory）+ `cronParser` + 定时任务视图 + 测试**全部就绪**，唯独缺 LLM 工具
 *  入口（`name: 'cronjob'` 只出现在 bundled 定义里 → stub → listTools 跳过 → 模型看不到）。
 *
 *  覆盖：
 *   - 注册（name / inputSchema / 必需 action）
 *   - create：必填校验、★ cron 表达式提前校验、成功返回 schedule_id 与下次触发时间
 *   - list / pause / resume / remove / history：参数校验与结果格式
 *   - 未知 action、底层异常
 *   - ★ 不提供 `trigger`（本地无「按 id 触发」API，见实现注释）
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/schedulerTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { registerSchedulerTools, CRONJOB_TOOL_NAME } from '../../browser/providers/tool/schedulerTools.js';

import type { IToolResultContent } from '../../common/providers.js';

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as any;

const NEXT_FIRE = 1_757_000_000_000;

function makeRunner(opts: {
	schedules?: any[];
	history?: any[];
	throwOnRegister?: boolean;
} = {}) {
	const calls: Array<[string, unknown]> = [];
	const scheduler: any = {
		registerCron: (cfg: any) => {
			if (opts.throwOnRegister) { throw new Error('scheduler exploded'); }
			calls.push(['registerCron', cfg]);
			return {
				scheduleId: 'sched-1',
				type: 'cron',
				getNextFireTime: () => NEXT_FIRE,
				pause() { }, resume() { }, triggerNow: async () => { }, dispose() { },
			};
		},
		listSchedules: (id: string) => { calls.push(['listSchedules', id]); return opts.schedules ?? []; },
		pauseSchedule: (id: string) => { calls.push(['pauseSchedule', id]); },
		resumeSchedule: (id: string) => { calls.push(['resumeSchedule', id]); },
		removeSchedule: (id: string) => { calls.push(['removeSchedule', id]); },
		getExecutionHistory: (id: string, o: any) => { calls.push(['getExecutionHistory', [id, o]]); return opts.history ?? []; },
	};
	const registered: any[] = [];
	registerSchedulerTools({
		register: (d: any) => registered.push(d),
		logService: quietLog,
		scheduler,
	} as any);
	return {
		definition: registered[0].definition,
		calls,
		invoke: async (args: Record<string, unknown>, agentId: string | undefined = 'agent-1'): Promise<string> => {
			const res: IToolResultContent[] = await registered[0].handler(args, undefined, agentId);
			assert.ok(Array.isArray(res) && res.length === 1, 'handler 应返回一个内容块');
			return (res[0] as { text: string }).text;
		},
	};
}

suite('Scheduler Tool (cronjob)', () => {

	test('CRONJOB_TOOL_NAME 与 bundled / isolator 登记名一致', () => {
		assert.strictEqual(CRONJOB_TOOL_NAME, 'cronjob');
	});

	test('definition 结构正确（action 必填）', () => {
		const r = makeRunner();
		assert.strictEqual(r.definition.name, 'cronjob');
		assert.deepStrictEqual(r.definition.inputSchema.required, ['action']);
		const actions = r.definition.inputSchema.properties.action.enum;
		assert.deepStrictEqual(actions, ['create', 'list', 'pause', 'resume', 'remove', 'history']);
		// ★ 不提供 trigger：本地没有「按 schedule id 触发」的 API（triggerNow 只存在于
		// registerCron 返回的 handle 实例上），提供它就是个永远失败的入口。
		assert.ok(!actions.includes('trigger'), '不应暴露 trigger');
	});

	test('缺 action → 明确报错', async () => {
		const r = makeRunner();
		assert.ok((await r.invoke({})).includes('"action" is required'));
	});

	test('无 agentId → 明确报错（无法确定目标 Agent）', async () => {
		const r = makeRunner();
		// 注意：不能传 undefined —— `invoke` 的默认参数会把它替换成 'agent-1'，
		// 那样测的就不是「无 agent 上下文」这条分支了。
		assert.ok((await r.invoke({ action: 'list' }, null as unknown as string)).includes('no agent context'));
	});

	// ─── create ────────────────────────────────────────────────────────────

	test('create：缺 name / schedule / task → 明确报错且不调用调度器', async () => {
		const r = makeRunner();
		const text = await r.invoke({ action: 'create', name: 'x' });
		assert.ok(text.includes('requires "name", "schedule" and "task"'), '应提示必填项');
		assert.strictEqual(r.calls.length, 0, '校验失败不应调用调度器');
	});

	test('★ create：非法 cron 表达式 → 提前报错（不注册后才失败）', async () => {
		const r = makeRunner();
		const text = await r.invoke({ action: 'create', name: 'x', schedule: '这不是 cron', task: 'do it' });
		assert.ok(text.includes('not a valid cron expression'), `应报 cron 非法，实际: ${text}`);
		assert.ok(text.includes('0 9 * * 1-5'), '应给出格式示例');
		assert.strictEqual(r.calls.length, 0, '非法 cron 不应调用调度器');
	});

	test('★ create：成功 → 注册到当前 agent 并返回 schedule_id 与下次触发时间', async () => {
		const r = makeRunner();
		const text = await r.invoke({ action: 'create', name: '晨会提醒', schedule: '0 9 * * 1-5', task: '总结昨天的进展' });
		assert.ok(text.includes('schedule_id: sched-1'), '应返回 schedule_id');
		assert.ok(text.includes(new Date(NEXT_FIRE).toISOString()), '应返回下次触发时间');
		assert.ok(text.includes('晨会提醒'), '应回显名称');

		const call = r.calls.find(c => c[0] === 'registerCron');
		assert.ok(call, '应调用 registerCron');
		const cfg = call![1] as any;
		assert.strictEqual(cfg.instanceId, 'agent-1', 'instanceId 应为当前 agent');
		assert.strictEqual(cfg.cronExpression, '0 9 * * 1-5');
		assert.strictEqual(cfg.inputTemplate.messageTemplate, '总结昨天的进展', 'task 应落到 messageTemplate');
	});

	test('create：timezone 透传', async () => {
		const r = makeRunner();
		await r.invoke({ action: 'create', name: 'n', schedule: '0 9 * * *', task: 't', timezone: 'Asia/Shanghai' });
		const cfg = r.calls.find(c => c[0] === 'registerCron')![1] as any;
		assert.strictEqual(cfg.timezone, 'Asia/Shanghai');
	});

	test('create：调度器抛错 → 捕获并报错（不冒泡）', async () => {
		const r = makeRunner({ throwOnRegister: true });
		const text = await r.invoke({ action: 'create', name: 'n', schedule: '0 9 * * *', task: 't' });
		assert.ok(text.includes('scheduler exploded'), '应转达底层错误');
	});

	// ─── list ──────────────────────────────────────────────────────────────

	test('list：无任务 → 明确提示', async () => {
		const r = makeRunner({ schedules: [] });
		assert.ok((await r.invoke({ action: 'list' })).includes('No scheduled jobs'));
	});

	test('★ list：格式化输出含 state / 下次触发 / 执行统计', async () => {
		const r = makeRunner({
			schedules: [{
				id: 's1', name: '晨会提醒', type: 'cron', instanceId: 'agent-1', state: 'active',
				createdAt: 0, nextFireAt: NEXT_FIRE, totalExecutions: 5, totalFailures: 1,
				config: { cronExpression: '0 9 * * 1-5' },
			}],
		});
		const text = await r.invoke({ action: 'list' });
		assert.ok(text.includes('晨会提醒'), '应含名称');
		assert.ok(text.includes('0 9 * * 1-5'), '应含 cron 表达式');
		assert.ok(text.includes('state=active'), '应含状态');
		assert.ok(text.includes('runs=5') && text.includes('failures=1'), '应含执行统计');
		assert.ok(text.includes('s1'), '应含 id（供后续 pause/remove 使用）');
	});

	// ─── pause / resume / remove / history ─────────────────────────────────

	test('pause / resume / remove：缺 schedule_id → 明确报错', async () => {
		const r = makeRunner();
		for (const action of ['pause', 'resume', 'remove']) {
			assert.ok((await r.invoke({ action })).includes('"schedule_id"'), `${action} 应要求 schedule_id`);
		}
		assert.strictEqual(r.calls.length, 0, '校验失败不应调用调度器');
	});

	test('pause / resume / remove：成功 → 调用对应方法并确认', async () => {
		const r = makeRunner();
		assert.ok((await r.invoke({ action: 'pause', schedule_id: 's1' })).includes('paused'));
		assert.ok((await r.invoke({ action: 'resume', schedule_id: 's1' })).includes('resumed'));
		assert.ok((await r.invoke({ action: 'remove', schedule_id: 's1' })).includes('removed'));
		assert.deepStrictEqual(r.calls.map(c => c[0]), ['pauseSchedule', 'resumeSchedule', 'removeSchedule']);
	});

	test('history：缺 schedule_id → 明确报错；无记录 → 明确提示', async () => {
		const r = makeRunner({ history: [] });
		assert.ok((await r.invoke({ action: 'history' })).includes('"schedule_id"'));
		assert.ok((await r.invoke({ action: 'history', schedule_id: 's1' })).includes('No execution history'));
	});

	test('history：有记录 → 含时间 / 状态 / 错误信息', async () => {
		const r = makeRunner({
			history: [
				{ executionId: 'e1', scheduleId: 's1', startedAt: NEXT_FIRE, status: 'success', retryCount: 0 },
				{ executionId: 'e2', scheduleId: 's1', startedAt: NEXT_FIRE + 1000, status: 'failed', retryCount: 2, error: 'timeout' },
			],
		});
		const text = await r.invoke({ action: 'history', schedule_id: 's1' });
		assert.ok(text.includes('success'), '应含成功记录');
		assert.ok(text.includes('failed'), '应含失败记录');
		assert.ok(text.includes('timeout'), '应含错误信息');
		assert.ok(text.includes('retry 2'), '应含重试次数');
	});

	test('未知 action → 明确报错并列出合法值', async () => {
		const r = makeRunner();
		const text = await r.invoke({ action: 'explode' });
		assert.ok(text.includes('unknown action'), '应报未知 action');
		assert.ok(text.includes('create, list, pause, resume, remove, history'), '应列出合法值');
	});
});
