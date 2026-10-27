// @vssaros/dsh-workbenches — **工作台 UI 共享层**（2026-10-22，方案稿 §6.19）。
//
// 为什么要共享：7 个自有工作台各写一套 CSS ⇒ 7 种视觉语言（圆角/边框/间距/字号各不同），
// 而且大量裸色值（`#4C9AFF` / `rgba(127,127,127,.2)`）**不随 dsh 主题切换**（令牌在
// `body` 与 `body[data-ds-dark-theme]` 下各有一套值，裸色只有一套）。
//
// 三条规矩（守卫 `check-workbench-style.mjs` 钉住）：
//   ① 颜色**只走** `--dsw-alias-*` 令牌，且写成 `var(--dsw-alias-x, <兜底值>)`（令牌名不是公开契约）；
//   ② 间距/圆角/字号**只走**本文件定义的 `--wb-*` 刻度（dsh 没有这类令牌 ⇒ 我们定，且只定一次）；
//   ③ 组件只写**布局覆盖**，不再自造视觉（原语类名 `wb-*` 由本文件提供）。
//
// 注入方式：宿主客户端（`lib/client.js`）加载后调 `installWorkbenchUi()` 注入一次 `<style id="vssaros-wb-ui">`
// ⇒ 7 个工作台共用一份；宿主缺席（老版本）时各包留的「降级样式」仍可用 ✓。

// ⚠ 装载器只认 `client.*.js` 形状的子块（相对请求会被拒 ⇒ 见 client.workbenchNav.js 的同一处教训）⇒
//   本文件以 `__ModuleLoader__.load` 包一层，导出 `install()` / `CSS`；宿主入口 `require.async` 它并调 install ✓。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-workbenches',
	chunk: 'client.ui.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

