/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createStateStore, emptyState } from '../../vssaros-workbenches/lib/state.js';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const React = (await import('react')).default;
const ReactDOM = (await import('react-dom')).default;
const { createRoot } = await import('react-dom/client');
const act = React.act;
const A = 'vssaros/desk-a';
const B = 'vssaros/desk-b';

function loadModule(relative) {
	let definition;
	window.__ModuleLoader__ = { load: value => { definition = value; } };
	new Function('window', 'document', readFileSync(new URL(relative, import.meta.url), 'utf8'))(window, document);
	return definition.factory(name => {
		if (name === 'react') { return React; }
		if (name === 'react-dom') { return ReactDOM; }
		throw new Error('Unexpected module: ' + name);
	});
}

async function fixture(bridge) {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-ui-scope-'));
	const store = createStateStore(directory);
	const initial = { ...emptyState(), added: [A, B], sessionBindings: { owned: A, other: B }, recentSessions: { [A]: 'owned' }, hiddenWorkspaces: { [A]: ['c'] } };
	await store.write({ revision: 0, state: initial });
	const savedFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		try { return Response.json(init?.method === 'POST' ? await store.write(JSON.parse(init.body)) : await store.read()); }
		catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
	};
	const workspaceListeners = new Set();
	const sessionListeners = new Set();
	const wsSnap = { phase: 'ready', items: [
		{ workspaceId: 'a', title: '目录 A', path: '/repo/a', sessionIds: ['owned', 'other', 'main'] },
		{ workspaceId: 'b', title: '目录 B', path: '/repo/b', sessionIds: [] },
		{ workspaceId: 'c', title: '目录 C', path: '/repo/c', sessionIds: [] },
	], archivedSessionIds: [], pinnedSessionIds: [] };
	const byId = {
		owned: { id: 'owned', cwd: '/repo/a', blank: false, retainedBy: {} },
		other: { id: 'other', cwd: '/repo/a', blank: false, retainedBy: {} },
		main: { id: 'main', cwd: '/repo/a', blank: false, retainedBy: { mainView: 1 } },
	};
	const calls = { native: [], created: [] };
	const effects = [];
	const slots = [];
	const provided = {};
	const source = (getSnapshot, listeners) => ({ getSnapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
	const ctx = {
		effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') { effects.push(cleanup); } return cleanup; },
		reflect: { provide: (name, value) => { provided[name] = value; return () => { delete provided[name]; }; } },
		slots: { inject: (_name, fn) => fn(), register: (spec, component) => { slots.push({ spec, component }); return () => {}; } },
		layout: { selectPanel() {}, toggleSidebar() {} },
		workspaces: { list: source(() => wsSnap, workspaceListeners) },
		sessions: {
			list: source(() => ({ ids: Object.keys(byId), byId }), sessionListeners),
			retain: () => ({ ready: Promise.resolve(), release() {} }),
			create: async request => {
				calls.created.push(request);
				const workspace = wsSnap.items.find(w => w.workspaceId === request.workspaceId);
				assert.ok(workspace);
				const id = 'new-' + calls.created.length;
				byId[id] = { id, cwd: workspace.path, blank: true, retainedBy: {} };
				workspace.sessionIds.push(id);
				for (const listener of sessionListeners) { listener(); }
				for (const listener of workspaceListeners) { listener(); }
				return id;
			},
		},
		uiWorkspace: { openSession: id => calls.native.push(id), startSession: id => calls.native.push(id) },
		get: name => ctx[name],
		inject: (names, callback) => { if (names.includes('desktopWorkbenches')) { callback({ ...ctx, desktopWorkbenches: provided.desktopWorkbenches }); } },
	};
	loadModule('../../vssaros-workbenches/lib/client.js').apply(ctx);
	const service = provided.desktopWorkbenches;
	await service.load();
	service.register({ title: '工作台 A', repository: 'vssaros:desk-a', customFrame: true }, () => null);
	service.register({ title: '工作台 B', repository: 'vssaros:desk-b', customFrame: true }, () => null);
	assert.equal(service.activate(A), true);
	service.dockTo(A, 'owned');
	loadModule('../lib/client.workspace.js').install(ctx, { state: { sessionId: 'main' }, bridge });
	const Header = slots.find(row => row.spec.id === 'vssaros-context-entry').component;
	const element = document.createElement('div');
	document.body.appendChild(element);
	const root = createRoot(element);
	const render = async sessionId => { await act(async () => { root.render(React.createElement(Header, { sessionId })); }); };
	const click = async node => {
		assert.ok(node, 'Expected an interactive element');
		await act(async () => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 30)); });
	};
	return {
		service, store, wsSnap, byId, calls, element, render, click,
		close: async () => {
			await act(async () => root.unmount());
			element.remove();
			for (const cleanup of effects.reverse()) { cleanup(); }
			globalThis.fetch = savedFetch;
			await rm(directory, { recursive: true, force: true });
		},
	};
}

async function openWorkspace(f, title) {
	await f.click(f.element.querySelector('[data-vssaros-context-chip]'));
	const row = [...f.element.querySelectorAll('[data-vssaros-context-item^="workspace:"]')].find(node => node.textContent.includes(title));
	await f.click(row);
}

