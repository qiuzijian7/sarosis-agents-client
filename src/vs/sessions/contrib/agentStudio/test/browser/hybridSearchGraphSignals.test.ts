/*---------------------------------------------------------------------------------------------
 *  P0-2 图信号重排 + token 预算封顶 单元测试（纯函数，无 IO）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	HybridSearchHit, rerankWithGraphSignals, clampToTokenBudget, estimateTokens,
} from '../../browser/knowledge/engine/hybridSearch.js';

function hit(id: string, rrf: number): HybridSearchHit<string> {
	return { item: id, id, vectorScore: -1, ftsScore: -1, rrfScore: rrf };
}

suite('AgentStudio - hybridSearch P0-2 图信号重排', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('高度数节点获得加成上移', () => {
		// b 原排第二，但度数远高于 a → 加成后应超过 a
		const hits = [hit('a', 0.0164), hit('b', 0.0163), hit('c', 0.01)];
		const signals: Record<string, { degree: number }> = { a: { degree: 0 }, b: { degree: 20 }, c: { degree: 1 } };
		const out = rerankWithGraphSignals(hits, h => signals[h.id!]);
		assert.strictEqual(out[0].id, 'b', '高度数节点应上移到首位');
	});

	test('无图信号时保持原序', () => {
		const hits = [hit('a', 0.3), hit('b', 0.2), hit('c', 0.1)];
		const out = rerankWithGraphSignals(hits, () => undefined);
		assert.deepStrictEqual(out.map(h => h.id), ['a', 'b', 'c']);
	});

	test('社区多样化：同社区超额者顺延队尾且不丢弃', () => {
		const hits = [hit('a', 0.5), hit('b', 0.4), hit('c', 0.3), hit('d', 0.2), hit('e', 0.1)];
		// a/b/c/d 同社区 1，e 社区 2；maxPerCommunity=2 → d 被挤到 e 之后
		const cid: Record<string, number> = { a: 1, b: 1, c: 1, d: 1, e: 2 };
		const out = rerankWithGraphSignals(hits, h => ({ degree: 0, communityId: cid[h.id!] }), { maxPerCommunity: 2 });
		assert.deepStrictEqual(out.map(h => h.id), ['a', 'b', 'e', 'c', 'd']);
		assert.strictEqual(out.length, 5, '不得丢弃任何结果');
	});
});

suite('AgentStudio - hybridSearch P0-2 token 预算封顶', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('estimateTokens：CJK 按字计、ASCII 按 4 字符折算', () => {
		assert.strictEqual(estimateTokens('中文四个字'), 5);
		assert.strictEqual(estimateTokens('abcdefgh'), 2);
	});

	test('超预算截断且至少保 1 条', () => {
		const items = ['x'.repeat(400), 'y'.repeat(400), 'z'.repeat(400)]; // 各约 100 token
		const r = clampToTokenBudget(items, s => s, 150);
		assert.strictEqual(r.items.length, 1, '预算 150 只容得下第 1 条');
		assert.strictEqual(r.truncated, true);

		const r2 = clampToTokenBudget(items, s => s, 10);
		assert.strictEqual(r2.items.length, 1, '预算不足也至少保 1 条');
	});

	test('预算充足不截断', () => {
		const items = ['a', 'b', 'c'];
		const r = clampToTokenBudget(items, s => s, 1000);
		assert.strictEqual(r.items.length, 3);
		assert.strictEqual(r.truncated, false);
	});
});
