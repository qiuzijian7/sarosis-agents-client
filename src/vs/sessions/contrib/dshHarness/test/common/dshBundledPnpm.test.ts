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
 * ★ 2026-11-07：pnpm 跟随上游升到 **11.28.5**，内置形态随之改变：
 *   pnpm 10 是单文件 bundle（`dist/pnpm.cjs`，7.4MB）；pnpm 11 是**目录分发** ——
 *   `bin/pnpm.mjs` 动态 import `dist/pnpm.mjs`（15.9MB），还要 `dist/node_modules` /
 *   `dist/vendor` / `dist/worker.js` ⇒ 只拷入口会 ERR_MODULE_NOT_FOUND，必须整包随附（≈21MB）。
 *
 * 版本单一真源：根 `package.json` 的 `devDependencies.pnpm`（精确版本）+ `packageManager`。
 * 构建期 `prepack-dsh-runtime.mjs` 用同一份造 PATH shim；`ensure-pnpm-tool.mjs` 用同一份拷进产物；
 * `check-dsh-release.mjs` / `install-deps.ps1` 交叉校验 ⇒ 构建机 / 本机 / 用户机器三处同版本。
 *
 * 为什么 shim 必须用 `node.path`（Host 自己的解释器）而**不能**用 Electron：
 *   实测 Electron 39 的 node 跑 pnpm `--version` 没问题，但真实 `pnpm install` 会崩。
 *   而"别人机器没有 node"这件事由 `dshNodeInstaller` 兜着：没 node 就跑不了 dsh ⇒
 *   Host 起来时 `node.path` **一定**是可用解释器（门槛 22.19+，满足 pnpm 11 的 ≥22.13）✓。
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

	test('1) 落位脚本：pnpm 11 整包落位 + 版本 pin + 完整性校验', () => {
		const tool = stripComments(read(TOOL));
		assert.match(tool, /resources\/app\/tools\/pnpm/,
			'pnpm 必须落在 resources/app/tools/pnpm（与 injectBundledPnpm 的读取路径一致）');
		// ★ pnpm 11 是目录分发：只拷 bin/pnpm.mjs 会 ERR_MODULE_NOT_FOUND
		assert.match(tool, /bin\/pnpm\.mjs/, '入口必须是 bin/pnpm.mjs（不再是 pnpm.cjs 单文件）');
		assert.match(tool, /dist\/pnpm\.mjs/, '必须同时落 dist/pnpm.mjs（bin 会动态 import 它）');
		assert.match(tool, /devDependencies\.pnpm/, '版本必须来自根 package.json 的单一真源');
		assert.match(tool, /pinnedPnpmVersion/, '要把 pin 读出来并校验仓库装的版本');
		// ⚠ 必须钉**真实比较**，只查常量名会被"常量还在、比较改成 >= 0"骗过（实测假绿 ✗）
		assert.match(tool, /size >= MIN_BYTES/,
			'完整性判定必须按 MIN_BYTES 真实比较（否则半截文件会被当成完整文件 ✗）');
		// 失败不许阻断打包（启动路径已被直装兜底覆盖）
		assert.match(tool, /不阻断打包|process\.exit\(0\)/,
			'拿不到 pnpm 时不许阻断打包（启动路径已有直装兜底）');
		assert.ok(!/require\('node:child_process'\)/.test(tool),
			'落位脚本不许依赖运行时 node（它是构建期脚本，可以在构建机跑；但产物里不该靠它）');
		assert.ok(!/fromGlobalPnpm/.test(tool),
			'不许再从全局 pnpm 的 shim 位置找源（那正是 CI 版本漂移的来源）');
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

		assert.match(body, /bundledPnpmEntry\(\)/,
			'必须读产物自带的 pnpm 包入口（bin/pnpm.mjs）');
		// dist 的完整性检查在 bundledPnpmEntry() 里（不在 injectBundledPnpm 的函数体内）⇒ 查全文
		assert.match(runtime, /dist[\s\S]{0,120}?pnpm\.mjs/,
			'必须同时确认 dist/pnpm.mjs 在位（pnpm 11 是目录分发，缺它会 ERR_MODULE_NOT_FOUND）');
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

	test('4) 版本单一真源：根 package.json / prepack / 发布守卫 / CI 四处同源', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
		const pin = String(pkg?.devDependencies?.pnpm ?? '');
		assert.match(pin, /^\d+\.\d+\.\d+$/,
			'devDependencies.pnpm 必须是精确版本（不许 ^/~/latest，否则 CI 会漂）');
		assert.strictEqual(pkg.packageManager, `pnpm@${pin}`,
			'packageManager 必须与 devDependencies 同值（Corepack/工具读的是这个字段）');

		const prepack = stripComments(read('build/prepack-dsh-runtime.mjs'));
		assert.match(prepack, /devDependencies\.pnpm/, 'prepack 要从同一个真源读 pin');
		assert.match(prepack, /buildPnpmShimDir/, '构建期要把 pin 的那份注入 dsh 子进程 PATH');
		assert.ok(!/'install', '-g', 'pnpm'/.test(prepack),
			'prepack 不许再用 npm -g 装任意版本（那正是 12.18.0 漂进来的路径）');

		const release = stripComments(read('build/saros/check-dsh-release.mjs'));
		assert.match(release, /devDependencies\.pnpm/, '发布守卫要读同一个真源');
		assert.match(release, /tools', 'pnpm'/, '发布守卫要核对**产物内置**的那份');
		assert.match(release, /sameVersion\(prodPnpm\.version, depPin\)/,
			'产物内置版本必须与 pin 真实比对（只查文件存在不够）');

		const ci = stripComments(read('.ci/scripts/install-deps.ps1'));
		assert.match(ci, /devDependencies\.pnpm/, 'CI 要校验同一个真源');
		assert.ok(!/npm install -g pnpm/.test(ci), 'CI 不许再装 latest（构建期不读全局 pnpm）');
	});
});
