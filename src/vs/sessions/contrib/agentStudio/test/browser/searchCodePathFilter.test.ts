/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	advanceSearchCodeEmptyStreak,
	normalizeFileGlobForSearch,
	normalizePathFilterForRoots,
	noMatchNoFilterHint,
	noMatchWithIncludeHint,
	searchCodeEmptyStreakHint,
	searchCodeEmptyStreakThresholdFor,
	SEARCH_CODE_EMPTY_STREAK_THRESHOLD_MAIN,
	SEARCH_CODE_EMPTY_STREAK_THRESHOLD_SUBAGENT,
} from '../../browser/providers/tool/pathFilterNormalize.js';

suite('search_code path_filter 归一化（log 1785228894680）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const ROOTS = ['S1Game', 'UE5EA'];

	// ─── 根目录名前缀剥离（本日志的失败形态）────────────────────────────────

	test('strips root folder name prefix from relative dir path', () => {
		assert.strictEqual(
			normalizePathFilterForRoots('UE5EA/Engine/Source/Runtime/CoreUObject', ROOTS),
			'Engine/Source/Runtime/CoreUObject'
		);
	});

	test('strips root folder name prefix from relative file path', () => {
		assert.strictEqual(
			normalizePathFilterForRoots('UE5EA/Engine/Source/Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp', ROOTS),
			'Engine/Source/Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp'
		);
	});

	test('root name match is case-insensitive', () => {
		assert.strictEqual(
			normalizePathFilterForRoots('ue5ea/Engine/Source', ROOTS),
			'Engine/Source'
		);
	});

	test('strips root name from second root as well', () => {
		assert.strictEqual(
			normalizePathFilterForRoots('S1Game/Source/S1Framework', ROOTS),
			'Source/S1Framework'
		);
	});

	test('bare root name means "whole root" → undefined (no filter)', () => {
		assert.strictEqual(normalizePathFilterForRoots('UE5EA', ROOTS), undefined);
		assert.strictEqual(normalizePathFilterForRoots('UE5EA/', ROOTS), undefined);
	});

	// ─── **/ 与 ./ 前缀剥离 ─────────────────────────────────────────────────

	test('strips leading **/ (documented example form stays equivalent)', () => {
		assert.strictEqual(normalizePathFilterForRoots('**/CoreUObject/**', ROOTS), 'CoreUObject/**');
	});

	test('strips combined **/ + root name', () => {
		assert.strictEqual(
			normalizePathFilterForRoots('**/UE5EA/Engine/Source/**', ROOTS),
			'Engine/Source/**'
		);
	});

	test('strips leading ./ and **/./ combos', () => {
		assert.strictEqual(normalizePathFilterForRoots('./src/**', ROOTS), 'src/**');
		assert.strictEqual(normalizePathFilterForRoots('**/./src/**', ROOTS), 'src/**');
	});

	// ─── 不受影响形态 ───────────────────────────────────────────────────────

	test('absolute paths pass through untouched', () => {
		assert.strictEqual(
			normalizePathFilterForRoots('f:/GR_qiuzijian_main/UE5EA/Engine', ROOTS),
			'f:/GR_qiuzijian_main/UE5EA/Engine'
		);
		assert.strictEqual(
			normalizePathFilterForRoots('/home/user/proj/src', ROOTS),
			'/home/user/proj/src'
		);
	});

	test('backslash absolute path normalized to forward slashes', () => {
		assert.strictEqual(
			normalizePathFilterForRoots('f:\\GR_qiuzijian_main\\UE5EA\\Engine', ROOTS),
			'f:/GR_qiuzijian_main/UE5EA/Engine'
		);
	});

	test('malformed **/f:/ absolute glob is repaired by **/ strip', () => {
		assert.strictEqual(
			normalizePathFilterForRoots('**/f:/GR_qiuzijian_main/UE5EA/Engine', ROOTS),
			'f:/GR_qiuzijian_main/UE5EA/Engine'
		);
	});

	test('plain relative paths without root name pass through', () => {
		assert.strictEqual(normalizePathFilterForRoots('Engine/Source/**', ROOTS), 'Engine/Source/**');
		assert.strictEqual(normalizePathFilterForRoots('src/**', ROOTS), 'src/**');
		assert.strictEqual(normalizePathFilterForRoots('GarbageCollection.cpp', ROOTS), 'GarbageCollection.cpp');
	});

	test('first segment equal to root name but is a file → still stripped only if dir-form', () => {
		// "UE5EA.config" 首段含点号不等于根名，不应误剥
		assert.strictEqual(normalizePathFilterForRoots('UE5EA.config', ROOTS), 'UE5EA.config');
	});

	test('empty / whitespace input → undefined', () => {
		assert.strictEqual(normalizePathFilterForRoots('', ROOTS), undefined);
		assert.strictEqual(normalizePathFilterForRoots('   ', ROOTS), undefined);
		assert.strictEqual(normalizePathFilterForRoots('**/', ROOTS), undefined);
	});

	test('empty root list → no stripping', () => {
		assert.strictEqual(normalizePathFilterForRoots('UE5EA/Engine', []), 'UE5EA/Engine');
	});

	// ─── no-match hint ──────────────────────────────────────────────────────

	test('noMatchWithIncludeHint cites the glob and advises removing the filter', () => {
		const hint = noMatchWithIncludeHint('**/UE5EA/Engine/**');
		assert.ok(hint.includes('**/UE5EA/Engine/**'), 'should cite the include glob');
		assert.ok(hint.includes('path_filter'), 'should mention path_filter');
		assert.ok(hint.includes('root folder name'), 'should explain the root-name pitfall');
	});

	// ─── search_code 连续空结果引导（log 1785231958842）────────────────────────

	test('searchCodeEmptyStreakHint cites streak and steers to structural search', () => {
		const hint = searchCodeEmptyStreakHint(3);
		assert.ok(hint.includes('3 times in a row'), 'should cite the streak count');
		assert.ok(hint.includes('search_graph'), 'should steer to search_graph');
		assert.ok(hint.includes('query_graph'), 'should steer to query_graph');
		assert.ok(hint.includes('path_filter'), 'should mention dropping/loosening path_filter');
		assert.ok(hint.includes('STOP retrying'), 'should tell the model to stop retrying search_code');
	});

	// ─── advanceSearchCodeEmptyStreak（连击推进纯函数，log 1785231958842）────────

	test('advanceSearchCodeEmptyStreak: 空命中连击递增；命中重置为 0', () => {
		let cur = 0;
		cur = advanceSearchCodeEmptyStreak(cur, true, 3).streak;   // 1
		cur = advanceSearchCodeEmptyStreak(cur, true, 3).streak;   // 2
		cur = advanceSearchCodeEmptyStreak(cur, true, 3).streak;   // 3
		assert.strictEqual(cur, 3);
		cur = advanceSearchCodeEmptyStreak(cur, false, 3).streak;  // 命中重置
		assert.strictEqual(cur, 0);
	});

	test('advanceSearchCodeEmptyStreak: shouldGuide 仅在阈值倍数（3/6…）为 true', () => {
		let cur = 0;
		const seen: boolean[] = [];
		for (let i = 0; i < 6; i++) {
			const r = advanceSearchCodeEmptyStreak(cur, true, 3);
			cur = r.streak; seen.push(r.shouldGuide);
		}
		assert.deepStrictEqual(seen, [false, false, true, false, false, true]);
	});

	test('advanceSearchCodeEmptyStreak: threshold<=0 永不引导（防御）', () => {
		const r = advanceSearchCodeEmptyStreak(2, true, 0);
		assert.strictEqual(r.streak, 3);
		assert.strictEqual(r.shouldGuide, false);
	});

	// ─── normalizeFileGlobForSearch（log 1785231958842：裸 file_pattern 未补 **/）──

	test('normalizeFileGlobForSearch: 裸文件名/裸扩展 glob 补 **/ 前缀', () => {
		assert.strictEqual(normalizeFileGlobForSearch('GarbageCollection.cpp'), '**/GarbageCollection.cpp');
		assert.strictEqual(normalizeFileGlobForSearch('*.cpp'), '**/*.cpp');
		assert.strictEqual(normalizeFileGlobForSearch('UObjectClusters.h'), '**/UObjectClusters.h');
	});
	test('normalizeFileGlobForSearch: 已含 / 的模式原样返回', () => {
		assert.strictEqual(normalizeFileGlobForSearch('**/*.cpp'), '**/*.cpp');
		assert.strictEqual(normalizeFileGlobForSearch('Engine/Source/**'), 'Engine/Source/**');
		assert.strictEqual(normalizeFileGlobForSearch('src/**/*.ts'), 'src/**/*.ts');
	});
	test('normalizeFileGlobForSearch: 空串原样返回（防御）', () => {
		assert.strictEqual(normalizeFileGlobForSearch(''), '');
	});

	// ─── noMatchNoFilterHint（log 1785231958842：无过滤空命中此前静默）──

	test('noMatchNoFilterHint: 引导验证符号名而非重写 query', () => {
		const hint = noMatchNoFilterHint();
		assert.ok(hint.includes('no path filter'), '应说明未用过滤');
		assert.ok(hint.includes('do not exist as written'), '应指出符号可能幻觉');
		assert.ok(hint.includes('search_files') || hint.includes('search_graph'), '应引导验证符号名');
	});

	// ─── searchCodeEmptyStreakThresholdFor（log 1785237941547：子代理更敏感）────

	test('searchCodeEmptyStreakThresholdFor: 子代理阈值更低（2）', () => {
		assert.strictEqual(searchCodeEmptyStreakThresholdFor('subagent-1785237332115-jxm2zho6z'), SEARCH_CODE_EMPTY_STREAK_THRESHOLD_SUBAGENT);
		assert.strictEqual(SEARCH_CODE_EMPTY_STREAK_THRESHOLD_SUBAGENT, 2, '子代理阈值应为 2');
	});
	test('searchCodeEmptyStreakThresholdFor: 主 agent/未定义阈值为主阈值（3）', () => {
		assert.strictEqual(searchCodeEmptyStreakThresholdFor('gr-gc'), SEARCH_CODE_EMPTY_STREAK_THRESHOLD_MAIN);
		assert.strictEqual(searchCodeEmptyStreakThresholdFor(undefined), SEARCH_CODE_EMPTY_STREAK_THRESHOLD_MAIN);
		assert.strictEqual(SEARCH_CODE_EMPTY_STREAK_THRESHOLD_MAIN, 3, '主 agent 阈值应为 3');
	});
	test('子代理 2 连空即触发引导（advanceSearchCodeEmptyStreak + 子代理阈值）', () => {
		const t = searchCodeEmptyStreakThresholdFor('subagent-x');
		const r1 = advanceSearchCodeEmptyStreak(0, true, t);
		assert.strictEqual(r1.shouldGuide, false, '子代理 1 连空不触发');
		const r2 = advanceSearchCodeEmptyStreak(r1.streak, true, t);
		assert.strictEqual(r2.shouldGuide, true, '子代理 2 连空即触发');
	});
});
