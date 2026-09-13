/*---------------------------------------------------------------------------------------------
 *  memoryWriteBudget.test.ts — memory_remember 写入预算回归测试（P2 补测，2026-09-09）
 *
 *  背景：评估发现预算耗尽分支零覆盖，且工具描述（3 saves）与代码（10/subagent）漂移。
 *  P0-4 已将预算泛化：子代理 per-task 10 / 主代理 per-session 50。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { checkMemoryWriteBudget } from '../../browser/providers/tool/memoryTools.js';

// 每个用例用独立 agentId，避免模块级计数器相互污染
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

suite('memoryWriteBudget — 写入预算（P0-4）', () => {
	test('子代理：前 10 次放行，第 11 次拒绝', () => {
		const id = uid('subagent-t');
		for (let i = 0; i < 10; i++) {
			const r = checkMemoryWriteBudget(id);
			assert.ok(r.allowed, `第 ${i + 1} 次应放行`);
			assert.strictEqual(r.budget, 10);
			assert.strictEqual(r.isSubagent, true);
		}
		const blocked = checkMemoryWriteBudget(id);
		assert.strictEqual(blocked.allowed, false, '第 11 次应拒绝');
		assert.strictEqual(blocked.used, 10);
	});

	test('主代理：前 50 次放行，第 51 次拒绝（P0-4 前完全无限制）', () => {
		const id = uid('main-t');
		for (let i = 0; i < 50; i++) {
			const r = checkMemoryWriteBudget(id);
			assert.ok(r.allowed, `第 ${i + 1} 次应放行`);
			assert.strictEqual(r.budget, 50);
			assert.strictEqual(r.isSubagent, false);
		}
		const blocked = checkMemoryWriteBudget(id);
		assert.strictEqual(blocked.allowed, false, '第 51 次应拒绝');
	});

	test('子代理与主代理预算相互独立（计数按 agentId 隔离）', () => {
		const sub = uid('subagent-i');
		const main = uid('main-i');
		for (let i = 0; i < 10; i++) { checkMemoryWriteBudget(sub); }
		assert.strictEqual(checkMemoryWriteBudget(sub).allowed, false, '子代理预算耗尽');
		assert.strictEqual(checkMemoryWriteBudget(main).allowed, true, '主代理计数不受子代理影响');
	});

	test('used 计数递增正确', () => {
		const id = uid('cnt');
		assert.strictEqual(checkMemoryWriteBudget(id).used, 1);
		assert.strictEqual(checkMemoryWriteBudget(id).used, 2);
		assert.strictEqual(checkMemoryWriteBudget(id).used, 3);
	});
});
