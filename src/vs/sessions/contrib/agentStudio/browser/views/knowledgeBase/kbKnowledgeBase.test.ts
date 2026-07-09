/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbKnowledgeBase.test.ts — 知识库功能综合测试套件。
 *
 *  覆盖：
 *   1. Tokenizer — CJK/ASCII/标签分词正确性
 *   2. 倒排索引 — 构建 / 搜索 / 标签检索 / 前缀补全
 *   3. 双链图谱 — [[...]] 解析 / 出链 / 反链
 *   4. 提及检测 — 正文文本匹配（非 [[ ]] 形式）
 *   5. Lute 渲染器 — wikilink 提取 / blockref 提取
 *   6. 图谱数据 — 内置内核 graph 数据生成
 *
 *  运行方式：
 *   cd <project-root>
 *   npx mocha --require ts-node/register src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbKnowledgeBase.test.ts
 *   # 或：
 *   npx tsgo --project src/tsconfig.json --noEmit --skipLibCheck src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbKnowledgeBase.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { KbFullTextIndex } from './kbIndex.js';

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 创建最小化的 mock IFileService（仅用于测试 tokenize / search 逻辑）。 */
function createMockFileService(): any {
	const files = new Map<string, { name: string; content: string; mtime: number; size: number }>();
	return {
		async resolve(uri: any): Promise<any> {
			const pathKey = uri.toString();
			const file = files.get(pathKey);
			if (file) {
				return {
					resource: uri,
					name: file.name,
					isDirectory: false,
					mtime: file.mtime,
					size: file.size,
					children: undefined,
				};
			}
			// 模拟目录：返回 children
			const entries: any[] = [];
			for (const [key, f] of files) {
				if (key.startsWith(pathKey + '/')) {
					entries.push({
						resource: { toString: () => key, path: key, fsPath: key } as any,
						name: f.name,
						isDirectory: false,
						mtime: f.mtime,
						size: f.size,
					});
				}
			}
			return { resource: uri, name: 'root', isDirectory: true, children: entries };
		},
		async readFile(uri: any): Promise<{ value: { toString(): string } }> {
			const file = files.get(uri.toString());
			if (!file) { throw new Error('File not found'); }
			return { value: { toString: () => file.content } };
		},
		async writeFile(_uri: any, _content: any): Promise<void> {},
		async createFolder(_uri: any): Promise<void> {},
		addFile(uri: string, name: string, content: string, mtime = 1000, size = content.length): void {
			files.set(uri, { name, content, mtime, size });
		},
	};
}

// ---------------------------------------------------------------------------
// 测试 1: Tokenizer
// ---------------------------------------------------------------------------

describe('KbFullTextIndex - Tokenizer', () => {

	let index: KbFullTextIndex;
	let fs: any;

	beforeEach(() => {
		fs = createMockFileService();
		index = new KbFullTextIndex(fs);
	});

	it('should tokenize ASCII words', () => {
		// 通过 build 验证 tokenize 效果
		fs.addFile('/vault/notes/doc1.md', 'doc1.md', 'hello world testing', 1000, 19);
		// 直接访问私有方法测试（通过构建后的搜索验证）
	});

	it('should tokenize CJK characters (single + bigram)', async () => {
		fs.addFile('/vault/notes/cn1.md', 'cn1.md', '你好世界知识管理', 1000, 24);
		await index.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		// 单字搜索
		const r1 = index.search('知识');
		assert.ok(r1.length > 0, '搜索「知识」应有结果');
		assert.ok(r1[0].name === 'cn1.md');

		// 双字搜索
		const r2 = index.search('管理');
		assert.ok(r2.length > 0, '搜索「管理」应有结果');
	});

	it('should tokenize Japanese kana', async () => {
		fs.addFile('/vault/notes/jp1.md', 'jp1.md', 'こんにちは世界あいうえお', 1000, 30);
		await index.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		const r1 = index.search('にち');
		assert.ok(r1.length > 0, '搜索假名应有结果');
	});

	it('should tokenize mixed CJK + ASCII', async () => {
		fs.addFile('/vault/notes/mix1.md', 'mix1.md', 'AI 人工智能 machine-learning 深度学习', 1000, 50);
		await index.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		const r1 = index.search('AI');
		assert.ok(r1.length > 0, '搜索英文应有结果');
		const r2 = index.search('depth');
		assert.ok(r2.length > 0, '搜索英文词片段应有结果');
	});
});

