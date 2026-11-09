/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 内置运行时（bundled）解析 —— **单版本模型**（2026-11-09 收敛）。
 *
 * 产品口径：dsh 版本由 `dsh-plugins/dsh-compat.json` 的 `bundled` 在构建期 pin 死，
 * 运行期只认这一个版本；`state.json` / managed 多版本池 / 全局 npm 兜底全部下线。
 * 用打桩 bin.js（打印固定版本号）+ 真实 Node 探版本，不走网络。
 */

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshRuntimeError, DshRuntimeManager, IResolvedNode } from '../../electron-main/dshRuntimeManager.js';

const BIN_REL = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];

/** 造一个假版本目录：bin.js 打印自己的版本号（供 _probeDshVersion 执行）。 */
function makeFakeRuntime(root: string, version: string): string {
	const bin = join(root, version, ...BIN_REL);
	mkdirSync(join(bin, '..'), { recursive: true });
	writeFileSync(bin, `console.log('${version}');\n`);
	// `resolveDsh` 会做 `runtimeInstallMissing` 廉价体检（10-29 真机事故：dsh-app-boot
	// 是空目录 ⇒ Host 一次都没起来）⇒ fixture 必须造齐体检要的构件。
	const scope = join(root, version, 'node_modules', '@deepseek-ai');
	writeFileSync(join(scope, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
	mkdirSync(join(scope, 'dsh-app-boot'), { recursive: true });
	writeFileSync(join(scope, 'dsh-app-boot', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version }));
	return bin;
}

suite('dshHarness / bundled runtime resolution (single version)', () => {
	let dir: string;
	const node: IResolvedNode = { path: process.execPath, version: process.version, source: 'path' };

	setup(() => dir = mkdtempSync(join(tmpdir(), 'vssaros-dsh-bundled-')));
	teardown(() => rmSync(dir, { recursive: true, force: true }));

	test('pin 命中 ⇒ source=bundled、version=pin', async () => {
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(bundled, '0.2.1-rc.2');
		const rt = new DshRuntimeManager(join(dir, 'managed'), () => { }, bundled, '0.2.1-rc.2');
		assert.strictEqual(rt.bundledVersion, '0.2.1-rc.2');
		const r = await rt.resolveDsh(undefined, node);
		assert.strictEqual(r.source, 'bundled');
		assert.strictEqual(r.version, '0.2.1-rc.2');
		assert.ok(r.bin.includes('bundled'), r.bin);
	});

	test('★ 目录里残留更高但没进 compat 清单的版本 ⇒ 仍只用 pin', async () => {
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(bundled, '0.2.1-rc.2');
		makeFakeRuntime(bundled, '9.9.9');
		mkdirSync(join(bundled, 'not-a-version'), { recursive: true });
		const rt = new DshRuntimeManager(join(dir, 'managed'), () => { }, bundled, '0.2.1-rc.2');
		const r = await rt.resolveDsh(undefined, node);
		assert.strictEqual(r.version, '0.2.1-rc.2', '★ 绝不「目录里取最高」');
	});

	test('★ pin 的版本不在包里 ⇒ 硬失败（不再悄悄退回最高版本）', async () => {
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(bundled, '0.2.1-rc.2');
		const rt = new DshRuntimeManager(join(dir, 'managed'), () => { }, bundled, '0.2.1-rc.99');
		await assert.rejects(() => rt.resolveDsh(undefined, node),
			(e: unknown) => e instanceof DshRuntimeError && e.code === 'dsh-missing' && /不完整|缺少内置/.test(e.message));
	});

	test('★ 没有 bundled pin / 没有 bundledRoot ⇒ 硬失败并提示重装应用', async () => {
		const bundled = join(dir, 'bundled');
		makeFakeRuntime(bundled, '0.2.1-rc.2');
		await assert.rejects(() => new DshRuntimeManager(join(dir, 'managed'), () => { }, bundled).resolveDsh(undefined, node), /未声明有效的 bundled dsh 版本/);
		await assert.rejects(() => new DshRuntimeManager(join(dir, 'managed'), () => { }, undefined, '0.2.1-rc.2').resolveDsh(undefined, node), /找不到内置运行时目录/);
	});

	test('★ manager 完全不读 state.json：托管目录里的旧指针不许影响解析', async () => {
		const managed = join(dir, 'managed');
		const bundled = join(dir, 'bundled');
		mkdirSync(managed, { recursive: true });
		writeFileSync(join(managed, 'state.json'), JSON.stringify({
			current: '9.9.9', history: ['0.1.0', '9.9.9'], profileRebuildPending: true,
		}));
		makeFakeRuntime(bundled, '0.2.1-rc.2');
		makeFakeRuntime(managed, '9.9.9');   // 旧的多版本池里还有一个"当前"版本
		const rt = new DshRuntimeManager(managed, () => { }, bundled, '0.2.1-rc.2');
		const r = await rt.resolveDsh(undefined, node);
		assert.strictEqual(r.version, '0.2.1-rc.2', '★ 旧 state.json / managed 副本必须被无视');
		assert.strictEqual(r.source, 'bundled');
		assert.deepStrictEqual(rt.getInfo().installed, ['0.2.1-rc.2'], 'UI 里也只有这一个版本');
		assert.strictEqual(rt.getInfo().current, '0.2.1-rc.2');
	});

	test('setting 覆盖仍可用（仅排障开关，不参与产品版本管理）', async () => {
		makeFakeRuntime(dir, '0.1.7-rc.2');
		const rt = new DshRuntimeManager(join(dir, 'managed'), () => { }, undefined, undefined);
		const r = await rt.resolveDsh(join(dir, '0.1.7-rc.2'), node);
		assert.strictEqual(r.source, 'setting');
		assert.ok(r.bin.includes('0.1.7-rc.2'), r.bin);
	});
});
