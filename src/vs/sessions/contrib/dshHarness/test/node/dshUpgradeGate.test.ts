/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级闸门的分支覆盖：Host 与运行时用假实现，快照 / 恢复走真实文件系统（临时目录）。
 */

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { IRuntimeState, selectRuntimeVersion, withCurrent } from '../../common/dshCli.js';
import { IDshHostStartOptions, IDshHostStatus } from '../../common/dshHarness.js';
import { IDshHealthReport, IHostActivity } from '../../common/dshUpgrade.js';
import { DshUpgradeGate, IUpgradeHost, IUpgradeRuntime } from '../../electron-main/dshUpgradeGate.js';

class FakeRuntime implements IUpgradeRuntime {
	state: IRuntimeState;
	constructor(readonly installed: string[], current: string) {
		this.state = { current, history: [current] };
	}
	readState() { return this.state; }
	async restoreState(s: IRuntimeState) { this.state = s; }
	listInstalled() { return this.installed; }
	async setCurrent(v: string) { this.state = withCurrent(this.state, v); }
	get current() { return selectRuntimeVersion(this.state, this.installed); }
}

class FakeHost implements IUpgradeHost {
	status: IDshHostStatus = { state: 'stopped', bridge: 'none' };
	activity: IHostActivity | undefined = { live: 0, sessions: [] };
	/** 版本 → 启动后是否健康。 */
	healthyVersions = new Set<string>();
	/** 模拟新版本启动时迁移会话格式：写一个新文件、改一个旧文件。 */
	migrate = true;
	events: string[] = [];
	constructor(readonly runtime: FakeRuntime, readonly home: string) { }
	async start(_o: IDshHostStartOptions) {
		const v = this.runtime.current!;
		this.events.push(`start ${v}`);
		if (this.migrate && v !== this.runtime.state.history[0]) {
			writeFileSync(join(this.home, 'sessions', 'a.jsonl'), 'MIGRATED');
			mkdirSync(join(this.home, 'sessions', 'v2-index'), { recursive: true });
		}
		this.status = this.healthyVersions.has(v)
			? { state: 'running', bridge: 'connected', dshVersion: v }
			: { state: 'error', bridge: 'none', error: `boom ${v}`, errorCode: 'start-failed' };
		return this.status;
	}
	async stop() {
		this.events.push('stop');
		this.status = { state: 'stopped', bridge: 'none' };
	}
	async getActivity() { return this.activity; }
	async healthCheck(): Promise<IDshHealthReport> {
		return { ok: this.status.state === 'running', checks: [{ name: 'host running', ok: this.status.state === 'running' }] };
	}
	effectiveDshHome() { return this.home; }
}

