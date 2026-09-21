/*---------------------------------------------------------------------------------------------
 *  assetPath.test.ts — 图文显示的图片 src 解析纯函数测试（node:test）。
 *  运行：node src/vs/sessions/contrib/agentStudio/webview/src/kbMarkdown/__tests__/run-assetpath-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRelativeRef, resolveAssetSrc, isMediaAssetSrc, mediaAssetId } from '../assetPath.js';

const BASE = 'https://file+.vscode-resource.vscode-cdn.net/vault/库/概念';

test('normalizeRelativeRef：去 ./ 与多余分隔符', () => {
	assert.equal(normalizeRelativeRef('./img/x.png'), 'img/x.png');
	assert.equal(normalizeRelativeRef('x.png'), 'x.png');
	assert.equal(normalizeRelativeRef('.//img//x.png'), 'img/x.png');
});

test('normalizeRelativeRef：../ 上溯', () => {
	assert.equal(normalizeRelativeRef('../shared/x.png'), 'shared/x.png');
	assert.equal(normalizeRelativeRef('a/b/../../x.png'), 'x.png');
});

test('resolveAssetSrc：相对路径拼接 assetBaseUri 并逐段编码', () => {
	assert.equal(
		resolveAssetSrc('图片/截 图.png', BASE),
		`${BASE}/${encodeURIComponent('图片')}/${encodeURIComponent('截 图.png')}`,
	);
	assert.equal(resolveAssetSrc('./a.png', BASE), `${BASE}/a.png`);
	// 尾斜杠容忍
	assert.equal(resolveAssetSrc('a.png', BASE + '/'), `${BASE}/a.png`);
});

test('resolveAssetSrc：绝对/协议路径原样返回', () => {
	for (const s of [
		'https://example.com/x.png',
		'data:image/png;base64,AAAA',
		'/abs/x.png',
		'C:/img/x.png',
		'#anchor',
	]) {
		assert.equal(resolveAssetSrc(s, BASE), s, s);
	}
});

test('resolveAssetSrc：缺 assetBaseUri 时原样返回（宿主未注入的安全降级）', () => {
	assert.equal(resolveAssetSrc('x.png', undefined), 'x.png');
	assert.equal(resolveAssetSrc(undefined, BASE), undefined);
});

test('resolveAssetSrc：saros-media:// 协议不被当相对路径改写（走媒体库桥）', () => {
	const src = 'saros-media://m1abc';
	assert.equal(resolveAssetSrc(src, BASE), src);
});

test('isMediaAssetSrc / mediaAssetId：协议识别与 id 提取', () => {
	assert.equal(isMediaAssetSrc('saros-media://m1abc'), true);
	assert.equal(isMediaAssetSrc('https://x.png'), false);
	assert.equal(isMediaAssetSrc(undefined), false);
	assert.equal(mediaAssetId('saros-media://m1abc'), 'm1abc');
	assert.equal(mediaAssetId('saros-media://m1abc?w=300'), 'm1abc', '忽略 query');
	assert.equal(mediaAssetId('saros-media://'), undefined);
	assert.equal(mediaAssetId('other://x'), undefined);
});

test('normalizeRelativeRef：防范越出目录的 ../ 与空段', () => {
	assert.equal(normalizeRelativeRef('../../x.png'), 'x.png');
	assert.equal(normalizeRelativeRef('..'), '');
	assert.equal(normalizeRelativeRef('./'), '');
});
