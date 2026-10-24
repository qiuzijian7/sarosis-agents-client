// @vssaros/dsh-workflow — host half：工作流只读页面（含**服务端渲染 SVG 画布**）+ 只读工具 + worker 自证。
//
// **v0 的边界（重要，别误读）**：本模块**没有**迁工作流引擎。方案 6.6/6.11.2 把这件事列为"高/不满足"：
// 引擎要从渲染进程 worker 迁到 Host `worker_threads`、Agent 节点改调 `ctx.agents`/`ctx.subagents`、
// 画布需 page 化。本切片做的是**能先落的那部分 + 把那个大前提变成可测事实**：
//   - 只读：列工作流、读节点图/边、跑过的会话数（读 `<数据根>/workflows/<id>/workflow.json`）；
//   - 画布：**服务端渲染 SVG**（真机数据证实 nodes 带 `position`）——不用 React 19 webview（那是待定项）；
//   - **engine.js 的 worker 自证**：每次渲染页面都起一个真 worker 拿回 threadId 再终止，
//     把"Host 能不能承载 worker_threads"从假设变成页面/工具上看得见的事实。
// 未做：执行（引擎迁移）、`ctx.agents` 接线、市场/发布、运行卡会话节点。

import { countIsolatedNodes, renderSvgCanvas, summarizeWorkflows } from './core/workflow.js';
import { bindFoundation } from './foundationRef.js';
import { buildSchema } from './core/schema.js';

import { probeWorkerThreads, runWorkflowLoad } from './engine.js';
// 重构 3.1：引擎核心环（DAG 编排 + checkpoint + 断点续跑 + 分支剪枝）。
import { createEngineCore } from './core/engineCore.js';
import { parseWorkflowCheckpoint } from './core/checkpoint.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// `NODE_META_KEYS` / `NODE_TYPE_ALIASES` **导出**是为 `workflow_get_schema` 用 ✓：schema 里那些规范性内容
// **从写侧常量推导** ✓（不是手写副本 ✗），`p3-10` 再拿两份互相对账 ⇒ 写侧改了目录会红 ✓。
import { NODE_META_KEYS, NODE_TYPE_ALIASES, applyWorkflow, checkpointDirOf, listWorkflows, mutateWorkflow, readWorkflow, workflowFilePathOf, workspacePathOf } from './store.js';

// 只读 agent 花名册（`<数据根>/agents/*/.agent.md` ✓，与 `vssaros-agents` 同源契约、各自一份实现 ✓）
import { listAgents } from './agents.js';


export const name = 'vssaros-workflow';

// 只依赖 tools：工具在任何模板里都该可用。webServer / connection 只在 web 模板里存在，
// 写进静态 `inject` 会让整个插件在 headless / tui profile 里**永久 pending**，连工具一起失效
//（2026-10-12 照 kanban 的现成写法收窄 —— 它的注释就是这条教训的先例 ✓；页面路由改为
// `ctx.inject(['webServer','connection'], …)` 动态挂 ⇒ 没有 web 模板时只是"没有页面"✓，工具照常在 ✓）。
export const inject = ['tools'];

/**
 * 页面渲染用的 worker 自证**缓存**（TTL）：起一个真 worker 拿 threadId 再终止是重活，而它
 * 只是页面上的一个事实栏（2026-10-12 优化，见 `doc/dsh-modules-conformance.html` §5-5）。
 *
 * ⚠ 只有**页面**用它；`workflow_engine_status` 工具**永远现跑** ✓ —— 那才是"现在到底行不行"的
 * 实证（这条区别是刻意的，别把它也缓存了 ✗）。
 */
const WORKER_PROBE_TTL_MS = 30_000;
let workerProbeCache;
async function probeWorkerCached() {
	const now = Date.now();
	if (workerProbeCache && now - workerProbeCache.at < WORKER_PROBE_TTL_MS) {
		return workerProbeCache.value;
	}
	const value = await probeWorkerThreads();
	workerProbeCache = { at: now, value };
	return value;
}

const ROUTE_PREFIX = '/x/workflow';
/** 本插件在反向通道里的调用方标识（VsSaros 侧据此查"这个插件声明了哪些能力"）。 */
const PLUGIN_ID = '@vssaros/dsh-workflow';
/** 「在画布打开」的等待预算：主进程一趟 + 渲染侧一趟（开编辑器，不开浏览器、不等用户），默认够用。 */
const OPEN_TIMEOUT_MS = 15_000;
/**
 * 「在 IDE 执行一个节点」（comfy / comfyStage / askUser）的等待预算 —— 比打开画布宽松得多：
 * 这类节点在壳侧要真的跑（ComfyTV 生成、媒体处理、等用户回答），百秒级是正常量级。
 *
 * ⚠ 2026-10-20：与 IDE 侧的 `IDE_REQUEST_EXECUTE_NODE_TIMEOUT_MS`（**180s**）配套，这里**故意小 30s**
 * —— 让**调用方先放弃**：超时时报的是"IDE 没回执"这个真因，而不是两边同时超时的竞态歧义
 * （`comfyStageBridge` 对 webview 也留 2min 余量，同一个思路）。要支持更久的长任务，两边一起调。
 */
const EXECUTE_NODE_TIMEOUT_MS = 150_000;
/** JSON 回执的统一响应头（多处理由共用一份，免得一处改了另一处忘）。 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
// ⚠ 这是**声明**的工具名清单（页面自诊断那一栏用它 ✓）—— 它必须与 `toolDefinitions()` 里真正注册的
// 名字**逐字一致** ✗。2026-10-12 加 `workflow_apply` 时漏改过这里一次 ✗，症状是"页面说 4 个、
// 注册表里 5 个" ✓（单元级看不出来 ✓）。⇒ `p3-10` 现在会拿**这两处互相对账** ✓（谁烂都红 ✓）。
export const TOOL_NAMES = ['workflow_list', 'workflow_get', 'workflow_get_schema', 'workflow_update', 'workflow_apply', 'workflow_engine_status', 'workflow_run'];
/** 页面上画布只画一个工作流（最大的那个，或 `?id=` 指定的）。 */
const CANVAS_NODE_LIMIT = 120;

// 页面外壳（标题 / 工具条 / 分区 / 空态 / 诊断行）逐条移植自 VsSaros 原容器 Pane，
// 见 `lib/pageShell.js` 顶部注释（真源行号 + 分发约定）。`escapeHtml` 由它提供；
// `renderChips` 是它的**共享筛选 chips 构建器** ✓（口径同 tasksView：`data-chip` + `active`），
// A 稿的「全部 / 有图 / 运行中 / 待整理」直接用它 ⇒ 不在本模块再抄一份 chips 标记 ✗。
import { escapeHtml, renderChips, renderShell } from './pageShell.js';


const isoOf = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '未知');

/**
 * 页面专属样式（统计行 / 紧凑行 / 徽章 / 画布 / 折叠区 / 自诊断）。
 * 骨架（标题 / 工具条 / 搜索行 / chips / 分区 / 空态）与主题变量由 `pageShell.js` 给 —— 能复用的都用它 ✓。
 *
 * ⚠ 本文件是**模板字符串**：注释与规则里一律不许出现反引号 ✗（会提前闭合，整个文件语法错 —— 本仓踩过多次）。
 */
const PAGE_CSS = `
.wf-grow { flex: 1; }
.dsh-header h1 { display: flex; align-items: center; gap: 6px; }
.wf-new { flex-shrink: 0; background: transparent; border: 0; font: inherit; font-size: 13px; line-height: 1; padding: 1px 5px; border-radius: 3px; color: var(--vscode-icon-foreground, #c5c5c5); cursor: pointer; }
.wf-new:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, .31)); }
.wf-stat { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; padding: 1px 10px 6px; font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
.wf-stat b { color: var(--vscode-foreground, #ccc); font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-search select { flex: 0 0 auto; max-width: 108px; font-size: 10px; padding: 2px; border-radius: 3px; border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, .35)); background: var(--vscode-input-background, transparent); color: var(--vscode-input-foreground, #ccc); }
.wf-row { align-items: flex-start; position: relative; padding: 6px 8px; cursor: pointer; }
.wf-row.wf-active { border-left-color: #10b981; }
.wf-row.wf-warn { border-left-color: #f59e0b; }
.wf-row.wf-cold { opacity: .7; }
.wf-l1 { display: flex; align-items: center; gap: 5px; font-weight: 600; }
.wf-l1 .wf-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-l2 { display: flex; align-items: center; gap: 6px; margin-top: 1px; font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
.wf-l2 .wf-id { flex-shrink: 0; font-family: ui-monospace, Consolas, monospace; }
.wf-l2 .wf-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-l2 .wf-cnt, .wf-l2 .wf-when { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.wf-badge { flex-shrink: 0; font-style: normal; padding: 0 5px; border-radius: 3px; font-size: 10px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.wf-badge.ok { background: #2b7a3d; }
.wf-badge.warnb { background: #7a4f2b; }
.wf-acts { position: absolute; right: 6px; top: 4px; display: none; gap: 1px; padding: 1px; border-radius: 4px; background: var(--vscode-sideBar-background, #1e1e1e); }
.wf-row:hover .wf-acts, .wf-row:focus-within .wf-acts { display: flex; }
.wf-acts button { background: transparent; border: 0; font: inherit; font-size: 12px; line-height: 1; padding: 2px 4px; border-radius: 3px; color: var(--vscode-icon-foreground, #c5c5c5); cursor: pointer; }
.wf-acts button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, .31)); }
.wf-acts button[aria-disabled="true"] { opacity: .5; }
.wf-fold { margin: 6px 10px 8px; border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, .35)); border-radius: 6px; padding: 5px 8px; }
.wf-fold > summary { cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
.wf-fold .canvas { max-height: 240px; }
.wf-foot { flex-shrink: 0; border-top: 1px solid var(--vscode-sideBar-border, rgba(128, 128, 128, .25)); padding: 3px 8px; }
.wf-foot > button { background: transparent; border: 0; font: inherit; font-size: 11px; padding: 1px 2px; cursor: pointer; color: var(--vscode-descriptionForeground, #999); }
.wf-foot > button:hover { color: var(--vscode-foreground, #ccc); }
.wf-foot-body { padding-top: 2px; }
.wf-foot-body .dsh-diag { padding: 1px 0; }
.canvas { overflow: auto; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; margin-top: 6px; }
.canvas svg .node rect { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-focusBorder, #007fd4); stroke-width: 1; }
.canvas svg .node .title { fill: var(--vscode-foreground, #ccc); font: 600 12px system-ui, sans-serif; }
.canvas svg .node .type { fill: var(--vscode-descriptionForeground, #999); font: 10px ui-monospace, monospace; }
.canvas svg .edge { fill: none; stroke: var(--vscode-descriptionForeground, #888); stroke-width: 1.4; }
.canvas svg .arrowHead { fill: var(--vscode-descriptionForeground, #888); }
`;

/** 简短日期（列表第二行用）：`09-16`；读不出就给空串（那一格只是装饰，不占位不报错）。 */
const shortOf = ms => {
	const iso = isoOf(ms);
	return iso === '未知' ? '' : iso.slice(5, 10);
};

/** 「待整理」的判据：空壳 **或** 有孤立节点（谁都没连）。两者都是**已经读出来的事实** ✓，不猜 ✓。 */
function tidyReasonOf(workflow) {
	if (workflow.empty) { return '空壳：没有节点图也没有线性步骤'; }
	const isolated = countIsolatedNodes(workflow);
	return isolated > 0 ? `${isolated} 个节点没有连线` : '';
}

/**
 * 工作流行（**两行**）—— 照原 `WorkflowViewPane` 的列表项形态（状态左边条 / 名称 + 徽章 / 元信息），
 * 换成插件页能用的 `.dsh-item` 骨架（样式在 `pageShell.js`）。
 *
 * 与上一版的差别（走 `doc/workflow-sideview-refactor-mockup.html` 的 A 稿）：
 *   · 原先把 category / author / visibility / version / tags / 会话 全拼成最多 4 行长文本 ⇒
 *     本机真机上这些字段**全是空的**（数据如此），那几行就退化成一串重复的「节点 x · 边 y · 更新 …」，
 *     在 330px 侧栏里还被 ellipsis 吃掉后半段 ✗ ⇒ 改为**两行**：L1 = 名称 + 状态徽章，
 *     L2 = id + 描述 + 「N 节点 · M 边」+ 日期；
 *   · 那四项（分类 / 作者 / 可见性 / 版本）**没丢** ✓：它们进了行的 `title`（悬停可见），
 *     需要常显时再单独设计（别靠猜它们的存在 ✓）。
 *
 * 机器可断言的锚点（p3-10）**一个都没动** ✓：`class="dsh-item wf-row"` / `data-open-id` /
 * `data-order`（补零串）/ `data-title` / `data-updated` / `role="button"`；新增的三个键是给**页内筛选**用
 * （`data-search` / `data-has-graph` / `data-active` / `data-warn`）—— 与 kb 页「服务端带键、页内重排」同一套做法 ✓。
 */
