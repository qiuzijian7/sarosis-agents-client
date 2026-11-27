/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../lib/client.submissionControls.js', import.meta.url), 'utf8');
function load(window = {}, timers = { setTimeout, clearTimeout }) {
	let definition;
	window.__ModuleLoader__ = { load: value => { definition = value; } };
	new Function('window', 'setTimeout', 'clearTimeout', source)(window, timers.setTimeout, timers.clearTimeout);
	return definition.factory(name => { assert.equal(name, 'react'); return React; });
}
function fixture(timers) {
	const controls = load({}, timers).__test.createSubmissionControls();
	const captures = [];
	const session = {
		sessionId: 'session-1',
		beginSubmission(input) {
			const capture = { input, abandoned: 0 };
			captures.push(capture);
			return { requestId: `request-${captures.length}`, abandon() { capture.abandoned++; } };
		},
	};
	const original = function (routed, text, attachments, mode, signal, accept) {
		const handle = routed.beginSubmission({ onAccept: accept });
		captures.at(-1).signal = signal;
		captures.at(-1).routed = routed;
		captures.at(-1).args = { text, attachments, mode, requestId: handle.requestId };
		return new Promise(() => {});
	};
	const send = (accept = () => {}) => controls.send(original, {}, session, 'draft', ['image-1'], 'queue', undefined, accept);
	return { controls, captures, session, original, send };
}

test('cancel before Host acceptance retains the draft and attachments through the official machine failure path', async () => {
	const { bundled } = JSON.parse(readFileSync(new URL('../../dsh-compat.json', import.meta.url), 'utf8'));
	const machinePath = new URL(`../../../dsh-runtime/${bundled}/node_modules/@deepseek-ai/dsh-client-ui-conversation/src/client/input/machine.ts`, import.meta.url);
	const js = transformSync(readFileSync(machinePath, 'utf8'), { loader: 'ts', format: 'esm' }).code;
	const { SubmitMachine } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
	const machine = new SubmitMachine();
	const f = fixture();
	const draft = { text: 'draft', attachments: ['image-1'], references: ['@file'], quotes: ['selected text'] };
	const [effect] = machine.dispatch({ type: 'enter', draft: draft.text, attachmentIds: draft.attachments, occurrences: [], quotes: [], mode: 'queue' });
	assert.equal(machine.state.phase, 'sending');
	const sending = f.send();
	assert.equal(f.controls.cancel('session-1'), 1);
	await assert.rejects(sending, /草稿已保留/);
	const effects = machine.dispatch({ type: 'sink-settled', attempt: effect.attempt, ok: false });
	assert.deepEqual({ phase: machine.state.phase, effects, draft, abandoned: f.captures[0].abandoned }, {
		phase: 'plain', effects: [], draft: { text: 'draft', attachments: ['image-1'], references: ['@file'], quotes: ['selected text'] }, abandoned: 1,
	});
	assert.equal(f.captures[0].signal.aborted, true);
	f.controls.dispose();
});

test('a late acceptance after cancellation cannot clear an edited draft or a replacement submission', async () => {
	const f = fixture();
	let accepted = 0;
	const first = f.send(() => accepted++);
	f.controls.cancel('session-1');
	const second = f.send(() => accepted++);
	await assert.rejects(first, /撤销/);
	f.captures[0].input.onAccept();
	assert.equal(accepted, 0);
	assert.equal(f.controls.getSnapshot('session-1').sending, true);
	f.captures[1].input.onAccept();
	assert.deepEqual(await second, { kind: 'success' });
	assert.equal(accepted, 1);
	f.controls.dispose();
});

test('an Inbox acceptance proof wins a missing RPC receipt and is never restored as an unsent draft', async () => {
	const f = fixture();
	let accepted = 0;
	const sending = f.send(() => accepted++);
	f.captures[0].input.onAccept();
	assert.equal(f.controls.cancel('session-1'), 0);
	assert.deepEqual(await sending, { kind: 'success' });
	assert.deepEqual({ accepted, abandoned: f.captures[0].abandoned, sending: f.controls.getSnapshot('session-1').sending },
		{ accepted: 1, abandoned: 0, sending: false });
	f.controls.dispose();
});

