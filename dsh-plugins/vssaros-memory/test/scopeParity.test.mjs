/*---------------------------------------------------------------------------------------------
 *  scopeParity.test.mjs — **跨进程作用域真源**的守卫（★ 2026-10-27）
 *
 * ## 要防的事（本仓已经踩过三次）
 * 同一台机器上记忆分区有两套命名：`ws-<workspaceId>`（插件拼）与 persona（`gr`/`default`…）
 * ⇒ **写 A 读 B** ⇒ 用户永远"没有记忆"。
 * 现在三方共用一份真源 `~/.vssaros-dev/memory-scope.json`：
 *   · 写者：**网关**（`setScopeAlias`，渲染进程没 fs）
 *   · 读者 A：渲染侧（`globalThis.__SAROS_AGENTMEMORY_SCOPE_ALIAS__` → `scopedMemoryAgentId`）
 *   · 读者 B：**本插件**（`readScopeSync` → `resolveMemoryScope`）
 *
 * ⚠ 两份实现**不可能物理合并**（插件是独立 npm 包，不能 import `extensions/`），
 *   ⇒ 所以用**同一组用例跑两边、逐例比对**来保证规则不分叉（这就是本文件的核心价值）。
 *
 * ## 本测试钉住
 *  ① `matchesScope` 的三种命中（`from` / `ws-<from>` / `wa-<from>`）与不命中
 *  ② `resolveMemoryScope` 优先级：跨进程别名 ＞ 会话人设 ＞ 主分区
 *  ③ **与引擎 `scopedMemoryAgentId()` 逐例对齐**（同一输入必须同一输出）
 *  ④ 接线断言：插件三处写入（memory_remember / 回合观测 / 草稿提升）都走同一解析器
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesScope, resolveMemoryScope, SCOPE_FILE_NAME } from '../lib/core/scope.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', 'lib', 'index.js');
const ENGINE = path.join(HERE, '..', '..', '..', 'extensions', 'agentmemory-memory', 'out', 'serverConfig.js');

const results = [];
const check = (name, fn) => {
	try { const d = fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};
const checkAsync = async (name, fn) => {
	try { const d = await fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};

check('① matchesScope：命中规则与引擎一致（给 from 加 ws-/wa- 前缀）', () => {
	// 引擎规则：`id === from || id === ws-<from> || id === wa-<from>`（前缀在 from 侧，不是剥掉）
	const bare = { from: 'abc', to: 'gr' };
	assert.equal(matchesScope('abc', bare), true, '裸 from 直配');
	assert.equal(matchesScope('ws-abc', bare), true, 'ws- 变体');
	assert.equal(matchesScope('wa-abc', bare), true, 'wa- 变体');
	assert.equal(matchesScope('ws-xyz', bare), false);
	const prefixed = { from: 'ws-abc', to: 'gr' };
	assert.equal(matchesScope('ws-abc', prefixed), true, '宿主写的就是 ws-<wsId> ⇒ 直配');
	assert.equal(matchesScope('ws-ws-abc', prefixed), true, '加前缀后仍可能命中（无害）');
	assert.equal(matchesScope('abc', prefixed), false, 'B* 不加前缀 ⇒ 不命中（与引擎一致，别自己发明规则 ✗）');
	assert.equal(matchesScope('', bare), false);
	assert.equal(matchesScope('abc', undefined), false);
	return 'ok';
});

check('② 优先级：跨进程别名 ＞ 会话人设 ＞ 主分区', () => {
	// 别名命中 ⇒ 用别名（即使有 persona 也不动摇：别名是"宿主认定的作用域"，层级更高）
	assert.equal(resolveMemoryScope({ agentId: 'ws-abc', persona: 'coder', scope: { from: 'ws-abc', to: 'gr' } }), 'gr');
	// 别名没命中 ⇒ 用人设
	assert.equal(resolveMemoryScope({ agentId: 'ws-abc', persona: 'coder', scope: { from: 'ws-zzz', to: 'gr' } }), 'coder');
	// 都没有 ⇒ 原样（不乱猜）
	assert.equal(resolveMemoryScope({ agentId: 'ws-abc' }), 'ws-abc');
	assert.equal(resolveMemoryScope({ agentId: 'ws-abc', persona: '   ' }), 'ws-abc');
	assert.equal(resolveMemoryScope({}), '');
	return 'ok';
});

await checkAsync('③ 与引擎 `scopedMemoryAgentId()` **逐例对齐**（同一输入同一输出）', async () => {
	if (!fs.existsSync(ENGINE)) { return '（跳过：引擎 out/ 未编译，先跑 extensions/agentmemory-memory 的 compile）'; }
	const engine = await import('file:///' + ENGINE.replace(/\\/g, '/'));
	assert.equal(typeof engine.scopedMemoryAgentId, 'function', '引擎必须导出 scopedMemoryAgentId');

	const cases = [
		{ from: 'ws-abc', to: 'gr', ids: ['ws-abc', 'abc', 'wa-abc', 'ws-other', '', 'default'] },
		{ from: 'saros-agents-client-ncshv', to: 'marketplace-bot', ids: ['ws-saros-agents-client-ncshv', 'saros-agents-client-ncshv', 'default'] },
	];
	const mismatches = [];
	for (const c of cases) {
		const g = globalThis;
		const prev = g.__SAROS_AGENTMEMORY_SCOPE_ALIAS__;
		g.__SAROS_AGENTMEMORY_SCOPE_ALIAS__ = { from: c.from, to: c.to };
		try {
			for (const id of c.ids) {
				const plugin = resolveMemoryScope({ agentId: id, scope: { from: c.from, to: c.to } });
				const eng = engine.scopedMemoryAgentId(id);
				if (plugin !== eng) { mismatches.push(`${id} (from=${c.from}): plugin=${plugin} engine=${eng}`); }
			}
		} finally {
			if (prev === undefined) { delete g.__SAROS_AGENTMEMORY_SCOPE_ALIAS__; }
			else { g.__SAROS_AGENTMEMORY_SCOPE_ALIAS__ = prev; }
		}
	}
	assert.deepEqual(mismatches, [], '插件与引擎的命中规则分叉了 ✗（两处必须同规则）');
	return 'ok';
});

check('④ 接线：三处写入都走同一解析器', () => {
	const src = fs.readFileSync(INDEX, 'utf8');
	const calls = (src.match(/resolveMemoryScope\(/g) || []).length;
	assert.ok(calls >= 3, `应至少 3 处调用（memory_remember / 回合观测 / 草稿提升），实际 ${calls}`);
	assert.ok(src.includes("from './core/scope.js'"), '必须从 core/scope.js 导入');
	// 不允许再直接按旧规则自算（那正是分叉的来源）
	assert.ok(!/writePartitionOf\(primaryPartition/.test(src), 'memory_remember 不应再直接用 writePartitionOf ✗');
	assert.ok(!/writePartitionOf\(agentIdOf\(config\)/.test(src), '回合观测不应再直接用 writePartitionOf ✗');
	assert.ok(src.includes("agentId: () => resolveMemoryScope({"), '草稿提升必须走同一解析器（否则写回 ws-* ✗）');
	return calls + ' 处调用';
});

check('⑤ 文件名与网关一致', () => {
	assert.equal(SCOPE_FILE_NAME, 'memory-scope.json');
	const gateway = fs.readFileSync(path.join(HERE, '..', '..', '..', 'extensions', 'agentmemory-memory', 'src', 'agentMemoryProviderV2.ts'), 'utf8');
	assert.ok(gateway.includes("'memory-scope.json'"), '网关侧必须写同一个文件名（否则插件读不到）');
	return 'ok';
});

for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
const failed = results.filter(r => !r.ok);
console.log('');
if (failed.length) { console.error(`✗ 作用域真源测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 跨进程作用域真源测试通过（${results.length} 项）`);
