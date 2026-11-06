// 「主管建群 ⇒ Bots 页签出现群聊行」的行为级守卫（2026-11-05，用户要求：同 DeepSeek-Bot，可打开、可重命名等）。
//
// 一条链路从头跑到尾，只有 dsh 宿主本身是打桩的：
//   ① 服务端：vssaros-agents 的群运行时（lib/rooms.js，真实现）挂到团队总线；SuperAgent 主管按用户要求建群 ——
//      与 superagent 的 `Team.createGroup` 同一个调用（`bus.createGroup({ ...input, createdBy: 'superagent' })`，
//      工具层由 superagent 的 vitest tests/team.spec.ts 覆盖）。
//   ② 页面：chat-surface 的 `client.workspaces.js`（侧栏）与 `client.conversationViews.js`（会话视图）用**真 React 18 +
//      jsdom** 装起来；`fetch('/x/agents/api/rooms')` 直通①的 `roomsApi`（index.js 的路由用的就是它）。
//   ③ 断言到 DOM 与宿主调用：Bots 页签出现群行 → 点开 = 打开群会话 → 右键 7 项（置顶 / 标为未读 / 群设置 / 重命名群聊 /
//      复制对话 ID / 从侧栏隐藏 / 删除群聊）逐项生效；群会话不进「会话」页签；群会话里的 group_relay 卡画出成员回复；
//      「设置」页签对群会话显示群设置卡并能保存。
//
// 跑法：node dsh-plugins/check-bots-rooms.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

// ⚠ 先挂 jsdom 再动态 import React（理由见 check-sessions-workbench.mjs 文件头）
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div><div id="root2"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let React; let createRoot; let act;
try {
	React = (await import('react')).default;
	({ createRoot } = await import('react-dom/client'));
	act = React.act ?? (await import('react-dom/test-utils')).act;
} catch (e) {
	console.log('  ✗ 缺少 react / react-dom（本守卫的隐含依赖，原本靠 hoist 带来）：' + String((e && e.message) || e).split('\n')[0]);
	process.exit(1);
}

const repo = process.cwd();
const problems = [];
const ok = (name) => console.log('  ✓ ' + name);
const fail = (msg) => { problems.push(String(msg)); console.log('  ✗ ' + String(msg)); };
const eq = (name, actual, expected) => {
	const a = JSON.stringify(actual); const e = JSON.stringify(expected);
	if (a === e) { ok(name); } else { fail(name + '：期望 ' + e + '，实际 ' + a); }
};
const truthy = (name, cond, detail) => { if (cond) { ok(name); } else { fail(name + (detail ? '：' + detail : '')); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const imp = (rel) => import(pathToFileURL(join(repo, rel)).href);

// ── ① 服务端：群运行时 + 团队总线 ──────────────────────────────────────────────────
const { createRooms, installRooms, roomsApi } = await imp('dsh-plugins/vssaros-agents/lib/rooms.js');
const roomCore = await imp('dsh-plugins/vssaros-agents/lib/core/rooms.js');
const { teamBus } = await imp('dsh-plugins/vssaros-agents/lib/teamBus.js');
const ROSTER = [{ id: 'designer', name: 'Designer' }, { id: 'coder', name: 'Coder' }, { id: 'reviewer', name: 'Code Reviewer' }];
const dsh = (() => {
	const sessions = new Map();
	const listeners = new Map();
	const archived = [];
	let n = 0;
	const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) { fn(...args); } };
	const agentOf = (s) => ({
		id: s.id,
		session: { id: s.id, get seq() { return s.seq; }, snapshotEvents: (from, to) => s.events.filter(e => e.seq > from && e.seq <= to) },
		ctx: { tools: { register: (def) => { s.tools.push(def.name); return () => undefined; } } },
		followup(message) {
			setTimeout(() => {
				const botId = /^vssaros-(.+)$/.exec(s.preset ?? '')?.[1];
				const text = botId === 'designer' ? '我先出交互稿，@Coder 你来实现' : botId === 'coder' ? '收到，用 Vue 3 写' : '[PASS]';
				s.seq += 1; s.events.push({ seq: s.seq, type: 'agent/inbox/spliced', data: { inserted: [message] } });
				s.seq += 1; s.events.push({ seq: s.seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
				emit('agent/turn-stopping', { agent: { session: agentOf(s).session } });
			}, 2);
		},
	});
	return {
		sessions, archived,
		sc: {
			create: async ({ workspaceId, cwd, agentPreset }) => {
				const id = `session-${++n}`;
				sessions.set(id, { id, preset: agentPreset, place: workspaceId ?? cwd, title: '', records: [], events: [], seq: 0, tools: [] });
				return { sessionId: id, agentPreset };
			},
			rename: async ({ sessionId, title }) => { sessions.get(sessionId).title = title; return { title, seq: 1 }; },
			resolveAgent: async (id) => (sessions.has(id) ? { agent: agentOf(sessions.get(id)) } : { error: {} }),
		},
		agents: { get: (id) => (sessions.has(id) ? agentOf(sessions.get(id)) : undefined) },
		workspaces: { list: () => [{ id: 'ws-1', path: 'G:/work/proj' }], archiveSession: async (id) => { archived.push(id); } },
		append: (session, type, data) => { sessions.get(session.id).records.push({ type, data }); return 1; },
		ctx: { on: (name, fn) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => undefined; } },
	};
})();
const dir = mkdtempSync(join(tmpdir(), 'bots-rooms-'));
const rooms = createRooms({
	file: join(dir, 'agent-rooms.json'), fallbackCwd: dir, roster: async () => ROSTER, presetOf: id => `vssaros-${id}`,
	sessions: () => dsh.sc, agents: () => dsh.agents, workspaces: () => dsh.workspaces, append: async () => dsh.append, warn: () => undefined,
});
installRooms(dsh.ctx, rooms);
const busRoot = {};
const bus = teamBus(busRoot);
bus.provideGroups(rooms);

// SuperAgent 主管：用户在主管对话里说「建个群，拉 Designer 和 Coder，做番茄钟 H5」⇒ Team.createGroup 的调用
const made = await bus.createGroup({ members: ['Designer', 'Coder'], name: '番茄钟 H5', notice: '移动端优先', createdBy: 'superagent' });
eq('① 主管经团队总线建群：群名 / 成员 / 管理员 / 建群人', [made.name, made.members.map(m => m.name), made.admin, made.createdBy],
	['番茄钟 H5', ['Designer', 'Coder'], 'designer', 'superagent']);
const roomSession = dsh.sessions.get(made.id);
eq('① 群 = 一条专属会话：在工作区里、标题是群名、带群标记、挂了 group_relay', [roomSession.place, roomSession.title, roomSession.records[0]?.data, roomSession.tools],
	['ws-1', '番茄钟 H5', { v: 1, roomId: made.id, role: 'room' }, ['group_relay']]);
{
	const token = Buffer.from(JSON.stringify(made.id)).toString('base64url');
	const refEvent = { type: 'user/message', data: { source: { kind: roomCore.ROOM_REFERENCE_KIND, references: [{ sessionId: made.id, label: '番茄钟 H5' }] }, content: [{ type: 'text', text: '## Referenced sessions' }] } };
	const ref = roomCore.roomReferenceOf(refEvent, id => rooms.isRoom(id), name => rooms.roomByName(name));
	eq('① DSH 引用会话能解析到群 id，并去掉 @群名只留指令',
		[roomCore.decodeDshSessionToken(token), ref?.roomId, roomCore.stripRoomMention(`@[番茄钟 H5](dsh-session:${token}) 开始制作`, '番茄钟 H5')],
		[made.id, made.id, '开始制作']);
}

// ── ② 页面：fetch 直通 roomsApi；宿主服务打桩 ───────────────────────────────────────
const calls = { opened: [], copied: [], activated: [], requests: [] };
globalThis.fetch = async (url, init = {}) => {
	const u = new URL(String(url), 'http://localhost');
	const method = (init.method || 'GET').toUpperCase();
	calls.requests.push(`${method} ${u.pathname}${u.search}`);
	const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
	if (u.pathname === '/x/agents/api/home') {
		return json(200, { agents: ROSTER.map(b => ({ ...b, registered: true, presetId: `vssaros-${b.id}` })), home: {}, root: '' });
	}
	if (u.pathname === '/x/agents/api/rooms') {
		const out = await roomsApi(rooms, { method, query: u.searchParams, body: init.body ? JSON.parse(init.body) : undefined });
		return json(out.status, out.body);
	}
	return json(404, { error: 'not found' });
};
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (text) => { calls.copied.push(text); } }, configurable: true });
// Node 22 自带只读的全局 navigator ⇒ 换成 jsdom 的（chunk 里读的是全局 `navigator`）
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });

