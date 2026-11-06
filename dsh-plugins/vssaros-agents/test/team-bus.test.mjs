// @vssaros/dsh-agents — 团队总线 + 团队服务（2026-11-04，superagent 主管组团 T0）
//   跑法：node dsh-plugins/vssaros-agents/test/team-bus.test.mjs
//
// 覆盖：
//   · 总线：没实现时调用明确报错；provide / 撤销只撤自己那份；订阅者抛错不挡别人；同一 root 拿到同一条总线
//   · 服务（真实临时目录里的 .agent.md）：名册含内置 + 自定义、黑名单 bot 不出现；委派开会话并投递任务、
//     **不**登记 relay 回传；回合结束（agent/turn-stopping）后总线收到 done + 报告；中断收到 cancelled。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installAssignmentTracker, resetAssignments } from '../lib/assignments.js';
import { ensureOutboxLoaded, outboxPendingFor, resetOutbox } from '../lib/outbox.js';
import { scanAgentsFromConfig } from '../lib/store.js';
import { createTeamService } from '../lib/team.js';
import { externalBotRow, teamBus } from '../lib/teamBus.js';
import { createTeamBot, supervisorBotCount } from '../lib/teamCreate.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-team-'));
const builtinRoot = join(root, 'builtin');
const writeAgent = (base, id, front) => {
	mkdirSync(join(base, id), { recursive: true });
	writeFileSync(join(base, id, '.agent.md'), `---\n${front}\n---\n你是 ${id}。\n`, 'utf8');
};
writeAgent(join(root, 'agents'), 'designer', 'name: 设计 bot\ndescription: 交互与视觉方案\nskills: figma, ux\nsubagent: true');
writeAgent(join(root, 'agents'), 'saros-claw', 'name: 隐藏的\ndescription: 不该出现');
writeAgent(builtinRoot, 'tester', 'name: 测试 bot\ndescription: 回归测试\nuserFacing: true');
writeAgent(builtinRoot, 'internal', 'name: 内部子代理\ndescription: 不面向用户');
const config = { dataRoot: root, agentsBuiltinRoot: builtinRoot };
resetOutbox();
await ensureOutboxLoaded(config);
resetAssignments();

/** 假 dsh：sessionController.create 造会话，agents.get 取活会话，ctx.on 收 turn-stopping 监听。 */
function fakeHost() {
	const sessions = new Map();
	const listeners = [];
	let n = 0;
	const state = {
		sessionController: { create: async ({ agentPreset }) => { const id = `s${++n}`; sessions.set(id, { id, preset: agentPreset, got: [], cancelled: null }); return { sessionId: id, agentPreset }; } },
		agents: { get: (id) => { const s = sessions.get(id); return s && { steer: (m) => s.got.push(m), cancel: (r) => { s.cancelled = r; } }; } },
	};
	const ctx = { on: (name, fn) => { listeners.push([name, fn]); return () => undefined; } };
	/** 模拟某会话回合结束：消费了 messageId，最终答复 text。 */
	const endTurn = (sessionId, messageId, text) => {
		const events = [
			{ type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId }] } },
			{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] }, interrupted: false } },
		];
		const session = { id: sessionId, seq: events.length, snapshotEvents: (from, to) => events.slice(from, to) };
		for (const [name, fn] of listeners) { if (name === 'agent/turn-stopping') { fn({ agent: { session } }); } }
	};
	return { state, ctx, sessions, endTurn };
}

await checkAsync('总线：没实现时调用明确报错；provide 后可用；撤销只撤自己那份', async () => {
	const bus = teamBus({});
	assert.equal(bus.available(), false);
	await assert.rejects(() => bus.listBots(), /还没就绪/);
	const a = { delegate: async () => 'a', listBots: async () => ['a'] };
	const b = { delegate: async () => 'b', listBots: async () => ['b'] };
	const withdrawA = bus.provide(a);
	const withdrawB = bus.provide(b);
	withdrawA();
	assert.deepEqual(await bus.listBots(), ['b'], '旧实现撤销时把新实现也撤了');
	withdrawB();
	assert.equal(bus.available(), false);
});
await checkAsync('总线：同一 root 同一条；订阅者抛错不挡别人；退订后收不到', async () => {
	const holder = {};
	const bus = teamBus(holder);
	assert.equal(teamBus(holder), bus);
	const got = [];
	const off = bus.subscribe((v) => got.push(v.id));
	bus.subscribe(() => { throw new Error('boom'); });
	assert.equal(bus.publish({ id: 'x' }), 1);
	off();
	bus.publish({ id: 'y' });
	assert.deepEqual(got, ['x']);
});

