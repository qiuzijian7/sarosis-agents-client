/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件入口内容的**指纹/比对**必须对换行符免疫（★ 2026-10-29）。
 *
 * 事故：打包版每次启动都 `installing @vssaros/dsh-kb@0.5.58 (was 0.5.58)` ⇒ `_pluginsStale`
 *   ⇒ 不复用常驻 Host ⇒ 每次都冷启。根因不是"内容变了"，而是**换行符**：
 *   随包产物 574605 字节（CRLF）vs 仓库 565802 字节（LF），长度差 8803 = 行数 ⇒ 逐行完全相同。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshEntryFingerprint
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeEntryText } from '../../electron-main/dshHostSupervisor.js';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('插件入口指纹：换行/ BOM 免疫', () => {

	test('① CRLF 与 LF 归一化后完全相同', () => {
		const lf = 'const a = 1;\nconst b = 2;\n';
		const crlf = 'const a = 1;\r\nconst b = 2;\r\n';
		assert.strictEqual(normalizeEntryText(crlf), normalizeEntryText(lf));
		assert.strictEqual(normalizeEntryText(crlf), lf);
	});

	test('② UTF-8 BOM 被去掉（Node 读 JS 本就忽略 BOM ⇒ 不改变语义）', () => {
		assert.strictEqual(normalizeEntryText('\uFEFFconst a = 1;\n'), 'const a = 1;\n');
	});

	test('③ 真正的内容差异仍然看得见（不能被归一化掩盖）', () => {
		assert.notStrictEqual(normalizeEntryText('const a = 1;\n'), normalizeEntryText('const a = 2;\n'));
		assert.notStrictEqual(normalizeEntryText('a\nb\n'), normalizeEntryText('a\n\nb\n'));
		// 单独的 CR（老 Mac 换行）不归一化 ⇒ 保留差异
		assert.notStrictEqual(normalizeEntryText('a\rb\n'), normalizeEntryText('a\nb\n'));
	});

	test('④ 指纹与"已装副本是否一致"两条判据都必须走归一化后的文本', () => {
		const src = stripComments(fs.readFileSync(path.join(process.cwd(), SUPERVISOR), 'utf8'));
		// 读取入口的那一处走归一化 ⇒ 指纹（hash）与内容比对（===）都自动免疫换行
		assert.match(src, /return normalizeEntryText\(readFileSync\(join\(dir, rel\), 'utf8'\)\);/,
			'_readEntryFile 必须返回归一化后的文本');
		// 两条判据都必须经由 _readEntryFile（不能各自再读一次原始字节）
		assert.match(src, /private _entryFingerprint\(dir: string\): string \| undefined \{\s*const text = this\._readEntryFile\(dir\);/,
			'_entryFingerprint 必须走 _readEntryFile');
		assert.match(src, /private _installedEntryMatches\(bundledDir: string, installedDir: string\): boolean \{\s*const want = this\._readEntryFile\(bundledDir\);\s*const have = this\._readEntryFile\(installedDir\);/,
			'_installedEntryMatches 必须走 _readEntryFile');
	});
});