const loadChunk = (rel) => {
	let captured = null;
	window.__ModuleLoader__ = { load: m => { captured = m; } };
	const fakeRequire = (name) => { if (name === 'react') { return React; } throw new Error('unexpected require: ' + name); };
	new Function('window', 'require', readFileSync(join(repo, rel), 'utf8'))(window, fakeRequire);
	if (!captured) { throw new Error(rel + ' 没有调用 __ModuleLoader__.load'); }
	return captured.factory(fakeRequire);
};
const ws = loadChunk('dsh-plugins/vssaros-chat-surface/lib/client.workspaces.js');
const cv = loadChunk('dsh-plugins/vssaros-chat-surface/lib/client.conversationViews.js');
// ★ 2026-11-06 跨插件契约：真实产出（roomsApi / 工具结果 / 三个 window 事件）都按 contracts/group-activity.schema.json 校验
const contractLib = await imp('dsh-plugins/contracts/validate.mjs');
const captured = { progress: [], roomsChanged: [], dock: [] };
window.addEventListener('vssaros-group-progress', (ev) => { captured.progress.push(ev.detail); });
window.addEventListener('vssaros-rooms-changed', (ev) => { captured.roomsChanged.push(ev.detail); });
window.addEventListener('vssaros-group-composer-dock-visibility', (ev) => { captured.dock.push(ev.detail); });

// 会话摘要：群会话与成员影子会话带 vssaros-room 投影（vssaros-agents 注册的投影 wire 出来的就是这个形状）
const summaries = () => {
	const byId = { 'plain-1': { id: 'plain-1', title: '普通会话', updatedAt: 2, projectionValues: {} } };
	for (const s of dsh.sessions.values()) {
		const mark = s.records.find(r => r.type === 'plugin:vssaros/room')?.data;
		byId[s.id] = { id: s.id, title: s.title, updatedAt: 1, projectionValues: mark ? { 'vssaros-room': { roomId: mark.roomId, role: mark.role, ...(mark.botId ? { botId: mark.botId } : {}) } } : {} };
	}
	return byId;
};
const subscribers = new Set();
const ctx = {
	effect: (fn) => fn(),
	get: (name) => (name === 'workspaces' ? { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', path: 'G:/work/proj', name: 'proj', sessionIds: [...dsh.sessions.keys(), 'plain-1'] }] }), subscribe: () => () => undefined } } : undefined),
	sessions: { list: { getSnapshot: () => ({ byId: summaries() }), subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); } }, retain: async () => undefined },
	uiWorkspace: { openSession: (sid) => { calls.opened.push(sid); return Promise.resolve(); } },
	uiConversation: { binding: (sid) => ({ activate: (view) => { calls.activated.push([sid, view]); } }) },
	layout: {}, remote: {},
};
let Sidebar = null;
let GroupDock = null;
let MemberDock = null;
const slotted = [];
ctx.slots = {
	inject: (_name, cb) => cb(),
	register: (opts, comp) => {
		slotted.push(opts);
		if (opts.name === 'sidebar.workspaces') { Sidebar = comp; }
		if (opts.id === 'vssaros-group-activity') { GroupDock = comp; }
		if (opts.id === 'vssaros-group-members') { MemberDock = comp; }
		return () => undefined;
	},
};
localStorage.setItem(ws.__test.SIDEBAR_VIEW_KEY, JSON.stringify('bots'));
localStorage.setItem(ws.__test.SIDEBAR_VIEW_KEY, 'bots');
ws.install(ctx, { state: {} });
cv.install(ctx, { state: {}, bridge: {} });
truthy('② 侧栏组件注册进 sidebar.workspaces', typeof Sidebar === 'function', JSON.stringify(slotted));
truthy('② 群执行浮层注册进 shell.overlay（order 104，不与 100/101/102/103 冲突）',
	typeof GroupDock === 'function' && slotted.some(o => o.name === 'shell.overlay' && o.id === 'vssaros-group-activity' && o.order === 104), JSON.stringify(slotted));
eq('② 实时取数纯函数：/api/rooms?active=1 与 /api/rooms 分别给浮层与 Bots 行',
	[(await ws.__test.fetchRoomActivity()).active.length >= 0, (await ws.__test.fetchRoomsOnly()).rooms.some(r => r.id === made.id)], [true, true]);
eq('② P1 事件级刷新：群列表指纹只在可见字段变化时变，事件名固定',
	[ws.__test.ROOMS_CHANGED_EVENT, ws.__test.roomsSignature([{ id: 'a', name: 'A', updatedAt: 1 }]) === ws.__test.roomsSignature([{ id: 'a', name: 'A', updatedAt: 1 }]),
		ws.__test.roomsSignature([{ id: 'a', name: 'A', updatedAt: 1 }]) !== ws.__test.roomsSignature([{ id: 'a', name: 'B', updatedAt: 1 }])],
	['vssaros-rooms-changed', true, true]);
truthy('② 只读 MemberDock 注册进 conversation.input.dock（order 30，不与官方/已有条目 tie）',
	typeof MemberDock === 'function' && slotted.some(o => o.name === 'conversation.input.dock' && o.id === 'vssaros-group-members' && o.order === 30), JSON.stringify(slotted));
eq('② 群进度事件名两端一致、状态节点文案可读',
	[ws.__test.GROUP_PROGRESS_EVENT, cv.__test.GROUP_PROGRESS_EVENT, cv.__test.statusNodeText({ kind: 'missed' }), cv.__test.statusNodeText({ kind: 'working', text: 'Coder 开始做了' })],
	['vssaros-group-progress', 'vssaros-group-progress', '成员没能按时回答', 'Coder 开始做了']);
