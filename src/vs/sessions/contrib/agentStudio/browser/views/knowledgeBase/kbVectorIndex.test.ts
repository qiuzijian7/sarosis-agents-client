/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbVectorIndex.test.ts — KbVectorIndex 单元测试（无联网，使用 FakeEmbeddingService）。
 *
 *  覆盖：
 *   1. chunkMarkdown — heading 边界切分 / 超长段落按行切 / 起偏移正确
 *   2. build — 切块 + 批量向量化 + 状态（built/tag/dimensions/chunkCount）
 *   3. search — cosine 相似度降序且落在 [0,1]
 *   4. 导入导出 — 同 tag 直接复用；异 tag 用保存 text 重新向量化（rebuildStale）
 *   5. rebuildStale — provider 切换后只重算 tag 不匹配的块
 *
 *  运行：npx mocha --require ts-node/register src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbVectorIndex.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { KbVectorIndex, chunkMarkdown, cosineSimilarity } from './kbVectorIndex.js';
import { IEmbeddingService, IEmbeddingResult } from '../../../common/embeddingProvider.js';

// ---------------------------------------------------------------------------
// Fake embedding（bag-of-words 向量，使 cosine 与词重叠相关，便于断言检索排序）
// ---------------------------------------------------------------------------

class FakeEmbeddingService implements IEmbeddingService {
	readonly _serviceBrand: undefined = undefined;
	constructor(
		private readonly _tag: string,
		private readonly _dim: number,
	) { }

	async embed(texts: string[]): Promise<IEmbeddingResult> {
		const vectors = texts.map(t => this._vec(t));
		return { vectors, tag: this._tag, providerId: this._tag.split('/')[0], model: this._tag.split('/')[1] ?? '', dimensions: this._dim };
	}
	getActiveTag(): string { return this._tag; }
	getActiveDimensions(): number { return this._dim; }
	listProviders(): any[] { return []; }
	getStatus(): any { return { activeProviderId: this._tag.split('/')[0], tag: this._tag, lastError: undefined }; }

	private _vec(text: string): number[] {
		const v = new Array(this._dim).fill(0);
		const toks = text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/i).filter(Boolean);
		for (const tk of toks) {
			let h = 0;
			for (let i = 0; i < tk.length; i++) { h = (h * 31 + tk.charCodeAt(i)) | 0; }
			const idx = Math.abs(h) % this._dim;
			v[idx] += 1;
		}
		return v;
	}
}

// ---------------------------------------------------------------------------
// Mock IFileService（同 kbKnowledgeBase.test.ts 风格，扩展 byteLength）
// ---------------------------------------------------------------------------

