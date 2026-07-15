/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { withStreamTimeout } from '../../common/resilience.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function* hangAfterFirst(): AsyncIterable<string> {
	yield 'a';
	await new Promise<void>(() => { /* never resolves → simulates a hung model stream */ });
}

async function* slowYield(): AsyncIterable<string> {
	yield 'a';
	await sleep(80); // 超过 runTimeout
	yield 'b';
}

async function* spacedYield(): AsyncIterable<string> {
	yield 'a';
	await sleep(10);
	yield 'b';
	await sleep(10);
	yield 'c';
}

async function* all(items: string[]): AsyncIterable<string> {
	for (const i of items) { yield i; }
}

async function* hangBeforeFirst(): AsyncIterable<string> {
	// 永不产出任何 item —— 模拟「首 token 之前就挂起」的流。
	await new Promise<void>(() => { /* never resolves */ });
}

async function* delayedFirstYield(delay: number, items: string[]): AsyncIterable<string> {
	// 首 token 延迟到达；若首 token 前空窗被当作 idle 计时，短 idleTimeout 会误杀。
	await sleep(delay);
	for (const i of items) { yield i; }
}

suite('Resilience - withStreamTimeout (P0b)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('normal stream passes through all items', async () => {
		const out: string[] = [];
		for await (const x of withStreamTimeout(all(['a', 'b', 'c']), { idleTimeout: 50 })) {
			out.push(x);
		}
		assert.deepStrictEqual(out, ['a', 'b', 'c']);
	});

	test('idle timeout fires when no delta arrives (hung stream)', async () => {
		const gen = (async () => {
			const out: string[] = [];
			for await (const x of withStreamTimeout(hangAfterFirst(), { idleTimeout: 30 })) {
				out.push(x);
			}
			return out;
		})();
		await assert.rejects(gen, (e: unknown) => e instanceof DOMException && e.name === 'TimeoutError');
	});

	test('idle timeout is refreshed by each delivered item', async () => {
		const out: string[] = [];
		for await (const x of withStreamTimeout(spacedYield(), { idleTimeout: 50 })) {
			out.push(x);
		}
		assert.deepStrictEqual(out, ['a', 'b', 'c']);
	});

	test('run timeout fires when total exceeds cap', async () => {
		const gen = (async () => {
			const out: string[] = [];
			for await (const x of withStreamTimeout(slowYield(), { runTimeout: 30 })) {
				out.push(x);
			}
			return out;
		})();
		await assert.rejects(gen, (e: unknown) => e instanceof DOMException && e.name === 'TimeoutError');
	});

	test('abort signal propagates AbortError', async () => {
		const ac = new AbortController();
		const gen = (async () => {
			const out: string[] = [];
			for await (const x of withStreamTimeout(hangAfterFirst(), { idleTimeout: 5000 }, { signal: ac.signal })) {
				out.push(x);
			}
			return out;
		})();
		setTimeout(() => ac.abort(), 10);
		await assert.rejects(gen, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
	});

	test('first-token timeout fires (not idle) when no delta before budget', async () => {
		// 用大 idleTimeout + 小 firstTokenTimeout：若首 token 前空窗误用 idleTimeout，
		// 需要 5000ms 才触发；正确行为应在 firstTokenTimeout(40ms) 触发。
		const gen = (async () => {
			const out: string[] = [];
			for await (const x of withStreamTimeout(hangBeforeFirst(), { idleTimeout: 5000, firstTokenTimeout: 40 })) {
				out.push(x);
			}
			return out;
		})();
		const t0 = Date.now();
		await assert.rejects(gen, (e: unknown) => e instanceof DOMException && e.name === 'TimeoutError');
		assert.ok(Date.now() - t0 < 1000, '应在 firstTokenTimeout(40ms) 而非 idleTimeout(5000ms) 触发');
	});

	test('slow first token is tolerated by firstTokenTimeout (no premature idle)', async () => {
		// 首 token 延迟 100ms，但 idleTimeout 仅 30ms。若首 token 前空窗被当作 idle
		// 计时，会在 30ms 误杀；正确行为应放行（首 token 宽限 200ms）。
		const out: string[] = [];
		const t0 = Date.now();
		for await (const x of withStreamTimeout(delayedFirstYield(100, ['a', 'b']), { idleTimeout: 30, firstTokenTimeout: 200 })) {
			out.push(x);
		}
		assert.deepStrictEqual(out, ['a', 'b']);
		assert.ok(Date.now() - t0 >= 100, '应至少等待首 token 延迟（未被 30ms idle 误杀）');
	});
});
