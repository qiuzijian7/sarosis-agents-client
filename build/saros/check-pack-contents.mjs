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
 *   3) 再加几项"不在 ensureDir 里、但同样不能少"的东西（主进程产物、随包插件目录…）；
 *   4) 按安装根预算检查安装后最长路径（Windows，默认上限 250）——
 *      超过就拒绝出包，避免 Inno 的 `restartreplace` 在用户机器上报 `MoveFile 错误 3`。
 *      可用 `VSSAROS_INSTALL_ROOT` 覆盖估算用的安装根。
 *
 * 失败 ⇒ `exit(1)` ⇒ **打包中止**（Inno Setup 拿不到一个缺件的产物）。
 *
 * 用法：
 *   node build/saros/check-pack-contents.mjs [构建输出目录]
 *   默认目录：../VSCode-win32-x64（相对仓库根，与 strip-before-pack 一致）
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDshRuntime } from './check-dsh-runtime.mjs';

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
// ── 平台布局（2026-10-31：macOS 打包支持）──────────────────────────────────────
// Windows/Linux ⇒ 产物根里是 `resources/app`；macOS ⇒ `.app` 里是 `Contents/Resources/app`。
const WIN_APP_SUB = 'resources/app';
const MAC_APP_SUB = 'Contents/Resources/app';

/** 该目录是否为产物根：返回其 app 子路径，不是产物根则返回 null。 */
function appSubOf(dir) {
	if (existsSync(join(dir, WIN_APP_SUB))) { return WIN_APP_SUB; }
	if (existsSync(join(dir, MAC_APP_SUB))) { return MAC_APP_SUB; }
	return null;
}

/** 候选展开：目录本身 + 一层子目录（macOS 的 `*.app` 就在构建输出目录里）。 */
function expandCandidates(dir) {
	const out = [dir];
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) { out.push(join(dir, e.name)); }
		}
	} catch { /* 目录不存在就跳过 */ }
	return out;
}

function resolveBuildDir() {
	const explicit = process.argv[2];
	if (explicit) {
		// 与 strip-before-pack.mjs 同口径：允许传 `VSCode-darwin-<arch>`（其内是 `<Name>.app`）
		const dir = resolve(explicit);
		if (appSubOf(dir)) { return dir; }
		for (const c of expandCandidates(dir)) {
			if (appSubOf(c)) { return resolve(c); }
		}
		return dir;
	}
	const candidates = [
		join(ROOT, '../VSCode-win32-x64'),
		// macOS：`../VSCode-darwin-<arch>/<Name>.app`（父目录与其子目录都探测 ⇒ 两种传法都命中）
		...expandCandidates(join(ROOT, '../VSCode-darwin-arm64')),
		...expandCandidates(join(ROOT, '../VSCode-darwin-x64')),
		// `.build/win32-x64/*`：有的流程把应用目录放在子目录里（如 `app/`）
		...expandCandidates(join(ROOT, '.build/win32-x64')),
	];

	for (const c of candidates) {
		if (appSubOf(c)) {
			return resolve(c);
		}
	}
	return resolve(candidates[0]);
}

let buildDir = resolveBuildDir();
const APP_SUB = appSubOf(buildDir) || WIN_APP_SUB;

/**
 * 安装后路径预算（2026-11-23）。
 *
 * `dsh-runtime/profile-seed` 里有 `.pnpm` 深层副本；用户装到
 * `D:\Programs\VsSarosis` 时最长路径已到 258，Inno 的 `restartreplace` 再给旧文件加
 * `old_*` 临时名就超过 Win32 MAX_PATH，升级报 `MoveFile 失败；错误代码 3`。
 *
 * 这里按「默认系统安装根」估算；可用 `VSSAROS_INSTALL_ROOT` 换成本机/CI 的真实安装根。
 * 250 是留给 `old_*` / 临时名 / 目录尾分隔符的余量，不是 MAX_PATH 本身。
 */
const MAX_INSTALLED_PATH = 250;
const INSTALL_ROOT_BUDGET = (process.env.VSSAROS_INSTALL_ROOT || 'C:\\Program Files\\VsSaros').replace(/[\\/]+$/, '');

/** 把「Windows 口吻」的相对路径翻译成当前平台的真实相对路径。 */
function toStagingRel(rel) {
	if (APP_SUB === WIN_APP_SUB) { return rel; }
	if (rel === WIN_APP_SUB) { return APP_SUB; }
	if (rel.startsWith(WIN_APP_SUB + '/')) { return APP_SUB + rel.slice(WIN_APP_SUB.length); }
	if (rel.startsWith('resources/')) { return 'Contents/Resources/' + rel.slice('resources/'.length); }
	return rel;
}

