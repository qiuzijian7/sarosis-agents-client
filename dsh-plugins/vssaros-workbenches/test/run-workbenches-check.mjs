#!/usr/bin/env node
// @vssaros/dsh-workbenches 自检（纯 Node、不联网、不起 Host）。
//   ① state.js：归属不可改/不可删、新归属需已添加、删除工作台保留笔记/可见性、revision 409、损坏数据 500、原子写不留临时文件；
//   ② client.js：register 校验逐条照官方（抛异常）、身份规范化、重复注册抛错、注销函数、open/leave 走 layout.selectPanel；
//   ③ 服务端 apply：provide desktopWorkbenchOwnership + 两条路由；config.root 为空时不注册（如实告警）。
//   ④ localInstall.js：工作台包校验与解包（路径穿越 / 缺 patch / 缺入口 / 大小上限）。
// 用法：node dsh-plugins/vssaros-workbenches/test/run-workbenches-check.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createStateStore, emptyState, validateState } from '../lib/state.js';
import { apply as applyServer, checkLocalWorkbenchTool, localWorkbenchInstallTool } from '../lib/index.js';
import { compareVersions, extractWorkbenchPackage, installedVersionOf, pendingRestartRecords, readInstallRecords, recordLocalInstall, safeEntryName } from '../lib/localInstall.js';
// （makeTar / externalFiles 在文件下方定义；用到它们的测试在其后，函数声明/常量均已就绪）

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const results = [];
async function t(name, fn) {
	try { await fn(); pass++; results.push(`  ✓ ${name}`); }
	catch (e) { results.push(`  ✗ ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 3).join('\n      ')}`); }
}

const A = 'vssaros/scheduler';
const B = 'acme/board';
const base = () => Object.assign(emptyState(), { added: [A, B] });

// ── ① state ──────────────────────────────────────────────────────────────
await t('合法状态通过；空状态通过', () => { validateState(emptyState()); validateState(base()); });
await t('未知字段 ⇒ 抛', () => assert.throws(() => validateState({ ...emptyState(), extra: 1 }), /未知字段/));
await t('身份必须是 owner/repo（大写/缺斜杠 ⇒ 抛）', () => {
	assert.throws(() => validateState({ ...emptyState(), added: ['Acme/Board'] }));
	assert.throws(() => validateState({ ...emptyState(), added: ['scheduler'] }));
});
await t('pinned/active 必须已添加', () => {
	assert.throws(() => validateState({ ...emptyState(), pinned: [A] }), /置顶/);
	assert.throws(() => validateState({ ...emptyState(), active: A }), /当前工作台/);
});
await t('★ 既有会话归属不可改', () => {
	const prev = { ...base(), sessionBindings: { s1: A } };
	assert.throws(() => validateState({ ...base(), sessionBindings: { s1: B } }, prev), /不能改变或删除/);
});
await t('★ 既有会话归属不可删', () => {
	const prev = { ...base(), sessionBindings: { s1: A } };
	assert.throws(() => validateState({ ...base(), sessionBindings: {} }, prev), /不能改变或删除/);
});
await t('★ 新归属只能指向已添加的工作台', () => {
	assert.throws(() => validateState({ ...emptyState(), added: [A], sessionBindings: { s2: B } }, { ...emptyState(), added: [A] }), /已添加/);
});
await t('移除工作台必须保留笔记与工作区可见性', () => {
	const prev = { ...base(), notes: { [A]: 'n' }, hiddenWorkspaces: { [A]: ['w1'] } };
	assert.throws(() => validateState({ ...base(), hiddenWorkspaces: { [A]: ['w1'] } }, prev), /笔记/);
	assert.throws(() => validateState({ ...base(), notes: { [A]: 'n' } }, prev), /可见性/);
});
await t('recentSessions 必须属于它的工作台', () => {
	assert.throws(() => validateState({ ...base(), sessionBindings: { s1: B }, recentSessions: { [A]: 's1' } }), /最近会话/);
});

const dir = mkdtempSync(join(tmpdir(), 'vss-wb-state-'));
try {
	const store = createStateStore(dir);
	await t('首次读 = revision 0 + 空状态', async () => {
		const r = await store.read();
		assert.equal(r.revision, 0);
		assert.deepEqual(r.state, emptyState());
	});
	await t('写入后 revision+1，磁盘内容一致，且不留临时文件', async () => {
		const r = await store.write({ revision: 0, state: { ...emptyState(), added: [A] } });
		assert.equal(r.revision, 1);
		const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
		assert.equal(disk.revision, 1);
		assert.deepEqual(disk.state.added, [A]);
		assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.tmp')), []);
	});
	await t('★ revision 过期 ⇒ 409（乐观锁）', async () => {
		await assert.rejects(store.write({ revision: 0, state: emptyState() }), e => e.status === 409);
	});
	await t('★ 写入也走归属校验（改归属 ⇒ 400，磁盘不变）', async () => {
		await store.write({ revision: 1, state: { ...emptyState(), added: [A, B], sessionBindings: { s1: A } } });
		await assert.rejects(store.write({ revision: 2, state: { ...emptyState(), added: [A, B], sessionBindings: { s1: B } } }), e => e.status === 400);
		assert.equal((await store.read()).state.sessionBindings.s1, A);
	});
	await t('★ 损坏的 state.json ⇒ 500，且绝不静默重置', async () => {
		writeFileSync(join(dir, 'state.json'), '{ broken');
		await assert.rejects(store.read(), e => e.status === 500);
		await assert.rejects(store.write({ revision: 0, state: emptyState() }), e => e.status === 500);
		assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '{ broken');
	});
} finally {
	rmSync(dir, { recursive: true, force: true });
}

// ── ② client ─────────────────────────────────────────────────────────────
function loadClient() {
	let mod = null;
	// ⚠ 2026-11-02：`client.js` 的深链 effect 会读 `window.location`（`?wb=` / `#wb=`），
	// 假 window 少了 location ⇒ apply() 直接抛，后面 12 条断言全部连锁失败（基线 18/30）。
	// 这里补一个只读 location，把"测试基建缺口"和"产品行为"分开。
	const sandboxWindow = {
		__ModuleLoader__: { load: ({ factory }) => { mod = factory(require); } },
		location: { search: '', hash: '', origin: 'http://127.0.0.1:1' },
	};
	const fakeReact = { createElement: (...a) => a, Component: class { }, Fragment: 'F', useRef: () => ({}), useLayoutEffect: () => { }, useState: init => [typeof init === 'function' ? init() : init, () => { }], useEffect: () => { } };
	const fakeReactDom = { createPortal: (node, el, key) => ['portal', { el, key }, node] };
	const require = name => {
		if (name === 'react') { return fakeReact; }
		if (name === 'react-dom') { return fakeReactDom; }
		throw new Error('unexpected require ' + name);
	};
	const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
	const fakeDocument = { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() { } } };
	new Function('window', 'globalThis', 'document', src)(sandboxWindow, {}, fakeDocument);
	return mod;
}
const client = loadClient();
const fakeCtx = () => {
	const calls = { selected: [], registered: [], disposed: 0, injected: [], slotRegs: [] };
	return {
		calls,
		slots: {
			register: (opts, comp) => { if (opts.name === 'main') { calls.registered.push(opts.key); } calls.slotRegs.push({ opts, comp }); return () => { if (opts.name === 'main') { calls.disposed++; } }; },
			inject: (name, factory) => { calls.injected.push(name); return factory(); },
		},
		layout: { selectPanel: key => calls.selected.push(key) },
	};
};
const Comp = () => null;

