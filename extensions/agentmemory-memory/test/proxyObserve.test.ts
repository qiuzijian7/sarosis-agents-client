/*---------------------------------------------------------------------------------------------
 *  proxyObserve.test.ts — 渲染侧代理必须**实现 observe**（★ 2026-10-26）
 *
 * ## 为什么（真机定案的"边聊边记完全失效"根因）
 * IDE 每迭代都会调 `memoryProvider.observe?.(request.agentId, {...})`
 * （`parts/turnPostIteration.ts:414-420`，**可选调用** `?.`）把本回合观测写进暂存层
 * （`mem:obs:*`）⇒ 再由固化/提升变成长期记忆 ⇒ 这是"边聊边记"的唯一自动入口。
 *
 * 而 `AgentMemoryProviderProxy` 之前**只有 `observeList`、没有 `observe`**
 * ⇒ `?.()` 静默 no-op ⇒ 实测：`observeList('ws-…') = 0`、四层全 0、
 * `addMemory/writeMemory = 0` 次 ⇒ **会话记忆从来没被写进去** ✗✗
 * （dsh 侧有 18889 条是因为它走引擎 V2 的 `observe`/`writeMemory`，不经过本 proxy）
 *
 * ## 本守卫钉住
 *  ① 代理**有能力** `observe`（否则 `?.()` 静默吞掉一切）
 *  ② `observe` 会把 `(agentId, payload)` **原样转发**到 `_call('observe', …)`
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentMemoryProviderProxy } from '../src/agentMemoryProviderProxy.js';

declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;

function makeProxy(calls: Array<{ method: string; args: any[] }>) {
	const p: any = new AgentMemoryProviderProxy();
	p._log = { info: () => { }, warn: () => { }, debug: () => { }, error: () => { } };
	p._call = async (method: string, ...args: any[]) => {
		calls.push({ method, args });
		if (method === 'observeList') { return calls.filter(c => c.method === 'observe').map(c => c.args[1]); }
		return null;
	};
	return p;
}

suite('记忆写入入口：proxy.observe（2026-10-26）', () => {

	test('① 代理必须实现 observe（否则 IDE 的 observe?.(…) 静默 no-op）', () => {
		const p = makeProxy([]);
		assert.equal(typeof p.observe, 'function',
			'AgentMemoryProviderProxy 缺少 observe ⇒ IDE 的"边聊边记"入口直接消失（实测记忆恒 0 条）✗');
	});

	test('② observe 把 (agentId, payload) 原样转发到 _call("observe", …)', async () => {
		const calls: Array<{ method: string; args: any[] }> = [];
		const p = makeProxy(calls);
		const payload = { sessionId: 'sess-1', hookType: 'turn_end', timestamp: '2026-10-26T00:00:00.000Z', data: { text: '回合内容' } };
		await p.observe('ws-proj-abc', payload);
		const hit = calls.find(c => c.method === 'observe');
		assert.ok(hit, '没有转发 observe 调用');
		assert.equal(hit!.args[0], 'ws-proj-abc', 'agentId 必须原样透传（分区键不能丢）');
		assert.deepEqual(hit!.args[1], payload, 'payload 必须原样透传（sessionId/hookType/data 一个都不能丢）');
	});
});

suite('记忆 provider 方法覆盖（generateReport / runExtendedDiagnostics）', () => {

	test('generateReport 转发 (type, agentId)', async () => {
		const calls: Array<{ method: string; args: any[] }> = [];
		const p: any = makeProxy(calls);
		p._call = async (method: string, ...args: any[]) => { calls.push({ method, args }); return { totalMemories: 7 }; };
		const r = await p.generateReport('daily', 'ws-proj-abc');
		const hit = calls.find(c => c.method === 'generateReport');
		assert.ok(hit, '没有转发 generateReport');
		assert.deepEqual(hit!.args, ['daily', 'ws-proj-abc'], '参数必须原样透传');
		assert.equal((r as any).totalMemories, 7, '返回值必须透传');
	});

	test('runExtendedDiagnostics 必须**同步返回 promise**（IDE 侧不 await 直接拿）', () => {
		const p: any = makeProxy([]);
		p._call = async () => ({ ok: true });
		const out = p.runExtendedDiagnostics('ws-proj-abc');
		assert.ok(out && typeof out.then === 'function', '必须返回 promise（IDE 侧 memoryDetailEditorPane.ts:2363 不 await ✗）');
	});
});
