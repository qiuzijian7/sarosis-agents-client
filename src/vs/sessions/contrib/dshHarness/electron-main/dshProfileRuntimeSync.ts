/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **内置 profile 种子的定位 / 复制 / 版本同步**。
 *
 * ## 口径沿革
 *
 * - 2026-11-09：收敛成单版本模型（bundled pin），删掉 managed 多版本指针与按版本重建 profile，
 *   定为「**userData/dsh-home 永不覆盖**」—— `_ensureProfile` 存在即 return。
 * - 2026-11-12（真机 `2.2.26237` / dsh `0.2.2-rc.2`）：bundled 从 `0.2.1-rc.2` 升级后，dev 的旧
 *   profile 被无限复用，暴露两层故障：
 *     ① `.modules.yaml` 的 `storeDir` 仍是构建机 G 盘 ⇒ 36 次 `ERR_PNPM_UNEXPECTED_STORE`
 *        ⇒ 伴生插件（含 `vssaros-dsh-bridge`）装不上 ⇒ `bridge: fallback` ⇒ 桌面窗口
 *        `startSession: 控制桥不可用`（已由 `dshStoreMetadata.ts` 修）；
 *     ② `cordis.patch.yml` / `package.json` 仍指向 `@deepseek-ai/dsh-web-app@0.2.1-rc.2`
 *        ⇒ 被 dsh 判为 incompatible 而禁用 ⇒ `webStartup` 缺失 ⇒ Host `code 1`。
 *   打包版新机器首启会用**同版本种子**，不会踩；只有「复用旧 profile」会踩。
 *
 * ⇒ 本轮把口径细化为：**用户数据永不覆盖，但随包插件层必须跟随 bundled 版本同步**。
 *   「插件层」= 种子顶层的那几项（`node_modules/` / `package.json` / `pnpm-*.yaml` /
 *   `cordis*.yml` / `.vssaros/` / `.plugin-manager/`），它们是构建期产物，不是用户配置。
 *   会话 / 设置 / 工作区本来就不在 profile 目录内；profile 里种子**没有**的条目一律原样保留。
 *
 * ## 安全边界
 *
 * - 老 profile 没有 marker ⇒ 只 `stamp` 当前版本，**绝不动文件**（升级代码首次运行不能误重建）。
 * - 版本一致 ⇒ `keep`；版本不一致但**没有同版本种子** ⇒ 只警告、绝不重建（那会清空用户 profile）。
 * - `rebuild` = 备份整目录 → 从种子复制插件层 → 把备份里种子没有的条目拷回 → 写 marker；
 *   任一步失败都删半成品并还原备份，错误往上冒（下次启动重试）。
 */

import { existsSync, readFileSync, promises as fsp } from 'fs';
import { join } from '../../../../base/common/path.js';

/** profile 里的版本标记（轻量，只记是哪个 dsh 版本建的插件层）。 */
export const PROFILE_RUNTIME_MARKER_REL = join('.vssaros', 'runtime-version.json');

export interface IProfileRuntimeMarker {
	readonly dshVersion: string;
	readonly updatedAt: string;
}

export function readProfileRuntimeVersion(profileDir: string): string | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(profileDir, PROFILE_RUNTIME_MARKER_REL), 'utf8')) as Partial<IProfileRuntimeMarker>;
		return typeof raw.dshVersion === 'string' && raw.dshVersion ? raw.dshVersion : undefined;
	} catch {
		return undefined; // 老 profile / 坏标记 ⇒ 当"没登记"，只 stamp 不重建
	}
}

export async function writeProfileRuntimeMarker(profileDir: string, dshVersion: string): Promise<void> {
	const to = join(profileDir, PROFILE_RUNTIME_MARKER_REL);
	await fsp.mkdir(join(profileDir, '.vssaros'), { recursive: true });
	const marker: IProfileRuntimeMarker = { dshVersion, updatedAt: new Date().toISOString() };
	await fsp.writeFile(to, JSON.stringify(marker, null, 2) + '\n', 'utf8');
}

export type ProfileRuntimeSyncPlan =
	| { kind: 'keep' }
	| { kind: 'stamp' }
	| { kind: 'init'; seedDir?: string }
	| { kind: 'rebuild'; seedDir: string; from: string }
	| { kind: 'warn-no-seed'; from: string };

export interface IProfileRuntimeSyncInput {
	readonly profileExists: boolean;
	readonly markerVersion?: string;
	readonly dshVersion: string;
	readonly seedDir?: string;
}

