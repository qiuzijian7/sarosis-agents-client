/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * advancedMemoryTools / memoryTools 注册与 handler 行为验证。
 *
 * 背景：引擎编排/治理模块（governance/team/mesh/sentinel/obsidian/cascade）
 * 经 V2 provider + 网关 + 代理转发链路完整，本测试验证工具层接线正确：
 *  - 6 个高级工具全部注册、category=memory
 *  - handler 正确调用 provider 对应方法并格式化结果
 *  - 无 provider / 缺 agentId 时给出可读错误而非异常
 *  - 基础 4 工具（remember/search/delete/list）同样注册且走 provider
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { registerAdvancedMemoryTools } from '../../browser/providers/tool/advancedMemoryTools.js';
import { registerMemoryTools } from '../../browser/providers/tool/memoryTools.js';

interface IFakeRegistration { name: string; category?: string; handler: (args: any, signal: any, agentId?: string) => Promise<any[]>; }

function createCtx(provider: any) {
	const registrations: IFakeRegistration[] = [];
	const ctx = {
		register: (r: any) => { registrations.push({ name: r.definition.name, category: r.definition.category, handler: r.handler }); },
		agentOS: { getActiveMemoryProvider: () => provider } as any,
		logService: new NullLogService(),
	};
	return { ctx, registrations };
}

/** 记录调用的高级方法假 provider（overrides 也会记录调用） */
function createFakeProvider(overrides: Record<string, any> = {}) {
	const calls: Array<{ method: string; args: any[] }> = [];
	const base: any = new Proxy({}, {
		get(_t, prop: string) {
			if (prop in overrides) {
				const fn = overrides[prop];
				return (...args: any[]) => { calls.push({ method: prop, args }); return fn(...args); };
			}
			return (...args: any[]) => { calls.push({ method: prop, args }); return Promise.resolve(undefined); };
		},
	});
	return { provider: base, calls };
}