eq('② composer dock 可见性事件两端一致',
	[ws.__test.GROUP_DOCK_VISIBILITY_EVENT, cv.__test.GROUP_DOCK_VISIBILITY_EVENT],
	['vssaros-group-composer-dock-visibility', 'vssaros-group-composer-dock-visibility']);
{
	const flow = cv.__test.groupComposerFlowOf([{ roomId: made.id, roomName: '番茄钟 H5', done: false, startedAt: Date.now() - 1000, finishedAt: 0,
		speaking: ['Coder'], replies: [], events: [{ kind: 'working', name: 'Coder', text: 'Coder 开始做了' }], failed: [], passed: [] }],
	{ roomId: made.id, role: 'room' });
	eq('② composer 活动行纯函数：群会话运行状态、typing、shimmer，提示说群语义',
		[flow.state, flow.role, flow.activityKind, flow.activity.includes('正在输入'), flow.queueHint.includes('本轮结束后')],
		['running', 'room', 'typing', true, true]);
	// 官方空草稿 Enter 什么都不做（插话是 Cmd/Ctrl+Enter，且随 busyEnter 设置变）⇒ 我们不再写按键，只说群语义
	const hint = cv.__test.groupComposerHintOf;
	eq('② composer 提示：按角色说群语义、不写按键；与群无关的会话不提示', [
		/Enter/.test(hint('room', true) + hint('room', false) + hint('member', true) + hint('member', false)),
		hint('member', true).includes('插话') && hint('member', true).includes('不进群聊'),
		hint('member', false).includes('不会转到群里'),
		hint('observer', true), hint('observer', false),
	], [false, true, true, '', '']);
}
// ── ②-契约 2026-11-06：一个状态机、一份广播契约（agents core / 两个 chat-surface chunk 逐字副本必须一致）──
{
	// ⚠ 与 vssaros-superagent/dev/tests/panel-work.spec.tsx 的用例表保持同一组输入与期望
	const cases = [
		[{ done: false, speaking: [] }, 'sent'],
		[{ done: false, speaking: ['Coder'] }, 'replying'],
		[{ done: true }, 'done'],
		[{ done: true, error: 'x' }, 'failed'],
		[{ done: true, error: '执行被重启打断', interrupted: true }, 'cut'],
		[{ done: true, events: [{ kind: 'cut' }] }, 'cut'],
		[{ done: true, phase: 'cut' }, 'cut'],
		[null, 'sent'],
	];
	const expected = cases.map(([, want]) => want);
	eq('②-契约 统一状态机：agents core / workspaces / conversationViews 三处对同一用例表结论一致', [
		cases.map(([input]) => roomCore.roundStatusOf(input)),
		cases.map(([input]) => ws.__test.groupRoundStatus(input)),
		cases.map(([input]) => cv.__test.groupRoundStatus(input)),
	], [expected, expected, expected]);
	eq('②-契约 状态文案三处一致（服务端 ROUND_STATUS_LABELS 为准）',
		[ws.__test.GROUP_ROUND_LABELS, cv.__test.GROUP_ROUND_LABELS],
		[{ ...roomCore.ROUND_STATUS_LABELS }, { ...roomCore.ROUND_STATUS_LABELS }]);
	eq('②-契约 广播 schema 与服务端 ROUND_SCHEMA 同值', ws.__test.GROUP_ACTIVITY_SCHEMA, roomCore.ROUND_SCHEMA);
	const normalized = ws.__test.normalizeGroupActivity([{ roomId: 'r1', done: true, interrupted: true, error: 'x' }, { bogus: 1 }, null]);
	eq('②-契约 广播归一化：丢坏项、补 status/statusLabel/数组字段',
		[normalized.length, normalized[0].status, normalized[0].statusLabel, Array.isArray(normalized[0].replies)], [1, 'cut', '已中断', true]);
	const base = [{ callId: 'c', roomId: 'r', status: 'replying', replies: [], events: [], speaking: ['A'], failed: [], passed: [] }];
	const at = 1_000_000;
	eq('②-契约 活动指纹：内容不变不重发；回复/状态变化即重发；运行中至多每 5s 刷新一次', [
		ws.__test.activitySignature(base, at) === ws.__test.activitySignature(base, at + 4000),
		ws.__test.activitySignature(base, at) === ws.__test.activitySignature(base, at + 6000),
		ws.__test.activitySignature(base, at) === ws.__test.activitySignature([{ ...base[0], replies: [{ name: 'A' }] }], at),
		ws.__test.activitySignature([{ ...base[0], status: 'done' }], at) === ws.__test.activitySignature([{ ...base[0], status: 'done' }], at + 60_000),
	], [true, false, false, true]);
	const cutFlow = cv.__test.groupComposerFlowOf([{ roomId: made.id, done: true, interrupted: true, error: '执行被重启打断',
		replies: [{ name: 'Coder', text: 'x' }], events: [{ kind: 'cut' }], speaking: [], failed: [], passed: [] }], { roomId: made.id, role: 'room' });
	eq('②-契约 composer 活动行：重启中断显示「被中断」而不是「执行失败」',
		[cutFlow.state, cutFlow.status, cutFlow.activity.includes('被中断')], ['cut', 'cut', true]);
	const cutBot = ws.__test.botStateOf([{ roomId: made.id, done: true, interrupted: true, error: '执行被重启打断', replies: [], events: [{ kind: 'cut', text: '群聊本轮被重启中断' }],
		speaking: [], failed: [], passed: [] }], { id: 'designer', name: 'Designer' }, [{ id: made.id, members: [{ id: 'designer', name: 'Designer' }] }]);
	eq('②-契约 Bots 行：中断轮次里的成员显示 alert「本轮被中断」', [cutBot.state, cutBot.eventKind], ['alert', 'cut']);
}

const container = document.getElementById('root');
const root = createRoot(container);
const settle = async (ms = 30) => { await act(async () => { await tick(ms); }); };
await act(async () => { root.render(React.createElement(Sidebar, { wide: true })); await tick(30); });
const q = (sel) => container.querySelector(sel);
const qa = (sel) => [...container.querySelectorAll(sel)];
const mouse = async (el, type, init = {}) => { await act(async () => { el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 60, ...init })); await tick(30); }); };
// 切到 Bots 页签（默认页签可能是「会话」）
const botsTab = qa('[data-vssaros-sidebar-tabs] button, .vssaros-ws-tab').find(b => /Bots/.test(b.textContent || ''));
if (botsTab && botsTab.getAttribute('data-on') !== '1') { await mouse(botsTab, 'click'); }
await settle(60);
const row = () => q(`[data-vssaros-room="${made.id}"]`);

// ── ③ Bots 页签：群行 ───────────────────────────────────────────────────────────────
truthy('③ Bots 页签出现「群聊」分段与群行', !!row() && /群聊/.test(container.textContent || ''), (container.textContent || '').slice(0, 300));
truthy('③ 群行显示群名、「群」标记与成员数', /番茄钟 H5/.test(row()?.textContent || '') && /群/.test(row()?.textContent || '') && /2 位成员/.test(row()?.textContent || ''), row()?.textContent);
eq('③ 群行排在 bot 行之前', qa('[data-vssaros-room], [data-vssaros-bot]').map(el => el.hasAttribute('data-vssaros-room') ? 'room' : 'bot')[0], 'room');
await mouse(row(), 'click');
eq('③ 点群行 ⇒ 中栏打开群会话（群 id 就是会话 id）', calls.opened.at(-1), made.id);

// 「会话」页签不列群会话（纯函数 = 渲染用的同一个 buildSidebar）
const built = ws.__test.buildSidebar({ workspaces: [{ workspaceId: 'ws-1', path: 'G:/work/proj', sessionIds: [made.id, 'plain-1'] }], records: [], sessionsById: summaries(), archivedIds: [], currentSessionId: null, pinnedIds: [], orderMap: {} });
eq('③ 群会话不进「会话」页签（只在 Bots 页签的群行里）', built.flatMap(r => r.sessions.map(s => s.id)), ['plain-1']);

// ── ④ 右键菜单 7 项 ─────────────────────────────────────────────────────────────────
const openMenu = async () => { await mouse(row(), 'contextmenu'); return q('[data-vssaros-room-menu]'); };
const menuItem = (act) => q(`[data-vssaros-room-menu] [data-act="room-${act}"]`);
let menu = await openMenu();
eq('④ 右键 ⇒ 菜单 7 项，顺序与 DeepSeek-Bot 一致', [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map(b => b.textContent),
	['置顶', '标为未读', '群设置', '重命名群聊', '复制对话 ID', '从侧栏隐藏', '删除群聊']);
eq('④ 菜单分 4 组（3 条分隔线）', menu ? menu.children.length - 7 : -1, 3);

await mouse(menuItem('pin'), 'mousedown');
await settle(80);
truthy('④ 置顶 ⇒ 服务端置顶、行上出现「置顶」', (await rooms.get(made.id)).pinned === true && /置顶/.test(row()?.textContent || ''));
menu = await openMenu();
eq('④ 已置顶的群菜单第一项是「取消置顶」', menuItem('pin')?.textContent, '取消置顶');

await mouse(menuItem('unread'), 'mousedown');
await settle();
truthy('④ 标为未读 ⇒ 行上出现未读点', !!row()?.querySelector('[data-vssaros-room-unread]'));
await mouse(row(), 'click');
truthy('④ 打开群 ⇒ 未读清掉', !row()?.querySelector('[data-vssaros-room-unread]'));

await openMenu();
await mouse(menuItem('rename'), 'mousedown');
await settle();
const input = q(`[data-vssaros-room-rename="${made.id}"]`);
truthy('④ 重命名群聊 ⇒ 行内出现改名输入框', !!input);
if (input) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '番茄钟小组');
		input.dispatchEvent(new window.Event('input', { bubbles: true }));
		await tick(10);
	});
	await act(async () => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(80); });
	await settle(80);
}
eq('④ 回车提交 ⇒ 服务端群名、群会话标题、行上文字都变了', [(await rooms.get(made.id)).name, dsh.sessions.get(made.id).title, /番茄钟小组/.test(row()?.textContent || '')], ['番茄钟小组', '番茄钟小组', true]);

