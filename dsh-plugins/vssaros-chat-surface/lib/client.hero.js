// @vssaros/dsh-chat-surface — 新会话品牌标（conversation.hero.brand.mark）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.hero.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.hero.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。段内代码与拆分前逐字一致。
		 */
		function install(ctx, shell) {
			const state = shell.state, mark = shell.mark;
				// 换皮 v0（方案 5.11 / 5.3 红线：样式只认宿主主题变量，失败回落官方样式）：
				// 新会话欢迎区的品牌标——官方内容是 renderSlot 的 fallback（HeroFish 鲸鱼），
				// 注册同名 slot 条目即替换；组件崩溃时 slot 机制自动 abdicate、官方鱼标回落。
				// 颜色全部走 --dsw-alias-* token（主题同步已让它们跟随 VsSaros 主题）。
				const HERO_SLOT = "conversation.hero.brand.mark";
				function VssarosHeroMark(props) {
					const size = (props && props.size) || 34;
					return react.createElement("span", {
						className: props && props.className,
						"data-vssaros-hero": "1",
						role: "img",
						"aria-label": "VsSaros",
						style: {
							display: "inline-flex", alignItems: "center", justifyContent: "center",
							width: size, height: size, borderRadius: Math.round(size * 0.24),
							background: "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))",
							border: "1px solid var(--dsw-alias-line-normal, transparent)",
							color: "var(--dsw-alias-label-primary, currentColor)",
							boxSizing: "border-box",
						},
					}, react.createElement("svg", {
						width: Math.round(size * 0.62), height: Math.round(size * 0.62), viewBox: "0 0 16 16",
						fill: "none", "aria-hidden": "true",
					}, react.createElement("path", {
						// VsSaros 火花标：四角星形（品牌主图形），用宿主主题的前景色描边填充。
						d: "M8 1 L9.6 6.4 L15 8 L9.6 9.6 L8 15 L6.4 9.6 L1 8 L6.4 6.4 Z",
						fill: "currentColor",
					})));
				}
				try {
					ctx.slots.inject(HERO_SLOT, () => {
						const dispose = ctx.slots.register({ name: HERO_SLOT, id: "vssaros-hero-mark", order: 100 }, VssarosHeroMark);
						return dispose;
					});
					state.heroSkin = true;
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
		}
		exports.install = install;
		return module.exports;
	}
});
