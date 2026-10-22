/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 商城「外部发布源」的解析（★ 2026-10-22，纯函数 ⇒ 可单测）。
 * ============================================================
 *
 * 工作台（dsh 插件）的本体**不在商城服务器上** ⇒ 商城只登记「去哪里取」
 * （distribution：npm / github-release / github-source）⇒ 客户端要把它变成可安装的 spec ✓。
 *
 * 口径照 dsh 市场协议 v2（dsh-plugins/vssaros-market/lib/installTargets.js）：
 * - npm            -> name@version
 * - github-source  -> github:owner/repo#commit
 * - github-release -> 不在这里转 spec（要先下载 + 校验 sha256 ⇒ 那是「装」的活儿 ✓）
 *
 * ★ **绝不自动换来源**：登记的是 npm 就只走 npm ⇒ 换源会让用户装到与商城登记不同的东西 ✗。
 */

/** 外部发布源描述（字段口径同服务端 PackageDistribution）。 */
export interface IExternalDistribution {
	readonly type: 'npm' | 'github-release' | 'github-source';
	readonly name?: string;
	readonly url?: string;
	readonly sha256?: string;
	readonly bytes?: number;
	readonly commit?: string;
	readonly peerRange?: string;
}

/** 解析结果。 */
export interface IResolvedDistribution {
	/** 可直接交给 `dsh plugin add` 的 spec（npm / github-source 才有） */
	readonly spec?: string;
	/** 插件名（核对已装版本要用） */
	readonly name?: string;
	/** 需要先下载再装（github-release） */
	readonly needsDownload: boolean;
	/** 失败原因（解析不出来时） */
	readonly error?: string;
}

/**
 * 把 distribution 解析成可安装的 spec。
 *
 * @param distribution 服务端登记的发布源（缺省 = 走 tar.gz 下载通道 ⇒ 返回空结果）
 * @param version 目标版本（npm spec 需要它）
 */
export function resolveDistributionSpec(
	distribution: IExternalDistribution | undefined | null,
	version: string | undefined,
): IResolvedDistribution {
	if (!distribution) {
		return { needsDownload: false };
	}
	switch (distribution.type) {
		case 'npm': {
			const name = distribution.name;
			if (!name) {
				return { needsDownload: false, error: 'npm 发布源缺少 name（包名）' };
			}
			return { spec: version ? `${name}@${version}` : name, name, needsDownload: false };
		}
		case 'github-source': {
			const repo = distribution.name;
			if (!repo) {
				return { needsDownload: false, error: 'github-source 发布源缺少 name（owner/repo）' };
			}
			const commit = distribution.commit ? `#${distribution.commit}` : '';
			return { spec: `github:${repo}${commit}`, name: repo, needsDownload: false };
		}
		case 'github-release':
			// 要先下载 + 校验 sha256 ⇒ 交给安装器（它有下载能力）✓
			return { name: distribution.name, needsDownload: true };
		default:
			return { needsDownload: false, error: `未知的发布源类型：${String((distribution as { type: string }).type)}` };
	}
}

/**
 * 从一份商品详情里取出该版本的发布源。
 *
 * ⚠️ 取值顺序：**版本 manifest 优先，包级其次** ✓
 *   （同一个包的不同版本可能来自不同源 ⇒ 版本级才是准的 ✓）。
 */
export function distributionOfVersion(
	detail: {
		readonly distribution?: IExternalDistribution | null;
		readonly versions?: readonly { readonly version: string; readonly manifest?: { readonly distribution?: IExternalDistribution } }[];
	},
	version: string | undefined,
): IExternalDistribution | undefined {
	const fromVersion = version
		? detail.versions?.find(v => v.version === version)?.manifest?.distribution
		: undefined;
	return fromVersion ?? detail.distribution ?? undefined;
}
