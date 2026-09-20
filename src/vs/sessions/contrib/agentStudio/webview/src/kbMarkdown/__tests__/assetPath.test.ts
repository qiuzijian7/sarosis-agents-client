/*---------------------------------------------------------------------------------------------
 *  assetPath.test.ts — 图文显示的图片 src 解析纯函数测试（node:test）。
 *  运行：node src/vs/sessions/contrib/agentStudio/webview/src/kbMarkdown/__tests__/run-assetpath-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRelativeRef, resolveAssetSrc } from '../assetPath.js';

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
