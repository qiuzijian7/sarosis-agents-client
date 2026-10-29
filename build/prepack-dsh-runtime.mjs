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
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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

/**
 * 建种子（**绝不让它拦住出包**）：`dsh plugin add` 是直接 spawn `pnpm`（运行时不自带，2026-10-16
 * CI 现场：`'pnpm' is not recognized` ⇒ 种子建不出来），而 seed 只是**首启加速项**：
 * 缺它 ⇒ 首启自己装 profile（慢 1-2 分钟，且有 pnpm 的机器才装得上）。运行时本体才是硬性要求，
 * 所以这里任何失败都只告警、不让 prepack 失败（对比：安装/版本不符是真失败，见上面 exit(1) ✓）。
 */
async function safeBuildProfileSeed(runtimeDir, dshBin, dshVersion) {
	const how = ensurePnpm();
	if (!how) {
		console.log('[prepack-dsh] ⚠ 找不到 pnpm（PATH / corepack / npm -g 都不行）⇒ **跳过** profile 种子。'
			+ '⚠ 2026-10-28 起种子是**硬门**（verify-staging 缺它就判出包失败）——'
			+ '所以这不是"可接受地降级"，而是"这一包出不来"。'
			+ 'CI 上请让 install-deps 装一个（`.ci/scripts/install-deps.ps1` 已加）。');
		return;
	}
	console.log(`[prepack-dsh] pnpm OK（来自 ${how}）`);
	try {
		await buildProfileSeed(runtimeDir, dshBin, dshVersion);
	} catch (e) {
		const err = e;
		const first = String(err?.message ?? e).split('\n')[0];
		// ★ 2026-10-28：种子现在是**硬门**（verify-staging 缺它就判出包失败），所以失败必须能诊断。
		// 原写法只打第一行，而 `execFileSync` 的第一行是命令行，**真正原因在 stderr**（2026-10-28
		// CI 现场就只留下 `Command failed: … dsh plugin add file:…`，尾部的 pnpm 报错被吞了）。
		const tail = [err?.stderr, err?.stdout]
			.map(s => (typeof s === 'string' ? s : s ? String(s) : ''))
			.filter(Boolean).join('\n').trim().slice(-2000);
		console.log(`[prepack-dsh] ⚠ profile 种子构建失败：${first}`);
		console.log(`[prepack-dsh]   错误码=${err?.code ?? '?'} status=${err?.status ?? '?'} stderr=${(err?.stderr ?? '').length}B stdout=${(err?.stdout ?? '').length}B`);
		if (tail) {
			console.log(`[prepack-dsh]   失败输出（末尾 2000 字符）：\n${tail}`);
		} else {
			console.log(`[prepack-dsh]   （没有 stderr/stdout；完整 message 末尾 1500 字符）\n${String(err?.message ?? '').slice(-1500)}`);
		}
		// ★ 2026-10-28：dsh 的**启动诊断**在 `<seed>/logs/startup-*.log` —— 那是唯一说清"为什么退出"
		//   的地方；而下面要把半成品种子整个删掉 ⇒ 先读出来打出来、再把日志目录拷到 runtime 下留痕
		//   （CI 上失败时这台机器上的日志会被清掉，没有留痕就永远查不了）。
		try {
			const logsDir = join(runtimeDir, 'profile-seed', 'logs');
			if (existsSync(logsDir)) {
				const logs = readdirSync(logsDir).filter(f => f.startsWith('startup-') && f.endsWith('.log')).sort();
				if (logs.length) {
					console.log(`[prepack-dsh]   启动诊断（${logs[logs.length - 1]} 末尾 4000 字符）：\n${readFileSync(join(logsDir, logs[logs.length - 1]), 'utf8').slice(-4000)}`);
					const { cpSync, mkdirSync } = await import('node:fs');
					const dst = join(runtimeDir, 'seed-build-fail-logs');
					mkdirSync(dst, { recursive: true });
					cpSync(logsDir, dst, { recursive: true, force: true });
					console.log(`[prepack-dsh]   失败诊断已留痕：${dst}`);
				}
			}
		} catch { /* 留痕失败也不拦出包 */ }
		console.log('[prepack-dsh]   ⇒ 种子缺失：**本次出包会被 verify-staging 判失败**（2026-10-28 起种子是硬门）。'
			+ '修好上面的原因后重跑本脚本即可（运行时本体已就绪 ✓，重跑只补种子）。');
		// ★ 必须清掉半成品：宿主侧判"种子可用"只看 `profile-seed/profiles/<p>/package.json` 在不在
		//（`_profileSeedDir`）——而它就创建在建种子的早期 ⇒ 半成品会被当成好种子整目录拷进 DSH_HOME，
		// 用户拿到一个"缺依赖的 profile"（比没有种子更糟 ✗✗）。清掉 = 干净的"没种子"回退 ✓。
		removeTree(join(runtimeDir, 'profile-seed'));
		console.log('[prepack-dsh]   已清掉半成品种子（宁可没有，也不给一个装不起来的 profile）');
	}
}

