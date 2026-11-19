/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createStateStore, emptyState } from '../lib/state.js';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver,
	Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const React = (await import('react')).default;
const ReactDOM = (await import('react-dom')).default;
const { createRoot } = await import('react-dom/client');
const { act } = React;
const h = React.createElement;
const OWNER = 'vssaros/example';
const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'assistant-host-'));
	const store = createStateStore(directory);
	await store.write({ revision: 0, state: { ...emptyState(), added: [OWNER] } });
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		try { return Response.json(init?.method === 'POST' ? await store.write(JSON.parse(init.body)) : await store.read()); }
		catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
	};
	let host;
	window.__ModuleLoader__ = { load: definition => { host = definition.factory(name => name === 'react' ? React : ReactDOM); } };
	new Function('window', 'document', src)(window, document);
	const rows = [];
	const effects = [];
	const provided = {};
	const calls = { created: [], opened: [], retains: 0, releases: 0 };
	const byId = {};
	const workspaces = { phase: 'ready', items: [
		{ workspaceId: 'one', title: '项目一', path: '/projects/one', sessionIds: [] },
		{ workspaceId: 'two', title: '项目二', path: '/projects/two', sessionIds: [] },
	], archivedSessionIds: [], pinnedSessionIds: [] };
	const ctx = {
		effect: callback => { const undo = callback(); if (typeof undo === 'function') { effects.push(undo); } return undo; },
		inject() {},
		reflect: { provide: (name, value) => { provided[name] = value; return () => {}; } },
		slots: { inject: (_name, callback) => callback(), register: (spec, component) => { rows.push({ spec, component }); return () => {}; } },
		layout: { selectPanel() {}, toggleSidebar() {} },
		workspaces: { list: { getSnapshot: () => workspaces, subscribe: () => () => {} } },
		sessions: {
			list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) },
			retain: () => { calls.retains++; return { ready: Promise.resolve(), release: () => calls.releases++ }; },
			create: async request => {
				calls.created.push(request);
				const id = 'session-' + calls.created.length;
				const workspace = workspaces.items.find(item => item.workspaceId === request.workspaceId);
				byId[id] = { id, cwd: workspace.path, blank: false };
				workspace.sessionIds.push(id);
				return id;
			},
		},
		uiWorkspace: { openSession: id => calls.opened.push(id) },
	};
	host.apply(ctx);
	const service = provided.desktopWorkbenches;
	await service.load();
	const Overlay = rows.find(row => row.spec.name === 'shell.overlay').component;
	const SessionProvider = ({ children }) => children;
	const input = () => h('input', { 'data-native-input': '', defaultValue: 'draft' });
	const node = document.createElement('div');
	document.body.appendChild(node);
	const root = createRoot(node);
	const render = async view => {
		await act(async () => { root.render(h(React.Fragment, null, view, h(Overlay, { SessionProvider, renderSlot: input }))); });
		await act(async () => { await service.queue; });
	};
	const click = async element => { assert.ok(element); await act(async () => { element.click(); await new Promise(resolve => setTimeout(resolve, 20)); }); };
	return {
		service, node, render, click, store, calls,
		close: async () => {
			await act(async () => root.unmount());
			node.remove();
			await service.queue;
			for (const cleanup of effects.reverse()) { cleanup(); }
			globalThis.fetch = previousFetch;
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test('整页工作台始终使用宿主浮动助手工具栏，旧标志只隐藏外开按钮', async () => {
	const f = await fixture();
	try {
		f.service.register({ title: '示例', repository: 'vssaros:example', customFrame: true, floatingActions: false }, () => h('section', { 'data-business': '' }, '业务'));
		await f.render(h(f.service.View, { id: OWNER, active: true }));
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-hosted-assistant]').length, 1);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-actions]').length, 1);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-open-external]').length, 0);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-assistant-toggle]').length, 0);
		const toolbar = f.node.querySelector('[role="toolbar"]');
		assert.equal(toolbar.getAttribute('aria-label'), 'AI 助手工具栏');
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-workspace-picker]').length, 1);
		assert.deepEqual(f.calls.created, []);
		const select = f.node.querySelector('select');
		await act(async () => { select.value = 'two'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
		assert.ok(f.node.textContent.includes('/projects/two'));
		await f.click([...f.node.querySelectorAll('button')].find(button => button.textContent === '开始对话'));
		assert.deepEqual(f.calls.created, [{ workspaceId: 'two' }]);
		assert.equal((await f.store.read()).state.sessionBindings['session-1'], OWNER);
		assert.ok(f.node.querySelector('[data-business]'));
		assert.deepEqual(f.calls.opened, []);
		const input = f.node.querySelector('[data-native-input]');
		assert.ok(input);
		input.value = '未发送草稿';
		const retains = f.calls.retains;
		const toggle = f.node.querySelector('[data-vssaros-wb-assist]');
		assert.equal(toggle.getAttribute('aria-expanded'), 'true');
		assert.equal(toggle.textContent, '»');
		await f.click(toggle);
		assert.equal(f.node.querySelector('.vssWbHostedContent').hidden, true);
		assert.equal(toggle.getAttribute('aria-label'), '展开 AI 助手');
		assert.equal(toggle.getAttribute('aria-expanded'), 'false');
		assert.equal(toggle.textContent, '«');
		await f.click(toggle);
		assert.equal(toggle.getAttribute('aria-label'), '收起 AI 助手');
		assert.equal(toggle.getAttribute('aria-expanded'), 'true');
		assert.equal(f.node.querySelector('[data-native-input]'), input);
		assert.equal(input.value, '未发送草稿');
		assert.equal(f.calls.retains, retains);
	} finally { await f.close(); }
});

