/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	advanceSearchCodeEmptyStreak,
	normalizeFileGlobForSearch,
	normalizeSearchPathFilter,
	searchRootCandidates,
	searchOutcomeHint,
} from '../../browser/providers/tool/pathFilterNormalize.js';

suite('search_code path_filter（P1 搜索根模型，log 1785228894680）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const ROOT_NAMES = ['S1Game', 'UE5EA'];
	const ROOT_PATHS = ['f:/GR/S1Game', 'f:/GR/UE5EA'];

	// ─── normalizeSearchPathFilter：清洗（**/../ 前缀、根名首段、绝对直通）─────

	test('strips root folder name prefix from relative dir path', () => {
		assert.strictEqual(
			normalizeSearchPathFilter('UE5EA/Engine/Source/Runtime/CoreUObject', ROOT_NAMES),
			'Engine/Source/Runtime/CoreUObject'
		);
	});

	test('strips root folder name prefix from relative file path', () => {
		assert.strictEqual(
			normalizeSearchPathFilter('UE5EA/Engine/Source/Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp', ROOT_NAMES),
			'Engine/Source/Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp'
		);
	});

	test('root name match is case-insensitive', () => {
		assert.strictEqual(normalizeSearchPathFilter('ue5ea/Engine/Source', ROOT_NAMES), 'Engine/Source');
	});

	test('strips root name from second root as well', () => {
		assert.strictEqual(normalizeSearchPathFilter('S1Game/Source/S1Framework', ROOT_NAMES), 'Source/S1Framework');
	});

	test('bare root name means "whole root" → empty (no filter)', () => {
		assert.strictEqual(normalizeSearchPathFilter('UE5EA', ROOT_NAMES), '');
		assert.strictEqual(normalizeSearchPathFilter('UE5EA/', ROOT_NAMES), '');
	});

	test('strips leading **/ (documented example form stays equivalent)', () => {
		assert.strictEqual(normalizeSearchPathFilter('**/CoreUObject/**', ROOT_NAMES), 'CoreUObject/**');
	});

	test('strips combined **/ + root name', () => {
		assert.strictEqual(normalizeSearchPathFilter('**/UE5EA/Engine/Source/**', ROOT_NAMES), 'Engine/Source/**');
	});

	test('strips leading ./ and **/./ combos', () => {
		assert.strictEqual(normalizeSearchPathFilter('./src/**', ROOT_NAMES), 'src/**');
		assert.strictEqual(normalizeSearchPathFilter('**/./src/**', ROOT_NAMES), 'src/**');
	});

	test('absolute paths pass through untouched', () => {
		assert.strictEqual(
			normalizeSearchPathFilter('f:/GR_qiuzijian_main/UE5EA/Engine', ROOT_NAMES),
			'f:/GR_qiuzijian_main/UE5EA/Engine'
		);
		assert.strictEqual(normalizeSearchPathFilter('/home/user/proj/src', ROOT_NAMES), '/home/user/proj/src');
	});

	test('backslash absolute path normalized to forward slashes', () => {
		assert.strictEqual(
			normalizeSearchPathFilter('f:\\GR_qiuzijian_main\\UE5EA\\Engine', ROOT_NAMES),
			'f:/GR_qiuzijian_main/UE5EA/Engine'
		);
	});

	test('malformed **/f:/ absolute glob is repaired by **/ strip', () => {
		assert.strictEqual(
			normalizeSearchPathFilter('**/f:/GR_qiuzijian_main/UE5EA/Engine', ROOT_NAMES),
			'f:/GR_qiuzijian_main/UE5EA/Engine'
		);
	});

	test('plain relative paths without root name pass through', () => {
		assert.strictEqual(normalizeSearchPathFilter('Engine/Source/**', ROOT_NAMES), 'Engine/Source/**');
		assert.strictEqual(normalizeSearchPathFilter('src/**', ROOT_NAMES), 'src/**');
		assert.strictEqual(normalizeSearchPathFilter('GarbageCollection.cpp', ROOT_NAMES), 'GarbageCollection.cpp');
	});

	test('first segment equal to root name but is a file → still stripped only if dir-form', () => {
		// "UE5EA.config" 首段含点号不等于根名，不应误剥
		assert.strictEqual(normalizeSearchPathFilter('UE5EA.config', ROOT_NAMES), 'UE5EA.config');
	});

	test('empty / whitespace input → empty (no filter)', () => {
		assert.strictEqual(normalizeSearchPathFilter('', ROOT_NAMES), '');
		assert.strictEqual(normalizeSearchPathFilter('   ', ROOT_NAMES), '');
		assert.strictEqual(normalizeSearchPathFilter('**/', ROOT_NAMES), '');
	});

	test('empty root list → no stripping', () => {
		assert.strictEqual(normalizeSearchPathFilter('UE5EA/Engine', []), 'UE5EA/Engine');
	});

	// ─── searchRootCandidates：搜索根候选（P1 新增）─────────────────────────

	test('searchRootCandidates: 相对路径在各根下展开', () => {
		assert.deepStrictEqual(
			searchRootCandidates('Engine/Source/Runtime', ROOT_PATHS),
			['f:/GR/S1Game/Engine/Source/Runtime', 'f:/GR/UE5EA/Engine/Source/Runtime']
		);
	});

	test('searchRootCandidates: 绝对路径单候选直通；含 * 或空 → 空数组', () => {
		assert.deepStrictEqual(searchRootCandidates('f:/GR/UE5EA/Engine', ROOT_PATHS), ['f:/GR/UE5EA/Engine']);
		assert.deepStrictEqual(searchRootCandidates('Engine/**', ROOT_PATHS), []);
		assert.deepStrictEqual(searchRootCandidates('', ROOT_PATHS), []);
	});

	// ─── no-match hint ──────────────────────────────────────────────────────

	test('searchOutcomeHint（include 分支）cites the glob and advises removing the filter', () => {
		const hint = searchOutcomeHint('**/UE5EA/Engine/**', 0, false);
		assert.ok(hint.includes('**/UE5EA/Engine/**'), 'should cite the include glob');
		assert.ok(hint.includes('path_filter'), 'should mention path_filter');
		assert.ok(hint.includes('root folder name'), 'should explain the root-name pitfall');
		assert.ok(!hint.includes('STOP retrying'), '未达阈值不应有连空强引导');
	});

	// ─── search_code 连续空结果引导（P3 合并进 searchOutcomeHint）────────────

	test('searchOutcomeHint（连空分支）cites streak and steers to structural search', () => {
		const hint = searchOutcomeHint(undefined, 3, true);
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

	// ─── searchOutcomeHint 无过滤分支（log 1785231958842：无过滤空命中此前静默）──

	test('searchOutcomeHint（无过滤分支）: 引导验证符号名而非重写 query', () => {
		const hint = searchOutcomeHint(undefined, 0, false);
		assert.ok(hint.includes('no path filter'), '应说明未用过滤');
		assert.ok(hint.includes('do not exist as written'), '应指出符号可能幻觉');
		assert.ok(hint.includes('search_files') || hint.includes('search_graph'), '应引导验证符号名');
	});

	// ─── 连空阈值（P3：阈值内联进 recordSearchCodeEmptyStreak，此处用 advance 验证倍数语义）──

	test('子代理阈值 2 / 主阈值 3 的倍数语义（advanceSearchCodeEmptyStreak 显式阈值）', () => {
		// 阈值 2：1 连空不触发，2 连空即触发
		const r1 = advanceSearchCodeEmptyStreak(0, true, 2);
		assert.strictEqual(r1.shouldGuide, false, '阈值 2 时 1 连空不触发');
		const r2 = advanceSearchCodeEmptyStreak(r1.streak, true, 2);
		assert.strictEqual(r2.shouldGuide, true, '阈值 2 时 2 连空即触发');
		// 阈值 3：3 连空才触发
		let cur = 0;
		const seen: boolean[] = [];
		for (let i = 0; i < 3; i++) {
			const r = advanceSearchCodeEmptyStreak(cur, true, 3);
			cur = r.streak; seen.push(r.shouldGuide);
		}
		assert.deepStrictEqual(seen, [false, false, true], '阈值 3 时第 3 次才触发');
	});
});