function workflowRow(workflow, order) {
	const nodeCount = workflow.nodes.length;
	const edgeCount = workflow.edges.length;
	const tidy = tidyReasonOf(workflow);
	const meta = [workflow.category, workflow.author, workflow.visibility, workflow.version, workflow.tags.length ? workflow.tags.join(', ') : ''].filter(Boolean).join(' · ');
	const sessionLine = workflow.sessionCount !== undefined
		? ` · 会话 ${workflow.sessionCount}${workflow.sessions?.runs !== undefined ? `（共跑 ${workflow.sessions.runs} 次）` : ''}${workflow.sessions?.latestName ? `，最近「${workflow.sessions.latestName}」` : ''}`
		: '';
	// 排序键（页内排序用，零新 API）：order 是**服务端给的索引顺序**（补零串 ⇒ 字符串比较＝数值比较，
	// 也是"切回索引顺序"的复原键）；title 小写；updated 是数值时间戳（缺就给空串，排序时沉底）。
	const updated = Number(workflow.updatedAt);
	const updateKey = Number.isFinite(updated) ? String(updated) : '';
	const searchKey = [workflow.name, workflow.id, workflow.description, meta].filter(Boolean).join(' ').toLowerCase();
	const hover = [`更新 ${isoOf(workflow.updatedAt)}`, sessionLine.replace(/^ · /, ''), meta, tidy].filter(Boolean).join(' · ');
	return `<div class="dsh-item wf-row${workflow.isActive ? ' wf-active' : ''}${tidy ? ' wf-warn' : ''}${workflow.empty ? ' wf-cold' : ''}" data-open-id="${escapeHtml(String(workflow.id ?? ''))}" data-order="${String(order).padStart(4, '0')}" data-title="${escapeHtml(String(workflow.name ?? '').toLowerCase())}" data-updated="${updateKey}" data-search="${escapeHtml(searchKey)}" data-has-graph="${nodeCount > 0 ? '1' : '0'}" data-active="${workflow.isActive ? '1' : '0'}" data-warn="${tidy ? '1' : '0'}" role="button" tabindex="0" title="点击：在编辑器区打开画布${hover ? ` ｜ ${escapeHtml(hover)}` : ''}">
	<div class="dsh-item-content">
		<div class="wf-l1"><span class="wf-name">${escapeHtml(workflow.name)}</span>${workflow.isActive ? '<em class="wf-badge ok">运行中</em>' : ''}${tidy ? `<em class="wf-badge warnb">待整理</em>` : ''}</div>
		<div class="wf-l2"><code class="wf-id">${escapeHtml(workflow.id)}</code><span class="wf-desc">${workflow.description ? escapeHtml(workflow.description) : '（无描述）'}</span><span class="wf-cnt">${nodeCount} 节点 · ${edgeCount} 边</span><span class="wf-when">${shortOf(workflow.updatedAt)}</span></div>
	</div>
	<div class="wf-acts">
		<button type="button" data-wf-act="open" title="在编辑器区打开画布">⧉</button>
		<button type="button" data-wf-act="run" title="执行（dsh 引擎跑这条工作流，结果写进轨迹）">▶</button>
		<button type="button" data-wf-act="export" aria-disabled="true" title="导出 JSON —— 未迁到 Host（选文件对话框是 IDE 能力，要新的反向通道 capability）">⤓</button>
		<button type="button" data-wf-act="delete" aria-disabled="true" title="删除 —— 未迁到 Host（需要一个新 Host 工具 + 审批闸）">🗑</button>
	</div>
</div>`;
}

/**
 * 页内交互（与看板页同一套做法）：点条目 → 在编辑器区打开这张工作流的画布。
 *
 * 走宿主路由 /x/workflow/api/open，由插件经**反向通道**请求 IDE 能力 workflow（清单里已声明才有授权）。
 * 成功/失败都写进一行提示：失败把 IDE / 主进程给的原因原样显示，不静默。
 *
 * A 稿新增的三件事（都是**页内行为**，零新 API ✓）：
 *   ① 搜索 + chips 筛选 + 排序：三者共用一个 `apply()` —— **筛选与重排必须一起做** ✓
 *      （分两个函数时，先筛后排序很容易出现"结果看着对、其实只排了可见的一部分"✗）；
 *   ② 自诊断折叠：默认收起（那两行是给开发/探针看的 ✓，锚点仍在 HTML 里 ⇒ 探针照读 ✓）；
 *   ③ **未迁到 Host 的入口点了给原因**（`＋` 新建 / `⤓` 导出 / `🗑` 删除）——
 *      比一个静默的死按钮有用 ✓；绝不假装成功 ✗。
 *
 * ⚠ 本文件是**模板字符串**：注释里一律不许出现反引号 ✗（会提前闭合整页），也不要用 `${` ✗
 *   （那是外层模板的插值语法）—— 拼接一律用 `+`。
 */
const WORKFLOW_SCRIPT = `
(function () {
	var root = document.querySelector('[data-vssaros-page="workflow"]');
	if (!root) { return; }
	var flash = root.querySelector('[data-wf-flash]');
	function say(text, isError) {
		if (!flash) { return; }
		flash.style.color = isError ? 'var(--vscode-errorForeground, #f48771)' : '';
		flash.textContent = text;
	}
	function open(id) {
		say('正在在画布里打开：' + id + ' …', false);
		fetch('/x/workflow/api/open?id=' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
			.then(function (res) { return res.json().then(function (body) { return { ok: res.ok && body && body.ok, body: body }; }); })
			.then(function (out) {
				if (out.ok) { say('已在画布里打开：' + id, false); }
				else { say('打开失败：' + String((out.body && out.body.error) || '未知原因'), true); }
			})
			.catch(function (err) { say('打开失败：' + String(err && err.message ? err.message : err), true); });
	}
	// 重构 3.2：执行入口（dsh 引擎跑这条工作流，结果写进轨迹）。
	function run(id) {
		say('正在执行：' + id + ' …（dsh 引擎，结果写进轨迹）', false);
		fetch('/x/workflow/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: id }) })
			.then(function (res) { return res.json().then(function (body) { return { ok: res.ok && body && body.ok, body: body }; }); })
			.then(function (out) {
				if (out.ok) { say('执行完成：' + id + '（' + String((out.body && out.body.executionId) || '') + '）', false); }
				else { say('执行失败：' + String((out.body && out.body.error) || '未知原因'), true); }
			})
			.catch(function (err) { say('执行失败：' + String(err && err.message ? err.message : err), true); });
	}
	// 未迁到 Host 的写出入口：点了**说清原因**（不是静默失败，也不是假装成功）。
	function notMigrated(what, why) { say(what + '还没迁到 Host：' + why, true); }
	var list = root.querySelector('[data-wf-list]');
	var search = root.querySelector('[data-wf-search]');
	var sortSelect = root.querySelector('[data-sort-select]');
	var none = root.querySelector('[data-wf-none]');
	var shown = root.querySelector('[data-wf-shown]');
	var chip = 'all';
	function rowsInList() {
		if (!list) { return []; }
		return Array.prototype.slice.call(list.children).filter(function (child) {
			return child.hasAttribute && child.hasAttribute('data-open-id');
		});
	}
	// 筛选 + 排序共用一处（顺序：先判可见、再对可见项排序并回插）——
	// 排序键**服务端就带上**（order 补零串 / title 小写 / updated 时间戳），与 kb 页同一套做法。
	function apply() {
		var query = search ? String(search.value || '').trim().toLowerCase() : '';
		var mode = sortSelect ? String(sortSelect.value || 'order') : 'order';
		var key = mode === 'order' ? 'data-order' : (mode.indexOf('title') === 0 ? 'data-title' : 'data-updated');
		var numeric = key === 'data-updated';
		var desc = mode === 'updated-desc' || mode === 'title-desc';
		var all = rowsInList();
		all.forEach(function (row) {
			var hitQuery = !query || String(row.getAttribute('data-search') || '').indexOf(query) >= 0;
			var hitChip = chip === 'all'
				|| (chip === 'graph' && row.getAttribute('data-has-graph') === '1')
				|| (chip === 'active' && row.getAttribute('data-active') === '1')
				|| (chip === 'warn' && row.getAttribute('data-warn') === '1');
			row.hidden = !(hitQuery && hitChip);
		});
		var visible = all.filter(function (row) { return !row.hidden; });
		visible.sort(function (a, b) {
			var av = String(a.getAttribute(key) || '');
			var bv = String(b.getAttribute(key) || '');
			if (!av && bv) { return 1; }
			if (av && !bv) { return -1; }
			if (numeric) { return (Number(av) || 0) - (Number(bv) || 0); }
			return av.localeCompare(bv, 'zh', { numeric: true });
		});
		if (desc) { visible.reverse(); }
		visible.forEach(function (row) { list.appendChild(row); });
		if (none) { none.hidden = visible.length > 0 || all.length === 0; }
		if (shown) { shown.textContent = visible.length === all.length ? String(all.length) : String(visible.length) + '/' + String(all.length); }
	}
	if (search) { search.addEventListener('input', apply); }
	if (sortSelect) { sortSelect.addEventListener('change', apply); }
	Array.prototype.slice.call(root.querySelectorAll('[data-chip]')).forEach(function (button) {
		button.addEventListener('click', function () {
			chip = String(button.getAttribute('data-chip') || 'all');
			Array.prototype.slice.call(root.querySelectorAll('[data-chip]')).forEach(function (other) {
				other.classList.toggle('active', other === button);
			});
			apply();
		});
	});
	var diagButton = root.querySelector('[data-wf-diag]');
	var diagBody = root.querySelector('[data-wf-diag-body]');
	if (diagButton && diagBody) {
		diagButton.addEventListener('click', function () {
			diagBody.hidden = !diagBody.hidden;
			diagButton.textContent = diagBody.hidden ? '⚙ 自诊断' : '⚙ 自诊断（收起）';
		});
	}
	var newButton = root.querySelector('[data-wf-new]');
	if (newButton) {
		newButton.addEventListener('click', function () {
			notMigrated('新建工作流', 'IDE 侧由 WorkflowViewPane 建（会同时盖 presetId / agentId / workspaceId），Host 侧现在只有 workflow_apply 的写盘能力，页面还没有表单路由。');
		});
	}
	Array.prototype.slice.call(root.querySelectorAll('[data-open-id]')).forEach(function (row) {
		var id = String(row.getAttribute('data-open-id') || '');
		Array.prototype.slice.call(row.querySelectorAll('[data-wf-act]')).forEach(function (button) {
			button.addEventListener('click', function (event) {
				event.stopPropagation();   // 别让动作按钮连带触发"打开画布" ✗
				var act = String(button.getAttribute('data-wf-act') || '');
				if (act === 'open') { open(id); return; }
				if (act === 'run') { run(id); return; }
				if (act === 'export') { notMigrated('导出', '选文件对话框是 IDE 能力，需要新的反向通道 capability。'); return; }
				notMigrated('删除', '需要一个新 Host 工具 + 审批闸（现在 store.js 只有 list / read / mutate / apply）。');
			});
		});
		row.addEventListener('click', function () { if (id) { open(id); } });
		row.addEventListener('keydown', function (event) {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				if (id) { open(id); }
			}
		});
	});
	apply();
})();
`;

/**
 * 页面数据（**SSR 页与 React 工作台共用**，2026-10-22）。
 *
 * 为什么共用：两个界面各自取数 ⇒ 迟早分叉（数字对不上、筛选口径不同、画布选中的不是同一个）✗。
 * ⇒ 这里一处取数，SSR 走 `renderPage`，React 走 `GET /api/page` ✓。
 *
 * @param config 配置
 * @param state  插件状态（读已注册的工具名）
 * @param wantedId 指定要看哪条工作流的画布（`?id=`）；不给 ⇒ 选节点最多的那条（与旧页一致 ✓）
 */
async function collectPageData(config, state, wantedId) {
	const data = await listWorkflows(config, { limit: 200 });
	const summary = summarizeWorkflows(data.workflows);
	// 选画布目标：`?id=` 指定的，否则节点最多的那个
	const selected = (wantedId ? summary.sorted.find(w => w.id === wantedId) : undefined)
		?? [...summary.sorted].sort((a, b) => b.nodes.length - a.nodes.length)[0];
	const canvas = selected
		? renderSvgCanvas({ ...selected, nodes: selected.nodes.slice(0, CANVAS_NODE_LIMIT) })
		: { svg: '', width: 0, height: 0, dangling: 0 };
	// 页面用**缓存过的**自证结果（TTL 30s，见文件头 `probeWorkerCached`）：起 worker 是重活，
	// 而它只是页面上的一个事实栏 ✓；"现在到底行不行"由 `workflow_engine_status` 工具现跑回答 ✓。
	const worker = await probeWorkerCached();
	const toolsRegistered = TOOL_NAMES.filter(tool => !!state.tools?.get(tool)).join(',') || '(未注册)';
	return {
		data,
		summary,
		selected: selected ? { id: selected.id, name: selected.name, nodes: selected.nodes.length, edges: selected.edges.length } : null,
		canvas,
		worker,
		toolsRegistered,
		rows: summary.sorted.map((workflow, index) => workflowRowData(workflow, index)),
	};
}