suite('advancedMemoryTools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('注册 6 个高级记忆工具，category 均为 memory', () => {
		const { ctx, registrations } = createCtx(createFakeProvider().provider);
		registerAdvancedMemoryTools(ctx as any);
		const names = registrations.map(r => r.name).sort();
		assert.deepStrictEqual(names, [
			'memory_cascade', 'memory_governance', 'memory_mesh',
			'memory_obsidian_export', 'memory_sentinel', 'memory_team',
		]);
		assert.ok(registrations.every(r => r.category === 'memory'));
	});

	test('memory_governance delete → governanceDelete 并报告数量', async () => {
		const { provider, calls } = createFakeProvider({
			governanceDelete: async () => ({ deleted: 2 }),
		});
		const { ctx, registrations } = createCtx(provider);
		registerAdvancedMemoryTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_governance')!;
		const out = await tool.handler({ action: 'delete', ids: ['a', 'b'] }, undefined, 'agent1');
		assert.strictEqual(calls[0].method, 'governanceDelete');
		assert.deepStrictEqual(calls[0].args, ['agent1', ['a', 'b']]);
		assert.ok(out[0].text.includes('Deleted 2'));
	});

	test('memory_governance bulk_delete 默认 dry-run 不执行删除', async () => {
		const { provider, calls } = createFakeProvider({
			governanceBulkDelete: async (_a: string, f: any) => ({ matched: 5, dryRun: f.dryRun }),
		});
		const { ctx, registrations } = createCtx(provider);
		registerAdvancedMemoryTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_governance')!;
		const out = await tool.handler({ action: 'bulk_delete', filters: { type: 'episodic' } }, undefined, 'agent1');
		assert.strictEqual(calls[0].args[1].dryRun, true);
		assert.ok(out[0].text.includes('Dry-run'));
	});

	test('memory_team share/query 转发 teamShare/teamQuery', async () => {
		const { provider, calls } = createFakeProvider({
			teamShare: async () => ({ success: true, item: { id: 'ts1' } }),
			teamQuery: async () => [{ type: 'memory', sharedBy: 'agent2', sharedAt: '2026-07-25', content: { content: 'convention X' } }],
		});
		const { ctx, registrations } = createCtx(provider);
		registerAdvancedMemoryTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_team')!;
		const shareOut = await tool.handler({ action: 'share', memory_id: 'm1' }, undefined, 'agent1');
		assert.strictEqual(calls[0].method, 'teamShare');
		assert.ok(shareOut[0].text.includes('ts1'));
		const queryOut = await tool.handler({ action: 'query' }, undefined, 'agent1');
		assert.strictEqual(calls[1].method, 'teamQuery');
		assert.ok(queryOut[0].text.includes('convention X'));
	});

	test('memory_mesh join/list/leave 全路径', async () => {
		const { provider, calls } = createFakeProvider({
			meshJoin: async () => ({ id: 'mesh1' }),
			meshList: async () => [{ id: 'mesh1', name: 'peer-a', url: 'http://x', status: 'online', sharedScopes: ['memories'] }],
			meshLeave: async () => true,
		});
		const { ctx, registrations } = createCtx(provider);
		registerAdvancedMemoryTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_mesh')!;
		await tool.handler({ action: 'join', name: 'peer-a', url: 'http://x' }, undefined, 'agent1');
		const listOut = await tool.handler({ action: 'list' }, undefined, 'agent1');
		const leaveOut = await tool.handler({ action: 'leave', peer_id: 'mesh1' }, undefined, 'agent1');
		assert.deepStrictEqual(calls.map(c => c.method), ['meshJoin', 'meshList', 'meshLeave']);
		assert.ok(listOut[0].text.includes('peer-a'));
		assert.ok(leaveOut[0].text.includes('offline'));
	});

	test('memory_sentinel create/list', async () => {
		const { provider, calls } = createFakeProvider({
			sentinelCreate: async () => ({ id: 'sen1' }),
			sentinelList: async () => [{ id: 'sen1', name: 'watch', type: 'threshold', condition: 'count > 10', createdAt: '2026-07-25' }],
		});
		const { ctx, registrations } = createCtx(provider);
		registerAdvancedMemoryTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_sentinel')!;
		const createOut = await tool.handler({ action: 'create', name: 'watch', condition: 'count > 10' }, undefined, 'agent1');
		const listOut = await tool.handler({ action: 'list' }, undefined, 'agent1');
		assert.deepStrictEqual(calls.map(c => c.method), ['sentinelCreate', 'sentinelList']);
		assert.ok(createOut[0].text.includes('sen1'));
		assert.ok(listOut[0].text.includes('count > 10'));
	});

	test('memory_sentinel check 报告触发清单；cancel 转发', async () => {
		const { provider, calls } = createFakeProvider({
			sentinelCheck: async () => ({
				checked: 2, expired: 0,
				triggered: [{ id: 'sen1', name: 'watch', type: 'threshold', result: { reason: 'threshold_crossed', currentValue: 5 } }],
				errors: [],
			}),
			sentinelCancel: async () => ({ success: true }),
		});
		const { ctx, registrations } = createCtx(provider);
		registerAdvancedMemoryTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_sentinel')!;
		const checkOut = await tool.handler({ action: 'check' }, undefined, 'agent1');
		assert.strictEqual(calls[0].method, 'sentinelCheck');
		assert.ok(checkOut[0].text.includes('Checked 2'));
		assert.ok(checkOut[0].text.includes('TRIGGERED 1'));
		assert.ok(checkOut[0].text.includes('threshold_crossed'));
		const cancelOut = await tool.handler({ action: 'cancel', sentinel_id: 'sen1' }, undefined, 'agent1');
		assert.deepStrictEqual(calls[1].args, ['agent1', 'sen1']);
		assert.ok(cancelOut[0].text.includes('cancelled'));
	});

	test('memory_obsidian_export 返回 markdown；超长截断', async () => {
		const { provider } = createFakeProvider({
			obsidianExport: async () => '# Memories\n\n- item',
		});
		const { ctx, registrations } = createCtx(provider);
		registerAdvancedMemoryTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_obsidian_export')!;
		const out = await tool.handler({}, undefined, 'agent1');
		assert.ok(out[0].text.includes('# Memories'));
	});

	test('memory_cascade 转发 cascadeUpdate', async () => {
		const { provider, calls } = createFakeProvider({
			cascadeUpdate: async () => ({ success: true, flagged: 3 }),
		});
		const { ctx, registrations } = createCtx(provider);
		registerAdvancedMemoryTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_cascade')!;
		const out = await tool.handler({ memory_id: 'old-1' }, undefined, 'agent1');
		assert.deepStrictEqual(calls[0].args, ['agent1', 'old-1']);
		assert.ok(out[0].text.includes('flagged 3'));
	});

	test('无 provider → 可读错误而非异常；缺 agentId → 错误提示', async () => {
		const { ctx, registrations } = createCtx(undefined);
		registerAdvancedMemoryTools(ctx as any);
		for (const tool of registrations) {
			const out = await tool.handler(tool.name === 'memory_governance' ? { action: 'audit' } : tool.name === 'memory_cascade' ? { memory_id: 'x' } : { action: 'list' }, undefined, 'agent1');
			assert.ok(out[0].text.includes('no memory provider'), `${tool.name} should report missing provider`);
		}
		const tool = registrations.find(r => r.name === 'memory_mesh')!;
		const out2 = await tool.handler({ action: 'list' }, undefined, undefined);
		assert.ok(out2[0].text.includes('agentId is required'));
	});
});

