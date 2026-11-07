#!/usr/bin/env node
/**
 * ensure-pnpm-tool.mjs — 把**仓库 pin 的那一份 pnpm** 落进产物（目录分发）。
 *
 * 为什么需要（2026-10-29）：
 *   别人机器上装我们的 exe ⇒ 界面只剩 dsh 官方页。查日志：
 *   `'pnpm' 不是内部或外部命令` ⇒ 35 个随包插件**一个都没装上**（0 ok, 35 to retry）
 *   ⇒ 换皮插件缺席 ⇒ 只剩官方外壳。
 *
 *   「启动时装插件」这条路已经有**直装兜底**（不依赖 pnpm，实测 35/35、4.3 秒），
 *   但**运行时**仍可能要用 pnpm（在页面里装第三方插件 / 技能、`dsh plugin add` 等）
 *   ⇒ 产物必须自带一份，否则那些功能在"没有 pnpm 的机器"上必然失败。
 *
 * ★ 2026-11-07：跟随上游 dsh 把 pnpm 从 10.18.0 升到 **11.28.5**，内置形态随之改变：
 *   · pnpm 10 的 npm 包是**单文件 bundle**（`dist/pnpm.cjs`，7.4MB）⇒ 以前只拷一个文件；
 *   · pnpm 11 是**目录分发**：`bin/pnpm.mjs`（1.4KB）动态 import `dist/pnpm.mjs`（15.9MB），
 *     外加 `dist/node_modules` / `dist/vendor` / `dist/templates` / `dist/worker.js`
 *     ⇒ 必须整包拷贝（约 21MB / 450 文件），只拷 bin 会 `ERR_MODULE_NOT_FOUND`。
 *   · pnpm 11.28.5 要求 **Node ≥22.13**（`bin/pnpm.mjs` 自己会检查）；Host 的托管 Node 门槛
 *     是 22.19+（`dshNodeInstaller.ts`），满足条件 ✓。
 *   ⇒ IDE 侧的 shim 用 **Host 自己的 `node.path`** 跑 `bin/pnpm.mjs`，不用 Electron 顶替
 *     （实测 Electron 39 跑 `pnpm install` 会在并发安装阶段崩）；也不要求用户机器装 node ✓。
 *
 * 单一真源：根 `package.json` 的 `devDependencies.pnpm`（精确版本）+ `packageManager`。
 * 构建期 prepack 用同一份 `node_modules/pnpm` 造 shim ⇒ 构建机 / 本机 / 用户机器三处同版本。
 *
 * 用法：
 *   node build/saros/ensure-pnpm-tool.mjs [构建输出目录]
 *   目标：<构建输出>/resources/app/tools/pnpm/{package.json,bin/pnpm.mjs,dist/pnpm.mjs,…}
 *
 * 失败策略：**只警告，不阻断打包**（启动路径已被直装兜底覆盖，这只是"运行时能力"）。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/** 与 strip-before-pack 一致的默认产物目录。 */
const DEFAULT_BUILD_DIR = join(ROOT, '../VSCode-win32-x64');

/** `dist/pnpm.mjs` 小于这个大小基本可以断定是半截文件/占位文件。 */
const MIN_BYTES = 1024 * 1024;

/** pnpm 版本的唯一真源（与 prepack / install-deps / check-dsh-release 同源）。 */
function pinnedPnpmVersion() {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
	const v = pkg?.devDependencies?.pnpm;
	const pm = typeof pkg?.packageManager === 'string' ? pkg.packageManager.replace(/^pnpm@/, '').trim() : '';
	if (typeof v !== 'string' || !/^\d+\.\d+\.\d+/.test(v) || v !== pm) {
		throw new Error(`根 package.json 的 pnpm 版本真源不一致/不精确：devDependencies.pnpm=${v}, packageManager=${pm}`);
	}
	return v;
}

function resolveBuildDir() {
	const explicit = process.argv[2];
	if (explicit) {
		return resolve(explicit);
	}
	const candidates = [DEFAULT_BUILD_DIR];
	try {
		// ⚠ 原来这里写的是 `require('node:fs')`（ESM 里 require 不存在 ⇒ 整段被 catch 吞掉，
		//   候选目录永远枚举不到）。改用顶部 import 的 readdirSync。
		for (const e of readdirSync(join(ROOT, '.build/win32-x64'), { withFileTypes: true })) {
			if (e.isDirectory()) {
				candidates.push(join(ROOT, '.build/win32-x64', e.name));
			}
		}
	} catch { /* 目录不存在就跳过 */ }
	candidates.push(join(ROOT, '.build/win32-x64'));
	for (const c of candidates) {
		if (existsSync(join(c, 'resources/app'))) {
			return resolve(c);
		}
	}
	return resolve(candidates[0]);
}

