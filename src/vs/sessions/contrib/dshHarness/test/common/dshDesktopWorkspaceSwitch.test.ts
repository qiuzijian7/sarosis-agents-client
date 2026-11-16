/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { dshChatNewSessionId } from '../../common/dshChatSession.js';

const file = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshFullWindowContribution.ts';
const source = readFileSync(join(process.cwd(), file), 'utf8');
const ts = createRequire(join(process.cwd(), 'package.json'))('typescript');
const start = source.indexOf('private readonly _pageCommandWires');
const end = source.indexOf('private async _newSession(', start);
assert.ok(start >= 0 && end > start, 'desktop switch implementation must exist');
const methods = source.slice(start, end);
const compiled = ts.transpileModule(`class TestHost { ${methods} }`, {
	compilerOptions: { target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;
const TestHost = new Function('dshChatNewSessionId', 'toDisposable', `${compiled}; return TestHost;`)(
	dshChatNewSessionId, (dispose: () => void) => ({ dispose }));

function fixture() {
	const listeners = new Set<(e: any) => void>();
	const calls: any[] = [];
	const failures: string[] = [];
	const disposables: { dispose(): void }[] = [];
	const viewId = 'dsh-desk-chat-w2-mwjb7dmu';
	const views = [{ viewId, surface: 'chat', sessionId: 'session-old' }];
	const sessions = [{ id: 'session-old', cwd: '/repo/main', agentPreset: 'code-agent' }];
	const host = new TestHost();
	host._register = (d: { dispose(): void }) => { disposables.push(d); return d; };
	host._log = { info: () => {}, warn: () => {}, trace: () => {} };
	host._notifications = { warn: (s: string) => failures.push(s) };
	host._dsh = {
		onDidPageEvent: (fn: (e: any) => void) => {
			listeners.add(fn);
			return { dispose: () => listeners.delete(fn) };
		},
		listViews: async () => views,
		listDshSessions: async () => sessions,
		startSession: async (args: any) => {
			calls.push(['start', args]);
			sessions.push({ id: args.sessionId, cwd: args.cwd, agentPreset: args.agentPreset });
			return { sessionId: args.sessionId, agentPreset: args.agentPreset };
		},
		rebindSession: async (id: string, sessionId: string) => {
			calls.push(['rebind', id, sessionId]);
			const view = views.find(v => v.viewId === id);
			if (view) { view.sessionId = sessionId; }
		}
	};
	const send = (path: string, id = viewId) => {
		for (const fn of listeners) { fn({ viewId: id, kind: 'command', command: { method: 'switchWorktree', path } }); }
	};
	const flush = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); } };
	return { host, viewId, views, calls, failures, disposables, listeners, send, flush };
}

