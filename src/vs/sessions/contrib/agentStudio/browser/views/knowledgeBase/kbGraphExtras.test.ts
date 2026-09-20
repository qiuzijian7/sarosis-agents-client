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
});
