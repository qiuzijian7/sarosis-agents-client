/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **随包模块插件**的枚举与合并（插件中心「随包」段 / 一键安装，方案 5.16 的补充）。
 *
 * 背景（可用性缺口）：`dsh-plugins/` 里的 10 个模块插件（skills / mcp / kb / memory / codebase /
 * kanban / workflow / agents / dashboard / ide）是**随产品分发**的，但用户此前只能在「添加插件」里
 * **手敲 spec**（`file:G:\...\dsh-plugins\vssaros-kanban` 这种）——既不现实，也踩跨盘符的坑。
 * 这里把"有哪些随包插件、装了没有、能不能升级"算成一份清单交给界面。
 *
 * 只列**模块插件**（`package.json` 的 `vssaros.module` 有值）：`vssaros-bridge` / `vssaros-chat-surface`
 * 是伴生插件（启动时自动安装维护），把它们混进"可安装"列表只会让用户以为自己得手动装。
 *
 * 纯函数 + 注入式读取，便于单测（不碰 Electron / app 路径）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IDshBundledPluginRow, IDshBundledPluginState } from '../common/dshHarness.js';

/** 一个随包插件的包信息（从 `package.json` 读出来的那几项）。 */
export interface IBundledPluginPackage {
	readonly name: string;
	readonly version: string;
	readonly description?: string;
	/** 清单里的模块 id（`vssaros.module`）；**只有模块插件才有**。 */
	readonly module: string;
	readonly dir: string;
	/**
	 * `peerDependencies['@deepseek-ai/dsh']` 里的范围（没有则空）。
	 *
	 * 用途：升级 dsh **运行时**前预检"这个版本会不会让我们的随包模块插件不兼容"
	 * （见 `dshCompat.discoverUpdates` 的模块插件预检）。读不到就当没有约束 ✓（不误报）。
	 */
	readonly peerRange?: string;
}

export interface IListBundledPluginsResult {
	readonly packages: readonly IBundledPluginPackage[];
	/** 目录里读不动/不该列出来的条目（诊断用：空目录、坏 package.json、解析成非对象…）。 */
	readonly problems: readonly string[];
}

/** 读取并解析包信息（注入以便单测；真实实现见 `readPackageJson`）。 */
export type PackageReader = (packageJsonPath: string) => unknown;

