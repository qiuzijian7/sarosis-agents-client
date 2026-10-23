/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **dsh 视图的主 frame 导航决策**（2026-10-23 从 `dshViewHost` 里抽出来的纯逻辑）。
 *
 * 为什么值得单独一层：真机出过「主页显示过程中，page 突然被切换成了会话页」——
 * 根因是视图的**整个文档**被同源导航到了 `/x/dashboard/`（那个文档里我们的插件不加载、
 * 没有 composer ⇒ 白屏看门狗 45s 后把视图 reload 回客户端 ⇒ 用户看到"主页变成会话页"）。
 * 判据原先写在 `will-navigate` 里，**没法单测**（要真的 Electron 事件）⇒ 提到这里，
 * 让"哪种地址该放行 / 该拦 / 该丢给系统浏览器"变成可断言的表。
 *
 * 三条铁律：
 *  ① dsh 客户端是 **`/` 上的 SPA** —— 主 frame 只有根路径算合法；工作台页一律走 iframe
 *     （`?surface=editor|sideview`）⇒ 同源非根路径必须**拦**（拦了才不会被看门狗当成白屏 ✗）；
 *  ② 跨源的 http(s) 交给**系统浏览器**（不留在视图里）；
 *  ③ 非 http(s)（`javascript:` / `file:` / `about:` / 解析失败）一律**拦**，且**不**交出去 ——
 *     `openExternal` 拿到 `javascript:` 这类地址的行为不值得赌 ✓。
 */
export type DshMainFrameNavigationDecision =
	/** 留在视图里（只有同源 `/` 会走到这里） */
	| 'allow'
	/** 拦下来，**不要**交给系统浏览器 */
	| 'block'
	/** 拦下来，交给系统浏览器打开 */
	| 'external';

/**
 * `pathname` 是否落在 `route` 这棵**子树**里（含相等）。
 *
 * 例：`route='/x/memory/'` ⇒ 命中 `/x/memory/`、`/x/memory/detail`、`/x/memory/?a=1`（查询串不进 pathname）；
 * 不命中 `/x/memoryx`（避免前缀误判）、`/x/other`。
 */
function isUnderRoute(pathname: string, route: string): boolean {
	const base = route.endsWith('/') ? route : `${route}/`;
	return pathname === route || pathname === base || pathname.startsWith(base);
}

/** 与 `isSameOrigin` 同口径：协议 + 主机 + 端口（默认端口归一化由 URL 负责）。 */
function sameOrigin(a: URL, b: URL): boolean {
	return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

/**
 * 决定一次**主 frame** 导航怎么处理。
 *
 * @param rawUrl 目标地址（Electron 给的原始字符串）
 * @param connectionOrigin 当前 dsh Host 的 origin（`http://127.0.0.1:7583`）；
 *   连接还没建立时是 `undefined` ⇒ 任何导航都不留在视图里（与既有行为一致：
 *   没连上时视图里的地址本来就没有可信来源）。
 */
export function decideMainFrameNavigation(
	rawUrl: string,
	connectionOrigin: string | undefined,
	/**
	 * 本视图承载的**插件页路由**（如 `/x/memory/`）—— 只有 `plugin-page` 表面才该传（★ 2026-10-23）。
	 *
	 * 为什么要它：真机「记忆库」页的「查看完整记忆」按钮 `location.href='./detail'` **点了没反应** ⇒
	 * 根因就是这条规则"同源只放行 `/`"把插件页的**下钻**（`/x/memory/detail`）一起拦了 ✗✗
	 * （那个子路由插件**真的**在服务 ⇒ 拦在导航层）。
	 *
	 * ⚠ **只对 `plugin-page` 传**：`workbench` 表面加载的是 dsh 客户端根 `/`，它的 route 只是给页面内部用的
	 * （`desktopWorkbenches.open(...)`）⇒ 若也对它放行子树，就会退回"主页被整页导航成工作台页"那个 bug ✗
	 */
	viewRoute?: string,
): DshMainFrameNavigationDecision {
	if (!connectionOrigin) {
		// 没连上 Host：视图里的页面不可信 ⇒ 交给外部（与改动前 `!this._connection || …` 一致）
		return 'external';
	}
	let target: URL;
	let origin: URL;
	try {
		target = new URL(rawUrl);
		origin = new URL(connectionOrigin);
	} catch {
		return 'block';   // 解析不了就别放行（宁可拦住，也不要让未知地址占住视图 ✗）
	}
	const httpish = target.protocol === 'http:' || target.protocol === 'https:';
	if (!sameOrigin(target, origin)) {
		return httpish ? 'external' : 'block';
	}
	// 同源：根路径留在视图里（`/?token=…` 也是根 ⇒ 认证跳转照常 ✓）
	if (target.pathname === '/') { return 'allow'; }
	// ★ 2026-10-23：**插件页视图**允许它**自己路由子树内**的同源导航 —— 否则插件页的下钻会被拦，
	//   表现就是"点了没反应"（真机：`/x/memory/` 页上的「查看完整记忆」按钮 `location.href='./detail'` ✗✗）。
	//   仍不放行路由子树之外的同源地址（`/x/dashboard/` 这类整页导航照旧拦 ✓）。
	if (viewRoute && viewRoute !== '/' && isUnderRoute(target.pathname, viewRoute)) { return 'allow'; }
	return 'block';
}
