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
await t('P3 主页排序字段：合法数组通过，重复/非字符串/超长拒绝', () => {
	const good = { ...emptyState(), homeWorkbenchOrder: ['vssaros/kb/default', 'files'], homeToolOrder: ['terminal'] };
	validateState(good);
	assert.throws(() => validateState({ ...emptyState(), homeWorkbenchOrder: ['a', 'a'] }), /排序键/);
	assert.throws(() => validateState({ ...emptyState(), homeToolOrder: [1] }), /排序键/);
	assert.throws(() => validateState({ ...emptyState(), homeToolOrder: ['x'.repeat(201)] }), /排序键/);
});
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
function loadClient(fetchImpl, reactOverrides = {}) {
	let mod = null;
	// ⚠ 2026-11-02：`client.js` 的深链 effect 会读 `window.location`（`?wb=` / `#wb=`），
	// 假 window 少了 location ⇒ apply() 直接抛，后面 12 条断言全部连锁失败（基线 18/30）。
	// 这里补一个只读 location，把"测试基建缺口"和"产品行为"分开。
	const sandboxWindow = {
		__ModuleLoader__: { load: ({ factory }) => { mod = factory(require); } },
		location: { search: '', hash: '', origin: 'http://127.0.0.1:1' },
	};
	const fakeReact = { createElement: (...a) => a, createContext: () => ({ Provider: 'Provider' }), useCallback: fn => fn, Component: class { }, Fragment: 'F', useRef: () => ({}), useLayoutEffect: () => { }, useState: init => [typeof init === 'function' ? init() : init, () => { }], useEffect: () => { } };
	Object.assign(fakeReact, reactOverrides);
	const fakeReactDom = { createPortal: (node, el, key) => ['portal', { el, key }, node] };
	const require = name => {
		if (name === 'react') { return fakeReact; }
		if (name === 'react-dom') { return fakeReactDom; }
		throw new Error('unexpected require ' + name);
	};
	const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
	const fakeDocument = { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() { } } };
	if (fetchImpl) { new Function('window', 'globalThis', 'document', 'fetch', src)(sandboxWindow, {}, fakeDocument, fetchImpl); }
	else { new Function('window', 'globalThis', 'document', src)(sandboxWindow, {}, fakeDocument); }
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
function serviceOf(module = client) {
	const ctx = fakeCtx();
	let service = null;
	ctx.effect = fn => fn();
	ctx.reflect = { provide: (name, svc) => { if (name === 'desktopWorkbenches') { service = svc; } return () => { }; } };
	const g = globalThis;
	const savedFetch = g.fetch;
	g.fetch = async () => ({ ok: true, json: async () => ({ revision: 0, state: emptyState() }) });
	try { module.apply(ctx); } finally { g.fetch = savedFetch; }
	return { service, ctx };
}
await t('外部插件默认Bot：local与公开仓库身份都按包名绑定，未注册preset不猜', async () => {
	let rows = [{ packageName: '@demo/desk', defaultPreset: 'vssaros-wb-helper' }];
	const module = loadClient(async url => ({ ok: true, json: async () => String(url).endsWith('/plugin-resources') ? { packages: rows } : { revision: 0, state: emptyState() } }));
	for (const repository of [undefined, 'https://github.com/demo/desk']) {
		const { service } = serviceOf(module);
		service.agentPresets = { list: async () => ({ ok: true, value: { presets: [{ id: 'vssaros-wb-helper' }] } }) };
		const dispose = service.register({ title: 'Demo', package: '@demo/desk', ...(repository ? { repository } : {}) }, Comp);
		assert.equal(await service.readyPreset(repository ? 'demo/desk' : 'local:@demo/desk'), 'vssaros-wb-helper');
		dispose();
	}
	rows = [];
	const { service } = serviceOf(module);
	service.agentPresets = { list: async () => ({ ok: true, value: { presets: [] } }) };
	service.register({ title: 'No Bot', package: '@demo/empty' }, Comp);
	assert.equal(await service.readyPreset('local:@demo/empty'), '');
});
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
await t('P1 统一目录：默认页 + 声明子页有稳定主键，非法/重复 pageId 抛', () => {
	const base = { title: '数据分析', repository: 'vssaros:analysis' };
	assert.equal(client.catalogKey('vssaros/analysis', 'overview'), 'vssaros/analysis/overview');
	const entry = client.normalize({ ...base, pages: [{ id: 'overview', title: '概览' }, { id: 'records', title: '数据表', route: '/x/analysis/records/' }] }, Comp);
	assert.deepEqual(entry.pages.map(p => p.pageId), ['default', 'overview', 'records']);
	assert.equal(entry.pages[0].key, 'vssaros/analysis/default');
	assert.equal(entry.pages[1].kind, 'component');
	assert.equal(entry.pages[2].kind, 'route');
	assert.equal(entry.pages[0].Component, Comp, 'renderer 留在内部条目，供 P2 取用');
	assert.throws(() => client.normalize({ ...base, pages: [{ id: 'Bad Name', title: '非法' }] }, Comp), /Invalid workbench page id/);
	assert.throws(() => client.normalize({ ...base, pages: [{ id: 'dup', title: '1' }, { id: 'dup', title: '2' }] }, Comp), /Duplicate workbench page id/);
});
await t('P1 统一目录：注册/注销订阅同步、快照不暴露 Component、路由页可单独登记', () => {
	const { service } = serviceOf();
	let notified = 0;
	const unsubscribe = service.subscribeCatalog(() => { notified += 1; });
	const empty = service.getCatalogSnapshot();
	assert.ok(Object.isFrozen(empty) && Object.isFrozen(empty.pages), '目录快照必须冻结');
	assert.equal(empty.pages.length, 0);
	const dispose = service.register({
		title: '定时任务', repository: 'vssaros:scheduler',
		pages: [{ id: 'overview', title: '概览' }],
	}, Comp);
	const registered = service.getCatalogSnapshot();
	assert.deepEqual(registered.pages.map(p => p.pageId), ['default', 'overview']);
	assert.ok(registered.pages.every(p => !Object.prototype.hasOwnProperty.call(p, 'Component')), '快照不能带 React Component');
	assert.equal(service.getCatalogRenderer('vssaros/scheduler/default'), Comp);
	assert.equal(service.getCatalogRenderer('vssaros/scheduler/overview'), Comp);
	assert.ok(notified > 0, '注册必须通知目录订阅者');
	const page = { workbenchId: 'route/x-kb', pageId: 'default', title: '知识库', route: '/x/kb/' };
	const disposePage = service.registerPage(page, null);
	const withRoute = service.getCatalogSnapshot();
	assert.equal(withRoute.pages.length, 3);
	assert.equal(withRoute.pages.find(p => p.key === 'route/x-kb/default').kind, 'route');
	assert.equal(service.getCatalogRenderer('route/x-kb/default'), null, '纯路由页没有 React renderer');
	assert.throws(() => service.registerPage(page, null), /Duplicate workbench catalog page/);
	disposePage();
	assert.equal(service.getCatalogSnapshot().pages.length, 2);
	dispose();
	assert.equal(service.getCatalogSnapshot().pages.length, 0, '注销必须移除所有页面');
	assert.equal(service.getCatalogRenderer('vssaros/scheduler/default'), null, '注销必须清掉 renderer');
	const before = notified;
	unsubscribe();
	service.register({ title: '临时', repository: 'vssaros:temp' }, Comp);
	assert.equal(notified, before, '退订后不再收到目录通知');
});
await t('P2 Better Sidebar 适配器：目录 diff、多实例 createTab、打开不替换、开关与注销', () => {
	client.__setSidebarLayoutV1(false);
	client.__testDeleteGlobal('__vssarosWorkbenchItems');
	client.__testDeleteGlobal('__vssarosPageComponents');
	const { service } = serviceOf();
	service.register({ title: '定时任务', repository: 'vssaros:scheduler' }, Comp);
	const registered = [];
	const disposed = [];
	const opened = [];
	const sidebar = {
		registerTab(descriptor) {
			registered.push(descriptor);
			return () => { disposed.push(descriptor.id); };
		},
		openTab(seed, scope) { opened.push({ seed, scope }); },
	};
	const adapter = client.__installSidebarWorkbenchAdapter(fakeCtx(), service, sidebar);
	assert.equal(registered.length, 0, '显式关闭 P3 时不得抢占 native guide');
	client.__setSidebarLayoutV1(true);
	assert.equal(registered.length, 1, '开关打开后按目录注册 tab type');
	const descriptor = registered[0];
	assert.match(descriptor.id, /^vssaros-wb:/);
	assert.equal(descriptor.hidden, false);
	assert.equal(typeof descriptor.component, 'function');
	assert.equal(typeof descriptor.createTab, 'function');
	const first = descriptor.createTab({});
	const second = descriptor.createTab({});
	assert.notEqual(first.tab.id, second.tab.id, 'createTab 必须每次铸造新实例 id');
	assert.equal(first.tab.type, descriptor.id);
	assert.equal(first.tab.meta.catalogKey, 'vssaros/scheduler/default');
	assert.equal(client.__openSidebarWorkbenchPage('vssaros/scheduler/default', { sessionId: 's1' }), true);
	assert.equal(opened.length, 1);
	assert.equal(opened[0].seed.type, descriptor.id);
	assert.equal(opened[0].seed.replaceTab, undefined, '打开工作台不能替换开始页');
	assert.equal(opened[0].scope.sessionId, 's1');
	const disposePage = service.registerPage({
		workbenchId: 'route/x-media', pageId: 'default', title: '媒体库', route: '/x/media/',
	}, null);
	assert.equal(registered.length, 2, '后续新增目录项应自动注册');
	disposePage();
	assert.equal(disposed.length, 1, '目录项注销应撤对应 tab type');
	client.__setSidebarLayoutV1(false);
	assert.equal(disposed.length, 2, '关闭开关应撤掉全部 native type');
	assert.equal(client.__sidebarLayoutV1Enabled(), false);
	adapter.dispose();
});
await t('P2 右栏工作台承载：根节点与 iframe 必须有 flex/height 双保险', () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	const wrapperRule = (source.match(/\[data-vssaros-wb-sidebar-page\]\s*\{[^}]*\}/) || [''])[0];
	assert.match(wrapperRule, /display:flex/, '右栏工作台根必须是 flex 容器');
	assert.match(wrapperRule, /flex:1 1 auto/, '右栏工作台根必须占据剩余空间');
	assert.match(wrapperRule, /min-height:0/, '右栏工作台根必须允许内部滚动区收缩');
	assert.match(wrapperRule, /height:100%/, '右栏工作台根必须有确定高度');
	assert.match(wrapperRule, /overflow:hidden/, '右栏工作台根不得把内层滚动区撑破');
	assert.match(source, /\[data-vssaros-wb-sidebar-page\]\s*>\s*\*\s*\{[^}]*flex:1 1 auto[^}]*min-height:0/,
		'renderer 根节点必须继承弹性高度');
	assert.match(source, /\[data-vssaros-wb-sidebar-page\]\s*>\s*iframe\s*\{[^}]*display:block[^}]*flex:1 1 auto[^}]*height:100%/,
		'route iframe 必须按块级弹性元素铺满，不再回落默认 150px');
	assert.match(source, /data-vssaros-wb-sidebar-route/, 'route 工作台必须带可诊断的 iframe 锚点');
});
await t('P3 所有权链：配置开启即接管开始页，live guideTakeover 不再短路工作台区', () => {
	client.__testDeleteGlobal('__vssarosWorkbenchItems');
	client.__testDeleteGlobal('__vssarosPageComponents');
	const { service } = serviceOf();
	service.register({ title: '知识库', repository: 'vssaros:kb' }, Comp);
	service.registerPage({
		workbenchId: 'vssaros/acme', pageId: 'default', canonicalId: 'vssaros/acme',
		title: '示例工作台', description: 'P3 回归用工作台', icon: 'grid', route: '/x/acme/',
		hidden: false, retired: false, enabled: true, availability: 'ready', state: 'active',
		sourceKind: 'registered', sourcePackage: 'test', package: 'test',
		visibility: { start: true, launcher: false, nativeTab: false, routeWhitelist: false, deepLink: false },
		aliases: [], replacedBy: '',
	}, null);
	client.__setSidebarLayoutV1(true);
	assert.equal(client.readSidebarLayoutV1Config({}), true, '无配置时 P3 默认开启');
	client.__setSidebarLayoutV1(false);
	assert.equal(client.readSidebarLayoutV1Config({}), false, '跨 chunk 全局显式 false 必须回退旧布局');
	assert.equal(client.readSidebarLayoutV1Config({ fiber: { entry: { options: { config: { sidebarLayoutV1: true } } } } }), true);
	assert.equal(client.readSidebarLayoutV1Config({ config: { sidebarLayoutV1: false } }), false);
	assert.equal(client.sidebarGuideReleased({ getSnapshot: () => ({ prefs: { guideTakeover: false } }) }), true);
	assert.equal(client.sidebarGuideReleased({ getSnapshot: () => ({ prefs: { guideTakeover: true } }) }), false);
	const guideRegs = [];
	const tabRegs = [];
	const disposedTabs = [];
	let guideDisposed = 0;
	let stateListener = null;
	const layoutConfig = { sidebarLayoutV1: true };
	const ctx = {
		fiber: { entry: { options: { config: layoutConfig } } },
		get: () => undefined,
		slots: {
			inject: (name, factory) => {
				if (name !== 'sidebar.right.tab.guide') { throw new Error('unexpected slot ' + name); }
				return factory();
			},
			register: (opts, component) => {
				guideRegs.push({ opts, component });
				return () => { guideDisposed += 1; };
			},
		},
	};
	// 复现用户截图：better-sidebar live prefs 仍为 true，shipped NativeGuide 常驻。
	const sidebar = {
		prefs: { guideTakeover: true },
		getSnapshot() { return { sessionId: 's1', prefs: this.prefs }; },
		subscribeState(listener) { stateListener = listener; return () => { stateListener = null; }; },
		subscribe() { return () => { }; },
		getTabs() { return [{ id: 'terminal', title: '终端' }, { id: 'vssaros-wb:hidden', hidden: true }]; },
		registerTab(descriptor) { tabRegs.push(descriptor); return () => { disposedTabs.push(descriptor.id); }; },
		openTab() { },
	};
	const HomeGuide = client.makeVsSarosHomeGuide(service, ctx, sidebar);
	const homeMarkup = JSON.stringify(HomeGuide({}));
	assert.match(homeMarkup, /data-vssaros-guide-root/, '自家开始页必须有常驻根锚点');
	assert.match(homeMarkup, /data-vssaros-surface/, '开始页必须声明工作台承载面');
	assert.match(homeMarkup, /vssaros-home-search/, 'v6 搜索框必须使用统一样式类');
	assert.match(homeMarkup, /vssaros-home-workbench-grid vssaros-home-tool-grid/, '工作台与工具必须共用同一个统一网格');
	assert.match(homeMarkup, /vssaros-home-workbench-open/, '工具与工作台必须共用统一 item 卡片');
	assert.match(homeMarkup, /data-vssaros-home-tool/, '工具必须并入工作台分组');
	assert.match(homeMarkup, /data-vssaros-home-anchor-action/, '每个 item 必须有可点击的锚点');
	assert.match(homeMarkup, /vssaros-home-anchor-button/, '每个 item 必须有独立可见的 anchor 按钮');
	assert.match(homeMarkup, /vssaros-home-card-actions/, '图钉按钮与拖动手柄必须并排放在卡片动作区');
	assert.match(homeMarkup, /aria-roledescription":"固定锚点/, 'anchor 按钮必须有明确的无障碍语义');
	assert.doesNotMatch(homeMarkup, /vssaros-home-filters|目录分类/, '开始页不得再渲染分类页签');
	assert.doesNotMatch(homeMarkup, /常用工具/, '开始页不得再有独立的常用工具分组');
	assert.match(homeMarkup, /viewBox/, '工具/工作台卡必须使用 SVG 图标而非 emoji');
	assert.match(homeMarkup, /data-vssaros-home-workbench/, '工作台目录必须渲染');
	assert.match(homeMarkup, /vssaros-home-workbench-grid/, '工作台必须渲染为双列卡片网格');
	assert.match(homeMarkup, /vssaros-home-drag-handle/, '工作台卡片必须有独立拖拽锚点');
	assert.match(homeMarkup, /data-vssaros-home-drag/, '工作台卡片必须有独立拖拽锚点');
	assert.match(homeMarkup, /data-vssaros-home-anchor/, '工作台卡片必须标记显式拖拽锚点');
	assert.match(homeMarkup, /aria-roledescription":"拖拽锚点/, '拖拽锚点必须有无障碍角色说明');
	assert.match(homeMarkup, /vssaros-home-workbench-anchor-/, '每张工作台卡片必须有稳定锚点 id');
	assert.match(homeMarkup, /data-vssaros-more-trigger/, '常用工具末尾必须有紧凑更多入口');
	assert.doesNotMatch(homeMarkup, /data-vssaros-all-tools-trigger|全部工具|vssaros-home-dialog/,
		'开始页不得再有「全部工具」按钮或弹层');
	assert.match(homeMarkup, /目录自动发现/, '工作台区必须展示目录自动发现标记');
	assert.match(homeMarkup, /拖动卡片右上角锚点/, '必须展示拖拽说明');
	assert.match(homeMarkup, /键盘：/, '必须展示键盘排序说明');
	assert.doesNotMatch(homeMarkup, /欢迎|今日会话|运行中|可用业务页|最近资源/, '开始页不得有欢迎/统计/最近资源');

	const disposeOwnership = client.__installSidebarLayoutOwnership(ctx, service, sidebar);
	assert.equal(client.__sidebarLayoutV1Enabled(), true, 'P3 配置开启且自有链注册成功即启用新布局');
	assert.equal(guideRegs.length, 1, '只能挂一条自有 guide 链');
	assert.equal(guideRegs[0].opts.priority, -10, '自有 guide 必须用负 priority 压过 shipped NativeGuide');
	assert.deepStrictEqual(guideRegs[0].opts.select(), {}, '自家 guide 必须总是当选，压过 shipped fallback');
	assert.equal(guideRegs[0].opts.inject('s1').sessionId, 's1');
	assert.equal(tabRegs.filter(d => d.id.startsWith('vssaros-wb:')).length, 1, '启用后目录页自动注册 native tab type');
	assert.equal(tabRegs.some(d => d.id === 'vssaros:image-reference'), true, '图片资源 tab 类型必须注册');
	assert.equal(client.__openSidebarWorkbenchPage('vssaros/kb/default'), true);
	assert.equal(client.__openImageReference('@image:image.png'), true, '图片 token 可另开右栏资源页');

	// live guideTakeover 翻转不得再次注册/注销，也不得让工作台区消失。
	sidebar.prefs.guideTakeover = false;
	stateListener();
	assert.equal(client.__sidebarLayoutV1Enabled(), true, 'live pref 变化不得短路 P3');
	assert.equal(guideRegs.length, 1, 'live pref 变化不得重复挂自有 guide');
	assert.equal(tabRegs.filter(d => d.id.startsWith('vssaros-wb:')).length, 1, 'live pref 变化不得重复注册目录 tab');
	assert.equal(disposedTabs.filter(id => id.startsWith('vssaros-wb:')).length, 0, 'live pref 变化不得注销目录 tab');

	// 只有显式把 sidebarLayoutV1 设为 false 才回退旧布局。
	layoutConfig.sidebarLayoutV1 = false;
	stateListener();
	assert.equal(client.__sidebarLayoutV1Enabled(), false, '显式 false 才回退旧布局');
	assert.equal(guideDisposed, 1, '回退时自有 guide 链必须注销');
	assert.equal(disposedTabs.filter(id => id.startsWith('vssaros-wb:')).length, 1, '回退时右栏目录 type 必须注销');
	layoutConfig.sidebarLayoutV1 = true;
	stateListener();
	assert.equal(client.__sidebarLayoutV1Enabled(), true);
	assert.equal(guideRegs.length, 2);
	assert.equal(tabRegs.filter(d => d.id.startsWith('vssaros-wb:')).length, 2);
	disposeOwnership();
	assert.equal(client.__sidebarLayoutV1Enabled(), false, '卸载后必须恢复默认旧布局');
	assert.equal(client.__openSidebarWorkbenchPage('vssaros/kb/default'), false);
	assert.equal(client.__openImageReference('@image:image.png'), false, '卸载后图片资源入口必须关闭');
});
/** 在 createElement 数组树里按 props 找节点（测试桩的 React 元素就是数组）。 */
function findTreeProps(node, predicate) {
	if (!Array.isArray(node)) { return null; }
	const props = node[1];
	if (props && typeof props === 'object' && !Array.isArray(props) && predicate(props)) { return props; }
	for (const child of node) {
		if (!Array.isArray(child) || child === node) { continue; }
		const found = findTreeProps(child, predicate);
		if (found) { return found; }
	}
	return null;
}
await t('开始页「浏览更多插件」直达商城工作台，不再打开宿主插件目录', () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	// 语义收敛到「浏览更多插件」这一个函数：官方插件页要打开宿主插件页装官方包，不该被全文禁令误伤。
	const browse = /const browsePlugins = \(\) => \{[\s\S]*?\n\t\t\t\};/.exec(source);
	assert.ok(browse, '必须能定位「浏览更多插件」实现');
	assert.doesNotMatch(browse[0], /pluginNavigation/, '「浏览更多插件」不得再调用宿主插件目录服务');
	assert.match(source, /canonicalId === MARKET_WORKBENCH_ID/, '必须按目录真源的 canonicalId 定位商城页');
	assert.match(source, /service\.open\(MARKET_WORKBENCH_ID\)/, '右栏目录未就绪时必须回落商城工作台本体');

	// 展开「更多」菜单（分类 state 下线后，第 3 个 useState 是 menuOpen），再真实点击菜单按钮。
	let stateCalls = 0;
	const menuClient = loadClient(undefined, {
		useState: init => {
			stateCalls += 1;
			const value = stateCalls === 3 ? true : (typeof init === 'function' ? init() : init);
			return [value, () => { }];
		},
	});
	const { service, ctx } = serviceOf(menuClient);
	menuClient.__registerManifestPages(service);
	assert.ok(service.getCatalogSnapshot().pages.some(page => page.canonicalId === 'vssaros/marketplace'),
		'目录必须包含商城 active 页');
	const opened = [];
	menuClient.__testSetGlobal('__vssarosOpenWorkbenchCatalogPage', key => { opened.push(key); return true; });
	let pluginListCalls = 0;
	ctx.get = name => name === 'pluginNavigation' ? { openList: () => { pluginListCalls += 1; } } : undefined;
	const sidebar = {
		getTabs: () => [],
		getSnapshot: () => ({ sessionId: 's1', prefs: { guideTakeover: false } }),
		subscribe: () => () => { },
		subscribeState: () => () => { },
		openTab: () => { },
	};
	const tree = menuClient.makeVsSarosHomeGuide(service, ctx, sidebar)({});
	const button = findTreeProps(tree, props => props['data-vssaros-browse-plugins'] === '1');
	assert.ok(button && typeof button.onClick === 'function', '更多菜单必须保留「浏览更多插件」按钮');
	button.onClick();
	assert.deepStrictEqual(opened, ['manifest:/x/marketplace//vssaros-wb-marketplace'], '点击必须打开商城工作台');
	assert.equal(pluginListCalls, 0, '点击不得打开宿主插件目录');

	// 右栏目录未就绪 ⇒ 回落注册式商城工作台本体，仍不得打开宿主插件目录。
	menuClient.__testDeleteGlobal('__vssarosOpenWorkbenchCatalogPage');
	service.register({ title: '商城工作台', repository: 'vssaros:marketplace' }, Comp);
	button.onClick();
	assert.equal(ctx.calls.selected.includes('vssaros-wb:vssaros/marketplace'), true,
		'右栏目录未就绪时必须打开注册式商城工作台');
	assert.equal(pluginListCalls, 0, '回落路径也不得打开宿主插件目录');
	service.dispose();
});
await t('开始页统一 item：工具并入工作台、分类下线、锚点点击固定到左侧栏', () => {
	const anchorSource = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(anchorSource, /data-vssaros-home-anchors/, '左侧栏必须有锚点 item 容器');
	assert.match(anchorSource, /\[data-sidebar-left\]/, '锚点容器必须挂在左侧栏 DOM');
	assert.match(anchorSource, /__vssarosOpenHomeAnchor/, '左侧栏 item 必须能打开右栏页签');
	assert.doesNotMatch(anchorSource, /allToolsOpen|allToolsDialog|data-vssaros-all-tools-trigger|vssaros-home-view-tools/,
		'全部工具按钮与弹层实现必须彻底下线');
	const anchorClient = loadClient();
	const { service, ctx } = serviceOf(anchorClient);
	anchorClient.__registerManifestPages(service);
	// 生产里由 vssaros-scheduler 注册的「自动化任务」工作台，也必须进统一 item 列表。
	service.register({ title: '自动化任务', repository: 'vssaros:scheduler' }, Comp);
	const opened = [];
	const toolOpened = [];
	anchorClient.__testSetGlobal('__vssarosOpenWorkbenchCatalogPage', key => { opened.push(key); return true; });
	const sidebar = {
		getTabs: () => [
			{ id: 'files', title: '文件', description: '浏览工作区文件' },
			{ id: 'git', title: 'Git', description: '变更' },
			{ id: 'hidden-tool', title: '隐藏', hidden: true },
		],
		getSnapshot: () => ({ sessionId: 's1', prefs: { guideTakeover: false } }),
		subscribe: () => () => { },
		subscribeState: () => () => { },
		openTab: seed => { toolOpened.push(seed); },
	};
	const tree = anchorClient.makeVsSarosHomeGuide(service, ctx, sidebar)({});
	const markup = JSON.stringify(tree);
	assert.match(markup, /"data-vssaros-home-workbench":"vssaros\/scheduler\/default"/,
		'自动化任务必须作为工作台 item 出现在统一列表');
	assert.match(markup, /自动化任务/, '自动化任务卡片必须可见');
	assert.match(markup, /"data-vssaros-home-tool":"files"/, '文件工具必须作为 item 出现在工作台分组');
	assert.match(markup, /"data-vssaros-home-tool":"git"/, 'Git 工具必须作为 item 出现在工作台分组');
	assert.doesNotMatch(markup, /"data-vssaros-home-tool":"hidden-tool"/, 'hidden 工具不得进开始页');
	assert.doesNotMatch(markup, /vssaros-home-filters|目录分类/, '分类页签必须下线');
	assert.doesNotMatch(markup, /常用工具/, '常用工具分组必须下线');

	anchorClient.__testWriteHomeAnchors([]);
	const anchorProps = findTreeProps(tree, props => props['data-vssaros-home-anchor-action'] === '1');
	assert.ok(anchorProps && typeof anchorProps.onClick === 'function', '每个 item 必须有可点击锚点');
	assert.equal(anchorProps.onKeyDown, undefined, 'anchor 不得重复绑定键盘事件（原生 click 即可）');
	anchorProps.onClick({ detail: 0 });
	assert.equal(anchorClient.__testReadHomeAnchors().length, 1, '键盘 / 触屏派发的 detail=0 click 也必须能固定');
	anchorProps.onClick({ detail: 0 });
	assert.equal(anchorClient.__testReadHomeAnchors().length, 0, '再次 click 必须取消固定');
	anchorProps.onClick({ detail: 1 });
	const anchors = anchorClient.__testReadHomeAnchors();
	assert.equal(anchors.length, 1, '点击锚点必须把 item 固定到左侧栏');
	assert.equal(anchors[0].kind, 'workbench', '锚点条目必须保留 item 类型');
	const openAnchor = anchorClient.__testGetGlobal('__vssarosOpenHomeAnchor');
	assert.equal(typeof openAnchor, 'function', '左侧栏锚点必须有打开入口');
	openAnchor(anchors[0].key);
	assert.deepStrictEqual(opened, [anchors[0].key], '点击左侧栏工作台锚点必须打开右栏 catalog 页');
	openAnchor('tool:files');
	assert.equal(toolOpened.some(seed => seed && seed.type === 'files'), true,
		'点击左侧栏工具锚点必须打开对应的右栏工具 tab');
	anchorProps.onClick({ detail: 1 });
	assert.equal(anchorClient.__testReadHomeAnchors().length, 0, '再次点击锚点必须取消固定');
	// localStorage 写入失败（Electron WebContentsView 常见）时，写入/读回必须同源，不能静默丢状态。
	const previousStore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	globalThis.localStorage = {
		getItem: () => null,
		setItem: () => { throw new Error('SecurityError'); },
	};
	try {
		anchorClient.__testWriteHomeAnchors([]);
		assert.equal(anchorClient.__testToggleHomeAnchor({ key: 'stub-key', title: '桩', kind: 'workbench' }), true);
		assert.deepStrictEqual(anchorClient.__testReadHomeAnchors().map(entry => entry.key), ['stub-key'],
			'localStorage 写入失败时必须回退到内存且读写一致');
	} finally {
		if (previousStore) { Object.defineProperty(globalThis, 'localStorage', previousStore); }
		else { delete globalThis.localStorage; }
	}
	service.dispose();
});
await t('统一 HomeItemRegistry：两个来源、一个投影、一个排序字段', () => {
	const registryClient = loadClient();
	const { service } = serviceOf(registryClient);
	registryClient.__registerManifestPages(service);
	service.register({ title: '自动化任务', repository: 'vssaros:scheduler' }, Comp);
	const sidebar = {
		getTabs: () => [
			{ id: 'files', title: '文件', description: '浏览工作区文件' },
			{ id: 'custom-tool', title: () => '自定义工具', description: '无需改名单' },
			{ id: 'hidden-tool', hidden: true, title: '隐藏' },
			{ id: 'bottom-tool', bottomOnly: true, title: '底部' },
			{ id: 'vssaros-wb:page', vssarosOwner: 'vssaros-workbenches', title: '承载页' },
		],
	};
	const registry = registryClient.createHomeItemRegistry(service, sidebar);
	const start = registryClient.selectHomeItems(registry.snapshot(), 'start').map(item => item.key);
	assert.ok(start.includes('manifest:/x/marketplace//vssaros-wb-marketplace'), '静态目录页必须来自 catalog 来源');
	assert.ok(start.includes('vssaros/scheduler/default'), '运行时注册工作台必须进同一 registry');
	assert.ok(start.includes('tool:files'), '工具 tab 必须来自 betterSidebar 来源');
	assert.ok(start.includes('tool:custom-tool'), '新增工具无需改任何硬编码名单');
	assert.equal(start.some(key => /hidden-tool|bottom-tool|vssaros-wb:page/.test(key)), false,
		'hidden / bottomOnly / 宿主承载 tab 不得进开始页');
	const custom = registry.get('tool:custom-tool');
	assert.equal(custom.title, '自定义工具', '元数据必须由注册方描述符提供');
	assert.equal(custom.description, '无需改名单', '描述不得退化成空占位');
	assert.equal(custom.origin.registry, 'betterSidebar', '来源必须可追溯');
	assert.equal(registryClient.homeItemKey('tool', 'x'), 'tool:x', '身份前缀必须由 registry 统一生成');
	assert.equal(registryClient.isHostOwnedTab({ id: 'vssaros-wb:page' }), true);
	assert.equal(registryClient.isHostOwnedTab({ id: 'files' }), false);
	assert.deepStrictEqual(registryClient.migrateHomeItemOrder(
		{ homeWorkbenchOrder: ['a'], homeToolOrder: ['files'] }, ['a', 'tool:files', 'b']),
	['a', 'tool:files', 'b'], '双字段必须迁移成单字段并补齐新增项');
	assert.deepStrictEqual(registryClient.migrateHomeItemOrder(
		{ homeItemOrder: ['b'], homeToolOrder: ['files'] }, ['a', 'b']), ['b', 'a'],
		'已有 homeItemOrder 优先，不被旧字段覆盖');
	assert.deepStrictEqual(emptyState().homeItemOrder, [], '状态必须包含统一排序字段');
	assert.throws(() => validateState({ ...emptyState(), homeItemOrder: ['a', 'a'] }), /排序键/,
		'统一排序字段必须复用原有合法性校验');
});
await t('开始页：install-status 短轮询、目录自动发现文案与 key/身份下线', () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(source, /getHomeItemRegistry\(service, betterSidebar\)/,
		'开始页必须消费统一 HomeItemRegistry，而不是直接拼两份名单');
	assert.match(source, /selectHomeItems\(allItems, 'start'\)/,
		'开始页必须由单一投影函数按 surface 过滤');
	assert.match(source, /migrateHomeItemOrder\(saved, itemKeys\)/,
		'排序必须走统一 homeItemOrder 迁移');
	assert.match(source, /const openHomeItem = \(item, surface = 'right-tab'\)/,
		'所有 item 必须共用同一个打开入口');
	assert.match(source, /module\.exports\.catalogDiagnosticsOf = catalogDiagnosticsOf;/,
		'目录策略诊断纯函数必须导出');
	assert.match(source, /globalThis\.__vssarosWorkbenchCatalogDiagnostics/,
		'必须提供只读目录诊断探针');
	assert.match(source, /INSTALL_STATUS_URL = '\/api\/vssaros-workbenches\/install-status'/,
		'开始页必须复用现有 install-status 端点');
	assert.match(source, /fetch\(INSTALL_STATUS_URL, \{ cache: 'no-store' \}\)/,
		'开始页必须读取 install-status 且不取缓存');
	assert.match(source, /setInterval\(refresh, INSTALL_STATUS_POLL_MS\)/,
		'开始页必须短轮询 install-status');
	assert.match(source, /window\.addEventListener\('focus', onFocus\)/,
		'窗口聚焦时必须补刷 install-status');
	assert.match(source, /document\.addEventListener\('visibilitychange', onVisibility\)/,
		'页面重新可见时必须补刷 install-status');
	assert.match(source, /globalThis\.clearInterval\(timer\)/, '卸载时必须清理轮询计时器');
	assert.match(source, /data-vssaros-restart-pending/, '待重启安装提示必须有可诊断锚点');
	assert.match(source, /已安装，重启 Harness 后出现/, '必须明确提示重启后才会出现');
	assert.match(source, /\.vssaros-home-install-notice/, '待重启安装提示必须有生产样式类');
	assert.match(source, /目录自动发现/, '自动发现文案必须限定为目录自动发现');
	assert.match(source, /module\.exports\.pendingInstallsOf = pendingInstallsOf;/,
		'pending 归一化纯函数必须可测');
	assert.match(source, /HOME_HIDDEN_WORKBENCH_IDS/, '下线必须支持稳定工作台身份');
	assert.match(source, /seen\.has\((?:view\.)?key\)/, '去重必须按 page.key，不按标题');
	assert.doesNotMatch(source, /HOME_HIDDEN_TITLES/, '不得再按标题黑名单吞掉新工作台');
	assert.match(source, /this\.catalogRevision \+= 1;\s*this\.publishCatalog\(\);\s*this\.listeners\.clear\(\);\s*this\.catalogListeners\.clear\(\);/,
		'dispose 必须在清监听器前发布空目录');
	assert.deepStrictEqual(client.pendingInstallsOf({
		pending: [
			{ name: ' @me/hello ', version: '1.2.3' },
			null, { version: 'x' }, { name: '   ' },
			{ name: '@me/world' },
		],
	}), [
		{ name: '@me/hello', version: '1.2.3' },
		{ name: '@me/world', version: '' },
	]);
	assert.deepStrictEqual(client.pendingInstallsOf(null), []);
	assert.deepStrictEqual(client.pendingInstallsOf({ pending: 'bad' }), []);
	const mk = (key, title, extra = {}) => ({
		key, title, description: '', icon: '', sourceKind: 'registered', sourcePackage: '',
		kind: 'component', route: '', hidden: false, retired: false, enabled: true,
		availability: 'ready', renderHandle: 'component:' + key,
		workbenchId: key.replace(/\/[^/]*$/, ''), ...extra,
	});
	const visible = client.visibleHomePagesOf([
		mk('legacy:/x/marketplace//vssaros-wb-marketplace', '商城'),
		mk('vssaros/marketplace/default', '商城工作台'),
		mk('custom/marketplace/default', '商城工作台', { workbenchId: 'vssaros/marketplace' }),
		mk('acme/market/default', '商城工作台'),
		mk('legacy:/x/sessions//vssaros-wb-sessions', '会话'),
		mk('legacy:/x/sessions/?view=tiles/vssaros-wb-session-tiles', '会话磁贴'),
		mk('vssaros/sessions/default', '历史会话'),
		mk('vssaros/media/default', '媒体库'),
		mk('legacy:/x/media//vssaros-wb-media', '媒体库'),
		mk('third/media/default', '媒体库'),
		mk('vssaros/codebase/default', '代码库'),
		mk('legacy:/x/codebase//vssaros-wb-codebase', '代码库'),
		mk('third/codebase/default', '代码库'),
		mk('vssaros/kanban/default', 'Tasks'),
		mk('third/task/default', 'task'),
		mk('acme/tasks/default', 'Tasks'),
		mk('acme/tasks/overview', 'Tasks'),
		mk('acme/chat/default', '会话'),
		mk('acme/history/default', '历史会话'),
		mk('vssaros/workflow/default', 'Workflow'),
		mk('acme/workflow/default', 'Workflow'),
		mk('legacy:/x/kb//vssaros-wb-kb', '知识库'),
		mk('vssaros/scheduler/default', '自动化任务'),
		mk('dup/key', '重复键 A'),
		mk('dup/key', '重复键 B'),
	]);
	const keys = visible.map(page => page.key);
	const titles = visible.map(page => page.title);
	assert.ok(keys.includes('legacy:/x/marketplace//vssaros-wb-marketplace'), '必须保留商城');
	for (const hiddenKey of [
		'vssaros/marketplace/default', 'custom/marketplace/default',
		'vssaros/sessions/default', 'vssaros/kanban/default', 'vssaros/workflow/default',
		'legacy:/x/sessions//vssaros-wb-sessions',
		'legacy:/x/sessions/?view=tiles/vssaros-wb-session-tiles',
		'legacy:/x/media//vssaros-wb-media', 'legacy:/x/codebase//vssaros-wb-codebase',
	]) {
		assert.ok(!keys.includes(hiddenKey), '已知旧 key/身份必须下线：' + hiddenKey);
	}
	for (const retained of ['Tasks', 'task', 'Workflow', '会话', '历史会话', '商城工作台']) {
		assert.ok(titles.includes(retained), '新 key 的同名工作台不得被标题吞掉：' + retained);
	}
	assert.equal(titles.filter(title => title === 'Tasks').length, 2, '同名但不同 key 的新工作台都应保留');
	assert.equal(keys.filter(key => key === 'dup/key').length, 1, '重复 key 必须只保留一次');
	assert.ok(keys.includes('vssaros/media/default') && keys.includes('third/media/default'),
		'媒体库同标题不同 key 不应互相吞掉');
	assert.ok(keys.includes('vssaros/codebase/default') && keys.includes('third/codebase/default'),
		'代码库同标题不同 key 不应互相吞掉');
	assert.ok(keys.includes('legacy:/x/kb//vssaros-wb-kb'), '未在下线名单的工作台必须保留');
	assert.ok(keys.includes('vssaros/scheduler/default'), '未在下线名单的工作台必须保留');
});
await t('HMR：dispose 先发布空目录并通知订阅者', () => {
	const { service } = serviceOf();
	let notified = 0;
	service.subscribeCatalog(() => { notified += 1; });
	service.registerPage({
		workbenchId: 'acme/dispose', pageId: 'default', title: '待卸载', route: '/x/dispose/',
	}, null);
	assert.equal(service.getCatalogSnapshot().pages.length, 1);
	const beforeDispose = notified;
	service.dispose();
	assert.ok(notified > beforeDispose, 'dispose 必须通知目录订阅者');
	assert.equal(service.getCatalogSnapshot().pages.length, 0, 'dispose 后目录必须为空');
});
await t('端到端：新 registerPage() 同时产出开始页卡片与 native tab', () => {
	client.__setSidebarLayoutV1(false);
	client.__testDeleteGlobal('__vssarosWorkbenchItems');
	client.__testDeleteGlobal('__vssarosPageComponents');
	const { service, ctx } = serviceOf();
	const registered = [], disposed = [], opened = [];
	const sidebar = {
		getTabs: () => [],
		getSnapshot: () => ({ sessionId: 's1', prefs: { guideTakeover: false } }),
		subscribeState: () => () => { },
		subscribe: () => () => { },
		registerTab: descriptor => { registered.push(descriptor); return () => { disposed.push(descriptor.id); }; },
		openTab: (seed, scope) => { opened.push({ seed, scope }); },
	};
	const adapter = client.__installSidebarWorkbenchAdapter(fakeCtx(), service, sidebar);
	client.__setSidebarLayoutV1(true);
	const key = 'acme/new/default';
	const disposePage = service.registerPage({
		workbenchId: 'acme/new', pageId: 'default', title: 'Tasks',
		description: '新建工作台', route: '/x/new/',
	}, null);
	assert.ok(service.getCatalogSnapshot().pages.some(page => page.key === key));
	assert.ok(client.visibleHomePagesOf(service.getCatalogSnapshot().pages).some(page => page.title === 'Tasks'),
		'旧标题黑名单不得吞掉新工作台');
	const markup = JSON.stringify(client.makeVsSarosHomeGuide(service, ctx, sidebar)({}));
	assert.match(markup, /Tasks/, '开始页必须渲染新工作台卡片');
	assert.match(markup, /data-vssaros-home-workbench/, '开始页必须有工作台卡片锚点');
	assert.match(markup, /目录自动发现/, '开始页必须展示目录自动发现标记');
	const descriptor = registered.find(item => item.title === 'Tasks' && item.id.startsWith('vssaros-wb:'));
	assert.ok(descriptor, '新目录项必须自动注册 native tab type');
	assert.equal(descriptor.createTab({}).tab.meta.catalogKey, key);
	assert.equal(client.__openSidebarWorkbenchPage(key, { sessionId: 's1' }), true);
	assert.equal(opened[0].seed.type, descriptor.id);
	disposePage();
	assert.ok(disposed.includes(descriptor.id), '注销目录项应撤 native tab');
	adapter.dispose();
	client.__setSidebarLayoutV1(false);
});
await t('开始页工作台锚点：每个 item 都有稳定 DOM id 与一一对应的拖拽锚点', () => {
	client.__setSidebarLayoutV1(false);
	client.__testDeleteGlobal('__vssarosWorkbenchItems');
	client.__testDeleteGlobal('__vssarosPageComponents');
	const { service, ctx } = serviceOf();
	const keys = ['acme/alpha/default', 'acme/beta/default', 'acme/gamma/default'];
	for (const [index, key] of keys.entries()) {
		const workbenchId = 'acme/' + key.split('/')[1];
		service.registerPage({
			workbenchId, pageId: 'default', title: '工作台 ' + index,
			description: '锚点回归', route: '/x/' + key.split('/')[1] + '/',
		}, null);
	}
	const sidebar = {
		getTabs: () => [],
		getSnapshot: () => ({ sessionId: 's1', prefs: { guideTakeover: false } }),
		subscribe: () => () => { },
		openTab: () => { },
	};
	const markup = JSON.stringify(client.makeVsSarosHomeGuide(service, ctx, sidebar)({}));
	const cards = [...markup.matchAll(/"data-vssaros-home-workbench":"([^"]+)"/g)].map(match => match[1]);
	const anchors = [...markup.matchAll(/"data-vssaros-home-anchor":"([^"]+)"/g)].map(match => match[1]);
	const drags = [...markup.matchAll(/"data-vssaros-home-drag":"([^"]+)"/g)].map(match => match[1]);
	const cardIds = [...markup.matchAll(/"id":"(vssaros-home-workbench-[0-9a-f]{8})"/g)].map(match => match[1]);
	const anchorIds = [...markup.matchAll(/"id":"(vssaros-home-workbench-anchor-[0-9a-f]{8})"/g)].map(match => match[1]);
	assert.equal(cards.length, keys.length, '每个工作台目录项都必须渲染成卡片');
	assert.deepStrictEqual([...cards].sort(), [...keys].sort(), '卡片 key 必须完整且无额外隐藏项');
	assert.deepStrictEqual([...anchors].sort(), [...cards].sort(), '每张卡片必须有一个显式拖拽锚点');
	assert.deepStrictEqual([...drags].sort(), [...cards].sort(), '拖拽锚点必须保持原有 data-vssaros-home-drag 契约');
	assert.equal(cardIds.length, keys.length, '每张卡片必须有稳定 DOM 锚点 id');
	assert.equal(anchorIds.length, keys.length, '每个拖拽锚点必须有稳定 id');
	assert.equal(new Set(cardIds).size, keys.length, '卡片 id 不得重复');
	assert.equal(new Set(anchorIds).size, keys.length, '拖拽锚点 id 不得重复');
	for (const key of keys) {
		const cardId = client.homeWorkbenchCardIdOf(key);
		const anchorId = client.homeWorkbenchAnchorIdOf(key);
		assert.ok(markup.includes('"id":"' + cardId + '"'), '必须渲染稳定卡片 id：' + key);
		assert.ok(markup.includes('"id":"' + anchorId + '"'), '必须渲染稳定锚点 id：' + key);
		assert.ok(markup.includes('"data-vssaros-home-anchor-card":"' + anchorId + '"'),
			'卡片必须关联自己的拖拽锚点：' + key);
	}
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(source, /\.vssaros-home-workbench-card:target/, '稳定 DOM 锚点必须支持 hash 定位高亮');
	assert.match(source, /scroll-margin-top:16px/, 'hash 定位必须留出顶部滚动间距');
	assert.match(source, /\.vssaros-home-anchor \{ z-index:1; \}/, '拖拽锚点必须保持在卡片最上层');
});
await t('阶段0/1 统一目录策略：canonical/state/visibility/aliases 与投影纯函数', () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(source, /selectHomeItems\(getHomeItemRegistry\(service, betterSidebar\)\.snapshot\(\), 'nativeTab'\)/,
		'右栏适配器必须使用统一 HomeItemRegistry 的 nativeTab 投影');
	assert.match(source, /canonicalConflictsOf\(this\.catalogSnapshot\.pages\)/,
		'目录发布必须检测 active canonical 冲突');
	client.__setSidebarLayoutV1(false);
	client.__testDeleteGlobal('__vssarosWorkbenchItems');
	client.__testDeleteGlobal('__vssarosPageComponents');
	const { service } = serviceOf();
	const disposePage = service.registerPage({
		workbenchId: 'acme/policy', pageId: 'default', title: '策略页',
		description: '目录策略回归', route: '/x/policy/',
		canonicalId: 'acme/canonical', state: 'alias',
		aliases: ['legacy-policy-tab'], replacedBy: 'acme/target/default',
		visibility: { start: false, launcher: false, nativeTab: false, routeWhitelist: true, deepLink: true },
	}, null);
	const snapshot = service.getCatalogSnapshot().pages[0];
	assert.equal(snapshot.canonicalId, 'acme/canonical');
	assert.equal(snapshot.canonicalKey, 'acme/canonical/default');
	assert.equal(snapshot.state, 'alias');
	assert.equal(snapshot.visibility.start, false);
	assert.equal(snapshot.visibility.nativeTab, false);
	assert.deepStrictEqual(snapshot.aliases, ['legacy-policy-tab']);
	assert.equal(snapshot.replacedBy, 'acme/target/default');
	assert.equal(client.selectStartPages(service.getCatalogSnapshot().pages).length, 0, 'alias 且 start=false 不得进入开始页');
	assert.equal(client.selectNativeTabPages(service.getCatalogSnapshot().pages).length, 0, 'nativeTab=false 不得注册 tab type');
	assert.equal(client.selectLauncherPages(service.getCatalogSnapshot().pages).length, 0, 'alias 且 launcher=false 不得进入启动器');
	assert.deepStrictEqual(client.selectRouteWhitelist(service.getCatalogSnapshot().pages).map(page => page.route), ['/x/policy/'],
		'route 白名单与可见性必须分离');
	const diagnostics = client.catalogDiagnosticsOf(service.getCatalogSnapshot().pages);
	assert.ok(Object.isFrozen(diagnostics) && Object.isFrozen(diagnostics[0]));
	assert.equal(diagnostics[0].state, 'alias');
	assert.equal(diagnostics[0].replacedBy, 'acme/target/default');
	disposePage();

	const base = {
		key: 'acme/base/default', workbenchId: 'acme/base', pageId: 'default',
		canonicalId: 'acme/base', canonicalKey: 'acme/base/default',
		title: '基线', enabled: true, hidden: false, retired: false, availability: 'ready', state: 'active',
		visibility: { start: true, launcher: true, nativeTab: true, routeWhitelist: false, deepLink: true },
		aliases: [], replacedBy: '', route: '',
	};
	assert.deepStrictEqual(client.selectStartPages([base, { ...base }]).map(page => page.key), [base.key],
		'重复 key 必须去重');
	assert.equal(client.selectStartPages([{ ...base, state: 'alias' }]).length, 0, 'alias 不得进入开始页');
	assert.equal(client.selectStartPages([{ ...base, visibility: { ...base.visibility, start: false } }]).length, 0,
		'显式 visibility.start=false 必须生效');
	assert.deepStrictEqual(client.visibleHomePagesOf([base]).map(page => page.key), [base.key],
		'兼容别名必须保持旧行为');
	assert.deepStrictEqual(client.selectNativeTabPages([base, { ...base, key: 'acme/no-tab/default', visibility: { ...base.visibility, nativeTab: false } }]).map(page => page.key), [base.key],
		'nativeTab=false 必须被排除');
	assert.deepStrictEqual(client.selectLauncherPages([base, { ...base, key: 'acme/no-launcher/default', visibility: { ...base.visibility, launcher: false } }]).map(page => page.key), [base.key],
		'launcher=false 必须被排除');
	assert.deepStrictEqual(client.selectRouteWhitelist([
		{ route: '/x/a/' }, { route: '/x/a/' }, { route: '/x/b/' }, { route: '' },
	]).map(page => page.route), ['/x/a/', '/x/b/']);

	const activeA = { ...base, key: 'a/default', canonicalId: 'acme/same', canonicalKey: 'acme/same/default' };
	const activeB = { ...activeA, key: 'b/default' };
	const alias = { ...activeA, key: 'c/default', state: 'alias' };
	const otherPage = { ...activeA, key: 'd/overview', pageId: 'overview', canonicalKey: 'acme/same/overview' };
	const conflicts = client.canonicalConflictsOf([activeA, activeB, alias, otherPage]);
	assert.equal(conflicts.length, 1, '同一 canonicalId+pageId 只能有一个 active 可见项');
	assert.deepStrictEqual(conflicts[0].keys, [activeA.key, activeB.key]);
	const target = { key: 'acme/target/default', canonicalId: 'acme/target', canonicalKey: 'acme/target/default', aliases: [], replacedBy: '' };
	const aliasPage = {
		key: 'legacy:/x/old//old-tab', pageId: 'old-tab', aliases: ['old-tab', '/x/old/'],
		replacedBy: 'acme/target/default',
	};
	assert.equal(client.resolveLegacyTabKey({ id: 'old-tab', route: '/x/old/' }, [aliasPage, target]), target.key,
		'旧页签必须经 aliases/replacedBy 映射到 canonical 目标');
	assert.deepStrictEqual(client.legacyTabKeysOf([{ id: 'old-tab' }], [aliasPage, target]), [target.key]);
});
await t('阶段2 统一目录清单：单一 manifest 生成隐藏/退役/离线视图', () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(source, /const WORKBENCH_MANIFEST = Object\.freeze\(\[/, '必须存在单一声明式清单');
	assert.match(source, /const HOME_HIDDEN_PAGE_KEYS = new Set\(hiddenRows\.map\(row => row\.key\)\);/,
		'HOME_HIDDEN_PAGE_KEYS 必须由 manifest 生成');
	assert.match(source, /const HOME_HIDDEN_WORKBENCH_IDS = new Set\(hiddenRows\.map\(row => row\.workbenchId\)\);/,
		'HOME_HIDDEN_WORKBENCH_IDS 必须由 manifest 生成');
	assert.match(source, /const RETIRED_WORKBENCH_IDS = WORKBENCH_MANIFEST\.filter\(row => row\.state === 'retired'\)\.map\(row => row\.workbenchId\);/,
		'RETIRED_WORKBENCH_IDS 必须由 manifest 生成');
	assert.match(source, /const OFFLINE_WORKBENCH_ROUTES = WORKBENCH_MANIFEST\.filter\(row => row\.state === 'offline'\)\.map\(row => row\.route\);/,
		'OFFLINE_WORKBENCH_ROUTES 必须由 manifest 生成');
	assert.match(source, /globalThis\.__vssarosWorkbenchManifest = \(\) => WORKBENCH_MANIFEST;/,
		'必须提供只读 manifest 探针');
	assert.match(source, /globalThis\.__vssarosWorkbenchManifestViews = \(\) => manifestViewsOf\(\);/,
		'必须提供只读生成视图探针');
	assert.match(source, /module\.exports\.workbenchManifest = workbenchManifest;/,
		'manifest 必须导出供自检');
	assert.match(source, /module\.exports\.manifestViewsOf = manifestViewsOf;/,
		'生成视图必须导出供自检');
	const manifest = client.workbenchManifest();
	assert.ok(Object.isFrozen(manifest), 'manifest 必须冻结');
	assert.equal(manifest.length, 19, '11 个 hidden + 4 个 offline + 1 个 retired + 3 个 active manifest route');
	assert.equal(manifest.filter(row => row.state === 'active' && row.sourceKind === 'manifest').length, 3,
		'active manifest route 行必须恰好 3 条');
	const requiredFields = ['key', 'workbenchId', 'pageId', 'canonicalId', 'state', 'visibility', 'aliases', 'replacedBy', 'route', 'title', 'sourceKind'];
	for (const row of manifest) {
		assert.ok(Object.isFrozen(row), 'manifest 行必须冻结：' + row.key);
		for (const field of requiredFields) { assert.ok(field in row, 'manifest 行缺字段 ' + field + '：' + row.key); }
		assert.ok(Object.isFrozen(row.visibility), 'visibility 必须冻结：' + row.key);
		assert.ok(Object.isFrozen(row.aliases), 'aliases 必须冻结：' + row.key);
	}
	assert.equal(new Set(manifest.map(row => row.key)).size, manifest.length, 'manifest key 不得重复');
	const hiddenKeys = [
		'vssaros/marketplace/default', 'vssaros/sessions/default', 'vssaros/workflow/default', 'vssaros/kanban/default',
		'vssaros/kb/default',
		'legacy:/x/sessions//vssaros-wb-sessions', 'legacy:/x/sessions/?view=tiles/vssaros-wb-session-tiles',
		'legacy:/x/media//vssaros-wb-media', 'legacy:/x/codebase//vssaros-wb-codebase',
		'legacy:/x/workflow//vssaros-wb-workflow', 'legacy:/x/kanban//vssaros-wb-kanban',
	];
	const hiddenIds = [
		'vssaros/marketplace', 'vssaros/sessions', 'vssaros/workflow', 'vssaros/kanban', 'vssaros/kb',
		'legacy:/x/sessions/', 'legacy:/x/sessions/?view=tiles',
		'legacy:/x/media/', 'legacy:/x/codebase/', 'legacy:/x/workflow/', 'legacy:/x/kanban/',
	];
	const views = client.manifestViewsOf();
	assert.ok(Object.isFrozen(views) && Object.isFrozen(views.hiddenPageKeys)
		&& Object.isFrozen(views.hiddenWorkbenchIds) && Object.isFrozen(views.retiredWorkbenchIds)
		&& Object.isFrozen(views.offlineRoutes), '生成视图必须全部冻结');
	assert.deepStrictEqual([...views.hiddenPageKeys].sort(), [...hiddenKeys].sort());
	assert.deepStrictEqual([...views.hiddenWorkbenchIds].sort(), [...hiddenIds].sort());
	assert.deepStrictEqual([...views.retiredWorkbenchIds], ['vssaros/loop']);
	assert.deepStrictEqual([...views.offlineRoutes], ['/x/kanban/', '/x/workflow/', '/x/imagegen/', '/x/skills/']);
	const mk = (key, title) => ({
		key, title, workbenchId: key.replace(/\/[^/]*$/, ''), pageId: 'default',
		enabled: true, hidden: false, retired: false, availability: 'ready', state: 'active',
		visibility: { start: true, launcher: true, nativeTab: true, routeWhitelist: true, deepLink: true },
		aliases: [], replacedBy: '', route: '',
	});
	assert.equal(client.selectStartPages(hiddenKeys.map(key => mk(key, '同名'))).length, 0,
		'生成视图必须保持旧 hidden key 全部下线');
	assert.equal(client.selectStartPages([mk('vssaros/kb/default', '知识库')]).length, 0,
		'注册式知识库默认页必须被稳定 key/身份下线');
	assert.equal(client.selectStartPages([mk('vssaros/studio/default', '已退役工作台')]).length, 0,
		'宿主退役身份的注册式默认页必须从开始页摘掉');
	assert.equal(client.selectStartPages([mk('acme/tasks/default', 'Tasks')]).length, 1,
		'新 key 的同名工作台不得被误吞');
});
await t('阶段3/4 单一目录生成视图与 legacy 桥硬退役', () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(source, /@generated-workbench-directory:start workbenches-client/, 'workbenches 必须内嵌单一目录生成区块');
	assert.match(source, /globalThis\.__vssarosWorkbenchCatalogEntries = \(\) => catalogEntriesOf\(service\.getCatalogSnapshot\(\)\.pages\);/,
		'必须发布统一目录 entries 探针');
	assert.match(source, /globalThis\.__vssarosWorkbenchCatalogSubscribe = listener => service\.subscribeCatalog\(listener\);/,
		'必须发布目录订阅探针');
	assert.match(source, /vssaros-wb-catalog-change/, 'publishCatalog 必须派发目录变更事件');
	assert.match(source, /module\.exports\.catalogEntriesOf = catalogEntriesOf;/, 'entries 纯函数必须导出');
	assert.match(source, /delete globalThis\.__vssarosWorkbenchCatalogEntries/, '卸载必须清理 entries 探针');
	assert.match(source, /delete globalThis\.__vssarosWorkbenchCatalogSubscribe/, '卸载必须清理订阅探针');
	assert.match(source, /service\.registerManifestPages\(\)/, '必须由 manifest 注册 active route 页');
	assert.match(source, /globalThis\.__vssarosWorkbenchManifestPagesRegistered = true/, '必须标记 manifest 注册完成');
	assert.match(source, /module\.exports\.__registerManifestPages/, 'manifest 注册入口必须导出');
	assert.doesNotMatch(source, /__vssarosWorkbenchItems/, 'workbenches 不得再提旧全局清单');
	assert.doesNotMatch(source, /ingestLegacyCatalog/, '兼容 API 必须物理删除');
	assert.doesNotMatch(source, /legacyCatalogDisposers/, 'legacy 注销器必须物理删除');
	assert.doesNotMatch(source, /vssaros-wb-tabs-change/, '硬退役后不得再监听旧 tabs-change');
	assert.doesNotMatch(source, /legacy catalog bridge/, '硬退役后不得再存在 legacy catalog bridge effect');
	const navSrc = readFileSync(join(here, '../../vssaros-chat-surface/lib/client.workbenchNav.js'), 'utf8');
	assert.match(navSrc, /@generated-workbench-directory:start chat-surface-nav/, 'nav 必须由单一目录生成');
	assert.match(navSrc, /policyHiddenIds\(\)/, '启动器必须使用策略隐藏身份');
	assert.doesNotMatch(navSrc, /__vssarosWorkbenchItems/, 'nav 不得再发布旧全局清单');
	const marketSrc = readFileSync(join(here, '../../vssaros-chat-surface/lib/client.market.js'), 'utf8');
	assert.match(marketSrc, /GENERATED_INSTALLED_ITEMS/, '商城已装项必须来自生成投影');
	assert.match(marketSrc, /!it\.offline/, '商城 offline 过滤必须保留');
	assert.doesNotMatch(marketSrc, /__vssarosWorkbenchItems/, 'market 不得再读取旧全局清单');
	const appSrc = readFileSync(join(here, '../../vssaros-dashboard/lib/app/src/app.jsx'), 'utf8');
	assert.match(appSrc, /GENERATED_FIXED_ENTRIES/, 'dashboard app 固定入口必须来自生成投影');
	assert.doesNotMatch(appSrc, /__vssarosWorkbenchItems/, 'dashboard app 不得再读取旧全局清单');
	const catalogSrc = readFileSync(join(here, '../../vssaros-dashboard/lib/catalog.js'), 'utf8');
	assert.match(catalogSrc, /workbench-directory\.generated\.js/, 'dashboard catalog 必须引用生成文件');
	assert.doesNotMatch(catalogSrc, /export const WORKBENCH_MODULES = \[/, 'dashboard 不得再手写卡片清单');
	const skillsSrc = readFileSync(join(here, '../../vssaros-skills/lib/index.js'), 'utf8');
	assert.match(skillsSrc, /workbench-directory\.generated\.js/, 'skills 只读镜像必须引用生成文件');
	assert.doesNotMatch(skillsSrc, /const TOOLS_WORKBENCHES = \[/, 'skills 不得再手写工具镜像');
	const mk = (key, route, extra = {}) => ({
		key, title: key, workbenchId: key.replace(/\/[^/]*$/, ''), pageId: 'default',
		enabled: true, hidden: false, retired: false, availability: 'ready', state: 'active',
		visibility: { start: true, launcher: true, nativeTab: true, routeWhitelist: true, deepLink: true },
		aliases: [], replacedBy: '', route, ...extra,
	});
	const pages = [
		mk('acme/active/default', '/x/a/'),
		mk('vssaros/marketplace/default', '/x/marketplace/', {
			visibility: { start: false, launcher: false, nativeTab: true, routeWhitelist: true, deepLink: true },
		}),
	];
	const probe = client.catalogPolicyProbeOf(pages);
	assert.ok(Object.isFrozen(probe), '策略视图必须冻结');
	assert.deepStrictEqual([...probe.startPages], ['acme/active/default']);
	assert.deepStrictEqual([...probe.launcherPages], ['acme/active/default']);
	assert.deepStrictEqual([...probe.nativeTabPages], ['acme/active/default', 'vssaros/marketplace/default']);
	assert.deepStrictEqual([...probe.routeWhitelist], ['/x/a/', '/x/marketplace/']);
	assert.equal(probe.hiddenWorkbenchIds.length, 11, '策略视图必须带 11 个隐藏身份');
	assert.deepStrictEqual([...probe.retiredWorkbenchIds], ['vssaros/loop']);
	assert.deepStrictEqual([...probe.offlineRoutes], ['/x/kanban/', '/x/workflow/', '/x/imagegen/', '/x/skills/']);
	const entries = client.catalogEntriesOf([]);
	assert.ok(Object.isFrozen(entries), 'entries 投影必须冻结');
	assert.ok(entries.length >= 13, 'entries 必须覆盖全部 nav 路线');
	assert.ok(entries.some(entry => entry.route === '/x/dashboard/'), 'entries 必须包含主页深链');
	assert.ok(entries.some(entry => entry.comp === 'memory'), 'entries 必须保留记忆组件页签');
	assert.equal(client.legacyBridgeModeOf({}), 'pending');
	assert.equal(client.legacyBridgeModeOf({
		__vssarosWorkbenchPolicy: () => ({ hiddenWorkbenchIds: [] }),
		__vssarosWorkbenchCatalogEntries: () => [],
	}), 'retired');
});
await t('阶段4 硬退役：manifest active route 页替代旧全局清单收编', () => {
	client.__setSidebarLayoutV1(false);
	client.__testDeleteGlobal('__vssarosWorkbenchItems');
	client.__testDeleteGlobal('__vssarosPageComponents');
	client.__testDeleteGlobal('__vssarosWorkbenchManifestPagesRegistered');
	const { service } = serviceOf();
	assert.equal(service.getCatalogSnapshot().pages.length, 0,
		'测试桩没有 fiber，不得在 apply 时自动注册 manifest 页');
	assert.equal(client.__registerManifestPages(service), true, 'manifest active route 页必须注册成功');
	const pages = service.getCatalogSnapshot().pages;
	assert.equal(pages.length, 3);
	assert.deepStrictEqual(pages.map(page => page.title), ['知识库', '记忆', '商城']);
	assert.deepStrictEqual(pages.map(page => page.key), [
		'manifest:/x/kb//vssaros-wb-kb',
		'manifest:/x/memory//vssaros-wb-memory-tab',
		'manifest:/x/marketplace//vssaros-wb-marketplace',
	]);
	assert.equal(pages[0].description, '知识库索引与检索', 'manifest 知识库卡必须使用目录行描述');
	assert.equal(pages[0].icon, '📚', 'manifest 知识库卡必须使用目录行图标');
	assert.equal(pages[0].sourcePackage, 'vssaros-kb', 'manifest 知识库卡必须使用目录行来源');
	assert.ok(pages.every(page => page.sourceKind === 'manifest' && page.state === 'active' && page.availability === 'ready'),
		'manifest route 页必须进入统一目录且可导航');
	assert.equal(client.selectStartPages(pages).length, 3, 'manifest route 页必须出现在开始页投影');
	const registeredKbDuplicate = {
		key: 'vssaros/kb/default', title: '知识库', workbenchId: 'vssaros/kb', pageId: 'default',
		enabled: true, hidden: false, retired: false, availability: 'ready', state: 'active',
		visibility: { start: true, launcher: true, nativeTab: true, routeWhitelist: true, deepLink: true },
		aliases: [], replacedBy: '', route: '/x/kb/',
	};
	assert.equal(client.selectStartPages([...pages, registeredKbDuplicate]).length, 3,
		'注册式知识库默认页必须被隐藏，开始页只保留一张知识库卡');
	assert.equal(client.__registerManifestPages(service), false, '重复注册必须幂等');
	assert.equal(service.getCatalogSnapshot().pages.length, 3);
	service.dispose();
});
await t('P4 基础：图片 token、主页顺序纯函数、工具目录过滤与资源 tab', () => {
	client.__setSidebarLayoutV1(false);
	assert.deepStrictEqual(client.parseImageToken('看图 @image:image.png 这里'), { raw: '@image:image.png', name: 'image.png' });
	assert.equal(client.parseImageToken('没有图片'), null);
	assert.equal(client.imageVersionsUrl('my image.png', 'http://host/dir/'), 'http://host/dir/x/imagegen/api/versions?attachment=my%20image.png');
	assert.deepStrictEqual(client.pickImageVersion({
		ok: true, current: 'v2', versions: [
			{ id: 'v1', url: '/img/1', prompt: '第一版', attachment: { attachmentId: 'a1' } },
			{ id: 'v2', url: '/img/2', prompt: '第二版', attachment: { attachmentId: 'a2' } },
		],
	}, 'image.png'), { name: 'image.png', title: '第二版', url: '/img/2', attachment: { attachmentId: 'a2' } });
	assert.equal(client.pickImageVersion({ ok: false, versions: [] }, 'image.png'), null);
	assert.deepStrictEqual(client.normalizeHomeOrder(['b', 'b', 'a'], ['a', 'c']), ['b', 'a', 'c']);
	assert.deepStrictEqual(client.moveHomeOrder(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
	assert.deepStrictEqual(client.toolEntriesOf({ getTabs: () => [
		{ id: 'files', title: () => '文件' },
		{ id: 'hidden', hidden: true, title: '隐藏' },
		{ id: 'bottom', bottomOnly: true, title: '底部' },
		{ id: 'vssaros-wb:page', title: '工作台' },
	] }).map(e => [e.id, e.title]), [['files', '文件']]);
	const opened = [];
	const registered = [];
	const sidebar = {
		getSnapshot: () => ({ sessionId: 's1', prefs: {} }),
		openTab(seed) { opened.push(seed); },
		registerTab(descriptor) { registered.push(descriptor); return () => { }; },
	};
	const dispose = client.__registerImageReferenceTab(sidebar);
	client.__setSidebarLayoutV1(true);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].id, 'vssaros:image-reference');
	assert.equal(registered[0].hidden, true, '图片资源页不占开始页菜单');
	assert.equal(typeof registered[0].createTab, 'function');
	assert.notEqual(registered[0].createTab({}).tab.id, registered[0].createTab({}).tab.id);
	assert.equal(client.__openImageReference('@image:image.png'), true);
	assert.equal(opened.length, 1);
	assert.equal(opened[0].type, 'vssaros:image-reference');
	assert.equal(opened[0].meta.name, 'image.png');
	dispose();
	client.__setSidebarLayoutV1(false);
	assert.equal(client.__openImageReference('@image:image.png'), false);
});
await t('P4 接线：生图工具卡发布 loadImage 并提供右侧预览按钮，不再次执行工具', () => {
	const source = readFileSync(join(here, '..', '..', 'vssaros-imagegen', 'lib', 'client.js'), 'utf8');
	assert.match(source, /__vssarosLoadImage\s*=\s*loadImage/, '生图卡必须发布会话授权的图片加载器');
	assert.match(source, /__vssarosOpenImageReference/, '生图卡必须接右侧图片资源入口');
	assert.match(source, /在右侧预览/, '工具卡必须有右侧预览按钮');
	assert.match(source, /未重新执行工具/, '右侧预览必须明确不重跑工具');
});
await t('P5 旧页签存档：纯映射只认可映射项，不复活未知或下线项', () => {
	const pages = [
		{ key: 'legacy:/x/kb//vssaros-wb-kb', pageId: 'vssaros-wb-kb', route: '/x/kb/', workbenchId: 'legacy:/x/kb/' },
		{ key: 'vssaros/workflow/default', pageId: 'default', route: '', workbenchId: 'vssaros/workflow' },
	];
	const tabs = [
		{ id: 'vssaros-wb-kb', route: '/x/kb/' },
		{ id: 'wb:vssaros/workflow', wbId: 'vssaros/workflow' },
		{ id: 'vssaros-wb-retired', route: '/x/retired/' },
	];
	assert.deepStrictEqual(client.legacyTabKeysOf(tabs, pages), [pages[0].key, pages[1].key]);
	assert.deepStrictEqual(client.legacyTabKeysOf([null, {}, { id: 'unknown' }], pages), []);
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
	const workspaceItems = [{ workspaceId: 'w1', path: 'C:/p', title: 'p', sessionIds: ['s1'] }];
	ctx.sessions = {
		list: { getSnapshot: () => ({ byId: sessions }) },
		refresh: async () => { },
		create: async ({ workspaceId }) => {
			const workspace = workspaceItems.find(w => w.workspaceId === workspaceId);
			assert.ok(workspace, 'session creation requires a registered workspace');
			const id = 'new-' + String(workspaceId).replace(/[^A-Za-z0-9-]/g, '-');
			sessions[id] = { cwd: workspace.path, retainedBy: { mainView: 0 } };
			workspace.sessionIds.push(id);
			return id;
		},
	};
	ctx.workspaces = {
		list: { getSnapshot: () => ({ items: workspaceItems }) },
		create: async ({ path }) => {
			const workspace = { workspaceId: 'w:' + path, path, title: path, sessionIds: [] };
			workspaceItems.push(workspace);
			return workspace;
		},
	};
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
			if (names.includes('connection')) {
				assert.ok(JSON.stringify(names) === '["connection"]' || JSON.stringify(names) === '["connection","webServer"]');
				cb(ctx); return;
			}
			if (names.length === 1 && ['skills', 'vssarosAgents', 'vssarosMcpSources', 'pluginManager'].includes(names[0])) { return; }
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
			'GET /api/vssaros-workbenches/plugin-resources',
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

// ── 官方插件 item / 右栏独立插件页 / 第三方 UI 扩展点（2026-11-24）─────────────────
await t('官方插件：内容 tab 自动成为开始页 item，点击链路走统一 openTool', () => {
	const tabRegs = [];
	const disposed = [];
	const sidebar = {
		getTabs: () => tabRegs.slice(),
		subscribe: () => () => { },
		registerTab(descriptor) { tabRegs.push(descriptor); return () => { disposed.push(descriptor.id); }; },
		openTab: () => { },
	};
	const dispose = client.__registerOfficialPluginsTab(sidebar);
	assert.equal(tabRegs.length, 1);
	const descriptor = tabRegs[0];
	assert.equal(descriptor.id, client.__officialPluginsTabType);
	assert.equal(descriptor.title, '官方插件');
	assert.equal(descriptor.single, true, '插件页必须是单例，避免重复开出多个右栏页');
	assert.equal(typeof descriptor.component, 'function');
	assert.equal(descriptor.vssarosOwner, undefined, '内容 tab 不能打宿主承载标记，否则会被开始页排除');
	assert.equal(client.isHostOwnedTab(descriptor), false);
	const view = client.toolViewOf(descriptor);
	assert.equal(view.title, '官方插件');
	assert.equal(view.icon, 'plugin', '图标必须走两来源共用的关键字规则');
	const service = {
		getCatalogSnapshot: () => ({ revision: 0, pages: [] }),
		subscribeCatalog: () => () => { },
	};
	const registry = client.createHomeItemRegistry(service, sidebar);
	const item = registry.get(client.homeItemKey('tool', descriptor.id));
	assert.ok(item, 'tab 必须自动进入统一 HomeItemRegistry，无需改任何硬编码名单');
	assert.equal(item.source, '官方');
	assert.equal(item.tabId, descriptor.id);
	assert.equal(item.origin.registry, 'betterSidebar', '点击必须走 openTool(destination tab) 链路');
	assert.ok(client.selectHomeItems(registry.snapshot(), 'start').some(entry => entry.key === item.key),
		'官方插件必须出现在开始页 start 投影');
	dispose();
	assert.deepEqual(disposed, [descriptor.id], '注销必须撤掉右栏 tab type');
});
await t('插件页扩展点：第三方注册 / 排序 / 订阅 / 重复拒绝 / 注销', () => {
	const globalRegistry = client.__testGetGlobal('__vssarosPluginPageSections');
	assert.equal(typeof globalRegistry.register, 'function', '扩展点必须在模块加载时建立，不依赖页面挂载');
	assert.equal(client.__testGetGlobal('__vssarosPluginPageSectionsReady'), true,
		'就绪标志必须立即可读，供比宿主先加载的第三方插件判断');
	const registry = client.__createPluginPageSections();
	let notified = 0;
	const off = registry.subscribe(() => { notified += 1; });
	const A = () => null;
	const B = () => null;
	assert.throws(() => registry.register(null, A), /Invalid plugin page section id/);
	assert.throws(() => registry.register({ id: 'x' }, null), /Invalid plugin page section component/);
	const disposeB = registry.register({ id: 'b', title: 'B', order: 200, source: '@acme/market' }, B);
	const disposeA = registry.register({ id: 'a', title: 'A', order: 10 }, A);
	assert.throws(() => registry.register({ id: 'a' }, A), /Duplicate plugin page section/);
	assert.deepEqual(registry.snapshot().map(section => section.id), ['a', 'b'], '按 order 升序投影');
	assert.equal(registry.snapshot().find(section => section.id === 'b').source, '@acme/market');
	assert.ok(notified >= 2, '注册必须通知订阅者，页面无需轮询');
	disposeA();
	assert.deepEqual(registry.snapshot().map(section => section.id), ['b']);
	off();
	disposeB();
	assert.equal(registry.snapshot().length, 0);
});
await t('插件页：按宿主插件页目录展示「内置插件配置 + 实验性插件」，不得再投影工作台目录', () => {
	const rows = client.__officialPluginsOf();
	assert.equal(rows.length, 8, '内置 4 项 + 实验性 4 项，必须是单一展示目录');
	assert.deepEqual(rows.map(row => row.group),
		['builtin', 'builtin', 'builtin', 'builtin', 'experimental', 'experimental', 'experimental', 'experimental'],
		'分组顺序必须与截图一致：先内置配置项，后实验性插件');
	assert.deepEqual(rows.map(row => row.title),
		['子智能体', '网页搜索与获取', 'Agent 循环', '终端', '语音输入', '自定义插件索引', '自动授权审查', '变更请求与工作树']);
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.doesNotMatch(source, /function officialPluginsOf\(\) \{[\s\S]{0,400}WORK_DIRECTORY_ROWS/,
		'官方插件清单不得再把工作台目录当数据源');
	const dispose = client.__pluginPageSections.register(
		{ id: 'probe-market', title: '第三方商城', source: 'dsh-market' }, () => null);
	const markup = JSON.stringify(client.__officialPluginsPage({ tab: { id: 't1' }, visible: true }));
	assert.match(markup, /data-vssaros-plugin-page/);
	assert.match(markup, /安装、启用和配置插件/, '页头副标题按截图展示');
	assert.match(markup, /内置插件配置/);
	assert.match(markup, /实验性插件/);
	assert.match(markup, /data-vssaros-plugin-package/, '官方插件行必须渲染');
	assert.match(markup, /data-vssaros-plugin-group/);
	assert.match(markup, /实验性/, '实验性标签必须渲染');
	assert.match(markup, /data-vssaros-plugin-switch/, '实验性插件开关必须渲染');
	assert.match(markup, /设置子智能体的递归层级、数量和模型。/, '内置项说明必须按截图渲染');
	assert.match(markup, /在本机使用 SenseVoice 转录录音。首次使用需安装依赖。/, '实验项说明必须按截图渲染');
	assert.doesNotMatch(markup, /@vssaros\//, '不得再把工作台包名当官方插件内容展示');
	assert.match(markup, /probe-market/, '第三方注入的 UI 区块必须渲染在插件页内');
	assert.match(markup, /data-vssaros-plugin-section/);
	assert.doesNotMatch(markup, /data-vssaros-plugin-sections-empty/);
	dispose();
	const empty = JSON.stringify(client.__officialPluginsPage({}));
	assert.match(empty, /data-vssaros-plugin-sections-empty/);
	assert.match(empty, /暂无第三方插件插入界面/, '空态必须有文案，不能是空白');
});
await t('「更多」→ 实验性插件详情：返回入口 + 截图完整清单', () => {
	const rows = client.__experimentalPluginsOf();
	assert.equal(rows.length, 11, '「更多」页清单必须与截图一致');
	assert.deepEqual(rows.map(row => row.title), [
		'自定义插件索引', '自动授权审查', '变更请求与工作树', '个性化推荐', '开发者工具',
		'思考过程机器翻译', '随对话更新的标题', 'DSH 徽章技能', 'DeepSeek 会话导入',
		'Codex 子智能体', 'Claude Code 子智能体',
	]);
	assert.deepEqual(rows.map(row => row.badge), [
		'实验性', '实验性', '实验性', '实验性', '实验性', '实验性', '实验性', '实验性', '实验性',
		'未安装', '未安装',
	], '最后两项是「未安装」，其余带实验性标签');
	const markup = JSON.stringify(client.__experimentalPluginsPage({ onBack() { } }));
	assert.match(markup, /data-vssaros-plugin-page":"experimental"/);
	assert.match(markup, /实验性插件/, '详情页标题必须渲染');
	assert.match(markup, /data-vssaros-plugin-back/, '必须有返回插件页入口');
	assert.match(markup, /data-vssaros-plugin-switch/, '详情行必须渲染开关');
	assert.match(markup, /未安装/);
	assert.match(markup, /针对你对 DSH 的个性化需求/, '详情页说明必须按截图渲染');
	for (const row of rows) {
		assert.ok(markup.includes(row.title), '详情页必须渲染：' + row.title);
	}
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(source, /setView\('experimental'\)/, '「更多」必须切到实验性插件详情视图');
	assert.doesNotMatch(source, /'data-vssaros-plugin-more': '1', onClick: openPluginMarket/,
		'「更多」不得再打开商城工作台');
});
await t('实验性开关：接真实 pluginState / setPluginEnabled，不再全员只读', async () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(source, /pluginActionRequest\('pluginState'/, '挂载时必须读真实插件状态');
	assert.match(source, /pluginActionRequest\('setPluginEnabled'/, '切换必须写真实插件状态');
	assert.match(source, /@deepseek-ai\/dsh-experimental-voice-input-bundle/, '开关必须按完整 npm 包名定位');
	assert.match(source, /@deepseek-ai\/dsh-experimental-forge-bundle/, 'Host 必需包必须登记在锁定表');
	assert.doesNotMatch(source, /title: '实验性插件的启停由宿主「插件」页管理，本页只展示目录。'/,
		'不得再保留「只读展示」的旧口径');
	const rows = client.__officialPluginsOf();
	const voice = rows.find(row => row.id === 'voice-input');
	const forge = rows.find(row => row.id === 'change-request-worktree');
	const autoReview = rows.find(row => row.id === 'auto-review');
	const off = new Map([['@deepseek-ai/dsh-experimental-voice-input-bundle', { enabled: false, installed: true }]]);
	const on = new Map([['@deepseek-ai/dsh-experimental-voice-input-bundle', { enabled: true, installed: true }]]);
	assert.equal(client.__pluginSwitchStateOf(voice, null, '', '').disabled, true, '真源未就绪时不许假开');
	assert.equal(client.__pluginSwitchStateOf(voice, off, '', '').disabled, false, '已安装且状态就绪 ⇒ 开关可点');
	assert.equal(client.__pluginSwitchStateOf(voice, off, '', '').checked, false);
	assert.equal(client.__pluginSwitchStateOf(voice, on, '', '').checked, true);
	assert.equal(client.__pluginSwitchStateOf(voice, on, '', 'bundle-busy').disabled, true, '切换中必须锁定');
	assert.equal(client.__pluginSwitchStateOf(forge, on, '', '').locked, true, 'Host 运行必需包必须锁住');
	assert.equal(client.__pluginSwitchStateOf(forge, on, '', '').disabled, true);
	const missing = client.__pluginSwitchStateOf(autoReview, new Map(), '', '');
	assert.equal(missing.missing, true, '未安装项必须如实标注并给出引导');
	assert.equal(missing.disabled, false, '未安装项可点，不能是无声的灰开关');
	assert.equal(client.__pluginSwitchStateOf(voice, on, '插件状态服务不可用', '').disabled, true,
		'状态服务不可用时不许切换');
	assert.equal(client.__pluginSwitchStateOf(rows[0], on, '', ''), null, '内置配置项没有开关');
	// HTTP 形状：与商城/技能页同一条 Host 动作通道。
	const calls = [];
	const wired = loadClient(async (url, opts) => {
		calls.push({ url, body: JSON.parse(opts.body) });
		return { ok: true, status: 200, json: async () => ({ ok: true, plugins: [] }) };
	});
	await wired.__pluginActionRequest('pluginState', {});
	assert.equal(calls[0].url, '/x/marketplace/api/action');
	assert.deepEqual(calls[0].body, { op: 'pluginState', params: {} });
	await wired.__pluginActionRequest('setPluginEnabled', {
		name: '@deepseek-ai/dsh-experimental-voice-input-bundle', enabled: true,
	});
	assert.equal(calls[1].body.op, 'setPluginEnabled');
	assert.equal(calls[1].body.params.enabled, true);
});
await t('未安装项：Host 真源裁决 + 宿主插件页安装入口，不再出现自相矛盾的提示', () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.doesNotMatch(source, /请先在插件页或商城安装/, '旧提示里「插件页」就是当前页，必须删掉');
	assert.match(source, /name: sw\.bundle, enabled: sw\.missing \? true : !sw\.checked/,
		'未安装项必须真的调用 setPluginEnabled，由 Host 裁决能否启用');
	assert.match(source, /本页是 VsSaros 的插件展示页，不能安装官方包/, '失败时必须说明当前页身份');
	assert.match(source, /data-vssaros-plugin-open-host/, '必须提供宿主原生插件页安装入口');
	assert.match(source, /ctx\.get\('pluginNavigation'\)/, '入口必须走宿主 pluginNavigation.openList');
	assert.match(source, /registerOfficialPluginsTab\(betterSidebar, service, ctx\)/, 'ctx 必须传到插件页');
	assert.equal(client.__openHostPluginList({
		get: name => name === 'pluginNavigation' ? { openList() { } } : undefined,
	}), true, '宿主服务可用时必须打开宿主插件页');
	assert.equal(client.__openHostPluginList({ get: () => undefined }), false, '没有宿主服务时如实返回 false');
	assert.equal(client.__openHostPluginList(null), false);
	const browsed = /const browsePlugins = \(\) => \{[\s\S]*?\n\t\t\t\};/.exec(source);
	assert.ok(browsed);
	assert.doesNotMatch(browsed[0], /pluginNavigation/, '「浏览更多插件」仍不得打开宿主插件目录');
});
await t('插件页样式：容器查询 + 设计令牌 + 插件行/开关 + 第三方区块错误隔离', () => {
	const source = readFileSync(join(here, '../lib/client.js'), 'utf8');
	assert.match(source, /@container \(min-width:520px\) \{ \.vssaros-plugin-page-grid/, '必须按容器宽度响应，不用 @media');
	assert.match(source, /\.vssaros-plugin-page-row \{/, '插件行样式必须存在');
	assert.match(source, /\.vssaros-plugin-page-switch \{/, '实验性开关样式必须存在');
	assert.match(source, /\.vssaros-plugin-page-switch\.is-on/, '真实启用态必须有可见样式');
	assert.match(source, /\.vssaros-plugin-page-back \{/, '详情页返回入口样式必须存在');
	assert.match(source, /\.vssaros-plugin-page-list-plain/, '详情页列表样式必须存在');
	assert.match(source, /class PluginPageSectionBoundary extends React\.Component/, '每块第三方 UI 必须独立错误边界');
	assert.match(source, /vssaros-plugin-page-sections-ready/, '必须派发就绪事件，覆盖第三方 chunk 先于宿主加载的时序');
	assert.match(source, /vssaros-plugin-page \{[^}]*--dsw-alias-label-primary/, '不得使用裸色值');
});

console.log(results.join('\n'));
const total = results.length;
console.log(`\n[vssaros-workbenches] ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
