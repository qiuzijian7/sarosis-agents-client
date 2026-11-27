/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';

const source = readFileSync(new URL('../lib/client.interactionRecovery.js', import.meta.url), 'utf8');
function load(window = {}, overrides = {}) {
	let definition;
	window.__ModuleLoader__ = { load: value => { definition = value; } };
	new Function('window', 'setInterval', 'clearInterval', 'Date', source)(window,
		overrides.setInterval || setInterval, overrides.clearInterval || clearInterval, overrides.Date || Date);
	return definition.factory(name => { assert.equal(name, 'react'); return React; });
}
const tool = (callId, name = 'ask_user_question') => ({ type: 'event', event: { type: 'tool/call', data: { callId, name } } });
const result = callId => ({ type: 'event', event: { type: 'tool/result', data: { callId } } });
const boundary = type => ({ type: 'event', event: { type } });
const facts = extra => ({ sessionId: 'session-1', callId: 'call-208', running: true, visible: false, connection: 'connected', ...extra });
function fixture(overrides = {}) {
	let clock = 0;
	let reconnects = 0;
	const reported = [];
	const machine = load().__test.createRecovery({ now: () => clock, reconnect: () => { reconnects++; }, reveal: () => false,
		report: value => reported.push(value), ...overrides });
	return { machine, reported, advance: ms => { clock += ms; }, reconnects: () => reconnects };
}

test('legacy blocking questions are detected from the same live event shape as the failed Session', () => {
	const active = load().__test.activeQuestionCalls;
	assert.deepEqual(active([boundary('turn/start'), tool('other', 'read_file'), tool('call-208')]), ['call-208']);
	assert.deepEqual(active([tool('call-208'), result('other')]), ['call-208']);
	assert.deepEqual(active([tool('call-208'), result('call-208')]), []);
	assert.deepEqual(active([tool('call-208'), boundary('turn/end')]), []);
	assert.deepEqual(active([tool('call-208'), boundary('turn/start'), tool('next', 'request_user_input')]), ['next']);
	assert.deepEqual(active([{ type: 'transient', event: { type: 'tool/call', data: { name: 'ask_user_question', callId: 'transient' } } }]), []);
});

test('missing legacy UI triggers one official event replay after a render grace period', () => {
	const f = fixture();
	assert.equal(f.machine.check(facts()), null);
	f.advance(2999);
	assert.equal(f.machine.check(facts()), null);
	f.advance(1);
	assert.equal(f.machine.check(facts()).phase, 'reconnecting');
	f.advance(3000);
	assert.equal(f.machine.check(facts()).phase, 'missing');
	for (let i = 0; i < 30; i++) { f.advance(1000); f.machine.check(facts()); }
	assert.equal(f.reconnects(), 1);
});

test('a replayed question panel clears the warning without answering or cancelling the request', () => {
	const f = fixture();
	f.machine.check(facts()); f.advance(3000); f.machine.check(facts());
	assert.equal(f.machine.check(facts({ pending: { kind: 'question' }, visible: true })), null);
	assert.equal(f.reported.at(-1).phase, 'visible');
	assert.equal(f.reconnects(), 1);
});

test('a visible normal question or an active approval does not get reconnected', () => {
	for (const state of [facts({ visible: true }), facts({ pending: { kind: 'approval' } })]) {
		const f = fixture();
		f.machine.check(state); f.advance(30000);
		assert.equal(f.machine.check(state), null);
		assert.equal(f.machine.retry(state), null);
		assert.equal(f.reconnects(), 0);
	}
});

test('known hidden timed questions remain hidden until the user explicitly reveals the official panel', () => {
	const reveals = [];
	const f = fixture({ reveal: (...args) => { reveals.push(args); return true; } });
	const hidden = facts({ projected: true });
	f.machine.check(hidden); f.advance(5000);
	assert.equal(f.machine.check(hidden).phase, 'missing');
	assert.equal(f.reconnects(), 0);
	assert.equal(f.machine.retry(hidden).phase, 'revealing');
	assert.deepEqual(reveals, [['session-1', 'call-208']]);
	assert.equal(f.reconnects(), 0);
});

test('a hidden background page does not consume the foreground recovery budget', () => {
	const f = fixture();
	f.machine.check(facts({ foreground: false })); f.advance(10000);
	assert.equal(f.machine.check(facts({ foreground: false })), null);
	assert.equal(f.reconnects(), 0);
	f.machine.check(facts({ foreground: true })); f.advance(3000);
	f.machine.check(facts({ foreground: true }));
	assert.equal(f.reconnects(), 1);
});

test('normal reconnection waits for readiness rather than starting overlapping generations', () => {
	const f = fixture();
	f.machine.check(facts()); f.advance(5000);
	assert.equal(f.machine.check(facts({ connection: 'connecting' })).phase, 'reconnecting');
	assert.equal(f.machine.retry(facts({ connection: 'connecting' })), null);
	assert.equal(f.reconnects(), 0);
	f.machine.check(facts());
	assert.equal(f.reconnects(), 1);
});

test('completed, cancelled and historical calls never trigger a replay', () => {
	for (const state of [facts({ callId: undefined }), facts({ running: false })]) {
		const f = fixture();
		f.machine.check(state); f.advance(10000);
		assert.equal(f.machine.check(state), null);
		assert.equal(f.reconnects(), 0);
	}
});

