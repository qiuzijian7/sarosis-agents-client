/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「一键升级前先释放 native 模块锁」的守卫（2026-10-29）。
 *
 * 真机：用户升级安装时报
 *   `尝试替换现有的文件时发生错误：DeleteFile 失败；错误代码 5。拒绝访问`
 *   （`…\resources\app\dsh-runtime\0.2.1-rc.2\node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node`）
 *   ⇒ 根因：**dsh Host 是 `detached` 常驻的**（IDE 关了它还活着）⇒ 它正加载着那个 `.node`
 *   ⇒ 安装器删不掉 ⇒ **安装中断 ⇒ 半装状态**（`resources/app/node_modules` 被删了却没装回来）✗✗。
 *
 * ⇒ 修法（一键升级这条路上）：`upgradeApp` 在 `quitAndInstall()` **之前**先让主进程结束 Host
 *   （`ReleaseHost` 通道）⇒ 锁释放 ⇒ 安装顺畅 ✓。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpgradeReleaseHost
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const COMMON = 'src/vs/sessions/contrib/dshHarness/common/dshHarness.ts';
const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';
const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('一键升级前释放 native 模块的文件锁', () => {

	test('1) 通道要有 ReleaseHost，主进程要真的结束 Host', () => {
		const common = stripComments(read(COMMON));
		assert.match(common, /ReleaseHost = 'releaseHost'/, '通道枚举必须有 ReleaseHost');

		const channel = stripComments(read(CHANNEL));
		assert.match(channel, /case DshHarnessChannelCommand\.ReleaseHost:/, '主进程必须有 ReleaseHost 分支');
		assert.match(channel, /this\._supervisor\.releaseHost\(\)/, '该分支必须真的结束 Host');

		const sup = stripComments(read(SUPERVISOR));
		assert.match(sup, /public async releaseHost\(\)/, 'supervisor 必须暴露 releaseHost');
		const at = sup.indexOf('public async releaseHost()');
		assert.ok(at > 0, '找不到 releaseHost');
		const end = sup.indexOf('\n\tprivate ', at);
		const body = sup.slice(at, end > at ? end : at + 2000);
		assert.match(body, /await this\._killChild\(\)/, '必须真的结束 Host 进程（否则锁不释放 ✗）');
		// ⚠ 不能清 run 目录：升级失败时 `host-*.log` 与覆盖层正是排查依据
		assert.ok(!/_cleanupRunFiles\(\)/.test(body),
			'releaseHost 不许清 run 目录（那些日志是升级失败的排查依据 ✗）');
	});

	test('2) upgradeApp 必须在 quitAndInstall 之前释放 Host（顺序不能反）', () => {
		const src = stripComments(read(SERVICE));
		const at = src.indexOf('public async upgradeApp()');
		assert.ok(at > 0, '找不到 upgradeApp');
		const end = src.indexOf('\n\tpublic ', at + 10);
		const body = src.slice(at, end > at ? end : at + 6000);

		const iRelease = body.indexOf('DshHarnessChannelCommand.ReleaseHost');
		const iQuit = body.indexOf('quitAndInstall()');
		assert.ok(iRelease > 0, 'upgradeApp 必须释放 Host');
		assert.ok(iQuit > 0, 'upgradeApp 必须调用 quitAndInstall');
		assert.ok(iRelease < iQuit,
			'释放 Host 必须在 quitAndInstall **之前**（否则进程还没退、锁还在 ⇒ 照样错误代码 5 ✗）');
		// 释放失败不许阻断升级（安装器还有 restartreplace 兜底）
		assert.match(body, /catch \(e\)/, '释放 Host 必须兜住异常');
	});
});
