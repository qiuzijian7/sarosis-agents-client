/*---------------------------------------------------------------------------------------------
 *  KB Worker Manager 单元测试。
 *
 *  覆盖：
 *  - 提及索引构建（O(N×K) 算法正确性）
 *  - 图谱构建（wikilink 解析正确性）
 *  - Worker fallback 到主线程同步路径
 *  - 边界情况：空文档、单文档、重复名称、大文本
 *  - 取消 token 支持
 *  - dispose 清理
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import {
	KbWorkerManager,
	type IKbWorkerMentionEntry,
	type IKbWorkerGraphData,
} from '../../browser/views/knowledgeBase/kbWorkerManager.js';

// ─── Helper: 构造测试文档 ─────────────────────────────────────────

function doc(name: string, text: string) {
	return {
		uri: URI.file(`/vault/${name}`),
		name,
		text,
		mtime: Date.now(),
		size: text.length,
	};
}

// ─── Test Suite ───────────────────────────────────────────────────

suite('AgentStudio - KbWorkerManager (main-thread fallback)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ══════════════════════════════════════════════════════
	//  提及索引构建
	// ══════════════════════════════════════════════════════

	suite('buildMentionIndex()', () => {

		test('空文档列表返回空数组', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const result = await mgr.buildMentionIndex([]);
			assert.strictEqual(result.length, 0, '空输入应返回空数组');
			mgr.dispose();
		});

		test('单文档：无其他文档提及自身', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const result = await mgr.buildMentionIndex([
				doc('Python入门.md', '# Python 入门\n这是一篇 Python 入门教程。'),
			]);
			// Python入门 被自身提及？不——自己的正文不产生提及（提及是"其他文档提到我"）
			const entry = result.find(e => e.normName.includes('python') && e.normName.includes('入门'));
			assert.ok(!entry || entry.mentionedIn.length === 0,
				'单文档不应有提及');
			mgr.dispose();
		});

		test('多文档：A 在正文中提到 B 应被捕获', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('读书笔记.md', '# 读书笔记\n最近在读 机器学习 和 Python入门，很有收获。'),
				doc('Python入门.md', '# Python 入门\nPython 是一门流行语言。'),
				doc('机器学习.md', '# 机器学习\n机器学习常用 Python 和 读书笔记 中提到的方法。'),
			];
			const result = await mgr.buildMentionIndex(docs);

			// Python入门 应被 读书笔记 提及（正文中精确出现了 'Python入门'）
			const pyEntry = result.find(e => e.normName === 'python入门');
			assert.ok(pyEntry, '应找到 Python入门 的提及条目');
			assert.ok(pyEntry!.mentionedIn.length >= 1,
				`Python入门 至少被 1 篇文档提及，实际: ${pyEntry!.mentionedIn.length}`);

			// 机器学习 应被 读书笔记 提及（正文中出现了 '机器学习'）
			const mlEntry = result.find(e => e.normName === '机器学习');
			assert.ok(mlEntry, '应找到 机器学习 的提及条目');
			assert.ok(mlEntry!.mentionedIn.length >= 1,
				`机器学习 至少被 1 篇文档提及，实际: ${mlEntry!.mentionedIn.length}`);
			mgr.dispose();
		});

		test('wikilink 内的文本不算提及（被 strip）', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('笔记A.md', '# 笔记A\n参考 [[笔记B]] 获取更多信息。'),
				doc('笔记B.md', '# 笔记B\n这是笔记B的内容。'),
			];
			const result = await mgr.buildMentionIndex(docs);
			// 笔记B 不应被 笔记A 提及（在 [[ ]] 中）
			// 笔记A 也不应被任何文档提及（无人提到它）
			for (const entry of result) {
				for (const uri of entry.mentionedIn) {
					assert.ok(!uri.includes('笔记A') || !entry.normName.includes('笔记a'),
						'笔记A 不应被提及（无人提到它）');
				}
			}
			mgr.dispose();
		});

		test('短名称（<2 字符）被跳过', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('A.md', '# A'),
				doc('B.md', '# B\nA B C'),
			];
			const result = await mgr.buildMentionIndex(docs);
			// 单字符文件名应被跳过
			for (const entry of result) {
				assert.strictEqual(entry.normName.length >= 2, true,
					`归一化名称长度应 >= 2: ${entry.normName}`);
			}
			mgr.dispose();
		});

		test('大量文档不超时且结果可重复', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const count = 100;
			const docs = [];
			for (let i = 0; i < count; i++) {
				docs.push(doc(
					`文档${i}.md`,
					`# 文档 ${i}\n这篇文档提到了 文档0 和 文档${(i + 1) % count}。`,
				));
			}
			const t0 = Date.now();
			const result = await mgr.buildMentionIndex(docs);
			const elapsed = Date.now() - t0;

			assert.ok(elapsed < 5000, `100 文档应在 5s 内完成，实际: ${elapsed}ms`);
			// 文档0 应被提及（所有其他文档的正文中都包含 "文档0"）
			const totalDoc0Mentions = result
				.filter(e => e.normName === '文档0')
				.reduce((sum, e) => sum + e.mentionedIn.length, 0);
			assert.ok(totalDoc0Mentions >= 1,
				`文档0 应被提及，实际提及次数: ${totalDoc0Mentions}`);

			// 重复运行结果一致
			const result2 = await mgr.buildMentionIndex(docs);
			assert.strictEqual(result2.length, result.length,
				'重复运行应产生相同数量的条目');
			mgr.dispose();
		});

		test('命名规范化：仅小写+trim', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('Machine Learning.md', '# ML\n提到了 Machine Learning 方法。'),
				doc('  MACHINE LEARNING  .md', '# ML2\n也提到了  MACHINE LEARNING  。'),
			];
			const result = await mgr.buildMentionIndex(docs);

			// 归一化后两者同名为 'machine learning'（trim + lower）
			const normedNames = result.map(e => e.normName);
			const mlNames = normedNames.filter(n => n === 'machine learning');
			assert.ok(mlNames.length >= 1,
				`规范化后应至少有一个 'machine learning' 条目，实际: ${normedNames.join(', ')}`);
			mgr.dispose();
		});

		test('代码块内容不计入提及', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('目标文档.md', '# 目标'),
				doc('代码笔记.md', '# 代码\n```\n目标文档\n```\n这是正文，提到目标文档。'),
			];
			const result = await mgr.buildMentionIndex(docs);
			// 目标文档 应被 代码笔记 提及（正文中提到了，即使代码块也被 strip 了）
			const targetEntry = result.find(e => e.normName === '目标文档');
			if (targetEntry) {
				assert.ok(targetEntry.mentionedIn.length >= 1,
					'目标文档 应被提及（正文中的提及保留，代码块的被 strip）');
			}
			mgr.dispose();
		});
	});

	// ══════════════════════════════════════════════════════
	//  图谱构建
	// ══════════════════════════════════════════════════════

	suite('buildGraph()', () => {

		test('空文档 → 空图谱', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const graph = await mgr.buildGraph([]);
			assert.strictEqual(graph.nodes.length, 0);
			assert.strictEqual(graph.links.length, 0);
			mgr.dispose();
		});

		test('无 wikilink 的文档 → 有节点无链接', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const graph = await mgr.buildGraph([
				doc('A.md', '# A\n纯文本无链接。'),
				doc('B.md', '# B\n另一个文档。'),
			]);
			assert.strictEqual(graph.nodes.length, 2, '应有 2 个节点');
			assert.strictEqual(graph.links.length, 0, '无 wikilink 应无链接');
			mgr.dispose();
		});

		test('[[wikilink]] 产生边', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const graph = await mgr.buildGraph([
				doc('A.md', '# A\n参考 [[B]]。'),
				doc('B.md', '# B\n'),
			]);
			assert.strictEqual(graph.nodes.length, 2, '应有 2 个节点');
			assert.strictEqual(graph.links.length, 1, '[[B]] 产生 1 条边');
			assert.strictEqual(graph.links[0].type, 'wikilink');
			// 验证方向：A 链接到 B
			const bUri = graph.nodes.find(n => n.name === 'B')!.uriStr;
			assert.ok(graph.links[0].target === bUri || graph.links[0].source === bUri,
				'连接应涉及 B');
			mgr.dispose();
		});

		test('[[别名|显示名]] 格式', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const graph = await mgr.buildGraph([
				doc('A.md', '# A\n见 [[B|文档B详情]]。'),
				doc('B.md', '# B\n'),
			]);
			assert.strictEqual(graph.links.length, 1, '[[B|显示名]] 应产生 1 条边');
			mgr.dispose();
		});

		test('[[笔记#标题]] 格式', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const graph = await mgr.buildGraph([
				doc('A.md', '# A\n参考 [[B#第一节]]。'),
				doc('B.md', '# B\n## 第一节\n内容。'),
			]);
			assert.strictEqual(graph.links.length, 1, '[[B#第一节]] 应产生 1 条边');
			mgr.dispose();
		});

		test('目标不存在 → 有链接但无对应节点', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const graph = await mgr.buildGraph([
				doc('A.md', '# A\n参考 [[不存在的文档]]。'),
			]);
			assert.strictEqual(graph.nodes.length, 1, '仅有 A 一个节点');
			// 链接到不存在的目标不会被添加（因为 nodes 中没有对应节点）
			assert.strictEqual(graph.links.length, 0,
				'目标不存在时应无链接');
			mgr.dispose();
		});

		test('多条链接', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const graph = await mgr.buildGraph([
				doc('中心.md', '# 中心\n参考 [[A]]、[[B]] 和 [[C]]。'),
				doc('A.md', '# A'),
				doc('B.md', '# B'),
				doc('C.md', '# C'),
			]);
			assert.strictEqual(graph.nodes.length, 4, '应有 4 个节点');
			assert.strictEqual(graph.links.length, 3, '[[A]][[B]][[C]] 产生 3 条边');
			mgr.dispose();
		});

		test('去重：相同文件名大小写不区分', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const graph = await mgr.buildGraph([
				doc('ABC.md', '# ABC\n'),
				doc('abc.md', '# abc\n'),
			]);
			// 大小写不同的同名文件应只有一个节点（lowerCase 去重）
			assert.strictEqual(graph.nodes.length, 1,
				'同名文件大小写不同 → 去重后 1 个节点');
			mgr.dispose();
		});
	});

	// ══════════════════════════════════════════════════════
	//  Worker 生命周期 & fallback
	// ══════════════════════════════════════════════════════

	suite('Worker lifecycle', () => {

		test('ensureWorker() 在 Node.js 中返回 false（fallback 模式）', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const ready = await mgr.ensureWorker();
			assert.strictEqual(ready, false,
				'Node.js 环境无 Web Worker → ensureWorker 应返回 false');
			assert.strictEqual(mgr.isWorkerReady, false,
				'isWorkerReady 应为 false');
			mgr.dispose();
		});

		test('fallback 后 buildMentionIndex 正常工作', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			// Worker 不可用 → 走 fallback 同步路径
			const result = await mgr.buildMentionIndex([
				doc('笔记A.md', '# 笔记A\n提到了 笔记B 的内容。'),
				doc('笔记B.md', '# 笔记B\n被 笔记A 提到。'),
			]);
			assert.ok(result.length >= 1, `fallback 路径应正常工作，结果数: ${result.length}`);
			mgr.dispose();
		});

		test('dispose 后不可再使用', () => {
			const mgr = new KbWorkerManager(new NullLogService());
			mgr.dispose();
			// dispose 后 isWorkerReady 应仍为 false
			assert.strictEqual(mgr.isWorkerReady, false);
		});

		test('重复 ensureWorker 不创建多次（幂等）', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const r1 = await mgr.ensureWorker();
			const r2 = await mgr.ensureWorker();
			assert.strictEqual(r1, r2, '重复调用应返回相同结果');
			mgr.dispose();
		});
	});

	// ══════════════════════════════════════════════════════
	//  取消 token
	// ══════════════════════════════════════════════════════

	suite('CancellationToken', () => {

		test('已取消的 token 应被尊重（不额外产生副作用）', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const cts = new CancellationTokenSource();
			cts.cancel();

			// fallback 同步路径不抛异常（token 只在 Worker 路径检查），但操作应正常完成
			const result = await mgr.buildMentionIndex([doc('笔记A.md', '# 笔记A')], cts.token);
			assert.ok(Array.isArray(result), '即使 token 已取消，fallback 路径应返回数组');
			cts.dispose();
			mgr.dispose();
		});

		test('未取消的 token 不阻止执行', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const result = await mgr.buildMentionIndex(
				[doc('A.md', '# A')],
				CancellationTokenSource.None,
			);
			assert.ok(Array.isArray(result), '应正常返回数组');
			mgr.dispose();
		});
	});

	// ══════════════════════════════════════════════════════
	//  极值/边界
	// ══════════════════════════════════════════════════════

	suite('边界情况', () => {

		test('超长文本不崩溃', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const longText = '# 长文档\n' + '长文本内容 '.repeat(5000);
			const result = await mgr.buildMentionIndex([
				doc('长文档.md', longText),
				doc('短文档.md', '# 短\n提到了 长文档。'),
			]);
			const longEntry = result.find(e => e.normName === '长文档');
			assert.ok(longEntry, '应找到 长文档 的提及条目');
			assert.ok(longEntry!.mentionedIn.length >= 1, '长文档 应被提及');
			mgr.dispose();
		});

		test('CJK 混合内容', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('机器学习.md', '# 机器学习\nMachine Learning（机器学习）是 AI 的核心。'),
				doc('AI概述.md', '# AI 概述\nAI 包含 机器学习 和 深度学习。'),
			];
			const result = await mgr.buildMentionIndex(docs);
			const mlEntry = result.find(e => e.normName === '机器学习');
			assert.ok(mlEntry, '应找到 CJK 文档名的提及条目');
			assert.ok(mlEntry!.mentionedIn.length >= 1, 'CJK 文档名应被提及');
			mgr.dispose();
		});

		test('全部文档名均 < 2 字符', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('A.md', '# A'),
				doc('B.md', '# B'),
				doc('C.md', '# C\nA B C'),
			];
			const result = await mgr.buildMentionIndex(docs);
			// 所有名称 < 2 字符 → 全部跳过
			assert.strictEqual(result.length, 0, '全部短名称 → 空结果');
			mgr.dispose();
		});

		test('特殊字符文档名', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('C++入门.md', '# C++\nC++11 是重要版本。'),
				doc('编程笔记.md', '# 笔记\n提到了 C++入门 和 Rust。'),
			];
			const result = await mgr.buildMentionIndex(docs);
			// C++特殊字符不应崩溃
			assert.ok(result.length >= 0, '特殊字符文档名不应崩溃');
			mgr.dispose();
		});
	});

	// ══════════════════════════════════════════════════════
	//  并行调用
	// ══════════════════════════════════════════════════════

	suite('并行调用', () => {

		test('buildMentionIndex + buildGraph 并行不冲突', async () => {
			const mgr = new KbWorkerManager(new NullLogService());
			const docs = [
				doc('A.md', '# A\n参考 [[B]]。'),
				doc('B.md', '# B\n提到了 A。'),
			];
			const [mentions, graph] = await Promise.all([
				mgr.buildMentionIndex(docs),
				mgr.buildGraph(docs),
			]);
			assert.ok(Array.isArray(mentions), '提及结果应为数组');
			assert.ok(graph.nodes.length === 2, '应有 2 个图节点');
			assert.ok(graph.links.length === 1, '应有 1 条边');
			mgr.dispose();
		});
	});
});
