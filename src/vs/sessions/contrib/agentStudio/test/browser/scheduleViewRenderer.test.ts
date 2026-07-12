/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── ScheduleViewRenderer 单测（Plan D 定时任务视图 + 纯函数 + 新建弹窗）──

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ScheduleViewRenderer, formatDateTime, formatCountdown } from '../../browser/scheduleViewRenderer.js';
import { ScheduleState } from '../../common/agentScheduler.js';
import type { IScheduleInfo, IScheduleInput } from '../../common/agentScheduler.js';

function input(taskId = 'task-1', workspaceId = 'ws-1'): IScheduleInput {
	return { messageTemplate: 'run', context: { taskId, workspaceId } };
}

function makeRule(over: Partial<IScheduleInfo> & { config?: any }): IScheduleInfo {
	return {
		id: 's-1',
		name: '晨会提醒',
		type: 'cron',
		instanceId: 'agent-A',
		state: ScheduleState.Active,
		createdAt: 0,
		totalExecutions: 0,
		totalFailures: 0,
		config: { name: '晨会提醒', instanceId: 'agent-A', cronExpression: '0 9 * * 1-5', inputTemplate: input() },
		...over,
	} as IScheduleInfo;
}

function mockTask(id = 'task-1', title = '登录页', assigneeName = 'Agent One', assigneeId = 'agent-A') {
	return { id, title, assigneeName, assigneeId, status: 'todo' } as any;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. 纯函数（无需 DOM）
// ═══════════════════════════════════════════════════════════════════════════════

suite('ScheduleViewRenderer — 纯函数', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formatDateTime 输出 YYYY-MM-DD HH:mm 并补零', () => {
		const ms = new Date(2026, 0, 1, 9, 5, 30).getTime(); // 2026-01-01 09:05
		assert.strictEqual(formatDateTime(ms), '2026-01-01 09:05');
		const ms2 = new Date(2026, 10, 12, 3, 0).getTime();
		assert.strictEqual(formatDateTime(ms2), '2026-11-12 03:00');
	});

	test('formatCountdown 各量级格式化', () => {
		assert.strictEqual(formatCountdown(Date.now() - 1), '即将执行');
		// 5 天 3 小时
		assert.strictEqual(formatCountdown(Date.now() + (5 * 86400 + 3 * 3600) * 1000), '5d 3h');
		// 2 小时 30 分
		assert.strictEqual(formatCountdown(Date.now() + (2 * 3600 + 30 * 60) * 1000), '2h 30m');
		// 45 分
		assert.strictEqual(formatCountdown(Date.now() + 45 * 60 * 1000), '45m');
		// 30 秒
		assert.strictEqual(formatCountdown(Date.now() + 30 * 1000), '30s');
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DOM 渲染 + 新建/编辑弹窗（浏览器测试环境提供 document）
// ═══════════════════════════════════════════════════════════════════════════════

suite('ScheduleViewRenderer — 渲染与弹窗', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 仅当 document 可用时注册 DOM 相关用例（browser 环境应始终满足）
	if (typeof document === 'undefined') {
		return;
	}

	let parent: HTMLElement;

	setup(() => {
		parent = document.createElement('div');
		document.body.appendChild(parent);
	});

	teardown(() => {
		parent.remove();
	});

	test('空列表渲染空状态与汇总文案', () => {
		const r = new ScheduleViewRenderer();
		try {
			r.create(parent);
			r.render([], []);
			assert.ok(parent.querySelector('.sched-empty'), '应显示空状态');
			assert.strictEqual(parent.querySelector('.sched-table-container'), null, '无表格');
			const summary = parent.querySelector('.sched-view-footer span')?.textContent ?? '';
			assert.ok(summary.includes('共 0 条定时任务'), `汇总应为 0 条，实际: ${summary}`);
		} finally {
			r.dispose();
		}
	});

	test('渲染表格行数等于规则数，并展示任务名/状态/规则/倒计时', () => {
		const r = new ScheduleViewRenderer();
		const rules = [
			makeRule({ id: 's-1', nextFireAt: Date.now() + 60000 }),
			makeRule({ id: 's-2', state: ScheduleState.Paused, name: '心跳',
				type: 'interval', config: { name: '心跳', instanceId: 'agent-A', intervalMs: 60000, inputTemplate: input('task-2') } }),
		];
		const tasks = [mockTask('task-1', '登录页'), mockTask('task-2', 'API 文档', 'Agent Two')];
		try {
			r.create(parent);
			r.render(rules, tasks);
			const rows = parent.querySelectorAll('.sched-table tbody tr');
			assert.strictEqual(rows.length, 2, '应渲染 2 行');

			// 活跃行的倒计时徽标存在
			assert.ok(parent.querySelector('.sched-countdown'), '活跃行应有倒计时徽标');
			// 暂停行带 paused-row 类
			assert.ok(parent.querySelector('tr.paused-row'), '暂停行应有 paused-row 类');

			// cron 规则文案 = 表达式
			const ruleCols = parent.querySelectorAll('.sched-rule-col');
			assert.ok(ruleCols[0].textContent?.includes('0 9 * * 1-5'), 'cron 规则应显示表达式');
			// interval 规则文案 = 「每 1 分钟」
			assert.ok(ruleCols[1].textContent?.includes('每 1 分钟'), `interval 规则应显示「每 1 分钟」，实际: ${ruleCols[1].textContent}`);
		} finally {
			r.dispose();
		}
	});

	test('active 行状态徽标为 ● 活跃', () => {
		const r = new ScheduleViewRenderer();
		try {
			r.create(parent);
			r.render([makeRule({ id: 's-1', nextFireAt: Date.now() + 60000 })], [mockTask()]);
			const badge = parent.querySelector('.sched-status-badge.active');
			assert.ok(badge, '应存在 active 状态徽标');
			assert.ok(badge!.textContent?.includes('活跃'), `徽标文案含「活跃」，实际: ${badge!.textContent}`);
		} finally {
			r.dispose();
		}
	});

	test('新建定时任务按钮触发 onCreateRequest', () => {
		const r = new ScheduleViewRenderer();
		try {
			r.create(parent);
			r.render([], []);
			let created = 0;
			r.onCreateRequest(e => { created++; });
			(parent.querySelector('.sched-view-footer .sched-btn-primary') as HTMLButtonElement).click();
			assert.strictEqual(created, 1, '点击「新建定时任务」应 fire onCreateRequest');
		} finally {
			r.dispose();
		}
	});

	test('showScheduleModal 默认（cron）保存生成正确 draft', () => {
		const r = new ScheduleViewRenderer();
		let saved: any = null;
		try {
			const tasks = [mockTask('task-1', '登录页')];
			r.showScheduleModal(parent, tasks, (draft) => { saved = draft; });
			assert.ok(parent.querySelector('.sched-modal-overlay'), '应打开弹窗');

			const sel = parent.querySelector('.sched-modal select') as HTMLSelectElement;
			sel.value = 'task-1';
			(parent.querySelector('.sched-modal .sched-btn-primary') as HTMLButtonElement).click();

			assert.ok(saved, '应回调 onSave');
			assert.strictEqual(saved.taskId, 'task-1');
			assert.strictEqual(saved.type, 'cron');
			assert.strictEqual(saved.cronExpression, '0 9 * * 1-5', '默认 cron 表达式');
			assert.strictEqual(saved.maxRetries, 0);
		} finally {
			r.dispose();
		}
	});

	test('showScheduleModal presetTaskId 锁定时不可改且 draft.taskId = preset', () => {
		const r = new ScheduleViewRenderer();
		let saved: any = null;
		try {
			const tasks = [mockTask('task-1'), mockTask('task-2', '看板', 'A2', 'agent-B')];
			r.showScheduleModal(parent, tasks, (d) => { saved = d; }, undefined, 'task-2');
			const sel = parent.querySelector('.sched-modal select') as HTMLSelectElement;
			assert.ok(sel.disabled, '锁定任务时选择器应禁用');
			(parent.querySelector('.sched-modal .sched-btn-primary') as HTMLButtonElement).click();
			assert.strictEqual(saved.taskId, 'task-2', 'draft.taskId 应为 preset 值');
		} finally {
			r.dispose();
		}
	});

	test('showScheduleModal interval 类型保存生成 intervalMs draft', () => {
		const r = new ScheduleViewRenderer();
		let saved: any = null;
		try {
			const tasks = [mockTask('task-1')];
			r.showScheduleModal(parent, tasks, (d) => { saved = d; });
			// 切到「固定间隔」tab
			const tabs = parent.querySelectorAll('.sched-type-tab');
			(tabs[1] as HTMLButtonElement).click();
			// 单位默认是「小时」，显式切到「分钟」(60000ms) 再设数值
			const selects = parent.querySelectorAll('.sched-modal select') as NodeListOf<HTMLSelectElement>;
			const unitSelect = selects[1]; // [0]=任务选择, [1]=间隔单位
			unitSelect.value = '60000';
			unitSelect.dispatchEvent(new Event('change'));
			const numInput = parent.querySelector('.sched-modal input[type="number"]') as HTMLInputElement;
			numInput.value = '30';
			numInput.dispatchEvent(new Event('input'));
			(parent.querySelector('.sched-modal .sched-btn-primary') as HTMLButtonElement).click();
			assert.strictEqual(saved.type, 'interval');
			assert.strictEqual(saved.intervalMs, 30 * 60000, '30 分钟 = 1800000ms');
		} finally {
			r.dispose();
		}
	});

	test('showScheduleModal edit 预填 cron 表达式与类型', () => {
		const r = new ScheduleViewRenderer();
		try {
			const tasks = [mockTask('task-1')];
			r.showScheduleModal(parent, tasks, () => {}, {
				id: 's-9', taskId: 'task-1', type: 'cron', cronExpression: '0 2 * * *', maxRetries: 3,
			});
			const cronInput = parent.querySelector('.sched-modal input[type="text"]') as HTMLInputElement;
			assert.strictEqual(cronInput.value, '0 2 * * *', '应预填编辑的 cron 表达式');
		} finally {
			r.dispose();
		}
	});

	test('无指派 Agent 的任务时任务选择器禁用', () => {
		const r = new ScheduleViewRenderer();
		try {
			const tasks = [{ id: 'task-x', title: '未指派', status: 'todo' } as any];
			r.showScheduleModal(parent, tasks, () => {});
			const sel = parent.querySelector('.sched-modal select') as HTMLSelectElement;
			assert.ok(sel.disabled, '无可调度任务时选择器应禁用');
		} finally {
			r.dispose();
		}
	});
});
