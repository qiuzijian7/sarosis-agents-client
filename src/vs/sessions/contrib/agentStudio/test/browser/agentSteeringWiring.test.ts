/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Steering（运行中消息注入）链路接线测试。
 *
 * 为什么这些用例重要：steering 的完整链路横跨 5 层
 *   webview useChatStore → postMessage → controller case → driver 队列 → executor 注入点
 * 其中 driver 队列与 controller case 是「承重接线」，一旦被误改（例如 agentId 隔离失效、
 * payload 字段重命名、case 被删），表现是「用户运行中输入的消息静默丢失」——
 * 没有任何报错，只有用户觉得 agent「没听见」。故用测试锁住这些契约。
 *
 * 测试对象是**真实产品代码**（AgentDriverService / WebviewController），不是重写的副本。
 * driver 的 9 个 DI 依赖以最小桩对象注入——构造器只保存引用，仅 startup 自愈会
 * 真正调用 workspace 服务，且其失败被 catch 成 warn，不阻断实例化。
 */

import assert from 'assert';
import { AgentDriverService } from '../../browser/agentDriverService.js';
import type { DeliveryQueue } from '../../common/deliveryQueue.js';

/**
 * 读取 driver 的私有 steering 队列。
 *
 * 为什么不加 public 访问器：那会把「测试可见性」烙进产品 API。
 * 此处从测试侧穿透私有字段，产品代码保持最小暴露面。
 */
function steeringQueues(driver: AgentDriverService): Map<string, DeliveryQueue> {
	return (driver as unknown as { _steeringQueues: Map<string, DeliveryQueue> })._steeringQueues;
}

function deliveryQueueOf(driver: AgentDriverService, agentId: string): DeliveryQueue {
	const queue = steeringQueues(driver).get(agentId);
	assert.ok(queue, `期望 agent ${agentId} 已有队列`);
	return queue;
}

function steeringQueueSizeOf(driver: AgentDriverService): number {
	return steeringQueues(driver).size;
}

/** 让构造期的异步自愈抛错也不影响断言（其失败被产品代码 catch 成 warn）。 */
async function flushStartup(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}

/** 最小 DI 桩：够构造器保存引用即可。 */
function createDriverStub(): AgentDriverService {
	const logService = {
		info: () => { /* noop */ },
		warn: () => { /* noop */ },
		error: () => { /* noop */ },
		trace: () => { /* noop */ },
		debug: () => { /* noop */ },
	};
	const configurationService = {
		getValue: () => undefined,
		onDidChangeConfiguration: () => ({ dispose: () => { /* noop */ } }),
	};
	// 自愈会遍历 binding 并查 workspace 文件夹；桩返回空集合 → 自愈空转。
	const workspaceContextService = {
		getWorkspace: () => ({ folders: [] }),
	};
	const stub = {
		_agentOS: {},
		_skillRegistry: {},
		_logService: logService,
		_configurationService: configurationService,
		_agentStudioService: {},
		_workspaceContextService: workspaceContextService,
		_mcpService: {},
		_storageService: { get: () => undefined, store: () => { /* noop */ } },
		_instantiationService: { invokeFunction: () => { throw new Error('not needed in this test'); } },
	};
	return new AgentDriverService(
		stub._agentOS as never,
		stub._skillRegistry as never,
		logService as never,
		configurationService as never,
		stub._agentStudioService as never,
		workspaceContextService as never,
		stub._mcpService as never,
		stub._storageService as never,
		stub._instantiationService as never,
	);
}

suite('Steering — 链路接线契约', () => {

	test('enqueueSteeringMessage 返回唯一 id，且异次调用不重复', async () => {
		const driver = createDriverStub();
		await flushStartup();

		const idA = driver.enqueueSteeringMessage('agent-a', '第一条');
		const idB = driver.enqueueSteeringMessage('agent-a', '第二条');

		// id 用于后续 ack/release 追踪；重复 id 会导致 ack 误伤同批
		assert.notStrictEqual(idA, idB, '同一 agent 的两次投递必须拿到不同 id');
		assert.ok(idA.length > 0 && idB.length > 0);
		driver.dispose();
	});

	test('队列按 agentId 隔离 —— 消息不串台', async () => {
		const driver = createDriverStub();
		await flushStartup();

		driver.enqueueSteeringMessage('agent-a', '给 A 的');
		driver.enqueueSteeringMessage('agent-b', '给 B 的');

		// 串台是这个设计最严重的失效：A 会读到 B 的消息
		const queueA = deliveryQueueOf(driver, 'agent-a');
		const queueB = deliveryQueueOf(driver, 'agent-b');

		assert.strictEqual(queueA.peek('agent-a').length, 1);
		assert.strictEqual(queueA.peek('agent-b').length, 0, 'A 的队列不应含 B 的消息');
		assert.strictEqual(queueB.peek('agent-b').length, 1);
		assert.strictEqual(queueB.peek('agent-a').length, 0, 'B 的队列不应含 A 的消息');

		// 队列实例必须稳定：若每次投递都新建实例，消息虽不串台但 turn 也消费不到
		// （executor 在 turn 启动时取队列引用，之后投递的消息会进另一个实例）。
		const queueAAgain = deliveryQueueOf(driver, 'agent-a');
		assert.strictEqual(queueAAgain, queueA, '同 agent 反复取必须拿到同一实例');
		driver.dispose();
	});

	test('队列懒建：未投递过的 agent 不占队列，首投后才创建', async () => {
		const driver = createDriverStub();
		await flushStartup();

		assert.strictEqual(steeringQueueSizeOf(driver), 0, '初始不应有任何队列');

		driver.enqueueSteeringMessage('agent-a', 'x');
		assert.strictEqual(steeringQueueSizeOf(driver), 1);

		// 同一个 agent 再投递应复用同一条队列（否则 turn 消费不到历史消息）
		driver.enqueueSteeringMessage('agent-a', 'y');
		assert.strictEqual(steeringQueueSizeOf(driver), 1, '同 agent 必须复用队列');
		assert.strictEqual(deliveryQueueOf(driver, 'agent-a').peek('agent-a').length, 2);
		driver.dispose();
	});

	test('队列跨调用存活 —— 模拟「turn 运行中投递，turn 内消费」', async () => {
		const driver = createDriverStub();
		await flushStartup();

		driver.enqueueSteeringMessage('agent-a', '运行中追加的指示');
		// 模拟 turn 内部：取同一队列并 lease
		const queue = deliveryQueueOf(driver, 'agent-a');
		const leased = queue.lease('agent-a', 'turn-1-1');

		assert.strictEqual(leased.length, 1);
		assert.strictEqual(leased[0].content, '运行中追加的指示');
		assert.strictEqual(leased[0].from, 'user', '默认 from 应为 user');

		// ack 后不可再被领取 —— 防止消息投两次
		queue.ack([leased[0].id]);
		assert.strictEqual(queue.lease('agent-a', 'turn-1-2').length, 0);
		driver.dispose();
	});

	test('from 参数可覆盖 —— 支持子任务/子 agent 来源标记', async () => {
		const driver = createDriverStub();
		await flushStartup();

		driver.enqueueSteeringMessage('agent-a', '来自子任务的补充', 'subagent');
		const queued = deliveryQueueOf(driver, 'agent-a').peek('agent-a');

		assert.strictEqual(queued.length, 1);
		assert.strictEqual(queued[0].from, 'subagent');
		driver.dispose();
	});
});
