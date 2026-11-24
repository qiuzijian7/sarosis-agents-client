/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件补丁的「版本覆盖」真源（插件级升级 P2）。
 *
 * 问题：补丁把新版本装进 profile 后，`DshHostSupervisor._ensurePlugin` 每次启动都会拿
 * `<appPath>/dsh-plugins/<pkg>/package.json` 里的**旧版本**去比对 `installed`；版本不等就
 * `installing <name>@<bundled>` 装回旧版（`dshHostSupervisor.ts:3133-3163`）。同时
 * `mergeBundledWithInstalled` 会把 profile 里更高的版本显示成 `downgradable`（「改回」）。
 *
 * 解法（不改 supervisor）：把已应用的补丁记在 `<userData>/dsh-plugin-overrides.json`，然后
 *  - **启动清单**用 `startupPackages()` 摘掉被覆盖的包 ⇒ `_ensurePlugin` 收到 `dir: undefined`
 *    直接返回 `installed`，不重装（同一函数 `:3120-3126` 的既有语义）；
 *  - **界面清单**用 `effectivePackages()` 把随包版本提升为补丁版本 ⇒ 状态回到 `installed`。
 *
 * 老客户端 / 没有这个文件 ⇒ 返回空数组，行为完全不变。删除该文件即回滚到随包版本。
 * 落点必须是 userData：system setup 装在 Program Files，`<appPath>` 不可写。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { comparePluginVersions, type IBundledPluginPackage } from './dshBundledPlugins.js';

export interface IDshPluginOverride {
	readonly name: string;
	readonly version: string;
	/** 仓库里的插件目录名（如 `vssaros-bridge`），用于把伴生插件的启动路径一并摘掉。 */
	readonly dirName: string;
	readonly sha256: string;
	/** 补丁 tgz 的绝对路径（userData 下），保留供回滚/重试。 */
	readonly archive: string;
	readonly appliedAt: string;
}

interface IDshPluginOverrideFile {
	readonly schemaVersion: 1;
	readonly entries: readonly IDshPluginOverride[];
}

export function overridesPath(userDataPath: string): string {
	return join(userDataPath, 'dsh-plugin-overrides.json');
}

/** 读不动 / 版本不对 / 字段缺失一律当「没有覆盖」，绝不让坏文件阻断启动。 */
export function readOverrides(userDataPath: string): IDshPluginOverride[] {
	const file = overridesPath(userDataPath);
	try {
		if (!existsSync(file)) {
			return [];
		}
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<IDshPluginOverrideFile>;
		if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
			return [];
		}
		return parsed.entries.filter((e): e is IDshPluginOverride =>
			!!e && typeof e.name === 'string' && typeof e.version === 'string'
			&& typeof e.dirName === 'string' && typeof e.sha256 === 'string' && typeof e.archive === 'string');
	} catch {
		return [];
	}
}

/** 原子写（tmp + rename），避免应用途中被杀留下半份覆盖表。 */
export function writeOverrides(userDataPath: string, entries: readonly IDshPluginOverride[]): void {
	const file = overridesPath(userDataPath);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, entries }, null, 2) + '\n', 'utf8');
	renameSync(tmp, file);
}

function newer(override: IDshPluginOverride, pkg: IBundledPluginPackage): boolean {
	return override.name === pkg.name && comparePluginVersions(override.version, pkg.version) > 0;
}

/** 界面/合并用：把随包版本提升为补丁版本（**不改 dir**，用户主动「改回」仍可回随包目录）。 */
export function effectivePackages(
	packages: readonly IBundledPluginPackage[],
	overrides: readonly IDshPluginOverride[],
): IBundledPluginPackage[] {
	return packages.map(pkg => {
		const hit = overrides.find(o => newer(o, pkg));
		return hit ? { ...pkg, version: hit.version } : pkg;
	});
}

/** 启动清单用：摘掉已被补丁覆盖的包，防止 `_ensurePlugin` 降级重装。 */
export function startupPackages(
	packages: readonly IBundledPluginPackage[],
	overrides: readonly IDshPluginOverride[],
): IBundledPluginPackage[] {
	return packages.filter(pkg => !overrides.some(o => newer(o, pkg)));
}

/** 已被补丁覆盖的插件目录名（伴生插件的 `xxxPluginDir` 路径用它判空）。 */
export function overriddenDirNames(overrides: readonly IDshPluginOverride[]): ReadonlySet<string> {
	return new Set(overrides.map(o => o.dirName));
}
