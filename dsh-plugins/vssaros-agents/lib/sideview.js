// @vssaros/dsh-agents — 侧栏名册摘要版（2026-10-16，方案 D 的「管理态」左半边）。
//
// 承载：宿主在**侧栏**打开 `/x/agents/` 时会带 `?surface=sideview`（dshPluginViewPane 注入）⇒
// index.js 把这类请求分派到本文件；其余（编辑区完整页 / 探针的默认请求）仍走 detail.js。
//
// 形态口径（与 kanban / dashboard 的 sideview 同一套惯例 ✓）：
//   ① 摘要 + 入口：紧凑名册（头像 + 状态灯 + 会话角标），**不放**详情控件（筛选/抽屉/用量表那是
//      编辑区完整页的事 ✗）；
//   ② 点条目 → 同源 localStorage 写焦点交接（FOCUS_KEY，值 = agentId + 竖线 + 时间戳）→ 桥
//      openModulePage('/x/agents/') 请宿主在编辑区打开完整页；完整页读交接展开该行
//      （编辑器输入按容器单例，第二次打开不重载 ⇒ 完整页还监听 storage 事件 ✓）；
//   ③ 桥太旧时给一行提示，**不静默失败** ✓（点了没反应最难查）。
//
// 探针锚点（p3-06 钉住）：data-vssaros-page="agents-sideview" / data-vssaros-surface="sideview" /
//   data-sideview-count / 行上 data-agent-id 与 data-live-sessions / 函数 openFull / FOCUS_KEY 字面量。
// ⚠ 本段含模板串：注释里不许出现反引号（会提前闭合、整文件语法错 —— 本仓已踩 5 次）。

import { avatarColorOf, escapeHtml, presetIdOf } from './core/agents.js';

/** 焦点交接键（与 detail.js 的 FOCUS_KEY 同值；p3-06 对账两份字面量一致 ✓）。 */
export const FOCUS_KEY = 'vssaros.agents.focus';

/** 消息列表右上角的短时间（渲染时刻的快照口径）：刚刚 / N分 / N时 / 昨天 / N天 / 月-日。 */
function agoShort(ms) {
	if (!Number.isFinite(ms)) {
		return '';
	}

	const m = Math.floor((Date.now() - ms) / 60000);
	if (m < 1) { return '刚刚'; }
	if (m < 60) { return m + '分'; }
	const h = Math.floor(m / 60);
	if (h < 24) { return h + '时'; }
	const d = Math.floor(h / 24);
	if (d === 1) { return '昨天'; }
	if (d < 7) { return d + '天'; }
	const dt = new Date(ms);
	return (dt.getMonth() + 1) + '-' + dt.getDate();
}

