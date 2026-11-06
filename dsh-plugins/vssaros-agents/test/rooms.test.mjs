// @vssaros/dsh-agents — 多 bot 群聊（2026-11-05，lib/rooms.js + lib/core/rooms.js）
//   跑法：node dsh-plugins/vssaros-agents/test/rooms.test.mjs
//
// 覆盖：
//   · 纯逻辑：@ 点名（最长名字优先、@所有人、代码/链接/邮箱不算）、谁来回答（admin / everyone / @）、
//     成员再叫人（只有管理员的 @所有人 有效、次数上限）、[PASS]、去自报姓名、建群校验、群提示。
//   · 运行时（假 dsh 会话真跑完整一轮）：建群 = 开会话 + 群标记 + 改名 + 挂 group_relay；
//     人发言 ⇒ 管理员先答、它 @ 的人接着答；everyone 模式依次发言；@ 两人并行；沉默与超时；
//     成员影子会话按 bot preset 建、写成员标记、复用；进度可轮询；
//     改名 / 改成员（移出者影子会话归档）/ 置顶 / 隐藏 / 删群（全部归档）/ 落盘后重读。
//   · 群会话的模型请求由我们合成：人刚说话 ⇒ group_relay 调用；工具结果之后 ⇒ stop；别的会话 / 标题请求放行。
//   · 团队总线：createGroup / listGroups 走 provideGroups 的实现。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	ROOM_IDLE_RELAY_LIMIT, ROOM_LIMITS, ROOM_RECORD_TYPE, ROOM_RELAY_TOOL, ROOM_TURN_KIND, ROOM_REFERENCE_KIND, ROUND_SCHEMA, ROUND_STATUSES, ROUND_STATUS_LABELS,
	RoomError, addressedRoomReference,
	autoRoomName, callsFrom, decodeDshSessionToken, isPass, mentionsIn, normalizeRoomInput, openingCall,
	roomOfEvent, roomProjection, roomPrompt, roomReferenceOf, roundStatusOf, sessionReferencesOf, sortRooms, stripOwnName, stripRoomMention,
} from '../lib/core/rooms.js';
import { GOAL_IDLE_NUDGES, applyGoal, goalPromptBlock, markTask } from '../lib/core/goals.js';
import { ROOMS_FILE_VERSION, ROUNDS_ARCHIVE_PER_ROOM, ROUNDS_KEEP_MAX, createRooms, holdsMessage, installRooms, relayAnswerText, relayStream, roomPostId, roomsApi, turnWorked, userTextOf } from '../lib/rooms.js';
import { teamBus } from '../lib/teamBus.js';

let pass = 0;
const fails = [];
const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); } };

const ROSTER = [{ id: 'designer', name: 'Designer' }, { id: 'coder', name: 'Coder' }, { id: 'reviewer', name: 'Code Reviewer' }, { id: 'code', name: 'Code' }];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// ── 纯逻辑 ──────────────────────────────────────────────────────────────────────
await check('@ 点名：最长名字优先，@所有人 记为 all，代码/链接/邮箱里的 @ 不算', () => {
	assert.deepEqual(mentionsIn('@Code Reviewer 看看，@Coder 你先写', ROSTER), { ids: ['reviewer', 'coder'], all: false });
	assert.deepEqual(mentionsIn('@Code 来一下', ROSTER), { ids: ['code'], all: false });
	assert.deepEqual(mentionsIn('@所有人 开会', ROSTER), { ids: [], all: true });
	assert.deepEqual(mentionsIn('发到 a@Coder.com，`@Designer` 和 https://x.com/@Designer 不算', ROSTER), { ids: [], all: false });
	assert.deepEqual(mentionsIn('＠designer 用 id 也行', ROSTER), { ids: ['designer'], all: false });
});
await check('谁来回答：@ 谁叫谁（并行）；admin 模式只叫管理员；everyone 依次（管理员先）；@所有人 全员并行', () => {
	const room = { members: ['designer', 'coder', 'reviewer'], admin: 'coder', mode: 'admin' };
	assert.deepEqual(openingCall(room, { ids: ['reviewer', 'designer'], all: false }), { ids: ['reviewer', 'designer'], ordered: false });
	assert.deepEqual(openingCall(room, { ids: [], all: false }), { ids: ['coder'], ordered: false });
	assert.deepEqual(openingCall({ ...room, mode: 'everyone' }, { ids: [], all: false }), { ids: ['coder', 'designer', 'reviewer'], ordered: true });
	assert.deepEqual(openingCall(room, { ids: [], all: true }), { ids: ['coder', 'designer', 'reviewer'], ordered: false });
	assert.deepEqual(openingCall(room, { ids: ['code'], all: false }), { ids: ['coder'], ordered: false }, '点了群外的人 ⇒ 按没点名处理');
});
await check('成员再叫人：不叫自己；只有管理员的 @所有人 有效；一轮里同一人被叫的总上限（防失控，多轮返工够用）', () => {
	const room = { members: ['designer', 'coder', 'reviewer'], admin: 'designer' };
	assert.deepEqual(callsFrom(room, 'coder', '@Designer @Coder 你们看', ROSTER, new Map()), ['designer']);
	assert.deepEqual(callsFrom(room, 'coder', '@所有人', ROSTER, new Map()), []);
	assert.deepEqual(callsFrom(room, 'designer', '@所有人', ROSTER, new Map()).sort(), ['coder', 'reviewer']);
	// ★ 2026-11-06：原来 2 次就到顶（打回一次就叫不动开发了）；现在上限只防失控
	assert.ok(ROOM_LIMITS.callsPerMember >= 6 && ROOM_LIMITS.botCalls >= 20, JSON.stringify(ROOM_LIMITS));
	assert.deepEqual(callsFrom(room, 'designer', '@Coder', ROSTER, new Map([['coder', 2]])), ['coder'], '第 3 次照样叫得动');
	assert.deepEqual(callsFrom(room, 'designer', '@Coder', ROSTER, new Map([['coder', ROOM_LIMITS.callsPerMember]])), []);
});
await check('沉默、去自报姓名、默认群名', () => {
	assert.equal(isPass('[PASS]'), true);
	assert.equal(isPass(' pass. '), true);
	assert.equal(isPass(''), true);
	assert.equal(isPass('我 pass 一下这个方案的第二点'), false);
	assert.equal(stripOwnName('Designer：先画线框', 'Designer'), '先画线框');
	assert.equal(stripOwnName('**Designer**: 好', 'Designer'), '好');
	assert.equal(stripOwnName('【Designer】好', 'Designer'), '好');
	assert.equal(autoRoomName(['A', 'B']), '你、A、B');
	assert.equal(autoRoomName(['A', 'B', 'C', 'D']), '你、A、B、C 等 5 人');
});
await check('@群 / 引用会话：dsh-session 解码、结构化引用识别、去掉 @群名只留指令', () => {
	const token = Buffer.from(JSON.stringify('session-room-1')).toString('base64url');
	assert.equal(decodeDshSessionToken(token), 'session-room-1');
	assert.deepEqual(sessionReferencesOf(`@[番茄钟 H5 开发团队](dsh-session:${token}) 开始制作`),
		[{ label: '番茄钟 H5 开发团队', sessionId: 'session-room-1' }]);
	const refEvent = { type: 'user/message', data: { source: { kind: ROOM_REFERENCE_KIND, references: [
		{ sessionId: 'session-room-1', label: '番茄钟 H5 开发团队' }] }, content: [{ type: 'text', text: '## Referenced sessions' }] } };
	assert.deepEqual(roomReferenceOf(refEvent, id => id === 'session-room-1', () => undefined),
		{ label: '番茄钟 H5 开发团队', sessionId: 'session-room-1', roomId: 'session-room-1' });
	assert.equal(addressedRoomReference('@番茄钟 H5 开发团队 开始制作', { label: '番茄钟 H5 开发团队' }), true);
	assert.equal(addressedRoomReference('这是背景资料，见 @番茄钟 H5 开发团队', { label: '番茄钟 H5 开发团队' }), false);
	assert.equal(stripRoomMention(`@[番茄钟 H5 开发团队](dsh-session:${token}) 开始制作番茄钟H5 应用`, '番茄钟 H5 开发团队'), '开始制作番茄钟H5 应用');
	assert.equal(stripRoomMention('@番茄钟 H5 开发团队 开始制作', '番茄钟 H5 开发团队'), '开始制作');
});
await check('统一轮次状态机：中断优先于失败；未结束有人在说 ⇒ replying；词表与文案齐全', () => {
	assert.deepEqual(ROUND_STATUSES, ['sent', 'replying', 'done', 'cut', 'failed']);
	for (const s of ROUND_STATUSES) { assert.ok(ROUND_STATUS_LABELS[s], `缺文案：${s}`); }
	assert.equal(roundStatusOf({ done: false, speaking: [] }), 'sent');
	assert.equal(roundStatusOf({ done: false, speaking: new Set(['Coder']) }), 'replying');
	assert.equal(roundStatusOf({ done: true }), 'done');
	assert.equal(roundStatusOf({ done: true, error: 'x' }), 'failed');
	assert.equal(roundStatusOf({ done: true, error: '执行被重启打断', interrupted: true }), 'cut', '重启收口同时带 error，仍算中断');
	assert.equal(roundStatusOf({ done: true, events: [{ kind: 'cut' }] }), 'cut');
	assert.equal(roundStatusOf({ done: true, phase: 'cut' }), 'cut');
	assert.equal(roundStatusOf(null), 'sent');
	assert.equal(ROUND_SCHEMA, 1);
});
await check('建群校验：两个同名 Bot 不能同群（群里靠名字认人，会互相错配）', () => {
	const twins = [...ROSTER, { id: 'coder-2', name: 'coder' }];
	assert.throws(() => normalizeRoomInput({ members: ['designer', 'coder', 'coder-2'] }, twins), /同名/);
	assert.deepEqual(normalizeRoomInput({ members: ['designer', 'coder-2'] }, twins).members, ['designer', 'coder-2'], '只选其中一个照常建群');
});
await check('建群校验：名字或 id 都认、去重；不认识的 / 少于 2 个 / 管理员不在群里 / 公告太长都拒绝', () => {
	const ok = normalizeRoomInput({ members: ['Designer', 'coder', 'designer'], notice: ' 先出方案 ' }, ROSTER);
	assert.deepEqual(ok, { members: ['designer', 'coder'], name: '你、Designer、Coder', named: false, notice: '先出方案', admin: 'designer', mode: 'admin' });
	assert.equal(normalizeRoomInput({ members: ['designer', 'coder'], name: '番茄钟', admin: 'Coder', mode: 'everyone' }, ROSTER).admin, 'coder');
	assert.throws(() => normalizeRoomInput({ members: ['designer', 'nobody'] }, ROSTER), /没有叫「nobody」的 Bot/);
	assert.throws(() => normalizeRoomInput({ members: ['designer'] }, ROSTER), /至少要有 2 个/);
	assert.throws(() => normalizeRoomInput({ members: ['designer', 'coder'], admin: 'reviewer' }, ROSTER), /管理员必须是群成员/);
	assert.throws(() => normalizeRoomInput({ members: ['designer', 'coder'], notice: 'x'.repeat(2001) }, ROSTER), RoomError);
	assert.throws(() => normalizeRoomInput({ members: ['designer', 'coder'], mode: 'mentions' }, ROSTER), /谁来回答/);
});
await check('群提示：成员、公告、新消息、位次与 [PASS] 规则；首次进群看最近消息', () => {
	const room = { id: 'r', name: '番茄钟', members: ['designer', 'coder'], admin: 'designer', notice: '用 Vue 3' };
	const log = [{ seq: 1, who: '用户', text: '做个番茄钟' }, { seq: 2, who: 'Designer', text: '我先出稿' }];
	const text = roomPrompt({ room, member: { id: 'coder', name: 'Coder' }, members: ROSTER.slice(0, 2), log, seen: 1,
		place: { ordered: true, index: 1, total: 2 }, calledBy: 'Designer' });
	assert.match(text, /^\[群聊「番茄钟」· 轮到你（Coder）\]/);
	assert.match(text, /群成员：你、Designer（管理员）/);
	assert.match(text, /群公告（每位成员都要遵守）：\n用 Vue 3/);
	assert.match(text, /之前的消息：\n用户：做个番茄钟/);
	assert.match(text, /新消息：\nDesigner：我先出稿/);
	assert.match(text, /是Designer叫你的/);
	assert.match(text, /你是第 2 位（共 2 位）/);
	assert.match(text, /\[PASS\]/);
	assert.match(roomPrompt({ room, member: { id: 'designer', name: 'Designer' }, members: ROSTER.slice(0, 2), log, seen: undefined, place: {} }), /最近的消息：\n用户：做个番茄钟\nDesigner：我先出稿[\s\S]*你是管理员/);
});
await check('群标记投影：读 plugin record，忽略别的事件返回同一引用；侧栏顺序置顶在前', () => {
	const unit = roomProjection();
	const state = unit.init();
	assert.equal(unit.apply(state, { type: 'user/message' }), state);
	const marked = unit.apply(state, { type: ROOM_RECORD_TYPE, ignorable: true, data: { v: 1, roomId: 'r1', role: 'member', botId: 'coder' } });
	assert.deepEqual(unit.wire.view(marked), { roomId: 'r1', role: 'member', botId: 'coder' });
	assert.equal(roomOfEvent({ type: ROOM_RECORD_TYPE, data: { roomId: 'r1' } }), undefined, '不是 ignorable 的不认');
	assert.deepEqual(sortRooms([{ id: 'a', updatedAt: 3 }, { id: 'b', pinned: true, updatedAt: 1 }, { id: 'c', updatedAt: 5 }]).map(r => r.id), ['b', 'c', 'a']);
});