test('manual retry remains available after a failed replay without an automatic reconnect loop', () => {
	const f = fixture();
	f.machine.check(facts()); f.advance(4000); f.machine.check(facts()); f.advance(4000);
	assert.equal(f.machine.check(facts()).phase, 'missing');
	assert.equal(f.machine.retry(facts()).phase, 'reconnecting');
	assert.equal(f.reconnects(), 2);
	f.advance(4000); f.machine.check(facts());
	assert.equal(f.reconnects(), 2);
});

test('reconnect failures produce a visible retry state and remain bounded', () => {
	let attempts = 0;
	const f = fixture({ reconnect: () => { attempts++; throw new Error('unavailable'); } });
	f.machine.check(facts()); f.advance(3000);
	assert.equal(f.machine.check(facts()).phase, 'failed');
	f.advance(3000); f.machine.check(facts());
	assert.equal(attempts, 1);
});

test('a new call in the same Session has its own one-shot recovery budget', () => {
	const f = fixture();
	f.machine.check(facts()); f.advance(3000); f.machine.check(facts());
	f.machine.check(facts({ callId: 'next' })); f.advance(3000); f.machine.check(facts({ callId: 'next' }));
	assert.equal(f.reconnects(), 2);
});

test('visibility checks do not mistake a hidden or collapsed question for an operable panel', () => {
	const dom = new JSDOM('<div data-composer-seat><div id="container"><div data-question-key="question"></div></div></div>');
	const { panelVisible } = load(dom.window).__test;
	const seat = dom.window.document.querySelector('[data-composer-seat]');
	const panel = seat.querySelector('[data-question-key]');
	panel.getBoundingClientRect = () => ({ width: 500, height: 250 });
	assert.equal(panelVisible(seat), true);
	seat.querySelector('#container').style.display = 'none';
	assert.equal(panelVisible(seat), false);
	seat.querySelector('#container').style.display = '';
	panel.hidden = true;
	assert.equal(panelVisible(seat), false);
	dom.window.close();
});

test('real React dock mounting recovers a missing panel and cleans up when the question is answered', async () => {
	const dom = new JSDOM('<div data-composer-seat><div id="dock"></div></div>', { pretendToBeVisual: true });
	const previousWindow = globalThis.window, previousDocument = globalThis.document, previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
	let clock = 0, tick, cleared = 0, reconnects = 0, registered;
	let events = { entries: [boundary('turn/start'), tool('call-208')] };
	let pending;
	const effects = [];
	const state = {};
	const session = { getSnapshot: () => ({ running: true }), projections: { faceOf: () => ({ getSnapshot: () => ({ active: [] }) }) } };
	const services = {
		connection: { state: { getSnapshot: () => 'connected' }, reconnect() { reconnects++; } },
		sessions: { binding: id => id === 'session-1' ? { session, eventSource: { getSnapshot: () => events } } : undefined },
		uiSession: { sessionStatus: { getSnapshot: () => new Map([['session-1', { pendingInteraction: pending }]]) } },
	};
	const module = load(dom.window, { Date: { now: () => clock },
		setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { cleared++; } });
	const ctx = { get: name => services[name], effect: fn => { effects.push(fn()); },
		slots: { inject: (_name, fn) => fn(), register: (spec, component) => { registered = { spec, component }; } } };
	const root = createRoot(dom.window.document.querySelector('#dock'));
	try {
		module.install(ctx, { state }); module.install(ctx, { state });
		assert.equal(registered.spec.id, 'vssaros-interaction-recovery');
		await React.act(async () => root.render(React.createElement(registered.component, { sessionId: 'session-1' })));
		clock = 4000;
		await React.act(async () => tick());
		assert.equal(reconnects, 1);
		assert.match(dom.window.document.body.textContent, /正在恢复交互通道/);
		const panel = dom.window.document.createElement('div');
		panel.setAttribute('data-question-key', 'native');
		panel.innerHTML = '<button>选项一</button><button>选项二</button>';
		panel.getBoundingClientRect = () => ({ width: 500, height: 250 });
		dom.window.document.querySelector('[data-composer-seat]').appendChild(panel);
		pending = { kind: 'question' };
		await React.act(async () => tick());
		assert.equal(dom.window.document.querySelector('[role="status"]'), null);
		assert.equal(state.interactionRecovery.phase, 'visible');
		events = { entries: [...events.entries, result('call-208')] };
		await React.act(async () => tick());
		assert.equal(state.interactionRecovery, null);
	} finally {
		await React.act(async () => root.unmount());
		for (const dispose of effects) { dispose?.(); }
		assert.equal(cleared, 1);
		assert.equal(state.interactionRecovery, null);
		globalThis.window = previousWindow; globalThis.document = previousDocument; globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
		dom.window.close();
	}
});

test('the recovery resource is independently loaded and shipped in the plugin', () => {
	const entry = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.ok(manifest.files.includes('lib/client.interactionRecovery.js'));
	assert.match(entry, /const ALWAYS_CHUNKS = \["\.\/client\.interactionRecovery\.js"/);
	assert.match(entry, /Promise\.resolve\(\)\.then\(\(\) => require\.async\("\.\/client\.interactionRecovery\.js"\)\)/);
	assert.match(entry, /filter\(p => p !== "\.\/client\.interactionRecovery\.js"\)/);
});