const SIDEVIEW_CSS = `:root { color-scheme: light dark; }
body { margin: 0; padding: 0 0 6px; font: 12.5px/1.45 system-ui, "Segoe UI", sans-serif; color: var(--vscode-foreground, #ccc); background: var(--vscode-sideBar-background, #1e1e1e); }
header { display: flex; align-items: center; gap: 6px; padding: 8px 10px 7px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); position: sticky; top: 0; background: var(--vscode-sideBar-background, #1e1e1e); }
h1 { margin: 0; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
h1 .n { color: var(--vscode-descriptionForeground, #999); font-weight: 400; }
header .openall { margin-left: auto; font-size: 11px; padding: 1px 8px; color: var(--vscode-textLink-foreground, #6aa9e8); background: transparent; border: 1px solid var(--vscode-panel-border, #555); border-radius: 4px; cursor: pointer; }
header .openall:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.25)); }
ul { margin: 0; padding: 4px 0; list-style: none; }
/* 方案 A（2026-10-16 用户选定，doc/agents-botmode-mockup.html）：侧栏 =「消息」列表 —— 平铺行 + 悬停/选中底色
   （取代款 A 的卡片外壳）；副行 = 最近一条会话标题，右上角 = 最近活跃时间 */
.row { display: flex; gap: 8px; align-items: center; padding: 7px 8px; cursor: pointer; border-radius: 8px; border-left: 3px solid transparent; }
li { margin: 0 4px 1px; border: 1px solid transparent; border-radius: 8px; }
li:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
li.warned .row { border-left-color: #cca700; }
.avatar { position: relative; flex: 0 0 30px; width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; line-height: 1; color: #fff; }
.row { position: relative; }
.row .acts { display: none; gap: 4px; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); }
.row:hover .acts { display: flex; }
.row:hover .time { visibility: hidden; }
.row .acts button { font-size: 10px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--vscode-panel-border, #555); background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-foreground, #ccc); cursor: pointer; }
.row .acts button:hover { border-color: var(--vscode-focusBorder, #0e639c); }
.dot { position: absolute; right: -3px; bottom: -3px; width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--vscode-sideBar-background, #1e1e1e); background: #555; }
.dot.busy { background: #4ec9b0; }
.main { flex: 1; min-width: 0; }
.l1 { display: flex; align-items: baseline; gap: 6px; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.time { margin-left: auto; flex: none; font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
/* 名字旁的紫色角色标签（.agent.md 的 role 字段） */
.l1 .r { font-size: 10px; color: #c586c0; white-space: nowrap; }
.badge { font-size: 9.5px; line-height: 14px; padding: 0 6px; border-radius: 7px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); white-space: nowrap; }
.badge.dim { background: transparent; border: 1px solid var(--vscode-panel-border, #555); color: var(--vscode-descriptionForeground, #999); }
.l2 { color: var(--vscode-descriptionForeground, #999); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 9.5px; line-height: 13px; padding: 0 5px; border-radius: 3px; background: #7a3d2b; color: #fff; }
.empty { padding: 22px 12px; text-align: center; color: var(--vscode-descriptionForeground, #999); }
.empty b { display: block; color: var(--vscode-foreground, #ccc); font-size: 12.5px; margin-bottom: 4px; }
.empty .big { font-size: 28px; margin-bottom: 6px; }
.empty button { display: block; width: 100%; margin-top: 8px; padding: 5px; border-radius: 5px; cursor: pointer; font-size: 11.5px; border: 1px solid var(--vscode-panel-border, #555); background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-foreground, #ccc); }
.empty button.primary { background: var(--vscode-button-background, #0e639c); border-color: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
.glabel { font-size: 10px; color: var(--vscode-descriptionForeground, #999); padding: 8px 10px 2px; text-transform: uppercase; letter-spacing: .5px; }
/* 新建入口：标题栏「＋ 新建」菜单 + 名册底部虚线行 */
header { position: sticky; z-index: 5; }
header .newbtn { font-size: 11px; padding: 1px 8px; border-radius: 4px; cursor: pointer; border: 1px solid var(--vscode-panel-border, #555); background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-foreground, #ccc); }
header .newbtn:hover { border-color: var(--vscode-focusBorder, #0e639c); }
.newmenu { position: absolute; top: 30px; right: 6px; width: 210px; z-index: 20; padding: 4px; border-radius: 7px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #555)); background: var(--vscode-menu-background, #252526); box-shadow: 0 6px 18px rgba(0,0,0,.45); }
.newmenu div { padding: 5px 8px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.newmenu div small { display: block; font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); }
.newmenu div:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.newmenu hr { border: none; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); margin: 3px 2px; }
.newrow { display: flex; gap: 8px; align-items: center; margin: 4px 4px 2px; padding: 6px 8px; border: 1px dashed var(--vscode-panel-border, #555); border-radius: 8px; color: var(--vscode-descriptionForeground, #999); cursor: pointer; font-size: 11.5px; }
.newrow:hover { border-color: var(--vscode-focusBorder, #0e639c); color: var(--vscode-foreground, #ccc); }
.newrow .plus { flex: 0 0 28px; height: 28px; border-radius: 8px; border: 1px dashed var(--vscode-panel-border, #555); display: inline-flex; align-items: center; justify-content: center; font-size: 15px; }
.search { display: block; margin: 6px 6px 2px; }
.search input { width: 100%; box-sizing: border-box; font: inherit; font-size: 11.5px; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--vscode-input-border, #555); background: var(--vscode-input-background, #2a2a2a); color: var(--vscode-input-foreground, #ccc); }
.search input:focus { outline: none; border-color: var(--vscode-focusBorder, #0e639c); }
/* 未读角标（消息列表红点数字；跟副行右端） */
.l2 .unread { float: right; margin-left: 6px; min-width: 16px; height: 15px; line-height: 15px; padding: 0 4px; border-radius: 8px; background: var(--vscode-badge-background, #f14c4c); color: var(--vscode-badge-foreground, #fff); font-size: 9.5px; text-align: center; }
.note { margin: 0; padding: 5px 10px; color: var(--vscode-editorWarning-foreground, #cca700); font-size: 11px; }
footer { margin-top: 6px; padding: 7px 10px 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); color: var(--vscode-descriptionForeground, #999); font-size: 10.5px; overflow-wrap: anywhere; }`;

