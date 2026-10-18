// @vssaros/dsh-*-page-shell —— 插件自托管页面的**外壳规范**（VsSaros 原先容器样式的移植）。
//
// 为什么需要它：`engine=dsh` 时，容器侧栏由 `DshPluginViewPane` 承载**插件自托管页面**（原生
// WebContentsView），原来那些专用 ViewPane（`TasksViewPane` / `WorkflowViewPane` /
// `KnowledgeBaseViewPane`）**一律不再注册** ⇒ 它们的外壳（标题栏 / 搜索行 / 状态筛选 chips /
// 列表项状态色 / 计数头 / 空态）在 dsh 侧**完全缺席**，只剩页面自己那点内联样式。
//
// 本文件的样式**逐条移植自 VsSaros 原 Pane**，真源（改样式时两边一起改）：
//   · 看板：`src/vs/sessions/contrib/agentStudio/browser/views/tasksView.ts:262-458`（`_getScopedCSS`）
//   · 工作流：`src/vs/sessions/contrib/agentStudio/browser/views/workflowView.ts:712-1008`
//   · 资料库：`src/vs/sessions/contrib/agentStudio/browser/views/media/kbView.css`
// 口径：只用 `--vscode-*` 主题变量（+ 与原 Pane 相同的硬编码状态色，如 `#f59e0b`），
// 不引入新色板；`var(--vscode-x, 回退)` 的回退值与原 Pane 一致，保证变量缺失时不至于不可读。
//
// 分发方式（与 `lib/store.js` 同一约定：**复制 + 真源注释**）：每个用到外壳的插件
// vendor 一份**逐字节相同**的副本（`lib/pageShell.js`），由守卫断言四份一致；不跨包 import
// （插件是独立安装的包，profile 里没有互相解析的路径）。

/** HTML 转义（页面全部服务端渲染，任何用户数据都必须过这一层）。 */
export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * 外壳样式：根布局 + 标题 + 工具条 + 搜索行 + chips + 计数头 + 列表项 + 空态 + 分区。
 * 类名前缀统一 `dsh-`，与看板页原有 `data-vssaros-page` 锚点互不干扰。
 */
export const SHELL_CSS = `
:root { color-scheme: light dark; }
html, body { height: 100%; }
body {
	margin: 0;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	font-family: var(--vscode-font-family, system-ui, "Segoe UI", sans-serif);
	font-size: 12px;
	color: var(--vscode-foreground, #ccc);
	background: var(--vscode-sideBar-background, #1e1e1e);
}

/* 标题（原 Pane 的 body 内标题区） */
.dsh-header { padding: 8px 10px 4px; }
.dsh-header h1 { font-size: 13px; font-weight: 600; margin: 0; }
.dsh-header h1 small { color: var(--vscode-descriptionForeground, #999); font-weight: 400; }

/* 工具条 */
.dsh-toolbar {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 8px;
	border-bottom: 1px solid var(--vscode-sideBar-border, rgba(128,128,128,.25));
}

/* 搜索行 */
.dsh-search {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 8px;
	border-bottom: 1px solid var(--vscode-sideBar-border, rgba(128,128,128,.25));
}
.dsh-search-icon { font-size: 12px; opacity: .6; }
.dsh-search input {
	flex: 1;
	min-width: 0;
	font-size: 11px;
	padding: 3px 6px;
	border-radius: 3px;
	border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
	background: var(--vscode-input-background, transparent);
	color: var(--vscode-input-foreground, #ccc);
	outline: none;
}
.dsh-search input:focus { border-color: var(--vscode-focusBorder, #007fd4); }

/* 状态筛选 chips */
.dsh-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 3px;
	padding: 4px 8px;
	border-bottom: 1px solid var(--vscode-sideBar-border, rgba(128,128,128,.25));
}
.dsh-chip {
	font-size: 10px;
	padding: 1px 6px;
	border-radius: 9px;
	border: 1px solid var(--vscode-input-border, transparent);
	background: transparent;
	color: var(--vscode-foreground, #ccc);
	cursor: pointer;
	opacity: .7;
}
.dsh-chip:hover { opacity: 1; background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.dsh-chip.active { opacity: 1; background: var(--vscode-button-secondaryBackground, #3a3d41); border-color: var(--vscode-focusBorder, #007fd4); }

/* 滚动区 / 计数头 / 空态 */
.dsh-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 0; }
.dsh-count { font-size: 10px; color: var(--vscode-descriptionForeground, #999); padding: 4px 10px 2px; opacity: .7; }
.dsh-empty { text-align: center; padding: 24px 12px; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }

/* 列表项（含状态左边框色 —— 逐条照 tasksView.ts:404-418） */
.dsh-item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	margin: 1px 4px;
	border-radius: 4px;
	border-left: 3px solid transparent;
}
.dsh-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.dsh-item.status-triage { border-left-color: #8b5cf6; }
.dsh-item.status-todo { border-left-color: #f59e0b; }
.dsh-item.status-ready { border-left-color: #0ea5e9; }
.dsh-item.status-running { border-left-color: #3b82f6; }
.dsh-item.status-blocked { border-left-color: #ef4444; }
.dsh-item.status-done { border-left-color: #10b981; }
.dsh-item.status-cancelled { border-left-color: #6b7280; }
.dsh-item.status-archived { border-left-color: #8b5cf6; }
.dsh-item-status { flex-shrink: 0; width: 20px; text-align: center; font-size: 12px; }
.dsh-item-content { flex: 1; min-width: 0; overflow: hidden; }
.dsh-item-title {
	font-size: 12px;
	line-height: 1.35;
	color: var(--vscode-foreground, #ccc);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.dsh-item-meta {
	font-size: 10px;
	line-height: 1.3;
	margin-top: 1px;
	color: var(--vscode-descriptionForeground, #999);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.dsh-item-priority { flex-shrink: 0; font-size: 12px; }
.dsh-id {
	color: var(--vscode-descriptionForeground, #999);
	font-family: ui-monospace, Consolas, monospace;
	margin-right: 6px;
}

/* 分区（工作流/资料库/代码图谱页用） */
.dsh-section {
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
	border-radius: 6px;
	padding: 8px 10px;
	margin: 8px 10px;
}
.dsh-section h2 {
	font-size: 11px;
	margin: 0 0 6px;
	text-transform: uppercase;
	letter-spacing: .04em;
	color: var(--vscode-descriptionForeground, #999);
}
.dsh-section h2 small { color: var(--vscode-foreground, #ccc); }

/* 工具条里的链接与按钮（工作流 / 记忆 / 代码库页的工具条用） */
.dsh-link { color: var(--vscode-textLink-foreground, #3794ff); font-size: 11px; white-space: nowrap; cursor: pointer; }
.dsh-btn {
	background: var(--vscode-button-background, #0e639c);
	color: var(--vscode-button-foreground, #fff);
	border: 0;
	border-radius: 4px;
	padding: 4px 10px;
	font: inherit;
	cursor: pointer;
}

/* 诊断行（机器可断言的 data-vssaros-* 锚点都挂在这类元素上） */
.dsh-diag {
	color: var(--vscode-descriptionForeground, #999);
	font-size: 11px;
	margin: 0;
	padding: 2px 10px 6px;
}
code { font-family: ui-monospace, Consolas, monospace; }
button, input, select { font-family: inherit; }
`;