await openMenu();
await mouse(menuItem('copy'), 'mousedown');
await settle();
eq('④ 复制对话 ID ⇒ 剪贴板里是群会话 id', calls.copied.at(-1), made.id);

await openMenu();
await mouse(menuItem('settings'), 'mousedown');
await settle(450);
eq('④ 群设置 ⇒ 打开群会话并直接落在「设置」页签', [calls.opened.at(-1), JSON.parse(localStorage.getItem('dsh.conversation.' + made.id) || '{}').view, calls.activated.at(-1)],
	[made.id, 'vssaros-bot-settings', [made.id, 'vssaros-bot-settings']]);

await openMenu();
await mouse(menuItem('hide'), 'mousedown');
await settle(80);
truthy('④ 从侧栏隐藏 ⇒ 服务端 hidden、群行消失', (await rooms.get(made.id)).hidden === true && !row());
await rooms.setFlags(made.id, { hidden: false });
await mouse(q('[data-vssaros-bots-refresh]'), 'click');
await settle(80);
truthy('④ 取消隐藏后刷新 ⇒ 群行回来', !!row());

// ── ⑤ 群会话里：一轮转发的回复卡 + 「设置」页签的群设置卡 ─────────────────────────────
rooms.noteUserMessage(made.id, '做一个番茄钟 H5');
const result = await rooms.relayTool().execute({}, { agent: { id: made.id }, callId: 'call-1' });
const relayRoot = createRoot(document.getElementById('root2'));
await act(async () => {
	relayRoot.render(React.createElement(cv.__test.GroupRelayView, { phase: 'result', callId: 'call-1', block: { content: [{ type: 'text', text: result }] } }));
	await tick(20);
});
const relayEl = document.getElementById('root2');
eq('⑤ 群会话里 group_relay 卡：管理员先答、它 @ 的成员接着答', [...relayEl.querySelectorAll('[data-vssaros-group-reply]')].map(el => el.getAttribute('data-vssaros-group-reply')), ['designer', 'coder']);
truthy('⑤ 回复卡显示成员名与原话', /Designer/.test(relayEl.textContent) && /我先出交互稿，@Coder 你来实现/.test(relayEl.textContent) && /收到，用 Vue 3 写/.test(relayEl.textContent), relayEl.textContent);
// ★ 2026-11-06（用户报「对话 UI 中 markdown 内容没有正确显示」：成员回复按纯文本显示，`**` / 反引号 / 列表符原样露出）
{
	const mdRoot = createRoot(document.getElementById('root2').appendChild(document.createElement('div')));
	const sample = [
		'已按 review 修掉，代码在 `pomodoro-h5/` 子项目。',
		'',
		'**修的内容（对照 review 条目）**',
		'- **Critical** `styles.css:35-39` 补 `[hidden]{display:none!important}`',
		'- **Minor 4** `src/ui.js` 同步',
		'  - 嵌套一层',
		'',
		'1. **Critical** —— 原先没有 `[hidden]` 规则',
		'2. **Important** —— `computeList` 子串误判',
		'',
		'✅ **已对齐**：设计令牌逐字一致',
		'① 默认只显任务页',
		'② 未触发时不可见',
		'',
		'| 项 | 结果 |',
		'|---|---|',
		'| npm test | **25** 通过 |',
		'',
		'```js',
		'const a = "**不是粗体**";',
		'```',
		'',
		'> 引用 *斜体*',
		'',
		'[文档](https://example.com/a) [坏链接](javascript:alert(1)) ~~删掉~~',
	].join('\n');
	await act(async () => { mdRoot.render(React.createElement('div', { 'data-md-probe': '1' }, cv.__test.markdownNodes(sample))); await tick(10); });
	const box = document.querySelector('[data-md-probe]');
	const texts = (sel) => [...box.querySelectorAll(sel)].map(el => el.textContent);
	eq('⑤-md 粗体 / 行内代码 / 列表 / 有序列表 / 表格 / 代码块 / 引用 都渲染成元素，标记符不露出', [
		texts('strong').slice(0, 5),
		texts('code').slice(0, 3),
		box.querySelectorAll('ul > li').length, box.querySelectorAll('ul ul > li').length, box.querySelectorAll('ol > li').length,
		texts('th'), texts('td'),
		box.querySelector('pre code')?.textContent,
		box.querySelector('blockquote em')?.textContent,
		/\*\*|`/.test([...box.childNodes].filter(el => el.tagName !== 'PRE').map(el => el.textContent).join('')),
	], [
		['修的内容（对照 review 条目）', 'Critical', 'Minor 4', 'Critical', 'Important'],
		['pomodoro-h5/', 'styles.css:35-39', '[hidden]{display:none!important}'],
		3, 1, 2,
		['项', '结果'], ['npm test', '25 通过'],
		'const a = "**不是粗体**";',
		'斜体',
		false,
	]);
	const para = [...box.querySelectorAll('p')].find(p => p.textContent.includes('已对齐'));
	eq('⑤-md CJK 粗体照样加粗；段内换行保留成 <br>', [para?.querySelector('strong')?.textContent, para?.querySelectorAll('br').length], ['已对齐', 2]);
	eq('⑤-md 链接只放行 http(s) / mailto：javascript: 原样显示、不产生 <a>', [
		[...box.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('rel')]),
		box.textContent.includes('[坏链接](javascript:alert(1))'),
		box.querySelector('del')?.textContent,
	], [[['文档', 'https://example.com/a', 'noopener noreferrer']], true, '删掉']);
	const raw = 'x'.repeat(60001);
	eq('⑤-md 超长文本按纯文本显示（不卡渲染）', cv.__test.markdownNodes(raw)[0].props.children.length, 60001);
	const mdCard = document.querySelector('[data-md-probe]').parentElement;
	const mdBlock = { content: [{ type: 'text', text: JSON.stringify({ replies: [{ botId: 'coder', name: 'Coder', ms: 19000, text: '**修的内容**\n- `npm test` 通过' }], passed: [], failed: [] }) }] };
	await act(async () => { mdRoot.render(React.createElement(cv.__test.GroupRelayView, { phase: 'result', callId: 'call-md', block: mdBlock })); await tick(20); });
	const reply = mdCard.querySelector('[data-vssaros-group-reply="coder"] [data-vssaros-md]');
	eq('⑤-md 群工具卡里成员回复的正文按 Markdown 渲染（真渲染 GroupRelayView）',
		[reply?.querySelector('strong')?.textContent, reply?.querySelector('li code')?.textContent, /\*\*|`/.test(reply?.textContent ?? '')], ['修的内容', 'npm test', false]);
	await act(async () => { mdRoot.unmount(); });
}
truthy('⑤ 群工具卡有明确完成态（DS Bot 的 turnTail / done 状态节点同用途）',
	!!relayEl.querySelector('[data-vssaros-group-relay="done"]') && /群聊本轮已完成/.test(relayEl.textContent), relayEl.textContent);
{
	const statusBlock = { content: [{ type: 'text', text: JSON.stringify({ replies: [], passed: [], failed: [],
		events: [{ kind: 'working', text: 'Coder 开始做了' }, { kind: 'missed', text: 'Designer 没能按时回答' }, { kind: 'done', text: '群聊本轮完成' }] }) }] };
	await act(async () => {
		relayRoot.render(React.createElement(cv.__test.GroupRelayView, { phase: 'result', callId: 'call-status', block: statusBlock }));
		await tick(20);
	});
	truthy('⑤ 状态节点 working / missed / done 独立渲染，不混成成员气泡',
		!!relayEl.querySelector('[data-vssaros-group-relay-status-node="missed"]')
		&& /Designer 没能按时回答/.test(relayEl.textContent)
		&& relayEl.querySelectorAll('[data-vssaros-group-reply]').length === 0, relayEl.textContent);
	}
	{
		const startedAt = Date.now() - 9_000, finishedAt = startedAt + 9_000;
		const body = { room: { id: made.id, name: '番茄钟 H5' }, callId: 'call-restart',
			replies: [{ botId: 'designer', name: 'Designer', text: '重启前已落盘的回复', ms: 1200 }], passed: [], failed: [],
			events: [{ kind: 'working', text: 'Designer 开始做了' }, { kind: 'cut', text: '群聊本轮被重启中断' }],
			startedAt, finishedAt, done: true, phase: 'cut', interrupted: true, error: '执行被重启打断' };
		const block = { content: [{ type: 'text', text: JSON.stringify(body) }] };
		const parsed = cv.__test.parseRelayResult(block);
		eq('⑤ 工具结果纯函数保留重启恢复元数据', [parsed.interrupted, parsed.phase, parsed.finishedAt, parsed.replies.length],
			[true, 'cut', finishedAt, 1]);
		await act(async () => {
			relayRoot.render(React.createElement(cv.__test.GroupRelayView, { phase: 'result', callId: 'call-restart', block }));
			await tick(20);
		});
		truthy('⑤ 重启后 group_relay 工具卡从持久结果重绘：已落盘回复 / cut / 正确用时',
			!!relayEl.querySelector('[data-vssaros-group-reply="designer"]')
			&& !!relayEl.querySelector('[data-vssaros-group-relay-status-node="cut"]')
			&& !!relayEl.querySelector('[data-vssaros-group-relay-interrupted="1"]')
			&& /重启前已落盘的回复/.test(relayEl.textContent)
			&& /群聊本轮被中断/.test(relayEl.textContent)
			&& /用时 9s/.test(relayEl.textContent), (relayEl.textContent || '').slice(0, 400));
	}
