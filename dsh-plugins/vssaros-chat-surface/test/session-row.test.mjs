/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
const React = (await import('react')).default;
const jsx = await import('react/jsx-runtime');
const { createRoot } = await import('react-dom/client');
const hoverCards = new Map();
const primitives = {
	HoverCard: props => { hoverCards.set(props.anchor.props['data-row-key'], props); return props.anchor; },
	StateDot: ({ state }) => React.createElement('i', { 'data-state': state }),
	Tooltip: ({ children }) => children,
	IconPinFillRegular: () => React.createElement('i', { 'data-official-pin': '1' }),
	useRowDragPreview: () => ({ start() {}, clear: () => true }),
	relativeTime: () => ({ unit: 'now', n: 0 }),
};
function loadChunk(name) {
	let captured;
	window.__ModuleLoader__ = { load: value => { captured = value; } };
	new Function('window', 'document', readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'))(window, document);
	return captured.factory(name => {
		if (name === 'react') { return React; }
		if (name === 'react/jsx-runtime') { return jsx; }
		if (name === '@deepseek-ai/dsh-client-ui-primitives') { return primitives; }
		throw new Error(`Unexpected shared module: ${name}`);
	});
}
const rowModule = loadChunk('client.sessionRow.js');
loadChunk('client.conversationHeader.js');
const workspaces = loadChunk('client.workspaces.js');
const dictionary = JSON.parse(readFileSync(new URL('../../../dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai/dsh-client-ui-workspace/locale/zh.json', import.meta.url), 'utf8'));
const t = (key, args = {}) => Object.entries(args).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key] ?? key);
const listeners = new Set();
const emit = () => { for (const listener of listeners) { listener(); } };
const source = getSnapshot => ({ getSnapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
const ids = Array.from({ length: 25 }, (_, index) => `session-${index}`);
let list = { phase: 'ready', ids, byId: Object.fromEntries(ids.map((id, index) => [id, {
	id, title: `会话 ${index}`, updatedAt: Date.now() - index * 1000, running: false, blank: false,
	cwd: index < 15 ? '/repo/main' : '/repo/pkg', retainedBy: { mainView: index === 0 ? 1 : 0 },
}])), projectionsBySession: {} };
let statuses = new Map([['session-1', { running: false, pendingInteraction: 'question', completionUnread: false }]]);
let active = null;
const menuProviders = new Map();
const opened = [];
const forks = [];
const pinned = [];
const effects = [];
const menuSource = source(() => active);
const ctx = {
	get: name => ({ workspaces: { list: source(() => workspaceSnapshot) }, contextMenus: menus, sessions: ctx.sessions })[name],
	sessions: { list: source(() => list) },
	uiWorkspace: { openSession: id => { opened.push(id); }, forkSession: async id => { forks.push(id); }, pinSession: async id => { pinned.push(id); } },
	locale: { bind: () => t },
	workspaces: { list: source(() => workspaceSnapshot) },
	remoteAccess: { source: () => ({ getSnapshot: () => true }) },
	effect: callback => { const dispose = callback(); if (typeof dispose === 'function') { effects.push(dispose); } },
};
const menus = {
	active: menuSource,
	register: provider => { assert.ok(!menuProviders.has(provider.id)); menuProviders.set(provider.id, provider); return () => menuProviders.delete(provider.id); },
};
ctx.contextMenus = menus;
let workspaceSnapshot = { phase: 'ready', pinnedSessionIds: [], archivedSessionIds: [], items: [
	{ workspaceId: 'w-main', path: '/repo/main', sessionIds: ids.slice(0, 15) },
	{ workspaceId: 'w-pkg', path: '/repo/pkg', sessionIds: ids.slice(15) },
] };
document.documentElement.dataset.vssarosWorkspaces = JSON.stringify([{ id: 'ide', name: '多根项目', roots: [
	{ path: '/repo/main', name: 'main', isPrimary: true }, { path: '/repo/pkg', name: 'pkg', isPrimary: false },
] }]);
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, rooms: [], active: [], agents: [], bots: [] }) });
const registration = [];
const officialChildren = new Set(['sidebar.workspaces.directoryFlow', 'sidebar.session.row.hover', 'sidebar.session.row.leading', 'sidebar.session.row.trailing', 'sidebar.workspaces.session.row.action']);
ctx.slots = {
	inject: (_name, callback) => callback(),
	register: (spec, component) => {
		for (const name of Object.keys(spec.children || {})) {
			if (officialChildren.has(name)) { throw new Error(`slot "${name}" is already declared by the official WorkspaceBrowser`); }
		}
		registration.push({ spec, component });
		return () => {};
	},
};
const state = {};
rowModule.install(ctx, { state });
const localeService = ctx.locale;
Object.defineProperty(ctx, 'locale', { configurable: true, get: () => { throw new Error('cannot get property "locale" without inject'); } });
workspaces.install(ctx, { state });
Object.defineProperty(ctx, 'locale', { configurable: true, value: localeService });
const { spec, component: Browser } = registration.find(entry => entry.spec.id === 'vssaros-workspaces');
const root = createRoot(document.getElementById('root'));
const props = {
	wide: true,
	t,
	useSessionStatus: select => select(React.useSyncExternalStore(ctx.sessions.list.subscribe, () => statuses)),
	useContextMenuTarget: select => select(React.useSyncExternalStore(menuSource.subscribe, menuSource.getSnapshot)),
	useSessionAccess: (_id, action) => action !== 'session/rename' || allowRename,
	useContextMenu: () => ({ getTriggerProps: (target, handlers) => ({
		...handlers,
		onContextMenu: event => { event.preventDefault(); active = target; emit(); },
	}) }),
	renderFactorySlot: (name, options) => {
		assert.equal(name, 'contextMenu.button');
		return React.createElement('button', { 'aria-label': options.label, 'data-more': '1', onClick: () => { active = options.target; emit(); } }, '⋯');
	},
	renderSlot: name => {
		assert.ok(Object.hasOwn(spec.children, name), `Undeclared child slot: ${name}`);
		return name === 'vssaros.workspaces.session.row.action'
			? React.createElement('button', { 'data-quick': '1', onClick: () => pinned.push('quick') }, '置顶') : null;
	},
};
let allowRename = true;
const render = async () => { await React.act(async () => { root.render(React.createElement(Browser, props)); }); };
const mouse = async (element, type, options = {}) => { await React.act(async () => { element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options })); }); };
const key = async (element, value) => { await React.act(async () => { element.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); }); };
const row = id => document.querySelector(`[data-session-item="${id}"]`);

