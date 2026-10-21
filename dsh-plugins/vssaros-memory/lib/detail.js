// @vssaros/dsh-memory — 「记忆详情」页（dsh 侧复刻 IDE 的 `MemoryDetailEditorPane`）。
//
// ## 为什么要它
// IDE 侧有一块「记忆详情」面板（`src/vs/sessions/contrib/agentStudio/browser/memoryDetailEditorPane.ts`
// = 10 个页签 + 统计 + 工具栏 + 两组筛选 + 搜索 + 列表），而 dsh 侧**没有** ⇒ 本插件那张入口卡
// （`lib/index.js` 的 `.kb-entry`）只能改成"跳到本页底部的注入正文" ✗，注释里也写明"本页没有
// 那个编辑器" ✗。本文件把那块面板按 dsh 的规矩复刻一份 ⇒ 那张卡终于能变成**真入口** ✓。
//
// ## 三条硬约束（都是本仓既有口径，别改回去 ✗）
// ① **零脚本**（`lib/pageShell.js` 的口径）：页签 / 筛选 / 切分区一律 `<a href="?…">`，搜索用
//    `<form method="get">`，展开用 `<details>` ⇒ **不需要 client chunk** ✓（`index.js` 顶部写明：
//    为了一个按钮引入 client chunk 会把"页面脚本能不能被当字符串 eval"那套契约一起拖进来 ✗）。
// ② **只读**：本页只调只读方法。IDE 侧卡片上的 `✏`(编辑) / `🗑`(删除) 需要 `updateMemory` /
//    `deleteMemory` ⇒ 属**写** ⇒ **本页不做** ✗（写入口是网关 + 审批闸 ✓，见 `index.js` 文件头）。
//    工具栏的 `Flush` 同理不做 ✓ —— 但**如实标注**，不静默少一个 ✗。
// ③ **模板字符串里不出现反引号**（本仓踩过五次 ✗）—— 本文件所有 HTML 都在模板字符串里 ✓。
//
// ## 与 IDE 侧的对齐口径
// · 样式**逐条移植** `memoryDetailEditorPane._injectStyles()`（181-295 行），类名保留 `md-` ✓，
//   只把"点击切换"换成"链接跳转"（零脚本 ✓）；主题变量同为 `--vscode-*`（`pageShell.js:12-13` ✓）。
// · 页签顺序 / 标签 / emoji 照抄 `_renderViewNav()`（448-471 行）✓。
// · 统计第 1、2 行是**前端本地聚合**（IDE 侧 `_countByTier` 同款 ✓）；第 3 行取 `getExtendedStats`
//   的**前 8 个 key**（IDE 侧 650 行 ✓）—— key **不硬编码** ✓（引擎改 key 本页不会失真 ✓）。
// · IDE 侧「搜索历史」按钮其实只是把扩展统计铺成弹层（名字骗人 ✓）⇒ 本页并进统计/诊断，不单列 ✗。

import { escapeHtml } from './pageShell.js';

/** 本页路由（**子路由**：不需改 `DSH_MODULE_PAGES` / 插件清单的 `vssaros.view` ✓）。 */
export const DETAIL_ROUTE = '/x/memory/detail';

/** 列表一次最多渲染多少条（IDE 侧 `PAGE_SIZE = 200` ✓；本页服务端渲染，取小一点更快 ✓）。 */
export const DETAIL_PAGE_SIZE = 50;

/** 10 个页签（顺序 / 标签 / emoji **照抄** `memoryDetailEditorPane.ts:448-471` ✓）。 */
export const DETAIL_VIEWS = [
	{ id: 'memories', label: '🧠 记忆', impl: true },
	{ id: 'sessions', label: '💬 会话', impl: true },
	{ id: 'slots', label: '📌 槽位', impl: true },
	{ id: 'lessons', label: '📖 教训', impl: true },
	{ id: 'consolidation', label: '🔄 固化', impl: true },
	{ id: 'audit', label: '📋 审计', impl: true },
	{ id: 'hooks', label: '🪝 钩子', impl: true },
	{ id: 'commits', label: '🔀 提交', impl: true },
	{ id: 'report', label: '📊 报告', impl: true },
	{ id: 'skills', label: '⚡ 技能', impl: true },
];

/** 分层筛选（照抄 604-609 行 ✓）。 */
const LAYERS = [
	{ id: 'all', label: '全部' },
	{ id: 'working', label: 'Working' },
	{ id: 'episodic', label: 'Episodic' },
	{ id: 'semantic', label: 'Semantic' },
	{ id: 'procedural', label: 'Procedural' },
];

/** Episodic 子类型筛选（照抄 617-622 行 ✓）。 */
const TYPES = [
	{ id: 'pattern', label: 'Pattern' },
	{ id: 'fact', label: 'Fact' },
	{ id: 'preference', label: 'Preference' },
	{ id: 'architecture', label: 'Architecture' },
	{ id: 'bug', label: 'Bug' },
	{ id: 'workflow', label: 'Workflow' },
];

/** 分层 → 徽标配色类（照抄 IDE 侧 `typeClasses` 的口径 ✓）。 */
const TIER_CLASS = { working: 'l0', episodic: 'l1', semantic: 'l2', procedural: 'l3' };

/** 本页认的参数（其余一律丢 ✓ —— 不原样回显别人的参数 ✗）。 */
// ★ 2026-10-21：加 `partition` —— 会话跨分区合并后，**同名 session id 可能出现多次**
//   （不同分区各有一个 `x1`）⇒ 只用 `?session=` 选中会**同时展开两条**（歧义 ✗）
//   ⇒ 选择必须带分区（`?session=<id>&partition=<分区>`）。
const KEPT_PARAMS = ['view', 'layer', 'type', 'q', 'agent', 'tool', 'sfilter', 'rtype', 'session', 'partition'];

/**
 * 页面样式：**逐条移植** `memoryDetailEditorPane.ts:184-293` ✓。
 *
 * 三处**有意**的换算（都是 dsh 侧既有口径，不是偷懒 ✓）：
 * ① 增补 `var(--vscode-x, 回退)` 的**回退值** —— `pageShell.js:12-13` 要求"变量缺失时也不至于
 *    不可读" ✓（IDE 侧在编辑器里跑、变量必然存在 ⇒ 它不需要回退；本页可能在宿主 iframe 里 ⇒ 需要 ✓）。
 * ② 展开态从"点击加 `.expanded` 类 + max-height 过渡"换成 **`<details>/<summary>`** ✓：零脚本下
 *    没有 JS 能切类 ⇒ 用原生元素 ✓，并把 `summary` 的默认三角 marker 隐掉 ✓。
 * ③ `.md-diag-panel` / `.md-overlay` 两个**浮层**样式**不要** ✗：浮层要有"关闭"交互，零脚本做不出
 *    ⇒ 本页把"诊断"改成**同一页的另一个 query**（`?tool=diag`）✓。
 */
