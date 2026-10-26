/*---------------------------------------------------------------------------------------------
 *  memoryScopeAlias.test.ts — 记忆**作用域单一解析器**（方案 A，★ 2026-10-26）
 *
 * ## 要解决的病
 * 同一引擎里存在两套分区命名：
 *   · 工作区 scoped：`ws-<workspaceId>`（dsh 插件 `partitionOf` 拼的）
 *   · 会话真实 agent（persona）：`saros-claw` / `default` / `knowledge-base-expert` …
 * ⇒ 写进 A、读 B ⇒ 用户永远看到「没有记忆」（实测：`ws-*` 四层全 0，`saros-claw` 有 4000+ 条）✗✗
 *
 * ## 方案 A 的不变量（本文件钉住）
 *  ① **读和写必须走同一个解析器** ⇒ `loadContext` / `observe` / `writeMemory` 落到**同一个 agentId**
 *     （结构性消除"写 A 读 B"，而不是每个调用点各自打补丁 ✗）
 *  ② **只在有别名时改**：没有别名 / 别名残缺 / id 不匹配 ⇒ **原样返回**（有数据的分区行为完全不变）
 *  ③ 别名 `from: 'ws-<workspaceId>'` 也接受 `from` 已带前缀的写法（避免双重前缀）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentMemoryProviderProxy } from '../src/agentMemoryProviderProxy.js';
import { memoryScopeAlias, scopedMemoryAgentId } from '../src/serverConfig.js';

declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;

const G = globalThis as { __SAROS_AGENTMEMORY_SCOPE_ALIAS__?: unknown };

function withAlias(alias: unknown, fn: () => void | Promise<void>) {
	return async () => {
		const prev = G.__SAROS_AGENTMEMORY_SCOPE_ALIAS__;
		G.__SAROS_AGENTMEMORY_SCOPE_ALIAS__ = alias;
		try { await fn(); } finally { G.__SAROS_AGENTMEMORY_SCOPE_ALIAS__ = prev; }
	};
}

suite('记忆作用域单一解析器（方案 A）', () => {

	test('② 没有别名 ⇒ 原样返回（行为与改动前完全一致）', () => {
		const prev = G.__SAROS_AGENTMEMORY_SCOPE_ALIAS__;
		delete G.__SAROS_AGENTMEMORY_SCOPE_ALIAS__;
		try {
			assert.equal(memoryScopeAlias(), undefined, '没注入 ⇒ 不该有别名');
			assert.equal(scopedMemoryAgentId('ws-proj-abc'), 'ws-proj-abc', '无别名时不能擅自改 scope ✗');
			assert.equal(scopedMemoryAgentId('saros-claw'), 'saros-claw');
		} finally { G.__SAROS_AGENTMEMORY_SCOPE_ALIAS__ = prev; }
	});

	test('别名命中 ⇒ ws-* 解析成 persona；其它 id 不受影响', async () => {
		await withAlias({ from: 'ws-proj-abc', to: 'saros-claw' }, () => {
			assert.equal(scopedMemoryAgentId('ws-proj-abc'), 'saros-claw', '工作区分区应归一到 persona');
			assert.equal(scopedMemoryAgentId('saros-claw'), 'saros-claw', '已经是 persona ⇒ 不变');
			assert.equal(scopedMemoryAgentId('default'), 'default', '别的分区不能被牵连 ✗');
		})();
	});

	test('别名残缺（缺 from/to）⇒ 视为没有别名，不乱映射', async () => {
		await withAlias({ from: 'ws-proj-abc' }, () => {
			assert.equal(memoryScopeAlias(), undefined);
			assert.equal(scopedMemoryAgentId('ws-proj-abc'), 'ws-proj-abc');
		})();
	});

	test('⭐ ① 读和写必须落到**同一个 agentId**（方案 A 的核心不变量）', async () => {
		await withAlias({ from: 'ws-proj-abc', to: 'saros-claw' }, async () => {
			const calls: Array<{ method: string; agentId: string }> = [];
			const p: any = new AgentMemoryProviderProxy();
			p._log = { info: () => { }, warn: () => { }, debug: () => { }, error: () => { } };
			p._call = async (method: string, ...args: any[]) => {
				calls.push({ method, agentId: String(args[0]) });
				if (method === 'listAllAgentsWithData') { return ['saros-claw', 'default']; }
				if (method === 'loadContext') { return { longTermMemories: [1], shortTermMemories: [], systemPrompt: 'x' }; }
				return null;
			};

			await p.loadContext('ws-proj-abc', 's1', 'q', {});
			await p.observe('ws-proj-abc', { sessionId: 's1' });
			await p.writeMemory('ws-proj-abc', { content: 'x' });

			const ids = new Set(
				calls.filter(c => c.method === 'loadContext' || c.method === 'observe' || c.method === 'writeMemory')
					.map(c => c.agentId),
			);
			assert.deepEqual([...ids], ['saros-claw'],
				`读/写必须落在同一个分区，实际: ${JSON.stringify([...ids])}（"写 A 读 B"就是"永远没有记忆"的根因 ✗）`);
		})();
	});
});
