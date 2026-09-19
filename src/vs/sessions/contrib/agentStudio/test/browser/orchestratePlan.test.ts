/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `AgentOSService._orchestratePlan` 契约测试（真实导入）。
 *
 * 被测：agentOSService.ts:1357-1470 的 plan_exit 编排流程（异步生成器）。
 *
 * 构造策略：`AgentOSService` 的构造器需要 7 个 DI 服务（:538-546），但该方法
 * 实际只读 `this._logService`（:1368/1375/1407/...）与
 * `this._instantiationService`（:1387）。因此用 `Object.create(prototype)` 跳过
 * 构造器、只挂这两个字段——既避免拉起整个 DI 容器，也让测试聚焦于本方法的契约。
 *
 * 本测试锁死的核心不变量（每一条都对应 :1370-1466 的一个显式决策）：
 *   1. idempotency：同一 key 第二次进入必须**早退**，不得重复创建 plan
 *      （:1371-1379）。这是防「用户重放 / turn 重试」导致重复派发的唯一闸门。
 *   2. 幂等键在创建成功后必须**立即登记**（:1409-1411），否则重启前重放检测失效。
 *   3. orchService 不可用（DI 抛错 / 缺方法）时**不得中断**：仍须输出 Plan Summary
 *      并给出「手动执行」文案（:1450-1469）——plan 模式不能因编排服务缺失而死锁。
 *   4. approvePlan 失败与 createPlanFromTasks 失败是**两种不同降级**：
 *        - create 失败 → planCreated=false → "service unavailable" 文案
 *        - approve 失败 → planCreated=true, planExecuting=false → "switch to mode" 文案
 *      两者被混为一谈时，用户会看到与实际不符的指引。
 *
 * 运行方式（自仓库根）：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *     src/vs/sessions/contrib/agentStudio/test/browser/orchestratePlan.test.ts
 */

import assert from 'assert';

import { AgentOSService } from '../../browser/agentOSService.js';

type Delta = any;

/** 收集异步生成器的全部 delta。 */
async function drain(gen: AsyncGenerator<Delta>): Promise<Delta[]> {
	const out: Delta[] = [];
	for await (const d of gen) { out.push(d); }
	return out;
}

/** 拼接所有 text delta，便于对最终面向用户的文案做断言。 */
function allText(deltas: Delta[]): string {
	return deltas
		.filter(d => d.type === 'text' && typeof d.content === 'string')
		.map(d => d.content)
		.join('');
}

function makeLogger() {
	const records: Array<{ level: string; msg: string }> = [];
	return {
		records,
		logService: {
			info: (msg: string) => { records.push({ level: 'info', msg }); },
			warn: (msg: string) => { records.push({ level: 'warn', msg }); },
			error: (msg: string) => { records.push({ level: 'error', msg }); },
			debug: (msg: string) => { records.push({ level: 'debug', msg }); },
			trace: (msg: string) => { records.push({ level: 'trace', msg }); },
		},
	};
}

/** 构造 orchService 替身；各钩子可注入失败，用于覆盖降级分支。 */
function makeOrchService(opts?: {
	createPlanFails?: boolean;
	approveFails?: boolean;
	omitApprove?: boolean;
	omitCreate?: boolean;
}) {
	const calls = { create: 0, approve: 0 };
	const service: any = {};
	if (!opts?.omitCreate) {
		service.createPlanFromTasks = async (summary: string, wsId: string, agentId: string, tasks: any[], sessionId: string) => {
			calls.create++;
			if (opts?.createPlanFails) { throw new Error('create boom'); }
			return { id: 'plan-1', summary, workspaceId: wsId, agentId, sessionId, tasks };
		};
	}
	if (!opts?.omitApprove) {
		service.approvePlan = async (planId: string) => {
			calls.approve++;
			if (opts?.approveFails) { throw new Error('approve boom'); }
			return { id: planId, tasks: [{ id: 't1' }, { id: 't2' }] };
		};
	}
	return { service, calls };
}

