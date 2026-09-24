/*---------------------------------------------------------------------------------------------
 *  kbArchiveExtract 单测 —— epub/docx → Markdown（★ 2026-09-24「A 方案」的解析核心）。
 *
 *  为什么这里自己造 zip：本模块的价值就是**零外部依赖**地解 zip，
 *  用真实二进制样本反而会让测试依赖样本文件；这里用 Node 的 `deflateRawSync` 现场构造
 *  zip（含 stored 与 deflate 两种方式），既覆盖解压路径，也覆盖「中央目录」读取。
 *  ⚠ 本模块**不校验 CRC**（只读 size/method）⇒ 测试可以写 0，不必引 crc32 实现。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { deflateRawSync } from 'zlib';
import { decodeEntities, docxToMarkdown, epubSpine, extractArchiveMarkdown, htmlToMarkdown, readZipEntries } from './kbArchiveExtract.js';
import { KB_DOC_SOURCE_EXTENSIONS } from './kbDocConvertChannel.js';

/** 现场构造一个 zip（stored / deflate 都能造）。 */
function makeZip(entries: Array<{ name: string; content: string; stored?: boolean }>): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const raw = Buffer.from(e.content, 'utf8');
		const data = e.stored ? raw : deflateRawSync(raw);
		const name = Buffer.from(e.name, 'utf8');

		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(e.stored ? 0 : 8, 8);
		lh.writeUInt32LE(0, 14);              // crc（读取侧不校验）
		lh.writeUInt32LE(data.length, 18);
		lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(name.length, 26);
		parts.push(lh, name, data);

		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(e.stored ? 0 : 8, 10);
		ch.writeUInt32LE(data.length, 20);
		ch.writeUInt32LE(raw.length, 24);
		ch.writeUInt16LE(name.length, 28);
		ch.writeUInt32LE(offset, 42);
		central.push(ch, name);

		offset += 30 + name.length + data.length;
	}
	const cen = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cen.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, cen, eocd]);
}

const DOCX_XML = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>
<w:p><w:r><w:t>第一段：</w:t></w:r><w:r><w:t>含 &amp; 与 &#x4e2d;文。</w:t></w:r></w:p>
<w:tbl>
  <w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>营收</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>结尾段落</w:t></w:r></w:p>
</w:body></w:document>`;

const CONTAINER_XML = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const OPF_XML = `<?xml version="1.0"?><package><manifest>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
const CH1 = `<html><head><title>第一章 起源</title></head><body><h1>第一章 起源</h1><p>很久很久以前 &amp; 之后。</p></body></html>`;
const CH2 = `<html><head><title>第二章 发展</title></head><body><p>正文没有标题</p><ul><li>要点一</li><li>要点二</li></ul></body></html>`;

function makeEpub(): Buffer {
	return makeZip([
		{ name: 'mimetype', content: 'application/epub+zip', stored: true },
		{ name: 'META-INF/container.xml', content: CONTAINER_XML },
		{ name: 'OEBPS/content.opf', content: OPF_XML },
		{ name: 'OEBPS/ch1.xhtml', content: CH1 },
		{ name: 'OEBPS/ch2.xhtml', content: CH2 },
		{ name: 'OEBPS/nav.xhtml', content: '<html><body><p>不在 spine 里</p></body></html>' },
	]);
}