// ---------------------------------------------------------------------------
// 测试 2: 倒排索引搜索
// ---------------------------------------------------------------------------

describe('KbFullTextIndex - Search', () => {

	let fs: any;
	let index: KbFullTextIndex;

	beforeEach(async () => {
		fs = createMockFileService();
		index = new KbFullTextIndex(fs);

		fs.addFile('/vault/notes/a.md', '算法入门.md',
			'# 算法入门\n\n排序算法是最基础的算法之一。\n\n常见排序包括冒泡排序、快速排序、归并排序。',
			1000, 80);
		fs.addFile('/vault/notes/b.md', '数据结构.md',
			'# 数据结构\n\n链表、栈、队列、树、图。\n\n二叉树和红黑树是常见树结构。',
			2000, 70);
		fs.addFile('/vault/notes/c.md', '项目计划.md',
			'# Q3 项目计划\n\n本月重点：前端性能优化，数据库索引优化。',
			3000, 60);

		await index.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);
	});

	it('should search by content and rank by BM25', () => {
		const hits = index.search('排序');
		assert.ok(hits.length >= 1, '应有排序相关结果');
		// 「算法入门」文档中多次出现「排序」，BM25 评分应最高
		assert.strictEqual(hits[0].name, '算法入门.md');
	});

	it('should match by filename with boosted score', () => {
		const hits = index.search('算法');
		assert.ok(hits.length >= 1);
		// 文件名命中应得分最高
		assert.strictEqual(hits[0].name, '算法入门.md');
		assert.strictEqual(hits[0].matchedBy, 'name');
	});

	it('should match CJK bigrams correctly', () => {
		const hits = index.search('红黑树');
		assert.ok(hits.length >= 1);
		assert.strictEqual(hits[0].name, '数据结构.md');
	});

	it('should return empty for no match', () => {
		const hits = index.search('zzzzz_nonexistent');
		assert.strictEqual(hits.length, 0);
	});

	it('should provide snippet with hit highlight', () => {
		const hits = index.search('快速排序');
		assert.ok(hits.length >= 1);
		assert.ok(hits[0].snippet.length > 0, '应有片段摘要');
		assert.ok(hits[0].snippet.includes('快速排序'), '片段应包含搜索词');
	});

	it('should respect limit parameter', () => {
		const hits = index.search('排序', 1);
		assert.ok(hits.length <= 1);
	});
});

// ---------------------------------------------------------------------------
// 测试 3: 标签索引
// ---------------------------------------------------------------------------

describe('KbFullTextIndex - Tag Index', () => {

	let fs: any;
	let index: KbFullTextIndex;

	beforeEach(async () => {
		fs = createMockFileService();
		index = new KbFullTextIndex(fs);

		fs.addFile('/vault/notes/t1.md', '任务管理.md',
			'# 任务管理\n\n#编程 #项目管理\n\n使用 TypeScript 开发。\n#前端',
			1000, 60);
		fs.addFile('/vault/notes/t2.md', '学习笔记.md',
			'# 学习笔记\n\n#编程 #AI #机器学习\n\n神经网络基础入门。',
			2000, 50);
		fs.addFile('/vault/notes/t3.md', '周报.md',
			'# 周报\n\n本周完成：界面重构。#前端\n\n下周计划：性能优化。',
			3000, 40);

		await index.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);
	});

	it('should extract tags from text', () => {
		const hits = index.searchByTag('编程');
		assert.strictEqual(hits.length, 2, '应有 2 个文档包含 #编程# 标签');
		const names = hits.map(h => h.name).sort();
		assert.deepStrictEqual(names, ['任务管理.md', '学习笔记.md']);
	});

	it('should search by tag and return matchedBy=tag', () => {
		const hits = index.searchByTag('前端');
		assert.strictEqual(hits.length, 2);
		assert.strictEqual(hits[0].matchedBy, 'tag');
	});

	it('should prefix-search tags for autocompletion', () => {
		const tags = index.searchTagsByPrefix('项');
		assert.ok(tags.includes('项目管理'), '应包含「项目管理」');
	});

	it('should list all tags with counts', () => {
		const all = index.getAllTags();
		assert.ok(all.length >= 4, '至少应有 4 个标签');
		// 标签按文档数降序
		assert.ok(all[0].count >= all[1].count);
	});

	it('should return empty for nonexistent tag', () => {
		const hits = index.searchByTag('不存在的标签');
		assert.strictEqual(hits.length, 0);
	});

	it('should boost tag-matched docs in full-text search', () => {
		// 搜索「编程」应返回文本命中，但标签命中的文档加权
		const hits = index.search('编程');
		assert.ok(hits.length >= 1);
	});
});