const host = fakeHost();
installAssignmentTracker(host.ctx, config, host.state);
const service = createTeamService(config, host.state);
const events = [];
const offBus = teamBus().subscribe((v) => events.push(v));

await checkAsync('名册：内置 + 自定义（与 Bots 管理面同一口径：只藏黑名单里的）；卡片不带 persona', async () => {
	const cards = await service.listBots();
	const ids = cards.map(c => c.id).sort();
	assert.deepEqual(ids, ['designer', 'internal', 'tester']);
	const designer = cards.find(c => c.id === 'designer');
	assert.deepEqual([designer.name, designer.delegatable, designer.source, designer.skills], ['设计 bot', true, 'custom', ['figma', 'ux']]);
	assert.equal(cards.find(c => c.id === 'tester').source, 'builtin');
	assert.equal(JSON.stringify(cards).includes('你是'), false, '卡片里不该有 persona 正文');
});

let delegated;
await checkAsync('委派：内置 bot 也能派（扫两个根）；开对应 preset 的会话并投递任务；不登记 relay', async () => {
	delegated = await service.delegate({ bot: '测试 bot', task: 'T5 回归测试：覆盖 5 步', fromName: 'SuperAgent 主管' });
	assert.equal(delegated.status, 'running');
	const s = host.sessions.get(delegated.sessionId);
	assert.equal(s.preset, 'vssaros-tester');
	assert.match(s.got[0].content[0].text, /来自 SuperAgent 主管[\s\S]*T5 回归测试/);
	assert.equal(outboxPendingFor(delegated.sessionId).length, 0, '主管走总线收结果，不该再登记 relay');
	assert.equal(JSON.stringify(delegated).includes('messageIds'), false, '视图不该带内部字段');
});
await checkAsync('回合结束：总线收到 done + 报告；get 读得到同一份', async () => {
	const s = host.sessions.get(delegated.sessionId);
	host.endTurn(delegated.sessionId, s.got[0].id, 'T5 通过：14 条用例。');
	const done = events.find(e => e.id === delegated.id);
	assert.deepEqual([done.status, done.report, done.botId], ['done', 'T5 通过：14 条用例。', 'tester']);
	assert.equal((await service.get(delegated.id)).status, 'done');
	assert.equal(await service.get('nope'), undefined);
});
await checkAsync('中断：总线收到 cancelled，会话被要求停下', async () => {
	const second = await service.delegate({ bot: 'designer', task: '交互方案' });
	const view = await service.cancel(second.id, '计划已停止');
	assert.equal(view.status, 'cancelled');
	assert.match(host.sessions.get(second.sessionId).cancelled.reason, /计划已停止/);
	assert.equal(events.filter(e => e.id === second.id && e.status === 'cancelled').length, 1);
});
await checkAsync('委派：不认识的 bot 明确报错（404），不猜', async () => {
	await assert.rejects(() => service.delegate({ bot: '不存在的', task: 'x' }), (e) => e.httpStatus === 404);
});

await checkAsync('外部 bot：登记/撤销、公开视图不含回调、按名字可找、旧撤销不误撤新登记', async () => {
	const bus = teamBus({});
	const got = [];
	const off = bus.registerExternalBot({ id: 'superagent', name: 'SuperAgent', role: '主管', session: 'desk-1', onMessage: (m) => { got.push(m); } });
	assert.deepEqual(bus.externalBots().map((b) => b.id), ['superagent']);
	assert.equal(JSON.stringify(bus.externalBots()).includes('onMessage'), false, '回调不能进公开视图');
	assert.equal(externalBotRow(bus.externalBots()[0]).sessionId, 'desk-1', '名册行要能打开主管对话');
	const found = bus.externalBotOf('SuperAgent');
	assert.equal(found?.id, 'superagent');
	await found.onMessage({ from: 's1', text: '帮我看下需求', hop: 1 });
	assert.equal(got[0].text, '帮我看下需求');
	const off2 = bus.registerExternalBot({ id: 'superagent', name: 'SuperAgent', onMessage: () => undefined });
	off();
	assert.equal(bus.externalBots().length, 1, '旧撤销函数不该撤掉后一次的登记');
	off2();
	assert.equal(bus.externalBots().length, 0);
	assert.equal(bus.registerExternalBot({ id: '', name: 'x', onMessage: () => undefined })(), undefined);
});

