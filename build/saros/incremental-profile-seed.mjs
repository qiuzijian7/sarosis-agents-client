/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 增量 profile 种子 —— 只给「改了几个 dsh 插件、bump 了补丁版本」的场景用。
 *
 * 全量重建（build/prepack-dsh-runtime.mjs 的 buildProfileSeed）会删掉整个种子、把 35+ 个插件
 * 重新 `dsh plugin add` 一遍，最后还要起一次 Host 让 web 模板依赖落盘（1–3 分钟）。
 * 但只改 `lib/*.js` + bump 版本时，依赖闭包与 web 模板一点没变 ⇒ 只需重新归档并 `dsh plugin add`
 * **变更的那几个包**，marker 与 profile 的其余部分原样保留。
 *
 * 安全边界（任一不满足 ⇒ 返回 ok:false，调用方回退全量重建）：
 *   - seed.json 存在、generatorRevision / dsh 版本与当前一致；
 *   - 插件**名单**完全相同（新增/删除插件、官方 bundle 版本变化都要全量重建）；
 *   - 变更插件的 dependencies / peerDependencies / optionalDependencies 与已装版本一致
 *     （依赖树变了就必须重新起 Host 落盘，不能走增量）；
 *   - profile 的 package.json / pnpm-workspace.yaml / web-app 依赖都在；
 *   - 增量执行中任何异常、断链、对账不符 ⇒ 不写 marker，回退全量（全量会整目录删掉重建）。
 *
 * 由 prepack-dsh-runtime.mjs --incremental-seed 调用；不带该参数时 prepack 行为完全不变。
 */

import { execFileSync } from 'node:child_process';
import {
	existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync,
	statSync, writeFileSync,
} from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { SEED_GENERATOR_REVISION, archiveSeedPlugin, relativizeSeedPaths } from './seed-package.mjs';

/** 与 prepack-dsh-runtime.mjs 的 UNSCOPED_VENDORED 保持一致（新增同类包要两边同步）。 */
const UNSCOPED_VENDORED = new Set(['dsh-ego-browser', 'dsh-vision-router', 'dsh-better-sidebar', 'dsh-deep-ptc-mode']);

/** 与 prepack 的 discoverRepoPluginDirs 同口径，foundation 排第一（marker 的键序必须稳定）。 */
function discoverRepoPluginDirs(baseDir) {
	const out = [];
	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) { continue; }
		const dir = join(baseDir, entry.name);
		const packagePath = join(dir, 'package.json');
		if (!existsSync(packagePath)) { continue; }
		const name = JSON.parse(readFileSync(packagePath, 'utf8'))?.name;
		if (typeof name === 'string' && (name.startsWith('@vssaros/') || name.startsWith('@tt-a1i/') || UNSCOPED_VENDORED.has(name))) {
			out.push(dir);
		}
	}
	return out.sort((a, b) => {
		const fa = a.endsWith(`${sep}vssaros-foundation`) ? 0 : 1;
		const fb = b.endsWith(`${sep}vssaros-foundation`) ? 0 : 1;
		return fa - fb || a.localeCompare(b);
	});
}

/** 与 prepack 的 buildProfileSeed.pluginSources 同一批官方 bundle。 */
function officialPluginSources(runtimeDir) {
	return [
		'dsh-web-app',
		// 与 prepack-dsh-runtime.mjs 的 OFFICIAL_BUNDLES 同源：首启必装项漏了就会 wants > 0。
		'dsh-experimental-session-search',
		'dsh-experimental-voice-input-bundle',
		'dsh-experimental-schedule-bundle',
		'dsh-experimental-forge-bundle',
		'dsh-experimental-forge',
		'dsh-experimental-forge-github',
		'dsh-experimental-forge-session',
		'dsh-experimental-client-ui-forge',
		'dsh-experimental-worktree',
		'dsh-skill-office',
		'dsh-tool-workspace-dependencies',
	].map(name => join(runtimeDir, 'node_modules', '@deepseek-ai', name))
		.filter(dir => existsSync(join(dir, 'package.json')));
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const dependencyShape = pkg => ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']
	.map(key => JSON.stringify(pkg?.[key] ?? {})).join('|');

/** 只查符号链接断链：增量后残留断链会让 ISCC / vinyl-fs 踩 ENOENT。 */
function hasDanglingLinks(profileDir) {
	const root = join(profileDir, 'node_modules');
	let dangling = 0;
	const scan = (dir, depth) => {
		if (depth > 8 || dangling > 0) { return; }
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
			if (err?.code === 'ENOENT' && dir !== root) { dangling++; }
			return;
		}
		for (const entry of entries) {
			const p = join(dir, entry.name);
			let st;
			try { st = lstatSync(p); } catch { continue; }
			if (st.isSymbolicLink() || entry.isSymbolicLink()) {
				try { statSync(p); } catch (err) { if (err?.code === 'ENOENT') { dangling++; return; } }
			} else if (st.isDirectory()) {
				scan(p, depth + 1);
			}
		}
	};
	if (existsSync(root)) { scan(root, 0); }
	return dangling > 0;
}

/**
 * 尝试增量更新种子。
 * @returns {Promise<{ok: boolean, changed?: string[], reason?: string}>}
 *   ok:false 表示「不适用/失败」，调用方必须回退全量 buildProfileSeed（种子可能已被部分改动）。
 */
