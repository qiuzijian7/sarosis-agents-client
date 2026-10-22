// @vssaros/dsh-chat-surface — 基础皮肤层（CSS 皮肤：composer 卡 / 过程组 / 工具卡 / 审批卡描边）
// ⚠ 不含用户气泡：dsh 官方已有该组件样式，本层不再改写它（见 SKIN_CSS 内注释）。
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.skin.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.skin.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。段内代码与拆分前逐字一致。
		 */
		function install(ctx, shell) {
			const state = shell.state;
				// 换皮 v0.2：CSS 皮肤层——只认 data-* 稳定钩子（不碰 hash 化类名）与 --dsw-alias-* token
				// （全集 13 个，主题同步已让它们跟随 VsSaros 主题）；卸载/失败时整层消失，官方样式原样。
				const SKIN_CSS = [
					// composer 卡片：描边 + 圆角 + 聚焦品牌色
					"[data-composer-card]{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}",
					"[data-composer-card]:focus-within{border-color:var(--dsw-alias-brand-primary);}",
					"[data-conversation-scroll]{scrollbar-width:thin;}",
					// ── 用户消息：**保持 dsh 官方样式**（2026-10-10 撤掉本层对它的覆写）──────────────
					// 原规则：`[data-chat-flow-kind="user"]{background:--dsw-alias-bg-layer-1!important;
					// border:1px solid --dsw-alias-border-l1!important;border-radius:12px!important;padding:6px 10px;}`
					// 它把官方那只**右对齐紧凑气泡**改成了"通栏描边卡片"，实测与官方观感差异明显
					// （用户对照截图后要求回到官方）⇒ 整条删除，官方气泡样式原样生效。
					// 教训：皮肤层只该补官方缺失的层次，不该改写官方已有组件的形状。
					// ── 助手消息：**保持 dsh 官方样式（无边框）**（2026-10-12 用户要求）────────────────
					// 原规则（2026-10-10 "批次①对齐原生"加的，已删除）：
					//   `[data-chat-flow-kind="assistant-step"]{border:1px solid --dsw-alias-border-l1!important;
					//    border-radius:10px 10px 10px 4px!important;}`
					// 它给 LLM 的回复套了一个通栏描边卡片；用户对照官方截图（纯文本、无任何框）要求去掉 ⇒ 整条删除。
					// ⚠ 与上面"用户消息"那条**同一个教训**：皮肤层只该补官方**缺失**的层次，
					// 不该给官方已有的节点加形状。kind 取值仍是实测的 `assistant-step`（不是 `assistant`），
					// 但本层不再碰它 —— 谁要加回边框，先看这两条教训与 2026-10-12 的对照截图。
					// ── 过程组 / 工具卡：**同样回到官方形状（无边框）**（2026-10-12 用户要求）─────────────
					// 原规则（同批"对齐原生"加的，已删除）：
					//   `[data-chat-flow-kind="turn-process"]{border-left:2px solid --dsw-alias-border-l2;
					//    border-radius:2px;padding-left:8px;}`
					//   `[data-chat-flow-kind="tool-call"]{border:1px solid --dsw-alias-border-l1!important;
					//    border-radius:10px!important;background:--dsw-alias-bg-layer-1!important;padding:4px 8px;}`
					// 用户口径："LLM 的返回消息不应该有边框"，并确认过程组 / 工具卡一并去掉（2026-10-12"进行"）。
					// 到此 user / assistant-step / turn-process / tool-call **四类都是同一原则**：
					// 官方已有的节点，本层只**读**、不改形状 ⇒ 官方改版时不会出现"我们和它对冲"✗。
					// 皮肤层剩下的增量只有"官方没有的层次"：审批警示边线、运行中呼吸光晕、composer 卡、
					// 菜单/弹层视觉、面包屑隐藏、preset 条目 hover。
					"[data-process-activity]{color:var(--dsw-alias-label-secondary);}",
					// 运行中/待交互：蓝色呼吸边框（批次①，对齐原生"待交互卡"语汇）。
					// 钩子是 dsh 自己的"运行中"指示节点（实测 data-chat-running 落在那颗 div 上）。
					"[data-chat-running]{border-radius:8px;animation:vssaros-breath 2.2s ease-in-out infinite;}",
					"@keyframes vssaros-breath{0%,100%{box-shadow:0 0 0 0 rgba(76,154,255,.30);}50%{box-shadow:0 0 0 4px rgba(76,154,255,0);}}",
					// 无障碍：系统开启"减少动态效果"时不做呼吸动画。
					"@media (prefers-reduced-motion:reduce){[data-chat-running]{animation:none!important;}}",
					// 工具卡描边已删（2026-10-12，理由与上面过程组同段注释）。
					// 审批卡：警示左边线
					"[data-approval-key]{border-left:3px solid var(--dsw-alias-state-warn-primary);border-radius:4px;}",
					// preset 下拉条目 hover 提亮（批次③②）：条目底色是内联样式，样式表要 !important 才盖得住。
					"[data-vssaros-preset-item]:hover{background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))!important;}",
					// ── 隐藏 dsh 头部里的**会话标题（面包屑）**（2026-10-11 用户要求）──────────────
					// 外层 VsSaros 编辑器页签已经显示会话名（`client.sessionLabel.js` 读 dsh 标题 → 上报宿主
					// → 页签文案），dsh 头部再显示一遍是重复信息，还挤压了本来就很窄的聊天框宽度。
					//
					// 为什么只能走 CSS：标题不是槽位渲染的（它是 `ConversationSessionHeader` 里内联的
					// `summary.displayTitle`：`dsh-client-ui-conversation/lib/client.js:16470-16499`），
					// 槽 `conversation.session.header.lineage` 的 fallback 也**包含**标题 ⇒ 注册 null 去不掉它。
					//
					// 锚点：`[data-conversation-header-corner]` 是这一行里**唯一稳定的 data 钩子**
					// （同级 div 的类名全被 hash 化；`nav` 自己只有本地化的 `aria-label`）。
					// 结构（同上 `:16461-16511`）：titleRow > titleCluster > [nav.crumbs, div.headerActions]。
					// 因此 `> div > nav` 精确命中面包屑，**保留**同一行里的动作位（＋/🕘/⚙）与工具位（🗂/⬢）。
					// `:has()` 在用（DSH_CHAT_ONLY_CSS 已依赖），Electron 30+ 支持。
					"div:has(> [data-conversation-header-corner]) > div > nav { display: none !important; }",
					// ★★ 2026-10-19（用户报「右侧缺少消息定位条，官方 dsh 里有」）：
					//   官方有个**轮次导航**（`nav` + `aria-label="轮次导航"`，每条刻度一个
					//   `button[data-index]`，点击=「加载并跳转到第 N 轮」）。它在**窄视口**下被 dsh
					//   自己 `display:none` —— 而我们的聊天框普遍 600~900px ⇒ **永远看不见**。
					//   实测（同一会话、同一 Host，只改视口宽度）：
					//     · 1520px：可见，28×122，12 个刻度
					//     · 900px ：`display:none`、刻度 0
					//     · 900px + 强制 display:block ⇒ **12 个刻度立刻回来**（28×122 正常）
					//   ⇒ 说明刻度与跳转逻辑都好好的，只是被藏了；覆盖 display 即可。
					//   ⚠ 选择器**不许按 aria-label 匹配**（它是本地化文案，英文环境会变）：
					//     用结构 + 非本地化钩子 `button[data-index]`（`:has()` 已被本文件使用）。
					//   ⚠ 只有 28px 宽、`right:12px` 的浮层，不会挤占聊天内容。
					'[data-slot="conversation.view"] nav:has(button[data-index]){display:block!important;}',
					// 聊天框设置 → 「用量页脚」开关（批次③④）：设了根数据属性即隐藏页脚，零侵入。
					"[data-vssaros-hide-usage] [data-vssaros-turn-usage]{display:none!important;}",
					// ── 批次②part2：composer `+` 弹层视觉（只改样式，不动结构与行为）────────────
					// ⚠ 修正（v0.2.18）：此前写成 `[data-trigger-menu] [data-menu-material]` **未生效** ——
					// dsh 的菜单是 **portal 渲染**（原语里有 `data-portal`），弹层不是触发器的后代，
					// 后代选择器永远匹配不上。改为**不依赖层级**：皮肤表只注入在 dsh 页面内，
					// 作用域本身就是页面级；菜单原语的钩子（data-menu-material / -group-heading / role=menuitem）
					// 在同一页面里就是我们要的那一套视觉语言（官方 `…`、其它菜单也一并统一，符合设计稿口径）。
					// 条目与快捷键仍由官方决定，我们只改样式。
					"[data-trigger-menu]{border-radius:10px;}",
					"[data-menu-material]{border:1px solid var(--dsw-alias-border-l1, transparent);border-radius:10px;background:var(--dsw-alias-bg-layer-1, transparent);box-shadow:0 8px 24px rgba(0,0,0,.35);}",
					"[data-menu-group-heading]{font-size:10.5px;letter-spacing:.03em;color:var(--dsw-alias-label-secondary, currentColor);padding:6px 8px 3px;}",
					"[role=\"menuitem\"]{border-radius:7px;}",
					"[role=\"menuitem\"]:hover{background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent));}",
				].join("\n");
				try {
					const style = document.createElement("style");
					style.dataset.vssarosSkin = "1";
					style.textContent = SKIN_CSS;
					(document.head || document.documentElement).appendChild(style);
					state.skinCss = true;
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
		}
		exports.install = install;
		return module.exports;
	}
});
