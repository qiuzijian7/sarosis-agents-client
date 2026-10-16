/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「添加插件」的**安装通道选择**（纯函数；2026-10-13）。
 *
 * 为什么要单独一个模块 + 纯函数：这个判据有**两个**消费点（都在 `pluginsView.ts`）——
 * ① 真安装走哪条（`_dshInstallPlugin`）；② "取消"按钮要不要出现（只有商城那条能取消）。两处判据必须
 * 一致，否则就是"点了取消却没反应/按钮在但请求不存在"这类最难查的错觉 ✗（本仓同类事故见
 * `doc/` 里"行 id 就是行身份"那些）。写成纯函数就能被单测按**真值表**钉住 ✓。
 *
 * 三条通道（都装着同一个插件，差别在**谁来跑 pnpm** 与能力面）：
 *
 * | transport | 命令 | 实现 | 能力 | 全新 profile |
 * |---|---|---|---|---|
 * | `local` | `InstallLocalPlugin` | 主进程暂存 + `dsh plugin add` | 无进度/取消 | ✅ 可用 |
 * | `spec` | `InstallPluginSpec` | 主进程 `dsh plugin add <spec>` | 无进度/取消/**无构建脚本批准** | ✅ 可用 |
 * | `marketplace` | `InstallDshPlugin` | Host 内 `pluginManager.installBundle` | 有进度/取消/构建脚本批准（`pendingBuilds`） | ❌ `operation-error` |
 *
 * ⇒ 取舍：**能用主进程那条就用**（全新 profile 上只有它行得通），把商城那条留给"只有它能做"的情形 ——
 * 也就是 **`approvedBuilds`（批准构建脚本后重装）** 与 **git / tarball 等非注册表形态**。视图在 `spec`
 * 那条失败时会**回落到** `marketplace`（保住构建脚本批准这条能力，见 `_dshInstallPlugin` 的注释 ✓）。
 */

/** 安装走哪条通道。 */
export type DshInstallTransport = 'local' | 'spec' | 'marketplace';

/** 预检结果里与选路有关的两项（`IDshInspectResult` 的子集，避免本模块依赖视图层的类型 ✓）。 */
export interface IDshTransportInspect {
	/** spec 形态：`registry` / `path` / `git` / `tarball`（见 `IBridgeInspectResult.kind`）。 */
	readonly kind?: string;
	/** 预检给出的包名（`registry` 形态一定有；**没有名字就不能走 `spec` 那条**——装完要按它核对版本 ✓）。 */
	readonly name?: string;
}

/**
 * 选通道（纯函数，真值表见模块头）。
 *
 * `hasApprovedBuilds` = 调用方带了"已批准的构建脚本"（第二次点安装）⇒ **必须**走商城那条：
 * 批准构建脚本是 Host `pluginManager` 的能力，主进程那条做不到 ⇒ 走错了就是"点了允许还是没建"✗。
 */
export function dshInstallTransport(inspect: IDshTransportInspect | undefined, hasApprovedBuilds: boolean): DshInstallTransport {
	if (hasApprovedBuilds) {
		return 'marketplace';
	}
	if (inspect?.kind === 'path') {
		return 'local';
	}
	// 注册表规格：主进程那条能装（且全新 profile 上只有它行得通 ✓）；但**必须有名字**才敢走：
	// 装完读 `<profile>/node_modules/<name>/package.json` 核对，读不出名字就无从判定"真装上了"✗。
	if (inspect?.kind === 'registry' && !!inspect.name?.trim()) {
		return 'spec';
	}
	// 其余（git / tarball / 未知形态 / 注册表但没名字）：只有商城那条会解析它们、也能给进度与取消 ✓
	return 'marketplace';
}