test('a hung pre-HTTP attachment preparation expires and abandons the echo without an input-state mutation', async () => {
	let timeout, cleared = 0;
	const f = fixture({ setTimeout(fn, ms) { assert.equal(ms, 40000); timeout = fn; return 1; }, clearTimeout() { cleared++; } });
	const sending = f.send();
	timeout();
	await assert.rejects(sending, /已恢复编辑/);
	assert.deepEqual({ abandoned: f.captures[0].abandoned, cleared, sending: f.controls.getSnapshot('session-1').sending },
		{ abandoned: 1, cleared: 1, sending: false });
	f.controls.dispose();
});

test('reference serialization can be cancelled before it ever reaches the prompt sink', async () => {
	const f = fixture();
	let signal;
	const serialized = f.controls.serialize((_source, _ref, value) => { signal = value; return new Promise(() => {}); }, {}, 'session-1', 'file', 'readme', undefined);
	f.controls.cancel('session-1');
	await assert.rejects(serialized, /草稿已保留/);
	assert.equal(signal.aborted, true);
	assert.equal(f.captures.length, 0);
	f.controls.dispose();
});

test('stopping the active turn cancels only this Session submission and preserves other Sessions', async () => {
	const f = fixture();
	const first = f.send();
	const other = f.controls.send(f.original, {}, { ...f.session, sessionId: 'session-2' }, 'other', [], 'steer');
	f.controls.stopState('stopping', { endpoint: 'session/cancel', sessionId: 'session-1' });
	await assert.rejects(first, /撤销/);
	assert.equal(f.controls.getSnapshot('session-1').stopping, true);
	assert.equal(f.controls.getSnapshot('session-2').sending, true);
	f.controls.stopState('failed', { endpoint: 'session/cancel', sessionId: 'session-1', error: 'timed out' });
	assert.match(f.controls.getSnapshot('session-1').stopError, /停止失败.*timed out/);
	f.controls.stopState('stopping', { endpoint: 'session/cancel', sessionId: 'session-1' });
	assert.equal(f.controls.getSnapshot('session-1').stopError, null);
	f.controls.stopState('accepted', { endpoint: 'session/cancel', sessionId: 'session-1' });
	assert.equal(f.controls.getSnapshot('session-1').stopping, false);
	f.controls.dispose();
	await assert.rejects(other, /撤销/);
});

