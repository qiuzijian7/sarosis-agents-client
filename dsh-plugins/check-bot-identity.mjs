#!/usr/bin/env node
// 守卫：会话的 Bot 身份（2026-11-03，"每个 bot 一个 preset"重构第 2 步）。
//
// 钉住四件事：
//   ① 模式 preset 清单只有一份口径：Host 真源（vssaros-agents/lib/core/botIdentity.js）= vssaros-memory 副本
//      = chat-surface 6 个 chunk 里的逐字副本（以前 9 份副本互不一致 ⇒ vssaros-full 被当成 bot、
//      vssaros-ptc / vssaros-full 被当成记忆人设分区）；
//   ② 客户端副本块逐字一致，且行为与 Host 的 resolveSessionBot 一致（表驱动对拍）；
//   ③ 身份记录：只认 ignorable 的 plugin record；presetId 与当前 preset 一致才采信；写入口幂等、永不抛；
//   ④ 接线：agent/created 里推迟写记录；两处注册投影；appendPluginRecord 以 Host 入口为锚解析。
//
// 用法：node dsh-plugins/check-bot-identity.mjs   （失败项打印 FAIL 并以非 0 退出）

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8').replace(/\r\n/g, '\n');
const load = (rel) => import(pathToFileURL(join(here, rel)).href);

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
	if (ok) { pass += 1; console.log('  ok   ' + name); return; }
	fail += 1;
	console.log('  FAIL ' + name + (detail !== undefined ? '  — ' + String(detail).slice(0, 300) : ''));
}

const core = await load('vssaros-agents/lib/core/botIdentity.js');
const writer = await load('vssaros-agents/lib/botIdentityWriter.js');

console.log('── ① 模式 preset 清单单一口径 ──');
const truth = JSON.stringify([...core.MODE_PRESET_IDS]);
check('真源含 vssaros-full / vssaros-ptc / vssaros-standard', ['vssaros-full', 'vssaros-ptc', 'vssaros-standard'].every(id => core.MODE_PRESET_IDS.includes(id)));
// 2026-11-03：vssaros-memory 整套下线并归档 ⇒ 上面三条「副本 == 真源」的对账断言随插件一起移除。

// ★ 2026-11-03：client.botSettingsBtn.js（右上角 ⚙）与 client.agents.js（Bots 工作台）已随功能下线删除
const CHUNKS = ['client.capsule.js', 'client.welcome.js', 'client.conversationViews.js', 'client.botEntry.js'];
const START = '/* vssaros:bot-identity v1';
const END = '/* /vssaros:bot-identity */';
const blockOf = (text) => {
	const a = text.indexOf(START);
	const b = text.indexOf(END);
	if (a < 0 || b < a) { return ''; }
	return text.slice(a, b + END.length).split('\n').map(l => l.replace(/^[ \t]+/, '')).join('\n');
};
const blocks = new Map();
for (const file of CHUNKS) {
	const text = read('vssaros-chat-surface/lib/' + file);
	const block = blockOf(text);
	blocks.set(file, block);
	check(`${file}：含身份副本块`, !!block);
	const m = block.match(/const BOT_MODE_PRESET_IDS = (\[[^\]]*\]);/);
	check(`${file}：副本里的模式清单 == 真源`, !!m && JSON.stringify(JSON.parse(m[1])) === truth, m && m[1]);
	// 旧判据不许复活（注释里出现不算：只查代码形态）
	check(`${file}：不再有旧的 4 项 MODE_PRESETS / 去前缀判模式`,
		!/const MODE_PRESETS = \[/.test(text) && !/MODE_PRESETS\.indexOf\(id\.slice\(VSSAROS_PREFIX\.length\)\)/.test(text));
}
const first = blocks.get(CHUNKS[0]);
check('6 个 chunk 的副本块逐字一致（忽略缩进）', CHUNKS.every(f => blocks.get(f) === first), CHUNKS.filter(f => blocks.get(f) !== first).join(','));

