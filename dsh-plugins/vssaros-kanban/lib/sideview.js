// @vssaros/dsh-kanban — **侧栏紧凑版**页面（sideview）。
//
// ⚠ 2026-10-14 引入（用户：「tasks 工作台缺少打开按钮，打开对应的 editorpane」）。做法与
//   `@vssaros/dsh-dashboard/lib/sideview.js` **完全同形**：宿主在**侧栏**承载插件页时注入
//   `?surface=sideview`（`dshPluginViewPane.ts` 第 6 参）⇒ 渲染**摘要 + 入口**；不带该参数 ⇒ 编辑区完整版
//   （`lib/board.js` 的多列看板）。
//
// 为什么侧栏不能照搬完整版：侧栏只有三百来像素，横向多列看板在那里等于每列几十像素（拖拽/折叠手柄
// 只有几像素 ⇒ 误触概率高）。所以侧栏只回答两件事：**"现在什么状况"** 与 **"从哪进去"**。
//
// ⚠ 与看板页**共用**的东西（不能各写一份，否则两边数字会漂）：
//   · 计数 `countsByStatus`（来自 `lib/board.js`）；
//   · 自诊断锚点 `diagHtml`（`data-vssaros-tools` / `data-registered` / 工作区 / 数据文件路径）。
//   ⇒ 两次探针都能在任一表面上断言同一批锚点 ✓。
//
// ⚠ 本文件的 HTML 在**模板字符串**里：注释与文案里**绝不能出现反引号**（会提前闭合整页；本仓已踩 5 次）。

import { countsByStatus, diagHtml, sortByRecent, statusIcon } from './board.js';
import { escapeHtml, renderChips, renderShell } from './pageShell.js';

/** 侧栏里最多列几条"需要关注"（原生那份 Dashboard 侧栏也是 5 条量级）。 */
const FOCUS_LIMIT = 6;
/** 「需要关注」= 还没走到终态的那些状态（`done` / `cancelled` / `archived` 不算）。 */
const FOCUS_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked'];

/** 侧栏的状态筛选 chips（`All` 在前，口径同原 `TasksViewPane`）。 */
const SIDEBAR_CHIPS = [
	{ value: 'all', label: '全部', icon: '📋', active: true },
	{ value: 'running', label: '执行中', icon: '⚡' },
	{ value: 'todo', label: '待执行', icon: '⬜' },
	{ value: 'ready', label: '就绪', icon: '✔️' },
	{ value: 'triage', label: '待分解', icon: '🗂' },
	{ value: 'done', label: '已完成', icon: '✅' },
];

/**
 * 「打开完整看板」按钮的点击行为（三级退化，与「主页」同款）：
 * ① 有页面桥（真机里一定有）⇒ 发 `openModulePage`，由 IDE 在**编辑区**打开同一个插件页；
 * ② 有桥但版本旧（没有这个方法）⇒ 原地导航到完整页；
 * ③ 纯浏览器（没有桥）⇒ 新标签页打开完整页 —— 这是**真能用的**退化，不是"点了没反应"。
 *
 * ⚠ 传 `location.pathname`（`/x/kanban/`，**不含查询串**）：宿主用它查模块页表（白名单），
 *   带不带 `surface=sideview` 是宿主的自由 ⇒ 页面不该把自己钉在某个表面参数上。
 */
const OPEN_FULL_JS = `(function(){var b=document.querySelector('[data-kanban-action="open-full"]');if(!b){return;}b.addEventListener('click',function(){var bridge=window.vssarosDsh;if(bridge&&typeof bridge.openModulePage==='function'){try{bridge.openModulePage(location.pathname);return;}catch(e){}}if(bridge){location.href=location.pathname;return;}window.open(location.pathname,'_blank','noopener');});})();`;

/** chips 就地过滤"需要关注"列表（不整页重载 ⇒ 输入即响应、不闪屏）。 */
const FILTER_JS = `(function(){document.body.dataset.kanbanClient='on';var rows=Array.prototype.slice.call(document.querySelectorAll('[data-kanban-focus-row]'));var chips=Array.prototype.slice.call(document.querySelectorAll('.dsh-chip'));var badge=document.querySelector('[data-kanban-focus-count]');var empty=document.querySelector('[data-kanban-focus-empty]');var status='all';function apply(){var shown=0;rows.forEach(function(row){var s=row.getAttribute('data-status')||'';var hit=status==='all'||s===status||(status==='todo'&&s==='ready')||(status==='running'&&s==='blocked');row.hidden=!hit;if(hit){shown+=1;}});if(badge){badge.textContent=String(shown);}if(empty){empty.hidden=shown!==0;}}chips.forEach(function(chip){chip.addEventListener('click',function(){chips.forEach(function(other){other.classList.remove('active');});chip.classList.add('active');status=chip.getAttribute('data-chip')||'all';apply();});});apply();})()`;

/** 侧栏页样式（只写本页用到的选择器；其余复用 `pageShell.js` 的外壳样式）。 */
const SIDEBAR_CSS = `
	/* ⚠ 本段在模板字符串里：注释里不能出现反引号。 */
	.kb-open { width: 100%; margin: 8px 0 10px; padding: 6px 10px; display: flex; align-items: center; justify-content: center; gap: 6px; }
	.kb-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 0 8px 10px; }
	.kb-kpi { padding: 6px 8px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 4px; }
	.kb-kpi-l { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground, #999); }
	.kb-kpi-v { font-size: 18px; font-weight: 300; line-height: 1.25; }
	.kb-kpi-d { font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
	/* ⚠ 条目是 flex ⇒ 必须显式让 hidden 生效（作者样式会盖掉 [hidden] 的 UA 规则） */
	.kb-focus [hidden] { display: none !important; }
	.kb-foot { font-size: 10px; line-height: 1.5; color: var(--vscode-descriptionForeground, #999); padding: 0 10px; margin: 8px 0 0; }
`;

