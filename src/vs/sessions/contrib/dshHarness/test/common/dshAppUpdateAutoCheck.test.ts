/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「应用更新必须在启动时自动查一次」+「应用更新有独立 UI 承载」的守卫（2026-10-29 / 11-05 修订）。
 *
 * 2026-10-29 真机报障：打包出的 exe 左下角那行一直显示「已最新」，而更新源上**确实有新版**
 * （本地 2.2.26207 / 源上 2.2.26208，URL 与响应都验过）。
 * 根因两层：
 *   1) 后端 `_checkAppUpdate()` **只在用户点「检查更新」/「一键升级」时**被调用
 *      => 启动时从来没人查 => `_appUpdate` 恒 undefined => 快照里 `app.action = 'unknown'` X。
 *   2) 前端 `client.upgrade.js` 的 `totalPending` 只数「随包插件 + 商城资产」，把应用更新漏掉 X。
 *
 * ★★ 2026-11-05 口径变更：应用本体更新**整条搬去** `client.appUpdate.js` 的**右下更新卡片**
 *   （复刻 dsh-desktop，8 相状态机）。左下胶囊从「应用 + 插件 + 资产」收敛为
 *   **只数随包插件 + 商城资产**，没有可升级资产时整块不渲染（10-23 用户口径）。
 *   ⇒ 旧第 2 条「侧栏计数必须把应用可升级算进去」已作废（它成了这条守卫唯一的失败项）。
 *   现改为钉住两件事：① 胶囊不许再把应用更新算进去（防两套 UI 同时提示）；
 *   ② 卡片必须真的接进 `ALWAYS_CHUNKS`（文件躺在包里但没接线 = 功能永不生效 ✗）。
 *   启动静默检查**仍然保留**，只是不弹卡片（见 `_onUpdateServiceState` 的注释）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshAppUpdateAutoCheck
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const UPGRADE_CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.upgrade.js';
const APP_UPDATE_CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.appUpdate.js';
const CHAT_SURFACE_ENTRY = 'dsh-plugins/vssaros-chat-surface/lib/client.js';

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
			'构造函数必须挂上「启动时静默检查应用更新」（否则 _appUpdate 永远是 undefined => 页面拿不到应用更新结论）');

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

	test('2) ★ 左下胶囊只数「插件 + 商城资产」，不许再把应用更新算进去', () => {
		// ⚠ 必须剥掉注释：注释里写着 `action === "upgrade"`（中文说明）⇒ 不剥会被注释骗过（实测假绿）。
		const chunk = stripComments(read(UPGRADE_CHUNK));

		// ① 计数口径：`totalPending` 只由 upgradableRows + assetRows 构成，不含任何 app.* 判定。
		const pendingAt = chunk.indexOf('const totalPending =');
		assert.ok(pendingAt > 0, '找不到 totalPending');
		const pendingLine = chunk.slice(pendingAt, chunk.indexOf('\n', pendingAt));
		assert.match(pendingLine, /upgradableRows\(s\)\.length \+ assetRows\(s\)\.length/,
			'只数可升级随包插件 + 商城资产');
		assert.ok(!/app\./.test(pendingLine),
			'应用本体更新不许再进 totalPending（11-05 起归右下卡片，两套 UI 同时提示是回归）');

		// ② 显隐条件只看 pendingCount：旧版的 `appNew` / `busyNow` / `appUp` 判定不许复活。
		assert.match(chunk, /if \(!open && pendingCount === 0\) \{/,
			'没有可升级资产时整块不渲染（10-23 用户口径），不再因"应用有新版"顶出来');
		assert.ok(!/const appUp = |const appNew = |const busyNow = |应用可升级/.test(chunk),
			'旧版「应用可升级」文案/判定不许回来（应用更新已搬到 client.appUpdate.js）');
	});

	test('3) ★ 应用更新卡片必须真的接线，且能读到静默检查的结论', () => {
		// 接线：`ALWAYS_CHUNKS` 里必须有无条件装载 —— 漏了接线时文件静静躺在包里，功能永不生效 ✗
		// （`check-chat-surface-chunks.mjs` 的接线守卫同源：PART_CHUNKS 只在 surface=chat 装载）。
		const entry = stripComments(read(CHAT_SURFACE_ENTRY));
		const at = entry.indexOf('const ALWAYS_CHUNKS = [');
		assert.ok(at > 0, '找不到 ALWAYS_CHUNKS');
		const list = entry.slice(at, entry.indexOf('];', at));
		assert.match(list, /\.\/client\.appUpdate\.js/, '应用更新卡片必须无条件装载（不只是 surface=chat）');

		const card = stripComments(read(APP_UPDATE_CHUNK));
		// 8 相状态机的显隐口径：3 个自动可见 + 4 个需 manual，idle 不弹。
		assert.match(card, /const AUTO_VISIBLE = \["available", "downloading", "downloaded"\]/,
			'发现新版/下载中/已下载要自动出卡片');
		assert.match(card, /const MANUAL_ONLY = \["checking", "up-to-date", "error", "unsupported"\]/,
			'其余阶段只有用户手动检查才出卡片');
		assert.match(card, /return status\.manual && MANUAL_ONLY\.indexOf\(status\.phase\) >= 0/,
			'手动阶段必须受 manual 约束（启动静默检查不该弹卡片）');
		// 静默检查只产出 `app.action` + `app.remote`（不经过 IUpdateService）⇒ 卡片必须能把它读成版本，
		// 否则将来把 phase 推进到 available 时卡片会显示不出目标版本。
		assert.match(card, /app\.action === "upgrade" && typeof app\.remote === "string" \? app\.remote/,
			'readState 必须兼容静默检查的 action=upgrade + remote（否则卡片拿不到目标版本）');
	});
});
