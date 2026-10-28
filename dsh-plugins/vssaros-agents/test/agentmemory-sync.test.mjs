// @vssaros/dsh-agents — MEMORY.md → AgentMemory 单向派生（2026-10-27，C 档）
//   跑法：node dsh-plugins/vssaros-agents/test/agentmemory-sync.test.mjs
//
// 这层有三条不能让步的语义：
//   ① **单向**：只调 `writeMemory`（写库），绝不回写文件 —— 文件是被注入 prompt 的真源
//   ② **去重**：重复点「同步」不能把同一条灌进库多次（否则检索结果全是副本）
//   ③ **部分失败不中断**：一条写失败，其余继续；失败原因逐条回报
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseMemoryEntries, syncMemoryToAgentMemory } from '../lib/agentmemoryImport.js';
import { memoryDirOf, writeCoreMemory } from '../lib/memory.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-amsync-'));
const config = { agentsRoot: join(root, 'agents'), dataRoot: join(root, 'data') };
mkdirSync(config.agentsRoot, { recursive: true });

/* ── 解析：哪些行算条目 ───────────────────────────────────────────── */
check('★ 认三种列表写法（- / * / 1.）', () => {
	const items = parseMemoryEntries(['- 甲', '* 乙', '1. 丙', '2) 丁'].join('\n'));
	assert.deepEqual(items.map((x) => x.content), ['甲', '乙', '丙', '丁']);
});

check('★ 标题 / 引用 / 表格 / 空行不算条目', () => {
	const text = ['# 记忆', '', '> 引用', '| a | b |', '普通段落', '- 真条目'].join('\n');
	assert.deepEqual(parseMemoryEntries(text).map((x) => x.content), ['真条目']);
});

check('★ HTML 注释块（含跨行）整段跳过', () => {
	const text = [
		'<!-- 这是说明',
		'- 注释里的假条目',
		'-->',
		'- 真条目',
	].join('\n');
	assert.deepEqual(parseMemoryEntries(text).map((x) => x.content), ['真条目']);
});

check('条目内容折叠空白 + 单条截断 500 字', () => {
	const items = parseMemoryEntries('-   多   空格   折叠   ' + '\n- ' + 'x'.repeat(600));
	assert.equal(items[0].content, '多 空格 折叠');
	assert.equal(items[1].content.length, 500);
});

check('上限保护（max）', () => {
	const text = Array.from({ length: 30 }, (_, i) => '- e' + i).join('\n');
	assert.equal(parseMemoryEntries(text, { max: 5 }).length, 5);
});

/* ── 同步 ─────────────────────────────────────────────────────────── */
const withFetch = async (impl, fn) => {
	const old = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		/* ⚠ 必须把返回值带出去 —— 上一版漏了 `return`，`const r = await withFetch(...)` 恒为 undefined */
		return await fn();
	} finally { globalThis.fetch = old; }
};
const okFetch = (calls) => async (url, init) => {
	calls.push({ url: String(url), body: JSON.parse(init.body) });
	return { ok: true, text: async () => '{"ok":true}' };
};

await checkAsync('★ 未配置网关 ⇒ unconfigured 且不发请求', async () => {
	let called = 0;
	await withFetch(async () => { called += 1; return { ok: true, text: async () => '{}' }; }, async () => {
		const r = await syncMemoryToAgentMemory({ ...config, agentMemoryGatewayUrl: '' }, 'bot-a', { env: {} });
		assert.equal(r.state, 'unconfigured');
		assert.equal(r.added, 0);
	});
	assert.equal(called, 0);
});

await checkAsync('MEMORY.md 没有条目 ⇒ empty（不误报成功）', async () => {
	await writeCoreMemory(config, 'bot-empty', '# 记忆\n\n<!-- 只有注释 -->\n');
	await withFetch(okFetch([]), async () => {
		const r = await syncMemoryToAgentMemory({ ...config, agentMemoryGatewayUrl: 'http://g:1' }, 'bot-empty', { env: {} });
		assert.equal(r.state, 'online');
		assert.equal(r.empty, true);
		assert.equal(r.added, 0);
	});
});

