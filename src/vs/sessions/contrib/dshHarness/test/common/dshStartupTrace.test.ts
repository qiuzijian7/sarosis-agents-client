/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DshStartupTrace } from '../../common/dshStartupTrace.js';

suite('DshStartupTrace', () => {
	test('records phase duration using the injected monotonic clock and preserves results', async () => {
		let now = 100;
		const lines: string[] = [];
		const trace = new DshStartupTrace('startup-1', line => lines.push(line), () => now);
		const result = await trace.measure('repair', () => { now += 27; return 42; });
		assert.strictEqual(result, 42);
		trace.finish('running');
		assert.strictEqual(lines.length, 4);
		assert.ok(lines.every(line => line.includes('"startupId":"startup-1"')));
		assert.ok(lines[2].includes('"durationMs":27'));
		assert.ok(lines[2].includes('"outcome":"ok"'));
		assert.ok(lines[3].includes('"elapsedMs":27'));
	});

	test('failed phase logs timing without serializing the error or changing its identity', async () => {
		const lines: string[] = [];
		const trace = new DshStartupTrace('startup-2', line => lines.push(line));
		const error = new Error('token=private');
		await assert.rejects(trace.measure('profile-sync', () => { throw error; }), caught => caught === error);
		trace.finish('error');
		assert.ok(lines.some(line => line.includes('"outcome":"error"')));
		assert.ok(lines.every(line => !line.includes('private')));
	});

	test('diagnostic failure does not fail startup and finish emits once', async () => {
		let calls = 0;
		const trace = new DshStartupTrace('startup-3', () => { calls++; throw new Error('logger closed'); });
		assert.strictEqual(await trace.measure('resolve', async () => true), true);
		trace.finish('running');
		trace.finish('error');
		trace.mark('late');
		assert.strictEqual(calls, 4);
	});

	test('supervisor traces preparation and reuse without changing readiness policy', () => {
		const source = readFileSync(join(process.cwd(), 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts'), 'utf8');
		for (const phase of ['resolve-node', 'resolve-dsh', 'profile-sync', 'bundled-source-sync', 'plugin-fingerprint.begin', 'lease-probe', 'deps-repair-before-spawn', 'host-await-ready']) {
			assert.ok(source.includes(`'${phase}'`), `missing phase ${phase}`);
		}
		assert.ok(source.includes("trace.finish(generation === this._generation ? this._status.state : 'superseded')"));
	});
});
