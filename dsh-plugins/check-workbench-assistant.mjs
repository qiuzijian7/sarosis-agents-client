// 工作台「AI 助手栏」的**行为级**守卫（真 React 18 + jsdom）。
//
// 2026-11-02 根治后的契约（用户：「不同工作台中聊天框的 agent 使用不当，多轮修复始终反复出错」）：
//   ① **唯一写入者**：只有宿主会改 agent；只改「这个工作台对话栏里此刻显示的那条」会话，绝不碰全局当前会话；
//   ② **每个工作台独占自己的会话**：新会话用 `sessions.create({ workspaceId, agentPreset })` 新建，
//      **不走** `connectBlank(ws, {agentPreset})`（它会复用工作区里现成的空会话 ⇒ 多个工作台抢同一条）；不再"借用"；
//   ③ **只用真实存在的 preset id**（`agentPresets.list()` 里有的）；读不到列表就**不指定**，绝不猜
//      （select 一个不存在的 id 会把会话弄坏：之后 resume 报 Unknown agent preset）；
//   ④ **等 preset 注册**：vssaros-agents 是 lazy 注册（开机 ~15s 后才补齐）⇒ 没就绪先不带 preset 建，注册好再补；
//   ⑤ 只改 blank、每条只套一次、等待期间被用户手动改过就尊重；官方失败返回 {ok:false}（不抛）⇒ 必须看 ok。
//
// 为什么 mock 必须"像真的"：上一版的 mock 里 select 永远成功、preset 永远存在、只挂一个工作台 ——
// 真机上反复出错的三个条件（多写入者并存、lazy 窗口、多页签同时挂载）一个都没建模，所以测试全绿、真机照样坏。
// 这一版：create 遇到未注册的 preset 会抛（与宿主一致）、select 未注册的返回 {ok:false}、roster 可以晚到、
// connectBlank 会**真的复用**共享的空会话（用来证明宿主不再走它）、两个工作台可以同时挂载。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

// ⚠ 加载顺序是硬约束（见 check-sessions-workbench.mjs）：先挂 jsdom 全局，再动态 import React。
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true, url: 'http://127.0.0.1:1/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.MutationObserver = window.MutationObserver;
globalThis.ResizeObserver = window.ResizeObserver || class { observe() { } unobserve() { } disconnect() { } };
let React; let ReactDOM; let createRoot; let act;
try {
	React = (await import('react')).default;
	ReactDOM = (await import('react-dom')).default;
	({ createRoot } = await import('react-dom/client'));
	act = typeof React.act === 'function' ? React.act : (await import('react-dom/test-utils')).act;
} catch (e) {
	console.log('  ✗ 缺少 react / react-dom（本守卫的隐含依赖，原本靠 hoist 带来）：' + String((e && e.message) || e).split('\n')[0]);
	process.exit(1);
}

const repo = process.cwd();
let problems = 0;
const ok = (n) => console.log('  ✓ ' + n);
const fail = (n, d) => { problems += 1; console.log('  ✗ ' + n + (d ? '  → ' + d : '')); };
const truthy = (n, c, d) => (c ? ok(n) : fail(n, d));
const eq = (n, a, e) => (JSON.stringify(a) === JSON.stringify(e) ? ok(n) : fail(n, '期望 ' + JSON.stringify(e) + '，实际 ' + JSON.stringify(a)));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const h = React.createElement;

console.log('[check-workbench-assistant] AI 助手栏：「＋ 新会话」+ 默认 agent（唯一写入者 / 独占会话 / 不猜 id / 等注册）');

const { emptyState } = await import(pathToFileURL(join(repo, 'dsh-plugins/vssaros-workbenches/lib/state.js')).href);
const SRC = readFileSync(join(repo, 'dsh-plugins/vssaros-workbenches/lib/client.js'), 'utf8');
let host = null;
{
	const req = (name) => { if (name === 'react') { return React; } if (name === 'react-dom') { return ReactDOM; } throw new Error('unexpected require ' + name); };
	window.__ModuleLoader__ = { load: (m) => { host = m.factory(req); } };
	new Function('window', 'document', 'globalThis', SRC)(window, window.document, globalThis);
}
if (!host) { fail('装不起宿主 client.js'); process.exit(1); }

/**
 * 能**记录调用**、行为对齐真宿主的 ctx。
 * @param {object} o
 * @param {string[]} o.presets 一开始就注册好的 preset id（之后可以往 env.roster 里 push，模拟 lazy 补齐）
 * @param {boolean} o.noPresetService 不提供 remote.agentPresets
 * @param {boolean} o.createRejectsPreset 带 agentPreset 的 create 一律抛（模拟意外失败）
 * @param {object[]} o.wsItems 工作区快照
 */
