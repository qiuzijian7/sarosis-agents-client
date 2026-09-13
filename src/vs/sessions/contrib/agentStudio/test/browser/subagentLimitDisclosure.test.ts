/*---------------------------------------------------------------------------------------------
 *  Unit tests for subagentLimitMiddleware — 单轮委派数超限的截断 + 「丢弃必须显式披露」。
 *
 *  ★ 回归守卫（2026-09-11）：超限的委派此前**只打一条 warn 日志**：
 *    ① 委派账本里查不到 —— 调用方只调 `markCancelled`，而条目从未 `markDelegated`
 *       → 对不存在条目是 no-op（本文件用 DelegationLedgerManager 把这个「no-op 事实」钉住，
 *       这样一旦有人把调用方的 markDelegated 去掉，测试就会失败）；
 *    ② 模型收不到任何 tool_result → 以为这些任务都在跑（后续推理建立在错误前提上）。
 *    修复后调用方必须：先 markDelegated 再 markCancelled + 为每个丢弃的 call 补一条
 *    失败 tool_result（`buildDroppedDelegationResult`）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	SubagentLimitMiddleware,
	buildDroppedDelegationResult,
	clampSubagentLimit,
	DEFAULT_MAX_CONCURRENT_SUBAGENTS,
	MAX_SUBAGENT_LIMIT,
	MIN_SUBAGENT_LIMIT,
	SUBAGENT_DELEGATION_TOOL_NAMES,
} from '../../common/subagentLimitMiddleware.js';
import { DelegationLedgerManager } from '../../common/delegationLedger.js';
import type { IToolCallInfo } from '../../common/providers.js';

const call = (id: string, name: string, args: Record<string, unknown> = {}): IToolCallInfo => ({
	id,
	name,
	arguments: JSON.stringify(args),
});
const delegation = (id: string) => call(id, 'delegate_task', { task: `task-${id}` });
const delegations = (n: number, prefix = 'd'): IToolCallInfo[] =>
	Array.from({ length: n }, (_, i) => delegation(`${prefix}${i + 1}`));

suite('subagentLimitMiddleware / 截断语义', () => {

	test('未超限 → 原样返回、无丢弃', () => {
		const calls = delegations(3);
		const r = new SubagentLimitMiddleware(5).apply(calls);
		assert.strictEqual(r.wasTruncated, false);
		assert.strictEqual(r.droppedCalls.length, 0);
		assert.strictEqual(r.toolCalls.length, 3);
		assert.strictEqual(r.originalTaskCount, 3);
		assert.strictEqual(r.keptTaskCount, 3);
	});

	test('恰好等于上限 → 不截断（边界）', () => {
		const r = new SubagentLimitMiddleware(5).apply(delegations(5));
		assert.strictEqual(r.wasTruncated, false);
		assert.strictEqual(r.toolCalls.length, 5);
	});

	test('★ 超限 → 保留前 N 个、其余进 droppedCalls（id 不丢）', () => {
		const calls = delegations(7);
		const r = new SubagentLimitMiddleware(5).apply(calls);
		assert.strictEqual(r.wasTruncated, true);
		assert.strictEqual(r.originalTaskCount, 7);
		assert.strictEqual(r.keptTaskCount, 5);
		assert.deepStrictEqual(r.toolCalls.map(c => c.id), ['d1', 'd2', 'd3', 'd4', 'd5']);
		assert.deepStrictEqual(r.droppedCalls.map(c => c.id), ['d6', 'd7']);
	});

	test('非委派工具调用永不被丢弃，也不占用名额', () => {
		const calls = [
			call('f1', 'file_read'),
			...delegations(6),
			call('f2', 'search_files'),
		];
		const r = new SubagentLimitMiddleware(5).apply(calls);
		const keptIds = r.toolCalls.map(c => c.id);
		assert.ok(keptIds.includes('f1') && keptIds.includes('f2'), '非委派调用必须保留');
		assert.strictEqual(r.keptTaskCount, 5);
		assert.strictEqual(r.droppedCalls.length, 1);
		assert.strictEqual(r.droppedCalls[0].id, 'd6');
	});

	test('默认上限 = 5，且 clamp 到 [2, 5]', () => {
		assert.strictEqual(DEFAULT_MAX_CONCURRENT_SUBAGENTS, 5);
		assert.strictEqual(new SubagentLimitMiddleware().maxConcurrent, 5);
		assert.strictEqual(clampSubagentLimit(1), MIN_SUBAGENT_LIMIT);
		assert.strictEqual(clampSubagentLimit(99), MAX_SUBAGENT_LIMIT);
		assert.strictEqual(clampSubagentLimit(3), 3);
	});

	test('委派工具名集合覆盖 delegate_task / task / spawn_subagent / dispatch_subagent', () => {
		for (const n of ['delegate_task', 'task', 'spawn_subagent', 'dispatch_subagent']) {
			assert.ok(SUBAGENT_DELEGATION_TOOL_NAMES.has(n), `${n} 应被识别为委派调用`);
		}
		assert.ok(!SUBAGENT_DELEGATION_TOOL_NAMES.has('file_read'));
	});
});

suite('subagentLimitMiddleware / 丢弃披露', () => {

	test('★ 每个被丢弃的委派都有可配对的失败 tool_result（披露文案含数量）', () => {
		const r = new SubagentLimitMiddleware(5).apply(delegations(7));
		const results = r.droppedCalls.map(d =>
			buildDroppedDelegationResult(d.id, r.keptTaskCount, r.originalTaskCount));

		// ① toolCallId 必须与模型下发的 id 一一对应，否则无法配对
		assert.deepStrictEqual(results.map(x => x.toolCallId), ['d6', 'd7']);
		for (const x of results) {
			assert.strictEqual(x.success, false, '丢弃必须回失败（不能伪装成成功）');
			assert.strictEqual(x.content.dropped, true);
			assert.strictEqual(x.content.reason, 'subagent_concurrency_limit');
			// ② 文案必须让模型知道「没执行」+ 数量 + 该怎么办
			assert.ok(x.content.message.includes('NOT executed'), x.content.message);
			assert.ok(x.content.message.includes('5'), `应含上限 5：${x.content.message}`);
			assert.ok(x.content.message.includes('7'), `应含提交总数 7：${x.content.message}`);
			assert.ok(x.content.message.includes('Re-submit'), x.content.message);
		}
	});

	test('★ 账本：未登记就 markCancelled 是 no-op（这正是此前「账本查不到」的根因）', () => {
		const ledger = new DelegationLedgerManager();
		ledger.markCancelled('ghost');
		assert.strictEqual(ledger.getAllEntries().length, 0, 'markCancelled 对未登记 id 必须无副作用');
	});

	test('★ 账本：先 markDelegated 再 markCancelled → 条目可见且状态为 cancelled（修复后的调用顺序）', () => {
		const ledger = new DelegationLedgerManager();
		const r = new SubagentLimitMiddleware(5).apply(delegations(7));
		for (const d of r.droppedCalls) {
			ledger.markDelegated(d.id, `task-${d.id}`, 'code-explorer');
			ledger.markCancelled(d.id);
		}
		const entries = ledger.getAllEntries();
		assert.strictEqual(entries.length, 2);
		for (const id of ['d6', 'd7']) {
			const e = entries.find(x => x.callId === id);
			assert.ok(e, `${id} 应进入账本`);
			assert.strictEqual(e.status, 'cancelled');
		}
		// 渲染结果（会被注入 system prompt）必须能体现这两条，否则模型仍看不见
		const rendered = ledger.render();
		assert.ok(rendered.includes('cancelled'), `账本渲染应含 cancelled：${rendered}`);
	});
});
