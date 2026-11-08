#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  check-dsh-release — 发布前的 **dsh 一致性**守卫（2026-10-28）。
 *
 * ## 为什么需要
 *
 * 判"某个随包插件要不要（重新）装进 profile"的口径是 **版本 + 入口文件内容**（`_planPluginInstall`
 * + `_installedEntryMatches`）。于是有两类真实事故，现有 50 多个 `dsh-plugins/check-*.mjs` 都抓不到：
 *
 *   ① **改了 `lib/**` 但没 bump 版本** —— 入口（`lib/index.js`）没动 ⇒ 指纹不变 ⇒ 打新包后
 *      按"版本相同、内容相同"处理 ⇒ **不重装** ⇒ 用户拿到的新 exe 里是新代码、profile 里是旧代码，
 *      界面表现"改了没生效"。（10-24 真机：只改 chunk 不改入口，怎么重启都还是旧界面。）
 *   ② **exe 里随包版本低于 profile** —— 每次启动都尝试"降级重装"（8 个包、跑满 4 分钟超时 +
 *      逐项回退再失败、桌面窗口卡在"正在启动后台服务…"）。10-28 真机踩过；现在运行期有"不降级"
 *      保护，但**发布前就该发现**这个包比用户 profile 旧。
 *
 * 另外两条是发布产物的完整性：
 *   ③ `dsh-compat.json` 的 `bundled` 必须在 `versions` 里（否则预装的运行时是"未验证版本"）；
 *   ④ `--dist <安装目录>` 时，产物里的 `resources/app/dsh-plugins/*` 与仓库同名包版本必须一致
 *      （防止"打包用了旧的 out/ 或漏拷某个插件"，那种问题只有装上之后才暴露）。
 *
 * ## 用法
 *
 *   node build/saros/check-dsh-release.mjs                       # 本地：只看工作区/HEAD 的改动 + compat
 *   node build/saros/check-dsh-release.mjs --base=origin/main     # CI：比对 PR base
 *   node build/saros/check-dsh-release.mjs --dist="D:/.../resources/app"   # 额外核对产物
 *   node build/saros/check-dsh-release.mjs --require-runtime      # 要求 dsh-runtime/<bundled> 已就绪
 *
 * 退出码：0 = 通过；1 = 有问题（每条形如 `✗ …`）。
 * ⚠ 零依赖（只用 node 内置）—— 它要在"没装 node_modules"的发布机上也能跑。
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 与 prepack 共用的裁剪清单（仓库内纯数据模块，不引入 node_modules 依赖 ✓）
import { PRUNE_LIST, VIRTUAL_STORE_HEAVY_RE } from './prune-list.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGINS_DIR = path.join(ROOT, 'dsh-plugins');

const argv = process.argv.slice(2);
const argOf = (name) => {
	const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
	if (!hit) {
		return undefined;
	}
	const eq = hit.indexOf('=');
	return eq >= 0 ? hit.slice(eq + 1) : '';
};
const BASE = argOf('base') ?? 'HEAD';
const DIST = argOf('dist');
const REQUIRE_RUNTIME = argv.includes('--require-runtime');

const problems = [];
const notes = [];
const problem = (msg) => problems.push(msg);
const note = (msg) => notes.push(msg);

const git = (...args) => {
	try {
		// stderr 丢掉：`core.autocrlf` 会在每次 status/diff 时刷 "LF will be replaced by CRLF"，
		// 它和本检查无关，留着只会淹没真正的输出。
		return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return undefined;   // 不在 git 仓库 / base 不存在 ⇒ 调用方自行降级
	}
};

