/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * resolvePublishAuthor 单元测试。
 *
 * 规则：优先 displayName → 其次 username → 回退 resourceAuthor → 全空返回 undefined。
 * 作者栏应自动取自登录信息，不允许手填伪造。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolvePublishAuthor } from '../../common/publishAuthor.js';

suite('Agent Studio - resolvePublishAuthor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('登录用户有 displayName — 优先使用 displayName', () => {
		const author = resolvePublishAuthor({ username: 'zijianqiu', displayName: '邱子健' }, 'old-author');
		assert.strictEqual(author, '邱子健');
	});

	test('登录用户仅 username（无 displayName）— 使用 username', () => {
		const author = resolvePublishAuthor({ username: 'zijianqiu' }, 'old-author');
		assert.strictEqual(author, 'zijianqiu');
	});

	test('displayName 为空白字符串 — 回退到 username', () => {
		const author = resolvePublishAuthor({ username: 'zijianqiu', displayName: '   ' }, 'old-author');
		assert.strictEqual(author, 'zijianqiu');
	});

	test('登录用户信息全空 — 回退到资源自带 author', () => {
		const author = resolvePublishAuthor({ username: '  ', displayName: '' }, 'old-author');
		assert.strictEqual(author, 'old-author');
	});

	test('未登录（currentUser undefined）— 回退到资源自带 author', () => {
		const author = resolvePublishAuthor(undefined, 'old-author');
		assert.strictEqual(author, 'old-author');
	});

	test('未登录且无资源 author — 返回 undefined', () => {
		assert.strictEqual(resolvePublishAuthor(undefined, undefined), undefined);
		assert.strictEqual(resolvePublishAuthor(undefined, ''), undefined);
		assert.strictEqual(resolvePublishAuthor(undefined, '   '), undefined);
	});

	test('登录用户优先于资源 author（即使资源 author 非空）', () => {
		const author = resolvePublishAuthor({ username: 'zijianqiu', displayName: '邱子健' }, 'resource-author');
		assert.strictEqual(author, '邱子健');
	});

	test('resourceAuthor 首尾空白会被 trim', () => {
		const author = resolvePublishAuthor(undefined, '  padded-author  ');
		assert.strictEqual(author, 'padded-author');
	});
});