export const DETAIL_CSS = `
	.memory-detail-container { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
	/* View navigation（标签换成 <a>：零脚本 ✓） */
	.md-view-nav { display: flex; gap: 2px; padding: 6px 20px 0; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); flex-shrink: 0; background: var(--vscode-editorWidget-background, #252526); flex-wrap: wrap; }
	.md-view-tab { padding: 6px 14px; cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground, #999); border: 1px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0; transition: all .15s; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
	.md-view-tab:hover { color: var(--vscode-foreground, #ccc); background: var(--vscode-list-hoverBackground, rgba(128,128,128,.06)); }
	.md-view-tab.active { color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); border-color: var(--vscode-widget-border, rgba(128,128,128,.35)); border-bottom-color: var(--vscode-editor-background, #1e1e1e); margin-bottom: -1px; }
	/* Header */
	.md-header { padding: 16px 20px 8px; flex-shrink: 0; }
	.md-header-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
	.md-header h1 { font-size: 16px; font-weight: 600; color: var(--vscode-foreground, #ccc); margin: 0; }
	.md-stats { display: flex; gap: 10px; flex-wrap: wrap; }
	.md-stats.types { margin-top: 6px; }
	.md-stat { background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); border-radius: 6px; padding: 6px 14px; cursor: help; }
	.md-stat .label { font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
	.md-stat .value { font-size: 16px; font-weight: 600; color: var(--vscode-foreground, #ccc); }
	.md-stat.l0 .value { color: #569cd6; } .md-stat.l1 .value { color: #4ec9b0; }
	.md-stat.l2 .value { color: #b799ff; } .md-stat.l3 .value { color: #f0a04b; }
	.md-stats-sep { font-size: 11px; color: var(--vscode-descriptionForeground, #999); align-self: center; }
	/* Action toolbar */
	.md-toolbar { display: flex; gap: 6px; padding: 6px 20px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); flex-shrink: 0; flex-wrap: wrap; }
	.md-btn { padding: 4px 12px; border-radius: 4px; font-size: 11px; cursor: pointer; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); background: var(--vscode-editorWidget-background, #252526); color: var(--vscode-descriptionForeground, #999); transition: all .15s; display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
	.md-btn:hover { color: var(--vscode-foreground, #ccc); border-color: var(--vscode-focusBorder, #3794ff); background: var(--vscode-list-hoverBackground, rgba(128,128,128,.06)); }
	.md-btn.primary { background: var(--vscode-focusBorder, #3794ff); color: #fff; border-color: var(--vscode-focusBorder, #3794ff); }
	.md-btn.primary:hover { opacity: .9; }
	.md-btn.disabled { opacity: .45; cursor: not-allowed; }
	/* Layer tabs（同样换成 <a> ✓） */
	.md-layer-tabs { display: flex; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); padding: 0 20px; flex-shrink: 0; flex-wrap: wrap; }
	.md-layer-tab { padding: 8px 16px; cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground, #999); border-bottom: 2px solid transparent; transition: all .15s; display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
	.md-layer-tab:hover { color: var(--vscode-foreground, #ccc); }
	.md-layer-tab.active { color: var(--vscode-foreground, #ccc); border-bottom-color: var(--vscode-focusBorder, #3794ff); }
	.md-layer-tab .count { background: var(--vscode-badge-background, rgba(128,128,128,.2)); font-size: 10px; padding: 1px 6px; border-radius: 8px; color: var(--vscode-badge-foreground, #888); }
	.md-layer-tabs.md-type-tabs { background: var(--vscode-sideBar-background, rgba(128,128,128,.04)); }
	.md-layer-tabs.md-type-tabs .md-layer-tab { padding: 5px 14px; font-size: 11px; opacity: .85; }
	.md-type-tabs-label { font-size: 10px; color: var(--vscode-descriptionForeground, #999); display: flex; align-items: center; padding: 5px 8px; border-right: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); margin-right: 4px; }
	/* Filter bar */
	.md-filter-bar { display: flex; align-items: center; gap: 8px; padding: 8px 20px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); flex-shrink: 0; flex-wrap: wrap; margin: 0; }
	.md-filter-label { font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
	.md-search { margin-left: auto; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 4px; padding: 4px 10px; color: var(--vscode-input-foreground, #ccc); font-size: 12px; width: 200px; outline: none; }
	.md-select { background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 4px; padding: 4px 8px; color: var(--vscode-input-foreground, #ccc); font-size: 12px; }
	/* Memory list */
	.md-list { flex: 1; overflow-y: auto; padding: 12px 20px; }
	/* Memory card（<details>：零脚本下的"展开"原语 ✓） */
	.md-card { background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
	.md-card > summary.md-card-header { list-style: none; }
	.md-card > summary.md-card-header::-webkit-details-marker { display: none; }
	.md-card-header { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid rgba(128,128,128,.06); cursor: pointer; }
	.md-card-header:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.06)); }
	.md-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; flex-shrink: 0; }
	.md-badge.l0 { background: rgba(86,156,214,.1); color: #569cd6; }
	.md-badge.l1 { background: rgba(78,201,176,.15); color: #4ec9b0; }
	.md-badge.l2 { background: rgba(183,153,255,.15); color: #b799ff; }
	.md-badge.l3 { background: rgba(240,160,75,.15); color: #f0a04b; }
	.md-badge.superseded { background: rgba(244,63,94,.12); color: #f43f5e; text-decoration: line-through; }
	.md-card-strength { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 8px; flex-shrink: 0; }
	.md-card-strength.high { background: rgba(93,202,165,.15); color: #5dcaa5; }
	.md-card-strength.mid { background: rgba(240,160,75,.15); color: #f0a04b; }
	.md-card-strength.low { background: rgba(244,63,94,.12); color: #f43f5e; }
	.md-card-title { font-size: 12px; color: var(--vscode-foreground, #ccc); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.md-card-time { font-size: 10px; color: var(--vscode-descriptionForeground, #999); flex-shrink: 0; }
	.md-expand { color: var(--vscode-descriptionForeground, #999); font-size: 10px; flex-shrink: 0; transition: transform .2s; }
	.md-card[open] .md-expand { transform: rotate(90deg); }
	.md-content { padding: 12px 14px; max-height: 440px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: var(--vscode-foreground, #ccc); }
	.md-content pre { background: rgba(0,0,0,.3); padding: 8px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, ui-monospace), monospace; font-size: 12px; }
	/* ⚠ 这两条是**补移植**：IDE 侧 _injectStyles 261 行有 blockquote，我第一版漏了 ✗（教训页的
	   "上下文"就靠它）；.md-audit-json 对应 IDE 侧 1084-1085 行那句内联的等宽 11px ✓
	   ⚠⚠ 本段在**模板字符串内** ⇒ 注释里绝不能出现反引号。同一条我在这轮踩了**三次**（HTML 注释、
	   CSS 注释、以及"修改注释时又引入"）⇒ 已把规则收紧为：**detail.js 里一律不用反引号** ✓ */
	.md-content blockquote { border-left: 3px solid var(--vscode-focusBorder, #3794ff); padding-left: 10px; margin: 6px 0; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
	.md-audit-json { font-size: 11px; }
	/* ⚡ 技能页（逐条照 IDE 侧 1400-1628 行的内联样式 ✓；都在模板字符串内 ⇒ 无反引号 ✓） */
	.md-banner { margin: 0 20px 8px; padding: 8px 12px; background: rgba(86,156,214,.08); border: 1px solid rgba(86,156,214,.2); border-radius: 6px; font-size: 11px; color: #569cd6; line-height: 1.7; }
	.md-card.skill-new { border-color: rgba(78,201,176,.4); border-left: 3px solid #4ec9b0; }
	.md-skill-status { font-size: 10px; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; background: rgba(204,167,0,.12); color: #cca700; }
	.md-skill-status.ok { background: rgba(78,201,176,.12); color: #4ec9b0; }
	.md-fm { background: rgba(128,128,128,.06); padding: 8px 12px; font-family: var(--vscode-editor-font-family, ui-monospace), monospace; font-size: 11px; line-height: 1.6; border-bottom: 1px solid rgba(128,128,128,.06); }
	.md-fm-k { color: #569cd6; margin-right: 6px; }
	.md-fm-v { color: #ce9178; }
	.md-skill-body { padding: 8px 12px; }
	.md-skill-body h1 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
	.md-skill-label { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground, #999); margin: 8px 0 4px; }
	.md-skill-trigger { font-size: 12px; color: #4ec9b0; padding: 6px 10px; background: rgba(78,201,176,.08); border-radius: 4px; border-left: 3px solid #4ec9b0; }
	.md-skill-outcome { font-size: 12px; color: var(--vscode-foreground, #ccc); padding: 6px 10px; background: rgba(86,156,214,.08); border-radius: 4px; border-left: 3px solid #569cd6; }
	.md-skill-steps { padding-left: 20px; margin: 0; }
	.md-skill-steps li { font-size: 12px; line-height: 1.6; margin: 2px 0; }
	.md-meta-chip.tag { background: rgba(183,153,255,.1); color: #b799ff; }
	.md-filter-chip { padding: 3px 10px; border-radius: 12px; font-size: 11px; cursor: pointer; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); background: var(--vscode-editorWidget-background, #252526); color: var(--vscode-descriptionForeground, #999); text-decoration: none; }
	.md-filter-chip:hover { color: var(--vscode-foreground, #ccc); border-color: var(--vscode-focusBorder, #3794ff); }
	.md-filter-chip.active { background: var(--vscode-focusBorder, #3794ff); color: #fff; border-color: var(--vscode-focusBorder, #3794ff); }
	.md-skill-status, .md-skill-status.ok { white-space: nowrap; }
	/* 📊 报告页（照 IDE 侧 1301-1322 行的内联样式 ✓） */
	.md-metrics { font-family: var(--vscode-editor-font-family, ui-monospace), monospace; font-size: 11px; }
	.md-warn { border-left: 3px solid #cca75d; padding-left: 10px; margin: 6px 0; color: #cca75d; font-size: 12px; }
	/* 💬 会话页 + 🔄 固化页（照 IDE 侧 846-901 / 1001-1026 行的内联样式 ✓） */
	.md-session-link { text-decoration: none; }
	.md-session-link:hover { text-decoration: underline; }
	.md-tier-head { display: flex; align-items: center; gap: 8px; padding: 8px 4px 4px; border-bottom: 2px solid var(--vscode-widget-border, rgba(128,128,128,.35)); margin-bottom: 8px; }
	.md-pre { white-space: pre-wrap; }
	.md-dim { color: var(--vscode-descriptionForeground, #999); }
	.md-content h3 { font-size: 12px; font-weight: 600; margin: 8px 0 4px; }
	.md-content ul, .md-content ol { margin: 4px 0 4px 20px; }
	.md-content li { font-size: 12px; line-height: 1.6; margin: 2px 0; }
	/* meta chips */
	.md-meta { padding: 6px 14px; border-top: 1px solid rgba(128,128,128,.06); display: flex; flex-wrap: wrap; gap: 4px; }
	.md-meta-chip { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); color: var(--vscode-descriptionForeground, #999); }
	.md-meta-chip.priority { background: rgba(255,165,0,.12); color: #ffa500; }
	.md-meta-chip.scene { background: rgba(183,153,255,.1); color: #b799ff; }
	.md-meta-chip.role { background: rgba(78,201,176,.1); color: #4ec9b0; }
	.md-meta-chip.session { background: rgba(55,148,255,.1); color: #3794ff; }
	/* empty / note */
	.md-empty { padding: 60px 20px; text-align: center; color: var(--vscode-descriptionForeground, #999); }
	.md-note { padding: 12px 20px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; line-height: 1.8; }
	.md-note code, .md-header code { background: rgba(128,128,128,.15); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, ui-monospace), monospace; }
	.md-note ul { margin: 6px 0 6px 20px; }
	/* 诊断区块（IDE 侧是浮层；本页改成同页区块 ✓ 见文件头 ③） */
	.md-diag-section { margin-bottom: 12px; padding: 0 20px; }
	.md-diag-section h3 { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground, #999); margin-bottom: 4px; }
	.md-diag-item { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; border-bottom: 1px solid rgba(128,128,128,.06); gap: 12px; }
	.md-diag-item .key { color: var(--vscode-descriptionForeground, #999); }
	.md-diag-item .val { color: var(--vscode-foreground, #ccc); font-weight: 500; }
	.md-diag-item .val.pass { color: #5dcaa5; } .md-diag-item .val.warn { color: #cca75d; } .md-diag-item .val.fail { color: #f48771; }
`;

/** 只保留本页认的参数，并**转义**（进 `href` 前必须转 ✓）。 */
function queryString(params, patch) {
	const merged = new URLSearchParams();
	for (const k of KEPT_PARAMS) {
		const v = params?.get?.(k);
		if (v) { merged.set(k, v); }
	}
	for (const [k, v] of Object.entries(patch ?? {})) {
		if (v === undefined || v === null || v === '' || v === false) { merged.delete(k); } else { merged.set(k, v); }
	}
	return escapeHtml(merged.toString());
}

/** 站内链接：保留其它维度、只覆盖给定项 ✓（否则点一次筛选会丢掉搜索词 ✗）。 */
function hrefTo(params, patch) {
	return './detail?' + queryString(params, patch);
}

/** 统计格（照抄 IDE 侧 `md-stat` 的 DOM 形状 ✓）。 */
function statCell(label, value, cls) {
	return '<div class="md-stat' + (cls ? ' ' + cls : '') + '">'
		+ '<div class="label">' + escapeHtml(label) + '</div>'
		+ '<div class="value">' + escapeHtml(value) + '</div></div>';
}

/** 页签导航（10 个 ✓）。未迁移的**仍可点**，落地后会如实标"尚未迁移" ✓（不藏 ✗）。 */
function renderViewNav(params) {
	const active = params?.get('view') ?? 'memories';
	const tabs = DETAIL_VIEWS.map(v =>
		'<a class="md-view-tab' + (v.id === active ? ' active' : '') + '" href="' + hrefTo(params, { view: v.id }) + '">'
		+ escapeHtml(v.label) + (v.impl ? '' : '<span class="count" title="dsh 侧尚未迁移">·</span>') + '</a>').join('');
	return '<nav class="md-view-nav" data-vssaros-md-views="' + DETAIL_VIEWS.length + '">' + tabs + '</nav>';
}

