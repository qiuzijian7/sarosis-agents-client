/*---------------------------------------------------------------------------------------------
 *  KbVectorIndex 引擎单元测试。
 *  - 确定性 bag-of-words embedding mock：相同词 → 高 cosine，便于验证检索排序。
 *  - 内存 FileService mock：支持 resolve / readFile / writeFile / exists，无真实磁盘 IO。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IEmbeddingService, IEmbeddingResult } from '../../common/embeddingProvider.js';
import {
	KbVectorIndex,
	chunkMarkdown,
	cosineSimilarity,
	KB_RAG_INDEX_FILE,
	KB_RAG_INDEX_BINARY_FILE,
	type IKbVectorChunk,
} from '../../browser/views/knowledgeBase/kbVectorIndex.js';
import type { KbSection } from '../../browser/views/knowledgeBase/kbTypes.js';

suite('AgentStudio - KbVectorIndex 引擎', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ── 确定性 embedding mock（bag-of-words）───────────────────────────────────
	class MockEmbeddingService implements IEmbeddingService {
		declare _serviceBrand: undefined;
		providerId = 'mock';
		model = 'mock-embed';
		dimensions = 64;
		tag = 'mock/mock-embed@64';
		embedCallCount = 0;

		private _hash(s: string): number {
			let h = 0;
			for (let i = 0; i < s.length; i++) {
				h = (h * 31 + s.charCodeAt(i)) | 0;
			}
			return Math.abs(h);
		}

		private _vec(text: string): number[] {
			const v = new Array(this.dimensions).fill(0);
			for (const w of text.toLowerCase().split(/\W+/)) {
				if (!w) { continue; }
				v[this._hash(w) % this.dimensions] += 1;
			}
			return v;
		}

		async embed(texts: string[]): Promise<IEmbeddingResult> {
			this.embedCallCount += texts.length;
			return {
				vectors: texts.map(t => this._vec(t)),
				tag: this.tag,
				providerId: this.providerId,
				model: this.model,
				dimensions: this.dimensions,
			};
		}

		getActiveTag(): string | undefined { return this.tag; }
		getActiveDimensions(): number | undefined { return this.dimensions; }
		listProviders() { return []; }
		getStatus() { return { activeProviderId: this.providerId, tag: this.tag, lastError: undefined }; }
	}

	// ── 内存 FileService mock（二进制安全：以 VSBuffer 原样存储）─────────────────
	interface INode { isDir: boolean; bytes?: VSBuffer; mtime: number; size: number; children?: string[]; }
	class MockFileService {
		private _nodes = new Map<string, INode>();
		addFile(uri: URI, content: string): void {
			this._nodes.set(uri.toString(), { isDir: false, bytes: VSBuffer.fromString(content), mtime: Date.now(), size: content.length });
		}
		addDir(uri: URI, children: URI[]): void {
			this._nodes.set(uri.toString(), { isDir: true, mtime: Date.now(), size: 0, children: children.map(c => c.toString()) });
		}
		async resolve(uri: URI) {
			const n = this._nodes.get(uri.toString());
			if (!n) { throw new Error('ENOENT ' + uri.toString()); }
			if (n.isDir) {
				return {
					resource: uri,
					isDirectory: true,
					mtime: n.mtime,
					size: 0,
					children: (n.children ?? []).map(c => this._childStat(URI.parse(c))),
				};
			}
			return { resource: uri, isDirectory: false, mtime: n.mtime, size: n.size };
		}
		private _childStat(uri: URI) {
			const n = this._nodes.get(uri.toString());
			return { resource: uri, isDirectory: n?.isDir ?? false, mtime: n?.mtime, size: n?.size };
		}
		async readFile(uri: URI) {
			const n = this._nodes.get(uri.toString());
			if (!n || n.isDir || !n.bytes) { throw new Error('ENOENT file ' + uri.toString()); }
			return { value: n.bytes };
		}
		async writeFile(uri: URI, content: VSBuffer): Promise<void> {
			this._nodes.set(uri.toString(), { isDir: false, bytes: content, mtime: Date.now(), size: content.byteLength });
		}
		async exists(uri: URI): Promise<boolean> { return this._nodes.has(uri.toString()); }
	}

	function makeVault(embed: MockEmbeddingService): { fs: MockFileService; root: URI; docA: URI; docB: URI } {
		const fs = new MockFileService();
		const root = URI.parse('file:///vault');
		const lib = URI.parse('file:///vault/库');
		const docA = URI.parse('file:///vault/库/A.md');
		const docB = URI.parse('file:///vault/库/B.md');
		fs.addFile(docA, '# RAG 向量索引\n\n切块 embedding 语义检索 向量化。\n\n## 子标题\n\n余弦相似度 计算。');
		fs.addFile(docB, '# 项目管理\n\n甘特图 任务分配 进度追踪。\n\n## 排期\n\n里程碑 风险管理。');
		fs.addDir(lib, [docA, docB]);
		fs.addDir(root, [lib]);
		return { fs, root, docA, docB };
	}

	const section: KbSection = 'library';

	// ── chunkMarkdown ───────────────────────────────────────────────────────────
	test('chunkMarkdown 在 heading 边界切分', () => {
		const text = '# 标题一\n正文一\n\n## 标题二\n正文二';
		const chunks = chunkMarkdown(text, 1000);
		assert.ok(chunks.length >= 2);
		// 第一个块应包含「标题一」
		assert.ok(chunks[0].text.includes('标题一'));
		// 第二个块应包含「标题二」
		assert.ok(chunks[1].text.includes('标题二'));
	});

	test('chunkMarkdown 超长内容在 maxChars 处按行再切', () => {
		// 生产语义：仅在「行边界」切分——单行超长时不会在行内再切。
		// 故用多行累计超过 maxChars 来验证按行再切。
		const line = 'y'.repeat(200);
		const text = Array.from({ length: 12 }, (_, i) => `line${i} ${line}`).join('\n');
		const chunks = chunkMarkdown(text, 1000);
		assert.ok(chunks.length >= 2, '累计超过 maxChars 应被再切分');
		for (const c of chunks) {
			assert.ok(c.text.length <= 1000, '单块不应超过 maxChars');
		}
	});

	test('chunkMarkdown 返回正确的 start 偏移', () => {
		const text = '# H1\nline1\nline2\n\n## H2\nline3';
		const chunks = chunkMarkdown(text, 1000);
		for (const c of chunks) {
			assert.strictEqual(text.slice(c.start, c.start + c.text.length), c.text, 'start 必须指向原文对应位置');
		}
	});

	test('chunkMarkdown 空文本返回空数组', () => {
		assert.deepStrictEqual(chunkMarkdown('', 1000), []);
		assert.deepStrictEqual(chunkMarkdown('   \n  \n', 1000), []);
	});

	// ── cosineSimilarity ────────────────────────────────────────────────────────
	test('cosineSimilarity 基本性质', () => {
		assert.strictEqual(cosineSimilarity([1, 0], [1, 0]), 1);
		assert.strictEqual(cosineSimilarity([1, 0], [0, 1]), 0);
		assert.strictEqual(cosineSimilarity([0, 0], [1, 1]), 0);
		// 长度不一致时按较短维度计算
		assert.ok(cosineSimilarity([1, 1, 0], [1, 1]) > 0.99);
	});

	// ── build + search ──────────────────────────────────────────────────────────
	test('build 后 isBuilt / chunkCount / tag', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);
		assert.strictEqual(idx.isBuilt, true);
		assert.ok(idx.chunkCount > 0, '应切出多块');
		assert.strictEqual(idx.tag, 'mock/mock-embed@64');
		assert.strictEqual(idx.dimensions, 64);
	});

	test('search 返回语义相关且按相似度降序', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);

		const hits = await idx.search('语义检索 embedding 向量', 8);
		assert.ok(hits.length > 0, '应检索到命中');
		// 共享词最多的 A.md 应排第一
		assert.ok(hits[0].docName.includes('A.md'), `top hit 应为 A.md，实际 ${hits[0].docName}`);
		assert.ok(hits[0].score > 0, 'top score 应 > 0');
		// 降序
		for (let i = 1; i < hits.length; i++) {
			assert.ok(hits[i - 1].score >= hits[i].score, '结果应降序');
		}
	});

	test('search 空索引 / 空查询返回 []', async () => {
		const embed = new MockEmbeddingService();
		const idx = new KbVectorIndex(new MockFileService() as any, embed);
		assert.deepStrictEqual(await idx.search('任意'), []);
		await idx.build([{ uri: URI.parse('file:///empty'), section }]);
		assert.deepStrictEqual(await idx.search('   '), []);
	});

	test('search 受 topK 裁剪', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);
		const hits = await idx.search('任务 进度 风险管理 甘特图', 1);
		assert.strictEqual(hits.length, 1);
	});

	test('无激活 Embedding 时 build 抛错', async () => {
		const idx = new KbVectorIndex(new MockFileService() as any, undefined);
		await assert.rejects(() => idx.build([{ uri: URI.parse('file:///x'), section }]), /Embedding provider/);
	});

	// ── serialize / deserialize 往返 ────────────────────────────────────────────
	test('serialize → deserialize 保留块与文本', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);

		const json = idx.serialize();
		const idx2 = new KbVectorIndex(new MockFileService() as any, embed);
		const ok = await idx2.deserialize(json);
		assert.strictEqual(ok, true);
		assert.strictEqual(idx2.isBuilt, true);
		assert.strictEqual(idx2.chunkCount, idx.chunkCount);
		assert.strictEqual(idx2.tag, 'mock/mock-embed@64');
	});

	test('deserialize 同 tag 直接复用向量（不重算）', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);
		const before = embed.embedCallCount;

		const idx2 = new KbVectorIndex(new MockFileService() as any, embed); // 同 tag
		await idx2.deserialize(idx.serialize());
		assert.strictEqual(embed.embedCallCount, before, '同 tag 不应触发重新向量化');
		assert.strictEqual(idx2.tag, 'mock/mock-embed@64');
	});

	test('deserialize 异 tag 触发重算（rebuildStale）', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);
		const before = embed.embedCallCount;

		// 切换 provider → 新 tag
		embed.providerId = 'mock2';
		embed.model = 'mock2-embed';
		embed.tag = 'mock2/mock2-embed@64';

		const idx2 = new KbVectorIndex(new MockFileService() as any, embed);
		const ok = await idx2.deserialize(idx.serialize());
		assert.strictEqual(ok, true);
		assert.ok(embed.embedCallCount > before, '异 tag 应触发重新向量化');
		assert.strictEqual(idx2.tag, 'mock2/mock2-embed@64');
		assert.strictEqual(idx2.chunkCount, idx.chunkCount);
	});

	test('deserialize 非法 JSON / 版本不符返回 false', async () => {
		const embed = new MockEmbeddingService();
		const idx = new KbVectorIndex(new MockFileService() as any, embed);
		assert.strictEqual(await idx.deserialize('not json'), false);
		assert.strictEqual(await idx.deserialize(JSON.stringify({ v: 999, chunks: [] })), false);
		assert.strictEqual(idx.isBuilt, false);
	});

	// ──  provider / tag 切换：rebuildStale ───────────────────────────────────────
	test('rebuildStale 仅重建 tag 不匹配的块', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);
		const total = idx.chunkCount;
		const before = embed.embedCallCount;

		// 切换 provider
		embed.providerId = 'mock2';
		embed.model = 'mock2-embed';
		embed.tag = 'mock2/mock2-embed@64';

		const rebuilt = await idx.rebuildStale();
		assert.strictEqual(rebuilt, total, '所有块都应被重建');
		assert.ok(embed.embedCallCount > before);
		assert.strictEqual(idx.tag, 'mock2/mock2-embed@64');
		// 重建后仍可检索
		const hits = await idx.search('语义检索 embedding');
		assert.ok(hits.length > 0);
	});

	// ── remapPaths（跨机器路径重映射）───────────────────────────────────────────
	test('remapPaths 重映射 docId / id / 内嵌文本引用', () => {
		const data = {
			v: 1, tag: 't', dimensions: 64, builtAt: 1,
			roots: [{ uri: 'file:///old/库', section: 'library' }],
			chunks: [{ id: 'file:///old/A.md#0', docId: 'file:///old/A.md', docName: 'A.md', section: 'library', text: '引用 file:///old/B.md 的内容', vector: [1], tag: 't', start: 0 }],
		};
		const out = KbVectorIndex.remapPaths(JSON.stringify(data), 'file:///old/', 'file:///new/');
		assert.ok(out, '应返回重映射后的 JSON');
		const parsed = JSON.parse(out!);
		assert.strictEqual(parsed.chunks[0].docId, 'file:///new/A.md');
		assert.strictEqual(parsed.chunks[0].id, 'file:///new/A.md#0');
		assert.strictEqual(parsed.chunks[0].text, '引用 file:///new/B.md 的内容');
		assert.strictEqual(parsed.roots[0].uri, 'file:///new/库');
	});

	test('remapPaths 无匹配返回 null', () => {
		const data = { v: 1, tag: 't', dimensions: 64, builtAt: 1, roots: [], chunks: [{ id: 'x', docId: 'file:///a', docName: 'a', section: 'library', text: 'no', vector: [], tag: 't', start: 0 }] };
		assert.strictEqual(KbVectorIndex.remapPaths(JSON.stringify(data), 'file:///zzz/', 'file:///yyy/'), null);
		assert.strictEqual(KbVectorIndex.remapPaths('bad', 'a', 'b'), null);
	});

	// ── import / export 文件往返 ────────────────────────────────────────────────
	test('exportToFile → importFromFile 往返保留索引', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);

		const outUri = URI.parse('file:///out/' + KB_RAG_INDEX_FILE);
		await idx.exportToFile(outUri);

		const idx2 = new KbVectorIndex(fs as any, embed);
		const ok = await idx2.importFromFile(outUri);
		assert.strictEqual(ok, true);
		assert.strictEqual(idx2.isBuilt, true);
		assert.strictEqual(idx2.chunkCount, idx.chunkCount);
	});

	test('importFromFile 不存在/非法文件返回 false', async () => {
		const embed = new MockEmbeddingService();
		const idx = new KbVectorIndex(new MockFileService() as any, embed);
		assert.strictEqual(await idx.importFromFile(URI.parse('file:///nope/missing.json')), false);
	});

	// ── 二进制序列化往返（.kvindex，Float32 密集布局）────────────────────────────
	test('serializeBinary → deserializeBinary 无损保留块与向量', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);

		const bin = idx.serializeBinary();
		assert.ok(bin instanceof Uint8Array);
		const idx2 = new KbVectorIndex(new MockFileService() as any, embed);
		const ok = await idx2.deserializeBinary(bin);
		assert.strictEqual(ok, true);
		assert.strictEqual(idx2.isBuilt, true);
		assert.strictEqual(idx2.chunkCount, idx.chunkCount);
		assert.strictEqual(idx2.tag, 'mock/mock-embed@64');
		// 向量应被原样保留（二进制无损）
		const a = idx.allChunks();
		const b = idx2.allChunks();
		for (let i = 0; i < a.length; i++) {
			assert.deepStrictEqual(b[i].vector, a[i].vector, `chunk ${i} 向量应一致`);
			assert.strictEqual(b[i].text, a[i].text);
		}
	});

	test('exportToBinaryFile → importFromBinaryFile 磁盘往返', async () => {
		const embed = new MockEmbeddingService();
		const { fs, root } = makeVault(embed);
		const idx = new KbVectorIndex(fs as any, embed);
		await idx.build([{ uri: root, section }]);

		const outUri = URI.parse('file:///out/' + KB_RAG_INDEX_BINARY_FILE);
		await idx.exportToBinaryFile(outUri);

		const idx2 = new KbVectorIndex(fs as any, embed);
		const ok = await idx2.importFromBinaryFile(outUri);
		assert.strictEqual(ok, true);
		assert.strictEqual(idx2.isBuilt, true);
		assert.strictEqual(idx2.chunkCount, idx.chunkCount);
		assert.strictEqual(idx2.tag, 'mock/mock-embed@64');
	});

	test('deserializeBinary 非法数据返回 false', async () => {
		const embed = new MockEmbeddingService();
		const idx = new KbVectorIndex(new MockFileService() as any, embed);
		assert.strictEqual(await idx.deserializeBinary(new Uint8Array([1, 2, 3])), false);
	});
});