const activeOut = await roomsApi(rooms, { method: 'GET', query: new URLSearchParams('active=1'), body: undefined });
truthy('⑤ /api/rooms?active=1 给全局浮层提供刚完成的群轮次',
	activeOut.body.active.some(item => item.roomId === made.id && item.done === true), JSON.stringify(activeOut.body).slice(0, 300));
const dockHost = document.createElement('div');
document.body.appendChild(dockHost);
const dockRoot = createRoot(dockHost);
const progressBefore = captured.progress.length;
await act(async () => { dockRoot.render(React.createElement(GroupDock)); await tick(80); });
{
	const realBroadcasts = captured.progress.slice(progressBefore);
	const progressOut = await roomsApi(rooms, { method: 'GET', query: new URLSearchParams('progress=call-1'), body: undefined });
	const missingOut = await roomsApi(rooms, { method: 'GET', query: new URLSearchParams('progress=call-no-such'), body: undefined });
	eq('⑤-契约 真实产出全部符合 contracts/group-activity.schema.json：?active=1 / ?progress= / 查不到 / 工具结果 / 浮层真实广播', [
		contractLib.check('activeResponse', activeOut.body),
		contractLib.check('progressResponse', progressOut.body),
		contractLib.check('progressResponse', missingOut.body),
		contractLib.check('relayResult', JSON.parse(result)),
		realBroadcasts.length > 0, realBroadcasts.flatMap(detail => contractLib.check('progressEvent', detail)),
		contractLib.check('round', contractLib.contract.examples.round),
	], [[], [], [], [], true, [], []]);
	eq('⑤-契约 契约里的版本 / 状态词表与 agents core 一致',
		[contractLib.contract.version, contractLib.contract.statuses], [roomCore.ROUND_SCHEMA, [...roomCore.ROUND_STATUSES]]);
	eq('⑤-契约 校验器自身能抓出不合约的数据', [
		contractLib.check('round', { ...contractLib.contract.examples.round, status: 'finished' }).length > 0,
		contractLib.check('progressEvent', { active: [] }).length > 0,
	], [true, true]);
}
const currentRoomName = (await rooms.get(made.id)).name;
truthy('⑤ 全局浮层：不打开群也能看到「已发到群 / 已完成 / 回复数」，对齐 DS Bot GroupEvent + roomProgress',
	!!dockHost.querySelector('[data-vssaros-group-activity="1"]') && (dockHost.textContent || '').includes(`已发到「${currentRoomName}」`) && /已完成/.test(dockHost.textContent || ''), (dockHost.textContent || '').slice(0, 300));