/**
 * 工具栏 —— IDE 侧那 6 个动作**逐个**交代 dsh 侧怎么处理 ✓。
 *
 * ⚠ 为什么不直接少放两个按钮 ✗：IDE 侧有 6 个、本页只有 4 个，用户会以为"功能缺了"而不知道
 *   是**刻意不做** ⇒ 缺的两个标灰 + tooltip 写清理由 ✓（与"如实标注"同一纪律 ✓）。
 */
function renderToolbar(params, model) {
	const refresh = '<a class="md-btn' + (model.hasGateway ? '' : ' disabled')
		+ '" href="./detail?' + queryString(params, {}) + '" title="重新请求本页（服务端重新取数）">🔄 刷新</a>';
	const flush = '<span class="md-btn disabled" title="Flush 是**写**操作（清引擎缓存）⇒ 本页只读口径不做；请在 IDE 面板或网关侧执行">💾 Flush（只读口径不做）</span>';
	const diag = '<a class="md-btn' + (model.tool === 'diag' ? ' primary' : '') + '" href="'
		+ hrefTo(params, { tool: model.tool === 'diag' ? '' : 'diag' })
		+ '" title="IDE 侧是浮层；零脚本下浮层没有关闭交互 ⇒ 本页改成同页区块">📊 诊断</a>';
	const exportJson = '<a class="md-btn" href="' + hrefTo(params, { tool: 'export-json' })
		+ '" title="服务端走 exportMemories 返回 application/json">📥 导出JSON</a>';
	const exportMd = '<a class="md-btn" href="' + hrefTo(params, { tool: 'export-md' })
		+ '" title="服务端把记忆拼成 Markdown 返回">📄 导出MD</a>';
	const history = '<span class="md-btn disabled" title="IDE 侧这个按钮只是把扩展统计铺成弹层（没有真正的搜索历史 API，名字骗人 ✓）⇒ 本页并进上方统计行与诊断区块">🔍 搜索历史（并入统计）</span>';
	return '<div class="md-toolbar">' + refresh + flush + diag + exportJson + exportMd + history + '</div>';
}

/** 第 1、2、3 行统计。 */
function renderStatRows(model) {
	const tier = model.tierCounts ?? {};
	const type = model.typeCounts ?? {};
	const row1 = [statCell('总数', model.total ?? 0), statCell('Working', tier.working ?? 0, 'l0'),
		statCell('Episodic', tier.episodic ?? 0, 'l1'), statCell('Semantic', tier.semantic ?? 0, 'l2'),
		statCell('Procedural', tier.procedural ?? 0, 'l3')].join('');
	const row2 = TYPES.map(t => statCell(t.label, type[t.id] ?? 0)).join('');
	// 第 3 行：`getExtendedStats` 的**前 8 个 key**（照 IDE 侧 650 行 ✓，key 不硬编码 ✓）
	const ext = model.extStats && typeof model.extStats === 'object' && !Array.isArray(model.extStats)
		? Object.entries(model.extStats).slice(0, 8) : [];
	const row3 = ext.map(([k, v]) => statCell(k,
		typeof v === 'number' && Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v))).join('');
	return '<div class="md-stats">' + row1 + '</div>'
		+ '<div class="md-stats types"><span class="md-stats-sep">↳ Episodic 子类型</span>' + row2 + '</div>'
		+ (row3 ? '<div class="md-stats types"><span class="md-stats-sep">↳ 扩展统计</span>' + row3 + '</div>' : '');
}

/** 分区下拉：零脚本 ⇒ `<form method="get">` + 提交按钮（`<select>` 不会自动提交 ✗）。 */
function renderAgentPicker(params, model) {
	const active = params?.get('agent') ?? '';
	const opts = ['<option value=""' + (active === '' ? ' selected' : '') + '>当前 Agent（' + escapeHtml(model.agentId) + '）</option>',
		'<option value="__all__"' + (active === '__all__' ? ' selected' : '') + '>全部 Agent</option>']
		.concat((model.agents ?? []).filter(a => a && a !== model.agentId)
			.map(a => '<option value="' + escapeHtml(a) + '"' + (active === a ? ' selected' : '') + '>' + escapeHtml(a) + '</option>')).join('');
	const hidden = ['view', 'layer', 'type', 'q', 'tool'].map(k => params?.get(k)
		? '<input type="hidden" name="' + k + '" value="' + escapeHtml(params.get(k)) + '">' : '').join('');
	return '<form class="md-filter-bar" method="get" action="./detail">' + hidden
		+ '<span class="md-filter-label">分区</span>'
		+ '<select class="md-select" name="agent">' + opts + '</select>'
		+ '<button class="md-btn" type="submit">切换</button>'
		+ '<span class="md-filter-label" style="margin-left:auto">只读 · 写入走 <code>memory_remember</code></span>'
		+ '</form>';
}

/** 两组筛选（分层 + 子类型）+ 搜索框 —— 全是 `<a>` / `<form>` ✓。 */
function renderFilters(params, model) {
	const layer = params?.get('layer') ?? 'all';
	const type = params?.get('type') ?? '';
	const tier = model.tierCounts ?? {};
	const layerTabs = LAYERS.map(l => {
		const n = l.id === 'all' ? (model.total ?? 0) : (tier[l.id] ?? 0);
		return '<a class="md-layer-tab' + (l.id === layer ? ' active' : '') + '" href="'
			+ hrefTo(params, { layer: l.id === 'all' ? '' : l.id }) + '">' + escapeHtml(l.label)
			+ '<span class="count">' + n + '</span></a>';
	}).join('');
	const typeTabs = '<span class="md-type-tabs-label">Episodic 子类型</span>' + TYPES.map(t =>
		'<a class="md-layer-tab' + (t.id === type ? ' active' : '') + '" href="'
		+ hrefTo(params, { type: t.id === type ? '' : t.id }) + '">' + escapeHtml(t.label)
		+ '<span class="count">' + (model.typeCounts?.[t.id] ?? 0) + '</span></a>').join('');
	const q = params?.get('q') ?? '';
	const search = '<form class="md-filter-bar" method="get" action="./detail">'
		+ ['view', 'layer', 'type', 'agent', 'tool'].map(k => params?.get(k)
			? '<input type="hidden" name="' + k + '" value="' + escapeHtml(params.get(k)) + '">' : '').join('')
		+ '<span class="md-filter-label">搜索内容</span>'
		+ '<input class="md-search" type="search" name="q" value="' + escapeHtml(q) + '" placeholder="🔍 搜索记忆内容...">'
		+ '<button class="md-btn" type="submit">搜索</button>'
		+ (q ? '<a class="md-btn" href="' + hrefTo(params, { q: '' }) + '">清除</a>' : '')
		+ '</form>';
	return '<div class="md-layer-tabs">' + layerTabs + '</div>'
		+ '<div class="md-layer-tabs md-type-tabs">' + typeTabs + '</div>'
		+ search;
}

/** 单条记忆卡片（`<details>` ✓）—— 字段与 IDE 侧 `_renderMemoryCards` 对齐 ✓。 */
function renderCard(item, expanded) {
	const tier = item.tier ?? 'episodic';
	const badge = '<span class="md-badge ' + (TIER_CLASS[tier] ?? 'l1') + '">' + escapeHtml(item.type ?? tier) + '</span>';
	const title = '<span class="md-card-title">' + escapeHtml(item.title ?? '') + '</span>';
	const time = item.timestamp ? '<span class="md-card-time">' + escapeHtml(item.timestamp) + '</span>' : '';
	const strength = typeof item.strength === 'number'
		? '<span class="md-card-strength ' + (item.strength > 0.5 ? 'high' : item.strength > 0.2 ? 'mid' : 'low')
			+ '" title="强度 ' + escapeHtml(item.strength.toFixed(2)) + '">' + Math.round(item.strength * 100) + '%</span>' : '';
	const chips = (item.meta ?? []).map(([k, v]) => '<span class="md-meta-chip'
		+ (k === 'sessionId' ? ' session' : k === 'priority' ? ' priority' : k === 'scene' ? ' scene' : '')
		+ '">' + escapeHtml(k + ': ' + v) + '</span>').join('');
	return '<details class="md-card" data-vssaros-md-card="' + escapeHtml(item.id ?? '') + '"' + (expanded ? ' open' : '') + '>'
		+ '<summary class="md-card-header">' + badge + title + time + strength + '<span class="md-expand">▶</span></summary>'
		+ '<div class="md-content"><pre>' + escapeHtml(item.content ?? '') + '</pre></div>'
		+ (chips ? '<div class="md-meta">' + chips + '</div>' : '')
		+ '</details>';
}

/**
 * 📌 槽位页（真源 `_renderSlotsView` 665-709 ✓）。
 *
 * 两个照抄来的要点：
 * ① **固定 8 槽位模型**：无论网关有没有返回，这 8 个槽位**都要显示**（缺的显示"(空)"）——
 *    IDE 侧 675-677 行的注释写明理由：网关没数据时若写成"暂无槽位"会**误报** ✗。
 * ② 槽位卡**默认展开**（IDE 侧 `card.classList.add('expanded')` ✓）—— 槽位内容就是这一页的主体，
 *    折起来等于让人多点一次 ✓。
 *
 * ⚠ `slotNames` 由 **model 注入**（`index.js` 的 `SLOT_NAMES` ✓）而不是本文件再抄一份：
 *    再抄一份就多了一个会漂移的真源 ✗；而 `detail.js` 也不能 import `index.js`（后者 import 前者
 *    ⇒ **循环依赖** ✗）。⇒ 注入是唯一既单一真源、又不引环的做法 ✓。
 * ⚠ IDE 侧槽位卡上的 `✏️`/`🗑️` 走 `setSlot`（**写**）⇒ 本页只读口径**不做**，但**如实标注** ✓。
 */
function renderSlotsView(params, model) {
	const slots = Array.isArray(model.slots) ? model.slots : [];
	const fixed = Array.isArray(model.slotNames) ? model.slotNames : [];
	const map = new Map();
	for (const s of slots) { map.set(String(s?.name ?? ''), String(s?.content ?? '')); }
	// 固定 8 个在前，网关多出来的追加在后（与 IDE 侧 682-685 行同序 ✓）
	const names = [...fixed, ...slots.map(s => String(s?.name ?? '')).filter(n => n && !fixed.includes(n))];
	if (names.length === 0) {
		return '<div class="md-empty">暂无固定槽位（连内置的 8 个都没有 ⇒ 引擎侧异常，不是"没有数据" ✗）。</div>';
	}
	const cards = names.map(name => {
		const content = map.get(name) ?? '';
		return '<details class="md-card" open data-vssaros-md-slot="' + escapeHtml(name) + '">'
			+ '<summary class="md-card-header"><span class="md-badge l2">' + escapeHtml(name) + '</span>'
			+ '<span class="md-card-title">' + escapeHtml(content.slice(0, 80) || '(空)') + '</span>'
			+ '<span class="md-expand">▶</span></summary>'
			+ '<div class="md-content"><pre>' + escapeHtml(content || '(空)') + '</pre></div>'
			+ '</details>';
	}).join('');
	const note = '<div class="md-note">槽位卡的 <b>编辑 / 删除</b>在 IDE 侧走 <code>setSlot</code>'
		+ '（<b>写</b>操作）⇒ 本页只读口径不做 ✗（写入口是网关 + 审批闸 ✓）。'
		+ '空的槽位是**引擎的正常状态**（首次调用会补 8 个空缺省项 ✓）⇒ 别当成故障 ✗。</div>';
	return '<div class="md-toolbar"><a class="md-btn" href="./detail?' + queryString(params, {}) + '">🔄 刷新</a>'
		+ '<span class="md-btn disabled" title="新增槽位是写操作 ⇒ 只读口径不做">➕ 新增槽位（只读口径不做）</span></div>'
		+ '<div class="md-list">' + cards + '</div>' + note;
}