if (!existsSync(buildDir)) {
	console.error(`❌ 构建输出目录不存在: ${buildDir}`);
	console.error('   候选探测：../VSCode-win32-x64、../VSCode-darwin-<arch>[/<Name>.app]、.build/win32-x64/*、.build/win32-x64');
	console.error('   ⇒ 打包时请显式传目录：node build/saros/check-pack-contents.mjs <产物根>');
	process.exit(1);
}
if (!existsSync(join(buildDir, APP_SUB))) {
	console.error(`❌ ${buildDir} 下没有 ${APP_SUB} ⇒ 这不是构建输出目录`);
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
	const stagingRel = toStagingRel(item.stagingRel);
	const abs = item.sentinel
		? join(buildDir, stagingRel, item.sentinel)
		: join(buildDir, stagingRel);
	if (!existsSync(abs)) {
		problems.push(`${item.label}：${item.stagingRel}${item.sentinel ? '/' + item.sentinel : ''} 缺失`);
	}
}

// ② 额外必需项
for (const item of REQUIRED_EXTRA) {
	if (!existsSync(join(buildDir, toStagingRel(item.rel)))) {
		problems.push(`${item.label}：${item.rel} 缺失`);
	}
}

// ③ 可选项（只警告）
for (const item of OPTIONAL_EXTRA) {
	if (!existsSync(join(buildDir, toStagingRel(item.rel)))) {
		warnings.push(`${item.label}：${item.rel} 不在构建输出里（若由安装阶段另拷则正常）`);
	}
}

// ④ 依赖闭包核对（2026-10-29）：产物代码里**真正 require 的** `@vscode/*`，
//   逐个确认 `node_modules/@vscode/*` 里在 —— 缺一个就是运行时 `ERR_MODULE_NOT_FOUND`。
//   ⚠ 这条能抓住"源目录里有、装出来没有"的那类缺件（`code.iss` 的 Excludes 排除 ⇒ 装包时丢）。
const appDir = join(buildDir, APP_SUB);
// ⚠ 这道门禁是给**构建输出目录**用的（`VSCode-win32-x64` / `VSCode-darwin-<arch>`）⇒ 目录不对就别硬报一堆误导的"缺失"
//   （安装目录里 `out/` 已被 bundle 成 main.js、`out/vs/**` 结构也不同 ⇒ 全是假警报 ✗）。
if (!existsSync(join(appDir, 'out/main.js'))) {
	console.error(`❌ ${buildDir} 不像构建输出目录（缺 ${APP_SUB}/out/main.js）`);
	console.error('   ⇒ 这道门禁要指向**打包的输入目录**（VSCode-win32-x64），不是安装目录。');
	console.error('   用法：node build/saros/check-pack-contents.mjs <构建输出目录>');
	process.exit(1);
}

// ④-a 构建残留门禁（2026-11-21）：`prepack-dsh-runtime.mjs` 删不掉旧种子时会留下
//   `profile-seed.deleting-<pid>/`。它含 `.pnpm` 深层副本，整目录拷进暂存后安装路径会超过
//   Win32 MAX_PATH，Inno Setup 的 `restartreplace` 临时重命名报 `MoveFile 失败；错误代码 3`。
{
	const runtimeRoot = join(appDir, 'dsh-runtime');
	const stale = [];
	if (existsSync(runtimeRoot)) {
		for (const version of readdirSync(runtimeRoot, { withFileTypes: true })) {
			if (!version.isDirectory()) { continue; }
			const versionDir = join(runtimeRoot, version.name);
			for (const entry of readdirSync(versionDir, { withFileTypes: true })) {
				if (/\.deleting-\d+$/.test(entry.name)) { stale.push(`${version.name}/${entry.name}`); }
			}
		}
	}
	if (stale.length) {
		problems.push(`随包 dsh-runtime 含构建残留 ${stale.slice(0, 3).join('、')}${stale.length > 3 ? ` 等 ${stale.length} 项` : ''}`
			+ '；清理 dsh-runtime/<version>/*.deleting-* 并重跑 strip-before-pack.mjs 后再打包');
	}
}