export function readPackageJson(path: string): unknown {
	return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 枚举 `root` 下的一级子目录，挑出**模块插件**（`vssaros.module` 非空）。
 *
 * 容错口径：读不动 / 没 `name` / 没 `version` / 没 `vssaros.module` 的条目**不进清单**，
 * 但会被记进 `problems`（界面与探针据此知道"目录里有东西但没被列出来"，而不是静默少一行）。
 * `root` 不存在时返回空清单 + 一条 problem（正常：老构建可能没带 `dsh-plugins/`）。
 */
export function listBundledPlugins(root: string, read: PackageReader = readPackageJson): IListBundledPluginsResult {
	const packages: IBundledPluginPackage[] = [];
	const problems: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(root).filter(e => {
			try {
				return statSync(join(root, e)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return { packages, problems: [`${root} 不可读（没有这个目录？）`] };
	}
	for (const entry of entries) {
		const dir = join(root, entry);
		let pkg: unknown;
		try {
			pkg = read(join(dir, 'package.json'));
		} catch (e) {
			problems.push(`${entry}: package.json 读不动（${String((e as Error)?.message ?? e)}）`);
			continue;
		}
		const p = pkg as { name?: unknown; version?: unknown; description?: unknown; vssaros?: { module?: unknown }; peerDependencies?: Record<string, unknown> };
		const name = typeof p?.name === 'string' ? p.name.trim() : '';
		const version = typeof p?.version === 'string' ? p.version.trim() : '';
		const moduleId = typeof p?.vssaros?.module === 'string' ? p.vssaros.module.trim() : '';
		if (!name || !version) {
			problems.push(`${entry}: 缺 name/version，跳过`);
			continue;
		}
		if (!moduleId) {
			// 伴生插件（bridge / chat-surface）走启动时自动安装，不列进"可安装"清单。
			problems.push(`${entry}: 非模块插件（无 vssaros.module），不列入随包模块`);
			continue;
		}
		// 运行时升级预检要用它（见 `IBundledPluginPackage.peerRange`）；读不到就当没有约束 ✓
		const peerRaw = p.peerDependencies?.['@deepseek-ai/dsh'];
		const peerRange = typeof peerRaw === 'string' && peerRaw.trim() ? peerRaw.trim() : undefined;
		packages.push({
			name,
			version,
			module: moduleId,
			dir,
			...(peerRange ? { peerRange } : {}),
			...(typeof p.description === 'string' && p.description.trim() ? { description: p.description.trim() } : {}),
		});
	}
	// 稳定顺序：按模块 id 排（界面顺序不受目录枚举顺序影响）。
	packages.sort((a, b) => (a.module === b.module ? a.name.localeCompare(b.name) : a.module.localeCompare(b.module)));
	return { packages, problems };
}

/** profile 里已装插件的最小形状（`IDshPluginInfo` 的子集，避免这里的类型依赖过宽）。 */
export interface IInstalledPluginRef {
	readonly name: string;
	readonly version?: string;
	readonly enabled?: boolean;
}

/**
 * 随包插件版本号**粗比较（只比数字段）**：等长不足按 0 补。
 *
 * 只用来给状态定方向（`upgradable` / `downgradable`）。**唯一实现** —— 视图侧原先另有一份私有拷贝，
 * 两处在"profile 里装了更新版本"这个条件下会给出互相矛盾的话术（2026-10-12 修）。
 *
 * ⚠ 已知局限：预发布段被当数字比 ⇒ `0.2.0-rc.2` 会被判**大于** `0.2.0` ✗（语义化版本里更小）。
 *   随包**插件**目前都是纯数字段版本（`0.1.7` / `0.2.20` / `0.3.0` 这种，见各
 *   `dsh-plugins/<dir>/package.json`）⇒ 够用；**一旦插件版本出现 `-rc` 段，这里必须换成
 *   `base/common/semver`**，否则按钮话术与状态徽标会整片反向 ✗。
 *
 * ⚠ 写注释时别让**星号紧跟斜杠**（例如把仓库目录写成通配路径）：那会**提前闭合块注释**，
 *   后面的中文就成了代码 ⇒ esbuild 直接报 "Expected ... but found ..."（2026-10-12 踩过两次，
 *   第二次甚至是"讲解这个坑"的那句话本身又踩了进去 ✗）。
 */
export function comparePluginVersions(a: string, b: string): number {
	const parts = (v: string) => v.split(/[.+-]/).map(p => Number.parseInt(p, 10)).filter(n => Number.isFinite(n));
	const pa = parts(a);
	const pb = parts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) {
			return d > 0 ? 1 : -1;
		}
	}
	return 0;
}

/**
 * 随包清单 × 已装清单 → 界面行（纯函数）。
 *
 * `state` 是**安装状态的真源**（四种，见 `IDshBundledPluginState`）：未装 ⇒ `missing`；相等 ⇒
 * `installed`；profile 更旧 ⇒ `upgradable`；profile **更新** ⇒ `downgradable`（此时按钮必须说"改回"，
 * 说成"升级"会让用户以为自己在升级 ✗）。已装但**停用**的（`enabled === false`）另标
 * `installedDisabled`（与 state 正交：界面要能说清"装了但关着"，否则用户点"安装"会以为没生效）。
 */
export function mergeBundledWithInstalled(
	packages: readonly IBundledPluginPackage[],
	installed: readonly IInstalledPluginRef[],
): IDshBundledPluginRow[] {
	const byName = new Map(installed.map(p => [p.name, p]));
	return packages.map(pkg => {
		const hit = byName.get(pkg.name);
		const installedVersion = hit?.version?.trim() || (hit ? pkg.version : undefined);
		// 装了但清单里没有版本号 ⇒ 视作"随包版本已装"（沿用既有口径：不把老 profile 判成要重装 ✓）
		let state: IDshBundledPluginState = 'missing';
		if (hit) {
			const cmp = comparePluginVersions(installedVersion ?? pkg.version, pkg.version);
			state = cmp === 0 ? 'installed' : cmp < 0 ? 'upgradable' : 'downgradable';
		}
		return {
			name: pkg.name,
			version: pkg.version,
			state,
			module: pkg.module,
			dir: pkg.dir,
			...(pkg.description ? { description: pkg.description } : {}),
			...(hit ? { installedVersion } : {}),
			...(hit && hit.enabled === false ? { installedDisabled: true } : {}),
		};
	});
}