/** 共享样式表（唯一真源；改这里 = 7 个工作台一起变）。 */
const WORKBENCH_UI_CSS = `
/* ── 0. 刻度（dsh 令牌里没有 font/radius/space ⇒ 由我们定，四档就够）──────────── */
:root {
	--wb-s1: 4px; --wb-s2: 8px; --wb-s3: 12px; --wb-s4: 16px;
	--wb-r-sm: 6px; --wb-r-md: 10px; --wb-r-pill: 999px;
	--wb-f-xs: 11px; --wb-f-sm: 12px; --wb-f-md: 13px; --wb-f-lg: 16px;
	/* ★ 2026-10-27：**工具条标题**专用字号（用户反馈"每个工作台的 title 太大"）。
	   独立于 `--wb-f-lg`：后者还给"空态/区块标题"用（scheduler、xhs-note），语义不同 ✗ */
	--wb-f-title: 14px;
	--wb-lh: 1.5;
	--wb-mono: var(--dsw-static-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, monospace);
}

/* ── 1. 根 / 工具条 ─────────────────────────────────────────────────────── */
.wb {
	display: flex; flex-direction: column; gap: var(--wb-s2);
	min-width: 0; height: 100%;
	padding: var(--wb-s3) var(--wb-s4);
	box-sizing: border-box;
	color: var(--dsw-alias-label-primary, #e6e6e6);
	font-size: var(--wb-f-sm);
	line-height: var(--wb-lh);
}
.wb-toolbar {
	display: flex; align-items: center; gap: var(--wb-s2); flex-wrap: wrap; min-width: 0;
	min-height: 32px;
}
.wb-title { margin: 0; font-size: var(--wb-f-lg); font-weight: 600; white-space: nowrap; }
/* ★ 2026-10-27（用户反馈「每个工作台的 title 太大」）：**工具条标题的唯一规格**。
   同时命中 `.wb-title` 与**裸 h1** —— 历史上有 7 个工作台标题写的是裸 `h1`（没加类），
   会吃宿主默认的 1.5em+ 大字号 ⇒ 9 个工作台标题大小不一 ✗ ⇒ 这里兜住，规格只定义一次 ✓
   ⚠ 上面 `.wb-title` 的 16px **保留**（空态/区块标题在用），只在工具条上下文压到 14px。 */
.wb-toolbar h1, .wb-toolbar .wb-title {
	margin: 0; font-size: var(--wb-f-title); font-weight: 600; line-height: 1.25; white-space: nowrap;
}
.wb-sub { font-size: var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); white-space: nowrap; }
.wb-stat { font-size: var(--wb-f-xs); color: var(--dsw-alias-label-secondary, rgba(230,230,230,.78)); white-space: nowrap; }
.wb-spacer { flex: 1 1 auto; }
.wb-links { display: flex; gap: var(--wb-s1); align-items: center; flex-wrap: wrap; }

/* ── 2. 分栏（左右两档；窄容器也保持左右，只收窄左列）──────────────────── */
.wb-split { flex: 1 1 auto; min-height: 0; display: flex; gap: var(--wb-s3); align-items: stretch; }
.wb-pane { display: flex; flex-direction: column; gap: var(--wb-s1); min-width: 0; min-height: 0; }
.wb-pane-left { flex: 0 1 340px; min-width: 240px; max-width: 46%; }
.wb-pane-right {
	flex: 1 1 auto; overflow: auto; min-width: 0;
	border-left: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
	padding-left: var(--wb-s3);
}
.wb-pane-hd { display: flex; align-items: center; gap: var(--wb-s2); min-width: 0; padding-bottom: var(--wb-s1); }
.wb-pane-title { font-size: var(--wb-f-sm); font-weight: 600; white-space: nowrap; }
.wb-pane-id { font-size: var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--wb-s2); }

/* ── 3. 列表 / 行 ──────────────────────────────────────────────────────── */
.wb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--wb-s1); }
.wb-row {
	display: grid; grid-template-columns: minmax(0, 1fr) auto;
	align-items: center; gap: var(--wb-s2);
	padding: var(--wb-s2) var(--wb-s3);
	border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
	border-radius: var(--wb-r-md);
	background: var(--dsw-alias-bg-layer-1, transparent);
	cursor: pointer; min-width: 0;
}
.wb-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.wb-row.is-selected {
	border-color: var(--dsw-alias-brand-primary, #007fd4);
	background: var(--dsw-alias-interactive-bg-active, rgba(0,127,212,.10));
}
.wb-row.is-warn { border-left: 2px solid var(--dsw-alias-state-warn-primary, #e0a43a); }
.wb-row.is-active { border-left: 2px solid var(--dsw-alias-state-success-primary, #3fb950); }
.wb-row.is-cold { opacity: .72; }
.wb-row-l1 { display: flex; align-items: center; gap: var(--wb-s1); min-width: 0; }
.wb-row-l2 { display: flex; align-items: center; gap: var(--wb-s2); min-width: 0; margin-top: 2px; font-size: var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.wb-row-name { font-size: var(--wb-f-md); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-row-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wb-code { font-family: var(--wb-mono); font-size: var(--wb-f-xs); color: var(--dsw-alias-label-secondary, rgba(230,230,230,.78)); }
.wb-meta { white-space: nowrap; }
.wb-acts { display: flex; gap: var(--wb-s1); align-items: center; }
.wb-num { font-size: var(--wb-f-xs); color: var(--dsw-alias-label-secondary, rgba(230,230,230,.78)); white-space: nowrap; }
.wb-chev { font-size: var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.wb-caret { width: 11px; color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }

/* ── 4. 徽标 / 药丸 ───────────────────────────────────────────────────── */
.wb-badge {
	font-size: var(--wb-f-xs); line-height: 1.4; padding: 0 7px;
	border-radius: var(--wb-r-pill); border: 1px solid currentColor;
	font-style: normal; white-space: nowrap;
	color: var(--dsw-alias-label-secondary, rgba(230,230,230,.8));
}
.wb-badge.is-ok { color: var(--dsw-alias-state-success-primary, #3fb950); }
.wb-badge.is-warn { color: var(--dsw-alias-state-warn-primary, #e0a43a); }
.wb-badge.is-error { color: var(--dsw-alias-state-error-primary, #f48771); }
.wb-badge.is-brand { color: var(--dsw-alias-brand-primary, #007fd4); }

/* ── 5. 按钮 / 输入 / 选择 ─────────────────────────────────────────────── */
.wb-btn {
	padding: 3px 11px; border-radius: var(--wb-r-pill);
	font-size: var(--wb-f-xs); font-family: inherit; cursor: pointer;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
	background: transparent; color: inherit;
}
.wb-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.wb-btn.is-primary {
	background: var(--dsw-alias-button-primary-fill, #007fd4);
	border-color: transparent; color: var(--dsw-alias-label-primary-inverted, #fff);
}
.wb-btn.is-primary:hover { background: var(--dsw-alias-button-primary-hover, #1b8ee0); }
.wb-btn.is-danger { color: var(--dsw-alias-state-error-primary, #f48771); border-color: currentColor; }
.wb-btn.is-ghost { border-color: transparent; padding: 2px 8px; }
.wb-btn:disabled { opacity: .5; cursor: default; }
.wb-btn.is-icon { padding: 2px 6px; line-height: 1.2; }
.wb-chip {
	padding: 2px 10px; border-radius: var(--wb-r-pill); cursor: pointer;
	font-size: var(--wb-f-xs); font-family: inherit;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
	background: transparent; color: inherit;
}
.wb-chip.is-active { border-color: var(--dsw-alias-brand-primary, #007fd4); color: var(--dsw-alias-brand-text, #4c9aff); }
.wb-chips { display: flex; gap: var(--wb-s1); flex-wrap: wrap; }
.wb-field-row { display: flex; gap: var(--wb-s1); align-items: center; flex-wrap: wrap; }
.wb-input, .wb-select {
	padding: 3px 8px; border-radius: var(--wb-r-sm);
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
	background: var(--dsw-alias-bg-layer-1, transparent);
	color: inherit; font: inherit; font-size: var(--wb-f-xs); min-width: 0;
}
.wb-input:focus, .wb-select:focus { outline: 1px solid var(--dsw-alias-brand-primary, #007fd4); outline-offset: 0; }

/* ── 6. 卡片 / 统计 ───────────────────────────────────────────────────── */
.wb-cards { display: flex; gap: var(--wb-s2); flex-wrap: wrap; }
.wb-card {
	flex: 1 1 150px; min-width: 140px;
	border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
	border-radius: var(--wb-r-md);
	padding: var(--wb-s2) var(--wb-s3);
	background: var(--dsw-alias-bg-layer-1, transparent);
}
.wb-card-num { font-size: var(--wb-f-lg); font-weight: 600; line-height: 1.2; }
.wb-card-label { font-size: var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.68)); }
.wb-card-sub { font-size: var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.55)); }
.wb-card-ico { font-size: var(--wb-f-md); color: var(--dsw-alias-label-secondary, rgba(230,230,230,.8)); }
.wb-card.is-accent { border-color: var(--dsw-alias-brand-primary, #4c9aff); }
.wb-card.is-ok { border-color: var(--dsw-alias-state-success-primary, #3fb950); }
.wb-card.is-warn { border-color: var(--dsw-alias-state-warn-primary, #e0a43a); }
.wb-card.is-error { border-color: var(--dsw-alias-state-error-primary, #f48771); }

/* ── 7. 表格 ─────────────────────────────────────────────────────────── */
.wb-table { border-collapse: collapse; width: 100%; font-size: var(--wb-f-xs); }
.wb-table th, .wb-table td {
	text-align: left; padding: 3px var(--wb-s2);
	border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14));
}
.wb-table th { color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); font-weight: 600; }
.wb-table td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }

/* ── 8. 页签 ─────────────────────────────────────────────────────────── */
.wb-tabs {
	display: flex; align-items: center; gap: var(--wb-s1); flex-wrap: wrap;
	border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
	padding-bottom: var(--wb-s1);
}
.wb-tab {
	padding: 3px 12px; border-radius: var(--wb-r-pill); cursor: pointer;
	font-size: var(--wb-f-sm); font-family: inherit;
	border: 1px solid transparent; background: transparent;
	color: var(--dsw-alias-label-secondary, rgba(230,230,230,.75));
}
.wb-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.wb-tab.is-active {
	border-color: var(--dsw-alias-brand-primary, #007fd4);
	color: var(--dsw-alias-label-primary, inherit); font-weight: 600;
}

/* ── 9. 画布 / 预格式 / 空态 / 诊断 ──────────────────────────────────── */
.wb-canvas-wrap { display: flex; flex-direction: column; gap: var(--wb-s1); min-width: 0; }
.wb-canvas { overflow: auto; min-width: 0; }
.wb-canvas svg { max-width: 100%; height: auto; }
.wb-pre {
	margin: 0; padding: var(--wb-s2) var(--wb-s3); max-height: 360px; overflow: auto;
	border-radius: var(--wb-r-md);
	background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.1));
	font-family: var(--wb-mono); font-size: var(--wb-f-xs); line-height: 1.6;
	white-space: pre-wrap; word-break: break-word;
}
.wb-empty {
	margin: var(--wb-s2) 0; font-size: var(--wb-f-sm);
	color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.7));
}
.wb-diag { margin: 0; font-size: var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.72)); }
.wb-foot { display: flex; flex-direction: column; gap: var(--wb-s1); }
.wb-foot-body { display: flex; flex-direction: column; gap: 2px; }
.wb-group-hd { font-size: var(--wb-f-xs); font-weight: 600; display: flex; align-items: center; gap: var(--wb-s1); }
.wb-group-hd small { font-weight: 400; color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.wb-ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--wb-f-xs); }
.wb-ul li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-ul a { color: var(--dsw-alias-brand-text, currentColor); text-decoration: none; }
.wb-ul a:hover { text-decoration: underline; }
.wb-drawer {
	display: flex; flex-direction: column; gap: var(--wb-s1); min-width: 0;
}
.wb-ghost {
	position: fixed; pointer-events: none; opacity: .85; z-index: 9999;
	border-radius: var(--wb-r-md); padding: var(--wb-s2);
	background: var(--dsw-alias-bg-overlay, rgba(40,40,40,.95));
	border: 1px solid var(--dsw-alias-brand-primary, #007fd4);
	color: var(--dsw-alias-label-primary, inherit);
	font-size: var(--wb-f-xs);
}

/* ── 10. 窄容器：分栏**保持左右**（用户要求），只收窄左列 ──────────────── */
@container vss-workbench (max-width: 760px) {
	.wb-pane-left { min-width: 200px; }
	.wb-stat { display: none; }
	.wb-row { grid-template-columns: minmax(0, 1fr); }
	.wb-acts { justify-self: end; }
}
`;

const STYLE_ID = 'vssaros-wb-ui';

/**
 * 注入共享样式表（幂等）。宿主客户端在 `apply` 里调一次即可。
 * @returns 清理函数（dsh 卸载宿主时移除 <style>）
 */
function installWorkbenchUi() {
	if (typeof document === 'undefined') { return undefined; }
	if (document.getElementById(STYLE_ID)) { return undefined; }
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = WORKBENCH_UI_CSS;
	document.head.appendChild(el);
	return () => { el.remove(); };
}

/** 共享层是否已注入（探针/自诊断用）。 */
function isWorkbenchUiInstalled() {
	return typeof document !== 'undefined' && !!document.getElementById(STYLE_ID);
}

		exports.CSS = WORKBENCH_UI_CSS;
		exports.install = installWorkbenchUi;
		exports.isInstalled = isWorkbenchUiInstalled;
		return module.exports;
	},
});