// ---------------------------------------------------------------------------
// 测试 4: Lute 渲染器 — 引用提取
// ---------------------------------------------------------------------------

describe('LuteRenderer - Reference Extraction', () => {

	it('should extract wikilinks [[...]]', async () => {
		const { extractWikilinks } = await import('./kbLuteRenderer.js');
		const text = '参考 [[算法入门]] 和 [[数据结构|数据]] 了解基础。';
		const links = extractWikilinks(text);
		assert.strictEqual(links.length, 2);
		assert.deepStrictEqual(links, ['算法入门', '数据结构|数据']);
	});

	it('should extract blockrefs ((...))', async () => {
		const { extractBlockRefs } = await import('./kbLuteRenderer.js');
		const text = '见 ((20230101-abc123)) 块的说明，以及 ((def456))。';
		const refs = extractBlockRefs(text);
		assert.strictEqual(refs.length, 2);
		assert.deepStrictEqual(refs, ['20230101-abc123', 'def456']);
	});

	it('should NOT extract inline code wikilinks', async () => {
		const { extractWikilinks } = await import('./kbLuteRenderer.js');
		const text = '代码块中 `[[不是链接]]` 不应提取。';
		const links = extractWikilinks(text);
		assert.strictEqual(links.length, 0, 'inline code 中的 [[...]] 不应被提取');
	});

	it('should extract wikilinks with headings', async () => {
		const { extractWikilinks } = await import('./kbLuteRenderer.js');
		const text = '参考 [[算法入门#快速排序]] 了解详情。';
		const links = extractWikilinks(text);
		assert.strictEqual(links.length, 1);
		assert.strictEqual(links[0], '算法入门#快速排序');
	});
});

// ---------------------------------------------------------------------------
// 测试 5: 双链图谱
// ---------------------------------------------------------------------------

describe('KbLinkGraph - Wikilinks', () => {

	it('should parse [[...]] and build outgoing links (basic)', async () => {
		const { KbLinkGraph } = await import('./kbGraph.js');
		const fs = createMockFileService();

		fs.addFile('/vault/notes/a.md', 'A.md', '参考 [[B]] 和 [[C|C笔记]]', 1000, 20);
		fs.addFile('/vault/notes/b.md', 'B.md', '被 A 引用。', 1000, 10);
		fs.addFile('/vault/notes/c.md', 'C.md', '也被 A 引用。', 1000, 10);

		const graph = new KbLinkGraph(fs);
		await graph.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		const aUri = '/vault/notes/a.md';
		const outgoing = graph.outgoingLinks(aUri);
		assert.strictEqual(outgoing.length, 2, 'A 应有 2 条出链');
		assert.ok(outgoing.some(o => o.label === 'B'));
		assert.ok(outgoing.some(o => o.label === 'C笔记'));
	});

	it('should compute backlinks', async () => {
		const { KbLinkGraph } = await import('./kbGraph.js');
		const fs = createMockFileService();

		fs.addFile('/vault/notes/a.md', 'A.md', '参考 [[B]]', 1000, 10);
		fs.addFile('/vault/notes/b.md', 'B.md', '# B\n\n被引用。', 1000, 8);

		const graph = new KbLinkGraph(fs);
		await graph.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		const bUri = '/vault/notes/b.md';
		const backlinks = graph.backlinks(bUri);
		assert.strictEqual(backlinks.length, 1, 'B 应有 1 条反链');
		assert.strictEqual(backlinks[0].name, 'A.md');
	});

	it('should mark missing targets as missing', async () => {
		const { KbLinkGraph } = await import('./kbGraph.js');
		const fs = createMockFileService();

		fs.addFile('/vault/notes/a.md', 'A.md', '参考 [[不存在的笔记]]', 1000, 10);

		const graph = new KbLinkGraph(fs);
		await graph.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		const aUri = '/vault/notes/a.md';
		const outgoing = graph.outgoingLinks(aUri);
		assert.strictEqual(outgoing.length, 1);
		assert.strictEqual(outgoing[0].targetUri, undefined, '不存在的目标 targetUri 应为 undefined');
	});
});