await t('身份规范化：vssaros:<m> → vssaros/<m>；GitHub → 小写 owner/repo', () => {
	assert.equal(client.identityOf('vssaros:scheduler'), 'vssaros/scheduler');
	assert.equal(client.identityOf('https://github.com/Acme/Board.git'), 'acme/board');
	assert.throws(() => client.identityOf('https://gitlab.com/a/b'));
	assert.throws(() => client.identityOf('vssaros:Bad Name'));
});
await t('register 校验（每条官方规则一个反例，都抛）', () => {
	const ok = { title: 'x', repository: 'vssaros:x' };
	const bad = [
		[null, Comp], [{ repository: 'vssaros:x' }, Comp], [ok, 'not-a-component'],
		[{ ...ok, customFrame: 'yes' }, Comp], [{ ...ok, headerLayout: 'tight' }, Comp],
		[{ ...ok, layout: { businessSide: 'top' } }, Comp], [{ ...ok, layout: { businessWidth: 0.2 } }, Comp],
		[{ ...ok, layout: { businessWidth: 0.71 } }, Comp], [{ ...ok, repository: 'https://gitlab.com/a/b' }, Comp],
	];
	for (const [d, c] of bad) { assert.throws(() => client.normalize(d, c), undefined, JSON.stringify(d)); }
	assert.ok(client.normalize({ ...ok, layout: { businessWidth: 0.25 } }, Comp));
	assert.ok(client.normalize({ ...ok, layout: { businessWidth: 0.7 } }, Comp));
});
await t('缺省值同官方：businessSide=right / businessWidth=0.36 / headerLayout=default', () => {
	const e = client.normalize({ title: 'x', repository: 'vssaros:x' }, Comp);
	assert.deepEqual(e.layout, { businessSide: 'right', businessWidth: 0.36 });
	assert.equal(e.headerLayout, 'default');
	assert.equal(e.customFrame, false);
	assert.equal(e.panel, 'vssaros-wb:vssaros/x');
});

// 拿到 Workbenches 类：apply 用假 ctx 跑一遍，从 reflect.provide 截获 service
function serviceOf() {
	const ctx = fakeCtx();
	let service = null;
	ctx.effect = fn => fn();
	ctx.reflect = { provide: (name, svc) => { if (name === 'desktopWorkbenches') { service = svc; } return () => { }; } };
	const g = globalThis;
	const savedFetch = g.fetch;
	g.fetch = async () => ({ ok: true, json: async () => ({ revision: 0, state: emptyState() }) });
	try { client.apply(ctx); } finally { g.fetch = savedFetch; }
	return { service, ctx };
}
await t('register → 注册 main keyed 面板；重复注册抛；注销函数撤面板', () => {
	const { service, ctx } = serviceOf();
	assert.ok(service, 'apply 必须 provide desktopWorkbenches');
	const dispose = service.register({ title: '定时任务', repository: 'vssaros:scheduler' }, Comp);
	assert.deepEqual(ctx.calls.registered, ['vssaros-wb:vssaros/scheduler']);
	assert.throws(() => service.register({ title: 'again', repository: 'vssaros:scheduler' }, Comp), /Duplicate/);
	assert.equal(service.getSnapshot().workbenches.length, 1);
	dispose();
	assert.equal(ctx.calls.disposed, 1);
	assert.equal(service.getSnapshot().workbenches.length, 0);
	dispose(); // 二次调用无副作用
	assert.equal(ctx.calls.disposed, 1);
});
// ── 注册失败可见（2026-11-02，对齐 dsh-desktop 的 registrationFailures）────────────────
// 为什么必须守：register 失败只抛给调用方的 `ctx.effect` ⇒ 异常进控制台，**界面上什么都没有**，
// 用户看到的是「装了、重启了、启动器里还是没有」——"装了没出现"的头号原因。
await t('注册失败：记录来源 + 阶段 + 原因，并**照旧抛**（不能变成静默跳过）', () => {
	const { service } = serviceOf();
	// ① 校验不过（identity）
	assert.throws(() => service.register({ repository: 'vssaros:broken' }, Comp), /Invalid workbench registration/);
	const one = service.getSnapshot().registrationFailures;
	assert.equal(one.length, 1, '失败必须进快照（界面据此显示）');
	assert.equal(one[0].source, 'vssaros:broken', '来源要报用户认识的名字');
	assert.equal(one[0].stage, 'identity');
	assert.match(one[0].message, /Invalid workbench registration/);
	// ② 身份重复（duplicate）——用另一个来源名注册同一个身份
	service.register({ title: 'ok', repository: 'vssaros:dup' }, Comp);
	assert.throws(() => service.register({ title: 'ok2', repository: 'vssaros:dup' }, Comp), /Duplicate/);
	const dup = service.getSnapshot().registrationFailures.find(f => f.stage === 'duplicate');
	assert.ok(dup, '重复注册要被标成 duplicate，不能和校验失败混为一谈');
	// ③ 面板挂载失败（slot）
	const broken = serviceOf();
	broken.ctx.slots.register = () => { throw new Error('slots 挂了'); };
	assert.throws(() => broken.service.register({ title: 'x', repository: 'vssaros:slot' }, Comp), /slots 挂了/);
	const slot = broken.service.getSnapshot().registrationFailures.find(f => f.stage === 'slot');
	assert.ok(slot, '面板挂载失败也要记');
	assert.equal(broken.service.getSnapshot().workbenches.length, 0, '挂载失败不能留下半登记');
});
await t('注册失败：同一个来源后来注册成功 ⇒ 记录被清掉（不留过期结论）', () => {
	const { service } = serviceOf();
	assert.throws(() => service.register({ repository: 'vssaros:retry' }, Comp));
	assert.equal(service.getSnapshot().registrationFailures.length, 1);
	service.register({ title: '终于好了', repository: 'vssaros:retry' }, Comp);
	assert.deepEqual(service.getSnapshot().registrationFailures, [], '成功后必须清掉（否则用户一直看到已不成立的失败）');
});

await t('open → selectPanel(面板 key)；leave → selectPanel(null)；未注册的 open 返回 false', () => {
	const { service, ctx } = serviceOf();
	service.register({ title: 'S', repository: 'vssaros:scheduler' }, Comp);
	assert.equal(service.open('vssaros/nope'), false);
	assert.equal(service.open('vssaros/scheduler'), true);
	assert.equal(service.current(), 'vssaros/scheduler');
	service.leave();
	assert.deepEqual(ctx.calls.selected, ['vssaros-wb:vssaros/scheduler', null]);
	assert.equal(service.current(), null);
});