/**
 * 📖 教训页（真源 `_renderLessonsView` 733-776 ✓）。
 *
 * 照抄要点：徽标固定是 `lesson`（类别不看数据 ✓）、tags 显示在**时间位**（`md-card-time` ✓）、
 * 卡**默认展开**，且展开区里除了正文还有一个 `blockquote` 放 **context**（"当时什么情况下学到的" ✓）。
 */
function renderLessonsView(params, model) {
	const lessons = Array.isArray(model.lessons) ? model.lessons : [];
	const cards = lessons.map((lesson, i) => {
		const content = String(lesson?.content ?? '');
		const tags = Array.isArray(lesson?.tags) ? lesson.tags.filter(Boolean) : [];
		return '<details class="md-card" open data-vssaros-md-lesson="' + escapeHtml(String(lesson?.id ?? i)) + '">'
			+ '<summary class="md-card-header"><span class="md-badge l3">lesson</span>'
			+ '<span class="md-card-title">' + escapeHtml(content.slice(0, 80)) + '</span>'
			+ (tags.length ? '<span class="md-card-time">' + escapeHtml(tags.join(', ')) + '</span>' : '')
			+ '<span class="md-expand">▶</span></summary>'
			+ '<div class="md-content"><pre>' + escapeHtml(content) + '</pre>'
			+ (lesson?.context ? '<blockquote>上下文: ' + escapeHtml(String(lesson.context)) + '</blockquote>' : '')
			+ '</div></details>';
	}).join('');
	const note = '<div class="md-note">教训卡的 <b>删除 / 新增</b>在 IDE 侧走 <code>deleteLesson</code> / '
		+ '<code>addLesson</code>（<b>写</b>）⇒ 本页只读口径不做 ✗。⚠ 这里**空**多半是正常状态 —— '
		+ '教训是引擎从错误里沉淀出来的，新分区刚开始就是空的 ✓（别当成坏掉 ✗）。</div>';
	return '<div class="md-toolbar"><a class="md-btn" href="./detail?' + queryString(params, {}) + '">🔄 刷新</a>'
		+ '<span class="md-btn disabled" title="新增教训是写操作 ⇒ 只读口径不做">➕ 新增教训（只读口径不做）</span></div>'
		+ '<div class="md-list">' + (cards || '<div class="md-empty">暂无教训记录（引擎还没沉淀出教训 ✓）。</div>') + '</div>' + note;
}

/**
 * 📋 审计页（真源 `_renderAuditView` 1034-1088 ✓）。
 *
 * 照抄要点：① 顶部把 `getAuditSummary` 的键值**铺成一排统计格**（复用 `.md-stats` ✓）；
 * ② 每条日志一张**默认展开**的卡，正文是 **`JSON.stringify(entry, null, 2)`**（等宽 + 11px ✓）；
 * ③ 操作徽标按 `operation` 上色：`write ⇒ l1` / `delete ⇒ l3` / 其它 `l0`（1075 行 ✓）。
 *
 * ⚠ `getAuditLog` **刻意不在** `MEMORY_API_READONLY` 里（它的首参不是 agentId ⇒ 硬塞进"自动前置
 *   agentId"的 `memory_api` 会传错参数 ✗，见 `index.js:982` 那段注释）⇒ 本页**直调** ✓
 *   （页面 ≠ 给模型的工具，白名单的边界只管后者 ✓）。
 */
function renderAuditView(params, model) {
	const summary = model.auditSummary && typeof model.auditSummary === 'object' ? Object.entries(model.auditSummary) : [];
	const statRow = summary.length
		? '<div class="md-stats" style="padding:8px 20px">'
			+ summary.map(([k, v]) => statCell(k, typeof v === 'object' ? JSON.stringify(v) : String(v))).join('') + '</div>'
		: '';
	const log = Array.isArray(model.auditLog) ? model.auditLog : [];
	const cards = log.map((entry, i) => {
		const op = String(entry?.operation ?? 'unknown');
		const cls = op === 'write' ? 'l1' : op === 'delete' ? 'l3' : 'l0';
		const title = String(entry?.agentId ?? '') + (entry?.type ? ' · ' + String(entry.type) : '');
		const ts = entry?.timestamp ? (() => {
			const d = new Date(entry.timestamp);
			return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
		})() : '';
		return '<details class="md-card" open data-vssaros-md-audit="' + i + '">'
			+ '<summary class="md-card-header"><span class="md-badge ' + cls + '">' + escapeHtml(op) + '</span>'
			+ '<span class="md-card-title">' + escapeHtml(title) + '</span>'
			+ (ts ? '<span class="md-card-time">' + escapeHtml(ts) + '</span>' : '')
			+ '<span class="md-expand">▶</span></summary>'
			+ '<div class="md-content"><pre class="md-audit-json">'
			+ escapeHtml(JSON.stringify(entry, null, 2)) + '</pre></div></details>';
	}).join('');
	return statRow
		+ '<div class="md-toolbar"><a class="md-btn" href="./detail?' + queryString(params, {}) + '">🔄 刷新</a>'
		+ '<span class="md-filter-label">只读 · 审计日志由网关侧记录</span></div>'
		+ '<div class="md-list">' + (cards || '<div class="md-empty">暂无审计日志</div>') + '</div>'
		+ '<div class="md-note">⚠ 这一页的 <code>getAuditSummary</code> / <code>getAuditLog</code> 是**页面直调**的 ✓'
		+ '（`getAuditLog` 刻意不在工具白名单里 —— 它的首参不是 agentId ⇒ 塞进 `memory_api` 会传错参数 ✗）。</div>';
}

/** 技能卡片里"待写入"高亮用的阈值（照 IDE 侧 1492 行 ✓）。 */
const SKILL_NEW_CONFIDENCE = 0.8;

/** 技能置信度配色（照 IDE 侧 1510-1512 行的 high/mid/low 分档 ✓）。 */
function confidenceClass(c) {
	return c >= 0.7 ? 'high' : c >= 0.5 ? 'mid' : 'low';
}

/**
 * ⚡ 技能页（真源 `_renderSkillsView` 1335-1488 + `_renderSkillCard` 1490-1630 ✓）。
 *
 * ## 照抄要点
 * ① 副标题固定写"从会话历史自动提取的可复用程序化技能 · 沉淀为标准 SKILL.md 格式 · 写入
 *    ~/.vssaros/skills/"（1344 行 ✓）；② 顶部 4 个统计格来自 `getSkillStats`（总技能 / 平均置信度 /
 *    总使用次数 / **已生成 SKILL.md = writtenCount/totalSkills** ✓）；③ 一条蓝色 banner（1408 行 ✓）；
 * ④ 状态筛选（全部 / 已写入 / 待写入）+ 搜索 —— ⚠ 搜索**搜三个字段**（`title` / `trigger` / `tags` ✓，
 *    比记忆页只搜 `content` 宽 ✓）；⑤ 卡片：`confidence ≥ 0.8 且未写入` ⇒ 左边框 3px 绿高亮 + 徽标
 *    变 `⚡ NEW`（l1），否则 `⚡ 技能`（l3）✓；⑥ 展开区是 **SKILL.md 预览**：frontmatter 三行
 *    （name / description = `trigger。expectedOutcome` / version 1.0.0 ✓，等宽 11px、label 蓝 value 橙 ✓）
 *    + 正文（h1 标题 / **触发条件**绿框 / **执行步骤** `<ol>` / **预期结果**蓝框 ✓）+ tags 与来源 chips ✓。
 *
 * ## ⚠ dsh 侧**刻意不做**的三类（全部如实标注，不静默少 ✗）
 * ① **usage 统计**：IDE 侧直读 `~/.vssaros/skills/<name>/.usage.json`（1353-1379 行 ✓）拿
 *    "read_skill 调用 / Skill 修改次数 / 近30天活跃 / 已钉选"—— 本页**不读用户目录** ✗
 *    （只读口径 + 单写者；而且那是宿主文件系统，与"数据只从网关来"的边界不符 ✓）。
 * ② **三个写动作**：`➕ 手动新增`（`addSkill`）/ `📁 生成全部 SKILL.md`（`writeAllSkillFiles`）/ 卡上的
 *    编辑删除 ⇒ 全走**写**方法 ⇒ 不做 ✓（写入口是网关 + 审批闸 ✓）。
 * ③ **`⬇ 导出 JSON`** 保留 ✓ 但改成服务端（`?tool=export-skills`）—— 零脚本下前端做不了下载 ✓。
 */
