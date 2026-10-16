// @vssaros/dsh-dashboard — **侧栏紧凑版**页面（sideview）。
//
// ⚠ 2026-10-13 引入（用户反馈："侧栏里的样式与原生 Dashboard 差异太大，且缺少打开按钮，
//   打开后应该在 editor pane 中显示"）。做法是**同一份数据、两种表面**：
//     · 侧栏（`?surface=sideview`，由宿主注入）⇒ 本文件：**摘要 + 入口**，对齐原生侧栏视图的信息层级
//       （打开按钮 / 4 张 mini KPI / 活跃会话 5 条 / 待处理 / 口径脚注）；
//     · 编辑区（无该参数）⇒ `index.js` 的完整页：可编排网格、完整明细、编排工具条。
//
// ⚠ **刻意不做的**（D2 已定）：侧栏版**不放**编排 / 添加组件 / 缩放手柄 —— 300px 宽里手柄只有几像素，
//   误触概率高；编排只在完整页做 ✓（用户原话："保留范围切换 + 口径脚注"）。
//
// ⚠ 两个"必须共用、不能各写一份"的东西：**摘要计算**（`summarizeModel`）与**锚点块**
//   （`metaBlock`）—— 否则侧栏说 32、完整页说 30，或者锚点只在一边存在 ⇒ 探针必红 ✗。
//
// ⚠ 本文件的 HTML 在**模板字符串**里：注释与文案里**绝不能出现反引号**，否则整页提前闭合 ✗
//   （本仓已因此踩过三次）。

import { activityText, escapeHtml, metaBlock, summarizeModel } from './catalog.js';
import { DATE_RANGES, formatMs, formatTokens } from './core/dashboard.js';

/** 侧栏里列几条活跃会话（原生那份也是 5 条）。 */
const SIDEVIEW_SESSIONS = 5;

/**
 * 「打开完整 Dashboard」按钮的点击行为。
 *
 * ① 有页面桥（真机里一定有）⇒ 发 `openModulePage` 命令，由 IDE 在**编辑区**打开同一个插件页 ✓；
 * ② 没有桥（纯浏览器打开这页时）⇒ 退化成新标签页打开完整页 —— 这是**真能用的**退化，不是"点了没反应" ✗。
 *
 * ⚠ 传的是 `location.pathname`（`/x/dashboard/`，**不含查询串**）：宿主用它查模块容器表，
 *   而带不带 `surface=sideview` 是宿主的自由 ⇒ 页面不该把自己"钉"在某个表面参数上 ✓。
 */
const OPEN_FULL_JS = `(function(){var b=document.querySelector('[data-dash-action="open-full"]');if(!b){return;}b.addEventListener('click',function(){var bridge=window.vssarosDsh;if(bridge&&typeof bridge.openModulePage==='function'){try{bridge.openModulePage(location.pathname);return;}catch(e){}}if(bridge){location.href=location.pathname;return;}window.open(location.pathname,'_blank','noopener');});})();`;

/** 会话的短标签：有标题用标题，没有就退化成 id 前 8 位（比"（无标题）"更有用）。 */
function shortLabel(session) {
	const title = typeof session.title === 'string' ? session.title.trim() : '';
	return title || String(session.id ?? '').slice(0, 8);
}

/** 一行紧凑会话（原生那份是"名称 + 状态徽章 + 一个度量"）。 */
function compactRow(session) {
	const pill = session.active ? '<span class="pill run">活跃</span>' : '<span class="pill">非活跃</span>';
	const metrics = [
		`turn ${session.stats?.turns ?? '未知'}`,
		formatMs(session.stats?.llmMs),
		formatTokens(session.tokens?.output),
	].join(' · ');
	// ⚠ 只有**真的有**运行中信号才多显示一行（不渲染"运行中：0"那种"未知伪装成 0" ✗）
	const live = session.activity ? `<div class="m2">${escapeHtml(activityText(session.activity))}</div>` : '';
	return `<li class="row"><div class="n">${escapeHtml(shortLabel(session))}</div><div class="m">${pill}<span class="r">${escapeHtml(metrics)}</span></div>${live}</li>`;
}

/**
 * 渲染侧栏紧凑版。
 *
 * ⚠ 只吃"页面级"输入（data / range / 两个如实上报的字符串 / 布局提示），**不接受布局** ——
 *   侧栏版没有组件网格，布局在这里没有意义 ✓。
 */