function makeEnv(o = {}) {
	const provided = {};
	const calls = { create: [], select: [], list: 0, connectBlank: [] };
	const sessionsById = {};
	const roster = [...(o.presets || [])];
	const wsItems = o.wsItems || [{ workspaceId: 'ws-1', title: 'demo', path: 'G:/x', sessionIds: [] }];
	let seq = 0;
	const savedFetch = globalThis.fetch;
	let state = emptyState();
	let revision = 0;
	globalThis.fetch = async (url, init) => {
		if (init && init.method === 'POST') {
			const body = JSON.parse(init.body);
			state = body.state; revision += 1;
			return { ok: true, status: 200, json: async () => ({ revision, state }) };
		}
		return { ok: true, status: 200, json: async () => ({ revision, state }) };
	};
	const ctx = {
		effect: (fn) => fn(),
		slots: { register: () => () => { }, inject: (_n, f) => f() },
		layout: { selectPanel: () => { }, toggleSidebar: () => { } },
		reflect: { provide: (name, svc) => { provided[name] = svc; return () => { }; } },
		sessions: {
			retain: () => ({ release() { }, ready: Promise.resolve() }),
			// 与宿主 session-controller 一致：未注册的 preset ⇒ 抛；建完**一定** attach 进工作区
			create: async (req) => {
				calls.create.push(req);
				if (req.agentPreset && (o.createRejectsPreset || !roster.includes(req.agentPreset))) { throw new Error('Unknown agent preset: ' + req.agentPreset); }
				const id = 'sess-' + (++seq);
				const ws = wsItems.find(w => w.workspaceId === req.workspaceId) || wsItems[0];
				sessionsById[id] = { id, blank: true, cwd: ws.path, projectionValues: { agentPreset: req.agentPreset || 'vssaros-standard' } };
				ws.sessionIds.push(id);
				return id;
			},
			list: { getSnapshot: () => ({ byId: sessionsById, ids: Object.keys(sessionsById) }) },
		},
		workspaces: {
			list: { getSnapshot: () => ({ phase: 'ready', items: wsItems, archivedSessionIds: [], pinnedSessionIds: [] }), subscribe: () => () => { } },
		},
		uiWorkspace: {
			openSession: () => { }, startSession: () => { },
			// 真实 connectBlank(ws, {agentPreset}) 会复用工作区里现成的空会话 ⇒ 这里返回一条**共享的**空会话。
			// 宿主一旦又走它，两个工作台就会拿到同一条 —— 断言里要求它**一次都不被调用**。
			connectBlank: async (wsId, reuse) => {
				calls.connectBlank.push([wsId, reuse]);
				if (!sessionsById['shared-blank']) {
					sessionsById['shared-blank'] = { id: 'shared-blank', blank: true, cwd: 'G:/x', projectionValues: { agentPreset: 'vssaros-standard' } };
					wsItems[0].sessionIds.push('shared-blank');
				}
				return 'shared-blank';
			},
		},
		inject: (deps, cb) => {
			if (deps.includes('remote.agentPresets') && !o.noPresetService) {
				cb({
					'remote.agentPresets': {
						list: async () => { calls.list += 1; return { ok: true, value: { presets: roster.map(id => ({ id })) } }; },
						// 与官方一致：失败**返回** {ok:false}，不抛；成功才真的改会话的 agent
						select: async (sid, pid) => {
							calls.select.push([sid, pid]);
							if (!roster.includes(pid)) { return { ok: false, error: { code: 'agent-preset/not-found', message: 'Unknown agent preset: ' + pid } }; }
							if (sessionsById[sid]) { sessionsById[sid].projectionValues = { ...(sessionsById[sid].projectionValues || {}), agentPreset: pid }; }
							return { ok: true, value: pid };
						},
					},
				});
			}
		},
	};
	host.apply(ctx);
	const service = provided.desktopWorkbenches;
	// 测试里把"等 preset 注册"的节奏调快（真机：每 1s 读一次，最多等 30s）
	service.presetPollMs = 15;
	service.presetWaitMs = 400;
	return { ctx, calls, sessionsById, wsItems, roster, service, restore: () => { globalThis.fetch = savedFetch; } };
}

async function mount(node) {
	const container = window.document.createElement('div');
	window.document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => { root.render(node); await tick(5); });
	return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); await tick(40); }); };
