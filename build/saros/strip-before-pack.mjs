#!/usr/bin/env node
/**
 * strip-before-pack.mjs — VsSarosis 安装包预打包清理脚本
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
 * 【VsSarosis 品牌下不工作 - 可安全排除】
 *   - @github/copilot (整个目录, 49MB) — 使用 Knot AG-UI, 不需要 GitHub Copilot
 *   - @microsoft/1ds-* 遥测 SDK — 连接 Microsoft 端点, VsSarosis 不应连 MS
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

// === 2. VsSarosis 品牌下不工作 ===
console.log('\n🏷️  [品牌] VsSarosis 不需要的模块:');

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

// 1) ripgrep（整包恢复：bin/rg.exe + lib + package.json）
if (!existsSync(path.join(buildDir, 'resources/app/node_modules/@vscode/ripgrep/bin/rg.exe'))) {
	const src = path.join(repoRoot, 'node_modules/@vscode/ripgrep');
	if (existsSync(path.join(src, 'bin/rg.exe'))) {
		mkdirSync(path.join(buildDir, 'resources/app/node_modules/@vscode'), { recursive: true });
		cpSync(src, path.join(buildDir, 'resources/app/node_modules/@vscode/ripgrep'), { recursive: true });
		console.log('  ♻️  @vscode/ripgrep —— 已从仓库 node_modules 整包恢复');
	} else {
		console.log('  ❌ @vscode/ripgrep/bin/rg.exe 缺失且仓库无可恢复源');
		criticalMissing++;
	}
} else {
	console.log('  ✅ @vscode/ripgrep/bin/rg.exe');
}

// 2) agentmemory 能力插件 dist（AgentCapability 回退路径硬编码加载）
ensureFile(
	'agentmemory-memory/dist/extension.js',
	'resources/app/extensions/agentmemory-memory/dist/extension.js',
	['extensions/agentmemory-memory/dist/extension.js'],
);

// 3) kbWorker.js（KB 内核 Worker 按 URL 加载；bundle 不产出 per-file 时需独立入口）
ensureFile(
	'kbWorker.js',
	'resources/app/out/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbWorker.js',
	['out/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbWorker.js'],
);

// 4) @vscode/sqlite3 原生模块（Codebase 图谱 SQLite 后端 + KB SQLite 必需）。
//    缺失 → 主进程 require('@vscode/sqlite3') 抛错 → search_graph/query_graph
//    走 SQLite 后端全部失败。需在 asar.unpacked 内（asar 内无法加载原生模块）。
ensureFile(
	'@vscode/sqlite3/build/Release/vscode-sqlite3.node',
	'resources/app/node_modules.asar.unpacked/@vscode/sqlite3/build/Release/vscode-sqlite3.node',
	['build/saros/bin/vscode-sqlite3.node'],
);

if (criticalMissing > 0) {
	console.error(`\n💥 ${criticalMissing} 项关键构件缺失且无法自愈——禁止带病出包！`);
	console.error('   请先执行：node build/next/index.ts transpile-plugins && npm run transpile-client，重建打包目录后重试。');
	process.exit(1);
}

// === 汇总 ===
console.log(`\n📊 总计释放: ${(totalFreed / 1024 / 1024).toFixed(1)}MB`);
console.log('✅ 清理完成，可以执行 Inno Setup 打包');
