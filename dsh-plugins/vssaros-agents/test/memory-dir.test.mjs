// @vssaros/dsh-agents — 记忆目录推导（2026-10-27「记忆没有内容」）
//   跑法：node dsh-plugins/vssaros-agents/test/memory-dir.test.mjs
//
// 这一层错了的症状特别隐蔽：页签不报错、只是**永远是 0 条**（用户以为功能坏了）。
// 三条必须钉住：
//   ① 自定义 agent 仍用 `<agentsRoot>/<id>/memory`（原行为，绝不能变）
//   ② 内置/预设 agent 在 agentsRoot 下没有目录 ⇒ 落到 `<dataRoot>/agent-memory/<id>`
//      （它的 md 在 agents-builtin 的 runDir 副本里，每次启动重建 ⇒ 写进去会丢）
//   ③ 写入后能立刻列出来（证明读写用的是同一条路径）
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listMemoryFiles, memoryDirOf, readMemoryFile, writeCoreMemory } from '../lib/memory.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-memdir-'));
const agentsRoot = join(root, 'agents');
const dataRoot = join(root, 'data');
const config = { agentsRoot, dataRoot };
mkdirSync(join(agentsRoot, 'my-custom-bot'), { recursive: true });

check('★ 自定义 agent：仍用 <agentsRoot>/<id>/memory（原行为不能变）', () => {
	assert.equal(memoryDirOf(config, 'my-custom-bot'), join(agentsRoot, 'my-custom-bot', 'memory'));
});

check('★ 内置 agent（agentsRoot 下无目录）：落到 <dataRoot>/agent-memory/<id>', () => {
	assert.equal(
		memoryDirOf(config, 'knowledge-base-expert'),
		join(dataRoot, 'agent-memory', 'knowledge-base-expert'),
		'内置 agent 的 md 在 agents-builtin 的 runDir 副本里 ⇒ 记忆不能写那儿（重启丢）',
	);
});

check('两个 agent 的记忆目录互不干扰', () => {
	assert.notEqual(memoryDirOf(config, 'my-custom-bot'), memoryDirOf(config, 'knowledge-base-expert'));
});

check('空 id 不抛（返回一个路径即可，调用方会自己判空）', () => {
	assert.equal(typeof memoryDirOf(config, ''), 'string');
	assert.equal(typeof memoryDirOf(config, undefined), 'string');
});

await checkAsync('★ 写入后能立刻列出（证明读写同一条路径）', async () => {
	const r = await writeCoreMemory(config, 'knowledge-base-expert', '- 记住：用户偏好中文答复\n');
	assert.equal(r.name, 'MEMORY.md');
	const listing = await listMemoryFiles(config, 'knowledge-base-expert');
	const names = (listing.files || []).map((f) => f.name);
	assert.ok(names.includes('MEMORY.md'), '列不出刚写的文件：' + JSON.stringify(names));
	const back = await readMemoryFile(config, 'knowledge-base-expert', 'MEMORY.md');
	assert.ok(String(back.text).includes('中文答复'));
});

await checkAsync('自定义 agent 的写入不落到 dataRoot（隔离）', async () => {
	await writeCoreMemory(config, 'my-custom-bot', '- 自定义 bot 的记忆\n');
	const own = await listMemoryFiles(config, 'my-custom-bot');
	assert.ok((own.files || []).some((f) => f.name === 'MEMORY.md'));
	// 内置那个不受影响（内容仍是上一条）
	const builtin = await readMemoryFile(config, 'knowledge-base-expert', 'MEMORY.md');
	assert.ok(!String(builtin.text).includes('自定义 bot 的记忆'));
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }

const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ 记忆目录单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
