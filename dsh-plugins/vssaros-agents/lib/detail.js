// @vssaros/dsh-agents — 编辑区完整页（A 款 · 紧凑行式）。
//
// 2026-10-16 起本文件承载**编辑区/默认表面**（surface=editor 或未带 surface）：内容 = 原 index.js 的
// renderPage 逐字搬入（探针锚点一字未动 ✓），另加**侧栏名册 → 本页**的焦点交接：
//   sideview 页点条目时把 agent id 写进同源 localStorage（FOCUS_KEY，带时间戳）再请宿主开编辑区页；
//   本页加载时读一次（消费掉），并监听 storage 事件接住"页面已开着"的后续点击（编辑器输入是
//   按容器单例的，第二次 openModulePage 不会重载页面 ⇒ 必须靠 storage 事件 ✓）。
// ⚠ 本段含模板串：注释里不许出现反引号（会提前闭合、整文件语法错 —— 本仓已踩 5 次）。
//
// 探针锚点（p3-06 逐条钉住，别改名、别删）：
//   data-vssaros-page / -agents-count / -presets-registered / -roster / -agents-root / data-live-sessions /
//   data-vssaros-usage-tab / id="usage" / tr 上的 data-usage-agent 与 data-usage-tokens（两属性相邻、单空格、
//   顺序不变）/ class="avatar" style="background:hsl(N 45% 42%)"（≥ 2 个）/ 头像正文 emoji 直接跟收尾标签 /
//   'allowlist' / '映射说明'；且在「花名册里没有我们 preset」的场景里，「未注册」必须恰好出现 2 次。
// 2026-10-16 新增锚点（同探针钉住）：data-vssaros-surface="editor" / FOCUS_KEY 交接函数 applyFocus。

import { avatarColorOf, escapeHtml, presetIdOf } from './core/agents.js';
import { CREATE_CLIENT_JS, CREATE_CSS, renderCreateSection } from './createPage.js';
import { HOME_CLIENT_JS, HOME_CSS, buildHomeData, homePanelsHtml } from './home.js';

/** 侧栏名册 → 本页的焦点交接键（同源 localStorage；值 = agentId + 竖线 + 时间戳）。 */
export const FOCUS_KEY = 'vssaros.agents.focus';

/* eslint-disable */
// ↓ 浏览器端（toString 内联）：「映射说明」里的「改为跟随默认」。不引用模块作用域；复用页面主脚本的 note。
// 逐个 POST（不并发：每次都会重扫目录 + 重注册 preset），全部结束后整页刷新（名册 / hero / 琥珀标都要重算）。
function resetModelClient() {
	window.resetModels = function (els) {
		var list = [];
		for (var i = 0; i < els.length; i++) {
			var id = els[i].getAttribute('data-reset-model');
			if (id && list.every(function (x) { return x.id !== id; })) { list.push({ id: id, name: els[i].getAttribute('data-reset-name') || id }); }
		}
		if (!list.length) { return; }
		var NL = String.fromCharCode(10);
		var ask = '把下面 ' + list.length + ' 个 Agent 的模型改为「跟随默认」？' + NL + NL
			+ list.map(function (x) { return '· ' + x.name; }).join(NL) + NL + NL
			+ '只删掉它们 .agent.md 里的 model 那一行，其余内容不动。';
		if (!window.confirm(ask)) { return; }
		for (var j = 0; j < els.length; j++) { els[j].disabled = true; }
		var done = [];
		var failed = [];
		var step = function (k) {
			if (k >= list.length) {
				if (failed.length) {
					if (typeof note === 'function') { note('改了 ' + done.length + ' 个；失败 ' + failed.length + ' 个：' + failed.join('；')); }
					setTimeout(function () { location.reload(); }, 2500);
				} else {
					location.reload();
				}
				return;
			}
			fetch('/x/agents/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resetModel', id: list[k].id }) })
				.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); } return j; }); })
				.then(function () { done.push(list[k].name); }, function (e) { failed.push(list[k].name + '（' + e.message + '）'); })
				.then(function () { step(k + 1); });
		};
		step(0);
	};
}
/* eslint-enable */
const RESET_MODEL_CLIENT_JS = '(' + resetModelClient.toString() + ')();';

/** 用量/实况的展示格式化（页面与 mockup 同口径：四桶全算；时间精确到分）。 */
const fmtTokens = n => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));
const fmtTime = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—');
/** 相对时间（概览签「正在做」用；渲染时刻的快照口径）。 */
const agoOf = ms => {
	if (!Number.isFinite(ms)) { return '—'; }
	const s = Math.floor((Date.now() - ms) / 1000);
	if (s < 60) { return '刚刚'; }
	const m = Math.floor(s / 60);
	if (m < 60) { return m + ' 分钟前'; }
	const h = Math.floor(m / 60);
	if (h < 24) { return h + ' 小时前'; }
	return Math.floor(h / 24) + ' 天前';
};

/* =====================================================================
 * 页面样式（A 款 · 紧凑行式）
 * 2026-10-14：用户从 4 款样式 mockup（doc/dsh-agents-sideview-styles-mockup.html）选定 A。
 * ===================================================================== */
