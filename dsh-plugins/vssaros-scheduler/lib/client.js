// CLIENT_BUILD_STAMP: 2026-10-28 native workbench (0.3.0 r3: two-stage inject) —— 改了子块就把这一行也动一下（?rev 随入口 mtime 变）
// @vssaros/dsh-scheduler — 客户端入口（2026-10-28 改造：工作台内容 = 官方原生「定时任务」页）。
//
// ── 这个入口现在只做三件事 ────────────────────────────────────────────────
//   ① 注入一条极小的容器样式（原生页根节点是 height:100%，需要外层 flex:1 才撑满）；
//   ② 装载子块 `client.native.js`（官方 `@deepseek-ai/dsh-client-ui-schedule` 的 chunk 副本，
//      MIT；只把官方 `apply()` 换成「注册一个工作台」，见该文件头注释）；
//   ③ 把插件的 ctx 交给它（`install(ctx)`）。
//
// ── 为什么搬进子块而不是写在这里 ──────────────────────────────────────────
// 用户 2026-10-28：「dsh 侧增加定时任务工作台，**复用原生的定时任务 UI**」。
// 官方那套 UI（左侧搜索/筛选/任务行 + 右侧详情含改时间、投递历史）是闭包组件，
// chunk 只导出 `apply`/`inject` ⇒ 外部 require 不到 ⇒ 只能原样搬运（子块 328KB，懒装载）。
// 之前自绘的 `vssSched*` 列表已整体退役（同一个工作台 id / 主页卡片 / 页签入口不变）。
//
// ⚠ 装载器只认 `client.*.js` 形状的子块（相对请求会被拒）⇒ 子块必须叫 `client.native.js`；
//   改子块后要动一下本入口（守卫 `check-chat-surface-chunks.mjs` 的 mtime 规则）+ 升版本。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-scheduler',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const STYLE_ID = 'vssaros-scheduler-host';

		/** 与原生页/外框对接的最小样式（视觉全在官方 CSS 与共享层里，这里只有布局）。 */
		const CSS = `
.vssWbNativeRoot { display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; height:100%; }
.vssWbNativeRoot > * { flex:1; min-height:0; min-width:0; }
`;

		function maintainStyles() {
			if (document.getElementById(STYLE_ID)) { return undefined; }
			const el = document.createElement('style');
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => el.remove();
		}

		function apply(ctx) {
			ctx.effect(maintainStyles, 'vssaros-scheduler: styles');
			// ★ 可选装载：运行时没有 `require.async`（老宿主）⇒ 只是没有新界面，不能把整个插件搞挂。
			try {
				if (typeof require.async === 'function') {
					require.async('./client.native.js').then((part) => {
						if (part && typeof part.install === 'function') { part.install(ctx); }
					}).catch((error) => {
						console.warn('[vssaros-scheduler] 原生定时任务界面装载失败：' + String((error && error.message) || error));
					});
				} else {
					console.warn('[vssaros-scheduler] 运行时没有 require.async ⇒ 原生定时任务界面装载不了');
				}
			} catch (error) {
				console.warn('[vssaros-scheduler] 原生定时任务界面装载失败：' + String((error && error.message) || error));
			}
			return undefined;
		}

		module.exports.apply = apply;
		// 没有硬依赖：`desktopWorkbenches` 在子块里走可选注入（缺了不出现新界面，而不是让 web boot pending）。
		module.exports.inject = [];
		return module.exports;
	},
});