/**
 * 一条工作流的**行数据**（React 工作台与 JSON 接口的载荷；与旧页的行字段一一对应 ✓）。
 *
 * 排序键（`order` / `title` / `updated`）在服务端算好 —— 页内排序不再读 DOM 属性 ✓（旧页那样做是因为
 * 它只有 HTML；React 侧直接排数组 ✓）。`search` 是小写后的可搜索串（与旧页 `data-search` 同口径 ✓）。
 */
function workflowRowData(workflow, index) {
	const nodeCount = Array.isArray(workflow.nodes) ? workflow.nodes.length : 0;
	const edgeCount = Array.isArray(workflow.edges) ? workflow.edges.length : 0;
	const tidy = tidyReasonOf(workflow);
	const meta = [workflow.category, workflow.author, workflow.visibility, workflow.version, workflow.tags?.length ? workflow.tags.join(', ') : ''].filter(Boolean).join(' · ');
	const updated = Number(workflow.updatedAt);
	const updateKey = Number.isFinite(updated) ? String(updated) : '';
	return {
		id: String(workflow.id ?? ''),
		name: String(workflow.name ?? ''),
		description: String(workflow.description ?? ''),
		meta,
		tidy,
		isActive: !!workflow.isActive,
		empty: !!workflow.empty,
		hasGraph: nodeCount > 0,
		nodeCount,
		edgeCount,
		updatedAt: workflow.updatedAt ?? null,
		updatedText: shortOf(workflow.updatedAt),
		updatedIso: isoOf(workflow.updatedAt),
		sessionCount: workflow.sessionCount,
		sessionRuns: workflow.sessions?.runs,
		sessionLatestName: workflow.sessions?.latestName,
		// 排序键（与旧页的 data-order / data-title / data-updated 同义 ✓）
		order: String(index).padStart(4, '0'),
		titleKey: String(workflow.name ?? '').toLowerCase(),
		updatedKey: updateKey,
		search: [workflow.name, workflow.id, workflow.description, meta].filter(Boolean).join(' ').toLowerCase(),
	};
}

/**
 * 服务端渲染的只读工作流页（**A 稿：紧凑列表**，见 `doc/workflow-sideview-refactor-mockup.html`）。
 *
 * 一句话：**列表是这个侧栏的本职** —— 画布让位（它 1522px 宽，330px 的侧栏里只看得到左上角），
 * 自证信息折进页脚、默认收起，列表升到首屏、加上搜索 / 筛选 / 排序。
 *
 * 与上一版（画布分区在上 + 平铺长行 + 常驻两行自证）的差别：见各段注释与 mockup §1 的六个问题。
 *
 * ⚠ 机器可断言的锚点与文案**一个都没动**（`p3-10` 按它们取数）：
 *   · `data-vssaros-workflow-{count,active,nodes,root,tools,workers,worker-thread,worker-detail}` ✓
 *     —— 折进「自诊断」折叠区，但**仍在 HTML 里** ✓（探针读文本，不读可见性 ✓）；
 *   · 文案「未迁引擎」那句 ✓（改写进自诊断区，四个字保留 ✓）；
 *   · **画布与 `N 节点 / M 边`** ✓ —— 收进页尾的**折叠区**：探针要页面里有 `<svg>` +
 *     `class="node"/"edge"` + `marker-end="url(#arrow)"`，所以画布**不能从页面里删掉** ✗，
 *     只能"不占首屏、默认不展开"✓（顺带也是没有 IDE 桥时唯一能看图的地方 ✓）；
 *   · 每行的 `class="dsh-item wf-row"` / `data-open-id` / `data-order` / `data-title` / `data-updated` /
 *     `role="button"` 与脚本里的 `/x/workflow/api/open` ✓；
 *   · 排序仍是 `<select data-sort-select>` + 五个 `<option value=…>` ✓（**不许**换成自定义菜单 ✗）。
 *
 * ⚠ **写路径仍缺席**（新建 / 导入 / 删除 / 拖拽排序 / 置顶 / 运行）—— 本插件是**只读切片**：
 * 那几件事在 VsSaros 侧由 `WorkflowViewPane` + `IWorkflowStorageService` 做（引擎也还没迁）。
 * 页面上那三个入口（`＋` / `⤓` / `🗑`）**点了给原因** ✓，不假装成功 ✗（mockup §3 把缺口的落点列全了）。
 */
function renderPage({ data, config, toolsRegistered, worker, selected, canvas }) {
	const { summary, errors, root, missing } = data;
	const rows = summary.sorted.map((workflow, index) => workflowRow(workflow, index)).join('');
	const edgeTotal = summary.sorted.reduce((sum, workflow) => sum + workflow.edges.length, 0);
	const tidyCount = summary.sorted.filter(workflow => !!tidyReasonOf(workflow)).length;
	const errorsHtml = errors.length
		? `<p class="dsh-diag">${errors.length} 项读不了：${escapeHtml(errors.slice(0, 3).join('；'))}${errors.length > 3 ? ' …' : ''}</p>`
		: '';
	// 画布（页尾折叠区）：默认收起 ⇒ 不占首屏；`?id=` 仍可指定要看哪一张 ✓。
	const canvasSummary = selected ? `${selected.nodes.length} 节点 / ${selected.edges.length} 边` : '（还没有工作流）';
	const canvasHtml = selected
		? (canvas.width
			? `<p class="dsh-diag">画布：<code>${escapeHtml(selected.id)}</code> · ${selected.nodes.length} 节点 / ${selected.edges.length} 边${canvas.dangling ? `（${canvas.dangling} 条边指向图外节点，未画）` : ''}${selected.nodes.length > CANVAS_NODE_LIMIT ? ` · 只画前 ${CANVAS_NODE_LIMIT} 个节点` : ''}（服务端 SVG，v0 · 由「${escapeHtml(selected.name)}」自动选中：节点最多的一张）</p><div class="canvas">${canvas.svg}</div>`
			: '<p class="dsh-empty">这个工作流没有节点图（可能只有线性步骤）。</p>')
		: '<p class="dsh-empty">还没有工作流可画。</p>';
	const workerHtml = worker.ok
		? `可用（threadId ${worker.threadId} · 回显 ${escapeHtml(worker.echo)} · ${worker.ms}ms）`
		: `不可用：${escapeHtml(worker.error ?? '未知原因')}`;
	const diag = `<p class="dsh-diag" data-vssaros-workflow-count="${summary.count}" data-vssaros-workflow-active="${summary.active}" data-vssaros-workflow-nodes="${summary.nodes}" data-vssaros-workflow-root="${escapeHtml(root)}" data-vssaros-workflow-tools="${escapeHtml(toolsRegistered)}" data-vssaros-workflow-workers="${worker.ok ? 'ok' : 'fail'}" data-vssaros-workflow-worker-thread="${worker.threadId ?? ''}">根目录 <code>${escapeHtml(root)}</code> · 工具 <code>${escapeHtml(toolsRegistered)}</code></p>`;
	const workerDiag = `<p class="dsh-diag" data-vssaros-workflow-worker-detail="${escapeHtml(workerHtml)}">Host worker_threads：${workerHtml}<br><small>这条是引擎迁移的前提：引擎要从渲染进程 worker 迁到 Host worker_threads（本版只做只读 + 自证，未迁引擎）。</small></p>`;
	const notices = `${missing ? `<p class="dsh-empty">工作流根目录还不存在：<code>${escapeHtml(missing)}</code></p>` : ''}${errorsHtml}`;
	// 排序（零新 API，与 kb 页同一套做法）：索引顺序（服务端给的原顺序）/ 更新时间 / 名称 ——
	// 维度全部取自已有字段。写类（新建 / 导入 / 删除 / 拖拽排序 / 置顶）**仍未迁**：没有 owns 交接，
	// 也没有跨进程锁（README 5.48），入口点了给原因。
	const sortOptions = [
		'<option value="order">索引顺序</option>',
		'<option value="updated-desc">更新时间（新→旧）</option>',
		'<option value="updated-asc">更新时间（旧→新）</option>',
		'<option value="title-asc">名称（A→Z）</option>',
		'<option value="title-desc">名称（Z→A）</option>',
	].join('');
	const listHtml = `<div class="wf-list" data-wf-list>${rows || '<p class="dsh-empty">还没有工作流。</p>'}</div>`;
	const chipsHtml = renderChips([
		{ value: 'all', label: `全部 ${summary.count}`, active: true },
		{ value: 'graph', label: `有图 ${summary.withGraph}` },
		{ value: 'active', label: `运行中 ${summary.active}` },
		{ value: 'warn', label: `待整理 ${tidyCount}` },
	]);
	return renderShell({
		kind: 'workflow',
		title: 'Workflow',
		subtitle: `${summary.count} 个工作流 · 只读`,
		headerHtml: `<div class="dsh-header"><h1>Workflow <small>${summary.count} 个 · 只读</small><span class="wf-grow"></span><a class="dsh-link" href="./" title="刷新（重新读盘）">⟳</a><button class="wf-new" type="button" data-wf-new title="新建工作流 —— 未迁到 Host（点了说明原因）">＋</button></h1><div class="wf-stat"><span>已显示 <b data-wf-shown>${summary.count}</b> 个</span><span>·</span><span><b>${summary.nodes}</b> 节点</span><span>·</span><span><b>${edgeTotal}</b> 边</span><span>·</span><span>运行中 <b>${summary.active}</b></span><span>·</span><span>待整理 <b>${tidyCount}</b></span></div></div>
<div class="dsh-search"><span class="dsh-search-icon" aria-hidden="true">⌕</span><input type="search" data-wf-search placeholder="搜索名称 / id / 描述" aria-label="搜索工作流"><select data-sort-select aria-label="排序">${sortOptions}</select></div>`,
		chipsHtml,
		bodyHtml: `<div class="dsh-scroll">${notices}${listHtml}<p class="dsh-empty" data-wf-none hidden>没有匹配的工作流：清空搜索，或把筛选切回「全部」。</p>
<details class="wf-fold"><summary>画布预览 <small>服务端 SVG（v0）· ${canvasSummary}</small></summary>${canvasHtml}</details></div>
<div class="wf-foot"><button type="button" data-wf-diag>⚙ 自诊断</button><div class="wf-foot-body" data-wf-diag-body hidden>${diag}${workerDiag}<p class="dsh-diag"><small>写类（新建 / 导入 / 删除 / 拖拽排序 / 置顶）仍未迁引擎：IDE 侧由 WorkflowViewPane 做，Host 侧只有 list / read / mutate / apply 四个写读工具。</small></p></div><p class="dsh-diag" data-wf-flash></p></div>`,
		extraCss: PAGE_CSS,
		script: WORKFLOW_SCRIPT,
	});
}