/** 按构造器字段的真实名字挂上依赖——绕过 7 参 DI 构造器。 */
function makeService(orchService: any, logger: any): any {
	const instance: any = Object.create(AgentOSService.prototype);
	instance._logService = logger.logService;
	instance._instantiationService = {
		invokeFunction: (fn: any) => fn({ get: () => orchService }),
	};
	return instance;
}

const REQUEST = { agentId: 'a1', sessionId: 's1', workspaceId: 'ws1' } as any;
const TASKS = [
	{ title: 'T1', description: 'd1', files: ['a.ts'], complexity: 'high', suggestedRole: 'Coder', dependencies: [] },
	{ title: 'T2', description: 'd2', dependencies: ['T1'] },
] as any;

suite('AgentOSService._orchestratePlan plan_exit 编排契约', () => {

	test('正常路径：创建 plan → 自动批准 → 发出 plan_tasks 卡片与三处文本', async () => {
		const logger = makeLogger();
		const { service: orch, calls } = makeOrchService();
		const svc = makeService(orch, logger);

		const deltas = await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S' }, TASKS, 'call-1'));

		assert.strictEqual(calls.create, 1, '应创建一次 plan');
		assert.strictEqual(calls.approve, 1, 'plan_exit 策略门已过，应自动批准一次（不留第二次审批断点）');

		const card = deltas.find(d => d.type === 'plan_tasks');
		assert.ok(card, '必须发出 plan_tasks 卡片，否则聊天里看不到任务列表');
		assert.strictEqual(card.planTasksData.planId, 'plan-1', '卡片须带真实 planId');
		assert.strictEqual(card.planTasksData.summary, 'S', '卡片须带方案摘要');
		assert.strictEqual(card.planTasksData.tasks.length, 2, '卡片须含全部任务');
		assert.strictEqual(card.planTasksData.tasks[1].dependencies[0], 'T1', '依赖关系必须透传（DAG 派发依据）');
		assert.strictEqual(card.planTasksData.tasks[0].complexity, 'high', '复杂度须透传');
		assert.strictEqual(card.planTasksData.tasks[0].status, 'pending', '新任务初始状态应为 pending');

		const text = allText(deltas);
		assert.ok(text.includes('Plan created with 2 task(s)'), '应输出创建成功文案');
		assert.ok(text.includes('方案已批准'), '应输出批准文案');
		assert.ok(text.includes('## Plan Summary'), '无论如何都要输出方案摘要');
		assert.ok(text.includes('### Tasks (2)'), '摘要须含任务数标题');
		assert.ok(text.includes('**T1**'), '摘要须逐条列出任务');
		assert.ok(text.includes('[role: Coder]'), '有 suggestedRole 时应标注角色');
	});

	test('idempotency：同一 key 二次进入必须早退，不重复创建 plan', async () => {
		const logger = makeLogger();
		const { service: orch, calls } = makeOrchService();
		const svc = makeService(orch, logger);

		const first = await drain(svc._orchestratePlan(REQUEST, { idempotencyKey: 'k1' }, TASKS, 'call-1'));
		const second = await drain(svc._orchestratePlan(REQUEST, { idempotencyKey: 'k1' }, TASKS, 'call-2'));

		assert.strictEqual(
			calls.create, 1,
			'第二次必须在创建前被幂等闸门挡住——若这里是 2，说明重复派发风险已回归',
		);
		const secondText = allText(second);
		assert.ok(
			secondText.includes('idempotent replay'),
			`第二次进入必须早退并明示幂等重放，实际：${secondText.slice(0, 200)}`,
		);
		assert.ok(
			!secondText.includes('## Plan Summary'),
			'幂等重放路径应在输出摘要前 return，不得再吐一份完整摘要',
		);
		assert.strictEqual(second.length, 1, '幂等重放只应产出单个 text delta');
		assert.ok(first.length > 1, '首次调用应产出多个 delta（卡片 + 文本）');
	});

	test('幂等键在创建成功后立即登记，供后续重放检测', async () => {
		const logger = makeLogger();
		const { service: orch } = makeOrchService();
		const svc = makeService(orch, logger);

		await drain(svc._orchestratePlan(REQUEST, { idempotencyKey: 'k2' }, TASKS, 'call-1'));

		assert.strictEqual(
			svc['_plan_idem_k2'], 'plan-1',
			'创建成功后必须把 planId 登记到 _plan_idem_<key>，否则跨 turn 的重放检测失效',
		);
	});

	test('未提供 idempotencyKey 时不做重放检测，每次都创建', async () => {
		const logger = makeLogger();
		const { service: orch, calls } = makeOrchService();
		const svc = makeService(orch, logger);

		await drain(svc._orchestratePlan(REQUEST, {}, TASKS, 'c1'));
		await drain(svc._orchestratePlan(REQUEST, {}, TASKS, 'c2'));

		assert.strictEqual(calls.create, 2, '无 key 时不应命中幂等闸门');
	});

	test('createPlanFromTasks 抛错 → 降级为 "orchestration service unavailable"，不得抛穿', async () => {
		const logger = makeLogger();
		const { service: orch } = makeOrchService({ createPlanFails: true });
		const svc = makeService(orch, logger);

		const deltas = await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S' }, TASKS, 'c1'));

		const text = allText(deltas);
		assert.ok(text.includes('## Plan Summary'), '创建失败仍须输出方案摘要（plan 模式不得死锁）');
		assert.ok(
			text.includes('orchestration service unavailable'),
			`创建失败应提示编排服务不可用，实际：${text.slice(-200)}`,
		);
		assert.ok(!text.includes('方案已批准'), '创建失败时不得声称已批准');
		assert.strictEqual(deltas.filter(d => d.type === 'plan_tasks').length, 0, '创建失败不得发卡片');
		assert.ok(
			logger.records.some(r => r.level === 'warn'),
			'创建失败必须记 warn 日志，便于排障',
		);
	});

	test('orchService 未注册（DI 抛错）→ 同样降级且不抛穿', async () => {
		const logger = makeLogger();
		const instance: any = Object.create(AgentOSService.prototype);
		instance._logService = logger.logService;
		instance._instantiationService = {
			invokeFunction: () => { throw new Error('service not registered'); },
		};

		const deltas = await drain(instance._orchestratePlan(REQUEST, { plan_summary: 'S' }, TASKS, 'c1'));

		const text = allText(deltas);
		assert.ok(text.includes('orchestration service unavailable'), '未注册服务应走同一降级文案');
		assert.ok(text.includes('## Plan Summary'), '仍须输出摘要');
	});

	test('缺 approvePlan 方法 → planCreated=true 但不进入执行态，文案要求切模式', async () => {
		const logger = makeLogger();
		const { service: orch, calls } = makeOrchService({ omitApprove: true });
		const svc = makeService(orch, logger);

		const deltas = await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S' }, TASKS, 'c1'));

		const text = allText(deltas);
		assert.strictEqual(calls.create, 1, '创建应成功');
		assert.ok(text.includes('Plan created with 2 task(s)'), '应输出创建成功文案');
		assert.ok(
			text.includes('assigned') && text.includes('CRAFT'),
			`无 approvePlan 时应提示切到 Craft 模式手动开始，实际：${text.slice(-200)}`,
		);
		assert.ok(!text.includes('方案已批准'), '无 approvePlan 时不得声称已批准');
		assert.ok(!text.includes('service unavailable'), 'plan 已创建，不应降级为"服务不可用"');
	});

	test('approvePlan 抛错 → 与 create 失败区分开：卡片与摘要保留，仅提示执行启动失败', async () => {
		const logger = makeLogger();
		const { service: orch, calls } = makeOrchService({ approveFails: true });
		const svc = makeService(orch, logger);

		const deltas = await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S' }, TASKS, 'c1'));

		const text = allText(deltas);
		assert.strictEqual(calls.create, 1, '创建应成功');
		assert.strictEqual(calls.approve, 1, '应尝试过批准');
		assert.strictEqual(deltas.filter(d => d.type === 'plan_tasks').length, 1, '卡片应在批准失败前已发出');
		assert.ok(text.includes('执行启动失败'), '应向用户明示执行启动失败');
		assert.ok(
			text.includes('assigned') && text.includes('CRAFT'),
			'approve 失败时 planExecuting=false、planCreated=true → 应给出"切模式"指引而非"服务不可用"',
		);
		assert.ok(!text.includes('service unavailable'), 'approve 失败不等于编排服务缺失，不得混用文案');
		assert.ok(
			logger.records.some(r => r.level === 'warn' && r.msg.includes('Auto-execute')),
			'批准失败须记 warn',
		);
	});

	test('next_mode 默认为 craft；显式传入时摘要文案同步变化', async () => {
		const logger = makeLogger();
		const { service: orch } = makeOrchService({ omitApprove: true });
		const svc = makeService(orch, logger);

		const withDefault = allText(await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S' }, TASKS, 'c1')));
		const withWork = allText(await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S', next_mode: 'work' }, TASKS, 'c2')));

		assert.ok(withDefault.includes('CRAFT'), '未传 next_mode 应默认 craft');
		assert.ok(withWork.includes('WORK'), '显式 next_mode=work 应体现在文案中');
		assert.ok(!withWork.includes('CRAFT'), '不得残留默认值文案');
	});

	test('空任务列表：仍产出摘要与卡片，不抛异常', async () => {
		const logger = makeLogger();
		const { service: orch } = makeOrchService();
		const svc = makeService(orch, logger);

		const deltas = await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S' }, [] as any, 'c1'));

		const text = allText(deltas);
		assert.ok(text.includes('### Tasks (0)'), '应如实标注 0 个任务');
		assert.ok(text.includes('## Plan Summary'), '空任务也须输出摘要');
		const card = deltas.find(d => d.type === 'plan_tasks');
		assert.ok(card, '空任务仍应发卡片（面板需据此展示空列表）');
		assert.strictEqual(card.planTasksData.tasks.length, 0);
	});

	test('createPlanFromTasks 收到的入参经过归一：files/dependencies 缺省为空数组、complexity 缺省 medium', async () => {
		const logger = makeLogger();
		let captured: any[] = [];
		const orch: any = {
			createPlanFromTasks: async (_s: string, _w: string, _a: string, tasks: any[]) => {
				captured = tasks;
				return { id: 'p', tasks: [] };
			},
			approvePlan: async () => ({ tasks: [] }),
		};
		const svc = makeService(orch, logger);

		// 第三个任务故意省略 files / complexity / dependencies / suggestedRole。
		const sparse = [
			{ title: 'S1', description: 'sd1' },
		] as any;
		await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S' }, sparse, 'c1'));

		assert.deepStrictEqual(captured[0].files, [], '缺省 files 应归一为空数组，而非 undefined');
		assert.deepStrictEqual(captured[0].dependencies, [], '缺省 dependencies 应归一为空数组');
		assert.strictEqual(captured[0].complexity, 'medium', '缺省 complexity 应归一为 medium');
		assert.strictEqual(captured[0].suggestedRole, undefined, '缺省 suggestedRole 应保持 undefined');

		// 已提供字段不得被默认值覆盖 —— 单独再跑一次带全字段的样本。
		await drain(svc._orchestratePlan(REQUEST, { plan_summary: 'S' }, TASKS, 'c2'));

		assert.strictEqual(captured[0].complexity, 'high', '已提供的 complexity 不得被覆盖');
		assert.strictEqual(captured[0].suggestedRole, 'Coder', 'suggestedRole 应透传');
		assert.deepStrictEqual(captured[0].files, ['a.ts'], '已提供的 files 应透传');
		assert.deepStrictEqual(captured[1].dependencies, ['T1'], '已提供的 dependencies 应透传（DAG 派发依据）');
	});
});
