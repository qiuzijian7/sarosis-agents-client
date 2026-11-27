/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createLazyPresetFill } from '../lib/lazyPresetFill.js';

function fixture(run = async () => undefined) {
	const timers = new Map();
	let next = 0;
	const fill = createLazyPresetFill(run, {
		setTimer(callback, delay) { assert.equal(delay, 15_000); const id = ++next; timers.set(id, callback); return id; },
		clearTimer(id) { timers.delete(id); },
	});
	return { fill, timers, fire() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); } };
}

test('cold boot does not schedule fallback until appReady arms it', async () => {
	let calls = 0;
	const f = fixture(async () => { calls++; });
	assert.equal(f.timers.size, 0);
	assert.equal(calls, 0);
	f.fill.arm(); f.fill.arm();
	assert.equal(f.timers.size, 1);
	f.fire();
	await f.fill.fillNow();
	assert.equal(calls, 1);
	await f.fill.dispose();
});

test('first use bypasses readiness fallback and merges simultaneous requests', async () => {
	let resolve;
	let calls = 0;
	const gate = new Promise(r => { resolve = r; });
	const f = fixture(async () => { calls++; await gate; });
	const a = f.fill.fillNow();
	const b = f.fill.fillNow();
	assert.equal(a, b);
	f.fill.arm();
	assert.equal(f.timers.size, 0);
	await Promise.resolve();
	assert.equal(calls, 1);
	resolve();
	await a;
	await f.fill.dispose();
});

test('disposing before first use cancels fallback without scanning', async () => {
	const f = fixture(async () => { assert.fail('must not initialize during disposal'); });
	f.fill.arm();
	await f.fill.dispose();
	f.fill.arm();
	await f.fill.fillNow();
	assert.equal(f.timers.size, 0);
});

test('queued first use is cancelled if disposed before its microtask runs', async () => {
	const f = fixture(async () => { assert.fail('disposed work must not start'); });
	const work = f.fill.fillNow();
	await f.fill.dispose();
	await work;
});

test('disposal waits for work already in flight and does not start a second run', async () => {
	let resolve;
	let done = false;
	const gate = new Promise(r => { resolve = r; });
	const f = fixture(async () => { await gate; });
	const work = f.fill.fillNow();
	await Promise.resolve();
	const closing = f.fill.dispose().then(() => { done = true; });
	await Promise.resolve();
	assert.equal(done, false);
	resolve(); await work; await closing;
	assert.equal(done, true);
});

test('first use receives initialization errors; fallback rejection is handled', async () => {
	const error = new Error('preset recovery failed');
	const f = fixture(async () => { throw error; });
	f.fill.arm(); f.fire();
	await assert.rejects(f.fill.fillNow(), caught => caught === error);
	await f.fill.dispose();
});

test('a failed first use can be retried instead of caching a permanent rejection', async () => {
	let attempts = 0;
	const f = fixture(async () => { if (++attempts === 1) { throw new Error('temporary failure'); } });
	await assert.rejects(f.fill.fillNow(), /temporary failure/);
	await f.fill.fillNow();
	assert.equal(attempts, 2);
	await f.fill.dispose();
});

test('fallback and explicit first use have distinct reason tags without changing coalescing', async () => {
	const reasons = [];
	const fallback = fixture(async reason => reasons.push(reason));
	fallback.fill.arm(); fallback.fire();
	await fallback.fill.fillNow('page-request');
	assert.deepEqual(reasons, ['ready-fallback']);
	await fallback.fill.dispose();
	const explicit = fixture(async reason => reasons.push(reason));
	await explicit.fill.fillNow('page-request');
	assert.deepEqual(reasons, ['ready-fallback', 'page-request']);
	await explicit.fill.dispose();
});

test('actual plugin wiring waits for appReady, retains on-demand gate and packages the helper', () => {
	const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	assert.match(source, /ready\.onReady\(\(\) => fill\.arm\(\)\)/);
	assert.match(source, /if \(!ready\?\.onReady\) \{ fill\.arm\(\); \}/);
	assert.match(source, /await state\.lazyFill\.fillNow\(\)/);
	assert.match(source, /await fill\.dispose\(\)/);
	assert.match(source, /state\.lazyFillDone = completed/);
	assert.match(source, /if \(completed && lazyPresetHooks\.state === state\)/);
	assert.ok(!source.includes('timer = setTimeout(() => { void fillNow(); }, LAZY_FILL_DELAY_MS)'));
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.ok(pkg.files.includes('lib/lazyPresetFill.js'));
});
