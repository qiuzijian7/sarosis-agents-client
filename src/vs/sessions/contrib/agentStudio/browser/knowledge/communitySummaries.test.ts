/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  communitySummaries.test.ts — 社区语义摘要模块单测。
 *
 *  覆盖：
 *   1. communityFingerprint — 归一 / 排序 / 稳定性
 *   2. buildCommunitySummaryPrompt — 格式契约与成员注入
 *   3. parseCommunitySummaries — 标准分段 / 缺主题容错 / 整段兜底 / 空段跳过
 *   4. summarizeCommunities — 无 chatModel 短路 / 规模门槛 / 缓存命中不调 LLM /
 *      缺失合并单次调用并写缓存 / LLM 失败不抛且回退
 *
 *  运行方式（通用 runner，tdd UI）：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/knowledge/communitySummaries.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import {
	communityFingerprint,
	buildCommunitySummaryPrompt,
	parseCommunitySummaries,
	summarizeCommunities,
	readInsightsCache,
	KB_INSIGHTS_CACHE_FILE,
} from './communitySummaries.js';
import type { IChatModel } from './llm.js';

/** 内存 mock IFileService（本模块只用到 readFile / writeFile）。 */
function createMockFileService(initial?: Record<string, string>) {
	const files = new Map<string, string>(Object.entries(initial ?? {}));
	const service = {
		async readFile(uri: URI): Promise<{ value: { toString(): string } }> {
			const key = uri.toString();
			if (!files.has(key)) { throw new Error('file not found: ' + key); }
			return { value: { toString: () => files.get(key)! } };
		},
		async writeFile(uri: URI, value: { toString(): string }): Promise<void> {
			files.set(uri.toString(), value.toString());
		},
	};
	return { service: service as any, files };
}

/** 构造记录调用次数的 mock chatModel。 */
function trackedModel(complete: () => Promise<string>): { model: IChatModel; stats: { calls: number } } {
	const stats = { calls: 0 };
	const model: IChatModel = {
		async complete() { stats.calls++; return complete(); },
		async extract<T>(): Promise<T> { throw new Error('not used'); },
	};
	return { model, stats };
}

suite('communitySummaries', () => {

	suite('communityFingerprint', () => {
		test('归一（trim+小写）且排序稳定', () => {
			const a = communityFingerprint(['  Beta ', 'alpha', 'Gamma']);
			const b = communityFingerprint(['gamma', 'ALPHA', 'beta']);
			assert.strictEqual(a, b);
			assert.strictEqual(a, 'alpha|beta|gamma');
		});
	});

	suite('buildCommunitySummaryPrompt', () => {
		test('包含格式契约与社区成员', () => {
			const p = buildCommunitySummaryPrompt([{ id: 'c3', members: ['笔记A', '笔记B'] }]);
			assert.ok(p.includes('### 社区 <id>'));
			assert.ok(p.includes('### 社区 c3'));
			assert.ok(p.includes('- 笔记A'));
		});
	});

	suite('parseCommunitySummaries', () => {
		test('标准格式分段解析', () => {
			const text = [
				'### 社区 c0',
				'主题：垃圾回收',
				'摘要：该社区讨论 JVM 与 V8 的 GC 机制。',
				'',
				'### 社区 c2',
				'主题：前端构建',
				'摘要：围绕 esbuild 与 transpile 的性能优化。',
			].join('\n');
			const m = parseCommunitySummaries(text);
			assert.strictEqual(m.size, 2);
			assert.strictEqual(m.get('c0')?.topic, '垃圾回收');
			assert.ok(m.get('c0')?.summary.includes('GC'));
			assert.strictEqual(m.get('c2')?.topic, '前端构建');
		});

		test('缺「主题」字段时 topic 为空串', () => {
			const m = parseCommunitySummaries('### 社区 c1\n摘要：只有摘要。');
			assert.strictEqual(m.get('c1')?.topic, '');
			assert.strictEqual(m.get('c1')?.summary, '只有摘要。');
		});

		test('段内无可解析字段时整段作 summary（兜底）', () => {
			const m = parseCommunitySummaries('### 社区 c4\n这是一段没有字段标记的描述。');
			assert.strictEqual(m.get('c4')?.summary, '这是一段没有字段标记的描述。');
		});

		test('空体段落被跳过', () => {
			const m = parseCommunitySummaries('### 社区 c5\n\n### 社区 c6\n主题：x\n摘要：y');
			assert.ok(!m.has('c5'));
			assert.ok(m.has('c6'));
		});
	});

	suite('summarizeCommunities', () => {
		const communities = [
			{ id: 'c0', members: ['Alpha', 'Beta', 'Gamma'] },
			{ id: 'c1', members: ['Delta', 'Epsilon'] },
		];

		test('无 chatModel 时短路返回空', async () => {
			const { service } = createMockFileService();
			const r = await summarizeCommunities(service, URI.file('/vault/lib'), communities, undefined);
			assert.strictEqual(r.size, 0);
		});

		test('单成员社区被过滤（成本门槛），不消耗 LLM', async () => {
			const { model, stats } = trackedModel(async () => '### 社区 c9\n主题：t\n摘要：s');
			const { service } = createMockFileService();
			const r = await summarizeCommunities(service, URI.file('/vault/lib'), [{ id: 'c9', members: ['Only'] }], model);
			assert.strictEqual(r.size, 0);
			assert.strictEqual(stats.calls, 0);
		});

		test('缓存命中时不调 LLM', async () => {
			const dir = URI.file('/vault/lib');
			const fp = communityFingerprint(communities[0].members);
			const cache: Record<string, { topic: string; summary: string }> = {};
			cache[fp] = { topic: '已缓存', summary: '缓存摘要' };
			const { service } = createMockFileService({
				[URI.joinPath(dir, KB_INSIGHTS_CACHE_FILE).toString()]: JSON.stringify(cache),
			});
			const { model, stats } = trackedModel(async () => { throw new Error('should not be called'); });
			const r = await summarizeCommunities(service, dir, [communities[0]], model);
			assert.strictEqual(stats.calls, 0);
			assert.strictEqual(r.get('c0')?.summary, '缓存摘要');
		});

		test('缺失社区一次 LLM 调用补齐并写缓存', async () => {
			const dir = URI.file('/vault/lib');
			const { service, files } = createMockFileService();
			const { model, stats } = trackedModel(async () =>
				'### 社区 c0\n主题：主题甲\n摘要：摘要甲\n### 社区 c1\n主题：主题乙\n摘要：摘要乙'
			);
			const r = await summarizeCommunities(service, dir, communities, model);
			assert.strictEqual(stats.calls, 1, '所有缺失社区合并为单次调用');
			assert.strictEqual(r.get('c0')?.topic, '主题甲');
			assert.strictEqual(r.get('c1')?.summary, '摘要乙');
			const cacheKey = URI.joinPath(dir, KB_INSIGHTS_CACHE_FILE).toString();
			assert.ok(files.has(cacheKey), '缓存文件已写入');
			const cache = await readInsightsCache(service, dir);
			assert.strictEqual(cache[communityFingerprint(communities[1].members)].topic, '主题乙');
		});

		test('LLM 失败时不抛、回退到缓存部分', async () => {
			const dir = URI.file('/vault/lib');
			const { service } = createMockFileService();
			const { model } = trackedModel(async () => { throw new Error('LLM down'); });
			const r = await summarizeCommunities(service, dir, communities, model);
			assert.strictEqual(r.size, 0, '无缓存时失败 ⇒ 空结果（调用方回退纯成员列表）');
		});
	});
});