const captureWarns = () => { const ow = console.warn; const warns = []; console.warn = (...a) => { warns.push(a.join(' ')); }; return { warns, restore: () => { console.warn = ow; } }; };
const reg = (env, title, repository, extra = {}) => env.service.register({ title, repository, customFrame: true, ...extra }, (p) => h('div', null, p.conversation));

async function openWorkbench(env, id) {
	await env.service.load();
	return mount(h(env.service.View, { id, active: true }));
}

// ── ① 两种承载都有按钮，且就在对话栏里；左上角没有收起 ────────────────────────────────────────
{
	const env = makeEnv({ presets: ['vssaros-marketplace-bot'] });
	try {
		reg(env, '商城', 'vssaros:marketplace');
		env.service.register({ title: '普通', repository: 'vssaros:plain' }, () => h('div', null, 'biz'));
		const inline = await openWorkbench(env, 'vssaros/marketplace');
		const b1 = inline.container.querySelectorAll('[data-vssaros-wb-new-session]');
		eq('① 整页工作台（customFrame）：对话栏里有 1 个「＋ 新会话」', b1.length, 1);
		truthy('① 它在对话栏（.vssWbDockHost）里', !!(b1[0] && b1[0].closest('.vssWbDockHost')));
		eq('① 按钮文案', b1[0] && b1[0].textContent, '＋ 新会话');
		const texts = [...inline.container.querySelectorAll('button')].map(b => b.textContent);
		truthy('① 对话栏里没有「» 收起」（收起统一走浮动工具栏）', !texts.some(t => /收起/.test(t)), texts.join('|'));
		await inline.unmount();
		const split = await openWorkbench(env, 'vssaros/plain');
		const b2 = split.container.querySelectorAll('[data-vssaros-wb-new-session]');
		eq('① 标准分栏：对话栏里有 1 个「＋ 新会话」', b2.length, 1);
		truthy('① 它在分栏对话栏（.vssWbSplitConversation）里', !!(b2[0] && b2[0].closest('.vssWbSplitConversation')));
		await split.unmount();
	} finally { env.restore(); }
}

// ── ② 点「＋ 新会话」⇒ 新建**自己的**会话（sessions.create），出生就带默认 agent，归属本工作台 ──────────
{
	const env = makeEnv({ presets: ['vssaros-marketplace-bot'] });
	try {
		reg(env, '商城', 'vssaros:marketplace');
		const m = await openWorkbench(env, 'vssaros/marketplace');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('② sessions.create 恰好 1 次，入参 = 工作区 + 商城默认 agent', env.calls.create, [{ workspaceId: 'ws-1', agentPreset: 'vssaros-marketplace-bot' }]);
		eq('② **不走** connectBlank（它会复用工作区里现成的空会话）', env.calls.connectBlank.length, 0);
		eq('② 会话归属了商城工作台', env.service.state.sessionBindings['sess-1'], 'vssaros/marketplace');
		eq('② 停靠的就是这条新会话', env.service.dockedSessionOf('vssaros/marketplace'), 'sess-1');
		eq('② 出生就带 preset ⇒ 不再事后 select', env.calls.select.length, 0);
		await m.unmount();
	} finally { env.restore(); }
}

// ── ③ 同一工作区里**两个工作台各自新建** ⇒ 两条不同的会话、各带各的 agent（不再抢同一条）──────────────
{
	const env = makeEnv({ presets: ['vssaros-marketplace-bot', 'vssaros-kb-expert'] });
	try {
		reg(env, '商城', 'vssaros:marketplace');
		reg(env, '知识库', 'vssaros:kb');
		await env.service.load();
		const mk = await mount(h(env.service.View, { id: 'vssaros/marketplace', active: true }));
		const kb = await mount(h(env.service.View, { id: 'vssaros/kb', active: false }));
		await click(mk.container.querySelector('[data-vssaros-wb-new-session]'));
		await click(kb.container.querySelector('[data-vssaros-wb-new-session]'));
		const a = env.service.dockedSessionOf('vssaros/marketplace');
		const b = env.service.dockedSessionOf('vssaros/kb');
		truthy('③ 两个工作台拿到的是**两条不同**的会话', !!a && !!b && a !== b, a + ' / ' + b);
		eq('③ 各自的 agent：商城 = 商城助手，知识库 = 知识库专家',
			[env.sessionsById[a] && env.sessionsById[a].projectionValues.agentPreset, env.sessionsById[b] && env.sessionsById[b].projectionValues.agentPreset],
			['vssaros-marketplace-bot', 'vssaros-kb-expert']);
		eq('③ 各自归属自己', [env.service.state.sessionBindings[a], env.service.state.sessionBindings[b]], ['vssaros/marketplace', 'vssaros/kb']);
		eq('③ 两次都没走 connectBlank', env.calls.connectBlank.length, 0);
		truthy('③ 两条都登记进了工作区（输入框可用的前提）', env.wsItems[0].sessionIds.includes(a) && env.wsItems[0].sessionIds.includes(b));
		truthy('③ 宿主不再提供「借用」（共享显示别人的会话）', typeof env.service.borrowSession === 'undefined');
		await mk.unmount(); await kb.unmount();
	} finally { env.restore(); }
}

