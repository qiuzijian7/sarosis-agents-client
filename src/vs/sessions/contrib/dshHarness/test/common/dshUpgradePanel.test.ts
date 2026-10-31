/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「升级入口收敛」守卫（2026-10-30）。
 *
 * 用户这一轮的三条要求：
 *   ① 启动 desktop 后，左下角**更新 UI 里直接显示更新内容**（不是只有"N 项可用"）；
 *   ② 手动点升级后**后台下载 + 重启**；
 *   ③ IDE 侧从 VsSaros 菜单「检查更新…」**打开面板，手动点检查**；
 *   ④ 启动时**不许自动弹**升级提示（原 `DshUpdateCheckContribution` 每天弹一条）。
 *
 * 这份测试只钉"结构与判据"，不测像素。⚠ 断言前必须剥注释：这些关键词在注释里都写过
 * （实测不剥注释会假绿 —— 把 prompt 加回注释里也能过）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUpgradePanel
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const CONTRIB = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const PANE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshUpgradeEditorPane.ts';
const MENUBAR = 'src/vs/sessions/browser/parts/menubar.contribution.ts';
const UPGRADE_CHUNK = 'dsh-plugins/vssaros-chat-surface/lib/client.upgrade.js';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `source missing (cwd changed?): ${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 剥掉块注释与整行行注释（注释里写满关键词，不剥会假绿）。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('升级入口收敛（启动不弹 / 菜单开面板 / 行上显示内容）', () => {

	test('① 启动链路不许再自动检查或弹升级提示', () => {
		const src = stripComments(read(CONTRIB));
		assert.ok(!/DshUpdateCheckContribution/.test(src),
			'DshUpdateCheckContribution 必须整段下线（它会在 Host running 后每 24h 弹一条升级提示）✗');
		assert.ok(!/dshHarness\.update\.available/.test(src),
			'不许再出现启动升级提示的文案 key（用户："不希望在此处弹出"）✗');
		assert.ok(!/notification\.prompt\(/.test(src),
			'启动链路里不许再 notification.prompt（那是弹窗的唯一来源）✗');
	});

	test('② VsSaros 菜单的「检查更新」必须指向我们自己的面板命令', () => {
		const src = stripComments(read(MENUBAR));
		const at = src.indexOf('检查更新');
		assert.ok(at > 0, '菜单里找不到「检查更新」项 ✗');
		// ⚠ id 在 title **之前**（`{ command: { id, title } }`）⇒ 必须前后都取，只看后面会假红
		const block = src.slice(Math.max(0, at - 400), at + 400);
		assert.match(block, /id:\s*'dshHarness\.checkAppUpdates'/,
			'菜单项必须指向 dshHarness.checkAppUpdates（原生 update.checkForUpdate 只会下载应用安装包，看不到插件/资产）✗');
		assert.ok(!/id:\s*'update\.checkForUpdate'/.test(block),
			'不许再指向原生 update.checkForUpdate ✗');
	});

	test('③ 面板打开**不联网**：手动点「检查更新」才查', () => {
		const src = stripComments(read(PANE));
		const at = src.indexOf('override async setInput(');
		assert.ok(at > 0, '面板缺少 setInput ✗');
		const body = src.slice(at, src.indexOf('\n\toverride layout', at));
		assert.match(body, /this\._refresh\(false\)/,
			'setInput 里必须用 _refresh(false)（打开面板不联网 —— 用户要的是"手动点击检查升级"）✗');
		assert.ok(!/this\._refresh\(true\)/.test(body), 'setInput 里不许直接 _refresh(true) ✗');

		const checkAt = src.indexOf("dataset['action'] = 'check'");
		assert.ok(checkAt > 0, '缺少「检查更新」按钮的锚点（dataset.action=check）✗');
		const checkLine = src.slice(Math.max(0, checkAt - 200), checkAt);
		assert.match(checkLine, /_refresh\(true\)/, '「检查更新」按钮必须走 _refresh(true) ✗');
	});

	test('④ 面板三条动作都接上，且数据只来自 getUpgradeState（不许自己算）', () => {
		const src = stripComments(read(PANE));
		assert.match(src, /this\._dsh\.getUpgradeState\(/, '面板必须走 getUpgradeState（与 desktop 那行同源）✗');
		assert.match(src, /this\._dsh\.upgradeApp\(\)/, '缺少一键升级应用 ✗');
		assert.match(src, /this\._dsh\.upgradeBundled\(/, '缺少随包插件升级 ✗');
		assert.match(src, /this\._dsh\.upgradeAsset\(/, '缺少商城资产升级 ✗');
		assert.ok(!/listBundledPlugins|checkUpgrades\(/.test(src),
			'面板不许自己读插件清单/商城（会与 service 口径漂移 ⇒ "面板 3 项、行上 2 项"）✗');
	});

	test('⑤ 一键升级按钮只认 action === "upgrade"（不降级），且 busy 时禁用', () => {
		const src = stripComments(read(PANE));
		const at = src.indexOf("dataset['action'] = 'upgrade-app'");
		assert.ok(at > 0, '缺少应用一键升级按钮的锚点 ✗');
		const above = src.slice(Math.max(0, at - 400), at);
		assert.match(above, /app\?\.action === 'upgrade'/,
			'按钮可用性必须只认 action === "upgrade"（downgrade = 源比本地旧 ⇒ 一键降级 ✗）✗');
		assert.match(above, /disabled/, '按钮必须受 disabled（busy / 不可升）控制 ✗');
	});

	test('⑥ service 必须暴露有返回值的 getUpgradeState（面板拿得到数据）', () => {
		const svc = stripComments(read(SERVICE));
		assert.match(svc, /getUpgradeState\(check\?: boolean\): Promise<IDshUpgradeState>;/,
			'接口上必须有 getUpgradeState(check?: boolean) ✗');
		assert.match(svc, /public async getUpgradeState\(check\?: boolean\): Promise<IDshUpgradeState>/,
			'实现必须存在 ✗');
		assert.match(svc, /return await this\._buildUpgradeState\(\);/,
			'实现必须复用 _buildUpgradeState（同一份口径）✗');
	});

	test('⑦ 左下角那行必须**显示更新内容**（具体项目 + 版本），不只是数量', () => {
		const chunk = stripComments(read(UPGRADE_CHUNK));
		const at = chunk.indexOf('const upcomingItems = ');
		assert.ok(at > 0, '缺少 upcomingItems（"更新内容"清单）✗');
		const end = chunk.indexOf(';', at);
		const body = chunk.slice(at, end > 0 ? end : at + 800);
		assert.match(body, /upgradableRows\(/, '清单必须来自可升级的随包插件 ✗');
		assert.match(body, /assetRows\(/, '清单必须包含商城资产 ✗');
		assert.ok(!/pendingRows\(/.test(body),
			'清单不许用 pendingRows（含"未安装"，那不是更新内容）✗');

		// Row 必须渲染第二行（.vu-sub），否则等于没显示内容
		const rowAt = chunk.indexOf('function Row(props)');
		assert.ok(rowAt > 0, '找不到 Row ✗');
		const row = chunk.slice(rowAt, chunk.indexOf('function bundledRows', rowAt));
		assert.match(row, /className: "vu-sub"/, 'Row 必须渲染 .vu-sub（第二行 = 更新内容）✗');
		assert.match(row, /upcomingItems\(s\)/, 'Row 必须用 upcomingItems ✗');
	});
});
