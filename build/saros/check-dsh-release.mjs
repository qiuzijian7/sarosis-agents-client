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
		note(`产物核对完成：${repoPlugins.length} 个随包插件`);
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