function toolDefinitions(ctx, state, config) {
	return [{
		// ── 结构改写（报告 §R.7 第 ④ 项里先落地的那一个 ✓）─────────────────────────────────────
		// 与 `workflow_update` 的分工 ✓：那个只改**元信息**（name/description/tags ✓）、**刻意不碰节点图** ✓；
		// 这个补上"**整份替换节点图 + 连线**"（照 IDE 真源 `workflowTools.ts` 的 `workflow_apply` ✓，
		// 它是 "create or replace" ✓）。两者都在 `WRITE_TOOLS` 里 ⇒ **都要过审批闸** ✓。
		// ⚠ 语义要点（都照真源 ✓，且都由 `store.js` 的 `normalizeApplyArgs` 强制 ✓）：
		//   · 必须有 Start 与 End 节点 ✓（缺一个引擎跑不起来 ⇒ 与其写完才发现，不如**先拒** ✓）；
		//   · `branch` / `condition` 归一成 `ifElse` ✓（真源原话：否则执行时退化成"走所有下游边" ✗）；
		//   · 节点内容（label/agentId/…）必须放在 `data` 里 ✓ —— 模型常写在顶层 ✗，本工具**自动挪进去** ✓；
		//   · 只替换 nodes/connections ✓，**其它元数据原样保留** ✓（tags/isActive/画布字段 ✗ 不能清掉）。
		name: 'workflow_apply',
		description: '用一整份节点图 + 连线**替换**一个工作流（可新建：id 不存在时创建 ✓）。'
			+ ' ⚠ 这是**结构性改动**：必须给**全部**节点与连线（含 Start 与 End，缺一个会被拒 ✓）；只想改名字/描述用 `workflow_update` ✓。'
			+ ' 节点格式：每个节点要 `{ id, type, position: { x, y }, data: { label, … } }` —— **内容字段必须放进 `data`**（放顶层会被自动挪进去，但别依赖它 ✓）。'
			+ ' 多端口节点（ifElse / switch / askUser）的连线要带 `fromPort`（`branch-0` / `option-0` 等 ✓）。'
			+ ' ⚠ 会写工作流定义文件 ⇒ **需要用户在审批里确认** ✓（被拒绝是正常的，不要反复重试 ✗）。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: '工作流 id（用 workflow_list 拿；不存在则新建）' },
				name: { type: 'string', description: '新名称（不传则保留原值 / 新建时用 id）' },
				description: { type: 'string', description: '新描述（不传则保留原值）' },
				nodes: {
					type: 'array',
					description: '全部节点（含 Start 与 End ✓）',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: '节点 id（唯一）' },
							type: { type: 'string', description: '节点类型（start / end / agent / ifElse …）' },
							position: {
								type: 'object',
								description: '画布坐标 { x, y }',
								properties: { x: { type: 'integer' }, y: { type: 'integer' } },
							},
							data: {
								type: 'object',
								description: '内容字段（至少要有 label；按类型还可有 agentId / prompt / agentConfig …）',
								properties: {
									label: { type: 'string', description: '节点显示名（必填）' },
									agentId: { type: 'string', description: 'agent 节点的 agent id' },
									prompt: { type: 'string', description: '该节点的提示词模板' },
									agentConfig: {
										type: 'object',
										description: 'agent 节点配置',
										properties: { modelId: { type: 'string' }, prompt: { type: 'string' } },
									},
								},
							},
						},
						required: ['id', 'type', 'position'],
					},
				},
				connections: {
					type: 'array',
					description: '全部连线（可为空数组）',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: '连线 id（唯一）' },
							from: { type: 'string', description: '起点节点 id' },
							to: { type: 'string', description: '终点节点 id' },
							fromPort: { type: 'string', description: '多端口节点必填（branch-0 / option-0 …）' },
						},
						required: ['id', 'from', 'to'],
					},
				},
			},
			required: ['id', 'nodes', 'connections'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					created: { type: 'boolean' },
					bytes: { type: 'integer' },
					attempts: { type: 'integer' },
					fixups: { type: 'array', items: { type: 'string' } },
				},
				required: ['id', 'created', 'bytes'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.created ? '已新建' : '已替换'}工作流 ${value.id}（${value.bytes} 字节；节点内容归一 ${value.fixups.length} 处${value.attempts > 1 ? `，重试 ${value.attempts} 次` : ''}）`,
			}],
		},
		// 写盘 ⇒ **不声明**可并行（与 workflow_update 同口径 ✓）
		execute: async (params) => {
			const id = typeof params?.id === 'string' ? params.id.trim() : '';
			if (!id) { throw new Error('id 不能为空（用 workflow_list 拿 id）。'); }
			const out = await applyWorkflow(config, id, {
				nodes: params?.nodes,
				connections: params?.connections,
				name: params?.name,
				description: params?.description,
			});
			return out.value;
		},
	}, {
		name: 'workflow_update',
		description: '改一个工作流的**元信息**（name / description / tags）—— 本模块**第一个写工具**：取锁 → 读 → 改 → 指纹 CAS → 原子写 → 释放（README 5.62）。'
			+ ' ⚠ 范围**刻意小**：只动这三个字段 ✓；节点图 / 边 / 会话索引**不碰**（那是画布编辑器与 IDE 服务的地盘 ✓）。传空串即清空该字段（`tags` 传空数组同理）。',
		parameters: {
			type: 'object',
			properties: {
				id: { type: 'string', description: '工作流 id（用 workflow_list 拿）' },
				name: { type: 'string', description: '新名称（不传则不改）' },
				description: { type: 'string', description: '新描述（不传则不改；传空串即清空）' },
				tags: { type: 'array', items: { type: 'string' }, description: '新标签（不传则不改；传空数组即清空）' },
			},
			required: ['id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					changed: { type: 'array', items: { type: 'string' } },
					attempts: { type: 'integer' },
					nodes: { type: 'integer' },
					edges: { type: 'integer' },
				},
				required: ['id', 'changed'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `已更新 ${value.id}：${(value.changed ?? []).join(' / ')}（CAS 重试 ${value.attempts} 次；节点 ${value.nodes} · 边 ${value.edges} 未动）`,
			}],
		},
		execute: async params => {
			const id = typeof params?.id === 'string' ? params.id.trim() : '';
			if (!id) {
				throw new Error('id 不能为空');
			}
			const result = await mutateWorkflow(config, id, (_workflow, raw) => {
				// ⚠ 在 **raw 的 JSON 对象**上改（不是在我们摘要出来的 `workflow` 上）⇒ 未知字段原样保留 ✓
				let data;
				try {
					data = JSON.parse(raw);
				} catch (e) {
					throw new Error(`workflow.json 不是合法 JSON：${e?.message ?? e}`);
				}
				if (!data || typeof data !== 'object' || Array.isArray(data)) {
					throw new Error('workflow.json 顶层不是对象');
				}
				const changed = [];
				if (typeof params.name === 'string') { data.name = params.name; changed.push('name'); }
				if (typeof params.description === 'string') { data.description = params.description; changed.push('description'); }
				if (Array.isArray(params.tags)) {
					data.tags = params.tags.filter(tag => typeof tag === 'string' && tag.trim());
					changed.push('tags');
				}
				if (!changed.length) {
					throw new Error('没有要改的字段：给 name / description / tags 之一');
				}
				data.updatedAt = Date.now();
				return {
					// 缩进风格与 IDE 侧一致（`workflowStorageService.ts:327` 也是 `JSON.stringify(x, null, 2)` ✓）
					text: JSON.stringify(data, null, 2),
					value: {
						changed,
						nodes: Array.isArray(data.nodes) ? data.nodes.length : 0,
						edges: Array.isArray(data.edges) ? data.edges.length : 0,
					},
				};
			});
			return { id, ...result.value, attempts: result.attempts };
		},
	}, {
		name: 'workflow_list',
		description: '列出 VsSaros 工作流（名称、节点/边数量、跑过的会话数、分类与作者等），只读。',
		parameters: {
			type: 'object',
			properties: { limit: { type: 'integer', description: '返回条数上限，1–200（默认 50；超出会被夹到边界）' } },
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					count: { type: 'integer' }, active: { type: 'integer' }, nodes: { type: 'integer' },
					workflows: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' }, name: { type: 'string' }, nodes: { type: 'integer' },
								edges: { type: 'integer' }, isActive: { type: 'boolean' }, category: { type: 'string' },
								// 会话语义（README 5.116）：description 里**早就承诺**了"跑过的会话数" ✓，
								// 而白名单与 schema 里**从来没有它** ✗ ⇒ 承诺了但没实现 ✓（p3-10 的两侧断言逮出来的 ✓）。
								sessionCount: { type: 'integer' }, sessionRuns: { type: 'integer' },
								sessionLatestName: { type: 'string' }, sessionLatestAt: { type: 'string' },
							},
							required: ['id', 'name', 'nodes', 'edges'],
						},
					},
				},
				required: ['count', 'workflows'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count
					? `${value.count} 个工作流（运行中 ${value.active}）：\n${value.workflows.map(w => `- ${w.name}（${w.id}）：${w.nodes} 节点 / ${w.edges} 边${w.isActive ? ' · 运行中' : ''}${w.sessionCount !== undefined ? ` · 会话 ${w.sessionCount}${w.sessionRuns !== undefined ? `（共跑 ${w.sessionRuns} 次）` : ''}${w.sessionLatestName ? `，最近「${w.sessionLatestName}」` : ''}` : ''}`).join('\n')}`
					: '没有工作流。',
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const limit = Math.min(200, Math.max(1, Number.isFinite(params?.limit) ? Math.floor(params.limit) : 50));
			const { workflows, errors } = await listWorkflows(config, { limit });
			const summary = summarizeWorkflows(workflows);
			return {
				count: summary.count,
				active: summary.active,
				nodes: summary.nodes,
				...(errors.length ? { errors } : {}),
				workflows: summary.sorted.map(workflow => Object.fromEntries(Object.entries({
					id: workflow.id,
					name: workflow.name,
					nodes: workflow.nodes.length,
					edges: workflow.edges.length,
					isActive: workflow.isActive,
					category: workflow.category,
					updatedAt: workflow.updatedAt,
					// 会话语义（README 5.116）：`sessionCount` 此前**不在白名单里** ✗ ⇒ 即使 store 读出来了，
					// 列表输出也看不见它 ✓（description 却早就承诺了"跑过的会话数" ✓ —— 承诺与实现分叉 ✗）。
					// 语义三项同理：**读不出来就是 undefined ⇒ 被下面的 filter 去掉** ✓（不猜字段名 ✓）。
					sessionCount: workflow.sessionCount,
					sessionRuns: workflow.sessions?.runs,
					sessionLatestName: workflow.sessions?.latestName,
					sessionLatestAt: workflow.sessions?.latestRunAt,
				}).filter(([, value]) => value !== undefined))),
			};
		},
	}, {
		name: 'workflow_get',
		description: '读一个工作流的节点图与连接（只读）。用 workflow_list 得到的 id。',
		parameters: {
			type: 'object',
			properties: { id: { type: 'string', description: '工作流 id，如 wf-dynamic-emoji' } },
			required: ['id'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
					nodes: { type: 'integer' }, edges: { type: 'integer' }, steps: { type: 'integer' },
					danglingEdges: { type: 'integer' }, sessionCount: { type: 'integer' },
					// 会话语义（README 5.116）：**扁平可选字段** ✓ —— 受限 schema 里别用嵌套对象
					//（`additionalProperties` 只能是布尔，写错的表现是**整个插件不挂载** ✗，上面那段注释有先例 ✓）
					sessionRuns: { type: 'integer' }, sessionLatestName: { type: 'string' }, sessionLatestAt: { type: 'string' },
					// ⚠️ 受限子集里 `additionalProperties` 只能是**布尔**（不能是 schema）：
					// 写成 `{ type: 'object', additionalProperties: { type: 'integer' } }` 会抛
					// `unsupported JSON schema: … additionalProperties must be a boolean`，
					// 而表现同样是**整个插件不挂载**（真机 404）。所以用「键值对数组」表达映射。
					nodeTypes: {
						type: 'array',
						items: {
							type: 'object',
							properties: { type: { type: 'string' }, count: { type: 'integer' } },
							required: ['type', 'count'],
						},
					},
					nodeNames: { type: 'array', items: { type: 'string' } },
					// ★ 2026-10-20：**节点内容**（`data` —— prompt / branches / allowTools / agentId …）。
					//   只给名字时模型没法改工作流（改 `workflow_apply` 要复述整份定义 ⇒ 看不到 prompt 就只能编 ✗）。
					//   ⚠ 受限 schema 下不能塞任意对象（`additionalProperties` 只能布尔）⇒ `data` 用**截断后的
					//   JSON 文本**（`dataJson`）表达 ✓，纯标量字段不会撑爆 schema。
					nodeDetails: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' }, dataJson: { type: 'string' },
							},
							required: ['id'],
						},
					},
					nodeDetailsTruncated: { type: 'boolean' },
				},
				required: ['id', 'nodes', 'edges'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `${value.name}（${value.id}）：${value.nodes} 节点 / ${value.edges} 边${value.steps > 0 ? ` / ${value.steps} 线性步骤` : ''}\n`
					+ `节点类型：${(value.nodeTypes ?? []).map(entry => `${entry.type}×${entry.count}`).join(', ') || '未知'}\n`
					+ `节点：${(value.nodeNames ?? []).join(', ')}`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const id = typeof params?.id === 'string' ? params.id.trim() : '';
			if (!id || /[\\/]|\.\./.test(id)) {
				throw new Error(`id 形态不合法：${id || '(空)'}`);
			}
			const result = await readWorkflow(config, id);
			if (result.error) {
				throw new Error(result.error);
			}
			const workflow = result.workflow;
			const nodeIds = new Set(workflow.nodes.map(node => node.id));
			const typeCounts = new Map();
			for (const node of workflow.nodes) {
				const key = node.type ?? '(未声明 type)';
				typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
			}
			const nodeTypes = [...typeCounts.entries()]
				.map(([type, count]) => ({ type, count }))
				.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
			// 节点内容：从**原文**读（`workflow` 是压扁投影，没有 data ✓）；读不到就不出现（不编造 ✗）。
			let nodeDetails = [];
			let nodeDetailsTruncated = false;
			try {
				const raw = await readRawWorkflow(workflow.dir);
				const budget = { left: NODE_DETAILS_BUDGET };
				nodeDetails = raw.nodes.slice(0, NODE_DETAILS_LIMIT).map(node => {
					const dataJson = node?.data === undefined ? '' : clipJson(node.data, NODE_DATA_LIMIT);
					if (dataJson.length > budget.left) {
						nodeDetailsTruncated = true;
						return { id: String(node?.id ?? ''), ...(node?.type ? { type: String(node.type) } : {}) };
					}
					budget.left -= dataJson.length;
					return {
						id: String(node?.id ?? ''),
						...(node?.type ? { type: String(node.type) } : {}),
						...(typeof node?.name === 'string' && node.name ? { name: node.name } : {}),
						...(dataJson ? { dataJson } : {}),
					};
				});
				if (raw.nodes.length > NODE_DETAILS_LIMIT) { nodeDetailsTruncated = true; }
			} catch { nodeDetails = []; }
			return {
				id: workflow.id,
				name: workflow.name,
				nodes: workflow.nodes.length,
				edges: workflow.edges.length,
				...(workflow.description ? { description: workflow.description } : {}),
				...(workflow.steps >= 0 ? { steps: workflow.steps } : {}),
				danglingEdges: workflow.edges.filter(edge => !nodeIds.has(edge.from) || !nodeIds.has(edge.to)).length,
				...(workflow.sessionCount !== undefined ? { sessionCount: workflow.sessionCount } : {}),
				// 会话语义（README 5.116）：**读不出来就不出现** ✓（形态不认识 ⇒ 只有 sessionCount ✓，
				// 与旧行为一致 ✓ —— 这是"不猜字段名"那条纪律的保留 ✓，不是被删掉 ✗）
				...(workflow.sessions?.runs !== undefined ? { sessionRuns: workflow.sessions.runs } : {}),
				...(workflow.sessions?.latestName ? { sessionLatestName: workflow.sessions.latestName } : {}),
				...(workflow.sessions?.latestRunAt ? { sessionLatestAt: workflow.sessions.latestRunAt } : {}),
				nodeTypes,
				nodeNames: workflow.nodes.map(node => node.name).slice(0, 40),
				...(nodeDetails.length > 0 ? { nodeDetails } : {}),
				...(nodeDetailsTruncated ? { nodeDetailsTruncated: true } : {}),
			};
		},
	}, {
		// ── workflow_get_schema（§R.7 第 ④ 项的**最后一项**）────────────────────────────────────
		// 真源：IDE `workflowTools.ts` 的 `workflow_get_schema` ✓ —— 一半是静态节点目录 ✓，
		// 另一半（**值钱的那半**）是**在线 agent 列表** ✓（`agent` 节点的 `data.agentId` 必须是其中之一 ✓，
		// 真源原话 "agentId MUST be one of …" ✓）。
		// ⚠ **三处故意不照抄**（都是"照抄会教错／会漂移"的地方 ✓）：
		//   ① 真源把 `branch` 当**真名**宣称 ✗，而我们写侧会把它归一成 `ifElse` ✓ ⇒ 我们宣称真名 + 单列别名 ✓；
		//   ② 目录里的**规范性**内容（别名 / 顶层元键 / 必带 Start+End）全部**从写侧常量推导** ✓ ——
		//      文档与实现"两份各自写"就是漂移的来源 ✗，这里让它们只有**一个**来源 ✓；
		//   ③ agents 从**盘上**读（`<数据根>/agents/*/.agent.md` ✓），不依赖任何服务 ✓。
		name: 'workflow_get_schema',
		description: '读**工作流节点类型的目录**与**本机可用 agent 列表**（只读）。'
			+ ' 建/改工作流**之前**先看它：① 有哪些已知节点类型、各自要注意什么（多端口节点的 `fromPort` 怎么写 ✓、'
			+ '内容字段为什么必须放进 `data` ✓）；② `agent` 节点的 `data.agentId` 能填哪些 id ✓（本工具最值钱的一半 ✓）。'
			+ ' ⚠ 目录只列**已知**类型，写侧对未知类型不改也不拦 ✗ ⇒ 用没列出的类型前先确认引擎认它 ✓。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: {
					nodeTypes: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								type: { type: 'string' }, label: { type: 'string' }, doc: { type: 'string' },
								usesAgentId: { type: 'boolean' }, ports: { type: 'array', items: { type: 'string' } },
							},
							required: ['type', 'label', 'doc'],
						},
					},
					aliases: {
						type: 'array',
						items: { type: 'object', properties: { alias: { type: 'string' }, type: { type: 'string' } }, required: ['alias', 'type'] },
					},
					metaKeys: { type: 'array', items: { type: 'string' } },
					requiredNodeTypes: { type: 'array', items: { type: 'string' } },
					dataFieldRule: { type: 'string' },
					positionHint: { type: 'string' },
					availableAgents: {
						type: 'array',
						items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, model: { type: 'string' } }, required: ['id'] },
					},
					agentErrors: { type: 'array', items: { type: 'string' } },
					agentsRoot: { type: 'string' },
					agentsMissing: { type: 'string' },
					notes: { type: 'array', items: { type: 'string' } },
				},
				required: ['nodeTypes', 'availableAgents'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `工作流节点类型（${value.nodeTypes.length} 个）：${value.nodeTypes.map(t => t.type).join(', ')}`
					+ `\n别名（进库前自动归一）：${(value.aliases ?? []).map(a => `${a.alias}→${a.type}`).join('、') || '（无）'}`
					+ `\n必带节点：${(value.requiredNodeTypes ?? []).join(' + ')}`
					+ `\n可用 agent（${value.availableAgents.length} 个）：${value.availableAgents.map(a => `${a.name ?? a.id}(${a.id})`).join('、') || '(no agents available — ask the user to create one first)'}`
					+ ((value.agentErrors ?? []).length ? `\n${value.agentErrors.slice(0, 3).join('；')}` : '')
					+ (value.agentsMissing ? `\n⚠ 没读到 agent 目录：${value.agentsMissing}` : ''),
			}],
		},
		isConcurrencySafe: () => true,
		execute: async () => {
			const { agents, errors, root, missing } = await listAgents(config);
			const value = buildSchema({
				agents,
				agentErrors: errors,
				// ★ 规范性内容**从写侧常量来** ✓（不是我在 catalog 里手抄一份 ✗）
				enforced: { aliases: NODE_TYPE_ALIASES, metaKeys: [...NODE_META_KEYS] },
			});
			return { ...value, agentsRoot: root, ...(missing ? { agentsMissing: missing } : {}) };
		},
	}, {
		name: 'workflow_engine_status',
		description: '自证 Host 侧 worker_threads 是否可用（起一个真 worker 拿回 threadId 再终止），并**在线程内真的加载一次**工作流定义——引擎迁移前置条件的实证。可给 id 指定某张工作流，默认取最近修改的一张。',
		parameters: {
			type: 'object',
			properties: { id: { type: 'string', description: '工作流 id（可选；默认最近修改的一张）' } },
			required: [],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, threadId: { type: 'integer' }, echo: { type: 'string' },
					ms: { type: 'integer' }, error: { type: 'string' },
					load: {
						type: 'object',
						properties: {
							ok: { type: 'boolean' }, id: { type: 'string' }, name: { type: 'string' },
							nodeCount: { type: 'integer' }, edgeCount: { type: 'integer' }, steps: { type: 'integer' },
							empty: { type: 'boolean' }, threadId: { type: 'integer' }, ms: { type: 'integer' }, error: { type: 'string' },
						},
						required: ['ok'],
					},
				},
				required: ['ok', 'ms'],
			},
			// ★ `presentationMeta`（报告 §5-11）：结构化元数据**随会话日志持久化**、卡片直接读 ✓ ——
			// 在这之前卡片只能去解析下面那行 `…_json:` **文本** ✗（人读文案一改口径，卡片就瞎 ✗）。
			// ⚠ 两条约束（都来自官方参考实现 `dsh-tool-fs-search/lib/types/presentation.d.ts` ✓）：
			//   ① `meta` 会被**持久化并每次请求重发** ⇒ 必须**限长** ✓（这里只放计数与短串，绝不塞正文 ✓）；
			//   ② 官方只为**顶层调用**计算 meta ✓（嵌套调用没有它 ✓）⇒ 卡片**不能只认 meta** ✗，
			//      必须保留文本回落 ✓。
			presentationMeta: (_args, value) => {
				const load = value.load;
				return {
					shape: 'engine-status',
					ok: value.ok === true,
					threadId: value.threadId ?? null,
					ms: value.ms ?? null,
					error: typeof value.error === 'string' ? value.error.slice(0, 200) : null,
					load: load ? {
						ok: load.ok === true,
						id: load.id ?? null,
						name: typeof load.name === 'string' ? load.name.slice(0, 80) : null,
						nodeCount: load.nodeCount ?? null,
						edgeCount: load.edgeCount ?? null,
						steps: load.steps ?? null,
						empty: load.empty === true,
						error: typeof load.error === 'string' ? load.error.slice(0, 200) : null,
					} : null,
				};
			},
			render: (_args, value) => {
				const head = value.ok
					? `Host worker_threads 可用：worker threadId ${value.threadId}，回显 ${value.echo}，耗时 ${value.ms}ms`
					: `Host worker_threads 不可用：${value.error}`;
				const load = value.load;
				const tail = !load ? ''
					: load.ok
						? ` ｜ 线程内加载成功：#${load.id} ${load.name ?? ''}（${load.nodeCount} 节点 / ${load.edgeCount} 连接 / ${load.steps} 步${load.empty ? '，空壳' : ''}，threadId ${load.threadId}，${load.ms}ms）`
						: ` ｜ 线程内加载失败：${load.error}`;
				return [
					// 人读那行 ✓（现有探针按它写文案 ✓）
					{ type: 'text', text: head + tail },
					// ★ 机器可读那行（README 5.09 的官方做法；第二张卡照第一张的分法 ✓）：
					// 键序固定 ✓，卡片/探针据此取值，不去解析人读文案 ✗。
					{
						type: 'text',
						text: `workflow_engine_status_json: ${JSON.stringify({
							ok: value.ok === true,
							threadId: value.threadId ?? null,
							ms: value.ms ?? null,
							load: value.load ?? null,
						})}`,
					},
				];
			},
		},
		execute: async (args = {}) => {
			const probe = await probeWorkerThreads({ echo: 'workflow_engine_status' });
			const base = Object.fromEntries(Object.entries(probe).filter(([, value]) => value !== undefined));
			// 挑一张工作流：给了 id 就用它 ✓；否则取最近修改的一张 ✓（列不出来时下面会如实报错 ✗，不瞎猜路径 ✓）
			let id = typeof args.id === 'string' ? args.id.trim() : '';
			if (!id) {
				const listed = await listWorkflows(config, { limit: 200 }).catch(() => undefined);
				const workflows = Array.isArray(listed?.workflows) ? listed.workflows : [];
				const newest = workflows.slice().sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0))[0];
				id = typeof newest?.id === 'string' ? newest.id : '';
			}
			if (!id) {
				return { ...base, load: { ok: false, error: '没有可加载的工作流（或指定的 id 不存在）' } };
			}
			// 路径穿越防护在 `workflowFilePathOf` 里（id 是模型可控输入 ✓）；返回 null ⇒ 如实报错 ✓
			const path = workflowFilePathOf(config, id);
			if (!path) {
				return { ...base, load: { ok: false, error: `工作流 id 不合法：${id}` } };
			}
			const load = await runWorkflowLoad({ path, id });
			// `runWorkflowLoad` 把计数放在 `summary` 里 ⇒ 这里**摊平**成输出 schema 的形状 ✓
			const flat = { ok: load.ok === true, ...(load.summary ?? {}), threadId: load.threadId, ms: load.ms, ...(load.error ? { error: load.error } : {}) };
			return { ...base, load: Object.fromEntries(Object.entries(flat).filter(([, value]) => value !== undefined)) };
		},
	}, {
		// ── 执行（2026-10-20）：让 **agent** 也能跑一条工作流（此前只有页面的 ▶ 能触发）───────────────
		// ⚠ 它**不写定义文件**，但会**真跑**（模型回合；Comfy 类节点还可能生成图像/视频，几分钟且花额度）
		//   ⇒ 也进 `WRITE_TOOLS` 的审批闸（文案按工具区分，见 `TOOL_APPROVAL`）。
		// ⚠ 等待策略：默认最多等 `waitSeconds` 秒，**超时不算失败** —— 执行还在后台跑，返回
		//   `status:'running'` + executionId，让调用方去看进度（聊天框 dock 条 / `/api/run/status`）。
		//   为什么不等到底：工具调用有自己的超时策略，一次调用挂十几分钟会把整个回合拖死 ✗。
		name: 'workflow_run',
		description: '执行一条工作流（dsh 引擎跑；agent / prompt 节点各驱动一个真实回合）。'
			+ ' ⚠ 有副作用：会真跑模型，Comfy 类节点还可能触发图像/视频生成（耗时且消耗额度）⇒ 需要用户批准。'
			+ ' 默认最多等 `waitSeconds` 秒：**超时不算失败**，会返回 `status:"running"` 与 `executionId`，'
			+ ' 之后看聊天框的进度条（或 `/x/workflow/api/run/status`）等它跑完；'
			+ ' 同一条工作流同时只允许一次执行（并发会被明确拒绝）。',
		parameters: {
			type: 'object',
			properties: {
				workflowId: { type: 'string', description: '工作流 id（workflow_list 得到的那个）' },
				waitSeconds: { type: 'integer', description: '最多等多少秒（默认 120，范围 5~600）' },
			},
			required: ['workflowId'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					status: { type: 'string' }, executionId: { type: 'string' }, workflowId: { type: 'string' },
					ok: { type: 'boolean' }, done: { type: 'integer' }, total: { type: 'integer' },
					failedNode: { type: 'string' }, error: { type: 'string' }, note: { type: 'string' },
				},
				required: ['status'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.status === 'running'
					? `工作流 ${value.workflowId ?? ''} 仍在执行（${value.done ?? 0}/${value.total ?? 0} 节点）：${value.executionId ?? ''}`
					: `工作流 ${value.workflowId ?? ''} 执行结束：${value.status}${value.failedNode ? `（失败节点 ${value.failedNode}）` : ''}${value.error ? ` — ${value.error}` : ''}`,
			}],
		},
		isConcurrencySafe: () => false,
		execute: async (params = {}) => {
			const workflowId = String(params?.workflowId ?? '').trim();
			if (!workflowId) {
				throw new Error('workflow_run 需要 workflowId（用 workflow_list 得到的那个）');
			}
			const waitSeconds = Math.min(600, Math.max(5, Number(params?.waitSeconds ?? 120) || 120));
			let timer;
			const TIMED_OUT = Symbol('timeout');
			const pending = runWorkflow(config, { workflowId });
			const timeout = new Promise(resolve => {
				timer = setTimeout(() => resolve(TIMED_OUT), waitSeconds * 1000);
				timer.unref?.();
			});
			try {
				const out = await Promise.race([pending, timeout]);
				if (out !== TIMED_OUT) {
					// ⚠ 兜一个 `status`：`runWorkflow` 的**失败分支**只回 `{ ok:false, error }`（没有 status），
					//   而本工具的 output schema 把 `status` 列为必填 ⇒ 漏兜会让"引擎不可用/空壳工作流"
					//   这类正常失败返回一个**不合 schema** 的结果（上游校验报错，用户看到的是一条莫名错误 ✗）。
					return { status: out?.ok === false ? 'failed' : 'unknown', workflowId, ...out };
				}
				// 还在跑：从运行态里挑这条工作流当前的 executionId（runWorkflow 尚未返回）
				const running = listRunStates({ workflowId }).find(state => state.status === 'running');
				return {
					status: 'running',
					workflowId,
					...(running?.executionId ? { executionId: running.executionId } : {}),
					done: Number(running?.done ?? 0),
					total: Number(running?.total ?? 0),
					note: `仍在执行（已等 ${waitSeconds}s）：它会在后台继续。进度见聊天框的进度条，或 GET /x/workflow/api/run/status`,
				};
			} finally {
				clearTimeout(timer);
			}
		},
	}];
}

/**
 * 装配期配置校验（fail-fast）：**错型立刻拒**，而且指得出是哪个键 ✓ —— 报告 §5-8 要的效果是"错型
 * **启动期即报**、而不是等第一次读配置才炸" ✓，这里用**同样早**的时机自己做到它 ✓。
 *
 * 为什么不用 dsh 的 `Config` 声明：那要 `import { z } from '@deepseek-ai/schemastery'` ✗ —— 本仓插件
 * **不 import 任何 `@deepseek-ai/*`** ✓（kanban 文件头写着理由：避免 profile 侧对 dsh 包的解析依赖、
 * 跨版本更稳 ✓）。键清单与 `store.js` **真正读的键一一对应** ✓（加配置键时这里也要加 ✗，否则校验漏）。
 *
 * ⚠ `vssaros-kanban` / `vssaros-workflow` 各有一份**内容相同**的副本（插件之间不能互相 import ✓）——
 * 改一处必须改另一处 ✓（两边各有断言钉住"错型必须抛" ✓，漏改会红 ✗）。
 */
