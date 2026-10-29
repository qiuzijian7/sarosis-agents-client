/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「产物自带 pnpm」的守卫（2026-10-29）。
 *
 * 真机：别人机器上 `'pnpm' 不是内部或外部命令` ⇒ 35 个随包插件一个都没装上 ⇒ 界面只剩官方页。
 *
 * 两条腿走路：
 *   ① **启动时装随包插件** → 走「直装」兜底（不依赖 pnpm，实测 35/35、4.3 秒）⇒ 已在
 *      `dshPluginDirectInstall` 里守住；
 *   ② **运行时**（页面里装第三方插件/技能、`dsh plugin add`）→ 仍要 pnpm ⇒ 产物必须自带一份。
 *
 * 为什么只带一个 `pnpm.cjs`：pnpm 10 的 npm 包是**单文件 bundle**（`dist/pnpm.cjs`，7.4MB，
 * 自带全部依赖）⇒ 产物只多 7.4MB，不需要 node_modules 树、不需要 bin shim。
 *
 * 为什么 shim 必须用 `node.path`（Host 自己的解释器）而**不能**用 Electron：
 *   实测 `ELECTRON_RUN_AS_NODE=1 <exe> pnpm.cjs --version` 能出 10.18.0，
 *   但真实 `pnpm install` 会失败（Electron 39 的 node 对 pnpm 的安装阶段不够用）。
 *   而"别人机器没有 node"这件事由 `dshNodeInstaller` 兜着：没 node 就跑不了 dsh ⇒
 *   Host 起来时 `node.path` **一定**是可用解释器 ✓。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshBundledPnpm
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const TOOL = 'build/saros/ensure-pnpm-tool.mjs';
const STRIP = 'build/saros/strip-before-pack.mjs';
const RUNTIME = 'src/vs/sessions/contrib/dshHarness/electron-main/dshRuntimeManager.ts';
const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('产物自带 pnpm', () => {

	test('1) 落位脚本：目标在 resources/app/tools/pnpm，且校验大小', () => {
		const tool = stripComments(read(TOOL));
		assert.match(tool, /resources\/app\/tools\/pnpm/,
			'pnpm 必须落在 resources/app/tools/pnpm（与 injectBundledPnpm 的读取路径一致）');
		assert.match(tool, /pnpm\.cjs/,
			'必须落 pnpm.cjs（单文件 bundle）');
		// ⚠ 必须钉**真实比较**（`if (size >= MIN_BYTES)`），只查常量名会被"常量还在、比较改成 >= 0"骗过（实测假绿 ✗）
		assert.match(tool, /if \(size >= MIN_BYTES\)/,
			'"已存在"判定必须按 MIN_BYTES 真实比较（否则半截文件会被当成完整文件 ✗）');
		// 失败不许阻断打包（启动路径已被直装兜底覆盖）
		assert.match(tool, /不阻断打包|process\.exit\(0\)/,
			'拿不到 pnpm 时不许阻断打包（启动路径已有直装兜底）');
		// 不许要求用户机器有 node（那正是我们要解决的问题）
		assert.ok(!/require\('node:child_process'\)/.test(tool),
			'落位脚本不许依赖运行时 node（它是构建期脚本，可以在构建机跑；但产物里不该靠它）');
	});

	test('2) 打包时落位（strip-before-pack 调用它）', () => {
		const strip = stripComments(read(STRIP));
		assert.match(strip, /ensure-pnpm-tool\.mjs/,
			'strip-before-pack 必须调用 ensure-pnpm-tool（否则产物里没有 pnpm）');
		assert.match(strip, /spawnSync\(process\.execPath, \[tool, buildDir\]/,
			'必须真的执行它（只引用文件名不算）');
	});

	test('3) 注入：系统没有 pnpm 时才注入，且用 node.path 而非 Electron', () => {
		const runtime = stripComments(read(RUNTIME));
		const at = runtime.indexOf('export function injectBundledPnpm');
		assert.ok(at > 0, '缺少 injectBundledPnpm');
		const end = runtime.indexOf('\nexport ', at + 10);
		const body = runtime.slice(at, end > 0 ? end : at + 3000);

		assert.match(body, /bundledPnpmCjs\(\)/,
			'必须读产物自带的 pnpm.cjs');
		assert.match(body, /hasPnpmOnPath\(/,
			'系统已有 pnpm 时必须尊重用户环境（不注入）');
		assert.match(body, /nodeExe/,
			'shim 必须用调用方给的 node（Host 自己的解释器）');
		assert.ok(!/process\.execPath/.test(body),
			'shim 里不许用 process.execPath 顶替 node（Electron 跑 pnpm install 会失败）');

		// 必须在 spawn Host 之前真的被调用，并传 node.path
		const supervisor = stripComments(read(SUPERVISOR));
		assert.match(supervisor, /injectBundledPnpm\(env, node\.path\)/,
			'spawn Host 前必须调用 injectBundledPnpm(env, node.path)');
	});
});
