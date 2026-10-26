/*---------------------------------------------------------------------------------------------
 *  proxyCrossPartition.test.ts — 记忆注入的**跨分区兜底**（★ 2026-10-26）
 *
 * ## 为什么需要它（真机实测的根因）
 * IDE 的 chat agentId 是 `ws-<workspaceId>` ⇒ 该分区四层全 0、`loadContext` 只回 **124B** 空壳
 * （`systemPrompt:""`、`contextTokens:28`），而**同一引擎**里 `saros-claw` 分区有 4039 条、
 * `loadContext` 回 **5.4KB** 并带 `<agentmemory-context>` 段
 * ⇒ 「会话没有记忆」不是读取坏了，是**读的分区不对** ✗✗
 *
 * ## 本守卫钉住三条
 *  ① 主分区**实质为空**且 id 形如 `ws-*` ⇒ 依次试"有数据的分区"，命中即用（并记日志，不静默）
 *  ② 主分区**非空** ⇒ **完全不做兜底**（连 `listAllAgentsWithData` 都不该调 ⇒ 零额外开销 ✓）
 *  ③ **非 `ws-*` 分区**（如 `saros-claw`）即便空也不兜底 ⇒ 有数据的分区行为完全不变 ✓
 *
 * ⚠ 这层是**渲染侧**（IDE 用它）；网关里跑的是 `AgentMemoryProviderV2`（进程内）
 *   ⇒ 用 `/provider/*` HTTP 探针**测不到**这段逻辑（我一开始就误用 HTTP 验证，白测一次 ✗）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentMemoryProviderProxy } from '../src/agentMemoryProviderProxy.js';

declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;

const EMPTY = { longTermMemories: [], shortTermMemories: [], systemPrompt: '', injectedContext: '' };
const RICH = { longTermMemories: [1, 2], shortTermMemories: [], systemPrompt: '<agentmemory-context project="x"/>', injectedContext: '' };

/** 造一个只劫持 `_call` 的代理（`_call` 是 public ⇒ 无需真实网关 ✓）。 */
function makeProxy(calls: Array<{ method: string; args: any[] }>) {
	const p: any = new AgentMemoryProviderProxy();
	p._log = { info: () => { }, warn: () => { }, debug: () => { }, error: () => { } };
	p._call = async (method: string, ...args: any[]) => {
		calls.push({ method, args });
		if (method === 'listAllAgentsWithData') { return ['default', 'saros-claw']; }
		if (method === 'loadContext') {
			const aid = String(args[0]);
			if (aid === 'ws-proj-abc') { return { ...EMPTY }; }
			if (aid === 'default') { return { ...RICH }; }
			return { ...EMPTY };
		}
		return null;
	};
	return p;
}

suite('记忆注入：跨分区兜底（2026-10-26）', () => {

	test('① 主分区（ws-*）空 ⇒ 兜底到有数据的分区，并采用它的上下文', async () => {
		const calls: Array<{ method: string; args: any[] }> = [];
		const p = makeProxy(calls);
		const ctx = await p.loadContext('ws-proj-abc', 'sess-1', '记忆', { scope: 'agent' });
		assert.equal(ctx.systemPrompt, RICH.systemPrompt, `应兜底到 default 的上下文，实际 ${JSON.stringify(ctx)}`);
		assert.equal(ctx.longTermMemories.length, 2, '兜底后应带上记忆条目');
		assert.ok(calls.some(c => c.method === 'listAllAgentsWithData'), '兜底时应先查"有数据的分区"');
	});

	test('② 主分区非空 ⇒ **不做**兜底（连候选列表都不查，零额外开销）', async () => {
		const calls: Array<{ method: string; args: any[] }> = [];
		const p: any = makeProxy(calls);
		p._call = async (method: string, ...args: any[]) => {
			calls.push({ method, args });
			if (method === 'loadContext') { return { ...RICH }; }
			return null;
		};
		const ctx = await p.loadContext('ws-proj-abc', 'sess-1', 'q', {});
		assert.equal(ctx.systemPrompt, RICH.systemPrompt, '主分区有内容时应原样返回');
		assert.ok(!calls.some(c => c.method === 'listAllAgentsWithData'), '有内容时不该查候选分区（性能与语义都要求 ✗）');
	});

	test('③ 非 ws-* 分区即便空也不兜底（有数据的分区行为不变）', async () => {
		const calls: Array<{ method: string; args: any[] }> = [];
		const p = makeProxy(calls);
		const ctx = await p.loadContext('saros-claw', 'sess-1', 'q', {});
		assert.equal(ctx.systemPrompt, '', 'saros-claw 空 ⇒ 应保持空（不得替它换分区）');
		assert.ok(!calls.some(c => c.method === 'listAllAgentsWithData'), '非 ws-* 分区不该触发兜底');
	});
});