test('已有内嵌助手不重复挂载，业务子页面移除助手后宿主兜底出现', async () => {
	const f = await fixture();
	try {
		let showInline;
		const Business = props => {
			const [shown, setShown] = React.useState(true);
			showInline = setShown;
			const [collapsed, setCollapsed] = React.useState(false);
			const element = React.useRef(null);
			React.useEffect(() => {
				const expand = () => setCollapsed(false);
				const collapse = () => setCollapsed(true);
				const root = element.current;
				root.addEventListener('vssaros:assist-expand', expand);
				root.addEventListener('vssaros:assist-collapse', collapse);
				return () => { root.removeEventListener('vssaros:assist-expand', expand); root.removeEventListener('vssaros:assist-collapse', collapse); };
			}, []);
			return h('section', { ref: element, 'data-vssaros-assist-collapsed': collapsed ? '1' : '0' },
				shown ? h('div', { hidden: collapsed }, props.conversation) : '业务详情');
		};
		f.service.register({ title: '示例', repository: 'vssaros:example', customFrame: true, floatingActions: false }, Business);
		await f.render(h(f.service.View, { id: OWNER, active: true }));
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-hosted-assistant]').length, 0);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-workspace-picker]').length, 1);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-actions]').length, 1);
		const toggle = f.node.querySelector('[data-vssaros-wb-assist]');
		await f.click(toggle);
		assert.equal(f.node.querySelector('section').getAttribute('data-vssaros-assist-collapsed'), '1');
		assert.equal(toggle.getAttribute('aria-expanded'), 'false');
		await f.click(toggle);
		assert.equal(f.node.querySelector('section').getAttribute('data-vssaros-assist-collapsed'), '0');
		assert.equal(toggle.getAttribute('aria-expanded'), 'true');
		assert.deepEqual(f.calls.created, []);
		assert.deepEqual(f.calls.opened, []);
		await act(async () => showInline(false));
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-hosted-assistant]').length, 1);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-workspace-picker]').length, 1);
		await act(async () => showInline(true));
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-hosted-assistant]').length, 0);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-new-session]').length, 1);
	} finally { await f.close(); }
});

test('旧 detach 工作台在宿主助手中仍能停靠对话，默认分栏保留原位置', async () => {
	const f = await fixture();
	try {
		f.service.register({ title: '示例', repository: 'vssaros:example', splitConversation: false, floatingActions: false }, () => h('section', null, '业务'));
		await f.render(h(f.service.View, { id: OWNER, active: true }));
		assert.equal(f.service.conversationMode(OWNER), 'inline');
		await f.click([...f.node.querySelectorAll('button')].find(button => button.textContent === '开始对话'));
		assert.ok(f.node.querySelector('[data-native-input]'));
		assert.deepEqual(f.calls.opened, []);
		await act(async () => { f.service.register({ title: '分栏', repository: 'vssaros:split', floatingActions: false }, () => h('section', null, '分栏业务')); });
		await f.render(h(f.service.View, { id: 'vssaros/split', active: true }));
		assert.equal(f.node.querySelectorAll('.vssWbSplitConversation').length, 1);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-hosted-assistant]').length, 0);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-actions]').length, 1);
		const pane = f.node.querySelector('.vssWbSplitConversation');
		const picker = pane.querySelector('select');
		const toggle = f.node.querySelector('[data-vssaros-wb-assist]');
		await f.click(toggle);
		assert.equal(pane.hidden, true);
		assert.equal(toggle.getAttribute('aria-expanded'), 'false');
		await f.click(toggle);
		assert.equal(pane.hidden, false);
		assert.equal(pane.querySelector('select'), picker);
		assert.equal(toggle.getAttribute('aria-expanded'), 'true');
		assert.deepEqual(f.calls.opened, []);
	} finally { await f.close(); }
});

