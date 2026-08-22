/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 子进程输出解码回归测试（2026-08-22，日志 1787363991734）。
 *
 * 事故：PowerShell 中文错误进入 LLM 上下文时是 mojibake `�Ҳ���·��`，模型读到乱码
 * 无法自纠。两个独立缺陷：① 按 UTF-8 解 CP936 字节 ② 逐 chunk 解码切断多字节字符。
 *
 * 最关键的两组断言：
 *  - **不得回归**：合法 UTF-8 必须原样解出（否则修 mojibake 会把正常输出弄坏）
 *  - **跨 chunk**：字符被切在 chunk 边界时，整体解码必须仍然正确
 */

import assert from 'assert';
import { decodeProcessOutput, ProcessOutputCollector } from '../../common/processOutputDecoder.js';

/** "找不到路径" 的 CP936 字节（日志事故的原始字节）。 */
const GBK_NOT_FOUND = new Uint8Array([0xD5, 0xD2, 0xB2, 0xBB, 0xB5, 0xBD, 0xC2, 0xB7, 0xBE, 0xB6]);

const utf8 = (s: string) => new TextEncoder().encode(s);

suite('processOutputDecoder — decodeProcessOutput', () => {

	test('★ 日志事故字节：CP936 中文正确解码（不再是 mojibake）', () => {
		const r = decodeProcessOutput(GBK_NOT_FOUND, 'cp936');
		assert.strictEqual(r.text, '找不到路径');
		assert.strictEqual(r.usedFallback, true);
	});

	test('★ 复现旧 bug 以防测试自欺：按 UTF-8 解同一串字节确实是乱码', () => {
		const wrong = new TextDecoder('utf-8').decode(GBK_NOT_FOUND);
		assert.strictEqual(wrong, '\uFFFD\u04B2\uFFFD\uFFFD\uFFFD\u00B7\uFFFD\uFFFD',
			'这正是日志里模型收到的内容');
		assert.notStrictEqual(wrong, '找不到路径');
	});

	test('★★ 合法 UTF-8 必须原样解出（防止修 mojibake 反而弄坏正常输出）', () => {
		for (const s of [
			'compiled 42 files',
			'编译完成，共 42 个文件',
			'error TS2322: 类型不匹配',
			'emoji 🎉 ok',
			'mixed 中文 and English',
		]) {
			const r = decodeProcessOutput(utf8(s), 'cp936');
			assert.strictEqual(r.text, s, s);
			assert.strictEqual(r.usedFallback, false, `${s} 不应回退`);
		}
	});

	test('★ localEncoding 未探测到时仍能用 gbk 回退', () => {
		assert.strictEqual(decodeProcessOutput(GBK_NOT_FOUND, undefined).text, '找不到路径');
	});

	test('★ cp936 必须被映射（TextDecoder 不认这个名字）', () => {
		// 实测 new TextDecoder('cp936') 抛 "encoding is not supported"
		assert.throws(() => new TextDecoder('cp936'), /not supported/i,
			'确认 cp936 确实不被支持 —— 所以映射层是必需的');
		// 而映射后能工作
		assert.strictEqual(decodeProcessOutput(GBK_NOT_FOUND, 'cp936').text, '找不到路径');
	});

	test('剥掉 UTF-8 BOM（PowerShell Out-File 默认带 BOM）', () => {
		const withBom = new Uint8Array([0xEF, 0xBB, 0xBF, ...utf8('hello')]);
		assert.strictEqual(decodeProcessOutput(withBom, 'cp936').text, 'hello');
	});

	test('识别并解码 UTF-16LE BOM（PowerShell 5.1 某些重定向输出）', () => {
		// "hi" in UTF-16LE with BOM
		const u16 = new Uint8Array([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]);
		const r = decodeProcessOutput(u16, 'cp936');
		assert.strictEqual(r.text, 'hi');
		assert.strictEqual(r.encoding, 'utf-16le');
	});

	test('空输入 → 空串，不抛异常', () => {
		const r = decodeProcessOutput(new Uint8Array(0), 'cp936');
		assert.strictEqual(r.text, '');
		assert.strictEqual(r.usedFallback, false);
	});

	test('★ 纯 ASCII 走 UTF-8 快路径（绝大多数命令输出）', () => {
		const r = decodeProcessOutput(utf8('npm WARN deprecated\nadded 120 packages'), 'cp936');
		assert.strictEqual(r.encoding, 'utf-8');
		assert.strictEqual(r.usedFallback, false);
	});

	test('未知编码名 → 落到候选链，不抛异常', () => {
		const r = decodeProcessOutput(GBK_NOT_FOUND, 'cp437');
		assert.ok(r.text.length > 0, '必须有输出而非抛错');
	});

	test('encoding 字段记录实际路径（便于日志复盘）', () => {
		assert.strictEqual(decodeProcessOutput(utf8('ok'), 'cp936').encoding, 'utf-8');
		assert.strictEqual(decodeProcessOutput(GBK_NOT_FOUND, 'cp936').encoding, 'gbk');
	});
});

suite('processOutputDecoder — ProcessOutputCollector（跨 chunk 边界）', () => {

	test('★★ UTF-8 汉字被切在 chunk 边界 → 整体解码仍正确', () => {
		// "中文" = E4 B8 AD E6 96 87，故意切在第一个字符中间
		const full = utf8('中文');
		const c = new ProcessOutputCollector();
		c.push(full.subarray(0, 2));   // E4 B8 —— 不完整
		c.push(full.subarray(2));      // AD E6 96 87
		assert.strictEqual(c.decode('cp936'), '中文',
			'这是原实现 `stdout += d.toString()` 必然出错的场景');
	});

	test('★★ GBK 汉字被切在 chunk 边界 → 整体解码仍正确', () => {
		const c = new ProcessOutputCollector();
		c.push(GBK_NOT_FOUND.subarray(0, 3));   // 切在第二个汉字中间
		c.push(GBK_NOT_FOUND.subarray(3));
		assert.strictEqual(c.decode('cp936'), '找不到路径');
	});

	test('★ 复现旧 bug：逐 chunk 解码确实会产生乱码', () => {
		const full = utf8('中文');
		const perChunk = new TextDecoder('utf-8').decode(full.subarray(0, 2))
			+ new TextDecoder('utf-8').decode(full.subarray(2));
		assert.notStrictEqual(perChunk, '中文', '逐 chunk 解码必然出错');
		assert.match(perChunk, /\uFFFD/, '边界字符变成替换字符');
	});

	test('逐字节推入（最恶劣分块）仍正确', () => {
		const c = new ProcessOutputCollector();
		for (const b of utf8('中文测试 mixed 🎉')) { c.push(new Uint8Array([b])); }
		assert.strictEqual(c.decode('cp936'), '中文测试 mixed 🎉');
	});

	test('byteLength 累计正确（用于超限保护）', () => {
		const c = new ProcessOutputCollector();
		c.push(new Uint8Array(10));
		c.push(new Uint8Array(5));
		assert.strictEqual(c.byteLength, 15);
	});

	test('★ decode 可多次调用（超时路径先读一次，close 再读）', () => {
		const c = new ProcessOutputCollector();
		c.push(utf8('partial'));
		assert.strictEqual(c.decode(), 'partial');
		c.push(utf8(' more'));
		assert.strictEqual(c.decode(), 'partial more', '第二次必须包含全部内容');
	});

	test('空 collector → 空串', () => {
		assert.strictEqual(new ProcessOutputCollector().decode('cp936'), '');
	});
});
