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

import { rmSync, existsSync, readdirSync, statSync, mkdirSync, cpSync } from 'node:fs';
import path from 'node:path';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = .../saros-agents-client/build/saros
// ROOT = .../saros-agents-client
const ROOT = resolve(__dirname, '../..');
// 构建输出在项目同级的 VSCode-win32-x64
const DEFAULT_BUILD_DIR = join(ROOT, '../VSCode-win32-x64');

const buildDir = resolve(process.argv[2] || DEFAULT_BUILD_DIR);

if (!existsSync(buildDir)) {
	console.error(`❌ 构建输出目录不存在: ${buildDir}`);
	process.exit(1);
}

console.log(`🧹 清理构建输出: ${buildDir}\n`);

let totalFreed = 0;

function toPosix(p) {
	return p.replace(/\\/g, '/');
}

function removeDir(label, relPath) {
	const absPath = join(buildDir, relPath);
	if (!existsSync(absPath)) {
		console.log(`  ⏭  ${label} — 不存在，跳过`);
		return;
	}
	let size = 0;
	try {
		const out = execSync(`du -sb "${toPosix(absPath)}" 2>/dev/null`, { encoding: 'utf8' }).trim();
		size = parseInt(out.split('\t')[0]) || 0;
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
	const absPath = join(buildDir, relPath);
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
		const out = execSync(`find "${toPosix(buildDir)}" -name "${pattern}" -type f 2>/dev/null`, { encoding: 'utf8' }).trim();
		if (!out) {
			console.log(`  ⏭  ${label} — 无匹配，跳过`);
			return;
		}
		const files = out.split('\n').filter(Boolean);
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

// node-pty: 仅保留 win32-x64 prebuilds
const ptyPrebuilds = join(buildDir, 'resources/app/node_modules/node-pty/prebuilds');
if (existsSync(ptyPrebuilds)) {
	const keptPrefix = 'win32-x64';
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
	execSync(`find "${toPosix(buildDir)}/resources/app/node_modules" -type d -empty -delete 2>/dev/null`);
	console.log('  ✅ 已清理空目录');
} catch { /* ignore */ }

// === 5. 关键构件校验与自愈（2026-08-05，生产事故 1785894964584） ===
// rg.exe 缺失 → 内容搜索降级慢速 walk；agentmemory dist 缺失 → 能力插件 404；
// kbWorker.js 缺失 → KB worker 404 回退主线程。缺任何一样都不得出包。
console.log('\n🩺 [关键构件] 校验与自愈:');
const repoRoot = path.resolve(__dirname, '../..');
let criticalMissing = 0;

function ensureFile(label, stagingRel, repoRelCandidates) {
	const stagingAbs = path.join(buildDir, stagingRel);
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
function ensureDir(label, stagingRel, repoRel, sentinel = 'extension.js') {
	const stagingAbs = path.join(buildDir, stagingRel);
	const sentinelAbs = path.join(stagingAbs, sentinel);
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
ensureOptionalBin('ffmpeg.exe', 'resources/saros/bin/ffmpeg.exe', 'build/saros/bin/ffmpeg.exe');
ensureOptionalBin('ffprobe.exe', 'resources/saros/bin/ffprobe.exe', 'build/saros/bin/ffprobe.exe');

if (criticalMissing > 0) {
	console.error(`\n💥 ${criticalMissing} 项关键构件缺失且无法自愈——禁止带病出包！`);
	console.error('   请先执行：node build/next/index.ts transpile-plugins && npm run transpile-client，重建打包目录后重试。');
	process.exit(1);
}

// === 汇总 ===
console.log(`\n📊 总计释放: ${(totalFreed / 1024 / 1024).toFixed(1)}MB`);
console.log('✅ 清理完成，可以执行 Inno Setup 打包');
