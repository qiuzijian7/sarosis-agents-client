/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * routineCrystalFacetTools 注册与 handler 行为验证。
 *
 * 引擎高阶记忆模块（routine/crystal/facet）经 V2 provider + 网关 + 代理转发
 * 链路完整，本测试验证工具层接线正确：
 *  - 3 个高阶工具全部注册、category=memory
 *  - handler 正确调用 provider 对应方法并格式化结果
 *  - 无 provider / 缺 agentId 时给出可读错误而非异常
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { registerRoutineCrystalFacetTools } from '../../browser/providers/tool/routineCrystalFacetTools.js';

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

/** 记录调用的假 provider（overrides 也会记录调用） */
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

suite('routineCrystalFacetTools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('注册 3 个高阶记忆工具，category 均为 memory', () => {
		const { ctx, registrations } = createCtx(createFakeProvider().provider);
		registerRoutineCrystalFacetTools(ctx as any);
		const names = registrations.map(r => r.name).sort();
		assert.deepStrictEqual(names, ['memory_crystal', 'memory_facet', 'memory_routine']);
		assert.ok(registrations.every(r => r.category === 'memory'));
	});

	test('memory_routine create/run/step/delete 全路径', async () => {
		const { provider, calls } = createFakeProvider({
			createRoutine: async () => ({ id: 'rtn1', name: 'deploy', steps: [{ order: 0, title: 's1' }] }),
			runRoutine: async () => ({ id: 'run1', routineId: 'rtn1', status: 'running', currentStep: 0 }),
			routineStepUpdate: async () => ({ id: 'run1', status: 'completed', currentStep: 1, completedAt: '2026-07-26' }),
			routineDelete: async () => true,
		});
		const { ctx, registrations } = createCtx(provider);
		registerRoutineCrystalFacetTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_routine')!;

		const createOut = await tool.handler({ action: 'create', name: 'deploy', steps: [{ title: 's1' }] }, undefined, 'agent1');
		assert.strictEqual(calls[0].method, 'createRoutine');
		assert.ok(createOut[0].text.includes('deploy'));

		const runOut = await tool.handler({ action: 'run', routine_id: 'rtn1' }, undefined, 'agent1');
		assert.strictEqual(calls[1].method, 'runRoutine');
		assert.ok(runOut[0].text.includes('run1'));

		const stepOut = await tool.handler({ action: 'step', run_id: 'run1', step_order: 0, step_status: 'done', result: 'ok' }, undefined, 'agent1');
		assert.strictEqual(calls[2].method, 'routineStepUpdate');
		assert.deepStrictEqual(calls[2].args.slice(0, 3), ['agent1', 'run1', 0]);
		assert.ok(stepOut[0].text.includes('completed'));

		const delOut = await tool.handler({ action: 'delete', routine_id: 'rtn1' }, undefined, 'agent1');
		assert.strictEqual(calls[3].method, 'routineDelete');
		assert.ok(delOut[0].text.includes('deleted'));
	});

	test('memory_routine list/get/status/freeze 转发', async () => {
		const { provider, calls } = createFakeProvider({
			getRoutines: async () => [{ id: 'rtn1', name: 'deploy', steps: [{ order: 0, title: 's1' }], frozen: true }],
			getRoutine: async () => ({ id: 'rtn1', name: 'deploy', steps: [{ order: 0, title: 's1', description: 'first' }], frozen: true }),
			routineStatus: async () => ({ success: true, progress: { total: 1, done: 0, active: 1, pending: 0 } }),
			routineFreeze: async () => ({ success: true, routine: { id: 'rtn1', frozen: true } }),
		});
		const { ctx, registrations } = createCtx(provider);
		registerRoutineCrystalFacetTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_routine')!;

		const listOut = await tool.handler({ action: 'list' }, undefined, 'agent1');
		assert.strictEqual(calls[0].method, 'getRoutines');
		assert.ok(listOut[0].text.includes('deploy'));

		const getOut = await tool.handler({ action: 'get', routine_id: 'rtn1' }, undefined, 'agent1');
		assert.strictEqual(calls[1].method, 'getRoutine');
		assert.ok(getOut[0].text.includes('s1'));

		const statusOut = await tool.handler({ action: 'status', run_id: 'run1' }, undefined, 'agent1');
		assert.strictEqual(calls[2].method, 'routineStatus');
		assert.ok(statusOut[0].text.includes('total'));

		const freezeOut = await tool.handler({ action: 'freeze', routine_id: 'rtn1' }, undefined, 'agent1');
		assert.strictEqual(calls[3].method, 'routineFreeze');
		assert.ok(freezeOut[0].text.includes('frozen=true'));
	});

	test('memory_crystal create/list/get/auto 全路径', async () => {
		const { provider, calls } = createFakeProvider({
			crystallize: async () => ({ id: 'cry1', narrative: 'built release flow' }),
			crystalList: async () => [{ id: 'cry1', narrative: 'built release flow', filesAffected: ['a.ts'] }],
			crystalGet: async () => ({ id: 'cry1', narrative: 'built release flow', keyOutcomes: ['ok'], filesAffected: ['a.ts'], lessons: ['do X'] }),
			autoCrystallize: async () => 2,
		});
		const { ctx, registrations } = createCtx(provider);
		registerRoutineCrystalFacetTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_crystal')!;

		const createOut = await tool.handler({ action: 'create', action_id: 'act1' }, undefined, 'agent1');
		assert.strictEqual(calls[0].method, 'crystallize');
		assert.deepStrictEqual(calls[0].args, ['agent1', 'act1']);
		assert.ok(createOut[0].text.includes('cry1'));

		const listOut = await tool.handler({ action: 'list' }, undefined, 'agent1');
		assert.strictEqual(calls[1].method, 'crystalList');
		assert.ok(listOut[0].text.includes('built release flow'));

		const getOut = await tool.handler({ action: 'get', crystal_id: 'cry1' }, undefined, 'agent1');
		assert.strictEqual(calls[2].method, 'crystalGet');
		assert.ok(getOut[0].text.includes('do X'));

		const autoOut = await tool.handler({ action: 'auto' }, undefined, 'agent1');
		assert.strictEqual(calls[3].method, 'autoCrystallize');
		assert.ok(autoOut[0].text.includes('2'));
	});

	test('memory_facet tag/query/get/untag/stats/dimensions 全路径', async () => {
		const { provider, calls } = createFakeProvider({
			facetTag: async () => ({ id: 'fac1' }),
			facetQuery: async () => [{ targetId: 'm1', targetType: 'memory', dimension: 'project', value: 'saros' }],
			facetGet: async () => ({ id: 'fac1', value: 'saros' }),
			facetUntag: async () => true,
			facetStats: async () => ({ 'project:saros': 3 }),
			facetDimensions: async () => ['project', 'status'],
		});
		const { ctx, registrations } = createCtx(provider);
		registerRoutineCrystalFacetTools(ctx as any);
		const tool = registrations.find(r => r.name === 'memory_facet')!;

		const tagOut = await tool.handler({ action: 'tag', target_id: 'm1', target_type: 'memory', dimension: 'project', value: 'saros' }, undefined, 'agent1');
		assert.strictEqual(calls[0].method, 'facetTag');
		assert.deepStrictEqual(calls[0].args.slice(0, 2), ['agent1', 'm1']);
		assert.ok(tagOut[0].text.includes('project=saros'));

		const queryOut = await tool.handler({ action: 'query', dimension: 'project' }, undefined, 'agent1');
		assert.strictEqual(calls[1].method, 'facetQuery');
		assert.ok(queryOut[0].text.includes('m1'));

		const getOut = await tool.handler({ action: 'get', target_id: 'm1', dimension: 'project' }, undefined, 'agent1');
		assert.strictEqual(calls[2].method, 'facetGet');
		assert.ok(getOut[0].text.includes('saros'));

		const untagOut = await tool.handler({ action: 'untag', target_id: 'm1', dimension: 'project' }, undefined, 'agent1');
		assert.strictEqual(calls[3].method, 'facetUntag');
		assert.ok(untagOut[0].text.includes('Removed'));

		const statsOut = await tool.handler({ action: 'stats' }, undefined, 'agent1');
		assert.strictEqual(calls[4].method, 'facetStats');
		assert.ok(statsOut[0].text.includes('project:saros'));

		const dimOut = await tool.handler({ action: 'dimensions' }, undefined, 'agent1');
		assert.strictEqual(calls[5].method, 'facetDimensions');
		assert.ok(dimOut[0].text.includes('project'));
	});

	test('无 provider → 可读错误而非异常；缺 agentId → 错误提示', async () => {
		const { ctx, registrations } = createCtx(undefined);
		registerRoutineCrystalFacetTools(ctx as any);
		for (const tool of registrations) {
			const out = await tool.handler({ action: 'list' }, undefined, 'agent1');
			assert.ok(out[0].text.includes('no memory provider'), `${tool.name} should report missing provider`);
		}
		const tool = registrations.find(r => r.name === 'memory_routine')!;
		const out2 = await tool.handler({ action: 'list' }, undefined, undefined);
		assert.ok(out2[0].text.includes('agentId is required'));
	});
});