console.log('── ② 客户端副本与 Host 判据对拍 ──');
const clientApi = new Function(first + '\nreturn { isBotPresetId, sessionBotOf, BOT_MODE_PRESET_IDS };')();
const CASES = [
	[{ agentPreset: 'vssaros-coder' }, 'preset 推断'],
	[{ agentPreset: 'vssaros-coder', identity: { botId: 'Coder.Bot', presetId: 'vssaros-coder' } }, '记录一致 ⇒ 记录'],
	[{ agentPreset: 'vssaros-coder', identity: { botId: 'old', presetId: 'vssaros-writer' } }, '空会话换过 preset ⇒ 旧记录不采信'],
	[{ agentPreset: 'vssaros-full' }, 'vssaros-full 是模式'],
	[{ agentPreset: 'vssaros-ptc', identity: { botId: 'x', presetId: 'vssaros-ptc' } }, '模式 preset 有记录也不是 bot'],
	[{ agentPreset: 'standard' }, '官方模式'],
	[{ agentPreset: 'vssaros-' }, '只有前缀'],
	[{ agentPreset: '' }, '空'],
	[{ agentPreset: 'other-preset' }, '非 vssaros'],
	[{ agentPreset: ' vssaros-coder ', identity: { botId: ' ', presetId: 'vssaros-coder' } }, '空白 botId ⇒ 不采信'],
];
for (const [input, label] of CASES) {
	const host = core.resolveSessionBot(input);
	const pv = { agentPreset: input.agentPreset, ...(input.identity ? { 'vssaros-bot': input.identity } : {}) };
	const cli = clientApi.sessionBotOf(pv);
	const same = host.isBot === cli.isBot && host.source === cli.source && (host.botId ?? null) === (cli.botId ?? null);
	check(`对拍：${label}`, same, JSON.stringify({ host, cli }));
}
check('Host：花名册反查兜底', core.resolveSessionBot({ agentPreset: 'vssaros-camelcase-bot' }, p => (p === 'vssaros-camelcase-bot' ? 'CamelCase.Bot' : undefined)).botId === 'CamelCase.Bot');
check('Host：反查抛错 ⇒ botId=null 不抛', core.resolveSessionBot({ agentPreset: 'vssaros-a' }, () => { throw new Error('x'); }).botId === null);

console.log('── ③ 身份记录读写 ──');
const rec = (data, extra = {}) => ({ type: core.BOT_IDENTITY_RECORD_TYPE, seq: 5, time: 1, ignorable: true, data, ...extra });
check('只认 ignorable 记录', core.botIdentityOfEvent(rec({ botId: 'a', presetId: 'vssaros-a' }, { ignorable: undefined })) === undefined
	&& core.botIdentityOfEvent(rec({ botId: 'a', presetId: 'vssaros-a' }))?.botId === 'a');
