#!/usr/bin/env node
/**
 * strip-before-pack.mjs — VsSaros 安装包预打包清理脚本
 *
 * 在 gulp vscode-win32-x64-ci 之后、Inno Setup 打包之前运行。
 * 从构建输出目录中删除不需要的文件，显著减小安装包体积。
 *
 * 用法:
 *   node build/saros/strip-before-pack.mjs [构建输出目录]
 *
 * 默认目录: ../VSCode-win32-x64 (相对于项目根目录)
 *
 * ★ 平台适配（2026-10-31）：macOS 产物是 `<…>/VsSaros.app/Contents/Resources/app`，
 *   本脚本把入参目录里第一个含 `Contents/Resources/app` 的 `*.app` 当作产物根
 *   （⇒ 传 `../VSCode-darwin-arm64` 或 `../VSCode-darwin-arm64/VsSaros.app` 都行），
 *   并把所有 Windows 口吻的 `resources/app/…` 路径自动翻译过去。Windows 行为不变。
 *
 * 清理项清单 (按安全级别分组):
 *
 * 【无损 - 生产环境不需要】
 *   - *.map sourcemap 文件 (~185MB)
 *   - 非 zh-CN/en-US 的 locale pak 文件 (53种语言, ~43MB)
 *   - LICENSES.chromium.html (~15MB)
 *   - node-pty 跨平台 prebuilds (仅保留 win32-x64, ~12MB)
 *
 * 【VsSaros 品牌下不工作 - 可安全排除】
 *   - @github/copilot (整个目录, 49MB) — VsSaros 使用自带的 AG-UI provider 扩展
 *     （如 codebuddy-provider、lightai-provider），不需要 GitHub Copilot
 *   - @microsoft/1ds-* 遥测 SDK — 连接 Microsoft 端点, VsSaros 不应连 MS
 *   - @microsoft/applicationinsights-* — 同上
 *   - @microsoft/dynamicproto-js — 同上
 *   - @microsoft/dev-tunnels-* — 需 Microsoft 账户
 *
 * 【低风险 - 特定功能降级】
 *   - dxcompiler.dll + dxil.dll (26.5MB) — WebGL/D3D shader 编译场景降级
 *   - vk_swiftshader.dll (5.4MB) — 无 GPU 时 Vulkan 软件回退不可用
 *   - playwright-core (9.3MB) — 浏览器自动化调试不可用
 *   - chrome-remote-interface (2.2MB) — Chrome DevTools Protocol 不可用
 *   - katex (4.4MB) — Markdown 数学公式不渲染
 *   - opentype.js (2.0MB) — 自定义字体解析降级
 *   - @vscode/vscode-languagedetection (1.8MB) — 未识别文件的语言检测降级
 *   - @xterm/addon-webgl (1.8MB) — 终端回退到 canvas 渲染器
 *   - @parcel (1.7MB) — Parcel bundler 未见直接使用
 *   - ssh2 (641KB) — Remote SSH 需 Microsoft 账户
 *   - @vscode/sandbox-runtime (1.5MB) — 沙箱运行时
 */

import { rmSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync, cpSync } from 'node:fs';
import path from 'node:path';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = .../saros-agents-client/build/saros
// ROOT = .../saros-agents-client
const ROOT = resolve(__dirname, '../..');
// 构建输出在项目同级的 VSCode-win32-x64（macOS: VSCode-darwin-<arch>，其内是 <Name>.app）
const DEFAULT_BUILD_DIR = join(ROOT, '../VSCode-win32-x64');

// ── 平台布局（2026-10-31：macOS 打包支持）──────────────────────────────────────
// Windows/Linux：产物根 == 构建输出目录，app 内容在 `<root>/resources/app`；
// macOS：app 内容在 `<…>/VsSaros.app/Contents/Resources/app`。
// 本脚本里**所有** staging 相对路径都按 Windows 口吻写成 `resources/app/…`，
// 这里统一翻译成当前平台的真实路径 ⇒ 命令行既可传 `VSCode-darwin-arm64`
// （自动下钻到里面的 `*.app`），也可直接传 `…/VsSaros.app`；Windows 行为完全不变 ✓。
const WIN_APP_SUB = 'resources/app';
const MAC_APP_SUB = 'Contents/Resources/app';

/** 探测产物根：返回 { dir, sub, isDarwin }。dir 可能被下钻到 `*.app`。 */
function detectBuildDir(dir) {
	if (existsSync(join(dir, MAC_APP_SUB))) {
		return { dir, sub: MAC_APP_SUB, isDarwin: true };
	}
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (!e.isDirectory() || !e.name.endsWith('.app')) { continue; }
			const candidate = join(dir, e.name);
			if (existsSync(join(candidate, MAC_APP_SUB))) {
				return { dir: candidate, sub: MAC_APP_SUB, isDarwin: true };
			}
		}
	} catch { /* 目录不可读 ⇒ 按非 darwin 处理 */ }
	return { dir, sub: WIN_APP_SUB, isDarwin: false };
}

let buildDir = resolve(process.argv[2] || DEFAULT_BUILD_DIR);

if (!existsSync(buildDir)) {
	console.error(`❌ 构建输出目录不存在: ${buildDir}`);
	process.exit(1);
}

const layout = detectBuildDir(buildDir);
const IS_DARWIN = layout.isDarwin;
const APP_SUB = layout.sub;
buildDir = layout.dir;

/** macOS 架构：优先从产物目录名（VSCode-darwin-arm64）推断，其次 process.arch。 */
const MAC_ARCH = (() => {
	const m = /VSCode-darwin-(x64|arm64|universal)/.exec(buildDir);
	return m ? m[1] : (process.arch === 'arm64' ? 'arm64' : 'x64');
})();

/** 把「Windows 口吻」的 staging 相对路径翻译成当前平台的真实相对路径。 */
function toStagingRel(rel) {
	if (!IS_DARWIN) { return rel; }
	if (rel === WIN_APP_SUB) { return MAC_APP_SUB; }
	if (rel.startsWith(WIN_APP_SUB + '/')) { return MAC_APP_SUB + rel.slice(WIN_APP_SUB.length); }
	// `resources/saros/…`（asar 外的可选二进制）⇒ mac 上 resourcesPath 指向 Contents/Resources
	if (rel.startsWith('resources/')) { return 'Contents/Resources/' + rel.slice('resources/'.length); }
	return rel;
}

console.log(`🧹 清理构建输出: ${buildDir}${IS_DARWIN ? `（macOS .app ⇒ app 根 = ${APP_SUB}，arch = ${MAC_ARCH}）` : ''}\n`);

let totalFreed = 0;

function toPosix(p) {
	return p.replace(/\\/g, '/');
}

// ★★ 2026-10-29（CI 实测：`E:\data\landun\…` 的打包日志里刷了几十条
//   `##[error] The system cannot find the path specified.`）：
//   这个脚本原来用 **bash 的 `du -sb` 与 `find … 2>/dev/null`** 来算体积、找 *.map、清空目录 ——
//   但**打包跑在 Windows CI 上**（cmd/PowerShell），`du`/`find`/`2>/dev/null` **一个都不存在**
//   ⇒ 那三步从来就没成功过（只是被 catch 吞掉了，所以没人发现）⇒ 清理没做、体积统计也不准 ✗✗。
//   ⇒ 全部改成 **Node 自身实现**（跨平台、无外部依赖）✓。

