/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「应用更新必须在启动时自动查一次」的守卫（2026-10-29）。
 *
 * 真机报障：打包出的 exe 左下角那行一直显示「已最新」，而更新源上**确实有新版**
 * （本地 2.2.26207 / 源上 2.2.26208，URL 与响应都验过）。
 *
 * 根因有两层：
 *   1) 后端 `_checkAppUpdate()` **只在用户点「检查更新」/「一键升级」时**被调用
 *      （`refreshUpgrade` / `upgradeApp`）=> 启动时从来没人查 => `_appUpdate` 恒 undefined
 *      => 快照里 `app.action = 'unknown'`（页面文案「还没检查」）X。
 *   2) 前端 `client.upgrade.js` 的 `totalPending` 只数「随包插件 + 商城资产」，
 *      **把应用更新漏掉了** => 就算后端查到了，侧栏那行仍然是 0 项 X。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshAppUpdateAutoCheck
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const UPGRADE_CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.upgrade.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `source missing (cwd changed?): ${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('应用更新的启动时自动检查', () => {

	test('1) 启动后必须静默查一次应用更新', () => {
		const src = stripComments(read(SERVICE));

		const ctorAt = src.indexOf('constructor(');
		assert.ok(ctorAt > 0, 'constructor not found');
		const ctorEnd = src.indexOf('\n\tprivate ', ctorAt);
		const ctor = src.slice(ctorAt, ctorEnd > 0 ? ctorEnd : ctorAt + 8000);
		assert.match(ctor, /_scheduleSilentAppUpdateCheck\(\)/,
			'构造函数必须挂上「启动时静默检查应用更新」（否则 _appUpdate 永远是 undefined => 左下角永远"已最新"）');

		const at = src.indexOf('private _scheduleSilentAppUpdateCheck(');
		assert.ok(at > 0, '_scheduleSilentAppUpdateCheck not found');
		const end = src.indexOf('\n\tprivate ', at + 10);
		const body = src.slice(at, end > 0 ? end : at + 2000);

		assert.match(body, /setTimeout\(/, '必须延后再查（避开首启高峰）');
		assert.match(body, /await this\._checkAppUpdate\(\)/, '必须真的调 _checkAppUpdate()');
		assert.match(body, /this\._appUpdate = /, '结果必须写进 _appUpdate（新视图靠 _pushUpgradeState 带上它）');
		assert.match(body, /_pushUpgradeToAll\(\)/, '查完必须推给已有视图');
		assert.match(body, /catch \(e\)/, '必须兜住异常（更新源挂了不许影响启动）');
		assert.ok(!/this\._upgradeBusy = /.test(body),
			'不许设 _upgradeBusy（静默检查不该让页面显示"正在检查更新源…"）');
	});

	test('2) 侧栏那行的计数必须把「应用可升级」算进去', () => {
		// ⚠ 必须剥掉注释：注释里写着 `action === "upgrade"`（中文说明）⇒ 不剥会被注释骗过（实测假绿）。
		const chunk = stripComments(read(UPGRADE_CHUNK));

		assert.match(chunk, /const appUpgradable = s =>/, '必须有 appUpgradable 判定');
		assert.match(chunk, /appUpgradable\(s\) \? 1 : 0/, 'totalPending 必须把应用可升级计成 1 项');
		// ⚠ 必须**定位到 appUpgradable 那一行**：文件里 `actionText()` 也有 `app.action === "upgrade"`
		//   ⇒ 全局匹配会被那处骗过（实测：把 appUpgradable 改成认 downgrade 仍然绿 ✗）。
		const auAt = chunk.indexOf('const appUpgradable = s =>');
		const auLine = chunk.slice(auAt, chunk.indexOf('\n', auAt));
		assert.match(auLine, /action === "upgrade"/,
			'appUpgradable 必须只认 action === "upgrade"（downgrade = 源比本地旧，算进去就是"一键降级" ✗）');

		const nUpAt = chunk.indexOf('const nUp =');
		assert.ok(nUpAt > 0, 'nUp not found');
		const nUpLine = chunk.slice(nUpAt, chunk.indexOf('\n', nUpAt));
		assert.ok(!/appUpgradable/.test(nUpLine), '「全部升级」不许把应用算进去（应用有独立的一键升级按钮）');
	});
});