function validateConfig(config) {
	const stringKeys = ['dataRoot', 'workflowsRoot'];
	const integerKeys = ['lockWaitMs', 'lockStaleMs'];
	for (const key of stringKeys) {
		const value = config?.[key];
		if (value !== undefined && typeof value !== 'string') {
			throw new Error(`${name}: config.${key} 必须是字符串（收到 ${typeof value}）—— 错型的配置会让模块读到别的地方，装配期直接拒掉`);
		}
	}
	for (const key of integerKeys) {
		const value = config?.[key];
		if (value !== undefined && !Number.isInteger(value)) {
			throw new Error(`${name}: config.${key} 必须是整数（收到 ${typeof value}）`);
		}
	}
}

/**
 * 写入类工具（审批闸只拦这些 ✓，见 README 5.104）。
 *
 * 为什么导出：跨模块守卫（`dshPluginPackages.test.ts`）拿它**机器核对** —— 名单非空 ✓、
 * 每个名字都真的被注册 ✓（防"闸挂了但名单是空的" ✗ 这种最像修好了的坏法 ✓）。
 */
export const WRITE_TOOLS = ['workflow_update', 'workflow_apply', 'workflow_run'];

/**
 * 每个需审批工具的**文案**：`reason` = 审计口径、`displayReason` = 用户可见。
 *
 * ⚠ 两处都是**用户真的会读到**的文案 ⇒ 必须描述"这次真正会发生什么"：
 *   `workflow_run` **不写定义文件**，但它会真跑（花模型调用、可能触发生成）——
 *   跟"改定义"共用一句就是假话 ✗（本仓"写死的文案会随状态变假"踩过多次）。
 * `p3-10` 会断言名单里**每个**工具都有文案（防"加了工具忘了写、用户看到一句错的"）。
 */