let PIN;
try {
	PIN = pinnedPnpmVersion();
} catch (e) {
	console.warn(`⚠️  ${String(e?.message ?? e)}`);
	console.warn('   ⇒ 产物**不自带** pnpm（不阻断打包；启动装插件走直装兜底）');
	process.exit(0);
}

const buildDir = resolveBuildDir();
const targetDir = join(buildDir, 'resources/app/tools/pnpm');
const srcDir = join(ROOT, 'node_modules', 'pnpm');

if (!existsSync(buildDir)) {
	console.error(`❌ 构建输出目录不存在: ${buildDir}`);
	console.error('   ⇒ 显式传目录：node build/saros/ensure-pnpm-tool.mjs <产物根>');
	process.exit(1);
}

/** 目标是否已经是**同一版本且完整**的 pnpm 包。 */
function targetIsCurrent() {
	const pkgPath = join(targetDir, 'package.json');
	const entry = join(targetDir, 'bin', 'pnpm.mjs');
	const bundle = join(targetDir, 'dist', 'pnpm.mjs');
	if (!existsSync(pkgPath) || !existsSync(entry) || !existsSync(bundle)) {
		return false;
	}
	try {
		if (JSON.parse(readFileSync(pkgPath, 'utf8')).version !== PIN) {
			return false; // 版本变了 ⇒ 必须覆盖（否则升级后产物里仍是旧的 10.x）
		}
		const size = statSync(bundle).size;
		return size >= MIN_BYTES;
	} catch {
		return false;
	}
}

// ① 产物里已有同版本的完整包 ⇒ 跳过
if (targetIsCurrent()) {
	const size = statSync(join(targetDir, 'dist', 'pnpm.mjs')).size;
	console.log(`✅ 产物里已有 pnpm@${PIN}（dist/pnpm.mjs ${(size / 1048576).toFixed(2)}MB）`);
	process.exit(0);
}

// ② 源必须就是仓库 pin 的那一份（不再从全局 pnpm 的 shim 位置瞎找 —— 那正是版本漂移的来源）
const srcPkg = join(srcDir, 'package.json');
if (!existsSync(srcPkg) || !existsSync(join(srcDir, 'bin', 'pnpm.mjs')) || !existsSync(join(srcDir, 'dist', 'pnpm.mjs'))) {
	console.warn(`⚠️  找不到 node_modules/pnpm@${PIN}（bin/pnpm.mjs + dist/pnpm.mjs）`);
	console.warn('   ⇒ 产物**不自带** pnpm：启动装插件仍走直装兜底（没问题），');
	console.warn('      但"在页面里装插件/技能"这类运行时能力在**没有 pnpm 的机器**上会失败。');
	console.warn('   修法：先 `npm install`（根 devDependencies 里有精确版本）再重新打包。');
	process.exit(0); // ⚠ 不阻断打包（启动路径已被直装覆盖）
}
const srcVersion = JSON.parse(readFileSync(srcPkg, 'utf8')).version;
if (srcVersion !== PIN) {
	console.warn(`⚠️  node_modules/pnpm 是 ${srcVersion}，期望 pin ${PIN} —— 拒绝把未 pin 的版本放进产物`);
	process.exit(0);
}

// ③ 落位：整包拷贝（bin + dist + package.json + LICENSE），并清掉 pnpm 10 时代的单文件残留
try {
	mkdirSync(targetDir, { recursive: true });
	rmSync(join(targetDir, 'pnpm.cjs'), { force: true }); // 旧版单文件 bundle：留着会让 shim 读到错的入口
	cpSync(join(srcDir, 'bin'), join(targetDir, 'bin'), { recursive: true, force: true });
	cpSync(join(srcDir, 'dist'), join(targetDir, 'dist'), { recursive: true, force: true });
	for (const f of ['package.json', 'LICENSE']) {
		if (existsSync(join(srcDir, f))) {
			cpSync(join(srcDir, f), join(targetDir, f), { force: true });
		}
	}
	const size = statSync(join(targetDir, 'dist', 'pnpm.mjs')).size;
	if (size < MIN_BYTES) {
		throw new Error(`落位后 dist/pnpm.mjs 只有 ${size} 字节（疑似半截）`);
	}
	console.log(`✅ 已把 pnpm@${PIN} 落进产物（dist/pnpm.mjs ${(size / 1048576).toFixed(2)}MB）⟵ ${srcDir}`);
} catch (e) {
	console.warn(`⚠️  pnpm@${PIN} 落位失败：${String(e?.message ?? e)}`);
	process.exit(0); // 同上：不阻断打包
}
