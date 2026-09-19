/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  topicOverviews.test.ts — 目录摘要中间层单测（tdd 风格，通用 runner 直跑）。
 *
 *  覆盖：
 *   1. fileStamp / topicChangeRatio — 印章与变更比例
 *   2. parseTopicOverviews — 分段解析与容错
 *   3. refreshTopicOverviews — 首次生成 / 无变更不重算 / <10% 不重算 / ≥10% 重算 /
 *      LLM 失败不抛 / 无 chatModel 短路
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/knowledge/topicOverviews.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import {
	fileStamp,
	topicChangeRatio,
	parseTopicOverviews,
	refreshTopicOverviews,
	TOPIC_OVERVIEW_FILE,
	TOPIC_OVERVIEW_CACHE_FILE,
} from './topicOverviews.js';
import type { IChatModel } from './llm.js';

/** 树形内存 mock IFileService（支持目录 children / readFile / writeFile）。 */
function createTreeFileService() {
	// path → { content, mtime, size }；目录由路径前缀推导
	const files = new Map<string, { content: string; mtime: number; size: number }>();
	const nameOf = (p: string) => p.split('/').pop()!;
	const service = {
		async resolve(uri: URI): Promise<any> {
			const key = uri.path;
			const file = files.get(key);
			if (file) {
				return { resource: uri, name: nameOf(key), isDirectory: false, mtime: file.mtime, size: file.size, children: undefined };
			}
			// 目录：收集直接子级（文件 + 子目录）
			const prefix = key.endsWith('/') ? key : key + '/';
			const seenDirs = new Set<string>();
			const children: any[] = [];
			for (const [p, f] of files) {
				if (!p.startsWith(prefix)) { continue; }
				const rest = p.slice(prefix.length);
				const seg = rest.split('/')[0];
				if (rest.includes('/')) {
					if (!seenDirs.has(seg)) {
						seenDirs.add(seg);
						children.push({ resource: URI.file(prefix + seg), name: seg, isDirectory: true });
					}
				} else {
					children.push({ resource: URI.file(p), name: seg, isDirectory: false, mtime: f.mtime, size: f.size });
				}
			}
			return { resource: uri, name: nameOf(key), isDirectory: true, mtime: 0, size: 0, children };
		},
		async readFile(uri: URI): Promise<{ value: { toString(): string } }> {
			const f = files.get(uri.path);
			if (!f) { throw new Error('not found: ' + uri.path); }
			return { value: { toString: () => f.content } };
		},
		async writeFile(uri: URI, value: { toString(): string }): Promise<void> {
			const content = value.toString();
			files.set(uri.path, { content, mtime: Date.now(), size: content.length });
		},
	};
	return {
		service: service as any,
		addFile(path: string, content: string, mtime = 1000) {
			files.set(path, { content, mtime, size: content.length });
		},
		getContent(path: string): string | undefined { return files.get(path)?.content; },
	};
}

function trackedModel(reply: string | (() => Promise<string>)): { model: IChatModel; stats: { calls: number } } {
	const stats = { calls: 0 };
	return {
		stats,
		model: {
			async complete() { stats.calls++; return typeof reply === 'function' ? reply() : reply; },
			async extract<T>(): Promise<T> { throw new Error('not used'); },
		},
	};
}

const DIR = URI.file('/vault/lib');

function seedNotes(fs: ReturnType<typeof createTreeFileService>, dirName: string, count: number, mtime = 1000): void {
	for (let i = 0; i < count; i++) {
		fs.addFile(`/vault/lib/${dirName}/note${i}.md`, `---\ntitle: 笔记${i}\n---\n# 笔记${i}\n主题${i}的内容。`, mtime);
	}
}