/**
 * 保证 `pnpm` 可用（`dsh plugin add` 直接 spawn 它）。三级兜底，返回用上的那级（找不到 ⇒ undefined）：
 *   ① PATH 里已有；② `corepack enable pnpm`（Node ≥16 自带 corepack）；③ `npm i -g pnpm`
 *   （CI 里 npm 已指向内网镜像 `npm_config_registry` ⇒ 这条最可能成 ✓）。
 */
function ensurePnpm() {
	const win = process.platform === 'win32';
	const probe = () => {
		try {
			execFileSync(win ? 'pnpm.cmd' : 'pnpm', ['-v'], { stdio: 'pipe', shell: win });
			return true;
		} catch {
			return false;
		}
	};
	if (probe()) {
		return 'PATH';
	}
	try {
		execFileSync('corepack', ['enable', 'pnpm'], { stdio: 'pipe', shell: win });
		execFileSync('corepack', ['prepare', 'pnpm@latest', '--activate'], { stdio: 'pipe', shell: win });
		if (probe()) {
			return 'corepack';
		}
	} catch { /* 落到 ③ */ }
	try {
		const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
		const args = ['install', '-g', 'pnpm', '--no-audit', '--no-fund', '--loglevel=error'];
		if (existsSync(cli)) {
			execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' });
		} else {
			execFileSync(win ? 'npm.cmd' : 'npm', args, { stdio: 'pipe', shell: win });
		}
		if (probe()) {
			return 'npm -g';
		}
	} catch { /* 全失败 */ }
	return undefined;
}

if (existsSync(bin) && !force) {
	prune(target); // 已有安装也补跑裁剪（幂等），保证旧产物升级裁剪清单后不用重装
	// ★ 2026-10-28：**目录在 ≠ 版本对**。2026-10-28 本机现场：`dsh-runtime/0.2.1-rc.2/` 里的引擎
	//   自报 `0.2.1-alpha.3`（上游 rc.2 包里的引擎版本串没跟上）⇒ 它自带的官方插件声明 rc.2、
	//   引擎却是 alpha.3 ⇒ 每次装插件都被「版本闸门」拦（"to accept the risk…"）⇒ 种子建不出来。
	//   旧写法直接「跳过安装」⇒ 一份**名不副实**的运行时被静默复用 ⇒ 种子链路的锅没人找得到。
	//   ⇒ 这里核对自报版本，对不上就重装（并把失败原因留在日志里）。
	const actual0 = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim().split(/\r?\n/).pop();
	if (actual0 === version) {
		console.log(`[prepack-dsh] dsh ${version} 已在 ${target}，跳过安装（${Math.round(dirSize(target) / 1024 / 1024)} MB）`);
		await safeBuildProfileSeed(target, bin, version); // 种子缺失/过期时补建（失败不拦出包）
		process.exit(0);
	}
	console.log(`[prepack-dsh] ⚠ 已存在的安装自报版本 ${actual0} ≠ 期望 ${version} ⇒ 视为不可用，重装`);
	removeTreeOrThrow(target, '清掉版本不符的旧安装');
}
if (existsSync(target)) {
	// bin 缺失但目录还在 ⇒ 上次装到一半 ⇒ 删干净重来（否则 npm 会把它当已装）
	removeTreeOrThrow(target, '清掉不可用的旧安装');
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
	removeTree(target);
	console.error(`[prepack-dsh] 版本不符：期望 ${version}，实际 ${actual}`);
	process.exit(1);
}

prune(target);
console.log(`[prepack-dsh] done: dsh ${actual} ready at ${target} (${Math.round(dirSize(target) / 1024 / 1024)} MB)`);

