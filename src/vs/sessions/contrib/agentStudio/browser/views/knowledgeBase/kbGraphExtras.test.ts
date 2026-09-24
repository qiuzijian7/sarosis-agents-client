/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbGraphExtras.test.ts — KbLinkGraph 单文档即时更新 API 测试（tdd 风格，通用 runner 直跑）。
 *
 *  覆盖：
 *   1. removeDoc — 节点 / name+title 注册 / 出链 / 反向索引 / 文本缓存即时清理
 *   2. removeDocsUnder — 目录前缀批量清理
 *   3. upsertDoc — 重命名/保存后出边即时替换
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbGraphExtras.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { KbLinkGraph } from './kbGraph.js';

function graph(): { g: KbLinkGraph; id: (name: string) => string } {
	const g = new KbLinkGraph({} as any);
	const docs = [
		{ uri: URI.file('/vault/库/概念/a.md'), name: 'a.md', section: 'library' as const, mtime: 1, text: '---\ntitle: Alpha\n---\n引用 [[b]] 与 [[c]]。' },
		{ uri: URI.file('/vault/库/概念/b.md'), name: 'b.md', section: 'library' as const, mtime: 2, text: '# B\n引用 [[c]]。' },
		{ uri: URI.file('/vault/库/会议/c.md'), name: 'c.md', section: 'library' as const, mtime: 3, text: '# C\n无出链。' },
	];
	g.buildFromDocs(docs);
	const id = (name: string) => docs.find(d => d.name === name)!.uri.toString();
	return { g, id };
}

suite('KbLinkGraph 单文档即时更新', () => {

	test('removeDoc：节点与边即时消失（反链不再命中）', () => {
		const { g, id } = graph();
		assert.strictEqual(g.getGraphData().nodes.length, 3);
		// a → b、c；b → c
		assert.strictEqual(g.backlinks(id('c.md')).length, 2, 'c 有 a/b 两个反链');

		g.removeDoc(URI.parse(id('b.md')));
		const data = g.getGraphData();
		assert.strictEqual(data.nodes.length, 2, '节点数减一');
		assert.ok(data.links.every(l => l.source !== id('b.md') && l.target !== id('b.md')), '所有涉 b 的边消失');
		assert.strictEqual(g.backlinks(id('c.md')).length, 1, 'c 的反链只剩 a');
		assert.strictEqual(g.backlinks(id('b.md')).length, 0, 'b 自身反链清空');
	});

	test('removeDocsUnder：目录前缀批量清理', () => {
		const { g, id } = graph();
		g.removeDocsUnder(URI.file('/vault/库/概念'));
		const data = g.getGraphData();
		assert.strictEqual(data.nodes.length, 1, '只剩会议目录的 c');
		assert.strictEqual(data.nodes[0].id, id('c.md'));
	});

	test('upsertDoc：出边按新文本即时替换（改名/编辑场景）', () => {
		const { g, id } = graph();
		// a.md 改内容：不再引用 b，改为只引用 c（且新增 frontmatter title 变更）
		g.upsertDoc(URI.parse(id('a.md')), 'a.md', 'library', 10, '---\ntitle: Alpha2\n---\n只引用 [[c]]。');
		const out = g.outgoingLinks(id('a.md'));
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].targetName, 'c');
		assert.strictEqual(g.backlinks(id('b.md')).length, 0, 'b 失去来自 a 的反链');
		assert.strictEqual(g.backlinks(id('c.md')).length, 2, 'c 仍有 a/b 两个反链');
		// title 注册更新：[[Alpha2]] 可解析到 a
		const viaTitle = g.outgoingLinks(id('a.md'))[0];
		assert.ok(viaTitle.targetUri, 'c 可解析');
	});

	test('upsertDoc：系统文件与不支持类型被跳过', () => {
		const { g, id } = graph();
		g.upsertDoc(URI.parse(id('a.md')), 'index.md', 'library', 10, '引用 [[b]]');
		// a 的原节点已移除，index.md 不进图谱
		assert.strictEqual(g.getGraphData().nodes.length, 2);
	});

	test('路径形 / file:// URI 形目标归一到文件名后解析（★ 2026-09-24 双链解析错误修复）', () => {
		const g = new KbLinkGraph({} as any);
		g.buildFromDocs([
			{ uri: URI.file('/vault/库/raw/UI优化篇.md'), name: 'UI优化篇.md', section: 'library' as const, mtime: 1, text: '# UI优化篇' },
			{
				uri: URI.file('/vault/笔记/索引.md'), name: '索引.md', section: 'notes' as const, mtime: 2, text: [
					'---', 'title: 索引', '---',
					'sources:',
					'  - "[[raw/UI优化篇.md]]"',                                        // ① 相对路径形（构建产物的溯源写法）
					'',
					'正文引用：[[库/raw/UI优化篇.md]]',                                // ② 带「库/」前缀的路径形
					'URI 形：[[file:///e:/VsSarosVault/库/raw/UI优化篇.md]]',              // ③ file:// URI（未编码）
					'编码 URI：[[file:///e%3A/VsSarosVault/%E5%BA%93/raw/UI%E4%BC%98%E5%8C%96%E7%AF%87.md]]', // ④ 百分号编码 URI
				].join('\n'),
			},
		]);
		const out = g.outgoingLinks(URI.file('/vault/笔记/索引.md').toString());
		assert.strictEqual(out.length, 4, '四种写法的链接都被解析出来');
		const target = URI.file('/vault/库/raw/UI优化篇.md').toString();
		assert.ok(out.every(o => o.targetUri?.toString() === target), '四种写法都解析到同一篇笔记');
		});

		test('出链 label 可读化（★ 2026-09-24「优化出链显示」）：URI/路径形目标不再显示编码原文', () => {
		const g = new KbLinkGraph({} as any);
		g.buildFromDocs([
			{ uri: URI.file('/vault/库/raw/UI优化篇.md'), name: 'UI优化篇.md', section: 'library' as const, mtime: 1, text: '# UI优化篇\n（无 frontmatter title）' },
			{ uri: URI.file('/vault/笔记/有标题.md'), name: '有标题.md', section: 'notes' as const, mtime: 1, text: '---\ntitle: 真正的标题\n---\n' },
			{
				uri: URI.file('/vault/笔记/索引.md'), name: '索引.md', section: 'notes' as const, mtime: 2, text: [
					'编码 URI：[[file:///e%3A/VsSarosVault/%E5%BA%93/raw/UI%E4%BC%98%E5%8C%96%E7%AF%87.md]]',
					'路径形：[[库/raw/UI优化篇.md]]',
					'带别名：[[库/raw/UI优化篇.md|UI 优化]]',
					'标题优先：[[有标题]]',
					'断链 URI：[[file:///e%3A/VsSarosVault/%E5%BA%93/raw/%E4%B8%8D%E5%AD%98%E5%9C%A8.md]]',
				].join('\n'),
			},
		]);
		const labels = g.outgoingLinks(URI.file('/vault/笔记/索引.md').toString()).map(o => o.label);
		assert.deepStrictEqual(labels, [
			'UI优化篇',      // 编码 URI ⇒ 已解析 ⇒ 目标文件名（去扩展名）
			'UI优化篇',      // 路径形 ⇒ 同上
			'UI 优化',       // 显式别名优先
			'真正的标题',     // 已解析且有 frontmatter title ⇒ title 优先于文件名
			'不存在',        // 断链 URI ⇒ 解码 + basename + 去扩展名（至少可读）
		]);
		});
});