const readJson = (p) => {
	try {
		return JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch {
		return undefined;
	}
};

/** 版本比较：只在两段都能解析成版本时给结论（本守卫不猜）。 */
const sameVersion = (a, b) => String(a ?? '') === String(b ?? '');

// ── ① compat 清单自洽 ───────────────────────────────────────────────────────
const compatPath = path.join(PLUGINS_DIR, 'dsh-compat.json');
const compat = readJson(compatPath);
const bundledRuntime = compat?.bundled;
if (!compat) {
	problem(`读不到 dsh-plugins/dsh-compat.json（发布时预装运行时要靠它）`);
} else if (!bundledRuntime) {
	problem('dsh-compat.json 没有 `bundled` 字段 ⇒ 安装包里不会带内置运行时（首启要联网下载）');
} else if (!Array.isArray(compat.versions) || !compat.versions.some(v => v?.version === bundledRuntime)) {
	problem(`dsh-compat.json: bundled=${bundledRuntime} 不在 versions 清单里（未验证版本不许预装）`);
} else {
	note(`compat.bundled = ${bundledRuntime}（在 versions 清单里 ✓）`);
}

// ── ② 运行时目录（可选硬性要求）─────────────────────────────────────────────
if (bundledRuntime) {
	const runtimeBin = path.join(ROOT, 'dsh-runtime', bundledRuntime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
	if (fs.existsSync(runtimeBin)) {
		note(`dsh-runtime/${bundledRuntime} 已就绪`);
	} else if (REQUIRE_RUNTIME) {
		problem(`dsh-runtime/${bundledRuntime} 不存在或缺少 bin.js —— 打包前先跑 node build/prepack-dsh-runtime.mjs`);
	} else {
		note(`dsh-runtime/${bundledRuntime} 尚未生成（打包前要跑 prepack-dsh-runtime）`);
	}
}

// ── ②bis 重型可选项：**只按裁剪清单检查**（清单是唯一真源）────────────────────
// ★ 2026-11-07 修正：10-28 加这条守卫时把「运行时与种子都不该有 libreoffice 内核」
//   **硬编码**在这里；11-02 Office 全量路线把 prepack 的 `PRUNE_LIST` 置空后守卫没跟上
//   ⇒ CI 全新构建装出 182MB 内核时会误报并拦出包 ✗。
//   现在共用一个纯数据模块 `prune-list.mjs`：
//     · `PRUNE_LIST` 里的项 → 运行时本体/种子 hoisted 布局里不许存在（为空 ⇒ 不检查）；
//     · `VIRTUAL_STORE_HEAVY_RE` → 种子 `.pnpm` 虚拟店里的**依赖副本**仍在裁，继续守着裁剪失败
//       （Office 引擎的绝对路径指向 dsh-runtime 本体，不指向种子副本 ⇒ 裁掉是安全的）。
const pruneTargets = PRUNE_LIST.map(rel => rel.filter(seg => seg !== 'node_modules'));

/**
 * ★ 2026-11-07 CI 事故（`VsSaros-Win-EXE-Package (9).log` L3428）：裁掉 `.pnpm/<pkg>@<ver>`
 * 之后，hoist 区 `node_modules/.pnpm/node_modules/<scope>/<name>` 里指向它的 junction 会悬空；
 * gulp 的 dshRuntime 资源流用 `stat` 跟随 ⇒ ENOENT ⇒ `vscode-win32-x64` 崩 ⇒ 0 个 exe。
 * ⚠ `fs.existsSync()` 对断链返回 false ⇒ 必须 `lstatSync().isSymbolicLink()` + `statSync()` 判定。
 */
const scanDanglingLinks = (nodeModulesDir, label) => {
	// ⚠ 递归整个 node_modules：不只 hoist 区，wrapper 包内部也会留指向被裁内核的链接
	//   （实测 `.pnpm/@deepseek-ai+libreoffice-kit@0.1.5/node_modules/.../libreoffice-kit-win32-x64`）。
	// ★ 2026-11-08：与 prepack 同判据 —— **lstat 在、stat 跟随 ENOENT** 就算断链，
	//   不再依赖 isSymbolicLink()/readlinkSync() 目标格式（CI 上这两者与本机不一致 ⇒ 上一版漏报）。
	//   第二条捕获路径：被 lstat 判成"目录"的断 junction，递归进去时 readdirSync 会 ENOENT。
	if (!fs.existsSync(nodeModulesDir)) {
		return;
	}
	const report = (p, via) => {
		problem(`${label} 的 node_modules 里有悬空链接 ${path.relative(nodeModulesDir, p)}（${via}）`
			+ ' —— gulp 拷贝时 stat 会 ENOENT 并崩掉整个打包任务；'
			+ '跑 node build/prepack-dsh-runtime.mjs 重新生成（它会清理断链）');
	};
	const scan = (dir, depth) => {
		if (depth > 8) {
			return;
		}
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			if (err?.code === 'ENOENT' && dir !== nodeModulesDir) {
				report(dir, 'readdir ENOENT');
			}
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			let st;
			try { st = fs.lstatSync(p); } catch { continue; }
			if (st.isSymbolicLink() || e.isSymbolicLink()) {
				try {
					fs.statSync(p);
				} catch (err) {
					if (err?.code === 'ENOENT') {
						report(p, 'stat ENOENT');
						continue;
					}
				}
			}
			if (st.isDirectory()) {
				scan(p, depth + 1);
			}
		}
	};
	scan(nodeModulesDir, 0);
};

const scanHeavy = (nodeModulesDir, label) => {
	if (!nodeModulesDir || !fs.existsSync(nodeModulesDir)) {
		return;
	}
	for (const rel of pruneTargets) {
		const p = path.join(nodeModulesDir, ...rel);
		if (fs.existsSync(p)) {
			problem(`${label} 里还有 ${rel.join('/')}（PRUNE_LIST 列了要裁却没裁掉）`
				+ ' —— 跑 node build/prepack-dsh-runtime.mjs 重新生成');
		}
	}
	const virtualStore = path.join(nodeModulesDir, '.pnpm');
	if (fs.existsSync(virtualStore)) {
		for (const entry of fs.readdirSync(virtualStore)) {
			if (VIRTUAL_STORE_HEAVY_RE.test(entry)) {
				problem(`${label} 的 .pnpm 里还有 ${entry}（种子里的内核副本，prepack 应裁掉）`
					+ ' —— 跑 node build/prepack-dsh-runtime.mjs 重新生成');
			}
		}
	}
};
if (bundledRuntime) {
	const rt = path.join(ROOT, 'dsh-runtime', bundledRuntime);
	const rtModules = path.join(rt, 'node_modules');
	scanHeavy(rtModules, `运行时 dsh-runtime/${bundledRuntime}`);
	scanDanglingLinks(rtModules, `运行时 dsh-runtime/${bundledRuntime}`);
	const seedProfiles = path.join(rt, 'profile-seed', 'profiles');
	if (fs.existsSync(seedProfiles)) {
		for (const p of fs.readdirSync(seedProfiles, { withFileTypes: true })) {
			if (p.isDirectory()) {
				const nm = path.join(seedProfiles, p.name, 'node_modules');
				scanHeavy(nm, `种子 profile ${p.name}`);
				scanDanglingLinks(nm, `种子 profile ${p.name}`);
			}
		}
	}
	note(pruneTargets.length === 0
		? '重型可选项检查完成：PRUNE_LIST 为空（Office 路线有意保留运行时本体内核）；种子 .pnpm 副本仍受检查'
		: `重型可选项检查完成（PRUNE_LIST ${pruneTargets.length} 项 + 种子 .pnpm 副本）`);
}

// ── ②ter pnpm 版本单一真源：构建期 / 产物内置 / 用户运行时三处必须同版本 ────────
// 2026-11-07：CI 全局 pnpm 从 10.18.0 漂到 12.18.0 ⇒ 连着两次事故（ERR_PNPM_IGNORED_BUILDS
// 让种子建不出来；.pnpm 虚拟店让种子从 234MB 涨到 573MB）。
// ⇒ 根 package.json 的 `devDependencies.pnpm` + `packageManager` 是唯一真源；
//   `prepack-dsh-runtime.mjs`（构建期 PATH shim）与 `ensure-pnpm-tool.mjs`（产物 tools/pnpm）
//   都读它。这条守卫在发布前把「仓库装的版本」与「产物里那份」对齐。
const rootPkg = readJson(path.join(ROOT, 'package.json'));
const pmPin = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager.replace(/^pnpm@/, '').trim() : '';
const depPin = String(rootPkg?.devDependencies?.pnpm ?? '');
if (!/^\d+\.\d+\.\d+$/.test(depPin) || pmPin !== depPin) {
	problem(`pnpm 版本真源不一致/不精确：packageManager=${rootPkg?.packageManager ?? '(无)'}、`
		+ `devDependencies.pnpm=${rootPkg?.devDependencies?.pnpm ?? '(无)'} —— 必须两处都是同一个精确版本（不许 ^/~/latest）`);
} else {
	note(`pnpm 单一真源 = ${depPin}（packageManager + devDependencies 一致 ✓）`);
	const localPnpm = readJson(path.join(ROOT, 'node_modules', 'pnpm', 'package.json'));
	if (!localPnpm) {
		problem(`node_modules/pnpm 不存在 ⇒ 构建期 prepack 与产物内置都取不到 pin 的版本；先跑 npm install`);
	} else if (!sameVersion(localPnpm.version, depPin)) {
		problem(`node_modules/pnpm 是 ${localPnpm.version}，期望 ${depPin} —— 不许用未 pin 的版本建种子/拷进产物`);
	} else {
		note(`node_modules/pnpm = ${depPin}（构建期 shim 的源 ✓）`);
	}
	if (DIST) {
		const prodDir = path.join(DIST, 'tools', 'pnpm');
		const prodPnpm = readJson(path.join(prodDir, 'package.json'));
		if (!prodPnpm) {
			problem(`产物里没有 tools/pnpm/package.json ⇒ 用户机器上没有自带 pnpm（运行时装插件会失败）`);
		} else if (!sameVersion(prodPnpm.version, depPin)) {
			problem(`产物内置 pnpm 是 ${prodPnpm.version}，期望 pin ${depPin} —— 跑 node build/saros/ensure-pnpm-tool.mjs 重新落位`);
		} else {
			note(`产物内置 pnpm = ${depPin}（与构建期同版本 ✓）`);
		}
		// pnpm 11 是**目录分发**：只拷 bin 会 ERR_MODULE_NOT_FOUND（bin/pnpm.mjs 动态 import dist/pnpm.mjs）
		for (const rel of ['bin/pnpm.mjs', 'dist/pnpm.mjs']) {
			const f = path.join(prodDir, rel);
			if (!fs.existsSync(f) || (rel.endsWith('dist/pnpm.mjs') && fs.statSync(f).size < 1024 * 1024)) {
				problem(`产物内置 pnpm 缺 ${rel}（或文件半截）—— pnpm 11 需要整个包，不是单文件 bundle`);
			}
		}
	}
}

// ── ②bis 空源文件（0 字节 .ts）────────────────────────────────────────────────
// 2026-10-28 事故：一个 0 字节的 .ts（模块搬家后留下的空壳）编译出的 sourcemap 里
// `sourcesContent: ['']` ⇒ mangling 跑满 44 分钟后整步失败（build/lib/nls.ts 现在会放过空源文件，
// 但那是**兜底**，不是许可：空 .ts 本身就是"忘了删"或"忘了搬"的残留）。
// ⇒ 发布前扫一遍：src / extensions 下不许再有 0 字节 .ts。
const EMPTY_TS_ALLOW = [
	'extensions/typescript-language-features/test-workspace/'   // TS 扩展的**故意**空 fixture
];
function scanEmptySources(dir, label) {
	const abs = path.join(ROOT, dir);
	if (!fs.existsSync(abs)) {
		return;
	}
	const stack = [abs];
	while (stack.length) {
		const cur = stack.pop();
		let entries = [];
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (e.name === 'node_modules' || e.name === '.git' || e.name === 'out' || e.name === 'out-build') {
					continue;
				}
				stack.push(path.join(cur, e.name));
			} else if (e.isFile() && e.name.endsWith('.ts')) {
				const full = path.join(cur, e.name);
				const rel = path.relative(ROOT, full).replace(/\\/g, '/');
				if (EMPTY_TS_ALLOW.some(a => rel.startsWith(a))) {
					continue;
				}
				try {
					if (fs.statSync(full).size === 0) {
						problem(`${label}：${rel} 是 0 字节的 .ts（空源文件 ⇒ sourcemap 里 sourcesContent 是空串，`
							+ 'mangling 会在 40 多分钟后才炸）—— 删掉它，或把它搬回新位置');
					}
				} catch { /* 读不到就跳过 */ }
			}
		}
	}
}
scanEmptySources('src', 'src');
scanEmptySources('extensions', 'extensions');
note('空源文件检查完成（src / extensions）');

