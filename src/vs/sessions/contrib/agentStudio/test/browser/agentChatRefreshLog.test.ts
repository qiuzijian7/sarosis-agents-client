/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 全量刷新日志回归测试（2026-08-22）。
 *
 * 两组关键断言：
 *  - **格式是对外契约**：我会用 grep/正则从用户导出的 `vscode-app-*.log` 里提取统计，
 *    字段名与分隔符随意改动会让分析失效。
 *  - **聚合不能吞掉首条**：高频来源必须在第一次就可见（否则「刚开始抖」看不到），
 *    同时不能刷屏。
 */

import assert from 'assert';
import {
	FullRefreshLogger, formatFullRefreshLog, type FullRefreshSource,
} from '../../../../browser/agentChat/agentChatPanel.refreshLog.js';

/** 可控时间源 + 捕获 sink。 */
function harness() {
	const lines: string[] = [];
	let now = 1_000_000;
	const logger = new FullRefreshLogger(m => lines.push(m), () => now);
	return {
		lines,
		logger,
		advance: (ms: number) => { now += ms; },
	};
}

suite('agentChatPanel.refreshLog — formatFullRefreshLog（对外契约）', () => {

	test('★ 单条格式：source 必在最前，字段用 key=value 空格分隔', () => {
		const s = formatFullRefreshLog('msg:slowpath-fallback', {
			msgId: 'm1', isStreaming: true, partsLen: 82, toolCalls: 51, contentLen: 33505,
		}, 1);
		assert.strictEqual(
			s,
			'[FullRefresh] source=msg:slowpath-fallback msgId=m1 streaming=true parts=82 toolCalls=51 contentLen=33505');
	});

	test('★ occurrence > 1 时带 ×N（便于 grep 高频来源）', () => {
		const s = formatFullRefreshLog('card:status-change', { toolId: 't7' }, 21);
		assert.match(s, /^\[FullRefresh\] source=card:status-change ×21 toolId=t7$/);
	});

	test('occurrence === 1 时不带 ×（避免噪音）', () => {
		assert.ok(!formatFullRefreshLog('md:incremental-failed', {}, 1).includes('×'));
	});

	test('缺省字段不输出（不打印 undefined）', () => {
		const s = formatFullRefreshLog('msg:bubble-missing', { msgId: 'm2' }, 1);
		assert.strictEqual(s, '[FullRefresh] source=msg:bubble-missing msgId=m2');
		assert.ok(!s.includes('undefined'));
	});

	test('★ contentLen=0 / streaming=false 等假值仍需输出（0 是有意义的信息）', () => {
		const s = formatFullRefreshLog('msg:thinking-state-change', { contentLen: 0, isStreaming: false, partsLen: 0 }, 1);
		assert.match(s, /streaming=false/);
		assert.match(s, /parts=0/);
		assert.match(s, /contentLen=0/);
	});

	test('note 字段用于区分同来源的子场景', () => {
		assert.match(formatFullRefreshLog('card:status-change', { note: 'running->success' }, 1),
			/note=running->success/);
		assert.match(formatFullRefreshLog('md:incremental-failed', { note: 'thinking-md' }, 1),
			/note=thinking-md/);
	});
});

suite('agentChatPanel.refreshLog — 聚合行为', () => {

	test('★ 首次必打（「刚开始抖」必须立刻可见）', () => {
		const h = harness();
		assert.strictEqual(h.logger.record('msg:slowpath-fallback', { msgId: 'm1' }), true);
		assert.strictEqual(h.lines.length, 1);
		assert.match(h.lines[0], /source=msg:slowpath-fallback/);
	});

	test('★★ 第 2..19 次不打（抑制刷屏）', () => {
		const h = harness();
		for (let i = 0; i < 19; i++) { h.logger.record('card:status-change'); }
		assert.strictEqual(h.lines.length, 1, '19 次内只应有首条');
		assert.strictEqual(h.logger.countOf('card:status-change'), 19, '但计数必须准确');
	});

	test('★ 第 21 次打一条并携带累计值', () => {
		const h = harness();
		for (let i = 0; i < 21; i++) { h.logger.record('card:status-change'); }
		assert.strictEqual(h.lines.length, 2);
		assert.match(h.lines[1], /×21/, '第二条必须带累计次数');
	});

	test('★ 300 次高频触发只产生约 15 条日志（体积可控但事实醒目）', () => {
		const h = harness();
		for (let i = 0; i < 300; i++) { h.logger.record('md:incremental-failed'); }
		assert.ok(h.lines.length <= 16, `实际 ${h.lines.length} 条`);
		assert.strictEqual(h.logger.countOf('md:incremental-failed'), 300);
		assert.match(h.lines[h.lines.length - 1], /×\d+/);
	});

	test('★ 不同来源各自独立计数（互不干扰）', () => {
		const h = harness();
		h.logger.record('msg:bubble-missing');
		h.logger.record('card:args-arrived');
		h.logger.record('card:args-arrived');
		assert.strictEqual(h.logger.countOf('msg:bubble-missing'), 1);
		assert.strictEqual(h.logger.countOf('card:args-arrived'), 2);
		assert.strictEqual(h.lines.length, 2, '两个来源各打首条');
	});

	test('★ 超过聚合窗口 → 计数归零、重新必打（跨 turn 不串味）', () => {
		const h = harness();
		h.logger.record('card:status-change');
		assert.strictEqual(h.logger.countOf('card:status-change'), 1);
		h.advance(6000);            // > AGGREGATE_WINDOW_MS(5000)
		h.logger.record('card:status-change');
		assert.strictEqual(h.logger.countOf('card:status-change'), 1, '新窗口应从 1 重新计');
		assert.strictEqual(h.lines.length, 2, '新窗口首条必打');
	});

	test('窗口内连续触发不重置（时间推进但未超窗）', () => {
		const h = harness();
		for (let i = 0; i < 5; i++) { h.logger.record('card:status-change'); h.advance(100); }
		assert.strictEqual(h.logger.countOf('card:status-change'), 5);
	});
});