// ── ④ 前台是**别的**工作台时，点这个工作台的按钮 ⇒ 仍归属这个工作台 ───────────────────────────────
{
	const env = makeEnv({ presets: ['vssaros-marketplace-bot', 'vssaros-kb-expert'] });
	try {
		reg(env, '商城', 'vssaros:marketplace');
		reg(env, '知识库', 'vssaros:kb');
		await env.service.load();
		env.service.activate('vssaros/kb');
		const m = await mount(h(env.service.View, { id: 'vssaros/marketplace', active: false }));
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('④ 点的是商城的按钮 ⇒ 会话归属商城（不是前台的知识库）', env.service.state.sessionBindings['sess-1'], 'vssaros/marketplace');
		eq('④ 用的是商城的默认 agent', env.calls.create[0] && env.calls.create[0].agentPreset, 'vssaros-marketplace-bot');
		await m.unmount();
	} finally { env.restore(); }
}

// ── ⑤ 知识库：候选两个，以 list() 里真实存在的为准 ────────────────────────────────────────────
for (const [label, presets, expected] of [
	['数据根里是 kb-expert（本机）', ['vssaros-kb-expert', 'vssaros-media-librarian'], 'vssaros-kb-expert'],
	['内置目录是 knowledge-base-expert（另一套环境）', ['vssaros-knowledge-base-expert'], 'vssaros-knowledge-base-expert'],
]) {
	const env = makeEnv({ presets });
	try {
		reg(env, '知识库', 'vssaros:kb');
		const m = await openWorkbench(env, 'vssaros/kb');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑤ 知识库 ' + label + ' ⇒ 用 ' + expected, env.calls.create[0] && env.calls.create[0].agentPreset, expected);
		await m.unmount();
	} finally { env.restore(); }
}

// ── ⑥ **绝不猜**：列表读不到 / 候选都不在 ⇒ 不带 preset、不 select ──────────────────────────────
{
	const env = makeEnv({ noPresetService: true });
	try {
		reg(env, '商城', 'vssaros:marketplace');
		const m = await openWorkbench(env, 'vssaros/marketplace');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑥ 没有 agentPresets 服务 ⇒ 建会话**不带** preset（不拿第一个候选碰运气）', env.calls.create, [{ workspaceId: 'ws-1' }]);
		truthy('⑥ 会话照样建出来并归属本工作台', env.service.state.sessionBindings['sess-1'] === 'vssaros/marketplace');
		await m.unmount();
	} finally { env.restore(); }
}
{
	const env = makeEnv({ presets: ['vssaros-media-librarian'] });
	const cw = captureWarns();
	try {
		reg(env, '知识库', 'vssaros:kb');
		const m = await openWorkbench(env, 'vssaros/kb');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑥ 候选都不在 ⇒ 建会话不带 agentPreset', env.calls.create, [{ workspaceId: 'ws-1' }]);
		await act(async () => { await tick(600); });   // 超过 presetWaitMs，让事后补的那一轮结束
		eq('⑥ 候选都不在 ⇒ 等完也**不 select**（不硬塞不存在的 id）', env.calls.select, []);
		truthy('⑥ 等完仍不在 ⇒ 告警一次，说清是哪个工作台', cw.warns.filter(w => /没有找到 vssaros\/kb 的默认 agent/.test(w)).length === 1, cw.warns.join('|').slice(0, 200));
		await m.unmount();
	} finally { cw.restore(); env.restore(); }
}

