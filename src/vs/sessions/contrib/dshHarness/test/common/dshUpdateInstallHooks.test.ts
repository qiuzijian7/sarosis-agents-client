/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「自动安装更新之前必须释放占用者」的守卫（2026-10-31）。
 *
 * 用户报障：**更新安装完毕后弹「要完成 VsSaros 的安装，安装程序必须重新启动您的电脑」**。
 *
 * 机制：win32 的自动安装走 `doApplyUpdate()`，给安装包传 **`/nocloseapplications`**
 * ⇒ Inno 不去关闭占用文件的进程 ⇒ 被锁的文件只能排到"重启时替换" ⇒ 收尾弹那条中文提示
 * （手动那条 `doQuitAndInstall()` 用 `/silent`，不带这个开关，所以很少出现）。
 *
 * ⇒ 修法是：spawn 安装包**之前**跑一次"释放占用者"钩子，由主进程的 dsh 通道注入
 *   `releaseHost()`（dsh Host 是 detached 常驻的，锁着 `dsh-runtime/<ver>/koffi.node`）。
 *   ⚠ 注释里不许写含 `*\/` 的 glob 路径（会**提前闭合块注释** ⇒ 全文语法崩）⇒ 一律写成 `<ver>`。
 *
 * 这份测试钉结构，不测行为：
 *   ① 钩子必须在 spawn **之前**（晚了等于没放锁）；
 *   ② 必须带超时（卡死的钩子不许把安装拖死）；
 *   ③ 失败不阻断（兜底是 restartreplace，不是装不上）；
 *   ④ sessions 侧必须真的注册了（否则 platform 层只是空跑）；
 *   ⑤ platform 层的钩子文件不许反向依赖 sessions（分层）。
 *
 * ⚠ 断言前必须剥注释：这些关键词在注释里都写过，不剥会假绿。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpdateInstallHooks
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const WIN32_UPDATE = 'src/vs/platform/update/electron-main/updateService.win32.ts';
const HOOKS = 'src/vs/platform/update/electron-main/updateInstallHooks.ts';
const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `source missing: ${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

/** 切出 `doApplyUpdate()` 的方法体（到下一个方法声明为止）。 */
function methodBody(src: string, signature: string): string {
	const at = src.indexOf(signature);
	assert.ok(at > 0, `找不到 ${signature} ✗`);
	const next = src.indexOf('\n\tprotected ', at + signature.length);
	const next2 = src.indexOf('\n\tprivate ', at + signature.length);
	const ends = [next, next2].filter(n => n > 0);
	return src.slice(at, ends.length ? Math.min(...ends) : at + 3000);
}

suite('自动安装更新前必须释放占用者（否则弹「必须重新启动您的电脑」）', () => {

	test('① 释放钩子必须在 spawn 安装包**之前**', () => {
		const src = stripComments(read(WIN32_UPDATE));
		const body = methodBody(src, 'protected override async doApplyUpdate()');
		const hookAt = body.indexOf('runBeforeUpdateInstallHooks(');
		assert.ok(hookAt > 0, 'doApplyUpdate 里必须调用 runBeforeUpdateInstallHooks（否则 dsh Host 的锁没人放）✗');
		const spawnAt = body.indexOf('spawn(');
		assert.ok(spawnAt > 0, '找不到 spawn（守卫不能空跑）✗');
		assert.ok(hookAt < spawnAt,
			'钩子必须早于 spawn（晚了 = 安装器已经带着 /nocloseapplications 起来了 ⇒ 锁还在 ⇒ 弹重启提示）✗');
	});

	test('② 钩子必须带超时（卡死的钩子不许把安装拖死）', () => {
		const src = stripComments(read(HOOKS));
		assert.match(src, /BEFORE_UPDATE_HOOK_TIMEOUT_MS\s*=/, '必须定义超时常量 ✗');
		assert.match(src, /Promise\.race\(/, '必须用 Promise.race 兜超时（直接 await 会被卡住的钩子挂死）✗');
		assert.match(src, /setTimeout\(resolve,\s*BEFORE_UPDATE_HOOK_TIMEOUT_MS\)/,
			'超时必须用到那个常量（写死数字会漂）✗');
	});

	test('③ 钩子失败不许阻断安装（兜底是 restartreplace，不是装不上）', () => {
		const src = stripComments(read(HOOKS));
		const at = src.indexOf('export async function runBeforeUpdateInstallHooks(');
		assert.ok(at > 0, '找不到 runBeforeUpdateInstallHooks ✗');
		const body = src.slice(at);
		assert.match(body, /try \{/, '必须有 try ✗');
		assert.match(body, /catch \(e\)/, '必须有 catch ✗');
		assert.match(body, /logService\?\.warn\(/, '失败必须记日志（否则"谁锁着"永远查不出来）✗');
		assert.ok(!/throw /.test(body.split('export')[0] ?? body),
			'catch 里不许把错误再抛出去（装不上比弹一次重启提示更糟）✗');
	});

	test('④ sessions 侧必须真的注册了 releaseHost（platform 层只是空跑）', () => {
		// ⚠ 这里**不用** stripComments：那份实现是"按块注释正则删除"，遇到代码里含 `/*` 的字符串
		//   （本文件里就有 `taskkill /T`、glob 之类）会吞掉中间大段 ⇒ 实测把注册行一起删没了（假红）。
		//   ⇒ 改成"逐行排除注释行"，既不受块注释影响，也不会把注释里的话当代码。
		const codeLines = read(CHANNEL).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
		const hit = codeLines.find(l => l.includes('registerBeforeUpdateInstallHook('));
		assert.ok(hit !== undefined, '主进程 dsh 通道必须注册"安装前释放"钩子 ✗');
		assert.match(hit, /this\._supervisor\.releaseHost\(\)/,
			'注册内容必须是 releaseHost（只有它才拿得到 Host 的句柄）✗');
	});

	test('⑤ platform 层的钩子文件不许反向依赖 sessions（分层）', () => {
		const src = read(HOOKS);
		const imports = src.split('\n').filter(l => /^import/.test(l));
		assert.ok(imports.length > 0, '找不到 import（守卫不能空跑）✗');
		for (const line of imports) {
			assert.ok(!/sessions/.test(line),
				`platform 层不许 import sessions（分层红线）：${line} ✗`);
		}
	});
});