await checkAsync('建 bot：写 .agent.md、标 created-by、可委派、同步 preset、计数', async () => {
	let synced = 0;
	const sync = async () => { synced += 1; };
	const created = await createTeamBot(config, { draft: {
		id: 'release-bot', name: '发布 bot', description: '版本说明与通知', skills: ['writing'], tools: ['read'],
		persona: '你负责汇总版本变更并写版本说明。不改代码。',
	} }, sync);
	assert.equal(created.id, 'release-bot');
	assert.equal(synced, 1);
	const text = await readFile(created.file, 'utf8');
	assert.match(text, /created-by: supervisor/);
	assert.match(text, /subagent: true/);
	assert.match(text, /你负责汇总版本变更/);
	assert.equal(await supervisorBotCount(config), 1);
	const { agents } = await scanAgentsFromConfig(config);
	assert.equal(agents.find((a) => a.id === 'release-bot')?.createdBy, 'supervisor');
});
await checkAsync('建 bot：同名 id 不覆盖，带 409', async () => {
	await assert.rejects(() => createTeamBot(config, { draft: {
		id: 'release-bot', name: '另一个名字', persona: 'x',
	} }), (e) => e.httpStatus === 409);
	assert.equal(await supervisorBotCount(config), 1);
});
await checkAsync('建 bot：缺字段明确报错，不写盘', async () => {
	await assert.rejects(() => createTeamBot(config, { draft: { id: 'no-name', persona: 'x' } }), (e) => e.httpStatus === 400);
	assert.equal(await supervisorBotCount(config), 1);
});

// ★ 2026-11-06 契约修订 2：version 仍是 1（老消费者只认 1），revision/features 标新能力；老总线原地补齐、订阅不丢。
await checkAsync('契约修订 2：version 不变、revision 2；presetOf 与注册口径同一；describeBot 未就绪报错、就绪按 id/名字找；老总线原地升级', async () => {
	const fresh = {};
	const bus = teamBus(fresh);
	assert.equal(bus.version, 1);
	assert.equal(bus.revision, 2);
	assert.deepEqual([...bus.features], ['delegate', 'externalBots', 'groups', 'presetOf', 'describeBot']);
	assert.equal(bus.presetOf('Code.Reviewer'), 'vssaros-code-reviewer');
	await assert.rejects(bus.describeBot('x'), /还没就绪/);
	const off = bus.provideDescribe(async (ref) => (ref === 'tester' || ref === '测试' ? { id: 'tester', name: '测试', preset: bus.presetOf('tester') } : undefined));
	assert.deepEqual(await bus.describeBot('测试'), { id: 'tester', name: '测试', preset: 'vssaros-tester' });
	assert.equal(await bus.describeBot('nobody'), undefined);
	off();
	await assert.rejects(bus.describeBot('tester'), /还没就绪/);
	// 一条 HMR 前由老模块建的 v1 总线：同一个对象被补齐，订阅表还在
	const heard = [];
	const legacy = { version: 1, delegate: () => undefined, subscribe(fn) { heard.push(fn); return () => undefined; } };
	const legacyRoot = { [Symbol.for('vssaros.team')]: legacy };
	const upgraded = teamBus(legacyRoot);
	assert.equal(upgraded, legacy);
	assert.equal(upgraded.version, 1);
	assert.equal(upgraded.revision, 2);
	assert.equal(typeof upgraded.createGroup, 'function');
	assert.equal(teamBus(legacyRoot), legacy, '再取一次还是同一个');
});

offBus();
try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(`team-bus: ${pass} passed, ${fails.length} failed`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
process.exitCode = fails.length ? 1 : 0;
