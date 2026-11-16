import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { toPackageSummary, toPackageDetail } from '../lib/shape.js';

const context = vm.createContext({ window: {}, AbortController, setTimeout, clearTimeout, DOMException });
vm.runInContext(await readFile(new URL('../lib/client.state.js', import.meta.url), 'utf8'), context);
const { createReadClient, createGate, createOperations, mergePage, itemKey } = context.window.MarketplaceState;
const response = value => ({ ok: true, json: async () => value });
const uiSource = await readFile(new URL('../lib/client.ui.js', import.meta.url), 'utf8');

test('收藏里的嵌套弹层挂到商城 main 外，不能被背景 inert 禁用', () => {
	const target = { id: 'vs-mp-overlays' };
	const sandbox = vm.createContext({ document: { getElementById: id => id === 'vs-mp-overlays' ? target : null }, window: {
		React: { createElement: (type, props, ...children) => ({ type, props, children }), useRef: value => ({ current: value }), useEffect: () => {} },
		ReactDOM: { createPortal: (node, element) => ({ node, element }) }
	} });
	vm.runInContext(uiSource, sandbox);
	const output = sandbox.window.MarketplaceUI.Drawer({ title: '收藏分组', onClose: () => {} });
	assert.equal(output.element, target);
	assert.equal(output.node.children[0].props['aria-modal'], true);
	assert.equal(output.node.children[0].props.role, 'dialog');
});

function managerHarness(props) {
	const state = []; let cursor = 0;
	const sandbox = vm.createContext({ window: { React: {
		createElement: (type, attrs, ...children) => ({ type, props: attrs || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) }),
		useState: value => { const i = cursor++; if (!(i in state)) state[i] = typeof value === 'function' ? value() : value; return [state[i], next => { state[i] = typeof next === 'function' ? next(state[i]) : next; }]; },
		useRef: value => ({ current: value }), useEffect: () => {}
	} } });
	vm.runInContext(uiSource, sandbox);
	function render() { cursor = 0; return sandbox.window.MarketplaceUI.InstalledManager(props); }
	function nodes(tree) { return typeof tree === 'object' && tree ? [tree, ...tree.children.flatMap(nodes)] : []; }
	function text(tree) { return typeof tree === 'object' && tree ? tree.children.map(text).join(' ') : String(tree ?? ''); }
	return { render, nodes, text, ui: sandbox.window.MarketplaceUI };
}
const managerFixtures = [
	{ kind: 'skill', slug: 'installed', name: '真实技能', installedVersion: '1', version: '1', latestVersion: '2', upgradable: true, icon: 'https://example.test/logo.png' },
	{ kind: 'knowledge', slug: 'local', name: '本机知识库', isLocal: true, version: '1' },
	{ kind: 'mcp', slug: 'off', name: '已停用 MCP', version: '1' },
	{ kind: 'mcp', slug: 'unknown', name: '未知 MCP', version: '1' }
];
test('管理状态只使用真实字段，未知不伪装连接成功，本机版本不等于已发布', () => {
	const ui = managerHarness({ items: [] }).ui;
	assert.equal(ui.installedStatus(managerFixtures[0], null).id, 'update');
	assert.equal(ui.installedStatus(managerFixtures[1], null).id, 'local');
	assert.equal(ui.installedStatus(managerFixtures[2], { disabled: true }).id, 'disabled');
	assert.equal(ui.installedStatus(managerFixtures[3], null).id, 'unknown');
	assert.equal(ui.installedStatus(managerFixtures[3], { type: 'stdio', approved: false }).id, 'approval');
	assert.equal(ui.installedStatus(managerFixtures[0], null).name.includes('运行正常'), false);
});
test('已安装列表、详情页签、筛选和操作使用同一稳定身份，保留本机卸载保护', () => {
	const h = managerHarness({ items: managerFixtures, servers: { off: { disabled: true } }, PkgIcon: () => {}, renderActions: () => null, onDetail: () => {}, onRefresh: () => {}, onMcpConfig: () => {}, operations: { get: () => ({}) } });
	let tree = h.render();
	assert.equal(h.nodes(tree).filter(x => x.props['data-installed-select']).length, 4);
	h.nodes(tree).find(x => x.props['data-installed-filter'] === 'local').props.onClick();
	tree = h.render(); assert.equal(h.nodes(tree).filter(x => x.props['data-installed-select']).length, 1);
	assert.ok(h.text(tree).includes('本机未发布')); assert.ok(!h.text(tree).includes('卸载…'));
	h.nodes(tree).find(x => x.props['data-installed-filter'] === 'all').props.onClick(); tree = h.render();
	h.nodes(tree).find(x => x.props['data-installed-select'] === 'mcp:off').props.onClick(); tree = h.render();
	h.nodes(tree).find(x => x.props['data-installed-panel'] === 'config').props.onClick(); tree = h.render();
	assert.ok(h.text(tree).includes('MCP 配置')); assert.ok(h.text(tree).includes('不代表连接成功'));
});
test('升级只进入既有预览回调，卸载确认前不写入，本机条目不可强制卸载', () => {
	const calls = [];
	const p = { ...managerFixtures[0] }, items = [p];
	const h = managerHarness({ items, onUpgrade: target => calls.push(['preview', target.slug]), onUninstall: target => calls.push(['uninstall', target.slug]), operations: { get: () => ({ pending: false }) } });
	let tree = h.render();
	h.nodes(tree).find(x => x.type === 'button' && h.text(x) === '升级前检查').props.onClick();
	assert.deepEqual(calls, [['preview', p.slug]]);
	h.nodes(tree).find(x => x.type === 'button' && h.text(x) === '卸载…').props.onClick(); tree = h.render();
	assert.equal(calls.length, 1);
	const modal = h.nodes(tree).find(x => x.type === h.ui.Drawer); assert.ok(modal);
	p.isLocal = true;
	h.nodes(modal).find(x => x.type === 'button' && h.text(x) === '确认卸载').props.onClick();
	assert.equal(calls.length, 1);
});

