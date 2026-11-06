// @vssaros/dsh-agents — 记忆总线 + 团队步骤的记忆沉淀（2026-11-04，superagent v2 P4）
//   跑法：node dsh-plugins/vssaros-agents/test/step-memory.test.mjs
//
// 覆盖：
//   · 总线：没实现时明确报错；provide 后可用；撤销只撤自己那份；同一 root 同一条总线
//   · facts：只往该 bot 的记忆加一条事实（2026-11-06 起写统一记忆 @vssaros/dsh-memory 的 bot 轨，这里用假的写入口），
//     ≤400 字符，重复证据不重复写，不产生技能草稿；统一记忆没就绪时暂存进旧目录的收件箱
//   · skill：事实 + `<dataRoot>/skills/.drafts/<name>/SKILL.md`（frontmatter name/description、owner bot:<id>、踩坑段）；
//     同一 bot 同一类步骤第二次不覆盖；批准转正到 `<root>/<name>/SKILL.md`、驳回删除草稿；不合法的名字被拒
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memoryBus } from '../lib/memoryBus.js';
import { decideSkillDraft, factOf, ownedSkillsOf, ownedSkillsText, ownerOf, rememberStep, skillNameOf, skillsRootOf } from '../lib/stepMemory.js';
import { gradeRisk, parseDistilled, ruleRisk } from '../lib/core/skillDistill.js';
import { distillRouteOf, makeStepDistiller } from '../lib/stepDistill.js';

let pass = 0;
const fails = [];
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n').slice(0, 12).join(' | ')}`); } };

const root = mkdtempSync(join(tmpdir(), 'vssaros-step-memory-'));
const agentsRoot = join(root, 'agents');
mkdirSync(join(agentsRoot, 'tester'), { recursive: true });
writeFileSync(join(agentsRoot, 'tester', '.agent.md'), '---\nname: 测试 bot\n---\n你是测试。\n', 'utf8');
const config = { dataRoot: join(root, 'data'), agentsRoot };
const evidence = (over = {}) => ({ requestId: 'r1', botId: 'tester', botName: '测试 bot', ticketId: 'tk1', ticketTitle: '首页新手引导上线',
	stepKey: 'T2', stepTitle: '回归测试', spec: '跑首页回归', outcome: 'ready', mode: 'facts', turns: 2, attempts: 1, failures: [],
	report: '首页回归 12 条全部通过', request: '@bot 首页新手引导要上线', ...over });
// 假的统一记忆写入口（形状同 @vssaros/dsh-memory 的 version 1：addBotEntry → { ok, duplicate?, message }）
const STORE_KEY = Symbol.for('vssaros.memory.store');
const written = [];
globalThis[STORE_KEY] = {
	version: 1,
	addBotEntry(botId, text) {
		if (written.some((w) => w.botId === botId && w.text === text)) { return { ok: true, duplicate: true, message: '已存在' }; }
		written.push({ botId, text });
		return { ok: true, message: '已添加' };
	},
};
const memoryOf = () => written.filter((w) => w.botId === 'tester').map((w) => w.text).join('\n');

await checkAsync('总线：没实现时报错，provide 后可用，撤销只撤自己', async () => {
	const fake = {};
	const bus = memoryBus(fake);
	assert.equal(memoryBus(fake), bus);
	assert.equal(bus.available(), false);
	await assert.rejects(bus.rememberStep({}), /还没就绪/);
	assert.equal(bus.provide({})(), undefined, '没有 rememberStep 的实现不接受');
	const off = bus.provide({ rememberStep: async () => ({ ok: 1 }), decideSkillDraft: async () => ({ state: 'active' }) });
	assert.deepEqual(await bus.rememberStep({}), { ok: 1 });
	const off2 = bus.provide({ rememberStep: async () => ({ ok: 2 }), decideSkillDraft: async () => ({}) });
	off();
	assert.deepEqual(await bus.rememberStep({}), { ok: 2 }, '旧撤销不该撤掉新实现');
	off2();
	assert.equal(bus.available(), false);
});

