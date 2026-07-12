/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── AgentSchedulerService 单测（Plan D 定时功能核心逻辑）──

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentSchedulerService } from '../../browser/agentSchedulerService.js';
import { ScheduleState, OverlapPolicy } from '../../common/agentScheduler.js';
import type { IScheduleInput, ICronScheduleConfig, IIntervalConfig, IOneShotConfig } from '../../common/agentScheduler.js';

// ─── Mock 依赖 ────────────────────────────────────────────────────────────────

function mockLogService(): any {
	return {
		info() {}, warn() {}, error() {}, debug() {}, trace() {},
		getLevel: () => 0, setLevel() {}, onDidChangeLogLevel: Event.None, dispose() {},
	};
}

function mockFileService(): any {
	return { watch: () => ({ dispose() {} }) };
}

function mockWorkspaceContextService(): any {
	return { getWorkspace: () => ({ folders: [] }) };
}

function mockEventBridge(): any {
	return { on: () => ({ dispose() {} }) };
}

function makeScheduler(): AgentSchedulerService {
	return new AgentSchedulerService(
		mockLogService(),
		mockFileService(),
		mockWorkspaceContextService(),
		mockEventBridge(),
	);
}

function input(context?: Record<string, unknown>): IScheduleInput {
	return {
		messageTemplate: 'run task {{timestamp}}',
		context: { taskId: 'task-1', workspaceId: 'ws-1', ...context },
	};
}

function cronConfig(instanceId: string, expr = '0 9 * * 1-5'): ICronScheduleConfig {
	return {
		name: '工作日晨报',
		instanceId,
		cronExpression: expr,
		inputTemplate: input(),
		executionPolicy: { overlap: OverlapPolicy.Skip, maxRetries: 2 },
	};
}

function intervalConfig(instanceId: string, intervalMs = 60000): IIntervalConfig {
	return { name: '心跳', instanceId, intervalMs, inputTemplate: input() };
}

function oneShotConfig(instanceId: string, triggerAt: number): IOneShotConfig {
	return { name: '一次性', instanceId, triggerAt, inputTemplate: input() };
}

