/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbVaultRecallTools.test.ts — KB agent 工具（kb_search / kb_suggest_links / kb_topic_overviews）测试。
 *
 *  覆盖：
 *   1. wikilinkOf — 扩展名剥离
 *   2. kb_search — 空 query / 无 vault 引导 / fulltext 不调向量 / hybrid RRF 融合排序与去重 /
 *      引用回链与目录摘要区 / semantic 未构建引导 / 空结果引导
 *   3. kb_suggest_links — 无 vault / 索引未构建 / 正常建议输出
 *   4. kb_topic_overviews — 无 vault / 空 / 正常列表
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/providers/tool/kbVaultRecallTools.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { registerKbVaultRecallTools, wikilinkOf } from './kbVaultRecallTools.js';

interface IKbHit { uri: string; title: string; snippet: string; score: number }

/** 捕获注册的工具 handler。 */
function createCtx(kernelOver: Record<string, unknown> = {}) {
	const registrations = new Map<string, { definition: any; handler: (args: any) => Promise<any> }>();
	const ctx = {
		register(reg: any) { registrations.set(reg.definition.name, reg); return { dispose() {} }; },
		kernelService: {
			hasActiveVault: () => true,
			searchFulltext: async (_q: string, _limit?: number): Promise<IKbHit[]> => [],
			searchVector: async (_q: string, _topK?: number): Promise<any[]> => [],
			getVectorStatus: () => ({ built: true, tag: 'fake/model@64', dimensions: 64, chunkCount: 10 }),
			getTopicOverviewsForDocs: async (_ids: string[]) => [],
			readTopicOverviews: async () => [],
			suggestLinks: async (_docId: string, _topK?: number, _minScore?: number) => [],
			...kernelOver,
		},
		logService: { warn() {} },
	};
	registerKbVaultRecallTools(ctx as any);
	return { registrations, kernelService: ctx.kernelService };
}

function textOf(result: any): string {
	const content = Array.isArray(result) ? result : result?.content;
	return (content ?? []).map((c: any) => c.text ?? '').join('\n');
}

