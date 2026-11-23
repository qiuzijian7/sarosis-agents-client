/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级链路**统一的版本比较真源**（2026-11-23）。
 *
 * 背景：此前三处各有一套口径 —— `dshAppUpdate.compareVersions`（按 `[.+-]` 切段且只取前 4 段，
 * 预发布后缀被吞掉）、`dshPluginVersionAudit.isVersionNewer`（正式版 > 预发布、脏值保守）、
 * `dshBundledPlugins.comparePluginVersions`（把 `rc.2` 当数字段 ⇒ `0.2.0-rc.2` 被判**大于**
 * `0.2.0`）⇒ 同一个版本号在「能不能升」「徽标说升级还是改回」上可能给出相反结论 ✗。
 *
 * 口径（语义化版本，够用且保守）：
 *  · 数字段逐段按**数值**比，缺段按 0 ⇒ `1.0` == `1.0.0`，`2.2.9` < `2.2.10`；
 *  · `+build` 元数据不参与比较（构建批次不同不是版本高低）；
 *  · 主版本相同时：**正式版 > 预发布**；预发布按 `.` 分段，数字段按数值、非数字段按字典序，
 *    数字段小于非数字段，前缀相同时段多者更大；
 *  · 读不懂的版本 ⇒ `compareVersions` 返回 0、`isVersionNewer` 返回 false（不猜方向：
 *    宁可不升 / 宁可多装一次，也别把用户降级）。
 *
 * ⚠ 零 VS Code 依赖、零 IO：宿主 / 主进程 / 页面桥校验都能直接复用；
 *   各旧模块保留同名导出做**兼容投影**，调用方无需改动。
 */

export interface IParsedVersion {
	readonly nums: readonly number[];
	/** 预发布标识（不含 `-`；`+build` 元数据已去掉）。 */
	readonly pre?: string;
}

/** 解析版本；格式不认识一律返回 `undefined`（由调用方决定保守口径）。 */
export function parseVersion(value: string | undefined): IParsedVersion | undefined {
	const raw = String(value ?? '').trim();
	if (!raw) {
		return undefined;
	}
	const withoutBuild = raw.split('+')[0];
	const dash = withoutBuild.indexOf('-');
	const core = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
	const pre = dash >= 0 ? withoutBuild.slice(dash + 1) : undefined;
	const segs = core.split('.');
	if (!segs.length || segs.some(seg => !/^\d+$/.test(seg))) {
		return undefined;
	}
	return { nums: segs.map(Number), ...(pre ? { pre } : {}) };
}

/** 比较预发布段；`undefined` 表示正式版（比任何预发布都大）。 */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
	if (a === b) {
		return 0;
	}
	if (!a) {
		return 1;
	}
	if (!b) {
		return -1;
	}
	const as = a.split('.');
	const bs = b.split('.');
	for (let i = 0; i < Math.max(as.length, bs.length); i++) {
		const ax = as[i];
		const bx = bs[i];
		if (ax === undefined) {
			return -1;
		}
		if (bx === undefined) {
			return 1;
		}
		const an = /^\d+$/.test(ax);
		const bn = /^\d+$/.test(bx);
		if (an && bn) {
			const d = Number(ax) - Number(bx);
			if (d !== 0) {
				return d > 0 ? 1 : -1;
			}
		} else if (an !== bn) {
			return an ? -1 : 1;
		} else if (ax !== bx) {
			return ax > bx ? 1 : -1;
		}
	}
	return 0;
}

/**
 * 比较版本：`-1` = a 更旧、`0` = 相同/无法判断、`1` = a 更新。
 * ⚠ 脏值返回 0（不猜方向）⇒ `decideAppUpdate` 会落到「已是最新」，不会误升级。
 */
export function compareVersions(a: string | undefined, b: string | undefined): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) {
		return 0;
	}
	for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
		const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
		if (d !== 0) {
			return d > 0 ? 1 : -1;
		}
	}
	return comparePrerelease(pa.pre, pb.pre);
}

/**
 * `a` 是否严格比 `b` 新。读不懂的版本（含字母 / 格式异常）⇒ false：
 * 保守口径，不据此跳过安装，宁可多装一次也别漏装（沿用 `dshPluginVersionAudit` 的原语义）。
 */
export function isVersionNewer(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b || a === b) {
		return false;
	}
	if (!parseVersion(a) || !parseVersion(b)) {
		return false;
	}
	return compareVersions(a, b) > 0;
}