// ── ③ 改了 lib/** 却没 bump 版本（本次守卫的核心）────────────────────────────
/** 仓库里所有随包插件：`{ name, dir, version }`。 */
const repoPlugins = [];
for (const e of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
	if (!e.isDirectory()) {
		continue;
	}
	const pkg = readJson(path.join(PLUGINS_DIR, e.name, 'package.json'));
	if (pkg?.name) {
		repoPlugins.push({ name: pkg.name, dirName: e.name, version: pkg.version });
	}
}

/** 本次改动过的文件（工作区 + 相对 base 的已提交改动）。 */
const changedFiles = new Set();
const statusOut = git('status', '--porcelain', '-z', '--', 'dsh-plugins');
if (statusOut) {
	for (const rec of statusOut.split('\0')) {
		if (!rec) {
			continue;
		}
		// 形如 ` M dsh-plugins/x/lib/a.js` / `?? dsh-plugins/x/lib/b.js` / `R  old\0new`
		const file = rec.slice(3).trim();
		if (file) {
			changedFiles.add(file.replace(/\\/g, '/'));
		}
	}
}
const diffOut = git('diff', '--name-only', BASE, '--', 'dsh-plugins');
if (diffOut) {
	for (const line of diffOut.split('\n')) {
		const file = line.trim().replace(/\\/g, '/');
		if (file) {
			changedFiles.add(file);
		}
	}
}

