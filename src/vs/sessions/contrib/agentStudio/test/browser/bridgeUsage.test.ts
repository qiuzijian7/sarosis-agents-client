/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── P3：BridgeUsageReporter 单测 ──

import assert from 'assert';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { BridgeUsageReporter, IUsageStatsStore, UsageSnapshot } from '../../browser/bridge/bridgeUsage.js';

/** 内存态存储，模拟持久化落盘/恢复。 */
function memUsageStore(): IUsageStatsStore & { snapshot?: UsageSnapshot; saves: number } {
	let snapshot: UsageSnapshot | undefined;
	const store: IUsageStatsStore & { snapshot?: UsageSnapshot; saves: number } = {
		snapshot: undefined,
		saves: 0,
		load() { return snapshot; },
		save(s: UsageSnapshot) { this.saves++; snapshot = s; this.snapshot = s; },
	};
	return store;
}

function makeLog(): ILogService {
	return { debug() {}, info() {}, warn() {}, error() {}, trace() {}, dispose() {} } as unknown as ILogService;
}

suite('BridgeUsageReporter (P3)', () => {
	test('record 累计 prompt/completion/total/calls', () => {
		const r = new BridgeUsageReporter(makeLog());
		r.record('s1', 'coder', { inputTokens: 10, outputTokens: 5 });
		r.record('s1', 'coder', { inputTokens: 20, outputTokens: 8, cachedTokens: 3, totalTokens: 31, credit: 2 });
		const a = r.getAgentStats('coder')!;
		assert.strictEqual(a.promptTokens, 30);
		assert.strictEqual(a.completionTokens, 13);
		assert.strictEqual(a.cachedTokens, 3);
		assert.strictEqual(a.totalTokens, 41); // 10+5 + 31
		assert.strictEqual(a.calls, 2);
		assert.strictEqual(a.credit, 2);
	});

	test('按 sessionKey / agentId 过滤', () => {
		const r = new BridgeUsageReporter(makeLog());
		r.record('sa', 'coder', { inputTokens: 10, outputTokens: 1 });
		r.record('sb', 'coder', { inputTokens: 20, outputTokens: 2 });
		assert.strictEqual(r.getSessionStats('sa')!.promptTokens, 10);
		const bySession = r.summarize({ sessionKey: 'sb' });
		assert.strictEqual(bySession.length, 1);
		assert.strictEqual(bySession[0].promptTokens, 20);
		const byAgent = r.summarize({ agentId: 'coder' });
		assert.strictEqual(byAgent.length, 1);
		assert.strictEqual(byAgent[0].promptTokens, 30);
	});

	test('getGlobal 聚合全部 Agent', () => {
		const r = new BridgeUsageReporter(makeLog());
		r.record('s1', 'a', { inputTokens: 10, outputTokens: 1 });
		r.record('s2', 'b', { inputTokens: 20, outputTokens: 2 });
		const g = r.getGlobal();
		assert.strictEqual(g.promptTokens, 30);
		assert.strictEqual(g.completionTokens, 3);
		assert.strictEqual(g.calls, 2);
	});

	test('reset 清空所有统计', () => {
		const r = new BridgeUsageReporter(makeLog());
		r.record('s1', 'coder', { inputTokens: 10, outputTokens: 1 });
		r.reset();
		assert.strictEqual(r.getAgentStats('coder'), undefined);
		assert.strictEqual(r.getGlobal().promptTokens, 0);
		assert.strictEqual(r.getSessionStats('s1'), undefined);
	});

	test('persist: record 写盘，新实例 restore 恢复', () => {
		const store = memUsageStore();
		const r = new BridgeUsageReporter(makeLog(), store);
		r.record('s1', 'coder', { inputTokens: 10, outputTokens: 5 });
		assert.strictEqual(store.saves, 1);
		assert.ok(store.snapshot);
		const r2 = new BridgeUsageReporter(makeLog(), store);
		assert.strictEqual(r2.getAgentStats('coder')!.promptTokens, 10);
		assert.strictEqual(r2.getGlobal().calls, 1);
		assert.strictEqual(r2.getSessionStats('s1')!.completionTokens, 5);
	});

	test('persist: reset 清空并落盘', () => {
		const store = memUsageStore();
		const r = new BridgeUsageReporter(makeLog(), store);
		r.record('s1', 'coder', { inputTokens: 10, outputTokens: 5 });
		r.reset();
		assert.ok(store.snapshot);
		assert.strictEqual(store.snapshot!.byAgent.length, 0);
		assert.strictEqual(store.snapshot!.bySession.length, 0);
		assert.strictEqual(store.snapshot!.global.promptTokens, 0);
	});

	test('无 store：退化为内存态，不抛错', () => {
		const r = new BridgeUsageReporter(makeLog());
		r.record('s1', 'coder', { inputTokens: 10, outputTokens: 5 });
		assert.strictEqual(r.getAgentStats('coder')!.promptTokens, 10);
	});
});
