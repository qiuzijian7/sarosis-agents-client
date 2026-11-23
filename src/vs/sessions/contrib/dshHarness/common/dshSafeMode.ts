/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 标题栏「以安全模式重启」的纯判据（2026-11-23）。
 *
 * ⚠ 与 dsh-desktop 官方的差别（如实说明，别让用户以为是同一件事）：
 *   官方是**启动期隔离 Profile**（重启后只加载内置插件）；本仓没有启动期隔离能力，
 *   所以这里落地为**可逆**的等价动作：停用可安全停用的第三方插件 → 重启 Harness →
 *   菜单提供「恢复插件并重启」按记录还原。两者都让「第三方插件不生效」，但本仓
 *   作用的是 VsSaros 侧插件激活（ActivityBar / 模块计划），不是 Host 组合包。
 *
 * ⚠ 绝不停用：官方 / 内置（`@vssaros/`、`@deepseek-ai/`）、当前 dsh 页面所在插件、
 *   以及任何形状可疑的包名 ⇒ 否则停完页面直接不可用（本仓高频缺陷形态）。
 */

export const DSH_SAFE_MODE_STORAGE_KEY = 'dsh.safeMode.disabledPlugins';

const BUILTIN_PREFIXES = ['@vssaros/', '@deepseek-ai/'];
const MAX_PLAN = 100;

/** 包名形状：npm 名（可选 scope），只允许字母数字与 `._-@/`，长度上限 200。 */
function validName(name: unknown): name is string {
	return typeof name === 'string' && name.length > 0 && name.length <= 200
		&& /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}

export function isThirdPartyPlugin(name: unknown, protectedNames: readonly string[] = []): name is string {
	if (!validName(name)) {
		return false;
	}
	if (BUILTIN_PREFIXES.some(prefix => name.startsWith(prefix))) {
		return false;
	}
	return !protectedNames.includes(name);
}

/** 本次要停用的插件名（已启用的第三方插件；去重、限长、形状校验）。 */
export function safeModeDisablePlan(
	plugins: readonly { readonly name: string; readonly enabled?: boolean }[] | undefined,
	protectedNames: readonly string[] = [],
): string[] {
	const out: string[] = [];
	for (const p of Array.isArray(plugins) ? plugins : []) {
		if (!p || p.enabled === false) {
			continue;
		}
		if (!isThirdPartyPlugin(p.name, protectedNames) || out.includes(p.name)) {
			continue;
		}
		out.push(p.name);
		if (out.length >= MAX_PLAN) {
			break;
		}
	}
	return out;
}

/** 恢复清单的信任边界：从 storage 读出来的 JSON 必须逐项白名单重建。 */
export function validateSafeModeBackup(value: unknown, protectedNames: readonly string[] = []): string[] {
	let raw: unknown = value;
	if (typeof raw === 'string') {
		try { raw = JSON.parse(raw); } catch { return []; }
	}
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: string[] = [];
	for (const name of raw.slice(0, MAX_PLAN)) {
		if (isThirdPartyPlugin(name, protectedNames) && !out.includes(name)) {
			out.push(name);
		}
	}
	return out;
}
