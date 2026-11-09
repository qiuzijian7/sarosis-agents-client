/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 运行时解析：定位 Node 与**唯一的内置 dsh**（方案第 3.2 节，2026-11-09 收敛）。
 *
 * 只依赖 Node 内置模块与 vs/base，不 import electron —— 可在纯 Node 下做集成测试。
 *
 * P0-2 结论：不能用 VsSaros 自带的 Electron 以 ELECTRON_RUN_AS_NODE 运行 dsh
 * （`node-addon-require-builtin` 只认 Electron ≥43，VsSaros 为 39.8.8），因此 Node 必须是独立的。
 *
 * ★★ 2026-11-09：**收敛成单版本模型**（对标开源 dsh-desktop / Dataelem）。
 *   原先这里管理 `<userData>/dsh-runtime/<version>/` 的**多版本池**：并列安装、`state.json`
 *   的 `current` 指针、history 回滚、升级闸门快照、按版本重建 profile。产品已明确不需要
 *   「用户自由切 runtime」，那一整套机制正是 11-07 / 11-09 两次 F5 崩溃的来源。
 *   现在：
 *     · dsh 只有一个来源 —— 构建期 prepack 到 `bundledRoot/<bundledPin>/` 的那份；
 *     · 版本由 `dsh-plugins/dsh-compat.json` 的 `bundled` **构建期 pin 死**，运行期只认它，
 *       目录里残留别的版本一律不看；缺了就报「安装包不完整」，不退回"取最高"；
 *     · 版本升级 = 应用发版；`userData/dsh-home` **永不覆盖**（见 `_ensureProfile`）；
 *     · `managedRoot` 只剩一个用途：托管便携 Node 的安装根（用户机器没装 Node 时）。
 *   ⇒ 不再读写 `state.json`，不再有 `current` / `history` / `install()` / `setCurrent()`。
 */

import { execFile } from 'child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from '../../../../base/common/path.js';
import { isRuntimeVersionDir, isSupportedNodeVersion } from '../common/dshCli.js';
import { DshErrorCode, IDshRuntimeInfo } from '../common/dshHarness.js';
import { runtimeInstallMissing } from '../common/dshRuntimeInstall.js';
import { FetchLike, installManagedNode, INodeInstallResult, managedNodePath } from './dshNodeInstaller.js';

const DSH_PKG_BIN = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];
const isWindows = process.platform === 'win32';

/** 带错误码的运行时错误：界面据错误码给出对应的修复按钮（安装 Node / 安装 dsh）。 */
export class DshRuntimeError extends Error {
	constructor(readonly code: DshErrorCode, message: string) {
		super(message);
	}
}

export interface IResolvedNode {
	/** 绝对路径（PATH 中的 node 也会解析为 `process.execPath`），用于定位随附的 npm。 */
	readonly path: string;
	readonly version: string;
	readonly source: 'setting' | 'managed' | 'path';
}

export interface IResolvedDsh {
	readonly bin: string;
	readonly version: string;
	/**
	 * `bundled` = 安装包内置（构建期 pin 到 `<appPath>/dsh-runtime/<version>`，见 build/prepack-dsh-runtime.mjs）。
	 * `setting` 只是**显式排障开关** `sessions.dshHarness.runtimePath`：不参与产品版本管理，
	 * 默认永远不会命中；产品路径 100% 是 bundled。
	 */
	readonly source: 'setting' | 'bundled';
}

export interface IRuntimeLog {
	(line: string): void;
}

/**
 * 环回地址必须绕过代理（★ 2026-10-16，借对照样本 `deepseek-harness-for-vscode` 的同名做法）。
 *
 * 为什么要有：Host 的插件页是经 `http://127.0.0.1:<port>/…` 加载的 ⇒ 用户环境里若配了系统代理
 * （Clash 一类）而 `NO_PROXY` 没排除环回，请求会被代理**劫持** ⇒ 页面白屏 / `/x/...` 全 404，
 * 而日志里看不出是代理干的 ✗（样本项目专门为此强制了这条）。
 *
 * 语义是**追加**而不是覆盖：用户已有条目原样保留（不夺用户的设置权 ✓）；`NO_PROXY=*`（全绕）
 * 视为已满足 ✓。
 */