function renderSkillsView(params, model) {
	const skills = Array.isArray(model.skills) ? model.skills : [];
	const stats = model.skillStats && typeof model.skillStats === 'object' ? model.skillStats : {};
	const filter = params.get('sfilter') ?? 'all';
	const q = (params.get('q') ?? '').toLowerCase().trim();

	const statRow = Object.keys(stats).length
		? '<div class="md-stats">'
			+ statCell('总技能', stats.totalSkills ?? 0, 'l3')
			+ statCell('平均置信度', typeof stats.avgConfidence === 'number' ? stats.avgConfidence.toFixed(2) : String(stats.avgConfidence ?? '—'))
			+ statCell('总使用次数', stats.totalUsage ?? 0)
			+ statCell('已生成 SKILL.md', String(stats.writtenCount ?? 0) + '/' + String(stats.totalSkills ?? 0))
			+ '</div>'
		: '';
	const banner = '<div class="md-banner">💡 技能提取后会生成 SKILL.md 到 ~/.vssaros/skills/&lt;技能名&gt;/SKILL.md '
		+ '（在 IDE 侧面板或网关侧执行 ✓ —— 本页只读 ✗）。'
		+ '⚠ 本页**没有** usage 统计（read_skill 调用 / 近30天活跃 / 已钉选）—— 那几项在 IDE 侧是直读 '
		+ '~/.vssaros/skills/*/.usage.json 得到的，本页不读用户目录 ✗。</div>';

	// 状态筛选（三个 chip，都是链接 ⇒ 零脚本 ✓）+ 搜索（保留 sfilter ✓）
	const chip = (id, label, n) => '<a class="md-filter-chip' + (filter === id ? ' active' : '')
		+ '" href="' + hrefTo(params, { sfilter: id === 'all' ? '' : id }) + '">' + label + '（' + n + '）</a>';
	const written = skills.filter(s => s.skillMdWritten).length;
	const filters = '<div class="md-filter-bar"><span class="md-filter-label">状态:</span>'
		+ chip('all', '全部', skills.length) + chip('written', '已写入', written)
		+ chip('pending', '待写入', skills.length - written) + '</div>';
	const search = '<form class="md-filter-bar" method="get" action="./detail">'
		+ ['view', 'agent', 'tool', 'sfilter'].map(k => params.get(k)
			? '<input type="hidden" name="' + k + '" value="' + escapeHtml(params.get(k)) + '">' : '').join('')
		+ '<span class="md-filter-label">搜索技能（搜 title / trigger / tags 三处 ✓）</span>'
		+ '<input class="md-search" type="search" name="q" value="' + escapeHtml(params.get('q') ?? '') + '" placeholder="🔍 搜索技能...">'
		+ '<button class="md-btn" type="submit">搜索</button>'
		+ (q ? '<a class="md-btn" href="' + hrefTo(params, { q: '' }) + '">清除</a>' : '')
		+ '</form>';

	// 筛选：状态 + 搜索**三字段**（照 IDE 侧 1450-1460 行 ✓）
	let shown = skills;
	if (filter === 'written') { shown = shown.filter(s => s.skillMdWritten); }
	if (filter === 'pending') { shown = shown.filter(s => !s.skillMdWritten); }
	if (q) {
		shown = shown.filter(s => String(s.title ?? '').toLowerCase().includes(q)
			|| String(s.trigger ?? '').toLowerCase().includes(q)
			|| (s.tags ?? []).some(t => String(t).toLowerCase().includes(q)));
	}
	const cards = shown.map((s, i) => renderSkillCard(s, i)).join('');

	return statRow + banner
		+ '<div class="md-toolbar"><a class="md-btn" href="./detail?' + queryString(params, {}) + '">🔄 刷新</a>'
		+ '<a class="md-btn" href="' + hrefTo(params, { tool: 'export-skills' }) + '" title="服务端分派（零脚本下前端做不了下载 ✓）">⬇ 导出 JSON</a>'
		+ '<span class="md-btn disabled" title="新增技能是写操作（addSkill）⇒ 只读口径不做">➕ 手动新增（只读口径不做）</span>'
		+ '<span class="md-btn disabled" title="生成 SKILL.md 是写操作（writeAllSkillFiles）⇒ 只读口径不做；请在 IDE 面板执行">📁 生成全部 SKILL.md（只读口径不做）</span>'
		+ '</div>'
		+ filters + search
		+ '<div class="md-list">'
		+ (cards || '<div class="md-empty">' + (skills.length ? '无匹配技能（换个筛选或清掉搜索词 ✓）' : '暂无技能记录。技能会在会话完成并执行固化后自动提取 ✓。') + '</div>')
		+ '</div>';
}

/** 单张技能卡（真源 `_renderSkillCard` 1490-1630 ✓）。 */
function renderSkillCard(skill, index) {
	const conf = typeof skill?.confidence === 'number' ? skill.confidence : 0;
	const isNew = conf >= SKILL_NEW_CONFIDENCE && !skill?.skillMdWritten;
	const cls = confidenceClass(conf);
	const steps = Array.isArray(skill?.steps) ? skill.steps : [];
	const tags = Array.isArray(skill?.tags) ? skill.tags : [];
	const created = skill?.createdAt ? (() => {
		const d = new Date(skill.createdAt);
		return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
	})() : '';
	const frontmatter = '<div class="md-fm">'
		+ '<div><span class="md-fm-k">name</span><span class="md-fm-v">' + escapeHtml(skill?.slug || '—') + '</span></div>'
		+ '<div><span class="md-fm-k">description</span><span class="md-fm-v">'
		+ escapeHtml(String(skill?.trigger ?? '') + '。' + String(skill?.expectedOutcome ?? '')) + '</span></div>'
		+ '<div><span class="md-fm-k">version</span><span class="md-fm-v">1.0.0</span></div>'
		+ '</div>';
	const body = '<div class="md-skill-body">'
		+ '<h1>' + escapeHtml(String(skill?.title ?? '')) + '</h1>'
		+ '<div class="md-skill-label">触发条件</div>'
		+ '<div class="md-skill-trigger">' + escapeHtml(String(skill?.trigger ?? '')) + '</div>'
		+ '<div class="md-skill-label">执行步骤</div>'
		+ '<ol class="md-skill-steps">' + steps.map(s => '<li>' + escapeHtml(String(s)) + '</li>').join('') + '</ol>'
		+ '<div class="md-skill-label">预期结果</div>'
		+ '<div class="md-skill-outcome">' + escapeHtml(String(skill?.expectedOutcome ?? '')) + '</div>'
		+ '</div>';
	const metaChips = tags.map(t => '<span class="md-meta-chip tag">#' + escapeHtml(String(t)) + '</span>').join('')
		+ '<span class="md-meta-chip session">来源: ' + escapeHtml(String(skill?.sourceSessionId ?? '—').slice(0, 20)) + '</span>'
		+ (skill?.slug ? '<span class="md-meta-chip">slug: ' + escapeHtml(String(skill.slug)) + '</span>' : '');
	return '<details class="md-card' + (isNew ? ' skill-new' : '') + '" open data-vssaros-md-skill="' + escapeHtml(String(index)) + '">'
		+ '<summary class="md-card-header">'
		+ '<span class="md-badge ' + (isNew ? 'l1' : 'l3') + '">' + (isNew ? '⚡ NEW' : '⚡ 技能') + '</span>'
		+ '<span class="md-card-strength ' + cls + '">置信度 ' + conf.toFixed(2) + '</span>'
		+ '<span class="md-card-title">' + escapeHtml(String(skill?.title ?? '')) + '</span>'
		+ '<span class="md-skill-status' + (skill?.skillMdWritten ? ' ok' : '') + '">'
		+ (skill?.skillMdWritten ? '📄 SKILL.md ✓' : '⏳ 待写入') + '</span>'
		+ '<span class="md-card-time">◉ 使用 ' + Number(skill?.usageCount ?? 0) + ' 次</span>'
		+ (created ? '<span class="md-card-time">' + escapeHtml(created) + '</span>' : '')
		+ '<span class="md-expand">▶</span></summary>'
		+ '<div class="md-content">' + frontmatter + body + '</div>'
		+ '<div class="md-meta">' + metaChips + '</div>'
		+ '</details>';
}

/**
 * Hook 系统的 9 种类型（**照抄** IDE 侧 `_renderHooksView` 1117 行的字面量 ✓ —— 连**顺序**都照抄，
 * 因为这一页是"逐类型过一遍"的清单，顺序就是人的检查顺序 ✓）。
 *
 * ⚠ 这 9 个**不随数据变**：`stats.hooksByType` 里没有的类型也要显示（显示成"未注册"）✓ ——
 * 否则"某类钩子一个都没注册"这件事会被**静默藏掉** ✗（与"空数据也要给出固定 8 槽位"同一条纪律 ✓）。
 */
const HOOK_TYPES = ['session_start', 'prompt_submit', 'pre_tool_use', 'post_tool_use', 'post_tool_failure',
	'pre_compact', 'task_completed', 'stop', 'session_end'];

/** 报告类型（照抄 1222-1228 行 ✓）。 */
const REPORT_TYPES = [
	{ id: 'summary', label: '📋 摘要' },
	{ id: 'health', label: '🏥 健康' },
	{ id: 'performance', label: '⚡ 性能' },
	{ id: 'usage', label: '📈 使用' },
	{ id: 'detailed', label: '🔍 详细' },
];

/**
 * 🪝 钩子页（真源 `_renderHooksView` 1092-1135 ✓）。
 *
 * ⚠⚠ **`getHookStats()` 没有参数** —— 它的首参**不是** agentId（正因如此它被**刻意**排除在
 * `MEMORY_API_READONLY` 之外 ✗，见 `index.js` 那段注释 ⇒ 本页**页面直调** ✓，调用形状：
 * `providerCall(base, 'getHookStats', [])` ✓ —— **不能前置 agentId** ✗）。
 */
function renderHooksView(params, model) {
	const stats = model.hookStats && typeof model.hookStats === 'object' ? model.hookStats : {};
	const byType = stats.hooksByType && typeof stats.hooksByType === 'object' ? stats.hooksByType : {};
	const calls = stats.callCounts && typeof stats.callCounts === 'object' ? stats.callCounts : {};
	const registered = Object.keys(byType).length;
	const statRow = '<div class="md-stats">'
		+ statCell('已注册钩子', stats.totalHooks ?? 0)
		+ statCell('钩子类型数', registered, 'l1') + '</div>';
	const cards = HOOK_TYPES.map(ht => {
		const count = Number(byType[ht] ?? 0);
		const called = Number(calls[ht] ?? 0);
		return '<div class="md-card" data-vssaros-md-hook="' + escapeHtml(ht) + '">'
			+ '<div class="md-card-header"><span class="md-badge' + (count > 0 ? ' l1' : '') + '">'
			+ escapeHtml(ht) + '</span>'
			+ '<span class="md-card-title">' + count + ' 个处理器</span>'
			+ '<span class="md-card-time">调用 ' + called + ' 次</span>'
			+ '<span class="md-card-strength ' + (count === 0 ? 'low' : 'high') + '">'
			+ (count === 0 ? '未注册' : '活跃') + '</span></div></div>';
	}).join('');
	return statRow
		+ '<div class="md-toolbar"><a class="md-btn" href="./detail?' + queryString(params, {}) + '">🔄 刷新</a>'
		+ '<span class="md-filter-label">只读 · 钩子由引擎侧注册</span></div>'
		+ '<div class="md-list">' + cards + '</div>'
		+ '<div class="md-note">⚠ 9 种类型**不随数据裁剪** ✓：引擎里一个都没注册的类型也会列出来'
		+ '（标"未注册"）—— 否则"某类钩子完全没接上"会被静默藏掉 ✗。</div>';
}

/**
 * 🔀 提交页（真源 `_renderCommitsView` 1139-1211 ✓）。
 *
 * ⚠ 两个方法都是**页面直调**、且**首参都不是 agentId** ✗：
 * `getCommitStats()`（无参 ✓）· `getRecentCommits(50)`（首参是 **limit** ✗）⇒ 不能前置 agentId ✓。
 */
