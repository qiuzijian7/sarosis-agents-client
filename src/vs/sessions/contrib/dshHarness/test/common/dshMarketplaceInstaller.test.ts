/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 商城「外部发布源」安装链的守卫（★ 2026-10-22）。
 * ============================================================
 *
 * 钉住三件**安全底线**（它们一旦松动，商城装的东西就不可信）：
 *  1. **没有 sha256 就不装**（校验值缺失/格式不对 ⇒ 拒绝）✓；
 *  2. **只收 https**（http 会被中间人替换内容）✓；
 *  3. **体积有上限**（默认 8 MiB ⇒ 不会把主进程内存/磁盘打爆）✓。
 *
 * ★ 这些是**纯函数**级判据（`isSha256Hex` / `isHttpsUrl` / 上限常量）⇒ 可以在进程内真跑 ✓。
 *   真下载那一段依赖网络 ⇒ 不在这里跑（要真机验）✓。
 */

import assert from 'node:assert/strict';
import { MARKETPLACE_MAX_DOWNLOAD_BYTES, isHttpsUrl, isSha256Hex } from '../../electron-main/dshMarketplaceInstaller.js';
import { resolveDistributionSpec } from '../../../agentStudio/common/marketplaceDistribution.js';

suite('dshMarketplaceInstaller（外部发布源安装链）', () => {

	test('★ sha256 判据：只认 64 位十六进制', () => {
		assert.strictEqual(isSha256Hex('a'.repeat(64)), true);
		assert.strictEqual(isSha256Hex('A'.repeat(64)), true);
		assert.strictEqual(isSha256Hex('a'.repeat(63)), false, '少一位不算');
		assert.strictEqual(isSha256Hex('a'.repeat(65)), false, '多一位不算');
		assert.strictEqual(isSha256Hex('g'.repeat(64)), false, '非十六进制不算');
		assert.strictEqual(isSha256Hex(''), false);
		assert.strictEqual(isSha256Hex(undefined), false);
		assert.strictEqual(isSha256Hex(null), false);
		assert.strictEqual(isSha256Hex(123), false);
	});

	test('★ https 判据：http / ftp / 相对路径一律不算', () => {
		assert.strictEqual(isHttpsUrl('https://github.com/o/r/releases/download/v1/pkg.tgz'), true);
		assert.strictEqual(isHttpsUrl('http://example.com/a.tgz'), false, 'http 不放行');
		assert.strictEqual(isHttpsUrl('ftp://example.com/a.tgz'), false);
		assert.strictEqual(isHttpsUrl('/local/a.tgz'), false);
		assert.strictEqual(isHttpsUrl('not a url'), false);
		assert.strictEqual(isHttpsUrl(undefined), false);
	});

	test('★ 体积上限：8 MiB（与 dsh 市场协议 v2 的 Release 包同档）', () => {
		assert.strictEqual(MARKETPLACE_MAX_DOWNLOAD_BYTES, 8 * 1024 * 1024);
	});

	test('★ github-release 走"先下载"通道（不转 spec）', () => {
		const r = resolveDistributionSpec({ type: 'github-release', name: '@acme/wb', url: 'https://x/y.tgz', sha256: 'a'.repeat(64) }, '1.0.0');
		assert.strictEqual(r.needsDownload, true, 'github-release 必须走下载通道');
		assert.strictEqual(r.spec, undefined, '它不该被转成 spec（转了就装错东西）');
		assert.strictEqual(r.error, undefined);
	});

	test('★ npm / github-source 直接转 spec（不需要下载）', () => {
		const npm = resolveDistributionSpec({ type: 'npm', name: '@acme/wb' }, '1.2.3');
		assert.strictEqual(npm.spec, '@acme/wb@1.2.3');
		assert.strictEqual(npm.needsDownload, false);

		const src = resolveDistributionSpec({ type: 'github-source', name: 'o/r', commit: 'abc123' }, '1.0.0');
		assert.strictEqual(src.spec, 'github:o/r#abc123');
		assert.strictEqual(src.needsDownload, false);
	});

	test('★ 绝不自动换来源：缺字段就报错，不猜', () => {
		assert.ok(resolveDistributionSpec({ type: 'npm' }, '1.0.0').error, 'npm 缺 name ⇒ 报错');
		assert.ok(resolveDistributionSpec({ type: 'github-source' }, '1.0.0').error, 'github-source 缺 name ⇒ 报错');
		assert.ok(resolveDistributionSpec({ type: 'wat' as 'npm' }, '1.0.0').error, '未知类型 ⇒ 报错');
	});
});