check('类型符合 plugin record 语法', /^plugin:[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/.test(core.BOT_IDENTITY_RECORD_TYPE));
const proj = core.botIdentityProjection();
const s0 = proj.init();
const other = { type: 'user/message', seq: 1 };
check('投影：无关事件返回同一引用', proj.apply(s0, other) === s0 && s0 === null);
const s1 = proj.apply(s0, rec({ botId: 'a', presetId: 'vssaros-a' }));
check('投影：记录 ⇒ 状态', s1?.botId === 'a' && s1?.presetId === 'vssaros-a' && s1?.atSeq === 5);
check('投影：wire 视图不带多余字段', JSON.stringify(proj.wire.view(s1)) === '{"botId":"a","presetId":"vssaros-a"}' && proj.wire.view(null) === null);
check('lastBotIdentityOf 取最后一条', core.lastBotIdentityOf([rec({ botId: 'a', presetId: 'p' }), other, rec({ botId: 'b', presetId: 'p' })])?.botId === 'b');

const fakeSession = (preset, events) => ({ meta: { agentPreset: preset }, snapshotEvents: () => events });
// 2026-11-03：memory.personaIdOf 的 4 条断言随 vssaros-memory 整套下线移除（被测模块已归档）。


{
	const calls = [];
	const append = (session, type, data) => { calls.push({ type, data }); return 7; };
	const agent = { session: {} };
	const r1 = await writer.writeBotIdentity({ append }, agent, { botId: 'a', presetId: 'vssaros-a' });
	check('写入：类型 + 数据形状', r1.ok && r1.seq === 7 && calls[0].type === core.BOT_IDENTITY_RECORD_TYPE && JSON.stringify(calls[0].data) === '{"v":1,"botId":"a","presetId":"vssaros-a"}', JSON.stringify({ r1, calls }));
	const projections = { stateOf: () => ({ botId: 'a', presetId: 'vssaros-a' }) };
	const r2 = await writer.writeBotIdentity({ append, projections }, agent, { botId: 'a', presetId: 'vssaros-a' });
	check('写入：已有同口径记录 ⇒ 不重复写', !r2.ok && r2.reason === 'already' && calls.length === 1);
	const r3 = await writer.writeBotIdentity({ append: () => { throw new TypeError('Cannot read private member'); } }, agent, { botId: 'a', presetId: 'vssaros-a' });
	check('写入：append 抛（模块实例不一致）⇒ ok:false、不抛', !r3.ok && /private member/.test(r3.reason));
	const r4 = await writer.writeBotIdentity({ append }, { session: {} }, { botId: '', presetId: 'vssaros-a' });
	check('写入：缺 botId ⇒ 不写', !r4.ok && calls.length === 1);
}

console.log('── ④ 接线 ──');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const idx = strip(read('vssaros-agents/lib/index.js'));
const bindingAt = idx.indexOf('function installSessionBinding(');
const bindingEnd = idx.indexOf('\nfunction ', bindingAt + 10);
const binding = bindingAt >= 0 ? idx.slice(bindingAt, bindingEnd > 0 ? bindingEnd : undefined) : '';
check('applyPersona 调 installSessionBinding', /installSessionBinding\(ctx, config\)/.test(idx));
check('installSessionBinding 订阅 agent/created', /ctx\.on\('agent\/created'/.test(binding));
check('身份记录推迟到 setImmediate 再写（agent/created 可能在别的 append 发布中派发，dsh 禁止重入）', /setImmediate\(\(\) => \{\s*void writeBotIdentity\(/.test(binding));
check('身份投影注册 ≥2 处（preset 作用域 + 顶层）', (idx.match(/register\(botIdentityProjection\(\)\)/g) || []).length >= 2);
const wsrc = strip(read('vssaros-agents/lib/botIdentityWriter.js'));
check('appendPluginRecord 以 Host 入口 process.argv[1] 为锚解析', /createRequire\(anchor\)\.resolve\('@deepseek-ai\/dsh-session'\)/.test(wsrc) && /process\.argv\[1\]/.test(wsrc));
const pkg = JSON.parse(read('vssaros-agents/package.json'));
check('agents 包清单含 botIdentity.js / botIdentityWriter.js', pkg.files.includes('lib/core/botIdentity.js') && pkg.files.includes('lib/botIdentityWriter.js'));
// ★ 2026-11-03：Bots 工作台（sideview.js / detail.js）已随功能整体下线 —— 反向断言：这两个文件不再存在，
//   否则说明工作台被复活了。
for (const f of ['vssaros-agents/lib/sideview.js', 'vssaros-agents/lib/detail.js']) {
	check(`${f} 已随 Bots 工作台删除`, !existsSync(join(here, f)));
}
{
	const src = strip(read('vssaros-chat-surface/lib/client.conversationViews.js'));
	check('conversationViews：agentId 先取身份记录的 botId', /bot\.botId \|\| bot\.presetId\.slice\(VSSAROS_PREFIX\.length\)/.test(src));
	check('右上角 Bot ⚙ chunk 已删（bot 配置统一进「设置」页签）', !existsSync(join(here, 'vssaros-chat-surface/lib/client.botSettingsBtn.js')));
}
for (const f of ['client.capsule.js', 'client.welcome.js']) {
	const src = strip(read('vssaros-chat-surface/lib/' + f));
	// ★ 2026-11-03：welcome.js 改成 effectiveAgentOf（人格 > 身份记录 > preset），名册按 who.agentId 匹配；
	//   capsule.js 仍是 sessionBotOf + bot.botId。两者都要验「按 id 优先匹配」+「走统一判据」。
	check(`${f}：名册按 botId / 人格 id 优先匹配`, /a\.id === (bot\.|who\.)?(botId|agentId)/.test(src)
		&& /(sessionBotOf|effectiveAgentOf)\(summary && summary\.projectionValues\)/.test(src));
}

console.log('── ⑤ Host 侧会话归属收口（第 3 步合并 preset 的前提）──');
{
	const live = await load('vssaros-agents/lib/core/live.js');
	const cacheRec = (preset, bot) => ({ record: { rows: { agentPreset: { val: preset }, ...(bot ? { 'vssaros-bot': { val: bot } } : {}) } } });
	const r1 = live.sessionRowOf(cacheRec('vssaros-shared', { botId: 'writer', presetId: 'vssaros-shared' }), 's1', 1).row;
	const r2 = live.sessionRowOf(cacheRec('vssaros-shared', { botId: 'coder', presetId: 'vssaros-shared' }), 's2', 2).row;
	const r3 = live.sessionRowOf(cacheRec('vssaros-coder'), 's3', 3).row;
	const r4 = live.sessionRowOf(cacheRec('vssaros-b', { botId: 'a', presetId: 'vssaros-a' }), 's4', 4).row;
	const r5 = live.sessionRowOf(cacheRec('vssaros-full', { botId: 'x', presetId: 'vssaros-full' }), 's5', 5).row;
	check('sessionRowOf：记录一致 ⇒ botId', r1.botId === 'writer' && r2.botId === 'coder');
	check('sessionRowOf：无记录 / 记录与 preset 不一致 / 模式 preset ⇒ botId=null', r3.botId === null && r4.botId === null && r5.botId === null);
	check('共用一个 preset 的两个 bot 会话分得开（第 3 步的前提）', live.rowBelongsTo(r1, 'writer') && !live.rowBelongsTo(r1, 'coder') && live.rowBelongsTo(r2, 'coder'));
	check('没有记录 ⇒ 仍按 preset 归属（旧会话不受影响）', live.rowBelongsTo(r3, 'coder') && live.rowBelongsTo(r4, 'b') && !live.rowBelongsTo(r4, 'a'));
	const agents = [{ id: 'writer', name: 'W' }, { id: 'coder', name: 'C' }];
	const agg = live.aggregateByPreset([r1, r2, r3]);
	check('aggregateByPreset 按归属聚合（coder：r2 + r3）', agg.get('vssaros-coder')?.sessions === 2 && agg.get('vssaros-writer')?.sessions === 1 && !agg.has('vssaros-shared'), JSON.stringify([...agg.keys()]));
	const usage = live.usageByAgent(agents, [r1, r2, r3]);
	check('usageByAgent 按归属', usage.agents.find(a => a.agentId === 'coder').sessions === 2 && usage.unknown.sessions === 0, JSON.stringify(usage.unknown));
	check('rowAgentOf', live.rowAgentOf(r1, agents)?.name === 'W' && live.rowAgentOf(r3, agents)?.name === 'C');
	const seen = await load('vssaros-agents/lib/seen.js');
	const unread = seen.unreadCounts([{ ...r1, lastActiveAt: 10 }, { ...r2, lastActiveAt: 10 }], agents, {});
	check('unreadCounts 按归属', unread.writer === 1 && unread.coder === 1, JSON.stringify(unread));
	const home = await load('vssaros-agents/lib/home.js');
	const hd = home.buildHomeData({ agents, sessionRows: [r1, r2, r3], assignments: { items: [] } });
	check('buildHomeData 按归属', hd.writer?.sessions?.length === 1 && hd.coder?.sessions?.length === 2, JSON.stringify({ w: hd.writer?.sessions?.length, c: hd.coder?.sessions?.length }));

	const sl = await load('vssaros-sessions/lib/core/sessionList.js');
	check('vssaros-sessions：BOT_KEY 与真源投影 key 一致', sl.BOT_KEY === core.BOT_PROJECTION_KEY);
	check('vssaros-sessions：botIdOfRows 与 resolveSessionBot 同口径', sl.botIdOfRows({ botId: 'w', presetId: 'vssaros-s' }, 'vssaros-s') === 'w'
		&& sl.botIdOfRows({ botId: 'w', presetId: 'vssaros-a' }, 'vssaros-s') === undefined && sl.botIdOfRows(null, 'vssaros-s') === undefined);
	check('vssaros-sessions：按 Bot 分组有记录用 botId、没有用 preset', sl.groupKeyOf({ botId: 'w', preset: 'vssaros-s' }, 'bot') === 'vssaros-w' && sl.groupKeyOf({ preset: 'vssaros-s' }, 'bot') === 'vssaros-s');

	// 调用面扫描：Host 侧不许再用 `row.presetId ===/!==` 或 `presetIdOf(a.id) === <会话 preset>` 判会话归属
	// ★ 2026-11-03：groups.js 已随群聊下线删除 ⇒ 扫描面收敛到仍在用会话归属的这几个
	const SCAN = ['seen.js', 'home.js', 'tools.js', 'relay.js', 'memory.js', 'agentSession.js'];
	for (const f of SCAN) {
		const src = strip(read('vssaros-agents/lib/' + f));
		// 任何「…presetId…」紧跟 ===/!== 的比较（含 String(row.presetId ?? '') !== … 这类包装），以及按会话 preset 反查花名册
		const bad = src.split('\n').filter(l => /\.presetId\b[^=!;]{0,12}\)?\s*(===|!==)/.test(l) || /presetIdOf\(a\.id\)\s*===\s*(preset|selfPreset)\b/.test(l));
		check(`${f}：不再按 presetId 直接判会话归属`, bad.length === 0, bad.join(' | '));
	}
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) {
	process.exitCode = 1;
}
