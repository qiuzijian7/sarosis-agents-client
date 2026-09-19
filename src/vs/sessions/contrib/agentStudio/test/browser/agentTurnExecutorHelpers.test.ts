/**
 * 循环体抽出函数单测 —— `injectSteeringMessages` / `classifyBudgetGate`。
 *
 * ## 为什么这些用例重要
 *
 * 这两个函数原先内联在 `executeAgentTurnDirect`（4112 行）里，**无法单测**——
 * 当时只能靠 `agentSteeringContract.test.ts` 扫源码断言「`lease(` 调用存在」
 * 来间接守护，测不到行为对错。
 *
 * 抽出后本文件补上行为验证，覆盖两类真实故障：
 *   1. 注入失败后**重复注入**：租约 release 后消息回到 pending，
 *      若同时保留已追加的部分，下一轮会再注入一次（用户看到消息出现两遍）。
 *   2. 预算耗尽**跳过收尾轮**：直接硬停会丢弃末轮发起的 delegate_task 成果
 *      （故障日志 1787214724132，见 agentTurnExecutor.ts:2198-2204 注释）。
 *
 * 注：前两个函数已进一步下沉到 `common/loopGate.ts`（避免 turnIterationGate
 * 与 agentTurnExecutor 形成循环依赖），import 源已随之更新。
 */

import * as assert from 'assert';
import {
	buildCheckpointSnapshot,
} from '../../browser/agentTurnExecutor.js';
import {
	classifyBudgetGate,
	injectSteeringMessages,
} from '../../common/loopGate.js';
import { createDeliveryQueue } from '../../common/deliveryQueue.js';
import { appendMessages, createInitialRunState } from '../../common/agentRunState.js';
import type { AgentRunMessage } from '../../common/agentRunState.js';
import type { BudgetSnapshot } from '../../common/iterationBudget.js';

/** 静默日志桩，同时记录调用以便断言。 */
function createLogSpy(): { info(msg: string): void; warn(msg: string): void; infos: string[]; warns: string[] } {
	const infos: string[] = [];
	const warns: string[] = [];
	return {
		infos,
		warns,
		info: (msg: string) => { infos.push(msg); },
		warn: (msg: string) => { warns.push(msg); },
	};
}

const appendOne = (current: ReadonlyArray<AgentRunMessage>, content: string): AgentRunMessage[] =>
	appendMessages(current as AgentRunMessage[], { role: 'user', content } as AgentRunMessage);