test('Session private-field getters and methods keep their original receiver through the routed facade', async () => {
	class Session {
		#id = 'session-1';
		get sessionId() { return this.#id; }
		prompt() { return this.#id; }
		beginSubmission() { return { requestId: 'rpc', abandon() {} }; }
	}
	const controls = fixture().controls;
	const value = await controls.send(routed => ({ kind: 'error', text: routed.prompt() }), {}, new Session(), 'draft', [], 'queue');
	assert.deepEqual(value, { kind: 'error', text: 'session-1' });
	controls.dispose();
});

test('an already cancelled parent signal never starts a submission and disposal settles pending work', async () => {
	const f = fixture();
	const parent = new AbortController(); parent.abort(new Error('released'));
	await assert.rejects(f.controls.send(f.original, {}, f.session, 'draft', [], 'queue', parent.signal), /released/);
	assert.equal(f.captures.length, 0);
	const pending = f.send();
	f.controls.dispose();
	await assert.rejects(pending, /撤销/);
	await assert.rejects(f.send(), /上下文已释放/);
});

test('real React controls cancel a blocked send, permit editing, show stop failure and clean up wrappers', async () => {
	const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
	const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
	const f = fixture();
	let registered, cleanup, running = true;
	const services = {
		conversation: { sendSession: f.original }, sessions: { scopeOf: () => 'session-1', binding: () => ({ session: { cancel: async () => ({ ok: false, error: { message: 'network unavailable' } }) } }) },
		inputTriggers: { sessionOf: () => ({ serializeReference: () => new Promise(() => {}) }) },
	};
	const originalSend = services.conversation.sendSession, originalSessionOf = services.inputTriggers.sessionOf;
	const ctx = {
		get: name => services[name],
		reflect: { provide: (name, value) => { services[name] = value; return () => { delete services[name]; }; } },
		effect: fn => { cleanup = fn(); },
		inject: (_names, fn) => { let dispose; fn({ get: ctx.get, effect: start => { dispose = start(); } }); return { dispose: () => dispose() }; },
		slots: { inject: (_name, fn) => { fn(); return () => {}; }, register: (spec, component) => { registered = { spec, component }; } },
	};
	const root = createRoot(dom.window.document.querySelector('#root'));
	try {
		load(dom.window).install(ctx, {});
		assert.equal(registered.spec.id, 'vssaros-submission-controls');
		await React.act(async () => root.render(React.createElement(registered.component, { sessionId: 'session-1', useSession: selector => selector({ running }) })));
		let sending;
		await React.act(async () => { sending = services.conversation.sendSession(f.session, 'draft', ['image-1'], 'queue').catch(error => error); });
		assert.match(dom.window.document.body.textContent, /草稿暂时只读/);
		const button = text => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === text);
		await React.act(async () => button('撤销发送，继续编辑').click());
		assert.match((await sending).message, /草稿已保留/);
		assert.equal(dom.window.document.querySelector('[data-vssaros-submission-controls]'), null);
		await React.act(async () => services.vssarosSubmissionControls.stopState('failed', { endpoint: 'session/cancel', sessionId: 'session-1', error: 'timed out' }));
		assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /停止失败/);
		await React.act(async () => button('停止当前轮').click());
		assert.match(dom.window.document.querySelector('[role="alert"]').textContent, /network unavailable/);
	} finally {
		await React.act(async () => root.unmount());
		await cleanup();
		assert.equal(services.conversation.sendSession, originalSend);
		assert.equal(services.inputTriggers.sessionOf, originalSessionOf);
		assert.equal(services.vssarosSubmissionControls, undefined);
		f.controls.dispose();
		globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
		dom.window.close();
	}
});

test('actual Cordis Service tracing preserves the calling context and restores methods at plugin teardown', async () => {
	const { bundled } = JSON.parse(readFileSync(new URL('../../dsh-compat.json', import.meta.url), 'utf8'));
	const { Context, Service } = await import(new URL(`../../../dsh-runtime/${bundled}/node_modules/@deepseek-ai/cordis/lib/index.js`, import.meta.url));
	const ctx = new Context();
	const f = fixture();
	const contexts = [];
	class Conversation extends Service {
		constructor() { super(ctx, 'conversation'); }
		sendSession(...args) { contexts.push(this.ctx); return f.original(...args); }
	}
	const conversation = new Conversation();
	const original = conversation.sendSession;
	ctx.provide('slots', { inject: (_slot, register) => { register(); return () => {}; }, register: () => () => {} });
	ctx.provide('sessions', { scopeOf: () => 'session-1' });
	ctx.provide('inputTriggers', { sessionOf: () => ({ serializeReference: async () => 'reference' }) });
	const module = load();
	const fiber = await ctx.plugin({ name: 'submission-control-regression', apply: scope => module.install(scope, {}) });
	try {
		for (let i = 0; i < 3; i++) { await new Promise(resolve => setImmediate(resolve)); }
		const calling = ctx.extend({ callerMarker: 'chat-1' });
		const sending = calling.get('conversation').sendSession(f.session, 'draft', [], 'queue').catch(error => error);
		assert.equal(contexts[0].callerMarker, 'chat-1');
		ctx.get('vssarosSubmissionControls').cancel('session-1');
		assert.match((await sending).message, /草稿已保留/);
	} finally {
		await fiber.dispose();
		assert.equal(conversation.sendSession, original);
		assert.equal(ctx.get('vssarosSubmissionControls'), undefined);
		await ctx.fiber.dispose();
		f.controls.dispose();
	}
});

test('the new recovery is independently loaded and shipped with all chat surfaces', () => {
	const entry = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.ok(manifest.files.includes('lib/client.submissionControls.js'));
	assert.match(entry, /const ALWAYS_CHUNKS = \[[^\]]*"\.\/client\.submissionControls\.js"/);
	assert.match(entry, /Promise\.resolve\(\)\.then\(\(\) => require\.async\("\.\/client\.submissionControls\.js"\)\)/);
});
