// @vssaros/dsh-agents — 记忆库初始化（2026-10-27「记忆/演化/版本/分支都没内容」）
//   跑法：node dsh-plugins/vssaros-agents/test/memory-init.test.mjs
//
// 这一层错了的症状同样是**静默**：四个页签全空，不报错。
// 四条必须钉住：
//   ① 空目录 ⇒ 写出 MEMORY.md 模板 + git init + 至少 1 条提交（否则版本/分支永远空）
//   ② 幂等：再调一次不产生新提交、`created` 为 false
//   ③ **绝不覆盖**已有 MEMORY.md（用户/agent 写的内容是资产）
//   ④ git 不可用时**不抛**（文件模式仍可用 —— 这是我们相对 DeepSeekBot 的优势）
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CORE_MEMORY_TEMPLATE, ensureMemoryRepo } from '../lib/memory.js';
import { gitLogOf, gitStatusOf, listMemoryFiles, listVersions, memoryDirOf, readMemoryFile, setVersion, INITIAL_VERSION_TAG } from '../lib/memory.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-meminit-'));
const config = { agentsRoot: join(root, 'agents'), dataRoot: join(root, 'data') };
mkdirSync(config.agentsRoot, { recursive: true });

await checkAsync('★ 空目录 ⇒ 写模板 + git init + 至少 1 条提交', async () => {
	const r = await ensureMemoryRepo(config, 'fresh-bot');
	assert.equal(r.ok, true);
	assert.equal(r.wroteTemplate, true, '首次应写模板');

	const dir = memoryDirOf(config, 'fresh-bot');
	assert.ok(existsSync(join(dir, 'MEMORY.md')), '模板文件没写出来');
	assert.ok(existsSync(join(dir, '.git')), 'git 没初始化（版本/分支会永远空）');

	const listing = await listMemoryFiles(config, 'fresh-bot');
	assert.ok((listing.files || []).some((f) => f.name === 'MEMORY.md'));

	const st = await gitStatusOf(config, 'fresh-bot');
	assert.equal(st.enabled, true, 'git 应可用');
	const log = await gitLogOf(config, 'fresh-bot', st, 10);
	assert.ok((log.log || []).length >= 1, '初始提交缺失（演化页签会空）：' + JSON.stringify(log));
});

await checkAsync('★ 幂等：再调一次不新增提交', async () => {
	const before = await gitLogOf(config, 'fresh-bot', await gitStatusOf(config, 'fresh-bot'), 50);
	const r = await ensureMemoryRepo(config, 'fresh-bot');
	assert.equal(r.created, false, '第二次不应再创建');
	assert.equal(r.wroteTemplate, false, '第二次不应再写模板');
	const after = await gitLogOf(config, 'fresh-bot', await gitStatusOf(config, 'fresh-bot'), 50);
	assert.equal((after.log || []).length, (before.log || []).length, '不该产生空提交');
});

await checkAsync('★ 绝不覆盖已有 MEMORY.md', async () => {
	const mine = '- 用户自己写的记忆：偏好中文\n';
	await ensureMemoryRepo(config, 'owned-bot');
	const dir = memoryDirOf(config, 'owned-bot');
	writeFileSync(join(dir, 'MEMORY.md'), mine, 'utf8');
	await ensureMemoryRepo(config, 'owned-bot');
	const back = await readMemoryFile(config, 'owned-bot', 'MEMORY.md');
	assert.equal(String(back.text), mine, '模板覆盖了用户内容');
});

await checkAsync('模板内容包含引导（不是空文件）', async () => {
	const t = CORE_MEMORY_TEMPLATE;
	assert.ok(t.includes('# 记忆'), '模板应有标题');
	assert.ok(t.includes('新会话'), '模板应说明改动何时生效');
	assert.ok(t.length > 40);
});

await checkAsync('★ git 不可用时不抛（文件模式仍可用）', async () => {
	/*
	 * 造不出"没装 git"的环境，但可以把 PATH 清空 —— git 是子进程，找不到就会失败。
	 * 断言：ensureMemoryRepo 仍返回 ok，且 MEMORY.md 存在（只是没有版本历史）。
	 */
	const old = process.env.PATH;
	try {
		process.env.PATH = join(root, 'no-such-bin');
		const r = await ensureMemoryRepo(config, 'nogit-bot');
		assert.equal(r.ok, true, 'git 不可用不该让记忆整体失败');
		assert.equal(r.git, 'unavailable', '应如实回报 git 不可用，而不是假装 ready');
		assert.ok(existsSync(join(memoryDirOf(config, 'nogit-bot'), 'MEMORY.md')));
	} finally {
		process.env.PATH = old;
	}
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

await checkAsync('★ 初始化后「版本」页签有内容（自动打 v0）', async () => {
	await ensureMemoryRepo(config, 'ver-bot');
	const v = await listVersions(config, 'ver-bot');
	assert.equal(v.enabled, true);
	assert.ok(v.versions.length >= 1, "初始化后应当至少有一个 tag：" + JSON.stringify(v));
	assert.equal(v.versions[0].tag, INITIAL_VERSION_TAG);
	/* tag 必须指向种子提交（否则「版本」与「演化」对不上） */
	const log = await gitLogOf(config, 'ver-bot', await gitStatusOf(config, 'ver-bot'), 5);
	assert.equal(v.versions[0].hash.slice(0, 8), String(log.log[0].hash || log.log[0].rev || '').slice(0, 8));
});

await checkAsync('★ 已有 tag 时不再补 v0（用户自己的版本名不能被插队）', async () => {
	await ensureMemoryRepo(config, 'ver-bot2');
	await setVersion(config, 'ver-bot2', INITIAL_VERSION_TAG, true);   // 删掉自动打的 v0
	await setVersion(config, 'ver-bot2', 'only-one');                  // 用户自己起一个
	await ensureMemoryRepo(config, 'ver-bot2');                        // 再初始化一次
	const tags = (await listVersions(config, 'ver-bot2')).versions.map((x) => x.tag);
	assert.deepEqual(tags, ['only-one'], '已有版本时不该补 v0：' + JSON.stringify(tags));
});

await checkAsync('重复初始化不会重复打 v0', async () => {
	await ensureMemoryRepo(config, 'ver-bot3');
	const r = await ensureMemoryRepo(config, 'ver-bot3');
	assert.equal(r.tagged, '', '第二次不该再打 tag');
	const tags = (await listVersions(config, 'ver-bot3')).versions.map((x) => x.tag);
	assert.equal(tags.filter((t) => t === INITIAL_VERSION_TAG).length, 1, JSON.stringify(tags));
});

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 记忆初始化单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
