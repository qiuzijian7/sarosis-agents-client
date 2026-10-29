/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「启动前补回随包插件缺失的自带文件」的守卫（2026-10-29）。
 *
 * 真机（桌面窗口一片空白，Host 起不来）：
 *
 *     dsh: skipping profile bundle "@vssaros/dsh-agents": failed to read overlay
 *           …\profiles\vssaros\node_modules\@vssaros\dsh-agents\cordis.presets.yml: ENOENT
 *     failed to import: ERR_MODULE_NOT_FOUND: Cannot find module
 *           '…\profiles\vssaros\node_modules\@vssaros\dsh-kb\vendor\markdown-it.cjs'
 *     start failed: Host 启动期间退出（code 1）
 *
 * ⇒ profile 是**半装**的（升级安装失败 ⇒ `node_modules` 被删了却没装回）。
 * ⇒ 而「已装判定」只看**版本 + 入口文件** ⇒ 缺自带文件仍判「已装」⇒ **永不重装** ⇒ 死循环。
 *
 * ⇒ 修法：启动前拿**随包目录**（永远完整的那份）当基准，把已装目录里缺的文件**补回来**。
 *
 * ⚠ 随包根必须从 `modulePluginDirs` 的目录**反推父目录**，不能用 `listBundledPlugins`：
 *   后者只列**模块插件**（`vssaros.module` 非空），而真正出问题的是**伴生插件**
 *   （`dsh-kb` / `dsh-agents`）⇒ 用它会漏掉要修的那批 ✗。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshBundledPluginFilesRepair
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const REPAIR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshProfileDepsRepair.ts';
const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('启动前补回随包插件缺失的自带文件', () => {

	test('1) 补回函数必须真的拷贝文件，且只处理已安装的插件', () => {
		const src = stripComments(read(REPAIR));
		const at = src.indexOf('export async function repairBundledPluginFiles(');
		assert.ok(at > 0, '缺少 repairBundledPluginFiles');
		const end = src.indexOf('\nexport ', at + 10);
		const body = src.slice(at, end > at ? end : at + 3000);

		assert.match(body, /readdir\(bundledRoot/, '必须遍历随包目录');
		assert.match(body, /fsp\.copyFile\(/, '必须真的把缺失文件拷贝过去（只打日志不算）');
		// ⚠ 没装的插件交给安装流程（不越权）
		assert.match(body, /fsp\.stat\(destDir\)/, '必须先判断已装目录在不在');
		// 单个文件补不回来不许炸（⚠ 断言不能写注释里的文字：stripComments 会把块注释删掉 ⇒ 假红）
		assert.match(body, /catch \{/, '单个文件失败不许阻断（必须有 catch）');
	});

	test('2) supervisor 必须在 spawn 之前调用它，且随包根从 modulePluginDirs 反推', () => {
		const src = stripComments(read(SUPERVISOR));

		const at = src.indexOf('const args = buildHostArgs(');
		assert.ok(at > 0, '找不到 spawn 之前那行');
		const iRepair = src.indexOf('repairBundledPluginFiles(', at);
		const iSpawn = src.indexOf('spawn(node.path, args', at);
		assert.ok(iRepair > at, '启动前必须补回随包插件文件（半装 profile 是 Host 起不来的真因）');
		assert.ok(iSpawn > at, '找不到 spawn dsh 那行');
		assert.ok(iRepair < iSpawn, '补回必须在 spawn **之前**（插件 import 发生在 dsh 启动时 ✗）');

		// 随包根：从 modulePluginDirs 反推（不能用 listBundledPlugins，会漏伴生插件）
		const rootAt = src.indexOf('private _bundledPluginsRoot(');
		assert.ok(rootAt > 0, '缺少 _bundledPluginsRoot');
		const rootBody = src.slice(rootAt, rootAt + 600);
		assert.match(rootBody, /modulePluginDirs/, '随包根必须从 modulePluginDirs 的目录反推父目录');
		assert.match(rootBody, /dirname\(/, '必须取父目录');
		assert.ok(!/listBundledPlugins/.test(rootBody),
			'不许用 listBundledPlugins 当随包根（它只列模块插件 ⇒ 会漏 dsh-kb 这类伴生插件 ✗）');
	});
});
