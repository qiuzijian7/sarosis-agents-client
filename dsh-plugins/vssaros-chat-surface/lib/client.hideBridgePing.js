// @vssaros/dsh-chat-surface — 遮蔽 VsSaros bridge 的 P0「VsSaros」连通性自检按钮（vssaros-ping cell）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.hideBridgePing.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ★ 2026-11-11（用户要求「dsh 侧聊天框 UI 右上角移除 VsSaros 按钮」）：
//   按钮**真源已删**（vssaros-bridge/lib/client.js 不再注册 vssaros-ping）。本 chunk 降级为
//   **旧版本/浏览器缓存兜底**：老 bridge 插件仍会把那颗按钮注册进 header.utilities。
//   ⚠ 装载路径必须走 **ALWAYS_CHUNKS**（无条件）：原先在 PART_CHUNKS，而 client.js 里
//     「换皮部件仍只在 chat 装」的早退（surface !== chat ⇒ return）让 desktop 主栏（full）
//     一条 PART chunk 都不装 ⇒ 遮蔽缺席 ⇒ 用户截图里右上角又冒出「VsSaros」✗✗。
//   ⇒ 与 client.openInAppMenu.js 同一条教训：跨 surface 的下线/遮蔽一律进 ALWAYS。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.hideBridgePing.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。
		 */
		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
				// ★ 2026-11-11：无条件装载（ALWAYS_CHUNKS）⇒ 必须自己幂等，
				//   否则任何一条重复装载路径都会让同 id 同 priority 注册抛错。
				if (state.hideBridgePing) { return; }
				// ── 遮蔽旧版 @vssaros/dsh-bridge 的「VsSaros」自检按钮 ──────────────────
				// bridge 插件 client half（P0 原型）把一颗按钮注册在
				// conversation.session.header.utilities（list 槽，id="vssaros-ping"，只传了 order: -20）。
				// 它的唯一行为是点击时调 `window.vssarosDsh.ping()`（页面→preload→主进程的连通性自检），
				// 不承担任何产品功能（会话绑定在 chat-surface 的 openSession，provider 同步走控制桥，
				// 主题/文件引用/插件页各走各的通路）⇒ VsSaros 聊天框不需要它。
				//
				// 遮蔽口径（读自 dsh-client-ui-slots 的 KindOptions）：list 槽的 `order` 只是**显示顺序**，
				// 决定"谁渲染"的是 **`priority`** —— 同 id 分 cell、升序取最低、默认 0（同 id 同 priority 抛错）。
				// bridge 那颗没传 priority ⇒ 默认 0，故这里用 `priority: -1` 胜出并渲染 null，按钮消失。
				// ⚠ 不要动 `order`：那是显示顺序，与遮蔽无关，写成负数只会让"顺序"这个语义被误读。
				const HEADER_UTILITIES_SLOT = "conversation.session.header.utilities";
				try {
					ctx.slots.inject(HEADER_UTILITIES_SLOT, () => ctx.slots.register(
						{ name: HEADER_UTILITIES_SLOT, id: "vssaros-ping", priority: -1 },
						() => null
					));
					state.hideBridgePing = true;
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
		}
		exports.install = install;
		return module.exports;
	}
});