test('没有自有折叠事件的内嵌助手仍可通过统一浮动工具栏控制', async () => {
	const f = await fixture();
	try {
		f.service.register({ title: '示例', repository: 'vssaros:example', customFrame: true, floatingActions: false }, props => h('section', null, props.conversation));
		await f.render(h(f.service.View, { id: OWNER, active: true }));
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-hosted-assistant]').length, 0);
		const pane = f.node.querySelector('[data-vssaros-wb-conversation]');
		const toggle = f.node.querySelector('[data-vssaros-wb-assist]');
		await f.click(toggle);
		assert.equal(pane.hidden, true);
		assert.equal(toggle.getAttribute('aria-expanded'), 'false');
		await f.click(toggle);
		assert.equal(pane.hidden, false);
		assert.equal(toggle.getAttribute('aria-expanded'), 'true');
		assert.equal(f.node.querySelector('[data-vssaros-wb-conversation]'), pane);
		assert.deepEqual(f.calls.created, []);
		assert.deepEqual(f.calls.opened, []);
	} finally { await f.close(); }
});

test('浮动工具栏只在当前工作台显示，卸载清理全局指针监听与观察器', async () => {
	const f = await fixture();
	const originalAdd = window.addEventListener;
	const originalRemove = window.removeEventListener;
	const pointers = new Set();
	window.addEventListener = function (name, fn, ...rest) {
		if (['pointermove', 'pointerup', 'pointercancel'].includes(name)) { pointers.add(fn); }
		return originalAdd.call(this, name, fn, ...rest);
	};
	window.removeEventListener = function (name, fn, ...rest) {
		if (['pointermove', 'pointerup', 'pointercancel'].includes(name)) { pointers.delete(fn); }
		return originalRemove.call(this, name, fn, ...rest);
	};
	try {
		f.service.register({ title: '示例', repository: 'vssaros:example', customFrame: true, floatingActions: false }, () => h('section', null, '业务'));
		await f.render(h(f.service.View, { id: OWNER, active: true }));
		const toolbar = f.node.querySelector('[data-vssaros-wb-actions]');
		assert.ok(pointers.size > 0);
		assert.equal(window.__vssarosResetWorkbenchActions(), 1);
		await f.render(null);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-actions]').length, 0);
		assert.equal(toolbar.__vssMounted, false);
		assert.equal(pointers.size, 0);
		assert.equal(window.__vssarosResetWorkbenchActions(), 0);
		assert.equal(f.service.active, null);
	} finally {
		await f.close();
		window.addEventListener = originalAdd;
		window.removeEventListener = originalRemove;
	}
});

test('SSR 工作台保留完整 URL 并有助手，不伪造 provider，晚到注册不冲突', async () => {
	const f = await fixture();
	try {
		let nav;
		window.__ModuleLoader__ = { load: definition => { nav = definition.factory(() => React); } };
		new Function('window', await readFile(new URL('../../vssaros-chat-surface/lib/client.workbenchNav.js', import.meta.url), 'utf8'))(window);
		const { renderWorkbenchPage, pageWorkbenchIdOf } = nav.__test;
		const tab = { id: 'vssaros-wb-example', name: '页面工作台', route: '/x/example/?view=tiles' };
		assert.equal(pageWorkbenchIdOf(tab), OWNER);
		assert.equal(pageWorkbenchIdOf({ id: 'group:settings', route: '/x/agents/' }), '');
		const ordinary = h('div', null, '群设置');
		assert.equal(renderWorkbenchPage(f.service, { id: 'group:settings', route: '/x/agents/' }, true, ordinary), ordinary);
		const page = () => renderWorkbenchPage(f.service, tab, true,
			h('iframe', { src: '/x/example/?view=tiles&surface=editor', title: '页面' }));
		await f.render(page());
		assert.equal(f.service.has(OWNER), false);
		assert.equal(f.service.available(OWNER), true);
		assert.equal(f.node.querySelector('iframe').getAttribute('src'), '/x/example/?view=tiles&surface=editor');
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-hosted-assistant]').length, 1);
		assert.equal(f.node.querySelectorAll('[role="toolbar"]').length, 1);
		assert.equal(f.node.querySelectorAll('[data-vssaros-wb-assistant-toggle]').length, 0);
		const iframe = f.node.querySelector('iframe');
		await f.click(f.node.querySelector('[data-vssaros-wb-assist]'));
		assert.equal(f.node.querySelector('.vssWbHostedContent').hidden, true);
		await f.click(f.node.querySelector('[data-vssaros-wb-assist]'));
		assert.equal(f.node.querySelector('iframe'), iframe);
		await f.click([...f.node.querySelectorAll('button')].find(button => button.textContent === '开始对话'));
		assert.equal(f.node.querySelector('iframe'), iframe);
		assert.ok(f.node.querySelector('[data-native-input]'));
		await act(async () => { f.service.register({ title: '真正的插件', repository: 'vssaros:example', customFrame: true }, () => h('div', null, '组件')); });
		assert.equal(f.service.has(OWNER), true);
		assert.deepEqual(f.calls.opened, []);
		await f.render(null);
		assert.equal(f.service.active, null);
		assert.equal(f.service.pageFrames.length, 0);
	} finally { await f.close(); }
});
