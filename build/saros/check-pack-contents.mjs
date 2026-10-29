#!/usr/bin/env node
/**
 * check-pack-contents.mjs — 产物**内容门禁**（打包前的最后一道闸）
 *
 * 为什么要它（2026-10-29 真机）：
 *   别人机器上装我们的 exe ⇒ 界面只剩 dsh 官方页；查日志发现产物里
 *   **缺 `@vscode/deviceid`**（`Error [ERR_MODULE_NOT_FOUND] … imported from …/out/main.js`）。
 *   而 `strip-before-pack.mjs` 里**早就有**补回这个包的 `ensureDir` 调用（00:36 就写好了），
 *   产物却是 13:40 打的 ⇒ **那个脚本根本没跑**（它不在 gulp 任务链里，靠手工执行）⇒
 *   ⇒ 缺件就这么一路溜到用户手上 ✗✗。
 *
 * 它做什么：
 *   1) **单一真相源**：关键构件清单**从 `strip-before-pack.mjs` 的 `ensureDir(...)` 调用里抽出来**
 *      （不另抄一份 ⇒ 以后加构件只改一处 ⇒ 清单不会漂移）；
 *   2) 逐项检查构建输出目录里**哨兵文件**是否真的在（`ensureDir` 的 sentinel）——
 *      ⚠ 不能只信"自愈时打了 ✅"：复制可能失败/被覆盖 ⇒ 这里**独立复核**；
 *   3) 再加几项"不在 ensureDir 里、但同样不能少"的东西（主进程产物、随包插件目录…）。
 *
 * 失败 ⇒ `exit(1)` ⇒ **打包中止**（Inno Setup 拿不到一个缺件的产物）。
 *
 * 用法：
 *   node build/saros/check-pack-contents.mjs [构建输出目录]
 *   默认目录：../VSCode-win32-x64（相对仓库根，与 strip-before-pack 一致）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

/**
 * 找"含 `resources/app` 的构建输出目录"。
 *
 * ★ 2026-10-29（实测踩坑）：只认 `../VSCode-win32-x64` 是不够的 —— 本机那个目录**根本不存在**
 *   （打包产物打完就清掉了，`.build/win32-x64/` 下只剩空的 `user-setup/`）⇒ 门禁会走
 *   "目录不存在 ⇒ 跳过"那条路 ⇒ **形同虚设** ✗✗。
 *   ⇒ 按候选列表探测，第一个"真的有 resources/app"的目录才是产物根 ✓。
 */