function renderCommitsView(params, model) {
	const stats = model.commitStats && typeof model.commitStats === 'object' ? model.commitStats : {};
	const commits = Array.isArray(model.commits) ? model.commits : [];
	const statRow = Object.keys(stats).length
		? '<div class="md-stats">'
			+ statCell('总提交', stats.totalCommits ?? 0)
			+ statCell('新增行', stats.totalInsertions ?? 0, 'l1')
			+ statCell('删除行', stats.totalDeletions ?? 0, 'l3')
			+ statCell('平均文件/提交', stats.avgFilesPerCommit ?? 0, 'l2') + '</div>'
		: '';
	const cards = commits.map((c, i) => {
		const md = c?.metadata && typeof c.metadata === 'object' ? c.metadata : {};
		const sha = String(md.sha ?? c?.id ?? '').slice(0, 8);
		const imp = typeof c?.importance === 'number' ? c.importance : undefined;
		const strength = imp === undefined ? ''
			: '<span class="md-card-strength ' + (imp >= 7 ? 'high' : imp >= 4 ? 'mid' : 'low') + '">P' + imp + '</span>';
		const time = c?.timestamp ? (() => {
			const d = new Date(c.timestamp);
			return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
		})() : '';
		const files = Array.isArray(md.filesChanged) ? md.filesChanged : [];
		const concepts = Array.isArray(md.concepts) ? md.concepts : [];
		const chips = (md.author ? '<span class="md-meta-chip">👤 ' + escapeHtml(String(md.author)) + '</span>' : '')
			+ (md.branch ? '<span class="md-meta-chip scene">🌿 ' + escapeHtml(String(md.branch)) + '</span>' : '')
			+ (files.length ? '<span class="md-meta-chip session">📄 ' + files.length + ' files</span>' : '')
			// ⚠ 概念只取**前 5 个**（照 1205 行的 `slice(0, 5)` ✓）—— 一条提交挂几十个概念时列表会被撑爆 ✗
			+ concepts.slice(0, 5).map(x => '<span class="md-meta-chip">#' + escapeHtml(String(x)) + '</span>').join('');
		return '<details class="md-card" open data-vssaros-md-commit="' + escapeHtml(String(i)) + '">'
			+ '<summary class="md-card-header"><span class="md-badge l1">' + escapeHtml(sha) + '</span>'
			+ '<span class="md-card-title">' + escapeHtml(String(c?.content ?? '').slice(0, 80)) + '</span>'
			+ (time ? '<span class="md-card-time">' + escapeHtml(time) + '</span>' : '')
			+ strength + '<span class="md-expand">▶</span></summary>'
			+ '<div class="md-content"><pre>' + escapeHtml(String(c?.content ?? '')) + '</pre></div>'
			+ (chips ? '<div class="md-meta">' + chips + '</div>' : '')
			+ '</details>';
	}).join('');
	return statRow
		+ '<div class="md-toolbar"><a class="md-btn" href="./detail?' + queryString(params, {}) + '">🔄 刷新</a>'
		+ '<span class="md-filter-label">只读 · 提交记录由引擎侧捕获</span></div>'
		+ '<div class="md-list">' + (cards
			|| '<div class="md-empty">暂无 Git 提交记录（提交代码后由引擎自动捕获 ✓）。</div>') + '</div>'
		+ '<div class="md-note">⚠ 这一页的两个方法（<code>getCommitStats</code> / <code>getRecentCommits</code>）'
		+ '都是**页面直调** ✓ —— 它们的首参**不是 agentId**（`getRecentCommits(50)` 的首参是 limit ✗）'
		+ '⇒ 塞进 `memory_api` 会被前置成错位参数，所以它们**刻意不在**工具白名单里 ✓。</div>';
}

/**
 * 📊 报告页（真源 `_renderReportView` 1215-1331 ✓）。
 *
 * ⚠ 零脚本适配：IDE 侧那 5 个类型按钮是"**换类型重新生成**"✗ ⇒ 本页换成 `?rtype=健康` 这类链接 ✓，
 * 并且在**没有 `rtype` 时默认生成 `summary`**（照 1241 行的"首屏自动出摘要" ✓）。
 * ⚠ `generateReport(type, agentId)` 的首参是 **type**（不是 agentId ✗）⇒ 页面直调：`[type, agentId]` ✓。
 */
function renderReportView(params, model) {
	const rtype = params.get('rtype') ?? 'summary';
	const typeBtns = REPORT_TYPES.map(rt => '<a class="md-btn' + (rt.id === rtype ? ' primary' : '')
		+ '" href="' + hrefTo(params, { rtype: rt.id }) + '">' + escapeHtml(rt.label) + '</a>').join('');
	const toolbar = '<div class="md-toolbar">' + typeBtns
		+ '<span class="md-btn disabled" title="报告是即时生成的（每次打开按当前数据算）⇒ 没有需要刷新的缓存">🔄 刷新</span>'
		+ '<span class="md-filter-label" style="margin-left:auto">当前：' + escapeHtml(rtype) + '</span></div>';
	const r = model.report && typeof model.report === 'object' ? model.report : null;
	if (!r) {
		return toolbar + '<div class="md-empty">'
			+ (model.hasGateway ? '报告为空（引擎没返回内容 ✓）' : '网关未配置 ⇒ 取不到报告 ✗')
			+ '</div>';
	}
	const health = String(r.overallHealth ?? 'unknown');
	// 健康徽标：healthy ⇒ l1 / degraded ⇒ l2 / 其它 ⇒ l3（照 1269 行 ✓）
	const healthCls = health === 'healthy' ? 'l1' : health === 'degraded' ? 'l2' : 'l3';
	const healthCard = '<div class="md-card" style="margin:0 20px 12px">'
		+ '<div class="md-card-header"><span class="md-badge ' + healthCls + '">' + escapeHtml(health.toUpperCase()) + '</span>'
		+ '<span class="md-card-title">' + escapeHtml(String(r.summary ?? '')) + '</span></div></div>';
	const recs = Array.isArray(r.recommendations) ? r.recommendations : [];
	const recCard = recs.length
		? '<div class="md-card" style="margin:0 20px 8px"><div class="md-card-header">💡 建议</div>'
			+ '<div class="md-content">' + recs.map(x => '<div>• ' + escapeHtml(String(x)) + '</div>').join('') + '</div></div>'
		: '';
	const sections = Array.isArray(r.sections) ? r.sections : [];
	const sectionCards = sections.map(sec => {
		const healthy = sec?.healthy !== false;
		const metrics = sec?.metrics && typeof sec.metrics === 'object' ? Object.entries(sec.metrics) : [];
		const warnings = Array.isArray(sec?.warnings) ? sec.warnings : [];
		return '<details class="md-card" open>'
			+ '<summary class="md-card-header"><span class="md-badge ' + (healthy ? 'l1' : 'l3') + '">'
			+ (healthy ? '✓' : '✗') + '</span>'
			+ '<span class="md-card-title">' + escapeHtml(String(sec?.name ?? 'unknown')) + '</span>'
			+ '<span class="md-expand">▶</span></summary>'
			+ '<div class="md-content">'
			+ (metrics.length ? '<div class="md-metrics">' + metrics.map(([k, v]) =>
				'<div class="md-diag-item"><span class="key">' + escapeHtml(k) + '</span><span class="val">'
				+ escapeHtml(v === undefined || v === null ? '(空)' : String(v)) + '</span></div>').join('') + '</div>' : '')
			+ warnings.map(w => '<blockquote class="md-warn">⚠️ ' + escapeHtml(String(w)) + '</blockquote>').join('')
			+ '</div></details>';
	}).join('');
	return toolbar + healthCard + recCard
		+ '<div class="md-list">' + (sectionCards || '<div class="md-empty">该报告没有分节内容 ✓</div>') + '</div>';
}

/**
 * 会话卡里的相对时间（照抄 IDE 侧 `_sessionRelTime` 937-946 行的**逻辑** ✓）。
 *
 * ⚠⚠ **这里修掉了真源的一处既存 bug**（不是照抄 ✗）：IDE 侧签名是 `_sessionRelTime(iso: string)`，
 *   函数体直接 `new Date(iso)` —— 而引擎返回的 `updatedAt` / `startedAt` 可能是**数字时间戳**，
 *   调用处又做了 `String(...)` ⇒ `new Date('1760000000000')` 得到 **Invalid Date** ✗✗
 *   （只有 ISO 字符串才解析得动）⇒ **真源那边数字时间戳一律显示成空白** ✓。
 *   本页实测就是如此：一开始 `分钟前` 一个都不出现（`p3-89` 的 64 抓到的 ✓）。
 *   ⇒ 修法：**两种都收**（数字 / 字符串 ✓），既修了这处，也兼容引擎两种返回形态 ✓。
 */
function sessionRelTime(value) {
	const ms = typeof value === 'number' ? value : new Date(String(value ?? '')).getTime();
	if (!ms || Number.isNaN(ms)) { return ''; }
	const min = Math.floor((Date.now() - ms) / 60000);
	if (min < 1) { return '刚刚'; }
	if (min < 60) { return min + '分钟前'; }
	const hour = Math.floor(min / 60);
	if (hour < 24) { return hour + '小时前'; }
	return Math.floor(hour / 24) + '天前';
}

/**
 * 💬 会话页（真源 `_renderSessionsView` 782-828 + `_appendSessionCard` 830-871 + `_fillSessionDetail` 873-935 ✓）。
 *
 * ## 零脚本下的一处**结构性改动**（必须记清楚，别当成实现瑕疵 ✗）
 * IDE 侧的展开是**懒加载**：点标题才去 `observeList`（864-870 行的 `loaded` 标记 ✓）。零脚本做不出
 * "点击后发请求"✗ ⇒ 本页改成：**点标题 ⇒ 换 `?session=<sid>` 重新请求整页** ✓，服务端**只对选中的那一个
 * 会话**取观察 ✓。⚠ 为什么不"一次把每个会话的观察都渲染出来"：那要对 N 个会话各发一次
 * `observeList` ✗（会话多时是 N 次网关往返）—— 而这一页**默认一个都不取** ✓。
 *
 * ## 照抄的要点
 * ① 统计 4 格：`会话数` / `观察总数`（= Σ `observationCount`）/ `已压缩会话`（有对应摘要的会话数）/
 *    `摘要数` ✓；② 卡徽标 `已压缩`(l1) / `暂存中`(l0) ✓；标题取 `firstPrompt` → `id` → '未命名会话' ✓；
 *    时间用**相对时间**（刚刚 / N分钟前 / … ✓）；③ chips：`👁 N 观察` / `📦 project` /
 *    `🗜 压缩 N 观察` ✓；④ 详情里"关键决策"取**前 10**、"涉及文件"取**前 20**、"概念"取**前 20** 个 ✓；
 *    ⑤ 观察按 `timestamp` **倒序**取**前 15**，行首标记 `🗜`(已压缩) / `⭐`(importance ≥ 5) / `·` ✓，
 *    超出则尾部写 `… 共 N 条观察` ✓；⑥ 标题文案随是否已压缩而变（`观察（暂存层残留）` / `观察（暂存层）` ✓）。
 */