suite('injectSteeringMessages — 运行中消息注入', () => {

	test('队列为空时原样返回，不新增消息', () => {
		const log = createLogSpy();
		const seed: AgentRunMessage[] = [{ role: 'user', content: '原始消息' } as AgentRunMessage];

		const result = injectSteeringMessages(
			createDeliveryQueue(), 'agent-a', 1, 'lease-1', seed, appendOne, log,
		);

		assert.strictEqual(result.injectedCount, 0);
		assert.strictEqual(result.messages, seed, '无消息时应返回同一引用，避免无谓重赋值');
		assert.strictEqual(log.infos.length, 0);
	});

	test('未提供队列时安全短路（steering 未启用路径）', () => {
		const log = createLogSpy();
		const seed: AgentRunMessage[] = [];

		const result = injectSteeringMessages(
			undefined, 'agent-a', 1, 'lease-1', seed, appendOne, log,
		);

		assert.strictEqual(result.injectedCount, 0);
		assert.strictEqual(result.messages, seed);
	});

	test('注入成功：按入队序追加，且不修改入参数组', () => {
		const log = createLogSpy();
		const queue = createDeliveryQueue();
		queue.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: '第一条' });
		queue.enqueue({ id: 'm2', from: 'user', to: 'agent-a', content: '第二条' });
		const seed: AgentRunMessage[] = [{ role: 'assistant', content: '前情' } as AgentRunMessage];

		const result = injectSteeringMessages(
			queue, 'agent-a', 3, 'lease-1', seed, appendOne, log,
		);

		assert.strictEqual(result.injectedCount, 2);
		assert.strictEqual(result.messages.length, 3);
		assert.strictEqual((result.messages[1] as { content: string }).content, '第一条');
		assert.strictEqual((result.messages[2] as { content: string }).content, '第二条');
		// 不可变：入参数组绝不被就地修改（否则调用方持有的旧引用会被静默污染）
		assert.strictEqual(seed.length, 1, '入参数组被就地修改了');
		assert.ok(log.infos.length > 0, '应记录注入日志便于线上归因');
	});

	test('注入成功后 ack —— 同批消息不会被下一轮重复领取', () => {
		const log = createLogSpy();
		const queue = createDeliveryQueue();
		queue.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: '一次性的' });

		injectSteeringMessages(queue, 'agent-a', 1, 'lease-1', [], appendOne, log);
		const second = injectSteeringMessages(queue, 'agent-a', 2, 'lease-2', [], appendOne, log);

		assert.strictEqual(second.injectedCount, 0, '已 ack 的消息被重复注入了');
	});

	test('追加抛错：释放租约且不保留部分追加（防重复注入）', () => {
		const log = createLogSpy();
		const queue = createDeliveryQueue();
		queue.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: '会失败的' });
		const seed: AgentRunMessage[] = [{ role: 'assistant', content: '前情' } as AgentRunMessage];

		const throwingAppend = (): AgentRunMessage[] => { throw new Error('模拟追加失败'); };
		const result = injectSteeringMessages(
			queue, 'agent-a', 1, 'lease-1', seed, throwingAppend, log,
		);

		// 关键：不保留部分追加。若保留，租约释放回 pending 后下一轮会再注入一次。
		assert.strictEqual(result.injectedCount, 0);
		assert.strictEqual(result.messages, seed, '失败时不应返回部分追加的结果');
		assert.ok(log.warns.length > 0, '失败应告警');

		// 租约已 release → 消息回到 pending，可被下一轮重新领取（不丢失）
		const retry = injectSteeringMessages(queue, 'agent-a', 2, 'lease-2', seed, appendOne, log);
		assert.strictEqual(retry.injectedCount, 1, '释放后消息应可重试，不能永久卡死');
	});

	test('部分追加后抛错：已追加的那条必须回滚（否则下一轮重复注入）', () => {
		// 这是「防重复注入」最容易漏的场景：先成功追加一条、第二条才抛错。
		// 若失败时返回 nextMessages（含第一条），租约 release 后该条回到 pending，
		// 下一轮重试会再注入一次 —— 用户在聊天区看到同一条消息出现两遍。
		const log = createLogSpy();
		const queue = createDeliveryQueue();
		queue.enqueue({ id: 'm1', from: 'user', to: 'agent-a', content: '第一条会成功' });
		queue.enqueue({ id: 'm2', from: 'user', to: 'agent-a', content: '第二条会失败' });
		const seed: AgentRunMessage[] = [{ role: 'assistant', content: '前情' } as AgentRunMessage];

		let callCount = 0;
		const failOnSecond = (current: ReadonlyArray<AgentRunMessage>, content: string): AgentRunMessage[] => {
			callCount++;
			if (callCount >= 2) { throw new Error('第二条追加失败'); }
			return appendMessages(current as AgentRunMessage[], { role: 'user', content } as AgentRunMessage);
		};

		const result = injectSteeringMessages(
			queue, 'agent-a', 1, 'lease-1', seed, failOnSecond, log,
		);

		assert.ok(callCount >= 2, '测试前提：应已成功追加过至少一条');
		assert.strictEqual(result.injectedCount, 0);
		assert.strictEqual(
			result.messages.length,
			seed.length,
			'失败时把已追加的部分带出去了 —— 下一轮会重复注入',
		);
		assert.strictEqual(result.messages, seed);

		// 两条都回到 pending，可整体重试
		const retry = injectSteeringMessages(queue, 'agent-a', 2, 'lease-2', seed, appendOne, log);
		assert.strictEqual(retry.injectedCount, 2, '两条都应可重试');
	});

	test('按 agentId 隔离：不领取其它 agent 的消息', () => {
		const log = createLogSpy();
		const queue = createDeliveryQueue();
		queue.enqueue({ id: 'm1', from: 'user', to: 'agent-b', content: '给 B 的' });

		const result = injectSteeringMessages(
			queue, 'agent-a', 1, 'lease-1', [], appendOne, log,
		);

		assert.strictEqual(result.injectedCount, 0, 'A 不应领取 B 的消息');
	});
});

