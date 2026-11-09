/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **内置 profile 种子的定位与复制**（首启专用）。
 *
 * ★★ 2026-11-09：**收敛成单版本模型**后，本模块从「profile ↔ runtime 版本一致性」大幅瘦身。
 *
 * 历史：这里曾有 marker 读写、`planProfileRuntimeSync`（keep/stamp/init/rebuild/warn-no-seed）、
 * `profileRebuildPending` 判定，服务于 `<userData>/dsh-runtime/state.json` 的多版本指针与
 * 「切版本时按新版本种子重建 profile」。真机上这套机制带来两次 F5 崩溃（11-07 老 profile
 * 跑新 runtime；11-09 重建时 Windows symlink EPERM），产品已明确不需要用户自由切 runtime：
 *
 *   · dsh 版本由 `dsh-plugins/dsh-compat.json` 的 `bundled` **构建期 pin 死**，升级 = 应用发版；
 *   · **`userData/dsh-home` 永不覆盖** —— profile 一旦建好就不再因版本变化被改写/重建；
 *   · 兼容性由构建期（check-dsh-release.mjs）+ 启动期既有的一致性检查负责：
 *     `repairProfileDeps` / `repairBundledPluginFiles` / `_ensureProfileBundles` / 插件安装链。
 *
 * ⇒ 现在只在**首次创建 profile** 时用到本模块：找到与 bundled 版本同名的种子并整目录复制。
 *   文件名沿用历史（`dshProfileRuntimeSync.ts`），避免无谓的 import/测试路径 churn。
 */

import { existsSync, promises as fsp } from 'fs';
import { join } from '../../../../base/common/path.js';

/**
 * 把 profile 种子**整目录**复制到目标位置（仅首启、目标不存在时调用）。
 *
 * ★★ 2026-11-09（真机：首次从仓库种子建 profile 直接崩溃）：
 *   `fsp.cp(seedDir, destDir, { recursive: true })` 默认 `dereference: false` ⇒ **按符号链接原样复制**。
 *   仓库里的种子 `node_modules/.pnpm/` 下有 **6097 个 pnpm symlink**，Windows 非管理员创建 symlink
 *   会 `EPERM: operation not permitted, symlink …`。
 *   打包版种子以 `npm_config_package_import_method=copy` 生成（真文件），**不能假设种子一定无链接**。
 *
 * ⇒ `dereference: true`：跟随链接复制成真实文件/目录，不需要任何特殊权限，任何形态的种子都能搬 ✓。
 *   代价是解引用后体积更大、复制更慢（实测 575MB → 3.1GB / 约 10 分钟），但只在首启发生一次；
 *   `_repairSeededStoreMetadata` 随后会校正 `.modules.yaml`。
 */
export async function copyProfileSeed(seedDir: string, destDir: string): Promise<void> {
	await fsp.cp(seedDir, destDir, { recursive: true, dereference: true, force: true });
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
