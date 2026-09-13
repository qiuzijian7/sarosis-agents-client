/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbViewUtils.test.ts — 知识库视图纯工具函数单元测试（无联网）。
 *
 *  覆盖 naturalCompare / formatSizeCompact / formatSizeFull /
 *  cssEscapeAttribute / normalizePathForCompare / isAbsolutePath。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	naturalCompare,
	formatSizeCompact,
	formatSizeFull,
	cssEscapeAttribute,
	normalizePathForCompare,
	isAbsolutePath,
} from './kbViewUtils.js';

describe('kbViewUtils - naturalCompare', () => {
	it('数字感知：2 排在 10 之前', () => {
		const names = ['file10.md', 'file2.md', 'file1.md'];
		names.sort(naturalCompare);
		assert.deepStrictEqual(names, ['file1.md', 'file2.md', 'file10.md']);
	});

	it('大小写不敏感', () => {
		assert.strictEqual(naturalCompare('README.md', 'readme.md'), 0);
	});
});

describe('kbViewUtils - formatSizeCompact', () => {
	it('B / KB / MB 三档', () => {
		assert.strictEqual(formatSizeCompact(512), '512B');
		assert.strictEqual(formatSizeCompact(2048), '2.0KB');
		assert.strictEqual(formatSizeCompact(1024 * 1024 * 3), '3.0MB');
	});

	it('边界：1023 归 B，1024 归 KB', () => {
		assert.strictEqual(formatSizeCompact(1023), '1023B');
		assert.strictEqual(formatSizeCompact(1024), '1.0KB');
	});
});

describe('kbViewUtils - formatSizeFull', () => {
	it('带空格、支持 GB', () => {
		assert.strictEqual(formatSizeFull(512), '512 B');
		assert.strictEqual(formatSizeFull(2048), '2.0 KB');
		assert.strictEqual(formatSizeFull(1024 * 1024 * 3), '3.0 MB');
		assert.strictEqual(formatSizeFull(1024 * 1024 * 1024 * 2), '2.0 GB');
	});
});

describe('kbViewUtils - cssEscapeAttribute', () => {
	it('转义双引号与反斜杠', () => {
		assert.strictEqual(cssEscapeAttribute('a"b'), 'a\\"b');
		assert.strictEqual(cssEscapeAttribute('a\\b'), 'a\\\\b');
	});

	it('普通路径不变', () => {
		assert.strictEqual(cssEscapeAttribute('/vault/note.md'), '/vault/note.md');
	});
});

describe('kbViewUtils - normalizePathForCompare', () => {
	it('统一斜杠并小写', () => {
		assert.strictEqual(normalizePathForCompare('C:\\Vault\\Note.MD'), 'c:/vault/note.md');
	});

	it('去除尾部斜杠', () => {
		assert.strictEqual(normalizePathForCompare('/vault/notes/'), '/vault/notes');
	});

	it('Windows 盘符大小写等价', () => {
		assert.strictEqual(
			normalizePathForCompare('C:/Vault/a.md'),
			normalizePathForCompare('c:/Vault/a.md'),
		);
	});
});

describe('kbViewUtils - isAbsolutePath', () => {
	it('Windows 盘符为绝对路径', () => {
		assert.strictEqual(isAbsolutePath('C:\\vault\\a.md'), true);
		assert.strictEqual(isAbsolutePath('D:/vault'), true);
	});

	it('Unix 根路径为绝对路径', () => {
		assert.strictEqual(isAbsolutePath('/home/user/vault'), true);
	});

	it('相对路径为 false', () => {
		assert.strictEqual(isAbsolutePath('vault/a.md'), false);
		assert.strictEqual(isAbsolutePath('./a.md'), false);
	});
});