// ─── profile 种子（真正消掉首启等待）──────────────────────────────────────
// 冷启动的大头不是装 dsh，而是首启时 web 模板 + 伴生插件的 pnpm 下载。
// 这里在构建期把 profile 完整建好（copy 导入模式 → node_modules 是真实文件、可搬运），
// 首启时 supervisor 整目录复制到 DSH_HOME——秒级完成，零网络。
// ⚠ 失败只告警不拦出包（见 `safeBuildProfileSeed`：运行时本体才是硬性要求）。
await safeBuildProfileSeed(target, bin, actual);

/**
 * `dsh-plugins/` 下的**全部随包插件目录**（数量不硬编码：凡包名 `@vssaros/*` 或 `@tt-a1i/*` 的目录全收。
 * 2026-10-28 实测仓库 33 个，而旧种子里只有 26 个 —— 这类偏差现在会被 `seedPluginGaps` 点名）。
 *
 * ⚠ 判据不能只看 `vssaros.module`（2026-10-19 现场）：patch 型插件（`cordis.patch.yml` 插一行，
 *   **没有** `vssaros.module`）同样必须进种子 —— 尤其 `vssaros-foundation`：它是所有模块插件的
 *   共享服务（`dataRoot` / `dshHome` / `pageShell` / `lock` 的唯一真源），消费者的
 *   `lib/foundationRef.js` 在它缺席时**直接抛**"vssaros-foundation 服务未绑定"；`vssaros-kb-refs`
 *   缺席则聊天框没有「@知识库」，`vssaros-browser` / `vssaros-unreal` 缺席则那两族工具静默消失。
 *   而种子的意义就是**首启零下载**（首启走 `dsh plugin add` 需要 pnpm，用户机器上不一定有 ✗）。
 *
 * 宿主侧的权威清单在 `dshHostSupervisor`（`DSH_*_PLUGIN_NAME` + 模块插件自发现）；构建脚本不能
 * import TS ⇒ 这里按"仓库里自称 `@vssaros/*` / `@tt-a1i/*`（vendored）的插件目录"全收，
 * 宁可多带（装着但不被 patch 插入 ⇒ 不激活，无副作用）也**不许漏**。
 * `dshPluginPackages.test.ts` 有一条守卫把两边清单逐名对齐（漂移即红）。
 */
function discoverRepoPluginDirs(baseDir) {
	const out = [];
	let entries;
	try {
		entries = readdirSync(baseDir, { withFileTypes: true });
	} catch {
		return out;
	}
	const skipped = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const dir = join(baseDir, entry.name);
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
			const name = typeof pkg?.name === 'string' ? pkg.name : '';
			// `@vssaros/*` = 自家插件；`@tt-a1i/archify-dsh` = vendored 第三方技能包（宿主也随包装）
			if (name.startsWith('@vssaros/') || name.startsWith('@tt-a1i/')) {
				out.push(dir);
			} else {
				// ★ 2026-10-28：有 package.json 却没被收 ⇒ **点名**。新增插件若忘了用 `@vssaros/*`
				//   命名，它会静默缺席种子（首启再补装需要 pnpm，用户机器上不一定有 ✗）。
				skipped.push(`${entry.name}（包名 ${name || '空'}）`);
			}
		} catch { /* 不是包 / 读不动 ⇒ 跳过（与宿主侧同口径） */ }
	}
	if (skipped.length) {
		console.log(`[prepack-dsh] ⚠ dsh-plugins 下这些目录有 package.json 但没进种子（包名须是 @vssaros/* 或 @tt-a1i/*）：${skipped.join(', ')}`);
	}
	// 确定性顺序（marker 比对用 JSON.stringify，必须稳定）。foundation 排第一：它是所有消费者的
	// 依赖（宿主安装清单里也刻意放在模块插件之前，见 `dshHostSupervisor` 的注释）。
	return out.sort((a, b) => {
		const fa = a.endsWith(`${sep}vssaros-foundation`) ? 0 : 1;
		const fb = b.endsWith(`${sep}vssaros-foundation`) ? 0 : 1;
		return fa - fb || a.localeCompare(b);
	});
}

/**
 * 种子**实际覆盖**核对：把 `wantPlugins`（= 仓库全部随包插件）与 `profileDir/node_modules` 里
 * 真实装上的 package.json 逐个对账，返回「缺 / 版本不符」的名字列表（空数组 = 全覆盖）。
 *
 * 为什么要它（2026-10-28）：种子只按 marker 判定"已是最新"时，**磁盘与 marker 可能不一致**
 * （本机实测：marker 26 个、仓库已 33 个；两个插件目录还曾被删空过）。种子少一个 ⇒ 用户首启
 * 走 `dsh plugin add` 补装 ⇒ 需要 pnpm（用户机器不一定有）⇒ 「首启零下载」直接破功，而且**没有任何报错**。
 * ⇒ 这里把它们变成构建期的显式失败/显式点名。
 */
