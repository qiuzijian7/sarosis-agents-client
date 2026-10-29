/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「没有 pnpm 也能装随包插件」的守卫（2026-10-29）。
 *
 * 真机（别人机器上装我们的 exe）：界面只剩 dsh 官方页（`title: "DeepSeek Harness"`）。
 * 根因（对方机器的 main.log 原文）：
 *
 *     one-shot install of 35 plugin(s) took 858 ms: 0 ok, 35 to retry
 *     批量安装输出（35 项未到位）：'pnpm' 不是内部或外部命令，也不是可运行的程序或批处理文件
 *
 * ⇒ 35 个随包插件**一个都没装上** ⇒ 换皮插件缺席 ⇒ 页面就是官方外壳。
 * ⇒ 打包产物不能把「装插件」依赖在用户机器上（普通用户既没有 pnpm、很可能也没有 node）。
 * ⇒ 而随包插件的 `dependencies` **全为空** ⇒ pnpm 在这里只干「拷贝」⇒ 我们自己干即可。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshPluginDirectInstall
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

/** 剥掉注释：断言只能命中真实代码，不能被注释里的同名标识符骗过。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('没有 pnpm 时的直装退路', () => {

	test('必须探测 pnpm，并且只探一次', () => {
		const body = stripComments(read(SUPERVISOR));
		assert.match(body, /private _pnpmAvailable\(\)/, '必须有 pnpm 探测方法');
		assert.match(body, /execFileSync\('pnpm', \['--version'\]/,
			'必须真的执行 pnpm --version（只看 PATH 不算，Windows 下要 shell 才能解析 pnpm.cmd）');
		assert.match(body, /pnpmAvailableCache/,
			'探测结果必须缓存（逐项重试 35 次时不能问 35 次）');
		assert.match(body, /DSH_DISABLE_PNPM/,
			'必须有测试钩子 / 逃生门（否则"没有 pnpm 的机器"那条路径无法验证）');
	});

	test('批量安装必须按 pnpm 可用性分叉', () => {
		const body = stripComments(read(SUPERVISOR));
		const at = body.indexOf('const stagedDirs = await Promise.all(wants.map');
		assert.ok(at > 0, '找不到暂存那行（stagedDirs）');
		const iAvail = body.indexOf('this._pnpmAvailable()', at);
		const iPnpm = body.indexOf('buildPluginAddArgsMany(', at);
		// ⚠ 必须找**调用点**（`this._installPluginsDirect(wants…`）：只找方法名会命中**方法定义**
		//   （定义在文件后面）⇒ "删掉调用点"这种突变会假绿（实测踩过 ✗）。
		const iDirect = body.indexOf('this._installPluginsDirect(wants', at);
		assert.ok(iAvail > at, '暂存之后必须先探测 pnpm');
		assert.ok(iDirect > 0, '必须真的调用直装方法（删掉调用点 ⇒ 没 pnpm 的机器上又全失败 ✗）');
		// ⚠ 直装调用在 `else` 分支里 ⇒ 源码位置上**必然在** pnpm 调用之后 ⇒ 不能断言"在前"（实测踩过 ✗）。
		//   真正要保证的是：**两者都在探测之后**（同一个分叉里）。
		assert.ok(iDirect > iAvail, '直装调用必须与 pnpm 调用同在探测之后的分叉里');
		assert.ok(iPnpm > iAvail, 'pnpm 批量调用必须受探测结果保护（否则没 pnpm 的机器上必然全失败）');
	});

	test('直装必须真的落文件，且同步 profile/package.json', () => {
		const body = stripComments(read(SUPERVISOR));
		const at = body.indexOf('const stagedDirs = await Promise.all(wants.map');
		assert.ok(at > 0, '找不到暂存那行（stagedDirs）');
		const dAt = body.indexOf('private async _installPluginsDirect(');
		assert.ok(dAt > 0, '缺少 _installPluginsDirect');
		const dEnd = body.indexOf('private async _writeProfileDeps(', dAt);
		const dBody = body.slice(dAt, dEnd > dAt ? dEnd : dAt + 4000);
		assert.match(dBody, /node_modules/, '直装必须落到 profile/node_modules');
		assert.match(dBody, /fsp\.cp\(/, '直装必须真的拷贝文件');
		assert.match(dBody, /fsp\.rm\(/, '直装前必须先清掉旧副本（否则会残留上一次的旧文件）');
		assert.match(dBody, /_readPkgVersion\(/, '直装后必须校验版本（不校验 ⇒ 半装状态 ⇒ 永远不重装 ✗）');
		assert.match(dBody, /_installedEntryMatches\(/, '直装后必须校验入口内容（同上 ✗）');

		const wAt = body.indexOf('private async _writeProfileDeps(');
		assert.ok(wAt > 0, '缺少 _writeProfileDeps');
		// ⚠ 同样要钉**调用点**（只查方法定义会被"方法还在、调用被删"骗过 ✗）。
		assert.ok(body.indexOf('this._writeProfileDeps(pluginProfileDir', at) > 0,
			'直装必须真的调用它来同步 profile/package.json（否则每次启动都判"未装"、反复重装 ✗）');
		const wBody = body.slice(wAt, wAt + 2500);
		assert.match(wBody, /dependencies/, '必须写 profile/package.json 的 dependencies');
		assert.match(wBody, /verified/, '写 spec 时必须只写**校验通过**的那些');
		assert.match(wBody, /delete json\.dependencies\[name\]/,
			'装失败的包必须把 spec 删掉（留着 ⇒ 下次误判"已装"⇒ 永远不重装 ✗✗）');
		assert.match(wBody, /toFileSpec\(/, 'spec 形态必须与 pnpm 装出来的一致（file: 路径）');
		assert.match(wBody, /fsp\.rename\(/,
			'必须原子写（先写临时文件再改名；直接写会被读到半截 ⇒ profile 解析失败）');
	});
});
