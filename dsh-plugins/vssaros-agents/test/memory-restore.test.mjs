// @vssaros/dsh-agents — 回滚的**数据安全性**（2026-10-31；对齐 DSB 的「恢复只往前追加」）
//   跑法：node dsh-plugins/vssaros-agents/test/memory-restore.test.mjs
//
// 要守的事实：回滚 = 覆盖文件 → 提交。如果**不先把未提交的改动存成一条提交**，
// 那些改动就在 Git 里彻底消失（提交时工作区已经是旧内容 ⇒ 连"回滚前长什么样"都查不到）。
// DSB 的口径是"所有能回去的点都在同一张图里" ⇒ 本测试断言：回滚后，未提交的内容**仍能在历史里找到**。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enableGit, gitLogOf, gitShowMemoryFile, gitStatusOf, memoryDirOf, restoreMemoryFile, snapshotGit } from '../lib/memory.js';

let pass = 0;
const fails = [];
const check = async (n, fn) => {
	try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

const root = mkdtempSync(join(tmpdir(), 'vssaros-restore-'));
const config = { dataRoot: root };
const agent = 'demo';

await check('启用 Git', async () => {
	const r = await enableGit(config, agent);
	assert.equal(r.enabled, true);
});

const dir = memoryDirOf(config, agent);
const file = join(dir, 'MEMORY.md');

/* v1：提交过的版本 */
writeFileSync(file, '# 记忆\n\n- v1 的一条\n', 'utf8');
await snapshotGit(config, agent, 'v1');
const logV1 = await gitLogOf(config, agent, undefined, 20);
const revV1 = logV1.log[0].hash;

/* 改一条但**不提交** —— 这就是"未提交改动" */
writeFileSync(file, '# 记忆\n\n- v1 的一条\n- 还没提交的一条\n', 'utf8');

await check('前提：此刻确实有未提交改动', async () => {
	const st = await gitStatusOf(config, agent);
	assert.ok(st.dirty >= 1, `dirty=${st.dirty}`);
});

let restored;
await check('回滚到 v1', async () => {
	restored = await restoreMemoryFile(config, agent, revV1, 'MEMORY.md');
	assert.equal(restored.name, 'MEMORY.md');
});

await check('★★ 未提交改动被先存成了一条提交（不是被抹掉）', async () => {
	assert.ok(restored.backup && restored.backup.committed === true, JSON.stringify(restored.backup));
});

await check('★★ 那些内容**仍能在历史里找到**（回滚后查得到"回滚前长什么样"）', async () => {
	const log = await gitLogOf(config, agent, undefined, 20);
	assert.ok(log.log.length >= 3, `commits=${log.log.length}`);
	const texts = [];
	for (const c of log.log.slice(0, 5)) {
		const s = await gitShowMemoryFile(config, agent, c.hash, 'MEMORY.md').catch(() => ({ text: '' }));
		texts.push(String(s.text || ''));
	}
	assert.ok(
		texts.some((t) => t.includes('还没提交的一条')),
		`历史里找不到未提交的那条：${JSON.stringify(texts)}`,
	);
});

await check('当前工作区确实是回滚后的旧内容', async () => {
	const now = readFileSync(file, 'utf8');
	assert.ok(now.includes('v1 的一条'));
	assert.equal(now.includes('还没提交的一条'), false);
});

await check('回滚本身也落了一条提交（便于再回滚 / 看清是谁改的）', async () => {
	assert.ok(restored.snapshot && restored.snapshot.committed === true, JSON.stringify(restored.snapshot));
});

try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* tmp 自清 */ }

console.log(`\n[memory-restore] ${pass} passing / ${fails.length} failing`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
process.exit(fails.length === 0 ? 0 : 1);