// ── ⑦ **等注册**（lazy 窗口）：开机时 preset 还没注册 ⇒ 先不带建，注册好后补到**这条**会话上 ──────────
// 真机：vssaros-agents 启动只注册 3 个 preset，其余 15s 后补齐；工作台此时已经打开了。
{
	const env = makeEnv({ presets: [] });
	try {
		reg(env, '知识库', 'vssaros:kb');
		const m = await openWorkbench(env, 'vssaros/kb');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑦ 还没注册 ⇒ 先不带 preset 建（不能因此建不出会话，也不拿未注册的 id 去撞）', env.calls.create, [{ workspaceId: 'ws-1' }]);
		eq('⑦ 还没注册时**不** select', env.calls.select, []);
		env.roster.push('vssaros-kb-expert');   // lazy 补齐到了
		await act(async () => { await tick(120); });
		eq('⑦ 注册好后补到这条会话上：select(sess-1, 知识库专家)', env.calls.select, [['sess-1', 'vssaros-kb-expert']]);
		eq('⑦ 会话的 agent 真的变了', env.sessionsById['sess-1'].projectionValues.agentPreset, 'vssaros-kb-expert');
		await m.unmount();
	} finally { env.restore(); }
}

// ── ⑧ 事后套用：只动 blank、每条只套一次、已是目标不调 ───────────────────────────────────────
{
	const env = makeEnv({ presets: ['vssaros-marketplace-bot'] });
	try {
		reg(env, '商城', 'vssaros:marketplace');
		await env.service.load();
		env.sessionsById['hero-1'] = { id: 'hero-1', blank: true, projectionValues: { agentPreset: 'vssaros-standard' } };
		env.sessionsById['talk-1'] = { id: 'talk-1', blank: false, projectionValues: { agentPreset: 'vssaros-standard' } };
		env.sessionsById['hero-2'] = { id: 'hero-2', blank: true, projectionValues: { agentPreset: 'vssaros-marketplace-bot' } };
		for (const sid of ['hero-1', 'talk-1', 'hero-2']) { await env.service.bindSession('vssaros/marketplace', sid); }
		env.service.dockTo('vssaros/marketplace', 'hero-1');
		env.service.applyDefaultPreset('vssaros/marketplace', 'hero-1'); await tick(60);
		eq('⑧ blank 会话 ⇒ select(会话, 商城助手)', env.calls.select, [['hero-1', 'vssaros-marketplace-bot']]);
		// 之后用户在 chip 里手动换成别的 agent，再次停靠这条（切页签回来）⇒ 不能抢回来
		// ⚠ 必须先让它"不是目标"再调第二次：否则第二次本来就会因为「已是目标」不调，测不出「只套一次」（反向突变 M7 抓到的）
		env.roster.push('vssaros-ppt-slides-master');
		env.sessionsById['hero-1'].projectionValues.agentPreset = 'vssaros-ppt-slides-master';
		env.service.applyDefaultPreset('vssaros/marketplace', 'hero-1'); await tick(60);
		eq('⑧ 同一条再来一次（用户已手动换过 agent）⇒ 不再 select', env.calls.select.length, 1);
		env.service.dockTo('vssaros/marketplace', 'talk-1');
		env.service.applyDefaultPreset('vssaros/marketplace', 'talk-1'); await tick(60);
		eq('⑧ 已经开聊的会话 ⇒ **绝不**改它的 agent', env.calls.select.length, 1);
		env.service.dockTo('vssaros/marketplace', 'hero-2');
		env.service.applyDefaultPreset('vssaros/marketplace', 'hero-2'); await tick(60);
		eq('⑧ 已经是目标 agent ⇒ 不调用', env.calls.select.length, 1);
	} finally { env.restore(); }
}

// ── ⑨ **多页签同时挂载**：两个工作台各自停靠 blank 会话 ⇒ 各改各的，绝不串台 ───────────────────────────
// 真机日志：「套用默认 agent 被拒：vssaros-media-librarian @ b553d405（Unknown agent preset: vssaros-knowledge-base-expert）」
// ——媒体库的会话被知识库插件改过。根因是插件对**全局当前会话**下手。宿主只认「这个工作台显示的那条」。
{
	const env = makeEnv({ presets: ['vssaros-kb-expert', 'vssaros-media-librarian', 'vssaros-marketplace-bot'] });
	try {
		reg(env, '知识库', 'vssaros:kb');
		reg(env, '媒体库', 'vssaros:media');
		reg(env, '商城', 'vssaros:marketplace');
		await env.service.load();
		for (const [wb, sid] of [['vssaros/kb', 's-kb'], ['vssaros/media', 's-media'], ['vssaros/marketplace', 's-mk']]) {
			env.sessionsById[sid] = { id: sid, blank: true, projectionValues: { agentPreset: 'vssaros-standard' } };
			env.wsItems[0].sessionIds.push(sid);
			await env.service.bindSession(wb, sid);
			env.service.dockTo(wb, sid);
		}
		env.service.activate('vssaros/marketplace');   // 前台是商城，但三个工作台都挂着
		env.service.applyDefaultPreset('vssaros/kb', 's-kb');
		env.service.applyDefaultPreset('vssaros/media', 's-media');
		env.service.applyDefaultPreset('vssaros/marketplace', 's-mk');
		await act(async () => { await tick(80); });
		const sorted = [...env.calls.select].sort((x, y) => x[0].localeCompare(y[0]));
		eq('⑨ 三个工作台各改各的那条，一一对应（没有任何交叉）', sorted,
			[['s-kb', 'vssaros-kb-expert'], ['s-media', 'vssaros-media-librarian'], ['s-mk', 'vssaros-marketplace-bot']]);
		// 想让知识库去改**不是它显示的**会话 ⇒ 拒绝
		env.sessionsById['s-other'] = { id: 's-other', blank: true, projectionValues: { agentPreset: 'vssaros-standard' } };
		await env.service.bindSession('vssaros/media', 's-other');
		env.service.applyDefaultPreset('vssaros/kb', 's-other');
		await act(async () => { await tick(80); });
		eq('⑨ 不是这个工作台显示（也不归它）的会话 ⇒ 不改', env.calls.select.filter(c => c[0] === 's-other'), []);
	} finally { env.restore(); }
}

