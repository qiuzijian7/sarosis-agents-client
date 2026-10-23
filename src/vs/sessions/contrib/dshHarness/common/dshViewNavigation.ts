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
 * 取 `pathname` 所属的**模块子树**（`/x/<module>`），不是模块页就返回 `undefined`。
 *
 * 例：`/x/memory/` / `/x/memory/detail` / `/x/memory/detail?x=1` ⇒ `/x/memory`；
 *     `/x/memoryx/` ⇒ `/x/memoryx`（**不同**子树，不会误放行 ✓）；`/` ⇒ `undefined`；`/myspace` ⇒ `undefined`。
 *
 * 为什么按两级取：dsh 的模块页统一挂在 `/x/<module>/…` 下 ⇒ 前缀就是"这个页面属于哪个模块"的天然边界 ✓。
 */
function moduleSubtree(pathname: string | undefined): string | undefined {
	if (!pathname) { return undefined; }
	const m = /^\/x\/([^/]+)/.exec(pathname);
	return m ? `/x/${m[1]}` : undefined;
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
	 * **当前主 frame 的 pathname**（调用方传 `new URL(wc.getURL()).pathname`）★ 2026-10-23。
	 *
	 * 为什么要它：真机「记忆库」页的「查看完整记忆」按钮 `location.href='./detail'` **点了没反应** ⇒
	 * 日志坐实：`blocked a main-frame navigation to /x/memory/detail` —— 就是这条"同源只放行 `/`"把
	 * **同一模块的下钻**一起拦了 ✗✗（那个子路由插件**真的**在服务 ⇒ 拦在导航层）。
	 *
	 * ⚠ 不能只看"视图表面"（我第一版只对 `plugin-page` 放行，结果**不够**）：真机上这个记忆库页被宿主
	 * `loadURL` 装进的是 **chat 视图**（id `dsh-desk-chat-*`）的主 frame ⇒ 表面判据覆盖不到 ✗。
	 * ⇒ 改成**按当前 URL 判**：目标只要还在**当前文档所在的同一模块子树**（`/x/<module>/…`）内就放行 ✓
	 *   —— 这样"记忆库 → 记忆详情"能走，而"从 `/` 或别的模块页跳到 `/x/dashboard/`"照旧拦 ✓
	 *   （后者正是 2026-10-23 那个「主页突然变成会话页」的 bug ✗）。
	 */
	currentPathname?: string,
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
	// ★ 2026-10-23：**同一模块子树内**的同源导航放行 —— 否则模块页的下钻会被拦，表现就是"点了没反应"
	//   （真机日志：`blocked a main-frame navigation to /x/memory/detail`；那个子路由插件真的在服务 ✗✗）。
	//   仍**不放行**跨模块 / 从根路径跳模块页的同源地址（`/` → `/x/dashboard/` 照旧拦 ✓）；
	//   查询串不进 pathname ⇒ `?tool=export-json` 这类下载动作也照常放行 ✓。
	const currentModule = moduleSubtree(currentPathname);
	if (currentModule && currentModule === moduleSubtree(target.pathname)) { return 'allow'; }
	return 'block';
}
