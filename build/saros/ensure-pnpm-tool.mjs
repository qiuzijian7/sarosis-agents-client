#!/usr/bin/env node
/**
 * ensure-pnpm-tool.mjs — 把 pnpm 的单文件 bundle 落进产物。
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
 * 为什么只带一个 `pnpm.cjs`：
 *   pnpm 10 的 npm 包是**单文件 bundle**（`dist/pnpm.cjs`，7.4MB，自带全部依赖）
 *   ⇒ 不需要 node_modules 树、不需要 bin shim ⇒ 产物里只多 7.4MB ✓
 *   ⚠ 它需要 node 解释器 ⇒ 由 IDE 侧用 **Electron 自己的 `ELECTRON_RUN_AS_NODE=1`** 来跑
 *     （实测 `ELECTRON_RUN_AS_NODE=1 "<VsSaros.exe>" pnpm.cjs --version` ⇒ 10.18.0，1.1 秒）
 *     ⇒ **不要求用户机器装 node** ✓✓
 *
 * 用法：
 *   node build/saros/ensure-pnpm-tool.mjs [构建输出目录]
 *   目标：<构建输出>/resources/app/tools/pnpm/pnpm.cjs
 *
 * 失败策略：**只警告，不阻断打包**（启动路径已被直装兜底覆盖，这只是"运行时能力"）。
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/** 与 strip-before-pack 一致的默认产物目录。 */
const DEFAULT_BUILD_DIR = join(ROOT, '../VSCode-win32-x64');

/** 小于这个大小基本可以断定是半截文件/占位文件。 */
const MIN_BYTES = 1024 * 1024;

function resolveBuildDir() {
	const explicit = process.argv[2];
	if (explicit) {
		return resolve(explicit);
	}
	const candidates = [DEFAULT_BUILD_DIR];
	try {
		const { readdirSync } = require('node:fs');
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

/** 从全局 pnpm 的 shim 位置向上找 `node_modules/pnpm/dist/pnpm.cjs`。 */
function fromGlobalPnpm() {
	const whichCmd = process.platform === 'win32' ? 'where' : 'which';
	let out = '';
	try {
		out = execFileSync(whichCmd, ['pnpm'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return undefined;
	}
	for (const line of String(out).trim().split(/\r?\n/).filter(Boolean)) {
		let dir = dirname(line.trim());
		// 向上最多走 4 层找 node_modules/pnpm/dist/pnpm.cjs
		for (let i = 0; i < 4; i++) {
			const cand = join(dir, 'node_modules/pnpm/dist/pnpm.cjs');
			if (existsSync(cand)) {
				return cand;
			}
			const parent = dirname(dir);
			if (parent === dir) {
				break;
			}
			dir = parent;
		}
	}
	return undefined;
}

/** 候选源（按优先级）。 */
function candidates() {
	return [
		join(ROOT, 'node_modules/pnpm/dist/pnpm.cjs'),
		fromGlobalPnpm(),
	].filter(Boolean);
}

const buildDir = resolveBuildDir();
const targetDir = join(buildDir, 'resources/app/tools/pnpm');
const target = join(targetDir, 'pnpm.cjs');

if (!existsSync(buildDir)) {
	console.error(`❌ 构建输出目录不存在: ${buildDir}`);
	console.error('   ⇒ 显式传目录：node build/saros/ensure-pnpm-tool.mjs <产物根>');
	process.exit(1);
}

// ① 产物里已有且看起来完整 ⇒ 跳过
if (existsSync(target)) {
	const size = statSync(target).size;
	if (size >= MIN_BYTES) {
		console.log(`✅ 产物里已有 pnpm.cjs（${(size / 1048576).toFixed(2)}MB）`);
		process.exit(0);
	}
	console.warn(`⚠️  产物里的 pnpm.cjs 只有 ${size} 字节（疑似半截）⇒ 重新落位`);
}

// ② 找一个可用的源
const src = candidates().find(p => existsSync(p) && statSync(p).size >= MIN_BYTES);
if (!src) {
	console.warn('⚠️  找不到可用的 pnpm.cjs 源（仓库 node_modules 与全局 pnpm 都没有）');
	console.warn('   ⇒ 产物**不自带** pnpm：启动装插件仍走直装兜底（没问题），');
	console.warn('      但"在页面里装插件/技能"这类运行时能力在**没有 pnpm 的机器**上会失败。');
	console.warn('   修法：先 `npm i -g pnpm`（或 `npm i pnpm --no-save`）再重新打包。');
	process.exit(0); // ⚠ 不阻断打包（启动路径已被直装覆盖）
}

// ③ 落位
try {
	mkdirSync(targetDir, { recursive: true });
	copyFileSync(src, target);
	const size = statSync(target).size;
	console.log(`✅ 已把 pnpm.cjs 落进产物（${(size / 1048576).toFixed(2)}MB）⟵ ${src}`);
} catch (e) {
	console.warn(`⚠️  pnpm.cjs 落位失败：${String(e?.message ?? e)}`);
	process.exit(0); // 同上：不阻断打包
}
