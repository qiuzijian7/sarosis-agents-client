// @vssaros/dsh-chat-surface — 侧栏品牌区换成 VsSaros 的 logo 与标题
//
// 为什么有这个 chunk（2026-10-21 用户："deepseek harness 的 logo 和标题都替换成 vssaros 的 logo 和标题"）：
//   桌面窗口（F5 默认形态）左侧顶部是官方侧栏的**品牌行** —— 上游画的是鱼形标 + `deepseek`
//   + 一枚 `HARNESS` 徽标。它属于 `client-ui-brand-official`（官方包），但**两个槽都对外开放**：
//     · `sidebar.brand.mark`（single / root，ownerProps `{ size }`，占位者 `OfficialBrandMark`）
//     · `sidebar.brand.name`（single / root，占位者 `OfficialBrandName`）
//   两者 `replaceRisk: "shadows-shipped-ui"`（官方 contract 原文）⇒ **可以替换**，这正是本 chunk 干的事。
//
// 怎么换（单条目槽的取向，2026-10-16 hero 那次实测过）：
//   `priority: -10`（**负值优先**）⇒ 顶掉官方那份；与「工作区浮层」遮蔽官方 WorkspacePickFlow 同一先例 ✓。
//   槽是 single ⇒ 不写 `order`；`id` 可写可不写（写上便于诊断/守卫）。
//
// Logo 的几何 = **IDE 自己那份**（`src/vs/sessions/browser/media/sessions-logo-dark.svg`，
//   与 `extensions/saros-pocket/media/saros-mark.svg` 逐字同几何）：白底圆角块 + 两条橙色弧 + 内圈。
//   内联成 React 元素（不用 innerHTML / 不引外部 URL）：
//     · 页面跑在 WebContentsView 里，外链图会被 CSP/网络分区拦（而且没有必要）；
//     · `dangerouslySetInnerHTML` 在 Trusted Types 下会被拒（本仓 IDE 侧踩过同类坑）⇒ 一律 createElement。
//
// 纪律：只在带官方 chrome 的视图（`chatOnly === false` 或 surface=full）注册 —— 主窗口的 chat-only
//   聊天框里根本没有侧栏，注册了也是空转（无害，但没必要）✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.brand.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT_MARK = "sidebar.brand.mark";
		const SLOT_NAME = "sidebar.brand.name";
		/** 折叠态兜底入口的落点（官方传 `{ wide }`；见 `CollapsedIdeEntry`）。 */
		const SLOT_FOOTER = "sidebar.footer.action";
		/** 负值优先（见文件头）⇒ 顶掉官方的 OfficialBrandMark / OfficialBrandName ✓。 */
		const PRIORITY = -10;
		const TITLE = "VsSaros";

		/** 官方那份是 `#FFFFFF` 底 + `#FF5A2E` 描边；值直接照抄 IDE 的 svg，不做主题推断。 */
		const MARK_FILL = "#FFFFFF";
		const MARK_STROKE = "#FF5A2E";

		/** 方形 logo（24×24 量级用它；与 IDE 侧 sessions-logo-dark.svg 同几何）。 */
		function BrandMark(props) {
			const raw = props && typeof props.size === "number" ? props.size : 0;
			const size = raw > 0 ? raw : 24;
			return react.createElement("span", {
				"data-vssaros-brand-mark": "1",
				style: {
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					width: size, height: size, flex: "0 0 auto", overflow: "hidden",
					borderRadius: Math.round(size * 0.19),
				},
			},
				react.createElement("svg", {
					viewBox: "0 0 512 512", width: size, height: size, role: "img", "aria-label": TITLE,
					style: { display: "block" },
				},
					react.createElement("rect", { width: 512, height: 512, rx: 96, fill: MARK_FILL }),
					react.createElement("g", { fill: "none", stroke: MARK_STROKE },
						react.createElement("g", { strokeWidth: 16 },
							react.createElement("path", { d: "M145.7 169.8 A140 140 0 0 1 366.3 169.8" }),
							react.createElement("path", { d: "M366.3 342.2 A140 140 0 0 1 145.7 342.2" }),
						),
						react.createElement("circle", { cx: 256, cy: 256, r: 58, strokeWidth: 30 }),
					),
				),
			);
		}

		/**
		 * 回到 VsSaros 的 **IDE 主窗口**（2026-10-21 用户："回到 ide 按钮移动到 logo 右侧"）。
		 *
		 * 从 `client.footer.js` 的侧栏行搬到这里：入口就挂在品牌行（logo + 标题）右边，
		 * 不再占 panellist 的一行。页面拿不到窗口级 API（`window.focus()` 只能激活自己所在的窗口 ✗）
		 * ⇒ 走页面桥 `focusIde`（桥 16，宿主 `showWindow` + `focusWindow`）✓。
		 *
		 * ⚠ 旧宿主（桥 < 16）没有 `focusIde`：必须**明说**，不许"点了没反应"✗。
		 */
		function openIde() {
			const api = (typeof window !== "undefined" && window.vssarosDsh) || null;
			if (api && typeof api.focusIde === "function") {
				try {
					const p = api.focusIde();
					if (p && typeof p.catch === "function") { p.catch(() => undefined); }
				} catch { /* IPC 失败只影响这一次点击 */ }
				return;
			}
			const st = (typeof window !== "undefined" && window.__vssarosChatSurface) || null;
			if (st) {
				st.ideEntry = "unsupported";
				st.ideEntryError = "focusIde unavailable (bridgeVersion=" + (api && api.bridgeVersion) + ")";
			}
			try {
				if (api && typeof api.notify === "function") {
					api.notify("warn", "当前宿主不支持「回到 IDE」（需要页面桥 16）");
				}
			} catch { /* 通知失败不阻塞 */ }
		}

		/**
		 * 标题 + 右侧那枚「回到 IDE」按钮。
		 *
		 * ⚠ 官方那份**同时承载版本徽标**（本地构建时 `brand.localBuild` 那枚小方块）⇒ 顶掉它之后
		 *   版本信息在这条侧栏里就没有了。这是刻意的：本产品只对外呈现一个名字（用户要求"标题换成
		 *   vssaros 的标题"），版本号在「关于」/设置里都有，不该占品牌位 ✓。
		 * ⚠ 按钮放在**标题之后**（= logo 右侧）：用户明确要求把原来侧栏里那行「回到 IDE」搬到这儿 ✓。
		 */
		function BrandName() {
			const [hover, setHover] = react.useState(false);
			return react.createElement("span", {
				style: { display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 },
			},
				react.createElement("span", {
					"data-vssaros-brand-name": "1",
					title: TITLE,
					style: {
						fontWeight: 600, fontSize: 14, letterSpacing: "0.2px", whiteSpace: "nowrap",
						color: "var(--dsw-alias-label-primary, inherit)",
					},
				}, TITLE),
				react.createElement("button", {
					type: "button",
					// ⚠ 用**稳定锚点**（不随 hover 变），e2e/守卫都按它找：
					"data-vssaros-ide-entry": "1",
					title: "回到 VsSaros 窗口",
					onClick: openIde,
					onMouseEnter: () => setHover(true),
					onMouseLeave: () => setHover(false),
					style: {
						display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
						height: 18, padding: "0 6px", borderRadius: 4, fontSize: 10.5, lineHeight: "16px",
						fontFamily: "inherit", whiteSpace: "nowrap", cursor: "pointer",
						border: "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.4))",
						background: hover ? "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.18))" : "transparent",
						color: hover ? "var(--dsw-alias-label-primary, inherit)" : "var(--dsw-alias-label-tertiary, #8a8a8a)",
					},
				}, "IDE ↗"),
			);
		}

		/**
		 * **侧栏折叠后**的「回到 IDE」兜底（2026-10-21 自查）。
		 *
		 * 为什么需要：品牌行进按钮挂在 `sidebar.brand.name` 上，而官方**折叠态只渲染 brand.mark**
		 * （`SidebarRoot` 的 collapsed 变体里没有 name）⇒ 用户一折叠侧栏，回 IDE 的唯一出口就消失了 ✗。
		 * ⇒ 额外注册一枚 `sidebar.footer.action` 条目，**只在 `wide === false` 时**渲染一枚「IDE」小按钮
		 * （折叠态官方把 footer 项居中排，尺寸刚好）；宽态返回 null ⇒ 不会出现两个入口 ✓。
		 * 官方给该槽的 props：`{ wide }`（`renderSlot("sidebar.footer.action", { wide })`）。
		 */
		function CollapsedIdeEntry(props) {
			if (!props || props.wide !== false) { return null; }   // 宽态：入口在品牌行 ✓
			return react.createElement("button", {
				type: "button",
				"data-vssaros-ide-entry": "1",
				"data-vssaros-ide-entry-collapsed": "1",
				title: "回到 VsSaros 窗口",
				onClick: openIde,
				style: {
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					height: 22, padding: "0 6px", borderRadius: 4, fontSize: 10, lineHeight: "18px",
					fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap",
					border: "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.4))",
					background: "transparent",
					color: "var(--dsw-alias-label-tertiary, #8a8a8a)",
				},
			}, "IDE");
		}

		function install(ctx, shell) {
			const bridge = (shell && shell.bridge) || {};
			const state = (shell && shell.state) || {};
			// 只给"带官方 chrome"的视图装（chat-only 的聊天框里没有官方侧栏）
			const chrome = bridge.surface === "full"
				|| (bridge.surface === "chat" && bridge.chatOnly === false);
			if (!chrome) { return; }
			// 幂等：两条装载路径可能都走到（PART_CHUNKS + 主包 hasOfficialChrome 那段 require.async），
			// 同一 single 槽注册两次会互相顶掉/报错（与 client.footer.js 同一个坑）✓。
			if (state.brandInstalled) { return; }

			try {
				ctx.slots.inject(SLOT_MARK, () => ctx.slots.register(
					{ name: SLOT_MARK, id: "vssaros-brand-mark", priority: PRIORITY }, BrandMark));
				ctx.slots.inject(SLOT_NAME, () => ctx.slots.register(
					{ name: SLOT_NAME, id: "vssaros-brand-name", priority: PRIORITY }, BrandName));
				// 折叠态兜底（见 `CollapsedIdeEntry`）：宽态返回 null，不会重复出入口 ✓
				ctx.slots.inject(SLOT_FOOTER, () => ctx.slots.register(
					{ name: SLOT_FOOTER, id: "vssaros-ide-collapsed" }, CollapsedIdeEntry));
				// 页面 title：上游 `<title>DeepSeek Harness</title>`（全窗窗口标题取它）⇒ 顶成本产品名 ✓
			try { document.title = TITLE; } catch (e) { /* 非浏览器环境忽略 */ }
			state.brandInstalled = true;
			} catch (e) {
				state.brandError = String((e && e.message) || e);
			}
		}

		exports.install = install;
		// 仅测试用：守卫直接在假 react 上断言"渲染出来的树里有 svg + 标题文案"（不猜源码写法 ✓）
		exports.__test = { BrandMark, BrandName, CollapsedIdeEntry, openIde, SLOT_MARK, SLOT_NAME, SLOT_FOOTER, PRIORITY, TITLE };
		return module.exports;
	}
});