await checkAsync('facts：只加一条事实（≤400 字符），重复不写，不产生草稿，也不调模型', async () => {
	let called = 0;
	const first = await rememberStep(config, evidence(), { distill: async () => { called += 1; throw new Error('不该调'); } });
	assert.equal(first.fact.ok, true);
	assert.equal(first.skill, undefined);
	assert.equal(called, 0);
	assert.match(memoryOf(), /\[团队工单\] 首页新手引导上线 · T2 回归测试 · ready：首页回归 12 条全部通过/);
	assert.equal((await rememberStep(config, evidence())).fact.duplicate, true);
	assert.ok(factOf(evidence({ report: 'x'.repeat(2000) })).length <= 400);
	assert.equal(existsSync(join(skillsRootOf(config), '.drafts')), false);
});

// ★ 2026-11-06：模型提炼 + 相似去重发版本 + 风险分级（superagent v2 第 7 节）
const distilled = (over = {}) => ({ title: '首页回归测试', description: '用 data-testid 定位元素跑首页回归，避免选择器超时',
	when: '改了首页交互、需要确认没有回归时', steps: ['给关键元素加 data-testid', '用 playwright 跑首页用例', '失败时先看选择器'],
	pitfalls: ['按文字定位在多语言下会超时'], verify: ['12 条用例全部通过'], risk: 'low', riskReasons: [], ...over });