suite('topicOverviews', () => {

	test('fileStamp / topicChangeRatio：集合对称差比例', () => {
		const a = [fileStamp('a.md', 1, 10), fileStamp('b.md', 1, 10)];
		assert.strictEqual(topicChangeRatio(a, a), 0);
		assert.strictEqual(topicChangeRatio(a, [...a, fileStamp('c.md', 1, 5)]), 1 / 3);
		assert.strictEqual(topicChangeRatio([], ['x']), 1);
	});

	test('parseTopicOverviews：分段解析与容错', () => {
		const m = parseTopicOverviews('### 目录 概念\n摘要：GC 相关概念。\n### 目录 会议\n只有正文没有前缀。');
		assert.strictEqual(m.get('概念'), 'GC 相关概念。');
		assert.strictEqual(m.get('会议'), '只有正文没有前缀。');
	});

	test('首次生成：调一次 LLM，写 .overview.md 与缓存', async () => {
		const fs = createTreeFileService();
		seedNotes(fs, '概念', 3);
		const { model, stats } = trackedModel('### 目录 概念\n摘要：概念目录的摘要。');
		const updated = await refreshTopicOverviews(fs.service, DIR, model);
		assert.deepStrictEqual(updated, ['概念']);
		assert.strictEqual(stats.calls, 1);
		const overview = fs.getContent(`/vault/lib/概念/${TOPIC_OVERVIEW_FILE}`);
		assert.ok(overview?.includes('概念目录的摘要'));
		assert.ok(fs.getContent(`/vault/lib/${TOPIC_OVERVIEW_CACHE_FILE}`), '缓存已落盘');
	});

	test('无变更时不重算（缓存命中，零 LLM 调用）', async () => {
		const fs = createTreeFileService();
		seedNotes(fs, '概念', 3);
		const { model, stats } = trackedModel('### 目录 概念\n摘要：首版摘要。');
		await refreshTopicOverviews(fs.service, DIR, model);
		const again = await refreshTopicOverviews(fs.service, DIR, model);
		assert.deepStrictEqual(again, []);
		assert.strictEqual(stats.calls, 1, '第二次不应再调 LLM');
	});

	test('变更 <10% 不重算；≥10% 重算', async () => {
		const fs = createTreeFileService();
		seedNotes(fs, '概念', 20);
		const { model, stats } = trackedModel('### 目录 概念\n摘要：摘要。');
		await refreshTopicOverviews(fs.service, DIR, model);
		assert.strictEqual(stats.calls, 1);

		// 改 1/20 = 5% ⇒ 不重算
		fs.addFile('/vault/lib/概念/note0.md', '---\ntitle: 笔记0\n---\n# 笔记0\n改了。', 2000);
		await refreshTopicOverviews(fs.service, DIR, model);
		assert.strictEqual(stats.calls, 1, '5% 变更不应触发重算');

		// 再改 1/20（累计 2/20 = 10%）⇒ 重算
		fs.addFile('/vault/lib/概念/note1.md', '---\ntitle: 笔记1\n---\n# 笔记1\n也改了。', 2000);
		const updated = await refreshTopicOverviews(fs.service, DIR, model);
		assert.strictEqual(stats.calls, 2, '10% 变更应触发重算');
		assert.deepStrictEqual(updated, ['概念']);
	});

	test('LLM 失败不抛、保留旧摘要、返回空', async () => {
		const fs = createTreeFileService();
		seedNotes(fs, '概念', 3);
		const { model } = trackedModel(async () => { throw new Error('LLM down'); });
		const updated = await refreshTopicOverviews(fs.service, DIR, model);
		assert.deepStrictEqual(updated, []);
		assert.strictEqual(fs.getContent(`/vault/lib/概念/${TOPIC_OVERVIEW_FILE}`), undefined, '失败时不写摘要文件');
	});

	test('无 chatModel 短路；空目录跳过', async () => {
		const fs = createTreeFileService();
		seedNotes(fs, '概念', 2);
		assert.deepStrictEqual(await refreshTopicOverviews(fs.service, DIR, undefined), []);
		// 空目录（无 md）不参与
		const fs2 = createTreeFileService();
		fs2.addFile('/vault/lib/概念/readme.txt', 'not md', 1000);
		const { model, stats } = trackedModel('### 目录 概念\n摘要：x');
		assert.deepStrictEqual(await refreshTopicOverviews(fs2.service, DIR, model), []);
		assert.strictEqual(stats.calls, 0);
	});
});
