/*---------------------------------------------------------------------------------------------
 *  graphAndIndexes.test.ts — 记忆引擎单元测试（P1-7 / P1-8，2026-09-09）
 *
 *  覆盖：
 *    1. BM25Index：_maxDocs 构造覆盖 + FIFO 淘汰计数 evictedCount + serialize/deserialize 往返
 *    2. VectorIndex：同上（trigram addText 路径 + export/import 往返）
 *    3. KnowledgeGraph.restoreFromData：P1-7 图谱 KV 持久化恢复（节点/边重建 + 悬挂边过滤）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { BM25Index } from '../src/bm25Index.js';
import { VectorIndex } from '../src/vectorIndex.js';
import { KnowledgeGraph } from '../src/knowledgeGraph.js';
import { effectiveVectorWeight } from '../src/amFunctions.js';

// run-browser-test.mjs 使用 mocha tdd UI 注入全局 suite/test；
// 不可 import 'mocha'（esbuild 会内联第二份 mocha 实例导致 currentContext undefined）。
declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;

suite('BM25Index — P1-8 上限治理', () => {
	test('构造参数覆盖 _maxDocs，FIFO 淘汰并累计 evictedCount', () => {
		const idx = new BM25Index(5);
		for (let i = 0; i < 7; i++) {
			idx.add(`doc-${i}`, `payload marker${i} shared terms here`);
		}
		assert.ok(idx.size <= 5, `size 应 <= 5，实际 ${idx.size}`);
		assert.ok(idx.evictedCount >= 2, `evictedCount 应 >= 2，实际 ${idx.evictedCount}`);
		// 最早插入的 doc-0/doc-1 应被淘汰（KV 里在但检索不可达——正是要暴露的信号）
		assert.deepStrictEqual(idx.search('marker0').map(r => r.id), [], '被淘汰的 doc-0 不应可检索');
		assert.ok(idx.search('marker6').some(r => r.id === 'doc-6'), '幸存文档仍可检索');
	});

	test('serialize/deserialize 往返保真（检索结果一致）', () => {
		const a = new BM25Index();
		a.add('m1', 'the quick brown fox jumps over the lazy dog');
		a.add('m2', 'agentmemory gateway BM25 index rebuild');
		const b = new BM25Index();
		assert.ok(b.deserialize(a.serialize()), 'deserialize 应返回 true');
		assert.strictEqual(b.size, a.size);
		const ra = a.search('quick brown fox', 5).map(r => r.id);
		const rb = b.search('quick brown fox', 5).map(r => r.id);
		assert.deepStrictEqual(rb, ra);
		assert.ok(rb.includes('m1'));
	});

	test('deserialize 损坏数据容错返回 false', () => {
		const b = new BM25Index();
		assert.strictEqual(b.deserialize('not json{{{'), false);
	});
});

suite('VectorIndex — P1-8 上限治理', () => {
	test('构造参数覆盖 _maxDocs，FIFO 淘汰并累计 evictedCount', () => {
		const vi = new VectorIndex(3);
		for (let i = 0; i < 5; i++) {
			vi.addText(`v-${i}`, `vector payload ${i} zebra`);
		}
		assert.ok(vi.size <= 3, `size 应 <= 3，实际 ${vi.size}`);
		assert.ok(vi.evictedCount >= 2, `evictedCount 应 >= 2，实际 ${vi.evictedCount}`);
	});

	test('serialize/deserialize 往返保真', () => {
		const a = new VectorIndex();
		a.addText('x1', 'alpha beta gamma delta');
		a.addText('x2', 'completely different tokens here');
		const b = new VectorIndex();
		const imported = b.deserialize(a.serialize());
		assert.strictEqual(imported, 2);
		assert.strictEqual(b.size, 2);
		assert.strictEqual(b.dimension, a.dimension);
	});
});

suite('KnowledgeGraph.restoreFromData — P1-7 持久化恢复', () => {
	function buildGraph(): KnowledgeGraph {
		const g = new KnowledgeGraph();
		g.extractFromMemory('mem-1', 'we use auth middleware in src/api/login.ts; decided to adopt jwt', 'sess-1');
		return g;
	}

	test('节点/边经 getNodes/getEdges 导出后可完整恢复', () => {
		const a = buildGraph();
		assert.ok(a.nodeCount > 0, '原图应有节点');
		const b = new KnowledgeGraph();
		b.restoreFromData(a.getNodes(), a.getEdges());
		assert.strictEqual(b.nodeCount, a.nodeCount);
		assert.strictEqual(b.edgeCount, a.edgeCount);
	});

	test('恢复后 searchByEntities 可用（graph 流重启不失效）', () => {
		const a = buildGraph();
		const names = KnowledgeGraph.extractEntityNames('auth middleware in src/api/login.ts');
		const before = a.searchByEntities(names, 2, 10);
		assert.ok(before.length > 0);
		const b = new KnowledgeGraph();
		b.restoreFromData(a.getNodes(), a.getEdges());
		const after = b.searchByEntities(names, 2, 10);
		assert.deepStrictEqual(after.map(r => r.obsId), before.map(r => r.obsId));
	});

	test('悬挂边被过滤（端点节点缺失时不恢复）', () => {
		const b = new KnowledgeGraph();
		b.restoreFromData(
			[{ id: 'n1', type: 'concept', name: 'cache', sourceMemoryIds: ['m1'], createdAt: '2026-01-01' }],
			[{
				id: 'n1→ghost', type: 'related_to', sourceNodeId: 'n1', targetNodeId: 'ghost-node',
				weight: 1, sourceMemoryIds: [], createdAt: '2026-01-01',
			}],
		);
		assert.strictEqual(b.nodeCount, 1);
		assert.strictEqual(b.edgeCount, 0, '悬挂边应被过滤');
	});

	test('空/损坏输入不抛错', () => {
		const b = new KnowledgeGraph();
		b.restoreFromData([], []);
		b.restoreFromData(undefined as any, undefined as any);
		assert.strictEqual(b.nodeCount, 0);
	});
});

suite('P1-6 — 向量权重诚实化', () => {
	test('effectiveVectorWeight：trigram 降权 / model 原权重 / undefined 保守取 trigram', () => {
		assert.strictEqual(effectiveVectorWeight('trigram'), 0.2);
		assert.strictEqual(effectiveVectorWeight('model'), 0.6);
		assert.strictEqual(effectiveVectorWeight(undefined), 0.2);
	});

	test('VectorIndex mode：addText → trigram；addModelVector → model', () => {
		const a = new VectorIndex();
		a.addText('t1', 'trigram payload zebra');
		assert.strictEqual(a.mode, 'trigram');
		const b = new VectorIndex();
		b.addModelVector('m1', new Float32Array(384).fill(0.1));
		assert.strictEqual(b.mode, 'model');
	});

	test('trigram 模式下检索正常（查询向量与库同源）', async () => {
		const vi = new VectorIndex();
		vi.addText('same-1', 'apple banana cherry');
		vi.addText('same-2', 'apple banana cherry');
		vi.addText('diff', ' completely unrelated tokens xyz');
		const results = await vi.search('apple banana cherry', 3);
		assert.ok(results.length > 0);
		assert.strictEqual(results[0].score > results[results.length - 1].score, true, '同文得分应高于异文');
	});
});