test('独立样式：页头与会话行局部类名不碰撞', () => {
	const localClasses = css => new Set([...css.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]));
	const rowClasses = localClasses(document.querySelector('[data-vssaros-official-session-row]').textContent);
	const headerClasses = localClasses(document.querySelector('[data-vssaros-conversation-header-style]').textContent);
	assert.deepEqual([...rowClasses].filter(name => headerClasses.has(name)), [], '独立 bundle 的 CSS Modules 必须使用不同类名');
	assert.ok([...rowClasses].every(name => name.length > 1), '会话行不能生成可污染其他插件的单字母类名');
});

test('工作区视图纯逻辑：迁移、归档、树形、多根与搜索', () => {
	const logic = workspaces.__test;
	assert.deepEqual(logic.normalizeWorkspaceView('{bad', { 'rec:old': ['a'] }), { groupBy: 'workspace', orderBy: 'manual', archivedFilter: 'default' });
	assert.deepEqual(logic.normalizeWorkspaceView({ groupBy: 'broken', orderBy: 'updated', archivedFilter: 'only' }), { groupBy: 'workspace', orderBy: 'updated', archivedFilter: 'only' });
	assert.equal(logic.sanitizeSearchQuery('a\0b'), 'ab');
	assert.equal(logic.sanitizeSearchQuery('a'.repeat(499) + '\uD83D\uDE00').length, 499);
	const options = {
		workspaces: [
			{ workspaceId: 'a', path: 'C:/Repo', sessionIds: ['a', 'blank', 'child', 'deleted'] },
			{ workspaceId: 'b', path: 'c:\\repo\\pkg', sessionIds: ['b', 'archive'] },
		],
		records: [{ id: 'parent', name: 'Project', roots: [{ path: 'C:/Repo', isPrimary: true }, { path: 'D:/Other', isPrimary: false }] }],
		sessionsById: { a: { title: 'Needle', updatedAt: 10 }, b: { title: 'Other', updatedAt: 20 }, archive: { title: 'Needle Archive', updatedAt: 30 }, blank: { blank: true }, child: { origin: 'subagent' }, deleted: {} },
		archivedIds: ['archive'], deletedIds: ['deleted'], currentSessionId: 'blank', pinnedIds: ['a'],
	};
	const grouped = logic.buildSidebar({ ...options, viewOptions: { orderBy: 'updated', archivedFilter: 'default' } });
	assert.deepEqual(grouped.map(group => group.sessions.map(session => session.id)), [['a', 'blank'], ['b']]);
	const archived = logic.buildSidebar({ ...options, viewOptions: { orderBy: 'updated', archivedFilter: 'only' } });
	assert.deepEqual(archived.flatMap(group => group.sessions.map(session => session.id)), ['archive']);
	const all = logic.buildSidebar({ ...options, viewOptions: { orderBy: 'updated', archivedFilter: 'show' } });
	const tree = logic.projectWorkspaceRows(all, { groupBy: 'workspace-tree' }, {});
	assert.deepEqual(tree.map(group => [group.key, group.depth, group.ancestors]), [['rec:parent', 0, []], ['ws:b', 1, ['parent']]]);
	assert.equal(tree[0].record.roots.length, 2);
	const flat = logic.projectWorkspaceRows(all, { groupBy: 'flat', orderBy: 'updated' }, {});
	assert.deepEqual(flat[0].sessions.map(session => session.id), ['a', 'archive', 'b', 'blank']);
	assert.equal(flat[0].sessions.find(session => session.id === 'b').groupKey, 'ws:b');
	const result = logic.deriveWorkspaceSearch(all, 'needle', { items: [{ sessionId: 'a', snippet: '<script>plain text</script>' }, { sessionId: 'b', snippet: 'Content needle' }, { sessionId: 'deleted' }, { sessionId: 'blank' }], hasMore: true });
	assert.deepEqual(result.items.map(session => session.id), ['archive', 'a', 'b']);
	assert.equal(result.items.find(session => session.id === 'a').snippet, '<script>plain text</script>');
	assert.equal(result.hasMore, true);
	assert.deepEqual(logic.deriveWorkspaceSearch(grouped, 'not found', { items: [{ sessionId: 'archive' }] }).items, []);
	assert.equal(logic.deriveWorkspaceSearch(all, 'project', { items: [] }, 1).hasMore, false);
});