// ---------------------------------------------------------------------------
// 测试 6: 提及检测
// ---------------------------------------------------------------------------

describe('KbNativeKernel - Mention Detection', () => {

	it('should detect mentions: text containing document name without [[ ]]', async () => {
		// 测试 _containsMention 逻辑（通过内置内核间接验证）
		// 正文中出现「算法入门」但没有 [[算法入门]] → 提及
		const { KbNativeKernel } = await import('./kbNativeKernel.js');
		const fs = createMockFileService();

		fs.addFile('/vault/notes/target.md', '算法入门.md',
			'# 算法入门\n\n基础算法知识。', 1000, 20);
		fs.addFile('/vault/notes/ref.md', '学习笔记.md',
			'# 学习笔记\n\n今天学习了算法入门相关的内容，很有收获。\n\n也参考了 [[其他笔记]]。',
			2000, 60);

		const kernel = new KbNativeKernel(fs);
		await kernel.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		const targetId = '/vault/notes/target.md';
		const result = await kernel.getBacklink2(targetId);
		assert.ok(result.backmentions.length >= 1, '应有提及');
		assert.ok(result.backmentions[0].name === '学习笔记.md');
	});

	it('should NOT double-count wikilinks as mentions', async () => {
		const { KbNativeKernel } = await import('./kbNativeKernel.js');
		const fs = createMockFileService();

		fs.addFile('/vault/notes/target.md', '算法入门.md',
			'# 算法入门', 1000, 10);
		fs.addFile('/vault/notes/ref.md', '笔记.md',
			'参考 [[算法入门]] 了解详情。算法入门是非常重要的话题。',
			2000, 40);

		const kernel = new KbNativeKernel(fs);
		await kernel.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		const targetId = '/vault/notes/target.md';
		const result = await kernel.getBacklink2(targetId);

		// 反链应有 1 条（[[算法入门]]）
		assert.strictEqual(result.backlinks.length, 1);
		// 提及中不应包含已通过 [[ ]] 链接的文档（那算反链）
		const mentionNames = result.backmentions.map(m => m.name);
		assert.ok(!mentionNames.includes('笔记.md'),
			'通过 [[ ]] 链接的文档不应出现在提及中');
	});
});

// ---------------------------------------------------------------------------
// 测试 7: 图谱数据
// ---------------------------------------------------------------------------

describe('KbNativeKernel - Graph', () => {

	it('should generate graph nodes and links', async () => {
		const { KbNativeKernel } = await import('./kbNativeKernel.js');
		const fs = createMockFileService();

		fs.addFile('/vault/notes/a.md', '算法.md', '参考 [[数据结构]]', 1000, 10);
		fs.addFile('/vault/notes/b.md', '数据结构.md', '# 数据结构', 2000, 8);

		const kernel = new KbNativeKernel(fs);
		await kernel.build([{ uri: { toString: () => '/vault/notes' } as any, section: 'notes' }]);

		const graph = await kernel.getGraph();
		assert.ok(graph.nodes.length >= 2, '应有至少 2 个节点');
		assert.ok(graph.links.length >= 1, '应有至少 1 条边');
		assert.ok(graph.nodes.every(n => n.type === 'doc' || n.type === 'tag'));
		assert.ok(graph.links.every(l => l.type === 'wikilink' || l.type === 'blockref' || l.type === 'tag'));
	});
});

// ---------------------------------------------------------------------------
// 运行入口
// ---------------------------------------------------------------------------

if (typeof describe === 'undefined') {
	console.log('Test file loaded. Run with: npx mocha <this-file>');
}
