/*---------------------------------------------------------------------------------------------
 *  workerPoolManager.test.ts — 统一 Worker 工厂单元测试。
 *
 *  覆盖：
 *  - wrapWorkerUrl basic & null handling
 *  - createBlobWorker 在 Node.js 环境的行为（Web Worker 不可用 → 返回 null）
 *  - 边界情况：空脚本、大脚本、特殊字符
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { wrapWorkerUrl, createBlobWorker, createWorkerPoolAsync } from '../../browser/shared/workerPoolManager.js';

const isNode = typeof window === 'undefined';

suite('wrapWorkerUrl', () => {

	test('returns non-empty string', () => {
		const result = wrapWorkerUrl('blob:http://test');
		assert.strictEqual(typeof result, 'string');
		assert.ok(result.length > 0, 'should return non-empty string');
	});

	test('passes through valid blob URL in Node.js environment', () => {
		const raw = 'blob:http://localhost/test-worker.js';
		const result = wrapWorkerUrl(raw);
		// In Node.js (no trustedTypes), should return the original URL unchanged
		assert.ok(result.includes('blob:'), `should contain blob: got: ${result.substring(0, 30)}`);
	});

	test('handles empty string gracefully', () => {
		assert.doesNotThrow(() => {
			const result = wrapWorkerUrl('');
			assert.strictEqual(typeof result, 'string');
		});
	});
});

suite('createBlobWorker', () => {

	test('returns null in Node.js environment (no Worker API)', () => {
		const worker = createBlobWorker('self.onmessage = function() {}');
		assert.strictEqual(worker, null, 'Node.js has no window.Worker');
	});

	test('returns null for empty script', () => {
		const worker = createBlobWorker('');
		assert.strictEqual(worker, null);
	});

	test('returns null for large script (no crash)', () => {
		const largeScript = 'self.onmessage = function() {};\n'.repeat(1000);
		assert.doesNotThrow(() => {
			const worker = createBlobWorker(largeScript);
			assert.strictEqual(worker, null);
		});
	});

	test('handles special characters in script', () => {
		const scriptWithSpecials = 'self.onmessage = function(e) { const x = "你好世界"; postMessage({ok: true}); };';
		assert.doesNotThrow(() => {
			const worker = createBlobWorker(scriptWithSpecials);
			assert.strictEqual(worker, null);
		});
	});
});

suite('createWorkerPoolAsync', () => {

	test('resolves with empty array in Node.js environment', async () => {
		const workers = await createWorkerPoolAsync('self.onmessage = function() {}', 4);
		assert.ok(Array.isArray(workers), 'should return array');
		assert.strictEqual(workers.length, 0, 'should be empty in Node.js');
	});

	test('handles poolCount = 0', async () => {
		const workers = await createWorkerPoolAsync('self.onmessage = function() {}', 0);
		assert.ok(Array.isArray(workers));
		assert.strictEqual(workers.length, 0);
	});

	test('pool does not reject on creation failure', async () => {
		await assert.doesNotReject(async () => {
			await createWorkerPoolAsync('bad code without valid JS', 2);
		});
	});
});

// Ensure mocha sees the suite (compiled file must export nothing)
export {};