// ── ②b 会话接口（2026-10-22）：建会话 ⇒ 登记归属 ⇒ 切到原生对话；归属不可改 ──────────────
function sessionHarness() {
	const { service, ctx } = serviceOf();
	const writes = [];
	const sessions = { s1: { retainedBy: { mainView: 0 } } };
	ctx.sessions = {
		list: { getSnapshot: () => ({ byId: sessions }) },
		refresh: async () => { },
		create: async ({ workspaceId }) => { const id = 'new-' + String(workspaceId).replace(/[^A-Za-z0-9-]/g, '-'); sessions[id] = { retainedBy: { mainView: 0 } }; return id; },
	};
	ctx.workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', path: 'C:/p', title: 'p', sessionIds: ['s1'] }] }) }, create: async ({ path }) => ({ workspaceId: 'w:' + path }) };
	const opened = [];
	ctx.uiWorkspace = { openSession: id => { opened.push(id); sessions[id] = { retainedBy: { mainView: 1 } }; }, pickDirectory: async () => 'C:/picked' };
	service.state = emptyState();
	service.revision = 0;
	const g = globalThis;
	const run = async fn => {
		const saved = g.fetch;
		g.fetch = async (url, init) => {
			const body = JSON.parse(init.body);
			validateState(body.state, service.state);
			writes.push(body.state);
			return { ok: true, json: async () => ({ revision: body.revision + 1, state: body.state }) };
		};
		try { return await fn(); } finally { g.fetch = saved; }
	};
	service.register({ title: 'XHS', repository: 'https://github.com/sara/xhs', customFrame: true }, Comp);
	return { service, ctx, opened, writes, run };
}
await t('会话接口：没打开工作台 ⇒ 拒绝（不替别人建会话）', async () => {
	const { service, run } = sessionHarness();
	await run(async () => { await assert.rejects(() => service.newSession('w1'), /请先打开/); });
});
await t('★ 整页工作台 newSession：登记归属 ⇒ 对话停靠在工作台里，**不切走**（真机：点 AI 协助后小红书被关掉）', async () => {
	const { service, ctx, opened, run } = sessionHarness();
	service.activate('sara/xhs');
	const id = await run(() => service.newSession('w1'));
	assert.equal(id, 'new-w1');
	assert.equal(service.state.sessionBindings['new-w1'], 'sara/xhs');
	assert.equal(service.state.recentSessions['sara/xhs'], 'new-w1');
	assert.deepEqual(opened, [], '不许 uiWorkspace.openSession（它会 selectPanel(null) 把工作台换走）');
	assert.ok(!ctx.calls.selected.includes(null), '不许 selectPanel(null)');
	assert.equal(service.ownsSession('new-w1'), true);
	assert.equal(service.currentSession(), 'new-w1', 'currentSession = 停靠会话（第三方据此判断"已经在对话里"）');
	assert.equal(service.dockTarget(), null, '还没有停靠点 ⇒ 不渲染');
	const el = { tag: 'dock' };
	const off = service.registerDock('sara/xhs', el);
	// 2026-11-02：dockTarget 多了 `mode`（inline = 停在工作台页面里；split = 停在宿主分栏左栏）
	assert.deepEqual(service.dockTarget(), { id: 'sara/xhs', element: el, sessionId: 'new-w1', mode: 'inline' });
	off();
	assert.equal(service.dockTarget(), null, '停靠点卸载 ⇒ 不渲染');
});
await t('停靠目标只认前台工作台；会话打不开 ⇒ 判死后回到"开始对话"', async () => {
	const { service, run } = sessionHarness();
	service.register({ title: 'Other', repository: 'https://github.com/a/other', customFrame: true }, Comp);
	service.activate('sara/xhs');
	await run(() => service.newSession('w1'));
	const el = {};
	service.registerDock('sara/xhs', el);
	service.activate('a/other');
	assert.equal(service.dockTarget(), null, '前台换成别的工作台 ⇒ 不往小红书的停靠点渲染');
	service.activate('sara/xhs');
	assert.equal(service.dockTarget()?.sessionId, 'new-w1');
	service.markDead('new-w1', new Error('session archived'));
	assert.equal(service.dockTarget(), null);
	assert.equal(service.dockedSessionOf('sara/xhs'), null);
	assert.match(service.dockError, /archived/);
});
await t('★ 标准分栏工作台（默认）：newSession 停靠在宿主左栏，**不切走**（2026-11-02 对齐官方 §4.1）', async () => {
	const { service, ctx, opened, run } = sessionHarness();
	service.register({ title: 'Std', repository: 'https://github.com/a/std' }, Comp);
	service.activate('a/std');
	assert.equal(service.conversationMode('a/std'), 'split', '未声明 customFrame ⇒ split');
	const id = await run(() => service.newSession('w1'));
	assert.deepEqual(opened, [], 'split 也不许 uiWorkspace.openSession（那会 selectPanel(null) 切走）');
	assert.ok(!ctx.calls.selected.includes(null), '不许 selectPanel(null)');
	const box = { tag: 'split-left' };
	const off = service.registerSplitDock('a/std', box);
	assert.deepEqual(service.dockTarget(), { id: 'a/std', element: box, sessionId: id, mode: 'split' });
	off();
	assert.equal(service.dockTarget(), null, '左栏卸载 ⇒ 不渲染');
});
await t('标准分栏可显式退出（splitConversation:false）⇒ 回到"切到原生对话"的旧行为', async () => {
	const { service, ctx, opened, run } = sessionHarness();
	service.register({ title: 'F', repository: 'https://github.com/a/f', splitConversation: false }, Comp);
	service.activate('a/f');
	assert.equal(service.conversationMode('a/f'), 'detach');
	assert.equal(service.docksConversation('a/f'), false);
	const id = await run(() => service.newSession('w1'));
	assert.deepEqual(opened, [id]);
	assert.equal(ctx.calls.selected.at(-1), null);
});
await t('★ 标准分栏左栏只认**归属本工作台**的会话（不抢普通会话）', () => {
	const { service, ctx } = sessionHarness();
	service.register({ title: 'Std', repository: 'https://github.com/a/std' }, Comp);
	// 让 s1 成为"主视图正在显示的会话"
	ctx.sessions.list.getSnapshot().byId.s1.retainedBy.mainView = 1;
	service.state.sessionBindings = { s1: 'other/wb' };
	service.activate('a/std');
	assert.equal(service.splitSessionOf('a/std'), null, '别的工作台的会话绝不显示在分栏里');
	service.state.sessionBindings = { s1: 'a/std' };
	assert.equal(service.splitSessionOf('a/std'), 's1', '主视图会话归属本工作台 ⇒ 落到左栏');
});
await t('会话接口：newWorkspaceSession 让用户选目录 ⇒ 建工作区 ⇒ 新会话；用户取消 ⇒ undefined', async () => {
	const { service, ctx, run } = sessionHarness();
	service.activate('sara/xhs');
	assert.equal(await run(() => service.newWorkspaceSession()), 'new-w-C--picked');
	ctx.uiWorkspace.pickDirectory = async () => undefined;
	assert.equal(await run(() => service.newWorkspaceSession()), undefined);
});
await t('会话接口：ensureSession 要 folder；已有会话归属别人 ⇒ 拒绝（归属不可改）', async () => {
	const { service, run } = sessionHarness();
	service.activate('sara/xhs');
	await run(async () => {
		await assert.rejects(() => service.ensureSession({}), /业务项目文件夹/);
		service.state.sessionBindings.s1 = 'other/wb';
		await assert.rejects(() => service.ensureSession({ sessionId: 's1' }), /另一个工作台/);
		assert.equal(await service.ensureSession({ folder: 'D:/proj' }), 'new-w-D--proj');
	});
});
await t('会话停靠：根覆盖层条目声明 session 作用域子槽（拿 SessionProvider 的唯一条件），子槽里注册对话面板', () => {
	const { ctx } = serviceOf();
	const overlay = ctx.calls.slotRegs.find(r => r.opts.name === 'shell.overlay');
	assert.ok(overlay, '必须注册进 shell.overlay（根布局常驻渲染）');
	assert.equal(typeof overlay.opts.order, 'number', 'list 槽必须给 order');
	assert.deepEqual(overlay.opts.children, { 'vssaros.workbench.conversation': { kind: 'single', scope: 'session' } });
	const panel = ctx.calls.slotRegs.find(r => r.opts.name === 'vssaros.workbench.conversation');
	assert.ok(panel && typeof panel.comp === 'function', '子槽里必须有对话面板');
});
await t('customFrame 组件拿到 active 与 conversation 停靠点；标准分栏不给', () => {
	const seen = [];
	const { service } = serviceOf();
	const Probe = props => { seen.push(Object.keys(props).sort().join(',')); return null; };
	service.register({ title: 'C', repository: 'https://github.com/a/c', customFrame: true }, Probe);
	service.register({ title: 'S', repository: 'https://github.com/a/s' }, Probe);
	const frameOf = id => client.__Frame({ service, entry: service.providers.get(id) });
	// 夹具里 createElement 返回 [type, props, ...children] ⇒ 沿 children 往下找到业务组件那一层
	const find = (node, type) => { if (!Array.isArray(node)) { return null; } if (node[0] === type) { return node; } for (const c of node.slice(2)) { const hit = find(c, type); if (hit) { return hit; } } return null; };
	const c = find(frameOf('a/c'), Probe);
	const s = find(frameOf('a/s'), Probe);
	assert.deepEqual(Object.keys(c[1]).sort(), ['active', 'conversation', 'entry', 'service']);
	assert.deepEqual(Object.keys(s[1]).sort(), ['entry', 'service']);
});