suite('desktop workspace switch: command consumer and session rebind', () => {
	test('composed startup executes view creation and command wiring without undeclared variables', async () => {
		const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const declaration = parsed.statements.find((s: any) => ts.isClassDeclaration(s)
			&& s.name?.text === 'DshFullWindowContribution');
		const method = declaration?.members.find((m: any) => m.name?.getText(parsed) === '_openComposed');
		assert.ok(method?.body, 'composed startup method must exist');
		const wiring = method.body.statements.find((s: any) => s.getText(parsed).startsWith('this._wirePageCommands(chatViewId,'));
		assert.ok(wiring, 'composed startup must wire its own view');
		const prefix = source.slice(method.getStart(parsed), wiring.end);
		const startup = ts.transpileModule(`class StartupHost { ${prefix}\nreturn true; } }`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022 }
		}).outputText;
		const StartupHost = new Function(`${startup}; return StartupHost;`)();
		const host = new StartupHost();
		const calls: any[] = [];
		host._dsh = { createView: async (...args: any[]) => { calls.push(['create', ...args]); } };
		host._wirePageCommands = (...args: any[]) => { calls.push(['wire', ...args]); };
		const aux = { window: { document: { title: '' } }, container: { style: {} } };
		assert.strictEqual(await host._openComposed(aux, 2, 'session-current'), true);
		assert.deepStrictEqual(calls.map(c => c[0]), ['create', 'wire']);
		assert.strictEqual(calls[0][4], 'session-current');
		assert.strictEqual(calls[1][1], calls[0][1]);
		assert.strictEqual(calls[1][2], undefined);
	});

	test('composed main, split and restored views all wire their own commands', () => {
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
		assert.match(code, /createView\(chatViewId[^;]+;\s*this\._wirePageCommands\(chatViewId, undefined\)/);
		assert.match(code, /createView\(splitViewId[^;]+;\s*this\._wirePageCommands\(splitViewId, undefined\)/);
		assert.match(code, /createView\(id, windowId[^;]+;\s*this\._wirePageCommands\(id, undefined\)/);
	});

	test('desktop switch starts target cwd with current preset, then rebinds the same view', async () => {
		const f = fixture();
		f.host._wirePageCommands(f.viewId, undefined);
		f.send('/repo/pkg-b');
		await f.flush();
		assert.strictEqual(f.calls.length, 2);
		assert.deepStrictEqual(f.calls.map(c => c[0]), ['start', 'rebind']);
		assert.strictEqual(f.calls[0][1].cwd, '/repo/pkg-b');
		assert.strictEqual(f.calls[0][1].agentPreset, 'code-agent');
		assert.strictEqual(f.calls[1][1], f.viewId);
		assert.strictEqual(f.calls[1][2], f.calls[0][1].sessionId);
		assert.deepStrictEqual(f.failures, []);
	});

	test('repeated wiring is idempotent and unrelated view commands are ignored', async () => {
		const f = fixture();
		f.host._wirePageCommands(f.viewId, undefined);
		f.host._wirePageCommands(f.viewId, undefined);
		assert.strictEqual(f.listeners.size, 1);
		f.send('/wrong', 'dsh-chat-w1-default');
		await f.flush();
		assert.deepStrictEqual(f.calls, []);
		for (const d of f.disposables) { d.dispose(); }
		assert.strictEqual(f.listeners.size, 0);
	});

	test('busy switch queues the next target without parallel session creation', async () => {
		const f = fixture();
		let release!: () => void;
		const wait = new Promise<void>(resolve => { release = resolve; });
		const original = f.host._dsh.startSession;
		let starts = 0;
		f.host._dsh.startSession = async (args: any) => {
			starts++;
			if (starts === 1) { await wait; }
			return original(args);
		};
		f.host._wirePageCommands(f.viewId, undefined);
		f.send('/repo/a');
		f.send('/repo/b');
		await f.flush();
		assert.strictEqual(starts, 1);
		release();
		await f.flush();
		assert.deepStrictEqual(f.calls.filter(c => c[0] === 'start').map(c => c[1].cwd), ['/repo/a', '/repo/b']);
		assert.deepStrictEqual(f.calls.map(c => c[0]), ['start', 'rebind', 'start', 'rebind']);
	});

	test('start failure notifies, does not rebind, and the next request remains usable', async () => {
		const f = fixture();
		const original = f.host._dsh.startSession;
		f.host._dsh.startSession = async () => { throw new Error('agent-preset/invalid'); };
		f.host._wirePageCommands(f.viewId, undefined);
		f.send('/repo/a');
		await f.flush();
		assert.deepStrictEqual(f.calls, []);
		assert.match(f.failures[0], /agent-preset\/invalid/);
		f.host._dsh.startSession = original;
		f.send('/repo/b');
		await f.flush();
		assert.strictEqual(f.calls[0][1].agentPreset, 'code-agent');
		assert.strictEqual(f.calls[1][1], f.viewId);
	});

	test('rebind failure notifies rather than claiming completion', async () => {
		const f = fixture();
		f.host._dsh.rebindSession = async () => { throw new Error('session is bound in another window'); };
		f.host._wirePageCommands(f.viewId, undefined);
		f.send('/repo/a');
		await f.flush();
		assert.strictEqual(f.calls.length, 1);
		assert.strictEqual(f.views[0].sessionId, 'session-old');
		assert.match(f.failures[0], /another window/);
	});

	test('missing current session metadata never silently changes the preset', async () => {
		const f = fixture();
		f.host._dsh.listDshSessions = async () => [];
		f.host._wirePageCommands(f.viewId, undefined);
		f.send('/repo/a');
		await f.flush();
		assert.deepStrictEqual(f.calls, []);
		assert.match(f.failures[0], /preset/);
	});

	test('unknown or closed view fails visibly without creating a session', async () => {
		const f = fixture();
		f.host._wirePageCommands(f.viewId, undefined);
		f.views.length = 0;
		f.send('/repo/a');
		await f.flush();
		assert.deepStrictEqual(f.calls, []);
		assert.match(f.failures[0], /视图已关闭/);
	});
});