// ── 假 dsh ──────────────────────────────────────────────────────────────────────
/**
 * 会话 = { id, preset, place, title, records, inbox, events, seq, archived }。
 * 成员会话收到 followup ⇒ 下一拍「跑一个回合」：splice 我们的消息 + 一条 assistant 文本（由 reply(botId, prompt) 决定），
 * 然后发 turn-stopping。reply 返回 'hang' ⇒ 不回（测超时）。
 */
function fakeHost(reply) {
	const sessions = new Map();
	const listeners = new Map();
	const order = [];
	let n = 0;
	let rooms;
	const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) { fn(...args); } };
	const agentOf = (s) => ({
		id: s.id,
		session: { id: s.id, get seq() { return s.seq; }, snapshotEvents: (from, to) => s.events.filter(e => e.seq > from && e.seq <= to) },
		inbox: { get nextTurn() { return s.inbox; }, nextStep: [] },
		ctx: { tools: { register: (def) => { s.tools.push(def.name); return () => undefined; } } },
		followup(message) {
			s.inbox.push(message);
			order.push({ at: 'start', session: s.id });
			setTimeout(() => {
				const botId = /^vssaros-(.+)$/.exec(s.preset ?? '')?.[1];
				const answer = reply(botId, message.content[0].text, s);
				if (answer === 'hang') { return; }
				// 回复可以是 `{ text, tools }`：先记 tools 次工具调用（成员「真干了活」），再说 text
				const text = typeof answer === 'object' && answer ? answer.text : answer;
				s.seq += 1; s.events.push({ seq: s.seq, type: 'agent/inbox/spliced', data: { inserted: [message] } });
				for (let i = 0; i < (typeof answer === 'object' && answer ? answer.tools ?? 0 : 0); i += 1) {
					s.seq += 1; s.events.push({ seq: s.seq, type: 'tool/call', data: { callId: `c${s.seq}`, name: 'edit', arguments: {} } });
				}
				s.seq += 1; s.events.push({ seq: s.seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
				order.push({ at: 'end', session: s.id });
				emit('agent/turn-stopping', { agent: { session: agentOf(s).session } });
			}, 5);
		},
	});
	const host = {
		sessions,
		order,
		archived: [],
		sc: {
			create: async ({ workspaceId, cwd, agentPreset }) => {
				const id = `s${++n}`;
				sessions.set(id, { id, preset: agentPreset, place: workspaceId ?? cwd, title: '', records: [], inbox: [], events: [], seq: 0, tools: [] });
				return { sessionId: id, agentPreset };
			},
			rename: async ({ sessionId, title }) => { sessions.get(sessionId).title = title; return { title, seq: 1 }; },
			resolveAgent: async (id) => (sessions.has(id) ? { agent: agentOf(sessions.get(id)) } : { error: { code: 'session/not-found' } }),
		},
		agents: { get: (id) => (sessions.has(id) ? agentOf(sessions.get(id)) : undefined) },
		workspaces: { list: () => [{ id: 'ws1', path: 'C:/work' }], create: async (path) => ({ id: `ws:${path}` }), archiveSession: async (id) => { host.archived.push(id); } },
		append: (session, type, data) => { sessions.get(session.id).records.push({ type, data }); return 1; },
		ctx: { on: (name, fn) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => undefined; } },
		emit,
		set rooms(value) { rooms = value; },
		get rooms() { return rooms; },
	};
	return host;
}
function makeRooms(host, file, extra = {}) {
	return createRooms({
		file, fallbackCwd: 'C:/fallback', roster: async () => ROSTER, presetOf: id => `vssaros-${id}`,
		sessions: () => host.sc, agents: () => host.agents, workspaces: () => host.workspaces, append: async () => host.append,
		warn: () => undefined, ...extra,
	});
}
const dir = mkdtempSync(join(tmpdir(), 'vssaros-rooms-'));
const file = join(dir, 'agent-rooms.json');

/** 手动结束一个被 'hang' 住的成员回合（模拟成员干了很久才完成）。 */
function finishHungTurn(host, sessionId, text) {
	const s = host.sessions.get(sessionId);
	const message = s.inbox.at(-1);
	s.seq += 1; s.events.push({ seq: s.seq, type: 'agent/inbox/spliced', data: { inserted: [message] } });
	s.seq += 1; s.events.push({ seq: s.seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
	host.emit('agent/turn-stopping', { agent: { session: { id: s.id, get seq() { return s.seq; }, snapshotEvents: (from, to) => s.events.filter(e => e.seq > from && e.seq <= to) } } });
}
const memberSessionOf = (host, botId) => [...host.sessions.values()].find(s => s.preset === `vssaros-${botId}`)?.id;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const waitUntilTrue = async (test, ms = 2000) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) { throw new Error('等不到条件成立'); } await sleep(5); } };
const drain = async (iter) => { const out = []; for await (const chunk of iter) { out.push(chunk); } return out; };

await check('接力闭环（对齐 DS Bot）：开发 @测试 → 测试发现问题 @开发 → 开发改完没 @ 人 ⇒ 自动叫回测试复测；接力规则写进提示词', async () => {
	const said = { coder: 0, reviewer: 0 };
	const prompts = [];
	const h = fakeHost((botId, prompt) => {
		prompts.push({ botId, prompt });
		said[botId] = (said[botId] ?? 0) + 1;
		if (botId === 'coder') { return said.coder === 1 ? { text: '番茄钟写好了。@Code Reviewer 请在浏览器里点测', tools: 3 } : { text: '按钮已修好，改了 src/timer.js', tools: 2 }; }
		if (botId === 'reviewer') { return said.reviewer === 1 ? { text: '开始按钮点了没反应。@Coder 请修，复现：点开始', tools: 4 } : { text: '复测通过，三个按钮都正常', tools: 3 }; }
		return '[PASS]';
	});
	const rs = makeRooms(h, join(dir, 'loop.json'));
	installRooms(h.ctx, rs);
	const r = await rs.create({ members: ['coder', 'reviewer', 'designer'], name: '闭环群' });
	rs.noteUserMessage(r.id, '做一个番茄钟');
	const out = JSON.parse(await rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-loop' }));
	assert.deepEqual(out.replies.map(x => [x.name, x.text]), [
		['Coder', '番茄钟写好了。@Code Reviewer 请在浏览器里点测'],
		['Code Reviewer', '开始按钮点了没反应。@Coder 请修，复现：点开始'],
		['Coder', '按钮已修好，改了 src/timer.js'],
		['Code Reviewer', '复测通过，三个按钮都正常'],
	], '开发修完后测试被自动叫回复测');
	assert.match(prompts.at(-1).prompt, /Coder 完成了你交代的工作/, '叫回时说明是谁做完了');
	assert.ok(out.events.some(e => e.kind === 'working' && /叫回 Code Reviewer/.test(e.text)));
	assert.match(prompts[0].prompt, /系统会把结果交回给你/);
	assert.match(prompts[0].prompt, /同一步就开始调用工具/);
	// 叫人的一方没干活（只是转述）⇒ 不叫回派活的人
	assert.equal(turnWorked([{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'x' }] } } }]), true);
	assert.equal(turnWorked([{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } }]), false);
});

