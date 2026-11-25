/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「应用（IDE）一键升级」的纯逻辑守卫（2026-10-23）。
 *
 * 为什么必须有它：真机更新源现在返回 `productVersion = 2.2.26080`，而本地构建是 `2.2.26125`
 * —— 而 VS Code 的 win32 更新服务判"有没有新版"用的是 **commit 不相等**（不比版本高低）⇒
 * 少了这道闸门，用户点「一键升级」会被**降级**装回旧版 ✗✗。
 */
import assert from 'assert';
import { buildUpdateEndpoint, compareVersions, decideAppUpdate, parseAppUpdateResponse, toAppUpdateCheckUrl } from '../../common/dshAppUpdate.js';
import { isNewerProductVersion } from '../../../../../platform/update/common/update.js';

suite('dshHarness / 应用一键升级：版本比较与降级闸门', () => {

	test('compareVersions：按数字段比，缺段当 0', () => {
		assert.ok(compareVersions('2.2.26080', '2.2.26125') < 0);
		assert.ok(compareVersions('2.2.26125', '2.2.26080') > 0);
		assert.strictEqual(compareVersions('2.2.26125', '2.2.26125'), 0);
		// 段数不同
		assert.ok(compareVersions('2.2', '2.2.1') < 0);
		assert.strictEqual(compareVersions('2.2.0', '2.2'), 0);
		// ★ 2026-11-23：比较器收敛到 common/dshVersion.ts ⇒ 预发布比正式版**旧**
		//   （旧实现把 `2.2.26125-rc.1` 与 `2.2.26125` 当成同版，可能把预发布当新版装上 ✗）
		assert.ok(compareVersions('2.2.26125-rc.1', '2.2.26125') < 0);
		// 大数字不按字符串比（否则 "9" > "10"）
		assert.ok(compareVersions('2.2.9', '2.2.10') < 0);
	});

	test('decideAppUpdate：只有更新源**严格更新**才允许升（本机的真实态必须挡住）', () => {
		assert.strictEqual(decideAppUpdate('2.2.26125', '2.2.26190'), 'upgrade');
		assert.strictEqual(decideAppUpdate('2.2.26125', '2.2.26125'), 'uptodate');
		// ★ 真机实测的那一组：更新源更旧 ⇒ 必须是 downgrade（一键升级里据此拒绝）
		assert.strictEqual(decideAppUpdate('2.2.26125', '2.2.26080'), 'downgrade');
		assert.strictEqual(decideAppUpdate('2.2.26125', undefined), 'unknown');
		assert.strictEqual(decideAppUpdate('2.2.26125', '   '), 'unknown');
		assert.strictEqual(decideAppUpdate('2.2.26276', 'invalid'), 'unknown');
		assert.strictEqual(decideAppUpdate('invalid', '2.2.26277'), 'unknown');
		assert.strictEqual(decideAppUpdate('2.2.26276', '2.2.26277'), 'upgrade');
		assert.strictEqual(decideAppUpdate('2.2.26276', '2.2.26229'), 'downgrade');
	});

	test('原生更新服务也必须拒绝同版、旧版和无效版本', () => {
		assert.strictEqual(isNewerProductVersion('2.2.26276', '2.2.26277'), true);
		assert.strictEqual(isNewerProductVersion('2.2.26276', '2.2.26276'), false);
		assert.strictEqual(isNewerProductVersion('2.2.26276', '2.2.26229'), false);
		assert.strictEqual(isNewerProductVersion('2.2.26276', '2.2.26276-rc.1'), false);
		assert.strictEqual(isNewerProductVersion('2.2.26276', undefined), false);
		assert.strictEqual(isNewerProductVersion('2.2.26276', 'invalid'), false);
		assert.strictEqual(isNewerProductVersion('invalid', '2.2.26277'), false);
	});

	test('buildUpdateEndpoint：与 win32 更新服务同形状（noversioncheck 必须有）', () => {
		const url = buildUpdateEndpoint('http://h:3030/', 'win32-x64', 'saros', 'abc123');
		assert.strictEqual(url, 'http://h:3030/api/update/win32-x64/saros/abc123?channel=latest&noversioncheck=true');
		// 尾部斜杠不能拼成 `//api`
		assert.ok(!url.includes('//api'));
	});

	test('原生更新 URL 转换保留 user/system/archive 和已有查询参数', () => {
		for (const platform of ['win32-x64-user', 'win32-x64', 'win32-x64-archive', 'win32-arm64-user', 'darwin-arm64']) {
			const feed = `https://updates.example/api/update/${platform}/saros/build?u=none`;
			const url = new URL(toAppUpdateCheckUrl(feed));
			assert.strictEqual(url.pathname, new URL(feed).pathname);
			assert.strictEqual(url.searchParams.get('u'), 'none');
			assert.strictEqual(url.searchParams.get('noversioncheck'), 'true');
			assert.strictEqual(toAppUpdateCheckUrl(url.toString()), url.toString());
		}
		assert.throws(() => toAppUpdateCheckUrl('file:///update'));
	});

	test('parseAppUpdateResponse：只认需要的字段，形状不对 ⇒ undefined', () => {
		assert.strictEqual(parseAppUpdateResponse(null), undefined);
		assert.strictEqual(parseAppUpdateResponse('nope'), undefined);
		assert.strictEqual(parseAppUpdateResponse({}), undefined);
		const ok = parseAppUpdateResponse({ version: 'deadbeef', productVersion: '2.2.26080', url: 'http://h/x.exe', sha256hash: 'aa' });
		assert.deepStrictEqual(ok, { version: 'deadbeef', productVersion: '2.2.26080', url: 'http://h/x.exe', sha256hash: 'aa' });
		// 只给 productVersion 也认（闸门只需要它）
		assert.deepStrictEqual(parseAppUpdateResponse({ productVersion: '2.2.26190' }), { productVersion: '2.2.26190' });
	});
});
