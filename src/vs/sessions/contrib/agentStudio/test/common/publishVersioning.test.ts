/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * publishVersioning 纯函数测试：
 *   1. parseSemver / compareSemver — 版本解析与比较
 *   2. bumpPatch / suggestNextVersion — 版本递增与建议
 *   3. validatePublishVersion — 发布前校验（格式/查重/递增）
 *   4. isVersionConflictError — 冲突错误识别
 */

import * as assert from 'node:assert';
import {
	parseSemver, compareSemver, bumpPatch, suggestNextVersion,
	validatePublishVersion, isVersionConflictError,
} from '../../browser/publishVersioning.js';

suite('publishVersioning', () => {

	suite('parseSemver', () => {
		test('标准 x.y.z 解析', () => {
			assert.deepStrictEqual(parseSemver('1.2.3'), [1, 2, 3]);
			assert.deepStrictEqual(parseSemver('0.0.0'), [0, 0, 0]);
			assert.deepStrictEqual(parseSemver('10.20.30'), [10, 20, 30]);
		});
		test('前后空白容忍', () => {
			assert.deepStrictEqual(parseSemver('  1.0.0  '), [1, 0, 0]);
		});
		test('非法格式返回 undefined', () => {
			assert.strictEqual(parseSemver('1.0'), undefined);
			assert.strictEqual(parseSemver('1.0.0.0'), undefined);
			assert.strictEqual(parseSemver('v1.0.0'), undefined);
			assert.strictEqual(parseSemver('1.0.0-beta'), undefined);
			assert.strictEqual(parseSemver(''), undefined);
			assert.strictEqual(parseSemver('abc'), undefined);
		});
	});

	suite('compareSemver', () => {
		test('major/minor/patch 逐级比较', () => {
			assert.ok(compareSemver('2.0.0', '1.9.9') > 0);
			assert.ok(compareSemver('1.2.0', '1.1.9') > 0);
			assert.ok(compareSemver('1.0.1', '1.0.0') > 0);
			assert.strictEqual(compareSemver('1.0.0', '1.0.0'), 0);
			assert.ok(compareSemver('1.0.0', '1.0.1') < 0);
		});
		test('数字比较而非字符串比较（10 > 9）', () => {
			assert.ok(compareSemver('1.10.0', '1.9.0') > 0);
		});
	});

	suite('bumpPatch', () => {
		test('patch +1', () => {
			assert.strictEqual(bumpPatch('1.0.0'), '1.0.1');
			assert.strictEqual(bumpPatch('1.2.9'), '1.2.10');
			assert.strictEqual(bumpPatch('0.0.0'), '0.0.1');
		});
		test('非 semver 原样返回', () => {
			assert.strictEqual(bumpPatch('abc'), 'abc');
		});
	});

	suite('suggestNextVersion', () => {
		test('无远端包 → 1.0.0', () => {
			assert.strictEqual(suggestNextVersion(undefined), '1.0.0');
			assert.strictEqual(suggestNextVersion({}), '1.0.0');
		});
		test('有 latest → patch+1', () => {
			assert.strictEqual(suggestNextVersion({ latestVersion: '1.0.0' }), '1.0.1');
			assert.strictEqual(suggestNextVersion({ latestVersion: '2.3.4' }), '2.3.5');
		});
	});

	suite('validatePublishVersion', () => {
		test('空版本号', () => {
			assert.ok(validatePublishVersion('', undefined));
			assert.ok(validatePublishVersion('   ', undefined));
		});
		test('非法格式', () => {
			assert.ok(validatePublishVersion('1.0', undefined)?.includes('格式'));
			assert.ok(validatePublishVersion('v1.0.0', undefined)?.includes('格式'));
		});
		test('无远端包 → 任意合法版本通过', () => {
			assert.strictEqual(validatePublishVersion('0.0.1', undefined), null);
			assert.strictEqual(validatePublishVersion('1.0.0', {}), null);
		});
		test('历史版本查重（命中 versions 列表）', () => {
			const remote = { latestVersion: '1.2.0', versions: [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '1.2.0' }] };
			const err = validatePublishVersion('1.1.0', remote);
			assert.ok(err?.includes('已存在'));
		});
		test('不大于 latest 被拦截', () => {
			const remote = { latestVersion: '1.2.0', versions: [] };
			assert.ok(validatePublishVersion('1.2.0', remote)?.includes('已存在') === false); // 1.2.0 不在 versions 时走 latest 校验
			const remoteDup = { latestVersion: '1.2.0', versions: [{ version: '1.2.0' }] };
			assert.ok(validatePublishVersion('1.2.0', remoteDup)?.includes('已存在'));
			assert.ok(validatePublishVersion('1.1.0', remote)?.includes('大于'));
			assert.ok(validatePublishVersion('0.9.9', remote)?.includes('大于'));
		});
		test('合法递增通过', () => {
			const remote = { latestVersion: '1.2.0', versions: [{ version: '1.2.0' }] };
			assert.strictEqual(validatePublishVersion('1.2.1', remote), null);
			assert.strictEqual(validatePublishVersion('1.3.0', remote), null);
			assert.strictEqual(validatePublishVersion('2.0.0', remote), null);
		});
	});

	suite('isVersionConflictError', () => {
		test('识别中英文冲突消息', () => {
			assert.strictEqual(isVersionConflictError('版本 v1.0.0 已存在于商城，请递增版本号后重试'), true);
			assert.strictEqual(isVersionConflictError('version already exists'), true);
			assert.strictEqual(isVersionConflictError('409 conflict'), true);
		});
		test('非冲突消息不误判', () => {
			assert.strictEqual(isVersionConflictError('未登录商城，请先在 VsSaros 中完成 TOF 登录'), false);
			assert.strictEqual(isVersionConflictError('网络超时'), false);
			assert.strictEqual(isVersionConflictError('发布失败: HTTP 500'), false);
		});
	});
});