export const LOOPBACK_NO_PROXY = ['127.0.0.1', 'localhost', '::1'] as const;

/**
 * 保证 env 的 `NO_PROXY` 覆盖环回；原地改并返回同一个对象。
 *
 * ⚠ Windows 的环境变量名**大小写不敏感** ⇒ 同一件事可能同时存在 `NO_PROXY` 与 `no_proxy` 两个键
 * （`extra` 里换个大小写写就会造出来）⇒ 这里先**合并成一个键**，否则 spawn 出去的子进程里两条都在、
 * 谁生效说不清 ✗。
 */
export function ensureLoopbackNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const keys = Object.keys(env).filter(k => k.toLowerCase() === 'no_proxy');
	const primary = keys[0] ?? 'NO_PROXY';
	const entries: string[] = [];
	for (const key of keys) {
		for (const raw of String(env[key] ?? '').split(',')) {
			const entry = raw.trim();
			if (entry !== '' && !entries.some(x => x.toLowerCase() === entry.toLowerCase())) {
				entries.push(entry);
			}
		}
	}
	for (const key of keys.slice(1)) {
		delete env[key];
	}
	const lowered = entries.map(e => e.toLowerCase());
	if (!lowered.includes('*')) {
		for (const token of LOOPBACK_NO_PROXY) {
			if (!lowered.includes(token)) {
				entries.push(token);
			}
		}
	}
	env[primary] = entries.join(',');
	return env;
}

/** 产物自带的 pnpm 单文件 bundle（打包版才有；dev 侧返回 undefined）。 */
function bundledPnpmEntry(): string | undefined {
	const res = (process as unknown as { resourcesPath?: string }).resourcesPath;
	if (!res) {
		return undefined;
	}
	// 打包版：<安装根>/resources/app/tools/pnpm/（由 build/saros/ensure-pnpm-tool.mjs 落位）。
	// ★ 2026-11-07：pnpm 11.28.5 不再是单文件 bundle —— `bin/pnpm.mjs` 会动态 import
	//   `dist/pnpm.mjs`，且还要 `dist/node_modules` / `dist/vendor` 等 ⇒ 整包随附。
	//   两个文件都在才认（只拷 bin 会 ERR_MODULE_NOT_FOUND）。
	const dir = join(res, 'app', 'tools', 'pnpm');
	const entry = join(dir, 'bin', 'pnpm.mjs');
	return existsSync(entry) && existsSync(join(dir, 'dist', 'pnpm.mjs')) ? entry : undefined;
}

/** PATH 里是否已经有 pnpm（有就尊重用户环境，不注入自带的）。 */
function hasPnpmOnPath(pathValue: string): boolean {
	const names = isWindows ? ['pnpm.cmd', 'pnpm.exe', 'pnpm.bat'] : ['pnpm'];
	for (const dir of pathValue.split(delimiter)) {
		if (!dir) {
			continue;
		}
		for (const name of names) {
			if (existsSync(join(dir, name))) {
				return true;
			}
		}
	}
	return false;
}

/**
 * 把**产物自带**的 pnpm 前置到子进程 PATH（仅当系统没有 pnpm 时才做）。
 *
 * ★★ 2026-10-29（真机：别人机器上 `'pnpm' 不是内部或外部命令` ⇒ 35 个随包插件全没装上 ⇒
 *   界面只剩 dsh 官方页）：
 *   · 「启动时装插件」已有**直装兜底**（不依赖 pnpm，实测 35/35、4.3 秒）；
 *   · 但**运行时**仍要用 pnpm（页面里装第三方插件/技能、`dsh plugin add`）⇒ 产物必须自带一份。
 *
 * 实现要点（2026-11-07 起）：产物自带的是**仓库 pin 的 pnpm@11.28.5 整包**（约 21MB，
 * 入口 `bin/pnpm.mjs` → `dist/pnpm.mjs`），版本与构建期 prepack 用的那份同源。
 * shim 用 **Host 自己的 `node.path`** 跑它 ⇒ 用户机器**不需要装 node**（dshNodeInstaller 会托管
 * 一个 ≥22.19 的 Node，满足 pnpm 11 的 ≥22.13 门槛）✓。
 *
 * ⚠ 与本文件顶部"不能用 Electron 跑 dsh"那条结论**不矛盾**：那条限制是 dsh 需要
 *   `node-addon-require-builtin`（Electron 39 不支持）；pnpm 是**纯 JS**，不碰那个能力 ✓。
 */