test('发现页没有已安装折叠或剔除命中，独立安装状态同步仍在', async () => {
	const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
	assert.equal(source.includes('h(InstalledFold'), false);
	assert.equal(source.includes('function InstalledFold'), false);
	assert.equal(source.includes('!it.installedVersion'), false);
	assert.ok(source.includes('refreshInstalled()')); assert.ok(source.includes('servers: mcpServerMap'));
});

test('共享映射保留真实素材、下载数、可安装性和日期', () => {
	const raw = { kind: 'skill', slug: 'real', icon: 'https://example.org/logo.png', cover: 'https://example.org/view.png', downloads: 0, installable: false, featured: true, created_at: 10, updated_at: 20, visibility: 'public' };
	for (const map of [toPackageSummary, toPackageDetail]) {
		const value = map(raw);
		for (const key of ['icon', 'cover', 'downloads', 'installable', 'featured', 'created_at', 'updated_at', 'visibility']) { assert.equal(value[key], raw[key], key); }
	}
	assert.equal(toPackageSummary({}).downloads, null);
});

test('同条件只读请求合并，分页缓存有界，私有清单不缓存', async () => {
	let calls = 0;
	const client = createReadClient({ endpoint: '/x/marketplace/api/action', fetchImpl: async () => { calls++; return response({ ok: true, items: [] }); }, maxCache: 2 });
	await Promise.all([client.read('list', { page: 1 }), client.read('list', { page: 1 })]);
	assert.equal(calls, 1);
	await client.read('list', { page: 1 });
	assert.equal(calls, 1);
	await client.read('list', { page: 2 }); await client.read('list', { page: 3 }); await client.read('list', { page: 1 });
	assert.equal(calls, 4);
	await client.read('list', { scope: 'mine' }); await client.read('list', { scope: 'mine' });
	assert.equal(calls, 6);
	client.dispose();
});

test('取消一个共享读取者不误取消其他读取者', async () => {
	let finish;
	const client = createReadClient({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
	const controller = new AbortController();
	const a = client.read('list', { page: 1 }, { signal: controller.signal });
	const b = client.read('list', { page: 1 });
	await Promise.resolve();
	controller.abort(); finish(response({ ok: true }));
	assert.equal((await a).cancelled, true);
	assert.equal((await b).ok, true);
	client.dispose();
});

test('只读超时明确失败，不留下永久在途条目', async () => {
	const client = createReadClient({ fetchImpl: () => new Promise(() => {}), timeoutMs: 10 });
	assert.equal((await client.read('list', {})).ok, false);
	client.dispose();
});

test('请求代次防止旧页面或详情回写', () => {
	const gate = createGate(); const a = gate.begin('page'), b = gate.begin('page');
	assert.equal(a.current(), false); assert.equal(a.signal.aborted, true); assert.equal(b.current(), true);
	gate.cancel('page'); assert.equal(b.current(), false);
});

test('按商品互斥、不影响其他商品，错误与加载状态可订阅', () => {
	const ops = createOperations(); let changes = 0; const off = ops.subscribe(() => changes++);
	const end = ops.begin('skill:a', 'install');
	assert.equal(ops.begin('skill:a', 'upgrade'), null); assert.ok(ops.begin('skill:b', 'install'));
	end('安装失败'); assert.equal(ops.get('skill:a').error, '安装失败'); assert.equal(ops.get('skill:a').pending, false);
	assert.equal(ops.get('skill:b').pending, true); assert.ok(changes > 0); off();
});

test('写操作失效后不复用在途旧快照', async () => {
	const queue = [];
	const client = createReadClient({ fetchImpl: () => new Promise(resolve => queue.push(resolve)) });
	const old = client.read('list', { page: 1 }); await Promise.resolve();
	client.invalidate(); const fresh = client.read('list', { page: 1 }); await Promise.resolve();
	assert.equal(queue.length, 2);
	queue[1](response({ ok: true, items: ['new'] })); await fresh;
	queue[0](response({ ok: true, items: ['old'] })); await old;
	assert.equal((await client.read('list', { page: 1 })).items[0], 'new'); client.dispose();
});

test('分页按身份去重并保留已安装命中，匹配总数不从条数猜', () => {
	const items = mergePage([{ kind: 'skill', slug: 'a', installedVersion: '1' }], [{ kind: 'skill', slug: 'a', installedVersion: '2' }, { kind: 'agent', slug: 'a' }]);
	assert.equal(items.length, 2); assert.equal(items[0].installedVersion, '2'); assert.equal(itemKey(items[1]), 'agent:a');
});