if (!git('rev-parse', '--verify', BASE)) {
	notes.push(`跳过"已提交改动"比对：git ref \`${BASE}\` 不存在`);
}

/** 这个包在 base 里的版本（读不到 ⇒ undefined，当作"新包/无法比对"）。 */
const baseVersionOf = (dirName) => {
	const raw = git('show', `${BASE}:dsh-plugins/${dirName}/package.json`);
	if (!raw) {
		return undefined;
	}
	try {
		return JSON.parse(raw).version;
	} catch {
		return undefined;
	}
};

/**
 * dirName → { libFiles: string[], headTouched: boolean }
 *
 * ⚠ 必须把**入口**单独标出来：判"要不要重装"的指纹来自入口文件内容
 *   （`_installedEntryMatches` 读 `package.json` 的 `main`）。入口也改了 ⇒ 指纹变 ⇒ 会重装；
 *   只有**入口没动、改的是别的 lib 文件**才是"打新包也不重装"的真事故。
 *   （实测踩过：把 `vssaros-kb` 的 `lib/index.js` + chunk 一起改，若不算入口就会误报 ✗。）
 */
const touched = new Map();
for (const file of changedFiles) {
	const m = /^dsh-plugins\/([^/]+)\/(.+)$/.exec(file);
	if (!m) {
		continue;
	}
	const [, dirName, rest] = m;
	const entry = touched.get(dirName) ?? { libFiles: [], headTouched: false };
	if (rest.startsWith('lib/')) {
		entry.libFiles.push(rest);
	}
	if (rest === 'package.json') {
		entry.headTouched = true;
	}
	touched.set(dirName, entry);
}