/**
 * 侧栏摘要页。
 * @param input.agents 扫描出的 agent 列表
 * @param input.summary summarizeAgents 结果
 * @param input.root agent 目录根（页脚自诊断）
 * @param input.missing 目录不存在时的路径
 * @param input.diagnostics 注册诊断（琥珀标 = 模型未映射）
 * @param input.roster dsh 花名册快照（判「未注册」）
 * @param input.liveRows liveForAgents 结果（状态灯 + 会话角标）
 * @param input.assignments listAssignments() 快照（2026-10-16，P1：运行中委派的角标）
 * @param input.unread 未读角标（2026-10-17，方案 A 收尾）：{ [agentId]: 上次查看后有活动的会话条数 }
 */
export function renderSideviewPage({ agents, summary, root, missing, diagnostics, roster, liveRows, assignments, groups, unread }) {
	const liveOf = new Map((liveRows ?? []).map(row => [row.agentId, row]));
	const notesOf = new Map((diagnostics ?? []).map(d => [d.agentId, d.notes ?? []]));
	// 每个 agent 的运行中委派数（台账是内存态，Host 重启清空——没有就不显示，不显示成 0 ✓）
	const runningOf = new Map();
	for (const item of assignments?.items ?? []) {
		if (item?.status === 'running' && typeof item.agentId === 'string') {
			runningOf.set(item.agentId, (runningOf.get(item.agentId) ?? 0) + 1);
		}
	}
	const rows = agents.map(a => {
		const live = liveOf.get(a.id);
		const sessions = live?.sessions ?? 0;
		const busy = sessions > 0;
		const assigned = runningOf.get(a.id) ?? 0;
		const registered = roster.includes(presetIdOf(a.id));
		const unmapped = (notesOf.get(a.id) ?? []).some(n => n.startsWith('模型未映射'));
		// 款 A：副行 = 职责 · 模型（mockup「联网检索研究员 · hy4」；两者都没有才退到未映射提示）
		const desc2 = [a.description, a.model].filter(Boolean).join(' · ') || (unmapped ? '模型未映射' : '');
		const avatar = '<span class="avatar" style="background:' + avatarColorOf(a.id) + '">'
			+ escapeHtml(a.icon ?? a.name.slice(0, 1))
			+ '<span class="dot' + (busy ? ' busy' : '') + '"></span></span>';
		const badge = (assigned > 0 ? '<span class="badge">委派 ' + assigned + '</span>' : '')
			+ (busy ? '<span class="badge">会话 ' + sessions + '</span>' : '');
		// 方案 A：副行优先放「最近一条会话标题」（消息列表的摘要位）；没有会话才退回 职责 · 模型
		const preview = live?.lastTitle || desc2;
		const time = agoShort(live?.lastActiveAt);
		// 未读角标（消息列表的红点数字；口径 = 上次点开后有活动的会话条数，见 lib/seen.js 头注释）
		const unreadN = unread?.[a.id] ?? 0;
		const unreadBadge = unreadN > 0 ? ' <span class="unread" data-unread-badge title="上次查看后有 ' + unreadN + ' 条会话有新活动（点开这条即清零）">' + (unreadN > 99 ? '99+' : unreadN) + '</span>' : '';
		return '<li' + (unmapped ? ' class="warned"' : '') + ' data-search="' + escapeHtml((a.id + ' ' + a.name + ' ' + (a.role ?? '') + ' ' + (a.description ?? '')).toLowerCase()) + '">'
			+ '<div class="row" data-agent-id="' + escapeHtml(a.id) + '" data-preset="' + escapeHtml(presetIdOf(a.id)) + '" data-live-sessions="' + sessions + '" onclick="openFull(this)"'
			+ ' title="在编辑区打开并定位到该 Agent">'
			+ avatar
			+ '<div class="main"><div class="l1"><span class="name">' + escapeHtml(a.name) + '</span>'
			+ (a.role ? '<span class="r">' + escapeHtml(a.role) + '</span>' : '')
			+ (registered ? '' : '<span class="tag">未注册</span>')
			+ badge + (time ? '<span class="time">' + escapeHtml(time) + '</span>' : '') + '</div>'
			+ '<div class="l2">' + escapeHtml(preview) + unreadBadge + '</div>'
			+ '</div>'
			// 悬停快捷动作（款 A）：会话 = 桥 newChat（新页签绑该 preset 会话 ✓）；委派 = 交接
			// 'delegate:<id>' 给编辑区完整页（开委派签并预选该 agent ✓）。stopPropagation 防穿透 ✓
			+ '<span class="acts"><button onclick="quickChat(event, this)">会话</button><button onclick="quickDelegate(event, this)">委派</button></span>'
			+ '</div></li>';
	}).join('');
	// 新建入口（2026-10-16，方案 A）：空名册 = 引导（两个起点直达向导）；非空 = 名册底部虚线行 ✓
	const newRow = '<div class="newrow" data-sv-new onclick="openCreate(\'blank\')"><span class="plus">＋</span><span>新建 Agent</span></div>';
	const guide = '<div class="empty" data-sv-empty><div class="big">🤖</div><b>还没有 Agent</b>建一个专属 Agent：它有自己的人格、模型、技能和记忆。'
		+ '<button class="primary" onclick="openCreate(\'blank\')">＋ 新建第一个 Agent</button><button onclick="openCreate(\'import\')">导入 .agent.md</button></div>';
	const body = missing
		? guide + '<p class="empty" style="padding-top:0;font-size:10.5px">agent 目录还不存在：<br><code>' + escapeHtml(missing) + '</code><br>建第一个 Agent 时会自动创建。</p>'
		: (rows ? '<label class="search"><input id="svQ" placeholder="搜索 Agent" oninput="svFilter()"></label><ul>' + rows + '</ul>' + newRow : guide);
	// 群聊区（2026-10-16，二期）：有群才显示（建群入口在编辑区群聊页签，侧栏不重复造 ✓）；
	// 点条目 → 交接 'group:<id>' → 编辑区开群聊页签并选中 ✓
	const groupList = groups?.groups ?? [];
	const groupRows = groupList.map(g =>
		'<li><div class="row" data-group-id="' + escapeHtml(g.id) + '" onclick="openGroup(this)" title="在编辑区打开群聊">'
		+ '<span class="avatar" style="background:#444">#</span>'
		+ '<div class="main"><div class="l1"><span class="name">' + escapeHtml(g.name) + '</span></div>'
		+ '<div class="l2">' + (g.mode === 'open' ? 'open' : 'admin') + ' · 成员 ' + (g.members?.length ?? 0) + '</div></div>'
		+ '</div></li>').join('');
	const groupsHtml = groupList.length
		? '<div class="glabel">群聊</div><ul data-vssaros-groups>' + groupRows + '</ul>'
		: '';
	const ours = roster.filter(id => id.startsWith('vssaros-'));
	const footer = '<footer data-sideview-count="' + summary.count + '">'
		+ '已注册 ' + ours.length + ' · 点条目在编辑区打开</footer>';

	const script = '<script>'
		+ 'var FOCUS_KEY = "vssaros.agents.focus";'
		// 点条目：先写焦点交接（同源 localStorage，完整页加载时消费 / 已开着时走 storage 事件），
		// 再请宿主在编辑区打开完整页（openModulePage 白名单只认模块页表路由 ✓）。
		+ 'function openFull(el) {'
		+ "var id = el && el.getAttribute ? el.getAttribute('data-agent-id') : '';"
		+ 'if (id) { try { if (window.localStorage) { localStorage.setItem(FOCUS_KEY, id + "|" + Date.now()); } } catch (e) {} }'
		// 点开 = 看过（未读角标清零；函数在下方 create 段里，同一个 script ✓）
		+ 'if (id && window.svSeenNow) { svSeenNow(id); }'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		+ "try { bridge.openModulePage('/x/agents/'); note(''); } catch (e) { note('打开编辑区页面失败：' + e); }"
		+ '}'
		// 点群条目：交接 'group:<id>'（detail 页 applyFocus 认这个前缀 ⇒ 开群聊页签选中该群 ✓）
		+ 'function openGroup(el) {'
		+ "var id = el && el.getAttribute ? el.getAttribute('data-group-id') : '';"
		+ 'if (id) { try { if (window.localStorage) { localStorage.setItem(FOCUS_KEY, "group:" + id + "|" + Date.now()); } } catch (e) {} }'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		+ "try { bridge.openModulePage('/x/agents/'); note(''); } catch (e) { note('打开编辑区页面失败：' + e); }"
		+ '}'
		// 快捷动作（款 A）：会话 = 桥 newChat 开绑定该 preset 的新会话页签；委派 = 交接 delegate:<id>
		// 给编辑区完整页（那边开委派签并预选）⇒ 两步都经宿主/交接，页面自己做不了 ✓
		+ 'function quickChat(ev, el) {'
		+ 'ev.stopPropagation();'
		+ "var row = el.closest('.row');"
		+ "var preset = row ? row.getAttribute('data-preset') : '';"
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.newChat !== 'function') { note('当前宿主不支持从这里开会话（需要带 newChat 的宿主）'); return; }"
		+ "if (!preset) { note('没拿到该 agent 的 preset id'); return; }"
		+ "try { bridge.newChat(preset); note(''); } catch (e) { note('开会话失败：' + e); }"
		+ '}'
		+ 'function quickDelegate(ev, el) {'
		+ 'ev.stopPropagation();'
		+ "var row = el.closest('.row');"
		+ "var id = row ? row.getAttribute('data-agent-id') : '';"
		+ 'if (id) { try { if (window.localStorage) { localStorage.setItem(FOCUS_KEY, "delegate:" + id + "|" + Date.now()); } } catch (e) {} }'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		+ "try { bridge.openModulePage('/x/agents/'); note(''); } catch (e) { note('打开委派页失败：' + e); }"
		+ '}'
		+ 'function openFullPage() {'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		+ "try { bridge.openModulePage('/x/agents/'); note(''); } catch (e) { note('打开编辑区页面失败：' + e); }"
		+ '}'
		+ 'function note(text) {'
		+ "var el = document.getElementById('svNote');"
		+ 'if (!el) { return; }'
		+ "if (!text) { el.hidden = true; el.textContent = ''; return; }"
		+ 'el.textContent = text;'
		+ 'el.hidden = false;'
		+ '}'
		+ SIDEVIEW_CREATE_JS
		+ '</script>';

	const newMenu = '<div class="newmenu" id="svNewMenu" hidden data-sv-newmenu>'
		+ '<div onclick="openCreate(\'blank\')">✎ 新建 Agent…<small>三步：起点 → 填写 → 完成</small></div>'
		+ '<div onclick="openCreate(\'copy\')">❏ 复制已有 Agent<small>在现成的基础上改</small></div>'
		+ '<div onclick="openCreate(\'import\')">⇪ 导入 .agent.md<small>粘贴别处的定义原文</small></div>'
		+ '<hr><div onclick="newGroup()"># 新建群聊<small>在编辑区「群聊」签里建</small></div></div>';

	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Agents · 消息</title>
