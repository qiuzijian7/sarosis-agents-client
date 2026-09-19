/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbVectorIndexExtras.test.ts — P1 增量特性测试（tdd 风格，通用 runner 直跑）。
 *  （kbVectorIndex.test.ts 为 bdd 风格走 npx mocha；本文件走 run-browser-test.mjs）
 *
 *  覆盖：
 *   1. removeDoc — 选择性删除单文档的块与元信息
 *   2. removeDocsUnder — 目录前缀批量删除
 *   3. findSimilarDocs — 隐式关联发现（命中相似 / 阈值过滤 / 排除自身）
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbVectorIndexExtras.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { KbVectorIndex } from './kbVectorIndex.js';
import { IEmbeddingService, IEmbeddingResult } from '../../../common/embeddingProvider.js';

/** bag-of-words 假 embedding（与 kbVectorIndex.test.ts 同思路：cosine 与词重叠相关）。 */
class FakeEmbeddingService implements IEmbeddingService {
	readonly _serviceBrand: undefined = undefined;
	async embed(texts: string[]): Promise<IEmbeddingResult> {
		const vectors = texts.map(t => this._vec(t));
		return { vectors, tag: 'fake/model@64', providerId: 'fake', model: 'model', dimensions: 64 };
	}
	getActiveTag(): string { return 'fake/model@64'; }
	getTagForProvider(): string | undefined { return 'fake/model@64'; }
	getActiveDimensions(): number { return 64; }
	listProviders(): any[] { return []; }
	getStatus(): any { return {}; }
	private _vec(text: string): number[] {
		const v = new Array(64).fill(0);
		for (const tk of text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/i).filter(Boolean)) {
			let h = 0;
			for (let i = 0; i < tk.length; i++) { h = (h * 31 + tk.charCodeAt(i)) | 0; }
			v[Math.abs(h) % 64] += 1;
		}
		return v;
	}
}

function createMockFileService() {
	const files = new Map<string, { name: string; content: string; mtime: number; size: number }>();
	return {
		async resolve(uri: any): Promise<any> {
			const pathKey = uri.toString();
			const file = files.get(pathKey);
			if (file) {
				return { resource: uri, name: file.name, isDirectory: false, mtime: file.mtime, size: file.size, children: undefined };
			}
			const entries: any[] = [];
			for (const [key, f] of files) {
				if (key.startsWith(pathKey + '/')) {
					entries.push({ resource: { toString: () => key, path: key, fsPath: key } as any, name: f.name, isDirectory: false, mtime: f.mtime, size: f.size });
				}
			}
			return { resource: uri, name: 'root', isDirectory: true, children: entries };
		},
		async readFile(uri: any): Promise<{ value: { toString(): string; byteLength: number } }> {
			const file = files.get(uri.toString());
			if (!file) { throw new Error('File not found'); }
			return { value: { toString: () => file.content, byteLength: file.content.length } };
		},
		async writeFile(): Promise<void> {},
		async createFolder(): Promise<void> {},
		addFile(uri: string, name: string, content: string, mtime = 1000, size = content.length): void {
			files.set(uri, { name, content, mtime, size });
		},
	};
}

async function buildFixture(): Promise<{ idx: KbVectorIndex; docIdOf: (name: string) => string }> {
	const fs = createMockFileService();
	// 用 URI.file（file:// scheme）保证 mock key 与 uri.toString() 一致（无 scheme 的 URI.parse 形态不稳）
	fs.addFile('file:///vault/lib/algo.md', 'algo.md', '# 算法\n\n算法与数据结构基础。算法进阶。', 1000, 40);
	fs.addFile('file:///vault/lib/algo2.md', 'algo2.md', '# 算法进阶\n\n算法与数据结构进阶讨论。', 1000, 36);
	fs.addFile('file:///vault/lib/cooking.md', 'cooking.md', '# 烹饪\n\n今天做了一顿美味的晚餐。', 1000, 30);
	const idx = new KbVectorIndex(fs as any, new FakeEmbeddingService());
	await idx.build([{ uri: URI.file('/vault/lib'), section: 'library' }]);
	const docIdOf = (name: string) => {
		const c = idx.allChunks().find(c => c.docName === name);
		if (!c) { throw new Error('no chunk for ' + name); }
		return c.docId;
	};
	return { idx, docIdOf };
}

suite('kbVectorIndex P1 extras', () => {

	test('removeDoc：选择性删除后检索不再命中该文档', async () => {
		const { idx, docIdOf } = await buildFixture();
		const before = idx.chunkCount;
		const removed = idx.removeDoc(docIdOf('algo.md'));
		assert.ok(removed > 0);
		assert.strictEqual(idx.chunkCount, before - removed);
		const hits = await idx.search('算法', 8);
		assert.ok(hits.every(h => h.docName !== 'algo.md'), '已删文档不应再被命中');
	});

	test('removeDocsUnder：目录前缀批量删除', async () => {
		const { idx, docIdOf } = await buildFixture();
		const dirPrefix = docIdOf('algo.md').slice(0, docIdOf('algo.md').lastIndexOf('/'));
		const removed = idx.removeDocsUnder(dirPrefix);
		assert.ok(removed > 0);
		assert.strictEqual(idx.chunkCount, 0);
		// 无 '/' 后缀误伤：文档 docId 不会被另一个同名前缀误删
		const { idx: idx2, docIdOf: docIdOf2 } = await buildFixture();
		const removedFile = idx2.removeDocsUnder(docIdOf2('algo.md'));
		assert.strictEqual(removedFile, 0, '文件 docId 加 / 前缀不应匹配任何块');
	});

	test('findSimilarDocs：命中相似文档、排除自身、阈值过滤无关文档', async () => {
		const { idx, docIdOf } = await buildFixture();
		// bag-of-words 假 embedding 下同主题文档 cosine ≈0.4，阈值取 0.3
		const hits = idx.findSimilarDocs(docIdOf('algo.md'), 5, 0.3);
		assert.ok(hits.length > 0);
		assert.ok(hits.every(h => h.docName !== 'algo.md'), '应排除自身');
		assert.strictEqual(hits[0].docName, 'algo2.md', '最相似应为同主题文档');
		assert.ok(hits.every(h => h.score >= 0.3), '低于阈值的应被过滤');
		assert.ok(hits.every(h => h.docName !== 'cooking.md'), '无关文档（零词重叠）应被过滤');
		// 高阈值下全部过滤
		const strict = idx.findSimilarDocs(docIdOf('algo.md'), 5, 0.99);
		assert.strictEqual(strict.length, 0);
	});

	test('findSimilarDocs：未构建 / 文档无块时返回空', async () => {
		const fs = createMockFileService();
		const idx = new KbVectorIndex(fs as any, new FakeEmbeddingService());
		assert.deepStrictEqual(idx.findSimilarDocs('file:///x.md'), []);
		const { idx: built } = await buildFixture();
		assert.deepStrictEqual(built.findSimilarDocs('file:///nonexistent.md'), []);
	});
});
