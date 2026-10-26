// @vssaros/dsh-chat-surface — 「工作台商城」（2026-10-21）
//
// ★ 内容**复刻** G:\CustomWorkspaces\AIProjects\dsh-desktop 的工作台市场页
//   （packages/dsh-desktop-workbenches/client.js:2049-2176 骨架 / 1273-1436 样式 / 1790-1811 详情模态）。
//   逐项对照（我们照抄的语义与数值）：
//     · 页头：H1「工作台」+ 副标题「有序组织专属界面、会话与资料」+ 搜索框（占位「搜索名称、作者或分类」）
//             + 右侧主 CTA「制作我的工作台」                                  ← 2050-2056
//     · 工具行：Tab「市场 / 我的收藏 (n) / 已安装 (n)」+ 刷新圆钮 + 分类 select + 排序 select
//                                                                       ← 2058-2070
//     · 网格：3 列 repeat(3,minmax(0,1fr)) / gap 16 / 窄屏两列 / 更窄一列；页面 max-width 1376
//                                                                       ← 1338 / 1432-1435
//     · 卡片：固定高 360px、radius 14、无边框；媒体区 aspect 3/1 + 标题 18px/26 + 作者行（作者 + vX）
//             + 描述 3 行截断 + 底部操作区                                    ← 2138-2167 / 1342-1347
//     · 指标（★ / 下载）**只对目录里给了数的条目渲染**；没有就整块不渲染（不显示 0 / 假数字 ✓）
//     · 缺字段如实：描述缺 ⇒「这个工作台暂时还没有填写介绍。」；作者缺 ⇒「暂无」+ 人物图标；
//             版本缺 ⇒ 整块不渲染；分类缺 ⇒「其他」                        ← 2142-2143 / 1676-1681 / 2022-2023
//     · 详情：**模态**（max-width 880 / max-height 85vh / radius 14 / padding 24），标题 + 关闭 +
//             描述全文 + 作者·版本 + 指标；**模态里没有安装按钮**（安装只在卡片上）
//                                                                       ← 1790-1811 / 1383
//     · 分页：每页 24 条 + 「加载更多」按钮 + 「已显示 X / 共 N 个工作台」    ← 1986-1989 / 2171-2173
//     · 空态文案逐字照用（市场目录不可用 / 还没有收藏工作台 / 还没有安装工作台 / 没有找到匹配的工作台）
//                                                                       ← 2168-2170
//
// ★ 2026-10-21（第二轮）：**目录驱动**。
//   上一版把清单写死在界面里（`ITEMS`）⇒ 加一个工作台要改代码 + 发版 ✗，而且「市场」Tab 其实
//   只是本机内置清单的换皮。现在改成：**清单在 Host 侧**（`@vssaros/dsh-market` 提供
//   `GET /x/market/api/catalog` ⇒ 随包策展目录 ＋ 可选远程目录 ＋ 安装态），界面只负责**渲染**。
//   安装/卸载也走 Host（`POST /x/market/api/install` / `.../uninstall` ⇒ 转交 dsh 官方 pluginManager）。
//   ⚠ 界面里**不再**有一份工作台清单 ⇒ 商城与侧栏页签的一致性由**守卫**保证
//   （`dsh-plugins/check-chat-surface-chunks.mjs`：策展目录的 workbenchId / 名字 / 路由必须与
//   `client.workbenchNav.js` 的 DEFAULT_ITEMS 逐项一致 ⇒ 漂了就红 ✓）。
//
// ── 与 dsh-desktop 的**能力差**（如实说明，不假装有）──────────────────────────
//   · dsh 的市场目录托管在 `market.dshdesktop.com`，条目是 GitHub 上的**第三方工作台仓库**，
//     还能提 PR 上架。我们：目录**随包分发**（可另配远程目录），上架通道还没有 ⇒ 页头写明
//     「还没有公开的策展仓库，暂时不能提交自己的工作台」。**不伪造**下载量 / Star / 作者排名。
//   · 分类/排序里「Star 数量 / 下载量」依赖远程指标 ⇒ 目录没给数就**不渲染指标**，值缺失的排最后。
//
// ── 装载位置（2026-10-21 真机事故，勿忘）────────────────────────────────────
//   本 chunk 必须同时出现在：① `PART_CHUNKS`（chat 形态）② **full 官方整页那条 require 列表**
//   （client.js 的 hasOfficialChrome 段）—— 只进 ① 的话，dsh 窗口（full 形态）里设置页永远没有这一节 ✗。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.market.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		/**
		 * `codicon:xxx` → emoji（与 `client.workbenchNav.js` 里那份**逐字一致**，守卫比对两处 ✓）。
		 * 原因：注册表 `icon` 是标识符（`codicon:home`），而 dsh 前端没有 codicon 字体/CSS，
		 * 图标体系是 emoji ⇒ 直接渲染会变成 🧩 / 一串字母（2026-10-22 实测）。
		 */
		const WB_ICON_EMOJI = {
			"codicon:home": "🏠", "codicon:book": "📚", "codicon:database": "🧠",
			"codicon:robot": "🤖", "codicon:organization": "🤖", "codicon:tasklist": "🗂️",
			"codicon:checklist": "🗂️", "codicon:list-tree": "🔀", "codicon:type-hierarchy": "🕸️",
			"codicon:clock": "⏰", "codicon:graph": "📊", "codicon:pulse": "💓",
			"codicon:search": "🔍", "codicon:settings": "⚙️", "codicon:gear": "⚙️",
			"codicon:extensions": "🧩", "codicon:package": "🧩", "codicon:cloud": "☁️",
			"codicon:comment-discussion": "💬", "codicon:terminal": "⌨️",
		};
		/** 图标 → 可渲染的 emoji：映射表优先；本来就是短符号/emoji ⇒ 原样；其余兜底 🧩。 */
		function wbIconEmoji(icon) {
			const raw = String(icon == null ? "" : icon).trim();
			if (!raw) { return "🧩"; }
			if (WB_ICON_EMOJI[raw]) { return WB_ICON_EMOJI[raw]; }
			if (raw.indexOf("codicon:") !== 0 && Array.from(raw).length <= 4) { return raw; }
			return "🧩";
		}
		// ⚠ **不能**去 require react-dom：dsh 的 chunk 装载器只提供 react（守卫也会直接抛）⇒
		//   详情模态**就地渲染**（遮罩是 position:fixed ⇒ 视觉上与 portal 到 body 等价 ✓）。

		const SLOT_SECTION = "settings.section";
		/** 本分区自己声明的子槽（内容组件注册到这里；general 分区同款做法 ✓）。 */
		const SLOT_CATALOG = "settings.vssaros.workbench.item";
		const SLOT_MAIN = "main";
		const SLOT_ITEM = "settings.general.item";
		const SECTION_ID = "vssaros-workbench";
		/** 分区在左侧导航里的位置：官方 account -10 / general 0 / models 10 / plugins 15 ⇒ 20 是空档 ✓。 */
		const SECTION_ORDER = 20;
		const ROW_ID = "vssaros-workbench-market";
		const ROW_ORDER = 34;
		const PANEL_KEY = "vssaros-workbench-market";
		const PAGE_SIZE = 24;
		const LS_FAV = "vssaros.market.favorites";
		/** Host 侧目录服务（`@vssaros/dsh-market` 提供的路由；同源 ⇒ 走 cookie 栅栏 ✓）。 */
		const CATALOG_API = "/x/market/api/catalog";
		const INSTALL_API = "/x/market/api/install";
		const UNINSTALL_API = "/x/market/api/uninstall";
		const CHECK_API = "/x/market/api/check";

		const CSS = `
.vssWb { --vssGutter:32px; color: var(--dsw-alias-label-primary, #e6e6e6); font-size:13px; line-height:20px; container-type: vss-wb-market; container-name: vss-wb-market; }
.vssWb * { box-sizing: border-box; }
.vssWbMuted { color: var(--dsw-alias-label-secondary, #a3a3a3); font-size:13px; line-height:1.65; }
.vssWbMarketHeader { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:24px var(--vssGutter) 0; }
.vssWbMarketHeaderText h1 { font-size:28px; line-height:36px; font-weight:650; letter-spacing:-.025em; margin:0 0 7px; }
.vssWbSearch { position:relative; display:block; margin-top:12px; }
.vssWbSearch input { width:100%; min-width:220px; max-width:480px; padding:7px 11px 7px 34px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-1, #262626); color:inherit; font:inherit; outline:none; }
.vssWbSearch input:focus-visible { outline:2px solid var(--dsw-focus-ring-color, #4d7cfe); outline-offset:1px; }
.vssWbSearchIcon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color: var(--dsw-alias-label-tertiary, #737373); font-size:12px; pointer-events:none; }
.vssWbBtn { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-1, #262626); color: inherit; font: inherit; padding:5px 10px; border-radius:6px; cursor:pointer; }
.vssWbBtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.vssWbPrimary { background: var(--dsw-alias-button-primary-fill, #4d7cfe); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.vssWbPrimary:hover { background: var(--dsw-alias-button-primary-hover, #3d6ce0); }
.vssWbCreate { padding:8px 13px; }
.vssWbNotice { margin:16px var(--vssGutter) 0; padding:10px 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-1, #262626); color: var(--dsw-alias-label-secondary, #a3a3a3); font-size:13px; }
.vssWbToolbar { display:flex; justify-content:space-between; gap:16px; padding-top:20px; margin-bottom:20px; padding-left:var(--vssGutter); padding-right:var(--vssGutter); align-items:center; flex-wrap:wrap; }
.vssWbTabs { display:flex; gap:6px; }
.vssWbTab { border:0; background:transparent; color: var(--dsw-alias-label-secondary, #a3a3a3); font:inherit; padding:5px 14px; border-radius:999px; cursor:pointer; }
.vssWbTab[aria-selected="true"] { background: color-mix(in srgb, var(--dsw-alias-bg-module-platform, #1b1c1f) 92%, var(--dsw-alias-label-primary, #e6e6e6) 8%); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight:600; }
.vssWbBrowseTools { display:flex; align-items:center; gap:10px; }
.vssWbRound { width:26px; height:26px; border-radius:50%; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: transparent; color: inherit; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; font-size:12px; flex:0 0 auto; }
.vssWbRound[aria-pressed="true"] { color: var(--dsw-alias-state-business-primary, #4d7cfe); border-color: var(--dsw-alias-state-business-primary, #4d7cfe); }
.vssWbSelect { border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-1, #262626); color: inherit; font: inherit; border-radius:8px; padding:7px 9px; min-width:110px; }
/* 列宽下限 = 216px：设置面板内容区 ~480px 时正好排 2 列（216×2+16=448 ≤ 480）⇒
   窄面板不再退化成 3 列（每列 125px ⇒ 按钮被挤爆 ✗）；中栏整页则自然排 3–4 列 ✓ */
.vssWbGrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(216px, 1fr)); gap:16px; align-items:stretch; padding:0 var(--vssGutter); }
.vssWbCard { min-height:320px; border-radius:14px; border:0; background: var(--dsw-alias-bg-module-platform, #1b1c1f); padding:0; display:flex; flex-direction:column; overflow:hidden; min-width:0; }
.vssWbMedia { margin:16px 16px 0; aspect-ratio:16/9; max-height:180px; border-radius:6px; position:relative; background: var(--dsw-alias-bg-layer-2, #303030); border:0; padding:0; cursor:pointer; width:calc(100% - 32px); overflow:hidden; flex:0 0 auto; }
.vssWbPreview { position:absolute; inset:0; display:flex; flex-direction:column; gap:8px; padding:12px; }
.vssWbPreviewDots { display:flex; gap:6px; }
.vssWbPreviewDots i { width:6px; height:6px; border-radius:50%; background: var(--dsw-alias-label-tertiary, #737373); display:block; }
.vssWbPreviewRow { flex:1; display:flex; gap:8px; }
.vssWbPreviewRow span { flex:1; border-radius:4px; background: var(--dsw-alias-bg-layer-1, #262626); display:block; }
.vssWbMediaZoom { position:absolute; right:8px; bottom:8px; width:24px; height:24px; border-radius:50%; background: rgba(0,0,0,.45); display:grid; place-items:center; font-size:11px; opacity:0; transition:opacity .16s; }
.vssWbMedia:hover .vssWbMediaZoom { opacity:1; }
.vssWbCardBody { padding:16px; display:flex; flex-direction:column; gap:8px; flex:1; min-height:0; min-width:0; }
.vssWbCardTitle { display:flex; align-items:center; gap:8px; min-width:0; }
.vssWbCardTitle h2 { font-size:18px; line-height:26px; font-weight:650; letter-spacing:-.018em; margin:0; min-width:0; }
.vssWbTitleText { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vssWbCategory { font-size:11px; color: var(--dsw-alias-label-tertiary, #737373); border:1px solid var(--dsw-alias-border-l2, #3e3e3e); border-radius:4px; padding:0 5px; flex:0 0 auto; }
.vssWbAuthorRow { display:flex; align-items:center; gap:8px; font-size:12.5px; color: var(--dsw-alias-label-secondary, #a3a3a3); min-width:0; }
.vssWbAuthorRow b { font-weight:600; color: var(--dsw-alias-label-primary, #e6e6e6); max-width:150px; }
.vssWbCardVersion { flex:0 0 auto; white-space:nowrap; }
.vssWbCardVersion::before { content:"· "; }
/* 描述：固定两行（照 dsh-desktop 的卡片形态）—— 少一行会截字、多一行会把卡片撑得高低不一 ✗ */
.vssWbCardDescription { margin:0; min-height:42px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.vssWbCardDescription p { margin:0; }
/* 底部一行：只放控件（GitHub / 收藏 / 主按钮）—— 指标已挪到上面独占一行 */
.vssWbActions { margin-top:auto; padding-top:4px; display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-wrap:nowrap; min-width:0; }
.vssWbCardControls { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
.vssWbCardBtn { font-size:12px; line-height:18px; padding:6px 11px; border-radius:999px; white-space:nowrap; flex:0 0 auto; }
.vssWbInstalled { font-size:12px; color: var(--dsw-alias-label-tertiary, #737373); white-space:nowrap; flex:0 0 auto; }
.vssWbMetrics { display:flex; gap:12px; font-size:12px; color: var(--dsw-alias-label-tertiary, #737373); min-width:0; overflow:hidden; }
.vssWbMetrics span { white-space:nowrap; }
.vssWbMoreContainer { display:flex; flex-direction:column; align-items:center; gap:8px; padding:24px 0 40px; }
.vssWbMore { min-width:140px; height:36px; border-radius:999px; font-size:13px; font-weight:550; justify-content:center; }
.vssWbMoreCount { margin:0; color: var(--dsw-alias-label-tertiary, #737373); font-size:13px; }
.vssWbEmpty { grid-column:1/-1; border:1px dashed var(--dsw-alias-border-l2, #3e3e3e); border-radius:14px; min-height:240px; padding:32px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; text-align:center; }
.vssWbEmpty strong { font-size:15px; font-weight:650; }
.vssWbModalBackdrop { position:fixed; inset:0; background: rgba(16,16,18,.52); z-index:9998; display:flex; align-items:center; justify-content:center; padding:24px; }
.vssWbModal { max-width:880px; width:100%; max-height:85vh; overflow:auto; padding:24px; border-radius:14px; background: var(--dsw-alias-bg-module-platform, #1b1c1f); border:1px solid var(--dsw-alias-border-l2, #3e3e3e); }
.vssWbModalHead { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
.vssWbModalHead h2 { font-size:18px; line-height:26px; font-weight:650; margin:0; display:flex; align-items:center; gap:8px; }
.vssWbModalIcon { width:26px; height:26px; border-radius:8px; background: var(--dsw-alias-bg-layer-2, #303030); display:grid; place-items:center; font-size:14px; }
.vssWbModalMeta { display:flex; align-items:center; gap:10px; margin-top:14px; font-size:12.5px; color: var(--dsw-alias-label-secondary, #a3a3a3); }
@container vss-wb-market (max-width:760px) { .vssWbGrid { grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); } }
/* ── 卡片媒体区：产品截图（目录给的第一张）＋ 模拟预览骨架 ─────────────────── */
.vssWbCardScreenshot { width:100%; height:100%; object-fit:cover; object-position:center; display:block; }
.vssWbPreviewPanes { display:grid; grid-template-columns:1.45fr 1fr; gap:6px; padding:8px 10px 10px; height:100%; }
.vssWbPreviewPane { background: var(--dsw-alias-bg-layer-1, #252526); border:1px solid var(--dsw-alias-border-l2, #3e3e3e); border-radius:6px; padding:7px; display:flex; flex-direction:column; gap:5px; min-width:0; }
.vssWbPreviewPane em { font-style:normal; font-size:10px; color: var(--dsw-alias-label-secondary, #a3a3a3); }
.vssWbPreviewPane i { display:block; height:5px; border-radius:3px; background: var(--dsw-alias-border-l2, #3e3e3e); }
.vssWbPreviewIcon { flex:1 1 auto; display:grid; place-items:center; font-size:30px; }
/* ── 作者行：GitHub 头像 ────────────────────────────────────────────────── */
.vssWbMetaItem { display:inline-flex; align-items:center; gap:6px; min-width:0; }
.vssWbAuthor b { font-weight:600; font-size:12px; color: var(--dsw-alias-label-primary, #e6e6e6); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:150px; }
.vssWbAvatar { width:20px; height:20px; border-radius:50%; object-fit:cover; background: var(--dsw-alias-bg-layer-2, #303030); }
.vssWbTitleText { color: inherit; text-decoration:none; }
a.vssWbTitleText:hover { text-decoration:underline; }
/* ── 详情：截图轮播 ─────────────────────────────────────────────────────── */
.vssWbCarousel { position:relative; margin:0 0 14px; border-radius:8px; overflow:hidden; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); }
.vssWbCarouselImage { display:block; width:100%; max-height:360px; object-fit:contain; background: var(--dsw-alias-bg-layer-1, #252526); }
.vssWbCarouselNav { position:absolute; top:50%; transform:translateY(-50%); width:28px; height:28px; border-radius:50%; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-2, #303030); color: var(--dsw-alias-label-primary, #e6e6e6); cursor:pointer; font-size:16px; line-height:1; }
.vssWbCarouselNav[data-side="prev"] { left:8px; }
.vssWbCarouselNav[data-side="next"] { right:8px; }
.vssWbCarouselCount { position:absolute; right:8px; bottom:8px; padding:2px 7px; border-radius:9px; background: rgba(0,0,0,.62); color:#fff; font-size:11px; }
/* ── 制作自己的工作台（三步）────────────────────────────────────────────── */
.vssWbSubmit { padding:0 32px 40px; display:flex; flex-direction:column; gap:18px; }
.vssWbSteps { display:flex; flex-direction:column; gap:14px; }
.vssWbStep { border:1px solid var(--dsw-alias-border-l2, #3e3e3e); border-radius:10px; padding:14px 16px; display:flex; flex-direction:column; gap:8px; }
.vssWbStep strong { font-size:13.5px; }
.vssWbStep p { margin:0; font-size:12.5px; line-height:1.7; color: var(--dsw-alias-label-secondary, #a3a3a3); }
.vssWbStepNum { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:50%; background: var(--dsw-alias-brand-primary, #0a84ff); color:#fff; font-size:11px; font-weight:700; }
.vssWbStepActions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.vssWbStepLink { background:none; border:none; color: var(--dsw-alias-label-secondary, #a3a3a3); text-decoration:underline; cursor:pointer; font-size:12px; padding:0; }
.vssWbPrompt { width:100%; min-height:180px; resize:vertical; padding:10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, #3e3e3e); background: var(--dsw-alias-bg-layer-1, #252526); color: var(--dsw-alias-label-primary, #e6e6e6); font-family: var(--dsw-font-mono, monospace); font-size:12px; line-height:1.6; }
.vssWbSubmitCategory { display:flex; align-items:center; gap:8px; font-size:12.5px; }
.vssWbSubmitOutcome { font-size:12px; }
/* ── 2026-10-22：兼容性标记 / 卸载 ─────────────────────────────────────────── */
.vssWbCompat { font-size:11px; line-height:16px; padding:1px 7px; border-radius:999px; white-space:nowrap; flex:0 0 auto; border:1px solid currentColor; }
.vssWbCompat[data-status="incompatible"] { color: var(--dsw-alias-state-warn-primary, #e0a43a); }
.vssWbCompat[data-status="ok"] { color: var(--dsw-alias-label-tertiary, #737373); }
.vssWbCompat[data-status="pending"] { color: var(--dsw-alias-state-business-primary, #4d7cfe); }
.vssWbLink { background:none; border:none; color: var(--dsw-alias-label-tertiary, #737373); font:inherit; font-size:12px; cursor:pointer; padding:0 2px; text-decoration:underline; flex:0 0 auto; }
.vssWbLink:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }
@media (prefers-reduced-motion: reduce) { .vssWb * { transition:none !important; } }
`;
		let cssInjected = false;
		function injectCss() {
			if (cssInjected || typeof document === "undefined") { return; }
			cssInjected = true;
			try {
				const tag = document.createElement("style");
				tag.setAttribute("data-vssaros-market-css", "1");
				tag.textContent = CSS;
				document.head.appendChild(tag);
			} catch { /* 样式失败只影响观感，不影响功能 */ }
		}

		function install(ctx, shell) {
			const bridge = (shell && shell.bridge) || {};
			const state = (shell && shell.state) || {};
			// 设置面板只存在于带官方 chrome 的视图（chat-only 聊天框里既没有侧栏也没有设置）⇒ 先自闸
			const chrome = bridge.surface === "full" || (bridge.surface === "chat" && bridge.chatOnly === false);
			if (!chrome) { return; }
			if (state.marketInstalled) { return; }
			injectCss();

			function notify(kind, text) {
				try { if (typeof bridge.notify === "function") { bridge.notify(kind, text); } } catch { /* 通知失败不影响别的 */ }
			}
			// ★ 2026-10-22 真机（"点安装没反应"）：商城页里自己的消息条 + 进行中的条目。
			//   `notify` 只进 IDE 主窗口右下角；用户在 dsh 窗口里操作时看不到 ⇒ 结果必须同时写在页面上。
			const MARKET_EVENT = "vssaros-market-ui";
			const ui = { message: null, busy: new Set() };
			function bumpUi() { try { window.dispatchEvent(new Event(MARKET_EVENT)); } catch { /* 无 window */ } }
			function say(kind, text) {
				ui.message = { kind: kind === "warn" ? "warn" : "info", text: String(text), at: Date.now() };
				bumpUi();
				notify(kind, text);
			}
			function useMarketUi() {
				const [, setVer] = react.useState(0);
				react.useEffect(() => {
					const h = () => setVer(v => v + 1);
					window.addEventListener(MARKET_EVENT, h);
					return () => window.removeEventListener(MARKET_EVENT, h);
				}, []);
				return ui;
			}
			/** 同一条目的操作串行化（装包分钟级，防重复点）；进行中卡片按钮显示"安装中…"。 */
			async function withBusy(entry, fn) {
				if (ui.busy.has(entry.id)) { return false; }
				ui.busy.add(entry.id); bumpUi();
				try { return await fn(); } finally { ui.busy.delete(entry.id); bumpUi(); }
			}
			/**
			 * 打开一个工作台。
			 * ★ 2026-10-22：**已注册进工作台宿主**的（第三方 / 已迁移的内置）⇒ 交给统一入口
			 *   `window.__vssarosOpenWorkbench`（workbenchNav 提供：开一个页签，内容是宿主 View）；
			 *   否则回落旧行为（侧栏页签，id 是目录里的 workbenchId）。
			 */
			function openWorkbench(entry) {
				const regId = String(entry?.registeredId || "").trim();
				if (regId && typeof window.__vssarosOpenWorkbench === "function") {
					try { if (window.__vssarosOpenWorkbench(regId)) { return; } } catch (e) {
						notify("warn", "打开失败：" + String((e && e.message) || e));
						return;
					}
				}
				const target = String(entry?.workbenchId || entry?.id || "").trim();
				if (!target) {
					notify("warn", "这个条目还没有接到侧栏页签（目录里没有 workbenchId）");
					return;
				}
				try {
					if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === "function") {
						ctx.sidebarRight.openTab(target);
						return;
					}
				} catch (e) {
					notify("warn", "打开失败：" + String((e && e.message) || e));
					return;
				}
				notify("warn", "当前没有可挂载的会话，" + (entry.name || "这个工作台") + " 的侧栏页签无处安放");
			}
			function readFavs() {
				try {
					const raw = window.localStorage && window.localStorage.getItem(LS_FAV);
					const arr = raw ? JSON.parse(raw) : [];
					return Array.isArray(arr) ? arr.map(String) : [];
				} catch { return []; }
			}
			function writeFavs(list) {
				try { window.localStorage && window.localStorage.setItem(LS_FAV, JSON.stringify(list)); } catch { /* 私密模式：收藏不持久 */ }
			}

			/** 读目录（Host 侧）。失败 ⇒ 如实报错，不装作「目录是空的」。 */
			async function loadCatalog(force) {
				if (typeof fetch !== "function") { return { ok: false, error: "这个环境没有 fetch（目录读不了）" }; }
				try {
					const res = await fetch(CATALOG_API + (force ? "?force=1" : ""), { credentials: "same-origin", cache: "no-store" });
					if (!res || !res.ok) {
						return { ok: false, error: "目录服务返回 HTTP " + (res ? res.status : "(无响应)") };
					}
					const body = await res.json();
					if (!body || !Array.isArray(body.workbenches)) {
						return { ok: false, error: "目录服务返回的不是一个目录" };
					}
					return { ok: true, body };
				} catch (e) {
					return { ok: false, error: String((e && e.message) || e) };
				}
			}

			/**
			 * 安装一个目录条目（Host ⇒ 经 IDE 安装通道；IDE 会先弹确认框）。
			 * ★ 2026-10-22：**如实**说结果 —— 只有 `ok:true` 才算装上；装上后提示"重启 Harness 后出现"。
			 *   失败按错误码给人话（不兼容 / 用户取消 / 宿主单例 / 待批准构建 / 其它）。
			 * ★ 同日真机（"点安装没反应"）：结果**也写在商城页面里**（`say`）—— `notify` 只进 IDE 主窗口右下角，
			 *   用户在 dsh 窗口里点的时候根本看不到。
			 */
			async function installEntry(entry) {
				if (typeof fetch !== "function") { say("warn", "这个环境没有 fetch（装不了）"); return false; }
				try {
					const res = await fetch(INSTALL_API, {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: entry.id }),
					});
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body?.ok !== true) {
						if (body?.code === "declined") { say("info", "已取消安装「" + (entry.name || entry.id) + "」"); return false; }
						say("warn", "安装「" + (entry.name || entry.id) + "」失败：" + String(body?.error || ("HTTP " + res.status)));
						return false;
					}
					const warn = Array.isArray(body.warnings) && body.warnings.length ? "（注意：" + body.warnings[0] + "）" : "";
					say("info", "已安装「" + (entry.name || entry.id) + "」" + (body.version ? " v" + body.version : "") + "。重启 Harness 后它会出现在工作台里" + warn);
					return true;
				} catch (e) {
					say("warn", "安装「" + (entry.name || entry.id) + "」失败：" + String((e && e.message) || e));
					return false;
				}
			}
			/** 卸载（只对从市场装的条目）。卸载不删用户数据；重启后生效。 */
			async function uninstallEntry(entry) {
				if (typeof fetch !== "function") { return false; }
				try {
					const res = await fetch(UNINSTALL_API, {
						method: "POST", credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: entry.id }),
					});
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body?.ok !== true) {
						say("warn", "卸载失败：" + String(body?.error || ("HTTP " + res.status)));
						return false;
					}
					say("info", "已卸载「" + (entry.name || entry.id) + "」。重启 Harness 后生效（它的数据不会被删除）");
					return true;
				} catch (e) {
					say("warn", "卸载失败：" + String((e && e.message) || e));
					return false;
				}
			}
			/** 只做兼容性检查（不装）：结论会写进 Host 缓存，目录卡片随即标出。 */
			async function checkEntry(entry) {
				if (typeof fetch !== "function") { return null; }
				try {
					const res = await fetch(CHECK_API + "?id=" + encodeURIComponent(entry.id), { credentials: "same-origin", cache: "no-store" });
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body?.ok !== true) { say("warn", "检查失败：" + String(body?.error || ("HTTP " + res.status))); return null; }
					return body;
				} catch (e) {
					say("warn", "检查失败：" + String((e && e.message) || e));
					return null;
				}
			}

			/**
			 * 工作台宿主（`@vssaros/dsh-workbenches`）里**当前已注册**的工作台（快照 + 订阅）。
			 * 拿不到宿主 ⇒ 空列表（不编造）。chunk 拿不到 ctx 的可选注入结果 ⇒ 用宿主暴露的只读快照钩子。
			 */
			function useRegisteredWorkbenches() {
				const read = () => {
					try {
						const snap = typeof globalThis.__vssarosWorkbenchesSnapshot === "function" ? globalThis.__vssarosWorkbenchesSnapshot() : null;
						return snap && Array.isArray(snap.workbenches) ? snap.workbenches : [];
					} catch { return []; }
				};
				const [list, setList] = react.useState(read);
				react.useEffect(() => {
					const svc = (() => { try { return ctx.get && ctx.get("desktopWorkbenches"); } catch { return null; } })();
					const refresh = () => setList(read());
					refresh();
					if (svc && typeof svc.subscribe === "function") { return svc.subscribe(refresh); }
					const timer = window.setInterval(refresh, 2000);
					return () => window.clearInterval(timer);
				}, []);
				return list;
			}

			// ── 卡片（复刻 dsh-desktop client.js:2138-2167）───────────────────────────
			/**
			 * 卡片媒体区：**有截图就显示截图**（目录里的第一张）；没有 ⇒ 模拟预览骨架
			 * （两个面板：会话 / 业务区域）—— 绝不伪造截图 ✗。
			 */
			function Preview(props) {
				const it = props.item;
				const shots = Array.isArray(it.screenshots) ? it.screenshots : [];
				const src = shots.length ? String(shots[0].url || "") : "";
				if (src) {
					return react.createElement("img", {
						className: "vssWbCardScreenshot", src, alt: (it.name || "工作台") + " 产品截图", loading: "lazy",
						onError: ev => { if (ev && ev.target) { ev.target.style.display = "none"; } },
					});
				}
				return react.createElement("div", { className: "vssWbPreview", role: "img", "aria-label": (it.name || "工作台") + " 界面预览（模拟）" },
					react.createElement("div", { className: "vssWbPreviewDots" }, react.createElement("i"), react.createElement("i"), react.createElement("i")),
					it.icon ? react.createElement("div", { className: "vssWbPreviewIcon" }, it.icon)
						: react.createElement("div", { className: "vssWbPreviewPanes" },
							react.createElement("div", { className: "vssWbPreviewPane" },
								react.createElement("em"), "会话", react.createElement("i"), react.createElement("i")),
							react.createElement("div", { className: "vssWbPreviewPane" },
								react.createElement("em"), "业务区域", react.createElement("i"), react.createElement("i")),
						),
				);
			}

			/**
			 * GitHub 图标（**内联 SVG**）。
			 *
			 * ⚠ 为什么不用字符（如 "⌂"）：dsh 客户端的字体子集里没有那个字形 ⇒ 渲染成豆腐块 ✗
			 *   （截图里那个方框就是它）⇒ 一律用 SVG。
			 */
			function GithubIcon(props) {
				return react.createElement("svg", {
					viewBox: "0 0 24 24", width: props && props.size ? props.size : 14, height: props && props.size ? props.size : 14,
					fill: "currentColor", "aria-hidden": "true", focusable: "false",
				}, react.createElement("path", {
					d: "M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.28-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22 0 1.6-.02 2.89-.02 3.28 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z",
				}));
			}

			/** 媒体区右上角的「放大」角标（**内联 SVG**：字符 "⤢" 在 dsh 字体子集里没有字形 ⇒ 豆腐块 ✗）。 */
			function MaximizeIcon(props) {
				const size = props && props.size ? props.size : 12;
				return react.createElement("svg", {
					viewBox: "0 0 24 24", width: size, height: size, fill: "currentColor",
					"aria-hidden": "true", focusable: "false",
				}, react.createElement("path", {
					d: "M4 4h7v2H6v5H4V4zm9 0h7v7h-2V6h-5V4zM4 13h2v5h5v2H4v-7zm14 0h2v7h-7v-2h5v-5z",
				}));
			}

			/** 作者行：GitHub 头像（按 owner 登录名）＋ 名字 ＋ 版本。 */
			function AuthorItem(props) {
				const it = props.item;
				const owner = String(it.owner || "").trim();
				const avatar = owner ? ("https://github.com/" + encodeURIComponent(owner) + ".png?size=40") : "";
				return react.createElement("span", { className: "vssWbMetaItem vssWbAuthor", title: "作者：" + (owner || it.author || "暂无") },
					avatar ? react.createElement("img", { className: "vssWbAvatar", src: avatar, alt: "", loading: "lazy",
						onError: ev => { if (ev && ev.target) { ev.target.style.display = "none"; } } })
						: react.createElement("span", { className: "vssWbModalIcon", style: { width: 20, height: 20, fontSize: 11 } }, "👤"),
					react.createElement("b", null, owner || it.author || "暂无"),
				);
			}

			function Card(props) {
				const it = props.item;
				// 指标只对**目录里给了数**的条目渲染；没有数 ⇒ 整块不渲染（不显示 0 / 假数字 ✓）
				const listed = it.listed === true;
				const stars = Number.isFinite(it.stars) ? it.stars : null;
				const downloads = Number.isFinite(it.downloads) ? it.downloads : null;
				const hasMetrics = listed && (stars !== null || downloads !== null);
				const faved = props.faved;
				const installed = it.installed === true;
				// 「打开」：内置工作台（有 route）或**已注册进工作台宿主**的（registeredId）
				const canOpen = installed && (!!it.route || !!it.registeredId);
				const compat = it.compatibility && it.compatibility.status;
				// 已知不兼容 / 被策略停用 ⇒ 不给「安装」
				const policyBlocked = !!(it.policy && it.policy.allowed === false);
				const canInstall = it.installable === true && !installed && compat !== "incompatible" && !policyBlocked;
				// 装上了但宿主里还没有它 ⇒ 要重启 Harness 才会加载（运行中的进程不热加载新包）
				const awaitingRestart = installed && !it.route && !it.registeredId && it.installedFromMarket === true;
				const repo = String(it.url || "").trim();
				return react.createElement("article", { className: "vssWbCard", "data-vssaros-market-card": it.id },
					// 媒体区：截图 / 模拟预览 ⇒ 点击开详情模态
					react.createElement("button", {
						type: "button", className: "vssWbMedia",
						"aria-label": "查看" + it.name + "详情",
						onClick: () => props.onDetail(it),
					},
						react.createElement(Preview, { item: it }),
						react.createElement("span", { className: "vssWbMediaZoom" }, react.createElement(MaximizeIcon, { size: 12 })),
					),
					react.createElement("div", { className: "vssWbCardBody" },
						react.createElement("div", { className: "vssWbCardTitle" },
							repo ? react.createElement("h2", null,
								react.createElement("a", { className: "vssWbTitleText", href: repo, target: "_blank", rel: "noopener noreferrer" },
									it.name || it.id))
								: react.createElement("h2", null, react.createElement("span", { className: "vssWbTitleText" }, it.name || it.id)),
							props.mine ? react.createElement("span", { className: "vssWbCategory" }, it.local ? "本地" : (it.category || "其他")) : null,
						),
						react.createElement("div", { className: "vssWbAuthorRow" },
							react.createElement(AuthorItem, { item: it }),
							it.version ? react.createElement("span", { className: "vssWbCardVersion" }, "v" + it.version) : null,
							compat === "incompatible" ? react.createElement("span", {
								className: "vssWbCompat", "data-status": "incompatible", "data-vssaros-market-compat": "incompatible",
								title: "与当前 dsh " + String(it.compatibility.runtimeVersion || "") + " 不兼容：" + Object.entries(it.compatibility.requirements || {}).map(([n, r]) => n + " " + r).join("；"),
							}, "不兼容") : null,
							awaitingRestart ? react.createElement("span", { className: "vssWbCompat", "data-status": "pending", title: "已安装，重启 Harness 后出现" }, "待重启") : null,
						),
						// 指标**独立成行**（不放底部）：窄卡片里底部还要放 GitHub / 收藏 / 主按钮，
						// 指标挤进去会被压成竖排（★ / 0 分两行）✗ ⇒ 挪到上面独占一行 ✓
						hasMetrics ? react.createElement("div", { className: "vssWbMetrics" },
							stars !== null ? react.createElement("span", { title: "GitHub Stars" }, "★ " + stars) : null,
							downloads !== null ? react.createElement("span", { title: "下载数" }, "⬇ " + downloads) : null,
						) : null,
						react.createElement("div", { className: "vssWbCardDescription" },
							react.createElement("p", { className: "vssWbMuted" }, it.description || "这个工作台暂时还没有填写介绍。"),
						),
						react.createElement("div", { className: "vssWbActions" },
							react.createElement("div", { className: "vssWbCardControls" },
								repo ? react.createElement("a", {
									className: "vssWbRound", href: repo, target: "_blank", rel: "noopener noreferrer",
									"aria-label": "在 GitHub 查看" + it.name, title: "查看 GitHub",
								}, react.createElement(GithubIcon, { size: 14 })) : null,
								react.createElement("button", {
									type: "button", className: "vssWbRound", "aria-pressed": faved ? "true" : "false",
									"aria-label": (faved ? "取消收藏" : "收藏") + it.name,
									onClick: () => props.onFav(it),
								}, faved ? "★" : "☆"),
								it.installedFromMarket === true && props.onUninstall ? react.createElement("button", {
									type: "button", className: "vssWbLink", "data-vssaros-market-uninstall": it.id,
									onClick: () => props.onUninstall(it),
								}, "卸载") : null,
								canOpen ? react.createElement("button", {
									type: "button", className: "vssWbBtn vssWbPrimary vssWbCardBtn",
									onClick: () => openWorkbench(it),
								}, "打开")
									: canInstall ? react.createElement("button", {
										type: "button", className: "vssWbBtn vssWbPrimary vssWbCardBtn",
										onClick: () => props.onInstall(it),
										disabled: ui.busy.has(it.id),
										"data-vssaros-market-install": it.id,
									}, ui.busy.has(it.id) ? "安装中…" : "安装")
										: installed ? react.createElement("span", { className: "vssWbInstalled", role: "status" }, awaitingRestart ? "重启后可用" : "已安装")
											: policyBlocked ? react.createElement("button", {
												type: "button", className: "vssWbBtn vssWbCardBtn", disabled: true, "data-vssaros-market-policy": "blocked",
												title: String(it.policy.reason || "已被停用"),
											}, "已停用")
											: compat === "incompatible" ? react.createElement("button", {
												type: "button", className: "vssWbBtn vssWbCardBtn", disabled: true,
												title: "与当前 dsh 版本不兼容，等作者发布兼容版本",
											}, "不兼容")
											: repo ? react.createElement("a", {
												className: "vssWbBtn vssWbPrimary vssWbCardBtn", href: repo, target: "_blank", rel: "noopener noreferrer",
											}, "查看安装说明")
												: react.createElement("button", {
													type: "button", className: "vssWbBtn vssWbCardBtn", disabled: true,
													title: "这个条目没有可安装的发布源",
												}, "不可安装"),
							),
						),
					),
				);
			}

			// ── 详情模态（复刻 dsh-desktop 1790-1811；portal 到 body）─────────────────
			/** 截图轮播（多张时左右切换 ＋ 计数）。 */
			function ScreenshotGallery(props) {
				const it = props.item;
				const shots = (Array.isArray(it.screenshots) ? it.screenshots : []).filter(s => s && s.url);
				const [index, setIndex] = react.useState(0);
				if (!shots.length) { return null; }
				const many = shots.length > 1;
				const go = (delta) => { setIndex(v => Math.max(0, Math.min(shots.length - 1, v + delta))); };
				return react.createElement("div", { className: "vssWbCarousel", role: "region", "aria-roledescription": "轮播",
					"aria-label": (it.name || "工作台") + " 产品截图" },
					react.createElement("img", { className: "vssWbCarouselImage", src: shots[index].url, alt: shots[index].alt || ((it.name || "工作台") + " 截图") }),
					many ? react.createElement("button", { type: "button", className: "vssWbCarouselNav", "data-side": "prev", "aria-label": "上一张", onClick: () => go(-1) }, "‹") : null,
					many ? react.createElement("button", { type: "button", className: "vssWbCarouselNav", "data-side": "next", "aria-label": "下一张", onClick: () => go(1) }, "›") : null,
					many ? react.createElement("span", { className: "vssWbCarouselCount", "aria-live": "polite" }, (index + 1) + " / " + shots.length) : null,
				);
			}

			/** 详情里的兼容性一行：有结论就显示；没有 ⇒ 给「检查兼容性」（会下载包做检查，不安装）。 */
			function CompatLine(props) {
				const it = props.item;
				const [result, setResult] = react.useState(it.compatibility || null);
				const [caps, setCaps] = react.useState(undefined);
				const [busy, setBusy] = react.useState(false);
				if (!it.installable) { return null; }
				if (it.policy && it.policy.allowed === false) {
					return react.createElement("p", { className: "vssWbMuted", style: { marginTop: 8 }, "data-vssaros-market-compat-line": "blocked" }, "✗ 已停用：" + String(it.policy.reason || ""));
				}
				const status = result && result.status;
				const req = result && result.requirements ? Object.entries(result.requirements).map(([n, r]) => n + " " + r).join("；") : "";
				const capText = caps === undefined ? null
					: caps === null ? "看不到这个包的代码（npm / 源码来源），列不出它的服务端会做什么。"
						: caps.length ? "静态扫描：它的服务端会" + caps.map(c => c.label).join("、") + "。"
							: "静态扫描没发现启动进程、注册 AI 工具、联网、写文件等行为。";
				return react.createElement("div", { style: { marginTop: 8 } },
					react.createElement("p", { className: "vssWbMuted", style: { margin: 0 }, "data-vssaros-market-compat-line": status || "none" },
						status === "ok" ? "✓ 与当前 dsh " + (result.runtimeVersion || "") + " 兼容"
							: status === "incompatible" ? "✗ 与当前 dsh " + (result.runtimeVersion || "") + " 不兼容" + (req ? "（它要求 " + req + "）" : "") + "。装上也会被 dsh 跳过。"
								: status === "unknown" ? "兼容性未能确认：" + String(result.reason || "")
									: "还没检查过与当前 dsh 版本的兼容性。",
						caps === undefined ? react.createElement("button", {
							type: "button", className: "vssWbLink", disabled: busy, style: { marginLeft: 8 },
							onClick: () => { setBusy(true); checkEntry(it).then(body => { setBusy(false); if (body) { setResult(body.compatibility); setCaps(body.capabilities === undefined ? null : body.capabilities); } }); },
						}, busy ? "检查中…" : "检查兼容性与权限") : null,
					),
					capText ? react.createElement("p", { className: "vssWbMuted", style: { margin: "4px 0 0" }, "data-vssaros-market-caps": caps ? caps.map(c => c.key).join(",") : "unknown" }, capText) : null,
				);
			}

			function DetailModal(props) {
				const it = props.item;
				const close = props.onClose;
				react.useEffect(() => {
					const onKey = ev => { if (ev.key === "Escape") { close(); } };
					document.addEventListener("keydown", onKey);
					return () => document.removeEventListener("keydown", onKey);
				}, []);
				const stars = Number.isFinite(it.stars) ? it.stars : null;
				const downloads = Number.isFinite(it.downloads) ? it.downloads : null;
				const sourceLabel = {
					"npm": "npm 包",
					"github-release": "GitHub Release 安装包",
					"github-source": "GitHub 源码",
				}[String((it.distribution && it.distribution.type) || "")] || "";
				const modal = react.createElement("div", { className: "vssWbModalBackdrop", onClick: ev => { if (ev.target === ev.currentTarget) { close(); } } },
					react.createElement("div", { className: "vssWbModal", role: "dialog", "aria-modal": "true", "aria-label": it.name + " 详情" },
						react.createElement("div", { className: "vssWbModalHead" },
							react.createElement("h2", null, it.name || it.id),
							react.createElement("button", { type: "button", className: "vssWbBtn", autoFocus: true, onClick: close }, "关闭"),
						),
						react.createElement(ScreenshotGallery, { item: it }),
						react.createElement("p", null, it.description || "这个工作台暂时还没有填写介绍。"),
						it.descriptionEn ? react.createElement("p", { className: "vssWbMuted" }, it.descriptionEn) : null,
						react.createElement("div", { className: "vssWbModalMeta" },
							react.createElement("b", null, it.owner || it.author || "暂无"),
							it.version ? react.createElement("span", null, "· v" + it.version) : null,
							it.license ? react.createElement("span", null, "· " + it.license) : null,
							it.category ? react.createElement("span", null, "· " + it.category) : null,
						),
						(stars !== null || downloads !== null) ? react.createElement("div", { className: "vssWbMetrics", style: { marginTop: 10 } },
							stars !== null ? react.createElement("span", null, "★ " + stars) : null,
							downloads !== null ? react.createElement("span", null, "⬇ " + downloads) : null,
						) : null,
						it.url ? react.createElement("p", { className: "vssWbMuted", style: { marginTop: 12 } },
							react.createElement("a", { href: it.url, target: "_blank", rel: "noopener noreferrer" }, "查看 GitHub 仓库")) : null,
						react.createElement("p", { className: "vssWbMuted", style: { marginTop: 12 } },
							sourceLabel
								? "发布源：" + sourceLabel + "（安装时按目录公示的版本与校验值核对；安装前会检查与当前 dsh 版本是否兼容）"
								: "这个条目没有可安装的发布源。"),
						react.createElement(CompatLine, { item: it }),
					),
				);
				// 官方是 React portal 到 body；我们**没有 react-dom**（chunk 只能 require react）⇒
				// 就地渲染（遮罩 position:fixed ⇒ 观感一致 ✓）
				return modal;
			}

			// ── 制作自己的工作台（复刻 dsh-desktop 的 submit 视图：2071-2101）──────────
			/** dsh 工作台市场的策展仓库（投稿 PR 提交到这里；本机不保存投稿状态）。 */
			const MARKET_REPO = "https://github.com/dataelement/awesome-dsh-workbench";

			/** 给 Agent 的「开发工作台」指令。 */
			function developmentPromptText() {
				return [
					"请帮我开发一个 dsh 工作台（工作台 = 有专属界面、会话与资料的插件）。",
					"要求：",
					"1. 代码放在我自己的公开 GitHub 仓库根目录（一个工作台，暂不支持 monorepo 子目录），并带许可证。",
					"2. package.json 是安装契约：完整 SemVer 版本、repository 指回本仓库、声明 dsh.bundle.patch、exports[\"./client\"] 真实存在。",
					"3. 界面边界、目录选择、会话归属、模式切换按《工作台开发规范》做。",
					"4. 打包后不超过 8MiB；包内不得含 .env / 令牌 / 密钥 / 客户数据 / 本机绝对路径。",
					"5. 至少一个可用安装源：npm 包、GitHub Release 安装包（.tgz）或仓库源码可直接安装。",
					"6. 全部开发完成后先装到本机自测并实际打开验证。",
					"（我还没明确要求上架时，停在「本机可用」就好，不要自作主张公开代码。）",
				].join("\n");
			}

			/** 给 Agent 的「投稿上架」指令。 */
			function submissionPromptText(category) {
				return [
					"我要把工作台上架到 dsh 工作台市场。",
					"1. 准备上架资料：名称、分类、中英文简介各一行（如实，不夸大）、1–5 张截图（存自己仓库，PNG/JPEG/WebP，单张 ≤2MiB，建议横向 16:9、宽 ≥1280px）。",
					"2. 选定安装源：发布 npm 包，或上传 .tgz 到 GitHub Release（用 releases/latest/download/<固定文件名>，文件名不要带版本号），或保证默认分支可直接安装。",
					"3. 向 " + MARKET_REPO + " 提交一个收录 PR，**只新增** data/workbenches/<owner>__<repo>.yml：",
					"   url / name / category / description.zh / description.en / screenshots（GitHub Release 路径再加 tarball）。",
					"   不要在 YAML 里写 version、npm 包名、校验值或作者 ID（市场会自动探测）。",
					"4. 提交 PR 就是进入审核；进度以 GitHub 上的 PR 为准，PR 合并且市场目录更新后，工作台才会出现在市场里。",
					category ? ("期望分类：" + category + "（可在 YAML 的 category 字段改成 market/data/categories.json 里已有的分类）。") : "",
				].filter(Boolean).join("\n");
			}

			/**
			 * 本机内置的工作台清单（由 `client.workbenchNav.js` 挂在 window 上）。
			 *
			 * ⚠ 拿不到就返回空数组（**不编造**）—— 商城界面只显示目录里真有的东西。
			 */
			function readLocalItems() {
				const raw = (typeof window !== "undefined" && window.__vssarosWorkbenchItems) || [];
				if (!Array.isArray(raw)) { return []; }
				return raw.filter(it => it && it.id && it.route).map(it => ({
					id: String(it.id),
					/** 侧栏页签 id（打开时用它寻址）—— 目录条目用的是 workbenchId，这里是本机 id。 */
					workbenchId: String(it.id),
					name: String(it.name || it.id),
					icon: wbIconEmoji(it.ico),
					route: String(it.route),
					category: "local",
					local: true,
					listed: false,
					installed: true,
					installable: false,
					description: "本机随产品分发的工作台。",
					author: "VsSaros（本机）",
					screenshots: [],
					owner: "",
					version: "",
				}));
			}

			/** 复制文本（失败时把内容显示出来让人手动复制 ✗ 不静默失败）。 */
			function copyText(text) {
				try {
					if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(text);
						return true;
					}
				} catch { /* 退回手动复制 */ }
				return false;
			}

			function SubmitView(props) {
				const [category, setCategory] = react.useState("");
				const [showPrompt, setShowPrompt] = react.useState(false);
				const [copied, setCopied] = react.useState("");
				const categories = (props.categories || []).filter(c => c && c.id);
				const prompt = submissionPromptText(category);
				const doCopy = () => {
					if (copyText(prompt)) { setCopied("已复制投稿指令，粘给 Agent 即可。"); }
					else { setShowPrompt(true); setCopied("复制失败，请展开下方的指令手动复制。"); }
				};
				return react.createElement("section", { className: "vssWbSubmit", "aria-label": "制作我的工作台", tabIndex: 0 },
					react.createElement("div", { className: "vssWbSteps" },
						react.createElement("div", { className: "vssWbStep" },
							react.createElement("span", { className: "vssWbStepNum" }, "1"),
							react.createElement("strong", null, "把开发指令交给 Agent"),
							react.createElement("p", null, "复制指令给你的 Agent。它会先跟你确认业务场景、目标用户和核心流程，再按《工作台开发规范》开发。只在本机使用，不需要上传代码。"),
							react.createElement("div", { className: "vssWbStepActions" },
								react.createElement("button", { type: "button", className: "vssWbBtn vssWbPrimary", onClick: () => copyText(developmentPromptText()) || setShowPrompt(true) }, "复制开发指令"),
							),
						),
						react.createElement("div", { className: "vssWbStep" },
							react.createElement("span", { className: "vssWbStepNum" }, "2"),
							react.createElement("strong", null, "装到本机，自测确认能用"),
							react.createElement("p", null, "开发完成后，让 Agent 把工作台装到这台机器，并按开发规范的本地自测清单检查、自己打开验证。尚未上架的版本会以「本地」标识出现。"),
						),
						react.createElement("div", { className: "vssWbStep" },
							react.createElement("span", { className: "vssWbStepNum" }, "3"),
							react.createElement("strong", null, "想上架，再按验收规范提交"),
							react.createElement("p", null, "把代码上传到你自己的 GitHub 仓库，准备简介和截图，再向 ",
								react.createElement("a", { href: MARKET_REPO, target: "_blank", rel: "noopener noreferrer" }, "工作台市场仓库"),
								"提交收录 PR。把投稿指令复制给 Agent 即可。"),
							categories.length ? react.createElement("label", { className: "vssWbSubmitCategory" },
								react.createElement("span", null, "上架分类"),
								react.createElement("select", { value: category, "aria-label": "上架分类", onChange: ev => setCategory(String(ev && ev.target ? ev.target.value : "")) },
									react.createElement("option", { value: "" }, "让 Agent 按规范选择"),
									categories.map(c => react.createElement("option", { key: c.id, value: c.id }, (c.name && (c.name.zh || c.name)) || c.id))),
							) : null,
							react.createElement("div", { className: "vssWbStepActions" },
								react.createElement("button", { type: "button", className: "vssWbBtn vssWbPrimary", onClick: doCopy }, "复制投稿指令"),
								react.createElement("button", { type: "button", className: "vssWbStepLink", onClick: () => setShowPrompt(v => !v) }, showPrompt ? "收起指令" : "查看指令"),
							),
							showPrompt ? react.createElement("textarea", { className: "vssWbPrompt", readOnly: true, value: prompt, "aria-label": "投稿工作台给 Agent 的指令" }) : null,
						),
					),
					copied ? react.createElement("p", { className: "vssWbMuted", role: "status" }, copied) : null,
					react.createElement("p", { className: "vssWbMuted vssWbSubmitOutcome" }, "提交 PR 就是进入审核，进度以 GitHub 上的 PR 为准，本机不保存投稿状态。PR 合并、市场目录更新后，工作台就会出现在工作台市场中。"),
				);
			}

			// ── 市场主体（页头 / 工具行 / 网格 / 加载更多 / 空态）─────────────────────
			function Market() {
				const [tab, setTab] = react.useState("market");
				const [q, setQ] = react.useState("");
				const [cat, setCat] = react.useState("all");
				const [sort, setSort] = react.useState("stars");
				const [visible, setVisible] = react.useState(PAGE_SIZE);
				const [favs, setFavs] = react.useState(readFavs);
				const [detail, setDetail] = react.useState(null);
				const [catalog, setCatalog] = react.useState(null);
				const [loadError, setLoadError] = react.useState("");
				const [loading, setLoading] = react.useState(false);

				const reload = (force) => {
					setLoading(true);
					return loadCatalog(force).then(result => {
						setLoading(false);
						if (result.ok) { setCatalog(result.body); setLoadError(""); }
						else { setLoadError(result.error); }
					});
				};
				react.useEffect(() => { reload(false); }, []);

				const toggleFav = (it) => {
					const next = favs.indexOf(it.id) >= 0 ? favs.filter(x => x !== it.id) : favs.concat([it.id]);
					setFavs(next);
					writeFavs(next);
				};
				const onInstall = (it) => {
					say("info", "正在安装「" + (it.name || it.id) + "」：下载与检查后会弹出确认框（在当前窗口）…");
					withBusy(it, () => installEntry(it)).then(ok => { if (ok) { reload(false); } });
				};
				const onUninstall = (it) => { withBusy(it, () => uninstallEntry(it)).then(ok => { if (ok) { reload(false); } }); };
				const uiState = useMarketUi();
				const registered = useRegisteredWorkbenches();
				// 目录身份 = `owner/repo`（小写），与宿主注册身份同口径 ⇒ 直接对上
				const registeredIds = new Set(registered.map(w => String(w.id || "").toLowerCase()));

				// Tab ⇒ 数据源（dsh：market=已上架条目 / favorites=收藏 / mine=已安装）
				const rawEntries = Array.isArray(catalog && catalog.workbenches) ? catalog.workbenches : [];
				const entries = rawEntries.map(it => registeredIds.has(String(it.id || "").toLowerCase())
					? Object.assign({}, it, { installed: true, registeredId: String(it.id).toLowerCase() }) : it);
				// 本机内置的工作台（随产品分发，**不是市场条目**）—— 由 workbenchNav chunk 挂在 window 上
				const localItems = readLocalItems();
				const marketInstalled = entries.filter(it => it.installed === true);
				// 宿主里已注册、但既不是内置条目也不在目录里的（本地装的第三方 / 已下架的）⇒ 也算"已安装"
				const known = new Set(entries.map(it => String(it.id || "").toLowerCase()));
				const extraRegistered = registered
					.filter(w => !String(w.id).startsWith("vssaros/") && !known.has(String(w.id).toLowerCase()))
					.map(w => ({
						id: w.id, registeredId: w.id, name: w.title || w.id, icon: wbIconEmoji(w.icon), description: w.description || "",
						category: "local", local: true, listed: false, installed: true, installable: false,
						author: String(w.id).split("/")[0] || "", owner: String(w.id).split("/")[0] || "", version: "", screenshots: [],
						url: /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(String(w.id)) ? "https://github.com/" + w.id : "",
					}));
				const installedCount = localItems.length + marketInstalled.length + extraRegistered.length;
				const base = tab === "favorites" ? entries.filter(it => favs.indexOf(it.id) >= 0)
					: tab === "mine" ? localItems.concat(marketInstalled, extraRegistered)
						: entries.filter(it => it.listed !== false);
				const declared = Array.isArray(catalog && catalog.categories) ? catalog.categories : [];
				// 分类下拉：**用目录声明的中文名**（不是原始 id —— id 是 productivity 这种英文 ✗）
				const usedIds = Array.from(new Set(base.map(it => it.category || "other")));
				const categories = [{ id: "all", name: "全部类型" }].concat(
					usedIds.map(id => {
						const hit = declared.find(c => c && c.id === id);
						const name = hit && hit.name ? (typeof hit.name === "string" ? hit.name : (hit.name.zh || hit.name.en || id)) : id;
						return { id, name };
					}),
				);
				const key = q.trim().toLowerCase();
				let list = base.filter(it => (cat === "all" || (it.category || "其他") === cat)
					&& (!key || String(it.name || "").toLowerCase().indexOf(key) >= 0
						|| String(it.author || "").toLowerCase().indexOf(key) >= 0
						|| String(it.category || "").toLowerCase().indexOf(key) >= 0
						|| String(it.description || "").toLowerCase().indexOf(key) >= 0));
				// 排序：**没值的排最后**（照 dsh 的 sortMarketEntries 语义）—— 目录没给 Star / 下载量时
				// 不该让"有值的"看起来更靠前，也不该显示假的 0 ✓
				const numOf = (value) => (Number.isFinite(value) ? value : null);
				const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh", { numeric: true });
				const withValueLast = (valueOf) => (a, b) => {
					const va = valueOf(a); const vb = valueOf(b);
					if (va === null && vb === null) { return byName(a, b); }
					if (va === null) { return 1; }
					if (vb === null) { return -1; }
					if (va === vb) { return byName(a, b); }
					return va - vb;
				};
				list = list.slice();
				if (sort === "name") { list.sort(byName); }
				else if (sort === "updated") { list.sort(withValueLast(it => numOf(it.updatedAt))); }
				else if (sort === "downloads") { list.sort(withValueLast(it => numOf(it.downloads))); }
				else { list.sort(withValueLast(it => numOf(it.stars))); }
				const shown = list.slice(0, visible);

				const onTab = (next) => { setTab(next); setCat("all"); setDetail(null); setVisible(PAGE_SIZE); };
				const onSearch = (v) => { setQ(v); setVisible(PAGE_SIZE); };

				const isSubmit = tab === "submit";
				return react.createElement("div", { className: "vssWb", "data-vssaros-page": "workbench-market" },
					// 页头（2050-2056）
					react.createElement("header", { className: "vssWbMarketHeader" },
						react.createElement("div", { className: "vssWbMarketHeaderText" },
							react.createElement("h1", null, isSubmit ? "制作属于你的工作台" : "工作台"),
							react.createElement("p", { className: "vssWbMuted" }, isSubmit ? "遵循规范开发、安装并验证，也可以准备材料提交到工作台市场。" : "有序组织专属界面、会话与资料"),
							!isSubmit ? react.createElement("label", { className: "vssWbSearch" },
								react.createElement("span", { className: "vssWbSearchIcon" }, "🔍"),
								react.createElement("input", {
									type: "search", placeholder: "搜索名称、作者或分类", "aria-label": "搜索工作台",
									value: q, "data-vssaros-market-search": "1",
									onChange: ev => onSearch(String(ev && ev.target ? ev.target.value : "")),
								}),
							) : null,
						),
						react.createElement("div", { className: "vssWbMarketHeaderActions" },
							react.createElement("button", {
								type: "button", className: "vssWbBtn vssWbPrimary vssWbCreate",
								onClick: () => { setTab(isSubmit ? "market" : "submit"); setCat("all"); setDetail(null); setVisible(PAGE_SIZE); },
							}, isSubmit ? "← 返回工作台市场" : "＋ 制作我的工作台"),
						),
					),
					// 状态条：如实说明目录来自哪儿 / 有没有读失败
					react.createElement("div", { className: "vssWbNotice", role: "status" },
						sourceText(catalog, loadError, loading)),
					// 操作结果（安装 / 卸载 / 检查）：页面内消息条（IDE 通知在 dsh 窗口里看不到）
					uiState.message ? react.createElement("div", {
						className: "vssWbNotice", role: uiState.message.kind === "warn" ? "alert" : "status",
						"data-vssaros-market-message": uiState.message.kind,
						style: { display: "flex", alignItems: "flex-start", gap: 10, borderColor: uiState.message.kind === "warn" ? "var(--dsw-alias-state-warn-primary, #e0a43a)" : undefined },
					},
						react.createElement("span", { style: { flex: "1 1 auto", minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, uiState.message.text),
						react.createElement("button", { type: "button", className: "vssWbLink", "aria-label": "关闭消息", onClick: () => { ui.message = null; bumpUi(); } }, "关闭"),
					) : null,
					// 工具行（2058-2070）
					!isSubmit ? react.createElement("div", { className: "vssWbToolbar" },
						react.createElement("div", { className: "vssWbTabs", role: "tablist", "aria-label": "工作台集合",
							onKeyDown: ev => {
								const order = ["market", "favorites", "mine"];
								const cur = order.indexOf(tab);
								let next = -1;
								if (ev.key === "ArrowRight") { next = (cur + 1) % order.length; }
								else if (ev.key === "ArrowLeft") { next = (cur - 1 + order.length) % order.length; }
								else if (ev.key === "Home") { next = 0; }
								else if (ev.key === "End") { next = order.length - 1; }
								if (next < 0) { return; }
								ev.preventDefault();
								onTab(order[next]);
							} },
							[
								["market", "市场"],
								["favorites", "我的收藏 (" + favs.length + ")"],
								["mine", "已安装 (" + installedCount + ")"],
							].map(([id, label]) => react.createElement("button", {
								key: id, type: "button", role: "tab", className: "vssWbTab",
								"aria-selected": tab === id ? "true" : "false",
								tabIndex: tab === id ? 0 : -1,
								"data-vssaros-market-tab": id,
								onClick: () => onTab(id),
							}, label)),
						),
						react.createElement("div", { className: "vssWbBrowseTools" },
							react.createElement("button", {
								type: "button", className: "vssWbRound", "aria-label": tab === "mine" ? "检查更新" : "刷新目录", "aria-busy": loading ? "true" : "false",
								onClick: () => { reload(true); },
							}, loading ? "…" : "⟳"),
							react.createElement("select", {
								className: "vssWbSelect", "aria-label": "按分类筛选", value: cat,
								onChange: ev => { setCat(String(ev && ev.target ? ev.target.value : "all")); setVisible(PAGE_SIZE); },
							}, categories.map(c => react.createElement("option", { key: c.id, value: c.id }, c.id === "all" ? "全部类型" : c.name))),
							react.createElement("select", {
								className: "vssWbSelect", "aria-label": "工作台排序方式", value: sort,
								onChange: ev => { setSort(String(ev && ev.target ? ev.target.value : "stars")); setVisible(PAGE_SIZE); },
							}, [
								["stars", "Star 数量"], ["downloads", "下载量"], ["updated", "更新时间"], ["name", "名称"],
							].map(([v, label]) => react.createElement("option", { key: v, value: v }, label))),
						),
					) : null,
					// 网格（2103-2173）｜ 制作视图（2071-2101）
					isSubmit ? react.createElement(SubmitView, { categories: declared })
						: react.createElement("section", { id: "dsh-workbench-" + tab + "-panel", role: "tabpanel", tabIndex: 0, "data-tab": tab },
						react.createElement("div", { className: "vssWbGrid" },
							shown.length ? shown.map(it => react.createElement(Card, {
								key: it.id, item: it, mine: tab === "mine",
								faved: favs.indexOf(it.id) >= 0,
								onFav: toggleFav, onDetail: setDetail, onInstall: onInstall, onUninstall: onUninstall,
							})) : react.createElement("div", { className: "vssWbEmpty" },
								react.createElement("strong", null,
									tab === "favorites" ? "还没有收藏工作台" : tab === "mine" ? "还没有安装工作台"
										: key ? "没有找到匹配的工作台" : "市场目录暂不可用"),
								react.createElement("span", { className: "vssWbMuted" },
									tab === "favorites" ? "把鼠标移到市场卡片上，点击书签即可收藏。"
										: tab === "mine" ? "到工作台市场选择一个工作台开始。"
											: key ? "试试其他关键词或分类。"
												: (loadError ? String(loadError) : "请重试读取目录，或使用已安装的工作台。")),
							),
						),
						list.length > visible ? react.createElement("div", { className: "vssWbMoreContainer" },
							react.createElement("button", {
								type: "button", className: "vssWbBtn vssWbMore",
								onClick: () => setVisible(v => v + PAGE_SIZE),
							}, "加载更多"),
							react.createElement("p", { className: "vssWbMoreCount" },
								"已显示 " + shown.length + " / 共 " + list.length + " 个工作台"),
						) : list.length ? react.createElement("div", { className: "vssWbMoreContainer" },
							react.createElement("p", { className: "vssWbMoreCount" },
								"已显示 " + shown.length + " / 共 " + list.length + " 个工作台"),
						) : null,
					),
					detail ? react.createElement(DetailModal, { item: detail, onClose: () => setDetail(null) }) : null,
				);
			}

			/** 状态条文案：目录来自哪儿 / 读失败没有（如实说，不装成"没有内容"）。 */
			function sourceText(catalog, loadError, loading) {
				if (loading && !catalog) { return "正在首次读取市场目录…"; }
				if (loading) { return "正在更新目录…"; }
				if (loadError) { return "市场目录暂不可用：" + String(loadError) + "。请重试读取目录，或使用已安装的工作台。"; }
				const source = (catalog && catalog.source) || {};
				const count = (catalog && catalog.total) || 0;
				if (source.origin === "remote") {
					return "目录来源：工作台市场 " + (source.url || "") + "（" + count + " 个工作台）"
						+ (source.stale ? "。在线市场暂时无法更新，正在显示上一次成功读取的目录。" : "");
				}
				return "目录来源：随包兜底目录（" + count + " 个工作台）。在线市场暂时无法读取，仍可使用已安装的工作台。";
			}

			// ── 设置分区本体（左侧导航一节「工作台商城」）──────────────────────────────────
			function WorkbenchSection(props) {
				const renderSlot = props && props.renderSlot;
				return react.createElement("div", null, renderSlot ? renderSlot(SLOT_CATALOG, {}) : null);
			}

			// ── 通用设置里那一行（快捷入口：把商城开到中栏整页）─────────────────────────
			function MarketRow() {
				return react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, width: "100%" }, "data-vssaros-setting": ROW_ID },
					react.createElement("span", { className: "vssWbModalIcon" }, "🧩"),
					react.createElement("span", { style: { flex: "1 1 auto", minWidth: 0 } },
						react.createElement("div", { style: { fontSize: 12.5, fontWeight: 600 } }, "工作台商城"),
						react.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)" } }, "浏览工作台目录：随包自带的与可安装的。"),
					),
					react.createElement("button", {
						type: "button", className: "vssWbBtn vssWbPrimary",
						"data-vssaros-market-open": "1",
						onClick: () => {
							try { ctx.layout.selectPanel(PANEL_KEY); } catch (e) {
								notify("warn", "打开工作台商城失败：" + String((e && e.message) || e));
							}
						},
					}, "打开"),
				);
			}

			// ── 注册：① 设置分区 ② 分区内容 ③ 中栏整页 ④ 通用设置快捷行 ──────────────────
			ctx.slots.inject(SLOT_SECTION, () => ctx.slots.register({
				name: SLOT_SECTION,
				id: SECTION_ID,
				order: SECTION_ORDER,
				label: () => "工作台商城",
				children: { [SLOT_CATALOG]: { kind: "list", scope: "root" } },
			}, WorkbenchSection));

			ctx.slots.inject(SLOT_CATALOG, () => ctx.slots.register(
				{ name: SLOT_CATALOG, id: "catalog", order: 0 },
				Market,
			));

			ctx.slots.inject(SLOT_MAIN, () => ctx.slots.register({ name: SLOT_MAIN, key: PANEL_KEY }, Market));

			try {
				ctx.slots.inject(SLOT_ITEM, () => ctx.slots.register(
					{ name: SLOT_ITEM, id: ROW_ID, order: ROW_ORDER },
					MarketRow,
				));
				state.marketRowRegistered = true;
			} catch (e) {
				state.marketRowError = String((e && e.message) || e);
			}
			state.marketInstalled = true;
		}

		exports.install = install;
		// 目录接口（守卫钉住：界面必须走 Host 的目录服务，不能再自己写死一份清单 ✗）
		exports.__catalogApi = CATALOG_API;
		exports.__installApi = INSTALL_API;
		exports.__uninstallApi = UNINSTALL_API;
		exports.__pageSize = PAGE_SIZE;
		return module.exports;
	},
});