function renderSessionsView(params, model) {
	const sessions = Array.isArray(model.sessions) ? model.sessions : [];
	const summaries = Array.isArray(model.summaries) ? model.summaries : [];
	const byId = new Map(summaries.map(s => [String(s?.sessionId ?? ''), s]));
	// ★ 2026-10-21：会话与摘要现在**跨分区**合并 ⇒ 配对键必须带分区
	//   （只按 sessionId 配 ⇒ 不同分区的同名 session 会互相错配，"已压缩"徽章就会串 ✗）。
	const sessionKeyOf = (partition, sessionId) => String(partition ?? '') + '::' + String(sessionId ?? '');
	const byKey = new Map(summaries.map(s => [sessionKeyOf(s?.partition, s?.sessionId), s]));
	const totalObs = sessions.reduce((n, s) => n + (Number(s?.observationCount) || 0), 0);
	const summarized = sessions.filter(s => byKey.has(sessionKeyOf(s?.partition, s?.id))).length;
	const statRow = '<div class="md-stats">'
		+ statCell('会话数', sessions.length, 'l0') + statCell('观察总数', totalObs, 'l1')
		+ statCell('已压缩会话', summarized, 'l2') + statCell('摘要数', summaries.length, 'l3') + '</div>';
	const selected = params.get('session') ?? '';
	// ★ 2026-10-21：选中态要**带分区**（同名 session 跨分区重复 ⇒ 只看 id 会同时展开多条 ✗）
	const selectedPart = params.get('partition') ?? '';
	const cards = sessions.map(s => {
		const sid = String(s?.id ?? '');
		const summary = byKey.get(sessionKeyOf(s?.partition, sid));
		const compressed = !!summary;
		const isOpen = selected !== '' && selected === sid
			&& (selectedPart === '' || selectedPart === String(s?.partition ?? ''));
		// ★ 2026-10-21：会话可能来自**工作区分区**或**agent 分区**（两种口径都显示）⇒
		//   标注来源分区，否则用户看到"同一个会话在两个分区各一份"会以为重复 ✗。
		const partChip = s?.partition
			? '<span class="md-meta-chip session">🗂 ' + escapeHtml(String(s.partition)) + '</span>'
			: '';
		const chips = '<span class="md-meta-chip">👁 ' + (Number(s?.observationCount) || 0) + ' 观察</span>'
			+ partChip
			+ (s?.project ? '<span class="md-meta-chip">📦 ' + escapeHtml(String(s.project)) + '</span>' : '')
			+ (summary && typeof summary.observationCount === 'number'
				? '<span class="md-meta-chip">🗜 压缩 ' + summary.observationCount + ' 观察</span>' : '');
		return '<div class="md-card" data-vssaros-md-session="' + escapeHtml(sid) + '">'
			+ '<div class="md-card-header"><span class="md-badge ' + (compressed ? 'l1' : 'l0') + '">'
			+ (compressed ? '已压缩' : '暂存中') + '</span>'
			// 点标题 = 换 `?session=`（选中/取消 ✓）；零脚本下这就是"展开"的原语 ✓
			+ '<a class="md-card-title md-session-link" href="' + hrefTo(params, { session: isOpen ? '' : sid, partition: isOpen ? '' : String(s?.partition ?? '') }) + '">'
			+ escapeHtml(String(s?.firstPrompt || sid || '未命名会话')) + '</a>'
			// ⚠ **别在这里 `String(...)`**：真源正是这么干才让数字时间戳变成 Invalid Date ✗（见函数头注释 ✓）
			+ '<span class="md-card-time">' + escapeHtml(sessionRelTime(s?.updatedAt ?? s?.startedAt ?? '')) + '</span>'
			+ '</div>'
			+ '<div class="md-meta">' + chips + '</div>'
			+ (isOpen ? renderSessionDetail(s, summary, model) : '')
			+ '</div>';
	}).join('');
	// ★ 2026-10-21：空态要说清"查了哪些分区"（否则用户以为没记录，实际是分区口径不同 ✗）
	const searched = Array.isArray(model.sessionPartitions) ? model.sessionPartitions : [];
	const searchedNote = searched.length
		? '（已查分区：' + escapeHtml(searched.slice(0, 8).join('、')) + (searched.length > 8 ? ' … 共 ' + searched.length + ' 个' : '') + '）'
		: '';
	const truncatedNote = model.sessionPartitionsTruncated
		? '<div class="md-note">⚠ 分区数超过上限，只查了前 ' + searched.length + ' 个（共 ' + (Number(model.sessionPartitionsTotal) || 0) + ' 个）⇒ 这里的会话数**少于**真实值。</div>'
		: '';
	// ⚠ 取数失败要**如实显示**（静默显示"暂无会话记录"会把"失败"说成"没有" ✗）
	const errorNote = model.sessionsError
		? '<div class="md-note">⚠ 会话取数失败：' + escapeHtml(String(model.sessionsError)) + '</div>'
		: '';
	return statRow
		+ '<div class="md-toolbar"><a class="md-btn" href="./detail?' + queryString(params, {}) + '">🔄 刷新</a>'
		+ '<span class="md-filter-label">只读 · 点会话标题展开详情（'
		+ (selected ? '当前：' + escapeHtml(selected) : '当前未选中') + '）</span></div>'
		+ truncatedNote
		+ '<div class="md-list">' + (cards
			|| '<div class="md-empty">暂无会话记录（开始对话后，观察会暂存到会话，达到阈值或会话结束时压缩为摘要 ✓）。' + searchedNote + '</div>')
		+ '</div>'
		+ '<div class="md-note">⚠ IDE 侧的展开是**懒加载**（点一下才取观察 ✗）；零脚本做不到"点击后发请求" ⇒ '
		+ '本页改成**点标题换 `?session=` 重新请求整页** ✓ —— 服务端**只对选中的那一个**会话取观察，'
		+ '默认一个都不取 ✓（否则 N 个会话就是 N 次网关往返 ✗）。</div>';
}

/** 单个会话的详情（真源 `_fillSessionDetail` 873-935 ✓；`model.sessionDetail` 由 index.js 只对选中会话取 ✓）。 */
function renderSessionDetail(s, summary, model) {
	const detail = model.sessionDetail && typeof model.sessionDetail === 'object' ? model.sessionDetail : {};
	const compressed = !!summary;
	let out = '';
	if (compressed && summary) {
		out += '<h3>📋 ' + escapeHtml(String(summary.title ?? '会话摘要')) + '</h3>';
		if (summary.narrative) { out += '<p class="md-pre">' + escapeHtml(String(summary.narrative)) + '</p>'; }
		const decisions = Array.isArray(summary.keyDecisions) ? summary.keyDecisions : [];
		if (decisions.length) {
			out += '<h3>关键决策</h3><ul>' + decisions.slice(0, 10).map(d => '<li>' + escapeHtml(String(d)) + '</li>').join('') + '</ul>';
		}
		const files = Array.isArray(summary.filesModified) ? summary.filesModified : [];
		if (files.length) {
			out += '<h3>涉及文件</h3><ul>' + files.slice(0, 20).map(f => '<li>' + escapeHtml(String(f)) + '</li>').join('') + '</ul>';
		}
		const concepts = Array.isArray(summary.concepts) ? summary.concepts : [];
		if (concepts.length) {
			out += '<p class="md-dim">概念: ' + escapeHtml(concepts.slice(0, 20).join(', ')) + '</p>';
		}
	}
	const obs = Array.isArray(detail.observations) ? detail.observations : null;
	if (obs === null) { return '<div class="md-content">' + out + '</div>'; }
	out += '<h3>' + (compressed ? '观察（暂存层残留）' : '观察（暂存层）') + '</h3>';
	if (!obs.length) {
		out += '<p class="md-dim">（无观察）</p>';
	} else {
		const recent = [...obs].sort((a, b) => String(b?.timestamp ?? '').localeCompare(String(a?.timestamp ?? ''))).slice(0, 15);
		out += '<ul>' + recent.map(o => {
			const imp = Number(o?.importance) || 0;
			const mark = o?.compressed ? '🗜' : (imp >= 5 ? '⭐' : '·');
			return '<li>' + mark + ' [' + escapeHtml(String(o?.hookType ?? '')) + '] '
				+ escapeHtml(String(o?.title ?? '').slice(0, 80)) + '</li>';
		}).join('') + '</ul>';
		if (obs.length > 15) { out += '<p class="md-dim">… 共 ' + obs.length + ' 条观察</p>'; }
	}
	return '<div class="md-content">' + out + '</div>';
}

/**
 * 🔄 固化页（真源 `_renderConsolidationView` 962-1030 ✓）。
 *
 * 照抄要点：① 顶部一张**固化上下文**卡（`getConsolidationContext` ✓，max-height 200 + pre-wrap ✓）；
 * ② 三层固定顺序 Episodic(l1) / Semantic(l2) / Procedural(l3) ✓，每层一个**层头**（底边 2px +
 * 层名徽标 + `N 条`）✓；③ **空层整层跳过** ✓（不显示"0 条"的空壳 ✓）；④ 每项一张卡：徽标 = `item.type`
 * （缺省用层 id ✓）、标题 = `content` → `narrative` 截 80 ✓、时间 ✓；⑤ ⚠ **默认折叠**（真源这里
 * **没有** `card.classList.add('expanded')` ✓ —— 与「记忆」页相反，别"统一"成展开 ✗）；
 * ⑥ 结构化字段 chips 固定 6 个：`title` / `facts` / `concepts` / `files` / `importance` / `strength` ✓
 * （对象值 ⇒ JSON 截 60 ✓）。
 *
 * ⚠ 这三个方法**首参都是 agentId** ✓ ⇒ 它们在 `MEMORY_API_READONLY` 里 ✓（与钩子/提交那几页不同 ✓）。
 */