export const TOOL_APPROVAL = {
	workflow_update: { reason: '会改动工作流定义文件', en: 'modify a workflow file', zh: '修改工作流定义' },
	workflow_apply: { reason: '会改动工作流定义文件', en: 'modify a workflow file', zh: '修改工作流定义' },
	workflow_run: {
		reason: '会真的执行这条工作流（跑模型；Comfy 类节点还可能生成图像/视频，耗时且消耗额度）',
		en: 'RUN this workflow (it costs model calls and may trigger media generation)',
		zh: '执行这条工作流',
	},
};

export function apply(ctx, config = {}) {
	// ── 配置校验（fail-fast，报告 §5-8）──────────────────────────────────────────────
	// 为什么不声明 dsh 的 `Config`：那要 `import { z } from '@deepseek-ai/schemastery'` ✗ —— 本仓插件
	// **不 import 任何 `@deepseek-ai/*`** ✓（kanban 文件头记着这条理由：避免 profile 侧对 dsh 包的解析
	// 依赖、跨版本更稳 ✓）。报告要的效果是"**错型启动期即报**，而不是用到才炸" ✓ —— 这里用**同样早**的
	// 时机自己做到它 ✓：装配期就把错型拒掉，且**指得出是哪个键** ✓（别等第一次读配置才炸 ✗）。
	// 其余模块若加配置，照这一段抄 ✓（配置键清单与本模块 `store.js` 真正读的键一一对应 ✓）。
	validateConfig(config);
	// 重构 1.3：绑定 foundation 共享服务（dataRoot/dshHome/pageShell/lock 的真源）。
	// ⚠ 位置在校验**之后** ✓：错型配置必须装配期第一个抛（守卫看的就是"报的是哪个键" ✓）。
	{
		// 同步直读在前：有插件在 apply 的**同步段**就建 store（inject 回调是异步的，会来不及 ✗）。
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
		let svc = null;
		try { svc = child.vssarosFoundation ?? null; } catch { /* 探针的假 ctx（Proxy）对未知属性抛错 ⇒ 当不存在 */ }
		if (svc) { bindFoundation(svc); }
	});
	}
	// ★ 写入类工具的**审批闸**（报告 §5-1 / README 5.104）：官方派发前决策钩子是 `tools/pre-execute`
	// 这条 **waterfall 事件** ✓（`dsh-tools` 类型 L37-47 ✓）；返回 `{ kind: 'ask' }` ＝ "先问用户" ✓。
	// 官方契约：`ask` **只有审批服务返回 `allowed-once` 才执行，否则 deny** ✓；**没有审批支持的部署会
	// degrade to deny** ✓（fail-closed ✓）；审批缝是 `ctx.get('approval')` ✓（L437-441 / L817-820 ✓）。
	// 本 profile 的 `user-approval` 在且未被禁用、策略默认 `ask` ✓（5.103 用 `--dump-config` 核对 ✓）。
	// ⚠ 位置必须在 `validateConfig` **之后** ✓ —— fail-fast 校验要第一个说话 ✓：
	// 我第一版把闸插在前面 ✗，`★ 配置错型必须在装配期就抛` 那条守卫立刻红了 ✓（错型配置的报错被
	// 闸自己的 TypeError 盖掉了 ✓ —— 守卫看的正是**报的是哪个键** ✓）。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (exec && WRITE_TOOLS.includes(exec.name)) {
			// `reason`=审计口径 ✓、`displayReason`=本地化提示 ✓（官方字段语义）
			// ⚠ 文案**按工具取**：`workflow_run` 不写文件但它会真跑 ⇒ 不能跟"改定义"共用一句 ✗
			const approval = TOOL_APPROVAL[exec.name] ?? { reason: '会改动工作流定义文件', en: 'modify a workflow file', zh: '修改工作流定义' };
			return {
				kind: 'ask',
				reason: `${exec.name} ${approval.reason}`,
				displayReason: { en: `Allow ${exec.name} to ${approval.en}?`, zh: `允许 ${exec.name} ${approval.zh}？` },
			};
		}
		return next(); // 只读工具交回默认 allow ✓（否则每次读也要弹窗 ⇒ 工具没法用 ✗）
	}));
	const state = { tools: null, engine: null, cancelRunSession: null };
	stateRef.current = state;  // 路由辅助（runWorkflow/listRuns）经它拿引擎（见文件尾）

	ctx.effect(() => {
		// ── R13（preset plane）：同一个包会被挂**两次**（host plane 一行 + 我们的 preset 里一行 ✓）──
		// `hostHalf: true` ⇒ 这次只注册页面/服务，**不注册工具**（工具交给 preset 里那次 ✓）；
		// 缺省 ⇒ **与从前完全一样** ✓（零行为改变）。注意上面 `validateConfig` 仍**先跑** ✓：
		// 错型配置必须在装配期第一个说话（p3-10 的守卫看的正是"报的是哪个键"✓）。
		if (config.hostHalf === true) { return undefined; }
		const disposers = toolDefinitions(ctx, state, config).map(definition => ctx.tools.register(definition));
		state.tools = ctx.tools;
		return () => {
			state.tools = null;
			for (const dispose of disposers) {
				dispose();
			}
		};
	});

	// 反向通道（**可选**依赖）：页面上的「在画布打开」经它请求 IDE 的 workflow 能力。
	//
	// ★ 2026-10-14 修正（真机症状：点条目/双击条目**完全没反应**，页面底部写着
	//   `打开失败：控制桥不可用（@vssaros/dsh-bridge 未加载或版本过旧）`）：
	//   原先写的是 `const found = ctx.vssarosBridge` 包 try/catch —— 那句**恒抛** ✗：
	//   cordis 的 context 代理对"没在 `inject` 里声明的服务"一律抛
	//   `cannot get property "vssarosBridge" without inject`（`@deepseek-ai/cordis/src/reflect.ts` 的
	//   handler；`ctx.provide` 只让**声明过**的 fiber 读到 ⇒ 兄弟插件必须声明）⇒ 被 catch 吞掉后
	//   `bridgeOf()` 恒为 undefined ⇒ **这条路径从来没通过**（而桥本身是好的：`/x/vssaros-bridge`
	//   实测 `reverse=ready clients=1`）。
	//   两条合法读法：① `ctx.inject(['vssarosBridge'], scope => …)` ← 本插件选它：动态声明，
	//   桥不在时**不会**让插件 pending（与上面 `webServer`/`connection` 同一姿势 ✓），且在 scope 里读到
	//   的服务"访问方 ctx"是我们自己 ⇒ 桥的 `stampCallerIdentity`（把自报 pluginId 换成盖章真身份）仍生效 ✓；
	//   ② `ctx.reflect.get('vssarosBridge', false)`（文档里的"不经 inject 要求地读" ✓，桥自己读
	//   `pluginManager` 就用它）—— 但经它拿到的服务其 `ctx` 是**根 ctx** ⇒ 盖章失效 ✗ ⇒ 不用它。
	// 重构 3.1（2026-10-16）：工作流引擎服务 `vssarosWorkflowEngine`（cordis 服务）。
	// 核心环在 `lib/core/engineCore.js`（DAG 编排 + checkpoint + 断点续跑 + 分支剪枝）；
	// checkpoint 三件套在 `lib/core/checkpoint.js`（移植自 legacy `workflowCheckpoint.ts`，逐字同逻辑 ✓）。
	// 可选注入 vssarosRuns：bridge 0.2.26+ 提供；不在 ⇒ 服务照样注册，agent/prompt 节点会如实失败
	// （"回合驱动不可用"），纯数据节点（start/end/ifElse/switch）照跑 ✓。
	{
		// runs 是可选注入（inject 回调异步 ⇒ 先给 null，到了回填）。引擎核心**必须在用时读
		// `deps.runs`**（不能解构 —— 解构就是快照，回填白费 ✗；2026-10-20 p3-151 真机栽在这里）。
		const deps = {
			// ★ 2026-10-20（p3-151 真机抓到）：`readWorkflow` 的返回是**包着的** ——
			//   `{ workflow }` 或 `{ error }`，**从不是 null** ✓。原先这里 `if (!wf) throw` 恒不成立 ×2：
			//   ① 找不到 ⇒ `{ error }` 被当成工作流 ⇒ `wf.nodes` undefined ⇒ **0 节点** ⇒ 直接 completed
			//      （"不存在的工作流"也会返回 ok:true —— 假成功）；
			//   ② 找到 ⇒ `{ workflow }` 也被当成工作流 ⇒ 同样是 **0 节点** ⇒ 引擎**从来没真跑过任何节点** ✗。
			//   ⇒ 这里必须解包；契约由 p3-151（真 Host + 真 runs）钉住，进程内 p3-104 用裸定义注入看不到它 ✗。
			// ★ 2026-10-20（p3-151 真机）：**执行面必须读原始 nodes/connections** ——
			//   `readWorkflow` 走的是 `parseWorkflow`，那是为**页面/画布**压扁过的形态：
			//     节点只剩 `{id,type,name,x,y}`（`data` 整个丢了 ⇒ prompt / branches / allowTools /
			//     retryMaxAttempts 全失效，真机症状 `session.run: prompt required` ✗）；
			//     边改名叫 `edges`（`wf.connections` 恒 undefined ⇒ 拓扑序退化成"按数组顺序全跑" ✗）。
			//   ⇒ 只读投影（页面/工具）保持压扁形态不动 ✓，**执行面单独读原文** ✓。
			loadWorkflow: async id => {
				const result = await readWorkflow(config, id);
				if (result?.error) { throw new Error(String(result.error)); }
				if (!result?.workflow) { throw new Error(`找不到工作流：${id}`); }
				try {
					const raw = await readRawWorkflow(result.workflow.dir);
					return { id: raw.id ?? id, name: raw.name ?? id, nodes: raw.nodes, connections: raw.connections };
				} catch (e) {
					throw new Error(`读工作流定义失败（${id}）：${String(e?.message ?? e)}`);
				}
			},
			saveCheckpoint: async (id, cp) => {
				const dir = checkpointDirOf(config);
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, `${id}.json`), JSON.stringify(cp, null, 2));
			},
			loadCheckpoint: async id => {
				try {
					const raw = await readFile(join(checkpointDirOf(config), `${id}.json`), 'utf8');
					const parsed = parseWorkflowCheckpoint(raw);
					return parsed.ok ? parsed.checkpoint : null;
				} catch { return null; }
			},
			runs: null,
			// 重构 3.3：节点分流的留壳侧（可选注入；不在 ⇒ 保持如实失败 ✓）
			officialWorkflow: null,   // 官方 workflowEngine（script 节点转交）
			// comfy / comfyStage / askUser 回 IDE 的那一跳：**走授权链**（`ide.request` + capability=workflow
			// + `op:'executeNode'`），理由见 `engineCore` 对应分支的注释。
			// ⚠ 写成**函数**而不是"apply 时取一次 bridge 快照"：`vssarosBridge` 是 inject 异步回填的，
			//   这里每次调用现取 `bridgeOf()` ⇒ 回填后立刻生效 ✓，桥不在时抛可读错误 ✓。
			executeNodeViaIde: payload => {
				const active = bridgeOf();
				if (!active) {
					throw new Error(`节点 ${payload?.nodeId ?? '?'} 的类型 ${payload?.nodeType ?? '?'} 要经桥回 IDE，但 vssarosBridge 不在（bridge 插件没装/没连）`);
				}
				return active.callIDE('ide.request', {
					capability: 'workflow',
					pluginId: PLUGIN_ID,
					params: { op: 'executeNode', ...payload },
				}, { timeoutMs: EXECUTE_NODE_TIMEOUT_MS });
			},
			cwdOf: () => workspacePathOf(config),
			log: (level, msg) => (typeof ctx.logger === 'function' ? ctx.logger('vssaros-workflow') : console)[level === 'warn' ? 'warn' : 'info'](msg),
		};
		ctx.inject(['vssarosRuns'], scope => {
			deps.runs = scope.vssarosRuns;
			return () => { deps.runs = null; };
		});
		ctx.inject(['workflowEngine'], scope => {
			deps.officialWorkflow = scope.workflowEngine;
			return () => { deps.officialWorkflow = null; };
		});
		// ⚠ 这里**不要**再单独 inject 一份 `vssarosBridge` 到 deps：回 IDE 的唯一出口是上面的
		//   `executeNodeViaIde`（内部读 `bridgeOf()`），两份来源只会漂移（2026-10-20 收编）。
		// 引擎实例存进 state：页面路由（/api/run）与别的插件（cordis 服务）都拿同一个 ✓。
		state.engine = createEngineCore(deps);
		// 取消"正在跑的那个节点"的会话（`/api/run/cancel` 用）：宿主内唯一的取消原语是 `vssarosRuns.cancel`。
		// ⚠ 必须在这里闭包 `deps`（而不是模块级快照）—— `runs` 是 inject **异步回填**的。
		state.cancelRunSession = async sessionId => {
			const runs = deps.runs;
			if (!runs || typeof runs.cancel !== 'function') {
				return { cancelled: false, reason: '回合驱动不可用（@vssaros/dsh-bridge 未加载或版本过旧）' };
			}
			return runs.cancel({ sessionId });
		};
		// ⚠⚠ **必须幂等**：本插件**同时**挂在两个 plane 上 ——
		//   host plane：`vssaros-workflow/cordis.patch.yml` 把本行插进 profile（Host 启动即装 ✓）；
		//   preset plane：`vssaros-agents/preset-vssaros.rows.yml` 的 vssaros-workflow 行（⇒ 生成物
		//     `cordis.presets.yml`）—— 会话选中那个 preset 时**再 apply 一次** ✓。
		//   而 `ctx.provide` 第二次会抛 `service "vssarosWorkflowEngine" has been registered at <vssaros-workflow>`
		//   ⇒ **整个 preset 被判 invalid** ⇒ `session.start` 直接失败 ✗✗
		//   （2026-10-16 真机：报 `agent-preset/invalid: vssaros-workflow (@vssaros/dsh-workflow)`，
		//    表现就是"点工作区 / worktree 切不过去"、且界面上**一句提示都没有** —— 见
		//    `dshChatInstanceHost._notifySwitchFailure` 那条补出来的通知出口 ✓）。
		// ⇒ 先"不经 inject 要求地读"探一次（`ctx.reflect.get(name, false)` 是文档口径：服务不在时返回
		//   undefined 而**不抛** ✓；桥插件读 `pluginManager` 用的就是它 ✓）：已经有就别再 provide
		//   —— 两层拿到同一个引擎实例，正合上面"都拿同一个"的意图 ✓。
		const existingEngine = ctx.reflect && typeof ctx.reflect.get === 'function'
			? ctx.reflect.get('vssarosWorkflowEngine', false)
			: undefined;
		if (!existingEngine) { ctx.provide('vssarosWorkflowEngine', state.engine); }
	}

	let bridge;
	ctx.inject(['vssarosBridge'], scope => {
		bridge = scope.vssarosBridge;
		return () => { bridge = undefined; };
	});
	function bridgeOf() {
		return bridge && typeof bridge.callIDE === 'function' ? bridge : undefined;
	}

	// 页面路由（**可选**依赖）：`webServer` / `connection` 只在 web 模板里存在（见静态 `inject` 的注释）。
	// 不在 web 模板 ⇒ 只是**没有页面** ✓，工具照常可用 ✓。
	ctx.inject(['webServer', 'connection'], page => {
		// ★ 2026-10-20（p3-151 真机抓到）：**执行引擎的引用必须挂"注册了页面路由"的那次 apply**。
		//   本包双 plane 挂载（host plane 的 patch 行 + preset plane 的 rows）⇒ 会 apply 两次、各建
		//   一份 state/engine，而 `stateRef` 是**模块级单例**（后 apply 覆盖前者 ✗）。preset 那次的
		//   作用域里 `vssarosRuns` 看不到 ⇒ 它的 `deps.runs` 恒 null ⇒ 页面 ▶ 拿到的是一个没有回合
		//   驱动的引擎（真机症状：节点 a 失败 `Cannot read properties of null (reading 'run')`）。
		//   页面路由只属于 host plane 实例 ⇒ 以"注册页面路由的那次"为准 ✓（`stateRef` 留给工具/引擎自用）。
		pageStateRef.current = state;
		return page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			try {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				// ★ 2026-10-22（工作台重构 §5 步骤 1）：**页面数据的 JSON 接口**。
				//   React 工作台（`lib/workbench.js`）与 SSR 页**共用同一份取数**（`collectPageData`）⇒
				//   两个界面的数字/筛选/画布永远一致 ✓（各写各的 ⇒ 迟早分叉 ✗）。
				if (url.pathname === `${ROUTE_PREFIX}/api/page` && req.method === 'GET') {
					const payload = await collectPageData(config, state, url.searchParams.get('id') ?? undefined);
					res.writeHead(200, JSON_HEADERS);
					res.end(JSON.stringify({ ok: true, ...payload }));
					return;
				}
				// ★ 2026-10-22（左右两档）：**只取画布**的轻接口 —— 左列点一行就换右列的图，
				//   没必要把整页（所有行 + 摘要 + worker 自证）重搬一遍 ✗（每次点行都白搬一遍）。
				if (url.pathname === `${ROUTE_PREFIX}/api/canvas` && req.method === 'GET') {
					const wanted = (url.searchParams.get('id') ?? '').trim();
					const payload = await collectPageData(config, state, wanted || undefined);
					res.writeHead(200, JSON_HEADERS);
					res.end(JSON.stringify({ ok: true, selected: payload.selected, canvas: payload.canvas }));
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/open`) {
					// 「在画布打开」：**只经反向通道**请求 IDE 能力 workflow（清单里已声明 ⇒ 才有授权）。
					// 没有桥 / 没有 IDE 监听时给**可读错误**（页面据此显示原因），绝不静默成功。
					const id = (url.searchParams.get('id') ?? '').trim();
					if (!id) {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: 'id 必填（工作流 id，如 wf-xxx）' }));
						return;
					}
					const activeBridge = bridgeOf();
					if (!activeBridge || typeof activeBridge.callIDE !== 'function') {
						res.writeHead(503, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: '控制桥不可用（@vssaros/dsh-bridge 未加载或版本过旧）：打开画布需要反向通道（协议 v2）' }));
						return;
					}
					try {
						const reply = await activeBridge.callIDE('ide.request', {
							capability: 'workflow',
							pluginId: PLUGIN_ID,
							params: { op: 'open', id },
						}, { timeoutMs: OPEN_TIMEOUT_MS });
						res.writeHead(200, JSON_HEADERS);
						res.end(JSON.stringify({ ok: true, reply: reply ?? null }));
					} catch (e) {
						// 主进程拒绝（未声明能力 / 插件未装 / 无 IDE 在监听）与执行端报错都走这里，
						// 文案原样带出去——这是用户唯一能看到的线索。
						res.writeHead(502, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
					}
					return;
				}
				// 重构 3.2：执行入口（POST /api/run）+ 运行轨迹（GET /api/runs）。
				if (url.pathname === `${ROUTE_PREFIX}/api/run` && req.method === 'POST') {
					const body = JSON.parse(await readBody(req));
					const out = await runWorkflow(config, body);
					res.writeHead(out.ok ? 200 : 500, JSON_HEADERS);
					res.end(JSON.stringify(out));
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/runs` && req.method === 'GET') {
					res.writeHead(200, JSON_HEADERS);
					res.end(JSON.stringify({ runs: await listRuns(config) }));
					return;
				}
				// 2026-10-20：**执行期运行态**（聊天页的 dock 条与页面都轮询它）。轮询 1s 级足够，
				// 不上 SSE —— 数据量小、实现与调试都便宜，且不需要长连接的生命周期管理。
				if (url.pathname === `${ROUTE_PREFIX}/api/run/status` && req.method === 'GET') {
					const workflowId = url.searchParams.get('workflowId') ?? undefined;
					const executionId = url.searchParams.get('executionId') ?? undefined;
					res.writeHead(200, JSON_HEADERS);
					res.end(JSON.stringify({ ok: true, runs: listRunStates({ workflowId, executionId }) }));
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/run/cancel` && req.method === 'POST') {
					let body = {};
					try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
					const out = await cancelWorkflow(config, body);
					res.writeHead(out.ok ? 200 : 409, JSON_HEADERS);
					res.end(JSON.stringify(out));
					return;
				}
				const payload = await collectPageData(config, state, url.searchParams.get('id') ?? undefined);
				const html = renderPage({ data: { ...payload.data, summary: payload.summary }, config, toolsRegistered: payload.toolsRegistered, worker: payload.worker, selected: payload.selected, canvas: payload.canvas });
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(html);
			} catch (e) {
				const message = String(e?.message ?? e);
				if (res.headersSent) {
					res.end(message);
				} else {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(message);
				}
			}
		},
		}));
	});
}

// ─── 重构 3.2：执行入口与运行轨迹的辅助（页面路由用）─────────────────────────

/** `workflow_get` 的节点明细上限：条数 / 单条 `data` 字符 / 全部 `data` 的字符预算。 */
const NODE_DETAILS_LIMIT = 60;
const NODE_DATA_LIMIT = 1500;
const NODE_DETAILS_BUDGET = 24_000;

/** 任意值 ⇒ 可读且不撑爆工具返回的 JSON 文本（序列化不了就退化成 String）。 */
function clipJson(value, limit) {
	let text;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (typeof text !== 'string') { return ''; }
	return text.length > limit ? `${text.slice(0, limit)}…（已截断，共 ${text.length} 字符）` : text;
}

/**
 * 读工作流**原文**（`nodes` 带 `data`、`connections` 原样）。
 *
 * ⚠ 别用 `readWorkflow` 代替：那条走 `parseWorkflow`，是为**页面/画布**压扁过的只读投影 ——
 * 节点只剩 `{id,type,name,x,y}`（`data` 全丢）、边改名叫 `edges`。执行面与 `workflow_get` 的
 * 节点明细都需要原文（2026-10-20 p3-151 真机：拿压扁形态去跑 ⇒ `session.run: prompt required`）。
 */
async function readRawWorkflow(dir) {
	const raw = JSON.parse(await readFile(join(String(dir), 'workflow.json'), 'utf8'));
	return {
		id: typeof raw?.id === 'string' ? raw.id : undefined,
		name: typeof raw?.name === 'string' ? raw.name : undefined,
		nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
		connections: Array.isArray(raw?.connections) ? raw.connections : [],
	};
}

/** 读请求体（上限 64KB——工作流定义里没有更大的东西）。 */
function readBody(req) {
	return new Promise((resolveBody, reject) => {
		let buf = '';
		req.on('data', c => { buf += c; if (buf.length > 64 * 1024) { req.destroy(); reject(new Error('body too large')); } });
		req.on('end', () => resolveBody(buf));
		req.on('error', reject);
	});
}

/** 正在执行的工作流（workflowId → executionId）：同一工作流**串行**，见下面的并发闸。 */
const runningWorkflows = new Map();

// ─── 运行态（2026-10-20：执行期可见性）──────────────────────────────────────────
// 为什么要它：`/api/run` 是**同步 await** ⇒ 从前只有"开始/完成"两个时间点，聊天框与页面
// 都看不到中间态。现在引擎每步 emit 一次事件，这里攒成一份**可直接渲染**的快照，
// 供 `GET /api/run/status` 轮询（1s 足够；不上 SSE —— 数据量小、实现与调试都便宜）。
/** executionId → 运行态快照。 */
const runStates = new Map();
/** executionId → AbortController（取消走它；引擎只在**节点之间**检查）。 */
const runControllers = new Map();
/** 最多留多少条历史（页面/聊天页只关心"还在跑的"与"最近一次"）。 */
const RUN_STATE_KEEP = 20;

/** 事件 → 快照。**纯内存、不落盘**（真源仍是 checkpoint；这里只是观测面）。 */
function applyRunEvent(event) {
	const id = event?.executionId;
	if (!id) { return; }
	const existing = runStates.get(id);
	if (event.type === 'run-start') {
		runStates.set(id, {
			executionId: id,
			workflowId: event.workflowId,
			name: existing?.name,
			status: 'running',
			startedAt: new Date().toISOString(),
			finishedAt: null,
			total: Number(event.total ?? (event.nodes ?? []).length),
			done: 0,
			currentNodeId: null,
			error: null,
			cancelling: false,
			nodes: (event.nodes ?? []).map(node => ({ id: node.id, type: node.type, label: node.label ?? node.id, status: 'pending' })),
		});
	} else if (existing) {
		const node = (event.nodeId !== undefined) ? existing.nodes.find(n => n.id === event.nodeId) : undefined;
		if (event.type === 'node-start') {
			if (node) { node.status = 'running'; }
			existing.currentNodeId = event.nodeId;
		} else if (event.type === 'node-end') {
			if (node) {
				node.status = event.status;
				if (event.error) { node.error = String(event.error); }
			}
			existing.done = existing.nodes.filter(n => n.status === 'completed').length;
			existing.currentNodeId = null;
		} else if (event.type === 'run-end') {
			existing.status = event.status;
			existing.finishedAt = new Date().toISOString();
			existing.currentNodeId = null;
			if (event.error) { existing.error = String(event.error); }
			if (event.cancelled) { existing.cancelled = true; }
		}
	}
	// 只留最近 N 条（Map 的插入序 = 首次出现序；重建插入以反映"最近活跃"）
	const snapshot = runStates.get(id);
	if (snapshot) {
		runStates.delete(id);
		runStates.set(id, snapshot);
	}
	while (runStates.size > RUN_STATE_KEEP) {
		runStates.delete(runStates.keys().next().value);
	}
}

/** 列运行态（最近的在前；可按 workflowId / executionId 过滤）。 */
export function listRunStates({ workflowId, executionId } = {}) {
	const all = [...runStates.values()].reverse();
	const filtered = all.filter(state =>
		(executionId === undefined || state.executionId === executionId)
		&& (workflowId === undefined || state.workflowId === workflowId));
	return filtered.map(state => ({ ...state, nodes: state.nodes.map(node => ({ ...node })) }));
}

/** 执行一条工作流（经引擎核心；缺参/没引擎/没 runs 都如实报错）。导出给探针测（p3-104/p3-151）。 */
export async function runWorkflow(config, body) {
	const workflowId = String(body?.workflowId ?? '').trim();
	if (!workflowId) { return { ok: false, error: '缺 workflowId' }; }
	// ⚠ 三段都用 `pageStateRef`（注册页面路由的那次 apply），不是 `stateRef` —— 双 plane 覆盖的真机事故，
	//   见 `pageStateRef` 定义处的注释 ✓。（2026-10-20 复核：这里的 `.run` 一度还写着 `stateRef` ——
	//   引擎检查与真正执行用了**两个不同实例**，只是恰好指向同一个才没现形 ✗，现已统一 ✓。）
	const engine = pageStateRef.current?.engine;
	if (!engine) { return { ok: false, error: '引擎不可用（插件没激活？）' }; }
	const executionId = `exec-${Date.now().toString(36)}`;
	const input = typeof body?.input === 'object' && body.input !== null ? body.input : {};
	const resumeFrom = typeof body?.resumeFromExecutionId === 'string' ? body.resumeFromExecutionId.trim() : '';
	// ★ 2026-10-20：**同一条工作流不许并发执行**。agent 节点的会话 id 是 `wf-<workflowId>-<nodeId>`
	//   （**不含 executionId**）⇒ 两次并发会共用同一批会话：prompt 排队、结果窗互相交叉，
	//   而 checkpoint 各写各的（看着都"完成"，内容串了 ✗）。串行既是产品语义，也避免会话被撑爆。
	const concurrent = runningWorkflows.get(workflowId);
	if (concurrent) {
		return { ok: false, executionId, error: `工作流 ${workflowId} 正在执行（${concurrent}）：同一条工作流不支持并发执行，等它跑完再点` };
	}
	runningWorkflows.set(workflowId, executionId);
	const controller = new AbortController();
	runControllers.set(executionId, controller);
	try {
		// ★ 2026-10-20（p3-151）：**0 节点不许报"执行完成"**。空图（新建还没画 / 读失败的另一半）
		//   在引擎里是一条都不跑就直接 completed ⇒ 用户看到"执行完成"却什么都没发生（比失败更坏 ✗）。
		//   判定放这里（HTTP 入口），不动 `engineCore` 的空图语义 —— 那条被 p3-103/105 的对账钉着 ✓。
		const pre = await readWorkflow(config, workflowId);
		if (pre?.error) { return { ok: false, executionId, error: String(pre.error) }; }
		const nodeCount = Array.isArray(pre?.workflow?.nodes) ? pre.workflow.nodes.length : 0;
		if (nodeCount === 0) {
			return { ok: false, executionId, error: `工作流 ${workflowId} 没有任何节点（空壳）：画好节点再执行` };
		}
		// 先占个位把**工作流名字**带进观测面（run-start 事件会保留它）—— 列表里只显示 exec-xxx 不好认。
		runStates.set(executionId, {
			executionId, workflowId, name: pre?.workflow?.name,
			status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
			total: nodeCount, done: 0, currentNodeId: null, error: null, cancelling: false, nodes: [],
		});
		const result = await engine.run({
			workflowId,
			executionId,
			input,
			resumeFromExecutionId: resumeFrom || undefined,
			onEvent: applyRunEvent,
			signal: controller.signal,
		});
		// ★ 2026-10-20：失败时把**失败节点的原因**一起带出去。原先只回 `failedNode` 名字 ⇒ 页面只能显示
		//   "执行失败：未知原因"（`renderPage` 的脚本读的正是 `body.error` ✓），用户得自己去翻 checkpoint ✗。
		const failedNode = result.failedNode ?? null;
		return {
			ok: result.status === 'completed',
			executionId,
			status: result.status,
			failedNode,
			...(failedNode && result.nodeStates?.[failedNode]?.error
				? { error: String(result.nodeStates[failedNode].error) }
				: {}),
			resumed: result.resumed === true,
		};
	} catch (e) {
		return { ok: false, executionId, error: String(e?.message ?? e) };
	} finally {
		runControllers.delete(executionId);
		// 认领者才释放（并发闸里被拒的那次不会走到这里 ✓）
		if (runningWorkflows.get(workflowId) === executionId) { runningWorkflows.delete(workflowId); }
	}
}

/**
 * 取消一次执行（`POST /api/run/cancel`）。导出给探针测（p3-104）。
 *
 * 语义刻意写清（别让"取消"看起来比实际更彻底）：
 * ① 置 AbortSignal ⇒ 引擎在**下一个节点开始前**停（该节点记 `cancelled`，整条执行记 `cancelled`）；
 * ② 正在跑的那个节点：**尽力**取消它那条会话（`vssarosRuns.cancel`）—— 它可能已经产出、
 *    也可能要等 provider 收尾；取消失败**不改变**"引擎会停"这个结论（所以两个结果分开报）。
 */
export async function cancelWorkflow(config, body) {
	const executionId = typeof body?.executionId === 'string' ? body.executionId.trim() : '';
	const snapshot = executionId
		? runStates.get(executionId)
		: [...runStates.values()].filter(state => state.status === 'running').pop();
	if (!snapshot) {
		return { ok: false, error: executionId ? `没有这个执行：${executionId}` : '当前没有正在执行的工作流' };
	}
	if (snapshot.status !== 'running') {
		return { ok: false, error: `执行 ${snapshot.executionId} 已结束（${snapshot.status}）` };
	}
	snapshot.cancelling = true;
	runControllers.get(snapshot.executionId)?.abort();
	const nodeId = snapshot.currentNodeId ?? null;
	let sessionCancelled = null;
	const cancelSession = pageStateRef.current?.cancelRunSession;
	if (nodeId && typeof cancelSession === 'function') {
		try {
			sessionCancelled = await cancelSession(`wf-${snapshot.workflowId}-${nodeId}`);
		} catch {
			sessionCancelled = null;
		}
	}
	return {
		ok: true,
		executionId: snapshot.executionId,
		workflowId: snapshot.workflowId,
		currentNodeId: nodeId,
		sessionCancelled,
	};
}

/** 列运行轨迹（checkpoint 文件 ⇒ 每条执行一份）。导出给探针测（p3-104）。 */
export async function listRuns(config) {
	const dir = checkpointDirOf(config);
	let files = [];
	try {
		const { readdir } = await import('node:fs/promises');
		files = (await readdir(dir)).filter(f => f.endsWith('.json'));
	} catch {
		return [];  // 目录不存在 ⇒ 没跑过（如实的空 ✓）
	}
	const out = [];
	for (const f of files.slice(0, 100)) {
		try {
			const raw = await readFile(join(dir, f), 'utf8');
			const parsed = parseWorkflowCheckpoint(raw);
			if (parsed.ok) {
				out.push({
					executionId: parsed.checkpoint.executionId,
					workflowId: parsed.checkpoint.workflowId,
					status: parsed.checkpoint.status ?? 'unknown',
					timestamp: parsed.checkpoint.timestamp ?? null,
					nodes: Object.keys(parsed.checkpoint.nodeStates).length,
				});
			}
		} catch { /* 单条坏了不拖垮整列 */ }
	}
	return out.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
}

/** 引擎实例的进程内引用（apply 里装，工具/引擎自用）。 */
const stateRef = { current: null };
/**
 * **页面路由**那次 apply 的 state（`/api/run` 用它）。
 *
 * ⚠ 不能直接用 `stateRef`：本包双 plane 挂载 ⇒ 两次 apply 会互相覆盖，而 preset 那次拿不到
 * `vssarosRuns`（作用域不同）⇒ 覆盖后页面 ▶ 用一个**没有回合驱动**的引擎，节点全失败
 * （真机症状：`Cannot read properties of null (reading 'run')`，p3-151 抓到）。
 */
const pageStateRef = { current: null };
