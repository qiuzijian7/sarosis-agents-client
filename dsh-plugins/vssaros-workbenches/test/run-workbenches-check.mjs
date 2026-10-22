#!/usr/bin/env node
// @vssaros/dsh-workbenches 自检（纯 Node、不联网、不起 Host）。
//   ① state.js：归属不可改/不可删、新归属需已添加、删除工作台保留笔记/可见性、revision 409、损坏数据 500、原子写不留临时文件；
//   ② client.js：register 校验逐条照官方（抛异常）、身份规范化、重复注册抛错、注销函数、open/leave 走 layout.selectPanel；
//   ③ 服务端 apply：provide desktopWorkbenchOwnership + 两条路由；config.root 为空时不注册（如实告警）。
// 用法：node dsh-plugins/vssaros-workbenches/test/run-workbenches-check.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateStore, emptyState, validateState } from '../lib/state.js';
import { apply as applyServer } from '../lib/index.js';

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
	const sandboxWindow = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(require); } } };
	const fakeReact = { createElement: (...a) => a, Component: class { }, Fragment: 'F', useRef: () => ({}), useLayoutEffect: () => { } };
	const require = name => {
		if (name === 'react') { return fakeReact; }
		throw new Error('unexpected require ' + name);
	};
	const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
	const fakeDocument = { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() { } } };
	new Function('window', 'globalThis', 'document', src)(sandboxWindow, {}, fakeDocument);
	return mod;
}
const client = loadClient();
const fakeCtx = () => {
	const calls = { selected: [], registered: [], disposed: 0 };
	return {
		calls,
		slots: { register: (opts) => { calls.registered.push(opts.key); return () => { calls.disposed++; }; } },
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
		};
		ctx.inject = (names, cb) => { assert.deepEqual(names, ['connection']); cb(ctx); };
		applyServer(ctx, { root: d });
		assert.deepEqual(routes.map(r => r.methods[0] + ' ' + r.path).sort(), ['GET /api/vssaros-workbenches/state', 'POST /api/vssaros-workbenches/state/write']);
		const own = await provided.desktopWorkbenchOwnership.read();
		assert.deepEqual(own, { revision: 0, sessionBindings: {}, added: [] });
		const res = await routes.find(r => r.methods[0] === 'GET').fetch();
		assert.equal(res.status, 200);
		const body = JSON.stringify({ revision: 0, state: { ...emptyState(), added: [A] } });
		const w = await routes.find(r => r.methods[0] === 'POST').fetch(new Request('http://x/', { method: 'POST', body, headers: { 'content-length': String(body.length) } }));
		assert.equal(w.status, 200);
		assert.deepEqual((await provided.desktopWorkbenchOwnership.read()).added, [A]);
		const stale = await routes.find(r => r.methods[0] === 'POST').fetch(new Request('http://x/', { method: 'POST', body }));
		assert.equal(stale.status, 409);
	} finally { rmSync(d, { recursive: true, force: true }); }
});
await t('服务端：config.root 为空 ⇒ 不注册任何路由（不猜目录）', () => {
	const routes = [];
	const warns = [];
	applyServer({ logger: () => ({ warn: m => warns.push(m) }), inject: (n, cb) => cb({ connection: { fetch: { register: r => routes.push(r) } } }), effect: fn => fn(), reflect: { provide() { } } }, { root: '' });
	assert.equal(routes.length, 0);
	assert.equal(warns.length, 1);
});

console.log(results.join('\n'));
const total = results.length;
console.log(`\n[vssaros-workbenches] ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
