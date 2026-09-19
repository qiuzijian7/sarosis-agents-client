/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `CodebaseGraphStore` 的内存 / 索引不变量单测（2026-09-18）。
 *
 * ## 背景（安装版堆快照 `Heap-20260918T192823`：680MB JS 堆）
 * 代码图谱约占 **172MB**，其中三块是**纯实现开销**（不是图数据本身）：
 *   ① `_edgeDedup` 用 `"sourceId:targetId:type"` 字符串键 ⇒ **每条边新建一个字符串**（约 20MB）；
 *   ② `_nodesByQN/_nodesByFile` 用 `` `${project}:${qn}` `` 复合键 ⇒ **每节点一个常驻字符串**（约 20MB）；
 *   ③ `_nodesByLabel` **只增不删** ⇒ 反复增量索引后旧 id 永久堆积（读侧靠 filter 掩盖）。
 * 本轮改为「按 source 分组的数值键 + 分项目嵌套索引 + 标签索引惰性重建」，本文件把这些
 * 行为不变量钉住 —— 尤其是**删除路径必须同时注销去重键与派生索引**（漏一处就会内存回涨）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphStoreMemory.test.ts
 */

import assert from 'assert';
import { CodebaseGraphStore } from '../../browser/codebaseGraphStore.js';

interface INodeSeed {
	project: string;
	label: string;
	name: string;
	qualifiedName: string;
	filePath?: string;
}

function seed(over: Partial<INodeSeed> = {}): INodeSeed {
	return { project: 'p1', label: 'Function', name: 'f', qualifiedName: 'a::f', filePath: 'src/a.ts', ...over };
}


