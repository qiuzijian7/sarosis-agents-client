/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	withStreamTimeout,
	computeAdaptiveFirstTokenTimeout,
	ADAPTIVE_FIRST_TOKEN_THRESHOLD,
	ADAPTIVE_FIRST_TOKEN_STEP_TOKENS,
	ADAPTIVE_FIRST_TOKEN_STEP_MS,
	ADAPTIVE_FIRST_TOKEN_CAP_MS,
	ADAPTIVE_FIRST_TOKEN_FLOOR_MS,
} from '../../common/resilience.js';
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

suite('computeAdaptiveFirstTokenTimeout', () => {
	const BASE = 45_000;
	const FLOOR = Math.max(BASE, ADAPTIVE_FIRST_TOKEN_FLOOR_MS);

	test('at or below threshold returns cold-start floor (not base)', () => {
		// 冷启动地板优先于 base：即使小 prompt 也至少等满地板宽限，
		// 避免网关实例冷启动（TTFT 与 prompt 大小无关）被误杀。
		assert.strictEqual(computeAdaptiveFirstTokenTimeout(0, BASE), FLOOR);
		assert.strictEqual(computeAdaptiveFirstTokenTimeout(8_000, BASE), FLOOR);
		assert.strictEqual(computeAdaptiveFirstTokenTimeout(ADAPTIVE_FIRST_TOKEN_THRESHOLD, BASE), FLOOR);
	});

	test('non-finite / negative input returns cold-start floor', () => {
		assert.strictEqual(computeAdaptiveFirstTokenTimeout(NaN, BASE), FLOOR);
		assert.strictEqual(computeAdaptiveFirstTokenTimeout(-1, BASE), FLOOR);
		assert.strictEqual(computeAdaptiveFirstTokenTimeout(Infinity, BASE), FLOOR);
	});

	test('cold-start floor covers gateway-instance cold start (incident 1787759336456)', () => {
		// 实测 hy3-ioa 小 prompt(≈20k) 网关实例冷启动 TTFT=86s 被 60s 预算误杀，
		// 流最终在 86s 正常返回 tool_call。地板 90s 必须 > 86s。
		const budget = computeAdaptiveFirstTokenTimeout(19_891, BASE);
		assert.ok(budget >= ADAPTIVE_FIRST_TOKEN_FLOOR_MS, `预算 ${budget} 应不低于地板 ${ADAPTIVE_FIRST_TOKEN_FLOOR_MS}`);
		assert.ok(budget > 86_000, `预算 ${budget}ms 应大于事故 TTFT 86s`);
	});

	test('grows in steps above threshold', () => {
		// 16k→base；+1 token 即进第一档 → base+15s；24k→base+15s；24k+1→base+30s
		assert.strictEqual(
			computeAdaptiveFirstTokenTimeout(ADAPTIVE_FIRST_TOKEN_THRESHOLD + 1, BASE),
			BASE + ADAPTIVE_FIRST_TOKEN_STEP_MS,
		);
		assert.strictEqual(
			computeAdaptiveFirstTokenTimeout(ADAPTIVE_FIRST_TOKEN_THRESHOLD + ADAPTIVE_FIRST_TOKEN_STEP_TOKENS, BASE),
			BASE + ADAPTIVE_FIRST_TOKEN_STEP_MS,
		);
		assert.strictEqual(
			computeAdaptiveFirstTokenTimeout(ADAPTIVE_FIRST_TOKEN_THRESHOLD + ADAPTIVE_FIRST_TOKEN_STEP_TOKENS + 1, BASE),
			BASE + 2 * ADAPTIVE_FIRST_TOKEN_STEP_MS,
		);
	});

	test('real-world incident case: 34k tokens gets ≥46s budget (no false kill at 45s)', () => {
		// 生产事故：hy3-ioa 34.2k tokens 冷缓存 TTFB=46.4s 被 45s 阈值误杀。
		// 34k → 45s + ceil(18k/8k)*15s = 45+45 = 90s，足以覆盖。
		const budget = computeAdaptiveFirstTokenTimeout(34_200, BASE);
		assert.strictEqual(budget, 90_000);
		assert.ok(budget > 46_400, `34k tokens 预算 ${budget}ms 应大于事故 TTFB 46.4s`);
	});

	test('caps at ADAPTIVE_FIRST_TOKEN_CAP_MS (below HTTP layer 120s)', () => {
		assert.strictEqual(computeAdaptiveFirstTokenTimeout(200_000, BASE), ADAPTIVE_FIRST_TOKEN_CAP_MS);
		assert.ok(ADAPTIVE_FIRST_TOKEN_CAP_MS < 120_000, '封顶必须低于 HTTP 层 120s 请求超时');
	});
});