const PAGE_CSS = `:root { color-scheme: light dark; }
body { margin: 0; padding: 0 0 10px; font: 13px/1.5 system-ui, "Segoe UI", sans-serif; color: var(--vscode-foreground, #ccc); background: var(--vscode-sideBar-background, #1e1e1e); }
header { position: sticky; top: 0; z-index: 2; padding: 9px 10px 8px; background: var(--vscode-sideBar-background, #1e1e1e); border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
h1 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
h1 .n { margin-left: auto; font-weight: 400; color: var(--vscode-descriptionForeground, #999); letter-spacing: 0; }
.tag { font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.tag.gray { background: transparent; border: 1px solid var(--vscode-panel-border, #555); color: var(--vscode-descriptionForeground, #999); }
.tag.off { background: #7a3d2b; color: #fff; }
.seg { display: flex; margin: 8px 0 7px; border: 1px solid var(--vscode-panel-border, #555); border-radius: 6px; overflow: hidden; }
.seg button { flex: 1; padding: 3px 0; font: inherit; font-size: 12px; color: var(--vscode-descriptionForeground, #999); background: transparent; border: 0; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--vscode-panel-border, #555); }
.seg button.on { background: var(--vscode-button-background, #0e639c); color: #fff; }
.search { display: flex; align-items: center; gap: 5px; padding: 2px 6px; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
.search input { flex: 1; min-width: 0; padding: 2px 0; font: inherit; font-size: 12px; color: inherit; background: transparent; border: 0; outline: 0; }
.search .mag, .search .n { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
ul { margin: 0; padding: 0; list-style: none; }
li.item { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
.row { display: flex; gap: 7px; padding: 5px 10px 5px 0; cursor: pointer; }
.row:hover, li.item.open > .row { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.bar { flex: 0 0 3px; align-self: stretch; background: transparent; }
li.warned .bar { background: #cca700; }
.avatar { flex: 0 0 18px; width: 18px; height: 18px; margin-top: 1px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; color: #fff; }
.main { flex: 1; min-width: 0; }
.l1 { display: flex; align-items: baseline; gap: 6px; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l1 .sp { margin-left: auto; color: var(--vscode-textLink-foreground, #6aa9e8); font-size: 11px; white-space: nowrap; }
.l1 .sp.dim { color: var(--vscode-descriptionForeground, #999); }
.l2 { color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chev { align-self: center; color: var(--vscode-descriptionForeground, #999); font-size: 10px; }
li.item.open .chev { transform: rotate(90deg); }
.drawer { display: none; padding: 5px 10px 8px 28px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); background: rgba(128,128,128,.08); color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; }
li.item.open > .drawer { display: block; }
.drawer dl { display: grid; grid-template-columns: 52px 1fr; gap: 3px 8px; margin: 0; }
.drawer dd { margin: 0; color: var(--vscode-foreground, #ccc); overflow-wrap: anywhere; }
.mono, code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.unmapped { color: #cca700; }
details.warn { margin: 10px; border: 1px solid rgba(204,167,0,.45); border-radius: 6px; background: rgba(204,167,0,.1); }
details.warn > summary { padding: 6px 9px; color: #cca700; font-size: 12px; cursor: pointer; list-style: none; }
details.warn > summary::-webkit-details-marker { display: none; }
details.warn .wbody { padding: 0 9px 2px; }
details.warn li { margin-bottom: 4px; padding: 3px 0 3px 8px; border-left: 2px solid rgba(204,167,0,.5); color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; }
section.pad { padding: 0 10px; }
h2 { margin: 8px 0 5px; font-size: 11px; font-weight: 400; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #999); }
h2 small { text-transform: none; letter-spacing: 0; }
table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
th, td { padding: 3px 6px 3px 0; text-align: left; vertical-align: top; }
tr.head th { color: var(--vscode-descriptionForeground, #999); font-weight: 400; }
tr td { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
tr.unknown td { color: var(--vscode-descriptionForeground, #999); }
.empty, .diag { color: var(--vscode-descriptionForeground, #999); }
.empty { padding: 28px 14px; text-align: center; }
.diag { margin: 6px 0 0; font-size: 11.5px; }
footer { margin-top: 10px; padding: 8px 10px 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); color: var(--vscode-descriptionForeground, #999); font-size: 11px; overflow-wrap: anywhere; }
.iconbtn { flex: 0 0 auto; align-self: center; padding: 1px 4px; font: inherit; font-size: 12px; line-height: 1; color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground, #999)); background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
.iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.25)); color: var(--vscode-foreground, #ccc); }
.acts { margin: 6px 0 0; }
.act { padding: 2px 8px; font: inherit; font-size: 11.5px; color: inherit; background: var(--vscode-button-secondaryBackground, #3a3d41); border: 1px solid var(--vscode-panel-border, #555); border-radius: 4px; cursor: pointer; }
.act:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.note { margin: 0; padding: 6px 10px; color: var(--vscode-editorWarning-foreground, #cca700); }
.aform { display: flex; gap: 6px; padding: 4px 10px 9px; }
.aform select, .aform input { background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, transparent); color: inherit; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 4px; }
.aform input { flex: 1; min-width: 0; }
.tag.run { background: #1f4d3f; }
.tag.done2 { background: #22304a; }
.tag.cancel2 { background: #3d2222; }
td .act { margin-right: 4px; }
.ahint { padding: 0 10px 6px; }
.gwrap { display: flex; gap: 10px; padding: 0 10px; min-height: 220px; }
.glist { flex: 0 0 190px; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); padding-right: 8px; }
.glist .gitem { padding: 5px 8px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.glist .gitem:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.glist .gitem.on { background: var(--vscode-list-activeSelectionBackground, #094771); }
.glist .gitem .gm { color: var(--vscode-descriptionForeground, #999); font-size: 10.5px; }
.gchat { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.glog { flex: 1; min-height: 160px; max-height: 380px; overflow-y: auto; padding: 6px 4px; }
.gmsg { margin-bottom: 8px; font-size: 12px; }
.gmsg .who { font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); margin-bottom: 2px; }
.gmsg .bubble { display: inline-block; max-width: 92%; padding: 6px 10px; border-radius: 8px; background: var(--vscode-editor-background, #252526); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); white-space: pre-wrap; overflow-wrap: anywhere; }
.gmsg.me .bubble { background: var(--vscode-button-secondaryBackground, #3a3d41); }
.gmsg.sys { text-align: center; }
.gmsg.sys .bubble { background: transparent; border: none; color: var(--vscode-descriptionForeground, #999); font-size: 10.5px; font-style: italic; padding: 0; }
.gcomposer { display: flex; gap: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
.gcomposer input { flex: 1; min-width: 0; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, transparent); color: inherit; font: inherit; font-size: 12px; padding: 5px 9px; border-radius: 5px; }
.mchip { display: inline-flex; gap: 4px; align-items: center; font-size: 11px; padding: 2px 9px; border-radius: 10px; background: var(--vscode-badge-background, #3c3c3c); border: 1px solid var(--vscode-panel-border, #555); color: var(--vscode-descriptionForeground, #999); cursor: pointer; }
.mchip.on { color: var(--vscode-button-foreground, #fff); border-color: var(--vscode-button-background, #0e639c); background: var(--vscode-button-background, #0e639c); }
.membar { display: flex; gap: 10px; align-items: center; padding: 7px 10px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 7px; margin: 0 10px 9px; font-size: 11.5px; }
.membar .on-git { color: #4ec9b0; }
.membar .dirty { color: #cca700; }
.memwrap { display: flex; gap: 10px; padding: 0 10px; }
.memlist { flex: 0 0 200px; }
.memfile { padding: 4px 8px; border-radius: 5px; cursor: pointer; font-size: 12px; display: flex; justify-content: space-between; }
.memfile:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.memfile.on { background: var(--vscode-list-activeSelectionBackground, #094771); }
.memfile .mk { font-size: 10px; color: #4ec9b0; }
.memfile .mk.no { color: #cca700; }
.memview { flex: 1; min-width: 0; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 7px; }
.memview .mh { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
.memview pre { margin: 0; padding: 8px 10px; max-height: 300px; overflow: auto; font: 11px/1.6 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.memlog { margin: 8px 10px 0; font-size: 11px; }
.memlog .lr { display: flex; gap: 8px; padding: 3px 4px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.15)); align-items: baseline; }
.memlog .h { font-family: ui-monospace, Consolas, monospace; color: #c586c0; }
.memlog .t { margin-left: auto; color: var(--vscode-descriptionForeground, #999); font-size: 10px; }
/* 款 A（2026-10-16 用户选定，doc/agents-surfaces-v2-mockup.html）：profile hero */
.hero { display: flex; gap: 12px; align-items: flex-start; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); background: rgba(128,128,128,.05); }
.hero .hav { flex: 0 0 44px; width: 44px; height: 44px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; font-size: 22px; color: #fff; position: relative; }
.hero .hav .dot { position: absolute; right: -3px; bottom: -3px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--vscode-sideBar-background, #1e1e1e); background: #555; }
.hero .hav .dot.busy { background: #4ec9b0; }
.hero .hmain { flex: 1; min-width: 0; }
.hero h2 { margin: 0 0 2px; font-size: 15px; text-transform: none; letter-spacing: 0; color: var(--vscode-foreground, #ccc); }
.hero .hsub { color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hero .hchips { margin-top: 5px; }
.hero .hstats { margin-top: 5px; display: flex; gap: 12px; font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); }
.hero .hstats b { color: var(--vscode-foreground, #ccc); font-weight: 600; }
.hero .hacts { display: flex; flex-direction: column; gap: 5px; }
.hero .hacts .act { white-space: nowrap; }
.hchip { display: inline-block; font-size: 10px; padding: 1px 8px; border-radius: 9px; background: var(--vscode-badge-background, #3c3c3c); border: 1px solid var(--vscode-panel-border, #555); color: var(--vscode-descriptionForeground, #999); margin: 1px 3px 1px 0; }
.hchip.ok { color: #4ec9b0; border-color: #2c4a43; }
.hchip.warn2 { color: #cca700; border-color: #57481f; }
.hchip.p { color: #c586c0; border-color: #3d2d4a; }
/* 概览签（款 A 收尾）：正在做 + 身份卡（随 hero 换人） */
.card { background: rgba(128,128,128,.05); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 7px; padding: 8px 10px; margin-bottom: 9px; }
.card h5 { margin: 0 0 6px; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--vscode-foreground, #ccc); }
.card h5 small { margin-left: auto; font-weight: 400; font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); }
.ovdoing .row2 { display: flex; gap: 7px; padding: 4px 0; font-size: 11.5px; align-items: baseline; }
.ovdoing .row2 .t { color: var(--vscode-descriptionForeground, #999); margin-left: auto; font-size: 10px; flex: none; }
.ovdoing .row2.dim { color: var(--vscode-descriptionForeground, #999); }
.idchip { font-family: ui-monospace, Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; }`;

