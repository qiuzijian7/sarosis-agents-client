/*---------------------------------------------------------------------------------------------
 *  codebaseSimilarityIncremental.test.ts — 增量克隆检测单元测试（2026-08-21）。
 *
 *  验证 detectSimilarCodeIncremental（新节点 vs 全量）与 detectSimilarCode（全量自配对）
 *  的语义一致性，以及修复日志 1787282021811 的「增量索引全量 MinHash 扫描卡死 renderer」。
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseSimilarityIncremental.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CodebaseGraphStore, GraphNode } from '../../browser/codebaseGraphStore.js';
import { detectSimilarCode, detectSimilarCodeIncremental, MINHASH_PERM } from '../../browser/codebaseGraphExtendedPasses.js';

const PROJECT = 'test';

/** 生成 48 长度的 MinHash 签名。 */
function sig(base: number): number[] {
	return Array.from({ length: MINHASH_PERM }, (_, i) => base + i);
}

/** 构造带 minHash 签名的 function 节点。 */
function addFn(store: CodebaseGraphStore, name: string, signature: number[]): GraphNode {
	return store.upsertNode({
		project: PROJECT,
		label: 'function',           // 小写：detectSimilarCode 只认 'function'/'method'
		name,
		qualifiedName: `file.ts::${name}`,
		filePath: 'file.ts',
		properties: { minHash: signature },
	});
}

function sortedPairs(edges: { sourceQN: string; targetQN: string }[]): string[] {
	return edges.map(e => {
		const a = e.sourceQN.split('::')[1];
		const b = e.targetQN.split('::')[1];
		return a < b ? `${a}<->${b}` : `${b}<->${a}`;
	}).sort();
}

suite('detectSimilarCodeIncremental vs detectSimilarCode', () => {

	test('full detection pairs identical signatures; incremental with an unrelated new node adds nothing', async () => {
		const store = new CodebaseGraphStore();
		const n1 = addFn(store, 'fnA', sig(1000));
		const n2 = addFn(store, 'fnB', sig(1000));   // 与 fnA 完全相同
		const n3 = addFn(store, 'fnC', sig(9000));   // 与谁都不同
		const all = store.getAllNodes();

		const full = detectSimilarCode(all, store, 0.7);
		assert.deepStrictEqual(sortedPairs(full), ['fnA<->fnB'], 'full pass must pair the two identical functions');

		// 增量只查 n3（与谁都不同）→ 0 边
		const inc3 = await detectSimilarCodeIncremental(new Set([n3.id]), all, store, 0.7);
		assert.strictEqual(inc3.length, 0, 'an unrelated new node must not produce any edge');
	});

	test('incremental with a new node identical to an existing one recovers the same edge', async () => {
		const store = new CodebaseGraphStore();
		const n1 = addFn(store, 'fnA', sig(1000));
		const n2 = addFn(store, 'fnB', sig(1000));
		const n3 = addFn(store, 'fnC', sig(9000));
		const all = store.getAllNodes();

		// 增量查 n2（与 n1 完全相同）→ 必须恢复 1 条边 n1<->n2
		const inc2 = await detectSimilarCodeIncremental(new Set([n2.id]), all, store, 0.7);
		assert.deepStrictEqual(sortedPairs(inc2), ['fnA<->fnB']);
	});

	test('incremental result is always a subset of full result and every edge touches a new node', async () => {
		const store = new CodebaseGraphStore();
		// fnA / fnB 克隆对；fnD / fnE 克隆对；fnC 独立
		const nA = addFn(store, 'fnA', sig(1000));
		const nB = addFn(store, 'fnB', sig(1000));
		const nC = addFn(store, 'fnC', sig(3000));
		const nD = addFn(store, 'fnD', sig(5000));
		const nE = addFn(store, 'fnE', sig(5000));
		const all = store.getAllNodes();

		const full = detectSimilarCode(all, store, 0.7);
		const fullPairs = new Set(sortedPairs(full));

		// 只把 nC（独立节点）当新节点 → 增量结果应为空
		const incC = await detectSimilarCodeIncremental(new Set([nC.id]), all, store, 0.7);
		assert.strictEqual(incC.length, 0);

		// 把 nB 当新节点 → 只应得到 fnA<->fnB，绝不能把 fnD<->fnE（两个都是旧节点）带出来
		const incB = await detectSimilarCodeIncremental(new Set([nB.id]), all, store, 0.7);
		assert.deepStrictEqual(sortedPairs(incB), ['fnA<->fnB']);
		for (const e of incB) {
			assert.ok(e.sourceQN.includes('fnB') || e.targetQN.includes('fnB'),
				'every incremental edge must touch the new node');
			assert.ok(fullPairs.has(e.sourceQN.split('::')[1] < e.targetQN.split('::')[1]
				? `${e.sourceQN.split('::')[1]}<->${e.targetQN.split('::')[1]}`
				: `${e.targetQN.split('::')[1]}<->${e.sourceQN.split('::')[1]}`),
				'incremental edge must exist in the full result');
		}

		// 把 nB 和 nE 都当新节点 → 应得到两个克隆对
		const incBE = await detectSimilarCodeIncremental(new Set([nB.id, nE.id]), all, store, 0.7);
		assert.deepStrictEqual(sortedPairs(incBE), ['fnA<->fnB', 'fnD<->fnE']);
	});

	test('new nodes that are clones of EACH OTHER are still detected', async () => {
		const store = new CodebaseGraphStore();
		const nOld = addFn(store, 'fnOld', sig(1000));
		// 两个全新节点互相克隆（都与旧节点不同）
		const nX = addFn(store, 'fnX', sig(7000));
		const nY = addFn(store, 'fnY', sig(7000));
		const all = store.getAllNodes();

		const inc = await detectSimilarCodeIncremental(new Set([nX.id, nY.id]), all, store, 0.7);
		assert.deepStrictEqual(sortedPairs(inc), ['fnX<->fnY'], 'new-vs-new clones must be detected');
	});

	test('empty or no-function new set short-circuits without throwing', async () => {
		const store = new CodebaseGraphStore();
		addFn(store, 'fnA', sig(1000));
		addFn(store, 'fnB', sig(1000));
		const all = store.getAllNodes();

		assert.strictEqual((await detectSimilarCodeIncremental(new Set<number>(), all, store, 0.7)).length, 0);
		// 新节点集里没有 function 节点（如只有 file 节点）→ 0 边
		const fileNode = store.upsertNode({ project: PROJECT, label: 'file', name: 'f.ts', qualifiedName: 'f.ts' });
		assert.strictEqual((await detectSimilarCodeIncremental(new Set([fileNode.id]), all, store, 0.7)).length, 0);
	});

});