suite('kbArchiveExtract · epub/docx → Markdown', () => {

	test('docx：标题样式 → #，段落合并，表格 → markdown 表格，实体解码', () => {
		const buf = makeZip([
			{ name: '[Content_Types].xml', content: '<Types/>' },
			{ name: 'word/document.xml', content: DOCX_XML },
		]);
		const r = extractArchiveMarkdown('报告.docx', buf);
		assert.ok(r.ok, `应解析成功：${r.error}`);
		const md = r.markdown!;
		assert.ok(md.includes('# 季度报告'), 'Heading1 应转成一级标题');
		assert.ok(md.includes('第一段：含 & 与 中文。'), 'run 应拼接、实体应解码');
		assert.ok(md.includes('| 指标 | 值 |'), '表格首行应转成 markdown 表头');
		assert.ok(md.includes('| --- | --- |'), '表格分隔行应存在');
		assert.ok(md.includes('| 营收 | 100 |'), '表格数据行应存在');
		assert.ok(md.includes('结尾段落'), '表格之后的段落不能丢');
	});

	test('docx：stored(0) 压缩方式同样可读（不是所有写入器都用 deflate）', () => {
		const buf = makeZip([{ name: 'word/document.xml', content: DOCX_XML, stored: true }]);
		const r = extractArchiveMarkdown('a.docx', buf);
		assert.ok(r.ok && r.markdown!.includes('# 季度报告'));
	});

	test('epub：按 spine 顺序取章节（manifest 顺序不算），忽略不在 spine 的文件', () => {
		const r = extractArchiveMarkdown('book.epub', makeEpub());
		assert.ok(r.ok, `应解析成功：${r.error}`);
		const md = r.markdown!;
		assert.strictEqual(r.chapters, 2, '只应有 2 章（nav.xhtml 不在 spine）');
		assert.ok(md.includes('第一章 起源'), '第一章内容应在');
		assert.ok(md.includes('第二章 发展'), '第二章内容应在');
		assert.ok(!md.includes('不在 spine 里'), '非 spine 文件不得混入');
		assert.ok(md.indexOf('第一章') < md.indexOf('第二章'), '章节顺序必须按 spine');
		assert.ok(md.includes('很久很久以前 & 之后。'), 'HTML 实体应解码');
		assert.ok(md.includes('- 要点一'), '列表应转成 markdown 列表');
		assert.ok(md.includes('## 第二章 发展'), '无自带标题的章节应补上章标题');
	});

	test('epub：OPF 路径相对 OPF 目录解析（`../` 也要能收敛）', () => {
		const buf = makeZip([
			{ name: 'META-INF/container.xml', content: '<container><rootfiles><rootfile full-path="OEBPS/sub/content.opf"/></rootfiles></container>' },
			{ name: 'OEBPS/sub/content.opf', content: '<package><manifest><item id="c1" href="../ch1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>' },
			{ name: 'OEBPS/ch1.xhtml', content: '<html><body><p>第一章正文</p></body></html>' },
		]);
		const r = extractArchiveMarkdown('b.epub', buf);
		assert.ok(r.ok, `应能按 OPF 目录解析相对 href：${r.error}`);
		assert.ok(r.markdown!.includes('第一章正文'));
	});

	test('错误路径：非 zip / 缺关键文件 / 不支持的类型 都给出可读原因', () => {
		const notZip = extractArchiveMarkdown('x.docx', Buffer.from('这不是 zip'));
		assert.ok(!notZip.ok && /不是有效的 zip/.test(notZip.error!), `应指出不是 zip：${notZip.error}`);

		const noDoc = extractArchiveMarkdown('x.docx', makeZip([{ name: 'a.txt', content: 'hi' }]));
		assert.ok(!noDoc.ok && /word\/document\.xml/.test(noDoc.error!), '应指出缺少 document.xml');

		const noOpf = extractArchiveMarkdown('x.epub', makeZip([{ name: 'META-INF/container.xml', content: '<container/>' }]));
		assert.ok(!noOpf.ok && /OPF/.test(noOpf.error!), '应指出缺少 OPF');

		const wrongExt = extractArchiveMarkdown('x.pdf', makeZip([]));
		assert.ok(!wrongExt.ok && /不支持的类型/.test(wrongExt.error!));

		const empty = extractArchiveMarkdown('x.docx', Buffer.alloc(0));
		assert.ok(!empty.ok && /为空/.test(empty.error!));
	});

	test('readZipEntries：损坏的中央目录要报错而不是静默返回空', () => {
		const ok = makeZip([{ name: 'a.txt', content: 'hi' }]);
		assert.ok(Array.isArray(readZipEntries(ok)), '正常 zip 应返回条目数组');
		const broken = Buffer.from(ok);
		broken.writeUInt32LE(0x12345678, broken.length - 22);   // 破坏 EOCD 签名
		assert.strictEqual(typeof readZipEntries(broken), 'string', '应返回错误文案');
	});

	test('★ 防漂移：KB 素材清单与提取器能力一致（.pdf 走 python、.epub/.docx 走本模块）', () => {
		assert.deepStrictEqual([...KB_DOC_SOURCE_EXTENSIONS].sort(), ['.docx', '.epub', '.pdf'],
			'素材清单变了就要同步「提取器支持哪些」和聊天框的 DOCUMENT_EXTENSIONS');
		assert.ok(extractArchiveMarkdown('a.epub', makeEpub()).ok, 'epub 由本模块负责');
		assert.ok(extractArchiveMarkdown('a.docx', makeZip([{ name: 'word/document.xml', content: DOCX_XML }])).ok, 'docx 由本模块负责');
		assert.ok(!extractArchiveMarkdown('a.pdf', Buffer.alloc(8)).ok, 'pdf 不该走本模块（那是主进程 python 分支）');
	});

	test('纯函数：htmlToMarkdown / decodeEntities / docxToMarkdown / epubSpine 可独立使用', () => {
		assert.strictEqual(decodeEntities('&lt;a&gt; &amp; &#65; &nbsp;'), '<a> & A  ');
		// 未知实体降级为空格（避免正文里残留 &xxx; 噪声）
		assert.strictEqual(decodeEntities('a&unknown;b'), 'a b');
		assert.ok(htmlToMarkdown('<script>var x=1</script><h2>T</h2><p>P</p><li>L</li>').includes('## T'));
		assert.ok(!htmlToMarkdown('<style>.a{color:red}</style><p>P</p>').includes('color:red'), '样式内容不得进正文');
		assert.strictEqual(docxToMarkdown('<w:body><w:p><w:r><w:t>只有一段</w:t></w:r></w:p></w:body>'), '只有一段');
		assert.deepStrictEqual(
			epubSpine(OPF_XML, 'OEBPS'),
			['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml'],
			'epubSpine 应按 spine 顺序解析出路径',
		);
	});
});