await check('只拦空转：成员之间连续 6 次没干活的互相接话就停下（有人干活就清零）', async () => {
	const h = fakeHost((botId) => (botId === 'designer' ? '@Coder 你看呢' : botId === 'coder' ? '@Designer 你定吧' : '[PASS]'));
	const rs = makeRooms(h, join(dir, 'idle-relay.json'));
	installRooms(h.ctx, rs);
	const r = await rs.create({ members: ['designer', 'coder'], name: '空转群' });
	rs.noteUserMessage(r.id, '讨论一下');
	const out = JSON.parse(await rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-idle-relay' }));
	assert.equal(out.replies.length, 1 + ROOM_IDLE_RELAY_LIMIT, '管理员先答，之后 6 次空转接话就停');
	assert.ok(out.events.some(e => e.kind === 'paused' && /没有干活/.test(e.text)));
	// 一直在干活的接力不受这个限制（超过 6 次照样接）
	let n = 0;
	const busy = fakeHost((botId) => { n += 1; return n <= 9 ? { text: botId === 'designer' ? '改好了 @Coder' : '改好了 @Designer', tools: 1 } : '收工'; });
	const rb = makeRooms(busy, join(dir, 'busy-relay.json'));
	installRooms(busy.ctx, rb);
	const rr = await rb.create({ members: ['designer', 'coder'], name: '干活群' });
	rb.noteUserMessage(rr.id, '开干');
	const done = JSON.parse(await rb.relayTool().execute({}, { agent: { id: rr.id }, callId: 'c-busy' }));
	assert.ok(done.replies.length >= 9, `一直干活的接力走了 ${done.replies.length} 次`);
	assert.ok(!done.events.some(e => e.kind === 'paused'));
});

await check('群目标（纯函数）：start 校验阶段与成员；pass 推进、rework 打回、revise 只改未通过的、complete 要求全部通过；账本与成员段落', () => {
	const room = { members: ['coder', 'designer', 'reviewer'], admin: 'coder' };
	const names = new Map(ROSTER.map(b => [b.id, b.name]));
	const ctx = { by: 'coder', memberOf: ref => room.members.find(id => id === String(ref).toLowerCase() || names.get(id) === ref), nameOf: id => names.get(id) ?? id, now: 1 };
	assert.match(applyGoal(room, { action: 'pass', evidence: 'x' }, ctx).error, /还没有目标/);
	assert.match(applyGoal(room, { action: 'start', objective: '番茄钟', acceptance: '能跑', stages: [{ title: '设计', acceptance: '有稿', tasks: [{ bot: 'Writer', task: 'x' }] }] }, ctx).error, /不是这个群的成员/);
	assert.match(applyGoal(room, { action: 'start', objective: '番茄钟', acceptance: '能跑', stages: [{ title: '设计', acceptance: '有稿', tasks: [] }] }, ctx).error, /没有任务/);
	const started = applyGoal(room, { action: 'start', title: '番茄钟 H5', objective: '做一个番茄钟 H5', acceptance: '浏览器里三个按钮都能用', rules: ['不引入后端'], stages: [
		{ title: '设计', acceptance: '页面与交互说明', tasks: [{ bot: 'Designer', task: '出设计' }] },
		{ title: '开发', acceptance: '本地能跑', tasks: [{ bot: 'Coder', task: '写代码' }] },
		{ title: '测试', acceptance: '浏览器点测通过', tasks: [{ bot: 'Code Reviewer', task: '点测' }] }] }, ctx);
	assert.deepEqual(started.reply, { event: 'start', title: '番茄钟 H5', stage: 1, stages: 3, next: '设计', note: '现在就在同一条回复里 @ 第一阶段的成员派活。' });
	assert.match(applyGoal(room, { action: 'start', objective: 'y', acceptance: 'y', stages: [{ title: 'a', acceptance: 'b', tasks: [{ bot: 'coder', task: 'c' }] }] }, ctx).error, /已经有一个进行中的目标/);
	assert.equal(markTask(room.goal, 'designer', ['pending'], 'working'), true);
	assert.match(goalPromptBlock(room.goal, 'designer', false, ctx.nameOf), /你在这一阶段的任务：出设计（进行中）/);
	assert.match(goalPromptBlock(room.goal, 'reviewer', false, ctx.nameOf), /这一阶段没有你的任务/);
	const ledger = goalPromptBlock(room.goal, 'coder', true, ctx.nameOf);
	assert.match(ledger, /\[当前\] 1\. 设计 —— 完成标准：页面与交互说明/);
	assert.match(ledger, /Designer：出设计【进行中】/);
	assert.match(ledger, /action=rework/);
	assert.match(applyGoal(room, { action: 'pass' }, ctx).error, /需要 evidence/);
	assert.equal(applyGoal(room, { action: 'pass', evidence: '设计稿在 design.md' }, ctx).reply.next, '开发');
	const rework = applyGoal(room, { action: 'rework', reason: '开始按钮没反应', bot: 'Coder' }, ctx).reply;
	assert.deepEqual([rework.event, rework.stage, rework.reworks], ['rework', 2, 1]);
	assert.match(goalPromptBlock(room.goal, 'coder', true, ctx.nameOf), /已打回 1 次，最近一次：开始按钮没反应/);
	assert.match(applyGoal(room, { action: 'complete', evidence: 'x' }, ctx).error, /第 2 阶段「开发」还没通过/);
	// revise 只改还没通过的阶段
	applyGoal(room, { action: 'revise', stages: [{ title: '开发 v2', acceptance: '本地能跑', tasks: [{ bot: 'coder', task: '重写' }] }, { title: '测试', acceptance: '点测', tasks: [{ bot: 'reviewer', task: '点测' }] }] }, ctx);
	assert.deepEqual(room.goal.stages.map(s => [s.title, s.status]), [['设计', 'passed'], ['开发 v2', 'active'], ['测试', 'pending']]);
	applyGoal(room, { action: 'pass', evidence: '能跑' }, ctx);
	assert.equal(applyGoal(room, { action: 'pass', evidence: '点测通过' }, ctx).reply.note.includes('complete'), true);
	assert.match(goalPromptBlock(room.goal, 'coder', true, ctx.nameOf), /所有阶段都通过了/);
	assert.equal(applyGoal(room, { action: 'complete', evidence: '三个按钮都能用', summary: '做好了' }, ctx).reply.event, 'complete');
	assert.equal(goalPromptBlock(room.goal, 'coder', true, ctx.nameOf), '', '完成后不再出现在提示词里');
	assert.match(applyGoal(room, { action: 'nope' }, ctx).error, /action 只能是/);
	assert.equal(GOAL_IDLE_NUDGES, 2);
});

await check('长任务提前放行（P2）：成员调工具后到点就不等它，本轮照常结束；它干完后结果进群聊，并新开一轮叫回派活的人', async () => {
	const said = { coder: 0, reviewer: 0 };
	const h = fakeHost((botId) => {
		said[botId] = (said[botId] ?? 0) + 1;
		if (botId === 'coder') { return said.coder === 1 ? { text: '@Code Reviewer 请写番茄钟，写完告诉我', tools: 1 } : { text: '好，我看下结果', tools: 1 }; }
		if (botId === 'reviewer') { return 'hang'; }
		return '[PASS]';
	});
	const rs = makeRooms(h, join(dir, 'release.json'), { releaseMs: 60, timeoutMs: 5000, maxWaitMs: 10_000 });
	installRooms(h.ctx, rs);
	const r = await rs.create({ members: ['coder', 'reviewer'], name: '放行群' });
	rs.noteUserMessage(r.id, '开工');
	const running = rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-rel-1' });
	await waitUntilTrue(() => !!memberSessionOf(h, 'reviewer') && h.sessions.get(memberSessionOf(h, 'reviewer')).inbox.length > 0);
	const rid = memberSessionOf(h, 'reviewer');
	h.emit('session/event', { id: rid }, { type: 'tool/call' }); // 开始干活 ⇒ 60ms 后放行
	const out = JSON.parse(await running);
	assert.deepEqual(out.failed, [], '放行不算失败');
	assert.ok(out.events.some(e => e.kind === 'working' && /这一轮先不等它/.test(e.text)), JSON.stringify(out.events.map(e => e.text)));
	assert.equal(said.coder, 1, '放行的人还没干完 ⇒ 本轮不叫回派活的人');
	// 它干完 ⇒ 结果进群聊，群会话收到一条「新开一轮」的消息（不进人的收件箱）
	const roomSession = h.sessions.get(r.id);
	const before = roomSession.inbox.length;
	finishHungTurn(h, rid, '写好了，在 src/');
	await waitUntilTrue(() => roomSession.inbox.length > before);
	const kick = roomSession.inbox.at(-1);
	assert.equal(kick.source.form, 'room-callback');
	assert.equal(userTextOf({ type: 'user/message', data: kick }), undefined, '回叫消息不当成人说的话');
	await rs.flush();
	const log = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')).rooms[0].log;
	assert.deepEqual([log.at(-1).who, log.at(-1).text, log.at(-1).late], ['Code Reviewer', '写好了，在 src/', true]);
	// 新一轮：叫回 Coder，提示词里写明谁干完了
	const next = JSON.parse(await rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-rel-2' }));
	assert.deepEqual(next.replies.map(x => [x.name, x.text]), [['Coder', '好，我看下结果']]);
	assert.ok(next.events.some(e => /Code Reviewer 完成了工作.*叫回 Coder/.test(e.text)), JSON.stringify(next.events.map(e => e.text)));
});

// ★ 2026-11-06 真机：「@番茄钟 H5 开发团队 开发H5 番茄钟」管理员 Coder 被放行到后台、5 分钟后迟到回复里 @Designer @Tester
//   派活，两人从没被叫到（群记录只有 Coder 的会话），需求停在半路。
await check('迟到回复里 @ 到的成员新开一轮去做；他们做完叫回点人的成员（对齐 DS Bot lateRoomReply）', async () => {
	const said = { coder: 0, designer: 0, reviewer: 0 };
	const h = fakeHost((botId) => {
		said[botId] = (said[botId] ?? 0) + 1;
		if (botId === 'coder') { return said.coder === 1 ? 'hang' : { text: '统计页和验收结果都收到了，可以交付', tools: 1 }; }
		if (botId === 'designer') { return { text: '统计页原型在 design/stats.md', tools: 1 }; }
		if (botId === 'reviewer') { return { text: '首页验收通过，无 P0', tools: 1 }; }
		return '[PASS]';
	});
	const file = join(dir, 'late-named.json');
	const rs = makeRooms(h, file, { releaseMs: 60, timeoutMs: 5000, maxWaitMs: 10_000 });
	installRooms(h.ctx, rs);
	const r = await rs.create({ members: ['coder', 'designer', 'reviewer'], name: '番茄钟群' });
	rs.noteUserMessage(r.id, '开发H5 番茄钟');
	const running = rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-ln-1' });
	await waitUntilTrue(() => !!memberSessionOf(h, 'coder') && h.sessions.get(memberSessionOf(h, 'coder')).inbox.length > 0);
	const cid = memberSessionOf(h, 'coder');
	h.emit('session/event', { id: cid }, { type: 'tool/call' }); // 管理员开始写代码 ⇒ 放行到后台
	const first = JSON.parse(await running);
	assert.deepEqual([said.designer, said.reviewer], [0, 0], '本轮只叫了管理员');
	assert.deepEqual(first.failed, []);
	const roomSession = h.sessions.get(r.id);
	const before = roomSession.inbox.length;
	finishHungTurn(h, cid, '首页搭好了。@Designer 请设计统计页 @Code Reviewer 请验收首页');
	await waitUntilTrue(() => roomSession.inbox.length > before);
	assert.equal(roomSession.inbox.length, before + 1, '点到的两人合成一条「新开一轮」');
	assert.equal(roomSession.inbox.at(-1).source.form, 'room-callback');
	const next = JSON.parse(await rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-ln-2' }));
	assert.deepEqual(next.replies.map(x => x.name).sort(), ['Code Reviewer', 'Coder', 'Designer'], JSON.stringify(next.replies));
	assert.deepEqual([said.designer, said.reviewer, said.coder], [1, 1, 2], '两人各做一次，做完叫回 Coder');
	assert.equal(next.replies.at(-1).name, 'Coder', '叫回的是点人的成员，在两人之后');
	assert.ok(next.events.some(e => /Coder 在迟到回复里点了 Designer/.test(e.text)), JSON.stringify(next.events.map(e => e.text)));
	await rs.flush();
	const log = JSON.parse(readFileSync(file, 'utf8')).rooms[0].log;
	assert.ok(log.some(l => l.who === 'Designer' && /stats\.md/.test(l.text)) && log.some(l => l.who === 'Code Reviewer' && /验收通过/.test(l.text)));
});

await check('群目标接线：管理员能用 group_goal、成员不能；任务状态随 @ 与交回推进；一轮结束没人干活 ⇒ 自动目标检查，管理员 [PASS] 就停', async () => {
	let adminTurns = 0;
	const prompts = [];
	const h = fakeHost((botId, prompt) => {
		prompts.push({ botId, prompt });
		if (botId === 'coder') { adminTurns += 1; return adminTurns === 1 ? { text: '@Designer 出设计', tools: 1 } : adminTurns === 2 ? { text: '设计收到', tools: 1 } : '[PASS]'; }
		if (botId === 'designer') { return { text: '设计稿好了，在 design.md', tools: 2 }; }
		return '[PASS]';
	});
	const file2 = join(dir, 'goal.json');
	const rs = makeRooms(h, file2, { releaseMs: 0 });
	installRooms(h.ctx, rs);
	const r = await rs.create({ members: ['coder', 'designer'], name: '目标群' });
	rs.noteUserMessage(r.id, '你好');
	await rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-g0' }); // 建出成员会话
	const coderSid = memberSessionOf(h, 'coder');
	assert.ok(h.sessions.get(coderSid).tools.includes('group_goal'), '成员会话挂了 group_goal');
	const tool = rs.goalTool(r.id, 'coder');
	const startOut = JSON.parse(await tool.execute({ action: 'start', title: '番茄钟', objective: '做番茄钟', acceptance: '能用', stages: [
		{ title: '设计', acceptance: '有稿', tasks: [{ bot: 'Designer', task: '出设计' }] },
		{ title: '开发', acceptance: '能跑', tasks: [{ bot: 'Coder', task: '写代码' }] }] }));
	assert.equal(startOut.event, 'start');
	assert.match(JSON.parse(await rs.goalTool(r.id, 'designer').execute({ action: 'status' })).error, /只有群管理员/);
	assert.equal(rs.goalOf(r.id).stageTitle, '设计');
	// 第 1 轮：管理员 @Designer ⇒ 进行中；Designer 交回 ⇒ 已交付；做完叫回管理员；之后一轮结束、没人干活 ⇒ 自动目标检查
	rs.noteUserMessage(r.id, '开始');
	adminTurns = 0;
	await rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-g1' });
	assert.equal(rs.goalOf(r.id).tasks[0].status, 'reported', JSON.stringify(rs.goalOf(r.id)));
	assert.match(prompts.filter(p => p.botId === 'designer').at(-1)?.prompt ?? '', /你在这一阶段的任务：出设计/, JSON.stringify(prompts.map(p => [p.botId, p.prompt.slice(-200)])));
	assert.match(prompts.filter(p => p.botId === 'coder').at(-1).prompt, /【群目标】[\s\S]*\[当前\] 1\. 设计/);
	assert.match(prompts.filter(p => p.botId === 'coder').at(-1).prompt, /Designer 完成了你交代的工作/, '做完叫回管理员');
	const roomSession = h.sessions.get(r.id);
	await waitUntilTrue(() => roomSession.inbox.some(m => m.source?.form === 'room-callback'));
	assert.match(roomSession.inbox.at(-1).content[0].text, /目标检查/);
	// 目标检查轮：管理员 [PASS] ⇒ 停下（idle），不再催
	const nudge = JSON.parse(await rs.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-g2' }));
	assert.ok(nudge.events.some(e => /目标检查/.test(e.text)));
	assert.match(prompts.at(-1).prompt, /【目标检查】/);
	await rs.flush();
	assert.equal(rs.goalOf(r.id).idle, true);
	const count = roomSession.inbox.filter(m => m.source?.form === 'room-callback').length;
	await sleep(30);
	assert.equal(roomSession.inbox.filter(m => m.source?.form === 'room-callback').length, count, 'idle 之后不再催');
	const log = JSON.parse(readFileSync(file2, 'utf8')).rooms[0].log;
	assert.ok(log.some(l => l.kind === 'goal' && /设定了目标「番茄钟」，共 2 个阶段/.test(l.text)));
});

await check('成员等待按进展计时：一直有动静就一直等，最终回复照常进群（真机：Coder 写了 12 分钟代码被第 240 秒判超时）', async () => {
	const h = fakeHost(() => 'hang');
	const slow = makeRooms(h, join(dir, 'slow.json'), { timeoutMs: 250, maxWaitMs: 10_000 });
	installRooms(h.ctx, slow);
	const r = await slow.create({ members: ['designer', 'coder'], name: '慢活群' });
	slow.noteUserMessage(r.id, '开始做');
	const running = slow.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-slow' });
	await sleep(20);
	const sid = memberSessionOf(h, 'designer');
	assert.ok(sid, '管理员拿到了活');
	for (let i = 0; i < 12; i += 1) { await sleep(50); h.emit('session/event', { id: sid }, { type: 'tool/call' }); } // 600ms > 250ms 超时，但一直有进展
	finishHungTurn(h, sid, '骨架搭好了，代码在 src/ 下');
	const out = JSON.parse(await running);
	assert.deepEqual(out.failed, [], '有进展就不判超时');
	assert.deepEqual(out.replies.map(x => [x.name, x.text]), [['Designer', '骨架搭好了，代码在 src/ 下']]);
});

await check('毫无进展才超时；超时后成员干完的回复记进群聊记录（标 late），不再丢失', async () => {
	const h = fakeHost(() => 'hang');
	const idleFile = join(dir, 'idle.json');
	const idle = makeRooms(h, idleFile, { timeoutMs: 60, maxWaitMs: 5000 });
	installRooms(h.ctx, idle);
	const r = await idle.create({ members: ['designer', 'coder'], name: '超时群' });
	idle.noteUserMessage(r.id, '开始做');
	const out = JSON.parse(await idle.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-idle' }));
	assert.equal(out.failed.length, 1);
	assert.match(out.failed[0].reason, /秒没有任何进展/);
	assert.ok(out.events.some(e => e.kind === 'missed' && /记进群聊记录/.test(e.text)));
	finishHungTurn(h, memberSessionOf(h, 'designer'), '我这边做完了');
	await idle.flush();
	const log = JSON.parse(readFileSync(idleFile, 'utf8')).rooms[0].log;
	assert.deepEqual([log.at(-1).who, log.at(-1).text, log.at(-1).late], ['Designer', '我这边做完了', true], '迟到的回复进了群聊记录');
	// 同一回合再结束一次（事件重放）不会重复记
	h.emit('agent/turn-stopping', { agent: { session: { id: memberSessionOf(h, 'designer'), seq: h.sessions.get(memberSessionOf(h, 'designer')).seq, snapshotEvents: () => [] } } });
	await idle.flush();
	assert.equal(JSON.parse(readFileSync(idleFile, 'utf8')).rooms[0].log.filter(l => l.late).length, 1);
});

await check('群成员的工具审批由群接住：进本轮 approvals 与 approval 节点，等审批不算超时，批了才继续（对齐 DS Bot「等你审批」）', async () => {
	const h = fakeHost(() => 'hang');
	let skew = 0;
	const ap = makeRooms(h, join(dir, 'approval.json'), { timeoutMs: 80, maxWaitMs: 10_000, now: () => Date.now() + skew });
	installRooms(h.ctx, ap);
	const r = await ap.create({ members: ['designer', 'coder'], name: '审批群' });
	ap.noteUserMessage(r.id, '开始做');
	const running = ap.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-ap' });
	await sleep(20);
	const sid = memberSessionOf(h, 'designer');
	const s = h.sessions.get(sid);
	s.seq += 1; s.events.push({ seq: s.seq, type: 'tool/call', data: { callId: 'call-1', name: 'pwsh', arguments: { command: 'pnpm add -D vitest' } } });
	let passedOn = false;
	const decided = ap.decideApproval({ agent: h.agents.get(sid), toolName: 'pwsh', callId: 'call-1' }, async () => { passedOn = true; return 'unavailable'; });
	await sleep(20);
	const live = ap.progress('c-ap');
	assert.equal(passedOn, false, '群成员的请求不交给 DSH 自带审批框');
	assert.equal(live.approvals.length, 1);
	assert.deepEqual([live.approvals[0].name, live.approvals[0].tool, live.approvals[0].detail], ['Designer', 'pwsh', 'pnpm add -D vitest']);
	assert.equal(live.approvals[0].settle, undefined, '对外视图不带内部回调');
	assert.ok(live.events.some(e => e.kind === 'approval' && e.approvalId === live.approvals[0].id && /等你批准/.test(e.text)));
	await sleep(250); // 超过 80ms 的「没有进展」窗口
	assert.equal(ap.progress('c-ap').failed.length, 0, '等人审批期间不判超时');
	// 接口回答
	const bad = await roomsApi(ap, { method: 'POST', query: new URLSearchParams(), body: { action: 'approve', id: live.approvals[0].id, choice: 'maybe' } });
	assert.equal(bad.status, 400);
	const ok = await roomsApi(ap, { method: 'POST', query: new URLSearchParams(), body: { action: 'approve', id: live.approvals[0].id, choice: 'allow' } });
	assert.equal(ok.status, 200);
	assert.equal(await decided, 'allowed-once');
	assert.equal(ap.progress('c-ap').approvals.length, 0);
	assert.ok(ap.progress('c-ap').events.some(e => e.kind === 'working' && /已允许/.test(e.text)));
	const again = await roomsApi(ap, { method: 'POST', query: new URLSearchParams(), body: { action: 'approve', id: live.approvals[0].id, choice: 'allow' } });
	assert.equal(again.status, 404, '同一条不能答两次');
	// 群已不等的迟到成员也可能请求审批：本轮结束很久之后，那个群的最近一轮仍出现在活动列表里
	finishHungTurn(h, sid, '依赖装好了');
	assert.deepEqual(JSON.parse(await running).replies.map(x => x.text), ['依赖装好了']);
	skew = 20 * 60_000; // 本轮结束 20 分钟后（远超活动列表的 15 秒 / 10 分钟保留）
	assert.equal(ap.active().find(item => item.roomId === r.id), undefined, '没有待审批时结束很久的轮次不在活动列表里');
	const lateAsk = ap.decideApproval({ agent: h.agents.get(sid), toolName: 'pwsh' }, async () => 'unavailable');
	await sleep(5);
	const shown = ap.active().find(item => item.roomId === r.id);
	assert.equal(shown?.approvals.length, 1, '有待审批的群保持在活动列表里');
	ap.answerApproval(shown.approvals[0].id, 'reject');
	assert.equal(await lateAsk, 'rejected');
	assert.ok(shown.callId.startsWith('approvals:') || shown.callId === 'c-ap', shown.callId);
	// 不是群成员的会话：原样交给下一个处理者（DSH 自带审批框）
	assert.equal(await ap.decideApproval({ agent: { id: 'someone-else', session: { header: {} } }, toolName: 'pwsh' }, async () => 'unavailable'), 'unavailable');
});

await check('群成员审批：拒绝即拒绝，没人批则到时按拒绝，请求被撤销按取消', async () => {
	const h = fakeHost(() => 'hang');
	const ap = makeRooms(h, join(dir, 'approval2.json'), { timeoutMs: 5000, maxWaitMs: 10_000, approvalMaxMs: 60 });
	installRooms(h.ctx, ap);
	const r = await ap.create({ members: ['designer', 'coder'], name: '审批群2' });
	ap.noteUserMessage(r.id, '开始做');
	void ap.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-ap2' });
	await sleep(20);
	const agent = h.agents.get(memberSessionOf(h, 'designer'));
	const rejected = ap.decideApproval({ agent, toolName: 'write' }, async () => 'unavailable');
	await sleep(5);
	ap.answerApproval(ap.pendingApprovals(r.id)[0].id, 'reject');
	assert.equal(await rejected, 'rejected');
	assert.equal(await ap.decideApproval({ agent, toolName: 'write' }, async () => 'unavailable'), 'rejected', '60ms 没人批 ⇒ 拒绝');
	assert.ok(ap.progress('c-ap2').events.some(e => /没人批，已拒绝/.test(e.text || '')));
	const controller = new AbortController();
	const cancelled = ap.decideApproval({ agent, toolName: 'write', signal: controller.signal }, async () => 'unavailable');
	await sleep(5);
	controller.abort();
	assert.equal(await cancelled, 'cancelled');
	assert.equal(ap.pendingApprovals().length, 0);
});

await check('一直有进展也有硬上限', async () => {
	const h = fakeHost(() => 'hang');
	const capped = makeRooms(h, join(dir, 'cap.json'), { timeoutMs: 200, maxWaitMs: 400 });
	installRooms(h.ctx, capped);
	const r = await capped.create({ members: ['designer', 'coder'], name: '上限群' });
	capped.noteUserMessage(r.id, '开始做');
	const running = capped.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-cap' });
	const pulse = setInterval(() => { const sid = memberSessionOf(h, 'designer'); if (sid) { h.emit('session/event', { id: sid }, { type: 'tool/call' }); } }, 20);
	try {
		const out = JSON.parse(await running);
		assert.match(out.failed[0]?.reason ?? '', /分钟仍未完成/);
	} finally { clearInterval(pulse); }
});

await check('群这一轮的结果写成助手正文：回合折叠后仍看得见成员回复', async () => {
	const tool = (result, isError = false) => ({ role: 'tool', toolCallId: 'c', isError, content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] });
	assert.equal(relayAnswerText(tool({ replies: [{ name: 'Designer', text: '稿子好了' }, { name: 'Coder', text: '骨架好了' }], failed: [], passed: [] })),
		'**Designer**：稿子好了\n\n**Coder**：骨架好了');
	assert.match(relayAnswerText(tool({ replies: [], failed: [{ name: 'Coder', reason: '240 秒没有任何进展' }], passed: [] })), /^> Coder 没能回答：240 秒没有任何进展$/);
	assert.equal(relayAnswerText(tool({ replies: [], failed: [], passed: ['Coder'] })), 'Coder 没有补充。');
	assert.match(relayAnswerText(tool('The tool call was interrupted after it was recorded…', true)), /被中断/);
	assert.match(relayAnswerText(tool({ replies: [{ name: 'Coder', text: '写了一半' }], failed: [], passed: [], interrupted: true })), /被中断/);
	const h = fakeHost(() => 'ok');
	const rs = makeRooms(h, join(dir, 'answer.json'));
	const r = await rs.create({ members: ['designer', 'coder'], name: '正文群' });
	const out = await drain(relayStream(rs, () => 'u')({ sessionId: r.id, tools: [{ name: ROOM_RELAY_TOOL }], messages: [
		{ role: 'user', source: { kind: 'user' } }, { role: 'assistant' }, tool({ replies: [{ name: 'Coder', text: '收到' }], failed: [], passed: [] })] }, () => { throw new Error('不该调模型'); }));
	assert.deepEqual(out.map(e => e.type), ['block-start', 'text-delta', 'block-end', 'finish']);
	assert.equal(out[1].text, '**Coder**：收到');
	assert.deepEqual(out.at(-1), { type: 'finish', reason: { kind: 'stop' } });
	const done = await drain(relayStream(rs, () => 'u')({ sessionId: r.id, tools: [{ name: ROOM_RELAY_TOOL }], messages: [
		{ role: 'user', source: { kind: 'user' } }, { role: 'assistant' }, tool({ replies: [] }), { role: 'assistant', content: '…' }] }, () => { throw new Error('不该调模型'); }));
	assert.deepEqual(done, [{ type: 'finish', reason: { kind: 'stop' } }], '正文写过之后就停');
});

// ── 建群 ──────────────────────────────────────────────────────────────────────
const said = [];
const host = fakeHost((botId, prompt) => {
	said.push({ botId, prompt });
	// 管理员第一次被叫时接下需求并点名 Coder；之后都沉默
	if (botId === 'designer') { return said.filter(s => s.botId === 'designer').length === 1 ? 'Designer：我出交互稿，@Coder 你来实现' : '[PASS]'; }
	if (botId === 'coder') { return '收到，用 Vue 3 写'; }
	if (botId === 'reviewer') { return '我来审查'; }
	return '[PASS]';
});
const rooms = makeRooms(host, file);
host.rooms = rooms;
installRooms(host.ctx, rooms);
let room;
await check('建群：在第一个工作区开群会话、写群标记、会话改名为群名、挂上 group_relay（只挂这一个）', async () => {
	room = await rooms.create({ members: ['designer', 'Coder', 'reviewer'], name: '番茄钟 H5', notice: '移动端优先' }, { createdBy: 'superagent' });
	const s = host.sessions.get(room.id);
	assert.equal(s.place, 'ws1');
	assert.equal(s.preset, undefined, '群会话用默认 preset（它从不调模型）');
	assert.deepEqual(s.records, [{ type: ROOM_RECORD_TYPE, data: { v: 1, roomId: room.id, role: 'room' } }]);
	assert.equal(s.title, '番茄钟 H5');
	assert.deepEqual(s.tools, [ROOM_RELAY_TOOL]);
	assert.equal(rooms.isRoom(room.id), true);
	assert.deepEqual(room.members, [{ id: 'designer', name: 'Designer' }, { id: 'coder', name: 'Coder' }, { id: 'reviewer', name: 'Code Reviewer' }]);
	assert.equal(room.admin, 'designer');
	assert.equal(room.mode, 'admin');
	assert.equal(room.sessionId, room.id);
	assert.equal(room.createdBy, 'superagent');
	assert.deepEqual((await rooms.list()).map(r => r.name), ['番茄钟 H5']);
});

await check('同名建群 ⇒ 在已有的群里编辑成员（加 / 减），不再另建；改名撞名被拒；没给群名的照常新建（真机：两个「番茄钟 H5 开发团队」）', async () => {
	const h = fakeHost(() => 'ok');
	const rs = makeRooms(h, join(dir, 'same-name.json'));
	const first = await rs.create({ members: ['designer', 'coder'], name: '番茄钟 H5 开发团队', notice: '先做骨架' }, { createdBy: 'superagent', originTriggerId: 't-1' });
	const memberSid = (await rs.get(first.id)).id;
	await rs.setFlags(first.id, { hidden: true });
	const sessionsBefore = h.sessions.size;
	const again = await rs.create({ members: ['Coder', 'reviewer'], name: '  番茄钟 h5 开发团队 ' }, { createdBy: 'superagent', originTriggerId: 't-2' });
	assert.equal(again.id, first.id, '复用同一个群');
	assert.equal(h.sessions.size, sessionsBefore, '没有开新的群会话');
	assert.equal(again.reused, true);
	assert.deepEqual(again.members.map(m => m.id), ['coder', 'reviewer']);
	assert.deepEqual([again.added, again.removed], [['Code Reviewer'], ['Designer']]);
	assert.equal(again.admin, 'coder', '原管理员被移出 ⇒ 换成第一位成员');
	assert.equal(again.notice, '先做骨架', '没给公告 ⇒ 保留原公告');
	assert.equal(again.name, '番茄钟 H5 开发团队', '群名不变');
	assert.equal(again.hidden, false, '藏起来的群重新露出来');
	assert.deepEqual((await rs.list()).map(r => r.name), ['番茄钟 H5 开发团队'], '只有一个群');
	assert.ok(memberSid);
	// 同一个 trigger 再来一次：仍按原幂等返回，不改成员
	assert.deepEqual((await rs.create({ members: ['designer', 'coder'], name: '番茄钟 H5 开发团队' }, { originTriggerId: 't-1' })).members.map(m => m.id), ['coder', 'reviewer']);
	// 管理员还在群里就留着；给了公告 / 模式才改
	const kept = await rs.create({ members: ['reviewer', 'coder', 'designer'], name: '番茄钟 H5 开发团队', notice: '改成移动端优先', mode: 'everyone' });
	assert.deepEqual([kept.admin, kept.notice, kept.mode, kept.added, kept.removed], ['coder', '改成移动端优先', 'everyone', ['Designer'], []]);
	// 成员不合法时照样报错，不动已有的群
	await assert.rejects(rs.create({ members: ['coder'], name: '番茄钟 H5 开发团队' }), /至少要有/);
	assert.equal((await rs.get(first.id)).members.length, 3);
	// 没给群名 ⇒ 照常新建
	const unnamed = await rs.create({ members: ['designer', 'coder'] });
	assert.notEqual(unnamed.id, first.id);
	assert.equal(unnamed.reused, undefined);
	// 改名撞上已有群名 ⇒ 拒绝；改成自己的名字没问题
	await assert.rejects(rs.update(unnamed.id, { name: '番茄钟 H5 开发团队' }), (error) => error.status === 409 && /已经有一个叫/.test(error.message));
	assert.equal((await rs.update(first.id, { name: '番茄钟 H5 开发团队' })).name, '番茄钟 H5 开发团队');
});

// ── 群会话的模型请求 ─────────────────────────────────────────────────────────────
await check('群会话：人刚说话 ⇒ 合成 group_relay 调用；工具结果之后 ⇒ stop；插件塞的 user 上下文不触发', async () => {
	const stream = relayStream(rooms, () => 'u-1');
	const tools = [{ name: ROOM_RELAY_TOOL }];
	const relay = await drain(stream({ sessionId: room.id, tools, messages: [{ role: 'user', source: { kind: 'user' }, content: '大家好' }] }, () => { throw new Error('不该调模型'); }));
	assert.deepEqual(relay.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
	assert.deepEqual(relay[2], { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'toolu_relay_u1', name: ROOM_RELAY_TOOL, arguments: '{}' } });
	const after = await drain(stream({ sessionId: room.id, tools, messages: [{ role: 'user', source: { kind: 'user' } }, { role: 'assistant' }, { role: 'tool' },
		{ role: 'user', source: { kind: 'time-context' } }] }, () => { throw new Error('不该调模型'); }));
	assert.deepEqual(after.map(e => e.type), ['block-start', 'text-delta', 'block-end', 'finish'], '工具结果之后写一段正文再停（回合折叠后仍可见）');
	assert.deepEqual(after.at(-1), { type: 'finish', reason: { kind: 'stop' } });
	const missing = await drain(stream({ sessionId: room.id, tools: [], messages: [{ role: 'user', source: { kind: 'user' } }] }, () => { throw new Error('不该调模型'); }));
	assert.match(missing[1].text, /群聊工具没挂上/);
	const passthrough = Symbol('next');
	assert.equal(stream({ sessionId: 'other', messages: [] }, () => passthrough), passthrough, '别的会话放行');
	assert.equal(stream({ sessionId: room.id, purpose: 'session-title', messages: [] }, () => passthrough), passthrough, '标题请求放行');
});
await check('只有人写的 user/message 进群收件箱', () => {
	assert.equal(userTextOf({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: ' hi ' }] } }), 'hi');
	assert.equal(userTextOf({ type: 'user/message', data: { source: { kind: 'plugin:x' }, content: 'x' } }), undefined);
});
await check('别的会话 @群 / 引用会话 ⇒ 真消息写进群会话（对齐 DS Bot post_to_group），同一条只投一次', async () => {
	const original = rooms.postToRoom;
	const posted = [];
	rooms.postToRoom = async function (...args) { posted.push(args); return original.apply(this, args); };
	try {
		const desk = { id: 'desk-outside' };
		const real = { type: 'user/message', data: { id: 'm-1', role: 'user', source: { kind: 'user' },
			content: [{ type: 'text', text: '@番茄钟 H5 开始制作番茄钟H5 应用' }] } };
		const reference = { type: 'user/message', data: { id: 'ref-1', role: 'user',
			source: { kind: ROOM_REFERENCE_KIND, form: 'recall', references: [{ sessionId: room.id, label: '番茄钟 H5' }] },
			content: [{ type: 'text', text: '## Referenced sessions' }] } };
		host.emit('session/event', desk, real);
		host.emit('session/event', desk, reference);
		host.emit('session/event', desk, reference);
		await new Promise(resolve => setTimeout(resolve, 15));
		assert.equal(posted.length, 1, '引用事件重复到达不重复转投');
		assert.equal(posted[0][0], room.id);
		assert.equal(posted[0][1], '开始制作番茄钟H5 应用');
		const message = host.sessions.get(room.id).inbox.at(-1);
		assert.equal(message.role, 'user');
		assert.equal(message.source.kind, 'user');
		assert.equal(message.source.form, 'room-post');
		assert.equal(message.source.fromSession, 'desk-outside');
		assert.equal(message.content[0].text, '开始制作番茄钟H5 应用');
		// DSH 落盘后的 user/message 事件会进群收件箱，群会话的 llm/stream 才有 group_relay 可合成
		host.emit('session/event', host.sessions.get(room.id), { type: 'user/message', data: message });
		const stream = relayStream(rooms, () => 'u-post');
		const chunks = await drain(stream({ sessionId: room.id, tools: [{ name: ROOM_RELAY_TOOL }],
			messages: [{ role: 'user', source: message.source, content: message.content }] }, () => { throw new Error('不该调模型'); }));
		assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
	} finally {
		rooms.postToRoom = original;
	}
});

// ── 一轮转发 ────────────────────────────────────────────────────────────────────
const tool = () => {
	const s = host.sessions.get(room.id);
	return { def: rooms.relayTool(), exec: { agent: { id: s.id }, callId: `call-${Math.random()}`, signal: new AbortController().signal } };
};
const userSays = (text) => {
	for (const fn of [host.ctx]) { void fn; }
	rooms.noteUserMessage(room.id, text);
};
let firstRound;
await check('admin 模式：人没点名 ⇒ 管理员先答；它 @ 的人接着答；回复按顺序写进本轮结果与群日志', async () => {
	userSays('做一个番茄钟 H5');
	const { def, exec } = tool();
	const running = def.execute({}, exec);
	await new Promise(resolve => setTimeout(resolve, 2));
	assert.deepEqual(rooms.progress(exec.callId).speaking, ['Designer'], '跑的过程中能看到谁在说话');
	firstRound = JSON.parse(await running);
	assert.deepEqual(firstRound.replies.map(r => [r.name, r.text]), [['Designer', '我出交互稿，@Coder 你来实现'], ['Coder', '收到，用 Vue 3 写']]);
	assert.deepEqual(firstRound.passed, []);
	assert.deepEqual(firstRound.failed, []);
	assert.deepEqual(firstRound.room, { id: room.id, name: '番茄钟 H5' });
	assert.equal(firstRound.callId, exec.callId);
	assert.equal(firstRound.done, true);
	assert.ok(firstRound.startedAt && firstRound.finishedAt >= firstRound.startedAt, '工具结果带开始/结束时间，重启后用时不会失真');
	assert.equal(firstRound.schema, ROUND_SCHEMA, '工具结果带契约版本');
	assert.equal(firstRound.status, 'done');
	assert.equal(firstRound.statusLabel, '已完成');
	assert.equal(said.filter(s => s.botId === 'reviewer').length, 0, '没被叫到的成员不说话');
	assert.match(said.find(s => s.botId === 'coder').prompt, /是Designer叫你的/);
	assert.match(said.find(s => s.botId === 'coder').prompt, /群公告（每位成员都要遵守）：\n移动端优先/);
	assert.equal(rooms.progress(exec.callId).done, true);
	assert.match((await rooms.get(room.id)).preview, /^Coder：收到/);
});
await check('执行中/刚完成的轮次可由 /api/rooms?active=1 给全局 UI 浮层轮询', async () => {
	const out = await roomsApi(rooms, { method: 'GET', query: new URLSearchParams('active=1'), body: undefined });
	assert.equal(out.status, 200);
	assert.equal(out.body.ok, true);
	assert.ok(Array.isArray(out.body.active));
	const active = out.body.active.find(item => item.roomId === room.id && Array.isArray(item.replies));
	assert.ok(active);
	const progress = await roomsApi(rooms, { method: 'GET', query: new URLSearchParams({ progress: active.callId }), body: undefined });
	assert.equal(progress.status, 200);
	assert.equal(progress.body.progress?.roomId, room.id);
});
await check('成员影子会话：按 bot preset 建、写成员标记、改名「成员 · 群」、下一轮复用；消息 kind 不会触发自动回传', async () => {
	const owner = [...host.sessions.values()].filter(s => s.records.some(r => r.data.role === 'member'));
	assert.deepEqual(owner.map(s => [s.preset, s.title, s.records[0].data.botId]), [['vssaros-designer', 'Designer · 番茄钟 H5', 'designer'], ['vssaros-coder', 'Coder · 番茄钟 H5', 'coder']]);
	assert.equal(owner.every(s => s.place === 'ws1'), true, '与群同一工作区');
	assert.equal(owner[0].inbox[0].source.kind, ROOM_TURN_KIND);
	assert.deepEqual(rooms.ownerOf(owner[1].id), { roomId: room.id, botId: 'coder' });
	const before = host.sessions.size;
	userSays('@Coder 加个暂停按钮');
	const { def, exec } = tool();
	const round = JSON.parse(await def.execute({}, exec));
	assert.deepEqual(round.replies.map(r => r.name), ['Coder'], '@ 谁叫谁');
	assert.equal(host.sessions.size, before, '复用已有影子会话');
	assert.match(said.at(-1).prompt, /新消息：\n用户：@Coder 加个暂停按钮/);
	assert.doesNotMatch(said.at(-1).prompt, /新消息：[\s\S]*做一个番茄钟/, '已读过的不再当新消息');
});
await check('everyone 模式：普通消息全员依次发言（管理员先，前一个说完下一个才开始）；沉默记 passed', async () => {
	await rooms.update(room.id, { mode: 'everyone' });
	host.order.length = 0;
	userSays('大家对配色有什么意见');
	const { def, exec } = tool();
	const round = JSON.parse(await def.execute({}, exec));
	assert.deepEqual(round.replies.map(r => r.name), ['Coder', 'Code Reviewer']);
	assert.deepEqual(round.passed, ['Designer']);
	const seq = host.order.map(o => `${o.at}:${host.sessions.get(o.session).preset}`);
	assert.deepEqual(seq.slice(0, 4), ['start:vssaros-designer', 'end:vssaros-designer', 'start:vssaros-coder', 'end:vssaros-coder'], seq.join(' '));
	assert.match(said.find(s => s.botId === 'reviewer').prompt, /你是第 3 位（共 3 位）/);
});
await check('@ 两人 ⇒ 并行（两人都开始后才有人结束）', async () => {
	host.order.length = 0;
	userSays('@Coder @Code Reviewer 一起看下');
	const { def, exec } = tool();
	const round = JSON.parse(await def.execute({}, exec));
	assert.deepEqual(round.replies.map(r => r.name).sort(), ['Code Reviewer', 'Coder']);
	assert.deepEqual(host.order.slice(0, 2).map(o => o.at), ['start', 'start']);
});
await check('超时：成员一直不回 ⇒ 记 failed 并给出原因，本轮照常结束', async () => {
	const slow = fakeHost(() => 'hang');
	const quick = makeRooms(slow, join(dir, 'slow.json'), { timeoutMs: 30 });
	installRooms(slow.ctx, quick);
	const r = await quick.create({ members: ['designer', 'coder'] });
	quick.noteUserMessage(r.id, '在吗');
	const round = JSON.parse(await quick.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-slow' }));
	assert.deepEqual(round.failed, [{ botId: 'designer', name: 'Designer', reason: '0 秒没有任何进展' }]);
	assert.equal(r.name, '你、Designer、Coder');
});
await check('状态节点：working / missed / done 单独进 events，不污染 replies；中断补 cut', async () => {
	const slow = fakeHost(() => 'hang');
	const status = makeRooms(slow, join(dir, 'status.json'), { timeoutMs: 30, workGraceMs: 5 });
	installRooms(slow.ctx, status);
	const r = await status.create({ members: ['designer', 'coder'] });
	status.noteUserMessage(r.id, '在吗');
	const round = JSON.parse(await status.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-status' }));
	const kinds = (round.events || []).map(event => event.kind);
	assert.ok(kinds.includes('working'));
	assert.ok(kinds.includes('missed'));
	assert.ok(kinds.includes('done'));
	assert.equal(round.replies.length, 0, '状态节点不混进成员回复');
	const progress = status.progress('c-status');
	assert.equal(progress.error, '');
	assert.ok(progress.events.some(event => event.kind === 'missed'));
	assert.ok(status.active().some(item => item.events.some(event => event.kind === 'done')));
	const aborted = new AbortController();
	aborted.abort();
	status.noteUserMessage(r.id, '再来一条');
	const cut = JSON.parse(await status.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-cut', signal: aborted.signal }));
	assert.ok((cut.events || []).some(event => event.kind === 'cut'));
});
await check('不是群会话调 group_relay ⇒ 如实报错，不转发', async () => {
	assert.deepEqual(JSON.parse(await rooms.relayTool().execute({}, { agent: { id: 'nope' } })), { error: '这不是群聊会话' });
});
await check('P0 幂等：同一个 originTriggerId / triggerId 重复建群只开一条会话', async () => {
	const h = fakeHost(() => '[PASS]');
	const idem = makeRooms(h, join(dir, 'idem.json'));
	installRooms(h.ctx, idem);
	const query = new URLSearchParams();
	const body = { action: 'create', members: ['designer', 'coder'], name: '幂等群', createdBy: 'superagent', triggerId: 'superagent:desk:m-fast' };
	const first = await roomsApi(idem, { method: 'POST', query, body });
	const second = await roomsApi(idem, { method: 'POST', query, body: { ...body, name: '重复请求改了名也仍复用' } });
	assert.equal(first.status, 200);
	assert.equal(second.status, 200);
	assert.equal(second.body.room.id, first.body.room.id);
	assert.equal(first.body.room.originTriggerId, 'superagent:desk:m-fast');
	assert.equal((await idem.list()).length, 1);
	assert.equal(h.sessions.size, 1);
});

// ── 改 / 置顶 / 隐藏 / 删 ──────────────────────────────────────────────────────────
await check('改名（同步会话标题）、移出成员（它的影子会话归档）、置顶、隐藏', async () => {
	const coderSession = [...host.sessions.values()].find(s => s.preset === 'vssaros-coder').id;
	let view = await rooms.update(room.id, { name: '番茄钟小组', members: ['designer', 'reviewer'], notice: '' });
	assert.equal(host.sessions.get(room.id).title, '番茄钟小组');
	assert.deepEqual(view.members.map(m => m.id), ['designer', 'reviewer']);
	assert.equal(view.notice, '');
	assert.deepEqual(host.archived, [coderSession]);
	view = await rooms.setFlags(room.id, { pinned: true });
	assert.equal(view.pinned, true);
	view = await rooms.setFlags(room.id, { hidden: true });
	assert.equal(view.hidden, true);
	view = await rooms.update(room.id, { name: '' });
	assert.equal(view.name, '你、Designer、Code Reviewer', '清空群名 ⇒ 回到按成员命名');
	await assert.rejects(rooms.update('nope', { name: 'x' }), /没有这个群/);
});
await check('落盘后重读：群、成员、标志、日志、执行轮次都在', async () => {
	await rooms.setFlags(room.id, { pinned: true });
	const saved = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(saved.version, 2);
	assert.ok(Array.isArray(saved.rounds) && saved.rounds.length > 0, '执行过程快照写进 agent-rooms.json');
	const again = makeRooms(host, file);
	const [view] = await again.list();
	assert.equal(view.id, room.id);
	assert.equal(view.pinned, true);
	assert.equal(view.hidden, true);
	assert.equal(again.isRoom(room.id), true);
	assert.match(view.preview, /：/);
	const restored = again.progress(firstRound.callId);
	assert.ok(restored, '重启后 ?progress= 仍能找到已完成的轮次');
	assert.equal(restored.done, true);
	assert.equal(restored.replies.length, firstRound.replies.length);
	assert.equal(restored.finishedAt, firstRound.finishedAt);
	const out = await roomsApi(again, { method: 'GET', query: new URLSearchParams({ progress: firstRound.callId }), body: undefined });
	assert.equal(out.body.progress?.callId, firstRound.callId);
	assert.ok(again.active().some(item => item.callId === firstRound.callId), '重启后 active 仍带出持久化的执行过程');
});

await check('执行中重启：快照写穿、旧轮次收口为 cut、已有状态节点不丢', async () => {
	const h = fakeHost(() => 'hang');
	const restartFile = join(dir, 'restart.json');
	const durable = makeRooms(h, restartFile, { timeoutMs: 50, workGraceMs: 5 });
	installRooms(h.ctx, durable);
	const r = await durable.create({ members: ['designer', 'coder'], name: '重启群' });
	durable.noteUserMessage(r.id, '继续做');
	const running = durable.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-restart', signal: new AbortController().signal });
	await new Promise(resolve => setTimeout(resolve, 8));
	const saved = JSON.parse(readFileSync(restartFile, 'utf8'));
	const snapshot = saved.rounds.find(item => item.callId === 'c-restart');
	assert.ok(snapshot, '运行中的 round 已落盘');
	assert.equal(snapshot.done, false);
	assert.ok(snapshot.events.some(event => event.kind === 'working'));
	const again = makeRooms(h, restartFile, { timeoutMs: 50, workGraceMs: 5 });
	await again.load();
	const restored = again.progress('c-restart');
	assert.ok(restored, '重启后 ?progress= 返回旧轮次');
	assert.equal(restored.done, true, '不再永远停在 running');
	assert.equal(restored.phase, 'cut');
	assert.equal(restored.status, 'cut', '服务端统一状态：重启中断 = cut（不是 failed / done）');
	assert.equal(restored.statusLabel, '已中断');
	assert.equal(restored.interrupted, true);
	assert.deepEqual(restored.speaking, [], '重启后没有活的成员回合');
	assert.ok(restored.events.some(event => event.kind === 'cut' && /重启中断/.test(event.text)));
	assert.ok(again.active().some(item => item.callId === 'c-restart' && item.interrupted), '重启后全局 UI 仍能看到被中断的轮次');
	const out = await roomsApi(again, { method: 'GET', query: new URLSearchParams('active=1'), body: undefined });
	assert.ok(out.body.active.some(item => item.callId === 'c-restart'));
	void running.catch(() => undefined);
});

await check('转投幂等：同一条来源消息只进群一次（待处理队列与已落盘历史都认），别的消息照常转投', async () => {
	const h = fakeHost(() => '收到');
	const idemFile = join(dir, 'idem-post.json'); // 别和上面「建群幂等」共用一个文件：同名群现在会被复用
	const idem = makeRooms(h, idemFile);
	const r = await idem.create({ members: ['designer', 'coder'], name: '幂等群' });
	const roomSession = h.sessions.get(r.id);
	const first = await idem.postToRoom(r.id, '开始做', { fromSession: 'desk-1', sourceMessageId: 'm-1' });
	assert.equal(first.messageId, roomPostId('desk-1', 'm-1'), 'id 由来源决定');
	assert.equal(first.duplicate, undefined);
	const again = await idem.postToRoom(r.id, '开始做', { fromSession: 'desk-1', sourceMessageId: 'm-1' });
	assert.equal(again.duplicate, true, '还在待处理队列里 ⇒ 不再投');
	assert.equal(roomSession.inbox.filter(m => m.id === first.messageId).length, 1);
	// 已被回合吃掉（离开队列、落进历史）之后再来一次（例如另一个窗口重放），同样认得
	roomSession.inbox.length = 0;
	roomSession.seq += 1;
	roomSession.events.push({ seq: roomSession.seq, type: 'user/message', data: { id: first.messageId, source: { kind: 'user' } } });
	assert.equal((await idem.postToRoom(r.id, '开始做', { fromSession: 'desk-1', sourceMessageId: 'm-1' })).duplicate, true, '历史里已有 ⇒ 不再投');
	assert.equal(roomSession.inbox.length, 0);
	const other = await idem.postToRoom(r.id, '继续', { fromSession: 'desk-1', sourceMessageId: 'm-2' });
	assert.equal(other.duplicate, undefined, '另一条来源消息照常转投');
	await idem.postToRoom(r.id, '无来源 1');
	await idem.postToRoom(r.id, '无来源 2');
	assert.equal(roomSession.inbox.length, 3, '没有来源信息的转投不做去重（各自随机 id）');
	assert.equal(holdsMessage(undefined, 'x'), false, '读不到会话 ⇒ 当作没有');
});

await check('关联 id：轮次带建群 trigger 与 @群 来源会话/消息，三处输出同口径', async () => {
	const h = fakeHost(() => '收到');
	const corrFile = join(dir, 'corr.json');
	const corr = makeRooms(h, corrFile);
	installRooms(h.ctx, corr);
	const r = await corr.create({ members: ['designer', 'coder'], name: '关联群' }, { originTriggerId: 'superagent:desk:m-corr' });
	const posted = await corr.postToRoom(r.id, '开始做', { fromSession: 'desk-1', sourceMessageId: 'm-9' });
	h.emit('session/event', h.sessions.get(r.id), { type: 'user/message', data: { id: posted.messageId, source: { kind: 'user' },
		content: [{ type: 'text', text: '开始做' }] } });
	const out = JSON.parse(await corr.relayTool().execute({}, { agent: { id: r.id }, callId: 'c-corr' }));
	assert.deepEqual([out.originTriggerId, out.fromSession, out.sourceMessageId], ['superagent:desk:m-corr', 'desk-1', 'm-9']);
	const progress = corr.progress('c-corr');
	assert.deepEqual([progress.schema, progress.originTriggerId, progress.fromSession], [ROUND_SCHEMA, 'superagent:desk:m-corr', 'desk-1']);
	assert.ok(corr.active().some(item => item.callId === 'c-corr' && item.originTriggerId === 'superagent:desk:m-corr'));
	await corr.flush();
	const disk = JSON.parse(readFileSync(corrFile, 'utf8')).rounds.find(item => item.callId === 'c-corr');
	assert.equal(disk.sourceMessageId, 'm-9', '关联 id 随快照落盘');
});

await check('持久化加固：并发改动合并写且 flush 后盘上是最终态；读到未来版本 ⇒ 只读冻结不覆盖', async () => {
	const h = fakeHost(() => '[PASS]');
	const mergeFile = join(dir, 'merge.json');
	const merged = makeRooms(h, mergeFile);
	const r = await merged.create({ members: ['designer', 'coder'], name: '合并写' });
	await Promise.all([merged.setFlags(r.id, { pinned: true }), merged.setFlags(r.id, { hidden: true })]);
	await merged.flush();
	const saved = JSON.parse(readFileSync(mergeFile, 'utf8'));
	assert.equal(saved.version, ROOMS_FILE_VERSION);
	assert.deepEqual([saved.rooms[0].pinned, saved.rooms[0].hidden], [true, true]);

	const futureFile = join(dir, 'future.json');
	const future = { version: ROOMS_FILE_VERSION + 1, rooms: [{ id: 'fx', members: ['designer', 'coder'], name: '未来群', admin: 'designer', mode: 'admin', log: [] }], extra: '新版本字段' };
	writeFileSync(futureFile, JSON.stringify(future), 'utf8');
	const warnings = [];
	const old = makeRooms(h, futureFile, { warn: (m) => warnings.push(m) });
	assert.equal((await old.list()).length, 1, '未来版本仍可读');
	await old.setFlags('fx', { pinned: true });
	await old.flush();
	assert.deepEqual(JSON.parse(readFileSync(futureFile, 'utf8')), future, '未来版本文件一字不改');
	assert.ok(warnings.some(m => /只读/.test(m)));
	assert.throws(() => readFileSync(`${futureFile}.owner`, 'utf8'), /ENOENT/, '未来版本不接管租约（否则会把新版本 Host 挤成只读）');
});

await check('单写者租约：后载入的实例接管；旧实例写前发现被接管 ⇒ 只读，不再整文件覆盖', async () => {
	const h = fakeHost(() => '[PASS]');
	const leaseRoomsFile = join(dir, 'lease.json');
	const warnings = [];
	const first = makeRooms(h, leaseRoomsFile, { warn: (m) => warnings.push(m) });
	const r = await first.create({ members: ['designer', 'coder'], name: '租约群' });
	await first.flush();
	const firstOwner = JSON.parse(readFileSync(`${leaseRoomsFile}.owner`, 'utf8'));
	assert.equal(first.storage().writable, true);
	const second = makeRooms(h, leaseRoomsFile);
	await second.load();
	const secondOwner = JSON.parse(readFileSync(`${leaseRoomsFile}.owner`, 'utf8'));
	assert.notEqual(secondOwner.token, firstOwner.token, '后载入的实例写入了自己的 token');
	await second.setFlags(r.id, { pinned: true });
	await second.flush();
	// 旧实例的内存里 pinned 仍是 false：若它还能写，就会把新实例的改动整文件盖掉
	await first.setFlags(r.id, { hidden: true });
	await first.flush();
	const disk = JSON.parse(readFileSync(leaseRoomsFile, 'utf8')).rooms.find(item => item.id === r.id);
	assert.deepEqual([disk.pinned, !!disk.hidden], [true, false], '旧实例没有覆盖新实例的数据');
	assert.deepEqual(first.storage(), { writable: false, reason: 'superseded', leaseFile: `${leaseRoomsFile}.owner` });
	assert.ok(warnings.some(m => /已接管/.test(m)), warnings.join(' | '));
	assert.equal(second.storage().writable, true);
	await second.close();
	assert.throws(() => readFileSync(`${leaseRoomsFile}.owner`, 'utf8'), /ENOENT/, '卸载时交还自己的租约');
	await first.close(); // 被接管的实例卸载不应误删别人的租约（此时已无租约，也不报错）
});

await check('被中断的轮次按群归档：超过 10 分钟仍可查、每群封顶、删群一起删；正常结束的照常过期', async () => {
	const h = fakeHost(() => '[PASS]');
	const archiveFile = join(dir, 'archive.json');
	const at = Date.now();
	const room = { id: 'ar', members: ['designer', 'coder'], name: '归档群', admin: 'designer', mode: 'admin', log: [] };
	const other = { id: 'ar2', members: ['designer', 'coder'], name: '另一群', admin: 'designer', mode: 'admin', log: [] };
	const round = (callId, roomId, minutesAgo, extra = {}) => ({ callId, roomId, replies: [{ botId: 'designer', name: 'Designer', text: `回复 ${callId}` }],
		passed: [], failed: [], events: [], speaking: [], startedAt: at - minutesAgo * 60_000 - 1000, finishedAt: at - minutesAgo * 60_000, done: true, phase: 'done', ...extra });
	const cut = (callId, roomId, minutesAgo) => round(callId, roomId, minutesAgo, { phase: 'cut', interrupted: true, error: '执行被重启打断' });
	const rounds = [
		cut('cut-old', 'ar', 60 * 24), // 一天前被打断
		round('done-old', 'ar', 30), // 30 分钟前正常结束
		...Array.from({ length: ROUNDS_ARCHIVE_PER_ROOM + 3 }, (_, i) => cut(`cut-${i}`, 'ar2', 20 + i)),
	];
	writeFileSync(archiveFile, JSON.stringify({ version: 2, rooms: [room, other], rounds }), 'utf8');
	const loaded = makeRooms(h, archiveFile);
	await loaded.load();
	const old = loaded.progress('cut-old');
	assert.ok(old, '一天前被打断的轮次仍能按 callId 查到（工具卡靠它补全回复）');
	assert.deepEqual([old.status, old.replies[0].text], ['cut', '回复 cut-old']);
	assert.equal(loaded.progress('done-old'), null, '正常结束的轮次结果在工具结果里，照常过期');
	assert.equal(loaded.active().some(item => item.callId === 'cut-old'), false, '归档轮次不再出现在活动列表里');
	const kept = [...Array(ROUNDS_ARCHIVE_PER_ROOM + 3).keys()].filter(i => loaded.progress(`cut-${i}`));
	assert.equal(kept.length, ROUNDS_ARCHIVE_PER_ROOM, '每个群最多归档 20 轮');
	assert.ok(kept.includes(0) && !kept.includes(ROUNDS_ARCHIVE_PER_ROOM + 2), '留下的是最近的');
	await loaded.remove('ar');
	assert.equal(loaded.progress('cut-old'), null, '删群时它的归档轮次一起删');
	await loaded.flush();
	assert.equal(JSON.parse(readFileSync(archiveFile, 'utf8')).rounds.some(item => item.roomId === 'ar'), false);
});

await check('持久化加固：载入时裁掉过期轮次、总数封顶，运行中（重启收口）的保留', async () => {
	const h = fakeHost(() => '[PASS]');
	const pruneFile = join(dir, 'prune.json');
	const at = Date.now();
	const done = (i, finishedAt) => ({ callId: `d${i}`, roomId: 'pr', replies: [], passed: [], failed: [], events: [], speaking: [],
		startedAt: finishedAt - 1000, finishedAt, done: true, phase: 'done' });
	const rounds = [done('old', at - 60 * 60_000), ...Array.from({ length: ROUNDS_KEEP_MAX + 10 }, (_, i) => done(i, at - i * 100)),
		{ callId: 'live', roomId: 'pr', replies: [], passed: [], failed: [], events: [], speaking: ['Coder'], startedAt: at - 5000, finishedAt: 0, done: false }];
	writeFileSync(pruneFile, JSON.stringify({ version: 2, rooms: [{ id: 'pr', members: ['designer', 'coder'], name: '裁剪', admin: 'designer', mode: 'admin', log: [] }], rounds }), 'utf8');
	const pr = makeRooms(h, pruneFile);
	await pr.load();
	await pr.flush();
	const kept = JSON.parse(readFileSync(pruneFile, 'utf8')).rounds;
	assert.ok(kept.filter(item => item.phase !== 'cut').length <= ROUNDS_KEEP_MAX, `正常结束的轮次总数封顶：${kept.length}`);
	assert.ok(kept.filter(item => item.phase === 'cut').length <= ROUNDS_ARCHIVE_PER_ROOM, '被中断的另按群归档封顶');
	assert.equal(kept.some(item => item.callId === 'dold'), false, '一小时前结束的轮次被裁掉');
	assert.ok(kept.some(item => item.callId === 'live' && item.phase === 'cut'), '运行中轮次重启收口为 cut 且保留');
	assert.equal(pr.progress('live').status, 'cut');
});
await check('删群：群会话与所有影子会话归档，记录删除', async () => {
	host.archived.length = 0;
	const sessionsOfRoom = [room.id, ...JSON.parse(readFileSync(file, 'utf8')).rooms[0] ? Object.values(JSON.parse(readFileSync(file, 'utf8')).rooms.find(r => r.id === room.id).sessions) : []];
	assert.deepEqual(await rooms.remove(room.id), { ok: true, id: room.id });
	assert.deepEqual(host.archived.sort(), sessionsOfRoom.sort());
	assert.deepEqual(await rooms.list(), []);
	assert.equal(rooms.isRoom(room.id), false);
});

// ── 团队总线 ────────────────────────────────────────────────────────────────────
await check('团队总线：没实现时 createGroup 明确报错；provideGroups 后 createGroup / listGroups 走群运行时', async () => {
	const root = {};
	const bus = teamBus(root);
	await assert.rejects(bus.createGroup({ members: ['designer', 'coder'] }), /群聊还没就绪/);
	const busHost = fakeHost(() => '[PASS]');
	const impl = makeRooms(busHost, join(dir, 'bus.json'));
	const undo = bus.provideGroups(impl);
	const made = await bus.createGroup({ members: ['designer', 'coder'], name: '主管建的群', createdBy: 'superagent', workspaceId: 'ws9', originTriggerId: 'superagent:desk:m-fast' });
	const again = await bus.createGroup({ members: ['designer', 'coder'], name: '重复请求', createdBy: 'superagent', workspaceId: 'ws9', originTriggerId: 'superagent:desk:m-fast' });
	assert.equal(made.name, '主管建的群');
	assert.equal(made.createdBy, 'superagent');
	assert.equal(made.originTriggerId, 'superagent:desk:m-fast');
	assert.equal(again.id, made.id, 'P0：同一个 trigger 复用同一个群');
	assert.equal(busHost.sessions.get(made.id).place, 'ws9');
	assert.deepEqual((await bus.listGroups()).map(r => r.id), [made.id]);
	undo();
	await assert.rejects(bus.listGroups(), /群聊还没就绪/);
	// 旧模块建的总线（HMR）也会补上群聊方法
	const legacyRoot = { [Symbol.for('vssaros.team')]: { version: 1, delegate: () => undefined } };
	assert.equal(typeof teamBus(legacyRoot).createGroup, 'function');
});

rmSync(dir, { recursive: true, force: true });
if (fails.length) {
	console.error(`rooms: ${pass} passed, ${fails.length} failed`);
	for (const f of fails) { console.error(`  ✗ ${f}`); }
	process.exit(1);
}
console.log(`rooms: ${pass} passed`);