// ── ⑩ 等待期间情况变了 ⇒ 放弃：换了会话 / 用户手动换了 agent ───────────────────────────────────
{
	const env = makeEnv({ presets: [] });
	try {
		reg(env, '知识库', 'vssaros:kb');
		await env.service.load();
		for (const sid of ['s-a', 's-b', 's-c']) {
			env.sessionsById[sid] = { id: sid, blank: true, projectionValues: { agentPreset: 'vssaros-standard' } };
			await env.service.bindSession('vssaros/kb', sid);
		}
		// a：等注册期间，对话栏换成了别的会话
		env.service.dockTo('vssaros/kb', 's-a');
		env.service.applyDefaultPreset('vssaros/kb', 's-a');
		await tick(30);
		env.service.dockTo('vssaros/kb', 's-b');
		// b：等注册期间，用户在 chip 里手动选了别的 agent
		env.service.applyDefaultPreset('vssaros/kb', 's-b');
		await tick(30);
		env.sessionsById['s-b'].projectionValues.agentPreset = 'vssaros-ppt-slides-master';
		env.roster.push('vssaros-kb-expert', 'vssaros-ppt-slides-master');
		await act(async () => { await tick(120); });
		eq('⑩ 等待期间对话栏换了会话 ⇒ 不再改原来那条', env.calls.select.filter(c => c[0] === 's-a'), []);
		eq('⑩ 等待期间用户手动换了 agent ⇒ 尊重，不抢回来', env.calls.select.filter(c => c[0] === 's-b'), []);
		eq('⑩ 用户选的 agent 保持不变', env.sessionsById['s-b'].projectionValues.agentPreset, 'vssaros-ppt-slides-master');
	} finally { env.restore(); }
}
{
	// 等注册期间，用户**直接开聊了**（开机那十几秒里发出第一句话）⇒ 已不是 blank，绝不能再改
	// （反向突变 M6 抓到的缺口：只在开始时判 blank，等完不再判，就会改掉一段进行中的对话）
	const env = makeEnv({ presets: [] });
	try {
		reg(env, '知识库', 'vssaros:kb');
		await env.service.load();
		env.sessionsById['s-c'] = { id: 's-c', blank: true, projectionValues: { agentPreset: 'vssaros-standard' } };
		await env.service.bindSession('vssaros/kb', 's-c');
		env.service.dockTo('vssaros/kb', 's-c');
		env.service.applyDefaultPreset('vssaros/kb', 's-c');
		await tick(30);
		env.sessionsById['s-c'].blank = false;
		env.roster.push('vssaros-kb-expert');
		await act(async () => { await tick(120); });
		eq('⑩ 等待期间用户已经开聊 ⇒ **绝不**改进行中对话的 agent', env.calls.select, []);
	} finally { env.restore(); }
}

