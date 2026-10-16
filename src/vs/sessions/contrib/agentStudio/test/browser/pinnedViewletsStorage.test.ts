/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `purgePinnedViewlets` 的行为网（`sessions/contrib/agentStudio/browser/pinnedViewletsStorage.ts`）。
 *
 * 这是在**用户持久化数据**上做减法，写坏的代价是 pin 顺序丢失，所以边界要逐条钉住：
 * 命中项要删干净、其它条目一个都不能动、无法解析的内容绝不能被覆盖。
 * 运行：`node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/pinnedViewletsStorage.test.ts`
 */

import assert from 'assert';
import { purgePinnedViewlets } from '../../browser/pinnedViewletsStorage.js';

/** 造一条 pinned 条目（只保留净化逻辑关心的字段）。 */
function entry(id: string, order: number, visible = true): { id: string; name: string; order: number; pinned: boolean; visible: boolean } {
	return { id, name: id, order, pinned: true, visible };
}

suite('pinnedViewlets 净化（注销后清残留）', () => {

	test('命中项被剔除，其它条目与顺序原样保留', () => {
		const json = JSON.stringify([entry('agentStudio.workspace', 10), entry('agentStudio.tasks', 70), entry('agentStudio.search', 20)]);

		const result = purgePinnedViewlets(json, 'agentStudio.tasks');

		assert.ok(result, '有命中项时必须返回结果（否则调用方不会写回）');
		assert.strictEqual(result!.before, 3);
		assert.strictEqual(result!.after, 2);
		assert.deepStrictEqual(JSON.parse(result!.value).map((e: { id: string }) => e.id), ['agentStudio.workspace', 'agentStudio.search']);
	});

	test('同一个 id 有多条残留时全部剔除（不留半截）', () => {
		const json = JSON.stringify([entry('vssaros.dsh.canvas', 115), entry('agentStudio.knowledgeBase', 110), entry('vssaros.dsh.canvas', 115, false)]);

		const result = purgePinnedViewlets(json, 'vssaros.dsh.canvas');

		assert.ok(result);
		assert.strictEqual(result!.after, 1);
		assert.deepStrictEqual(JSON.parse(result!.value).map((e: { id: string }) => e.id), ['agentStudio.knowledgeBase']);
	});

	test('全部条目都是目标时，结果是空数组（合法值，调用方照写）', () => {
		const json = JSON.stringify([entry('vssaros.dsh.codebase', 25)]);

		const result = purgePinnedViewlets(json, 'vssaros.dsh.codebase');

		assert.ok(result);
		assert.strictEqual(result!.after, 0);
		assert.strictEqual(result!.value, '[]');
	});

	test('没有该 id ⇒ 返回 undefined（不做无意义的写盘）', () => {
		const json = JSON.stringify([entry('agentStudio.workspace', 10), entry('agentStudio.search', 20)]);

		assert.strictEqual(purgePinnedViewlets(json, 'vssaros.dsh.canvas'), undefined);
	});

	test('无法解析 / 形态不对的内容一律返回 undefined（绝不覆盖用户的存储）', () => {
		assert.strictEqual(purgePinnedViewlets(undefined, 'x'), undefined, '值为空');
		assert.strictEqual(purgePinnedViewlets('', 'x'), undefined, '空串');
		assert.strictEqual(purgePinnedViewlets('{not json', 'x'), undefined, '非法 JSON');
		assert.strictEqual(purgePinnedViewlets('{"id":"x"}', 'x'), undefined, '对象而不是数组');
		assert.strictEqual(purgePinnedViewlets('"x"', 'x'), undefined, '字符串而不是数组');
		assert.strictEqual(purgePinnedViewlets('null', 'x'), undefined, 'null');
	});

	test('条目缺 id / 为 null 时不误伤，也不会因它命中', () => {
		const json = JSON.stringify([null, { name: 'no-id' }, entry('agentStudio.tasks', 70)]);

		// 找不到目标 ⇒ undefined
		assert.strictEqual(purgePinnedViewlets(json, 'agentStudio.workflow'), undefined);

		// 命中目标时，畸形条目要原样留（本函数只认 id 相等）
		const result = purgePinnedViewlets(json, 'agentStudio.tasks');
		assert.ok(result);
		assert.strictEqual(result!.after, 2);
		assert.deepStrictEqual(JSON.parse(result!.value), [null, { name: 'no-id' }]);
	});

	test('id 只按字符串相等比较：数字 id 既不会被误删、也不会被误命中', () => {
		const json = JSON.stringify([{ id: 42, name: 'numeric' }, entry('agentStudio.tasks', 70)]);

		// 数字 42 ≠ 字符串 '42' ⇒ 无命中 ⇒ 不写回（用户的存储原样保留）
		assert.strictEqual(purgePinnedViewlets(json, '42'), undefined);

		// 命中真目标时，数字 id 的条目原样留着
		const result = purgePinnedViewlets(json, 'agentStudio.tasks');
		assert.ok(result);
		assert.strictEqual(result!.after, 1);
		assert.deepStrictEqual(JSON.parse(result!.value).map((e: { id: unknown }) => e.id), [42]);
	});
});