const openRoomBtn = dockHost.querySelector('[data-act="open-room"]');
await act(async () => { if (openRoomBtn) { openRoomBtn.click(); } await tick(20); });
eq('⑤ 点浮层「打开群聊」⇒ 打开目标群会话（DS Bot GroupEvent 同款入口）', calls.opened.at(-1), made.id);
truthy('⑤ 同一 window 只有一个活动轮询器（热重载/重复挂载由后来者接管）', !!window.__vssarosGroupActivityPoller);
await act(async () => {
	window.dispatchEvent(new window.CustomEvent(ws.__test.GROUP_PROGRESS_EVENT, { detail: { schema: 1, seq: 99, active: [{
		callId: 'call-cut-ui', roomId: 'room-cut-ui', roomName: '中断群', done: true, interrupted: true, error: '执行被重启打断',
		startedAt: Date.now() - 5000, finishedAt: Date.now(), replies: [], events: [{ kind: 'cut', text: '群聊本轮被重启中断' }], speaking: [], failed: [], passed: [] }] } }));
	await tick(20);
});
const cutRow = dockHost.querySelector('[data-vssaros-group-activity-room="room-cut-ui"]');
truthy('⑤ 右栏浮层：重启中断的轮次显示「已中断」（不再显示成「执行失败」或「已完成」）',
	cutRow?.getAttribute('data-vssaros-group-activity-round-status') === 'cut'
	&& /已中断/.test(cutRow?.querySelector('[data-vssaros-group-activity-status]')?.textContent || ''), (dockHost.textContent || '').slice(0, 300));
{
	const lostHost = document.createElement('div');
	document.body.appendChild(lostHost);
	const lostRoot = createRoot(lostHost);
	await act(async () => {
		lostRoot.render(React.createElement(cv.__test.GroupRelayView, { phase: 'call', callId: 'call-never-existed', lostAfterPolls: 2, pollMs: 10 }));
		await tick(20);
	});
	// 条件等待（≤3s），不用固定睡眠：机器忙时轮询间隔会被拉长
	for (let i = 0; i < 150 && !lostHost.querySelector('[data-vssaros-group-relay="lost"]'); i += 1) {
		await act(async () => { await tick(20); });
	}
	truthy('⑤ 工具卡：进度连续拿不到（重启前的旧调用）⇒ 收口为「执行状态已丢失」并停止轮询，不再永远「正在交给群成员」',
		!!lostHost.querySelector('[data-vssaros-group-relay="lost"]')
		&& /执行状态已丢失/.test(lostHost.textContent || '')
		&& !/正在把消息交给群成员/.test(lostHost.textContent || '')
		&& !/没有叫到任何成员/.test(lostHost.textContent || ''), (lostHost.textContent || '').slice(0, 300));
	const before = calls.requests.filter(r => /progress=call-never-existed/.test(r)).length;
	await act(async () => { await tick(80); });
	eq('⑤ 工具卡：判定丢失后不再继续轮询', calls.requests.filter(r => /progress=call-never-existed/.test(r)).length, before);
	await act(async () => { lostRoot.unmount(); });
}
{
	// DSH 重启后给悬空调用补的收尾结果（dsh-session repair 原文），不是我们的 JSON
	const closer = { isError: true, content: [{ type: 'text', text: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics.' }] };
	eq('⑤ 工具卡：认得 DSH 的「被打断」收尾结果，不把我们自己的 JSON / 普通错误误判',
		[cv.__test.isHostInterruptedResult(closer), cv.__test.isHostInterruptedResult({ content: [{ type: 'text', text: '{"replies":[]}' }] }),
			cv.__test.isHostInterruptedResult(null), cv.__test.parseRelayResult(closer)],
		[true, false, false, null]);
	const cutHost = document.createElement('div');
	document.body.appendChild(cutHost);
	const cutRoot = createRoot(cutHost);
	await act(async () => {
		cutRoot.render(React.createElement(cv.__test.GroupRelayView, { phase: 'result', block: closer, callId: 'call-closed-by-host', lostAfterPolls: 2, pollMs: 10 }));
		await tick(20);
	});
	for (let i = 0; i < 150 && !/被重启打断/.test(cutHost.textContent || ''); i += 1) { await act(async () => { await tick(20); }); }
	truthy('⑤ 工具卡：DSH 收尾结果且查不到归档 ⇒ 显示「被重启打断」（cut），不是「状态丢失」也不是英文错误',
		/群聊本轮被重启打断/.test(cutHost.textContent || '')
		&& cutHost.querySelector('[data-vssaros-group-relay-round-status]')?.getAttribute('data-vssaros-group-relay-round-status') === 'cut'
		&& !/执行状态已丢失|interrupted after it was recorded/.test(cutHost.textContent || ''), (cutHost.textContent || '').slice(0, 300));
	await act(async () => { cutRoot.unmount(); });
}
truthy('⑤ 成员影子会话不进「会话」页签', ws.__test.buildSidebar({ workspaces: [{ workspaceId: 'ws-1', path: 'G:/w', sessionIds: [...dsh.sessions.keys()] }], records: [], sessionsById: summaries(), archivedIds: [], currentSessionId: null, pinnedIds: [], orderMap: {} })
	.every(r => r.sessions.length === 0));

const said = [];
await act(async () => {
	relayRoot.render(React.createElement(cv.__test.SettingsView, { sessionId: made.id, __vssarosCtx: ctx, __vssarosSay: (t) => said.push(t) }));
	await tick(80);
});
await act(async () => { await tick(80); });
const card = relayEl.querySelector(`[data-vssaros-room-settings="${made.id}"]`);
truthy('⑤ 群会话的「设置」页签 ⇒ 群设置卡（群名 / 公告 / 谁来回答 / 成员）', !!card && !!card.querySelector('[data-vssaros-room-notice]') && card.querySelectorAll('[data-vssaros-room-member]').length === 2, relayEl.textContent.slice(0, 200));
if (card) {
	const radio = card.querySelector('[data-vssaros-room-mode="everyone"] input');
	await act(async () => { radio.click(); await tick(10); });
	await act(async () => { card.querySelector('[data-act="room-save"]').click(); await tick(80); });
	await act(async () => { await tick(80); });
	eq('⑤ 群设置卡改「谁来回答」并保存 ⇒ 服务端生效', [(await rooms.get(made.id)).mode, said.at(-1)], ['everyone', '群设置已保存']);
}

// ── ⑤-b P1：群列表变化事件 ⇒ Bots 页签立刻刷新，不等 2s 轮询 ──────────────────────────
{
	const listed = await roomsApi(rooms, { method: 'GET', query: new URLSearchParams(), body: undefined });
	const original = listed.body.rooms || [];
	const changed = original.map(r => ({ ...r, name: '群聊即时刷新', preview: 'Coder：事件已到', updatedAt: Date.now() }));
	await act(async () => {
		window.dispatchEvent(new window.CustomEvent(ws.__test.ROOMS_CHANGED_EVENT, { detail: { schema: 1, rooms: changed } }));
		await tick(30);
	});
	truthy('⑤-b 收到 vssaros-rooms-changed ⇒ 群行立刻改名/更新 preview', /群聊即时刷新/.test(row()?.textContent || ''), row()?.textContent);
	await act(async () => {
		window.dispatchEvent(new window.CustomEvent(ws.__test.ROOMS_CHANGED_EVENT, { detail: { schema: 1, rooms: original } }));
		await tick(30);
	});
	truthy('⑤-b 恢复原群列表后群行回到当前群名', (row()?.textContent || '').includes(currentRoomName), row()?.textContent);
}

// ── ⑤-c 只读 MemberDock：composer dock 显示成员状态胶囊和状态节点，没有审批/停止按钮 ──────
const memberHost = document.createElement('div');
document.body.appendChild(memberHost);
const memberRoot = createRoot(memberHost);
await act(async () => {
	memberRoot.render(React.createElement(MemberDock, { sessionId: made.id }));
	await tick(20);
});
await act(async () => {
	window.dispatchEvent(new window.CustomEvent(cv.__test.GROUP_PROGRESS_EVENT, { detail: { active: [{
		callId: 'call-member', roomId: made.id, roomName: currentRoomName, done: false, startedAt: Date.now() - 1000, finishedAt: 0, error: '',
		speaking: ['Coder'], replies: [{ name: 'Designer', text: '我先出稿' }], passed: [], failed: [],
		events: [{ kind: 'working', name: 'Coder', text: 'Coder 开始做了' }],
	}] } }));
	await tick(30);
});
truthy('⑤-c MemberDock 显示「正在输入 / 已回复 / working 状态节点」且不含按钮',
	!!memberHost.querySelector('[data-vssaros-group-member-dock="1"]')
	&& !!memberHost.querySelector('[data-vssaros-group-member="Coder"][data-vssaros-group-member-state="speaking"]')
	&& !!memberHost.querySelector('[data-vssaros-group-member="Designer"][data-vssaros-group-member-state="replied"]')
	&& !!memberHost.querySelector('[data-vssaros-group-member-event="working"]')
	&& !memberHost.querySelector('button'), (memberHost.textContent || '').slice(0, 300));
const groupFlowCss = String(document.head.querySelector('[data-vssaros-group-flow-style]')?.textContent || '');
truthy('⑤-c 群会话 composer dock 注入 DS Bot 式活动行、shimmer 与群语义提示',
	/vssaros-group-flow-shimmer/.test(groupFlowCss) && /prefers-reduced-motion/.test(groupFlowCss)
	&& !!memberHost.querySelector('[data-vssaros-group-composer-flow="1"][data-vssaros-group-composer-role="room"]')
	&& !!memberHost.querySelector('[data-vssaros-group-composer-activity="typing"]')
	&& !!memberHost.querySelector('[data-vssaros-group-composer-activity-text]')
	&& (memberHost.querySelector('[data-vssaros-group-composer-queue-hint-text]')?.textContent || '').includes('本轮结束后'),
	(memberHost.textContent || '').slice(0, 400));
{
	const member = [...dsh.sessions.values()].find((s) => s.records.find((r) => r.type === 'plugin:vssaros/room')?.data?.role === 'member');
	truthy('⑤-c 找到 bot 影子会话用于验证 composer 活动行', !!member, JSON.stringify([...dsh.sessions.keys()]));
	await act(async () => {
		memberRoot.render(React.createElement(MemberDock, { sessionId: member.id }));
		await tick(20);
		window.dispatchEvent(new window.CustomEvent(cv.__test.GROUP_PROGRESS_EVENT, { detail: { active: [{
			callId: 'call-member-role', roomId: made.id, roomName: currentRoomName, done: false, startedAt: Date.now() - 1000, finishedAt: 0, error: '',
			speaking: ['Coder'], replies: [], passed: [], failed: [], events: [{ kind: 'working', name: 'Coder', text: 'Coder 开始做了' }],
		}] } }));
		await tick(30);
	});
	truthy('⑤-c bot 影子会话 composer dock 显示 member 角色与当前群活动行',
		!!memberHost.querySelector('[data-vssaros-group-composer-flow="1"][data-vssaros-group-composer-role="member"]')
		&& (memberHost.textContent || '').includes('Coder 正在输入')
		&& (memberHost.textContent || '').includes('不进群聊')
		&& !(memberHost.textContent || '').includes('空输入 Enter'),
		(memberHost.textContent || '').slice(0, 400));
	{
		// ★ 2026-11-06 群成员审批：真实挂起一条（同一个 rooms 实例），成员栏出现「等你审批」与按钮，点「允许」走 roomsApi 真放行
		const decided = rooms.decideApproval({ agent: { id: member.id, session: { header: {} } }, toolName: 'pwsh' }, async () => 'unavailable');
		await tick(10);
		const waiting = rooms.pendingApprovals(made.id);
		await act(async () => {
			window.dispatchEvent(new window.CustomEvent(cv.__test.GROUP_PROGRESS_EVENT, { detail: { schema: 1, active: [{
				callId: 'call-approval', roomId: made.id, roomName: currentRoomName, done: false, startedAt: Date.now() - 1000, finishedAt: 0, error: '',
				speaking: [], replies: [], passed: [], failed: [], events: [], approvals: waiting,
			}] } }));
			await tick(30);
		});
		const allow = memberHost.querySelector('[data-act="group-approval-allow"]');
		truthy('⑤-审批 成员栏显示「等你审批」与允许 / 拒绝',
			waiting.length === 1 && !!allow && !!memberHost.querySelector('[data-act="group-approval-reject"]')
			&& !!memberHost.querySelector('[data-vssaros-group-member-state="approval"]'),
			(memberHost.textContent || '').slice(0, 300));
		await act(async () => { allow?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick(30); });
		eq('⑤-审批 点「允许」⇒ POST approve 真放行这条请求',
			[await Promise.race([decided, tick(500).then(() => 'timeout')]), rooms.pendingApprovals(made.id).length,
				calls.requests.some((r) => r === 'POST /x/agents/api/rooms')],
			['allowed-once', 0, true]);
	}
	await act(async () => {
		window.dispatchEvent(new window.CustomEvent(cv.__test.GROUP_PROGRESS_EVENT, { detail: { active: [{
			callId: 'call-right-tip', roomId: made.id, roomName: currentRoomName, done: false, startedAt: Date.now() - 1000, finishedAt: 0, error: '',
			speaking: ['Coder'], replies: [], passed: [], failed: [], events: [],
		}] } }));
		await tick(30);
	});
	truthy('⑤-c 打开群/成员会话后，右侧栏「已发到…」全局 tip 让位给 composer 活动行',
		Array.isArray(window.__vssarosGroupComposerDocks) && window.__vssarosGroupComposerDocks.includes(made.id)
		&& !dockHost.querySelector('[data-vssaros-group-activity="1"]'),
		(dockHost.textContent || '').slice(0, 300));
	await act(async () => {
		window.dispatchEvent(new window.CustomEvent(ws.__test.GROUP_DOCK_VISIBILITY_EVENT, { detail: { schema: 1, visible: false, roomId: made.id, role: 'member' } }));
		await tick(30);
	});
	truthy('⑤-c 离开群/成员会话后右侧栏 tip 恢复', !!dockHost.querySelector('[data-vssaros-group-activity="1"]'),
		(dockHost.textContent || '').slice(0, 300));
	{
		// ★ 2026-11-06（用户要求）：SuperAgent 工作台在前台时不显示这张 tip（它自己的卡片和执行页已有群运行）
		const mark = document.createElement('div');
		mark.setAttribute(ws.__test.GROUP_TIP_OFF_ATTR, 'off');
		let markShown = true; // jsdom 没有布局：用 getClientRects 模拟「工作台在前台 / 被藏起来」
		mark.getClientRects = () => (markShown ? [{ width: 100, height: 100 }] : []);
		eq('⑤-c tip 让位判定：可见的声明才算；藏起来的、没有声明的都不算', [
			ws.__test.groupTipSuppressed(document),
			(() => { document.body.appendChild(mark); const on = ws.__test.groupTipSuppressed(document); markShown = false; const hidden = ws.__test.groupTipSuppressed(document); markShown = true; mark.remove(); return [on, hidden]; })(),
			ws.__test.groupTipSuppressed(null),
		], [false, [true, false], false]);
		await act(async () => { document.body.appendChild(mark); await tick(600); });
		truthy('⑤-c SuperAgent 工作台在前台 ⇒ 右侧栏「已发到…」tip 不显示，群进度轮询照常（工作台的群运行区块还要用）',
			!dockHost.querySelector('[data-vssaros-group-activity="1"]') && !!window.__vssarosGroupActivityPoller,
			(dockHost.textContent || '').slice(0, 300));
		await act(async () => { markShown = false; await tick(600); });
		truthy('⑤-c 切走 SuperAgent（工作台被藏起来）⇒ tip 恢复', !!dockHost.querySelector('[data-vssaros-group-activity="1"]'),
			(dockHost.textContent || '').slice(0, 300));
		mark.remove();
	}
	await act(async () => {
		window.dispatchEvent(new window.CustomEvent(ws.__test.GROUP_DOCK_VISIBILITY_EVENT, { detail: { schema: 1, visible: true, roomId: made.id, role: 'member' } }));
		await tick(20);
	});
	eq('⑤-契约 输入框栏可见性事件（真实挂载/卸载产出 + 替身）全部符合契约',
		[captured.dock.length > 0, captured.dock.flatMap(detail => contractLib.check('dockVisibilityEvent', detail))], [true, []]);
	// 真实的群列表变化：改一个可见字段，等浮层下一次轮询发出 vssaros-rooms-changed
	const changedBefore = captured.roomsChanged.length;
	const wasPinned = !!(await rooms.get(made.id)).pinned;
	await rooms.setFlags(made.id, { pinned: !wasPinned });
	for (let i = 0; i < 60 && captured.roomsChanged.length === changedBefore; i += 1) { await act(async () => { await tick(50); }); }
	await rooms.setFlags(made.id, { pinned: wasPinned });
	eq('⑤-契约 群列表变化事件（浮层真实产出）符合契约',
		[captured.roomsChanged.length > changedBefore, captured.roomsChanged.flatMap(detail => contractLib.check('roomsChangedEvent', detail))], [true, []]);
}

// ── ⑤-d Bots 行：复刻 DS Bot 的 bot item 状态动画（头像姿态 + shimmer + 彩点）─────────
{
	const listed = await roomsApi(rooms, { method: 'GET', query: new URLSearchParams(), body: undefined });
	const listedRooms = listed.body.rooms || [];
	const activity = [{
		callId: 'call-bot-state', roomId: made.id, roomName: currentRoomName, done: false,
		startedAt: Date.now() - 1000, finishedAt: 0, error: '',
		speaking: ['Coder'], replies: [{ botId: 'reviewer', name: 'Code Reviewer', text: '审查完成', ms: 1200 }],
		events: [{ kind: 'working', name: 'Designer', text: 'Designer 开始做了，还在工作…' }],
		failed: [], passed: [],
	}];
	const coderState = ws.__test.botStateOf(activity, { id: 'coder', name: 'Coder' }, listedRooms);
	const designerState = ws.__test.botStateOf(activity, { id: 'designer', name: 'Designer' }, listedRooms);
	const reviewerState = ws.__test.botStateOf(activity, { id: 'reviewer', name: 'Code Reviewer' }, listedRooms);
	const idleState = ws.__test.botStateOf([], { id: 'coder', name: 'Coder' }, listedRooms);
	eq('⑤-d botStateOf 把 speaking / working / reply / idle 映射成 DS Bot 状态',
		[coderState.state, coderState.eventKind, designerState.state, reviewerState.state, idleState.state],
		['thinking', 'speaking', 'working', 'done', 'idle']);
	// ★ 2026-11-06（用户报「正在执行任务的 bot，点击其 item，没有打开对应的对话窗口」）：
	//   在群里有活动的 bot ⇒ 打开它在那个群里的会话；群里还没它的会话 ⇒ 打开群会话；idle ⇒ 空（走最近私聊）。
	// Coder 在群里开过会话、Designer 没有（去掉它前面几步真实开出来的那条）
	const withMember = listedRooms.map(r => (r.id === made.id ? { ...r, members: r.members.map(m => {
		const { sessionId: _own, ...rest } = m;
		return m.id === 'coder' ? { ...rest, sessionId: 'member-coder-sid' } : rest;
	}) } : r));
	eq('⑤-d botOpenTargetOf：忙的 bot 打开群内会话（无则群会话），闲的走原路',
		[ws.__test.botOpenTargetOf(coderState, { id: 'coder', name: 'Coder' }, withMember),
			ws.__test.botOpenTargetOf(designerState, { id: 'designer', name: 'Designer' }, withMember),
			ws.__test.botOpenTargetOf(idleState, { id: 'coder', name: 'Coder' }, withMember),
			ws.__test.botOpenTargetOf({ state: 'working', roomId: 'gone-room' }, { id: 'coder' }, withMember)],
		['member-coder-sid', made.id, '', 'gone-room']);
	const wsSrc = readFileSync(join(repo, 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.workspaces.js'), 'utf8');
	eq('⑤-d 点 bot 行先按 botOpenTargetOf 打开群内会话（openBot 接线）',
		/const openBot = \(a\) => \{[\s\S]{0,400}botOpenTargetOf\(botStateOf\(groupActivity, a,[\s\S]{0,200}openSession\(busySid/.test(wsSrc), true);
	const listedMembers = (listed.body.rooms.find(r => r.id === made.id) || {}).members || [];
	eq('⑤-d /api/rooms 的成员带它在群里的会话 id（开过才有）',
		[listedMembers.some(m => typeof m.sessionId === 'string' && m.sessionId.length > 0),
			listedMembers.filter(m => m.sessionId).every(m => m.sessionId !== made.id)], [true, true]);
	const roundFor = (extra) => Object.assign({ callId: 'call-state', roomId: made.id, roomName: currentRoomName, done: false,
		startedAt: Date.now() - 1000, finishedAt: 0, error: '', speaking: [], replies: [], events: [], failed: [], passed: [] }, extra);
	const coder = { id: 'coder', name: 'Coder' };
	eq('⑤-d botStateOf 覆盖 DS Bot 其余状态：searching / sending / waiting / alert / orbit / done',
		[
			ws.__test.botStateOf([roundFor({ events: [{ kind: 'working', name: 'Coder', text: 'Coder 正在搜索文件' }] })], coder, listedRooms).state,
			ws.__test.botStateOf([roundFor({ events: [{ kind: 'working', name: 'Coder', text: 'Coder 正在转交结果' }] })], coder, listedRooms).state,
			ws.__test.botStateOf([roundFor({ events: [{ kind: 'paused', name: 'Coder', text: '暂停' }] })], coder, listedRooms).state,
			ws.__test.botStateOf([roundFor({ failed: [{ botId: 'coder', name: 'Coder', reason: '超时' }] })], coder, listedRooms).state,
			ws.__test.botStateOf([roundFor({})], { id: 'designer', name: 'Designer' }, listedRooms).state,
			ws.__test.botStateOf([roundFor({ done: true })], { id: 'designer', name: 'Designer' }, listedRooms).state,
		], ['searching', 'sending', 'waiting', 'alert', 'orbit', 'done']);
	await act(async () => {
		window.dispatchEvent(new window.CustomEvent(ws.__test.GROUP_PROGRESS_EVENT, { detail: { active: activity } }));
		await tick(30);
	});
	const botStateCss = String(document.head.querySelector('[data-vssaros-bot-state-style]')?.textContent || '');
	truthy('⑤-d 注入了 DS Bot 姿态/shimmer/彩点样式表',
		!!document.head.querySelector('[data-vssaros-bot-state-style]')
		&& /vssaros-bot-bob/.test(botStateCss) && /vssaros-bot-ponder/.test(botStateCss)
		&& /vssaros-bot-seek/.test(botStateCss) && /vssaros-bot-dash/.test(botStateCss)
		&& /vssaros-bot-sway/.test(botStateCss) && /vssaros-bot-hop/.test(botStateCss)
		&& /vssaros-bot-done/.test(botStateCss) && /vssaros-bot-shimmer/.test(botStateCss)
		&& /\[data-vssaros-bot-state='thinking'\]/.test(botStateCss)
		&& /\[data-vssaros-bot-state='searching'\]/.test(botStateCss)
		&& /\[data-vssaros-bot-state='sending'\]/.test(botStateCss)
		&& /\[data-vssaros-bot-state='alert'\]/.test(botStateCss)
		&& /prefers-reduced-motion/.test(botStateCss));
	truthy('⑤-d Bots 行实时显示 thinking / working / done 状态、shimmer 文案与彩点',
		!!q('[data-vssaros-bot="coder"][data-vssaros-bot-state="thinking"][data-vssaros-bot-event="speaking"]')
		&& !!q('[data-vssaros-bot="designer"][data-vssaros-bot-state="working"][data-vssaros-bot-event="working"]')
		&& !!q('[data-vssaros-bot="reviewer"][data-vssaros-bot-state="done"]')
		&& !!q('[data-vssaros-bot="coder"][data-vssaros-bot-room="' + made.id + '"]')
		&& !!q('[data-vssaros-bot-state-label]')
		&& !!q('[data-vssaros-bot-dot]')
		&& !!q('[data-vssaros-bot-avatar]'), (container.textContent || '').slice(0, 400));
	await act(async () => {
		window.dispatchEvent(new window.CustomEvent(ws.__test.GROUP_PROGRESS_EVENT, { detail: { active: [] } }));
		await tick(20);
	});
	truthy('⑤-d 活动清空 ⇒ Bots 行回到 idle，不再显示状态灯',
		!!q('[data-vssaros-bot="coder"][data-vssaros-bot-state="idle"]') && !q('[data-vssaros-bot-dot]'), (container.textContent || '').slice(0, 300));
}

// ── ⑥ 删除群聊 ──────────────────────────────────────────────────────────────────────
await openMenu();
await mouse(menuItem('delete'), 'mousedown');
await settle();
truthy('⑥ 删除群聊 ⇒ 先弹确认（不直接删）', !!q('[data-vssaros-room-confirm]') && (await rooms.list()).length === 1);
await mouse(q('[data-act="room-delete-confirm"]'), 'click');
await settle(100);
truthy('⑥ 确认 ⇒ 群从侧栏消失、服务端删除、群会话与成员会话归档',
	!row() && (await rooms.list()).length === 0 && dsh.archived.includes(made.id) && dsh.archived.length === 3, JSON.stringify(dsh.archived));

await act(async () => { root.unmount(); relayRoot.unmount(); dockRoot.unmount(); memberRoot.unmount(); });
rmSync(dir, { recursive: true, force: true });
if (problems.length) {
	console.log(`\n✗ check-bots-rooms：${problems.length} 项失败`);
	process.exit(1);
}
console.log('\n✓ check-bots-rooms：主管建群 ⇒ Bots 页签群行（打开 / 7 项菜单 / 改名 / 设置 / 隐藏 / 删除）全部通过');
process.exit(0);