export function injectBundledPnpm(env: NodeJS.ProcessEnv, nodeExe: string | undefined): void {
	const entry = bundledPnpmEntry();
	if (!entry || !nodeExe) {
		return;
	}
	const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
	const current = env[key] ?? '';
	if (hasPnpmOnPath(current)) {
		return; // 系统已有 pnpm ⇒ 尊重用户环境
	}
	try {
		const dir = join(tmpdir(), 'vssaros-pnpm-shim');
		mkdirSync(dir, { recursive: true });
		// 每次启动都重写（tmp 可能被清理；幂等且只有几百字节）
		//
		// ⚠ **必须用真正在用的那个 node**（`node.path`），不能用 Electron 顶替：
		//   实测 Electron 39 的 node 跑 pnpm `--version` 没问题，但 `pnpm install` 装到
		//   `added 513` 时**直接崩掉**（并发安装阶段不够用）✗✗。
		//   而"别人机器没有 node"这件事由 `dshNodeInstaller` 兜着：没 node 就跑不了 dsh，
		//   所以 Host 起来时 `node.path` **一定**是可用解释器（托管安装的或系统的）✓。
		//   pnpm 11.28.5 还要求 Node ≥22.13，托管 Node 的门槛是 22.19+ ⇒ 满足 ✓。
		if (isWindows) {
			writeFileSync(
				join(dir, 'pnpm.cmd'),
				'@echo off\r\n"' + nodeExe + '" "' + entry + '" %*\r\n',
				'utf8',
			);
		} else {
			writeFileSync(
				join(dir, 'pnpm'),
				'#!/bin/sh\n"' + nodeExe + '" "' + entry + '" "$@"\n',
				{ mode: 0o755 },
			);
		}
		env[key] = dir + delimiter + current;
	} catch {
		// shim 建不起来 ⇒ 不影响启动（启动装插件走直装兜底；只是运行时用不了 pnpm）
	}
}

/** 进程环境：去掉会改变子 Node 行为的变量（Electron 主进程里可能带着它们）。 */
export function sanitizedEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	for (const [k, v] of Object.entries(extra)) {
		if (v === undefined) {
			delete env[k];
		} else {
			env[k] = v;
		}
	}
	// 环回绕代理放在 `extra` 合并**之后**：即便调用方显式传了 `NO_PROXY`，也保证环回不被代理劫持 ✓。
	ensureLoopbackNoProxy(env);
	// ⚠ 产物自带的 pnpm 由调用方显式注入（`injectBundledPnpm(env, node.path)`）——
	//   这里拿不到"真正在用的 node"，而 shim 必须用那个 node（用 Electron 顶替会崩，见那边注释）。
	return env;
}

function run(file: string, args: readonly string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv; shell?: boolean; cwd?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		execFile(file, args as string[], {
			timeout: opts.timeout ?? 20_000,
			env: opts.env ?? sanitizedEnv(),
			windowsHide: true,
			shell: opts.shell,
			cwd: opts.cwd,
			maxBuffer: 16 * 1024 * 1024,
		}, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (err && !stderr ? String(err.message) : '') });
		});
	});
}

export class DshRuntimeManager {