suite('dshHarness / upgrade gate', () => {
	let root: string;
	let home: string;
	let snaps: string;
	let rt: FakeRuntime;
	let host: FakeHost;
	let gate: DshUpgradeGate;
	const log: string[] = [];

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'vssaros-gate-'));
		home = join(root, 'dsh-home');
		snaps = join(root, 'snapshots');
		mkdirSync(join(home, 'sessions'), { recursive: true });
		mkdirSync(join(home, 'profiles', 'vssaros'), { recursive: true });
		writeFileSync(join(home, 'sessions', 'a.jsonl'), 'ORIGINAL');
		writeFileSync(join(home, 'profiles', 'vssaros', 'package.json'), '{"v":1}');
		writeFileSync(join(home, '.credentials.yaml'), 'secret: x');
		rt = new FakeRuntime(['0.2.0', '0.2.1', '0.3.0'], '0.2.0');
		host = new FakeHost(rt, home);
		host.healthyVersions.add('0.2.0');
		gate = new DshUpgradeGate(host, rt, snaps, l => log.push(l));
	});

	teardown(() => rmSync(root, { recursive: true, force: true }));

	test('blocks while sessions run; schedules alone do not block', async () => {
		host.status = { state: 'running', bridge: 'connected' };
		host.activity = { live: 2, sessions: [{ sessionId: 'x', kinds: ['turn'] }, { sessionId: 'y', kinds: ['schedule'] }] };
		const r = await gate.upgrade({ version: '0.2.1' }, {});
		assert.strictEqual(r.outcome, 'blocked');
		assert.strictEqual(r.running, 1);
		assert.strictEqual(rt.current, '0.2.0', 'pointer untouched');
		assert.deepStrictEqual(host.events, [], 'Host untouched');
		assert.ok(!existsSync(snaps), 'no snapshot taken');
	});

	test('unknown activity (bridge down) blocks with running = -1', async () => {
		host.status = { state: 'running', bridge: 'fallback' };
		host.activity = undefined;
		const r = await gate.upgrade({ version: '0.2.1' }, {});
		assert.strictEqual(r.outcome, 'blocked');
		assert.strictEqual(r.running, -1);
	});

	test('healthy switch: snapshot taken (no credentials), pointer moved, Host kept running', async () => {
		host.status = { state: 'running', bridge: 'connected' };
		host.healthyVersions.add('0.2.1');
		const r = await gate.upgrade({ version: '0.2.1' }, {});
		assert.strictEqual(r.outcome, 'switched', r.error);
		assert.strictEqual(rt.current, '0.2.1');
		assert.deepStrictEqual(host.events, ['stop', 'start 0.2.1']);
		assert.strictEqual(host.status.state, 'running');
		const data = join(r.snapshot!, 'data');
		assert.strictEqual(readFileSync(join(data, 'sessions', 'a.jsonl'), 'utf8'), 'ORIGINAL', 'snapshot is pre-migration');
		assert.ok(existsSync(join(data, 'profiles', 'vssaros', 'package.json')));
		assert.ok(!existsSync(join(data, '.credentials.yaml')), 'credentials are never copied');
		const manifest = JSON.parse(readFileSync(join(r.snapshot!, 'manifest.json'), 'utf8'));
		assert.deepStrictEqual(manifest.dirs.map((d: { rel: string; present: boolean }) => `${d.rel.replace(/\\/g, '/')}:${d.present}`), ['profiles/vssaros:true', 'sessions:true', 'storages:false']);
	});

	test('failed health check: pointer, sessions and profile restored; new dirs removed; Host restarted on the old version', async () => {
		host.status = { state: 'running', bridge: 'connected' };
		const before = rt.state;
		const r = await gate.upgrade({ version: '0.3.0' }, {});
		assert.strictEqual(r.outcome, 'rolled-back', r.error);
		assert.match(r.error ?? '', /host running/);
		assert.deepStrictEqual(rt.state, before, 'pointer state restored exactly');
		assert.strictEqual(readFileSync(join(home, 'sessions', 'a.jsonl'), 'utf8'), 'ORIGINAL', 'migrated session restored');
		assert.ok(!existsSync(join(home, 'sessions', 'v2-index')), 'dir created by the new version is gone');
		assert.strictEqual(readFileSync(join(home, '.credentials.yaml'), 'utf8'), 'secret: x', 'credentials untouched');
		assert.deepStrictEqual(host.events, ['stop', 'start 0.3.0', 'stop', 'start 0.2.0']);
		assert.strictEqual(host.status.state, 'running');
	});

	test('Host that was stopped stays stopped after a healthy switch', async () => {
		host.healthyVersions.add('0.2.1');
		const r = await gate.upgrade({ version: '0.2.1' }, {});
		assert.strictEqual(r.outcome, 'switched');
		assert.deepStrictEqual(host.events, ['stop', 'start 0.2.1', 'stop']);
	});

	test('force bypasses the running-work check', async () => {
		host.status = { state: 'running', bridge: 'connected' };
		host.activity = { live: 1, sessions: [{ sessionId: 'x', kinds: ['turn'] }] };
		host.healthyVersions.add('0.2.1');
		assert.strictEqual((await gate.upgrade({ version: '0.2.1', force: true }, {})).outcome, 'switched');
	});

	test('guards: same version, not installed, runtimePath override, concurrent call', async () => {
		assert.strictEqual((await gate.upgrade({ version: '0.2.0' }, {})).outcome, 'unchanged');
		assert.strictEqual((await gate.upgrade({ version: '9.9.9' }, {})).outcome, 'failed');
		assert.match((await gate.upgrade({ version: '0.2.1' }, { runtimePath: 'C:\\x' })).error ?? '', /runtimePath/);
		host.healthyVersions.add('0.2.1');
		const [a, b] = await Promise.all([gate.upgrade({ version: '0.2.1' }, {}), gate.upgrade({ version: '0.2.1' }, {})]);
		assert.deepStrictEqual([a.outcome, b.outcome].sort(), ['failed', 'switched']);
	});

	test('keeps only the newest 3 snapshots', async () => {
		host.healthyVersions.add('0.2.1').add('0.3.0');
		host.migrate = false;
		mkdirSync(snaps, { recursive: true });
		for (const n of ['20200101T000000-a-to-b', '20200102T000000-a-to-b', '20200103T000000-a-to-b']) {
			mkdirSync(join(snaps, n));
		}
		await gate.upgrade({ version: '0.2.1' }, {});
		const left = readdirSync(snaps).sort();
		assert.strictEqual(left.length, 3);
		assert.ok(!left.includes('20200101T000000-a-to-b'));
	});
});
