/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { createStateStore, emptyState } from '../lib/state.js';

const A = 'vssaros/desk-a';
const B = 'vssaros/desk-b';
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const deferred = () => {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
};
const storage = () => {
	const values = new Map();
	return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

async function fixture(sessionStorage = storage()) {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-navigation-'));
	const store = createStateStore(directory);
	await store.write({ revision: 0, state: { ...emptyState(), added: [A, B], sessionBindings: { old: A, other: B }, recentSessions: { [A]: 'old' } } });
	const effects = [];
	const provided = {};
	const byId = { old: { id: 'old', cwd: '/repo/a' }, other: { id: 'other', cwd: '/repo/a' }, main: { id: 'main', cwd: '/repo/a', retainedBy: { mainView: 1 } } };
	const items = [
		{ workspaceId: 'a', title: 'A', path: '/repo/a', sessionIds: ['old', 'other', 'main'] },
		{ workspaceId: 'b', title: 'B', path: '/repo/b', sessionIds: [] },
	];
	const calls = { created: [], opened: [], picked: 0, workspaces: [] };
	let createGate;
	let pickGate;
	const ctx = {
		effect: callback => { const cleanup = callback(); if (typeof cleanup === 'function') { effects.push(cleanup); } return cleanup; },
		reflect: { provide: (name, value) => { provided[name] = value; return () => {}; } },
		slots: { register: () => () => {}, inject: (_name, callback) => callback() },
		layout: { selectPanel() {} },
		inject() {},
		workspaces: {
			list: { getSnapshot: () => ({ phase: 'ready', items }) },
			create: async ({ path }) => {
				calls.workspaces.push(path);
				const workspace = { workspaceId: 'picked', title: path, path, sessionIds: [] };
				items.push(workspace);
				return workspace;
			},
		},
		sessions: {
			list: { getSnapshot: () => ({ byId, ids: Object.keys(byId) }) },
			retain: () => ({ ready: Promise.resolve(), release() {} }),
			refresh: async () => {},
			create: async request => {
				const id = 'new-' + (calls.created.length + 1);
				calls.created.push(JSON.parse(JSON.stringify(request)));
				const wait = createGate; createGate = undefined;
				if (wait) { await wait; }
				const workspace = items.find(w => w.workspaceId === request.workspaceId);
				assert.ok(workspace);
				byId[id] = { id, cwd: workspace.path, blank: true };
				workspace.sessionIds.push(id);
				return id;
			},
		},
		uiWorkspace: {
			openSession: id => calls.opened.push(id),
			pickDirectory: async () => { calls.picked++; return pickGate ? await pickGate : '/repo/picked'; },
		},
	};
	let module;
	const style = { textContent: '', remove() {} };
	const window = { __ModuleLoader__: { load: definition => { module = definition; } }, sessionStorage, localStorage: storage(), location: { search: '', hash: '' } };
	runInNewContext(source, {
		window, console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
		document: { getElementById: () => style, createElement: () => style, head: { appendChild() {} } },
		fetch: async (_url, init) => {
			try { return Response.json(init?.method === 'POST' ? await store.write(JSON.parse(init.body)) : await store.read()); }
			catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
		},
	});
	const host = module.factory(name => {
		if (name === 'react') { return { createElement: () => null, createContext: () => ({ Provider: null }), Component: class {} }; }
		if (name === 'react-dom') { return {}; }
		throw new Error('Unexpected module: ' + name);
	});
	host.apply(ctx);
	const service = provided.desktopWorkbenches;
	await service.load();
	service.register({ title: '工作台 A', repository: 'vssaros:desk-a', customFrame: true }, () => null);
	service.register({ title: '工作台 B', repository: 'vssaros:desk-b', customFrame: true }, () => null);
	service.activate(A);
	service.dockTo(A, 'old');
	return {
		service, store, calls, byId, sessionStorage,
		holdCreate: promise => { createGate = promise; },
		holdPicker: promise => { pickGate = promise; },
		close: async () => { for (const cleanup of effects.reverse()) { cleanup(); } await service.queue; await rm(directory, { recursive: true, force: true }); },
	};
}

async function creating(f) {
	for (let i = 0; i < 100 && !f.calls.created.length; i++) { await new Promise(resolve => setImmediate(resolve)); }
	assert.ok(f.calls.created.length, 'Expected session creation to begin');
}

test('定向创建固定工作台和目录，主会话与另一工作台归属不变', async () => {
	const f = await fixture();
	try {
		const id = await f.service.newSessionFor(A, 'b');
		const state = (await f.store.read()).state;
		assert.deepEqual({ requests: f.calls.created, main: f.byId.main.cwd, owner: state.sessionBindings[id], other: state.sessionBindings.other, recent: state.recentSessions[A], docked: f.service.dockedSessionOf(A), native: f.calls.opened },
			{ requests: [{ workspaceId: 'b' }], main: '/repo/a', owner: A, other: B, recent: id, docked: id, native: [] });
	} finally { await f.close(); }
});

test('等待 preset 时切台，尚未开始的创建直接取消', async () => {
	const f = await fixture();
	try {
		const gate = deferred();
		f.service.readyPreset = () => gate.promise;
		const pending = f.service.newSessionFor(A, 'b');
		f.service.activate(B);
		gate.resolve('');
		assert.equal(await pending, undefined);
		assert.deepEqual(f.calls.created, []);
	} finally { await f.close(); }
});

test('创建已经开始后切台，结果保留原归属但不改新前台或最近指针', async () => {
	const f = await fixture();
	try {
		const gate = deferred(); f.holdCreate(gate.promise);
		const pending = f.service.newSessionFor(A, 'b');
		await creating(f);
		f.service.activate(B);
		gate.resolve();
		const id = await pending;
		const state = (await f.store.read()).state;
		assert.deepEqual({ owner: state.sessionBindings[id], active: f.service.active, recent: state.recentSessions[A], dock: f.service.dockedSessionOf(A), error: f.service.dockError },
			{ owner: A, active: B, recent: 'old', dock: 'old', error: null });
	} finally { await f.close(); }
});

test('同工作台较慢的旧创建不能覆盖新请求的停靠和持久化最近会话', async () => {
	const f = await fixture();
	try {
		const gate = deferred(); f.holdCreate(gate.promise);
		const first = f.service.newSessionFor(A, 'a');
		await creating(f);
		const second = await f.service.newSessionFor(A, 'b');
		gate.resolve();
		const old = await first;
		const state = (await f.store.read()).state;
		assert.deepEqual({ firstOwner: state.sessionBindings[old], recent: state.recentSessions[A], dock: f.service.dockedSessionOf(A), selected: f.service.defaultWorkspace(A).workspaceId },
			{ firstOwner: A, recent: second, dock: second, selected: 'b' });
	} finally { await f.close(); }
});

test('创建期间移除工作台，晚到结果不能重新添加或绑定它', async () => {
	const f = await fixture();
	try {
		const gate = deferred(); f.holdCreate(gate.promise);
		const pending = f.service.newSessionFor(A, 'b');
		await creating(f);
		await f.service.remove(A);
		gate.resolve();
		const id = await pending;
		const state = (await f.store.read()).state;
		assert.deepEqual({ added: state.added.includes(A), binding: state.sessionBindings[id], history: state.sessionBindings.old, active: f.service.active },
			{ added: false, binding: undefined, history: A, active: null });
	} finally { await f.close(); }
});

test('目录选择期间切台，不创建工作区、会话或绑定', async () => {
	const f = await fixture();
	try {
		const gate = deferred(); f.holdPicker(gate.promise);
		const pending = f.service.newWorkspaceSessionFor(A);
		f.service.activate(B); gate.resolve('/repo/new');
		assert.equal(await pending, undefined);
		assert.deepEqual({ workspaces: f.calls.workspaces, created: f.calls.created }, { workspaces: [], created: [] });
	} finally { await f.close(); }
});

test('失效最近会话只清指针，真实 validator 不拒绝且历史归属保留', async () => {
	const f = await fixture();
	try {
		await f.service.clearStaleBinding(A, 'old');
		const state = (await f.store.read()).state;
		assert.deepEqual({ owner: state.sessionBindings.old, recent: state.recentSessions[A], dock: f.service.dockedSessionOf(A) }, { owner: A, recent: undefined, dock: null });
	} finally { await f.close(); }
});

test('工作台独立隐藏目录可逆，恢复最后一项保留空数组且不删除登记', async () => {
	const f = await fixture();
	try {
		await f.service.hideWorkspaces(['a', 'b'], A);
		assert.deepEqual({ a: f.service.visibleWorkspaces(A).length, b: f.service.visibleWorkspaces(B).length }, { a: 0, b: 2 });
		await f.service.showWorkspace('a', A);
		await f.service.showWorkspace('b', A);
		assert.deepEqual((await f.store.read()).state.hiddenWorkspaces[A], []);
		assert.equal(f.service.visibleWorkspaces(A).length, 2);
		await assert.rejects(() => f.service.openSessionFor(A, 'other'), /不属于/);
	} finally { await f.close(); }
});

test('SuperAgent 执行会话在原生聊天页打开，而非不可见的工作台停靠点', async () => {
	const f = await fixture();
	try {
		f.service.register({ title: 'SuperAgent', repository: 'vssaros:superagent', customFrame: true, sessionNavigation: 'native' }, () => null);
		f.service.activate('vssaros/superagent');
		await f.service.bindSessions('vssaros/superagent', ['worker-task']);
		await f.service.openSessionFor('vssaros/superagent', 'worker-task');
		assert.deepEqual(f.calls.opened, ['worker-task']);
		assert.equal(f.service.active, null);
		assert.equal(f.service.docked.has('vssaros/superagent'), false);
		assert.equal((await f.store.read()).state.sessionBindings['worker-task'], 'vssaros/superagent');
	} finally { await f.close(); }
});

test('后台执行会话批量登记不抢前台，不改最近会话，重复同步不重写状态', async () => {
	const f = await fixture();
	try {
		await f.service.bindSessions(A, ['worker-task', 'step-task-build', 'worker-task']);
		const saved = await f.store.read();
		assert.deepEqual({ worker: saved.state.sessionBindings['worker-task'], step: saved.state.sessionBindings['step-task-build'],
			recent: saved.state.recentSessions[A], dock: f.service.dockedSessionOf(A), active: f.service.active },
			{ worker: A, step: A, recent: 'old', dock: 'old', active: A });
		await f.service.bindSessions(A, ['worker-task', 'step-task-build']);
		assert.equal((await f.store.read()).revision, saved.revision);
		await assert.rejects(() => f.service.bindSessions(A, ['other', 'not-committed']), /另一个工作台/);
		assert.equal((await f.store.read()).state.sessionBindings['not-committed'], undefined);
		f.service.activate(B);
		await f.service.bindSessions(A, ['late']);
		assert.equal((await f.store.read()).state.sessionBindings.late, undefined);
	} finally { await f.close(); }
});

test('目录选择按视图保存，恢复不读取共享 state.active', async () => {
	const sessionStorage = storage();
	const first = await fixture(sessionStorage);
	try { first.service.selectWorkspace(A, 'b'); }
	finally { await first.close(); }
	const restored = await fixture(sessionStorage);
	const otherView = await fixture();
	try {
		assert.deepEqual({ restored: restored.service.defaultWorkspace(A).workspaceId, otherView: otherView.service.defaultWorkspace(A).workspaceId }, { restored: 'b', otherView: 'a' });
	} finally { await restored.close(); await otherView.close(); }
});
