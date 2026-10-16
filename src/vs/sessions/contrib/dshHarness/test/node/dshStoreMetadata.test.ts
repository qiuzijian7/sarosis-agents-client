/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pnpm 虚拟店元数据修复（`dshStoreMetadata`）的两半：**路径写法归一** 与 **内容改写**。
 *
 * 起因（真机实测 2026-10-11）：pnpm 对"虚拟店位置是否一致"是**字符串比较**，而 Windows 上
 * `TEMP` / `userData` 常给 **8.3 短名**（`C:\Users\QIUZIJ~1\…`）——记录值与 pnpm 内部算出的
 * 长名不同写法 ⇒ `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` ⇒ 伴生包（含**必装**的
 * `@deepseek-ai/dsh-web-app`，它提供 `webStartup`）装不上 ⇒ 需要它的插件全 pending ⇒
 * `StartupError: … required plugins did not activate` ⇒ **Host 退出 code 1**。
 *
 * ★ 本套用例专门钉住那个最坑的点：**`fs.realpathSync` 不展开 8.3 短名，只有 `.native` 才展开**。
 */

import assert from 'assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { longFormRealpath, normalizeExistingPath, repairStoreMetadataContent } from '../../electron-main/dshStoreMetadata.js';

suite('dshStoreMetadata（pnpm 虚拟店元数据修复）', () => {

	test('★ 本机事实：`realpathSync` 不展开 8.3 短名，`.native` 才展开（两个都不可用时退回入参）', () => {
		// `tmpdir()` 在 Windows 上给的就是短名（`C:\Users\QIUZIJ~1\…`），正好当样本。
		const short = mkdtempSync(join(tmpdir(), 'vssaros-pathform-'));
		try {
			const native = (realpathSync as { native?: (p: string) => string }).native;
			if (native) {
				// 有原生实现时：归一结果里不该再出现 8.3 的 `~1` 这类段（短名目录名本身不含 `~`）。
				const viaNative = normalizeExistingPath(short, native.bind(realpathSync));
				assert.ok(!/~\d/.test(viaNative), `归一后不该再有 8.3 段：${viaNative}`);
			}
			// 注入一个恒抛的 realpath：归一只是"更好"，任何失败都要原样返回入参，不能让启动挂掉。
			assert.strictEqual(normalizeExistingPath(short, () => { throw new Error('nope'); }), short);
		} finally {
			rmSync(short, { recursive: true, force: true });
		}
	});

	test('路径还不存在时归一到**最长的已存在前缀**再拼回剩余部分（DSH_HOME 首启前就是这种）', () => {
		const base = mkdtempSync(join(tmpdir(), 'vssaros-pathform-'));
		try {
			// 假装 base 是"长名"，输入写成某个短名写法：注入的 realpath 只认 base 这一段。
			const fakeRealpath = (p: string) => (p.toLowerCase() === base.toLowerCase() ? join(base, '…long…') : p);
			const missing = join(base, 'dsh-home', 'profiles', 'vssaros');
			const got = normalizeExistingPath(missing, fakeRealpath);
			assert.strictEqual(got, join(base, '…long…', 'dsh-home', 'profiles', 'vssaros'),
				`已存在前缀应被归一、不存在的段应原样拼回：${got}`);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('长名 realpath 生产实现可用（`longFormRealpath()` 不抛）', () => {
		const base = mkdtempSync(join(tmpdir(), 'vssaros-pathform-'));
		try {
			assert.strictEqual(typeof longFormRealpath(), 'function');
			assert.ok(normalizeExistingPath(base).length > 0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('内容改写：只换 `virtualStoreDir`（+ 给了就换 `storeDir`），其它行一字不动', () => {
		const before = [
			'hoistPattern:',
			'  - "*"',
			'storeDir: G:\\.pnpm-store\\v10',
			'virtualStoreDir: G:\\repo\\dsh-runtime\\0.2.0-rc.2\\profile-seed\\profiles\\vssaros\\node_modules\\.pnpm',
			'packageManager: pnpm@10.0.0',
			'',
		].join('\n');
		const virtual = 'C:\\Users\\qiuzijian\\AppData\\Local\\Temp\\x\\dsh-home\\profiles\\vssaros\\node_modules\\.pnpm';
		const store = 'C:\\.pnpm-store\\v10';
		const r = repairStoreMetadataContent(before, virtual, store);
		assert.strictEqual(r.changed, true);
		assert.ok(r.content.includes(`virtualStoreDir: ${virtual}`), r.content);
		assert.ok(r.content.includes(`storeDir: ${store}`), r.content);
		assert.ok(r.content.includes('packageManager: pnpm@10.0.0'), '别动无关行');
		assert.ok(r.content.includes('  - "*"'), '别动无关行（缩进也保留）');
		assert.strictEqual(r.content.split('\n').length, before.split('\n').length);
		assert.strictEqual(r.storeDir, store);
	});

	test('幂等：已经是期望值 ⇒ `changed=false`（不写文件、不打日志）', () => {
		const virtual = 'C:\\x\\profiles\\vssaros\\node_modules\\.pnpm';
		const before = `storeDir: C:\\.pnpm-store\\v10\nvirtualStoreDir: ${virtual}\n`;
		const r = repairStoreMetadataContent(before, virtual, 'C:\\.pnpm-store\\v10');
		assert.strictEqual(r.changed, false);
		assert.strictEqual(r.content, before);
	});

	test('只给 `virtualStoreDir` 时不动 `storeDir`（拿不到版本号的情况）', () => {
		const before = 'storeDir: G:\\.pnpm-store\\v10\nvirtualStoreDir: G:\\old\\.pnpm\n';
		const r = repairStoreMetadataContent(before, 'C:\\new\\.pnpm');
		assert.strictEqual(r.changed, true);
		assert.ok(r.content.includes('storeDir: G:\\.pnpm-store\\v10'), 'storeDir 应保持原样');
		assert.ok(r.content.includes('virtualStoreDir: C:\\new\\.pnpm'));
		assert.strictEqual(r.storeDir, undefined);
	});

	test('短名场景端到端：写进文件的 `virtualStoreDir` 必须是长名（否则 pnpm 字符串比较仍不等）', () => {
		const base = normalizeExistingPath(mkdtempSync(join(tmpdir(), 'vssaros-pathform-')));
		try {
			const profile = join(base, 'dsh-home', 'profiles', 'vssaros');
			mkdirSync(join(profile, 'node_modules'), { recursive: true });
			const file = join(profile, 'node_modules', '.modules.yaml');
			// 模拟"上一轮用短名写法写过"的元数据：这里直接把 base 换成短名写法（本机 TEMP 即短名）。
			const shortBase = base.replace(/\\qiuzijian\\/i, '\\QIUZIJ~1\\');
			const before = `storeDir: C:\\.pnpm-store\\v10\nvirtualStoreDir: ${shortBase}\\dsh-home\\profiles\\vssaros\\node_modules\\.pnpm\n`;
			writeFileSync(file, before, 'utf8');

			const expectedDir = normalizeExistingPath(profile);
			const r = repairStoreMetadataContent(before, join(expectedDir, 'node_modules', '.pnpm'), 'C:\\.pnpm-store\\v10');
			assert.strictEqual(r.changed, true, '短名写法必须被判为"需要修"');
			assert.ok(!/~\d/.test(r.content), `修完不该再有 8.3 段：${r.content}`);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