/**
 * 渲染状态筛选 chips（口径同 `tasksView.ts:96-117`：`All` 在前、默认 active）。
 *
 * @param {{ value: string, label: string, icon?: string, active?: boolean }[]} chips
 */
export function renderChips(chips) {
	return `<div class="dsh-chips" role="toolbar">${chips.map(c => {
		const cls = c.active ? 'dsh-chip active' : 'dsh-chip';
		const icon = c.icon ? `${escapeHtml(c.icon)} ` : '';
		return `<button type="button" class="${cls}" data-chip="${escapeHtml(c.value)}">${icon}${escapeHtml(c.label)}</button>`;
	}).join('')}</div>`;
}

// ⚠ 本文件**必须与模块无关** —— 它要被四个模块插件 vendor 成**逐字节相同**的副本（见上方分发约定），
// 所以模块专属的东西（看板的 `STATUS_ICONS` / `KANBAN_CHIPS`、工作流的动作按钮、资料库的 Tab …）
// 一律放各插件自己的 `lib/index.js`。往这里塞模块专属内容，等于让别的模块被迫依赖看板的状态表 ✗。

/**
 * 组装整页：外壳样式 + 页面专属样式 + 标题/工具条/chips/正文 + 可选脚本。
 *
 * `kind` 落到 `body[data-vssaros-page]`（既有探针的锚点，不可改）；
 * `attrs` 用来挂机器断言行（如 `data-vssaros-tools` / `data-registered`）。
 */
export function renderShell({ kind, title, subtitle = '', headerHtml = '', toolbarHtml = '', chipsHtml = '', bodyHtml = '', attrs = '', extraCss = '', script = '', lang = 'zh' }) {
	const head = subtitle ? `${escapeHtml(title)} <small>${escapeHtml(subtitle)}</small>` : escapeHtml(title);
	return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} · VsSaros</title>
<style>${SHELL_CSS}${extraCss}</style>
</head>
<body data-vssaros-page="${escapeHtml(kind)}"${attrs ? ` ${attrs}` : ''}>
${headerHtml || `<div class="dsh-header"><h1>${head}</h1></div>`}
${toolbarHtml}
${chipsHtml}
${bodyHtml}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}
