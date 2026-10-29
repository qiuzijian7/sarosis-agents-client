/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 托管运行时：定位 Node 与 dsh、并列安装版本、切换指针（方案第 3.2 节）。
 *
 * 只依赖 Node 内置模块与 vs/base，不 import electron —— 可在纯 Node 下做集成测试。
 *
 * P0-2 结论：不能用 VsSaros 自带的 Electron 以 ELECTRON_RUN_AS_NODE 运行 dsh
 * （`node-addon-require-builtin` 只认 Electron ≥43，VsSaros 为 39.8.8），因此 Node 必须是独立的。
 */

import { execFile } from 'child_process';
import { existsSync, mkdirSync, promises as fsp, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from '../../../../base/common/path.js';
import { compareSemver, isRuntimeVersionDir, isSupportedNodeVersion, IRuntimeState, parseRuntimeState, selectRuntimeVersion, withCurrent } from '../common/dshCli.js';
import { DshErrorCode, IDshRuntimeInfo } from '../common/dshHarness.js';
import { npmCliCandidates } from '../common/dshNodeDist.js';
import { runtimeInstallMissing } from '../common/dshRuntimeInstall.js';
import { FetchLike, installManagedNode, INodeInstallResult, managedNodePath } from './dshNodeInstaller.js';

const DSH_PKG_BIN = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];
const STATE_FILE = 'state.json';
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
	/** bundled = 安装包内置（构建期预装到 `<appPath>/dsh-runtime/<version>`，见 build/prepack-dsh-runtime.mjs）。 */
	readonly source: 'setting' | 'managed' | 'bundled' | 'global';
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
function bundledPnpmCjs(): string | undefined {
	const res = (process as unknown as { resourcesPath?: string }).resourcesPath;
	if (!res) {
		return undefined;
	}
	// 打包版：<安装根>/resources/app/tools/pnpm/pnpm.cjs（由 build/saros/ensure-pnpm-tool.mjs 落位）
	const p = join(res, 'app', 'tools', 'pnpm', 'pnpm.cjs');
	return existsSync(p) ? p : undefined;
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
 * 实现要点：只带**单文件 bundle**（`pnpm.cjs`，7.4MB），shim 里用
 * **Electron 自己当 node**（`ELECTRON_RUN_AS_NODE=1`）⇒ 用户机器**不需要装 node**
 * （实测 `ELECTRON_RUN_AS_NODE=1 "<exe>" pnpm.cjs --version` ⇒ 10.18.0，1.1 秒）。
 *
 * ⚠ 与本文件顶部"不能用 Electron 跑 dsh"那条结论**不矛盾**：那条限制是 dsh 需要
 *   `node-addon-require-builtin`（Electron 39 不支持）；pnpm 是**纯 JS**，不碰那个能力 ✓。
 */
export function injectBundledPnpm(env: NodeJS.ProcessEnv, nodeExe: string | undefined): void {
	const cjs = bundledPnpmCjs();
	if (!cjs || !nodeExe) {
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
		//   实测 `ELECTRON_RUN_AS_NODE=1 <exe> pnpm.cjs --version` 能出 10.18.0，
		//   但 `pnpm install` 装到 `added 513` 时**直接崩掉**（exit 异常）——
		//   Electron 39 的 node 对 pnpm 的并发安装阶段不够用 ✗✗。
		//   而"别人机器没有 node"这件事由 `dshNodeInstaller` 兜着：没 node 就跑不了 dsh，
		//   所以 Host 起来时 `node.path` **一定**是可用解释器（托管安装的或系统的）✓。
		if (isWindows) {
			writeFileSync(
				join(dir, 'pnpm.cmd'),
				'@echo off\r\n"' + nodeExe + '" "' + cjs + '" %*\r\n',
				'utf8',
			);
		} else {
			writeFileSync(
				join(dir, 'pnpm'),
				'#!/bin/sh\n"' + nodeExe + '" "' + cjs + '" "$@"\n',
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
		/** 托管根目录，如 `<userData>/dsh-runtime`；其下 `<version>/` 为 `npm i --prefix` 目标，`node/` 预留给托管 Node。 */
		readonly managedRoot: string,
		private readonly _log: IRuntimeLog,
		/** 安装包内置运行时根目录（打包后 `<appPath>/dsh-runtime`）；缺省/不存在 = 未内置。 */
		readonly bundledRoot?: string,
		/**
		 * 构建期 pin 的 bundled 版本（`dsh-plugins/dsh-compat.json` 的 `bundled`，与打包侧同源）。
		 *
		 * 为什么要 pin（2026-10-28）：旧行为取 `listBundled().at(-1)` = **目录里最高的版本**。打包侧一旦
		 * 残留了更高但没进兼容清单的版本（本机实测 rc.1 + rc.2 并存），装出来的包就会跑一个**没验证过**
		 * 的运行时；而 pin 的版本才是 `dsh-compat.json` 声明验证过的那一个。
		 * 缺省（dev 直跑 / 单测）⇒ 仍退回"取最高"，保持旧行为。
		 */
		private readonly _bundledVersionPin?: string,
	) { }

	// ─── 指针 ────────────────────────────────────────────────────────────────

	readState(): IRuntimeState {
		const p = join(this.managedRoot, STATE_FILE);
		return parseRuntimeState(existsSync(p) ? readFileSync(p, 'utf8') : undefined);
	}

	private async _writeState(state: IRuntimeState): Promise<void> {
		await fsp.mkdir(this.managedRoot, { recursive: true });
		const p = join(this.managedRoot, STATE_FILE);
		const tmp = `${p}.${process.pid}.tmp`;
		await fsp.writeFile(tmp, JSON.stringify(state, undefined, 2));
		await fsp.rename(tmp, p);
	}

	/** 原样写回指针（升级回退用）。 */
	restoreState(state: IRuntimeState): Promise<void> {
		this._log(`runtime pointer restored → ${state.current ?? '(none)'}`);
		return this._writeState(state);
	}

	listInstalled(): string[] {
		return this._listVersions(this.managedRoot);
	}

	/** 安装包内置的 dsh 版本（构建期预装；只读，绝不写入）。 */
	listBundled(): string[] {
		return this.bundledRoot ? this._listVersions(this.bundledRoot) : [];
	}

	private _listVersions(root: string): string[] {
		if (!existsSync(root)) {
			return [];
		}
		return readdirSync(root)
			.filter(isRuntimeVersionDir)
			.filter(v => existsSync(join(root, v, ...DSH_PKG_BIN)))
			.sort(compareSemver);
	}

	/**
	 * 选定本次要用的 bundled 版本：**compat 清单 pin 的版本优先**，目录里没有才退回"最高版本"。
	 *
	 * pin 在包里但目录里没有时不硬失败：那是"打包侧 pin 与产物不一致"，让全新安装直接起不来比
	 * 退回最高版本更糟 ⇒ 记一行日志（运维能在日志里看到）再退回。
	 */
	private _selectBundled(): string | undefined {
		const versions = this.listBundled();
		if (versions.length === 0) {
			return undefined;
		}
		const pin = this._bundledVersionPin?.trim();
		if (pin) {
			if (versions.includes(pin)) {
				return pin;
			}
			this._log(`bundled pin ${pin}（dsh-compat.json）不在安装包里：实际有 ${versions.join(', ')} ⇒ 退回最高版本`);
		}
		return versions[versions.length - 1];
	}

	getInfo(activeBin?: string): IDshRuntimeInfo {
		return { managedRoot: this.managedRoot, current: this.readState().current, installed: this.listInstalled(), activeBin };
	}

	async setCurrent(version: string): Promise<void> {
		if (!this.listInstalled().includes(version)) {
			throw new Error(`dsh ${version} 未安装在 ${this.managedRoot}`);
		}
		await this._writeState(withCurrent(this.readState(), version));
		this._log(`runtime pointer → ${version}`);
	}

	/**
	 * 并列安装一个版本：装进 `<root>/<version>`，校验 `dsh --version` 与目标一致，失败则删除目录。
	 * 不改指针 —— 切换由调用方在确认无运行中任务后执行（升级闸门，方案第 3.3 节）。
	 */
	async install(version: string, node: IResolvedNode): Promise<IResolvedDsh> {
		if (!isRuntimeVersionDir(version)) {
			throw new Error(`非法版本号：${version}`);
		}
		const target = join(this.managedRoot, version);
		const bin = join(target, ...DSH_PKG_BIN);
		if (existsSync(bin)) {
			return { bin, version: await this._probeDshVersion(node, bin), source: 'managed' };
		}
		await fsp.mkdir(target, { recursive: true });
		this._log(`installing @deepseek-ai/dsh@${version} into ${target}`);
		const r = await this._npm(node, ['install', '--prefix', target, `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund', '--loglevel=error'], 10 * 60_000);
		if (r.code !== 0 || !existsSync(bin)) {
			await fsp.rm(target, { recursive: true, force: true });
			throw new Error(`npm install 失败（code ${r.code}）：${(r.stderr || r.stdout).trim().slice(-800)}`);
		}
		const actual = await this._probeDshVersion(node, bin);
		if (actual !== version) {
			await fsp.rm(target, { recursive: true, force: true });
			throw new Error(`安装后版本不符：期望 ${version}，实际 ${actual}`);
		}
		this._log(`installed dsh ${actual}`);
		return { bin, version: actual, source: 'managed' };
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

	/** 查询 `@deepseek-ai/dsh` 的全部 dist-tags（只保留合法版本号）。 */
	async distTags(node: IResolvedNode): Promise<Record<string, string>> {
		const r = await this._npm(node, ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], 60_000);
		if (r.code !== 0) {
			throw new Error(`查询 dist-tags 失败：${(r.stderr || r.stdout).trim().slice(-400)}`);
		}
		const raw = JSON.parse(r.stdout) as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const [tag, v] of Object.entries(raw)) {
			if (/^[a-z][a-z0-9.-]*$/i.test(tag) && typeof v === 'string' && isRuntimeVersionDir(v)) {
				out[tag] = v;
			}
		}
		return out;
	}

	/** 查询 npm 上某个 dist-tag 对应的 dsh 版本（如 `latest`）。 */
	async distTagVersion(node: IResolvedNode, tag: string): Promise<string> {
		if (!/^[a-z][a-z0-9.-]*$/i.test(tag)) {
			throw new Error(`非法 dist-tag：${tag}`);
		}
		const r = await this._npm(node, ['view', `@deepseek-ai/dsh@${tag}`, 'version'], 60_000);
		const v = r.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
		if (r.code !== 0 || !isRuntimeVersionDir(v)) {
			throw new Error(`查询 @deepseek-ai/dsh@${tag} 失败：${(r.stderr || r.stdout).trim().slice(-400)}`);
		}
		return v;
	}

	/**
	 * 用所选 Node 自带的 npm 运行（`node npm-cli.js ...`），避免依赖 PATH 中的 npm 与 Windows 的 `.cmd` + shell。
	 * 找不到随附 npm 时才回退到 PATH 中的 npm。
	 */
	private _npm(node: IResolvedNode, args: string[], timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
		const cli = npmCliCandidates(node.path, process.platform).find(p => existsSync(p));
		if (cli) {
			return run(node.path, [cli, ...args], { timeout, env: sanitizedEnv() });
		}
		// 参数已校验（版本号 / dist-tag 正则），不含 shell 元字符。
		return run(isWindows ? 'npm.cmd' : 'npm', args, { timeout, shell: isWindows, env: sanitizedEnv() });
	}

	async resolveDsh(settingPath: string | undefined, node: IResolvedNode): Promise<IResolvedDsh> {
		if (settingPath?.trim()) {
			const bin0 = this._binFromSetting(settingPath.trim());
			if (!bin0) {
				throw new Error(`设置 sessions.dshHarness.runtimePath 指向的位置找不到 dsh：${settingPath}`);
			}
			const bin = toLongPath(bin0);
			return { bin, version: await this._probeDshVersion(node, bin), source: 'setting' };
		}

		// managed 在 bundled 之前：managed 指针只来自用户显式的安装/升级操作，必须尊重；
		// bundled 是构建期 pin 的兜底（全新安装时 managed 必为空，自然落到 bundled）。
		const version = selectRuntimeVersion(this.readState(), this.listInstalled());
		if (version) {
			// ★★ 2026-10-29（真机：打包 exe 启动即报「startSession: 控制桥不可用」）：
			//   托管副本里的 `@deepseek-ai/dsh-app-boot` 是**空目录**（迁移复制不全），而 `state.json`
			//   仍指向它 ⇒ 这里原来直接把 bin 交给 `_probeDshVersion` ⇒ `ERR_MODULE_NOT_FOUND` 抛出
			//   ⇒ Host 一次都没起来、`bridge` 恒 undefined，而日志里只有"控制桥不可用"✗✗。
			//   ⇒ 先做**廉价文件体检**（不 spawn）：缺构件就跳过这份、继续回落 bundled；
			//     探测失败（能启动但 --version 报错）同样跳过 —— 坏副本不许劫持整个启动 ✓。
			const installDir = join(this.managedRoot, version);
			const missing = runtimeInstallMissing(existsSync, installDir);
			if (missing.length) {
				this._log(`managed dsh ${version} 不完整（缺 ${missing.join('、')}）⇒ 跳过它，回落到下一个候选`);
			} else {
				const bin = toLongPath(join(installDir, ...DSH_PKG_BIN));
				try {
					return { bin, version: await this._probeDshVersion(node, bin), source: 'managed' };
				} catch (e) {
					this._log(`managed dsh ${version} 探测失败（${String((e as Error)?.message ?? e)}）⇒ 跳过它，回落到下一个候选`);
				}
			}
		}

		const bundled = this._selectBundled();
		if (bundled) {
			const bin = toLongPath(join(this.bundledRoot!, bundled, ...DSH_PKG_BIN));
			try {
				const probed = await this._probeDshVersion(node, bin);
				this._log(`using bundled dsh ${probed} (${bin})`);
				return { bin, version: probed, source: 'bundled' };
			} catch (e) {
				// bundled 也坏 ⇒ 说明打包漏了构件；继续找 global，别让用户看到一句"找不到 dsh" ✗
				this._log(`bundled dsh ${bundled} 探测失败（${String((e as Error)?.message ?? e)}）⇒ 继续找全局安装`);
			}
		}

		const global0 = await this._globalBin(node);
		if (global0) {
			const global = toLongPath(global0);
			return { bin: global, version: await this._probeDshVersion(node, global), source: 'global' };
		}
		throw new DshRuntimeError('dsh-missing', `未找到 dsh：托管目录 ${this.managedRoot} 为空${this.bundledRoot ? '，安装包未内置运行时' : ''}，全局也未安装。可执行「DSH: 安装运行时版本」，或 npm i -g @deepseek-ai/dsh。`);
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

	private async _globalBin(node: IResolvedNode): Promise<string | undefined> {
		const r = await this._npm(node, ['root', '-g'], 15_000);
		const root = r.stdout.trim().split(/\r?\n/).pop();
		if (r.code !== 0 || !root) {
			return undefined;
		}
		const bin = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
		try {
			return statSync(bin).isFile() ? bin : undefined;
		} catch {
			return undefined;
		}
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
