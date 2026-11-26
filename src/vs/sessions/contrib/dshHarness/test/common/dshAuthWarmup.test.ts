/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DshAuthWarmup, IDshAuthCookie, sameAuthConnection } from '../../common/dshAuthWarmup.js';

const connection = { origin: 'http://127.0.0.1:3080', authUrl: 'http://127.0.0.1:3080/?token=first' };
const cookie: IDshAuthCookie = { name: 'dsh-auth-test', value: 'fresh', domain: '127.0.0.1', path: '/' };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

suite('DshAuthWarmup', () => {
	const instances: DshAuthWarmup<object>[] = [];
	teardown(() => { for (const instance of instances.splice(0)) { instance.dispose(); } });

	function fixture(timeoutMs = 15_000) {
		let now = 1_000;
		let calls = 0;
		let ok = true;
		let fail = false;
		let cookies: readonly IDshAuthCookie[] = [cookie];
		const events: string[] = [];
		const warmup = new DshAuthWarmup<object>({
			exchange: async () => { calls++; if (fail) { throw new Error('offline'); } return ok; },
			cookies: async () => cookies,
			now: () => now,
			timeoutMs,
			onEvent: event => events.push(event),
		});
		instances.push(warmup);
		warmup.setConnection(connection);
		return {
			warmup, events, session: {}, calls: () => calls,
			advance: (ms: number) => { now += ms; },
			setCookies: (value: readonly IDshAuthCookie[]) => { cookies = value; },
			setOk: (value: boolean) => { ok = value; },
			setFail: () => { fail = true; },
		};
	}

	test('completed prefetch is reused after validating the exact cookie', async () => {
		const f = fixture();
		assert.strictEqual(await f.warmup.ensure(f.session, connection), true);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), true);
		assert.strictEqual(f.calls(), 1);
		assert.deepStrictEqual(f.events, ['exchange', 'cache-hit']);
	});

	test('proofs are isolated by Session object identity', async () => {
		const f = fixture();
		await f.warmup.ensure(f.session, connection);
		await f.warmup.ensure({}, connection);
		assert.strictEqual(f.calls(), 2);
	});

	test('expired proof requires a fresh exchange', async () => {
		const f = fixture();
		await f.warmup.ensure(f.session, connection);
		f.advance(30_000);
		await f.warmup.ensure(f.session, connection);
		assert.strictEqual(f.calls(), 2);
	});

	test('an unchanged cookie from another authority cannot hide replacement of the current cookie', async () => {
		const f = fixture();
		const older = { ...cookie, name: 'dsh-auth-other', value: 'older' };
		f.setCookies([cookie, older]);
		await f.warmup.ensure(f.session, connection);
		f.setCookies([{ ...cookie, value: 'overwritten' }, older]);
		f.setOk(false);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
		assert.strictEqual(f.calls(), 2);
	});

	test('deleted or overwritten cookie invalidates the proof', async () => {
		const f = fixture();
		await f.warmup.ensure(f.session, connection);
		f.setCookies([{ ...cookie, value: 'overwritten' }]);
		await f.warmup.ensure(f.session, connection);
		assert.strictEqual(f.calls(), 2);
		f.setCookies([]);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
		assert.strictEqual(f.calls(), 3);
	});

	test('expired cookies and cookies within expiry safety margin do not prove authentication', async () => {
		const f = fixture();
		f.setCookies([{ ...cookie, expirationDate: 2 }]);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
		f.setCookies([{ ...cookie, expirationDate: 10 }]);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), true);
		f.advance(8_000);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
		assert.strictEqual(f.calls(), 3);
	});

	test('HTTP failure never succeeds using an old cookie', async () => {
		const f = fixture();
		f.setOk(false);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
		assert.strictEqual(f.calls(), 2);
	});

	test('rejected exchange never succeeds using an old cookie', async () => {
		const f = fixture();
		f.setFail();
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
		assert.deepStrictEqual(f.events, ['failed']);
	});

	test('force bypasses completed proof', async () => {
		const f = fixture();
		await f.warmup.ensure(f.session, connection);
		await f.warmup.ensure(f.session, connection, true);
		assert.strictEqual(f.calls(), 2);
	});

	test('force joins an already in-flight fresh exchange', async () => {
		const gate = deferred<boolean>();
		let calls = 0;
		const warmup = new DshAuthWarmup<object>({ exchange: () => { calls++; return gate.promise; }, cookies: async () => [cookie] });
		instances.push(warmup);
		warmup.setConnection(connection);
		const session = {};
		const first = warmup.ensure(session, connection);
		await Promise.resolve();
		const forced = warmup.ensure(session, connection, true);
		assert.strictEqual(first, forced);
		gate.resolve(true);
		assert.strictEqual(await forced, true);
		assert.strictEqual(calls, 1);
	});

	test('force arriving during cached cookie validation upgrades to a fresh exchange', async () => {
		const validation = deferred<readonly IDshAuthCookie[]>();
		let calls = 0;
		let reads = 0;
		const warmup = new DshAuthWarmup<object>({
			exchange: async () => { calls++; return true; },
			cookies: () => ++reads === 2 ? validation.promise : Promise.resolve([cookie]),
		});
		instances.push(warmup);
		warmup.setConnection(connection);
		const session = {};
		await warmup.ensure(session, connection);
		const cached = warmup.ensure(session, connection);
		await Promise.resolve();
		const forced = warmup.ensure(session, connection, true);
		assert.strictEqual(cached, forced);
		validation.resolve([cookie]);
		assert.strictEqual(await forced, true);
		assert.strictEqual(calls, 2);
	});

	test('same authority with a new token invalidates proof and rejects old connection', async () => {
		const f = fixture();
		await f.warmup.ensure(f.session, connection);
		const changed = { ...connection, authUrl: `${connection.origin}/?token=second` };
		assert.strictEqual(sameAuthConnection(connection, changed), false);
		const epoch = f.warmup.epoch;
		f.warmup.setConnection(changed);
		assert.strictEqual(f.warmup.isCurrent(connection, epoch), false);
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
		assert.strictEqual(await f.warmup.ensure(f.session, changed), true);
		assert.strictEqual(f.calls(), 2);
	});

	test('duplicate connection notifications preserve proof; disconnect invalidates it', async () => {
		const f = fixture();
		await f.warmup.ensure(f.session, connection);
		const epoch = f.warmup.epoch;
		f.warmup.setConnection({ ...connection });
		assert.strictEqual(f.warmup.epoch, epoch);
		await f.warmup.ensure(f.session, connection);
		assert.strictEqual(f.calls(), 1);
		f.warmup.setConnection(undefined);
		f.warmup.setConnection(connection);
		await f.warmup.ensure(f.session, connection);
		assert.strictEqual(f.calls(), 2);
	});

	test('replacement waits for old exchange settlement and does not retain its success', async () => {
		const old = deferred<boolean>();
		const entered = deferred<boolean>();
		const calls: string[] = [];
		let oldSignal: AbortSignal | undefined;
		const warmup = new DshAuthWarmup<object>({
			exchange: async (_session, conn, signal) => {
				calls.push(conn.authUrl);
				if (conn.authUrl === connection.authUrl) { oldSignal = signal; entered.resolve(true); return old.promise; }
				return true;
			},
			cookies: async () => [cookie],
		});
		instances.push(warmup);
		warmup.setConnection(connection);
		const session = {};
		const first = warmup.ensure(session, connection);
		await entered.promise;
		const secondConnection = { ...connection, authUrl: `${connection.origin}/?token=new` };
		warmup.setConnection(secondConnection);
		const second = warmup.ensure(session, secondConnection);
		assert.strictEqual(oldSignal?.aborted, true);
		await Promise.resolve();
		assert.strictEqual(calls.length, 1);
		old.resolve(true);
		assert.strictEqual(await first, false);
		assert.strictEqual(await second, true);
		await warmup.ensure(session, secondConnection);
		assert.strictEqual(calls.length, 2);
	});

	test('timeout aborts exchange and does not trust a residual cookie', async () => {
		const events: string[] = [];
		const warmup = new DshAuthWarmup<object>({
			exchange: (_session, _conn, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
			cookies: async () => [cookie], timeoutMs: 5, onEvent: event => events.push(event),
		});
		instances.push(warmup);
		warmup.setConnection(connection);
		assert.strictEqual(await warmup.ensure({}, connection), false);
		assert.deepStrictEqual(events, ['timeout']);
	});

	test('dispose cancels exchanges and rejects subsequent reuse', async () => {
		const f = fixture();
		await f.warmup.ensure(f.session, connection);
		f.warmup.dispose();
		assert.strictEqual(await f.warmup.ensure(f.session, connection), false);
	});

	test('view integration preserves follow, validates generation before navigation and handles token replacement', () => {
		const source = readFileSync(join(process.cwd(), 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts'), 'utf8');
		assert.ok(source.includes("redirect: 'follow', signal"));
		assert.ok(source.includes('response.ok'));
		assert.ok(source.includes('!sameAuthConnection(connection, this._connection)'));
		assert.ok(source.includes('this._register(new DshAuthWarmup<Session>'));
		const load = source.slice(source.indexOf('private async _load(slot:'));
		assert.ok(load.indexOf('this._authWarmup.isCurrent(conn, epoch)') < load.indexOf('webContents.loadURL(url)'));
		assert.ok(load.includes('this._views.get(slot.id) !== slot'));
		assert.ok(!source.includes('byKey.delete(key)'));
	});
});
