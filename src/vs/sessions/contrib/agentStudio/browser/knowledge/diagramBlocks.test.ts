/*---------------------------------------------------------------------------------------------
 *  图表代码块的提取与替换（纯函数）单元测试 —— 2026-09-23
 *
 *  这是「mermaid/drawio → PNG → 飞书」链路的**第一段**（找块 / 换块），也是最容易写错的一段：
 *  区间算错会误删正文、换块时不留空行会让飞书插图（block_replace 整块替换）吃掉同段文字。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/browser/knowledge/diagramBlocks.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { extractDiagramBlocks, replaceDiagramBlock } from './diagramBlocks.js';

const md = (...lines: string[]) => lines.join('\n');

suite('图表代码块：提取（extractDiagramBlocks）', () => {
	test('mermaid 块：拿到 kind / 源码 / 能精确回切原文', () => {
		const doc = md('# 标题', '', '```mermaid', 'graph TD', '  A-->B', '```', '', '正文', '');
		const blocks = extractDiagramBlocks(doc);
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].kind, 'mermaid');
		assert.strictEqual(blocks[0].source, 'graph TD\n  A-->B');
		// 区间必须能回切出原始片段（否则替换会错位）
		assert.strictEqual(doc.slice(blocks[0].start, blocks[0].end), blocks[0].raw);
		assert.ok(blocks[0].raw.startsWith('```mermaid'));
	});

	test('drawio：```drawio 与 ```xml(<mxfile>) 都识别；裸 XML 不提取（无法定位替换边界）', () => {
		const byLabel = extractDiagramBlocks(md('```drawio', '<mxfile/>', '```'));
		assert.strictEqual(byLabel.length, 1, `\`\`\`drawio 应被识别（实际 ${byLabel.length} 个块，kind=${String(byLabel[0]?.kind)}）`);
		assert.strictEqual(byLabel[0]?.kind, 'drawio');
		const byXml = extractDiagramBlocks(md('```xml', '<mxfile><diagram/></mxfile>', '```'));
		assert.strictEqual(byXml[0]?.kind, 'drawio');
		// ⚠ 自闭合写法（`<mxGraphModel/>`）也必须识别 —— 曾经被漏掉（回归钉）
		const byMx = extractDiagramBlocks(md('```xml', '<mxGraphModel/>', '```'));
		assert.strictEqual(byMx[0]?.kind, 'drawio', '自闭合 <mxGraphModel/> 应识别为 drawio');
		const byMxOpen = extractDiagramBlocks(md('```xml', '<mxGraphModel dx="1">', '```'));
		assert.strictEqual(byMxOpen[0]?.kind, 'drawio');
		// 裸 XML：没有围栏 ⇒ 不当作可替换块（同步侧另有告警）
		assert.deepStrictEqual(extractDiagramBlocks('前面 <mxfile>x</mxfile> 后面'), []);
	});

	test('普通代码块 / 无标签的普通 xml 不得误提取', () => {
		assert.deepStrictEqual(extractDiagramBlocks(md('```js', 'const a = 1;', '```')), []);
		assert.deepStrictEqual(extractDiagramBlocks(md('```xml', '<note>x</note>', '```')), [],
			'非 drawio 的 xml 不应被当作图表');
		assert.deepStrictEqual(extractDiagramBlocks(md('```', 'plain', '```')), []);
	});

	test('多个块：按出现顺序，且区间互不重叠', () => {
		const doc = md('A', '', '```mermaid', 'g1', '```', '', '中间', '', '```mermaid', 'g2', '```', '尾');
		const blocks = extractDiagramBlocks(doc);
		assert.strictEqual(blocks.length, 2);
		assert.deepStrictEqual(blocks.map(b => b.source), ['g1', 'g2']);
		assert.ok(blocks[0].end <= blocks[1].start, '区间不得重叠');
	});

	test('未闭合围栏不当作代码块（避免把后面整篇正文吃掉）', () => {
		assert.deepStrictEqual(extractDiagramBlocks(md('```mermaid', 'graph TD', '没闭合的正文')), []);
	});

	test('~~ 波浪围栏同样支持', () => {
		const blocks = extractDiagramBlocks(md('~~~mermaid', 'graph TD', '~~~'));
		assert.strictEqual(blocks.length, 1);
		assert.strictEqual(blocks[0].source, 'graph TD');
	});
});

suite('图表代码块：替换为图片引用（replaceDiagramBlock）', () => {
	test('★ 源码块被换成图片引用，且**独占段落**（前后必须有空行）', () => {
		const doc = md('# 标题', '', '```mermaid', 'graph TD', '  A-->B', '```', '', '正文', '');
		const blocks = extractDiagramBlocks(doc);
		const out = replaceDiagramBlock(doc, blocks[0], 'assets/note/chart-1.png');

		assert.ok(out.includes('![[assets/note/chart-1.png]]'), '应写入图片引用');
		assert.ok(!out.includes('```mermaid'), '源码围栏应消失');
		assert.ok(!out.includes('A-->B'), '源码正文应消失');
		// ⚠ 关键：飞书插图走 block_replace（整块替换）⇒ 引用必须独占段落
		assert.match(out, /\n\n!\[\[assets\/note\/chart-1\.png\]\]\n\n/, '图片引用必须独占段落');
		// 其余内容逐字保留
		assert.ok(out.includes('# 标题'));
		assert.ok(out.includes('正文'));
	});

	test('文件开头就是图表块 ⇒ 不产生多余的前导空行', () => {
		const doc = md('```mermaid', 'g', '```', '', '后续正文');
		const blocks = extractDiagramBlocks(doc);
		const out = replaceDiagramBlock(doc, blocks[0], 'a.png');
		assert.ok(!out.startsWith('\n'), '不应以空行开头');
		assert.ok(out.includes('![[a.png]]'));
		assert.ok(out.includes('后续正文'));
	});

	test('★ 多块逐个替换后互不影响（按原始区间操作，不重新解析）', () => {
		const doc = md('A', '', '```mermaid', 'g1', '```', '', '中间', '', '```mermaid', 'g2', '```', '尾');
		const blocks = extractDiagramBlocks(doc);
		// 从后往前替换，避免前面的替换使后面的区间失效
		let out = doc;
		for (const b of [...blocks].reverse()) { out = replaceDiagramBlock(out, b, `${b.source}.png`); }
		assert.ok(out.includes('![[g1.png]]') && out.includes('![[g2.png]]'), '两块都应被替换');
		assert.ok(!out.includes('```mermaid'), '不应残留源码块');
		assert.ok(out.includes('A') && out.includes('中间') && out.includes('尾'), '正文与间隔文字保留');
	});

	test('drawio 块同样可替换（`.drawio` 附件引用不受影响，那是另一条路径）', () => {
		const doc = md('```xml', '<mxfile><diagram/></mxfile>', '```');
		const blocks = extractDiagramBlocks(doc);
		const out = replaceDiagramBlock(doc, blocks[0], 'assets/d/drawio-1.png');
		assert.ok(out.includes('![[assets/d/drawio-1.png]]'));
		assert.ok(!out.includes('<mxfile>'));
	});
});
