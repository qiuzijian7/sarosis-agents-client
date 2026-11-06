// @vssaros/dsh-agents — DS Bot 团队离线导入（2026-11-06，superagent v2 第 8 项「适配层」）
//   跑法：node dsh-plugins/vssaros-agents/test/ds-bot-import.test.mjs
//
// 覆盖：
//   · 规划：version 不对拒绝；私密 Bot 跳过；id 不撞（中文名退到 dsbot-<原 id>）；人设/角色/工作目录照搬；
//     skill 能力（含 pack 里的）落成 dsbot-<名>，MCP 不导并说明；模型不导并说明；记忆事实去掉元数据、跳过 Index；
//     群换成新 id 并列出没导入的成员；密钥只列名字
//   · 落盘（临时目录）：预览不写任何文件；--apply 写 .agent.md（带 imported-from）、SKILL.md、记忆收件箱；
//     再跑一次全部跳过（already-imported）；CLI 子命令同口径
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { factsOf, importedSourceOf, markImported, planDsBotImport } from '../lib/core/dsBotImport.js';
import { dsBotHomeOf, importDsBotTeam } from '../lib/importDsBotTeam.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n').slice(0, 6).join(' | ')}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-ds-bot-import-'));
const dsHome = join(root, 'dsh', 'bot');
const ada = 'a1b2c3d4-0000-4000-8000-000000000001', zhang = 'e5f6a7b8-0000-4000-8000-000000000002', secret = 'c0ffee00-0000-4000-8000-000000000003';
const state = {
	version: 1, mainBotIds: [ada],
	bots: {
		[ada]: { id: ada, name: 'Ada', role: 'Researcher', instructions: 'You dig into papers and summarize findings with citations.', createdAt: 1, createdBy: null,
			capabilities: ['web-notes', 'kit', 'github-mcp'], model: 'deepseek/deepseek-chat', workDir: join(root, 'research'), permission: 'workspace-write', sessionId: ada },
		[zhang]: { id: zhang, name: '张工', role: '测试', instructions: '你负责回归测试。', createdAt: 2, createdBy: ada, capabilities: [], workDir: 'relative/dir' },
		[secret]: { id: secret, name: 'Hidden', role: '', instructions: 'x', createdAt: 3, createdBy: null, capabilities: [], private: true },
	},
	rooms: { 'room-1': { id: 'room-1', name: 'Launch crew', members: [ada, zhang, secret], admin: ada, mode: 'admin', notice: 'Ship v2 by Friday.' } },
	capabilities: { items: {
		'web-notes': { name: 'web-notes', kind: 'skill', description: 'How to take notes', content: '# Notes\n\nWrite them down.' },
		'test-run': { name: 'test-run', kind: 'skill', description: 'Run the tests', content: 'pnpm test' },
		kit: { name: 'kit', kind: 'pack', items: ['test-run', 'github-mcp'] },
		'github-mcp': { name: 'github-mcp', kind: 'mcp', transport: 'stdio', command: 'npx', args: ['gh-mcp'], env: { TOKEN: '$DSH_SECRET_GH' } },
	} },
};
mkdirSync(join(dsHome, 'memory', 'bots', ada), { recursive: true });
writeFileSync(join(dsHome, 'state.json'), JSON.stringify(state), 'utf8');
writeFileSync(join(dsHome, 'secrets.json'), JSON.stringify({ secrets: [{ name: 'GH', value: 'ghp_SHOULD_NEVER_BE_READ_OUT', purpose: 'github' }] }), 'utf8');
writeFileSync(join(dsHome, 'memory', 'bots', ada, 'MEMORY.md'), '# Memory\n\n## Index\n- [[papers]]\n\n## Facts\n- Prefers arXiv over blogs [source: user; added: 2026-10-01]\n- Cites with DOI\n', 'utf8');
const config = { agentsRoot: join(root, 'vs', 'agents'), dataRoot: join(root, 'vs') };
mkdirSync(join(config.agentsRoot, 'ada'), { recursive: true }); // 一个已占用的 id