/**
 * ④-b 安装后路径长度门禁（2026-11-23）。
 *
 * 仅 Windows 生效：Inno 的 `restartreplace` 会把旧文件改名成 `old_*` 再替换；
 * `profile-seed/.pnpm` 的最长路径本身已接近 260，安装根再长一点就会在用户机器上
 * 报 `MoveFile 失败；错误代码 3`。这里按安装根预算逐文件算出安装后路径，超过即拒绝出包。
 */
function longestInstalledPath(appDir) {
	let worst = '';
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			// 连枚举都失败通常说明路径已经超限/目录损坏；fail-closed，不要带病出包。
			problems.push(`安装路径扫描失败：${dir}（${error.message}）`);
			return;
		}
		for (const entry of entries) {
			// pnpm 的 node_modules 链接/junction 不跟：路径长度按真实文件算，避免循环。
			if (entry.isSymbolicLink()) {
				continue;
			}
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			const rel = relative(buildDir, abs);
			const installed = `${INSTALL_ROOT_BUDGET}\\${rel}`;
			if (installed.length > worst.length) {
				worst = installed;
			}
		}
	};
	walk(appDir);
	return worst;
}

if (APP_SUB === WIN_APP_SUB) {
	const longest = longestInstalledPath(appDir);
	if (longest && longest.length > MAX_INSTALLED_PATH) {
		problems.push(`安装后最长路径 ${longest.length} 字符 > ${MAX_INSTALLED_PATH}：${longest}`
			+ `\n     修法：缩短 profile-seed 目录结构，或把 profile-seed 打成压缩包再安装；`
			+ '不要把 dsh-runtime 放回带 restartreplace 的主 [Files] 行（会报 MoveFile 错误 3）');
	}
}

/**
 * ④-c 安装器接线守卫：dsh-runtime 必须保持"单独复制 + 不带 restartreplace"。
 * 否则以后合并回主 [Files] 行时，长路径 MoveFile 错误 3 会再次复发。
 */
if (APP_SUB === WIN_APP_SUB) {
	const iss = readFileSync(join(ROOT, 'build/win32/code.iss'), 'utf8');
	const sourceLines = iss.split(/\r?\n/).filter(line => /^\s*Source:\s*"/.test(line));
	// ★ 2026-11-24：dsh-runtime 拆成两行 —— *.node 单独带 restartreplace（koffi.node 被占用时兜底），
	//   批量行（含超长 profile-seed）不带。判据要精确匹配批量行，别被 *.node 行抢到。
	const nodeCopy = sourceLines.find(line => /Source:\s*"resources\\app\\dsh-runtime\\\*\.node"/.test(line));
	const runtimeCopy = sourceLines.find(line => /Source:\s*"resources\\app\\dsh-runtime\\\*"/.test(line));
	const mainCopy = sourceLines.find(line => line.includes('Source: "*"'));
	if (!runtimeCopy || runtimeCopy.includes('restartreplace')) {
		problems.push('code.iss：dsh-runtime 批量行必须单独复制且不带 restartreplace（否则长路径升级会报 MoveFile 错误 3）');
	}
	if (!runtimeCopy || !runtimeCopy.includes('Excludes: "*.node"')) {
		problems.push('code.iss：dsh-runtime 批量行必须 Excludes *.node（否则 *.node 会被两条行重复安装）');
	}
	if (!nodeCopy || !nodeCopy.includes('restartreplace')) {
		problems.push('code.iss：*.node 必须单独带 restartreplace（否则被占用时 DeleteFile 错误代码 5 会中断安装）');
	}
	if (!mainCopy || !mainCopy.includes('\\resources\\app\\dsh-runtime,\\resources\\app\\dsh-runtime\\**')) {
		problems.push('code.iss：主 [Files] 行必须排除 resources\\app\\dsh-runtime 与它的子树');
	}
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

try {
	const compat = JSON.parse(readFileSync(join(ROOT, 'dsh-plugins/dsh-compat.json'), 'utf8'));
	if (!compat.bundled) {
		problems.push('dsh-compat.json 缺 bundled，无法核对随包运行时');
	} else {
		const runtimeDir = join(appDir, 'dsh-runtime', compat.bundled);
		const problem = checkDshRuntime(runtimeDir, compat.bundled);
		if (problem) { problems.push(problem); }
		else { console.log(`  · 随包运行时启动检查通过：${compat.bundled}`); }
	}
} catch (error) {
	problems.push(`随包运行时检查失败：${error.message}`);
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