// ── ⑪ 官方 select 失败是**返回 {ok:false}**（不抛）⇒ 必须看 ok 并告警 ───────────────────────────────
{
	const env = makeEnv({ presets: ['vssaros-marketplace-bot'] });
	const cw = captureWarns();
	try {
		reg(env, '商城', 'vssaros:marketplace');
		await env.service.load();
		env.sessionsById['hero-1'] = { id: 'hero-1', blank: true, projectionValues: { agentPreset: 'vssaros-standard' } };
		await env.service.bindSession('vssaros/marketplace', 'hero-1');
		env.service.dockTo('vssaros/marketplace', 'hero-1');
		// list 里有、但 select 时被拒（例如 preset 刚被撤掉）
		const svc = env.service.agentPresets;
		const realSelect = svc.select;
		svc.select = async (sid, pid) => { env.calls.select.push([sid, pid]); return { ok: false, error: { message: 'not found' } }; };
		env.service.applyDefaultPreset('vssaros/marketplace', 'hero-1'); await tick(60);
		svc.select = realSelect;
		truthy('⑪ select 返回 {ok:false} ⇒ 记告警（含原因），不是静默成功', cw.warns.some(w => /套用默认 agent 被拒：vssaros-marketplace-bot @ hero-1（not found）/.test(w)), cw.warns.join('|').slice(0, 200));
	} finally { cw.restore(); env.restore(); }
}

// ── ⑫ 带 preset 建会话意外被拒 ⇒ 退回不带 preset，不能因此建不出会话 ───────────────────────────────
{
	const env = makeEnv({ presets: ['vssaros-marketplace-bot'], createRejectsPreset: true });
	const cw = captureWarns();
	try {
		reg(env, '商城', 'vssaros:marketplace');
		const m = await openWorkbench(env, 'vssaros/marketplace');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑫ 先试带 preset，再退回不带的：共 2 次 create', env.calls.create.map(c => !!c.agentPreset), [true, false]);
		truthy('⑫ 退回之后会话照样建出来并归属本工作台', env.service.state.sessionBindings['sess-1'] === 'vssaros/marketplace');
		truthy('⑫ 退回时有告警（不静默）', cw.warns.some(w => /带 agentPreset 建会话失败，退回默认/.test(w)));
		await m.unmount();
	} finally { cw.restore(); env.restore(); }
}

// ── ⑬ 没有默认 agent 的工作台 / 第三方自带 assistantPreset ────────────────────────────────────────
{
	const env = makeEnv({ presets: [] });
	try {
		reg(env, '看板', 'vssaros:kanban');
		const m = await openWorkbench(env, 'vssaros/kanban');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑬ 没有默认 agent ⇒ 建会话不带 agentPreset', env.calls.create, [{ workspaceId: 'ws-1' }]);
		eq('⑬ 也不会去 list / select', [env.calls.list, env.calls.select.length], [0, 0]);
		await m.unmount();
	} finally { env.restore(); }
}
{
	const env = makeEnv({ presets: ['vssaros-my-bot'] });
	try {
		env.service.register({ title: '自带', package: '@me/own', assistantPreset: 'vssaros-my-bot', customFrame: true }, (p) => h('div', null, p.conversation));
		const m = await openWorkbench(env, 'local:@me/own');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑬ 第三方在描述符里声明 assistantPreset ⇒ 用它', env.calls.create[0] && env.calls.create[0].agentPreset, 'vssaros-my-bot');
		await m.unmount();
	} finally { env.restore(); }
}

// ── ⑭ 自愈：停靠的是没被工作区收录的空会话 ⇒ 给**这个**工作台建一条自己的新会话 ─────────────────────
{
	const env = makeEnv({ presets: ['vssaros-kb-expert', 'vssaros-marketplace-bot'] });
	const cw = captureWarns();
	try {
		reg(env, '知识库', 'vssaros:kb');
		reg(env, '商城', 'vssaros:marketplace');
		await env.service.load();
		const old = 'sess-old';
		env.sessionsById[old] = { id: old, blank: true, cwd: 'G:/x', projectionValues: {} };   // 故意不收录
		await env.service.bindSession('vssaros/kb', old);
		env.service.dockTo('vssaros/kb', old);
		env.service.activate('vssaros/marketplace');   // 前台是**商城**（多页签同时挂载）
		env.service.diagnoseDock('vssaros/kb', old);
		await act(async () => { await tick(120); });
		const now = env.service.dockedSessionOf('vssaros/kb');
		truthy('⑭ 知识库换上了一条新会话', !!now && now !== old, '现在是 ' + now);
		eq('⑭ 新会话归属**知识库**（不是前台的商城）', env.service.state.sessionBindings[now], 'vssaros/kb');
		eq('⑭ 用知识库自己的 agent 新建（sessions.create，不走 connectBlank）',
			[env.calls.create[0], env.calls.connectBlank.length], [{ workspaceId: 'ws-1', agentPreset: 'vssaros-kb-expert' }, 0]);
		truthy('⑭ 新会话登记进了工作区', env.wsItems[0].sessionIds.includes(now));
		truthy('⑭ 换会话时留下告警（可追溯）', cw.warns.some(w => /换一条自己的新会话/.test(w)), cw.warns.join('|').slice(0, 160));
		eq('⑭ 商城没被动到（没有给商城建 / 绑会话）', Object.values(env.service.state.sessionBindings).filter(x => x === 'vssaros/marketplace').length, 0);
		env.service.healDock('vssaros/kb', env.sessionsById[old]);
		await tick(80);
		eq('⑭ 同一个工作台只救一次（不反复建会话）', env.calls.create.length, 1);
	} finally { cw.restore(); env.restore(); }
}
{
	const env = makeEnv({ presets: ['vssaros-kb-expert'] });
	try {
		reg(env, '知识库', 'vssaros:kb');
		await env.service.load();
		for (const [sid, blank, listed] of [['sess-ok', true, true], ['sess-talk', false, false]]) {
			env.sessionsById[sid] = { id: sid, blank, cwd: 'G:/x', projectionValues: {} };
			if (listed) { env.wsItems[0].sessionIds.push(sid); }
			await env.service.bindSession('vssaros/kb', sid);
			env.service.dockTo('vssaros/kb', sid);
			env.service.diagnoseDock('vssaros/kb', sid);
			await tick(80);
		}
		eq('⑭ 已收录的 / 有内容的会话 ⇒ 都不换（不打扰、不丢上下文）', env.calls.create.length, 0);
	} finally { env.restore(); }
}

