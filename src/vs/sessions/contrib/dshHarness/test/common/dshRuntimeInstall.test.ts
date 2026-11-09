/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 运行时副本"能不能用"的判据（2026-10-29 真机事故的守卫）。
 *
 * 事故：`~/.vssaros/dsh-runtime/0.2.1-alpha.3/node_modules/@deepseek-ai/dsh-app-boot`
 * 是**空目录**（迁移复制不全），`state.json` 仍指向它 ⇒ 托管版本被优先选中 ⇒
 * `dsh --version` 抛 `ERR_MODULE_NOT_FOUND` ⇒ Host 没起来 ⇒ 桌面窗口报
 * 「startSession: 控制桥不可用」，日志里看不出根因 ✗。
 *
 * 本守卫钉两件事：
 *   ① 判据必须查 `dsh-app-boot/package.json`（缺它的形态正是本次事故）；
 *   ② 管理器必须在选托管版本前调用它、坏副本跳过并回落（不许直接交给 `_probeDshVersion`）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshRuntimeInstall
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

import { runtimeInstallMissing } from '../../common/dshRuntimeInstall.js';

const MANAGER = 'src/vs/sessions/contrib/dshHarness/electron-main/dshRuntimeManager.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

/** 用一个 Set 模拟文件系统（`exists` 只看"这些绝对路径存在"）。 */
const fsWith = (present: readonly string[]) => {
	const set = new Set(present);
	return (p: string) => set.has(p);
};

const DIR = 'C:/Users/u/.vssaros/dsh-runtime/0.2.1-alpha.3';
const OK = [
	`${DIR}/node_modules/@deepseek-ai/dsh/package.json`,
	`${DIR}/node_modules/@deepseek-ai/dsh/lib/bin.js`,
	`${DIR}/node_modules/@deepseek-ai/dsh-app-boot/package.json`,
];

suite('运行时副本可用性判据', () => {

	test('① 齐全 ⇒ 没问题', () => {
		assert.deepStrictEqual(runtimeInstallMissing(fsWith(OK), DIR), []);
	});

	test('② 缺 `dsh-app-boot/package.json` ⇒ 必须报出来（本次事故的形态）', () => {
		// 真机：`dsh-app-boot` 目录存在但是**空的**（连 package.json 都没有）
		const present = OK.filter(p => !p.includes('dsh-app-boot'));
		const missing = runtimeInstallMissing(fsWith(present), DIR);
		assert.deepStrictEqual(missing, ['node_modules/@deepseek-ai/dsh-app-boot/package.json'],
			'空目录的 dsh-app-boot 必须判为不可用（它是 bin.js 的第一个 import，缺了必崩 ✗）');
	});

	test('③ 缺 bin.js / dsh 本体也要报', () => {
		assert.deepStrictEqual(
			runtimeInstallMissing(fsWith([`${DIR}/node_modules/@deepseek-ai/dsh/package.json`]), DIR),
			['node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/@deepseek-ai/dsh-app-boot/package.json']);
		assert.ok(runtimeInstallMissing(fsWith(OK.filter(p => !p.includes('dsh/package.json'))), DIR)
			.includes('node_modules/@deepseek-ai/dsh/package.json'));
	});

	test('④ 路径分隔符与尾斜杠不许影响判据', () => {
		// Windows 反斜杠 + 尾部分隔符都要归一化，否则真要体检时会"全部判缺"
		assert.deepStrictEqual(runtimeInstallMissing(fsWith(OK), 'C:\\Users\\u\\.vssaros\\dsh-runtime\\0.2.1-alpha.3'), [],
			'反斜杠形式必须归一化成 `/` 再比对 ✗');
		assert.deepStrictEqual(runtimeInstallMissing(fsWith(OK), `${DIR}/`), [], '尾斜杠必须被去掉 ✗');
		assert.deepStrictEqual(runtimeInstallMissing(fsWith(OK), `${DIR}\\\\`), []);
	});

	test('⑤ ★ 单版本模型：resolveDsh 必须严格校验 pin + 体检唯一内置副本，缺构件就硬失败', () => {
		// ★★ 2026-11-09：managed 多版本池 / global 兜底 / 「坏副本跳过并回落」全部下线。
		//   现在只有一份内置 runtime，缺构件 = 安装包不完整 ⇒ 明确报错让用户重装，
		//   绝不悄悄换成别的版本（那正是 11-07 F5 崩溃的成因之一）。
		const src = stripComments(read(MANAGER));
		const at = src.indexOf('async resolveDsh(');
		assert.ok(at > 0, '找不到 resolveDsh ✗');
		const body = src.slice(at, src.indexOf('\n\tasync ', at + 1) > 0 ? src.indexOf('\n\tasync ', at + 1) : at + 6000);

		const iRequire = body.indexOf('this._requireBundled()');
		assert.ok(iRequire > 0, '必须先按 compat pin 严格校验唯一版本 ✗');
		const iCheck = body.indexOf('runtimeInstallMissing(existsSync', iRequire);
		const iProbe = body.indexOf('_probeDshVersion(node, bin)', iRequire);
		assert.ok(iCheck > iRequire, '内置副本必须做 `runtimeInstallMissing` 廉价体检（10-29 真机事故）✗');
		assert.ok(iProbe > iCheck, '体检必须排在探测之前（顺序反了等于没查 ✗）');
		assert.match(body, /内置 dsh \$\{version\} 不完整/, '不可用时要明确说"缺什么 + 重装应用"✗');
		assert.match(body, /source: 'bundled'/, '产品路径只能解析成 bundled');
		assert.ok(!/managedRoot, version|_globalBin|回落到下一个候选/.test(body), '不许再有 managed/global 回落链 ✗');
	});
});