test('内嵌助手没有主视图桥也能选择目录，真实存储归属不串台', async () => {
	const f = await fixture(undefined);
	try {
		await f.render('owned');
		await openWorkspace(f, '目录 B');
		assert.ok(![...f.element.querySelectorAll('[data-vssaros-context-item^="workspace:"]')].some(node => node.textContent.includes('目录 C')));
		await f.click(f.element.querySelector('[data-vssaros-context-item="root:/repo/b"] button'));
		assert.deepEqual(f.calls, { native: [], created: [{ workspaceId: 'b' }] });
		const { state } = await f.store.read();
		assert.deepEqual({ owner: state.sessionBindings['new-1'], other: state.sessionBindings.other, current: f.service.dockedSessionOf(A), main: f.byId.main.cwd },
			{ owner: A, other: B, current: 'new-1', main: '/repo/a' });
	} finally { await f.close(); }
});

test('最后一个隐藏目录重新显示后，真实状态存储接受空数组且菜单响应变化', async () => {
	const f = await fixture(undefined);
	try {
		await f.render('owned');
		await f.click(f.element.querySelector('[data-vssaros-context-chip]'));
		assert.ok(!f.element.textContent.includes('目录 C'));
		await act(async () => { await f.service.showWorkspace('c', A); });
		assert.ok(f.element.textContent.includes('目录 C'));
		assert.deepEqual((await f.store.read()).state.hiddenWorkspaces[A], []);
	} finally { await f.close(); }
});

test('普通聊天保留原来的目录桥，工作台服务不收编普通会话', async () => {
	const sent = [];
	const f = await fixture({ switchWorktree: path => { sent.push(path); }, notify() {} });
	try {
		f.service.leave();
		await f.render('main');
		await openWorkspace(f, '目录 B');
		await f.click(f.element.querySelector('[data-vssaros-context-item="root:/repo/b"] button'));
		assert.deepEqual(sent, ['/repo/b']);
		assert.deepEqual(f.calls.created, []);
		assert.equal((await f.store.read()).state.sessionBindings.main, undefined);
	} finally { await f.close(); }
});

test('SuperAgent 首轮执行会话和工作区可见，执行及等待会话不受分页隐藏', () => {
	const { buildSidebar, visibleSessions } = loadModule('../lib/client.workspaces.js').__test;
	const owner = 'vssaros/superagent';
	const workspaces = [{ workspaceId: 'sa', path: '/runs/task', sessionIds: ['desk', 'worker-task', 'step-task-build', 'unrelated'] }];
	const sessionsById = { desk: { blank: true }, 'worker-task': { blank: true, turnRunning: true },
		'step-task-build': { blank: true, pendingQuestions: 1 }, unrelated: { turnRunning: true } };
	const scope = { active: owner, state: { sessionBindings: { desk: owner, 'worker-task': owner, 'step-task-build': owner }, hiddenWorkspaces: {} } };
	for (const records of [[], [{ id: 'multi', name: '执行项目', roots: [{ path: '/runs/task', name: '执行目录', isPrimary: true }] }]]) {
		const rows = buildSidebar({ workspaces, sessionsById, workbench: scope, records });
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0].sessions.map(s => s.id).sort(), ['step-task-build', 'worker-task']);
		assert.equal(rows[0].hiddenBlanks, 1);
		const idleRows = buildSidebar({ workspaces, sessionsById: { desk: { blank: true }, 'worker-task': { blank: true }, 'step-task-build': { blank: true } }, workbench: scope, records });
		assert.equal(idleRows.length, 1);
		assert.deepEqual(idleRows[0].sessions, []);
	}
	const all = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'worker-task', status: 'running' }, { id: 'step-task-build', status: 'awaiting' }];
	assert.deepEqual(visibleSessions(all, 1).map(s => s.id), ['old-1', 'worker-task', 'step-task-build']);
});

test('左栏多根分组按工作台归属过滤，隐藏只裁剪所属根，普通模式不混工作台历史', async () => {
	const f = await fixture(undefined);
	try {
		const buildSidebar = loadModule('../lib/client.workspaces.js').__test.buildSidebar;
		const records = [{ id: 'multi', name: '多根项目', roots: [
			{ path: '/repo/a', name: '主根', isPrimary: true }, { path: '/repo/b', name: '关联根', isPrimary: false },
		] }];
		const snapshot = () => buildSidebar({ workspaces: f.wsSnap.items, records, sessionsById: f.byId,
			currentSessionId: f.service.dockedSessionOf(f.service.active), workbench: f.service.getSnapshot() });
		const sessionId = await f.service.newSessionFor(A, 'b');
		assert.deepEqual(snapshot().flatMap(row => row.sessions.map(s => s.id)).sort(), ['owned', sessionId].sort());
		await f.service.hideWorkspace('b', A);
		assert.deepEqual(snapshot().map(row => ({ roots: row.record.roots.map(r => r.path), sessions: row.sessions.map(s => s.id) })),
			[{ roots: ['/repo/a'], sessions: ['owned'] }]);
		f.service.activate(B);
		assert.deepEqual(snapshot().flatMap(row => row.sessions.map(s => s.id)), ['other']);
		f.service.leave();
		assert.deepEqual(snapshot().flatMap(row => row.sessions.map(s => s.id)), ['main']);
		assert.deepEqual(buildSidebar({ workspaces: f.wsSnap.items, records, sessionsById: f.byId,
			workbench: { active: A, state: { sessionBindings: {}, hiddenWorkspaces: {} } } }), []);
	} finally { await f.close(); }
});