function renderConsolidationView(params, model) {
	const ctx = typeof model.consolidationContext === 'string' ? model.consolidationContext : '';
	const ctxCard = ctx
		? '<div class="md-card" style="margin:8px 20px 8px"><div class="md-content" style="max-height:200px">'
			+ '<pre>' + escapeHtml(ctx) + '</pre></div></div>'
		: '';
	const tiers = [
		{ id: 'episodic', label: 'Episodic', badge: 'l1', key: 'episodicItems' },
		{ id: 'semantic', label: 'Semantic', badge: 'l2', key: 'semanticItems' },
		{ id: 'procedural', label: 'Procedural', badge: 'l3', key: 'proceduralItems' },
	];
	const FIELDS = ['title', 'facts', 'concepts', 'files', 'importance', 'strength'];
	let body = '';
	for (const tier of tiers) {
		const items = Array.isArray(model[tier.key]) ? model[tier.key] : [];
		if (items.length === 0) { continue; }
		body += '<div class="md-tier-head" data-vssaros-md-tier="' + tier.id + '">'
			+ '<span class="md-badge ' + tier.badge + '">' + tier.label + '</span>'
			+ '<span class="md-card-title">' + items.length + ' 条</span></div>';
		for (const item of items) {
			const title = String(item?.content ?? item?.narrative ?? '');
			const chips = FIELDS.filter(f => item?.[f] !== undefined && item?.[f] !== null).map(f => {
				const v = item[f];
				const text = typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v);
				return '<span class="md-meta-chip">' + escapeHtml(f + ': ' + text) + '</span>';
			}).join('');
			const ts = item?.timestamp ? (() => {
				const d = new Date(item.timestamp);
				return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
			})() : '';
			// ⚠ **不要**加 open：真源这一页是**默认折叠**的 ✓（与记忆页相反 ✓）
			body += '<details class="md-card" data-vssaros-md-consolidated="' + escapeHtml(String(item?.id ?? '')) + '">'
				+ '<summary class="md-card-header"><span class="md-badge ' + tier.badge + '">'
				+ escapeHtml(String(item?.type ?? tier.id)) + '</span>'
				+ '<span class="md-card-title">' + escapeHtml(title.slice(0, 80)) + '</span>'
				+ (ts ? '<span class="md-card-time">' + escapeHtml(ts) + '</span>' : '')
				+ '<span class="md-expand">▶</span></summary>'
				+ '<div class="md-content"><pre>' + escapeHtml(title) + '</pre></div>'
				+ (chips ? '<div class="md-meta">' + chips + '</div>' : '')
				+ '</details>';
		}
	}
	return ctxCard
		+ '<div class="md-toolbar"><a class="md-btn" href="./detail?' + queryString(params, {}) + '">🔄 刷新</a>'
		+ '<span class="md-filter-label">只读 · 三层固化结果（空层整层跳过 ✓）</span></div>'
		+ '<div class="md-list">' + (body || '<div class="md-empty">三层都还没有固化产出 ✓（引擎在会话结束 / 达到阈值时才沉淀 ✗）。</div>')
		+ '</div>';
}

/**
 * 未迁移页签的**如实**说明 ✗。
 *
 * ⚠ 为什么不干脆藏掉这 9 个页签 ✗：IDE 侧有它们（同一块面板），藏掉会让"这里少了几页"变成
 *   一个不可解释的差异 ⇒ 显示 + 明确说"尚未迁移" + 给出**数据面已就绪**的证据（各页要的方法名 ✓）
 *   才是可推进的状态 ✓。
 */
function renderNotMigrated(params) {
	const id = params?.get('view');
	const view = DETAIL_VIEWS.find(v => v.id === id) ?? { label: id ?? '?' };
	return '<div class="md-note" data-vssaros-md-pending="' + escapeHtml(String(id ?? '')) + '">'
		// ⚠ "可用的是哪几页"用**变量**推出来（不是手写一句 ✗）—— 否则每迁一页就要改文案，
		//   而没有任何断言守它（`p3-89` 的 ⑱ 只断言"如实说了尚未迁移" ✓）。
		+ '<b>' + escapeHtml(String(view.label)) + '</b> 这一页 dsh 侧<b>尚未迁移</b> ✗ —— 现在可用的是：'
		+ DETAIL_VIEWS.filter(v => v.impl).map(v => escapeHtml(v.label)).join(' · ') + ' ✓。<br><br>'
		+ '真源是 IDE 侧 <code>MemoryDetailEditorPane</code>，各页签的渲染函数与数据源已查清：'
		+ '<ul>'
		+ '<li>💬 会话 ← <code>listSessions</code> / <code>listSummaries</code> / <code>observeList</code></li>'
		+ '<li>📌 槽位 ← <code>getSlots</code> / <code>slotList</code> / <code>getSlot</code></li>'
		+ '<li>📖 教训 ← <code>getLessons</code></li>'
		+ '<li>🔄 固化 ← <code>getEpisodicMemories</code> / <code>getSemanticMemories</code> / <code>getProceduralMemories</code> / <code>getConsolidationContext</code></li>'
		+ '<li>📋 审计 ← <code>getAuditSummary</code>（<code>getAuditLog</code> 需按首参口径直调 ✓）</li>'
		+ '<li>🪝 钩子 ← <code>getHookStats</code> · 🔀 提交 ← <code>getCommitStats</code> / <code>getRecentCommits</code>（这三个**刻意不在**工具白名单里 ⇒ 页面直调 ✓）</li>'
		+ '<li>📊 报告 ← <code>generateReport</code> · ⚡ 技能 ← <code>listSkills</code> / <code>getSkillStats</code></li>'
		+ '</ul>'
		+ '⇒ 剩下的是**逐个补渲染函数**的活，数据面已经够 ✓。'
		+ '</div>';
}

/** 诊断区块（本页区块形式 ✓）。 */
function renderDiagnostics(model) {
	const rows = Object.entries(model.diag ?? {}).map(([k, v]) =>
		'<div class="md-diag-item"><span class="key">' + escapeHtml(k) + '</span><span class="val">'
		+ (typeof v === 'boolean' ? (v ? '<span class="pass">true</span>' : '<span class="fail">false</span>')
			: escapeHtml(v === undefined || v === null ? '(空)' : String(v)))
		+ '</span></div>').join('');
	return '<section class="md-diag-section" data-vssaros-md-diag="1">'
		+ '<h3>诊断（<code>diagnose</code> + <code>getExtendedStats</code>）</h3>'
		+ (rows || '<div class="md-diag-item"><span class="key">（无数据 —— 网关未配置或方法不可达）</span></div>')
		+ '</section>';
}

/** 「🧠 记忆」页签主体。 */
function renderMemories(params, model) {
	const items = model.items ?? [];
	const cards = items.map((it, i) => renderCard(it, i === 0)).join('');
	return renderStatRows(model)
		+ renderToolbar(params, model)
		+ renderAgentPicker(params, model)
		+ renderFilters(params, model)
		+ (model.tool === 'diag' ? renderDiagnostics(model) : '')
		+ '<div class="md-list">'
		+ (model.error
			? '<div class="md-empty">取数失败：' + escapeHtml(model.error) + '</div>'
			: (cards || '<div class="md-empty">没有命中任何记忆条目'
				+ (params?.get('q') ? '（搜索词：' + escapeHtml(params.get('q')) + '）' : '') + '。</div>'))
		+ (model.truncated
			? '<div class="md-note">只显示前 ' + items.length + ' 条（该分区共 ' + (model.total ?? 0)
				+ ' 条）⇒ 用上方搜索或筛选收窄 ✓。</div>'
			: '')
		+ '</div>';
}

/**
 * 渲染整页（**纯函数**：不做任何 I/O ✓）。
 *
 * 为什么不在这里取数 ✗：① `p3-07` / `p3-69` 这类假网关探针要能**直接喂数据**测它 ✓；
 * ② 取数是 async，而本文件要保持可被同步调用（与 `renderFragment` 同款分工 ✓）。
 *
 * @param model.params      `URLSearchParams`（本页认 `view/layer/type/q/agent/tool` ✓）
 * @param model.agentId     当前分区
 * @param model.hasGateway  网关是否配置（false ⇒ 不显示"刷新"等会 500 的入口 ✓）
 * @param model.items       已过滤好的条目（`{id,type,tier,title,content,timestamp,strength,meta}` ✓）
 * @param model.total/tierCounts/typeCounts  **本地聚合**（IDE 侧同款 ✓）
 * @param model.extStats    `getExtendedStats` 原始对象（取前 8 个 key ✓）
 */
export function renderDetailPage(model) {
	const params = model.params;
	// ⚠ `tool` **必须**从 query 取出来再并进 model：`renderToolbar` / `renderMemories` 读的是
	//   `model.tool` ⇒ 不并进来的话它**永远是 undefined** ✗（`?tool=diag` 会静默失效 ✗）。
	//   这条是**纯函数验证**抓到的（`check.mjs` 的 ⑯）—— 它不经 server、直接喂数据 ⇒ 便宜且准 ✓。
	const tool = params?.get('tool') ?? '';
	const m = { ...model, tool };
	const active = params?.get('view') ?? 'memories';
	const view = DETAIL_VIEWS.find(v => v.id === active) ?? DETAIL_VIEWS[0];
	const header = '<div class="md-header"><div class="md-header-bar"><h1>🧠 记忆详情</h1>'
		+ '<span class="md-filter-label">' + (model.hasGateway ? '网关已连接' : '⚠ 网关未配置')
		+ ' · 分区 <code>' + escapeHtml(model.agentId) + '</code></span>'
		+ '<span class="md-filter-label" style="margin-left:auto"><a class="md-btn" href="./" title="回到记忆库页">← 记忆库</a></span>'
		+ '</div></div>';
	const body = '<div class="memory-detail-container" data-vssaros-page="memory-detail" data-vssaros-md-view="' + escapeHtml(active) + '">'
		+ renderViewNav(params)
		+ header
		// 已迁移的页签在此分派；未迁移的落到 `renderNotMigrated` ✓（它会**如实**说明，不假装有内容 ✓）
		+ (active === 'memories' ? renderMemories(params, m)
			: active === 'slots' ? renderSlotsView(params, m)
				: active === 'lessons' ? renderLessonsView(params, m)
					: active === 'audit' ? renderAuditView(params, m)
						: active === 'skills' ? renderSkillsView(params, m)
							: active === 'hooks' ? renderHooksView(params, m)
								: active === 'commits' ? renderCommitsView(params, m)
									: active === 'report' ? renderReportView(params, m)
										: active === 'sessions' ? renderSessionsView(params, m)
											: active === 'consolidation' ? renderConsolidationView(params, m)
												: renderNotMigrated(params))
		+ '</div>';
	return {
		body,
		title: '记忆详情 · ' + view.label,
		extraCss: DETAIL_CSS,
	};
}

/**
 * 工具栏里 `?tool=…` 的动作 —— **由 `index.js` 在路由里执行**（本文件不碰 I/O ✓）。
 *
 * 返回值是"该动作要回什么响应"的描述，不是结果本身 ✓（保持本文件纯粹 ✓）。
 */
export const DETAIL_TOOLS = ['diag', 'export-json', 'export-md'];