<style>
${SIDEVIEW_CSS}
</style>
</head>
<body data-vssaros-page="agents-sideview" data-vssaros-surface="sideview">
<header>
	<h1>消息 <span class="n">${summary.count}</span></h1>
	<button class="newbtn" style="margin-left:auto" onclick="toggleNewMenu(event)" title="新建 Agent / 群聊">＋ 新建</button>
	<button class="openall" style="margin-left:0" onclick="openFullPage()" title="在编辑区打开完整页">⇗</button>
	${newMenu}
</header>
<p class="note" id="svNote" hidden></p>
${body}
${groupsHtml}
${footer}
${script}
</body>
</html>`;
}

/* eslint-disable */
// ↓ 浏览器端（toString 内联进页面脚本，与主脚本同一个 script 标签）：新建入口 + 搜索 + 新建后刷新。
// 不引用模块作用域；交接复用主脚本的 FOCUS_KEY / note（同一个全局作用域 ✓）。
function sideviewCreateClient() {
	function handoff(value) {
		try { if (window.localStorage) { localStorage.setItem(FOCUS_KEY, value + '|' + Date.now()); } } catch (e) {}
		var bridge = window.vssarosDsh;
		if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }
		try { bridge.openModulePage('/x/agents/'); note(''); } catch (e) { note('打开编辑区页面失败：' + e); }
	}
	window.openCreate = function (kind) { closeMenu(); handoff('create:' + (kind || 'blank')); };
	window.newGroup = function () { closeMenu(); handoff('tab:groups'); };
	function closeMenu() { var m = document.getElementById('svNewMenu'); if (m) { m.hidden = true; } }
	window.toggleNewMenu = function (ev) {
		if (ev) { ev.stopPropagation(); }
		var m = document.getElementById('svNewMenu');
		if (m) { m.hidden = !m.hidden; }
	};
	document.addEventListener('click', function (e) {
		var m = document.getElementById('svNewMenu');
		if (m && !m.hidden && !(e.target.closest && e.target.closest('#svNewMenu'))) { m.hidden = true; }
	});
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); } });
	window.svFilter = function () {
		var box = document.getElementById('svQ');
		var q = box ? box.value.trim().toLowerCase() : '';
		var all = document.querySelectorAll('li[data-search]');
		for (var i = 0; i < all.length; i++) { var t = all[i].getAttribute('data-search') || ''; all[i].hidden = !!q && t.indexOf(q) < 0; }
	};
	// 编辑区向导建好一个 Agent ⇒ 写同源 localStorage 的 vssaros.agents.changed ⇒ 这里刷新名册 ✓
	window.addEventListener('storage', function (e) { if (e && e.key === 'vssaros.agents.changed' && e.newValue) { location.reload(); } });
	// ── 未读角标（2026-10-17）──────────────────────────────────────────────
	// badge 在 .l2 末尾（服务端首屏已带）；轮询只就地改角标，**不整页重载** ✓
	function applyUnread(counts) {
		var rows = document.querySelectorAll('.row[data-agent-id]');
		for (var i = 0; i < rows.length; i++) {
			var id = rows[i].getAttribute('data-agent-id');
			var n = counts && counts[id] > 0 ? counts[id] : 0;
			var l2 = rows[i].querySelector('.l2');
			if (!l2) { continue; }
			var badge = l2.querySelector('[data-unread-badge]');
			if (n > 0) {
				if (!badge) {
					badge = document.createElement('span');
					badge.className = 'unread';
					badge.setAttribute('data-unread-badge', '1');
					l2.appendChild(document.createTextNode(' '));
					l2.appendChild(badge);
				}
				badge.textContent = n > 99 ? '99+' : String(n);
				badge.title = '上次查看后有 ' + n + ' 条会话有新活动（点开这条即清零）';
			} else if (badge) { badge.remove(); }
		}
	}
	window.svSeenNow = function (id) {
		var li = document.querySelector('.row[data-agent-id="' + id + '"]');
		var badge = li ? li.querySelector('[data-unread-badge]') : null;
		if (badge) { badge.remove(); }   // 本地先清（别等 POST 回来 ✓）
		try {
			fetch('/x/agents/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'seen', id: id }) })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (j) { if (j && j.counts) { applyUnread(j.counts); } })
				.catch(function () {});
		} catch (e) {}
	};
	var unreadStopped = false;
	function pollUnread() {
		if (unreadStopped || document.hidden) { return; }
		fetch('/x/agents/api/unread').then(function (r) {
			if (r.status === 404) { unreadStopped = true; return null; }   // 老版本插件：停轮询（首屏角标还在 ✓）
			return r.ok ? r.json() : null;
		}).then(function (j) { if (j && j.counts) { applyUnread(j.counts); } }).catch(function () {});
	}
	setInterval(pollUnread, 15000);
}
/* eslint-enable */
const SIDEVIEW_CREATE_JS = '(' + sideviewCreateClient.toString() + ')();';
