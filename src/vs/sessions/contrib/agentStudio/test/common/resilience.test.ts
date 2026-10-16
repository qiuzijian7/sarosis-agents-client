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

	test('grows in steps above threshold（地板先吞掉最早几档 —— 这是有意的）', () => {
		// ⚠ 2026-10-14 修：这条原来断言 `门槛+1 ⇒ BASE + 1×步长 = 60s`、`门槛+8k ⇒ 60s`、`+8k+1 ⇒ 75s`
		//   —— 那是**冷启动地板之前**的读数 ✗。地板（`ADAPTIVE_FIRST_TOKEN_FLOOR_MS = 90s`，为事故
		//   1787759336456 的网关冷启动加的）优先级高于 base+step，而 base=45s 时前几档算出来仍 < 90s
		//   ⇒ 一律被抬到 90s ⇒ **60s / 75s 这两个中间值不可达**（实现注释里那份阶梯就是这么写的 ✓）。
		//   现在按"地板 → 阶梯 → 封顶"的真实口径逐档钉住；下面注释里的算式可直接复核 ✓。
		const at = (tokens: number) => computeAdaptiveFirstTokenTimeout(tokens, BASE);
		// ① 刚好在门槛上 ⇒ 地板
		assert.strictEqual(at(ADAPTIVE_FIRST_TOKEN_THRESHOLD), FLOOR);
		// ② 门槛之上但 base+step 仍低于地板 ⇒ **还是地板**（45s+15s=60s、45s+30s=75s 都被抬到 90s）
		assert.strictEqual(at(ADAPTIVE_FIRST_TOKEN_THRESHOLD + 1), FLOOR,
			'45s+1 档=60s < 地板 90s ⇒ 抬到地板（不是 60s ✗）');
		assert.strictEqual(at(ADAPTIVE_FIRST_TOKEN_THRESHOLD + 2 * ADAPTIVE_FIRST_TOKEN_STEP_TOKENS), FLOOR,
			'45s+2 档=75s < 地板 90s ⇒ 抬到地板');
		// ③ 地板边界：16k+3 档=40k ⇒ 45s+45s=90s == 地板 ⇒ 90s（这一步"涨"正好被地板吃掉）
		assert.strictEqual(at(ADAPTIVE_FIRST_TOKEN_THRESHOLD + 3 * ADAPTIVE_FIRST_TOKEN_STEP_TOKENS), FLOOR);
		// ④ 阶梯**真的**超过地板：40k+1 ⇒ 4 档 ⇒ 45s+60s=105s ✓（能看出在涨，且还没到封顶）
		assert.strictEqual(at(ADAPTIVE_FIRST_TOKEN_THRESHOLD + 3 * ADAPTIVE_FIRST_TOKEN_STEP_TOKENS + 1),
			BASE + 4 * ADAPTIVE_FIRST_TOKEN_STEP_MS, '40k+1 ⇒ 105s');
		assert.strictEqual(at(ADAPTIVE_FIRST_TOKEN_THRESHOLD + 4 * ADAPTIVE_FIRST_TOKEN_STEP_TOKENS),
			BASE + 4 * ADAPTIVE_FIRST_TOKEN_STEP_MS, '48k ⇒ 仍是 105s（第 4 档上界含）');
		// ⑤ 封顶：48k+1 ⇒ 5 档 ⇒ 45s+75s=120s > cap 115s ⇒ 115s（不得 ≥ HTTP 层 120s 请求超时 ✓）
		assert.strictEqual(at(ADAPTIVE_FIRST_TOKEN_THRESHOLD + 4 * ADAPTIVE_FIRST_TOKEN_STEP_TOKENS + 1),
			ADAPTIVE_FIRST_TOKEN_CAP_MS, '过 48k ⇒ 封顶 115s');
		assert.strictEqual(at(500_000), ADAPTIVE_FIRST_TOKEN_CAP_MS, '再大也不会越过封顶');
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