for (const [dirName, t] of touched) {
	if (!t.libFiles.length) {
		continue;
	}
	const pkg = readJson(path.join(PLUGINS_DIR, dirName, 'package.json'));
	if (!pkg) {
		continue;   // 包被删了：由 `check-plugin-files` 那边报
	}
	const before = baseVersionOf(dirName);
	if (before === undefined) {
		note(`${pkg.name}: 新包（base 里没有），跳过版本比对`);
		continue;
	}
	const entryRel = (typeof pkg.main === 'string' && pkg.main ? pkg.main : 'lib/index.js').replace(/^\.\//, '').replace(/\\/g, '/');
	const entryChanged = t.libFiles.some(f => f === entryRel);
	if (!sameVersion(before, pkg.version)) {
		note(`${pkg.name}: lib 有改动且版本已 bump（${before} → ${pkg.version}）✓`);
		continue;
	}
	if (entryChanged) {
		// 入口变了 ⇒ 内容指纹变 ⇒ 会重装，不算致命；但版本没变时锁文件/暂存目录不会换，
		// 属于"能生效但脆弱"，发布前仍建议 bump。
		note(`${pkg.name}: 入口 ${entryRel} 有改动但版本没变（${pkg.version}）—— 靠内容指纹仍会重装，建议 bump 更稳`);
		continue;
	}
	problem(`${pkg.name}: 只改了 ${t.libFiles.length} 个非入口文件、没动入口（${entryRel}）也没 bump 版本（${pkg.version}）——`
		+ ' 指纹不变 ⇒ 打新包后不会重装 ⇒ 用户"改了没生效"。跑 `node scripts/dsh-plugin-deploy.mjs --bump` 后再发');
}

// ── ④ 产物核对（--dist）─────────────────────────────────────────────────────
if (DIST) {
	const distPlugins = path.join(DIST, 'dsh-plugins');
	if (!fs.existsSync(distPlugins)) {
		problem(`产物里没有 dsh-plugins 目录：${distPlugins}（路径给错了？或者打包时被 strip 掉了）`);
	} else {
		const distDirs = fs.readdirSync(distPlugins, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
		for (const p of repoPlugins) {
			const distPkg = readJson(path.join(distPlugins, p.dirName, 'package.json'));
			if (!distPkg) {
				problem(`产物里缺少插件 ${p.name}（${p.dirName}/package.json 读不到 ⇒ 打包 glob 漏了？）`);
				continue;
			}
			if (!sameVersion(distPkg.version, p.version)) {
				problem(`产物里 ${p.name} 是 ${distPkg.version}，仓库是 ${p.version} —— 产物过期（重新编译/打包）`);
			}
		}
		const extra = distDirs.filter(d => !repoPlugins.some(p => p.dirName === d));
		if (extra.length) {
			note(`产物里有仓库中已不存在的插件目录：${extra.join(', ')}（打包目录没清理干净？）`);
		}
		const runtimeDir = path.join(DIST, 'dsh-runtime');
		if (bundledRuntime && !fs.existsSync(path.join(runtimeDir, bundledRuntime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
			problem(`产物里缺少 dsh-runtime/${bundledRuntime}（首启会退化成联网安装）`);
		}
		if (bundledRuntime) {
			// 产物层面再扫一遍重型可选项 + 悬空链接（运行时 + 随包种子）
			const distModules = path.join(runtimeDir, bundledRuntime, 'node_modules');
			scanHeavy(distModules, '产物运行时');
			scanDanglingLinks(distModules, '产物运行时');
			const distSeed = path.join(runtimeDir, bundledRuntime, 'profile-seed', 'profiles');
			if (fs.existsSync(distSeed)) {
				for (const p of fs.readdirSync(distSeed, { withFileTypes: true })) {
					if (p.isDirectory()) {
						const nm = path.join(distSeed, p.name, 'node_modules');
						scanHeavy(nm, `产物种子 profile ${p.name}`);
						scanDanglingLinks(nm, `产物种子 profile ${p.name}`);
					}
				}
			}
		}
		// ★ 2026-10-29（真机：打包 exe 启动即报 `ERR_MODULE_NOT_FOUND: @vscode/deviceid`）：
		//   `out/main.js` 里 `require('@vscode/deviceid')` 取 machineId —— 非静态 import，
		//   gulp 的 node_modules 流不会落位它（实测产物 `@vscode/` 下只有 13 个包）。
		//   它与 dsh 无关，但**同属"发布产物必须自带的关键构件"** ⇒ 一起守，顺手兜住这类漏包。
		const deviceId = path.join(DIST, 'node_modules', '@vscode', 'deviceid', 'dist', 'index.js');
		if (!fs.existsSync(deviceId)) {
			problem('产物里缺少 `@vscode/deviceid`（`out/main.js` 会 require 它 ⇒ 每次启动一条 ERR_MODULE_NOT_FOUND；'
				+ '`strip-before-pack` 的 2.6c 段负责补回）');
		}
		note(`产物核对完成：${repoPlugins.length} 个随包插件`);
	}
}

// ── ⑤ 发布脚本自身的关键构件补回（2026-10-29）────────────────────────────────
//   `strip-before-pack` 里有一组「必须存在/自愈」的构件（tree-sitter-wasm / deviceid / rg.exe…）。
//   它们都是**运行时按路径解析、静态依赖图看不见**的东西 ⇒ 一旦那段被删，产物就会静默缺包。
//   这里只钉最关键的两条（本次真机踩到的 deviceid + 之前踩过的 tree-sitter-wasm）。
{
	const strip = path.join(ROOT, 'build', 'saros', 'strip-before-pack.mjs');
	if (!fs.existsSync(strip)) {
		problem('找不到 build/saros/strip-before-pack.mjs（发布脚本守卫失去依据）');
	} else {
		const src = fs.readFileSync(strip, 'utf8');
		// ⚠ 必须匹配**实际的 ensureDir 调用**，不能只查包名出现：
		//   文件里大段注释也写着包名（`@vscode/deviceid`），只查字符串会被"注释还在、调用被删"骗过（实测假绿 ✗）。
		for (const name of ['@vscode/deviceid', '@vscode/tree-sitter-wasm']) {
			const call = new RegExp(`ensureDir\\(\\s*'${name.replace(/[/@]/g, m => `\\${m}`)}',\\s*'resources/app/node_modules/${name.replace(/[/@]/g, m => `\\${m}`)}'`);
			if (!call.test(src)) {
				problem(`strip-before-pack 里缺少 \`${name}\` 的 ensureDir 补回调用`
					+ '（运行时按路径解析的构件，漏了产物就静默缺包；注释里提到不算）');
			}
		}
	}
}

// ── 输出 ────────────────────────────────────────────────────────────────────
for (const n of notes) {
	console.log(`  · ${n}`);
}
if (problems.length) {
	console.error(`\n✗ dsh 发布一致性检查发现 ${problems.length} 处问题：`);
	for (const p of problems) {
		console.error(`  - ${p}`);
	}
	process.exit(1);
}
console.log('\n✓ dsh 发布一致性检查通过');
