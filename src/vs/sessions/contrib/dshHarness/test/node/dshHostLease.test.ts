/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { tmpdir } from 'os';
import { AddressInfo } from 'net';
import { join } from '../../../../../base/common/path.js';
import { hostLeaseBlocker, IDshHostLease, parseHostLease } from '../../common/dshHostLease.js';
import { DshHostLeaseStore, pidAlive } from '../../electron-main/dshHostLeaseStore.js';

function lease(overrides: Partial<IDshHostLease> = {}): IDshHostLease {
	return {
		format: 1,
		pid: process.pid,
		origin: 'http://127.0.0.1:41000',
		authUrl: 'http://127.0.0.1:41000/?token=abc',
		dshVersion: '0.2.0-rc.2',
		profile: 'vssaros',
		pipe: '\\\\.\\pipe\\dsh-test',
		bridgeToken: 'tok',
		instanceId: 'vssaros-1',
		startedAt: Date.now(),
		...overrides,
	};
}

suite('dshHostLease', () => {

	test('parse accepts a full lease and rejects malformed ones', () => {
		// 只采样**一次**：`lease()` 里的 `startedAt: Date.now()` 每调一次就取一次时钟，
		// 对同一份数据比两次会在跨毫秒时 flake（全量并发下偶发过：…841 vs …840）。
		const sample = lease();
		assert.deepStrictEqual(parseHostLease(JSON.stringify(sample)), sample);
		for (const bad of [
			'not json',
			'{}',
			JSON.stringify({ ...lease(), format: 2 }),
			JSON.stringify({ ...lease(), pid: -1 }),
			JSON.stringify({ ...lease(), origin: 'http://evil.example.com/' }),
			JSON.stringify({ ...lease(), authUrl: 'http://127.0.0.1:9999/?token=x' }),	// 与 origin 不一致
			JSON.stringify({ ...lease(), dshVersion: '' }),
			JSON.stringify({ ...lease(), pipe: 42 }),
		]) {
			assert.strictEqual(parseHostLease(bad), undefined, bad.slice(0, 60));
		}
	});

	test('blocker: version or profile mismatch prevents reuse', () => {
		const want = { dshVersion: '0.2.0-rc.2', profile: 'vssaros' };
		assert.strictEqual(hostLeaseBlocker(lease(), want), undefined);
		assert.match(hostLeaseBlocker(lease({ dshVersion: '0.1.7-rc.2' }), want)!, /版本不同/);
		assert.match(hostLeaseBlocker(lease({ profile: 'other' }), want)!, /profile 不同/);
	});

	suite('store', () => {
		let dir: string;
		let store: DshHostLeaseStore;
		setup(() => {
			dir = mkdtempSync(join(tmpdir(), 'dsh-lease-test-'));
			store = new DshHostLeaseStore(dir, () => { });
		});
		teardown(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		test('write → read round-trip; removeIfOurs only removes the owner\'s lease', async () => {
			const mine = lease({ pid: process.pid });
			await store.write(mine);
			assert.deepStrictEqual(store.read(), mine);

			await store.removeIfOurs(999999);	// 别人的 pid：不删
			assert.ok(store.read(), 'lease of another pid must survive');
			await store.removeIfOurs(process.pid);
			assert.strictEqual(store.read(), undefined);
		});

		test('invalid host.json is treated as no lease', async () => {
			writeFileSync(join(dir, 'host.json'), '{"broken');
			assert.strictEqual(store.read(), undefined);
		});

		test('probe: dead pid fails fast; live pid + http server passes', async () => {
			assert.match((await store.probe(lease({ pid: 999999 })))!, /已不存在/);

			const server: Server = createServer((_req, res) => {
				res.writeHead(200).end('ok');
			});
			await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
			try {
				const port = (server.address() as AddressInfo).port;
				const live = lease({ origin: `http://127.0.0.1:${port}`, authUrl: `http://127.0.0.1:${port}/?token=x` });
				assert.strictEqual(await store.probe(live), undefined);
			} finally {
				server.close();
			}
			// 活着的 pid 但端口无人监听 → 失败
			assert.match((await store.probe(lease({ origin: 'http://127.0.0.1:1', authUrl: 'http://127.0.0.1:1/?token=x' })))!, /HTTP 探测失败/);
		});

		test('removeIfStale removes only leases whose pid is dead', async () => {
			await store.write(lease({ pid: 999999 }));
			await store.removeIfStale();
			assert.strictEqual(store.read(), undefined, 'dead pid lease removed');

			await store.write(lease({ pid: process.pid }));
			await store.removeIfStale();
			assert.ok(store.read(), 'live pid lease kept');
		});

		test('start lock: second acquirer waits and sees the first one\'s lease', async () => {
			const first = await store.acquireStartLock(2_000);
			assert.strictEqual(first, undefined, 'first acquirer gets the lock');

			const waiter = store.acquireStartLock(5_000);
			await new Promise(r => setTimeout(r, 700));
			await store.write(lease({ pid: process.pid }));	// 先者启动完成
			await store.releaseStartLock();
			const seen = await waiter;
			assert.ok(seen && seen.pid === process.pid, 'waiter received the fresh lease instead of starting');
		});

		test('start lock: a lock held by a dead pid is broken', async () => {
			writeFileSync(join(dir, 'host.json.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
			const got = await store.acquireStartLock(2_000);
			assert.strictEqual(got, undefined, 'stale lock broken and acquired');
			assert.strictEqual(JSON.parse(readFileSync(join(dir, 'host.json.lock'), 'utf8')).pid, process.pid);
			await store.releaseStartLock();
		});

		test('pidAlive', () => {
			assert.ok(pidAlive(process.pid));
			assert.ok(!pidAlive(999999));
		});
	});
});