suite('kbVaultRecallTools', () => {

	test('wikilinkOf：剥离 md/markdown 扩展名，其他不动', () => {
		assert.strictEqual(wikilinkOf('GC机制.md'), '[[GC机制]]');
		assert.strictEqual(wikilinkOf('note.markdown'), '[[note]]');
		assert.strictEqual(wikilinkOf('无扩展'), '[[无扩展]]');
	});

	suite('kb_search', () => {
		test('空 query 返回提示', async () => {
			const { registrations } = createCtx();
			const r = await registrations.get('kb_search')!.handler({ query: '  ' });
			assert.ok(textOf(r).includes('非空'));
		});

		test('无 vault 时返回引导文本（不报错）', async () => {
			const { registrations } = createCtx({ hasActiveVault: () => false });
			const r = await registrations.get('kb_search')!.handler({ query: 'x' });
			assert.ok(textOf(r).includes('没有已打开的知识库'));
		});

		test('fulltext 模式不调用向量通道', async () => {
			let vectorCalled = false;
			const { registrations } = createCtx({
				searchFulltext: async () => [{ uri: 'file:///v/库/a.md', title: 'a.md', snippet: '片段', score: 3 }],
				searchVector: async () => { vectorCalled = true; return []; },
			});
			const r = await registrations.get('kb_search')!.handler({ query: 'a', mode: 'fulltext' });
			assert.strictEqual(vectorCalled, false);
			assert.strictEqual(r.details.count, 1);
		});

		test('hybrid：双通道 RRF 融合——同文档两通道命中应排第一且不重复', async () => {
			const { registrations } = createCtx({
				// fulltext: A(rank0) B(rank1)；semantic: B(rank0) C(rank1)
				searchFulltext: async () => [
					{ uri: 'file:///v/库/A.md', title: 'A.md', snippet: 'fa', score: 9 },
					{ uri: 'file:///v/库/B.md', title: 'B.md', snippet: 'fb', score: 5 },
				],
				searchVector: async () => [
					{ docId: 'file:///v/库/B.md', docName: 'B.md', text: 'sb 语义片段更长更完整', score: 0.9 },
					{ docId: 'file:///v/库/C.md', docName: 'C.md', text: 'sc', score: 0.8 },
				],
				getTopicOverviewsForDocs: async () => [{ dir: '概念', summary: '概念目录摘要' }],
			});
			const r = await registrations.get('kb_search')!.handler({ query: 'q', mode: 'hybrid' });
			const hits = r.details.hits;
			assert.strictEqual(hits.length, 3, 'A/B/C 去重后三条');
			assert.strictEqual(hits[0].uri, 'file:///v/库/B.md', 'B 双通道命中 ⇒ RRF 最高');
			// 语义片段优先展示
			assert.ok(hits[0].snippet.includes('语义片段'));
			const text = textOf(r);
			assert.ok(text.includes('[[B]]'), '引用回链（去扩展名）');
			assert.ok(text.includes('相关目录摘要'), '附目录摘要区');
			assert.ok(text.includes('概念目录摘要'));
			assert.deepStrictEqual(r.details.topicOverviews, [{ dir: '概念', summary: '概念目录摘要' }]);
		});

		test('semantic 模式索引未构建时返回引导', async () => {
			const { registrations } = createCtx({ getVectorStatus: () => ({ built: false }) });
			const r = await registrations.get('kb_search')!.handler({ query: 'q', mode: 'semantic' });
			assert.ok(textOf(r).includes('语义索引尚未构建'));
		});

		test('空结果返回可操作引导', async () => {
			const { registrations } = createCtx();
			const r = await registrations.get('kb_search')!.handler({ query: '不存在的词' });
			assert.ok(textOf(r).includes('未找到'));
			assert.ok(textOf(r).includes('search_files'), '应引导到代码检索工具');
		});

		test('目录摘要读取失败不影响检索主路径', async () => {
			const { registrations } = createCtx({
				searchFulltext: async () => [{ uri: 'file:///v/库/a.md', title: 'a.md', snippet: 's', score: 1 }],
				getTopicOverviewsForDocs: async () => { throw new Error('disk boom'); },
			});
			const r = await registrations.get('kb_search')!.handler({ query: 'a' });
			assert.strictEqual(r.details.count, 1, '检索结果不受影响');
		});
	});

	suite('kb_suggest_links', () => {
		test('无 vault 返回引导', async () => {
			const { registrations } = createCtx({ hasActiveVault: () => false });
			const r = await registrations.get('kb_suggest_links')!.handler({ docUri: 'file:///v/库/a.md' });
			assert.ok(textOf(r).includes('没有已打开的知识库'));
		});

		test('向量索引未构建返回引导', async () => {
			const { registrations } = createCtx({ getVectorStatus: () => ({ built: false }) });
			const r = await registrations.get('kb_suggest_links')!.handler({ docUri: 'file:///v/库/a.md' });
			assert.ok(textOf(r).includes('向量索引尚未构建'));
		});

		test('正常建议：含 [[链接]] 与 uri，空结果有提示', async () => {
			const { registrations } = createCtx({
				suggestLinks: async () => [
					{ docId: 'file:///v/库/b.md', docName: 'b.md', score: 0.86, text: '相关片段' },
				],
			});
			const r = await registrations.get('kb_suggest_links')!.handler({ docUri: 'file:///v/库/a.md' });
			const text = textOf(r);
			assert.ok(text.includes('[[b]]'));
			assert.ok(text.includes('uri: file:///v/库/b.md'));
			assert.strictEqual(r.details.count, 1);

			const empty = await createCtx().registrations.get('kb_suggest_links')!.handler({ docUri: 'file:///v/库/a.md' });
			assert.ok(textOf(empty).includes('未找到'));
		});
	});

	suite('kb_topic_overviews', () => {
		test('无 vault / 空 / 正常列表', async () => {
			const noVault = createCtx({ hasActiveVault: () => false });
			assert.ok(textOf(await noVault.registrations.get('kb_topic_overviews')!.handler({})).includes('没有已打开的知识库'));

			const emptyCtx = createCtx();
			assert.ok(textOf(await emptyCtx.registrations.get('kb_topic_overviews')!.handler({})).includes('暂无目录摘要'));

			const withData = createCtx({
				readTopicOverviews: async () => [
					{ dir: '概念', summary: 'GC 与内存管理相关概念。' },
					{ dir: '会议', summary: '周会纪要。' },
				],
			});
			const r = await withData.registrations.get('kb_topic_overviews')!.handler({});
			const text = textOf(r);
			assert.ok(text.includes('## 概念'));
			assert.ok(text.includes('GC 与内存管理相关概念。'));
			assert.strictEqual(r.details.count, 2);
		});
	});
});