await checkAsync('规划：拒绝不认识的版本；私密跳过；id 不撞；人设/角色/工作目录；skill 与 pack 落成 dsbot-*，MCP 与模型说明；记忆；群；密钥只列名', async () => {
	assert.throws(() => planDsBotImport({ version: 2, bots: {} }), /只认 1/);
	assert.throws(() => planDsBotImport({ version: 1 }), /缺 bots/);
	assert.deepEqual(factsOf('# Memory\n\n## Index\n- [[x]]\n\n## Facts\n- A [source: u]\n- B\n'), ['A', 'B']);
	const plan = planDsBotImport(state, { existingIds: ['ada'], memoryOf: (id) => (id === ada ? readFileSync(join(dsHome, 'memory', 'bots', ada, 'MEMORY.md'), 'utf8') : undefined), secretNames: ['GH'] });
	const byName = Object.fromEntries(plan.bots.map(bot => [bot.name, bot]));
	assert.equal(byName.Hidden.action, 'skip');
	assert.equal(byName.Hidden.reason, 'private');
	assert.equal(byName.Ada.id, 'dsbot-ada', 'ada 已占用 ⇒ dsbot-ada');
	assert.equal(byName['张工'].id, 'dsbot-e5f6a7b8', '中文名 ⇒ dsbot-<原 id 前 8 位>');
	assert.equal(byName.Ada.draft.persona, state.bots[ada].instructions);
	assert.equal(byName.Ada.draft.role, 'Researcher');
	assert.deepEqual(byName.Ada.draft.workspacesWrite, [state.bots[ada].workDir]);
	assert.deepEqual(byName['张工'].draft.workspacesWrite, []);
	assert.deepEqual(byName.Ada.draft.skills, ['dsbot-web-notes', 'dsbot-test-run']);
	assert.ok(byName.Ada.notes.some(note => /deepseek\/deepseek-chat/.test(note)));
	assert.ok(byName.Ada.notes.some(note => /MCP 能力 github-mcp/.test(note)));
	assert.ok(byName['张工'].notes.some(note => /不是绝对路径/.test(note)));
	assert.deepEqual(byName.Ada.memory, ['Prefers arXiv over blogs', 'Cites with DOI']);
	assert.deepEqual(plan.skills.map(skill => skill.name), ['dsbot-web-notes', 'dsbot-test-run']);
	assert.deepEqual(plan.groups, [{ source: 'room-1', name: 'Launch crew', members: ['dsbot-ada', 'dsbot-e5f6a7b8'], missing: 1, admin: 'dsbot-ada', mode: 'admin', notice: 'Ship v2 by Friday.' }]);
	assert.deepEqual(plan.secrets, ['GH']);
	assert.ok(!JSON.stringify(plan).includes('ghp_SHOULD_NEVER'));
	// 真机数据（2026-11-06）：DS Bot 的 id 是 `session-<hex>` 形的会话 id
	const sessionIds = planDsBotImport({ version: 1, bots: { 'session-e1f2a3b4c5': { id: 'session-e1f2a3b4c5', name: '产品', instructions: 'x' },
		'session-77aa88bb99': { id: 'session-77aa88bb99', name: '架构', instructions: 'y' } } });
	assert.deepEqual(sessionIds.bots.map(bot => bot.id), ['dsbot-e1f2a3b4', 'dsbot-77aa88bb']);
	assert.equal(importedSourceOf(markImported('---\nname: a\n---\nbody', ada).text), ada);
	assert.equal(markImported(markImported('---\nname: a\n---\n', ada).text, 'other').text.match(/imported-from/g).length, 1);
});

await checkAsync('落盘：预览不写；--apply 写 .agent.md（带导入标记）、SKILL.md、记忆收件箱；再跑一次全部跳过', async () => {
	const preview = await importDsBotTeam(config, { dsHome });
	assert.equal(preview.bots.filter(bot => bot.action === 'create').length, 2);
	assert.deepEqual(readdirSync(config.agentsRoot), ['ada'], '预览不写');
	assert.equal(existsSync(join(config.dataRoot, 'skills')), false);
	const applied = await importDsBotTeam(config, { dsHome, apply: true });
	assert.deepEqual(applied.applied.failed, []);
	assert.deepEqual(applied.applied.bots.map(bot => bot.id).sort(), ['dsbot-ada', 'dsbot-e5f6a7b8']);
	const md = readFileSync(join(config.agentsRoot, 'dsbot-ada', '.agent.md'), 'utf8');
	assert.match(md, new RegExp(`imported-from: ds-bot:${ada}`));
	assert.match(md, /You dig into papers/);
	assert.match(md, /dsbot-web-notes/);
	assert.match(readFileSync(join(config.dataRoot, 'skills', 'dsbot-web-notes', 'SKILL.md'), 'utf8'), /^---\nname: dsbot-web-notes\n[\s\S]*Write them down\./);
	assert.equal(applied.applied.facts, 2);
	const inbox = readdirSync(join(config.agentsRoot, 'dsbot-ada'), { recursive: true }).find(file => String(file).endsWith('MEMORY.md'));
	assert.match(readFileSync(join(config.agentsRoot, 'dsbot-ada', String(inbox)), 'utf8'), /\[从 DS Bot 导入\] Prefers arXiv over blogs/);
	const again = await importDsBotTeam(config, { dsHome, apply: true });
	assert.deepEqual(again.bots.filter(bot => bot.action === 'create'), []);
	assert.deepEqual(again.bots.filter(bot => bot.reason === 'already-imported').map(bot => bot.id).sort(), ['dsbot-ada', 'dsbot-e5f6a7b8']);
	assert.deepEqual(again.groups[0].members, ['dsbot-ada', 'dsbot-e5f6a7b8'], '群成员仍能对上已导入的 id');
	assert.equal(again.applied.facts, 0, '不重复写记忆');
});

await checkAsync('DS Bot 目录：--ds-home > $DSH_HOME/bot > ~/.dsh/bot；CLI 子命令预览并说明', async () => {
	assert.equal(dsBotHomeOf(dsHome), dsHome);
	assert.equal(dsBotHomeOf(undefined, { DSH_HOME: join(root, 'dsh') }), join(root, 'dsh', 'bot'));
	assert.match(dsBotHomeOf(undefined, {}), /[\\/]\.dsh[\\/]bot$/);
	const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent.mjs');
	const other = { agentsRoot: join(root, 'cli', 'agents') };
	const out = execFileSync(process.execPath, [cli, 'import-ds-bot', '--ds-home', dsHome, '--agents-root', other.agentsRoot, '--data-root', join(root, 'cli')],
		{ encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
	assert.match(out, /将导入 2 个 Bot、2 项技能/);
	assert.match(out, /群「Launch crew」需要在 Bots 里手动建/);
	assert.match(out, /密钥没有导入（GH）/);
	assert.match(out, /这是预览/);
	assert.equal(existsSync(other.agentsRoot), false);
});

rmSync(root, { recursive: true, force: true });
console.log(`ds-bot-import: ${pass} passed, ${fails.length} failed`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
if (fails.length) { process.exitCode = 1; }
