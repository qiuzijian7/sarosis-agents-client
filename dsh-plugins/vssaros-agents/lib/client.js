// 2026-10-24 touch：client.agents.js：@media → @container + 根节点 container-type ⇒ 入口置新（chunk 守卫按 mtime 判）。
// CLIENT_BUILD_STAMP 2026-10-24T21:15：client.agents.js 于 20:58 变更后置新入口（chunk ?rev 跟随）
// @vssaros/dsh-agents — 客户端入口（工作台重构 §5 步骤 2，2026-10-22）。
//
// 本包原先**没有客户端半**（页面是纯 SSR + 页内脚本）。React 工作台（**第一刀：名册面**）需要入口：
// 它只做一件事 —— 把子块 `client.agents.js` 装进来（注册进宿主服务 `desktopWorkbenches`）。
//
// 第一刀范围：Agent 名册（名字 / 角色 / 模型 / 注册状态 / 会话数 / 待处理 / 运行中 / 收件箱，点开看详情）。
// ★ 第二刀（同日）：**三个列表页签**搬进来 —— 用量（`/api/usage`）/ 委派（`/api/assignments`）/
//   授权（`/api/approval-templates` + `/api/outbox`，只读）。**群聊 / 记忆 / 演化仍是独立页面**（给明确入口）：
//   群聊是三栏应用（DSB v3 群聊页），记忆有查看器、演化有时间线 + diff + 回滚 ⇒ 都不是"列表页签"能覆盖的 ✓。
// ★ 第三刀（同日）：**群聊 / 记忆** 做成只读页签 —— 群聊列群 + 成员 + 「打开」链接（`/api/groups`）；
//   记忆列文件 + 历史版本，点开看内容/那一版（`/api/memory?agent=&file=&rev=`，**只读**）。
//   建群 / 发消息 / 恢复 / 提交快照 仍在各自页面 ✓。
// ★ 第四刀（同日）：**演化页签**也进来了（只读）—— 时间线 + 「看这版」+ **「对比当前」逐行 diff**
//   （diff 由服务端算：`/api/memory?agent=&file=&rev=&against=working` ⇒ `diff.rows` 直接渲染 ✓）。
//   **回滚**是写动作 ⇒ 仍在完整页（按钮上写明了 ✓）。
//
// ⚠ 子块文件名**必须**是 `client.<名字>.js`（装载器只认 `client.*.js` ⇒ 相对请求会被拒）。
// ⚠ 入口里必须先 `var exports = module.exports;`（**否则真机报 `exports is not defined`**）。
// ⚠ 改过子块要**再动一下这个入口**（守卫查 mtime），且**版本号必须是最后一次改动的动作**。
// ⚠ 2026-10-22 补一条实测：**连"改了又改回来"也会推进子块 mtime**（内容没变、时间变了）⇒ 守卫照样会红
//   （它比的是时间，不是内容）⇒ 变异测试之后必须重新动一次入口 + 升版本 ✓。
// ★ 2026-10-22（UI 统一 §6.19）：组件改用**共享层** `wb-*` 原语（宿主注入一份样式表）——
//   自写 CSS 从 58 行压到 30 行（只留 ag-item / ag-row / 头像 / 两行信息 / 事实表 / 药丸三色）；
//   顺带修掉**不存在的令牌名**（`--dsw-alias-border-default` / `-label-link` / `-font-family-monospace` /
//   `-state-focus-primary`）与写死的药丸色（`#e0a43a` / `#4C9AFF`）⇒ 之前从没跟随过主题 ✗。
// ⚠ 探针锚点：名册行 `data-ag-row`、名字 `data-ag-name`（类名属视觉层 ⇒ 不当锚点）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-agents',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		function apply(ctx) {
			try {
				if (typeof require.async !== 'function') { throw new Error('装载器没有 require.async（老运行时）'); }
				require.async('./client.agents.js')
					.then((part) => { if (part && typeof part.install === 'function') { part.install(ctx); } })
					.catch((e) => {
						const why = String((e && e.message) || e);
						globalThis.__vssarosAgentsClient = { loaded: true, workbenchFailed: why };
						console.warn(`[vssaros-agents] 工作台组件装载失败：${why}`);
					});
			} catch (e) {
				const why = String((e && e.message) || e);
				globalThis.__vssarosAgentsClient = { loaded: true, workbenchFailed: why };
				console.warn(`[vssaros-agents] 工作台组件装载失败：${why}`);
			}
			globalThis.__vssarosAgentsClient = Object.assign({}, globalThis.__vssarosAgentsClient, { loaded: true });
			return undefined;
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	},
});
// 2026-10-24 touch: 修「首次点击页签却切中主页」后刷新入口 mtime ⇒ 客户端 chunk 的 ?rev 变化，浏览器不再吃旧缓存。

