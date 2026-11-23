/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 统一版本比较真源的行为守卫（2026-11-23）：钉住「预发布比正式版旧」「build 元数据不参与」
 * 「脏值不猜方向」，并验证 app 升级闸门 / profile 审计 / 随包插件状态三处不再各比各的。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshVersion
 */

import assert from 'assert';
import { compareVersions, isVersionNewer, parseVersion } from '../../common/dshVersion.js';
import { compareVersions as appCompareVersions, decideAppUpdate } from '../../common/dshAppUpdate.js';
import { isVersionNewer as auditIsVersionNewer } from '../../common/dshPluginVersionAudit.js';

suite('dshHarness / 统一版本比较真源', () => {

	test('parseVersion：数字段 / 预发布 / build / 脏值', () => {
		assert.deepStrictEqual(parseVersion('2.2.26125'), { nums: [2, 2, 26125] });
		assert.deepStrictEqual(parseVersion(' 1.0.0-rc.2+build.7 '), { nums: [1, 0, 0], pre: 'rc.2' });
		assert.strictEqual(parseVersion(''), undefined);
		assert.strictEqual(parseVersion('abc'), undefined);
		assert.strictEqual(parseVersion('v1.2.3'), undefined);
		assert.strictEqual(parseVersion(undefined), undefined);
	});

	test('compareVersions：缺段按 0、按数值比、正式版 > 预发布', () => {
		assert.strictEqual(compareVersions('2.2.26080', '2.2.26125'), -1);
		assert.strictEqual(compareVersions('2.2.26125', '2.2.26080'), 1);
		assert.strictEqual(compareVersions('2.2.26125', '2.2.26125'), 0);
		assert.strictEqual(compareVersions('2.2', '2.2.1'), -1);
		assert.strictEqual(compareVersions('2.2.0', '2.2'), 0);
		assert.strictEqual(compareVersions('2.2.9', '2.2.10'), -1, '大数字不能按字符串比');
		assert.strictEqual(compareVersions('2.2.26125', '2.2.26125-rc.1'), 1, '正式版比预发布新');
		assert.strictEqual(compareVersions('2.2.26125-rc.1', '2.2.26125'), -1);
		assert.strictEqual(compareVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1, '预发布数字段按数值比');
		assert.strictEqual(compareVersions('1.0.0+build.a', '1.0.0+build.b'), 0, 'build 元数据不参与');
	});

	test('compareVersions：脏值一律 0（不猜方向 ⇒ 升级闸门落到「已是最新」）', () => {
		assert.strictEqual(compareVersions('abc', '1.0.0'), 0);
		assert.strictEqual(compareVersions('1.0.0', 'abc'), 0);
		assert.strictEqual(compareVersions(undefined, '1.0.0'), 0);
		assert.strictEqual(compareVersions('', ''), 0);
	});

	test('isVersionNewer：保守语义（沿用 profile 审计原口径）', () => {
		assert.strictEqual(isVersionNewer('0.2.259', '0.2.243'), true);
		assert.strictEqual(isVersionNewer('0.2.243', '0.2.259'), false);
		assert.strictEqual(isVersionNewer('0.10.0', '0.9.9'), true);
		assert.strictEqual(isVersionNewer('1.0.0', '1.0.0-rc.1'), true);
		assert.strictEqual(isVersionNewer('1.0.0-rc.1', '1.0.0'), false);
		assert.strictEqual(isVersionNewer('1.0.0-rc.2', '1.0.0-rc.1'), true);
		assert.strictEqual(isVersionNewer('1.0.0', '1.0.0'), false);
		assert.strictEqual(isVersionNewer('abc', '1.0.0'), false, '读不懂不据此跳过安装');
		assert.strictEqual(isVersionNewer(undefined, '1.0.0'), false);
	});

	test('三处导出指向同一套口径（不再各比各的）', () => {
		assert.strictEqual(appCompareVersions, compareVersions, 'app 升级闸门必须与真源是同一个函数');
		const pairs: Array<[string, string]> = [
			['2.2.26080', '2.2.26125'],
			['1.0.0', '1.0.0-rc.1'],
			['0.2.0-rc.2', '0.2.0'],
			['abc', '1.0.0'],
		];
		for (const [a, b] of pairs) {
			assert.strictEqual(auditIsVersionNewer(a, b), isVersionNewer(a, b), `${a} vs ${b}：profile 审计口径漂移`);
		}
	});

	test('decideAppUpdate：同版本号的预发布不再被当成「有新版」', () => {
		assert.strictEqual(decideAppUpdate('2.2.26125', '2.2.26125-rc.1'), 'downgrade');
		assert.strictEqual(decideAppUpdate('2.2.26125', '2.2.26126-rc.1'), 'upgrade', '更高主版本的预发布仍可升');
		assert.strictEqual(decideAppUpdate('2.2.26125', 'not-a-version'), 'uptodate', '脏值保守：宁可不升');
	});
});