test('行槽镜像：独立声明、官方动作保留、更新与卸载清理', () => {
	const logic = workspaces.__test;
	const source = 'sidebar.workspaces.session.row.action';
	const alias = logic.SESSION_ROW_SLOTS[source];
	const action = () => null;
	let entries = [{ options: { id: 'pin', order: 100 }, component: action, inject: () => ({ pin: true }), locale: 'workspace' }];
	const copies = new Map();
	const subscriptions = new Map();
	const errors = [];
	const slots = {
		inject: (_name, install) => install(),
		entries: name => name === source ? entries : [],
		subscribe: (name, update) => { subscriptions.set(name, update); return () => subscriptions.delete(name); },
		register: (options, component) => {
			assert.ok(!officialChildren.has(options.name));
			assert.equal(options.name, alias);
			assert.equal(component, action);
			assert.ok(!copies.has(options.id));
			copies.set(options.id, options);
			return () => copies.delete(options.id);
		},
	};
	const dispose = logic.mirrorSessionRowSlots(slots, error => errors.push(error));
	assert.equal(copies.size, 1);
	assert.equal(copies.get('pin').locale, 'workspace');
	assert.deepEqual(copies.get('pin').inject(), { pin: true });
	entries = entries.concat({ options: { id: 'archive', order: 200 }, component: action });
	subscriptions.get(source)();
	assert.deepEqual([...copies.keys()], ['pin', 'archive']);
	assert.deepEqual(errors, []);
	assert.equal(subscriptions.size, 4);
	dispose();
	assert.equal(copies.size, 0);
	assert.equal(subscriptions.size, 0);
	assert.equal(entries.length, 2);
});