suite('AgentSchedulerService (Plan D)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('registerCron 返回 handle、fire created 事件并进入列表', () => {
		const svc = makeScheduler();
		try {
			const changes: string[] = [];
			svc.onDidScheduleChange(e => changes.push(e.changeType));

			const handle = svc.registerCron(cronConfig('agent-A'));
			assert.ok(typeof handle.scheduleId === 'string' && handle.scheduleId.length > 0, '应返回 scheduleId');
			assert.strictEqual(handle.type, 'cron');
			assert.ok(changes.includes('created'), '应 fire created 事件');

			const all = svc.listAllSchedules('');
			assert.strictEqual(all.length, 1);
			assert.strictEqual(all[0].id, handle.scheduleId);
			assert.strictEqual(all[0].state, ScheduleState.Active);
		} finally {
			svc.dispose();
		}
	});

	test('registerCron 的有效 cron 计算出未来的下次触发时间', () => {
		const svc = makeScheduler();
		const handle = svc.registerCron(cronConfig('agent-A'));
		try {
			const next = handle.getNextFireTime();
			assert.ok(typeof next === 'number', 'getNextFireTime 应返回数字');
			assert.ok(next! > Date.now(), '下次触发时间应在未来');
		} finally {
			handle.dispose();
			svc.dispose();
		}
	});

	test('无效 cron 表达式注册成功但 nextFireTime 为 null', () => {
		const svc = makeScheduler();
		const handle = svc.registerCron(cronConfig('agent-A', 'not a cron'));
		try {
			assert.strictEqual(handle.getNextFireTime(), null, '无效表达式应返回 null');
		} finally {
			handle.dispose();
			svc.dispose();
		}
	});

	test('listSchedules 按 instanceId 过滤，listAllSchedules 忽略 workspaceId', () => {
		const svc = makeScheduler();
		const hA = svc.registerCron(cronConfig('agent-A'));
		const hB = svc.registerInterval(intervalConfig('agent-B'));
		try {
			assert.strictEqual(svc.listSchedules('agent-A').length, 1, 'agent-A 仅 1 条');
			assert.strictEqual(svc.listSchedules('agent-B').length, 1, 'agent-B 仅 1 条');
			assert.strictEqual(svc.listSchedules('agent-C').length, 0, '其他实例 0 条');
			// listAllSchedules 忽略 workspaceId 参数，返回全部
			assert.strictEqual(svc.listAllSchedules('').length, 2);
			assert.strictEqual(svc.listAllSchedules('ws-any').length, 2);
		} finally {
			hA.dispose(); hB.dispose();
			svc.dispose();
		}
	});

	test('pause / resume 切换状态并 fire 对应事件', () => {
		const svc = makeScheduler();
		const handle = svc.registerCron(cronConfig('agent-A'));
		try {
			const changes: string[] = [];
			svc.onDidScheduleChange(e => changes.push(e.changeType));

			svc.pauseSchedule(handle.scheduleId);
			assert.strictEqual(svc.listAllSchedules('')[0].state, ScheduleState.Paused, '应变为 Paused');
			assert.ok(changes.includes('paused'), '应 fire paused');

			svc.resumeSchedule(handle.scheduleId);
			assert.strictEqual(svc.listAllSchedules('')[0].state, ScheduleState.Active, '应恢复 Active');
			assert.ok(changes.includes('resumed'), '应 fire resumed');

			// 重复 pause / resume 不应重复 fire
			svc.pauseSchedule(handle.scheduleId); // Paused
			svc.pauseSchedule(handle.scheduleId); // 已是 Paused，不再 fire
			const pausedCount = changes.filter(c => c === 'paused').length;
			assert.strictEqual(pausedCount, 1, '重复 pause 不应产生多余 paused 事件');
		} finally {
			handle.dispose();
			svc.dispose();
		}
	});

	test('removeSchedule 移除条目并 fire removed 事件', () => {
		const svc = makeScheduler();
		const handle = svc.registerCron(cronConfig('agent-A'));
		try {
			const changes: string[] = [];
			svc.onDidScheduleChange(e => changes.push(e.changeType));

			svc.removeSchedule(handle.scheduleId);
			assert.strictEqual(svc.listAllSchedules('').length, 0, '移除后应无条目');
			assert.ok(changes.includes('removed'), '应 fire removed');
		} finally {
			svc.dispose();
		}
	});

	test('triggerNow 通过 handle 立即执行并 fire onDidTrigger', async () => {
		const svc = makeScheduler();
		const handle = svc.registerInterval(intervalConfig('agent-A'));
		try {
			let triggered = 0;
			let lastInput: IScheduleInput | undefined;
			svc.onDidTrigger(e => { triggered++; lastInput = e.input; });

			await handle.triggerNow();

			assert.strictEqual(triggered, 1, 'triggerNow 应 fire 一次 onDidTrigger');
			assert.ok(lastInput && lastInput.messageTemplate.includes('run task'), '触发事件应携带 input');
		} finally {
			handle.dispose();
			svc.dispose();
		}
	});

	test('过期的 one-shot 立即执行且 handle 标记为 completed', () => {
		const svc = makeScheduler();
		let triggered = 0;
		svc.onDidTrigger(() => { triggered++; });
		// triggerAt 在过去 → 注册时立即执行
		const handle = svc.registerOneShot(oneShotConfig('agent-A', Date.now() - 1000));
		try {
			assert.strictEqual(triggered, 1, '过期 one-shot 注册时应立即执行');
			assert.strictEqual(handle.type, 'one-shot');
			assert.strictEqual(handle.getNextFireTime(), null, '已完成 one-shot 无下次触发');
		} finally {
			svc.dispose();
		}
	});

	test('未来的 one-shot 注册后进入列表且状态 Active', () => {
		const svc = makeScheduler();
		const handle = svc.registerOneShot(oneShotConfig('agent-A', Date.now() + 60000));
		try {
			const info = svc.listAllSchedules('')[0];
			assert.strictEqual(info.state, ScheduleState.Active);
			assert.strictEqual(info.type, 'one-shot');
			assert.ok(typeof info.nextFireAt === 'number' && info.nextFireAt! > Date.now());
		} finally {
			handle.dispose();
			svc.dispose();
		}
	});

	test('interval 的 nextFireAt 约为 now + intervalMs', () => {
		const svc = makeScheduler();
		const handle = svc.registerInterval(intervalConfig('agent-A', 120000));
		try {
			const next = handle.getNextFireTime()!;
			const delta = next - Date.now();
			assert.ok(delta > 100000 && delta <= 120000 + 5000, `nextFireAt 应在 [100s,125s] 区间，实际 ${delta}ms`);
		} finally {
			handle.dispose();
			svc.dispose();
		}
	});
});