function seedPluginGaps(profileDir, wantPlugins) {
	const gaps = [];
	for (const [name, version] of Object.entries(wantPlugins)) {
		const manifest = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
		let actual;
		try {
			actual = JSON.parse(readFileSync(manifest, 'utf8')).version;
		} catch { /* 缺文件 / 空白 */ }
		if (!actual) {
			gaps.push(`${name}（缺）`);
		} else if (String(actual) !== String(version)) {
			gaps.push(`${name}（应 ${version}，实为 ${actual}）`);
		}
	}
	return gaps;
}

/** 在 <target>/profile-seed 里建好 vssaros profile（含伴生插件 + 全部模块插件 + web 模板依赖）。 */
async function buildProfileSeed(runtimeDir, dshBin, dshVersion) {
	const { cpSync, mkdirSync, writeFileSync } = await import('node:fs');
	const seed = join(runtimeDir, 'profile-seed');
	const profileDir = join(seed, 'profiles', 'vssaros');
	const markerPath = join(seed, 'seed.json');
	const pluginSources = [
		// 仓库侧**全部**随包插件（模块插件 + patch 型伴生插件 + vendored），foundation 已排第一 ✓。
		// ⚠ 2026-10-19：这里原先只收 `vssaros.module` ⇒ foundation / kb-refs / browser / unreal /
		//   archify 全漏（种子装上后那些插件一激活就抛"foundation 服务未绑定"✗）。
		...discoverRepoPluginDirs(join(root, 'dsh-plugins')),
		// dsh 运行时自带的**官方 bundle**（随 dsh 版本分发，仓库里没有）：web-app + 语音输入 + 调度。
		// 与宿主 `DSH_WEB_APP_BUNDLE_NAME` / `DSH_VOICE_BUNDLE_PLUGIN_NAME` / `DSH_SCHEDULE_BUNDLE_PLUGIN_NAME`
		// 同一批；漏了它们首启要 `dsh plugin add`（**需 pnpm**）⇒ "首启零下载"就破了 ✗✗。
		// ⚠ web-app 尤其不能漏：它提供 `webServer` / `connection` 两个服务，缺了 bridge / chat-surface /
		//   codebase / memory 全部永远 pending ⇒ Host 直接退出 code 1（见 `dshHostSupervisor` 的注释）。
		join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-web-app'),
		join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-experimental-voice-input-bundle'),
		join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-experimental-schedule-bundle'),
	].filter(p => existsSync(join(p, 'package.json')));
	const wantPlugins = {};
	for (const src of pluginSources) {
		const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
		wantPlugins[pkg.name] = pkg.version;
	}
	if (existsSync(markerPath)) {
		const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
		if (marker.dsh === dshVersion && JSON.stringify(marker.plugins) === JSON.stringify(wantPlugins) && existsSync(join(profileDir, 'package.json'))) {
			// ★ 2026-10-28：marker 只说明"上次建的时候清单是这个"，**不说明磁盘上真有**。
			//   实测（本机 0.2.1-rc.1 种子）：marker 26 个插件、仓库已 33 个，两个插件目录曾被删空过，
			//   而 marker 与清单恰好一致 ⇒ 永不自愈 ⇒ 装机后首启还要 `dsh plugin add`（需 pnpm）✗。
			//   ⇒ 命中 marker 之后**仍要按磁盘对账**，缺一个/版本不符就重建（而不是"已是最新"）。
			const gaps = seedPluginGaps(profileDir, wantPlugins);
			if (gaps.length === 0) {
				console.log('[prepack-dsh] profile seed 已是最新，跳过');
				return;
			}
			console.log(`[prepack-dsh] seed marker 说已最新，但磁盘对不上 ${gaps.length} 个 ⇒ 重建：${gaps.join(', ')}`);
		}
	}
	console.log('[prepack-dsh] building profile seed（约 1–3 分钟，仅构建期一次性）…');
	removeTreeOrThrow(seed, 'dsh 要求 profile 目录不存在，由它自己创建'); // 种子里的 node_modules 很深 ⇒ 必须走扩展长度删除
	// copy 导入模式：node_modules 是真文件而不是指向 pnpm store 的链接——否则搬不走。
	const env = { ...process.env, DSH_HOME: seed, npm_config_package_import_method: 'copy' };
	/**
	 * dsh 的插件管理器有「版本闸门」：插件声明的 dsh 版本与运行时不一致时，`dsh plugin add` 会拒绝，
	 * 并在 stderr 里给出补救命令：
	 *   `dsh: to accept the risk, run: dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <v> --accept-risk`
	 * 2026-10-28 实测（本地与 CI 同一处）：我们自己的 `@vssaros/dsh-agents` 声明的
	 * `@deepseek-ai/dsh-agent-preset` 版本与 web 模板装出来的不一致 ⇒ 种子建不出来 ⇒ 整包出不来。
	 * ⇒ 自动接受并重试一次。**接受记录落在 profile 里**（DSH_HOME=seed）⇒ 随种子带到用户机器，
	 *    用户首启不会再撞这道闸门。
	 */
	const acceptVersionGate = (text) => {
		const m = /allow-version\s+(\S+)\s+--dsh-version\s+(\S+)/.exec(text ?? '');
		return m ? { pkg: m[1], dshVersion: m[2] } : undefined;
	};
	const dshRun = args => execFileSync(process.execPath, [dshBin, ...args], { env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	/** 已接受的版本豁免（package@version → dsh 版本），用于日志与去重。 */
	const acceptedVersionGates = new Map();
	const dsh = args => {
		// 一个种子里有 35 个插件，而官方 bundle（web-app）会带进**几十个** dsh-* 包，
		// 它们各自声明的 dsh 版本（alpha.3）与运行时（rc.2）不一致 ⇒ 每装一个撞一道闸门。
		// ⇒ 循环「接受 → 重试」直到不再有闸门（上限 400，够覆盖整棵官方包树）。
		let lastErr;
		for (let attempt = 0; attempt < 400; attempt++) {
			try {
				return dshRun(args);
			} catch (e) {
				lastErr = e;
				const text = `${e?.stderr ?? ''}\n${e?.stdout ?? ''}\n${e?.message ?? ''}`;
				const gate = acceptVersionGate(text);
				if (!gate) {
					throw e;
				}
				if (acceptedVersionGates.has(gate.pkg)) {
					// 同一个包又撞了 ⇒ 再接受一次没有意义（多半是另一个原因），把原始错误抛出去
					throw e;
				}
				acceptedVersionGates.set(gate.pkg, gate.dshVersion);
				console.log(`[prepack-dsh] dsh 版本闸门：接受 ${gate.pkg}（--dsh-version ${gate.dshVersion}）后重试（第 ${acceptedVersionGates.size} 次）`);
				dshRun(['plugin', '--profile', 'vssaros', 'allow-version', gate.pkg, '--dsh-version', gate.dshVersion, '--accept-risk']);
			}
		}
		throw lastErr ?? new Error('dsh 调用失败（版本闸门重试次数用尽）');
	};

	dsh(['--profile', 'vssaros', '--from-default-profile', 'web', '--help']);
	if (!existsSync(join(profileDir, 'package.json'))) {
		throw new Error('profile 初始化失败（seed）');
	}
	// ★ 2026-10-29（CI 现场）：pnpm 10+ 默认**禁止依赖的 install 脚本**，并且把「有 build script
	//   但没 approve」当成**错误**（ERR_PNPM_IGNORED_BUILDS）⇒ `dsh plugin add` 直接失败
	//   ⇒ profile 种子建不出来（CI 实测卡在 koffi@3.1.1）⇒ 产物缺种子 ⇒ verify-staging 判死。
	//   ⇒ 在 profile 的 package.json 里显式列出允许构建的依赖。
	//   ★ 这个字段**随种子带到用户机器** ⇒ 用户在「插件中心/页面里装插件」时也不会再被这道闸门拦
	//     （用户侧的同类失败此前无人注意过：pnpm 只在报错时才提示）。
	const APPROVED_BUILD_DEPS = ['koffi', 'esbuild', 'better-sqlite3', 'sharp'];
	try {
		const pkgPath = join(profileDir, 'package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		pkg.pnpm = { ...(pkg.pnpm ?? {}), onlyBuiltDependencies: APPROVED_BUILD_DEPS };
		writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n');
		console.log(`[prepack-dsh] profile 已放行 ${APPROVED_BUILD_DEPS.length} 个依赖的 install 脚本（pnpm.onlyBuiltDependencies）`);
	} catch (e) {
		console.log(`[prepack-dsh] ⚠ 写 pnpm.onlyBuiltDependencies 失败（pnpm 10+ 可能因此拦下种子构建）：${String(e?.message ?? e).split('\n')[0]}`);
	}
	for (const src of pluginSources) {
		const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
		// 与运行时 supervisor._stagePlugin 同构：暂存到 profile 内再装（避开跨盘符 file: 坑）。
		const flat = pkg.name.replace(/^@/, '').replace(/\//g, '-');
		const staged = join(profileDir, '.vssaros', 'plugins', `${flat}-${pkg.version}`);
		removeTree(staged);
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
	// ★ 安全（2026-10-17）：上面那次"试启动"会在种子里生成 `.credentials.yaml`
	// （`client-connection/browser-session` 的 kind=grant 记录）——**绝不能烘进安装包**：
	// 所有用户的种子会共用同一个 grant 密钥，且它是构建机的产物。
	// 实测（隔离副本）：删掉后 Host 照常启动、首启**自己重建**该文件 ✓ ⇒ 只删、不需要补。
	const seedCreds = join(seed, '.credentials.yaml');
	if (existsSync(seedCreds)) {
		rmSync(seedCreds, { force: true });
		console.log('[prepack-dsh] seed credentials scrubbed（首启自生成 ✓）');
	}
	// ★ 2026-10-28：种子里的 node_modules 是 pnpm **平铺**出来的依赖闭包 ⇒ 官方包的
	//   **可选**依赖（libreoffice 内核 ≈182MB）会被一起装进来 —— 而运行时那边我们明明裁掉了
	//   （PRUNE_LIST）。不裁的后果实测：种子 417MB ≈ 运行时 522MB ⇒ 体积翻倍。
	//   ⇒ 种子用**同一份** PRUNE_LIST 裁一遍（口径一致：wrapper 留着，只删平台内核）。
	prune(profileDir, 'profile seed');
	for (const rel of PRUNE_LIST) {
		const p = join(profileDir, ...rel);
		if (existsSync(p)) {
			console.log(`[prepack-dsh] ⚠ 种子里的 ${rel.join('/')} 没裁掉（还在包里 ⇒ 包会大 ${Math.round(dirSize(p) / 1024 / 1024)} MB；`
				+ '发布守卫 check-dsh-release.mjs 会把它报成问题）');
		}
	}
	// ★ 2026-10-28：**先对账再写 marker** —— 写早了等于给一个残缺种子盖章"已是最新"。
	//   装不上的插件上面已经 throw；这里挡的是"装上了但数量/版本对不上清单"的那类（例如清单在
	//   构建中途变化、或 pnpm 把某个 file: 依赖当成没变化而跳过替换）。
	const seedGaps = seedPluginGaps(profileDir, wantPlugins);
	if (seedGaps.length) {
		throw new Error(`profile seed 不完整（${seedGaps.length}/${Object.keys(wantPlugins).length} 个插件没到位）：${seedGaps.join(', ')}`);
	}
	writeFileSync(markerPath, JSON.stringify({ dsh: dshVersion, plugins: wantPlugins, createdAt: new Date().toISOString() }, undefined, 2));
	console.log(`[prepack-dsh] profile seed ready (${Math.round(dirSize(seed) / 1024 / 1024)} MB)；覆盖全部 ${Object.keys(wantPlugins).length} 个随包插件 ✓`);
	if (acceptedVersionGates.size) {
		// 这些豁免**落在 profile 里**（DSH_HOME=seed）⇒ 随种子带到用户机器，用户首启不再撞版本闸门。
		console.log(`[prepack-dsh] 版本豁免 ${acceptedVersionGates.size} 条（已写入 profile）：${[...acceptedVersionGates.keys()].slice(0, 8).join(', ')}${acceptedVersionGates.size > 8 ? ' …' : ''}`);
	}
}

/**
 * 裁剪重型可选负载（幂等：不存在即跳过）。
 *
 * ⚠ **裁剪失败绝不能拖垮构建**（2026-10-16 生产：CI 上删 LibreOffice 内核时 `ENOTEMPTY`
 * 未捕获抛出 ⇒ prepack 进程崩 ⇒ 打包链在 gulp 之前中止 ⇒ 上传出去的安装包仍是"上次残留的暂存目录"
 * 打出来的（不含 dsh 运行时）⇒ 用户装完还是「找不到 dsh」✗✗）。裁掉的只是 ~182MB 的可选内核：
 * 删不掉就让包大一点，**不许**因此不出包。
 *
 * ★ 2026-10-28：**运行时与 profile 种子要裁同一份清单**。种子里的 node_modules 是 pnpm
 *   **平铺**出来的依赖闭包 ⇒ 官方包的 optionalDependencies（libreoffice 内核 ≈182MB）会被装进
 *   种子 —— 而运行时那边我们明明裁掉了。不裁的后果实测：种子 417MB ≈ 运行时 522MB ⇒ 体积翻倍。
 */
function prune(targetDir, label = 'runtime') {
	let prunedMB = 0;
	for (const rel of PRUNE_LIST) {
		const p = join(targetDir, ...rel);
		if (!existsSync(p)) {
			continue;
		}
		const bytes = dirSize(p);
		if (removeTree(p)) {
			prunedMB += bytes / 1024 / 1024;
			console.log(`[prepack-dsh] pruned ${label}: ${rel.join('/')} (${Math.round(bytes / 1024 / 1024)} MB)`);
		} else {
			console.log(`[prepack-dsh] ⚠ 裁剪失败（保留原样，包会大约 ${Math.round(bytes / 1024 / 1024)} MB）：${label} ${rel.join('/')}`);
		}
	}
	if (prunedMB > 0) {
		console.log(`[prepack-dsh] pruned total (${label}): ${Math.round(prunedMB)} MB`);
	}
}

/**
 * 删目录：**不抛**。返回是否删干净。三步兜底（Windows 上递归删的重灾区）：
 *   ① `rmSync(recursive)` 带重试（杀软/索引器短暂占用，重试常能过）；
 *   ② 加 `\\?\` 扩展长度前缀再删 —— CI（Windows Server 2016，未开 LongPathsEnabled）最深那层
 *      `…\libreoffice-kit-win32-x64\program\share\config\soffice.cfg\…` 会超 MAX_PATH，
 *      `rmdir` 直接 `ENOTEMPTY`（2026-10-16 那次崩溃的现场就是这个 ✗）；前缀绕过 260 上限 ✓；
 *   ③ 仍失败 ⇒ 尽力而为：**把整目录改名到 `*.deleting-<pid>` 挪开**（rename 只要目标同级就行，
 *      不受深层路径影响）——挪走后调用方看到的目标就不在了 ✓，残留目录由下次构建或人工清理。
 */
function removeTree(abs) {
	// ① 普通递归删（`maxRetries` 覆盖"杀软/索引器短暂占用"）
	try {
		rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		if (!existsSync(abs)) {
			return true;
		}
	} catch { /* 落到 ② */ }
	// ② 扩展长度前缀（绕过 MAX_PATH；CI 上那层 soffice.cfg 超 260 字符 ⇒ 上面必然 ENOTEMPTY）
	try {
		const long = toExtendedLengthPath(abs);
		rmSync(long, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		if (!existsSync(abs)) {
			return true;
		}
	} catch { /* 落到 ③ */ }
	// ③ 删不掉就挪开（rename 不受深层路径影响）——对调用方来说"目标已不存在"就够了
	try {
		const aside = `${abs}.deleting-${process.pid}`;
		renameSync(abs, aside);
		console.log(`[prepack-dsh] 目录删不掉，已挪开：${aside}（可由下次构建或人工清理）`);
		return true;
	} catch {
		return false;
	}
}

/** 与 removeTree 同一套兜底，但**必须删干净**（目标不可用于调用方时用）。 */
function removeTreeOrThrow(abs, what) {
	if (!removeTree(abs)) {
		throw new Error(`无法删除 ${abs}（${what}）——请手工作业后重试`);
	}
}

/** Windows 扩展长度路径前缀（绕过 MAX_PATH；`\\?\` 只能用在**绝对**且已规范化**的路径上）。 */
function toExtendedLengthPath(abs) {
	if (process.platform !== 'win32') {
		return abs;
	}
	const resolved = resolve(abs);
	if (resolved.startsWith('\\\\?\\')) {
		return resolved;
	}
	if (resolved.startsWith('\\\\')) {
		return `\\\\?\\UNC${resolved.slice(1)}`;
	}
	return `\\\\?\\${resolved}`;
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