export function renderDetailPage({ agents, summary, root, missing, diagnostics, roster, errors, liveRows, sessionRows, usage, assignments, templates, groups, outbox, create }) {
	const liveOf = new Map((liveRows ?? []).map(row => [row.agentId, row]));
	// 每个 agent 的运行中委派数（hero 统计行用 ✓）
	const asgRunningOf = new Map();
	// 每个 agent 的运行中委派明细（概览签「正在做」用：task + 相对时间）
	const runningListOf = new Map();
	for (const item of assignments?.items ?? []) {
		if (item?.status === 'running' && typeof item.agentId === 'string') {
			asgRunningOf.set(item.agentId, (asgRunningOf.get(item.agentId) ?? 0) + 1);
			const list = runningListOf.get(item.agentId) ?? [];
			list.push({ task: item.task ?? '', ago: agoOf(item.createdAt) });
			runningListOf.set(item.agentId, list);
		}
	}
	// 「模型未映射」的琥珀标来自宿主给的诊断（不由页面猜）：diagnostics 每项是 { agentId, presetId, notes, ... }
	const notesOf = new Map((diagnostics ?? []).map(d => [d.agentId, d.notes ?? []]));
	const rows = agents.map(a => {
		const presetId = presetIdOf(a.id);
		const registered = roster.includes(presetId);
		const live = liveOf.get(a.id);
		const unmapped = (notesOf.get(a.id) ?? []).some(n => n.startsWith('模型未映射'));
		// 副行：模型 · 工具 · 人设 · token（token 只在有会话时出现 —— 没有会话就不显示 0）
		const sub = [
			a.model ? (unmapped ? '模型未映射' : 'model ' + escapeHtml(a.model)) : 'model 未设',
			a.tools.length ? a.tools.length + ' tools' : '无 tools',
			a.persona ? '人设 ' + a.persona.length + ' 字' : '无人设正文',
		];
		if (live && live.sessions > 0) {
			sub.push('token ' + fmtTokens(live.tokens));
		}
		// 头像：icon 是 emoji 原样显示；没写 icon 就退到名字首字（底色按 id 哈希恒定）。圆角方块，不用圆形。
		const avatar = '<span class="avatar" style="background:' + avatarColorOf(a.id) + '" data-agent-icon="' + escapeHtml(a.icon ?? '') + '">' + escapeHtml(a.icon ?? a.name.slice(0, 1)) + '</span>';
		const facts = '<dl>'
			+ '<dt>preset</dt><dd class="mono">' + escapeHtml(presetId) + '</dd>'
			+ '<dt>定义</dt><dd class="mono">' + escapeHtml(a.file ?? '(未知)') + '</dd>'
			+ '<dt>模型</dt><dd>' + (a.model
				? escapeHtml(a.model) + (unmapped ? ' <span class="unmapped">未映射 → 跟随默认模型</span>' : '')
				: '未设（跟随默认模型）') + '</dd>'
			+ '<dt>工具</dt><dd>' + (a.tools.length ? escapeHtml(a.tools.join('、')) : '无（该 agent 不限制工具）') + '</dd>'
			+ '<dt>人设</dt><dd>' + (a.persona ? a.persona.length + ' 字' : '无人设正文') + '</dd>'
			+ (live && live.sessions > 0
				? '<dt>实况</dt><dd>' + live.sessions + ' 会话 · ' + fmtTokens(live.tokens) + ' token · ' + live.turns + ' 回合 · 最近 ' + escapeHtml(fmtTime(live.lastActiveAt)) + '</dd>'
				: '')
			+ '</dl>'
			// 2026-10-14：抽屉里的显式入口（行上的齿轮是快路径，这里不依赖悬停/小图标能被看见）
			+ '<p class="acts"><button class="act" onclick="openAgentSettingsFrom(this)" title="打开该 bot 在 VsSaros 里的 Agent 设置页">Agent 设置</button></p>';
		// data-search：筛选框的匹配面（id / 名称 / 描述），在服务端算好，页面只做子串匹配。
		// data-h-* = hero 区的数据源（款 A：点行 → hero 换成该 agent；全在服务端算好，JS 只搬运 ✓）
		const hModel = a.model ? (unmapped ? '模型未映射' : a.model) : '默认模型';
		const hLive = live && live.sessions > 0 ? live.sessions + ' 会话 · ' + fmtTokens(live.tokens) + ' token' : '';
		const hAsg = asgRunningOf.get(a.id) ?? 0;
		return '<li class="item' + (unmapped ? ' warned' : '') + '" data-agent-id="' + escapeHtml(a.id) + '" data-live-sessions="' + (live?.sessions ?? 0) + '" data-search="' + escapeHtml((a.id + ' ' + a.name + ' ' + (a.description ?? '')).toLowerCase()) + '"'
			+ ' data-h-preset="' + escapeHtml(presetId) + '" data-h-name="' + escapeHtml(a.name) + '" data-h-desc="' + escapeHtml(a.description ?? '') + '"'
			+ ' data-h-model="' + escapeHtml(hModel) + '" data-h-model-warn="' + (unmapped ? 1 : 0) + '" data-h-tools="' + a.tools.length + '" data-h-persona="' + a.persona.length + '"'
			+ ' data-h-live="' + escapeHtml(hLive) + '" data-h-asg="' + hAsg + '" data-h-file="' + escapeHtml(a.file ?? '') + '" data-h-doing="' + escapeHtml(JSON.stringify(runningListOf.get(a.id) ?? [])) + '" data-h-skills="' + escapeHtml(a.skills?.join(', ') ?? '') + '">'
			+ '<div class="row" onclick="toggleRow(this)"><span class="bar"></span>' + avatar
			+ '<div class="main"><div class="l1"><span class="name">' + escapeHtml(a.name) + '</span>'
			+ (registered ? '' : '<span class="tag off">未注册</span>')
			+ '<span class="sp' + (live && live.sessions > 0 ? '' : ' dim') + '">' + (live && live.sessions > 0 ? '会话 ' + live.sessions : '—') + '</span></div>'
			+ '<div class="l2">' + sub.join(' · ') + '</div></div>'
			+ '<button class="iconbtn" title="Agent 设置" aria-label="Agent 设置" onclick="openAgentSettingsFrom(this)">⚙</button>'
			+ '<span class="chev">›</span></div>'
			+ '<div class="drawer">' + facts + '</div></li>';
	}).join('');
	const newBtn = '<button class="act" onclick="showTab(\'create\'); if (window.crBegin) { crBegin(\'blank\'); }">＋ 新建 Agent</button>';
	const body = missing
		? '<p class="empty">agent 目录还不存在：<code>' + escapeHtml(missing) + '</code><br>建第一个 Agent 时会自动创建它。</p><p class="empty">' + newBtn + '</p>'
		: (rows ? '<ul>' + rows + '</ul>' : '<p class="empty">还没有可用的 agent（每个子目录需要一个带 name 的 .agent.md）。</p><p class="empty">' + newBtn + '</p>');
	const notes = diagnostics.flatMap(d => (d.notes ?? []).map(n => d.presetId + '：' + n));
	// 「模型未映射」的条目带一键修复（2026-10-17，方案 A 第 4 步遗留 ①）：删掉该 Agent 的 model 行 = 跟随默认。
	// 名字从 agents 里取（确认框里说人话，不只报 id）✓
	const nameOf = new Map(agents.map(a => [a.id, a.name]));
	const unmappedIds = diagnostics.filter(d => (d.notes ?? []).some(n => n.startsWith('模型未映射'))).map(d => d.agentId);
	const resetBtn = id => ' <button class="act" data-reset-model="' + escapeHtml(id) + '" data-reset-name="' + escapeHtml(nameOf.get(id) ?? id)
		+ '" onclick="resetModels([this])" title="删掉它 .agent.md 里的 model 行，改为跟随默认模型（其余内容不动）">改为跟随默认</button>';
	const noteItems = diagnostics.flatMap(d => (d.notes ?? []).map(n => '<li>' + escapeHtml(d.presetId + '：' + n) + (n.startsWith('模型未映射') ? resetBtn(d.agentId) : '') + '</li>'));
	const bulkReset = unmappedIds.length >= 2
		? '<p data-vssaros-reset-all><button class="act" onclick="resetModels(document.querySelectorAll(\'[data-reset-model]\'))">全部改为跟随默认（' + unmappedIds.length + ' 个）</button>'
			+ ' <span class="diag">这些 Agent 写的模型 dsh 没有路由，运行时本来就会退回默认模型；改掉后黄色提示消失</span></p>'
		: '';
	// 映射说明 / 问题：默认收起（原生 details，不依赖脚本）；有 errors 时默认展开（那是真出事了）
	const problems = (notes.length || errors.length)
		? '<details class="warn"' + (errors.length ? ' open' : '') + '><summary>映射说明 / 问题 ' + (notes.length + errors.length)
			+ (unmappedIds.length ? ' · ' + unmappedIds.length + ' 个模型未映射，可一键改为跟随默认' : '') + '</summary><div class="wbody">' + bulkReset + '<ul>'
			+ noteItems.join('') + errors.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul></div></details>'
		: '';
	const ours = roster.filter(id => id.startsWith('vssaros-'));
	// 页脚：把旧版标题下那长条 diag 行收进来（四个探针锚点挂在这里）
	const footer = '<footer data-vssaros-agents-count="' + summary.count + '" data-vssaros-presets-registered="' + ours.length
		+ '" data-vssaros-roster="' + escapeHtml(roster.join(',')) + '" data-vssaros-agents-root="' + escapeHtml(root) + '">'
		+ '已注册 preset ' + ours.length + ' / 花名册 ' + roster.length + ' · <code>' + escapeHtml(root) + '</code></footer>';

	// 用量页签（P5）：按 agent / 按模型；名册外会话单列「未归属」。口径注释与 mockup 一致。
	const usageRows = (usage?.agents ?? []).map(u => {
		const agent = agents.find(a => a.id === u.agentId);
		const models = u.models.length ? u.models.map(m => escapeHtml(m.ref) + '（' + fmtTokens(m.tokens) + '）').join('<br>') : '—';
		const avatar = agent ? '<span class="avatar" style="background:' + avatarColorOf(agent.id) + '">' + escapeHtml(agent.icon ?? agent.name.slice(0, 1)) + '</span>' : '';
		return '<tr data-usage-agent="' + escapeHtml(u.agentId) + '" data-usage-tokens="' + u.tokens + '"><td>' + avatar + '<b>' + escapeHtml(agent?.name ?? u.agentId) + '</b></td><td>' + u.sessions + '</td><td>' + fmtTokens(u.tokens) + '</td><td>' + u.turns + '</td><td>' + escapeHtml(fmtTime(u.lastActiveAt)) + '</td><td>' + models + '</td></tr>';
	}).join('');
	const unknown = usage?.unknown;
	const unknownRow = unknown && unknown.sessions > 0
		? '<tr class="unknown"><td>未归属（standard / 已删 agent 的残留）</td><td>' + unknown.sessions + '</td><td>' + fmtTokens(unknown.tokens) + '</td><td>' + unknown.turns + '</td><td>—</td><td>—</td></tr>'
		: '';
	const usageSection = usage
		? '<div id="usage" hidden><section class="pad"><h2>用量 <small>按 agent / 按模型 · 只读（projcache）</small></h2>'
			+ '<table><tr class="head"><th>Agent</th><th>会话</th><th>token</th><th>回合</th><th>最近活跃</th><th>按模型</th></tr>' + usageRows + unknownRow + '</table>'
			+ '<p class="diag">token = 输入+输出+读缓存+写缓存；「最近活跃」= 最后一条用户输入。按时间的趋势视图在 Dashboard 页。</p></section></div>'
		: '';
	// 委派页签（2026-10-16，P1）：台账快照（服务端首渲，JS 轮询增量刷新；内存态，Host 重启清空——如实写 ✓）
	const assignmentItems = assignments?.items ?? [];
	const assignmentRowHtml = r => {
		const statusTag = r.status === 'running' ? '<span class="tag run">运行中</span>'
			: r.status === 'done' ? '<span class="tag done2">已完成</span>'
				: '<span class="tag cancel2">已中断</span>';
		const acts = r.status === 'running'
			? '<button class="act" onclick="assignmentAsk(this)" title="往该委派的会话再发一条消息">追问</button><button class="act" onclick="assignmentCancel(this)" title="停掉该委派会话的当前回合">中断</button>'
			: '<button class="act" onclick="assignmentAsk(this)" title="追问会把该委派重新置为运行中">追问</button>';
		return '<tr data-assignment-id="' + escapeHtml(r.id) + '"><td><b>' + escapeHtml(r.agentName ?? r.agentId) + '</b></td>'
			+ '<td>' + escapeHtml(r.task.length > 60 ? r.task.slice(0, 60) + '…' : r.task) + '</td>'
			+ '<td>' + statusTag + (r.error ? '<br><span class="unmapped">' + escapeHtml(r.error) + '</span>' : '') + '</td>'
			+ '<td>' + escapeHtml(fmtTime(r.updatedAt)) + '</td><td>' + acts + '</td></tr>';
	};
	const assignmentsSection = '<div id="assignments" hidden><section class="pad"><h2>委派 <small>台账落盘持久化（重启不丢） · 并发 ' + (assignments?.running ?? 0) + '/' + (assignments?.cap ?? 8) + '</small></h2>'
		+ '<div class="aform"><select id="aAgent">' + agents.map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + '</option>').join('') + '</select>'
		+ '<input id="aTask" placeholder="任务（自包含：对方看不到当前会话上下文）" onkeydown="if(event.key===\'Enter\'){assignmentCreate()}"><button class="act" onclick="assignmentCreate()">委派</button></div>'
		+ '<table><tr class="head"><th>Agent</th><th>任务</th><th>状态</th><th>更新</th><th>操作</th></tr><tbody id="aRows">'
		+ (assignmentItems.length ? assignmentItems.map(assignmentRowHtml).join('') : '<tr class="unknown"><td colspan="5">还没有委派。</td></tr>')
		+ '</tbody></table>'
		+ '<p class="diag ahint">报告写回台账（截断 4000 字，全文在该委派的会话日志）；创建时若从会话发起，回复也会回传到来源会话。</p></section></div>';
	// 授权页签（2026-10-16，P2）：能力声明（.agent.md 的 tools allowlist，声明式真源 ✓）+ 审批模板
	// （命中即自动放行；只覆盖本包 WRITE_TOOLS）+ 密钥的如实说明（我们不代理 dsh 凭据 ✗）。
	const templateItems = templates?.templates ?? [];
	const templateTools = templates?.tools ?? [];
	// Workspace Grant 矩阵（2026-10-16 二期）：真源 = .agent.md 的 workspaces-read/write（声明式 ✓）；
	// 缺省行如实标「收紧缺省：仅缺省工作区」。强制点 = 三条开会话路径的 cwd 闸（grants.js ✓）。
	const grantRows = agents.flatMap(a => {
		if (!a.workspaces) {
			return ['<tr><td><b>' + escapeHtml(a.name) + '</b></td><td colspan="2"><span class="diag">未声明 workspaces ⇒ 收紧缺省：仅缺省工作区（显式 cwd 会被拒）</span></td></tr>'];
		}
		const writeSet = new Set((a.workspaces.write ?? []).map(w => w.toLowerCase()));
		const all = [...new Set([...(a.workspaces.read ?? []), ...(a.workspaces.write ?? [])])];
		return all.map(w => '<tr><td><b>' + escapeHtml(a.name) + '</b></td><td><code>' + escapeHtml(w) + '</code></td><td>'
			+ (writeSet.has(w.toLowerCase()) ? '读+写' : '只读') + '</td></tr>');
	}).join('');
	// Outbox 表（同页签内；unknown-outcome 禁自动重发——只有手动重发按钮 ✓）
	const outboxEntries = outbox?.entries ?? [];
	const outboxRowHtml = e => {
		const tag = e.status === 'unknown' ? '<span class="tag cancel2">unknown-outcome</span>'
			: e.status === 'pending' ? '<span class="tag run">在途</span>' : '<span class="tag done2">已回收</span>';
		const where = e.kind === 'group' ? '群聊回收' : ('回传到 ' + escapeHtml(e.from ?? '(无)'));
		return '<tr data-outbox-id="' + escapeHtml(e.id) + '"><td class="mono">' + escapeHtml((e.messageId ?? '').slice(0, 8)) + '</td>'
			+ '<td>' + where + '</td><td>' + tag + (e.note ? '<br><span class="unmapped">' + escapeHtml(e.note) + '</span>' : '') + '</td>'
			+ '<td>' + escapeHtml(fmtTime(e.sentAt)) + '</td>'
			+ '<td>' + (e.status === 'unknown' ? '<button class="act" onclick="outboxRetry(this)">手动重发</button>' : '—') + '</td></tr>';
	};
	const grantsSection = '<div id="grants" hidden><section class="pad">'
		+ '<h2>能力声明 <small>每个 agent 的工具白名单（真源 = .agent.md 的 tools；空 = 不限制）</small></h2>'
		+ '<table><tr class="head"><th>Agent</th><th>工具白名单</th></tr>'
		+ agents.map(a => '<tr><td><b>' + escapeHtml(a.name) + '</b> <span class="mono">' + escapeHtml(a.id) + '</span></td><td>'
			+ (a.tools.length ? escapeHtml(a.tools.join('、')) : '<span class="diag">不限制（该 agent 能用全部工具）</span>') + '</td></tr>').join('')
		+ '</table>'
		+ '<h2 style="margin-top:12px">审批模板 <small>命中模板的过闸工具不再每次问 · 只覆盖本包工具 · 工具名级粒度</small></h2>'
		+ '<div class="aform"><select id="tTool">' + templateTools.map(t => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join('') + '</select>'
		+ '<input id="tNote" placeholder="备注（可空：为什么放宽它）"><button class="act" onclick="templateAdd()">存为模板</button></div>'
		+ '<table><tbody id="tRows">'
		+ (templateItems.length
			? templateItems.map(t => '<tr data-template-tool="' + escapeHtml(t.tool) + '"><td class="mono">' + escapeHtml(t.tool) + '</td><td>' + escapeHtml(t.note ?? '') + '</td><td>' + escapeHtml(fmtTime(t.createdAt)) + '</td><td><button class="act" onclick="templateRemove(this)">删除</button></td></tr>').join('')
			: '<tr class="unknown"><td>还没有模板——过闸工具每次都会问。</td></tr>')
		+ '</tbody></table>'
		+ '<h2 style="margin-top:12px">Workspace Grant <small>真源 = .agent.md 的 workspaces-read/write · 强制点 = 开会话路径的 cwd 闸</small></h2>'
		+ '<table data-vssaros-grant-matrix><tr class="head"><th>Agent</th><th>授权路径</th><th>权限</th></tr>'
		+ (grantRows || '<tr class="unknown"><td colspan="3">还没有 agent。</td></tr>') + '</table>'
		+ '<h2 style="margin-top:12px">Outbox <small>回传/派发的耐久队列 · 重启读回 · unknown-outcome 永不自动重发</small></h2>'
		+ '<table><tr class="head"><th>消息</th><th>去向</th><th>状态</th><th>发出时间</th><th>操作</th></tr><tbody id="oRows">'
		+ (outboxEntries.length ? outboxEntries.map(outboxRowHtml).join('') : '<tr class="unknown"><td colspan="5">队列是空的。</td></tr>')
		+ '</tbody></table>'
		+ '<p class="diag ahint">密钥：本页不展示也不代理凭据——dsh 侧的凭据走它自己的配置面，模型永远只见引用不见原值（需要卡片式密钥管理时单独立项）。</p>'
		+ '</section></div>';
	// 群聊页签（2026-10-16，二期）：左群列表 + 右对话区（自托管 transcript；承载面决策见 lib/groups.js ★）。
	const groupItems = groups?.groups ?? [];
	const groupRowHtml = g => '<div class="gitem" data-group-id="' + escapeHtml(g.id) + '" onclick="selectGroup(this)">'
		+ '<b># ' + escapeHtml(g.name) + '</b> <span class="gm">' + (g.mode === 'open' ? 'open' : 'admin') + ' · 成员 ' + (g.members?.length ?? 0) + '</span></div>';
	const groupsSection = '<div id="groups" hidden><section class="pad"><h2>群聊 <small>派发 = 成员会话 steer · 回复回收进群记录 · 封顶 ' + (groups?.keep ?? 200) + ' 条</small></h2>'
		+ '<div class="aform"><input id="gName" placeholder="群名">'
		+ '<select id="gMode"><option value="admin">admin（只响应被 @ 的）</option><option value="open">open（全员响应）</option></select>'
		+ '<button class="act" onclick="groupCreate()">建群</button></div>'
		+ '<div class="aform" id="gMembers">' + agents.map(a => '<span class="mchip" data-member="' + escapeHtml(a.id) + '" onclick="this.classList.toggle(\'on\')">' + escapeHtml(a.icon ?? '') + ' ' + escapeHtml(a.name) + '</span>').join('') + '</div>'
		+ '<div class="gwrap"><div class="glist" id="gList">'
		+ (groupItems.length ? groupItems.map(groupRowHtml).join('') : '<p class="diag">还没有群。</p>')
		+ '</div><div class="gchat"><div class="glog" id="gLog"><p class="diag">选一个群开始。</p></div>'
		+ '<div class="gcomposer"><input id="gInput" placeholder="发消息（admin 模式记得 @成员）" onkeydown="if(event.key===\'Enter\'){groupSend()}" disabled><button class="act" id="gSend" onclick="groupSend()" disabled>发送</button></div>'
		+ '</div></div></section></div>';
	// 记忆页签（2026-10-16，二期）：agent 选择器 + 文件列表 + 查看器 + Git 状态/历史。
	// 数据全走 /x/agents/api/memory（服务端只渲染壳）；写口只有「启用 Git / 提交快照」两个 ✓。
	const memorySection = '<div id="memory" hidden><section class="pad"><h2>记忆 <small>MEMORY.md 前 2KB 随人设段注入 prompt（冻结快照 · 每分钟刷新） · 写口只有 Git 两个按钮</small></h2>'
		+ '<div class="aform"><select id="mAgent" onchange="memoryLoad()">' + agents.map(a => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + '</option>').join('') + '</select>'
		+ '<span class="diag" id="mHint">Git 化可选；提交只能人按按钮（模型没有记忆写口）</span></div>'
		+ '<div class="membar" id="mBar">…</div>'
		+ '<div class="memwrap"><div class="memlist" id="mList"><p class="diag">…</p></div>'
		+ '<div class="memview"><div class="mh" id="mTitle">选一个文件</div><pre id="mBody">…</pre></div></div>'
		+ '<div class="memlog" id="mLog"></div>'
		+ '</section></div>';
	// Hero（款 A，2026-10-16 用户选定）：当前聚焦 agent 的 profile 头部（大头像/描述/能力 chips/
	// 实况统计/快捷动作）。初始 = 第一个 agent；点名册行 ⇒ updateHero 换（数据全在行的 data-h-* 上 ✓）。
	const heroOf = agents[0];
	const hero = heroOf ? (() => {
		const live = liveOf.get(heroOf.id);
		const unmapped = (notesOf.get(heroOf.id) ?? []).some(n => n.startsWith('模型未映射'));
		const modelChip = heroOf.model
			? (unmapped ? '<span class="hchip warn2">模型未映射 → 跟随默认</span>' : '<span class="hchip ok">' + escapeHtml(heroOf.model) + '</span>')
			: '<span class="hchip">默认模型</span>';
		return '<div class="hero" id="hero" data-h-agent="' + escapeHtml(heroOf.id) + '" data-h-preset="' + escapeHtml(presetIdOf(heroOf.id)) + '">'
			+ '<span class="hav" id="hAvatar" style="background:' + avatarColorOf(heroOf.id) + '">'
			+ '<span id="hEmoji">' + escapeHtml(heroOf.icon ?? heroOf.name.slice(0, 1)) + '</span>'
			+ '<span class="dot' + (live && live.sessions > 0 ? ' busy' : '') + '" id="hDot"></span></span>'
			+ '<div class="hmain"><h2 id="hName">' + escapeHtml(heroOf.name) + '</h2>'
			+ '<div class="hsub" id="hDesc">' + escapeHtml(heroOf.description ?? '（没写 description）') + '</div>'
			+ '<div class="hchips" id="hChips">' + modelChip
			+ '<span class="hchip">' + (heroOf.tools.length ? heroOf.tools.length + ' 工具白名单' : '不限工具') + '</span>'
			+ '<span class="hchip">人设 ' + heroOf.persona.length + ' 字</span>'
			+ (heroOf.skills?.length ? '<span class="hchip p">skill: ' + escapeHtml(heroOf.skills.join(', ')) + '</span>' : '') + '</div>'
			+ '<div class="hstats" id="hStats">' + (live && live.sessions > 0 ? '<span>会话 <b>' + live.sessions + '</b></span><span>token <b>' + fmtTokens(live.tokens) + '</b></span>' : '<span>还没有会话</span>')
			+ ((asgRunningOf.get(heroOf.id) ?? 0) > 0 ? '<span>委派 <b>' + asgRunningOf.get(heroOf.id) + ' 在跑</b></span>' : '') + '<span id="hMem"></span></div></div>'
			+ '<div class="hacts"><button class="act" onclick="heroChat()">发起会话</button><button class="act" onclick="heroDelegate()">委派任务</button><button class="act" onclick="heroSettings()">⚙ Agent 设置</button></div>'
			+ '</div>';
	})() : '';
	// 概览签 = Bot 主页（方案 A 第 2 步，2026-10-16；doc/agents-botmode-mockup.html）：身份条 + 四块面板
	// （会话 / Bot 收件箱 / 记忆 / 定时）。每个 agent 的数据按 id 存在 data-home 上，换人只重渲（lib/home.js ★）。
	const homeData = buildHomeData({ agents, sessionRows, assignments, groups });
	const overview = heroOf
		? '<div id="overview" data-vssaros-home data-home="' + escapeHtml(JSON.stringify(homeData)) + '"><section class="pad">'
			+ '<div class="idstrip"><span class="lbl">身份（.agent.md）</span>'
			+ '<span class="hchip">📄 <span class="idchip" id="ovFile">' + escapeHtml(heroOf.file ?? '（未知）') + '</span></span>'
			+ '<span class="hchip" id="ovMem" style="display:none"></span>'
			+ '<button class="act" onclick="heroSettings()" title="打开该 bot 的 Agent 设置页">打开编辑器</button></div>'
			+ '<div class="home-grid" id="homeGrid">' + homePanelsHtml(homeData[heroOf.id], escapeHtml) + '</div>'
			+ '</section></div>'
		: '<div id="overview"><p class="empty">还没有可用的 agent。</p></div>';
const tabNav = '<nav class="seg"><button id="tabOverview" class="on" onclick="showTab(\'overview\')">概览</button>'
	+ '<button id="tabRoster" onclick="showTab(\'roster\')">身份 ' + summary.count + '</button>'
		+ '<button id="tabAssign" data-vssaros-assignments-tab onclick="showTab(\'assignments\')" data-assignments-running="' + (assignments?.running ?? 0) + '">委派 ' + assignmentItems.length + '</button>'
		+ '<button id="tabGrant" data-vssaros-grants-tab onclick="showTab(\'grants\')">授权 ' + templateItems.length + '</button>'
		+ '<button id="tabGroup" data-vssaros-groups-tab onclick="showTab(\'groups\')">群聊 ' + groupItems.length + '</button>'
		+ '<button id="tabMemory" data-vssaros-memory-tab onclick="showTab(\'memory\')">记忆</button>'
		+ (usage ? '<button id="tabUsage" data-vssaros-usage-tab onclick="showTab(\'usage\')" data-usage-sessions="' + usage.totals.sessions + '" data-usage-tokens="' + usage.totals.tokens + '">用量 ' + usage.totals.sessions + '</button>' : '') + '</nav>';
	// 页面脚本：页签 + 行展开 + 筛选 + 焦点交接。都是纯前端增强，关掉 JS 也读得到全部内容。
	const script = '<script>'
		// 侧栏名册 → 本页的焦点交接键（与 sideview.js 的 FOCUS_KEY 同值；插件内两个页面文件各持一份字面量，
		// 靠 p3-06 的断言对账，不跨文件 import 页面脚本 —— 页面脚本是字符串，import 的是构建期符号 ✓）
		+ 'var FOCUS_KEY = "vssaros.agents.focus";'
		// 打开该 bot 的 VsSaros「Agent 设置」编辑器页（桥 `5 → 6`）。页面开不了编辑器 ⇒ 只能请宿主开。
		// 宿主版本旧（preload 没暴露这个 key）时在头部提示一行，**不静默失败** ✓。
		+ 'function openAgentSettings(id, name) {'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openAgentSettings !== 'function') { note('当前宿主不支持从这里打开 Agent 设置（需要桥版本 6 的宿主）'); return; }"
		+ "try { bridge.openAgentSettings(id, name); note(''); } catch (e) { note('打开 Agent 设置失败：' + e); }"
		+ '}'
		// 从行上的齿轮 / 抽屉按钮取 id（`li.item[data-agent-id]` 是行的身份锚点 ✓），顺便把显示名带上
		+ 'function openAgentSettingsFrom(el) {'
		+ "var li = el && el.closest ? el.closest('li.item') : null;"
		+ 'if (!li) { return; }'
		+ "var n = li.querySelector('.name');"
		+ "openAgentSettings(li.getAttribute('data-agent-id'), n ? n.textContent : undefined);"
		+ '}'
		+ 'function note(text) {'
		+ "var el = document.getElementById('pageNote');"
		+ 'if (!el) { return; }'
		+ "if (!text) { el.hidden = true; el.textContent = ''; return; }"
		+ 'el.textContent = text;'
		+ 'el.hidden = false;'
		+ '}'
		+ 'function showTab(which) {'
		+ "var panes = ['overview', 'roster', 'usage', 'assignments', 'grants', 'groups', 'memory', 'create'];"
		+ "for (var i = 0; i < panes.length; i++) {"
		+ 'var pane = document.getElementById(panes[i]);'
		+ 'if (pane) { pane.hidden = panes[i] !== which; }'
		+ '}'
		// 新建向导要整块宽度 ⇒ 打开时收起 hero（hero 讲的是「当前 agent」，新建时没有当前 agent ✓）
		+ "var heroEl = document.getElementById('hero');"
		+ "if (heroEl) { heroEl.hidden = which === 'create'; }"
		+ "var tabs = { overview: 'tabOverview', roster: 'tabRoster', usage: 'tabUsage', assignments: 'tabAssign', grants: 'tabGrant', groups: 'tabGroup', memory: 'tabMemory' };"
		+ 'for (var k in tabs) {'
		+ 'var t = document.getElementById(tabs[k]);'
		+ "if (t) { t.classList.toggle('on', k === which); }"
		+ '}'
		+ '}'
		+ 'function toggleRow(el) { var li = el.parentElement; if (li) { li.classList.toggle(\'open\'); updateHero(li); } }'
		// Hero（款 A）：点名册行 ⇒ hero 换成该 agent（数据全在行的 data-h-* 上，JS 只搬运 ✓）。
		// 快捷动作：发起会话 = 桥 newChat（绑 preset 的新会话页签 ✓）；委派 = 开委派签并预选；
		// 设置 = 既有 openAgentSettingsFrom 链。没桥 ⇒ note 提示，不静默 ✓。
		+ 'var H_AGENT = "";'
		+ 'function updateHero(li) {'
		+ 'if (!li || !li.getAttribute) { return; }'
		+ "var hero = document.getElementById('hero');"
		+ 'if (!hero) { return; }'
		+ 'H_AGENT = li.getAttribute("data-agent-id") || "";'
		+ 'hero.setAttribute("data-h-agent", H_AGENT);'
		+ 'hero.setAttribute("data-h-preset", li.getAttribute("data-h-preset") || "");'
		+ "var av = li.querySelector('.avatar');"
		+ "var hav = document.getElementById('hAvatar');"
		+ 'if (av && hav) { hav.style.background = av.style.background; }'
		+ "var hEmoji = document.getElementById('hEmoji');"
		+ 'if (hEmoji && av) { hEmoji.textContent = av.textContent; }'
		+ "var hDot = document.getElementById('hDot');"
		+ 'if (hDot) { hDot.className = "dot" + (li.getAttribute("data-h-live") ? " busy" : ""); }'
		+ "var hName = document.getElementById('hName');"
		+ 'if (hName) { hName.textContent = li.getAttribute("data-h-name") || H_AGENT; }'
		+ "var hDesc = document.getElementById('hDesc');"
		+ 'if (hDesc) { hDesc.textContent = li.getAttribute("data-h-desc") || "（没写 description）"; }'
		+ "var hChips = document.getElementById('hChips');"
		+ 'if (hChips) {'
		+ 'var modelWarn = li.getAttribute("data-h-model-warn") === "1";'
		+ 'var tools = li.getAttribute("data-h-tools");'
		+ 'var persona = li.getAttribute("data-h-persona");'
		+ 'var skills = li.getAttribute("data-h-skills") || "";'
		// ⚠ 这三行整体是**页面脚本字符串**（detail.js 外层单引号串），里头的拼接/三元是给浏览器看的，
		//   不许在服务端求值（上一版把三元写到了外层 ⇒ modelWarn is not defined 整页 500 ✗）
		+ 'hChips.innerHTML = "<span class=\\"hchip " + (modelWarn ? "warn2" : "ok") + "\\">" + esc(li.getAttribute("data-h-model") || "默认模型") + "</span>"'
		+ ' + "<span class=\\"hchip\\">" + (tools === "0" ? "不限工具" : tools + " 工具白名单") + "</span>"'
		+ ' + "<span class=\\"hchip\\">人设 " + esc(persona) + " 字</span>"'
		+ ' + (skills ? "<span class=\\"hchip p\\">skill: " + esc(skills) + "</span>" : "");'
		+ '}'
		+ "var hStats = document.getElementById('hStats');"
		+ 'if (hStats) {'
		+ 'var live = li.getAttribute("data-h-live") || "";'
		+ 'var asg = li.getAttribute("data-h-asg") || "0";'
		+ 'hStats.innerHTML = live ? "<span>" + esc(live) + "</span>" : "<span>还没有会话</span>";'
		+ 'if (asg !== "0") { hStats.innerHTML += "<span>委派 <b>" + esc(asg) + " 在跑</b></span>"; }'
		+ 'hStats.innerHTML += "<span id=\\"hMem\\"></span>";'
		+ '}'
		// Bot 主页（方案 A）：四块面板随 hero 换人重渲（数据在 #overview 的 data-home 上 ✓）
		+ 'renderHome(H_AGENT);'
		+ "var ovFile = document.getElementById('ovFile');"
		+ 'if (ovFile) { ovFile.textContent = li.getAttribute("data-h-file") || "（未知）"; }'
		+ "var ovMem = document.getElementById('ovMem');"
		+ 'if (ovMem) { ovMem.style.display = "none"; }'
		+ 'loadMemory(H_AGENT);'
		+ '}'
		// 款 A（E4/E8b）：记忆数据 = 异步 fetch memory API（Git 提交数 → hero「记忆 N 次提交」、
		// MEMORY.md 是否存在 + 最近 hash → 身份卡第二枚 chip）。失败静默（不显示，不报错 ✓）。
		+ 'function loadMemory(agentId) {'
		+ 'if (!agentId) { return; }'
		+ 'fetch("/x/agents/api/memory?agent=" + encodeURIComponent(agentId))'
		+ '.then(function (r) { return r.ok ? r.json() : null; })'
		+ '.then(function (j) {'
		+ 'homeMemoryFill(j);'
		+ 'if (!j) { return; }'
		+ 'var hasMem = (j.files || []).some(function (f) { return f.name === "MEMORY.md"; });'
		+ 'var hash = j.log && j.log.length ? j.log[0].hash : "";'
		+ 'var ovMem = document.getElementById("ovMem");'
		+ 'if (ovMem) {'
		+ 'if (hasMem) { ovMem.textContent = "📄 memory/MEMORY.md" + (hash ? " · " + hash : ""); ovMem.style.display = ""; }'
		+ 'else { ovMem.style.display = "none"; }'
		+ '}'
		+ 'var commits = j.git && j.git.enabled ? j.git.commits : 0;'
		+ 'var hMem = document.getElementById("hMem");'
		+ 'if (hMem) { hMem.innerHTML = commits > 0 ? "记忆 <b>" + commits + " 次提交</b>" : ""; }'
		+ '})'
		+ '.catch(function () { homeMemoryFill(null); });'
		+ '}'
		// 初始聚焦 = 服务端渲染的第一个 agent（hero 的 data-h-agent 上有 ✓）
		+ '(function () {'
		+ "var hero = document.getElementById('hero');"
		+ 'if (hero) { H_AGENT = hero.getAttribute("data-h-agent") || ""; }'
		+ 'loadMemory(H_AGENT);'
		+ '})();'
		+ HOME_CLIENT_JS
		+ 'function heroChat() {'
		+ "var hero = document.getElementById('hero');"
		+ 'var preset = hero ? hero.getAttribute("data-h-preset") : "";'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.newChat !== 'function') { note('当前宿主不支持从这里开会话（需要带 newChat 的宿主）'); return; }"
		+ "if (!preset) { note('没拿到该 agent 的 preset id'); return; }"
		+ "try { bridge.newChat(preset); note(''); } catch (e) { note('开会话失败：' + e); }"
		+ '}'
		+ 'function heroDelegate() {'
		+ "if (!H_AGENT) { note('先点名册行选一个 agent'); return; }"
		+ "showTab('assignments');"
		+ "var sel = document.getElementById('aAgent');"
		+ 'if (sel) { sel.value = H_AGENT; }'
		+ "var input = document.getElementById('aTask');"
		+ 'if (input) { input.focus(); }'
		+ '}'
		+ 'function heroSettings() {'
		+ "if (!H_AGENT) { note('先点名册行选一个 agent'); return; }"
		+ "var hName = document.getElementById('hName');"
		+ "openAgentSettings(H_AGENT, hName ? hName.textContent : undefined);"
		+ '}'
		+ 'function filterRows() {'
		+ "var box = document.getElementById('q');"
		+ "var out = document.getElementById('qCount');"
		+ 'var q = box ? String(box.value || \'\').trim().toLowerCase() : \'\';'
		+ "var all = document.querySelectorAll('#roster li.item');"
		+ 'var hit = 0;'
		+ 'for (var i = 0; i < all.length; i++) {'
		+ "var t = all[i].getAttribute('data-search') || '';"
		+ 'var show = !q || t.indexOf(q) >= 0;'
		+ 'all[i].hidden = !show;'
		+ 'if (show) { hit++; }'
		+ '}'
		+ 'if (out) { out.textContent = q ? hit + \'/\' + all.length : String(all.length); }'
		+ '}'
		// 焦点交接（2026-10-16，方案 D）：展开指定 agent 的行并滚到它。只在名册页签有意义 ⇒
		// 交接到达时若停在用量页签，先切回名册（否则"滚过去"滚的是隐藏区块，用户看不见 ✗）。
		+ 'function applyFocus(id) {'
		+ 'if (!id) { return; }'
		// 新建交接（2026-10-16，方案 A）："create:<起点>" ⇒ 开新建向导。向导脚本排在主脚本之后
		// （首次加载时这里先跑）⇒ 推迟一拍再调 crBegin ✓
		+ "if (id.indexOf('create:') === 0) {"
		+ "var crKind = id.slice(7) || 'blank';"
		+ "showTab('create');"
		+ 'setTimeout(function () { if (window.crBegin) { crBegin(crKind); } }, 0);'
		+ 'return;'
		+ '}'
		// 页签交接："tab:<页签>"（侧栏「新建群聊」⇒ 开群聊签，建群表单在那里 ✓）
		+ "if (id.indexOf('tab:') === 0) {"
		+ 'showTab(id.slice(4));'
		+ 'return;'
		+ '}'
		// 聊天框欢迎卡（方案 A 第 3 步）的两个按钮：
		//   "home:<agentId>"   ⇒ hero 换成该 agent + 停在概览签（= Bot 主页）；
		//   "memory:<agentId>" ⇒ 记忆签并选中该 agent（已加载过就手动重读一次）。
		// ⚠ 推迟一拍：首次加载时这里先于「showTab 记忆签覆写」与 M_LOADED 赋值执行（同 create: 的理由 ✓）
		+ "if (id.indexOf('home:') === 0 || id.indexOf('memory:') === 0) {"
		+ "var isMem = id.indexOf('memory:') === 0;"
		+ 'var aid = id.slice(isMem ? 7 : 5);'
		+ 'setTimeout(function () {'
		+ "var hli = document.querySelector('#roster li.item[data-agent-id=\"' + aid + '\"]');"
		+ 'if (hli) { updateHero(hli); }'
		+ 'if (isMem) {'
		+ "var msel = document.getElementById('mAgent');"
		+ 'if (msel) { msel.value = aid; }'
		+ 'var wasLoaded = M_LOADED;'
		+ "showTab('memory');"
		+ 'if (wasLoaded) { memoryLoad(); }'
		+ '} else {'
		+ "showTab('overview');"
		+ '}'
		+ '}, 0);'
		+ 'return;'
		+ '}'
		// 群聊交接（2026-10-16，二期）：id 形如 "group:<群id>" ⇒ 开群聊页签并选中该群 ✓
		+ "if (id.indexOf('group:') === 0) {"
		+ "showTab('groups');"
		+ "selectGroupById(id.slice(6));"
		+ 'return;'
		+ '}'
		// 委派交接（款 A，sideview 的「委派」快捷动作）："delegate:<agentId>" ⇒ 开委派签并预选 ✓
		+ "if (id.indexOf('delegate:') === 0) {"
		+ 'H_AGENT = id.slice(9);'
		+ 'heroDelegate();'
		+ 'return;'
		+ '}'
		+ "var li = document.querySelector('#roster li.item[data-agent-id=\"' + id + '\"]');"
		+ 'if (!li) { return; }'
		+ "showTab('roster');"
		+ "var box = document.getElementById('q');"
		+ "if (box && box.value) { box.value = ''; filterRows(); }"
		+ "li.classList.add('open');"
		+ 'updateHero(li);'
		+ "li.scrollIntoView({ block: 'center' });"
		+ '}'
		+ 'function focusFromStorage() {'
		+ 'try {'
		+ "var raw = window.localStorage ? localStorage.getItem(FOCUS_KEY) : null;"
		+ 'if (!raw) { return; }'
		+ 'localStorage.removeItem(FOCUS_KEY);'
		+ "applyFocus(String(raw).split('|')[0]);"
		+ '} catch (e) { /* localStorage 不可用就静默跳过——页面主体不受影响 */ }'
		+ '}'
		+ 'window.addEventListener("storage", function (e) {'
		+ 'if (e && e.key === FOCUS_KEY && e.newValue) {'
		+ "applyFocus(String(e.newValue).split('|')[0]);"
		+ '}'
		+ '});'
		+ 'focusFromStorage();'
		// ── 委派页签（2026-10-16，P1）：创建/追问/中断走 /x/agents/api/assignments；轮询刷新。
		// 失败必须进 pageNote，不静默 ✓。
		+ 'function esc(s) {'
		+ 'return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {'
		+ 'return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;" }[c];'
		+ '});'
		+ '}'
		+ 'function assignmentPost(body) {'
		+ "return fetch('/x/agents/api/assignments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })"
		+ '.then(function (r) {'
		+ 'return r.json().catch(function () { return {}; }).then(function (j) {'
		+ "if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }"
		+ 'return j;'
		+ '});'
		+ '});'
		+ '}'
		+ 'function assignmentCreate() {'
		+ "var sel = document.getElementById('aAgent');"
		+ "var input = document.getElementById('aTask');"
		+ 'var task = input ? input.value.trim() : "";'
		+ "if (!sel || !task) { note(task ? '' : '任务不能为空'); return; }"
		+ 'assignmentPost({ agent: sel.value, task: task })'
		+ '.then(function () { input.value = ""; note(""); refreshAssignments(); })'
		+ '.catch(function (e) { note("委派失败：" + e.message); });'
		+ '}'
		+ 'function assignmentIdOf(el) {'
		+ "var tr = el && el.closest ? el.closest('tr[data-assignment-id]') : null;"
		+ "return tr ? tr.getAttribute('data-assignment-id') : '';"
		+ '}'
		+ 'function assignmentAsk(el) {'
		+ 'var id = assignmentIdOf(el);'
		+ "var text = window.prompt('追问内容（发到该委派的同一条会话）：');"
		+ 'if (!id || !text || !text.trim()) { return; }'
		+ "assignmentPost({ action: 'ask', id: id, message: text.trim() })"
		+ '.then(function () { note(""); refreshAssignments(); })'
		+ '.catch(function (e) { note("追问失败：" + e.message); });'
		+ '}'
		+ 'function assignmentCancel(el) {'
		+ 'var id = assignmentIdOf(el);'
		+ "if (!id || !window.confirm('中断这条委派？（停掉其会话的当前回合）')) { return; }"
		+ "assignmentPost({ action: 'cancel', id: id })"
		+ '.then(function () { note(""); refreshAssignments(); })'
		+ '.catch(function (e) { note("中断失败：" + e.message); });'
		+ '}'
		+ 'function fmtClock(ts) {'
		+ 'try { return new Date(ts).toISOString().slice(5, 16).replace("T", " "); } catch (e) { return "—"; }'
		+ '}'
		+ 'function refreshAssignments() {'
		+ "fetch('/x/agents/api/assignments').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {"
		+ 'if (!j) { return; }'
		+ "var body = document.getElementById('aRows');"
		+ 'if (body) {'
		+ 'var rows = [];'
		+ 'for (var i = 0; i < (j.items || []).length; i++) {'
		+ 'var a = j.items[i];'
		+ 'var tag = a.status === "running" ? "<span class=\\"tag run\\">运行中</span>"'
		+ ': a.status === "done" ? "<span class=\\"tag done2\\">已完成</span>"'
		+ ': "<span class=\\"tag cancel2\\">已中断</span>";'
		+ 'var acts = a.status === "running"'
		+ '? "<button class=\\"act\\" onclick=\\"assignmentAsk(this)\\">追问</button><button class=\\"act\\" onclick=\\"assignmentCancel(this)\\">中断</button>"'
		+ ': "<button class=\\"act\\" onclick=\\"assignmentAsk(this)\\">追问</button>";'
		+ 'rows.push("<tr data-assignment-id=\\"" + esc(a.id) + "\\"><td><b>" + esc(a.agentName || a.agentId) + "</b></td><td>"'
		+ ' + esc(a.task && a.task.length > 60 ? a.task.slice(0, 60) + "…" : a.task) + "</td><td>" + tag'
		+ ' + (a.error ? "<br><span class=\\"unmapped\\">" + esc(a.error) + "</span>" : "")'
		+ ' + "</td><td>" + fmtClock(a.updatedAt) + "</td><td>" + acts + "</td></tr>");'
		+ '}'
		+ 'body.innerHTML = rows.length ? rows.join("") : "<tr class=\\"unknown\\"><td colspan=\\"5\\">还没有委派。</td></tr>";'
		+ '}'
		+ "var tab = document.getElementById('tabAssign');"
		+ 'if (tab) {'
		+ "tab.textContent = '委派 ' + ((j.items || []).length);"
		+ "tab.setAttribute('data-assignments-running', String(j.running || 0));"
		+ '}'
		+ '}).catch(function () { /* 轮询失败下轮再来，不打搅 */ });'
		+ '}'
		+ 'window.setInterval(function () {'
		+ "if (document.hidden) { return; }"
		+ "var pane = document.getElementById('assignments');"
		+ 'if (pane && !pane.hidden) { refreshAssignments(); }'
		+ '}, 6000);'
		// ── 授权页签（2026-10-16，P2）：模板增删走 /x/agents/api/approval-templates；就地刷新不重载 ✓。
		+ 'function templatePost(body) {'
		+ "return fetch('/x/agents/api/approval-templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })"
		+ '.then(function (r) {'
		+ 'return r.json().catch(function () { return {}; }).then(function (j) {'
		+ "if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }"
		+ 'return j;'
		+ '});'
		+ '});'
		+ '}'
		+ 'function renderTemplates(list) {'
		+ "var body = document.getElementById('tRows');"
		+ 'if (!body) { return; }'
		+ 'if (!list.length) { body.innerHTML = "<tr class=\\"unknown\\"><td>还没有模板——过闸工具每次都会问。</td></tr>"; return; }'
		+ 'var rows = [];'
		+ 'for (var i = 0; i < list.length; i++) {'
		+ 'var t = list[i];'
		+ 'rows.push("<tr data-template-tool=\\"" + esc(t.tool) + "\\"><td class=\\"mono\\">" + esc(t.tool) + "</td><td>" + esc(t.note || "") + "</td><td>" + fmtClock(t.createdAt) + "</td><td><button class=\\"act\\" onclick=\\"templateRemove(this)\\">删除</button></td></tr>");'
		+ '}'
		+ 'body.innerHTML = rows.join("");'
		+ "var tab = document.getElementById('tabGrant');"
		+ "if (tab) { tab.textContent = '授权 ' + list.length; }"
		+ '}'
		+ 'function templateAdd() {'
		+ "var sel = document.getElementById('tTool');"
		+ "var noteEl = document.getElementById('tNote');"
		+ 'if (!sel) { return; }'
		+ "templatePost({ action: 'add', tool: sel.value, note: noteEl ? noteEl.value.trim() : '' })"
		+ '.then(function (j) { if (noteEl) { noteEl.value = ""; } note(""); renderTemplates(j.templates || []); })'
		+ '.catch(function (e) { note("存模板失败：" + e.message); });'
		+ '}'
		+ 'function templateRemove(el) {'
		+ "var tr = el && el.closest ? el.closest('tr[data-template-tool]') : null;"
		+ "var tool = tr ? tr.getAttribute('data-template-tool') : '';"
		+ 'if (!tool) { return; }'
		+ "if (!window.confirm('删除「' + tool + '」的审批模板？（之后它每次执行都会再问）')) { return; }"
		+ "templatePost({ action: 'remove', tool: tool })"
		+ '.then(function (j) { note(""); renderTemplates(j.templates || []); })'
		+ '.catch(function (e) { note("删除模板失败：" + e.message); });'
		+ '}'
		// Outbox（2026-10-16 二期）：手动重发是 unknown-outcome 的**唯一**重发口（带 confirm ✓）。
		+ 'function outboxRetry(el) {'
		+ "var tr = el && el.closest ? el.closest('tr[data-outbox-id]') : null;"
		+ "var id = tr ? tr.getAttribute('data-outbox-id') : '';"
		+ 'if (!id) { return; }'
		+ "if (!window.confirm('手动重发这条回传？（它之前投递失败过——若实际已送达，对方会收到两次）')) { return; }"
		+ "fetch('/x/agents/api/outbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry', id: id }) })"
		+ '.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {'
		+ "if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }"
		+ "note(''); refreshOutbox();"
		+ '}) })'
		+ '.catch(function (e) { note("重发失败：" + e.message); });'
		+ '}'
		+ 'function refreshOutbox() {'
		+ "fetch('/x/agents/api/outbox').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {"
		+ 'if (!j) { return; }'
		+ "var body = document.getElementById('oRows');"
		+ 'if (!body) { return; }'
		+ 'var rows = [];'
		+ 'for (var i = 0; i < (j.entries || []).length; i++) {'
		+ 'var e = j.entries[i];'
		+ 'var tag = e.status === "unknown" ? "<span class=\\"tag cancel2\\">unknown-outcome</span>"'
		+ ' : e.status === "pending" ? "<span class=\\"tag run\\">在途</span>" : "<span class=\\"tag done2\\">已回收</span>";'
		+ 'var where = e.kind === "group" ? "群聊回收" : ("回传到 " + esc(e.from || "(无)"));'
		+ 'rows.push("<tr data-outbox-id=\\"" + esc(e.id) + "\\"><td class=\\"mono\\">" + esc(String(e.messageId || "").slice(0, 8)) + "</td><td>" + where + "</td><td>" + tag'
		+ ' + (e.note ? "<br><span class=\\"unmapped\\">" + esc(e.note) + "</span>" : "")'
		+ ' + "</td><td>" + fmtClock(e.sentAt) + "</td><td>"'
		+ ' + (e.status === "unknown" ? "<button class=\\"act\\" onclick=\\"outboxRetry(this)\\">手动重发</button>" : "—")'
		+ ' + "</td></tr>");'
		+ '}'
		+ 'body.innerHTML = rows.length ? rows.join("") : "<tr class=\\"unknown\\"><td colspan=\\"5\\">队列是空的。</td></tr>";'
		+ '}).catch(function () { /* 下轮再来 */ });'
		+ '}'
		// ── 群聊页签（2026-10-16，二期）：选中/发消息/建群/删群 + 轮询 transcript。
		+ 'var G_SELECTED = "";'
		+ 'function groupPost(body) {'
		+ "return fetch('/x/agents/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })"
		+ '.then(function (r) {'
		+ 'return r.json().catch(function () { return {}; }).then(function (j) {'
		+ "if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }"
		+ 'return j;'
		+ '});'
		+ '});'
		+ '}'
		+ 'function renderGroupList(groups) {'
		+ "var el = document.getElementById('gList');"
		+ 'if (!el) { return; }'
		+ 'if (!groups.length) { el.innerHTML = "<p class=\\"diag\\">还没有群。</p>"; return; }'
		+ 'var html = "";'
		+ 'for (var i = 0; i < groups.length; i++) {'
		+ 'var g = groups[i];'
		+ 'html += "<div class=\\"gitem" + (g.id === G_SELECTED ? " on" : "") + "\\" data-group-id=\\"" + esc(g.id) + "\\" onclick=\\"selectGroup(this)\\">"'
		+ ' + "<b># " + esc(g.name) + "</b> <span class=\\"gm\\">" + (g.mode === "open" ? "open" : "admin") + " · 成员 " + (g.members ? g.members.length : 0) + "</span></div>";'
		+ '}'
		+ 'el.innerHTML = html;'
		+ '}'
		+ 'function renderTranscript(g) {'
		+ "var log = document.getElementById('gLog');"
		+ 'if (!log) { return; }'
		+ 'var items = (g && g.transcript) || [];'
		+ 'if (!items.length) { log.innerHTML = "<p class=\\"diag\\">还没有消息。</p>"; return; }'
		+ 'var html = "";'
		+ 'for (var i = 0; i < items.length; i++) {'
		+ 'var m = items[i];'
		+ 'var cls = m.role === "user" ? "gmsg me" : m.role === "system" ? "gmsg sys" : "gmsg";'
		+ 'var who = m.role === "user" ? "你" : m.role === "system" ? "" : esc(m.name || m.agentId || "成员");'
		+ 'html += "<div class=\\"" + cls + "\\">" + (who ? "<div class=\\"who\\">" + who + "</div>" : "")'
		+ ' + "<div class=\\"bubble\\">" + esc(m.text) + "</div></div>";'
		+ '}'
		+ 'log.innerHTML = html;'
		+ 'log.scrollTop = log.scrollHeight;'
		+ '}'
		+ 'function refreshGroups(keepSel) {'
		+ "return fetch('/x/agents/api/groups').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {"
		+ 'if (!j) { return; }'
		+ 'renderGroupList(j.groups || []);'
		+ 'var sel = null;'
		+ 'for (var i = 0; i < (j.groups || []).length; i++) { if (j.groups[i].id === G_SELECTED) { sel = j.groups[i]; } }'
		+ 'if (sel) { renderTranscript(sel); }'
		+ "var tab = document.getElementById('tabGroup');"
		+ "if (tab) { tab.textContent = '群聊 ' + (j.groups || []).length; }"
		+ '}).catch(function () { /* 轮询失败下轮再来 */ });'
		+ '}'
		+ 'function selectGroupById(id) {'
		+ 'G_SELECTED = id;'
		+ "var items = document.querySelectorAll('#gList .gitem');"
		+ 'for (var i = 0; i < items.length; i++) {'
		+ 'items[i].classList.toggle("on", items[i].getAttribute("data-group-id") === id);'
		+ '}'
		+ "var input = document.getElementById('gInput');"
		+ "var btn = document.getElementById('gSend');"
		+ 'if (input) { input.disabled = !id; }'
		+ 'if (btn) { btn.disabled = !id; }'
		+ 'refreshGroups(true);'
		+ '}'
		+ 'function selectGroup(el) {'
		+ "var id = el && el.getAttribute ? el.getAttribute('data-group-id') : '';"
		+ 'if (id) { selectGroupById(id); }'
		+ '}'
		+ 'function groupCreate() {'
		+ "var nameEl = document.getElementById('gName');"
		+ "var modeEl = document.getElementById('gMode');"
		+ 'var name = nameEl ? nameEl.value.trim() : "";'
		+ "if (!name) { note('群名不能为空'); return; }"
		+ "var chips = document.querySelectorAll('#gMembers .mchip.on');"
		+ 'var members = [];'
		+ 'for (var i = 0; i < chips.length; i++) { members.push(chips[i].getAttribute("data-member")); }'
		+ "if (!members.length) { note('至少勾一个成员'); return; }"
		+ "groupPost({ action: 'create', name: name, mode: modeEl ? modeEl.value : 'admin', members: members })"
		+ '.then(function (g) { nameEl.value = ""; note(""); G_SELECTED = g.id; refreshGroups(true); })'
		+ '.catch(function (e) { note("建群失败：" + e.message); });'
		+ '}'
		+ 'function groupSend() {'
		+ "var input = document.getElementById('gInput');"
		+ 'var text = input ? input.value.trim() : "";'
		+ "if (!G_SELECTED || !text) { note(text ? '' : '消息不能为空'); return; }"
		+ "groupPost({ action: 'message', id: G_SELECTED, text: text })"
		+ '.then(function () { input.value = ""; note(""); refreshGroups(true); })'
		+ '.catch(function (e) { note("发送失败：" + e.message); });'
		+ '}'
		+ 'window.setInterval(function () {'
		+ "if (document.hidden) { return; }"
		+ "var pane = document.getElementById('groups');"
		+ 'if (pane && !pane.hidden && G_SELECTED) { refreshGroups(true); }'
		+ "var gp = document.getElementById('grants');"
		+ 'if (gp && !gp.hidden) { refreshOutbox(); }'
		+ '}, 6000);'
		// ── 记忆页签（2026-10-16，二期）：全走 api/memory；失败进 pageNote 不静默 ✓。
		+ 'var M_FILE = "";'
		+ 'function memoryApi(params) {'
		+ "var sel = document.getElementById('mAgent');"
		+ "var agent = sel ? sel.value : '';"
		+ 'if (!agent) { return Promise.resolve(null); }'
		+ "var q = '/x/agents/api/memory?agent=' + encodeURIComponent(agent) + (params || '');"
		+ 'return fetch(q).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {'
		+ "if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }"
		+ 'return j;'
		+ '}); });'
		+ '}'
		+ 'function memoryRender(j) {'
		+ 'if (!j) { return; }'
		+ "var bar = document.getElementById('mBar');"
		+ 'if (bar) {'
		+ 'bar.innerHTML = j.git && j.git.enabled'
		+ ' ? "<span class=\\"on-git\\">🌿 Git 已启用 · " + esc(j.git.branch) + " · " + j.git.commits + " 次提交</span>"'
		+ '   + (j.git.dirty > 0 ? "<span class=\\"dirty\\">● " + j.git.dirty + " 个未提交</span>" : "<span>干净</span>")'
		+ '   + "<span style=\\"margin-left:auto\\"></span>"'
		+ '   + "<button class=\\"act\\" onclick=\\"memorySnapshot()\\">提交快照</button>"'
		+ ' : "<span>还不是 Git 仓库 · 文件读写不受影响</span><span style=\\"margin-left:auto\\"></span><button class=\\"act\\" onclick=\\"memoryEnableGit()\\">启用 Git 版本化</button>";'
		+ '}'
		+ "var list = document.getElementById('mList');"
		+ 'if (list) {'
		+ 'var dirtySet = {};'
		+ 'if (j.git && j.git.dirtyFiles) { for (var d = 0; d < j.git.dirtyFiles.length; d++) { dirtySet[j.git.dirtyFiles[d]] = true; } }'
		+ 'list.innerHTML = (j.files && j.files.length)'
		+ ' ? j.files.map(function (f) {'
		+ '   return "<div class=\\"memfile" + (f.name === M_FILE ? " on" : "") + "\\" data-memory-file=\\"" + esc(f.name) + "\\" onclick=\\"memoryView(this)\\">"'
		+ '   + "<span>📄 " + esc(f.name) + "</span>"'
		+ '   + (j.git && j.git.enabled ? "<span class=\\"mk" + (dirtySet[f.name] ? " no" : "") + "\\">" + (dirtySet[f.name] ? "●" : "✓") + "</span>" : "")'
		+ '   + "</div>";'
		+ ' }).join("")'
		+ ' : "<p class=\\"diag\\">还没有记忆文件（agent 用文件工具写进 memory/ 目录）。</p>";'
		+ '}'
		+ "var log = document.getElementById('mLog');"
		+ 'if (log) {'
		+ 'log.innerHTML = j.git && j.git.enabled && j.log && j.log.length'
		+ ' ? "<b>提交历史（只读）</b>" + j.log.map(function (l) { return "<div class=\\"lr\\"><span class=\\"h\\">" + esc(l.hash) + "</span><span>" + esc(l.subject) + "</span><span class=\\"t\\">" + esc(l.date) + "</span></div>"; }).join("")'
		+ ' : "";'
		+ '}'
		+ '}'
		+ 'function memoryLoad() {'
		+ 'M_FILE = "";'
		+ "var t = document.getElementById('mTitle');"
		+ "var b = document.getElementById('mBody');"
		+ 'if (t) { t.textContent = "选一个文件"; }'
		+ 'if (b) { b.textContent = "…"; }'
		+ 'memoryApi("").then(memoryRender).catch(function (e) { note("记忆读取失败：" + e.message); });'
		+ '}'
		+ 'function memoryView(el) {'
		+ "var name = el && el.getAttribute ? el.getAttribute('data-memory-file') : '';"
		+ 'if (!name) { return; }'
		+ 'M_FILE = name;'
		+ 'memoryApi("&file=" + encodeURIComponent(name)).then(function (j) {'
		+ 'if (!j) { return; }'
		+ 'memoryRender(j);'
		+ "var t = document.getElementById('mTitle');"
		+ "var b = document.getElementById('mBody');"
		+ 'if (t) { t.textContent = name; }'
		+ 'if (b) { b.textContent = j.content ? j.content.text : "（读不到内容）"; }'
		+ '}).catch(function (e) { note("读文件失败：" + e.message); });'
		+ '}'
		+ 'function memoryEnableGit() {'
		+ "var sel = document.getElementById('mAgent');"
		+ 'if (!sel) { return; }'
		+ "fetch('/x/agents/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'enable-git', agent: sel.value }) })"
		+ '.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {'
		+ "if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }"
		+ "note(''); memoryLoad();"
		+ '}) })'
		+ '.catch(function (e) { note("启用 Git 失败：" + e.message); });'
		+ '}'
		+ 'function memorySnapshot() {'
		+ "var sel = document.getElementById('mAgent');"
		+ 'if (!sel) { return; }'
		+ "var msg = window.prompt('快照说明（可空）：');"
		+ 'if (msg === null) { return; }'
		+ "fetch('/x/agents/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'snapshot', agent: sel.value, message: msg }) })"
		+ '.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {'
		+ "if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }"
		+ "note(j.note || ''); memoryLoad();"
		+ '}) })'
		+ '.catch(function (e) { note("提交快照失败：" + e.message); });'
		+ '}'
		// 记忆页签第一次被打开时才加载（省一次无谓请求 ✓）
		+ 'var M_LOADED = false;'
		+ 'var origShowTab = showTab;'
		+ 'showTab = function (which) {'
		+ 'origShowTab(which);'
		+ "if (which === 'memory' && !M_LOADED) { M_LOADED = true; memoryLoad(); }"
		+ '};'
		+ CREATE_CLIENT_JS
		+ RESET_MODEL_CLIENT_JS
		+ '</script>';

	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Agents · VsSaros</title>
<style>
${PAGE_CSS}
${CREATE_CSS}
${HOME_CSS}
</style>
</head>
<body data-vssaros-page="agents" data-vssaros-surface="editor">
<header>
	<h1>Agents <span class="n">${summary.count}</span></h1>
	${tabNav}
	<button class="act" onclick="showTab('create'); if (window.crBegin) { crBegin('blank'); }" title="新建一个 Agent（写入 .agent.md）">＋ 新建</button>
	<label class="search"><span class="mag">⌕</span><input id="q" placeholder="筛选 name / id / 描述" oninput="filterRows()"><span class="n" id="qCount">${summary.count}</span></label>
</header>
<p class="diag note" id="pageNote" hidden></p>
${hero}
${overview}
<div id="roster" hidden>${body}</div>
${usageSection}
${assignmentsSection}
${grantsSection}
${groupsSection}
${memorySection}
${renderCreateSection({ agents, create })}
${problems}
${footer}
${script}
</body>
</html>`;
}
