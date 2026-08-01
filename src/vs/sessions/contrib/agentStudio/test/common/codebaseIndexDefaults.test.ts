/*---------------------------------------------------------------------------------------------
 *  Codebase 索引排除目录默认表 — 单测
 *
 *  覆盖：
 *  - mergeExcludeDirs 去重（大小写不敏感）与顺序稳定
 *  - extractExcludeDirNames 从 code-workspace 的 search.exclude/files.exclude 提取目录名
 *  - parseCbmIgnore 与 writeCbmIgnore 写入格式（"dir/" 每行）的往返兼容
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	mergeExcludeDirs,
	extractExcludeDirNames,
	parseCbmIgnore,
} from '../../common/codebaseIndexDefaults.js';

suite('Codebase — IndexDefaults', () => {

	suite('mergeExcludeDirs', () => {

		test('去重 + 保持首次出现顺序', () => {
			assert.deepStrictEqual(
				mergeExcludeDirs(['a', 'b'], ['b', 'c']),
				['a', 'b', 'c'],
			);
		});

		test('大小写不敏感去重（扫描器本身即大小写不敏感）', () => {
			assert.deepStrictEqual(mergeExcludeDirs(['Build'], ['build']), ['Build']);
		});

		test('忽略 undefined / 空串 / 纯空白', () => {
			assert.deepStrictEqual(mergeExcludeDirs(undefined, ['', '  ', 'a']), ['a']);
		});
	});

	suite('extractExcludeDirNames', () => {

		test('从 search.exclude 提取干净的目录段', () => {
			const map = {
				'**/node_modules': true,
				'**/Intermediate': true,
				'**/Binaries/**': true,
				'Saved/': true,
			};
			assert.deepStrictEqual(extractExcludeDirNames(map), ['node_modules', 'Intermediate', 'Binaries', 'Saved']);
		});

		test('跳过含通配符的文件级排除（不污染目录名匹配）', () => {
			const map = {
				'**/*.log': true,
				'*.code-workspace': true,
				'**/Content': true,
			};
			assert.deepStrictEqual(extractExcludeDirNames(map), ['Content']);
		});

		test('显式 false 不启用', () => {
			const map = {
				'**/DerivedDataCache': false,
				'**/Plugins': true,
			};
			assert.deepStrictEqual(extractExcludeDirNames(map), ['Plugins']);
		});

		test('带 when 子句的对象视为启用', () => {
			const map = {
				'**/ThirdParty': { when: 'my.extension' } as { when?: string },
				'**/Config': true,
			};
			assert.deepStrictEqual(extractExcludeDirNames(map), ['ThirdParty', 'Config']);
		});

		test('undefined / 空映射 → 空列表', () => {
			assert.deepStrictEqual(extractExcludeDirNames(undefined), []);
			assert.deepStrictEqual(extractExcludeDirNames({}), []);
		});

		test('与 mergeExcludeDirs 共享去重语义', () => {
			const map = { '**/build': true, '**/Build': true };
			assert.deepStrictEqual(extractExcludeDirNames(map), ['build']);
		});
	});

	suite('parseCbmIgnore', () => {

		test('解析 writeCbmIgnore 写入格式（每行 "dir/"）', () => {
			const written = ['node_modules/', '.git/', 'Intermediate/'].join('\n') + '\n';
			assert.deepStrictEqual(parseCbmIgnore(written), ['node_modules', '.git', 'Intermediate']);
		});

		test('忽略注释与空行', () => {
			assert.deepStrictEqual(parseCbmIgnore('# comment\n\n  \nout/\n'), ['out']);
		});

		test('忽略含通配符的行（扫描器按目录名精确匹配）', () => {
			assert.deepStrictEqual(parseCbmIgnore('*.log\nbuild/\n?tmp/\n'), ['build']);
		});

		test('多级路径取最后一段', () => {
			assert.deepStrictEqual(parseCbmIgnore('a/b/Intermediate/\n'), ['Intermediate']);
		});

		test('反斜杠路径归一化', () => {
			assert.deepStrictEqual(parseCbmIgnore('a\\b\\Saved\\'), ['Saved']);
		});

		test('空内容 → 空列表', () => {
			assert.deepStrictEqual(parseCbmIgnore(''), []);
		});
	});
});
