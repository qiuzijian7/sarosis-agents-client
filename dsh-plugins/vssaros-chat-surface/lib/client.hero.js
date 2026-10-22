// @vssaros/dsh-chat-surface — 新会话品牌标（conversation.hero.brand.mark）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.hero.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ★ 2026-10-21（用户："client.hero.js中使用 sessions-logo"）：这里原来画的是**四角火花**
//   （另一个"品牌图形"），与侧栏 `client.brand.js` 的方形标并存 ⇒ 同一个窗口两套 logo ✗。
//   现在两边**同几何**：白底圆角块 + 两条 #FF5A2E 弧 + r=58 内圈，逐字取自
//   `src/vs/sessions/browser/media/sessions-logo-dark.svg`（IDE 自己的那份）。
//   ⚠ 两份文件各自内联一份（chunk 只能 require("react")，不能互相 import）⇒
//     `check-chat-surface-chunks.mjs` 的守卫 ⑪ 会**渲染两边**再对账 `d`，改一处必红 ✓。
//   ⚠ 组件放在**工厂作用域**（不是 install 里）：`exports.__test` 要能拿到它（守卫要渲染）——
//     放在 install 里会在装载时 `VssarosHeroMark is not defined`（2026-10-21 当场踩过 ✗）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.hero.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const HERO_SLOT = "conversation.hero.brand.mark";
		const MARK_FILL = "#FFFFFF";
		const MARK_STROKE = "#FF5A2E";
		const ARC_TOP = "M145.7 169.8 A140 140 0 0 1 366.3 169.8";
		const ARC_BOTTOM = "M366.3 342.2 A140 140 0 0 1 145.7 342.2";

		/** VsSaros 方形标（与侧栏 `client.brand.js` 的 BrandMark 同几何；大小由 owner 的 `size` 定）。 */
		function VssarosHeroMark(props) {
			const size = (props && props.size) || 34;
			return react.createElement("span", {
				className: props && props.className,
				"data-vssaros-hero": "1",
				role: "img",
				"aria-label": "VsSaros",
				style: {
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					// 圆角与 svg 里 rect 的 rx(96/512 ≈ 18.75%) 同比例 ⇒ 不会露出两层不同的圆角 ✓
					width: size, height: size, borderRadius: Math.round(size * 0.1875),
					overflow: "hidden", boxSizing: "border-box", flex: "0 0 auto",
				},
			}, react.createElement("svg", {
				width: size, height: size, viewBox: "0 0 512 512",
				role: "img", "aria-label": "VsSaros", style: { display: "block" },
			},
				react.createElement("rect", { width: 512, height: 512, rx: 96, fill: MARK_FILL }),
				react.createElement("g", { fill: "none", stroke: MARK_STROKE },
					react.createElement("g", { strokeWidth: 16 },
						react.createElement("path", { d: ARC_TOP }),
						react.createElement("path", { d: ARC_BOTTOM }),
					),
					react.createElement("circle", { cx: 256, cy: 256, r: 58, strokeWidth: 30 }),
				),
			));
		}

		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。
		 *
		 * 换皮 v0（方案 5.11 / 5.3 红线：样式只认宿主主题变量，失败回落官方样式）：
		 * 新会话欢迎区的品牌标——官方内容是 renderSlot 的 fallback（HeroFish 鲸鱼），
		 * 注册同名 slot 条目即替换；组件崩溃时 slot 机制自动 abdicate、官方鱼标回落。
		 */
		function install(ctx, shell) {
			const state = shell.state;
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
		// 仅测试用：守卫 ⑪ 直接用假 react 渲染一次，核对与侧栏 `client.brand.js` **同几何** ✓
		exports.__test = { VssarosHeroMark };
		return module.exports;
	}
});