suite('memoryTools（基础 4 工具注册回归）', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('注册 remember/search/delete/list 且 handler 走 provider', async () => {
		const writes: any[] = [];
		const fake = {
			writeMemory: async (_a: string, e: any) => { writes.push(e); },
			searchMemory: async () => [{ id: 'm1', type: 'episodic', content: 'hello world', timestamp: 1753300000000 }],
			forgetMemory: async () => true,
		};
		const { ctx, registrations } = createCtx(fake);
		registerMemoryTools(ctx as any);
		const names = registrations.map(r => r.name).sort();
		assert.deepStrictEqual(names, ['memory_delete', 'memory_list', 'memory_remember', 'memory_search']);

		const remember = registrations.find(r => r.name === 'memory_remember')!;
		const out = await remember.handler({ content: 'test fact' }, undefined, 'agent1');
		assert.strictEqual(writes.length, 1);
		assert.strictEqual(writes[0].content, 'test fact');
		assert.ok(out[0].text.includes('Memory saved'));

		const search = registrations.find(r => r.name === 'memory_search')!;
		const sOut = await search.handler({ query: 'hello' }, undefined, 'agent1');
		assert.ok(sOut[0].text.includes('hello world'));

		const del = registrations.find(r => r.name === 'memory_delete')!;
		const dOut = await del.handler({ id: 'm1' }, undefined, 'agent1');
		assert.ok(dOut[0].text.includes('Deleted'));

		const list = registrations.find(r => r.name === 'memory_list')!;
		const lOut = await list.handler({}, undefined, 'agent1');
		assert.ok(lOut[0].text.includes('hello world'));
	});

	test('无 provider → 全部给出可读错误', async () => {
		const { ctx, registrations } = createCtx(undefined);
		registerMemoryTools(ctx as any);
		for (const tool of registrations) {
			const args: any = tool.name === 'memory_remember' ? { content: 'x' } : tool.name === 'memory_search' ? { query: 'x' } : tool.name === 'memory_delete' ? { id: 'x' } : {};
			const out = await tool.handler(args, undefined, 'agent1');
			assert.ok(out[0].text.includes('no memory provider'), `${tool.name} should report missing provider`);
		}
	});
});