	constructor(
		/** 用户数据根：收敛后只剩「托管便携 Node」一个用途（`<userData>/dsh-runtime/node/`）；不再是 dsh 版本池。 */
		readonly managedRoot: string,
		private readonly _log: IRuntimeLog,
		/** 内置运行时根目录（打包版 `<appPath>/dsh-runtime`；dev 由 channel 向上回退到仓库根 `dsh-runtime`）。 */
		readonly bundledRoot?: string,
		/** 构建期 pin 的唯一版本（`dsh-plugins/dsh-compat.json` 的 `bundled`）。 */
		private readonly _bundledVersionPin?: string,
	) { }

	/** 构建期 pin 的版本；单版本模型下它就是「当前版本」，没有第二个候选。 */
	get bundledVersion(): string | undefined {
		return this._bundledVersionPin?.trim() || undefined;
	}

	/**
	 * 校验并返回**唯一**可用的内置版本。
	 *
	 * ★ 不再「目录里取最高」：包里残留更高但没进 compat 清单的版本一律不看
	 *   （2026-10-28 真机踩过：rc.1 + rc.2 并存时跑到了没验证过的那个）。
	 *   pin 缺、目录名非法、bin 缺 ⇒ **硬失败**，让构建期漏件显形，而不是悄悄降级。
	 *   构建期由 `build/saros/check-dsh-release.mjs` 保证包内只有 pin 的这一个版本。
	 */
	private _requireBundled(): { version: string; dir: string; bin: string } {
		const version = this.bundledVersion;
		if (!version || !isRuntimeVersionDir(version)) {
			throw new DshRuntimeError('dsh-missing', `安装包未声明有效的 bundled dsh 版本（dsh-plugins/dsh-compat.json 的 bundled）：${version ?? '(空)'}`);
		}
		if (!this.bundledRoot) {
			throw new DshRuntimeError('dsh-missing', `找不到内置运行时目录（bundledRoot 为空）；bundled ${version} 随应用发版，请重新安装本应用`);
		}
		const dir = join(this.bundledRoot, version);
		const bin = toLongPath(join(dir, ...DSH_PKG_BIN));
		if (!existsSync(bin)) {
			throw new DshRuntimeError('dsh-missing', `安装包不完整：缺少内置 dsh ${version}（${bin}）。请重新安装本应用`);
		}
		return { version, dir, bin };
	}

	/** UI 展示用。**保留字段形状**以兼容既有调用方：单版本模型下 current / installed 都只是 bundled 版本。 */
	getInfo(activeBin?: string): IDshRuntimeInfo {
		const v = this.bundledVersion;
		return { managedRoot: this.managedRoot, current: v, installed: v ? [v] : [], activeBin };
	}

	// ─── 解析 ────────────────────────────────────────────────────────────────

	/**
	 * 顺序：设置项 → 托管 Node → PATH。托管 Node 排在 PATH 之前：用户机器上的 node 版本不可控，
	 * 托管的那份由 VsSaros 安装并自检过。
	 */
	async resolveNode(settingPath: string | undefined): Promise<IResolvedNode> {
		const candidates: { path: string; source: IResolvedNode['source'] }[] = [];
		if (settingPath?.trim()) {
			candidates.push({ path: settingPath.trim(), source: 'setting' });
		}
		const managed = managedNodePath(this.managedRoot);
		if (existsSync(managed)) {
			candidates.push({ path: managed, source: 'managed' });
		}
		candidates.push({ path: isWindows ? 'node.exe' : 'node', source: 'path' });

		const rejected: string[] = [];
		for (const c of candidates) {
			const r = await run(c.path, ['-p', 'process.version + "\\n" + process.execPath'], { timeout: 10_000 });
			const [version, execPath] = r.stdout.trim().split(/\r?\n/);
			if (r.code !== 0 || !version) {
				rejected.push(`${c.path}: 无法执行`);
				continue;
			}
			if (!isSupportedNodeVersion(version)) {
				rejected.push(`${c.path}: ${version} 低于 dsh 要求（22.19+ 或 24+）`);
				continue;
			}
			return { path: execPath?.trim() || c.path, version, source: c.source };
		}
		throw new DshRuntimeError('node-missing', `找不到可用的 Node：${rejected.join('；')}。可执行「DSH: 安装托管 Node」，或在设置 sessions.dshHarness.nodePath 中指定 Node 22.19+ / 24+。`);
	}