function resolveBuildDir() {
	const explicit = process.argv[2];
	if (explicit) {
		return resolve(explicit);
	}
	const candidates = [join(ROOT, '../VSCode-win32-x64')];
	// `.build/win32-x64/*`：有的流程把应用目录放在子目录里（如 `app/`）
	try {
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

const buildDir = resolveBuildDir();

if (!existsSync(buildDir)) {
	console.error(`❌ 构建输出目录不存在: ${buildDir}`);
	console.error('   候选探测：../VSCode-win32-x64、.build/win32-x64/*、.build/win32-x64');
	console.error('   ⇒ 打包时请显式传目录：node build/saros/check-pack-contents.mjs <产物根>');
	process.exit(1);
}
if (!existsSync(join(buildDir, 'resources/app'))) {
	console.error(`❌ ${buildDir} 下没有 resources/app ⇒ 这不是构建输出目录`);
	process.exit(1);
}

/**
 * 抽 `ensureDir(label, stagingRel, repoRel, sentinel?)` 的调用（哨兵默认 'extension.js'）。
 *
 * ⚠ **不用正则去匹配参数**（实测踩过两次坑）：我们自己的调用是**多行带尾逗号**的那种，
 *   一旦形式变了（换行/尾逗号/引号）正则就会**一个都匹配不到** ⇒ 门禁形同虚设 ✗✗。
 *   ⇒ 改成**按括号配对**取出调用块，再从块里取单引号字符串 ⇒ 对排版变化免疫 ✓。
 */
function ensureCallsFrom(source) {
	const out = [];
	// ⚠ **两类都要抽**（实测只抽 ensureDir 只得到 1 项）：strip 里的构件大部分走
	//   `ensureFile(相对路径, 产物路径, [仓库源…])`（文件级），少数走
	//   `ensureDir(名字, 产物路径, 仓库源, 哨兵?)`（目录级）⇒ 漏一类就等于漏掉一堆构件 ✗。
	for (const fn of ['ensureDir', 'ensureFile']) {
		let i = 0;
		for (;;) {
			const at = source.indexOf(fn + '(', i);
			if (at < 0) { break; }
			// 跳过函数**定义**（`function ensureDir(label, …)`）—— 它不是调用。
			if (/function\s+$/.test(source.slice(Math.max(0, at - 12), at))) { i = at + fn.length; continue; }
			// 找配对的右括号
			let depth = 0;
			let end = -1;
			for (let j = at + fn.length; j < source.length; j++) {
				const ch = source[j];
				if (ch === '(') { depth++; }
				else if (ch === ')') { depth--; if (depth === 0) { end = j; break; } }
			}
			if (end < 0) { break; }
			const args = [...source.slice(at, end + 1).matchAll(/'([^']*)'/g)].map(m => m[1]);
			// 两种调用的**第二个参数都是"产物里的相对路径"** ⇒ 统一按它检查 ✓
			if (args.length >= 2) {
				out.push({
					kind: fn,
					label: args[0],
					stagingRel: args[1],
					// ⚠ 哨兵**只在显式给了第四参时**才检查：ensureDir 省略时默认 'extension.js'，
					//   但那些构件目录里根本没有 extension.js（如 agent-studio/out）⇒ 误报 ✗。
					sentinel: (fn === 'ensureDir' && args.length >= 4) ? args[3] : undefined,
				});
			}
			i = end + 1;
		}
	}
	return out;
}

let stripSource = '';
try {
	stripSource = readFileSync(join(__dirname, 'strip-before-pack.mjs'), 'utf8');
} catch (e) {
	console.error(`❌ 读不到 build/saros/strip-before-pack.mjs：${String(e?.message ?? e)}`);
	console.error('   （门禁的清单来源没了 ⇒ 不能放行）');
	process.exit(1);
}

const fromEnsure = ensureCallsFrom(stripSource);

// ⚠⚠ 清单抽不出来 ⇒ 门禁**失效**了 ⇒ 必须 fail-closed（不许"清单为空 = 一切正常"地放行 ✗✗）
if (fromEnsure.length === 0) {
	console.error('❌ 从 strip-before-pack.mjs 抽不到任何 ensureDir 调用 ⇒ 门禁失效，拒绝放行');
	console.error('   （多半是 ensureDir 的调用形式变了 ⇒ 请同步更新 check-pack-contents.mjs 的正则）');
	process.exit(1);
}

/** 不在 ensureDir 里、但同样必须存在的（缺了 ⇒ 产物起不来或功能直接坏）。 */
const REQUIRED_EXTRA = [
	{ label: '主进程产物', rel: 'resources/app/out/main.js' },
	{ label: '随包 dsh 插件目录', rel: 'resources/app/dsh-plugins' },
];

/** 缺失只警告（有些构件由 Inno Setup 阶段另拷，不在构建输出里）。 */
const OPTIONAL_EXTRA = [
	{ label: '随包 dsh 运行时', rel: 'resources/app/dsh-runtime' },
];

const problems = [];
const warnings = [];

// ① ensureDir / ensureFile 清单（单一真相源）
for (const item of fromEnsure) {
	const abs = item.sentinel
		? join(buildDir, item.stagingRel, item.sentinel)
		: join(buildDir, item.stagingRel);
	if (!existsSync(abs)) {
		problems.push(`${item.label}：${item.stagingRel}${item.sentinel ? '/' + item.sentinel : ''} 缺失`);
	}
}

// ② 额外必需项
for (const item of REQUIRED_EXTRA) {
	if (!existsSync(join(buildDir, item.rel))) {
		problems.push(`${item.label}：${item.rel} 缺失`);
	}
}

// ③ 可选项（只警告）
for (const item of OPTIONAL_EXTRA) {
	if (!existsSync(join(buildDir, item.rel))) {
		warnings.push(`${item.label}：${item.rel} 不在构建输出里（若由安装阶段另拷则正常）`);
	}
}

if (problems.length) {
	console.error(`\n❌ 产物内容门禁未通过（${problems.length} 项关键构件缺失）：`);
	for (const p of problems) {
		console.error(`   · ${p}`);
	}
	console.error('\n   修法：');
	console.error('   ① 确认打包流程**真的跑了** build/saros/strip-before-pack.mjs（它负责自愈补回）；');
	console.error('   ② 若自愈后仍缺 ⇒ 检查仓库源是否存在（例如 node_modules/@vscode/deviceid），');
	console.error('      必要时先 `npm ci` 再重新打包。');
	process.exit(1);
}

for (const w of warnings) {
	console.log(`  ⚠️  ${w}`);
}
console.log(`✅ 产物内容门禁通过（${fromEnsure.length + REQUIRED_EXTRA.length} 项关键构件都在）`);
