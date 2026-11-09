// @vssaros/dsh-agents — 创建 Agent 的校验 / 写盘链（2026-11-09 质量修复）
//   跑法：node dsh-plugins/vssaros-agents/test/create.test.mjs
//
// 起因：`createAgentFromDraft` / `validateDraft` / `previewAgentDraft` 此前只有 team-bus.test.mjs
//   的 3 个用例间接覆盖，run-agents-check.mjs 对整条 create 链零断言。
// 覆盖：规则（保留名 / . 结尾 / preset 碰撞 / 内置根撞名 / 列表字符集 / 绝对路径 / 人格 warning）、
//   serializeAgentMd 空字段、previewAgentDraft 双根合并、写盘 / 409 / 并发只成功一次 / 不覆盖。
//
// ⚠ 未覆盖（需要 mock fs 或构造完整 dsh ctx，留待 HTTP 级集成测试）：
//   writeFile 'wx' 失败后的空目录清理、syncPresets 失败后 registered:false 的 HTTP 返回。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentFromDraft, previewAgentDraft } from '../lib/create.js';
import { normalizeDraft, serializeAgentMd, validateDraft } from '../lib/core/create.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => {
	try { await fn(); pass += 1; }
	catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); }
};

const root = mkdtempSync(join(tmpdir(), 'vssaros-create-'));
const builtinRoot = join(root, 'builtin');
const agentsRoot = join(root, 'agents');
// 内置 agent 通常不在展示名册里（userFacing 白名单）⇒ 前端重名预校验也看不见它们。
mkdirSync(join(builtinRoot, 'coder'), { recursive: true });
mkdirSync(join(builtinRoot, 'reviewer'), { recursive: true });
const config = { dataRoot: root, agentsRoot, agentsBuiltinRoot: builtinRoot };
const draftOf = (over) => normalizeDraft({ name: '测试 bot', id: 'test-bot', ...(over || {}) });

await checkAsync('validateDraft：合法草稿通过；空 persona 给 warning', async () => {
	const r = validateDraft(draftOf());
	assert.deepEqual(r.errors, []);
	assert.equal(r.conflict, false);
	assert.ok(r.warnings.some((w) => w.includes('人格正文')));
});

await checkAsync('validateDraft：保留名 / 以 . 结尾 / 非法字符都拦住，且不算 conflict', async () => {
	for (const id of ['con', 'tester.', 'bad id']) {
		const r = validateDraft(draftOf({ id }));
		assert.ok(r.errors.length, id);
		assert.equal(r.conflict, false, id);
	}
});

await checkAsync('validateDraft：preset id 碰撞（. 与 _ 折成 -）带 409 语义', async () => {
	const r = validateDraft(draftOf({ id: 'a.b' }), { existingIds: ['a-b'] });
	assert.ok(r.errors.some((e) => e.includes('撞了 preset id')));
	assert.equal(r.conflict, true);
});

await checkAsync('validateDraft：内置根 id 也占坑，文案点名「内置」', async () => {
	const r = validateDraft(draftOf({ id: 'coder' }), { builtinIds: ['coder', 'reviewer'] });
	assert.equal(r.conflict, true);
	assert.ok(r.errors.some((e) => e.includes('内置')));
});

await checkAsync('validateDraft：tools/skills 过字符集；名字是否真实存在仍不校验（钉住已知缺口）', async () => {
	const bad = validateDraft(draftOf({ tools: ['bad tool!'] }));
	assert.ok(bad.errors.some((e) => e.includes('工具名不合法')));
	const ok = validateDraft(draftOf({ tools: ['file_read'], skills: ['not-a-real-skill'] }));
	assert.deepEqual(ok.errors, []);
});

await checkAsync('validateDraft：工作区必须写绝对路径', async () => {
	const r = validateDraft(draftOf({ workspacesRead: ['./relative'] }));
	assert.ok(r.errors.some((e) => e.includes('绝对路径')));
});

await checkAsync('serializeAgentMd：空字段不写；只交 5 个字段时产出的是「空壳」', async () => {
	const text = serializeAgentMd(draftOf());
	assert.match(text, /^---\nname: 测试 bot\n/);
	assert.ok(!/skills:|tools:|model:/.test(text));
	assert.ok(text.endsWith('---\n'), '正文为空时不该多出正文');
});

await checkAsync('previewAgentDraft：内置根 + 自定义根一起占 id（不再能静默劫持内置 agent）', async () => {
	const p = await previewAgentDraft(config, { name: '劫持', id: 'coder' });
	assert.equal(p.conflict, true);
	assert.ok(p.errors.some((e) => e.includes('内置')));
	assert.ok(p.agentMd.includes('name: 劫持'));
});

await checkAsync('previewAgentDraft：表单只交 5 字段 ⇒ 明确 warning「没写人格正文」', async () => {
	const p = await previewAgentDraft(config, {
		name: '空壳', id: 'shell-bot', role: '审阅', description: '说明', icon: 'lucide:bot',
	});
	assert.deepEqual(p.errors, []);
	assert.ok(p.warnings.some((w) => w.includes('人格正文')));
	assert.ok(!p.agentMd.includes('skills:'));
});

await checkAsync('createAgentFromDraft：写盘 + 返回 file / presetId / warnings', async () => {
	const c = await createAgentFromDraft(config, { name: '发布 bot', id: 'release-bot', persona: '你负责发布。' });
	assert.equal(c.id, 'release-bot');
	assert.equal(c.presetId, 'vssaros-release-bot');
	assert.deepEqual(c.warnings, []);
	const text = readFileSync(c.file, 'utf8');
	assert.match(text, /name: 发布 bot/);
	assert.match(text, /你负责发布。/);
});

await checkAsync('createAgentFromDraft：用内置 id 新建 ⇒ 409，且不写盘', async () => {
	await assert.rejects(
		() => createAgentFromDraft(config, { name: '劫持', id: 'coder' }),
		(e) => e.httpStatus === 409,
	);
	assert.equal(existsSync(join(agentsRoot, 'coder')), false);
});

await checkAsync('createAgentFromDraft：同名 id 不覆盖（409）', async () => {
	await assert.rejects(
		() => createAgentFromDraft(config, { name: '另一个', id: 'release-bot' }),
		(e) => e.httpStatus === 409,
	);
	assert.match(readFileSync(join(agentsRoot, 'release-bot', '.agent.md'), 'utf8'), /name: 发布 bot/);
});

await checkAsync('createAgentFromDraft：preset 碰撞 ⇒ 409（conflict 字段，不再靠字符串匹配）', async () => {
	await createAgentFromDraft(config, { name: '连字符', id: 'a-b' });
	await assert.rejects(
		() => createAgentFromDraft(config, { name: '点号', id: 'a.b' }),
		(e) => e.httpStatus === 409,
	);
});

await checkAsync('createAgentFromDraft：并发同 id 只成功一次（mkdir + wx 双保险）', async () => {
	const rs = await Promise.allSettled([
		createAgentFromDraft(config, { name: '并发 A', id: 'race-bot' }),
		createAgentFromDraft(config, { name: '并发 B', id: 'race-bot' }),
	]);
	assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
	const rejected = rs.filter((r) => r.status === 'rejected');
	assert.equal(rejected.length, 1);
	assert.ok(rejected[0].reason?.httpStatus === 409 || rejected[0].reason?.code === 'EEXIST');
});

rmSync(root, { recursive: true, force: true });
console.log(`create: ${pass} passed, ${fails.length} failed`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
process.exitCode = fails.length ? 1 : 0;
