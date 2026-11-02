// @vssaros/dsh-sessions — client half：历史会话**工作台**（注册式 React，身份 `vssaros/sessions`）
//
// ★ 2026-11-02（承载收口 P1，见 doc/workbench-carrier-consolidation.md）：
//   原来「会话」只有 SSR 页面（`/x/sessions/`）：dsh 窗口的页签条用 iframe 打开它。
//   现在多了本入口 + 子块 `client.history.js`，它把工作台注册进宿主服务 `desktopWorkbenches`
//   （身份 `vssaros/sessions`）⇒ 页签条里 `/x/sessions/` 那一条**自动**从 iframe 换成宿主渲染
//   （导航的 `wbFor()` 按「`/x/<m>/` → `vssaros/<m>`」认；没注册就回落 iframe，所以这是可回退的双跑）。
//
// ⚠ 旧页面**不能删**：`vssaros.activityBar`（IDE 左栏「历史会话（插件页）」）加载的仍是 `/x/sessions/` 的 SSR 页，
//   而且 `?view=tiles` 的「会话磁贴」入口也还在用它。本次迁的只是 dsh 窗口里的**列表视图**。
//
// 子块文件名必须是 `client.<名字>.js`（装载器只认这个形状）。
// ⚠ 规矩：改过任何 `client.*.js` 子块之后，**要再动一下这个入口**（守卫查 mtime ⇒ 漏了必红）——
//   否则浏览器会一直吃缓存里的旧 chunk ⇒ 用户看到旧界面。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-sessions',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/** 客户端插件体：装载工作台子块。装不上只影响这个工作台（回落 iframe），不拖垮别的。 */
		function apply(ctx) {
			const fail = (e) => {
				const why = String((e && e.message) || e);
				globalThis.__vssarosSessionsClient = Object.assign({}, globalThis.__vssarosSessionsClient, { workbenchFailed: why });
				console.warn(`[vssaros-sessions] 工作台组件装载失败（回落 iframe 页面）：${why}`);
			};
			globalThis.__vssarosSessionsClient = { loaded: true };
			try {
				if (typeof require.async !== 'function') { throw new Error('装载器没有 require.async（老运行时）'); }
				require.async('./client.history.js')
					.then((part) => { if (part && typeof part.install === 'function') { part.install(ctx); } })
					.catch(fail);
			} catch (e) {
				fail(e);
			}
			return undefined;
		}

		// 不写硬依赖：拿不到 `desktopWorkbenches` 只是「工作台不出现」，页面照旧可用（子块里是可选注入）。
		const inject = [];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
