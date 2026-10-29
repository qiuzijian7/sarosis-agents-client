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

import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * 扫产物里对**裸模块**的引用（`require('@vscode/x')` / `from '@vscode/x'` / `import('@vscode/x')`）。
 *
 * ★ 为什么需要（2026-10-29 的真机事故）：
 *   `build/win32/code.iss` 的 `[Files]` Excludes 里排除了 `@vscode/deviceid` 与
 *   `@vscode/policy-watcher`（上游 VS Code 当遥测件剥掉）⇒ 而我们的 `out/main.js` **在 import 它们**
 *   ⇒ 装完就是 `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vscode/deviceid'` ✗✗。
 *   而这个缺件**在源目录里查不出来**（strip 的自愈日志显示 ✅ 存在）⇒ 只有对着**产物**查才能抓住。
 *
 * ⇒ 办法：**扫产物代码里真正 require 的 `@vscode/*`**，逐个确认 `node_modules/@vscode/*` 里在。
 *   ⚠ 只扫**产物真正引用到的**（而不是仓库里有什么）⇒ 天然不需要白名单：
 *   内联的（编译期已变成相对路径的）根本不会出现在产物里 ✓。
 */
function collectBareRequires(root, prefixes) {
	const found = new Set();
	const re = /(?:require\(|from\s+|import\s*\(\s*|require\.resolve\(\s*)['"]([^'"]+)['"]/g;
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				walk(p);
			} else if (/\.(js|mjs|cjs)$/i.test(e.name)) {
				let text;
				try {
					text = readFileSync(p, 'utf8');
				} catch {
					continue;
				}
				for (const m of text.matchAll(re)) {
					const spec = m[1];
					if (prefixes.some(pre => spec === pre || spec.startsWith(pre + '/'))) {
						found.add(spec);
					}
				}
			}
		}
	};
	walk(root);
	return found;
}

/**
 * 裸模块名 → 包目录（`@vscode/x` → `@vscode/x`；`x/y` → `x/y`）。
 */
function packageDirOf(spec) {
	return spec;
}

/**
 * 产物里的包可能不在磁盘上 —— **纯 JS 包被打进 `node_modules.asar`**，native 模块在
 * `node_modules.asar.unpacked` ⇒ 只查磁盘目录会**误判成缺件**（实测踩过 ✗）。
 * ⇒ 这里解析 asar 的**头部目录表**（不解包）来判断"包在不在归档里"。
 */
function asarHasPackage(asarFile, pkgDir) {
	let fd;
	try {
		fd = openSync(asarFile, 'r');
		const head = Buffer.alloc(16);
		if (readSync(fd, head, 0, 16, 0) < 16) {
			return false;
		}
		const headerSize = head.readUInt32LE(12);
		if (!headerSize || headerSize > 64 * 1024 * 1024) {
			return false;
		}
		const hbuf = Buffer.alloc(headerSize);
		if (readSync(fd, hbuf, 0, headerSize, 16) < headerSize) {
			return false;
		}
		const header = JSON.parse(hbuf.toString('utf8'));
		let node = header && header.files;
		for (const seg of pkgDir.split('/')) {
			if (!node) {
				return false;
			}
			node = node[seg];
			if (!node) {
				return false;
			}
			node = node.files;
		}
		return true;
	} catch {
		return false;
	} finally {
		try { if (fd !== undefined) { closeSync(fd); } } catch { /* ignore */ }
	}
}

/** 包在产物里吗？（磁盘目录 / asar 归档 / asar.unpacked 三处任一有就算在） */
function packagePresent(appDir, spec) {
	const parts = spec.split('/');
	if (existsSync(join(appDir, 'node_modules', ...parts))) {
		return true;
	}
	if (existsSync(join(appDir, 'node_modules.asar.unpacked', ...parts))) {
		return true;
	}
	const asar = join(appDir, 'node_modules.asar');
	return existsSync(asar) ? asarHasPackage(asar, spec) : false;
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

// ④ 依赖闭包核对（2026-10-29）：产物代码里**真正 require 的** `@vscode/*`，
//   逐个确认 `node_modules/@vscode/*` 里在 —— 缺一个就是运行时 `ERR_MODULE_NOT_FOUND`。
//   ⚠ 这条能抓住"源目录里有、装出来没有"的那类缺件（`code.iss` 的 Excludes 排除 ⇒ 装包时丢）。
const appDir = join(buildDir, 'resources/app');
// ⚠ 这道门禁是给**构建输出目录**用的（`VSCode-win32-x64`）⇒ 目录不对就别硬报一堆误导的"缺失"
//   （安装目录里 `out/` 已被 bundle 成 main.js、`out/vs/**` 结构也不同 ⇒ 全是假警报 ✗）。
if (!existsSync(join(appDir, 'out/main.js'))) {
	console.error(`❌ ${buildDir} 不像构建输出目录（缺 resources/app/out/main.js）`);
	console.error('   ⇒ 这道门禁要指向**打包的输入目录**（VSCode-win32-x64），不是安装目录。');
	console.error('   用法：node build/saros/check-pack-contents.mjs <构建输出目录>');
	process.exit(1);
}
if (existsSync(appDir)) {
	const scanRoots = [join(appDir, 'out'), join(appDir, 'extensions')].filter(p => existsSync(p));
	if (scanRoots.length) {
		const required = new Set();
		for (const root of scanRoots) {
			for (const spec of collectBareRequires(root, ['@vscode'])) {
				required.add(spec);
			}
		}
		for (const spec of required) {
			if (!packagePresent(appDir, spec)) {
				problems.push(`产物代码引用了 ${spec}，但产物里没有（磁盘/asar 都没有）⇒ 运行时 ERR_MODULE_NOT_FOUND`);
			}
		}
		console.log(`  · 依赖闭包核对：扫到 ${required.size} 个 @vscode/* 引用`);
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
