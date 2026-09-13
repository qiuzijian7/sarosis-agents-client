/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 发布 manifest 组装 —— **纯函数**（`MarketplaceService.publish` 的第 1 步）。
 *
 * 抽出的动机（2026-09-11）：`publish()` 的这段组装此前内联在 service 里，导致
 * **`visibility` / `tags` / `useGuide` 被静默丢弃** —— 发布弹窗收集了、`IPublishOptions`
 * 也声明了，但组装时只合并了 name/version/description/category/author，于是
 * 「可见性 / 标签 / 使用指南」在商城侧永远为空（只写回本地 workflow.json）。
 * 内联代码无法单测（service 依赖 DI + 网络），缺陷因此长期无人发现。
 *
 * 现在它是纯函数，有 `test/browser/publishManifest.test.ts` 锁定：
 *  - 三个元数据字段**显式传入才覆盖**（未传保留 manifest 既有值）——
 *    避免「只改描述的二次发布」把之前填好的可见性/标签清空；
 *  - author 三级兜底：opts > manifest > 当前登录用户；
 *  - agent 包才带 skillRefs / mcpRefs。
 */

import type { PackageManifest } from '../../common/packageInstaller.js';
import type { IPublishOptions } from '../../common/marketplace.js';

/**
 * 组装最终上传的 manifest（会写进 tar 包内的 `manifest.json`）。
 *
 * @param base            installer.preparePack 产出的 manifest（含 kind/id/name/version…）
 * @param opts            发布弹窗传入的覆盖项（IPublishOptions）
 * @param fallbackAuthor  显式 author 缺失时的兜底（通常是当前登录用户；调用方负责解析）
 */
export function buildPublishManifest(
	base: PackageManifest,
	opts: IPublishOptions,
	fallbackAuthor?: string,
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		...base,
		name: opts.name || base.name,
		version: opts.version || base.version,
		description: opts.description ?? base.description,
		category: opts.category ?? base.category,
		// 三级兜底：显式 override > manifest 自带 > 当前登录用户
		// （skill 自动上传等路径不传 author，也能落到登录者身份）
		author: opts.author ?? base.author ?? fallbackAuthor,
		// ── 以下三项曾在此处被丢弃（见文件头注释）──
		...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
		// 空数组视为「未填写」：不覆盖 manifest 既有 tags（否则二次发布会被清空）
		...(opts.tags !== undefined && opts.tags.length > 0 ? { tags: [...opts.tags] } : {}),
		...(opts.useGuide ? { useGuide: opts.useGuide } : {}),
	};
	// 关联包（仅 agent 类型有意义）
	if (base.kind === 'agent') {
		if (opts.skillRefs?.length) { out.skillRefs = opts.skillRefs; }
		if (opts.mcpRefs?.length) { out.mcpRefs = opts.mcpRefs; }
	}
	return out;
}
