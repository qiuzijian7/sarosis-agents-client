#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 构建期预装 dsh 运行时：把 `dsh-plugins/dsh-compat.json` 里 `bundled` 指定的版本
 * 安装到仓库根的 `dsh-runtime/<version>/`（npm install --prefix，与运行时托管安装同构），
 * 由 gulpfile.vscode.ts 的 dshRuntime 资源流原样打进安装包 `<appPath>/dsh-runtime/`。
 *
 * 效果：全新安装首启零下载——DshRuntimeManager.resolveDsh 的 bundled 档直接命中，
 * 不再依赖用户网络的 npm 源。缺失/损坏时运行时自动退回原有 npm 安装引导。
 *
 * 用法：node build/prepack-dsh-runtime.mjs [--force]
 * 幂等：目标目录已有同版本 bin.js 时跳过安装（--force 重装）；裁剪与 profile 种子每次都会补跑
 * （各自幂等），保证旧产物升级清单/插件版本后不用重装运行时。
 *
 * 注意：在 CodeBuddy IDE 里跑要净化 NODE_OPTIONS（注入的 safe-delete 会拦裁剪的批量删除）。
 */

/** 安装后裁剪的重型可选负载（参考 skymecode/deepseek-harness-for-vscode 的做法）：
 *  聊天框场景用不到，删掉可省 ~205 MB；功能本身按"缺失即降级"验证（first-run e2e 全绿为准）。 */
const PRUNE_LIST = [
	// 文档预览的 LibreOffice 转换内核（182 MB）：聊天框不展示文档预览侧栏。
	['node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64'],
	['node_modules', '@deepseek-ai', 'libreoffice-kit-darwin-arm64'],
	['node_modules', '@deepseek-ai', 'libreoffice-kit-darwin-x64'],
	['node_modules', '@deepseek-ai', 'libreoffice-kit-linux-x64'],
	// 注意：sherpa-onnx-*（本地语音识别，22 MB）**不裁**——语音输入是聊天框特性
	//（voice-input bundle 由 supervisor 装进 profile，引擎靠它跑 SenseVoice）。
];

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'dsh-plugins', 'dsh-compat.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const version = manifest.bundled;
if (!version) {
	console.log('[prepack-dsh] compat 清单没有 bundled 字段，跳过（安装包将不含内置运行时）');
	process.exit(0);
}
if (!manifest.versions?.some(v => v.version === version)) {
	console.error(`[prepack-dsh] bundled 版本 ${version} 不在清单 versions 里（未验证版本不许预装）`);
	process.exit(1);
}


const target = join(root, 'dsh-runtime', version);
const bin = join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const force = process.argv.includes('--force');

if (existsSync(bin) && !force) {
	prune(target); // 已有安装也补跑裁剪（幂等），保证旧产物升级裁剪清单后不用重装
	console.log(`[prepack-dsh] dsh ${version} 已在 ${target}，跳过安装（${Math.round(dirSize(target) / 1024 / 1024)} MB）`);
	const actual0 = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim().split(/\r?\n/).pop();
	await buildProfileSeed(target, bin, actual0); // 种子缺失/过期时补建
	process.exit(0);
}
if (existsSync(target)) {
	rmSync(target, { recursive: true, force: true });
}

