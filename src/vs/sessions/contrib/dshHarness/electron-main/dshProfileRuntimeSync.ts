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
 * - `rebuild` = 按种子顶层条目就地覆盖插件层 → 写 marker；用户自有条目不枚举、不删除；
 *   不再 rename 整个 profile（Windows 上会被旧 Host 占用而 EPERM）。任一步失败都由调用方保留旧 marker，下次启动重试。
 */

import { existsSync, readFileSync, promises as fsp } from 'fs';
import { dirname, join } from '../../../../base/common/path.js';
import { copyDirectoryConcurrently, copyFileWithRetry } from './dshConcurrentCopy.js';
import { stagePluginDir } from './dshPluginStaging.js';
import { isSharedProfile } from './dshSharedProfile.js';

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
 * 随包插件「源码 → 用户 profile」同步结果。
 *
 * `changed === true` 表示真的换过插件文件，调用方必须让常驻 Host 失效；
 * 否则重复启动应完全 no-op，才能恢复 Host 复用。
 */
export interface IBundledPluginSyncResult {
	readonly scanned: number;
	readonly synced: string[];
	readonly skipped: string[];
	readonly errors: string[];
	readonly changed: boolean;
}

export interface IBundledPluginSource {
	readonly name: string;
	readonly sourceDir: string;
}

export interface IBundledPluginSyncOptions {
	/** 版本 + 入口内容一致时返回 true；与 `_planPluginInstall` 共用同一口径。 */
	readonly matches: (sourceDir: string, installedDir: string) => boolean;
	/** 测试可注入；生产默认用 `isSharedProfile()`。 */
	readonly isSharedProfile?: (profileDir: string) => Promise<boolean>;
	/** 测试可注入；生产默认用 `stagePluginDir()` 原子落位。 */
	readonly stage?: (sourceDir: string, destDir: string) => Promise<string>;
	readonly log?: (line: string) => void;
}

/** 与 prepack 的 `discoverRepoPluginDirs` 同口径：只同步仓库自带插件，不碰官方/用户插件。 */
const BUNDLED_REPO_UNSCOPED = new Set(['dsh-ego-browser', 'dsh-vision-router', 'dsh-better-sidebar', 'dsh-deep-ptc-mode']);

export function isBundledRepoPluginName(name: string): boolean {
	return name.startsWith('@vssaros/') || name.startsWith('@tt-a1i/') || BUNDLED_REPO_UNSCOPED.has(name);
}

/**
 * 用 `dsh-plugins/` 当前源码直接修好用户 profile 的同版本入口漂移。
 *
 * 为什么不从 `profile-seed` 同步：种子可能由旧源码 / pnpm 同版本 no-op 生成（真机见过
 * `@vssaros/dsh-skills` 与源码入口不一致），再同步种子只会把旧内容刷回用户 profile。
 * 源码目录是 `plugins[]` 的真源，直接以它为准最稳。
 *
 * 安全边界：
 * - 不调 `dsh plugin add` / pnpm；只做目录复制 + 原子 rename；
 * - 白名单只覆盖仓库自带插件，用户自装与官方包绝不枚举/删除；
 * - shared profile 的 `node_modules` 本来就指向种子，直接跳过；
 * - 白名单插件若被 pnpm 装成链接，先只摘链接本身，再用源码目录原子覆盖；绝不递归删链接目标；
 * - 单包失败只记录，回退到既有安装链。
 */
