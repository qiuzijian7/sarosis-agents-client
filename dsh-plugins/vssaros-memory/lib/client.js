// 2026-10-26 touch：client.memory.js 详情页改用共享 wbToolbar（吸顶锚点收敛为 1 处）⇒ 入口置新。
// 2026-10-24 touch：client.memory.js 经变异测试改写后置新（chunk 守卫按 mtime 判）。
// 2026-10-24 touch：client.memory.js：补 @container ⇒ 入口置新（chunk 守卫按 mtime 判）。
// @vssaros/dsh-memory — 客户端入口（工作台重构 §5 步骤 2，2026-10-22）。
//
// 本包原先**没有客户端半**（页面是纯 SSR + 两个表单动作）。React 工作台来了之后需要入口：
// 它只做一件事 —— 把子块 `client.memory.js` 装进来（注册进宿主服务 `desktopWorkbenches`）。
// 2026-10-26（v0.6.6）：**记忆详情 = React 二级页**（同一工作台内 state 切换，10 个页签，
//   数据来自新增的 `GET /x/memory/api/detail?view=…`）⇒ 不再导航/不开窗/不需要桥 ✓
// 2026-10-24（历史）：曾改走宿主 `openModulePage`（原先只有 href ⇒
//   点击 = 主 frame 整页导航 ⇒ 被导航守卫拦 ⇒ "点了没反应"；详情现在开在编辑区标签页里）✓
// ⚠ 描述符必须与清单 `vssaros.workbench` **逐字段一致**（description / icon 也一样）：宿主快照直接取描述符、
//   **不回落到清单** ⇒ 漏写就是"注册表里那一项说明/图标是空的" ✗（2026-10-22 审计发现本包漏了 icon，
//   已在 `client.memory.js` 补 `codicon:database`；守卫 `dshPluginPackages` 也补了这条比对）。
// ★ 2026-10-22（UI 统一 §6.19）：组件改用**共享层** `wb-*` 原语（宿主注入一份样式表）——
//   自写 CSS 从 30 行压到 18 行（只留 hero 大数字、草稿列表、错误色），间距/圆角/字号走 `--wb-*`；
//   顺带修掉**不存在的令牌名**（`--dsw-alias-border-default` / `-label-link` / `-font-family-monospace`，
//   它们一直静默回落硬编码 ⇒ 从没跟随过主题）。守卫 UNIFIED 白名单已加入本包。
//   ⚠ **机器锚点用 `data-*`**：统计卡 `data-vssaros-memory-stat`、槽位 `data-vssaros-memory-slot(s)`
//     —— 类名属于视觉层（统一时会换成 `wb-*`），拿类名当锚点一改样式探针就瞎 ✗（迁移当场踩到）。
// ★ React 工作台内容：主入口 + 四张统计卡 + 自动沉淀计数 + 固定槽位 + 草稿区（提升/丢弃照旧走
//   `/x/memory/promote` `/x/memory/discard` 两个 POST 路由 ⇒ 审批闸口径不变）+ 诊断（折叠）+ 工作记忆原文。
//
// ⚠ 子块文件名**必须**是 `client.<名字>.js`（装载器只认 `client.*.js` ⇒ 相对请求 `client-modules` 会拒，
//   写成 `memory.js` 会报 "invalid relative chunk request" ⇒ 工作台静默不出现 ✗）。
// ⚠ 规矩：改过 `client.memory.js` 之后，**要再动一下这个入口**（守卫查 mtime ⇒ 漏了必红 ✓），
//   并且**版本号必须是这一包最后一次改动的动作**（p3-17 的"装的就是当前源码"会当场报红 ✓）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-memory',
	factory: (require) => {
		var module = { exports: {} };
		// ⚠ 必须显式给 `exports` 起个别名：装载器给的是 factory，`exports` 在**模块作用域里并不存在** ⇒
		//   漏了这行就是真机那条 `web boot: … import failed: exports is not defined` ✗（真机验收当场抓到 ✓）。
		var exports = module.exports;

		function apply(ctx) {
			try {
				if (typeof require.async !== 'function') { throw new Error('装载器没有 require.async（老运行时）'); }
				require.async('./client.memory.js')
					.then((part) => { if (part && typeof part.install === 'function') { part.install(ctx); } })
					.catch((e) => {
						const why = String((e && e.message) || e);
						globalThis.__vssarosMemoryClient = { loaded: true, workbenchFailed: why };
						console.warn(`[vssaros-memory] 工作台组件装载失败：${why}`);
					});
			} catch (e) {
				const why = String((e && e.message) || e);
				globalThis.__vssarosMemoryClient = { loaded: true, workbenchFailed: why };
				console.warn(`[vssaros-memory] 工作台组件装载失败：${why}`);
			}
			globalThis.__vssarosMemoryClient = Object.assign({}, globalThis.__vssarosMemoryClient, { loaded: true });
			return undefined;
		}

		exports.apply = apply;
		// 硬依赖留空：拿不到槽也不该让整个客户端插件不 apply（Cordis 的 inject 是硬依赖）。
		exports.inject = [];
		return module.exports;
	},
});
