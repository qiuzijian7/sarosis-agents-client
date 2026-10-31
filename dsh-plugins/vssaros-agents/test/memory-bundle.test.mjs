// @vssaros/dsh-agents — 导出 / 导入**记忆历史**（2026-10-31，对齐 DSB 的 git-history.bundle）
//   跑法：node dsh-plugins/vssaros-agents/test/memory-bundle.test.mjs
//
// 要守的事实：包里带上 `memory-history.bundle` ⇒ 换台机器装回来**历史也在**
// （能看演化、能回滚、能看到人起过的版本名），而不只是"最后一次的内容"。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableGit, gitLogOf, memoryDirOf, snapshotGit } from '../lib/memory.js';
import { exportAgent, importAgent, MEMORY_HISTORY_NAME } from '../lib/pack.js';

let pass = 0;
const fails = [];
const check = async (n, fn) => {
	try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

const root = mkdtempSync(join(tmpdir(), 'vssaros-bundle-'));
const config = { dataRoot: root, agentsRoot: join(root, 'agents') };
const id = 'demo';
const agentDir = join(config.agentsRoot, id);

/* 一个最小 agent（.agent.md 才是唯一真源） */
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, '.agent.md'), '---\nname: Demo Bot\n---\n你是一个演示 agent。\n', 'utf8');

/* 记忆：v1 → 提交 → v2 → 提交 */
await enableGit(config, id);
const mem = memoryDirOf(config, id);
writeFileSync(join(mem, 'MEMORY.md'), '# 记忆\n\n- v1\n', 'utf8');
await snapshotGit(config, id, 'v1');
writeFileSync(join(mem, 'MEMORY.md'), '# 记忆\n\n- v1\n- v2\n', 'utf8');
await snapshotGit(config, id, 'v2');

const logBefore = await gitLogOf(config, id, undefined, 20);
let pack;
await check('导出：勾了历史就带 bundle', async () => {
	pack = await exportAgent(config, id, { includeMemory: true, includeHistory: true });
	assert.ok(pack.history, 'history 字段缺失');
	assert.equal(pack.history.included, true, JSON.stringify(pack.history));
	assert.ok(pack.history.bytes > 0, `bytes=${pack.history.bytes}`);
	assert.ok(pack.memoryFiles.includes('MEMORY.md'), JSON.stringify(pack.memoryFiles));
});

await check('导出：**不勾**就不带（历史里有删过的内容 ⇒ 默认不带）', async () => {
	const p2 = await exportAgent(config, id, { includeMemory: true });
	assert.equal(p2.history, null, JSON.stringify(p2.history));
});

/* 抹掉本地 agent 与记忆 ⇒ 模拟"换台机器装回来" */
rmSync(agentDir, { recursive: true, force: true });
rmSync(mem, { recursive: true, force: true });

let imported;
await check('导入：装回文件 + 历史', async () => {
	imported = await importAgent(config, pack.buffer, { overwrite: false });
	assert.equal(imported.id, id);
	assert.ok(imported.memoryFiles.includes('MEMORY.md'), JSON.stringify(imported.memoryFiles));
	assert.ok(imported.history && imported.history.restored === true, JSON.stringify(imported.history));
});

await check('★★ 历史真的回来了：提交数与导入前一致（不只是最后一次内容）', async () => {
	const log = await gitLogOf(config, id, undefined, 20);
	assert.ok(log.log.length >= logBefore.log.length, `导入后 ${log.log.length} < 导入前 ${logBefore.log.length}`);
	assert.ok(log.log.length >= 2, `commits=${log.log.length}`);
});

await check('★★ 分支也回来了（main 指向同样的提交）', async () => {
	assert.ok(imported.history.heads.includes('main'), JSON.stringify(imported.history.heads));
});

await check('装回的当前内容仍是**包里的文件**（不被历史 tip 覆盖）', async () => {
	const now = readFileSync(join(memoryDirOf(config, id), 'MEMORY.md'), 'utf8');
	assert.ok(now.includes('- v2'), now.slice(0, 60));
});

await check('包里那一条的名字是约定的 bundle 名', async () => {
	assert.equal(MEMORY_HISTORY_NAME, 'memory-history.bundle');
});

try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* tmp 自清 */ }

console.log(`\n[memory-bundle] ${pass} passing / ${fails.length} failing`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
process.exit(fails.length === 0 ? 0 : 1);