console.log(`[prepack-dsh] installing @deepseek-ai/dsh@${version} → ${target}`);
// 优先用随 Node 的 npm-cli.js 直跑（Windows 下 execFile 直跑 npm.cmd 会被 EINVAL 拒绝）；
// 找不到才回退 PATH 里的 npm（Windows 需经 shell 起批处理）。
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmArgs = ['install', '--prefix', target, `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund', '--loglevel=error'];
if (existsSync(npmCli)) {
	execFileSync(process.execPath, [npmCli, ...npmArgs], { stdio: 'inherit', cwd: root });
} else {
	execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
}

if (!existsSync(bin)) {
	console.error(`[prepack-dsh] 安装后未找到 ${bin}`);
	process.exit(1);
}
const actual = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim().split(/\r?\n/).pop();
if (actual !== version) {
	rmSync(target, { recursive: true, force: true });
	console.error(`[prepack-dsh] 版本不符：期望 ${version}，实际 ${actual}`);
	process.exit(1);
}

prune(target);
console.log(`[prepack-dsh] done: dsh ${actual} ready at ${target} (${Math.round(dirSize(target) / 1024 / 1024)} MB)`);

// ─── profile 种子（真正消掉首启等待）──────────────────────────────────────
// 冷启动的大头不是装 dsh，而是首启时 web 模板 + 伴生插件的 pnpm 下载。
// 这里在构建期把 profile 完整建好（copy 导入模式 → node_modules 是真实文件、可搬运），
// 首启时 supervisor 整目录复制到 DSH_HOME——秒级完成，零网络。
await buildProfileSeed(target, bin, actual);

/**
 * `dsh-plugins/` 下带 `vssaros.module` 清单的**模块插件**目录（agents / skills / mcp / kb / memory /
 * codebase / kanban / workflow / dashboard / ide）。
 *
 * 同一判据在宿主侧是 `listBundledPlugins()`（`src/vs/sessions/contrib/dshHarness/electron-main/
 * dshBundledPlugins.ts`）；构建脚本不能 import TS ⇒ 就地重写一遍，`dshPluginPackages.test.ts` 里有一条
 * 守卫比对两边口径（只有一份判断标准，漂移会红）。
 */
function discoverModulePluginDirs(baseDir) {
	const out = [];
	let entries;
	try {
		entries = readdirSync(baseDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const dir = join(baseDir, entry.name);
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
			if (typeof pkg?.name === 'string' && pkg.name.startsWith('@vssaros/')
				&& typeof pkg?.vssaros?.module === 'string' && pkg.vssaros.module.trim()) {
				out.push(dir);
			}
		} catch { /* 不是包 / 读不动 ⇒ 跳过（与宿主侧同口径） */ }
	}
	return out.sort();
}

/** 在 <target>/profile-seed 里建好 vssaros profile（含伴生插件 + 全部模块插件 + web 模板依赖）。 */
async function buildProfileSeed(runtimeDir, dshBin, dshVersion) {
	const { cpSync, mkdirSync, writeFileSync } = await import('node:fs');
	const seed = join(runtimeDir, 'profile-seed');
	const profileDir = join(seed, 'profiles', 'vssaros');
	const markerPath = join(seed, 'seed.json');
	const pluginSources = [
		...['vssaros-bridge', 'vssaros-chat-surface'].map(n => join(root, 'dsh-plugins', n)),
		// 模块插件自 2026-10-11 起**全部随包**（用户要求）：自发现，避免"新模块忘了加进清单"的漂移
		// （漂移的表现是"模块没装、图标也不出现"，编译期看不出来 ✗）。
		...discoverModulePluginDirs(join(root, 'dsh-plugins')),
		join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-experimental-voice-input-bundle'),
	];
	const wantPlugins = {};
	for (const src of pluginSources) {
		const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
		wantPlugins[pkg.name] = pkg.version;
	}
	if (existsSync(markerPath)) {
		const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
		if (marker.dsh === dshVersion && JSON.stringify(marker.plugins) === JSON.stringify(wantPlugins) && existsSync(join(profileDir, 'package.json'))) {
			console.log('[prepack-dsh] profile seed 已是最新，跳过');
			return;
		}
	}
	console.log('[prepack-dsh] building profile seed（约 1–3 分钟，仅构建期一次性）…');
	rmSync(seed, { recursive: true, force: true }); // dsh 要求 profile 目录不存在，由它自己创建
	// copy 导入模式：node_modules 是真文件而不是指向 pnpm store 的链接——否则搬不走。
	const env = { ...process.env, DSH_HOME: seed, npm_config_package_import_method: 'copy' };
	const dsh = args => execFileSync(process.execPath, [dshBin, ...args], { env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

	dsh(['--profile', 'vssaros', '--from-default-profile', 'web', '--help']);
	if (!existsSync(join(profileDir, 'package.json'))) {
		throw new Error('profile 初始化失败（seed）');
	}
	for (const src of pluginSources) {
		const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
		// 与运行时 supervisor._stagePlugin 同构：暂存到 profile 内再装（避开跨盘符 file: 坑）。
		const flat = pkg.name.replace(/^@/, '').replace(/\//g, '-');
		const staged = join(profileDir, '.vssaros', 'plugins', `${flat}-${pkg.version}`);
		rmSync(staged, { recursive: true, force: true });
		mkdirSync(staged, { recursive: true });
		cpSync(src, staged, {
			recursive: true,
			filter: s => !/[\\/]node_modules([\\/]|$)/.test(s.slice(src.length)),
		});
		dsh(['plugin', '--profile', 'vssaros', 'add', `file:${staged.replace(/\\/g, '/')}`]);
		const installed = join(profileDir, 'node_modules', ...pkg.name.split('/'), 'package.json');
		if (!existsSync(installed)) {
			throw new Error(`seed 插件安装失败：${pkg.name}`);
		}
		console.log(`[prepack-dsh] seed plugin: ${pkg.name}@${pkg.version}`);
	}
	// 起一次 Host 让 web 模板依赖全部落盘（首启的 pnpm 下载就发生在这步），看到 URL 行即杀。
	console.log('[prepack-dsh] booting Host once against the seed to materialize web-template deps…');
	const { spawn } = await import('node:child_process');
	await new Promise((resolveBoot, rejectBoot) => {
		const child = spawn(process.execPath, [dshBin, '--profile', 'vssaros', '--no-open', '--port', '0'], { env });
		let out = '';
		let ready = false;
		const timer = setTimeout(() => { child.kill('SIGKILL'); rejectBoot(new Error(`seed Host 5 分钟未就绪：${out.slice(-600)}`)); }, 300_000);
		const onData = d => {
			out = (out + d.toString()).slice(-64 * 1024);
			if (!ready && /dsh web: http:\/\/127\.0\.0\.1:\d+/.test(out)) {
				ready = true;
				clearTimeout(timer);
				child.kill('SIGTERM');
				setTimeout(() => { child.kill('SIGKILL'); }, 1_500);
			}
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.on('exit', () => {
			clearTimeout(timer);
			if (ready) {
				resolveBoot(); // 看到 URL 行后我们主动杀的，exit 是预期结果
			} else {
				rejectBoot(new Error(`seed Host 提前退出：${out.slice(-600)}`));
			}
		});
	});
	// 后处理：暂存插件的 file: 依赖是构建机绝对路径（pnpm 安装时写入 package.json / lockfile），
	// 搬到用户机器上会断。改写成 profile 相对路径——暂存目录就在 profile 里（.vssaros/plugins/），
	// 相对写法天然可搬运。
	const seedPrefix = profileDir.replace(/\\/g, '/');
	let rewritten = 0;
	for (const f of ['package.json', 'pnpm-lock.yaml']) {
		const p = join(profileDir, f);
		if (!existsSync(p)) {
			continue;
		}
		const text = readFileSync(p, 'utf8');
		const fixed = text.replaceAll(`file:${seedPrefix}/`, 'file:');
		if (fixed !== text) {
			const { writeFileSync: wf } = await import('node:fs');
			wf(p, fixed);
			rewritten++;
		}
	}
	console.log(`[prepack-dsh] seed path rewrite: ${rewritten} file(s) de-absolutized`);
	writeFileSync(markerPath, JSON.stringify({ dsh: dshVersion, plugins: wantPlugins, createdAt: new Date().toISOString() }, undefined, 2));
	console.log(`[prepack-dsh] profile seed ready (${Math.round(dirSize(seed) / 1024 / 1024)} MB)`);
}

/** 裁剪重型可选负载（幂等：不存在即跳过）。 */
function prune(targetDir) {
	let prunedMB = 0;
	for (const rel of PRUNE_LIST) {
		const p = join(targetDir, ...rel);
		if (existsSync(p)) {
			const bytes = dirSize(p);
			rmSync(p, { recursive: true, force: true });
			prunedMB += bytes / 1024 / 1024;
			console.log(`[prepack-dsh] pruned ${rel.join('/')} (${Math.round(bytes / 1024 / 1024)} MB)`);
		}
	}
	if (prunedMB > 0) {
		console.log(`[prepack-dsh] pruned total: ${Math.round(prunedMB)} MB`);
	}
}

function dirSize(p) {
	let sum = 0;
	const stack = [p];
	while (stack.length) {
		const cur = stack.pop();
		for (const e of readdirSync(cur, { withFileTypes: true })) {
			const f = join(cur, e.name);
			if (e.isDirectory()) {
				stack.push(f);
			} else if (e.isFile()) {
				try { sum += statSync(f).size; } catch { /* 让位于竞态删除 */ }
			}
		}
	}
	return sum;
}