// ── ③ server apply ───────────────────────────────────────────────────────
await t('嵌入式：activate 记前台但不切面板；View 组件已提供；未注册的 activate 返回 false', () => {
	const { service, ctx } = serviceOf();
	service.register({ title: 'S', repository: 'vssaros:scheduler' }, Comp);
	assert.equal(typeof service.View, 'function');
	assert.equal(service.activate('vssaros/nope'), false);
	assert.equal(service.activate('vssaros/scheduler'), true);
	assert.equal(service.current(), 'vssaros/scheduler');
	assert.deepEqual(ctx.calls.selected, []);
});
await t('服务端：provide desktopWorkbenchOwnership + 注册 state / state/write 两条路由', async () => {
	const d = mkdtempSync(join(tmpdir(), 'vss-wb-srv-'));
	try {
		const routes = [];
		const provided = {};
		const ctx = {
			effect: fn => fn(),
			reflect: { provide: (n, s) => { provided[n] = s; return () => { }; } },
			connection: { fetch: { register: r => routes.push(r) } },
			// `/link` 要 `webServer.port`（2026-10-26 真机：只 inject connection 时 port 是 undefined）
			webServer: { port: 12345 },
		};
		// 2026-11-02：服务端还会 inject(['tools']) 注册 install_local_workbench
		const tools = [];
		ctx.tools = { register: (definition) => { tools.push(definition); return () => { }; } };
		ctx.inject = (names, cb) => {
			if (names.includes('connection')) { assert.deepEqual(names, ['connection', 'webServer']); cb(ctx); return; }
			if (names.includes('tools')) { cb(ctx); return; }
			// 2026-11-02：还会 inject(['vssarosBridge']) 显式声明"控制桥可选"（dshPluginPackages 守卫要求）。
			// 这里**不回调**（= 组合里没装桥）⇒ 工具应如实报"没有可用的控制桥"。
			if (names.includes('vssarosBridge')) { return; }
			throw new Error('unexpected inject ' + JSON.stringify(names));
		};
		applyServer(ctx, { root: d });
		assert.deepEqual(tools.map(t => t.name).sort(), ['check_local_workbench', 'install_local_workbench'], '必须注册安装工具与干跑检查工具');
		const tool = tools.find(t => t.name === 'install_local_workbench');
		assert.deepEqual(tool.parameters.required, ['path']);
		await assert.rejects(() => tool.execute({ path: 'relative/thing.tgz' }), /绝对路径/);
		// 没有控制桥时**如实报错**（不许假装装好了）
		await assert.rejects(() => tool.execute({ path: d + '/x.tgz' }), /没有可用的控制桥/);
		// 2026-11-02：/link（带 token 深链）与 /development-guide（随包规范）也是本服务注册的
		assert.deepEqual(routes.map(r => r.methods[0] + ' ' + r.path).sort(), [
			'GET /api/vssaros-workbenches/development-guide',
			'GET /api/vssaros-workbenches/install-status',
			'GET /api/vssaros-workbenches/link',
			'GET /api/vssaros-workbenches/state',
			'POST /api/vssaros-workbenches/state/write',
		]);
		const own = await provided.desktopWorkbenchOwnership.read();
		assert.deepEqual(own, { revision: 0, sessionBindings: {}, added: [] });
		const routeOf = (method, path) => routes.find(r => r.methods[0] === method && r.path === path);
		const res = await routeOf('GET', '/api/vssaros-workbenches/state').fetch();
		assert.equal(res.status, 200);
		const body = JSON.stringify({ revision: 0, state: { ...emptyState(), added: [A] } });
		const w = await routeOf('POST', '/api/vssaros-workbenches/state/write').fetch(new Request('http://x/', { method: 'POST', body, headers: { 'content-length': String(body.length) } }));
		assert.equal(w.status, 200);
		assert.deepEqual((await provided.desktopWorkbenchOwnership.read()).added, [A]);
		const stale = await routeOf('POST', '/api/vssaros-workbenches/state/write').fetch(new Request('http://x/', { method: 'POST', body }));
		assert.equal(stale.status, 409);
		// 规范路由：必须能读到随包规范正文（Agent 在 dsh 侧取规范只用这一个 URL）
		const guide = await routeOf('GET', '/api/vssaros-workbenches/development-guide').fetch(new Request('http://x/api/vssaros-workbenches/development-guide'));
		assert.equal(guide.status, 200);
		assert.match(guide.headers.get('content-type'), /text\/markdown/);
		assert.match(await guide.text(), /工作台/);
		// 规范版本（2026-11-02）：`<插件版本>/<内容 sha256 前 8 位>`。
		// 为什么要它：正文只有日期 ⇒ Agent 汇报“按规范做的”不可验证；内容哈希参与版本
		// ⇒ 只改文档不改插件版本时这个值也会变（挡“文档漂了但版本没动”）。
		const ver = guide.headers.get('x-workbench-guide-version');
		assert.match(String(ver), /^\d+\.\d+\.\d+\/[0-9a-f]{8}$/, '响应头必须是 <version>/<sha8>：' + ver);
		const again = await routeOf('GET', '/api/vssaros-workbenches/development-guide').fetch(new Request('http://x/'));
		assert.equal(again.headers.get('x-workbench-guide-version'), ver, '同一份内容必须给同一个版本号');
		// 生效态路由（2026-11-02）：没有记录 ⇒ 空；有「刚装、待重启」的记录 ⇒ pending 里有它；
		// 记录必须来自**工具真实的回执形状**（packageName，不是 name）——这条是回归：
		// 之前只读 `name` ⇒ 真实调用时记成空串，pending 永远是空。
		const status = routeOf('GET', '/api/vssaros-workbenches/install-status');
		const empty = await (await status.fetch()).json();
		assert.deepEqual(empty.pending, []);
		assert.ok(Date.parse(empty.hostStartedAt) <= Date.now(), 'hostStartedAt 必须是过去的时间');
		await recordLocalInstall(d, { packageName: '@me/hello', version: '1.2.3', application: 'restart-required' });
		const after = await (await status.fetch()).json();
		assert.deepEqual(after.pending.map(p => [p.name, p.version]), [['@me/hello', '1.2.3']], '工具形状的记录必须被认出包名');
	} finally { rmSync(d, { recursive: true, force: true }); }
});
await t('生效态：pendingRestartRecords 判据（Host 启动时间 vs 记录时间，按包取最新）', () => {
	const T0 = Date.parse('2026-11-02T10:00:00Z');   // 假定 Host 启动时间
	const before = '2026-11-02T09:00:00Z';             // 启动前装的 ⇒ 已被这次启动加载
	const after1 = '2026-11-02T10:05:00Z';
	const after2 = '2026-11-02T10:06:00Z';
	const rec = (name, application, at, version = '1.0.0') => ({ name, version, application, at });
	// 启动之后装、待重启 ⇒ pending
	assert.deepEqual(pendingRestartRecords([rec('a', 'restart-required', after1)], T0).map(p => p.name), ['a']);
	// 启动之前装的 ⇒ 重启过了 ⇒ 不再提示（不需要"已读"状态）
	assert.deepEqual(pendingRestartRecords([rec('a', 'restart-required', before)], T0), []);
	// 同一个包后来又失败 / 取消 / 生效 ⇒ 顶掉更早的 restart-required（最新在前）
	for (const next of ['failed', 'cancelled', 'applied']) {
		assert.deepEqual(pendingRestartRecords([rec('a', next, after2, '1.0.1'), rec('a', 'restart-required', after1)], T0), [], next + ' 要顶掉旧结论');
	}
	// 不同的包互不影响
	assert.deepEqual(pendingRestartRecords([rec('b', 'failed', after2), rec('a', 'restart-required', after1)], T0).map(p => p.name), ['a']);
	// 脏数据不抛：缺包名 / 时间非法 / 非数组
	assert.deepEqual(pendingRestartRecords([{ application: 'restart-required', at: after1 }, rec('c', 'restart-required', 'not-a-date'), null], T0), []);
	assert.deepEqual(pendingRestartRecords(undefined, T0), []);
});
await t('安装记录：工具回执形状（packageName）与历史形状（name）都认；没有包名不写', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-rec2-'));
	try {
		assert.equal(await recordLocalInstall(dir, { packageName: '@me/a', version: '1.0.0', application: 'applied' }), true);
		assert.equal(await recordLocalInstall(dir, { packageName: '@me/b', version: '1.0.0', application: 'applied' }), true);
		const rows = await readInstallRecords(dir);
		assert.deepEqual(rows.map(r => r.name).sort(), ['@me/a', '@me/b'], '同版本的不同包不能互相覆盖');
		assert.equal(await recordLocalInstall(dir, { version: '1.0.0', application: 'applied' }), false, '没有包名 ⇒ 不写');
		assert.deepEqual(await readInstallRecords(join(dir, 'nope')), [], '读不到 ⇒ 空数组，不抛');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('生效态：客户端启动器的提示接线（路由 / 锚点 / 老 Host 容错）', () => {
	const nav = readFileSync(new URL('../../vssaros-chat-surface/lib/client.workbenchNav.js', import.meta.url), 'utf8');
	assert.match(nav, /\/api\/vssaros-workbenches\/install-status/);
	assert.match(nav, /data-vssaros-restart-pending/);
	assert.match(nav, /重启 Harness/);
	// 老 Host 没有这条路由 ⇒ 不能让启动器报错（提示只是增强）
	assert.match(nav, /r && r\.ok \? r\.json\(\) : null/);
	assert.match(nav, /refreshRestartPending\(\);/);
});
await t('服务端：config.root 为空 ⇒ 不注册任何路由（不猜目录）', () => {
	const routes = [];
	const warns = [];
	applyServer({ logger: () => ({ warn: m => warns.push(m) }), inject: (n, cb) => cb({ connection: { fetch: { register: r => routes.push(r) } } }), effect: fn => fn(), reflect: { provide() { } } }, { root: '' });
	assert.equal(routes.length, 0);
	assert.equal(warns.length, 1);
});

// ── ④ 本地安装包校验（2026-11-02：install_local_workbench 的前置门槛）──────────
/** 造一个最小 ustar（只写普通文件 + 结尾 1024 个 0）。 */
function makeTar(files) {
	const blocks = [];
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content, 'utf8');
		const header = Buffer.alloc(512, 0);
		header.write(name, 0, 100, 'utf8');
		header.write('0000644\0', 100, 8, 'ascii');
		header.write('0000000\0', 108, 8, 'ascii');
		header.write('0000000\0', 116, 8, 'ascii');
		header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
		header.write('00000000000\0', 136, 12, 'ascii');
		header.write('        ', 148, 8, 'ascii');
		header.write('0', 156, 1, 'ascii');
		header.write('ustar\0', 257, 6, 'ascii');
		header.write('00', 263, 2, 'ascii');
		let sum = 0;
		for (const byte of header) { sum += byte; }
		header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
	}
	blocks.push(Buffer.alloc(1024, 0));
	return Buffer.concat(blocks);
}
const wbManifest = (over = {}) => JSON.stringify({
	name: '@acme/wb-demo', version: '1.2.3', main: 'lib/index.js',
	exports: { '.': './lib/index.js', './client': './lib/client.js' },
	dsh: { bundle: { patch: ['./cordis.patch.yml'] }, client: { platform: 'web' } },
	...over,
});
const goodFiles = () => ({
	'package/package.json': wbManifest(),
	'package/cordis.patch.yml': '- insert: []\n',
	'package/lib/index.js': 'export const name = "demo";\n',
	'package/lib/client.js': 'module.exports = {};\n',
});
await t('safeEntryName：拒绝绝对路径 / 盘符 / 路径穿越', () => {
	assert.equal(safeEntryName('./a/b.js'), 'a/b.js');
	for (const bad of ['/etc/passwd', 'C:/win.ini', '../escape.js', 'a/../../b.js']) {
		assert.throws(() => safeEntryName(bad), /绝对路径|盘符|越界/, bad);
	}
});
await t('合法包：解包成功、剥掉 npm 的 package/ 前缀、认出 client 入口', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-pkg-'));
	try {
		const pkg = await extractWorkbenchPackage(gzipSync(makeTar(goodFiles())), join(dir, 'out'));
		assert.equal(pkg.name, '@acme/wb-demo');
		assert.equal(pkg.version, '1.2.3');
		assert.equal(pkg.hasClient, true);
		assert.ok(pkg.files.includes('package.json'), '根目录 package.json 必须落在包根');
		assert.equal(readFileSync(join(dir, 'out', 'lib', 'index.js'), 'utf8').includes('demo'), true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('缺 dsh.bundle.patch ⇒ 抛（那不是 dsh 插件包，装上去永远不会被加载）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-pkg-'));
	try {
		const files = goodFiles();
		files['package/package.json'] = wbManifest({ dsh: { client: { platform: 'web' } } });
		await assert.rejects(() => extractWorkbenchPackage(gzipSync(makeTar(files)), join(dir, 'o')), /dsh\.bundle\.patch/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('声明的 patch / 入口不在包里 ⇒ 抛（否则装上是空白）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-pkg-'));
	try {
		const noPatch = goodFiles();
		delete noPatch['package/cordis.patch.yml'];
		await assert.rejects(() => extractWorkbenchPackage(gzipSync(makeTar(noPatch)), join(dir, 'a')), /不在包里/);
		const noMain = goodFiles();
		delete noMain['package/lib/index.js'];
		await assert.rejects(() => extractWorkbenchPackage(gzipSync(makeTar(noMain)), join(dir, 'b')), /入口不在包里|不在包里/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('包内路径穿越 ⇒ 拒绝（zip/tar slip）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-pkg-'));
	try {
		const files = goodFiles();
		files['package/../../evil.js'] = 'x';
		await assert.rejects(() => extractWorkbenchPackage(gzipSync(makeTar(files)), join(dir, 'o')), /越界/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('缺 package.json / 包太大 ⇒ 抛', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-pkg-'));
	try {
		await assert.rejects(() => extractWorkbenchPackage(gzipSync(makeTar({ 'package/a.js': 'x' })), join(dir, 'o')), /没有 package\.json/);
		await assert.rejects(() => extractWorkbenchPackage(Buffer.alloc(9 * 1024 * 1024, 1), join(dir, 'p')), /包太大/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
// ── ④b 干跑检查 check_local_workbench（2026-11-02，P1-1）─────────────────────────
/** 一个「完全合规的外部工作台包」：有 client 入口、注入宿主、描述符走 package。 */
const externalFiles = (over = {}) => ({
	'package/package.json': wbManifest({
		name: '@me/ext-demo',
		dsh: { bundle: { patch: ['./cordis.patch.yml'] }, client: { platform: 'web', inject: ['@vssaros/dsh-workbenches'] } },
	}),
	'package/cordis.patch.yml': '- insert: []\n',
	'package/lib/index.js': 'export const name = "demo";\n',
	'package/lib/client.js': 'window.__ModuleLoader__.load({ id: "x", factory: () => ({}) });\n',
	'package/lib/client.demo.js': "desktopWorkbenches.register({ package: '@me/ext-demo', title: 'T' }, Panel);\n",
	...over,
});
const runCheck = async (files) => {
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-chk-'));
	try {
		const archive = join(dir, 'a.tgz');
		writeFileSync(archive, gzipSync(makeTar(files)));
		return await checkLocalWorkbenchTool().execute({ path: archive });
	} finally { rmSync(dir, { recursive: true, force: true }); }
};
await t('干跑：合规外部包 ⇒ ok，身份 = local:<包名>，且明说只验了结构 + 静态审计', async () => {
	const r = await runCheck(externalFiles());
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	assert.equal(r.packageName, '@me/ext-demo');
	assert.equal(r.identity, 'local:@me/ext-demo');
	assert.match(r.verified, /不含.*加载/, 'verified 必须声明没验什么（不许被说成「已验证可用」）');
	assert.deepEqual(r.errors, []);
	// 干跑回执带规范版本（Agent 交付时能报“按 vX/abcdef12 审计的”）
	assert.match(String(r.guideVersion), /^\d+\.\d+\.\d+\/[0-9a-f]{8}$/, '干跑回执必须带 guideVersion：' + r.guideVersion);
});
await t('干跑：每一类「装了也不对」都要报 error（并带原因）', async () => {
	// ⚠ `wbManifest` 的默认 exports 自带 `./client`——只覆盖 dsh 不会去掉它（第一版测试就栽在这：包本来合规）
	const noClient = await runCheck(externalFiles({ 'package/package.json': wbManifest({ name: '@me/ext-demo', exports: { '.': './lib/index.js' }, dsh: { bundle: { patch: ['./cordis.patch.yml'] }, client: { platform: 'web', inject: ['@vssaros/dsh-workbenches'] } } }) }));
	assert.equal(noClient.ok, false);
	assert.match(noClient.errors.join('|'), /exports\["\.\/client"\]/);
	const noInject = await runCheck(externalFiles({ 'package/package.json': wbManifest({ dsh: { bundle: { patch: ['./cordis.patch.yml'] }, client: { platform: 'web' } } }) }));
	assert.equal(noInject.ok, false);
	assert.match(noInject.errors.join('|'), /dsh\.client\.inject/);
	const missingClientFile = externalFiles();
	delete missingClientFile['package/lib/client.js'];
	const r3 = await runCheck(missingClientFile);
	assert.equal(r3.ok, false);
	assert.match(r3.errors.join('|'), /不在包里/);
	const bundledReact = await runCheck(externalFiles({ 'package/lib/client.js': '/* Minified React error # */ x()' }));
	assert.equal(bundledReact.ok, false);
	assert.match(bundledReact.errors.join('|'), /React/);
});
await t('没有 exports["./client"] 的包：结构校验不抛「空文件名」，hasClient=false，干跑给出真实原因', async () => {
	// 回归：以前对 `safeEntryName('')` 求值 ⇒ 抛「包里有空文件名」，真实原因（不是工作台包）被掩盖
	const files = externalFiles({ 'package/package.json': wbManifest({ exports: { '.': './lib/index.js' }, dsh: { bundle: { patch: ['./cordis.patch.yml'] }, client: { platform: 'web', inject: ['@vssaros/dsh-workbenches'] } } }) });
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-nocl-'));
	try {
		const pkg = await extractWorkbenchPackage(gzipSync(makeTar(files)), join(dir, 'o'));
		assert.equal(pkg.hasClient, false);
		const r = await runCheck(files);
		assert.equal(r.ok, false);
		assert.match(r.errors.join('|'), /不是工作台包/);
		assert.doesNotMatch(r.errors.join('|'), /空文件名/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('干跑：结构不合法是「检查结果」（ok:false + 原因），不是工具抛错', async () => {
	// 缺 dsh.bundle.patch、路径穿越、非 tgz、读不到文件——Agent 要读原因去改，抛异常它只会看到「工具失败」
	const files = externalFiles();
	files['package/package.json'] = wbManifest({ dsh: { client: { platform: 'web' } } });
	const noPatch = await runCheck(files);
	assert.equal(noPatch.ok, false);
	assert.match(noPatch.errors[0], /dsh\.bundle\.patch/);
	const evil = await runCheck(externalFiles({ 'package/../../evil.js': 'x' }));
	assert.equal(evil.ok, false);
	assert.match(evil.errors[0], /越界/);
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-chk2-'));
	try {
		const junk = join(dir, 'junk.tgz');
		writeFileSync(junk, 'not a tgz');
		const r = await checkLocalWorkbenchTool().execute({ path: junk });
		assert.equal(r.ok, false);
		assert.match(r.errors[0], /不是合法的 \.tgz/);
		const gone = await checkLocalWorkbenchTool().execute({ path: join(dir, 'nope.tgz') });
		assert.equal(gone.ok, false);
		assert.match(gone.errors[0], /读不到文件/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
	await assert.rejects(() => checkLocalWorkbenchTool().execute({ path: 'relative.tgz' }), /绝对路径/);
	await assert.rejects(() => checkLocalWorkbenchTool().execute({}), /需要 path/);
});
await t('干跑：warning 不阻断；能力扫描只看服务端文件（客户端 fetch 不算）', async () => {
	const r = await runCheck(externalFiles({
		'package/package.json': wbManifest({
			name: '@me/ext-demo',
			dependencies: { react: '^19.0.0' },
			dsh: { bundle: { patch: ['./cordis.patch.yml'] }, client: { platform: 'web', inject: ['@vssaros/dsh-workbenches'] } },
		}),
		'package/lib/index.js': "import { spawn } from 'node:child_process'; fetch('http://x'); ctx.tools.register({});",
		'package/lib/client.demo.js': "fetch('/api/x'); desktopWorkbenches.register({ package: '@me/ext-demo', title: 'T' }, P);",
	}));
	assert.equal(r.ok, true, '宿主单例依赖只是 warning，不该阻断');
	assert.match(r.warnings.join('|'), /dependencies 里带了宿主单例包 react/);
	for (const label of ['启动子进程', '向 AI 注册工具', '访问网络']) {
		assert.ok(r.capabilities.some(c => c.includes(label)), `应扫到：${label}`);
	}
	// 反例：只有客户端文件里有 fetch，服务端干净 ⇒ 不应报「访问网络」
	const clientOnly = await runCheck(externalFiles({ 'package/lib/client.demo.js': "fetch('/api/x'); desktopWorkbenches.register({ package: '@me/ext-demo', title: 'T' }, P);" }));
	assert.equal(clientOnly.capabilities.length, 0, '客户端 fetch 不是服务端能力');
});
await t('干跑：描述符没有 register( ⇒ warning；写了 repository 时按其自身口径出身份', async () => {
	const noRegister = await runCheck(externalFiles({ 'package/lib/client.demo.js': '// nothing here' }));
	assert.equal(noRegister.ok, true);
	assert.match(noRegister.warnings.join('|'), /没找到工作台注册调用/);
	const withRepo = await runCheck(externalFiles({ 'package/lib/client.demo.js': "desktopWorkbenches.register({ repository: 'vssaros:demo', title: 'T' }, P);" }));
	assert.equal(withRepo.identity, 'vssaros:demo');
});
await t('干跑：认得出「先把服务取到变量再注册」的写法（studio 是 `const dw = …; dw.register({…})`）', async () => {
	// 回归：2026-11-02 之前只认 `desktopWorkbenches.register(` 全名 ⇒ 这种写法被误判成「没注册」，
	// 作者看到假 warning、身份也推不出来（studio 本尊就是这么写的）
	// ⚠ 描述符也必须是**变量**：`dw.register({…})` 这种“别名的对象字面量”会被「只认对象字面量」的正则蒙对，
	//   验不出真正要防的那条（studio 与脚手架生成的都是 `register(DESCRIPTOR, Panel)`）。
	const viaAlias = await runCheck(externalFiles({
		'package/lib/client.demo.js': "const DESCRIPTOR = { package: '@me/ext-demo', title: 'T' };\nconst dw = scope.desktopWorkbenches;\nscope.effect(() => dw.register(DESCRIPTOR, Panel));\n",
	}));
	assert.deepEqual(viaAlias.warnings.filter(w => /没找到工作台注册调用/.test(w)), [], '不许误判成没注册');
	assert.equal(viaAlias.identity, 'local:@me/ext-demo');
	// 认错方向的边界：只是调了别的方法（不带 title 对象）不该被当成注册
	const notRegister = await runCheck(externalFiles({ 'package/lib/client.demo.js': "loader.register('./x.js');\n" }));
	assert.match(notRegister.warnings.join('|'), /没找到工作台注册调用/);
});
await t('干跑与真安装共用同一套结构校验（同一个坏包两边都被拒；干跑绝不写盘）', async () => {
	const bad = externalFiles({ 'package/../../evil.js': 'x' });
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-same-'));
	try {
		const archive = join(dir, 'bad.tgz');
		writeFileSync(archive, gzipSync(makeTar(bad)));
		const dry = await checkLocalWorkbenchTool().execute({ path: archive });
		assert.equal(dry.ok, false);
		await assert.rejects(() => extractWorkbenchPackage(gzipSync(makeTar(bad)), join(dir, 'out')), /越界/);
		// 干跑不能留下任何东西：目录里只有我们自己写的 bad.tgz
		const before = readdirSync(dir).sort();
		await checkLocalWorkbenchTool().execute({ path: archive });
		assert.deepEqual(readdirSync(dir).sort(), before, '干跑不许往磁盘写东西');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('干跑：审计规则与 vssaros-market/lib/inspect.js 逐字同源（两个插件各存一份，漂移会让两边结论不一致）', async () => {
	const market = await import('../../vssaros-market/lib/inspect.js');
	const mine = await import('../lib/localInstall.js');
	const same = (a, b) => JSON.stringify(a.map(x => Array.isArray(x) ? x.map(String) : String(x))) === JSON.stringify(b.map(x => Array.isArray(x) ? x.map(String) : String(x)));
	assert.ok(same(market.SERVER_CAPABILITY_RULES, mine.SERVER_CAPABILITY_RULES), 'SERVER_CAPABILITY_RULES 漂移');
	assert.ok(same(market.REACT_BUNDLE_MARKERS, mine.REACT_BUNDLE_MARKERS), 'REACT_BUNDLE_MARKERS 漂移');
	assert.ok(same(market.HOST_SINGLETON_PATTERNS, mine.HOST_SINGLETON_PATTERNS), 'HOST_SINGLETON_PATTERNS 漂移');
	assert.deepEqual(market.WORKBENCH_HOST_PACKAGES, mine.WORKBENCH_HOST_PACKAGES, 'WORKBENCH_HOST_PACKAGES 漂移');
});
await t('工具：调用 IDE 的参数契约与超时预算（与 IDE 侧 workbenches.install 对齐）', async () => {
	// 静态断言：这几个字段少一个，IDE 侧就会在**用户确认之前**抛参数错误，
	// 表现为"点了没反应"；超时少于 7 分钟会把分钟级的 dsh plugin add 当成失败。
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(src, /capability:\s*'workbenches'/);
	assert.match(src, /op:\s*'install'/);
	assert.match(src, /name:\s*prepared\.name/);
	assert.match(src, /version:\s*prepared\.version/);
	assert.match(src, /dir:\s*prepared\.dir/);
	const timeout = /timeoutMs:\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(src);
	assert.ok(timeout, '必须给 install 调用的 timeoutMs（默认 10s 太短）');
	assert.ok(Number(timeout[1]) >= 7, `timeoutMs 必须 ≥ 7 分钟（IDE 侧 IDE_REQUEST_INSTALL_TIMEOUT_MS），当前 ${timeout[1]}`);
});

await t('工具：失败/取消时保留解包目录（只成功才清）', async () => {
	const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(src, /if\s*\(succeeded\)\s*\{[\s\S]{0,120}prepared\.cleanup\(\)/);
	assert.match(src, /解包目录保留/);
});

/** 造一个带假控制桥的安装工具 + 真数据根，走工具**真实**的 execute 路径（不绕过 recordQuietly）。 */
const installWithBridge = async (reply, { replace = false, bundles, allowDowngrade } = {}) => {
	const root = mkdtempSync(join(tmpdir(), 'vss-wb-inst-root-'));
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-inst-tgz-'));
	const calls = [];
	const bridge = { callIDE: async (method, args) => { calls.push({ method, args }); if (reply instanceof Error) { throw reply; } return reply; } };
	const scoped = bundles === undefined ? {} : { pluginManager: { listBundles: async () => bundles } };
	try {
		const archive = join(dir, 'a.tgz');
		writeFileSync(archive, gzipSync(makeTar(externalFiles())));
		const tool = localWorkbenchInstallTool(scoped, root, () => bridge);
		const result = await tool.execute({ path: archive, replace, ...(allowDowngrade === undefined ? {} : { allowDowngrade }) });
		const records = await readInstallRecords(root);
		return { result, records, calls };
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
};
await t('工具真实路径：成功 / 失败 / 取消 都会写安装证据（回归：recordQuietly 曾被传错参数，证据从未落盘）', async () => {
	const ok = await installWithBridge({ ok: true, version: '1.2.3', restartRequired: true });
	assert.equal(ok.result.application, 'restart-required');
	assert.equal(ok.records.length, 1, '成功安装必须留下一条证据');
	assert.equal(ok.records[0].name, '@me/ext-demo');
	assert.equal(ok.records[0].application, 'restart-required');

	const failed = await installWithBridge({ ok: false, error: '主进程说不行' });
	assert.equal(failed.result.application, 'failed');
	assert.equal(failed.records.length, 1, '失败也要留证据（否则"为什么没装上"只能靠回忆）');
	assert.equal(failed.records[0].application, 'failed');

	const cancelled = await installWithBridge({ ok: false, declined: true, error: '用户取消了安装' });
	assert.equal(cancelled.result.application, 'cancelled');
	assert.equal(cancelled.records[0].application, 'cancelled', '取消与失败必须分开记');
});
// ── 覆盖检测（P1-4，2026-11-02）：同名已装 ⇒ 必须被明说、被授权 ─────────────────────
const NAME = '@me/ext-demo';
await t('覆盖检测：installedVersionOf 的边界（完整名 / 短名 / installed:false / 查不到 ≠ 没装）', async () => {
	const pm = (bundles) => ({ listBundles: async () => bundles });
	assert.deepEqual(await installedVersionOf(pm([{ name: NAME, version: '1.0.0', installed: true }]), NAME), { status: 'present', installed: '1.0.0' });
	// 去 scope 的短名也认（与 market 的 installedNames 同口径，防「装了却显示成没装」）
	assert.deepEqual(await installedVersionOf(pm([{ name: 'ext-demo', version: '2.0.0', installed: true }]), NAME), { status: 'present', installed: '2.0.0' });
	// 目录里有但没装 ⇒ 不算已装
	assert.deepEqual(await installedVersionOf(pm([{ name: NAME, version: '1.0.0', installed: false }]), NAME), { status: 'absent' });
	// 没有这个包 / 别的包
	assert.deepEqual(await installedVersionOf(pm([{ name: '@other/x', version: '1.0.0', installed: true }]), NAME), { status: 'absent' });
	assert.deepEqual(await installedVersionOf(pm([]), NAME), { status: 'absent' });
	// 已装但没报版本 ⇒ present + 空串（不编造版本）
	assert.deepEqual(await installedVersionOf(pm([{ name: NAME, installed: true }]), NAME), { status: 'present', installed: '' });
	// **查不到不是没装**：没有 pluginManager / listBundles 不是函数 / 抛错 / 返回非数组 ⇒ unknown
	for (const broken of [undefined, null, {}, { listBundles: async () => { throw new Error('boom'); } }, { listBundles: async () => 'nope' }]) {
		assert.deepEqual(await installedVersionOf(broken, NAME), { status: 'unknown' });
	}
	// 脏数据不抛：条目缺 name / 非对象
	assert.deepEqual(await installedVersionOf(pm([null, {}, { name: '' }, 7]), NAME), { status: 'absent' });
});
await t('覆盖检测·工具真实路径：未装 ⇒ 正常安装，不带 replacing，回执标 replaceCheck:absent', async () => {
	const r = await installWithBridge({ ok: true, version: '1.2.3', restartRequired: true }, { bundles: [] });
	assert.equal(r.result.application, 'restart-required');
	assert.equal(r.result.replaceCheck, 'absent');
	assert.equal(r.result.replaced, undefined);
	assert.equal(r.calls.length, 1);
	assert.equal(r.calls[0].args.params.replacing, undefined, '新装不该带 replacing（否则确认框会错写成“覆盖”）');
});
await t('覆盖检测·工具真实路径：已装 + 没授权 ⇒ 不发起安装、不弹确认框、说清下一步', async () => {
	const r = await installWithBridge({ ok: true, version: '1.2.3' }, { bundles: [{ name: NAME, version: '1.0.0', installed: true }], replace: false });
	assert.equal(r.calls.length, 0, '没授权覆盖时一次 IDE 请求都不该发（不打扰用户）');
	assert.equal(r.result.application, 'failed');
	assert.equal(r.result.code, 'replace_not_authorized');
	assert.equal(r.result.installedVersion, '1.0.0');
	assert.match(r.result.error, /已经装了（当前 1\.0\.0）/);
	assert.match(r.result.error, /replace: true/, '要告诉 Agent 下一步该怎么做');
	assert.match(r.result.error, /向用户确认/, '授权来自用户，不是 Agent 自己');
	// 被拦下也要留证据（"为什么没装上"）
	assert.equal(r.records.length, 1);
	assert.equal(r.records[0].application, 'failed');
});
await t('覆盖检测·工具真实路径：已装 + 已授权 ⇒ 发起安装，带 replacing{from,to}，回执记录覆盖了什么', async () => {
	const r = await installWithBridge({ ok: true, version: '1.2.3', restartRequired: true }, { bundles: [{ name: NAME, version: '1.0.0', installed: true }], replace: true });
	assert.equal(r.calls.length, 1);
	assert.equal(r.calls[0].args.params.replace, true);
	assert.deepEqual(r.calls[0].args.params.replacing, { from: '1.0.0', to: '1.2.3' });
	assert.equal(r.result.application, 'restart-required');
	assert.equal(r.result.replaceCheck, 'present');
	assert.deepEqual(r.result.replaced, { from: '1.0.0', to: '1.2.3' });
});
await t('覆盖检测·工具真实路径：查不到已装版本 ⇒ 不阻断，但如实标 unknown（不能说成“没有冲突”）', async () => {
	const r = await installWithBridge({ ok: true, version: '1.2.3', restartRequired: true });   // 没有 pluginManager
	assert.equal(r.calls.length, 1, '查不到不该挡住安装（否则无 pluginManager 的组合永远装不上）');
	assert.equal(r.result.replaceCheck, 'unknown');
	assert.equal(r.result.replaced, undefined);
	assert.equal(r.calls[0].args.params.replacing, undefined);
});
// ── 降级保护（2026-11-02，对齐 dsh-desktop「已取消安装以避免降级」）─────────────────
await t('compareVersions：按语义比，不按字符串比；不可比时返回 null（不猜）', () => {
	assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '字符串比较会判反');
	assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
	assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
	assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1, '预发布低于正式版');
	assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
	assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1, '字母标识符高于数字标识符');
	assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.9'), 0, '构建元数据不参与比较');
	assert.equal(compareVersions('1.0.0-rc-1', '1.0.0-rc-2'), -1, '预发布段里的连字符不能被当成另一段');
	assert.equal(compareVersions('1.0', '1.0.0'), null, '不是完整 SemVer ⇒ 不比');
	assert.equal(compareVersions('', '1.0.0'), null);
	assert.equal(compareVersions('abc', '1.0.0'), null);
});
await t('降级：已装 2.0.0、要装 1.2.3 ⇒ 拦下（不发起安装、不弹框），并说明怎么回退', async () => {
	const r = await installWithBridge({ ok: true, version: '1.2.3' }, { replace: true, bundles: [{ name: '@me/ext-demo', version: '2.0.0', installed: true }] });
	assert.equal(r.calls.length, 0, '降级不该惊动用户（不弹确认框）');
	assert.equal(r.result.application, 'failed');
	assert.equal(r.result.code, 'downgrade_blocked');
	assert.equal(r.result.installedVersion, '2.0.0');
	assert.match(r.result.error, /已装 2\.0\.0/);
	assert.match(r.result.error, /allowDowngrade: true/, '要告诉 Agent 下一步怎么做');
	assert.equal(r.records.length, 1, '被拦下也要留证据');
});
await t('降级：判在覆盖授权**之前**（否则用户要先授权覆盖、才被告知是降级，两次往返）', async () => {
	// 没传 replace 也不该先报 replace_not_authorized
	const r = await installWithBridge({ ok: true, version: '1.2.3' }, { bundles: [{ name: '@me/ext-demo', version: '2.0.0', installed: true }] });
	assert.equal(r.result.code, 'downgrade_blocked', '降级是更具体的原因，必须先报');
});
await t('降级：用户明确要求回退（allowDowngrade: true）⇒ 放行，且仍要覆盖授权', async () => {
	const blocked = await installWithBridge({ ok: true, version: '1.2.3' }, { allowDowngrade: true, bundles: [{ name: '@me/ext-demo', version: '2.0.0', installed: true }] });
	assert.equal(blocked.result.code, 'replace_not_authorized', '只免降级，不等于免覆盖授权');
	await new Promise(r => setTimeout(r, 0));
	const ok = await installWithBridge({ ok: true, version: '1.2.3', restartRequired: true }, { allowDowngrade: true, replace: true, bundles: [{ name: '@me/ext-demo', version: '2.0.0', installed: true }] });
	assert.equal(ok.calls.length, 1);
	assert.equal(ok.result.application, 'restart-required');
	assert.deepEqual(ok.result.replaced, { from: '2.0.0', to: '1.2.3' });
});
await t('降级：同版本 / 升级 / 版本不可比 都照常进行（不误拦）', async () => {
	for (const [installed, expectCalls] of [['1.2.3', 1], ['1.0.0', 1], ['不是版本', 1]]) {
		const r = await installWithBridge({ ok: true, version: '1.2.3', restartRequired: true }, { replace: true, bundles: [{ name: '@me/ext-demo', version: installed, installed: true }] });
		assert.equal(r.calls.length, expectCalls, `已装 ${installed} 不该被降级检查拦下`);
		assert.equal(r.result.code, undefined, `已装 ${installed} 不该返回拦截 code`);
	}
});
await t('工具：没有控制桥 ⇒ 明确失败（不假装装好）', async () => {
	const tool = localWorkbenchInstallTool({});
	assert.equal(tool.name, 'install_local_workbench');
	await assert.rejects(() => tool.execute({ path: join(tmpdir(), 'nope.tgz') }), /没有可用的控制桥/);
});
await t('安装记录：同名同版本覆盖、不同版本追加、落盘不含临时文件', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'vss-wb-rec-'));
	try {
		assert.equal(await recordLocalInstall(dir, { name: 'a', version: '1.0.0', application: 'restart-required' }), true);
		assert.equal(await recordLocalInstall(dir, { name: 'a', version: '1.0.0', application: 'failed' }), true);
		assert.equal(await recordLocalInstall(dir, { name: 'a', version: '1.0.1', application: 'applied' }), true);
		const rows = JSON.parse(readFileSync(join(dir, 'local-installs.json'), 'utf8'));
		assert.equal(rows.length, 2, '同版本只留最新一条');
		assert.equal(rows[0].version, '1.0.1', '最新在前');
		assert.equal(rows[0].source, 'local');
		assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
		assert.equal(await recordLocalInstall('', { name: 'x' }), false, '没有数据根 ⇒ 不写（不猜目录）');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(results.join('\n'));
const total = results.length;
console.log(`\n[vssaros-workbenches] ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