/** 递归累加目录字节数（替代 `du -sb`）。 */
function dirSizeBytes(dir) {
	let total = 0;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		try {
			if (e.isDirectory()) {
				total += dirSizeBytes(p);
			} else if (e.isFile()) {
				total += statSync(p).size;
			}
		} catch { /* 单个条目读不到就跳过 */ }
	}
	return total;
}

/** 按文件名通配（只支持 `*` 与 `?`）递归找文件（替代 `find -name … -type f`）。 */
function findFilesByName(root, pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	const re = new RegExp('^' + escaped + '$');
	const out = [];
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
			} else if (e.isFile() && re.test(e.name)) {
				out.push(p);
			}
		}
	};
	walk(root);
	return out;
}

/** 后序删除空目录（替代 `find -type d -empty -delete`），返回删掉的个数。 */
function removeEmptyDirs(root) {
	let removed = 0;
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		let remaining = 0;
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (!walk(p)) {
					remaining++;
				}
			} else {
				remaining++;
			}
		}
		if (remaining === 0 && dir !== root) {
			try {
				rmSync(dir, { recursive: true, force: true });
				removed++;
				return true;
			} catch {
				return false;
			}
		}
		return false;
	};
	walk(root);
	return removed;
}

function removeDir(label, relPath) {
	const absPath = join(buildDir, toStagingRel(relPath));
	if (!existsSync(absPath)) {
		console.log(`  ⏭  ${label} — 不存在，跳过`);
		return;
	}
	let size = 0;
	try {
		size = dirSizeBytes(absPath);
	} catch { /* ignore */ }
	try {
		rmSync(absPath, { recursive: true, force: true });
		totalFreed += size;
		const sizeStr = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${(size / 1024).toFixed(0)}KB`;
		console.log(`  ✅ ${label} — ${sizeStr}`);
	} catch (e) {
		console.log(`  ⚠️  ${label} — 删除失败: ${e.message}`);
	}
}

function removeFile(label, relPath) {
	const absPath = join(buildDir, toStagingRel(relPath));
	if (!existsSync(absPath)) {
		console.log(`  ⏭  ${label} — 不存在，跳过`);
		return;
	}
	const size = statSync(absPath).size;
	try {
		rmSync(absPath, { force: true });
		totalFreed += size;
		const sizeStr = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${(size / 1024).toFixed(0)}KB`;
		console.log(`  ✅ ${label} — ${sizeStr}`);
	} catch (e) {
		console.log(`  ⚠️  ${label} — 删除失败: ${e.message}`);
	}
}