	/** 下载并安装托管便携 Node（`<managedRoot>/node/`）。 */
	installNode(fetchImpl: FetchLike, opts: { mirror?: string; version?: string } = {}): Promise<INodeInstallResult> {
		return installManagedNode({ managedRoot: this.managedRoot, fetch: fetchImpl, log: this._log, ...opts });
	}

	/**
	 * 解析 dsh（★ 2026-11-09 单版本模型）：**只有两条路**
	 *  ① `sessions.dshHarness.runtimePath` 显式覆盖 —— 仅排障用，不参与产品版本管理；
	 *  ② 构建期 pin 的**唯一内置版本** —— 产品默认，100% 命中。
	 * 不再有 managed 多版本池、`state.json` 指针、全局 npm 兜底。
	 */
	async resolveDsh(settingPath: string | undefined, node: IResolvedNode): Promise<IResolvedDsh> {
		if (settingPath?.trim()) {
			const bin0 = this._binFromSetting(settingPath.trim());
			if (!bin0) {
				throw new Error(`设置 sessions.dshHarness.runtimePath 指向的位置找不到 dsh：${settingPath}`);
			}
			const bin = toLongPath(bin0);
			return { bin, version: await this._probeDshVersion(node, bin), source: 'setting' };
		}

		const { version, dir, bin } = this._requireBundled();
		// 廉价文件体检（不 spawn）：2026-10-29 真机踩过「bin.js 在但 @deepseek-ai/dsh-app-boot
		// 是空目录」⇒ 一启动就 ERR_MODULE_NOT_FOUND，日志却只有"控制桥不可用"。
		const missing = runtimeInstallMissing(existsSync, dir);
		if (missing.length) {
			throw new DshRuntimeError('dsh-missing', `内置 dsh ${version} 不完整（缺 ${missing.join('、')}）：${dir}。请重新安装本应用`);
		}
		const probed = await this._probeDshVersion(node, bin);
		if (probed !== version) {
			this._log(`bundled dsh --version=${probed} 与构建期 pin=${version} 不一致 ⇒ 以 pin 为准（构建期校验应拦住）`);
		}
		this._log(`using bundled dsh ${probed} (${bin})`);
		// ⚠ 返回 **pin** 而不是 probed：`_profileSeedDir` 用 `dsh.version` 拼
		//   `dsh-runtime/<version>/profile-seed/`，必须与目录名严格一致，否则首启找不到种子。
		return { bin, version, source: 'bundled' };
	}

	private _binFromSetting(p: string): string | undefined {
		if (p.endsWith('.js')) {
			return existsSync(p) ? p : undefined;
		}
		for (const rel of [DSH_PKG_BIN, ['lib', 'bin.js']]) {
			const candidate = join(p, ...rel);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private async _probeDshVersion(node: IResolvedNode, bin: string): Promise<string> {
		const r = await run(node.path, [bin, '--version'], { timeout: 20_000 });
		const v = r.stdout.trim().split(/\r?\n/).pop() ?? '';
		if (r.code !== 0 || !v) {
			throw new Error(`dsh --version 失败（${bin}）：${(r.stderr || r.stdout).trim().slice(-400)}`);
		}
		return v;
	}
}

/**
 * Windows 8.3 短名（如 `C:\Users\QIUZIJ~1\…`）转长名：dsh 的 loader 按 file URL 解析
 * 条目，短名路径会让 profile 的 root Include 注册落空（实测：运行时放在短名路径下时
 * 任何 settings 写入都报 "profile reload requires the root Include entry"）。
 * 非 Windows / 路径不存在时原样返回。
 */
function toLongPath(p: string): string {
	if (process.platform !== 'win32') {
		return p;
	}
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}
