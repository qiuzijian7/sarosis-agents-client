/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * pinned viewlets 存储的**纯字符串净化**（无平台 / 无 DOM 依赖 ⇒ 可被单测直接加载）。
 *
 * 存储键：`workbench.activity.pinnedViewlets2`（`workbench/browser/parts/activitybar/activitybarPart.ts:54`）
 * 与 `workbench.agentsession.pinnedViewlets2`（`sessions/browser/parts/sidebarPart.ts:108`，sessions 布局
 * 把图标条折进侧栏，另有一套前缀）。值是
 * `[{ id, name, icon?, views, pinned, order, visible, isBuiltin }, ...]`，
 * 读写见 `workbench/browser/parts/paneCompositeBar.ts:686-716`。
 *
 * 为什么要擦：注销一个动态容器会同步触发 `PaneCompositeBar.saveCachedViewContainers()`
 * （`paneCompositeBar.ts:603-631`），把刚注销的 id 以 `visible:false` 写回存储（`:562, 626`）。
 * 图标确实不再渲染，但**同名容器下次注册时会在原 order 位置"复活"且不会重新 pin**
 * （`:357-360` 命中 storage 缓存）。
 */

/** 净化结果：写回用的值 + 变化前后的条数（供日志）。 */
export interface IPinnedViewletsPurge {
	/** 过滤后的 JSON，可直接写回同一存储键。 */
	readonly value: string;
	/** 过滤前的条目数。 */
	readonly before: number;
	/** 过滤后的条目数。 */
	readonly after: number;
}

/**
 * 从 pinned viewlets 的 JSON 里剔除 `containerId` 的**全部**条目。
 *
 * 返回 `undefined` 表示**不必写回**：值为空、不是合法 JSON、不是数组、或压根没有该 id。
 * 这样调用方只需在一处判空，也**绝不会**把无法解析的存储内容当成空数组覆盖掉。
 */
export function purgePinnedViewlets(json: string | undefined, containerId: string): IPinnedViewletsPurge | undefined {
	if (!json) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}

	if (!Array.isArray(parsed)) {
		return undefined;
	}

	const kept = parsed.filter(entry => (entry as { readonly id?: unknown } | null | undefined)?.id !== containerId);
	if (kept.length === parsed.length) {
		return undefined;
	}

	return { value: JSON.stringify(kept), before: parsed.length, after: kept.length };
}
