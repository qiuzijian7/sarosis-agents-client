/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件启停的落盘：改**当前 profile 的 `package.json`** 里的 `dsh.profile.bundles`
 * （`<DSH_HOME>/profiles/<profile>/package.json`）—— 这是 dsh 原生的「是不是这个组合的一部分」，
 * 见 `common/dshPluginActivation.ts` 的口径说明。不做任何自建状态文件（避免第二真源）。
 *
 * 目录由调用方以回调给出（profile 随 Host 启动设置变化），真正读写时再解析；
 * 纯逻辑（解析 / 增删 / 序列化 / 禁停名单）在 `common/dshPluginActivation.ts`。
 */

import { promises as fsp } from 'fs';
import { join } from '../../../../base/common/path.js';
import { DshHmrState, isBundleDisableForbidden, parseHmrPatchState, parseProfileBundles, serializeProfilePackageJson, setBundleEnabled, setRowDisabledOverride } from '../common/dshPluginActivation.js';

export class DshPluginActivationStore {

	constructor(
		/** 当前 profile 目录（惰性解析：Host 启动后才确定 profile 与 DSH_HOME）。 */
		private readonly _profileDir: () => string,
		private readonly _log: (line: string) => void,
	) { }

	private _file(): string {
		return join(this._profileDir(), 'package.json');
	}

	/** 读 profile 的 package.json；缺失 / 损坏时返回 undefined（调用方据此报"profile 尚未创建"）。 */
	async read(): Promise<Record<string, unknown> | undefined> {
		try {
			const parsed = JSON.parse(await fsp.readFile(this._file(), 'utf8'));
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
		} catch {
			return undefined;
		}
	}

	/** 当前组合里的 bundle 列表（读不到时为空）。 */
	async listBundles(): Promise<readonly string[]> {
		return parseProfileBundles(await this.read());
	}

	/**
	 * HMR 状态：读 profile 的 `cordis.patch.yml`，看 `hmr` 行是否被显式覆盖。
	 * `unknown` = patch 里没有该条目（条目由 base bundle 提供，launcher 提供 profileContext 时启用）。
	 */
	async hmrState(): Promise<DshHmrState> {
		try {
			return parseHmrPatchState(await fsp.readFile(join(this._profileDir(), 'cordis.patch.yml'), 'utf8'));
		} catch {
			return 'unknown';
		}
	}

	/**
	 * **行级**启停的文件级通路：改当前 profile 的 `cordis.patch.yml`（写/删某个条目的 `disabled` 覆盖）。
	 *
	 * 为什么需要：Host 的实时重组在 VsSaros 的启动路径上**必然**失败（README 4.51——dsh 的
	 * `reconcileProfilePatches()` 要求 root Include entry），没有这一路，"禁用某一行"就是**白点**。
	 * 与 {@link setEnabled}（改 bundles）同源：写盘，由 HMR 或下次启动生效；`changed:false` = 幂等无变更。
	 * 落盘形态由纯函数 {@link setRowDisabledOverride} 决定（与 dsh 自己写的 `disabled: <!enabled>` 一致）。
	 */
	async setRowEnabled(rowId: string, enabled: boolean, moduleName?: string): Promise<{ readonly changed: boolean }> {
		const file = join(this._profileDir(), 'cordis.patch.yml');
		let before: string | undefined;
		try {
			before = await fsp.readFile(file, 'utf8');
		} catch {
			before = undefined;
		}
		const { text, changed } = setRowDisabledOverride(before, rowId, enabled, moduleName);
		if (!changed) {
			return { changed: false };
		}
		try {
			// 与 dsh 写 profile patch 同口径：新建时 0o600（它是 `writeFileAtomic(path, …, { mode: 384 })`）
			await fsp.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
		} catch (e) {
			throw new Error(`写入 profile 组合失败（${file}）：${String((e as Error)?.message ?? e)}`);
		}
		this._log(`profile row: ${rowId} ${enabled ? 'enabled' : 'disabled'}`);
		return { changed: true };
	}

	/**
	 * 启停某个包（改 `dsh.profile.bundles`）；返回本次是否真的写了盘（用于界面判断"要不要重载"）。
	 * 抛错的都是"调用方能理解并展示"的情形：profile 未创建 / 该包不可停用 / 写盘失败。
	 */
	async setEnabled(pluginName: string, enabled: boolean): Promise<{ readonly changed: boolean }> {
		const name = pluginName.trim();
		if (!enabled && isBundleDisableForbidden(name)) {
			throw new Error(`${name} 是 Host 运行所必需（基础组合 / 控制桥），不能停用`);
		}
		const pkg = await this.read();
		if (!pkg) {
			throw new Error('profile 尚未创建（或 package.json 不可读）：先启动一次 Host 再改启停');
		}
		const { packageJson, changed } = setBundleEnabled(pkg, name, enabled);
		if (!changed) {
			return { changed: false };
		}
		const file = this._file();
		try {
			await fsp.writeFile(file, serializeProfilePackageJson(packageJson), 'utf8');
		} catch (e) {
			throw new Error(`写入 profile 组合失败（${file}）：${String((e as Error)?.message ?? e)}`);
		}
		// dsh-hmr 会在 profile manifest 的 bundles 列表变化时串行热重载（README：
		// "manifest notifications reload only when the ordered dsh.profile.bundles list changes"）；
		// HMR 未启用时改动要重启 Host 才生效。
		this._log(`profile bundles: ${name} ${enabled ? 'added' : 'removed'}`);
		return { changed: true };
	}
}
