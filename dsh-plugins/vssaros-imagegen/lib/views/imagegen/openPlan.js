/**
 * 「打开某个路由」的**落点决策**（纯函数 ⇒ 可被探针直接测）。
 *
 * ★ 为什么要它（2026-10-22 用户报「桥不可用，无法打开画布」）：
 *   **页面桥（`window.vssarosDsh`）只在 IDE 的 webview 里有** —— 它由 IDE 侧的
 *   `preload-dshView.ts` 注入。而 **dsh 客户端窗口**（VsSaros Desktop）里的插件页
 *   是 dsh 自己加载的 webview ⇒ **没有 preload ⇒ 没有页面桥**。
 *   ⇒ 原来"打开画布"只走 `bridge.openModulePage(route)`（在 IDE 编辑区开页签），
 *     在 dsh 窗口里就是**点了没反应**（用户看到的黄标就是这个）。
 *
 * ★ 但画布页**本来就不需要页面桥**：它是 Host 的同源 HTTP 路由（`/x/imagegen/canvas/`），
 *   页面只用同源 fetch ⇒ **同窗口直接导航就能打开** ✓。
 *   ⇒ 决策分三种落点：
 *     · `ide`    —— 有页面桥：在 IDE 编辑区开一个页签（保持原行为 ✓）。
 *     · `self`   —— 无页面桥：**同窗口导航**到该路由（画布页/工作台页都能开 ✓）。
 *     · `current`—— 无页面桥且目标就是当前页：什么都不用做（只提示一句）。
 *
 * ⚠ 落点差别对用户是可见的（"同窗口打开"会离开当前页）⇒ 所以要**如实说**，不静默跳。
 */

/** 工作台页路由。 */
export const WORKBENCH_ROUTE = '/x/imagegen/';
/** 画布页路由。 */
export const CANVAS_ROUTE = '/x/imagegen/canvas/';

/**
 * @param {string} route 目标路由（插件页路由）
 * @param {boolean} hasBridge 页面桥在不在
 * @returns {{mode: 'ide'|'self'|'current', route: string, note: string}}
 */
export function planOpenRoute(route, hasBridge) {
	const target = String(route || '');
	if (hasBridge) {
		return { mode: 'ide', route: target, note: '' };
	}
	if (target === WORKBENCH_ROUTE) {
		// 当前页就是工作台（dsh 窗口里打开的插件页）⇒ 没什么可"打开"的。
		return { mode: 'current', route: target, note: '已经在工作台了（当前窗口）' };
	}
	return {
		mode: 'self',
		route: target,
		note: '这个窗口没有 IDE 页面桥（dsh 客户端窗口自带）⇒ 已在本窗口打开',
	};
}

