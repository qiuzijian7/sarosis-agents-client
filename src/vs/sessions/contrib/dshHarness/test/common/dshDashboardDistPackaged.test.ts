/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「主页前端产物必须进包」的守卫（2026-10-31，真机 P0：主页空白）。
 *
 * 真机（`main(8).log`，用户 yueezhu，主页一直空白）：
 *   `vssaros-dashboard (@vssaros/dsh-dashboard): failed to import: ENOENT … lib/app/dist/dashboard-app.js`
 *   ⇒ `SessionCreateError: session create failed: agent-preset/invalid: vssaros-dashboard … never started`
 *   ⇒ 会话建不起来 ⇒ 主页永远空白（窗口在、桥也连着，**只有内容区是空的**，极易误判成前端 bug）。
 *
 * 根因：那两个文件是 `dsh-plugins/vssaros-dashboard/vendor/build.mjs` 的**构建产物**，
 *   而 `.gitignore` 里 `dist/` ⇒ **0 个文件入库** ⇒ 干净检出 / CI / 别人打包时根本没有
 *   ⇒ 直装进 profile ⇒ 插件 import 失败。本机不复现：本机手工跑过构建 ✓。
 *
 * 修法（`build/saros/strip-before-pack.mjs`）：仓库里没有就**现跑构建**，再 `ensureFile` 落进暂存；
 *   构建失败 ⇒ `criticalMissing++`（构建收尾报红，不许静默出包）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshDashboardDistPackaged
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = 'build/saros/strip-before-pack.mjs';
const GITIGNORE = '.gitignore';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

suite('主页前端产物必须进包', () => {

	test('1) 两个产物都必须有 ensureFile 落位（缺一个主页就空白）', () => {
		const src = read(SCRIPT);
		for (const f of ['dashboard-app.js', 'dashboard-app.css']) {
			assert.ok(src.includes(`vssaros-dashboard/lib/app/dist/${f}`),
				`打包脚本必须处理 ${f}（缺它 ⇒ dsh-dashboard import 失败 ⇒ 主页空白 ✗）`);
		}
		// 暂存位置必须与随包插件目录一致（profile 里就是按这个路径装的）。
		// ⚠ 代码里文件名是模板变量 `${a.file}` ⇒ 只断言路径前缀
		assert.match(src, /resources\/app\/dsh-plugins\/vssaros-dashboard\/lib\/app\/dist\//,
			'落位路径必须是 resources/app/dsh-plugins/<插件目录>/lib/app/dist/…');
	});

	test('2) 仓库里没有时必须现跑构建，且失败要 criticalMissing', () => {
		const src = read(SCRIPT);
		// ⚠ 日志文案里也提到 vendor/build.mjs ⇒ 取**最后一次**出现（真正的 spawnSync 那处）
		const at = src.lastIndexOf('vendor/build.mjs');
		assert.ok(at > 0, '必须有"现跑 vendor/build.mjs"的兜底（dist/ 不入库 ⇒ 干净检出一定没有）');
		const seg = src.slice(Math.max(0, at - 600), at + 1200);
		// ⚠ 断言**构建脚本路径本身**：只断言 `spawnSync(process.execPath, [` 会被"调用被禁用"骗过去
		//   （第一版守卫就这么被 M3 骗成假绿）
		assert.match(seg, /path\.join\(repoRoot, 'dsh-plugins\/vssaros-dashboard\/vendor\/build\.mjs'\)/,
			'必须把 vendor/build.mjs 的路径真的传给 spawnSync');
		assert.match(seg, /spawnSync\(process\.execPath, \[/, '必须真的用 node 跑构建脚本');
		assert.match(seg, /criticalMissing \+= missing\.length;/, '构建失败必须计入 criticalMissing（不许静默出包）');
	});

	test('3) 这两个文件确实不入库（所以才需要第 2 条）——若哪天改成入库了，本条会红，需复核', () => {
		const gi = read(GITIGNORE);
		assert.match(gi, /^\s*dist\/\s*$/m, '.gitignore 里有 dist/（产物不入库 ⇒ 打包链必须自己生成）');
	});
});
