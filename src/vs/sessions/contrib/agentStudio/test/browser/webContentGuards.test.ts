/*---------------------------------------------------------------------------------------------
 *  抓取正文的形状防护单测（对比 Hermes-Agent 后补上的缺口，2026-09-24）。
 *
 *  这些断言盯的是两类**会让正文消失或让上下文被污染**的情形（不是风格问题）：
 *    · 内联 base64 把 web_extract 的字符预算吃光 ⇒ 模型看到一堆 iVBORw0KGgo 而没有正文；
 *    · 二进制载荷（PDF/zip/SQLite）被当"页面内容"喂给模型 ⇒ 基于乱码推理。
 *  同时盯反向风险：**误伤**（把正常正文判成二进制、把普通文本里的 base64 字样改掉）。
 *
 *  运行：npm run test-agentstudio-browser
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	binaryPayloadMessage,
	detectBinaryPayload,
	stripInlineBase64,
} from '../../browser/providers/tool/webContentGuards.js';

/** ≥ 阈值的假载荷（80 个 base64 字符起）。 */
const LONG_B64 = 'A'.repeat(120);
const SHORT_B64 = 'A'.repeat(20);

suite('webContentGuards — 内联 base64 / 二进制载荷防护', () => {

	// ─── 内联 base64 ────────────────────────────────────────────────────

	test('★ markdown data-URI 图片 → [IMAGE: alt]（保住 alt 文本）', () => {
		const out = stripInlineBase64(`前文\n![架构图](data:image/png;base64,${LONG_B64})\n后文`);
		assert.strictEqual(out.replaced, 1);
		assert.ok(out.text.includes('[IMAGE: 架构图]'), out.text);
		assert.ok(!out.text.includes(LONG_B64), '载荷必须被清掉');
		assert.ok(out.text.includes('前文') && out.text.includes('后文'), '上下文必须保留');
	});

	test('alt 为空时退化成 [IMAGE]', () => {
		const out = stripInlineBase64(`![](data:image/png;base64,${LONG_B64})`);
		assert.strictEqual(out.text, '[IMAGE]');
	});

	test('★ HTML 属性 / CSS url() 里的 data-URI 也命中（通用兜底，与语法无关）', () => {
		const html = `<img src="data:image/png;base64,${LONG_B64}">`;
		const css = `body{background:url(data:image/gif;base64,${LONG_B64})}`;
		const htmlOut = stripInlineBase64(html);
		const cssOut = stripInlineBase64(css);
		assert.strictEqual(htmlOut.replaced, 1);
		assert.ok(htmlOut.text.includes('[inline image/png removed]'), htmlOut.text);
		assert.strictEqual(cssOut.replaced, 1);
		assert.ok(cssOut.text.includes('[inline image/gif removed]'), cssOut.text);
	});

	test('多个载荷各自计数，removedChars 反映省下的量', () => {
		const out = stripInlineBase64(`![a](data:image/png;base64,${LONG_B64})![b](data:image/jpeg;base64,${LONG_B64})`);
		assert.strictEqual(out.replaced, 2);
		assert.ok(out.removedChars >= LONG_B64.length * 2, `removedChars=${out.removedChars}`);
	});

	test('短载荷不动它（小图标剥了反而丢信息）', () => {
		const src = `![icon](data:image/gif;base64,${SHORT_B64})`;
		const out = stripInlineBase64(src);
		assert.strictEqual(out.replaced, 0);
		assert.strictEqual(out.text, src);
	});

	test('不含 ";base64," 的文本原样返回**同一引用**（热路径零成本短路）', () => {
		const src = '一段普通正文，里面提到 base64 编解码但不是 data URI。'.repeat(20);
		assert.strictEqual(stripInlineBase64(src).text, src);
	});

	test('正文里的 "base64" 字样与普通 data: 链接不受影响', () => {
		const src = '我们讨论 base64 与 https://example.com/a?data=xyz 这两种写法。';
		assert.strictEqual(stripInlineBase64(src).text, src);
	});

	// ─── 二进制载荷 ──────────────────────────────────────────────────────

	test('★★ 命中魔数：PDF / ZIP / SQLite / ELF / PNG / JPEG / GIF', () => {
		assert.strictEqual(detectBinaryPayload('%PDF-1.7\n%âãÏÓ'), 'PDF');
		assert.strictEqual(detectBinaryPayload('PK\u0003\u0004\u0014\u0000'), 'ZIP/Office 压缩包');
		assert.strictEqual(detectBinaryPayload('SQLite format 3\u0000'), 'SQLite 数据库');
		assert.strictEqual(detectBinaryPayload('\u007FELF\u0002\u0001\u0001'), 'ELF 可执行文件');
		assert.strictEqual(detectBinaryPayload('\u0089PNG\r\n\u001A\n'), 'PNG 图片');
		assert.strictEqual(detectBinaryPayload('\u00FF\u00D8\u00FF\u00E0'), 'JPEG 图片');
		assert.strictEqual(detectBinaryPayload('GIF89a\u0001\u0000'), 'GIF 图片');
	});

	test('★ "MZ" 开头但内容可打印 ⇒ 不当可执行文件（防误伤正常文本）', () => {
		// "MZ" 是 DOS 头，但完全可能是一段以 MZ 开头的正常文本（例如 "MZ 系列产品介绍…"）。
		assert.strictEqual(detectBinaryPayload(`MZ${'a'.repeat(300)}`), undefined);
	});

	test('"MZ" 开头且大量不可打印 ⇒ 判为可执行文件', () => {
		assert.strictEqual(detectBinaryPayload(`MZ${'\u0000'.repeat(300)}`), 'Windows 可执行文件');
	});

	test('★ 未收录的类型靠不可打印比例兜底', () => {
		assert.strictEqual(detectBinaryPayload('\u0001\u0002\u0003'.repeat(80)), '二进制数据（未识别的类型）');
	});

	test('★ 反向：正常中英文正文（含 emoji / 大量换行）不得误判', () => {
		const prose = ('这是一段正常的中文正文，句子长度足够长。\n'.repeat(20)) + 'mixed English text. 😀🎉\n'.repeat(10);
		assert.strictEqual(detectBinaryPayload(prose), undefined,
			'emoji 按 UTF-16 计长度会得出 0.5 的比例 → 误判成二进制（这正是 printableRatio 必须按码点计的原因）');
	});

	test('空串 / 未定义安全', () => {
		assert.strictEqual(detectBinaryPayload(''), undefined);
		assert.strictEqual(detectBinaryPayload(undefined as unknown as string), undefined);
	});

	test('★ 失败文案必须明确"不要把内容当页面正文"，并给出替代动作', () => {
		const msg = binaryPayloadMessage('https://x/f.pdf', 'PDF', 12345);
		assert.ok(msg.includes('Do NOT treat any part of this response as page content'), msg);
		assert.ok(msg.includes('execute_code'), '要给出可执行的下一步，而不是只说失败');
		assert.ok(msg.includes('https://x/f.pdf') && msg.includes('PDF'));
	});

});
