// @vssaros/dsh-chat-surface — 隐藏官方「在其他 app 中打开」下拉（open-in-app cell）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.openInApp.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.openInApp.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。段内代码与拆分前逐字一致。
		 */
		function install(ctx, shell) {
			const state = shell.state;
				// ── 隐藏官方「在其他 app 中打开」下拉（open-in-app 徽标）────────────────
				// 官方 dsh-client-ui-open-in-app 把会话目录徽标 + 应用下拉注册在
				// conversation.session.header.utilities（list 槽，id="open-in-app"，默认 priority 0）。
				// VsSaros 聊天框不需要「在其他 app 中打开」，用同一个 id + 更低 priority（升序取最低者渲染）
				// 遮蔽它、组件渲染 null。注意：同 id 同 priority 会抛错，故必须用 -1。
				const OPEN_IN_APP_SLOT = "conversation.session.header.utilities";
				try {
					ctx.slots.inject(OPEN_IN_APP_SLOT, () => ctx.slots.register(
						{ name: OPEN_IN_APP_SLOT, id: "open-in-app", priority: -1 },
						() => null
					));
					state.hideOpenInApp = true;
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
		}
		exports.install = install;
		return module.exports;
	}
});