await checkAsync('skill：模型提炼成草稿（做法/坑/验证/风险），相似的出新版本，批准后替换生效版并留旧版；驳回删除', async () => {
	const skillEvidence = evidence({ mode: 'skill', turns: 5, attempts: 2, failures: ['选择器超时'], report: '换成 data-testid 后通过', sessionId: 'step-tk1-T2' });
	const seen = [];
	const distill = async (ev, similar) => { seen.push({ ev, similar }); return distilled(); };
	const result = await rememberStep(config, skillEvidence, { distill });
	const name = skillNameOf(skillEvidence);
	assert.deepEqual([result.skill.name, result.skill.created, result.skill.version, result.skill.risk, result.skill.distilled], [name, true, 1, 'low', true]);
	assert.equal(seen[0].ev.sessionId, 'step-tk1-T2');
	assert.deepEqual(seen[0].similar, [], '第一次没有已有技能');
	const text = readFileSync(join(config.dataRoot, 'skills', '.drafts', name, 'SKILL.md'), 'utf8');
	assert.match(text, /^---\r?\nname: bot-tester-/);
	assert.match(text, /\ndescription: "用 data-testid 定位元素跑首页回归，避免选择器超时"\r?\n/);
	assert.match(text, /owner: "bot:tester"/);
	assert.match(text, /\n {2}version: 1\r?\n/);
	assert.match(text, /\n {2}risk: low\r?\n/);
	assert.match(text, /\n {2}distilled: model\r?\n/);
	assert.match(text, /## 做法\r?\n\r?\n1\. 给关键元素加 data-testid\r?\n2\. 用 playwright 跑首页用例/);
	assert.match(text, /## 踩过的坑\r?\n\r?\n1\. 按文字定位在多语言下会超时/);
	assert.match(text, /## 怎么验证\r?\n\r?\n- 12 条用例全部通过/);
	assert.doesNotMatch(text, /换成 data-testid 后通过/, '不复述报告原文');
	assert.match(memoryOf(), /第 2 次完成/);
	// 还没批准：同类证据更新这份草稿，版本不变，不新建
	const again = await rememberStep(config, { ...skillEvidence, report: '另一种说法' }, { distill });
	assert.deepEqual([again.skill.name, again.skill.created, again.skill.version, again.skill.updates], [name, false, 1, 'draft']);
	assert.deepEqual(seen[1].similar, [{ name, description: '用 data-testid 定位元素跑首页回归，避免选择器超时', version: 1 }], '已有技能交给模型比对');
	assert.deepEqual(decideSkillDraft(config, name, 'approve'), { name, state: 'active', version: 1 });
	assert.equal(existsSync(join(config.dataRoot, 'skills', name, 'SKILL.md')), true);
	assert.equal(existsSync(join(config.dataRoot, 'skills', '.drafts', name)), false);
	// 另一个步骤标题，但模型说是同一项（sameAs）⇒ 出 v2 草稿；批准后替换生效版，v1 留作 SKILL.v1.md
	const v2 = await rememberStep(config, evidence({ mode: 'skill', stepTitle: '回归复测', stepKey: 'T5' }),
		{ distill: async () => distilled({ description: '首页回归复测：先补 data-testid 再跑用例', sameAs: name }) });
	assert.deepEqual([v2.skill.name, v2.skill.created, v2.skill.version, v2.skill.updates], [name, false, 2, 'active']);
	assert.match(readFileSync(v2.skill.path, 'utf8'), /v2（替换 v1）/);
	assert.deepEqual(decideSkillDraft(config, name, 'approve'), { name, state: 'active', version: 2 });
	assert.match(readFileSync(join(config.dataRoot, 'skills', name, 'SKILL.v1.md'), 'utf8'), /\n {2}version: 1\r?\n/);
	assert.match(readFileSync(join(config.dataRoot, 'skills', name, 'SKILL.md'), 'utf8'), /\n {2}version: 2\r?\n/);
	// 文字相近（不点名）也算同一项：和生效的 v2 描述相近
	const v3 = await rememberStep(config, evidence({ mode: 'skill', stepTitle: '冒烟', stepKey: 'T6' }),
		{ distill: async () => distilled({ title: '首页回归测试', description: '首页回归复测：先补 data-testid 再跑全部用例' }) });
	assert.deepEqual([v3.skill.name, v3.skill.version], [name, 3]);
	// 不相干的新建；驳回删除草稿
	const other = await rememberStep(config, evidence({ mode: 'skill', stepTitle: '写发版说明' }),
		{ distill: async () => distilled({ title: '发版说明', description: '按模板整理变更列表写发版说明' }) });
	assert.equal(other.skill.created, true);
	assert.notEqual(other.skill.name, name);
	assert.deepEqual(decideSkillDraft(config, other.skill.name, 'reject'), { name: other.skill.name, state: 'rejected' });
	assert.equal(existsSync(join(config.dataRoot, 'skills', '.drafts', other.skill.name)), false);
	assert.throws(() => decideSkillDraft(config, '../etc', 'approve'), /不合法/);
	await assert.rejects(rememberStep(config, evidence({ mode: 'other' })), /未知 mode/);
	await assert.rejects(rememberStep(config, evidence({ botId: '' })), /botId/);
});

await checkAsync('风险分级：模型自报与规则取较高；高风险写明理由', async () => {
	const risky = await rememberStep(config, evidence({ mode: 'skill', stepTitle: '发布到灰度', stepKey: 'T7' }),
		{ distill: async () => distilled({ title: '灰度发布', description: '把构建产物发布到灰度环境', steps: ['pnpm build', 'git push origin release', '在飞书群发通知'], risk: 'medium', riskReasons: ['要推送'] }) });
	assert.equal(risky.skill.risk, 'high');
	assert.deepEqual(risky.skill.riskReasons, ['要推送', '会发布或推送', '会外发消息']);
	assert.match(readFileSync(risky.skill.path, 'utf8'), /riskReasons: "要推送；会发布或推送；会外发消息"/);
	assert.equal(gradeRisk({ risk: 'high', riskReasons: ['模型说高'] }, '只读几个文件').level, 'high', '模型说高就高');
	assert.equal(ruleRisk('读取 README，整理要点').level, 'low');
	assert.equal(ruleRisk('npm test').level, 'medium');
	assert.equal(ruleRisk('把 token 写进配置').level, 'high');
});

await checkAsync('模型不可用 / 答得不对 ⇒ 退回模板草稿并如实标记（distilled: template + 原因）', async () => {
	const fallback = await rememberStep(config, evidence({ mode: 'skill', stepTitle: '整理埋点表', stepKey: 'T8', failures: ['字段对不上'] }),
		{ distill: async () => { throw new Error('提炼超过 90 秒'); } });
	assert.deepEqual([fallback.skill.distilled, fallback.skill.distillError], [false, '提炼超过 90 秒']);
	const text = readFileSync(fallback.skill.path, 'utf8');
	assert.match(text, /\n {2}distilled: template\r?\n/);
	assert.match(text, /模型没能提炼/);
	assert.match(text, /## 踩过的坑\r?\n\r?\n1\. 字段对不上/);
	const none = await rememberStep(config, evidence({ mode: 'skill', stepTitle: '无模型', stepKey: 'T9' }));
	assert.match(none.skill.distillError, /没有提炼模型/);
	assert.throws(() => parseDistilled('好的，我来总结一下'), /不是 JSON/);
	assert.throws(() => parseDistilled('{"description":"x"}'), /缺少 description 或 steps/);
	assert.throws(() => parseDistilled('{"description":"x","steps":["a"],"risk":"extreme"}'), /风险等级不认识/);
	assert.deepEqual(parseDistilled('```json\n{"description":"d","steps":["a"],"sameAs":"bot-x"}\n```'),
		{ title: '', description: 'd', when: '', steps: ['a'], pitfalls: [], verify: [], risk: 'low', riskReasons: [], sameAs: 'bot-x' });
});

await checkAsync('一次性模型调用：llm.stream 拼文本、按配置/会话/bot 选模型、超时中止、不开会话', async () => {
	const calls = [];
	const llm = { stream(options) { calls.push(options); return (async function* () { yield { type: 'reasoning-delta', text: '想' }; yield { type: 'text-delta', text: JSON.stringify(distilled()).slice(0, 20) }; yield { type: 'text-delta', text: JSON.stringify(distilled()).slice(20) }; })(); } };
	const agents = { get: (id) => (id === 'step-tk1-T2' ? { options: { provider: 'p-session', model: 'm-session' } } : undefined) };
	const route = distillRouteOf({ config: {}, agents: () => agents, botRoute: (botId) => (botId === 'tester' ? { provider: 'p-bot', model: 'm-bot' } : undefined) });
	assert.deepEqual(route({ botId: 'tester', sessionId: 'step-tk1-T2' }), { provider: 'p-session', model: 'm-session' });
	assert.deepEqual(route({ botId: 'tester' }), { provider: 'p-bot', model: 'm-bot' });
	assert.equal(route({ botId: 'nobody' }), undefined);
	assert.deepEqual(distillRouteOf({ config: { distillProvider: 'p-cfg', distillModel: 'm-cfg' }, agents: () => agents, botRoute: () => undefined })({ sessionId: 'step-tk1-T2' }), { provider: 'p-cfg', model: 'm-cfg' });
	const distill = makeStepDistiller({ llm: () => llm, route });
	const out = await distill(evidence({ sessionId: 'step-tk1-T2' }), [{ name: 'bot-x', description: 'd', version: 1 }]);
	assert.equal(out.description, distilled().description);
	assert.equal(out.model, 'p-session/m-session');
	assert.equal(calls[0].provider, 'p-session');
	assert.match(calls[0].system, /只输出一个 JSON 对象/);
	assert.match(calls[0].messages[0].content[0].text, /"existingSkills":\[\{"name":"bot-x"/);
	assert.equal(calls[0].sessionId, undefined, '不挂在任何会话上');
	await assert.rejects(makeStepDistiller({ llm: () => llm, route: () => undefined })(evidence()), /没有可用的提炼模型/);
	await assert.rejects(makeStepDistiller({ llm: () => undefined, route })(evidence()), /llm 服务还没就绪/);
	const slow = { stream: (options) => (async function* () { await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted'))); }); yield { type: 'text-delta', text: '' }; })() };
	await assert.rejects(makeStepDistiller({ llm: () => slow, route, timeoutMs: 30 })(evidence({ sessionId: 'step-tk1-T2' })), /提炼超过 0 秒/);
});

await checkAsync('bot 的技能清单：只列已生效、归属该 bot 的技能，顶层或 metadata 下的 owner 都认', async () => {
	const skills = join(config.dataRoot, 'skills');
	const write = (dir, front) => { mkdirSync(join(skills, dir), { recursive: true }); writeFileSync(join(skills, dir, 'SKILL.md'), `---\n${front}\n---\n正文\n`, 'utf8'); };
	write('zz-top', 'name: zz-top\ndescription: 顶层 owner\nowner: bot:tester');
	write('aa-other', 'name: aa-other\ndescription: 别人的\nmetadata:\n  owner: "bot:designer"');
	write('mm-none', 'name: mm-none\ndescription: 没有归属');
	mkdirSync(join(skills, '.drafts', 'dd-draft'), { recursive: true });
	writeFileSync(join(skills, '.drafts', 'dd-draft', 'SKILL.md'), '---\nname: dd-draft\ndescription: 草稿\nmetadata:\n  owner: "bot:tester"\n---\n', 'utf8');
	assert.equal(ownerOf('---\nname: x\nmetadata:\n  owner: "bot:a"\n---\n'), 'bot:a');
	assert.equal(ownerOf('---\nowner: bot:b\n---\n'), 'bot:b');
	assert.equal(ownerOf('没有 frontmatter\nowner: bot:c'), '');
	const mine = await ownedSkillsOf(config, 'tester');
	// 上一个用例转正的 bot-tester-* 也在，按名字排序；草稿、别人的、无归属的都不在。
	assert.deepEqual(mine.map((s) => s.name), [...mine.map((s) => s.name)].sort());
	assert.ok(mine.some((s) => s.name === 'zz-top' && s.description === '顶层 owner'));
	assert.ok(mine.some((s) => /^bot-tester-/.test(s.name)));
	assert.equal(mine.some((s) => ['aa-other', 'mm-none', 'dd-draft'].includes(s.name)), false);
	assert.deepEqual(await ownedSkillsOf(config, ''), []);
	assert.deepEqual(await ownedSkillsOf({ ...config, skillsRoot: join(root, 'nowhere') }, 'tester'), []);
	const text = ownedSkillsText([{ name: 'zz-top', description: '顶层 owner' }]);
	assert.match(text, /^\n\n## 你的技能\n/);
	assert.match(text, /- zz-top：顶层 owner$/);
	assert.equal(ownedSkillsText([]), '');
});

await checkAsync('统一记忆没就绪 ⇒ 事实暂存进旧目录的收件箱（统一记忆下次启动时并入）', async () => {
	delete globalThis[STORE_KEY];
	const r = await rememberStep(config, evidence({ stepKey: 'T9', stepTitle: '收件箱' }));
	assert.equal(r.fact.ok, true);
	const inbox = join(agentsRoot, 'tester', 'memory', 'MEMORY.md');
	assert.ok(existsSync(inbox), '自定义 bot 的收件箱在 <agents>/<id>/memory/MEMORY.md');
	assert.match(readFileSync(inbox, 'utf8'), /^- \[\d{4}-\d{2}-\d{2}\] \[团队工单\] 首页新手引导上线 · T9 收件箱/m);
});

rmSync(root, { recursive: true, force: true });
console.log(`step-memory: ${pass} passed, ${fails.length} failed`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
if (fails.length) { process.exitCode = 1; }
