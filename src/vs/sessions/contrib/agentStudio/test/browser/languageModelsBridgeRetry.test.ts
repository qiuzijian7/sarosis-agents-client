/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	CHUNK_TIMEOUT_SENTINEL,
	isRetryableStreamError,
	LM_BRIDGE_RETRY_MAX_ATTEMPTS,
	raceIteratorNext,
	VSSAROS_TOOL_CALL_PROGRESS_MIME,
} from '../../browser/languageModelsBridge.js';
import { adaptModelDelta } from '../../browser/agentModelAccess.js';

/**
 * P4 死流重试的纯函数级测试（2026-07-26）。
 * 覆盖：isRetryableStreamError 分类 + raceIteratorNext chunk 超时赛跑。
 * chat() 重试循环本体依赖 ILanguageModelsService DI，不在此 mock。
 */
suite('languageModelsBridge — P4 stream retry helpers', () => {

	suite('isRetryableStreamError', () => {

		test('SSE 读超时（chunk 超时哨兵错误）→ 可重试', () => {
			assert.strictEqual(isRetryableStreamError('SSE read timed out'), true);
		});

		test('网络层错误 → 可重试', () => {
			assert.strictEqual(isRetryableStreamError('fetch failed'), true);
			assert.strictEqual(isRetryableStreamError('read ECONNRESET'), true);
			assert.strictEqual(isRetryableStreamError('socket hang up'), true);
			assert.strictEqual(isRetryableStreamError('network error'), true);
		});

		test('网关 5xx / 429 → 可重试', () => {
			assert.strictEqual(isRetryableStreamError('HTTP 502 Bad Gateway'), true);
			assert.strictEqual(isRetryableStreamError('HTTP 503 Service Unavailable'), true);
			assert.strictEqual(isRetryableStreamError('HTTP 429 Too Many Requests'), true);
		});

		test('网关超时类 → 可重试', () => {
			assert.strictEqual(isRetryableStreamError('Request timeout'), true);
			assert.strictEqual(isRetryableStreamError('Gateway Timeout'), true);
			assert.strictEqual(isRetryableStreamError('ETIMEDOUT'), true);
		});

		test('用户取消 → 不可重试', () => {
			assert.strictEqual(isRetryableStreamError('Aborted'), false);
			assert.strictEqual(isRetryableStreamError('The operation was aborted'), false);
			assert.strictEqual(isRetryableStreamError('Request cancelled by user'), false);
		});

		test('4xx 参数/权限错误 → 不可重试（重试必然同样失败）', () => {
			assert.strictEqual(isRetryableStreamError('HTTP 400: {"code":11133,"msg":"invalid_parameter"}'), false);
			assert.strictEqual(isRetryableStreamError('HTTP 401 Unauthorized'), false);
			assert.strictEqual(isRetryableStreamError('HTTP 403 Forbidden'), false);
		});

		test('未知错误 → 不可重试（保守策略）', () => {
			assert.strictEqual(isRetryableStreamError('Unexpected token < in JSON'), false);
			assert.strictEqual(isRetryableStreamError('some random error'), false);
		});
	});

	suite('raceIteratorNext', () => {

		test('正常 resolve 的 iterator 原样透传结果', async () => {
			const it: AsyncIterator<string> = {
				next: () => Promise.resolve({ value: 'chunk-1', done: false }),
			};
			const r = await raceIteratorNext(it, 50);
			assert.notStrictEqual(r, CHUNK_TIMEOUT_SENTINEL);
			assert.deepStrictEqual(r, { value: 'chunk-1', done: false });
		});

		test('iterator 完成（done=true）原样透传', async () => {
			const it: AsyncIterator<string> = {
				next: () => Promise.resolve({ value: undefined, done: true }),
			};
			const r = await raceIteratorNext(it, 50);
			assert.notStrictEqual(r, CHUNK_TIMEOUT_SENTINEL);
			assert.strictEqual((r as IteratorResult<string>).done, true);
		});

		test('永不 resolve 的 iterator（死流）→ 超时后返回哨兵', async () => {
			const it: AsyncIterator<string> = {
				next: () => new Promise(() => { /* 永不 resolve — 模拟 TCP 静默死亡 */ }),
			};
			const t0 = Date.now();
			const r = await raceIteratorNext(it, 60);
			const elapsed = Date.now() - t0;
			assert.strictEqual(r, CHUNK_TIMEOUT_SENTINEL, '应返回超时哨兵');
			assert.ok(elapsed >= 55, `应在 ~60ms 后超时，实际 ${elapsed}ms`);
		});

		test('慢于阈值的 chunk → 哨兵；快于阈值的 chunk → 正常（per-read 重武装语义）', async () => {
			const slow: AsyncIterator<string> = {
				next: () => new Promise(res => setTimeout(() => res({ value: 'late', done: false }), 120)),
			};
			assert.strictEqual(await raceIteratorNext(slow, 50), CHUNK_TIMEOUT_SENTINEL);

			const fast: AsyncIterator<string> = {
				next: () => new Promise(res => setTimeout(() => res({ value: 'soon', done: false }), 10)),
			};
			const r = await raceIteratorNext(fast, 50);
			assert.notStrictEqual(r, CHUNK_TIMEOUT_SENTINEL);
			assert.deepStrictEqual(r, { value: 'soon', done: false });
		});
	});

	test('重试预算常量：1 首发 + 2 重试 = 3 次尝试（MiMo 收敛版）', () => {
		assert.strictEqual(LM_BRIDGE_RETRY_MAX_ATTEMPTS, 3);
	});
});

// ── 治本（2026-07-26，事故 1785049332701）：工具参数流式进度信号管道 ──
suite('tool_call progress pipeline（治本）', () => {

	test('MIME 约定与 provider 扩展一致', () => {
		assert.strictEqual(VSSAROS_TOOL_CALL_PROGRESS_MIME, 'application/vnd.saros.tool-call-progress+json');
	});

	test('adaptModelDelta：tool_progress → tool_progress（stage 透传）', () => {
		const deps = { logService: { info() { /* noop */ } } } as any;
		const d = adaptModelDelta(deps, { type: 'tool_progress', content: '正在生成工具调用参数 file_write… 已 12 KB' });
		assert.strictEqual(d.type, 'tool_progress');
		assert.strictEqual((d as any).stage, '正在生成工具调用参数 file_write… 已 12 KB');
	});

	test('adaptModelDelta：tool_progress 无 content → 空 stage（不崩溃）', () => {
		const deps = { logService: { info() { /* noop */ } } } as any;
		const d = adaptModelDelta(deps, { type: 'tool_progress' });
		assert.strictEqual(d.type, 'tool_progress');
		assert.strictEqual((d as any).stage, '');
	});
});