await checkAsync('★ 首次同步：逐条 writeMemory，entry 形状正确', async () => {
	await writeCoreMemory(config, 'bot-a', ['# 记忆', '', '- 偏好中文', '- 评测集在 D:\\eval', ''].join('\n'));
	const calls = [];
	await withFetch(okFetch(calls), async () => {
		const r = await syncMemoryToAgentMemory({ ...config, agentMemoryGatewayUrl: 'http://g:1' }, 'bot-a', { env: {} });
		assert.equal(r.state, 'online');
		assert.equal(r.added, 2, JSON.stringify(r));
		assert.equal(r.skipped, 0);
	});
	assert.equal(calls.length, 2);
	assert.ok(calls[0].url.includes('/provider/writeMemory'), calls[0].url);
	assert.deepEqual(calls[0].body.args[0], 'bot-a');
	assert.deepEqual(calls[0].body.args[1], { type: 'note', content: '偏好中文' });
});

await checkAsync('★ 第二次同步：全部跳过（hash 去重生效）', async () => {
	const calls = [];
	await withFetch(okFetch(calls), async () => {
		const r = await syncMemoryToAgentMemory({ ...config, agentMemoryGatewayUrl: 'http://g:1' }, 'bot-a', { env: {} });
		assert.equal(r.added, 0, '不该重复写：' + JSON.stringify(r));
		assert.equal(r.skipped, 2);
	});
	assert.equal(calls.length, 0, '去重后不该发任何请求');
});

await checkAsync('★ 新增一条只写那一条', async () => {
	await writeCoreMemory(config, 'bot-a', ['# 记忆', '', '- 偏好中文', '- 评测集在 D:\\eval', '- 新加的一条', ''].join('\n'));
	const calls = [];
	await withFetch(okFetch(calls), async () => {
		const r = await syncMemoryToAgentMemory({ ...config, agentMemoryGatewayUrl: 'http://g:1' }, 'bot-a', { env: {} });
		assert.equal(r.added, 1);
		assert.equal(r.skipped, 2);
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].body.args[1].content, '新加的一条');
});

await checkAsync('★ 一条失败不中断其它（failed 逐条回报）', async () => {
	await writeCoreMemory(config, 'bot-b', ['- 会失败的', '- 会成功的'].join('\n'));
	await withFetch(async (url, init) => {
		const entry = JSON.parse(init.body).args[1];
		if (entry.content === '会失败的') { throw new Error('boom 500'); }
		return { ok: true, text: async () => '{"ok":true}' };
	}, async () => {
		const r = await syncMemoryToAgentMemory({ ...config, agentMemoryGatewayUrl: 'http://g:1' }, 'bot-b', { env: {} });
		assert.equal(r.added, 1);
		assert.equal(r.failed.length, 1);
		assert.ok(String(r.failed[0].error).includes('boom'));
	});
});

await checkAsync('★ 去重状态存 <dataRoot>/agent-memory-sync.json，且**不写进记忆目录**', async () => {
	const r = await withFetch(okFetch([]), () => syncMemoryToAgentMemory({ ...config, agentMemoryGatewayUrl: 'http://g:1' }, 'bot-a', { env: {} }));
	assert.ok(r);
	const stateFile = join(config.dataRoot, 'agent-memory-sync.json');
	const j = JSON.parse(readFileSync(stateFile, 'utf8'));
	assert.equal(j.version, 1);
	assert.ok(Array.isArray(j.agents['bot-a'].hashes));
	assert.ok(j.agents['bot-a'].hashes.length >= 3);
	/* 记忆目录里不该出现状态文件（否则 git status 永远脏） */
	const memDir = memoryDirOf(config, 'bot-a');
	let dirty = false;
	try { readFileSync(join(memDir, 'agent-memory-sync.json'), 'utf8'); dirty = true; } catch { dirty = false; }
	assert.equal(dirty, false, '去重状态不能落在 git 工作树里');
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ AgentMemory 同步单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
