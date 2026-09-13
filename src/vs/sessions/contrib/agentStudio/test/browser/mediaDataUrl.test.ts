/*---------------------------------------------------------------------------------------------
 *  Unit test: data URL 解析（2026-09-12「媒体库视频点击后变黑」修复的纯函数部分）。
 *
 *  背景：媒体库视频把几 MB 的 mp4 **data URL** 直接赋给 `<video>` → Chromium 加载失败
 *  → **黑块** ✗。修法是解析成字节后建 **blob URL** 再喂给 `<video>` ✓。
 *  本测试锁定解析正确性（Blob/URL 的创建留在调用方 —— Node 无 createObjectURL）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { parseDataUrl } from '../../webview/src/features/workflowEditor/comfyHost/mediaDataUrl.js';

test('★ 解析 base64 data URL：mime 与字节正确', () => {
	// "hi" = 0x68 0x69
	const r = parseDataUrl('data:text/plain;base64,aGk=');
	assert.ok(r, '应解析成功');
	assert.strictEqual(r!.mime, 'text/plain');
	assert.deepStrictEqual(Array.from(r!.bytes), [0x68, 0x69]);
});

test('★ 视频 mime 与二进制字节（含 0x00，验证不是字符串截断）', () => {
	// 0x00 0x01 0xFF → base64 "AAH/"
	const r = parseDataUrl('data:video/mp4;base64,AAH/');
	assert.strictEqual(r!.mime, 'video/mp4');
	assert.deepStrictEqual(Array.from(r!.bytes), [0x00, 0x01, 0xFF]);
});

test('★ 无 mime / 百分号编码形态', () => {
	const noMime = parseDataUrl('data:;base64,aGk=');
	assert.strictEqual(noMime!.mime, 'application/octet-stream', '缺 mime 应回退通用类型');

	const pct = parseDataUrl('data:text/plain,hi%20there');
	assert.deepStrictEqual(Array.from(pct!.bytes), Array.from('hi there').map(c => c.charCodeAt(0)));
});

test('★ 非法输入返回 null（调用方回退原 URL，不炸）', () => {
	assert.strictEqual(parseDataUrl(''), null);
	assert.strictEqual(parseDataUrl('blob:http://x/y'), null);
	assert.strictEqual(parseDataUrl('data:video/mp4;base64'), null, '缺逗号 → null');
	assert.strictEqual(parseDataUrl('data:video/mp4;base64,!!!not-base64!!!'), null, '坏 base64 → null');
});