/**
 * 渲染侧栏紧凑版。
 *
 * 吃**原始任务记录**（要看 `status` 与 `updatedAt`；描述不进这一页 —— 与看板页同一口径）。
 */
export function renderSideviewPage({ tasks, missing, registeredTools, expectedTools, dataFile, workspaceId }) {
	const all = (Array.isArray(tasks) ? tasks : []).filter(t => t && typeof t === 'object');
	const counts = countsByStatus(all);
	const total = counts.total;

	const kpis = [
		{ label: '待执行', value: (counts.todo ?? 0) + (counts.ready ?? 0), detail: `就绪 ${counts.ready ?? 0}` },
		{ label: '执行中', value: (counts.running ?? 0) + (counts.blocked ?? 0), detail: `阻塞 ${counts.blocked ?? 0}` },
		{ label: '执行结束', value: counts.done ?? 0, detail: `待分解 ${counts.triage ?? 0}` },
		{ label: '取消 / 归档', value: (counts.cancelled ?? 0) + (counts.archived ?? 0), detail: `取消 ${counts.cancelled ?? 0}` },
	];

	// 「需要关注」：未走到终态的卡片，最近更新的在前
	const focus = sortByRecent(all.filter(t => FOCUS_STATUSES.includes(String(t.status ?? ''))));
	const shown = focus.slice(0, FOCUS_LIMIT);
	const focusRows = shown.map(task => {
		const status = String(task.status ?? '');
		const meta = [
			`${statusIcon(status)} ${escapeHtml(status)}`,
			task.assigneeName ? `🤖 ${escapeHtml(String(task.assigneeName))}` : '未指派',
			escapeHtml(String(task.priority ?? '')),
			task.updatedAt ? escapeHtml(String(task.updatedAt).slice(0, 10)) : '',
		].filter(Boolean).join(' · ');
		return `<div class="dsh-item status-${escapeHtml(status)}" data-kanban-focus-row data-status="${escapeHtml(status)}">`
			+ `<span class="dsh-item-status" aria-hidden="true">${statusIcon(status)}</span>`
			+ '<div class="dsh-item-content">'
			+ `<div class="dsh-item-title"><span class="dsh-id">${escapeHtml(String(task.id ?? '').slice(-6))}</span>${escapeHtml(String(task.title ?? ''))}</div>`
			+ `<div class="dsh-item-meta">${meta}</div>`
			+ '</div></div>';
	}).join('');

	const diag = diagHtml({ registeredTools, expectedTools, workspaceId, dataFile });
	const more = focus.length > shown.length
		? `<p class="kb-foot">另有 ${focus.length - shown.length} 张未完成卡片 —— 完整看板里看。</p>`
		: '';

	const header = `<div class="dsh-header"><h1>Tasks <small>${total} 条（只读）</small></h1>${diag}</div>`;
	const toolbar = '<div class="dsh-toolbar"><button type="button" class="dsh-btn kb-open" data-kanban-action="open-full">📋 打开完整看板</button></div>';
	const body = '<div class="dsh-scroll">'
		+ '<div class="kb-kpis">' + kpis.map(kpi => `<div class="kb-kpi"><div class="kb-kpi-l">${escapeHtml(kpi.label)}</div><div class="kb-kpi-v">${kpi.value}</div><div class="kb-kpi-d">${escapeHtml(kpi.detail)}</div></div>`).join('') + '</div>'
		+ renderChips(SIDEBAR_CHIPS)
		+ '<div class="kb-focus">'
		+ `<div class="dsh-count">需要关注 <span data-kanban-focus-count>${shown.length}</span> / ${focus.length}</div>`
		+ (focusRows || '<p class="dsh-empty">没有未完成的卡片。</p>')
		+ '<p class="dsh-empty" data-kanban-focus-empty hidden>这个筛选下没有卡片。</p>'
		+ more
		+ '</div>'
		+ (missing
			? `<p class="dsh-empty">看板数据文件还不存在：<code>${escapeHtml(missing)}</code><br>首次启动或尚未使用看板时属正常。</p>`
			: '')
		+ '<p class="kb-foot" data-vssaros-kanban-scope="taskboard">口径：与 IDE 侧「看板」读<b>同一份</b> <code>taskboard.json</code>（IDE 那份看板没有 <code>triage</code> 列，本页有 ⇒ 模型刚建的卡在这里可见）。</p>'
		+ '<p class="kb-foot">这里只是摘要与入口：<b>多列看板、筛选、卡片详情</b>都在完整页里（点上面的按钮）。</p>'
		+ '</div>';

	return renderShell({
		kind: 'kanban',
		title: 'Tasks',
		subtitle: `${total} 条（只读）`,
		headerHtml: header,
		toolbarHtml: toolbar,
		bodyHtml: body,
		attrs: 'data-vssaros-kanban-surface="sideview"',
		extraCss: SIDEBAR_CSS,
		script: `${OPEN_FULL_JS}\n${FILTER_JS}`,
	});
}
