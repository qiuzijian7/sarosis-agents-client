/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 发布版本号工具 —— 商城发布流程共用的纯函数（无服务依赖，可单测）。
 *
 * 覆盖：
 *  - semver 比较 / patch 递增
 *  - 基于商城远端包信息建议下一版本号
 *  - 发布前版本号校验（格式 / 历史版本查重 / 必须大于 latest）
 *  - 版本冲突错误识别（驱动自动递增重试）
 */

/** 解析 x.y.z → [x, y, z]；非法返回 undefined */
export function parseSemver(v: string): [number, number, number] | undefined {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
	if (!m) { return undefined; }
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** semver 比较：a > b 返回正数，相等 0，a < b 返回负数；非法版本按字符串比较兜底 */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) { return a.localeCompare(b); }
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) { return pa[i] - pb[i]; }
	}
	return 0;
}

/** patch 号 +1（1.0.0 → 1.0.1）；非 semver 原样返回 */
export function bumpPatch(version: string): string {
	const p = parseSemver(version);
	if (!p) { return version; }
	return `${p[0]}.${p[1]}.${p[2] + 1}`;
}

/** 远端包的最小版本信息（getPackage 返回的子集，便于 mock 测试） */
export interface IRemoteVersionInfo {
	readonly latestVersion?: string;
	readonly versions?: readonly { readonly version: string }[];
}

/** 建议下一版本号：有 latest 则 patch+1，否则 1.0.0 */
export function suggestNextVersion(remote: IRemoteVersionInfo | undefined): string {
	const latest = remote?.latestVersion;
	return latest ? bumpPatch(latest) : '1.0.0';
}

/**
 * 发布前校验版本号。
 * @returns 错误消息（应提示给用户）；null 表示通过。
 */
export function validatePublishVersion(version: string, remote: IRemoteVersionInfo | undefined): string | null {
	const v = version.trim();
	if (!v) { return '请输入版本号'; }
	if (!parseSemver(v)) { return `版本号 "${v}" 格式不正确，应为 x.y.z 格式（如 1.0.0）`; }
	if (!remote) { return null; }

	// 历史版本查重（含已下架的，防止覆盖 sha256 不一致的同号版本）
	if (remote.versions?.some(ver => ver.version === v)) {
		return `版本 v${v} 已存在于商城，请递增版本号后重试`;
	}
	// 必须大于 latest（服务端亦会强校验，客户端提前拦截）
	if (remote.latestVersion && compareSemver(v, remote.latestVersion) <= 0) {
		return `版本号必须大于商城当前最新版本 v${remote.latestVersion}`;
	}
	return null;
}

/** 判断发布错误是否属于"版本冲突"（可自动递增重试） */
export function isVersionConflictError(message: string): boolean {
	return /已存在|already exists|版本.*冲突|conflict/i.test(message);
}
