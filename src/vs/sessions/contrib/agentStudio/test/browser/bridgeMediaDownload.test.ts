/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 入站媒体下载（飞书图片/文件，2026-09-23）的纯函数用例。
 *
 * 工厂 `createMainProcessBinaryDownload` 依赖主进程通道（在飞书平台用例里以桩替换），
 * 这里只钉住三处容易写错的换算：base64 → 字节、mime 归一、按扩展名兜底。
 */

import assert from 'assert';
import { base64ToBytes, guessMimeFromName, normalizeMime } from '../../browser/bridge/bridgeMediaDownload.js';

suite('入站媒体下载 · 纯函数', () => {
	test('base64 → 字节：按**字节**还原（不是字符码），空串安全', () => {
		assert.deepStrictEqual(Array.from(base64ToBytes('AQID')), [1, 2, 3]);
		// 0xFF 0xD8 0xFF = JPEG 文件头；用错解码方式（如直接 charCodeAt）会得到别的值
		assert.deepStrictEqual(Array.from(base64ToBytes('/9j/')), [0xff, 0xd8, 0xff]);
		assert.strictEqual(base64ToBytes('').length, 0);
	});

	test('normalizeMime：剥掉 charset 参数；非法/空值返回 undefined（不误当 mime 用）', () => {
		assert.strictEqual(normalizeMime('image/png; charset=binary'), 'image/png');
		assert.strictEqual(normalizeMime('  application/pdf  '), 'application/pdf');
		assert.strictEqual(normalizeMime(undefined), undefined);
		assert.strictEqual(normalizeMime(''), undefined);
		assert.strictEqual(normalizeMime('garbage'), undefined, '没有 "/" 的串不算 mime ✗✓');
	});

	test('guessMimeFromName：按扩展名猜（大小写不敏感），未知/缺名按类型兜底', () => {
		assert.strictEqual(guessMimeFromName('报表.XLSX', 'file'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
		assert.strictEqual(guessMimeFromName('a.PNG', 'image'), 'image/png');
		assert.strictEqual(guessMimeFromName('note.md', 'file'), 'text/markdown');
		assert.strictEqual(guessMimeFromName('voice.opus', 'file'), 'audio/opus');
		// 兜底：图片给 image/png，文件给八位字节流（宁可是通用值，也不要猜错成图片）
		assert.strictEqual(guessMimeFromName('weird.zzz', 'image'), 'image/png');
		assert.strictEqual(guessMimeFromName('weird.zzz', 'file'), 'application/octet-stream');
		assert.strictEqual(guessMimeFromName(undefined, 'file'), 'application/octet-stream');
	});
});