export async function tryIncrementalSeed({ root, runtimeDir, dshBin, dshVersion, pnpmShimDir }) {
	const seed = join(runtimeDir, 'profile-seed');
	const profileDir = join(seed, 'profiles', 'vssaros');
	const markerPath = join(seed, 'seed.json');

	try {
		if (!existsSync(markerPath) || !existsSync(join(profileDir, 'package.json'))
			|| !existsSync(join(profileDir, 'pnpm-workspace.yaml'))
			|| !existsSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'))) {
			return { ok: false, reason: '种子或 web 模板依赖不完整（首次构建 / 半成品种子）' };
		}

		const marker = readJson(markerPath);
		if (marker.generatorRevision !== SEED_GENERATOR_REVISION || marker.dsh !== dshVersion
			|| !marker.plugins || typeof marker.plugins !== 'object') {
			return { ok: false, reason: 'seed marker 版本/生成器修订号与当前不一致' };
		}

		const repoDirs = discoverRepoPluginDirs(join(root, 'dsh-plugins'));
		const officialDirs = officialPluginSources(runtimeDir);
		const repoDirByName = new Map();
		const wantPlugins = {};
		for (const dir of [...repoDirs, ...officialDirs]) {
			const pkg = readJson(join(dir, 'package.json'));
			wantPlugins[pkg.name] = pkg.version;
			if (repoDirs.includes(dir)) { repoDirByName.set(pkg.name, dir); }
		}

		const oldNames = Object.keys(marker.plugins);
		const newNames = Object.keys(wantPlugins);
		if (oldNames.length !== newNames.length || newNames.some(name => !Object.hasOwn(marker.plugins, name))) {
			return { ok: false, reason: '插件名单有增删（新增插件或 dsh bundle 版本变化）' };
		}
		for (const [name, version] of Object.entries(wantPlugins)) {
			if (!repoDirByName.has(name) && marker.plugins[name] !== version) {
				return { ok: false, reason: `官方 bundle 版本变化：${name}` };
			}
		}

		const changed = newNames.filter(name => repoDirByName.has(name) && marker.plugins[name] !== wantPlugins[name]);
		if (changed.length === 0) {
			return { ok: true, changed: [] };
		}

		// 依赖清单变了 ⇒ 闭包要重新解析、必须起 Host 落盘 ⇒ 全量重建。
		for (const name of changed) {
			const repoPkg = readJson(join(repoDirByName.get(name), 'package.json'));
			const installedPath = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
			if (!existsSync(installedPath)) {
				return { ok: false, reason: `${name} 在种子里缺失` };
			}
			const installedPkg = readJson(installedPath);
			if (dependencyShape(repoPkg) !== dependencyShape(installedPkg)) {
				return { ok: false, reason: `${name} 的依赖清单发生变化` };
			}
		}

		const env = {
			...process.env,
			DSH_HOME: seed,
			pnpm_config_package_import_method: 'copy',
			pnpm_config_auto_install_peers: 'false',
			pnpm_config_strict_peer_dependencies: 'false',
			pnpm_config_verify_deps_before_run: 'false',
		};
		if (pnpmShimDir) {
			const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
			env[pathKey] = pnpmShimDir + delimiter + (env[pathKey] ?? '');
		}
		const dshRun = dshArgs => execFileSync(process.execPath, [dshBin, ...dshArgs], {
			env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
		});
		/** dsh 的版本闸门（allow-version … --accept-risk）：命中就接受后重试，与全量路径同策略。 */
		const dsh = dshArgs => {
			let lastError;
			const accepted = new Set();
			for (let attempt = 0; attempt < 60; attempt++) {
				try {
					return dshRun(dshArgs);
				} catch (error) {
					lastError = error;
					const text = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;
					const match = /allow-version\s+(\S+)\s+--dsh-version\s+(\S+)/.exec(text);
					if (!match || accepted.has(match[1])) { throw error; }
					accepted.add(match[1]);
					dshRun(['plugin', '--profile', 'vssaros', 'allow-version', match[1], '--dsh-version', match[2], '--accept-risk']);
				}
			}
			throw lastError ?? new Error('dsh 版本闸门重试次数用尽');
		};

		for (const name of changed) {
			const dir = repoDirByName.get(name);
			const pkg = readJson(join(dir, 'package.json'));
			const flat = name.replace(/^@/, '').replace(/\//g, '-');
			const archive = join(profileDir, '.vssaros', 'plugins', `${flat}-${pkg.version}.tgz`);
			mkdirSync(join(profileDir, '.vssaros', 'plugins'), { recursive: true });
			rmSync(archive, { force: true }); // 允许增量重跑（archiveSeedPlugin 拒绝覆盖已存在归档）
			await archiveSeedPlugin(dir, archive);
			dsh(['plugin', '--profile', 'vssaros', 'add', `file:${archive.replace(/\\/g, '/')}`]);
			const installed = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
			if (!existsSync(installed) || readJson(installed).version !== pkg.version) {
				throw new Error(`${name}@${pkg.version} 增量安装后版本对不上`);
			}
			console.log(`[seed-incremental] ↻ ${name} ${marker.plugins[name]} → ${pkg.version}`);
		}

		relativizeSeedPaths(profileDir);
		rmSync(join(seed, '.credentials.yaml'), { force: true });
		if (hasDanglingLinks(profileDir)) {
			throw new Error('增量后种子里出现悬空链接（gulp / ISCC 会 ENOENT）');
		}
		for (const [name, version] of Object.entries(wantPlugins)) {
			const installed = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
			if (!existsSync(installed) || readJson(installed).version !== version) {
				throw new Error(`增量后种子清单不完整：${name}@${version}`);
			}
		}
		writeFileSync(markerPath, JSON.stringify({
			generatorRevision: SEED_GENERATOR_REVISION,
			dsh: dshVersion,
			plugins: wantPlugins,
			createdAt: new Date().toISOString(),
		}, undefined, 2));
		return { ok: true, changed };
	} catch (error) {
		return { ok: false, reason: `增量执行失败：${String(error?.message ?? error).split('\n')[0]}` };
	}
}
