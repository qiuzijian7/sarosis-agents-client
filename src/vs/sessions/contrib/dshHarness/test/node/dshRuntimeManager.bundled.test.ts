/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置运行时（bundled）解析：构建期预装到 `<appPath>/dsh-runtime/<version>` 的 dsh
 * 参与 resolveDsh 的解析链（setting → managed → bundled → global）。
 * 用打桩 bin.js（打印固定版本号）+ 真实 Node 探版本，不走网络。
 */

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshRuntimeManager, IResolvedNode } from '../../electron-main/dshRuntimeManager.js';

const BIN_REL = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];

/** 造一个假版本目录：bin.js 打印自己的版本号（供 _probeDshVersion 执行）。 */
function makeFakeRuntime(root: string, version: string): string {
	const bin = join(root, version, ...BIN_REL);
	mkdirSync(join(bin, '..'), { recursive: true });
	writeFileSync(bin, `console.log('${version}');\n`);
	return bin;
}

suite('dshHarness / bundled runtime resolution', () => {
	let dir: string;
	const node: IResolvedNode = { path: process.execPath, version: process.version, source: 'path' };

	setup(() => dir = mkdtempSync(join(tmpdir(), 'vssaros-dsh-bundled-')));
	teardown(() => rmSync(dir, { recursive: true, force: true }));

	test('managed 为空时命中 bundled，source=bundled', async () => {
		const managed = join(dir, 'managed');
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(bundled, '0.2.0-rc.2');
		const rt = new DshRuntimeManager(managed, () => { }, bundled);
		assert.deepStrictEqual(rt.listBundled(), ['0.2.0-rc.2']);
		const r = await rt.resolveDsh(undefined, node);
		assert.strictEqual(r.source, 'bundled');
		assert.strictEqual(r.version, '0.2.0-rc.2');
		assert.ok(r.bin.includes('bundled'), r.bin);
	});

	test('managed 指针优先于 bundled（用户显式安装/升级必须被尊重）', async () => {
		const managed = join(dir, 'managed');
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(managed, '0.2.0-rc.2');
		makeFakeRuntime(bundled, '9.9.9-bundled');
		const rt = new DshRuntimeManager(managed, () => { }, bundled);
		await rt.setCurrent('0.2.0-rc.2');
		const r = await rt.resolveDsh(undefined, node);
		assert.strictEqual(r.source, 'managed');
		assert.strictEqual(r.version, '0.2.0-rc.2');
	});

	test('bundled 多版本取最高；非法目录名被忽略', async () => {
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(bundled, '0.1.7-rc.2');
		makeFakeRuntime(bundled, '0.2.0-rc.2');
		mkdirSync(join(bundled, 'not-a-version'), { recursive: true });
		const rt = new DshRuntimeManager(join(dir, 'managed'), () => { }, bundled);
		assert.deepStrictEqual(rt.listBundled(), ['0.1.7-rc.2', '0.2.0-rc.2']);
		const r = await rt.resolveDsh(undefined, node);
		assert.strictEqual(r.version, '0.2.0-rc.2');
	});

	test('compat pin 优先于"目录里最高版本"（残留的更高版本不许被选中）', async () => {
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(bundled, '0.2.1-rc.2');
		makeFakeRuntime(bundled, '0.3.0'); // 更高但没进兼容清单的残留版本
		const rt = new DshRuntimeManager(join(dir, 'managed'), () => { }, bundled, '0.2.1-rc.2');
		const r = await rt.resolveDsh(undefined, node);
		assert.strictEqual(r.source, 'bundled');
		assert.strictEqual(r.version, '0.2.1-rc.2', '必须用 dsh-compat.json pin 的版本，不是目录里的最高版本');
	});

	test('pin 的版本不在包里 ⇒ 退回最高版本并留日志（不硬失败）', async () => {
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(bundled, '0.2.1-rc.2');
		const lines: string[] = [];
		const rt = new DshRuntimeManager(join(dir, 'managed'), l => lines.push(l), bundled, '0.2.1-rc.99');
		const r = await rt.resolveDsh(undefined, node);
		assert.strictEqual(r.version, '0.2.1-rc.2');
		assert.ok(lines.some(l => l.includes('bundled pin')), `要留一行可诊断日志（实际日志：${lines.join(' | ')}）`);
	});

	test('bundledRoot 缺省/不存在时 listBundled 为空，不影响原有解析链', async () => {
		const rt = new DshRuntimeManager(join(dir, 'managed'), () => { }, join(dir, 'nope'));
		assert.deepStrictEqual(rt.listBundled(), []);
		const rt2 = new DshRuntimeManager(join(dir, 'managed'), () => { });
		assert.deepStrictEqual(rt2.listBundled(), []);
	});
});