function createMockFileService(): any {
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
		async writeFile(uri: any, content: any): Promise<void> {
			files.set(uri.toString(), { name: 'out.kbrag.json', content: content.toString(), mtime: Date.now(), size: content.toString().length });
		},
		async createFolder(_uri: any): Promise<void> {},
		addFile(uri: string, name: string, content: string, mtime = 1000, size = content.length): void {
			files.set(uri, { name, content, mtime, size });
		},
		getRaw(uri: string): string | undefined { return files.get(uri)?.content; },
	};
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('kbVectorIndex', () => {

	describe('chunkMarkdown', () => {
		it('在 heading 边界切分，并记录起偏移', () => {
			const md = '# 标题一\n第一段内容。\n\n# 标题二\n第二段内容。';
			const chunks = chunkMarkdown(md, 1000);
			assert.strictEqual(chunks.length, 2);
			assert.ok(chunks[0].text.startsWith('# 标题一'));
			assert.ok(chunks[1].text.startsWith('# 标题二'));
			// 第二段起点 = 第一段长度 + 1 个换行
			assert.strictEqual(chunks[1].start, '# 标题一\n第一段内容。\n\n'.length);
		});

		it('超长段落在单块超过 maxChars 时按行切', () => {
			const longPara = Array.from({ length: 200 }, (_, i) => `行${i}`).join('\n');
			const md = `# 大段\n${longPara}`;
			const chunks = chunkMarkdown(md, 100);
			assert.ok(chunks.length >= 2, '应被切成多块');
			for (const c of chunks) {
				assert.ok(c.text.length <= 100 + 50, '单块不超过 maxChars 太多');
			}
		});

		it('空文本不产生块', () => {
			assert.strictEqual(chunkMarkdown('   \n\n  ', 1000).length, 0);
		});
	});

	describe('cosineSimilarity', () => {
		it('相同向量相似度为 1', () => {
			const a = [1, 2, 3];
			assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-9);
		});
		it('零向量返回 0', () => {
			assert.strictEqual(cosineSimilarity([0, 0], [1, 1]), 0);
		});
	});

	describe('build + search', () => {
		it('构建向量索引并可语义检索（命中含关键词的块）', async () => {
			const fs = createMockFileService();
			fs.addFile('/vault/notes/algo.md', 'algo.md',
				'# 算法入门\n\n本文介绍算法入门与数据结构基础。\n\n算法入门非常重要。', 1000, 60);
			fs.addFile('/vault/notes/cooking.md', 'cooking.md',
				'# 烹饪\n\n今天做了一顿美味的晚餐，与算法无关。', 1000, 40);

			const emb = new FakeEmbeddingService('openai/text-embedding-3-small@512', 512);
			const idx = new KbVectorIndex(fs, emb);

			await idx.build([{ uri: URI.parse('/vault/notes'), section: 'notes' }]);

			const status = idx.getStatus();
			assert.strictEqual(status.built, true);
			assert.strictEqual(status.tag, 'openai/text-embedding-3-small@512');
			assert.strictEqual(status.dimensions, 512);
			assert.ok(status.chunkCount >= 2);

			const hits = await idx.search('算法', 4);
			assert.ok(hits.length > 0);
			// 最高分块应来自 algo.md（含“算法”）
			assert.ok(hits[0].docName === 'algo.md', `top hit 应为 algo.md，实际 ${hits[0]?.docName}`);
			for (const h of hits) {
				assert.ok(h.score <= 1 + 1e-9 && h.score >= 0, 'score 应在 [0,1]');
			}
			// 降序
			for (let i = 1; i < hits.length; i++) {
				assert.ok(hits[i - 1].score >= hits[i].score);
			}
		});

		it('无激活 provider 时 build 抛错', async () => {
			const fs = createMockFileService();
			fs.addFile('/vault/notes/a.md', 'a.md', '# 测试\n内容', 1000, 20);
			const idx = new KbVectorIndex(fs, undefined);
			await assert.rejects(() => idx.build([{ uri: URI.parse('/vault/notes'), section: 'notes' }]));
		});
	});

	describe('import / export (.kbrag.json)', () => {
		it('同 tag 导入直接复用向量，chunkCount 不变', async () => {
			const fs = createMockFileService();
			fs.addFile('/vault/notes/a.md', 'a.md', '# 主题A\n关于算法入门的讨论。', 1000, 40);
			const emb = new FakeEmbeddingService('openai/text-embedding-3-small@512', 512);

			const src = new KbVectorIndex(fs, emb);
			await src.build([{ uri: URI.parse('/vault/notes'), section: 'notes' }]);
			const json = src.serialize();
			const count = src.chunkCount;

			const dst = new KbVectorIndex(fs, emb);
			const ok = await dst.deserialize(json);
			assert.strictEqual(ok, true);
			assert.strictEqual(dst.chunkCount, count);
			assert.strictEqual(dst.getStatus().tag, 'openai/text-embedding-3-small@512');
		});

		it('异 tag 导入用保存 text 重新向量化（rebuildStale），chunkCount 保留且 tag 更新', async () => {
			const fs = createMockFileService();
			fs.addFile('/vault/notes/a.md', 'a.md', '# 主题A\n关于算法入门的讨论。', 1000, 40);
			const embA = new FakeEmbeddingService('openai/text-embedding-3-small@512', 512);

			const src = new KbVectorIndex(fs, embA);
			await src.build([{ uri: URI.parse('/vault/notes'), section: 'notes' }]);
			const json = src.serialize();
			const count = src.chunkCount;

			// 切换到另一个 provider tag（维度不同，模拟 provider 切换）
			const embB = new FakeEmbeddingService('local/Xenova-all-MiniLM-L6-v2@384', 384);
			const dst = new KbVectorIndex(fs, embB);
			const ok = await dst.deserialize(json);
			assert.strictEqual(ok, true);
			assert.strictEqual(dst.chunkCount, count, '重新向量化后块数不变');
			assert.strictEqual(dst.getStatus().tag, 'local/Xenova-all-MiniLM-L6-v2@384');
			assert.strictEqual(dst.getStatus().dimensions, 384);
		});

		it('exportToFile / importFromFile 经磁盘往返', async () => {
			const fs = createMockFileService();
			fs.addFile('/vault/notes/a.md', 'a.md', '# 主题A\n关于算法入门的讨论。', 1000, 40);
			const emb = new FakeEmbeddingService('openai/text-embedding-3-small@512', 512);

			const src = new KbVectorIndex(fs, emb);
			await src.build([{ uri: URI.parse('/vault/notes'), section: 'notes' }]);
			const uri = URI.parse('/vault/notes/.kbrag.json');
			await src.exportToFile(uri);

			const dst = new KbVectorIndex(fs, emb);
			const ok = await dst.importFromFile(uri);
			assert.strictEqual(ok, true);
			assert.strictEqual(dst.chunkCount, src.chunkCount);
		});
	});

	describe('rebuildStale (Phase 3)', () => {
		it('provider 切换后只重算 tag 不匹配的块', async () => {
			const fs = createMockFileService();
			fs.addFile('/vault/notes/a.md', 'a.md', '# 主题A\n关于算法入门。', 1000, 30);
			fs.addFile('/vault/notes/b.md', 'b.md', '# 主题B\n关于数据结构。', 1000, 30);
			const embA = new FakeEmbeddingService('openai/text-embedding-3-small@512', 512);

			const idx = new KbVectorIndex(fs, embA);
			await idx.build([{ uri: URI.parse('/vault/notes'), section: 'notes' }]);
			const total = idx.chunkCount;
			assert.ok(total >= 2);

			// 手动把一部分块的 tag 改成旧 tag，模拟 provider 切换前的残留
			const chunks = idx.allChunks();
			const staleCount = Math.min(1, chunks.length);
			for (let i = 0; i < staleCount; i++) { chunks[i].tag = 'old/legacy@512'; }

			// 切到新 provider 后调用 rebuildStale
			const embB = new FakeEmbeddingService('openai/text-embedding-3-small@512', 512);
			(idx as any)._embedding = embB;
			const rebuilt = await (idx as any).rebuildStale();
			assert.strictEqual(rebuilt, staleCount);
			assert.strictEqual(idx.chunkCount, total, '重算后总块数不变');
			assert.ok(idx.allChunks().every(c => c.tag === 'openai/text-embedding-3-small@512'));
		});
	});
});