export async function syncBundledPluginDirs(
	sources: readonly IBundledPluginSource[],
	profileDir: string,
	options: IBundledPluginSyncOptions,
): Promise<IBundledPluginSyncResult> {
	const log = options.log ?? (() => undefined);
	const shared = await (options.isSharedProfile ?? isSharedProfile)(profileDir);
	if (shared) {
		log('bundled plugin sync: shared profile already points at the seed; skip');
		return { scanned: 0, synced: [], skipped: [], errors: [], changed: false };
	}

	const result = { scanned: 0, synced: [] as string[], skipped: [] as string[], errors: [] as string[], changed: false };
	for (const { name, sourceDir } of sources) {
		if (!isBundledRepoPluginName(name)) {
			continue;
		}
		result.scanned += 1;
		if (name.includes('..') || name.includes('\\') || name.startsWith('/')) {
			result.skipped.push(name);
			continue;
		}
		const installedPackageDir = join(profileDir, 'node_modules', ...name.split('/'));
		try {
			await fsp.access(join(sourceDir, 'package.json'));
		} catch {
			result.skipped.push(name);
			continue;
		}
		if (options.matches(sourceDir, installedPackageDir)) {
			continue;
		}
		const installedStat = await fsp.lstat(installedPackageDir).catch(() => undefined);
		if (installedStat?.isSymbolicLink()) {
			// ★ 2026-11-24：pnpm 会把随包插件装成 junction/symlink。之前 skip 会让
			//   `_planPluginInstall` 继续判同版本内容漂移 ⇒ 24s pnpm 重装 + Host 冷启动。
			//   白名单内插件应摘掉链接本身（绝不递归删目标），再用源码目录原子落位。
			try {
				await fsp.unlink(installedPackageDir);
			} catch {
				await fsp.rmdir(installedPackageDir); // Windows junction 只能 rmdir 摘链接
			}
			log(`bundled plugin sync: ${name} was a pnpm link; replaced by the source directory`);
		}
		try {
			await (options.stage ?? ((src, destDir) => stagePluginDir({ sourceDir: src, destDir })))(sourceDir, installedPackageDir);
			result.synced.push(name);
			result.changed = true;
			if (!options.matches(sourceDir, installedPackageDir)) {
				result.errors.push(`${name}（同步后入口仍不一致）`);
			}
		} catch (e) {
			result.errors.push(`${name}（${String((e as Error)?.message ?? e).slice(0, 160)}）`);
		}
	}
	if (result.changed) {
		log(`bundled plugin sync: ${result.synced.length}/${result.scanned} plugin(s) refreshed from source without pnpm`);
	}
	if (result.errors.length) {
		log(`bundled plugin sync: ${result.errors.length} plugin(s) still need the legacy install path: ${result.errors.join(', ')}`);
	}
	return result;
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
 *
 * 2026-11-23（安装版首启太慢）：`fsp.cp` 逐文件串行，3 万多个小文件还要逐个过 Defender ⇒ 首启几分钟。
 *   换成 `copyDirectoryConcurrently`（worker 池并发 `copyFile`），语义仍对齐
 *   `fsp.cp(src, dest, { recursive: true, dereference: true, force: true })`：解引用、覆盖、失败向上冒；
 *   目录认领与失败回滚留在本函数，没有跟着实现一起换。
 */
export async function copyProfileSeed(seedDir: string, destDir: string): Promise<void> {
	// 先校验种子 manifest：坏种子不许在目标位置留下一个会被 init/stamp 误认成"已完成"的目录。
	const manifestPath = join(seedDir, 'package.json');
	const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
	if (Object.prototype.toString.call(manifest) !== '[object Object]') {
		throw new Error(`profile seed manifest is invalid: ${manifestPath}`);
	}
	// mkdir(destDir) 是原子认领：目标已存在或并发复制的败者都会失败，绝不覆盖/清理别人的 profile。
	await fsp.mkdir(dirname(destDir), { recursive: true });
	await fsp.mkdir(destDir);
	try {
		await copyDirectoryConcurrently(seedDir, destDir, { dereference: true });
	} catch (e) {
		// 只有认领成功者会清理由它自己刚建的半成品目录。
		await fsp.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
		throw e;
	}
}

/**
 * **只同步随包插件层**：按种子顶层条目就地覆盖，不再 rename 整个 profile 目录。
 *
 * ★ 2026-11-24 真机：dsh runtime 从 `0.2.2-rc.2` 升到 `0.2.2-rc.5` 时，旧 keepAlive Host
 *   仍占着 `.vssaros-dev/dsh-home/profiles/vssaros`；原来的「整目录 rename 成 .bak」在
 *   Windows 上直接 `EPERM: operation not permitted, rename ...` ⇒ Host 起不来 ⇒
 *   桌面窗口停在「正在加载 dsh 桌面界面…」。改成就地写文件后不再要求目录可移动。
 *
 * - 先校验种子 `package.json`，坏种子绝不写 profile；
 * - 只覆盖种子**顶层**列出的条目；用户自有的其它文件/目录不枚举、不删除、原样保留；
 * - `node_modules` 等目录按真实字节跳过相同文件，变化项用并发复制覆盖，源符号链接按内容复制；
 * - profile 中已是链接的条目（shared junction）跳过，避免顺着链接写进安装目录；
 * - marker 由调用方仅在成功后写入；中途失败下次启动会重试，不会留下「已升级」假标记。
 */
export async function syncProfilePluginLayer(
	seedDir: string,
	profileDir: string,
	// 注入仅为让「复制失败」可被精确单测；生产用并发复制 / copyFile。
	copyEntry: (from: string, to: string, isDirectory: boolean) => Promise<void> = async (from, to, isDirectory) => {
		if (isDirectory) {
			await copyDirectoryConcurrently(from, to, { dereference: true, skipUnchanged: true, replaceLinkedTargets: true });
			return;
		}
		await fsp.mkdir(dirname(to), { recursive: true });
		await copyFileWithRetry(from, to, { skipUnchanged: true, replaceLinkedTargets: true });
	},
): Promise<{ restoredUserData: string[] }> {
	// 坏种子不许在 profile 里留下一个会被误认成「已同步」的混合状态。
	const seedManifest = JSON.parse(await fsp.readFile(join(seedDir, 'package.json'), 'utf8'));
	if (Object.prototype.toString.call(seedManifest) !== '[object Object]') {
		throw new Error(`profile seed manifest is invalid: ${join(seedDir, 'package.json')}`);
	}
	const seedEntries = (await fsp.readdir(seedDir, { withFileTypes: true }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const seedNames = new Set(seedEntries.map(entry => entry.name));
	await fsp.mkdir(profileDir, { recursive: true });
	const profileEntries = await fsp.readdir(profileDir);
	const restoredUserData = profileEntries.filter(name => !seedNames.has(name)).sort();

	for (const entry of seedEntries) {
		const from = join(seedDir, entry.name);
		const to = join(profileDir, entry.name);
		// shared profile 的 node_modules 是指向种子的 junction；跳过即可天然对齐新版本。
		const targetStat = await fsp.lstat(to).catch(() => undefined);
		if (targetStat?.isSymbolicLink()) {
			continue;
		}
		// stat 跟随链接，拿到种子条目真实形态；dereference 复制避免 Windows 非管理员建 symlink。
		const sourceStat = await fsp.stat(from);
		const isDirectory = sourceStat.isDirectory();
		if (targetStat && targetStat.isDirectory() !== isDirectory) {
			await fsp.rm(to, { recursive: true, force: true }).catch(() => undefined);
		}
		await copyEntry(from, to, isDirectory);
	}
	return { restoredUserData };
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