suite('agentChatPanel.refreshLog — flushSummary', () => {

	test('★ 按次数降序列出所有来源（一眼看出主因）', () => {
		const h = harness();
		for (let i = 0; i < 30; i++) { h.logger.record('card:status-change'); }
		for (let i = 0; i < 5; i++) { h.logger.record('msg:slowpath-fallback'); }
		h.logger.record('msg:bubble-missing');
		h.lines.length = 0;
		h.logger.flushSummary('msgId=m9');

		assert.strictEqual(h.lines.length, 1);
		const s = h.lines[0];
		assert.match(s, /^\[FullRefresh\] SUMMARY \(msgId=m9\) total=36 — /);
		assert.match(s, /card:status-change×30, msg:slowpath-fallback×5, msg:bubble-missing×1/,
			'必须按次数降序');
	});

	test('★ flushSummary 后计数清空（下一轮独立统计）', () => {
		const h = harness();
		h.logger.record('card:status-change');
		h.logger.flushSummary();
		assert.strictEqual(h.logger.countOf('card:status-change'), 0);
	});

	test('★ 无任何全量刷新时不输出 summary（健康路径零噪音）', () => {
		const h = harness();
		h.logger.flushSummary('msgId=m0');
		assert.strictEqual(h.lines.length, 0, '没有全量刷新就不该有日志');
	});

	test('context 可省略', () => {
		const h = harness();
		h.logger.record('md:incremental-failed');
		h.lines.length = 0;
		h.logger.flushSummary();
		assert.match(h.lines[0], /^\[FullRefresh\] SUMMARY total=1 — md:incremental-failed×1$/);
	});
});

suite('agentChatPanel.refreshLog — 来源覆盖度', () => {

	test('★ 所有来源都能被记录且格式合法（防新增来源漏测）', () => {
		const all: FullRefreshSource[] = [
			'msg:slowpath-fallback',
			'msg:thinking-state-change',
			'msg:stream-end-structural',
			'msg:streaming-structure-changed',
			'msg:streaming-container-missing',
			'msg:subagent-card-missing',
			'msg:bubble-missing',
			'msg:keyed-inconsistent',
			'card:status-change',
			'card:args-arrived',
			'card:progress-row-missing',
			'md:incremental-failed',
		];
		const h = harness();
		for (const s of all) { h.logger.record(s, { msgId: 'm' }); }
		assert.strictEqual(h.lines.length, all.length, '每个来源都应打首条');
		for (const line of h.lines) {
			assert.match(line, /^\[FullRefresh\] source=(?:msg|card|md):[a-z-]+ /,
				`格式不合法: ${line}`);
		}
	});

	test('★ msg:keyed-inconsistent 携带 DOM/期望数对比（定位 keyed diff bug）', () => {
		// 该来源出现即说明 keyed diff 有真 bug，note 必须带能直接定位的实参
		const s = formatFullRefreshLog('msg:keyed-inconsistent', {
			msgId: 'm1', partsLen: 124, toolCalls: 73, note: 'domParts=120 expected=124',
		}, 1);
		assert.match(s, /note=domParts=120 expected=124/);
	});

	test('★ 来源前缀区分三个层级（msg / card / md）', () => {
		// 前缀是分析日志时的第一层分类：整条消息重建 vs 单卡重建 vs markdown 子树替换
		const h = harness();
		h.logger.record('msg:bubble-missing');
		h.logger.record('card:status-change');
		h.logger.record('md:incremental-failed');
		assert.match(h.lines[0], /source=msg:/);
		assert.match(h.lines[1], /source=card:/);
		assert.match(h.lines[2], /source=md:/);
	});
});
