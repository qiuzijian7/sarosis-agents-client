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
import os from 'node:os';
import path from 'node:path';

import { DshHostSupervisor, normalizeEntryText } from '../../electron-main/dshHostSupervisor.js';
import { syncBundledPluginDirs } from '../../electron-main/dshProfileRuntimeSync.js';

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
		assert.match(src, /normalizeEntryText\(readFileSync\(join\(dir, file\), 'utf8'\)\)/,
			'_readEntryFile 必须归一化每个模块的文本');
		assert.match(src, /JSON\.stringify\(\[\.\.\.files\]\.sort\(\)\.map/,
			'模块路径必须排序并序列化，避免目录枚举顺序影响指纹');
		// 两条判据都必须经由 _readEntryFile（不能各自再读一次原始字节）
		assert.match(src, /private _entryFingerprint\(dir: string\): string \| undefined \{\s*const text = this\._readEntryFile\(dir\);/,
			'_entryFingerprint 必须走 _readEntryFile');
		assert.match(src, /private _installedEntryMatches\(bundledDir: string, installedDir: string\): boolean \{\s*const want = this\._readEntryFile\(bundledDir\);\s*const have = this\._readEntryFile\(installedDir\);/,
			'_installedEntryMatches 必须走 _readEntryFile');
	});
});

interface IPluginContentReader {
	_readEntryFile(dir: string): string | undefined;
	_entryFingerprint(dir: string): string | undefined;
	_installedEntryMatches(bundledDir: string, installedDir: string): boolean;
}

const reader = DshHostSupervisor.prototype as unknown as IPluginContentReader;

suite('插件入口指纹：同版本子模块同步', () => {
	let root: string;
	let source: string;
	let installed: string;

	const write = (dir: string, file: string, text: string): void => {
		const target = path.join(dir, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	};

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-content-'));
		source = path.join(root, 'source');
		installed = path.join(root, 'profile', 'node_modules', '@vssaros', 'dsh-bridge');
		for (const dir of [source, installed]) {
			write(dir, 'package.json', JSON.stringify({ name: '@vssaros/dsh-bridge', version: '0.2.50', main: 'lib/index.js' }));
			write(dir, 'lib/index.js', "export { credentialRef } from './codebuddy.js';\n");
			write(dir, 'lib/codebuddy.js', "export const credentialRef = 'VSSAROS_CODEBUDDY_ACCESS_TOKEN';\n");
		}
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('入口与版本相同，codebuddy.js 的旧凭据引用仍必须被识别', () => {
		write(installed, 'lib/codebuddy.js', "export const credentialRef = 'VSSAROS_CODEBUDDY_KEY';\n");
		assert.deepStrictEqual({
			entryMatches: fs.readFileSync(path.join(source, 'lib/index.js'), 'utf8') === fs.readFileSync(path.join(installed, 'lib/index.js'), 'utf8'),
			contentMatches: reader._installedEntryMatches(source, installed),
			fingerprintMatches: reader._entryFingerprint(source) === reader._entryFingerprint(installed),
		}, { entryMatches: true, contentMatches: false, fingerprintMatches: false });
	});

	for (const extension of ['js', 'mjs', 'cjs']) {
		test(`嵌套 ${extension} 模块变化必须影响内容比对与暂存指纹`, () => {
			write(source, `lib/auth/token.${extension}`, 'export const value = 1;\n');
			write(installed, `lib/auth/token.${extension}`, 'export const value = 2;\n');
			assert.deepStrictEqual({
				contentMatches: reader._installedEntryMatches(source, installed),
				fingerprintMatches: reader._entryFingerprint(source) === reader._entryFingerprint(installed),
			}, { contentMatches: false, fingerprintMatches: false });
		});
	}

	test('所有模块的 CRLF 与 BOM 都被归一化，重复启动无需同步', () => {
		for (const file of ['lib/index.js', 'lib/codebuddy.js']) {
			const text = fs.readFileSync(path.join(installed, file), 'utf8');
			write(installed, file, '\uFEFF' + text.replace(/\n/g, '\r\n'));
		}
		assert.deepStrictEqual({
			contentMatches: reader._installedEntryMatches(source, installed),
			fingerprintMatches: reader._entryFingerprint(source) === reader._entryFingerprint(installed),
		}, { contentMatches: true, fingerprintMatches: true });
	});

	test('子模块缺失或改名不能被相同入口掩盖', () => {
		fs.renameSync(path.join(installed, 'lib/codebuddy.js'), path.join(installed, 'lib/session.js'));
		assert.strictEqual(reader._installedEntryMatches(source, installed), false);
		fs.rmSync(path.join(installed, 'lib/session.js'));
		assert.strictEqual(reader._installedEntryMatches(source, installed), false);
	});

	test('入口缺失时保持保守判定，不把两个坏副本当作相同', () => {
		for (const dir of [source, installed]) {
			fs.rmSync(path.join(dir, 'lib/index.js'));
		}
		assert.deepStrictEqual({
			content: reader._readEntryFile(source),
			fingerprint: reader._entryFingerprint(source),
			contentMatches: reader._installedEntryMatches(source, installed),
		}, { content: undefined, fingerprint: undefined, contentMatches: false });
	});

	test('依赖、文档、source map 和二进制资源不影响 JS 模块指纹', () => {
		for (const file of ['lib/node_modules/dep/index.js', 'lib/docs/readme.md', 'lib/index.js.map', 'lib/native.wasm', 'lib/.cache/generated.js']) {
			write(source, file, 'source');
			write(installed, file, 'installed');
		}
		assert.strictEqual(reader._installedEntryMatches(source, installed), true);
	});

	test('顶层入口也能检查子模块，但不会扫描被暂存排除的开发工作区', () => {
		for (const dir of [source, installed]) {
			write(dir, 'package.json', JSON.stringify({ main: './index.js' }));
			write(dir, 'index.js', "export { credentialRef } from './lib/codebuddy.js';\n");
		}
		write(source, 'dev/package.json', '{}');
		write(source, 'dev/test.js', 'source-only development workspace');
		assert.strictEqual(reader._installedEntryMatches(source, installed), true);
		write(installed, 'lib/codebuddy.js', "export const credentialRef = 'VSSAROS_CODEBUDDY_KEY';\n");
		assert.strictEqual(reader._installedEntryMatches(source, installed), false);
	});

	test('真实同步修好同版本认证子模块，保留模型设置，第二次同步为 no-op', async () => {
		write(installed, 'lib/codebuddy.js', "export const credentialRef = 'VSSAROS_CODEBUDDY_KEY';\n");
		const profile = path.join(root, 'profile');
		write(profile, 'cordis.patch.yml', 'keep-model-settings');
		const sources = [{ name: '@vssaros/dsh-bridge', sourceDir: source }];
		const options = {
			matches: (from: string, to: string) => reader._installedEntryMatches(from, to),
			isSharedProfile: async () => false,
		};
		const first = await syncBundledPluginDirs(sources, profile, options);
		const second = await syncBundledPluginDirs(sources, profile, options);
		assert.deepStrictEqual({
			firstSynced: first.synced,
			firstChanged: first.changed,
			firstErrors: first.errors,
			secondChanged: second.changed,
			contentMatches: reader._installedEntryMatches(source, installed),
			settings: fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'),
		}, {
			firstSynced: ['@vssaros/dsh-bridge'], firstChanged: true, firstErrors: [],
			secondChanged: false, contentMatches: true, settings: 'keep-model-settings',
		});
	});
});