/** 纯判定，不读盘不改盘 ⇒ 可完整单测。 */
export function planProfileRuntimeSync(input: IProfileRuntimeSyncInput): ProfileRuntimeSyncPlan {
	if (!input.profileExists) {
		return input.seedDir ? { kind: 'init', seedDir: input.seedDir } : { kind: 'init' };
	}
	if (!input.markerVersion) {
		return { kind: 'stamp' };
	}
	if (input.markerVersion === input.dshVersion) {
		return { kind: 'keep' };
	}
	return input.seedDir
		? { kind: 'rebuild', seedDir: input.seedDir, from: input.markerVersion }
		: { kind: 'warn-no-seed', from: input.markerVersion };
}

/**
 * 把 profile 种子**整目录**复制到目标位置（目标不存在时调用）。
 *
 * ★★ 2026-11-09（真机：首次从仓库种子建 profile 直接崩溃）：
 *   `fsp.cp(..., { recursive: true })` 默认 `dereference: false` ⇒ 按符号链接原样复制。
 *   仓库种子 `node_modules/.pnpm/` 下有 **6097 个 pnpm symlink**，Windows 非管理员创建 symlink
 *   会 `EPERM` ⇒ 重建失败 ⇒ app 启动崩溃。打包版种子用 `npm_config_package_import_method=copy`
 *   生成（真文件），**不能假设种子一定无链接**。
 *
 * ⇒ `dereference: true`：跟随链接复制成真实文件/目录，不需要任何特殊权限 ✓。
 *   代价：解引用后体积/耗时变大（实测 575MB → 3.1GB / 约 10 分钟），只在首启或版本升级各一次；
 *   `_repairSeededStoreMetadata` 随后会校正 `.modules.yaml`（含 pnpm 11 的 JSON 写法）。
 */
export async function copyProfileSeed(seedDir: string, destDir: string): Promise<void> {
	await fsp.cp(seedDir, destDir, { recursive: true, dereference: true, force: true });
}

/**
 * **只同步随包插件层**：备份旧 profile → 从同版本种子复制 → 把备份里种子没有的条目拷回。
 *
 * 「种子顶层条目」天然就是插件层的定义（构建期产物），不用维护一份可能过时的白名单。
 * 用户数据（会话/设置/自定义文件）不在此列，全部保留 ✓。
 */
export async function syncProfilePluginLayer(
	seedDir: string,
	profileDir: string,
	backupDir: string,
	// 注入仅为让「复制失败 ⇒ 回滚」可被精确单测；生产一律用 copyProfileSeed。
	copy: (from: string, to: string) => Promise<void> = copyProfileSeed,
): Promise<{ restoredUserData: string[] }> {
	const seedEntries = new Set(await fsp.readdir(seedDir));
	await fsp.rename(profileDir, backupDir);
	try {
		await copy(seedDir, profileDir);
		const restoredUserData: string[] = [];
		for (const entry of await fsp.readdir(backupDir)) {
			if (seedEntries.has(entry)) {
				continue; // 插件层：用新版本种子
			}
			await fsp.cp(join(backupDir, entry), join(profileDir, entry), { recursive: true, dereference: true, force: true });
			restoredUserData.push(entry);
		}
		return { restoredUserData };
	} catch (e) {
		// 半成品绝不能留在原路径 ⇒ 删掉并还原备份，让错误继续往上冒（下次启动重试）
		await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
		await fsp.rename(backupDir, profileDir).catch(() => undefined);
		throw e;
	}
}

/**
 * 版本对应的 profile 种子目录；不存在/缺 `package.json` ⇒ `undefined`（绝不返回半成品目录）。
 *
 * @param runtimeRoot **dsh-runtime 目录本身**（打包版 `<appPath>/dsh-runtime`，dev 仓库根 `dsh-runtime/`），
 *   其内部按 `<version>/profile-seed/profiles/<profile>` 组织。注意不是 `<appPath>`：
 *   `DshRuntimeManager.bundledRoot` 传进来的就是这个目录，别再拼一层 `dsh-runtime` ✗。
 */
export function profileSeedDirFor(runtimeRoot: string | undefined, dshVersion: string, profile: string): string | undefined {
	if (!runtimeRoot || !dshVersion || !profile) {
		return undefined;
	}
	const dir = join(runtimeRoot, dshVersion, 'profile-seed', 'profiles', profile);
	return existsSync(join(dir, 'package.json')) ? dir : undefined;
}