function removeGlob(label, pattern) {
	try {
		const files = findFilesByName(buildDir, pattern);
		if (files.length === 0) {
			console.log(`  ⏭  ${label} — 无匹配，跳过`);
			return;
		}
		let size = 0;
		for (const f of files) {
			try { size += statSync(f).size; } catch { /* skip */ }
			try { rmSync(f, { force: true }); } catch { /* skip */ }
		}
		totalFreed += size;
		const sizeStr = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${(size / 1024).toFixed(0)}KB`;
		console.log(`  ✅ ${label} — ${files.length} 文件, ${sizeStr}`);
	} catch (e) {
		console.log(`  ⚠️  ${label} — 失败: ${e.message}`);
	}
}

// === 1. 无损清理 ===
console.log('📦 [无损] 生产环境不需要的文件:');

removeGlob('.map sourcemaps', '*.map');
removeFile('LICENSES.chromium.html', 'LICENSES.chromium.html');

// 精简 locales — 仅保留 en-US.pak 和 zh-CN.pak
const localesDir = join(buildDir, 'locales');
if (existsSync(localesDir)) {
	const kept = new Set(['en-US.pak', 'zh-CN.pak']);
	const paks = readdirSync(localesDir).filter(f => f.endsWith('.pak') && !kept.has(f));
	let size = 0;
	for (const f of paks) {
		const fp = join(localesDir, f);
		try { size += statSync(fp).size; } catch { /* skip */ }
		try { rmSync(fp, { force: true }); } catch { /* skip */ }
	}
	totalFreed += size;
	console.log(`  ✅ 精简 locales (${paks.length} 文件) — ${(size / 1024 / 1024).toFixed(1)}MB`);
}

// node-pty: 仅保留当前平台的 prebuilds（win: win32-x64 / mac: darwin-<arch>）
const ptyPrebuilds = join(buildDir, toStagingRel('resources/app/node_modules/node-pty/prebuilds'));
if (existsSync(ptyPrebuilds)) {
	const keptPrefix = IS_DARWIN ? `darwin-${MAC_ARCH}` : 'win32-x64';
	const entries = readdirSync(ptyPrebuilds).filter(e => !e.startsWith(keptPrefix));
	for (const e of entries) {
		removeDir(`node-pty prebuilds/${e}`, `resources/app/node_modules/node-pty/prebuilds/${e}`);
	}
}

// === 2. VsSaros 品牌下不工作 ===
console.log('\n🏷️  [品牌] VsSaros 不需要的模块:');

removeDir('@github/copilot (整个目录)', 'resources/app/node_modules/@github/copilot');
removeDir('@github/copilot-sdk', 'resources/app/node_modules/@github/copilot-sdk');
removeDir('@microsoft/1ds-post-js', 'resources/app/node_modules/@microsoft/1ds-post-js');
removeDir('@microsoft/1ds-core-js', 'resources/app/node_modules/@microsoft/1ds-core-js');
removeDir('@microsoft/applicationinsights-core-js', 'resources/app/node_modules/@microsoft/applicationinsights-core-js');
removeDir('@microsoft/applicationinsights-shims', 'resources/app/node_modules/@microsoft/applicationinsights-shims');
removeDir('@microsoft/dynamicproto-js', 'resources/app/node_modules/@microsoft/dynamicproto-js');
removeDir('@microsoft/dev-tunnels-ssh', 'resources/app/node_modules/@microsoft/dev-tunnels-ssh');
removeDir('@microsoft/dev-tunnels-connections', 'resources/app/node_modules/@microsoft/dev-tunnels-connections');
removeDir('@microsoft/dev-tunnels-contracts', 'resources/app/node_modules/@microsoft/dev-tunnels-contracts');
removeDir('@microsoft/dev-tunnels-management', 'resources/app/node_modules/@microsoft/dev-tunnels-management');
removeDir('@microsoft/dev-tunnels-ssh-tcp', 'resources/app/node_modules/@microsoft/dev-tunnels-ssh-tcp');

// === 3. 低风险 - 特定功能降级 ===
console.log('\n⚡ [低风险] 功能降级项:');

removeFile('dxcompiler.dll', 'dxcompiler.dll');
removeFile('dxil.dll', 'dxil.dll');
removeFile('vk_swiftshader.dll', 'vk_swiftshader.dll');
removeDir('playwright-core', 'resources/app/node_modules/playwright-core');
removeDir('chrome-remote-interface', 'resources/app/node_modules/chrome-remote-interface');
removeDir('katex', 'resources/app/node_modules/katex');
removeDir('opentype.js', 'resources/app/node_modules/opentype.js');
removeDir('@vscode/vscode-languagedetection', 'resources/app/node_modules/@vscode/vscode-languagedetection');
removeDir('@xterm/addon-webgl', 'resources/app/node_modules/@xterm/addon-webgl');
removeDir('@parcel', 'resources/app/node_modules/@parcel');
removeDir('ssh2', 'resources/app/node_modules/ssh2');
removeDir('@vscode/sandbox-runtime', 'resources/app/node_modules/@vscode/sandbox-runtime');

// === 4. 清理空目录 ===
console.log('\n🧹 清理空目录...');
try {
	const removed = removeEmptyDirs(join(buildDir, toStagingRel('resources/app/node_modules')));
	console.log(`  ✅ 已清理空目录（${removed} 个）`);
} catch { /* ignore */ }

// === 5. 关键构件校验与自愈（2026-08-05，生产事故 1785894964584） ===
// rg.exe 缺失 → 内容搜索降级慢速 walk；agentmemory dist 缺失 → 能力插件 404；
// kbWorker.js 缺失 → KB worker 404 回退主线程。缺任何一样都不得出包。
// 2026-09-15 追加：@vscode/tree-sitter-wasm 缺失 → codebase 图谱解析回退 renderer
// 主线程（大仓库索引期间 UI 冻结），且运行时只有一条 WARN —— 见下面 2.6。
console.log('\n🩺 [关键构件] 校验与自愈:');
const repoRoot = path.resolve(__dirname, '../..');
let criticalMissing = 0;

function ensureFile(label, stagingRel, repoRelCandidates) {
	const stagingAbs = path.join(buildDir, toStagingRel(stagingRel));
	if (existsSync(stagingAbs)) { console.log(`  ✅ ${label}`); return; }
	for (const repoRel of repoRelCandidates) {
		const repoAbs = path.join(repoRoot, repoRel);
		if (existsSync(repoAbs)) {
			mkdirSync(path.dirname(stagingAbs), { recursive: true });
			cpSync(repoAbs, stagingAbs, { recursive: true });
			console.log(`  ♻️  ${label} —— 已从 ${repoRel} 恢复`);
			return;
		}
	}
	console.log(`  ❌ ${label} 缺失且无法自愈（${stagingRel}）`);
	criticalMissing++;
}

// 与 ensureFile 类似，但自愈“整个目录”（如扩展编译产物 out/、node_modules 依赖）。
// sentinel 用于判定目标目录是否已健全（默认 extension.js；node_modules 包用 package.json）。
function ensureDir(label, stagingRel, repoRel, sentinel = 'extension.js', opts = {}) {
	const stagingAbs = path.join(buildDir, toStagingRel(stagingRel));
	const sentinelAbs = path.join(stagingAbs, sentinel);
	// ★★ 2026-10-30（真机 P0：全新机器装上后**主页白屏**，日志
	//   `vssaros-kb: failed to import … vendor/markdown-it.cjs ENOENT`、
	//   `vssaros-agents: failed to read overlay … cordis.presets.yml ENOENT`）：
	//   原来是"哨兵在就整个跳过"⇒ 暂存目录里**某次旧构建**留下的 `dsh-plugins/` 永远不会刷新
	//   ⇒ 之后新增的插件文件（vendor/、cordis.presets.yml、lib/app/…）**永远进不了包** ✗✗。
	//   本机从不复现：本机 profile 早就装过这些文件，不经过"随包 + 直装"这条路。
	//   ⇒ `refresh: true` 的调用点**每次都从仓库重新整目录覆盖**（旧内容先删，防残留删不掉的文件）。
	if (opts.refresh) {
		const repoAbsForced = path.join(repoRoot, repoRel);
		if (!existsSync(repoAbsForced)) {
			console.log(`  ❌ ${label} 缺失且无法自愈（${repoRel}）`);
			criticalMissing++;
			return;
		}
		rmSync(stagingAbs, { recursive: true, force: true });
		mkdirSync(stagingAbs, { recursive: true });
		cpSync(repoAbsForced, stagingAbs, { recursive: true });
		console.log(`  ♻️  ${label} —— 已按仓库当前内容**刷新**（refresh=true，防旧副本残留）`);
		return;
	}
	if (existsSync(sentinelAbs)) { console.log(`  ✅ ${label}`); return; }
	const repoAbs = path.join(repoRoot, repoRel);
	if (existsSync(repoAbs)) {
		mkdirSync(stagingAbs, { recursive: true });
		cpSync(repoAbs, stagingAbs, { recursive: true });
		console.log(`  ♻️  ${label} —— 已从 ${repoRel} 恢复`);
		return;
	}
	console.log(`  ❌ ${label} 缺失且无法自愈（${stagingRel}）`);
	criticalMissing++;
}

// 1) agentmemory 能力插件 dist（AgentCapability 回退路径硬编码加载）
ensureFile(
	'agentmemory-memory/dist/extension.js',
	'resources/app/extensions/agentmemory-memory/dist/extension.js',
	['extensions/agentmemory-memory/dist/extension.js'],
);

// 2) 自定义扩展编译产物 out/ 缺失自愈（2026-08-29 生产事故：agent-studio 缺失 out/extension.js
//    → 扩展宿主激活失败 → 工作区崩溃 “An unknown error occurred”）。
//    这些扩展的 src/ 随 git 进入构建目录，但 out/ 被 .gitignore 排除，且 gulp 扩展编译管线
//    不认识它们，导致 out/ 不进包。sentinel 用 extension.js 判定目录是否健全。
ensureDir(
	'agent-studio/out',
	'resources/app/extensions/agent-studio/out',
	'extensions/agent-studio/out',
);

// 2.5) typescript 运行时依赖（html/css/json 语言服务器 import 'typescript'）。
//    缺失 → 这些内置语言服务器激活失败。自愈整包（sentinel=package.json）。
ensureDir(
	'node_modules/typescript',
	'resources/app/node_modules/typescript',
	'node_modules/typescript',
	'package.json',
);

// 2.5b) **dsh-plugins/**（随包分发的 dsh 插件：bridge / chat-surface + 11 个模块插件，以及
//    `dsh-compat.json`）。2026-10-12 补：`<appPath>/dsh-plugins` 是宿主解析插件与兼容清单的**唯一**
//    位置（`dshHarnessChannel.ts` 用 `join(app.getAppPath(), 'dsh-plugins')`，兼容清单读同层
//    `dsh-plugins/dsh-compat.json`），但**标准打包链完全不知道这个目录** —— `build/` 下 0 处 `dsh`
//    引用、根 `gulpfile.mjs` 只 `import './build/gulpfile.ts'`、`deploy-package/scripts/build-installer.ps1`
//    跑的也是标准 `gulp vscode-win32-x64-*-setup` ⇒ 不进包 ✗。
//    现象（生产版）：模块插件全缺、插件中心「随包」段为空、`dsh-compat.json` 读不到；而
//    `dshHostSupervisor` 的注释把"老构建没带 `dsh-plugins/`"当作**合法**状态 ⇒ 整件事是静默的 ✗✗。
//    sentinel 用 `vssaros-bridge/package.json`：它证明**目录真的被灌满**（不是只有一个空壳目录 ✗），
//    与上面 tree-sitter 那两条同一思路。缺它会让构建在收尾统计里报错（criticalMissing ✓）。
ensureDir(
	'dsh-plugins',
	'resources/app/dsh-plugins',
	'dsh-plugins',
	'vssaros-bridge/package.json',
	// ⚠ 必须 refresh：这个目录里放的是**我们的插件源码**（每次发版都在改），
	//   用"哨兵在就跳过"会让暂存目录停在**某次旧构建**（真机 P0：`kb/vendor/markdown-it.cjs`、
	//   `agents/cordis.presets.yml` 永远进不了包 ⇒ 全新机器主页白屏）。
	{ refresh: true },
);

// 2.5b-2) ★★ 2026-10-30 完整性门禁：**逐文件**比对「暂存 vs 仓库」的 `dsh-plugins/`。
//
// 为什么光有 refresh 还不够：refresh 只保证"这次拷了"，但只要有人把这条调用改回默认、
// 或拷贝中途失败，缺文件依然会静默进包（真机就是"包缺 vendor/markdown-it.cjs ⇒ 用户主页白屏"，
// 而整个构建过程**一句报错都没有** ✗✗）。
// ⇒ 这里直接算两边相对路径集合的差集：仓库有、暂存没有 ⇒ criticalMissing（构建收尾会红）。
// ⚠ 排除 `node_modules`（源里可能有，但不该进包）与 `test/`（构建有意排除，运行时不需要）。
/**
 * 随包 `dsh-plugins` 的完整性门禁。
 *
 * ⚠ **必须在"生成产物"之后调用**（2026-10-31）：它比的是「仓库 vs 暂存」，
 *   而 `dist/` / `vendor/` 这类产物是**生成**出来的（且被 gitignore ⇒ 干净检出没有）。
 *   在生成之前跑 ⇒ 两边都没有 ⇒ 判"一致" ⇒ 静默漏掉（真机 10-31 就是这样：CI 上 840、
 *   本机 874，差的 34 个全是产物）。
 */
function verifyDshPluginsComplete() {
	const repoPlugins = path.join(repoRoot, 'dsh-plugins');
	const stagingPlugins = path.join(buildDir, toStagingRel('resources/app/dsh-plugins'));
	const walk = (root, dir = '', out = []) => {
		let entries;
		try { entries = readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
		for (const e of entries) {
			const rel = dir ? `${dir}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (e.name === 'node_modules' || rel === 'test' || rel.endsWith('/test')) { continue; }
				walk(root, rel, out);
			} else {
				out.push(rel);
			}
		}
		return out;
	};
	if (existsSync(repoPlugins) && existsSync(stagingPlugins)) {
		const have = new Set(walk(stagingPlugins));
		const want = walk(repoPlugins);
		const missing = want.filter(rel => !have.has(rel));
		if (missing.length) {
			console.log(`  ❌ 随包 dsh-plugins 与仓库不一致：缺 ${missing.length}/${want.length} 个文件`
				+ `（例：${missing.slice(0, 5).join('、')}）⇒ 用户侧会 import 失败 / 白屏`);
			criticalMissing++;
		} else {
			console.log(`  ✅ 随包 dsh-plugins 完整性：${want.length} 个文件与仓库逐一对齐`);
		}
	} else {
		console.log('  ❌ 无法校验 dsh-plugins 完整性（仓库或暂存目录不存在）');
		criticalMissing++;
	}
}

