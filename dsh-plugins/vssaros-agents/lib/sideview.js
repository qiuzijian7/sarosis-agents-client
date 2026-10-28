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
import { renderAvatarContent } from './core/iconRender.js';

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
.glabel { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--vscode-descriptionForeground, #999); padding: 8px 10px 2px; text-transform: uppercase; letter-spacing: .5px; }
/* 群聊区（2026-10-21 方案 A）：新建按钮 + 每行「聊天」按钮 */
.gnew { margin-left: auto; width: 18px; height: 18px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground, #999); font-size: 12px; }
.gnew:hover { background: rgba(128,128,128,.2); color: var(--vscode-foreground, #ccc); }
.gempty { padding: 4px 10px 8px; font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); }
.gchat { margin-left: auto; flex: none; font-size: 10px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); color: var(--vscode-descriptionForeground, #999); background: transparent; }
/* 群未读：数字角标；空值用 :empty 隐藏（这样轮询可以直接改 textContent，不用增删节点） */
.gunread { margin-left: 6px; flex: none; font-size: 9px; line-height: 14px; color: #fff; background: var(--vscode-activityBarBadge-background, #0e639c); border-radius: 7px; padding: 0 5px; }
.gunread:empty { display: none; }
.gchat:hover { border-color: var(--vscode-focusBorder, #0e639c); color: var(--vscode-foreground, #ccc); }
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
footer { margin-top: 6px; padding: 7px 10px 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); color: var(--vscode-descriptionForeground, #999); font-size: 10.5px; overflow-wrap: anywhere; }
/* 右键菜单（2026-10-19 用户要求：agent item 右键弹 menu）—— fixed 定位，绝不放进任何 overflow 容器 */
.ctxmenu { position: fixed; z-index: 40; min-width: 212px; max-width: 320px; padding: 4px; border-radius: 7px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #555)); background: var(--vscode-menu-background, #252526); color: var(--vscode-menu-foreground, var(--vscode-foreground, #ccc)); box-shadow: 0 8px 22px rgba(0,0,0,.5); }
.ctxmenu .hd { padding: 4px 8px 3px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctxmenu .it { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 5px; cursor: pointer; font-size: 12px; white-space: nowrap; }
.ctxmenu .it .ic { flex: 0 0 14px; text-align: center; opacity: .9; }
.ctxmenu .it .lb { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
.ctxmenu .it:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground, #094771)); color: var(--vscode-menu-selectionForeground, #fff); }
.ctxmenu hr { border: none; border-top: 1px solid var(--vscode-menu-separatorBackground, rgba(128,128,128,.3)); margin: 3px 2px; }
/* 危险项（删除 Agent）：文字用错误色 + 悬停淡红，避免和日常操作混淆 */
.ctxmenu .it[data-act="delete-agent"] .lb { color: var(--vscode-errorForeground, #f48771); }
.ctxmenu .it[data-act="delete-agent"]:hover { background: rgba(244,135,113,.14); }
.dlg .dbtn.danger { background: #a1262a; border-color: transparent; color: #fff; }
.dlg .dbtn.danger:hover { filter: brightness(1.15); }
/* 对话框（2026-10-19：DSB 导入的「先预览再写盘」）——fixed 居中，不被侧栏 overflow 裁 */
.dlg { position: fixed; z-index: 60; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 64px); display: flex; flex-direction: column; border-radius: 10px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #555)); background: var(--vscode-menu-background, #252526); color: var(--vscode-menu-foreground, var(--vscode-foreground, #ccc)); box-shadow: 0 16px 48px rgba(0,0,0,.55); }
/* ⚠ 必须显式写 .dlg[hidden]：.dlg 的 display:flex 会盖掉浏览器默认的 [hidden]{display:none} ⇒ 隐藏失效 */
.dlg[hidden] { display: none; }
.dlg .dhd { display: flex; align-items: center; gap: 8px; padding: 9px 10px; font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--vscode-menu-separatorBackground, rgba(128,128,128,.3)); }
.dlg .dhd .dbtn { margin-left: auto; }
.dlg .dbd { padding: 8px 10px; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.dlg .drow { display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; }
.dlg .dk { flex: 0 0 46px; color: var(--vscode-descriptionForeground, #999); }
.dlg .dv { flex: 1 1 auto; overflow-wrap: anywhere; }
.dlg .dv.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.dlg .dlist { max-height: 168px; overflow: auto; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 6px; padding: 4px 6px; font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.dlg .dli { padding: 2px 0; overflow-wrap: anywhere; }
.dlg .dinput { flex: 1 1 auto; min-width: 0; font: inherit; font-size: 11.5px; padding: 3px 6px; border-radius: 5px; border: 1px solid var(--vscode-input-border, #555); background: var(--vscode-input-background, #2a2a2a); color: var(--vscode-input-foreground, #ccc); }
.dlg .dft { display: flex; gap: 8px; justify-content: flex-end; padding: 8px 10px; border-top: 1px solid var(--vscode-menu-separatorBackground, rgba(128,128,128,.3)); }
.dlg .dbtn { border: 1px solid var(--vscode-button-border, rgba(128,128,128,.4)); background: transparent; color: inherit; font-size: 11.5px; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.dlg .dbtn.primary { background: var(--vscode-button-background, #0e639c); border-color: transparent; color: var(--vscode-button-foreground, #fff); }
.dlg .dbtn:hover { filter: brightness(1.12); }`;

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
			+ renderAvatarContent(a.icon, a.name.slice(0, 1), { size: 16 })
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
			+ '<div class="row" data-agent-id="' + escapeHtml(a.id) + '" data-preset="' + escapeHtml(presetIdOf(a.id)) + '"'
			+ ' data-agent-name="' + escapeHtml(a.name) + '" data-agent-file="' + escapeHtml(a.file ?? '') + '"'
		// 来源（builtin / custom）：右键菜单据此决定能不能「删除 Agent」（内置删了也会被重新生成）
		+ ' data-agent-source="' + escapeHtml(a.source ?? 'custom') + '"'
			+ ' data-live-sessions="' + sessions + '" onclick="openFull(this)" oncontextmenu="svMenu(event, this)"'
			+ ' title="点击在编辑区打开；右键更多操作">'
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
		// 群头像（2026-10-21）：有图就用图，没图仍是 #
		+ (g.avatar
			? '<span class="avatar" style="background:#444;overflow:hidden"><img src="' + escapeHtml(g.avatar) + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></span>'
			: '<span class="avatar" style="background:#444">#</span>')
		// 群未读角标（2026-10-21）：服务端首屏带上，之后由 15s 轮询就地改（空 = CSS 隐藏）
		+ '<div class="main"><div class="l1"><span class="name">' + escapeHtml(g.name) + '</span>'
		+ '<span class="gunread" data-group-unread="' + escapeHtml(g.id) + '">' + (g.unread > 0 ? g.unread : '') + '</span></div>'
		+ '<div class="l2">' + (g.mode === 'open' ? 'open' : 'admin') + ' · 成员 ' + (g.members?.length ?? 0) + '</div></div>'
		// 「聊天」按钮（2026-10-21 方案 A，用户要求）：直接开**编辑区群聊页签**并选中这个群。
		// 与整行点击的区别是刻意的：整行仍是老的"交接 focus → 详情页群聊签"（兼容既有探针），
		// 新按钮走 `openModulePage('/x/agents/group?group=…')` ⇒ 独立页签、可多开、可拖分屏。
		+ '<button class="gchat" data-group-chat="' + escapeHtml(g.id) + '" onclick="chatGroup(event, this)" title="在编辑区打开群聊">聊天</button>'
		+ '</div></li>').join('');
	// 新建群聊按钮（同上）：即使一个群都没有也要有（否则空态下没有入口 ✗）
	const groupsHtml = '<div class="glabel">群聊'
		+ '<button class="gnew" data-group-new onclick="newGroupPage(event)" title="新建群聊（在编辑区打开）">＋</button></div>'
		+ (groupList.length
			? '<ul data-vssaros-groups>' + groupRows + '</ul>'
			: '<div class="gempty">还没有群聊 · 点 ＋ 新建</div>');
	// 委派专用 preset（`<preset>-assign`）不算"已注册的 Agent"（与本体是同一个 agent，见 core/agents.js）
	const ours = roster.filter(id => id.startsWith('vssaros-') && !/-assign$/.test(id));
	const footer = '<footer data-sideview-count="' + summary.count + '">'
		+ '已注册 <span data-sv-count>' + ours.length + '</span> · 点条目在编辑区打开</footer>';

	const script = '<script>'
		+ 'var FOCUS_KEY = "vssaros.agents.focus";'
		// 点条目：先写焦点交接（同源 localStorage，完整页加载时消费 / 已开着时走 storage 事件），
		// 再请宿主在编辑区打开完整页（openModulePage 白名单只认模块页表路由 ✓）。
		/*
		 * ★ 2026-10-27（方案 C2）：点条目改成**分栏打开** ——
		 *   中栏开会话（`bridge.newChat(preset)`，新页签绑该 bot 人格）
		 *   + 右栏开设置（`bridge.openAgentSettings(id)`，IDE 的 Agent 设置编辑器页）。
		 *   两个能力都在时**不再**打开编辑区整页（整页是 C1 的老形态，会盖掉分栏）。
		 *   ⚠ 缺任一能力（老桥）⇒ 退回 `openModulePage('/x/agents/')` 打开整页，
		 *     并如实提示，不静默 ✗。
		 */
		+ 'function openAgent(id, preset) {'
		+ 'if (!id) { return; }'
		+ 'try { if (window.localStorage) { localStorage.setItem(FOCUS_KEY, id + "|" + Date.now()); } } catch (e) {}'
		// 点开 = 看过（未读角标清零；函数在下方 create 段里，同一个 script ✓）
		+ 'if (window.svSeenNow) { svSeenNow(id); }'
		+ 'var bridge = window.vssarosDsh;'
		// ★ 首选：`openBot`（桥 21）—— 由**宿主**布局：chat 进当前组、设置开在右侧新组，
		//   顺序与分组都不受页面控制，避免"设置把会话挤走"。
		+ "if (bridge && typeof bridge.openBot === 'function') { try { bridge.openBot(id); note('已在中栏打开会话、右栏打开设置'); return; } catch (e) {} }"
		// 兜底（老桥）：连调两个方法；两次调用都可能落在同一组，所以只承诺"都开了"，不承诺布局
		+ 'var ok = 0;'
		+ "if (bridge && typeof bridge.newChat === 'function' && preset) { try { bridge.newChat(preset); ok++; } catch (e) {} }"
		+ "if (bridge && typeof bridge.openAgentSettings === 'function') { try { bridge.openAgentSettings(id); ok++; } catch (e) {} }"
		+ 'if (ok >= 2) { note("已打开会话与设置（老桥：可能在同一组）"); return; }'
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		+ "try { bridge.openModulePage('/x/agents/'); note(''); } catch (e) { note('打开编辑区页面失败：' + e); }"
		+ '}'
		+ 'function openFull(el) {'
		+ "var row = el && el.closest ? el.closest('.row') : null;"
		+ "openAgent(row ? row.getAttribute('data-agent-id') : '', row ? row.getAttribute('data-preset') : '');"
		+ '}'
		// 点群条目：交接 'group:<id>'（detail 页 applyFocus 认这个前缀 ⇒ 开群聊页签选中该群 ✓）
		+ 'function openGroup(el) {'
		+ "var id = el && el.getAttribute ? el.getAttribute('data-group-id') : '';"
		+ 'if (id) { try { if (window.localStorage) { localStorage.setItem(FOCUS_KEY, "group:" + id + "|" + Date.now()); } } catch (e) {} }'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		+ "try { bridge.openModulePage('/x/agents/'); note(''); } catch (e) { note('打开编辑区页面失败：' + e); }"
		+ '}'
		// 群聊页（2026-10-21 方案 A）：`openModulePage` 的白名单按**前缀**归属；
		// `/x/agents/group?group=<id>` 仍以 `/x/agents/` 开头 ⇒ 宿主认它属于 agents 容器，
		// 而 `DshPluginPageEditorInput` 的单例键 = 容器 + 子路由 ⇒ **每个群一个 tab** ✓
		+ 'function chatGroup(ev, el) {'
		+ 'if (ev && ev.stopPropagation) { ev.stopPropagation(); }'
		+ "var id = el && el.getAttribute ? el.getAttribute('data-group-chat') : '';"
		+ 'if (!id) { return; }'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		// ⚠ 群 id 走**路径段**：桥的 `openModulePage` 只放 `[A-Za-z0-9._~/-]`（查询串会被丢掉）。
		//   `/x/agents/group/<id>` 同时让编辑区输入的单例键"容器 + 子路由"天然一群一 tab ✓
		+ "if (!/^[A-Za-z0-9._-]+$/.test(id)) { note('群 id 含非法字符，无法打开：' + id); return; }"
		+ "try { bridge.openModulePage('/x/agents/group/' + id); note(''); } catch (e) { note('打开群聊页失败：' + e); }"
		+ '}'
		+ 'function newGroupPage(ev) {'
		+ 'if (ev && ev.stopPropagation) { ev.stopPropagation(); }'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		// 新建也是路径段（`/new` 是保留段，不与群 id 冲突：id 是 uuid）
		+ "try { bridge.openModulePage('/x/agents/group/new'); note(''); } catch (e) { note('打开群聊页失败：' + e); }"
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
		// ── 右键菜单（2026-10-19 用户要求）────────────────────────────────────────
		// 行上「点击 = 在编辑区打开」；二级动作（换会话/委派/记忆/设置/复制路径/打开 md）不该常驻占位
		// ⇒ 右键弹。fixed 定位 + 视口夹取（不会被祖先 overflow 裁 ✓；锚点 = 鼠标点）。
		+ 'var CTX = { id: "", preset: "", name: "", file: "" };'
		+ 'function svCtxInfo(el) {'
		+ "var row = el && el.closest ? el.closest('.row') : null;"
		+ "if (!row || !row.getAttribute('data-agent-id')) { return null; }"
		+ "return { id: row.getAttribute('data-agent-id'), preset: row.getAttribute('data-preset') || '', name: row.getAttribute('data-agent-name') || '', file: row.getAttribute('data-agent-file') || '', source: row.getAttribute('data-agent-source') || 'custom' };"
		+ '}'
		+ 'function svCtxClose() {'
		+ "var m = document.getElementById('svCtx');"
		+ "if (m) { m.hidden = true; m.innerHTML = ''; }"
		+ '}'
		+ 'function svCtxItem(act, icon, label) {'
		+ "var d = document.createElement('div');"
		+ "d.className = 'it'; d.setAttribute('data-act', act);"
		+ "var i = document.createElement('span'); i.className = 'ic'; i.textContent = icon;"
		+ "var l = document.createElement('span'); l.className = 'lb'; l.textContent = label;"
		+ 'd.appendChild(i); d.appendChild(l);'
		+ "d.addEventListener('click', function (e) { e.stopPropagation(); svCtxClose(); svCtxAct(act); });"
		+ 'return d;'
		+ '}'
		+ 'function svCopy(text) {'
		+ 'if (!text) { note("这条没有可复制的路径（agent 没落盘？）"); return; }'
		// ⚠ 剪贴板 API 在无权限的容器里可能**既不 resolve 也不 reject**（真机实测：点了没提示 ✗）
		//   ⇒ 400ms 后强制走 textarea+execCommand 兜底，保证"复制"永远有可见反馈。
		+ 'var settled = false;'
		+ 'function finish(msg) { if (settled) { return; } settled = true; note(msg); }'
		+ 'function fallback() {'
		+ 'if (settled) { return; }'
		+ 'try {'
		+ "var ta = document.createElement('textarea'); ta.value = text;"
		+ "ta.style.position = 'fixed'; ta.style.opacity = '0';"
		+ 'document.body.appendChild(ta); ta.select();'
		+ "document.execCommand('copy'); document.body.removeChild(ta);"
		+ "finish('已复制：' + text);"
		+ "} catch (e) { finish('复制失败：' + e); }"
		+ '}'
		+ 'try {'
		+ 'if (navigator.clipboard && navigator.clipboard.writeText) {'
		+ "navigator.clipboard.writeText(text).then(function () { finish('已复制：' + text); }, fallback);"
		+ 'setTimeout(fallback, 400);'
		+ 'return;'
		+ '}'
		+ '} catch (e) { /* 落到兜底 */ }'
		+ 'fallback();'
		+ '}'
		+ 'function svCtxAct(act) {'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (act === 'open') { openAgent(CTX.id); return; }"
		+ "if (act === 'chat') {"
		+ "if (!bridge || typeof bridge.newChat !== 'function') { note('当前宿主不支持从这里开会话（需要带 newChat 的宿主）'); return; }"
		+ "if (!CTX.preset) { note('没拿到该 agent 的 preset id'); return; }"
		+ "try { bridge.newChat(CTX.preset); note(''); } catch (e) { note('开会话失败：' + e); }"
		+ 'return; }'
		+ "if (act === 'delegate' || act === 'memory') {"
		+ 'var prefix = act === "delegate" ? "delegate:" : "memory:";'
		+ "try { if (window.localStorage) { localStorage.setItem(FOCUS_KEY, prefix + CTX.id + '|' + Date.now()); } } catch (e) {}"
		+ "if (!bridge || typeof bridge.openModulePage !== 'function') { note('当前宿主不支持在编辑区打开（需要桥版本 3+ 的宿主）'); return; }"
		+ "try { bridge.openModulePage('/x/agents/'); note(''); } catch (e) { note('打开编辑区页面失败：' + e); }"
		+ 'return; }'
		+ "if (act === 'settings') {"
		+ "if (!bridge || typeof bridge.openAgentSettings !== 'function') { note('当前宿主不支持从这里打开 Agent 设置（需要桥版本 6+）'); return; }"
		+ 'try {'
		+ 'var p1 = bridge.openAgentSettings(CTX.id, CTX.name || CTX.id);'
		+ "if (p1 && typeof p1.catch === 'function') { p1.catch(function (e) { note('打开设置失败：' + e); }); }"
		+ "} catch (e) { note('打开设置失败：' + e); }"
		+ 'return; }'
		// 导出（2026-10-19）：先弹确认框再写盘 —— 记忆文件可能含私人信息，**默认不打包**，
		// 由用户勾选。页面没有"保存对话框"的桥 ⇒ 仍让 Host 写到 <dataRoot>/exports/，成功后再 reveal。
		+ "if (act === 'export-zip') {"
		+ 'svExportOpen();'
		+ 'return; }'
		// 删除（2026-10-20）：先弹确认框讲清"会一起删掉什么"，再落盘
		+ "if (act === 'delete-agent') {"
		+ 'svDeleteOpen();'
		+ 'return; }'
		+ "if (act === 'copy-id') { svCopy(CTX.id); return; }"
		+ "if (act === 'copy-file') { svCopy(CTX.file); return; }"
		+ "if (act === 'open-md') {"
		+ "if (!bridge || typeof bridge.openFile !== 'function') { note('当前宿主不支持打开文件（需要桥版本 3+）'); return; }"
		+ 'try {'
		+ 'var p2 = bridge.openFile(CTX.file);'
		+ "if (p2 && typeof p2.catch === 'function') { p2.catch(function (e) { note('打开文件失败：' + e); }); }"
		+ "} catch (e) { note('打开文件失败：' + e); }"
		+ 'return; }'
		+ '}'
		+ 'function svMenu(ev, el) {'
		+ 'ev.preventDefault(); ev.stopPropagation();'
		+ 'var info = svCtxInfo(el);'
		+ 'if (!info) { return; }'
		+ 'CTX = info;'
		+ "var m = document.getElementById('svCtx'); if (!m) { return; }"
		+ "m.innerHTML = '';"
		+ "var hd = document.createElement('div'); hd.className = 'hd'; hd.textContent = info.name || info.id; m.appendChild(hd);"
		+ "m.appendChild(svCtxItem('open', '⎘', '在编辑区打开'));"
		+ "m.appendChild(svCtxItem('chat', '✳', '发起会话（新页签）'));"
		+ "m.appendChild(svCtxItem('delegate', '⇢', '委派任务'));"
		+ "m.appendChild(svCtxItem('memory', '🧠', '探索记忆'));"
		+ "m.appendChild(svCtxItem('settings', '⚙', 'Agent 设置'));"
		+ "m.appendChild(svCtxItem('export-zip', '⤓', '导出 Agent 包（.zip）'));"
		+ 'm.appendChild(document.createElement("hr"));'
		+ "m.appendChild(svCtxItem('copy-id', '⧉', '复制 Agent ID'));"
		+ "if (info.file) { m.appendChild(svCtxItem('copy-file', '⧉', '复制 .agent.md 路径')); m.appendChild(svCtxItem('open-md', '↗', '在编辑器中打开 .agent.md')); }"
		+ 'else { m.appendChild(svCtxItem("copy-file", "⧉", "复制定义文件路径（未知）")); }'
		// 删除（2026-10-20 用户要求）：放在最下面 + 分隔线 + 危险色，避免和日常操作混在一起。
		// 只对**自定义** agent 显示（内置的在代码里、删了下次启动还会生成，服务端也会 403）。
		+ "if (info.source !== 'builtin') {"
		+ 'm.appendChild(document.createElement("hr"));'
		+ "m.appendChild(svCtxItem('delete-agent', '🗑', '删除 Agent…'));"
		+ '}'
		+ 'm.hidden = false;'
		+ "m.style.left = '0px'; m.style.top = '0px';"
		+ 'var r = m.getBoundingClientRect();'
		+ 'var x = Math.min(ev.clientX, window.innerWidth - r.width - 6);'
		+ 'var y = Math.min(ev.clientY, window.innerHeight - r.height - 6);'
		+ "m.style.left = Math.max(4, x) + 'px'; m.style.top = Math.max(4, y) + 'px';"
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
		// ── 从 DeepSeekBot 导入（2026-10-19）：**先预览再写盘** ─────────────────────
		// 为什么两步：包里可能有会被拍平的子目录记忆、有要丢弃的条目（git bundle）、也可能 id 撞车；
		// 直接写进去再报错，用户得先清掉半成品（体验差且难解释）。所以先 `dryRun: true` 拿计划，
		// 弹框让人确认 id / 记忆映射 / 跳过项 / 提示，点「导入」才真正落盘。
		+ 'var DLG = { zip: "", soul: "", file: "", plan: null, busy: false };'
		+ 'function svDlgClose() {'
		+ "var d = document.getElementById('svDlg');"
		+ "if (d) { d.hidden = true; d.innerHTML = ''; }"
		+ 'DLG.busy = false;'
		+ '}'
		+ 'function svDlgRow(k, v, mono) {'
		+ "var r = document.createElement('div'); r.className = 'drow';"
		+ "var a = document.createElement('span'); a.className = 'dk'; a.textContent = k;"
		+ "var b = document.createElement('span'); b.className = 'dv' + (mono ? ' mono' : ''); b.textContent = v;"
		+ 'r.appendChild(a); r.appendChild(b); return r;'
		+ '}'
		+ 'function svDlgBtn(label, act, primary) {'
		+ "var b = document.createElement('button'); b.type = 'button';"
		+ "b.className = 'dbtn' + (primary ? ' primary' : ''); b.textContent = label;"
		+ "b.setAttribute('data-sv-dlg-act', act);"
		+ "b.addEventListener('click', function () { svDlgAct(act); });"
		+ 'return b;'
		+ '}'
		+ 'function svDlgOpen(title, bodyNodes, footNodes) {'
		+ "var d = document.getElementById('svDlg'); if (!d) { return; }"
		+ "d.innerHTML = '';"
		+ "var hd = document.createElement('div'); hd.className = 'dhd';"
		+ "var titleEl = document.createElement('span'); titleEl.textContent = title; hd.appendChild(titleEl);"
		+ "var closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'dbtn';"
		+ "closeBtn.textContent = '✕'; closeBtn.setAttribute('data-sv-dlg-close', '1');"
		+ "closeBtn.addEventListener('click', svDlgClose); hd.appendChild(closeBtn);"
		+ "var bd = document.createElement('div'); bd.className = 'dbd';"
		+ 'for (var i = 0; i < bodyNodes.length; i++) { bd.appendChild(bodyNodes[i]); }'
		+ "var ft = document.createElement('div'); ft.className = 'dft';"
		+ 'for (var j = 0; j < footNodes.length; j++) { ft.appendChild(footNodes[j]); }'
		+ 'd.appendChild(hd); d.appendChild(bd); d.appendChild(ft); d.hidden = false;'
		+ '}'
		+ 'function svDlgAct(act) {'
		+ "if (act === 'cancel') { svDlgClose(); return; }"
		+ "if (act === 'import') { svImportCommit(false); return; }"
		+ "if (act === 'overwrite') { svImportCommit(true); return; }"
		+ "if (act === 'export') { svExportCommit(); return; }"
		+ "if (act === 'delete') { svDeleteCommit(); return; }"
		+ "if (act === 'reveal') {"
		+ "try { if (window.vssarosDsh && typeof window.vssarosDsh.reveal === 'function' && CTX.lastPath) { window.vssarosDsh.reveal(CTX.lastPath); } } catch (e) {}"
		+ 'svDlgClose();'
		+ 'return; }'
		+ '}'
		// 删除确认框（2026-10-20）：把"会一起删掉什么"讲清楚，再让人点红色按钮。
		// ⚠ 不可撤销 —— 所以这里**不做**"输入名字确认"那种花活（侧栏场景下太长），
		//   但必须列出：定义文件、memory/（记忆）、.git（历史），以及"内置 agent 不能删"的口径。
		+ 'function svDeleteOpen() {'
		+ "if (!CTX || !CTX.id) { return; }"
		+ "if (CTX.source === 'builtin') { note('内置 agent 不能删除（定义在代码里，删了下次启动还会生成）'); return; }"
		+ 'var nodes = [];'
		+ "nodes.push(svDlgRow('Agent', (CTX.name || CTX.id) + '（' + CTX.id + '）'));"
		+ "nodes.push(svDlgRow('删除', CTX.file ? CTX.file.replace(/[\\\\/][^\\\\/]+$/, '') : '该 agent 的整个目录'));"
		+ "nodes.push(svDlgRow('同时删掉', 'memory/（全部记忆）· .git（版本历史）· 该目录下所有文件'));"
		+ "nodes.push(svDlgRow('不可撤销', '删掉后无法在页面里恢复；要留档请先「导出 Agent 包」'));"
		+ 'var del = svDlgBtn("删除", "delete", false);'
		+ "del.className = 'dbtn danger';"
		+ 'del.setAttribute("data-sv-delete-commit", "1");'
		+ "svDlgOpen('删除 Agent', nodes, [svDlgBtn('取消', 'cancel', true), del]);"
		+ '}'
		+ 'function svDeleteCommit() {'
		+ "if (!CTX || !CTX.id || DLG.busy) { return; }"
		+ 'DLG.busy = true;'
		+ "note('正在删除 ' + CTX.id + ' …');"
		+ "fetch('/x/agents/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: CTX.id }) })"
		+ '.then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })'
		+ '.then(function (res) {'
		+ 'DLG.busy = false;'
		+ 'var d = res.j || {};'
		+ 'if (d && d.removed) {'
		+ 'svDlgClose();'
		+ "note('已删除 ' + (d.name || d.id) + '（' + (d.dir || '') + '）');"
		// ⚠ 2026-10-20（用户报「删除后 UI 刷新慢」）：**不再整页 reload**。
		//   reload 意味着再走一遍服务端渲染 + 一次全量 scan/sync（实测 85ms 起，还在后台重注册时更久），
		//   而这里要的只是"那一行消失"。就地摘掉行 + 更新计数 = 0 延迟。
		+ 'var row = document.querySelector(\'.row[data-agent-id="\' + d.id + \'"]\');'
		+ 'if (row && row.parentNode) { row.parentNode.removeChild(row); }'
		+ "var cnt = document.querySelector('[data-sv-count]');"
		+ "if (cnt) { cnt.textContent = String(Math.max(0, Number(cnt.textContent || '0') - 1)); }"
		// 删到空了才 reload 一次（空态是服务端渲染的，本地拼不出来）
		+ "if (!document.querySelector('.row[data-agent-id]')) { setTimeout(function () { try { location.reload(); } catch (e) {} }, 300); }"
		+ '} else {'
		+ "note('删除失败：' + (d.error || ('HTTP ' + res.status)));"
		+ 'if (res.status === 403 || res.status === 404) { svDlgClose(); }'
		+ '}'
		+ "}, function (e) { DLG.busy = false; note('删除失败：' + e); });"
		+ '}'
		// 导出确认框：唯一选项是「是否包含记忆」（默认不包含）
		+ 'function svExportOpen() {'
		+ 'var nodes = [];'
		+ "nodes.push(svDlgRow('Agent', (CTX.name || CTX.id) + '（' + CTX.id + '）'));"
		+ 'var memRow = document.createElement("div"); memRow.className = "drow";'
		+ 'var memKey = document.createElement("span"); memKey.className = "dk"; memKey.textContent = "选项";'
		+ 'var memWrap = document.createElement("span"); memWrap.className = "dv";'
		+ 'var chk = document.createElement("input"); chk.type = "checkbox"; chk.setAttribute("data-sv-export-memory", "1");'
		+ 'chk.checked = false;'
		+ 'memWrap.appendChild(chk);'
		+ 'memWrap.appendChild(document.createTextNode(" 包含记忆文件（memory/*，可能含私人信息）"));'
		+ 'memRow.appendChild(memKey); memRow.appendChild(memWrap); nodes.push(memRow);'
		+ "nodes.push(svDlgRow('写到', '数据目录的 exports/ 下（导出后可定位文件）'));"
		+ "svDlgOpen('导出 Agent 包', nodes, [svDlgBtn('取消', 'cancel'), svDlgBtn('导出', 'export', true)]);"
		+ '}'
		+ 'function svExportCommit() {'
		+ "var chk = document.querySelector('[data-sv-export-memory]');"
		+ 'var memory = !!(chk && chk.checked);'
		+ "note('正在导出…');"
		+ "fetch('/x/agents/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', id: CTX.id, memory: memory }) })"
		+ '.then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })'
		+ '.then(function (res) {'
		+ 'var d = res.j || {};'
		+ 'if (d && d.path) {'
		+ 'CTX.lastPath = String(d.path);'
		+ 'svDlgClose();'
		+ "svDlgOpen('已导出', ["
		+ "svDlgRow('文件', String(d.fileName || d.path)),"
		+ "svDlgRow('路径', String(d.path)),"
		+ "svDlgRow('大小', String(d.bytes) + ' 字节'),"
		+ "svDlgRow('记忆', memory ? ((d.memoryFiles && d.memoryFiles.length) ? d.memoryFiles.length + ' 个文件' : '没有可打包的记忆') : '未包含')"
		+ "], [svDlgBtn('在资源管理器中显示', 'reveal'), svDlgBtn('好', 'cancel', true)]);"
		+ "} else { note('导出失败：' + (d.error || ('HTTP ' + res.status))); }"
		+ "}, function (e) { note('导出失败：' + e); });"
		+ '}'
		+ 'function svImportDsb() {'
		+ "var input = document.createElement('input');"
		+ "input.type = 'file';"
		// 2026-10-19：也收**纯人设 markdown**（不是每个 bot 都有 zip；Tob 这种人设先存成 .md 即可）
		+ "input.accept = '.zip,application/zip,.md,.markdown,text/markdown';"
		+ "input.setAttribute('data-sv-import-input', '1');"
		+ 'input.onchange = function () {'
		+ "var f = input.files && input.files[0]; if (!f) { return; }"
		+ "note('正在读取 ' + f.name + ' …');"
		+ "var isMd = /\\.(md|markdown)$/i.test(f.name);"
		+ 'var reader = new FileReader();'
		+ 'reader.onload = function () {'
		+ "if (isMd) { svImportDryRunSoul(String(reader.result || ''), f.name); return; }"
		+ "var dataUrl = String(reader.result || '');"
		+ "var comma = dataUrl.indexOf(',');"
		+ "var b64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';"
		+ "if (!b64) { note('读取失败：拿不到文件内容'); return; }"
		+ 'svImportDryRun(b64, f.name);'
		+ '};'
		+ 'if (isMd) { reader.readAsText(f); } else { reader.readAsDataURL(f); }'
		+ '};'
		+ 'input.click();'
		+ '}'
		// 纯人设（markdown）：客户端先本地校验非空，再走同一条 dryRun 预览
		+ 'function svImportDryRunSoul(text, fileName) {'
		+ "if (!String(text || '').trim()) { note('这个文件是空的'); return; }"
		+ 'DLG.zip = ""; DLG.soul = String(text); DLG.file = fileName; DLG.plan = null;'
		+ "note('正在检查 ' + fileName + ' …');"
		+ "fetch('/x/agents/api/import-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ soul: text, dryRun: true }) })"
		+ '.then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })'
		+ '.then(function (res) {'
		+ 'var d = res.j || {};'
		+ 'if (!res.ok || d.dryRun !== true) {'
		+ "note('这个文件不能导入：' + (d.error || '未知原因'));"
		+ "svDlgOpen('导入失败', [svDlgRow('原因', String(d.error || '未知原因'))], [svDlgBtn('知道了', 'cancel', true)]);"
		+ 'return; }'
		+ 'svDlgPlan(d);'
		+ "}).catch(function (e) { note('检查失败：' + e); });"
		+ '}'
		+ 'function svImportDryRun(b64, fileName) {'
		+ 'DLG.zip = b64; DLG.file = fileName; DLG.plan = null;'
		+ "note('正在检查 ' + fileName + ' …');"
		+ "fetch('/x/agents/api/import-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zip: b64, dryRun: true }) })"
		+ '.then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })'
		+ '.then(function (res) {'
		+ 'var d = res.j || {};'
		+ 'if (!res.ok || d.dryRun !== true) {'
		+ "note('这个包不能导入：' + (d.error || '未知原因'));"
		+ "svDlgOpen('导入失败', [svDlgRow('原因', String(d.error || '未知原因'))], [svDlgBtn('知道了', 'cancel', true)]);"
		+ 'return; }'
		+ 'svDlgPlan(d);'
		+ "}).catch(function (e) { note('检查失败：' + e); });"
		+ '}'
		+ 'function svDlgPlan(d) {'
		+ 'DLG.plan = d; note("");'
		+ 'var nodes = [];'
		+ 'nodes.push(svDlgRow("名称", String(d.name || d.id || "")));'
		+ 'var idRow = document.createElement("div"); idRow.className = "drow";'
		+ 'var idKey = document.createElement("span"); idKey.className = "dk"; idKey.textContent = "id";'
		+ "var idIn = document.createElement('input'); idIn.type = 'text'; idIn.className = 'dinput';"
		+ "idIn.value = String(d.id || ''); idIn.setAttribute('data-sv-dlg-id', '1');"
		+ "idIn.setAttribute('placeholder', 'agent id（英文/数字/-）');"
		+ 'idRow.appendChild(idKey); idRow.appendChild(idIn); nodes.push(idRow);'
		+ 'if (d.mode === "overwritten") { nodes.push(svDlgRow("注意", "已存在同名 agent —— 导入会覆盖它")); }'
		+ 'nodes.push(svDlgRow("记忆", (d.memoryFiles && d.memoryFiles.length) ? d.memoryFiles.length + " 个文件" : "没有（不注入常驻记忆）"));'
		+ 'if (d.memoryFiles && d.memoryFiles.length) {'
		+ 'var list = document.createElement("div"); list.className = "dlist";'
		+ 'for (var i = 0; i < d.memoryFiles.length; i++) {'
		+ 'var f = d.memoryFiles[i];'
		+ 'var row = document.createElement("div"); row.className = "dli";'
		+ 'row.textContent = f.name + (f.from && f.from !== f.name ? "  ← " + f.from : "");'
		+ 'list.appendChild(row); }'
		+ 'nodes.push(list); }'
		+ 'if (d.skipped && d.skipped.length) { nodes.push(svDlgRow("跳过", d.skipped.map(function (s) { return s.path; }).join(", "))); }'
		+ 'for (var w = 0; w < (d.warnings || []).length; w++) { nodes.push(svDlgRow("提示", d.warnings[w])); }'
		+ 'var foot = [svDlgBtn("取消", "cancel"), svDlgBtn(d.mode === "overwritten" ? "覆盖导入" : "导入", "import", true)];'
		+ 'svDlgOpen("导入 DeepSeekBot 的 Bot", nodes, foot);'
		+ '}'
		+ 'function svImportCommit(overwrite) {'
		+ 'if ((!DLG.zip && !DLG.soul) || DLG.busy) { return; }'
		+ "var idEl = document.querySelector('[data-sv-dlg-id]');"
		+ "var id = idEl && idEl.value ? String(idEl.value).trim() : '';"
		+ 'DLG.busy = true;'
		+ "note('正在导入…');"
		+ 'var payload = DLG.zip ? { zip: DLG.zip } : { soul: DLG.soul };'
		+ 'payload.id = id; payload.overwrite = !!overwrite;'
		+ "fetch('/x/agents/api/import-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })"
		+ '.then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })'
		+ '.then(function (res) {'
		+ 'var d = res.j || {}; DLG.busy = false;'
		+ 'if (d && d.ok) {'
		+ "svDlgClose();"
		+ "note('已导入 ' + d.name + '（' + d.id + '）' + (d.memoryFiles && d.memoryFiles.length ? '，记忆 ' + d.memoryFiles.length + ' 个' : ''));"
		+ 'setTimeout(function () { try { location.reload(); } catch (e) {} }, 800);'
		+ '} else if (res.status === 409 && !overwrite) {'
		+ "svDlgOpen('已存在同名 agent', [svDlgRow('原因', String(d.error || id)), svDlgRow('覆盖会', '替换磁盘上的 .agent.md 与该 Bot 带来的记忆文件')], [svDlgBtn('取消', 'cancel'), svDlgBtn('覆盖导入', 'overwrite', true)]);"
		+ "} else { note('导入失败：' + (d.error || ('HTTP ' + res.status))); }"
		+ "}, function (e) { DLG.busy = false; note('导入失败：' + e); });"
		+ '}'
		// 菜单关闭：点外面（mousedown 捕获；点菜单内部直接放过）、Esc、滚动、失焦、改窗口大小
		+ "document.addEventListener('mousedown', function (e) {"
		+ "var m = document.getElementById('svCtx');"
		+ "if (!m || m.hidden) { return; }"
		+ "if (m.contains(e.target)) { return; }"
		+ 'svCtxClose();'
		+ '}, true);'
		+ "document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { svCtxClose(); svDlgClose(); } });"
		+ "document.addEventListener('scroll', function () { svCtxClose(); }, true);"
		+ 'window.addEventListener("blur", svCtxClose);'
		+ 'window.addEventListener("resize", svCtxClose);'
		+ SIDEVIEW_CREATE_JS
		+ '</script>';

	const newMenu = '<div class="newmenu" id="svNewMenu" hidden data-sv-newmenu>'
		+ '<div onclick="openCreate(\'blank\')">✎ 新建 Agent…<small>三步：起点 → 填写 → 完成</small></div>'
		+ '<div onclick="openCreate(\'copy\')">❏ 复制已有 Agent<small>在现成的基础上改</small></div>'
		+ '<div onclick="openCreate(\'import\')">⇪ 导入 .agent.md<small>粘贴别处的定义原文</small></div>'
		// 2026-10-19：从 DeepSeekBot（PersonaBot）导入。页面里没有"保存/打开文件"的桥能力，
		// 但 `<input type=file>` 在 WebContentsView 里是可用的 ⇒ 选 zip → base64 → POST /api/import-bot。
		+ '<div onclick="svImportDsb()" data-sv-import-dsb="1">⇩ 导入 Bot 包 / 人设（.zip · .md）<small>SOUL.md → 人设，MEMORY.md → 记忆；也可以只给一段人设 markdown</small></div>'
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
<div class="ctxmenu" id="svCtx" hidden></div>
<div class="dlg" id="svDlg" hidden></div>
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
	// 群未读（2026-10-21）：只改角标文本（值为空时 CSS `:empty` 自动隐藏）⇒ 不整页重载 ✓
	function applyGroupUnread(map) {
		var badges = document.querySelectorAll('[data-group-unread]');
		for (var i = 0; i < badges.length; i++) {
			var gid = badges[i].getAttribute('data-group-unread');
			var gn = map && map[gid] > 0 ? map[gid] : 0;
			badges[i].textContent = gn > 0 ? String(gn) : '';
		}
	}
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
		}).then(function (j) {
			if (j && j.counts) { applyUnread(j.counts); }
			if (j && j.groups) { applyGroupUnread(j.groups); }
		}).catch(function () {});
	}
	setInterval(pollUnread, 15000);
}
/* eslint-enable */
const SIDEVIEW_CREATE_JS = '(' + sideviewCreateClient.toString() + ')();';