test('添加工作区：取消、创建失败、导航失败后只重试打开', async () => {
	const phases = [];
	const creates = [];
	const opens = [];
	const service = { create: async input => { creates.push(input); return { workspaceId: 'adopted' }; } };
	const picker = { pickDirectory: async () => null };
	assert.deepEqual(await workspaces.__test.adoptWorkspace(picker, service, phase => phases.push(phase)), { canceled: true });
	assert.equal(creates.length, 0);
	picker.pickDirectory = async () => 'G:/Existing';
	picker.startSession = async () => { throw new Error('offline'); };
	const failed = await workspaces.__test.adoptWorkspace(picker, service, phase => phases.push(phase));
	assert.deepEqual(failed, { id: 'adopted', path: 'G:/Existing', openError: 'offline' });
	picker.startSession = async (id, options) => opens.push([id, options]);
	await workspaces.__test.adoptWorkspace(picker, service, phase => phases.push(phase), failed.id);
	assert.deepEqual(creates, [{ path: 'G:/Existing' }]);
	assert.deepEqual(opens, [['adopted', { clearPreviousDraft: false }]]);
	assert.deepEqual(phases, ['picking', 'picking', 'creating', 'opening', 'opening']);
	await assert.rejects(workspaces.__test.adoptWorkspace(picker, { create: async () => { throw new Error('denied'); } }, () => {}), /denied/);
	delete picker.startSession;
	picker.openWorkspaceSession = async (...args) => opens.push(args);
	await workspaces.__test.adoptWorkspace(picker, service, () => {}, 'adopted');
	assert.deepEqual(opens.at(-1), ['adopted', undefined, {}]);
});