// ── ⑮ 新会话建在**用户当前工作区** ─────────────────────────────────────────────────────────
{
	const env = makeEnv({
		presets: ['vssaros-marketplace-bot'],
		wsItems: [
			{ workspaceId: 'ws-first', title: 'Saros-agents-pocket', path: 'G:/SarosWorkspace/Saros-agents-pocket', sessionIds: [] },
			{ workspaceId: 'ws-current', title: 'sarosis-agents-client', path: 'G:/SarosWorkspace/sarosis-agents-client', sessionIds: ['s-main'] },
		],
	});
	try {
		await env.service.load();
		env.sessionsById['s-main'] = { id: 's-main', blank: false, cwd: 'G:/SarosWorkspace/sarosis-agents-client', retainedBy: { mainView: 1 }, projectionValues: {} };
		reg(env, '商城', 'vssaros:marketplace');
		const m = await openWorkbench(env, 'vssaros/marketplace');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑮ 新会话建在当前主视图会话所在的工作区', env.calls.create[0] && env.calls.create[0].workspaceId, 'ws-current');
		await m.unmount();
	} finally { env.restore(); }
}
{
	const env = makeEnv({
		presets: ['vssaros-marketplace-bot'],
		wsItems: [
			{ workspaceId: 'ws-first', title: 'A', path: 'G:/a', sessionIds: [] },
			{ workspaceId: 'ws-recent', title: 'B', path: 'G:/b', sessionIds: [] },
		],
	});
	try {
		await env.service.load();
		reg(env, '商城', 'vssaros:marketplace');
		await env.service.bindSession('vssaros/marketplace', 's-prev');
		env.wsItems[1].sessionIds.push('s-prev');
		const m = await openWorkbench(env, 'vssaros/marketplace');
		await click(m.container.querySelector('[data-vssaros-wb-new-session]'));
		eq('⑮ 没有主视图会话 ⇒ 用它上次所在的工作区', env.calls.create[0] && env.calls.create[0].workspaceId, 'ws-recent');
		await m.unmount();
	} finally { env.restore(); }
}

// ── ⑯ 归属不可改（服务端 validateState 会拒）──────────────────────────────────────────────────
{
	const env = makeEnv({ presets: [] });
	try {
		reg(env, '知识库', 'vssaros:kb');
		reg(env, '商城', 'vssaros:marketplace');
		await env.service.load();
		await env.service.bindSession('vssaros/kb', 's-x');
		let error = null;
		try { await env.service.bindSession('vssaros/marketplace', 's-x'); } catch (e) { error = e; }
		truthy('⑯ 别的工作台的会话不能改绑（空会话也一样）', !!error && /已属于另一个工作台/.test(String(error.message)));
		eq('⑯ 归属仍是原来的工作台', env.service.state.sessionBindings['s-x'], 'vssaros/kb');
	} finally { env.restore(); }
}

console.log(problems ? `\n[check-workbench-assistant] ✗ ${problems} 项不通过` : '\n[check-workbench-assistant] ✓ 通过');
process.exit(problems ? 1 : 0);