suite('classifyBudgetGate — 预算门控裁决', () => {

	test('有预算余量 → 继续', () => {
		assert.strictEqual(classifyBudgetGate(true, false, false), 'continue');
		assert.strictEqual(classifyBudgetGate(true, true, true), 'continue');
	});

	test('预算耗尽但有 grace → 继续', () => {
		assert.strictEqual(classifyBudgetGate(false, true, false), 'continue');
	});

	test('预算耗尽且无 grace、未跑收尾轮 → 转入收尾轮（而非直接停）', () => {
		// 这是两段式语义的核心：先给模型一次「禁用工具、仅输出结论」的机会，
		// 否则末轮工具成果会被丢弃（故障日志 1787214724132）。
		assert.strictEqual(classifyBudgetGate(false, false, false), 'wrap-up');
	});

	test('预算耗尽、收尾轮已跑过 → 硬停（防死循环）', () => {
		assert.strictEqual(classifyBudgetGate(false, false, true), 'stop');
	});
});

suite('buildCheckpointSnapshot — 断点快照构造', () => {

	const budgetSnapshot: BudgetSnapshot = {
		maxIterations: 90,
		remaining: 42,
		consumed: 48,
		graceCall: true,
		graceUsed: false,
	};

	test('预算写入快照（恢复后不重复消耗）', () => {
		const state = createInitialRunState({});
		const snap = buildCheckpointSnapshot(state, budgetSnapshot, [], 'react', 7);

		assert.deepStrictEqual(snap.state.budgetSnapshot, budgetSnapshot,
			'budget 必须落盘，否则中断恢复后预算归零、被重复消耗');
	});

	test('返回带版本的信封（restore 侧据此拒绝过高版本）', () => {
		// snapshotRunState 返回 { version, state } 而非裸 state：
		// 若误当作裸 state 消费，所有字段都会是 undefined（本次抽取时真实踩过）。
		const snap = buildCheckpointSnapshot(createInitialRunState({}), budgetSnapshot, [], 'react', 1);

		assert.strictEqual(typeof snap.version, 'number', '快照必须带 version');
		assert.ok(snap.state, '状态必须挂在 state 字段下');
	});

	test('messages 同时写入真身与兼容镜像', () => {
		// P0-a-2 的历史坑：SET_LOOP_MESSAGES 曾只写 loopMessages，导致快照里
		// messages 恒为空壳。此处锁死「两者都存在且内容一致」。
		const state = createInitialRunState({});
		const msgs = appendOne([], 'hello') as AgentRunMessage[];
		const snap = buildCheckpointSnapshot(state, budgetSnapshot, msgs, 'react', 1);

		assert.deepStrictEqual(snap.state.messages, msgs, 'messages 是真身');
		assert.deepStrictEqual(snap.state.loopMessages, msgs, 'loopMessages 是旧恢复路径的兼容镜像');
	});

	test('范式写入快照（恢复时重建同一策略）', () => {
		const state = createInitialRunState({ paradigm: 'react' });
		const snap = buildCheckpointSnapshot(state, budgetSnapshot, [], 'plan-explore', 3);

		assert.strictEqual(snap.state.paradigm, 'plan-explore',
			'范式漂移会让恢复后的策略钩子与原始运行对不上');
	});

	test('iteration 显式透传（不进 reducer，属步进计数器）', () => {
		const state = createInitialRunState({});
		const snap = buildCheckpointSnapshot(state, budgetSnapshot, [], 'react', 11);

		assert.strictEqual(snap.state.iteration, 11, 'iteration 由调用方透传，缺失会导致恢复后续跑点错位');
	});

	test('快照是深拷贝，改快照不影响源 state', () => {
		// checkpoint 是 fire-and-forget 异步落盘：若与源共享引用，循环后续轮次
		// 继续 mutate 会把「过去某一轮的快照」污染成最新状态。
		const state = createInitialRunState({});
		const msgs = appendOne([], 'original') as AgentRunMessage[];
		const snap = buildCheckpointSnapshot(state, budgetSnapshot, msgs, 'react', 5);

		snap.state.messages.push({ role: 'user', content: 'mutated' } as AgentRunMessage);

		assert.strictEqual(msgs.length, 1, '源 messages 不应被快照的改动波及');
		assert.notStrictEqual(snap.state.messages, msgs, '快照必须是独立副本');
	});
});