test('官方行适配保留本地列表与操作', async context => {
	try {
		assert.equal(state.officialSessionRowVersion, '0.2.2-rc.2');
		assert.deepEqual(Object.keys(spec.children).sort(), ['vssaros.workspaces.session.row.action', 'vssaros.workspaces.session.row.hover', 'vssaros.workspaces.session.row.leading', 'vssaros.workspaces.session.row.trailing']);
		assert.equal(state.workspacesReplaced, true);
		assert.equal(state.workspacesError, undefined);
		assert.equal(spec.locale, 'workspace');
		assert.equal(spec.inject().hooks.contextMenuTarget, menus.active);
		await render();
		const firstRow = row('session-0');
		const firstRowStyle = window.getComputedStyle(firstRow);
		assert.notEqual(firstRowStyle.position, 'absolute', '会话行被页头样式污染成绝对定位后展开会重叠');
		assert.notEqual(firstRowStyle.position, 'fixed', '会话行被页头样式污染成固定定位后展开会重叠');
		assert.equal(firstRowStyle.height, '32px', '会话行必须保持官方 32px 流式高度');
		assert.equal(firstRowStyle.display.replace(/\s/g, ''), 'flex', '会话行必须保持官方 flex 行布局');
		const originalList = list;
		const originalWorkspaceSnapshot = workspaceSnapshot;
		try {
			await React.act(async () => {
				list = {
					...originalList,
					ids: [...originalList.ids, 'session-hidden-blank'],
					byId: { ...originalList.byId, 'session-hidden-blank': { blank: true, running: false, updatedAt: 1 } },
				};
				workspaceSnapshot = {
					...originalWorkspaceSnapshot,
					items: originalWorkspaceSnapshot.items.map((item, index) => index === 0
						? { ...item, sessionIds: [...item.sessionIds, 'session-hidden-blank'] } : item),
				};
				emit();
			});
			assert.equal(row('session-hidden-blank'), null, '空会话仍应被隐藏');
			assert.ok(!document.getElementById('root').textContent.includes('已隐藏'), '工作区下方不应显示隐藏空会话提示');
			assert.ok(!document.getElementById('root').textContent.includes('条空会话'), '工作区下方不应显示空会话计数文案');
		} finally {
			await React.act(async () => { list = originalList; workspaceSnapshot = originalWorkspaceSnapshot; emit(); });
		}
		assert.equal(document.querySelectorAll('.vssaros-ws-project').length, 1);
		assert.equal(document.querySelectorAll('[data-session-item]').length, 20);
		assert.ok(document.querySelector('[data-vssaros-more-sessions]'));
		assert.ok(document.querySelector('[data-vssaros-sidebar-tabs]').textContent.includes('Bots'));
		assert.ok(document.getElementById('root').textContent.includes('pkg'));
		assert.equal(row('session-1').querySelector('[data-state]').dataset.state, 'warning');
		assert.equal(hoverCards.get('session:session-1').openDelayMs, 800);
		await mouse(row('session-0'), 'click');
		await key(row('session-0'), 'Enter');
		await key(row('session-0'), ' ');
		assert.deepEqual(opened, ['session-0', 'session-0', 'session-0']);
		await React.act(async () => { row('session-0').focus(); });
		await key(row('session-0'), 'ArrowDown');
		assert.equal(document.activeElement, row('session-1'));
		const before = opened.length;
		await mouse(row('session-1').querySelector('[data-quick]'), 'click');
		assert.equal(opened.length, before);
		assert.deepEqual(pinned, ['quick']);
		await mouse(row('session-1'), 'contextmenu');
		assert.equal(active.value.sessionId, 'session-1');
		assert.equal(hoverCards.get('session:session-1').disabled, true);
		await React.act(async () => { menuProviders.get('session.vssaros.unread').resolve(active.value)[0].run(); active = null; emit(); });
		assert.equal(row('session-1').parentElement.dataset.manualUnread, '1');
		await mouse(row('session-1'), 'click');
		assert.equal(row('session-1').parentElement.dataset.manualUnread, undefined);
		await key(row('session-1'), 'Delete');
		assert.ok(document.querySelector('[data-vssaros-sess-confirm]'));
		await key(document.body, 'Escape');
		assert.equal(document.querySelector('[data-vssaros-sess-confirm]'), null);
		await mouse(row('session-2').children[1], 'mousedown', { detail: 1 });
		await mouse(row('session-2').children[1], 'dblclick');
		assert.ok(document.querySelector('input[aria-label="会话标题"]'));
		await key(document.querySelector('input[aria-label="会话标题"]'), 'Escape');
		allowRename = false;
		await render();
		await mouse(row('session-2').children[1], 'mousedown', { detail: 1 });
		await mouse(row('session-2').children[1], 'dblclick');
		assert.equal(document.querySelector('input[aria-label="会话标题"]'), null);
		await React.act(async () => { statuses = new Map([['session-2', { running: false, completionUnread: true }]]); emit(); });
		assert.equal(row('session-2').querySelector('[data-state]').dataset.state, 'done');
		const node = rowModule.toSessionNode({ id: 'session-2', title: '测试', at: 1 }, {
			byId: { child: { running: true } }, projectionsBySession: { 'session-2': { values: { subagentCatalog: [{ id: 'child' }] } } },
		}, new Map());
		assert.equal(node.runningSubagentCount, 1);
		await mouse(document.querySelector('[data-vssaros-more-sessions]'), 'click');
		assert.equal(document.querySelectorAll('[data-session-item]').length, 25);
		const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
		const dragEvent = async (id, type) => {
			const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: 60 });
			Object.defineProperty(event, 'dataTransfer', { value: transfer });
			await React.act(async () => { row(id).dispatchEvent(event); });
		};
		await dragEvent('session-2', 'dragstart');
		assert.equal(hoverCards.get('session:session-2').disabled, true);
		await dragEvent('session-4', 'dragover');
		await dragEvent('session-4', 'drop');
		const saved = localStorage.getItem('vssaros.chatSurface.sessionOrder.v1');
		const order = JSON.parse(saved)['rec:ide'];
		assert.equal(order.indexOf('session-2'), order.indexOf('session-4') + 1);
		await React.act(async () => { workspaceSnapshot = { ...workspaceSnapshot, pinnedSessionIds: ['session-4'] }; emit(); });
		await dragEvent('session-3', 'dragstart');
		await dragEvent('session-4', 'dragover');
		assert.equal(transfer.dropEffect, 'none');
		await dragEvent('session-4', 'drop');
		assert.equal(localStorage.getItem('vssaros.chatSurface.sessionOrder.v1'), saved);
		assert.ok(document.querySelector('[data-vssaros-official-session-row]').textContent.includes('dsh-sidebar-paint-inset'));
		loadChunk('client.sessionRow.js');
		assert.equal(document.querySelectorAll('[data-vssaros-official-session-row]').length, 1);
		const menuBuild = await build({ entryPoints: [new URL('../../../dsh-runtime/0.2.2-rc.2/node_modules/@deepseek-ai/dsh-client-ui-workspace/src/client/session-actions/context-menus.tsx', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, write: false, platform: 'node', format: 'cjs' });
		const module = { exports: {} };
		new Function('module', 'exports', menuBuild.outputFiles[0].text)(module, module.exports);
		module.exports.registerSessionMenus(ctx, { pinSession: ctx.uiWorkspace.pinSession, forkSession: ctx.uiWorkspace.forkSession });
		await menuProviders.get('session.fork').resolve({ sessionId: 'session-2' })[0].run();
		assert.deepEqual(forks, ['session-2']);
		document.documentElement.lang = 'zh-CN';
		const choose = async value => {
			await mouse(document.querySelector('[data-vssaros-view-button]'), 'click');
			assert.equal(document.querySelectorAll('[role="menuitemradio"]').length, 8);
			await mouse(document.querySelector(`[data-vssaros-view-choice="${value}"]`), 'click');
		};
		const input = async value => {
			const element = document.querySelector('input[aria-label="搜索工作区 / 会话"]');
			await React.act(async () => {
				Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
				element.dispatchEvent(new window.Event('input', { bubbles: true }));
			});
		};
		const wait = async () => { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, workspaces.__test.SEARCH_DELAY_MS + 30)); }); };
		await context.test('视图菜单：键盘、三种布局、排序及持久化', async () => {
			await render();
			await mouse(document.querySelector('[data-vssaros-view-button]'), 'click');
			assert.equal(document.activeElement.dataset.vssarosViewChoice, 'workspace');
			await key(document.activeElement, 'ArrowDown');
			assert.equal(document.activeElement.dataset.vssarosViewChoice, 'workspace-tree');
			await key(document.activeElement, 'Escape');
			assert.equal(document.querySelector('[data-vssaros-view-menu]'), null);
			assert.equal(document.activeElement.dataset.vssarosViewButton, '1');
			await choose('flat');
			assert.equal(document.querySelectorAll('.vssaros-ws-project').length, 0);
			assert.equal(document.querySelectorAll('[data-session-item]').length, 20);
			await choose('updated');
			assert.deepEqual(JSON.parse(localStorage.getItem(workspaces.__test.SESSION_ORDER_KEY)), {});
			assert.equal(document.querySelector('[data-session-item]').dataset.sessionItem, 'session-4');
			await choose('workspace-tree');
			assert.equal(document.querySelectorAll('.vssaros-ws-project').length, 1);
			await choose('workspace');
			assert.deepEqual(JSON.parse(localStorage.getItem(workspaces.__test.WORKSPACE_VIEW_KEY)), { groupBy: 'workspace', orderBy: 'updated', archivedFilter: 'default' });
		});
		await context.test('多根面板：点击展开不折叠会话组，再点或 Esc 收起', async () => {
			const chip = () => document.querySelector('[data-vssaros-ws-roots-chip="ide"]');
			const count = document.querySelectorAll('[data-session-item]').length;
			await mouse(chip(), 'click');
			assert.equal(chip().getAttribute('aria-expanded'), 'true');
			assert.deepEqual([...document.querySelectorAll('[data-vssaros-ws-root]')].map(el => el.getAttribute('data-vssaros-ws-root')), ['/repo/main', '/repo/pkg']);
			assert.equal(document.querySelectorAll('[data-session-item]').length, count);
			await mouse(chip(), 'click');
			assert.equal(document.querySelector('[data-vssaros-ws-roots]'), null);
			await mouse(chip(), 'click');
			await key(document.body, 'Escape');
			assert.equal(chip().getAttribute('aria-expanded'), 'false');
			assert.equal(document.querySelector('[data-vssaros-ws-roots]'), null);
		});
		await context.test('搜索：折叠组可命中、标题过滤、清空及安全摘要', async () => {
			await mouse(document.querySelector('.vssaros-ws-project'), 'click');
			assert.equal(document.querySelectorAll('[data-session-item]').length, 0);
			ctx.sessions.search = async () => ({ ok: true, value: { items: [{ sessionId: 'session-8', snippet: '<script>literal</script>' }, { sessionId: 'session-8' }], hasMore: false } });
			await mouse(document.querySelector('button[aria-label="搜索工作区 / 会话"]'), 'click');
			assert.equal(document.activeElement.tagName, 'INPUT');
			await input('会话 24');
			assert.deepEqual(Array.from(document.querySelectorAll('[data-session-item]'), node => node.dataset.sessionItem), ['session-24']);
			await wait();
			assert.equal(document.querySelectorAll('[data-session-item]').length, 2);
			assert.equal(document.querySelector('[data-vssaros-search-snippet]').textContent, '<script>literal</script>');
			assert.equal(document.querySelector('[data-vssaros-search-snippet] script'), null);
			await key(document.activeElement, 'Escape');
			assert.equal(document.querySelector('input[aria-label="搜索工作区 / 会话"]'), null);
			assert.equal(document.querySelectorAll('[data-session-item]').length, 0);
			await mouse(document.querySelector('.vssaros-ws-project'), 'click');
		});
		await context.test('搜索：旧响应取消、无结果与 Host 失败降级', async () => {
			const requests = [];
			ctx.sessions.search = (query, signal) => new Promise(resolve => requests.push({ query, signal, resolve }));
			await mouse(document.querySelector('button[aria-label="搜索工作区 / 会话"]'), 'click');
			await input('first'); await wait();
			await input('second'); await wait();
			assert.equal(requests.length, 2);
			assert.equal(requests[0].signal.aborted, true);
			await React.act(async () => { requests[1].resolve({ ok: true, value: { items: [{ sessionId: 'session-2', snippet: 'second result' }] } }); });
			await React.act(async () => { requests[0].resolve({ ok: true, value: { items: [{ sessionId: 'session-3', snippet: 'stale result' }] } }); });
			assert.deepEqual(Array.from(document.querySelectorAll('[data-session-item]'), node => node.dataset.sessionItem), ['session-2']);
			ctx.sessions.search = async () => ({ ok: false, error: { message: 'offline' } });
			await input('会话 24'); await wait();
			assert.ok(row('session-24'));
			assert.ok(document.getElementById('root').textContent.includes('offline'));
			ctx.sessions.search = async () => ({ ok: true, value: { items: [] } });
			await input('missing'); await wait();
			assert.ok(document.getElementById('root').textContent.includes('没有匹配的会话'));
			await mouse(document.querySelector('button[aria-label="清除搜索"]'), 'click');
		});
		await context.test('归档过滤及恢复，不直接打开归档会话', async () => {
			await React.act(async () => { workspaceSnapshot = { ...workspaceSnapshot, archivedSessionIds: ['session-8'] }; emit(); });
			assert.equal(row('session-8'), null);
			await choose('only');
			assert.deepEqual(Array.from(document.querySelectorAll('[data-session-item]'), node => node.dataset.sessionItem), ['session-8']);
			const before = opened.length;
			await mouse(row('session-8'), 'click');
			assert.equal(opened.length, before);
			ctx.uiWorkspace.unarchiveSession = async id => { workspaceSnapshot = { ...workspaceSnapshot, archivedSessionIds: workspaceSnapshot.archivedSessionIds.filter(value => value !== id) }; emit(); };
			await render();
			await mouse(document.querySelector('button[aria-label="恢复归档"]'), 'click');
			assert.equal(row('session-8'), null);
			await choose('default');
			assert.ok(row('session-8'));
		});
		await context.test('少量列表始终可搜索、窄栏 hook 稳定、跨窗口偏好恢复', async () => {
			await React.act(async () => { workspaceSnapshot = { ...workspaceSnapshot, items: [{ workspaceId: 'w-main', path: '/repo/main', sessionIds: ['session-0'] }] }; emit(); });
			assert.ok(document.querySelector('button[aria-label="搜索工作区 / 会话"]'));
			props.wide = false; await render(); props.wide = true; await render();
			await React.act(async () => {
				localStorage.setItem(workspaces.__test.WORKSPACE_VIEW_KEY, JSON.stringify({ groupBy: 'flat', orderBy: 'manual', archivedFilter: 'show' }));
				window.dispatchEvent(new window.StorageEvent('storage', { key: workspaces.__test.WORKSPACE_VIEW_KEY }));
			});
			assert.equal(document.querySelector('[data-vssaros-session-list]').dataset.vssarosSessionList, 'flat');
			assert.equal(document.querySelectorAll('[data-session-item]').length, 1);
		});
		await context.test('添加目录防重复请求，导航失败可仅重试打开', async () => {
			let resolvePick;
			let pickCount = 0;
			const creates = [];
			const starts = [];
			const oldGet = ctx.get;
			ctx.get = name => name === 'workspaces' ? { list: ctx.workspaces.list, create: async value => { creates.push(value); return { workspaceId: 'new-ws' }; } } : oldGet(name);
			ctx.uiWorkspace.pickDirectory = () => { pickCount++; return new Promise(resolve => { resolvePick = resolve; }); };
			ctx.uiWorkspace.startSession = async () => { throw new Error('navigation failed'); };
			await mouse(document.querySelector('button[aria-label="添加工作区"]'), 'click');
			await mouse(document.querySelector('[data-vssaros-add-directory]'), 'click');
			assert.equal(document.querySelector('button[aria-label="添加工作区"]').disabled, true);
			await mouse(document.querySelector('button[aria-label="添加工作区"]'), 'click');
			assert.equal(pickCount, 1);
			await React.act(async () => { resolvePick('/repo/new'); });
			assert.ok(document.querySelector('[data-vssaros-retry-workspace]'));
			ctx.uiWorkspace.startSession = async (...args) => starts.push(args);
			await mouse(document.querySelector('[data-vssaros-retry-workspace]'), 'click');
			assert.equal(pickCount, 1);
			assert.deepEqual(creates, [{ path: '/repo/new' }]);
			assert.deepEqual(starts, [['new-ws', { clearPreviousDraft: false }]]);
			assert.equal(document.querySelector('[data-vssaros-retry-workspace]'), null);
			ctx.get = oldGet;
		});
	} finally {
		await React.act(async () => { root.unmount(); });
		for (const dispose of effects) { dispose(); }
		dom.window.close();
	}
});