// 2.5c-2) ★★ 2026-10-31（真机 P0：**主页空白**，日志
//   `vssaros-dashboard (@vssaros/dsh-dashboard): failed to import: ENOENT … lib/app/dist/dashboard-app.js`
//   ⇒ `SessionCreateError: session create failed: agent-preset/invalid: vssaros-dashboard … never started`
//   ⇒ 会话建不起来 ⇒ 桌面窗口/主页永远空白 ✗✗）：
//   `dsh-plugins/vssaros-dashboard/lib/app/dist/` 里的两个文件是 **`vendor/build.mjs` 的构建产物**，
//   而 `.gitignore` 第 6 行有 `dist/` ⇒ **0 个文件入库** ⇒ 干净检出 / CI / 别人打包时根本没有
//   ⇒ 直装进 profile ⇒ 插件 import 失败 ⇒ 主页空白。本机不复现：本机 10-27 手工跑过构建 ✓。
//   ⇒ 这里**先构建再落位**：仓库里没有就现跑 `vendor/build.mjs`；构建也失败 ⇒ criticalMissing（收尾报红）。
{
	const rel = 'dsh-plugins/vssaros-dashboard/lib/app/dist';
	const artifacts = [
		{ file: 'dashboard-app.js', label: 'vssaros-dashboard/lib/app/dist/dashboard-app.js（主页前端，缺它 ⇒ 主页空白）' },
		{ file: 'dashboard-app.css', label: 'vssaros-dashboard/lib/app/dist/dashboard-app.css（主页样式）' },
	];
	const missing = artifacts.filter(a => !existsSync(path.join(repoRoot, rel, a.file)));
	if (missing.length) {
		console.log(`  ⚠ 主页前端产物缺失（${missing.map(a => a.file).join('、')}）⇒ 现跑构建：node ${rel.replace('lib/app/dist', 'vendor/build.mjs')}`);
		const r = spawnSync(process.execPath, [path.join(repoRoot, 'dsh-plugins/vssaros-dashboard/vendor/build.mjs')], {
			cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 180000,
		});
		if (r.status !== 0) {
			console.log(`  ❌ 主页前端构建失败（exit=${r.status}）：${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
			criticalMissing += missing.length;
		}
	}
	for (const a of artifacts) {
		ensureFile(
			a.label,
			`resources/app/dsh-plugins/vssaros-dashboard/lib/app/dist/${a.file}`,
			[`${rel}/${a.file}`],
		);
	}
}

// 2.5c-3) ★★ 2026-10-31（真机：CI 打出的包里**没有飞书入站的 SDK**）：
//   `vssaros-agents/lib/adapters/feishuRawWs.js:134` 运行时 `await import('./vendor/deps/ws/index.js')`
//   ⇒ 而 `lib/adapters/vendor/` 在 `.gitignore` 里，由 `npm run vendor`
//     （= `node scripts/vendor-lark-sdk.mjs`）生成；该脚本头部注释自己写着
//     **「发布脚本必须先跑它，否则包里没有 SDK」** —— CI 里确实没跑 ✗。
//   ⇒ 缺它的后果：飞书入站起不来（"unavailable：未安装 @larksuiteoapi/node-sdk" 的老问题回来）。
{
	const rel = 'dsh-plugins/vssaros-agents/lib/adapters/vendor';
	const sentinel = 'deps/ws/index.js';
	if (!existsSync(path.join(repoRoot, rel, sentinel))) {
		console.log('  ⚠ 飞书入站 SDK 未 vendor ⇒ 现跑：node scripts/vendor-lark-sdk.mjs（在 dsh-plugins/vssaros-agents 下；需能访问 npm 源）');
		const r = spawnSync(process.execPath, ['scripts/vendor-lark-sdk.mjs'], {
			cwd: path.join(repoRoot, 'dsh-plugins/vssaros-agents'), encoding: 'utf8', windowsHide: true, timeout: 300000,
		});
		if (r.status !== 0) {
			console.log(`  ❌ vendor 失败（exit=${r.status}）：${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
			criticalMissing++;
		}
	}
	ensureDir(
		'vssaros-agents/lib/adapters/vendor（飞书入站 SDK，缺它 ⇒ 飞书入站起不来）',
		'resources/app/dsh-plugins/vssaros-agents/lib/adapters/vendor',
		rel,
		sentinel,
	);
}

// 2.5c-4) 交付/合规类文本（**运行时不读**，但缺了不对）：能落位就落位，缺了只警告（不计 criticalMissing，避免假红）。
for (const [label, repoRel, stagingRel, how] of [
	['codebase/vendor/LANGUAGES.txt（bin/vendor-assets.mjs --check 的清单源）',
		'dsh-plugins/vssaros-codebase/vendor/LANGUAGES.txt',
		'resources/app/dsh-plugins/vssaros-codebase/vendor/LANGUAGES.txt',
		'node dsh-plugins/vssaros-codebase/bin/vendor-assets.mjs --all'],
	['pele/assets/VERSION.txt（交付白名单）',
		'dsh-plugins/vssaros-pele/assets/VERSION.txt',
		'resources/app/dsh-plugins/vssaros-pele/assets/VERSION.txt',
		'node dsh-plugins/vssaros-pele/tools/build-pele.mjs'],
	['archify: JetBrainsMono-OFL.txt（第三方字体许可证，合规）',
		'dsh-plugins/vssaros-archify/skills/archify/assets/JetBrainsMono-OFL.txt',
		'resources/app/dsh-plugins/vssaros-archify/skills/archify/assets/JetBrainsMono-OFL.txt',
		'静态文件 ⇒ 入库（git add -f）'],
	['imagegen: LICENSE-excalidraw.txt（第三方许可证，合规）',
		'dsh-plugins/vssaros-imagegen/vendor/excalidraw/LICENSE-excalidraw.txt',
		'resources/app/dsh-plugins/vssaros-imagegen/vendor/excalidraw/LICENSE-excalidraw.txt',
		'静态文件 ⇒ 入库（git add -f）'],
	['marketplace: lib/vendor/README.txt',
		'dsh-plugins/vssaros-marketplace/lib/vendor/README.txt',
		'resources/app/dsh-plugins/vssaros-marketplace/lib/vendor/README.txt',
		'静态文件 ⇒ 入库（git add -f）'],
]) {
	if (existsSync(path.join(repoRoot, repoRel))) {
		ensureFile(label, stagingRel, [repoRel]);
	} else {
		console.log(`  ⚠️ ${label} 缺失（不影响运行，仅影响交付/合规）⇒ 补法：${how}`);
	}
}

// ★ 门禁放在**所有生成之后**（理由见 verifyDshPluginsComplete 的注释）
verifyDshPluginsComplete();

// 2.5d) ★ 2026-10-16（用户报「打包出的 VsSaros.exe 找不到 dsh」，首启弹「需要准备 DeepSeek Harness
//    运行环境」）：**构建期预装的 dsh 运行时**也是"关键构件"，必须与 dsh-plugins 同一待遇。
//
//    它在包里的位置是 `<appPath>/dsh-runtime/<版本>/`（`dshHarnessChannel` 用
//    `join(app.getAppPath(), 'dsh-runtime')`；`DshRuntimeManager.resolveDsh` 的 **bundled 档**读它），
//    是"全新安装首启零下载"的唯一来源。
//
//    为什么昨天那版会缺：`/dsh-runtime/` 在 **.gitignore** 里（由 `build/prepack-dsh-runtime.mjs`
//    现生成）⇒ CI / 干净检出里**根本没有这个目录**；而 gulpfile 的 `dshRuntime` 流是
//    `allowEmpty: true`（有意为之：本地 dev 打包可跳过，运行时退回 npm 安装引导）。
//    两个"各自都合理"的设计叠起来 ⇒ **静默少一个 ~200MB 的关键构件**，且没有任何一处会红 ✗✗
//    （`code.iss` 的 `[Files] Source: "*"` 是照搬暂存目录 ⇒ 暂存没有 = 装出来没有）。
//
//    版本以 `dsh-plugins/dsh-compat.json` 的 `bundled` 为准（与 supervisor / 运行时解析同源 ✓，
//    不在这里写死版本号，防漂移）。sentinel 取运行时的真实入口 `node_modules/@deepseek-ai/dsh/lib/bin.js`：
//    它同时证明**版本对**、**目录不是空壳**（与 tree-sitter 那几条同一思路 ✓）。
//    ⚠ 自愈是**整目录** cp（含 profile-seed/），所以种子一并回来了。
let bundledVersion = '';
let versionKnown = false;
try {
	bundledVersion = String(JSON.parse(readFileSync(path.join(repoRoot, 'dsh-plugins/dsh-compat.json'), 'utf8')).bundled ?? '').trim();
	versionKnown = /^[0-9A-Za-z.-]+$/.test(bundledVersion);
	if (!versionKnown) {
		console.log(`  ❌ dsh-plugins/dsh-compat.json 的 bundled 字段非法：${JSON.stringify(bundledVersion)}`);
		criticalMissing++;
	}
} catch (e) {
	console.log(`  ❌ 读不到/解析不了 dsh-plugins/dsh-compat.json（无法确定该内置哪个 dsh 版本）：${String(e?.message ?? e)}`);
	criticalMissing++;
}
if (versionKnown) {
	ensureDir(
		`dsh-runtime/${bundledVersion}（内置运行时 ⇒ 首启零下载）`,
		`resources/app/dsh-runtime/${bundledVersion}`,
		`dsh-runtime/${bundledVersion}`,
		'node_modules/@deepseek-ai/dsh/lib/bin.js',
		// ★★ 2026-10-30（真机 P0：全新机器日志 `正在初始化专属 profile（web 模板）…`）：
		//   同一版本**重建**时（换了插件、加了 profile-seed），暂存里那份旧副本因为有 bin.js
		//   ⇒ 永远跳过拷贝 ⇒ **`profile-seed/` 根本没进包** ⇒ 首启只能走 `dsh profile init`
		//   的 web 模板（bundles 只有 base/web-app）⇒ 插件不加载 ⇒ 主页白屏 ✗✗。
		//   ⇒ refresh：每次按仓库当前内容整目录重拷（约 200MB，几秒到十几秒，可接受）。
		{ refresh: true },
	);
	// ★ 同一条链上的**门禁**：种子必须真的在暂存里（`_ensureProfile` 靠它做"零下载首启"，
	//   缺了就会退化成 web 模板 ⇒ 上面那条 P0 的现场）。任一 profile 有 package.json 即算通过。
	{
		const seedRoot = path.join(buildDir, toStagingRel('resources/app/dsh-runtime'), bundledVersion, 'profile-seed', 'profiles');
		let seedOk = false;
		try {
			for (const d of readdirSync(seedRoot, { withFileTypes: true })) {
				if (d.isDirectory() && existsSync(path.join(seedRoot, d.name, 'package.json'))) { seedOk = true; break; }
			}
		} catch { seedOk = false; }
		if (seedOk) {
			console.log('  ✅ profile-seed 已随包（首启零下载）');
		} else {
			console.log('  ❌ 随包 dsh-runtime 缺 profile-seed/profiles/<p>/package.json'
				+ ' ⇒ 全新机器会退化成 web 模板（bundles 只有 base/web-app，我们的插件不加载）✗');
			criticalMissing++;
		}
	}
	// 仓库侧也没有它时（上面已计 criticalMissing）：再给一句**可执行**的补救 ——
	// 否则现场只知道"缺"，不知道缺的那一步是"跑 prepack"（昨天那次就是这么过去的 ✗）
	if (!existsSync(path.join(repoRoot, 'dsh-runtime', bundledVersion))) {
		console.log(`      ⇒ 先跑 \`node build/prepack-dsh-runtime.mjs\` 生成 dsh-runtime/${bundledVersion}/（约 200MB，需能访问 npm 源）`);
	}
}

// 2.6) @vscode/tree-sitter-wasm（2026-09-15，用户报「vssaros.exe 报错」）：
//    codebase 图谱的解析 Worker 池按**运行时路径**读取本模块
//    （`codebaseGraphParserPool._initPool` → `FileAccess.asFileUri('<appRoot>/node_modules/@vscode/tree-sitter-wasm/wasm/…')`：
//     `tree-sitter.js` + `tree-sitter.wasm` + 各语言 `tree-sitter-*.wasm`）。
//    读不到 ⇒ `Worker pool init failed … fallback to main thread`
//    ⇒ 18 万节点的索引改在 **renderer 主线程**解析（UI 冻结），而日志里只有一条 WARN。
//    ⚠ 该模块**从不被静态 import**（`importAMDNodeModule('@vscode/tree-sitter-wasm', 'wasm/tree-sitter.js')`
//    是字符串路径），静态依赖图 / bundler externals **看不见它** ⇒ 必须在打包阶段显式保证落位
//    （与 kbWorker.js / rg.exe / better_sqlite3.node 同一类「关键构件」）。
//    实测已发布包 `2.2.26032-saros` 就缺它：`resources/app/node_modules/@vscode/` 只有 13 个包、
//    没有 tree-sitter-wasm（而该包自己的 package.json 已声明 `@vscode/tree-sitter-wasm: ^0.3.1`）。
ensureDir(
	'@vscode/tree-sitter-wasm',
	'resources/app/node_modules/@vscode/tree-sitter-wasm',
	'node_modules/@vscode/tree-sitter-wasm',
	'wasm/tree-sitter.js',
);

// 2.6b) 逐语言 wasm 也要齐（2026-09-20，用户报「10/11 个语言的 tree-sitter wasm **读取失败**」）：
//    ensureDir 的 sentinel 只证明 `wasm/tree-sitter.js` 在 ✗ —— 它**不证明各语言 wasm 在** ✗✗。
//    打包的 bundler 只会带上 **VS Code 自身引用**的那 7 个（bash/css/ini/powershell/regex/typescript/tree-sitter ✓），
//    而 agentStudio 图谱按**运行时路径**读的另 10 个（tsx/javascript/python/go/rust/java/ruby/cpp/c-sharp/php ✗）
//    从不被静态 import ⇒ 被丢 ✗✗ ⇒ 装出来只有 `typescript` 能解析、其余语言全「检索不到内容 / 0 节点」✗✗。
//    ⇒ 以**仓库侧 wasm 目录为准**逐文件补齐（**不硬编码语言清单**，防漂移 ✗✓ —— 包升级带新语言时自动跟随 ✓）。
{
	const repoWasmDir = path.join(repoRoot, 'node_modules/@vscode/tree-sitter-wasm/wasm');
	if (existsSync(repoWasmDir)) {
		let added = 0;
		for (const f of readdirSync(repoWasmDir).filter(x => x.endsWith('.wasm'))) {
			const stagingAbs = path.join(buildDir, toStagingRel(`resources/app/node_modules/@vscode/tree-sitter-wasm/wasm/${f}`));
			if (!existsSync(stagingAbs)) { added++; }
			ensureFile(
				`tree-sitter-wasm/wasm/${f}`,
				`resources/app/node_modules/@vscode/tree-sitter-wasm/wasm/${f}`,
				[`node_modules/@vscode/tree-sitter-wasm/wasm/${f}`],
			);
		}
		if (added > 0) { console.log(`  ⚠ 逐语言 wasm 缺 ${added} 个（已自愈 ✓）—— 说明 bundler 又丢了对运行时路径加载的构件 ✗`); }
	} else {
		console.log('  ❌ 仓库侧 @vscode/tree-sitter-wasm/wasm 目录不存在（无法逐语言校验）');
		criticalMissing++;
	}
}

// 2.6c) @vscode/deviceid（2026-10-29，用户报「打包 exe 启动报错」）：
//   `out/main.js` 里 `require('@vscode/deviceid')` 取 machineId —— 非静态 import ⇒ bundler 看不见，
//   而该包 `main = dist/index.js`（纯 JS、整包仅 0.04MB，不是原生模块）⇒ 整包落位即可用。
//   实测产物 `resources/app/node_modules/@vscode/` 只有 13 个包、**没有它**
//   ⇒ 每次启动一条 `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vscode/deviceid' imported from out/main.js`，
//   设备标识链静默降级（与 tree-sitter-wasm 完全同一成因：依赖树里有、gulp 的 node_modules 流没落位）。
ensureDir(
	'@vscode/deviceid',
	'resources/app/node_modules/@vscode/deviceid',
	'node_modules/@vscode/deviceid',
	'dist/index.js',
);

// 2.5c) ★ 2026-10-12（**决策 2 = wasm 全量随包**）：`dsh-plugins/vssaros-codebase/vendor/`（≈21MB）。
//    为什么上面 2.5b 的 sentinel **不够**：那个 sentinel 是 `vssaros-bridge/package.json` ——
//    它只证明 `dsh-plugins/` **被灌满**，**不证明我们插件包里那 21MB 资产在** ✗✗
//    （这正是 2.6b 那条踩过的坑：`ensureDir` 的 sentinel 证明不了"目录里每个文件都在" ✓）。
//    真机后果（若漏）：`lib/parser/resolve.js` 的"随包 vendor/"这一级候选不成立 ⇒ 退到 dev 的
//    `node_modules`（生产包里没有）⇒ **要真解析就 `no-parser-assets` 当场拒**，而且用户的观感是
//    "索引功能在开发机上好好的、装出来就不行" ✗✗（本仓最贵的那类静默失效 ✓）。
//    ⇒ 以**仓库侧 vendor 目录为准**逐文件补齐（**不硬编码语言清单**，防漂移 ✓ —— 将来换档/加语言自动跟随 ✓）。
{
	const repoVendorDir = path.join(repoRoot, 'dsh-plugins/vssaros-codebase/vendor');
	const stagingVendorRel = toStagingRel('resources/app/dsh-plugins/vssaros-codebase/vendor');
	if (existsSync(repoVendorDir)) {
		const entries = readdirSync(repoVendorDir).filter(name => name !== 'LANGUAGES.txt');
		// 清单文件也一起带上（它记录"这批资产是哪几档语言"，人查/守卫查都用得上 ✓；不是运行时依赖 ✓）
		for (const name of [...entries, 'LANGUAGES.txt']) {
			if (!existsSync(path.join(repoVendorDir, name))) { continue; }
			const stagingAbs = path.join(buildDir, `${stagingVendorRel}/${name}`);
			if (!existsSync(stagingAbs)) {
				ensureFile(`vssaros-codebase/vendor/${name}`, `${stagingVendorRel}/${name}`, [`dsh-plugins/vssaros-codebase/vendor/${name}`]);
			}
		}
		// 运行时**必须是 `.cjs`**（原样 `.js` 会被当 ESM 求值 ⇒ 报一句看不出根因的
		// `Unable to determine script URL` ✗ —— 见插件里 `lib/parser/resolve.js` 文件头；这里当场判它 ✓）
		const runtimeAbs = path.join(buildDir, `${stagingVendorRel}/tree-sitter.cjs`);
		if (!existsSync(runtimeAbs)) {
			console.log(`  ❌ vssaros-codebase/vendor 的运行时不是 \`tree-sitter.cjs\`（进包必须改名 `.cjs`，否则会被当 ESM 求值 ✗）`);
			criticalMissing++;
		} else {
			const bytes = entries.reduce((sum, name) => sum + (statSync(path.join(repoVendorDir, name)).size || 0), 0);
			console.log(`  ✅ vssaros-codebase/vendor（${entries.length} 个文件 / ${(bytes / 1024 / 1024).toFixed(2)}MB —— 决策 2 全量档）`);
		}
	} else {
		console.log('  ❌ 仓库侧 dsh-plugins/vssaros-codebase/vendor 不存在 ⇒ 跑 `node dsh-plugins/vssaros-codebase/bin/vendor-assets.mjs --all` 生成（决策 2）');
		criticalMissing++;
	}
}

// 2.7) ★ 2026-09-21：能力插件清单 `out/vs/extensions/capability-plugins.js`
// 由 `build/next/index.ts` 在 `npm run transpile-client` 时**生成**（不是源码、不被静态 import），
// 而 renderer 侧按**运行时路径** `../../../../extensions/capability-plugins.js` 动态 import 它
// ⇒ 与 tree-sitter wasm / kbWorker.js 同一类"生成产物漏拷" ✗。
// 真机后果（安装版日志 2026-09-21）：`Failed to load capability-plugins.js manifest.
// Falling back to hardcoded plugin list (dev mode)` ⇒ 生产包里却在跑 **dev 回退清单**，
// 且随后每个插件的 primary import 都指向 `src/extension.js`（dev 路径）⇒ 必然失败一次 ✗。
ensureFile(
	'out/vs/extensions/capability-plugins.js',
	'resources/app/out/vs/extensions/capability-plugins.js',
	['out/vs/extensions/capability-plugins.js'],
);

// 3) kbWorker.js（KB 内核 Worker 按 URL 加载；bundle 不产出 per-file 时需独立入口）
ensureFile(
	'kbWorker.js',
	'resources/app/out/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbWorker.js',
	['out/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbWorker.js'],
);

// 3.5) new-window.ps1（任务栏 jump list "New Window" 多开启动脚本；须落在 asar 外
//      resources/saros/，外部 PowerShell 进程才能读取执行。workspacesHistoryMainService
//      的 getNewWindowScriptArgs() 按 process.resourcesPath 解析此路径）
ensureFile(
	'resources/saros/new-window.ps1',
	'resources/saros/new-window.ps1',
	['scripts/new-window.ps1'],
);

// 4) @vscode/sqlite3 原生模块（Codebase 图谱 SQLite 后端 + KB SQLite 必需）。
//    缺失 → 主进程 require('@vscode/sqlite3') 抛错 → search_graph/query_graph
//    走 SQLite 后端全部失败。需在 asar.unpacked 内（asar 内无法加载原生模块）。
ensureFile(
	'@vscode/sqlite3/build/Release/vscode-sqlite3.node',
	'resources/app/node_modules.asar.unpacked/@vscode/sqlite3/build/Release/vscode-sqlite3.node',
	['build/saros/bin/vscode-sqlite3.node'],
);

// 5) better-sqlite3 原生模块（KB 全文检索 kbSqliteStore 必需；root package.json 已声明
//    12.11.1，JS 壳随 node_modules.asar 打包，此处保证 Electron-ABI 的 .node 落位
//    asar.unpacked）。bindings 为 better-sqlite3 的 npm 依赖，声明后自动进 asar。
//    非 N-API（V8 API）→ 升级 Electron 必须同步重编 build/saros/bin/sqlite/better_sqlite3.node。
ensureFile(
	'better-sqlite3/build/Release/better_sqlite3.node',
	'resources/app/node_modules.asar.unpacked/better-sqlite3/build/Release/better_sqlite3.node',
	['build/saros/bin/sqlite/better_sqlite3.node'],
);

// 5.1) ⚠ 同一份绑定还必须落在**真实 node_modules** 下（2026-09-14 生产事故：
//    media.import 报 "media store unavailable (better-sqlite3 failed to load)"）。
//    实测已安装产物形态为：resources/app/node_modules 是真实目录（node_modules.asar
//    是 28 字节空归档 {"files":{}}），此时运行时 require('better-sqlite3') 解析到真实
//    目录里的 JS 壳，而 better-sqlite3 内部用 `bindings` **只在包内**查
//    build/Release/better_sqlite3.node —— 该文件仅存在于 asar.unpacked 时必然抛
//    "Could not locate the bindings file"，被上层 catch 吞掉后就是上面的报错。
//    运行时已有 betterSqlite3.ts 显式传 nativeBinding 兜底，这里补齐磁盘落位双保险。
ensureFile(
	'better-sqlite3/build/Release/better_sqlite3.node (node_modules)',
	'resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
	['build/saros/bin/sqlite/better_sqlite3.node'],
);

// 6) ★ 2026-09-25：内置智能体资源 `resources/.agents/**`（技能 / KB 同步脚本 / MCP 预设 / 内置工作流 / 工具）
//    —— 与 kbWorker.js / tree-sitter-wasm **同一类**构件：**运行时按路径读取、从不被静态 import**
//    ⇒ 打包拷贝只带走它认识的文件，**点目录（`.agents`）整棵被漏掉**：
//      · 内置技能：`skillRegistryService` 用 `FileAccess.asFileUri('vs/../../resources/.agents/skills')` 扫描；
//      · 飞书同步脚本：`feishuSyncCore.resolveSyncScript` 找 `<appRoot>/resources/.agents/kb/feishu-sync.mjs`。
//    实测已发布包（用户报障 2026-09-25）：`resources/app/resources` 下**只有 `thirdparty`/`win32`**，
//    `.agents` 整棵不存在 ⇒ 内置技能全部缺失，点「同步飞书」报
//    「未找到内置同步脚本（resources/.agents/kb/feishu-sync.mjs）——安装可能不完整」。
//    ⚠ 已核对 Inno 的 `[Files] Excludes`（build/win32/code.iss:114）**没有**排除 `.agents`
//      ⇒ 根因在 staging 拷贝环节；这里整棵兜底自愈。
//    sentinel 用 kb 脚本：技能可以后补，脚本缺了「同步飞书 / kb_feishu_sync」直接不可用。
ensureDir(
	'resources/.agents（内置技能 + KB 同步脚本 + MCP 预设 + 内置工作流）',
	'resources/app/resources/.agents',
	'resources/.agents',
	'kb/feishu-sync.mjs',
);

// === 5.5 ffmpeg/ffprobe（vox 口播视频节点可选依赖）===
// 内置到 resources/saros/bin/，让安装包「默认自带 ffmpeg」。缺失仅警告（不阻断
// 核心出包，vox 功能会回退提示用户），与 rg.exe 等核心构件区分。
console.log('\n🎬 [可选依赖] ffmpeg/ffprobe（vox 口播视频）:');
function ensureOptionalBin(label, stagingRel, repoRel) {
	const stagingAbs = path.join(buildDir, stagingRel);
	if (existsSync(stagingAbs)) {
		console.log(`  ✅ ${label}`);
		return;
	}
	const repoAbs = path.join(repoRoot, repoRel);
	if (existsSync(repoAbs)) {
		mkdirSync(path.dirname(stagingAbs), { recursive: true });
		cpSync(repoAbs, stagingAbs);
		console.log(`  ♻️  ${label} —— 已从 ${repoRel} 复制到安装包`);
	} else {
		console.log(`  ⚠️  ${label} 缺失（vox 口播视频不可用）。获取: node build/saros/fetch-ffmpeg.mjs`);
	}
}
// macOS 二进制没有 .exe 后缀（且 build/saros/bin 里目前只有 win 版 ⇒ 缺失仅警告，不阻断出包）
const BIN_EXT = IS_DARWIN ? '' : '.exe';
ensureOptionalBin(`ffmpeg${BIN_EXT}`, `resources/saros/bin/ffmpeg${BIN_EXT}`, `build/saros/bin/ffmpeg${BIN_EXT}`);
ensureOptionalBin(`ffprobe${BIN_EXT}`, `resources/saros/bin/ffprobe${BIN_EXT}`, `build/saros/bin/ffprobe${BIN_EXT}`);
ensureOptionalBin(`yt-dlp${BIN_EXT}`, `resources/saros/bin/yt-dlp${BIN_EXT}`, `build/saros/bin/yt-dlp${BIN_EXT}`);

// === 5.6 whisper.cpp（本地 ASR：video_analyze 对无字幕轨视频的口播转写）===
// 2026-09-25 用户拍板随包。exe+DLL ≈8MB；模型 ggml-base ≈141MB 显著抬包体积 ——
// 若将来要瘦身，优先把模型改为「首用按需下载」（fetch-whisper.mjs 的下载逻辑可复用）。
// 缺失仅警告不阻断出包（与 ffmpeg 同级：功能是降级为「口播内容不可知」，不是崩）。
console.log('\n🗣️ [可选依赖] whisper.cpp（本地 ASR 口播转写）:');
ensureOptionalBin(`whisper-cli${BIN_EXT}`, `resources/saros/bin/whisper-cli${BIN_EXT}`, `build/saros/bin/whisper-cli${BIN_EXT}`);
// DLL 是运行时依赖（whisper.dll/ggml*.dll/parakeet.dll/SDL2.dll），缺一个 exe 就起不来。
// 按名字前缀 glob 拷贝而不逐个点名：whisper.cpp 版本间 DLL 清单会变（如 v1.9 新增
// parakeet.dll），点名会漏。build/saros/bin/ 下没有其他来源的 .dll（ffmpeg/yt-dlp 是
// 静态 exe，rg/sqlite 是 .exe/.node）⇒ 这个 glob 不会误拷。
{
	const repoBin = path.join(repoRoot, 'build/saros/bin');
	const stagingBin = path.join(buildDir, toStagingRel('resources/saros/bin'));
	// win: *.dll（whisper/ggml/parakeet/SDL2）；mac: 同一批库的 *.dylib
	const libRe = IS_DARWIN ? /^(whisper|ggml|parakeet|SDL2).*\.(dylib|so)$/i : /^(whisper|ggml|parakeet|SDL2).*\.dll$/i;
	const dlls = existsSync(repoBin)
		? readdirSync(repoBin).filter(f => libRe.test(f))
		: [];
	if (dlls.length === 0) {
		console.log(`  ⚠️  whisper 运行时库缺失（whisper-cli 将起不来；${IS_DARWIN ? 'macOS 需要 .dylib' : 'Windows 需要 .dll'}）。获取: node build/saros/fetch-whisper.mjs`);
	}
	for (const d of dlls) {
		ensureOptionalBin(d, `resources/saros/bin/${d}`, `build/saros/bin/${d}`);
	}
}
ensureOptionalBin('ggml-base.bin (whisper 模型)', 'resources/saros/models/ggml-base.bin', 'build/saros/models/ggml-base.bin');

if (criticalMissing > 0) {
	console.error(`\n💥 ${criticalMissing} 项关键构件缺失且无法自愈——禁止带病出包！`);
	console.error('   请先执行：node build/next/index.ts transpile-plugins && npm run transpile-client，重建打包目录后重试。');
	process.exit(1);
}

// === 产物自带 pnpm（2026-10-29）================================================
//   为什么：用户机器上通常**没有 pnpm**（那是开发工具）⇒ 启动时装插件已由「直装」兜底，
//   但运行时（在页面里装第三方插件 / 技能、`dsh plugin add`）仍要用 pnpm ⇒ 产物必须自带一份。
//   ⚠ 只带**单文件 bundle**（`dist/pnpm.cjs`，7.4MB，自带全部依赖）；
//     它需要 node 解释器 ⇒ 由 IDE 侧用 **Electron 自己的 `ELECTRON_RUN_AS_NODE=1`** 来跑
//     （实测 `ELECTRON_RUN_AS_NODE=1 "<exe>" pnpm.cjs --version` ⇒ 10.18.0，1.1 秒）
//     ⇒ **不要求用户机器装 node** ✓。
//   ⚠ 失败**不阻断**打包（启动路径已被直装覆盖，这只影响"运行时能不能用 pnpm"）。
{
	const tool = join(__dirname, 'ensure-pnpm-tool.mjs');
	if (!existsSync(tool)) {
		console.log('  ⚠️  缺少 build/saros/ensure-pnpm-tool.mjs ⇒ 产物不会自带 pnpm');
	} else {
		const r = spawnSync(process.execPath, [tool, buildDir], { stdio: 'inherit' });
		if (r.status !== 0) {
			console.log('  ⚠️  pnpm 工具落位脚本异常（不阻断打包：启动已由直装兜底覆盖）');
		}
	}
}

// === 产物内容门禁（2026-10-29）=================================================
//   为什么不能只信上面的 `criticalMissing`：它只统计"仓库源也没有、自愈不了"的那些；
//   而"自愈成功"也可能**没落到最终产物里**（复制后被清、路径不对、被别的步骤覆盖）。
//   真机（别人机器上装我们的 exe）：产物里**缺 `@vscode/deviceid`**
//   （`Error [ERR_MODULE_NOT_FOUND] … imported from …/out/main.js`），
//   而补回它的 `ensureDir` 调用当时**早就在这个文件里**（00:36 写好、13:40 打的包）
//   ⇒ 说明**这个脚本压根没跑**（它不在 gulp 任务链里，靠手工执行）⇒ 缺件一路溜到用户手上 ✗✗。
//   ⇒ 这里**独立复核**一遍产物内容（清单从本文件的 ensureDir 调用自动推导 ⇒ 单一真相源），
//     缺一即 exit(1) ⇒ **打包中止**。
{
	const gate = join(__dirname, 'check-pack-contents.mjs');
	if (!existsSync(gate)) {
		console.error(`\n💥 找不到产物内容门禁脚本：${gate}（禁止带病出包）`);
		process.exit(1);
	}
	const r = spawnSync(process.execPath, [gate, buildDir], { stdio: 'inherit' });
	if (r.status !== 0) {
		console.error('\n💥 产物内容门禁未通过——禁止带病出包！');
		process.exit(r.status || 1);
	}
}

// === 汇总 ===
console.log(`\n📊 总计释放: ${(totalFreed / 1024 / 1024).toFixed(1)}MB`);
console.log(`✅ 清理完成，可以执行 ${IS_DARWIN ? 'dmg / zip' : 'Inno Setup'} 打包`);