suite('CodebaseGraphStore — 内存与索引不变量（2026-09-18）', () => {

	test('边去重：同三元组只入一次、类型不同不算重复、删节点时数值键一并注销', () => {
		const s = new CodebaseGraphStore();
		const a = s.upsertNode(seed({ qualifiedName: 'a()', filePath: 'src/a.ts' }));
		const b = s.upsertNode(seed({ qualifiedName: 'b()', filePath: 'src/b.ts' }));

		const e1 = s.insertEdge({ sourceId: a.id, targetId: b.id, type: 'calls', project: 'p1' } as any);
		assert.ok(e1, '首次插入应成功');
		assert.strictEqual(
			s.insertEdge({ sourceId: a.id, targetId: b.id, type: 'calls', project: 'p1' } as any),
			null, '同 (source,target,type) 必须判重',
		);
		assert.ok(
			s.insertEdge({ sourceId: a.id, targetId: b.id, type: 'imports', project: 'p1' } as any),
			'不同 type 不应被判重',
		);
		assert.strictEqual(s.getMemoryStats().dedupEntries, 2, '去重表条目数应恰为 2 条边');
		assert.strictEqual(s.getMemoryStats().dedupSourceSets, 1, '两条边同源 ⇒ 只应有 1 个 source 集合');

		// 删掉 b 所在文件 ⇒ b 的关联边（含去重键）必须一并消失，且空集合要整条回收
		s.deleteNodesByFile('p1', 'src/b.ts');
		const after = s.getMemoryStats();
		assert.strictEqual(after.edges, 0, '删节点后不应残留边');
		assert.strictEqual(after.dedupEntries, 0, '去重键必须随边注销（否则内存只增不减）');
		assert.strictEqual(after.dedupSourceSets, 0, '空 source 集合必须回收');

		// 注销之后同一个三元组应可重新插入（若键没删干净这里会返回 null）
		const b2 = s.upsertNode(seed({ qualifiedName: 'b()', filePath: 'src/b.ts' }));
		assert.ok(
			s.insertEdge({ sourceId: a.id, targetId: b2.id, type: 'calls', project: 'p1' } as any),
			'注销彻底的实现下，重复三元组重插应成功',
		);
	});

	test('派生索引：QN / 文件 / 标签三条查找路径都要命中', () => {
		const s = new CodebaseGraphStore();
		const a = s.upsertNode(seed({ qualifiedName: 'a::f', filePath: 'src/a.ts' }));
		s.upsertNode(seed({ qualifiedName: 'a::g', filePath: 'src/a.ts', label: 'Class' }));

		assert.strictEqual(s.findNodeByQN('p1', 'a::f')?.id, a.id, 'QN 精确查找');
		assert.strictEqual(s.findNodesByFile('p1', 'src/a.ts').length, 2, '文件索引应含 2 个节点');
		assert.strictEqual(s.findNodesByLabel('p1', 'Function').length, 1, '标签索引（惰性重建）应含 1 个');
		assert.strictEqual(s.findNodesByLabel('p1', 'Class').length, 1, '同项目第二个标签');

		// 惰性重建后的健康态：标签索引里的 id 总数 == 节点总数（每个节点恰属一个 label）
		const st = s.getMemoryStats();
		assert.strictEqual(st.labelIds, st.nodes, '标签索引不得含陈旧/重复 id');

		// 项目名/符号名里含 ':' 时，旧实现（indexOf(':') 反解复合键）会错；嵌套索引应正确
		const colons = s.upsertNode(seed({ project: 'ns:sub', qualifiedName: 'A:B::f', filePath: 'src/c.ts' }));
		assert.strictEqual(s.findNodeByQN('ns:sub', 'A:B::f')?.id, colons.id, '项目名/符号名含 ":" 也要能命中');
		assert.ok(s.findNodeByQNFuzzy('ns:sub', 'A:B::f'), '模糊查找同样不应被 ":" 误导');
	});

	test('filePath 迁移：更新后旧文件查不到、新文件查得到（旧实现更新路径不动 file 索引）', () => {
		const s = new CodebaseGraphStore();
		const a = s.upsertNode(seed({ qualifiedName: 'a::f', filePath: 'src/old.ts' }));
		assert.strictEqual(s.findNodesByFile('p1', 'src/old.ts').length, 1);

		s.upsertNode(seed({ qualifiedName: 'a::f', filePath: 'src/new.ts' }));
		assert.strictEqual(s.findNodesByFile('p1', 'src/old.ts').length, 0, '旧文件索引必须摘掉该 id');
		assert.strictEqual(s.findNodesByFile('p1', 'src/new.ts').length, 1, '新文件索引必须登记该 id');
		assert.strictEqual(s.findNodeByQN('p1', 'a::f')?.id, a.id, 'QN 索引不应因迁移而变化');
	});

	test('反复增量索引同一文件：标签索引不得堆积陈旧 id（旧实现只增不删）', () => {
		const s = new CodebaseGraphStore();
		for (let round = 0; round < 5; round++) {
			s.deleteNodesByFile('p1', 'src/a.ts');
			s.upsertNode(seed({ qualifiedName: 'a::f', filePath: 'src/a.ts' }));
			s.upsertNode(seed({ qualifiedName: 'a::g', filePath: 'src/a.ts', label: 'Class' }));
		}
		const list = s.findNodesByLabel('p1', 'Function');
		assert.strictEqual(list.length, 1, '同一文件重索引 5 轮后，Function 标签下仍应只有 1 个节点');
		const st = s.getMemoryStats();
		assert.strictEqual(st.nodes, 2, '节点数应保持 2');
		assert.strictEqual(st.labelIds, 2, '标签索引 id 总数必须等于节点数（不得堆积）');
		assert.strictEqual(s.findNodesByFile('p1', 'src/a.ts').length, 2, '文件索引同样不得堆积');
	});

	test('BM25：重建后能命中，节点删除后不再命中（且统计数字自洽）', async () => {
		const s = new CodebaseGraphStore();
		s.setDeferBM25(true);
		const a = s.upsertNode(seed({ qualifiedName: 'alpha::findUserInfo', name: 'findUserInfo', filePath: 'src/a.ts' }));
		s.upsertNode(seed({ qualifiedName: 'beta::otherThing', name: 'otherThing', filePath: 'src/b.ts' }));
		s.setDeferBM25(false);
		await s.rebuildBM25(undefined, true);

		const hits = s.ftsSearch('findUserInfo', 10);
		assert.ok(hits.has(a.id), 'BM25 应命中 findUserInfo');
		const st = s.getMemoryStats();
		assert.ok(st.terms > 0, 'terms 应 > 0');
		assert.ok(st.postings > 0, 'postings 应 > 0');

		// 全量重建后删掉该文件 ⇒ 再次全量重建应不再命中（且倒排规模下降）
		s.deleteNodesByFile('p1', 'src/a.ts');
		await s.rebuildBM25(undefined, true);
		assert.strictEqual(s.ftsSearch('findUserInfo', 10).size, 0, '删除后不应再命中');
		assert.ok(s.getMemoryStats().postings < st.postings, 'postings 应随文档删除而下降');
	});

	test('fromJSONAsync 恢复：索引与去重表都要重建（重复边只留一条）', async () => {
		const s = new CodebaseGraphStore();
		const nodeA = { id: 1, project: 'p1', label: 'Function', name: 'f', qualifiedName: 'a::f', filePath: 'src/a.ts', inDegree: 0, outDegree: 2 };
		const nodeB = { id: 2, project: 'p1', label: 'Function', name: 'g', qualifiedName: 'a::g', filePath: 'src/a.ts', inDegree: 2, outDegree: 0 };
		const edge = { id: 1, sourceId: 1, targetId: 2, type: 'calls', project: 'p1' };
		await s.fromJSONAsync({ nodes: [nodeA, nodeB], edges: [edge, { ...edge, id: 2 }] });

		const integrity = s.checkIntegrity();
		assert.deepStrictEqual(integrity.errors, [], '完整性自检不应报错');
		assert.ok(integrity.ok, 'checkIntegrity().ok 应为 true');
		assert.strictEqual(s.findNodeByQN('p1', 'a::f')?.id, 1, 'QN 索引应已恢复');
		assert.strictEqual(s.findNodesByFile('p1', 'src/a.ts').length, 2, '文件索引应已恢复');
		assert.strictEqual(s.findNodesByLabel('p1', 'Function').length, 2, '标签索引（惰性）应可重建');
		const st = s.getMemoryStats();
		assert.strictEqual(st.edges, 2, '两条边 id 不同 ⇒ 都入主存储');
		assert.strictEqual(st.dedupEntries, 1, '但 (source,target,type) 相同 ⇒ 去重表只留 1 条');
	});
});