export function renderSideviewPage({ data, range = 'all', toolsRegistered = '', liveServices = '', layoutNote = '' }) {
	const { summary, tally } = summarizeModel(data, range, { toolsRegistered, liveServices });
	const { errors, dir, missing, truncated } = data;

	const kpis = [
		{ label: '会话', value: String(summary.sessions), detail: `${summary.active} 个活跃` },
		{ label: 'turn / step', value: `${summary.turns ?? '未知'}<span class="u">/${summary.steps ?? '未知'}</span>`, detail: '范围内' },
		{ label: '模型耗时', value: formatMs(summary.llmMs), detail: `工具 ${formatMs(summary.toolMs)}` },
		{ label: '排队待发', value: tally.queued !== undefined ? String(tally.queued) : '未知', detail: tally.waiting ? `待审批 ${tally.waiting}` : '无待审批信号' },
	];

	// 范围切换：⚠ 链接必须**带上 surface 参数**，否则在侧栏里点一下"7 天"就跳到完整页了 ✗
	// （`&` 在 HTML 属性里写成实体 `&amp;` —— 合法且浏览器解释一致 ✓）
	const rangeLinks = DATE_RANGES.map(item => item.range === range
		? `<b>${escapeHtml(item.label)}</b>`
		: `<a href="?surface=sideview&amp;range=${encodeURIComponent(item.range)}">${escapeHtml(item.label)}</a>`).join(' · ');

	// 待处理：**只列已知的**（tally 里缺席 = 这一轮没看到该类信号，不编造 0 ✓）
	const pending = [
		tally.queued ? `${tally.queued} 条消息排队待发` : '',
		tally.waiting ? `${tally.waiting} 个会话在等用户回答 / 审批` : '',
		tally.retrying ? `${tally.retrying} 个会话正在重试（LLM）` : '',
		tally.running ? `${tally.running} 个回合进行中` : '',
		tally.inProgress !== undefined && tally.todoSessions ? `${tally.inProgress} 项待办进行中（${tally.todoSessions} 个会话有清单）` : '',
	].filter(Boolean);
	const pendingHtml = pending.length
		? `<div class="sec"><span>待处理</span><span class="badge">${pending.length}</span></div><ul>${pending.map(text => `<li class="row"><div class="n">${escapeHtml(text)}</div></li>`).join('')}</ul>`
		: '<p class="foot">未发现排队 / 待审批 / 重试信号（按投影缓存判断）。</p>';

	const shown = summary.sorted.slice(0, SIDEVIEW_SESSIONS);
	const sessionsHtml = shown.length
		? `<ul>${shown.map(compactRow).join('')}</ul>`
		: '<p class="empty">没有可显示的会话。</p>';

	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Dashboard · VsSaros</title>
<style>
	/* ⚠ 本段在模板字符串里：注释里不能出现反引号（会提前闭合整页）。 */
	:root { color-scheme: light dark; }
	body { margin: 0; padding: 0 12px 16px; font: 13px/1.6 system-ui, "Segoe UI", sans-serif; color: var(--vscode-foreground, #ccc); background: var(--vscode-sideBar-background, #1e1e1e); }
	.open { width: 100%; margin: 0 0 14px; padding: 7px 12px; display: flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 12px; color: #fff; background: var(--vscode-button-background, #0e639c); border: 0; border-radius: 4px; cursor: pointer; }
	.open:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
	.kgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
	.k { padding: 10px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 4px; background: var(--vscode-editor-background, #1e1e1e); }
	.k .kl { font-size: 10px; text-transform: uppercase; color: var(--vscode-descriptionForeground, #999); margin-bottom: 4px; }
	.k .kv { font-size: 20px; font-weight: 300; }
	.k .kv .u { font-size: 12px; }
	.k .kd { font-size: 10px; color: var(--vscode-descriptionForeground, #999); margin-top: 2px; }
	.range { font-size: 12px; margin: 0 0 12px; color: var(--vscode-descriptionForeground, #999); }
	.range a, .range b { color: inherit; }
	.sec { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; color: var(--vscode-descriptionForeground, #999); margin: 0 0 8px; }
	.badge { background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); border-radius: 8px; padding: 0 6px; font-size: 10px; }
	ul { list-style: none; margin: 0 0 14px; padding: 0; }
	.row { padding: 8px 10px; margin-bottom: 6px; border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 4px; background: var(--vscode-editor-background, #1e1e1e); }
	.row .n { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.row .m { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 9px; color: var(--vscode-descriptionForeground, #999); }
	.row .m2 { font-size: 9px; color: var(--vscode-descriptionForeground, #999); margin-top: 2px; }
	.row .r { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.pill { border-radius: 8px; padding: 0 5px; background: rgba(128,128,128,.25); }
	.pill.run { background: rgba(78,201,176,.18); color: #4ec9b0; }
	.foot { font-size: 10px; line-height: 1.5; color: var(--vscode-descriptionForeground, #999); margin: 10px 0 0; }
	.empty { color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
	code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body data-vssaros-page="dashboard" data-vssaros-dashboard-surface="sideview">
<button type="button" class="open" data-dash-action="open-full">📊 打开完整主页</button>
<div class="kgrid">
${kpis.map(kpi => `	<div class="k" data-dash-kpi="${escapeHtml(kpi.label)}"><div class="kl">${escapeHtml(kpi.label)}</div><div class="kv">${kpi.value}</div><div class="kd">${escapeHtml(kpi.detail)}</div></div>`).join('\n')}
</div>
<p class="range" data-vssaros-dashboard-range="${escapeHtml(range)}">范围：${rangeLinks}</p>
${layoutNote ? `<p class="foot" data-vssaros-dashboard-layout-note="1">${escapeHtml(layoutNote)}</p>\n` : ''}
<div class="sec"><span>活跃会话</span><span class="badge">${summary.sessions}</span></div>
${sessionsHtml}
${pendingHtml}
${missing ? `<p class="foot">投影缓存目录还不存在：<code>${escapeHtml(missing)}</code>（dsh 还没写过会话，或 DSH_HOME 配错了）。</p>` : ''}
${truncated ? '<p class="foot">目录里还有更多会话，已按上限截断。</p>' : ''}
${errors.length ? `<p class="foot">${errors.length} 个缓存文件读不了：${escapeHtml(errors.slice(0, 3).join('；'))}${errors.length > 3 ? ' …' : ''}</p>` : ''}
<p class="foot" data-vssaros-dashboard-scope="session-telemetry">口径：数字来自 dsh 自己的<b>会话投影缓存</b>（checkpoint 落盘，可能比实时略落后）；IDE 侧「主页」是它自己的聚合口径（另有成本与告警）⇒ <b>两者数字不必相同</b>。</p>
<p class="foot">这里只是摘要与入口：<b>编排、完整明细、范围外的会话</b>都在完整页里（点上面的按钮）。数据目录 <code>${escapeHtml(dir)}</code>。</p>
${metaBlock({ data, summary, tally, toolsRegistered, liveServices })}
<script>${OPEN_FULL_JS}</script>
</body>
</html>`;
}
